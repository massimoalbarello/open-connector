import type { CredentialValidators } from "../core/types.ts";
import type { SyncDefinitionRuntime, SyncRegistration } from "./sync-definition.ts";

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { s } from "../core/json-schema.ts";
import { createGitHubSyncProvider } from "../providers/github/sync-provider.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { createLocalAuthMiddleware } from "../server/api/auth.ts";
import { registerSyncRoutes } from "../server/api/sync-routes.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { syncAssetUrl } from "./asset-store.ts";
import { SyncRunner } from "./sync-runner.ts";
import { SyncStoreError } from "./sync-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
const definition = {
  id: "github.test",
  version: "1",
  provider: "github",
  kinds: [{ kind: "test" }],
  configSchema: s.object({}),
  defaultConfig: {},
  checkpointSchema: s.object({ cursor: s.integer() }, { required: ["cursor"] }),
  initialCheckpoint: { cursor: 0 },
  requiredScopes: [],
  scheduleSeconds: 60,
};

async function setup(runtime: SyncDefinitionRuntime, validators?: CredentialValidators) {
  const database = new SqliteRuntimeDatabase(":memory:", { syncDefinitions: [definition] });
  databases.push(database);
  await database.syncStore.delivery.configure({
    url: "https://receiver.example.com",
    bearerToken: "secret",
    enabled: true,
  });
  const catalog = createCatalogStore([
    { service: "github", displayName: "GitHub", categories: [], authTypes: ["api_key"], auth: [], actions: [] },
  ]);
  const loader = new ProviderLoader({
    github: async () => ({
      executors: {},
      credentialValidators: validators ?? {
        apiKey: async () => ({ sourceIdentity: { accountId: "native", authorizationBoundary: "scope" } }),
      },
    }),
  });
  await database.connectionStore.set("github", "default", {
    authType: "api_key",
    apiKey: "secret",
    values: {},
    profile: { accountId: "label", displayName: "Label", grantedScopes: [] },
    metadata: {},
  });
  const connections = new ConnectionService({ catalog, providerLoader: loader, store: database.connectionStore });
  const load = vi.fn(async () => runtime);
  const registrations: SyncRegistration[] = [{ definition, load, createProvider: createGitHubSyncProvider }];
  const runner = new SyncRunner({
    store: database.syncStore,
    connectionStore: database.connectionStore,
    connections,
    registrations,
  });
  return { database, runner, load };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("compiled sync runner", () => {
  it("waits before verification without a destination and resumes only committed pages after destination removal", async () => {
    const cursors: number[] = [];
    const verify = vi.fn(async () => ({ sourceIdentity: { accountId: "native", authorizationBoundary: "scope" } }));
    const { database, runner, load } = await setup(
      {
        async *run(context) {
          const cursor = Number((context.checkpoint as { cursor: number }).cursor);
          cursors.push(cursor);
          yield {
            records: [{ kind: "test", record: { id: String(cursor), title: "Record title", body: "Saved" } }],
            checkpoint: { cursor: cursor + 1 },
            complete: cursor > 0,
          };
          database.syncStore.delivery.remove();
          yield {
            records: [{ kind: "test", record: { id: "uncommitted", title: "Record title", body: "Must retry" } }],
            checkpoint: { cursor: 2 },
            complete: true,
          };
        },
      },
      { apiKey: verify },
    );
    database.syncStore.delivery.remove();
    await expect(runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "destination_required" });
    expect(verify).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    await database.syncStore.delivery.configure({
      url: "https://first.example.com",
      bearerToken: "secret",
      enabled: true,
    });
    await expect(runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "destination_required" });
    const changes = (await database.syncStore.listChanges()).items;
    expect(changes).toHaveLength(1);
    const installationId = changes[0]!.installationId;
    expect(await database.syncStore.getCheckpoint(installationId)).toMatchObject({ revision: 1, value: { cursor: 1 } });
    expect(await database.syncStore.getRun(changes[0]!.runId)).toMatchObject({
      state: "cancelled",
      errorCode: "destination_required",
      pageCount: 1,
    });
    await database.syncStore.delivery.configure({
      url: "https://next.example.com",
      bearerToken: "secret",
      enabled: false,
    });
    await expect(runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "destination_required" });
    await database.syncStore.delivery.configure({
      url: "https://next.example.com",
      bearerToken: "secret",
      enabled: true,
    });
    expect((await runner.run({ definitionId: definition.id })).complete).toBe(true);
    expect(cursors).toEqual([0, 1]);
    expect(database.syncStore.delivery.status().pendingRecords).toBe(2);
  });

  it("loads lazily and resumes durable pages without duplicating unchanged records", async () => {
    const cursors: unknown[] = [];
    const { database, runner, load } = await setup({
      async *run(context) {
        const checkpoint = context.checkpoint as { cursor: number };
        cursors.push(checkpoint.cursor);
        for (let cursor = checkpoint.cursor + 1; cursor <= 2; cursor++)
          yield {
            records: [{ kind: "test", record: { id: "same", title: "Record title", body: "# Same" } }],
            checkpoint: { cursor },
            complete: cursor === 2,
          };
      },
    });
    expect(load).not.toHaveBeenCalled();
    const first = await runner.run({ definitionId: definition.id, maxPages: 1 });
    expect(first.complete).toBe(false);
    const second = await runner.run({ definitionId: definition.id });
    expect(second.complete).toBe(true);
    expect(cursors).toEqual([0, 1]);
    expect((await database.syncStore.listChanges()).items).toHaveLength(1);
    expect((await database.syncStore.getCheckpoint(first.installationId!))?.revision).toBe(2);
  });

  it("dry runs use isolated progress and leave installations, records and checkpoints untouched", async () => {
    const { database, runner } = await setup({
      async *run(context) {
        const asset = await context.assets.stage({ name: "preview.txt", bytes: Buffer.from("preview") });
        yield {
          records: [
            {
              kind: "test",
              record: {
                id: "preview",
                title: "Record title",
                body: `# Preview\n\n[File](${syncAssetUrl(asset)})`,
                assets: [asset],
              },
            },
          ],
          checkpoint: { cursor: 1 },
          complete: true,
        };
      },
    });
    database.syncStore.delivery.remove();
    const result = await runner.run({ definitionId: definition.id, dryRun: true });
    expect(result.preview?.[0]).toMatchObject({
      id: "preview",
      content: {
        body: expect.stringContaining("# Preview"),
        assets: [expect.objectContaining({ name: "preview.txt" })],
      },
    });
    expect(database.syncStore.sources.getBindingRevision()).toBe(0);
    expect((await database.syncStore.listChanges()).items).toEqual([]);
    expect(result.installationId).toBeUndefined();
  });

  it("bounds dry-run preview bytes across pages without persisting progress", async () => {
    const { database, runner } = await setup({
      async *run() {
        for (let cursor = 1; cursor <= 3; cursor++)
          yield {
            records: [
              {
                kind: "test",
                record: { id: String(cursor), title: "Record title", body: "x".repeat(6 * 1024 * 1024) },
              },
            ],
            checkpoint: { cursor },
            complete: cursor === 3,
          };
      },
    });
    await expect(runner.run({ definitionId: definition.id, dryRun: true, maxPages: 3 })).rejects.toThrow(
      "preview exceeds 16 MiB",
    );
    expect(database.syncStore.sources.getBindingRevision()).toBe(0);
    expect((await database.syncStore.listChanges()).items).toEqual([]);
  });

  it("does not commit partial pages or invalid progress after required hydration fails", async () => {
    const { database, runner } = await setup({
      async *run() {
        yield {
          records: [{ kind: "test", record: { id: "good", title: "Record title", body: "# Complete" } }],
          checkpoint: { cursor: 1 },
          complete: false,
        };
        throw new Error("Required comments failed");
      },
    });
    await expect(runner.run({ definitionId: definition.id })).rejects.toThrow("Required comments failed");
    const change = (await database.syncStore.listChanges()).items[0]!;
    expect((await database.syncStore.getCheckpoint(change.installationId))?.value).toEqual({ cursor: 1 });
    expect((await database.syncStore.getRun(change.runId))?.state).toBe("failed");
    const invalid = await setup({
      async *run() {
        yield {
          records: [{ kind: "test", record: { id: "bad", title: "Record title", body: "# Bad" } }],
          checkpoint: { unknown: 1 },
          complete: true,
        };
      },
    });
    await expect(invalid.runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await invalid.database.syncStore.listChanges()).items).toEqual([]);
  });

  it("cancels in-flight acquisition and prevents concurrent runs", async () => {
    const entered = Promise.withResolvers<void>();
    const { runner } = await setup({
      async *run(context) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }),
        );
        yield { checkpoint: { cursor: 1 }, complete: true };
      },
    });
    const result = runner.run({ definitionId: definition.id });
    const rejected = expect(result).rejects.toThrow("stopping");
    await entered.promise;
    await expect(runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "run_busy" });
    await runner.stop();
    await rejected;
    expect(runner.busy).toBe(false);
  });

  it("renews leases while hydration waits and commits with the latest fencing generation", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { runner } = await setup({
      async *run() {
        entered.resolve();
        await release.promise;
        yield { checkpoint: { cursor: 1 }, complete: true };
      },
    });
    const result = runner.run({ definitionId: definition.id });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(90_001);
    release.resolve();
    expect((await result).run).toMatchObject({ state: "succeeded", leaseGeneration: 4 });
  });

  it("requires admin authentication and rejects malformed run configuration", async () => {
    const { runner, database } = await setup({
      async *run() {
        yield { checkpoint: { cursor: 1 }, complete: true };
      },
    });
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ adminToken: "admin" }));
    registerSyncRoutes(app, runner, database.syncStore);
    expect((await app.request("/api/sync/definitions")).status).toBe(401);
    expect(
      (
        await app.request(`/api/sync/definitions/${definition.id}/run`, {
          method: "POST",
          headers: { authorization: "Bearer admin", "content-type": "application/json" },
          body: JSON.stringify({ wrong: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/api/sync/definitions/${definition.id}/run`, {
          method: "POST",
          headers: { authorization: "Bearer admin", "content-type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        })
      ).status,
    ).toBe(200);
  });
});

it("pauses a full attachment spool without losing progress or escalating acquisition failures", async () => {
  const { runner, database } = await setup({
    async *run() {
      yield {
        records: [{ kind: "test", record: { id: "one", title: "Saved", body: "Saved before backpressure" } }],
        checkpoint: { cursor: 1 },
        complete: false,
      };
      throw new SyncStoreError("asset_storage_full", "Pending attachment budget reached.");
    },
  });
  const installation = await runner.create({ definitionId: definition.id, enabled: true });
  const before = Date.now();
  await expect(runner.run({ definitionId: definition.id })).rejects.toMatchObject({ code: "asset_storage_full" });
  expect(await database.syncStore.getCheckpoint(installation.id)).toMatchObject({ value: { cursor: 1 } });
  const paused = await database.syncStore.getInstallation(installation.id);
  expect(paused).toMatchObject({ state: "enabled", consecutiveFailures: 0, lastError: "asset_storage_full" });
  expect(Date.parse(paused!.nextDueAt!)).toBeGreaterThanOrEqual(before + 60_000);
  expect((await database.syncStore.listChanges()).items).toHaveLength(1);
});
