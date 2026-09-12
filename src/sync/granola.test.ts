import type { ResolvedCredential } from "../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { provider } from "../providers/granola/definition.ts";
import { credentialValidators, executors } from "../providers/granola/executors.ts";
import { validateGranolaOAuthCredential } from "../providers/granola/runtime-mcp.ts";
import { createGranolaSyncProvider } from "../providers/granola/sync-provider.ts";
import { McpResponseSizeError, withMcpClient } from "../providers/mcp-client.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { granolaMeetings } from "../sync-definitions/granola/definition.ts";
import { syncRegistrations } from "../sync-definitions/sync-registry.ts";
import { SyncRunner } from "./sync-runner.ts";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn<typeof fetch>() }));
vi.mock("../providers/provider-runtime.ts", async (original) => ({
  ...(await original<object>()),
  providerFetch: fetcher,
}));
const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  vi.restoreAllMocks();
});

function protocol() {
  const state = {
    summary: "Ship the integration.",
    transcriptError: false,
    transcriptErrorId: "",
    meetingIds: ["meeting"],
    meetingDate: new Date().toISOString().slice(0, 10),
    account: "native-account",
    principalMissing: false,
  };
  fetcher.mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    if (String(url).endsWith("/userinfo"))
      return Response.json(
        state.principalMissing ? { email: "label@example.com" } : { sub: state.account, email: "label@example.com" },
      );
    expect(String(url)).toBe("https://mcp.granola.ai/mcp");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize")
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "granola-fixture", version: "1" },
      };
    else if (request.method === "tools/list")
      result = { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }] };
    else if (request.method === "tools/call") {
      const transcript = request.params.name === "get_meeting_transcript";
      const meetingIds: string[] =
        request.params.name === "get_meetings" ? request.params.arguments.meeting_ids : state.meetingIds;
      const text = transcript
        ? JSON.stringify({ id: request.params.arguments.meeting_id, transcript: "[00:01] Ada: Yes & thanks." })
        : `<meetings_data count="${meetingIds.length}">${meetingIds.map((id) => `<meeting id="${id}" title="Planning" date="${state.meetingDate}"><known_participants>Ada &lt;ada@example.com&gt;</known_participants><summary>${state.summary}</summary></meeting>`).join("")}</meetings_data>`;
      const notice =
        request.params.name === "list_meetings"
          ? "<access_notice>Only recent personal notes are available on this plan.</access_notice>\n\n"
          : "";
      result = {
        content: [{ type: "text", text: notice + text }],
        isError:
          transcript && (state.transcriptError || request.params.arguments.meeting_id === state.transcriptErrorId),
      };
    } else throw new Error(`Unexpected MCP method ${request.method}`);
    // Exercise the SDK's SSE framing, including a keepalive and a split data frame.
    const frame = `: keepalive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`;
    const bytes = new TextEncoder().encode(frame);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return state;
}

const credential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "private-token",
  tokenType: "Bearer",
  metadata: {},
  profile: { accountId: "unverified-label", displayName: "Label", grantedScopes: [] },
};

async function fixture() {
  const state = protocol();
  const database = new SqliteRuntimeDatabase(":memory:", { syncDefinitions: [granolaMeetings] });
  databases.push(database);
  const connections = new ConnectionService({
    catalog: createCatalogStore([provider], { executableActionIds: provider.actions.map((action) => action.id) }),
    store: database.connectionStore,
    providerLoader: new ProviderLoader({ granola: async () => ({ credentialValidators, executors }) }),
  });
  await connections.setOAuthCredential("granola", credential);
  const runner = new SyncRunner({
    store: database.syncStore,
    connectionStore: database.connectionStore,
    connections,
    registrations: syncRegistrations,
  });
  return { state, database, connections, runner };
}

const destination = {
  url: "https://receiver.example.com/records",
  bearerToken: "receiver-token",
  enabled: true,
};

