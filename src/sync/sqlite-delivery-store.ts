import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RuntimeRow } from "../server/storage/runtime-sql.ts";
import type { SyncRecordAsset } from "./asset-store.ts";
import type { SyncAssetReceipt } from "./asset-upload.ts";
import type {
  CompleteSyncDeliveryInput,
  ISyncDeliveryStore,
  SyncDeliveryEnvelope,
  SyncDeliveryLease,
  SyncDeliveryRecord,
  SyncDestinationInput,
  UpdateSyncDestinationInput,
  SyncRunDelivery,
  SyncDestination,
  SyncDeliveryStatus,
} from "./delivery-store.ts";
import type { SqliteSyncAssetStore } from "./sqlite-asset-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { createHash } from "node:crypto";
import { assertPublicHttpUrl } from "../core/request.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { parseJson, readString } from "../server/storage/runtime-sql.ts";
import { resolveSyncAssetLinks } from "./asset-links.ts";
import { syncAssetUrl } from "./asset-store.ts";
import { validateAssetReceipt } from "./asset-upload.ts";
import { maximumDeliveryBytes, maximumRecordBytes } from "./delivery-store.ts";
import { recordDeliveryContract } from "./record-delivery-contract.generated.ts";
import { canonicalizeJsonObject } from "./record-hash.ts";
import { runSyncTransaction } from "./sqlite-sync-transaction.ts";
import { SyncStoreError } from "./sync-store.ts";

/** Durable membership, attempts and ACKs. No transaction spans encryption or network I/O. */
export class SqliteSyncDeliveryStore implements ISyncDeliveryStore {
  private readonly database: DatabaseSync;
  private readonly codec: ISecretCodec;
  private readonly assets: SqliteSyncAssetStore;

  constructor(database: DatabaseSync, codec: ISecretCodec, assets: SqliteSyncAssetStore) {
    this.database = database;
    this.codec = codec;
    this.assets = assets;
  }

  async configure(input: SyncDestinationInput): Promise<void> {
    if (
      !input.url ||
      !input.bearerToken ||
      typeof input.enabled !== "boolean" ||
      input.bearerToken.length > 8192 ||
      /\s/.test(input.bearerToken)
    )
      throw new SyncStoreError("invalid_input", "Destination URL, Bearer token and enabled flag are required.");
    await this.save({ ...input, assetsUrl: input.assetsUrl ?? null }, false);
  }

  async update(input: UpdateSyncDestinationInput): Promise<void> {
    await this.save(input, true);
  }

  private async save(input: UpdateSyncDestinationInput, requireExisting: boolean): Promise<void> {
    if (
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      (input.bearerToken !== undefined &&
        (!input.bearerToken || input.bearerToken.length > 8192 || /\s/.test(input.bearerToken)))
    )
      throw new SyncStoreError("invalid_input", "Invalid destination enabled flag or Bearer token.");
    const url =
      input.url === undefined
        ? undefined
        : assertPublicHttpUrl(input.url, {
            fieldName: "Destination URL",
            createError: (message) => new SyncStoreError("invalid_input", message),
          });
    if (url && (url.protocol !== "https:" || url.hash))
      throw new SyncStoreError("invalid_input", "The destination requires public HTTPS without a fragment.");
    const assetsUrl =
      input.assetsUrl == null
        ? input.assetsUrl
        : assertPublicHttpUrl(input.assetsUrl, {
            fieldName: "Asset upload URL",
            createError: (message) => new SyncStoreError("invalid_input", message),
          }).toString();
    const secret = input.bearerToken === undefined ? undefined : await this.codec.encode(input.bearerToken);
    runSyncTransaction(this.database, () => {
      const existing = this.database.prepare("select * from sync_destination where id = 1").get();
      if (requireExisting && !existing)
        throw new SyncStoreError("destination_required", "Destination is not configured.");
      if (!existing && (!url || !secret || input.enabled === undefined))
        throw new SyncStoreError("invalid_input", "Destination URL, Bearer token and enabled flag are required.");
      const nextUrl = url?.toString() ?? readString(existing!, "url");
      const nextAssetsUrl = assetsUrl === undefined ? (existing?.assets_url ?? null) : assetsUrl;
      if (nextAssetsUrl) {
        const parsed = new URL(String(nextAssetsUrl));
        if (parsed.origin !== new URL(nextUrl).origin || parsed.protocol !== "https:" || parsed.hash || parsed.search)
          throw new SyncStoreError(
            "invalid_input",
            "Asset uploads require HTTPS on the record destination origin, without a query or fragment.",
          );
      }
      const identityChanged =
        !existing ||
        nextUrl !== existing.url ||
        nextAssetsUrl !== existing.assets_url ||
        input.bearerToken !== undefined;
      this.database
        .prepare(`insert into sync_destination(id, url, bearer_secret, enabled, assets_url) values (1, ?, ?, ?, ?)
        on conflict(id) do update set url = excluded.url, bearer_secret = excluded.bearer_secret, enabled = excluded.enabled, assets_url = excluded.assets_url`)
        .run(
          url?.toString() ?? readString(existing!, "url"),
          secret ?? readString(existing!, "bearer_secret"),
          Number(input.enabled ?? existing?.enabled === 1),
          nextAssetsUrl,
        );
      this.releaseBatches(new Date().toISOString(), identityChanged);
    });
  }

