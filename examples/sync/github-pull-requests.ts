import { adminHeaders, fetchJson } from "../local-http/client.ts";

const origin = process.env.OOMOL_CONNECT_ORIGIN;
if (!origin || !process.env.OOMOL_CONNECT_ADMIN_TOKEN) {
  console.log(
    "Skipped: set OOMOL_CONNECT_ORIGIN and OOMOL_CONNECT_ADMIN_TOKEN, and connect GitHub in the console first.",
  );
} else {
  const result = await fetchJson(`${origin}/api/sync/definitions/github.pull-requests/run`, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      connectionName: process.env.GITHUB_CONNECTION_NAME ?? "default",
      dryRun: process.env.SYNC_DRY_RUN !== "0",
      maxPages: Number(process.env.SYNC_MAX_PAGES ?? 1),
    }),
  });
  console.log(JSON.stringify(result, null, 2));
}
