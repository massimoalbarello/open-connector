import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { executors as slackbotExecutors } from "../slackbot/executors.ts";
import { credentialValidators, executors as slackExecutors, proxy } from "./executors.ts";

afterEach(() => vi.unstubAllGlobals());

describe.each(["action", "bot action", "proxy"])("Slack %s rate limits", (path) => {
  it.each(["ratelimited", "rate_limited", undefined])("keeps HTTP cooldowns for %s", async (reason) => {
    vi.stubGlobal("fetch", async () =>
      reason === undefined
        ? new Response("secret raw body", { status: 429, headers: { "Retry-After": "60" } })
        : Response.json(
            { ok: false, error: reason, response_metadata: { messages: ["secret"] }, token: "secret" },
            { status: 429, headers: { "Retry-After": "60", "set-cookie": "secret" } },
          ),
    );
    const context: ExecutionContext = {
      getCredential: async () => oauthCredential(path === "bot action" ? "bot" : "user"),
    };
    const result =
      path === "proxy"
        ? await proxy({ method: "GET", endpoint: "/conversations.list" }, context)
        : await (
            path === "bot action"
              ? slackbotExecutors["slackbot.list_channels"]!
              : slackExecutors["slack.list_channels"]!
          )({}, context);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { status: 429, reason, headers: { "retry-after": "60" } } },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("Slack application errors", () => {
  it.each(["download", "upload"])("keeps cooldowns from the file %s step", async (step) => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = input.toString();
      if ((step === "download" && url === "https://example.com/file.txt") || url === "https://files.slack.com/upload") {
        return new Response("secret raw failure", { status: 429, headers: { "Retry-After": "60" } });
      }
      if (url === "https://example.com/file.txt") return new Response("file contents");
      return Response.json({ ok: true, upload_url: "https://files.slack.com/upload", file_id: "F123" });
    });
    const result = await slackExecutors["slack.upload_file"]!(
      { fileUrl: "https://example.com/file.txt", filename: "file.txt" },
      { getCredential: async () => oauthCredential("user") },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { status: 429, headers: { "retry-after": "60" } } },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each(["ratelimited", "rate_limited"])("keeps the real HTTP 200 status for %s", async (reason) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ ok: false, error: reason, token: "secret" }, { headers: { "Retry-After": "30" } }),
    );
    const result = await slackExecutors["slack.list_channels"]!(
      {},
      { getCredential: async () => oauthCredential("user") },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { status: 200, reason, headers: { "retry-after": "30" } } },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

describe("Slack authorization paths", () => {
  it.each([
    { actionId: "slack.list_channels", rawTokenType: "bot", execute: slackExecutors["slack.list_channels"]! },
    {
      actionId: "slackbot.list_channels",
      rawTokenType: "user",
      execute: slackbotExecutors["slackbot.list_channels"]!,
    },
    {
      actionId: "slack.list_channels",
      rawTokenType: "Bearer",
      accessToken: "xoxb-bot-token",
      execute: slackExecutors["slack.list_channels"]!,
    },
    {
      actionId: "slackbot.list_channels",
      rawTokenType: "Bearer",
      accessToken: "xoxp-user-token",
      execute: slackbotExecutors["slackbot.list_channels"]!,
    },
  ])("rejects the other authorization path for $actionId", async ({ rawTokenType, accessToken, execute }) => {
    const context: ExecutionContext = {
      getCredential: async () => oauthCredential(rawTokenType, {}, accessToken),
    };

    await expect(execute({}, context)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
      },
    });
  });

  it.each([
    {
      actionId: "slack.open_conversation",
      rawTokenType: "user",
      execute: slackExecutors["slack.open_conversation"]!,
    },
    {
      actionId: "slackbot.open_conversation",
      rawTokenType: "bot",
      execute: slackbotExecutors["slackbot.open_conversation"]!,
    },
    {
      actionId: "slack.open_conversation",
      rawTokenType: "Bearer",
      accessToken: "xoxp-user-token",
      execute: slackExecutors["slack.open_conversation"]!,
    },
  ])("allows the matching authorization path for $actionId", async ({ rawTokenType, accessToken, execute }) => {
    const context: ExecutionContext = {
      getCredential: async () => oauthCredential(rawTokenType, {}, accessToken),
    };

    await expect(execute({ userIds: [] }, context)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "open_conversation only supports one userId",
      },
    });
  });

  it.each([
    {
      tokenType: "user",
      accessToken: "access-token",
      metadata: {
        rawTokenType: "user",
        scope: "channels:read",
        authed_user: { scope: "chat:write,search:read" },
      },
      scopes: ["chat:write", "search:read"],
    },
    {
      tokenType: "Bearer user",
      accessToken: "xoxp-user-token",
      metadata: {
        rawTokenType: "Bearer",
        scope: "channels:read,chat:write,search:read",
      },
      scopes: ["channels:read", "chat:write", "search:read"],
    },
    {
      tokenType: "bot",
      accessToken: "access-token",
      metadata: {
        rawTokenType: "bot",
        scope: "channels:read,chat:write",
        authed_user: { scope: "search:read" },
      },
      scopes: ["channels:read", "chat:write"],
    },
  ])("reads scopes from a $tokenType token response", async ({ accessToken, tokenType, metadata, scopes }) => {
    const result = await credentialValidators.oauth2!(oauthCredential(tokenType, metadata, accessToken), {
      fetcher: async (url, init) => {
        expect(url.toString()).toBe("https://slack.com/api/auth.test");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        return Response.json({ ok: true, team: "Example workspace", user_id: "U123" });
      },
    });

    expect(result).toMatchObject({
      profile: {
        accountId: "U123",
        displayName: "Example workspace",
      },
      grantedScopes: scopes,
    });
  });
});

function oauthCredential(
  rawTokenType: string,
  metadata: Record<string, unknown> = {},
  accessToken = "access-token",
): OAuthCredential {
  return {
    authType: "oauth2",
    accessToken,
    tokenType: rawTokenType,
    profile: {
      accountId: "U123",
      displayName: "Example workspace",
      grantedScopes: [],
    },
    metadata: { ...metadata, rawTokenType },
  };
}
