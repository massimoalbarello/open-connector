import type { SyncContext, SyncPage, SyncPageRecord } from "../../sync/sync-definition.ts";

import { requiredRawString } from "../../core/cast.ts";
import { parseMeetings, parseTranscript } from "../../providers/granola/mcp-response.ts";
import { providerResponseError } from "../../providers/provider-runtime.ts";
import { discover } from "./discovery.ts";
import { renderMeeting } from "./render.ts";

/** Hydrate at most ten meetings before atomically committing their records and discovery progress. */
export async function* run(context: SyncContext): AsyncGenerator<SyncPage> {
  for await (const batch of discover(context)) {
    context.signal.throwIfAborted();
    const records: SyncPageRecord[] = [];
    if (batch.ids.length) {
      const result = await context.provider.request("get_meetings", { meeting_ids: batch.ids });
      const details = parseMeetings(requiredRawString(result.text, "Granola meeting details", providerResponseError));
      if (details.length !== batch.ids.length || details.some((meeting) => !batch.ids.includes(meeting.id)))
        throw providerResponseError(
          "Granola did not return every requested meeting; use Reprocess to restart discovery if access changed.",
        );
      for (const id of batch.ids) {
        context.signal.throwIfAborted();
        const meeting = details.find((detail) => detail.id === id)!;
        let transcript: string | undefined;
        if (context.config.includeTranscript === true) {
          const result = await context.provider.request("get_meeting_transcript", { meeting_id: id });
          transcript = parseTranscript(requiredRawString(result.text, "Granola transcript", providerResponseError), id);
        }
        records.push({ kind: "meeting", record: renderMeeting(meeting, transcript) });
      }
    }
    yield { records, checkpoint: batch.checkpoint, complete: batch.complete };
  }
}
