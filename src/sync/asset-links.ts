import type { Nodes } from "mdast";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { SyncStoreError } from "./sync-store.ts";

/** Resolve Markdown destinations only; quoted text, code, and unrelated URLs keep their meaning. */
export function resolveSyncAssetLinks(body: string, urls: ReadonlyMap<string, string>): string {
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  let changed = false;
  function visit(node: Nodes): void {
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition") &&
      node.url.startsWith("open-connector://asset/")
    ) {
      const url = urls.get(node.url);
      if (!url) throw new SyncStoreError("invalid_input", "An attachment link is missing from the record manifest.");
      changed ||= url !== node.url;
      node.url = url;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  return changed ? toMarkdown(tree, { extensions: [gfmToMarkdown()] }) : body;
}
