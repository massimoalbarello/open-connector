import type { SyncContext } from "../../sync/sync-definition.ts";

import { requiredResponseRecord, providerResponseError } from "../../providers/provider-runtime.ts";

export const actorSelection = "login url ... on User { id } ... on Bot { id } ... on Organization { id }";
export const pageSelection = "pageInfo { hasNextPage endCursor } totalCount";

export interface GitHubConnection {
  nodes: Record<string, unknown>[];
  cursor: string | null;
  totalCount: number;
}

/** Never turn a missing/partial collection into an empty successful hydration. */
export function readConnection(value: unknown): GitHubConnection {
  const connection = requiredResponseRecord(value, "GitHub collection");
  if (
    !Array.isArray(connection.nodes) ||
    !Number.isSafeInteger(connection.totalCount) ||
    Number(connection.totalCount) < 0
  )
    throw providerResponseError("GitHub collection is incomplete.");
  const page = requiredResponseRecord(connection.pageInfo, "GitHub pagination");
  if (typeof page.hasNextPage !== "boolean") throw providerResponseError("GitHub pagination is incomplete.");
  if (page.hasNextPage && (typeof page.endCursor !== "string" || !page.endCursor))
    throw providerResponseError("GitHub pagination cursor is missing.");
  return {
    nodes: connection.nodes.map((item) => requiredResponseRecord(item, "GitHub item")),
    cursor: page.hasNextPage ? String(page.endCursor) : null,
    totalCount: Number(connection.totalCount),
  };
}

/** Fully hydrate independently paginated children, detecting cursor loops and count changes. */
export async function collectNodes(
  context: SyncContext,
  id: string,
  type: string,
  field: string,
  selection: string,
  first: unknown,
): Promise<Record<string, unknown>[]> {
  let page = readConnection(first);
  const expected = page.totalCount;
  const nodes: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  while (true) {
    for (const node of page.nodes) {
      if (typeof node.id !== "string" || !node.id)
        throw providerResponseError("GitHub collection item is missing its identity.");
      const id = node.id;
      if (ids.has(id)) throw providerResponseError("GitHub collection repeated an item; retry hydration.");
      ids.add(id);
      nodes.push(node);
    }
    if (page.totalCount !== expected || nodes.length > expected)
      throw providerResponseError("GitHub collection changed during hydration; retry the record.");
    if (!page.cursor) break;
    if (cursors.has(page.cursor)) throw providerResponseError("GitHub pagination repeated a cursor.");
    cursors.add(page.cursor);
    const data = await context.provider.request("graphql", {
      query: `query SyncRelated($id: ID!, $after: String) { node(id: $id) { ... on ${type} { ${field}(first: 50, after: $after) { nodes { ${selection} } ${pageSelection} } } } }`,
      variables: { id, after: page.cursor },
    });
    page = readConnection(requiredResponseRecord(data.node, "GitHub parent")[field]);
  }
  if (nodes.length !== expected) throw providerResponseError("GitHub collection was truncated; retry the record.");
  return nodes;
}
