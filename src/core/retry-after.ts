import { optionalString } from "./cast.ts";

/** Preserve upstream Retry-After text without interpreting its units or date format. */
export function readRetryAfterHeader(value: unknown): string | undefined {
  const text = optionalString(value);
  return text && text.length <= 128 && /^[\x20-\x7e]+$/u.test(text) ? text : undefined;
}
