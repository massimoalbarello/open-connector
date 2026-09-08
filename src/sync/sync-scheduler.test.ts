import type { SyncDeliveryRecord } from "./delivery-store.ts";
import type { SyncDefinition, SyncDefinitionRuntime } from "./sync-definition.ts";

import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoggingReceiver } from "../../examples/sync/receiver-server.ts";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { s } from "../core/json-schema.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { createLocalAuthMiddleware } from "../server/api/auth.ts";
import { registerSyncRoutes } from "../server/api/sync-routes.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { githubPullRequests } from "../sync-definitions/github/definition.ts";
import { githubPullRequestFixture } from "../sync-definitions/github/pull-requests.test-fixture.ts";
import { run as githubRun } from "../sync-definitions/github/pull-requests.ts";
import { SyncDeliveryWorker } from "./delivery-worker.ts";
import { SyncRunner } from "./sync-runner.ts";
import { SyncScheduler } from "./sync-scheduler.ts";

const { providerTransport } = vi.hoisted(() => ({ providerTransport: vi.fn<typeof fetch>() }));
vi.mock("../providers/provider-runtime.ts", async (original) => ({
  ...(await original<object>()),
  providerFetch: providerTransport,
}));

const definition = {
  id: "github.test",
  version: "1",
  provider: "github",
  kinds: [{ kind: "record" }],
  configSchema: s.object({}),
  defaultConfig: {},
  checkpointSchema: s.object({ cursor: s.integer() }, { required: ["cursor"] }),
  initialCheckpoint: { cursor: 0 },
  requiredScopes: [],
  scheduleSeconds: 60,
};
const cleanups: (() => Promise<void>)[] = [];
const now = () => new Date().toISOString();

