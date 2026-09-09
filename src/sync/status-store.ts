import type { SyncDeliveryStatus, SyncRunDelivery } from "./delivery-store.ts";
import type { SyncBindingCandidate } from "./schedule-store.ts";
import type { SyncDefinition } from "./sync-definition.ts";
import type { SyncInstallation, SyncRun } from "./sync-store.ts";

/** Administration status shared by the server and dashboard. */
export interface SyncStatus extends SyncStoreStatus {
  definitions: readonly SyncDefinition[];
  acquisitionRunning: boolean;
  schedulerRunning: boolean;
  delivery: SyncDeliveryStatus;
}

export interface SyncStoreStatus {
  installations: SyncInstallationStatus[];
  runs: SyncRunStatus[];
  bindingErrors: SyncBindingCandidateError[];
}
export interface SyncRunStatus extends SyncRun {
  delivery: SyncRunDelivery;
}
export interface SyncInstallationStatus extends SyncInstallation {
  connectionName?: string;
  connectionStatus: "connected" | "missing" | "changed";
  latestRun?: SyncRunStatus;
  /** Distinct current records, including those whose acknowledged payload was purged. */
  recordCount: number;
  /** Acknowledged record changes, including updates and deletions. */
  deliveredCount: number;
  pendingCount: number;
}
export interface SyncBindingCandidateError extends SyncBindingCandidate {
  errorCode: string;
  nextAttemptAt: string;
}

/** Read-only monitoring across acquisition, scheduling, and delivery state. */
export interface ISyncStatusStore {
  read(installationId?: string): Promise<SyncStoreStatus>;
  getRun(id: string): SyncRunStatus | undefined;
}
