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

export interface P2PFileAttachment {
  fileName: string;
  mimeType: string;
  byteSize: number;
  blobUrl: string;
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
  attachment?: P2PFileAttachment;
}

export const P2P_FILE_CHUNK_BYTES = 6144;
export const P2P_MAX_FILE_BYTES = 8 * 1024 * 1024;

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
      kind: "file-start";
      id: string;
      author: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
      totalChunks: number;
      caption?: string;
      at: string;
    }
  | {
      kind: "file-chunk";
      id: string;
      index: number;
      data: string;
    }
  | {
      kind: "file-end";
      id: string;
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
  if (!str || !/^[A-Za-z0-9_-]+$/.test(str) || str.length % 4 === 1) {
    throw new Error("无效的 Base64URL 端到端加密密钥编码");
  }
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function safeInlineImageMime(mimeType: string): boolean {
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
  );
}

export function createSafeP2PBlobUrl(bytes: Uint8Array, mimeType: string): string {
  const safeType = safeInlineImageMime(mimeType) ? mimeType : "application/octet-stream";
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: safeType }));
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

export function hasP2PRoomInUrl(
  loc: Pick<Location, "pathname" | "hash"> = window.location
): boolean {
  if (/^\/(?:direct|r)(?:\/|$)/.test(loc.pathname)) return true;
  const hash = loc.hash.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  return params.has("k");
}

