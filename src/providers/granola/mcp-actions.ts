import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const meetingSchema = s.requiredObject("A Granola meeting returned through MCP.", {
  id: s.nonEmptyString("Native Granola meeting ID."),
  title: s.string("Meeting title."),
  date: s.string("Meeting date as displayed by Granola, not a creation or update timestamp."),
  attendees: s.string("Participant names and email addresses as supplied by Granola."),
  summary: s.optional(s.string("Meeting summary, preserving its original Markdown when present.")),
});

export const granolaMcpActions: ActionDefinition[] = [
  defineProviderAction("granola", {
    name: "list_meetings",
    description:
      "List accessible Granola meetings from the last 30 days through MCP. Requires OAuth and supports the free plan.",
    requiredScopes: [],
    followUpActions: ["granola.get_meetings"],
    inputSchema: s.object({}),
    outputSchema: s.requiredObject("Meetings in the last 30 days.", {
      meetings: s.array(meetingSchema),
    }),
  }),
  defineProviderAction("granola", {
    name: "get_meetings",
    description:
      "Read Granola meeting details and summaries by ID through MCP. Requires OAuth. Free plans cover personal notes from the last 30 days.",
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
    description: "Read a Granola meeting transcript through MCP. Requires OAuth and a paid Granola plan.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Meeting whose transcript to retrieve.", {
      meeting_id: s.nonEmptyString("Native Granola meeting ID."),
    }),
    outputSchema: s.requiredObject("Original transcript text for the requested meeting.", {
      meeting_id: s.nonEmptyString("Native Granola meeting ID."),
      transcript: s.nonEmptyString("Transcript text, preserving speaker labels, timestamps, and whitespace."),
    }),
  }),
];
