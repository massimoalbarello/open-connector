import type { StageSyncAssetInput, SyncRecordAsset } from "../../sync/asset-store.ts";
import type { SyncContext } from "../../sync/sync-definition.ts";
import type { JsonObject, SyncRecordInventoryInput, SyncRecordInventoryPage } from "../../sync/sync-store.ts";
import type { Mock } from "vitest";

import { vi } from "vitest";
import { describeSyncAsset } from "../../sync/asset-store.ts";
import { gmailThreads } from "./definition.ts";

export function mime(content = "hello", cid = "picture", filename = "report[1].txt"): string {
  return [
    "From: Ada <ada@example.com>",
    "To: Max <max@example.com>",
    "Subject: =?UTF-8?B?Um9hZG1hcCDigJMgY2Fmw6k=?=",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=mixed",
    "",
    "--mixed",
    "Content-Type: multipart/related; boundary=related",
    "",
    "--related",
    "Content-Type: multipart/alternative; boundary=alternative",
    "",
    "--alternative",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "caf=E9 plain",
    "--alternative",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<p>Hello <strong>team</strong></p><img src="cid:${cid}" alt="plot"><img src="https://tracker.example/pixel" alt="external"><script>secret script</script><a href="context-use://asset/injected">injected</a>`,
    "--alternative--",
    "--related",
    "Content-Type: image/png",
    `Content-ID: <${cid}>`,
    "Content-Disposition: inline; filename=plot.png",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(content).toString("base64"),
    "--related--",
    "--mixed",
    "Content-Type: application/octet-stream",
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    "",
    "--mixed--",
    "",
  ].join("\r\n");
}

interface GmailFixture {
  context: SyncContext;
  request: Mock<(operation: string, input?: JsonObject) => Promise<JsonObject>>;
  stage: Mock<(input: StageSyncAssetInput) => Promise<SyncRecordAsset>>;
  list: Mock<(input: SyncRecordInventoryInput) => Promise<SyncRecordInventoryPage>>;
}

export function fixture(): GmailFixture {
  const request = vi.fn(async (operation: string, input: JsonObject = {}): Promise<JsonObject> => {
    if (operation === "profile") return { historyId: "100" };
    if (operation === "threads.list") return { threads: [{ id: "a" }] };
    if (operation === "history.list") return { historyId: "100" };
    if (operation === "threads.get") return { id: input.id!, historyId: "90", messages: [{ id: `${input.id}-m` }] };
    if (operation === "messages.get")
      return {
        id: input.id!,
        threadId: String(input.id).split("-m")[0]!,
        internalDate: "1690000000000",
        labelIds: ["INBOX", "UNREAD"],
        raw: Buffer.from(mime()).toString("base64url"),
      };
    throw new Error(operation);
  });
  const stage = vi.fn(async (input: StageSyncAssetInput) => describeSyncAsset(input));
  const list = vi.fn(async (_input: SyncRecordInventoryInput) => ({ ids: [] as string[], throughSequence: 0 }));
  const context: SyncContext = {
    provider: { request },
    records: { list },
    assets: { stage },
    config: {},
    checkpoint: gmailThreads.initialCheckpoint,
    sourceId: "google-account",
    startedAt: "2026-09-12T00:00:00Z",
    signal: new AbortController().signal,
  };
  return { context, request, stage, list };
}
