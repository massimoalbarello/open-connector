import type { JsonObject } from "../../sync/sync-store.ts";

import { describe, expect, it } from "vitest";
import { githubPullRequests } from "./definition.ts";
import { githubPullRequestFixture as fixture } from "./pull-requests.test-fixture.ts";
import { run } from "./pull-requests.ts";

describe("GitHub pull request sync", () => {
  it("hydrates every independent related page including more than 250 commits", async () => {
    const { context, graphql } = fixture();
    const pages = await Array.fromAsync(run(context));
    const record = pages[0]!.records![0]!.record;
    expect(record.id).toBe("PR_native");
    expect(record.title).toBe("a/b #1: Complete PR");
    expect(record.body.startsWith(`# ${record.title}\n`)).toBe(true);
    for (const text of [
      "Author Markdown",
      "Comment 100",
      "Review 50",
      "Commit 300",
      "Thread 50",
      "src/file.ts:7",
      "State: MERGED",
    ])
      expect(record.body).toContain(text);
    expect(record.participants).toEqual([
      {
        identities: [{ namespace: "github", id: "U_1" }],
        roles: ["author", "commenter", "committer", "reviewer"],
        name: "octocat",
      },
    ]);
    expect(pages[0]!.checkpoint).toMatchObject({ cursor: "record-cursor" });
    expect(pages.at(-1)).toMatchObject({
      complete: true,
      checkpoint: { phase: "updates", cursor: null, watermark: context.startedAt },
    });
    expect(graphql.mock.calls.filter(([query]) => query.includes("SyncRelated")).length).toBeGreaterThan(5);
    expect((await Array.fromAsync(run(context)))[0]!.records![0]!.record).toEqual(record);
  });

  it("fails before emitting a record when a required related page fails", async () => {
    const { context, graphql } = fixture();
    const original = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, variables) => {
      if (query.includes("SyncRelated")) throw new Error("Required page failed");
      return original(query, variables);
    });
    await expect(run(context).next()).rejects.toThrow("Required page failed");
  });

  it("rejects incomplete core data and mid-hydration edits", async () => {
    const first = fixture();
    delete first.pull.body;
    await expect(run(first.context).next()).rejects.toThrow();
    const second = fixture();
    const original = second.graphql.getMockImplementation()!;
    second.graphql.mockImplementation(async (query, variables) =>
      query.includes("SyncVerifyPull")
        ? { node: { updatedAt: "2026-09-03T00:00:00Z", headRefOid: "new" } }
        : original(query, variables),
    );
    await expect(run(second.context).next()).rejects.toThrow("changed during hydration");
  });

  it("uses overlap for updates and reconciles child edits with unchanged parent timestamps", async () => {
    const { context, comments } = fixture();
    context.checkpoint = {
      phase: "updates",
      cursor: null,
      repositoryCursor: null,
      repositoryId: null,
      cycleStartedAt: null,
      watermark: "2026-09-02T00:00:00Z",
      reconciledAt: "2026-09-02T00:00:00Z",
    };
    context.startedAt = "2026-09-02T01:00:00Z";
    expect((await Array.fromAsync(run(context)))[0]?.records).toBeUndefined();
    comments[0]!.body = "Changed child with unchanged parent timestamp";
    context.startedAt = "2026-09-03T01:00:00Z";
    expect((await Array.fromAsync(run(context)))[0]!.records![0]!.record.body).toContain("Changed child");
    context.startedAt = "2026-09-01T00:04:00Z";
    context.checkpoint = { ...(context.checkpoint as JsonObject), watermark: "2026-09-01T00:04:00Z" };
    expect((await Array.fromAsync(run(context)))[0]!.records).toHaveLength(1);
  });

  it("does not infer deletions from missing discovery results", async () => {
    const { context } = fixture();
    context.checkpoint = { ...(githubPullRequests.initialCheckpoint as JsonObject), cursor: "record-cursor" };
    const pages = await Array.fromAsync(run(context));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.deletes).toBeUndefined();
  });
});

it("restarts expired cursors backwards without inventing deletes", async () => {
  const { context, graphql } = fixture();
  context.checkpoint = { ...(githubPullRequests.initialCheckpoint as JsonObject), cursor: "expired" };
  const { SyncStoreError } = await import("../../sync/sync-store.ts");
  graphql.mockRejectedValue(new SyncStoreError("cursor_expired", "Expired"));
  expect(await Array.fromAsync(run(context))).toEqual([
    { checkpoint: { ...(context.checkpoint as JsonObject), cursor: null }, complete: false },
  ]);
});

it("discovers accessible repositories without requiring filters and scopes cursors to each repository", async () => {
  const { context, graphql } = fixture();
  context.config.scope = "accessible";
  const original = graphql.getMockImplementation()!;
  graphql.mockImplementation(async (query, variables = {}) => {
    if (query.includes("SyncRepositories")) {
      const next = variables.after === "repo-1" ? "repo-2" : variables.after ? null : "repo-1";
      return {
        viewer: {
          repositories: {
            edges: next ? [{ cursor: next, node: { id: next } }] : [],
            pageInfo: { hasNextPage: next === "repo-1" },
          },
        },
      };
    }
    if (query.includes("SyncDiscover")) return { node: (await original(query, variables)).viewer };
    return original(query, variables);
  });
  const pages = await Array.fromAsync(run(context));
  expect(pages.filter((page) => page.records?.length)).toHaveLength(2);
  expect(pages.at(-1)?.complete).toBe(true);
});
