import type { ConnectionRecord, ProviderDefinition } from "./model";
import type { SyncInstallation, SyncReceiver, SyncRun, SyncStatus } from "./sync-model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { ChevronDown, ChevronRight, Database, Loader2, RefreshCw, Send, Timer, Webhook } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { ApiError, apiGet } from "./api";
import { Badge, EmptyState, FormStatus, InlineError, ProviderIcon } from "./shared-ui";
import { syncCanPoll, syncHealth } from "./sync-model";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface SyncsPageProps {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  onAuthExpired(): void;
}

export function SyncsPage(props: SyncsPageProps): ReactNode {
  const t = useTranslate();
  const [status, setStatus] = useState<SyncStatus>();
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load(): Promise<void> {
      setLoading(true);
      let retry = true;
      try {
        const result = await apiGet<SyncStatus>("/api/sync/status");
        if (cancelled) return;
        setStatus(result);
        setUnavailable(false);
        setError(undefined);
        setUpdatedAt(new Date().toISOString());
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setStatus(undefined);
          retry = false;
          props.onAuthExpired();
        } else if (caught instanceof ApiError && caught.status === 404) {
          setStatus(undefined);
          setError(undefined);
          setUnavailable(true);
          retry = false;
        } else {
          setError(caught instanceof Error ? caught.message : t("syncs.loadFailed"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (retry) timer = setTimeout(() => void load(), 10_000);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh, props.connections, t]);

  return (
    <div className="page-stack syncs-page">
      <div className="syncs-toolbar">
        <div>
          <p>{t("syncs.description")}</p>
          <p className="syncs-secondary">
            {updatedAt ? (
              <>
                {t("syncs.updated")} <SyncTime value={updatedAt} /> ·{" "}
              </>
            ) : null}
            {t("syncs.autoRefresh")}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          {t("common.refresh")}
        </Button>
      </div>
      {error ? (
        <InlineError message={`${t("syncs.loadFailed")} ${error}${status ? ` ${t("syncs.stale")}` : ""}`} />
      ) : null}
      {unavailable ? (
        <EmptyState
          title={t("syncs.unavailableTitle")}
          description={t("syncs.unavailableDescription")}
          icon={<RefreshCw size={20} />}
        />
      ) : status ? (
        <SyncsOverview status={status} providers={props.providers} />
      ) : loading ? (
        <div className="loading-panel" role="status">
          <Loader2 size={16} className="spin" />
          {t("syncs.loading")}
        </div>
      ) : null}
    </div>
  );
}

interface SyncsOverviewProps {
  status: SyncStatus;
  providers: ProviderDefinition[];
}

export function SyncsOverview({ status, providers }: SyncsOverviewProps): ReactNode {
  const t = useTranslate();
  const [expanded, setExpanded] = useState<string>();
  const records = status.installations.reduce((sum, item) => sum + item.recordCount, 0);
  const delivered = status.receivers.reduce((sum, item) => sum + item.deliveredRecords, 0);
  const pending = status.receivers.reduce((sum, item) => sum + item.pendingRecords, 0);
  return (
    <>
      {!status.schedulerRunning ? <FormStatus message={t("syncs.schedulerStopped")} /> : null}
      <div className="syncs-metrics">
        <SyncMetric
          label={t("syncs.syncedRecords")}
          value={records}
          hint={t("syncs.uniqueRecords")}
          icon={<Database size={16} />}
        />
        <SyncMetric
          label={t("syncs.delivered")}
          value={delivered}
          hint={t("syncs.acknowledged")}
          icon={<Send size={16} />}
        />
        <SyncMetric
          label={t("syncs.pending")}
          value={pending}
          hint={t("syncs.awaitingAck")}
          icon={<Timer size={16} />}
        />
        <SyncMetric
          label={t("syncs.destinations")}
          value={status.receivers.length}
          hint={t("syncs.enabledCount", { count: status.receivers.filter((item) => item.enabled).length })}
          icon={<Webhook size={16} />}
        />
      </div>
      <section aria-labelledby="syncs-polling-title">
        <div className="section-heading-row">
          <h2 id="syncs-polling-title">{t("syncs.polling")}</h2>
          <Badge tone={status.acquisitionRunning ? "success" : undefined}>
            {t(status.acquisitionRunning ? "syncs.states.running" : "syncs.acquisitionIdle")}
          </Badge>
        </div>
        <div className="table-panel">
          {status.installations.length === 0 ? (
            <EmptyState title={t("syncs.noSyncsTitle")} description={t("syncs.noSyncsDescription")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("syncs.sync")}</TableHead>
                  <TableHead>{t("syncs.status")}</TableHead>
                  <TableHead>{t("syncs.lastIteration")}</TableHead>
                  <TableHead>{t("syncs.nextPoll")}</TableHead>
                  <TableHead className="syncs-number">{t("syncs.records")}</TableHead>
                  <TableHead className="syncs-number">{t("syncs.delivered")}</TableHead>
                  <TableHead className="syncs-number">{t("syncs.pending")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.installations.map((sync) => {
                  const provider = providers.find((item) => item.service === sync.provider);
                  const open = expanded === sync.id;
                  return (
                    <Fragment key={sync.id}>
                      <TableRow>
                        <TableCell>
                          <button
                            className="syncs-name"
                            onClick={() => setExpanded(open ? undefined : sync.id)}
                            aria-expanded={open}
                            aria-controls={`sync-details-${sync.id}`}
                          >
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            {provider ? <ProviderIcon provider={provider} /> : <RefreshCw size={18} />}
                            <span>
                              <strong>{sync.definitionId}</strong>
                              <small>
                                {provider?.displayName ?? sync.provider} · {sync.connectionName ?? sync.connectionId}
                              </small>
                            </span>
                          </button>
                        </TableCell>
                        <TableCell>
                          <SyncBadge state={syncHealth(sync)} />
                        </TableCell>
                        <TableCell>
                          <SyncTime value={sync.latestRun?.startedAt} empty={t("syncs.never")} />
                          {sync.latestRun ? (
                            <small className="syncs-secondary syncs-block">
                              {t(`syncs.states.${sync.latestRun.state}`)}
                            </small>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <NextPoll sync={sync} schedulerRunning={status.schedulerRunning} />
                        </TableCell>
                        <TableCell className="syncs-number">{sync.recordCount.toLocaleString()}</TableCell>
                        <TableCell className="syncs-number">{sync.deliveredCount.toLocaleString()}</TableCell>
                        <TableCell className="syncs-number">
                          {sync.pendingCount > 0 ? (
                            <Badge tone="warning">{sync.pendingCount.toLocaleString()}</Badge>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                      </TableRow>
                      {open ? (
                        <TableRow>
                          <TableCell colSpan={7} className="syncs-expanded">
                            <div id={`sync-details-${sync.id}`}>
                              <dl className="syncs-details">
                                <div>
                                  <dt>{t("syncs.lastSuccess")}</dt>
                                  <dd>
                                    <SyncTime value={sync.lastSuccessAt} empty={t("syncs.never")} />
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("syncs.interval")}</dt>
                                  <dd>
                                    {sync.scheduleSeconds
                                      ? t("syncs.everySeconds", { count: sync.scheduleSeconds })
                                      : "—"}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("syncs.failures")}</dt>
                                  <dd>{sync.consecutiveFailures}</dd>
                                </div>
                                <div>
                                  <dt>{t("syncs.sourceId")}</dt>
                                  <dd className="mono">{sync.sourceId ?? "—"}</dd>
                                </div>
                              </dl>
                              {sync.requiresBackfill ? <FormStatus message={t("syncs.backfillRequired")} /> : null}
                              {sync.connectionStatus !== "connected" ? (
                                <FormStatus message={t(`syncs.connection.${sync.connectionStatus}`)} />
                              ) : null}
                              {sync.lastError ? <InlineError message={sync.lastError} /> : null}
                              {sync.latestRun?.errorMessage ? (
                                <p className="syncs-error">{sync.latestRun.errorMessage}</p>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        <p className="syncs-footnote">{t("syncs.countsHint")}</p>
      </section>
      {status.bindingErrors.length > 0 ? (
        <section aria-labelledby="syncs-binding-title">
          <div className="section-heading-row">
            <h2 id="syncs-binding-title">{t("syncs.bindingErrors")}</h2>
          </div>
          {status.bindingErrors.map((error) => (
            <Card className="syncs-binding" key={`${error.connectionId}/${error.definitionId}`}>
              <strong>
                {error.definitionId} · {error.connectionName}
              </strong>
              <p className="syncs-error">{error.errorCode}</p>
              <p className="syncs-secondary">
                {t("syncs.nextAttempt")}:{" "}
                {status.schedulerRunning ? <SyncTime value={error.nextAttemptAt} /> : t("syncs.stopped")}
              </p>
            </Card>
          ))}
        </section>
      ) : null}
      <section aria-labelledby="syncs-destinations-title">
        <div className="section-heading-row">
          <h2 id="syncs-destinations-title">{t("syncs.webhookDestinations")}</h2>
          <span className="syncs-secondary">{t("syncs.allSources")}</span>
        </div>
        {status.receivers.length === 0 ? (
          <EmptyState
            title={t("syncs.noDestinationsTitle")}
            description={t("syncs.noDestinationsDescription")}
            icon={<Webhook size={20} />}
          />
        ) : (
          <div className="syncs-destinations">
            {status.receivers.map((receiver) => (
              <Destination key={receiver.id} receiver={receiver} schedulerRunning={status.schedulerRunning} />
            ))}
          </div>
        )}
      </section>
      <RecentIterations runs={status.runs} installations={status.installations} />
    </>
  );
}

interface SyncMetricProps {
  label: string;
  value: number;
  hint: string;
  icon: ReactNode;
}

function SyncMetric(props: SyncMetricProps): ReactNode {
  return (
    <Card className="syncs-metric">
      <div>
        {props.icon}
        <span>{props.label}</span>
      </div>
      <strong>{props.value.toLocaleString()}</strong>
      <small>{props.hint}</small>
    </Card>
  );
}

function SyncTime({ value, empty = "—" }: { value?: string; empty?: string }): ReactNode {
  if (!value) return empty;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}

function SyncBadge({ state }: { state: string }): ReactNode {
  const t = useTranslate();
  const tone = ["failed", "lease_expired", "needsAttention", "disconnected"].includes(state)
    ? "error"
    : ["retrying", "verifying", "waiting"].includes(state)
      ? "warning"
      : ["running", "succeeded", "scheduled", "enabled"].includes(state)
        ? "success"
        : undefined;
  return <Badge tone={tone}>{t(`syncs.states.${state}`)}</Badge>;
}

function NextPoll({ sync, schedulerRunning }: { sync: SyncInstallation; schedulerRunning: boolean }): ReactNode {
  const t = useTranslate();
  if (!syncCanPoll(sync)) return <span className="syncs-secondary">{t("syncs.notScheduled")}</span>;
  if (sync.latestRun?.state === "running") return <span className="syncs-secondary">{t("syncs.afterCurrent")}</span>;
  if (!schedulerRunning) return <span className="syncs-secondary">{t("syncs.stopped")}</span>;
  return (
    <>
      <SyncTime value={sync.nextDueAt} />
      {sync.nextDueAt && Date.parse(sync.nextDueAt) <= Date.now() ? (
        <small className="syncs-secondary syncs-block">{t("syncs.due")}</small>
      ) : null}
    </>
  );
}

function Destination({ receiver, schedulerRunning }: { receiver: SyncReceiver; schedulerRunning: boolean }): ReactNode {
  const t = useTranslate();
  return (
    <Card className="syncs-destination">
      <div className="section-heading-row">
        <strong>
          <Webhook size={16} />
          {receiver.id}
        </strong>
        <SyncBadge state={!receiver.enabled ? "paused" : receiver.lastError ? "retrying" : "enabled"} />
      </div>
      <p className="syncs-url mono">{receiver.url}</p>
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
            ) : !schedulerRunning ? (
              t("syncs.stopped")
            ) : receiver.pendingRecords === 0 ? (
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
        <InlineError message={`${receiver.lastError} · ${t("syncs.attempts", { count: receiver.attemptCount })}`} />
      ) : null}
    </Card>
  );
}

function RecentIterations({ runs, installations }: { runs: SyncRun[]; installations: SyncInstallation[] }): ReactNode {
  const t = useTranslate();
  const [limit, setLimit] = useState(10);
  return (
    <section aria-labelledby="syncs-history-title">
      <div className="section-heading-row">
        <h2 id="syncs-history-title">{t("syncs.recentIterations")}</h2>
        <span className="syncs-secondary">{t("syncs.historyLimit")}</span>
      </div>
      <div className="table-panel">
        {runs.length === 0 ? (
          <EmptyState title={t("syncs.noRunsTitle")} description={t("syncs.noRunsDescription")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("syncs.iteration")}</TableHead>
                <TableHead>{t("syncs.status")}</TableHead>
                <TableHead>{t("syncs.started")}</TableHead>
                <TableHead>{t("syncs.duration")}</TableHead>
                <TableHead className="syncs-number">{t("syncs.processed")}</TableHead>
                <TableHead className="syncs-number">{t("syncs.changes")}</TableHead>
                <TableHead>{t("syncs.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.slice(0, limit).map((run) => {
                const sync = installations.find((item) => item.id === run.installationId);
                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <strong>{sync?.definitionId ?? run.installationId}</strong>
                      <small className="syncs-secondary syncs-block">
                        {sync?.connectionName} · {t(`syncs.reasons.${run.reason}`)}
                      </small>
                      <span className="syncs-secondary mono syncs-block" title={run.id}>
                        {run.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <SyncBadge state={run.state} />
                    </TableCell>
                    <TableCell>
                      <SyncTime value={run.startedAt} />
                    </TableCell>
                    <TableCell>
                      {run.completedAt
                        ? t("syncs.seconds", {
                            count: Math.max(
                              0,
                              (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000,
                            ).toLocaleString(undefined, { maximumFractionDigits: 1 }),
                          })
                        : "—"}
                    </TableCell>
                    <TableCell className="syncs-number">
                      {run.upsertCount.toLocaleString()}
                      <small className="syncs-secondary syncs-block">
                        {t("syncs.pages", { count: run.pageCount })}
                      </small>
                    </TableCell>
                    <TableCell className="syncs-number">{run.changeCount.toLocaleString()}</TableCell>
                    <TableCell className="syncs-run-error">
                      {run.errorCode ? <span className="syncs-error">{run.errorCode}</span> : "—"}
                      {run.errorMessage ? (
                        <small className="syncs-secondary syncs-block">{run.errorMessage}</small>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {runs.length > limit ? (
        <div className="table-footer">
          <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + 20)}>
            {t("common.showMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
