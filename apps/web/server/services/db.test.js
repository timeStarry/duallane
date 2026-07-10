import { describe, expect, it, vi } from "vitest";
import { createDatabaseFromPool, openDatabase } from "./db.mjs";

describe("postgres database adapter", () => {
  it("translates parameters and restores camel-case result aliases", async () => {
    const createdAt = new Date("2026-07-10T08:00:00.000Z");
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ camelcase: "ok", createdat: createdAt }],
        rowCount: 1
      }))
    };
    const db = createDatabaseFromPool(pool);

    const row = await db.prepare("SELECT ? AS camelCase, '?' AS createdAt").get("value");

    expect(pool.query).toHaveBeenCalledWith("SELECT $1 AS camelCase, '?' AS createdAt", ["value"]);
    expect(row).toEqual({ camelCase: "ok", createdAt: createdAt.toISOString() });
  });

  it("uses one client for nested transactions and transaction-level locks", async () => {
    const queries = [];
    const client = {
      query: vi.fn(async (text, values = []) => {
        queries.push({ text, values });
        return { rows: [], rowCount: text.startsWith("UPDATE") ? 1 : null };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) };
    const db = createDatabaseFromPool(pool);

    await db.transaction(async () => {
      await db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run("Owner", "usr_owner");
      await db.lock("workspace-quota:usr_owner");
      await db.transaction(async () => {
        await db.prepare("SELECT ? AS nestedValue").all(1);
      });
    });

    expect(queries[0].text).toBe("BEGIN");
    expect(queries.some(({ text }) => text === "UPDATE users SET display_name = $1 WHERE id = $2")).toBe(true);
    expect(queries.some(({ text }) => text === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")).toBe(true);
    expect(queries.some(({ text }) => text.startsWith("SAVEPOINT duallane_"))).toBe(true);
    expect(queries.some(({ text }) => text.startsWith("RELEASE SAVEPOINT duallane_"))).toBe(true);
    expect(queries.at(-1).text).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client when a transaction fails", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: null })),
      release: vi.fn()
    };
    const db = createDatabaseFromPool({ connect: vi.fn(async () => client) });

    await expect(db.transaction(async () => {
      throw new Error("transaction failed");
    })).rejects.toThrow("transaction failed");

    expect(client.query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("requires explicit production database connection settings", async () => {
    await expect(openDatabase("")).rejects.toThrow("DATABASE_URL or PGHOST");
  });
});
