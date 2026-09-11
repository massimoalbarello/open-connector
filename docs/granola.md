# Granola API and MCP

The `granola` provider supports both of Granola's public interfaces:

| Interface | Authentication                                   | Actions                                  | Availability                                  |
| --------- | ------------------------------------------------ | ---------------------------------------- | --------------------------------------------- |
| REST API  | API key                                          | `list_notes`, `get_note`, `list_folders` | Business and Enterprise                       |
| MCP       | Browser OAuth with automatic client registration | `mcp_list_tools`, `mcp_call_tool`        | Includes Basic (Free), subject to plan limits |

Granola's REST API does not offer OAuth. MCP tokens belong to the MCP service and cannot be used
for REST actions. Store separate named connections when using both interfaces.

On the free plan, MCP can access personal notes from the last 30 days. Some folder, search, and
transcript tools require a paid plan. Access follows the active workspace in the Granola app;
switching workspaces changes the notes available to the same connection. See Granola's official
[MCP documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp) and
[API documentation](https://docs.granola.ai/help-center/sharing/integrations/granola-api).

## Connect with OAuth

Start the runtime with `npm run dev`. In the console, select Granola, choose OAuth, and connect.
The runtime registers a public client automatically; there is no OAuth app to create manually.
Sign in with the email address associated with your Granola account.

The same flow is available through HTTP:

```bash
curl -s -X POST http://localhost:3000/api/oauth/authorizations \
  -H 'content-type: application/json' \
  -d '{"service":"granola","connectionName":"mcp"}'
```

Open the returned `authorizationUrl` and complete consent. The runtime exchanges the code with
PKCE, verifies the account and MCP access, and saves the credentials for automatic refresh.
If the runtime requires authentication, include its admin bearer token on `/api` calls and its
runtime bearer token on `/v1` calls, as described in [Credentials](credentials.md).

The callback is the configured runtime origin plus `/oauth/callback`. Set `OOMOL_CONNECT_ORIGIN`
before starting the runtime if the browser uses a different address from `http://localhost:3000`.
Client registration uses the configured callback exactly.

## Discover and call MCP tools

Discover tools first: Granola controls the available tools and their argument schemas.

```bash
curl -s -X POST http://localhost:3000/v1/actions/granola.mcp_list_tools \
  -H 'content-type: application/json' \
  -d '{"connectionName":"mcp","input":{}}'
```

If the result has `nextCursor`, pass it as `input.cursor` to retrieve another page. Use a returned
tool's `name` and `inputSchema` to construct a call. For example:

```bash
curl -s -X POST http://localhost:3000/v1/actions/granola.mcp_call_tool \
  -H 'content-type: application/json' \
  -d '{"connectionName":"mcp","input":{"toolName":"list_meetings","arguments":{"time_range":"last_30_days"}}}'
```

Other tools include `get_meetings`, `query_granola_meetings`, `get_meeting_transcript`, and
`get_account_info`. Use the live schemas for their arguments. Successful calls retain Granola's
MCP content blocks and structured output under `data.result` in the HTTP response; a tool error produces a failed
action rather than meeting content. HTTP authorization and rate-limit failures retain their
corresponding runtime error codes.

## Connect with an API key

Create a key in Granola **Settings → Connectors → API keys**, then save an API connection:

```bash
curl -s -X PUT http://localhost:3000/api/connections/granola \
  -H 'content-type: application/json' \
  -d '{"connectionName":"api","authType":"api_key","values":{"apiKey":"YOUR_GRANOLA_API_KEY"}}'

curl -s -X POST http://localhost:3000/v1/actions/granola.list_notes \
  -H 'content-type: application/json' \
  -d '{"connectionName":"api","input":{"page_size":10}}'
```

Existing REST inputs, outputs, and cursor pagination are unchanged. Choosing an API connection
for an MCP action, or an OAuth connection for a REST action, fails before sending credentials.

## Runnable example

```bash
node examples/local-http/granola.ts connect
# Complete browser consent, then:
node examples/local-http/granola.ts tools
node examples/local-http/granola.ts meetings
```

Use `GRANOLA_CONNECTION` to override the example's `mcp` connection name and
`OOMOL_CONNECT_ORIGIN` to select the runtime. For REST:

```bash
GRANOLA_API_KEY=... node examples/local-http/granola.ts api
```

## Implementation references

Nango also separates Granola's API-key and MCP OAuth integrations. Its
[provider configuration](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml)
declares the MCP authorization, token, and registration endpoints; its
[MCP registration client](https://github.com/NangoHQ/nango/blob/master/packages/shared/lib/clients/mcp.client.ts)
requests a public client with the deployment callback. Open Connector uses its own shared OAuth
lifecycle and MCP SDK client for the same protocol. The resource indicator follows Granola's
[protected-resource metadata](https://mcp.granola.ai/.well-known/oauth-protected-resource),
`https://mcp.granola.ai/mcp`, and is sent during authorization, code exchange, and refresh.
