import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Check,
  Clipboard,
  Download,
  FileCheck2,
  FileUp,
  History,
  Link2,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sun,
  Trash2,
  UsersRound,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

type Lane = "entry" | "p2p" | "workspace-dev";
type P2pStep = "name" | "waiting" | "chat" | "ended" | "invalid-room";
type ConnectionState = "idle" | "connecting" | "connected" | "offline" | "error";
type P2pTransportMode = "waiting" | "direct" | "relay-text" | "offline" | "error";
type DataChannelState = "idle" | RTCDataChannelState;
type P2pRoomIssue = "" | "not-found" | "full" | "missing-key";
type CopyState = "idle" | "copied" | "failed";
type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type SecureChannel = "signal" | "ws-chat" | "profile";
type SecureEnvelope = {
  type: "secure";
  v: 1;
  channel: SecureChannel;
  nonce: string;
  ciphertext: string;
};
type SecureKeys = Record<SecureChannel, CryptoKey>;
type IceServersResponse = {
  iceServers?: RTCIceServer[];
};
type FileTransferStatus = "offered" | "waiting" | "sending" | "receiving" | "complete" | "rejected" | "failed";
type FileTransfer = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: FileTransferStatus;
  progress: number;
  downloadUrl?: string;
  failureReason?: string;
  riskNote?: string;
  retryable?: boolean;
};
type Message = {
  id: string;
  author: string;
  body: string;
  lane: "p2p" | "workspace";
  at: string;
  self?: boolean;
  fileName?: string;
  fileTransfer?: FileTransfer;
};
type Peer = {
  id: string;
  name?: string;
  self?: boolean;
};
type PeerProfile = {
  kind: "profile";
  peerId?: string;
  name: string;
};
type ChatEnvelope = Extract<DataEnvelope, { kind: "chat" }>;
type SignalMessage = {
  signal?: "offer" | "answer" | "ice";
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type PeerSocketMessage = {
  author: string;
  body?: string;
  peers?: Peer[];
  peerId?: string;
  from?: Peer;
  signal?: SignalMessage;
  secure?: SecureEnvelope;
  systemEvent?: "room-not-found" | "room-full" | "joined" | "peer-joined" | "peer-left" | "peer-list";
};
type DataEnvelope =
  | { kind: "chat"; id: string; author: string; body: string; at: string }
  | { kind: "file-offer"; transferId: string; author: string; name: string; size: number; mimeType: string }
  | { kind: "file-accept"; transferId: string }
  | { kind: "file-reject"; transferId: string; reason?: string }
  | { kind: "file-chunk"; transferId: string; index: number; total: number; data: string }
  | { kind: "file-complete"; transferId: string };
type IncomingFileBuffer = {
  name: string;
  size: number;
  mimeType: string;
  chunks: Uint8Array<ArrayBuffer>[];
  receivedBytes: number;
  blob?: Blob;
};
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};
type RoomDetail = {
  label: string;
  value: string;
};
type SavedP2pSession = {
  id: string;
  roomId: string;
  displayName: string;
  savedAt: string;
  messages: Message[];
};
type ConnectionAdvice = {
  title: string;
  body: string;
  items: string[];
};

const FILE_CHUNK_SIZE = 16 * 1024;
const P2P_LARGE_FILE_WARNING_BYTES = 100 * 1024 * 1024;
const P2P_MAX_FILE_BYTES = 512 * 1024 * 1024;
const P2P_SAVED_SESSIONS_KEY = "duallane-p2p-sessions";
const THEME_STORAGE_KEY = "duallane-theme-mode";
const P2P_SECRET_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const SECURE_ENVELOPE_VERSION = 1;
const P2P_MAX_PARTICIPANTS = 2;
const P2P_DEFAULT_PARTICIPANTS = 2;

const secureChannels: SecureChannel[] = ["signal", "ws-chat", "profile"];

function getStoredThemeMode(): ThemeMode {
  if (typeof localStorage === "undefined") {
    return "system";
  }

  const storedMode = localStorage.getItem(THEME_STORAGE_KEY);
  return storedMode === "light" || storedMode === "dark" || storedMode === "system" ? storedMode : "system";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function normalizePassphrase(value: string) {
  return value.trim().normalize("NFKC");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function generateRoomSecret() {
  const bytes = new Uint8Array(P2P_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function getRoomSecretFromHash(hash = window.location.hash) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const secret = params.get("k");
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : "";
}

function withRoomSecret(link: string, secret: string) {
  const url = new URL(link);
  url.hash = new URLSearchParams({ k: secret }).toString();
  return url.toString();
}

async function deriveP2pKeys(roomId: string, secret: string, passphrase: string): Promise<SecureKeys> {
  const encoder = new TextEncoder();
  const ikm = base64UrlToBytes(secret);
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = encoder.encode(`duallane-p2p:${roomId}:${normalizePassphrase(passphrase)}`);
  const entries = await Promise.all(
    secureChannels.map(async (channel) => {
      const key = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: encoder.encode(`duallane-p2p-v1:${channel}`)
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      return [channel, key] as const;
    })
  );
  return Object.fromEntries(entries) as SecureKeys;
}

async function getP2pVerificationCode(roomId: string, secret: string, passphrase: string) {
  const encoder = new TextEncoder();
  const ikm = base64UrlToBytes(secret);
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`duallane-p2p:${roomId}:${normalizePassphrase(passphrase)}`),
      info: encoder.encode("duallane-p2p-v1:verify")
    },
    baseKey,
    32
  );
  const value = new DataView(bits).getUint32(0);
  return String(value % 1_000_000).padStart(6, "0");
}

async function encryptSecurePayload(keys: SecureKeys, channel: SecureChannel, payload: unknown): Promise<SecureEnvelope> {
  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, keys[channel], plaintext);
  return {
    type: "secure",
    v: SECURE_ENVELOPE_VERSION,
    channel,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

async function decryptSecurePayload<T>(keys: SecureKeys, envelope: SecureEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.nonce) },
    keys[envelope.channel],
    base64UrlToBytes(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

function makeId(prefix: string) {
  return `${prefix}-${randomId()}`;
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "请求失败"}`);
  }
  return (await response.json()) as T;
}

function getWsUrl(roomId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}`;
}

function getInviteLink(roomId: string) {
  return `${window.location.origin}/?lane=p2p&room=${encodeURIComponent(roomId)}`;
}

async function getIceServers() {
  try {
    const data = await fetch("/api/p2p/ice-servers").then((response) => parseJson<IceServersResponse>(response));
    return Array.isArray(data.iceServers) && data.iceServers.length > 0
      ? data.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];
  } catch {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to the legacy path below for LAN HTTP browsers.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function getO2OState(peerCount: number, socketState: ConnectionState, rtcState: ConnectionState): ConnectionState {
  if (socketState === "error" || socketState === "connecting") {
    return socketState;
  }
  if (socketState === "connected" && peerCount >= 2) {
    return "connected";
  }
  if (peerCount >= 2) {
    return rtcState === "error" || rtcState === "offline" ? rtcState : "connecting";
  }
  if (socketState === "offline") {
    return "offline";
  }
  return "idle";
}

function getP2pTransportMode(
  peerCount: number,
  socketState: ConnectionState,
  rtcState: ConnectionState
): P2pTransportMode {
  if (rtcState === "connected") {
    return "direct";
  }
  if (socketState === "error") {
    return "error";
  }
  if (socketState === "connected" && peerCount >= 2) {
    return "relay-text";
  }
  if (rtcState === "error") {
    return "error";
  }
  if (socketState === "connected") {
    return "waiting";
  }
  if (socketState === "offline" || rtcState === "offline") {
    return "offline";
  }
  return "waiting";
}

function connectionStateLabel(state: ConnectionState) {
  const labels: Record<ConnectionState, string> = {
    idle: "等待中",
    connecting: "连接中",
    connected: "已连接",
    offline: "离线",
    error: "异常"
  };

  return labels[state];
}

function p2pTransportModeLabel(mode: P2pTransportMode) {
  const labels: Record<P2pTransportMode, string> = {
    waiting: "等待连接路径",
    direct: "浏览器直连",
    "relay-text": "临时中转文本",
    offline: "连接已断开",
    error: "连接异常"
  };

  return labels[mode];
}

function p2pTransportModeDescription(mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return "消息和文件走浏览器直连。";
  }
  if (mode === "relay-text") {
    return "文本暂走信令中转。文件等待直连通道。";
  }
  if (mode === "offline") {
    return "对方离线或连接已断开。";
  }
  if (mode === "error") {
    return "连接异常，请检查网络或重建房间。";
  }
  return peerCount >= 2 ? "正在协商直连路径。" : "等待对方加入房间。";
}

function p2pTrustText(mode: P2pTransportMode) {
  if (mode === "direct") {
    return "当前为浏览器直连。服务器不保存对话内容";
  }
  if (mode === "relay-text") {
    return "当前文本走临时中转。服务器不保存对话内容";
  }
  return "服务器不保存对话内容";
}

