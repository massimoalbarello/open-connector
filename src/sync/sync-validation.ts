import type { JsonSchema } from "../core/types.ts";
import type { JsonValue } from "./sync-store.ts";
import type { Schema } from "@cfworker/json-schema";

import { Validator } from "@cfworker/json-schema";
import { canonicalizeJsonValue } from "./record-hash.ts";
import { SyncStoreError } from "./sync-store.ts";

/** Validate framework progress/configuration without coercion or dropping unknown fields. */
export function validateSyncValue(value: unknown, schema: JsonSchema, label: string): JsonValue {
  try {
    const normalized = canonicalizeJsonValue(value).value;
    const result = new Validator(schema as Schema, "2020-12", false).validate(normalized);
    if (!result.valid) throw new Error(result.errors.map((error) => error.error).join("; "));
    return normalized;
  } catch (error) {
    throw new SyncStoreError("invalid_input", `${label}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}
