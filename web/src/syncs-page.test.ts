import type { SyncInstallation, SyncStatus } from "./sync-model";

import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAppI18n } from "./i18n";
import { syncCanPoll, syncHealth } from "./sync-model";
import { SyncsOverview } from "./syncs-page";

const installation: SyncInstallation = {
  id: "sync-1",
  definitionId: "github.pull-requests",
  provider: "github",
  sourceId: "source-1",
  connectionId: "connection-1",
  connectionName: "personal",
  connectionStatus: "connected",
  state: "enabled",
  scheduleSeconds: 900,
  nextDueAt: "2026-09-08T12:15:00.000Z",
  lastSuccessAt: "2026-09-08T12:00:00.000Z",
  consecutiveFailures: 0,
  requiresBackfill: false,
  recordCount: 12,
  deliveredCount: 20,
  pendingCount: 4,
  latestRun: {
    id: "run-1",
    installationId: "sync-1",
    reason: "schedule",
    state: "succeeded",
    startedAt: "2026-09-08T11:59:00.000Z",
    completedAt: "2026-09-08T12:00:00.000Z",
    pageCount: 2,
    upsertCount: 12,
    changeCount: 3,
  },
};
const status: SyncStatus = {
  acquisitionRunning: false,
  schedulerRunning: true,
  installations: [installation],
  runs: [installation.latestRun!],
  bindingErrors: [],
  receivers: [
    {
      id: "context-use",
      url: "https://context.example.com/records",
      enabled: true,
      pendingRecords: 4,
      deliveredRecords: 20,
      attemptCount: 2,
      lastError: "http_503",
      nextAttemptAt: "2026-09-08T12:16:00.000Z",
      lastDeliveredAt: "2026-09-08T12:00:05.000Z",
    },
  ],
};

function render(value: SyncStatus): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createAppI18n("en") },
      createElement(SyncsOverview, { status: value, providers: [] }),
    ),
  );
}

describe("sync monitoring", () => {
  it("shows polling and delivery separately with retry details and unambiguous counts", () => {
    const html = render(status);
    for (const text of [
      "github.pull-requests",
      "personal",
      "Synced records",
      "Delivered",
      "Pending",
      "context-use",
      "https://context.example.com/records",
      "http_503",
      "2 attempts on current batch",
      "one record can have multiple deliveries",
      "Recent iterations",
      "run-1",
    ])
      expect(html).toContain(text);
    expect(html).toContain('dateTime="2026-09-08T12:15:00.000Z"');
    expect(html).toContain('dateTime="2026-09-08T12:00:05.000Z"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows empty states and verification failures before an installation exists", () => {
    const html = render({
      ...status,
      installations: [],
      receivers: [],
      runs: [],
      bindingErrors: [
        {
          connectionId: "pending",
          connectionName: "work",
          definitionId: "github.pull-requests",
          errorCode: "source_verification_failed",
          nextAttemptAt: "2026-09-08T12:15:00.000Z",
        },
      ],
    });
    expect(html).toContain("No syncs yet");
    expect(html).toContain("No webhook destinations registered");
    expect(html).toContain("No iterations yet");
    expect(html).toContain("source_verification_failed");
    expect(html).toContain("targeted backfill");
  });

  it("shows failed iterations and their errors alongside successful iterations", () => {
    const html = render({
      ...status,
      runs: [
        {
          ...installation.latestRun!,
          id: "failed-poll",
          state: "failed",
          pageCount: 0,
          upsertCount: 0,
          changeCount: 0,
          errorCode: "acquisition_failed",
          errorMessage: "Polling failed before acquisition started; committed progress is retained.",
        },
        installation.latestRun!,
      ],
    });
    expect(html).toContain("failed-poll");
    expect(html).toContain("Failed");
    expect(html).toContain("acquisition_failed");
    expect(html).toContain("Polling failed before acquisition started; committed progress is retained.");
    expect(html).toContain("run-1");
    expect(html).toContain("Succeeded");
  });

  it("does not promise scheduled polling or delivery when disabled or stopped", () => {
    const html = render({ ...status, schedulerRunning: false });
    expect(html).toContain("Automatic polling and delivery are stopped");
    expect(html).not.toContain('dateTime="2026-09-08T12:15:00.000Z"');
    expect(html).not.toContain('dateTime="2026-09-08T12:16:00.000Z"');
    const paused = render({
      ...status,
      installations: [{ ...installation, state: "disabled" }],
      receivers: [{ ...status.receivers[0]!, enabled: false }],
    });
    expect(paused).toContain("Not scheduled");
    expect(paused).toContain("Paused");
    expect(paused).not.toContain('dateTime="2026-09-08T12:16:00.000Z"');
  });

  it("gives connection and backfill problems priority over previous success", () => {
    for (const [patch, health] of [
      [{ state: "disabled" }, "paused"],
      [{ connectionStatus: "missing" }, "disconnected"],
      [{ connectionStatus: "changed" }, "verifying"],
      [{ requiresBackfill: true }, "needsAttention"],
      [{ state: "needs_attention" }, "needsAttention"],
    ] as [Partial<SyncInstallation>, string][]) {
      expect(syncHealth({ ...installation, ...patch })).toBe(health);
      expect(syncCanPoll({ ...installation, ...patch })).toBe(false);
    }
    expect(syncHealth({ ...installation, lastError: "http_429", consecutiveFailures: 1 })).toBe("retrying");
  });
});
