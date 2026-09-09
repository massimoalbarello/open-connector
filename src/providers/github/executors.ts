import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { GitHubActionContext, GitHubActionHandler } from "./runtime-shared.ts";

import {
  combineProviderActionHandlers,
  defineProviderExecutors,
  requireBearerCredential,
} from "../provider-runtime.ts";
import { activityActionHandlers } from "./runtime-activity.ts";
import { issueActionHandlers } from "./runtime-issue.ts";
import { pullRequestActionHandlers } from "./runtime-pull-request.ts";
import { releaseActionHandlers } from "./runtime-release.ts";
import { repositoryActionHandlers } from "./runtime-repository.ts";
import { searchActionHandlers } from "./runtime-search.ts";
import { verifyGitHubUser } from "./source-identity.ts";

const service = "github";

export const executors: ProviderExecutors = defineProviderExecutors<GitHubActionContext>({
  service,
  handlers: combineProviderActionHandlers<"github", GitHubActionHandler>(
    service,
    activityActionHandlers,
    repositoryActionHandlers,
    issueActionHandlers,
    pullRequestActionHandlers,
    releaseActionHandlers,
    searchActionHandlers,
  ),
  async createContext(context, fetcher): Promise<GitHubActionContext> {
    const credential = await requireBearerCredential(context, service);
    return {
      accessToken: credential.accessToken,
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey: (input, options) => verifyGitHubUser(input.apiKey, options),
  oauth2: (input, options) => verifyGitHubUser(input.accessToken, options),
};
