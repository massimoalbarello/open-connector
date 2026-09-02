# Sync Engine Architecture

Status: proposed design for the first sync-engine implementation.

This document defines a small, durable data-sync subsystem for the self-hosted OpenConnector
runtime. It is deliberately narrower than a general workflow platform: trusted sync definitions
compiled into the executable acquire provider data, SQLite records progress and changes, and generic
sinks deliver those changes to consumers.

The design is informed by the public behavior of Nango Syncs, DBOS durable schedules and queues, and
Activepieces polling triggers. It is an independent OpenConnector design and does not reuse their
source code.

## Scope and non-goals

The first release targets one Linux x86-64 OpenConnector process, one operator, SQLite, and a global
sync concurrency of one. It must support:

- initial backfills followed by incremental acquisition;
- persisted schedules, runs, retries, leases, and crash recovery;
- provider checkpoints that advance with record writes;
- a latest-record cache with added, updated, and deleted change events;
- explicit deletes and safe snapshot-based deletion detection;
- provider webhooks followed by periodic polling reconciliation;
- at-least-once push delivery and a cursor-based pull feed;
- trusted, provider-specific sync definitions compiled into the executable; and
- authenticated provider REST, GraphQL, and existing OpenConnector Action calls without exposing
  credentials to a sync function.

The first release will not be a general workflow engine, a multi-node scheduler, or a user-code
sandbox. It will not load arbitrary JavaScript, depend on a worker service, replace whole tables on
refresh, or introduce PostgreSQL, Redis, cron, or a sidecar. Two-way writes remain OpenConnector
Actions rather than part of the sync kernel.

The existing PostgreSQL and Cloudflare/D1 connector runtimes remain supported for their current
features, but do not host the sync engine. Enabling sync with `OOMOL_CONNECT_DATABASE_URL` configured
must fail configuration validation with a clear SQLite-only error rather than silently running an
incomplete engine.

## Design principles

1. **SQLite is the durable coordinator.** In-memory timers are hints. The database is authoritative
   for schedules, queue order, leases, checkpoints, records, changes, and delivery attempts.
2. **Provider I/O and consumer I/O never run in a SQLite transaction.** A transaction only validates
   current durable state and applies already-acquired data.
3. **A page is the recovery boundary.** Record changes, tombstones, change events, outbox rows, run
   progress, and the provider checkpoint commit together or not at all.
4. **Provider progress and consumer progress are separate.** A provider checkpoint controls the next
   provider request. A consumer cursor controls the next cache change a consumer reads or receives.
5. **Definitions receive capabilities, not secrets.** They can make authenticated provider calls,
   but cannot inspect access tokens, refresh tokens, API keys, OAuth client secrets, or sink secrets.
6. **Polling is the correctness path.** Webhooks reduce latency; periodic reconciliation repairs
   missed, duplicated, and out-of-order webhook events.
7. **The external data contract is vendor-neutral.** The kernel does not know about Context Use or
   any other consumer-specific models.

## Ownership boundaries

| Owner                       | Facts and behavior it exclusively owns                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Compiled sync registry      | Definition IDs, versions, provider association, required scopes, schemas, models, default schedules, and trusted function implementations |
| Sync control service        | Enabling, disabling, upgrading, manually triggering, and inspecting per-connection sync installations                                     |
| Durable scheduler           | Due-time calculation and idempotent creation of queue items                                                                               |
| Sync worker                 | Queue leasing, deadlines, cancellation, retries, and invocation of trusted definitions                                                    |
| Provider capability adapter | Connection resolution, OAuth refresh, authenticated proxy requests, and Action execution                                                  |
| SQLite sync store           | Atomic commits, schedule/run state, checkpoints, record cache, change sequence, snapshot marks, webhook receipts, and outbox state        |
| Delivery engine             | Sink leasing, batching, signing, backoff, and acknowledgement after network delivery                                                      |
| HTTP/API layer              | Authentication, request validation, and serialization of control, status, webhook, and change-feed routes                                 |

Provider metadata continues to belong to provider definitions and the generated catalog. Sync
definitions refer to a provider by service ID and do not copy its display name, OAuth endpoints, or
credential shape.

