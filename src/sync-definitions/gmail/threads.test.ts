import type { StageSyncAssetInput } from "../../sync/asset-store.ts";
import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "../../providers/provider-runtime.ts";
import { describeSyncAsset } from "../../sync/asset-store.ts";
import { normalizeSyncRecord } from "../../sync/record-contract.ts";
import { validateSyncValue } from "../../sync/sync-validation.ts";
import { gmailThreads } from "./definition.ts";
import { hydrateThread } from "./hydrate.ts";
import { fixture, mime } from "./threads.test-fixture.ts";
import { run } from "./threads.ts";

async function collect(context: SyncContext) {
  const pages = await Array.fromAsync(run(context));
  for (const page of pages) {
    validateSyncValue(page.checkpoint, gmailThreads.checkpointSchema, "checkpoint");
    for (const record of page.records ?? []) normalizeSyncRecord(record.record, gmailThreads.kinds[0]!);
  }
  return pages;
}

describe("Gmail thread acquisition", () => {
  it("parses nested MIME and zero-byte files, scopes CID links per message, and renders deterministically", async () => {
    const { context, request, stage } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      if (operation === "threads.get")
        return { id: "a", historyId: "90", messages: [{ id: "second" }, { id: "first" }] };
      if (operation === "messages.get")
        return {
          id: input.id!,
          threadId: "a",
          labelIds: ["UNREAD", "INBOX"],
          internalDate: input.id === "first" ? "1600000000000" : "1690000000000",
          raw: Buffer.from(mime(String(input.id))).toString("base64url"),
        };
      return base(operation, input);
    });
    const record = (await hydrateThread(context, "a"))!;
    expect(stage).toHaveBeenCalledTimes(4);
    expect(stage.mock.calls.map(([input]) => Buffer.from(input.bytes).toString())).toEqual(["first", "", "second", ""]);
    expect(record.body).toContain("Hello **team**");
    expect(record.body).toContain("![plot](open-connector://asset/");
    expect(record.body).not.toMatch(/cid:|tracker\.example|secret script|context-use:\/\/asset\/injected/);
    expect(record.body.indexOf("2020-09-13")).toBeLessThan(record.body.indexOf("2023-07-22"));
    expect(record).toMatchObject({
      id: "a",
      title: "Roadmap – café",
      attributes: { messageCount: 2, labelIds: ["INBOX", "UNREAD"] },
      sourceCreatedAt: "2020-09-13T12:26:40.000Z",
    });
    expect(record.sourceUpdatedAt).toBeUndefined();
    const normalized = normalizeSyncRecord(record, gmailThreads.kinds[0]!);
    expect(normalizeSyncRecord((await hydrateThread(context, "a"))!, gmailThreads.kinds[0]!)).toEqual(normalized);
  });

  it("decodes plain-text charsets and keeps authored Markdown punctuation literal", async () => {
    const { context, request } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(
      async (operation, input = {}): Promise<JsonObject> =>
        operation === "messages.get"
          ? {
              id: input.id!,
              threadId: "a",
              labelIds: [],
              internalDate: "1690000000000",
              raw: Buffer.from(
                "Subject: Plain\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9 *literal* [name](cid:fake)",
              ).toString("base64url"),
            }
          : base(operation, input),
    );
    expect((await hydrateThread(context, "a"))?.body).toContain("café \\*literal\\* \\[name\\](cid:fake)");
  });

  it("resumes all backfill pages and interleaves history without narrowing mailbox scope", async () => {
    const { context, request } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(
      async (operation, input = {}): Promise<JsonObject> =>
        operation === "threads.list"
          ? input.pageToken
            ? { threads: [{ id: "b" }] }
            : { threads: [{ id: "a" }], nextPageToken: "next" }
          : base(operation, input),
    );
    const iterator = run(context);
    const prefix = [await iterator.next()];
    await iterator.return(undefined);
    const checkpoint = prefix.at(-1)!.value!.checkpoint;
    const pages = await collect({ ...context, checkpoint });
    expect(pages.flatMap((page) => page.records ?? []).map((item) => item.record.id)).toEqual(["b"]);
    const discoveryCalls = request.mock.calls.filter(([operation]) => operation === "threads.list");
    expect(discoveryCalls.map(([, input]) => input)).toEqual([{ pageToken: null }, { pageToken: "next" }]);
    expect(request.mock.calls.map(([operation]) => operation).indexOf("history.list")).toBeLessThan(
      request.mock.calls.findIndex(([operation, input]) => operation === "threads.list" && input?.pageToken === "next"),
    );
    expect(pages.at(-1)?.complete).toBe(true);
  });

  it("advances a history cursor only after all affected threads commit, including old edits and deletion", async () => {
    const { context, request } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      if (operation === "history.list")
        return input.historyId === "100"
          ? {
              history: [
                {
                  id: "90071992547409931",
                  labelsRemoved: [{ message: { threadId: "a" } }],
                  messagesDeleted: [{ message: { threadId: "b" } }],
                  messages: [{ threadId: "a" }],
                },
              ],
              historyId: "90071992547409932",
            }
          : { historyId: input.historyId! };
      if (operation === "threads.get" && input.id === "b") throw new ProviderRequestError(404, "Gone");
      return base(operation, input);
    });
    const iterator = run({
      ...context,
      checkpoint: { ...(gmailThreads.initialCheckpoint as JsonObject), phase: "history", historyId: "100" },
    });
    const first = (await iterator.next()).value!;
    expect(first.checkpoint).toMatchObject({ historyId: "100", nextHistoryId: "90071992547409932", pendingIds: ["b"] });
    await iterator.return(undefined);
    const resumed = await collect({ ...context, checkpoint: first.checkpoint });
    expect(resumed[0]).toMatchObject({
      deletes: [{ kind: "thread", id: "b" }],
      checkpoint: { historyId: "90071992547409932" },
      complete: true,
    });
    expect(request.mock.calls.filter(([operation]) => operation === "history.list")).toHaveLength(1);
  });

  it("continues history after the last applied event instead of persisting a second scan cursor", async () => {
    const { context, request } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(
      async (operation, input = {}): Promise<JsonObject> =>
        operation === "history.list"
          ? input.historyId === "100"
            ? {
                history: [{ id: "110", messagesAdded: [{ message: { threadId: "a" } }] }],
                nextPageToken: "unused",
                historyId: "200",
              }
            : { historyId: "200" }
          : base(operation, input),
    );
    const pages = await collect({
      ...context,
      checkpoint: { ...(gmailThreads.initialCheckpoint as JsonObject), phase: "history", historyId: "100" },
    });
    expect(request.mock.calls.filter(([operation]) => operation === "history.list").map(([, input]) => input)).toEqual([
      { historyId: "100" },
      { historyId: "110" },
    ]);
    expect(pages.at(-1)?.checkpoint).toMatchObject({ historyId: "200" });
  });

  it("recovers expired history with a full scan and authoritative rechecks of known IDs", async () => {
    const { context, request, list } = fixture();
    list.mockImplementation(async (input) => ({
      throughSequence: 42,
      ids: input?.throughSequence === 42 && !input?.afterId ? ["deleted", "hidden"] : [],
    }));
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      if (operation === "history.list" && input.historyId === "1") throw new ProviderRequestError(404, "Expired");
      if (operation === "threads.get" && input.id === "deleted") throw new ProviderRequestError(404, "Gone");
      return base(operation, input);
    });
    const pages = await collect({
      ...context,
      checkpoint: { ...(gmailThreads.initialCheckpoint as JsonObject), phase: "history", historyId: "1" },
    });
    expect(pages.flatMap((page) => page.deletes ?? [])).toEqual([{ kind: "thread", id: "deleted" }]);
    expect(pages.flatMap((page) => page.records ?? []).map((item) => item.record.id)).toContain("hidden");
    expect(list).toHaveBeenCalledWith({ kind: "thread", throughSequence: 42, afterId: "hidden" });
  });

  it.each([403, 429, 500])("never treats HTTP %i or a partial scan as deletion", async (status) => {
    const { context, request } = fixture();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      if (operation === "threads.get") throw new ProviderRequestError(status, "Unavailable");
      return base(operation, input);
    });
    const iterator = run(context);
    await expect(iterator.next()).rejects.toMatchObject({ status });
  });

  it("does not yield a partial record after attachment failure, message disappearance, or concurrent thread changes", async () => {
    const { context, stage, request } = fixture();
    stage.mockRejectedValueOnce(new Error("Disk full"));
    await expect(hydrateThread(context, "a")).rejects.toThrow("Disk full");
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      if (operation === "messages.get") throw new ProviderRequestError(404, "Message disappeared");
      return base(operation, input);
    });
    await expect(hydrateThread(context, "a")).rejects.toMatchObject({ status: 404 });
    let reads = 0;
    request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
      const result = await base(operation, input);
      if (operation === "threads.get") result.historyId = String(++reads);
      return result;
    });
    await expect(hydrateThread(context, "a")).rejects.toThrow("changed during hydration");
  });

  it.each(["invalid", "170000000000000000000", "-1"])(
    "rejects invalid source timestamps (%s)",
    async (internalDate) => {
      const { context, request } = fixture();
      const base = request.getMockImplementation()!;
      request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
        const result = await base(operation, input);
        if (operation === "messages.get") result.internalDate = internalDate;
        return result;
      });
      await expect(hydrateThread(context, "a")).rejects.toMatchObject({ status: 502 });
    },
  );
});

