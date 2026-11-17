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
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

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
      if (res.statusCode === 426) {
        const chunks = [];
        let total = 0;
        const origin = new URL(parsed); origin.protocol = isSecure ? "https:" : "http:";
        let finished = false;
        const failUpgrade = (input = {}) => {
          if (finished) return;
          finished = true;
          this.#fail(gatewayTransportError("sdk.upgrade_required", 426, false, sdkUpgradeInfo(input, origin)));
        };
        const timer = setTimeout(() => { res.destroy(); failUpgrade(); }, 1000);
        timer.unref?.();
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > 16 * 1024) { clearTimeout(timer); res.destroy(); failUpgrade(); }
          else chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(timer);
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error; } catch { /* Safe same-origin defaults suffice. */ }
          failUpgrade(input);
        });
        res.on("error", () => { clearTimeout(timer); failUpgrade(); });
        return;
      }
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
    if (this.#closeEmitted) return;
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

// --- src/transport.js ---
// Shared HTTP boundary: credentials stay on the configured gateway origin.
// Fixed input-validation codes from Go's feishucards converter. Business/action
// errors and future card.* codes must remain unknown rather than expanding this
// into a promise about every use of an idempotency key.
const CARD_VALIDATION_REJECTION_CODES = new Set([
  "card.feishu_invalid", "card.feishu_elements_required", "card.feishu_invalid_config",
  "card.feishu_unsupported_version", "card.feishu_invalid_header", "card.feishu_style_forbidden",
  "card.feishu_invalid_element", "card.feishu_unknown_element", "card.feishu_invalid_note",
  "card.feishu_invalid_actions", "card.feishu_invalid_button", "card.feishu_invalid_action",
  "card.feishu_duplicate_action", "card.feishu_invalid_columns", "card.feishu_invalid_column",
  "card.feishu_invalid_text", "card.unknown_action", "card.feishu_action_input_forbidden",
  "card.feishu_unknown_field",
  "card.invalid_payload", "card.payload_too_large", "card.payload_too_complex", "card.payload_too_deep",
  "card.text_too_large", "card.unsafe_content", "card.invalid_url", "card.url_forbidden", "card.private_url",
]);

export function optionalGatewayResult(error, fallback = null) {
  if (error?.code === "sdk.upgrade_required") throw error;
  return fallback;
}

export function sdkUpgradeInfo(input = {}, origin) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const base = new URL(origin);
  const integrationUrl = (value, fallback, allowed) => {
    try {
      const parsed = new URL(value || fallback, base);
      if (parsed.origin === base.origin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && allowed.includes(parsed.pathname)) return parsed.href;
    } catch { /* Only fixed, same-origin upgrade resources are trusted. */ }
    return new URL(fallback, base).href;
  };
  const version = (value) => /^1\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u.test(value || "") ? value : "1.2.1";
  return Object.freeze({
    minimumSdkVersion: version(input.minimumSdkVersion), latestSdkVersion: version(input.latestSdkVersion),
    runtimeManifestUrl: integrationUrl(input.runtimeManifestUrl, "/integrations/duallane-agent.manifest.json", ["/integrations/duallane-agent.manifest.json", "/integrations/v2/duallane-agent.manifest.json"]),
    docsUrl: integrationUrl(input.docsUrl, "/integrations/v2/duallane-channel.md", ["/integrations/duallane-channel.md", "/integrations/v2/duallane-channel.md"]),
    skillUrl: integrationUrl(input.skillUrl, "/integrations/duallane-agent/SKILL.md", ["/integrations/duallane-agent/SKILL.md"]),
  });
}

export function gatewayTransportError(code, statusCode = 0, retryable = false, upgrade) {
  const error = new Error("DualLane gateway request failed");
  error.name = "DualLaneAgentError";
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  error.retryable = code === "sdk.upgrade_required" ? false : retryable;
  if (code === "sdk.upgrade_required") {
    error.message = "DualLane Agent SDK upgrade required";
    if (upgrade) error.upgrade = upgrade;
  }
  return error;
}

export async function readGatewayBytes(response, maxBytes = 4 * 1024 * 1024) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw gatewayTransportError("gateway.response_too_large");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw gatewayTransportError("gateway.response_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw gatewayTransportError("gateway.response_too_large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readGatewayJson(response) {
  const type = response.headers?.get?.("content-type") || "";
  if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(type)) {
    await response.body?.cancel?.().catch(() => {});
    if (!response.ok) return {};
    throw gatewayTransportError("gateway.invalid_response", response.status, true);
  }
  try {
    const data = response.body || response.arrayBuffer
      ? JSON.parse((await readGatewayBytes(response)).toString("utf8"))
      : await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error?.code === "gateway.response_too_large") throw error;
    if (!response.ok) return {};
    throw gatewayTransportError("gateway.invalid_response", response.status, true);
  }
}

export async function requestGateway({ fetchImpl, url, init, timeoutMs = 35_000, signal, read = readGatewayJson }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("requestTimeoutMs is invalid");
  }
  const controller = new AbortController();
  let rejectDeadline;
  let timedOut = false;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const abort = () => {
    controller.abort();
    rejectDeadline(gatewayTransportError("sdk.aborted"));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(gatewayTransportError("network.timeout", 0, true));
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw gatewayTransportError("sdk.aborted");
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const data = await readGatewayJson(response);
        const code = response.status === 426 ? "sdk.upgrade_required" : /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(data?.error?.code || "")
          ? data.error.code : "gateway.request_failed";
        const error = gatewayTransportError(code, response.status, response.status === 429 || response.status >= 500,
          code === "sdk.upgrade_required" ? sdkUpgradeInfo(data.error, url) : undefined);
        if ([400, 422].includes(response.status) && ["POST", "PATCH", "PUT"].includes(init?.method) && CARD_VALIDATION_REJECTION_CODES.has(code)) {
          error.attemptOutcome = "rejected";
          error.safeToRetry = false;
        }
        throw error;
      }
      return await read(response);
    })()]);
  } catch (error) {
    if (timedOut) throw gatewayTransportError("network.timeout", 0, true);
    if (signal?.aborted) throw gatewayTransportError("sdk.aborted");
    if (error?.name === "DualLaneAgentError") throw error;
    // Never retain a fetch cause, URL, response body, or arbitrary server message.
    throw gatewayTransportError("network.unavailable", 0, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// --- src/base64.js ---
const ARTIFACT_BASE64_VALUES = new Uint8Array(128).fill(255);
for (const [index, character] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
  ARTIFACT_BASE64_VALUES[character.charCodeAt(0)] = index;
}

function artifactBase64Error(code) {
  return Object.assign(new Error(code), { code });
}

/** Strict RFC 4648 decoding with O(n) time and constant validation stack space. */
export function decodeArtifactBase64(data, { maxBytes = 25 * 1024 * 1024 } = {}) {
  if (typeof data !== "string") throw artifactBase64Error("artifact.invalid_data");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw artifactBase64Error("artifact.too_large");
  if (data.length % 4 !== 0) throw artifactBase64Error("artifact.invalid_base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const end = data.length - padding;
  const decodedLength = data.length / 4 * 3 - padding;
  if (decodedLength > maxBytes) throw artifactBase64Error("artifact.too_large");
  // Buffer.from alone silently accepts whitespace, URL-safe characters and bad
  // padding. Validate every character and the unused trailing bits first.
  let last = 0;
  for (let index = 0; index < end; index += 1) {
    const code = data.charCodeAt(index);
    if (code >= ARTIFACT_BASE64_VALUES.length || ARTIFACT_BASE64_VALUES[code] === 255) {
      throw artifactBase64Error("artifact.invalid_base64");
    }
    last = ARTIFACT_BASE64_VALUES[code];
  }
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) {
    throw artifactBase64Error("artifact.invalid_base64");
  }
  return Buffer.from(data, "base64");
}

// --- src/file-input.js ---
export const AGENT_DIRECT_FILE_MAX_BYTES = 50 * 1024 * 1024;

function fileInputError(code) {
  return Object.assign(new TypeError("File input is invalid or exceeds the allowed byte limit."), { code });
}

/** Apply the direct-upload budget before allocating a UTF-8 buffer. */
export function normalizeFileBytes(value, { allowText = true } = {}) {
  if (typeof value === "string" && allowText) {
    const byteSize = Buffer.byteLength(value, "utf8");
    if (byteSize > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
    if (!byteSize) throw fileInputError("artifact.invalid_data");
    return Buffer.from(value, "utf8");
  }
  if (!(value instanceof Uint8Array) || !value.byteLength) throw fileInputError("artifact.invalid_data");
  if (value.byteLength > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
  return value;
}

/** Read a regular file with a finite allocation, refusing a changed size. */
export function readBoundedFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) throw fileInputError("artifact.invalid_data");
    if (stat.size > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
    // One extra byte detects growth without allocating or reading an unbounded body.
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size || fs.fstatSync(fd).size !== stat.size) throw fileInputError("artifact.input_changed");
    return bytes.subarray(0, offset);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("artifact.")) throw error;
    throw fileInputError("artifact.file_unavailable");
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the bounded-input failure. */ } }
  }
}

// --- src/message-content.js ---
export const AGENT_MESSAGE_FORMAT = "duallane.message+json;v=1";
const MESSAGE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_BLOCK_FIELDS = Object.freeze({
  text: ["text"], mention: ["userId", "label"], link: ["url", "label"],
  attachment: ["attachmentId"], emoji: ["shortcode"],
  emote_collection: ["shareId"], topic_reference: ["topicId", "title"], card: ["cardId", "cardType", "schemaVersion", "fallbackText"],
});

function messageInvalid(code = "message.invalid_content") {
  return Object.assign(new TypeError("Invalid structured DualLane message"), { code });
}

function messageReference(value) {
  if (typeof value !== "string" || !MESSAGE_REFERENCE_ID.test(value)) throw messageInvalid("message.invalid_reference");
  return value;
}

export function messageText(text) {
  if (typeof text !== "string" || !text || text.length > 30_000) throw messageInvalid();
  return { type: "text", text };
}

export function messageMention(userId, label = "") {
  if (typeof label !== "string" || label.length > 180) throw messageInvalid();
  return { type: "mention", userId: messageReference(userId), label };
}

export function messageAttachment(attachmentId) {
  return { type: "attachment", attachmentId: messageReference(attachmentId) };
}

export function messageLink(url, label = "") {
  let parsed;
  try { parsed = new URL(url); } catch { throw messageInvalid("message.invalid_link"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || String(url).length > 4096 || typeof label !== "string" || label.length > 1000) throw messageInvalid("message.invalid_link");
  return { type: "link", url: parsed.href, label };
}

function normalizeMessageBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) throw messageInvalid();
  switch (block.type) {
    case "text": return messageText(block.text);
    case "mention": return messageMention(block.userId, block.label);
    case "attachment": return messageAttachment(block.attachmentId);
    case "link": return messageLink(block.url, block.label);
    case "emoji":
      if (typeof block.shortcode !== "string" || !/^(?:[a-z0-9_+\-]{1,64}|custom:[A-Za-z0-9._:-]{1,128})$/u.test(block.shortcode)) throw messageInvalid();
      return { type: "emoji", shortcode: block.shortcode };
    case "emote_collection": return { type: "emote_collection", shareId: messageReference(block.shareId) };
    case "topic_reference":
      if (typeof block.title !== "string" || block.title.length > 300) throw messageInvalid();
      return { type: "topic_reference", topicId: messageReference(block.topicId), title: block.title };
    case "card":
      if (typeof block.cardType !== "string" || block.cardType.length > 100 || !Number.isSafeInteger(block.schemaVersion) || block.schemaVersion < 1 || typeof block.fallbackText !== "string" || block.fallbackText.length > 3000) throw messageInvalid();
      return { type: "card", cardId: messageReference(block.cardId), cardType: block.cardType, schemaVersion: block.schemaVersion, fallbackText: block.fallbackText };
    default: throw messageInvalid("message.unsupported_block");
  }
}

function messageBlockFallback(block) {
  switch (block.type) {
    case "text": return block.text;
    case "mention": return `@${block.label || block.userId}`;
    case "link": return block.label || block.url;
    case "attachment": return "[附件]";
    case "emoji": return `:${block.shortcode}:`;
    case "emote_collection": return "[表情合集]";
    case "topic_reference": return block.title;
    case "card": return block.fallbackText;
    default: return "[不支持的消息内容]";
  }
}

/** Canonical outbound representation; the server still validates IDs and ACLs. */
export function buildMessageContent(input) {
  const blocks = Array.isArray(input) ? input : input?.blocks;
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 100 || (input?.format !== undefined && input.format !== AGENT_MESSAGE_FORMAT)) throw messageInvalid();
  const normalized = blocks.map(normalizeMessageBlock);
  const plainText = normalized.map(messageBlockFallback).join("");
  if (plainText.length > 30_000 || Buffer.byteLength(JSON.stringify(normalized)) > 128 * 1024) throw messageInvalid("message.content_limit");
  return { format: AGENT_MESSAGE_FORMAT, blocks: normalized, plainText };
}

/** Unknown read blocks remain visible as unsupported; never silently re-send them. */
export function parseMessageContent(input) {
  if (!input || input.format !== AGENT_MESSAGE_FORMAT || !Array.isArray(input.blocks) || input.blocks.length > 100) throw messageInvalid();
  const unsupportedBlockTypes = [];
  const blocks = input.blocks.map((block) => {
    if (!Object.hasOwn(MESSAGE_BLOCK_FIELDS, block?.type)) {
      const originalType = typeof block?.type === "string" ? block.type.slice(0, 64) : "unknown";
      unsupportedBlockTypes.push(originalType);
      return { type: "unsupported", originalType };
    }
    return normalizeMessageBlock(block);
  });
  return { format: AGENT_MESSAGE_FORMAT, blocks,
    plainText: typeof input.plainText === "string" ? input.plainText.slice(0, 30_000) : blocks.map(messageBlockFallback).join(""),
    unsupportedBlockTypes, complete: unsupportedBlockTypes.length === 0 };
}

export const AGENT_MESSAGE_CONTENT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { format: { const: AGENT_MESSAGE_FORMAT }, plainText: { type: "string", maxLength: 30_000, description: "Optional display fallback; the server canonicalizes it." },
    blocks: { type: "array", minItems: 1, maxItems: 100,
      items: { oneOf: Object.entries(MESSAGE_BLOCK_FIELDS).map(([type, fields]) => ({
        type: "object", additionalProperties: false,
        properties: { type: { const: type }, ...Object.fromEntries(fields.map((field) => [field,
          field === "schemaVersion" ? { type: "integer", minimum: 1 }
            : { type: "string", ...(field.endsWith("Id") ? { pattern: MESSAGE_REFERENCE_ID.source, maxLength: 128 } : { maxLength: field === "text" ? 30_000 : field === "url" ? 4096 : 3000 }) }])) },
        required: ["type", ...fields.filter((field) => field !== "label")],
      })) } } },
  required: ["format", "blocks"],
});

// --- src/task-client.js ---
const SCOPED_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function scopedTaskError(code) {
  return Object.assign(new Error("DualLane task operation is unavailable"), { name: "DualLaneAgentError", code, retryable: false });
}

function scopedTaskExpiry(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw scopedTaskError("task.invalid_context");
  return time;
}

