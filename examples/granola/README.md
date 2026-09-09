# Granola MCP meeting sync

`granola.meetings` emits one `meeting` record per native Granola meeting ID, with the generated summary followed by the transcript. It uses the **Granola MCP** OAuth connector (`granola_mcp`). The existing **Granola** API-key provider remains available for REST actions.

## Connect

Granola MCP uses browser OAuth with a public client and PKCE. Register a client for your deployment's exact Callback URL (shown in **OAuth Apps > Granola MCP**):

```sh
GRANOLA_REDIRECT_URI=https://connector.example.com/oauth/callback \
  node examples/granola/register-oauth-client.ts
```

Save the returned Client ID in OAuth Apps and leave Client Secret empty. Connect **Granola MCP** in Providers. Use a Granola plan with transcript access and select the intended workspace in Granola. Workspace access also depends on its MCP settings. The connector requests OpenID scopes to verify the provider's stable account subject through UserInfo; email addresses and credential hashes are never source identities.

The registered sync appears in **Syncs** and starts through the existing scheduler. Its configuration is `{}`, and its default polling interval is one hour. Start, stop, resume, run now, and change the interval using the same controls as other syncs. Configure the receiving webhook in **Destinations**; the definition uses the framework's existing delivery and retry behavior.

## Coverage and recovery

- Each iteration scans the MCP `last_30_days` window and re-fetches both summary and transcript. This catches edits within the window; it does **not** provide a full historical backfill or detect edits to older meetings.
- Source identity is the OAuth account. MCP follows that account's active workspace, so each discovery scan covers the workspace selected at that time. Native meeting IDs retain their identity when the workspace selection or OAuth credential changes. This does not combine all workspaces in one scan.
- Discovery is bounded to 1,000 returned meeting IDs. Explicit count mismatches, duplicate IDs, or a reported continuation fail the iteration rather than silently advancing. Unreported upstream caps remain an MCP coverage limitation.
- The checkpoint stores only remaining IDs. Each complete meeting and its checkpoint commit together. Restarting re-fetches unfinished records without merging them into old content.
- A missing summary, unavailable transcript, permission failure, or malformed response fails the iteration. It does not replace an earlier complete record with partial content. Failed iterations appear in the normal sync history. If access changes leave an unfinished ID permanently unavailable, use an explicit backfill to restart discovery.
- Absence never means deletion. Meeting dates appear as source context in Markdown; MCP's display dates are not treated as record creation or modification timestamps.

For a preview without changing stored progress, send `{"dryRun":true,"maxPages":1}` to `POST /api/sync/definitions/granola.meetings/run` with your normal admin authentication.

A normal or targeted backfill uses the same endpoint with `"backfill":true` and, optionally, `"targetReceiverId":"your-destination"`. Here, backfill means restarting the supported 30-day scan. New destinations receive future changes; a targeted backfill also delivers unchanged records from that scan to the selected destination.

Official references: [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp), [OAuth discovery](https://mcp.granola.ai/.well-known/oauth-authorization-server), [OpenID discovery](https://mcp-auth.granola.ai/.well-known/openid-configuration).
