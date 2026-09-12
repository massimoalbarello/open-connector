import { describe, expect, it } from "vitest";
import { s } from "../core/json-schema.ts";
import { normalizeSourceTimestamp, normalizeSyncRecord } from "./record-contract.ts";

const kind = { kind: "pull-request", attributesSchema: s.object({ status: s.string(), count: s.number() }) };
const base = {
  id: "90071992547409931234567890",
  title: "owner/repo #42: Preserve Markdown",
  body: "# Pull request\n\n  Preserve Markdown.\n",
};

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
    expect(first.content.value.title).toBe(base.title);
    expect(first.content.sha256).toBe(again.content.sha256);
    const changed = normalizeSyncRecord(
      { ...base, sourceUpdatedAt: "2024-02-29T12:00:00.1Z", attributes: { count: 3, status: "open" } },
      kind,
    );
    expect(changed.content.sha256).not.toBe(first.content.sha256);
    expect(first.content.value).not.toHaveProperty("id");
  });

  it("hashes title-only corrections without changing identity or Markdown", () => {
    const first = normalizeSyncRecord(base, kind);
    const updated = normalizeSyncRecord({ ...base, title: "owner/repo #42: Fix Unicode résumé 🐛" }, kind);
    expect(updated.id).toBe(first.id);
    expect(updated.content.value.body).toBe(first.content.value.body);
    expect(updated.content.value.title).toBe("owner/repo #42: Fix Unicode résumé 🐛");
    expect(updated.content.sha256).not.toBe(first.content.sha256);
    expect(normalizeSyncRecord({ ...base, title: updated.content.value.title }, kind)).toEqual(updated);
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
    { ...base, id: "", body: "text" },
    { ...base, id: "  ", body: "text" },
    { ...base, id: 9007199254740992, body: "text" },
    { ...base, id: "1", body: " \n " },
    { id: "1", title: "Missing body" },
    { id: "1", body: "Missing title" },
    ...["", " \n \t", null, 42].map((title) => ({ ...base, title })),
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

it("hashes attachment manifests deterministically and rejects destination upload state in source content", () => {
  const first = { sha256: "a".repeat(64), name: "first.txt", sizeBytes: 0 };
  const second = { sha256: "b".repeat(64), name: "second.txt", sizeBytes: 8 };
  const original = normalizeSyncRecord({ ...base, assets: [first, second] }, kind);
  expect(normalizeSyncRecord({ ...base, assets: [second, first, first] }, kind)).toEqual(original);
  expect(
    normalizeSyncRecord({ ...base, assets: [{ ...first, name: "renamed.txt" }, second] }, kind).content.sha256,
  ).not.toBe(original.content.sha256);
  for (const asset of [
    { ...first, url: "https://upload.example.com/temporary" },
    { ...first, assetId: "destination-id" },
    { ...first, sizeBytes: -1 },
    { ...first, sha256: "invalid" },
  ])
    expect(() => normalizeSyncRecord({ ...base, assets: [asset] }, kind)).toThrow();
  expect(normalizeSyncRecord({ ...base, assets: [] }, kind)).toEqual(normalizeSyncRecord(base, kind));
});