The sync store is a Node/SQLite-specific dependency, not a new member of the cross-platform
`RuntimeDatabase` interface. A future backend can implement the sync-store contract deliberately;
the initial implementation must not add placeholder PostgreSQL or D1 methods.

## Proposed module boundaries

The exact filenames may evolve, but the responsibility split should remain:

```text
src/sync/definition.ts             public trusted-definition contract
src/sync/registry.ts               immutable compiled registry
src/sync/provider-client.ts        credential-free provider capabilities
src/sync/control-service.ts        installation and manual-run lifecycle
src/sync/scheduler.ts              due schedule -> durable queue item
src/sync/worker.ts                 leases and executes one sync job
src/sync/commit-service.ts         validation and atomic commit orchestration
src/sync/delivery.ts               generic sinks and durable outbox dispatcher
src/sync/webhooks.ts               verified receipt and durable enqueue
src/sync/sqlite-sync-store.ts      all sync SQLite statements and transactions
src/sync-definitions/github/...    compiled GitHub definitions
```

There should be no `index.ts` barrel. The Node entry point composes a `SyncRuntime` from these
concrete modules. HTTP routes receive the control and query interfaces, not the SQLite connection.

## Trusted sync-definition API

The API is generic over configuration, checkpoint, and declared output models. This is an
illustrative contract, not a commitment to the exact TypeScript spelling:

```ts
defineSync({
  id: "github.pull-requests",
  version: "1.0.0",
  provider: "github",
  defaultSchedule: { everySeconds: 300 },
  requiredScopes: ["repo"],
  configSchema: s.object({
    owner: s.string(),
    repository: s.string(),
  }),
  checkpointSchema: s.object({
    updatedAt: s.string(),
    nodeId: s.string(),
    pageCursor: s.optional(s.string()),
  }),
  models: {
    PullRequest: pullRequestSchema,
  },

  async run(ctx) {
    const checkpoint = await ctx.checkpoint();
    for await (const page of fetchPullRequests(ctx.provider, ctx.config, checkpoint)) {
      await ctx.commit({
        upserts: { PullRequest: page.records },
        deletes: {},
        checkpoint: page.nextCheckpoint,
      });
    }
  },

  async onWebhook(ctx, event) {
    // Validate the provider event, hydrate affected records, then call ctx.commit().
  },
});
```

Definition IDs are stable logical identities. Versions are immutable semantic versions in the
compiled registry. An installation selects exactly one definition version. Activating a version
with an incompatible config, checkpoint, or model schema requires an explicit migration or a
checkpoint reset; it must never reinterpret stored JSON optimistically.

The model namespace is `(installation, model, record ID)`, not `(definition version, ...)`, so a
compatible definition upgrade preserves change detection. A breaking model change either uses a
new model name or declares a cache reset during upgrade. Resetting a checkpoint alone keeps the
cache and therefore preserves added-versus-updated detection.

`SyncContext` exposes only:

- `connection`: opaque connection ID, provider service, and non-secret profile information;
- `config`: the installation config after schema validation;
- `checkpoint()`: the checkpoint captured for this run;
- `provider.request(...)`: authenticated relative REST or GraphQL requests;
- `provider.runAction(...)`: a declared existing OpenConnector Action on the same connection;
- `commit(...)`: one validated atomic page commit;
- `snapshot.start()`, `snapshot.commit(...)`, and `snapshot.finish({ checkpoint })` for full-scan deletion
  detection;
- structured logging, an abort signal, and an absolute deadline.

The provider adapter reuses `ConnectionService` for connection lookup and OAuth refresh and reuses
the provider loader's proxy and Action executors in-process. It does not call the public HTTP API.
Calls are restricted to the definition's provider, connection, required scopes, and declared
Actions. The same guarded provider egress path remains responsible for SSRF checks, redirect checks,
timeouts, provider-specific authentication, and rate-limit errors.

`SyncContext` must not expose `getCredential`, raw executor contexts, arbitrary fetch, the runtime
database, or the sink registry. Log fields and errors pass through the existing secret-redaction
rules before persistence.

## Durable state model

All sync tables live in the existing `connect.sqlite` database and are installed by normal numbered
migrations, which PR1 already embeds in the standalone executable. Timestamps are UTC ISO strings;
ordering uses integer sequences or explicit tie-breakers rather than timestamp uniqueness.

### Installations and schedules

