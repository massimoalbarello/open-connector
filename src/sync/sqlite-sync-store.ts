import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RuntimeRow } from "../server/storage/runtime-sql.ts";
import type { SyncDefinitionContract } from "./record-contract.ts";
import type {
  CommitSyncPageInput,
  FinishSyncRunInput,
  FinishSyncSnapshotInput,
  ISyncStore,
  JsonObject,
  JsonValue,
  ListSyncChangesInput,
  RenewSyncRunLeaseInput,
  StartSyncRunInput,
  StartSyncSnapshotInput,
  SyncChange,
  SyncChangeOperation,
  SyncChangePage,
  SyncCheckpoint,
  SyncCommitResult,
  SyncInstallation,
  SyncInstallationState,
  SyncLeaseInput,
  SyncOutboxRecord,
  SyncRecord,
  SyncRun,
  SyncRunReason,
  SyncRunState,
  SyncSnapshot,
} from "./sync-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";
import { optionalRawString } from "../core/cast.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { PlainTextSecretCodec } from "../server/secrets/secret-codec-core.ts";
import { parseJson, readString } from "../server/storage/runtime-sql.ts";
import { maximumRecordBytes } from "./delivery-store.ts";
import { normalizeSyncRecord } from "./record-contract.ts";
import { canonicalizeJsonValue } from "./record-hash.ts";
import { SqliteSyncDeliveryStore } from "./sqlite-delivery-store.ts";
import { SqliteSyncScheduleStore } from "./sqlite-schedule-store.ts";
import { SqliteSyncSourceStore } from "./sqlite-source-store.ts";
import { SqliteSyncStatusStore } from "./sqlite-status-store.ts";
import { runSyncTransaction } from "./sqlite-sync-transaction.ts";
import { SyncStoreError } from "./sync-store.ts";

const defaultChangeLimit = 100;
const maximumChangeLimit = 1_000;
const maximumIdentifierLength = 1_024;
const modelPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const timestampSchema = z.iso.datetime({ offset: true });

interface PreparedUpsert {
  model: string;
  id: string;
  payload: JsonObject;
  payloadJson: string;
  payloadHash: string;
}

interface PreparedDelete {
  model: string;
  id: string;
}

interface PreparedCommit {
  installationId: string;
  runId: string;
  lease: SyncLeaseInput;
  expectedCheckpointRevision: number;
  checkpoint: JsonValue;
  checkpointJson: string | null;
  upserts: PreparedUpsert[];
  deletes: PreparedDelete[];
  snapshotId?: string;
  committedAt: string;
}

interface ChangeSource {
  installation: SyncInstallation;
  run: SyncRun;
  committedAt: string;
}

interface InsertChangeInput extends ChangeSource {
  model: string;
  recordId: string;
  operation: SyncChangeOperation;
  recordRevision: number;
  payload?: JsonObject;
  payloadJson: string;
  payloadHash: string;
  deletedAt?: string;
}

interface WriteCheckpointInput {
  installation: SyncInstallation;
  run: SyncRun;
  expectedRevision: number;
  value: JsonValue;
  valueJson: string | null;
  committedAt: string;
}

/** SQLite implementation of the durable sync state and record cache. */
export class SqliteSyncStore implements ISyncStore {
  private readonly database: DatabaseSync;

  readonly sources: SqliteSyncSourceStore;
  readonly delivery: SqliteSyncDeliveryStore;
  readonly schedule: SqliteSyncScheduleStore;
  readonly status: SqliteSyncStatusStore;
  private readonly definitions: readonly SyncDefinitionContract[];

  constructor(
    database: DatabaseSync,
    definitions: readonly SyncDefinitionContract[] = [],
    codec: ISecretCodec = new PlainTextSecretCodec(),
  ) {
    this.delivery = new SqliteSyncDeliveryStore(database, codec);
    this.database = database;
    this.schedule = new SqliteSyncScheduleStore(database, {
      installation: (id) => this.readInstallation(id),
    });
    this.status = new SqliteSyncStatusStore(database, {
      installation: (id) => this.readInstallation(id),
      run: (id) => this.readRun(id),
      runDelivery: (id) => this.delivery.runStatus(id),
    });
    this.definitions = structuredClone(definitions);
    const ids = new Set<string>();
    for (const definition of this.definitions) {
      requiredIdentifier(definition.id, "definition id");
      requiredIdentifier(definition.version, "definition version");
      requiredIdentifier(definition.provider, "provider");
      if (ids.has(definition.id) || !definition.kinds.length)
        throw invalidInput("Definitions must have unique IDs and declare kinds.");
      ids.add(definition.id);
      normalizeModels(definition.kinds.map((kind) => kind.kind));
    }
    this.sources = new SqliteSyncSourceStore(database, this.definitions);
  }

  async getInstallation(id: string): Promise<SyncInstallation | undefined> {
    return this.readInstallation(requiredIdentifier(id, "installation id"));
  }

