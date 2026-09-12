import type { SyncRecordAsset } from "./asset-store.ts";
import type { SyncAssetReceipt } from "./asset-upload.ts";

import { recordDeliveryContract } from "./record-delivery-contract.generated.ts";

export type { SyncDeliveryEnvelope, SyncDeliveryRecord } from "./record-delivery-contract.generated.ts";

export const maximumDeliveryBytes: number = recordDeliveryContract.maximumDeliveryBytes;
export const maximumRecordBytes: number = recordDeliveryContract.maximumRecordBytes;

export interface SyncDestinationInput {
  assetsUrl?: string | null;
  url: string;
  bearerToken: string;
  enabled: boolean;
}
export interface UpdateSyncDestinationInput {
  assetsUrl?: string | null;
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
  assetsUrl?: string;
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
  assetsUrl?: string;
  /** Available once all assets have been resolved into a durable delivery body. */
  body?: string;
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
  pendingAssets(lease: SyncDeliveryLease): SyncRecordAsset[];
  readAsset(lease: SyncDeliveryLease, sha256: string): Uint8Array;
  assetUploaded(lease: SyncDeliveryLease, asset: SyncAssetReceipt): void;
  prepare(lease: SyncDeliveryLease): string;
  renew(lease: SyncDeliveryLease, now: string): void;
  claim(now: string): Promise<SyncDeliveryLease | undefined>;
  complete(input: CompleteSyncDeliveryInput): void;
  purge(): void;
}
