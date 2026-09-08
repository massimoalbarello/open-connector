import type { SyncInstallationStatus } from "../../src/sync/schedule-store.ts";

/** Paused or disconnected syncs must not appear healthy just because the last run succeeded. */
export function syncHealth(sync: SyncInstallationStatus): string {
  if (sync.latestRun?.state === "running") return "running";
  if (sync.state === "disabled") return "paused";
  if (sync.connectionStatus === "missing") return "disconnected";
  if (sync.connectionStatus === "changed") return "verifying";
  if (sync.requiresBackfill || sync.state === "needs_attention") return "needsAttention";
  if (sync.lastError || sync.consecutiveFailures > 0) return "retrying";
  return sync.latestRun ? "scheduled" : "waiting";
}

export function syncCanPoll(sync: SyncInstallationStatus): boolean {
  return sync.state === "enabled" && sync.connectionStatus === "connected" && !sync.requiresBackfill;
}