`sync_installations` stores one configured sync per OpenConnector connection:

- stable installation ID;
- definition ID and selected version;
- provider service and immutable OpenConnector connection ID;
- validated config JSON and config schema version;
- lifecycle state: `enabled`, `disabled`, or `needs_attention`;
- schedule interval, next due time, and last successful time; and
- created and updated timestamps.

The connection ID, rather than a mutable connection alias, binds an installation to credentials.
Deleting or replacing that connection disables the installation and records a reason. Reconnecting
does not silently attach old sync state to a different provider account.

The initial schedule grammar is a positive fixed interval plus an optional deterministic jitter.
It is adequate for one process and easy to persist. Cron expressions can be added later without
changing run or queue semantics.

### Queue items, runs, and leases

`sync_jobs` is the durable queue. A job records:

- stable job ID and installation ID;
- reason: `schedule`, `manual`, `backfill`, `webhook`, `reconcile`, or `retry`;
- definition version and optional webhook receipt ID;
- due time, priority, attempt number, and deterministic deduplication key;
- state: `queued`, `leased`, `completed`, `failed`, or `cancelled`;
- lease owner, lease generation, and lease expiry; and
- last structured failure classification.

`sync_runs` stores one attempt. Its state and progress are mutable only until it reaches a terminal
state, after which the row is operational history. Job and attempt state machines are distinct:

```text
job: queued -> leased -> completed
                |  |
                |  +-> retry_wait -> queued
                +----> failed | cancelled

attempt: running -> succeeded | failed | cancelled | lease_expired
```

The job deduplication key is unique. For schedules it is derived from installation ID plus the
scheduled due instant, so repeated scheduler ticks cannot create duplicate work. Manual triggers
use a caller-supplied idempotency key or a new trigger ID. Repeated provider webhook event IDs map to
one receipt and one logical job.

The scheduler periodically performs one short transaction: select enabled installations whose
`next_due_at` has passed, insert jobs with unique deduplication keys, and advance each schedule's
next due time. It coalesces missed intervals into one immediate reconciliation job rather than
replaying every missed poll after downtime. A manual backfill range, if later supported, is a
separate explicit feature.

One in-process worker claims the oldest due job in a transaction, setting a random process owner, an
incremented lease generation, and a short expiry. It heartbeats between provider pages. Every page
commit compares the job ID, owner, generation, and unexpired lease, preventing a stale worker from
committing after recovery has reassigned the job.

On startup, expired leases become queued retry attempts. Non-expired leases are left alone until
expiry, which handles overlap during a slow restart. Graceful shutdown stops new claims, aborts the
active provider request, and gives the worker a bounded opportunity to finish or record a retry.
The checkpoint makes a hard kill equivalent to failure immediately after the last committed page.

### Checkpoints

`sync_checkpoints` stores one provider checkpoint per installation and selected definition version,
along with the checkpoint schema version, the run that last advanced it, and an update timestamp.
The checkpoint is an opaque provider-specific JSON value validated by the definition.

A run reads one checkpoint snapshot when it starts. The definition may advance it only through
`commit`. A checkpoint never means that a provider page was merely fetched; it means all effects of
that page are durable. Definitions should use a deterministic compound boundary such as
`(updatedAt, provider ID)` and an inclusive overlap when provider timestamps are coarse. Stable
record hashes make the overlap harmless.

Initial backfill starts with no checkpoint. If it stops halfway, the next attempt resumes from the
last committed page. A completed backfill transitions the installation to normal reconciliation.
For APIs whose page tokens expire, the definition stores a durable high-water boundary and can
restart the current window safely instead of depending on a long-lived token.

Provider checkpoints are never returned as consumer cursors. Consumer cursors represent positions
in OpenConnector's ordered change log and remain valid when provider checkpoint formats change.

### Record identity, hashing, and revisions

`sync_records` is the canonical latest-record cache. Its primary key is:

```text
(installation_id, model, record_id)
```

Each row stores the latest full JSON payload, a SHA-256 payload hash, a monotonically increasing
record revision, first-seen and last-changed timestamps, deletion state, deletion timestamp, and the
last completed snapshot that saw it.

The definition must produce a non-empty stable provider identity for every record. Record IDs are
opaque strings; the kernel never infers identity from array order or hashes the whole payload as an
ID. Models are definition-declared strings.

