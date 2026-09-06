import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { WORKSPACE_SESSION_COOKIE } from "../../apps/web/server/services/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "apps/backend/internal/workspacecontract/testdata/node-core.json");
const nodeRoutesPath = path.join(repoRoot, "apps/backend/api/node-routes.json");

const CORE_ROUTES = [
  ["GET", "/api/auth/github/start"],
  ["GET", "/api/auth/github/callback"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/workspace/bootstrap"],
  ["GET", "/api/workspace/statistics"],
  ["GET", "/api/workspace/members"],
  ["PATCH", "/api/workspace/me/profile"],
  ["GET", "/api/workspace/member-visibility/{userId}"],
  ["PUT", "/api/workspace/member-visibility/{userId}"],
  ["PATCH", "/api/workspace/members/{userId}/role"],
  ["DELETE", "/api/workspace/members/{userId}"],
  ["PUT", "/api/workspace/members/{userId}/remark"],
  ["DELETE", "/api/workspace/members/{userId}/remark"],
  ["GET", "/api/workspace/conversations"],
  ["POST", "/api/workspace/conversations"],
  ["GET", "/api/workspace/conversations/{conversationId}"],
  ["GET", "/api/workspace/conversations/{conversationId}/messages"],
  ["POST", "/api/workspace/conversations/{conversationId}/read"],
  ["PATCH", "/api/workspace/conversations/{conversationId}/notification"],
  ["PATCH", "/api/workspace/groups/{conversationId}"],
  ["POST", "/api/workspace/groups/{conversationId}/leave"],
  ["POST", "/api/workspace/groups/{conversationId}/members"],
  ["DELETE", "/api/workspace/groups/{conversationId}/members/{userId}"],
  ["GET", "/api/workspace/groups/{conversationId}/pins"],
  ["POST", "/api/workspace/groups/{conversationId}/pins"],
  ["DELETE", "/api/workspace/groups/{conversationId}/pins/{messageId}"],
  ["POST", "/api/workspace/messages"],
  ["POST", "/api/workspace/messages/{messageId}/reactions"],
  ["DELETE", "/api/workspace/messages/{messageId}/reactions/{emoteKey}"],
  ["POST", "/api/workspace/messages/{messageId}/recall"],
  ["PUT", "/api/workspace/messages/{messageId}/hidden"],
  ["DELETE", "/api/workspace/messages/{messageId}/hidden"]
];

const EXCLUDED_ROUTES = [
  "/api/workspace/me/notifications",
  "/api/workspace/me/ntfy",
  "/api/workspace/me/emotes",
  "/api/workspace/me/avatar",
  "/api/workspace/settings/email"
];

const OWNER_ID = "usr_owner";
const PEER_ID = "usr_core_contract_peer";
const PEER_LOGIN = "core-contract-peer";
const SECOND_PEER_ID = "usr_core_contract_second";
const SECOND_PEER_LOGIN = "core-contract-second";

function iso(value) {
  return new Date(value).toISOString();
}

function seedHuman(db, { id, login, displayName }) {
  const now = iso(Date.now());
  db.prepare(`
    INSERT INTO users (
      id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
    )
    VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)
    ON CONFLICT (id) DO NOTHING
  `).run(id, login, displayName, now);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', ?, 'member', ?, NULL)
    ON CONFLICT (space_id, user_id) DO NOTHING
  `).run(id, now);
}

function readRouteInventory() {
  const declared = JSON.parse(requireRead(nodeRoutesPath)).routes;
  const byKey = new Map(declared.map((route) => [`${route.method} ${route.path}`, route]));
  return CORE_ROUTES.map(([method, routePath]) => {
    const route = byKey.get(`${method} ${routePath}`);
    assert(route, `node-routes.json is missing ${method} ${routePath}`);
    assert.equal(route.source, "apps/web/server/index.mjs", `${method} ${routePath} source changed unexpectedly`);
    return {
      method,
      path: routePath,
      nodePath: route.nodePath,
      source: route.source
    };
  });
}

function requireRead(filePath) {
  // This synchronous read is deliberately limited to the checked-in route
  // inventory; request/response fixtures use the asynchronous application API.
  return readFileSync(filePath, "utf8");
}

function parseJSONBody(response) {
  if (!response.body) return null;
  return response.json();
}

function captureRequest(request, cookie) {
  const headers = {};
  if (request.payload !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `${WORKSPACE_SESSION_COOKIE}=fixture-session`;
  return {
    method: request.method,
    path: request.url,
    headers,
    ...(request.payload !== undefined ? { body: request.payload } : {})
  };
}

function latestAudit(db, action) {
  return db.prepare(`
    SELECT action, target_type AS targetType, result
    FROM audit_logs
    WHERE action = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).get(action) ?? null;
}

