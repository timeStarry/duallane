import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "../services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../services/workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "../services/workspace-bot-gateway.mjs";
import { registerWorkspaceBotGatewayRoutes } from "./workspace-bot-gateway.mjs";

const SPACE_ID = "spc_default";

describe("Bot Gateway routes", () => {
  const fixtures = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ app, db, directory }) => {
      await app.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("blocks every Gateway endpoint while Workspace is disabled", async () => {
    const app = Fastify({ logger: false });
    registerWorkspaceBotGatewayRoutes({ app, workspaceEnabled: false });
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-gateway-route-disabled-"));
    fixtures.push({ app, db: { close() {} }, directory });
    const response = await app.inject({ method: "GET", url: "/api/bot-gateway/v1/me" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("workspace.disabled");
  });

  it("keeps Bot Gateway auth separate from ordinary headers and masks internal projection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-gateway-route-"));
    const db = openTestDatabase(directory);
    const botService = createWorkspaceAgentBotService({ db });
    const gateway = createWorkspaceBotGatewayService({ db, botService });
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Route Gateway" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const app = Fastify({ logger: false });
    registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled: true });
    fixtures.push({ app, db, directory });

    const ordinary = await app.inject({ method: "GET", url: "/api/bot-gateway/v1/me" });
    expect(ordinary.statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/api/bot-gateway/v1/me", headers: { authorization: `Bearer ${issued.token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().bot.githubLogin).toBeUndefined();
    expect(response.json().bot.ownerUserId).toBeUndefined();
  });
});
