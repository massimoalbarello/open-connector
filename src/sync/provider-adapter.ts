import type { IConnectionStore, StoredConnection } from "../connection-service.ts";
import type { JsonObject } from "./sync-store.ts";

import { SyncStoreError } from "./sync-store.ts";

export interface SyncProvider {
  /** Adapter-owned read operation; credentials never reach the acquisition definition. */
  request(operation: string, input?: JsonObject): Promise<JsonObject>;
}

export interface SyncProviderContext {
  connection: StoredConnection;
  signal: AbortSignal;
}

export interface SyncProviderOptions extends SyncProviderContext {
  connections: IConnectionStore;
  assertActive?(): void;
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
    options.assertActive?.();
  };
  return {
    async request(operation, input) {
      await assertPinned();
      const result = await provider.request(operation, input);
      await assertPinned();
      return result;
    },
  };
}
