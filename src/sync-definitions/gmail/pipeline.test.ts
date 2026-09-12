import { expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { provider as gmailCatalog } from "../../providers/gmail/definition.ts";
import { ProviderLoader } from "../../providers/provider-loader.ts";
import { SqliteRuntimeDatabase } from "../../server/storage/sqlite-runtime-store.ts";
import { canonicalizeJsonObject } from "../../sync/record-hash.ts";
import { SyncRunner } from "../../sync/sync-runner.ts";
import { gmailThreads } from "./definition.ts";
import { fixture } from "./threads.test-fixture.ts";
import { run } from "./threads.ts";

it("retains complete Gmail attachments through acquisition, delivery and a repeated backfill", async () => {
  const database = new SqliteRuntimeDatabase(":memory:", { syncDefinitions: [gmailThreads] });
  try {
    await database.connectionStore.set("gmail", "default", {
      authType: "oauth2",
      accessToken: "fixture",
      tokenType: "Bearer",
      metadata: {},
      profile: {
        accountId: "ada@example.com",
        displayName: "Ada",
        grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
      },
    });
    const connections = new ConnectionService({
      catalog: createCatalogStore([gmailCatalog]),
      store: database.connectionStore,
      providerLoader: new ProviderLoader({
        gmail: async () => ({
          executors: {},
          credentialValidators: {
            oauth2: async () => ({
              sourceIdentity: { accountId: "native-google-id", authorizationBoundary: "mailbox" },
            }),
          },
        }),
      }),
    });
    await database.syncStore.delivery.configure({
      enabled: true,
      url: "https://receiver.example/api/records/batch",
      assetsUrl: "https://receiver.example/api/assets/imports",
      bearerToken: "sync-key",
    });
    const { context } = fixture();
    const makeRunner = () =>
      new SyncRunner({
        store: database.syncStore,
        connectionStore: database.connectionStore,
        connections,
        registrations: [
          { definition: gmailThreads, load: async () => ({ run }), createProvider: () => context.provider },
        ],
      });
    const preview = await makeRunner().run({ definitionId: gmailThreads.id, dryRun: true });
    expect(preview.preview?.[0]).toMatchObject({ id: "a" });
    expect((await database.syncStore.listChanges()).items).toHaveLength(0);
    const first = await makeRunner().run({ definitionId: gmailThreads.id, maxPages: 1 });
    expect(first.complete).toBe(false);
    expect((await database.syncStore.listChanges()).items).toHaveLength(1);
    expect(await database.syncStore.getCheckpoint(first.installationId!)).toMatchObject({
      value: { pendingIds: [], historyId: "100" },
    });
    const acquired = await makeRunner().run({ definitionId: gmailThreads.id });
    expect(acquired.complete).toBe(true);
    const changes = (await database.syncStore.listChanges()).items;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ recordId: "a", recordRevision: 1 });
    const delivery = database.syncStore.delivery;
    const lease = (await delivery.claim(new Date().toISOString()))!;
    const pending = delivery.pendingAssets(lease);
    expect(pending).toHaveLength(2);
    expect(pending.map((asset) => Buffer.from(delivery.readAsset(lease, asset.sha256)).toString()).sort()).toEqual([
      "",
      "hello",
    ]);
    for (const asset of pending)
      delivery.assetUploaded(lease, {
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        assetId: `file-${asset.sha256}`,
        url: `context-use://asset/file-${asset.sha256}`,
      });
    const body = JSON.parse(delivery.prepare(lease));
    expect(body.records[0].content.assetIds).toHaveLength(2);
    expect(body.records[0].content.body).toContain("context-use://asset/file-");
    expect(body.records[0].content.body).not.toContain("open-connector://asset/");
    expect(body.records[0].contentHash).toBe(canonicalizeJsonObject(body.records[0].content).sha256);
    delivery.complete({ lease, acknowledged: true, now: new Date().toISOString() });
    expect(await database.syncStore.getRecord(first.installationId!, "thread", "a")).toMatchObject({
      revision: 1,
      content: undefined,
    });
    // Delivery removed the body. A full rebuild must still be deterministic and avoid a new revision.
    expect((await makeRunner().run({ definitionId: gmailThreads.id, backfill: true })).complete).toBe(true);
    expect((await database.syncStore.listChanges()).items).toHaveLength(1);
  } finally {
    database.close();
  }
});
