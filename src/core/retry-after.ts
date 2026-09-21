import { optionalString } from "./cast.ts";

/** Keep HTTP delay-seconds or IMF-fixdate verbatim; discard malformed or unsafe header values. */
export function parseRetryAfter(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text || text.length > 128) {
    return undefined;
  }
  if (/^\d+$/u.test(text)) {
    return text;
  }
  if (
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      text,
    ) &&
    Number.isFinite(Date.parse(text))
  ) {
    return text;
  }
  return undefined;
}