export function scrubP2PRoomFromUrl(targetPath = "/"): void {
  if (typeof window === "undefined") return;
  if (hasP2PRoomInUrl(window.location)) {
    window.history.replaceState(null, "", targetPath);
  }
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
  onIncomingFile: (fileMsg: {
    id: string;
    author: string;
    caption: string;
    at: string;
    attachment: P2PFileAttachment;
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
  sendFile: (payload: {
    id: string;
    author: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    caption?: string;
    at: string;
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
    if (
      obj.kind === "file-start" &&
      typeof obj.id === "string" &&
      obj.id.length > 0 &&
      typeof obj.author === "string" &&
      typeof obj.fileName === "string" &&
      obj.fileName.length > 0 &&
      typeof obj.mimeType === "string" &&
      typeof obj.byteSize === "number" &&
      obj.byteSize >= 0 &&
      obj.byteSize <= P2P_MAX_FILE_BYTES &&
      typeof obj.totalChunks === "number" &&
      obj.totalChunks >= 0 &&
      obj.totalChunks <= Math.ceil(P2P_MAX_FILE_BYTES / P2P_FILE_CHUNK_BYTES) + 1 &&
      typeof obj.at === "string"
    ) {
      return {
        kind: "file-start",
        id: obj.id,
        author: obj.author,
        fileName: obj.fileName,
        mimeType: obj.mimeType,
        byteSize: obj.byteSize,
        totalChunks: obj.totalChunks,
        caption: typeof obj.caption === "string" ? obj.caption : undefined,
        at: obj.at,
      };
    }
    if (
      obj.kind === "file-chunk" &&
      typeof obj.id === "string" &&
      obj.id.length > 0 &&
      typeof obj.index === "number" &&
      obj.index >= 0 &&
      typeof obj.data === "string"
    ) {
      return {
        kind: "file-chunk",
        id: obj.id,
        index: obj.index,
        data: obj.data,
      };
    }
    if (obj.kind === "file-end" && typeof obj.id === "string" && obj.id.length > 0) {
      return { kind: "file-end", id: obj.id };
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
  let incomingChain = Promise.resolve();

  const incomingFiles = new Map<
    string,
    {
      author: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
      totalChunks: number;
      caption: string;
      at: string;
      chunks: Array<Uint8Array | undefined>;
      receivedChunks: number;
      ended: boolean;
    }
  >();

  const tryFinalizeIncomingFile = (transferId: string) => {
    const entry = incomingFiles.get(transferId);
    if (!entry || !entry.ended || entry.receivedChunks !== entry.totalChunks) {
      return;
    }
    incomingFiles.delete(transferId);
    const merged = new Uint8Array(entry.byteSize);
    let offset = 0;
    for (let i = 0; i < entry.totalChunks; i++) {
      const part = entry.chunks[i];
      if (!part || offset + part.byteLength > entry.byteSize) return;
      merged.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== entry.byteSize) return;
    const blobUrl = createSafeP2PBlobUrl(merged, entry.mimeType);
    callbacks.onIncomingFile({
      id: transferId,
      author: entry.author,
      caption: entry.caption,
      at: entry.at,
      attachment: {
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        byteSize: entry.byteSize,
        blobUrl,
      },
    });
    void sendEncryptedEnvelope({ kind: "chat-ack", messageId: transferId });
  };

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
      const nonce = frame.nonce;
      const ciphertext = frame.ciphertext;
      incomingChain = incomingChain
        .then(async () => {
          let decrypted: string;
          try {
            decrypted = await decryptP2PBytes(aesKey, nonce, ciphertext);
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
          } else if (parsed.kind === "file-start") {
            incomingFiles.set(parsed.id, {
              author: parsed.author,
              fileName: parsed.fileName,
              mimeType: parsed.mimeType,
              byteSize: parsed.byteSize,
              totalChunks: parsed.totalChunks,
              caption: parsed.caption || "",
              at: parsed.at,
              chunks: new Array<Uint8Array | undefined>(parsed.totalChunks),
              receivedChunks: 0,
              ended: parsed.totalChunks === 0,
            });
            if (parsed.totalChunks === 0) {
              tryFinalizeIncomingFile(parsed.id);
            }
          } else if (parsed.kind === "file-chunk") {
            const entry = incomingFiles.get(parsed.id);
            if (!entry || parsed.index >= entry.totalChunks) return;
            try {
              const rawPart = fromBase64Url(parsed.data);
              if (!entry.chunks[parsed.index]) {
                entry.chunks[parsed.index] = rawPart;
                entry.receivedChunks += 1;
              }
              tryFinalizeIncomingFile(parsed.id);
            } catch {
              incomingFiles.delete(parsed.id);
            }
          } else if (parsed.kind === "file-end") {
            const entry = incomingFiles.get(parsed.id);
            if (!entry) return;
            entry.ended = true;
            tryFinalizeIncomingFile(parsed.id);
          } else if (parsed.kind === "chat-ack") {
            callbacks.onDeliveryAck(parsed.messageId);
          }
        })
        .catch(() => {});
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
    sendFile: async (payload) => {
      if (payload.bytes.byteLength > P2P_MAX_FILE_BYTES) {
        return false;
      }
      const totalChunks =
        payload.bytes.byteLength === 0
          ? 0
          : Math.ceil(payload.bytes.byteLength / P2P_FILE_CHUNK_BYTES);
      const started = await sendEncryptedEnvelope({
        kind: "file-start",
        id: payload.id,
        author: payload.author,
        fileName: payload.fileName,
        mimeType: payload.mimeType || "application/octet-stream",
        byteSize: payload.bytes.byteLength,
        totalChunks,
        caption: payload.caption,
        at: payload.at,
      });
      if (!started) return false;
      for (let i = 0; i < totalChunks; i++) {
        const start = i * P2P_FILE_CHUNK_BYTES;
        const end = Math.min(payload.bytes.byteLength, start + P2P_FILE_CHUNK_BYTES);
        const slice = payload.bytes.subarray(start, end);
        const sentChunk = await sendEncryptedEnvelope({
          kind: "file-chunk",
          id: payload.id,
          index: i,
          data: toBase64Url(slice),
        });
        if (!sentChunk) return false;
      }
      return sendEncryptedEnvelope({
        kind: "file-end",
        id: payload.id,
      });
    },
    close: () => {
      closedIntentionally = true;
      incomingFiles.clear();
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
