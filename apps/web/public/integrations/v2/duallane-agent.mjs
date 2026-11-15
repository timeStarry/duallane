#!/usr/bin/env node
/**
 * DualLane Universal Agent Runtime (Standalone Single-File CLI + Stdio MCP + JS SDK)
 * Zero external npm dependencies · Requires Node.js >= 20
 *
 * Install anywhere directly from your DualLane host:
 *   mkdir -p ~/.duallane/bin
 *   curl -fsSL https://<duallane-host>/integrations/duallane-agent.mjs -o ~/.duallane/bin/duallane-agent.mjs
 *   chmod +x ~/.duallane/bin/duallane-agent.mjs
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- src/ws-lite.js ---
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/**
 * Zero-dependency RFC 6455 WebSocket client built on Node's native http/https modules.
 * Supports custom handshake headers (`Authorization: Bearer ...`) across Node 20/22+
 * without requiring any external npm package (`ws`).
 */
export class LiteWebSocket extends EventEmitter {
  readyState = CONNECTING;
  #req = null;
  #socket = null;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #closeEmitted = false;

  constructor(url, options = {}) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new TypeError(`Unsupported WebSocket protocol: ${parsed.protocol}`);
    }
    const isSecure = parsed.protocol === "wss:";
    const transport = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");

    const headers = {
      ...(options.headers || {}),
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    };

    const req = transport.request({
      protocol: isSecure ? "https:" : "http:",
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      method: "GET",
      headers,
      agent: options.agent ?? false,
    });
    this.#req = req;

    req.on("upgrade", (res, socket, head) => {
      const accept = String(res.headers["sec-websocket-accept"] || "").trim();
      if (accept !== expectedAccept) {
        socket.destroy();
        this.#fail(new Error("Invalid Sec-WebSocket-Accept header"));
        return;
      }
      this.#socket = socket;
      socket.setNoDelay?.(true);
      this.readyState = OPEN;

      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("error", (err) => this.#fail(err));
      socket.on("close", () => this.#finalizeClose(1006, ""));
      socket.on("end", () => this.#finalizeClose(1000, ""));

      this.emit("open");
      if (head && head.length > 0) {
        this.#onData(head);
      }
    });

    req.on("response", (res) => {
      res.resume();
      this.#fail(new Error(`Unexpected HTTP response status: ${res.statusCode}`));
    });

    req.on("error", (err) => {
      this.#fail(err);
    });

    req.end();
  }

  send(data) {
    if (this.readyState !== OPEN || !this.#socket) {
      throw new Error("WebSocket is not open");
    }
    const isString = typeof data === "string";
    const payload = isString ? Buffer.from(data, "utf8") : Buffer.from(data);
    const opcode = isString ? 0x01 : 0x02;
    this.#writeFrame(opcode, payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (this.readyState === CONNECTING) {
      this.readyState = CLOSED;
      try {
        this.#req?.destroy();
      } catch {
        /* ignore */
      }
      this.#finalizeClose(code, reason);
      return;
    }
    this.readyState = CLOSING;
    const reasonBuf = reason ? Buffer.from(String(reason).slice(0, 120), "utf8") : Buffer.alloc(0);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(Number.isInteger(code) ? code : 1000, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.#writeFrame(0x08, payload);
      this.#socket?.end();
    } catch {
      this.#socket?.destroy();
    }
    this.#finalizeClose(code, reason);
  }

  #writeFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let headerLen = 2;
    if (len >= 126 && len <= 65535) headerLen = 4;
    else if (len > 65535) headerLen = 10;

    const frame = Buffer.allocUnsafe(headerLen + 4 + len);
    frame[0] = 0x80 | (opcode & 0x0f);
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len <= 65535) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    mask.copy(frame, headerLen);
    for (let i = 0; i < len; i += 1) {
      frame[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
    }
    this.#socket?.write(frame);
  }

  #onData(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.#buffer.length < 4) return;
        payloadLen = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.#buffer.length < 10) return;
        const bigLen = this.#buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(16 * 1024 * 1024)) {
          this.#fail(new Error("WebSocket frame exceeds 16 MiB safety limit"));
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.#buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      this.#buffer = this.#buffer.subarray(offset + maskLen + payloadLen);
      this.#handleFrame(fin, opcode, payload);
    }
  }

  #handleFrame(fin, opcode, payload) {
    if (opcode === 0x08) {
      let code = 1005;
      let reason = "";
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString("utf8");
      }
      if (this.readyState === OPEN) {
        this.readyState = CLOSING;
        try {
          this.#writeFrame(0x08, payload.subarray(0, Math.min(payload.length, 125)));
        } catch {
          /* ignore */
        }
      }
      this.#socket?.destroy();
      this.#finalizeClose(code, reason);
      return;
    }

    if (opcode === 0x09) {
      if (this.readyState === OPEN) {
        try {
          this.#writeFrame(0x0a, payload.subarray(0, Math.min(payload.length, 125)));
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (opcode === 0x0a) {
      return;
    }

    if (opcode === 0x00) {
      this.#fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.#fragments);
        const messageOpcode = this.#fragmentOpcode;
        this.#fragments = [];
        this.#fragmentOpcode = 0;
        this.emit("message", messageOpcode === 0x01 ? full.toString("utf8") : full);
      }
      return;
    }

    if (opcode === 0x01 || opcode === 0x02) {
      if (fin) {
        this.emit("message", opcode === 0x01 ? payload.toString("utf8") : payload);
      } else {
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
      }
    }
  }

  #fail(error) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
    }
    try {
      this.#socket?.destroy();
    } catch {
      /* ignore */
    }
    this.#finalizeClose(1006, "");
  }

  #finalizeClose(code, reason) {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.readyState = CLOSED;
    this.#fragments = [];
    this.#buffer = Buffer.alloc(0);
    this.emit("close", code, reason);
  }
}

// --- src/index.js ---
export const DUALLANE_AGENT_SDK_VERSION = "1.0.6";
export const DUALLANE_GATEWAY_VERSION = 1;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class DualLaneAgentError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DualLaneAgentError";
    this.code = code;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable === true;
  }
}

export class DualLaneAgentSetupClient {
  #origin;
  #fetch;

  constructor(options = {}) {
    this.#origin = normalizeOrigin(options.url);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("DualLane Agent setup client requires fetch");
  }

  async request(setupSessionId, input = {}) {
    return this.#request("POST", "/api/bot-gateway/v1/setup/request", {
      setupSessionId: normalizeSetupSessionId(setupSessionId),
      requestedScopes: input.requestedScopes,
      conversationIds: input.conversationIds,
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      protocolVersion: input.protocolVersion,
      capabilities: input.capabilities
    });
  }

  async status(setupSessionId) {
    const id = encodeURIComponent(normalizeSetupSessionId(setupSessionId));
    return this.#request("GET", `/api/bot-gateway/v1/setup/status?setupSessionId=${id}`);
  }

  async exchange(setupSessionId, input = {}) {
    return this.#request("POST", "/api/bot-gateway/v1/setup/exchange", {
      setupSessionId: normalizeSetupSessionId(setupSessionId),
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      protocolVersion: input.protocolVersion
    });
  }

  async #request(method, path, body) {
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        method,
        headers: compact({ accept: "application/json", "content-type": body === undefined ? undefined : "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(compact(body))
      });
    } catch (cause) {
      throw new DualLaneAgentError("network.unavailable", "DualLane Agent setup endpoint is unavailable", { cause, retryable: true });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw new DualLaneAgentError(
        safeErrorCode(payload?.error?.code, "gateway.setup_failed"),
        safeErrorText(payload?.error?.message, "DualLane Agent setup request failed"),
        { statusCode: response.status, retryable: response.status === 429 || response.status >= 500 }
      );
    }
    return payload;
  }
}

export class DualLaneAgentClient {
  #origin;
  #token;
  #fetch;
  #webSocketFactory;
  #adapterVersion;
  #heartbeatMs;
  #ackTimeoutMs;
  #connectTimeoutMs;
  #reconnect;
  #socket = null;
  #stopped = true;
  #lastSequence = 0;
  #attempt = 0;
  #generation = 0;
  #heartbeatTimer = null;
  #reconnectTimer = null;
  #pendingAcks = new Map();
  #eventChain = Promise.resolve();
  #callbacks = {};

  constructor(options = {}) {
    this.#origin = normalizeOrigin(options.url);
    this.#token = normalizeToken(options.token);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("DualLane Agent SDK requires fetch");
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    if (typeof this.#webSocketFactory !== "function") throw new TypeError("webSocketFactory must be a function");
    this.#adapterVersion = normalizeAdapterVersion(options.adapterVersion ?? `duallane-js/${DUALLANE_AGENT_SDK_VERSION}`);
    this.#heartbeatMs = normalizeDuration(options.heartbeatMs, 20_000, 5_000, 120_000, "heartbeatMs");
    this.#ackTimeoutMs = normalizeDuration(options.ackTimeoutMs, 8_000, 1_000, 60_000, "ackTimeoutMs");
    this.#connectTimeoutMs = normalizeDuration(options.connectTimeoutMs, 10_000, 1_000, 60_000, "connectTimeoutMs");
    this.#reconnect = Object.freeze({
      minDelayMs: normalizeDuration(options.reconnect?.minDelayMs, 500, 100, 60_000, "reconnect.minDelayMs"),
      maxDelayMs: normalizeDuration(options.reconnect?.maxDelayMs, 30_000, 500, 120_000, "reconnect.maxDelayMs"),
      factor: normalizeFactor(options.reconnect?.factor ?? 2),
      jitter: normalizeJitter(options.reconnect?.jitter ?? 0.2)
    });
    if (this.#reconnect.minDelayMs > this.#reconnect.maxDelayMs) throw new TypeError("reconnect minDelayMs exceeds maxDelayMs");
  }