  async startRun(input: StartSyncRunInput): Promise<SyncRun> {
    const id = requiredIdentifier(input.id, "run id");
    const installationId = requiredIdentifier(input.installationId, "installation id");
    const definitionVersion = requiredIdentifier(input.definitionVersion, "definition version");
    const reason = input.reason;
    assertRunReason(reason);
    const leaseOwner = requiredIdentifier(input.leaseOwner, "lease owner");
    const leaseExpiresAt = requiredTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
    const startedAt = requiredTimestamp(input.startedAt, "startedAt");
    if (leaseExpiresAt <= startedAt) {
      throw invalidInput("leaseExpiresAt must be later than startedAt.");
    }
    if (Date.parse(leaseExpiresAt) <= Date.now()) throw invalidInput("leaseExpiresAt must be in the future.");

    runSyncTransaction(this.database, () => {
      this.delivery.requireDestination();
      if (this.database.prepare("select 1 from sync_runs where state = 'running'").get())
        throw new SyncStoreError("run_busy", "Another acquisition is already running.");
      const installation = this.requireInstallation(installationId);
      if (installation.removedAt) throw invalidInput("Restore this sync before starting another iteration.");
      if (installation.requiresBackfill && input.resetCheckpoint === undefined)
        throw invalidInput("Interrupted snapshot requires an explicit backfill run.");
      if (installation.requiresBackfill && input.resetCheckpoint !== undefined) {
        this.database
          .prepare(
            "update sync_installations set requires_backfill = 0, state = 'enabled', last_error = null where id = ?",
          )
          .run(installationId);
        installation.state = "enabled";
      }
      this.assertSourceBinding(installation);
      if (installation.state !== "enabled") {
        throw invalidInput("A run cannot start for an installation that is not enabled.");
      }
      if (installation.definitionVersion !== definitionVersion) {
        throw invalidInput(
          `Run definition version ${definitionVersion} does not match installation version ${installation.definitionVersion}.`,
        );
      }
      const checkpointRevision = this.readCheckpoint(installationId)?.revision ?? 0;
      this.database
        .prepare(
          `
          insert into sync_runs (
            id, installation_id, definition_version, reason, state, lease_owner,
            lease_generation, lease_expires_at, checkpoint_revision, started_at, binding_revision
          ) values (?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          installationId,
          definitionVersion,
          reason,
          leaseOwner,
          leaseExpiresAt,
          checkpointRevision,
          startedAt,
          installation.bindingRevision,
        );
      if (input.resetCheckpoint !== undefined) {
        const reset = canonicalizeJsonValue(input.resetCheckpoint);
        const resetResult = this.writeCheckpoint({
          installation,
          run: this.requireRun(id),
          expectedRevision: checkpointRevision,
          value: reset.value,
          valueJson: reset.value === null ? null : reset.json,
          committedAt: startedAt,
        });
        this.database
          .prepare("update sync_runs set checkpoint_revision = ? where id = ?")
          .run(resetResult.revision, id);
      }
    });
    return this.requireRun(id);
  }

  async getRun(id: string): Promise<SyncRun | undefined> {
    return this.readRun(requiredIdentifier(id, "run id"));
  }

  async renewRunLease(input: RenewSyncRunLeaseInput): Promise<SyncRun> {
    const runId = requiredIdentifier(input.runId, "run id");
    const lease = normalizeLease(input);
    const expiresAt = requiredTimestamp(input.expiresAt, "expiresAt");
    runSyncTransaction(this.database, () => {
      this.delivery.requireDestination();
      this.assertLease(runId, lease);
      if (Date.parse(expiresAt) <= Date.now()) {
        throw invalidInput("expiresAt must be in the future.");
      }
      const result = this.database
        .prepare(
          `
          update sync_runs
          set lease_generation = lease_generation + 1, lease_expires_at = ?
          where id = ? and state = 'running' and lease_owner = ? and lease_generation = ?
        `,
        )
        .run(expiresAt, runId, lease.owner, lease.generation);
      if (result.changes !== 1) {
        throw leaseLost(runId);
      }
    });
    return this.requireRun(runId);
  }

  async finishRun(input: FinishSyncRunInput): Promise<SyncRun> {
    const runId = requiredIdentifier(input.runId, "run id");
    const lease = normalizeLease(input);
    const completedAt = requiredTimestamp(input.completedAt, "completedAt");
    const state = input.state;
    if (state !== "succeeded" && state !== "failed" && state !== "cancelled" && state !== "lease_expired") {
      throw invalidInput("A finished run must have a terminal state.");
    }

    runSyncTransaction(this.database, () => {
      const run = this.assertLease(runId, lease);
      const activeSnapshot = this.database
        .prepare("select id from sync_snapshots where run_id = ? and state = 'active'")
        .get(runId);
      if (activeSnapshot && state === "succeeded") {
        throw invalidInput("A run cannot succeed while it has an active snapshot.");
      }
      if (activeSnapshot) {
        this.database
          .prepare(
            "update sync_installations set requires_backfill = 1, state = 'needs_attention', last_error = 'snapshot_interrupted' where id = ?",
          )
          .run(run.installationId);
        this.database
          .prepare(
            "update sync_snapshots set state = 'abandoned', completed_at = ? where run_id = ? and state = 'active'",
          )
          .run(completedAt, runId);
      }

      this.database
        .prepare(
          `
          update sync_runs
          set state = ?, completed_at = ?, error_code = ?, error_message = ?
          where id = ?
        `,
        )
        .run(state, completedAt, input.errorCode ?? null, input.errorMessage ?? null, runId);
      if (state === "succeeded") {
        this.database
          .prepare("update sync_installations set last_success_at = ?, updated_at = ? where id = ?")
          .run(completedAt, completedAt, run.installationId);
      }
    });
    return this.requireRun(runId);
  }

  async getCheckpoint(installationId: string): Promise<SyncCheckpoint | undefined> {
    return this.readCheckpoint(requiredIdentifier(installationId, "installation id"));
  }

  async commitPage(input: CommitSyncPageInput): Promise<SyncCommitResult> {
    const installation = this.requireInstallation(input.installationId);
    const prepared = prepareCommit(input, this.requireDefinition(installation));
    return runSyncTransaction(this.database, () => {
      this.delivery.requireDestination();
      const result = this.commitPreparedPage(prepared);
      this.delivery.purge();
      return result;
    });
  }

  async startSnapshot(input: StartSyncSnapshotInput): Promise<SyncSnapshot> {
    const id = requiredIdentifier(input.id, "snapshot id");
    const installationId = requiredIdentifier(input.installationId, "installation id");
    const runId = requiredIdentifier(input.runId, "run id");
    const lease = normalizeLease(input.lease);
    const expectedCheckpointRevision = readRevision(input.expectedCheckpointRevision);
    const startedAt = requiredTimestamp(input.startedAt, "startedAt");
    const models = normalizeModels(input.kinds);

    runSyncTransaction(this.database, () => {
      this.delivery.requireDestination();
      const run = this.assertLease(runId, lease, installationId);
      this.assertDefinitionVersion(installationId, run);
      this.assertCheckpointRevision(installationId, expectedCheckpointRevision);
      const definition = this.requireDefinition(this.requireInstallation(installationId));
      if (models.some((model) => !definition.kinds.some((kind) => kind.kind === model)))
        throw invalidInput("Snapshot contains an undeclared kind.");
      const baseline = this.database.prepare("select max(sequence) as value from sync_changes").get();
      this.database
        .prepare(
          `
          insert into sync_snapshots (
            id, installation_id, run_id, models_value, baseline_sequence, state, started_at
          ) values (?, ?, ?, ?, ?, 'active', ?)
        `,
        )
        .run(id, installationId, runId, JSON.stringify(models), readOptionalNumber(baseline, "value") ?? 0, startedAt);
    });
    return this.requireSnapshot(id);
  }

  async finishSnapshot(input: FinishSyncSnapshotInput): Promise<SyncCommitResult> {
    const installationId = requiredIdentifier(input.installationId, "installation id");
    const runId = requiredIdentifier(input.runId, "run id");
    const snapshotId = requiredIdentifier(input.snapshotId, "snapshot id");
    const lease = normalizeLease(input.lease);
    const expectedCheckpointRevision = readRevision(input.expectedCheckpointRevision);
    const committedAt = requiredTimestamp(input.committedAt, "committedAt");
    const checkpoint = readCanonicalValue(input.nextCheckpoint, "Sync checkpoint");

    return runSyncTransaction(this.database, () => {
      this.delivery.requireDestination();
      const installation = this.requireInstallation(installationId);
      const run = this.assertLease(runId, lease, installationId);
      this.assertDefinitionVersion(installationId, run);
      this.assertCheckpointRevision(installationId, expectedCheckpointRevision);
      const snapshot = this.requireActiveSnapshot(snapshotId, installationId, runId);
      const source: ChangeSource = { installation, run, committedAt };
      const candidates = this.readSnapshotDeleteCandidates(snapshot);
      const changes: SyncChange[] = [];

      for (const record of candidates) {
        const change = this.insertChange({
          ...source,
          model: record.kind,
          recordId: record.id,
          operation: "deleted",
          recordRevision: record.revision + 1,
          payload: record.content,
          payloadJson: JSON.stringify(record.content ?? null),
          payloadHash: record.contentHash,
          deletedAt: committedAt,
        });
        this.database
          .prepare(
            `
            update sync_records
            set revision = ?, last_change_sequence = ?, last_changed_at = ?, deleted_at = ?
            where installation_id = ? and model = ? and record_id = ?
          `,
          )
          .run(
            change.recordRevision,
            change.sequence,
            committedAt,
            committedAt,
            installationId,
            record.kind,
            record.id,
          );
        changes.push(change);
      }

      this.database
        .prepare("update sync_snapshots set state = 'completed', completed_at = ? where id = ?")
        .run(committedAt, snapshotId);
      const nextCheckpoint = this.writeCheckpoint({
        installation,
        run,
        expectedRevision: expectedCheckpointRevision,
        value: checkpoint.value,
        valueJson: checkpoint.value === null ? null : checkpoint.json,
        committedAt,
      });
      this.updateRunProgress(runId, nextCheckpoint.revision, 1, 0, candidates.length, changes.length);
      this.delivery.purge();
      return {
        checkpoint: nextCheckpoint,
        changes,
        upsertCount: 0,
        deleteCount: candidates.length,
      };
    });
  }

  async getRecord(installationId: string, model: string, recordId: string): Promise<SyncRecord | undefined> {
    const row = this.database
      .prepare(
        `
        select (select source_id from sync_installations where id = installation_id) as source_id,
          (select provider from sync_installations where id = installation_id) as provider,
          installation_id, model, record_id, payload, payload_hash, revision,
          created_sequence, last_change_sequence, first_seen_at, last_changed_at,
          deleted_at, last_seen_snapshot_id
        from sync_records
        where installation_id = ? and model = ? and record_id = ?
      `,
      )
      .get(requiredIdentifier(installationId, "installation id"), requiredModel(model), requiredRecordId(recordId));
    return row ? readRecordRow(row) : undefined;
  }

  async listChanges(input: ListSyncChangesInput = {}): Promise<SyncChangePage> {
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
      throw invalidInput("limit must be a positive safe integer.");
    }
    const limit = Math.min(input.limit ?? defaultChangeLimit, maximumChangeLimit);
    const conditions: string[] = [];
    const values: Array<number | string> = [];
    if (input.afterSequence !== undefined) {
      if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
        throw invalidInput("afterSequence must be a non-negative safe integer.");
      }
      conditions.push("sequence > ?");
      values.push(input.afterSequence);
    }
    if (input.installationId !== undefined) {
      conditions.push("installation_id = ?");
      values.push(requiredIdentifier(input.installationId, "installation id"));
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.database
      .prepare(
        `
        select (select source_id from sync_installations where id = installation_id) as source_id,
          sequence, event_id, installation_id, provider, connection_id, definition_id,
          definition_version, model, record_id, operation, record_revision, payload,
          payload_hash, deleted_at, run_id, committed_at
        from sync_changes
        ${where}
        order by sequence
        limit ?
      `,
      )
      .all(...values, limit)
      .map(readChangeRow);
    return {
      items: rows,
      nextSequence: rows.at(-1)?.sequence,
    };
  }

  async listOutbox(): Promise<SyncOutboxRecord[]> {
    return this.database
      .prepare(
        `
        select change_sequence, state, attempt_count, next_attempt_at,
          lease_owner, lease_generation, lease_expires_at, delivered_at, last_error
        from sync_outbox
        order by change_sequence
      `,
      )
      .all()
      .map(readOutboxRow);
  }

  private commitPreparedPage(input: PreparedCommit): SyncCommitResult {
    const installation = this.requireInstallation(input.installationId);
    const run = this.assertLease(input.runId, input.lease, input.installationId);
    this.assertDefinitionVersion(input.installationId, run);
    this.assertCheckpointRevision(input.installationId, input.expectedCheckpointRevision);
    const snapshot = input.snapshotId
      ? this.requireActiveSnapshot(input.snapshotId, input.installationId, input.runId)
      : undefined;
    if (
      !snapshot &&
      this.database.prepare("select id from sync_snapshots where run_id = ? and state = 'active'").get(input.runId)
    ) {
      throw invalidInput("Page commits during an active snapshot must include its snapshotId.");
    }
    if (snapshot) {
      const models = new Set(snapshot.kinds);
      for (const record of [...input.upserts, ...input.deletes]) {
        if (!models.has(record.model)) {
          throw invalidInput(`Kind ${record.model} is not part of snapshot ${snapshot.id}.`);
        }
      }
    }

    const source: ChangeSource = { installation, run, committedAt: input.committedAt };
    const changes: SyncChange[] = [];
    for (const upsert of input.upserts) {
      const current = this.readRecord(input.installationId, upsert.model, upsert.id);
      if (!current) {
        const change = this.insertChange({
          ...source,
          model: upsert.model,
          recordId: upsert.id,
          operation: "added",
          recordRevision: 1,
          payload: upsert.payload,
          payloadJson: upsert.payloadJson,
          payloadHash: upsert.payloadHash,
        });
        this.database
          .prepare(
            `
            insert into sync_records (
              installation_id, model, record_id, payload, payload_hash, revision,
              created_sequence, last_change_sequence, first_seen_at, last_changed_at,
              deleted_at, last_seen_snapshot_id
            ) values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, null, ?)
          `,
          )
          .run(
            input.installationId,
            upsert.model,
            upsert.id,
            upsert.payloadJson,
            upsert.payloadHash,
            change.sequence,
            change.sequence,
            input.committedAt,
            input.committedAt,
            snapshot?.id ?? null,
          );
        changes.push(change);
        continue;
      }

      if (current.deletedAt || current.contentHash !== upsert.payloadHash) {
        const change = this.insertChange({
          ...source,
          model: upsert.model,
          recordId: upsert.id,
          operation: current.deletedAt ? "added" : "updated",
          recordRevision: current.revision + 1,
          payload: upsert.payload,
          payloadJson: upsert.payloadJson,
          payloadHash: upsert.payloadHash,
        });
        this.database
          .prepare(
            `
            update sync_records
            set payload = ?, payload_hash = ?, revision = ?, last_change_sequence = ?,
              last_changed_at = ?, deleted_at = null, last_seen_snapshot_id = ?
            where installation_id = ? and model = ? and record_id = ?
          `,
          )
          .run(
            upsert.payloadJson,
            upsert.payloadHash,
            change.recordRevision,
            change.sequence,
            input.committedAt,
            snapshot?.id ?? current.lastSeenSnapshotId ?? null,
            input.installationId,
            upsert.model,
            upsert.id,
          );
        changes.push(change);
      } else if (snapshot) {
        this.database
          .prepare(
            `
            update sync_records set last_seen_snapshot_id = ?
            where installation_id = ? and model = ? and record_id = ?
          `,
          )
          .run(snapshot.id, input.installationId, upsert.model, upsert.id);
      }
    }

    for (const deletion of input.deletes) {
      const current = this.readRecord(input.installationId, deletion.model, deletion.id);
      if (!current || current.deletedAt) {
        continue;
      }
      const change = this.insertChange({
        ...source,
        model: current.kind,
        recordId: current.id,
        operation: "deleted",
        recordRevision: current.revision + 1,
        payload: current.content,
        payloadJson: JSON.stringify(current.content ?? null),
        payloadHash: current.contentHash,
        deletedAt: input.committedAt,
      });
      this.database
        .prepare(
          `
          update sync_records
          set revision = ?, last_change_sequence = ?, last_changed_at = ?, deleted_at = ?
          where installation_id = ? and model = ? and record_id = ?
        `,
        )
        .run(
          change.recordRevision,
          change.sequence,
          input.committedAt,
          input.committedAt,
          input.installationId,
          current.kind,
          current.id,
        );
      changes.push(change);
    }

    const checkpoint = this.writeCheckpoint({
      installation,
      run,
      expectedRevision: input.expectedCheckpointRevision,
      value: input.checkpoint,
      valueJson: input.checkpointJson,
      committedAt: input.committedAt,
    });
    this.updateRunProgress(run.id, checkpoint.revision, 1, input.upserts.length, input.deletes.length, changes.length);
    return {
      checkpoint,
      changes,
      upsertCount: input.upserts.length,
      deleteCount: input.deletes.length,
    };
  }

  private insertChange(input: InsertChangeInput): SyncChange {
    const eventId = randomUUIDv7(Date.parse(input.committedAt));
    const result = this.database
      .prepare(
        `
        insert into sync_changes (
          event_id, installation_id, provider, connection_id, definition_id,
          definition_version, model, record_id, operation, record_revision,
          payload, payload_hash, deleted_at, run_id, committed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        eventId,
        input.installation.id,
        input.installation.provider,
        input.installation.connectionId,
        input.installation.definitionId,
        input.run.definitionVersion,
        input.model,
        input.recordId,
        input.operation,
        input.recordRevision,
        input.payloadJson,
        input.payloadHash,
        input.deletedAt ?? null,
        input.run.id,
        input.committedAt,
      );
    const sequence = toSafeInteger(result.lastInsertRowid, "change sequence");
    this.database
      .prepare(
        `
        insert into sync_outbox (
          change_sequence, state, attempt_count, next_attempt_at, lease_generation
        )
        values (?, 'pending', 0, ?, 0)
      `,
      )
      .run(sequence, input.committedAt);
    return {
      sourceId: input.installation.sourceId,
      sequence,
      eventId,
      installationId: input.installation.id,
      provider: input.installation.provider,
      connectionId: input.installation.connectionId,
      definitionId: input.installation.definitionId,
      definitionVersion: input.run.definitionVersion,
      kind: input.model,
      recordId: input.recordId,
      operation: input.operation,
      recordRevision: input.recordRevision,
      content: input.payload,
      contentHash: input.payloadHash,
      deletedAt: input.deletedAt,
      runId: input.run.id,
      committedAt: input.committedAt,
    };
  }

  private writeCheckpoint(input: WriteCheckpointInput): SyncCheckpoint {
    const nextRevision = input.expectedRevision + 1;
    const result =
      input.expectedRevision === 0
        ? this.database
            .prepare(
              `
              insert into sync_checkpoints (
                installation_id, definition_version, revision, value, run_id, updated_at
              ) values (?, ?, ?, ?, ?, ?)
              on conflict(installation_id) do nothing
            `,
            )
            .run(
              input.installation.id,
              input.run.definitionVersion,
              nextRevision,
              input.valueJson,
              input.run.id,
              input.committedAt,
            )
        : this.database
            .prepare(
              `
              update sync_checkpoints
              set definition_version = ?, revision = ?, value = ?, run_id = ?, updated_at = ?
              where installation_id = ? and revision = ?
            `,
            )
            .run(
              input.run.definitionVersion,
              nextRevision,
              input.valueJson,
              input.run.id,
              input.committedAt,
              input.installation.id,
              input.expectedRevision,
            );
    if (result.changes !== 1) {
      throw checkpointConflict(input.installation.id, input.expectedRevision);
    }
    return {
      installationId: input.installation.id,
      definitionVersion: input.run.definitionVersion,
      revision: nextRevision,
      value: input.value,
      runId: input.run.id,
      updatedAt: input.committedAt,
    };
  }

  private updateRunProgress(
    runId: string,
    checkpointRevision: number,
    pageCount: number,
    upsertCount: number,
    deleteCount: number,
    changeCount: number,
  ): void {
    this.database
      .prepare(
        `
        update sync_runs
        set checkpoint_revision = ?, page_count = page_count + ?,
          upsert_count = upsert_count + ?, delete_count = delete_count + ?,
          change_count = change_count + ?
        where id = ?
      `,
      )
      .run(checkpointRevision, pageCount, upsertCount, deleteCount, changeCount, runId);
  }

  private assertLease(runId: string, lease: SyncLeaseInput, installationId?: string): SyncRun {
    const run = this.readRun(runId);
    if (!run) {
      throw new SyncStoreError("run_not_found", `Sync run not found: ${runId}.`);
    }
    if (
      run.state !== "running" ||
      run.leaseOwner !== lease.owner ||
      run.leaseGeneration !== lease.generation ||
      Date.parse(run.leaseExpiresAt) <= Date.now() ||
      (installationId !== undefined && run.installationId !== installationId)
    ) {
      throw leaseLost(runId);
    }
    const installation = this.requireInstallation(run.installationId);
    this.assertSourceBinding(installation);
    const binding = this.database.prepare("select binding_revision from sync_runs where id = ?").get(runId);
    if (binding?.binding_revision !== installation.bindingRevision) throw leaseLost(runId);
    return run;
  }

  private assertSourceBinding(installation: SyncInstallation): void {
    const definition = this.requireDefinition(installation);
    for (const kind of definition.kinds) {
      const owner = this.database
        .prepare("select installation_id from sync_source_kinds where source_id = ? and kind = ?")
        .get(installation.sourceId, kind.kind);
      if (owner?.installation_id !== installation.id)
        throw new SyncStoreError(
          "binding_conflict",
          "Definition kinds changed; reverify source ownership before running.",
        );
    }
    if (
      !this.database
        .prepare("select id from connections where id = ? and revision = ? and service = ?")
        .get(installation.connectionId, installation.credentialRevision, installation.provider)
    )
      throw new SyncStoreError("credential_changed", "Verify and rebind the changed source credential before running.");
  }

  private requireDefinition(installation: SyncInstallation): SyncDefinitionContract {
    const definition = this.definitions.find((item) => item.id === installation.definitionId);
    if (
      !definition ||
      definition.provider !== installation.provider ||
      definition.version !== installation.definitionVersion
    )
      throw invalidInput("Installation does not match a registered definition and version.");
    return definition;
  }

  private assertDefinitionVersion(installationId: string, run: SyncRun): void {
    const installation = this.requireInstallation(installationId);
    if (installation.definitionVersion !== run.definitionVersion) {
      throw leaseLost(run.id);
    }
  }

  private assertCheckpointRevision(installationId: string, expectedRevision: number): void {
    const actual = this.readCheckpoint(installationId)?.revision ?? 0;
    if (actual !== expectedRevision) {
      throw checkpointConflict(installationId, expectedRevision, actual);
    }
  }

  private readSnapshotDeleteCandidates(snapshot: SyncSnapshot): SyncRecord[] {
    const placeholders = snapshot.kinds.map(() => "?").join(", ");
    return this.database
      .prepare(
        `
        select (select source_id from sync_installations where id = installation_id) as source_id,
          (select provider from sync_installations where id = installation_id) as provider,
          installation_id, model, record_id, payload, payload_hash, revision,
          created_sequence, last_change_sequence, first_seen_at, last_changed_at,
          deleted_at, last_seen_snapshot_id
        from sync_records
        where installation_id = ? and model in (${placeholders}) and deleted_at is null
          and last_seen_snapshot_id is not ? and last_change_sequence <= ?
        order by model, record_id
      `,
      )
      .all(snapshot.installationId, ...snapshot.kinds, snapshot.id, snapshot.baselineSequence)
      .map(readRecordRow);
  }

  private requireActiveSnapshot(id: string, installationId: string, runId: string): SyncSnapshot {
    const snapshot = this.readSnapshot(id);
    if (!snapshot) {
      throw new SyncStoreError("snapshot_not_found", `Sync snapshot not found: ${id}.`);
    }
    if (snapshot.state !== "active" || snapshot.installationId !== installationId || snapshot.runId !== runId) {
      throw new SyncStoreError("snapshot_inactive", `Sync snapshot is not active for this run: ${id}.`);
    }
    return snapshot;
  }

  private requireSnapshot(id: string): SyncSnapshot {
    const snapshot = this.readSnapshot(id);
    if (!snapshot) {
      throw new SyncStoreError("snapshot_not_found", `Sync snapshot not found: ${id}.`);
    }
    return snapshot;
  }

  private readSnapshot(id: string): SyncSnapshot | undefined {
    const row = this.database
      .prepare(
        `
        select id, installation_id, run_id, models_value, baseline_sequence,
          state, started_at, completed_at
        from sync_snapshots where id = ?
      `,
      )
      .get(id);
    return row ? readSnapshotRow(row) : undefined;
  }

  private requireInstallation(id: string): SyncInstallation {
    const installation = this.readInstallation(id);
    if (!installation) {
      throw new SyncStoreError("installation_not_found", `Sync installation not found: ${id}.`);
    }
    return installation;
  }

  private readInstallation(id: string): SyncInstallation | undefined {
    const row = this.database
      .prepare(
        `
        select source_id, credential_revision, binding_revision, id, definition_id, definition_version, provider, connection_id, config_value,
          state, schedule_seconds, next_due_at, last_success_at, created_at, updated_at, consecutive_failures, last_error, requires_backfill, removed_at
        from sync_installations where id = ?
      `,
      )
      .get(id);
    return row ? readInstallationRow(row) : undefined;
  }

  private requireRun(id: string): SyncRun {
    const run = this.readRun(id);
    if (!run) {
      throw new SyncStoreError("run_not_found", `Sync run not found: ${id}.`);
    }
    return run;
  }

  private readRun(id: string): SyncRun | undefined {
    const row = this.database
      .prepare(
        `
        select id, installation_id, definition_version, reason, state, lease_owner,
          lease_generation, lease_expires_at, checkpoint_revision, page_count,
          upsert_count, delete_count, change_count, error_code, error_message,
          started_at, completed_at
        from sync_runs where id = ?
      `,
      )
      .get(id);
    return row ? readRunRow(row) : undefined;
  }

  private readCheckpoint(installationId: string): SyncCheckpoint | undefined {
    const row = this.database
      .prepare(
        `
        select installation_id, definition_version, revision, value, run_id, updated_at
        from sync_checkpoints where installation_id = ?
      `,
      )
      .get(installationId);
    return row ? readCheckpointRow(row) : undefined;
  }

  private readRecord(installationId: string, model: string, id: string): SyncRecord | undefined {
    const row = this.database
      .prepare(
        `
        select (select source_id from sync_installations where id = installation_id) as source_id,
          (select provider from sync_installations where id = installation_id) as provider,
          installation_id, model, record_id, payload, payload_hash, revision,
          created_sequence, last_change_sequence, first_seen_at, last_changed_at,
          deleted_at, last_seen_snapshot_id
        from sync_records
        where installation_id = ? and model = ? and record_id = ?
      `,
      )
      .get(installationId, model, id);
    return row ? readRecordRow(row) : undefined;
  }
}

function prepareCommit(input: CommitSyncPageInput, definition: SyncDefinitionContract): PreparedCommit {
  const installationId = requiredIdentifier(input.installationId, "installation id");
  const runId = requiredIdentifier(input.runId, "run id");
  const lease = normalizeLease(input.lease);
  const expectedCheckpointRevision = readRevision(input.expectedCheckpointRevision);
  const checkpoint = readCanonicalValue(input.nextCheckpoint, "Sync checkpoint");
  const committedAt = requiredTimestamp(input.committedAt, "committedAt");
  const snapshotId = input.snapshotId === undefined ? undefined : requiredIdentifier(input.snapshotId, "snapshot id");
  const keys = new Set<string>();
  const upserts = (input.upserts ?? []).map((record) => {
    const model = requiredModel(record.kind);
    const kind = definition.kinds.find((item) => item.kind === model);
    if (!kind) throw invalidInput(`Undeclared kind: ${model}.`);
    const normalized = normalizeSyncRecord(record.record, kind);
    const id = normalized.id;
    assertUniqueRecord(keys, model, id);
    const payload = normalized.content;
    if (Buffer.byteLength(payload.json) > maximumRecordBytes)
      throw invalidInput("Record exceeds the 8 MiB delivery limit.");
    return {
      model,
      id,
      payload: payload.value,
      payloadJson: payload.json,
      payloadHash: payload.sha256,
    };
  });
  const deletes = (input.deletes ?? []).map((record) => {
    const model = requiredModel(record.kind);
    if (!definition.kinds.some((item) => item.kind === model)) throw invalidInput(`Undeclared kind: ${model}.`);
    const id = requiredRecordId(record.id);
    assertUniqueRecord(keys, model, id);
    return { model, id };
  });
  return {
    installationId,
    runId,
    lease,
    expectedCheckpointRevision,
    checkpoint: checkpoint.value,
    checkpointJson: checkpoint.value === null ? null : checkpoint.json,
    upserts,
    deletes,
    snapshotId,
    committedAt,
  };
}

function readInstallationRow(row: RuntimeRow): SyncInstallation {
  const state = readString(row, "state");
  assertInstallationState(state);
  return {
    removedAt: readOptionalString(row, "removed_at"),
    sourceId: readString(row, "source_id"),
    credentialRevision: readString(row, "credential_revision"),
    bindingRevision: readNumber(row, "binding_revision"),
    id: readString(row, "id"),
    definitionId: readString(row, "definition_id"),
    definitionVersion: readString(row, "definition_version"),
    provider: readString(row, "provider"),
    connectionId: readString(row, "connection_id"),
    config: parseJson<JsonObject>(readString(row, "config_value")),
    state,
    consecutiveFailures: readNumber(row, "consecutive_failures"),
    lastError: readOptionalString(row, "last_error"),
    requiresBackfill: row.requires_backfill === 1,
    scheduleSeconds: readOptionalNumber(row, "schedule_seconds"),
    nextDueAt: readOptionalString(row, "next_due_at"),
    lastSuccessAt: readOptionalString(row, "last_success_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readRunRow(row: RuntimeRow): SyncRun {
  const reason = readString(row, "reason");
  const state = readString(row, "state");
  assertRunReason(reason);
  assertRunState(state);
  return {
    id: readString(row, "id"),
    installationId: readString(row, "installation_id"),
    definitionVersion: readString(row, "definition_version"),
    reason,
    state,
    leaseOwner: readString(row, "lease_owner"),
    leaseGeneration: readNumber(row, "lease_generation"),
    leaseExpiresAt: readString(row, "lease_expires_at"),
    checkpointRevision: readNumber(row, "checkpoint_revision"),
    pageCount: readNumber(row, "page_count"),
    upsertCount: readNumber(row, "upsert_count"),
    deleteCount: readNumber(row, "delete_count"),
    changeCount: readNumber(row, "change_count"),
    errorCode: readOptionalString(row, "error_code"),
    errorMessage: readOptionalString(row, "error_message"),
    startedAt: readString(row, "started_at"),
    completedAt: readOptionalString(row, "completed_at"),
  };
}

function readCheckpointRow(row: RuntimeRow): SyncCheckpoint {
  const value = readOptionalString(row, "value");
  return {
    installationId: readString(row, "installation_id"),
    definitionVersion: readString(row, "definition_version"),
    revision: readNumber(row, "revision"),
    value: value === undefined ? null : parseJson<JsonValue>(value),
    runId: readString(row, "run_id"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readRecordRow(row: RuntimeRow): SyncRecord {
  return {
    sourceId: readString(row, "source_id"),
    provider: readString(row, "provider"),
    installationId: readString(row, "installation_id"),
    kind: readString(row, "model"),
    id: readString(row, "record_id"),
    content: parseJson<JsonObject | null>(readString(row, "payload")) ?? undefined,
    contentHash: readString(row, "payload_hash"),
    revision: readNumber(row, "revision"),
    createdSequence: readNumber(row, "created_sequence"),
    lastChangeSequence: readNumber(row, "last_change_sequence"),
    firstSeenAt: readString(row, "first_seen_at"),
    lastChangedAt: readString(row, "last_changed_at"),
    deletedAt: readOptionalString(row, "deleted_at"),
    lastSeenSnapshotId: readOptionalString(row, "last_seen_snapshot_id"),
  };
}

function readChangeRow(row: RuntimeRow): SyncChange {
  const operation = readString(row, "operation");
  assertChangeOperation(operation);
  return {
    sourceId: readString(row, "source_id"),
    sequence: readNumber(row, "sequence"),
    eventId: readString(row, "event_id"),
    installationId: readString(row, "installation_id"),
    provider: readString(row, "provider"),
    connectionId: readString(row, "connection_id"),
    definitionId: readString(row, "definition_id"),
    definitionVersion: readString(row, "definition_version"),
    kind: readString(row, "model"),
    recordId: readString(row, "record_id"),
    operation,
    recordRevision: readNumber(row, "record_revision"),
    content: parseJson<JsonObject | null>(readString(row, "payload")) ?? undefined,
    contentHash: readString(row, "payload_hash"),
    deletedAt: readOptionalString(row, "deleted_at"),
    runId: readString(row, "run_id"),
    committedAt: readString(row, "committed_at"),
  };
}

function readSnapshotRow(row: RuntimeRow): SyncSnapshot {
  const state = readString(row, "state");
  if (state !== "abandoned" && state !== "active" && state !== "completed") {
    throw new Error(`Unexpected sync snapshot state: ${state}.`);
  }
  return {
    id: readString(row, "id"),
    installationId: readString(row, "installation_id"),
    runId: readString(row, "run_id"),
    kinds: parseJson<string[]>(readString(row, "models_value")),
    baselineSequence: readNumber(row, "baseline_sequence"),
    state,
    startedAt: readString(row, "started_at"),
    completedAt: readOptionalString(row, "completed_at"),
  };
}

function readOutboxRow(row: RuntimeRow): SyncOutboxRecord {
  const state = readString(row, "state");
  if (state !== "delivered" && state !== "leased" && state !== "pending") {
    throw new Error(`Unexpected sync outbox state: ${state}.`);
  }
  return {
    changeSequence: readNumber(row, "change_sequence"),
    state,
    attemptCount: readNumber(row, "attempt_count"),
    nextAttemptAt: readString(row, "next_attempt_at"),
    leaseOwner: readOptionalString(row, "lease_owner"),
    leaseGeneration: readNumber(row, "lease_generation"),
    leaseExpiresAt: readOptionalString(row, "lease_expires_at"),
    deliveredAt: readOptionalString(row, "delivered_at"),
    lastError: readOptionalString(row, "last_error"),
  };
}

function readCanonicalValue(value: unknown, label: string): ReturnType<typeof canonicalizeJsonValue> {
  try {
    return canonicalizeJsonValue(value);
  } catch (error) {
    throw invalidInput(`${label} is invalid: ${error instanceof Error ? error.message : "unknown JSON error"}`);
  }
}

function requiredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumIdentifierLength) {
    throw invalidInput(`${label} must be a non-empty string no longer than ${maximumIdentifierLength} characters.`);
  }
  return value;
}

function requiredModel(value: string): string {
  if (typeof value !== "string" || !modelPattern.test(value)) {
    throw invalidInput(
      "model must start with a letter and contain at most 128 letters, digits, dots, underscores, or hyphens.",
    );
  }
  return value;
}

function requiredRecordId(value: string): string {
  return requiredIdentifier(value, "record id");
}

function requiredTimestamp(value: string, label: string): string {
  const milliseconds = timestampSchema.safeParse(value).success ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw invalidInput(`${label} must be a valid timezone-qualified ISO timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function readRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput("expectedCheckpointRevision must be a non-negative safe integer.");
  }
  return value;
}

function normalizeLease(input: SyncLeaseInput): SyncLeaseInput {
  const generation = input.generation;
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw invalidInput("lease generation must be a positive safe integer.");
  }
  return {
    owner: requiredIdentifier(input.owner, "lease owner"),
    generation,
  };
}

function normalizeModels(input: readonly string[]): string[] {
  if (input.length === 0) {
    throw invalidInput("A snapshot must include at least one model.");
  }
  const models = Array.from(new Set(input.map(requiredModel))).sort();
  if (models.length !== input.length) {
    throw invalidInput("Snapshot models must be unique.");
  }
  return models;
}

function assertUniqueRecord(keys: Set<string>, model: string, id: string): void {
  const key = JSON.stringify([model, id]);
  if (keys.has(key)) {
    throw invalidInput(`Record ${model}/${id} appears more than once in one page commit.`);
  }
  keys.add(key);
}

function assertInstallationState(value: string): asserts value is SyncInstallationState {
  if (value !== "disabled" && value !== "enabled" && value !== "needs_attention") {
    throw invalidInput(`Unexpected sync installation state: ${value}.`);
  }
}

function assertRunReason(value: string): asserts value is SyncRunReason {
  if (
    value !== "backfill" &&
    value !== "manual" &&
    value !== "reconcile" &&
    value !== "retry" &&
    value !== "schedule" &&
    value !== "webhook"
  ) {
    throw invalidInput(`Unexpected sync run reason: ${value}.`);
  }
}

function assertRunState(value: string): asserts value is SyncRunState {
  if (
    value !== "cancelled" &&
    value !== "failed" &&
    value !== "lease_expired" &&
    value !== "running" &&
    value !== "succeeded"
  ) {
    throw new Error(`Unexpected sync run state: ${value}.`);
  }
}

function assertChangeOperation(value: string): asserts value is SyncChangeOperation {
  if (value !== "added" && value !== "deleted" && value !== "updated") {
    throw new Error(`Unexpected sync change operation: ${value}.`);
  }
}

function readOptionalString(row: RuntimeRow | undefined, key: string): string | undefined {
  return row ? optionalRawString(row[key]) : undefined;
}

function readNumber(row: RuntimeRow, key: string): number {
  return toSafeInteger(row[key], key);
}

function readOptionalNumber(row: RuntimeRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  return value == null ? undefined : toSafeInteger(value, key);
}

function toSafeInteger(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`Expected ${label} to be a safe integer.`);
  }
  return number;
}

function invalidInput(message: string): SyncStoreError {
  return new SyncStoreError("invalid_input", message);
}

function leaseLost(runId: string): SyncStoreError {
  return new SyncStoreError("lease_lost", `The lease for sync run ${runId} is no longer valid.`);
}

function checkpointConflict(installationId: string, expected: number, actual?: number): SyncStoreError {
  const suffix = actual === undefined ? "" : `; current revision is ${actual}`;
  return new SyncStoreError(
    "checkpoint_conflict",
    `Expected checkpoint revision ${expected} for sync installation ${installationId}${suffix}.`,
  );
}
