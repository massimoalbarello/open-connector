import type { CredentialValidationResult, CredentialValidatorOptions, ResolvedCredential } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlerSubset, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import {
  looseArray,
  optionalRecord,
  optionalString,
  requiredRawString,
  requiredString,
  requiredStringArray,
} from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  providerResponseError,
  providerInputError,
  parseProviderJsonBodyText,
  ProviderRequestError,
  readProviderJsonBody,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";
import { parseMeetings, parseTranscript } from "./mcp-response.ts";

export const granolaMcpActionHandlers: ProviderActionHandlerSubset<
  "granola",
  ProviderRuntimeHandler<OAuthProviderContext>
> = {
  async list_meetings(input, context) {
    if (input.time_range === "custom") {
      const start = requiredInputString(input.custom_start, "custom_start");
      const end = requiredInputString(input.custom_end, "custom_end");
      if (start > end) throw providerInputError("custom_start must not be after custom_end.");
    } else if (input.custom_start !== undefined || input.custom_end !== undefined) {
      throw providerInputError("Custom dates require time_range: custom.");
    }
    return { meetings: parseMeetings(await callGranolaMcpTool(context, "list_meetings", input)) };
  },
  async get_meetings(input, context) {
    const ids = requiredStringArray(input.meeting_ids, "meeting_ids", providerInputError);
    const meetings = parseMeetings(await callGranolaMcpTool(context, "get_meetings", input));
    if (meetings.length !== new Set(ids).size || meetings.some((meeting) => !ids.includes(meeting.id)))
      throw providerResponseError("Granola did not return every requested meeting.");
    return { meetings };
  },
  async get_meeting_transcript(input, context) {
    const id = requiredInputString(input.meeting_id, "meeting_id");
    return {
      meeting_id: id,
      transcript: parseTranscript(await callGranolaMcpTool(context, "get_meeting_transcript", input), id),
    };
  },
  list_meeting_folders: async (input, context) => ({
    text: await callGranolaMcpTool(context, "list_meeting_folders", input),
  }),
  query_meetings: async (input, context) => ({
    answer: await callGranolaMcpTool(context, "query_granola_meetings", input),
  }),
  get_account_info: async (input, context) =>
    requiredResponseRecord(
      parseProviderJsonBodyText(await callGranolaMcpTool(context, "get_account_info", input), {
        emptyBody: undefined,
        invalidJsonMessage: "Invalid Granola account response.",
      }),
      "Granola account",
    ),
};

/** Read advertised tool schemas without inferring capabilities from the account's subscription. */
export function listGranolaMcpTools(context: OAuthProviderContext, cursor?: string): Promise<Record<string, unknown>> {
  return withGranolaClient(context, (client, signal) => client.listTools({ cursor }, { signal }));
}

/** Execute a Granola tool through the same authenticated MCP transport for actions and acquisition. */
export function callGranolaMcpTool(
  context: OAuthProviderContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  return withGranolaClient(context, async (client, signal) => {
    const result = await client.callTool({ name, arguments: input }, { signal });
    if (result.isError) {
      const message = looseArray(result.content)
        .map((item) => optionalString(optionalRecord(item)?.text))
        .filter(Boolean)
        .join("\n");
      throw new ProviderRequestError(502, `Granola MCP tool ${name} failed${message ? `: ${message}` : "."}`, result);
    }
    if (!Array.isArray(result.content) || result.content.length === 0)
      throw providerResponseError("Granola MCP returned no content.");
    return result.content
      .map((item) => {
        const block = requiredResponseRecord(item, "Granola MCP content");
        if (block.type !== "text") throw providerResponseError("Granola MCP returned unsupported content.");
        return requiredRawString(block.text, "Granola MCP text", providerResponseError);
      })
      .join("\n");
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
