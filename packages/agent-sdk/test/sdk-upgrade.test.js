import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DualLaneAgentClient, DualLaneAgentSetupClient, DUALLANE_AGENT_SDK_VERSION } from "../src/index.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { getDaemonStateDir } from "../src/daemon.js";
import { loadAgentProfile, saveAgentProfile } from "../src/profile-store.js";

const token = `dl_bot_${"u".repeat(32)}`;
const upgrade = { error: { code: "sdk.upgrade_required", minimumSdkVersion: "1.2.0", latestSdkVersion: "1.2.0",
  runtimeManifestUrl: "/integrations/duallane-agent.manifest.json", docsUrl: "/integrations/v2/duallane-channel.md", skillUrl: "/integrations/duallane-agent/SKILL.md" } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const makeClient = (fetch, more = {}) => new DualLaneAgentClient({ url: "https://gateway.example", token, fetch, ...more });
const sendJson = (response, body, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
async function gatewayFixture(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
function rejectUpgrade(socket, body = upgrade) {
  const data = JSON.stringify(body);
  socket.end(`HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`);
}
function acceptSocket(request, socket) {
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ready = Buffer.from(JSON.stringify({ version: 1, type: "ready", currentSequence: 0 }));
  socket.write(Buffer.concat([Buffer.from([0x81, ready.length]), ready]));
}

test("SDK and setup always declare their actual version independently of custom adapter metadata", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), init }); return json({}); };
  const client = makeClient(fetch, { adapterVersion: "legacy/0.1.0", headers: { "x-duallane-sdk-version": "0.1.0" } });
  await client.getMe();
  const task = client.forTask({ id: "t1", conversationId: "c1", triggerMessageId: "m1", expiresAt: Date.now() + 60_000 });
  try { await task.validate().catch(() => {}); } finally { task.close(); }
  const setup = new DualLaneAgentSetupClient({ url: "https://gateway.example", fetch });
  const setupId = `setup_${"x".repeat(32)}`;
  await setup.request(setupId, { clientVersion: "0.1.0" }); await setup.status(setupId); await setup.exchange(setupId, { clientVersion: "0.1.0" });
  assert.ok(calls.length >= 5);
  for (const { init } of calls) assert.equal(init.headers["x-duallane-sdk-version"], DUALLANE_AGENT_SDK_VERSION);
  for (const { init } of calls.filter(({ url }) => /setup\/(request|exchange)$/u.test(url))) assert.equal(JSON.parse(init.body).clientVersion, "0.1.0");
  await setup.request(setupId);
  assert.equal(JSON.parse(calls.at(-1).init.body).clientVersion, DUALLANE_AGENT_SDK_VERSION);
  assert.equal(calls[0].init.headers["x-duallane-adapter-version"], "legacy/0.1.0");
});

test("426 is terminal, does not retain server secrets or attacker upgrade URLs, and has same-origin guidance", async () => {
  const payload = { error: { ...upgrade.error, message: token, minimumSdkVersion: token, runtimeManifestUrl: `https://attacker.example/${token}`, docsUrl: `/${token}`, skillUrl: `//attacker.example/${token}` } };
  await assert.rejects(makeClient(async () => json(payload, 426)).getMe(), (error) => {
    assert.equal(error.code, "sdk.upgrade_required"); assert.equal(error.retryable, false); assert.equal(error.statusCode, 426);
    assert.equal(error.upgrade.minimumSdkVersion, "1.2.0");
    for (const value of Object.values(error.upgrade).filter((item) => item.startsWith("https:"))) assert.ok(value.startsWith("https://gateway.example/integrations/"));
    assert.ok(!JSON.stringify(error).includes(token)); assert.ok(!error.message.includes(token)); return true;
  });
  await assert.rejects(new DualLaneAgentSetupClient({ url: "https://gateway.example", fetch: async () => json(upgrade, 426) }).status(`setup_${"x".repeat(32)}`), (error) => error.code === "sdk.upgrade_required" && !error.retryable && Boolean(error.upgrade));
});

