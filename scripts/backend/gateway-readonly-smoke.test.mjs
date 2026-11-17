import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function createWebSocketFake({ workspaceEnabled = true, mode = "normal", p2pMode = "normal", sockets = [] }) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      const p2p = new URL(this.url).pathname.startsWith("/ws/p2p/");
      if (p2p && p2pMode === "throw") throw new Error("synthetic handshake refusal");
      if (mode === "throw") throw new Error("synthetic handshake refusal");
      queueMicrotask(() => {
        if (this.closed) return;
        if (p2p) {
          this.emit("open");
          if (p2pMode === "silent") return;
          if (p2pMode !== "empty") {
            const data = p2pMode === "oversized" ? "x".repeat(GATEWAY_SMOKE_LIMITS.maxWebSocketFrameBytes + 1) : JSON.stringify({
              type: "system",
              event: p2pMode === "ready" ? "room-joined" : "room-not-found"
            });
            for (let index = 0; index < (p2pMode === "too-many" ? GATEWAY_SMOKE_LIMITS.maxWebSocketFrames + 1 : 1); index += 1) {
              this.emit("message", { data });
            }
          }
          this.emit("close", { code: p2pMode === "wrong-close" ? 1000 : 1005 });
          return;
        }
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
      assert.equal(new URL(this.url).pathname, "/ws/workspace");
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
      authorization: request.headers.authorization,
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
    if (options.responses?.[pathname]) {
      const { status, payload } = options.responses[pathname];
      jsonResponse(response, status, payload);
      return;
    }
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
    if (pathname.startsWith("/api/p2p/rooms/")) {
      jsonResponse(response, 404, { error: "room not found" });
      return;
    }
    if (["/api/v1/bootstrap", "/api/v1/sync", "/api/v1/admin/overview"].includes(pathname)) {
      jsonResponse(response, 401, { error: { code: "auth.required" } });
      return;
    }
    if (["/api/bot/v2/conversations", "/api/bot/v2/doctor", "/api/bot/v2/updates"].includes(pathname)) {
      jsonResponse(response, 401, { error: { code: "bot.invalid_token" } });
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
  const upgradedSockets = new Set();
  if (options.realP2PWebSocket) {
    server.on("upgrade", (request, socket) => {
      const pathname = new URL(request.url, "http://synthetic").pathname;
      requests.push({ method: request.method, pathname, cookie: request.headers.cookie, upgrade: request.headers.upgrade });
      upgradedSockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => upgradedSockets.delete(socket));
      if (!pathname.startsWith("/ws/p2p/")) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const body = Buffer.from(JSON.stringify({ type: "system", event: "room-not-found" }));
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body, Buffer.from([0x88, 0])]));
      socket.on("data", (frame) => {
        // The read-only P2P client only replies to the server's close handshake.
        assert.equal(frame[0] & 0x0f, 0x08);
        socket.end();
      });
    });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/`;
  try {
    return await callback({ baseURL, requests });
  } finally {
    for (const socket of upgradedSockets) socket.destroy();
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

test("AppV1 releases verify WebSocket routing and new API auth boundaries without ICE or writes", async () => {
  for (const version of ["1.0.15", "1.1.0", "2.0.0"]) {
    const sockets = [];
    await withGateway({ version, responses: { "/api/p2p/ice-servers": { status: 404, payload: {} } } }, async ({ baseURL, requests }) => {
      const report = await run(smokeOptions(baseURL, "go-full", {
        expectedVersion: version,
        WebSocketImpl: createWebSocketFake({ sockets })
      }));
      assert.equal(report.status, "PASS");
      assert.equal(report.count, 17);
      assert.deepEqual(report.stages.map(({ stage }) => stage), [
        "home", "assets", "health", "p2p-room", "p2p-ws", "workspace-bootstrap",
        "workspace-v1", "bot-v2", "private-entries", "workspace-ws"
      ]);
      assert.ok(requests.every(({ method, cookie, authorization }) => method === "GET" && cookie === undefined && authorization === undefined));
      assert.equal(requests.some(({ pathname }) => pathname === "/api/p2p/ice-servers"), false);
      const p2p = sockets.find(({ url }) => new URL(url).pathname.startsWith("/ws/p2p/"));
      assert.deepEqual(p2p.sent, []);
      assert.ok(p2p.closed);
    });
  }
});

test("old Go releases retain their recovery smoke contract", async () => {
  for (const version of ["0.18.0", "1.0.14"]) {
    await withGateway({ version }, async ({ baseURL, requests }) => {
      const report = await run(smokeOptions(baseURL, "go-full", { expectedVersion: version }));
      assert.equal(report.status, "PASS");
      assert.ok(report.stages.some(({ stage }) => stage === "ice"));
      assert.equal(requests.some(({ pathname }) => pathname.startsWith("/api/v1/") || pathname.startsWith("/api/bot/v2/")), false);
    });
  }
});

test("AppV1 missing routes or broken auth cannot pass through legacy endpoint success", async () => {
  for (const [pathname, stage, status, payload, code] of [
    ["/api/v1/bootstrap", "workspace-v1", 404, {}, "unexpected_status"],
    ["/api/v1/sync", "workspace-v1", 200, { messages: ["private-data"] }, "unexpected_status"],
    ["/api/v1/admin/overview", "workspace-v1", 401, { error: { code: "wrong-auth" } }, "unexpected_error_contract"],
    ["/api/bot/v2/conversations", "bot-v2", 404, {}, "unexpected_status"],
    ["/api/bot/v2/doctor", "bot-v2", 200, { secret: "private-data" }, "unexpected_status"],
    ["/api/bot/v2/updates", "bot-v2", 401, { error: { code: "wrong-auth" } }, "unexpected_error_contract"]
  ]) {
    await withGateway({ version: "1.0.15", responses: { [pathname]: { status, payload } } }, async ({ baseURL }) => {
      const report = await run(smokeOptions(baseURL, "go-full", { expectedVersion: "1.0.15" }));
      assert.deepEqual(report.error, { stage, code });
      assert.equal(JSON.stringify(report).includes("private-data"), false);
    });
  }
});

test("P2P requires the missing-room frame and clean protocol close, not a rejected handshake", async () => {
  for (const [p2pMode, code] of [
    ["throw", "ws_handshake_rejected"],
    ["ready", "p2p_ws_missing_room_contract"],
    ["empty", "ws_missing_expected_frame"],
    ["wrong-close", "ws_unexpected_close"],
    ["oversized", "ws_frame_too_large"],
    ["too-many", "ws_frame_limit"],
    ["silent", "ws_timeout"]
  ]) {
    const sockets = [];
    await withGateway({ version: "1.0.15" }, async ({ baseURL }) => {
      const report = await run(smokeOptions(baseURL, "go-full", {
        expectedVersion: "1.0.15",
        WebSocketImpl: createWebSocketFake({ p2pMode, sockets })
      }));
      assert.deepEqual(report.error, { stage: "p2p-ws", code });
      assert.ok(sockets.every(({ sent }) => sent.length === 0));
      if (p2pMode !== "throw") assert.ok(sockets.every(({ closed }) => closed));
    });
  }
});

test("AppV1 passes a real WebSocket missing-room frame and empty close handshake", async () => {
  await withGateway({ version: "1.0.15", realP2PWebSocket: true }, async ({ baseURL, requests }) => {
    const report = await run(smokeOptions(baseURL, "go-full", {
      expectedVersion: "1.0.15",
      WebSocketImpl: globalThis.WebSocket
    }));
    assert.equal(report.status, "PASS", JSON.stringify(report));
    assert.ok(requests.some(({ pathname, upgrade }) => pathname.startsWith("/ws/p2p/") && upgrade === "websocket"));
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
