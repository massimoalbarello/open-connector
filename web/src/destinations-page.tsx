import type { SyncDeliveryStatus, SyncDestination } from "../../src/sync/delivery-store.ts";
import type { SyncStatus } from "../../src/sync/status-store.ts";
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
  const [editing, setEditing] = useState<SyncDestination | "new">();
  const [removing, setRemoving] = useState(false);
  const delivery = resource.value?.delivery;
  return (
    <SyncPageFrame
      resource={resource}
      description={t("destinations.description")}
      actions={
        !delivery?.destination ? (
          <Button size="sm" disabled={!delivery} onClick={() => setEditing("new")}>
            <Plus size={14} />
            {t("destinations.add")}
          </Button>
        ) : undefined
      }
    >
      {delivery ? (
        <DestinationOverview
          delivery={delivery}
          schedulerRunning={resource.value!.schedulerRunning}
          onEdit={() => setEditing(delivery.destination!)}
          onRemove={() => setRemoving(true)}
        />
      ) : null}
      {editing ? (
        <DestinationForm
          destination={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            resource.refresh();
          }}
          onAuthExpired={props.onAuthExpired}
        />
      ) : null}
      {removing && delivery ? (
        <ConfirmSyncAction
          title={t("destinations.remove")}
          description={t("destinations.removeDescription", { count: delivery.pendingRecords })}
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            try {
              await apiDelete("/api/sync/destination");
              resource.refresh();
            } catch (error) {
              resource.reportError(error);
            } finally {
              setRemoving(false);
            }
          }}
        />
      ) : null}
    </SyncPageFrame>
  );
}

interface DestinationOverviewProps {
  delivery: SyncDeliveryStatus;
  schedulerRunning: boolean;
  onEdit(): void;
  onRemove(): void;
}

export function DestinationOverview({
  delivery,
  schedulerRunning,
  onEdit,
  onRemove,
}: DestinationOverviewProps): ReactNode {
  const t = useTranslate();
  const destination = delivery.destination;
  return (
    <>
      {!schedulerRunning ? <FormStatus message={t("syncs.schedulerStopped")} /> : null}
      {!destination?.enabled ? <FormStatus message={t("syncs.waitingDestination")} /> : null}
      <Card className="syncs-destination">
        {destination ? (
          <>
            <div className="section-heading-row">
              <strong>
                <Webhook size={18} />
                {t("syncs.webhookDestinations")}
              </strong>
              <div className="button-row">
                <SyncBadge state={!destination.enabled ? "paused" : delivery.lastError ? "retrying" : "enabled"} />
                <Button variant="outline" size="sm" onClick={onEdit}>
                  <Settings size={14} />
                  {t("syncs.manage.edit")}
                </Button>
                <Button variant="ghost" size="sm" onClick={onRemove}>
                  <Trash2 size={14} />
                  {t("syncs.manage.remove")}
                </Button>
              </div>
            </div>
            <p className="syncs-url mono">{destination.url}</p>
          </>
        ) : (
          <EmptyState
            title={t("syncs.noDestinationsTitle")}
            description={t("destinations.emptyDescription")}
            icon={<Webhook size={20} />}
          />
        )}
        <dl className="syncs-details">
          <div>
            <dt>{t("syncs.delivered")}</dt>
            <dd>{delivery.deliveredRecords.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t("syncs.pending")}</dt>
            <dd>{delivery.pendingRecords.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t("syncs.lastDelivery")}</dt>
            <dd>
              <SyncTime value={delivery.lastDeliveredAt} empty={t("syncs.never")} />
            </dd>
          </div>
          <div>
            <dt>{t("syncs.nextAttempt")}</dt>
            <dd>
              {!destination?.enabled ? (
                t("syncs.states.waitingDestination")
              ) : !schedulerRunning ? (
                t("syncs.stopped")
              ) : !delivery.pendingRecords ? (
                "—"
              ) : delivery.nextAttemptAt ? (
                <SyncTime value={delivery.nextAttemptAt} />
              ) : (
                t("syncs.queued")
              )}
            </dd>
          </div>
        </dl>
        {delivery.lastError ? (
          <InlineError message={`${delivery.lastError} · ${t("syncs.attempts", { count: delivery.attemptCount })}`} />
        ) : null}
      </Card>
      <p className="syncs-footnote">{t("destinations.retentionHint")}</p>
    </>
  );
}
