import type { JsonSchema } from "../core/types.ts";
import type { SyncProvider, SyncProviderContext } from "./provider-adapter.ts";
import type { SyncDefinitionContract, SyncRecordInput } from "./record-contract.ts";
import type { JsonObject, JsonValue, SyncRecordDeleteInput } from "./sync-store.ts";

export interface SyncDefinition extends SyncDefinitionContract {
  requiredScopes: readonly string[];
  configSchema: JsonSchema;
  defaultConfig: JsonObject;
  checkpointSchema: JsonSchema;
  initialCheckpoint: JsonValue;
  scheduleSeconds: number;
}

export interface SyncContext {
  provider: SyncProvider;
  config: JsonObject;
  checkpoint: JsonValue;
  sourceId: string;
  startedAt: string;
  signal: AbortSignal;
}

export interface SyncPageRecord {
  kind: string;
  record: SyncRecordInput;
}

export interface SyncPage {
  records?: readonly SyncPageRecord[];
  deletes?: readonly SyncRecordDeleteInput[];
  checkpoint: JsonValue;
  /** The definition has completed this acquisition cycle. */
  complete: boolean;
}

export interface SyncDefinitionRuntime {
  run(context: SyncContext): AsyncGenerator<SyncPage>;
}

export interface SyncRegistration {
  createProvider(context: SyncProviderContext): SyncProvider;
  definition: SyncDefinition;
  load(): Promise<SyncDefinitionRuntime>;
}
