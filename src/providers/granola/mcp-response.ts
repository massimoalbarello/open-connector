import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { z } from "zod";
import { optionalString, requiredRawString } from "../../core/cast.ts";
import {
  ProviderRequestError,
  providerResponseError,
  requiredResponseRecord,
  parseProviderJsonBodyText,
} from "../provider-runtime.ts";

export interface GranolaMeeting {
  id: string;
  title: string;
  date: string;
  attendees: string;
  summary?: string;
  privateNotes?: string;
}

const meetingSchema = z.object({
  "@_id": z.string().min(1).max(1024),
  "@_title": z.string(),
  "@_date": z.string(),
  known_participants: z.string().default(""),
  summary: z.string().optional(),
  private_notes: z.string().optional(),
});
const xml = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => name === "meeting",
});

/** Discovery can retry an incomplete date range; hydration must still reject incomplete records. */
export class GranolaTruncatedMeetingsError extends ProviderRequestError {
  constructor() {
    super(502, "Granola meeting list is truncated.");
  }
}

/** Reject malformed discovery rather than silently turning it into an empty successful scan. */
export function parseMeetings(text: string): GranolaMeeting[] {
  let document: Record<string, unknown>;
  try {
    // Granola does not need DTDs. Do not expand provider-supplied custom entities.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsupported XML declaration");
    // MCP returns XML fragments: free-plan discovery includes an access_notice beside meetings_data.
    const response = `<granola_response>${text}</granola_response>`;
    SyntaxValidator.validate(response);
    document = requiredResponseRecord(xml.parse(response).granola_response, "Granola meetings");
  } catch {
    throw providerResponseError("Granola returned malformed meeting XML.");
  }
  const root = requiredResponseRecord(document.meetings_data, "Granola meeting list");
  const parsed = z.array(meetingSchema).safeParse(root.meeting ?? []);
  if (!parsed.success) throw providerResponseError("Granola returned invalid meeting fields.");
  const meetings = parsed.data;
  const count = optionalString(root["@_count"]);
  if (
    (count !== undefined && (!/^\d+$/.test(count) || Number(count) !== meetings.length)) ||
    root["@_has_more"] === "true" ||
    optionalString(root["@_next_cursor"])
  )
    throw new GranolaTruncatedMeetingsError();
  if (new Set(meetings.map((meeting) => meeting["@_id"])).size !== meetings.length)
    throw providerResponseError("Granola returned duplicate meeting IDs.");
  return meetings.map((meeting) => ({
    id: meeting["@_id"],
    title: meeting["@_title"],
    date: meeting["@_date"],
    attendees: meeting.known_participants,
    summary: meeting.summary,
    privateNotes: meeting.private_notes,
  }));
}

/** Preserve authored transcript text, including speaker labels and timestamps, without rewriting prose. */
export function parseTranscript(text: string, meetingId: string): string {
  let transcript: string;
  const value = text.trim();
  if (value.startsWith("{")) {
    const data = requiredResponseRecord(
      parseProviderJsonBodyText(value, {
        emptyBody: undefined,
        invalidJsonMessage: "Invalid Granola transcript response.",
      }),
      "Granola transcript",
    );
    if (data.id !== meetingId) throw providerResponseError("Granola returned a different transcript identity.");
    transcript = requiredRawString(data.transcript, "Granola transcript", providerResponseError);
  } else if (value.startsWith("<transcript")) {
    if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw providerResponseError("Unsupported Granola transcript XML.");
    try {
      SyntaxValidator.validate(value);
    } catch {
      throw providerResponseError("Granola returned malformed transcript XML.");
    }
    const data = requiredResponseRecord(xml.parse(value).transcript, "Granola transcript");
    if (data["@_meeting_id"] !== meetingId)
      throw providerResponseError("Granola returned a different transcript identity.");
    transcript = requiredRawString(data["#text"], "Granola transcript", providerResponseError);
  } else {
    // Older MCP responses contain the transcript directly, without an envelope.
    transcript = requiredRawString(text, "Granola transcript", providerResponseError);
  }
  if (!transcript.trim() || /^no transcript\b/i.test(transcript.trim()))
    throw providerResponseError("Granola transcript is not available yet.");
  return transcript;
}