function getConnectionAdvice({
  roomIssue,
  peerCount,
  socketState,
  rtcState,
  mode
}: {
  roomIssue: P2pRoomIssue;
  peerCount: number;
  socketState: ConnectionState;
  rtcState: ConnectionState;
  mode: P2pTransportMode;
}): ConnectionAdvice | null {
  if (roomIssue === "not-found") {
    return {
      title: "房间不存在或已过期",
      body: "这个邀请链接已经不可用。请让发起方重新创建房间，并复制新的邀请链接。",
      items: ["返回后重新创建房间", "确认复制的是最新链接", "房间开启后让双方都保持页面打开"]
    };
  }
  if (roomIssue === "full") {
    return {
      title: "房间已满",
      body: "一对一直连房间只允许两端加入。请确认是否已经有另一端在线，或重新创建一个房间。",
      items: ["关闭多余窗口后重试", "需要新的对象时重新创建房间", "多人协作请改用工作区"]
    };
  }
  if (mode === "error" || socketState === "error" || rtcState === "error") {
    return {
      title: "连接异常",
      body: "信令或浏览器直连协商失败。当前页面可以保留消息记录，但建议重建连接路径。",
      items: ["让对方保持页面打开并刷新一次", "复制新链接重新进入房间", "需要稳定留存和文件中转时改用工作区"]
    };
  }
  if (mode === "offline") {
    return {
      title: "对方离线或连接已断开",
      body: "直连会话依赖双方页面同时在线。任一方关闭页面、休眠或网络切换都会中断。",
      items: ["让对方重新打开同一邀请链接", "无法恢复时复制新链接重建房间", "重要文件建议改用工作区中转"]
    };
  }
  if (mode === "relay-text" && peerCount >= 2) {
    return {
      title: "文件通道还未就绪",
      body: "文本可以临时通过信令中转，文件需要等待浏览器直连数据通道建立。",
      items: ["双方保持页面打开 10 到 20 秒", "检查浏览器是否禁用了 WebRTC", "仍无法建立时改用工作区中转文件"]
    };
  }
  if (mode === "waiting") {
    return {
      title: "等待对方加入",
      body: "复制邀请链接给对方。对方打开页面并输入名称后，系统会自动协商直连路径。",
      items: ["确认对方打开的是最新链接", "让对方不要关闭页面", "房间过期后需要重新创建"]
    };
  }
  return null;
}

function transferStatusLabel(status: FileTransferStatus) {
  const labels: Record<FileTransferStatus, string> = {
    offered: "等待确认",
    waiting: "等待对方",
    sending: "发送中",
    receiving: "接收中",
    complete: "已完成",
    rejected: "已拒绝",
    failed: "失败"
  };

  return labels[status];
}

function getFileMessageBody(transfer: FileTransfer) {
  if (transfer.status === "offered") {
    return "收到一个加密文件传输请求。";
  }
  if (transfer.status === "waiting") {
    return "文件请求已发送，等待对方接受。";
  }
  if (transfer.status === "sending") {
    return "正在发送加密文件，请双方保持页面在线。";
  }
  if (transfer.status === "receiving") {
    return "正在接收加密文件，请双方保持页面在线。";
  }
  if (transfer.status === "complete") {
    return "文件传输已完成。";
  }
  if (transfer.status === "rejected") {
    return "文件传输已被拒绝。";
  }
  return transfer.failureReason ? `文件传输失败：${transfer.failureReason}` : "文件传输失败。";
}

function getTransferProgress(doneBytes: number, totalBytes: number) {
  if (totalBytes <= 0) {
    return 100;
  }
  return Math.min(100, Math.round((doneBytes / totalBytes) * 100));
}

function parseDataEnvelope(raw: string): DataEnvelope | null {
  try {
    return parseDataEnvelopeValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseDataEnvelopeValue(value: unknown): DataEnvelope | null {
  const envelope = value as Partial<DataEnvelope>;
  if (!envelope || typeof envelope !== "object" || typeof envelope.kind !== "string") {
    return null;
  }

  if (
    envelope.kind === "chat" &&
    typeof envelope.id === "string" &&
    typeof envelope.author === "string" &&
    typeof envelope.body === "string" &&
    typeof envelope.at === "string"
  ) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-offer" &&
    typeof envelope.transferId === "string" &&
    typeof envelope.author === "string" &&
    typeof envelope.name === "string" &&
    typeof envelope.size === "number" &&
    typeof envelope.mimeType === "string"
  ) {
    return envelope as DataEnvelope;
  }

  if (
    (envelope.kind === "file-accept" || envelope.kind === "file-complete") &&
    typeof envelope.transferId === "string"
  ) {
    return envelope as DataEnvelope;
  }

  if (envelope.kind === "file-reject" && typeof envelope.transferId === "string") {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-chunk" &&
    typeof envelope.transferId === "string" &&
    typeof envelope.index === "number" &&
    typeof envelope.total === "number" &&
    typeof envelope.data === "string"
  ) {
    return envelope as DataEnvelope;
  }

  return null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function waitForBufferedAmount(channel: RTCDataChannel) {
  if (channel.bufferedAmount < 1024 * 1024) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      if (channel.bufferedAmount < 512 * 1024) {
        window.clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

function getFileRiskNote(fileSize: number) {
  if (fileSize >= P2P_LARGE_FILE_WARNING_BYTES) {
    return `大文件 ${formatBytes(fileSize)} 对网络稳定性要求较高，中断后需要重新发送。`;
  }
  return undefined;
}

function getFileLimitText() {
  return `当前直连通道建议单个文件不超过 ${formatBytes(P2P_MAX_FILE_BYTES)}。`;
}

function sanitizeMessagesForStorage(messages: Message[]) {
  return messages.map((message) => ({
    ...message,
    fileTransfer: message.fileTransfer
      ? {
          ...message.fileTransfer,
          downloadUrl: undefined
        }
      : undefined
  }));
}

function getSavedP2pSessions(): SavedP2pSession[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  const sessions: SavedP2pSession[] = [];
  try {
    const stored = localStorage.getItem(P2P_SAVED_SESSIONS_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      for (const session of parsed) {
        if (
          session &&
          typeof session.id === "string" &&
          typeof session.roomId === "string" &&
          typeof session.savedAt === "string" &&
          Array.isArray(session.messages)
        ) {
          sessions.push({
            id: session.id,
            roomId: session.roomId,
            displayName: typeof session.displayName === "string" ? session.displayName : "本机",
            savedAt: session.savedAt,
            messages: session.messages as Message[]
          });
        }
      }
    }
  } catch {
    // Ignore malformed local records and keep the UI usable.
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || key === P2P_SAVED_SESSIONS_KEY || !key.startsWith("duallane-p2p-")) {
      continue;
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(parsed)) {
        continue;
      }
      const roomId = key.replace("duallane-p2p-", "") || "legacy";
      const legacyId = `legacy-${roomId}`;
      if (!sessions.some((session) => session.id === legacyId)) {
        sessions.push({
          id: legacyId,
          roomId,
          displayName: "本机",
          savedAt: new Date(0).toISOString(),
          messages: parsed as Message[]
        });
      }
    } catch {
      // Ignore malformed legacy records.
    }
  }

  return sessions.sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt));
}