  get lastSequence() {
    return this.#lastSequence;
  }

  get connected() {
    return this.#socket?.readyState === OPEN;
  }

  async connect(options = {}) {
    if (!this.#stopped) throw new DualLaneAgentError("sdk.already_started", "DualLane Agent client is already started");
    this.#stopped = false;
    this.#lastSequence = normalizeSequence(options.lastSequence ?? 0, true);
    this.#callbacks = {
      onEvent: typeof options.onEvent === "function" ? options.onEvent : async () => {},
      onError: typeof options.onError === "function" ? options.onError : () => {},
      onStatus: typeof options.onStatus === "function" ? options.onStatus : () => {},
      onSyncRequired: typeof options.onSyncRequired === "function" ? options.onSyncRequired : async () => {}
    };
    if (options.signal) {
      if (options.signal.aborted) {
        this.stop();
        throw new DualLaneAgentError("sdk.aborted", "DualLane Agent connection was aborted");
      }
      options.signal.addEventListener("abort", () => this.stop(), { once: true });
    }
    await this.#open();
    return this;
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#heartbeatTimer);
    this.#reconnectTimer = null;
    this.#heartbeatTimer = null;
    this.#rejectPendingAcks(new DualLaneAgentError("gateway.disconnected", "DualLane Agent Gateway disconnected", { retryable: true }));
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState === OPEN) socket.close(1000, "client stopped");
    this.#callbacks.onStatus?.({ status: "stopped", lastSequence: this.#lastSequence });
  }

  async getMe() {
    return this.#request("GET", "/api/bot-gateway/v1/me");
  }

  async getContext(conversationId, options = {}) {
    const id = normalizeId(conversationId, "conversationId");
    const query = options.limit === undefined ? "" : `?limit=${normalizeLimit(options.limit)}`;
    return this.#request("GET", `/api/bot-gateway/v1/conversations/${encodeURIComponent(id)}/context${query}`);
  }

  async acknowledge(input) {
    const body = normalizeAck(input);
    return this.#request("POST", "/api/bot-gateway/v1/events/ack", body);
  }

  async sendMessage(input = {}) {
    const conversationId = normalizeId(input.conversationId, "conversationId");
    const clientMessageId = normalizeId(input.clientMessageId ?? createClientId("msg"), "clientMessageId");
    const idempotencyKey = normalizeId(input.idempotencyKey ?? clientMessageId, "idempotencyKey");
    if (input.text === undefined && input.content === undefined) throw new TypeError("text or content is required");
    return this.#request("POST", "/api/bot-gateway/v1/messages", compact({
      conversationId,
      clientMessageId,
      idempotencyKey,
      text: input.text,
      content: input.content,
      replyToMessageId: input.replyToMessageId
    }));
  }

  async sendCard(input = {}) {
    const conversationId = normalizeId(input.conversationId, "conversationId");
    const clientMessageId = normalizeId(input.clientMessageId ?? createClientId("cardmsg"), "clientMessageId");
    const idempotencyKey = normalizeId(input.idempotencyKey ?? clientMessageId, "idempotencyKey");
    return this.#request("POST", "/api/bot-gateway/v1/cards", compact({
      conversationId,
      clientMessageId,
      idempotencyKey,
      cardType: input.cardType,
      schemaVersion: input.schemaVersion,
      fallbackText: input.fallbackText,
      payload: input.payload,
      format: input.format,
      feishuCard: input.feishuCard
    }));
  }

  async sendFeishuCard(input = {}) {
    if (!input.card || typeof input.card !== "object" || Array.isArray(input.card)) throw new TypeError("card is required");
    return this.sendCard({ ...input, format: "feishu-card", feishuCard: input.card, card: undefined });
  }

  async updateCard(cardId, input = {}) {
    return this.#request("PATCH", `/api/bot-gateway/v1/cards/${encodeURIComponent(normalizeId(cardId, "cardId"))}`, compact(input));
  }

  async updateFeishuCard(cardId, input = {}) {
    if (!input.card || typeof input.card !== "object" || Array.isArray(input.card)) throw new TypeError("card is required");
    return this.updateCard(cardId, compact({
      expectedRevision: input.expectedRevision,
      fallbackText: input.fallbackText,
      format: "feishu-card",
      feishuCard: input.card
    }));
  }

  async setTyping(conversationId, options = {}) {
    const id = normalizeId(conversationId, "conversationId");
    const state = typeof options.state === "string" ? options.state.trim() : "";
    if (state === "typing" || state === "thinking") {
      return this.#request("POST", "/api/bot/v2/typing", { conversationId: id, state });
    }
    return this.#request("POST", "/api/bot-gateway/v1/typing", { conversationId: id });
  }

  async unbind() {
    return this.#request("POST", "/api/bot/v2/unbind", {});
  }

  async listConversations() {
    return this.#request("GET", "/api/bot/v2/conversations");
  }

  async editMessage(messageId, plainText) {
    const id = normalizeId(messageId, "messageId");
    const text = typeof plainText === "string" ? plainText.trim() : "";
    if (!text) throw new TypeError("plainText is required");
    return this.#request("PATCH", `/api/bot/v2/messages/${encodeURIComponent(id)}`, { plainText: text });
  }

  async getUpdates(options = {}) {
    const afterSequence = options.afterSequence === undefined ? 0 : normalizeSequence(options.afterSequence, true);
    const limit = options.limit === undefined ? 50 : normalizeLimit(options.limit);
    const timeoutRaw = options.timeout === undefined ? 0 : Number(options.timeout);
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(25, Math.floor(timeoutRaw)) : 0;
    const timeoutParam = timeout > 0 ? `&timeout=${timeout}` : "";
    return this.#request("GET", `/api/bot/v2/updates?afterSequence=${afterSequence}&limit=${limit}${timeoutParam}`);
  }

  async pollNextEvent(options = {}) {
    const deadlineMs = Date.now() + Math.max(1000, Number(options.timeoutMs || 60_000));
    const filterConv = typeof options.conversationId === "string" ? options.conversationId.trim() : "";
    let cursor = normalizeSequence(options.afterSequence ?? 0, true);
    const signal = options.signal;

    while (Date.now() < deadlineMs && !signal?.aborted) {
      const remainingSec = Math.max(1, Math.ceil((deadlineMs - Date.now()) / 1000));
      const longPollSec = Math.min(20, remainingSec);
      let res = await this.getUpdates({ afterSequence: cursor, limit: 50, timeout: longPollSec });
      if (res?.syncRequired && Number.isSafeInteger(res?.currentSequence)) {
        cursor = Math.max(0, Number(res.currentSequence));
        await options.onSyncRequired?.({ currentSequence: cursor, reason: "sync_required" });
        continue;
      }
      const events = Array.isArray(res?.events) ? res.events : [];
      for (const ev of events) {
        const seq = Number(ev?.sequence || 0);
        if (seq > cursor) {
          cursor = seq;
          this.#lastSequence = Math.max(this.#lastSequence, seq);
        }
        if (ev?.eventId && seq > 0) {
          await this.acknowledge({ eventId: ev.eventId, sequence: seq }).catch(() => {});
        }
        await options.onCursorAdvance?.(cursor);
        if (filterConv && ev?.conversationId !== filterConv) {
          continue;
        }
        return { timeout: false, event: ev, lastSequence: cursor, transport: "poll" };
      }
      if (events.length === 0 && Date.now() < deadlineMs && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return { timeout: true, lastSequence: cursor, transport: "poll" };
  }

  async #request(method, path, body) {
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        method,
        headers: compact({
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          "content-type": body === undefined ? undefined : "application/json",
          "x-duallane-adapter-version": this.#adapterVersion
        }),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (cause) {
      throw new DualLaneAgentError("network.unavailable", "DualLane Agent Gateway is unavailable", { cause, retryable: true });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const code = safeErrorCode(payload?.error?.code, "gateway.request_failed");
      const message = redactToken(safeErrorText(payload?.error?.message, "DualLane Agent Gateway request failed"), this.#token);
      throw new DualLaneAgentError(code, message, { statusCode: response.status, retryable: response.status === 429 || response.status >= 500 });
    }
    return payload;
  }

  async #open() {
    const generation = ++this.#generation;
    this.#callbacks.onStatus?.({ status: this.#attempt ? "reconnecting" : "connecting", attempt: this.#attempt, lastSequence: this.#lastSequence });
    const socketUrl = new URL("/ws/bot-gateway", this.#origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = await this.#webSocketFactory(socketUrl.toString(), {
        headers: {
          authorization: `Bearer ${this.#token}`,
          "x-duallane-adapter-version": this.#adapterVersion
        }
      });
    } catch {
      throw new DualLaneAgentError("gateway.connection_failed", "DualLane Agent Gateway connection failed", { retryable: true });
    }
    if (!socket || typeof socket.send !== "function") throw new TypeError("webSocketFactory returned an invalid socket");
    this.#socket = socket;

    return await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        if (generation !== this.#generation || ready) return;
        try { socket.close(1000, "connect timeout"); } catch { /* best effort */ }
        reject(new DualLaneAgentError("gateway.connect_timeout", "DualLane Agent Gateway connection timed out", { retryable: true }));
      }, this.#connectTimeoutMs);
      timeout.unref?.();

      bindSocket(socket, "open", () => {
        if (generation !== this.#generation || this.#stopped) return;
        socket.send(JSON.stringify({ version: DUALLANE_GATEWAY_VERSION, type: "hello", lastSequence: this.#lastSequence }));
      });
      bindSocket(socket, "message", (event) => {
        if (generation !== this.#generation || this.#stopped) return;
        let frame;
        try {
          frame = JSON.parse(messageData(event));
        } catch {
          this.#reportError(new DualLaneAgentError("gateway.invalid_frame", "DualLane Agent Gateway sent invalid JSON"));
          return;
        }
        if (frame?.version !== DUALLANE_GATEWAY_VERSION) {
          this.#reportError(new DualLaneAgentError("gateway.version_mismatch", "DualLane Agent Gateway version is unsupported"));
          return;
        }
        if (frame.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          this.#attempt = 0;
          this.#startHeartbeat(generation);
          this.#callbacks.onStatus?.({ status: "connected", currentSequence: frame.currentSequence, replayCount: frame.replayCount, lastSequence: this.#lastSequence });
          resolve(this);
          return;
        }
        if (frame.type === "ack") {
          this.#resolveAck(frame);
          return;
        }
        if (frame.type === "event") {
          this.#eventChain = this.#eventChain.then(() => this.#consumeEvent(frame.event)).catch((error) => this.#reportError(error));
          return;
        }
        if (frame.type === "sync_required") {
          const currentSequence = normalizeSequence(frame.currentSequence ?? 0, true);
          this.#eventChain = this.#eventChain.then(async () => {
            await this.#callbacks.onSyncRequired?.({
              currentSequence,
              reason: safeErrorText(frame.reason, "sync_required")
            });
            this.#lastSequence = currentSequence;
            if (!ready) {
              ready = true;
              clearTimeout(timeout);
              this.#attempt = 0;
              this.#startHeartbeat(generation);
              this.#callbacks.onStatus?.({ status: "connected", syncRequired: true, currentSequence, lastSequence: this.#lastSequence });
              resolve(this);
            }
          }).catch((error) => {
            const safe = this.#reportError(error);
            if (!ready) reject(safe);
          });
          return;
        }
        if (frame.type === "error") {
          this.#reportError(new DualLaneAgentError(safeErrorCode(frame.error?.code, "gateway.error"), redactToken(safeErrorText(frame.error?.message, "DualLane Agent Gateway error"), this.#token)));
        }
      });
      bindSocket(socket, "close", () => {
        clearTimeout(timeout);
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = null;
        if (generation !== this.#generation) return;
        this.#socket = null;
        this.#rejectPendingAcks(new DualLaneAgentError("gateway.disconnected", "DualLane Agent Gateway disconnected", { retryable: true }));
        if (!ready) reject(new DualLaneAgentError("gateway.connection_failed", "DualLane Agent Gateway connection failed", { retryable: true }));
        if (!this.#stopped) this.#scheduleReconnect();
      });
      bindSocket(socket, "error", () => {
        this.#reportError(new DualLaneAgentError("gateway.socket_error", "DualLane Agent Gateway socket error", { retryable: true }));
      });
    });
  }

  async #consumeEvent(event) {
    if (!event || typeof event !== "object") throw new DualLaneAgentError("gateway.invalid_event", "DualLane Agent Gateway event is invalid");
    const sequence = normalizeSequence(event.sequence);
    const eventId = normalizeId(event.eventId, "eventId");
    if (sequence > this.#lastSequence) await this.#callbacks.onEvent?.(Object.freeze({ ...event, sequence, eventId }));
    await this.#ackOverSocket({ sequence, eventId });
    this.#lastSequence = Math.max(this.#lastSequence, sequence);
  }

  async #ackOverSocket(input) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) throw new DualLaneAgentError("gateway.disconnected", "DualLane Agent Gateway disconnected", { retryable: true });
    if (this.#pendingAcks.has(input.sequence)) return this.#pendingAcks.get(input.sequence).promise;
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    const timer = setTimeout(() => {
      this.#pendingAcks.delete(input.sequence);
      reject(new DualLaneAgentError("gateway.ack_timeout", "DualLane Agent Gateway acknowledgement timed out", { retryable: true }));
    }, this.#ackTimeoutMs);
    timer.unref?.();
    this.#pendingAcks.set(input.sequence, { promise, resolve, reject, timer });
    socket.send(JSON.stringify({ version: DUALLANE_GATEWAY_VERSION, type: "ack", ...input }));
    return promise;
  }

  #resolveAck(frame) {
    const sequence = normalizeSequence(frame.sequence ?? 0, true);
    const pending = this.#pendingAcks.get(sequence);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingAcks.delete(sequence);
    pending.resolve({ acknowledged: frame.acknowledged === true, eventId: frame.eventId ?? null, sequence });
  }

  #startHeartbeat(generation) {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      if (generation !== this.#generation || this.#stopped || this.#socket?.readyState !== OPEN) return;
      this.#socket.send(JSON.stringify({ version: DUALLANE_GATEWAY_VERSION, type: "heartbeat", id: createClientId("hb") }));
    }, this.#heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#attempt += 1;
    const base = Math.min(this.#reconnect.maxDelayMs, this.#reconnect.minDelayMs * this.#reconnect.factor ** (this.#attempt - 1));
    const spread = base * this.#reconnect.jitter;
    const delay = Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
    this.#callbacks.onStatus?.({ status: "disconnected", retryInMs: delay, attempt: this.#attempt, lastSequence: this.#lastSequence });
    this.#reconnectTimer = setTimeout(() => {
      this.#open().catch((error) => {
        this.#reportError(error);
        if (!this.#stopped) this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #rejectPendingAcks(error) {
    for (const pending of this.#pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingAcks.clear();
  }

  #reportError(error) {
    const safe = error instanceof DualLaneAgentError
      ? new DualLaneAgentError(safeErrorCode(error.code, "gateway.error"), redactToken(error.message, this.#token), { statusCode: error.statusCode, retryable: error.retryable })
      : new DualLaneAgentError("sdk.callback_failed", "DualLane Agent callback failed");
    try { this.#callbacks.onError?.(safe); } catch { /* callbacks cannot break transport */ }
    return safe;
  }
}

function defaultWebSocketFactory(url, options) {
  return new LiteWebSocket(url, { headers: options?.headers });
}

function bindSocket(socket, event, listener) {
  if (typeof socket.on === "function") socket.on(event, listener);
  else if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
  else throw new TypeError("WebSocket implementation does not support events");
}

function messageData(event) {
  const value = event?.data ?? event;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  return String(value);
}

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("url must be an absolute HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("url must be an HTTP(S) origin without credentials, query, or fragment");
  }
  url.pathname = "/";
  return url;
}

function normalizeToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^dl_bot_[A-Za-z0-9_-]{32,}$/u.test(token)) throw new TypeError("token is not a DualLane Bot token");
  return token;
}

function normalizeAdapterVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+ -]{0,127}$/u.test(version)) throw new TypeError("adapterVersion is invalid");
  return version;
}

function normalizeId(value, label) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(id)) throw new TypeError(`${label} is invalid`);
  return id;
}

function normalizeSetupSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^setup_[A-Za-z0-9_-]{16,}$/u.test(id)) throw new TypeError("setupSessionId is invalid");
  return id;
}

function normalizeSequence(value, allowZero = false) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new TypeError("sequence is invalid");
  return number;
}

function normalizeAck(input = {}) {
  const sequence = input.sequence === undefined ? undefined : normalizeSequence(input.sequence, true);
  const eventId = input.eventId === undefined ? undefined : normalizeId(input.eventId, "eventId");
  if (eventId === undefined && (sequence === undefined || sequence === 0)) throw new TypeError("eventId or sequence is required");
  return compact({ sequence, eventId });
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("limit must be between 1 and 200");
  return limit;
}

function normalizeDuration(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid`);
  return number;
}

function normalizeFactor(value) {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor < 1 || factor > 10) throw new TypeError("reconnect.factor is invalid");
  return factor;
}

function normalizeJitter(value) {
  const jitter = Number(value);
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new TypeError("reconnect.jitter is invalid");
  return jitter;
}

function createClientId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function readJson(response) {
  const type = response.headers?.get?.("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) return {};
  try { return await response.json(); } catch { return {}; }
}

function safeErrorText(value, fallback) {
  return typeof value === "string" && value.length <= 512 ? value : fallback;
}

function safeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value) ? value : fallback;
}

function redactToken(value, token) {
  return String(value).split(token).join("[REDACTED]").replace(/dl_bot_[A-Za-z0-9_-]{16,}/gu, "[REDACTED]");
}

// --- src/v2.js ---
/**
 * Verify DualLane Outbound Webhook HMAC-SHA256 signature.
 * Header format: `X-DualLane-Signature: t=<timestamp>,v1=<hex>`
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(",")
      .map((p) => p.trim().split("="))
      .filter(([k, v]) => k && v)
  );
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) {
    return false;
  }
  const signedPayload = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fluent builder for DualLane Card Kit v1 documents.
 */
export function createCardKitBuilder(cardId, cardType = "custom") {
  const doc = {
    version: 1,
    cardId: cardId || `card_${crypto.randomUUID()}`,
    cardType,
    status: "active",
    revision: 1,
    fallbackText: "",
    blocks: [],
  };

  const api = {
    header(title, options = {}) {
      doc.blocks.push({ type: "header", title, ...options });
      if (!doc.fallbackText) doc.fallbackText = title;
      return api;
    },
    markdown(content) {
      doc.blocks.push({ type: "markdown", content });
      if (!doc.fallbackText) doc.fallbackText = content;
      return api;
    },
    fields(items) {
      doc.blocks.push({ type: "fields", items });
      return api;
    },
    poll(pollId, options, config = {}) {
      const totalVotes = options.reduce((sum, o) => sum + (o.votes || 0), 0);
      doc.blocks.push({ type: "poll", pollId, options, totalVotes, ...config });
      return api;
    },
    actions(elements) {
      doc.blocks.push({ type: "actions", elements });
      return api;
    },
    divider() {
      doc.blocks.push({ type: "divider" });
      return api;
    },
    fallback(text) {
      doc.fallbackText = text;
      return api;
    },
    build() {
      return structuredClone(doc);
    },
  };

  return api;
}

/**
 * DualLane Bot Gateway v2 client with HTTP long-polling, Card Kit v1, and AI streaming replies.
 */
export class DualLaneBotV2 {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #request(path, init = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = body?.error?.code;
      throw err;
    }
    return body;
  }

  getMe() {
    return this.#request("/api/bot-gateway/v1/me", { method: "GET" });
  }

  listConversations() {
    return this.#request("/api/bot/v2/conversations", { method: "GET" });
  }

  getContext(conversationId, limit = 50) {
    return this.#request(`/api/bot-gateway/v1/conversations/${encodeURIComponent(conversationId)}/context?limit=${limit}`, {
      method: "GET",
    });
  }

  getUpdates(afterSequence = 0, limit = 50) {
    return this.#request(`/api/bot/v2/updates?afterSequence=${afterSequence}&limit=${limit}`, {
      method: "GET",
    });
  }

  sendMessage(conversationId, text, options = {}) {
    return this.#request("/api/bot-gateway/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        text,
        replyToMessageId: options.replyToMessageId,
        clientMessageId: options.clientMessageId || `sdk_${crypto.randomUUID()}`,
        idempotencyKey: options.idempotencyKey || `idem_${crypto.randomUUID()}`,
      }),
    });
  }

  editMessage(messageId, plainText) {
    return this.#request(`/api/bot/v2/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ plainText }),
    });
  }

  sendCard(conversationId, cardDoc, options = {}) {
    return this.#request("/api/bot-gateway/v1/cards", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        card: cardDoc,
        replyToMessageId: options.replyToMessageId,
        clientMessageId: options.clientMessageId || `sdk_${crypto.randomUUID()}`,
        idempotencyKey: options.idempotencyKey || `idem_${crypto.randomUUID()}`,
      }),
    });
  }

  /**
   * Stream an AI async iterable of text chunks into a single DualLane message via batched PATCH edits.
   */
  async streamReply(conversationId, chunksAsyncIterable, options = {}) {
    const initial = await this.sendMessage(conversationId, options.placeholder || "正在思考…", options);
    const messageId = initial?.message?.id;
    if (!messageId) return initial;

    let buffer = "";
    let lastFlush = 0;
    const intervalMs = options.flushIntervalMs ?? 250;

    for await (const chunk of chunksAsyncIterable) {
      buffer += String(chunk);
      const now = Date.now();
      if (now - lastFlush >= intervalMs && buffer.trim()) {
        await this.editMessage(messageId, buffer);
        lastFlush = now;
      }
    }
    if (buffer.trim()) {
      await this.editMessage(messageId, buffer);
    }
    return { messageId, text: buffer };
  }
}

