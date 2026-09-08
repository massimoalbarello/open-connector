import type { SyncRegistration } from "./sync-definition.ts";

import { githubPullRequests } from "../sync-definitions/github/definition.ts";

/** Metadata is eager; acquisition/rendering code loads only when its sync runs. */
export const syncRegistrations: readonly SyncRegistration[] = [
  { definition: githubPullRequests, load: () => import("../sync-definitions/github/pull-requests.ts") },
];
