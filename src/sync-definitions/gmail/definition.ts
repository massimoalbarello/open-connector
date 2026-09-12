import type { SyncDefinition } from "../../sync/sync-definition.ts";

import { s } from "../../core/json-schema.ts";
import { gmailIdentityScope, gmailSyncReadScopes } from "../../providers/gmail/scopes.ts";

export const gmailThreads: SyncDefinition = {
  id: "gmail.threads",
  version: "1",
  provider: "gmail",
  kinds: [
    {
      kind: "thread",
      attributesSchema: s.object(
        { messageCount: s.integer({ minimum: 1 }), labelIds: s.array(s.string()) },
        { required: ["messageCount", "labelIds"] },
      ),
    },
  ],
  requiredScopes: [gmailIdentityScope],
  requiredScopesAnyOf: gmailSyncReadScopes,
  configSchema: s.object({}),
  defaultConfig: {},
  checkpointSchema: s.object(
    {
      phase: s.stringEnum(["backfill", "reconcile", "history"]),
      historyId: s.nullable(s.string({ pattern: "^[0-9]+$" })),
      pageToken: s.nullable(s.string()),
      throughSequence: s.integer({ minimum: 0 }),
      afterId: s.nullable(s.string()),
      pendingIds: s.array(s.string(), { maxItems: 1000 }),
      nextHistoryId: s.nullable(s.string({ pattern: "^[0-9]+$" })),
      historyDue: s.boolean(),
      historyComplete: s.boolean(),
    },
    {
      required: [
        "phase",
        "historyId",
        "pageToken",
        "throughSequence",
        "afterId",
        "pendingIds",
        "nextHistoryId",
        "historyDue",
        "historyComplete",
      ],
    },
  ),
  initialCheckpoint: {
    phase: "backfill",
    historyId: null,
    pageToken: null,
    throughSequence: 0,
    afterId: null,
    pendingIds: [],
    nextHistoryId: null,
    historyDue: false,
    historyComplete: false,
  },
  scheduleSeconds: 300,
};
