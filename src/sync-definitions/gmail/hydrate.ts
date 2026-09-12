import type { SyncRecordAsset } from "../../sync/asset-store.ts";
import type { SyncParticipant, SyncRecordInput } from "../../sync/record-contract.ts";
import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";
import type { ParsedMail, AddressObject } from "mailparser";

import { simpleParser } from "mailparser";
import TurndownService from "turndown";
import { optionalString, requiredString } from "../../core/cast.ts";
import {
  ProviderRequestError,
  providerResponseError,
  requiredResponseRecord,
} from "../../providers/provider-runtime.ts";
import { syncAssetUrl } from "../../sync/asset-store.ts";

interface RenderedMessage {
  id: string;
  date: string;
  subject?: string;
  body: string;
  labels: string[];
  participants: SyncParticipant[];
  assets: SyncRecordAsset[];
}

function markdown(cidUrls: Map<string, string>): TurndownService {
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  converter.remove(["script", "style", "iframe", "object"]);
  converter.addRule("emailImages", {
    filter: "img",
    replacement: (_content, node) => {
      const src = node.getAttribute("src") ?? "";
      const url = src.startsWith("cid:") ? cidUrls.get(src.slice(4)) : undefined;
      const label = converter.escape(node.getAttribute("alt") ?? "");
      return url ? `![${label}](${url})` : label;
    },
  });
  converter.addRule("emailLinks", {
    filter: "a",
    replacement: (content, node) => {
      const href = node.getAttribute("href") ?? "";
      const url = href.startsWith("cid:")
        ? cidUrls.get(href.slice(4))
        : /^(https?:\/\/|mailto:)/i.test(href)
          ? href
          : undefined;
      return url
        ? `[${content}](<${url.replace(/[<>\r\n]/g, (character) => encodeURIComponent(character))}>)`
        : content;
    },
  });
  return converter;
}

function addresses(value: AddressObject | AddressObject[] | undefined): AddressObject[] {
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

async function renderMessage(context: SyncContext, resource: JsonObject): Promise<RenderedMessage> {
  const id = requiredString(resource.id, "Gmail message id", providerResponseError);
  const raw = requiredString(resource.raw, "Gmail raw message", providerResponseError);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.length % 4 === 1)
    throw providerResponseError("Gmail returned invalid base64url MIME content.");
  const timestamp = requiredString(resource.internalDate, "Gmail internalDate", providerResponseError);
  if (
    !/^\d+$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    !Number.isFinite(new Date(Number(timestamp)).getTime())
  )
    throw providerResponseError("Gmail returned an invalid message date.");
  const date = new Date(Number(timestamp)).toISOString();
  const parserOptions = {
    skipImageLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    keepDeliveryStatus: true,
  };
  const mail: ParsedMail = await simpleParser(Buffer.from(raw, "base64url"), parserOptions);
  const assets: SyncRecordAsset[] = [];
  const cidUrls = new Map<string, string>();
  const attachments: string[] = [];
  const converter = markdown(cidUrls);
  for (const [index, attachment] of mail.attachments.entries()) {
    context.signal.throwIfAborted();
    const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
    const asset = await context.assets.stage({ name: filename.slice(0, 160), bytes: attachment.content });
    assets.push(asset);
    const url = syncAssetUrl(asset);
    if (attachment.cid) {
      if (cidUrls.has(attachment.cid) && cidUrls.get(attachment.cid) !== url)
        throw providerResponseError("An email contains ambiguous attachment Content-IDs.");
      cidUrls.set(attachment.cid, url);
    }
    attachments.push(`- [${converter.escape(filename.replace(/[\r\n]+/g, " "))}](${url})`);
  }
  const participants: SyncParticipant[] = [];
  const headers: string[] = [];
  for (const [label, values, role] of [
    ["From", addresses(mail.from), "sender"],
    ["To", addresses(mail.to), "recipient"],
    ["Cc", addresses(mail.cc), "recipient"],
    ["Bcc", addresses(mail.bcc), "recipient"],
  ] as const) {
    const formatted: string[] = [];
    for (const value of values)
      for (const address of value.value) {
        if (!address.address) continue;
        formatted.push(address.name ? `${address.name} <${address.address}>` : address.address);
        participants.push({
          identities: [{ namespace: "email", id: address.address }],
          roles: [role],
          name: optionalString(address.name),
        });
      }
    if (formatted.length)
      headers.push(`**${label}:** ${converter.escape(formatted.join(", ").replace(/[\r\n]+/g, " "))}`);
  }
  if (
    resource.labelIds !== undefined &&
    (!Array.isArray(resource.labelIds) || resource.labelIds.some((label) => typeof label !== "string"))
  )
    throw providerResponseError("Gmail returned invalid message labels.");
  const labels = [...new Set((resource.labelIds ?? []) as string[])].sort();
  if (labels.length) headers.push(`**Labels:** ${labels.map((label) => converter.escape(label)).join(", ")}`);
  const subject = optionalString(mail.subject);
  const content = mail.html ? converter.turndown(mail.html) : converter.escape(mail.text ?? "");
  return {
    id,
    date,
    subject,
    labels,
    participants,
    assets,
    body: [
      `## ${date}${subject ? ` — ${converter.escape(subject.replace(/[\r\n]+/g, " "))}` : ""}`,
      headers.join("\n\n"),
      content.trim(),
      attachments.length ? `### Attachments\n\n${attachments.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function messageIds(thread: JsonObject, id: string): string[] {
  if (thread.id !== id || !Array.isArray(thread.messages) || thread.messages.length === 0)
    throw providerResponseError("Gmail returned an incomplete thread.");
  return thread.messages
    .map((value) =>
      requiredString(requiredResponseRecord(value, "Gmail message").id, "Gmail message id", providerResponseError),
    )
    .sort();
}

/** A missing thread is authoritative; a missing message during hydration requires a fresh retry. */
export async function hydrateThread(context: SyncContext, id: string): Promise<SyncRecordInput | undefined> {
  let thread: JsonObject;
  try {
    thread = await context.provider.request("threads.get", { id });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return undefined;
    throw error;
  }
  const ids = messageIds(thread, id);
  const historyId = requiredString(thread.historyId, "Gmail thread history id", providerResponseError);
  const messages: RenderedMessage[] = [];
  for (const messageId of ids) {
    const resource = await context.provider.request("messages.get", { id: messageId });
    if (resource.id !== messageId || resource.threadId !== id)
      throw providerResponseError("Gmail returned a different message identity.");
    messages.push(await renderMessage(context, resource));
  }
  const latest = await context.provider.request("threads.get", { id });
  if (latest.historyId !== historyId || JSON.stringify(messageIds(latest, id)) !== JSON.stringify(ids))
    throw providerResponseError("Gmail thread changed during hydration; retry the whole record.");
  messages.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const title = messages.find((message) => message.subject)?.subject ?? `Email thread ${id}`;
  const labelIds = [...new Set(messages.flatMap((message) => message.labels))].sort();
  return {
    id,
    title,
    body: `# ${markdown(new Map()).escape(title.replace(/[\r\n]+/g, " "))}\n\n${messages.map((message) => message.body).join("\n\n---\n\n")}`,
    sourceCreatedAt: messages[0]!.date,
    participants: messages.flatMap((message) => message.participants),
    attributes: { messageCount: messages.length, labelIds },
    assets: messages.flatMap((message) => message.assets),
  };
}
