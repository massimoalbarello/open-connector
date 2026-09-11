import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const origin = (process.env.OOMOL_CONNECT_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const mode = process.argv[2];
const connection = process.env.GRANOLA_CONNECTION ?? (mode === "api" ? "api" : "mcp");

if (mode === "connect") {
  const started = await fetchJson<{ authorizationUrl: string }>(`${origin}/api/oauth/authorizations`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ service: "granola", connectionName: connection }),
  });
  console.log("Open this URL and finish Granola consent, then run this example with tools or meetings:");
  console.log(started.authorizationUrl);
} else if (mode === "tools" || mode === "meetings") {
  const action = mode === "tools" ? "mcp_list_tools" : "mcp_call_tool";
  const input = mode === "tools" ? {} : { toolName: "list_meetings", arguments: { time_range: "last_30_days" } };
  console.log(
    JSON.stringify(
      await fetchJson(`${origin}/v1/actions/granola.${action}`, {
        method: "POST",
        headers: runtimeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ connectionName: connection, input }),
      }),
      null,
      2,
    ),
  );
} else if (mode === "api") {
  const apiKey = process.env.GRANOLA_API_KEY;
  if (!apiKey) {
    console.log("Skipping Granola REST example: set GRANOLA_API_KEY (Business or Enterprise plan).");
    process.exit(0);
  }
  await fetchJson(`${origin}/api/connections/granola`, {
    method: "PUT",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ connectionName: connection, authType: "api_key", values: { apiKey } }),
  });
  console.log(
    JSON.stringify(
      await fetchJson(`${origin}/v1/actions/granola.list_notes`, {
        method: "POST",
        headers: runtimeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ connectionName: connection, input: { page_size: 10 } }),
      }),
      null,
      2,
    ),
  );
} else {
  console.log("Usage: node examples/local-http/granola.ts connect|tools|meetings|api");
  console.log("Start the runtime first. MCP uses browser OAuth; api requires GRANOLA_API_KEY.");
}
