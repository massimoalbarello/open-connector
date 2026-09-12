import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const meetingSchema = s.requiredObject("A Granola meeting.", {
  id: s.nonEmptyString("Meeting ID for reading notes or the transcript."),
  title: s.string("Meeting title."),
  date: s.string("Meeting date as displayed by Granola."),
  attendees: s.string("Participant names and email addresses supplied by Granola."),
  summary: s.optional(s.string("AI-generated meeting summary, preserving its Markdown.")),
  privateNotes: s.optional(s.string("The connected user's private notes, when returned.")),
});
const meetingsOutput = s.requiredObject("Granola meetings returned for this request.", {
  meetings: s.array(meetingSchema),
});

export const granolaMcpActions: ActionDefinition[] = [
  defineProviderAction("granola", {
    name: "list_meetings",
    description:
      "List accessible meeting titles, dates, and participants through OAuth, with optional date and involvement filters.",
    requiredScopes: [],
    followUpActions: ["granola.get_meetings", "granola.get_meeting_transcript"],
    inputSchema: s.object({
      time_range: s.optional(
        s.stringEnum("Date range to list. Omit to use Granola's default; custom ranges require upstream support.", [
          "this_week",
          "last_week",
          "last_30_days",
          "custom",
        ]),
      ),
      custom_start: s.optional(s.date("Inclusive start date for a custom range.")),
      custom_end: s.optional(s.date("End date for a custom range.")),
      folder_id: s.optional(s.uuid("Limit meetings to this folder, when Granola allows folder filtering.")),
      workspace_only: s.optional(
        s.literal(true, {
          description: "Limit results to public workspace meetings. Omit to include all accessible meetings.",
        }),
      ),
      involvement: s.optional(
        s.object(
          "Positive conditions combine with OR; negative conditions exclude matches. Omit to ignore involvement.",
          {
            captured_by_me: s.optional(s.boolean("Include or exclude notes captured by the connected user.")),
            listed_as_participant: s.optional(
              s.boolean("Include or exclude meetings listing the connected user as a participant."),
            ),
          },
        ),
      ),
    }),
    outputSchema: meetingsOutput,
  }),
  defineProviderAction("granola", {
    name: "get_meetings",
    description: "Read summaries, notes, and participants for up to ten meetings through OAuth.",
    requiredScopes: [],
    followUpActions: ["granola.get_meeting_transcript"],
    inputSchema: s.requiredObject("Meetings to read.", {
      meeting_ids: s.array(s.uuid("Meeting ID returned by list_meetings."), { minItems: 1, maxItems: 10 }),
    }),
    outputSchema: meetingsOutput,
  }),
  defineProviderAction("granola", {
    name: "get_meeting_transcript",
    description: "Read a meeting's verbatim transcript through OAuth. Granola must grant transcript access.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Meeting to read.", {
      meeting_id: s.uuid("Meeting ID returned by list_meetings."),
    }),
    outputSchema: s.requiredObject("A meeting transcript.", {
      meeting_id: s.uuid("Meeting ID associated with the transcript."),
      transcript: s.string("Verbatim transcript, preserving speaker labels and timestamps."),
    }),
  }),
  defineProviderAction("granola", {
    name: "list_meeting_folders",
    description: "Browse accessible meeting folders through OAuth. Granola must grant folder access.",
    requiredScopes: [],
    followUpActions: ["granola.list_meetings"],
    inputSchema: s.object({}),
    outputSchema: s.requiredObject("Granola's folder listing.", {
      text: s.string("Folder listing in Granola's text format, including IDs, titles, descriptions, and note counts."),
    }),
  }),
  defineProviderAction("granola", {
    name: "query_meetings",
    description:
      "Ask a question about accessible meeting notes through OAuth and receive an answer with source citations.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Question and optional meetings to search.", {
      query: s.nonEmptyString("Question about meeting content, decisions, or action items."),
      document_ids: s.optional(s.array(s.uuid("Limit the answer to these meeting IDs."))),
    }),
    outputSchema: s.requiredObject("Granola's answer.", {
      answer: s.string("Answer with original source citation links preserved."),
    }),
  }),
  defineProviderAction("granola", {
    name: "get_account_info",
    description: "Identify the Granola account, active workspace, and meeting access scopes connected through OAuth.",
    requiredScopes: [],
    inputSchema: s.object({}),
    outputSchema: s.looseRequiredObject("The connected Granola account.", {
      email: s.email("Connected account email."),
      active_workspace: s.looseRequiredObject("Workspace used by Granola MCP.", {
        id: s.nonEmptyString("Workspace ID."),
        display_name: s.string("Workspace name."),
      }),
      mcp_note_access: s.optional(
        s.looseRequiredObject("Effective note access.", {
          scopes: s.array(s.string("Note category accessible to this connection.")),
        }),
      ),
    }),
  }),
];
