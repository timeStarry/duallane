import { openDatabase } from "./services/db.mjs";
import {
  createWorkspaceS3MigrationStore,
  runWorkspaceS3Migration
} from "./services/workspace-s3-migration.mjs";

const env = process.env;
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
const store = await createWorkspaceS3MigrationStore({ env });

try {
  await store.assertReady();
  const report = await runWorkspaceS3Migration({ db, dataDir, store, runId, mode });
  process.stdout.write(
    `Workspace S3 migration ${report.status}: run=${report.runId} total=${report.counts.total} verified=${report.counts.verified}\n`
  );
} finally {
  await Promise.allSettled([db.close(), store.close()]);
}
