import type { JsonObject } from "../../sync/sync-store.ts";

import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { normalizeSyncRecord } from "../../sync/record-contract.ts";
import { githubPullRequests } from "./definition.ts";
import { githubPullRequestFixture as fixture } from "./pull-requests.test-fixture.ts";
import { run } from "./pull-requests.ts";

describe("GitHub pull request sync", () => {
  it("hydrates all discussion pages without fetching commits", async () => {
    const { context, graphql } = fixture();
    const pages = await Array.fromAsync(run(context));
    const record = pages[0]!.records![0]!.record;
    expect(record.id).toBe("PR_native");
    expect(record.title).toBe("a/b #1: Complete PR");
    expect(record.body.startsWith(`# ${record.title}\n`)).toBe(true);
    expect(record.body).not.toContain("## Commits");
    expect(graphql.mock.calls.some(([query]) => query.includes("commits("))).toBe(false);
    for (const text of ["Author Markdown", "Comment 100", "Review 50", "Thread 50", "src/file.ts:7", "State: MERGED"])
      expect(record.body).toContain(text);
    expect(record.participants).toEqual([
      {
        identities: [{ namespace: "github", id: "U_1" }],
        roles: ["author", "commenter", "reviewer"],
        name: "octocat",
      },
    ]);
    expect(pages[0]!.checkpoint).toMatchObject({ cursor: "record-cursor" });
    expect(pages.at(-1)).toMatchObject({
      complete: true,
      checkpoint: { phase: "updates", cursor: null, watermark: context.startedAt },
    });
    expect((await Array.fromAsync(run(context)))[0]!.records![0]!.record).toEqual(record);
  });

  it("contains authored headings and code within the description and omits empty activity sections", async () => {
    const { context, pull } = fixture();
    const description = "# Why\n\nOriginal text\n\nHow\n---\n\n```md\n## Code, not a section\n```\n\n> Existing quote";
    pull.body = description;
    for (const field of ["comments", "reviews", "reviewThreads"])
      pull[field] = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
    const record = (await Array.fromAsync(run(context)))[0]!.records![0]!.record;
    const markdown = fromMarkdown(record.body);
    expect(markdown.children.filter((node) => node.type === "heading")).toMatchObject([
      { depth: 1, children: [{ value: "a/b #1: Complete PR" }] },
      { depth: 2, children: [{ value: "Description" }] },
    ]);
    const quote = markdown.children.find((node) => node.type === "blockquote");
    expect(quote?.children).toEqual(
      fromMarkdown(description).children.map((node) =>
        expect.objectContaining({
          type: node.type,
        }),
      ),
    );
    expect(quote?.children.find((node) => node.type === "code")).toMatchObject({
      lang: "md",
      value: "## Code, not a section",
    });
    expect(record.body).not.toMatch(/^## (Comments|Reviews|Review discussions|Commits)$/m);
    expect(normalizeSyncRecord(record, githubPullRequests.kinds[0]!).id).toBe("PR_native");
  });

  it.each([
    ["comments", "Comments"],
    ["reviews", "Reviews"],
    ["reviewThreads", "Review discussions"],
  ])("omits only the empty %s section", async (field, heading) => {
    const { context, pull } = fixture();
    pull[field] = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
    const record = (await Array.fromAsync(run(context)))[0]!.records![0]!.record;
    for (const section of ["Comments", "Reviews", "Review discussions"])
      expect(record.body.includes(`\n\n## ${section}\n\n`)).toBe(section !== heading);
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
