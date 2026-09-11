import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { describe, expect, it, vi } from "vitest";
import { McpResponseSizeError } from "../../providers/mcp-client.ts";
import { validateSyncValue } from "../../sync/sync-validation.ts";
import { granolaMeetings } from "./definition.ts";
import { discover } from "./discovery.ts";

interface Meeting {
  id: string;
  date: string;
}

function fixture(meetings: Meeting[], custom = true) {
  const state = { custom, truncateAbove: Infinity, oversizeAbove: Infinity };
  const request = vi.fn(async (operation: string, input: JsonObject = {}): Promise<JsonObject> => {
    if (operation === "list_tools")
      return {
        tools: [
          {
            name: "list_meetings",
            inputSchema: {
              type: "object",
              properties: state.custom
                ? {
                    time_range: { type: "string", enum: ["custom"] },
                    custom_start: { type: "string" },
                    custom_end: { type: "string" },
                  }
                : {},
            },
          },
        ],
      };
    if (operation !== "list_meetings") throw new Error("Unexpected operation");
    if (state.custom) {
      expect(input.time_range).toBe("custom");
      expect(Object.keys(input).sort()).toEqual(["custom_end", "custom_start", "time_range"]);
    } else expect(input).toEqual({});
    const selected = meetings.filter(
      (meeting) =>
        !state.custom || (meeting.date >= String(input.custom_start) && meeting.date <= String(input.custom_end)),
    );
    if (selected.length > state.oversizeAbove) throw new McpResponseSizeError();
    const truncated = selected.length > state.truncateAbove;
    const returned = selected.slice(0, state.truncateAbove);
    return {
      text: `<meetings_data count="${returned.length}" has_more="${truncated}">${returned
        .map((meeting) => `<meeting id="${meeting.id}" title="Meeting" date="${meeting.date}"/>`)
        .join("")}</meetings_data>`,
    };
  });
  const context: SyncContext = {
    provider: { request },
    config: granolaMeetings.defaultConfig,
    checkpoint: granolaMeetings.initialCheckpoint,
    sourceId: "account",
    startedAt: "2026-09-09T12:00:00.000Z",
    signal: new AbortController().signal,
  };
  return { context, request, state };
}

