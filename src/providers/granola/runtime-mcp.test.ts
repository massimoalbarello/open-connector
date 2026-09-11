import type { ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { executors, credentialValidators } from "./executors.ts";

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
        content: [{ type: "text", text: "Meeting summary" }],
        structuredContent: { meeting_id: "meeting-1" },
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

  it.each([false, true])("preserves MCP text and structured content over JSON/SSE (SSE: %s)", async (sse) => {
    const onCall = vi.fn();
    stubMcp({ sse, onCall });
    await expect(
      execute("mcp_call_tool", { toolName: "get_meetings", arguments: { meeting_ids: ["meeting-1"] } }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        result: {
          content: [{ type: "text", text: "Meeting summary" }],
          structuredContent: { meeting_id: "meeting-1" },
        },
      },
    });
    expect(onCall).toHaveBeenCalledWith({ name: "get_meetings", arguments: { meeting_ids: ["meeting-1"] } });
  });

  it("forwards discovery cursors and returns the live tool schemas", async () => {
    const onCall = vi.fn();
    stubMcp({ onCall });
    await expect(execute("mcp_list_tools", { cursor: "previous-page" })).resolves.toMatchObject({
      ok: true,
      output: { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }], nextCursor: "next-page" },
    });
    expect(onCall).toHaveBeenCalledWith({ cursor: "previous-page" });
  });

  it("does not mistake a failed tool result for meeting content", async () => {
    stubMcp({ result: { isError: true, content: [{ type: "text", text: "Requires a paid plan" }] } });
    await expect(execute("mcp_call_tool", { toolName: "get_meeting_transcript" })).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_error", details: { status: 502 } },
    });
  });

  it.each([
    [401, "authorization_failed"],
    [403, "authorization_failed"],
    [429, "rate_limited"],
  ])("preserves actionable HTTP failures (%s)", async (status, code) => {
    stubMcp({ status: Number(status) });
    await expect(execute("mcp_list_tools", {})).resolves.toMatchObject({ ok: false, error: { code } });
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
    await expect(execute("mcp_list_tools", {}, apiKey)).resolves.toMatchObject({
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
