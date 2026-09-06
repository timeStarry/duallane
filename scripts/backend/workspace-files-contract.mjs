import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "apps/backend/internal/workspacecontract/testdata/node-files.json");
const nodeRoutesPath = path.join(repoRoot, "apps/backend/api/node-routes.json");

const OWNER_ID = "usr_owner";
const IMAGE_BYTES = Buffer.from("synthetic-image-contract-payload", "utf8");
const PART_BYTES = Buffer.from("synthetic-chunk-contract", "utf8");

const FILE_ROUTES = [
  ["GET", "/api/workspace/files"],
  ["POST", "/api/workspace/files/uploads/reserve"],
  ["GET", "/api/workspace/files/uploads/{uploadId}"],
  ["PUT", "/api/workspace/files/uploads/{uploadId}/parts/{partNumber}"],
  ["POST", "/api/workspace/files/uploads/{uploadId}/complete"],
  ["PUT", "/api/workspace/files/uploads/{uploadId}/content"],
  ["POST", "/api/workspace/files/uploads/{uploadId}/fail"],
  ["DELETE", "/api/workspace/files/{attachmentId}"],
  ["GET", "/api/workspace/files/{attachmentId}/download"],
  ["POST", "/api/workspace/files/{attachmentId}/downloads/reserve"],
  ["GET", "/api/workspace/files/{attachmentId}/preview"]
];

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