/** A task is a revocable server grant, never a replacement for the Bot credential. */
export function createTaskScopedClient(client, task, options = {}) {
  if (!task || !SCOPED_TASK_ID.test(task.id || "") || !SCOPED_TASK_ID.test(task.conversationId || "") || typeof client.getTask !== "function") throw scopedTaskError("task.invalid_context");
  const initial = { id: task.id, conversationId: task.conversationId, triggerMessageId: task.triggerMessageId, expiresAt: scopedTaskExpiry(task.expiresAt) };
  const now = options.now ?? Date.now;
  const limit = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  const maxCalls = limit(options.maxCalls, 32, 128);
  const maxResultBytes = limit(options.maxResultBytes, 16 * 1024 * 1024, 64 * 1024 * 1024);
  const deadline = Math.min(initial.expiresAt, now() + limit(options.timeoutMs, 300_000, 600_000));
  let calls = 0, resultBytes = 0, closed = false;
  const controller = new AbortController();
  const abort = () => { closed = true; controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const assertOpen = () => {
    if (closed || options.signal?.aborted) throw scopedTaskError("task.cancelled");
    if (now() >= deadline) throw scopedTaskError("task.expired");
  };
  function conversation(value = initial.conversationId) {
    assertOpen();
    if (value !== initial.conversationId) throw scopedTaskError("task.conversation_mismatch");
    return value;
  }
  async function run(operation) {
    assertOpen();
    if (calls >= maxCalls || resultBytes >= maxResultBytes) throw scopedTaskError("context.budget_exhausted");
    calls++;
    const checked = await client.getTask(initial.id, { signal: controller.signal });
    assertOpen();
    const current = checked?.task;
    if (!current || current.id !== initial.id || current.conversationId !== initial.conversationId || current.triggerMessageId !== initial.triggerMessageId || scopedTaskExpiry(current.expiresAt) <= now() || ["cancelled", "expired", "revoked"].includes(current.status)) throw scopedTaskError("task.authorization_denied");
    const result = await operation(controller.signal);
    assertOpen();
    const bytes = result?.bytes instanceof Uint8Array ? result.bytes.byteLength : Buffer.byteLength(JSON.stringify(result ?? null));
    resultBytes += bytes;
    if (resultBytes > maxResultBytes) throw scopedTaskError("context.budget_exhausted");
    const messageConversation = result?.message?.conversationId;
    if (messageConversation && messageConversation !== initial.conversationId) throw scopedTaskError("task.conversation_mismatch");
    return result;
  }
  async function requireFeature(feature) {
    const capabilities = await run((signal) => client.getCapabilities(initial.conversationId, { signal }));
    if (capabilities?.features?.[feature] !== true) throw scopedTaskError("task.operation_unavailable");
  }
  function reference(operation, key) { return { taskId: initial.id, operation, key }; }
  async function mutation(operation, key, execute) {
    const operationReference = reference(operation, key);
    try { return { ...await run(execute), operation: operationReference }; }
    catch (error) { error.operation = operationReference; throw error; }
  }
  const scoped = {
    task: Object.freeze({ ...initial }),
    close() { abort(); options.signal?.removeEventListener("abort", abort); },
    budget() { return { calls, maxCalls, resultBytes, maxResultBytes, expiresAt: deadline }; },
    validate() { return run(async () => ({ valid: true })); },
    getCapabilities() { return run((signal) => client.getCapabilities(initial.conversationId, { signal })); },
    getOperation(operation, key) { return run((signal) => client.getOperation(initial.id, operation, key, { signal })); },
    getContext(id = initial.conversationId, input = {}) { return run((signal) => client.getContext(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    getMessage(messageId, input = {}) { return run((signal) => client.getMessage(messageId, { ...input, conversationId: initial.conversationId, signal })); },
    listHistory(id = initial.conversationId, input = {}) { return run((signal) => client.listHistory(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    searchMessages(id = initial.conversationId, input = {}) { return run((signal) => client.searchMessages(conversation(id), { ...input, signal, limit: Math.min(input.limit ?? 12, 50) })); },
    listMembers(id = initial.conversationId) { return run((signal) => client.listMembers(conversation(id), { signal })); },
    sendMessage(input) { conversation(input?.conversationId); return run((signal) => client.sendMessage({ ...input, signal })); },
    async editMessage(messageId, input, options = {}) {
      await requireFeature("conditionalMessageEdit");
      const update = typeof input === "string" ? { plainText: input, expectedVersion: options.expectedVersion } : { ...input };
      if (update.expectedVersion === undefined) update.expectedVersion = (await scoped.getMessage(messageId))?.message?.version;
      if (!/^[a-f0-9]{64}$/u.test(update.expectedVersion || "")) throw scopedTaskError("message.version_required");
      const key = "edit_" + crypto.createHash("sha256").update(`${messageId}:${update.expectedVersion}`).digest("hex");
      return mutation("message.edit", key, (signal) => client.editMessage(messageId, update, { signal }));
    },
    sendCard(input) { conversation(input?.conversationId); return run((signal) => client.sendCard({ ...input, signal })); },
    sendFeishuCard(input) { conversation(input?.conversationId); return run((signal) => client.sendFeishuCard({ ...input, signal })); },
    async updateCard(cardId, input = {}) {
      await requireFeature("taskCardUpdate");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw scopedTaskError("card.revision_required");
      const key = "card_" + crypto.createHash("sha256").update(`${cardId}:${input.expectedRevision}`).digest("hex");
      return mutation("card.update", key, (signal) => client.updateCard(cardId, { ...input, signal }));
    },
    async updateFeishuCard(cardId, input = {}) {
      await requireFeature("taskCardUpdate");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw scopedTaskError("card.revision_required");
      const key = "card_" + crypto.createHash("sha256").update(`${cardId}:${input.expectedRevision}`).digest("hex");
      return mutation("card.update", key, (signal) => client.updateFeishuCard(cardId, { ...input, signal }));
    },
    sendFile(input) { conversation(input?.conversationId); return run((signal) => client.sendFile({ ...input, signal })); },
    uploadFile(input) { conversation(input?.conversationId); return run((signal) => client.uploadFile({ ...input, signal })); },
    reserveUpload(input) { conversation(input?.conversationId); return run((signal) => client.reserveUpload({ ...input, signal })); },
    completeUploadContent(uploadId, bytes, mimeType) { return run((signal) => client.completeUploadContent(uploadId, bytes, mimeType, { signal })); },
    getUploadStatus(uploadId) { return run((signal) => client.getUploadStatus(uploadId, { signal })); },
    readAttachment(input) { conversation(input?.conversationId); return run((signal) => client.readAttachment({ ...input, signal })); },
    setTyping(id, input = {}) { conversation(id); return client.setTyping(id, { ...input, signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal }); },
  };
  return Object.freeze(scoped);
}

// --- src/task-tools.js ---
const taskToolSchema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const taskToolString = { type: "string", minLength: 1, maxLength: 4096 };
const taskHistoryProperties = { before: taskToolString, query: { type: "string", minLength: 1, maxLength: 500 },
  authorId: taskToolString, startTime: taskToolString, endTime: taskToolString,
  limit: { type: "integer", minimum: 1, maximum: 50 } };
const TASK_CARD_ACTIONS = new Set(["confirm", "cancel", "submit", "refresh"]);
const TASK_CARD_INPUT_PROPERTIES = {
  title: { type: "string", minLength: 1, maxLength: 180 }, markdown: { type: "string", maxLength: 16_000 },
  tone: { enum: ["blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "grey"] },
  fallbackText: { type: "string", maxLength: 3000 },
  buttons: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false,
    properties: { actionId: { enum: [...TASK_CARD_ACTIONS] }, label: { type: "string", maxLength: 180 },
      style: { enum: ["default", "primary", "danger"] }, value: { type: "object" } }, required: ["actionId", "label"] } },
};
const TASK_TOOL_FEATURES = Object.freeze({ duallane_edit_message: "conditionalMessageEdit", duallane_send_card: "taskCardUpdate", duallane_update_card: "taskCardUpdate" });

// Both task and operator MCP use the same fixed-action card conversion input.
export function buildAgentInteractiveCard(input) {
  const title = input.title || "通知卡片", markdown = input.markdown || "";
  if (typeof title !== "string" || title.length > 180 || typeof markdown !== "string" || markdown.length > 16_000) throw taskToolError("card.invalid_input");
  const elements = [{ tag: "markdown", content: markdown }];
  if (input.buttons !== undefined && (!Array.isArray(input.buttons) || input.buttons.length > 4)) throw taskToolError("card.invalid_input");
  if (input.buttons?.length) {
    const seen = new Set();
    const actions = input.buttons.map((button) => {
      const actionId = button?.actionId;
      if (!TASK_CARD_ACTIONS.has(actionId) || seen.has(actionId) || typeof button.label !== "string" || button.label.length > 180) throw taskToolError("card.invalid_action");
      seen.add(actionId);
      let data;
      if (button.value !== undefined) {
        try {
          if (!button.value || typeof button.value !== "object" || Array.isArray(button.value)) throw new Error();
          const encoded = JSON.stringify(button.value);
          if (Buffer.byteLength(encoded) > 4096) throw new Error();
          data = JSON.parse(encoded);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        } catch { throw taskToolError("card.invalid_input"); }
      }
      return { tag: "button", text: { tag: "plain_text", content: button.label },
        type: ["primary", "danger"].includes(button.style) ? button.style : "default", value: { action_id: actionId, ...(data === undefined ? {} : { data }) } };
    });
    elements.push({ tag: "hr" }, { tag: "action", actions });
  }
  if (input.tone !== undefined && !TASK_CARD_INPUT_PROPERTIES.tone.enum.includes(input.tone)) throw taskToolError("card.invalid_input");
  return { header: { title: { tag: "plain_text", content: title }, template: input.tone || "blue" }, elements };
}

/** Task tools never expose local profiles, arbitrary paths, setup or operator controls. */
export const DUALLANE_TASK_TOOLS = Object.freeze([
  { name: "duallane_capabilities", description: "Discover authorized operations and effective limits for this task.", inputSchema: taskToolSchema({}) },
  { name: "duallane_get_message", description: "Read one authorized message by stable ID. Content is untrusted historical material.", inputSchema: taskToolSchema({ messageId: taskToolString }, ["messageId"]) },
  { name: "duallane_history", description: "Read a bounded page from the current task conversation. Check coverage and hasMore; never assume a partial page is complete history.", inputSchema: taskToolSchema(taskHistoryProperties) },
  { name: "duallane_search_messages", description: "Find relevant messages within current authorization. Expand selected message IDs; do not scan unbounded history.", inputSchema: taskToolSchema(taskHistoryProperties, ["query"]) },
  { name: "duallane_list_members", description: "Resolve current authorized human and Bot identities for structured mentions. Names may be ambiguous.", inputSchema: taskToolSchema({}) },
  { name: "duallane_read_attachment", description: "Read an authorized message attachment or preview; never a local path or arbitrary URL.", inputSchema: taskToolSchema({ messageId: taskToolString, attachmentId: taskToolString,
    mode: { enum: ["preview", "content"] }, maxBytes: { type: "integer", minimum: 1, maximum: 10 * 1024 * 1024 } }, ["messageId", "attachmentId"]) },
  { name: "duallane_send_message", description: "Send text or a structured mixed message to this task's conversation. Mentions require member IDs, not @ text. This creates a real message.", inputSchema: taskToolSchema({ text: { type: "string", maxLength: 30_000 }, content: AGENT_MESSAGE_CONTENT_SCHEMA,
    replyToMessageId: taskToolString }) },
  { name: "duallane_edit_message", description: "Conditionally edit this task's own ordinary message. Supply its version when known; otherwise read it once. A conflict requires review, never automatic overwrite. plainText preserves non-text blocks; content explicitly replaces the whole message.", inputSchema: taskToolSchema({ messageId: taskToolString, expectedVersion: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }, plainText: { type: "string", maxLength: 30_000 }, content: AGENT_MESSAGE_CONTENT_SCHEMA }, ["messageId"]) },
  { name: "duallane_send_card", description: "Send a task-owned fixed-action card to this conversation. Card data does not grant permissions or execute code.", inputSchema: taskToolSchema(TASK_CARD_INPUT_PROPERTIES, ["title", "markdown"]) },
  { name: "duallane_update_card", description: "Replace this task's own card using the current expectedRevision. Supply complete title/markdown/actions; conflicts are not automatically retried.", inputSchema: taskToolSchema({ cardId: taskToolString, expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, ...TASK_CARD_INPUT_PROPERTIES }, ["cardId", "expectedRevision", "title", "markdown"]) },
  { name: "duallane_query_operation", description: "Coordinate a known operation reference in this task. committed proves server submission, not human reading; unknown with safeToRetry=false must not be blindly reissued.", inputSchema: taskToolSchema({ operation: { enum: ["message.send", "message.edit", "card.send", "card.update"] }, key: taskToolString }, ["operation", "key"]) },
]);

function taskToolError(code) { return Object.assign(new Error("DualLane task tool failed"), { code }); }

export function safeAgentOperationReference(value, taskId) {
  const valid = (text) => typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text);
  if (!value || !valid(value.taskId) || !valid(value.key) || (taskId && value.taskId !== taskId) || !["message.send", "message.edit", "card.send", "card.update"].includes(value.operation)) return undefined;
  return { taskId: value.taskId, operation: value.operation, key: value.key };
}

function taskToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw taskToolError("tool.invalid_arguments");
  for (const name of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, name)) throw taskToolError("tool.invalid_arguments");
  for (const name of tool.inputSchema.required) if (args[name] === undefined) throw taskToolError("tool.invalid_arguments");
  for (const [name, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[name];
    if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 4096))) throw taskToolError("tool.invalid_arguments");
    if (schema.type === "integer" && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) throw taskToolError("tool.invalid_arguments");
    if (schema.enum && !schema.enum.includes(value)) throw taskToolError("tool.invalid_arguments");
  }
}

export function createTaskToolServer(client, options = {}) {
  if (!client?.task || typeof client.validate !== "function") throw taskToolError("task.invalid_context");
  const completedWrites = new Map();
  let capabilities = options.capabilities;
  const availableTools = () => DUALLANE_TASK_TOOLS.filter((tool) => !TASK_TOOL_FEATURES[tool.name] || capabilities?.features?.[TASK_TOOL_FEATURES[tool.name]] === true);
  async function getTools() {
    capabilities = await client.getCapabilities();
    return availableTools();
  }
  async function rememberWrite(name, input, operationId, execute) {
    if (typeof operationId !== "string" || !operationId || operationId.length > 128) throw taskToolError("tool.operation_id_required");
    const fingerprint = JSON.stringify([name, input]);
    if (completedWrites.has(operationId)) {
      await client.validate();
      const previous = completedWrites.get(operationId);
      if (previous.fingerprint !== fingerprint) throw taskToolError("tool.idempotency_conflict");
      return previous.promise;
    }
    if (completedWrites.size >= 128) throw taskToolError("context.budget_exhausted");
    const key = `tool-${crypto.createHash("sha256").update(`${client.task.id}\n${operationId}`).digest("hex")}`;
    const promise = Promise.resolve().then(() => execute(key));
    completedWrites.set(operationId, { fingerprint, promise });
    return promise;
  }
  async function withOperation(operation, key, execute) {
    const reference = { taskId: client.task.id, operation, key };
    try { return { ...await execute(), operation: reference }; }
    catch (error) { error.operation = reference; throw error; }
  }
  async function callTool(name, input = {}, operationId) {
    const tool = DUALLANE_TASK_TOOLS.find((item) => item.name === name);
    if (!tool) throw taskToolError("tool.not_available");
    taskToolArguments(tool, input);
    if (TASK_TOOL_FEATURES[name]) {
      await getTools();
      if (!availableTools().some((item) => item.name === name)) throw taskToolError("tool.not_available");
    }
    const conversationId = client.task.conversationId;
    switch (name) {
      case "duallane_capabilities": return client.getCapabilities();
      case "duallane_get_message": return client.getMessage(input.messageId);
      case "duallane_history": return client.listHistory(conversationId, input);
      case "duallane_search_messages": return client.searchMessages(conversationId, input);
      case "duallane_list_members": return client.listMembers();
      case "duallane_query_operation": return client.getOperation(input.operation, input.key);
      case "duallane_read_attachment": {
        const resource = await client.readAttachment({ conversationId, ...input });
        return { mimeType: resource.mimeType, byteSize: resource.byteSize, encoding: "base64", data: Buffer.from(resource.bytes).toString("base64"),
          reference: { conversationId, messageId: input.messageId, attachmentId: input.attachmentId }, trust: "untrusted-attachment" };
      }
      case "duallane_send_message": {
        if (input.text === undefined && input.content === undefined) throw taskToolError("tool.invalid_arguments");
        return rememberWrite(name, input, operationId, (key) => withOperation("message.send", key,
          () => client.sendMessage({ conversationId, ...input, clientMessageId: key, idempotencyKey: key })));
      }
      case "duallane_edit_message": return rememberWrite(name, input, operationId, () => client.editMessage(input.messageId, input));
      case "duallane_send_card": return rememberWrite(name, input, operationId, (key) => withOperation("card.send", key,
        () => client.sendFeishuCard({ conversationId, card: buildAgentInteractiveCard(input), fallbackText: input.fallbackText || input.title, clientMessageId: key, idempotencyKey: key })));
      case "duallane_update_card": return rememberWrite(name, input, operationId, () => client.updateFeishuCard(input.cardId,
        { expectedRevision: input.expectedRevision, card: buildAgentInteractiveCard(input), fallbackText: input.fallbackText || input.title }));
      default: throw taskToolError("tool.not_available");
    }
  }
  async function handleJsonRpc(message) {
    const id = message?.id ?? null;
    if (!message || message.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    if (message.id === undefined && String(message.method).startsWith("notifications/")) return null;
    if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "duallane-task-tools", version: "1" } } };
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: await getTools() } };
    if (message.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {}, String(id));
      const image = /^image\/(png|jpeg|gif|webp)$/u.test(result?.mimeType || "") && result.encoding === "base64";
      const metadata = image ? { ...result, data: undefined } : result;
      return { jsonrpc: "2.0", id, result: { isError: false, structuredContent: metadata,
        content: [...(image ? [{ type: "image", mimeType: result.mimeType, data: result.data }] : []), { type: "text", text: JSON.stringify(metadata) }] } };
    } catch (error) {
      const code = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error?.code || "") ? error.code : "tool.execution_failed";
      const operation = safeAgentOperationReference(error?.operation, client.task.id);
      const attempt = ["rejected", "unknown"].includes(error?.attemptOutcome) ? { attemptOutcome: error.attemptOutcome, safeToRetry: false, retryable: error.retryable === true } : {};
      if (code === "sdk.upgrade_required") return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, retryable: false, upgrade: error.upgrade } }) }] } };
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message: "Task tool could not complete; check current authorization, coverage and budget.", ...attempt, ...(operation ? { operation } : {}) } }) }] } };
    }
  }
  return { callTool, handleJsonRpc, getTools, availableTools };
}

/** Credentials for this loopback broker belong to the trusted adapter environment. */
export async function createTaskToolBroker(client, { signal, capabilities } = {}) {
  const secret = crypto.randomBytes(32).toString("hex");
  const tools = createTaskToolServer(client, { capabilities: capabilities ?? await client.getCapabilities() });
  const connections = new Set();
  let closed = false;
  const server = http.createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (closed || request.method !== "POST" || request.url !== "/task-tools" || request.headers.host !== expectedHost || request.headers.origin || request.headers.authorization !== `Bearer ${secret}` || request.headers["content-type"] !== "application/json") {
      response.writeHead(403).end(); return;
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await tools.handleJsonRpc(message);
      if (closed || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result));
    } catch { if (response.destroyed) return; if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.requestTimeout = 35_000; server.headersTimeout = 5000;
  server.on("connection", (connection) => { connections.add(connection); connection.on("close", () => connections.delete(connection)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => {
    if (closed) return; closed = true;
    signal?.removeEventListener("abort", close);
    server.close(); for (const connection of connections) connection.destroy();
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) { close(); throw taskToolError("task.cancelled"); }
  return { descriptor: { protocol: "duallane.agent.tools", version: 1, transport: "mcp-stdio", command: "duallane-agent mcp --task",
    tools: tools.availableTools(), limits: client.budget(), scope: { conversationId: client.task.conversationId, taskId: client.task.id } },
    environment: { DUALLANE_TASK_BROKER_URL: `http://127.0.0.1:${server.address()?.port}/task-tools`, DUALLANE_TASK_BROKER_KEY: secret }, close };
}

export function createTaskBrokerMcpAdapter({ url = process.env.DUALLANE_TASK_BROKER_URL, key = process.env.DUALLANE_TASK_BROKER_KEY, fetchImpl = globalThis.fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw taskToolError("task.broker_unavailable"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/task-tools" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/u.test(key || "")) throw taskToolError("task.broker_unavailable");
  // Only this trusted stdio adapter receives the broker key. It does not pass it to an LLM.
  return { async handleJsonRpc(message) {
    if (!message || message.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    try {
      const response = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!response.ok) throw taskToolError("task.broker_unavailable");
      return await response.json();
    } catch { return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: "Task tools are unavailable" } }; }
  } };
}

// --- src/index.js ---
export const DUALLANE_AGENT_SDK_VERSION = "1.2.1";
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
    this.retryable = code !== "sdk.upgrade_required" && options.retryable === true;
    if (code === "sdk.upgrade_required" && options.upgrade) this.upgrade = options.upgrade;
    if (["rejected", "unknown"].includes(options.attemptOutcome)) this.attemptOutcome = options.attemptOutcome;
    if (options.safeToRetry === false) this.safeToRetry = false;
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
      clientVersion: input.clientVersion ?? DUALLANE_AGENT_SDK_VERSION,
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
      clientVersion: input.clientVersion ?? DUALLANE_AGENT_SDK_VERSION,
      protocolVersion: input.protocolVersion
    });
  }

  async #request(method, path, body) {
    try {
      return await requestGateway({ fetchImpl: this.#fetch, url: new URL(path, this.#origin), init: {
        method,
        headers: compact({ accept: "application/json", "x-duallane-sdk-version": DUALLANE_AGENT_SDK_VERSION, "content-type": body === undefined ? undefined : "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(compact(body))
      } });
    } catch (error) {
      throw new DualLaneAgentError(error.code || "network.unavailable", error.code === "sdk.upgrade_required" ? error.message : "DualLane Agent setup request failed", error);
    }
  }
}

export class DualLaneAgentClient {
  #origin;
  #token;
  #fetch;
  #webSocketFactory;
  #adapterVersion;
  #onUpgradeRequired;
  #heartbeatMs;
  #ackTimeoutMs;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #taskId;
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
    this.#onUpgradeRequired = typeof options.onUpgradeRequired === "function" ? options.onUpgradeRequired : () => {};
    this.#heartbeatMs = normalizeDuration(options.heartbeatMs, 20_000, 5_000, 120_000, "heartbeatMs");
    this.#ackTimeoutMs = normalizeDuration(options.ackTimeoutMs, 8_000, 1_000, 60_000, "ackTimeoutMs");
    this.#connectTimeoutMs = normalizeDuration(options.connectTimeoutMs, 10_000, 1_000, 60_000, "connectTimeoutMs");
    this.#requestTimeoutMs = normalizeDuration(options.requestTimeoutMs, 35_000, 1, 120_000, "requestTimeoutMs");
    this.#taskId = options.taskId === undefined ? null : normalizeId(options.taskId, "taskId");
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
    try { await this.#open(); } catch (error) { this.stop(); throw error; }
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
    if (socket && socket.readyState < 2) socket.close(1000, "client stopped");
    this.#callbacks.onStatus?.({ status: "stopped", lastSequence: this.#lastSequence });
  }

  async getMe() {
    return this.#request("GET", "/api/bot-gateway/v1/me");
  }

  async getCapabilities(conversationId, options = {}) {
    const query = conversationId ? `?conversationId=${encodeURIComponent(normalizeId(conversationId, "conversationId"))}` : "";
    return this.#request("GET", `/api/bot/v2/capabilities${query}`, undefined, options);
  }

  async createTask(input = {}, options = {}) {
    return this.#request("POST", "/api/bot/v2/tasks", { eventId: normalizeId(input.eventId, "eventId") }, options);
  }

  async getTask(taskId, options = {}) {
    return this.#request("GET", `/api/bot/v2/tasks/${encodeURIComponent(normalizeId(taskId, "taskId"))}`, undefined, options);
  }

  async cancelAgentTask(taskId, options = {}) {
    return this.#request("DELETE", `/api/bot/v2/tasks/${encodeURIComponent(normalizeId(taskId, "taskId"))}`, undefined, options);
  }

  async getOperation(taskId, operation, key, options = {}) {
    const values = [taskId, operation, key].map((value) => encodeURIComponent(normalizeId(value, "operation reference")));
    return this.#request("GET", `/api/bot/v2/tasks/${values[0]}/operations/${values[1]}/${values[2]}`, undefined, options);
  }

