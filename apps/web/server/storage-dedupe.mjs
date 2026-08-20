import { createWorkspaceObjectStore } from "./services/workspace-object-store.mjs";
import { openDatabase } from "./services/db.mjs";
import { runWorkspaceStorageDedupe } from "./services/workspace-storage-dedupe.mjs";

const env = process.env;
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
  seed: false
});
const store = await createWorkspaceObjectStore({ env, dataDir });

try {
  await store.assertReady();
  const report = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir,
    runId: env.WORKSPACE_STORAGE_DEDUPE_RUN_ID,
    mode: env.WORKSPACE_STORAGE_DEDUPE_MODE || "backfill"
  });
  process.stdout.write(
    `Workspace storage dedupe ${report.status}: run=${report.runId} mode=${report.mode} ` +
    `processed=${report.counts.processed} finalized=${report.counts.finalized}\n`
  );
} finally {
  await Promise.allSettled([db.close(), store.close()]);
}
