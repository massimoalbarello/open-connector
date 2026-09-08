import type { SyncReceiverStatus } from "./delivery-store.ts";
import type { SyncDefinition } from "./sync-definition.ts";
import type { JsonObject, SyncInstallation, SyncRun } from "./sync-store.ts";

/** Administration status shared by the server and dashboard. */
export interface SyncStatus extends SyncScheduleStatus {
  acquisitionRunning: boolean;
  schedulerRunning: boolean;
  receivers: SyncReceiverStatus[];
}

export interface SyncBindingCandidate {
  config?: JsonObject;
  connectionId: string;
  connectionName: string;
  credentialRevision: string;
  definitionId: string;
}
export interface SyncScheduleStatus {
  installations: SyncInstallationStatus[];
  runs: SyncRun[];
  bindingErrors: SyncBindingCandidateError[];
}
export interface SyncInstallationStatus extends SyncInstallation {
  connectionName?: string;
  connectionStatus: "connected" | "missing" | "changed";
  latestRun?: SyncRun;
  /** Distinct current records, including those whose acknowledged payload was purged. */
  recordCount: number;
  /** Record changes per webhook destination; updates and fan-out count separately. */
  deliveredCount: number;
  pendingCount: number;
}
export interface SyncBindingCandidateError extends SyncBindingCandidate {
  errorCode: string;
  nextAttemptAt: string;
}
export interface SyncScheduleResult {
  installationId: string;
  bindingRevision: number;
  complete: boolean;
  succeeded: boolean;
  errorCode?: string;
  now: string;
}
export interface FailedSyncPollInput {
  /** The scheduled binding and due time observed before attempting acquisition. */
  installation: SyncInstallation;
  startedAt: string;
  completedAt: string;
  errorCode: string;
}
export interface ConfigureSyncScheduleInput {
  installationId: string;
  enabled: boolean;
  scheduleSeconds?: number;
}
export interface ScheduledSyncInstallation {
  installation: SyncInstallation;
  connectionName: string;
}
export interface ISyncScheduleStore {
  reconcile(definitions: readonly SyncDefinition[], now: string): void;
  bindingDue(definitions: readonly SyncDefinition[], now: string): SyncBindingCandidate | undefined;
  bindingFailed(candidate: SyncBindingCandidate, errorCode: string, now: string): void;
  bindingSucceeded(candidate: SyncBindingCandidate): void;
  due(now: string): ScheduledSyncInstallation | undefined;
  complete(input: SyncScheduleResult): void;
  /** Persist an attempt that failed before startRun, together with its retry backoff. */
  failBeforeRun(input: FailedSyncPollInput): void;
  recover(now: string): number;
  configure(input: ConfigureSyncScheduleInput): void;
  status(): Promise<SyncScheduleStatus>;
}
