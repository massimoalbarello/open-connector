import type { SyncParticipant, SyncRecordInput } from "../../sync/record-contract.ts";

import { z } from "zod";

const actorSchema = z.object({ login: z.string(), url: z.string(), id: z.string().optional() }).nullable();
const date = z.iso.datetime({ offset: true });
const pullResponse = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.url(),
  createdAt: date,
  updatedAt: date,
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  mergedAt: date.nullable(),
  closedAt: date.nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  repository: z.object({ id: z.string(), nameWithOwner: z.string(), url: z.url() }),
  author: actorSchema,
});
const commentResponse = z.object({
  id: z.string(),
  body: z.string(),
  url: z.url(),
  createdAt: date,
  updatedAt: date,
  author: actorSchema,
});
const reviewResponse = z.object({
  id: z.string(),
  body: z.string(),
  url: z.url(),
  submittedAt: date.nullable(),
  state: z.string(),
  author: actorSchema,
});
const commitResponse = z.object({
  commit: z.object({
    oid: z.string(),
    message: z.string(),
    url: z.url(),
    committedDate: date,
    author: z.object({ user: actorSchema }).nullable(),
  }),
});
const threadResponse = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(commentResponse),
});

interface PullRequestContent {
  pull: Record<string, unknown>;
  comments: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  commits: Record<string, unknown>[];
  threads: Record<string, unknown>[];
}

/** Deterministic complete replacement, preserving upstream Markdown and stable native IDs. */
export function renderPullRequest(input: PullRequestContent): SyncRecordInput {
  const pull = pullResponse.parse(input.pull);
  const comments = input.comments.map((item) => commentResponse.parse(item));
  const reviews = input.reviews.map((item) => reviewResponse.parse(item));
  const commits = input.commits.map((item) => commitResponse.parse(item));
  const threads = input.threads.map((item) => threadResponse.parse(item));
  const repository = pull.repository;
  const participants = new Map<string, SyncParticipant>();
  const actor = (person: z.infer<typeof actorSchema> | undefined, role: string): string => {
    if (!person) return "Deleted user";
    const id = person.id;
    const name = person.login;
    if (id) {
      const current = participants.get(id) ?? { identities: [{ namespace: "github", id }], roles: [], name };
      current.roles = [...new Set([...current.roles, role])].sort();
      participants.set(id, current);
    }
    return name;
  };
  const title = `${repository.nameWithOwner} #${pull.number}: ${pull.title}`;
  const lines = [
    `# ${title}`,
    pull.url,
    `State: ${pull.state}${pull.isDraft ? " (draft)" : ""}`,
    `Author: ${actor(pull.author, "author")}`,
    `Branch: ${pull.headRefName} → ${pull.baseRefName}`,
    `Created: ${pull.createdAt} | Updated: ${pull.updatedAt}`,
    `Merged: ${pull.mergedAt || "No"} | Closed: ${pull.closedAt || "No"}`,
    pull.body,
    "## Comments",
  ];
  for (const comment of sort(comments, (item) => `${item.createdAt}\0${item.id}`))
    lines.push(
      `### ${actor(comment.author, "commenter")} — ${comment.createdAt}`,
      `Updated: ${comment.updatedAt} | ${comment.url}`,
      comment.body,
    );
  lines.push("## Reviews");
  for (const review of sort(reviews, (item) => `${item.submittedAt ?? ""}\0${item.id}`))
    lines.push(
      `### ${actor(review.author, "reviewer")} — ${review.state}`,
      `${review.submittedAt ?? "Pending"} | ${review.url}`,
      review.body,
    );
  lines.push("## Review discussions");
  for (const thread of [...threads].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    lines.push(
      `### ${thread.path}:${thread.line ?? ""} (${thread.isResolved ? "resolved" : "unresolved"}${thread.isOutdated ? ", outdated" : ""})`,
    );
    for (const comment of sort(thread.comments, (item) => `${item.createdAt}\0${item.id}`))
      lines.push(
        `#### ${actor(comment.author, "reviewer")} — ${comment.createdAt}`,
        `Updated: ${comment.updatedAt} | ${comment.url}`,
        comment.body,
      );
  }
  lines.push("## Commits");
  for (const item of commits) {
    const commit = item.commit;
    const author = commit.author;
    lines.push(
      `### ${commit.oid} — ${actor(author?.user, "committer")}`,
      `${commit.committedDate} | ${commit.url}`,
      commit.message,
    );
  }
  return {
    id: pull.id,
    title,
    body: lines.join("\n\n"),
    sourceUrl: pull.url,
    sourceCreatedAt: pull.createdAt,
    sourceUpdatedAt: pull.updatedAt,
    participants: [...participants.values()],
    attributes: {
      repository: repository.nameWithOwner,
      number: pull.number,
      state: pull.state,
      draft: pull.isDraft === true,
    },
  };
}

function sort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const left = key(a),
      right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