describe("Granola MCP protocol and durable acquisition", () => {
  it("previews free-plan summaries without a destination, then persists and reprocesses the same identities", async () => {
    const { state, database, runner } = await fixture();
    state.transcriptError = true;
    state.meetingDate = "2023-04-03";
    const input = { definitionId: granolaMeetings.id };
    const preview = await runner.run({ ...input, dryRun: true });
    expect(preview.preview).toMatchObject([{ provider: "granola", id: "meeting", content: { title: "Planning" } }]);
    expect(preview.installationId).toBeUndefined();
    expect(database.syncStore.sources.getBindingRevision()).toBe(0);
    expect((await database.syncStore.listChanges()).items).toEqual([]);
    expect((await database.syncStore.status.read()).installations).toEqual([]);
    await database.syncStore.delivery.configure(destination);
    const first = await runner.run(input);
    const record = await database.syncStore.getRecord(first.installationId!, "meeting", "meeting");
    expect(record?.content?.body).toContain(state.summary);
    expect(record?.content?.body).not.toContain("## Transcript");
    expect(record?.content?.body).not.toContain("Not included in this sync");
    const polled = await runner.run(input);
    expect(polled).toMatchObject({ records: 0, complete: true });
    expect(await database.syncStore.getCheckpoint(first.installationId!)).toMatchObject({
      value: { polling: { watermark: expect.any(String) } },
    });
    expect((await database.syncStore.listChanges()).items).toHaveLength(1);
    state.summary = "Summary revised before reprocessing.";
    database.syncStore.schedule.requestRun(first.installationId!, true);
    const replay = await runner.run({ ...input, backfill: true });
    expect(replay.installationId).toBe(first.installationId);
    const changes = (await database.syncStore.listChanges()).items;
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      sourceId: changes[0]!.sourceId,
      recordId: changes[0]!.recordId,
      recordRevision: 2,
    });
    const updated = await database.syncStore.getRecord(first.installationId!, "meeting", "meeting");
    expect(updated?.revision).toBe(2);
    expect(updated?.content?.body).toContain(state.summary);
    const toolNames = fetcher.mock.calls.flatMap(([, init]) => {
      if (!init?.body) return [];
      const request = JSON.parse(String(init.body));
      return request.method === "tools/call" ? [request.params.name] : [];
    });
    expect(toolNames).not.toContain("get_meeting_transcript");
  });

  it("commits complete records, preserves them through transcript failure, and deduplicates reauthorization", async () => {
    const { state, database, connections, runner } = await fixture();
    await database.syncStore.delivery.configure(destination);
    const input = { definitionId: granolaMeetings.id, config: { includeTranscript: true } };
    const first = await runner.run(input);
    expect(first.complete).toBe(true);
    const before = await database.syncStore.getRecord(first.installationId!, "meeting", "meeting");
    expect(JSON.stringify(before)).toContain("## Transcript");
    expect(JSON.stringify(before)).not.toContain("private-token");
    const checkpoint = await database.syncStore.getCheckpoint(first.installationId!);
    state.summary = "A changed summary.";
    state.transcriptError = true;
    await expect(runner.run(input)).rejects.toThrow("failed");
    expect(await database.syncStore.getRecord(first.installationId!, "meeting", "meeting")).toEqual(before);
    expect(await database.syncStore.getCheckpoint(first.installationId!)).toEqual(checkpoint);
    expect((await database.syncStore.status.read()).runs[0]?.state).toBe("failed");
    state.transcriptError = false;
    await connections.setOAuthCredential("granola", { ...credential, accessToken: "replacement-token" });
    const updated = await runner.run(input);
    expect(updated.installationId).toBe(first.installationId);
    await runner.run(input);
    expect((await database.syncStore.listChanges()).items).toHaveLength(2);
    state.account = "another-native-account";
    const different = await runner.run(input);
    expect(different.installationId).not.toBe(first.installationId);
  });

  it("atomically saves a completed batch and resumes the failed batch from its durable cursor", async () => {
    const { state, database, runner } = await fixture();
    await database.syncStore.delivery.configure(destination);
    state.meetingIds = Array.from({ length: 13 }, (_, index) => `meeting-${String(index).padStart(2, "0")}`);
    state.transcriptErrorId = "meeting-11";
    const input = { definitionId: granolaMeetings.id, config: { includeTranscript: true } };
    await expect(runner.run(input)).rejects.toThrow("failed");
    const installationId = (await database.syncStore.status.read()).installations[0]!.id;
    expect((await database.syncStore.listChanges()).items).toHaveLength(10);
    expect(await database.syncStore.getRecord(installationId, "meeting", "meeting-10")).toBeUndefined();
    expect(await database.syncStore.getCheckpoint(installationId)).toMatchObject({
      value: { pendingIds: null, scan: { ranges: [null], afterId: "meeting-09" } },
    });
    state.transcriptErrorId = "";
    const resumed = await runner.run(input);
    expect(resumed).toMatchObject({ installationId, records: 3, complete: true });
    expect((await database.syncStore.listChanges()).items).toHaveLength(13);
    expect(await database.syncStore.getCheckpoint(installationId)).toMatchObject({
      value: {
        pendingIds: null,
        scan: null,
        polling: { watermark: expect.any(String), reconciledAt: expect.any(String) },
      },
    });
  });

  it("refuses an email-only principal, write operations, and HTTP errors", async () => {
    const state = protocol();
    state.principalMissing = true;
    await expect(validateGranolaOAuthCredential(credential, { fetcher })).rejects.toThrow("account ID");
    const adapter = createGranolaSyncProvider({
      connection: { id: "connection", revision: "revision", service: "granola", connectionName: "default", credential },
      signal: new AbortController().signal,
    });
    await expect(adapter.request("delete_meeting")).rejects.toThrow("Unsupported");
    await expect(adapter.request("toString")).rejects.toThrow("Unsupported");
    fetcher.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(adapter.request("list_meetings")).rejects.toMatchObject({ status: 429 });
  });

  it("bounds streaming MCP responses before the SDK accumulates an oversized result", async () => {
    protocol();
    await expect(
      withMcpClient(
        {
          endpoint: new URL("https://mcp.granola.ai/mcp"),
          transport: "streamable_http",
          fetcher,
          headers: { authorization: "Bearer token" },
          maxResponseBytes: 20,
        },
        async (client) => client.listTools(),
      ),
    ).rejects.toBeInstanceOf(McpResponseSizeError);
  });
});
