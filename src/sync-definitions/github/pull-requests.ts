import type { SyncRecordInput } from "../../sync/record-contract.ts";
import type { SyncContext, SyncPage } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { requiredResponseRecord, providerResponseError } from "../../providers/provider-runtime.ts";
import { SyncStoreError } from "../../sync/sync-store.ts";
import { actorSelection, collectNodes, pageSelection } from "./graphql.ts";
import { renderPullRequest } from "./render.ts";

const commentsSelection = `id body url createdAt updatedAt author { ${actorSelection} }`;
const reviewsSelection = `id body url submittedAt state author { ${actorSelection} }`;
const threadSelection = `id path line isResolved isOutdated comments(first: 50) { nodes { ${commentsSelection} } ${pageSelection} }`;
const coreSelection = `id number title body url createdAt updatedAt state isDraft mergedAt closedAt baseRefName headRefName headRefOid repository { id nameWithOwner url } author { ${actorSelection} }`;
const hydrateQuery = `query SyncPullRequest($id: ID!) { node(id: $id) { ... on PullRequest { ${coreSelection}
  comments(first: 50) { nodes { ${commentsSelection} } ${pageSelection} }
  reviews(first: 50) { nodes { ${reviewsSelection} } ${pageSelection} }
  reviewThreads(first: 50) { nodes { ${threadSelection} } ${pageSelection} }
} } }`;

async function hydrate(context: SyncContext, id: string): Promise<SyncRecordInput> {
  const pull = requiredResponseRecord(
    (await context.provider.request("graphql", { query: hydrateQuery, variables: { id } })).node,
    "GitHub pull request",
  );
  if (pull.id !== id) throw providerResponseError("GitHub returned a different pull request identity.");
  const comments = await collectNodes(context, id, "PullRequest", "comments", commentsSelection, pull.comments);
  const reviews = await collectNodes(context, id, "PullRequest", "reviews", reviewsSelection, pull.reviews);
  const threads = await collectNodes(context, id, "PullRequest", "reviewThreads", threadSelection, pull.reviewThreads);
  for (const thread of threads)
    thread.comments = await collectNodes(
      context,
      String(thread.id),
      "PullRequestReviewThread",
      "comments",
      commentsSelection,
      thread.comments,
    );
  const latest = requiredResponseRecord(
    (
      await context.provider.request("graphql", {
        query: "query SyncVerifyPull($id: ID!) { node(id: $id) { ... on PullRequest { updatedAt headRefOid } } }",
        variables: { id },
      })
    ).node,
    "GitHub pull request",
  );
  if (latest.updatedAt !== pull.updatedAt || latest.headRefOid !== pull.headRefOid)
    throw providerResponseError("Pull request changed during hydration; retry the record.");
  return renderPullRequest({
    pull,
    comments,
    reviews,
    threads,
  });
}

/**
 * Authored PRs: stable creation-order backfill, updated-order polling with five-minute overlap,
 * and daily full rehydration for child edits/deletions that need not advance parent updatedAt.
 * Accessible mode enumerates affiliated repositories and fully rehydrates each cycle. Neither
 * mode infers deletes from absence/permission loss. Each yielded record includes all children.
 * Native GraphQL connections avoid Search's 1,000-result cap.
 * Cursors are opaque and persisted only after hydration. Expired discovery cursors restart
 * backwards without resetting records. Manual backfill also restarts discovery.
 */
