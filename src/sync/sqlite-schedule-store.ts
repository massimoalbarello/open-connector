import type {
  ConfigureSyncScheduleInput,
  FailedSyncPollInput,
  ScheduledSyncInstallation,
  ISyncScheduleStore,
  SyncBindingCandidate,
  SyncScheduleResult,
} from "./schedule-store.ts";
import type { SyncDefinition } from "./sync-definition.ts";
import type { JsonObject, SyncInstallation } from "./sync-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { parseJson, readString } from "../server/storage/runtime-sql.ts";
import { runSyncTransaction } from "./sqlite-sync-transaction.ts";
import { SyncStoreError } from "./sync-store.ts";

interface ScheduleReaders {
  installation(id: string): SyncInstallation | undefined;
}

/** Cadence belongs to the logical source; failed identity checks belong to a credential revision. */
export class SqliteSyncScheduleStore implements ISyncScheduleStore {
  private readonly database: DatabaseSync;
  private readonly readers: ScheduleReaders;
  constructor(database: DatabaseSync, readers: ScheduleReaders) {
    this.database = database;
    this.readers = readers;
  }

  reconcile(definitions: readonly SyncDefinition[], now: string): void {
    runSyncTransaction(this.database, () => {
      this.database
        .prepare(
          "delete from sync_binding_checks where not exists(select 1 from connections c where c.id = sync_binding_checks.connection_id)",
        )
        .run();
      for (const row of this.database
        .prepare("select id, definition_id, definition_version from sync_installations where state = 'enabled'")
        .all()) {
        if (
          !definitions.some(
            (definition) => definition.id === row.definition_id && definition.version === row.definition_version,
          )
        )
          this.database
            .prepare(
              "update sync_installations set state = 'needs_attention', last_error = 'definition_unavailable' where id = ?",
            )
            .run(readString(row, "id"));
      }
      for (const definition of definitions) {
        this.database
          .prepare(
            "update sync_installations set schedule_seconds = coalesce(schedule_seconds, ?), next_due_at = coalesce(next_due_at, ?) where definition_id = ? and definition_version = ? and (schedule_seconds is null or next_due_at is null)",
          )
          .run(definition.scheduleSeconds, now, definition.id, definition.version);
      }
    });
  }

  bindingDue(definitions: readonly SyncDefinition[], now: string): SyncBindingCandidate | undefined {
    if (this.database.prepare("select 1 from sync_runs where state = 'running'").get()) return undefined;
    for (const definition of definitions) {
      const row = this.database
        .prepare(`select c.id, c.connection_name, c.revision, (select config_value from sync_installations i where i.connection_id = c.id and i.definition_id = ? order by i.updated_at desc limit 1) as config from connections c
        left join sync_binding_checks b on b.connection_id = c.id and b.definition_id = ?
        where c.service = ? and not exists(select 1 from sync_installations i where i.connection_id = c.id and i.definition_id = ? and i.state = 'disabled') and (b.connection_id is null or b.credential_revision != c.revision or b.next_attempt_at <= ?)
        and not exists(select 1 from sync_installations i where i.definition_id = ? and i.connection_id = c.id and i.credential_revision = c.revision)
        order by coalesce(b.next_attempt_at, ''), c.connection_name limit 1`)
        .get(definition.id, definition.id, definition.provider, definition.id, now, definition.id);
      if (row)
        return {
          config: row.config === null ? undefined : parseJson<JsonObject>(readString(row, "config")),
          definitionId: definition.id,
          connectionId: readString(row, "id"),
          connectionName: readString(row, "connection_name"),
          credentialRevision: readString(row, "revision"),
        };
    }
    return undefined;
  }

  bindingFailed(candidate: SyncBindingCandidate, errorCode: string, now: string): void {
    if (
      this.database
        .prepare(
          "select 1 from sync_installations where connection_id = ? and definition_id = ? and credential_revision = ?",
        )
        .get(candidate.connectionId, candidate.definitionId, candidate.credentialRevision)
    ) {
      this.bindingSucceeded(candidate);
      return;
    }
    const previous = this.database
      .prepare(
        "select attempt_count, credential_revision from sync_binding_checks where connection_id = ? and definition_id = ?",
      )
      .get(candidate.connectionId, candidate.definitionId);
    const attempt =
      previous?.credential_revision === candidate.credentialRevision ? Number(previous.attempt_count) + 1 : 1;
    this.database
      .prepare(`insert into sync_binding_checks(connection_id, definition_id, credential_revision, attempt_count, next_attempt_at, last_error) values (?, ?, ?, ?, ?, ?)
      on conflict(connection_id, definition_id) do update set credential_revision = excluded.credential_revision, attempt_count = excluded.attempt_count, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error`)
      .run(
        candidate.connectionId,
        candidate.definitionId,
        candidate.credentialRevision,
        attempt,
        retryTime(now, attempt),
        errorCode,
      );
  }

