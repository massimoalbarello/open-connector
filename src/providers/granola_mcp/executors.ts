import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { granolaActionHandlers, verifyGranolaAccount } from "./runtime.ts";

export const executors: ProviderExecutors = defineOAuthProviderExecutors("granola_mcp", granolaActionHandlers);
export const credentialValidators: CredentialValidators = { oauth2: verifyGranolaAccount };