  forTask(task, options = {}) {
    const credentialed = new DualLaneAgentClient({ url: this.#origin, token: this.#token, fetch: this.#fetch,
      webSocketFactory: this.#webSocketFactory, adapterVersion: this.#adapterVersion,
      requestTimeoutMs: this.#requestTimeoutMs, taskId: task.id, onUpgradeRequired: this.#onUpgradeRequired });
    return createTaskScopedClient(credentialed, task, options);
  }

  async getMessage(messageId, options = {}) {
    const query = options.conversationId ? `?conversationId=${encodeURIComponent(normalizeId(options.conversationId, "conversationId"))}` : "";
    return this.#request("GET", `/api/bot/v2/messages/${encodeURIComponent(normalizeId(messageId, "messageId"))}${query}`, undefined, options);
  }

  async listHistory(conversationId, options = {}) {
    const query = new URLSearchParams();
    for (const name of ["before", "query", "authorId", "startTime", "endTime"]) {
      if (options[name] !== undefined) {
        const value = options[name] instanceof Date && ["startTime", "endTime"].includes(name) ? options[name].toISOString() : String(options[name]);
        if (!value || value.length > 4096) throw new TypeError(`${name} is invalid`);
        query.set(name, value);
      }
    }
    if (options.limit !== undefined) query.set("limit", String(normalizeLimit(options.limit)));
    return this.#request("GET", `/api/bot/v2/conversations/${encodeURIComponent(normalizeId(conversationId, "conversationId"))}/messages?${query}`, undefined, options);
  }

  async searchMessages(conversationId, options = {}) {
    if (typeof options.query !== "string" || !options.query.trim()) throw new TypeError("query is required");
    return this.listHistory(conversationId, options);
  }

  async listMembers(conversationId, options = {}) {
    return this.#request("GET", `/api/bot/v2/conversations/${encodeURIComponent(normalizeId(conversationId, "conversationId"))}/members`, undefined, options);
  }

  async getContext(conversationId, options = {}) {
    const id = normalizeId(conversationId, "conversationId");
    const query = options.limit === undefined ? "" : `?limit=${normalizeLimit(options.limit)}`;
    return this.#request("GET", `/api/bot-gateway/v1/conversations/${encodeURIComponent(id)}/context${query}`, undefined, options);
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
    return this.#taskOperation("message.send", idempotencyKey, () => this.#request("POST", "/api/bot-gateway/v1/messages", compact({
      conversationId,
      clientMessageId,
      idempotencyKey,
      text: input.text,
      content: input.content === undefined ? undefined : buildMessageContent(input.content),
      replyToMessageId: input.replyToMessageId
    }), { signal: input.signal }));
  }

  async sendCard(input = {}) {
    const conversationId = normalizeId(input.conversationId, "conversationId");
    const clientMessageId = normalizeId(input.clientMessageId ?? createClientId("cardmsg"), "clientMessageId");
    const idempotencyKey = normalizeId(input.idempotencyKey ?? clientMessageId, "idempotencyKey");
    return this.#taskOperation("card.send", idempotencyKey, () => this.#request("POST", "/api/bot-gateway/v1/cards", compact({
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
    }), { signal: input.signal }));
  }

  async sendFeishuCard(input = {}) {
    if (!input.card || typeof input.card !== "object" || Array.isArray(input.card)) throw new TypeError("card is required");
    return this.sendCard({ ...input, format: "feishu-card", feishuCard: input.card, card: undefined });
  }

  async updateCard(cardId, input = {}) {
    const { signal, ...body } = input;
    const id = normalizeId(cardId, "cardId");
    const key = "card_" + crypto.createHash("sha256").update(`${id}:${body.expectedRevision}`).digest("hex");
    return this.#taskOperation("card.update", key, () => this.#request("PATCH", `/api/bot-gateway/v1/cards/${encodeURIComponent(id)}`, compact(body), { signal }));
  }

  async updateFeishuCard(cardId, input = {}) {
    if (!input.card || typeof input.card !== "object" || Array.isArray(input.card)) throw new TypeError("card is required");
    return this.updateCard(cardId, compact({
      expectedRevision: input.expectedRevision,
      signal: input.signal,
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

  async editMessage(messageId, input, options = {}) {
    const id = normalizeId(messageId, "messageId");
    const update = typeof input === "string" ? { plainText: input.trim(), expectedVersion: options.expectedVersion } : input;
    if (!update || typeof update !== "object" || Array.isArray(update)) throw new TypeError("message update is required");
    const body = compact({ plainText: update.plainText, content: update.content === undefined ? undefined : buildMessageContent(update.content), expectedVersion: update.expectedVersion });
    if ((body.plainText === undefined || body.plainText === "") && body.content === undefined) throw new TypeError("plainText or content is required");
    if (body.plainText !== undefined && (typeof body.plainText !== "string" || body.plainText.length > 30_000)) throw new TypeError("plainText is invalid");
    if (this.#taskId) {
      if (body.expectedVersion === undefined) body.expectedVersion = (await this.getMessage(id, { signal: options.signal }))?.message?.version;
      if (!/^[a-f0-9]{64}$/u.test(body.expectedVersion || "")) throw new DualLaneAgentError("message.version_required", "A current message version is required");
    } else if (body.content !== undefined || body.expectedVersion !== undefined) {
      throw new DualLaneAgentError("task.context_required", "Conditional or structured edits require a task client");
    }
    const key = "edit_" + crypto.createHash("sha256").update(`${id}:${body.expectedVersion}`).digest("hex");
    return this.#taskOperation("message.edit", key, () => this.#request("PATCH", `/api/bot/v2/messages/${encodeURIComponent(id)}`, body, options));
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
      mimeType,
      { signal: input.signal }
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
    }, { signal: input.signal });
  }

  async getUploadStatus(uploadId, options = {}) {
    return this.#request("GET", `/api/bot/v2/uploads/${encodeURIComponent(normalizeId(uploadId, "uploadId"))}`, undefined, options);
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

  async completeUploadContent(uploadId, rawBytes, mimeType = "application/octet-stream", options = {}) {
    const id = normalizeId(uploadId, "uploadId");
    rawBytes = normalizeFileBytes(rawBytes, { allowText: false });
    return this.#requestBinary(
      "PUT",
      `/api/bot/v2/uploads/${encodeURIComponent(id)}/content`,
      rawBytes,
      mimeType,
      options
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

  async #taskOperation(operation, key, execute) {
    const reference = this.#taskId ? { taskId: this.#taskId, operation, key } : undefined;
    try {
      const result = await execute();
      return reference ? { ...result, operation: reference } : result;
    } catch (error) {
      if (operation === "card.send" || operation === "card.update") {
        // A rejected attempt does not prove that another request using this key
        // never committed. Neither outcome authorizes blind re-submission.
        error.attemptOutcome ??= "unknown";
        error.safeToRetry = false;
      }
      if (reference) error.operation = reference;
      throw error;
    }
  }

  async #request(method, path, body, options = {}) {
    return this.#gatewayRequest(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      ...options,
    });
  }

  async #requestBinary(method, path, rawBytes, contentType = "application/octet-stream", options = {}) {
    return this.#gatewayRequest(method, path, { body: rawBytes, contentType, byteSize: rawBytes.byteLength, ...options });
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
            "x-duallane-sdk-version": DUALLANE_AGENT_SDK_VERSION,
            "x-duallane-task": this.#taskId || undefined,
          }),
          body: options.body,
        },
      });
    } catch (error) {
      const safe = new DualLaneAgentError(error.code || "network.unavailable", error.code === "sdk.upgrade_required" ? error.message : "DualLane Agent Gateway request failed", {
        statusCode: error.statusCode,
        retryable: error.retryable === true,
        upgrade: error.upgrade,
        attemptOutcome: error.attemptOutcome,
        safeToRetry: error.safeToRetry,
      });
      if (safe.code === "sdk.upgrade_required") {
        this.stop();
        try { this.#onUpgradeRequired(safe); } catch { /* Observability cannot restart incompatible SDKs. */ }
      }
      throw safe;
    }
  }

  async #open() {
    const generation = ++this.#generation;
    this.#callbacks.onStatus?.({ status: this.#attempt ? "reconnecting" : "connecting", attempt: this.#attempt, lastSequence: this.#lastSequence });
    // Browser WebSocket cannot attach Bot Authorization. Adapters must preserve
    // both handshake headers; this preflight never replaces the WS server gate.
    await this.getMe();
    if (this.#stopped || generation !== this.#generation) throw new DualLaneAgentError("sdk.aborted", "DualLane Agent connection was aborted");
    const socketUrl = new URL("/ws/bot-gateway", this.#origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = await this.#webSocketFactory(socketUrl.toString(), {
        headers: {
          authorization: `Bearer ${this.#token}`,
          "x-duallane-sdk-version": DUALLANE_AGENT_SDK_VERSION,
          "x-duallane-adapter-version": this.#adapterVersion
        }
      });
    } catch (error) {
      if (error?.code === "sdk.upgrade_required") throw new DualLaneAgentError(error.code, "DualLane Agent SDK upgrade required", { statusCode: 426, upgrade: sdkUpgradeInfo(error.upgrade, this.#origin) });
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
          const code = safeErrorCode(frame.error?.code, "gateway.error");
          const error = this.#reportError(new DualLaneAgentError(code, code === "sdk.upgrade_required" ? "DualLane Agent SDK upgrade required" : redactToken(safeErrorText(frame.error?.message, "DualLane Agent Gateway error"), this.#token), { upgrade: code === "sdk.upgrade_required" ? sdkUpgradeInfo(frame.error, this.#origin) : undefined }));
          if (code === "sdk.upgrade_required") { clearTimeout(timeout); this.stop(); reject(error); }
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
      bindSocket(socket, "error", (error) => {
        if (error?.code === "sdk.upgrade_required") {
          const safe = this.#reportError(new DualLaneAgentError(error.code, "DualLane Agent SDK upgrade required", { statusCode: 426, upgrade: sdkUpgradeInfo(error.upgrade, this.#origin) }));
          clearTimeout(timeout); this.stop(); reject(safe);
        } else this.#reportError(new DualLaneAgentError("gateway.socket_error", "DualLane Agent Gateway socket error", { retryable: true }));
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
        if (error?.code === "sdk.upgrade_required") this.stop();
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
      ? new DualLaneAgentError(safeErrorCode(error.code, "gateway.error"), redactToken(error.message, this.#token), { statusCode: error.statusCode, retryable: error.retryable, upgrade: error.upgrade })
      : new DualLaneAgentError("sdk.callback_failed", "DualLane Agent callback failed");
    try { this.#callbacks.onError?.(safe); } catch { /* callbacks cannot break transport */ }
    if (safe.code === "sdk.upgrade_required") {
      this.stop();
      try { this.#onUpgradeRequired(safe); } catch { /* Compatibility failures remain terminal. */ }
    }
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

// --- src/media.js ---
const MEDIA_MIB = 1024 * 1024;
const MEDIA_HARD_MAX_BYTES = 50 * MEDIA_MIB;
const MEDIA_REMOTE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain",
]);
const MEDIA_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"],
  ["application/pdf", "pdf"], ["image/svg+xml", "svg"], ["text/plain", "txt"],
  ["text/markdown", "md"], ["text/csv", "csv"], ["text/html", "html"], ["text/css", "css"],
  ["text/javascript", "js"], ["application/javascript", "js"], ["text/xml", "xml"],
  ["application/xml", "xml"], ["application/json", "json"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
]);
const MEDIA_OFFICE_PARTS = new Map([
  ["docx", "word/document.xml"], ["xlsx", "xl/workbook.xml"], ["pptx", "ppt/presentation.xml"],
]);
const MEDIA_ERROR_MESSAGES = {
  "media.disabled": "Public media retrieval is not enabled.",
  "media.invalid_options": "Media retrieval limits are invalid.",
  "media.invalid_url": "The media URL is invalid.",
  "media.destination_denied": "The media destination is not permitted.",
  "media.dns_failed": "The media destination could not be resolved.",
  "media.network": "The media connection failed.",
  "media.timeout": "Media retrieval timed out.",
  "media.cancelled": "Media retrieval was cancelled.",
  "media.redirect_limit": "The media redirect limit was reached.",
  "media.response_invalid": "The media response is invalid.",
  "media.http_error": "The media server refused the request.",
  "media.encoding_unsupported": "Compressed media responses are not supported.",
  "media.too_large": "The media exceeds the byte limit.",
  "artifact.invalid_bytes": "The artifact must contain non-empty bytes.",
  "artifact.too_large": "The artifact exceeds the byte limit.",
  "artifact.unsupported_type": "The artifact format is not supported.",
  "artifact.type_mismatch": "The artifact bytes do not match the declared format.",
};

export class MediaPolicyError extends Error {
  constructor(code, options = {}) {
    super(MEDIA_ERROR_MESSAGES[code] || "Media validation failed.");
    this.name = "MediaPolicyError";
    this.code = Object.hasOwn(MEDIA_ERROR_MESSAGES, code) ? code : "media.response_invalid";
    this.retryable = options.retryable === true;
    if (Number.isInteger(options.status)) this.status = options.status;
  }
}

function mediaLimit(value, fallback, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new MediaPolicyError("media.invalid_options");
  }
  return result;
}

function mediaUtf8(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function mediaSvgPrefix(text) {
  let offset = 0;
  // Match the existing whitespace/XML-declaration prefix without a repeated
  // regexp group whose stack grows with a large, otherwise valid SVG input.
  while (offset < text.length) {
    while (offset < text.length && /\s/u.test(text[offset])) offset += 1;
    if (!text.startsWith("<?xml", offset)) break;
    const end = text.indexOf("?", offset + 5);
    if (end < 0 || text[end + 1] !== ">") return false;
    offset = end + 2;
  }
  return text.startsWith("<svg", offset) && (text[offset + 4] === ">" || /\s/u.test(text[offset + 4] || ""));
}

// This validates the bounded container envelope, not document safety or content.
// No entry is decompressed, rendered, followed, or executed by the SDK.
function mediaOfficeEnvelope(bytes, extension) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return false;
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (count < 2 || count > 2048 || bytes.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) return false;
  const names = new Set();
  const ranges = [];
  let offset = centralStart;
  let expanded = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const local = bytes.readUInt32LE(offset + 42);
    if (entryEnd > end || nameLength < 1 || nameLength > 1024 || flags & 0x41 || ![0, 8].includes(method) ||
        (method === 0 && compressed !== size) ||
        bytes.readUInt16LE(offset + 34) !== 0 || (mode & 0xf000) === 0xa000) return false;
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = mediaUtf8(nameBytes);
    if (!name || name.startsWith("/") || /[\\:\u0000]/u.test(name) ||
        name.split("/").some((part) => part === "." || part === "..") || names.has(name)) return false;
    expanded += size;
    if (expanded > MEDIA_HARD_MAX_BYTES || compressed > MEDIA_HARD_MAX_BYTES ||
        size === 0xffffffff || local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50) return false;
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > centralStart || localNameLength !== nameLength ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
        !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) return false;
    if (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) return false;
    ranges.push([local, dataStart + compressed]);
    names.add(name);
    offset = entryEnd;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) return false;
  return offset === end && names.has("[Content_Types].xml") && names.has(MEDIA_OFFICE_PARTS.get(extension));
}

/** Validate an opaque artifact envelope; this does not render or sanitize documents. */
export function validateArtifactBytes(rawBytes, declaredMimeType, options = {}) {
  const maxBytes = mediaLimit(options.maxBytes, 25 * MEDIA_MIB, MEDIA_HARD_MAX_BYTES);
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength === 0) {
    throw new MediaPolicyError("artifact.invalid_bytes");
  }
  if (rawBytes.byteLength > maxBytes) throw new MediaPolicyError("artifact.too_large");
  const bytes = Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const mimeType = String(declaredMimeType || "").split(";", 1)[0].trim().toLowerCase();
  const extension = MEDIA_EXTENSIONS.get(mimeType);
  if (!extension || (options.source === "https" && !MEDIA_REMOTE_TYPES.has(mimeType))) {
    throw new MediaPolicyError("artifact.unsupported_type");
  }
  let matches = false;
  if (mimeType === "image/png") {
    matches = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  } else if (mimeType === "image/jpeg") {
    matches = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  } else if (mimeType === "image/gif") {
    matches = bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b;
  } else if (mimeType === "image/webp") {
    matches = bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
  } else if (mimeType === "application/pdf") {
    matches = bytes.length >= 14 && /^%PDF-[12]\.\d/u.test(bytes.toString("ascii", 0, 8)) &&
      /%%EOF\s*$/u.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("ascii"));
  } else if (MEDIA_OFFICE_PARTS.has(extension)) {
    matches = mediaOfficeEnvelope(bytes, extension);
  } else {
    const text = mediaUtf8(bytes);
    matches = text !== null;
    if (matches && mimeType === "image/svg+xml") matches = mediaSvgPrefix(text);
    if (matches && mimeType === "application/json") {
      try { JSON.parse(text); } catch { matches = false; }
    }
    if (matches && options.source === "https") {
      // A remote HTML error/login page is not a text attachment.
      matches = !/^\s*(?:<!doctype\s+html|<html|<script|<svg|<\?xml)/iu.test(text);
    }
  }
  if (!matches) throw new MediaPolicyError("artifact.type_mismatch");
  return { mimeType, byteSize: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), extension };
}

function mediaIpv4Public(address) {
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function mediaIpv6Words(address) {
  if (address.includes(".") || address.includes("%")) return null;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].map((part) => parseInt(part, 16));
}

function mediaPublicAddress(address) {
  if (typeof address !== "string" || address.length > 64) return false;
  const family = net.isIP(address);
  if (family === 4) return mediaIpv4Public(address);
  if (family !== 6) return false;
  const words = mediaIpv6Words(address);
  // Only ordinary global unicast, excluding protocol, transition and documentation ranges.
  // This deliberately rejects mapped/NAT64/6to4/Teredo even when their embedded IPv4 is public.
  return words !== null && (words[0] & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && words[1] < 0x200) &&
    !(words[0] === 0x2001 && words[1] === 0xdb8) && words[0] !== 0x2002 &&
    !(words[0] === 0x3fff && (words[1] & 0xf000) === 0);
}

function mediaDestination(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new MediaPolicyError("media.invalid_url"); }
  if (typeof rawUrl !== "string" || rawUrl.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(rawUrl)) {
    throw new MediaPolicyError("media.invalid_url");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new MediaPolicyError("media.destination_denied");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (!hostname || hostname.endsWith(".") || (!net.isIP(hostname) && !hostname.includes("."))) {
    throw new MediaPolicyError("media.destination_denied");
  }
  url.hash = "";
  return { url, hostname };
}

function mediaAbortError(signal) {
  return signal.reason instanceof MediaPolicyError ? signal.reason : new MediaPolicyError("media.cancelled");
}

function mediaAwaitSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(mediaAbortError(signal));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function mediaResolveAddress(hostname, signal, resolver) {
  if (signal.aborted) throw mediaAbortError(signal);
  let addresses;
  try {
    const family = net.isIP(hostname);
    if (family) {
      addresses = [{ address: hostname, family }];
    } else if (resolver) {
      const resolveFamily = async (version) => {
        try {
          const records = await (version === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname));
          return records.map((address) => ({ address, family: version }));
        } catch (error) {
          if (["ENODATA", "ENOTFOUND"].includes(error.code)) return [];
          throw error;
        }
      };
      addresses = (await mediaAwaitSignal(Promise.all([resolveFamily(4), resolveFamily(6)]), signal)).flat();
    } else {
      addresses = await mediaAwaitSignal(dns.lookup(hostname, { all: true, verbatim: true }), signal);
    }
  } catch (error) {
    if (signal.aborted) throw mediaAbortError(signal);
    if (error instanceof MediaPolicyError) throw error;
    throw new MediaPolicyError("media.dns_failed", { retryable: true });
  }
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 ||
      addresses.some((entry) => !mediaPublicAddress(entry.address) || net.isIP(entry.address) !== entry.family)) {
    throw new MediaPolicyError("media.destination_denied");
  }
  return addresses[0];
}

function mediaSameAddress(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual === expected) return true;
  if (net.isIP(expected) === 4 && actual === `::ffff:${expected}`) return true;
  return net.isIP(actual) === 6 && net.isIP(expected) === 6 &&
    String(mediaIpv6Words(actual)) === String(mediaIpv6Words(expected));
}

function mediaRequest(destination, pinned, limits, signal) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    let secure = false;
    let connectionTimer;
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(result);
      response?.destroy();
      request?.destroy();
      agent.destroy();
    };
    const onAbort = () => finish(mediaAbortError(signal));
    if (signal.aborted) return finish(mediaAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      request = https.request(destination.url, {
        method: "GET", agent, rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        family: pinned.family,
        lookup: (_hostname, opts, callback) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        headers: {
          Accept: [...MEDIA_REMOTE_TYPES].join(", "),
          "Accept-Encoding": "identity",
          "User-Agent": "DualLane-Media/1",
        },
      }, (incoming) => {
        response = incoming;
        incoming.on("error", () => finish(new MediaPolicyError("media.network", { retryable: true })));
        if (settled) return incoming.destroy();
        if (!secure || !mediaSameAddress(incoming.socket?.remoteAddress, pinned.address)) {
          return finish(new MediaPolicyError("media.destination_denied"));
        }
        const status = incoming.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location;
          if (typeof location !== "string" || !location) return finish(new MediaPolicyError("media.response_invalid"));
          return finish(null, { redirect: location });
        }
        if (status !== 200) return finish(new MediaPolicyError("media.http_error", { status, retryable: status >= 500 || status === 429 }));
        const encoding = incoming.headers["content-encoding"];
        if (encoding && String(encoding).toLowerCase() !== "identity") return finish(new MediaPolicyError("media.encoding_unsupported"));
        const type = incoming.headers["content-type"];
        if (typeof type !== "string" || !MEDIA_REMOTE_TYPES.has(type.split(";", 1)[0].trim().toLowerCase())) {
          return finish(new MediaPolicyError("artifact.unsupported_type"));
        }
        const lengthHeader = incoming.headers["content-length"];
        let declaredLength;
        if (lengthHeader !== undefined) {
          if (typeof lengthHeader !== "string" || !/^\d+$/u.test(lengthHeader)) return finish(new MediaPolicyError("media.response_invalid"));
          declaredLength = Number(lengthHeader);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > limits.maxBytes) return finish(new MediaPolicyError("media.too_large"));
        }
        const chunks = [];
        let received = 0;
        incoming.on("data", (chunk) => {
          if (settled) return;
          if (!(chunk instanceof Uint8Array)) return finish(new MediaPolicyError("media.response_invalid"));
          received += chunk.byteLength;
          if (received > limits.maxBytes) return finish(new MediaPolicyError("media.too_large"));
          chunks.push(chunk);
        });
        incoming.on("aborted", () => finish(new MediaPolicyError("media.network", { retryable: true })));
        incoming.on("end", () => {
          if (settled) return;
          if (incoming.complete !== true || (declaredLength !== undefined && received !== declaredLength)) {
            return finish(new MediaPolicyError("media.response_invalid"));
          }
          finish(null, { bytes: Buffer.concat(chunks, received), mimeType: type });
        });
      });
      request.on("socket", (socket) => {
        socket.once("secureConnect", () => {
          if (!socket.authorized || !mediaSameAddress(socket.remoteAddress, pinned.address)) {
            return finish(new MediaPolicyError("media.destination_denied"));
          }
          secure = true;
          clearTimeout(connectionTimer);
        });
      });
      request.on("error", () => finish(new MediaPolicyError("media.network", { retryable: true })));
      connectionTimer = setTimeout(() => finish(new MediaPolicyError("media.timeout", { retryable: true })), limits.connectTimeoutMs);
      request.end();
    } catch {
      finish(new MediaPolicyError("media.network", { retryable: true }));
    }
  });
}

/** Retrieve public media with no ambient credentials, proxy, or caller-supplied headers. */
export async function fetchPublicMedia(rawUrl, options = {}) {
  if (options.enabled !== true) throw new MediaPolicyError("media.disabled");
  const limits = {
    maxBytes: mediaLimit(options.maxBytes, 10 * MEDIA_MIB, MEDIA_HARD_MAX_BYTES),
    timeoutMs: mediaLimit(options.timeoutMs, 15000, 60000),
    connectTimeoutMs: mediaLimit(options.connectTimeoutMs, 5000, 15000),
    maxRedirects: options.maxRedirects === undefined ? 3 : options.maxRedirects,
  };
  if (!Number.isInteger(limits.maxRedirects) || limits.maxRedirects < 0 || limits.maxRedirects > 3 ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new MediaPolicyError("media.invalid_options");
  }
  let resolver;
  if (options.dnsServers !== undefined) {
    if (!Array.isArray(options.dnsServers) || options.dnsServers.length < 1 || options.dnsServers.length > 3 ||
        options.dnsServers.some((server) => typeof server !== "string" || !mediaPublicAddress(server))) {
      throw new MediaPolicyError("media.invalid_options");
    }
    // This is operator configuration, not an input from a bridge result or chat.
    // A separate resolver prevents changing the process-global DNS configuration.
    try {
      resolver = new dns.Resolver({ timeout: Math.min(limits.timeoutMs, limits.connectTimeoutMs), tries: 1 });
      resolver.setServers([...options.dnsServers]);
    } catch {
      throw new MediaPolicyError("media.invalid_options");
    }
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new MediaPolicyError("media.cancelled"));
  const onResolverAbort = () => resolver?.cancel();
  controller.signal.addEventListener("abort", onResolverAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new MediaPolicyError("media.timeout", { retryable: true })), limits.timeoutMs);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  try {
    let destination = mediaDestination(rawUrl);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const pinned = await mediaResolveAddress(destination.hostname, controller.signal, resolver);
      const result = await mediaRequest(destination, pinned, limits, controller.signal);
      if (result.redirect !== undefined) {
        if (redirectCount >= limits.maxRedirects) throw new MediaPolicyError("media.redirect_limit");
        let next;
        try { next = new URL(result.redirect, destination.url).href; } catch { throw new MediaPolicyError("media.invalid_url"); }
        if (/[\u0000-\u0020\u007f\\]/u.test(result.redirect)) throw new MediaPolicyError("media.invalid_url");
        destination = mediaDestination(next);
        continue;
      }
      const verified = validateArtifactBytes(result.bytes, result.mimeType, { maxBytes: limits.maxBytes, source: "https" });
      return {
        bytes: result.bytes, mimeType: verified.mimeType,
        fileName: `media.${verified.extension}`, byteSize: verified.byteSize, sha256: verified.sha256,
        source: { kind: "https", origin: destination.url.origin, redirectCount },
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    controller.signal.removeEventListener("abort", onResolverAbort);
    resolver?.cancel();
  }
}

// --- src/inbound.js ---
// Only the trigger's logical references enter the model input; history and
// generated local paths do not implicitly authorize another download.
export async function prepareAgentInputs({ client, event, triggerMessage, context, conversation, scopes = [], signal }) {
  const conversationId = event?.conversationId;
  const messageId = triggerMessage?.id;
  if (!conversationId || !messageId || (conversation?.id && conversation.id !== conversationId)) return [];
  const authorized = context?.messages?.find((message) => message.id === messageId);
  if (!authorized) return [];
  const blocks = Array.isArray(authorized.content?.blocks) ? authorized.content.blocks : [];
  const ids = [...new Set(blocks.filter((block) => block.type === "attachment").map((block) => block.attachmentId).filter((id) => typeof id === "string"))];
  if (ids.length > 6) throw Object.assign(new Error("Too many input attachments"), { code: "input.attachment_limit" });
  const canRead = scopes.includes("messages:read_context") && scopes.includes("files:read_content");
  const canPreview = scopes.includes("messages:read_context") && scopes.includes("files:read_preview");
  let remaining = 10 * 1024 * 1024;
  const inputs = [];
  for (const attachmentId of ids) {
    const reference = { attachmentId, messageId, conversationId };
    if (!canRead && !canPreview) {
      inputs.push({ ...reference, status: "unavailable", code: "input.attachment_scope_required" });
      continue;
    }
    if (remaining <= 0) throw Object.assign(new Error("Input attachments exceed the byte limit"), { code: "input.attachment_limit" });
    try {
      const mode = canRead ? "content" : "preview";
      const result = await client.readAttachment({ ...reference, mode, maxBytes: Math.min(remaining, mode === "preview" ? 64 * 1024 : remaining), signal });
      const available = remaining;
      remaining -= result.bytes.byteLength;
      // A currently authorized DL attachment is distinct from an arbitrary
      // public URL. Validate its opaque envelope without rendering/executing it.
      const checked = validateArtifactBytes(result.bytes, result.mimeType, { source: "inline", maxBytes: available });
      const textInput = checked.mimeType.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(checked.mimeType);
      inputs.push({
        ...reference,
        status: "available",
        kind: checked.mimeType.startsWith("image/") ? "image" : textInput ? "text" : "document",
        mimeType: checked.mimeType,
        byteSize: result.bytes.byteLength,
        encoding: textInput ? "utf8" : "base64",
        data: Buffer.from(result.bytes).toString(textInput ? "utf8" : "base64"),
        trust: "untrusted-attachment",
      });
    } catch (error) {
      if (error?.code === "sdk.aborted") throw error;
      if (error?.code === "gateway.response_too_large") remaining = 0;
      const code = typeof error?.code === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/u.test(error.code) ? error.code : "input.attachment_unavailable";
      inputs.push({ ...reference, status: "unavailable", code });
    }
  }
  return inputs;
}

// --- src/bridge-protocol.js ---
export const AGENT_BRIDGE_PROTOCOL_VERSION = 1;
export const AGENT_MAX_RESULT_BYTES = 70 * 1024 * 1024;
const BRIDGE_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const BRIDGE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class AgentRuntimeError extends Error {
  constructor(code, { retryable = false, stage = "running" } = {}) {
    super(code);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.stage = stage;
  }
}

export function safeAgentError(error, stage = "running") {
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_.]{1,63}$/u.test(error.code)
    ? error.code : "task.failed";
  return {
    code,
    stage,
    retryable: error?.code !== "sdk.upgrade_required" && (error?.retryable === true || [408, 429, 502, 503, 504].includes(error?.statusCode ?? error?.status)),
  };
}