  runStatus(runId: string): SyncRunDelivery {
    const row = this.database
      .prepare(`select count(*) as total,
      coalesce(sum(o.state = 'delivered'), 0) as delivered,
      coalesce(sum(o.state != 'delivered'), 0) as pending,
      coalesce(sum(o.state = 'leased'), 0) as leased,
      max(case when o.state = 'pending' then o.last_error end) as last_error,
      min(case when o.state = 'pending' then o.next_attempt_at end) as next_attempt_at,
      max(o.delivered_at) as last_delivered_at
      from sync_outbox o join sync_changes c on c.sequence = o.change_sequence where c.run_id = ?`)
      .get(runId)!;
    const ready = this.getDestination()?.enabled === true;
    const total = Number(row.total),
      pending = Number(row.pending);
    return {
      state:
        total === 0
          ? "none"
          : pending === 0
            ? "delivered"
            : !ready
              ? "waiting"
              : Number(row.leased) > 0
                ? "delivering"
                : row.last_error
                  ? "retrying"
                  : "pending",
      totalRecords: total,
      deliveredRecords: Number(row.delivered),
      pendingRecords: pending,
      lastError: row.last_error === null ? undefined : readString(row, "last_error"),
      nextAttemptAt: !ready || row.next_attempt_at === null ? undefined : readString(row, "next_attempt_at"),
      lastDeliveredAt: row.last_delivered_at === null ? undefined : readString(row, "last_delivered_at"),
    };
  }

  remove(): void {
    runSyncTransaction(this.database, () => {
      this.database.prepare("delete from sync_destination").run();
      this.releaseBatches(new Date().toISOString(), true);
    });
  }

  getDestination(): SyncDestination | undefined {
    const row = this.database.prepare("select url, enabled, assets_url from sync_destination where id = 1").get();
    return row
      ? {
          url: readString(row, "url"),
          enabled: row.enabled === 1,
          assetsUrl: row.assets_url === null ? undefined : readString(row, "assets_url"),
        }
      : undefined;
  }

  requireDestination(): void {
    if (!this.getDestination()?.enabled)
      throw new SyncStoreError("destination_required", "Sync is waiting for an enabled destination.");
  }