  bindingSucceeded(candidate: SyncBindingCandidate): void {
    // A second alias may resolve to an already owned source; avoid repeatedly switching its credential.
    this.database
      .prepare(`insert into sync_binding_checks(connection_id, definition_id, credential_revision, next_attempt_at) values (?, ?, ?, '9999-01-01T00:00:00.000Z')
      on conflict(connection_id, definition_id) do update set credential_revision = excluded.credential_revision, next_attempt_at = excluded.next_attempt_at, attempt_count = 0, last_error = null`)
      .run(candidate.connectionId, candidate.definitionId, candidate.credentialRevision);
  }

  due(now: string): ScheduledSyncInstallation | undefined {
    if (this.database.prepare("select 1 from sync_runs where state = 'running'").get()) return undefined;
    const row = this.database
      .prepare(`select i.id, c.connection_name from sync_installations i join connections c on c.id = i.connection_id and c.revision = i.credential_revision
      where i.state = 'enabled' and i.requires_backfill = 0 and i.next_due_at <= ? order by i.next_due_at, i.id limit 1`)
      .get(now);
    return row
      ? {
          installation: this.readers.installation(readString(row, "id"))!,
          connectionName: readString(row, "connection_name"),
        }
      : undefined;
  }

  complete(input: SyncScheduleResult): void {
    const installation = this.readers.installation(input.installationId);
    if (!installation || installation.bindingRevision !== input.bindingRevision) return;
    const waiting = input.errorCode === "destination_required";
    const failures = waiting
      ? installation.consecutiveFailures
      : input.succeeded
        ? 0
        : installation.consecutiveFailures + 1;
    const next = waiting
      ? input.now
      : input.succeeded
        ? new Date(
            Date.parse(input.now) + (input.complete ? (installation.scheduleSeconds ?? 900) * 1000 : 1000),
          ).toISOString()
        : retryTime(input.now, failures);
    this.database
      .prepare(
        `update sync_installations set consecutive_failures = ?, last_error = case when requires_backfill = 1 then 'snapshot_interrupted' else ? end, next_due_at = ? where id = ? and binding_revision = ?`,
      )
      .run(failures, waiting ? null : (input.errorCode ?? null), next, input.installationId, input.bindingRevision);
  }

  failBeforeRun(input: FailedSyncPollInput): void {
    runSyncTransaction(this.database, () => {
      const installation = this.readers.installation(input.installation.id);
      if (
        !installation ||
        installation.state !== "enabled" ||
        installation.bindingRevision !== input.installation.bindingRevision ||
        installation.nextDueAt !== input.installation.nextDueAt ||
        this.database
          .prepare("select 1 from sync_runs where installation_id = ? and started_at >= ?")
          .get(installation.id, input.startedAt)
      )
        return;
      const id = randomUUIDv7();
      this.database
        .prepare(`insert into sync_runs (
          id, installation_id, definition_version, reason, state, lease_owner,
          lease_generation, lease_expires_at, checkpoint_revision, binding_revision,
          started_at, completed_at, error_code, error_message
        ) values (?, ?, ?, 'schedule', 'failed', ?, 1, ?,
          coalesce((select revision from sync_checkpoints where installation_id = ?), 0), ?, ?, ?, ?, ?)`)
        .run(
          id,
          installation.id,
          installation.definitionVersion,
          id,
          input.completedAt,
          installation.id,
          installation.bindingRevision,
          input.startedAt,
          input.completedAt,
          input.errorCode,
          "Polling failed before acquisition started; committed progress is retained.",
        );
      this.complete({
        installationId: installation.id,
        bindingRevision: installation.bindingRevision,
        succeeded: false,
        complete: false,
        errorCode: input.errorCode,
        now: input.completedAt,
      });
    });
  }

