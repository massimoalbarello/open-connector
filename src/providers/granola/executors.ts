import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors, defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { granolaMcpActionHandlers, validateGranolaOAuthCredential } from "./runtime-mcp.ts";
import { granolaActionHandlers, validateGranolaCredential } from "./runtime.ts";

const service = "granola";

export const executors: ProviderExecutors = {
  ...defineApiKeyProviderExecutors(service, granolaActionHandlers),
  ...defineOAuthProviderExecutors(service, granolaMcpActionHandlers),
};

export const credentialValidators: CredentialValidators = {
  oauth2: validateGranolaOAuthCredential,
  apiKey(input, { fetcher, signal }) {
    return validateGranolaCredential(input.apiKey, fetcher, signal);
  },
};
