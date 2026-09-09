import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import Fastify from "../../apps/web/node_modules/fastify/fastify.js";
import fastifyWebsocket from "../../apps/web/node_modules/@fastify/websocket/index.js";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "../../apps/web/server/services/workspace-bot-gateway.mjs";
import { registerWorkspaceBotGatewayRoutes } from "../../apps/web/server/routes/workspace-bot-gateway.mjs";

const SPACE_ID = "spc_default";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(SCRIPT_DIR, "testdata", "bot-websocket-goldens.json");

class RawWebSocketClient {
  constructor(socket, initialData = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initialData;
    this.frames = [];
    this.waiters = [];
    this.failure = null;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("WebSocket TCP connection closed")));
    this.drain();
  }

  static async connect(port, authorization) {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    const headers = [
      "GET /ws/bot-gateway HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: ${authorization}`,
      "",
      ""
    ].join("\r\n");
    socket.write(headers);
    const { response, remainder } = await readUpgrade(socket);
    assert.match(response, /^HTTP\/1\.1 101 /u, response);
    return new RawWebSocketClient(socket, remainder);
  }

  sendJSON(value, binary = false) {
    return this.sendRaw(Buffer.from(JSON.stringify(value), "utf8"), binary);
  }

  sendRaw(payload, binary = false) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const frame = encodeFrame(binary ? 0x2 : 0x1, body);
    this.socket.write(frame);
  }

  async readJSON() {
    while (true) {
      const frame = await this.readFrame();
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x8) throw new Error(`unexpected close ${readClose(frame.payload).reason}`);
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        return JSON.parse(frame.payload.toString("utf8"));
      }
    }
  }

  async readClose() {
    while (true) {
      const frame = await this.readFrame();
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x8) return readClose(frame.payload);
    }
  }

  async readFrame(timeoutMs = 3000) {
    if (this.frames.length > 0) return this.frames.shift();
    if (this.failure) throw this.failure;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry.resolve !== resolve);
        reject(new Error("timed out waiting for WebSocket frame"));
      }, timeoutMs);
      this.waiters.push({
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  close() {
    if (!this.socket.destroyed) this.socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  drain() {
    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  const mask = randomBytes(4);
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
    length = Number(longLength);
    offset += 8;
  }
  const masked = (second & 0x80) !== 0;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  return { opcode: first & 0x0f, payload, bytes: offset + length };
}

async function readUpgrade(socket) {
  let buffer = Buffer.alloc(0);
  return await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (marker < 0) return;
      socket.off("data", onData);
      resolve({ response: buffer.subarray(0, marker).toString("latin1"), remainder: buffer.subarray(marker + 4) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function readClose(payload) {
  if (payload.length < 2) return { code: 1005, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") };
}

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN_PATH, "utf8"));
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-websocket-fixture-"));
  const db = openTestDatabase(directory);
  const app = Fastify({ logger: false });
  let validClient;
  let rawClient;
  try {
    const botService = createWorkspaceAgentBotService({ db });
    const gateway = createWorkspaceBotGatewayService({ db, botService });
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Synthetic WS fixture" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    await app.register(fastifyWebsocket);
    registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled: true, getSpaceId: () => SPACE_ID });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const port = new URL(address).port;

    rawClient = await RawWebSocketClient.connect(port, `dl_bot_${"x".repeat(32)}`);
    assert.deepEqual(await rawClient.readClose(), golden.node.rawAuthorizationClose);
    rawClient.close();

    validClient = await RawWebSocketClient.connect(port, `Bearer ${issued.token}`);
    validClient.sendRaw(Buffer.from('{"version":1e0,"type":"hello","lastSequence":" \\u00a0"}', "utf8"), true);
    assert.deepEqual(await validClient.readJSON(), golden.node.ready);
    validClient.sendRaw(Buffer.from(JSON.stringify({ version: 1, type: "heartbeat", id: { nested: [true, "x", null] } }), "utf8"), true);
    const heartbeat = await validClient.readJSON();
    assert.equal(heartbeat.version, 1);
    assert.equal(heartbeat.type, "heartbeat");
    assert.deepEqual(heartbeat.id, golden.node.heartbeatId);
    assert.equal(typeof heartbeat.timestamp, "string");
    validClient.sendJSON({ version: 1, type: "close" });
    assert.deepEqual(await validClient.readJSON(), golden.node.invalidCloseCommand);
    validClient.close();
    console.log(JSON.stringify({ status: "PASS", route: "/ws/bot-gateway", service: "synthetic-sqlite", golden: GOLDEN_PATH }, null, 2));
  } finally {
    validClient?.close();
    rawClient?.close();
    await app.close().catch(() => {});
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
