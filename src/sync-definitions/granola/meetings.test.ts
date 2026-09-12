import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { describe, expect, it, vi } from "vitest";
import { parseMeetings, parseTranscript } from "../../providers/granola/mcp-response.ts";
import { normalizeSyncRecord } from "../../sync/record-contract.ts";
import { validateSyncValue } from "../../sync/sync-validation.ts";
import { granolaMeetings } from "./definition.ts";
import { run } from "./meetings.ts";
import { renderMeeting } from "./render.ts";

const details = (id: string, summary = "## Decisions\n\n- Keep authored **Markdown** & code `a < b`.") =>
  `<meeting id="${id}" title="Roadmap &amp; delivery" date="Sep 8, 2026 2:30 PM"><known_participants>Ada &lt;ada@example.com&gt;, Max (note creator) &lt;max@example.com&gt;</known_participants><summary><![CDATA[${summary}]]></summary><private_notes>private sentinel</private_notes><debug>debug sentinel</debug></meeting>`;
const list = (ids: string[]) =>
  `<meetings_data count="${ids.length}">${ids.map((id) => details(id)).join("")}</meetings_data>`;
function fixture(ids = ["a", "b"]) {
  const request = vi.fn(async (operation: string, input: JsonObject = {}): Promise<JsonObject> => {
    if (operation === "list_tools") return { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }] };
    if (operation === "list_meetings") return { text: list(ids) };
    if (operation === "get_meetings") return { text: list(input.meeting_ids as string[]) };
    if (operation === "get_meeting_transcript")
      return {
        text: JSON.stringify({
          id: input.meeting_id,
          transcript: "[00:10] Me: Preserve what was said. Them: Yes & thank you.",
        }),
      };
    throw new Error("Unexpected read operation");
  });
  const context: SyncContext = {
    provider: { request },
    config: { includeTranscript: true },
    checkpoint: granolaMeetings.initialCheckpoint,
    sourceId: "account",
    signal: new AbortController().signal,
    startedAt: "2026-09-09T00:00:00Z",
  };
  return { context, request };
}

