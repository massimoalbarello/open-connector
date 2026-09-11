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
        "Include transcripts. Requires a paid Granola plan; transcript failures stop the record from being saved.",
      ),
    },
    { required: ["includeTranscript"] },
  ),
  defaultConfig: { includeTranscript: false },
  checkpointSchema: s.requiredObject("Remaining native IDs from one discovery scan; null starts a new scan.", {
    pendingIds: s.nullable(s.array(s.string({ minLength: 1, maxLength: 1024 }), { maxItems: 1000, uniqueItems: true })),
  }),
  initialCheckpoint: { pendingIds: null },
  scheduleSeconds: 3600,
};