Before hashing, the kernel validates the payload against its model schema and serializes JSON in a
canonical form with recursively sorted object keys. Arrays retain order. Non-JSON values and
`undefined` are rejected. Definitions should remove volatile fetch metadata that does not represent
a meaningful provider change.

An upsert creates an `added` event when no row exists or the row is tombstoned. It creates an
`updated` event only when the canonical payload hash differs. An identical active upsert merely
updates snapshot-seen bookkeeping. A delete against an active row increments the revision, marks a
tombstone, preserves the last-known payload, and emits `deleted`. Repeating the same delete is a
no-op. Resurrection is represented by a new `added` event with the next revision.

`sync_changes` is append-only and has both a monotonically increasing SQLite integer sequence and a
globally unique event ID. It stores the operation, complete payload (including the last-known
payload for a tombstone), record revision, source identifiers, run ID, and occurrence timestamp.
Keeping the payload in the change row makes replay deterministic even after the latest cache entry
changes again.

## The atomic page-commit invariant

Provider requests finish and their results are schema-validated before entering SQLite. A single
`BEGIN IMMEDIATE` transaction then:

1. verifies the active job lease and expected checkpoint revision;
2. loads affected cache rows;
3. applies changed upserts and tombstones with monotonic record revisions;
4. appends one change event per material change;
5. inserts one outbox row per event and enabled push sink;
6. updates snapshot-seen markers, run counters, and run progress;
7. writes the validated next provider checkpoint with compare-and-swap semantics; and
8. commits.

If any statement fails, all eight effects roll back. A process crash before commit repeats the page;
a crash after commit resumes after it. Both cases are safe because stable identities and hashes make
replayed provider data idempotent.

The transaction contains no provider request, sink request, secret decoding, asynchronous callback,
or arbitrary sync-definition code. SQLite statements remain synchronous through `node:sqlite`, and
the transaction is kept small enough that the HTTP server can continue serving unrelated reads.

## Safe deletion detection

Incremental syncs may emit explicit delete IDs only when the provider supplies a deletion stream,
archive flag, or equivalent evidence. The absence of an item from an incremental page is never
evidence of deletion.

For providers that require a complete enumeration, the definition uses snapshot boundaries:

1. `snapshot.start()` persists a unique snapshot ID, the model set, and a baseline change sequence.
2. Each page commit marks every returned record with that snapshot ID. It does not delete unseen
   records.
3. The definition calls `snapshot.finish({ checkpoint })` only after every requested provider page
   succeeds.
4. One final transaction tombstones active baseline records in the snapshot's models that were not
   seen, appends changes and outbox rows, marks the snapshot complete, and advances the final
   checkpoint.

A failed, cancelled, expired, or abandoned snapshot never deletes records. Its marks may remain for
diagnostics and are ignored by later snapshot IDs. The baseline sequence prevents a future
multi-worker implementation from deleting a record introduced after the snapshot began. With the
initial concurrency of one, it also documents the intended invariant rather than relying on an
accidental scheduling property.

This is full-scan deletion detection, not full-refresh table replacement: unchanged records retain
their identity and revision, changed records update in place, and consumers receive only deltas.

## Retry and rate-limit policy

The provider capability adapter returns structured failure classes:

- `rate_limited`, with parsed provider reset or `Retry-After` information;
- `transient`, for timeouts, connection failures, and retryable provider 5xx responses;
- `auth_required`, after the existing OAuth refresh path cannot restore access;
- `invalid_definition`, for schema, checkpoint, or undeclared-capability violations; and
- `permanent`, for non-retryable provider responses.

Rate limits schedule the next attempt at the provider deadline plus bounded jitter. Other transient
failures use exponential backoff with jitter and a configured cap. The attempt counter and next due
time are persisted before the worker releases the lease. `auth_required` and definition/config
errors put the installation in `needs_attention` to avoid hammering the provider. Permanent errors
fail the run; operator policy decides whether the next regular reconciliation should still occur.

Retries are at-least-once executions from the last page checkpoint, not blind replays of in-memory
function state. Definitions must not perform provider writes. A deadline asks the definition to stop
after the current page; forced cancellation falls back to lease expiry and checkpoint recovery.

## Generic delivery and change feed