// --- src/profile-store.js ---
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SETUP_ID_RE = /^setup_[A-Za-z0-9_-]{16,}$/u;

export const DEFAULT_SETUP_SCOPES = Object.freeze([
  "messages:read_trigger",
  "messages:read_context",
  "messages:send",
  "cards:write",
  "cards:act",
  "commands:receive",
]);

export function normalizeProfileName(profile = "default") {
  const trimmed = String(profile || "default").trim() || "default";
  if (!SAFE_PROFILE.test(trimmed)) {
    throw new TypeError(`Invalid profile name: ${trimmed}`);
  }
  return trimmed;
}

export function sanitizeSetupClientName(raw, fallback = "duallane-agent/1.0.0") {
  const cleaned = String(raw || "")
    .replace(/[^A-Za-z0-9._/+ -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 120);
  return cleaned || fallback;
}

export function getAgentConfigDir(overrideDir) {
  if (overrideDir) return path.resolve(overrideDir);
  if (process.env.DUALLANE_AGENT_CONFIG_DIR) {
    return path.resolve(process.env.DUALLANE_AGENT_CONFIG_DIR);
  }
  return path.join(os.homedir(), ".config", "duallane", "agents");
}

export function resolveProfilePath(profile = "default", configDir) {
  return path.join(getAgentConfigDir(configDir), `${normalizeProfileName(profile)}.json`);
}

export function resolvePendingSetupPath(profile = "default", configDir) {
  return path.join(getAgentConfigDir(configDir), `${normalizeProfileName(profile)}.pending.json`);
}

export function parseSetupTarget(setupUrlOrId, explicitUrl) {
  const raw = String(setupUrlOrId || "").trim();
  if (!raw) {
    throw new TypeError("setupUrl or setupSessionId is required");
  }

  if (SETUP_ID_RE.test(raw)) {
    const base = String(explicitUrl || process.env.DUALLANE_URL || "").trim();
    if (!base) {
      throw new TypeError("Full setup URL or --url <origin> is required when passing a bare setupSessionId");
    }
    const parsedBase = new URL(base);
    const origin = parsedBase.origin;
    return {
      origin,
      setupSessionId: raw,
      approvalUrl: `${origin}/workspace?setup=${encodeURIComponent(raw)}`,
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("setupUrl must be a valid DualLane setup URL or setup_<id>");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("setupUrl must use http:// or https://");
  }
  const setupSessionId = (parsed.searchParams.get("setup") || parsed.searchParams.get("setupSessionId") || "").trim();
  if (!SETUP_ID_RE.test(setupSessionId)) {
    throw new TypeError("setupUrl does not contain a valid ?setup=setup_<id> parameter");
  }
  const origin = parsed.origin;
  return {
    origin,
    setupSessionId,
    approvalUrl: `${origin}/workspace?setup=${encodeURIComponent(setupSessionId)}`,
  };
}

export function loadAgentProfile(profile = "default", options = {}) {
  const normalized = normalizeProfileName(profile);
  const filePath = resolveProfilePath(normalized, options.configDir);
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.url && parsed?.token) {
      return {
        source: "profile",
        profile: normalized,
        filePath,
        url: parsed.url,
        token: parsed.token,
        botId: parsed.botId || null,
        botName: parsed.botName || null,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
        lastSequence: Number.isSafeInteger(parsed.lastSequence) && parsed.lastSequence >= 0 ? parsed.lastSequence : 0,
        updatedAt: parsed.updatedAt || null,
      };
    }
  }

  const envUrl = String(process.env.DUALLANE_URL || "").trim();
  const envToken = String(process.env.DUALLANE_BOT_TOKEN || "").trim();
  if (envUrl && envToken) {
    return {
      source: "env",
      profile: normalized,
      filePath: null,
      url: new URL(envUrl).origin,
      token: envToken,
      botId: null,
      botName: null,
      scopes: [],
      lastSequence: 0,
      updatedAt: null,
    };
  }

  return null;
}

