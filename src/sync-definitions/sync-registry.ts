import type { SyncRegistration } from "../sync/sync-definition.ts";

import { createGitHubSyncProvider } from "../providers/github/sync-provider.ts";
import { createGmailSyncProvider } from "../providers/gmail/sync-provider.ts";
import { createGranolaSyncProvider } from "../providers/granola/sync-provider.ts";
import { githubPullRequests } from "./github/definition.ts";
import { gmailThreads } from "./gmail/definition.ts";
import { granolaMeetings } from "./granola/definition.ts";

/** Compose provider-owned definitions and adapters outside the provider-independent execution framework. */
export const syncRegistrations: readonly SyncRegistration[] = [
  { definition: gmailThreads, createProvider: createGmailSyncProvider, load: () => import("./gmail/threads.ts") },
  {
    definition: granolaMeetings,
    createProvider: createGranolaSyncProvider,
    load: () => import("./granola/meetings.ts"),
  },
  {
    definition: githubPullRequests,
    createProvider: createGitHubSyncProvider,
    load: () => import("./github/pull-requests.ts"),
  },
];
