import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createDualLaneMcpServer, startDualLaneMcpStdioServer } from "../src/mcp.js";
import { loadAgentProfile, parseSetupTarget } from "../src/profile-store.js";

const SETUP_ID = `setup_${"b".repeat(32)}`;
const RAW_TOKEN = `dl_bot_${"c".repeat(36)}`;

test("parseSetupTarget accepts full workspace setup URLs and bare setup IDs", () => {
  const fromUrl = parseSetupTarget(`https://duallane.example.com/workspace?setup=${SETUP_ID}`);
  assert.equal(fromUrl.origin, "https://duallane.example.com");
  assert.equal(fromUrl.setupSessionId, SETUP_ID);
  assert.equal(fromUrl.approvalUrl, `https://duallane.example.com/workspace?setup=${SETUP_ID}`);

  const fromBare = parseSetupTarget(SETUP_ID, "https://duallane.example.com/some/path");
  assert.equal(fromBare.origin, "https://duallane.example.com");
  assert.equal(fromBare.setupSessionId, SETUP_ID);
});

test("MCP setup_start -> setup_finish pairs Bot, writes 0600 profile, and never exposes raw token to LLM", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duallane-mcp-test-"));
  const calls = [];

  const mockFetch = async (url, init = {}) => {
    const href = url.toString();
    calls.push({ href, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });

    if (href.endsWith("/api/bot-gateway/v1/setup/request")) {
      return jsonResponse({ session: { id: SETUP_ID, status: "pending" } });
    }
    if (href.includes("/api/bot-gateway/v1/setup/status")) {
      return jsonResponse({ setup: { id: SETUP_ID, status: "approved" } });
    }
    if (href.endsWith("/api/bot-gateway/v1/setup/exchange")) {
      return jsonResponse(
        {
          token: RAW_TOKEN,
          tokenRecord: { id: "btk_1", scopes: ["messages:read_trigger", "messages:send", "cards:write"] },
          session: { id: SETUP_ID, botId: "bot_universal_1", status: "exchanged" },
        },
        201
      );
    }
    if (href.endsWith("/api/bot-gateway/v1/me")) {
      return jsonResponse({
        version: 1,
        bot: { id: "bot_universal_1", botUserId: "usr_bot_1", name: "通用协作助手" },
        scopes: ["messages:read_trigger", "messages:read_context", "messages:send", "cards:write", "cards:act"],
      });
    }
    if (href.endsWith("/api/bot/v2/conversations")) {
      return jsonResponse({
        conversations: [
          { id: "conv_dm_1", type: "direct", title: "Owner", allowSend: true, allowTrigger: true, allowContext: true, maxMessages: 50 },
        ],
      });
    }
    if (href.endsWith("/api/bot-gateway/v1/messages")) {
      return jsonResponse({ message: { id: "msg_out_1", conversationId: "conv_dm_1" } }, 201);
    }
    if (href.endsWith("/api/bot/v2/messages/msg_out_1")) {
      return jsonResponse({ ok: true, messageId: "msg_out_1" });
    }
    if (href.endsWith("/api/bot-gateway/v1/cards")) {
      return jsonResponse({ card: { id: "card_1", revision: 1 }, message: { id: "msg_card_1" } }, 201);
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  const server = createDualLaneMcpServer({
    configDir: tmpDir,
    fetch: mockFetch,
    sleep: async () => {},
    webSocketFactory: async () => new FakeGatewaySocket(),
  });

  // 1. Initialize & list tools
  const initRes = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", clientInfo: { name: "claude-code", version: "1.0" } },
  });
  assert.equal(initRes.result.protocolVersion, "2025-03-26");

  const listRes = await server.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listRes.result.tools.length >= 8, true);

  // 2. Start setup
  const startRes = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "duallane_setup_start",
      arguments: {
        setupUrl: `https://duallane.example.com/workspace?setup=${SETUP_ID}`,
        clientName: "Universal Test Agent",
      },
    },
  });
  assert.equal(startRes.result.isError, false);
  assert.equal(startRes.result.structuredContent.approvalUrl, `https://duallane.example.com/workspace?setup=${SETUP_ID}`);

  // 3. Finish setup
  const finishRes = await server.handleJsonRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "duallane_setup_finish", arguments: { waitSeconds: 5 } },
  });
  assert.equal(finishRes.result.isError, false);
  assert.equal(finishRes.result.structuredContent.status, "connected");
  assert.equal(finishRes.result.structuredContent.bot.name, "通用协作助手");
  assert.equal(JSON.stringify(finishRes).includes(RAW_TOKEN), false, "MCP output must never expose raw token");

  // Check file mode 0600 on POSIX
  const savedProfile = loadAgentProfile("default", { configDir: tmpDir });
  assert.equal(savedProfile.token, RAW_TOKEN);
  const mode = fs.statSync(savedProfile.filePath).mode & 0o777;
  assert.equal(mode, 0o600);

  // 4. Send message, edit message, and send interactive card
  const sendRes = await server.callTool("duallane_send_message", {
    conversationId: "conv_dm_1",
    text: "任务已开始执行…",
  });
  assert.equal(sendRes.message.id, "msg_out_1");

  const editRes = await server.callTool("duallane_edit_message", {
    messageId: "msg_out_1",
    plainText: "任务执行完毕！",
  });
  assert.equal(editRes.ok, true);

  const cardRes = await server.callTool("duallane_send_card", {
    conversationId: "conv_dm_1",
    title: "部署确认",
    markdown: "是否继续部署生产环境？",
    tone: "orange",
    buttons: [
      { actionId: "confirm", label: "批准", style: "primary", value: { env: "prod" } },
      { actionId: "cancel", label: "取消", style: "danger" },
    ],
  });
  assert.equal(cardRes.card.id, "card_1");

  // 5. Wait for incoming event over WebSocket and persist sequence cursor
  const waitRes = await server.callTool("duallane_wait_for_event", {
    timeoutSeconds: 5,
    conversationId: "conv_dm_1",
  });
  assert.equal(waitRes.timeout, false);
  assert.equal(waitRes.event.eventId, "evt_live_9");
  assert.equal(loadAgentProfile("default", { configDir: tmpDir }).lastSequence, 9);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Stdio MCP transport supports both newline-delimited JSON and Content-Length framing", async () => {
  // 1. Newline framing
  const inNl = new PassThrough();
  const outNl = new PassThrough();
  startDualLaneMcpStdioServer({ stdin: inNl, stdout: outNl });

  const nlPromise = onceData(outNl);
  inNl.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" })}\n`);
  const nlRaw = await nlPromise;
  assert.deepEqual(JSON.parse(nlRaw.trim()), { jsonrpc: "2.0", id: 10, result: {} });

  // 2. Content-Length framing
  const inCl = new PassThrough();
  const outCl = new PassThrough();
  startDualLaneMcpStdioServer({ stdin: inCl, stdout: outCl });

  const reqJson = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" });
  const clPromise = onceData(outCl);
  inCl.write(`Content-Length: ${Buffer.byteLength(reqJson)}\r\n\r\n${reqJson}`);
  const clRaw = await clPromise;
  assert.equal(clRaw.startsWith("Content-Length:"), true);
  const body = clRaw.split("\r\n\r\n")[1];
  assert.deepEqual(JSON.parse(body), { jsonrpc: "2.0", id: 11, result: {} });
});

class FakeGatewaySocket extends EventEmitter {
  readyState = 0;

  constructor() {
    super();
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ version: 1, type: "ready", currentSequence: 8, replayCount: 0 }));
        this.emit(
          "message",
          JSON.stringify({
            version: 1,
            type: "event",
            event: {
              eventId: "evt_live_9",
              sequence: 9,
              type: "card.action",
              conversationId: "conv_dm_1",
              payload: { actionId: "confirm", value: { env: "prod" } },
            },
          })
        );
      });
    }
    if (frame.type === "ack") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ version: 1, type: "ack", acknowledged: true, eventId: frame.eventId, sequence: frame.sequence }));
      });
    }
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, "");
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function onceData(stream) {
  return new Promise((resolve) => {
    stream.once("data", (chunk) => resolve(chunk.toString("utf8")));
  });
}
