import type { SyncParticipant, SyncRecordInput } from "../../sync/record-contract.ts";

import { optionalRecord, optionalString, optionalRawString } from "../../core/cast.ts";
import { requiredResponseRecord, providerResponseError } from "../../providers/provider-runtime.ts";

export interface PullRequestContent {
  pull: Record<string, unknown>;
  comments: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  commits: Record<string, unknown>[];
  threads: Record<string, unknown>[];
}

/** Deterministic complete replacement, preserving upstream Markdown and stable native IDs. */
export function renderPullRequest(input: PullRequestContent): SyncRecordInput {
  const { pull } = input;
  const repository = requiredResponseRecord(pull.repository, "GitHub repository");
  const participants = new Map<string, SyncParticipant>();
  const actor = (value: unknown, role: string): string => {
    const person = optionalRecord(value);
    if (!person) return "Deleted user";
    const id = optionalString(person.id);
    const name = optionalString(person.login) ?? "Unknown user";
    if (id) {
      const current = participants.get(id) ?? { identities: [{ namespace: "github", id }], roles: [], name };
      current.roles = [...new Set([...current.roles, role])].sort();
      participants.set(id, current);
    }
    return name;
  };
  const sort = (items: Record<string, unknown>[]): Record<string, unknown>[] =>
    [...items].sort((a, b) => {
      const left = `${optionalRawString(a.createdAt ?? a.submittedAt ?? a.committedDate)}\0${optionalRawString(a.id ?? a.oid)}`;
      const right = `${optionalRawString(b.createdAt ?? b.submittedAt ?? b.committedDate)}\0${optionalRawString(b.id ?? b.oid)}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const lines = [
    `# ${optionalRawString(repository.nameWithOwner)} #${pull.number}: ${optionalRawString(pull.title)}`,
    optionalRawString(pull.url),
    `State: ${optionalRawString(pull.state)}${pull.isDraft ? " (draft)" : ""}`,
    `Author: ${actor(pull.author, "author")}`,
    `Branch: ${optionalRawString(pull.headRefName)} → ${optionalRawString(pull.baseRefName)}`,
    `Created: ${optionalRawString(pull.createdAt)} | Updated: ${optionalRawString(pull.updatedAt)}`,
    `Merged: ${optionalRawString(pull.mergedAt) || "No"} | Closed: ${optionalRawString(pull.closedAt) || "No"}`,
    optionalRawString(pull.body),
    "## Comments",
  ];
  for (const comment of sort(input.comments))
    lines.push(
      `### ${actor(comment.author, "commenter")} — ${optionalRawString(comment.createdAt)}`,
      `Updated: ${optionalRawString(comment.updatedAt)} | ${optionalRawString(comment.url)}`,
      optionalRawString(comment.body),
    );
  lines.push("## Reviews");
  for (const review of sort(input.reviews))
    lines.push(
      `### ${actor(review.author, "reviewer")} — ${optionalRawString(review.state)}`,
      `${optionalRawString(review.submittedAt) ?? "Pending"} | ${optionalRawString(review.url)}`,
      optionalRawString(review.body),
    );
  lines.push("## Review discussions");
  for (const thread of [...input.threads].sort((a, b) => String(a.id).localeCompare(String(b.id), "en"))) {
    lines.push(
      `### ${optionalRawString(thread.path)}:${thread.line ?? ""} (${thread.isResolved ? "resolved" : "unresolved"}${thread.isOutdated ? ", outdated" : ""})`,
    );
    if (!Array.isArray(thread.comments)) throw providerResponseError("Review thread comments were not hydrated.");
    for (const comment of sort(thread.comments))
      lines.push(
        `#### ${actor(comment.author, "reviewer")} — ${optionalRawString(comment.createdAt)}`,
        `Updated: ${optionalRawString(comment.updatedAt)} | ${optionalRawString(comment.url)}`,
        optionalRawString(comment.body),
      );
  }
  lines.push("## Commits");
  for (const item of input.commits) {
    const commit = requiredResponseRecord(item.commit, "GitHub commit");
    const author = optionalRecord(commit.author);
    lines.push(
      `### ${optionalRawString(commit.oid)} — ${actor(author?.user, "committer")}`,
      `${optionalRawString(commit.committedDate)} | ${optionalRawString(commit.url)}`,
      optionalRawString(commit.message),
    );
  }
  if (typeof pull.id !== "string" || !pull.id || !Number.isSafeInteger(pull.number))
    throw providerResponseError("Pull request identity is incomplete.");
  return {
    id: pull.id,
    body: lines.join("\n\n"),
    sourceUrl: String(pull.url),
    sourceCreatedAt: String(pull.createdAt),
    sourceUpdatedAt: String(pull.updatedAt),
    participants: [...participants.values()],
    attributes: {
      repository: String(repository.nameWithOwner),
      number: Number(pull.number),
      state: String(pull.state),
      draft: pull.isDraft === true,
    },
  };
}
