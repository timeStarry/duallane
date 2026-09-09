import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { GATEWAY_SMOKE_LIMITS, run } from "./gateway-readonly-smoke.mjs";

const COMMIT = "a".repeat(40);
const HOME_BODY = "<!doctype html><html><head><script src=\"/assets/app.js\"></script><link rel=\"stylesheet\" href=\"/assets/app.css\"></head><body></body></html>";

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function createWebSocketFake({ workspaceEnabled = true, mode = "normal" }) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.sent = [];
      this.closed = false;
      if (mode === "throw") throw new Error("synthetic handshake refusal");
      queueMicrotask(() => {
        if (this.closed) return;
        if (!workspaceEnabled) {
          this.emit("close", { code: 1013, reason: "workspace disabled" });
          return;
        }
        this.emit("open");
        if (mode === "ready") {
          this.emit("message", { data: JSON.stringify({ version: 1, type: "ready" }) });
          this.emit("close", { code: 1008, reason: "workspace access required" });
          return;
        }
        if (mode === "blob-ready") {
          const body = JSON.stringify({ version: 1, type: "ready" });
          this.emit("message", {
            data: {
              size: Buffer.byteLength(body),
              arrayBuffer: async () => new TextEncoder().encode(body).buffer
            }
          });
          this.emit("close", { code: 1008, reason: "workspace access required" });
          return;
        }
        queueMicrotask(() => {
          if (this.closed) return;
          this.emit("message", { data: JSON.stringify({
            version: 1,
            type: "error",
            error: { code: "auth.required", message: "synthetic" }
          }) });
          this.emit("close", { code: 1008, reason: "workspace access required" });
        });
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type, value) {
      for (const listener of this.listeners.get(type) ?? []) listener(value);
    }

    send(value) {
      this.sent.push(value);
      assert.equal(value, JSON.stringify({ version: 1, type: "hello", lastSeq: 0 }));
    }

    close() {
      this.closed = true;
    }
  };
}

