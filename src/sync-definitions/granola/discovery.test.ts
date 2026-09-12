import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { describe, expect, it, vi } from "vitest";
import { McpResponseSizeError } from "../../providers/mcp-client.ts";
import { describeSyncAsset } from "../../sync/asset-store.ts";
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
    assets: { stage: async (input) => describeSyncAsset(input) },
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
      { id: "historical", date: "2023-01-01" },
      ...Array.from({ length: 1205 }, (_, index) => ({ id: `meeting-${index}`, date: "2026-09-08" })),
    ];
    const { context, request } = fixture(meetings);
    const batches = await Array.fromAsync(discover(context));
    expect([...new Set(batches.flatMap((batch) => batch.ids))].sort()).toEqual(
      meetings.map((meeting) => meeting.id).sort(),
    );
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({
      time_range: "custom",
      custom_start: "2023-01-01",
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
    expect(batches.at(-1)).toMatchObject({
      complete: true,
      checkpoint: {
        pendingIds: null,
        scan: null,
        polling: { watermark: context.startedAt, reconciledAt: context.startedAt, customRanges: true },
      },
    });
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
      date: "2023-04-03",
    }));
    const { context, request } = fixture(meetings);
    const iterator = discover(context);
    const first = (await iterator.next()).value!;
    await iterator.return(undefined);
    meetings.push({ id: "inserted-before-cursor", date: "2023-04-03" });
    request.mockClear();
    const resumed = await Array.fromAsync(
      discover({ ...context, checkpoint: first.checkpoint, startedAt: "2026-10-09T12:00:00.000Z" }),
    );
    expect(resumed.flatMap((batch) => batch.ids)).toEqual(["meeting-10", "meeting-11", "meeting-12"]);
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({
      time_range: "custom",
      custom_start: "2023-01-01",
      custom_end: "2026-09-10",
    });
    const nextCycle = await Array.fromAsync(
      discover({ ...context, checkpoint: resumed.at(-1)!.checkpoint, startedAt: "2026-10-10T12:00:00.000Z" }),
    );
    expect(nextCycle.flatMap((batch) => batch.ids)).toContain("inserted-before-cursor");
  });

  it("uses server defaults when custom ranges are unavailable and picks up newly advertised history", async () => {
    const { context, state, request } = fixture([{ id: "accessible", date: "2023-04-03" }], false);
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
      scan: { ranges: [{ start: "2023-01-01", end: "2024-01-01" }], afterId: "z-last-committed" },
    };
    expect(
      (await Array.fromAsync(discover({ ...context, checkpoint: customSaved }))).flatMap((batch) => batch.ids),
    ).toEqual(["accessible"]);
  });

  it("finishes a legacy ID queue and then starts full history without changing the definition version", async () => {
    const { context } = fixture([{ id: "historical", date: "2023-04-03" }]);
    const checkpoint = { pendingIds: ["unfinished"] };
    validateSyncValue(checkpoint, granolaMeetings.checkpointSchema, "Legacy checkpoint");
    const batches = await Array.fromAsync(discover({ ...context, checkpoint }));
    expect(batches[0]).toEqual({
      ids: ["unfinished"],
      checkpoint: { ...(granolaMeetings.initialCheckpoint as JsonObject), polling: null },
      complete: false,
    });
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

  it.each([true, false])(
    "polls recent meetings after backfill, then reconciles old arrivals daily (custom=%s)",
    async (custom) => {
      const meetings = [{ id: "old", date: "2023-04-03" }];
      const { context, request } = fixture(meetings, custom);
      const historical = await Array.fromAsync(discover(context));
      expect(historical.flatMap((batch) => batch.ids)).toEqual(["old"]);
      let checkpoint = historical.at(-1)!.checkpoint;
      request.mockClear();
      const empty = await Array.fromAsync(discover({ ...context, checkpoint, startedAt: "2026-09-09T13:00:00.000Z" }));
      expect(empty.flatMap((batch) => batch.ids)).toEqual([]);
      expect(empty.at(-1)).toMatchObject({
        complete: true,
        checkpoint: { polling: { watermark: "2026-09-09T13:00:00.000Z", reconciledAt: context.startedAt } },
      });
      expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual(
        custom
          ? {
              time_range: "custom",
              custom_start: "2026-09-08",
              custom_end: "2026-09-10",
            }
          : {},
      );
      checkpoint = empty.at(-1)!.checkpoint;
      meetings.push(
        { id: "new", date: "2026-09-09" },
        { id: "overlap", date: "2026-09-08" },
        { id: "late-old", date: "2023-04-03" },
      );
      const recent = await Array.fromAsync(discover({ ...context, checkpoint, startedAt: "2026-09-09T14:00:00.000Z" }));
      expect(recent.flatMap((batch) => batch.ids)).toEqual(["new", "overlap"]);
      const reconciled = await Array.fromAsync(
        discover({ ...context, checkpoint: recent.at(-1)!.checkpoint, startedAt: "2026-09-10T12:00:00.000Z" }),
      );
      expect(reconciled.flatMap((batch) => batch.ids)).toEqual(["late-old", "new", "old", "overlap"]);
      expect(reconciled.at(-1)).toMatchObject({
        checkpoint: { polling: { reconciledAt: "2026-09-10T12:00:00.000Z" } },
      });
    },
  );

  it("keeps the polling cutoff and watermark fixed across interrupted batches and downtime", async () => {
    const meetings: Meeting[] = [];
    const { context, request } = fixture(meetings);
    const first = await Array.fromAsync(discover(context));
    meetings.push(
      ...Array.from({ length: 13 }, (_, index) => ({
        id: `meeting-${String(index).padStart(2, "0")}`,
        date: "2026-09-09",
      })),
    );
    const iterator = discover({
      ...context,
      checkpoint: first.at(-1)!.checkpoint,
      startedAt: "2026-09-09T13:00:00.000Z",
    });
    const committed = (await iterator.next()).value!;
    await iterator.return(undefined);
    expect(committed.checkpoint.polling).toEqual(first.at(-1)!.checkpoint.polling);
    expect(committed.checkpoint.scan).toMatchObject({
      startedAt: "2026-09-09T13:00:00.000Z",
      from: "2026-09-08",
      afterId: "meeting-09",
    });
    request.mockClear();
    const resumed = await Array.fromAsync(
      discover({ ...context, checkpoint: committed.checkpoint, startedAt: "2026-10-09T12:00:00.000Z" }),
    );
    expect(resumed.flatMap((batch) => batch.ids)).toEqual(["meeting-10", "meeting-11", "meeting-12"]);
    expect(request.mock.calls.find(([operation]) => operation === "list_meetings")?.[1]).toEqual({
      time_range: "custom",
      custom_start: "2026-09-08",
      custom_end: "2026-09-10",
    });
    expect(resumed.at(-1)).toMatchObject({
      checkpoint: { polling: { watermark: "2026-09-09T13:00:00.000Z", reconciledAt: context.startedAt } },
    });
  });

  it("keeps undated and unrecognized dates eligible and compares display dates without timezone shifts", async () => {
    const { context, request } = fixture([], false);
    const first = await Array.fromAsync(discover(context));
    const read = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input) =>
      operation === "list_meetings"
        ? {
            text: '<meetings_data><meeting title="Meeting" id="old" date="Sep 7, 2026 11:59 PM GMT+1"/><meeting title="Meeting" id="edge" date="September 8, 2026 12:00 AM"/><meeting title="Meeting" id="iso" date="2026-09-08T00:00:00+14:00"/><meeting title="Meeting" id="missing" date=""/><meeting title="Meeting" id="unknown" date="Yesterday"/><meeting title="Meeting" id="invalid" date="2026-02-30"/></meetings_data>',
          }
        : read(operation, input),
    );
    const recent = await Array.fromAsync(
      discover({ ...context, checkpoint: first.at(-1)!.checkpoint, startedAt: "2026-09-09T13:00:00.000Z" }),
    );
    expect(recent.flatMap((batch) => batch.ids)).toEqual(["edge", "invalid", "iso", "missing", "unknown"]);
  });

  it("reconciles newly accessible history when custom filters become available after a completed scan", async () => {
    const { context, state } = fixture([{ id: "old", date: "2023-04-03" }], false);
    const first = await Array.fromAsync(discover(context));
    state.custom = true;
    const next = await Array.fromAsync(
      discover({ ...context, checkpoint: first.at(-1)!.checkpoint, startedAt: "2026-09-09T13:00:00.000Z" }),
    );
    expect(next.flatMap((batch) => batch.ids)).toEqual(["old"]);
    expect(next.at(-1)).toMatchObject({ checkpoint: { polling: { customRanges: true } } });
  });
});
