import type { ProviderDefinition } from "../../core/types.ts";

import { granolaActions } from "./actions.ts";
import { granolaMcpEndpoint, granolaOAuthIssuer } from "./endpoints.ts";
import { granolaMcpActions } from "./mcp-actions.ts";

const service = "granola";

export const provider: ProviderDefinition = {
  service,
  displayName: "Granola",
  categories: ["AI", "Productivity"],
  authTypes: ["oauth2", "api_key"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: `${granolaOAuthIssuer}/oauth2/authorize`,
      tokenUrl: `${granolaOAuthIssuer}/oauth2/token`,
      clientRegistrationUrl: `${granolaOAuthIssuer}/oauth2/register`,
      resource: granolaMcpEndpoint,
      scopes: ["openid", "profile", "email", "offline_access"],
      tokenEndpointAuthMethod: "none",
      pkce: { method: "S256" },
    },
    {
      type: "api_key",
      label: "API Key",
      placeholder: "granola_api_key",
      description:
        "For Granola REST API actions on Business or Enterprise plans. Create a key in Granola Settings > Connectors > API keys. Use OAuth for MCP access, including the free plan: https://docs.granola.ai/help-center/sharing/integrations/granola-api.",
    },
  ],
  homepageUrl: "https://www.granola.ai",
  actions: [...granolaActions, ...granolaMcpActions],
};
