import type { SyncDefinition } from "./sync-definition.ts";
import type { JsonObject, SyncInstallation } from "./sync-store.ts";

export interface SyncBindingCandidate {
  config?: JsonObject;
  connectionId: string;
  connectionName: string;
  credentialRevision: string;
  definitionId: string;
}
export interface SyncScheduleResult {
  installationId: string;
  bindingRevision: number;
  complete: boolean;
  succeeded: boolean;
  errorCode?: string;
  now: string;
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
  recover(now: string): number;
  configure(input: ConfigureSyncScheduleInput): void;
}
