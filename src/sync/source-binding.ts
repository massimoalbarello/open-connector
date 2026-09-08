import type { ConnectionService, VerifiedSourceConnection } from "../connection-service.ts";
import type { SyncInstallation, ISyncStore } from "./sync-store.ts";

export interface BindSyncSourceInput {
  /** Optional stable internal binding ID, primarily for explicit legacy resolution. */
  id?: string;
  definitionId: string;
  definitionVersion: string;
  provider: string;
  config: unknown;
  verifiedConnection: VerifiedSourceConnection;
  expectedBindingRevision: number;
  /** Operator attestation that this legacy installation belongs to the verified source. */
  resolveLegacyIdentity?: boolean;
  createdAt: string;
}

export interface ISyncSourceStore {
  getBindingRevision(): number;
  /** Internal persistence boundary: accept only fresh evidence from ConnectionService. */
  bind(input: BindSyncSourceInput): Promise<string>;
}

export interface VerifySyncSourceInput {
  id?: string;
  definitionId: string;
  definitionVersion: string;
  provider: string;
  connectionName?: string;
  config?: unknown;
  resolveLegacyIdentity?: boolean;
  signal?: AbortSignal;
}

/** Auth runs outside SQLite. The store fences both credential and binding changes afterward. */
export class SyncSourceBindingService {
  private readonly connections: ConnectionService;
  private readonly store: ISyncStore;

  constructor(connections: ConnectionService, store: ISyncStore) {
    this.connections = connections;
    this.store = store;
  }

  async bind(input: VerifySyncSourceInput): Promise<SyncInstallation> {
    const expectedBindingRevision = this.store.sources.getBindingRevision();
    const verifiedConnection = await this.connections.verifySourceConnection(
      input.provider,
      input.connectionName,
      input.signal,
    );
    input.signal?.throwIfAborted();
    const id = await this.store.sources.bind({
      id: input.id,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      provider: input.provider,
      config: input.config ?? {},
      verifiedConnection,
      expectedBindingRevision,
      resolveLegacyIdentity: input.resolveLegacyIdentity,
      createdAt: new Date().toISOString(),
    });
    return (await this.store.getInstallation(id))!;
  }
}
