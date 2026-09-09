import type { ResolvedCredential } from "../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { provider } from "../providers/granola_mcp/definition.ts";
import { credentialValidators, executors } from "../providers/granola_mcp/executors.ts";
import { callGranolaTool, verifyGranolaAccount } from "../providers/granola_mcp/runtime.ts";
import { createGranolaSyncProvider } from "../providers/granola_mcp/sync-provider.ts";
import { withMcpClient } from "../providers/mcp-client.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { granolaMeetings } from "../sync-definitions/granola/definition.ts";
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
      const text = transcript
        ? JSON.stringify({ id: "meeting", transcript: "[00:01] Ada: Yes & thanks." })
        : `<meetings_data count="1"><meeting id="meeting" title="Planning" date="Sep 8, 2026"><known_participants>Ada &lt;ada@example.com&gt;</known_participants><summary>${state.summary}</summary></meeting></meetings_data>`;
      result = { content: [{ type: "text", text }], isError: transcript && state.transcriptError };
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

describe("Granola MCP protocol and durable acquisition", () => {
  it("commits complete records, preserves them through transcript failure, and deduplicates reauthorization", async () => {
    const state = protocol();
    const database = new SqliteRuntimeDatabase(":memory:", { syncDefinitions: [granolaMeetings] });
    databases.push(database);
    await database.syncStore.delivery.configure({
      url: "https://receiver.example.com/records",
      bearerToken: "receiver-token",
      enabled: true,
    });
    const connections = new ConnectionService({
      catalog: createCatalogStore([provider], { executableActionIds: provider.actions.map((action) => action.id) }),
      store: database.connectionStore,
      providerLoader: new ProviderLoader({ granola_mcp: async () => ({ credentialValidators, executors }) }),
    });
    await connections.setOAuthCredential("granola_mcp", credential);
    const runner = new SyncRunner({
      store: database.syncStore,
      connectionStore: database.connectionStore,
      connections,
      registrations: [
        {
          definition: granolaMeetings,
          createProvider: createGranolaSyncProvider,
          load: () => import("../sync-definitions/granola/meetings.ts"),
        },
      ],
    });
    const first = await runner.run({ definitionId: granolaMeetings.id });
    expect(first.complete).toBe(true);
    const before = await database.syncStore.getRecord(first.installationId!, "meeting", "meeting");
    expect(JSON.stringify(before)).toContain("## Transcript");
    expect(JSON.stringify(before)).not.toContain("private-token");
    const checkpoint = await database.syncStore.getCheckpoint(first.installationId!);
    state.summary = "A changed summary.";
    state.transcriptError = true;
    await expect(runner.run({ definitionId: granolaMeetings.id })).rejects.toThrow("failed");
    expect(await database.syncStore.getRecord(first.installationId!, "meeting", "meeting")).toEqual(before);
    expect(await database.syncStore.getCheckpoint(first.installationId!)).toEqual(checkpoint);
    expect((await database.syncStore.status.read()).runs[0]?.state).toBe("failed");
    state.transcriptError = false;
    await connections.setOAuthCredential("granola_mcp", { ...credential, accessToken: "replacement-token" });
    const updated = await runner.run({ definitionId: granolaMeetings.id });
    expect(updated.installationId).toBe(first.installationId);
    await runner.run({ definitionId: granolaMeetings.id });
    expect((await database.syncStore.listChanges()).items).toHaveLength(2);
    state.account = "another-native-account";
    const different = await runner.run({ definitionId: granolaMeetings.id });
    expect(different.installationId).not.toBe(first.installationId);
  });

  it("refuses an email-only principal, write operations, and HTTP errors", async () => {
    const state = protocol();
    state.principalMissing = true;
    await expect(verifyGranolaAccount(credential, { fetcher })).rejects.toThrow("account ID");
    const context = { accessToken: "token", fetcher };
    await expect(callGranolaTool(context, "delete_meeting", {})).rejects.toThrow("Unsupported");
    await expect(callGranolaTool(context, "toString", {})).rejects.toThrow("Unsupported");
    fetcher.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(callGranolaTool(context, "list_meetings", {})).rejects.toMatchObject({ status: 429 });
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
    ).rejects.toThrow("byte limit");
  });
});
