import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.mjs";
import { openTestDatabase } from "./services/test-database.mjs";

describe("workspace routes", () => {
  let dataDir;
  let apps;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-route-test-"));
    apps = [];
  });

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await rm(dataDir, { recursive: true, force: true });
  });

  async function makeApp(env = {}, options = {}) {
    const rawDb = openTestDatabase(dataDir);
    const db = options.wrapDb ? options.wrapDb(rawDb) : rawDb;
    const app = await createApp({
      dataDir,
      db,
      env: {
        WORKSPACE_ENABLED: "true",
        NODE_ENV: "test",
        SERVE_STATIC: "false",
        ...env
      },
      fetchImpl: options.fetchImpl,
      githubOAuthTimeoutMs: options.githubOAuthTimeoutMs,
      loggerStream: options.loggerStream,
      ...(options.useDefaultLogger ? {} : { logger: options.logger ?? false })
    });
    app.addHook("onClose", async () => rawDb.close());
    const originalInject = app.inject.bind(app);
    app.inject = (options, ...rest) => {
      if (
        options &&
        typeof options === "object" &&
        options.method === "POST" &&
        options.url === "/api/workspace/conversations" &&
        options.payload &&
        typeof options.payload === "object" &&
        options.payload.type === "group" &&
        !Object.hasOwn(options.payload, "memberIds")
      ) {
        options = {
          ...options,
          payload: {
            ...options.payload,
            memberIds: [ensureRouteFixtureGroupMember()]
          }
        };
      }
      return originalInject(options, ...rest);
    };
    apps.push(app);
    return app;
  }

  function ensureRouteFixtureGroupMember() {
    const db = openTestDatabase(dataDir);
    try {
      const existing = db.prepare("SELECT id FROM users WHERE github_login = ?").get("route-group-fixture");
      if (existing?.id) {
        return existing.id;
      }
      const now = new Date().toISOString();
      const userId = "usr_route_group_fixture";
      db.prepare(`
        INSERT INTO users (
          id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
        )
        VALUES (?, NULL, 'route-group-fixture', 'route-group-fixture@example.com', 'Route Group Fixture', NULL, 'human', ?, NULL)
      `).run(userId, now);
      db.prepare(`
        INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
        VALUES ('spc_default', ?, 'member', ?, NULL)
      `).run(userId, now);
      return userId;
    } finally {
      db.close();
    }
  }

  function getAttachmentStorageKey(attachmentId) {
    const db = openTestDatabase(dataDir);
    try {
      const row = db.prepare("SELECT storage_key AS storageKey FROM attachments WHERE id = ?").get(attachmentId);
      return row?.storageKey;
    } finally {
      db.close();
    }
  }

  function getWorkspaceContentCounts() {
    const db = openTestDatabase(dataDir);
    try {
      return {
        messages: db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
        attachments: db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
        messageAttachments: db.prepare("SELECT COUNT(*) AS count FROM message_attachments").get().count,
        transferLedger: db.prepare("SELECT COUNT(*) AS count FROM transfer_ledger").get().count,
        workspaceEvents: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
        auditLogs: db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count
      };
    } finally {
      db.close();
    }
  }

  function getLatestAudit(action, actorUserId) {
    const db = openTestDatabase(dataDir);
    try {
      return db.prepare(`
        SELECT action, target_type AS targetType, target_id AS targetId, result, reason
        FROM audit_logs
        WHERE action = ?
          AND actor_user_id = ?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(action, actorUserId);
    } finally {
      db.close();
    }
  }

  function getLatestAuditByAction(action) {
    const db = openTestDatabase(dataDir);
    try {
      return db.prepare(`
        SELECT action, target_type AS targetType, target_id AS targetId, result, reason
        FROM audit_logs
        WHERE action = ?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(action);
    } finally {
      db.close();
    }
  }

  function expectNoWorkspaceInternals(payload, extraHiddenValues = []) {
    const serialized = JSON.stringify(payload);
    for (const field of [
      "contentJson",
      "payloadJson",
      "storageKey",
      "uploadTransferId",
      "transferId",
      "requestId",
      "githubId",
      "email",
      "ipAddress",
      "userAgent"
    ]) {
      expect(serialized).not.toContain(field);
    }
    for (const value of extraHiddenValues) {
      expect(serialized).not.toContain(value);
    }
  }

  function readWsJsonFrames(ws, count) {
    return new Promise((resolve, reject) => {
      const frames = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for workspace websocket frame"));
      }, 1000);
      function cleanup() {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        ws.off("error", onError);
      }
      function onMessage(data) {
        frames.push(JSON.parse(data.toString()));
        if (frames.length >= count) {
          cleanup();
          resolve(frames);
        }
      }
      function onError(error) {
        cleanup();
        reject(error);
      }
      ws.on("message", onMessage);
      ws.on("error", onError);
    });
  }

  it("keeps workspace HTTP routes disabled without the feature flag", async () => {
    const app = await makeApp({ WORKSPACE_ENABLED: "false" });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "workspace.disabled",
        message: "共享空间暂未开放"
      }
    });
  });

  it("starts without PostgreSQL when workspace is disabled", async () => {
    const app = await createApp({
      dataDir,
      env: {
        WORKSPACE_ENABLED: "false",
        NODE_ENV: "test",
        SERVE_STATIC: "false"
      },
      logger: false
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });

    expect(health.statusCode).toBe(200);
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
  });

  it("keeps health responses free of local storage paths", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "duallane",
      lane: "ready"
    });
  });

  it("keeps workspace websocket disabled without the feature flag", async () => {
    const app = await makeApp({ WORKSPACE_ENABLED: "false" });
    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    const close = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for disabled workspace websocket close"));
      }, 1000);
      function cleanup() {
        clearTimeout(timeout);
        ws.off("close", onClose);
        ws.off("error", onError);
      }
      function onClose(code, reason) {
        cleanup();
        resolve({ code, reason: reason.toString() });
      }
      function onError(error) {
        cleanup();
        reject(error);
      }
      ws.on("close", onClose);
      ws.on("error", onError);
    });

    expect(close).toEqual({ code: 1013, reason: "workspace disabled" });
  });

  it("redirects development root entry requests to the frontend server", async () => {
    const app = await makeApp({ WORKSPACE_FRONTEND_URL: "http://127.0.0.1:5174" });
    const response = await app.inject({
      method: "GET",
      url: "/?lane=workspace"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:5174/?lane=workspace");
  });

  it("redirects development root entry requests with default static settings", async () => {
    const db = openTestDatabase(dataDir);
    const app = await createApp({
      dataDir,
      db,
      env: {
        WORKSPACE_ENABLED: "true",
        NODE_ENV: "development",
        WORKSPACE_FRONTEND_URL: "http://127.0.0.1:5175"
      },
      logger: false
    });
    app.addHook("onClose", async () => db.close());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/?lane=workspace"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:5175/?lane=workspace");
  });

  it("redirects development GitHub login directly to the callback fallback", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?invite=INVITE-1"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/api/auth/github/callback");
    expect(response.headers.location).toContain("githubLogin=timeStarry");
    expect(response.cookies.some((cookie) => cookie.name === "duallane_pending_invite" && cookie.value === "INVITE-1")).toBe(true);
  });

  it("redirects successful development callback back to the frontend dev server", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry",
      cookies: {
        duallane_oauth_state: "dev-state"
      }
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:5173/?lane=workspace");
    expect(response.cookies.some((cookie) => cookie.name === "duallane_oauth_state" && cookie.value === "")).toBe(true);
  });

  it("rejects GitHub id rebinding through the callback with a safe error", async () => {
    const app = await makeApp();
    const firstLogin = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubId=route-stable-owner&githubLogin=timeStarry&email=timestarry%40qq.com"
    });
    expect(firstLogin.statusCode).toBe(200);

    const conflictingLogin = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubId=route-different-owner&githubLogin=timeStarry&email=other-owner%40example.com"
    });
    expect(conflictingLogin.statusCode).toBe(401);
    expect(conflictingLogin.json()).toEqual({
      error: {
        code: "auth.identity_conflict",
        message: "GitHub 身份与已有账号不一致，请联系空间主人"
      }
    });

    const db = openTestDatabase(dataDir);
    try {
      expect(db.prepare("SELECT github_id AS githubId FROM users WHERE id = 'usr_owner'").get()).toEqual({
        githubId: "route-stable-owner"
      });
      expect(db.prepare(`
        SELECT result, reason
        FROM audit_logs
        WHERE action = 'login.rejected'
        ORDER BY rowid DESC
        LIMIT 1
      `).get()).toEqual({ result: "rejected", reason: "auth.identity_conflict" });
    } finally {
      db.close();
    }
  });

  it("uses the configured workspace frontend URL for OAuth callback redirects", async () => {
    const app = await makeApp({ WORKSPACE_FRONTEND_URL: "http://127.0.0.1:5174/app/" });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry",
      cookies: {
        duallane_oauth_state: "dev-state"
      }
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:5174/?lane=workspace");
  });

  it("accepts a pending invite during GitHub callback", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "PENDING-OAUTH",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubLogin=pending-oauth&email=pending-oauth%40example.com&displayName=Pending%20OAuth",
      cookies: {
        duallane_oauth_state: "dev-state",
        duallane_pending_invite: "PENDING-OAUTH"
      }
    });

    expect(callback.statusCode).toBe(200);
    expect(callback.json().user).toMatchObject({
      githubLogin: "pending-oauth",
      role: "member"
    });
    expect(callback.json().user.email).toBeUndefined();
    expect(callback.json().user.githubId).toBeUndefined();
    expect(callback.cookies.some((cookie) => cookie.name === "duallane_pending_invite" && cookie.value === "")).toBe(true);
    expect(callback.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value)).toBe(true);
  });

  it("clears invalid pending invite cookies during GitHub callback without creating a session", async () => {
    const app = await makeApp();
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubLogin=bad-pending-oauth&email=bad-pending-oauth%40example.com&displayName=Bad%20Pending",
      cookies: {
        duallane_oauth_state: "dev-state",
        duallane_pending_invite: "MISSING-PENDING-OAUTH"
      }
    });

    expect(callback.statusCode).toBe(400);
    expect(callback.json().error.code).toBe("invite.invalid");
    expect(callback.cookies.some((cookie) => cookie.name === "duallane_pending_invite" && cookie.value === "")).toBe(true);
    expect(callback.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value)).toBe(false);
    expectNoWorkspaceInternals(callback.json(), ["bad-pending-oauth@example.com", "MISSING-PENDING-OAUTH"]);
  });

  it("revokes workspace sessions on logout", async () => {
    const app = await makeApp();
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry",
      cookies: {
        duallane_oauth_state: "dev-state"
      }
    });
    expect(callback.statusCode).toBe(200);
    const sessionCookie = callback.cookies.find((cookie) => cookie.name === "duallane_workspace");
    expect(sessionCookie?.value).toBeTruthy();

    const authed = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      cookies: {
        duallane_workspace: sessionCookie.value
      }
    });
    expect(authed.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: {
        duallane_workspace: sessionCookie.value
      }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(logout.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value === "")).toBe(true);

    const rejected = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      cookies: {
        duallane_workspace: sessionCookie.value
      }
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("auth.required");
  });

  it("does not accept the workspace user header in production", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth.required");
  });

  it("does not expose request ids in workspace client errors", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "auth.required",
        message: "请先登录共享空间"
      }
    });
  });

  it("requires complete GitHub OAuth config in production", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "" });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/start"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("auth.github_not_configured");
  });

  it("marks OAuth cookies secure behind the trusted HTTPS proxy", async () => {
    const app = await makeApp({
      NODE_ENV: "production",
      TRUST_PROXY: "true",
      PUBLIC_BASE_URL: "https://duallane.example",
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-secret"
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?invite=SECURE-INVITE",
      headers: {
        host: "duallane.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(response.statusCode).toBe(302);
    expect(response.cookies.find((cookie) => cookie.name === "duallane_oauth_state")?.secure).toBe(true);
    expect(response.cookies.find((cookie) => cookie.name === "duallane_pending_invite")?.secure).toBe(true);
  });

  it("rejects production GitHub callback without OAuth state", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?code=abc"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("auth.invalid_state");
    expect(response.cookies.some((cookie) => cookie.name === "duallane_oauth_state" && cookie.value === "")).toBe(true);
  });

  it("rejects production GitHub callback when OAuth state does not match", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?code=abc&state=returned-state",
      cookies: {
        duallane_oauth_state: "stored-state"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "auth.invalid_state",
        message: "登录状态校验失败"
      }
    });
    expect(response.cookies.some((cookie) => cookie.name === "duallane_oauth_state" && cookie.value === "")).toBe(true);
    expect(response.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value)).toBe(false);
  });

  it("bounds the complete GitHub OAuth exchange and returns a stable safe error", async () => {
    const callbackCode = "timeout-callback-code";
    const callbackState = "timeout-callback-state";
    const clientSecret = "timeout-client-secret";
    const observedSignals = [];
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
      expect(options.headers["user-agent"]).toBe("DualLane/0.1");
      observedSignals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    const app = await makeApp({
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "timeout-client-id",
      GITHUB_CLIENT_SECRET: clientSecret
    }, {
      fetchImpl,
      githubOAuthTimeoutMs: 25
    });

    const startedAt = performance.now();
    const response = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?format=json&code=${callbackCode}&state=${callbackState}`,
      cookies: {
        duallane_oauth_state: callbackState
      }
    });

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "auth.github_failed",
        message: "GitHub 登录失败"
      }
    });
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0].aborted).toBe(true);
    expect(response.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value)).toBe(false);
    expectNoWorkspaceInternals(response.json(), [callbackCode, callbackState, clientSecret, "TimeoutError"]);
    expect(getLatestAuditByAction("login.rejected")).toEqual({
      action: "login.rejected",
      targetType: "github_oauth",
      targetId: "token",
      result: "rejected",
      reason: "auth.github_failed"
    });
  });

  it("bounds invalid GitHub OAuth timeout configuration without returning an internal error", async () => {
    const callbackState = "oversized-timeout-state";
    const app = await makeApp({
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "oversized-timeout-client-id",
      GITHUB_CLIENT_SECRET: "oversized-timeout-client-secret",
      GITHUB_OAUTH_TIMEOUT_MS: "4294967296"
    }, {
      fetchImpl: async () => new Response(null, { status: 503 })
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?format=json&code=oversized-timeout-code&state=${callbackState}`,
      cookies: {
        duallane_oauth_state: callbackState
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("auth.github_failed");
  });

  it.each([
    ["token", "https://github.com/login/oauth/access_token"],
    ["profile", "https://api.github.com/user"],
    ["email", "https://api.github.com/user/emails"]
  ])("maps GitHub %s upstream failures to the same safe error", async (_phase, failingUrl) => {
    const callbackCode = "provider-callback-code";
    const callbackState = "provider-callback-state";
    const clientSecret = "provider-client-secret";
    const accessToken = "provider-access-token";
    const providerMessage = "provider-sensitive-error-body";
    const observedSignals = [];
    const fetchImpl = async (url, options) => {
      expect(options.headers["user-agent"]).toBe("DualLane/0.1");
      observedSignals.push(options.signal);
      if (url === failingUrl) {
        return new Response(JSON.stringify({ message: providerMessage, token: accessToken }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: accessToken });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 12345, login: "provider-user", email: null });
      }
      return Response.json([{ email: "provider-user@example.com", primary: true, verified: true }]);
    };
    const app = await makeApp({
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "provider-client-id",
      GITHUB_CLIENT_SECRET: clientSecret
    }, { fetchImpl });

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?format=json&code=${callbackCode}&state=${callbackState}`,
      cookies: {
        duallane_oauth_state: callbackState
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "auth.github_failed",
        message: "GitHub 登录失败"
      }
    });
    expect(new Set(observedSignals).size).toBe(1);
    expect(response.cookies.some((cookie) => cookie.name === "duallane_workspace" && cookie.value)).toBe(false);
    expectNoWorkspaceInternals(response.json(), [
      callbackCode,
      callbackState,
      clientSecret,
      accessToken,
      providerMessage
    ]);
    expect(getLatestAuditByAction("login.rejected")).toEqual({
      action: "login.rejected",
      targetType: "github_oauth",
      targetId: _phase,
      result: "rejected",
      reason: "auth.github_failed"
    });
  });

  it("keeps GitHub callback secrets out of default application logs", async () => {
    const callbackCode = "logger-callback-code";
    const callbackState = "logger-callback-state";
    const cookieSecret = "logger-cookie-secret";
    const authorizationSecret = "logger-authorization-secret";
    const clientSecret = "logger-client-secret";
    let logOutput = "";
    const app = await makeApp({
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "logger-client-id",
      GITHUB_CLIENT_SECRET: clientSecret
    }, {
      fetchImpl: async () => new Response(null, { status: 503 }),
      useDefaultLogger: true,
      loggerStream: {
        write(chunk) {
          logOutput += String(chunk);
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?format=json&code=${callbackCode}&state=${callbackState}`,
      headers: {
        authorization: `Bearer ${authorizationSecret}`,
        cookie: `duallane_oauth_state=${callbackState}; extra=${cookieSecret}`
      }
    });

    expect(response.statusCode).toBe(502);
    expect(logOutput).toContain('"url":"/api/auth/github/callback"');
    expect(logOutput).toContain('"event":"github_oauth_failed"');
    expect(logOutput).toContain('"phase":"token"');
    for (const secret of [callbackCode, callbackState, cookieSecret, authorizationSecret, clientSecret]) {
      expect(logOutput).not.toContain(secret);
    }
  });

  it("requires GitHub login for direct invite acceptance in production", async () => {
    const app = await makeApp({ NODE_ENV: "production", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/CODE/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "member"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth.github_required");
    expect(getLatestAuditByAction("invite.accept")).toEqual({
      action: "invite.accept",
      targetType: "invite",
      targetId: null,
      result: "rejected",
      reason: "auth.github_required"
    });
  });

  it("returns product invite links and expiry on invite creation", async () => {
    const app = await makeApp({ WORKSPACE_FRONTEND_URL: "http://127.0.0.1:5174/app/" });
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-INVITE-LINK",
        defaultRole: "member",
        maxUses: 1,
        expiresInHours: 24
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().invite).toMatchObject({
      code: "ROUTE-INVITE-LINK",
      defaultRole: "member",
      maxUses: 1,
      uses: 0,
      inviteUrl: "http://127.0.0.1:5174/?lane=workspace&invite=ROUTE-INVITE-LINK"
    });
    expect(response.json().invite.expiresAt).toBeTruthy();
    expectNoWorkspaceInternals(response.json(), ["timestarry@qq.com"]);
  });

  it("lists workspace members with route-level filtering", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-member",
        email: "route-member@example.com",
        displayName: "Route Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user.email).toBeUndefined();
    expect(accepted.json().user.githubId).toBeUndefined();
    expectNoWorkspaceInternals(accepted.json(), ["route-member@example.com"]);

    const members = await app.inject({
      method: "GET",
      url: "/api/workspace/members?q=route&role=member&kind=human&limit=1",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(members.statusCode).toBe(200);
    expect(members.json().members.map((member) => member.githubLogin)).toEqual(["route-member"]);
    expect(members.json().members[0]).toMatchObject({
      roleLabel: "成员",
      capabilities: {
        canStartDirectConversation: true
      }
    });
    expectNoWorkspaceInternals(members.json(), ["route-member@example.com"]);
  });

  it("enforces contact-scoped member discovery and owner-managed visibility routes", async () => {
    const app = await makeApp();
    for (const fixture of [
      { code: "ROUTE-VISIBLE-MEMBER", login: "route-visible-member", name: "Route Visible Member" },
      { code: "ROUTE-HIDDEN-MEMBER", login: "route-hidden-member", name: "Route Hidden Member" }
    ]) {
      expect((await app.inject({
        method: "POST",
        url: "/api/workspace/invites",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: { code: fixture.code, defaultRole: "member", maxUses: 1 }
      })).statusCode).toBe(201);
      expect((await app.inject({
        method: "POST",
        url: `/api/workspace/invites/${fixture.code}/accept`,
        headers: { "content-type": "application/json" },
        payload: {
          githubLogin: fixture.login,
          email: `${fixture.login}@example.com`,
          displayName: fixture.name
        }
      })).statusCode).toBe(201);
    }

    const db = openTestDatabase(dataDir);
    const visibleUserId = db.prepare("SELECT id FROM users WHERE github_login = 'route-visible-member'").get().id;
    const hiddenUserId = db.prepare("SELECT id FROM users WHERE github_login = 'route-hidden-member'").get().id;
    db.close();

    const initial = await app.inject({
      method: "GET",
      url: "/api/workspace/members",
      headers: { "x-workspace-user-id": visibleUserId }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().members.map((member) => member.id)).toEqual([visibleUserId]);

    expect((await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: { type: "direct", targetUserId: visibleUserId }
    })).statusCode).toBe(201);

    const contacts = await app.inject({
      method: "GET",
      url: "/api/workspace/members",
      headers: { "x-workspace-user-id": visibleUserId }
    });
    expect(contacts.statusCode).toBe(200);
    expect(contacts.json().members.map((member) => member.id)).toEqual(
      expect.arrayContaining([visibleUserId, "usr_owner"])
    );
    expect(contacts.json().members.map((member) => member.id)).not.toContain(hiddenUserId);
    expect(contacts.json().members.find((member) => member.id === "usr_owner")).toMatchObject({
      role: "admin",
      roleLabel: "管理员"
    });

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/workspace/member-visibility/${visibleUserId}`,
      headers: { "x-workspace-user-id": visibleUserId }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("permission.denied");

    const granted = await app.inject({
      method: "PUT",
      url: `/api/workspace/member-visibility/${visibleUserId}`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: { visibleUserIds: [hiddenUserId] }
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().visibility).toMatchObject({
      viewerUserId: visibleUserId,
      grantedUserIds: [hiddenUserId]
    });

    const afterGrant = await app.inject({
      method: "GET",
      url: "/api/workspace/members",
      headers: { "x-workspace-user-id": visibleUserId }
    });
    expect(afterGrant.json().members.map((member) => member.id)).toContain(hiddenUserId);
    expectNoWorkspaceInternals(afterGrant.json(), [
      "route-visible-member@example.com",
      "route-hidden-member@example.com"
    ]);
  });

  it("revokes invites through workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-REVOKE-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);
    const inviteId = invite.json().invite.id;

    const revoked = await app.inject({
      method: "POST",
      url: `/api/workspace/invites/${inviteId}/revoke`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().invite).toMatchObject({ id: inviteId });
    expect(revoked.json().invite.revokedAt).toBeTruthy();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-REVOKE-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-revoked-member",
        email: "route-revoked-member@example.com"
      }
    });
    expect(accepted.statusCode).toBe(400);
    expect(accepted.json().error.code).toBe("invite.invalid");
    expectNoWorkspaceInternals(accepted.json(), [
      inviteId,
      "ROUTE-REVOKE-MEMBER",
      "route-revoked-member@example.com"
    ]);
  });

  it("rejects normal member invite management routes with safe errors and operation records", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-INVITE-ACTOR",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-INVITE-ACTOR/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-invite-actor",
        email: "route-invite-actor@example.com",
        displayName: "Route Invite Actor"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const createRejected = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        code: "MEMBER-CREATED-CODE",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(createRejected.statusCode).toBe(403);
    expect(createRejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(createRejected.json(), [
      "MEMBER-CREATED-CODE",
      "route-invite-actor@example.com"
    ]);
    expect(getLatestAudit("invite.create", memberId)).toEqual({
      action: "invite.create",
      targetType: "invite",
      targetId: null,
      result: "rejected",
      reason: "insufficient permission"
    });

    const targetInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-INVITE-TARGET",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(targetInvite.statusCode).toBe(201);
    const targetInviteId = targetInvite.json().invite.id;

    const revokeRejected = await app.inject({
      method: "POST",
      url: `/api/workspace/invites/${targetInviteId}/revoke`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(revokeRejected.statusCode).toBe(403);
    expect(revokeRejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(revokeRejected.json(), [
      targetInviteId,
      "ROUTE-INVITE-TARGET",
      "route-invite-actor@example.com"
    ]);
    expect(getLatestAudit("invite.revoke", memberId)).toEqual({
      action: "invite.revoke",
      targetType: "invite",
      targetId: targetInviteId,
      result: "rejected",
      reason: "insufficient permission"
    });

    const db = openTestDatabase(dataDir);
    try {
      const target = db.prepare("SELECT revoked_at AS revokedAt FROM invites WHERE id = ?").get(targetInviteId);
      expect(target.revokedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("records missing invite revocation attempts with safe route errors", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/missing-route-invite/revoke",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invite.not_found");
    expectNoWorkspaceInternals(response.json(), ["timestarry@qq.com"]);
    expect(getLatestAudit("invite.revoke", "usr_owner")).toEqual({
      action: "invite.revoke",
      targetType: "invite",
      targetId: "missing-route-invite",
      result: "rejected",
      reason: "invite not found"
    });
  });

  it("updates member roles through owner-only workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-ROLE-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-ROLE-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-role-member",
        email: "route-role-member@example.com",
        displayName: "Route Role Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/workspace/members/${memberId}/role`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        role: "admin"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().member.role).toBe("admin");

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/workspace/members/usr_owner/role`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        role: "member"
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(rejected.json(), ["usr_owner", "route-role-member@example.com"]);
    expect(getLatestAudit("member.role_update", memberId)).toEqual({
      action: "member.role_update",
      targetType: "member",
      targetId: "usr_owner",
      result: "rejected",
      reason: "insufficient permission"
    });

    const removeRejected = await app.inject({
      method: "DELETE",
      url: "/api/workspace/members/usr_owner",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(removeRejected.statusCode).toBe(403);
    expect(removeRejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(removeRejected.json(), ["usr_owner", "route-role-member@example.com"]);
    expect(getLatestAudit("member.remove", memberId)).toEqual({
      action: "member.remove",
      targetType: "member",
      targetId: "usr_owner",
      result: "rejected",
      reason: "insufficient permission"
    });
  });

  it("rejects self role updates through workspace routes", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/workspace/members/usr_owner/role",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        role: "member"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("member.role_invalid");
    expectNoWorkspaceInternals(response.json(), ["timestarry@qq.com"]);
    expect(getLatestAudit("member.role_update", "usr_owner")).toEqual({
      action: "member.role_update",
      targetType: "member",
      targetId: "usr_owner",
      result: "rejected",
      reason: "self role update"
    });
  });

  it("removes space members through owner-only workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-REMOVE-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-REMOVE-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-remove-member",
        email: "route-remove-member@example.com",
        displayName: "Route Remove Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/members/${memberId}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, userId: memberId });

    const members = await app.inject({
      method: "GET",
      url: "/api/workspace/members",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members.map((member) => member.id)).not.toContain(memberId);

    const rejected = await app.inject({
      method: "DELETE",
      url: "/api/workspace/members/usr_owner",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("auth.required");
  });

  it("rejects self removal through workspace routes", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/workspace/members/usr_owner",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("member.remove_invalid");
    expectNoWorkspaceInternals(response.json(), ["timestarry@qq.com"]);
    expect(getLatestAudit("member.remove", "usr_owner")).toEqual({
      action: "member.remove",
      targetType: "member",
      targetId: "usr_owner",
      result: "rejected",
      reason: "self removal"
    });

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().auth.currentUser.role).toBe("owner");
  });

  it("manages group members through workspace routes and rejects normal members", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-GROUP-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-GROUP-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-group-member",
        email: "route-group-member@example.com",
        displayName: "Route Group Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Managed Group"
      }
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().conversation.id;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/workspace/groups/${conversationId}/members`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        userId: memberId
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(rejected.json(), [
      conversationId,
      "Route Managed Group",
      "route-group-member@example.com"
    ]);
    expect(getLatestAudit("conversation.member.manage", memberId)).toEqual({
      action: "conversation.member.manage",
      targetType: "conversation",
      targetId: conversationId,
      result: "rejected",
      reason: "insufficient permission"
    });

    const renameRejected = await app.inject({
      method: "PATCH",
      url: `/api/workspace/groups/${conversationId}`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        title: "Member leaked rename"
      }
    });
    expect(renameRejected.statusCode).toBe(403);
    expect(renameRejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(renameRejected.json(), [
      conversationId,
      "Member leaked rename",
      "Route Managed Group",
      "route-group-member@example.com"
    ]);
    expect(getLatestAudit("conversation.member.manage", memberId)).toEqual({
      action: "conversation.member.manage",
      targetType: "conversation",
      targetId: conversationId,
      result: "rejected",
      reason: "insufficient permission"
    });

    const added = await app.inject({
      method: "POST",
      url: `/api/workspace/groups/${conversationId}/members`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        userId: memberId
      }
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().conversation.members.map((member) => member.id)).toContain(memberId);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/groups/${conversationId}/members/${memberId}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().conversation.members.map((member) => member.id)).not.toContain(memberId);
  });

  it("renames group conversations through workspace routes", async () => {
    const app = await makeApp();
    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Old route group"
      }
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().conversation.id;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/workspace/groups/${conversationId}`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        title: "New route group"
      }
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().conversation.title).toBe("New route group");
  });

  it("returns conversation details only to active conversation members", async () => {
    const app = await makeApp();
    const invited = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-DETAIL-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invited.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-DETAIL-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubId: "route-detail-provider-id",
        githubLogin: "route-detail-member",
        email: "route-detail-member@example.com",
        displayName: "Route Detail Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Detail Group",
        memberIds: [memberId]
      }
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().conversation.id;

    const detail = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().conversation).toMatchObject({
      id: conversationId,
      title: "Route Detail Group",
      type: "group"
    });
    expect(detail.json().conversation.members.map((member) => member.id)).toContain(memberId);
    expectNoWorkspaceInternals(detail.json(), ["route-detail-member@example.com", "route-detail-provider-id"]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/groups/${conversationId}/members/${memberId}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: {
        code: "conversation.not_found",
        message: "你无法访问此会话"
      }
    });
    expectNoWorkspaceInternals(denied.json(), [conversationId, "Route Detail Group"]);
  });

  it("rejects reserved auditor conversation content routes without leaking content", async () => {
    const app = await makeApp();
    const auditorInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-AUDITOR-NO-CHAT",
        defaultRole: "auditor",
        maxUses: 1
      }
    });
    expect(auditorInvite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-AUDITOR-NO-CHAT/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubId: "route-auditor-provider-id",
        githubLogin: "route-auditor-no-chat",
        email: "route-auditor-no-chat@example.com",
        displayName: "Route Auditor No Chat"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const auditorId = accepted.json().user.id;

    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Auditor Hidden Group",
        memberIds: [auditorId]
      }
    });
    expect(group.statusCode).toBe(400);
    expect(group.json().error.code).toBe("member.not_chat_participant");
    expectNoWorkspaceInternals(group.json(), [
      "Route Auditor Hidden Group",
      "route-auditor-no-chat@example.com",
      "route-auditor-provider-id"
    ]);

    const validGroup = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Auditor Hidden Group"
      }
    });
    expect(validGroup.statusCode).toBe(201);
    const conversationId = validGroup.json().conversation.id;

    const message = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        clientMessageId: "route-auditor-hidden-message",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "Route auditor secret content",
          blocks: [{ type: "text", text: "Route auditor secret content" }]
        }
      }
    });
    expect(message.statusCode).toBe(201);

    const deniedList = await app.inject({
      method: "GET",
      url: "/api/workspace/conversations",
      headers: {
        "x-workspace-user-id": auditorId
      }
    });
    expect(deniedList.statusCode).toBe(403);
    expect(deniedList.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(deniedList.json(), [
      "Route Auditor Hidden Group",
      "Route auditor secret content",
      "route-auditor-no-chat@example.com",
      "route-auditor-provider-id"
    ]);

    const deniedDetail = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}`,
      headers: {
        "x-workspace-user-id": auditorId
      }
    });
    expect(deniedDetail.statusCode).toBe(403);
    expect(deniedDetail.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(deniedDetail.json(), [
      "Route Auditor Hidden Group",
      "Route auditor secret content",
      "route-auditor-no-chat@example.com",
      "route-auditor-provider-id"
    ]);

    const deniedMessages = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}/messages`,
      headers: {
        "x-workspace-user-id": auditorId
      }
    });
    expect(deniedMessages.statusCode).toBe(403);
    expect(deniedMessages.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(deniedMessages.json(), [
      "Route Auditor Hidden Group",
      "Route auditor secret content",
      "route-auditor-no-chat@example.com",
      "route-auditor-provider-id"
    ]);

    const deniedRead = await app.inject({
      method: "POST",
      url: `/api/workspace/conversations/${conversationId}/read`,
      headers: {
        "x-workspace-user-id": auditorId
      }
    });
    expect(deniedRead.statusCode).toBe(403);
    expect(deniedRead.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(deniedRead.json(), [
      "Route Auditor Hidden Group",
      "Route auditor secret content",
      "route-auditor-no-chat@example.com",
      "route-auditor-provider-id"
    ]);

    expect(getLatestAudit("conversation.read", auditorId)).toEqual({
      action: "conversation.read",
      targetType: "conversation",
      targetId: conversationId,
      result: "rejected",
      reason: "insufficient permission"
    });
  });

  it("lets a group member leave through workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-LEAVE-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-LEAVE-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-leave-member",
        email: "route-leave-member@example.com",
        displayName: "Route Leave Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Leave Group",
        memberIds: [memberId]
      }
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().conversation.id;

    const leave = await app.inject({
      method: "POST",
      url: `/api/workspace/groups/${conversationId}/leave`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(leave.statusCode).toBe(200);
    expect(leave.json()).toEqual({ ok: true, conversationId });

    const conversations = await app.inject({
      method: "GET",
      url: "/api/workspace/conversations",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json().conversations.map((item) => item.id)).not.toContain(conversationId);
  });

  it("rejects stale download ids after group access is removed", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-DOWNLOAD-LOSS",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-DOWNLOAD-LOSS/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-download-loss",
        email: "route-download-loss@example.com",
        displayName: "Route Download Loss"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const group = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Download Loss",
        memberIds: [memberId]
      }
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().conversation.id;
    const content = Buffer.from("group file access loss", "utf8");

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "group-access-loss.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "conversation",
        conversationId
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const downloadReserve = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(downloadReserve.statusCode).toBe(201);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/groups/${conversationId}/members/${memberId}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);

    const staleDownload = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/download?downloadId=${downloadReserve.json().id}`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(staleDownload.statusCode).toBe(403);
    expect(staleDownload.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(staleDownload.json(), [
      conversationId,
      upload.attachment.id,
      downloadReserve.json().id,
      "Route Download Loss",
      "group-access-loss.txt",
      "group file access loss"
    ]);

    const db = openTestDatabase(dataDir);
    try {
      const audit = db.prepare(`
        SELECT result, reason
        FROM audit_logs
        WHERE actor_user_id = ?
          AND action = 'file.download'
          AND target_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(memberId, upload.attachment.id);
      expect(audit).toEqual({ result: "rejected", reason: "not a conversation member" });
    } finally {
      db.close();
    }
  });

  it("marks conversations as read through workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-READ-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-READ-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-read-member",
        email: "route-read-member@example.com",
        displayName: "Route Read Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const direct = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "direct",
        targetUserId: memberId
      }
    });
    expect(direct.statusCode).toBe(201);
    const conversationId = direct.json().conversation.id;
    expect(direct.json().conversation).toMatchObject({
      displayTitle: "Route Read Member",
      otherMember: {
        id: memberId,
        displayName: "Route Read Member"
      }
    });

    const message = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        clientMessageId: "route-unread-1",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "Unread route message",
          blocks: [{ type: "text", text: "Unread route message" }]
        }
      }
    });
    expect(message.statusCode).toBe(201);

    const beforeRead = await app.inject({
      method: "GET",
      url: "/api/workspace/conversations",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(beforeRead.statusCode).toBe(200);
    const listedConversation = beforeRead.json().conversations.find((item) => item.id === conversationId);
    expect(listedConversation).toMatchObject({
      displayTitle: "timeStarry",
      otherMember: {
        id: "usr_owner",
        displayName: "timeStarry"
      },
      memberCount: 2,
      lastMessagePlainText: "Unread route message",
      retentionText: "保留最近 10000 条消息",
      unreadCount: 1,
      lastReadSeq: null,
      notificationLevel: "all",
      capabilities: {
        canSendMessage: true,
        canUploadFile: true,
        canManageMembers: false
      }
    });
    expect(listedConversation.lastMessageAt).toBeTruthy();
    expectNoWorkspaceInternals(listedConversation);

    const read = await app.inject({
      method: "POST",
      url: `/api/workspace/conversations/${conversationId}/read`,
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().conversation.unreadCount).toBe(0);
    expect(read.json().conversation.lastReadSeq).toBeGreaterThan(0);
    expect(read.json().conversation.notificationLevel).toBe("all");
  });

  it("updates conversation notification levels through workspace routes", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-NOTIFY-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-NOTIFY-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-notify-member",
        email: "route-notify-member@example.com",
        displayName: "Route Notify Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const direct = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "direct",
        targetUserId: memberId
      }
    });
    expect(direct.statusCode).toBe(201);
    const conversationId = direct.json().conversation.id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/workspace/conversations/${conversationId}/notification`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        level: "mentions"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().conversation.notificationLevel).toBe("mentions");
    expectNoWorkspaceInternals(updated.json(), ["route-notify-member@example.com"]);

    const memberList = await app.inject({
      method: "GET",
      url: "/api/workspace/conversations",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(memberList.statusCode).toBe(200);
    expect(memberList.json().conversations.find((item) => item.id === conversationId).notificationLevel).toBe("mentions");

    const ownerList = await app.inject({
      method: "GET",
      url: "/api/workspace/conversations",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(ownerList.statusCode).toBe(200);
    expect(ownerList.json().conversations.find((item) => item.id === conversationId).notificationLevel).toBe("all");

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/workspace/conversations/${conversationId}/notification`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        level: "loud"
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("conversation.notification_invalid");
  });

  it("derives message authors from the authenticated workspace actor", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-ACTOR-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-ACTOR-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-actor-member",
        email: "route-actor-member@example.com",
        displayName: "Route Actor Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const direct = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "direct",
        targetUserId: memberId
      }
    });
    expect(direct.statusCode).toBe(201);
    const conversationId = direct.json().conversation.id;

    const forged = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        authorId: "usr_owner",
        authorKind: "bot",
        kind: "bot",
        ai: {
          provider: "forged"
        },
        conversationId,
        clientMessageId: "route-forged-author",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "Actor must come from request",
          blocks: [{ type: "text", text: "Actor must come from request" }]
        }
      }
    });
    expect(forged.statusCode).toBe(201);
    expect(forged.json().message.authorId).toBe(memberId);
    expect(forged.json().message.authorId).not.toBe("usr_owner");
    expect(forged.json().message.authorKind).toBe("human");
    expect(forged.json().message.kind).toBe("user");
    expect(forged.json().message.ai).toBeUndefined();

    const db = openTestDatabase(dataDir);
    try {
      const audit = db.prepare(`
        SELECT actor_user_id AS actorUserId
        FROM audit_logs
        WHERE action = 'message.create' AND target_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(conversationId);
      expect(audit.actorUserId).toBe(memberId);
    } finally {
      db.close();
    }
  });

  it("rejects malformed structured message blocks without persisting raw content", async () => {
    const app = await makeApp();
    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Invalid Blocks"
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const rejected = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        clientMessageId: "route-invalid-block",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "raw client fallback must not persist",
          blocks: [
            {
              type: "raw",
              text: "raw client fallback must not persist",
              storageKey: "workspace/spc_default/leak"
            }
          ]
        }
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({
      error: {
        code: "message.invalid_block",
        message: "消息块格式无效"
      }
    });
    expectNoWorkspaceInternals(rejected.json(), ["raw client fallback must not persist"]);

    const db = openTestDatabase(dataDir);
    try {
      const persisted = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?").get("route-invalid-block");
      expect(persisted.count).toBe(0);
      const audit = db.prepare(`
        SELECT result, reason
        FROM audit_logs
        WHERE actor_user_id = 'usr_owner'
          AND action = 'message.create'
          AND target_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(conversationId);
      expect(audit).toEqual({ result: "rejected", reason: "message.invalid_block" });
    } finally {
      db.close();
    }
  });

  it("loads older conversation messages through before cursor", async () => {
    const app = await makeApp();
    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route message history"
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const created = [];
    for (const text of ["one", "two", "three", "four"]) {
      const message = await app.inject({
        method: "POST",
        url: "/api/workspace/messages",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          conversationId,
          clientMessageId: `route-history-${text}`,
          content: {
            format: "duallane.message+json;v=1",
            plainText: text,
            blocks: [{ type: "text", text }]
          }
        }
      });
      expect(message.statusCode).toBe(201);
      created.push(message.json().message);
    }

    const latest = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}/messages?limit=2`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().messages.map((message) => message.plainText)).toEqual(["three", "four"]);

    const older = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}/messages?before=${created[2].id}&limit=2`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(older.statusCode).toBe(200);
    expect(older.json().messages.map((message) => message.plainText)).toEqual(["one", "two"]);
  });

  it("streams workspace realtime ready and event frames", async () => {
    const app = await makeApp();
    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 2);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: 0 }));
      const [ready, event] = await frames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        spaceId: "spc_default",
        replayFrom: 1
      });
      expect(ready.currentSeq).toBeGreaterThanOrEqual(1);
      expect(ready.replayCount).toBeGreaterThanOrEqual(1);

      expect(event).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "workspace.member_joined",
          target: {
            type: "user",
            id: "usr_owner"
          }
        }
      });
      expect(event.event.payloadJson).toBeUndefined();
    } finally {
      ws.terminate();
    }
  });

  it("pushes new workspace events to connected realtime clients", async () => {
    const app = await makeApp();
    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const pushedFrames = readWsJsonFrames(ws, 1);
      const conversation = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "group",
          title: "Realtime push"
        }
      });
      expect(conversation.statusCode).toBe(201);
      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "conversation.created",
          target: {
            type: "conversation",
            id: conversation.json().conversation.id
          }
        }
      });
      expect(frame.event.payloadJson).toBeUndefined();
      expect(JSON.stringify(frame)).not.toContain("requestId");
    } finally {
      ws.terminate();
    }
  });

  it("delivers workspace events persisted while hello replay switches to live updates", async () => {
    let signalReplayStarted;
    let releaseReplay;
    const replayStarted = new Promise((resolve) => {
      signalReplayStarted = resolve;
    });
    const replayReleased = new Promise((resolve) => {
      releaseReplay = resolve;
    });
    let replayBlocked = false;
    const app = await makeApp({}, {
      wrapDb(rawDb) {
        return {
          prepare(sql) {
            const statement = rawDb.prepare(sql);
            if (!replayBlocked && sql.includes("FROM workspace_events") && sql.includes("seq > ?")) {
              return {
                async all(...params) {
                  const rows = statement.all(...params);
                  replayBlocked = true;
                  signalReplayStarted();
                  await replayReleased;
                  return rows;
                }
              };
            }
            return statement;
          },
          transaction: rawDb.transaction,
          lock: rawDb.lock
        };
      }
    });
    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 4);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      await replayStarted;

      const conversation = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "group",
          title: "Hello replay race"
        }
      });
      expect(conversation.statusCode).toBe(201);
      releaseReplay();

      const [ready, ...events] = await frames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        currentSeq,
        replayCount: 0
      });
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.event.seq)).toEqual([currentSeq + 1, currentSeq + 2, currentSeq + 3]);
      expect(events.map((event) => event.event.type)).toEqual([
        "conversation.created",
        "conversation.member_added",
        "message.created"
      ]);
      expect(events[0]).toMatchObject({
        version: 1,
        type: "event",
        event: {
          seq: currentSeq + 1,
          type: "conversation.created",
          payload: {
            conversation: {
              id: conversation.json().conversation.id,
              title: "Hello replay race"
            }
          }
        }
      });
    } finally {
      releaseReplay();
      ws.terminate();
    }
  });

  it("projects realtime member payload capabilities for the receiving member", async () => {
    const app = await makeApp();
    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const pushedFrames = readWsJsonFrames(ws, 1);
      const invite = await app.inject({
        method: "POST",
        url: "/api/workspace/invites",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          code: "REALTIME-MEMBER-CAPABILITY",
          defaultRole: "member",
          maxUses: 1
        }
      });
      expect(invite.statusCode).toBe(201);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/workspace/invites/REALTIME-MEMBER-CAPABILITY/accept",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          githubLogin: "realtime-member-capability",
          email: "realtime-member-capability@example.com",
          displayName: "Realtime Member Capability"
        }
      });
      expect(accepted.statusCode).toBe(201);

      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "workspace.member_joined",
          payload: {
            member: {
              id: accepted.json().user.id,
              displayName: "Realtime Member Capability",
              capabilities: {
                canStartDirectConversation: true
              }
            }
          }
        }
      });
      expect(JSON.stringify(frame)).not.toContain("realtime-member-capability@example.com");
    } finally {
      ws.terminate();
    }
  });

  it("does not push inaccessible realtime events to connected clients", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-HIDDEN-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-HIDDEN-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-hidden-member",
        email: "realtime-hidden-member@example.com",
        displayName: "Realtime Hidden Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": memberId
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const hidden = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "group",
          title: "Hidden realtime group"
        }
      });
      expect(hidden.statusCode).toBe(201);

      const pushedFrames = readWsJsonFrames(ws, 1);
      const visible = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "direct",
          targetUserId: memberId
        }
      });
      expect(visible.statusCode).toBe(201);

      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "conversation.created",
          target: {
            type: "conversation",
            id: visible.json().conversation.id
          }
        }
      });
      expect(frame.event.target.id).not.toBe(hidden.json().conversation.id);
    } finally {
      ws.terminate();
    }
  });

  it("projects realtime conversation payloads for the receiving member", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-VIEWER-DIRECT",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-VIEWER-DIRECT/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-viewer-direct",
        email: "realtime-viewer-direct@example.com",
        displayName: "Realtime Viewer Direct"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const pushedFrames = readWsJsonFrames(ws, 1);
      const direct = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "direct",
          targetUserId: memberId
        }
      });
      expect(direct.statusCode).toBe(201);
      expect(direct.json().conversation.displayTitle).toBe("Realtime Viewer Direct");

      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "conversation.created",
          payload: {
            conversation: {
              id: direct.json().conversation.id,
              displayTitle: "Realtime Viewer Direct",
              otherMember: {
                id: memberId,
                displayName: "Realtime Viewer Direct"
              }
            }
          }
        }
      });
      expect(JSON.stringify(frame)).not.toContain("realtime-viewer-direct@example.com");
    } finally {
      ws.terminate();
    }
  });

  it("keeps websocket cursors behind invisible events so later visible events still push", async () => {
    const app = await makeApp();
    const memberInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-CURSOR-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(memberInvite.statusCode).toBe(201);
    const memberAccepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-CURSOR-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-cursor-member",
        email: "realtime-cursor-member@example.com",
        displayName: "Realtime Cursor Member"
      }
    });
    expect(memberAccepted.statusCode).toBe(201);
    const memberId = memberAccepted.json().user.id;

    const visibleConversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Realtime cursor visible",
        memberIds: [memberId]
      }
    });
    expect(visibleConversation.statusCode).toBe(201);

    const hiddenConversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Realtime cursor hidden"
      }
    });
    expect(hiddenConversation.statusCode).toBe(201);

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": memberId
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const pushedFrames = readWsJsonFrames(ws, 1);
      const hiddenMessage = await app.inject({
        method: "POST",
        url: "/api/workspace/messages",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          conversationId: hiddenConversation.json().conversation.id,
          clientMessageId: "hidden-before-visible",
          content: {
            format: "duallane.message+json;v=1",
            plainText: "Hidden before visible",
            blocks: [{ type: "text", text: "Hidden before visible" }]
          }
        }
      });
      expect(hiddenMessage.statusCode).toBe(201);

      const visibleMessage = await app.inject({
        method: "POST",
        url: "/api/workspace/messages",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          conversationId: visibleConversation.json().conversation.id,
          clientMessageId: "visible-after-hidden",
          content: {
            format: "duallane.message+json;v=1",
            plainText: "Visible after hidden",
            blocks: [{ type: "text", text: "Visible after hidden" }]
          }
        }
      });
      expect(visibleMessage.statusCode).toBe(201);

      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "message.created",
          conversationId: visibleConversation.json().conversation.id,
          payload: {
            messageId: visibleMessage.json().message.id
          }
        }
      });
      expect(JSON.stringify(frame)).not.toContain(hiddenMessage.json().message.id);
    } finally {
      ws.terminate();
    }
  });

  it("sends a safe realtime error and closes when a connected member loses space access", async () => {
    const app = await makeApp();
    const memberInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-REMOVED-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(memberInvite.statusCode).toBe(201);
    const memberAccepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-REMOVED-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-removed-member",
        email: "realtime-removed-member@example.com",
        displayName: "Realtime Removed Member"
      }
    });
    expect(memberAccepted.statusCode).toBe(201);
    const memberId = memberAccepted.json().user.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": memberId
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const errorFrames = readWsJsonFrames(ws, 1);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/workspace/members/${memberId}`,
        headers: {
          "x-workspace-user-id": "usr_owner"
        }
      });
      expect(removed.statusCode).toBe(200);

      const [frame] = await errorFrames;
      expect(frame).toEqual({
        version: 1,
        type: "error",
        error: {
          code: "auth.required",
          message: "请先登录共享空间"
        }
      });
      expect(JSON.stringify(frame)).not.toContain("requestId");
      expect(JSON.stringify(frame)).not.toContain("REALTIME-REMOVED-MEMBER");
      expect(JSON.stringify(frame)).not.toContain("realtime-removed-member@example.com");
    } finally {
      ws.terminate();
    }
  });

  it("marks realtime replay batches when more visible events remain", async () => {
    const app = await makeApp();
    for (let index = 0; index < 205; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/workspace/conversations",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": "usr_owner"
        },
        payload: {
          type: "group",
          title: `Replay batch ${index}`
        }
      });
      expect(response.statusCode).toBe(201);
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: 0 }));
      const [ready] = await frames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 200,
        hasMore: true
      });
    } finally {
      ws.terminate();
    }
  });

  it("does not expose transfer ids in realtime attachment-created frames", async () => {
    const app = await makeApp();
    const db = openTestDatabase(dataDir);
    let beforeSeq;
    try {
      beforeSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "realtime-pending.txt",
        mimeType: "text/plain",
        byteSize: 8,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 2);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: beforeSeq }));
      const [ready, attachmentFrame] = await frames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 1
      });
      expect(attachmentFrame?.event.payload).toMatchObject({
        attachmentId: reserve.json().attachment.id,
        status: "pending"
      });
      expect(attachmentFrame.event.payload.transferId).toBeUndefined();
      expect(attachmentFrame.event.payload.attachment.storageKey).toBeUndefined();
    } finally {
      ws.terminate();
    }
  });

  it("projects realtime attachment capabilities for the receiving member", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-ATTACHMENT-CAPABILITY",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-ATTACHMENT-CAPABILITY/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-attachment-capability",
        email: "realtime-attachment-capability@example.com",
        displayName: "Realtime Attachment Capability"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const pushedFrames = readWsJsonFrames(ws, 2);
      const reserve = await app.inject({
        method: "POST",
        url: "/api/workspace/files/uploads/reserve",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": memberId
        },
        payload: {
          fileName: "realtime-capability.txt",
          mimeType: "text/plain",
          byteSize: 10,
          visibility: "space"
        }
      });
      expect(reserve.statusCode).toBe(201);

      const content = await app.inject({
        method: "PUT",
        url: `/api/workspace/files/uploads/${reserve.json().id}/content`,
        headers: {
          "content-type": "application/octet-stream",
          "x-workspace-user-id": memberId
        },
        payload: Buffer.from("0123456789")
      });
      expect(content.statusCode).toBe(200);

      const frames = await pushedFrames;
      const availableFrame = frames.find((frame) => frame.event?.type === "attachment.available");
      expect(availableFrame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          payload: {
            attachment: {
              id: reserve.json().attachment.id,
              fileName: "realtime-capability.txt",
              capabilities: {
                canDownload: true,
                canRemove: true
              },
              uploader: {
                displayName: "Realtime Attachment Capability"
              }
            }
          }
        }
      });
      expect(availableFrame.event.payload.attachment.storageKey).toBeUndefined();
      expect(JSON.stringify(availableFrame)).not.toContain("realtime-attachment-capability@example.com");
    } finally {
      ws.terminate();
    }
  });

  it("projects realtime message attachment capabilities for the receiving member", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-MESSAGE-ATTACHMENT-CAPABILITY",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-MESSAGE-ATTACHMENT-CAPABILITY/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-message-attachment",
        email: "realtime-message-attachment@example.com",
        displayName: "Realtime Message Attachment"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Realtime message attachment",
        memberIds: [memberId]
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const readyFrames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      const [ready] = await readyFrames;
      expect(ready).toMatchObject({
        version: 1,
        type: "ready",
        replayCount: 0
      });

      const reserve = await app.inject({
        method: "POST",
        url: "/api/workspace/files/uploads/reserve",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": memberId
        },
        payload: {
          conversationId,
          fileName: "realtime-message-attachment.txt",
          mimeType: "text/plain",
          byteSize: 10,
          visibility: "conversation"
        }
      });
      expect(reserve.statusCode).toBe(201);

      const content = await app.inject({
        method: "PUT",
        url: `/api/workspace/files/uploads/${reserve.json().id}/content`,
        headers: {
          "content-type": "application/octet-stream",
          "x-workspace-user-id": memberId
        },
        payload: Buffer.from("0123456789")
      });
      expect(content.statusCode).toBe(200);

      const pushedFrames = readWsJsonFrames(ws, 1);
      const message = await app.inject({
        method: "POST",
        url: "/api/workspace/messages",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": memberId
        },
        payload: {
          conversationId,
          clientMessageId: "realtime-message-attachment",
          content: {
            format: "duallane.message+json;v=1",
            blocks: [
              { type: "text", text: "Realtime message file " },
              { type: "attachment", attachmentId: reserve.json().attachment.id }
            ]
          }
        }
      });
      expect(message.statusCode).toBe(201);

      const [frame] = await pushedFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "message.created",
          payload: {
            message: {
              clientMessageId: "realtime-message-attachment",
              attachments: [
                {
                  id: reserve.json().attachment.id,
                  fileName: "realtime-message-attachment.txt",
                  capabilities: {
                    canDownload: true,
                    canRemove: true
                  },
                  uploader: {
                    displayName: "Realtime Message Attachment"
                  }
                }
              ]
            }
          }
        }
      });
      expectNoWorkspaceInternals(frame, ["realtime-message-attachment@example.com"]);
    } finally {
      ws.terminate();
    }
  });

  it("keeps realtime notification preference updates actor-local", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "REALTIME-NOTIFY-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/REALTIME-NOTIFY-MEMBER/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "realtime-notify-member",
        email: "realtime-notify-member@example.com",
        displayName: "Realtime Notify Member"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;

    const direct = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "direct",
        targetUserId: memberId
      }
    });
    expect(direct.statusCode).toBe(201);
    const conversationId = direct.json().conversation.id;

    const db = openTestDatabase(dataDir);
    let currentSeq;
    try {
      currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM workspace_events").get().seq;
    } finally {
      db.close();
    }

    await app.ready();
    const memberWs = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    const ownerWs = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const memberReadyFrames = readWsJsonFrames(memberWs, 1);
      const ownerReadyFrames = readWsJsonFrames(ownerWs, 1);
      memberWs.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      ownerWs.send(JSON.stringify({ version: 1, type: "hello", lastSeq: currentSeq }));
      await memberReadyFrames;
      await ownerReadyFrames;

      const memberFrames = readWsJsonFrames(memberWs, 1);
      const ownerProbe = readWsJsonFrames(ownerWs, 1);
      const updated = await app.inject({
        method: "PATCH",
        url: `/api/workspace/conversations/${conversationId}/notification`,
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": memberId
        },
        payload: {
          level: "muted"
        }
      });
      expect(updated.statusCode).toBe(200);

      const [frame] = await memberFrames;
      expect(frame).toMatchObject({
        version: 1,
        type: "event",
        event: {
          type: "conversation.notification_updated",
          target: {
            type: "user",
            id: memberId
          },
          payload: {
            conversationId,
            userId: memberId,
            notificationLevel: "muted",
            conversation: {
              id: conversationId,
              notificationLevel: "muted"
            }
          }
        }
      });
      expectNoWorkspaceInternals(frame, ["realtime-notify-member@example.com"]);

      const visible = await app.inject({
        method: "POST",
        url: "/api/workspace/messages",
        headers: {
          "content-type": "application/json",
          "x-workspace-user-id": memberId
        },
        payload: {
          conversationId,
          clientMessageId: "notify-actor-local-probe",
          content: {
            format: "duallane.message+json;v=1",
            blocks: [{ type: "text", text: "Visible after notification update" }]
          }
        }
      });
      expect(visible.statusCode).toBe(201);
      const [ownerFrame] = await ownerProbe;
      expect(ownerFrame.event.type).toBe("message.created");
      expect(JSON.stringify(ownerFrame)).not.toContain("conversation.notification_updated");
    } finally {
      memberWs.terminate();
      ownerWs.terminate();
    }
  });

  it("asks clients to resync when realtime cursor is ahead of the server", async () => {
    const app = await makeApp();
    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: 999999 }));
      const [sync] = await frames;
      expect(sync).toMatchObject({
        version: 1,
        type: "sync.required",
        spaceId: "spc_default",
        reason: "cursor_ahead"
      });
      expect(sync.currentSeq).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(sync)).not.toContain("requestId");
    } finally {
      ws.terminate();
    }
  });

  it("does not expose request ids in workspace realtime errors", async () => {
    const app = await makeApp();
    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "bad" }));
      const [frame] = await frames;
      expect(frame).toEqual({
        version: 1,
        type: "error",
        error: {
          code: "realtime.invalid",
          message: "实时同步请求无效"
        }
      });
    } finally {
      ws.terminate();
    }
  });

  it("uses the same safe realtime error envelope for auth failures", async () => {
    const app = await makeApp();
    await app.ready();
    const ws = await app.injectWS("/ws/workspace", {
      headers: {
        "x-workspace-user-id": "missing-workspace-user"
      }
    });

    try {
      const frames = readWsJsonFrames(ws, 1);
      ws.send(JSON.stringify({ version: 1, type: "hello", lastSeq: 0 }));
      const [frame] = await frames;
      expect(frame).toEqual({
        version: 1,
        type: "error",
        error: {
          code: "auth.required",
          message: "请先登录共享空间"
        }
      });
      expect(JSON.stringify(frame)).not.toContain("requestId");
      expect(JSON.stringify(frame)).not.toContain("missing-workspace-user");
    } finally {
      ws.terminate();
    }
  });

  it("returns current quota usage through workspace bootstrap", async () => {
    const app = await makeApp();
    const content = Buffer.from("quota route body", "utf8");
    const before = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().policy.usedTodayBytes).toBe(0);
    expect(before.json().policy.remainingQuotaBytes).toBe(before.json().policy.dailyQuotaBytes);

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "quota.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();
    expect(upload.upload).toEqual({ id: upload.id });
    expect(upload.attachment.storageKey).toBeUndefined();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().policy.usedTodayBytes).toBe(content.byteLength);
    expect(after.json().policy.remainingQuotaBytes).toBe(after.json().policy.dailyQuotaBytes - content.byteLength);
  });

  it("returns first-screen conversations and files through workspace bootstrap", async () => {
    const app = await makeApp();
    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route Bootstrap First Screen"
      }
    });
    expect(conversation.statusCode).toBe(201);

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "route-bootstrap.txt",
        mimeType: "text/plain",
        byteSize: 5,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${reserve.json().id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("hello")
    });
    expect(complete.statusCode).toBe(200);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().conversations.map((item) => item.id)).toContain(conversation.json().conversation.id);
    expect(bootstrap.json().files.map((item) => item.id)).toContain(reserve.json().attachment.id);
    expectNoWorkspaceInternals(bootstrap.json());
  });

  it("does not expose internal transfer ids for rejected upload reservations", async () => {
    const app = await makeApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "invalid-route-upload.bin",
        mimeType: "application/octet-stream",
        byteSize: -1,
        visibility: "space"
      }
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("file.invalid_size");
    expectNoWorkspaceInternals(invalid.json(), ["invalid-route-upload.bin"]);
    expect(getLatestAudit("file.upload.reserve", "usr_owner")).toEqual({
      action: "file.upload.reserve",
      targetType: "attachment",
      targetId: "new",
      result: "rejected",
      reason: "file.invalid_size"
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "too-large.bin",
        mimeType: "application/octet-stream",
        byteSize: Number.MAX_SAFE_INTEGER,
        visibility: "space"
      }
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      status: "rejected",
      usedToday: 0
    });
    expect(rejected.json().id).toBeUndefined();
    expect(JSON.stringify(rejected.json())).not.toContain("transferId");
  });

  it("does not expose internal transfer ids for rejected download reservations", async () => {
    const app = await makeApp();
    const content = Buffer.from("download rejection body", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "download-reject.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const filler = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "quota-filler.bin",
        mimeType: "application/octet-stream",
        byteSize: upload.dailyQuotaBytes - upload.usedToday,
        visibility: "space"
      }
    });
    expect(filler.statusCode).toBe(201);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      status: "rejected",
      remainingBytes: 0
    });
    expect(rejected.json().id).toBeUndefined();
    expect(JSON.stringify(rejected.json())).not.toContain("transferId");
  });

  it("does not expose provider identity fields for the current bootstrap user", async () => {
    const app = await makeApp();
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubId=route-provider-owner&githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry",
      cookies: {
        duallane_oauth_state: "dev-state"
      }
    });
    expect(callback.statusCode).toBe(200);
    const sessionCookie = callback.cookies.find((cookie) => cookie.name === "duallane_workspace");
    expect(sessionCookie?.value).toBeTruthy();

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      cookies: {
        duallane_workspace: sessionCookie.value
      }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().auth.currentUser.githubLogin).toBe("timeStarry");
    expect(bootstrap.json().auth.currentUser.email).toBeUndefined();
    expect(bootstrap.json().auth.currentUser.githubId).toBeUndefined();
    expect(JSON.stringify(bootstrap.json())).not.toContain("route-provider-owner");
    expect(JSON.stringify(bootstrap.json())).not.toContain("timestarry@qq.com");
  });

  it("limits bootstrap invite lists to each role's manageable invite scope", async () => {
    const app = await makeApp();
    const adminInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-BOOTSTRAP-ADMIN",
        defaultRole: "admin",
        maxUses: 1
      }
    });
    expect(adminInvite.statusCode).toBe(201);

    const acceptedAdmin = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-BOOTSTRAP-ADMIN/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-bootstrap-admin",
        email: "route-bootstrap-admin@example.com",
        displayName: "Route Bootstrap Admin"
      }
    });
    expect(acceptedAdmin.statusCode).toBe(201);
    const adminId = acceptedAdmin.json().user.id;

    const memberInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": adminId
      },
      payload: {
        code: "ROUTE-BOOTSTRAP-MEMBER",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(memberInvite.statusCode).toBe(201);

    const ownerInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-BOOTSTRAP-OWNER",
        defaultRole: "owner",
        maxUses: 1
      }
    });
    expect(ownerInvite.statusCode).toBe(201);

    const adminBootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": adminId
      }
    });
    expect(adminBootstrap.statusCode).toBe(200);
    expect(adminBootstrap.json().invites).toEqual([
      expect.objectContaining({
        id: memberInvite.json().invite.id,
        defaultRole: "member",
        codePreview: memberInvite.json().invite.codePreview
      })
    ]);
    expectNoWorkspaceInternals(adminBootstrap.json(), [
      "ROUTE-BOOTSTRAP-MEMBER",
      "ROUTE-BOOTSTRAP-ADMIN",
      "ROUTE-BOOTSTRAP-OWNER",
      adminInvite.json().invite.id,
      ownerInvite.json().invite.id,
      "route-bootstrap-admin@example.com"
    ]);

    const ownerBootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(ownerBootstrap.statusCode).toBe(200);
    expect(ownerBootstrap.json().invites.map((invite) => invite.id)).toEqual(
      expect.arrayContaining([
        adminInvite.json().invite.id,
        memberInvite.json().invite.id,
        ownerInvite.json().invite.id
      ])
    );
  });

  it("prevents admins from revoking privileged invites through workspace routes", async () => {
    const app = await makeApp();
    const adminInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-REVOKE-PRIVILEGED-ADMIN",
        defaultRole: "admin",
        maxUses: 1
      }
    });
    expect(adminInvite.statusCode).toBe(201);

    const acceptedAdmin = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-REVOKE-PRIVILEGED-ADMIN/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-revoke-privileged-admin",
        email: "route-revoke-privileged-admin@example.com",
        displayName: "Route Revoke Privileged Admin"
      }
    });
    expect(acceptedAdmin.statusCode).toBe(201);
    const adminId = acceptedAdmin.json().user.id;

    const ownerInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-REVOKE-PRIVILEGED-OWNER",
        defaultRole: "owner",
        maxUses: 1
      }
    });
    expect(ownerInvite.statusCode).toBe(201);
    const ownerInviteId = ownerInvite.json().invite.id;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/workspace/invites/${ownerInviteId}/revoke`,
      headers: {
        "x-workspace-user-id": adminId
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(rejected.json(), [
      ownerInviteId,
      "ROUTE-REVOKE-PRIVILEGED-ADMIN",
      "ROUTE-REVOKE-PRIVILEGED-OWNER",
      "route-revoke-privileged-admin@example.com"
    ]);
    expect(getLatestAudit("invite.revoke", adminId)).toEqual({
      action: "invite.revoke",
      targetType: "invite",
      targetId: ownerInviteId,
      result: "rejected",
      reason: "insufficient permission"
    });

    const db = openTestDatabase(dataDir);
    try {
      const invite = db.prepare("SELECT revoked_at AS revokedAt FROM invites WHERE id = ?").get(ownerInviteId);
      expect(invite.revokedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("derives file transfer actors from the authenticated workspace actor", async () => {
    const app = await makeApp();
    const invite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-FILE-ACTOR",
        defaultRole: "member",
        maxUses: 1
      }
    });
    expect(invite.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-FILE-ACTOR/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-file-actor",
        email: "route-file-actor@example.com",
        displayName: "Route File Actor"
      }
    });
    expect(accepted.statusCode).toBe(201);
    const memberId = accepted.json().user.id;
    const content = Buffer.from("actor-owned file", "utf8");

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        userId: "usr_owner",
        fileName: "actor-owned.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();
    expect(upload.attachment.uploaderId).toBe(memberId);

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": memberId
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const downloadReserve = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": memberId
      },
      payload: {
        userId: "usr_owner"
      }
    });
    expect(downloadReserve.statusCode).toBe(201);
    expect(downloadReserve.json().status).toBe("completed");

    const ownerBootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(ownerBootstrap.statusCode).toBe(200);
    expect(ownerBootstrap.json().policy.usedTodayBytes).toBe(0);

    const memberBootstrap = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": memberId
      }
    });
    expect(memberBootstrap.statusCode).toBe(200);
    expect(memberBootstrap.json().policy.usedTodayBytes).toBe(content.byteLength * 2);

    const db = openTestDatabase(dataDir);
    try {
      const ledgerUsers = db.prepare(`
        SELECT user_id AS userId, direction, status
        FROM transfer_ledger
        WHERE attachment_id = ?
        ORDER BY direction ASC, created_at ASC
      `).all(upload.attachment.id);
      expect(ledgerUsers).toEqual([
        { userId: memberId, direction: "download", status: "completed" },
        { userId: memberId, direction: "upload", status: "completed" }
      ]);
    } finally {
      db.close();
    }
  });

  it("filters workspace files through route query parameters", async () => {
    const app = await makeApp();
    const standaloneReserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "route-standalone.txt",
        mimeType: "text/plain",
        byteSize: 3,
        visibility: "space"
      }
    });
    expect(standaloneReserve.statusCode).toBe(201);
    const standalone = standaloneReserve.json();
    const standaloneComplete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${standalone.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("one")
    });
    expect(standaloneComplete.statusCode).toBe(200);

    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route File Room"
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const scopedReserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        fileName: "route-room-brief.txt",
        mimeType: "text/plain",
        byteSize: 3,
        visibility: "conversation"
      }
    });
    expect(scopedReserve.statusCode).toBe(201);
    const scoped = scopedReserve.json();
    const scopedComplete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${scoped.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("two")
    });
    expect(scopedComplete.statusCode).toBe(200);

    const files = await app.inject({
      method: "GET",
      url: `/api/workspace/files?scope=conversation&conversationId=${conversationId}&q=brief`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().files.map((file) => file.id)).toEqual([scoped.attachment.id]);
    expect(files.json().files[0]).toMatchObject({
      uploader: {
        id: "usr_owner",
        displayName: "timeStarry"
      },
      capabilities: {
        canDownload: true,
        canRemove: true
      }
    });
    expect(files.json().files[0].availableAt).toBeTruthy();
    expectNoWorkspaceInternals(files.json());
  });

  it("keeps space-visible upload reservations detached from supplied conversation ids", async () => {
    const app = await makeApp();
    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Detached Route File Room"
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        fileName: "route-detached.txt",
        mimeType: "text/plain",
        byteSize: 3,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    expect(reserve.json().attachment.conversationId).toBeNull();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${reserve.json().id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("one")
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().attachment.conversationId).toBeNull();

    const standaloneFiles = await app.inject({
      method: "GET",
      url: "/api/workspace/files?scope=standalone",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(standaloneFiles.statusCode).toBe(200);
    expect(standaloneFiles.json().files.map((file) => file.id)).toContain(reserve.json().attachment.id);

    const conversationFiles = await app.inject({
      method: "GET",
      url: `/api/workspace/files?scope=conversation&conversationId=${conversationId}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(conversationFiles.statusCode).toBe(200);
    expect(conversationFiles.json().files.map((file) => file.id)).not.toContain(reserve.json().attachment.id);
    expectNoWorkspaceInternals(standaloneFiles.json());
    expectNoWorkspaceInternals(conversationFiles.json());
  });

  it("blocks file library routes for roles without download permission", async () => {
    const app = await makeApp();
    const auditorInvite = await app.inject({
      method: "POST",
      url: "/api/workspace/invites",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        code: "ROUTE-AUDITOR-FILES",
        defaultRole: "auditor",
        maxUses: 1
      }
    });
    expect(auditorInvite.statusCode).toBe(201);

    const auditorAccepted = await app.inject({
      method: "POST",
      url: "/api/workspace/invites/ROUTE-AUDITOR-FILES/accept",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        githubLogin: "route-auditor-files",
        email: "route-auditor-files@example.com",
        displayName: "Route Auditor Files"
      }
    });
    expect(auditorAccepted.statusCode).toBe(201);
    const auditorId = auditorAccepted.json().user.id;

    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "route-auditor-visible.txt",
        mimeType: "text/plain",
        byteSize: 3,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();
    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("aud")
    });
    expect(complete.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "GET",
      url: "/api/workspace/files",
      headers: {
        "x-workspace-user-id": auditorId
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("permission.denied");
    expectNoWorkspaceInternals(rejected.json(), [
      upload.attachment.id,
      "route-auditor-visible.txt",
      "ROUTE-AUDITOR-FILES",
      "route-auditor-files@example.com"
    ]);
    expect(getLatestAudit("file.download", auditorId)).toEqual({
      action: "file.download",
      targetType: "workspace",
      targetId: null,
      result: "rejected",
      reason: "insufficient permission"
    });
  });

  it("uploads file bytes to local storage and downloads the same content after quota check", async () => {
    const app = await makeApp();
    const content = Buffer.from("workspace file body", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "note.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().attachment.status).toBe("available");
    expect(complete.json().attachment.storageKey).toBeUndefined();

    const storageKey = getAttachmentStorageKey(upload.attachment.id);
    expect(storageKey).toBeTruthy();
    const stored = await readFile(path.join(dataDir, "workspace-files", storageKey));
    expect(stored.equals(content)).toBe(true);

    const downloadReserve = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(downloadReserve.statusCode).toBe(201);
    expect(downloadReserve.json().status).toBe("completed");

    const download = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/download?downloadId=${downloadReserve.json().id}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("text/plain");
    expect(download.rawPayload.equals(content)).toBe(true);

    const after = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().policy.usedTodayBytes).toBe(content.byteLength * 2);
  });

  it("previews visible images inline without consuming download quota", async () => {
    const app = await makeApp();
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "preview.png",
        mimeType: "image/png",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const preview = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/preview`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/png");
    expect(preview.headers["content-disposition"]).toBe('inline; filename="preview.png"');
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect(preview.rawPayload.equals(content)).toBe(true);

    const after = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().policy.usedTodayBytes).toBe(content.byteLength);
  });

  it("rejects inline previews for non-image attachments", async () => {
    const app = await makeApp();
    const content = Buffer.from("not an image", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "notes.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();
    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const preview = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/preview`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error.code).toBe("file.preview_unsupported");
  });
  it("lists structured messages without raw persistence fields", async () => {
    const app = await makeApp();
    const conversation = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        type: "group",
        title: "Route message projection"
      }
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().conversation.id;

    const content = Buffer.from("projected attachment", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        fileName: "projected.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "conversation"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const message = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        conversationId,
        clientMessageId: "route-projection-message",
        content: {
          format: "duallane.message+json;v=1",
          blocks: [
            { type: "text", text: "Projected file " },
            { type: "attachment", attachmentId: upload.attachment.id }
          ]
        }
      }
    });
    expect(message.statusCode).toBe(201);

    const messages = await app.inject({
      method: "GET",
      url: `/api/workspace/conversations/${conversationId}/messages`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(messages.statusCode).toBe(200);
    const listedMessages = messages.json().messages;
    expect(listedMessages[0]).toMatchObject({
      kind: "system",
      plainText: "timeStarry 创建了群聊「Route message projection」"
    });
    const projectedMessage = listedMessages.find((item) => item.clientMessageId === "route-projection-message");
    expect(projectedMessage).toMatchObject({
      clientMessageId: "route-projection-message",
      plainText: "Projected file [文件]"
    });
    expect(projectedMessage.attachments[0]).toMatchObject({
      id: upload.attachment.id,
      fileName: "projected.txt"
    });
    expectNoWorkspaceInternals(messages.json());
  });

  it("rejects stale download ids after a file is removed", async () => {
    const app = await makeApp();
    const content = Buffer.from("removed after reserve", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "remove-after-reserve.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const downloadReserve = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(downloadReserve.statusCode).toBe(201);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/files/${upload.attachment.id}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);

    const staleDownload = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/download?downloadId=${downloadReserve.json().id}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(staleDownload.statusCode).toBe(400);
    expect(staleDownload.json().error.code).toBe("file.not_found");
  });

  it("removes uploaded files through workspace routes", async () => {
    const app = await makeApp();
    const content = Buffer.from("remove route file", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "route-remove.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();
    expect(upload.upload).toEqual({ id: upload.id });
    expect(upload.attachment.storageKey).toBeUndefined();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspace/files/${upload.attachment.id}`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, attachmentId: upload.attachment.id });

    const files = await app.inject({
      method: "GET",
      url: "/api/workspace/files",
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().files.map((file) => file.id)).not.toContain(upload.attachment.id);

    const download = await app.inject({
      method: "GET",
      url: `/api/workspace/files/${upload.attachment.id}/download`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(download.statusCode).toBe(400);
    expect(download.json().error.code).toBe("file.not_found");
  });

  it("does not consume download quota when stored file content is missing", async () => {
    const app = await makeApp();
    const content = Buffer.from("missing stored content", "utf8");
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "missing.txt",
        mimeType: "text/plain",
        byteSize: content.byteLength,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const complete = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: content
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().attachment.storageKey).toBeUndefined();

    const storageKey = getAttachmentStorageKey(upload.attachment.id);
    expect(storageKey).toBeTruthy();
    await rm(path.join(dataDir, "workspace-files", storageKey), { force: true });

    const downloadReserve = await app.inject({
      method: "POST",
      url: `/api/workspace/files/${upload.attachment.id}/downloads/reserve`,
      headers: {
        "x-workspace-user-id": "usr_owner"
      }
    });
    expect(downloadReserve.statusCode).toBe(404);
    expect(downloadReserve.json().error.code).toBe("file.storage_missing");

    const db = openTestDatabase(dataDir);
    try {
      const used = db.prepare(`
        SELECT COALESCE(SUM(byte_size), 0) AS used
        FROM transfer_ledger
        WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
      `).get();
      expect(used.used).toBe(content.byteLength);
    } finally {
      db.close();
    }
  });

  it("does not complete metadata-only uploads and releases quota on content mismatch", async () => {
    const app = await makeApp();
    const reserve = await app.inject({
      method: "POST",
      url: "/api/workspace/files/uploads/reserve",
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {
        fileName: "mismatch.txt",
        mimeType: "text/plain",
        byteSize: 12,
        visibility: "space"
      }
    });
    expect(reserve.statusCode).toBe(201);
    const upload = reserve.json();

    const metadataOnlyComplete = await app.inject({
      method: "POST",
      url: `/api/workspace/files/uploads/${upload.id}/complete`,
      headers: {
        "content-type": "application/json",
        "x-workspace-user-id": "usr_owner"
      },
      payload: {}
    });
    expect(metadataOnlyComplete.statusCode).toBe(404);
    expect(metadataOnlyComplete.json().error.code).toBe("file.storage_missing");

    const afterMetadataOnlyDb = openTestDatabase(dataDir);
    try {
      const used = afterMetadataOnlyDb.prepare(`
        SELECT COALESCE(SUM(byte_size), 0) AS used
        FROM transfer_ledger
        WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
      `).get();
      const failed = afterMetadataOnlyDb.prepare("SELECT status FROM transfer_ledger WHERE id = ?").get(upload.id);
      const attachment = afterMetadataOnlyDb.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
      const audit = afterMetadataOnlyDb.prepare(`
        SELECT result, reason
        FROM audit_logs
        WHERE action = 'file.upload.failed' AND target_id = ?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(upload.attachment.id);
      expect(used.used).toBe(0);
      expect(failed.status).toBe("failed");
      expect(attachment.status).toBe("failed");
      expect(audit).toEqual({ result: "failure", reason: "文件内容不可用" });
    } finally {
      afterMetadataOnlyDb.close();
    }

    const mismatch = await app.inject({
      method: "PUT",
      url: `/api/workspace/files/uploads/${upload.id}/content`,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-user-id": "usr_owner"
      },
      payload: Buffer.from("short")
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("upload.invalid");

    const db = openTestDatabase(dataDir);
    try {
      const used = db.prepare(`
        SELECT COALESCE(SUM(byte_size), 0) AS used
        FROM transfer_ledger
        WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
      `).get();
      const failed = db.prepare("SELECT status FROM transfer_ledger WHERE id = ?").get(upload.id);
      expect(used.used).toBe(0);
      expect(failed.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("does not persist p2p secure envelopes into workspace persistence", async () => {
    const app = await makeApp();
    const roomResponse = await app.inject({
      method: "POST",
      url: "/api/p2p/rooms",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        maxPeers: 2
      }
    });
    expect(roomResponse.statusCode).toBe(201);
    const { roomId } = roomResponse.json();
    const before = getWorkspaceContentCounts();

    await app.ready();
    const left = await app.injectWS(`/ws/p2p/${roomId}`);
    const right = await app.injectWS(`/ws/p2p/${roomId}`);

    try {
      const frames = readWsJsonFrames(right, 1);
      left.send(JSON.stringify({
        type: "secure",
        v: 1,
        channel: "ws-chat",
        nonce: "nonce_123",
        ciphertext: "ciphertext_456"
      }));
      const [forwarded] = await frames;
      expect(forwarded).toMatchObject({
        type: "secure",
        v: 1,
        channel: "ws-chat",
        nonce: "nonce_123",
        ciphertext: "ciphertext_456"
      });
    } finally {
      left.terminate();
      right.terminate();
    }

    expect(getWorkspaceContentCounts()).toEqual(before);
  });
  it("returns idempotent Reaction status codes and calibrated summaries", async () => {
    const app = await makeApp();
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubId=reaction-route-owner&githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry"
    });
    const sessionCookie = callback.cookies.find((cookie) => cookie.name === "duallane_workspace");
    expect(sessionCookie?.value).toBeTruthy();
    const cookies = { duallane_workspace: sessionCookie.value };

    const conversationResponse = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations",
      cookies,
      payload: { type: "group", title: "Reaction route" }
    });
    expect(conversationResponse.statusCode).toBe(201);
    const conversationId = conversationResponse.json().conversation.id;

    const messageResponse = await app.inject({
      method: "POST",
      url: "/api/workspace/messages",
      cookies,
      payload: {
        conversationId,
        clientMessageId: "reaction-route-message",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "Reaction route message",
          blocks: [{ type: "text", text: "Reaction route message" }]
        }
      }
    });
    expect(messageResponse.statusCode).toBe(201);
    const messageId = messageResponse.json().message.id;

    const add = await app.inject({
      method: "POST",
      url: "/api/workspace/messages/" + encodeURIComponent(messageId) + "/reactions",
      cookies,
      payload: { emoteKey: "feishu:ok" }
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({
      messageId,
      reactions: [{
        emoteKey: "feishu:ok",
        count: 1,
        reactedByCurrentUser: true
      }]
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workspace/messages/" + encodeURIComponent(messageId) + "/reactions",
      cookies,
      payload: { emoteKey: "feishu:ok" }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(add.json());

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/workspace/messages/" + encodeURIComponent(messageId) + "/reactions/feishu%3Aok",
      cookies
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ messageId, reactions: [] });

    const duplicateRemove = await app.inject({
      method: "DELETE",
      url: "/api/workspace/messages/" + encodeURIComponent(messageId) + "/reactions/feishu%3Aok",
      cookies
    });
    expect(duplicateRemove.statusCode).toBe(200);
    expect(duplicateRemove.json()).toEqual(remove.json());

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workspace/messages/" + encodeURIComponent(messageId) + "/reactions",
      cookies,
      payload: { emoteKey: "douyin:laughwithtears" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("reaction.invalid_emote");
  });
});