async function* discover(context: SyncContext): AsyncGenerator<SyncPage> {
  let checkpoint = { ...(context.checkpoint as JsonObject) };
  const accessible = context.config.scope === "accessible";
  if (checkpoint.cycleStartedAt === null) {
    const due =
      !checkpoint.reconciledAt ||
      Date.parse(context.startedAt) - Date.parse(String(checkpoint.reconciledAt)) >= 86_400_000;
    checkpoint = {
      ...checkpoint,
      phase: accessible || due ? "reconcile" : checkpoint.phase,
      cycleStartedAt: context.startedAt,
    };
  }
  const updates = checkpoint.phase === "updates";
  const order = updates ? "{field: UPDATED_AT, direction: DESC}" : "{field: CREATED_AT, direction: ASC}";
  const cutoff = checkpoint.watermark ? Date.parse(String(checkpoint.watermark)) - 300_000 : 0;
  const cursors = new Set<string>();
  while (true) {
    context.signal.throwIfAborted();
    if (accessible && !checkpoint.repositoryId) {
      const data = await context.provider.request("graphql", {
        query:
          "query SyncRepositories($after: String) { viewer { repositories(first: 1, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: CREATED_AT, direction: ASC}) { edges { cursor node { id } } pageInfo { hasNextPage } } } }",
        variables: { after: checkpoint.repositoryCursor },
      });
      const repositories = requiredResponseRecord(
        requiredResponseRecord(data.viewer, "GitHub viewer").repositories,
        "GitHub repositories",
      );
      if (!Array.isArray(repositories.edges)) throw providerResponseError("Missing repository discovery page.");
      const page = requiredResponseRecord(repositories.pageInfo, "GitHub repository pagination");
      if (typeof page.hasNextPage !== "boolean" || (page.hasNextPage && !repositories.edges.length))
        throw providerResponseError("Incomplete GitHub repository pagination.");
      if (!repositories.edges.length) break;
      const edge = requiredResponseRecord(repositories.edges[0], "GitHub repository edge");
      const repository = requiredResponseRecord(edge.node, "GitHub repository");
      if (
        typeof repository.id !== "string" ||
        !repository.id ||
        typeof edge.cursor !== "string" ||
        !edge.cursor ||
        edge.cursor === checkpoint.repositoryCursor
      )
        throw providerResponseError("Invalid or repeated GitHub repository cursor.");
      checkpoint.repositoryId = repository.id;
      checkpoint.repositoryCursor = edge.cursor;
    }
    const collection = `pullRequests(first: 10, after: $after, orderBy: ${order}) { edges { cursor node { id updatedAt } } pageInfo { hasNextPage } }`;
    const query = accessible
      ? `query SyncDiscover($after: String, $id: ID!) { node(id: $id) { ... on Repository { ${collection} } } }`
      : `query SyncDiscover($after: String) { viewer { ${collection} } }`;
    const variables: JsonObject = { after: checkpoint.cursor };
    if (accessible) variables.id = checkpoint.repositoryId;
    const data = await context.provider.request("graphql", { query, variables });
    const list = requiredResponseRecord(
      requiredResponseRecord(accessible ? data.node : data.viewer, "GitHub discovery parent").pullRequests,
      "GitHub discovery",
    );
    if (!Array.isArray(list.edges)) throw providerResponseError("Missing pull request discovery page.");
    let reachedWatermark = false;
    for (const item of list.edges) {
      const edge = requiredResponseRecord(item, "GitHub edge");
      const node = requiredResponseRecord(edge.node, "GitHub pull request");
      if (updates && Date.parse(String(node.updatedAt)) < cutoff) {
        reachedWatermark = true;
        break;
      }
      if (
        typeof edge.cursor !== "string" ||
        typeof node.id !== "string" ||
        cursors.has(`${checkpoint.repositoryId}:${edge.cursor}`)
      )
        throw providerResponseError("Invalid or repeated GitHub discovery cursor.");
      cursors.add(`${checkpoint.repositoryId}:${edge.cursor}`);
      const record = await hydrate(context, node.id);
      checkpoint = { ...checkpoint, cursor: edge.cursor };
      yield { records: [{ kind: "pull-request", record }], checkpoint, complete: false };
    }
    const page = requiredResponseRecord(list.pageInfo, "GitHub discovery pagination");
    if (typeof page.hasNextPage !== "boolean" || (page.hasNextPage && !list.edges.length))
      throw providerResponseError("Incomplete GitHub discovery pagination.");
    if (!reachedWatermark && page.hasNextPage) continue;
    if (!accessible) break;
    checkpoint = { ...checkpoint, cursor: null, repositoryId: null };
    yield { checkpoint, complete: false };
  }
  yield {
    checkpoint: {
      phase: "updates",
      cursor: null,
      repositoryCursor: null,
      repositoryId: null,
      cycleStartedAt: null,
      watermark: checkpoint.cycleStartedAt,
      reconciledAt: updates ? checkpoint.reconciledAt : checkpoint.cycleStartedAt,
    },
    complete: true,
  };
}

/** Invalid continuation tokens restart backwards; committed record identities remain intact. */
export async function* run(context: SyncContext): AsyncGenerator<SyncPage> {
  try {
    yield* discover(context);
  } catch (error) {
    if (!(error instanceof SyncStoreError) || error.code !== "cursor_expired") throw error;
    yield {
      checkpoint: { ...(context.checkpoint as JsonObject), cursor: null, repositoryCursor: null, repositoryId: null },
      complete: false,
    };
  }
}
