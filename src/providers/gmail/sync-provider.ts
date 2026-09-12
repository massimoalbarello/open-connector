import type { SyncProvider, SyncProviderContext } from "../../sync/provider-adapter.ts";
import type { JsonObject } from "../../sync/sync-store.ts";

import { optionalString } from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { SyncStoreError } from "../../sync/sync-store.ts";
import {
  providerFetch,
  ProviderRequestError,
  readProviderJsonBody,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";

/** Read complete MIME messages without exposing OAuth credentials to a sync definition. */
export function createGmailSyncProvider({ connection, signal }: SyncProviderContext): SyncProvider {
  if (connection.service !== "gmail" || connection.credential.authType !== "oauth2")
    throw new SyncStoreError("invalid_input", "Gmail sync requires an OAuth connection.");
  const accessToken = connection.credential.accessToken;
  return {
    async request(operation, input = {}) {
      let path: string;
      const query = new URLSearchParams();
      switch (operation) {
        case "profile":
          path = "profile";
          break;
        case "threads.list":
          path = "threads";
          query.set("maxResults", "50");
          query.set("includeSpamTrash", "true");
          if (optionalString(input.pageToken))
            query.set("pageToken", requiredInputString(input.pageToken, "pageToken"));
          break;
        case "threads.get":
          path = `threads/${encodePathSegment(requiredInputString(input.id, "id"))}`;
          query.set("format", "minimal");
          break;
        case "messages.get":
          path = `messages/${encodePathSegment(requiredInputString(input.id, "id"))}`;
          query.set("format", "raw");
          break;
        case "history.list":
          path = "history";
          query.set("maxResults", "25");
          query.set("startHistoryId", requiredInputString(input.historyId, "historyId"));
          break;
        default:
          throw new SyncStoreError("invalid_input", "Unsupported Gmail sync read.");
      }
      return runProviderRequest(
        { signal, label: "Gmail sync", timeoutMs: operation === "messages.get" ? 120_000 : undefined },
        async (requestSignal) => {
          const response = await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${query}`, {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: requestSignal,
            redirect: "error",
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new ProviderRequestError(response.status, `Gmail sync request returned HTTP ${response.status}.`);
          }
          return requiredResponseRecord(
            await readProviderJsonBody(response, {
              maxBytes: operation === "messages.get" ? 128 * 1024 * 1024 : 8 * 1024 * 1024,
              emptyBody: null,
              invalidJsonMessage: "Gmail returned invalid JSON.",
            }),
            "Gmail sync response",
          ) as JsonObject;
        },
      );
    },
  };
}
