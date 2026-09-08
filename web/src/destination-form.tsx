import type { SyncReceiver } from "./sync-model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { ApiError, apiPatch, apiPut } from "./api";
import { CredentialInput } from "./credential-input";
import { InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DestinationFormProps {
  receiver?: SyncReceiver;
  onClose(): void;
  onSaved(): void;
  onAuthExpired(): void;
}

export function DestinationForm(props: DestinationFormProps): ReactNode {
  const t = useTranslate();
  const [id, setId] = useState(() => props.receiver?.id ?? `webhook-${crypto.randomUUID().slice(0, 8)}`);
  const [url, setUrl] = useState(props.receiver?.url ?? "");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(props.receiver?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const path = `/api/sync/receivers/${encodeURIComponent(id.trim())}`;
      if (props.receiver) await apiPatch(path, { url: url.trim(), bearerToken: token.trim() || undefined, enabled });
      else await apiPut(path, { url: url.trim(), bearerToken: token.trim(), enabled });
      props.onSaved();
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
          <DialogTitle>{t(props.receiver ? "destinations.edit" : "destinations.add")}</DialogTitle>
          <DialogDescription>{t("destinations.formDescription")}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <Label className="field">
            <span>{t("destinations.id")}</span>
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              readOnly={Boolean(props.receiver)}
              required
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*"
            />
          </Label>
          <Label className="field">
            <span>{t("destinations.url")}</span>
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/records"
              required
            />
          </Label>
          <CredentialInput
            field={{
              key: "token",
              inputType: "password",
              label: t("destinations.token"),
              secret: true,
              required: !props.receiver,
              description: props.receiver ? t("destinations.keepToken") : t("destinations.tokenHint"),
            }}
            value={token}
            onChange={setToken}
          />
          <Label className="syncs-checkbox">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t("destinations.enabled")}
          </Label>
          <p className="syncs-footnote">{t("destinations.disabledHint")}</p>
          {props.receiver ? <p className="syncs-footnote">{t("destinations.updateHint")}</p> : null}
          {error ? <InlineError message={error} /> : null}
          <div className="button-row">
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="spin" size={14} /> : null}
              {t("syncs.manage.save")}
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
