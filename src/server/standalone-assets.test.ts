import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareServerAssets } from "./standalone-assets.ts";

interface MutableRuntimeGlobal {
  Bun?: unknown;
}

const runtimeGlobal = globalThis as typeof globalThis & MutableRuntimeGlobal;
const originalBun = runtimeGlobal.Bun;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalBun === undefined) {
    delete runtimeGlobal.Bun;
  } else {
    runtimeGlobal.Bun = originalBun;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("standalone server assets", () => {
  it("uses repository paths outside a standalone executable", async () => {
    delete runtimeGlobal.Bun;

    const assets = await prepareServerAssets({ root: "/workspace/open-connector" });

    expect(assets).toMatchObject({
      catalogDir: "/workspace/open-connector/catalog/apps",
      staticRoot: "/workspace/open-connector/dist/web",
    });
    expect(assets.migrationDirectory).toBeUndefined();
  });

  it("replaces and cleans a fixed standalone materialization directory", async () => {
    const parent = await temporaryDirectory();
    const materializationDirectory = join(parent, ".open-connector-assets");
    await mkdir(materializationDirectory, { recursive: true });
    await writeFile(join(materializationDirectory, "stale.txt"), "left by a killed process");
    await writeFile(join(parent, "persistent-data.txt"), "must not be deleted");
    runtimeGlobal.Bun = {
      isStandaloneExecutable: true,
      embeddedFiles: [
        namedBlob("/$bunfs/root/catalog/apps/example.json", '{"service":"example"}'),
        namedBlob("/$bunfs/root/migrations/0001_runtime.sql", "select 1;"),
        namedBlob("/$bunfs/root/dist/web/index.html", "<main>OpenConnector</main>"),
      ],
    };

    const assets = await prepareServerAssets({ materializationParentDirectory: parent });

    expect(assets).toMatchObject({
      catalogDir: join(materializationDirectory, "catalog/apps"),
      migrationDirectory: join(materializationDirectory, "migrations"),
      staticRoot: join(materializationDirectory, "dist/web"),
    });
    await expect(access(join(materializationDirectory, "stale.txt"))).rejects.toThrow();
    expect(await readFile(join(assets.catalogDir, "example.json"), "utf8")).toBe('{"service":"example"}');
    expect(await readFile(join(assets.staticRoot, "index.html"), "utf8")).toBe("<main>OpenConnector</main>");

    await assets.dispose();
    await expect(access(materializationDirectory)).rejects.toThrow();
    expect(await readFile(join(parent, "persistent-data.txt"), "utf8")).toBe("must not be deleted");
  });

  it("removes the materialization directory when no runtime assets are embedded", async () => {
    const parent = await temporaryDirectory();
    const materializationDirectory = join(parent, ".open-connector-assets");
    runtimeGlobal.Bun = {
      isStandaloneExecutable: true,
      embeddedFiles: [namedBlob("/$bunfs/root/unrelated.txt", "ignored")],
    };

    await expect(prepareServerAssets({ materializationParentDirectory: parent })).rejects.toThrow(
      "Standalone executable is missing required runtime assets: catalog, migrations, webConsole.",
    );
    await expect(access(materializationDirectory)).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-connector-standalone-assets-"));
  temporaryDirectories.push(directory);
  return directory;
}

function namedBlob(name: string, contents: string): Blob & { name: string } {
  const blob = new Blob([contents]) as Blob & { name: string };
  blob.name = name;
  return blob;
}
