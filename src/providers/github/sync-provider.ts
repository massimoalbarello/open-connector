import type { SyncProvider, SyncProviderContext } from "../../sync/provider-adapter.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { readBoundedResponseBytes } from "../../core/request.ts";
import { SyncStoreError } from "../../sync/sync-store.ts";
import {
  requiredResponseRecord,
  requiredInputString,
  providerFetch,
  runProviderRequest,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { githubApiBaseUrl, githubHeaders } from "./runtime-shared.ts";

/** GitHub authentication and GraphQL response semantics; the framework fences credential revisions. */
export function createGitHubSyncProvider({ connection, signal }: SyncProviderContext): SyncProvider {
  if (connection.service !== "github")
    throw new SyncStoreError("invalid_input", "GitHub sync requires a GitHub connection.");
  const credential = connection.credential;
  const token =
    credential.authType === "oauth2"
      ? credential.accessToken
      : credential.authType === "api_key"
        ? credential.apiKey
        : undefined;
  if (!token) throw new SyncStoreError("invalid_input", "GitHub sync requires a user token.");
  const request = async (query: string, variables: JsonObject): Promise<unknown> => {
    return runProviderRequest({ signal, label: "GitHub sync" }, async (requestSignal) => {
      const response = await providerFetch(`${githubApiBaseUrl}/graphql`, {
        method: "POST",
        headers: githubHeaders(token, true),
        body: JSON.stringify({ query, variables }),
        signal: requestSignal,
        redirect: "error",
      });
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: 16 * 1024 * 1024,
        fieldName: "GitHub response",
        createError: (message) => new ProviderRequestError(502, message),
      });
      if (!response.ok)
        throw new ProviderRequestError(response.status, `GitHub sync request returned HTTP ${response.status}.`);
      return JSON.parse(new TextDecoder().decode(bytes));
    });
  };
  return {
    async request(operation, input = {}) {
      const query = requiredInputString(input.query, "query");
      if (operation !== "graphql" || !/^\s*query\b/.test(query) || /\b(mutation|subscription)\b/.test(query))
        throw new SyncStoreError("invalid_input", "Sync GraphQL accepts queries only.");
      const variables = input.variables as JsonObject | undefined;
      const envelope = requiredResponseRecord(await request(query, variables ?? {}), "GitHub GraphQL");
      if (
        Array.isArray(envelope.errors) &&
        envelope.errors.some((item) => {
          const error = requiredResponseRecord(item, "GraphQL error");
          return error.type === "INVALID_CURSOR_ARGUMENTS" || error.type === "INVALID_CURSOR";
        })
      )
        throw new SyncStoreError("cursor_expired", "GitHub pagination cursor is no longer valid.");
      if (envelope.errors !== undefined)
        throw new ProviderRequestError(502, "GitHub GraphQL returned errors; partial data was discarded.");
      return requiredResponseRecord(envelope.data, "GitHub GraphQL data") as JsonObject;
    },
  };
}
