import type { ProviderDefinition } from "./model";
import type { SyncPageProps } from "./sync-data";
import type { SyncStatus } from "./sync-model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { EmptyState, FormStatus, ProviderIcon } from "./shared-ui";
import { useSyncResource } from "./sync-data";
import { SyncForm } from "./sync-forms";
import { syncCanPoll, syncHealth } from "./sync-model";
import { DeliveryStatus, SyncBadge, SyncPageFrame, SyncTime } from "./sync-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function SyncsPage(props: SyncPageProps): ReactNode {
  const t = useTranslate();
  const resource = useSyncResource<SyncStatus>("/api/sync/status", props);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  return (
    <SyncPageFrame
      resource={resource}
      description={t("syncs.manage.overviewDescription")}
      actions={
        <Button size="sm" disabled={!resource.value?.definitions?.length} onClick={() => setAdding(true)}>
          <Plus size={14} />
          {t("syncs.manage.add")}
        </Button>
      }
    >
      {resource.value ? <SyncsOverview status={resource.value} providers={props.providers} /> : null}
      {adding && resource.value ? (
        <SyncForm
          {...props}
          definitions={resource.value.definitions}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            resource.refresh();
            navigate(`/syncs/${encodeURIComponent(id)}`);
          }}
        />
      ) : null}
    </SyncPageFrame>
  );
}

export function SyncsOverview({
  status,
  providers,
}: {
  status: SyncStatus;
  providers: ProviderDefinition[];
}): ReactNode {
  const t = useTranslate();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(25);
  const query = search.toLowerCase().trim();
  const syncs = status.installations.filter((item) =>
    `${item.definitionId} ${item.provider} ${item.connectionName ?? ""}`.toLowerCase().includes(query),
  );
  const available = (status.definitions ?? []).filter(
    (item) =>
      !status.installations.some((sync) => sync.definitionId === item.id) &&
      `${item.id} ${item.provider}`.toLowerCase().includes(query),
  );
  const total = syncs.length + available.length;
  return (
    <>
      {!status.schedulerRunning ? <FormStatus message={t("syncs.schedulerStopped")} /> : null}
      <div className="syncs-table-toolbar">
        <LabelledSearch
          value={search}
          onChange={(value) => {
            setSearch(value);
            setLimit(25);
          }}
        />
        <span className="syncs-secondary">{t("common.showing", { shown: Math.min(limit, total), total })}</span>
        <Link to="/destinations">{t("syncs.manage.manageDestinations")}</Link>
      </div>
      <div className="table-panel">
        {!total ? (
          <EmptyState title={t("syncs.noSyncsTitle")} description={t("syncs.manage.noMatchingSyncs")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("syncs.sync")}</TableHead>
                <TableHead>{t("syncs.status")}</TableHead>
                <TableHead>{t("syncs.lastIteration")}</TableHead>
                <TableHead>{t("syncs.nextPoll")}</TableHead>
                <TableHead className="syncs-number">{t("syncs.records")}</TableHead>
                <TableHead>{t("syncs.manage.latestDelivery")}</TableHead>
                <TableHead className="syncs-number">{t("syncs.pending")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {syncs.slice(0, limit).map((sync) => {
                const provider = providers.find((item) => item.service === sync.provider);
                const path = `/syncs/${encodeURIComponent(sync.id)}`;
                return (
                  <TableRow key={sync.id} className="syncs-clickable-row" onClick={() => navigate(path)}>
                    <TableCell>
                      <Link className="syncs-name" to={path} onClick={(event) => event.stopPropagation()}>
                        {provider ? <ProviderIcon provider={provider} /> : <RefreshCw size={18} />}
                        <span>
                          <strong>{sync.definitionId}</strong>
                          <small>{sync.connectionName ?? sync.provider}</small>
                        </span>
                      </Link>
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
                      {!syncCanPoll(sync) ? (
                        t("syncs.notScheduled")
                      ) : !status.schedulerRunning ? (
                        t("syncs.stopped")
                      ) : sync.latestRun?.state === "running" ? (
                        t("syncs.afterCurrent")
                      ) : (
                        <SyncTime value={sync.nextDueAt} />
                      )}
                    </TableCell>
                    <TableCell className="syncs-number">{sync.recordCount.toLocaleString()}</TableCell>
                    <TableCell>
                      <DeliveryStatus run={sync.latestRun} compact />
                    </TableCell>
                    <TableCell className="syncs-number">{sync.pendingCount.toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
              {available.slice(0, Math.max(0, limit - syncs.length)).map((definition) => {
                const path = `/syncs/available/${encodeURIComponent(definition.id)}`;
                return (
                  <TableRow key={definition.id} className="syncs-clickable-row" onClick={() => navigate(path)}>
                    <TableCell>
                      <Link to={path} className="syncs-name" onClick={(event) => event.stopPropagation()}>
                        <RefreshCw size={18} />
                        <span>
                          <strong>{definition.id}</strong>
                          <small>{definition.provider}</small>
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <SyncBadge state="notConfigured" />
                    </TableCell>
                    <TableCell colSpan={5}>
                      <span className="syncs-secondary">{t("syncs.manage.availableHint")}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {total > limit ? (
        <div className="table-footer">
          <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + 25)}>
            {t("common.showMore")}
          </Button>
        </div>
      ) : null}
      {status.bindingErrors.length ? (
        <section>
          <h2>{t("syncs.bindingErrors")}</h2>
          {status.bindingErrors.map((item) => (
            <FormStatus
              key={`${item.connectionId}:${item.definitionId}`}
              message={`${item.definitionId} · ${item.connectionName} · ${item.errorCode}`}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}

function LabelledSearch({ value, onChange }: { value: string; onChange(value: string): void }): ReactNode {
  const t = useTranslate();
  return (
    <label className="syncs-search">
      <Search size={15} />
      <Input
        value={value}
        aria-label={t("syncs.manage.search")}
        placeholder={t("syncs.manage.search")}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
