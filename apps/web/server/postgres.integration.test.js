import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAILY_QUOTA_BYTES } from "./services/quota.mjs";
import { migrateDatabase, openDatabase } from "./services/db.mjs";
import { getWorkspaceBootstrap, reserveUpload } from "./services/workspace.mjs";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe("postgres workspace integration", () => {
  const schema = `duallane_test_${process.pid}_${Date.now()}`;
  let adminPool;
  let workspacePool;
  let db;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    workspacePool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 4
    });
    db = await openDatabase(databaseUrl, { pool: workspacePool });
  });

  afterAll(async () => {
    await db?.close();
    await workspacePool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it("applies migrations and seeds the gated workspace", async () => {
    await migrateDatabase(db);
    const bootstrap = await getWorkspaceBootstrap(db);
    const migrationCount = await db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
    const seedEventCount = await db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE id = 'evt_seed_owner'").get();

    expect(bootstrap.space.id).toBe("spc_default");
    expect(bootstrap.auth.currentUser.id).toBe("usr_owner");
    expect(migrationCount.count).toBe(1);
    expect(seedEventCount.count).toBe(1);
  });

  it("serializes concurrent quota reservations before transfer", async () => {
    const request = {
      id: "postgres-quota-test",
      ip: "127.0.0.1",
      headers: { "user-agent": "vitest-postgres" }
    };
    const byteSize = Math.floor(DAILY_QUOTA_BYTES * 0.75);
    const reservations = await Promise.all([
      reserveUpload(db, request, {
        actorId: "usr_owner",
        fileName: "first.bin",
        mimeType: "application/octet-stream",
        byteSize,
        visibility: "space"
      }),
      reserveUpload(db, request, {
        actorId: "usr_owner",
        fileName: "second.bin",
        mimeType: "application/octet-stream",
        byteSize,
        visibility: "space"
      })
    ]);

    expect(reservations.map((item) => item.status).sort()).toEqual(["rejected", "reserved"]);
    const rejectionAudit = await db.prepare(`
      SELECT result FROM audit_logs
      WHERE action = 'file.upload.rejected' AND request_id = ?
    `).get(request.id);
    expect(rejectionAudit).toEqual({ result: "rejected" });

    const events = await db.prepare(`
      SELECT seq FROM workspace_events WHERE space_id = ? ORDER BY seq
    `).all("spc_default");
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
  });
});
