import type { SyncDeliveryEnvelope } from "./delivery-store.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoggingReceiver } from "../../examples/sync/receiver-server.ts";
import { createSecretCodec } from "../server/secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { SyncDeliveryWorker } from "./delivery-worker.ts";

const cleanups: (() => Promise<void>)[] = [];
const definition = { id: "test", version: "1", provider: "github", kinds: [{ kind: "record" }] };
const now = () => new Date().toISOString();

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sync-delivery-"));
  const path = join(dir, "connector.sqlite");
  const codec = createSecretCodec(Buffer.alloc(32, 4).toString("base64"));
  let database = new SqliteRuntimeDatabase(path, { syncDefinitions: [definition], secretCodec: codec });
  cleanups.push(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  const connection = await database.connectionStore.set("github", "default", {
    authType: "api_key",
    apiKey: "provider-secret",
    profile: { accountId: "display", displayName: "Display", grantedScopes: [] },
    values: {},
    metadata: {},
  });
  const id = await database.syncStore.sources.bind({
    definitionId: "test",
    definitionVersion: "1",
    provider: "github",
    config: {},
    verifiedConnection: {
      id: connection.id,
      revision: connection.revision,
      service: "github",
      identity: { accountId: "native", authorizationBoundary: "scope" },
    },
    expectedBindingRevision: database.syncStore.sources.getBindingRevision(),
    createdAt: now(),
  });
  await database.syncStore.delivery.configure({
    url: "https://first.example.com/records",
    bearerToken: "receiver-secret",
    enabled: true,
  });
  await database.syncStore.startRun({
    id: "run",
    installationId: id,
    definitionVersion: "1",
    reason: "manual",
    leaseOwner: "owner",
    leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    startedAt: now(),
  });
  let revision = 0;
  const register = (name: string) =>
    database.syncStore.delivery.configure({
      url: `https://${name}.example.com/records`,
      bearerToken: "receiver-secret",
      enabled: true,
    });
  const commit = async (
    records = [{ kind: "record", record: { id: "one", body: "# Complete record" } }],
    deletes?: { kind: string; id: string }[],
  ) => {
    const result = await database.syncStore.commitPage({
      installationId: id,
      runId: "run",
      lease: { owner: "owner", generation: 1 },
      expectedCheckpointRevision: revision,
      nextCheckpoint: { cursor: revision },
      upserts: records,
      deletes,
      committedAt: now(),
    });
    revision = result.checkpoint.revision;
    return result;
  };
  return {
    get database() {
      return database;
    },
    id,
    register,
    commit,
    path,
    dir,
    restart() {
      database.close();
      database = new SqliteRuntimeDatabase(path, { syncDefinitions: [definition], secretCodec: codec });
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("durable sync delivery", () => {
  it("reports distinct live records separately from delivery history, including retries, purging and deletions", async () => {
    const f = await setup();
    const store = f.database.syncStore;
    await f.register("first");
    await f.commit([
      { kind: "record", record: { id: "one", body: "First" } },
      { kind: "record", record: { id: "two", body: "Second" } },
    ]);
    const stats = async () => (await store.status.read()).installations.find((item) => item.id === f.id);
    expect(await stats()).toMatchObject({
      recordCount: 2,
      deliveredCount: 0,
      pendingCount: 2,
      connectionName: "default",
      connectionStatus: "connected",
      latestRun: { id: "run" },
    });
    const first = (await store.delivery.claim(now()))!;
    expect(await stats()).toMatchObject({ pendingCount: 2 });
    store.delivery.complete({ lease: first, acknowledged: false, errorCode: "http_503", retryAt: now(), now: now() });
    expect(await stats()).toMatchObject({ recordCount: 2, deliveredCount: 0, pendingCount: 2 });
    expect(store.delivery.status()).toMatchObject({
      deliveredRecords: 0,
      pendingRecords: 2,
      lastError: "http_503",
      attemptCount: 1,
    });
    const retry = (await store.delivery.claim(now()))!;
    store.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect((await store.getRecord(f.id, "record", "one"))?.content).toBeUndefined();
    expect(await stats()).toMatchObject({ recordCount: 2, deliveredCount: 2, pendingCount: 0 });
    await f.commit([{ kind: "record", record: { id: "one", body: "Updated" } }], [{ kind: "record", id: "two" }]);
    expect(await stats()).toMatchObject({ recordCount: 1, deliveredCount: 2, pendingCount: 2 });
    await store.delivery.configure({
      url: "https://second.example.com/records",
      bearerToken: "receiver-secret",
      enabled: false,
    });
    expect(await stats()).toMatchObject({ pendingCount: 2 });

    store.delivery.remove();
    expect(await stats()).toMatchObject({ pendingCount: 2 });
    expect(store.delivery.status()).toMatchObject({ destination: undefined, pendingRecords: 2, deliveredRecords: 2 });

    const connection = await f.database.connectionStore.set("github", "another", {
      authType: "api_key",
      apiKey: "other-secret",
      profile: { accountId: "other", displayName: "Other", grantedScopes: [] },
      values: {},
      metadata: {},
    });
    const otherId = await store.sources.bind({
      definitionId: "test",
      definitionVersion: "1",
      provider: "github",
      config: {},
      createdAt: now(),
      verifiedConnection: {
        id: connection.id,
        revision: connection.revision,
        service: "github",
        identity: { accountId: "other", authorizationBoundary: "scope" },
      },
      expectedBindingRevision: store.sources.getBindingRevision(),
    });
    expect((await store.status.read()).installations.find((item) => item.id === otherId)).toMatchObject({
      recordCount: 0,
      deliveredCount: 0,
      pendingCount: 0,
      connectionName: "another",
      connectionStatus: "connected",
    });
    await f.database.connectionStore.set("github", "another", {
      authType: "api_key",
      apiKey: "changed",
      profile: { accountId: "other", displayName: "Other", grantedScopes: [] },
      values: {},
      metadata: {},
    });
    expect((await store.status.read()).installations.find((item) => item.id === otherId)?.connectionStatus).toBe(
      "changed",
    );
    await f.database.connectionStore.delete("github", "another");
    expect((await store.status.read()).installations.find((item) => item.id === otherId)?.connectionStatus).toBe(
      "missing",
    );
    expect(JSON.stringify({ ...(await store.status.read()), delivery: store.delivery.status() })).not.toContain(
      "secret",
    );
  });

  it("keeps each sync's latest iteration even when it falls outside the recent history window", async () => {
    const f = await setup();
    const raw = new DatabaseSync(f.path);
    try {
      raw.prepare("update sync_runs set state = 'succeeded', completed_at = started_at where id = 'run'").run();
      const insert =
        raw.prepare(`insert into sync_runs(id, installation_id, definition_version, reason, state, lease_owner, lease_generation, lease_expires_at, checkpoint_revision, binding_revision, started_at, completed_at)
        values (?, 'busy-other-sync', '1', 'schedule', 'succeeded', 'owner', 1, ?, 0, 1, ?, ?)`);
      for (let index = 0; index < 101; index++) {
        const timestamp = new Date(Date.now() + 1000 + index).toISOString();
        insert.run(`other-${index}`, timestamp, timestamp, timestamp);
      }
      const status = await f.database.syncStore.status.read();
      expect(status.runs).toHaveLength(100);
      expect(status.runs.some((run) => run.id === "run")).toBe(false);
      expect(status.installations[0]?.latestRun).toMatchObject({ id: "run", state: "succeeded" });
      expect((await f.database.syncStore.status.read(f.id)).runs.map((run) => run.id)).toEqual(["run"]);
    } finally {
      raw.close();
    }
  });

  it("rolls back destination removal when delivery fencing fails", async () => {
    const f = await setup();
    await f.commit();
    const lease = (await f.database.syncStore.delivery.claim(now()))!;
    const sql = new DatabaseSync(f.path);
    try {
      sql.exec(
        "create trigger reject_fence before update on sync_delivery_batches begin select raise(abort, 'fencing failed'); end;",
      );
      expect(() => f.database.syncStore.delivery.remove()).toThrow("fencing failed");
      expect(f.database.syncStore.delivery.getDestination()?.enabled).toBe(true);
      sql.exec("drop trigger reject_fence");
      f.database.syncStore.delivery.complete({ lease, acknowledged: true, now: now() });
      expect(f.database.syncStore.delivery.status().deliveredRecords).toBe(1);
    } finally {
      sql.close();
    }
  });

  it("closes an interrupted attempt when a receiver changes and rejects its late ACK", async () => {
    const f = await setup();
    await f.register("first");
    await f.commit();
    const old = (await f.database.syncStore.delivery.claim(now()))!;
    await f.database.syncStore.delivery.configure({
      url: "https://new.example.com/records",
      bearerToken: "rotated-token",
      enabled: true,
    });
    const sql = new DatabaseSync(f.path);
    try {
      expect(
        sql
          .prepare("select completed_at, error_code from sync_delivery_attempts where batch_id = ? and attempt = 1")
          .get(old.id),
      ).toEqual({ completed_at: expect.any(String), error_code: "destination_changed" });
    } finally {
      sql.close();
    }
    expect(() => f.database.syncStore.delivery.complete({ lease: old, acknowledged: true, now: now() })).toThrow(
      "lease",
    );
    const retry = (await f.database.syncStore.delivery.claim(now()))!;
    expect(retry).toMatchObject({
      id: old.id,
      body: old.body,
      attempt: 2,
      url: "https://new.example.com/records",
      bearerToken: "rotated-token",
    });
    f.database.syncStore.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect(f.database.syncStore.delivery.status()).toMatchObject({ deliveredRecords: 1, pendingRecords: 0 });
  });

  it("retains pending records across destination removal and restart, then delivers identical events to the replacement", async () => {
    const f = await setup();
    const committed = await f.commit();
    const old = (await f.database.syncStore.delivery.claim(now()))!;
    await f.commit([{ kind: "record", record: { id: "two", body: "Waiting for its first batch" } }]);
    f.database.syncStore.delivery.remove();
    expect(() => f.database.syncStore.delivery.complete({ lease: old, acknowledged: true, now: now() })).toThrow(
      "lease",
    );
    f.restart();
    expect(f.database.syncStore.delivery.status()).toMatchObject({
      destination: undefined,
      pendingRecords: 2,
      deliveredRecords: 0,
    });
    expect(await f.database.syncStore.delivery.claim(now())).toBeUndefined();
    f.database.syncStore.delivery.purge();
    expect((await f.database.syncStore.getRecord(f.id, "record", "one"))?.content?.body).toBe("# Complete record");
    await expect(f.commit()).rejects.toMatchObject({ code: "destination_required" });
    expect((await f.database.syncStore.getCheckpoint(f.id))?.revision).toBe(2);
    await f.register("replacement");
    const retry = (await f.database.syncStore.delivery.claim(now()))!;
    expect(retry).toMatchObject({ id: old.id, body: old.body, url: "https://replacement.example.com/records" });
    const record = (JSON.parse(retry.body) as SyncDeliveryEnvelope).records[0]!;
    expect(record.eventId).toBe(committed.changes[0]!.eventId);
    expect(record.revision).toBe(1);
    f.database.syncStore.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect((await f.database.syncStore.getRecord(f.id, "record", "one"))?.content).toBeUndefined();
    expect((await f.database.syncStore.getRecord(f.id, "record", "two"))?.content).toBeDefined();
    const unbatched = (await f.database.syncStore.delivery.claim(now()))!;
    expect(JSON.parse(unbatched.body).records[0]).toMatchObject({
      id: "two",
      content: { body: "Waiting for its first batch" },
    });
    f.database.syncStore.delivery.complete({ lease: unbatched, acknowledged: true, now: now() });
    expect((await f.commit()).changes).toHaveLength(0);
    expect(await f.database.syncStore.delivery.claim(now())).toBeUndefined();
    const deletion = await f.commit([], [{ kind: "record", id: "one" }]);
    expect(deletion.changes[0]?.recordRevision).toBe(2);
    const tombstone = JSON.parse((await f.database.syncStore.delivery.claim(now()))!.body).records[0];
    expect(tombstone.operation).toBe("deleted");
    expect(tombstone.content).toBeUndefined();
  });

  it("bounds stable membership and fences stale acknowledgements after lease expiry or receiver rotation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await setup();
    await f.register("first");
    await f.commit(
      Array.from({ length: 51 }, (_, index) => ({ kind: "record", record: { id: String(index), body: "# Record" } })),
    );
    const first = (await f.database.syncStore.delivery.claim(now()))!;
    expect(JSON.parse(first.body).records).toHaveLength(50);
    expect(await f.database.syncStore.delivery.claim(now())).toBeUndefined();
    vi.setSystemTime(Date.now() + 61_000);
    f.restart();
    const reclaimed = (await f.database.syncStore.delivery.claim(now()))!;
    expect(reclaimed.body).toBe(first.body);
    expect(() => f.database.syncStore.delivery.complete({ lease: first, acknowledged: true, now: now() })).toThrow(
      "no longer owned",
    );
    await f.register("first");
    expect(() => f.database.syncStore.delivery.complete({ lease: reclaimed, acknowledged: true, now: now() })).toThrow(
      "no longer owned",
    );
    const rotated = (await f.database.syncStore.delivery.claim(now()))!;
    f.database.syncStore.delivery.complete({ lease: rotated, acknowledged: true, now: now() });
    expect(JSON.parse((await f.database.syncStore.delivery.claim(now()))!.body).records).toHaveLength(1);
  });

  it("honors Retry-After, hides/encrypts secrets and rejects private or non-HTTPS receivers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await setup();
    await f.register("first");
    await f.commit();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not saved", { status: 429, headers: { "retry-after": "120" } }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const worker = new SyncDeliveryWorker({ store: f.database.syncStore.delivery, fetcher });
    expect(await worker.tick()).toBe(true);
    expect(await worker.tick()).toBe(false);
    const status = f.database.syncStore.delivery.status();
    expect(status.lastError).toBe("http_429");
    expect(JSON.stringify(status)).not.toContain("receiver-secret");
    const raw = new DatabaseSync(f.path);
    const secret = raw.prepare("select bearer_secret from sync_destination").get()!.bearer_secret;
    raw.close();
    expect(secret).not.toContain("receiver-secret");
    vi.setSystemTime(Date.now() + 121_000);
    expect(await worker.tick()).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer receiver-secret" },
    });
    for (const url of ["http://public.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.1"])
      await expect(
        f.database.syncStore.delivery.configure({ url, bearerToken: "secret", enabled: true }),
      ).rejects.toThrow();
  });

  it("delivers to the real logging receiver, which deduplicates retries and rejects older revisions", async () => {
    const f = await setup();
    const received: unknown[] = [];
    const receiver = await startLoggingReceiver({
      databasePath: join(f.dir, "receiver.sqlite"),
      bearerToken: "receiver-secret",
      onRecord: (record) => received.push(record),
    });
    cleanups.push(receiver.close);
    await f.register("first");
    await f.commit();
    const lease = (await f.database.syncStore.delivery.claim(now()))!;
    const send = (body: string, token = "receiver-secret") =>
      fetch(receiver.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    expect((await send(lease.body, "wrong")).status).toBe(401);
    expect((await send(lease.body)).status).toBe(200);
    expect((await send(lease.body)).status).toBe(200);
    const newer = JSON.parse(lease.body) as SyncDeliveryEnvelope;
    newer.batchId = "01991c55-a120-7394-aef7-b08403e90942";
    const newerRecord = newer.records[0]!;
    if (newerRecord.operation === "deleted") throw new Error("Expected an upsert delivery.");
    newerRecord.eventId = "01991c55-a120-7394-aef7-b08403e90943";
    newerRecord.revision = 2;
    newerRecord.content = { body: "# New" };
    newerRecord.contentHash = "1".repeat(64);
    expect((await send(JSON.stringify(newer))).status).toBe(200);
    const stale = JSON.parse(lease.body);
    stale.batchId = "01991c55-a120-7394-aef7-b08403e90944";
    stale.records[0].eventId = "01991c55-a120-7394-aef7-b08403e90945";
    expect((await send(JSON.stringify(stale))).status).toBe(200);
    expect(received).toHaveLength(2);
    f.database.syncStore.delivery.complete({ lease, acknowledged: false, now: now(), retryAt: now() });
    const worker = new SyncDeliveryWorker({
      store: f.database.syncStore.delivery,
      fetcher: (_url, init) => fetch(receiver.url, init),
    });
    await worker.tick();
    expect(received).toHaveLength(2);
    expect(f.database.syncStore.delivery.status()?.pendingRecords).toBe(0);
  });
});

