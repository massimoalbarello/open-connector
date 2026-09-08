# Sync authoring guidelines

These instructions apply to trusted, compiled sync definitions under
`src/sync-definitions/<provider>/`. Shared execution and delivery machinery belongs in `src/sync/`.
The root repository guidelines also apply. Do not add barrel files.

## Scope and implementation status

This is the target authoring contract, not a claim that the SDK exists already. PR3 implements the
SQLite storage foundation. Definition registration, the provider capability adapter, automatic
scheduling/recovery, record-schema enforcement, subscriber delivery, and acknowledgement-based
payload cleanup are future work. Do not implement these separately inside a definition or expand
a storage-only change to include them.

Call the output a **record**: for example, a GitHub pull request, Gmail thread, or Granola meeting
transcript. One record may combine many endpoints and independently paginated related collections.
The framework must not need provider-specific knowledge to store or deliver it.

## Ownership and module boundaries

- A definition owns its stable ID, version, provider association, output kinds, required scopes,
  default cadence, optional configuration, checkpoint schema, discovery queries, hydration, and
  Markdown rendering. Each source/kind has one authoritative definition.
- Use the shared record contract and schema owner when implemented. Do not create a different
  universal schema for each provider. Use repository JSON-schema helpers for declared schemas.
- The framework supplies provider/kind/source context, validated input, connection-bound provider
  requests, existing read-only Actions, the checkpoint, cancellation/deadlines, logging, and an
  atomic commit operation. Provider metadata remains owned by the provider catalog.
- Scheduling, run leases, checkpoint persistence, hashes/revisions, subscriber registration,
  signing, retries, acknowledgements, and payload cleanup belong exclusively to the framework.
  Definitions never call receivers, write sync SQL, maintain delivery state, or hash records.
- Use the shared authenticated, SSRF-guarded provider capability. Never use global fetch, handle
  raw credentials, or create provider-local retry/timeout wrappers. Syncs acquire data; they do not
  mutate upstream records. Respect the abort signal and keep acquisition batches bounded.
- A compiled definition is trusted code, not a security sandbox. A restricted context is an API
  boundary, not isolation from malicious code compiled into the process.

## Identity survives reauthorization

- Supply a non-empty, opaque, provider-native record ID. For a composite ID, specify an unambiguous
  encoding and its scope; for example, repository ID plus PR number when no global PR ID is used.
- Never derive identity from the Markdown, a title, timestamp, array position, credential ID,
  connection alias, installation ID, or definition version. Preserve large numeric provider IDs
  without conversion through an imprecise JavaScript number.
- Use `(stable source namespace, kind, external record ID)` as the logical key. The framework may
  map it to a separate internal ID if storage needs one; do not require a second ID unnecessarily.
  A source namespace represents the logical account/workspace and authorization boundary, not the
  current credential handle.
- Reauthorization or replacement credentials for the same verified source must preserve record
  IDs, revisions, delivery history, and compatible checkpoints. Never silently link a different
  account by matching display name/email. Ambiguous source linking requires explicit resolution.
- Different accounts keep separate progress. The internal source/definition binding can be created
  automatically; a separate installation setup UI and filters are not required.
- Changing an ID scheme, kind, or source namespace requires an explicit migration. A checkpoint
  reset alone must not reset identity or revisions.

## Markdown-first record contract

Sync authors supply required `id` and non-empty `body` (Markdown). Optional fields are `sourceUrl`,
`sourceCreatedAt`, `sourceUpdatedAt`, `participants`, and schema-declared `attributes`. The framework
adds `provider`, `kind`, and the source namespace; it owns observation/commit times, hashes,
revisions, operations, and delivery envelopes. Do not duplicate those framework fields in output.

- Make the body understandable without provider-specific JSON: include a descriptive heading,
  source context/URL, meaningful status and timestamps, participants, user-authored content, and
  relevant nested activity. Preserve authored text and useful code/file locations.
- Important facts in participants or attributes must also be represented in Markdown. Structured
  fields support machine filtering; they must not hide content from Markdown-only consumers.
- Participants use shared identities and roles such as author, sender, recipient, or attendee.
  Deduplicate deterministically without treating display names as globally unique identities.
- Custom attributes are compact and declared by the kind's schema. Never include raw responses,
  debug metadata, credentials, API navigation links, pagination tokens, or whole nested objects
  merely because they were returned by the provider.
- Optional source timestamps must be real, timezone-qualified RFC 3339 strings. Validate calendar
  values and normalize to UTC with deterministic precision through the shared record normalizer.
  Reject ambiguous local times and invalid dates. Do not substitute fetch time for a missing
  source modification time. An event date is not automatically a modification timestamp.
- Attachments are deferred. Do not add attachment schemas, ingestion, downloads, blob storage,
  signed URLs, or a placeholder attachments field. Ordinary source links may appear in Markdown;
  they do not promise mirrored or durably retrievable assets.

## Deterministic changes

The framework compares a SHA-256 hash of the canonical, normalized content fields: body, source
URL/timestamps when present, participants, and attributes. Identity/routing and operational fields
are separate. Hashing only Markdown would miss a meaningful structured-field correction. No extra
body-only hash is required for the initial contract.

