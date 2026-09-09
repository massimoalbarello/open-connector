import type { SyncProvider, SyncProviderContext } from "../../sync/provider-adapter.ts";

import { providerFetch, providerInputError } from "../provider-runtime.ts";

/** Credentials stay in the provider adapter; the framework pins their revision around every request. */
export function createGranolaSyncProvider({ connection, signal }: SyncProviderContext): SyncProvider {
  if (connection.service !== "granola_mcp" || connection.credential.authType !== "oauth2")
    throw providerInputError("Granola sync requires a Granola OAuth connection.");
  const context = { accessToken: connection.credential.accessToken, fetcher: providerFetch, signal };
  return {
    async request(operation, input = {}) {
      const { callGranolaTool } = await import("./runtime.ts");
      const { text } = await callGranolaTool(context, operation, input);
      return { text };
    },
  };
}
