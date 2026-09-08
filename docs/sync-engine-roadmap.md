# Sync engine follow-up PRs

Status: proposed sequence after the PR3 storage review, 2026-09-08. These are implementation slices,
not already opened PRs or claims that the functionality exists. Actual PR numbers are assigned by
GitHub. Keep each slice usable/testable without requiring unfinished later layers.

The [architecture](sync-engine-architecture.md) owns framework invariants, and
[the authoring guidelines](../src/sync-definitions/AGENTS.md) own source-specific record rules.
The [Nango source audit](nango-sync-internals.md) explains the reference implementation and where
our smaller, single-process design differs.

## PR3: reviewed storage foundation

Keep this PR on SQLite persistence: canonical JSON/hashes, upserts/tombstones/revisions, immutable
changes, outbox enqueue, run-lease guards, checkpoint compare-and-swap, and safe snapshot completion.
The review hardens prototype-named JSON keys, host-clock lease expiry, snapshot participation, and
input validation; it expands rollback/reopen tests. Provider/receiver requests remain outside SQL.

Current limitations are explicit: full payloads remain in both latest-record and change rows;
there is no acknowledgement or cleanup API yet. Run state survives reopen, but automatic expired-run
recovery is not implemented. Definition schemas and account-rebinding semantics are not enforced.
The current sink registration is an internal id/kind/enabled store operation, not an HTTP webhook
registration API. The schema and fan-out policy will evolve in later migrations before delivery.

## Follow-up 1: shared record contract and stable source binding

Scope:

- Introduce the shared Markdown-first input schema and normalizer: native `id`, `body`, optional
  source URL/timestamps, participants with identities/roles, and declared attributes. No attachments.
- Validate timezone-qualified timestamps and normalize deterministically. Hash only normalized
  record content, excluding identity/routing and operational fields.
- Declare output kinds and inject provider/kind/source context. Keep the term **record** in public
  contracts, including the receiver protocol; do not introduce consumer-specific payload fields.
- Persist the verified logical source account/workspace independently of current credentials.
  Automatically create the source/definition binding without mandatory filters or installation UI.
- Rebind replacement credentials only after verifying the same stable provider account and
  authorization boundary. Verify outside the transaction, then fence the credential revision when
  storing the binding. Different/ambiguous accounts must not inherit another source's checkpoint.
- Prefer the natural `(source namespace, kind, external ID)` record key. Keep a separate internal
  ID only if a concrete storage need justifies it. Migrate existing installation-based state without
  regenerating record identity/revisions. Do not infer source identity from aliases or display names.

Acceptance:

- Same verified account with refreshed/replaced credentials preserves IDs, revisions, and progress.
- A different account has isolated record/checkpoint state, even if a connection alias is reused.
- Metadata-only content changes deliver as updates; transport-only changes do not change hashes.
- Invalid dates, unknown fields/kinds, empty IDs/bodies, and conflicting bindings are rejected.

No scheduler or outbound HTTP delivery in this PR.

## Follow-up 2: compiled sync SDK and a manually runnable GitHub sync

Depends on follow-up 1. Build the abstraction against a real record, not only synthetic fixtures.

Scope:

- Add the trusted definition contract, lazy compiled registry, validated config/checkpoints, and
  a connection-bound provider/Action adapter that reuses existing authentication and guarded egress.
- Add one-shot execution with run ownership, lease heartbeats during long network calls,
  cancellation/deadlines, structured errors, and atomic commits. Read account/record IDs as strings.
- Add `github.pull-requests`: discover accessible repositories, perform a resumable initial
  backfill, discover changed PRs, hydrate required comments/reviews/commits through all pages, and
  render complete deterministic Markdown records. No mandatory repository-filter configuration.
- Verify actual API discovery and child-update behavior before committing to a watermark scheme.
  Document provider limits and fallback reconciliation, following the authoring guide.
- Provide an authenticated manual run entry point and an isolated dry-run/example path. No raw
  credentials, SQL handle, subscriber keys, or unrestricted fetch in the sync context.

Acceptance:

- One connection can run the definition and create durable records/outbox work without a scheduler.
- Backfill, overlap, edits to old PRs, independent nested pagination, and failed hydration are tested.
- Restart/resume preserves committed progress; schema-version mismatch requires migration/reset.
- Tests prove scope checks, secret redaction, guarded network access, and cancellation/lease fencing.

No inbound provider webhooks or automatic scheduling yet.

## Follow-up 3: receiver registration, durable push, and acknowledgement cleanup

Depends on follow-ups 1 and 2 for an end-to-end demonstration. Generic outbox tests can use fixture
records and must not depend on GitHub response shapes.

