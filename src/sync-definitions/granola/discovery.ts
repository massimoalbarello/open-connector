import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { looseArray, optionalRecord, optionalString, requiredRawString } from "../../core/cast.ts";
import { GranolaTruncatedMeetingsError, parseMeetings } from "../../providers/granola/mcp-response.ts";
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

interface DiscoveryBatch {
  ids: string[];
  checkpoint: JsonObject;
  complete: boolean;
}

const dayMilliseconds = 86_400_000;
const discoveryBatchSize = 100;

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
 * New IDs behind that cursor are picked up by the next full scan. This is reconciliation, not
 * an upstream snapshot/change feed; never infer deletion from absence. If even the smallest
 * range is truncated or exceeds the transport's byte budget, fail without skipping its data.
 *
 * Version 1 compatibility: drain legacy pendingIds first, then begin full discovery. New progress
 * stores scan instead of an ID queue. Both forms validate without resetting saved identities.
 */
export async function* discover(context: SyncContext): AsyncGenerator<DiscoveryBatch> {
  const checkpoint = context.checkpoint as JsonObject;
  let pending = checkpoint.pendingIds as string[] | null;
  while (pending?.length) {
    context.signal.throwIfAborted();
    const ids = pending.slice(0, 10);
    pending = pending.slice(ids.length);
    yield { ids, checkpoint: { pendingIds: pending.length ? pending : null, scan: null }, complete: false };
  }

  const available = await startScan(context);
  const saved = checkpoint.scan as MeetingScan | null | undefined;
  // Restart discovery if the advertised request shape changes; committed records keep their identities.
  let scan: MeetingScan | null =
    saved && (saved.ranges[0] === null) === (available.ranges[0] === null) ? saved : available;
  while (scan) {
    context.signal.throwIfAborted();
    const range: MeetingRange | null = scan.ranges[0] ?? null;
    const halves: MeetingRange[] | undefined = range ? splitRange(range) : undefined;
    let ids: string[];
    try {
      const input: JsonObject = range ? { time_range: "custom", custom_start: range.start, custom_end: range.end } : {};
      const result = await context.provider.request("list_meetings", input);
      ids = parseMeetings(requiredRawString(result.text, "Granola meeting list", providerResponseError))
        .map((meeting) => meeting.id)
        .sort();
    } catch (error) {
      if (!halves || !(error instanceof GranolaTruncatedMeetingsError || error instanceof McpResponseSizeError))
        throw error;
      scan = { ranges: [...halves, ...scan.ranges.slice(1)], afterId: null };
      yield { ids: [], checkpoint: { pendingIds: null, scan }, complete: false };
      continue;
    }
    if (halves && ids.length > discoveryBatchSize && scan.afterId === null) {
      scan = { ranges: [...halves, ...scan.ranges.slice(1)], afterId: null };
      yield { ids: [], checkpoint: { pendingIds: null, scan }, complete: false };
      continue;
    }

    const afterId = scan.afterId;
    const remaining = ids.filter((id) => afterId === null || id > afterId);
    const currentRanges: (MeetingRange | null)[] = scan.ranges;
    const ranges = currentRanges.slice(1);
    if (!remaining.length) {
      scan = ranges.length ? { ranges, afterId: null } : null;
      yield { ids: [], checkpoint: { pendingIds: null, scan }, complete: scan === null };
      continue;
    }
    for (let offset = 0; offset < remaining.length; offset += 10) {
      const batch = remaining.slice(offset, offset + 10);
      scan =
        offset + batch.length < remaining.length
          ? { ranges: currentRanges, afterId: batch.at(-1)! }
          : ranges.length
            ? { ranges, afterId: null }
            : null;
      yield { ids: batch, checkpoint: { pendingIds: null, scan }, complete: scan === null };
    }
  }
}

async function startScan(context: SyncContext): Promise<MeetingScan> {
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
      const custom =
        looseArray(timeRange?.enum).includes("custom") &&
        optionalRecord(properties.custom_start) &&
        optionalRecord(properties.custom_end);
      return {
        ranges: custom
          ? [
              {
                // Granola began in early 2023, before its public launch: https://www.granola.ai/blog/series-a
                start: "2023-01-01",
                end: new Date(Date.parse(context.startedAt) + dayMilliseconds).toISOString().slice(0, 10),
              },
            ]
          : [null],
        afterId: null,
      };
    }
    cursor = optionalString(result.nextCursor);
    if (cursor && seen.has(cursor)) throw providerResponseError("Granola repeated a tool discovery cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw providerResponseError("Granola does not advertise the list_meetings tool.");
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
