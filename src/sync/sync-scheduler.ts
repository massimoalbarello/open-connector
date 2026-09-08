import type { SyncDeliveryWorker } from "./delivery-worker.ts";
import type { SyncRunner } from "./sync-runner.ts";
import type { ISyncStore } from "./sync-store.ts";

import { SyncStoreError } from "./sync-store.ts";

export interface SyncSchedulerOptions {
  store: ISyncStore;
  runner: SyncRunner;
  delivery: SyncDeliveryWorker;
  onError?(code: string): void;
}

/** A small embedded dispatcher: persisted due times, one acquisition, independent delivery retries. */
export class SyncScheduler {
  private readonly options: SyncSchedulerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private acquisition?: Promise<void>;
  private delivery?: Promise<void>;
  private stopped = false;
  private preferBinding = true;

  constructor(options: SyncSchedulerOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.timer !== undefined && !this.stopped;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  tick(): void {
    if (this.stopped) return;
    if (!this.delivery)
      this.delivery = this.options.delivery
        .tick()
        .then(() => undefined)
        .catch(() => this.options.onError?.("delivery_failed"))
        .finally(() => {
          this.delivery = undefined;
        });
    if (!this.acquisition)
      this.acquisition = this.acquire()
        .catch(() => this.options.onError?.("scheduler_failed"))
        .finally(() => {
          this.acquisition = undefined;
        });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([this.options.runner.stop(), this.options.delivery.stop()]);
    await Promise.all([this.acquisition, this.delivery]);
  }

  private async acquire(): Promise<void> {
    const { store, runner } = this.options;
    if (runner.busy) return;
    const now = new Date().toISOString();
    store.schedule.recover(now);
    store.schedule.reconcile(runner.definitions(), now);
    const candidate = store.schedule.bindingDue(runner.definitions(), now);
    const scheduled = store.schedule.due(now);
    if (candidate && (!scheduled || this.preferBinding)) {
      this.preferBinding = false;
      try {
        await runner.run({
          definitionId: candidate.definitionId,
          connectionName: candidate.connectionName,
          config: candidate.config,
          reason: "schedule",
        });
        store.schedule.bindingSucceeded(candidate);
      } catch (error) {
        if (!(error instanceof SyncStoreError) || error.code !== "run_busy")
          store.schedule.bindingFailed(
            candidate,
            error instanceof SyncStoreError ? error.code : "source_verification_failed",
            new Date().toISOString(),
          );
      }
      return;
    }
    if (!scheduled) return;
    this.preferBinding = true;
    const { installation, connectionName } = scheduled;
    const definition = runner.definitions().find((item) => item.id === installation.definitionId);
    if (!definition || definition.version !== installation.definitionVersion) return;
    try {
      await runner.run({
        definitionId: definition.id,
        connectionName,
        config: installation.config,
        reason: "schedule",
      });
    } catch (error) {
      // Failures before startRun still need durable backoff. Later failures already update the source.
      const current = await store.getInstallation(installation.id);
      if (
        current?.nextDueAt === installation.nextDueAt &&
        (!(error instanceof SyncStoreError) || error.code !== "run_busy")
      )
        store.schedule.complete({
          installationId: installation.id,
          bindingRevision: installation.bindingRevision,
          succeeded: false,
          complete: false,
          errorCode: error instanceof SyncStoreError ? error.code : "acquisition_failed",
          now: new Date().toISOString(),
        });
    }
  }
}
