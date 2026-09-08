import type { SyncReceiverStatus as SyncReceiver } from "../../src/sync/delivery-store.ts";
import type { SyncStatus } from "../../src/sync/schedule-store.ts";
import type { SyncPageProps } from "./sync-data";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Plus, Settings, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { apiDelete } from "./api";
import { DestinationForm } from "./destination-form";
import { EmptyState, FormStatus, InlineError } from "./shared-ui";
import { useSyncResource } from "./sync-data";
import { ConfirmSyncAction } from "./sync-forms";
import { SyncBadge, SyncPageFrame, SyncTime } from "./sync-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function DestinationsPage(props: SyncPageProps): ReactNode {
  const t = useTranslate();
  const resource = useSyncResource<SyncStatus>("/api/sync/status", props);
  const [editing, setEditing] = useState<SyncReceiver | "new">();
  const [removing, setRemoving] = useState<SyncReceiver>();
  return (
    <SyncPageFrame
      resource={resource}
      description={t("destinations.description")}
      actions={
        <Button size="sm" disabled={!resource.value} onClick={() => setEditing("new")}>
          <Plus size={14} />
          {t("destinations.add")}
        </Button>
      }
    >
      {!resource.value?.schedulerRunning ? <FormStatus message={t("syncs.schedulerStopped")} /> : null}
      {!resource.value?.receivers.length ? (
        <EmptyState
          title={t("syncs.noDestinationsTitle")}
          description={t("destinations.emptyDescription")}
          icon={<Webhook size={20} />}
        />
      ) : (
        <div className="syncs-destinations">
          {resource.value.receivers.map((receiver) => (
            <Card key={receiver.id} className="syncs-destination">
              <div className="section-heading-row">
                <strong>
                  <Webhook size={18} />
                  {receiver.id}
                </strong>
                <div className="button-row">
                  <SyncBadge state={!receiver.enabled ? "paused" : receiver.lastError ? "retrying" : "enabled"} />
                  <Button variant="outline" size="sm" onClick={() => setEditing(receiver)}>
                    <Settings size={14} />
                    {t("syncs.manage.edit")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(receiver)}>
                    <Trash2 size={14} />
                    {t("syncs.manage.remove")}
                  </Button>
                </div>
              </div>
              <p className="syncs-url mono">{receiver.url}</p>
              <p className="syncs-secondary">{t("syncs.allSources")}</p>
              <dl className="syncs-details">
                <div>
                  <dt>{t("syncs.delivered")}</dt>
                  <dd>{receiver.deliveredRecords.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>{t("syncs.pending")}</dt>
                  <dd>{receiver.pendingRecords.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>{t("syncs.lastDelivery")}</dt>
                  <dd>
                    <SyncTime value={receiver.lastDeliveredAt} empty={t("syncs.never")} />
                  </dd>
                </div>
                <div>
                  <dt>{t("syncs.nextAttempt")}</dt>
                  <dd>
                    {!receiver.enabled ? (
                      t("syncs.states.paused")
                    ) : !resource.value?.schedulerRunning ? (
                      t("syncs.stopped")
                    ) : !receiver.pendingRecords ? (
                      "—"
                    ) : receiver.nextAttemptAt ? (
                      <SyncTime value={receiver.nextAttemptAt} />
                    ) : (
                      t("syncs.queued")
                    )}
                  </dd>
                </div>
              </dl>
              {receiver.lastError ? (
                <InlineError
                  message={`${receiver.lastError} · ${t("syncs.attempts", { count: receiver.attemptCount })}`}
                />
              ) : null}
            </Card>
          ))}
        </div>
      )}
      <p className="syncs-footnote">{t("destinations.newRecordsHint")}</p>
      {editing ? (
        <DestinationForm
          receiver={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            resource.refresh();
          }}
          onAuthExpired={props.onAuthExpired}
        />
      ) : null}
      {removing ? (
        <ConfirmSyncAction
          title={t("destinations.remove")}
          description={t("destinations.removeDescription", { count: removing.pendingRecords })}
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            try {
              await apiDelete(`/api/sync/receivers/${encodeURIComponent(removing.id)}`);
              resource.refresh();
            } catch (error) {
              resource.reportError(error);
            } finally {
              setRemoving(undefined);
            }
          }}
        />
      ) : null}
    </SyncPageFrame>
  );
}
