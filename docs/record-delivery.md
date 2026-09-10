# Record delivery contract

OpenConnector owns one delivery contract for every record destination. The machine-readable source
of truth is [record-delivery.openapi.yaml](record-delivery.openapi.yaml); the sender types and runtime
schema are generated from it.

A destination supplies its URL and an opaque bearer token when it is configured. OpenConnector
`POST`s a JSON batch to that URL with `Authorization: Bearer <token>` and an `Idempotency-Key` equal
to the body’s `batchId`. The contract deliberately does not define a receiver URL or token format.

A `2xx` response acknowledges the complete batch. Destinations should respond only after every
record is durably accepted; any other response may cause OpenConnector to retry the exact body and
idempotency key. A destination can return `Retry-After` to request a delay.

Each batch contains at most 50 records and is at most 16 MiB. Upserts contain Markdown `body` plus
optional source metadata; deletions are tombstones without content. Receivers should deduplicate
events by `eventId`, use `(sourceId, kind, id)` as the record identity, and ignore revisions older
than the latest accepted revision. All field constraints are defined in the OpenAPI schema.

`contentHash` is the lowercase SHA-256 of content encoded as UTF-8 canonical JSON: object keys are
sorted recursively, array order is preserved, non-finite numbers are rejected, and negative zero is
normalized to zero. A deletion carries the hash of the last content.

Changes incompatible with existing destinations require a new envelope `version` and OpenAPI
contract version.