Render deterministically. Order set-like lists consistently, preserve meaningful chronological
order with stable tie-breakers, and avoid generated fetch-time prose. Do not aggressively normalize
user-authored Markdown. Identical content must not emit an update; changed content replaces the
complete record and advances its revision. Do not implement partial merge behavior in a sync.

## Discovery, hydration, and checkpoints

Document each definition's actual strategy next to its implementation:

1. The initial backfill scope and how it transitions to incremental runs.
2. The provider endpoint/filter/change feed used to discover new **and updated** records.
3. Each checkpoint field's meaning, schema version, and exact use in subsequent API requests.
4. Page ordering, timestamp ties/overlap, provider cursor expiry, and reset/recovery behavior.
5. How related changes invalidate the parent record, plus deletion and reconciliation coverage.

Prefer provider change cursors when available. Distinguish a long-lived incremental watermark from
a continuation token for the current scan. A checkpoint may contain both; keep it bounded and never
use it as record storage. Do not turn checkpoint bookkeeping into output records.

The execution pattern is: load the validated checkpoint, discover affected IDs, hydrate each record
from all required endpoints/pages, render and validate it, then atomically commit completed records
and the next checkpoint. The framework persists opaque progress; the definition interprets it.

- Advance progress only when all records covered by it have been durably committed. Merely fetching
  an ID or receiving a page is not completion. If a future design queues hydration separately, that
  pending work must itself be durable before advancing discovery progress.
- Resume interrupted backfills from committed progress. Repeated acquisition must be safe; do not
  promise exactly one provider fetch across a crash before commit.
- With timestamp filters, use provider-supported ordering, explicit boundary/tie handling, and a
  documented overlap where appropriate. Never blindly advance to local completion time. Preserve
  any fixed scan boundary and continuation state needed to avoid moving-window gaps.
- Updates to old records matter. Verify whether child changes advance the parent's watermark. If
  not, discover child changes separately or reconcile periodically. Do not assume this behavior.
- When no reliable incremental API exists, document the scan and its limitations. A recent-time
  window is not complete historical coverage. Prefer lightweight discovery and selective hydration
  where supported; do not claim a generic checkpoint makes an API incremental.
- Do not overwrite a complete record with accidental partial content after a required API failure.
  Propagate the failure without advancing past it. Distinguish unavailable optional content from a
  transient fetch failure; expose documented provider caps or intentional omissions in the body.
- An item missing from an incremental page, a permission-filtered response, or a partial scan is not
  deleted. Emit deletes only from authoritative evidence or after a completed, same-scope snapshot.
- Incompatible checkpoint changes require migration or an explicit reset/backfill policy. Never
  reinterpret stored state under a new schema without validation.

## Delivery and retention assumptions

Definitions are receiver-agnostic. Push delivery is the preferred initial transport; any later pull
transport must share the same durable subscriber/acknowledgement model.

Provider acquisition and receiver HTTP requests run outside database transactions. The framework
uses short, separate transactions to commit acquired records/progress, claim delivery work, and
record acknowledgements or retries. Receipt acknowledgement and safe payload release are atomic,
or a later cleanup transaction must recheck the same acknowledgement invariant. Never hold a
transaction open while waiting for an external service.

A receiver can supply its API key when registering its webhook. The framework owns protected key
storage, outbound authentication, secret redaction, and destination validation; sync authors never
see the key. Registration authentication and the receiver's outbound API key are separate concerns.

The framework retains immutable record content while an intended subscriber has not acknowledged
that revision. After all required acknowledgements, content can be purged; compact identity, hash,
revision, tombstone, and delivery metadata remain. An acknowledgement of an old revision cannot
release a newer pending payload. A disabled or failed subscriber is not an acknowledgement.

Do not depend on a permanent latest-body cache or historical payload replay. New subscribers that
need existing records require an explicit source backfill with subscriber-targeted enqueue even
when hashes are unchanged. This must not reset existing revisions or redeliver to other subscribers.
An exact historical body cannot be recovered after purge merely by refetching today's source state.

## Required tests

- Shared record-schema validation, non-empty Markdown, valid/invalid timestamp cases, and compact
  participants/attributes; fixture-only raw/debug fields do not leak into the saved record.
- Multi-endpoint aggregation, all required nested pagination, deterministic ordering, meaningful
  Markdown content, provider caps, and failure midway through hydration.
- Initial backfill, incremental queries derived from the checkpoint, edits to old records,
  timestamp ties/overlap, cursor expiry, and restart after a committed page.
- Stable native/composite IDs across repeat runs and compatible definition upgrades; framework
  contract tests own same-account reauthorization and different-account isolation.
- Identical inputs produce identical normalized output; a structured-only correction still changes
  content. Generic store tests own hash comparison and monotonic revisions.
- Deletion evidence and failed/incomplete snapshot safety where applicable. Generic framework
  tests own lease fencing, atomic rollback, acknowledgement races, and delivery retries.

Use the real shared SDK/test harness once it exists; do not invent a provider-local substitute.
Follow the root verification instructions. Never advance a production checkpoint in a dry run.
