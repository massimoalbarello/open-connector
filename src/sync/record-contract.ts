import type { JsonSchema } from "../core/types.ts";
import type { CanonicalJson } from "./record-hash.ts";
import type { JsonObject } from "./sync-store.ts";
import type { Schema } from "@cfworker/json-schema";

import { Validator } from "@cfworker/json-schema";
import { s } from "../core/json-schema.ts";
import { canonicalizeJsonObject } from "./record-hash.ts";
import { SyncStoreError } from "./sync-store.ts";

export interface SyncKindContract {
  kind: string;
  attributesSchema?: JsonSchema;
}

/** The record portion of a compiled definition; acquisition and checkpoint schemas come later. */
export interface SyncDefinitionContract {
  id: string;
  version: string;
  provider: string;
  kinds: readonly SyncKindContract[];
}

export interface SyncParticipantIdentity {
  namespace: string;
  id: string;
}

export interface SyncParticipant {
  identities: SyncParticipantIdentity[];
  roles: string[];
  name?: string;
}

/** Author-owned content. Important structured facts must also appear in body. */
export interface SyncRecordInput {
  id: string;
  /** Descriptive plain text chosen by the sync for display and search. */
  title: string;
  body: string;
  sourceUrl?: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  participants?: SyncParticipant[];
  attributes?: JsonObject;
}

export interface NormalizedSyncRecord {
  id: string;
  content: CanonicalJson<JsonObject>;
}

const nonempty = s.nonWhitespaceString("Non-empty text.");
const participantSchema = s.object(
  {
    identities: s.array(s.object({ namespace: nonempty, id: nonempty }, { required: ["namespace", "id"] }), {
      minItems: 1,
      maxItems: 16,
    }),
    roles: s.array(nonempty, { minItems: 1, maxItems: 32 }),
    name: nonempty,
  },
  { required: ["identities", "roles"] },
);

/** Shared strict schema; framework routing and delivery fields are never author input. */
export function syncRecordSchema(kind: SyncKindContract): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    id: s.nonWhitespaceString("Opaque provider-native ID.", { maxLength: 1024 }),
    title: s.nonWhitespaceString("Descriptive plain-text title chosen by the sync for display and search."),
    body: nonempty,
    sourceUrl: s.url("Link to the source record."),
    sourceCreatedAt: s.string(),
    sourceUpdatedAt: s.string(),
    participants: s.array(participantSchema, { maxItems: 1000 }),
  };
  if (kind.attributesSchema) {
    if (kind.attributesSchema.type !== "object" || kind.attributesSchema.additionalProperties !== false)
      throw new SyncStoreError("invalid_input", "Attributes must declare a closed object schema.");
    properties.attributes = kind.attributesSchema;
  }
  return s.object(properties, { required: ["id", "title", "body"] });
}

/** Normalize without trimming Markdown or converting opaque IDs to numbers. Hash content only. */
export function normalizeSyncRecord(input: unknown, kind: SyncKindContract): NormalizedSyncRecord {
  try {
    const record = canonicalizeJsonObject(input).value;
    const result = new Validator(syncRecordSchema(kind) as Schema, "2020-12", false).validate(record);
    if (!result.valid) throw new Error(result.errors.map((error) => error.error).join("; "));
    const { id, ...content } = record;
    for (const field of ["sourceCreatedAt", "sourceUpdatedAt"]) {
      if (content[field] !== undefined) content[field] = normalizeSourceTimestamp(content[field]);
    }
    if (content.sourceUrl !== undefined) {
      const url = new URL(content.sourceUrl as string);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("sourceUrl must be an HTTP(S) link without credentials.");
      }
    }
    if (content.participants !== undefined) {
      const participants = content.participants as unknown as SyncParticipant[];
      // These collections are sets. Never deduplicate people by their display name.
      content.participants = sortedUnique(
        participants.map((participant) => ({
          ...participant,
          identities: sortedUnique(participant.identities),
          roles: [...new Set(participant.roles)].sort(),
        })),
      ) as unknown as JsonObject[];
    }
    if (content.attributes !== undefined) {
      const attributes = canonicalizeJsonObject(content.attributes);
      if (Buffer.byteLength(attributes.json, "utf8") > 16_384) throw new Error("attributes exceed 16 KiB.");
    }
    return { id: id as string, content: canonicalizeJsonObject(content) };
  } catch (error) {
    throw new SyncStoreError(
      "invalid_input",
      `Invalid sync record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Accept real RFC 3339 instants, preserving fractional precision without Date's millisecond truncation. */
export function normalizeSourceTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("Source timestamp must be a string.");
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Source timestamp must be timezone-qualified RFC 3339.");
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1]! ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    zone === "-00:00"
  ) {
    throw new Error("Invalid or ambiguous source timestamp.");
  }
  if (zone!.length > 1 && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))
    throw new Error("Invalid timezone offset.");
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone!.toUpperCase()}`);
  const utc = date.toISOString();
  if (utc.length !== 24) throw new Error("Source timestamp UTC year must have four digits.");
  const digits = (fraction ?? "").replace(/0+$/, "");
  return `${utc.slice(0, 19)}${digits ? `.${digits}` : ""}Z`;
}

function sortedUnique<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [canonicalizeJsonObject(value).json, value])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}
