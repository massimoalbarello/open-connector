import type { IConnectionStore, StoredConnection } from "../connection-service.ts";
import type { SyncDefinition, SyncProvider } from "./sync-definition.ts";
import type { JsonObject } from "./sync-store.ts";

import { readBoundedResponseBytes } from "../core/request.ts";
import { githubApiBaseUrl, githubHeaders } from "../providers/github/runtime-shared.ts";
import {
  requiredResponseRecord,
  providerFetch,
  runProviderRequest,
  ProviderRequestError,
} from "../providers/provider-runtime.ts";
import { SyncStoreError } from "./sync-store.ts";

export interface SyncProviderOptions {
  connection: StoredConnection;
  connections: IConnectionStore;
  definition: SyncDefinition;
  signal: AbortSignal;
}

/** Credentials stay pinned in this framework closure; definitions receive only read capabilities. */
export function createSyncProvider(options: SyncProviderOptions): SyncProvider {
  const { connection, definition, signal } = options;
  if (definition.provider !== "github")
    throw new SyncStoreError("invalid_input", "No compiled sync adapter for this provider.");
  const credential = connection.credential;
  const token =
    credential.authType === "oauth2"
      ? credential.accessToken
      : credential.authType === "api_key"
        ? credential.apiKey
        : undefined;
  if (!token) throw new SyncStoreError("invalid_input", "GitHub sync requires a user token.");
  const assertPinned = async (): Promise<void> => {
    signal.throwIfAborted();
    const current = await options.connections.get(connection.service, connection.connectionName);
    if (current?.id !== connection.id || current.revision !== connection.revision)
      throw new SyncStoreError("credential_changed", "Sync credential changed during acquisition.");
  };
  const request = async (query: string, variables: JsonObject): Promise<unknown> => {
    await assertPinned();
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
      await assertPinned();
      return JSON.parse(new TextDecoder().decode(bytes));
    });
  };
  return {
    async graphql(query, variables = {}) {
      // Compiled queries are trusted, but this capability deliberately does not support mutations.
      if (!/^\s*query\b/.test(query) || /\b(mutation|subscription)\b/.test(query))
        throw new SyncStoreError("invalid_input", "Sync GraphQL accepts queries only.");
      const envelope = requiredResponseRecord(await request(query, variables), "GitHub GraphQL");
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