  status(): SyncDeliveryStatus {
    const row = this.database
      .prepare(`select
      coalesce(sum(state != 'delivered'), 0) as pending,
      coalesce(sum(state = 'delivered'), 0) as delivered, max(delivered_at) as last_delivered_at from sync_outbox`)
      .get()!;
    const batch = this.database
      .prepare(
        "select last_error, next_attempt_at, attempt_count from sync_delivery_batches where state != 'delivered'",
      )
      .get();
    const destination = this.getDestination();
    return {
      destination,
      pendingRecords: Number(row.pending),
      deliveredRecords: Number(row.delivered),
      lastDeliveredAt: row.last_delivered_at === null ? undefined : readString(row, "last_delivered_at"),
      attemptCount: Number(batch?.attempt_count ?? 0),
      lastError: batch?.last_error == null ? undefined : readString(batch, "last_error"),
      nextAttemptAt: destination?.enabled && batch ? readString(batch, "next_attempt_at") : undefined,
    };
  }

  // The queue survives configuration changes. Old workers cannot acknowledge a replacement's delivery.
  private releaseBatches(now: string, identityChanged: boolean): void {
    if (identityChanged) {
      this.database.prepare("delete from sync_asset_uploads").run();
      this.database.prepare("update sync_delivery_batches set body = null where state != 'delivered'").run();
      this.database
        .prepare(`update sync_changes set delivery_hash = null where exists (
        select 1 from sync_outbox o where o.change_sequence = sync_changes.sequence and o.state != 'delivered'
      )`)
        .run();
    }
    this.database
      .prepare(`update sync_delivery_attempts set completed_at = ?, error_code = 'destination_changed'
      where completed_at is null`)
      .run(now);
    this.database
      .prepare(`update sync_delivery_batches set state = 'pending', lease_generation = lease_generation + 1,
      next_attempt_at = ?, lease_expires_at = null, last_error = null where state != 'delivered'`)
      .run(now);
    this.database
      .prepare(`update sync_outbox set state = 'pending', next_attempt_at = ?,
      lease_expires_at = null, last_error = null where state != 'delivered'`)
      .run(now);
  }

  async claim(now: string): Promise<SyncDeliveryLease | undefined> {
    const claimed = runSyncTransaction(this.database, () => {
      const destination = this.database.prepare("select * from sync_destination where id = 1 and enabled = 1").get();
      if (!destination) return undefined;
      let batch = this.database.prepare(`select * from sync_delivery_batches where state != 'delivered'`).get();
      if (
        batch &&
        (readString(batch, "next_attempt_at") > now ||
          (batch.state === "leased" && readString(batch, "lease_expires_at") > now))
      )
        return undefined;
      if (!batch) {
        const id = randomUUIDv7();
        const rows = this.database
          .prepare(`select c.*, i.source_id from sync_outbox o join sync_changes c on c.sequence = o.change_sequence
          join sync_installations i on i.id = c.installation_id
          where o.state = 'pending' and o.batch_id is null order by c.sequence limit ?`)
          .iterate(recordDeliveryContract.maximumBatchRecords);
        const envelope: SyncDeliveryEnvelope = {
          version: recordDeliveryContract.version,
          batchId: id,
          records: [],
        };
        const selected: number[] = [];
        for (const row of rows) {
          envelope.records.push(readDeliveryRecord(row));
          if (Buffer.byteLength(JSON.stringify(envelope)) > maximumDeliveryBytes) {
            if (!selected.length)
              throw new SyncStoreError("invalid_input", "Pending record exceeds delivery byte limit.");
            envelope.records.pop();
            break;
          }
          selected.push(Number(row.sequence));
        }
        if (!selected.length) return undefined;
        this.database
          .prepare(
            "insert into sync_delivery_batches(id, state, next_attempt_at, created_at) values (?, 'pending', ?, ?)",
          )
          .run(id, now, now);
        for (const sequence of selected)
          this.database.prepare("update sync_outbox set batch_id = ? where change_sequence = ?").run(id, sequence);
        batch = this.database.prepare("select * from sync_delivery_batches where id = ?").get(id)!;
      }
      const id = readString(batch, "id");
      const owner = randomUUIDv7();
      const generation = Number(batch.lease_generation) + 1;
      const attempt = Number(batch.attempt_count) + 1;
      const expires = new Date(Date.parse(now) + 60_000).toISOString();
      this.database
        .prepare(
          "update sync_delivery_attempts set completed_at = ?, error_code = 'lease_expired' where batch_id = ? and completed_at is null",
        )
        .run(now, id);
      this.database
        .prepare(
          "update sync_delivery_batches set state = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ?, attempt_count = ? where id = ?",
        )
        .run(owner, generation, expires, attempt, id);
      this.database
        .prepare(
          "update sync_outbox set state = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ?, attempt_count = ? where batch_id = ?",
        )
        .run(owner, generation, expires, attempt, id);
      this.database
        .prepare("insert into sync_delivery_attempts(batch_id, attempt, started_at) values (?, ?, ?)")
        .run(id, attempt, now);
      return {
        id,
        owner,
        generation,
        attempt,
        url: readString(destination, "url"),
        bearerToken: readString(destination, "bearer_secret"),
        assetsUrl: destination.assets_url === null ? undefined : readString(destination, "assets_url"),
        body: batch.body == null ? undefined : readString(batch, "body"),
      };
    });
    if (!claimed) return undefined;
    try {
      claimed.bearerToken = await this.codec.decode(claimed.bearerToken);
    } catch {
      this.complete({
        lease: claimed,
        acknowledged: false,
        errorCode: "receiver_secret_unavailable",
        retryAt: new Date(Date.parse(now) + 3600_000).toISOString(),
        now,
      });
      return undefined;
    }
    const hasAssets = this.database
      .prepare(
        `select 1 from sync_change_assets a join sync_outbox o on o.change_sequence = a.change_sequence where o.batch_id = ? limit 1`,
      )
      .get(claimed.id);
    if (!hasAssets) claimed.body = this.prepare(claimed);
    return claimed;
  }

