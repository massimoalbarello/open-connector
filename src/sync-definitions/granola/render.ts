import type { GranolaMeeting } from "../../providers/granola/actions.ts";
import type { SyncParticipant, SyncRecordInput } from "../../sync/record-contract.ts";

import { optionalString, requiredRawString } from "../../core/cast.ts";
import { providerResponseError } from "../../providers/provider-runtime.ts";

/** One complete Markdown record; meeting dates are display context, not invented creation/update times. */
export function renderMeeting(meeting: GranolaMeeting, transcript?: string): SyncRecordInput {
  const summary = requiredRawString(meeting.summary, "Granola meeting summary", providerResponseError);
  if (!summary.trim() || /^no summary\b/i.test(summary.trim()))
    throw providerResponseError("Granola meeting summary is not available yet.");
  const labels = (meeting.attendees ?? "")
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
  const title = meeting.title?.trim() || "Untitled meeting";
  const body = [`# ${title}`, "", `- Granola: ${sourceUrl}`];
  if (meeting.date) body.push(`- Meeting date: ${meeting.date}`);
  if (labels.length) body.push(`- Attendees: ${[...new Set(labels)].join(", ")}`);
  body.push("", "## Summary", "", summary);
  if (transcript) body.push("", "## Transcript", "", transcript);
  return { id: meeting.id, title, body: body.join("\n"), sourceUrl, participants };
}
