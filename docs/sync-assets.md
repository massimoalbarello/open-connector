# Sync attachment storage

Compiled syncs acquire attachment bytes through their provider and pass them to
`context.assets.stage({ name, bytes })` before yielding the corresponding record.
The returned `{ sha256, name, sizeBytes }` goes in the record's `assets` manifest.
Use `syncAssetUrl(asset)` for attachment links or inline images in its Markdown.
These framework addresses describe source content; destination addresses do not
belong in the source manifest or source change hash.

Staging persists bytes in the runtime SQLite database under the current run lease.
A page can commit only when all its declared bytes are available. The record,
outbox references, and acquisition checkpoint then commit in one transaction.
Repeated bytes share storage, including across several pending record revisions.
Definitions stage attachments for the next page, then yield it before acquiring
the following page.

Each asset is limited to 100 MiB. Pending asset bytes have a default 1 GiB budget,
configurable through `SqliteRuntimeDatabaseOptions.maximumPendingAssetBytes`.
This budget counts retained attachment content, excluding SQLite and record
metadata overhead. Exhausting it pauses acquisition at the last committed page;
scheduled runs retry after a minute without increasing the acquisition failure
count. Delivery continues independently.

Local bytes remain until every delivery needing them is acknowledged. Unclaimed
staging bytes are released when their run ends or its lease expires. SQLite can
reuse released pages; releasing bytes does not promise to shrink the database
file. Dry runs validate and hash bytes without persisting them.

## Delivering to context-use

Configure the record webhook as `https://<context-use-host>/api/records/batch`
and the asset upload URL as `https://<context-use-host>/api/assets/imports`.
Both endpoints use the API key issued by the context-use sync. The destination
form accepts both URLs; API clients can set the optional `assetsUrl` field on
`PUT` or `PATCH /api/sync/destination`, or clear it with `null`. Assets and records
must use the same HTTPS origin. Other receivers can implement the same protocol.

The sender looks up `GET <assetsUrl>/<sha256>` before uploading missing bytes with
`PUT` to the same address. PUT uses multipart fields `name`, `sha256`, and `file`.
A completed upload returns `{ assetId, url, sha256, sizeBytes }`, with a permanent
asset address in `url`. A missing key returns 404; the same key and bytes must
return the same asset on repeated requests. Conflicting bytes must fail. Uploaded
assets are independent resources and do not belong to a batch reservation.

Successful upload receipts are retained locally. Once every required asset is
ready, the sender resolves Markdown destinations, replaces the source manifest
with the complete `assetIds` set, computes the hash of that final content, and
persists the request body. Retries reuse the exact body and batch ID. Uploads and
record requests have separate timeouts, and the delivery lease renews during
uploads. A lost upload response is recovered by lookup; a lost record response is
recovered by retrying the frozen request.

If longer destination addresses push an unsent batch past 16 MiB, only its fitting
prefix is sent and the remaining records stay queued. Individual resolved records
must still fit the 8 MiB record limit. Changing destination addresses or credentials
fences in-flight work and clears destination-specific upload mappings; pending
source content and bytes remain available for the replacement destination.

The receiver atomically accepts each record with its complete asset-reference set.
It deduplicates records by revision without persisting batch receipts. Cleanup of
independently uploaded, unreferenced receiver assets is outside this protocol.