function latestEvent(db, type, targetId = null) {
  if (targetId) {
    return db.prepare(`
      SELECT type, target_type AS targetType
      FROM workspace_events
      WHERE type = ? AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(type, targetId) ?? null;
  }
  return db.prepare(`
    SELECT type, target_type AS targetType
    FROM workspace_events
    WHERE type = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).get(type) ?? null;
}

function sideEffectContract(db, { auditAction, eventType, eventTargetId } = {}) {
  const result = {};
  if (auditAction) {
    result.audit = latestAudit(db, auditAction);
  }
  if (eventType) {
    result.event = latestEvent(db, eventType, eventTargetId);
  }
  result.persistence = {
    messages: Number(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count),
    workspaceEvents: Number(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count),
    auditLogs: Number(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count)
  };
  return result;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_STRING_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

function replaceString(value, ids, generatedIds) {
  if (ids.has(value)) return ids.get(value);
  let normalized = value;
  for (const [raw, canonical] of ids) {
    normalized = normalized.split(raw).join(canonical);
  }
  if (UUID_PATTERN.test(normalized)) {
    if (!generatedIds.has(normalized)) {
      generatedIds.set(normalized, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
    }
    return generatedIds.get(normalized);
  }
  if (normalized.match(UUID_IN_STRING_PATTERN)) {
    return normalized.replace(UUID_IN_STRING_PATTERN, (raw) => {
      if (!generatedIds.has(raw)) {
        generatedIds.set(raw, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
      }
      return generatedIds.get(raw);
    });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) {
    return "2026-01-01T00:00:00.000Z";
  }
  return normalized;
}

function normalizeFixture(value, ids, generatedIds = new Map()) {
  if (Array.isArray(value)) return value.map((item) => normalizeFixture(item, ids, generatedIds));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? replaceString(value, ids, generatedIds) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeFixture(child, ids, generatedIds)]));
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-core-contract-"));
  const db = openTestDatabase(dataDir);
  seedHuman(db, { id: PEER_ID, login: PEER_LOGIN, displayName: "Core Contract Peer" });
  seedHuman(db, { id: SECOND_PEER_ID, login: SECOND_PEER_LOGIN, displayName: "Core Contract Second" });

  const app = await createApp({
    dataDir,
    db,
    env: {
      WORKSPACE_ENABLED: "true",
      NODE_ENV: "test",
      SERVE_STATIC: "false",
      WORKSPACE_EMAIL_WORKER_ENABLED: "false",
      WORKSPACE_NTFY_WORKER_ENABLED: "false",
      WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false",
      SESSION_SECRET: "workspace-core-contract-test-secret"
    },
    logger: false
  });

  const scenarios = [];
  const addScenario = (name, request, response, sideEffects, cookie = false) => {
    scenarios.push({
      name,
      request: captureRequest(request, cookie),
      response: { status: response.statusCode, body: parseJSONBody(response) },
      ...(sideEffects ? { sideEffects } : {})
    });
  };

  try {
    const unauthorizedRequest = { method: "GET", url: "/api/workspace/bootstrap" };
    const unauthorized = await app.inject(unauthorizedRequest);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.json().error.code, "auth.required");
    addScenario("auth-required-bootstrap", unauthorizedRequest, unauthorized);

    const rejectedLoginRequest = {
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubLogin=workspace-core-outsider&displayName=Workspace%20Core%20Outsider"
    };
    const rejectedLogin = await app.inject(rejectedLoginRequest);
    assert.equal(rejectedLogin.statusCode, 401);
    assert.equal(rejectedLogin.json().error.code, "auth.not_invited");
    addScenario(
      "login-rejected-not-invited",
      rejectedLoginRequest,
      rejectedLogin,
      sideEffectContract(db, { auditAction: "login.rejected" })
    );

    const loginRequest = {
      method: "GET",
      url: "/api/auth/github/callback?format=json&githubId=workspace-core-owner&githubLogin=timeStarry&displayName=timeStarry"
    };
    const login = await app.inject(loginRequest);
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().user.id, OWNER_ID);
    const sessionCookie = login.cookies.find((cookie) => cookie.name === WORKSPACE_SESSION_COOKIE);
    assert(sessionCookie?.value, "successful callback did not issue a workspace session");
    addScenario("login-success-json", loginRequest, login, sideEffectContract(db, { auditAction: "login.success" }));
    const cookies = { [WORKSPACE_SESSION_COOKIE]: sessionCookie.value };

    const bootstrapRequest = { method: "GET", url: "/api/workspace/bootstrap", cookies };
    const bootstrap = await app.inject(bootstrapRequest);
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.json().auth.currentUser.id, OWNER_ID);
    addScenario("bootstrap-read", bootstrapRequest, bootstrap, null, true);

    const statisticsRequest = { method: "GET", url: "/api/workspace/statistics", cookies };
    const statistics = await app.inject(statisticsRequest);
    assert.equal(statistics.statusCode, 200);
    assert(Number.isInteger(statistics.json().statistics.totals.members));
    addScenario("statistics-read", statisticsRequest, statistics, null, true);

    const membersRequest = { method: "GET", url: "/api/workspace/members?limit=50", cookies };
    const members = await app.inject(membersRequest);
    assert.equal(members.statusCode, 200);
    assert(Array.isArray(members.json().members));
    addScenario("members-read", membersRequest, members, null, true);

    const profileRequest = {
      method: "PATCH",
      url: "/api/workspace/me/profile",
      cookies,
      payload: { nickname: "Core Owner", searchDiscoverable: true, recallReason: "修正" }
    };
    const profile = await app.inject(profileRequest);
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().user.nickname, "Core Owner");
    addScenario(
      "profile-update-write",
      profileRequest,
      profile,
      sideEffectContract(db, { auditAction: "profile.update" }),
      true
    );

    const visibilityPath = `/api/workspace/member-visibility/${PEER_ID}`;
    const visibilityGetRequest = { method: "GET", url: visibilityPath, cookies };
    const visibilityGet = await app.inject(visibilityGetRequest);
    assert.equal(visibilityGet.statusCode, 200);
    addScenario("member-visibility-read", visibilityGetRequest, visibilityGet, null, true);

    const visibilityPutRequest = {
      method: "PUT",
      url: visibilityPath,
      cookies,
      payload: { visibleUserIds: [SECOND_PEER_ID] }
    };
    const visibilityPut = await app.inject(visibilityPutRequest);
    assert.equal(visibilityPut.statusCode, 200);
    addScenario(
      "member-visibility-write",
      visibilityPutRequest,
      visibilityPut,
      sideEffectContract(db, { auditAction: "member.visibility_update", eventType: "workspace.member_visibility_updated" }),
      true
    );

    const conversationRequest = {
      method: "POST",
      url: "/api/workspace/conversations",
      cookies,
      payload: { type: "group", title: "Core Contract Group", memberIds: [PEER_ID] }
    };
    const conversationResponse = await app.inject(conversationRequest);
    assert.equal(conversationResponse.statusCode, 201);
    const conversationId = conversationResponse.json().conversation.id;
    assert(conversationId, "group creation did not return a conversation id");
    addScenario(
      "conversation-create-write",
      conversationRequest,
      conversationResponse,
      sideEffectContract(db, { auditAction: "conversation.create", eventType: "conversation.created", eventTargetId: conversationId }),
      true
    );

    const conversationPath = `/api/workspace/conversations/${conversationId}`;
    const conversationReadRequest = { method: "GET", url: conversationPath, cookies };
    const conversationRead = await app.inject(conversationReadRequest);
    assert.equal(conversationRead.statusCode, 200);
    addScenario("conversation-read", conversationReadRequest, conversationRead, null, true);

    const conversationsRequest = { method: "GET", url: "/api/workspace/conversations", cookies };
    const conversations = await app.inject(conversationsRequest);
    assert.equal(conversations.statusCode, 200);
    addScenario("conversations-read", conversationsRequest, conversations, null, true);

    const groupPatchRequest = {
      method: "PATCH",
      url: `/api/workspace/groups/${conversationId}`,
      cookies,
      payload: { title: "Core Contract Group Renamed", avatarEmoji: "📚" }
    };
    const groupPatch = await app.inject(groupPatchRequest);
    assert.equal(groupPatch.statusCode, 200);
    addScenario("group-update-write", groupPatchRequest, groupPatch, null, true);

    const messageRequest = {
      method: "POST",
      url: "/api/workspace/messages",
      cookies,
      payload: {
        conversationId,
        clientMessageId: "workspace-core-contract-message-1",
        content: {
          format: "duallane.message+json;v=1",
          blocks: [{ type: "text", text: "Core contract message" }]
        },
        replyToMessageId: null
      }
    };
    const messageResponse = await app.inject(messageRequest);
    assert.equal(messageResponse.statusCode, 201);
    const messageId = messageResponse.json().message.id;
    assert(messageId, "message creation did not return a message id");
    addScenario(
      "message-create-write",
      messageRequest,
      messageResponse,
      sideEffectContract(db, { auditAction: "message.create", eventType: "message.created", eventTargetId: messageId }),
      true
    );

    const messagesPath = `/api/workspace/conversations/${conversationId}/messages?limit=20`;
    const messagesRequest = { method: "GET", url: messagesPath, cookies };
    const messages = await app.inject(messagesRequest);
    assert.equal(messages.statusCode, 200);
    assert(messages.json().messages.some((item) => item.id === messageId));
    addScenario("messages-read", messagesRequest, messages, null, true);

    const readRequest = { method: "POST", url: `${conversationPath}/read`, cookies };
    const readResponse = await app.inject(readRequest);
    assert.equal(readResponse.statusCode, 200);
    addScenario("conversation-read-marker-write", readRequest, readResponse, null, true);

    const notificationRequest = {
      method: "PATCH",
      url: `${conversationPath}/notification`,
      cookies,
      payload: { level: "mentions" }
    };
    const notification = await app.inject(notificationRequest);
    assert.equal(notification.statusCode, 200);
    assert.equal(notification.json().conversation.notificationLevel, "mentions");
    addScenario("conversation-notification-write", notificationRequest, notification, null, true);

    const addMemberRequest = {
      method: "POST",
      url: `/api/workspace/groups/${conversationId}/members`,
      cookies,
      payload: { userId: SECOND_PEER_ID }
    };
    const addMember = await app.inject(addMemberRequest);
    assert.equal(addMember.statusCode, 201);
    addScenario("group-member-add-write", addMemberRequest, addMember, null, true);

    const removeMemberRequest = {
      method: "DELETE",
      url: `/api/workspace/groups/${conversationId}/members/${SECOND_PEER_ID}`,
      cookies
    };
    const removeMember = await app.inject(removeMemberRequest);
    assert.equal(removeMember.statusCode, 200);
    addScenario("group-member-remove-write", removeMemberRequest, removeMember, null, true);

    const pinsReadRequest = { method: "GET", url: `/api/workspace/groups/${conversationId}/pins?limit=20`, cookies };
    const pinsRead = await app.inject(pinsReadRequest);
    assert.equal(pinsRead.statusCode, 200);
    addScenario("pins-read-empty", pinsReadRequest, pinsRead, null, true);

    const pinRequest = {
      method: "POST",
      url: `/api/workspace/groups/${conversationId}/pins`,
      cookies,
      payload: { messageId }
    };
    const pin = await app.inject(pinRequest);
    assert.equal(pin.statusCode, 201);
    addScenario("pin-write", pinRequest, pin, sideEffectContract(db, { auditAction: "message.pin", eventType: "message.pinned", eventTargetId: messageId }), true);

    const pinnedRead = await app.inject(pinsReadRequest);
    assert.equal(pinnedRead.statusCode, 200);
    addScenario("pins-read", pinsReadRequest, pinnedRead, null, true);

    const unpinRequest = {
      method: "DELETE",
      url: `/api/workspace/groups/${conversationId}/pins/${messageId}`,
      cookies
    };
    const unpin = await app.inject(unpinRequest);
    assert.equal(unpin.statusCode, 200);
    addScenario("pin-delete-write", unpinRequest, unpin, null, true);

    const reactionRequest = {
      method: "POST",
      url: `/api/workspace/messages/${messageId}/reactions`,
      cookies,
      payload: { emoteKey: "feishu:ok" }
    };
    const reaction = await app.inject(reactionRequest);
    assert.equal(reaction.statusCode, 201);
    addScenario("reaction-add-write", reactionRequest, reaction, null, true);

    const reactionDeleteRequest = {
      method: "DELETE",
      url: `/api/workspace/messages/${messageId}/reactions/feishu%3Aok`,
      cookies
    };
    const reactionDelete = await app.inject(reactionDeleteRequest);
    assert.equal(reactionDelete.statusCode, 200);
    addScenario("reaction-delete-write", reactionDeleteRequest, reactionDelete, null, true);

    const hiddenPath = `/api/workspace/messages/${messageId}/hidden`;
    const hideRequest = { method: "PUT", url: hiddenPath, cookies };
    const hide = await app.inject(hideRequest);
    assert.equal(hide.statusCode, 200);
    addScenario("message-hide-write", hideRequest, hide, null, true);

    const unhideRequest = { method: "DELETE", url: hiddenPath, cookies };
    const unhide = await app.inject(unhideRequest);
    assert.equal(unhide.statusCode, 200);
    addScenario("message-unhide-write", unhideRequest, unhide, null, true);

    const recallRequest = { method: "POST", url: `/api/workspace/messages/${messageId}/recall`, cookies };
    const recall = await app.inject(recallRequest);
    assert.equal(recall.statusCode, 200);
    addScenario("message-recall-write", recallRequest, recall, sideEffectContract(db, { auditAction: "message.recall", eventType: "message.recalled", eventTargetId: messageId }), true);

    const logoutRequest = { method: "POST", url: "/api/auth/logout", cookies };
    const logout = await app.inject(logoutRequest);
    assert.equal(logout.statusCode, 200);
    addScenario("logout", logoutRequest, logout, null, true);

    const ids = new Map([
      [conversationId, "conv_01"],
      [messageId, "msg_01"]
    ]);
    return normalizeFixture({
      schemaVersion: 1,
      source: {
        nodeRoutes: "apps/backend/api/node-routes.json",
        routeSource: "apps/web/server/index.mjs",
        fixtureRuntime: "apps/web/server/services/test-database.mjs"
      },
      routes: readRouteInventory(),
      excludedRoutes: EXCLUDED_ROUTES,
      scenarios
    }, ids);
  } finally {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check") || !write;
  const fixture = await createFixture();
  if (write) {
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    console.log(`workspace core fixture written: ${fixturePath}`);
  }
  if (check) {
    const expected = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.deepEqual(fixture, expected, "checked-in Workspace core fixture is stale; run --write after reviewing Node changes");
    console.log(`workspace core contract fixture PASS (${fixture.scenarios.length} scenarios, ${fixture.routes.length} routes)`);
  }
}

await main();