test("WS preflight rejection opens no socket and cannot schedule a reconnect or polling fallback", async () => {
  let requests = 0, connections = 0;
  const client = makeClient(async () => { requests++; return json(upgrade, 426); }, { webSocketFactory() { connections++; }, reconnect: { minDelayMs: 100, maxDelayMs: 500 } });
  await assert.rejects(client.connect(), (error) => error.code === "sdk.upgrade_required" && !error.retryable);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(requests, 1); assert.equal(connections, 0); assert.equal(client.connected, false);
});

test("Node WS performs real authenticated preflight and declares SDK version again on the handshake", async () => {
  const seen = [];
  const fixture = await gatewayFixture((request, response) => { seen.push({ route: request.url, headers: request.headers }); sendJson(response, {}); });
  fixture.server.on("upgrade", (request, socket) => { seen.push({ route: request.url, headers: request.headers }); acceptSocket(request, socket); });
  const client = new DualLaneAgentClient({ url: fixture.url, token });
  try {
    await client.connect();
    assert.deepEqual(seen.map((item) => item.route), ["/api/bot-gateway/v1/me", "/ws/bot-gateway"]);
    for (const item of seen) { assert.equal(item.headers["x-duallane-sdk-version"], DUALLANE_AGENT_SDK_VERSION); assert.equal(item.headers.authorization, `Bearer ${token}`); assert.ok(!item.route.includes(token)); }
  } finally { client.stop(); await fixture.close(); }
});

test("WS handshake 426 after a successful preflight is terminal and returns bounded upgrade guidance", async () => {
  let handshakes = 0, preflights = 0;
  const fixture = await gatewayFixture((_request, response) => { preflights++; sendJson(response, {}); });
  fixture.server.on("upgrade", (_request, socket) => { handshakes++; rejectUpgrade(socket); });
  const client = new DualLaneAgentClient({ url: fixture.url, token, reconnect: { minDelayMs: 100, maxDelayMs: 500 } });
  try {
    await assert.rejects(client.connect(), (error) => error.code === "sdk.upgrade_required" && error.statusCode === 426 && !error.retryable && error.upgrade.runtimeManifestUrl.startsWith(fixture.url));
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(preflights, 1); assert.equal(handshakes, 1);
  } finally { client.stop(); await fixture.close(); }
});

test("EventTarget WS adapters receive the same fixed headers and terminal upgrade frames stop transport", async () => {
  let closed = false;
  const client = makeClient(async () => json({}), { webSocketFactory(_url, options) {
    assert.equal(options.headers["x-duallane-sdk-version"], DUALLANE_AGENT_SDK_VERSION); assert.equal(options.headers.authorization, `Bearer ${token}`);
    const socket = new EventTarget(); socket.readyState = 0;
    socket.close = () => { closed = true; socket.readyState = 3; socket.dispatchEvent(new Event("close")); };
    socket.send = () => { const event = new Event("message"); Object.defineProperty(event, "data", { value: JSON.stringify({ version: 1, type: "error", ...upgrade }) }); socket.dispatchEvent(event); };
    setImmediate(() => { socket.readyState = 1; socket.dispatchEvent(new Event("open")); }); return socket;
  } });
  await assert.rejects(client.connect(), (error) => error.code === "sdk.upgrade_required" && !error.retryable);
  assert.equal(closed, true);
});

test("native browser-style WS cannot silently move Bot credentials into the URL or subprotocol", { skip: typeof globalThis.WebSocket !== "function" }, async () => {
  let rejected = 0;
  const fixture = await gatewayFixture((_request, response) => sendJson(response, {}));
  fixture.server.on("upgrade", (request, socket) => {
    assert.equal(request.url, "/ws/bot-gateway"); assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["sec-websocket-protocol"], undefined); rejected++; rejectUpgrade(socket);
  });
  const client = new DualLaneAgentClient({ url: fixture.url, token, webSocketFactory: (url) => new WebSocket(url) });
  try { await assert.rejects(client.connect()); assert.equal(rejected, 1); assert.equal(client.connected, false); }
  finally { client.stop(); await fixture.close(); }
});

