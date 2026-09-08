import type { SyncDefinitionContract } from "./record-contract.ts";
import type { BindSyncSourceInput, ISyncSourceStore } from "./source-binding.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { normalizeSourceTimestamp } from "./record-contract.ts";
import { canonicalizeJsonObject } from "./record-hash.ts";
import { runSyncTransaction } from "./sqlite-sync-transaction.ts";
import { SyncStoreError } from "./sync-store.ts";

/** Verified logical accounts and their replaceable credential bindings. No provider I/O here. */
export class SqliteSyncSourceStore implements ISyncSourceStore {
  private readonly database: DatabaseSync;
  private readonly definitions: readonly SyncDefinitionContract[];

  constructor(database: DatabaseSync, definitions: readonly SyncDefinitionContract[]) {
    this.database = database;
    this.definitions = definitions;
  }

  // One database-wide epoch also fences automatic discovery of an existing source: its ID
  // is not known until provider verification finishes. Unrelated rebinds may require a retry.
  getBindingRevision(): number {
    return Number(this.database.prepare("select revision from sync_binding_state where id = 1").get()!.revision);
  }

  async bind(input: BindSyncSourceInput): Promise<string> {
    const definition = this.definitions.find((item) => item.id === input.definitionId);
    if (!definition || definition.provider !== input.provider || definition.version !== input.definitionVersion) {
      throw new SyncStoreError("invalid_input", "Binding must match a registered definition and version.");
    }
    const connection = input.verifiedConnection;
    const { accountId, authorizationBoundary } = connection.identity;
    for (const value of [accountId, authorizationBoundary, connection.id, connection.revision, input.id ?? "new"]) {
      if (typeof value !== "string" || !value.trim() || value.length > 1024)
        throw new SyncStoreError(
          "invalid_input",
          "Source identifiers must be non-empty strings of at most 1024 characters.",
        );
    }
    if (connection.service !== definition.provider)
      throw new SyncStoreError("invalid_input", "Connection provider does not match definition.");
    let config: ReturnType<typeof canonicalizeJsonObject>;
    try {
      config = canonicalizeJsonObject(input.config);
    } catch {
      throw new SyncStoreError("invalid_input", "Binding configuration must be a JSON object.");
    }
    let createdAt: string;
    try {
      createdAt = new Date(normalizeSourceTimestamp(input.createdAt)).toISOString();
    } catch {
      throw new SyncStoreError("invalid_input", "Invalid binding timestamp.");
    }
    return runSyncTransaction(this.database, () => {
      if (this.getBindingRevision() !== input.expectedBindingRevision)
        throw conflict("Source bindings changed during verification; retry.");
      if (
        !this.database
          .prepare("select id from connections where id = ? and service = ? and revision = ?")
          .get(connection.id, connection.service, connection.revision)
      ) {
        throw new SyncStoreError("credential_changed", "Credential changed during source verification; retry.");
      }
      let source = this.database
        .prepare("select id from sync_sources where provider = ? and account_id = ? and authorization_boundary = ?")
        .get(connection.service, accountId, authorizationBoundary);
      const target = input.id
        ? this.database.prepare("select * from sync_installations where id = ?").get(input.id)
        : undefined;
      if (target && (target.definition_id !== definition.id || target.provider !== definition.provider))
        throw conflict("Target belongs to a different definition or provider.");
      if (target && target.source_id !== source?.id)
        throw conflict("A different account or authorization boundary cannot inherit this binding.");
      if (!source) {
        const id = randomUUIDv7();
        this.database
          .prepare(
            "insert into sync_sources (id, provider, account_id, authorization_boundary, created_at) values (?, ?, ?, ?, ?)",
          )
          .run(id, definition.provider, accountId, authorizationBoundary, createdAt);
        source = { id };
      }
      const sourceId = String(source.id);
      const existing = this.database
        .prepare("select * from sync_installations where source_id = ? and definition_id = ?")
        .get(sourceId, definition.id);
      if (input.id && existing && input.id !== existing.id)
        throw conflict(
          "Multiple installations claim the same source and definition; explicit state resolution is required.",
        );
      const binding = target ?? existing;
      if (binding && (binding.definition_version !== definition.version || binding.config_value !== config.json))
        throw conflict("Definition version or configuration changed; migrate progress explicitly before rebinding.");
      const id = binding ? String(binding.id) : (input.id ?? randomUUIDv7());
      let allKindsBound = true;
      for (const kind of definition.kinds) {
        const owner = this.database
          .prepare("select installation_id from sync_source_kinds where source_id = ? and kind = ?")
          .get(sourceId, kind.kind);
        if (!owner) allKindsBound = false;
        if (owner && owner.installation_id !== id)
          throw conflict(`Kind ${kind.kind} already has an authoritative definition for this source.`);
      }
      if (
        allKindsBound &&
        binding?.source_id === sourceId &&
        binding.connection_id === connection.id &&
        binding.credential_revision === connection.revision
      )
        return id;
      const revision = input.expectedBindingRevision + 1;
      if (binding) {
        this.database
          .prepare(
            "update sync_installations set source_id = ?, connection_id = ?, credential_revision = ?, binding_revision = ?, updated_at = ? where id = ?",
          )
          .run(sourceId, connection.id, connection.revision, revision, createdAt, id);
        // Acquired pages from the previous credential must never commit under the new binding.
        this.database
          .prepare(
            "update sync_runs set state = 'cancelled', completed_at = ?, error_code = 'binding_changed' where installation_id = ? and state = 'running'",
          )
          .run(createdAt, id);
        this.database
          .prepare(
            "update sync_snapshots set state = 'abandoned', completed_at = ? where installation_id = ? and state = 'active'",
          )
          .run(createdAt, id);
      } else {
        this.database
          .prepare(
            `insert into sync_installations (id, definition_id, definition_version, provider, connection_id, config_value, state, created_at, updated_at, source_id, credential_revision, binding_revision) values (?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            definition.id,
            definition.version,
            definition.provider,
            connection.id,
            config.json,
            createdAt,
            createdAt,
            sourceId,
            connection.revision,
            revision,
          );
      }
      for (const kind of definition.kinds)
        this.database
          .prepare("insert or ignore into sync_source_kinds (source_id, kind, installation_id) values (?, ?, ?)")
          .run(sourceId, kind.kind, id);
      this.database.prepare("update sync_binding_state set revision = ? where id = 1").run(revision);
      return id;
    });
  }
}

function conflict(message: string): SyncStoreError {
  return new SyncStoreError("binding_conflict", message);
}
