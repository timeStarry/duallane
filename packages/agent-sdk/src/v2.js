import crypto from "node:crypto";
import { inferMimeTypeFromFileName } from "./index.js";

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

  async sendFile(conversationId, bytes, fileName, options = {}) {
    const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    const resolvedName = String(fileName || "attachment.bin").trim() || "attachment.bin";
    const mimeType = String(options.mimeType || inferMimeTypeFromFileName(resolvedName)).trim() || "application/octet-stream";
    const params = new URLSearchParams();
    params.set("fileName", resolvedName);
    params.set("mimeType", mimeType);
    if (options.text) params.set("text", String(options.text));
    if (options.replyToMessageId) params.set("replyToMessageId", String(options.replyToMessageId));
    if (options.clientMessageId) params.set("clientMessageId", String(options.clientMessageId));
    if (options.sendMessage === false) params.set("sendMessage", "false");
    const res = await this.fetch(
      `${this.baseUrl}/api/bot/v2/conversations/${encodeURIComponent(conversationId)}/files?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": mimeType,
        },
        body: raw,
      }
    );
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
