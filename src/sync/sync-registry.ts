import type { SyncRegistration } from "./sync-definition.ts";

import { createGitHubSyncProvider } from "../providers/github/sync-provider.ts";
import { githubPullRequests } from "../sync-definitions/github/definition.ts";

/** Metadata is eager; acquisition/rendering code loads only when its sync runs. */
export const syncRegistrations: readonly SyncRegistration[] = [
  {
    definition: githubPullRequests,
    createProvider: createGitHubSyncProvider,
    load: () => import("../sync-definitions/github/pull-requests.ts"),
  },
];
