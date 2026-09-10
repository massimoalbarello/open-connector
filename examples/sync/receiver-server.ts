import type { SyncDeliveryEnvelope, SyncDeliveryRecord } from "../../src/sync/delivery-store.ts";

import { Validator } from "@cfworker/json-schema";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { maximumDeliveryBytes } from "../../src/sync/delivery-store.ts";
import { recordDeliveryEnvelopeSchema } from "../../src/sync/record-delivery-contract.generated.ts";

interface LoggingReceiverOptions {
  databasePath: string;
  bearerToken: string;
  port?: number;
  onRecord(record: SyncDeliveryRecord): void;
}
interface LoggingReceiver {
  url: string;
  close(): Promise<void>;
}
const envelopeValidator = new Validator(recordDeliveryEnvelopeSchema, "2020-12", false);

/** A small durable logging receiver: persist/deduplicate a whole batch before returning 200. */
export async function startLoggingReceiver(options: LoggingReceiverOptions): Promise<LoggingReceiver> {
  if (!options.bearerToken) throw new Error("Receiver Bearer token is required.");
  const database = new DatabaseSync(options.databasePath);
  database.exec(`pragma journal_mode = wal; pragma synchronous = full;
    create table if not exists receipts(batch_id text primary key, body_hash text not null, body text not null);
    create table if not exists records(source_id text, kind text, record_id text, revision integer not null, content_hash text not null, value text not null, primary key(source_id, kind, record_id));
    create table if not exists events(event_id text primary key);`);
  const authorization = Buffer.from(`Bearer ${options.bearerToken}`);
  const server = createServer(async (request, response) => {
    const presented = Buffer.from(request.headers.authorization ?? "");
    if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) {
      response.writeHead(401).end();
      request.resume();
      return;
    }
    if (request.method !== "POST" || request.url !== "/records") {
      response.writeHead(404).end();
      request.resume();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maximumDeliveryBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = JSON.parse(body);
      if (!envelopeValidator.validate(parsed).valid) throw new Error("Invalid record delivery envelope.");
      const envelope = parsed as SyncDeliveryEnvelope;
      const hash = createHash("sha256").update(body).digest("hex");
      const receipt = database.prepare("select body_hash from receipts where batch_id = ?").get(envelope.batchId);
      if (receipt) {
        response.writeHead(receipt.body_hash === hash ? 200 : 409).end();
        return;
      }
      const changed: SyncDeliveryRecord[] = [];
      database.exec("begin immediate");
      try {
        for (const record of envelope.records) {
          if (record.operation !== "deleted" && !record.content) throw new Error("Missing upsert content");
          if (database.prepare("select 1 from events where event_id = ?").get(record.eventId)) continue;
          const current = database
            .prepare("select revision, content_hash from records where source_id = ? and kind = ? and record_id = ?")
            .get(record.sourceId, record.kind, record.id);
          if (current && Number(current.revision) === record.revision && current.content_hash !== record.contentHash)
            throw new Error("Conflicting revision");
          if (!current || Number(current.revision) < record.revision) {
            database
              .prepare(
                "insert into records values (?, ?, ?, ?, ?, ?) on conflict(source_id, kind, record_id) do update set revision = excluded.revision, content_hash = excluded.content_hash, value = excluded.value",
              )
              .run(
                record.sourceId,
                record.kind,
                record.id,
                record.revision,
                record.contentHash,
                JSON.stringify(record),
              );
            changed.push(record);
          }
          database.prepare("insert into events values (?)").run(record.eventId);
        }
        database.prepare("insert into receipts values (?, ?, ?)").run(envelope.batchId, hash, body);
        database.exec("commit");
      } catch (error) {
        database.exec("rollback");
        throw error;
      }
      for (const record of changed) options.onRecord(record);
      response.writeHead(200).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Receiver did not start.");
  return {
    url: `http://127.0.0.1:${address.port}/records`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      database.close();
    },
  };
}
