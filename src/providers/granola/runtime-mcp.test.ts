import type { ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { executors, credentialValidators } from "./executors.ts";
import { listGranolaMcpTools } from "./runtime-mcp.ts";

const oauth: ResolvedCredential = {
  authType: "oauth2",
  accessToken: "mcp-token",
  tokenType: "Bearer",
  metadata: {},
  profile: { accountId: "account", displayName: "Account", grantedScopes: [] },
};
const apiKey: ResolvedCredential = {
  authType: "api_key",
  apiKey: "rest-key",
  values: {},
  metadata: {},
  profile: oauth.profile,
};

interface McpFixtureOptions {
  sse?: boolean;
  status?: number;
  result?: Record<string, unknown>;
  onCall?: (params: Record<string, unknown>) => void;
}

function stubMcp(options: McpFixtureOptions = {}): typeof fetch {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mcp-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (String(url).endsWith("/oauth2/userinfo")) {
      return Response.json({ sub: "native-user-id", email: "user@example.com", name: "User" });
    }
    expect(String(url)).toBe("https://mcp.granola.ai/mcp");
    if (options.status) return new Response(null, { status: options.status });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Granola fixture", version: "1" },
      };
    } else if (request.method === "tools/list") {
      result = { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }], nextCursor: "next-page" };
      options.onCall?.(request.params);
    } else if (request.method === "tools/call") {
      options.onCall?.(request.params);
      result = options.result ?? {
        content: [
          {
            type: "text",
            text: '<access_notice>Access is limited.</access_notice><meetings_data count="1"><meeting id="meeting-1" title="Planning &amp; review" date="Sep 12, 2026"><known_participants>Ada &lt;ada@example.com&gt;</known_participants><summary><![CDATA[## Decisions\n\n- Keep **Markdown**.]]></summary><private_notes>My notes</private_notes></meeting></meetings_data>',
          },
        ],
      };
    } else throw new Error(`Unexpected MCP request: ${request.method}`);
    const message = { jsonrpc: "2.0", id: request.id, result };
    return options.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(message);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function execute(name: string, input: Record<string, unknown>, credential = oauth) {
  return executors[`granola.${name}`]!(input, { getCredential: async () => credential });
}

