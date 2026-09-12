import { expect, it } from "vitest";
import { resolveSyncAssetLinks } from "./asset-links.ts";
import { validateAssetReceipt } from "./asset-upload.ts";

it("resolves Markdown links and reference images without interpreting quoted code as attachments", () => {
  const source = `open-connector://asset/${"a".repeat(64)}`;
  const target = "context-use://asset/drawing";
  const body = `[File](${source})\n\n![Drawing][image]\n\n[image]: ${source}\n\n\`${source}\`\n\n[Source](https://example.com)`;
  const resolved = resolveSyncAssetLinks(body, new Map([[source, target]]));
  expect(resolved).toContain(`[File](${target})`);
  expect(resolved).toContain(`[image]: ${target}`);
  expect(resolved).toContain(`\`${source}\``);
  expect(resolved).toContain("[Source](https://example.com)");
  expect(() => resolveSyncAssetLinks(body, new Map())).toThrow("missing from the record manifest");
  expect(resolveSyncAssetLinks(body, new Map([[source, source]]))).toBe(body);
});

it("accepts only complete receipts for the expected bytes and usable asset addresses", () => {
  const expected = { sha256: "a".repeat(64), sizeBytes: 4 };
  const valid = { ...expected, assetId: "file", url: "context-use://asset/file" };
  expect(validateAssetReceipt(valid, expected)).toEqual(valid);
  for (const invalid of [
    { ...valid, sha256: "b".repeat(64) },
    { ...valid, sizeBytes: 5 },
    { ...valid, url: "javascript:alert(1)" },
    { ...valid, url: "context-use://asset/another-file" },
    { ...valid, url: "https://user:password@example.com/file" },
    { ...valid, uploadHandle: "temporary" },
  ])
    expect(() => validateAssetReceipt(invalid, expected)).toThrow();
});