function writeSavedP2pSessions(sessions: SavedP2pSession[]) {
  localStorage.setItem(P2P_SAVED_SESSIONS_KEY, JSON.stringify(sessions));
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    return "早期记录";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    themeMode === "system" ? getSystemTheme() : themeMode
  );
  const [lane, setLane] = useState<Lane>("entry");
  const [p2pStep, setP2pStep] = useState<P2pStep>("name");
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [p2pStatus, setP2pStatus] = useState<ConnectionState>("idle");
  const [p2pError, setP2pError] = useState("");
  const [p2pRoomIssue, setP2pRoomIssue] = useState<P2pRoomIssue>("");
  const [roomSecret, setRoomSecret] = useState("");
  const [securityPassphrase, setSecurityPassphrase] = useState("");
  const [p2pParticipantCount, setP2pParticipantCount] = useState(P2P_DEFAULT_PARTICIPANTS);
  const [verificationCode, setVerificationCode] = useState("");
  const [p2pMessages, setP2pMessages] = useState<Message[]>([]);
  const [p2pDraft, setP2pDraft] = useState("");
  const [sessionSaved, setSessionSaved] = useState<"idle" | "saved">("idle");
  const [savedP2pSessions, setSavedP2pSessions] = useState<SavedP2pSession[]>(() => getSavedP2pSessions());
  const [selectedSavedSessionId, setSelectedSavedSessionId] = useState("");
  const [savedSessionsOpen, setSavedSessionsOpen] = useState(false);
  const [p2pPeers, setP2pPeers] = useState<Peer[]>([]);
  const [p2pSocketState, setP2pSocketState] = useState<ConnectionState>("idle");
  const [p2pRtcState, setP2pRtcState] = useState<ConnectionState>("idle");
  const [p2pDataChannelState, setP2pDataChannelState] = useState<DataChannelState>("idle");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [roomDetailsOpen, setRoomDetailsOpen] = useState(false);
  const localDisplayName = displayName.trim() || "访客";
  const wsRef = useRef<WebSocket | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const secureKeysRef = useRef<SecureKeys | null>(null);
  const peerIdRef = useRef("");
  const p2pPeersRef = useRef<Peer[]>([]);
  const peerProfilesRef = useRef<Map<string, string>>(new Map());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  const incomingFilesRef = useRef<Map<string, IncomingFileBuffer>>(new Map());
  const p2pMessageListRef = useRef<HTMLDivElement | null>(null);
  const p2pConnectionState = getO2OState(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pTransportMode = getP2pTransportMode(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pCanTransferFiles = p2pDataChannelState === "open";
  const canStartPeerSession = Boolean(roomId && roomSecret && verificationCode);
  const selectedSavedSession = savedP2pSessions.find((session) => session.id === selectedSavedSessionId);
  const p2pRoomIssueTitle =
    p2pRoomIssue === "missing-key"
      ? "邀请链接不完整。"
      : p2pRoomIssue === "full"
        ? "房间已满。"
        : "房间不存在或已过期。";
  const p2pRoomIssueText =
    p2pRoomIssue === "missing-key"
      ? "这个邀请链接缺少安全密钥。请让发起方重新复制完整链接，确认链接包含 #k=... 后再打开。"
      : p2pRoomIssue === "full"
      ? "一对一直连房间只允许两端加入。请关闭多余窗口后重试，或重新创建房间。"
      : "这个邀请链接已经无法加入。请重新创建房间，并把新的邀请链接发给对方。";
  const connectionAdvice = useMemo(
    () =>
      getConnectionAdvice({
        roomIssue: p2pRoomIssue,
        peerCount: p2pPeers.length,
        socketState: p2pSocketState,
        rtcState: p2pRtcState,
        mode: p2pTransportMode
      }),
    [p2pPeers.length, p2pRoomIssue, p2pRtcState, p2pSocketState, p2pTransportMode]
  );
  const roomDetails = useMemo<RoomDetail[]>(
    () => [
      { label: "房间 ID", value: roomId || "本地预览" },
      { label: "安全校验码", value: verificationCode || "等待密钥" },
      { label: "你", value: localDisplayName },
      { label: "信令", value: connectionStateLabel(p2pSocketState) },
      { label: "直连数据通道", value: connectionStateLabel(p2pRtcState) },
      { label: "消息路径", value: p2pTransportModeDescription(p2pTransportMode, p2pPeers.length) },
      {
        label: "文件路径",
        value: p2pCanTransferFiles
          ? "浏览器直连文件传输可用。"
          : p2pDataChannelState === "connecting"
            ? "文件通道正在打开。"
            : "等待直连数据通道。"
      },
      {
        label: "保存方式",
        value:
          "支持的浏览器会询问保存位置。其他浏览器会按下载设置保存。"
      }
    ],
    [
      localDisplayName,
      p2pCanTransferFiles,
      p2pDataChannelState,
      p2pPeers,
      p2pRtcState,
      p2pSocketState,
      p2pTransportMode,
      roomId,
      verificationCode
    ]
  );

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.style.colorScheme = resolvedTheme;
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    if (themeMode !== "system") {
      setResolvedTheme(themeMode);
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => setResolvedTheme(query.matches ? "dark" : "light");

    updateTheme();
    query.addEventListener("change", updateTheme);
    return () => query.removeEventListener("change", updateTheme);
  }, [themeMode]);

  useEffect(() => {
    p2pMessageListRef.current?.scrollTo({
      top: p2pMessageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [p2pMessages.length]);

  useEffect(() => {
    p2pPeersRef.current = p2pPeers;
  }, [p2pPeers]);

  useEffect(() => {
    if (!selectedSavedSessionId && savedP2pSessions.length > 0) {
      setSelectedSavedSessionId(savedP2pSessions[0].id);
    }
  }, [savedP2pSessions, selectedSavedSessionId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingRoomId = params.get("room");
    if (params.get("lane") === "workspace") {
      setLane("workspace-dev");
      return;
    }

    if (params.get("lane") !== "p2p" || !incomingRoomId) {
      return;
    }

    const incomingSecret = getRoomSecretFromHash();
    if (!incomingSecret) {
      setLane("p2p");
      setP2pStep("invalid-room");
      setRoomId(incomingRoomId);
      setP2pRoomIssue("missing-key");
      return;
    }

    setLane("p2p");
    setP2pStep("name");
    setRoomId(incomingRoomId);
    setRoomSecret(incomingSecret);
    setInviteLink(withRoomSecret(getInviteLink(incomingRoomId), incomingSecret));
    setP2pRoomIssue("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    secureKeysRef.current = null;
    setVerificationCode("");
    if (!roomId || !roomSecret) {
      return;
    }

    deriveP2pKeys(roomId, roomSecret, securityPassphrase)
      .then(async (keys) => {
        const code = await getP2pVerificationCode(roomId, roomSecret, securityPassphrase);
        if (cancelled) {
          return;
        }
        secureKeysRef.current = keys;
        setVerificationCode(code);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        secureKeysRef.current = null;
        setVerificationCode("");
        setP2pError("安全密钥不可用，请重新复制完整邀请链接。");
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, roomSecret, securityPassphrase]);

  useEffect(() => {
    if (p2pStep !== "chat" || !canStartPeerSession) {
      return;
    }

    const keys = secureKeysRef.current;
    if (!keys) {
      setP2pError("正在准备端到端加密密钥，请稍后再进入聊天。");
      return;
    }

    let disposed = false;
    let peerConnection: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;
    setP2pSocketState("connecting");
    setP2pRtcState("connecting");
    setP2pDataChannelState("idle");
    setP2pError("");
    setP2pRoomIssue("");

    const sendSecure = async (channel: SecureChannel, payload: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(await encryptSecurePayload(keys, channel, payload)));
      }
    };

    const sendSignal = (payload: unknown) => {
      void sendSecure("signal", payload);
    };

    const publishProfile = () => {
      if (peerIdRef.current) {
        peerProfilesRef.current.set(peerIdRef.current, localDisplayName);
      }
      void sendSecure("profile", {
        kind: "profile",
        peerId: peerIdRef.current || undefined,
        name: localDisplayName
      } satisfies PeerProfile);
    };

    const attachChannel = (channel: RTCDataChannel) => {
      dataChannelRef.current = channel;
      setP2pDataChannelState(channel.readyState);
      channel.addEventListener("open", () => {
        setP2pDataChannelState("open");
        setP2pRtcState("connected");
      });
      channel.addEventListener("close", () => {
        if (dataChannelRef.current === channel) {
          dataChannelRef.current = null;
        }
        setP2pDataChannelState("closed");
        setP2pRtcState("offline");
        markInterruptedTransfers("文件通道已断开，请确认双方页面在线后重新发送");
      });
      channel.addEventListener("error", () => {
        setP2pDataChannelState("closed");
        setP2pRtcState("error");
        markInterruptedTransfers("文件通道异常，请刷新或重建房间后重新发送");
      });
      channel.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        void handleDataChannelMessage(event.data);
      });
    };

    void (async () => {
      const iceServers = await getIceServers();
      if (disposed) {
        return;
      }
      peerConnection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all"
      });

      peerConnection.addEventListener("icecandidate", (event) => {
        if (event.candidate) {
          sendSignal({ type: "signal", signal: "ice", candidate: event.candidate.toJSON() });
        }
      });
      peerConnection.addEventListener("connectionstatechange", () => {
        if (!peerConnection) {
          return;
        }
        if (peerConnection.connectionState === "connected") {
          setP2pRtcState("connected");
        } else if (["failed", "disconnected"].includes(peerConnection.connectionState)) {
          setP2pRtcState("offline");
        } else if (peerConnection.connectionState === "connecting") {
          setP2pRtcState("connecting");
        }
      });
      peerConnection.addEventListener("datachannel", (event) => {
        attachChannel(event.channel);
      });

      socket = new WebSocket(getWsUrl(roomId));
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        setP2pSocketState("connected");
        publishProfile();
      });

      socket.addEventListener("message", async (event) => {
      const incoming = parsePeerMessage(event.data);
      if (!incoming) {
        return;
      }
      if (incoming.systemEvent === "room-not-found" || incoming.systemEvent === "room-full") {
        setP2pRoomIssue(incoming.systemEvent === "room-full" ? "full" : "not-found");
        setP2pSocketState("error");
        setP2pRtcState("error");
        setP2pDataChannelState("idle");
        setP2pPeers([]);
        setP2pStep("invalid-room");
        return;
      }
      if (incoming.peerId) {
        peerIdRef.current = incoming.peerId;
        peerProfilesRef.current.set(incoming.peerId, localDisplayName);
        publishProfile();
      }
      if (incoming.peers) {
        setP2pPeers(resolvePeers(incoming.peers, peerProfilesRef.current, peerIdRef.current, localDisplayName));
      }
      if (incoming.systemEvent === "peer-joined" || (incoming.systemEvent === "joined" && (incoming.peers?.length ?? 0) >= 2)) {
        publishProfile();
      }
      if (incoming.body && ["joined", "peer-joined", "peer-left"].includes(incoming.systemEvent || "")) {
        setP2pMessages((messages) => [
          ...messages,
          {
            id: makeId("system"),
            author: "系统",
            body: incoming.body || "",
            lane: "p2p",
            at: nowLabel()
          }
        ]);
      }
      if (incoming.secure) {
        try {
          const decrypted = await decryptSecurePayload<unknown>(keys, incoming.secure);
          if (incoming.secure.channel === "signal") {
            const signal = normalizeSignalPayload(decrypted);
            if (signal && peerConnection) {
              await handleSignalMessage(peerConnection, sendSignal, signal);
            }
            return;
          }
          if (incoming.secure.channel === "profile") {
            const profile = normalizeProfilePayload(decrypted);
            if (profile) {
              const senderId = profile.peerId ?? incoming.from?.id ?? findRemotePeerId(incoming.peers ?? p2pPeersRef.current, peerIdRef.current);
              if (senderId) {
                peerProfilesRef.current.set(senderId, profile.name);
                setP2pPeers((peers) => resolvePeers(peers, peerProfilesRef.current, peerIdRef.current, localDisplayName));
              }
            }
            return;
          }
          if (incoming.secure.channel === "ws-chat") {
            const chat = normalizeWsChatPayload(decrypted);
            if (chat) {
              setP2pMessages((messages) => [
                ...messages,
                {
                  id: chat.id,
                  author: chat.author,
                  body: chat.body,
                  lane: "p2p",
                  at: chat.at
                }
              ]);
            }
            return;
          }
        } catch {
          setP2pError("收到无法解密的内容，请确认双方安全口令和邀请链接一致。");
          return;
        }
      }
      const signal = incoming.signal;
      if (signal) {
        if (peerConnection) {
          await handleSignalMessage(peerConnection, sendSignal, signal);
        }
        return;
      }
      if (incoming.peers && incoming.peers.length >= 2 && peerIdRef.current && peerConnection) {
        const initiator = peerIdRef.current === [...incoming.peers].sort((a, b) => a.id.localeCompare(b.id))[0].id;
        if (initiator && !dataChannelRef.current) {
          const channel = peerConnection.createDataChannel("duallane-p2p");
          attachChannel(channel);
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: "signal", signal: "offer", description: offer });
        }
      }
      });

      socket.addEventListener("close", () => {
        setP2pSocketState((status) => (status === "connecting" ? "offline" : status));
        setP2pRtcState("offline");
        setP2pDataChannelState("closed");
        setP2pPeers([]);
        markInterruptedTransfers("连接已断开，请重建房间或让对方重新打开页面后重新发送");
      });

      socket.addEventListener("error", () => {
        setP2pSocketState("error");
        setP2pRtcState("error");
        setP2pDataChannelState("closed");
        setP2pError("实时信令暂不可用，你仍然可以查看本地界面流程。");
      });
    })();

    return () => {
      disposed = true;
      socket?.close();
      dataChannelRef.current?.close();
      peerConnection?.close();
      wsRef.current = null;
      dataChannelRef.current = null;
      setP2pDataChannelState("idle");
      pendingIceRef.current = [];
      pendingFilesRef.current.clear();
      incomingFilesRef.current.clear();
    };
  }, [canStartPeerSession, localDisplayName, p2pStep, roomId]);

  async function createP2pRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      return;
    }

    setP2pStatus("connecting");
    setP2pSocketState("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setSessionSaved("idle");

    if (roomId) {
      if (!roomSecret) {
        setP2pStatus("error");
        setP2pRoomIssue("missing-key");
        setP2pStep("invalid-room");
        return;
      }
      try {
        const response = await fetch(`/api/p2p/rooms/${encodeURIComponent(roomId)}`);
        if (response.status === 404) {
          setP2pStatus("error");
          setP2pSocketState("error");
          setP2pRtcState("error");
          setP2pDataChannelState("idle");
          setP2pRoomIssue("not-found");
          setP2pStep("invalid-room");
          return;
        }
        if (!response.ok) {
          setP2pError(`房间校验暂不可用：${response.status} ${response.statusText || "请求失败"}`);
        }
        setInviteLink(withRoomSecret(getInviteLink(roomId), roomSecret));
        setP2pStatus("idle");
        setP2pStep("chat");
      } catch (error) {
        setP2pError(error instanceof Error ? `房间校验暂不可用：${error.message}` : "房间校验暂不可用。");
        setInviteLink(withRoomSecret(getInviteLink(roomId), roomSecret));
        setP2pStatus("idle");
        setP2pStep("chat");
      }
      return;
    }

    try {
      const nextSecret = generateRoomSecret();
      const data = await fetch("/api/p2p/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPeers: p2pParticipantCount })
      }).then((response) => parseJson<{ roomId?: string; id?: string; inviteLink?: string }>(response));
      const nextRoomId = data.roomId ?? data.id;
      if (!nextRoomId) {
        throw new Error("房间 API 未返回房间 ID");
      }
      setRoomId(nextRoomId);
      setRoomSecret(nextSecret);
      setInviteLink(withRoomSecret(getInviteLink(nextRoomId), nextSecret));
      setP2pStep("waiting");
    } catch (error) {
      setRoomId("");
      setInviteLink("");
      setP2pError(error instanceof Error ? `房间 API 暂不可用：${error.message}` : "房间 API 暂不可用。");
    } finally {
      setP2pStatus("idle");
    }
  }

  async function sendP2pMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = p2pDraft.trim();
    if (!body) {
      return;
    }

    const message = {
      id: makeId("p2p"),
      author: displayName.trim() || "你",
      body,
      lane: "p2p" as const,
      at: nowLabel(),
      self: true
    };
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState === "open") {
      dataChannel.send(
        JSON.stringify({
          kind: "chat",
          id: message.id,
          author: message.author,
          body: message.body,
          at: message.at
        } satisfies DataEnvelope)
      );
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      const keys = secureKeysRef.current;
      if (!keys) {
        setP2pError("端到端加密密钥尚未就绪，无法通过中转发送。");
        return;
      }
      wsRef.current.send(
        JSON.stringify(
          await encryptSecurePayload(keys, "ws-chat", {
            kind: "chat",
            id: message.id,
            author: message.author,
            body: message.body,
            at: message.at
          } satisfies DataEnvelope)
        )
      );
    }

    setP2pMessages((messages) => [...messages, message]);
    setP2pDraft("");
  }

  function addP2pFile(file: File) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: "系统",
          body: "加密直连文件传输尚未就绪。请让对方保持页面打开，或改用工作区中转。",
          lane: "p2p",
          at: nowLabel()
        }
      ]);
      return;
    }

    const transferId = makeId("file");
    const riskNote = getFileRiskNote(file.size);
    if (file.size > P2P_MAX_FILE_BYTES) {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: transferId,
          author: displayName.trim() || "你",
          body: `文件未发送：${getFileLimitText()} 大文件请拆分后重试，或改用工作区中转。`,
          lane: "p2p",
          at: nowLabel(),
          self: true,
          fileTransfer: {
            id: transferId,
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            status: "failed",
            progress: 0,
            failureReason: `超过 ${formatBytes(P2P_MAX_FILE_BYTES)} 的直连上限`,
            riskNote: "大文件更适合使用工作区中转，便于断点外的重新上传和审计留存。"
          }
        }
      ]);
      return;
    }

    pendingFilesRef.current.set(transferId, file);
    dataChannel.send(
      JSON.stringify({
        kind: "file-offer",
        transferId,
        author: displayName.trim() || "对方",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream"
      } satisfies DataEnvelope)
    );
    setP2pMessages((messages) => [
      ...messages,
      {
        id: transferId,
        author: displayName.trim() || "你",
        body: "文件请求已发送，等待对方接受。",
        lane: "p2p",
        at: nowLabel(),
        self: true,
        fileTransfer: {
          id: transferId,
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          status: "waiting",
          progress: 0,
          riskNote,
          retryable: true
        }
      }
    ]);
  }

  function sendEnvelope(envelope: DataEnvelope) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      return false;
    }
    dataChannel.send(JSON.stringify(envelope));
    return true;
  }

  async function handleDataChannelMessage(raw: string) {
    const envelope = parseDataEnvelope(raw);
    if (!envelope) {
      return;
    }

    if (envelope.kind === "chat") {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: envelope.id,
          author: envelope.author,
          body: envelope.body,
          lane: "p2p",
          at: envelope.at
        }
      ]);
      return;
    }

    if (envelope.kind === "file-offer") {
      incomingFilesRef.current.set(envelope.transferId, {
        name: envelope.name,
        size: envelope.size,
        mimeType: envelope.mimeType || "application/octet-stream",
        chunks: [],
        receivedBytes: 0
      });
      setP2pMessages((messages) => [
        ...messages,
        {
          id: envelope.transferId,
          author: envelope.author || "对方",
          body: "收到一个加密文件传输请求。",
          lane: "p2p",
          at: nowLabel(),
          fileTransfer: {
            id: envelope.transferId,
            name: envelope.name,
            size: envelope.size,
            mimeType: envelope.mimeType,
            status: "offered",
            progress: 0,
            riskNote: getFileRiskNote(envelope.size)
          }
        }
      ]);
      return;
    }

    if (envelope.kind === "file-accept") {
      const file = pendingFilesRef.current.get(envelope.transferId);
      if (!file) {
        updateP2pFileTransfer(envelope.transferId, {
          status: "failed",
          failureReason: "本机已找不到待发送文件，请重新选择文件发送",
          retryable: false
        });
        return;
      }
      void sendP2pFile(envelope.transferId, file);
      return;
    }

    if (envelope.kind === "file-reject") {
      pendingFilesRef.current.delete(envelope.transferId);
      incomingFilesRef.current.delete(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, {
        status: "rejected",
        progress: 0,
        failureReason: envelope.reason || "对方拒绝接收"
      });
      return;
    }

    if (envelope.kind === "file-chunk") {
      const incomingFile = incomingFilesRef.current.get(envelope.transferId);
      if (!incomingFile) {
        return;
      }
      const bytes = base64ToBytes(envelope.data);
      const previousBytes = incomingFile.chunks[envelope.index]?.byteLength ?? 0;
      incomingFile.chunks[envelope.index] = bytes;
      incomingFile.receivedBytes += bytes.byteLength - previousBytes;
      updateP2pFileTransfer(envelope.transferId, {
        status: "receiving",
        progress: getTransferProgress(incomingFile.receivedBytes, incomingFile.size)
      });
      return;
    }

    if (envelope.kind === "file-complete") {
      const incomingFile = incomingFilesRef.current.get(envelope.transferId);
      if (!incomingFile) {
        return;
      }
      const blob = new Blob(incomingFile.chunks, { type: incomingFile.mimeType || "application/octet-stream" });
      incomingFile.blob = blob;
      const downloadUrl = URL.createObjectURL(blob);
      updateP2pFileTransfer(envelope.transferId, { status: "complete", progress: 100, downloadUrl });
      sendEnvelope({ kind: "file-complete", transferId: envelope.transferId });
    }
  }

  async function handleSignalMessage(
    peerConnection: RTCPeerConnection,
    sendSignal: (payload: unknown) => void,
    signal: SignalMessage
  ) {
    if (signal.signal === "offer" && signal.description) {
      await peerConnection.setRemoteDescription(signal.description);
      await drainPendingIce(peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendSignal({ type: "signal", signal: "answer", description: answer });
      return;
    }

    if (signal.signal === "answer" && signal.description) {
      await peerConnection.setRemoteDescription(signal.description);
      await drainPendingIce(peerConnection);
      return;
    }

    if (signal.signal === "ice" && signal.candidate) {
      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(signal.candidate);
      } else {
        pendingIceRef.current.push(signal.candidate);
      }
    }
  }

  async function drainPendingIce(peerConnection: RTCPeerConnection) {
    const candidates = pendingIceRef.current.splice(0);
    for (const candidate of candidates) {
      await peerConnection.addIceCandidate(candidate);
    }
  }

  function updateP2pFileTransfer(transferId: string, patch: Partial<FileTransfer>) {
    setP2pMessages((messages) =>
      messages.map((message) => {
        if (message.fileTransfer?.id !== transferId) {
          return message;
        }
        return {
          ...message,
          body: getFileMessageBody({ ...message.fileTransfer, ...patch }),
          fileTransfer: {
            ...message.fileTransfer,
            ...patch
          }
        };
      })
    );
  }

  function markInterruptedTransfers(reason: string) {
    setP2pMessages((messages) =>
      messages.map((message) => {
        const transfer = message.fileTransfer;
        if (!transfer || !["waiting", "sending", "receiving", "offered"].includes(transfer.status)) {
          return message;
        }
        const nextTransfer = {
          ...transfer,
          status: "failed" as const,
          failureReason: reason,
          retryable: Boolean(message.self && pendingFilesRef.current.has(transfer.id))
        };
        return {
          ...message,
          body: getFileMessageBody(nextTransfer),
          fileTransfer: nextTransfer
        };
      })
    );
  }

  async function sendP2pFile(transferId: string, file: File) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道已断开，请重连后重新发送",
        retryable: true
      });
      return;
    }

    updateP2pFileTransfer(transferId, { status: "sending", progress: 0, failureReason: undefined });
    const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));
    for (let index = 0; index < total; index += 1) {
      const chunk = file.slice(index * FILE_CHUNK_SIZE, Math.min(file.size, (index + 1) * FILE_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      await waitForBufferedAmount(dataChannel);
      if (dataChannel.readyState !== "open") {
        updateP2pFileTransfer(transferId, {
          status: "failed",
          failureReason: "传输中断，请确认双方页面在线后重新发送",
          retryable: true
        });
        return;
      }
      dataChannel.send(
        JSON.stringify({
          kind: "file-chunk",
          transferId,
          index,
          total,
          data: arrayBufferToBase64(buffer)
        } satisfies DataEnvelope)
      );
      updateP2pFileTransfer(transferId, { progress: Math.round(((index + 1) / total) * 100) });
    }

    dataChannel.send(JSON.stringify({ kind: "file-complete", transferId } satisfies DataEnvelope));
    pendingFilesRef.current.delete(transferId);
    updateP2pFileTransfer(transferId, { status: "complete", progress: 100, retryable: false });
  }

  async function acceptP2pFile(transferId: string) {
    const accepted = sendEnvelope({ kind: "file-accept", transferId });
    if (!accepted) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "接受时直连通道已断开，请让对方重新发送"
      });
      return;
    }
    updateP2pFileTransfer(transferId, { status: "receiving", progress: 0, failureReason: undefined });
  }

  function rejectP2pFile(transferId: string) {
    incomingFilesRef.current.delete(transferId);
    sendEnvelope({ kind: "file-reject", transferId, reason: "对方拒绝接收" });
    updateP2pFileTransfer(transferId, { status: "rejected", progress: 0, failureReason: "你已拒绝接收" });
  }

  function retryP2pFile(transferId: string) {
    const file = pendingFilesRef.current.get(transferId);
    const dataChannel = dataChannelRef.current;
    if (!file) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "本机已找不到原文件，请重新选择文件",
        retryable: false
      });
      return;
    }
    if (dataChannel?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道未恢复，请等待对方在线后重试",
        retryable: true
      });
      return;
    }
    updateP2pFileTransfer(transferId, { status: "waiting", progress: 0, failureReason: undefined });
    dataChannel.send(
      JSON.stringify({
        kind: "file-offer",
        transferId,
        author: displayName.trim() || "对方",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream"
      } satisfies DataEnvelope)
    );
  }

  async function saveP2pFile(transfer: FileTransfer) {
    const incomingFile = incomingFilesRef.current.get(transfer.id);
    const blob = incomingFile?.blob;
    if (!blob) {
      return;
    }

    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({ suggestedName: transfer.name });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    const downloadUrl = transfer.downloadUrl ?? URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = transfer.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function saveP2pSession() {
    const now = new Date().toISOString();
    const session: SavedP2pSession = {
      id: makeId("session"),
      roomId: roomId || "本地",
      displayName: displayName.trim() || "本机",
      savedAt: now,
      messages: sanitizeMessagesForStorage(p2pMessages)
    };
    const nextSessions = [session, ...savedP2pSessions].slice(0, 30);
    writeSavedP2pSessions(nextSessions);
    setSavedP2pSessions(nextSessions);
    setSelectedSavedSessionId(session.id);
    setSessionSaved("saved");
  }

  function exportP2pSession(session: SavedP2pSession) {
    downloadJson(`duallane-p2p-${session.roomId}-${session.savedAt.slice(0, 10)}.json`, session);
  }

  function clearSavedP2pSessions() {
    writeSavedP2pSessions([]);
    setSavedP2pSessions([]);
    setSelectedSavedSessionId("");
    setSavedSessionsOpen(false);
  }

  function discardP2pSession() {
    setP2pMessages([]);
    resetToEntry();
  }

  function endP2pSocket() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "leave" }));
    }
    wsRef.current?.close();
    dataChannelRef.current?.close();
  }

  function resetToEntry() {
    endP2pSocket();
    setLane("entry");
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setP2pMessages([]);
    setP2pDraft("");
    setSessionSaved("idle");
    setP2pPeers([]);
    setP2pSocketState("idle");
    setP2pRtcState("idle");
    setP2pDataChannelState("idle");
    setRoomDetailsOpen(false);
    setSavedSessionsOpen(false);
    setCopyState("idle");
    pendingFilesRef.current.clear();
    incomingFilesRef.current.clear();
    peerProfilesRef.current.clear();
    secureKeysRef.current = null;
    peerIdRef.current = "";
    setRoomId("");
    setInviteLink("");
    setRoomSecret("");
    setSecurityPassphrase("");
    setP2pParticipantCount(P2P_DEFAULT_PARTICIPANTS);
    setVerificationCode("");
  }

  function startNewP2pRoom() {
    endP2pSocket();
    setLane("p2p");
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setP2pMessages([]);
    setP2pDraft("");
    setP2pPeers([]);
    setP2pSocketState("idle");
    setP2pRtcState("idle");
    setP2pDataChannelState("idle");
    setRoomDetailsOpen(false);
    setSavedSessionsOpen(false);
    setCopyState("idle");
    setSessionSaved("idle");
    pendingFilesRef.current.clear();
    incomingFilesRef.current.clear();
    peerProfilesRef.current.clear();
    secureKeysRef.current = null;
    peerIdRef.current = "";
    setRoomId("");
    setInviteLink("");
    setRoomSecret("");
    setSecurityPassphrase("");
    setP2pParticipantCount(P2P_DEFAULT_PARTICIPANTS);
    setVerificationCode("");
    window.history.replaceState({}, "", window.location.pathname);
  }

  async function copyInviteLink() {
    const didCopy = await copyText(inviteLink);
    setCopyState(didCopy ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <main className="shell">
      <ThemeSwitch mode={themeMode} resolvedTheme={resolvedTheme} onModeChange={setThemeMode} />
      {lane === "entry" && (
        <section className="entry" aria-labelledby="entry-title">
          <div className="entry-heading">
            <p className="eyebrow">DualLane</p>
            <h1 id="entry-title">开始加密对话</h1>
          </div>
          <div className="lane-grid" aria-label="通信通道">
            <button className="lane-choice direct-choice" type="button" onClick={() => setLane("p2p")}>
              <span className="lane-icon" aria-hidden="true">
                <LockKeyhole size={28} />
              </span>
              <strong>一对一直连</strong>
              <span>无需登录，仅使用服务器做信令协调。<br />对话内容不在服务器保存。</span>
            </button>
            <button className="lane-choice workspace-choice" type="button" onClick={() => setLane("workspace-dev")}>
              <span className="lane-icon" aria-hidden="true">
                <ShieldCheck size={28} />
              </span>
              <strong>工作区</strong>
              <span>邀请制中继通道，支持 GitHub 登录、消息留存、配额和审计日志。</span>
            </button>
          </div>
        </section>
      )}

      {lane === "p2p" && (
        <section className="lane-surface" aria-labelledby="p2p-title">
          <TopBar
            label="P2P 私密通道"
            title="一对一直连"
            icon={<LockKeyhole size={18} />}
            onBack={resetToEntry}
          />

          {p2pStep === "name" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Radio size={30} />
              </div>
              <p className="eyebrow">无需账号</p>
              <h2 id="p2p-title">{roomId ? "加入私密直连会话。" : "发起私密直连会话。"}</h2>
              <p className="quiet">
                {roomId
                  ? `输入显示名称即可加入房间 ${roomId}。`
                  : "显示名称只会在本次本地会话中展示给对方。"}
              </p>
              <form className="stack-form" onSubmit={createP2pRoom}>
                <label>
                  <span>显示名称</span>
                  <input
                    autoFocus
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={40}
                    placeholder="会话显示名称"
                  />
                </label>
                <label>
                  <span>安全口令（可选）</span>
                  <input
                    value={securityPassphrase}
                    onChange={(event) => setSecurityPassphrase(event.target.value)}
                    maxLength={64}
                    placeholder="双方输入同一口令"
                    autoComplete="off"
                  />
                </label>
                {!roomId && (
                  <label>
                    <span>
                      会话参与人数
                      <small title={`当前私密直连链路上限为 ${P2P_MAX_PARTICIPANTS} 人。`}>
                        上限 {P2P_MAX_PARTICIPANTS} 人
                      </small>
                    </span>
                    <input
                      readOnly
                      value={`${p2pParticipantCount} 人`}
                      aria-label="会话参与人数"
                    />
                  </label>
                )}
                <button className="primary direct-button" type="submit" disabled={!displayName.trim()}>
                  {roomId ? <MessageSquare size={18} /> : <Plus size={18} />}
                  {roomId ? "加入会话" : "开始会话"}
                </button>
              </form>
              <InlineNotice
                tone="info"
                text={
                  <>
                    邀请链接包含端到端加密密钥；<br />
                    安全口令只在本机参与派生，不会发送到服务器。
                  </>
                }
              />
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
              {savedP2pSessions.length > 0 && (
                <div className="local-records-block">
                  <button className="secondary compact" type="button" onClick={() => setSavedSessionsOpen((open) => !open)}>
                    <History size={16} />
                    {savedSessionsOpen ? "收起已保存记录" : "查看已保存记录"}
                  </button>
                  {savedSessionsOpen && (
                    <SavedSessionsPanel
                      sessions={savedP2pSessions}
                      selectedSession={selectedSavedSession}
                      selectedSessionId={selectedSavedSessionId}
                      onSelect={setSelectedSavedSessionId}
                      onExport={exportP2pSession}
                      onClear={clearSavedP2pSessions}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {p2pStep === "waiting" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Link2 size={30} />
              </div>
              <p className="eyebrow">房间已就绪</p>
              <h2>分享这个邀请链接。</h2>
              <p className="quiet">
                房间 ID 为 {roomId}。<br />
                复制完整链接，确认包含 #k= 安全片段后再发给对方。
              </p>
              <div className="copy-box">
                <span>{inviteLink}</span>
                <button
                  className="secondary compact"
                  type="button"
                  title="复制邀请链接"
                  onClick={() => void copyInviteLink()}
                >
                  <Clipboard size={18} />
                  {copyState === "copied" ? "已复制" : "复制"}
                </button>
              </div>
              <div className="action-row">
                <button className="primary direct-button" type="button" onClick={() => setP2pStep("chat")}>
                  <MessageSquare size={18} />
                  进入聊天
                </button>
              </div>
              {copyState === "failed" && <InlineNotice tone="warning" text="复制失败，请手动选择链接文本。" />}
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
            </div>
          )}

          {p2pStep === "chat" && (
            <ChatPanel
              title="一对一直连"
              subtitle={`房间 ${roomId || "本地"}`}
              hideTitle
              details={
                <RoomDetails
                  open={roomDetailsOpen}
                  details={roomDetails}
                  peers={p2pPeers}
                  shareLink={inviteLink}
                  onCopyShare={copyInviteLink}
                  copyState={copyState}
                  onToggle={() => setRoomDetailsOpen((open) => !open)}
                />
              }
              status={
                <P2pStatusControl
                  state={p2pConnectionState}
                  mode={p2pTransportMode}
                  peerCount={p2pPeers.length}
                  advice={connectionAdvice}
                  trustText={p2pTrustText(p2pTransportMode)}
                />
              }
              messages={p2pMessages}
              messageListRef={p2pMessageListRef}
              draft={p2pDraft}
              onDraft={setP2pDraft}
              onSend={sendP2pMessage}
              onFile={addP2pFile}
              onAcceptFile={(transferId) => void acceptP2pFile(transferId)}
              onRejectFile={rejectP2pFile}
              onSaveFile={(transfer) => void saveP2pFile(transfer)}
              onRetryFile={retryP2pFile}
              onEnd={() => {
                endP2pSocket();
                setP2pStep("ended");
              }}
              fileLabel="选择文件"
              fileInputDisabled={!p2pCanTransferFiles}
              fileInputTitle={
                p2pCanTransferFiles ? "选择文件进行加密点对点传输" : "等待对方数据通道上线"
              }
            />
          )}

          {p2pStep === "invalid-room" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <AlertCircle size={30} />
              </div>
              <p className="eyebrow">房间不可用</p>
              <h2>{p2pRoomIssueTitle}</h2>
              <p className="quiet">{p2pRoomIssueText}</p>
              <div className="action-row">
                <button className="primary direct-button" type="button" onClick={startNewP2pRoom}>
                  <RefreshCw size={18} />
                  重新创建房间
                </button>
                <button className="secondary" type="button" onClick={resetToEntry}>
                  <ArrowLeft size={18} />
                  返回通道选择
                </button>
              </div>
              <InlineNotice
                tone="warning"
                text={
                  <>
                    房间只保存短时信令状态；<br />
                    过期或服务重启后，需要使用新链接。
                  </>
                }
              />
            </div>
          )}

          {p2pStep === "ended" && (
            <div className="single-action">
              <div className="center-icon ended-bg" aria-hidden="true">
                <Check size={30} />
              </div>
              <p className="eyebrow">会话已关闭</p>
              <h2>本次会话已结束。</h2>
              <p className="quiet">
                服务器不保存对话内容；<br />
                选择本地保存或导出时，记录会以明文保存在本机浏览器或文件中。
              </p>
              <div className="action-row">
                {sessionSaved === "saved" ? (
                  <button className="primary direct-button" type="button" onClick={resetToEntry}>
                    <ArrowLeft size={18} />
                    返回首页
                  </button>
                ) : (
                  <>
                    <button
                      className="primary direct-button"
                      type="button"
                      onClick={saveP2pSession}
                    >
                      <Save size={18} />
                      保存到本地
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={discardP2pSession}
                    >
                      <X size={18} />
                      不保存并关闭
                    </button>
                  </>
                )}
              </div>
              {sessionSaved === "saved" && <InlineNotice tone="success" text="已保存到本机浏览器明文存储。" />}
              <SavedSessionsPanel
                sessions={savedP2pSessions}
                selectedSession={selectedSavedSession}
                selectedSessionId={selectedSavedSessionId}
                onSelect={setSelectedSavedSessionId}
                onExport={exportP2pSession}
                onClear={clearSavedP2pSessions}
              />
            </div>
          )}
        </section>
      )}

      {lane === "workspace-dev" && (
        <section className="lane-surface" aria-labelledby="workspace-dev-title">
          <TopBar
            label="可审计中继通道"
            title="工作区"
            icon={<ShieldCheck size={18} />}
            onBack={resetToEntry}
          />
          <div className="single-action development-state">
            <div className="center-icon workspace-dev-bg" aria-hidden="true">
              <ShieldCheck size={30} />
            </div>
            <p className="eyebrow">功能正在开发中</p>
            <h2 id="workspace-dev-title">工作区中转暂未开放。</h2>
            <p className="quiet">
              工作区涉及登录、权限、消息留存、文件配额和审计能力。<br />
              正式上线前，所有入口和越权跳转都会统一拦截到这里。
            </p>
            <div className="development-list" aria-label="暂未开放能力">
              <span>GitHub 登录与邀请门禁</span>
              <span>服务端中转文件与配额</span>
              <span>消息留存和审计导出</span>
            </div>
            <div className="action-row">
              <button className="primary direct-button" type="button" onClick={() => setLane("p2p")}>
                <LockKeyhole size={18} />
                使用一对一直连
              </button>
              <button className="secondary" type="button" onClick={resetToEntry}>
                <ArrowLeft size={18} />
                返回首页
              </button>
            </div>
            <InlineNotice
              tone="info"
              text={
                <>
                  当前可交付链路为 O2O 私密直连；<br />
                  工作区 API 已默认关闭，避免误用未完成能力。
                </>
              }
            />
          </div>
        </section>
      )}
    </main>
  );
}

function parsePeerMessage(raw: unknown): PeerSocketMessage | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      event?: string;
      peers?: Peer[];
      peerId?: string;
      from?: Peer;
      v?: number;
      channel?: SecureChannel;
      nonce?: string;
      ciphertext?: string;
    };

    if (parsed.type === "system") {
      if (parsed.event === "room-not-found") {
        return {
          author: "系统",
          body: "房间不存在或已过期，请重新创建。",
          systemEvent: "room-not-found"
        };
      }
      if (parsed.event === "room-full") {
        return {
          author: "系统",
          body: "房间已满，请重新创建。",
          systemEvent: "room-full"
        };
      }
      if (parsed.event === "joined") {
        return {
          author: "系统",
          body: parsed.peers && parsed.peers.length >= 2 ? "你已加入房间，正在建立连接。" : "你已进入房间，等待对方加入。",
          systemEvent: "joined",
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      if (parsed.event === "peer-joined") {
        return {
          author: "系统",
          body: "对方已加入房间，正在建立连接。",
          systemEvent: "peer-joined",
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-left") {
        return {
          author: "系统",
          body: "对方已离开房间。",
          systemEvent: "peer-left",
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-list") {
        return {
          author: "系统",
          systemEvent: "peer-list",
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      return parsed.event ? { author: "系统", body: parsed.event, peers: parsed.peers } : null;
    }

    if (parsed.type === "secure" && parsed.v === SECURE_ENVELOPE_VERSION && isSecureChannel(parsed.channel)) {
      return {
        author: "对方",
        peers: parsed.peers,
        from: parsed.from,
        secure: {
          type: "secure",
          v: SECURE_ENVELOPE_VERSION,
          channel: parsed.channel,
          nonce: String(parsed.nonce || ""),
          ciphertext: String(parsed.ciphertext || "")
        }
      };
    }

    return null;
  } catch {
    return null;
  }
}

function isSecureChannel(value: unknown): value is SecureChannel {
  return value === "signal" || value === "ws-chat" || value === "profile";
}

function resolvePeers(peers: Peer[] = [], profiles: Map<string, string>, selfPeerId: string, selfName: string) {
  return peers.map((peer) => ({
    id: peer.id,
    name: peer.id === selfPeerId ? selfName : profiles.get(peer.id) ?? "对方",
    self: peer.id === selfPeerId
  }));
}

function formatPeerName(peer: Peer) {
  return peer.self ? `你（${peer.name || "访客"}）` : peer.name || "对方";
}

function findRemotePeerId(peers: Peer[], selfPeerId: string) {
  return peers.find((peer) => peer.id !== selfPeerId)?.id ?? "";
}

function normalizeSignalPayload(value: unknown): SignalMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as SignalMessage & { type?: string };
  if (payload.type !== "signal" || !payload.signal) {
    return null;
  }
  return {
    signal: payload.signal,
    description: payload.description,
    candidate: payload.candidate
  };
}

function normalizeProfilePayload(value: unknown): PeerProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as { kind?: string; peerId?: string; name?: string };
  if (payload.kind !== "profile" || typeof payload.name !== "string") {
    return null;
  }
  return {
    kind: "profile",
    peerId: typeof payload.peerId === "string" ? payload.peerId : undefined,
    name: payload.name.trim().slice(0, 40) || "对方"
  };
}

function normalizeWsChatPayload(value: unknown): ChatEnvelope | null {
  const envelope = parseDataEnvelopeValue(value);
  return envelope?.kind === "chat" ? envelope : null;
}

function ThemeSwitch({
  mode,
  resolvedTheme,
  onModeChange
}: {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  onModeChange: (mode: ThemeMode) => void;
}) {
  const options: Array<{ value: ThemeMode; label: string; title: string; icon: React.ReactNode }> = [
    { value: "system", label: "系统", title: `跟随系统（当前${resolvedTheme === "dark" ? "深色" : "浅色"}）`, icon: <Monitor size={15} /> },
    { value: "light", label: "浅色", title: "使用浅色模式", icon: <Sun size={15} /> },
    { value: "dark", label: "深色", title: "使用深色模式", icon: <Moon size={15} /> }
  ];

  return (
    <div className="theme-switch" aria-label="外观模式">
      {options.map((option) => (
        <button
          className={mode === option.value ? "active" : ""}
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={mode === option.value}
          onClick={() => onModeChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function TopBar({
  label,
  title,
  icon,
  onBack
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button" type="button" onClick={onBack} title="返回通道选择">
        <ArrowLeft size={18} />
      </button>
      <div className="topbar-title">
        <span>
          {icon}
          {label}
        </span>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function InlineNotice({ tone, text }: { tone: "info" | "success" | "warning"; text: React.ReactNode }) {
  return (
    <p className={`notice ${tone}`}>
      {tone === "warning" ? <AlertCircle size={16} /> : <Check size={16} />}
      {text}
    </p>
  );
}

function getP2pStatusSummary(state: ConnectionState, mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return "浏览器直连";
  }
  if (mode === "relay-text") {
    return "文本中转";
  }
  if (mode === "error" || state === "error") {
    return "连接异常";
  }
  if (mode === "offline" || state === "offline") {
    return "对方离线";
  }
  if (peerCount >= 2) {
    return "协商直连";
  }
  return "等待对方";
}

function getP2pStatusTone(state: ConnectionState, mode: P2pTransportMode) {
  if (mode === "direct") {
    return "direct";
  }
  if (mode === "error" || state === "error") {
    return "error";
  }
  if (mode === "offline" || state === "offline") {
    return "offline";
  }
  if (mode === "relay-text") {
    return "relay";
  }
  return "waiting";
}

function getDefaultP2pStatusTips(mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return ["可以发送文本和文件", "双方关闭页面后会话结束"];
  }
  if (mode === "relay-text") {
    return ["文本可继续发送", "文件需等待直连通道", "长时间未恢复时复制新链接重试"];
  }
  if (mode === "waiting" && peerCount >= 2) {
    return ["双方保持页面打开", "浏览器会继续协商直连路径"];
  }
  return ["复制邀请链接给对方", "双方保持页面打开"];
}

function P2pStatusControl({
  state,
  mode,
  peerCount,
  advice,
  trustText
}: {
  state: ConnectionState;
  mode: P2pTransportMode;
  peerCount: number;
  advice: ConnectionAdvice | null;
  trustText: string;
}) {
  const summary = getP2pStatusSummary(state, mode, peerCount);
  const tone = getP2pStatusTone(state, mode);
  const tips = advice?.items ?? getDefaultP2pStatusTips(mode, peerCount);
  const body = advice?.body ?? p2pTransportModeDescription(mode, peerCount);

  return (
    <details className={`p2p-status-control ${tone}`}>
      <summary>
        <span className="status-dot" aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown className="status-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="p2p-status-popover">
        <strong>{advice?.title ?? p2pTransportModeLabel(mode)}</strong>
        <p>{body}</p>
        <small>{trustText}</small>
        {tips.length > 0 && (
          <ul>
            {tips.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function RoomDetails({
  open,
  details,
  peers,
  shareLink,
  onCopyShare,
  copyState,
  onToggle
}: {
  open: boolean;
  details: RoomDetail[];
  peers: Peer[];
  shareLink?: string;
  onCopyShare?: () => void;
  copyState?: CopyState;
  onToggle: () => void;
}) {
  return (
    <section className={open ? "room-details open" : "room-details"} aria-label="会话信息">
      <button className="room-details-toggle" type="button" onClick={onToggle} aria-expanded={open}>
        <span>
          <UsersRound size={16} />
          会话信息
        </span>
        {open ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
      </button>
      {open && (
        <div className="room-details-body">
          <dl className="detail-grid">
            {details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
          <p className="verification-help">
            安全校验码由邀请链接密钥和可选安全口令派生。双方看到的数字一致，说明使用的是同一组端到端加密密钥。
          </p>
          <div className="peer-list-inline" aria-label="在线状态">
            <span className="presence online" aria-hidden="true" />
            <strong>{peers.length ? `${peers.length}/2 在线` : "等待对方"}</strong>
            {peers.length ? (
              <span>{peers.map(formatPeerName).join("、")}</span>
            ) : (
              <span>复制邀请链接给对方加入</span>
            )}
          </div>
          {shareLink && (
            <div className="share-strip">
              <div className="share-meta">
                <Link2 size={16} />
                <span>邀请</span>
              </div>
              <span className="share-link-text">{shareLink}</span>
              <button
                className="secondary compact"
                type="button"
                title="复制邀请链接"
                onClick={onCopyShare}
              >
                <Clipboard size={16} />
                {copyState === "copied" ? "已复制" : "复制"}
              </button>
            </div>
          )}
          {copyState === "failed" && <p className="copy-fallback">复制失败，请手动选择链接。</p>}
        </div>
      )}
    </section>
  );
}

function SavedSessionsPanel({
  sessions,
  selectedSession,
  selectedSessionId,
  onSelect,
  onExport,
  onClear
}: {
  sessions: SavedP2pSession[];
  selectedSession?: SavedP2pSession;
  selectedSessionId: string;
  onSelect: (sessionId: string) => void;
  onExport: (session: SavedP2pSession) => void;
  onClear: () => void;
}) {
  return (
    <section className="saved-sessions" aria-label="已保存会话记录">
      <div className="saved-sessions-header">
        <span>
          <History size={16} />
          已保存记录
        </span>
        <button className="secondary compact" type="button" onClick={onClear} disabled={!sessions.length}>
          <Trash2 size={15} />
          清除
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="saved-empty">暂无本地保存记录。</p>
      ) : (
        <>
          <p className="saved-empty">
            这些记录仅保存在本机浏览器，内容为明文；<br />
            导出文件同样为明文 JSON。
          </p>
          <div className="saved-session-list">
            {sessions.map((session) => (
              <button
                className={session.id === selectedSessionId ? "saved-session active" : "saved-session"}
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
              >
                <strong>房间 {session.roomId}</strong>
                <span>
                  {formatSavedAt(session.savedAt)} · {session.messages.length} 条
                </span>
              </button>
            ))}
          </div>
          {selectedSession && (
            <div className="saved-session-preview">
              <div className="saved-preview-toolbar">
                <span>{selectedSession.messages.length} 条消息</span>
                <button className="secondary compact" type="button" onClick={() => onExport(selectedSession)}>
                  <Download size={15} />
                  导出
                </button>
              </div>
              <div className="saved-message-list">
                {selectedSession.messages.slice(0, 8).map((message) => (
                  <article key={message.id}>
                    <strong>{message.author}</strong>
                    <span>{message.at}</span>
                    <p>{message.body}</p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FileTransferCard({
  transfer,
  self,
  onAccept,
  onReject,
  onSave,
  onRetry
}: {
  transfer: FileTransfer;
  self: boolean;
  onAccept?: (transferId: string) => void;
  onReject?: (transferId: string) => void;
  onSave?: (transfer: FileTransfer) => void;
  onRetry?: (transferId: string) => void;
}) {
  const isActive = transfer.status === "sending" || transfer.status === "receiving";
  const canRespond = !self && transfer.status === "offered";
  const canSave = !self && transfer.status === "complete";
  const canRetry = self && transfer.retryable && (transfer.status === "failed" || transfer.status === "rejected");

  return (
    <div className={`file-transfer ${transfer.status}`}>
      <div className="file-transfer-main">
        <span className="file-transfer-icon" aria-hidden="true">
          {transfer.status === "complete" ? <FileCheck2 size={18} /> : <FileUp size={18} />}
        </span>
        <span className="file-transfer-text">
          <strong>{transfer.name}</strong>
          <small>
            {formatBytes(transfer.size)} · {transferStatusLabel(transfer.status)}
          </small>
        </span>
      </div>
      {(isActive || transfer.progress > 0) && (
        <div className="transfer-progress" aria-label={`传输进度 ${transfer.progress}%`}>
          <span style={{ width: `${transfer.progress}%` }} />
        </div>
      )}
      {isActive && (
        <p className="transfer-tip">提示：文件加密传输期间，双方应保持页面在线。</p>
      )}
      {transfer.riskNote && <p className="transfer-tip">{transfer.riskNote}</p>}
      {transfer.failureReason && <p className="transfer-tip">原因：{transfer.failureReason}</p>}
      {canRespond && (
        <div className="file-transfer-actions">
          <button className="primary compact direct-button" type="button" onClick={() => onAccept?.(transfer.id)}>
            <Check size={16} />
            接受
          </button>
          <button className="secondary compact" type="button" onClick={() => onReject?.(transfer.id)}>
            <X size={16} />
            拒绝
          </button>
        </div>
      )}
      {canSave && (
        <>
          <p className="transfer-tip">
            浏览器支持时会选择保存位置；<br />
            否则会按默认下载设置保存。
          </p>
          <div className="file-transfer-actions">
            <button className="primary compact direct-button" type="button" onClick={() => onSave?.(transfer)}>
              <Download size={16} />
              保存
            </button>
          </div>
        </>
      )}
      {canRetry && (
        <div className="file-transfer-actions">
          <button className="secondary compact" type="button" onClick={() => onRetry?.(transfer.id)}>
            <RefreshCw size={16} />
            重新发送
          </button>
        </div>
      )}
    </div>
  );
}

function ChatPanel({
  title,
  subtitle,
  hideTitle = false,
  details,
  status,
  messages,
  messageListRef,
  draft,
  onDraft,
  onSend,
  onFile,
  onAcceptFile,
  onRejectFile,
  onSaveFile,
  onRetryFile,
  onEnd,
  fileLabel,
  fileInputDisabled = false,
  fileInputTitle
}: {
  title: string;
  subtitle: string;
  hideTitle?: boolean;
  details?: React.ReactNode;
  status: React.ReactNode;
  messages: Message[];
  messageListRef?: RefObject<HTMLDivElement | null>;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onFile: (file: File) => void;
  onAcceptFile?: (transferId: string) => void;
  onRejectFile?: (transferId: string) => void;
  onSaveFile?: (transfer: FileTransfer) => void;
  onRetryFile?: (transferId: string) => void;
  onEnd?: () => void;
  fileLabel: string;
  fileInputDisabled?: boolean;
  fileInputTitle?: string;
}) {
  return (
    <section className="chat-panel" aria-label={title}>
      <header className="chat-header">
        <div className={hideTitle ? "chat-heading title-hidden" : "chat-heading"}>
          <p className="eyebrow">{subtitle}</p>
          {!hideTitle && <h2>{title}</h2>}
        </div>
        <div className="chat-status">
          {status}
          {onEnd && (
            <button className="secondary compact" type="button" onClick={onEnd}>
              <LogOut size={16} />
              结束
            </button>
          )}
        </div>
      </header>
      <div className="chat-extras">
        {details}
      </div>
      <div className="message-list" ref={messageListRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={26} />
            <span>还没有消息。</span>
          </div>
        ) : (
          messages.map((message) => (
            <article className={message.self ? "message self" : message.author === "系统" ? "message system" : "message"} key={message.id}>
              <div className="message-meta">
                <strong>{message.author}</strong>
                <span>{message.at}</span>
              </div>
              <p>{message.body}</p>
              {message.fileTransfer && (
                <FileTransferCard
                  transfer={message.fileTransfer}
                  self={Boolean(message.self)}
                  onAccept={onAcceptFile}
                  onReject={onRejectFile}
                  onSave={onSaveFile}
                  onRetry={onRetryFile}
                />
              )}
              {message.fileName && (
                <span className="file-chip">
                  <FileUp size={14} />
                  {message.fileName}
                </span>
              )}
            </article>
          ))
        )}
      </div>
      <form className="composer" onSubmit={onSend}>
        <label
          className={fileInputDisabled ? "file-button disabled" : "file-button"}
          title={fileInputTitle}
          aria-disabled={fileInputDisabled}
        >
          <FileUp size={17} />
          <span>{fileLabel}</span>
          <input
            type="file"
            disabled={fileInputDisabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                onFile(file);
                event.currentTarget.value = "";
              }
            }}
          />
        </label>
        <input
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="输入消息"
          aria-label="输入消息"
        />
        <button className="primary send-button" type="submit" disabled={!draft.trim()} title="发送消息">
          <Send size={18} />
          <span>发送</span>
        </button>
      </form>
    </section>
  );
}
