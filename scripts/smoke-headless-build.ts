// Run with Bun after installing the packed headless package into the supplied consumer directory.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const consumer = resolve(process.argv[2]);
const { getConnectorBuildOptions } = (await import(
  import.meta.resolve("@oomol-lab/open-connector/build", join(consumer, "package.json"))
)) as typeof import("../src/server/connector-build.ts");
const execution = await mkdtemp(join(tmpdir(), "connector-build-smoke-"));
const entrypoint = join(consumer, "compiled-host.ts");
const source = `
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createConnectorRuntime, getConnectorAssetDirectory } from "@oomol-lab/open-connector";
const expected = JSON.parse(process.argv[2]);
const files = await readdir(join(getConnectorAssetDirectory(), "catalog/apps"));
assert.deepEqual(files.filter(name => name.endsWith(".json")).sort(), expected.map(id => id + ".json").sort());
globalThis.fetch = async () => Response.json({ id: 1, login: "fixture-account" });
const runtime = await createConnectorRuntime({
  dataDir: "./data", publicOrigin: "https://host.example", encryptionKey: "fixture-encryption-key",
});
const request = (path, body) => runtime.fetch(new Request("https://host.example" + path, {
  method: body ? "POST" : "GET",
  headers: { "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}));
try {
  const catalog = await (await request("/v1/providers")).json();
  assert.deepEqual(catalog.data.map(provider => provider.service).sort(), expected);
  if (!expected.includes("slack")) assert.equal((await request("/v1/providers/slack/setup")).status, 404);
  if (expected.includes("github")) {
    assert.equal((await request("/v1/providers/github/setup")).status, 200, "GitHub setup");
    const connected = await request("/v1/connections/github/connect/api-key", { apiKey: "fixture-secret" });
    assert.equal(connected.status, 200, "API-key connection");
    const apps = await (await request("/v1/apps/services/github")).json();
    const action = await runtime.fetch(new Request("https://host.example/v1/actions/github.get_current_user", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oo-connector-alias": apps.data[0].alias },
      body: JSON.stringify({ input: {} }),
    }));
    assert.equal(action.status, 200, await action.clone().text());
    assert.equal((await action.json()).data.login, "fixture-account");
    const proxy = await runtime.fetch(new Request("https://host.example/v1/proxy/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oo-connector-alias": apps.data[0].alias },
      body: JSON.stringify({ method: "GET", endpoint: "/user" }),
    }));
    assert.equal(proxy.status, 200, "Proxy request");
    assert.equal((await proxy.json()).data.data.login, "fixture-account");
    const configured = await runtime.fetch(new Request("https://host.example/api/oauth/configs/github", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "fixture-client", clientSecret: "fixture-secret" }),
    }));
    assert.equal(configured.status, 200, "OAuth configuration");
    const started = await request("/v1/connections/github/connect", { returnUri: "https://host.example/settings" });
    assert.equal(started.status, 200, "OAuth start");
    const authorization = new URL((await started.json()).data.authorizationUrl);
    assert.equal(authorization.searchParams.get("redirect_uri"), "https://host.example/oauth/callback");
  }
} finally { await runtime.close(); }
`;

try {
  await writeFile(entrypoint, source);
  await assert.rejects(getConnectorBuildOptions({ providers: ["missing-provider"] }), /Unknown provider/);
  await assert.rejects(getConnectorBuildOptions({ providers: ["../github"] }), /provider id/);
  const defaults = await getConnectorBuildOptions();
  const omitted = await getConnectorBuildOptions({});
  assert.deepEqual(omitted.assets, defaults.assets);
  await omitted.dispose();
  const index = JSON.parse(await readFile(join(defaults.assets[0]!, "catalog/apps-index.json"), "utf8"));
  const all = index.providers.map((entry: { provider: { service: string } }) => entry.provider.service).sort();
  await defaults.dispose();
  for (const providers of [undefined, ["github", "github"], []]) {
    const expected = providers === undefined ? all : [...new Set(providers)].sort();
    const prepared = await getConnectorBuildOptions({ providers });
    const outfile = join(execution, "host");
    try {
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target: "bun",
        format: "esm",
        splitting: true,
        plugins: prepared.plugins,
        external: prepared.external,
        compile: { outfile, assets: prepared.assets },
        metafile: true,
      });
      assert.ok(result.success, result.logs.join("\n"));
      assert.ok(result.metafile);
      const bundledProviders = [
        ...new Set(
          Object.keys(result.metafile.inputs).flatMap((path) => {
            const match = /\/src\/providers\/([^/]+)\//.exec(path.replaceAll("\\", "/"));
            return match ? [match[1]!] : [];
          }),
        ),
      ].sort();
      assert.deepEqual(bundledProviders, expected);
    } finally {
      await prepared.dispose();
    }
    if (providers !== undefined) await assert.rejects(readdir(prepared.assets[0]!));
    const child = Bun.spawn([outfile, JSON.stringify(expected)], {
      cwd: execution,
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await child.exited, 0);
    await rm(join(execution, "data"), { recursive: true, force: true });
    console.log(`Compiled host passed with ${expected.length} providers.`);
  }
} finally {
  await rm(entrypoint, { force: true });
  await rm(execution, { recursive: true, force: true });
}
