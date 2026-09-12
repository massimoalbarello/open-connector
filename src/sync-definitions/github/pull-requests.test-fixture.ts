import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";
import type { Mock } from "vitest";

import { vi } from "vitest";
import { describeSyncAsset } from "../../sync/asset-store.ts";
import { githubPullRequests } from "./definition.ts";

interface GitHubPullRequestFixture {
  context: SyncContext;
  graphql: Mock<(query: string, variables?: JsonObject) => Promise<JsonObject>>;
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
const page = (nodes: unknown[], offset = 0) => ({
  totalCount: nodes.length,
  nodes: nodes.slice(offset, offset + 50),
  pageInfo: { hasNextPage: offset + 50 < nodes.length, endCursor: String(offset + 50) },
});

export function githubPullRequestFixture(): GitHubPullRequestFixture {
  const comments = Array.from({ length: 101 }, (_, index) => comment(index));
  const reviews = Array.from({ length: 51 }, (_, index) => review(index));
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
    reviewThreads: page(threads),
  };
  const graphql = vi.fn<(query: string, variables?: JsonObject) => Promise<JsonObject>>(
    async (query, variables = {}) => {
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
      throw new Error("Unexpected query");
    },
  );
  const context: SyncContext = {
    records: { list: async () => ({ ids: [], throughSequence: 0 }) },
    assets: { stage: async (input) => describeSyncAsset(input) },
    provider: { request: (_operation, input = {}) => graphql(String(input.query), input.variables as JsonObject) },
    checkpoint: githubPullRequests.initialCheckpoint,
    config: { scope: "authored" },
    sourceId: "source",
    startedAt: "2026-09-02T00:00:00Z",
    signal: new AbortController().signal,
  };
  return { context, graphql, pull, comments };
}
