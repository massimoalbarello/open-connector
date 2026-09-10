import { recordDeliveryContract } from "./record-delivery-contract.generated.ts";

export type { SyncDeliveryEnvelope, SyncDeliveryRecord } from "./record-delivery-contract.generated.ts";

export const maximumDeliveryBytes: number = recordDeliveryContract.maximumDeliveryBytes;
export const maximumRecordBytes: number = recordDeliveryContract.maximumRecordBytes;

export interface SyncDestinationInput {
  url: string;
  bearerToken: string;
  enabled: boolean;
}
export interface UpdateSyncDestinationInput {
  url?: string;
  bearerToken?: string;
  enabled?: boolean;
}
export interface SyncRunDelivery {
  state: "none" | "waiting" | "pending" | "delivering" | "retrying" | "delivered";
  totalRecords: number;
  deliveredRecords: number;
  pendingRecords: number;
  lastError?: string;
  nextAttemptAt?: string;
  lastDeliveredAt?: string;
}
export interface SyncDestination {
  url: string;
  enabled: boolean;
}
export interface SyncDeliveryStatus {
  destination?: SyncDestination;
  pendingRecords: number;
  deliveredRecords: number;
  lastDeliveredAt?: string;
  attemptCount: number;
  lastError?: string;
  nextAttemptAt?: string;
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
  update(input: UpdateSyncDestinationInput): Promise<void>;
  runStatus(runId: string): SyncRunDelivery;
  /** Remove configuration and fence in-flight ACKs; queued records remain pending. */
  remove(): void;
  getDestination(): SyncDestination | undefined;
  requireDestination(): void;
  status(): SyncDeliveryStatus;
  claim(now: string): Promise<SyncDeliveryLease | undefined>;
  complete(input: CompleteSyncDeliveryInput): void;
  purge(): void;
}