it("restarts an expired discovery token without inferring deletions from the interrupted scan", async () => {
  const { context, request } = fixture();
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
    if (operation === "threads.list" && input.pageToken === "expired")
      throw new ProviderRequestError(400, "Invalid token");
    return base(operation, input);
  });
  const pages = await collect({
    ...context,
    checkpoint: { ...(gmailThreads.initialCheckpoint as JsonObject), historyId: "100", pageToken: "expired" },
  });
  expect(pages.flatMap((page) => page.deletes ?? [])).toEqual([]);
  expect(
    request.mock.calls.filter(([operation]) => operation === "threads.list").map(([, input]) => input?.pageToken),
  ).toEqual(["expired", null]);
  expect(pages.flatMap((page) => page.records ?? []).map((item) => item.record.id)).toEqual(["a"]);
});

it("keeps unnamed attachments and accepts a message without labels", async () => {
  const { context, request } = fixture();
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (operation, input = {}): Promise<JsonObject> => {
    const result = await base(operation, input);
    if (operation === "messages.get") {
      result.raw = Buffer.from(mime("hello", "picture", "")).toString("base64url");
      delete result.labelIds;
    }
    return result;
  });
  const record = (await hydrateThread(context, "a"))!;
  expect(record.assets).toContainEqual(expect.objectContaining({ name: "attachment-2", sizeBytes: 0 }));
  expect(record.attributes?.labelIds).toEqual([]);
  normalizeSyncRecord(record, gmailThreads.kinds[0]!);
});
