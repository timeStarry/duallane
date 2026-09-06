// Builds the executable Bot owner/Gateway contract fixture from the checked-in
// Node route inventory and the real Node message DTO golden. It contains only
// synthetic identifiers and never emits a raw Bot token.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "../../apps/web/node_modules/fastify/fastify.js";
import { registerWorkspaceAgentBotRoutes } from "../../apps/web/server/routes/workspace-bots.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const routeInventoryPath = path.join(root, "apps/backend/api/node-routes.json");
const messageGoldenPath = path.join(root, "apps/backend/internal/workspace/botgateway/testdata/node-message-dto.json");
const outputPath = path.join(root, "apps/backend/internal/workspacecontract/testdata/node-bot-contract.json");

const ownerSetupRoutes = [
  ["GET", "/api/workspace/bot-setup/{sessionId}", "/api/workspace/bot-setup/:sessionId"],
  ["POST", "/api/workspace/bot-setup/{sessionId}/approve", "/api/workspace/bot-setup/:sessionId/approve"],
  ["POST", "/api/workspace/bot-setup/{sessionId}/deny", "/api/workspace/bot-setup/:sessionId/deny"]
];
const websocketRoute = ["GET", "/ws/bot-gateway", "/ws/bot-gateway"];

const inventory = JSON.parse(await readFile(routeInventoryPath, "utf8"));
const messageGolden = JSON.parse(await readFile(messageGoldenPath, "utf8"));
const routes = inventory.routes
  .filter((route) => route.path.startsWith("/api/workspace/bots") || route.path.startsWith("/api/bot-gateway/v1/"))
  .map(({ method, path: routePath, nodePath, source, transport, lane }) => ({ method, path: routePath, nodePath, source, transport, lane }));
for (const [method, routePath, nodePath] of ownerSetupRoutes) {
  routes.push({ method, path: routePath, nodePath, source: "apps/web/server/routes/workspace-bots.mjs", transport: "http", lane: "workspace" });
}
routes.push({ method: websocketRoute[0], path: websocketRoute[1], nodePath: websocketRoute[2], source: "apps/web/server/routes/workspace-bot-gateway.mjs", transport: "websocket", lane: "workspace" });

// Exercise the owner route and actual service/database; only the authenticated
// test actor and deterministic IDs/time are injected. No token is issued.
async function ownerCreateResponse() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-contract-"));
  let db;
  let app;
  try {
    db = openTestDatabase(directory);
    app = Fastify({ logger: false });
    const service = createWorkspaceAgentBotService({
      db, now: () => new Date("2026-09-06T09:10:11.123Z"), idFactory: () => "fixture"
    });
    registerWorkspaceAgentBotRoutes({
      app, service, workspaceEnabled: true,
      getActorId: () => "usr_owner", getSpaceId: () => "spc_default"
    });
    const response = await app.inject({
      method: "POST", url: "/api/workspace/bots", payload: { name: "Contract Fixture Bot" }
    });
    assert.equal(response.statusCode, 201);
    return { status: response.statusCode, body: response.json() };
  } finally {
    try { await app?.close(); } finally {
      try { await db?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}
const ownerResponse = await ownerCreateResponse();
const messageCase = messageGolden.cases.find(({ name }) => name === "text-alias");
if (!messageCase) throw new Error("Node message golden is missing text-alias");

const fixture = {
  schemaVersion: 1,
  source: {
    nodeRoutes: "apps/backend/api/node-routes.json",
    ownerRouteSource: "apps/web/server/routes/workspace-bots.mjs",
    gatewayRouteSource: "apps/web/server/routes/workspace-bot-gateway.mjs",
    messageRuntime: "scripts/backend/bot-message-dto-fixtures.mjs"
  },
  routes,
  scenarios: [
    {
      name: "owner-bot-create",
      document: "workspace-bots",
      request: { method: "POST", path: "/api/workspace/bots", headers: { "content-type": "application/json" }, body: { name: "Contract Fixture Bot" } },
      response: ownerResponse
    },
    {
      name: "gateway-message-node-golden",
      document: "bot-gateway",
      request: {
        method: "POST",
        path: "/api/bot-gateway/v1/messages",
        headers: { "content-type": "application/json" },
        body: messageCase.request
      },
      response: { status: messageCase.statusCode, body: messageCase.response }
    }
  ]
};

if (process.argv.includes("--write")) {
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
} else {
  const expected = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(fixture, expected, "Bot contract fixture drift");
}
process.stdout.write(`bot-contract-fixtures ${process.argv.includes("--write") ? "written" : "verified"} routes=${routes.length} scenarios=${fixture.scenarios.length} PASS\n`);