async function fixture(custom?: SyncDefinitionRuntime, contract: SyncDefinition = definition) {
  const dir = await mkdtemp(join(tmpdir(), "sync-scheduler-"));
  const path = join(dir, "connector.sqlite");
  const state = { body: "Original", visits: 0, verifyFails: false, verifications: 0 };
  const runtime: SyncDefinitionRuntime = custom ?? {
    async *run(context) {
      state.visits++;
      const cursor = Number((context.checkpoint as { cursor: number }).cursor);
      for (let index = cursor; index < 2; index++)
        yield {
          records: [{ kind: "record", record: { id: String(index), body: state.body } }],
          checkpoint: { cursor: index + 1 },
          complete: false,
        };
      yield { checkpoint: { cursor: 0 }, complete: true };
    },
  };
  const catalog = createCatalogStore([
    { service: "github", displayName: "GitHub", categories: [], authTypes: ["api_key"], auth: [], actions: [] },
  ]);
  const loader = new ProviderLoader({
    github: async () => ({
      executors: {},
      credentialValidators: {
        apiKey: async () => {
          state.verifications++;
          if (state.verifyFails) throw new Error("private-secret-provider-error");
          return { sourceIdentity: { accountId: "native", authorizationBoundary: "scopes" } };
        },
      },
    }),
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 200 }));
  let database: SqliteRuntimeDatabase;
  let runner: SyncRunner;
  let scheduler: SyncScheduler;
  let delivery: SyncDeliveryWorker;
  const open = () => {
    database = new SqliteRuntimeDatabase(path, { syncDefinitions: [contract] });
    const connections = new ConnectionService({ catalog, providerLoader: loader, store: database.connectionStore });
    runner = new SyncRunner({
      store: database.syncStore,
      connections,
      connectionStore: database.connectionStore,
      registrations: [{ definition: contract, load: async () => runtime }],
      catalog,
      loader,
    });
    delivery = new SyncDeliveryWorker({ store: database.syncStore.delivery, fetcher });
    scheduler = new SyncScheduler({ store: database.syncStore, runner, delivery });
  };
  open();
  const credential = {
    authType: "api_key" as const,
    apiKey: "credential",
    values: {},
    metadata: {},
    profile: { accountId: "display", displayName: "Display", grantedScopes: [] },
  };
  await database!.connectionStore.set("github", "default", credential);
  cleanups.push(async () => {
    await scheduler.stop();
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    state,
    fetcher,
    credential,
    path,
    get database() {
      return database;
    },
    get runner() {
      return runner;
    },
    get scheduler() {
      return scheduler;
    },
    get delivery() {
      return delivery;
    },
    async restart() {
      await scheduler.stop();
      database.close();
      open();
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

describe("embedded sync scheduler", () => {
  it("automatically acquires connected sources, persists cadence, coalesces missed intervals and delivers independently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    await f.database.syncStore.delivery.register({
      id: "receiver",
      url: "https://receiver.example.com/records",
      bearerToken: "secret",
      enabled: true,
    });
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(1));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const first = (await f.database.syncStore.schedule.status()).installations[0]!;
    expect(first.scheduleSeconds).toBe(60);
    expect(Date.parse(first.nextDueAt!) - Date.parse(first.lastSuccessAt!)).toBe(60_000);
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    await f.restart();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.visits).toBe(1);
    f.state.body = "Edited old record";
    vi.setSystemTime(Date.now() + 3600_000);
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(2));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const status = await f.database.syncStore.schedule.status();
    expect(status.runs).toHaveLength(2);
    expect(status.runs.every((run) => run.reason === "schedule")).toBe(true);
    expect((await f.database.syncStore.getRecord(first.id, "record", "0"))?.revision).toBe(2);
    expect(Date.parse(status.installations[0]!.nextDueAt!) - Date.parse(status.installations[0]!.lastSuccessAt!)).toBe(
      60_000,
    );
  });

  it("backs off failed source verification durably and retries a replaced credential immediately", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    f.state.verifyFails = true;
    f.scheduler.tick();
    await vi.waitFor(async () => expect((await f.database.syncStore.schedule.status()).bindingErrors).toHaveLength(1));
    await f.restart();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.verifications).toBe(1);
    expect(JSON.stringify(await f.database.syncStore.schedule.status())).not.toContain("private-secret");
    f.state.verifyFails = false;
    await f.database.connectionStore.set("github", "default", { ...f.credential, apiKey: "replacement" });
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(1));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    expect((await f.database.syncStore.schedule.status()).bindingErrors).toHaveLength(0);
  });

  it("continues a targeted backfill after restart without changing event IDs or revisions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    await f.runner.run({ definitionId: definition.id });
    const original = (await f.database.syncStore.listChanges()).items;
    expect(original.every((change) => change.content === undefined)).toBe(true);
    await f.database.syncStore.delivery.register({
      id: "new",
      url: "https://new.example.com/records",
      bearerToken: "secret",
      enabled: true,
    });
    const partial = await f.runner.run({
      definitionId: definition.id,
      backfill: true,
      targetReceiverId: "new",
      maxPages: 1,
    });
    expect(partial.complete).toBe(false);
    expect((await f.database.syncStore.getInstallation(partial.installationId!))?.bootstrapReceiverId).toBe("new");
    await f.restart();
    vi.setSystemTime(Date.now() + 2000);
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(3));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    f.scheduler.tick();
    await vi.waitFor(async () => expect((await f.database.syncStore.delivery.list())[0]?.pendingRecords).toBe(0));
    const delivered = f.fetcher.mock.calls.flatMap(([, input]) => JSON.parse(String(input?.body)).records);
    expect(delivered.map((record) => record.eventId).sort()).toEqual(original.map((record) => record.eventId).sort());
    expect(delivered.every((record) => record.revision === 1)).toBe(true);
    expect((await f.database.syncStore.getInstallation(partial.installationId!))?.bootstrapReceiverId).toBeUndefined();
  });

  it("enforces the global acquisition slot across database instances and cancels cleanly on shutdown", async () => {
    let entered = false;
    const f = await fixture({
      async *run(context) {
        entered = true;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
        yield { checkpoint: { cursor: 0 }, complete: true };
      },
    });
    const running = f.runner.run({ definitionId: definition.id });
    const outcome = running.catch((error) => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    const other = new SqliteRuntimeDatabase(f.path, { syncDefinitions: [definition] });
    try {
      const installation = (await f.database.syncStore.schedule.status()).installations[0]!;
      await expect(
        other.syncStore.startRun({
          id: "other",
          installationId: installation.id,
          definitionVersion: "1",
          reason: "manual",
          leaseOwner: "other",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          startedAt: now(),
        }),
      ).rejects.toMatchObject({ code: "run_busy" });
      await f.scheduler.stop();
      expect(await outcome).toBeInstanceOf(Error);
      expect((await f.database.syncStore.schedule.status()).runs[0]?.state).toBe("cancelled");
      await expect(f.runner.run({ definitionId: definition.id })).rejects.toThrow("stopping");
    } finally {
      other.close();
    }
  });

  it("recovers expired runs and refuses to reuse an interrupted snapshot checkpoint without explicit backfill", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const seeded = await f.runner.run({ definitionId: definition.id });
    const store = f.database.syncStore;
    const checkpoint = (await store.getCheckpoint(seeded.installationId!))!;
    await store.startRun({
      id: "lost",
      installationId: seeded.installationId!,
      definitionVersion: "1",
      reason: "manual",
      leaseOwner: "lost",
      leaseExpiresAt: new Date(Date.now() + 1000).toISOString(),
      startedAt: now(),
    });
    await store.startSnapshot({
      id: "snapshot",
      installationId: seeded.installationId!,
      runId: "lost",
      kinds: ["record"],
      lease: { owner: "lost", generation: 1 },
      expectedCheckpointRevision: checkpoint.revision,
      startedAt: now(),
    });
    vi.setSystemTime(Date.now() + 2000);
    expect(store.schedule.recover(now())).toBe(1);
    expect((await store.getRun("lost"))?.state).toBe("lease_expired");
    expect((await store.getInstallation(seeded.installationId!))?.requiresBackfill).toBe(true);
    expect(store.schedule.due(now())).toBeUndefined();
    await expect(f.runner.run({ definitionId: definition.id })).rejects.toThrow("explicit backfill");
    const recovered = await f.runner.run({ definitionId: definition.id, backfill: true });
    expect(recovered.complete).toBe(true);
    expect((await store.getInstallation(seeded.installationId!))?.requiresBackfill).toBe(false);
    expect((await store.getCheckpoint(seeded.installationId!))!.revision).toBeGreaterThan(checkpoint.revision);
    expect((await store.getRecord(seeded.installationId!, "record", "0"))?.revision).toBe(1);
  });

  it("protects status/configuration with admin auth and persists disabled schedules", async () => {
    const f = await fixture();
    const run = await f.runner.run({ definitionId: definition.id });
    const app = new Hono();
    app.use("/api/*", createLocalAuthMiddleware({ adminToken: "admin" }));
    registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery);
    expect((await app.request("/api/sync/status")).status).toBe(401);
    const disabled = await app.request(`/api/sync/installations/${run.installationId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, scheduleSeconds: 120 }),
    });
    expect(disabled.status).toBe(200);
    await f.restart();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.visits).toBe(1);
    expect((await f.database.syncStore.getInstallation(run.installationId!))?.state).toBe("disabled");
  });
});

it("runs the compiled GitHub sync through the scheduler and real HTTP receiver, including child edits on old PRs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const upstream = githubPullRequestFixture();
  providerTransport.mockImplementation(async (_url, input) => {
    const request = JSON.parse(String(input?.body));
    return new Response(JSON.stringify({ data: await upstream.graphql(request.query, request.variables) }));
  });
  const f = await fixture({ run: githubRun }, githubPullRequests);
  const received: SyncDeliveryRecord[] = [];
  const receiver = await startLoggingReceiver({
    databasePath: ":memory:",
    bearerToken: "receiver",
    onRecord: (record) => received.push(record),
  });
  cleanups.push(receiver.close);
  f.fetcher.mockImplementation((_url, input) => fetch(receiver.url, input));
  await f.database.syncStore.delivery.register({
    id: "log",
    url: "https://log.example.com/records",
    bearerToken: "receiver",
    enabled: true,
  });
  f.scheduler.tick();
  await vi.waitFor(async () => expect((await f.database.syncStore.schedule.status()).runs[0]?.state).toBe("succeeded"));
  f.scheduler.tick();
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]?.content?.body).toContain("Commit 300");
  expect(received[0]?.content?.body).toContain("Thread 50");
  expect(received[0]?.revision).toBe(1);
  await vi.waitFor(async () => expect((await f.database.syncStore.delivery.list())[0]?.pendingRecords).toBe(0));
  await f.restart();
  upstream.comments[0]!.body = "An old child comment was corrected";
  vi.setSystemTime(Date.now() + 26 * 3600_000);
  f.scheduler.tick();
  await vi.waitFor(async () => expect((await f.database.syncStore.listChanges()).items).toHaveLength(2));
  await vi.waitFor(() => expect(f.runner.busy).toBe(false));
  f.scheduler.tick();
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[1]?.id).toBe(received[0]?.id);
  expect(received[1]?.sourceId).toBe(received[0]?.sourceId);
  expect(received[1]?.revision).toBe(2);
  expect(received[1]?.content?.body).toContain("An old child comment was corrected");
});
