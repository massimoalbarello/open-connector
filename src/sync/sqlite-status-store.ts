import type { ISyncStatusStore, SyncStoreStatus, SyncBindingCandidateError } from "./status-store.ts";
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
    const installations = this.database
      .prepare("select id from sync_installations order by created_at, id")
      .all()
      .map((row) => this.readers.installation(readString(row, "id"))!);
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
