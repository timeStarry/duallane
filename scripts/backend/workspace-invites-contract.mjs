import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "apps/backend/internal/workspacecontract/testdata/node-invites.json");
const nodeRoutesPath = path.join(repoRoot, "apps/backend/api/node-routes.json");

const OWNER_ID = "usr_owner";
const MEMBER_ID = "usr_invite_contract_member";
const MEMBER_LOGIN = "invite-contract-member";
const INVITE_CODE = "INVITE-CONTRACT-MEMBER";

const INVITE_ROUTES = [
  ["POST", "/api/workspace/invites"],
  ["POST", "/api/workspace/invites/{code}/accept"],
  ["POST", "/api/workspace/invites/{inviteId}/revoke"]
];

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function seedMember(db) {
  const now = iso();
  db.prepare(`
    INSERT INTO users (
      id, github_id, github_login, email, display_name, nickname, avatar_url,
      kind, created_at, last_login_at
    ) VALUES (?, NULL, ?, NULL, ?, ?, NULL, 'human', ?, NULL)
    ON CONFLICT (id) DO NOTHING
  `).run(MEMBER_ID, MEMBER_LOGIN, "Invite Contract Member", MEMBER_LOGIN, now);
}

function jsonRequest(method, url, payload, actorId) {
  return {
    method,
    url,
    headers: {
      ...(actorId ? { "x-workspace-user-id": actorId } : {}),
      "content-type": "application/json"
    },
    payload
  };
}

function emptyRequest(method, url, actorId) {
  return {
    method,
    url,
    headers: actorId ? { "x-workspace-user-id": actorId } : {}
  };
}

function captureRequest(request) {
  return {
    method: request.method,
    path: request.url,
    headers: request.headers ?? {},
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

function replaceString(value, ids, generatedIds) {
  if (ids.has(value)) return ids.get(value);
  let normalized = value;
  for (const [raw, canonical] of ids) normalized = normalized.split(raw).join(canonical);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    if (!generatedIds.has(normalized)) {
      generatedIds.set(normalized, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
    }
    return generatedIds.get(normalized);
  }
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
  if (uuidPattern.test(normalized)) {
    return normalized.replace(uuidPattern, (raw) => {
      if (!generatedIds.has(raw)) {
        generatedIds.set(raw, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
      }
      return generatedIds.get(raw);
    });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)) {
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

function routeInventory() {
  const inventory = JSON.parse(readFileSync(nodeRoutesPath, "utf8"));
  const routes = new Map(inventory.routes.map((route) => [`${route.method} ${route.path}`, route]));
  return INVITE_ROUTES.map(([method, routePath]) => {
    const route = routes.get(`${method} ${routePath}`);
    assert(route, `node-routes.json is missing ${method} ${routePath}`);
    assert.equal(route.source, "apps/web/server/index.mjs");
    return { method, path: routePath, nodePath: route.nodePath, source: route.source };
  });
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-invites-contract-"));
  let db;
  let app;
  try {
    db = openTestDatabase(dataDir);
    seedMember(db);
    app = await createApp({
      logger: false,
      dataDir,
      db,
      env: {
        WORKSPACE_ENABLED: "true",
        NODE_ENV: "test",
        SERVE_STATIC: "false",
        WORKSPACE_EMAIL_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_WORKER_ENABLED: "false",
        WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false",
        WORKSPACE_FRONTEND_URL: "https://workspace.example.test"
      }
    });

    const requests = [];
    const scenarios = [];
    const invoke = async (name, request, sideEffects = {}) => {
      const response = await app.inject(request);
      const body = response.body ? response.json() : null;
      const resolvedSideEffects = typeof sideEffects === "function" ? sideEffects() : sideEffects;
      scenarios.push({
        name,
        request: captureRequest(request),
        response: { status: response.statusCode, body },
        ...(Object.keys(resolvedSideEffects).length ? { sideEffects: resolvedSideEffects } : {})
      });
      return { response, body };
    };

    const unauthenticated = await invoke(
      "create-requires-session",
      jsonRequest("POST", "/api/workspace/invites", { defaultRole: "member" })
    );
    assert.equal(unauthenticated.response.statusCode, 401);
    requests.push(unauthenticated);

    const created = await invoke(
      "create-member-invite",
      jsonRequest("POST", "/api/workspace/invites", {
        code: INVITE_CODE,
        defaultRole: "member",
        maxUses: 1,
        expiresInHours: 168
      }, OWNER_ID),
      () => ({ audit: latestAudit(db, "invite.create") })
    );
    assert.equal(created.response.statusCode, 201);
    assert.equal(created.body.invite.code, INVITE_CODE);
    const inviteId = created.body.invite.id;

    const accepted = await invoke(
      "accept-invite",
      jsonRequest("POST", `/api/workspace/invites/${encodeURIComponent(INVITE_CODE)}/accept`, {
        githubId: "github-invite-contract-member",
        githubLogin: MEMBER_LOGIN,
        displayName: "Invite Contract Member"
      }),
      () => ({ audit: latestAudit(db, "invite.accept") })
    );
    assert.equal(accepted.response.statusCode, 201);
    assert.equal(accepted.body.user.id, MEMBER_ID);

    const revoked = await invoke(
      "revoke-invite",
      jsonRequest("POST", `/api/workspace/invites/${encodeURIComponent(inviteId)}/revoke`, {}, OWNER_ID),
      () => ({ audit: latestAudit(db, "invite.revoke") })
    );
    assert.equal(revoked.response.statusCode, 200);
    assert.equal(revoked.body.invite.id, inviteId);


    const ids = new Map([[inviteId, "inv_generated"]]);
    return {
      schemaVersion: 1,
      source: {
        nodeRoutes: "apps/backend/api/node-routes.json",
        routeSource: "apps/web/server/index.mjs",
        fixtureRuntime: "apps/web/server/services/test-database.mjs"
      },
      routes: routeInventory(),
      scenarios: normalizeFixture(scenarios, ids)
    };
  } finally {
    try { await app?.close(); } finally {
      try { db?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

const mode = process.argv[2] || "--check";
assert(["--write", "--check"].includes(mode), "usage: workspace-invites-contract.mjs --write|--check");
const fixture = await createFixture();
let existing = null;
try {
  existing = JSON.parse(await readFile(fixturePath, "utf8"));
} catch (error) {
  if (mode === "--check" && error?.code !== "ENOENT") throw error;
}
if (mode === "--write") {
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`workspace invites fixture written: ${fixture.scenarios.length} scenarios`);
} else {
  assert.deepEqual(fixture, existing, "Node invite fixture is stale; run --write after an intentional contract change");
  console.log(`workspace invites fixture check passed: ${fixture.scenarios.length} scenarios`);
}
