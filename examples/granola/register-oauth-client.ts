import { requiredString } from "../../src/core/cast.ts";
import { granolaOAuthIssuer } from "../../src/providers/granola_mcp/endpoints.ts";
import {
  providerFetch,
  providerResponseError,
  readProviderJson,
  requiredResponseRecord,
  runProviderRequest,
} from "../../src/providers/provider-runtime.ts";

const redirectUri = process.env.GRANOLA_REDIRECT_URI;
if (!redirectUri) {
  console.log("Skipped: set GRANOLA_REDIRECT_URI to the Callback URL shown for Granola MCP in OAuth Apps.");
} else {
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "https:" &&
    !(callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))
  )
    throw new Error("Use an HTTPS callback or a local HTTP loopback callback.");
  const registration = await runProviderRequest({ label: "Granola OAuth registration" }, async (signal) => {
    const response = await providerFetch(`${granolaOAuthIssuer}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal,
      body: JSON.stringify({
        client_name: "Open Connector",
        redirect_uris: [callback.href],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!response.ok) throw new Error(`Granola registration returned HTTP ${response.status}.`);
    return requiredResponseRecord(
      await readProviderJson(response, "Granola OAuth registration"),
      "Granola OAuth client",
    );
  });
  console.log(`Client ID: ${requiredString(registration.client_id, "client_id", providerResponseError)}`);
  console.log(
    "Save this Client ID in OAuth Apps > Granola MCP, leave Client Secret empty, and connect Granola in Providers.",
  );
}
