# GitHub pull request sync

The Node/SQLite server includes the compiled `github.pull-requests` definition. Connect a GitHub OAuth user token or classic personal access token through the existing connection flow. The token must expose `X-OAuth-Scopes` during `/user` verification; tokens without that evidence (including fine-grained/app tokens) cannot establish a sync source yet. Include `repo` when private repositories are required. Records cover only what the grant can access.

With the server running, preview one fully hydrated PR without writing sync state:

```sh
OOMOL_CONNECT_ORIGIN=http://localhost:3456 OOMOL_CONNECT_ADMIN_TOKEN=... node examples/sync/github-pull-requests.ts
```

Set `SYNC_DRY_RUN=0` to commit, `SYNC_MAX_PAGES=100` for a larger run, and `GITHUB_CONNECTION_NAME` to choose a connection. Each run is bounded to ten minutes and resumes the last committed checkpoint. Repeat to finish a large backfill. The example prints a skip message if its server credentials are missing.

The underlying authenticated endpoint is `POST /api/sync/definitions/github.pull-requests/run`, with optional `connectionName`, `dryRun`, `backfill`, `maxPages` and `config`. The default configuration is `{"scope":"authored"}`: all PRs authored by the connected user, across accessible repositories. For every PR in affiliated repositories, use `{"scope":"accessible"}` on the first run. A source's configuration is fixed once bound; changing its discovery scope requires an explicit migration. `backfill:true` restarts acquisition without resetting record IDs or revisions.

Authored mode uses creation order for backfill, updated order with five minutes of overlap for subsequent runs, and a full daily reconciliation for child edits and removals. Accessible mode discovers repositories automatically and scans them completely each cycle. Both hydrate the description, comments, reviews, review discussions and commits with independent pagination. No Search API or REST commit-list cap is used. Large/changing PRs may require retries; failed hydration retains committed progress. Absence or lost access never implies deletion.

`GET /api/sync/definitions` lists compiled metadata and `GET /api/sync/runs/:id` reads durable run status. These endpoints require the existing admin Bearer token. Sync definitions do not receive connection secrets or direct receiver access.
