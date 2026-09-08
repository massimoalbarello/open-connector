import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RuntimeRow } from "../server/storage/runtime-sql.ts";
import type {
  CompleteSyncDeliveryInput,
  ISyncDeliveryStore,
  SyncDeliveryEnvelope,
  SyncDeliveryLease,
  SyncDeliveryRecord,
  SyncReceiverInput,
  SyncReceiverStatus,
  SyncRunDelivery,
  UpdateSyncReceiverInput,
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

  async register(input: SyncReceiverInput): Promise<void> {
    if (!input.url || !input.bearerToken || typeof input.enabled !== "boolean")
      throw new SyncStoreError("invalid_input", "Receiver URL, Bearer token and enabled flag are required.");
    await this.configure(input, false);
  }

  async update(input: UpdateSyncReceiverInput): Promise<void> {
    await this.configure(input, true);
  }

  private async configure(input: UpdateSyncReceiverInput, requireExisting: boolean): Promise<void> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.id) ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      (input.bearerToken !== undefined &&
        (!input.bearerToken || input.bearerToken.length > 8192 || /\s/.test(input.bearerToken)))
    )
      throw new SyncStoreError("invalid_input", "Invalid receiver ID, enabled flag or Bearer token.");
    const url =
      input.url === undefined
        ? undefined
        : assertPublicHttpUrl(input.url, {
            fieldName: "Receiver URL",
            createError: (message) => new SyncStoreError("invalid_input", message),
          });
    if (url && (url.protocol !== "https:" || url.hash))
      throw new SyncStoreError("invalid_input", "Receivers require public HTTPS without a fragment.");
    const secret = input.bearerToken === undefined ? undefined : await this.codec.encode(input.bearerToken);
    const now = new Date().toISOString();
    runSyncTransaction(this.database, () => {
      const existing = this.database
        .prepare("select r.*, s.enabled from sync_receivers r join sync_sinks s on s.id = r.id where r.id = ?")
        .get(input.id);
      if (existing?.removed_at)
        throw new SyncStoreError("invalid_input", "This destination ID was removed. Use a new destination ID.");
      if (requireExisting && !existing) throw new SyncStoreError("receiver_not_found", "Destination not found.");
      if (!existing && (!url || !secret || input.enabled === undefined))
        throw new SyncStoreError("invalid_input", "Receiver URL, Bearer token and enabled flag are required.");
      this.database
        .prepare(
          "insert into sync_sinks(id, kind, enabled, created_at, updated_at) values (?, 'http', ?, ?, ?) on conflict(id) do update set enabled = excluded.enabled, updated_at = excluded.updated_at",
        )
        .run(input.id, Number(input.enabled ?? existing?.enabled === 1), now, now);
      this.database
        .prepare(
          "insert into sync_receivers(id, url, bearer_secret) values (?, ?, ?) on conflict(id) do update set url = excluded.url, bearer_secret = excluded.bearer_secret",
        )
        .run(
          input.id,
          url?.toString() ?? readString(existing!, "url"),
          secret ?? readString(existing!, "bearer_secret"),
        );
      // Reconfiguration fences an old worker's ACK while preserving stable batch membership.
      this.database
        .prepare(
          "update sync_delivery_batches set state = 'pending', lease_generation = lease_generation + 1, next_attempt_at = ?, lease_expires_at = null where sink_id = ? and state != 'delivered' and cancelled_at is null",
        )
        .run(now, input.id);
      this.database
        .prepare(
          "update sync_outbox set state = 'pending', next_attempt_at = ? where sink_id = ? and state in ('pending', 'leased')",
        )
        .run(now, input.id);
    });
  }

  remove(id: string): void {
    const now = new Date().toISOString();
    runSyncTransaction(this.database, () => {
      if (!this.database.prepare("select 1 from sync_receivers where id = ? and removed_at is null").get(id))
        throw new SyncStoreError("receiver_not_found", "Destination not found.");
      this.database.prepare("update sync_sinks set enabled = 0, updated_at = ? where id = ?").run(now, id);
      this.database.prepare("update sync_receivers set removed_at = ?, bearer_secret = '' where id = ?").run(now, id);
      this.database
        .prepare(
          "update sync_delivery_attempts set completed_at = ?, error_code = 'receiver_removed' where completed_at is null and batch_id in (select id from sync_delivery_batches where sink_id = ?)",
        )
        .run(now, id);
      this.database
        .prepare(
          "update sync_delivery_batches set cancelled_at = ?, lease_generation = lease_generation + 1, lease_expires_at = null, last_error = 'receiver_removed' where sink_id = ? and state != 'delivered'",
        )
        .run(now, id);
      this.database
        .prepare(
          "update sync_outbox set state = 'dead', last_error = 'receiver_removed', lease_expires_at = null where sink_id = ? and state != 'delivered'",
        )
        .run(id);
      this.database
        .prepare("update sync_installations set bootstrap_receiver_id = null where bootstrap_receiver_id = ?")
        .run(id);
      this.purge();
    });
  }

  runStatus(runId: string): SyncRunDelivery {
    const row = this.database
      .prepare(`select count(*) as total,
      coalesce(sum(o.state = 'delivered'), 0) as delivered,
      coalesce(sum(o.state in ('pending', 'leased')), 0) as pending,
      coalesce(sum(o.state = 'dead'), 0) as cancelled,
      coalesce(sum(o.state = 'leased'), 0) as leased,
      max(case when o.state = 'pending' then o.last_error end) as last_error,
      min(case when o.state = 'pending' and s.enabled = 1 then o.next_attempt_at end) as next_attempt_at,
      max(o.delivered_at) as last_delivered_at
      from sync_outbox o join sync_receivers r on r.id = o.sink_id join sync_sinks s on s.id = r.id where o.run_id = ?`)
      .get(runId)!;
    const total = Number(row.total),
      pending = Number(row.pending),
      cancelled = Number(row.cancelled);
    return {
      state:
        total === 0
          ? "none"
          : Number(row.leased) > 0
            ? "delivering"
            : pending > 0
              ? row.last_error
                ? "retrying"
                : "pending"
              : cancelled > 0
                ? "cancelled"
                : "delivered",
      totalRecords: total,
      deliveredRecords: Number(row.delivered),
      pendingRecords: pending,
      cancelledRecords: cancelled,
      lastError: row.last_error === null ? undefined : readString(row, "last_error"),
      nextAttemptAt: row.next_attempt_at === null ? undefined : readString(row, "next_attempt_at"),
      lastDeliveredAt: row.last_delivered_at === null ? undefined : readString(row, "last_delivered_at"),
    };
  }

  async list(): Promise<SyncReceiverStatus[]> {
    return this.database
      .prepare(`select r.id, r.url, s.enabled,
      (select count(*) from sync_outbox where sink_id = r.id and state in ('pending', 'leased')) as pending,
      (select count(*) from sync_outbox where sink_id = r.id and state = 'delivered') as delivered,
      (select max(delivered_at) from sync_delivery_batches where sink_id = r.id) as last_delivered_at,
      b.last_error, b.next_attempt_at, b.attempt_count from sync_receivers r join sync_sinks s on s.id = r.id
      left join sync_delivery_batches b on b.sink_id = r.id and b.state != 'delivered' and b.cancelled_at is null where r.removed_at is null order by r.id`)
      .all()
      .map((row) => ({
        id: readString(row, "id"),
        url: readString(row, "url"),
        enabled: row.enabled === 1,
        pendingRecords: Number(row.pending),
        deliveredRecords: Number(row.delivered),
        lastDeliveredAt: row.last_delivered_at === null ? undefined : String(row.last_delivered_at),
        attemptCount: Number(row.attempt_count ?? 0),
        lastError: row.last_error === null ? undefined : String(row.last_error),
        nextAttemptAt: row.next_attempt_at === null ? undefined : String(row.next_attempt_at),
      }));
  }

  async claim(now: string): Promise<SyncDeliveryLease | undefined> {
    const claimed = runSyncTransaction(this.database, () => {
      let batch = this.database
        .prepare(`select b.* from sync_delivery_batches b join sync_sinks s on s.id = b.sink_id
        where s.enabled = 1 and b.state != 'delivered' and b.cancelled_at is null and b.next_attempt_at <= ?
        and (b.state = 'pending' or b.lease_expires_at <= ?) order by b.next_attempt_at, b.id limit 1`)
        .get(now, now);
      if (!batch) {
        const sink = this.database
          .prepare(`select s.id from sync_sinks s join sync_receivers r on r.id = s.id
          where s.enabled = 1 and exists(select 1 from sync_outbox o where o.sink_id = s.id and o.state = 'pending' and o.batch_id is null)
          and not exists(select 1 from sync_delivery_batches b where b.sink_id = s.id and b.state != 'delivered' and b.cancelled_at is null) order by coalesce((select max(delivered_at) from sync_delivery_batches b where b.sink_id = s.id), ''), s.id limit 1`)
          .get();
        if (!sink) return undefined;
        const id = randomUUIDv7();
        const rows = this.database
          .prepare(`select c.*, i.source_id from sync_outbox o join sync_changes c on c.sequence = o.change_sequence
          join sync_installations i on i.id = c.installation_id
          where o.sink_id = ? and o.state = 'pending' and o.batch_id is null order by c.sequence limit 50`)
          .iterate(readString(sink, "id"));
        const envelope: SyncDeliveryEnvelope = { version: 1, batchId: id, records: [] };
        const selected: number[] = [];
        for (const row of rows) {
          envelope.records.push(readDeliveryRecord(row));
          if (Buffer.byteLength(JSON.stringify(envelope)) > maximumDeliveryBytes) {
            envelope.records.pop();
            break;
          }
          selected.push(Number(row.sequence));
        }
        if (!selected.length) throw new SyncStoreError("invalid_input", "Pending record exceeds delivery byte limit.");
        this.database
          .prepare(
            "insert into sync_delivery_batches(id, sink_id, state, next_attempt_at, created_at) values (?, ?, 'pending', ?, ?)",
          )
          .run(id, readString(sink, "id"), now, now);
        for (const sequence of selected)
          this.database
            .prepare("update sync_outbox set batch_id = ? where sink_id = ? and change_sequence = ?")
            .run(id, readString(sink, "id"), sequence);
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
      const receiver = this.database
        .prepare("select * from sync_receivers where id = ?")
        .get(readString(batch, "sink_id"))!;
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
        url: readString(receiver, "url"),
        bearerToken: readString(receiver, "bearer_secret"),
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
        where id = ? and state = 'leased' and cancelled_at is null and lease_owner = ? and lease_generation = ? and lease_expires_at > ?`)
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

  /** Retain compact metadata forever; bodies only while some intended receiver still owes an ACK. */
  purge(): void {
    this.database
      .prepare(`update sync_changes set payload = 'null' where payload != 'null'
      and not exists(select 1 from sync_outbox o where o.change_sequence = sync_changes.sequence and o.state in ('pending', 'leased'))`)
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
