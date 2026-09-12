import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { looseArray, optionalRecord, optionalString, requiredRawString } from "../../core/cast.ts";
import { GranolaTruncatedMeetingsError, parseGranolaMeetings } from "../../providers/granola/mcp-response.ts";
import { McpResponseSizeError } from "../../providers/mcp-client.ts";
import { providerResponseError, requiredResponseRecord } from "../../providers/provider-runtime.ts";

interface MeetingRange extends JsonObject {
  start: string;
  end: string;
}

interface MeetingScan extends JsonObject {
  ranges: (MeetingRange | null)[];
  afterId: string | null;
}

interface PollingProgress extends JsonObject {
  watermark: string;
  reconciledAt: string;
  customRanges: boolean;
}

interface DiscoveryBatch {
  ids: string[];
  checkpoint: JsonObject;
  complete: boolean;
}

const dayMilliseconds = 86_400_000;
const discoveryBatchSize = 100;
// Granola began in early 2023, before its public launch: https://www.granola.ai/blog/series-a
const historyStart = "2023-01-01";

/**
 * Scan every accessible meeting. MCP has date filters but no meeting-page cursor. Inspect its
 * advertised schema each run: scan from Granola's founding year through the next UTC date
 * when custom ranges are supported, otherwise send no filters and accept the server's scope.
 * Never infer a subscription, ownership restriction, or rolling lookback from account metadata.
 *
 * Split crowded, truncated, or oversized ranges, retaining overlapping date boundaries so ties
 * cannot fall between them. A single day can contain any number of meetings; hydrate ten at a
 * time, persisting only the last committed native ID. The range stack is logarithmic in calendar
 * span (under 32 entries), independent of meeting count. Empty/split ranges yield progress too.
 *
 * On resume, re-list the same fixed range and continue after its committed ID in lexical order.
 * After backfill, polling.watermark retains the start of the completed scan. Frequent polls
 * start one calendar day earlier, covering date-only timestamps, timezone boundaries and delayed
 * summary generation. Use the filter upstream when advertised; otherwise list metadata with no
 * filters and hydrate only meetings at/after that date. Empty/unrecognized dates are always
 * hydrated. This is a meeting-date window, not an updated-at feed: old edits, late arrivals and
 * IDs inserted behind a committed lexical cursor are recovered by a full reconciliation daily.
 * polling.reconciledAt schedules that reconciliation; customRanges detects capability changes
 * and forces a full scan. No subscription rules or total-history cap are imposed.
 *
 * scan.startedAt and scan.from stay fixed across interrupted runs. Advance the polling watermark
 * only with the last hydrated batch, never to the later resume/completion time. No scan is an
 * upstream snapshot; never infer deletion from absence. If even the smallest range is truncated
 * or exceeds the transport's byte budget, fail without skipping its data.
 *
 * Version 1 compatibility: drain legacy pendingIds and resume legacy ranges before transitioning.
 * A completed legacy checkpoint has no polling watermark, so it needs one full reconciliation.
 * All added checkpoint fields are optional; saved record identities are unchanged.
 */