describe("Granola history discovery", () => {
  it("covers all accessible history and accepts more than 1,000 meetings on one date", async () => {
    const meetings = [
      { id: "historical", date: "2001-04-03" },
      ...Array.from({ length: 1205 }, (_, index) => ({ id: `meeting-${index}`, date: "2026-09-08" })),
    ];
    const { context, request } = fixture(meetings);
    const batches = await Array.fromAsync(discover(context));
    expect([...new Set(batches.flatMap((batch) => batch.ids))].sort()).toEqual(
      meetings.map((meeting) => meeting.id).sort(),
    );
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({
      time_range: "custom",
      custom_start: "0001-01-01",
      custom_end: "2026-09-10",
    });
    for (const batch of batches) {
      expect(batch.ids.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(batch.checkpoint).length).toBeLessThan(2000);
      expect(batch.checkpoint.pendingIds).toBeNull();
      expect(validateSyncValue(batch.checkpoint, granolaMeetings.checkpointSchema, "Checkpoint")).toEqual(
        batch.checkpoint,
      );
    }
    expect(batches.at(-1)).toMatchObject({ complete: true, checkpoint: granolaMeetings.initialCheckpoint });
  });

  it.each(["truncated", "oversized"])("subdivides %s ranges without dropping boundary meetings", async (failure) => {
    const meetings = Array.from({ length: 90 }, (_, index) => ({
      id: `meeting-${index}`,
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    }));
    const { context, state } = fixture(meetings);
    if (failure === "truncated") state.truncateAbove = 10;
    else state.oversizeAbove = 10;
    const batches = await Array.fromAsync(discover(context));
    expect(batches.some((batch) => !batch.ids.length && !batch.complete)).toBe(true);
    expect([...new Set(batches.flatMap((batch) => batch.ids))].sort()).toEqual(
      meetings.map((meeting) => meeting.id).sort(),
    );
    expect(batches.at(-1)?.complete).toBe(true);
  });

  it("resumes fixed ranges without moving their dates and reconciles IDs inserted behind the cursor next cycle", async () => {
    const meetings = Array.from({ length: 13 }, (_, index) => ({
      id: `meeting-${String(index).padStart(2, "0")}`,
      date: "2001-04-03",
    }));
    const { context, request } = fixture(meetings);
    const iterator = discover(context);
    const first = (await iterator.next()).value!;
    await iterator.return(undefined);
    meetings.push({ id: "inserted-before-cursor", date: "2001-04-03" });
    request.mockClear();
    const resumed = await Array.fromAsync(
      discover({ ...context, checkpoint: first.checkpoint, startedAt: "2026-10-09T12:00:00.000Z" }),
    );
    expect(resumed.flatMap((batch) => batch.ids)).toEqual(["meeting-10", "meeting-11", "meeting-12"]);
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({
      time_range: "custom",
      custom_start: "0001-01-01",
      custom_end: "2026-09-10",
    });
    const nextCycle = await Array.fromAsync(discover({ ...context, checkpoint: resumed.at(-1)!.checkpoint }));
    expect(nextCycle.flatMap((batch) => batch.ids)).toContain("inserted-before-cursor");
  });

  it("uses server defaults when custom ranges are unavailable and picks up newly advertised history", async () => {
    const { context, state, request } = fixture([{ id: "accessible", date: "2001-04-03" }], false);
    const batches = await Array.fromAsync(discover(context));
    expect(batches.flatMap((batch) => batch.ids)).toEqual(["accessible"]);
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({});
    state.custom = true;
    const saved = { pendingIds: null, scan: { ranges: [null], afterId: "z-last-committed" } };
    expect((await Array.fromAsync(discover({ ...context, checkpoint: saved }))).flatMap((batch) => batch.ids)).toEqual([
      "accessible",
    ]);
    state.custom = false;
    const customSaved = {
      pendingIds: null,
      scan: { ranges: [{ start: "2001-01-01", end: "2002-01-01" }], afterId: "z-last-committed" },
    };
    expect(
      (await Array.fromAsync(discover({ ...context, checkpoint: customSaved }))).flatMap((batch) => batch.ids),
    ).toEqual(["accessible"]);
  });

  it("finishes a legacy ID queue and then starts full history without changing the definition version", async () => {
    const { context } = fixture([{ id: "historical", date: "2001-04-03" }]);
    const checkpoint = { pendingIds: ["unfinished"] };
    validateSyncValue(checkpoint, granolaMeetings.checkpointSchema, "Legacy checkpoint");
    const batches = await Array.fromAsync(discover({ ...context, checkpoint }));
    expect(batches[0]).toEqual({ ids: ["unfinished"], checkpoint: granolaMeetings.initialCheckpoint, complete: false });
    expect(batches.flatMap((batch) => batch.ids)).toEqual(["unfinished", "historical"]);
    expect(batches.at(-1)?.complete).toBe(true);
  });

  it("follows tool-schema pagination and refuses missing or repeated discovery", async () => {
    const { context, request } = fixture([]);
    const read = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}) =>
      operation === "list_tools" && !input.cursor ? { tools: [], nextCursor: "tools-page-2" } : read(operation, input),
    );
    await Array.fromAsync(discover(context));
    expect(request).toHaveBeenCalledWith("list_tools", { cursor: "tools-page-2" });
    request.mockResolvedValue({ tools: [], nextCursor: "same" });
    await expect(Array.fromAsync(discover(context))).rejects.toThrow("repeated");
    request.mockResolvedValue({ tools: [] });
    await expect(Array.fromAsync(discover(context))).rejects.toThrow("does not advertise");
  });

  it("fails an unsplittable truncated range instead of committing incomplete discovery", async () => {
    const { context, state } = fixture([{ id: "meeting", date: "2026-09-08" }]);
    state.truncateAbove = 0;
    const iterator = discover({
      ...context,
      checkpoint: {
        pendingIds: null,
        scan: { ranges: [{ start: "2026-09-08", end: "2026-09-09" }], afterId: null },
      },
    });
    await expect(iterator.next()).rejects.toThrow("truncated");
  });
});
