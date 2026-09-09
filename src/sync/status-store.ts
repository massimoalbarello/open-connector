import type { SyncBindingCandidate } from "./schedule-store.ts";
import type { SyncInstallation, SyncRun } from "./sync-store.ts";

export interface SyncStoreStatus {
  installations: SyncInstallation[];
  runs: SyncRun[];
  bindingErrors: SyncBindingCandidateError[];
}
export interface SyncBindingCandidateError extends SyncBindingCandidate {
  errorCode: string;
  nextAttemptAt: string;
}

/** Read-only monitoring across acquisition, scheduling, and delivery state. */
export interface ISyncStatusStore {
  read(): Promise<SyncStoreStatus>;
}