function bridgeHumanMessage(message) {
  return message && ["human", "user"].includes(message.authorKind || message.senderKind || message.kind);
}

export function resolveAgentTrigger(event, context, authorization) {
  const payload = event?.payload || {};
  if (event?.type === "command.invoked") {
    if (payload.argsComplete === false) throw new AgentRuntimeError("input.trigger_truncated");
    return null;
  }
  if (event?.type === "card.action") return null;
  const explicitId = payload.messageId || payload.message?.id || event?.messageId;
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  if (explicitId) {
    const message = payload.message?.id === explicitId ? payload.message : messages.find((item) => item?.id === explicitId);
    if (!message && payload.textComplete === true && typeof payload.text === "string") {
      return { id: explicitId, authorKind: "human", plainText: payload.text };
    }
    const kind = message?.authorKind || message?.kind;
    const trustedBotTrigger = kind === "bot" && authorization?.triggerMessageId === explicitId && authorization?.conversationId === event.conversationId;
    if (!message || kind === "system" || (kind === "bot" && !trustedBotTrigger)) {
      throw new AgentRuntimeError("input.trigger_unavailable");
    }
    return structuredClone(message);
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return { id: null, authorKind: "human", plainText: payload.text };
  }
  const human = [...messages].reverse().find(bridgeHumanMessage);
  if (!human) throw new AgentRuntimeError("input.trigger_unavailable");
  return structuredClone(human);
}

export function buildAgentBridgeRequest({ taskId, event, context, conversation, capabilities = {}, inputs = [], artifacts = [], authorization }) {
  if (!conversation?.id || conversation.id !== event?.conversationId) {
    throw new AgentRuntimeError("input.conversation_mismatch");
  }
  const triggerMessage = resolveAgentTrigger(event, context, authorization);
  return {
    protocol: "duallane.agent.request",
    version: AGENT_BRIDGE_PROTOCOL_VERSION,
    taskId,
    event,
    context,
    conversation,
    triggerMessage,
    capabilities: {
      resultProtocolVersion: AGENT_BRIDGE_PROTOCOL_VERSION,
      maxArtifacts: 6,
      maxArtifactBytes: BRIDGE_MAX_ARTIFACT_BYTES,
      localPathOutput: false,
      publicMedia: false,
      ...capabilities,
    },
    inputs,
    artifacts,
  };
}

function bridgeFileName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\\/\x00-\x1f\x7f]/u.test(value) || value === "." || value === "..") {
    throw new AgentRuntimeError("artifact.invalid_name");
  }
  return value.trim();
}

function bridgeDecodeBytes(data, encoding, maxBytes) {
  if (typeof data !== "string") throw new AgentRuntimeError("artifact.invalid_data");
  if (maxBytes < 1) throw new AgentRuntimeError("artifact.too_large");
  if (encoding === "base64") {
    return decodeArtifactBase64(data, { maxBytes });
  }
  if (encoding !== "utf8") throw new AgentRuntimeError("artifact.invalid_encoding");
  if (Buffer.byteLength(data) > maxBytes) throw new AgentRuntimeError("artifact.too_large");
  return Buffer.from(data, "utf8");
}

function bridgeLegacyResult(text) {
  if (/\[\[DUALLANE_FILE:/u.test(text)) throw new AgentRuntimeError("artifact.local_path_denied");
  const artifacts = [];
  const cleanText = text.replace(/<duallane-file\s+([^>]*)>([\s\S]*?)<\/duallane-file>/giu, (_full, attrs, inner) => {
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(attrs)?.[1];
    const fileName = attr("name") || "generated.txt";
    artifacts.push({ id: `legacy-${artifacts.length + 1}`, source: "inline", fileName,
      mimeType: attr("mime") || inferMimeTypeFromFileName(fileName),
      encoding: attr("encoding") || "utf8", data: inner.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "") });
    return "";
  }).replace(/\n{3,}/gu, "\n\n").trim();
  return { protocol: "duallane.agent.result", version: 1, status: "completed", text: cleanText, artifacts };
}

export function parseAgentBridgeResult(raw, { taskId, validateBytes } = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > AGENT_MAX_RESULT_BYTES) throw new AgentRuntimeError("bridge.output_limit");
  let result;
  try { result = JSON.parse(raw); } catch { /* Plain stdout is a supported compatibility format. */ }
  if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "protocol")) result = bridgeLegacyResult(raw);
  if (result.protocol !== "duallane.agent.result" || result.version !== 1) throw new AgentRuntimeError("bridge.protocol_unsupported");
  if (result.taskId !== undefined && result.taskId !== taskId) throw new AgentRuntimeError("bridge.task_mismatch");
  if (result.status !== "completed") throw new AgentRuntimeError(result.status === "cancelled" ? "bridge.cancelled" : "bridge.incomplete");
  const content = result.content === undefined ? undefined : buildMessageContent(result.content);
  if (result.text === undefined && content) result.text = content.plainText;
  if (typeof result.text !== "string" || result.text.length > 28_000) throw new AgentRuntimeError("bridge.invalid_text");
  if (result.artifacts === undefined) result.artifacts = [];
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 6) throw new AgentRuntimeError("artifact.count_limit");
  const seen = new Set(); let totalBytes = 0;
  const artifacts = result.artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(artifact.id) || seen.has(artifact.id)) {
      throw new AgentRuntimeError("artifact.invalid_id");
    }
    seen.add(artifact.id);
    if (artifact.source === "artifact") {
      if (typeof artifact.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.artifactId)) throw new AgentRuntimeError("artifact.invalid_reference");
      return { id: artifact.id, source: "artifact", artifactId: artifact.artifactId };
    }
    if (artifact.source === "https") {
      if (typeof artifact.url !== "string" || artifact.url.length > 4096) throw new AgentRuntimeError("media.invalid_url");
      return { id: artifact.id, source: "https", url: artifact.url,
        ...(artifact.fileName !== undefined ? { fileName: bridgeFileName(artifact.fileName) } : {}) };
    }
    if (artifact.source !== "inline") throw new AgentRuntimeError("artifact.source_unsupported");
    const fileName = bridgeFileName(artifact.fileName);
    const mimeType = String(artifact.mimeType || inferMimeTypeFromFileName(fileName)).toLowerCase();
    const bytes = bridgeDecodeBytes(artifact.data, artifact.encoding, Math.min(BRIDGE_MAX_ARTIFACT_BYTES, BRIDGE_MAX_TOTAL_BYTES - totalBytes));
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > BRIDGE_MAX_ARTIFACT_BYTES || totalBytes > BRIDGE_MAX_TOTAL_BYTES) throw new AgentRuntimeError("artifact.too_large");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (artifact.byteSize !== undefined && artifact.byteSize !== bytes.length) throw new AgentRuntimeError("artifact.size_mismatch");
    if (artifact.sha256 !== undefined && artifact.sha256 !== sha256) throw new AgentRuntimeError("artifact.digest_mismatch");
    validateBytes?.(bytes, mimeType);
    return { id: artifact.id, source: "inline", fileName, mimeType, bytes, sha256 };
  });
  if (!result.text.trim() && !artifacts.length) throw new AgentRuntimeError("bridge.empty_result");
  return { text: result.text.trim(), artifacts, ...(content ? { content } : {}) };
}

// --- src/task-runtime.js ---
const TASK_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const TASK_FILE_LIMIT = 16 * 1024 * 1024;
const taskDigest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const taskCheckCancelled = (signal) => { if (signal?.aborted) throw new AgentRuntimeError("task.cancelled"); };

function taskStartThinking(client, conversationId, signal) {
  if (typeof client.setTyping !== "function" || signal.aborted) return () => {};
  const request = new AbortController();
  let stopped = false, pending = false;
  const renew = () => {
    if (stopped || pending || signal.aborted) return;
    pending = true;
    // This six-second server lease is advisory; a failed heartbeat cannot fail
    // a business task or accumulate overlapping requests on a slow gateway.
    Promise.resolve().then(() => {
      if (!stopped) return client.setTyping(conversationId, { state: "thinking", signal: request.signal, timeoutMs: 3000 });
    }).catch(() => {}).finally(() => { pending = false; });
  };
  const timer = setInterval(renew, 3800);
  timer.unref?.();
  const stop = () => {
    stopped = true; clearInterval(timer); request.abort();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  renew();
  return stop;
}

function taskPrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  let cursor = path.parse(resolved).root;
  for (const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentRuntimeError("runtime.unsafe_state_path");
  }
  if (process.platform !== "win32" && (fs.statSync(resolved).mode & 0o077) !== 0) throw new AgentRuntimeError("runtime.state_permissions");
  return resolved;
}

function taskReadFile(file, maxBytes = TASK_FILE_LIMIT) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new AgentRuntimeError("runtime.unsafe_state_file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new AgentRuntimeError("runtime.state_permissions");
  return fs.readFileSync(file);
}

function taskAtomicWrite(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (fs.existsSync(file)) taskReadFile(file);
    fs.renameSync(temporary, file);
    // Persist the rename where directory fsync is supported.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function taskIdentity(origin, botId) {
  const base = new URL(origin);
  if (base.username || base.password || !["https:", "http:"].includes(base.protocol) || typeof botId !== "string" || !botId.trim()) throw new AgentRuntimeError("runtime.invalid_identity");
  return taskDigest(`${base.origin}\n${botId}`);
}

function taskEventFingerprint(event) {
  const messageId = event.payload?.messageId || event.payload?.message?.id || event.messageId;
  // Replay reprojects current authorized text. An edit does not create a new
  // event or replace an already accepted task's input and publication receipts.
  const identity = event.type === "message.created" && typeof messageId === "string" && messageId
    ? { messageId } : event.payload || null;
  return taskDigest(JSON.stringify([event.type, event.conversationId, identity]));
}

function taskOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function acquireTaskOwner(directory) {
  const lock = path.join(directory, "owner.json");
  const gate = path.join(directory, "owner-acquisition");
  const recovery = path.join(directory, "owner-recovery");
  if (fs.existsSync(recovery)) throw new AgentRuntimeError("runtime.owner_recovery_active");
  try { fs.mkdirSync(gate, { mode: 0o700 }); } catch { throw new AgentRuntimeError("runtime.owner_busy"); }
  const nonce = crypto.randomUUID();
  const claimant = path.join(gate, "claimant.json");
  try {
    const claimFd = fs.openSync(claimant, "wx", 0o600);
    try { fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(claimFd); } finally { fs.closeSync(claimFd); }
    if (fs.existsSync(recovery)) throw new AgentRuntimeError("runtime.owner_recovery_active");
    if (fs.existsSync(lock)) {
      const old = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
      if (taskOwnerAlive(old.pid)) throw new AgentRuntimeError("runtime.owner_busy");
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } finally {
    if (fs.existsSync(claimant)) {
      const claim = JSON.parse(taskReadFile(claimant, 4096).toString("utf8"));
      if (claim.pid === process.pid && claim.nonce === nonce) fs.unlinkSync(claimant);
    }
    if (fs.existsSync(gate)) fs.rmdirSync(gate);
  }
  return () => {
    if (!fs.existsSync(lock)) return;
    const owner = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
    if (owner.pid === process.pid && owner.nonce === nonce) fs.unlinkSync(lock);
  };
}

export function recoverAgentTaskOwner(options, { confirmStopped = false } = {}) {
  if (confirmStopped !== true) throw new AgentRuntimeError("runtime.offline_confirmation_required");
  const directory = taskPrivateDirectory(agentTaskDirectory(options));
  const recovery = path.join(directory, "owner-recovery");
  try { fs.mkdirSync(recovery, { mode: 0o700 }); } catch { throw new AgentRuntimeError("runtime.owner_recovery_active"); }
  try {
    const lock = path.join(directory, "owner.json");
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(taskReadFile(lock, 4096).toString("utf8"));
      if (taskOwnerAlive(owner.pid)) throw new AgentRuntimeError("runtime.owner_busy");
    }
    const gate = path.join(directory, "owner-acquisition");
    if (fs.existsSync(gate)) {
      taskPrivateDirectory(gate);
      const entries = fs.readdirSync(gate);
      if (entries.some((name) => name !== "claimant.json")) throw new AgentRuntimeError("runtime.unsafe_state_path");
      const claimant = path.join(gate, "claimant.json");
      if (entries.length) {
        const claim = JSON.parse(taskReadFile(claimant, 4096).toString("utf8"));
        if (taskOwnerAlive(claim.pid)) throw new AgentRuntimeError("runtime.owner_busy");
        fs.unlinkSync(claimant);
      }
      // An acquiring process must write its claimant before touching owner.json.
      // If it wins this race, rmdir fails on the non-empty gate; no recursive deletion.
      fs.rmdirSync(gate);
    }
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    return { recovered: true };
  } finally { fs.rmdirSync(recovery); }
}

function agentTaskDirectory({ stateDir, origin, botId }) {
  return path.join(path.resolve(stateDir), taskIdentity(origin, botId));
}

export function readAgentTaskSummary(options) {
  const directory = agentTaskDirectory(options);
  if (fs.existsSync(directory)) taskPrivateDirectory(directory);
  const file = path.join(directory, "tasks.json");
  if (!fs.existsSync(file)) return { total: 0, active: 0, failed: 0, completed: 0, tasks: [] };
  const state = JSON.parse(taskReadFile(file).toString("utf8"));
  const tasks = (state.tasks || []).map((task) => ({ taskId: task.taskId, state: task.state, attempts: task.attempts,
    error: task.error || null, updatedAt: task.updatedAt, expiresAt: task.expiresAt,
    serverCancellationPending: task.remoteCancellationPending === true }));
  return { total: tasks.length, active: tasks.filter((t) => !TASK_TERMINAL.has(t.state)).length,
    failed: tasks.filter((t) => t.state === "failed").length, completed: tasks.filter((t) => t.state === "completed").length, tasks };
}

export function requestAgentTaskControl(options, taskId, action = "retry") {
  if (!/^[a-f0-9]{64}$/u.test(taskId) || !["retry", "cancel"].includes(action)) throw new AgentRuntimeError("task.invalid_control");
  const directory = agentTaskDirectory(options);
  taskPrivateDirectory(directory);
  const state = readAgentTaskSummary(options);
  if (!state.tasks.some((task) => task.taskId === taskId)) throw new AgentRuntimeError("task.not_found");
  taskAtomicWrite(path.join(directory, `control-${taskId}.json`), JSON.stringify({ taskId, action }));
  return { taskId, action, queued: true };
}