describe("Granola meeting acquisition", () => {
  it("syncs summaries without requesting transcripts or adding discovery filters", async () => {
    const { context, request } = fixture(["a"]);
    const pages = await Array.fromAsync(run({ ...context, config: granolaMeetings.defaultConfig }));
    const record = pages[0]!.records![0]!.record;
    expect(normalizeSyncRecord(record, granolaMeetings.kinds[0]!)).toMatchObject({
      id: "a",
      content: { value: { title: "Roadmap & delivery" } },
    });
    expect(record.body).not.toContain("## Transcript");
    expect(record.body).not.toContain("Not included in this sync");
    expect(request.mock.calls.map(([name]) => name)).toEqual(["list_tools", "list_meetings", "get_meetings"]);
    expect(request.mock.calls.find(([name]) => name === "list_meetings")?.[1]).toEqual({});
  });
  it("combines both endpoints into deterministic Markdown without inventing source timestamps", async () => {
    const { context } = fixture(["a"]);
    const pages = await Array.fromAsync(run(context));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ complete: true, checkpoint: { pendingIds: null } });
    const record = pages[0]!.records![0]!.record;
    const normalized = normalizeSyncRecord(record, granolaMeetings.kinds[0]!);
    expect(record).toMatchObject({ id: "a", title: "Roadmap & delivery", sourceUrl: "https://notes.granola.ai/d/a" });
    expect(record.body).toContain("# Roadmap & delivery");
    expect(record.body).toContain("## Summary\n\n## Decisions\n\n- Keep authored **Markdown** & code `a < b`.");
    expect(record.body).toContain("## Transcript\n\n[00:10] Me: Preserve what was said. Them: Yes & thank you.");
    expect(record.sourceCreatedAt).toBeUndefined();
    expect(record.sourceUpdatedAt).toBeUndefined();
    expect(record.participants).toHaveLength(2);
    expect(JSON.stringify(normalized)).not.toMatch(/private sentinel|debug sentinel/);
    expect(normalizeSyncRecord(record, granolaMeetings.kinds[0]!)).toEqual(normalized);
  });

  it("resumes after the committed ID and completes every hydration batch", async () => {
    const { context, request } = fixture(Array.from({ length: 13 }, (_, index) => String(index).padStart(2, "0")));
    const first = run(context);
    const page = (await first.next()).value!;
    await first.return(undefined);
    request.mockClear();
    const resumed = await Array.fromAsync(run({ ...context, checkpoint: page.checkpoint }));
    expect(resumed.flatMap((item) => item.records ?? []).map((item) => item.record.id)).toEqual(
      Array.from({ length: 3 }, (_, index) => String(index + 10).padStart(2, "0")),
    );
    expect(page.records).toHaveLength(10);
    expect(page.checkpoint).toEqual({ pendingIds: null, scan: { ranges: [null], afterId: "09" } });
    expect(resumed.at(-1)?.complete).toBe(true);
  });

  it("syncs more than 1,000 meetings in bounded batches with a constant-size checkpoint", async () => {
    const ids = Array.from({ length: 1205 }, (_, index) => `meeting-${index}`);
    const { context } = fixture(ids);
    const pages = await Array.fromAsync(run({ ...context, config: granolaMeetings.defaultConfig }));
    expect(pages.flatMap((page) => page.records ?? []).map((item) => item.record.id)).toEqual(ids.sort());
    for (const page of pages) {
      expect(page.records!.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(page.checkpoint).length).toBeLessThan(128);
      expect(validateSyncValue(page.checkpoint, granolaMeetings.checkpointSchema, "Checkpoint")).toEqual(
        page.checkpoint,
      );
    }
    expect(pages.at(-1)).toMatchObject({ complete: true, checkpoint: granolaMeetings.initialCheckpoint });
  });

  it("rehydrates accessible meetings and never infers deletion from an empty scan", async () => {
    const { context, request } = fixture(["unchanged-native-id"]);
    const first = (await Array.fromAsync(run(context)))[0]!;
    const transport = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}) =>
      operation === "list_tools"
        ? transport(operation, input)
        : {
            text:
              operation === "get_meeting_transcript"
                ? JSON.stringify({ id: input.meeting_id, transcript: "An edited transcript." })
                : list(["unchanged-native-id"]),
          },
    );
    const updated = (await Array.fromAsync(run({ ...context, checkpoint: first.checkpoint })))[0]!;
    expect(updated.records![0]!.record.id).toBe(first.records![0]!.record.id);
    expect(updated.records![0]!.record.body).toContain("An edited transcript.");
    expect(updated.records![0]!.record.body).not.toEqual(first.records![0]!.record.body);
    const empty = fixture([]);
    expect(await Array.fromAsync(run(empty.context))).toEqual([
      { records: [], checkpoint: granolaMeetings.initialCheckpoint, complete: true },
    ]);
  });

  it("keeps progress before a failed batch and rejects incomplete details", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `a${String(index).padStart(2, "0")}`);
    const { context, request } = fixture(ids);
    const transport = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input) => {
      if (operation === "get_meeting_transcript" && input?.meeting_id === "a10") throw new Error("Transcript failed");
      return transport(operation, input);
    });
    const iterator = run(context);
    const page = (await iterator.next()).value!;
    expect(page).toMatchObject({ checkpoint: { pendingIds: null, scan: { afterId: "a09" } }, complete: false });
    await expect(iterator.next()).rejects.toThrow("Transcript failed");
    request.mockImplementation(async (operation, input) =>
      operation === "get_meetings" ? { text: list([]) } : transport(operation, input),
    );
    await expect(Array.fromAsync(run({ ...context, checkpoint: page.checkpoint }))).rejects.toThrow(
      "every requested meeting",
    );
  });

  it("validates XML, identities, discovery counts, and missing required content", () => {
    expect(() => parseMeetings("not XML")).toThrow();
    expect(() => parseMeetings(`<meetings_data count="2">${details("a")}</meetings_data>`)).toThrow("truncated");
    expect(() => parseMeetings(list(["a", "a"]))).toThrow("duplicate");
    expect(() => parseMeetings('<!DOCTYPE x [<!ENTITY x "expanded">]><meetings_data/>')).toThrow();
    expect(() => parseTranscript('{"id":"other","transcript":"wrong meeting"}', "a")).toThrow("identity");
    expect(() => parseTranscript("No transcript available", "a")).toThrow("not available");
    const meeting = parseMeetings(`<meetings_data>${details("a", "No summary")}</meetings_data>`)[0]!;
    expect(() => renderMeeting(meeting, "Transcript")).toThrow("not available");
    expect(parseTranscript('<transcript meeting_id="a"><![CDATA[Me: A & B < C]]></transcript>', "a")).toBe(
      "Me: A & B < C",
    );
    const guest = renderMeeting({ ...meeting, summary: "Summary", attendees: "A guest" }, "Transcript");
    expect(guest.participants).toEqual([]);
    expect(guest.body).toContain("A guest");
    const authored = renderMeeting(
      { ...meeting, summary: "    indented code\n\nA paragraph." },
      "  A speaker's words.",
    );
    expect(authored.body).toContain("## Summary\n\n    indented code");
    expect(authored.body).toContain("## Transcript\n\n  A speaker's words.");
    expect(renderMeeting({ ...meeting, title: "   ", summary: "Summary" }).title).toBe("Untitled meeting");
    expect(() => parseMeetings(`<meetings_data has_more="true">${details("a")}</meetings_data>`)).toThrow("truncated");
    expect(() => parseMeetings(`<meetings_data next_cursor="next">${details("a")}</meetings_data>`)).toThrow(
      "truncated",
    );
  });

  it("accepts access notices beside meeting data without weakening fragment validation", () => {
    const notice = "<access_notice>Only recent personal notes are available on this plan.</access_notice>";
    const response = `${notice}\n\n${list(["a"])}`;
    const meetings = parseMeetings(response);
    expect(meetings).toEqual(parseMeetings(list(["a"])));
    expect(renderMeeting(meetings[0]!).body).not.toContain("Only recent personal notes");
    expect(() => parseMeetings(`<access_notice>Unclosed notice\n${list(["a"])}`)).toThrow("malformed");
    expect(() => parseMeetings(`${notice}<meetings_data count="2">${details("a")}</meetings_data>`)).toThrow(
      "truncated",
    );
    expect(() => parseMeetings(notice)).toThrow("meeting list");
  });

  it("preserves identity and detects title changes while normalizing participant order", async () => {
    const meeting = parseMeetings(list(["a"]))[0]!;
    const record = renderMeeting(meeting, "Transcript");
    const reordered = renderMeeting(
      { ...meeting, attendees: "Max (note creator) <max@example.com>, Ada <ada@example.com>" },
      "Transcript",
    );
    expect(normalizeSyncRecord(reordered, granolaMeetings.kinds[0]!)).toEqual(
      normalizeSyncRecord(record, granolaMeetings.kinds[0]!),
    );
    const retitled = renderMeeting({ ...meeting, title: "Updated title" }, "Transcript");
    expect(retitled.id).toBe(record.id);
    expect(normalizeSyncRecord(retitled, granolaMeetings.kinds[0]!)).not.toEqual(
      normalizeSyncRecord(record, granolaMeetings.kinds[0]!),
    );
  });

  it("stops cancelled acquisition before hydrating a saved checkpoint", async () => {
    const { context, request } = fixture();
    await expect(
      Array.fromAsync(
        run({ ...context, checkpoint: { pendingIds: ["a"] }, signal: AbortSignal.abort(new Error("Cancelled")) }),
      ),
    ).rejects.toThrow("Cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});
