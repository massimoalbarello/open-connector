import type { ConnectionService, IConnectionStore } from "../connection-service.ts";
import type { SyncRegistration } from "./sync-definition.ts";
import type { ISyncStore, JsonObject, JsonValue, SyncRun } from "./sync-store.ts";

import { normalizeConnectionName } from "../connection-service.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";
import { maximumRecordBytes } from "./delivery-store.ts";
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
}

export interface RunSyncInput {
  definitionId: string;
  connectionName?: string;
  config?: JsonObject;
  dryRun?: boolean;
  backfill?: boolean;
  maxPages?: number;
  signal?: AbortSignal;
  reason?: "schedule";
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
  private installationId?: string;
  private stopped = false;
  private dryRun = false;

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
    if (this.stopped) return Promise.reject(new SyncStoreError("run_busy", "Sync runtime is stopping."));
    if (this.active) return Promise.reject(new SyncStoreError("run_busy", "Another acquisition is already running."));
    const controller = new AbortController();
    this.active = controller;
    this.dryRun = input.dryRun === true;
    const pending = this.execute(input, controller)
      .catch((error) => {
        throw controller.signal.aborted ? controller.signal.reason : error;
      })
      .finally(() => {
        this.active = undefined;
        this.installationId = undefined;
        this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  cancel(installationId: string): void {
    if (this.installationId === installationId) this.active?.abort(new Error("Sync installation was disabled."));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.abort(new Error("Sync runtime is stopping."));
    await this.pending?.catch(() => undefined);
  }

  /** Cancellation is prompt locally; transactional store checks protect other processes too. */
  destinationChanged(): void {
    if (!this.dryRun && !this.options.store.delivery.getDestination()?.enabled)
      this.active?.abort(new SyncStoreError("destination_required", "Sync is waiting for an enabled destination."));
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
    if (!input.dryRun) store.delivery.requireDestination();
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
    this.installationId = installation?.id;
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
    if (installation) {
      store.schedule.recover(startedAt);
      store.schedule.reconcile(this.definitions(), startedAt);
    }
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
        reason: input.backfill ? "backfill" : (input.reason ?? "manual"),
        resetCheckpoint: input.backfill ? definition.initialCheckpoint : undefined,
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        startedAt,
      });
      checkpointRevision = (await store.getCheckpoint(installation.id))?.revision ?? 0;
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
    let previewBytes = 2;
    try {
      const runtime = await registration.load();
      const provider = createSyncProvider({
        connection,
        connections: connectionStore,
        createProvider: registration.createProvider,
        signal,
        assertActive: installation ? () => store.delivery.requireDestination() : undefined,
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
          if (result.preview!.length + records.length > 100)
            throw new SyncStoreError("invalid_input", "Dry-run preview exceeds 100 records; lower maxPages.");
          for (const item of records) {
            const kind = definition.kinds.find((kind) => kind.kind === item.kind);
            if (!kind) throw new SyncStoreError("invalid_input", "Sync emitted an undeclared kind.");
            const value = normalizeSyncRecord(item.record, kind);
            if (Buffer.byteLength(value.content.json) > maximumRecordBytes)
              throw new SyncStoreError("invalid_input", "Record exceeds the 8 MiB delivery limit.");
            const preview: JsonObject = {
              provider: definition.provider,
              sourceId: "dry-run",
              kind: item.kind,
              id: value.id,
              content: value.content.value,
            };
            previewBytes += Buffer.byteLength(JSON.stringify(preview)) + 1;
            if (previewBytes > 16 * 1024 * 1024)
              throw new SyncStoreError("invalid_input", "Dry-run preview exceeds 16 MiB; lower maxPages.");
            result.preview!.push(preview);
          }
        }
        result.pages++;
        result.records += records.length;
        result.complete = page.complete;
        if (page.complete || result.pages >= maxPages) break;
      }
      if (!result.pages) throw new SyncStoreError("invalid_input", "Sync definition ended without a progress page.");
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
      if (installation)
        store.schedule.complete({
          installationId: installation.id,
          bindingRevision: installation.bindingRevision,
          succeeded: true,
          complete: result.complete,
          now: new Date().toISOString(),
        });
      return result;
    } catch (cause) {
      const error = signal.aborted ? signal.reason : cause;
      const waiting = error instanceof SyncStoreError && error.code === "destination_required";
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatWork;
      if (installation)
        await store
          .finishRun({
            runId,
            ...lease,
            state: signal.aborted || waiting ? "cancelled" : "failed",
            completedAt: new Date().toISOString(),
            errorCode: error instanceof SyncStoreError ? error.code : "acquisition_failed",
            errorMessage: waiting
              ? "Waiting for destination; committed progress is retained."
              : signal.aborted
                ? "Acquisition cancelled."
                : "Acquisition failed; committed progress is retained.",
          })
          .catch(() => undefined);
      if (installation)
        store.schedule.complete({
          installationId: installation.id,
          bindingRevision: installation.bindingRevision,
          succeeded: false,
          complete: false,
          errorCode: error instanceof SyncStoreError ? error.code : "acquisition_failed",
          now: new Date().toISOString(),
        });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
