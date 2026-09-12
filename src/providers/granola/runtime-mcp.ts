import type { CredentialValidationResult, CredentialValidatorOptions, ResolvedCredential } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlerSubset, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import {
  objectArray,
  optionalString,
  requiredRawString,
  requiredString,
  requiredStringArray,
} from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  providerInputError,
  providerResponseError,
  providerUserAgent,
  ProviderRequestError,
  readProviderJsonBody,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";
import { parseGranolaMeetings, parseGranolaTranscript } from "./mcp-response.ts";

export const granolaMcpActionHandlers: ProviderActionHandlerSubset<
  "granola",
  ProviderRuntimeHandler<OAuthProviderContext>
> = {
  async list_meetings(_input, context) {
    const text = await callGranolaTool(context, "list_meetings", { time_range: "last_30_days" });
    return { meetings: parseGranolaMeetings(text) };
  },
  async get_meetings(input, context) {
    const ids = requiredStringArray(input.meeting_ids, "meeting_ids", providerInputError);
    const text = await callGranolaTool(context, "get_meetings", { meeting_ids: ids });
    const meetings = parseGranolaMeetings(text);
    const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
    if (meetings.length !== ids.length || ids.some((id) => !byId.has(id))) {
      throw providerResponseError("Granola did not return every requested meeting.");
    }
    return { meetings: ids.map((id) => byId.get(id)!) };
  },
  async get_meeting_transcript(input, context) {
    const meetingId = requiredInputString(input.meeting_id, "meeting_id");
    const text = await callGranolaTool(context, "get_meeting_transcript", { meeting_id: meetingId });
    return { meeting_id: meetingId, transcript: parseGranolaTranscript(text, meetingId) };
  },
};

function callGranolaTool(context: OAuthProviderContext, name: string, input: Record<string, unknown>): Promise<string> {
  return withGranolaClient(context, async (client, signal) => {
    const result = await client.callTool({ name, arguments: input }, { signal });
    if (result.isError) throw new ProviderRequestError(502, `Granola MCP tool ${name} failed.`, result);
    const content = objectArray(result.content, "Granola MCP content", providerResponseError);
    if (content.length === 0) throw providerResponseError("Granola MCP returned no meeting content.");
    return content
      .map((block) => {
        if (block.type !== "text") throw providerResponseError("Granola MCP returned unsupported meeting content.");
        return requiredRawString(block.text, "Granola meeting text", providerResponseError);
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
        headers: { authorization: `Bearer ${context.accessToken}`, "user-agent": providerUserAgent },
        redirect: "manual",
        signal,
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
      };
    });
  } catch (error) {
    if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
      throw new ProviderRequestError(400, "Granola OAuth credentials are invalid or MCP access is disabled.");
    }
    throw error;
  }
}