export function saveAgentProfile(profile = "default", data = {}, options = {}) {
  const normalized = normalizeProfileName(profile);
  const dir = getAgentConfigDir(options.configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = resolveProfilePath(normalized, options.configDir);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    profile: normalized,
    url: new URL(data.url).origin,
    token: String(data.token || "").trim(),
    botId: data.botId || null,
    botUserId: data.botUserId || null,
    botName: data.botName || null,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    lastSequence: Number.isSafeInteger(data.lastSequence) && data.lastSequence >= 0 ? data.lastSequence : 0,
    clientName: data.clientName || null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return { profile: normalized, filePath };
}

export function updateProfileCursor(profile = "default", lastSequence, options = {}) {
  const existing = loadAgentProfile(profile, options);
  if (!existing || existing.source !== "profile" || !existing.filePath) return;
  if (!Number.isSafeInteger(lastSequence) || lastSequence <= existing.lastSequence) return;
  const raw = JSON.parse(fs.readFileSync(existing.filePath, "utf8"));
  raw.lastSequence = lastSequence;
  raw.updatedAt = new Date().toISOString();
  const tmpPath = `${existing.filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, existing.filePath);
}

export function savePendingSetup(profile = "default", pending = {}, options = {}) {
  const normalized = normalizeProfileName(profile);
  const dir = getAgentConfigDir(options.configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = resolvePendingSetupPath(normalized, options.configDir);
  const payload = {
    profile: normalized,
    origin: pending.origin,
    setupSessionId: pending.setupSessionId,
    approvalUrl: pending.approvalUrl,
    clientName: pending.clientName || "duallane-agent",
    clientVersion: pending.clientVersion || "1.0.0",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function loadPendingSetup(profile = "default", options = {}) {
  const filePath = resolvePendingSetupPath(profile, options.configDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function clearPendingSetup(profile = "default", options = {}) {
  const filePath = resolvePendingSetupPath(profile, options.configDir);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function deleteAgentProfile(profile = "default", options = {}) {
  const normalized = normalizeProfileName(profile);
  const filePath = resolveProfilePath(normalized, options.configDir);
  clearPendingSetup(normalized, options);
  let removed = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed = true;
    }
  } catch {
    /* ignore */
  }
  return { profile: normalized, filePath, removed };
}

// --- src/mcp.js ---
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";
const ALLOWED_CARD_ACTIONS = new Set(["confirm", "cancel", "submit", "refresh"]);

export const DUALLANE_MCP_TOOLS = [
  {
    name: "duallane_setup_start",
    description:
      "Start one-time interactive pairing between this AI Agent and a DualLane Bot using the user's setup URL (?setup=setup_...). Returns the approval URL for the user to click in their browser. Never requires manual token copy-paste.",
    inputSchema: {
      type: "object",
      properties: {
        setupUrl: {
          type: "string",
          description: "The DualLane setup URL (e.g. https://.../workspace?setup=setup_xxx) provided by the user.",
        },
        url: {
          type: "string",
          description: "Optional DualLane base URL if setupUrl is a bare setup_<id>.",
        },
        profile: {
          type: "string",
          description: "Local credential profile name (default: 'default').",
        },
        clientName: {
          type: "string",
          description: "Human-readable name of this Agent runtime shown on the user's approval screen (e.g. 'Claude Code', 'Codex', 'Cursor', 'Antigravity').",
        },
        requestedScopes: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of Bot Gateway scopes to request.",
        },
      },
      required: ["setupUrl"],
    },
  },
  {
    name: "duallane_setup_finish",
    description:
      "Poll an initiated DualLane setup session until the user approves it in their browser, exchange the session once for a Bot token, and store it securely in ~/.config/duallane/agents/<profile>.json (0600).",
    inputSchema: {
      type: "object",
      properties: {
        setupUrl: {
          type: "string",
          description: "Optional DualLane setup URL or setup_<id> (defaults to the most recent pending session for this profile).",
        },
        url: {
          type: "string",
          description: "Optional DualLane base URL when setupUrl is a bare setup_<id>.",
        },
        profile: {
          type: "string",
          description: "Local credential profile name (default: 'default').",
        },
        waitSeconds: {
          type: "integer",
          minimum: 0,
          maximum: 180,
          description: "How many seconds to wait/poll for user browser approval before returning (default: 45).",
        },
      },
    },
  },
  {
    name: "duallane_status",
    description:
      "Check DualLane Bot connection status, identity, granted scopes, and authorized conversations for the active profile.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_list_conversations",
    description:
      "List all DualLane direct and group conversations this Bot belongs to, including whether sending, trigger delivery, and context reading are enabled.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_get_context",
    description:
      "Read recent authorized messages from a DualLane conversation (requires messages:read_context scope and an active context grant from the conversation owner).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max messages to fetch (default: 30)." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_send_message",
    description: "Send a text / Markdown message to an authorized DualLane conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        text: { type: "string", description: "Message text (supports Markdown)." },
        replyToMessageId: { type: "string", description: "Optional message ID (msg_...) to reply to." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId", "text"],
    },
  },
  {
    name: "duallane_edit_message",
    description:
      "Edit a message previously sent by this Bot in DualLane (useful for live progress updates and streaming final answers).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID (msg_...) previously returned by duallane_send_message." },
        plainText: { type: "string", description: "Updated message text." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["messageId", "plainText"],
    },
  },
  {
    name: "duallane_send_card",
    description:
      "Send an interactive approval/notification card to a DualLane conversation with optional action buttons (confirm, cancel, submit, refresh).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        title: { type: "string", description: "Card header title." },
        markdown: { type: "string", description: "Main Markdown body of the card." },
        tone: {
          type: "string",
          enum: ["blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "grey"],
          description: "Optional header color template (default: 'blue').",
        },
        fallbackText: { type: "string", description: "Plain-text summary shown in conversation list previews." },
        buttons: {
          type: "array",
          description:
            "Optional interactive buttons (up to 4). Each actionId must be one of: confirm, cancel, submit, refresh (each used at most once per card).",
          items: {
            type: "object",
            properties: {
              actionId: { type: "string", enum: ["confirm", "cancel", "submit", "refresh"] },
              label: { type: "string" },
              style: { type: "string", enum: ["default", "primary", "danger"] },
              value: { type: "object", description: "Optional metadata object returned when the user clicks this button." },
            },
            required: ["actionId", "label"],
          },
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId", "title", "markdown"],
    },
  },
  {
    name: "duallane_wait_for_event",
    description:
      "Wait in real time (via outbound WebSocket with replay cursor) for the next incoming DualLane message, @mention, /command, or interactive card button click.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          description: "Maximum seconds to wait before returning { timeout: true } (default: 60).",
        },
        conversationId: {
          type: "string",
          description: "Optional conversationId filter — only return events from this conversation.",
        },
        afterSequence: {
          type: "integer",
          minimum: 0,
          description: "Optional sequence cursor override (defaults to profile's saved lastSequence).",
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_set_typing",
    description:
      "Emit a real-time 'thinking' or 'typing' indicator in a DualLane conversation (and advance read confirmation) while processing a complex task.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        state: {
          type: "string",
          enum: ["thinking", "typing"],
          description: "Processing state shown to users (default: 'thinking').",
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_unbind",
    description:
      "Revoke this Agent's bound DualLane Bot token on the server and remove the local ~/.config/duallane/agents/<profile>.json credential file.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
];

export function createDualLaneMcpServer(options = {}) {
  const defaultProfile = normalizeProfileName(options.defaultProfile || "default");
  const configDir = options.configDir;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  function makeClient(profileName) {
    const profile = loadAgentProfile(profileName || defaultProfile, { configDir });
    if (!profile) {
      throw new DualLaneAgentError(
        "profile.not_configured",
        `No DualLane Bot credentials found for profile "${profileName || defaultProfile}". Run duallane_setup_start with a setup URL from DualLane Settings -> Bots first.`
      );
    }
    const client = new DualLaneAgentClient({
      url: profile.url,
      token: profile.token,
      fetch: fetchImpl,
      webSocketFactory,
      adapterVersion: `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`,
    });
    return { client, profile };
  }

  async function callTool(name, args = {}) {
    const profileName = normalizeProfileName(args.profile || defaultProfile);

    switch (name) {
      case "duallane_setup_start": {
        const target = parseSetupTarget(args.setupUrl, args.url);
        const clientName = sanitizeSetupClientName(args.clientName, `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`);
        const requestedScopes =
          Array.isArray(args.requestedScopes) && args.requestedScopes.length > 0
            ? args.requestedScopes
            : [...DEFAULT_SETUP_SCOPES];

        const setupClient = new DualLaneAgentSetupClient({ url: target.origin, fetch: fetchImpl });
        const initialCheck = await setupClient.status(target.setupSessionId).catch(() => null);
        const initialSession = initialCheck?.setup || initialCheck?.session || null;
        const initialStatus = initialSession ? String(initialSession.status || "") : "";

        let response = initialCheck;
        if (initialStatus !== "approved") {
          response = await setupClient.request(target.setupSessionId, {
            requestedScopes,
            clientName,
            clientVersion: DUALLANE_AGENT_SDK_VERSION,
            protocolVersion: "v1",
            capabilities: ["mcp", "websocket", "cards", "stream_edit"],
          });
        }

        savePendingSetup(
          profileName,
          {
            origin: target.origin,
            setupSessionId: target.setupSessionId,
            approvalUrl: target.approvalUrl,
            clientName,
            clientVersion: DUALLANE_AGENT_SDK_VERSION,
          },
          { configDir }
        );

        const resolvedStatus = response?.session?.status || response?.setup?.status || "pending_approval";
        return {
          status: resolvedStatus,
          profile: profileName,
          origin: target.origin,
          setupSessionId: target.setupSessionId,
          approvalUrl: target.approvalUrl,
          requestedScopes,
          nextStep:
            resolvedStatus === "approved"
              ? "Session is already approved! Call duallane_setup_finish immediately to complete credential exchange."
              : `Ask the user to open ${target.approvalUrl} (or approve directly in DualLane Settings -> Bots), then call duallane_setup_finish.`,
        };
      }

      case "duallane_setup_finish": {
        const pending = loadPendingSetup(profileName, { configDir });
        let target;
        if (args.setupUrl) {
          target = parseSetupTarget(args.setupUrl, args.url || pending?.origin);
        } else if (pending?.setupSessionId && pending?.origin) {
          target = {
            origin: pending.origin,
            setupSessionId: pending.setupSessionId,
            approvalUrl: pending.approvalUrl || `${pending.origin}/workspace?setup=${encodeURIComponent(pending.setupSessionId)}`,
          };
        } else {
          throw new DualLaneAgentError(
            "setup.no_pending_session",
            "No pending setup session found. Call duallane_setup_start with the user's setup URL first."
          );
        }

        const waitSeconds = Math.min(180, Math.max(0, Number.isFinite(Number(args.waitSeconds)) ? Number(args.waitSeconds) : 45));
        const deadline = Date.now() + waitSeconds * 1000;
        const setupClient = new DualLaneAgentSetupClient({ url: target.origin, fetch: fetchImpl });
        const clientName = sanitizeSetupClientName(pending?.clientName, `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`);

        let latestStatus = "pending";
        while (true) {
          const check = await setupClient.status(target.setupSessionId);
          const session = check?.setup || check?.session || {};
          latestStatus = String(session.status || "pending");
          if (latestStatus === "approved") {
            break;
          }
          if (latestStatus === "denied" || latestStatus === "expired" || latestStatus === "exchanged") {
            clearPendingSetup(profileName, { configDir });
            throw new DualLaneAgentError(
              `setup.${latestStatus}`,
              `Setup session is ${latestStatus}. Please generate a fresh pairing link in DualLane Settings -> Bots.`
            );
          }
          if (Date.now() >= deadline) {
            return {
              status: latestStatus,
              profile: profileName,
              setupSessionId: target.setupSessionId,
              approvalUrl: target.approvalUrl,
              message: "Waiting for user approval in DualLane. Once the user clicks Approve, call duallane_setup_finish again.",
            };
          }
          await sleep(1500);
        }

        const exchanged = await setupClient.exchange(target.setupSessionId, {
          clientName,
          clientVersion: DUALLANE_AGENT_SDK_VERSION,
          protocolVersion: "v1",
        });

        const rawToken = String(exchanged?.token || "").trim();
        if (!rawToken) {
          throw new DualLaneAgentError("setup.exchange_empty", "Setup exchange succeeded without returning a token");
        }

        const verifyClient = new DualLaneAgentClient({
          url: target.origin,
          token: rawToken,
          fetch: fetchImpl,
          webSocketFactory,
          adapterVersion: `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`,
        });
        let me = null;
        let conversations = [];
        try {
          me = await verifyClient.getMe();
          const convRes = await verifyClient.listConversations();
          conversations = convRes?.conversations || [];
        } catch {
          /* non-fatal verification enrichment */
        }

        const saved = saveAgentProfile(
          profileName,
          {
            url: target.origin,
            token: rawToken,
            botId: me?.bot?.id || exchanged?.session?.botId || null,
            botUserId: me?.bot?.botUserId || null,
            botName: me?.bot?.name || null,
            scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
            clientName,
          },
          { configDir }
        );
        clearPendingSetup(profileName, { configDir });

        return {
          status: "connected",
          profile: saved.profile,
          credentialsStoredAt: saved.filePath,
          origin: target.origin,
          bot: me?.bot || { id: exchanged?.session?.botId },
          scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
          conversations,
        };
      }

      case "duallane_status": {
        const { client, profile } = makeClient(profileName);
        const [me, convRes] = await Promise.all([
          client.getMe(),
          client.listConversations().catch(() => ({ conversations: [] })),
        ]);
        return {
          connected: true,
          profile: profile.profile,
          source: profile.source,
          origin: profile.url,
          lastSequence: profile.lastSequence,
          bot: me?.bot,
          scopes: me?.scopes || [],
          settings: me?.settings,
          gatewayConnection: me?.connection || null,
          conversations: convRes?.conversations || [],
        };
      }

      case "duallane_list_conversations": {
        const { client } = makeClient(profileName);
        return await client.listConversations();
      }

      case "duallane_get_context": {
        const { client } = makeClient(profileName);
        const limit = args.limit === undefined ? 30 : Number(args.limit);
        return await client.getContext(args.conversationId, { limit });
      }

      case "duallane_send_message": {
        const { client } = makeClient(profileName);
        return await client.sendMessage({
          conversationId: args.conversationId,
          text: args.text,
          replyToMessageId: args.replyToMessageId,
        });
      }

      case "duallane_edit_message": {
        const { client } = makeClient(profileName);
        return await client.editMessage(args.messageId, args.plainText);
      }

      case "duallane_send_card": {
        const { client } = makeClient(profileName);
        const elements = [
          {
            tag: "markdown",
            content: String(args.markdown || ""),
          },
        ];
        if (Array.isArray(args.buttons) && args.buttons.length > 0) {
          const seen = new Set();
          const actions = [];
          for (const btn of args.buttons.slice(0, 4)) {
            const actionId = String(btn?.actionId || "").trim();
            if (!ALLOWED_CARD_ACTIONS.has(actionId) || seen.has(actionId)) {
              throw new TypeError(`Card button actionId must be unique and one of: confirm, cancel, submit, refresh (got "${actionId}")`);
            }
            seen.add(actionId);
            actions.push({
              tag: "button",
              text: { tag: "plain_text", content: String(btn.label || actionId) },
              type: btn.style === "primary" || btn.style === "danger" ? btn.style : "default",
              value: {
                action: actionId,
                ...(btn.value && typeof btn.value === "object" && !Array.isArray(btn.value) ? btn.value : {}),
              },
            });
          }
          if (actions.length > 0) {
            elements.push({ tag: "hr" });
            elements.push({ tag: "action", actions });
          }
        }
        const card = {
          header: {
            title: { tag: "plain_text", content: String(args.title || "通知卡片") },
            template: args.tone || "blue",
          },
          elements,
        };
        return await client.sendFeishuCard({
          conversationId: args.conversationId,
          fallbackText: String(args.fallbackText || args.title || "交互卡片"),
          card,
        });
      }

      case "duallane_wait_for_event": {
        const { client, profile } = makeClient(profileName);
        const timeoutSeconds = Math.min(300, Math.max(1, Number(args.timeoutSeconds || 60)));
        const startSeq =
          args.afterSequence !== undefined && Number.isSafeInteger(Number(args.afterSequence))
            ? Number(args.afterSequence)
            : profile.lastSequence || 0;
        const filterConv = args.conversationId ? String(args.conversationId).trim() : "";
        const startedAtMs = Date.now();

        const fallbackToPoll = async (cursor) => {
          const remainingMs = Math.max(1000, timeoutSeconds * 1000 - (Date.now() - startedAtMs));
          const polled = await client.pollNextEvent({
            afterSequence: cursor,
            timeoutMs: remainingMs,
            conversationId: filterConv,
            onCursorAdvance: (seq) => updateProfileCursor(profileName, seq, { configDir }),
            onSyncRequired: ({ currentSequence }) => updateProfileCursor(profileName, currentSequence, { configDir }),
          });
          if (polled.timeout) {
            return {
              timeout: true,
              waitedSeconds: timeoutSeconds,
              lastSequence: polled.lastSequence,
            };
          }
          return {
            timeout: false,
            event: polled.event,
            lastSequence: polled.lastSequence,
          };
        };

        return await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            client.stop();
            resolve({
              timeout: true,
              waitedSeconds: timeoutSeconds,
              lastSequence: client.lastSequence || startSeq,
            });
          }, timeoutSeconds * 1000);
          timer.unref?.();

          client
            .connect({
              lastSequence: startSeq,
              async onEvent(event) {
                updateProfileCursor(profileName, event.sequence, { configDir });
                if (filterConv && event.conversationId !== filterConv) {
                  return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                setImmediate(() => client.stop());
                resolve({
                  timeout: false,
                  event,
                  lastSequence: event.sequence,
                });
              },
              async onSyncRequired({ currentSequence }) {
                updateProfileCursor(profileName, currentSequence, { configDir });
              },
              onError(err) {
                if (!settled && !err?.retryable) {
                  settled = true;
                  clearTimeout(timer);
                  client.stop();
                  reject(err);
                }
              },
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              client.stop();
              if (err?.retryable) {
                fallbackToPoll(client.lastSequence || startSeq).then(resolve, reject);
                return;
              }
              reject(err);
            });
        });
      }

      case "duallane_set_typing": {
        const { client } = makeClient(args.profile);
        return await client.setTyping(args.conversationId, { state: args.state || "thinking" });
      }

      case "duallane_unbind": {
        const profileName = normalizeProfileName(args.profile || defaultProfile);
        const existing = loadAgentProfile(profileName, { configDir });
        let serverRevoked = false;
        if (existing) {
          const client = new DualLaneAgentClient({
            url: existing.url,
            token: existing.token,
            fetch: fetchImpl,
            webSocketFactory,
          });
          await client.unbind().then(() => {
            serverRevoked = true;
          }).catch(() => {});
        }
        const cleaned = deleteAgentProfile(profileName, { configDir });
        return {
          status: "unbound",
          profile: cleaned.profile,
          serverRevoked,
          removedLocalFile: cleaned.removed,
        };
      }

      default:
        throw new DualLaneAgentError("mcp.unknown_tool", `Unknown tool: ${name}`);
    }
  }

  async function handleJsonRpc(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          const requestedVersion = String(params?.protocolVersion || "");
          const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
            ? requestedVersion
            : DEFAULT_MCP_PROTOCOL_VERSION;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: negotiated,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: "duallane-agent-mcp",
                version: DUALLANE_AGENT_SDK_VERSION,
              },
            },
          };
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: DUALLANE_MCP_TOOLS },
          };

        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };

        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };

        case "tools/call": {
          const toolName = String(params?.name || "");
          const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
          try {
            const output = await callTool(toolName, toolArgs);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
                structuredContent: output,
                isError: false,
              },
            };
          } catch (toolErr) {
            const safeError = {
              code: toolErr?.code || "tool.execution_failed",
              message: redactSecrets(toolErr?.message || String(toolErr)),
              statusCode: toolErr?.statusCode || null,
            };
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ error: safeError }, null, 2) }],
                isError: true,
              },
            };
          }
        }

        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: redactSecrets(err?.message || "Internal MCP server error"),
        },
      };
    }
  }

  return {
    callTool,
    handleJsonRpc,
  };
}

export function startDualLaneMcpStdioServer(options = {}) {
  const server = createDualLaneMcpServer(options);
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;

  let buffer = Buffer.alloc(0);
  let framingMode = null; // "newline" | "content-length"

  function sendResponse(payload) {
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (framingMode === "content-length") {
      const byteLength = Buffer.byteLength(json, "utf8");
      output.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  }

  function dispatchRawMessage(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    Promise.all(items.map((item) => server.handleJsonRpc(item))).then((responses) => {
      const valid = responses.filter(Boolean);
      if (valid.length === 0) return;
      if (Array.isArray(parsed)) sendResponse(valid);
      else sendResponse(valid[0]);
    });
  }

  input.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);

    while (buffer.length > 0) {
      if (!framingMode) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8").trimStart();
        if (!preview) return;
        framingMode = /^content-length:/iu.test(preview) ? "content-length" : "newline";
      }

      if (framingMode === "content-length") {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const match = /content-length:\s*(\d+)/iu.exec(headerText);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return;
        const bodyText = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
        buffer = buffer.subarray(bodyStart + length);
        dispatchRawMessage(bodyText);
      } else {
        const newlineIdx = buffer.indexOf(0x0a);
        if (newlineIdx === -1) return;
        const line = buffer.subarray(0, newlineIdx).toString("utf8");
        buffer = buffer.subarray(newlineIdx + 1);
        dispatchRawMessage(line);
      }
    }
  });

  return server;
}

function redactSecrets(text) {
  return String(text || "").replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
}

// --- bin/duallane-agent.mjs ---
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function printHelp() {
  process.stdout.write(`DualLane Universal Agent CLI & MCP Server v${DUALLANE_AGENT_SDK_VERSION}

Usage:
  duallane-agent setup <setup-url-or-id> [--url <origin>] [--profile default] [--name <agent-name>]
  duallane-agent mcp [--profile default]
  duallane-agent status [--profile default]
  duallane-agent conversations [--profile default]
  duallane-agent updates [--ack] [--timeout 20] [--profile default]
  duallane-agent wait [--timeout 3600] [--transport auto|ws|poll] [--profile default]
  duallane-agent send <conversationId> <text> [--reply-to <messageId>] [--profile default]
  duallane-agent edit <messageId> <text> [--profile default]
  duallane-agent typing <conversationId> [--state thinking|typing] [--profile default]
  duallane-agent unbind [--profile default]
  duallane-agent listen --cmd "<shell-command>" [--transport auto|ws|poll] [--profile default]

Works with Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, and OpenClaw.
`);
}

async function runSetup(positionals, flags) {
  const setupInput = positionals[0];
  if (!setupInput) {
    throw new Error("Missing setup URL. Usage: duallane-agent setup \"https://<host>/workspace?setup=setup_...\"");
  }
  const profile = normalizeProfileName(flags.profile || "default");
  const clientName = sanitizeSetupClientName(flags.name, `duallane-cli/${DUALLANE_AGENT_SDK_VERSION} ${os.hostname()}`);
  const target = parseSetupTarget(setupInput, flags.url);
  const scopes = flags.scopes
    ? String(flags.scopes)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_SETUP_SCOPES];

  const setupClient = new DualLaneAgentSetupClient({ url: target.origin });
  const initialCheck = await setupClient.status(target.setupSessionId).catch(() => null);
  const initialSession = initialCheck?.setup || initialCheck?.session || null;
  const initialStatus = initialSession ? String(initialSession.status || "") : "";

  if (initialStatus !== "approved") {
    await setupClient.request(target.setupSessionId, {
      requestedScopes: scopes,
      clientName,
      clientVersion: DUALLANE_AGENT_SDK_VERSION,
      protocolVersion: "v1",
      capabilities: ["cli", "mcp", "websocket", "cards", "stream_edit"],
    });

    process.stderr.write(`\n[DualLane] Pairing request submitted as "${clientName}".\n`);
    process.stderr.write(`[DualLane] Approve in DualLane Settings -> Bots or open:\n  ${target.approvalUrl}\n\n`);

    if (flags["no-wait"]) {
      process.stdout.write(JSON.stringify({ status: "pending_approval", profile, approvalUrl: target.approvalUrl }, null, 2) + "\n");
      return;
    }
  } else {
    process.stderr.write(`\n[DualLane] Setup session is already pre-approved — exchanging credentials now...\n`);
  }

  const waitSeconds = Math.min(300, Math.max(5, Number(flags.wait || 180)));
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const check = await setupClient.status(target.setupSessionId);
    const session = check?.setup || check?.session || {};
    const status = String(session.status || "pending");
    if (status === "approved") {
      const exchanged = await setupClient.exchange(target.setupSessionId, {
        clientName,
        clientVersion: DUALLANE_AGENT_SDK_VERSION,
        protocolVersion: "v1",
      });
      const rawToken = String(exchanged?.token || "").trim();
      const client = new DualLaneAgentClient({ url: target.origin, token: rawToken });
      const me = await client.getMe().catch(() => null);
      const convs = await client.listConversations().catch(() => ({ conversations: [] }));

      const saved = saveAgentProfile(profile, {
        url: target.origin,
        token: rawToken,
        botId: me?.bot?.id || exchanged?.session?.botId || null,
        botUserId: me?.bot?.botUserId || null,
        botName: me?.bot?.name || null,
        scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
        lastSequence: Number(me?.connection?.currentSequence || 0),
        clientName,
      });

      process.stderr.write(`[DualLane] Connected! Token saved securely (0600) to ${saved.filePath}\n`);
      process.stdout.write(
        JSON.stringify(
          {
            status: "connected",
            profile: saved.profile,
            credentialsFile: saved.filePath,
            origin: target.origin,
            bot: me?.bot || null,
            scopes: me?.scopes || [],
            conversations: convs?.conversations || [],
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    if (status === "denied" || status === "expired" || status === "exchanged") {
      throw new Error(`Setup session ${status}. Generate a new pairing link in DualLane Settings -> Bots.`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(`Timed out after ${waitSeconds}s waiting for approval at ${target.approvalUrl}`);
}

function requireClient(profileFlag) {
  const profileName = normalizeProfileName(profileFlag || "default");
  const profile = loadAgentProfile(profileName);
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" is not configured. Run: duallane-agent setup "<setupUrl>" --profile ${profileName}`
    );
  }
  const client = new DualLaneAgentClient({
    url: profile.url,
    token: profile.token,
    adapterVersion: `duallane-cli/${DUALLANE_AGENT_SDK_VERSION}`,
  });
  return { client, profile, profileName };
}

