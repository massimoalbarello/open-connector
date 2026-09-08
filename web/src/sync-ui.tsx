import type { SyncResource } from "./sync-data";
import type { SyncRun } from "../../src/sync/sync-store.ts";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface SyncPageFrameProps<T> {
  resource: SyncResource<T>;
  description: string;
  actions?: ReactNode;
  unavailableDescription?: string;
  children: ReactNode;
}

export function SyncPageFrame<T>({
  resource,
  description,
  actions,
  unavailableDescription,
  children,
}: SyncPageFrameProps<T>): ReactNode {
  const t = useTranslate();
  return (
    <div className="page-stack syncs-page">
      <div className="syncs-toolbar">
        <div>
          <p>{description}</p>
          <p className="syncs-secondary">
            {resource.updatedAt ? (
              <>
                {t("syncs.updated")} <SyncTime value={resource.updatedAt} /> ·{" "}
              </>
            ) : null}
            {t("syncs.autoRefresh")}
          </p>
        </div>
        <div className="button-row">
          {actions}
          <Button variant="outline" size="sm" disabled={resource.loading} onClick={resource.refresh}>
            {resource.loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {t("common.refresh")}
          </Button>
        </div>
      </div>
      {resource.error ? (
        <InlineError message={`${resource.error}${resource.value !== undefined ? ` ${t("syncs.stale")}` : ""}`} />
      ) : null}
      {resource.unavailable ? (
        <EmptyState
          title={t("syncs.manage.unavailable")}
          description={unavailableDescription ?? t("syncs.unavailableDescription")}
        />
      ) : resource.value !== undefined ? (
        children
      ) : resource.loading ? (
        <div className="loading-panel" role="status">
          <Loader2 size={16} className="spin" />
          {t("syncs.loading")}
        </div>
      ) : null}
    </div>
  );
}

export function SyncTime({ value, empty = "—" }: { value?: string; empty?: string }): ReactNode {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (
    empty
  ) : (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}

export function SyncBadge({ state }: { state: string }): ReactNode {
  const t = useTranslate();
  const tone = ["failed", "lease_expired", "needsAttention", "disconnected"].includes(state)
    ? "error"
    : ["retrying", "verifying", "cancelled"].includes(state)
      ? "warning"
      : ["running", "succeeded", "scheduled", "enabled", "delivered"].includes(state)
        ? "success"
        : undefined;
  return <Badge tone={tone}>{t(`syncs.states.${state}`)}</Badge>;
}

export function SyncMetric({ label, value, hint }: { label: string; value: number; hint: string }): ReactNode {
  return (
    <Card className="syncs-metric">
      <div>{label}</div>
      <strong>{value.toLocaleString()}</strong>
      <small>{hint}</small>
    </Card>
  );
}

export function DeliveryStatus({ run, compact = false }: { run?: SyncRun; compact?: boolean }): ReactNode {
  const t = useTranslate();
  if (!run) return "—";
  const delivery = run.delivery;
  if (!delivery) return <span className="syncs-secondary">{t("syncs.manage.deliveryUnavailable")}</span>;
  if (!delivery.totalRecords)
    return (
      <span className="syncs-secondary">
        {t(run.changeCount ? "syncs.manage.noDeliveryDestination" : "syncs.manage.nothingToDeliver")}
      </span>
    );
  return (
    <div className="syncs-delivery-status">
      <Badge
        tone={
          delivery.state === "delivered"
            ? "success"
            : ["retrying", "cancelled"].includes(delivery.state)
              ? "warning"
              : undefined
        }
      >
        {t(`syncs.deliveryStates.${delivery.state}`)}
      </Badge>
      <small className="syncs-secondary syncs-block">
        {t("syncs.manage.deliveryProgress", { delivered: delivery.deliveredRecords, total: delivery.totalRecords })}
      </small>
      {!compact && delivery.pendingRecords ? (
        <small className="syncs-secondary syncs-block">
          {t("syncs.manage.pendingCount", { count: delivery.pendingRecords })}
        </small>
      ) : null}
      {!compact && delivery.cancelledRecords ? (
        <small className="syncs-secondary syncs-block">
          {t("syncs.manage.cancelledCount", { count: delivery.cancelledRecords })}
        </small>
      ) : null}
      {!compact && delivery.lastError ? <small className="syncs-error syncs-block">{delivery.lastError}</small> : null}
      {!compact && delivery.pendingRecords && delivery.nextAttemptAt ? (
        <small className="syncs-secondary syncs-block">
          {t("syncs.nextAttempt")}: <SyncTime value={delivery.nextAttemptAt} />
        </small>
      ) : null}
    </div>
  );
}

export function RecentIterations({ runs }: { runs: SyncRun[] }): ReactNode {
  const t = useTranslate();
  const [limit, setLimit] = useState(10);
  return (
    <section aria-labelledby="syncs-history-title">
      <div className="section-heading-row">
        <h2 id="syncs-history-title">{t("syncs.recentIterations")}</h2>
        <span className="syncs-secondary">{t("syncs.manage.historyLimit")}</span>
      </div>
      <div className="table-panel">
        {!runs.length ? (
          <EmptyState title={t("syncs.noRunsTitle")} description={t("syncs.noRunsDescription")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("syncs.iteration")}</TableHead>
                <TableHead>{t("syncs.manage.pollingResult")}</TableHead>
                <TableHead>{t("syncs.manage.delivery")}</TableHead>
                <TableHead className="syncs-number">{t("syncs.processed")}</TableHead>
                <TableHead>{t("syncs.duration")}</TableHead>
                <TableHead>{t("syncs.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.slice(0, limit).map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <SyncTime value={run.startedAt} />
                    <small className="syncs-secondary syncs-block">{t(`syncs.reasons.${run.reason}`)}</small>
                    <small className="mono syncs-secondary syncs-block">{run.id}</small>
                  </TableCell>
                  <TableCell>
                    <SyncBadge state={run.state} />
                  </TableCell>
                  <TableCell>
                    <DeliveryStatus run={run} />
                  </TableCell>
                  <TableCell className="syncs-number">
                    {run.upsertCount.toLocaleString()}
                    <small className="syncs-secondary syncs-block">{t("syncs.pages", { count: run.pageCount })}</small>
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
                  <TableCell className="syncs-run-error">
                    {run.errorCode ? <span className="syncs-error">{run.errorCode}</span> : "—"}
                    {run.errorMessage ? (
                      <small className="syncs-secondary syncs-block">{run.errorMessage}</small>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <p className="syncs-footnote">{t("syncs.manage.iterationDeliveryHint")}</p>
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
