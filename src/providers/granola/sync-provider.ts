import type { SyncProvider, SyncProviderContext } from "../../sync/provider-adapter.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { optionalString } from "../../core/cast.ts";
import { providerFetch, providerInputError } from "../provider-runtime.ts";

/** Restrict acquisition to tool discovery and meeting reads; the shared adapter fences the connection revision. */
export function createGranolaSyncProvider({ connection, signal }: SyncProviderContext): SyncProvider {
  if (connection.service !== "granola" || connection.credential.authType !== "oauth2")
    throw providerInputError("Granola sync requires a Granola OAuth connection.");
  const context = { accessToken: connection.credential.accessToken, fetcher: providerFetch, signal };
  return {
    async request(operation, input = {}) {
      if (!["list_tools", "list_meetings", "get_meetings", "get_meeting_transcript"].includes(operation))
        throw providerInputError("Unsupported Granola sync read operation.");
      const { callGranolaMcpTool, listGranolaMcpTools } = await import("./runtime-mcp.ts");
      if (operation === "list_tools")
        return (await listGranolaMcpTools(context, optionalString(input.cursor))) as JsonObject;
      return { text: await callGranolaMcpTool(context, operation, input) };
    },
  };
}
