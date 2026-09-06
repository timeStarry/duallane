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
const fixturePath = path.join(repoRoot, "apps/backend/internal/workspacecontract/testdata/node-notifications.json");
const nodeRoutesPath = path.join(repoRoot, "apps/backend/api/node-routes.json");

const OWNER_ID = "usr_owner";
const OWNER_EMAIL = "owner@example.test";
const SMTP_INPUT = {
  smtpHost: "smtp.example.test",
  smtpPort: 2525,
  encryption: "starttls",
  fromAddress: "noreply@example.test",
  fromName: "DualLane Contract"
};

const NOTIFICATION_ROUTES = [
  ["POST", "/api/workspace/me/notification-email/challenges"],
  ["POST", "/api/workspace/me/notification-email/use-github"],
  ["POST", "/api/workspace/me/notification-email/verify"],
  ["GET", "/api/workspace/me/notifications"],
  ["PATCH", "/api/workspace/me/notifications"],
  ["GET", "/api/workspace/me/ntfy"],
  ["PATCH", "/api/workspace/me/ntfy"],
  ["POST", "/api/workspace/me/ntfy/rotate"],
  ["GET", "/api/workspace/settings/email"],
  ["PUT", "/api/workspace/settings/email"],
  ["POST", "/api/workspace/settings/email/test"]
];

function iso(value = Date.now()) {
  return new Date(value).toISOString();
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

function replaceString(value, replacements, generatedIds) {
  if (replacements.has(value)) return replacements.get(value);
  let normalized = value;
  for (const [raw, canonical] of replacements) normalized = normalized.split(raw).join(canonical);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    if (!generatedIds.has(normalized)) {
      generatedIds.set(normalized, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
    }
    return generatedIds.get(normalized);
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(normalized) && normalized.length > 50) {
    return "fixture-test-proof";
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)) {
    return "2026-01-01T00:00:00.000Z";
  }
  return normalized;
}

function normalizeFixture(value, replacements, generatedIds = new Map()) {
  if (Array.isArray(value)) return value.map((item) => normalizeFixture(item, replacements, generatedIds));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? replaceString(value, replacements, generatedIds) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeFixture(child, replacements, generatedIds)]));
}

