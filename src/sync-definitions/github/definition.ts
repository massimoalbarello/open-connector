import type { SyncDefinition } from "../../sync/sync-definition.ts";

import { s } from "../../core/json-schema.ts";

export const githubPullRequests: SyncDefinition = {
  id: "github.pull-requests",
  version: "1",
  provider: "github",
  kinds: [
    {
      kind: "pull-request",
      attributesSchema: s.object(
        { repository: s.string(), number: s.integer(), state: s.string(), draft: s.boolean() },
        { required: ["repository", "number", "state", "draft"] },
      ),
    },
  ],
  requiredScopes: [], // Public grants work; private PRs require repo. Identity verification reports actual scopes.
  configSchema: s.object({ scope: s.stringEnum(["authored", "accessible"]) }, { required: ["scope"] }),
  defaultConfig: { scope: "authored" },
  checkpointSchema: s.object(
    {
      phase: s.stringEnum(["backfill", "updates", "reconcile"]),
      cursor: s.nullable(s.string()),
      repositoryCursor: s.nullable(s.string()),
      repositoryId: s.nullable(s.string()),
      cycleStartedAt: s.nullable(s.dateTime("Start of the current bounded acquisition cycle.")),
      watermark: s.nullable(s.dateTime("Previous completed cycle's start; queried with overlap.")),
      reconciledAt: s.nullable(s.dateTime("Last completed full hydration cycle.")),
    },
    {
      required: ["phase", "cursor", "repositoryCursor", "repositoryId", "cycleStartedAt", "watermark", "reconciledAt"],
    },
  ),
  initialCheckpoint: {
    phase: "backfill",
    cursor: null,
    repositoryCursor: null,
    repositoryId: null,
    cycleStartedAt: null,
    watermark: null,
    reconciledAt: null,
  },
  scheduleSeconds: 900,
};
