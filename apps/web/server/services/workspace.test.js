import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.mjs";
import { DAILY_QUOTA_BYTES } from "./quota.mjs";
import { createRelayMessage, reserveTransferQuota, WorkspaceValidationError } from "./workspace.mjs";

const request = {
  id: "test-request",
  ip: "127.0.0.1",
  headers: {
    "user-agent": "vitest"
  }
};

describe("workspace service", () => {
  let dataDir;
  let db;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-test-"));
    db = openDatabase(dataDir);
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists relay messages for conversation members", () => {
    const message = createRelayMessage(db, request, {
      authorId: "usr_owner",
      conversationId: "conv_ops",
      body: "A persisted relay message"
    });

    expect(message.body).toBe("A persisted relay message");
    const row = db.prepare("SELECT body FROM messages WHERE id = ?").get(message.id);
    expect(row.body).toBe("A persisted relay message");
  });

  it("rejects relay messages from non-members and writes an audit row", () => {
    db.prepare(`
      INSERT INTO users (id, github_login, display_name, role, created_at)
      VALUES ('usr_outsider', 'outsider', 'Outsider', 'member', ?)
    `).run(new Date().toISOString());

    expect(() =>
      createRelayMessage(db, request, {
        authorId: "usr_outsider",
        conversationId: "conv_ops",
        body: "Should not land"
      })
    ).toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = 'usr_outsider'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    expect(audit.result).toBe("rejected");
  });

  it("rejects transfers beyond the combined daily quota", () => {
    const reservation = reserveTransferQuota(db, request, {
      userId: "usr_owner",
      direction: "upload",
      byteSize: DAILY_QUOTA_BYTES + 1
    });

    expect(reservation.status).toBe("rejected");
    const ledger = db.prepare("SELECT status FROM transfer_ledger WHERE id = ?").get(reservation.id);
    expect(ledger.status).toBe("rejected");
  });
});
