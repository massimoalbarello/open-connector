import type { SyncPageProps } from "./sync-data";
import type { SyncStatus } from "./sync-model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ArrowLeft, Loader2, Play, Settings, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiDelete, apiPatch, apiPost } from "./api";
import { EmptyState, FormStatus, InlineError } from "./shared-ui";
import { useSyncResource } from "./sync-data";
import { ConfirmSyncAction, SyncForm } from "./sync-forms";
import { syncCanPoll, syncHealth } from "./sync-model";
import { DeliveryStatus, RecentIterations, SyncBadge, SyncMetric, SyncPageFrame, SyncTime } from "./sync-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function SyncDetailPage(props: SyncPageProps): ReactNode {
  const t = useTranslate();
  const { installationId, definitionId } = useParams();
  const navigate = useNavigate();
  const resource = useSyncResource<SyncStatus>(
    installationId ? `/api/sync/installations/${encodeURIComponent(installationId)}/status` : "/api/sync/status",
    props,
  );
  const sync = resource.value?.installations.find((item) => item.id === installationId);
  const definition = resource.value?.definitions?.find((item) => item.id === (sync?.definitionId ?? definitionId));
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [working, setWorking] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function change(action: string, work: () => Promise<unknown>): Promise<void> {
    setWorking(action);
    setNotice(undefined);
    try {
      await work();
      resource.refresh();
      if (action === "run") setNotice(t("syncs.manage.runQueued"));
    } catch (error) {
      resource.reportError(error);
    } finally {
      setWorking(undefined);
    }
  }

  return (
    <SyncPageFrame
      resource={resource}
      description={t("syncs.manage.detailDescription")}
      unavailableDescription={installationId ? t("syncs.manage.noMatchingSyncs") : undefined}
      actions={
        <Link className="syncs-back" to="/syncs">
          <ArrowLeft size={15} />
          {t("syncs.manage.allSyncs")}
        </Link>
      }
    >
      {!sync && !definition ? (
        <EmptyState title={t("syncs.manage.unavailable")} description={t("syncs.manage.noMatchingSyncs")} />
      ) : (
        <>
          <div className="syncs-detail-heading">
            <div>
              <h2>{sync?.definitionId ?? definition?.id}</h2>
              <p className="syncs-secondary">{sync?.connectionName ?? definition?.provider}</p>
            </div>
            <div className="button-row">
              {sync ? (
                <>
                  <SyncBadge state={syncHealth(sync)} />
                  {sync.state === "enabled" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(working)}
                      onClick={() =>
                        void change("stop", () =>
                          apiPatch(`/api/sync/installations/${encodeURIComponent(sync.id)}`, { enabled: false }),
                        )
                      }
                    >
                      <Square size={14} />
                      {t("syncs.manage.stop")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={
                        Boolean(working) ||
                        sync.requiresBackfill ||
                        sync.connectionStatus === "missing" ||
                        !resource.value?.schedulerRunning
                      }
                      onClick={() =>
                        void change("resume", () =>
                          apiPatch(`/api/sync/installations/${encodeURIComponent(sync.id)}`, { enabled: true }),
                        )
                      }
                    >
                      <Play size={14} />
                      {t(sync.latestRun ? "syncs.manage.resume" : "syncs.manage.start")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={
                      Boolean(working) ||
                      !syncCanPoll(sync) ||
                      sync.latestRun?.state === "running" ||
                      !resource.value?.schedulerRunning
                    }
                    onClick={() =>
                      void change("run", () =>
                        apiPost(`/api/sync/installations/${encodeURIComponent(sync.id)}/run`, {}),
                      )
                    }
                  >
                    {working === "run" ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                    {t("syncs.manage.runNow")}
                  </Button>
                  <Button variant="outline" size="sm" disabled={Boolean(working)} onClick={() => setEditing(true)}>
                    <Settings size={14} />
                    {t("syncs.manage.edit")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={Boolean(working)} onClick={() => setRemoving(true)}>
                    <Trash2 size={14} />
                    {t("syncs.manage.remove")}
                  </Button>
                </>
              ) : (
                <Button onClick={() => setEditing(true)}>
                  <Play size={14} />
                  {t("syncs.manage.start")}
                </Button>
              )}
            </div>
          </div>
          {!resource.value?.schedulerRunning ? <FormStatus message={t("syncs.schedulerStopped")} /> : null}
          {notice ? <FormStatus message={notice} /> : null}
          {sync ? (
            <>
              <p className="syncs-secondary">{t("syncs.manage.stopHint")}</p>
              <div className="syncs-metrics syncs-metrics-three">
                <SyncMetric label={t("syncs.syncedRecords")} value={sync.recordCount} hint={t("syncs.uniqueRecords")} />
                <SyncMetric label={t("syncs.delivered")} value={sync.deliveredCount} hint={t("syncs.acknowledged")} />
                <SyncMetric label={t("syncs.pending")} value={sync.pendingCount} hint={t("syncs.awaitingAck")} />
              </div>
              <Card className="syncs-detail-card">
                <dl className="syncs-details">
                  <div>
                    <dt>{t("syncs.interval")}</dt>
                    <dd>
                      {t("syncs.everySeconds", { count: sync.scheduleSeconds ?? definition?.scheduleSeconds ?? 900 })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("syncs.nextPoll")}</dt>
                    <dd>
                      {!syncCanPoll(sync) ? (
                        t("syncs.notScheduled")
                      ) : !resource.value?.schedulerRunning ? (
                        t("syncs.stopped")
                      ) : sync.latestRun?.state === "running" ? (
                        t("syncs.afterCurrent")
                      ) : (
                        <SyncTime value={sync.nextDueAt} />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("syncs.lastSuccess")}</dt>
                    <dd>
                      <SyncTime value={sync.lastSuccessAt} empty={t("syncs.never")} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("syncs.failures")}</dt>
                    <dd>{sync.consecutiveFailures}</dd>
                  </div>
                  <div>
                    <dt>{t("syncs.manage.latestDelivery")}</dt>
                    <dd>
                      <DeliveryStatus run={sync.latestRun} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("syncs.webhookDestinations")}</dt>
                    <dd>
                      <Link to="/destinations">{t("syncs.manage.manageDestinations")}</Link>
                    </dd>
                  </div>
                </dl>
              </Card>
              {sync.connectionStatus !== "connected" ? (
                <InlineError message={t(`syncs.connection.${sync.connectionStatus}`)} />
              ) : null}
              {sync.requiresBackfill ? <InlineError message={t("syncs.backfillRequired")} /> : null}
              {sync.lastError ? <InlineError message={sync.lastError} /> : null}
              <p className="syncs-footnote">{t("syncs.countsHint")}</p>
              <RecentIterations key={sync.id} runs={resource.value?.runs ?? []} />
              <details className="syncs-config">
                <summary>{t("syncs.manage.config")}</summary>
                <pre>{JSON.stringify(sync.config, null, 2)}</pre>
                <p className="syncs-secondary">
                  {t("syncs.sourceId")}: {sync.sourceId ?? "—"}
                </p>
              </details>
            </>
          ) : (
            <EmptyState title={t("syncs.states.notConfigured")} description={t("syncs.manage.addDescription")} />
          )}
        </>
      )}
      {editing && resource.value ? (
        <SyncForm
          {...props}
          definitions={resource.value.definitions}
          installation={sync}
          definitionId={definitionId}
          onClose={() => setEditing(false)}
          onSaved={(id) => {
            setEditing(false);
            resource.refresh();
            if (id !== installationId) navigate(`/syncs/${encodeURIComponent(id)}`);
          }}
        />
      ) : null}
      {removing && sync ? (
        <ConfirmSyncAction
          title={t("syncs.manage.removeSync")}
          description={t("syncs.manage.removeSyncDescription")}
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            try {
              await apiDelete(`/api/sync/installations/${encodeURIComponent(sync.id)}`);
              navigate("/syncs");
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
