import type { SyncContext, SyncPage } from "../../sync/sync-definition.ts";

import { requiredString, requiredRawString } from "../../core/cast.ts";
import { providerResponseError } from "../../providers/provider-runtime.ts";
import { parseMeetings, parseTranscript, renderMeeting } from "./render.ts";

/**
 * Rehydrate the last 30 days of accessible meetings in the active Granola workspace every hour.
 * This is a rolling scan, not a historical backfill or an incremental change feed. Rehydration
 * catches summary/transcript edits inside that window; older edits are outside its coverage.
 * Persist only remaining IDs, after each complete record is committed. A restart re-fetches
 * unfinished records. IDs are account-scoped native meeting IDs and survive token refresh.
 * Missing detail/summary/transcript fails the poll without overwriting earlier complete content.
 * An explicit backfill restarts discovery; absence or permission loss never emits deletions.
 */
export async function* run(context: SyncContext): AsyncGenerator<SyncPage> {
  let pending = (context.checkpoint as { pendingIds: string[] | null }).pendingIds;
  if (pending === null) {
    const result = await context.provider.request("list_meetings", { time_range: "last_30_days" });
    pending = parseMeetings(requiredString(result.text, "Granola meeting list", providerResponseError))
      .map((meeting) => meeting.id)
      .sort();
  }
  while (pending.length) {
    context.signal.throwIfAborted();
    const ids = pending.slice(0, 10);
    const result = await context.provider.request("get_meetings", { meeting_ids: ids });
    const details = parseMeetings(requiredString(result.text, "Granola meeting details", providerResponseError));
    if (details.length !== ids.length || details.some((meeting) => !ids.includes(meeting.id)))
      throw providerResponseError(
        "Granola did not return every requested meeting; retry discovery with an explicit backfill if access changed.",
      );
    for (const id of ids) {
      context.signal.throwIfAborted();
      const meeting = details.find((detail) => detail.id === id)!;
      const result = await context.provider.request("get_meeting_transcript", { meeting_id: id });
      const transcript = parseTranscript(
        requiredRawString(result.text, "Granola transcript", providerResponseError),
        id,
      );
      const record = renderMeeting(meeting, transcript);
      pending = pending.slice(1);
      yield {
        records: [{ kind: "meeting", record }],
        checkpoint: { pendingIds: pending.length ? pending : null },
        complete: pending.length === 0,
      };
      if (!pending.length) return;
    }
  }
  // An empty discovery scan still completes a polling iteration.
  yield { checkpoint: { pendingIds: null }, complete: true };
}
