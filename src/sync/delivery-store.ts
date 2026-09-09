import type { JsonObject, SyncChangeOperation } from "./sync-store.ts";

export const maximumDeliveryBytes: number = 16 * 1024 * 1024;
export const maximumRecordBytes: number = 8 * 1024 * 1024;

export interface SyncDestinationInput {
  url: string;
  bearerToken: string;
  enabled: boolean;
}
export interface SyncDestination {
  url: string;
  enabled: boolean;
}
export interface SyncDeliveryStatus {
  destination?: SyncDestination;
  pendingRecords: number;
  deliveredRecords: number;
  lastError?: string;
  nextAttemptAt?: string;
}
/** Stable event and source identities let receivers deduplicate and reject stale revisions. */
export interface SyncDeliveryRecord {
  eventId: string;
  provider: string;
  sourceId: string;
  kind: string;
  id: string;
  revision: number;
  operation: SyncChangeOperation;
  contentHash: string;
  content?: JsonObject;
  committedAt: string;
}
export interface SyncDeliveryEnvelope {
  version: 1;
  batchId: string;
  records: SyncDeliveryRecord[];
}
export interface SyncDeliveryLease {
  id: string;
  owner: string;
  generation: number;
  attempt: number;
  url: string;
  bearerToken: string;
  body: string;
}
export interface CompleteSyncDeliveryInput {
  lease: SyncDeliveryLease;
  acknowledged: boolean;
  httpStatus?: number;
  errorCode?: string;
  retryAt?: string;
  now: string;
}
export interface ISyncDeliveryStore {
  configure(input: SyncDestinationInput): Promise<void>;
  /** Remove configuration and fence in-flight ACKs; queued records remain pending. */
  remove(): void;
  getDestination(): SyncDestination | undefined;
  requireDestination(): void;
  status(): SyncDeliveryStatus;
  claim(now: string): Promise<SyncDeliveryLease | undefined>;
  complete(input: CompleteSyncDeliveryInput): void;
  purge(): void;
}
