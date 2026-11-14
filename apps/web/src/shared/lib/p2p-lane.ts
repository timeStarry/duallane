/**
 * P2P Direct Lane (RAM-only, Zero Server Persistence)
 *
 * Security invariant:
 * - Room encryption key `#k=` lives strictly in URL fragment & browser RAM.
 * - Never persisted to IndexedDB, localStorage, or sent to any backend HTTP/log endpoint.
 * - All non-system WebSocket frames over `/ws/p2p/:roomId` are AES-256-GCM encrypted
 *   (`{ type: "secure", v: 1, channel: "ws-chat", nonce, ciphertext }`).
 */

export type P2PPeerPresenceStatus =
  | "idle"
  | "connecting"
  | "waiting_peer"
  | "peer_connected"
  | "room_not_found"
  | "room_full"
  | "disconnected"
  | "error";

export type P2PDeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "failed";

export interface P2PRoomSession {
  roomId: string;
  keyFingerprint: string;
  connectedPeers: number;
  remotePeerCount: number;
  status: P2PPeerPresenceStatus;
  shareUrl: string;
  expiresAt?: string;
  errorMessage?: string;
  keyMismatchWarning?: boolean;
}

export interface P2PChatMessage {
  id: string;
  senderName: string;
  isOwn: boolean;
  text: string;
  replyToId?: string;
  editedAt?: string;
  createdAt: string;
  deliveryStatus: P2PDeliveryStatus;
  reactions: Record<string, number>;
}

export type P2PDataEnvelope =
  | {
      kind: "chat";
      id: string;
      author: string;
      body: string;
      at: string;
      replyToId?: string;
    }
  | {
      kind: "chat-ack";
      messageId: string;
    };

export interface CreatedP2PRoomResponse {
  roomId: string;
  inviteLink: string;
  expiresAt: string;
  maxPeers: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function generateRoomKeyString(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(raw);
}

export async function deriveAesKey(keyStr: string): Promise<{ key: CryptoKey; fingerprint: string }> {
  const raw = fromBase64Url(keyStr);
  if (raw.byteLength !== 16 && raw.byteLength !== 24 && raw.byteLength !== 32) {
    throw new Error("无效的端到端加密密钥长度");
  }
  const buf = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buf).set(raw);
  const key = await crypto.subtle.importKey("raw", buf, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const fpBytes = new Uint8Array(hash).slice(0, 4);
  const fingerprint = Array.from(fpBytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
  return { key, fingerprint };
}

export async function encryptP2PBytes(
  key: CryptoKey,
  plaintext: string
): Promise<{ nonce: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    nonce: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(cipher)),
  };
}

export async function decryptP2PBytes(
  key: CryptoKey,
  nonce: string,
  ciphertext: string
): Promise<string> {
  const ivRaw = fromBase64Url(nonce);
  const ctRaw = fromBase64Url(ciphertext);
  const iv = new ArrayBuffer(ivRaw.byteLength);
  new Uint8Array(iv).set(ivRaw);
  const ct = new ArrayBuffer(ctRaw.byteLength);
  new Uint8Array(ct).set(ctRaw);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

export async function encryptP2PPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const { nonce, ciphertext } = await encryptP2PBytes(key, plaintext);
  return JSON.stringify({ iv: nonce, ct: ciphertext });
}

export async function decryptP2PPayload(key: CryptoKey, envelopeJson: string): Promise<string> {
  const parsed = JSON.parse(envelopeJson) as { iv: string; ct: string };
  return decryptP2PBytes(key, parsed.iv, parsed.ct);
}

export function extractP2PRoomFromUrl(
  loc: Pick<Location, "pathname" | "hash"> = window.location
): { roomId: string; keyStr: string } | null {
  const match = loc.pathname.match(/^\/(?:direct|r)\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const hash = loc.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const keyStr = (params.get("k") || "").trim();
  if (!keyStr) return null;
  return { roomId: match[1], keyStr };
}

export function buildP2PShareUrl(roomId: string, keyStr: string, origin = window.location.origin): string {
  return `${origin}/direct/${encodeURIComponent(roomId)}#k=${keyStr}`;
}

export async function createRemoteP2PRoom(): Promise<CreatedP2PRoomResponse> {
  const response = await fetch("/api/p2p/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPeers: 2 }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("直连信令服务返回异常响应，请检查 Go P2P 服务是否已启动");
    }
  }
  if (!response.ok || typeof parsed.roomId !== "string" || !parsed.roomId) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : `创建直连房间失败 (HTTP ${response.status})`;
    throw new Error(errMsg);
  }
  return {
    roomId: parsed.roomId,
    inviteLink: typeof parsed.inviteLink === "string" ? parsed.inviteLink : "",
    expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : "",
    maxPeers: typeof parsed.maxPeers === "number" ? parsed.maxPeers : 2,
  };
}

export interface P2PRoomTransportCallbacks {
  onPresenceChange: (update: {
    status: P2PPeerPresenceStatus;
    connectedPeers: number;
    remotePeerCount: number;
    errorMessage?: string;
  }) => void;
  onIncomingChat: (msg: {
    id: string;
    author: string;
    body: string;
    at: string;
    replyToId?: string;
  }) => void;
  onDeliveryAck: (messageId: string) => void;
  onKeyMismatch: () => void;
}

export interface P2PRoomTransport {
  isOpen: () => boolean;
  sendChat: (msg: {
    id: string;
    author: string;
    body: string;
    at: string;
    replyToId?: string;
  }) => Promise<boolean>;
  close: () => void;
}

