import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./index.mjs";
import { openTestDatabase } from "./services/test-database.mjs";
import { createWorkspaceSession, WORKSPACE_SESSION_COOKIE } from "./services/workspace.mjs";

describe("workspace foundation route integration", () => {
  const fixtures = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.app.close();
      fixture.db?.close();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("keeps every foundation endpoint disabled without opening a database", async () => {
    const fixture = await makeApp({ enabled: false });
    for (const request of [
      { method: "POST", url: "/api/workspace/bots", payload: { name: "Disabled" } },
      { method: "GET", url: "/api/workspace/echo/requirements" },
      { method: "GET", url: "/api/workspace/topics" }
    ]) {
      const response = await fixture.app.inject(request);
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("workspace.disabled");
    }
  });

  it("registers Bot, Echo and Topic routes through the application session resolver", async () => {
    const fixture = await makeApp({ nodeEnv: "production" });

    for (const request of [
      { method: "POST", url: "/api/workspace/bots", payload: { name: "Header bypass" } },
      { method: "GET", url: "/api/workspace/echo/requirements" },
      { method: "GET", url: "/api/workspace/topics" }
    ]) {
      const response = await fixture.app.inject({
        ...request,
        headers: { "x-workspace-user-id": "usr_owner" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("auth.required");
    }

    const session = await createWorkspaceSession(fixture.db, "usr_owner");
    const cookie = `${WORKSPACE_SESSION_COOKIE}=${session.token}`;
    const bot = await fixture.app.inject({
      method: "POST",
      url: "/api/workspace/bots",
      headers: { cookie },
      payload: { name: "Session-owned Bot" }
    });
    expect(bot.statusCode).toBe(201);
    expect(bot.json().bot).toMatchObject({
      name: "Session-owned Bot",
      kind: "bot",
      authenticationAllowed: false
    });

    const echo = await fixture.app.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements",
      headers: { cookie }
    });
    expect(echo.statusCode).toBe(200);
    expect(echo.json()).toEqual({ requirements: [] });

    const topics = await fixture.app.inject({
      method: "GET",
      url: "/api/workspace/topics",
      headers: { cookie }
    });
    expect(topics.statusCode).toBe(200);
    expect(topics.json()).toEqual({ topics: [] });
  });

  async function makeApp({ enabled = true, nodeEnv = "test" } = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-foundation-routes-"));
    const db = enabled ? openTestDatabase(dataDir) : null;
    const app = await createApp({
      dataDir,
      ...(db ? { db } : {}),
      env: {
        WORKSPACE_ENABLED: enabled ? "true" : "false",
        NODE_ENV: nodeEnv,
        SERVE_STATIC: "false",
        WORKSPACE_EMAIL_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_WORKER_ENABLED: "false",
        SESSION_SECRET: "foundation-route-test-secret"
      },
      logger: false
    });
    const fixture = { app, db, dataDir };
    fixtures.push(fixture);
    return fixture;
  }
});
