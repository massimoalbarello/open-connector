import type { OAuth2AuthDefinition } from "../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOAuthClient } from "./oauth-client-registration.ts";

const auth: OAuth2AuthDefinition = {
  type: "oauth2",
  authorizationUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  clientRegistrationUrl: "https://example.com/register",
  scopes: ["offline_access"],
  tokenEndpointAuthMethod: "none",
  pkce: { method: "S256" },
};
const redirectUri = "http://localhost:3000/oauth/callback";

describe("OAuth client registration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { client_id: "id", token_endpoint_auth_method: "client_secret_basic", redirect_uris: [redirectUri] },
    { client_id: "id", token_endpoint_auth_method: "none", redirect_uris: ["https://wrong.example/callback"] },
    { token_endpoint_auth_method: "none", redirect_uris: [redirectUri] },
    ["not an object"],
  ])("rejects unusable registrations before starting consent", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    await expect(registerOAuthClient({ auth, redirectUri })).rejects.toMatchObject({
      code: "oauth_client_registration_failed",
    });
  });

  it.each(["http://example.com/register", "https://127.0.0.1/register", "https://user:secret@example.com/register"])(
    "rejects unsafe registration endpoints before making a request: %s",
    async (url) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        registerOAuthClient({ auth: { ...auth, clientRegistrationUrl: url }, redirectUri }),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("does not follow redirects or leak registration response bodies", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response("secret registration token", {
        status: 302,
        headers: { location: "https://other.example/register" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(registerOAuthClient({ auth, redirectUri })).rejects.toMatchObject({
      message: "OAuth client registration failed (HTTP 302).",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("caps response bodies and cancels oversized streams", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
      ),
    );
    await expect(registerOAuthClient({ auth, redirectUri })).rejects.toThrow("exceeds");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