function parseEnvelope(rawPlaintext: string): P2PDataEnvelope | null {
  try {
    const obj = JSON.parse(rawPlaintext) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    if (
      obj.kind === "chat" &&
      typeof obj.id === "string" &&
      obj.id.length > 0 &&
      typeof obj.author === "string" &&
      obj.author.length > 0 &&
      typeof obj.body === "string" &&
      obj.body.length > 0 &&
      typeof obj.at === "string"
    ) {
      return {
        kind: "chat",
        id: obj.id,
        author: obj.author,
        body: obj.body,
        at: obj.at,
        replyToId: typeof obj.replyToId === "string" ? obj.replyToId : undefined,
      };
    }
    if (obj.kind === "chat-ack" && typeof obj.messageId === "string" && obj.messageId.length > 0) {
      return { kind: "chat-ack", messageId: obj.messageId };
    }
    return null;
  } catch {
    return null;
  }
}

export function connectP2PRoomTransport(
  roomId: string,
  aesKey: CryptoKey,
  callbacks: P2PRoomTransportCallbacks
): P2PRoomTransport {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}`;
  const socket = new WebSocket(wsUrl);

  let selfPeerId = "";
  let closedIntentionally = false;
  let terminalRoomError = false;
  let latestTotalPeers = 1;
  let latestRemotePeers = 0;

  const sendEncryptedEnvelope = async (envelope: P2PDataEnvelope): Promise<boolean> => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const { nonce, ciphertext } = await encryptP2PBytes(aesKey, JSON.stringify(envelope));
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(
      JSON.stringify({
        type: "secure",
        v: 1,
        channel: "ws-chat",
        nonce,
        ciphertext,
      })
    );
    return true;
  };

  const applyPeerList = (rawPeers: unknown) => {
    if (!Array.isArray(rawPeers)) return;
    const peerIds = rawPeers
      .map((item) =>
        item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : ""
      )
      .filter(Boolean);
    latestTotalPeers = Math.max(1, peerIds.length);
    latestRemotePeers = selfPeerId
      ? peerIds.filter((id) => id !== selfPeerId).length
      : Math.max(0, peerIds.length - 1);
    callbacks.onPresenceChange({
      status: latestRemotePeers > 0 ? "peer_connected" : "waiting_peer",
      connectedPeers: latestTotalPeers,
      remotePeerCount: latestRemotePeers,
    });
  };

  socket.addEventListener("open", () => {
    if (selfPeerId) return;
    callbacks.onPresenceChange({
      status: "waiting_peer",
      connectedPeers: 1,
      remotePeerCount: 0,
    });
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.type === "system") {
      const sysEvent = String(frame.event || "");
      if (sysEvent === "joined") {
        if (typeof frame.peerId === "string" && frame.peerId) {
          selfPeerId = frame.peerId;
        }
        applyPeerList(frame.peers);
        return;
      }
      if (sysEvent === "peer-joined" || sysEvent === "peer-list" || sysEvent === "peer-left") {
        applyPeerList(frame.peers);
        return;
      }
      if (sysEvent === "room-not-found") {
        terminalRoomError = true;
        callbacks.onPresenceChange({
          status: "room_not_found",
          connectedPeers: 0,
          remotePeerCount: 0,
          errorMessage: "该直连房间不存在或已过期，请新建房间并重新分享完整链接。",
        });
        return;
      }
      if (sysEvent === "room-full") {
        terminalRoomError = true;
        callbacks.onPresenceChange({
          status: "room_full",
          connectedPeers: 2,
          remotePeerCount: 0,
          errorMessage: "该直连房间已满（限双人点对点端到端加密），请新建房间。",
        });
        return;
      }
      return;
    }

    if (
      frame.type === "secure" &&
      frame.v === 1 &&
      frame.channel === "ws-chat" &&
      typeof frame.nonce === "string" &&
      typeof frame.ciphertext === "string"
    ) {
      void (async () => {
        let decrypted: string;
        try {
          decrypted = await decryptP2PBytes(aesKey, frame.nonce as string, frame.ciphertext as string);
        } catch {
          callbacks.onKeyMismatch();
          return;
        }
        const parsed = parseEnvelope(decrypted);
        if (!parsed) return;
        if (parsed.kind === "chat") {
          callbacks.onIncomingChat({
            id: parsed.id,
            author: parsed.author,
            body: parsed.body,
            at: parsed.at,
            replyToId: parsed.replyToId,
          });
          void sendEncryptedEnvelope({ kind: "chat-ack", messageId: parsed.id });
        } else if (parsed.kind === "chat-ack") {
          callbacks.onDeliveryAck(parsed.messageId);
        }
      })();
    }
  });

  socket.addEventListener("error", () => {
    if (closedIntentionally || terminalRoomError) return;
    callbacks.onPresenceChange({
      status: "error",
      connectedPeers: 0,
      remotePeerCount: 0,
      errorMessage: "直连信令连接中断，请确认 Go P2P 服务在线。",
    });
  });

  socket.addEventListener("close", () => {
    if (closedIntentionally || terminalRoomError) return;
    callbacks.onPresenceChange({
      status: "disconnected",
      connectedPeers: 0,
      remotePeerCount: 0,
      errorMessage: "直连房间连接已关闭，可重新加入或新建房间。",
    });
  });

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    sendChat: (msg) =>
      sendEncryptedEnvelope({
        kind: "chat",
        id: msg.id,
        author: msg.author,
        body: msg.body,
        at: msg.at,
        replyToId: msg.replyToId,
      }),
    close: () => {
      closedIntentionally = true;
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "leave" }));
        }
        socket.close(1000, "leave");
      } catch {
        // Ignore socket teardown errors
      }
    },
  };
}
