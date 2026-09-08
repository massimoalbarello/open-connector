import type { CatalogStore } from "../catalog-store.ts";
import type { IConnectionStore, StoredConnection } from "../connection-service.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { SyncDefinition, SyncProvider } from "./sync-definition.ts";
import type { JsonObject } from "./sync-store.ts";

import { readBoundedResponseBytes } from "../core/request.ts";
import { validateActionInput } from "../core/validation.ts";
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
  catalog: CatalogStore;
  loader: IProviderLoader;
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
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    await assertPinned();
    const url = new URL(path, githubApiBaseUrl);
    if (!path.startsWith("/") || url.origin !== githubApiBaseUrl || url.username || url.password || url.hash)
      throw new SyncStoreError("invalid_input", "Sync requests must stay on the provider API origin.");
    return runProviderRequest({ signal, label: "GitHub sync" }, async (requestSignal) => {
      const response = await providerFetch(url, {
        method,
        headers: githubHeaders(token, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
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
    async get(path, query) {
      const url = new URL(path, githubApiBaseUrl);
      if (url.origin !== githubApiBaseUrl || !path.startsWith("/"))
        throw new SyncStoreError("invalid_input", "Invalid provider path.");
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      return request(url.pathname + url.search, "GET");
    },
    async graphql(query, variables = {}) {
      // Compiled queries are trusted, but this capability deliberately does not support mutations.
      if (!/^\s*query\b/.test(query) || /\b(mutation|subscription)\b/.test(query))
        throw new SyncStoreError("invalid_input", "Sync GraphQL accepts queries only.");
      const envelope = requiredResponseRecord(
        await request("/graphql", "POST", { query, variables }),
        "GitHub GraphQL",
      );
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
    async action(name, input) {
      await assertPinned();
      if (!definition.readActions?.includes(name))
        throw new SyncStoreError("invalid_input", "Action is not in this definition's read-only allowlist.");
      const action = options.catalog.actions.find((item) => item.id === name && item.service === definition.provider);
      if (!action || !validateActionInput(action, input).valid)
        throw new SyncStoreError("invalid_input", "Invalid sync Action input.");
      const executor = await options.loader.loadActionExecutor(definition.provider, name);
      if (!executor) throw new SyncStoreError("invalid_input", "Sync Action is unavailable.");
      const result = await executor(input, {
        getCredential: async (service) => (service === definition.provider ? credential : undefined),
        signal,
      });
      await assertPinned();
      if (!result.ok) throw new ProviderRequestError(502, "Sync Action failed.");
      return result.output;
    },
  };
}
