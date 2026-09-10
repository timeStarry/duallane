import { openDatabase } from "../lib/database.mjs";
import {
  createWorkspaceS3MigrationStore,
  runWorkspaceS3Migration
} from "../lib/s3-migration.mjs";

export async function runStorageMigrate({ env = process.env, stdout = process.stdout } = {}) {
  const runId = env.WORKSPACE_STORAGE_MIGRATION_RUN_ID;
  const mode = env.WORKSPACE_STORAGE_MIGRATION_MODE || "backfill";
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
    store = await createWorkspaceS3MigrationStore({ env });
    await store.assertReady();
    const report = await runWorkspaceS3Migration({ db, dataDir, store, runId, mode });
    stdout.write(
      `Workspace S3 migration ${report.status}: run=${report.runId} total=${report.counts.total} verified=${report.counts.verified}\n`
    );
    return report;
  } finally {
    await Promise.allSettled([db.close(), store?.close?.()]);
  }
}
