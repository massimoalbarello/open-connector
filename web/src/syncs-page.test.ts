import type { SyncInstallationStatus as SyncInstallation, SyncStatus } from "../../src/sync/status-store.ts";

import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DestinationOverview } from "./destinations-page";
import { createAppI18n } from "./i18n";
import { syncCanPoll, syncHealth } from "./sync-model";
import { RecentIterations } from "./sync-ui";
import { SyncsOverview } from "./syncs-page";

const installation: SyncInstallation = {
  id: "sync-1",
  definitionVersion: "1",
  credentialRevision: "credential-1",
  bindingRevision: 1,
  config: {},
  createdAt: "2026-09-08T11:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
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
    definitionVersion: "1",
    leaseOwner: "worker",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-09-08T12:00:00.000Z",
    checkpointRevision: 1,
    deleteCount: 0,
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
      configSchema: { type: "object" },
      checkpointSchema: { type: "object" },
      initialCheckpoint: {},
      kinds: [{ kind: "pull-request" }],
      requiredScopes: [],
    },
  ],
  delivery: {
    destination: { url: "https://context.example.com/records", enabled: true },
    pendingRecords: 4,
    deliveredRecords: 20,
    attemptCount: 2,
    lastError: "http_503",
    nextAttemptAt: "2026-09-08T12:16:00.000Z",
    lastDeliveredAt: "2026-09-08T12:00:05.000Z",
  },
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
  it("shows a waiting sync and retained delivery counts while no destination is configured", () => {
    const delivery = { ...status.delivery, destination: undefined };
    const html = render({ ...status, delivery });
    expect(html).toContain("Waiting for destination");
    expect(html).not.toContain('dateTime="2026-09-08T12:15:00.000Z"');
    expect(syncHealth({ ...installation, state: "disabled" }, false)).toBe("paused");
    expect(syncCanPoll(installation, false)).toBe(false);
    const destination = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n: createAppI18n("en") },
        createElement(DestinationOverview, { delivery, schedulerRunning: true, onEdit() {}, onRemove() {} }),
      ),
    );
    expect(destination).toContain("No webhook destination configured");
    expect(destination).toContain("Pending records are retained");
    expect(destination).toContain("<dd>4</dd>");
    expect(destination).toContain("<dd>20</dd>");
    expect(destination).not.toContain('dateTime="2026-09-08T12:16:00.000Z"');
  });

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
      delivery: { pendingRecords: 0, deliveredRecords: 0, attemptCount: 0 },
      bindingErrors: [
        {
          connectionId: "pending",
          credentialRevision: "credential-1",
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
            {
              ...original,
              id: "no-destination",
              delivery: { ...original.delivery, state: "waiting", nextAttemptAt: undefined },
            },
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
      "Waiting for destination",
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
      [{ requiresBackfill: true }, "waiting"],
      [{ state: "needs_attention" }, "needsAttention"],
    ] as [Partial<SyncInstallation>, string][]) {
      expect(syncHealth({ ...installation, ...patch }, true)).toBe(health);
      expect(syncCanPoll({ ...installation, ...patch }, true)).toBe(false);
    }
    expect(syncHealth({ ...installation, lastError: "http_429", consecutiveFailures: 1 }, true)).toBe("retrying");
  });
});
