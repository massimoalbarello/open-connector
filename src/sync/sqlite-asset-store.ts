import type { StageSyncAssetInput, SyncRecordAsset } from "./asset-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { defaultPendingAssetBytes, describeSyncAsset } from "./asset-store.ts";
import { SyncStoreError } from "./sync-store.ts";

/** Called within the sync store's fenced transactions; no provider or destination I/O. */
export class SqliteSyncAssetStore {
  private readonly database: DatabaseSync;
  private readonly maximumBytes: number;

  constructor(database: DatabaseSync, maximumBytes: number = defaultPendingAssetBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new SyncStoreError("invalid_input", "Pending asset budget must be a positive integer.");
    this.database = database;
    this.maximumBytes = maximumBytes;
  }

  stage(runId: string, input: StageSyncAssetInput): SyncRecordAsset {
    const asset = describeSyncAsset(input);
    this.purge();
    const existing = this.database.prepare("select 1 from sync_assets where sha256 = ?").get(asset.sha256);
    if (!existing) {
      const retained = this.database.prepare("select coalesce(sum(size_bytes), 0) as bytes from sync_assets").get()!;
      if (Number(retained.bytes) + asset.sizeBytes > this.maximumBytes)
        throw new SyncStoreError("asset_storage_full", "Pending attachments have reached the storage budget.");
      this.database
        .prepare("insert into sync_assets(sha256, bytes, size_bytes) values (?, ?, ?)")
        .run(asset.sha256, input.bytes, asset.sizeBytes);
    }
    this.database
      .prepare("insert or ignore into sync_staged_assets(run_id, sha256) values (?, ?)")
      .run(runId, asset.sha256);
    return asset;
  }

  require(assets: readonly SyncRecordAsset[]): void {
    for (const asset of assets) {
      const row = this.database.prepare("select size_bytes from sync_assets where sha256 = ?").get(asset.sha256);
      if (!row || Number(row.size_bytes) !== asset.sizeBytes)
        throw new SyncStoreError("invalid_input", "A record references attachment bytes that have not been staged.");
    }
  }

  claim(sequence: number, assets: readonly SyncRecordAsset[]): void {
    this.require(assets);
    for (const asset of assets)
      this.database
        .prepare("insert or ignore into sync_change_assets(change_sequence, sha256) values (?, ?)")
        .run(sequence, asset.sha256);
  }

  releasePage(runId: string, assets: readonly SyncRecordAsset[]): void {
    for (const asset of assets)
      this.database.prepare("delete from sync_staged_assets where run_id = ? and sha256 = ?").run(runId, asset.sha256);
  }

  /** Release only local bytes whose acquisition lease or pending deliveries no longer need them. */
  purge(): void {
    this.database
      .prepare(`delete from sync_staged_assets where not exists (
      select 1 from sync_runs r where r.id = sync_staged_assets.run_id
        and r.state = 'running' and r.lease_expires_at > ?
    )`)
      .run(new Date().toISOString());
    this.database
      .prepare(`delete from sync_change_assets where exists (
      select 1 from sync_outbox o where o.change_sequence = sync_change_assets.change_sequence and o.state = 'delivered'
    )`)
      .run();
    this.database
      .prepare(`delete from sync_assets where not exists (
      select 1 from sync_staged_assets s where s.sha256 = sync_assets.sha256
    ) and not exists (
      select 1 from sync_change_assets c where c.sha256 = sync_assets.sha256
    )`)
      .run();
  }
}