Scope:

- Add authenticated webhook/subscriber registration with destination URL, authorized source scope,
  and a receiver-provided API key. Keep registration authorization separate from outbound auth.
- Use HTTPS Bearer authentication initially. Protect keys through the configured secret codec,
  support rotation/redaction, and validate destinations through shared guarded egress. Reject
  redirects instead of forwarding a credential to a different target. Do not expose keys in reads.
- Finalize a vendor-neutral, versioned record-event envelope with stable event ID, source/kind/native
  record ID, revision, operation, and complete upsert content; deletes need identity/revision only.
- Persist delivery leases, fixed batch membership, attempts, due times, acknowledgements, and
  terminal failures per subscriber. Timeout/throttling/transient failure retries use backoff,
  jitter, and Retry-After; auth/config failures require attention rather than silently dropping work.
- Implement separate short transactions for acquisition commit, delivery claim, and delivery
  acknowledgement/retry. All HTTP and key decoding happen outside the transactions. A 2xx means
  the receiver durably accepted the entire batch; partial acceptance is not an initial feature.
- Separate compact record metadata from temporary immutable revision payloads. Migrate PR3's
  duplicate cached/event bodies. Purge a revision's content only after all intended subscribers
  acknowledge it; preserve hashes/revisions/tombstones. Never let an old ACK purge newer content.
- New subscribers begin with future changes. If bootstrap is requested, explicitly refetch current
  records and enqueue for that subscriber even when hashes match. Do not reset other subscribers'
  progress or increment a record revision just to bootstrap a receiver.
- Provide a runnable generic receiver fixture. Context Use can implement one inbox/upsert endpoint
  and acknowledge durable receipt before indexing; it should not poll providers or drain cursors.

Acceptance:

- The manual GitHub sync delivers records to the fixture with the registered API key.
- Crash after provider commit resumes delivery without refetching for delivery. Crash after the
  receiver accepts but before local ACK recording resends identical events safely.
- Two receivers have independent attempts/ACKs; disabled or failed is not acknowledged. Cleanup
  races, old ACKs, deleted records after body purge, and restart are exercised against SQLite.
- A purged unchanged record stays a no-op on ordinary acquisition, yet can bootstrap a new receiver.
- Bad keys, forbidden destinations/redirects, timeouts, 429s, and 5xx responses cannot lose records.

Backlog caps/automatic pause policies, HMAC signing, public pull APIs, and historical archive replay
are deferred. Until caps exist, outages retain pending content. Operational documentation must state
this disk-growth behavior. Removing a subscriber must explicitly resolve its pending obligations.

## Follow-up 4: scheduling and automatic recovery

Depends on the prior one-shot execution and delivery contracts.

Scope:

- Add persisted fixed-interval schedules and idempotent queueing with global acquisition concurrency
  one. Coalesce missed ticks rather than replaying every missed interval after downtime.
- Recover expired runs/leases at startup, fence prior owners, and resume from committed checkpoints.
  Preserve or deliberately restart an interrupted snapshot with the correct checkpoint; never
  resume from a mid-scan cursor with a fresh snapshot and infer deletion of earlier pages.
- Classify provider auth/rate-limit/transient failures and persist retry due times. Delivery retry
  state stays independent of acquisition retry state.
- Compose services in the single executable, with bounded shutdown, readiness, manual trigger,
  enable/disable, and basic run/outbox status. Do not add PostgreSQL, Redis, cron, or a sidecar.

Acceptance:

- Real process restart resumes work without duplicate scheduled jobs or stale-worker commits.
- Fake-clock tests cover missed ticks, deadline expiry, auth-required state, and Retry-After.
- Restart during a snapshot cannot delete records from previously committed scan pages.
- Existing connector APIs remain usable while network requests are in flight; no network-held SQL
  transaction. Acquisition, delivery, and shutdown remain independently cancellable.

## Follow-up 5: provider webhooks and more definitions

- Verify/deduplicate provider webhook receipts, durably enqueue before acknowledging them, hydrate
  affected records through the same definition path, and retain polling reconciliation.
- Add Gmail thread and Granola meeting-transcript definitions individually, with evidence-backed
  incremental strategies and explicit coverage limitations. Do not assume a provider offers a
  durable change cursor merely because the SDK supports checkpoints.
- Test duplicate/out-of-order webhooks, missed-event reconciliation, token expiry, and permissions.

Attachments, two-way writes, advanced filtering, additional internal IDs without a demonstrated
need, multi-process orchestration, and backlog policy are not prerequisites for the first useful
record-sync service.