function routeInventory() {
  const inventory = JSON.parse(readFileSync(nodeRoutesPath, "utf8"));
  const routes = new Map(inventory.routes.map((route) => [`${route.method} ${route.path}`, route]));
  return NOTIFICATION_ROUTES.map(([method, routePath]) => {
    const route = routes.get(`${method} ${routePath}`);
    assert(route, `node-routes.json is missing ${method} ${routePath}`);
    assert.equal(route.source, "apps/web/server/index.mjs");
    return { method, path: routePath, nodePath: route.nodePath, source: route.source };
  });
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-notifications-contract-"));
  let db;
  let app;
  try {
    db = openTestDatabase(dataDir);
    const sentMail = [];
    app = await createApp({
      logger: false,
      dataDir,
      db,
      workspaceEmailSender: async (config, message, recipient) => {
        sentMail.push({ config, message, recipient });
      },
      env: {
        WORKSPACE_ENABLED: "true",
        NODE_ENV: "test",
        SERVE_STATIC: "false",
        WORKSPACE_EMAIL_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_WORKER_ENABLED: "false",
        WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_BASE_URL: "https://ntfy.example.test",
        WORKSPACE_SMTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        WORKSPACE_FRONTEND_URL: "https://workspace.example.test"
      }
    });

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
      "notifications-requires-session",
      emptyRequest("GET", "/api/workspace/me/notifications")
    );
    assert.equal(unauthenticated.response.statusCode, 401);

    await invoke("notifications-get", emptyRequest("GET", "/api/workspace/me/notifications", OWNER_ID));
    await invoke(
      "ntfy-get",
      emptyRequest("GET", "/api/workspace/me/ntfy", OWNER_ID)
    );
    await invoke(
      "ntfy-patch-disabled",
      jsonRequest("PATCH", "/api/workspace/me/ntfy", { enabled: false }, OWNER_ID)
    );
    await invoke(
      "ntfy-patch-enabled",
      jsonRequest("PATCH", "/api/workspace/me/ntfy", { enabled: true }, OWNER_ID)
    );
    await invoke(
      "ntfy-rotate",
      emptyRequest("POST", "/api/workspace/me/ntfy/rotate", OWNER_ID)
    );

    await invoke("email-settings-get-before-config", emptyRequest("GET", "/api/workspace/settings/email", OWNER_ID));
    const tested = await invoke(
      "email-settings-test",
      jsonRequest("POST", "/api/workspace/settings/email/test", SMTP_INPUT, OWNER_ID),
      () => ({ audit: latestAudit(db, "email.smtp_test") })
    );
    assert.equal(tested.response.statusCode, 200);
    const testProof = tested.body.testProof;

    await invoke(
      "email-settings-put",
      jsonRequest("PUT", "/api/workspace/settings/email", {
        ...SMTP_INPUT,
        enabled: true,
        testProof
      }, OWNER_ID),
      () => ({ audit: latestAudit(db, "email.smtp_settings_update") })
    );
    await invoke("email-settings-get", emptyRequest("GET", "/api/workspace/settings/email", OWNER_ID));

    const challenge = await invoke(
      "email-challenge-create",
      jsonRequest("POST", "/api/workspace/me/notification-email/challenges", { email: "notify@example.test" }, OWNER_ID),
      () => ({ audit: latestAudit(db, "email.verification_send") })
    );
    assert.equal(challenge.response.statusCode, 201);
    const challengeId = challenge.body.challengeId;
    const challengeMessage = sentMail.at(-1)?.message?.text ?? "";
    const code = challengeMessage.match(/\b\d{6}\b/u)?.[0];
    assert(code, "the synthetic sender did not receive the verification code");

    await invoke(
      "email-challenge-verify",
      jsonRequest("POST", "/api/workspace/me/notification-email/verify", { challengeId, code }, OWNER_ID),
      () => ({ audit: latestAudit(db, "email.verification_confirm") })
    );
    await invoke(
      "email-use-github",
      emptyRequest("POST", "/api/workspace/me/notification-email/use-github", OWNER_ID)
    );
    await invoke(
      "notifications-patch",
      jsonRequest("PATCH", "/api/workspace/me/notifications", {
        enabled: true,
        immediateEnabled: true,
        digestEnabled: false
      }, OWNER_ID)
    );


    const replacements = new Map([
      [OWNER_EMAIL, "owner@example.test"],
      ["timestarry@qq.com", "owner@example.test"],
      [testProof, "fixture-test-proof"],
      [challengeId, "generated_challenge"],
      [code, "123456"],
      [scenarios.find((scenario) => scenario.name === "ntfy-get")?.response.body?.ntfy?.topic, "duallane-owner-initial"],
      [scenarios.find((scenario) => scenario.name === "ntfy-rotate")?.response.body?.ntfy?.topic, "duallane-owner-rotated"]
    ]);
    return {
      schemaVersion: 1,
      source: {
        nodeRoutes: "apps/backend/api/node-routes.json",
        routeSource: "apps/web/server/index.mjs",
        fixtureRuntime: "apps/web/server/services/test-database.mjs"
      },
      routes: routeInventory(),
      scenarios: normalizeFixture(scenarios, replacements)
    };
  } finally {
    try { await app?.close(); } finally {
      try { db?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

const mode = process.argv[2] || "--check";
assert(["--write", "--check"].includes(mode), "usage: workspace-notifications-contract.mjs --write|--check");
const fixture = await createFixture();
let existing = null;
try {
  existing = JSON.parse(await readFile(fixturePath, "utf8"));
} catch (error) {
  if (mode === "--check" && error?.code !== "ENOENT") throw error;
}
if (mode === "--write") {
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`workspace notifications fixture written: ${fixture.scenarios.length} scenarios`);
} else {
  assert.deepEqual(fixture, existing, "Node notifications fixture is stale; run --write after an intentional contract change");
  console.log(`workspace notifications fixture check passed: ${fixture.scenarios.length} scenarios`);
}
