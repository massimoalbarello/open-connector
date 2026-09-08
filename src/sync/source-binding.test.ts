import type { CredentialValidators, ResolvedCredential, VerifiedSourceIdentity } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { SyncDefinitionContract } from "./record-contract.ts";
import type { BindSyncSourceInput } from "./source-binding.ts";

import { mkdtemp, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { providerFetch } from "../providers/provider-runtime.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { SyncSourceBindingService } from "./source-binding.ts";

const definition: SyncDefinitionContract = {
  id: "test.records",
  version: "1",
  provider: "test",
  kinds: [{ kind: "record" }],
};
const identity: VerifiedSourceIdentity = { accountId: "native-123", authorizationBoundary: "workspace-456" };
const databases: SqliteRuntimeDatabase[] = [];
const directories: string[] = [];
const now = () => new Date().toISOString();

function credential(token = "first"): ResolvedCredential {
  return {
    authType: "api_key",
    apiKey: token,
    values: { apiKey: token },
    profile: { accountId: "reused-name", displayName: "Reused Name", grantedScopes: [] },
    metadata: {},
  };
}

async function fixture(validators: CredentialValidators = { apiKey: async () => ({ sourceIdentity: identity }) }) {
  const database = new SqliteRuntimeDatabase(":memory:", {
    syncDefinitions: [definition, { ...definition, id: "other.definition" }],
  });
  databases.push(database);
  await database.connectionStore.set("test", "default", credential());
  const loader: IProviderLoader = {
    loadActionExecutor: async () => undefined,
    loadProxyExecutor: async () => undefined,
    loadCredentialValidators: async () => validators,
  };
  const connections = new ConnectionService({
    catalog: createCatalogStore([
      {
        service: "test",
        displayName: "Test",
        categories: [],
        authTypes: ["api_key", "oauth2", "custom_credential"],
        auth: [],
        actions: [],
      },
    ]),
    store: database.connectionStore,
    providerLoader: loader,
    oauthCredentials: {
      refresh: async (_service, value) => ({
        ...value,
        accessToken: "refreshed",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    },
  });
  return { database, connections, service: new SyncSourceBindingService(connections, database.syncStore) };
}

const bindingInput = { provider: "test", definitionId: definition.id, definitionVersion: definition.version };

async function seed(database: SqliteRuntimeDatabase, installationId: string, runId = "run") {
  await database.syncStore.startRun({
    id: runId,
    installationId,
    definitionVersion: "1",
    reason: "manual",
    leaseOwner: "worker",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    startedAt: now(),
  });
  return database.syncStore.commitPage({
    installationId,
    runId,
    lease: { owner: "worker", generation: 1 },
    expectedCheckpointRevision: 0,
    nextCheckpoint: { cursor: "durable" },
    upserts: [{ kind: "record", record: { id: "large-9007199254740993123", body: "# Complete record" } }],
    committedAt: now(),
  });
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("verified source binding", () => {
  it("automatically reuses source state after replacing a credential handle and fences old work", async () => {
    const { database, service } = await fixture();
    const first = await service.bind(bindingInput);
    const saved = await seed(database, first.id);
    await database.connectionStore.delete("test", "default");
    const replacement = await database.connectionStore.set("test", "default", credential("replacement"));
    expect(replacement.id).not.toBe(first.connectionId);
    const rebound = await service.bind(bindingInput);
    expect(rebound.id).toBe(first.id);
    expect(rebound.sourceId).toBe(first.sourceId);
    expect(rebound.connectionId).toBe(replacement.id);
    expect(await database.syncStore.getCheckpoint(first.id)).toEqual(saved.checkpoint);
    expect((await database.syncStore.listChanges()).items).toEqual(saved.changes);
    await expect(
      database.syncStore.commitPage({
        installationId: first.id,
        runId: "run",
        lease: { owner: "worker", generation: 1 },
        expectedCheckpointRevision: 1,
        nextCheckpoint: null,
        committedAt: now(),
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await database.syncStore.startRun({
      id: "resumed",
      installationId: first.id,
      definitionVersion: "1",
      reason: "manual",
      leaseOwner: "worker",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: now(),
    });
    const same = await database.syncStore.commitPage({
      installationId: first.id,
      runId: "resumed",
      lease: { owner: "worker", generation: 1 },
      expectedCheckpointRevision: 1,
      nextCheckpoint: { cursor: "next" },
      upserts: [{ kind: "record", record: { id: "large-9007199254740993123", body: "# Complete record" } }],
      committedAt: now(),
    });
    expect(same.changes).toEqual([]);
    expect(await database.syncStore.getRecord(first.id, "record", "large-9007199254740993123")).toMatchObject({
      revision: 1,
      sourceId: first.sourceId,
      provider: "test",
      kind: "record",
    });
  });

  it("makes repeated verification of an unchanged binding a no-op", async () => {
    const { database, service } = await fixture();
    const first = await service.bind(bindingInput);
    await seed(database, first.id);
    const second = await service.bind(bindingInput);
    expect(second).toEqual(first);
    expect(database.syncStore.sources.getBindingRevision()).toBe(first.bindingRevision);
    expect((await database.syncStore.getRun("run"))?.state).toBe("running");
  });

  it.each(["account", "boundary", "deleted-alias"])(
    "isolates a changed %s even when names and aliases match",
    async (variant) => {
      let current = identity;
      const { database, service } = await fixture({ apiKey: async () => ({ sourceIdentity: current }) });
      const first = await service.bind(bindingInput);
      await seed(database, first.id);
      current =
        variant === "boundary"
          ? { ...identity, authorizationBoundary: "other-workspace" }
          : { ...identity, accountId: "other-account" };
      if (variant === "deleted-alias") await database.connectionStore.delete("test", "default");
      await database.connectionStore.set("test", "default", credential("other-account"));
      await expect(service.bind({ ...bindingInput, id: first.id })).rejects.toMatchObject({ code: "binding_conflict" });
      const other = await service.bind(bindingInput);
      expect(other.sourceId).not.toBe(first.sourceId);
      expect(other.id).not.toBe(first.id);
      expect(await database.syncStore.getCheckpoint(other.id)).toBeUndefined();
      expect(await database.syncStore.getRecord(other.id, "record", "large-9007199254740993123")).toBeUndefined();
      expect((await database.syncStore.getCheckpoint(first.id))?.revision).toBe(1);
    },
  );

  it("rejects credential replacement while remote verification is in flight", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { database, service } = await fixture({
      apiKey: async () => {
        started.resolve();
        await gate.promise;
        return { sourceIdentity: identity };
      },
    });
    const pending = service.bind(bindingInput);
    await started.promise;
    await database.connectionStore.set("test", "default", credential("changed"));
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "credential_changed" });
    expect(database.syncStore.sources.getBindingRevision()).toBe(0);
  });

  it("fences simultaneous bindings after both verified against the same binding revision", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const bothStarted = Promise.withResolvers<void>();
    let calls = 0;
    const { database, service } = await fixture({
      apiKey: async () => {
        const index = calls++;
        if (calls === 2) bothStarted.resolve();
        await gates[index]!.promise;
        return { sourceIdentity: identity };
      },
    });
    const first = service.bind(bindingInput);
    const second = service.bind(bindingInput);
    await bothStarted.promise;
    gates[0]!.resolve();
    await first;
    gates[1]!.resolve();
    await expect(second).rejects.toMatchObject({ code: "binding_conflict" });
    expect(database.syncStore.sources.getBindingRevision()).toBe(1);
  });

  it("refreshes OAuth through existing auth before verifying the exact stored revision", async () => {
    const oauth2 = vi.fn<NonNullable<CredentialValidators["oauth2"]>>(async () => ({ sourceIdentity: identity }));
    const { database, service } = await fixture({ oauth2 });
    await database.connectionStore.set("test", "default", {
      authType: "oauth2",
      tokenType: "Bearer",
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: "2000-01-01T00:00:00Z",
      profile: { accountId: "name", displayName: "Name", grantedScopes: [] },
      metadata: {},
    });
    const bound = await service.bind(bindingInput);
    expect(oauth2.mock.calls[0]?.[0]).toMatchObject({ accessToken: "refreshed" });
    expect(bound.credentialRevision).toBe((await database.connectionStore.get("test", "default"))?.revision);
    const before = await seed(database, bound.id);
    const stored = (await database.connectionStore.get("test", "default"))!;
    if (stored.credential.authType !== "oauth2") throw new Error("Expected OAuth.");
    await database.connectionStore.set("test", "default", { ...stored.credential, expiresAt: "2000-01-01T00:00:00Z" });
    const again = await service.bind(bindingInput);
    expect(again.sourceId).toBe(bound.sourceId);
    expect(await database.syncStore.getCheckpoint(again.id)).toEqual(before.checkpoint);
  });

  it("uses guarded validation without exposing credential material in verification evidence", async () => {
    const apiKey: NonNullable<CredentialValidators["apiKey"]> = vi.fn(async (_input, options) => {
      expect(options.fetcher).toBe(providerFetch);
      return { sourceIdentity: identity };
    });
    const { connections } = await fixture({ apiKey });
    const evidence = await connections.verifySourceConnection("test");
    expect(Object.keys(evidence).sort()).toEqual(["id", "identity", "revision", "service"]);
  });

  it.each([
    {},
    { profile: { accountId: "looks-native", displayName: "Name" } },
    { metadata: { accountId: "looks-native" } },
  ])("never promotes a stored/default profile to verified identity: %j", async (result) => {
    const { service } = await fixture({ apiKey: async () => result });
    await expect(service.bind(bindingInput)).rejects.toMatchObject({ code: "source_identity_unverified" });
  });

  it("rejects unknown definitions, conflicting kind owners, config changes, and blank identity", async () => {
    const { database, service } = await fixture();
    const bound = await service.bind(bindingInput);
    await expect(service.bind({ ...bindingInput, definitionId: "unknown" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.bind({ ...bindingInput, definitionId: "other.definition" })).rejects.toMatchObject({
      code: "binding_conflict",
    });
    await expect(service.bind({ ...bindingInput, config: { changed: true } })).rejects.toMatchObject({
      code: "binding_conflict",
    });
    expect((await database.syncStore.getInstallation(bound.id))?.sourceId).toBe(bound.sourceId);
    const blank = await fixture({ apiKey: async () => ({ sourceIdentity: { ...identity, accountId: " " } }) });
    await expect(blank.service.bind(bindingInput)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not bind when verification is cancelled", async () => {
    const controller = new AbortController();
    const { database, service } = await fixture({
      apiKey: async () => {
        controller.abort();
        return { sourceIdentity: identity };
      },
    });
    await expect(service.bind({ ...bindingInput, signal: controller.signal })).rejects.toMatchObject({
      code: "connection_cancelled",
    });
    expect(database.syncStore.sources.getBindingRevision()).toBe(0);
  });
});

describe("PR3 source migration", () => {
  it("preserves records, revisions, changes, outbox and checkpoint until explicitly resolving legacy ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sync-source-migration-"));
    directories.push(directory);
    const migrationDirectory = join(directory, "migrations");
    await mkdir(migrationDirectory);
    const original = new URL("../../migrations/", import.meta.url);
    for (const file of await readdir(original)) {
      if (file.endsWith(".sql") && file < "0014")
        await copyFile(new URL(file, original), join(migrationDirectory, file));
    }
    const path = join(directory, "legacy.sqlite");
    const legacy = new SqliteRuntimeDatabase(path, { migrationDirectory });
    const connection = await legacy.connectionStore.set("test", "default", credential());
    legacy.close();
    const sql = new DatabaseSync(path);
    const at = now();
    sql
      .prepare(
        `insert into sync_installations (id, definition_id, definition_version, provider, connection_id, config_value, state, created_at, updated_at) values ('legacy', 'test.records', '1', 'test', ?, '{}', 'enabled', ?, ?)`,
      )
      .run(connection.id, at, at);
    sql
      .prepare(
        `insert into sync_runs (id, installation_id, definition_version, reason, state, lease_owner, lease_generation, lease_expires_at, checkpoint_revision, started_at) values ('old-run', 'legacy', '1', 'manual', 'running', 'old-worker', 1, ?, 7, ?)`,
      )
      .run(new Date(Date.now() + 60_000).toISOString(), at);
    sql.prepare(`insert into sync_checkpoints values ('legacy', '1', 7, '{"cursor":"keep"}', 'old-run', ?)`).run(at);
    sql
      .prepare(
        `insert into sync_changes (sequence, event_id, installation_id, provider, connection_id, definition_id, definition_version, model, record_id, operation, record_revision, payload, payload_hash, run_id, committed_at) values (1, 'original-event', 'legacy', 'test', ?, 'test.records', '1', 'record', 'native-record', 'updated', 9, '{"body":"Legacy Markdown"}', 'original-hash', 'old-run', ?)`,
      )
      .run(connection.id, at);
    sql
      .prepare(
        `insert into sync_records (installation_id, model, record_id, payload, payload_hash, revision, created_sequence, last_change_sequence, first_seen_at, last_changed_at) values ('legacy', 'record', 'native-record', '{"body":"Legacy Markdown"}', 'original-hash', 9, 1, 1, ?, ?)`,
      )
      .run(at, at);
    sql.prepare(`insert into sync_sinks values ('receiver', 'http', 1, ?, ?)`).run(at, at);
    sql
      .prepare(
        `insert into sync_outbox (sink_id, change_sequence, state, next_attempt_at) values ('receiver', 1, 'pending', ?)`,
      )
      .run(at);
    sql
      .prepare(
        `insert into sync_snapshots values ('old-snapshot', 'legacy', 'old-run', '["record"]', 1, 'active', ?, null)`,
      )
      .run(at);
    // A second legacy installation makes duplicate-account resolution ambiguous.
    sql.exec(
      `insert into sync_installations select 'ambiguous', definition_id, definition_version, provider, connection_id, config_value, state, schedule_seconds, next_due_at, last_success_at, created_at, updated_at from sync_installations where id = 'legacy'`,
    );
    sql.exec(
      `insert into sync_installations select 'disabled', definition_id, definition_version, provider, connection_id, config_value, 'disabled', schedule_seconds, next_due_at, last_success_at, created_at, updated_at from sync_installations where id = 'legacy'`,
    );
    sql.close();

    const database = new SqliteRuntimeDatabase(path, { syncDefinitions: [definition] });
    databases.push(database);
    const store = database.syncStore;
    expect(await store.getInstallation("legacy")).toMatchObject({ state: "needs_attention", sourceId: undefined });
    expect(await store.getRun("old-run")).toMatchObject({
      state: "cancelled",
      errorCode: "source_verification_required",
    });
    const originalRecord = await store.getRecord("legacy", "record", "native-record");
    const originalCheckpoint = await store.getCheckpoint("legacy");
    const originalOutbox = await store.listOutbox("receiver");
    const input: BindSyncSourceInput = {
      ...bindingInput,
      config: {},
      createdAt: at,
      expectedBindingRevision: 0,
      verifiedConnection: { id: connection.id, revision: connection.revision, service: "test", identity },
    };
    await expect(store.sources.bind(input)).rejects.toMatchObject({ code: "binding_conflict" });
    await expect(store.sources.bind({ ...input, id: "legacy" })).rejects.toMatchObject({ code: "binding_conflict" });
    expect(await store.sources.bind({ ...input, id: "legacy", resolveLegacyIdentity: true })).toBe("legacy");
    const bound = (await store.getInstallation("legacy"))!;
    expect(await store.getRecord("legacy", "record", "native-record")).toEqual({
      ...originalRecord,
      sourceId: bound.sourceId,
    });
    expect(await store.getCheckpoint("legacy")).toEqual(originalCheckpoint);
    expect(await store.listOutbox("receiver")).toEqual(originalOutbox);
    expect((await store.listChanges()).items[0]).toMatchObject({
      eventId: "original-event",
      recordRevision: 9,
      contentHash: "original-hash",
      sourceId: bound.sourceId,
    });
    await expect(
      store.sources.bind({ ...input, expectedBindingRevision: 1, id: "ambiguous", resolveLegacyIdentity: true }),
    ).rejects.toMatchObject({ code: "binding_conflict" });
    expect((await store.getInstallation("ambiguous"))?.sourceId).toBeUndefined();
    expect(store.sources.getBindingRevision()).toBe(1);
    expect((await store.getInstallation("disabled"))?.state).toBe("disabled");
    await expect(
      store.startRun({
        id: "unverified",
        installationId: "disabled",
        definitionVersion: "1",
        reason: "manual",
        leaseOwner: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: now(),
      }),
    ).rejects.toMatchObject({ code: "binding_conflict" });
  });
});