async function runBridgeCommand(shellCmd, payload) {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DUALLANE_BOT_TOKEN;
    env.DUALLANE_CONVERSATION_ID = String(payload.event?.conversationId || "");
    env.DUALLANE_EVENT_TYPE = String(payload.event?.type || "");
    env.DUALLANE_MESSAGE_TEXT = String(
      payload.event?.payload?.message?.plainText || payload.event?.payload?.plainText || ""
    );

    const child = spawn(shellCmd, {
      shell: true,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Bridge command exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runListen(flags) {
  const cmd = typeof flags.cmd === "string" ? flags.cmd.trim() : "";
  if (!cmd) {
    throw new Error("Missing --cmd \"<shell-command>\" for incoming event bridge.");
  }
  const transportMode = String(flags.transport || "auto").trim().toLowerCase();
  const { client, profile, profileName } = requireClient(flags.profile);
  const me = await client.getMe();
  process.stderr.write(
    `[DualLane] Listening as "${me?.bot?.name || profile.botName || "Bot"}" (${profile.url}) -> forwarding events to: ${cmd}\n`
  );

  let stopped = false;
  const handleIncomingEvent = async (event) => {
    updateProfileCursor(profileName, event.sequence);
    if (!event.conversationId) return;

    await client.setTyping(event.conversationId).catch(() => {});
    let context = null;
    if (profile.scopes.includes("messages:read_context")) {
      context = await client.getContext(event.conversationId, { limit: 20 }).catch(() => null);
    }

    const replyText = await runBridgeCommand(cmd, { event, context });
    if (replyText) {
      await client.sendMessage({
        conversationId: event.conversationId,
        text: replyText,
        replyToMessageId: event.payload?.message?.id || event.payload?.messageId,
        clientMessageId: `${event.eventId}:reply`,
        idempotencyKey: `${event.eventId}:reply`,
      });
    }
  };

  const runPollLoop = async (initialSeq) => {
    let cursor = initialSeq;
    process.stderr.write(`[DualLane] HTTP long-polling active (seq=${cursor})\n`);
    while (!stopped) {
      try {
        const polled = await client.pollNextEvent({
          afterSequence: cursor,
          timeoutMs: 25_000,
          onCursorAdvance: (seq) => {
            cursor = seq;
            updateProfileCursor(profileName, seq);
          },
          onSyncRequired: ({ currentSequence }) => {
            cursor = currentSequence;
            updateProfileCursor(profileName, currentSequence);
          },
        });
        cursor = polled.lastSequence;
        if (!polled.timeout && polled.event) {
          await handleIncomingEvent(polled.event);
        }
      } catch (err) {
        if (stopped) break;
        process.stderr.write(`[DualLane] Poll error (${err?.code || "poll_failed"}): ${err?.message || err}\n`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const shutdown = () => {
    stopped = true;
    process.stderr.write("\n[DualLane] Stopping listener...\n");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (transportMode === "poll") {
    await runPollLoop(profile.lastSequence || 0);
    return;
  }

  try {
    await client.connect({
      lastSequence: profile.lastSequence || 0,
      onStatus(state) {
        if (state.status === "connected") {
          process.stderr.write(`[DualLane] WebSocket connected (seq=${state.currentSequence ?? state.lastSequence})\n`);
        } else if (state.status === "disconnected") {
          process.stderr.write(`[DualLane] Disconnected, retrying in ${state.retryInMs}ms...\n`);
        }
      },
      onEvent: handleIncomingEvent,
      async onSyncRequired({ currentSequence }) {
        updateProfileCursor(profileName, currentSequence);
      },
      onError(err) {
        process.stderr.write(`[DualLane] Gateway error (${err.code}): ${err.message}\n`);
      },
    });
  } catch (err) {
    if (transportMode === "auto" && err?.retryable) {
      client.stop();
      process.stderr.write(`[DualLane] WebSocket unavailable (${err.code}), falling back to HTTP long-polling...\n`);
      await runPollLoop(client.lastSequence || profile.lastSequence || 0);
      return;
    }
    throw err;
  }
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const subcommand = positionals[0];

  if (!subcommand || flags.help || flags.h || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "mcp") {
    startDualLaneMcpStdioServer({ defaultProfile: flags.profile || "default" });
    return;
  }

  if (subcommand === "setup") {
    await runSetup(positionals.slice(1), flags);
    return;
  }

  if (subcommand === "status") {
    const { client, profile } = requireClient(flags.profile);
    const [me, convs] = await Promise.all([
      client.getMe(),
      client.listConversations().catch(() => ({ conversations: [] })),
    ]);
    process.stdout.write(
      JSON.stringify(
        {
          profile: profile.profile,
          origin: profile.url,
          bot: me?.bot,
          scopes: me?.scopes,
          connection: me?.connection,
          conversations: convs?.conversations || [],
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "conversations") {
    const { client } = requireClient(flags.profile);
    const res = await client.listConversations();
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "updates") {
    const { client, profile, profileName } = requireClient(flags.profile);
    const afterSequence =
      flags["after-sequence"] !== undefined
        ? Number(flags["after-sequence"])
        : profile.lastSequence || 0;
    const timeout = flags.timeout !== undefined ? Number(flags.timeout) : 0;
    let res = await client.getUpdates({ afterSequence, limit: Number(flags.limit || 50), timeout });
    if (res?.syncRequired && Number(res.currentSequence) > 0 && afterSequence === 0) {
      const fallbackSeq = Math.max(0, Number(res.currentSequence) - 100);
      const retry = await client
        .getUpdates({ afterSequence: fallbackSeq, limit: Number(flags.limit || 50), timeout })
        .catch(() => null);
      if (retry && !retry.syncRequired) {
        res = retry;
      }
    }
    const events = Array.isArray(res?.events) ? res.events : [];
    if (flags.ack) {
      const maxSeq =
        events.length > 0
          ? Math.max(...events.map((e) => Number(e.sequence || 0)))
          : Number(res?.currentSequence || 0);
      if (maxSeq > 0) {
        await client.acknowledge({ sequence: maxSeq }).catch(() => {});
        updateProfileCursor(profileName, maxSeq);
      }
    }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "wait") {
    const { client, profile, profileName } = requireClient(flags.profile);
    const timeoutSeconds = Math.min(86400, Math.max(5, Number(flags.timeout || 3600)));
    const startSeq =
      flags["after-sequence"] !== undefined
        ? Number(flags["after-sequence"])
        : profile.lastSequence || 0;
    const filterConv = typeof flags.conversation === "string" ? flags.conversation.trim() : "";
    const transportMode = String(flags.transport || "auto").trim().toLowerCase();
    const startedAtMs = Date.now();

    const waitViaPoll = async (cursor) => {
      const remainingMs = Math.max(1000, timeoutSeconds * 1000 - (Date.now() - startedAtMs));
      const polled = await client.pollNextEvent({
        afterSequence: cursor,
        timeoutMs: remainingMs,
        conversationId: filterConv,
        onCursorAdvance: (seq) => updateProfileCursor(profileName, seq),
        onSyncRequired: ({ currentSequence }) => updateProfileCursor(profileName, currentSequence),
      });
      if (polled.timeout || !polled.event) {
        return {
          status: "timeout",
          profile: profileName,
          waitedSeconds: timeoutSeconds,
          lastSequence: polled.lastSequence,
          transport: "poll",
        };
      }
      const ev = polled.event;
      if (ev.conversationId) {
        await client.setTyping(ev.conversationId).catch(() => {});
      }
      let context = null;
      if (ev.conversationId && profile.scopes?.includes("messages:read_context")) {
        context = await client.getContext(ev.conversationId, { limit: 15 }).catch(() => null);
      }
      return {
        status: "event",
        profile: profileName,
        lastSequence: polled.lastSequence,
        transport: "poll",
        event: ev,
        context,
      };
    };

    const result =
      transportMode === "poll"
        ? await waitViaPoll(startSeq)
        : await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              client.stop();
              resolve({
                status: "timeout",
                profile: profileName,
                waitedSeconds: timeoutSeconds,
                lastSequence: client.lastSequence || startSeq,
                transport: "ws",
              });
            }, timeoutSeconds * 1000);

            client
              .connect({
                lastSequence: startSeq,
                async onEvent(event) {
                  updateProfileCursor(profileName, event.sequence);
                  await client
                    .acknowledge({ eventId: event.eventId, sequence: event.sequence })
                    .catch(() => {});
                  if (filterConv && event.conversationId !== filterConv) {
                    return;
                  }
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  if (event.conversationId) {
                    await client.setTyping(event.conversationId).catch(() => {});
                  }
                  let context = null;
                  if (event.conversationId && profile.scopes?.includes("messages:read_context")) {
                    context = await client.getContext(event.conversationId, { limit: 15 }).catch(() => null);
                  }
                  setImmediate(() => client.stop());
                  resolve({
                    status: "event",
                    profile: profileName,
                    lastSequence: event.sequence,
                    transport: "ws",
                    event,
                    context,
                  });
                },
                async onSyncRequired({ currentSequence }) {
                  updateProfileCursor(profileName, currentSequence);
                },
                onError(err) {
                  if (!settled && !err?.retryable) {
                    settled = true;
                    clearTimeout(timer);
                    client.stop();
                    reject(err);
                  }
                },
              })
              .catch((err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                client.stop();
                if (transportMode === "auto" && err?.retryable) {
                  waitViaPoll(client.lastSequence || startSeq).then(resolve, reject);
                  return;
                }
                reject(err);
              });
          });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (subcommand === "send") {
    const [conversationId, ...rest] = positionals.slice(1);
    const text = rest.join(" ").trim();
    if (!conversationId || !text) {
      throw new Error("Usage: duallane-agent send <conversationId> <text> [--reply-to <msgId>]");
    }
    const { client } = requireClient(flags.profile);
    const res = await client.sendMessage({
      conversationId,
      text,
      replyToMessageId: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "edit") {
    const [messageId, ...rest] = positionals.slice(1);
    const text = rest.join(" ").trim();
    if (!messageId || !text) {
      throw new Error("Usage: duallane-agent edit <messageId> <text> [--profile default]");
    }
    const { client } = requireClient(flags.profile);
    const res = await client.editMessage(messageId, text);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "typing") {
    const [conversationId] = positionals.slice(1);
    if (!conversationId) {
      throw new Error("Usage: duallane-agent typing <conversationId> [--state thinking|typing] [--profile default]");
    }
    const { client } = requireClient(flags.profile);
    const state = flags.state === "typing" ? "typing" : "thinking";
    const res = await client.setTyping(conversationId, { state });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "unbind") {
    const { client, profileName } = requireClient(flags.profile);
    const revoked = await client.unbind().catch(() => ({ ok: false }));
    const deleted = deleteAgentProfile(profileName);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          profile: profileName,
          serverRevoked: Boolean(revoked?.ok),
          localDeleted: deleted,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "listen") {
    await runListen(flags);
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Run "duallane-agent --help".`);
}

const isDirectCli = (() => {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isDirectCli) {
  main().catch((err) => {
    const safeMsg = String(err?.message || err).replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
    process.stderr.write(`[DualLane Error] ${safeMsg}\n`);
    process.exit(1);
  });
}