/** A local durable inbox. Transport ACK confirms accept(), never business completion. */
export function createAgentTaskRuntime(options) {
  const { client, invoke, prepareInputs = async () => [], resolveMedia, validateBytes,
    onState = () => {}, now = Date.now, scopes = [] } = options;
  if (!client || typeof invoke !== "function") throw new AgentRuntimeError("runtime.invalid_adapter");
  for (const field of ["maxTasks", "maxBytes", "retentionMs", "maxConcurrency", "maxAttempts", "retryDelayMs", "authorizationPollMs"]) {
    if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || options[field] < (field === "retryDelayMs" ? 0 : 1))) throw new AgentRuntimeError("runtime.invalid_limit");
  }
  const maxTasks = Math.min(1000, Math.max(1, options.maxTasks ?? 200));
  const maxBytes = Math.min(1024 * 1024 * 1024, Math.max(1, options.maxBytes ?? 256 * 1024 * 1024));
  const retentionMs = Math.min(7 * 24 * 3600_000, Math.max(60_000, options.retentionMs ?? 24 * 3600_000));
  const concurrency = Math.min(8, Math.max(1, options.maxConcurrency ?? 2));
  const maxAttempts = Math.min(5, Math.max(1, options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1500);
  taskPrivateDirectory(path.resolve(options.stateDir));
  const directory = taskPrivateDirectory(agentTaskDirectory(options));
  const releaseOwner = acquireTaskOwner(directory);
  const stateFile = path.join(directory, "tasks.json");
  let tasks = [], closed = false, started = false, timer, scheduling = false;
  const running = new Map(), activeConversations = new Set(), waiters = [], notifying = new Map();
  const scopedClients = new Map();
  const remoteControls = new Set();
  const notify = () => { try { onState(summary()); } catch { /* Observability cannot alter task state. */ } };
  const persist = () => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, tasks }));
    if (bytes.length > TASK_FILE_LIMIT) throw new AgentRuntimeError("runtime.state_limit");
    taskAtomicWrite(stateFile, bytes);
  };
  const setState = (task, state, patch = {}) => { Object.assign(task, patch, { state, updatedAt: now() }); persist(); notify(); };
  const blobPath = (id) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new AgentRuntimeError("artifact.invalid_reference");
    return path.join(directory, `${id}.blob`);
  };
  const usedBytes = () => fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.blob$/u.test(name))
    .reduce((total, name) => total + fs.lstatSync(path.join(directory, name)).size, 0);
  const summary = () => ({ total: tasks.length, active: running.size,
    pending: tasks.filter((task) => !TASK_TERMINAL.has(task.state)).length,
    failed: tasks.filter((task) => task.state === "failed").length,
    completed: tasks.filter((task) => task.state === "completed").length,
    lastError: [...tasks].reverse().find((task) => task.error)?.error || null });
  const prune = () => {
    const expired = tasks.filter((task) => task.expiresAt <= now() && !running.has(task.taskId));
    if (!expired.length) return;
    tasks = tasks.filter((task) => !expired.includes(task)); persist();
    for (const task of expired) for (const artifact of task.artifacts || []) {
      const file = blobPath(artifact.artifactId);
      if (fs.existsSync(file)) { taskReadFile(file, 50 * 1024 * 1024); fs.unlinkSync(file); }
    }
  };
  try {
    for (const name of fs.readdirSync(directory).filter((name) => /^(?:tasks\.json|[a-f0-9]{64}\.blob)\.[a-f0-9-]{36}\.tmp$/u.test(name))) {
      const file = path.join(directory, name); taskReadFile(file, 25 * 1024 * 1024); fs.unlinkSync(file);
    }
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(taskReadFile(stateFile).toString("utf8"));
      if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 1000) throw new AgentRuntimeError("runtime.invalid_state");
      tasks = state.tasks;
      for (const task of tasks) {
        if (!/^[a-f0-9]{64}$/u.test(task.taskId) || typeof task.event?.conversationId !== "string" || !Number.isFinite(task.expiresAt)) throw new AgentRuntimeError("runtime.invalid_state");
        if (!TASK_TERMINAL.has(task.state)) {
          if ((task.artifacts || []).some((artifact) => ["uploading", "reserving"].includes(artifact.state) && !artifact.uploadId && !artifact.attachmentId)) {
            for (const artifact of task.artifacts || []) if (["uploading", "reserving"].includes(artifact.state) && !artifact.uploadId && !artifact.attachmentId) artifact.state = "unknown";
            task.state = "failed"; task.error = { code: "upload.outcome_unknown", stage: "uploading", retryable: false };
          } else task.state = "received";
        }
      }
    }
    prune(); persist();
    const referenced = new Set(tasks.flatMap((task) => (task.artifacts || []).map((artifact) => `${artifact.artifactId}.blob`)));
    for (const name of fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.blob$/u.test(name) && !referenced.has(name))) {
      const file = path.join(directory, name); taskReadFile(file, 25 * 1024 * 1024); fs.unlinkSync(file);
    }
  } catch (error) { releaseOwner(); throw error; }

  async function authorize(task) {
    const result = await client.listConversations();
    const conversation = result?.conversations?.find((item) => item.id === task.event.conversationId);
    if (!conversation || conversation.allowTrigger === false || conversation.allowSend === false) throw new AgentRuntimeError("task.authorization_denied");
    let activeClient = client, capabilities;
    if (typeof client.getCapabilities === "function") {
      try { capabilities = await client.getCapabilities(conversation.id); }
      catch (error) {
        if (error?.statusCode !== 404 && error?.statusCode !== 405) throw error;
        if (conversation.taskRequired === true || task.remoteTask) throw new AgentRuntimeError("task.protocol_required");
      }
      if (capabilities?.features?.taskAuthorization === true && task.event.type === "message.created") {
        if (!task.remoteTask) {
          const accepted = await client.createTask({ eventId: task.event.eventId });
          const triggerId = task.event.payload?.messageId || task.event.payload?.message?.id || task.event.messageId;
          if (!accepted?.task?.id || accepted.task.conversationId !== conversation.id || (triggerId && accepted.task.triggerMessageId !== triggerId)) throw new AgentRuntimeError("task.invalid_context");
          task.remoteTask = accepted.task; persist();
        }
        const checked = await client.getTask(task.remoteTask.id);
        if (!checked?.task || checked.task.id !== task.remoteTask.id || checked.task.conversationId !== conversation.id || checked.task.triggerMessageId !== task.remoteTask.triggerMessageId) throw new AgentRuntimeError("task.authorization_denied");
        activeClient = scopedClients.get(task.taskId);
        if (!activeClient) {
          activeClient = client.forTask(checked.task);
          scopedClients.set(task.taskId, activeClient);
        }
      } else if (capabilities?.taskRequired === true || conversation.taskRequired === true || task.remoteTask) {
        throw new AgentRuntimeError("task.protocol_required");
      }
    } else if (conversation.taskRequired === true) throw new AgentRuntimeError("task.protocol_required");
    let context = null;
    if (scopes.includes("messages:read_context") && conversation.allowContext !== false) context = await activeClient.getContext(conversation.id, { limit: 12 });
    if (task.remoteTask && (!context?.messages?.some((message) => message.id === task.remoteTask.triggerMessageId))) {
      const exact = await activeClient.getMessage(task.remoteTask.triggerMessageId);
      if (!exact?.message?.id) throw new AgentRuntimeError("input.trigger_unavailable");
      context = { ...(context || {}), messages: [...(context?.messages || []).slice(-11), exact.message] };
    }
    return { conversation, context, client: activeClient, capabilities };
  }

  function activeTaskClient(task) { return scopedClients.get(task.taskId) || client; }

  function watchRemoteTask(task, controller) {
    if (!task.remoteTask) return () => {};
    let stopped = false, pending = false;
    const check = async () => {
      if (stopped || pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await client.getTask(task.remoteTask.id, { signal: controller.signal });
        if (!result?.task || result.task.id !== task.remoteTask.id || result.task.conversationId !== task.event.conversationId
          || result.task.triggerMessageId !== task.remoteTask.triggerMessageId
          || ["cancelled", "expired", "revoked"].includes(result.task.status)
          || Date.parse(result.task.expiresAt) <= now()) throw new AgentRuntimeError("task.authorization_denied");
      }
      catch (error) { if (!stopped) controller.abort(error?.code === "sdk.upgrade_required" ? error : new AgentRuntimeError(error?.code || "task.authorization_denied")); }
      finally { pending = false; }
    };
    const timer = setInterval(check, Math.min(30_000, Math.max(100, options.authorizationPollMs ?? 5000)));
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }

  function visibleArtifacts(conversationId, context) {
    if (!scopes.includes("files:read_content") || !scopes.includes("messages:read_context")) return [];
    const visibleMessages = new Map((context?.messages || []).filter((message) => !message.recalledAt && !message.deletedAt && !message.removedAt && !["recalled", "removed", "deleted"].includes(message.status)).map((message) => [message.id, message]));
    return tasks.filter((task) => task.event.conversationId === conversationId && task.expiresAt > now())
      .flatMap((task) => (task.artifacts || []).filter((artifact) => artifact.messageId &&
        visibleMessages.get(artifact.messageId)?.content?.blocks?.some((block) => block.type === "attachment" && block.attachmentId === artifact.attachmentId && !["removed", "deleted", "failed"].includes(block.status)))
        .map((artifact) => ({ artifactId: artifact.artifactId, fileName: artifact.fileName, mimeType: artifact.mimeType,
          byteSize: artifact.byteSize, attachmentId: artifact.attachmentId, messageId: artifact.messageId, sourceMessageId: task.triggerMessageId || null,
          expiresAt: task.expiresAt })));
  }

  async function readArtifact(id, conversationId, context, signal, maxBytes = 10 * 1024 * 1024, taskClient = client) {
    if (!scopes.includes("files:read_content") || !scopes.includes("messages:read_context") || typeof client.readAttachment !== "function") throw new AgentRuntimeError("artifact.read_scope_required");
    const visible = visibleArtifacts(conversationId, context).find((artifact) => artifact.artifactId === id);
    if (!visible) throw new AgentRuntimeError("artifact.reference_denied");
    const owner = tasks.find((task) => (task.artifacts || []).some((artifact) => artifact.artifactId === id));
    const record = owner.artifacts.find((artifact) => artifact.artifactId === id);
    if (record.byteSize > maxBytes) throw new AgentRuntimeError("input.attachment_limit");
    const result = await taskClient.readAttachment({ conversationId, messageId: record.messageId, attachmentId: record.attachmentId,
      mode: "content", signal, maxBytes });
    taskCheckCancelled(signal);
    if (owner.expiresAt <= now()) throw new AgentRuntimeError("artifact.expired");
    const bytes = Buffer.from(result.bytes);
    if (bytes.length !== record.byteSize || taskDigest(bytes) !== record.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
    validateBytes?.(bytes, record.mimeType);
    return { bytes, fileName: record.fileName, mimeType: record.mimeType, attachmentId: record.attachmentId,
      source: { kind: "artifact", artifactId: id, attachmentId: record.attachmentId, messageId: record.messageId } };
  }

  async function generate(task, authorization, signal) {
    taskCheckCancelled(signal);
    const { conversation, context, client: taskClient } = authorization;
    const request = buildAgentBridgeRequest({ taskId: task.taskId, event: task.event, conversation, context, authorization: task.remoteTask,
      capabilities: { publicMedia: Boolean(resolveMedia), incomingAttachments: scopes.some((scope) => ["files:read_content", "files:read_preview"].includes(scope)) },
      artifacts: visibleArtifacts(conversation.id, context) });
    task.triggerMessageId = request.triggerMessage?.id || null;
    persist();
    request.inputs = await prepareInputs({ client: taskClient, event: task.event, triggerMessage: request.triggerMessage, context, conversation, scopes, signal });
    taskCheckCancelled(signal);
    let remainingInputBytes = 10 * 1024 * 1024 - request.inputs.reduce((total, input) => total + (input.byteSize || 0), 0);
    const alreadyIncluded = new Set(request.inputs.map((input) => input.attachmentId));
    for (const reference of [...request.artifacts].reverse().filter((artifact) => !alreadyIncluded.has(artifact.attachmentId)).slice(0, 2)) {
      if (alreadyIncluded.has(reference.attachmentId) || request.inputs.length >= 6 || reference.byteSize > remainingInputBytes) continue;
      try {
        const artifact = await readArtifact(reference.artifactId, conversation.id, context, signal, remainingInputBytes, taskClient);
        remainingInputBytes -= artifact.bytes.length;
        alreadyIncluded.add(reference.attachmentId);
        request.inputs.push({ artifactId: reference.artifactId, attachmentId: reference.attachmentId, messageId: reference.messageId,
          conversationId: conversation.id, status: "available", trust: "untrusted-attachment", mimeType: artifact.mimeType,
          byteSize: artifact.bytes.length, type: /^image\/(?:png|jpeg|gif|webp)$/u.test(artifact.mimeType) ? "image" : "document",
          encoding: "base64", data: artifact.bytes.toString("base64") });
      } catch (error) {
        taskCheckCancelled(signal);
        if (error?.code === "sdk.upgrade_required") throw error;
        request.inputs.push({ artifactId: reference.artifactId, status: "unavailable", code: safeAgentError(error).code });
      }
    }
    let broker;
    let result;
    try {
      if (task.remoteTask) {
        const currentCapabilities = await taskClient.getCapabilities();
        request.capabilities.channel = { features: currentCapabilities.features, operations: currentCapabilities.operations,
          limits: currentCapabilities.limits, taskRequired: currentCapabilities.taskRequired };
        broker = await createTaskToolBroker(taskClient, { signal, capabilities: currentCapabilities });
        request.toolSession = broker.descriptor;
        request.capabilities.taskTools = true;
      }
      result = parseAgentBridgeResult(await invoke(request, { signal, toolEnvironment: broker?.environment }), { taskId: task.taskId, validateBytes });
    } finally { broker?.close(); }
    taskCheckCancelled(signal);
    const artifacts = [];
    let total = 0;
    try { for (const descriptor of result.artifacts) {
      let artifact = descriptor;
      if (descriptor.source === "https") {
        if (!resolveMedia) throw new AgentRuntimeError("media.disabled");
        artifact = await resolveMedia(descriptor.url, { signal });
        taskCheckCancelled(signal);
        if (descriptor.fileName) artifact.fileName = descriptor.fileName;
      } else if (descriptor.source === "artifact") artifact = await readArtifact(descriptor.artifactId, conversation.id, context, signal, 10 * 1024 * 1024, taskClient);
      validateBytes?.(artifact.bytes, artifact.mimeType, { source: descriptor.source === "https" ? "https" : "inline" });
      total += artifact.bytes.length;
      if (total > 50 * 1024 * 1024 || usedBytes() + artifact.bytes.length > maxBytes) throw new AgentRuntimeError("artifact.storage_limit");
      const artifactId = taskDigest(`${task.taskId}\n${descriptor.id}`);
      const sha256 = taskDigest(artifact.bytes);
      const file = blobPath(artifactId);
      if (fs.existsSync(file)) {
        if (taskDigest(taskReadFile(file, 25 * 1024 * 1024)) !== sha256) throw new AgentRuntimeError("artifact.conflicting_result");
      } else taskAtomicWrite(file, artifact.bytes);
      artifacts.push({ artifactId, fileName: artifact.fileName, mimeType: artifact.mimeType, byteSize: artifact.bytes.length,
        sha256, state: descriptor.source === "artifact" && artifact.attachmentId ? "uploaded" : "generated",
        source: ["https", "artifact"].includes(descriptor.source) ? artifact.source : { kind: descriptor.source },
        attachmentId: descriptor.source === "artifact" ? artifact.attachmentId : null, messageId: null });
    } } catch (error) {
      for (const artifact of artifacts) {
        const file = blobPath(artifact.artifactId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      throw error;
    }
    task.text = result.text; task.content = result.content; task.artifacts = artifacts; task.generated = true;
    setState(task, "generated");
  }

  async function publish(task, signal) {
    const taskClient = activeTaskClient(task);
    for (let index = 0; index < task.artifacts.length; index += 1) {
      const artifact = task.artifacts[index];
      if (artifact.messageId) continue;
      if (signal.aborted) throw new AgentRuntimeError("task.cancelled");
      const authorization = await authorize(task);
      taskCheckCancelled(signal);
      if (artifact.source?.kind === "artifact") {
        const current = await readArtifact(artifact.source.artifactId, task.event.conversationId, authorization.context, signal, 10 * 1024 * 1024, taskClient);
        if (taskDigest(current.bytes) !== artifact.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
      }
      if (!artifact.attachmentId) {
        if (artifact.state === "uploading" || artifact.state === "unknown") throw new AgentRuntimeError("upload.outcome_unknown");
        const bytes = taskReadFile(blobPath(artifact.artifactId), 25 * 1024 * 1024);
        if (taskDigest(bytes) !== artifact.sha256) throw new AgentRuntimeError("artifact.integrity_failed");
        setState(task, "uploading");
        if (typeof taskClient.reserveUpload === "function" && typeof taskClient.getUploadStatus === "function") {
          if (!artifact.uploadId) {
            artifact.state = "reserving"; persist();
            let reservationRejected = false;
            try {
              const reserved = await taskClient.reserveUpload({ conversationId: task.event.conversationId,
                fileName: artifact.fileName, mimeType: artifact.mimeType, byteSize: artifact.byteSize });
              // Quota rejection is a successful gateway response with no upload ID.
              if (reserved?.upload?.status === "rejected") {
                reservationRejected = true;
                throw new AgentRuntimeError("quota.insufficient");
              }
              const uploadId = reserved?.upload?.id;
              if (typeof uploadId !== "string" || !uploadId) throw new AgentRuntimeError("upload.outcome_unknown");
              artifact.uploadId = uploadId; artifact.state = "reserved"; persist();
            } catch (error) {
              const status = error?.statusCode ?? error?.status;
              const rejected = reservationRejected || (Number.isInteger(status) && status >= 400 && status < 500);
              artifact.state = rejected ? "generated" : "unknown"; persist();
              if (!rejected) throw new AgentRuntimeError("upload.outcome_unknown");
              throw error;
            }
          }
          if (artifact.state === "reserved") {
            taskCheckCancelled(signal);
            artifact.state = "completing"; persist();
            try {
              const complete = await taskClient.completeUploadContent(artifact.uploadId, bytes, artifact.mimeType);
              const receipt = complete?.attachment || complete?.upload?.attachment;
              if (receipt?.id) { artifact.attachmentId = receipt.id; artifact.state = "uploaded"; persist(); }
              else { artifact.state = "checking"; persist(); }
            } catch (error) {
              const status = error?.statusCode ?? error?.status;
              if (Number.isInteger(status) && status >= 400 && status < 500) {
                // A definitive rejection did not accept this transfer. Preserve the
                // reservation and original error; an explicit retry may try it again.
                artifact.state = "reserved"; persist(); throw error;
              }
              // Reconcile only an uncertain completion instead of retransferring bytes.
              artifact.state = "checking"; persist();
            }
          }
          taskCheckCancelled(signal);
          if (!artifact.attachmentId) {
            const status = await taskClient.getUploadStatus(artifact.uploadId);
            if (status?.upload?.status === "completed" && status.upload.attachment?.id) {
              artifact.attachmentId = status.upload.attachment.id; artifact.state = "uploaded"; persist();
            } else if (status?.upload?.status === "failed") throw new AgentRuntimeError("upload.failed");
            else throw new AgentRuntimeError("upload.status_pending", { retryable: true });
          }
        } else {
          // Older custom clients cannot reconcile a lost one-step upload receipt.
          artifact.state = "uploading"; persist();
          try {
            const uploaded = await taskClient.uploadFile({ conversationId: task.event.conversationId, bytes,
              fileName: artifact.fileName, mimeType: artifact.mimeType,
              clientMessageId: `artifact-${artifact.artifactId}`, idempotencyKey: `artifact-${artifact.artifactId}` });
            if (typeof uploaded?.attachment?.id !== "string" || !uploaded.attachment.id) throw new AgentRuntimeError("upload.outcome_unknown");
            artifact.attachmentId = uploaded.attachment.id; artifact.state = "uploaded"; persist();
          } catch (error) {
            const status = error?.statusCode ?? error?.status;
            const rejected = Number.isInteger(status) && status >= 400 && status < 500;
            artifact.state = rejected ? "generated" : "unknown"; persist();
            if (!rejected) throw new AgentRuntimeError("upload.outcome_unknown");
            throw error;
          }
        }
      }
      if (signal.aborted) throw new AgentRuntimeError("task.cancelled");
      setState(task, "sending");
      const text = index === 0 ? task.text : "";
      const sent = await taskClient.sendMessage({ conversationId: task.event.conversationId,
        content: { format: "duallane.message+json;v=1", plainText: text,
          blocks: [...(index === 0 && task.content ? task.content.blocks : (text ? [{ type: "text", text }] : [])), { type: "attachment", attachmentId: artifact.attachmentId }] },
        replyToMessageId: task.triggerMessageId || undefined,
        clientMessageId: `publish-${artifact.artifactId}`, idempotencyKey: `publish-${artifact.artifactId}` });
      if (!sent?.message?.id) throw new AgentRuntimeError("send.invalid_receipt", { retryable: true });
      artifact.messageId = sent.message.id; artifact.state = "sent"; persist();
      taskCheckCancelled(signal);
    }
    if (!task.artifacts.length && !task.messageId) {
      await authorize(task); taskCheckCancelled(signal); setState(task, "sending");
      const sent = await taskClient.sendMessage({ conversationId: task.event.conversationId, text: task.text,
        content: task.content,
        replyToMessageId: task.triggerMessageId || undefined,
        clientMessageId: `reply-${task.taskId}`, idempotencyKey: `reply-${task.taskId}` });
      if (!sent?.message?.id) throw new AgentRuntimeError("send.invalid_receipt", { retryable: true });
      task.messageId = sent.message.id; persist();
      taskCheckCancelled(signal);
    }
    taskCheckCancelled(signal);
    setState(task, "completed", { error: null });
  }

  async function failureReceipt(task) {
    if (task.failureNotified || task.state === "cancelled" || task.notificationAttempts >= 3) return;
    task.notificationAttempts = (task.notificationAttempts || 0) + 1;
    task.nextNotificationAt = now() + Math.max(1000, retryDelayMs) * 2 ** (task.notificationAttempts - 1);
    persist();
    try {
      await authorize(task);
      const error = task.error;
      const result = await activeTaskClient(task).sendMessage({ conversationId: task.event.conversationId,
        text: `请求未完成（阶段：${error.stage}；错误：${error.code}）。已成功发送的附件会保留。请联系机器人管理员重试任务 ${task.taskId}。`,
        replyToMessageId: task.triggerMessageId || task.event.payload?.messageId || undefined,
        clientMessageId: `failure-${task.taskId}-${task.generation || 0}`, idempotencyKey: `failure-${task.taskId}-${task.generation || 0}` });
      if (result?.message?.id) { task.failureNotified = true; persist(); }
    } catch (error) {
      if (!safeAgentError(error).retryable) { task.notificationAttempts = 3; persist(); }
    } finally {
      if (!running.has(task.taskId)) { scopedClients.get(task.taskId)?.close(); scopedClients.delete(task.taskId); }
    }
  }

  async function execute(task, controller) {
    task.attempts += 1; task.error = null; setState(task, "running");
    let stopThinking = () => {}, stopWatching = () => {};
    try {
      const authorization = await authorize(task);
      taskCheckCancelled(controller.signal);
      stopWatching = watchRemoteTask(task, controller);
      stopThinking = taskStartThinking(authorization.client, task.event.conversationId, controller.signal);
      if (!task.generated) await generate(task, authorization, controller.signal);
      if (controller.signal.aborted) throw new AgentRuntimeError("task.cancelled");
      await publish(task, controller.signal);
    } catch (error) {
      stopThinking();
      if (error?.code === "sdk.upgrade_required" || controller.signal.reason?.code === "sdk.upgrade_required") {
        setState(task, "failed", { error: safeAgentError(controller.signal.reason?.code === "sdk.upgrade_required" ? controller.signal.reason : error, task.state), notificationAttempts: 3 });
        return;
      }
      const safe = safeAgentError(error, task.state);
      if (controller.signal.aborted && closed) { setState(task, "received", { error: null }); return; }
      if (controller.signal.aborted || ["task.cancelled", "bridge.cancelled"].includes(safe.code)) { setState(task, "cancelled", { error: { code: "task.cancelled", stage: task.state, retryable: false } }); return; }
      if (safe.retryable && task.attempts < maxAttempts && safe.code !== "upload.outcome_unknown") {
        setState(task, "received", { error: safe, nextAttemptAt: now() + retryDelayMs * 2 ** (task.attempts - 1) });
      } else { setState(task, "failed", { error: safe }); await failureReceipt(task); }
    } finally {
      stopThinking(); stopWatching();
      scopedClients.get(task.taskId)?.close(); scopedClients.delete(task.taskId);
    }
  }

  function control(taskId, action) {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task || task.expiresAt <= now()) throw new AgentRuntimeError("task.not_found");
    if (action === "cancel") {
      if (task.remoteTask && typeof client.cancelAgentTask === "function") {
        task.remoteCancellationPending = true; persist();
        const cancellation = Promise.resolve().then(() => client.cancelAgentTask(task.remoteTask.id, { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }))
          .then(() => { task.remoteCancellationPending = false; persist(); }).catch(() => {});
        remoteControls.add(cancellation); cancellation.finally(() => remoteControls.delete(cancellation));
      }
      if (running.has(taskId)) running.get(taskId).controller.abort();
      else if (!TASK_TERMINAL.has(task.state)) setState(task, "cancelled");
      return;
    }
    if (task.state !== "failed") throw new AgentRuntimeError("task.not_retryable");
    if ((task.artifacts || []).some((artifact) => ["unknown", "uploading", "reserving"].includes(artifact.state) && !artifact.uploadId)) throw new AgentRuntimeError("upload.outcome_unknown");
    task.attempts = 0; task.failureNotified = false; task.notificationAttempts = 0; task.generation = (task.generation || 0) + 1;
    setState(task, "received", { error: null, nextAttemptAt: 0 }); schedule();
  }

  function schedule() {
    if (!started || closed || scheduling) return;
    scheduling = true;
    try {
      prune();
      for (const file of fs.readdirSync(directory).filter((name) => /^control-[a-f0-9]{64}\.json$/u.test(name))) {
        const filePath = path.join(directory, file);
        const input = JSON.parse(taskReadFile(filePath, 4096).toString("utf8"));
        try { control(input.taskId, input.action); } catch { /* Invalid/stale operator requests do not run a task. */ }
        fs.unlinkSync(filePath);
      }
      const waitingConversations = new Set(activeConversations);
      for (const task of tasks) {
        if (running.size >= concurrency) break;
        if (task.state !== "received" || waitingConversations.has(task.event.conversationId)) continue;
        waitingConversations.add(task.event.conversationId);
        if ((task.nextAttemptAt || 0) > now()) continue;
        const controller = new AbortController();
        activeConversations.add(task.event.conversationId);
        // Publish ownership before execute() can synchronously persist/notify.
        const slot = { controller, promise: null }; running.set(task.taskId, slot);
        slot.promise = execute(task, controller).catch(() => {
          // Disk failures stop admission; accepting more events would lose durable ownership.
          closed = true;
        }).finally(() => {
          running.delete(task.taskId); activeConversations.delete(task.event.conversationId);
          queueMicrotask(schedule);
          if (!running.size && !tasks.some((item) => item.state === "received")) for (const waiter of waiters.splice(0)) waiter();
          notify();
        });
      }
      for (const task of tasks) {
        if (running.size + notifying.size >= concurrency) break;
        if (task.state !== "failed" || task.failureNotified || task.notificationAttempts >= 3 || (task.nextNotificationAt || 0) > now() || notifying.has(task.taskId)) continue;
        const work = failureReceipt(task).catch(() => { closed = true; }).finally(() => notifying.delete(task.taskId));
        notifying.set(task.taskId, work);
      }
    } finally { scheduling = false; }
  }

  return {
    accept(event, { completed = false } = {}) {
      if (closed) throw new AgentRuntimeError("runtime.closed");
      if (!event || typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 180 || typeof event.conversationId !== "string" || !event.conversationId || Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) throw new AgentRuntimeError("task.invalid_event");
      prune();
      const taskId = taskDigest(`${taskIdentity(options.origin, options.botId)}\n${event.eventId}`);
      const fingerprint = taskEventFingerprint(event);
      const previous = tasks.find((task) => task.taskId === taskId);
      if (previous) {
        if (taskEventFingerprint(previous.event) !== fingerprint) throw new AgentRuntimeError("task.event_conflict");
        return { taskId, duplicate: true };
      }
      if (tasks.length >= maxTasks) throw new AgentRuntimeError("runtime.queue_full", { retryable: true });
      const timestamp = now();
      tasks.push({ taskId, fingerprint, event: structuredClone(event), state: completed ? "completed" : "received", createdAt: timestamp, updatedAt: timestamp,
        expiresAt: timestamp + retentionMs, attempts: 0, artifacts: [], generated: false });
      try { persist(); } catch (error) { tasks.pop(); throw error; }
      queueMicrotask(schedule); notify();
      return { taskId, duplicate: false };
    },
    start() {
      if (closed) throw new AgentRuntimeError("runtime.closed");
      if (started) return;
      started = true; timer = setInterval(schedule, Math.max(20, Math.min(retryDelayMs || 20, 500))); schedule();
    },
    retry(taskId) { control(taskId, "retry"); },
    cancel(taskId) { control(taskId, "cancel"); },
    summary,
    getTask(taskId) { const task = tasks.find((item) => item.taskId === taskId); return task ? structuredClone(task) : null; },
    listArtifacts(conversationId, context) { return visibleArtifacts(conversationId, context); },
    async idle() {
      if (!running.size && !tasks.some((task) => task.state === "received")) return;
      await new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      closed = true; clearInterval(timer);
      for (const { controller } of running.values()) controller.abort();
      await Promise.allSettled([...running.values()].map((slot) => slot.promise));
      await Promise.allSettled([...notifying.values()]);
      await Promise.allSettled([...remoteControls]);
      for (const scoped of scopedClients.values()) scoped.close(); scopedClients.clear();
      releaseOwner();
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}

// --- src/runtime-update.js ---
const RUNTIME_MAX_BYTES = 5 * 1024 * 1024;

function runtimeUpdateError(code) {
  return Object.assign(new Error("Official runtime update could not complete safely."), { code });
}

function runtimeAtomicWrite(file, bytes, mode = 0o600) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function runtimeReadPrivateJson(file, maximum = 8192) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw runtimeUpdateError("runtime.unsafe_target");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw runtimeUpdateError("runtime.recovery_required"); }
}

function runtimeAcquireUpdateLock(target) {
  const lock = `${target}.update-lock`;
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  };
  const create = () => fs.writeFileSync(lock, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try { create(); } catch (error) {
    if (error.code !== "EEXIST" || alive(runtimeReadPrivateJson(lock).pid)) throw runtimeUpdateError("runtime.update_busy");
    const gate = `${lock}.recovery`;
    try { fs.mkdirSync(gate, { mode: 0o700 }); } catch { throw runtimeUpdateError("runtime.update_busy"); }
    try {
      if (alive(runtimeReadPrivateJson(lock).pid)) throw runtimeUpdateError("runtime.update_busy");
      fs.unlinkSync(lock); create();
    } finally { fs.rmdirSync(gate); }
  }
  return () => {
    if (runtimeReadPrivateJson(lock).nonce === owner.nonce) fs.unlinkSync(lock);
  };
}

function runtimeRecoverUpdate(target) {
  const journalPath = `${target}.update.json`;
  if (!fs.existsSync(journalPath)) return;
  const journal = runtimeReadPrivateJson(journalPath);
  if (journal.version !== 1 || !/^[a-f0-9]{64}$/u.test(journal.next?.sha256 || "") ||
      journal.next.fileName !== path.basename(target) || journal.next.format !== "duallane.official-runtime") throw runtimeUpdateError("runtime.recovery_required");
  const identity = runtimeFileIdentity(target);
  const installed = runtimeInstallRecord(target);
  if (installed && installed.sha256 !== journal.previous?.sha256 && installed.sha256 !== journal.next.sha256) throw runtimeUpdateError("runtime.recovery_required");
  if (identity?.sha256 === journal.next.sha256) {
    runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(journal.next) + "\n");
  } else if ((identity?.sha256 || null) === (journal.previous?.sha256 || null)) {
    if (journal.previous) runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(journal.previous) + "\n");
    else if (installed) fs.unlinkSync(`${target}.install.json`);
  } else {
    throw runtimeUpdateError("runtime.recovery_required");
  }
  fs.unlinkSync(journalPath);
}

