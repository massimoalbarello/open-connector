import type { ProviderDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";

export const provider: ProviderDefinition = {
  service: "granola_mcp",
  displayName: "Granola MCP",
  categories: ["Productivity"],
  homepageUrl: "https://www.granola.ai",
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: `${granolaOAuthIssuer}/oauth2/authorize`,
      tokenUrl: `${granolaOAuthIssuer}/oauth2/token`,
      scopes: ["openid", "profile", "email", "offline_access", "mcp"],
      tokenEndpointAuthMethod: "none",
      pkce: { method: "S256" },
      authorizationParams: { resource: granolaMcpEndpoint },
      clientSetup: {
        docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
        steps: [
          "Copy this deployment's Callback URL.",
          `POST {"client_name":"Open Connector","redirect_uris":["<Callback URL>"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"} as JSON to ${granolaOAuthIssuer}/oauth2/register.`,
          "Enter the returned client_id below and leave Client Secret empty. Connect Granola using the browser OAuth flow.",
        ],
      },
    },
  ],
  actions: [
    defineProviderAction("granola_mcp", {
      name: "list_meetings",
      description: "List accessible meetings from the last 30 days in the active Granola workspace.",
      inputSchema: s.object({}),
      outputSchema: s.requiredObject("Meeting metadata returned by Granola MCP.", { text: s.string() }),
    }),
    defineProviderAction("granola_mcp", {
      name: "get_meetings",
      description: "Read notes and generated summaries for up to ten Granola meeting IDs.",
      inputSchema: s.requiredObject("Meetings to retrieve.", {
        meeting_ids: s.array(s.string({ minLength: 1 }), { minItems: 1, maxItems: 10, uniqueItems: true }),
      }),
      outputSchema: s.requiredObject("Meeting content returned by Granola MCP.", { text: s.string() }),
    }),
    defineProviderAction("granola_mcp", {
      name: "get_meeting_transcript",
      description: "Read a meeting's transcript. Requires a Granola plan with transcript access.",
      inputSchema: s.requiredObject("Meeting to retrieve.", { meeting_id: s.string({ minLength: 1 }) }),
      outputSchema: s.requiredObject("Transcript returned by Granola MCP.", { text: s.string() }),
    }),
  ],
};
