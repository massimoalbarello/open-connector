# Gmail threads

`gmail.threads` produces one complete `thread` record per native Gmail thread ID.
The source namespace comes from Google's immutable OpenID Connect `sub`, verified
with the same OAuth access token used for Gmail. An email address remains a display
label. Reconnect older Gmail connections to grant `openid`; sync also requires one
of `gmail.readonly`, `gmail.modify`, or `https://mail.google.com/`. Existing Gmail
actions remain available to older grants.

## Acquisition

The initial scan covers all accessible mail, including Spam and Trash, through
`users.threads.list` with 50 IDs per page and no date or label filter. Each thread
is fetched with `users.threads.get(format=minimal)`, then each message with
`users.messages.get(format=raw)`. RAW contains the complete RFC 2822 MIME message,
including attachment bytes, so a separate `messages.attachments.get` request is
unnecessary. MailParser decodes MIME nesting, transfer encodings and character
sets. HTML bodies become Markdown through Turndown. Plain text stays literal.

Messages are ordered by Gmail `internalDate` and native message ID. The earliest
message supplies `sourceCreatedAt`; message dates are not presented as thread
modification times. Sender/recipient headers, dates, message subjects, label IDs
and attachment links appear in the body. Native label IDs are retained rather than
introducing a mutable label-name cache. Remote images are reduced to their alt
text and HTML scripts are discarded; no email content triggers remote downloads.

Every attachment is staged through the framework before yielding its thread.
Inline CID references are resolved within their own message. Files also appear
in an attachment list, including empty and unnamed files. Duplicate bytes can
share an asset; duplicate filenames do not overwrite each other. A second minimal
thread read verifies the message set and history ID before the record is yielded.
A changed thread or any required message/attachment failure retries the whole
record, without committing partial content.

## Incremental progress and recovery

Before scanning, capture the mailbox history ID from `users.getProfile` and a
fixed creation-sequence boundary for existing local record identities. After each
backfill or reconciliation page, apply one `users.history.list` page of up to 25
history events. Additions, deletions and label changes invalidate their parent
thread, including threads whose messages are old. Each affected thread is rebuilt
from Google; retained email bodies are never required.

History is chronological. After applying a non-terminal page, the last event's
native history ID becomes the next `startHistoryId`. After applying a terminal
page, use the response's mailbox history ID. This avoids persisting a separate
history continuation token. IDs remain decimal strings; comparisons use BigInt.
The checkpoint advances only after every affected thread has committed. A bounded
list of discovered IDs permits a restart between threads without advancing the
applied history cursor or retaining provider payloads.

History HTTP 404 resets discovery to a full mailbox scan. When that scan finishes,
re-fetch all previously known active thread IDs within the captured creation
boundary. This extra read pass trades API requests during recovery for avoiding a
second durable journal or snapshot lifecycle. Only an initial thread GET returning
404 emits a deletion. Missing scan entries, message GET 404 during hydration,
403, 429 and 5xx never do. Partial scans cannot delete records by absence. A stale
backfill page token returning 400 restarts discovery safely, preserving records
and the applied history cursor. Manual backfill follows the same recovery path.

Checkpoint version 1 fields:

| Field             | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `phase`           | Backfill, known-ID reconciliation, or incremental history.                                        |
| `historyId`       | Last fully applied history boundary; null initializes a full scan.                                |
| `pageToken`       | Next full-scan page, used only after pending IDs are hydrated.                                    |
| `throughSequence` | Fixed creation boundary for known-ID reconciliation.                                              |
| `afterId`         | Last discovered known ID; pending IDs finish before reading past it.                              |
| `pendingIds`      | At most 1,000 native IDs awaiting complete hydration.                                             |
| `nextHistoryId`   | History boundary to commit when the pending list is exhausted.                                    |
| `historyDue`      | Apply a history page before continuing the full scan.                                             |
| `historyComplete` | Current history response was terminal; finish the incremental cycle after pending records commit. |

The regular cadence is five minutes. Framework run/page limits, scheduling,
credential fencing, retry backoff and attachment storage backpressure apply.
History may expire again during a sufficiently long outage; recovery restarts
without clearing record identity or revisions.

## Limits and delivery

Provider responses are bounded to 128 MiB of JSON for one RAW message and 8 MiB
for discovery/metadata. Messages are parsed sequentially, buffering one MIME
message and its attachments at a time. The shared record limits (including
8 MiB of delivered text and 1,000 attachment/participant entries) still apply.
Oversized responses, records or history pages fail visibly and do not skip data.
Gmail controls API quotas; upstream failures use the normal acquisition backoff.

Configure the record destination and its independent asset import endpoint as
explained in [sync assets](../../../docs/sync-assets.md). The framework uploads
assets, resolves permanent receiver links, freezes each outgoing request, then
submits records in batches. Local bytes remain until delivery acknowledgement.
Receiver orphan cleanup is outside this implementation.

References: [Gmail message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
[history listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[synchronization](https://developers.google.com/workspace/gmail/api/guides/sync),
[Google account identity](https://developers.google.com/identity/openid-connect/openid-connect),
[MailParser](https://nodemailer.com/extras/mailparser).
