import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RuntimeRow } from "../server/storage/runtime-sql.ts";
import type {
  CompleteSyncDeliveryInput,
  ISyncDeliveryStore,
  SyncDeliveryEnvelope,
  SyncDeliveryLease,
  SyncDeliveryRecord,
  SyncDestinationInput,
  SyncDestination,
  SyncDeliveryStatus,
} from "./delivery-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { assertPublicHttpUrl } from "../core/request.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { parseJson, readString } from "../server/storage/runtime-sql.ts";
import { maximumDeliveryBytes } from "./delivery-store.ts";
import { runSyncTransaction } from "./sqlite-sync-transaction.ts";
import { SyncStoreError } from "./sync-store.ts";

/** Durable membership, attempts and ACKs. No transaction spans encryption or network I/O. */
export class SqliteSyncDeliveryStore implements ISyncDeliveryStore {
  private readonly database: DatabaseSync;
  private readonly codec: ISecretCodec;

  constructor(database: DatabaseSync, codec: ISecretCodec) {
    this.database = database;
    this.codec = codec;
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
    const url = assertPublicHttpUrl(input.url, {
      fieldName: "Destination URL",
      createError: (message) => new SyncStoreError("invalid_input", message),
    });
    if (url.protocol !== "https:" || url.hash)
      throw new SyncStoreError("invalid_input", "The destination requires public HTTPS without a fragment.");
    const secret = await this.codec.encode(input.bearerToken);
    const now = new Date().toISOString();
    runSyncTransaction(this.database, () => {
      this.database
        .prepare(`insert into sync_destination(id, url, bearer_secret, enabled) values (1, ?, ?, ?)
        on conflict(id) do update set url = excluded.url, bearer_secret = excluded.bearer_secret, enabled = excluded.enabled`)
        .run(url.toString(), secret, Number(input.enabled));
      this.releaseBatches(now);
    });
  }

  remove(): void {
    runSyncTransaction(this.database, () => {
      this.database.prepare("delete from sync_destination").run();
      this.releaseBatches(new Date().toISOString());
    });
  }

  getDestination(): SyncDestination | undefined {
    const row = this.database.prepare("select url, enabled from sync_destination where id = 1").get();
    return row ? { url: readString(row, "url"), enabled: row.enabled === 1 } : undefined;
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
  private releaseBatches(now: string): void {
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
          where o.state = 'pending' and o.batch_id is null order by c.sequence limit 50`)
          .iterate();
        const envelope: SyncDeliveryEnvelope = { version: 1, batchId: id, records: [] };
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
      const rows = this.database
        .prepare(`select c.*, i.source_id from sync_outbox o join sync_changes c on c.sequence = o.change_sequence
        join sync_installations i on i.id = c.installation_id where o.batch_id = ? order by c.sequence`)
        .all(id);
      const envelope: SyncDeliveryEnvelope = { version: 1, batchId: id, records: rows.map(readDeliveryRecord) };
      return {
        id,
        owner,
        generation,
        attempt,
        url: readString(destination, "url"),
        bearerToken: readString(destination, "bearer_secret"),
        body: JSON.stringify(envelope),
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
    return claimed;
  }

  complete(input: CompleteSyncDeliveryInput): void {
    runSyncTransaction(this.database, () => {
      const { lease, now } = input;
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
  const content = parseJson<SyncDeliveryRecord["content"]>(readString(row, "payload")) ?? undefined;
  if (operation !== "deleted" && !content)
    throw new SyncStoreError("invalid_input", "Pending delivery payload is unavailable.");
  return {
    eventId: readString(row, "event_id"),
    provider: readString(row, "provider"),
    sourceId: readString(row, "source_id"),
    kind: readString(row, "model"),
    id: readString(row, "record_id"),
    revision: Number(row.record_revision),
    operation,
    contentHash: readString(row, "payload_hash"),
    content: operation === "deleted" ? undefined : content,
    committedAt: readString(row, "committed_at"),
  };
}
