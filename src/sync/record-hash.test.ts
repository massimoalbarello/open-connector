import { describe, expect, it } from "vitest";
import { canonicalizeJsonObject, canonicalizeJsonValue } from "./record-hash.ts";

describe("sync record canonicalization", () => {
  it("produces the same payload and hash for equivalent object key orders", () => {
    const first = canonicalizeJsonObject({ z: 1, nested: { b: true, a: [3, 2, 1] } });
    const second = canonicalizeJsonObject({ nested: { a: [3, 2, 1], b: true }, z: 1 });

    expect(first.json).toBe('{"nested":{"a":[3,2,1],"b":true},"z":1}');
    expect(second).toEqual(first);
  });

  it("normalizes negative zero and accepts any finite JSON checkpoint", () => {
    expect(canonicalizeJsonValue({ cursor: null, offset: -0 }).json).toBe('{"cursor":null,"offset":0}');
  });

  it("preserves prototype-named JSON keys in payloads and hashes", () => {
    const value = JSON.parse('{"body":"hello","__proto__":{"x":1},"nested":{"__proto__":null}}');
    const result = canonicalizeJsonObject(value);

    expect(result.json).toBe('{"__proto__":{"x":1},"body":"hello","nested":{"__proto__":null}}');
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
    expect(result.sha256).not.toBe(canonicalizeJsonObject({ body: "hello", nested: {} }).sha256);
    expect(canonicalizeJsonValue(value).json).toBe(result.json);
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "body", {
      enumerable: true,
      get() {
        invoked = true;
        return "hello";
      },
    });
    expect(() => canonicalizeJsonObject(value)).toThrow("data property");
    expect(invoked).toBe(false);
  });

  it.each([
    { label: "non-finite number", value: { count: Number.POSITIVE_INFINITY } },
    { label: "undefined", value: { missing: undefined } },
    { label: "class instance", value: new Date("2026-01-01T00:00:00.000Z") },
    { label: "sparse array", value: { items: Array(1) } },
  ])("rejects a $label", ({ value }) => {
    expect(() => canonicalizeJsonObject(value)).toThrow(TypeError);
  });

  it("rejects circular values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalizeJsonObject(value)).toThrow("circular reference");
  });
});
