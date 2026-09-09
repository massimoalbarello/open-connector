import type { ISyncDeliveryStore } from "./delivery-store.ts";
import type { ISyncScheduleStore } from "./schedule-store.ts";
import type { ISyncSourceStore } from "./source-binding.ts";
import type { ISyncStatusStore } from "./status-store.ts";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type SyncInstallationState = "disabled" | "enabled" | "needs_attention";
export type SyncRunReason = "backfill" | "manual" | "reconcile" | "retry" | "schedule" | "webhook";
export type SyncRunState = "cancelled" | "failed" | "lease_expired" | "running" | "succeeded";
export type SyncChangeOperation = "added" | "deleted" | "updated";

export interface SyncInstallation {
  consecutiveFailures: number;
  lastError?: string;
  requiresBackfill: boolean;
  sourceId: string;
  credentialRevision: string;
  bindingRevision: number;
  id: string;
  definitionId: string;
  definitionVersion: string;
  provider: string;
  connectionId: string;
  config: JsonObject;
  state: SyncInstallationState;
  scheduleSeconds?: number;
  nextDueAt?: string;
  lastSuccessAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartSyncRunInput {
  /** An explicit backward reset, committed atomically with the new run. */
  resetCheckpoint?: JsonValue;
  id: string;
  installationId: string;
  definitionVersion: string;
  reason: SyncRunReason;
  leaseOwner: string;
  leaseExpiresAt: string;
  startedAt: string;
}

export interface SyncRun {
  id: string;
  installationId: string;
  definitionVersion: string;
  reason: SyncRunReason;
  state: SyncRunState;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  checkpointRevision: number;
  pageCount: number;
  upsertCount: number;
  deleteCount: number;
  changeCount: number;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface SyncLeaseInput {
  owner: string;
  generation: number;
}

export interface RenewSyncRunLeaseInput extends SyncLeaseInput {
  runId: string;
  expiresAt: string;
}

export interface FinishSyncRunInput extends SyncLeaseInput {
  runId: string;
  state: Exclude<SyncRunState, "running">;
  completedAt: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface SyncCheckpoint {
  installationId: string;
  definitionVersion: string;
  revision: number;
  value: JsonValue | null;
  runId: string;
  updatedAt: string;
}

export interface SyncRecordUpsertInput {
  kind: string;
  record: unknown;
}

export interface SyncRecordDeleteInput {
  kind: string;
  id: string;
}

export interface CommitSyncPageInput {
  installationId: string;
  runId: string;
  lease: SyncLeaseInput;
  expectedCheckpointRevision: number;
  nextCheckpoint: unknown;
  upserts?: readonly SyncRecordUpsertInput[];
  deletes?: readonly SyncRecordDeleteInput[];
  snapshotId?: string;
  committedAt: string;
}

export interface FinishSyncSnapshotInput {
  installationId: string;
  runId: string;
  snapshotId: string;
  lease: SyncLeaseInput;
  expectedCheckpointRevision: number;
  nextCheckpoint: unknown;
  committedAt: string;
}

export interface StartSyncSnapshotInput {
  id: string;
  installationId: string;
  runId: string;
  kinds: readonly string[];
  lease: SyncLeaseInput;
  expectedCheckpointRevision: number;
  startedAt: string;
}

export interface SyncSnapshot {
  id: string;
  installationId: string;
  runId: string;
  kinds: string[];
  baselineSequence: number;
  state: "abandoned" | "active" | "completed";
  startedAt: string;
  completedAt?: string;
}

export interface SyncRecord {
  sourceId: string;
  provider: string;
  installationId: string;
  kind: string;
  id: string;
  /** Omitted after the destination acknowledges the payload. */
  content?: JsonObject;
  contentHash: string;
  revision: number;
  createdSequence: number;
  lastChangeSequence: number;
  firstSeenAt: string;
  lastChangedAt: string;
  deletedAt?: string;
  lastSeenSnapshotId?: string;
}

export interface SyncChange {
  sourceId: string;
  sequence: number;
  eventId: string;
  installationId: string;
  provider: string;
  connectionId: string;
  definitionId: string;
  definitionVersion: string;
  kind: string;
  recordId: string;
  operation: SyncChangeOperation;
  recordRevision: number;
  /** Omitted after the destination acknowledges the payload. */
  content?: JsonObject;
  contentHash: string;
  deletedAt?: string;
  runId: string;
  committedAt: string;
}

export interface SyncCommitResult {
  checkpoint: SyncCheckpoint;
  changes: SyncChange[];
  upsertCount: number;
  deleteCount: number;
}

export interface ListSyncChangesInput {
  afterSequence?: number;
  installationId?: string;
  limit?: number;
}

export interface SyncChangePage {
  items: SyncChange[];
  nextSequence?: number;
}

export interface SyncOutboxRecord {
  changeSequence: number;
  state: "delivered" | "leased" | "pending";
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface ISyncStore {
  readonly schedule: ISyncScheduleStore;
  readonly status: ISyncStatusStore;
  readonly delivery: ISyncDeliveryStore;
  readonly sources: ISyncSourceStore;
  getInstallation(id: string): Promise<SyncInstallation | undefined>;
  startRun(input: StartSyncRunInput): Promise<SyncRun>;
  getRun(id: string): Promise<SyncRun | undefined>;
  renewRunLease(input: RenewSyncRunLeaseInput): Promise<SyncRun>;
  finishRun(input: FinishSyncRunInput): Promise<SyncRun>;
  getCheckpoint(installationId: string): Promise<SyncCheckpoint | undefined>;
  /** Persist already-acquired data and progress together; never perform network I/O in the transaction. */
  commitPage(input: CommitSyncPageInput): Promise<SyncCommitResult>;
  startSnapshot(input: StartSyncSnapshotInput): Promise<SyncSnapshot>;
  finishSnapshot(input: FinishSyncSnapshotInput): Promise<SyncCommitResult>;
  getRecord(installationId: string, kind: string, recordId: string): Promise<SyncRecord | undefined>;
  listChanges(input?: ListSyncChangesInput): Promise<SyncChangePage>;
  listOutbox(): Promise<SyncOutboxRecord[]>;
}

export type SyncStoreErrorCode =
  | "destination_required"
  | "binding_conflict"
  | "credential_changed"
  | "checkpoint_conflict"
  | "installation_not_found"
  | "invalid_input"
  | "lease_lost"
  | "cursor_expired"
  | "run_busy"
  | "run_not_found"
  | "snapshot_inactive"
  | "snapshot_not_found";

export class SyncStoreError extends Error {
  readonly code: SyncStoreErrorCode;

  constructor(code: SyncStoreErrorCode, message: string) {
    super(message);
    this.name = "SyncStoreError";
    this.code = code;
  }
}
