import crypto from "node:crypto";
import { LiteWebSocket, OPEN } from "./ws-lite.js";
import { requestGateway, readGatewayBytes } from "./transport.js";
import { normalizeFileBytes } from "./file-input.js";

export const DUALLANE_AGENT_SDK_VERSION = "1.1.2";
export const DUALLANE_GATEWAY_VERSION = 1;

export function compareRuntimeSemver(a, b) {
  const pa = String(a || "")
    .trim()
    .replace(/^v/iu, "")
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "")
    .trim()
    .replace(/^v/iu, "")
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

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
  #requestTimeoutMs;
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
    this.#requestTimeoutMs = normalizeDuration(options.requestTimeoutMs, 35_000, 1, 120_000, "requestTimeoutMs");
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
      manualAck: options.ack === false,
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
    const result = await this.#request("POST", "/api/bot-gateway/v1/events/ack", body);
    if (result.acknowledged !== true
      || (result.eventId !== undefined && result.eventId !== body.eventId)
      || (result.sequence !== undefined && result.sequence !== body.sequence)) {
      throw new DualLaneAgentError("gateway.ack_rejected", "Event acknowledgement was rejected");
    }
    return result;
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
      feishuCard: input.feishuCard,
      card: input.card
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
    const request = { signal: options.signal, timeoutMs: options.timeoutMs };
    if (state === "typing" || state === "thinking") {
      return this.#request("POST", "/api/bot/v2/typing", { conversationId: id, state }, request);
    }
    return this.#request("POST", "/api/bot-gateway/v1/typing", { conversationId: id }, request);
  }

  async unbind() {
    return this.#request("POST", "/api/bot/v2/unbind", {});
  }

  async publishMobileRelease(options = {}) {
    const apkBytes = options.apkBytes;
    if (!(apkBytes instanceof Uint8Array) || apkBytes.byteLength === 0) {
      throw new TypeError("apkBytes must be a non-empty Uint8Array or Buffer");
    }
    const params = new URLSearchParams();
    if (typeof options.version === "string" && options.version.trim()) {
      params.set("version", options.version.trim());
    }
    if (Number.isInteger(options.versionCode) && options.versionCode > 0) {
      params.set("versionCode", String(options.versionCode));
    }
    if (Number.isInteger(options.minNativeVersionCode) && options.minNativeVersionCode > 0) {
      params.set("minNativeVersionCode", String(options.minNativeVersionCode));
    }
    const qs = params.toString();
    const uploaded = await this.#requestBinary(
      "PUT",
      `/api/bot/v2/mobile-release/apk${qs ? `?${qs}` : ""}`,
      apkBytes,
      "application/vnd.android.package-archive"
    );
    const rel = uploaded?.release || {};
    if (
      options.title !== undefined ||
      options.notes !== undefined ||
      options.enabled !== undefined ||
      options.minNativeVersionCode !== undefined
    ) {
      return await this.#request("PUT", "/api/bot/v2/mobile-release", {
        enabled: options.enabled ?? true,
        version: options.version || rel.version || "",
        versionCode: options.versionCode || rel.versionCode || 0,
        title: options.title !== undefined ? String(options.title) : rel.title || "",
        notes: options.notes !== undefined ? String(options.notes) : rel.notes || "",
        ...(Number.isInteger(options.minNativeVersionCode) && options.minNativeVersionCode > 0
          ? { minNativeVersionCode: options.minNativeVersionCode }
          : {})
      });
    }
    return uploaded;
  }

  async publishMobileOTA(options = {}) {
    const zipBytes = options.zipBytes;
    if (!(zipBytes instanceof Uint8Array) || zipBytes.byteLength === 0) {
      throw new TypeError("zipBytes must be a non-empty Uint8Array or Buffer");
    }
    const params = new URLSearchParams();
    if (typeof options.version === "string" && options.version.trim()) {
      params.set("version", options.version.trim());
    }
    if (Number.isInteger(options.minNativeVersionCode) && options.minNativeVersionCode > 0) {
      params.set("minNativeVersionCode", String(options.minNativeVersionCode));
    }
    const qs = params.toString();
    const uploaded = await this.#requestBinary(
      "PUT",
      `/api/bot/v2/mobile-release/ota${qs ? `?${qs}` : ""}`,
      zipBytes,
      "application/zip"
    );
    const rel = uploaded?.release || {};
    if (options.title !== undefined || options.notes !== undefined || options.enabled !== undefined) {
      return await this.#request("PUT", "/api/bot/v2/mobile-release", {
        enabled: options.enabled ?? true,
        version: options.version || rel.version || "",
        versionCode: rel.versionCode || 0,
        title: options.title !== undefined ? String(options.title) : rel.title || "",
        notes: options.notes !== undefined ? String(options.notes) : rel.notes || "",
        ...(Number.isInteger(options.minNativeVersionCode) && options.minNativeVersionCode > 0
          ? { minNativeVersionCode: options.minNativeVersionCode }
          : {})
      });
    }
    return uploaded;
  }

  async listConversations() {
    return this.#request("GET", "/api/bot/v2/conversations");
  }

  async getDoctor() {
    return this.#request("GET", "/api/bot/v2/doctor");
  }

  async editMessage(messageId, plainText) {
    const id = normalizeId(messageId, "messageId");
    const text = typeof plainText === "string" ? plainText.trim() : "";
    if (!text) throw new TypeError("plainText is required");
    return this.#request("PATCH", `/api/bot/v2/messages/${encodeURIComponent(id)}`, { plainText: text });
  }

  async sendFile(input = {}) {
    const conversationId = normalizeId(input.conversationId, "conversationId");
    const rawBytes = normalizeFileBytes(input.bytes);
    const fileName = String(input.fileName || "attachment.bin").trim() || "attachment.bin";
    const mimeType = String(input.mimeType || inferMimeTypeFromFileName(fileName)).trim() || "application/octet-stream";
    const params = new URLSearchParams();
    params.set("fileName", fileName);
    params.set("mimeType", mimeType);
    if (typeof input.text === "string" && input.text.trim()) {
      params.set("text", input.text.trim());
    }
    if (typeof input.replyToMessageId === "string" && input.replyToMessageId.trim()) {
      params.set("replyToMessageId", normalizeId(input.replyToMessageId, "replyToMessageId"));
    }
    if (typeof input.clientMessageId === "string" && input.clientMessageId.trim()) {
      params.set("clientMessageId", normalizeId(input.clientMessageId, "clientMessageId"));
    }
    if (input.sendMessage === false) {
      params.set("sendMessage", "false");
    }
    return this.#requestBinary(
      "POST",
      `/api/bot/v2/conversations/${encodeURIComponent(conversationId)}/files?${params.toString()}`,
      rawBytes,
      mimeType
    );
  }

  async uploadFile(input = {}) {
    return this.sendFile({ ...input, sendMessage: false });
  }

  async reserveUpload(input = {}) {
    const byteSize = normalizeDuration(input.byteSize, undefined, 1, 50 * 1024 * 1024, "byteSize");
    const fileName = String(input.fileName || "attachment.bin").trim();
    if (!fileName || fileName.length > 240 || /[\x00-\x1f\\/]/u.test(fileName)) throw new TypeError("fileName is invalid");
    return this.#request("POST", "/api/bot-gateway/v1/attachments", {
      conversationId: normalizeId(input.conversationId, "conversationId"),
      fileName,
      mimeType: String(input.mimeType || inferMimeTypeFromFileName(fileName)),
      byteSize,
      visibility: "conversation",
    });
  }

  async getUploadStatus(uploadId) {
    return this.#request("GET", `/api/bot/v2/uploads/${encodeURIComponent(normalizeId(uploadId, "uploadId"))}`);
  }

  async readAttachment(input = {}) {
    const conversationId = normalizeId(input.conversationId, "conversationId");
    const attachmentId = normalizeId(input.attachmentId, "attachmentId");
    const messageId = normalizeId(input.messageId, "messageId");
    const mode = input.mode ?? "content";
    if (mode !== "content" && mode !== "preview") throw new TypeError("attachment mode is invalid");
    const limit = mode === "preview" ? 64 * 1024 : 10 * 1024 * 1024;
    const maxBytes = normalizeDuration(input.maxBytes, limit, 1, limit, "maxBytes");
    const query = new URLSearchParams({ messageId, mode });
    return this.#gatewayRequest("GET", `/api/bot/v2/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/content?${query}`, {
      signal: input.signal,
      accept: "application/octet-stream",
      read: async (response) => {
        const mimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const bytes = await readGatewayBytes(response, maxBytes);
        return { bytes, mimeType, byteSize: bytes.byteLength };
      },
    });
  }

  async completeUploadContent(uploadId, rawBytes, mimeType = "application/octet-stream") {
    const id = normalizeId(uploadId, "uploadId");
    rawBytes = normalizeFileBytes(rawBytes, { allowText: false });
    return this.#requestBinary(
      "PUT",
      `/api/bot/v2/uploads/${encodeURIComponent(id)}/content`,
      rawBytes,
      mimeType
    );
  }

  async getUpdates(options = {}) {
    const afterSequence = options.afterSequence === undefined ? 0 : normalizeSequence(options.afterSequence, true);
    const limit = options.limit === undefined ? 50 : normalizeLimit(options.limit);
    const timeoutRaw = options.timeout === undefined ? 0 : Number(options.timeout);
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(25, Math.floor(timeoutRaw)) : 0;
    const timeoutParam = timeout > 0 ? `&timeout=${timeout}` : "";
    return this.#request("GET", `/api/bot/v2/updates?afterSequence=${afterSequence}&limit=${limit}${timeoutParam}`, undefined, { signal: options.signal, timeoutMs: options.timeoutMs });
  }

  async pollNextEvent(options = {}) {
    const deadlineMs = Date.now() + Math.max(1000, Number(options.timeoutMs || 60_000));
    const filterConv = typeof options.conversationId === "string" ? options.conversationId.trim() : "";
    const initialCursor = normalizeSequence(options.afterSequence ?? 0, true);
    let cursor = initialCursor;
    const signal = options.signal;

    while (Date.now() < deadlineMs && !signal?.aborted) {
      const remainingSec = Math.max(1, Math.ceil((deadlineMs - Date.now()) / 1000));
      const longPollSec = Math.min(20, remainingSec);
      const res = await this.getUpdates({ afterSequence: cursor, limit: 50, timeout: longPollSec, signal, timeoutMs: Math.min(this.#requestTimeoutMs, Math.max(1, deadlineMs - Date.now())) });
      if (res?.syncRequired && Number.isSafeInteger(res?.currentSequence)) {
        cursor = Math.max(0, Number(res.currentSequence));
        await options.onSyncRequired?.({ currentSequence: cursor, reason: "sync_required" });
        continue;
      }
      const events = Array.isArray(res?.events) ? res.events : [];
      for (const ev of events) {
        const seq = normalizeSequence(ev?.sequence);
        normalizeId(ev?.eventId, "eventId");
        if (filterConv && ev?.conversationId !== filterConv) {
          // A filtered read must not acknowledge or persist another conversation.
          cursor = Math.max(cursor, seq);
          continue;
        }
        if (options.ack === true) {
          await this.acknowledge({ eventId: ev.eventId, sequence: seq });
          cursor = Math.max(cursor, seq);
          if (!filterConv) {
            this.#lastSequence = Math.max(this.#lastSequence, seq);
            await options.onCursorAdvance?.(cursor);
          }
        }
        return { timeout: false, event: ev, lastSequence: Math.max(initialCursor, this.#lastSequence), nextSequence: seq, requiresAck: options.ack !== true, transport: "poll" };
      }
      if (events.length === 0 && Date.now() < deadlineMs && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return { timeout: true, lastSequence: Math.max(initialCursor, this.#lastSequence), transport: "poll" };
  }

  async #request(method, path, body, options = {}) {
    return this.#gatewayRequest(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      ...options,
    });
  }

  async #requestBinary(method, path, rawBytes, contentType = "application/octet-stream") {
    return this.#gatewayRequest(method, path, { body: rawBytes, contentType, byteSize: rawBytes.byteLength });
  }

  async #gatewayRequest(method, route, options = {}) {
    try {
      return await requestGateway({
        fetchImpl: this.#fetch,
        url: new URL(route, this.#origin),
        timeoutMs: options.timeoutMs ?? this.#requestTimeoutMs,
        signal: options.signal,
        read: options.read,
        init: {
          method,
          headers: compact({
            authorization: `Bearer ${this.#token}`,
            accept: options.accept || "application/json",
            "content-type": options.contentType,
            "content-length": options.byteSize === undefined ? undefined : String(options.byteSize),
            "x-duallane-adapter-version": this.#adapterVersion,
          }),
          body: options.body,
        },
      });
    } catch (error) {
      throw new DualLaneAgentError(error.code || "network.unavailable", "DualLane Agent Gateway request failed", {
        statusCode: error.statusCode,
        retryable: error.retryable === true,
      });
    }
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
          this.#eventChain = this.#eventChain.then(async () => {
            if (generation !== this.#generation || this.#stopped) return;
            await this.#consumeEvent(frame.event);
          }).catch((error) => {
            this.#reportError(error);
            if (generation === this.#generation) {
              this.#generation += 1;
              this.#socket = null;
              socket.close(1011, "event not accepted");
              this.#rejectPendingAcks(new DualLaneAgentError("gateway.disconnected", "Event was not accepted", { retryable: true }));
              if (!this.#stopped) this.#scheduleReconnect();
            }
          });
          return;
        }
        if (frame.type === "sync_required") {
          const currentSequence = normalizeSequence(frame.currentSequence ?? 0, true);
          this.#eventChain = this.#eventChain.then(async () => {
            if (generation !== this.#generation || this.#stopped) return;
            await this.#callbacks.onSyncRequired?.({
              currentSequence,
              reason: safeErrorText(frame.reason, "sync_required")
            });
            if (generation !== this.#generation || this.#stopped) return;
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
    if (this.#callbacks.manualAck) return;
    const ack = await this.#ackOverSocket({ sequence, eventId });
    if (!ack.acknowledged) throw new DualLaneAgentError("gateway.ack_rejected", "Event acknowledgement was rejected");
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

export function inferMimeTypeFromFileName(fileName) {
  const lower = String(fileName || "").trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot !== -1 ? lower.slice(dot) : "";
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".html":
    case ".htm":
      return "text/html";
    case ".zip":
      return "application/zip";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".ts":
    case ".tsx":
    case ".py":
    case ".go":
    case ".rs":
    case ".sh":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".sql":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