  private assertLease(lease: SyncDeliveryLease, now = new Date().toISOString()): RuntimeRow {
    const row = this.database
      .prepare(`select * from sync_delivery_batches
      where id = ? and state = 'leased' and lease_owner = ? and lease_generation = ? and lease_expires_at > ?`)
      .get(lease.id, lease.owner, lease.generation, now);
    if (!row) throw new SyncStoreError("lease_lost", "Delivery lease is no longer owned.");
    return row;
  }

  private batchRows(lease: SyncDeliveryLease): RuntimeRow[] {
    return this.database
      .prepare(`select c.*, i.source_id from sync_changes c
      join sync_outbox o on o.change_sequence = c.sequence join sync_installations i on i.id = c.installation_id
      where o.batch_id = ? order by c.sequence`)
      .all(lease.id);
  }

  pendingAssets(lease: SyncDeliveryLease): SyncRecordAsset[] {
    this.assertLease(lease);
    const pending = new Map<string, SyncRecordAsset>();
    for (const row of this.batchRows(lease)) {
      const content = parseJson<{ assets?: SyncRecordAsset[] } | null>(readString(row, "payload"));
      for (const asset of content?.assets ?? []) {
        if (!this.database.prepare("select 1 from sync_asset_uploads where sha256 = ?").get(asset.sha256))
          pending.set(asset.sha256, asset);
      }
    }
    return [...pending.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  }

  readAsset(lease: SyncDeliveryLease, sha256: string): Uint8Array {
    this.assertLease(lease);
    const row = this.database
      .prepare(`select a.bytes from sync_assets a where a.sha256 = ? and exists (
      select 1 from sync_change_assets c join sync_outbox o on o.change_sequence = c.change_sequence
      where c.sha256 = a.sha256 and o.batch_id = ?
    )`)
      .get(sha256, lease.id);
    if (!(row?.bytes instanceof Uint8Array) || createHash("sha256").update(row.bytes).digest("hex") !== sha256)
      throw new SyncStoreError("invalid_input", "Pending attachment bytes are missing or corrupt.");
    return row.bytes;
  }

  assetUploaded(lease: SyncDeliveryLease, receipt: SyncAssetReceipt): void {
    runSyncTransaction(this.database, () => {
      this.assertLease(lease);
      const expected = this.database
        .prepare(`select a.size_bytes from sync_assets a where a.sha256 = ? and exists (
        select 1 from sync_change_assets c join sync_outbox o on o.change_sequence = c.change_sequence
        where c.sha256 = a.sha256 and o.batch_id = ?
      )`)
        .get(receipt.sha256, lease.id);
      if (!expected) throw new SyncStoreError("invalid_input", "Upload is not pending in this delivery.");
      const asset = validateAssetReceipt(receipt, { sha256: receipt.sha256, sizeBytes: Number(expected.size_bytes) });
      const existing = this.database
        .prepare("select asset_id, url from sync_asset_uploads where sha256 = ?")
        .get(asset.sha256);
      if (existing) {
        if (existing.asset_id !== asset.assetId || existing.url !== asset.url)
          throw new SyncStoreError("invalid_input", "Destination changed an uploaded asset identity.");
        return;
      }
      this.database
        .prepare("insert into sync_asset_uploads(sha256, asset_id, url, size_bytes) values (?, ?, ?, ?)")
        .run(asset.sha256, asset.assetId, asset.url, asset.sizeBytes);
    });
  }

  renew(lease: SyncDeliveryLease, now: string): void {
    runSyncTransaction(this.database, () => {
      this.assertLease(lease, now);
      const expires = new Date(Date.parse(now) + 60_000).toISOString();
      this.database
        .prepare("update sync_delivery_batches set lease_expires_at = ? where id = ?")
        .run(expires, lease.id);
      this.database.prepare("update sync_outbox set lease_expires_at = ? where batch_id = ?").run(expires, lease.id);
    });
  }

  prepare(lease: SyncDeliveryLease): string {
    return runSyncTransaction(this.database, () => {
      const batch = this.assertLease(lease);
      if (batch.body !== null) return readString(batch, "body");
      const envelope: SyncDeliveryEnvelope = {
        version: recordDeliveryContract.version,
        batchId: lease.id,
        records: [],
      };
      const rows = this.batchRows(lease);
      let envelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
      for (const row of rows) {
        const record = readDeliveryRecord(row);
        if (record.operation !== "deleted") {
          const source = record.content as typeof record.content & { assets?: SyncRecordAsset[] };
          const { assets, ...content } = source;
          if (assets?.length) {
            const urls = new Map<string, string>();
            const ids = new Set<string>();
            for (const asset of assets) {
              const uploaded = this.database
                .prepare("select * from sync_asset_uploads where sha256 = ?")
                .get(asset.sha256);
              if (!uploaded)
                throw new SyncStoreError("invalid_input", "Attachments must finish uploading before delivery.");
              urls.set(syncAssetUrl(asset), readString(uploaded, "url"));
              ids.add(readString(uploaded, "asset_id"));
            }
            content.body = resolveSyncAssetLinks(content.body, urls);
            content.assetIds = [...ids].sort();
          }
          const canonical = canonicalizeJsonObject(content);
          if (Buffer.byteLength(canonical.json) > maximumRecordBytes)
            throw new SyncStoreError("invalid_input", "Resolved record exceeds the 8 MiB delivery limit.");
          record.content = content;
          record.contentHash = canonical.sha256;
        } else {
          const prior = this.database
            .prepare(`select delivery_hash from sync_changes
            where installation_id = ? and model = ? and record_id = ? and sequence < ?
              and delivery_hash is not null order by sequence desc limit 1`)
            .get(readString(row, "installation_id"), record.kind, record.id, Number(row.sequence));
          if (prior) record.contentHash = readString(prior, "delivery_hash");
        }
        const recordBytes = Buffer.byteLength(JSON.stringify(record)) + (envelope.records.length ? 1 : 0);
        if (envelopeBytes + recordBytes > maximumDeliveryBytes) {
          if (!envelope.records.length)
            throw new SyncStoreError("invalid_input", "Resolved record exceeds delivery byte limit.");
          // No request has been sent yet. Release only the suffix that cannot fit after URL resolution.
          this.database
            .prepare(`update sync_outbox set batch_id = null, state = 'pending', lease_owner = null,
            lease_expires_at = null where batch_id = ? and change_sequence >= ?`)
            .run(lease.id, Number(row.sequence));
          break;
        }
        envelopeBytes += recordBytes;
        envelope.records.push(record);
        this.database
          .prepare("update sync_changes set delivery_hash = ? where sequence = ?")
          .run(record.contentHash, Number(row.sequence));
      }
      const body = JSON.stringify(envelope);
      this.database.prepare("update sync_delivery_batches set body = ? where id = ?").run(body, lease.id);
      return body;
    });
  }

  complete(input: CompleteSyncDeliveryInput): void {
    runSyncTransaction(this.database, () => {
      const { lease, now } = input;
      const batch = this.assertLease(lease, now);
      if (input.acknowledged && batch.body === null)
        throw new SyncStoreError("invalid_input", "Cannot acknowledge records before preparing their assets.");
      const state = input.acknowledged ? "delivered" : "pending";
      const result = this.database
        .prepare(`update sync_delivery_batches set state = ?, delivered_at = ?, next_attempt_at = ?, last_error = ?, lease_expires_at = null
        where id = ? and state = 'leased' and lease_owner = ? and lease_generation = ? and lease_expires_at > ?`)
        .run(
          state,
          input.acknowledged ? now : null,
          input.retryAt ?? now,
          input.errorCode ?? null,
          lease.id,
          lease.owner,
          lease.generation,
          now,
        );
      if (result.changes !== 1) throw new SyncStoreError("lease_lost", "Delivery lease is no longer owned.");
      this.database
        .prepare(
          "update sync_outbox set state = ?, delivered_at = ?, next_attempt_at = ?, last_error = ?, lease_expires_at = null where batch_id = ?",
        )
        .run(state, input.acknowledged ? now : null, input.retryAt ?? now, input.errorCode ?? null, lease.id);
      this.database
        .prepare(
          "update sync_delivery_attempts set completed_at = ?, http_status = ?, error_code = ? where batch_id = ? and attempt = ?",
        )
        .run(now, input.httpStatus ?? null, input.errorCode ?? null, lease.id, lease.attempt);
      this.purge();
    });
  }

  /** Retain unacknowledged bodies even when destination configuration is absent. */
  purge(): void {
    this.assets.purge();
    this.database
      .prepare("update sync_delivery_batches set body = null where state = 'delivered' and body is not null")
      .run();
    this.database
      .prepare(`update sync_changes set payload = 'null' where payload != 'null'
      and exists(select 1 from sync_outbox o where o.change_sequence = sync_changes.sequence and o.state = 'delivered')`)
      .run();
    this.database
      .prepare(`update sync_records set payload = 'null' where payload != 'null'
      and exists(select 1 from sync_changes c where c.sequence = sync_records.last_change_sequence and c.payload = 'null')`)
      .run();
  }
}

function readDeliveryRecord(row: RuntimeRow): SyncDeliveryRecord {
  const operation = readString(row, "operation") as SyncDeliveryRecord["operation"];
  const content =
    parseJson<Extract<SyncDeliveryRecord, { operation: "added" | "updated" }>["content"]>(readString(row, "payload")) ??
    undefined;
  if (operation !== "deleted" && !content)
    throw new SyncStoreError("invalid_input", "Pending delivery payload is unavailable.");
  const common = {
    eventId: readString(row, "event_id"),
    provider: readString(row, "provider"),
    sourceId: readString(row, "source_id"),
    kind: readString(row, "model"),
    id: readString(row, "record_id"),
    revision: Number(row.record_revision),
    contentHash: readString(row, "payload_hash"),
    committedAt: readString(row, "committed_at"),
  };
  return operation === "deleted" ? { ...common, operation } : { ...common, operation, content: content! };
}
