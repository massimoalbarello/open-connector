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

## Push records to a receiver

Start the local logging receiver:

```sh
SYNC_RECEIVER_TOKEN=... node examples/sync/receiver.ts
```

It listens on `127.0.0.1:8788/records` and saves receipts in `./sync-receiver.sqlite` (override with `PORT` and `SYNC_RECEIVER_DB`). Expose `/records` through a public HTTPS tunnel when the connector is remote. Registered receivers require public HTTPS; every delivery validates DNS and rejects redirects.

Register **before** acquisition using authenticated `PUT /api/sync/receivers/local-test` with:

```json
{ "url": "https://your-tunnel.example/records", "bearerToken": "your-receiver-token", "enabled": true }
```

Receiver secrets use the server's configured secret codec and never appear in the receiver list. Updating the same ID replaces its URL/token and fences old delivery leases. `enabled:false` pauses both new subscriptions and existing delivery attempts; pending payloads remain until delivery is resumed and acknowledged.

`POST /api/sync/delivery/run` attempts one due batch. `GET /api/sync/receivers` reports backlog, delivery counts, last error and next retry. Each POST carries `Authorization: Bearer <receiver token>` and a JSON envelope with `version:1`, a stable `batchId`, and `records`. Records carry `eventId`, `provider`, `sourceId`, `kind`, `id`, `revision`, `operation`, `contentHash`, `committedAt`, and complete `content` for upserts. Deletes contain identity/revision metadata without content. A 2xx response acknowledges the **entire** batch; a timeout or any other response retries the same batch and event IDs. Retries use capped exponential backoff with jitter and honor Retry-After up to one hour. There is no automatic discard after a retry count.

Receivers must deduplicate event IDs and only apply increasing revisions for `(sourceId, kind, id)`. The example persists a whole batch before ACK and demonstrates both rules. It is a diagnostic receiver, not a production indexing service.

Batches contain at most 50 records and 16 MiB; individual records are limited to 8 MiB and rejected before checkpoint advancement if larger. Immutable payloads remain until all intended receivers ACK. Then bodies are purged from change and record storage, leaving compact identity/hash/revision metadata. Payload cleanup is logical database retention, not secure deletion from backups or SQLite pages.

New receivers subscribe to future changes. To populate a new receiver with existing records, run acquisition with `targetReceiverId:"local-test"` and `backfill:true`, then continue with the same target and without `backfill` until `complete:true`. The framework rehydrates from GitHub, enqueues unchanged revisions only for that receiver, and preserves existing event IDs/revisions. Actual newly discovered changes still go to every enabled receiver. Backfill uses the source's ordinary acquisition checkpoint and temporarily replaces its incremental scan; it does not create a historical replay cache.

## Automatic scheduling and recovery

The Node/SQLite server starts acquisition and delivery dispatchers automatically. A supported connected account is verified and bound using the definition's default configuration. GitHub polls every 15 minutes; an unfinished backfill continues after one second, with at most one acquisition across the SQLite database. Delivery runs independently once per second. Missed schedule intervals coalesce into one due run. Verification/acquisition failures back off from 30 seconds to one hour; replacing a credential immediately permits fresh verification.

Set `OOMOL_CONNECT_SYNC_ENABLED=0` to use only the manual endpoints, including when choosing a nondefault scope before the first automatic binding. Library users of `createConnectApp` explicitly start the returned `syncScheduler`. Sync execution is currently available with the Node/SQLite backend; PostgreSQL and Cloudflare do not host this embedded scheduler.

`GET /api/sync/status` returns installations, the latest 100 runs, binding errors and receiver backlog. `PATCH /api/sync/installations/:id` accepts `{"enabled":false}` to stop an installation, or `{"enabled":true,"scheduleSeconds":900}` to resume/configure it. Intervals range from one minute to one day. Receiver delivery remains independent of acquisition enablement.

The dashboard's **Syncs** table links to individual sync pages with polling controls, counts and recent iterations. Each iteration reports polling and delivery separately: committed pages from a failed poll can still be delivered. Delivery counts track records queued by that iteration, including targeted backfills. Existing outbox entries are attributed to their original change's run during migration; old targeted backfills cannot be distinguished retrospectively.

The authenticated administration API also supports:

- `POST /api/sync/installations` with `definitionId`, optional `connectionName`, `config`, `scheduleSeconds`, and `enabled` (default `true`) to bind or restore a sync. Source configuration remains fixed after binding; editing the interval preserves its checkpoint.
- `GET /api/sync/installations/:id/status` for that sync and its latest 100 iterations.
- `POST /api/sync/installations/:id/run` to queue an immediate poll (202). This requires the scheduler to be running and resumes a paused sync.
- `DELETE /api/sync/installations/:id` to stop and hide a sync. Records, history and checkpoints remain, queued deliveries continue, and automatic discovery does not restart it. Add the same source and definition again to restore it.
- `PATCH /api/sync/receivers/:id` with optional `url`, `bearerToken` and `enabled`. Omitting the token preserves the saved secret. Pending deliveries use the updated settings.
- `DELETE /api/sync/receivers/:id` to remove its saved token and cancel its pending deliveries while retaining delivery history. A request already in flight may still arrive. Removed destination IDs remain reserved; use a new ID when registering a replacement.

The separate **Destinations** page exposes destination registration, editing and removal. Stopping a sync cancels its current poll and retains committed progress; resuming makes it due immediately. New destinations receive future changes; use the targeted backfill described above for existing records.

Leases renew during acquisition. An expired worker is fenced and committed progress resumes after recovery. Interrupted authoritative snapshots are abandoned and require an explicit `backfill:true` run before further acquisition; they cannot infer deletions from an incomplete scan. A backward checkpoint reset is persisted atomically with its new run. Targeted receiver backfills also persist their target until completion, so scheduled continuation survives restart. Run shutdown aborts provider and delivery requests before closing storage; the server forces exit after ten seconds if work cannot stop, leaving leases for restart recovery.

For a remote smoke test: use persistent SQLite storage, connect GitHub, start and expose the local receiver, register its public HTTPS endpoint, then use a targeted backfill if acquisition ran before registration. Watch `/api/sync/status` alongside the receiver's console output. The test suite exercises this path with the compiled GitHub definition, paginated provider fixtures and a real local HTTP receiver; live account authorization is a separate deployment step.
