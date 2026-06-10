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
  Github,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Radio,
  Save,
  Search,
  Send,
  ShieldCheck,
  ShieldHalf,
  Sun,
  UsersRound,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

type Lane = "entry" | "p2p" | "workspace";
type P2pStep = "name" | "waiting" | "chat" | "ended";
type ConnectionState = "idle" | "connecting" | "connected" | "offline" | "error";
type P2pTransportMode = "waiting" | "direct" | "relay-text" | "offline" | "error";
type CopyState = "idle" | "copied" | "failed";
type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type FileTransferStatus = "offered" | "waiting" | "sending" | "receiving" | "complete" | "rejected" | "failed";
type FileTransfer = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: FileTransferStatus;
  progress: number;
  downloadUrl?: string;
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
type Conversation = {
  id: string;
  name: string;
  type: "direct" | "group";
  unread: number;
  last: string;
};
type ApiMessage = {
  id: string;
  authorName?: string;
  body: string;
  createdAt?: string;
};
type ApiConversation = {
  id: string;
  title?: string;
  name?: string;
  type: "direct" | "group";
  messageCount?: number;
  last?: string;
  messages?: ApiMessage[];
};
type WorkspaceUser = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "auditor";
  status: "online" | "away" | "offline";
};
type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  result: "success" | "rejected" | "failure";
  at: string;
};
type Peer = {
  id: string;
  name: string;
};
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
  signal?: SignalMessage;
};
type DataEnvelope =
  | { kind: "chat"; id: string; author: string; body: string; at: string }
  | { kind: "file-offer"; transferId: string; author: string; name: string; size: number; mimeType: string }
  | { kind: "file-accept"; transferId: string }
  | { kind: "file-reject"; transferId: string }
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

const FILE_CHUNK_SIZE = 16 * 1024;
const THEME_STORAGE_KEY = "duallane-theme-mode";

const workspaceUsers: WorkspaceUser[] = [
  { id: "u-001", name: "陈 Mira", role: "owner", status: "online" },
  { id: "u-014", name: "Jon Bell", role: "admin", status: "away" },
  { id: "u-027", name: "Nadia Ali", role: "member", status: "online" },
  { id: "u-030", name: "Theo Park", role: "auditor", status: "offline" }
];

const fallbackConversations: Conversation[] = [
  { id: "ops", name: "运营协作", type: "group", unread: 2, last: "配额复核已完成" },
  { id: "mira", name: "陈 Mira", type: "direct", unread: 0, last: "邀请已接受" },
  { id: "handoff", name: "事件交接", type: "group", unread: 0, last: "审计导出已附上" }
];

const fallbackAudit: AuditEvent[] = [
  { id: "a-1", action: "邀请已创建", actor: "陈 Mira", result: "success", at: "09:42" },
  { id: "a-2", action: "文件配额已检查", actor: "Jon Bell", result: "success", at: "10:16" },
  { id: "a-3", action: "下载被拒绝", actor: "Nadia Ali", result: "rejected", at: "10:31" }
];

const initialWorkspaceMessages: Message[] = [
  {
    id: "w-1",
    author: "陈 Mira",
    body: "GitHub 邀请门禁已启用。新成员需要先接受邀请，才能进入工作区。",
    lane: "workspace",
    at: "09:44"
  },
  {
    id: "w-2",
    author: "Jon Bell",
    body: "每日传输配额会同时统计上传和下载。",
    lane: "workspace",
    at: "10:18",
    fileName: "quota-ledger.csv"
  }
];

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