function rawRequest(method, url, payload, contentType, actorId, extraHeaders = {}) {
  return {
    method,
    url,
    headers: {
      ...(actorId ? { "x-workspace-user-id": actorId } : {}),
      "content-type": contentType,
      ...extraHeaders
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
  const body = Buffer.isBuffer(request.payload)
    ? { bodyBase64: request.payload.toString("base64") }
    : request.payload === undefined ? {} : { body: request.payload };
  return {
    method: request.method,
    path: request.url,
    headers: request.headers ?? {},
    ...body
  };
}

function responseHeaders(response) {
  const headers = {};
  for (const name of ["content-type", "cache-control", "content-disposition", "content-length"]) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = String(value);
  }
  return headers;
}

function captureResponse(response, { binary = false } = {}) {
  if (binary) {
    const payload = Buffer.isBuffer(response.rawPayload)
      ? response.rawPayload
      : Buffer.from(response.body ?? "", "binary");
    return {
      status: response.statusCode,
      headers: responseHeaders(response),
      bodyBase64: payload.toString("base64")
    };
  }
  return {
    status: response.statusCode,
    headers: responseHeaders(response),
    body: response.body ? response.json() : null
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
  return FILE_ROUTES.map(([method, routePath]) => {
    const route = routes.get(`${method} ${routePath}`);
    assert(route, `node-routes.json is missing ${method} ${routePath}`);
    assert.equal(route.source, "apps/web/server/index.mjs");
    return { method, path: routePath, nodePath: route.nodePath, source: route.source };
  });
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-files-contract-"));
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
        WORKSPACE_STORAGE_DRIVER: "local",
        WORKSPACE_EMAIL_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_WORKER_ENABLED: "false",
        WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false"
      }
    });

    const scenarios = [];
    const invoke = async (name, request, options = {}) => {
      const response = await app.inject(request);
      const resolvedSideEffects = typeof options.sideEffects === "function" ? options.sideEffects() : options.sideEffects;
      scenarios.push({
        name,
        request: captureRequest(request),
        response: captureResponse(response, options),
        ...(resolvedSideEffects ? { sideEffects: resolvedSideEffects } : {})
      });
      return { response, body: options.binary ? null : (response.body ? response.json() : null) };
    };

    const unauthenticated = await invoke("files-requires-session", emptyRequest("GET", "/api/workspace/files"));
    assert.equal(unauthenticated.response.statusCode, 401);

    await invoke("files-list-empty", emptyRequest("GET", "/api/workspace/files?scope=all&limit=5", OWNER_ID));

    const reservation = await invoke(
      "upload-reserve",
      jsonRequest("POST", "/api/workspace/files/uploads/reserve", {
        fileName: "fixture.png",
        mimeType: "image/png",
        byteSize: IMAGE_BYTES.byteLength,
        visibility: "space"
      }, OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.upload.reserve") }) }
    );
    assert.equal(reservation.response.statusCode, 201);
    const uploadId = reservation.body.upload.id;
    const attachmentId = reservation.body.attachment.id;

    await invoke(
      "upload-status-before-content",
      emptyRequest("GET", `/api/workspace/files/uploads/${uploadId}`, OWNER_ID)
    );

    await invoke(
      "upload-content-and-complete",
      rawRequest("PUT", `/api/workspace/files/uploads/${uploadId}/content`, IMAGE_BYTES, "image/png", OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.upload.completed") }) }
    );

    await invoke("files-list-after-upload", emptyRequest("GET", "/api/workspace/files?scope=all", OWNER_ID));

    const downloadReservation = await invoke(
      "download-reserve",
      jsonRequest("POST", `/api/workspace/files/${attachmentId}/downloads/reserve`, {}, OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.download.completed") }) }
    );
    assert.equal(downloadReservation.response.statusCode, 201);
    const downloadId = downloadReservation.body.id;

    await invoke(
      "file-preview",
      emptyRequest("GET", `/api/workspace/files/${attachmentId}/preview`, OWNER_ID),
      { binary: true }
    );
    await invoke(
      "file-download-with-grant",
      emptyRequest("GET", `/api/workspace/files/${attachmentId}/download?downloadId=${encodeURIComponent(downloadId)}`, OWNER_ID),
      { binary: true }
    );

    await invoke(
      "file-remove",
      emptyRequest("DELETE", `/api/workspace/files/${attachmentId}`, OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.remove") }) }
    );

    const chunkReservation = await invoke(
      "chunk-upload-reserve",
      jsonRequest("POST", "/api/workspace/files/uploads/reserve", {
        fileName: "fixture.txt",
        mimeType: "text/plain",
        byteSize: PART_BYTES.byteLength,
        visibility: "space"
      }, OWNER_ID)
    );
    const chunkUploadId = chunkReservation.body.upload.id;
    const partHash = createHash("sha256").update(PART_BYTES).digest("hex");
    await invoke(
      "chunk-upload-part",
      rawRequest(
        "PUT",
        `/api/workspace/files/uploads/${chunkUploadId}/parts/1`,
        PART_BYTES,
        "application/octet-stream",
        OWNER_ID,
        {
          "content-length": String(PART_BYTES.byteLength),
          "x-duallane-part-sha256": partHash
        }
      )
    );
    await invoke(
      "chunk-upload-status",
      emptyRequest("GET", `/api/workspace/files/uploads/${chunkUploadId}`, OWNER_ID)
    );
    await invoke(
      "chunk-upload-complete",
      jsonRequest("POST", `/api/workspace/files/uploads/${chunkUploadId}/complete`, { mode: "chunked" }, OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.upload.completed") }) }
    );

    const failedReservation = await invoke(
      "upload-reserve-for-failure",
      jsonRequest("POST", "/api/workspace/files/uploads/reserve", {
        fileName: "failed.txt",
        mimeType: "text/plain",
        byteSize: 4,
        visibility: "space"
      }, OWNER_ID)
    );
    await invoke(
      "upload-fail",
      jsonRequest("POST", `/api/workspace/files/uploads/${failedReservation.body.upload.id}/fail`, { reason: "synthetic_cancel" }, OWNER_ID),
      { sideEffects: () => ({ audit: latestAudit(db, "file.upload.failed") }) }
    );


    return {
      schemaVersion: 1,
      source: {
        nodeRoutes: "apps/backend/api/node-routes.json",
        routeSource: "apps/web/server/index.mjs",
        fixtureRuntime: "apps/web/server/services/test-database.mjs"
      },
      routes: routeInventory(),
      scenarios: normalizeFixture(scenarios, new Map())
    };
  } finally {
    try { await app?.close(); } finally {
      try { db?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

const mode = process.argv[2] || "--check";
assert(["--write", "--check"].includes(mode), "usage: workspace-files-contract.mjs --write|--check");
const fixture = await createFixture();
let existing = null;
try {
  existing = JSON.parse(await readFile(fixturePath, "utf8"));
} catch (error) {
  if (mode === "--check" && error?.code !== "ENOENT") throw error;
}
if (mode === "--write") {
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`workspace files fixture written: ${fixture.scenarios.length} scenarios`);
} else {
  assert.deepEqual(fixture, existing, "Node files fixture is stale; run --write after an intentional contract change");
  console.log(`workspace files fixture check passed: ${fixture.scenarios.length} scenarios`);
}
