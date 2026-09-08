import type { FinishSyncRunInput, SyncLeaseInput } from "./sync-store.ts";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);
});

afterEach(async () => {
  vi.useRealTimers();
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

    fixture.lease = { owner: "worker-1", generation: 2 };
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 1, t2),
        nextCheckpoint: { cursor: "page-2" },
      }),
    ).resolves.toMatchObject({ checkpoint: { revision: 2 } });

    vi.setSystemTime("2026-09-02T12:00:00.000Z");
    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 2, t2),
        nextCheckpoint: { cursor: "expired" },
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("uses transaction-time lease expiry even when callers reuse old timestamps", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.startSnapshot({
      id: "snapshot-1",
      installationId: "github-prs",
      runId: "run-1",
      models: ["PullRequest"],
      lease: fixture.lease,
      expectedCheckpointRevision: 0,
      startedAt: t1,
    });
    vi.setSystemTime(leaseExpiry);

    await expect(
      store.commitPage({
        ...commitIdentity(fixture, 0, t1),
        snapshotId: "snapshot-1",
        nextCheckpoint: { cursor: "late" },
        upserts: [{ model: "PullRequest", id: "PR_1", payload: { body: "Late" } }],
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(
      store.renewRunLease({
        runId: "run-1",
        ...fixture.lease,
        expiresAt: "2026-09-02T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(
      store.finishSnapshot({
        installationId: "github-prs",
        runId: "run-1",
        snapshotId: "snapshot-1",
        lease: fixture.lease,
        expectedCheckpointRevision: 0,
        nextCheckpoint: null,
        committedAt: t1,
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(
      store.startSnapshot({
        id: "snapshot-2",
        installationId: "github-prs",
        runId: "run-1",
        models: ["PullRequest"],
        lease: fixture.lease,
        expectedCheckpointRevision: 0,
        startedAt: t1,
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(
      store.finishRun({
        runId: "run-1",
        ...fixture.lease,
        state: "failed",
        completedAt: t1,
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(store.getCheckpoint("github-prs")).resolves.toBeUndefined();
    await expect(store.listChanges()).resolves.toMatchObject({ items: [] });
    await expect(store.listOutbox("consumer-http")).resolves.toEqual([]);
  });

  it("rejects expired initial leases and renewals", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await expect(
      store.startRun({
        id: "run-past",
        installationId: "github-prs",
        definitionVersion: "1.0.0",
        reason: "retry",
        leaseOwner: "worker-2",
        startedAt: "2026-09-01T00:00:00.000Z",
        leaseExpiresAt: t0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.renewRunLease({
        runId: "run-1",
        ...fixture.lease,
        expiresAt: t0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.getRun("run-1")).resolves.toMatchObject({ leaseGeneration: 1 });
  });

  it("rejects nonterminal finishRun states without changing run state", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.database.syncStore.finishRun({
        runId: "run-1",
        ...fixture.lease,
        state: "running" as FinishSyncRunInput["state"],
        completedAt: t1,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(fixture.database.syncStore.getRun("run-1")).resolves.toMatchObject({
      state: "running",
      completedAt: undefined,
    });
  });

  it.each([
    { table: "sync_changes", operation: "insert", condition: "when new.record_id = 'PR_2'" },
    { table: "sync_records", operation: "insert", condition: "when new.record_id = 'PR_2'" },
    { table: "sync_outbox", operation: "insert", condition: "when new.change_sequence = 3" },
    { table: "sync_checkpoints", operation: "update", condition: "" },
    { table: "sync_runs", operation: "update", condition: "" },
  ])(
    "rolls back record, event, outbox, and progress writes on $table failure",
    async ({ table, operation, condition }) => {
      const fixture = await createFixture();
      const store = fixture.database.syncStore;
      await store.commitPage({
        ...commitIdentity(fixture, 0, t1),
        nextCheckpoint: { cursor: "seed" },
        upserts: [{ model: "PullRequest", id: "PR_1", payload: { body: "Original" } }],
      });
      const before = await store.listChanges();
      const injector = new DatabaseSync(fixture.databasePath);
      try {
        injector.exec(`create trigger fail_commit before ${operation} on ${table} ${condition} begin
        select raise(abort, 'injected failure'); end;`);
      } finally {
        injector.close();
      }
      await expect(
        store.commitPage({
          ...commitIdentity(fixture, 1, t2),
          nextCheckpoint: { cursor: "updated" },
          upserts: [
            { model: "PullRequest", id: "PR_1", payload: { body: "Updated" } },
            { model: "PullRequest", id: "PR_2", payload: { body: "Second" } },
          ],
        }),
      ).rejects.toThrow("injected failure");
      fixture.database.close();
      fixture.database = new SqliteRuntimeDatabase(fixture.databasePath);
      const reopened = fixture.database.syncStore;
      await expect(reopened.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
        revision: 1,
        payload: { body: "Original" },
      });
      await expect(reopened.getRecord("github-prs", "PullRequest", "PR_2")).resolves.toBeUndefined();
      await expect(reopened.getCheckpoint("github-prs")).resolves.toMatchObject({
        revision: 1,
        value: { cursor: "seed" },
      });
      await expect(reopened.listChanges()).resolves.toEqual(before);
      await expect(reopened.listOutbox("consumer-http")).resolves.toHaveLength(1);
      await expect(reopened.getRun("run-1")).resolves.toMatchObject({
        checkpointRevision: 1,
        pageCount: 1,
        changeCount: 1,
      });
    },
  );

  it("rolls back snapshot tombstones and completion when checkpoint persistence fails", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: null,
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { body: "Still present" } }],
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
    const injector = new DatabaseSync(fixture.databasePath);
    try {
      injector.exec(`create trigger fail_snapshot before update on sync_checkpoints begin
        select raise(abort, 'checkpoint failed'); end;`);
    } finally {
      injector.close();
    }
    const completion = {
      installationId: "github-prs",
      runId: "run-1",
      snapshotId: "snapshot-1",
      lease: fixture.lease,
      expectedCheckpointRevision: 1,
      nextCheckpoint: { cursor: "complete" },
      committedAt: t3,
    };
    await expect(store.finishSnapshot(completion)).rejects.toThrow("checkpoint failed");
    fixture.database.close();
    fixture.database = new SqliteRuntimeDatabase(fixture.databasePath);
    const reopened = fixture.database.syncStore;
    await expect(reopened.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({
      revision: 1,
      deletedAt: undefined,
    });
    await expect(reopened.listChanges()).resolves.toMatchObject({ items: [{ operation: "added" }] });
    await expect(reopened.listOutbox("consumer-http")).resolves.toHaveLength(1);
    await expect(reopened.getCheckpoint("github-prs")).resolves.toMatchObject({ revision: 1 });
    const repair = new DatabaseSync(fixture.databasePath);
    try {
      expect(repair.prepare("select state from sync_snapshots where id = ?").get("snapshot-1")?.state).toBe("active");
      repair.exec("drop trigger fail_snapshot");
    } finally {
      repair.close();
    }
    await expect(reopened.finishSnapshot(completion)).resolves.toMatchObject({
      checkpoint: { revision: 2 },
      changes: [{ operation: "deleted", recordRevision: 2 }],
    });
  });

  it("retains exact earlier change payloads and fans out only to enabled sinks", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    await store.registerSink({ id: "second", kind: "http", enabled: true, updatedAt: t0 });
    await store.registerSink({ id: "disabled", kind: "http", enabled: false, updatedAt: t0 });
    const first = await store.commitPage({
      ...commitIdentity(fixture, 0, t1),
      nextCheckpoint: null,
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { body: "First revision" } }],
    });
    await store.commitPage({
      ...commitIdentity(fixture, 1, t2),
      nextCheckpoint: null,
      upserts: [{ model: "PullRequest", id: "PR_1", payload: { body: "Second revision" } }],
    });
    expect((await store.listChanges()).items[0]).toEqual(first.changes[0]);
    await expect(store.listOutbox("second")).resolves.toHaveLength(2);
    await expect(store.listOutbox("disabled")).resolves.toEqual([]);
  });

  it("keeps the current binding and record revision across in-place credential replacement", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    const upserts = [{ model: "PullRequest", id: "PR_1", payload: { body: "Same record" } }];
    await store.commitPage({ ...commitIdentity(fixture, 0, t1), nextCheckpoint: null, upserts });
    const connection = await fixture.database.connectionStore.get("github", "default");
    if (connection?.credential.authType !== "api_key") {
      throw new Error("Expected the API-key fixture connection.");
    }
    const updated = await fixture.database.connectionStore.set("github", "default", {
      ...connection.credential,
      apiKey: "replacement-token",
      values: { apiKey: "replacement-token" },
    });
    expect(updated.id).toBe(fixture.connectionId);
    await expect(
      store.commitPage({ ...commitIdentity(fixture, 1, t2), nextCheckpoint: null, upserts }),
    ).resolves.toMatchObject({ changes: [] });
    await expect(store.getRecord("github-prs", "PullRequest", "PR_1")).resolves.toMatchObject({ revision: 1 });
  });

  it.each(["2026-02-30T00:00:00.000Z", "2026-09-02", "2026-09-02T10:00:00", "1", ""])(
    "rejects invalid or ambiguous timestamps: %s",
    async (createdAt) => {
      const fixture = await createFixture({ createInstallation: false });
      await expect(
        fixture.database.syncStore.createInstallation({
          id: "invalid-time",
          definitionId: "github.pull-requests",
          definitionVersion: "1.0.0",
          provider: "github",
          connectionId: fixture.connectionId,
          config: {},
          createdAt,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(fixture.database.syncStore.getInstallation("invalid-time")).resolves.toBeUndefined();
    },
  );

  it("normalizes timezone offsets for durable timestamps", async () => {
    const fixture = await createFixture({ createInstallation: false });
    await expect(
      fixture.database.syncStore.createInstallation({
        id: "offset-time",
        definitionId: "github.pull-requests",
        definitionVersion: "1.0.0",
        provider: "github",
        connectionId: fixture.connectionId,
        config: {},
        createdAt: "2026-09-02T11:00:00+01:00",
      }),
    ).resolves.toMatchObject({ createdAt: t0 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid change-page limits: %s",
    async (limit) => {
      const fixture = await createFixture();
      await expect(fixture.database.syncStore.listChanges({ limit })).rejects.toMatchObject({ code: "invalid_input" });
    },
  );

  it("requires explicit snapshot participation so an unchanged record cannot be marked unseen", async () => {
    const fixture = await createFixture();
    const store = fixture.database.syncStore;
    const upserts = [{ model: "PullRequest", id: "PR_1", payload: { body: "Unchanged" } }];
    await store.commitPage({ ...commitIdentity(fixture, 0, t1), nextCheckpoint: null, upserts });
    await store.startSnapshot({
      id: "snapshot-1",
      installationId: "github-prs",
      runId: "run-1",
      models: ["PullRequest"],
      lease: fixture.lease,
      expectedCheckpointRevision: 1,
      startedAt: t2,
    });
    await expect(
      store.commitPage({ ...commitIdentity(fixture, 1, t3), nextCheckpoint: null, upserts }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.getCheckpoint("github-prs")).resolves.toMatchObject({ revision: 1 });
    await store.commitPage({
      ...commitIdentity(fixture, 1, t3),
      snapshotId: "snapshot-1",
      nextCheckpoint: null,
      upserts,
    });
    await expect(
      store.finishSnapshot({
        installationId: "github-prs",
        runId: "run-1",
        snapshotId: "snapshot-1",
        lease: fixture.lease,
        expectedCheckpointRevision: 2,
        nextCheckpoint: null,
        committedAt: t4,
      }),
    ).resolves.toMatchObject({ changes: [], deleteCount: 0 });
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
    lease: { owner: "worker-1", generation: 1 },
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

function commitIdentity(fixture: Fixture, revision: number, committedAt: string) {
  return {
    installationId: "github-prs",
    runId: "run-1",
    lease: fixture.lease,
    expectedCheckpointRevision: revision,
    committedAt,
  };
}
