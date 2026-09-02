import type { SyncLeaseInput } from "./sync-store.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";

const t0 = "2026-09-02T10:00:00.000Z";
const t1 = "2026-09-02T10:01:00.000Z";
const t2 = "2026-09-02T10:02:00.000Z";
const t3 = "2026-09-02T10:03:00.000Z";
const t4 = "2026-09-02T10:04:00.000Z";
const leaseExpiry = "2026-09-02T11:00:00.000Z";

interface Fixture {
  directory: string;
  databasePath: string;
  database: SqliteRuntimeDatabase;
  connectionId: string;
  lease: SyncLeaseInput;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("SQLite sync state", () => {
  it("atomically advances records, changes, outbox entries, and checkpoints", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;

    const added = await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "page-1" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { title: "First", number: 1 } }],
    });
    expect(added).toMatchObject({
      checkpoint: { revision: 1, value: { cursor: "page-1" } },
      changes: [{ operation: "added", recordId: "PR_1", recordRevision: 1 }],
    });

    const unchanged = await store.commitPage({
      ...commitIdentity(fixture, 1, t2),
      nextCheckpoint: { cursor: "page-2" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1, title: "First" } }],
    });
    expect(unchanged.changes).toEqual([]);
    expect(unchanged.checkpoint.revision).toBe(2);

    const updated = await store.commitPage({
      ...commitIdentity(fixture, 2, t3),
      nextCheckpoint: { cursor: "page-3" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1, title: "Updated" } }],
    });
    expect(updated.changes).toMatchObject([{ operation: "updated", recordRevision: 2 }]);

    const deleted = await store.commitPage({
      ...commitIdentity(fixture, 3, t4),
      nextCheckpoint: { cursor: "page-4" },
      deletes: [{ model: "PullRequest", id: "PR_1" }],
    });
    expect(deleted.changes).toMatchObject([
      {
        operation: "deleted",
        recordRevision: 3,
        payload: { number: 1, title: "Updated" },
        deletedAt: t4,
      },
    ]);

    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      revision: 3,
      deletedAt: t4,
      payload: { number: 1, title: "Updated" },
    });
    await expect(store.listChanges()).resolves.toMatchObject({
      items: [
        { operation: "added", recordRevision: 1 },
        { operation: "updated", recordRevision: 2 },
        { operation: "deleted", recordRevision: 3 },
      ],
    });
    await expect(store.listOutbox("consumer-http")).resolves.toMatchObject([
      { changeSequence: 1, state: "pending" },
      { changeSequence: 2, state: "pending" },
      { changeSequence: 3, state: "pending" },
    ]);
    await expect(store.getRun("run-1")).resolves.toMatchObject({
      pageCount: 4,
      upsertCount: 3,
      deleteCount: 1,
      changeCount: 3,
      checkpointRevision: 4,
    });
  });

  it("rolls back the entire page when checkpoint persistence fails and safely retries it", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    const injector = new DatabaseSync(fixture.databasePath);
    injector.exec(`
      create trigger fail_sync_checkpoint before insert on sync_checkpoints begin
        select raise(abort, 'checkpoint failed');
      end;
    `);
    injector.close();

    const commit = {
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "page-1" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    };
    await expect(store.commitPage(commit)).rejects.toThrow("checkpoint failed");
    await expect(store.getCheckpoint("github-prs")).resolves.toBeUndefined();
    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toBeUndefined();
    await expect(store.listChanges()).resolves.toEqual({ items: [], nextSequence: undefined });
    await expect(store.listOutbox("consumer-http")).resolves.toEqual([]);
    await expect(store.getRun("run-1")).resolves.toMatchObject({ pageCount: 0, changeCount: 0 });

    const repair = new DatabaseSync(fixture.databasePath);
    repair.exec("drop trigger fail_sync_checkpoint;");
    repair.close();
    await expect(store.commitPage(commit)).resolves.toMatchObject({
      checkpoint: { revision: 1 },
      changes: [{ operation: "added" }],
    });
  });

  it("makes repeated deletes idempotent and emits an added change when a tombstone is resurrected", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "seed" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    });
    await store.commitPage({
      ...commitIdentity(fixture, 1, t2),
      nextCheckpoint: { cursor: "deleted" },
      deletes: [{ model: "PullRequest", id: "PR_1" }],
    });
    const repeatedDelete = await store.commitPage({
      ...commitIdentity(fixture, 2, t3),
      nextCheckpoint: { cursor: "still-deleted" },
      deletes: [{ model: "PullRequest", id: "PR_1" }],
    });
    expect(repeatedDelete.changes).toEqual([]);

    const resurrected = await store.commitPage({
      ...commitIdentity(fixture, 3, t4),
      nextCheckpoint: { cursor: "resurrected" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1, restored: true } }],
    });
    expect(resurrected.changes).toMatchObject([{ operation: "added", recordRevision: 3 }]);
    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      revision: 3,
      deletedAt: undefined,
      payload: { number: 1, restored: true },
    });
  });

  it("rejects duplicate and non-JSON records before changing durable state", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 0, t1),
        nextCheckpoint: { cursor: "invalid" },
        upserts: [
          { model: "PullRequest", id: "PR_1", payload: { number: 1 } },
          { model: "PullRequest", id: "PR_1", payload: { number: 2 } },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 0, t1),
        nextCheckpoint: { cursor: "invalid" },
        upserts: [{ model: "PullRequest", id: "PR_2", payload: { number: Number.NaN } }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.getCheckpoint("github-prs")).resolves.toBeUndefined();
    await expect(store.listChanges()).resolves.toEqual({ items: [], nextSequence: undefined });
  });

  it("fences stale checkpoints, expired leases, and previous lease generations", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "page-1" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    });

    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 0, t2),
        nextCheckpoint: { cursor: "stale" },
        upserts: [{ model: "PullRequest", id: "PR_2", payload: { number: 2 } }],
      }),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 1, "2026-09-02T12:00:00.000Z"),
        nextCheckpoint: { cursor: "expired" },
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });

    const renewed = await store.renewRunLease({
      runId: "run-1",
      ...fixture.lease,
      expiresAt: "2026-09-02T12:00:00.000Z",
    });
    expect(renewed.leaseGeneration).toBe(2);
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 1, t2),
        nextCheckpoint: { cursor: "old-lease" },
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });

    fixture.lease = { owner: "worker-1", generation: 2, observedAt: t2 };
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 1, t2),
        nextCheckpoint: { cursor: "page-2" },
      }),
    ).resolves.toMatchObject({ checkpoint: { revision: 2 } });
  });

  it("tombstones only baseline records missing from a successfully finished snapshot", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "seed" },
      upserts: [
        { model: "PullRequest", id: "PR_1", payload: { number: 1 } },
        { model: "PullRequest", id: "PR_2", payload: { number: 2 } },
      ],
    });
    await store.startSnapshot({
      id: "snapshot-1",
      installationId: "github-prs",
      runId: "run-1",
      models: ["PullRequest"],
      lease: fixture.lease,
      expectedCheckpointRevision: 1,
      startedAt: t2,
    });
    await store.commitPage({
      ...commitIdentity(fixture, 1, t3),
      snapshotId: "snapshot-1",
      nextCheckpoint: { cursor: "scan-page-1" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    });

    const result = await store.finishSnapshot({
      installationId: "github-prs",
      runId: "run-1",
      snapshotId: "snapshot-1",
      lease: fixture.lease,
      expectedCheckpointRevision: 2,
      nextCheckpoint: { cursor: "scan-complete" },
      committedAt: t4,
    });
    expect(result).toMatchObject({
      checkpoint: { revision: 3, value: { cursor: "scan-complete" } },
      changes: [{ operation: "deleted", recordId: "PR_2" }],
      deleteCount: 1,
    });
    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      deletedAt: undefined,
    });
    await expect(store.getRecord("github-prs", "PullRequest", "PR_2")).resolves.toMatchObject({ deletedAt: t4 });
  });

  it("abandons an incomplete snapshot without deleting unseen records", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "seed" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    });
    await store.startSnapshot({
      id: "snapshot-1",
      installationId: "github-prs",
      runId: "run-1",
      models: ["PullRequest"],
      lease: fixture.lease,
      expectedCheckpointRevision: 1,
      startedAt: t2,
    });

    await store.finishRun({
      runId: "run-1",
      ...fixture.lease,
      state: "failed",
      completedAt: t3,
      errorCode: "provider_error",
    });
    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      deletedAt: undefined,
    });
    await expect(
      store.finishSnapshot({
        installationId: "github-prs",
        runId: "run-1",
        snapshotId: "snapshot-1",
        lease: fixture.lease,
        expectedCheckpointRevision: 1,
        nextCheckpoint: { cursor: "unsafe" },
        committedAt: t4,
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("persists cache, checkpoint, and change-feed state across a process restart", async () => {
    const fixture = await createFixture();
    await fixture.database.syncStore.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: { cursor: "durable" },
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { number: 1 } }],
    });
    fixture.database.close();

    fixture.database = new SqliteRuntimeDatabase(fixture.databasePath);
    await expect(fixture.database.syncStore.getCheckpoint("github-prs")).resolves.toMatchObject({
      revision: 1,
      value: { cursor: "durable" },
    });
    await expect(fixture.database.syncStore.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      revision: 1,
      payload: { number: 1 },
    });
    await expect(fixture.database.syncStore.listChanges({ afterSequence: 0 })).resolves.toMatchObject({
      items: [{ eventId: expect.any(String), operation: "added" }],
    });
  });

  it("rejects installations that do not bind to the selected provider connection", async () => {
    const fixture = await createFixture({ createInstallation: false });
    await expect(
      fixture.database.syncStore.createInstallation({
        id: "bad-installation",
        definitionId: "github.pull-requests",
        definitionVersion: "1.0.0",
        provider: "gmail",
        connectionId: fixture.connectionId,
        config: {},
        createdAt: t0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

async function createFixture(options: { createInstallation?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "open-connector-sync-"));
  const databasePath = join(directory, "connect.sqlite");
  const database = new SqliteRuntimeDatabase(databasePath);
  const connection = await database.connectionStore.set("github", "default", {
    authType: "api_key",
    apiKey: "test-token",
    values: { apiKey: "test-token" },
    profile: { accountId: "octocat", displayName: "Octocat", grantedScopes: ["repo"] },
    metadata: {},
  });
  const fixture: Fixture = {
    directory,
    databasePath,
    database,
    connectionId: connection.id,
    lease: { owner: "worker-1", generation: 1, observedAt: t1 },
  };
  fixtures.push(fixture);
  if (options.createInstallation !== false) {
    await database.syncStore.createInstallation({
      id: "github-prs",
      definitionId: "github.pull-requests",
      definitionVersion: "1.0.0",
      provider: "github",
      connectionId: connection.id,
      config: { owner: "openai", repository: "openai-node" },
      scheduleSeconds: 300,
      createdAt: t0,
    });
    await database.syncStore.registerSink({
      id: "consumer-http",
      kind: "http",
      enabled: true,
      updatedAt: t0,
    });
    await database.syncStore.startRun({
      id: "run-1",
      installationId: "github-prs",
      definitionVersion: "1.0.0",
      reason: "backfill",
      leaseOwner: "worker-1",
      leaseExpiresAt: leaseExpiry,
      startedAt: t0,
    });
  }
  return fixture;
}

function commitIdentity(fixture: Fixture, revision: number, observedAt: string) {
  return {
    installationId: "github-prs",
    runId: "run-1",
    lease: { ...fixture.lease, observedAt },
    expectedCheckpointRevision: revision,
    committedAt: observedAt,
  };
}
