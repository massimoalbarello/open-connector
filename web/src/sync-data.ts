import type { ConnectionRecord, ProviderDefinition } from "./model";

import { useTranslate } from "@embra/i18n/react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet } from "./api";

export interface SyncPageProps {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  onAuthExpired(): void;
}

export interface SyncResource<T> {
  value?: T;
  error?: string;
  loading: boolean;
  unavailable: boolean;
  updatedAt?: string;
  refresh(): void;
  reportError(error: unknown): void;
}

/** Keep the last snapshot during transient errors; mutations refresh the same resource. */
export function useSyncResource<T>(path: string, props: SyncPageProps): SyncResource<T> {
  const t = useTranslate();
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [revision, setRevision] = useState(0);
  const onAuthExpired = useRef(props.onAuthExpired);
  onAuthExpired.current = props.onAuthExpired;
  useEffect(() => {
    setValue(undefined);
    setUpdatedAt(undefined);
  }, [path]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load(): Promise<void> {
      setLoading(true);
      let retry = true;
      try {
        const result = await apiGet<T>(path);
        if (cancelled) return;
        setValue(result);
        setUnavailable(false);
        setError(undefined);
        setUpdatedAt(new Date().toISOString());
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setValue(undefined);
          retry = false;
          onAuthExpired.current();
        } else if (caught instanceof ApiError && caught.status === 404) {
          setValue(undefined);
          setError(undefined);
          setUnavailable(true);
          retry = false;
        } else setError(caught instanceof Error ? caught.message : t("syncs.loadFailed"));
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
  }, [path, revision, props.connections, t]);
  return {
    value,
    error,
    loading,
    unavailable,
    updatedAt,
    refresh: () => setRevision((previous) => previous + 1),
    reportError: (caught) => {
      if (caught instanceof ApiError && caught.status === 401) onAuthExpired.current();
      else setError(caught instanceof Error ? caught.message : t("syncs.loadFailed"));
    },
  };
}