describe("iteration delivery and destination management", () => {
  it("keeps delivery progress for failed polls across retries and restarts", async () => {
    const f = await setup();
    await f.register("first");
    const store = f.database.syncStore;
    await f.commit();
    await store.finishRun({
      runId: "run",
      owner: "owner",
      generation: 1,
      state: "failed",
      completedAt: now(),
      errorCode: "acquisition_failed",
    });
    expect((await store.status.getRun("run"))?.delivery).toMatchObject({
      state: "pending",
      totalRecords: 1,
      pendingRecords: 1,
    });
    const first = (await store.delivery.claim(now()))!;
    expect((await store.status.getRun("run"))?.delivery.state).toBe("delivering");
    store.delivery.complete({ lease: first, acknowledged: false, errorCode: "http_503", retryAt: now(), now: now() });
    f.restart();
    expect((await f.database.syncStore.status.getRun("run"))?.delivery).toMatchObject({
      state: "retrying",
      lastError: "http_503",
      pendingRecords: 1,
    });
    const retry = (await f.database.syncStore.delivery.claim(now()))!;
    f.database.syncStore.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect(await f.database.syncStore.status.getRun("run")).toMatchObject({
      state: "failed",
      errorCode: "acquisition_failed",
      delivery: { state: "delivered", deliveredRecords: 1, pendingRecords: 0 },
    });
  });

  it("attributes changes to their polling iteration without recounting prior delivery", async () => {
    const f = await setup();
    const store = f.database.syncStore;
    await f.register("first");
    await f.commit();
    const first = (await store.delivery.claim(now()))!;
    store.delivery.complete({ lease: first, acknowledged: true, now: now() });
    await store.finishRun({
      runId: "run",
      owner: "owner",
      generation: 1,
      state: "succeeded",
      completedAt: now(),
    });
    await f.register("second");
    await store.startRun({
      id: "backfill",
      installationId: f.id,
      definitionVersion: "1",
      reason: "backfill",
      leaseOwner: "owner",
      leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: now(),
    });
    const page = {
      installationId: f.id,
      runId: "backfill",
      lease: { owner: "owner", generation: 1 },
      expectedCheckpointRevision: 1,
      nextCheckpoint: {},
      upserts: [
        { kind: "record", record: { id: "one", body: "# Complete record" } },
        { kind: "record", record: { id: "two", body: "New record" } },
      ],
      committedAt: now(),
    };
    expect((await store.commitPage(page)).changes).toHaveLength(1);
    await store.commitPage({ ...page, expectedCheckpointRevision: 2 });
    expect((await store.status.getRun("run"))?.delivery).toMatchObject({ state: "delivered", totalRecords: 1 });
    expect((await store.status.getRun("backfill"))?.delivery).toMatchObject({ state: "pending", totalRecords: 1 });
    const pending = (await store.delivery.claim(now()))!;
    store.delivery.complete({ lease: pending, acknowledged: true, now: now() });
    expect((await store.status.getRun("backfill"))?.delivery).toMatchObject({ state: "delivered", totalRecords: 1 });
  });

  it("updates a destination without returning or replacing its token and fences old acknowledgements", async () => {
    const f = await setup();
    await f.register("first");
    await f.commit();
    const delivery = f.database.syncStore.delivery;
    const old = (await delivery.claim(now()))!;
    await delivery.update({ url: "https://updated.example.com/records" });
    expect(() => delivery.complete({ lease: old, acknowledged: true, now: now() })).toThrow("no longer owned");
    const fresh = (await delivery.claim(now()))!;
    expect(fresh.url).toBe("https://updated.example.com/records");
    expect(fresh.bearerToken).toBe("receiver-secret");
    expect(fresh.body).toBe(old.body);
    expect(JSON.stringify(delivery.status())).not.toContain("receiver-secret");
    delivery.remove();
    await expect(delivery.update({ enabled: false })).rejects.toMatchObject({ code: "destination_required" });
    await expect(delivery.update({ url: "https://127.0.0.1" })).rejects.toThrow();
  });

  it("keeps per-iteration delivery pending when configuration is removed and reports its eventual acknowledgement", async () => {
    const f = await setup();
    await f.commit();
    const store = f.database.syncStore;
    const old = (await store.delivery.claim(now()))!;
    store.delivery.remove();
    expect(() => store.delivery.complete({ lease: old, acknowledged: true, now: now() })).toThrow("no longer owned");
    expect(store.delivery.status()).toMatchObject({ destination: undefined, pendingRecords: 1 });
    expect(store.status.getRun("run")?.delivery).toMatchObject({
      state: "waiting",
      totalRecords: 1,
      pendingRecords: 1,
      nextAttemptAt: undefined,
    });
    const raw = new DatabaseSync(f.path);
    try {
      expect(raw.prepare("select count(*) as count from sync_destination").get()?.count).toBe(0);
    } finally {
      raw.close();
    }
    f.restart();
    expect(f.database.syncStore.status.getRun("run")?.delivery.state).toBe("waiting");
    await f.register("replacement");
    const next = (await f.database.syncStore.delivery.claim(now()))!;
    expect(next.body).toBe(old.body);
    f.database.syncStore.delivery.complete({ lease: next, acknowledged: true, now: now() });
    expect(f.database.syncStore.status.getRun("run")?.delivery).toMatchObject({
      state: "delivered",
      deliveredRecords: 1,
      pendingRecords: 0,
    });
  });
});