  recover(now: string): number {
    return runSyncTransaction(this.database, () => {
      this.database
        .prepare(`update sync_installations set state = 'needs_attention', requires_backfill = 1, last_error = 'snapshot_interrupted'
        where exists(select 1 from sync_snapshots s join sync_runs r on r.id = s.run_id where s.installation_id = sync_installations.id and s.state = 'active' and r.state = 'running' and r.lease_expires_at <= ?)`)
        .run(now);
      this.database
        .prepare(`update sync_snapshots set state = 'abandoned', completed_at = ? where state = 'active'
        and exists(select 1 from sync_runs r where r.id = sync_snapshots.run_id and r.state = 'running' and r.lease_expires_at <= ?)`)
        .run(now, now);
      const expired = this.database
        .prepare("select installation_id from sync_runs where state = 'running' and lease_expires_at <= ?")
        .all(now);
      this.database
        .prepare(
          "update sync_runs set state = 'lease_expired', completed_at = ?, error_code = 'lease_expired', error_message = 'Worker lease expired; committed progress is retained.' where state = 'running' and lease_expires_at <= ?",
        )
        .run(now, now);
      for (const row of expired)
        this.database
          .prepare(
            "update sync_installations set next_due_at = ?, last_error = coalesce(last_error, 'lease_expired') where id = ?",
          )
          .run(now, readString(row, "installation_id"));
      return expired.length;
    });
  }

  configure(input: ConfigureSyncScheduleInput): void {
    runSyncTransaction(this.database, () => this.updateSchedule(input, new Date().toISOString()));
  }

  remove(installationId: string): void {
    const now = new Date().toISOString();
    runSyncTransaction(this.database, () => {
      this.updateSchedule({ installationId, enabled: false }, now);
      this.database.prepare("update sync_installations set removed_at = ? where id = ?").run(now, installationId);
    });
  }

  private updateSchedule(input: ConfigureSyncScheduleInput, now: string): void {
    if (
      typeof input.enabled !== "boolean" ||
      (input.scheduleSeconds !== undefined &&
        (!Number.isInteger(input.scheduleSeconds) || input.scheduleSeconds < 60 || input.scheduleSeconds > 86400))
    )
      throw new SyncStoreError("invalid_input", "Schedule interval must be between 60 and 86400 seconds.");
    const installation = this.readers.installation(input.installationId);
    if (!installation || (installation.removedAt && !input.restore))
      throw new SyncStoreError("installation_not_found", "Sync installation not found.");
    if (input.enabled && installation.requiresBackfill)
      throw new SyncStoreError("invalid_input", "Interrupted snapshot requires an explicit backfill run.");
    this.database
      .prepare(
        "update sync_installations set state = ?, schedule_seconds = ?, next_due_at = ?, updated_at = ?, removed_at = null where id = ?",
      )
      .run(
        input.enabled ? "enabled" : "disabled",
        input.scheduleSeconds ?? installation.scheduleSeconds ?? 900,
        now,
        now,
        input.installationId,
      );
    if (!input.enabled) {
      this.database
        .prepare(
          "update sync_installations set requires_backfill = 1 where id = ? and exists(select 1 from sync_snapshots where installation_id = ? and state = 'active')",
        )
        .run(input.installationId, input.installationId);
      this.database
        .prepare(
          "update sync_runs set state = 'cancelled', completed_at = ?, error_code = 'installation_disabled' where installation_id = ? and state = 'running'",
        )
        .run(now, input.installationId);
      this.database
        .prepare(
          "update sync_snapshots set state = 'abandoned', completed_at = ? where installation_id = ? and state = 'active'",
        )
        .run(now, input.installationId);
    }
  }

  requestRun(installationId: string): void {
    const installation = this.readers.installation(installationId);
    if (!installation || installation.removedAt)
      throw new SyncStoreError("installation_not_found", "Sync installation not found.");
    if (
      this.database
        .prepare("select 1 from sync_runs where installation_id = ? and state = 'running'")
        .get(installationId)
    )
      throw new SyncStoreError("run_busy", "This sync is already running.");
    this.configure({ installationId, enabled: true });
  }
}

function retryTime(now: string, failures: number): string {
  return new Date(Date.parse(now) + Math.min(3600_000, 30_000 * 2 ** Math.min(failures - 1, 7))).toISOString();
}
