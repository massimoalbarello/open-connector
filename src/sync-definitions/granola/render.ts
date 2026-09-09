import type { SyncParticipant, SyncRecordInput } from "../../sync/record-contract.ts";

import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { z } from "zod";
import { optionalString, requiredRawString } from "../../core/cast.ts";
import { providerResponseError, requiredResponseRecord } from "../../providers/provider-runtime.ts";

interface GranolaMeeting {
  id: string;
  title: string;
  date: string;
  attendees: string;
  summary?: string;
}

const meetingSchema = z.object({
  "@_id": z.string().min(1).max(1024),
  "@_title": z.string(),
  "@_date": z.string(),
  known_participants: z.string().default(""),
  summary: z.string().optional(),
});
const xml = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => name === "meeting",
});

/** Reject malformed discovery rather than silently turning it into an empty successful scan. */
export function parseMeetings(text: string): GranolaMeeting[] {
  let document: Record<string, unknown>;
  try {
    // Granola does not need DTDs. Do not expand provider-supplied custom entities.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsupported XML declaration");
    SyntaxValidator.validate(text);
    document = requiredResponseRecord(xml.parse(text), "Granola meetings");
  } catch {
    throw providerResponseError("Granola returned malformed meeting XML.");
  }
  const root = requiredResponseRecord(document.meetings_data, "Granola meeting list");
  const meetings = z
    .array(meetingSchema)
    .max(1000)
    .parse(root.meeting ?? []);
  const count = optionalString(root["@_count"]);
  if (
    (count !== undefined && (!/^\d+$/.test(count) || Number(count) !== meetings.length)) ||
    root["@_has_more"] === "true" ||
    optionalString(root["@_next_cursor"])
  )
    throw providerResponseError(
      "Granola meeting list is truncated; this sync cannot advance past incomplete discovery.",
    );
  if (new Set(meetings.map((meeting) => meeting["@_id"])).size !== meetings.length)
    throw providerResponseError("Granola returned duplicate meeting IDs.");
  return meetings.map((meeting) => ({
    id: meeting["@_id"],
    title: meeting["@_title"],
    date: meeting["@_date"],
    attendees: meeting.known_participants,
    summary: meeting.summary,
  }));
}

/** Preserve authored transcript text, including speaker labels and timestamps, without rewriting prose. */
export function parseTranscript(text: string, meetingId: string): string {
  let transcript: string;
  const value = text.trim();
  if (value.startsWith("{")) {
    const data = requiredResponseRecord(JSON.parse(value), "Granola transcript");
    if (data.id !== meetingId) throw providerResponseError("Granola returned a different transcript identity.");
    transcript = requiredRawString(data.transcript, "Granola transcript", providerResponseError);
  } else if (value.startsWith("<transcript")) {
    if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw providerResponseError("Unsupported Granola transcript XML.");
    SyntaxValidator.validate(value);
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

/** One complete Markdown record; meeting dates are display context, not invented creation/update times. */
export function renderMeeting(meeting: GranolaMeeting, transcript: string): SyncRecordInput {
  const summary = requiredRawString(meeting.summary, "Granola meeting summary", providerResponseError);
  if (!summary.trim() || /^no summary\b/i.test(summary.trim()))
    throw providerResponseError("Granola meeting summary is not available yet.");
  const labels = meeting.attendees
    .split(/>\s*,\s*/)
    .map((entry, index, entries) => (index < entries.length - 1 ? `${entry}>` : entry).trim())
    .filter(Boolean)
    .sort();
  const participants: SyncParticipant[] = [];
  const emails = new Set<string>();
  for (const label of labels) {
    const match = label.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
    if (!match) continue; // Display names alone are not identities.
    const email = match[2]!.toLowerCase();
    if (emails.has(email)) continue;
    emails.add(email);
    participants.push({
      identities: [{ namespace: "email", id: email }],
      roles: ["attendee"],
      name: optionalString(match[1]!.replace(/\s*\(note creator\)\s*/i, " ")),
    });
  }
  const sourceUrl = `https://notes.granola.ai/d/${encodeURIComponent(meeting.id)}`;
  const body = [`# ${meeting.title || "Untitled meeting"}`, "", `- Granola: ${sourceUrl}`];
  if (meeting.date) body.push(`- Meeting date: ${meeting.date}`);
  if (labels.length) body.push(`- Attendees: ${[...new Set(labels)].join(", ")}`);
  body.push("", "## Summary", "", summary, "", "## Transcript", "", transcript);
  return { id: meeting.id, body: body.join("\n"), sourceUrl, participants };
}
