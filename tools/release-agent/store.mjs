import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dayMs = 24 * 60 * 60 * 1000;

export function ticketId(source) {
  const key = JSON.stringify([source.spaceId, source.conversationId, source.messageId]);
  return `DL-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function readTicket(row) {
  return row && { ...JSON.parse(row.record), revision: row.revision };
}

export function openReleaseStore(stateDirectory, { now = Date.now } = {}) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const database = join(stateDirectory, "release-agent.sqlite");
  const db = new DatabaseSync(database);
  if (process.platform !== "win32") chmodSync(database, 0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_ms INTEGER NOT NULL,
      updated_ms INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_state ON tickets(state, created_ms);
    CREATE TABLE IF NOT EXISTS audit (
      sequence INTEGER PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      timestamp_ms INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      key TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      next_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      receipt TEXT
    );
    CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(status, next_ms);
  `);

  function transaction(run) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const select = db.prepare("SELECT record, revision FROM tickets WHERE id = ?");
  const audit = db.prepare("INSERT INTO audit (ticket_id,timestamp_ms,actor,action,result) VALUES (?,?,?,?,?)");
  const update = db.prepare("UPDATE tickets SET state = ?, record = ?, updated_ms = ?, revision = revision + 1 WHERE id = ? AND revision = ?");
  const insertDelivery = db.prepare("INSERT INTO deliveries (key,ticket_id,kind,text,next_ms) VALUES (?,?,?,?,?)");

  function record(id, actor, action, result) {
    audit.run(id, now(), actor, action, result);
  }

  function write(ticket, patch, actor, action, result, delivery) {
    const { revision, ...before } = ticket;
    const after = { ...before, ...patch };
    const changed = update.run(after.state, JSON.stringify(after), now(), ticket.id, revision).changes;
    if (changed !== 1) return null;
    record(ticket.id, actor, action, result);
    if (delivery) {
      insertDelivery.run(`${ticket.id.toLowerCase()}-${delivery.stage}`, ticket.id,
        delivery.kind, delivery.text || "", now());
    }
    return { ...after, revision: revision + 1 };
  }

  return {
    close: () => db.close(),
    get: (id) => readTicket(select.get(id)),
    list: () => db.prepare("SELECT record,revision FROM tickets ORDER BY created_ms DESC LIMIT 100").all().map(readTicket),
    listByState: (state) => db.prepare("SELECT record,revision FROM tickets WHERE state = ? ORDER BY created_ms LIMIT 100").all(state).map(readTicket),
    take({ source, text, context, maxDailyTickets }) {
      return transaction(() => {
        const id = ticketId(source);
        const existing = readTicket(select.get(id));
        if (existing) return { ticket: existing, duplicate: true };
        const count = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE created_ms >= ?").get(now() - dayMs).count;
        if (count >= maxDailyTickets) return { quota: true };
        const createdAt = now();
        const ticket = { id, source, text, context, createdAt, state: "queued" };
        db.prepare("INSERT INTO tickets (id,state,revision,created_ms,updated_ms,record) VALUES (?,?,1,?,?,?)")
          .run(id, ticket.state, createdAt, createdAt, JSON.stringify(ticket));
        record(id, source.actorId, "intake", "queued");
        return { ticket: { ...ticket, revision: 1 }, duplicate: false };
      });
    },
    observe(states) {
      for (const state of states) {
        const row = db.prepare("SELECT record,revision FROM tickets WHERE state = ? ORDER BY updated_ms, id LIMIT 1").get(state);
        if (row) return readTicket(row);
      }
      return null;
    },
    transition(ticket, patch, { actor = "worker", action, result = patch.state, delivery, exclusive = [] }) {
      return transaction(() => {
        for (const state of exclusive) {
          if (db.prepare("SELECT 1 AS found FROM tickets WHERE state = ? LIMIT 1").get(state)) return null;
        }
        return write(ticket, patch, actor, action, result, delivery);
      });
    },
    audit(id, actor, action, result) {
      record(id, actor, action, result);
    },
    listAudit(id) {
      return db.prepare("SELECT actor,action,result,timestamp_ms FROM audit WHERE ticket_id = ? ORDER BY sequence").all(id);
    },
    nextDelivery() {
      return db.prepare("SELECT * FROM deliveries WHERE status = 'pending' AND next_ms <= ? ORDER BY next_ms,rowid LIMIT 1").get(now());
    },
    deliverySucceeded(delivery, receipt) {
      return transaction(() => {
        const saved = db.prepare("UPDATE deliveries SET status = 'sent', receipt = ? WHERE key = ? AND status = 'pending'")
          .run(JSON.stringify(receipt), delivery.key).changes;
        if (saved !== 1) return;
        const ticket = readTicket(select.get(delivery.ticket_id));
        if (delivery.kind === "approval" && ticket.state === "card_pending") {
          write(ticket, { state: "awaiting_approval", cardId: receipt.cardId }, "worker", "approval_card", "sent");
        } else {
          record(ticket.id, "worker", "group_reply", "sent");
        }
      });
    },
    deliveryFailed(delivery, code, retryable) {
      transaction(() => {
        const attempts = delivery.attempts + 1;
        const willRetry = retryable && attempts < 5;
        const changed = db.prepare("UPDATE deliveries SET attempts = ?, next_ms = ?, status = ? WHERE key = ? AND attempts = ? AND status = 'pending'")
          .run(attempts, now() + 1000 * 5 ** attempts, willRetry ? "pending" : "blocked", delivery.key, delivery.attempts).changes;
        if (changed !== 1) return;
        record(delivery.ticket_id, "worker", "delivery_failed", code);
        const ticket = readTicket(select.get(delivery.ticket_id));
        if (!willRetry && delivery.kind === "approval" && ticket.state === "card_pending") {
          write(ticket, { state: "blocked", reason: code }, "worker", "approval_card", "blocked");
        }
      });
    },
  };
}
