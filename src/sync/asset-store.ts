import { createHash } from "node:crypto";
import { SyncStoreError } from "./sync-store.ts";

export const maximumSyncAssetBytes: number = 100 * 1024 * 1024;
export const defaultPendingAssetBytes: number = 1024 * 1024 * 1024;

/** Source content identity. Destination IDs and upload handles never enter this manifest. */
export interface SyncRecordAsset {
  sha256: string;
  name: string;
  sizeBytes: number;
}

export interface StageSyncAssetInput {
  name: string;
  bytes: Uint8Array;
}

export interface SyncAssets {
  /** Acquire and stage each attachment before yielding the page that references it. */
  stage(input: StageSyncAssetInput): Promise<SyncRecordAsset>;
}

/** Also used by dry runs, which validate attachments without persisting their bytes. */
export function describeSyncAsset(input: StageSyncAssetInput): SyncRecordAsset {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > maximumSyncAssetBytes)
    throw new SyncStoreError("invalid_input", "An attachment exceeds the 100 MiB asset limit.");
  const name = input.name.trim();
  if (!name || name.length > 160)
    throw new SyncStoreError("invalid_input", "Asset names must contain 1–160 characters.");
  return { name, sizeBytes: input.bytes.byteLength, sha256: createHash("sha256").update(input.bytes).digest("hex") };
}

/** A framework-owned placeholder resolved only when preparing delivery. */
export function syncAssetUrl(asset: Pick<SyncRecordAsset, "sha256">): string {
  return `open-connector://asset/${asset.sha256}`;
}
