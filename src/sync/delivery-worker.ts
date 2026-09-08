import type { ISyncDeliveryStore } from "./delivery-store.ts";

import { providerFetch } from "../providers/provider-runtime.ts";
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

  constructor(options: SyncDeliveryWorkerOptions) {
    this.options = options;
  }

  tick(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    this.pending = this.deliver(signal).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.pending?.catch(() => undefined);
  }

  private async deliver(signal: AbortSignal): Promise<boolean> {
    this.options.store.purge();
    const lease = await this.options.store.claim(new Date().toISOString());
    if (!lease) return false;
    let acknowledged = false;
    let httpStatus: number | undefined;
    let errorCode: string | undefined;
    let retryAfter = 0;
    try {
      const response = await (this.options.fetcher ?? providerFetch)(lease.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.bearerToken}`,
          "content-type": "application/json",
          "idempotency-key": lease.id,
        },
        body: lease.body,
        redirect: "error",
        signal,
      });
      httpStatus = response.status;
      acknowledged = response.ok;
      if (!acknowledged) errorCode = `http_${response.status}`;
      const header = response.headers.get("retry-after");
      if (header)
        retryAfter = /^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
      // Only the status is the batch ACK. Never store response bodies or receiver credentials in errors.
      await response.body?.cancel().catch(() => undefined);
    } catch {
      errorCode = signal.aborted ? "delivery_aborted" : "delivery_failed";
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
