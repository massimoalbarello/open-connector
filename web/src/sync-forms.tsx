import type { SyncPageProps } from "./sync-data";
import type { SyncDefinition, SyncInstallation } from "./sync-model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError, apiPatch, apiPost } from "./api";
import { InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface SyncFormProps extends SyncPageProps {
  definitions: SyncDefinition[];
  installation?: SyncInstallation;
  definitionId?: string;
  onClose(): void;
  onSaved(id: string): void;
}

export function SyncForm(props: SyncFormProps): ReactNode {
  const t = useTranslate();
  const current = props.installation;
  const [definitionId, setDefinitionId] = useState(
    current?.definitionId ?? props.definitionId ?? props.definitions[0]?.id ?? "",
  );
  const definition = props.definitions.find((item) => item.id === definitionId);
  const accounts = props.connections.filter(
    (item) => item.service === definition?.provider && item.configured !== false && !item.virtual,
  );
  const [connectionName, setConnectionName] = useState(
    current?.connectionName ?? accounts[0]?.connectionName ?? "default",
  );
  const [minutes, setMinutes] = useState(String((current?.scheduleSeconds ?? definition?.scheduleSeconds ?? 900) / 60));
  const [config, setConfig] = useState(JSON.stringify(definition?.defaultConfig ?? {}, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const scheduleSeconds = Math.round(Number(minutes) * 60);
      let id: string;
      if (current) {
        await apiPatch(`/api/sync/installations/${encodeURIComponent(current.id)}`, {
          enabled: current.state === "enabled",
          scheduleSeconds,
        });
        id = current.id;
      } else {
        const parsed: unknown = JSON.parse(config);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error(t("syncs.manage.invalidConfig"));
        const result = await apiPost<{ id: string }>("/api/sync/installations", {
          definitionId,
          connectionName,
          config: parsed,
          scheduleSeconds,
          enabled: true,
        });
        id = result.id;
      }
      props.onSaved(id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) props.onAuthExpired();
      setError(caught instanceof Error ? caught.message : t("syncs.manage.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(current ? "syncs.manage.edit" : "syncs.manage.add")}</DialogTitle>
          <DialogDescription>
            {t(current ? "syncs.manage.editDescription" : "syncs.manage.addDescription")}
          </DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          {current ? (
            <p className="mono">
              {current.definitionId} · {current.connectionName}
            </p>
          ) : (
            <>
              <Label className="field">
                <span>{t("syncs.manage.definition")}</span>
                <Select
                  value={definitionId}
                  onValueChange={(id) => {
                    const selected = props.definitions.find((item) => item.id === id);
                    setDefinitionId(id);
                    setMinutes(String((selected?.scheduleSeconds ?? 900) / 60));
                    setConfig(JSON.stringify(selected?.defaultConfig ?? {}, null, 2));
                    setConnectionName(
                      props.connections.find(
                        (item) => item.service === selected?.provider && item.configured !== false && !item.virtual,
                      )?.connectionName ?? "default",
                    );
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {props.definitions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="field">
                <span>{t("syncs.manage.account")}</span>
                <Select value={connectionName} onValueChange={setConnectionName} disabled={!accounts.length}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((item) => (
                      <SelectItem
                        key={item.id ?? item.connectionName ?? "default"}
                        value={item.connectionName ?? "default"}
                      >
                        {item.connectionName ?? "default"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              {!accounts.length ? (
                <p className="syncs-footnote">
                  {t("syncs.manage.connectAccount")}{" "}
                  <Link to="/providers" onClick={props.onClose}>
                    {t("nav.providers")}
                  </Link>
                </p>
              ) : null}
            </>
          )}
          <Label className="field">
            <span>{t("syncs.manage.intervalMinutes")}</span>
            <Input
              type="number"
              min={1}
              max={1440}
              step="any"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              required
            />
          </Label>
          {!current ? (
            <details>
              <summary>{t("syncs.manage.config")}</summary>
              <Label className="field">
                <span className="sr-only">{t("syncs.manage.config")}</span>
                <Textarea
                  value={config}
                  onChange={(event) => setConfig(event.target.value)}
                  className="min-h-28 font-mono text-xs"
                  spellCheck={false}
                />
              </Label>
            </details>
          ) : null}
          {error ? <InlineError message={error} /> : null}
          <div className="button-row">
            <Button type="submit" disabled={saving || !definition || (!current && !accounts.length)}>
              {saving ? <Loader2 className="spin" size={14} /> : null}
              {t(current ? "syncs.manage.save" : "syncs.manage.start")}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              {t("common.close")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmSyncActionProps {
  title: string;
  description: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function ConfirmSyncAction(props: ConfirmSyncActionProps): ReactNode {
  const t = useTranslate();
  const [working, setWorking] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="button-row">
          <Button
            variant="destructive"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await props.onConfirm();
              } finally {
                setWorking(false);
              }
            }}
          >
            {working ? <Loader2 className="spin" size={14} /> : null}
            {t("syncs.manage.remove")}
          </Button>
          <Button variant="outline" disabled={working} onClick={props.onClose}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
