import type { SyncRegistration } from "./sync-definition.ts";

import { createGitHubSyncProvider } from "../providers/github/sync-provider.ts";
import { createGranolaSyncProvider } from "../providers/granola/sync-provider.ts";
import { githubPullRequests } from "../sync-definitions/github/definition.ts";
import { granolaMeetings } from "../sync-definitions/granola/definition.ts";

/** Metadata is eager; acquisition/rendering code loads only when its sync runs. */
export const syncRegistrations: readonly SyncRegistration[] = [
  {
    definition: granolaMeetings,
    createProvider: createGranolaSyncProvider,
    load: () => import("../sync-definitions/granola/meetings.ts"),
  },
  {
    definition: githubPullRequests,
    createProvider: createGitHubSyncProvider,
    load: () => import("../sync-definitions/github/pull-requests.ts"),
  },
];
