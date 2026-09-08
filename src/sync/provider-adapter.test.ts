import { describe, expect, it, vi } from "vitest";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { githubPullRequests } from "../sync-definitions/github/definition.ts";
import { createSyncProvider } from "./provider-adapter.ts";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn<typeof fetch>() }));
vi.mock("../providers/provider-runtime.ts", async (original) => ({
  ...(await original<object>()),
  providerFetch: fetcher,
}));

describe("sync provider capability", () => {
  it("pins credentials, restricts requests, and discards partial GraphQL responses", async () => {
    const database = new SqliteRuntimeDatabase(":memory:");
    try {
      const credential = {
        authType: "api_key" as const,
        apiKey: "private-token",
        profile: { accountId: "user", displayName: "User", grantedScopes: [] },
        metadata: {},
        values: {},
      };
      await database.connectionStore.set("github", "default", credential);
      const connection = (await database.connectionStore.get("github", "default"))!;
      const provider = createSyncProvider({
        connection,
        connections: database.connectionStore,
        definition: githubPullRequests,
        signal: new AbortController().signal,
      });
      fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { viewer: { id: "native" } } })));
      expect(await provider.graphql("query { viewer { id } }")).toEqual({ viewer: { id: "native" } });
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/graphql");
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        redirect: "error",
        headers: { authorization: "Bearer private-token" },
      });
      await expect(provider.graphql("mutation { deleteIssue }")).rejects.toThrow("queries only");
      fetcher.mockResolvedValue(
        new Response(JSON.stringify({ data: { viewer: {} }, errors: [{ message: "unavailable" }] })),
      );
      await expect(provider.graphql("query { viewer { id } }")).rejects.toThrow("partial data was discarded");
      await database.connectionStore.set("github", "default", { ...credential, apiKey: "replacement" });
      await expect(provider.graphql("query { viewer { id } }")).rejects.toThrow("credential changed");
    } finally {
      database.close();
    }
  });
});
