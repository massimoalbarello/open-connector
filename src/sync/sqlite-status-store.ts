import type {
  ISyncStatusStore,
  SyncStoreStatus,
  SyncBindingCandidateError,
  SyncInstallationStatus,
} from "./status-store.ts";
import type { SyncInstallation, SyncRun } from "./sync-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { readString } from "../server/storage/runtime-sql.ts";

interface StatusReaders {
  installation(id: string): SyncInstallation | undefined;
  run(id: string): SyncRun | undefined;
}

/** Monitoring queries do not participate in scheduling decisions or record commits. */
export class SqliteSyncStatusStore implements ISyncStatusStore {
  private readonly database: DatabaseSync;
  private readonly readers: StatusReaders;

  constructor(database: DatabaseSync, readers: StatusReaders) {
    this.database = database;
    this.readers = readers;
  }

  async read(): Promise<SyncStoreStatus> {
    const installations: SyncInstallationStatus[] = this.database
      .prepare(`select i.id, c.connection_name,
        case when c.id is null then 'missing' when c.revision is not i.credential_revision then 'changed' else 'connected' end as connection_status,
        (select id from sync_runs where installation_id = i.id order by started_at desc, id desc limit 1) as latest_run_id,
        (select count(*) from sync_records where installation_id = i.id and deleted_at is null) as record_count,
        coalesce(d.delivered, 0) as delivered_count, coalesce(d.pending, 0) as pending_count
        from sync_installations i left join connections c on c.id = i.connection_id
        left join (
          select ch.installation_id, sum(o.state = 'delivered') as delivered, sum(o.state != 'delivered') as pending
          from sync_changes ch join sync_outbox o on o.change_sequence = ch.sequence
          join sync_receivers r on r.id = o.sink_id group by ch.installation_id
        ) d on d.installation_id = i.id order by i.created_at, i.id`)
      .all()
      .map((row) => ({
        ...this.readers.installation(readString(row, "id"))!,
        connectionName: row.connection_name === null ? undefined : readString(row, "connection_name"),
        connectionStatus: readString(row, "connection_status") as SyncInstallationStatus["connectionStatus"],
        latestRun: row.latest_run_id === null ? undefined : this.readers.run(readString(row, "latest_run_id")),
        recordCount: Number(row.record_count),
        deliveredCount: Number(row.delivered_count),
        pendingCount: Number(row.pending_count),
      }));
    const runs = this.database
      .prepare("select id from sync_runs order by started_at desc, id desc limit 100")
      .all()
      .map((row) => this.readers.run(readString(row, "id"))!);
    const bindingErrors: SyncBindingCandidateError[] = this.database
      .prepare(
        `select b.*, c.connection_name from sync_binding_checks b join connections c on c.id = b.connection_id where b.last_error is not null and b.credential_revision = c.revision order by b.next_attempt_at`,
      )
      .all()
      .map((row) => ({
        connectionId: readString(row, "connection_id"),
        connectionName: readString(row, "connection_name"),
        credentialRevision: readString(row, "credential_revision"),
        definitionId: readString(row, "definition_id"),
        errorCode: readString(row, "last_error"),
        nextAttemptAt: readString(row, "next_attempt_at"),
      }));
    return { installations, runs, bindingErrors };
  }
}
