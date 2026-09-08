# Nango sync internals: source audit

Inspected on 2026-09-08 at Nango commit
[`1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c`](https://github.com/NangoHQ/nango/tree/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c).
This is a scoped, static source audit of the record/checkpoint path, deletion tracking, and outbound
sync-completion delivery, not an execution test or a full security/operations audit. No Nango source
was copied into OpenConnector. The repository's [license](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/LICENSE)
is ELv2; source availability is not a reason to transplant its implementation into this project.

## Record writes and checkpoints are separate operations

[`NangoSyncRunner.batchSave`](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/runner/lib/sdk/sdk.ts#L562)
removes framework metadata, splits records into batches, and calls `persistClient.postRecords`.
[`persistRecords`](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/persist/lib/records.ts#L19)
formats records, checks declared-model membership, and dispatches to the records store.

[`Checkpointing.saveCheckpoint`](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/runner/lib/sdk/checkpointing.ts#L60)
separately calls `putCheckpoint` with an expected version.
The [database upsert](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/shared/lib/services/checkpoints/checkpoints.ts#L74)
increments the version only when it matches, rejecting stale updates.
[Integration tests](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/shared/lib/services/checkpoints/checkpoints.integration.test.ts#L25)
cover missing/wrong versions and soft-delete resurrection conflicts. These tests were read, not run.
The sync runner checks for graceful interruption after successfully saving a checkpoint.

Consequence: the inspected API does not transact a batch save and its subsequent checkpoint save
together. A crash between them can cause acquisition and saving to repeat. We retain version checks
but use one SQLite commit for record state, delivery events, outbox entries, and progress. This
removes that cross-operation gap without promising exactly-once provider requests.

Nango's backend checkpoint validator accepts a bounded flat object of scalar values (at most 16
fields, bounded key/string lengths), with backend Date-to-ISO normalization. It is not arbitrary
nested JSON. We should keep checkpoints small and schema-validated without treating Nango's exact
limits or representation as requirements for OpenConnector.

## Identity and hash comparison

The [record formatter](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/records/lib/helpers/format.ts#L29)
retains an external ID and derives an internal UUID from the internal connection ID, model, and
external ID. It computes MD5 over `JSON.stringify` of the supplied record, not just one body field.
There is no canonical key sorting in that formatter.

Take the identity/content separation, not that exact encoding. Our logical source must survive a
credential/connection replacement for the same verified account. Keep SHA-256 over canonical,
normalized record content, excluding routing and operational metadata. A participants/attributes
change must deliver even if Markdown is byte-identical.

## Metadata, payloads, cursors, and pruning

The [PostgreSQL store](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/records/lib/stores/postgres/postgres.ts#L536)
classifies incoming records by external ID, hash, and deletion state in a transaction with an
advisory lock. It separates metadata from encrypted payload data and has an upsert path for that
payload data. It is not an immutable per-revision delivery log.

Record reads use an [ordered `(updated_at, id)` comparison](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/records/lib/stores/postgres/postgres.ts#L239),
encoded by the [cursor helper](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/records/lib/cursor.ts#L15).
This exposes current record state ordered by modification, not every historical version.

Its [prune mode](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/records/lib/stores/postgres/postgres.ts#L1270)
removes payload data and marks pruning while preserving metadata and cursor position. Auto-pruning
candidates use age, not downstream per-record acknowledgements. Metadata/payload separation is
useful for us; our target is acknowledgement-based removal of delivery content, not a lasting cache.

## Deletion tracking

[`trackDeletesStart` / `trackDeletesEnd`](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/runner/lib/sdk/sdk.ts#L702)
persist a starting job marker and later delete outdated records before clearing it. The store tracks
seen generations and processes outdated deletion in batches. Adopt the explicit complete-scan
boundary and resumable progress, not deletion inferred from missing incremental results. PR3's
snapshot completion remains its own SQLite implementation.

## Completion webhooks and retries

[`sendSync`](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/webhooks/lib/sync.ts#L96)
constructs a completion notification containing connection/sync/model identifiers and counts, not
record bodies. It can suppress unchanged runs and deliver to configured primary/secondary URLs.
The receiver fetches records separately; a successful notification is not acknowledgement of those
records being durably consumed.

The [delivery helper](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/webhooks/lib/utils.ts#L239)
uses stable body serialization, an HMAC header (alongside a legacy signature), timeout, circuit
breaker, and an in-process retry loop. Its `shouldRetry` implementation treats HTTP 300-499 as
non-retryable, including ordinary 429 responses. The inspected
[completion call site](https://github.com/NangoHQ/nango/blob/1edc1b40d8c4d7d6e0638c01bc1d473c5da7dd2c/packages/jobs/lib/execution/sync.ts#L449)
launches notification work asynchronously and records failures on a tracing span. This path does
not establish a durable per-record acknowledgement/outbox contract; this is not a claim about every
other Nango webhook subsystem or deployment.

For our target, push complete, bounded record batches from a durable SQLite outbox. Use stable event
IDs and record revisions, retryable throttling with `Retry-After`, independent subscriber state,
and acknowledgements only after durable acceptance. A receiver can use a generic inbox/upsert
handler rather than implement source polling or a cursor-draining loop. Pull can be added later,
but payload purge then requires explicit consumer acknowledgement, not merely an HTTP GET.

## Decisions for the next implementation slices

- Keep PR3 focused on its existing storage behavior; do not add the scheduler, SDK, or dispatcher in
  this documentation change.
- The target is compact record metadata plus temporary immutable delivery payloads. Purge payloads
  after all intended subscribers acknowledge the corresponding revision. Keep tombstones and
  revisions; do not purge on a timeout or because one subscriber is disabled.
- A new subscriber starts with future changes unless an explicit source backfill is requested.
  Backfill must enqueue for that subscriber even for unchanged hashes. Purged historical revisions
  cannot be replayed exactly; refetching yields current source state.
- New definitions follow [the sync-authoring instructions](../src/sync-definitions/AGENTS.md),
  including Markdown content, source-stable identity, optional validated timestamps, no attachments
  yet, complete hydration, and explicit incremental semantics.
- Backlog limits and automatic pause/operator policies are deferred. Until introduced, retain
  unacknowledged content even during prolonged outages; do not silently discard it. Subscriber
  removal/cancellation must explicitly resolve pending delivery obligations.
