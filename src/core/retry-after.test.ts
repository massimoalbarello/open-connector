import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "./retry-after.ts";

describe("Retry-After", () => {
  it.each(["0", "120", "Mon, 21 Sep 2026 12:00:00 GMT"])("preserves %s", (value) => {
    expect(parseRetryAfter(value)).toBe(value);
  });

  it.each([
    undefined,
    null,
    60,
    "",
    "-1",
    "1.5",
    "tomorrow",
    "120, 240",
    "secret-token",
    "1\r\nAuthorization: secret",
    "1".repeat(129),
  ])("discards malformed or unsafe values %#", (value) => expect(parseRetryAfter(value)).toBeUndefined());
});
