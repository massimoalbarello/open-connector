import type { ProviderSummaryDefinition } from "./catalog-store.ts";
import type { ProviderDefinition } from "./core/types.ts";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore, loadCatalog, resolveExecutableActionIds } from "./catalog-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("catalog store", () => {
  it("preserves optional provider descriptions without defaulting missing ones", () => {
    const providers: ProviderDefinition[] = [
      {
        service: "described",
        displayName: "Described",
        description: "A provider-level summary.",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [],
      },
      {
        service: "plain",
        displayName: "Plain",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [],
      },
    ];

    const catalog = createCatalogStore(providers);

    expect(catalog.providers.find((provider) => provider.service === "described")?.description).toBe(
      "A provider-level summary.",
    );
    expect(catalog.providers.find((provider) => provider.service === "plain")).not.toHaveProperty("description");
  });

  it("builds provider summaries that drop action schemas but keep metadata", () => {
    const providers: ProviderDefinition[] = [
      {
        service: "example",
        displayName: "Example",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [
          {
            id: "example.ping",
            service: "example",
            name: "ping",
            description: "Ping the service.",
            requiredScopes: ["read"],
            providerPermissions: [],
            inputSchema: { type: "object", properties: { message: { type: "string" } } },
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        ],
      },
    ];

    const catalog = createCatalogStore(providers, { executableActionIds: ["example.ping"] });
    const [summary] = JSON.parse(catalog.providerSummariesJson) as ProviderSummaryDefinition[];
    const summarizedAction = summary?.actions[0];

    expect(summarizedAction).not.toHaveProperty("inputSchema");
    expect(summarizedAction).not.toHaveProperty("outputSchema");
    expect(summarizedAction?.id).toBe("example.ping");
    expect(summarizedAction?.requiredScopes).toEqual(["read"]);
    expect(summarizedAction?.execution.locallyExecutable).toBe(true);
    expect(summary?.execution.actionCount).toBe(1);
    expect(summary?.scenario).toBe("developer");
    // The full catalog still carries schemas for /api/actions/:actionId.
    expect(catalog.actionsById.get("example.ping")?.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  it("resolves every action from executable services alongside explicit action ids", () => {
    const providers = [providerFixture("example", ["ping", "pong"]), providerFixture("remote", ["ping"])];

    const catalog = createCatalogStore(providers, {
      executableActionIds: resolveExecutableActionIds(providers, {
        executableServices: ["example"],
        executableActionIds: ["remote.ping"],
      }),
    });

    expect(catalog.executableActionIds).toEqual(new Set(["example.ping", "example.pong", "remote.ping"]));
    expect(catalog.actionsById.get("example.pong")?.execution.locallyExecutable).toBe(true);
  });

  it("loads action schemas lazily while preserving their JSON response shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-connector-catalog-store-"));
    temporaryDirectories.push(root);
    const catalogDir = join(root, "apps");
    const providerPath = join(catalogDir, "example.json");
    await mkdir(catalogDir, { recursive: true });
    const provider = providerFixture("example", ["ping"]);
    await writeFile(providerPath, JSON.stringify(provider));

    const catalog = await loadCatalog(catalogDir, { executableServices: ["example"] });
    provider.actions[0]!.inputSchema = { type: "object", properties: { lazy: { type: "boolean" } } };
    await writeFile(providerPath, JSON.stringify(provider));

    const action = catalog.actionsById.get("example.ping")!;
    expect(action.inputSchema).toEqual({ type: "object", properties: { lazy: { type: "boolean" } } });
    expect(JSON.parse(JSON.stringify(action))).toMatchObject({
      id: "example.ping",
      inputSchema: { type: "object", properties: { lazy: { type: "boolean" } } },
      outputSchema: {},
      execution: { locallyExecutable: true },
    });
    const [summary] = JSON.parse(catalog.providerSummariesJson) as ProviderSummaryDefinition[];
    expect(summary?.actions[0]).not.toHaveProperty("inputSchema");
    expect(summary?.actions[0]).not.toHaveProperty("outputSchema");
  });

  it("evicts least-recently-used schema files from the bounded cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-connector-catalog-cache-"));
    temporaryDirectories.push(root);
    const catalogDir = join(root, "apps");
    await mkdir(catalogDir, { recursive: true });
    const providers = Array.from({ length: 9 }, (_, index) => providerFixture(`service-${index}`, ["ping"]));
    for (const provider of providers) {
      provider.actions[0]!.inputSchema = { type: "object", description: "initial" };
      await writeFile(join(catalogDir, `${provider.service}.json`), JSON.stringify(provider));
    }

    const catalog = await loadCatalog(catalogDir);
    const firstAction = catalog.actionsById.get("service-0.ping")!;
    expect(firstAction.inputSchema.description).toBe("initial");
    providers[0]!.actions[0]!.inputSchema = { type: "object", description: "reloaded after eviction" };
    await writeFile(join(catalogDir, "service-0.json"), JSON.stringify(providers[0]));

    for (let index = 1; index < providers.length; index++) {
      expect(catalog.actionsById.get(`service-${index}.ping`)!.inputSchema.description).toBe("initial");
    }
    expect(firstAction.inputSchema.description).toBe("reloaded after eviction");
  });
});

function providerFixture(service: string, actionNames: string[]): ProviderDefinition {
  return {
    service,
    displayName: service,
    categories: ["Developer Tools"],
    authTypes: ["no_auth"],
    auth: [{ type: "no_auth" }],
    actions: actionNames.map((name) => ({
      id: `${service}.${name}`,
      service,
      name,
      description: `${name} action.`,
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: {},
      outputSchema: {},
    })),
  };
}
