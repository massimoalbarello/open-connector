import type { CatalogStore } from "../catalog-store.ts";
import type { ConnectionService, IConnectionStore } from "../connection-service.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { SyncRegistration } from "./sync-definition.ts";
import type { ISyncStore, JsonObject, JsonValue, SyncRun } from "./sync-store.ts";

import { normalizeConnectionName } from "../connection-service.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { createSyncProvider } from "./provider-adapter.ts";
import { normalizeSyncRecord } from "./record-contract.ts";
import { SyncSourceBindingService } from "./source-binding.ts";
import { SyncStoreError } from "./sync-store.ts";
import { validateSyncValue } from "./sync-validation.ts";

export interface SyncRunnerOptions {
  store: ISyncStore;
  connections: ConnectionService;
  connectionStore: IConnectionStore;
  registrations: readonly SyncRegistration[];
  catalog: CatalogStore;
  loader: IProviderLoader;
}

export interface RunSyncInput {
  definitionId: string;
  connectionName?: string;
  config?: JsonObject;
  dryRun?: boolean;
  backfill?: boolean;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface RunSyncResult {
  installationId?: string;
  run?: SyncRun;
  complete: boolean;
  pages: number;
  records: number;
  /** Bounded, normalized previews only for isolated dry runs. */
  preview?: JsonObject[];
}

/** Runs trusted compiled acquisition with pinned auth, validated progress and fenced page commits. */
export class SyncRunner {
  private readonly options: SyncRunnerOptions;
  private active?: AbortController;
  private pending?: Promise<RunSyncResult>;