Provider acquisition and delivery are independent loops. A successful page commit is not delayed by
a consumer outage.

The kernel-facing sink contract is intentionally small:

```ts
interface SyncSink {
  readonly id: string;
  deliver(batch: ChangeBatch, context: SinkContext): Promise<DeliveryResult>;
}
```

The first implementation is an HTTP sink. Sink configuration and HMAC secrets are stored through
OpenConnector's secret codec. The delivery worker leases due `sync_outbox` rows in a short
transaction, performs the HTTP request outside SQLite, then acknowledges or reschedules them in a
second transaction. A stable batch ID is derived from the sink and ordered event IDs. Retries resend
the same full events and batch ID.

The logical event contract contains:

- protocol version and stable event ID;
- opaque ordered cursor;
- operation: `added`, `updated`, or `deleted`;
- source provider, opaque connection ID, sync definition ID, and model;
- record ID, revision, full payload, and deletion timestamp; and
- provider-observed time when available, plus engine commit time.

The HTTP representation will be finalized with consumers separately. It must not use
OpenConnector-, Nango-, or Context Use-specific metadata names. Requests include a timestamp, body
digest, signature key ID, and HMAC signature. Consumers acknowledge only after durably applying the
batch and deduplicate by event ID or batch ID. Non-2xx responses, timeouts, and 429s retain outbox
rows for durable retry. Delivery is at least once; exactly-once effects are the consumer's
idempotency responsibility.

The pull change feed reads `sync_changes` strictly after an opaque cursor and returns a bounded page
plus the next cursor. A consumer stores its own cursor outside provider checkpoint state. Push sinks
also track an acknowledged change sequence, so push can later fall back to pull replay without
altering the cache. Retention may compact acknowledged change and outbox rows only after every
configured durable consumer has advanced beyond them; the latest-record cache and tombstones have
their own explicit retention policy.

## Provider webhooks

Provider webhooks are a third boundary, distinct from both polling and delivery:

```text
provider webhook -> verified durable receipt -> sync job -> cache commit
scheduled poll   -> provider reconciliation  -> cache commit
cache commit     -> outbox/change feed        -> external consumer
```

The HTTP webhook handler limits the body size, verifies the provider signature against secret
configuration, resolves the installation without exposing credentials, and transactionally stores
a deduplicated receipt plus a queued job before returning success. It does not run the sync function
inside the request. When the provider supplies no stable delivery ID, the receipt key uses a scoped
hash of the canonical request and a bounded deduplication window.

`onWebhook` receives a validated provider event, may hydrate authoritative state through
`ctx.provider`, and commits changes through the same atomic path as polling. Raw webhook payloads are
encrypted when retained, redacted from logs, and deleted after a short operational retention period.
Webhook jobs for the same installation can be coalesced; a periodic reconciliation schedule remains
enabled even when webhook processing appears healthy.

## Process and single-executable lifecycle

Only the Node entry point starts sync services. Startup order is:

1. materialize PR1's embedded assets and migrations;
2. open `connect.sqlite`, enable WAL, and apply migrations;
3. construct existing connection, OAuth, provider, proxy, and Action services;
4. construct the compiled sync registry and SQLite sync store;
5. recover expired leases and start scheduler, sync worker, and delivery worker; and
6. start accepting HTTP requests.

The runtime may start HTTP before step 5 only if readiness distinguishes `starting` from `ready`.
The simpler initial implementation completes recovery first. Shutdown stops timers and new leases,
aborts active network requests, waits for bounded cleanup, closes the HTTP server, and finally closes
SQLite.

No child process, dynamic code file, external scheduler, or additional executable is required. The
compiled registry and sync definitions are bundled exactly like existing provider runtime modules.
Definitions should remain lazy-loadable so providers without enabled syncs do not increase startup
cost.

## Control and observability

Admin control endpoints should support listing definitions and installations, validating config,
enabling, disabling, upgrading, triggering, and inspecting runs. A test run uses the same provider
capabilities and schemas but writes to an isolated temporary cache or returns a bounded preview; it
must never advance the production checkpoint or consumer cursor.

Operational views expose definition/version, connection profile, schedule state, current checkpoint
summary, last success, next due time, active lease, attempt count, records/change counts, outbox lag,
and redacted errors. They never expose credentials, sink secrets, raw authorization headers, or raw
signed webhook URLs.

