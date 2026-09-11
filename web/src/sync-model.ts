import type { SyncInstallationStatus } from "../../src/sync/status-store.ts";

/** Paused or disconnected syncs must not appear healthy just because the last run succeeded. */
export function syncHealth(sync: SyncInstallationStatus, destinationReady: boolean): string {
  if (sync.state === "disabled") return "paused";
  if (!destinationReady) return "waitingDestination";
  if (sync.latestRun?.state === "running") return "running";
  if (sync.connectionStatus === "missing") return "disconnected";
  if (sync.connectionStatus === "changed") return "verifying";
  if (sync.state === "needs_attention") return "needsAttention";
  if (sync.requiresBackfill && !sync.lastError) return "waiting";
  if (sync.lastError || sync.consecutiveFailures > 0) return "retrying";
  return sync.latestRun ? "scheduled" : "waiting";
}

export function syncCanPoll(sync: SyncInstallationStatus, destinationReady: boolean): boolean {
  return (
    destinationReady && sync.state === "enabled" && sync.connectionStatus === "connected" && !sync.requiresBackfill
  );
}