describe("Granola REST and MCP execution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("returns meeting fields and authored summaries over JSON/SSE (SSE: %s)", async (sse) => {
    const onCall = vi.fn();
    stubMcp({ sse, onCall });
    await expect(execute("get_meetings", { meeting_ids: ["meeting-1"] })).resolves.toMatchObject({
      ok: true,
      output: {
        meetings: [
          {
            id: "meeting-1",
            title: "Planning & review",
            date: "Sep 12, 2026",
            attendees: "Ada <ada@example.com>",
            summary: "## Decisions\n\n- Keep **Markdown**.",
            privateNotes: "My notes",
          },
        ],
      },
    });
    expect(onCall).toHaveBeenCalledWith({ name: "get_meetings", arguments: { meeting_ids: ["meeting-1"] } });
  });

  it("forwards discovery cursors and returns the live tool schemas", async () => {
    const onCall = vi.fn();
    const fetcher = stubMcp({ onCall });
    await expect(
      listGranolaMcpTools({ accessToken: oauth.accessToken, fetcher }, "previous-page"),
    ).resolves.toMatchObject({
      tools: [{ name: "list_meetings", inputSchema: { type: "object" } }],
      nextCursor: "next-page",
    });
    expect(onCall).toHaveBeenCalledWith({ cursor: "previous-page" });
  });

  it("does not mistake a failed tool result for meeting content", async () => {
    stubMcp({ result: { isError: true, content: [{ type: "text", text: "Requires a paid plan" }] } });
    await expect(execute("get_meeting_transcript", { meeting_id: "meeting-1" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "provider_error",
        message: expect.stringContaining("Requires a paid plan"),
        details: { status: 502 },
      },
    });
  });

  it("forwards meeting filters without imposing a date range or discarding exclusions", async () => {
    const onCall = vi.fn();
    stubMcp({ onCall });
    await expect(execute("list_meetings", {})).resolves.toMatchObject({ ok: true });
    expect(onCall).toHaveBeenLastCalledWith({ name: "list_meetings", arguments: {} });
    const input = {
      time_range: "custom",
      custom_start: "2023-01-01",
      custom_end: "2026-09-12",
      folder_id: "folder-1",
      involvement: { captured_by_me: false, listed_as_participant: true },
    };
    await expect(execute("list_meetings", input)).resolves.toMatchObject({ ok: true });
    expect(onCall).toHaveBeenLastCalledWith({ name: "list_meetings", arguments: input });
    onCall.mockClear();
    for (const input of [
      { time_range: "custom" },
      { custom_start: "2023-01-01" },
      { time_range: "custom", custom_start: "2026-09-12", custom_end: "2023-01-01" },
    ]) {
      await expect(execute("list_meetings", input)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(onCall).not.toHaveBeenCalled();
  });

  it("refuses incomplete meeting batches and mismatched transcript identities", async () => {
    stubMcp();
    await expect(execute("get_meetings", { meeting_ids: ["meeting-1", "meeting-2"] })).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_error" },
    });
    stubMcp({
      result: { content: [{ type: "text", text: JSON.stringify({ id: "different", transcript: "Wrong meeting" }) }] },
    });
    await expect(execute("get_meeting_transcript", { meeting_id: "meeting-1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_error", message: expect.stringContaining("identity") },
    });
  });

  it.each([
    {
      action: "get_meeting_transcript",
      tool: "get_meeting_transcript",
      input: { meeting_id: "meeting-1" },
      text: JSON.stringify({ id: "meeting-1", transcript: "[00:01] Ada: Keep this & that." }),
      output: { meeting_id: "meeting-1", transcript: "[00:01] Ada: Keep this & that." },
    },
    {
      action: "query_meetings",
      tool: "query_granola_meetings",
      input: { query: "What was decided?", document_ids: ["meeting-1"] },
      text: "Ship it. [[0]](https://notes.granola.ai/d/meeting-1)",
      output: { answer: "Ship it. [[0]](https://notes.granola.ai/d/meeting-1)" },
    },
    {
      action: "list_meeting_folders",
      tool: "list_meeting_folders",
      input: {},
      text: "Folder: Engineering",
      output: { text: "Folder: Engineering" },
    },
    {
      action: "get_account_info",
      tool: "get_account_info",
      input: {},
      text: JSON.stringify({
        email: "user@example.com",
        active_workspace: { id: "workspace-1", display_name: "Engineering" },
        mcp_note_access: { scopes: ["personal"] },
      }),
      output: {
        email: "user@example.com",
        active_workspace: { id: "workspace-1", display_name: "Engineering" },
        mcp_note_access: { scopes: ["personal"] },
      },
    },
  ])("executes $action with its named input and useful output", async ({ action, tool, input, text, output }) => {
    const onCall = vi.fn();
    stubMcp({ onCall, result: { content: [{ type: "text", text }] } });
    await expect(execute(action, input)).resolves.toEqual({ ok: true, output });
    expect(onCall).toHaveBeenLastCalledWith({ name: tool, arguments: input });
  });

  it.each([
    [401, "authorization_failed"],
    [403, "authorization_failed"],
    [429, "rate_limited"],
  ])("preserves actionable HTTP failures (%s)", async (status, code) => {
    stubMcp({ status: Number(status) });
    await expect(execute("list_meetings", {})).resolves.toMatchObject({ ok: false, error: { code } });
  });

  it("validates an OAuth account without invoking paid meeting tools", async () => {
    const onCall = vi.fn();
    const fetcher = stubMcp({ onCall });
    await expect(credentialValidators.oauth2!(oauth, { fetcher })).resolves.toMatchObject({
      profile: { accountId: "native-user-id", displayName: "User" },
      sourceIdentity: { accountId: "native-user-id", authorizationBoundary: "https://mcp.granola.ai/mcp" },
    });
    expect(onCall).toHaveBeenCalledWith({});
  });

  it("reports invalid credentials as connection form errors", async () => {
    const fetcher = stubMcp({ status: 401 });
    await expect(credentialValidators.oauth2!(oauth, { fetcher })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects credentials for the other transport before any egress", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(execute("list_meetings", {}, apiKey)).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_failed" },
    });
    await expect(execute("list_notes", {}, oauth)).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_failed" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps REST notes and pagination on the API key endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://public-api.granola.ai/v1/notes?cursor=page-1&page_size=2");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rest-key");
        return Response.json({ notes: [{ id: "note-1" }], hasMore: true, cursor: "page-2" });
      }),
    );
    await expect(execute("list_notes", { cursor: "page-1", page_size: 2 }, apiKey)).resolves.toMatchObject({
      ok: true,
      output: { notes: [{ id: "note-1" }], hasMore: true, nextCursor: "page-2" },
    });
  });
});