  constructor(options: SyncRunnerOptions) {
    this.options = options;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  definitions(): readonly SyncRegistration["definition"][] {
    return this.options.registrations.map((item) => item.definition);
  }

  run(input: RunSyncInput): Promise<RunSyncResult> {
    if (this.active) return Promise.reject(new SyncStoreError("run_busy", "Another acquisition is already running."));
    const controller = new AbortController();
    this.active = controller;
    const pending = this.execute(input, controller).finally(() => {
      this.active = undefined;
      this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  async stop(): Promise<void> {
    this.active?.abort(new Error("Sync runtime is stopping."));
    await this.pending?.catch(() => undefined);
  }

  private async execute(input: RunSyncInput, controller: AbortController): Promise<RunSyncResult> {
    const { store, connections, connectionStore } = this.options;
    const registration = this.options.registrations.find((item) => item.definition.id === input.definitionId);
    if (!registration) throw new SyncStoreError("invalid_input", "Unknown sync definition.");
    const definition = registration.definition;
    const maxPages = input.maxPages ?? (input.dryRun ? 1 : 100);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
      throw new SyncStoreError("invalid_input", "maxPages must be between 1 and 1000.");
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10 * 60_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const config = validateSyncValue(
      input.config ?? definition.defaultConfig,
      definition.configSchema,
      "Sync configuration",
    ) as JsonObject;
    const name = normalizeConnectionName(input.connectionName);
    const startedAt = new Date().toISOString();
    const installation = input.dryRun
      ? undefined
      : await new SyncSourceBindingService(connections, store).bind({
          definitionId: definition.id,
          definitionVersion: definition.version,
          provider: definition.provider,
          connectionName: name,
          config,
          signal,
        });
    const verified = installation
      ? { id: installation.connectionId, revision: installation.credentialRevision }
      : await connections.verifySourceConnection(definition.provider, name, signal);
    const connection = await connectionStore.get(definition.provider, name);
    if (!connection || connection.id !== verified.id || connection.revision !== verified.revision)
      throw new SyncStoreError("credential_changed", "Connection changed before acquisition.");
    const credential = connection.credential;
    if (
      credential.authType === "no_auth" ||
      definition.requiredScopes.some((scope) => !credential.profile.grantedScopes.includes(scope))
    )
      throw new SyncStoreError("invalid_input", "Required sync scopes have not been granted.");
    const storedCheckpoint = installation ? await store.getCheckpoint(installation.id) : undefined;
    if (storedCheckpoint && storedCheckpoint.definitionVersion !== definition.version)
      throw new SyncStoreError("invalid_input", "Checkpoint version needs migration.");
    let checkpoint: JsonValue = validateSyncValue(
      input.backfill ? definition.initialCheckpoint : (storedCheckpoint?.value ?? definition.initialCheckpoint),
      definition.checkpointSchema,
      "Sync checkpoint",
    );
    let checkpointRevision = storedCheckpoint?.revision ?? 0;
    const runId = randomUUIDv7();
    const owner = randomUUIDv7();
    let lease = { owner, generation: 1 };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatWork = Promise.resolve();
    let run: SyncRun | undefined;
    if (installation) {
      run = await store.startRun({
        id: runId,
        installationId: installation.id,
        definitionVersion: definition.version,
        reason: input.backfill ? "backfill" : "manual",
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        startedAt,
      });
      heartbeat = setInterval(() => {
        heartbeatWork = heartbeatWork
          .then(async () => {
            const renewed = await store.renewRunLease({
              runId,
              ...lease,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            });
            lease = { owner, generation: renewed.leaseGeneration };
          })
          .catch((error) => controller.abort(error));
      }, 30_000);
      heartbeat.unref();
    }
    const result: RunSyncResult = {
      installationId: installation?.id,
      run,
      complete: false,
      pages: 0,
      records: 0,
      preview: input.dryRun ? [] : undefined,
    };
    try {
      const runtime = await registration.load();
      const provider = createSyncProvider({
        connection,
        connections: connectionStore,
        definition,
        signal,
        catalog: this.options.catalog,
        loader: this.options.loader,
      });
      for await (const page of runtime.run({
        provider,
        config,
        checkpoint,
        sourceId: installation?.sourceId ?? "dry-run",
        startedAt,
        signal,
      })) {
        signal.throwIfAborted();
        checkpoint = validateSyncValue(page.checkpoint, definition.checkpointSchema, "Sync checkpoint");
        const records = page.records ?? [];
        if (typeof page.complete !== "boolean" || records.length + (page.deletes?.length ?? 0) > 1000)
          throw new SyncStoreError("invalid_input", "Invalid or oversized sync page.");
        const identities = new Set<string>();
        for (const item of [
          ...records.map((item) => ({ kind: item.kind, id: item.record.id })),
          ...(page.deletes ?? []),
        ]) {
          const key = JSON.stringify([item.kind, item.id]);
          if (
            !definition.kinds.some((kind) => kind.kind === item.kind) ||
            typeof item.id !== "string" ||
            !item.id.trim() ||
            identities.has(key)
          )
            throw new SyncStoreError("invalid_input", "Invalid or duplicate sync record identity.");
          identities.add(key);
        }
        const normalized = records.map((item) => {
          const kind = definition.kinds.find((kind) => kind.kind === item.kind);
          if (!kind) throw new SyncStoreError("invalid_input", "Sync emitted an undeclared kind.");
          return { kind: item.kind, value: normalizeSyncRecord(item.record, kind) };
        });
        if (installation) {
          await heartbeatWork;
          signal.throwIfAborted();
          const committed = await store.commitPage({
            installationId: installation.id,
            runId,
            lease,
            expectedCheckpointRevision: checkpointRevision,
            nextCheckpoint: checkpoint,
            upserts: records,
            deletes: page.deletes,
            committedAt: new Date().toISOString(),
          });
          checkpointRevision = committed.checkpoint.revision;
        } else {
          for (const record of normalized) {
            if (result.preview!.length >= 100)
              throw new SyncStoreError("invalid_input", "Dry-run preview exceeds 100 records; lower maxPages.");
            result.preview!.push({
              provider: definition.provider,
              sourceId: "dry-run",
              kind: record.kind,
              id: record.value.id,
              content: record.value.content.value,
            });
          }
        }
        result.pages++;
        result.records += normalized.length;
        result.complete = page.complete;
        if (page.complete || result.pages >= maxPages) break;
      }
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatWork;
      signal.throwIfAborted();
      if (installation)
        result.run = await store.finishRun({
          runId,
          ...lease,
          state: "succeeded",
          completedAt: new Date().toISOString(),
        });
      return result;
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatWork;
      if (installation)
        await store
          .finishRun({
            runId,
            ...lease,
            state: signal.aborted ? "cancelled" : "failed",
            completedAt: new Date().toISOString(),
            errorCode: error instanceof SyncStoreError ? error.code : "acquisition_failed",
            errorMessage: signal.aborted
              ? "Acquisition cancelled."
              : "Acquisition failed; committed progress is retained.",
          })
          .catch(() => undefined);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
