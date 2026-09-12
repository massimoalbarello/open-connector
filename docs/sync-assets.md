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
