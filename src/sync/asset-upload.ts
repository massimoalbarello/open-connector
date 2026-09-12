import type { SyncRecordAsset } from "./asset-store.ts";

import { z } from "zod";
import { readBoundedResponseBytes } from "../core/request.ts";
import { maximumSyncAssetBytes } from "./asset-store.ts";

export interface SyncAssetReceipt {
  sha256: string;
  sizeBytes: number;
  assetId: string;
  url: string;
}

const receiptSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(0).max(maximumSyncAssetBytes),
  assetId: z.string().min(1).max(1024).regex(/\S/),
  url: z.string().url().max(2048),
});

export class DeliveryHttpError extends Error {
  readonly status: number;
  readonly retryAfter: number;
  constructor(response: Response) {
    super(`Destination returned HTTP ${response.status}.`);
    this.status = response.status;
    const header = response.headers.get("retry-after");
    this.retryAfter = header
      ? /^\d+$/.test(header)
        ? Number(header) * 1000
        : Math.max(0, Date.parse(header) - Date.now())
      : 0;
  }
}

export function validateAssetReceipt(
  value: unknown,
  expected: Pick<SyncRecordAsset, "sha256" | "sizeBytes">,
): SyncAssetReceipt {
  const asset = receiptSchema.parse(value);
  const url = new URL(asset.url);
  if (
    asset.sha256 !== expected.sha256 ||
    asset.sizeBytes !== expected.sizeBytes ||
    url.username ||
    url.password ||
    !(url.protocol === "https:" || asset.url === `context-use://asset/${asset.assetId}`)
  )
    throw new Error("Destination returned an invalid asset receipt.");
  return asset;
}

export interface UploadSyncAssetOptions {
  asset: SyncRecordAsset;
  assetsUrl: string;
  bearerToken: string;
  signal: AbortSignal;
  fetcher: typeof fetch;
  readBytes(): Uint8Array;
}

/** Recover a completed independent upload before sending bytes again after a lost response. */
export async function uploadSyncAsset(options: UploadSyncAssetOptions): Promise<SyncAssetReceipt> {
  const url = `${options.assetsUrl.replace(/\/$/, "")}/${options.asset.sha256}`;
  const headers = { authorization: `Bearer ${options.bearerToken}` };
  const init = { headers, signal: options.signal, redirect: "error" as const };
  let response = await options.fetcher(url, init);
  if (response.status === 404) {
    await response.body?.cancel();
    const form = new FormData();
    form.set("name", options.asset.name);
    form.set("sha256", options.asset.sha256);
    form.set("file", new Blob([Buffer.from(options.readBytes())]), options.asset.name);
    response = await options.fetcher(url, { ...init, method: "PUT", body: form });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeliveryHttpError(response);
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 8192,
    fieldName: "Asset receipt",
    createError: () => new Error("Invalid destination asset response."),
  });
  return validateAssetReceipt(JSON.parse(new TextDecoder().decode(bytes)), options.asset);
}
