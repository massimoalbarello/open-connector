import type { CredentialValidationResult, CredentialValidatorOptions } from "../../core/types.ts";

import { optionalString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { providerResponseError, requiredResponseRecord, runProviderRequest } from "../provider-runtime.ts";
import { githubApiBaseUrl, githubHeaders } from "./runtime-shared.ts";

/** Prove a GitHub user principal. Only classic PAT/OAuth grants expose a verifiable scope boundary. */
export async function verifyGitHubUser(
  accessToken: string,
  options: CredentialValidatorOptions,
): Promise<CredentialValidationResult> {
  return runProviderRequest({ signal: options.signal, label: "GitHub identity" }, async (signal) => {
    const response = await options.fetcher(`${githubApiBaseUrl}/user`, {
      headers: githubHeaders(accessToken, false),
      signal,
      redirect: "error",
    });
    if (!response.ok) throw providerResponseError(`GitHub identity verification returned HTTP ${response.status}.`);
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: 1024 * 1024,
      fieldName: "GitHub identity",
      createError: providerResponseError,
    });
    const user = requiredResponseRecord(JSON.parse(new TextDecoder().decode(bytes)), "GitHub user");
    const nativeId = optionalString(user.node_id);
    const login = optionalString(user.login);
    const scopesHeader = response.headers.get("x-oauth-scopes");
    const scopes =
      scopesHeader === null
        ? undefined
        : [
            ...new Set(
              scopesHeader
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean),
            ),
          ].sort();
    return {
      profile: {
        accountId: login ?? nativeId ?? "github:user",
        displayName: optionalString(user.name) ?? login ?? "GitHub User",
        grantedScopes: scopes,
      },
      sourceIdentity:
        nativeId && user.type === "User" && scopes
          ? { accountId: nativeId, authorizationBoundary: JSON.stringify(["github.com", "user", scopes]) }
          : undefined,
      metadata: { currentUser: user },
    };
  });
}
