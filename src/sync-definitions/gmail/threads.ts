import type { SyncContext, SyncPage } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { optionalString, requiredString } from "../../core/cast.ts";
import {
  ProviderRequestError,
  providerResponseError,
  requiredResponseRecord,
} from "../../providers/provider-runtime.ts";
import { gmailThreads } from "./definition.ts";
import { hydrateThread } from "./hydrate.ts";

interface Checkpoint extends JsonObject {
  phase: "backfill" | "reconcile" | "history";
  historyId: string | null;
  pageToken: string | null;
  throughSequence: number;
  afterId: string | null;
  pendingIds: string[];
  nextHistoryId: string | null;
  historyDue: boolean;
  historyComplete: boolean;
}

function historyId(value: unknown): string {
  const id = requiredString(value, "Gmail history id", providerResponseError);
  if (!/^\d+$/.test(id)) throw providerResponseError("Gmail history id must be a decimal string.");
  return id;
}

function changedThreads(response: JsonObject): string[] {
  if (response.history !== undefined && !Array.isArray(response.history))
    throw providerResponseError("Invalid Gmail history page.");
  const ids = new Set<string>();
  for (const item of response.history ?? []) {
    const entry = requiredResponseRecord(item, "Gmail history entry");
    // Include the general collection as well, so newly introduced event kinds still invalidate threads.
    for (const field of ["messages", "messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) {
      const events = entry[field];
      if (events === undefined) continue;
      if (!Array.isArray(events)) throw providerResponseError("Invalid Gmail history messages.");
      for (const event of events) {
        const object = requiredResponseRecord(event, "Gmail history event");
        const message = field === "messages" ? object : requiredResponseRecord(object.message, "Gmail changed message");
        ids.add(requiredString(message.threadId, "Gmail changed thread id", providerResponseError));
      }
    }
  }
  if (ids.size > 1000) throw providerResponseError("Gmail history page exceeds the pending thread limit.");
  return [...ids].sort();
}

/** Full mailbox scan, interleaved history, then authoritative rechecks of previously known IDs.
 * Pending IDs are discovery work; applied history moves only after their complete records commit.
 * See README.md for cursor expiry, reconciliation and resource limits.
 */
export async function* run(context: SyncContext): AsyncGenerator<SyncPage> {
  let checkpoint = {
    ...(context.checkpoint as Checkpoint),
    pendingIds: [...(context.checkpoint as Checkpoint).pendingIds],
  };
  while (true) {
    context.signal.throwIfAborted();
    if (checkpoint.historyId === null) {
      const profile = await context.provider.request("profile");
      const inventory = await context.records.list({ kind: "thread" });
      checkpoint = {
        ...checkpoint,
        historyId: historyId(profile.historyId),
        throughSequence: inventory.throughSequence,
      };
      continue;
    }
    if (checkpoint.pendingIds.length) {
      const id = checkpoint.pendingIds[0]!;
      const record = await hydrateThread(context, id);
      checkpoint = { ...checkpoint, pendingIds: checkpoint.pendingIds.slice(1) };
      if (!checkpoint.pendingIds.length && checkpoint.nextHistoryId !== null)
        checkpoint = { ...checkpoint, historyId: checkpoint.nextHistoryId, nextHistoryId: null, historyDue: false };
      const complete =
        checkpoint.phase === "history" && checkpoint.historyComplete && checkpoint.pendingIds.length === 0;
      yield {
        records: record ? [{ kind: "thread", record }] : [],
        deletes: record ? [] : [{ kind: "thread", id }],
        checkpoint,
        complete,
      };
      if (complete) return;
      continue;
    }
    if (checkpoint.historyDue || checkpoint.phase === "history") {
      let response: JsonObject;
      try {
        response = await context.provider.request("history.list", { historyId: checkpoint.historyId });
      } catch (error) {
        if (!(error instanceof ProviderRequestError) || error.status !== 404) throw error;
        checkpoint = { ...(gmailThreads.initialCheckpoint as Checkpoint) };
        yield { checkpoint, complete: false };
        continue;
      }
      const ids = changedThreads(response);
      const entries = response.history as JsonObject[] | undefined;
      const complete = !optionalString(response.nextPageToken);
      const nextHistoryId = historyId(complete ? response.historyId : entries?.at(-1)?.id);
      if (
        BigInt(nextHistoryId) < BigInt(checkpoint.historyId) ||
        (!complete && BigInt(nextHistoryId) === BigInt(checkpoint.historyId))
      )
        throw providerResponseError("Gmail history did not advance.");
      checkpoint = {
        ...checkpoint,
        pendingIds: ids,
        nextHistoryId: ids.length ? nextHistoryId : null,
        historyId: ids.length ? checkpoint.historyId : nextHistoryId,
        historyDue: false,
        historyComplete: complete,
      };
      const finished = checkpoint.phase === "history" && complete && ids.length === 0;
      if (!ids.length) yield { checkpoint, complete: finished };
      if (finished) return;
      continue;
    }
    if (checkpoint.phase === "backfill") {
      let response: JsonObject;
      try {
        response = await context.provider.request("threads.list", { pageToken: checkpoint.pageToken });
      } catch (error) {
        if (!checkpoint.pageToken || !(error instanceof ProviderRequestError) || error.status !== 400) throw error;
        checkpoint = { ...checkpoint, pageToken: null, historyDue: true };
        yield { checkpoint, complete: false };
        continue;
      }
      if (response.threads !== undefined && !Array.isArray(response.threads))
        throw providerResponseError("Invalid Gmail thread discovery.");
      const ids = [
        ...new Set(
          (response.threads ?? []).map((value) =>
            requiredString(requiredResponseRecord(value, "Gmail thread").id, "Gmail thread id", providerResponseError),
          ),
        ),
      ];
      if (ids.length > 50) throw providerResponseError("Gmail exceeded the requested discovery page size.");
      const pageToken = optionalString(response.nextPageToken) ?? null;
      if (pageToken !== null && pageToken === checkpoint.pageToken)
        throw providerResponseError("Gmail repeated a discovery token.");
      checkpoint = {
        ...checkpoint,
        pageToken,
        pendingIds: ids,
        phase: pageToken ? "backfill" : "reconcile",
        historyDue: true,
        historyComplete: false,
      };
      if (!ids.length) yield { checkpoint, complete: false };
      continue;
    }
    const inventory = await context.records.list({
      kind: "thread",
      throughSequence: checkpoint.throughSequence,
      afterId: checkpoint.afterId ?? undefined,
    });
    checkpoint = {
      ...checkpoint,
      pendingIds: inventory.ids,
      afterId: inventory.ids.at(-1) ?? checkpoint.afterId,
      phase: inventory.ids.length ? "reconcile" : "history",
      historyDue: true,
      historyComplete: false,
    };
    if (!inventory.ids.length) yield { checkpoint, complete: false };
  }
}
