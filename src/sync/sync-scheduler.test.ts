import type { SyncDeliveryRecord } from "./delivery-store.ts";
import type { SyncDefinition, SyncDefinitionRuntime } from "./sync-definition.ts";

import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoggingReceiver } from "../../examples/sync/receiver-server.ts";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { s } from "../core/json-schema.ts";
import { createGitHubSyncProvider } from "../providers/github/sync-provider.ts";
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
      registrations: [{ definition: contract, createProvider: createGitHubSyncProvider, load: async () => runtime }],
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
  await database!.syncStore.delivery.configure({
    url: "https://receiver.example.com/records",
    bearerToken: "secret",
    enabled: true,
  });
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
  it("waits without failures, cancels when the destination is removed, and resumes acquisition and delivery after restart", async () => {
    const cursors: number[] = [];
    const f = await fixture({
      async *run(context) {
        const cursor = Number((context.checkpoint as { cursor: number }).cursor);
        cursors.push(cursor);
        yield {
          records: [{ kind: "record", record: { id: String(cursor), body: "Saved" } }],
          checkpoint: { cursor: cursor + 1 },
          complete: cursor > 0,
        };
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const destination = { url: "https://receiver.example.com/records", bearerToken: "secret", enabled: true };
    f.database.syncStore.delivery.remove();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.verifications).toBe(0);
    expect((await f.database.syncStore.status.read()).bindingErrors).toEqual([]);
    await f.database.syncStore.delivery.configure(destination);
    f.scheduler.tick();
    await vi.waitFor(async () => expect((await f.database.syncStore.listChanges()).items).toHaveLength(1));
    const app = new Hono();
    app.use("/api/*", createLocalAuthMiddleware({ adminToken: "admin" }));
    registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery);
    expect((await app.request("/api/sync/destination", { method: "DELETE" })).status).toBe(401);
    expect(
      (await app.request("/api/sync/destination", { method: "DELETE", headers: { authorization: "Bearer admin" } }))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const waiting = await f.database.syncStore.status.read();
    expect(waiting.runs).toMatchObject([{ state: "cancelled", errorCode: "destination_required", pageCount: 1 }]);
    expect(waiting.installations[0]).toMatchObject({ state: "enabled", consecutiveFailures: 0, lastError: undefined });
    f.scheduler.tick();
    await f.restart();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cursors).toEqual([0]);
    expect((await f.database.syncStore.status.read()).runs).toHaveLength(1);
    expect(f.database.syncStore.delivery.status()).toMatchObject({ destination: undefined, pendingRecords: 1 });
    await f.database.syncStore.delivery.configure({ ...destination, url: "https://replacement.example.com/records" });
    f.scheduler.tick();
    await vi.waitFor(() => expect(cursors).toEqual([0, 1]));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    f.scheduler.tick();
    await vi.waitFor(() =>
      expect(f.database.syncStore.delivery.status()).toMatchObject({ deliveredRecords: 2, pendingRecords: 0 }),
    );
    const records = f.fetcher.mock.calls.flatMap(([, input]) => JSON.parse(String(input?.body)).records);
    expect(records.map((record) => record.id)).toEqual(["0", "1"]);
    f.database.syncStore.schedule.configure({ installationId: waiting.installations[0]!.id, enabled: false });
    f.database.syncStore.delivery.remove();
    await f.database.syncStore.delivery.configure(destination);
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cursors).toEqual([0, 1]);
    expect((await f.database.syncStore.status.read()).installations[0]?.state).toBe("disabled");
  });

  it("automatically acquires connected sources, persists cadence, coalesces missed intervals and delivers independently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    await f.database.syncStore.delivery.configure({
      url: "https://receiver.example.com/records",
      bearerToken: "secret",
      enabled: true,
    });
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(1));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const first = (await f.database.syncStore.status.read()).installations[0]!;
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
    const status = await f.database.syncStore.status.read();
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
    await vi.waitFor(async () => expect((await f.database.syncStore.status.read()).bindingErrors).toHaveLength(1));
    await f.restart();
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.verifications).toBe(1);
    expect(JSON.stringify(await f.database.syncStore.status.read())).not.toContain("private-secret");
    f.state.verifyFails = false;
    await f.database.connectionStore.set("github", "default", { ...f.credential, apiKey: "replacement" });
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.state.visits).toBe(1));
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    expect((await f.database.syncStore.status.read()).bindingErrors).toHaveLength(0);
  });

  it("keeps failed polling verification in recent iterations across restart and a successful retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const first = (await f.database.syncStore.status.read()).installations[0]!;
    const checkpoint = await f.database.syncStore.getCheckpoint(first.id);
    f.state.verifyFails = true;
    vi.setSystemTime(first.nextDueAt!);
    const startedAt = now();
    f.scheduler.tick();
    await vi.waitFor(async () => expect((await f.database.syncStore.status.read()).runs).toHaveLength(2));
    const failed = (await f.database.syncStore.status.read()).runs[0]!;
    expect(failed).toMatchObject({
      installationId: first.id,
      reason: "schedule",
      state: "failed",
      startedAt,
      completedAt: expect.any(String),
      errorCode: "acquisition_failed",
      errorMessage: "Polling failed before acquisition started; committed progress is retained.",
      pageCount: 0,
      upsertCount: 0,
      changeCount: 0,
      checkpointRevision: checkpoint!.revision,
    });
    expect(Date.parse(failed.completedAt!)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    expect(await f.database.syncStore.getCheckpoint(first.id)).toEqual(checkpoint);
    await f.restart();
    const app = new Hono();
    registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery, f.scheduler);
    const response = await app.request("/api/sync/status");
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.installations[0]).toMatchObject({
      latestRun: JSON.parse(JSON.stringify(failed)),
      consecutiveFailures: 1,
      lastSuccessAt: first.lastSuccessAt,
      recordCount: 2,
    });
    expect(status.runs.map((run: { state: string }) => run.state)).toEqual(["failed", "succeeded"]);
    expect(JSON.stringify(status)).not.toContain("private-secret");
    f.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.state.verifications).toBe(2);
    f.state.verifyFails = false;
    vi.setSystemTime(status.installations[0].nextDueAt);
    f.scheduler.tick();
    await vi.waitFor(async () => expect((await f.database.syncStore.status.read()).runs[0]?.state).toBe("succeeded"));
    const retried = await f.database.syncStore.status.read();
    expect(retried.runs.map((run) => run.state)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(retried.installations[0]?.consecutiveFailures).toBe(0);
  });

  it("records a polling failure only once when acquisition already created the run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let fail = false;
    const f = await fixture({
      async *run() {
        if (fail) throw new Error("private-acquisition-error");
        yield { checkpoint: { cursor: 0 }, complete: true };
      },
    });
    const first = await f.runner.run({ definitionId: definition.id });
    const installation = (await f.database.syncStore.getInstallation(first.installationId!))!;
    fail = true;
    vi.setSystemTime(installation.nextDueAt!);
    f.scheduler.tick();
    await vi.waitFor(() => expect(f.runner.busy).toBe(false));
    const status = await f.database.syncStore.status.read();
    expect(status.runs.map((run) => run.state)).toEqual(["failed", "succeeded"]);
    expect(status.installations[0]?.consecutiveFailures).toBe(1);
    expect(JSON.stringify(status)).not.toContain("private-acquisition-error");
  });

  it("rolls back a sync removal if its tombstone cannot be saved", async () => {
    const f = await fixture();
    const first = await f.runner.run({ definitionId: definition.id });
    const store = f.database.syncStore;
    const installation = (await store.getInstallation(first.installationId!))!;
    await store.startRun({
      id: "removing",
      installationId: installation.id,
      definitionVersion: "1",
      reason: "manual",
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: now(),
    });
    const before = await store.getRun("removing");
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(
        "create trigger reject_removal before update of removed_at on sync_installations when new.removed_at is not null begin select raise(abort, 'removal write failed'); end;",
      );
      expect(() => store.schedule.remove(installation.id)).toThrow("removal write failed");
      expect(await store.getInstallation(installation.id)).toEqual(installation);
      expect(await store.getRun("removing")).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it("does not record a late verification failure after the sync was stopped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const first = await f.runner.run({ definitionId: definition.id });
    const installation = (await f.database.syncStore.getInstallation(first.installationId!))!;
    vi.setSystemTime(installation.nextDueAt!);
    f.database.syncStore.schedule.configure({ installationId: installation.id, enabled: false });
    const stopped = await f.database.syncStore.getInstallation(installation.id);
    f.database.syncStore.schedule.failBeforeRun({
      installation,
      startedAt: now(),
      completedAt: now(),
      errorCode: "acquisition_failed",
    });
    expect(await f.database.syncStore.getInstallation(installation.id)).toEqual(stopped);
    expect((await f.database.syncStore.status.read()).runs).toHaveLength(1);
  });

  it("commits a failed poll and its backoff atomically and ignores a repeated completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const first = await f.runner.run({ definitionId: definition.id });
    const installation = (await f.database.syncStore.getInstallation(first.installationId!))!;
    vi.setSystemTime(installation.nextDueAt!);
    const failure = { installation, startedAt: now(), completedAt: now(), errorCode: "acquisition_failed" };
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(`create trigger reject_backoff before update of consecutive_failures on sync_installations
        begin select raise(abort, 'backoff write failed'); end;`);
      expect(() => f.database.syncStore.schedule.failBeforeRun(failure)).toThrow("backoff write failed");
      const unchanged = await f.database.syncStore.status.read();
      expect(unchanged.runs).toHaveLength(1);
      expect(unchanged.installations[0]?.nextDueAt).toBe(installation.nextDueAt);
      expect(unchanged.installations[0]?.consecutiveFailures).toBe(0);
      raw.exec("drop trigger reject_backoff");
      f.database.syncStore.schedule.failBeforeRun(failure);
      f.database.syncStore.schedule.failBeforeRun(failure);
      const completed = await f.database.syncStore.status.read();
      expect(completed.runs.map((run) => run.state)).toEqual(["failed", "succeeded"]);
      expect(completed.installations[0]?.consecutiveFailures).toBe(1);
    } finally {
      raw.close();
    }
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
      const installation = (await f.database.syncStore.status.read()).installations[0]!;
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
      expect((await f.database.syncStore.status.read()).runs[0]?.state).toBe("cancelled");
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
    registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery, f.scheduler);
    expect((await app.request("/api/sync/status")).status).toBe(401);
    const status = await app.request("/api/sync/status", { headers: { authorization: "Bearer admin" } });
    expect(await status.json()).toMatchObject({
      schedulerRunning: false,
      installations: [
        {
          id: run.installationId,
          recordCount: 2,
          deliveredCount: 0,
          pendingCount: 2,
          latestRun: { state: "succeeded" },
        },
      ],
    });
    f.scheduler.start();
    expect(f.scheduler.running).toBe(true);
    const disabled = await app.request(`/api/sync/installations/${run.installationId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, scheduleSeconds: 120 }),
    });
    expect(disabled.status).toBe(200);
    await f.restart();
    expect(f.scheduler.running).toBe(false);
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
  await f.database.syncStore.delivery.configure({
    url: "https://log.example.com/records",
    bearerToken: "receiver",
    enabled: true,
  });
  f.scheduler.tick();
  await vi.waitFor(async () => expect((await f.database.syncStore.status.read()).runs[0]?.state).toBe("succeeded"));
  f.scheduler.tick();
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]?.operation !== "deleted" ? received[0]?.content.body : undefined).toContain("Commit 300");
  expect(received[0]?.operation !== "deleted" ? received[0]?.content.body : undefined).toContain("Thread 50");
  expect(received[0]?.revision).toBe(1);
  await vi.waitFor(async () => expect(f.database.syncStore.delivery.status().pendingRecords).toBe(0));
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
  expect(received[1]?.operation !== "deleted" ? received[1]?.content.body : undefined).toContain(
    "An old child comment was corrected",
  );
});

it("manages syncs through authenticated routes without losing committed progress", async () => {
  const cursors: number[] = [];
  const f = await fixture({
    async *run(context) {
      const cursor = Number((context.checkpoint as { cursor: number }).cursor);
      cursors.push(cursor);
      yield {
        records: [{ kind: "record", record: { id: String(cursor), body: "Saved" } }],
        checkpoint: { cursor: cursor + 1 },
        complete: cursor > 0,
      };
      if (!cursor)
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  const app = new Hono();
  app.use("/api/*", createLocalAuthMiddleware({ adminToken: "admin" }));
  registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery, f.scheduler);
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(`/api/sync/${path}`, {
      method,
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (const [path, method] of [
    ["installations", "POST"],
    ["installations/test", "DELETE"],
    ["installations/test/run", "POST"],
    ["destination", "PATCH"],
    ["destination", "DELETE"],
  ])
    expect((await app.request(`/api/sync/${path}`, { method })).status).toBe(401);
  expect((await request("installations", "POST", { definitionId: definition.id, scheduleSeconds: 1 })).status).toBe(
    400,
  );
  const created = await request("installations", "POST", {
    definitionId: definition.id,
    enabled: false,
    scheduleSeconds: 120,
  });
  expect(created.status).toBe(201);
  const sync = await created.json();
  expect(sync).toMatchObject({ state: "disabled", scheduleSeconds: 120 });
  expect((await request(`installations/${sync.id}/run`, "POST")).status).toBe(503);
  f.scheduler.start();
  expect((await request(`installations/${sync.id}`, "PATCH", { enabled: true })).status).toBe(200);
  await vi.waitFor(async () =>
    expect((await f.database.syncStore.getCheckpoint(sync.id))?.value).toEqual({ cursor: 1 }),
  );
  expect((await request(`installations/${sync.id}/run`, "POST")).status).toBe(409);
  expect((await request(`installations/${sync.id}`, "PATCH", { enabled: false })).status).toBe(200);
  await vi.waitFor(() => expect(f.runner.busy).toBe(false));
  const stopped = await (await request(`installations/${sync.id}/status`)).json();
  expect(stopped).toMatchObject({
    installations: [{ state: "disabled", recordCount: 1, consecutiveFailures: 0 }],
    runs: [{ state: "cancelled" }],
  });
  expect(stopped.installations[0].lastError).toBeUndefined();
  expect((await request(`installations/${sync.id}/run`, "POST")).status).toBe(202);
  await vi.waitFor(async () =>
    expect((await f.database.syncStore.status.read(sync.id)).runs.some((run) => run.state === "succeeded")).toBe(true),
  );
  expect(cursors).toEqual([0, 1]);
  expect((await request(`installations/${sync.id}`, "DELETE")).status).toBe(200);
  expect((await request(`installations/${sync.id}/status`)).status).toBe(404);
  expect((await request(`installations/${sync.id}`, "PATCH", { enabled: true })).status).toBe(404);
  await f.restart();
  f.scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(cursors).toEqual([0, 1]);
  expect((await f.database.syncStore.status.read()).installations).toEqual([]);
  const restored = await f.runner.create({ definitionId: definition.id, enabled: false, scheduleSeconds: 300 });
  expect(restored).toMatchObject({ id: sync.id, state: "disabled", scheduleSeconds: 300 });
  expect(restored.removedAt).toBeUndefined();
  expect((await f.database.syncStore.getCheckpoint(sync.id))?.value).toEqual({ cursor: 2 });
  expect((await f.database.syncStore.status.read(sync.id)).runs).toHaveLength(2);
});

it("validates singleton destination management and preserves the token on partial updates", async () => {
  const f = await fixture();
  const app = new Hono();
  app.use("/api/*", createLocalAuthMiddleware({ adminToken: "admin" }));
  registerSyncRoutes(app, f.runner, f.database.syncStore, f.delivery, f.scheduler);
  const request = (method: string, body?: unknown) =>
    app.request("/api/sync/destination", {
      method,
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  expect((await request("PUT", { url: "https://receiver.example.com/records", bearerToken: "secret" })).status).toBe(
    200,
  );
  expect((await request("PATCH", { url: "https://updated.example.com/records", enabled: false })).status).toBe(200);
  expect(await (await request("GET")).json()).toMatchObject({
    destination: { url: "https://updated.example.com/records", enabled: false },
  });
  expect((await request("PATCH", { bearerToken: "" })).status).toBe(400);
  expect((await request("PATCH", { url: "http://receiver.example.com" })).status).toBe(400);
  expect((await request("DELETE")).status).toBe(200);
  expect((await request("DELETE")).status).toBe(200);
  expect((await request("PATCH", { enabled: true })).status).toBe(409);
  expect(f.database.syncStore.delivery.getDestination()).toBeUndefined();
});
