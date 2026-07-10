import { openDatabase } from "./services/db.mjs";

const env = process.env;
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
    : undefined
});

try {
  process.stdout.write("Workspace PostgreSQL migrations applied.\n");
} finally {
  await db.close();
}
