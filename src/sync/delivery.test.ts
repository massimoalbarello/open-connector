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
    database.syncStore.delivery.register({
      id: name,
      url: `https://${name}.example.com/records`,
      bearerToken: "receiver-secret",
      enabled: true,
    });
  const commit = async (
    records = [{ kind: "record", record: { id: "one", body: "# Complete record" } }],
    targetReceiverId?: string,
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
      targetReceiverId,
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
    await f.register("second");
    await f.commit([
      { kind: "record", record: { id: "one", body: "First" } },
      { kind: "record", record: { id: "two", body: "Second" } },
    ]);
    const stats = async () => (await store.status.read()).installations.find((item) => item.id === f.id);
    expect(await stats()).toMatchObject({
      recordCount: 2,
      deliveredCount: 0,
      pendingCount: 4,
      connectionName: "default",
      connectionStatus: "connected",
      latestRun: { id: "run" },
    });
    const first = (await store.delivery.claim(now()))!;
    expect(await stats()).toMatchObject({ pendingCount: 4 });
    const acknowledgedAt = now();
    store.delivery.complete({ lease: first, acknowledged: true, now: acknowledgedAt });
    const second = (await store.delivery.claim(now()))!;
    store.delivery.complete({ lease: second, acknowledged: false, errorCode: "http_503", retryAt: now(), now: now() });
    expect(await stats()).toMatchObject({ recordCount: 2, deliveredCount: 2, pendingCount: 2 });
    expect(await store.delivery.list()).toMatchObject([
      { id: "first", deliveredRecords: 2, pendingRecords: 0, lastDeliveredAt: acknowledgedAt, attemptCount: 0 },
      { id: "second", deliveredRecords: 0, pendingRecords: 2, lastError: "http_503", attemptCount: 1 },
    ]);
    const retry = (await store.delivery.claim(now()))!;
    store.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect((await store.getRecord(f.id, "record", "one"))?.content).toBeUndefined();
    expect(await stats()).toMatchObject({ recordCount: 2, deliveredCount: 4, pendingCount: 0 });
    await f.commit([{ kind: "record", record: { id: "one", body: "Updated" } }], undefined, [
      { kind: "record", id: "two" },
    ]);
    expect(await stats()).toMatchObject({ recordCount: 1, deliveredCount: 4, pendingCount: 4 });
    await store.delivery.register({
      id: "second",
      url: "https://second.example.com/records",
      bearerToken: "receiver-secret",
      enabled: false,
    });
    expect(await stats()).toMatchObject({ pendingCount: 4 });

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
    expect(JSON.stringify({ ...(await store.status.read()), receivers: await store.delivery.list() })).not.toContain(
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
    } finally {
      raw.close();
    }
  });

  it("closes an interrupted attempt when a receiver changes and rejects its late ACK", async () => {
    const f = await setup();
    await f.register("first");
    await f.commit();
    const old = (await f.database.syncStore.delivery.claim(now()))!;
    await f.database.syncStore.delivery.register({
      id: "first",
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
      ).toEqual({ completed_at: expect.any(String), error_code: "receiver_reconfigured" });
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
    expect((await f.database.syncStore.delivery.list())[0]).toMatchObject({ deliveredRecords: 1, pendingRecords: 0 });
  });

  it("keeps immutable payloads until all ACKs, retries identical batches after restart, and bootstraps one new receiver", async () => {
    const f = await setup();
    await f.register("first");
    await f.register("second");
    const committed = await f.commit();
    const first = (await f.database.syncStore.delivery.claim(now()))!;
    f.database.syncStore.delivery.complete({ lease: first, acknowledged: true, now: now() });
    expect((await f.database.syncStore.getRecord(f.id, "record", "one"))?.content).toBeDefined();
    const second = (await f.database.syncStore.delivery.claim(now()))!;
    f.database.syncStore.delivery.complete({
      lease: second,
      acknowledged: false,
      retryAt: now(),
      errorCode: "http_500",
      now: now(),
    });
    f.restart();
    const retry = (await f.database.syncStore.delivery.claim(now()))!;
    expect(retry.body).toBe(second.body);
    expect(retry.attempt).toBe(2);
    f.database.syncStore.delivery.complete({ lease: retry, acknowledged: true, now: now() });
    expect((await f.database.syncStore.getRecord(f.id, "record", "one"))?.content).toBeUndefined();
    expect((await f.commit()).changes).toHaveLength(0);
    await f.register("new");
    expect(await f.database.syncStore.delivery.claim(now())).toBeUndefined();
    expect((await f.commit(undefined, "new")).changes).toHaveLength(0);
    const bootstrap = (await f.database.syncStore.delivery.claim(now()))!;
    const record = (JSON.parse(bootstrap.body) as SyncDeliveryEnvelope).records[0]!;
    expect(record.eventId).toBe(committed.changes[0]!.eventId);
    expect(record.revision).toBe(1);
    expect(record.content?.body).toBe("# Complete record");
    expect(await f.database.syncStore.listOutbox("first")).toHaveLength(1);
    f.database.syncStore.delivery.complete({ lease: bootstrap, acknowledged: true, now: now() });
    const deletion = await f.commit([], undefined, [{ kind: "record", id: "one" }]);
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
    const status = await f.database.syncStore.delivery.list();
    expect(status[0]?.lastError).toBe("http_429");
    expect(JSON.stringify(status)).not.toContain("receiver-secret");
    const raw = new DatabaseSync(f.path);
    const secret = raw.prepare("select bearer_secret from sync_receivers").get()!.bearer_secret;
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
        f.database.syncStore.delivery.register({ id: "blocked", url, bearerToken: "secret", enabled: true }),
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
    newer.batchId = "newer";
    newer.records[0]!.eventId = "new-event";
    newer.records[0]!.revision = 2;
    newer.records[0]!.content = { body: "# New" };
    newer.records[0]!.contentHash = "new-hash";
    expect((await send(JSON.stringify(newer))).status).toBe(200);
    const stale = JSON.parse(lease.body);
    stale.batchId = "stale";
    stale.records[0].eventId = "old-event";
    expect((await send(JSON.stringify(stale))).status).toBe(200);
    expect(received).toHaveLength(2);
    f.database.syncStore.delivery.complete({ lease, acknowledged: false, now: now(), retryAt: now() });
    const worker = new SyncDeliveryWorker({
      store: f.database.syncStore.delivery,
      fetcher: (_url, init) => fetch(receiver.url, init),
    });
    await worker.tick();
    expect(received).toHaveLength(2);
    expect((await f.database.syncStore.delivery.list())[0]?.pendingRecords).toBe(0);
  });
});
