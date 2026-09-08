import type { SyncRunner } from "../../sync/sync-runner.ts";
import type { ISyncStore, JsonObject } from "../../sync/sync-store.ts";
import type { Hono } from "hono";

import { z } from "zod";
import { ConnectionError } from "../../connection-service.ts";
import { SyncStoreError } from "../../sync/sync-store.ts";
import { readJsonBody, jsonError } from "./http-utils.ts";

const runSchema = z.strictObject({
  connectionName: z.string().optional(),
  config: z.record(z.string(), z.json()).optional(),
  dryRun: z.boolean().optional(),
  backfill: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(1000).optional(),
});

/** Registered behind the existing /api admin authentication middleware. */
export function registerSyncRoutes(app: Hono, runner: SyncRunner, store: ISyncStore): void {
  app.get("/api/sync/definitions", (context) => context.json(runner.definitions()));
  app.get("/api/sync/runs/:id", async (context) => {
    const run = await store.getRun(context.req.param("id"));
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
      if (error instanceof SyncStoreError || error instanceof ConnectionError)
        return context.json(
          { error: { code: error.code, message: error.message } },
          error.code === "run_busy" || error.code === "credential_changed" || error.code === "binding_conflict"
            ? 409
            : 400,
        );
      throw error;
    }
  });
}
