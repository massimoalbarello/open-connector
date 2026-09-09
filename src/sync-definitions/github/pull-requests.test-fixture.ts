import type { SyncProvider } from "../../sync/provider-adapter.ts";
import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";
import type { Mock } from "vitest";

import { vi } from "vitest";
import { githubPullRequests } from "./definition.ts";

interface GitHubPullRequestFixture {
  context: SyncContext;
  graphql: Mock<SyncProvider["graphql"]>;
  pull: Record<string, unknown>;
  comments: Record<string, unknown>[];
}

const timestamp = "2026-09-01T00:00:00Z";
const actor = { id: "U_1", login: "octocat", url: "https://github.com/octocat" };
const comment = (id: number) => ({
  id: `comment-${id}`,
  body: `Comment ${id}`,
  createdAt: timestamp,
  updatedAt: timestamp,
  url: `https://github.com/a/b/pull/1#comment-${id}`,
  author: actor,
});
const review = (id: number) => ({
  id: `review-${id}`,
  body: `Review ${id}`,
  submittedAt: timestamp,
  state: "APPROVED",
  url: `https://github.com/a/b/pull/1#review-${id}`,
  author: actor,
});
const commit = (id: number) => ({
  commit: {
    oid: `sha-${id}`,
    message: `Commit ${id}`,
    committedDate: timestamp,
    url: `https://github.com/a/b/commit/sha-${id}`,
    author: { user: actor },
  },
});
const page = (nodes: unknown[], offset = 0) => ({
  totalCount: nodes.length,
  nodes: nodes.slice(offset, offset + 50),
  pageInfo: { hasNextPage: offset + 50 < nodes.length, endCursor: String(offset + 50) },
});

export function githubPullRequestFixture(): GitHubPullRequestFixture {
  const comments = Array.from({ length: 101 }, (_, index) => comment(index));
  const reviews = Array.from({ length: 51 }, (_, index) => review(index));
  const commits = Array.from({ length: 301 }, (_, index) => commit(index));
  const threadComments = Array.from({ length: 51 }, (_, index) => ({ ...comment(index), body: `Thread ${index}` }));
  const threads = [
    {
      id: "thread-1",
      path: "src/file.ts",
      line: 7,
      isResolved: true,
      isOutdated: false,
      comments: page(threadComments),
    },
  ];
  const pull: Record<string, unknown> = {
    id: "PR_native",
    number: 1,
    title: "Complete PR",
    body: "Author Markdown",
    url: "https://github.com/a/b/pull/1",
    createdAt: timestamp,
    updatedAt: timestamp,
    state: "MERGED",
    isDraft: false,
    mergedAt: timestamp,
    closedAt: timestamp,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "sha-300",
    repository: { id: "R_native", nameWithOwner: "a/b", url: "https://github.com/a/b" },
    author: actor,
    comments: page(comments),
    reviews: page(reviews),
    commits: page(commits),
    reviewThreads: page(threads),
  };
  const graphql = vi.fn<SyncProvider["graphql"]>(async (query, variables = {}) => {
    if (query.includes("SyncDiscover"))
      return {
        viewer: {
          pullRequests: {
            edges: variables.after
              ? []
              : [{ cursor: "record-cursor", node: { id: "PR_native", updatedAt: timestamp } }],
            pageInfo: { hasNextPage: false },
          },
        },
      };
    if (query.includes("SyncPullRequest")) return { node: structuredClone(pull) } as JsonObject;
    if (query.includes("SyncVerifyPull"))
      return { node: { updatedAt: pull.updatedAt, headRefOid: pull.headRefOid } } as JsonObject;
    const offset = Number(variables.after);
    if (variables.id === "thread-1") return { node: { comments: page(threadComments, offset) } } as JsonObject;
    if (query.includes("comments(first:")) return { node: { comments: page(comments, offset) } } as JsonObject;
    if (query.includes("reviews(first:")) return { node: { reviews: page(reviews, offset) } } as JsonObject;
    if (query.includes("commits(first:")) return { node: { commits: page(commits, offset) } } as JsonObject;
    throw new Error("Unexpected query");
  });
  const context: SyncContext = {
    provider: { graphql },
    checkpoint: githubPullRequests.initialCheckpoint,
    config: { scope: "authored" },
    sourceId: "source",
    startedAt: "2026-09-02T00:00:00Z",
    signal: new AbortController().signal,
  };
  return { context, graphql, pull, comments };
}
