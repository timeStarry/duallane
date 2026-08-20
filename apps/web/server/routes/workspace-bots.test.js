import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "../services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../services/workspace-agent-bots.mjs";
import { registerWorkspaceAgentBotRoutes } from "./workspace-bots.mjs";

const SPACE_ID = "spc_default";

describe("workspace Agent Bot management routes", () => {
  const fixtures = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ app, db, directory }) => {
      await app.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("returns the workspace-disabled contract without requiring a service or database", async () => {
    const app = Fastify({ logger: false });
    registerWorkspaceAgentBotRoutes({
      app,
      workspaceEnabled: false,
      getActorId: () => null
    });
    fixtures.push({ app, db: { close() {} }, directory: await mkdtemp(path.join(tmpdir(), "duallane-bot-route-disabled-")) });

    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      payload: { name: "ignored" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "workspace.disabled", message: "共享空间暂未开放" }
    });
  });

  it("requires an authenticated human actor and rejects a Bot identity", async () => {
    const fixture = await makeFixture();
    const unauthenticated = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      payload: { name: "No session" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("auth.required");

    const created = await fixture.service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Owned" });
    const botSession = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": created.botUserId },
      payload: { name: "Impersonation" }
    });
    expect(botSession.statusCode).toBe(403);
    expect(botSession.json().error.code).toBe("permission.denied");

    const invalidBody = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { displayName: "missing name" }
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json()).toEqual({
      error: { code: "bot.invalid_request", message: "请求参数无效" }
    });
  });

  it("keeps Bot management owner-scoped and does not return another owner Bot", async () => {
    const fixture = await makeFixture();
    const created = await fixture.service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Owner Bot" });
    const outsider = "usr_route_outsider";
    fixture.db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)
    `).run(outsider, "route-outsider", "Route Outsider", new Date().toISOString());
    fixture.db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, 'member', ?, NULL)
    `).run(SPACE_ID, outsider, new Date().toISOString());

    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/workspace/bots/${created.id}`,
      headers: { "x-user": outsider }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("permission.denied");

    const missing = await fixture.app.inject({
      method: "GET",
      url: "/api/workspace/bots/not-a-bot",
      headers: { "x-user": "usr_owner" }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("bot.not_found");
  });

  it("returns a newly issued Token once and masks it in all later projections", async () => {
    const fixture = await makeFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { name: "Token Bot" }
    });
    expect(created.statusCode).toBe(201);
    const botId = created.json().bot.id;

    const issued = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/tokens`,
      headers: { "x-user": "usr_owner" },
      payload: { scopes: ["messages:send"] }
    });
    expect(issued.statusCode).toBe(201);
    const rawToken = issued.json().token;
    expect(rawToken).toMatch(/^dl_bot_/u);
    expect(issued.json().tokenRecord.token).toBeUndefined();
    const persisted = fixture.db.prepare("SELECT token_hash AS tokenHash, scopes_json AS scopesJson FROM workspace_agent_bot_tokens WHERE id = ?").get(issued.json().tokenRecord.id);
    expect(persisted.tokenHash).not.toBe(rawToken);
    expect(persisted.tokenHash).not.toContain(rawToken);
    expect(persisted.scopesJson).not.toContain(rawToken);

    const listed = await fixture.app.inject({
      method: "GET",
      url: `/api/workspace/bots/${botId}/tokens`,
      headers: { "x-user": "usr_owner" }
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(rawToken);
    expect(listed.json().tokens[0].token).toMatch(/^dl_bot_••/u);
  });

  it("exposes the complete owner lifecycle, including two-stage deletion and replacement", async () => {
    const fixture = await makeFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { name: "Lifecycle Bot" }
    });
    const botId = created.json().bot.id;

    const paused = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/pause`,
      headers: { "x-user": "usr_owner" }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().bot.status).toBe("paused");

    const resumed = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/resume`,
      headers: { "x-user": "usr_owner" }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().bot.status).toBe("active");

    const tokenResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/tokens`,
      headers: { "x-user": "usr_owner" },
      payload: {}
    });
    const tokenId = tokenResponse.json().tokenRecord.id;
    const revoked = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/tokens/${tokenId}/revoke`,
      headers: { "x-user": "usr_owner" }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().token.token).toMatch(/^dl_bot_••/u);

    const requested = await fixture.app.inject({
      method: "DELETE",
      url: `/api/workspace/bots/${botId}`,
      headers: { "x-user": "usr_owner" }
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().bot.status).toBe("deleting");

    const confirmed = await fixture.app.inject({
      method: "POST",
      url: `/api/workspace/bots/${botId}/delete/confirm`,
      headers: { "x-user": "usr_owner" }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().bot.status).toBe("deleted");

    const replacement = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { name: "Replacement Bot" }
    });
    expect(replacement.statusCode).toBe(201);
    const replacementId = replacement.json().bot.id;
    expect(replacementId).not.toBe(botId);

    const replacementRead = await fixture.app.inject({
      method: "GET",
      url: `/api/workspace/bots/${replacementId}`,
      headers: { "x-user": "usr_owner" }
    });
    expect(replacementRead.statusCode).toBe(200);
    expect(replacementRead.json().bot).toMatchObject({ id: replacementId, name: "Replacement Bot", status: "active" });

    // The owner projection must prefer the current active replacement over a
    // deleted historical Bot, even when the old row is newer by insertion.
    await expect(fixture.service.getOwnedBot("usr_owner", SPACE_ID)).resolves.toMatchObject({
      id: replacementId,
      status: "active"
    });
  });

  it("manages policy settings, rotates tokens, and reports connection state", async () => {
    const fixture = await makeFixture();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { "x-user": "usr_owner" },
      payload: { name: "Settings Bot" }
    });
    const botId = created.json().bot.id;
    const identitySettings = await fixture.app.inject({
      method: "PATCH",
      url: `/api/workspace/bots/${botId}/settings`,
      headers: { "x-user": "usr_owner" },
      payload: {
        description: "Release coordination",
        welcomeMessage: "Ready to help",
        showCreator: true,
        visibilityPolicy: "private",
        allowedMemberIds: []
      }
    });
    expect(identitySettings.statusCode).toBe(200);
    expect(identitySettings.json().settings).toMatchObject({
      description: "Release coordination",
      welcomeMessage: "Ready to help",
      showCreator: true,
      visibilityPolicy: "private",
      allowedMemberIds: []
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_visibility_members WHERE bot_id = ?").get(botId).count).toBe(0);
    const settings = await fixture.app.inject({
      method: "PATCH",
      url: `/api/workspace/bots/${botId}/settings`,
      headers: { "x-user": "usr_owner" },
      payload: { visibilityPolicy: "space_members", allowGroup: true, maxContextMessages: 80 }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().settings).toMatchObject({ visibilityPolicy: "space_members", allowGroup: true, context: { maxMessages: 80 } });
    const issued = await fixture.app.inject({ method: "POST", url: `/api/workspace/bots/${botId}/tokens`, headers: { "x-user": "usr_owner" }, payload: {} });
    const rotated = await fixture.app.inject({ method: "POST", url: `/api/workspace/bots/${botId}/tokens/rotate`, headers: { "x-user": "usr_owner" }, payload: {} });
    expect(rotated.statusCode).toBe(201);
    await expect(fixture.service.authenticateToken(issued.json().token)).rejects.toMatchObject({ code: "bot.invalid_token" });
    await expect(fixture.service.authenticateToken(rotated.json().token)).resolves.toMatchObject({ botId });
    const connection = await fixture.app.inject({ method: "GET", url: `/api/workspace/bots/${botId}/connection`, headers: { "x-user": "usr_owner" } });
    expect(connection.statusCode).toBe(200);
    expect(connection.json().connection.status).toBe("disconnected");
  });

  async function makeFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-route-"));
    const db = openTestDatabase(directory);
    const service = createWorkspaceAgentBotService({ db });
    const app = Fastify({ logger: false });
    registerWorkspaceAgentBotRoutes({
      app,
      service,
      getActorId: (request) => request.headers["x-user"] || null,
      getSpaceId: () => SPACE_ID,
      workspaceEnabled: true
    });
    const fixture = { app, db, service, directory };
    fixtures.push(fixture);
    return fixture;
  }
});
