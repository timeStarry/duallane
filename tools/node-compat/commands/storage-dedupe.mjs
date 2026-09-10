import { openDatabase } from "../lib/database.mjs";
import { createWorkspaceObjectStore } from "../lib/object-store.mjs";
import { runWorkspaceStorageDedupe } from "../lib/storage-dedupe.mjs";

export async function runStorageDedupe({ env = process.env, stdout = process.stdout } = {}) {
  const dataDir = env.DUALLANE_DATA_DIR || "/app/data";
  const maxConnections = Number(env.DATABASE_POOL_MAX);
  const db = await openDatabase(env.DATABASE_URL, {
    host: env.PGHOST,
    port: Number(env.PGPORT) || undefined,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    maxConnections: Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : undefined,
    ssl: env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
    migrate: false,
    seed: false
  });
  let store;
  try {
    store = await createWorkspaceObjectStore({ env, dataDir });
    await store.assertReady();
    const report = await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir,
      runId: env.WORKSPACE_STORAGE_DEDUPE_RUN_ID,
      mode: env.WORKSPACE_STORAGE_DEDUPE_MODE || "backfill"
    });
    stdout.write(
      `Workspace storage dedupe ${report.status}: run=${report.runId} mode=${report.mode} ` +
      `processed=${report.counts.processed} finalized=${report.counts.finalized}\n`
    );
    return report;
  } finally {
    await Promise.allSettled([db.close(), store?.close?.()]);
  }
}
