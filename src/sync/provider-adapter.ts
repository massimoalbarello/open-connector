import type { IConnectionStore, StoredConnection } from "../connection-service.ts";
import type { JsonObject } from "./sync-store.ts";

import { SyncStoreError } from "./sync-store.ts";

export interface SyncProvider {
  graphql(query: string, variables?: JsonObject): Promise<JsonObject>;
}

export interface SyncProviderContext {
  connection: StoredConnection;
  signal: AbortSignal;
}

export interface SyncProviderOptions extends SyncProviderContext {
  connections: IConnectionStore;
  createProvider(context: SyncProviderContext): SyncProvider;
}

/** Pin every request to the verified credential, including the result returned after network I/O. */
export function createSyncProvider(options: SyncProviderOptions): SyncProvider {
  const { connection, signal } = options;
  const provider = options.createProvider({ connection, signal });
  const assertPinned = async (): Promise<void> => {
    signal.throwIfAborted();
    const current = await options.connections.get(connection.service, connection.connectionName);
    if (current?.id !== connection.id || current.revision !== connection.revision)
      throw new SyncStoreError("credential_changed", "Sync credential changed during acquisition.");
  };
  return {
    async graphql(query, variables) {
      if (!/^\s*query\b/.test(query) || /\b(mutation|subscription)\b/.test(query))
        throw new SyncStoreError("invalid_input", "Sync GraphQL accepts queries only.");
      await assertPinned();
      const result = await provider.graphql(query, variables);
      await assertPinned();
      return result;
    },
  };
}
