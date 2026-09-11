import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

/** Meeting fields shared by the API-key and OAuth transports. Missing upstream fields stay omitted. */
export interface GranolaMeeting {
  id: string;
  title: string | null;
  date?: string;
  attendees?: string;
  summary?: string;
}

const meetingSchema = s.requiredObject("A Granola meeting.", {
  id: s.nonEmptyString("Meeting ID for this connection. OAuth and API-key IDs are not interchangeable."),
  title: s.nullable(s.string("Meeting title, when available.")),
  date: s.optional(s.string("Meeting date when available, not a creation or update timestamp.")),
  attendees: s.optional(s.string("Participant names and email addresses when available.")),
  summary: s.optional(s.string("Meeting summary, preserving its original Markdown when present.")),
});

export const granolaMeetingActions: ActionDefinition[] = [
  defineProviderAction("granola", {
    name: "list_meetings",
    description:
      "List recent Granola meetings with OAuth or an API key. OAuth uses MCP's last-30-days window; API keys list notes created in the last 30 days. Use get_meetings to read summaries.",
    requiredScopes: [],
    followUpActions: ["granola.get_meetings"],
    inputSchema: s.object({}),
    outputSchema: s.requiredObject("Recent meetings accessible to this connection.", {
      meetings: s.array(meetingSchema),
    }),
  }),
  defineProviderAction("granola", {
    name: "get_meetings",
    description:
      "Read Granola meeting details and summaries by ID with OAuth or an API key. Use IDs returned for the same connection. Free-plan OAuth access covers personal notes from the last 30 days.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Meetings to retrieve.", {
      meeting_ids: s.array(s.nonEmptyString("Meeting ID returned by list_meetings."), {
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
      }),
    }),
    outputSchema: s.requiredObject("Requested meetings in input order.", {
      meetings: s.array(meetingSchema),
    }),
  }),
  defineProviderAction("granola", {
    name: "get_meeting_transcript",
    description: "Read a Granola meeting transcript with OAuth or an API key. Requires an eligible paid Granola plan.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Meeting whose transcript to retrieve.", {
      meeting_id: s.nonEmptyString("Meeting ID returned for this connection."),
    }),
    outputSchema: s.requiredObject("Transcript text for the requested meeting.", {
      meeting_id: s.nonEmptyString("Native Granola meeting ID."),
      transcript: s.nonEmptyString("Transcript text with speaker labels and timestamps when available."),
    }),
  }),
];
