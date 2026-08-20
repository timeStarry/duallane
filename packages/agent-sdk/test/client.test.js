import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DualLaneAgentClient } from "../src/index.js";
import { createOpenClawDualLaneAdapter } from "../src/openclaw.js";

const TOKEN = `dl_bot_${"a".repeat(32)}`;

test("REST requests keep the Bot token in Authorization and never in URLs", async () => {
  const calls = [];
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ version: 1, bot: { id: "bot_1" } });
    }
  });
  await client.getMe();
  await client.getContext("conv_1", { limit: 12 });
  assert.equal(calls[0].url, "https://duallane.example.com/api/bot-gateway/v1/me");
  assert.equal(calls[1].url, "https://duallane.example.com/api/bot-gateway/v1/conversations/conv_1/context?limit=12");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls.some(({ url }) => url.includes(TOKEN)), false);
});

test("WebSocket hello, replay event handling, acknowledgement, and resume are ordered", async () => {
  const sockets = [];
  const events = [];
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    heartbeatMs: 120_000,
    webSocketFactory: async (url, options) => {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    fetch: async () => jsonResponse({})
  });
  await client.connect({ lastSequence: 7, onEvent: async (event) => events.push(event.eventId) });
  assert.equal(sockets[0].url, "wss://duallane.example.com/ws/bot-gateway");
  assert.equal(sockets[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(sockets[0].sent[0].type, "hello");
  assert.equal(sockets[0].sent[0].lastSequence, 7);

  sockets[0].emitFrame({ version: 1, type: "event", event: { eventId: "evt_8", sequence: 8, type: "message.created", conversationId: "conv_1", payload: {} } });
  await waitFor(() => client.lastSequence === 8);
  assert.deepEqual(events, ["evt_8"]);
  assert.deepEqual(sockets[0].sent.at(-1), { version: 1, type: "ack", eventId: "evt_8", sequence: 8 });
  client.stop();
});

test("Feishu card helpers use the explicit Gateway conversion input", async () => {
  const calls = [];
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), body: JSON.parse(init.body) });
      return jsonResponse({ card: { id: "card_1" } }, 201);
    }
  });
  await client.sendFeishuCard({
    conversationId: "conv_1",
    fallbackText: "确认卡片",
    card: { elements: [{ tag: "div", text: { tag: "plain_text", content: "请确认" } }] }
  });
  assert.equal(calls[0].url, "https://duallane.example.com/api/bot-gateway/v1/cards");
  assert.equal(calls[0].body.format, "feishu-card");
  assert.equal(calls[0].body.feishuCard.elements[0].tag, "div");
  assert.equal(Object.hasOwn(calls[0].body, "token"), false);
});

test("sync-required completes only after the runtime rebuild callback", async () => {
  let rebuilt = false;
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    heartbeatMs: 120_000,
    webSocketFactory: async (url, options) => {
      const socket = new FakeSocket(url, options);
      socket.helloResponse = { version: 1, type: "sync_required", currentSequence: 42, reason: "replay_window_exceeded" };
      return socket;
    },
    fetch: async () => jsonResponse({})
  });
  await client.connect({
    lastSequence: 1,
    async onSyncRequired(state) {
      assert.equal(state.currentSequence, 42);
      rebuilt = true;
    }
  });
  assert.equal(rebuilt, true);
  assert.equal(client.lastSequence, 42);
  client.stop();
});

test("reconnect resumes from the last acknowledged event sequence", async () => {
  const sockets = [];
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    heartbeatMs: 120_000,
    reconnect: { minDelayMs: 100, maxDelayMs: 500, factor: 1, jitter: 0 },
    webSocketFactory: async (url, options) => {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    fetch: async () => jsonResponse({})
  });
  await client.connect({ lastSequence: 3, onEvent: async () => {} });
  sockets[0].emitFrame({ version: 1, type: "event", event: { eventId: "evt_resume", sequence: 4, type: "message.created", conversationId: "conv_1", payload: {} } });
  await waitFor(() => client.lastSequence === 4);
  sockets[0].close();
  await waitFor(() => sockets.length === 2, 200);
  await waitFor(() => sockets[1].sent.some((frame) => frame.type === "hello"));
  expectFrame(sockets[1].sent.find((frame) => frame.type === "hello"), { type: "hello", lastSequence: 4 });
  client.stop();
});

test("OpenClaw bridge dispatches authorized context and one idempotent reply", async () => {
  const sent = [];
  const client = {
    async connect(options) {
      await options.onEvent({ eventId: "evt_openclaw", sequence: 2, type: "message.created", conversationId: "conv_openclaw" });
      return this;
    },
    stop() {},
    async getContext(conversationId) { return { conversation: { id: conversationId }, messages: [] }; },
    async sendMessage(input) { sent.push(input); return { message: { id: "msg_reply" } }; },
    async sendCard() {},
    async setTyping() {}
  };
  const adapter = createOpenClawDualLaneAdapter({
    client,
    dispatchInbound: async ({ channel, context }) => {
      assert.equal(channel, "duallane");
      assert.equal(context.conversation.id, "conv_openclaw");
      return "OpenClaw reply";
    }
  });
  await adapter.start();
  assert.deepEqual(sent, [{
    conversationId: "conv_openclaw",
    text: "OpenClaw reply",
    replyToMessageId: undefined,
    idempotencyKey: "evt_openclaw:text",
    clientMessageId: "evt_openclaw:reply"
  }]);
});

test("errors redact Bot tokens from server-provided messages", async () => {
  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: TOKEN,
    fetch: async () => jsonResponse({ error: { code: "bad", message: `do not expose ${TOKEN}` } }, 400)
  });
  await assert.rejects(client.getMe(), (error) => error.code === "bad" && !error.message.includes(TOKEN) && error.message.includes("[REDACTED]"));
});

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  helloResponse = { version: 1, type: "ready", currentSequence: 7, replayCount: 0, hasMore: false };

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.emitFrame(this.helloResponse));
    if (frame.type === "ack") queueMicrotask(() => this.emitFrame({ version: 1, type: "ack", acknowledged: true, eventId: frame.eventId, sequence: frame.sequence }));
  }

  emitFrame(frame) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}

function expectFrame(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual?.[key], value);
}
