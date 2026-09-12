import type { ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { SqliteRuntimeDatabase } from "../../server/storage/sqlite-runtime-store.ts";
import { credentialValidators } from "./executors.ts";
import { createGmailSyncProvider } from "./sync-provider.ts";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn<typeof fetch>() }));
vi.mock("../provider-runtime.ts", async (original) => ({ ...(await original<object>()), providerFetch: fetcher }));

const credential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "test-token",
  tokenType: "Bearer",
  refreshToken: "refresh",
  profile: {
    accountId: "mutable@example.com",
    displayName: "Mutable",
    grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
  },
  metadata: {},
};

it("keeps Google source identity stable across email changes and does not invent identity for old grants", async () => {
  let email = "before@example.com";
  const google = vi.fn<typeof fetch>(async (input) =>
    Response.json(String(input).includes("userinfo") ? { sub: "90071992547409931234" } : { emailAddress: email }),
  );
  const first = await credentialValidators.oauth2!(credential, { fetcher: google });
  email = "after@example.com";
  const second = await credentialValidators.oauth2!(credential, { fetcher: google });
  expect(first?.sourceIdentity).toEqual({ accountId: "90071992547409931234", authorizationBoundary: "mailbox" });
  expect(second?.sourceIdentity).toEqual(first?.sourceIdentity);
  expect(second?.profile?.accountId).toBe(email);
  google.mockClear();
  expect(
    (
      await credentialValidators.oauth2!(
        { ...credential, profile: { ...credential.profile, grantedScopes: [] } },
        { fetcher: google },
      )
    )?.sourceIdentity,
  ).toBeUndefined();
  expect(google).toHaveBeenCalledTimes(1);
  google.mockImplementation(async (input) =>
    Response.json(String(input).includes("userinfo") ? {} : { emailAddress: email }),
  );
  await expect(credentialValidators.oauth2!(credential, { fetcher: google })).rejects.toMatchObject({ status: 502 });
});

describe("Gmail sync read adapter", () => {
  it("fetches the complete MIME resource, lists all mail, and preserves upstream error status", async () => {
    const database = new SqliteRuntimeDatabase(":memory:");
    try {
      await database.connectionStore.set("gmail", "default", credential);
      const connection = (await database.connectionStore.get("gmail", "default"))!;
      const provider = createGmailSyncProvider({ connection, signal: new AbortController().signal });
      fetcher.mockReset().mockImplementation(async () => Response.json({ raw: "raw" }));
      await provider.request("threads.list", { pageToken: "opaque & token" });
      await provider.request("messages.get", { id: "native-id" });
      await provider.request("history.list", { historyId: "90071992547409931234" });
      const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
      expect(urls[0]?.searchParams.get("includeSpamTrash")).toBe("true");
      expect(urls[0]?.searchParams.get("pageToken")).toBe("opaque & token");
      expect(urls[0]?.searchParams.has("q")).toBe(false);
      expect(urls[1]?.searchParams.get("format")).toBe("raw");
      expect(urls[2]?.searchParams.get("startHistoryId")).toBe("90071992547409931234");
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
        headers: { authorization: "Bearer test-token" },
        redirect: "error",
      });
      await expect(provider.request("messages.delete", { id: "native-id" })).rejects.toMatchObject({
        code: "invalid_input",
      });
      fetcher.mockResolvedValue(new Response("sensitive upstream body", { status: 404 }));
      await expect(provider.request("history.list", { historyId: "100" })).rejects.toMatchObject({
        status: 404,
        message: "Gmail sync request returned HTTP 404.",
      });
      fetcher.mockResolvedValue(new Response("{}", { headers: { "content-length": String(129 * 1024 * 1024) } }));
      await expect(provider.request("messages.get", { id: "native-id" })).rejects.toMatchObject({ status: 413 });
    } finally {
      database.close();
    }
  });
});
