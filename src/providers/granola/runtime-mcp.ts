import type { CredentialValidationResult, CredentialValidatorOptions, ResolvedCredential } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlerSubset, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  providerResponseError,
  ProviderRequestError,
  readProviderJsonBody,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";

export const granolaMcpActionHandlers: ProviderActionHandlerSubset<
  "granola",
  ProviderRuntimeHandler<OAuthProviderContext>
> = {
  mcp_list_tools: (input, context) =>
    withGranolaClient(context, (client, signal) =>
      client.listTools({ cursor: optionalString(input.cursor) }, { signal }),
    ),
  mcp_call_tool: async (input, context) => ({
    result: await callGranolaMcpTool(
      context,
      requiredInputString(input.toolName, "toolName"),
      optionalRecord(input.arguments) ?? {},
    ),
  }),
};

/** Execute a Granola tool through the same authenticated MCP transport for actions and acquisition. */
export function callGranolaMcpTool(
  context: OAuthProviderContext,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withGranolaClient(context, async (client, signal) => {
    const result = await client.callTool({ name, arguments: input }, { signal });
    if (result.isError) throw new ProviderRequestError(502, `Granola MCP tool ${name} failed.`, result);
    return result;
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
        redirect: "manual",
        signal,
        maxResponseBytes: 16 * 1024 * 1024,
        mapError(error) {
          if (error instanceof UnauthorizedError)
            return new ProviderRequestError(401, "Granola OAuth authorization expired.");
          if (error instanceof SdkHttpError)
            return new ProviderRequestError(error.status ?? 502, "Granola MCP request failed.");
          return error;
        },
      },
      (client) => run(client, signal),
    ),
  );
}

/** Validate the OAuth account and MCP grant without requiring paid meeting or transcript tools. */
export async function validateGranolaOAuthCredential(
  credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
  options: CredentialValidatorOptions,
): Promise<CredentialValidationResult> {
  try {
    return await runProviderRequest({ signal: options.signal, label: "Granola OAuth validation" }, async (signal) => {
      const response = await options.fetcher(`${granolaOAuthIssuer}/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "manual",
        signal,
      });
      if (!response.ok) throw new ProviderRequestError(response.status, "Granola account verification failed.");
      const user = requiredResponseRecord(
        await readProviderJsonBody(response, {
          emptyBody: undefined,
          invalidJsonMessage: "Invalid Granola account response.",
          maxBytes: 1024 * 1024,
        }),
        "Granola account",
      );
      const accountId = requiredString(user.sub, "Granola account ID", providerResponseError);
      await withGranolaClient(
        { accessToken: credential.accessToken, fetcher: options.fetcher, signal },
        (client, signal) => client.listTools({}, { signal }),
      );
      return {
        profile: { accountId, displayName: optionalString(user.name) ?? optionalString(user.email) ?? accountId },
        sourceIdentity: { accountId, authorizationBoundary: granolaMcpEndpoint },
      };
    });
  } catch (error) {
    if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
      throw new ProviderRequestError(400, "Granola OAuth credentials are invalid or MCP access is disabled.");
    }
    throw error;
  }
}