async function withGateway(options, callback) {
  const requests = [];
  const workspaceEnabled = options.workspaceEnabled ?? true;
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      pathname: new URL(request.url, "http://synthetic").pathname,
      cookie: request.headers.cookie,
      upgrade: request.headers.upgrade
    });
    if (request.headers.cookie) {
      response.writeHead(400);
      response.end("cookie not allowed");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    const pathname = new URL(request.url, "http://synthetic").pathname;
    if (options.redirectHome && pathname === "/") {
      response.writeHead(302, { location: "http://127.0.0.1:9/other-origin" });
      response.end();
      return;
    }
    if (options.oversizedHome && pathname === "/") {
      response.writeHead(200, { "content-length": String(GATEWAY_SMOKE_LIMITS.maxHTMLBytes + 1) });
      response.end();
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(HOME_BODY);
      return;
    }
    if (pathname === "/assets/app.js" || pathname === "/assets/app.css") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("synthetic asset");
      return;
    }
    if (pathname === "/api/health") {
      jsonResponse(response, 200, { ok: true, service: "duallane", lane: "ready", appVersion: options.version });
      return;
    }
    if (pathname === "/api/p2p/ice-servers") {
      jsonResponse(response, 200, { iceServers: [{ urls: "stun:synthetic.invalid" }] });
      return;
    }
    if (pathname === "/api/workspace/bootstrap") {
      if (!workspaceEnabled) jsonResponse(response, 503, { error: { code: "workspace.disabled", message: "synthetic" } });
      else jsonResponse(response, 401, { error: { code: "auth.required", message: "synthetic" } });
      return;
    }
    if (pathname === "/ws/workspace" && request.headers.upgrade === "websocket") {
      if (!workspaceEnabled) jsonResponse(response, 503, { error: { code: "workspace.disabled" } });
      else jsonResponse(response, 401, { error: { code: "auth.required" } });
      return;
    }
    if (["/readyz", "/healthz", "/metrics"].includes(pathname)) {
      if (options.privateSpa) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(HOME_BODY);
      } else {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/`;
  try {
    return await callback({ baseURL, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function smokeOptions(baseURL, profile = "go-full", overrides = {}) {
  const workspaceEnabled = overrides.workspaceEnabled ?? true;
  return {
    baseURL,
    expectedVersion: "synthetic-version",
    fullCommit: COMMIT,
    profile,
    workspaceEnabled,
    WebSocketImpl: createWebSocketFake({ workspaceEnabled }),
    ...overrides
  };
}

test("passes both profile-specific read-only contracts and sends only bounded GETs", async () => {
  await withGateway({ profile: "go-full", version: "synthetic-version" }, async ({ baseURL, requests }) => {
    const report = await run(smokeOptions(baseURL));
    assert.equal(report.status, "PASS");
    assert.equal(report.count, 10);
    assert.deepEqual(report.stages.map(({ stage, status }) => ({ stage, status })), [
      { stage: "home", status: "PASS" },
      { stage: "assets", status: "PASS" },
      { stage: "health", status: "PASS" },
      { stage: "ice", status: "PASS" },
      { stage: "workspace-bootstrap", status: "PASS" },
      { stage: "private-entries", status: "PASS" },
      { stage: "workspace-ws", status: "PASS" }
    ]);
    assert.ok(requests.length >= 9);
    assert.ok(requests.every((request) => request.method === "GET" && request.cookie === undefined));
    assert.equal(requests.some((request) => request.method !== "GET"), false);
  });

  await withGateway({ profile: "node-default", version: "synthetic-version", workspaceEnabled: true }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL, "node-default"));
    assert.equal(report.status, "PASS");
    assert.equal(report.stages.at(-1).stage, "workspace-ws");
    assert.equal(report.stages.find(({ stage }) => stage === "workspace-bootstrap").status, "PASS");
  });

  await withGateway({ profile: "node-default", version: "synthetic-version", workspaceEnabled: true, privateSpa: true }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL, "node-default"));
    assert.equal(report.status, "PASS");
    assert.equal(report.stages.find(({ stage }) => stage === "private-entries").exposure, "not_exposed/SPA");
  });

  await withGateway({ profile: "node-default", version: "synthetic-version", workspaceEnabled: false }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL, "node-default", { workspaceEnabled: false }));
    assert.equal(report.status, "PASS");
    assert.equal(report.stages.at(-1).stage, "workspace-ws");
  });
});

test("accepts an actual HTTP WebSocket rejection when the client cannot upgrade", async () => {
  await withGateway({ profile: "go-full", version: "synthetic-version" }, async ({ baseURL, requests }) => {
    const report = await run(smokeOptions(baseURL, "go-full", {
      WebSocketImpl: createWebSocketFake({ workspaceEnabled: true, mode: "throw" })
    }));
    assert.equal(report.status, "PASS");
    const upgrade = requests.find((request) => request.pathname === "/ws/workspace");
    assert.equal(upgrade?.method, "GET");
    assert.equal(upgrade?.upgrade, "websocket");
  });
});

test("reports version HTTP evidence separately from the prevalidated immutable commit", async () => {
  await withGateway({ profile: "go-full", version: "synthetic-version" }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL));
    assert.equal(report.status, "PASS");
    assert.equal(report.stages.find(({ stage }) => stage === "health").publicCommit, "not-exposed");
  });

  await withGateway({ profile: "go-full", version: "synthetic-version", privateSpa: true }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL));
    assert.deepEqual(report.error, { stage: "private-entries", code: "private_entry_exposed" });
  });
});

test("rejects unsafe targets, redirects, oversized bodies, and unauthorized ready frames", async () => {
  const invalid = await run(smokeOptions("http://example.invalid:1234/"));
  assert.equal(invalid.status, "FAIL");
  assert.deepEqual(invalid.error, { stage: "input", code: "invalid_base_url" });

  const credentials = await run(smokeOptions("http://user:pass@127.0.0.1:1234/"));
  assert.equal(credentials.status, "FAIL");
  assert.deepEqual(credentials.error, { stage: "input", code: "invalid_base_url" });

  const missingWorkspaceFlag = await run({
    baseURL: "http://127.0.0.1:1234/",
    expectedVersion: "synthetic-version",
    fullCommit: COMMIT,
    profile: "node-default"
  });
  assert.equal(missingWorkspaceFlag.status, "FAIL");
  assert.deepEqual(missingWorkspaceFlag.error, { stage: "input", code: "invalid_workspace_enabled" });

  const disabledGo = await run(smokeOptions("http://127.0.0.1:1234/", "go-full", { workspaceEnabled: false }));
  assert.equal(disabledGo.status, "FAIL");
  assert.deepEqual(disabledGo.error, { stage: "input", code: "go_workspace_must_be_enabled" });

  await withGateway({ profile: "go-full", version: "synthetic-version", redirectHome: true }, async ({ baseURL, requests }) => {
    const report = await run(smokeOptions(baseURL));
    assert.deepEqual(report.error, { stage: "home", code: "redirect_rejected" });
    assert.equal(requests.length, 1);
  });

  await withGateway({ profile: "go-full", version: "synthetic-version", oversizedHome: true }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL));
    assert.deepEqual(report.error, { stage: "home", code: "body_too_large" });
  });

  await withGateway({ profile: "go-full", version: "synthetic-version" }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL, "go-full", {
      WebSocketImpl: createWebSocketFake({ workspaceEnabled: true, mode: "ready" })
    }));
    assert.deepEqual(report.error, { stage: "workspace-ws", code: "workspace_ws_unauthorized_ready" });
  });

  await withGateway({ profile: "go-full", version: "synthetic-version" }, async ({ baseURL }) => {
    const report = await run(smokeOptions(baseURL, "go-full", {
      WebSocketImpl: createWebSocketFake({ workspaceEnabled: true, mode: "blob-ready" })
    }));
    assert.deepEqual(report.error, { stage: "workspace-ws", code: "workspace_ws_unauthorized_ready" });
  });
});
