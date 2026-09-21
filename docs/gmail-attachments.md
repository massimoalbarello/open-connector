# Download Gmail attachments

`gmail.download_attachment` decodes a Gmail attachment into a temporary transit file and returns
`{ fileId, downloadUrl, sizeBytes, name, mimeType }`. Fetch `downloadUrl` to stream the raw bytes.
The action returns only after the complete attachment has been validated and stored.

Use a connected Gmail OAuth account or a delegated service account with Gmail read access. Obtain
`messageId` and `attachmentId` from the message and its attachment part. Optional `fileName` and
`mimeType` come from that part's metadata; they default to `attachment` and
`application/octet-stream`. Optional `userId` defaults to `me`.

```bash
curl -s -X POST http://localhost:3000/v1/actions/gmail.download_attachment \
  -H "authorization: Bearer $OOMOL_CONNECT_RUNTIME_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"input":{"messageId":"MESSAGE_ID","attachmentId":"ATTACHMENT_ID","fileName":"report.pdf","mimeType":"application/pdf"}}'
```

This action currently requires the Node filesystem transit backend (`OOMOL_CONNECT_TRANSIT_FILE_BACKEND=local`,
the Node default). S3, R2 and KV stores do not
implement the optional `createFromStream` capability and are rejected before the attachment request.
No buffered fallback is used. Normal transit-file expiry and `OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES`
still apply; the limit counts decoded bytes. The normal provider request timeout also applies.

[Gmail returns attachment bytes as base64url inside JSON](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments).
The Gmail adapter processes that response incrementally, retaining a 16 KiB base64 block and at most
16,384 characters of JSON envelope text, plus transport chunks. The filesystem writer applies backpressure and
writes to a temporary file. It commits only after validating the JSON, base64url and reported size;
failure, cancellation or a size-limit breach removes the partial file. The existing HTTP file
download streams from disk. Calling the internal `TransitFileStore.read` API still materializes a
`File`; use the HTTP download URL for streaming consumption.

The ordinary Gmail JSON proxy retains its 20 MiB response limit. This action is the separate file
path for attachments whose encoded JSON would exceed that limit.
