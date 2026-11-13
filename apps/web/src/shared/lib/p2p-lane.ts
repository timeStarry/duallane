/**
 * P2P Direct Lane (RAM-only, Zero Server Persistence)
 *
 * Security invariant:
 * - Room encryption key `#k=` lives strictly in URL fragment & browser RAM.
 * - Never persisted to IndexedDB, localStorage, or sent to any backend HTTP/log endpoint.
 */

export interface P2PRoomSession {
  roomId: string;
  keyFingerprint: string;
  connectedPeers: number;
  status: "idle" | "connecting" | "connected" | "error";
  shareUrl: string;
}

export interface P2PChatMessage {
  id: string;
  senderName: string;
  isOwn: boolean;
  text: string;
  replyToId?: string;
  editedAt?: string;
  createdAt: string;
  reactions: Record<string, number>;
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
  const buf = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buf).set(raw);
  const key = await crypto.subtle.importKey("raw", buf, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const fpBytes = new Uint8Array(hash).slice(0, 4);
  const fingerprint = Array.from(fpBytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
  return { key, fingerprint };
}

export async function encryptP2PPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return JSON.stringify({
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(cipher)),
  });
}

export async function decryptP2PPayload(key: CryptoKey, envelopeJson: string): Promise<string> {
  const parsed = JSON.parse(envelopeJson) as { iv: string; ct: string };
  const ivRaw = fromBase64Url(parsed.iv);
  const ctRaw = fromBase64Url(parsed.ct);
  const iv = new ArrayBuffer(ivRaw.byteLength);
  new Uint8Array(iv).set(ivRaw);
  const ct = new ArrayBuffer(ctRaw.byteLength);
  new Uint8Array(ct).set(ctRaw);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

export function extractP2PRoomFromUrl(): { roomId: string; keyStr: string } | null {
  const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const keyStr = params.get("k") || "";
  if (!keyStr) return null;
  return { roomId: match[1], keyStr };
}
