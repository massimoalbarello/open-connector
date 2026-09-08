import type { DatabaseSync } from "node:sqlite";

/** All sync writes use short synchronous transactions; network work must finish first. */
export function runSyncTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("begin immediate");
  try {
    const result = work();
    database.exec("commit");
    return result;
  } catch (error) {
    database.exec("rollback");
    throw error;
  }
}
