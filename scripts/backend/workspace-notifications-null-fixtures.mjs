import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const goldenPath = path.join(repoRoot, "scripts/backend/testdata/workspace-notifications-null.json");
const ownerID = "usr_owner";

function flags(body) {
  return {
    enabled: body.notifications.enabled,
    immediateEnabled: body.notifications.immediateEnabled,
    digestEnabled: body.notifications.digestEnabled
  };
}

function patchRequest(payload) {
  return {
    method: "PATCH",
    url: "/api/workspace/me/notifications",
    headers: {
      "x-workspace-user-id": ownerID,
      "content-type": "application/json"
    },
    payload
  };
}

function getRequest() {
  return {
    method: "GET",
    url: "/api/workspace/me/notifications",
    headers: { "x-workspace-user-id": ownerID }
  };
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-notifications-null-"));
  let db;
  let app;
  try {
    db = openTestDatabase(dataDir);
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
        WORKSPACE_NTFY_BASE_URL: "https://ntfy.example.test",
        WORKSPACE_SMTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        WORKSPACE_FRONTEND_URL: "https://workspace.example.test"
      }
    });

    const scenarios = [];
    const invoke = async (name, request) => {
      const response = await app.inject(request);
      const body = response.json();
      assert.equal(response.statusCode, 200, `${name} status`);
      const result = { name, request, response: { status: response.statusCode, flags: flags(body) } };
      scenarios.push(result);
      return result.response.flags;
    };

    const initialResponse = await app.inject(getRequest());
    const initialBody = initialResponse.json();
    assert.equal(initialResponse.statusCode, 200, "initial status");
    const initialFlags = flags(initialBody);
    assert.deepEqual(initialFlags, { enabled: true, immediateEnabled: false, digestEnabled: true });
    scenarios.push({
      name: "initial-true-state",
      request: getRequest(),
      response: { status: initialResponse.statusCode, flags: initialFlags }
    });

    const nullEnabled = await invoke("explicit-null-enabled", patchRequest({ enabled: null }));
    assert.deepEqual(nullEnabled, { enabled: false, immediateEnabled: false, digestEnabled: true });

    const restoredEnabled = await invoke("restore-enabled", patchRequest({ enabled: true }));
    assert.deepEqual(restoredEnabled, { enabled: true, immediateEnabled: false, digestEnabled: true });

    const omittedEnabled = await invoke("omitted-enabled", patchRequest({}));
    assert.deepEqual(omittedEnabled, { enabled: true, immediateEnabled: false, digestEnabled: true });

    const immediateTrue = await invoke("set-immediate-true", patchRequest({ immediateEnabled: true }));
    assert.deepEqual(immediateTrue, { enabled: true, immediateEnabled: true, digestEnabled: true });

    const nullImmediate = await invoke("explicit-null-immediate", patchRequest({ immediateEnabled: null }));
    assert.deepEqual(nullImmediate, { enabled: true, immediateEnabled: false, digestEnabled: true });

    const omittedImmediate = await invoke("omitted-immediate", patchRequest({}));
    assert.deepEqual(omittedImmediate, { enabled: true, immediateEnabled: false, digestEnabled: true });

    const fixture = {
      contract: "node-workspace-notifications-null-v1",
      source: "apps/web/server/index.mjs + services/workspace-email.mjs",
      database: "synthetic-sqlite",
      scenarios
    };
    if (process.argv.includes("--write")) {
      await writeFile(goldenPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    } else {
      assert.deepEqual(fixture, JSON.parse(await readFile(goldenPath, "utf8")));
    }
    process.stdout.write(`workspace notifications null fixture ${process.argv.includes("--write") ? "written" : "verified"} ${scenarios.length} PASS\n`);
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        db?.close();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }
}

await main();
