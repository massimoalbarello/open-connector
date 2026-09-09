import type { SyncDeliveryStatus } from "./delivery-store.ts";
import type { SyncBindingCandidate } from "./schedule-store.ts";
import type { SyncInstallation, SyncRun } from "./sync-store.ts";

/** Administration status shared by the server and dashboard. */
export interface SyncStatus extends SyncStoreStatus {
  acquisitionRunning: boolean;
  schedulerRunning: boolean;
  delivery: SyncDeliveryStatus;
}

export interface SyncStoreStatus {
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
  read(): Promise<SyncStoreStatus>;
}
