import type { SyncInstallation, SyncStatus } from "./sync-model";

import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createAppI18n } from "./i18n";
import { syncCanPoll, syncHealth } from "./sync-model";
import { RecentIterations } from "./sync-ui";
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
  config: {},
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
    delivery: {
      state: "retrying",
      totalRecords: 3,
      deliveredRecords: 1,
      pendingRecords: 2,
      cancelledRecords: 0,
      lastError: "http_503",
    },
  },
};
const status: SyncStatus = {
  acquisitionRunning: false,
  schedulerRunning: true,
  installations: [installation],
  runs: [installation.latestRun!],
  bindingErrors: [],
  definitions: [
    {
      id: "github.pull-requests",
      provider: "github",
      version: "1",
      scheduleSeconds: 900,
      defaultConfig: {},
      requiredScopes: [],
    },
  ],
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
      createElement(MemoryRouter, {}, createElement(SyncsOverview, { status: value, providers: [] })),
    ),
  );
}

describe("sync monitoring", () => {
  it("shows a compact table linking sync details and destinations", () => {
    const html = render(status);
    for (const text of ["github.pull-requests", "personal", "Latest iteration delivery", "1 of 3 delivered"])
      expect(html).toContain(text);
    expect(html).toContain('href="/syncs/sync-1"');
    expect(html).toContain('href="/destinations"');
    expect(html).toContain('dateTime="2026-09-08T12:15:00.000Z"');
    expect(html).not.toContain("context.example.com");
    expect(html).not.toContain("Recent iterations");
  });

  it("offers available definitions before an installation exists and shows verification failures", () => {
    const html = render({
      ...status,
      installations: [],
      runs: [],
      receivers: [],
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
    expect(html).toContain('href="/syncs/available/github.pull-requests"');
    expect(html).toContain("Not configured");
    expect(html).toContain("source_verification_failed");
  });

  it("shows failed polling independently of delivery and distinguishes no changes from missing destinations", () => {
    const original = installation.latestRun!;
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n: createAppI18n("en") },
        createElement(RecentIterations, {
          runs: [
            {
              ...original,
              id: "failed-poll",
              state: "failed",
              errorCode: "acquisition_failed",
              errorMessage: "Committed progress is retained.",
            },
            {
              ...original,
              id: "delivered-poll",
              delivery: {
                ...original.delivery,
                state: "delivered",
                deliveredRecords: 3,
                pendingRecords: 0,
                lastError: undefined,
              },
            },
            { ...original, id: "no-destination", delivery: { ...original.delivery, totalRecords: 0 } },
            { ...original, id: "no-changes", changeCount: 0, delivery: { ...original.delivery, totalRecords: 0 } },
          ],
        }),
      ),
    );
    for (const text of [
      "failed-poll",
      "Failed",
      "acquisition_failed",
      "Committed progress is retained.",
      "Retrying",
      "http_503",
      "3 of 3 delivered",
      "Succeeded",
      "No destination when acquired",
      "Nothing to deliver",
    ])
      expect(html).toContain(text);
  });

  it("does not promise scheduled polling when disabled or stopped", () => {
    const html = render({ ...status, schedulerRunning: false });
    expect(html).toContain("Automatic polling and delivery are stopped");
    expect(html).not.toContain('dateTime="2026-09-08T12:15:00.000Z"');
    const paused = render({ ...status, installations: [{ ...installation, state: "disabled" }] });
    expect(paused).toContain("Not scheduled");
    expect(paused).toContain("Paused");
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
