import Fastify from "../../apps/web/node_modules/fastify/fastify.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerWorkspaceAgentBotRoutes } from "../../apps/web/server/routes/workspace-bots.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";

const SPACE_ID = "spc_default";
const NOW = "2026-09-06T09:10:11.123Z";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-connection-"));
  const db = openTestDatabase(directory);
  const service = createWorkspaceAgentBotService({ db, now: () => new Date(NOW) });
  const app = Fastify({ logger: false });
  registerWorkspaceAgentBotRoutes({
    app,
    service,
    getActorId: (request) => request.headers["x-user"] ?? null,
    getSpaceId: () => SPACE_ID
  });
  await app.ready();

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { name: "Node Connection Fixture" }
    });
    if (created.statusCode !== 201) throw new Error(`create status ${created.statusCode}: ${created.body}`);
    const botId = created.json().bot.id;

    const bodyCases = [
      { name: "omitted", payload: undefined, expectedStatus: 200 },
      { name: "empty-json", headers: { "content-type": "application/json" }, payload: "", expectedStatus: 400 },
      { name: "unknown-object", payload: { ignored: true }, expectedStatus: 200 },
      { name: "null", headers: { "content-type": "application/json" }, payload: "null", expectedStatus: 200 },
      { name: "primitive", headers: { "content-type": "application/json" }, payload: "1", expectedStatus: 200 },
      { name: "malformed", headers: { "content-type": "application/json" }, payload: "{", expectedStatus: 400 }
    ];
    const bodyObservations = [];
    for (const testCase of bodyCases) {
      const response = await app.inject({
        method: "POST",
        url: `/api/workspace/bots/${botId}/connection/test`,
        headers: { "x-user": "usr_owner", ...testCase.headers },
        ...(testCase.payload === undefined ? {} : { payload: testCase.payload })
      });
      bodyObservations.push({ name: testCase.name, statusCode: response.statusCode, body: response.json() });
      if (response.statusCode !== testCase.expectedStatus) {
        throw new Error(`body ${testCase.name} status ${response.statusCode}: ${response.body}`);
      }
    }

    db.prepare(`UPDATE workspace_agent_bot_connections
      SET status = 'connected', adapter_version = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
      WHERE bot_id = ? AND space_id = ?`).run("node-v1", "gateway.timeout", NOW, NOW, botId, SPACE_ID);

    const ownerRead = await app.inject({
      method: "GET",
      url: `/api/workspace/bots/${botId}/connection`,
      headers: { "x-user": "usr_owner" }
    });
    const readConnection = ownerRead.json().connection;
    if (ownerRead.statusCode !== 200 || readConnection.status !== "connected" || readConnection.adapterVersion !== "node-v1") {
      throw new Error(`owner GET mismatch: ${ownerRead.statusCode} ${ownerRead.body}`);
    }

    const ownerTest = await app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/connection/test`,
      headers: { "x-user": "usr_owner" },
      payload: {}
    });
    const testedConnection = ownerTest.json().connection;
    if (ownerTest.statusCode !== 200 || testedConnection.lastErrorCode !== null || testedConnection.testedAt !== NOW) {
      throw new Error(`owner POST mismatch: ${ownerTest.statusCode} ${ownerTest.body}`);
    }
    if (Object.hasOwn(testedConnection, "connectionNonce") || Object.hasOwn(testedConnection, "token")) {
      throw new Error(`secret field leaked: ${ownerTest.body}`);
    }

    db.prepare(`INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)`).run("usr_connection_member", "connection-member", "Connection Member", NOW);
    db.prepare(`INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, 'member', ?, NULL)`).run(SPACE_ID, "usr_connection_member", NOW);
    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/workspace/bots/${botId}/connection`,
      headers: { "x-user": "usr_connection_member" }
    });
    if (foreignRead.statusCode !== 403 || foreignRead.json().error.code !== "permission.denied") {
      throw new Error(`foreign GET mismatch: ${foreignRead.statusCode} ${foreignRead.body}`);
    }

    db.prepare("UPDATE workspace_agent_bots SET status = 'paused' WHERE id = ?").run(botId);
    db.prepare("UPDATE workspace_agent_bot_connections SET status = 'paused' WHERE bot_id = ? AND space_id = ?").run(botId, SPACE_ID);
    const paused = await app.inject({
      method: "GET",
      url: `/api/workspace/bots/${botId}/connection`,
      headers: { "x-user": "usr_owner" }
    });
    if (paused.statusCode !== 200 || paused.json().connection.status !== "paused") {
      throw new Error(`paused GET mismatch: ${paused.statusCode} ${paused.body}`);
    }

    const auditCounts = db.prepare(`SELECT action, result, COUNT(*) AS count
      FROM audit_logs WHERE action IN ('bot.connection.test', 'bot.connection.read')
      GROUP BY action, result ORDER BY action, result`).all();
    console.log(JSON.stringify({ bodyObservations, ownerGet: readConnection, ownerTest: testedConnection, paused: paused.json().connection, auditCounts }));
  } finally {
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