Public `/v1` response shaping remains in `src/server/api/runtime-api.ts`. Route handlers dispatch and
validate rather than assemble compatibility objects. The admin console can initially use `/api`
control routes while the vendor-neutral change-feed protocol is finalized.

## First vertical slice: GitHub pull requests

The first complete definition is `github.pull-requests` and uses GitHub's provider-native GraphQL
endpoint through `ctx.provider.request`. Configuration selects an owner and repository. The model
contains a pull request plus normalized comments, reviews, and commits needed by generic consumers.

The backfill walks pull requests in a deterministic order. Incremental runs use a compound
`(updatedAt, node ID)` boundary with a small overlap and hydrate nested collections whose pagination
is independent. Each page commits only after all nested data for its records is complete. Closed and
merged pull requests remain normal upserts; deletion is emitted only from authoritative GitHub
evidence or a successful reconciliation snapshot.

The slice must demonstrate OAuth refresh, required-scope validation, GraphQL pagination, crash
resume, rate-limit reset handling, update detection, comments/reviews/commits refresh, explicit or
snapshot-safe deletion behavior, cursor replay, signed HTTP delivery, and reconciliation after a
webhook.

## Implementation sequence

Each step should be reviewable and leave the existing connector runtime working:

1. Add the SQLite sync store, migrations, model validation, canonical hashing, atomic page commits,
   latest-record queries, and change-feed queries.
2. Add durable installations, fixed-interval scheduling, queue leases, recovery, deadlines, retries,
   and operational run queries with global concurrency one.
3. Add the trusted definition contract, lazy compiled registry, and credential-free provider/Action
   adapter.
4. Add the sink abstraction, HTTP signing, durable outbox dispatcher, and cursor-based replay API.
5. Add the GitHub pull-request vertical slice and end-to-end restart/rate-limit tests.
6. Add verified provider webhook receipts and GitHub webhook hydration while retaining polling.
7. Add further definitions one provider at a time.

## Required verification

The store test suite should inject failures before and after every statement group in page commit and
snapshot finish, reopen the same SQLite file, and prove the invariant. Scheduler tests should use a
fake clock and multiple scheduler instances against one file to prove deduplication and lease
fencing. Delivery tests should crash after the consumer accepts a batch but before acknowledgement
and prove the identical event IDs are retried.

Definition contract tests should reject undeclared models and Actions, invalid config/checkpoints,
unstable or empty IDs, non-JSON payloads, and attempts to access another connection. Security tests
should prove sync functions cannot receive raw credentials, provider calls retain the shared SSRF
guard, logs redact secrets, and webhook signatures are checked before durable enqueue.

The GitHub end-to-end fixture should cover backfill, an unchanged overlap, an update, a tombstone,
restart from a mid-pagination checkpoint, rate limiting, a duplicated webhook, and reconciliation of
a deliberately missed webhook.

Every implementation PR must run `npm run fix-check`; provider definition or Action changes must also
run `npm run generate:catalog`.

## Deferred decisions

The following are intentionally deferred without weakening the kernel invariants:

- the final HTTP delivery and pull-feed wire spelling;
- operator-configurable change, tombstone, webhook, and run-log retention periods;
- cron schedules and multi-process concurrency;
- consumer-managed dead-letter workflows;
- sandboxed user-authored definitions; and
- additional storage backends.

Any later choice must preserve atomic page commits, separate provider and consumer progress,
credential-free definition capabilities, lease fencing, stable event identity, and polling-backed
webhook reconciliation.

## References

- [Nango sync functions](https://nango.dev/docs/guides/functions/syncs/sync-functions)
- [Nango checkpoints](https://nango.dev/docs/guides/functions/syncs/checkpoints)
- [Nango records cache](https://nango.dev/docs/guides/functions/syncs/records-cache)
- [Nango deletion detection](https://nango.dev/docs/guides/functions/syncs/deletion-detection)
- [Nango real-time syncs](https://nango.dev/docs/guides/functions/syncs/realtime-syncs)
- [DBOS scheduled workflows](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows)
- [DBOS queues and concurrency](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)
- [Activepieces polling trigger](https://www.activepieces.com/docs/build-pieces/piece-reference/triggers/polling-trigger)
