import type { SyncDefinition } from "../../sync/sync-definition.ts";

import { s } from "../../core/json-schema.ts";

export const granolaMeetings: SyncDefinition = {
  id: "granola.meetings",
  version: "1",
  provider: "granola_mcp",
  kinds: [{ kind: "meeting" }],
  requiredScopes: ["mcp"],
  configSchema: s.object({}),
  defaultConfig: {},
  checkpointSchema: s.requiredObject("Remaining native IDs from one discovery scan; null starts a new scan.", {
    pendingIds: s.nullable(s.array(s.string({ minLength: 1, maxLength: 1024 }), { maxItems: 1000, uniqueItems: true })),
  }),
  initialCheckpoint: { pendingIds: null },
  scheduleSeconds: 3600,
};
