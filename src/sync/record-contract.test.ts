import { describe, expect, it } from "vitest";
import { s } from "../core/json-schema.ts";
import { normalizeSourceTimestamp, normalizeSyncRecord } from "./record-contract.ts";

const kind = { kind: "pull-request", attributesSchema: s.object({ status: s.string(), count: s.number() }) };
const base = { id: "90071992547409931234567890", body: "# Pull request\n\n  Preserve Markdown.\n" };

describe("shared Markdown record contract", () => {
  it("hashes normalized content and excludes record identity and framework envelopes", () => {
    const first = normalizeSyncRecord(
      { ...base, sourceUpdatedAt: "2024-02-29T13:00:00.1000+01:00", attributes: { count: 2, status: "open" } },
      kind,
    );
    const again = normalizeSyncRecord(
      { ...base, id: "other", sourceUpdatedAt: "2024-02-29T12:00:00.1Z", attributes: { status: "open", count: 2 } },
      kind,
    );
    expect(first.id).toBe(base.id);
    expect(first.content.value.body).toBe(base.body);
    expect(first.content.sha256).toBe(again.content.sha256);
    const changed = normalizeSyncRecord(
      { ...base, sourceUpdatedAt: "2024-02-29T12:00:00.1Z", attributes: { count: 3, status: "open" } },
      kind,
    );
    expect(changed.content.sha256).not.toBe(first.content.sha256);
    expect(first.content.value).not.toHaveProperty("id");
  });

  it("normalizes set ordering without using participant display names as identities", () => {
    const a = {
      name: "Alex",
      identities: [
        { namespace: "github", id: "1" },
        { namespace: "email", id: "a@example.com" },
      ],
      roles: ["reviewer", "author", "author"],
    };
    const b = { name: "Alex", identities: [{ namespace: "github", id: "2" }], roles: ["author"] };
    const one = normalizeSyncRecord({ ...base, participants: [a, b, a] }, kind);
    const two = normalizeSyncRecord(
      { ...base, participants: [b, { ...a, identities: [...a.identities].reverse(), roles: ["author", "reviewer"] }] },
      kind,
    );
    expect(one.content.sha256).toBe(two.content.sha256);
    expect(one.content.value.participants).toHaveLength(2);
  });

  it.each([
    { id: "", body: "text" },
    { id: "  ", body: "text" },
    { id: 9007199254740992, body: "text" },
    { id: "1", body: " \n " },
    { id: "1" },
    { ...base, body: null },
    ...["provider", "kind", "sourceId", "revision", "eventId", "observedAt", "attachments", "raw"].map((field) => ({
      ...base,
      [field]: "forbidden",
    })),
    { ...base, attributes: { undeclared: true } },
    { ...base, attributes: { count: Number.NaN } },
    { ...base, participants: [{ name: "Only a name", roles: ["author"] }] },
    { ...base, participants: [{ identities: [{ namespace: "github", id: "1", token: "secret" }], roles: ["author"] }] },
    { ...base, sourceUrl: "javascript:alert(1)" },
    { ...base, sourceUrl: "https://user:password@example.com" },
  ])("rejects invalid content and unknown fields: %j", (value) => {
    expect(() => normalizeSyncRecord(value, kind)).toThrow();
  });

  it("rejects undeclared or oversized attributes", () => {
    expect(() => normalizeSyncRecord({ ...base, attributes: {} }, { kind: "plain" })).toThrow();
    expect(() => normalizeSyncRecord({ ...base, attributes: { status: "x".repeat(16_384) } }, kind)).toThrow();
  });

  it.each([
    "2023-02-29T00:00:00Z",
    "2024-04-31T00:00:00Z",
    "2024-00-01T00:00:00Z",
    "2024-01-00T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:60:00Z",
    "2024-01-01T00:00:60Z",
    "2024-01-01",
    "2024-01-01T00:00:00",
    "2024-01-01T00:00:00-00:00",
    "2024-01-01T00:00:00+24:00",
    "2024-01-01T00:00:00+01:60",
    "not a date",
    "",
  ])("rejects invalid or ambiguous source dates: %s", (sourceCreatedAt) => {
    expect(() => normalizeSyncRecord({ ...base, sourceCreatedAt }, kind)).toThrow();
  });

  it("preserves sub-millisecond precision and calendar boundaries deterministically", () => {
    expect(normalizeSourceTimestamp("2024-03-01T00:15:00.1234567890+01:00")).toBe("2024-02-29T23:15:00.123456789Z");
    expect(normalizeSourceTimestamp("0001-01-01t00:00:00.000z")).toBe("0001-01-01T00:00:00Z");
    expect(normalizeSourceTimestamp("2000-02-29T23:59:59Z")).toBe("2000-02-29T23:59:59Z");
  });
});