test("MCP surfaces forced upgrade as a failed tool with safe guidance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-upgrade-mcp-"));
  try {
    saveAgentProfile("default", { url: "https://gateway.example", token }, { configDir: directory });
    const server = createDualLaneMcpServer({ configDir: directory, fetch: async () => json(upgrade, 426) });
    const response = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "duallane_status", arguments: {} } });
    assert.equal(response.result.isError, true);
    const error = JSON.parse(response.result.content[0].text).error;
    assert.equal(error.code, "sdk.upgrade_required"); assert.equal(error.retryable, false); assert.ok(error.upgrade.runtimeManifestUrl); assert.ok(!JSON.stringify(response).includes(token));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI empty-queue and daemon startup cannot report success on 426, and the daemon saves a pause without re-pairing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-upgrade-cli-"));
  const configDir = path.join(directory, "agents");
  let calls = 0;
  const fixture = await gatewayFixture((_request, response) => { calls++; sendJson(response, upgrade, 426); });
  const cli = fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url));
  async function run(args) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: configDir }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("synthetic CLI deadline")); }, 10_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject); child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }
  try {
    saveAgentProfile("default", { url: fixture.url, token, botId: "synthetic_bot", lastSequence: 17 }, { configDir });
    const before = loadAgentProfile("default", { configDir });
    for (const args of [["updates"], ["wait", "--transport", "auto", "--timeout", "5"], ["daemon", "run", "--cmd", "synthetic-command-must-not-run", "--transport", "poll"]]) {
      const result = await run(args);
      assert.equal(result.code, 1, result.stderr); assert.equal(result.stdout, "");
      const detail = JSON.parse(result.stderr.trim().split(/\r?\n/u).at(-1));
      assert.equal(detail.code, "sdk.upgrade_required"); assert.equal(detail.retryable, false);
      assert.ok(detail.updateCommand.includes(cli));
      assert.ok(detail.updateCommand.includes("'update' '--profile' 'default' '--url'"));
      assert.ok(detail.updateCommand.includes(fixture.url));
      assert.equal(detail.updateCommand.startsWith("& "), process.platform === "win32");
      assert.ok(!result.stderr.includes(token));
    }
    assert.equal(calls, 3);
    const record = JSON.parse(fs.readFileSync(path.join(getDaemonStateDir(configDir), "default.json"), "utf8"));
    assert.equal(record.pausedReason, "sdk.upgrade_required"); assert.equal(record.healthy, false); assert.ok(record.upgrade.runtimeManifestUrl);
    assert.deepEqual(loadAgentProfile("default", { configDir }), before);
    // A future server floor can change while an already-running daemon polls.
    // Start a distinct record; /me succeeds but the next credentialed call rejects.
    saveAgentProfile("active", { url: fixture.url, token, botId: "synthetic-bot" }, { configDir });
    fixture.server.removeAllListeners("request");
    let polls = 0;
    fixture.server.on("request", (request, response) => {
      if (request.url.endsWith("/me")) sendJson(response, { bot: { id: "synthetic-bot" }, scopes: [] });
      else { polls++; sendJson(response, upgrade, 426); }
    });
    const active = await run(["daemon", "run", "--profile", "active", "--cmd", "synthetic-command-must-not-run", "--transport", "poll"]);
    assert.equal(active.code, 1, active.stderr); assert.equal(polls, 1);
    const activeRecord = JSON.parse(fs.readFileSync(path.join(getDaemonStateDir(configDir), "active.json"), "utf8"));
    assert.equal(activeRecord.pausedReason, "sdk.upgrade_required"); assert.equal(activeRecord.healthy, false);
  } finally { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
