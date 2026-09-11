import type { OAuth2AuthDefinition } from "../core/types.ts";
import type { OAuthClientConfigInput } from "./oauth-client-config-service.ts";

import { optionalRecord, optionalString } from "../core/cast.ts";
import { assertPublicHttpUrl, readBoundedResponseBytes } from "../core/request.ts";
import { createProviderTimeout, providerFetch, providerUserAgent } from "../providers/provider-runtime.ts";
import { OAuthClientConfigError } from "./oauth-client-config-service.ts";

interface OAuthClientRegistrationInput {
  auth: OAuth2AuthDefinition;
  redirectUri: string;
  signal?: AbortSignal;
}

/** Register a public RFC 7591 client for this connection's callback and refresh lifecycle. */
export async function registerOAuthClient(input: OAuthClientRegistrationInput): Promise<OAuthClientConfigInput> {
  const createError = (message: string): OAuthClientConfigError =>
    new OAuthClientConfigError("oauth_client_registration_failed", message);
  if (!input.auth.clientRegistrationUrl || input.auth.tokenEndpointAuthMethod !== "none" || !input.auth.pkce) {
    throw createError("Automatic OAuth registration requires a public client with PKCE.");
  }
  const url = assertPublicHttpUrl(input.auth.clientRegistrationUrl, {
    fieldName: "OAuth registration URL",
    createError,
  });
  if (url.protocol !== "https:") throw createError("OAuth registration requires HTTPS.");
  if (url.username || url.password || url.hash)
    throw createError("OAuth registration URL must not include credentials or a fragment.");

  const timeout = createProviderTimeout(input.signal);
  try {
    const response = await providerFetch(url, {
      method: "POST",
      redirect: "manual",
      signal: timeout.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": providerUserAgent,
      },
      body: JSON.stringify({
        client_name: "Open Connector",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: input.auth.scopes.join(input.auth.scopeSeparator ?? " "),
      }),
    });
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: 1024 * 1024,
      fieldName: "OAuth registration response",
      createError,
    });
    if (!response.ok) throw createError(`OAuth client registration failed (HTTP ${response.status}).`);
    const payload = optionalRecord(JSON.parse(new TextDecoder().decode(bytes)));
    const clientId = optionalString(payload?.client_id);
    if (!clientId) throw createError("OAuth registration did not return a client_id.");
    if (payload?.token_endpoint_auth_method !== "none") {
      throw createError("OAuth registration did not accept public client authentication.");
    }
    if (!Array.isArray(payload.redirect_uris) || !payload.redirect_uris.includes(input.redirectUri)) {
      throw createError("OAuth registration did not accept the runtime callback URL.");
    }
    return { clientId, clientSecret: "" };
  } catch (error) {
    if (error instanceof OAuthClientConfigError) throw error;
    // Registration responses may contain secrets; never include arbitrary response bodies in errors.
    throw createError("OAuth client registration failed. Please try connecting again.");
  } finally {
    timeout.cleanup();
  }
}
