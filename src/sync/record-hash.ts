import type { JsonObject, JsonValue } from "./sync-store.ts";

import { createHash } from "node:crypto";

export interface CanonicalJson<T extends JsonValue> {
  value: T;
  json: string;
  sha256: string;
}

/** Validate, canonicalize, and hash a JSON object without invoking JSON-specific user hooks. */
export function canonicalizeJsonObject(value: unknown): CanonicalJson<JsonObject> {
  const normalized = normalizeJson(value, "$", new Set<object>());
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError("Sync record payload must be a JSON object.");
  }
  return serializeCanonical(normalized);
}

/** Validate and canonicalize a provider checkpoint or configuration value. */
export function canonicalizeJsonValue(value: unknown): CanonicalJson<JsonValue> {
  return serializeCanonical(normalizeJson(value, "$", new Set<object>()));
}

function serializeCanonical<T extends JsonValue>(value: T): CanonicalJson<T> {
  const json = JSON.stringify(value);
  return {
    value,
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function normalizeJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain a finite JSON number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: JsonValue[] = [];
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const expectedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || !expectedKeys.has(key)) {
          throw new TypeError(`${path} contains a non-JSON array property.`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor) {
          throw new TypeError(`${path} contains a sparse array.`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(`${path}[${index}] must be a data property.`);
        }
        normalized.push(normalizeJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized: JsonObject = {};
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      normalized[key] = normalizeJson(descriptor.value, `${path}.${key}`, ancestors);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} contains a symbol property.`);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}