function runtimeFileIdentity(target) {
  if (!target || !fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RUNTIME_MAX_BYTES) throw runtimeUpdateError("runtime.unsafe_target");
  let parent = path.dirname(path.resolve(target));
  while (true) {
    if (fs.lstatSync(parent).isSymbolicLink()) throw runtimeUpdateError("runtime.unsafe_target");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"), byteSize: stat.size };
}

function runtimeInstallRecord(target) {
  const recordPath = `${target}.install.json`;
  if (!fs.existsSync(recordPath)) return null;
  const stat = fs.lstatSync(recordPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw runtimeUpdateError("runtime.invalid_install_record");
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (record.format !== "duallane.official-runtime" || record.version !== 1 || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error();
    return record;
  } catch { throw runtimeUpdateError("runtime.invalid_install_record"); }
}

export async function inspectOfficialRuntime({ origin, targetPath, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw runtimeUpdateError("runtime.invalid_origin"); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw runtimeUpdateError("runtime.invalid_origin");
  const manifest = await requestGateway({
    fetchImpl, url: new URL("/integrations/duallane-agent.manifest.json", base), timeoutMs,
    init: { method: "GET", headers: { accept: "application/json", "cache-control": "no-cache" } },
  });
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version || "") ||
      !/^[a-f0-9]{64}$/u.test(manifest.sha256 || "") || !Number.isSafeInteger(manifest.byteSize) ||
      manifest.byteSize < 1024 || manifest.byteSize > RUNTIME_MAX_BYTES) throw runtimeUpdateError("runtime.invalid_manifest");
  const compatibility = manifest.compatibility;
  if (compatibility && (compatibility.gatewayVersion !== 1 || compatibility.bridgeProtocolVersion !== 1)) throw runtimeUpdateError("runtime.incompatible");
  const current = runtimeFileIdentity(targetPath);
  const record = targetPath ? runtimeInstallRecord(targetPath) : null;
  const contentChanged = current ? current.sha256 !== manifest.sha256 : null;
  const versionOrder = compareRuntimeSemver(manifest.version, DUALLANE_AGENT_SDK_VERSION);
  return {
    currentVersion: DUALLANE_AGENT_SDK_VERSION,
    latestVersion: manifest.version,
    updateAvailable: versionOrder > 0 || (versionOrder === 0 && contentChanged === true),
    contentChanged,
    sameVersionDrift: versionOrder === 0 && contentChanged === true,
    managed: Boolean(current && record && record.sha256 === current.sha256 && record.origin === base.origin && record.fileName === path.basename(targetPath)),
    locallyModified: Boolean(current && record && record.sha256 !== current.sha256),
    sha256: manifest.sha256,
    byteSize: manifest.byteSize,
    buildId: typeof manifest.buildId === "string" && /^[a-f0-9]{64}$/u.test(manifest.buildId) ? manifest.buildId : null,
    compatibility: compatibility || { gatewayVersion: 1, bridgeProtocolVersion: 1 },
    downloadUrl: new URL("/integrations/duallane-agent.mjs", base).href,
    highlights: Array.isArray(manifest.highlights) ? manifest.highlights.filter((v) => typeof v === "string" && v.length < 300).slice(0, 8) : [],
  };
}

export async function installOfficialRuntime({ origin, targetPath, force = false, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const target = path.resolve(targetPath);
  if (path.basename(target) !== "duallane-agent.mjs") throw runtimeUpdateError("runtime.unmanaged_target");
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let ancestor = dir;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw runtimeUpdateError("runtime.unsafe_target");
    const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  const release = runtimeAcquireUpdateLock(target);
  try {
  runtimeRecoverUpdate(target);
  const check = await inspectOfficialRuntime({ origin, targetPath: target, fetchImpl, timeoutMs });
  const original = runtimeFileIdentity(target);
  // An exact published bundle may establish provenance without overwriting it.
  // Unknown old bundles and local extensions require a separate clean install.
  if (original && !check.managed && original.sha256 !== check.sha256) throw runtimeUpdateError("runtime.local_changes_preserved");
  if (check.locallyModified) throw runtimeUpdateError("runtime.local_changes_preserved");
  if (!check.updateAvailable && !force && original?.sha256 === check.sha256 && check.managed) return { ...check, updated: false, targetPath: target };
  if (compareRuntimeSemver(check.latestVersion, DUALLANE_AGENT_SDK_VERSION) < 0) throw runtimeUpdateError("runtime.downgrade_denied");
  const bytes = await requestGateway({
    fetchImpl, url: check.downloadUrl, timeoutMs,
    init: { method: "GET", headers: { "cache-control": "no-cache" } },
    read: (response) => readGatewayBytes(response, RUNTIME_MAX_BYTES),
  });
  if (bytes.byteLength !== check.byteSize || crypto.createHash("sha256").update(bytes).digest("hex") !== check.sha256) throw runtimeUpdateError("runtime.integrity_mismatch");
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: bytes, timeout: 10_000, encoding: "utf8", maxBuffer: 64 * 1024, windowsHide: true });
  if (syntax.status !== 0) throw runtimeUpdateError("runtime.invalid_script");
  const current = runtimeFileIdentity(target);
  if (current?.sha256 !== original?.sha256) throw runtimeUpdateError("runtime.target_changed");
  const previousBytes = original ? fs.readFileSync(target) : null;
  const previous = runtimeInstallRecord(target);
  const journalPath = `${target}.update.json`;
  const record = { format: "duallane.official-runtime", version: 1, origin: new URL(origin).origin, fileName: path.basename(target), sha256: check.sha256, byteSize: bytes.byteLength, sdkVersion: check.latestVersion };
  runtimeAtomicWrite(journalPath, JSON.stringify({ version: 1, previous: previous || (original ? { ...record, ...original } : null), next: record }));
  try {
    runtimeAtomicWrite(target, bytes, 0o755);
    runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(record) + "\n");
    fs.unlinkSync(journalPath);
  } catch {
    try {
      if (runtimeFileIdentity(target)?.sha256 === record.sha256) {
        if (previousBytes) runtimeAtomicWrite(target, previousBytes, 0o755);
        else fs.unlinkSync(target);
      }
      const currentRecord = runtimeInstallRecord(target);
      if (currentRecord?.sha256 === record.sha256 && previous?.sha256 !== record.sha256) {
        if (previous) runtimeAtomicWrite(`${target}.install.json`, JSON.stringify(previous) + "\n");
        else fs.unlinkSync(`${target}.install.json`);
      }
      fs.unlinkSync(journalPath);
    } catch {
      // The journal records both legitimate identities for the next locked run.
    }
    throw runtimeUpdateError("runtime.install_failed");
  }
  return { ...check, managed: true, updated: original?.sha256 !== check.sha256, targetPath: target };
  } finally { release(); }
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
  #client;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, requestTimeoutMs }) {
    this.#client = new DualLaneAgentClient({ url: baseUrl, token, fetch: fetchImpl, requestTimeoutMs });
  }

  getMe() { return this.#client.getMe(); }
  getCapabilities(conversationId) { return this.#client.getCapabilities(conversationId); }
  createTask(input) { return this.#client.createTask(input); }
  getTask(taskId) { return this.#client.getTask(taskId); }
  cancelAgentTask(taskId) { return this.#client.cancelAgentTask(taskId); }
  getOperation(taskId, operation, key) { return this.#client.getOperation(taskId, operation, key); }
  forTask(task, options) { return this.#client.forTask(task, options); }
  getMessage(messageId, options) { return this.#client.getMessage(messageId, options); }
  listHistory(conversationId, options) { return this.#client.listHistory(conversationId, options); }
  searchMessages(conversationId, options) { return this.#client.searchMessages(conversationId, options); }
  listMembers(conversationId) { return this.#client.listMembers(conversationId); }
  listConversations() { return this.#client.listConversations(); }
  getContext(conversationId, limit = 50) { return this.#client.getContext(conversationId, { limit }); }
  getUpdates(afterSequence = 0, limit = 50) { return this.#client.getUpdates({ afterSequence, limit }); }
  sendMessage(conversationId, text, options = {}) { return this.#client.sendMessage({ ...options, conversationId, text }); }
  editMessage(messageId, input, options) { return this.#client.editMessage(messageId, input, options); }
  sendFile(conversationId, bytes, fileName, options = {}) { return this.#client.sendFile({ ...options, conversationId, bytes, fileName }); }
  readAttachment(input) { return this.#client.readAttachment(input); }
  sendCard(conversationId, cardDoc, options = {}) { return this.#client.sendCard({ ...options, conversationId, card: cardDoc }); }

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
  "files:read_metadata",
  "files:write",
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
        taskId: { type: "string" },
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
        content: AGENT_MESSAGE_CONTENT_SCHEMA,
        taskId: { type: "string", description: "Server task ID; required for task-authorized conversations." },
        replyToMessageId: { type: "string", description: "Optional message ID (msg_...) to reply to." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_edit_message",
    description:
      "Edit a message previously sent by this Bot in DualLane (useful for live progress updates and streaming final answers).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        messageId: { type: "string", description: "Message ID (msg_...) previously returned by duallane_send_message." },
        plainText: { type: "string", description: "Updated message text." },
        content: AGENT_MESSAGE_CONTENT_SCHEMA,
        expectedVersion: { type: "string", minLength: 64, maxLength: 64, description: "Current message.version for a task edit. A conflict is never refreshed automatically." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["messageId"],
    },
  },
  {
    name: "duallane_send_file",
    description:
      "Upload and send a generated file or image (from a local filePath, UTF-8 contentText, or base64 contentBase64) directly to an authorized DualLane conversation.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Server task ID for task-authorized destinations; local file paths are operator-only." },
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        filePath: { type: "string", description: "Local path to the file to upload (provide filePath, contentText, or contentBase64)." },
        contentText: { type: "string", description: "Inline UTF-8 file text when generating text/markdown/csv/svg/code without writing to disk." },
        contentBase64: { type: "string", description: "Inline Base64-encoded binary payload when sending generated images/PDFs/ZIPs directly." },
        fileName: { type: "string", description: "File name shown in DualLane (inferred from filePath if omitted, e.g. 'report.md' or 'chart.png')." },
        mimeType: { type: "string", description: "Optional MIME type (auto-inferred from fileName extension if omitted)." },
        text: { type: "string", description: "Optional caption / message text sent together with the file." },
        replyToMessageId: { type: "string", description: "Optional message ID (msg_...) to reply to." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_send_card",
    description:
      "Send an interactive approval/notification card to a DualLane conversation with optional action buttons (confirm, cancel, submit, refresh).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
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
      "Wait in real time (via outbound WebSocket with replay cursor) for the next incoming DualLane message, @mention, /command, or interactive card button click. Receiving does not acknowledge completion: call duallane_ack_event after durable handling. Use the resident task runtime for recoverable model jobs.",
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
    name: "duallane_ack_event",
    description: "Acknowledge an event only after its work has completed or been durably accepted. Does not send a reply or advance the shared profile cursor. Pass an explicit afterSequence on the next wait only when all earlier events have been handled.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        sequence: { type: "integer", minimum: 1 },
        profile: { type: "string" },
      },
      required: ["eventId", "sequence"],
    },
  },
  {
    name: "duallane_set_typing",
    description:
      "Emit a real-time 'thinking' or 'typing' indicator in a DualLane conversation (and advance read confirmation) while processing a complex task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
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
    name: "duallane_doctor",
    description:
      "Run full health diagnostics for this DualLane Bot: runtime SDK version vs server latest, granted scopes, effective per-conversation trigger/context permissions, block reasons, and recent deliveries.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_runtime_update",
    description:
      "Check or apply SHA-256 verified updates to the local standalone duallane-agent.mjs runtime and smoothly restart installed background daemons (lark-cli style).",
    inputSchema: {
      type: "object",
      properties: {
        checkOnly: {
          type: "boolean",
          description: "If true, only check whether a newer SDK version is available without overwriting local files.",
        },
        restartDaemons: {
          type: "boolean",
          description: "If true (default), restart installed background daemons after updating.",
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
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
  { name: "duallane_begin_task", description: "Operator: establish a server-authorized task for an exact delivered event. Never use a chat-supplied actor identity.",
    inputSchema: { type: "object", properties: { eventId: { type: "string" }, profile: { type: "string" } }, required: ["eventId"] } },
  { name: "duallane_cancel_task", description: "Operator: cancel further work in a server task chain. This does not withdraw published messages.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" }, profile: { type: "string" } }, required: ["taskId"] } },
  ...DUALLANE_TASK_TOOLS.filter((tool) => !["duallane_send_message", "duallane_edit_message", "duallane_send_card"].includes(tool.name)).map((tool) => ({ ...tool,
    description: `${tool.description} Operator entry requires an existing taskId; group adapters use mcp --task.`,
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, taskId: { type: "string" }, profile: { type: "string" } },
      required: [...tool.inputSchema.required, ...(tool.name === "duallane_capabilities" ? [] : ["taskId"])] } })),
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

    if (name === "duallane_begin_task") return makeClient(profileName).client.createTask({ eventId: args.eventId });
    if (name === "duallane_cancel_task") return makeClient(profileName).client.cancelAgentTask(args.taskId);
    if (DUALLANE_TASK_TOOLS.some((tool) => tool.name === name) && !["duallane_send_message", "duallane_edit_message", "duallane_send_card"].includes(name)) {
      const { client } = makeClient(profileName);
      if (name === "duallane_capabilities" && !args.taskId) return client.getCapabilities();
      if (typeof args.taskId !== "string" || !args.taskId) throw new DualLaneAgentError("task.context_required", "An existing server task is required");
      const record = await client.getTask(args.taskId);
      const scoped = client.forTask(record.task);
      const input = { ...args }; delete input.taskId; delete input.profile;
      const operationId = "operator-" + crypto.createHash("sha256").update(JSON.stringify([name, input])).digest("hex");
      try { return await createTaskToolServer(scoped).callTool(name, input, operationId); }
      finally { scoped.close(); }
    }

    switch (name) {
      case "duallane_setup_start": {
        const target = parseSetupTarget(args.setupUrl, args.url);
        const clientName = sanitizeSetupClientName(args.clientName, `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`);
        const requestedScopes =
          Array.isArray(args.requestedScopes) && args.requestedScopes.length > 0
            ? args.requestedScopes
            : [...DEFAULT_SETUP_SCOPES];

        const setupClient = new DualLaneAgentSetupClient({ url: target.origin, fetch: fetchImpl });
        const initialCheck = await setupClient.status(target.setupSessionId).catch(optionalGatewayResult);
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
        } catch (error) {
          optionalGatewayResult(error);
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
          client.listConversations().catch((error) => optionalGatewayResult(error, { conversations: [] })),
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
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        try { return await scoped.getContext(args.conversationId, { limit }); }
        finally { if (scoped !== client) scoped.close(); }
      }

      case "duallane_send_message": {
        const { client } = makeClient(profileName);
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        try { return await scoped.sendMessage({
          conversationId: args.conversationId,
          text: args.text,
          content: args.content,
          replyToMessageId: args.replyToMessageId,
        }); } finally { if (scoped !== client) scoped.close(); }
      }

      case "duallane_edit_message": {
        const { client } = makeClient(profileName);
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        const input = args.taskId || args.content !== undefined || args.expectedVersion !== undefined
          ? { plainText: args.plainText, content: args.content, expectedVersion: args.expectedVersion } : args.plainText;
        try { return await scoped.editMessage(args.messageId, input); }
        finally { if (scoped !== client) scoped.close(); }
      }

      case "duallane_send_file": {
        const { client } = makeClient(profileName);
        let rawBytes;
        let resolvedName = typeof args.fileName === "string" ? args.fileName.trim() : "";
        if (typeof args.filePath === "string" && args.filePath.trim()) {
          const full = path.resolve(args.filePath.trim());
          rawBytes = readBoundedFile(full);
          if (!resolvedName) {
            resolvedName = path.basename(full);
          }
        } else if (typeof args.contentBase64 === "string" && args.contentBase64.trim()) {
          const cleanedB64 = args.contentBase64.trim().replace(/^data:[^;]+;base64,/iu, "");
          rawBytes = decodeArtifactBase64(cleanedB64, { maxBytes: AGENT_DIRECT_FILE_MAX_BYTES });
        } else if (typeof args.contentText === "string" && args.contentText.length > 0) {
          rawBytes = normalizeFileBytes(args.contentText);
        } else {
          throw new TypeError("One of filePath, contentText, or contentBase64 is required for duallane_send_file");
        }
        if (!resolvedName) {
          resolvedName = "generated.txt";
        }
        const mimeType =
          typeof args.mimeType === "string" && args.mimeType.trim()
            ? args.mimeType.trim()
            : inferMimeTypeFromFileName(resolvedName);
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        try { return await scoped.sendFile({
          conversationId: args.conversationId,
          bytes: rawBytes,
          fileName: resolvedName,
          mimeType,
          text: args.text,
          replyToMessageId: args.replyToMessageId,
        }); } finally { if (scoped !== client) scoped.close(); }
      }

      case "duallane_send_card": {
        const { client } = makeClient(profileName);
        const card = buildAgentInteractiveCard(args);
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        try { return await scoped.sendFeishuCard({
          conversationId: args.conversationId,
          fallbackText: String(args.fallbackText || args.title || "交互卡片"),
          card,
        }); } finally { if (scoped !== client) scoped.close(); }
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
            ack: false,
            onSyncRequired: () => { throw new DualLaneAgentError("gateway.sync_required", "Event replay requires explicit resynchronization"); },
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
            requiresAck: true,
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
              ack: false,
              async onEvent(event) {
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
                  lastSequence: startSeq,
                  requiresAck: true,
                });
              },
              async onSyncRequired() {
                throw new DualLaneAgentError("gateway.sync_required", "Event replay requires explicit resynchronization");
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

      case "duallane_ack_event": {
        const { client } = makeClient(profileName);
        const result = await client.acknowledge({ eventId: args.eventId, sequence: args.sequence });
        return { ...result, acknowledgedSequence: args.sequence, profileCursorUnchanged: true };
      }

      case "duallane_set_typing": {
        const { client } = makeClient(args.profile);
        const scoped = args.taskId ? client.forTask((await client.getTask(args.taskId)).task) : client;
        try { return await scoped.setTyping(args.conversationId, { state: args.state || "thinking" }); }
        finally { if (scoped !== client) scoped.close(); }
      }

      case "duallane_doctor": {
        const { client, profile } = makeClient(args.profile);
        const [doctor, updateInfo] = await Promise.all([
          client.getDoctor().catch(optionalGatewayResult),
          checkRuntimeUpdate({ origin: profile.url, targetPath: resolveStandaloneScriptPath(), fetchImpl }).catch(() => null),
        ]);
        return {
          profile: profile.profile,
          origin: profile.url,
          localSdkVersion: DUALLANE_AGENT_SDK_VERSION,
          runtimeUpdate: updateInfo,
          ...(doctor || {}),
          localTasks: (doctor?.bot?.id || profile.botId) ? readAgentTaskSummary({
            stateDir: path.join(getDaemonStateDir(configDir), "tasks"), origin: profile.url, botId: doctor?.bot?.id || profile.botId,
          }) : null,
        };
      }

      case "duallane_runtime_update": {
        const { profile } = makeClient(args.profile);
        if (args.checkOnly) {
          return await checkRuntimeUpdate({ origin: profile.url, targetPath: resolveStandaloneScriptPath(), fetchImpl });
        }
        const staged = await stageRuntimeSelfUpdate({
          origin: profile.url,
          fetchImpl,
        });
        let restartedProfiles = [];
        if (staged.updated && args.restartDaemons !== false) {
          restartedProfiles = await restartInstalledDaemons({ configDir, quiet: true });
        }
        return {
          ...staged,
          restartedProfiles,
        };
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
              retryable: toolErr?.code === "sdk.upgrade_required" ? false : toolErr?.retryable === true,
              ...(["rejected", "unknown"].includes(toolErr?.attemptOutcome) ? { attemptOutcome: toolErr.attemptOutcome, safeToRetry: false } : {}),
              ...(toolErr?.upgrade ? { upgrade: toolErr.upgrade, updateCommand: runtimeUpgradeCommand(resolveStandaloneScriptPath(), normalizeProfileName(toolArgs.profile || defaultProfile), toolErr.upgrade.runtimeManifestUrl) } : {}),
              ...(safeAgentOperationReference(toolErr?.operation) ? { operation: safeAgentOperationReference(toolErr.operation) } : {}),
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
  const server = options.server ?? createDualLaneMcpServer(options);
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;

  let buffer = Buffer.alloc(0);
  let framingMode = null; // "newline" | "content-length"
  const maxInputBytes = options.maxInputBytes ?? 80 * 1024 * 1024;

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
    if (buffer.length + buf.length > maxInputBytes) {
      buffer = Buffer.alloc(0);
      sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request exceeds the input limit" } });
      input.pause(); input.destroy?.(); return;
    }
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
        if (!Number.isSafeInteger(length) || length > maxInputBytes) {
          buffer = Buffer.alloc(0);
          sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request exceeds the input limit" } });
          input.pause(); input.destroy?.(); return;
        }
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

// --- src/daemon.js ---
const DAEMON_VALID_AGENTS = new Set(["auto", "cmd"]);
const DAEMON_VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function getDaemonStateDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "daemons");
}

export function getDaemonLogDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "logs");
}

export function createDaemonMediaResolver({ enabled, dnsServers = [], fetchMedia = fetchPublicMedia }) {
  if (!enabled) return undefined;
  return (url, { signal } = {}) => fetchMedia(url, { enabled: true, signal,
    ...(dnsServers.length ? { dnsServers } : {}) });
}

export function getDaemonServiceLabel(profileName) {
  return `top.tsio.duallane.agent.${normalizeProfileName(profileName)}`;
}

export function getMacLaunchAgentPath(profileName, homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${getDaemonServiceLabel(profileName)}.plist`);
}

export function getLinuxSystemdUnitName(profileName) {
  return `duallane-agent-${normalizeProfileName(profileName)}.service`;
}

export function getLinuxSystemdUnitPath(profileName, homeDir = os.homedir()) {
  return path.join(homeDir, ".config", "systemd", "user", getLinuxSystemdUnitName(profileName));
}

function escapeDaemonXml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function buildLaunchdPlistXml(spec) {
  const argsXml = spec.programArguments
    .map((arg) => `      <string>${escapeDaemonXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.env || {})
    .filter(([, val]) => typeof val === "string" && val.length > 0)
    .map(
      ([k, v]) => `      <key>${escapeDaemonXml(k)}</key>\n      <string>${escapeDaemonXml(v)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeDaemonXml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeDaemonXml(spec.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeDaemonXml(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeDaemonXml(spec.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
  </dict>
</plist>
`;
}

export function buildSystemdUnitFile(spec) {
  const quotedArgs = spec.programArguments
    .map((arg) => `"${String(arg).replace(/(["\\])/gu, "\\$1")}"`)
    .join(" ");
  const envLines = Object.entries(spec.env || {})
    .filter(([, val]) => typeof val === "string" && val.length > 0)
    .map(([k, v]) => `Environment="${k}=${String(v).replace(/(["\\])/gu, "\\$1")}"`)
    .join("\n");

  return `[Unit]
Description=DualLane Agent Resident Listener (${spec.profileName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDirectory}
ExecStart=${quotedArgs}
Restart=always
RestartSec=3
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
${envLines}

[Install]
WantedBy=default.target
`;
}

export function detectAvailableAgentBinary(preferred = "auto") {
  const normalized = String(preferred || "auto").trim().toLowerCase();
  if (!DAEMON_VALID_AGENTS.has(normalized)) {
    throw new TypeError(`Unsupported --agent "${preferred}". Use auto or cmd with --cmd <command>.`);
  }
  return normalized;
}

export function buildDaemonAgentPrompt({ botName, conversation, event, context }) {
  const isGroup = conversation?.type === "group" || conversation?.kind === "group";
  const convTitle = conversation?.title || (isGroup ? "群聊" : "私聊");
  const eventType = String(event?.type || event?.eventType || "message.created");
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};

  const contextMessages = Array.isArray(context?.messages) ? context.messages : [];
  const historyLines = contextMessages.slice(-20).map((m) => {
    const speaker =
      m.authorName ||
      m.senderName ||
      (m.authorKind === "bot" || m.kind === "bot" ? botName || "Bot" : "成员");
    const ts = m.createdAt ? String(m.createdAt).slice(11, 19) : "";
    const text = String(m.plainText || "").trim() || "[媒体/卡片消息]";
    return `[${ts}] ${speaker}: ${text}`;
  });

  const latestMsgText = String(resolveAgentTrigger(event, context)?.plainText || "").trim();

  const safetyRule = isGroup
    ? [
        `安全边界（群聊强制策略）：当前消息来自多人共享群聊「${convTitle}」。`,
        `严禁执行任何修改本机文件、修改系统配置、安装软件、读取敏感私钥凭证或具有副作用的命令；仅作为群聊智能体提供对话解答与信息协助。`,
      ].join("\n")
    : `当前消息来自主人授权的一对一私聊会话。请直接给出清晰、准确、简洁的回复。`;

  const fileGuidance = `生成产物应通过 duallane.agent.result v1 结构化协议导出真实字节。兼容文本模式可使用 <duallane-file name="文件名.ext">文件正文</duallane-file>（二进制内容加 encoding="base64"）。不得提供本机路径；只有渠道返回发送回执后才能确认附件已经发出。`;

  const sections = [
    `你是接入在 DualLane 协作空间中的 AI 智能体「${botName || "Bot"}」。`,
    `请直接输出你要发送到当前聊天窗口的最终回复正文（支持 Markdown，不要输出“以下是回复”等多余包装语，也不要调用 duallane-agent send 发送，外层守护进程会自动将你的最终回复发出）。`,
    fileGuidance,
    safetyRule,
  ];

  if (historyLines.length > 0) {
    sections.push(`最近会话上下文（按时间顺序）：\n${historyLines.join("\n")}`);
  }

  if (eventType === "card.action") {
    sections.push(
      `触发事件：用户点击了交互卡片按钮 actionId="${payload.actionId || ""}"，附加数据：${JSON.stringify(payload.data || {})}`
    );
  } else if (eventType === "command.invoked") {
    sections.push(
      `触发事件：用户调用了指令 /${payload.command || ""} ${payload.args || ""}`.trim()
    );
  } else if (latestMsgText) {
    sections.push(`最新待回复消息：\n${latestMsgText}`);
  }

  return sections.join("\n\n");
}

export function extractGeneratedFilesFromReply(rawReply) {
  const result = parseAgentBridgeResult(String(rawReply || ""), { validateBytes: validateArtifactBytes });
  if (result.artifacts.some((artifact) => artifact.source !== "inline")) throw new AgentRuntimeError("artifact.runtime_required");
  return { cleanText: result.text, files: result.artifacts.map(({ fileName, mimeType, bytes }) => ({ fileName, mimeType, bytes })) };
}

function readDaemonRecord(profileName, configDir) {
  const filePath = path.join(getDaemonStateDir(configDir), `${normalizeProfileName(profileName)}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeDaemonRecord(profileName, record, configDir) {
  const dir = getDaemonStateDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${normalizeProfileName(profileName)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return filePath;
}

function isDaemonPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 1) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveStandaloneScriptPath(explicitPath = "") {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  const argvScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (
    argvScript &&
    argvScript.endsWith("duallane-agent.mjs") &&
    !argvScript.includes(`${path.sep}packages${path.sep}agent-sdk${path.sep}bin${path.sep}`)
  ) {
    return argvScript;
  }
  return path.join(os.homedir(), ".duallane", "bin", "duallane-agent.mjs");
}

export function runtimeUpgradeCommand(scriptPath, profileName = "default", origin) {
  const quote = (value) => process.platform === "win32" ? `'${String(value).replace(/'/gu, "''")}'` : `'${String(value).replace(/'/gu, "'\\''")}'`;
  const args = [process.execPath, scriptPath, "update", "--profile", normalizeProfileName(profileName)];
  if (origin) args.push("--url", new URL(origin).origin);
  return `${process.platform === "win32" ? "& " : ""}${args.map((value) => quote(value)).join(" ")}`;
}

export async function checkRuntimeUpdate(options = {}) {
  return inspectOfficialRuntime(options);
}

export async function stageRuntimeSelfUpdate(options = {}) {
  return installOfficialRuntime({ ...options, targetPath: resolveStandaloneScriptPath(options.targetPath) });
}

export async function restartInstalledDaemons({ configDir, quiet = true } = {}) {
  const dir = getDaemonStateDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const restarted = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const profileName = entry.slice(0, -5);
    const rec = readDaemonRecord(profileName, configDir);
    if (!rec) continue;
    try {
      await manageDaemonCli(["restart"], { profile: profileName, quiet });
      restarted.push(profileName);
    } catch {
      /* ignore stale profile */
    }
  }
  return restarted;
}

export async function invokeDaemonAgentTurn({ customCmd, workdir, request, signal, toolEnvironment, timeoutMs = 300_000 }) {
  if (!customCmd) throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new AgentRuntimeError("bridge.input_limit");
  if (signal?.aborted) throw new AgentRuntimeError("bridge.cancelled");
  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DUALLANE_BOT_TOKEN;
    delete env.DUALLANE_TOKEN;
    delete env.DUALLANE_MESSAGE_TEXT;
    delete env.DUALLANE_TASK_BROKER_URL;
    delete env.DUALLANE_TASK_BROKER_KEY;
    if (toolEnvironment) {
      env.DUALLANE_TASK_BROKER_URL = toolEnvironment.DUALLANE_TASK_BROKER_URL;
      env.DUALLANE_TASK_BROKER_KEY = toolEnvironment.DUALLANE_TASK_BROKER_KEY;
    }
    env.DUALLANE_CONVERSATION_ID = String(request.event.conversationId);
    env.DUALLANE_EVENT_TYPE = String(request.event.type || "");
    const child = spawn(customCmd, { cwd: workdir, shell: true, windowsHide: true,
      detached: process.platform !== "win32", env, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBytes = 0, stderrBytes = 0, failure, settled = false;
    const chunks = [];
    const terminate = (code) => {
      if (failure) return;
      failure = new AgentRuntimeError(code);
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
    };
    const aborted = () => terminate("bridge.cancelled");
    const timer = setTimeout(() => terminate("bridge.timeout"), Math.min(600_000, Math.max(100, timeoutMs)));
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > AGENT_MAX_RESULT_BYTES) terminate("bridge.output_limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) terminate("bridge.stderr_limit");
    });
    child.stdin.on("error", () => { /* Exit/error below determines the safe result. */ });
    child.on("error", () => finish(new AgentRuntimeError("bridge.spawn_failed")));
    child.on("close", (code) => finish(failure || (code !== 0 ? new AgentRuntimeError("bridge.failed") : null), Buffer.concat(chunks).toString("utf8").trim()));
    child.stdin.end(input);
  });
}

export async function runResidentDaemon(flags = {}) {
  const profileName = normalizeProfileName(flags.profile || "default");
  const profile = loadAgentProfile(profileName);
  if (!profile) throw new Error(`Profile "${profileName}" is not configured. Run setup first.`);
  const savedCfg = readDaemonRecord(profileName) || {};
  if (savedCfg.pausedReason) {
    // Revoked credentials remain paused across supervisor restarts until an
    // operator explicitly runs daemon start/restart with the updated profile.
    writeDaemonRecord(profileName, { ...savedCfg, pid: process.pid, healthy: false });
    if (savedCfg.pausedReason === "sdk.upgrade_required") process.stderr.write(`DualLane Agent SDK upgrade required. Run: ${runtimeUpgradeCommand(resolveStandaloneScriptPath(), profileName, profile.url)}\n${JSON.stringify(savedCfg.upgrade || {})}\n`);
    await new Promise((resolve) => {
      const timer = setInterval(() => {}, 60_000);
      const resume = () => { clearInterval(timer); process.removeListener("SIGINT", resume); process.removeListener("SIGTERM", resume); resolve(); };
      process.once("SIGINT", resume); process.once("SIGTERM", resume);
    });
    return;
  }
  const customCmd = typeof flags.cmd === "string" ? flags.cmd.trim() : (savedCfg.cmd || "");
  const agentMode = detectAvailableAgentBinary(flags.agent || (typeof flags.cmd === "string" && flags.cmd.trim() ? "cmd" : savedCfg.agent) || (customCmd ? "cmd" : "auto"));
  if (!customCmd) throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
  const workdir = path.resolve(String(flags.workdir || savedCfg.workdir || os.homedir()));
  const rawSandbox = String(flags.sandbox || savedCfg.sandbox || "read-only").trim();
  const sandboxMode = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
  const model = typeof flags.model === "string" ? flags.model.trim() : (savedCfg.model || "");
  const transportMode = String(flags.transport || savedCfg.transport || "auto").trim().toLowerCase();
  const allowPublicMedia = flags["allow-public-media"] === true || flags["allow-public-media"] === "true" || (flags["allow-public-media"] === undefined && savedCfg.allowPublicMedia === true);
  const mediaDnsServers = typeof flags["media-dns-servers"] === "string" ? flags["media-dns-servers"].split(",").map((value) => value.trim()).filter(Boolean) : (savedCfg.mediaDnsServers || []);
  const autoUpdateEnabled = flags["auto-update"] === undefined ? savedCfg.autoUpdateEnabled !== false : flags["auto-update"] !== "false" && flags["auto-update"] !== false;
  const stateDir = path.join(getDaemonStateDir(), "tasks");
  let pauseUpgrade;
  const client = new DualLaneAgentClient({ url: profile.url, token: profile.token, adapterVersion: `duallane-daemon/${DUALLANE_AGENT_SDK_VERSION}`, onUpgradeRequired(error) { pauseUpgrade?.(error); } });
  const log = (code) => process.stderr.write(`[${new Date().toISOString()}] [DualLane] ${code}\n`);
  let record = { ...savedCfg, profile: profileName, agent: agentMode, cmd: customCmd,
    workdir, sandbox: sandboxMode, model: model || undefined, transport: transportMode,
    allowPublicMedia, mediaDnsServers, autoUpdateEnabled, pid: process.pid, healthy: false, probeError: null,
    startedAt: new Date().toISOString() };
  let me;
  // The child owns runtime state from its first network probe onward. A parent
  // must never replace a freshly written pause after launching this process.
  writeDaemonRecord(profileName, record);
  try { me = await client.getMe(); }
  catch (error) {
    if (error?.code === "sdk.upgrade_required" || [401, 403].includes(error?.statusCode ?? error?.status)) {
      writeDaemonRecord(profileName, { ...record, pausedReason: safeAgentError(error).code, probeError: safeAgentError(error).code, ...(error.upgrade ? { upgrade: error.upgrade } : {}) });
    }
    throw error;
  }
  const botId = me?.bot?.id || profile.botId;
  const scopes = Array.isArray(me?.scopes) ? me.scopes : [];
  let stopped = false, runtime, pendingRestart = false, updateBusy = false, stopResolve, upgradeFailure;
  const shutdownSignal = new Promise((resolve) => { stopResolve = resolve; });
  const timers = [];
  const updateRecord = (patch) => {
    record = { ...record, ...patch, updatedAt: new Date().toISOString() };
    writeDaemonRecord(profileName, record);
  };
  const shutdown = async () => {
    if (stopped) return;
    stopped = true; client.stop(); timers.forEach(clearInterval);
    await runtime?.close(); stopResolve();
  };
  const signalShutdown = () => { void shutdown(); };
  pauseUpgrade = (error) => {
    if (upgradeFailure) return;
    upgradeFailure = error;
    updateRecord({ healthy: false, pausedReason: "sdk.upgrade_required", probeError: "sdk.upgrade_required", upgrade: error.upgrade });
    void shutdown();
  };
  process.once("SIGINT", signalShutdown); process.once("SIGTERM", signalShutdown);
  runtime = createAgentTaskRuntime({ stateDir, origin: profile.url, botId, client, scopes,
    maxConcurrency: Number(flags.concurrency || savedCfg.concurrency || 2),
    prepareInputs: prepareAgentInputs,
    validateBytes: validateArtifactBytes,
    resolveMedia: createDaemonMediaResolver({ enabled: allowPublicMedia, dnsServers: mediaDnsServers }),
    invoke: (request, { signal, toolEnvironment }) => invokeDaemonAgentTurn({ customCmd, workdir, request, signal, toolEnvironment }),
    onState(summary) {
      updateRecord({ taskSummary: summary });
      if (pendingRestart && summary.pending === 0 && summary.active === 0) void shutdown();
    },
  });
  try { writeDaemonRecord(profileName, record); runtime.start(); }
  catch (error) {
    await runtime.close(); process.removeListener("SIGINT", signalShutdown); process.removeListener("SIGTERM", signalShutdown); throw error;
  }
  let cursor = Number(profile.lastSequence || 0);
  const acceptEvent = (event) => {
    const isBusinessEvent = ["message.created", "bot.mentioned", "command.invoked", "card.action"].includes(event.type);
    const accepted = runtime.accept(isBusinessEvent ? event : { ...event, conversationId: event.conversationId || "__runtime__" }, { completed: !isBusinessEvent });
    if (event.type === "bot.runtime_upgrade") void checkUpdate();
    return accepted;
  };
  const activeScriptPath = path.resolve(process.argv[1] || resolveStandaloneScriptPath());
  const isStandalone = activeScriptPath.endsWith("duallane-agent.mjs") && !activeScriptPath.includes(`${path.sep}packages${path.sep}agent-sdk${path.sep}bin${path.sep}`);
  const checkUpdate = async () => {
    if (!autoUpdateEnabled || !isStandalone || stopped || updateBusy || pendingRestart) return;
    updateBusy = true;
    try {
      const result = await stageRuntimeSelfUpdate({ origin: profile.url, targetPath: activeScriptPath });
      if (result.updated) {
        pendingRestart = true;
        if (runtime.summary().pending === 0 && runtime.summary().active === 0) await shutdown();
      }
    } catch (error) { log(`update.${safeAgentError(error).code}`); }
    finally { updateBusy = false; }
  };
  if (autoUpdateEnabled && isStandalone) {
    const first = setTimeout(() => { void checkUpdate(); }, 15_000); first.unref?.(); timers.push(first);
    const periodic = setInterval(() => { void checkUpdate(); }, 20 * 60_000); periodic.unref?.(); timers.push(periodic);
  }
  const polling = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const result = await client.pollNextEvent({ afterSequence: cursor, timeoutMs: 25_000, ack: false,
          onSyncRequired({ currentSequence }) {
            cursor = currentSequence; updateProfileCursor(profileName, cursor);
          } });
        if (result.event) {
          acceptEvent(result.event);
          await client.acknowledge({ eventId: result.event.eventId, sequence: result.event.sequence });
          cursor = result.event.sequence;
          updateProfileCursor(profileName, cursor);
        }
        failures = 0; updateRecord({ healthy: true, probeError: null });
      } catch (error) {
        const safe = safeAgentError(error); failures += 1;
        updateRecord({ healthy: false, probeError: safe.code }); log(safe.code);
        if (error?.code === "sdk.upgrade_required") { pauseUpgrade(error); throw error; }
        if ([401, 403].includes(error?.statusCode ?? error?.status)) updateRecord({ pausedReason: safe.code });
        if ([401, 403].includes(error?.statusCode ?? error?.status) || !safe.retryable || failures >= 3) throw new AgentRuntimeError(safe.code);
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, failures * 1000)));
      }
    }
  };
  try {
    if (transportMode === "poll") await polling();
    else {
      try {
        await client.connect({ lastSequence: cursor,
          onEvent(event) { acceptEvent(event); updateProfileCursor(profileName, event.sequence); },
          onStatus(state) { updateRecord({ healthy: state.status === "connected", probeError: state.status === "connected" ? null : "gateway.disconnected" }); },
          onSyncRequired({ currentSequence }) { cursor = currentSequence; updateProfileCursor(profileName, cursor); },
          onError(error) {
            const safe = safeAgentError(error); updateRecord({ healthy: false, probeError: safe.code }); log(safe.code);
            if ([401, 403].includes(error?.statusCode ?? error?.status)) { updateRecord({ pausedReason: safe.code }); void shutdown(); }
          },
        });
        await shutdownSignal;
      } catch (error) {
        client.stop();
        if (transportMode === "auto" && error?.retryable) await polling();
        else throw error;
      }
    }
  } finally {
    await shutdown();
    process.removeListener("SIGINT", signalShutdown); process.removeListener("SIGTERM", signalShutdown);
    updateRecord({ healthy: false, stoppedAt: new Date().toISOString() });
  }
  if (upgradeFailure) throw upgradeFailure;
  if (pendingRestart && record.manager === "detached") {
    const args = [activeScriptPath, "daemon", "run", "--profile", profileName];
    const logPath = record.logPath || path.join(getDaemonLogDir(), `${profileName}.log`);
    const logFd = fs.openSync(logPath, "a", 0o600);
    try {
      updateRecord({ pid: undefined, healthy: false });
      const child = spawn(process.execPath, args, { cwd: workdir, env: process.env, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
    } finally { fs.closeSync(logFd); }
  }
}

function stopDetachedPidIfRunning(profileName, configDir) {
  const rec = readDaemonRecord(profileName, configDir);
  if (rec?.pid && isDaemonPidAlive(rec.pid)) {
    try {
      process.kill(Number(rec.pid), "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function manageDaemonCli(positionals = [], flags = {}) {
  const action = String(positionals[0] || "status").trim().toLowerCase();
  const profileName = normalizeProfileName(flags.profile || "default");

  if (action === "recover-lock") {
    const profile = loadAgentProfile(profileName);
    if (!profile?.botId) throw new AgentRuntimeError("runtime.identity_required");
    const recovered = recoverAgentTaskOwner({ stateDir: path.join(getDaemonStateDir(), "tasks"), origin: profile.url, botId: profile.botId },
      { confirmStopped: flags["confirm-stopped"] === true || flags["confirm-stopped"] === "true" });
    process.stdout.write(JSON.stringify(recovered) + "\n");
    return;
  }

  if (action === "retry" || action === "cancel") {
    const profile = loadAgentProfile(profileName);
    if (!profile?.botId) throw new AgentRuntimeError("runtime.identity_required");
    const control = requestAgentTaskControl({ stateDir: path.join(getDaemonStateDir(), "tasks"),
      origin: profile.url, botId: profile.botId }, String(positionals[1] || ""), action);
    process.stdout.write(JSON.stringify(control) + "\n");
    return;
  }

  if (action === "run") {
    await runResidentDaemon(flags);
    return;
  }

  const scriptPath = resolveStandaloneScriptPath(flags.script);
  const nodePath = process.execPath;
  const logDir = getDaemonLogDir();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${profileName}.log`);
  const label = getDaemonServiceLabel(profileName);

  if (action === "logs") {
    const maxLines = Math.max(10, Math.min(500, Number(flags.lines || 60)));
    if (!fs.existsSync(logPath)) {
      process.stdout.write(`No daemon logs yet at ${logPath}\n`);
      return;
    }
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    process.stdout.write(lines.slice(-maxLines).join("\n") + "\n");
    return;
  }

  if (action === "install" || action === "start" || action === "restart") {
    const profile = loadAgentProfile(profileName);
    if (!profile) {
      throw new Error(
        `Profile "${profileName}" is not configured. Run: duallane-agent setup "<setupUrl>" --profile ${profileName}`
      );
    }
    const prev = readDaemonRecord(profileName) || {};
    const customCmd = typeof flags.cmd === "string" ? flags.cmd.trim() : (prev.cmd || "");
    const agentMode = detectAvailableAgentBinary(
      flags.agent ||
      (typeof flags.cmd === "string" && flags.cmd.trim() ? "cmd" : prev.agent) ||
      (customCmd ? "cmd" : "auto")
    );
    if (!customCmd) {
      throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
    }
    const workdir = path.resolve(String(flags.workdir || prev.workdir || process.cwd()));
    const rawSandbox = String(flags.sandbox || prev.sandbox || "read-only").trim();
    const sandbox = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
    const model = typeof flags.model === "string" ? flags.model.trim() : (prev.model || "");
    const transport = String(flags.transport || prev.transport || "auto").trim().toLowerCase();
    const allowPublicMedia = flags["allow-public-media"] === undefined ? prev.allowPublicMedia === true : [true, "true"].includes(flags["allow-public-media"]);
    const mediaDnsServers = typeof flags["media-dns-servers"] === "string" ? flags["media-dns-servers"].split(",").map((value) => value.trim()).filter(Boolean) : (prev.mediaDnsServers || []);
    const autoUpdateEnabled = flags["auto-update"] === undefined ? prev.autoUpdateEnabled !== false : ![false, "false"].includes(flags["auto-update"]);

    const programArguments = [
      nodePath,
      scriptPath,
      "daemon",
      "run",
      "--profile",
      profileName,
      "--agent",
      agentMode,
      "--workdir",
      workdir,
      "--sandbox",
      sandbox,
      "--transport",
      transport,
    ];
    if (model) programArguments.push("--model", model);
    if (customCmd) programArguments.push("--cmd", customCmd);
    programArguments.push("--allow-public-media", String(allowPublicMedia), "--auto-update", String(autoUpdateEnabled));
    if (mediaDnsServers.length) programArguments.push("--media-dns-servers", mediaDnsServers.join(","));

    const env = {
      HOME: os.homedir(),
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG || "en_US.UTF-8",
    };

    const startingRecord = (manager) => ({
      profile: profileName, botName: profile.botName || null, manager, label,
      agent: agentMode, cmd: customCmd, workdir, sandbox, model: model || undefined,
      transport, allowPublicMedia, mediaDnsServers, autoUpdateEnabled, logPath,
      healthy: false, probeError: null, pausedReason: null,
      installedAt: new Date().toISOString(),
    });
    let manager = "detached";
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const plistPath = getMacLaunchAgentPath(profileName);
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(
        plistPath,
        buildLaunchdPlistXml({
          label,
          programArguments,
          workingDirectory: workdir,
          logPath,
          env,
        }),
        "utf8"
      );
      const domain = `gui/${process.getuid()}`;
      spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
      stopDetachedPidIfRunning(profileName);
      writeDaemonRecord(profileName, startingRecord("launchd"));
      const boot = spawnSync("launchctl", ["bootstrap", domain, plistPath], { encoding: "utf8" });
      if (boot.status === 0) {
        spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
        manager = "launchd";
      } else spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
    } else if (process.platform === "linux") {
      const unitPath = getLinuxSystemdUnitPath(profileName);
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(
        unitPath,
        buildSystemdUnitFile({
          profileName,
          programArguments,
          workingDirectory: workdir,
          logPath,
          env,
        }),
        "utf8"
      );
      stopDetachedPidIfRunning(profileName);
      spawnSync("systemctl", ["--user", "stop", getLinuxSystemdUnitName(profileName)], { stdio: "ignore" });
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      writeDaemonRecord(profileName, startingRecord("systemd"));
      const enable = spawnSync(
        "systemctl",
        ["--user", "enable", "--now", getLinuxSystemdUnitName(profileName)],
        { encoding: "utf8" }
      );
      if (enable.status === 0) {
        spawnSync("systemctl", ["--user", "restart", getLinuxSystemdUnitName(profileName)], {
          stdio: "ignore",
        });
        manager = "systemd";
      } else spawnSync("systemctl", ["--user", "stop", getLinuxSystemdUnitName(profileName)], { stdio: "ignore" });
    }

    let spawnedPid = null;
    if (manager === "detached") {
      stopDetachedPidIfRunning(profileName);
      writeDaemonRecord(profileName, startingRecord("detached"));
      const logFd = fs.openSync(logPath, "a");
      const child = spawn(programArguments[0], programArguments.slice(1), {
        cwd: workdir,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);
      spawnedPid = child.pid;
    }

    // No record write is allowed after launch: the child may already have
    // persisted a newer health result or mandatory-upgrade pause. It records
    // its own PID before probing; installation is not a health assertion.

    if (!flags.quiet) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            action,
            profile: profileName,
            manager,
            agent: agentMode,
            sandbox,
            workdir,
            logPath,
            ...(spawnedPid ? { pid: spawnedPid } : {}),
          },
          null,
          2
        ) + "\n"
      );
    }
    return;
  }

  if (action === "stop" || action === "uninstall") {
    const stoppedVia = [];
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const plistPath = getMacLaunchAgentPath(profileName);
      const domain = `gui/${process.getuid()}`;
      const res = spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
      if (res.status === 0) stoppedVia.push("launchd");
      if (action === "uninstall" && fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }
    } else if (process.platform === "linux") {
      const unitName = getLinuxSystemdUnitName(profileName);
      const unitPath = getLinuxSystemdUnitPath(profileName);
      const res = spawnSync(
        "systemctl",
        ["--user", action === "uninstall" ? "disable" : "stop", "--now", unitName],
        { stdio: "ignore" }
      );
      if (res.status === 0) stoppedVia.push("systemd");
      if (action === "uninstall" && fs.existsSync(unitPath)) {
        fs.unlinkSync(unitPath);
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      }
    }
    if (stopDetachedPidIfRunning(profileName)) {
      stoppedVia.push("pid");
    }
    if (action === "uninstall") {
      const recFile = path.join(getDaemonStateDir(), `${profileName}.json`);
      if (fs.existsSync(recFile)) fs.unlinkSync(recFile);
    }
    process.stdout.write(
      JSON.stringify({ ok: true, action, profile: profileName, stoppedVia }, null, 2) + "\n"
    );
    return;
  }

  if (action === "status") {
    const rec = readDaemonRecord(profileName);
    let serviceRunning = false;
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const check = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
        encoding: "utf8",
      });
      if (check.status === 0 && /state\s*=\s*running/iu.test(String(check.stdout || ""))) {
        serviceRunning = true;
      }
    } else if (process.platform === "linux") {
      const check = spawnSync("systemctl", ["--user", "is-active", getLinuxSystemdUnitName(profileName)], {
        encoding: "utf8",
      });
      if (check.status === 0 && String(check.stdout || "").trim() === "active") {
        serviceRunning = true;
      }
    }
    if (!serviceRunning && rec?.pid && isDaemonPidAlive(rec.pid)) {
      serviceRunning = true;
    }

    let remoteConnection = null, probeError = null, taskSummary = null;
    const profile = loadAgentProfile(profileName);
    if (profile) {
      const client = new DualLaneAgentClient({
        url: profile.url,
        token: profile.token,
        adapterVersion: `duallane-cli/${DUALLANE_AGENT_SDK_VERSION}`,
      });
      try {
        const me = await client.getMe();
        remoteConnection = me?.connection || null;
        if (me?.bot?.id) taskSummary = readAgentTaskSummary({ stateDir: path.join(getDaemonStateDir(), "tasks"), origin: profile.url, botId: me.bot.id });
      } catch (error) {
        if (error?.code === "sdk.upgrade_required") throw error;
        probeError = safeAgentError(error).code;
      }
    }

    process.stdout.write(
      JSON.stringify(
        {
          profile: profileName,
          running: serviceRunning,
          healthy: serviceRunning && !probeError && rec?.healthy === true,
          probeError,
          taskSummary,
          daemon: rec || null,
          gatewayConnection: remoteConnection,
          logPath,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  throw new Error(
    `Unknown daemon action "${action}". Usage: duallane-agent daemon <install|start|stop|restart|uninstall|status|logs|run|retry|cancel> [taskId] [--profile default]`
  );
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
  duallane-agent version [--check] [--profile default] [--url <origin>]
  duallane-agent update [--check] [--force] [--no-restart] [--profile default] [--url <origin>]
  duallane-agent doctor [--profile default]
  duallane-agent ack <eventId> <sequence> [--profile default]
  duallane-agent daemon retry <taskId> [--profile default]
  duallane-agent daemon cancel <taskId> [--profile default]
  duallane-agent daemon recover-lock --confirm-stopped true [--profile default]
  duallane-agent daemon run --cmd <command> [--allow-public-media] [--media-dns-servers 1.1.1.1,8.8.8.8]
  duallane-agent daemon <install|start|stop|restart|uninstall|status|logs|run> --cmd <command> [--agent auto|cmd] [--workdir <dir>] [--profile default]
  duallane-agent mcp [--profile default]
  duallane-agent mcp --task
  duallane-agent capabilities [conversationId] [--task-id <id>] [--profile default]
  duallane-agent task <begin|status|cancel> <event-or-task-id> [--profile default]
  duallane-agent history [conversationId] --task-id <id> [--before <cursor>] [--limit 12]
  duallane-agent search [conversationId] --task-id <id> --query <text> [--author <memberId>] [--start-time <RFC3339>] [--end-time <RFC3339>]
  duallane-agent get-message <messageId> --task-id <id>
  duallane-agent members [conversationId] --task-id <id>
  duallane-agent operation <taskId> <operation> <key> [--profile default]
  duallane-agent send-card <conversationId> --card-json <fixed-action-card> [--task-id <id>]
  duallane-agent update-card <cardId> --card-json <fixed-action-card> --expected-revision <n> --task-id <id>
  duallane-agent status [--profile default]
  duallane-agent conversations [--profile default]
  duallane-agent updates [--ack] [--timeout 20] [--profile default]
  duallane-agent wait [--timeout 3600] [--transport auto|ws|poll] [--profile default]
  duallane-agent send <conversationId> [text] [--content-json <structured-content>] [--task-id <id>] [--reply-to <messageId>] [--profile default]
  duallane-agent send-file <conversationId> <filePath> [--task-id <id>] [--name <fileName>] [--mime <mimeType>] [--text <caption>] [--reply-to <messageId>] [--profile default]
  duallane-agent edit <messageId> [text] [--content-json <content>] [--expected-version <version>] [--task-id <id>] [--profile default]
  duallane-agent typing <conversationId> [--state thinking|typing] [--profile default]
  duallane-agent publish-mobile <apkPath> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]
  duallane-agent publish-mobile-ota <wwwDirOrZip> --version <semver> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]
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
  const initialCheck = await setupClient.status(target.setupSessionId).catch(optionalGatewayResult);
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
      const me = await client.getMe().catch(optionalGatewayResult);
      const convs = await client.listConversations().catch((error) => optionalGatewayResult(error, { conversations: [] }));

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

async function runListen(flags) {
  // Interactive and managed listeners use the same durable task boundary.
  return runResidentDaemon({ ...flags, agent: "cmd" });
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const subcommand = positionals[0];

  if ((!subcommand && flags.version) || subcommand === "-v" || subcommand === "version") {
    const profile = loadAgentProfile(normalizeProfileName(flags.profile || "default"));
    const origin = String(flags.url || profile?.url || "").trim();
    if (flags.check && origin) {
      const check = await checkRuntimeUpdate({ origin, targetPath: resolveStandaloneScriptPath(flags.script) });
      process.stdout.write(JSON.stringify(check, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      JSON.stringify(
        {
          version: DUALLANE_AGENT_SDK_VERSION,
          gatewayVersion: DUALLANE_GATEWAY_VERSION,
          node: process.version,
          scriptPath: resolveStandaloneScriptPath(),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (!subcommand || flags.help || flags.h || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "update" || subcommand === "upgrade") {
    const profile = loadAgentProfile(normalizeProfileName(flags.profile || "default"));
    const origin = String(flags.url || profile?.url || "https://duallane.tsio.top").trim();
    if (flags.check) {
      const check = await checkRuntimeUpdate({ origin, targetPath: resolveStandaloneScriptPath(flags.target) });
      process.stdout.write(JSON.stringify(check, null, 2) + "\n");
      return;
    }
    const staged = await stageRuntimeSelfUpdate({
      origin,
      targetPath: typeof flags.target === "string" ? flags.target : "",
      force: Boolean(flags.force),
    });
    let restartedProfiles = [];
    if (staged.updated && !flags["no-restart"]) {
      restartedProfiles = await restartInstalledDaemons({ quiet: true });
    }
    process.stdout.write(
      JSON.stringify(
        {
          ...staged,
          restartedProfiles,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "doctor") {
    const { client, profile } = requireClient(flags.profile);
    const [doctor, me, updateInfo] = await Promise.all([
      client.getDoctor().catch(optionalGatewayResult),
      client.getMe().catch(optionalGatewayResult),
      checkRuntimeUpdate({ origin: profile.url, targetPath: resolveStandaloneScriptPath(flags.script) }).catch(() => null),
    ]);
    process.stdout.write(
      JSON.stringify(
        {
          ok: Boolean(doctor?.ok || me?.bot?.id),
          profile: profile.profile,
          origin: profile.url,
          localSdkVersion: DUALLANE_AGENT_SDK_VERSION,
          runtimeUpdate: updateInfo,
          connection: me?.connection || null,
          bot: doctor?.bot || me?.bot || null,
          scopes: doctor?.scopes || me?.scopes || [],
          conversations: doctor?.conversations || [],
          recentDeliveries: doctor?.recentDeliveries || [],
          localTasks: (doctor?.bot?.id || profile.botId) ? readAgentTaskSummary({
            stateDir: path.join(getDaemonStateDir(), "tasks"), origin: profile.url, botId: doctor?.bot?.id || profile.botId,
          }) : null,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "mcp") {
    if (flags.task) {
      const server = createTaskBrokerMcpAdapter();
      delete process.env.DUALLANE_TASK_BROKER_URL;
      delete process.env.DUALLANE_TASK_BROKER_KEY;
      startDualLaneMcpStdioServer({ server, maxInputBytes: 128 * 1024 });
    } else {
      if (process.env.DUALLANE_TASK_BROKER_URL || process.env.DUALLANE_TASK_BROKER_KEY) throw new Error("Task adapters must use mcp --task; operator profiles are unavailable.");
      startDualLaneMcpStdioServer({ defaultProfile: flags.profile || "default" });
    }
    return;
  }

  if (subcommand === "operation") {
    const [taskId, operation, key] = positionals.slice(1);
    if (!taskId || !operation || !key) throw new Error("Usage: duallane-agent operation <taskId> <operation> <key>");
    const { client } = requireClient(flags.profile);
    const scoped = client.forTask((await client.getTask(taskId)).task);
    try { process.stdout.write(JSON.stringify(await scoped.getOperation(operation, key), null, 2) + "\n"); }
    finally { scoped.close(); }
    return;
  }

  if (subcommand === "send-card" || subcommand === "update-card") {
    const [target] = positionals.slice(1);
    if (!target || typeof flags["card-json"] !== "string") throw new Error("Card operations require an object ID and --card-json.");
    if (subcommand === "update-card" && typeof flags["task-id"] !== "string") throw new Error("update-card requires --task-id; legacy operator card updates are not exposed by this command.");
    const cardInput = JSON.parse(flags["card-json"]), card = buildAgentInteractiveCard(cardInput);
    const { client } = requireClient(flags.profile);
    const scoped = flags["task-id"] ? client.forTask((await client.getTask(flags["task-id"])).task) : client;
    try {
      const result = subcommand === "update-card" ? await scoped.updateFeishuCard(target, { card, expectedRevision: Number(flags["expected-revision"]), fallbackText: cardInput.fallbackText || cardInput.title })
        : await scoped.sendFeishuCard({ conversationId: target, card, fallbackText: cardInput.fallbackText || cardInput.title });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally { if (scoped !== client) scoped.close(); }
    return;
  }

  if (["capabilities", "task", "history", "search", "get-message", "members"].includes(subcommand)) {
    const { client } = requireClient(flags.profile);
    if (subcommand === "task") {
      const [action, id] = positionals.slice(1);
      if (!id || !["begin", "status", "cancel"].includes(action)) throw new Error("Usage: duallane-agent task begin <eventId> | status <taskId> | cancel <taskId>");
      const result = action === "begin" ? await client.createTask({ eventId: id }) : action === "cancel" ? await client.cancelAgentTask(id) : await client.getTask(id);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return;
    }
    if (subcommand === "capabilities" && !flags["task-id"]) {
      process.stdout.write(JSON.stringify(await client.getCapabilities(positionals[1]), null, 2) + "\n"); return;
    }
    if (typeof flags["task-id"] !== "string") throw new Error("This operation requires --task-id <server-task-id>.");
    const scoped = client.forTask((await client.getTask(flags["task-id"])).task);
    try {
      const history = {};
      for (const [flag, field] of [["before", "before"], ["query", "query"], ["author", "authorId"], ["start-time", "startTime"], ["end-time", "endTime"]]) {
        if (flags[flag] !== undefined) history[field] = flags[flag];
      }
      if (flags.limit !== undefined) history.limit = Number(flags.limit);
      const result = subcommand === "capabilities" ? await scoped.getCapabilities()
        : subcommand === "get-message" ? await scoped.getMessage(positionals[1])
          : subcommand === "members" ? await scoped.listMembers(positionals[1] || scoped.task.conversationId)
            : subcommand === "search" ? await scoped.searchMessages(positionals[1] || scoped.task.conversationId, history)
              : await scoped.listHistory(positionals[1] || scoped.task.conversationId, history);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally { scoped.close(); }
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
      client.listConversations().catch((error) => optionalGatewayResult(error, { conversations: [] })),
    ]);
    const remoteLatest = String(convs?.latestSdkVersion || "").trim();
    const updateAvailable =
      remoteLatest.length > 0 && compareRuntimeSemver(remoteLatest, DUALLANE_AGENT_SDK_VERSION) > 0;
    if (updateAvailable) {
      process.stderr.write(
        `[DualLane] New runtime available: v${DUALLANE_AGENT_SDK_VERSION} -> v${remoteLatest}. Run: duallane-agent update\n`
      );
    }
    process.stdout.write(
      JSON.stringify(
        {
          profile: profile.profile,
          origin: profile.url,
          sdkVersion: DUALLANE_AGENT_SDK_VERSION,
          latestSdkVersion: remoteLatest || DUALLANE_AGENT_SDK_VERSION,
          updateAvailable,
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
        .catch(optionalGatewayResult);
      if (retry && !retry.syncRequired) {
        res = retry;
      }
    }
    const events = Array.isArray(res?.events) ? res.events : [];
    if (flags.ack) {
      if (res?.syncRequired) throw new DualLaneAgentError("gateway.sync_required", "Event replay requires explicit resynchronization");
      for (const event of events) {
        await client.acknowledge({ eventId: event.eventId, sequence: event.sequence });
        updateProfileCursor(profileName, event.sequence);
      }
    }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "ack") {
    const { client } = requireClient(flags.profile);
    const result = await client.acknowledge({ eventId: positionals[1], sequence: Number(positionals[2]) });
    process.stdout.write(JSON.stringify({ ...result, profileCursorUnchanged: true }) + "\n");
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
        ack: false,
        onSyncRequired: () => { throw new DualLaneAgentError("gateway.sync_required", "Event replay requires explicit resynchronization"); },
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
        await client.setTyping(ev.conversationId).catch(optionalGatewayResult);
      }
      let context = null;
      if (ev.conversationId && profile.scopes?.includes("messages:read_context")) {
        context = await client.getContext(ev.conversationId, { limit: 15 }).catch(optionalGatewayResult);
      }
      return {
        status: "event",
        requiresAck: true,
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
                ack: false,
                async onEvent(event) {
                  if (filterConv && event.conversationId !== filterConv) {
                    return;
                  }
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  if (event.conversationId) {
                    await client.setTyping(event.conversationId).catch(optionalGatewayResult);
                  }
                  let context = null;
                  if (event.conversationId && profile.scopes?.includes("messages:read_context")) {
                    context = await client.getContext(event.conversationId, { limit: 15 }).catch(optionalGatewayResult);
                  }
                  setImmediate(() => client.stop());
                  resolve({
                    status: "event",
                    profile: profileName,
                    lastSequence: startSeq,
                    requiresAck: true,
                    transport: "ws",
                    event,
                    context,
                  });
                },
                async onSyncRequired() {
                  throw new DualLaneAgentError("gateway.sync_required", "Event replay requires explicit resynchronization");
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
    const content = typeof flags["content-json"] === "string" ? buildMessageContent(JSON.parse(flags["content-json"])) : undefined;
    if (!conversationId || (!text && !content)) {
      throw new Error("Usage: duallane-agent send <conversationId> <text> [--reply-to <msgId>]");
    }
    const { client } = requireClient(flags.profile);
    const scoped = flags["task-id"] ? client.forTask((await client.getTask(flags["task-id"])).task) : client;
    let res;
    try { res = await scoped.sendMessage({
      conversationId,
      text,
      content,
      replyToMessageId: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
    }); } finally { if (scoped !== client) scoped.close(); }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "send-file") {
    const [conversationId, filePath] = positionals.slice(1);
    if (!conversationId || !filePath) {
      throw new Error(
        "Usage: duallane-agent send-file <conversationId> <filePath> [--name <fileName>] [--mime <mimeType>] [--text <caption>] [--reply-to <msgId>]"
      );
    }
    const resolvedPath = path.resolve(filePath);
    const bytes = readBoundedFile(resolvedPath);
    const fileName =
      typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : path.basename(resolvedPath);
    const mimeType =
      typeof flags.mime === "string" && flags.mime.trim()
        ? flags.mime.trim()
        : inferMimeTypeFromFileName(fileName);
    const { client } = requireClient(flags.profile);
    const scoped = flags["task-id"] ? client.forTask((await client.getTask(flags["task-id"])).task) : client;
    let res;
    try { res = await scoped.sendFile({
      conversationId,
      bytes,
      fileName,
      mimeType,
      text: typeof flags.text === "string" ? flags.text : undefined,
      replyToMessageId: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
    }); } finally { if (scoped !== client) scoped.close(); }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "edit") {
    const [messageId, ...rest] = positionals.slice(1);
    const text = rest.join(" ").trim();
    const content = typeof flags["content-json"] === "string" ? buildMessageContent(JSON.parse(flags["content-json"])) : undefined;
    if (!messageId || (!text && !content)) {
      throw new Error("Usage: duallane-agent edit <messageId> <text> [--profile default]");
    }
    const { client } = requireClient(flags.profile);
    const scoped = flags["task-id"] ? client.forTask((await client.getTask(flags["task-id"])).task) : client;
    let res;
    const input = flags["task-id"] || content || flags["expected-version"] ? { plainText: text || undefined, content, expectedVersion: flags["expected-version"] } : text;
    try { res = await scoped.editMessage(messageId, input); }
    finally { if (scoped !== client) scoped.close(); }
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
    const scoped = flags["task-id"] ? client.forTask((await client.getTask(flags["task-id"])).task) : client;
    let res;
    try { res = await scoped.setTyping(conversationId, { state }); }
    finally { if (scoped !== client) scoped.close(); }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packDirectoryToZipBuffer(rootDir) {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        files.push({ name: rel, data: fs.readFileSync(full) });
      }
    }
  };
  walk(rootDir, "");
  if (files.length === 0) {
    throw new Error(`Directory "${rootDir}" contains no files to pack`);
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const raw = file.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32Buffer(raw);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(8, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0x5421, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(compressed.length, 18);
    localHdr.writeUInt32LE(raw.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, compressed);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(8, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0x5421, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(compressed.length, 20);
    centralHdr.writeUInt32LE(raw.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

  if (subcommand === "publish-mobile") {
    const [apkPath] = positionals.slice(1);
    if (!apkPath) {
      throw new Error(
        "Usage: duallane-agent publish-mobile <apkPath> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]"
      );
    }
    const apkBytes = fs.readFileSync(apkPath);
    let notes = typeof flags.notes === "string" ? flags.notes : undefined;
    if (typeof flags["notes-file"] === "string" && flags["notes-file"].trim()) {
      notes = fs.readFileSync(flags["notes-file"].trim(), "utf8");
    }
    const minNativeCode = flags["min-native-code"] ? Number(flags["min-native-code"]) : undefined;
    const { client } = requireClient(flags.profile);
    const res = await client.publishMobileRelease({
      apkBytes,
      version: typeof flags.version === "string" ? flags.version : undefined,
      versionCode: flags["version-code"] ? Number(flags["version-code"]) : undefined,
      minNativeVersionCode: minNativeCode,
      title: typeof flags.title === "string" ? flags.title : undefined,
      notes,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "publish-mobile-ota") {
    const [targetPath] = positionals.slice(1);
    if (!targetPath || typeof flags.version !== "string" || !flags.version.trim()) {
      throw new Error(
        "Usage: duallane-agent publish-mobile-ota <wwwDirOrZip> --version <semver> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]"
      );
    }
    const stat = fs.statSync(targetPath);
    const zipBytes = stat.isDirectory() ? packDirectoryToZipBuffer(targetPath) : fs.readFileSync(targetPath);
    let notes = typeof flags.notes === "string" ? flags.notes : undefined;
    if (typeof flags["notes-file"] === "string" && flags["notes-file"].trim()) {
      notes = fs.readFileSync(flags["notes-file"].trim(), "utf8");
    }
    const minNativeCode = flags["min-native-code"] ? Number(flags["min-native-code"]) : undefined;
    const { client } = requireClient(flags.profile);
    const res = await client.publishMobileOTA({
      zipBytes,
      version: flags.version.trim(),
      minNativeVersionCode: minNativeCode,
      title: typeof flags.title === "string" ? flags.title : undefined,
      notes,
    });
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

  if (subcommand === "daemon") {
    await manageDaemonCli(positionals.slice(1), flags);
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
    if (err?.code === "sdk.upgrade_required") {
      const { flags } = parseArgs(process.argv.slice(2));
      const profile = typeof flags.profile === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(flags.profile) ? flags.profile : "default";
      process.stderr.write(JSON.stringify({ code: err.code, retryable: false, updateCommand: runtimeUpgradeCommand(fileURLToPath(import.meta.url), profile, err.upgrade?.runtimeManifestUrl), upgrade: err.upgrade }) + "\n");
    }
    const operation = safeAgentOperationReference(err?.operation);
    if (operation || ["rejected", "unknown"].includes(err?.attemptOutcome)) process.stderr.write(JSON.stringify({ ...(operation ? { operation } : {}), ...(err?.attemptOutcome ? { attemptOutcome: err.attemptOutcome } : {}), safeToRetry: false }) + "\n");
    process.exitCode = 1;
  });
}