export async function* discover(context: SyncContext): AsyncGenerator<DiscoveryBatch> {
  const checkpoint = context.checkpoint as JsonObject;
  const polling = (checkpoint.polling as PollingProgress | null | undefined) ?? null;
  let pending = checkpoint.pendingIds as string[] | null;
  while (pending?.length) {
    context.signal.throwIfAborted();
    const ids = pending.slice(0, 10);
    pending = pending.slice(ids.length);
    yield { ids, checkpoint: { pendingIds: pending.length ? pending : null, scan: null, polling }, complete: false };
  }

  const customRanges = await supportsCustomRanges(context);
  const due =
    !polling ||
    polling.customRanges !== customRanges ||
    Date.parse(context.startedAt) - Date.parse(polling.reconciledAt) >= dayMilliseconds;
  const from = due ? null : new Date(Date.parse(polling.watermark) - dayMilliseconds).toISOString().slice(0, 10);
  const available: MeetingScan = {
    ranges: customRanges
      ? [
          {
            start: from && from > historyStart ? from : historyStart,
            end: new Date(Date.parse(context.startedAt) + dayMilliseconds).toISOString().slice(0, 10),
          },
        ]
      : [null],
    afterId: null,
    startedAt: context.startedAt,
    from,
  };
  const saved = checkpoint.scan as MeetingScan | null | undefined;
  // Restart discovery if the advertised request shape changes; committed records keep their identities.
  let scan: MeetingScan | null =
    saved && (saved.ranges[0] === null) === (available.ranges[0] === null) ? saved : available;
  // A legacy fixed range may have ended before this run. Keep the next poll behind that boundary.
  const legacyEnd = scan.ranges.at(-1)?.end;
  const startedAt =
    optionalString(scan.startedAt) ??
    new Date(
      Math.min(Date.parse(context.startedAt), legacyEnd ? Date.parse(`${legacyEnd}T00:00:00Z`) : Infinity),
    ).toISOString();
  const scanFrom = optionalString(scan.from) ?? null;
  scan = { ...scan, startedAt, from: scanFrom };
  const progress = (next: MeetingScan | null): JsonObject => ({
    pendingIds: null,
    scan: next,
    polling: next
      ? polling
      : {
          watermark: startedAt,
          reconciledAt: scanFrom === null ? context.startedAt : polling!.reconciledAt,
          customRanges,
        },
  });
  while (scan) {
    context.signal.throwIfAborted();
    const range: MeetingRange | null = scan.ranges[0] ?? null;
    const halves: MeetingRange[] | undefined = range ? splitRange(range) : undefined;
    let ids: string[];
    try {
      const input: JsonObject = range ? { time_range: "custom", custom_start: range.start, custom_end: range.end } : {};
      const result = await context.provider.request("list_meetings", input);
      ids = parseGranolaMeetings(requiredRawString(result.text, "Granola meeting list", providerResponseError))
        .filter((meeting) => {
          const date = meetingDate(meeting.date);
          return scanFrom === null || date === undefined || date >= scanFrom;
        })
        .map((meeting) => meeting.id)
        .sort();
    } catch (error) {
      if (!halves || !(error instanceof GranolaTruncatedMeetingsError || error instanceof McpResponseSizeError))
        throw error;
      scan = { ...scan, ranges: [...halves, ...scan.ranges.slice(1)], afterId: null };
      yield { ids: [], checkpoint: progress(scan), complete: false };
      continue;
    }
    if (halves && ids.length > discoveryBatchSize && scan.afterId === null) {
      scan = { ...scan, ranges: [...halves, ...scan.ranges.slice(1)], afterId: null };
      yield { ids: [], checkpoint: progress(scan), complete: false };
      continue;
    }

    const afterId = scan.afterId;
    const remaining = ids.filter((id) => afterId === null || id > afterId);
    const currentRanges: (MeetingRange | null)[] = scan.ranges;
    const ranges = currentRanges.slice(1);
    if (!remaining.length) {
      scan = ranges.length ? { ranges, afterId: null, startedAt, from: scanFrom } : null;
      yield { ids: [], checkpoint: progress(scan), complete: scan === null };
      continue;
    }
    for (let offset = 0; offset < remaining.length; offset += 10) {
      const batch = remaining.slice(offset, offset + 10);
      scan =
        offset + batch.length < remaining.length
          ? { ranges: currentRanges, afterId: batch.at(-1)!, startedAt, from: scanFrom }
          : ranges.length
            ? { ranges, afterId: null, startedAt, from: scanFrom }
            : null;
      yield { ids: batch, checkpoint: progress(scan), complete: scan === null };
    }
  }
}

async function supportsCustomRanges(context: SyncContext): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    context.signal.throwIfAborted();
    const result = await context.provider.request("list_tools", cursor ? { cursor } : {});
    for (const item of looseArray(result.tools)) {
      const tool = requiredResponseRecord(item, "Granola MCP tool");
      if (tool.name !== "list_meetings") continue;
      const schema = requiredResponseRecord(tool.inputSchema, "Granola meeting discovery schema");
      const properties = optionalRecord(schema.properties) ?? {};
      const timeRange = optionalRecord(properties.time_range);
      return Boolean(
        looseArray(timeRange?.enum).includes("custom") &&
        optionalRecord(properties.custom_start) &&
        optionalRecord(properties.custom_end),
      );
    }
    cursor = optionalString(result.nextCursor);
    if (cursor && seen.has(cursor)) throw providerResponseError("Granola repeated a tool discovery cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw providerResponseError("Granola does not advertise the list_meetings tool.");
}

/** Read Granola's ISO or English display date without depending on the worker's local timezone. */
function meetingDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let date = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1];
  if (!date) {
    const display = /^([A-Za-z]+) (\d{1,2}), (\d{4})(?:$|\s)/.exec(value);
    if (!display) return undefined;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months.indexOf(display[1]!.slice(0, 3));
    if (month < 0) return undefined;
    date = `${display[3]}-${String(month + 1).padStart(2, "0")}-${display[2]!.padStart(2, "0")}`;
  }
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : undefined;
}

function splitRange(range: MeetingRange): MeetingRange[] | undefined {
  const start = Date.parse(`${range.start}T00:00:00.000Z`);
  const end = Date.parse(`${range.end}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw providerResponseError("Invalid Granola discovery date range.");
  const days = Math.round((end - start) / dayMilliseconds);
  if (days <= 1) return undefined;
  const middle = new Date(start + Math.floor(days / 2) * dayMilliseconds).toISOString().slice(0, 10);
  return [
    { start: range.start, end: middle },
    { start: middle, end: range.end },
  ];
}
