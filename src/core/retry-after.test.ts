import { describe, expect, it } from "vitest";
import { readRetryAfterHeader } from "./retry-after.ts";

describe("Retry-After header preservation", () => {
  it.each([
    "0",
    "120",
    "1790000000",
    "1790000000000",
    "Mon, 21 Sep 2026 12:00:00 GMT",
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
    "2026-09-21T12:00:00Z",
    "provider-specific value",
  ])("preserves %s without interpreting it", (value) => {
    expect(readRetryAfterHeader(value)).toBe(value);
  });

  it.each([undefined, null, 60, "", " ", "1\r\nAuthorization: secret", "1\0", "1\u007f", "1\u0100", "1".repeat(129)])(
    "discards absent, oversized, or unsafe header values %#",
    (value) => expect(readRetryAfterHeader(value)).toBeUndefined(),
  );
});
