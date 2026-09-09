import { describe, expect, it } from "vitest";
import { verifyGitHubUser } from "../providers/github/source-identity.ts";

describe("GitHub source identity", () => {
  it("uses native IDs and normalized verified scopes, never a reused login", async () => {
    const first = await verifyGitHubUser("token", {
      fetcher: async () =>
        Response.json(
          { node_id: "U_native", login: "old", type: "User" },
          { headers: { "x-oauth-scopes": "repo, read:user, repo" } },
        ),
    });
    const second = await verifyGitHubUser("replacement", {
      fetcher: async () =>
        Response.json(
          { node_id: "U_native", login: "renamed", type: "User" },
          { headers: { "x-oauth-scopes": "read:user,repo" } },
        ),
    });
    expect(first.sourceIdentity).toEqual(second.sourceIdentity);
    expect(first.sourceIdentity?.accountId).toBe("U_native");
    const other = await verifyGitHubUser("other", {
      fetcher: async () =>
        Response.json({ node_id: "U_other", login: "old", type: "User" }, { headers: { "x-oauth-scopes": "repo" } }),
    });
    expect(other.sourceIdentity).not.toEqual(first.sourceIdentity);
  });
  it("does not guess fine-grained or installation grant boundaries", async () => {
    const result = await verifyGitHubUser("token", {
      fetcher: async () => Response.json({ node_id: "U_native", login: "name", type: "User" }),
    });
    expect(result.sourceIdentity).toBeUndefined();
  });
});
