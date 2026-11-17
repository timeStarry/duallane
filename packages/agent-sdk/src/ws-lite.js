import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";

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
