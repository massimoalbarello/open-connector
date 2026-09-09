import type { CredentialValidationResult, CredentialValidatorOptions, ResolvedCredential } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { optionalString, requiredRawString, requiredString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  providerInputError,
  providerResponseError,
  ProviderRequestError,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";

interface GranolaToolText {
  text: string;
}

/** Only the three concrete read tools used by acquisition are exposed as provider actions. */
export const granolaActionHandlers: ProviderActionHandlers<
  "granola_mcp",
  ProviderRuntimeHandler<OAuthProviderContext>
> = {
  list_meetings: (_input, context) => callGranolaTool(context, "list_meetings", { time_range: "last_30_days" }),
  get_meetings: (input, context) => callGranolaTool(context, "get_meetings", input),
  get_meeting_transcript: (input, context) => callGranolaTool(context, "get_meeting_transcript", input),
};

/** MCP transport owns negotiation, framing and cleanup; never interpret error text as meeting content. */
export async function callGranolaTool(
  context: OAuthProviderContext,
  name: string,
  input: Record<string, unknown>,
): Promise<GranolaToolText> {
  if (!Object.hasOwn(granolaActionHandlers, name)) throw providerInputError("Unsupported Granola read operation.");
  return withGranolaClient(context, async (client, signal) => {
    const result = await client.callTool({ name, arguments: input }, { signal });
    if (result.isError) throw providerResponseError(`Granola ${name} failed; meeting content was not saved.`);
    if (!Array.isArray(result.content))
      throw providerResponseError("Granola MCP returned an unsupported content format.");
    const text = result.content
      .map((item) => {
        if (item.type !== "text") throw providerResponseError("Granola MCP returned an unsupported content format.");
        return requiredRawString(item.text, "Granola tool text", providerResponseError);
      })
      .join("\n");
    return { text };
  });
}

function withGranolaClient<T>(
  context: OAuthProviderContext,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runProviderRequest({ signal: context.signal, label: "Granola MCP" }, (signal) =>
    withMcpClient(
      {
        endpoint: new URL(granolaMcpEndpoint),
        transport: "streamable_http",
        fetcher: context.fetcher,
        headers: { authorization: `Bearer ${context.accessToken}` },
        redirect: "error",
        signal,
        maxResponseBytes: 16 * 1024 * 1024,
        mapError: (error) => {
          if (error instanceof UnauthorizedError)
            return new ProviderRequestError(401, "Granola authorization expired.");
          if (error instanceof SdkHttpError)
            return new ProviderRequestError(error.status ?? 502, "Granola MCP request failed.");
          return error;
        },
      },
      (client) => run(client, signal),
    ),
  );
}

/** OIDC UserInfo proves the account; neither an email nor a hash of the token is source identity. */
export async function verifyGranolaAccount(
  credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
  options: CredentialValidatorOptions,
): Promise<CredentialValidationResult> {
  return runProviderRequest({ signal: options.signal, label: "Granola identity" }, async (signal) => {
    const response = await options.fetcher(`${granolaOAuthIssuer}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new ProviderRequestError(
        response.status === 401 || response.status === 403 ? 400 : response.status,
        "Granola account verification failed.",
      );
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: 1024 * 1024,
      fieldName: "Granola identity",
      createError: providerResponseError,
    });
    const user = requiredResponseRecord(JSON.parse(new TextDecoder().decode(bytes)), "Granola account");
    const accountId = requiredString(user.sub, "Granola account ID", providerResponseError);
    // Successful MCP access proves this token's resource grant, independently of stored profile data.
    await withGranolaClient(
      { accessToken: credential.accessToken, fetcher: options.fetcher, signal },
      async (client, signal) => {
        const tools = await client.listTools({}, { signal });
        if (!tools.tools.some((tool) => tool.name === "list_meetings"))
          throw providerResponseError("Granola MCP did not expose meeting access.");
      },
    );
    return {
      profile: {
        accountId,
        displayName: optionalString(user.name) ?? optionalString(user.email) ?? accountId,
        grantedScopes: ["mcp"],
      },
      sourceIdentity: { accountId, authorizationBoundary: JSON.stringify([granolaMcpEndpoint, "account", "mcp"]) },
    };
  });
}
