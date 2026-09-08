/** Read-only shapes returned by the sync administration API. */
export interface SyncStatus {
  acquisitionRunning: boolean;
  schedulerRunning: boolean;
  installations: SyncInstallation[];
  runs: SyncRun[];
  receivers: SyncReceiver[];
  bindingErrors: SyncBindingError[];
}

export interface SyncInstallation {
  id: string;
  definitionId: string;
  provider: string;
  sourceId?: string;
  connectionId: string;
  connectionName?: string;
  connectionStatus: "connected" | "missing" | "changed";
  state: "disabled" | "enabled" | "needs_attention";
  scheduleSeconds?: number;
  nextDueAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  requiresBackfill: boolean;
  latestRun?: SyncRun;
  recordCount: number;
  deliveredCount: number;
  pendingCount: number;
}

export interface SyncRun {
  id: string;
  installationId: string;
  reason: "backfill" | "manual" | "reconcile" | "retry" | "schedule" | "webhook";
  state: "cancelled" | "failed" | "lease_expired" | "running" | "succeeded";
  startedAt: string;
  completedAt?: string;
  pageCount: number;
  upsertCount: number;
  changeCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SyncReceiver {
  id: string;
  url: string;
  enabled: boolean;
  pendingRecords: number;
  deliveredRecords: number;
  lastDeliveredAt?: string;
  attemptCount: number;
  lastError?: string;
  nextAttemptAt?: string;
}

export interface SyncBindingError {
  connectionId: string;
  connectionName: string;
  definitionId: string;
  errorCode: string;
  nextAttemptAt: string;
}

/** Paused or disconnected syncs must not appear healthy just because the last run succeeded. */
export function syncHealth(sync: SyncInstallation): string {
  if (sync.latestRun?.state === "running") return "running";
  if (sync.state === "disabled") return "paused";
  if (sync.connectionStatus === "missing") return "disconnected";
  if (sync.connectionStatus === "changed") return "verifying";
  if (sync.requiresBackfill || sync.state === "needs_attention") return "needsAttention";
  if (sync.lastError || sync.consecutiveFailures > 0) return "retrying";
  return sync.latestRun ? "scheduled" : "waiting";
}

export function syncCanPoll(sync: SyncInstallation): boolean {
  return sync.state === "enabled" && sync.connectionStatus === "connected" && !sync.requiresBackfill;
}
