import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface NamedBlob extends Blob {
  name?: string;
}

interface BunRuntime {
  isStandaloneExecutable?: boolean;
  embeddedFiles?: readonly NamedBlob[];
}

export interface ServerAssetPaths {
  catalogDir: string;
  migrationDirectory?: string;
  staticRoot: string;
  dispose(): Promise<void>;
}

export interface PrepareServerAssetsOptions {
  /** Filesystem root used by regular Node.js development and deployments. */
  root?: string;
  /** Parent directory for the fixed scratch directory owned by the standalone executable. */
  materializationParentDirectory?: string;
}

/**
 * Materialize assets carried by a Bun standalone executable into a replaceable
 * runtime directory. The existing Node loaders can then keep using filesystem
 * paths while the deployed artifact remains one binary.
 */
export async function prepareServerAssets(options: PrepareServerAssetsOptions = {}): Promise<ServerAssetPaths> {
  const root = options.root ?? process.cwd();
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun?.isStandaloneExecutable) {
    return {
      catalogDir: join(root, "catalog/apps"),
      staticRoot: join(root, "dist/web"),
      dispose: async () => undefined,
    };
  }

  const assetRoot = join(options.materializationParentDirectory ?? tmpdir(), ".open-connector-assets");
  const embeddedFiles = bun.embeddedFiles ?? [];
  const extracted = {
    catalog: false,
    migrations: false,
    webConsole: false,
  };

  try {
    // A deterministic directory prevents hard-killed processes from leaking a
    // complete copy of the embedded assets on every restart.
    await rm(assetRoot, { recursive: true, force: true });
    await mkdir(assetRoot, { recursive: true });

    for (const file of embeddedFiles) {
      const relativePath = resolveEmbeddedPath(file.name);
      if (!relativePath) {
        continue;
      }

      const target = join(assetRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(await file.arrayBuffer()));
      extracted.catalog ||= relativePath.startsWith("catalog/apps/") && relativePath.endsWith(".json");
      extracted.migrations ||= relativePath.startsWith("migrations/") && relativePath.endsWith(".sql");
      extracted.webConsole ||= relativePath === "dist/web/index.html";
    }

    const missingAssets = Object.entries(extracted)
      .filter(([, present]) => !present)
      .map(([name]) => name);
    if (missingAssets.length > 0) {
      throw new Error(`Standalone executable is missing required runtime assets: ${missingAssets.join(", ")}.`);
    }

    return {
      catalogDir: join(assetRoot, "catalog/apps"),
      migrationDirectory: join(assetRoot, "migrations"),
      staticRoot: join(assetRoot, "dist/web"),
      dispose: async () => {
        await rm(assetRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(assetRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveEmbeddedPath(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  const normalized = name.replaceAll("\\", "/");
  for (const [prefix, destination] of [
    ["migrations/", "migrations/"],
    ["catalog/apps/", "catalog/apps/"],
    ["dist/web/", "dist/web/"],
    ["web/", "dist/web/"],
  ] as const) {
    const index = normalized.lastIndexOf(prefix);
    if (index >= 0) {
      const path = `${destination}${normalized.slice(index + prefix.length)}`;
      return path.includes("../") ? undefined : path;
    }
  }
  return undefined;
}
