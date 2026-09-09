import type { SyncDestination } from "../../src/sync/delivery-store.ts";
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
  destination?: SyncDestination;
  onClose(): void;
  onSaved(): void;
  onAuthExpired(): void;
}

export function DestinationForm(props: DestinationFormProps): ReactNode {
  const t = useTranslate();
  const [url, setUrl] = useState(props.destination?.url ?? "");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(props.destination?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const path = "/api/sync/destination";
      if (props.destination) await apiPatch(path, { url: url.trim(), bearerToken: token.trim() || undefined, enabled });
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
          <DialogTitle>{t(props.destination ? "destinations.edit" : "destinations.add")}</DialogTitle>
          <DialogDescription>{t("destinations.formDescription")}</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
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
              required: !props.destination,
              description: props.destination ? t("destinations.keepToken") : t("destinations.tokenHint"),
            }}
            value={token}
            onChange={setToken}
          />
          <Label className="syncs-checkbox">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t("destinations.enabled")}
          </Label>
          <p className="syncs-footnote">{t("destinations.disabledHint")}</p>
          {props.destination ? <p className="syncs-footnote">{t("destinations.updateHint")}</p> : null}
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
