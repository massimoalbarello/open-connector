import type { ISyncDeliveryStore } from "./delivery-store.ts";

import { providerFetch } from "../providers/provider-runtime.ts";
import { DeliveryHttpError, uploadSyncAsset } from "./asset-upload.ts";
import { SyncStoreError } from "./sync-store.ts";

export interface SyncDeliveryWorkerOptions {
  store: ISyncDeliveryStore;
  /** Tests may inject a transport; production always uses the shared DNS/redirect guard. */
  fetcher?: typeof fetch;
}

/** Deliver one durable batch at a time. Timers and lifecycle belong to the runtime scheduler. */
export class SyncDeliveryWorker {
  private options: SyncDeliveryWorkerOptions;
  private pending?: Promise<boolean>;
  private controller?: AbortController;
  private stopped = false;

  constructor(options: SyncDeliveryWorkerOptions) {
    this.options = options;
  }

  tick(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10 * 60_000)]);
    this.pending = this.deliver(signal).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.pending?.catch(() => undefined);
  }

  private async deliver(signal: AbortSignal): Promise<boolean> {
    const lease = await this.options.store.claim(new Date().toISOString());
    if (!lease) return false;
    let acknowledged = false;
    let httpStatus: number | undefined;
    let errorCode: string | undefined;
    let retryAfter = 0;
    const abort = new AbortController();
    const activeSignal = AbortSignal.any([signal, abort.signal]);
    const heartbeat = setInterval(() => {
      try {
        this.options.store.renew(lease, new Date().toISOString());
      } catch (error) {
        abort.abort(error);
      }
    }, 20_000);
    heartbeat.unref();
    try {
      const pending = this.options.store.pendingAssets(lease);
      if (pending.length && !lease.assetsUrl)
        throw new SyncStoreError("destination_required", "Configure an asset upload URL for attachments.");
      for (const asset of pending) {
        const receipt = await uploadSyncAsset({
          asset,
          assetsUrl: lease.assetsUrl!,
          bearerToken: lease.bearerToken,
          signal: AbortSignal.any([activeSignal, AbortSignal.timeout(120_000)]),
          fetcher: this.options.fetcher ?? providerFetch,
          readBytes: () => this.options.store.readAsset(lease, asset.sha256),
        });
        this.options.store.assetUploaded(lease, receipt);
      }
      const body = this.options.store.prepare(lease);
      activeSignal.throwIfAborted();
      const response = await (this.options.fetcher ?? providerFetch)(lease.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.bearerToken}`,
          "content-type": "application/json",
          "idempotency-key": lease.id,
        },
        body,
        redirect: "error",
        signal: AbortSignal.any([activeSignal, AbortSignal.timeout(30_000)]),
      });
      httpStatus = response.status;
      acknowledged = response.ok;
      await response.body?.cancel().catch(() => undefined);
      if (!acknowledged) throw new DeliveryHttpError(response);
    } catch (error) {
      if (error instanceof DeliveryHttpError) {
        httpStatus = error.status;
        retryAfter = error.retryAfter;
        errorCode = `http_${error.status}`;
      } else {
        errorCode =
          error instanceof SyncStoreError ? error.code : activeSignal.aborted ? "delivery_aborted" : "delivery_failed";
      }
    } finally {
      clearInterval(heartbeat);
    }
    const backoff = Math.min(3600_000, 1000 * 2 ** Math.min(lease.attempt, 12));
    const delay = Math.min(
      3600_000,
      Math.max(backoff * (0.75 + Math.random() * 0.5), Number.isFinite(retryAfter) ? retryAfter : 0),
    );
    const now = new Date().toISOString();
    try {
      this.options.store.complete({
        lease,
        acknowledged,
        httpStatus,
        errorCode,
        now,
        retryAt: new Date(Date.now() + delay).toISOString(),
      });
    } catch (error) {
      if (!(error instanceof SyncStoreError) || error.code !== "lease_lost") throw error;
    }
    return true;
  }
}
