import type { SyncDefinition } from "../../sync/sync-definition.ts";

import { s } from "../../core/json-schema.ts";

export const granolaMeetings: SyncDefinition = {
  id: "granola.meetings",
  version: "1",
  provider: "granola",
  kinds: [{ kind: "meeting" }],
  requiredScopes: [], // Account verification proves MCP access; OIDC scopes do not encode Granola plan entitlements.
  configSchema: s.object(
    {
      includeTranscript: s.boolean(
        "Fetch transcripts in addition to meeting notes; transcript failures stop the batch from being saved.",
      ),
    },
    { required: ["includeTranscript"] },
  ),
  defaultConfig: { includeTranscript: false },
  checkpointSchema: s.requiredObject("Discovery continuation, persisted with each completed batch.", {
    pendingIds: s.nullable(s.array(s.string({ minLength: 1, maxLength: 1024 }), { uniqueItems: true })),
    scan: s.optional(
      s.nullable(
        s.requiredObject("Unfinished ranges and the last committed native ID in the first range.", {
          ranges: s.array(
            s.nullable(
              s.requiredObject("Inclusive custom date range; null uses the server's unfiltered scope.", {
                start: s.date("First calendar date in the range."),
                end: s.date("Last calendar date in the range."),
              }),
            ),
            { minItems: 1, maxItems: 32 },
          ),
          afterId: s.nullable(s.string({ minLength: 1, maxLength: 1024 })),
        }),
      ),
    ),
  }),
  initialCheckpoint: { pendingIds: null, scan: null },
  scheduleSeconds: 3600,
};
