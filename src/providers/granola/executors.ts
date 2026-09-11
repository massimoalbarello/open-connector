import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";

import {
  defineApiKeyProviderExecutors,
  defineOAuthProviderExecutors,
  defineProviderProxy,
} from "../provider-runtime.ts";
import { granolaMcpActionHandlers, validateGranolaOAuthCredential } from "./runtime-mcp.ts";
import { granolaActionHandlers, granolaApiBaseUrl, validateGranolaCredential } from "./runtime.ts";

const service = "granola";

export const executors: ProviderExecutors = {
  ...defineApiKeyProviderExecutors(service, granolaActionHandlers),
  ...defineOAuthProviderExecutors(service, granolaMcpActionHandlers, { skipDnsValidation: true }),
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: granolaApiBaseUrl,
  auth: { type: "api_key_authorization", prefix: "Bearer " },
  skipDnsValidation: true,
  customizeRequest({ headers }) {
    headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  oauth2: validateGranolaOAuthCredential,
  apiKey(input, { fetcher, signal }) {
    return validateGranolaCredential(input.apiKey, fetcher, signal);
  },
};
