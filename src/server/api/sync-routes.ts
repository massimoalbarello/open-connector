import type { SyncDeliveryWorker } from "../../sync/delivery-worker.ts";
import type { SyncStatus } from "../../sync/status-store.ts";
import type { SyncRunner } from "../../sync/sync-runner.ts";
import type { SyncScheduler } from "../../sync/sync-scheduler.ts";
import type { ISyncStore, JsonObject } from "../../sync/sync-store.ts";
import type { Context, Hono } from "hono";

import { z } from "zod";
import { ConnectionError } from "../../connection-service.ts";
import { SyncStoreError } from "../../sync/sync-store.ts";
import { readJsonBody, jsonError } from "./http-utils.ts";

const runSchema = z.strictObject({
  targetReceiverId: z.string().min(1).max(128).optional(),
  connectionName: z.string().optional(),
  config: z.record(z.string(), z.json()).optional(),
  dryRun: z.boolean().optional(),
  backfill: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(1000).optional(),
});

/** Registered behind the existing /api admin authentication middleware. */
export function registerSyncRoutes(
  app: Hono,
  runner: SyncRunner,
  store: ISyncStore,
  delivery?: SyncDeliveryWorker,
  scheduler?: SyncScheduler,
): void {
  if (delivery)
    app.post("/api/sync/delivery/run", async (context) => context.json({ attempted: await delivery.tick() }));
  app.get("/api/sync/status", async (context) =>
    context.json<SyncStatus>({
      acquisitionRunning: runner.busy,
      schedulerRunning: scheduler?.running ?? false,
      ...(await store.status.read()),
      receivers: await store.delivery.list(),
      definitions: runner.definitions(),
    }),
  );
  app.get("/api/sync/installations/:id/status", async (context) => {
    const status = await store.status.read(context.req.param("id"));
    if (!status.installations.length)
      return jsonError(context, 404, "installation_not_found", "Sync installation not found.");
    return context.json<SyncStatus>({
      ...status,
      acquisitionRunning: runner.busy,
      schedulerRunning: scheduler?.running ?? false,
      receivers: await store.delivery.list(),
      definitions: runner.definitions(),
    });
  });
  app.post("/api/sync/installations", async (context) => {
    const schema = z.strictObject({
      definitionId: z.string().min(1),
      connectionName: z.string().optional(),
      config: z.record(z.string(), z.json()).optional(),
      scheduleSeconds: z.number().int().min(60).max(86400).optional(),
      enabled: z.boolean().default(true),
    });
    const parsed = schema.safeParse(await readJsonBody(context, 64 * 1024));
    if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid sync configuration.");
    try {
      const installation = await runner.create({
        ...parsed.data,
        config: parsed.data.config as JsonObject | undefined,
        signal: context.req.raw.signal,
      });
      if (scheduler?.running) scheduler.tick();
      return context.json(installation, 201);
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.post("/api/sync/installations/:id/run", async (context) => {
    if (!scheduler?.running)
      return jsonError(context, 503, "scheduler_stopped", "Automatic polling is stopped on this runtime.");
    try {
      store.schedule.requestRun(context.req.param("id"));
      scheduler.tick();
      return context.json({ queued: true }, 202);
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.delete("/api/sync/installations/:id", (context) => {
    try {
      const id = context.req.param("id");
      store.schedule.remove(id);
      runner.cancel(id);
      return context.json({ id });
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.patch("/api/sync/installations/:id", async (context) => {
    const schema = z.strictObject({
      enabled: z.boolean(),
      scheduleSeconds: z.number().int().min(60).max(86400).optional(),
    });
    const parsed = schema.safeParse(await readJsonBody(context, 64 * 1024));
    if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid schedule configuration.");
    try {
      const installationId = context.req.param("id");
      store.schedule.configure({ installationId, ...parsed.data });
      if (!parsed.data.enabled) runner.cancel(installationId);
      else if (scheduler?.running) scheduler.tick();
      return context.json(await store.getInstallation(installationId));
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.get("/api/sync/receivers", async (context) => context.json(await store.delivery.list()));
  app.patch("/api/sync/receivers/:id", async (context) => {
    const schema = z.strictObject({
      url: z.string().max(8192).optional(),
      bearerToken: z.string().min(1).max(8192).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(await readJsonBody(context, 64 * 1024));
    if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid destination configuration.");
    try {
      const id = context.req.param("id");
      await store.delivery.update({ id, ...parsed.data });
      return context.json({ id });
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.delete("/api/sync/receivers/:id", (context) => {
    try {
      const id = context.req.param("id");
      store.delivery.remove(id);
      return context.json({ id });
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.put("/api/sync/receivers/:id", async (context) => {
    const schema = z.strictObject({
      url: z.string().max(8192),
      bearerToken: z.string().max(8192),
      enabled: z.boolean().default(true),
    });
    const parsed = schema.safeParse(await readJsonBody(context, 64 * 1024));
    if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid receiver registration.");
    try {
      await store.delivery.register({ id: context.req.param("id"), ...parsed.data });
      return context.json({ id: context.req.param("id") });
    } catch (error) {
      return syncError(context, error);
    }
  });
  app.get("/api/sync/definitions", (context) => context.json(runner.definitions()));
  app.get("/api/sync/runs/:id", (context) => {
    const run = store.status.getRun(context.req.param("id"));
    return run ? context.json(run) : jsonError(context, 404, "run_not_found", "Sync run not found.");
  });
  app.post("/api/sync/definitions/:id/run", async (context) => {
    try {
      const parsed = runSchema.safeParse(await readJsonBody(context, 64 * 1024));
      if (!parsed.success) return jsonError(context, 400, "invalid_input", "Invalid sync run request.");
      return context.json(
        await runner.run({
          ...parsed.data,
          config: parsed.data.config as JsonObject | undefined,
          definitionId: context.req.param("id"),
          signal: context.req.raw.signal,
        }),
      );
    } catch (error) {
      return syncError(context, error);
    }
  });
}

function syncError(context: Context, error: unknown): Response {
  if (error instanceof SyncStoreError || error instanceof ConnectionError)
    return jsonError(
      context,
      error.code === "installation_not_found" || error.code === "receiver_not_found"
        ? 404
        : error.code === "run_busy" || error.code === "binding_conflict" || error.code === "credential_changed"
          ? 409
          : 400,
      error.code,
      error.message,
    );
  throw error;
}