function getWsUrl(roomId: string, name: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ name });
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}?${query}`;
}

function getInviteLink(roomId: string) {
  return `${window.location.origin}/?lane=p2p&room=${encodeURIComponent(roomId)}`;
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
  if (peerCount >= 2 && rtcState === "connected") {
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
  if (socketState === "error" || rtcState === "error") {
    return "error";
  }
  if (socketState === "connected" && peerCount >= 2) {
    return "relay-text";
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
    return "文本暂走信令中转；文件等待直连通道。";
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
    return "当前为浏览器直连；服务器不保存对话内容";
  }
  if (mode === "relay-text") {
    return "当前文本走临时中转；服务器不保存对话内容";
  }
  return "服务器不保存对话内容";
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
  return "文件传输失败。";
}

function getTransferProgress(doneBytes: number, totalBytes: number) {
  if (totalBytes <= 0) {
    return 100;
  }
  return Math.min(100, Math.round((doneBytes / totalBytes) * 100));
}

function parseDataEnvelope(raw: string): DataEnvelope | null {
  try {
    const value = JSON.parse(raw) as Partial<DataEnvelope>;
    if (!value || typeof value !== "object" || typeof value.kind !== "string") {
      return null;
    }

    if (
      value.kind === "chat" &&
      typeof value.id === "string" &&
      typeof value.author === "string" &&
      typeof value.body === "string" &&
      typeof value.at === "string"
    ) {
      return value as DataEnvelope;
    }

    if (
      value.kind === "file-offer" &&
      typeof value.transferId === "string" &&
      typeof value.author === "string" &&
      typeof value.name === "string" &&
      typeof value.size === "number" &&
      typeof value.mimeType === "string"
    ) {
      return value as DataEnvelope;
    }

    if (
      (value.kind === "file-accept" || value.kind === "file-reject" || value.kind === "file-complete") &&
      typeof value.transferId === "string"
    ) {
      return value as DataEnvelope;
    }

    if (
      value.kind === "file-chunk" &&
      typeof value.transferId === "string" &&
      typeof value.index === "number" &&
      typeof value.total === "number" &&
      typeof value.data === "string"
    ) {
      return value as DataEnvelope;
    }

    return null;
  } catch {
    return null;
  }
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
  const [p2pMessages, setP2pMessages] = useState<Message[]>([]);
  const [p2pDraft, setP2pDraft] = useState("");
  const [sessionSaved, setSessionSaved] = useState<"idle" | "saved" | "discarded">("idle");
  const [p2pPeers, setP2pPeers] = useState<Peer[]>([]);
  const [p2pSocketState, setP2pSocketState] = useState<ConnectionState>("idle");
  const [p2pRtcState, setP2pRtcState] = useState<ConnectionState>("idle");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [roomDetailsOpen, setRoomDetailsOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerIdRef = useRef("");
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  const incomingFilesRef = useRef<Map<string, IncomingFileBuffer>>(new Map());
  const p2pMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceMessageListRef = useRef<HTMLDivElement | null>(null);

  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(fallbackConversations);
  const [activeConversation, setActiveConversation] = useState(fallbackConversations[0].id);
  const [workspaceMessages, setWorkspaceMessages] = useState<Message[]>(initialWorkspaceMessages);
  const [workspaceDraft, setWorkspaceDraft] = useState("");

  const activeConversationName = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversation)?.name ?? "会话",
    [activeConversation, conversations]
  );
  const p2pConnectionState = getO2OState(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pTransportMode = getP2pTransportMode(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pCanTransferFiles = p2pRtcState === "connected" && dataChannelRef.current?.readyState === "open";
  const roomDetails = useMemo<RoomDetail[]>(
    () => [
      { label: "房间 ID", value: roomId || "本地预览" },
      { label: "你", value: displayName.trim() || "访客" },
      { label: "已连接成员", value: p2pPeers.length ? p2pPeers.map((peer) => peer.name).join(", ") : "等待中" },
      { label: "信令", value: connectionStateLabel(p2pSocketState) },
      { label: "直连数据通道", value: connectionStateLabel(p2pRtcState) },
      { label: "消息路径", value: p2pTransportModeDescription(p2pTransportMode, p2pPeers.length) },
      { label: "文件路径", value: p2pCanTransferFiles ? "浏览器直连文件传输可用。" : "等待直连数据通道。" },
      {
        label: "保存方式",
        value:
          "支持的浏览器会询问保存位置；其他浏览器会按下载设置保存。"
      }
    ],
    [displayName, p2pCanTransferFiles, p2pPeers, p2pRtcState, p2pSocketState, p2pTransportMode, roomId]
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
    workspaceMessageListRef.current?.scrollTo({
      top: workspaceMessageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [workspaceMessages.length]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingRoomId = params.get("room");
    if (params.get("lane") !== "p2p" || !incomingRoomId) {
      return;
    }

    setLane("p2p");
    setP2pStep("name");
    setRoomId(incomingRoomId);
    setInviteLink(getInviteLink(incomingRoomId));
  }, []);

  useEffect(() => {
    if (p2pStep !== "chat" || !roomId) {
      return;
    }

    setP2pSocketState("connecting");
    setP2pRtcState("connecting");
    setP2pError("");
    const socket = new WebSocket(getWsUrl(roomId, displayName.trim() || "访客"));
    wsRef.current = socket;

    const sendSignal = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    const attachChannel = (channel: RTCDataChannel) => {
      dataChannelRef.current = channel;
      channel.addEventListener("open", () => setP2pRtcState("connected"));
      channel.addEventListener("close", () => {
        if (dataChannelRef.current === channel) {
          dataChannelRef.current = null;
        }
        setP2pRtcState("offline");
      });
      channel.addEventListener("error", () => setP2pRtcState("error"));
      channel.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        void handleDataChannelMessage(event.data);
      });
    };

    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendSignal({ type: "signal", signal: "ice", candidate: event.candidate.toJSON() });
      }
    });
    peerConnection.addEventListener("connectionstatechange", () => {
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

    socket.addEventListener("open", () => {
      setP2pSocketState("connected");
    });

    socket.addEventListener("message", async (event) => {
      const incoming = parsePeerMessage(event.data);
      if (incoming?.peers) {
        setP2pPeers(incoming.peers);
      }
      if (!incoming) {
        return;
      }
      const signal = incoming.signal;
      if (signal) {
        await handleSignalMessage(peerConnection, sendSignal, signal);
        return;
      }
      if (incoming.peerId) {
        peerIdRef.current = incoming.peerId;
      }
      if (incoming.peers && incoming.peers.length >= 2 && peerIdRef.current) {
        const initiator = peerIdRef.current === [...incoming.peers].sort((a, b) => a.id.localeCompare(b.id))[0].id;
        if (initiator && !dataChannelRef.current) {
          const channel = peerConnection.createDataChannel("duallane-p2p");
          attachChannel(channel);
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: "signal", signal: "offer", description: offer });
        }
      }
      const body = incoming.body;
      if (!body) {
        return;
      }
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: incoming.author,
          body,
          lane: "p2p",
          at: nowLabel()
        }
      ]);
    });

    socket.addEventListener("close", () => {
      setP2pSocketState((status) => (status === "connecting" ? "offline" : status));
      setP2pRtcState("offline");
      setP2pPeers([]);
    });

    socket.addEventListener("error", () => {
      setP2pSocketState("error");
      setP2pRtcState("error");
      setP2pError("实时信令暂不可用，你仍然可以查看本地界面流程。");
    });

    return () => {
      socket.close();
      dataChannelRef.current?.close();
      peerConnection.close();
      wsRef.current = null;
      dataChannelRef.current = null;
      pendingIceRef.current = [];
      pendingFilesRef.current.clear();
      incomingFilesRef.current.clear();
    };
  }, [p2pStep, roomId]);

  async function createP2pRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      return;
    }

    setP2pStatus("connecting");
    setP2pSocketState("idle");
    setP2pError("");
    setSessionSaved("idle");

    if (roomId) {
      setInviteLink(getInviteLink(roomId));
      setP2pStatus("idle");
      setP2pStep("chat");
      return;
    }

    try {
      const data = await fetch("/api/p2p/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name })
      }).then((response) => parseJson<{ roomId?: string; id?: string; inviteLink?: string }>(response));
      const nextRoomId = data.roomId ?? data.id ?? randomId().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(getInviteLink(nextRoomId));
    } catch (error) {
      const nextRoomId = randomId().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(getInviteLink(nextRoomId));
      setP2pError(error instanceof Error ? `房间 API 暂不可用：${error.message}` : "房间 API 暂不可用。");
    } finally {
      setP2pStatus("idle");
      setP2pStep("waiting");
    }
  }

  function sendP2pMessage(event: FormEvent<HTMLFormElement>) {
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
      wsRef.current.send(JSON.stringify({ type: "message", body }));
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
          body: "加密直连文件传输尚未就绪，请等待对方在线。",
          lane: "p2p",
          at: nowLabel()
        }
      ]);
      return;
    }

    const transferId = makeId("file");
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
          progress: 0
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
            progress: 0
          }
        }
      ]);
      return;
    }

    if (envelope.kind === "file-accept") {
      const file = pendingFilesRef.current.get(envelope.transferId);
      if (!file) {
        updateP2pFileTransfer(envelope.transferId, { status: "failed" });
        return;
      }
      void sendP2pFile(envelope.transferId, file);
      return;
    }

    if (envelope.kind === "file-reject") {
      pendingFilesRef.current.delete(envelope.transferId);
      incomingFilesRef.current.delete(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, { status: "rejected", progress: 0 });
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

  async function sendP2pFile(transferId: string, file: File) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      updateP2pFileTransfer(transferId, { status: "failed" });
      return;
    }

    updateP2pFileTransfer(transferId, { status: "sending", progress: 0 });
    const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));
    for (let index = 0; index < total; index += 1) {
      const chunk = file.slice(index * FILE_CHUNK_SIZE, Math.min(file.size, (index + 1) * FILE_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      await waitForBufferedAmount(dataChannel);
      if (dataChannel.readyState !== "open") {
        updateP2pFileTransfer(transferId, { status: "failed" });
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
    updateP2pFileTransfer(transferId, { status: "complete", progress: 100 });
  }

  async function acceptP2pFile(transferId: string) {
    const accepted = sendEnvelope({ kind: "file-accept", transferId });
    if (!accepted) {
      updateP2pFileTransfer(transferId, { status: "failed" });
      return;
    }
    updateP2pFileTransfer(transferId, { status: "receiving", progress: 0 });
  }

  function rejectP2pFile(transferId: string) {
    incomingFilesRef.current.delete(transferId);
    sendEnvelope({ kind: "file-reject", transferId });
    updateP2pFileTransfer(transferId, { status: "rejected", progress: 0 });
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

  async function openWorkspace() {
    setLane("workspace");
    setWorkspaceLoading(true);
    setWorkspaceError("");

    try {
      await fetch("/api/workspace/bootstrap").then((response) =>
        parseJson<{ user?: unknown; inviteOnly?: boolean }>(response)
      );
      setWorkspaceReady(true);
    } catch (error) {
      setWorkspaceError(
        error instanceof Error
          ? `工作区初始化暂不可用：${error.message}`
          : "工作区初始化暂不可用。"
      );
      setWorkspaceReady(false);
    }

    try {
      const data = await fetch("/api/workspace/conversations").then((response) =>
        parseJson<{ conversations?: ApiConversation[] } | ApiConversation[]>(response)
      );
      const nextConversations = Array.isArray(data) ? data : data.conversations;
      if (nextConversations?.length) {
        const mappedConversations = nextConversations.map(mapApiConversation);
        setConversations(mappedConversations);
        setActiveConversation(mappedConversations[0].id);
        setWorkspaceMessages(mapApiMessages(nextConversations[0].messages ?? []));
      }
    } catch {
      setConversations(fallbackConversations);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  function sendWorkspaceMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = workspaceDraft.trim();
    if (!body) {
      return;
    }

    setWorkspaceMessages((messages) => [
      ...messages,
      {
        id: makeId("workspace"),
        author: "你",
        body,
        lane: "workspace",
        at: nowLabel(),
        self: true
      }
    ]);
    setWorkspaceDraft("");
  }

  function resetToEntry() {
    wsRef.current?.close();
    setLane("entry");
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pMessages([]);
    setP2pDraft("");
    setP2pPeers([]);
    setP2pSocketState("idle");
    setP2pRtcState("idle");
    setRoomDetailsOpen(false);
    setCopyState("idle");
    pendingFilesRef.current.clear();
    incomingFilesRef.current.clear();
    setRoomId("");
    setInviteLink("");
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
            <h1 id="entry-title">开始对话前，先选择通信通道。</h1>
          </div>
          <div className="lane-grid" aria-label="通信通道">
            <button className="lane-choice direct-choice" type="button" onClick={() => setLane("p2p")}>
              <span className="lane-icon" aria-hidden="true">
                <LockKeyhole size={28} />
              </span>
              <strong>一对一直连</strong>
              <span>无需登录，仅使用服务器做信令协调；对话内容不在服务器保存。</span>
            </button>
            <button className="lane-choice workspace-choice" type="button" onClick={openWorkspace}>
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
                    placeholder="小陈"
                  />
                </label>
                <button className="primary direct-button" type="submit" disabled={!displayName.trim()}>
                  {roomId ? <MessageSquare size={18} /> : <Plus size={18} />}
                  {roomId ? "加入会话" : "开始会话"}
                </button>
              </form>
            </div>
          )}

          {p2pStep === "waiting" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Link2 size={30} />
              </div>
              <p className="eyebrow">房间已就绪</p>
              <h2>分享这个邀请链接。</h2>
              <p className="quiet">房间 ID 为 {roomId}。先复制链接，准备好后再进入聊天。</p>
              <div className="copy-box">
                <span>{inviteLink}</span>
                <button
                  className="icon-button"
                  type="button"
                  title="复制邀请链接"
                  onClick={() => void copyInviteLink()}
                >
                  <Clipboard size={18} />
                </button>
              </div>
              <div className="action-row">
                <button className="primary direct-button" type="button" onClick={() => setP2pStep("chat")}>
                  <MessageSquare size={18} />
                  进入聊天
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void copyInviteLink()}
                >
                  <Clipboard size={18} />
                  {copyState === "copied" ? "已复制" : "复制链接"}
                </button>
              </div>
              <StatusPill state={p2pStatus} fallbackText="可分享" />
              {copyState === "failed" && <InlineNotice tone="warning" text="复制失败，请手动选择链接文本。" />}
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
            </div>
          )}

          {p2pStep === "chat" && (
            <ChatPanel
              title="直连会话"
              subtitle={`房间 ${roomId || "本地"}`}
              trustText={p2pTrustText(p2pTransportMode)}
              details={
                <RoomDetails
                  open={roomDetailsOpen}
                  details={roomDetails}
                  peers={p2pPeers}
                  onToggle={() => setRoomDetailsOpen((open) => !open)}
                />
              }
              shareLink={inviteLink}
              onCopyShare={copyInviteLink}
              copyState={copyState}
              status={
                <>
                  <StatusPill state={p2pConnectionState} fallbackText="等待对方" />
                  <TransportPill mode={p2pTransportMode} />
                </>
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
              onEnd={() => {
                wsRef.current?.close();
                setP2pStep("ended");
              }}
              fileLabel="选择文件"
              fileInputDisabled={!p2pCanTransferFiles}
              fileInputTitle={
                p2pCanTransferFiles ? "选择文件进行加密点对点传输" : "等待对方数据通道上线"
              }
            />
          )}

          {p2pStep === "ended" && (
            <div className="single-action">
              <div className="center-icon ended-bg" aria-hidden="true">
                <Check size={30} />
              </div>
              <p className="eyebrow">会话已关闭</p>
              <h2>本次会话已结束。</h2>
              <p className="quiet">你可以只在这个浏览器中保留记录，也可以立即丢弃本地状态。</p>
              <div className="action-row">
                <button
                  className="primary direct-button"
                  type="button"
                  onClick={() => {
                    localStorage.setItem(`duallane-p2p-${roomId}`, JSON.stringify(p2pMessages));
                    setSessionSaved("saved");
                  }}
                >
                  <Save size={18} />
                  保存到本地
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setP2pMessages([]);
                    setSessionSaved("discarded");
                  }}
                >
                  <X size={18} />
                  不保存并关闭
                </button>
              </div>
              {sessionSaved === "saved" && <InlineNotice tone="success" text="已保存到本机浏览器存储。" />}
              {sessionSaved === "discarded" && <InlineNotice tone="warning" text="本地会话状态已丢弃。" />}
            </div>
          )}
        </section>
      )}

      {lane === "workspace" && (
        <section className="workspace-shell" aria-labelledby="workspace-title">
          <TopBar
            label="可审计中继通道"
            title="工作区"
            icon={<ShieldHalf size={18} />}
            onBack={resetToEntry}
          />
          <div className="workspace-status">
            <span>
              <KeyRound size={16} />
              邀请制
            </span>
            <span>
              <Github size={16} />
              需要 GitHub 登录
            </span>
            <span>
              <ShieldCheck size={16} />
              权限角色与审计日志
            </span>
          </div>
          {workspaceLoading && <InlineNotice tone="info" text="正在检查工作区初始化状态和会话列表..." />}
          {workspaceError && <InlineNotice tone="warning" text={`${workspaceError} 当前展示本地预览数据。`} />}

          <div className="workspace-grid">
            <aside className="sidebar" aria-label="工作区导航">
              <div className="search-field">
                <Search size={16} />
                <input placeholder="查找会话" aria-label="查找会话" />
              </div>
              <div className="section-title">
                <span>会话</span>
                <button className="icon-button" type="button" title="新建会话">
                  <Plus size={16} />
                </button>
              </div>
              <div className="conversation-list">
                {conversations.map((conversation) => (
                  <button
                    className={conversation.id === activeConversation ? "conversation active" : "conversation"}
                    key={conversation.id}
                    type="button"
                    onClick={() => setActiveConversation(conversation.id)}
                  >
                    <span className="conversation-icon" aria-hidden="true">
                      {conversation.type === "group" ? <UsersRound size={17} /> : <MessageSquare size={17} />}
                    </span>
                    <span>
                      <strong>{conversation.name}</strong>
                      <small>{conversation.last}</small>
                    </span>
                    {conversation.unread > 0 && <em>{conversation.unread}</em>}
                  </button>
                ))}
              </div>
              <div className="member-list">
                <div className="section-title">
                  <span>成员</span>
                </div>
                {workspaceUsers.map((user) => (
                  <div className="member" key={user.id}>
                    <span className={`presence ${user.status}`} aria-hidden="true" />
                    <span>
                      <strong>{user.name}</strong>
                      <small>{roleLabel(user.role)}</small>
                    </span>
                  </div>
                ))}
              </div>
            </aside>

            <ChatPanel
              title={activeConversationName}
              subtitle={workspaceReady ? "已认证工作区" : "后端就绪前的预览"}
              trustText="消息和文件由服务器留存"
              status={<StatusPill state={workspaceReady ? "connected" : "offline"} fallbackText="邀请门禁待就绪" />}
              messages={workspaceMessages}
              messageListRef={workspaceMessageListRef}
              draft={workspaceDraft}
              onDraft={setWorkspaceDraft}
              onSend={sendWorkspaceMessage}
              onFile={(file) =>
                setWorkspaceMessages((messages) => [
                  ...messages,
                  {
                    id: makeId("workspace"),
                    author: "你",
                    body: "已加入中继上传和配额检查队列。",
                    lane: "workspace",
                    at: nowLabel(),
                    self: true,
                    fileName: file.name
                  }
                ])
              }
              fileLabel="添加文件"
            />

            <aside className="audit-panel" aria-label="管理与审计">
              <div className="admin-strip">
                <strong>管理</strong>
                <span>每日 2 GiB 传输配额</span>
              </div>
              <div className="metric-grid">
                <div>
                  <strong>10k</strong>
                  <span>消息留存</span>
                </div>
                <div>
                  <strong>4</strong>
                  <span>启用角色</span>
                </div>
              </div>
              <div className="section-title">
                <span>审计</span>
              </div>
              <div className="audit-list">
                {fallbackAudit.map((event) => (
                  <div className="audit-row" key={event.id}>
                    <span className={`audit-dot ${event.result}`} aria-hidden="true" />
                    <span>
                      <strong>{event.action}</strong>
                      <small>
                        {event.actor} 于 {event.at}
                      </small>
                    </span>
                    <em>{auditResultLabel(event.result)}</em>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}

function parsePeerMessage(raw: unknown): PeerSocketMessage | null {
  if (typeof raw !== "string") {
    return { author: "对方", body: "收到一段二进制信令数据。" };
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      event?: string;
      body?: string;
      from?: { name?: string };
      peer?: { name?: string };
      peers?: Peer[];
      peerId?: string;
      signal?: "offer" | "answer" | "ice";
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };

    if (parsed.type === "system") {
      const peerName = parsed.peer?.name ?? "对方";
      if (parsed.event === "joined") {
        return {
          author: "系统",
          body: `${peerName} 已加入房间。`,
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      if (parsed.event === "peer-joined") {
        return {
          author: "系统",
          body: `${peerName} 已加入房间。`,
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-left") {
        return {
          author: "系统",
          body: `${peerName} 已离开房间。`,
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-list") {
        return {
          author: "系统",
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      return parsed.event ? { author: "系统", body: parsed.event, peers: parsed.peers } : null;
    }

    if (parsed.type === "signal" && parsed.signal) {
      return {
        author: parsed.from?.name ?? "对方",
        signal: {
          signal: parsed.signal,
          description: parsed.description,
          candidate: parsed.candidate
        }
      };
    }

    if (typeof parsed.body === "string" && parsed.body.trim()) {
      return {
        author: parsed.from?.name ?? "对方",
        body: parsed.body
      };
    }

    return null;
  } catch {
    return { author: "对方", body: raw };
  }
}

function mapApiConversation(conversation: ApiConversation): Conversation {
  const latestMessage = conversation.messages?.at(-1);
  return {
    id: conversation.id,
    name: conversation.title ?? conversation.name ?? "会话",
    type: conversation.type,
    unread: 0,
    last: latestMessage?.body ?? conversation.last ?? `已留存 ${conversation.messageCount ?? 0} 条消息`
  };
}

function mapApiMessages(messages: ApiMessage[]): Message[] {
  if (!messages.length) {
    return initialWorkspaceMessages;
  }

  return messages.map((message) => ({
    id: message.id,
    author: message.authorName ?? "工作区成员",
    body: message.body,
    lane: "workspace",
    at: message.createdAt ? nowLabelFromDate(message.createdAt) : nowLabel()
  }));
}

function nowLabelFromDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nowLabel();
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function roleLabel(role: WorkspaceUser["role"]) {
  const labels: Record<WorkspaceUser["role"], string> = {
    owner: "所有者",
    admin: "管理员",
    member: "成员",
    auditor: "审计员"
  };

  return labels[role];
}

function auditResultLabel(result: AuditEvent["result"]) {
  const labels: Record<AuditEvent["result"], string> = {
    success: "成功",
    rejected: "已拒绝",
    failure: "失败"
  };

  return labels[result];
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

function StatusPill({ state, fallbackText }: { state: ConnectionState; fallbackText: string }) {
  const labels: Record<ConnectionState, string> = {
    idle: fallbackText,
    connecting: "连接中",
    connected: "对方在线",
    offline: fallbackText,
    error: "受限模式"
  };

  return <span className={`status-pill ${state}`}>{labels[state]}</span>;
}

function TransportPill({ mode }: { mode: P2pTransportMode }) {
  return <span className={`transport-pill ${mode}`}>{p2pTransportModeLabel(mode)}</span>;
}

function InlineNotice({ tone, text }: { tone: "info" | "success" | "warning"; text: string }) {
  return (
    <p className={`notice ${tone}`}>
      {tone === "warning" ? <AlertCircle size={16} /> : <Check size={16} />}
      {text}
    </p>
  );
}

function RoomDetails({
  open,
  details,
  peers,
  onToggle
}: {
  open: boolean;
  details: RoomDetail[];
  peers: Peer[];
  onToggle: () => void;
}) {
  return (
    <section className={open ? "room-details open" : "room-details"} aria-label="房间详情">
      <button className="room-details-toggle" type="button" onClick={onToggle} aria-expanded={open}>
        <span>
          <UsersRound size={16} />
          房间详情
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
          <div className="peer-list-inline" aria-label="已连接成员">
            {peers.length ? (
              peers.map((peer) => (
                <span key={peer.id}>
                  <span className="presence online" aria-hidden="true" />
                  {peer.name}
                </span>
              ))
            ) : (
              <span>
                <span className="presence" aria-hidden="true" />
                等待对方
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function FileTransferCard({
  transfer,
  self,
  onAccept,
  onReject,
  onSave
}: {
  transfer: FileTransfer;
  self: boolean;
  onAccept?: (transferId: string) => void;
  onReject?: (transferId: string) => void;
  onSave?: (transfer: FileTransfer) => void;
}) {
  const isActive = transfer.status === "sending" || transfer.status === "receiving";
  const canRespond = !self && transfer.status === "offered";
  const canSave = !self && transfer.status === "complete";

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
          <p className="transfer-tip">浏览器支持时会选择保存位置；否则会按默认下载设置保存。</p>
          <div className="file-transfer-actions">
            <button className="primary compact direct-button" type="button" onClick={() => onSave?.(transfer)}>
              <Download size={16} />
              保存
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChatPanel({
  title,
  subtitle,
  trustText,
  details,
  shareLink,
  onCopyShare,
  copyState,
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
  onEnd,
  fileLabel,
  fileInputDisabled = false,
  fileInputTitle
}: {
  title: string;
  subtitle: string;
  trustText: string;
  details?: React.ReactNode;
  shareLink?: string;
  onCopyShare?: () => void;
  copyState?: CopyState;
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
  onEnd?: () => void;
  fileLabel: string;
  fileInputDisabled?: boolean;
  fileInputTitle?: string;
}) {
  return (
    <section className="chat-panel" aria-label={title}>
      <header className="chat-header">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h2>{title}</h2>
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
      <div className="trust-strip">
        <ShieldCheck size={16} />
        <span>{trustText}</span>
      </div>
      <div className="chat-extras">
        {details}
        {shareLink && (
          <div className="share-block">
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
            {copyState === "failed" && <p className="copy-fallback">复制失败，请手动选择链接。</p>}
          </div>
        )}
      </div>
      <div className="message-list" ref={messageListRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={26} />
            <span>还没有消息。</span>
          </div>
        ) : (
          messages.map((message) => (
            <article className={message.self ? "message self" : "message"} key={message.id}>
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
