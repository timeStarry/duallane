import {
  AlertCircle,
  AtSign,
  ArrowLeft,
  BellRing,
  BellOff,
  Bold,
  ChevronDown,
  ChevronUp,
  Check,
  Clipboard,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileText,
  FileUp,
  FileVideo,
  Github,
  Heart,
  History,
  Italic,
  Link2,
  LayoutGrid,
  List,
  ListOrdered,
  LockKeyhole,
  LogOut,
  Mail,
  Maximize2,
  MessageSquare,
  Minus,
  Minimize2,
  Monitor,
  Moon,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Quote,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Smile,
  Strikethrough,
  Sun,
  Trash2,
  Type,
  Undo2,
  UserRound,
  UsersRound,
  X
} from "lucide-react";
import { Fragment, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  MessageBody,
  ReactionEmoteGlyph,
  getEmoteInsertText,
  findFirstImageEmoteKey,
  getReactionEmote,
  getReactionEmoteKey,
  renderMessageParts,
  visibleEmotePacks,
  type EmoteItem,
  type EmotePack
} from "./emotes";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { WorkspaceAvatarEditor } from "./WorkspaceAvatarEditor";
import {
  WorkspaceComposerEditor,
  type WorkspaceComposerDocument,
  type WorkspaceComposerEditorHandle
} from "./WorkspaceComposerEditor";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
import {
  P2P_FILE_CHUNK_SIZE,
  P2P_MAX_CHAT_BYTES,
  P2P_MAX_FILE_BYTES,
  getP2pFileChunkCount,
  parseDataEnvelope,
  parseDataEnvelopeValue,
  sha256Base64Url,
  validateP2pFileChunk,
  validateP2pFileCompletion,
  type DataEnvelope
} from "./p2p-protocol";
import { createWorkspaceJsonHeaders } from "./workspace-http";
import { AboutPage } from "./AboutPage";
import { getAppRouteUrl, parseAppRoute, workspaceRoute, type AppRoute } from "./app-route";
import { getWorkspaceEntryUrl, getWorkspaceLoginUrl } from "./workspace-url";
import { formatWorkspaceConversationTime } from "./workspace-conversation-time";
import { isPreviewableImageMimeType, renamePastedImageFiles } from "./workspace-image-files";
import {
  classifyWorkspaceFile,
  workspaceFileMatchesCategory,
  type WorkspaceFileCategory,
  type WorkspaceFileViewMode
} from "./workspace-file-category";
import {
  normalizeWorkspaceGroupAvatarEmoji,
  WORKSPACE_GROUP_AVATAR_PRESETS
} from "./workspace-group-avatar";
import { userFacingErrorMessage } from "./user-facing-error";
import { installWorkspaceUnreadFavicon } from "./workspace-unread-favicon";

type Lane = "entry" | "about" | "p2p" | "workspace-dev";
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
type FileTransferStatus = "offered" | "waiting" | "sending" | "receiving" | "verifying" | "complete" | "rejected" | "failed";
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
type WorkspaceReactionUser = {
  id: string;
  displayName: string;
  githubLogin?: string;
  avatarUrl?: string;
  createdAt: string;
};
type WorkspaceReactionGroup = {
  emoteKey: string;
  count: number;
  reactedByCurrentUser: boolean;
  users: WorkspaceReactionUser[];
};
type Message = {
  id: string;
  authorId?: string;
  author: string;
  authorAvatarUrl?: string;
  authorKind?: "human" | "bot" | "system";
  body: string;
  lane: "p2p" | "workspace";
  at: string;
  createdAt?: string;
  self?: boolean;
  localState?: "sending" | "delivered" | "failed";
  failureReason?: string;
  fileName?: string;
  content?: {
    blocks: WorkspaceContentBlock[];
  };
  attachments?: WorkspaceAttachment[];
  reactions?: WorkspaceReactionGroup[];
  pin?: WorkspaceMessagePin;
  recalledAt?: string | null;
  recallReason?: string | null;
  replyTo?: {
    author: string;
    body: string;
  };
  fileTransfer?: FileTransfer;
};
type WorkspaceUser = {
  id: string;
  githubLogin?: string;
  displayName: string;
  nickname?: string | null;
  remark?: string;
  description?: string;
  avatarUrl?: string;
  searchDiscoverable?: boolean;
  recallReason?: string;
  kind: "human" | "bot" | "system";
  role: "owner" | "admin" | "member" | "auditor";
  roleLabel?: string;
  capabilities?: {
    canStartDirectConversation?: boolean;
    canJoinGroups?: boolean;
    canManage?: boolean;
  };
  joinedAt: string;
};
type WorkspacePermissions = {
  canCreateMemberInvite: boolean;
  canCreatePrivilegedInvite: boolean;
  canManageMemberVisibility: boolean;
  canManageEmailSettings: boolean;
  canReadConversations: boolean;
  canCreateGroup: boolean;
  canCreateDirect: boolean;
  canUpload: boolean;
  canDownload: boolean;
  canViewOperationRecords: boolean;
};
type WorkspacePolicy = {
  dailyQuotaBytes: number;
  usedTodayBytes?: number;
  remainingQuotaBytes?: number;
  messageRetentionCount: number;
  memberVisibilityBasis: "direct_contacts";
};
type WorkspaceMemberVisibility = {
  basis: "direct_contacts";
  viewerUserId: string;
  automaticUserIds: string[];
  grantedUserIds: string[];
  visibleUserIds: string[];
};
type WorkspaceBootstrap = {
  auth: {
    mode: string;
    inviteOnly: boolean;
    currentUser: WorkspaceUser;
  };
  space: {
    id: string;
    name: string;
    slug: string;
    createdBy: string;
    createdAt: string;
  };
  policy: WorkspacePolicy;
  permissions: WorkspacePermissions;
  members: WorkspaceUser[];
  conversations?: WorkspaceConversation[];
  files?: WorkspaceFile[];
  invites: WorkspaceInvite[];
  inviteSummary: WorkspaceInviteSummary;
  eventCursor?: number;
};
type WorkspaceInviteSummary = {
  total: number;
  active: number;
  history: number;
  acceptedUses: number;
  availableUses: number;
};
type WorkspaceStatisticsValues = {
  members: number;
  conversations: number;
  messages: number;
  files: number;
  uploadedBytes: number;
};
type WorkspaceStatistics = {
  asOf: string;
  dayStartedAt: string;
  totals: WorkspaceStatisticsValues;
  today: WorkspaceStatisticsValues;
};
type WorkspaceInvite = {
  id: string;
  code?: string;
  inviteUrl?: string;
  codePreview: string;
  defaultRole: WorkspaceUser["role"];
  maxUses: number;
  uses: number;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  acceptedMemberCount: number;
  acceptedMembers: Array<WorkspaceUser & { acceptedAt: string }>;
};
type WorkspaceContentBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string }
  | { type: "attachment"; attachmentId: string };
type WorkspaceAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: "pending" | "available" | "failed" | "removed";
  visibility?: "private_staging" | "conversation" | "space";
};
type WorkspaceMessage = {
  id: string;
  conversationId: string;
  authorId: string;
  authorName?: string;
  authorGithubLogin?: string;
  authorAvatarUrl?: string;
  authorKind: "human" | "bot" | "system";
  kind: "user" | "bot" | "system";
  clientMessageId?: string;
  content: {
    format: string;
    plainText: string;
    blocks: WorkspaceContentBlock[];
  };
  plainText: string;
  replyToMessageId?: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  recalledAt?: string | null;
  recallReason?: string | null;
  attachments: WorkspaceAttachment[];
  reactions: WorkspaceReactionGroup[];
  pin?: WorkspaceMessagePin;
};
type WorkspaceMessagePin = {
  pinnedByUserId: string;
  pinnedAt: string;
  canUnpin: boolean;
};
type WorkspacePinnedMessage = WorkspaceMessagePin & {
  messageId: string;
  message: WorkspaceMessage;
};
type WorkspaceConversation = {
  id: string;
  spaceId: string;
  type: "direct" | "group";
  title: string;
  avatarEmoji?: string | null;
  displayTitle?: string;
  otherMember?: WorkspaceUser | null;
  retentionCount: number;
  retentionText?: string;
  createdAt: string;
  lastActivityAt?: string;
  messageCount: number;
  memberCount?: number;
  lastMessagePlainText?: string;
  lastMessageAt?: string | null;
  unreadCount?: number;
  lastReadMessageId?: string | null;
  lastReadAt?: string | null;
  lastReadSeq?: number | null;
  notificationLevel?: "all" | "mentions" | "muted";
  capabilities?: {
    canSendMessage?: boolean;
    canUploadFile?: boolean;
    canManageMembers?: boolean;
  };
  members: WorkspaceUser[];
  latestMessages: WorkspaceMessage[];
};
type WorkspaceFile = WorkspaceAttachment & {
  uploaderId: string;
  uploaderName: string;
  uploader?: {
    id?: string;
    displayName?: string;
  };
  conversationId?: string | null;
  createdAt: string;
  completedAt?: string | null;
  availableAt?: string | null;
  capabilities?: {
    canDownload?: boolean;
    canRemove?: boolean;
  };
  localUpload?: {
    file: File;
    scope: "current" | "space";
    state: "uploading" | "failed";
    failureReason?: string;
  };
};
type WorkspaceView = "chat" | "files" | "members" | "space" | "account";
type WorkspaceMobilePane = "list" | "main" | "details";
type WorkspaceCreateMode = "" | "direct" | "group";
type WorkspaceContextMode = "conversation" | "file" | "member";
type WorkspaceContextTab = "overview" | "members" | "files" | "settings";
type WorkspaceSpaceTab = "overview" | "invites" | "roles" | "visibility" | "email";
type WorkspaceFileFilter = "all" | "conversation" | "standalone" | "mine";
type WorkspaceMemberRoleFilter = "all" | WorkspaceUser["role"];
type WorkspaceMemberKindFilter = "all" | WorkspaceUser["kind"];
type WorkspaceNotificationLevel = "all" | "mentions" | "muted";
type WorkspaceRealtimeState = "idle" | "connecting" | "connected" | "syncing" | "offline" | "error";
const WORKSPACE_NOTICE_AUTO_DISMISS_MS = 5000;
type WorkspaceNoticeOptions = {
  persistent?: boolean;
  durationMs?: number;
};
type WorkspaceNotice = {
  id: number;
  tone: "info" | "success" | "warning";
  text: string;
  persistent: boolean;
  durationMs: number;
};
type WorkspaceNotificationPreferences = {
  email: string | null;
  maskedEmail: string | null;
  emailSource: "github" | "custom";
  emailVerified: boolean;
  githubEmail: string | null;
  enabled: boolean;
  immediateEnabled: boolean;
  digestEnabled: boolean;
  mailAvailable: boolean;
};
type WorkspaceNtfyPreferences = {
  enabled: boolean;
  topic: string;
  serverUrl: string;
  subscriptionUrl: string;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
};
type WorkspaceEmoteSettings = {
  availablePacks: Array<{ id: Exclude<EmotePack["id"], "custom">; label: string }>;
  enabledPackIds: Array<Exclude<EmotePack["id"], "custom">>;
  minimumEnabled: number;
};
type WorkspaceCustomEmote = {
  id: string;
  kind: "builtin" | "custom";
  label: string;
  token: string;
  src: string;
  emoteKey?: string;
  animated: boolean;
  byteSize?: number;
  sourceType?: "upload" | "attachment" | "builtin" | "custom";
  originalFileName?: string;
  originalMimeType?: string;
  createdAt: string;
};
type WorkspaceEmailSettings = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  encryption: "starttls" | "tls" | "none";
  username: string;
  fromAddress: string;
  fromName: string;
  passwordConfigured: boolean;
  activeFrom?: string | null;
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestErrorCode: string | null;
  lastDeliveryAt?: string | null;
  failedJobCount: number;
};
type WorkspaceTransferDirection = "upload" | "download";
type WorkspaceEvent = {
  id: string;
  spaceId: string;
  seq: number;
  type: string;
  actorId?: string | null;
  conversationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown>;
  createdAt: string;
};
type WorkspaceRealtimeEnvelope = {
  version?: number;
  type?: string;
  currentSeq?: number;
  replayCount?: number;
  hasMore?: boolean;
  event?: WorkspaceEvent;
  events?: WorkspaceEvent[];
  error?: {
    code: string;
    message: string;
  };
};
type WorkspaceEventPayload = {
  userId?: string;
  notificationLevel?: WorkspaceNotificationLevel;
  member?: WorkspaceUser | null;
  conversationId?: string;
  conversation?: WorkspaceConversation | null;
  messageId?: string;
  message?: WorkspaceMessage | null;
  reactions?: WorkspaceReactionGroup[];
  attachmentId?: string;
  attachment?: WorkspaceFile | null;
  status?: WorkspaceAttachment["status"];
  direction?: "upload" | "download";
  reason?: string;
};
type WorkspaceLocalMessage = {
  id: string;
  clientMessageId: string;
  conversationId: string;
  body: string;
  blocks: WorkspaceContentBlock[];
  attachments?: WorkspaceAttachment[];
  replyToMessageId?: string | null;
  createdAt: string;
  state: "sending" | "failed";
  failureReason?: string;
};
type WorkspaceComposerAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  state: "queued" | "uploading" | "uploaded" | "failed";
  progress: number;
  attachment?: WorkspaceAttachment;
  uploadId?: string;
  failureReason?: string;
  generatedFromLongMessage?: boolean;
  generatedSource?: string;
};
type WorkspaceUploadContract = {
  id: string;
  mode: "single" | "chunked";
  partSize: number;
  partCount: number;
};
const WORKSPACE_LONG_MESSAGE_CODE_POINTS = 30_000;
const WORKSPACE_LONG_MESSAGE_BYTES = 100 * 1024;
const WORKSPACE_ROLE_OPTIONS: WorkspaceUser["role"][] = ["owner", "admin", "member", "auditor"];
const WORKSPACE_CONTEXT_STORAGE_KEY = "duallane.workspace.context-open";
const WORKSPACE_MAX_STAGED_ATTACHMENTS = 10;
type WorkspaceErrorPayload = {
  error?: {
    code: string;
    message: string;
  };
};
const WORKSPACE_ERROR_COPY: Record<string, string> = {
  "auth.required": "登录后进入共享空间。",
  "auth.not_invited": "这个 GitHub 账号还没有加入共享空间。",
  "auth.identity_conflict": "GitHub 身份与已有账号不一致，请联系空间主人。",
  "auth.github_required": "请通过 GitHub 登录接受邀请。",
  "auth.github_not_configured": "GitHub 登录尚未配置。",
  "workspace.disabled": "共享空间暂未开放。",
  "permission.denied": "你当前不能执行此操作。",
  "conversation.not_found": "你无法访问此会话。",
  "conversation.required": "你无法访问此会话。",
  "file.not_found": "文件已不可用。",
  "file.storage_missing": "文件内容暂时不可用。",
  "file.storage_mismatch": "文件内容暂时不可用。",
  "quota.insufficient": "今日传输额度不足。",
  "upload.size_mismatch": "文件上传失败，请重试。",
  "upload.invalid_content": "文件上传失败，请重试。",
  "upload.part_size_mismatch": "文件分片大小不正确，请重试。",
  "upload.part_hash_mismatch": "文件分片校验失败，已自动重试。",
  "upload.parts_incomplete": "文件分片尚未上传完整，请重试。",
  "http.413": "单次上传内容过大，请使用受支持的文件或刷新后重试。",
  "message.invalid_content": "消息内容无法发送，请调整后重试。",
  "message.idempotency_conflict": "这条消息已发生变化，请重新发送。",
  "message.too_long": "消息正文过长，请作为 TXT 文件发送。",
  "message.recall_unsupported": "该消息不能撤回。",
  "profile.recall_reason_invalid": "撤回文案应为 1 至 16 个有效字符。",
  "pin.group_only": "只有群聊支持常驻消息。",
  "pin.not_author": "只能常驻自己发送的消息。",
  "pin.limit_reached": "每人在每个群聊最多常驻 3 条消息。",
  "avatar.unsupported_format": "头像仅支持 JPEG、PNG 或 WebP。",
  "avatar.invalid_size": "头像文件大小不符合要求。",
  "avatar.invalid_image": "头像图片无法解析。",
  "emote.invalid_format": "收藏表情仅支持 JPEG、PNG、WebP、GIF 或 BMP。",
  "emote.input_too_large": "收藏表情原图不能超过 10 MiB。",
  "emote.animation_too_complex": "动图帧数或时长超出限制。",
  "emote.limit_reached": "收藏表情已达到 100 个上限。",
  "emote.storage_limit_reached": "收藏表情空间已满。"
};
class WorkspaceClientError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceClientError";
    this.code = code;
  }
}
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
type P2pMessageEnvelope = Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>;
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
type IncomingFileBuffer = {
  name: string;
  size: number;
  total: number;
  mimeType: string;
  accepted: boolean;
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>;
  chunkDigests: Array<string | undefined>;
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

const P2P_LARGE_FILE_WARNING_BYTES = 100 * 1024 * 1024;
const P2P_SAVED_SESSIONS_KEY = "duallane-p2p-sessions";
const THEME_STORAGE_KEY = "duallane-theme-mode";
const P2P_SECRET_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const SECURE_ENVELOPE_VERSION = 1;
const P2P_MAX_PARTICIPANTS = 2;
const P2P_DEFAULT_PARTICIPANTS = 2;
const P2P_MESSAGE_ACK_TIMEOUT_MS = 10_000;
const P2P_FILE_ACK_TIMEOUT_MS = 10_000;
const P2P_RECONNECT_DELAY_MS = 1_500;
const P2P_RTC_NEGOTIATION_TIMEOUT_MS = 5_000;

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

function formatMessageDayLabel(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfToday - startOfDate) / 86400000);
  if (dayDelta === 0) {
    return "今天";
  }
  if (dayDelta === 1) {
    return "昨天";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric"
  }).format(date);
}

function getMessageDayKey(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
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

async function workspaceJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: createWorkspaceJsonHeaders(options)
  });
  if (!response.ok) {
    let payload: WorkspaceErrorPayload | null = null;
    try {
      payload = (await response.json()) as WorkspaceErrorPayload;
    } catch {
      // Fall back to the HTTP status below.
    }
    throw createWorkspaceClientError(response, payload);
  }
  return (await response.json()) as T;
}

async function workspaceFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let payload: WorkspaceErrorPayload | null = null;
    try {
      payload = (await response.json()) as WorkspaceErrorPayload;
    } catch {
      // Non-JSON responses fall back to the HTTP status below.
    }
    throw createWorkspaceClientError(response, payload);
  }
  return response;
}

function uploadWorkspaceFileContent(
  uploadId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  upload?: WorkspaceUploadContract
): Promise<{ attachment: WorkspaceAttachment }> {
  if (upload?.mode === "chunked") {
    return uploadWorkspaceFileInChunks(uploadId, file, upload, onProgress, signal);
  }
  return uploadWorkspaceFileSingleRequest(uploadId, file, onProgress, signal);
}

function uploadWorkspaceFileSingleRequest(
  uploadId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal
): Promise<{ attachment: WorkspaceAttachment }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.open("PUT", `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/content`);
    request.responseType = "json";
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(96, Math.max(8, Math.round((event.loaded / event.total) * 88))));
      }
    });
    request.addEventListener("load", () => {
      signal.removeEventListener("abort", abort);
      const payload = request.response && typeof request.response === "object"
        ? request.response as { attachment?: WorkspaceAttachment; error?: { code?: string; message?: string } }
        : {};
      if (request.status >= 200 && request.status < 300 && payload.attachment) {
        onProgress(100);
        resolve({ attachment: payload.attachment });
        return;
      }
      const code = payload.error?.code || `http.${request.status || 0}`;
      reject(new WorkspaceClientError(code, WORKSPACE_ERROR_COPY[code] || payload.error?.message || "文件上传失败"));
    });
    request.addEventListener("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new WorkspaceClientError("network.error", "网络连接失败，请稍后重试"));
    });
    request.addEventListener("abort", () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    request.send(file);
  });
}

async function uploadWorkspaceFileInChunks(
  uploadId: string,
  file: File,
  upload: WorkspaceUploadContract,
  onProgress: (progress: number) => void,
  signal: AbortSignal
): Promise<{ attachment: WorkspaceAttachment }> {
  const status = await workspaceJson<{
    parts: Array<{ partNumber: number; byteSize: number; sha256: string }>;
  }>(`/api/workspace/files/uploads/${encodeURIComponent(uploadId)}`);
  const received = new Map(status.parts.map((part) => [part.partNumber, part]));
  const completedBytes = new Map<number, number>();
  const activeBytes = new Map<number, number>();
  const updateProgress = () => {
    const loaded = [...completedBytes.values(), ...activeBytes.values()].reduce((total, value) => total + value, 0);
    onProgress(Math.min(96, Math.max(8, Math.round(8 + (loaded / file.size) * 88))));
  };
  let cursor = 1;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.min(2, upload.partCount) }, async () => {
    while (!failure && cursor <= upload.partCount) {
      const partNumber = cursor;
      cursor += 1;
      const start = (partNumber - 1) * upload.partSize;
      const blob = file.slice(start, Math.min(file.size, start + upload.partSize));
      const sha256 = await sha256Blob(blob);
      if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const existing = received.get(partNumber);
      if (existing?.byteSize === blob.size && existing.sha256 === sha256) {
        completedBytes.set(partNumber, blob.size);
        updateProgress();
        continue;
      }
      try {
        await retryWorkspaceUploadPart({
          uploadId,
          partNumber,
          blob,
          sha256,
          signal,
          onProgress: (loaded) => {
            activeBytes.set(partNumber, loaded);
            updateProgress();
          }
        });
        activeBytes.delete(partNumber);
        completedBytes.set(partNumber, blob.size);
        updateProgress();
      } catch (error) {
        failure = error;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  const completed = await workspaceJson<{ attachment: WorkspaceAttachment }>(
    `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: "POST", body: JSON.stringify({ mode: "chunked" }) }
  );
  onProgress(100);
  return completed;
}

async function retryWorkspaceUploadPart({
  uploadId,
  partNumber,
  blob,
  sha256,
  signal,
  onProgress
}: {
  uploadId: string;
  partNumber: number;
  blob: Blob;
  sha256: string;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await uploadWorkspacePartRequest(uploadId, partNumber, blob, sha256, signal, onProgress);
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function uploadWorkspacePartRequest(
  uploadId: string,
  partNumber: number,
  blob: Blob,
  sha256: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.open("PUT", `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`);
    request.responseType = "json";
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-duallane-part-sha256", sha256);
    request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    request.addEventListener("load", () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      const payload = request.response && typeof request.response === "object"
        ? request.response as { error?: { code?: string; message?: string } }
        : {};
      const code = payload.error?.code || `http.${request.status || 0}`;
      reject(new WorkspaceClientError(code, WORKSPACE_ERROR_COPY[code] || payload.error?.message || "文件分片上传失败"));
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(new WorkspaceClientError("network.error", "网络连接失败，请稍后重试"));
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    request.send(blob);
  });
}

async function sha256Blob(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function createWorkspaceClientError(response: Response, payload: WorkspaceErrorPayload | null) {
  const code = payload?.error?.code || `http.${response.status}`;
  const safeMessage = WORKSPACE_ERROR_COPY[code] || payload?.error?.message || `${response.status} ${response.statusText || "请求失败"}`;
  return new WorkspaceClientError(code, safeMessage);
}

function getWsUrl(roomId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}`;
}

function getWorkspaceWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/workspace`;
}

function getInviteLink(roomId: string) {
  return `${window.location.origin}/direct/${encodeURIComponent(roomId)}`;
}

function routeLane(route: AppRoute): Lane {
  if (route.kind === "about") return "about";
  if (route.kind === "direct") return "p2p";
  if (route.kind === "workspace") return "workspace-dev";
  return "entry";
}

function workspaceViewFromRoute(route: Extract<AppRoute, { kind: "workspace" }> | null): WorkspaceView {
  if (!route || route.view === "new") return "chat";
  return route.view;
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

function workspaceRoleLabel(role: WorkspaceUser["role"]) {
  const labels: Record<WorkspaceUser["role"], string> = {
    owner: "空间主人",
    admin: "管理员",
    member: "成员",
    auditor: "成员"
  };
  return labels[role];
}

function workspaceMemberRoleLabel(member: Pick<WorkspaceUser, "role" | "roleLabel">) {
  return member.roleLabel || workspaceRoleLabel(member.role);
}

function workspaceMemberKindLabel(kind: WorkspaceUser["kind"]) {
  const labels: Record<WorkspaceUser["kind"], string> = {
    human: "成员",
    bot: "机器人",
    system: "系统"
  };
  return labels[kind];
}

function WorkspaceBotBadge({ kind }: { kind?: WorkspaceUser["kind"] }) {
  if (kind !== "bot") {
    return null;
  }
  return <span className="workspace-bot-badge" aria-label="官方机器人">BOT</span>;
}

function WorkspaceIdentityName({ name, kind }: { name: string; kind?: WorkspaceUser["kind"] }) {
  return (
    <span className="workspace-identity-name">
      <span>{name}</span>
      <WorkspaceBotBadge kind={kind} />
    </span>
  );
}

function workspaceRealtimeStateLabel(state: WorkspaceRealtimeState) {
  const labels: Record<WorkspaceRealtimeState, string> = {
    idle: "等待实时同步",
    connecting: "正在连接实时同步",
    connected: "实时同步",
    syncing: "正在同步",
    offline: "实时同步已断开",
    error: "实时同步异常"
  };
  return labels[state];
}

function workspaceNotificationLevelLabel(level: WorkspaceNotificationLevel = "all") {
  const labels: Record<WorkspaceNotificationLevel, string> = {
    all: "所有消息",
    mentions: "仅提到我",
    muted: "免打扰"
  };
  return labels[level];
}

function workspaceNotificationLevelDescription(level: WorkspaceNotificationLevel = "all") {
  const descriptions: Record<WorkspaceNotificationLevel, string> = {
    all: "会话有新消息时正常提醒并计入未读。",
    mentions: "只有提到你时重点提醒，普通未读保持安静。",
    muted: "不主动提醒，仍保留未读状态。"
  };
  return descriptions[level];
}

function getWorkspaceRealtimeEvents(envelope: WorkspaceRealtimeEnvelope) {
  const events = envelope.event ? [envelope.event] : Array.isArray(envelope.events) ? envelope.events : [];
  return events.filter((item) => Number.isFinite(item.seq));
}

function formatWorkspaceTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nowLabel();
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function workspaceConversationTitle(conversation: WorkspaceConversation, currentUserId?: string) {
  if (conversation.displayTitle) {
    return conversation.displayTitle;
  }
  if (conversation.type === "direct") {
    const otherMember = conversation.members.find((member) => member.id !== currentUserId);
    return otherMember?.displayName || conversation.title;
  }
  return conversation.title;
}

function workspaceConversationMemberCount(conversation: { memberCount?: number; members: unknown[] }) {
  return conversation.memberCount ?? conversation.members.length;
}

type WorkspaceConversationPreviewInput = Pick<
  WorkspaceConversation,
  "type" | "lastMessagePlainText" | "memberCount" | "members"
> & {
  latestMessages: Array<Pick<WorkspaceMessage, "authorName" | "kind" | "plainText">>;
};

export function workspaceConversationPreview(conversation: WorkspaceConversationPreviewInput) {
  const latest = conversation.latestMessages.at(-1);
  const preview = latest?.plainText || conversation.lastMessagePlainText;
  if (preview) {
    const authorName = latest?.authorName?.trim();
    if (conversation.type === "group" && latest?.kind !== "system" && authorName) {
      return `${authorName}：${preview}`;
    }
    return preview;
  }
  return conversation.type === "group"
    ? `${workspaceConversationMemberCount(conversation)} 位成员`
    : "还没有消息";
}

function workspaceConversationTime(conversation: WorkspaceConversation) {
  return formatWorkspaceConversationTime(
    conversation.lastActivityAt || conversation.latestMessages.at(-1)?.createdAt || conversation.createdAt
  );
}

function workspaceConversationTimestamp(conversation: WorkspaceConversation) {
  return Date.parse(conversation.lastActivityAt || conversation.latestMessages.at(-1)?.createdAt || conversation.createdAt) || 0;
}

function sortWorkspaceConversations(conversations: WorkspaceConversation[]) {
  return [...conversations].sort((left, right) => {
    const activityDelta = workspaceConversationTimestamp(right) - workspaceConversationTimestamp(left);
    if (activityDelta !== 0) return activityDelta;
    return (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
  });
}

function sortWorkspaceFiles(files: WorkspaceFile[]) {
  return [...files].sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
}

function compareWorkspaceMembers(left: WorkspaceUser, right: WorkspaceUser) {
  return left.displayName.localeCompare(right.displayName, "zh-CN");
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...items, item];
}

function upsertWorkspaceMessageList(messages: WorkspaceMessage[], message: WorkspaceMessage) {
  const hasMessage = messages.some(
    (candidate) =>
      candidate.id === message.id ||
      (candidate.clientMessageId && candidate.clientMessageId === message.clientMessageId)
  );
  if (hasMessage) {
    return messages.map((candidate) =>
      candidate.id === message.id ||
      (candidate.clientMessageId && candidate.clientMessageId === message.clientMessageId)
        ? message
        : candidate
    );
  }
  const next = [...messages, message];
  return messages.length > 20 ? next : next.slice(-20);
}

function mergeWorkspaceConversation(local: WorkspaceConversation, incoming: WorkspaceConversation) {
  return {
    ...incoming,
    latestMessages:
      local.latestMessages.length > incoming.latestMessages.length
        ? local.latestMessages
        : incoming.latestMessages
  };
}

function upsertWorkspaceConversationList(conversations: WorkspaceConversation[], conversation: WorkspaceConversation) {
  const hasConversation = conversations.some((item) => item.id === conversation.id);
  return sortWorkspaceConversations(
    hasConversation
      ? conversations.map((item) => item.id === conversation.id ? mergeWorkspaceConversation(item, conversation) : item)
      : [conversation, ...conversations]
  );
}

function mergeWorkspaceConversationList(local: WorkspaceConversation[], incoming: WorkspaceConversation[]) {
  const localById = new Map(local.map((conversation) => [conversation.id, conversation]));
  return sortWorkspaceConversations(
    incoming.map((conversation) => {
      const existing = localById.get(conversation.id);
      return existing ? mergeWorkspaceConversation(existing, conversation) : conversation;
    })
  );
}

function workspaceFileScope(file: WorkspaceFile, conversations: WorkspaceConversation[]) {
  if (file.visibility === "space") {
    return "空间文件";
  }
  const conversation = conversations.find((item) => item.id === file.conversationId);
  return conversation ? workspaceConversationTitle(conversation) : "会话文件";
}

function workspaceFileUploaderName(file: WorkspaceFile) {
  return file.uploader?.displayName || file.uploaderName;
}

function workspaceFileVisibilityLabel(file: WorkspaceFile) {
  if (file.localUpload?.state === "uploading") {
    return "上传中";
  }
  if (file.localUpload?.state === "failed") {
    return "失败";
  }
  if (file.visibility === "space") {
    return "空间";
  }
  if (file.visibility === "conversation") {
    return "会话";
  }
  if (file.visibility === "private_staging") {
    return "暂存";
  }
  return "文件";
}

function workspaceMemberInitial(name: string) {
  return (name.trim().slice(0, 1) || "?").toUpperCase();
}

function workspaceInviteStatus(invite: WorkspaceInvite) {
  if (invite.revokedAt) {
    return "已撤销";
  }
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
    return "已过期";
  }
  if (invite.uses >= invite.maxUses) {
    return "已用完";
  }
  return "有效";
}

function canRevokeWorkspaceInvite(invite: WorkspaceInvite) {
  return workspaceInviteStatus(invite) === "有效";
}

function formatWorkspaceInviteDate(value?: string | null) {
  if (!value) {
    return "长期有效";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function WorkspaceInviteRow({
  invite,
  onRevoke
}: {
  invite: WorkspaceInvite;
  onRevoke: (invite: WorkspaceInvite) => void;
}) {
  const status = workspaceInviteStatus(invite);
  const hiddenAcceptedMemberCount = Math.max(0, invite.acceptedMemberCount - invite.acceptedMembers.length);
  return (
    <div className="workspace-invite-row">
      <div className="workspace-invite-main">
        <div className="workspace-invite-heading">
          <strong>{invite.codePreview}</strong>
          <span className={`workspace-invite-status ${status === "有效" ? "active" : "history"}`}>{status}</span>
        </div>
        <small>
          {workspaceRoleLabel(invite.defaultRole)} · 已使用 {invite.uses}/{invite.maxUses} · 创建于 {formatWorkspaceInviteDate(invite.createdAt)}
        </small>
        <small>{invite.expiresAt ? `有效至 ${formatWorkspaceInviteDate(invite.expiresAt)}` : "无到期时间"}</small>
        {invite.acceptedMemberCount > 0 && (
          <div className="workspace-invite-acceptances" aria-label="通过此邀请加入的成员">
            <span>已加入</span>
            <div className="workspace-invite-member-list">
              {invite.acceptedMembers.map((member) => (
                <span className="workspace-invite-member" key={member.id} title={`${member.displayName} · ${formatWorkspaceInviteDate(member.acceptedAt)}`}>
                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="tiny" decorative />
                  <span><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></span>
                </span>
              ))}
              {hiddenAcceptedMemberCount > 0 && <em>另有 {hiddenAcceptedMemberCount} 位成员</em>}
            </div>
          </div>
        )}
      </div>
      {canRevokeWorkspaceInvite(invite) && (
        <button className="secondary compact danger-action" type="button" onClick={() => onRevoke(invite)}>
          撤销
        </button>
      )}
    </div>
  );
}

function canRemoveWorkspaceFile(file: WorkspaceFile, currentUser?: WorkspaceUser) {
  if (typeof file.capabilities?.canRemove === "boolean") {
    return file.capabilities.canRemove;
  }
  return Boolean(currentUser && (file.uploaderId === currentUser.id || currentUser.role === "owner" || currentUser.role === "admin"));
}

export function buildWorkspaceMessageBlocks(text: string, mentionMembers: WorkspaceUser[] = []): WorkspaceContentBlock[] {
  const blocks: WorkspaceContentBlock[] = [];
  let cursor = 0;
  const mentionOptions = getWorkspaceMentionOptions(mentionMembers);

  while (cursor < text.length) {
    const nextMention = findNextWorkspaceMention(text, cursor, mentionOptions);
    if (!nextMention) {
      blocks.push({ type: "text", text: text.slice(cursor) });
      break;
    }

    if (nextMention.start > cursor) {
      blocks.push({ type: "text", text: text.slice(cursor, nextMention.start) });
    }
    blocks.push(nextMention.block);
    cursor = nextMention.end;
  }

  return blocks.filter((block) => block.type !== "text" || block.text.length > 0);
}

export function serializeWorkspaceMessageForCopy(message: Pick<Message, "body" | "content" | "attachments">) {
  const blocks = message.content?.blocks ?? [];
  if (blocks.length === 0) return message.body;
  const attachments = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment.fileName]));
  const source = blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label ? `[${block.label}](${block.url})` : block.url;
    if (block.type === "emoji") return block.shortcode.startsWith("custom:")
      ? `[${block.shortcode}]`
      : `:${block.shortcode}:`;
    return attachments.get(block.attachmentId) ?? "";
  }).join("");
  return source || message.body;
}

function getWorkspaceEmoteFavoriteSource(message: Pick<Message, "content" | "attachments">) {
  const customBlock = message.content?.blocks.find((block) =>
    block.type === "emoji" && /^custom:[a-f0-9-]{36}$/i.test(block.shortcode)
  );
  if (customBlock?.type === "emoji") {
    return { customEmoteId: customBlock.shortcode.slice("custom:".length) };
  }
  const text = message.content?.blocks
    .filter((block): block is Extract<WorkspaceContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("") ?? "";
  const emoteKey = findFirstImageEmoteKey(text);
  if (emoteKey) return { emoteKey };
  const attachment = message.attachments?.find((item) =>
    item.status === "available" && isPreviewableImageMimeType(item.mimeType)
  );
  return attachment ? { attachmentId: attachment.id } : null;
}

function getWorkspaceMentionOptions(members: WorkspaceUser[]) {
  return members.flatMap((member) => {
    const labels = Array.from(new Set(
      [member.displayName, member.githubLogin].filter((value): value is string => Boolean(value)).map((value) => value.trim())
    ));
    return labels.map((label) => ({
      token: `@${label}`,
      member
    }));
  }).sort((a, b) => b.token.length - a.token.length);
}

function findNextWorkspaceMention(
  text: string,
  cursor: number,
  options: Array<{ token: string; member: WorkspaceUser }>
) {
  let best: { start: number; end: number; block: WorkspaceContentBlock } | null = null;

  for (const option of options) {
    let start = text.indexOf(option.token, cursor);
    while (start !== -1) {
      const end = start + option.token.length;
      if (isWorkspaceMentionBoundary(text[start - 1]) && isWorkspaceMentionBoundary(text[end])) {
        const candidate = {
          start,
          end,
          block: {
            type: "mention",
            userId: option.member.id,
            label: option.member.displayName
          } satisfies WorkspaceContentBlock
        };
        if (!best || candidate.start < best.start || (candidate.start === best.start && candidate.end > best.end)) {
          best = candidate;
        }
        break;
      }
      start = text.indexOf(option.token, start + option.token.length);
    }
  }

  return best;
}

function isWorkspaceMentionBoundary(value?: string) {
  return !value || /[\s,，.。!?！？;；:：()[\]{}"'“”‘’<>]/.test(value);
}

export function isWorkspaceTextOverAttachmentLimit(value: string) {
  return Array.from(value).length > WORKSPACE_LONG_MESSAGE_CODE_POINTS ||
    new TextEncoder().encode(value).byteLength > WORKSPACE_LONG_MESSAGE_BYTES;
}

function createWorkspaceLongMessageAttachment(source: string): WorkspaceComposerAttachment {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return {
    id: makeId("long-message"),
    file: new File([source], `长消息-${stamp}.txt`, { type: "text/plain" }),
    state: "queued",
    progress: 0,
    generatedFromLongMessage: true,
    generatedSource: source
  };
}

function workspaceComposerDocumentToContentBlocks(document: WorkspaceComposerDocument): WorkspaceContentBlock[] {
  const blocks: WorkspaceContentBlock[] = [];
  for (const block of document.blocks) {
    if (block.type === "mention") {
      blocks.push(block);
      continue;
    }
    if (block.type === "emote" && block.item.kind === "image" && block.item.customId) {
      blocks.push({ type: "emoji", shortcode: `custom:${block.item.customId}` });
      continue;
    }
    const text = block.type === "text" ? block.text : block.token;
    if (!text) continue;
    const previous = blocks.at(-1);
    if (previous?.type === "text") previous.text += text;
    else blocks.push({ type: "text", text });
  }
  return blocks;
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
      items: ["关闭多余窗口后重试", "需要新的对象时重新创建房间", "多人协作请改用共享空间"]
    };
  }
  if (mode === "error" || socketState === "error" || rtcState === "error") {
    return {
      title: "连接异常",
      body: "信令或浏览器直连协商暂时失败，系统正在自动重连。当前页面会保留本地消息记录。",
      items: ["双方保持页面打开并等待几秒", "长时间未恢复时重新打开同一链接", "需要稳定保留时上传到共享空间"]
    };
  }
  if (mode === "offline") {
    return {
      title: "对方离线或连接已断开",
      body: "直连会话依赖双方页面同时在线，系统会在页面保持打开时自动尝试恢复连接。",
      items: ["等待对方重新上线并保持页面打开", "长时间未恢复时重新打开同一链接", "重要文件建议上传到共享空间"]
    };
  }
  if (mode === "relay-text" && peerCount >= 2) {
    return {
      title: "文件通道还未就绪",
      body: "文本可以临时通过信令中转，文件需要等待浏览器直连数据通道建立。",
      items: ["双方保持页面打开 10 到 20 秒", "检查浏览器是否禁用了 WebRTC", "仍无法建立时上传到共享空间"]
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
    verifying: "等待校验",
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
  if (transfer.status === "verifying") {
    return "文件已发送，等待对方完成完整性校验。";
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


function workspaceMemberSecondaryText(member: WorkspaceUser) {
  const details: string[] = [];
  if (member.description) {
    details.push(member.description);
  } else if (member.githubLogin) {
    details.push(`@${member.githubLogin}`);
  }
  if (member.role !== "member") {
    details.push(workspaceMemberRoleLabel(member));
  }
  if (member.kind === "system") {
    details.push(workspaceMemberKindLabel(member.kind));
  }
  return details.join(" · ");
}
function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function getWorkspaceTransferQuotaWarning(
  byteSize: number,
  direction: WorkspaceTransferDirection,
  policy?: WorkspacePolicy
) {
  if (!policy || byteSize <= 0) {
    return "";
  }
  const remaining =
    typeof policy.remainingQuotaBytes === "number" && Number.isFinite(policy.remainingQuotaBytes)
      ? Math.max(0, policy.remainingQuotaBytes)
      : null;
  const dailyLimit =
    typeof policy.dailyQuotaBytes === "number" && Number.isFinite(policy.dailyQuotaBytes)
      ? Math.max(0, policy.dailyQuotaBytes)
      : null;
  const comparableQuota = remaining ?? dailyLimit;
  if (comparableQuota === null || byteSize <= comparableQuota) {
    return "";
  }
  const action = direction === "download" ? "下载" : "上传";
  const quotaText = remaining === null ? `单日上限 ${formatBytes(comparableQuota)}` : `今日还可传输 ${formatBytes(comparableQuota)}`;
  return `今日传输额度不足，无法${action}此文件。此文件 ${formatBytes(byteSize)}，${quotaText}。`;
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
  if (channel.readyState !== "open" || channel.bufferedAmount < 1024 * 1024) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      if (channel.readyState !== "open" || channel.bufferedAmount < 512 * 1024) {
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

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
}


export type WorkspaceMarkdownFormat =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inline-code"
  | "quote"
  | "unordered-list"
  | "ordered-list"
  | "link"
  | "code-block"
  | "divider";

export type WorkspaceMarkdownEdit = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

function workspaceMarkdownSelection(value: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(value.length, Math.min(selectionStart, selectionEnd)));
  const end = Math.max(start, Math.min(value.length, Math.max(selectionStart, selectionEnd)));
  return { start, end };
}

function wrapWorkspaceMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
  suffix: string,
  placeholder: string
): WorkspaceMarkdownEdit {
  const { start, end } = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const content = value.slice(start, end) || placeholder;
  return {
    value: value.slice(0, start) + prefix + content + suffix + value.slice(end),
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + content.length
  };
}

function prefixWorkspaceMarkdownLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefixForLine: (index: number) => string
): WorkspaceMarkdownEdit {
  const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const lineStart = value.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const nextLineBreak = value.indexOf("\n", selection.end);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  const formatted = value
    .slice(lineStart, lineEnd)
    .split("\n")
    .map((line, index) => prefixForLine(index) + line)
    .join("\n");
  return {
    value: value.slice(0, lineStart) + formatted + value.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + formatted.length
  };
}

export function applyWorkspaceMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: WorkspaceMarkdownFormat
): WorkspaceMarkdownEdit {
  if (format === "bold") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "**", "**", "粗体文本");
  }
  if (format === "italic") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "*", "*", "斜体文本");
  }
  if (format === "strikethrough") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "~~", "~~", "删除线文本");
  }
  if (format === "inline-code") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "`", "`", "代码");
  }
  if (format === "code-block") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "~~~\n", "\n~~~", "代码");
  }
  if (format === "quote") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, () => "> ");
  }
  if (format === "unordered-list") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, () => "- ");
  }
  if (format === "ordered-list") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, (index) => String(index + 1) + ". ");
  }
  if (format === "divider") {
    const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
    const before = value.slice(0, selection.start).replace(/\s*$/, "");
    const after = value.slice(selection.end).replace(/^\s*/, "");
    const prefix = before ? "\n\n" : "";
    const suffix = after ? "\n\n" : "";
    const inserted = `${prefix}---${suffix}`;
    return {
      value: before + inserted + after,
      selectionStart: before.length + prefix.length + 3,
      selectionEnd: before.length + prefix.length + 3
    };
  }

  const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const label = value.slice(selection.start, selection.end) || "链接文本";
  const prefix = "[" + label + "](";
  const url = "https://";
  return {
    value: value.slice(0, selection.start) + prefix + url + ")" + value.slice(selection.end),
    selectionStart: selection.start + prefix.length,
    selectionEnd: selection.start + prefix.length + url.length
  };
}

const WORKSPACE_MARKDOWN_FORMAT_GROUPS = [
  [
    { format: "bold", label: "粗体", icon: Bold },
    { format: "italic", label: "斜体", icon: Italic },
    { format: "strikethrough", label: "删除线", icon: Strikethrough },
    { format: "inline-code", label: "行内代码", icon: Code2 }
  ],
  [
    { format: "quote", label: "引用", icon: Quote },
    { format: "unordered-list", label: "无序列表", icon: List },
    { format: "ordered-list", label: "有序列表", icon: ListOrdered }
  ],
  [
    { format: "link", label: "链接", icon: Link2 },
    { format: "code-block", label: "代码块", icon: FileCode2 },
    { format: "divider", label: "分割线", icon: Minus }
  ]
] as const;

export function applyWorkspaceReactionOptimistic(
  groups: WorkspaceReactionGroup[],
  emoteKey: string,
  user: WorkspaceReactionUser
) {
  const existing = groups.find((group) => group.emoteKey === emoteKey);
  if (existing?.reactedByCurrentUser) {
    return groups
      .map((group) => {
        if (group.emoteKey !== emoteKey) {
          return group;
        }
        const users = group.users.filter((candidate) => candidate.id !== user.id);
        return {
          ...group,
          count: users.length,
          reactedByCurrentUser: false,
          users
        };
      })
      .filter((group) => group.count > 0);
  }
  if (existing) {
    return groups.map((group) =>
      group.emoteKey === emoteKey
        ? {
            ...group,
            count: group.users.some((candidate) => candidate.id === user.id)
              ? group.users.length
              : group.users.length + 1,
            reactedByCurrentUser: true,
            users: group.users.some((candidate) => candidate.id === user.id)
              ? group.users
              : [...group.users, user]
          }
        : group
    );
  }
  return [
    ...groups,
    {
      emoteKey,
      count: 1,
      reactedByCurrentUser: true,
      users: [user]
    }
  ];
}

export function shouldApplyWorkspaceReactionResponse(currentEventSeq: number, eventSeqAtRequest: number) {
  return currentEventSeq <= eventSeqAtRequest;
}
export function App() {
  const initialParsedRouteRef = useRef<ReturnType<typeof parseAppRoute> | null>(null);
  if (!initialParsedRouteRef.current) {
    initialParsedRouteRef.current = parseAppRoute(window.location.pathname, window.location.search, window.location.hash);
  }
  const initialParsedRoute = initialParsedRouteRef.current;
  const initialRoute = initialParsedRoute.route;
  const initialRoomId = initialRoute.kind === "direct" ? initialRoute.roomId : "";
  const initialRoomSecret = initialRoute.kind === "direct" && initialRoomId ? getRoomSecretFromHash() : "";
  const initialWorkspaceRoute = initialRoute.kind === "workspace" ? initialRoute : null;
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    themeMode === "system" ? getSystemTheme() : themeMode
  );
  const [lane, setLane] = useState<Lane>(() => routeLane(initialRoute));
  const [p2pStep, setP2pStep] = useState<P2pStep>(() => initialRoomId && !initialRoomSecret ? "invalid-room" : "name");
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState(initialRoomId);
  const [inviteLink, setInviteLink] = useState(() => initialRoomId && initialRoomSecret
    ? withRoomSecret(getInviteLink(initialRoomId), initialRoomSecret)
    : "");
  const [p2pStatus, setP2pStatus] = useState<ConnectionState>("idle");
  const [p2pError, setP2pError] = useState("");
  const [p2pRoomIssue, setP2pRoomIssue] = useState<P2pRoomIssue>(() => initialRoomId && !initialRoomSecret ? "missing-key" : "");
  const [roomSecret, setRoomSecret] = useState(initialRoomSecret);
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
  const [workspaceBootstrap, setWorkspaceBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [workspaceStatistics, setWorkspaceStatistics] = useState<WorkspaceStatistics | null>(null);
  const [workspaceStatisticsLoading, setWorkspaceStatisticsLoading] = useState(false);
  const [workspaceStatisticsError, setWorkspaceStatisticsError] = useState("");
  const [workspaceConversations, setWorkspaceConversations] = useState<WorkspaceConversation[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceLibraryFiles, setWorkspaceLibraryFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceDirectoryMembers, setWorkspaceDirectoryMembers] = useState<WorkspaceUser[]>([]);
  const [workspaceSelectedConversationId, setWorkspaceSelectedConversationId] = useState(initialWorkspaceRoute?.conversationId ?? "");
  const [workspaceDraftByConversation, setWorkspaceDraftByConversation] = useState<Record<string, WorkspaceComposerDocument>>({});
  const [workspaceReplyToMessageIdByConversation, setWorkspaceReplyToMessageIdByConversation] = useState<Record<string, string>>({});
  const [workspaceComposerAttachmentsByConversation, setWorkspaceComposerAttachmentsByConversation] = useState<
    Record<string, WorkspaceComposerAttachment[]>
  >({});
  const [workspaceUnreadAnchorByConversation, setWorkspaceUnreadAnchorByConversation] = useState<
    Record<string, { messageId?: string | null; count: number }>
  >({});
  const [workspaceNewMessageCountByConversation, setWorkspaceNewMessageCountByConversation] = useState<Record<string, number>>({});
  const [workspaceAwayFromLatestByConversation, setWorkspaceAwayFromLatestByConversation] = useState<Record<string, boolean>>({});
  const [workspaceScrollToLatestRequest, setWorkspaceScrollToLatestRequest] = useState(0);
  const [workspaceSending, setWorkspaceSending] = useState(false);
  const [workspaceLocalMessages, setWorkspaceLocalMessages] = useState<WorkspaceLocalMessage[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = useState<"idle" | "loading" | "ready" | "disabled" | "auth" | "error">("idle");
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceNotice, setWorkspaceNotice] = useState<WorkspaceNotice | null>(null);
  const [workspacePendingInviteCode, setWorkspacePendingInviteCode] = useState(initialWorkspaceRoute?.inviteCode ?? "");
  const [workspaceInviteCode, setWorkspaceInviteCode] = useState("");
  const [workspaceInviteCodeId, setWorkspaceInviteCodeId] = useState("");
  const [workspaceNewGroupTitle, setWorkspaceNewGroupTitle] = useState("");
  const [workspaceNewGroupAvatarEmoji, setWorkspaceNewGroupAvatarEmoji] = useState("");
  const [workspaceGroupRenameTitle, setWorkspaceGroupRenameTitle] = useState("");
  const [workspaceGroupAvatarEmoji, setWorkspaceGroupAvatarEmoji] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => workspaceViewFromRoute(initialWorkspaceRoute));
  const [workspaceMobilePane, setWorkspaceMobilePane] = useState<WorkspaceMobilePane>("list");
  const [workspaceContextMode, setWorkspaceContextMode] = useState<WorkspaceContextMode>("conversation");
  const [workspaceContextCollapsed, setWorkspaceContextCollapsed] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(WORKSPACE_CONTEXT_STORAGE_KEY) !== "true"
  );
  const [workspaceContextTab, setWorkspaceContextTab] = useState<WorkspaceContextTab>("overview");
  const [workspaceSpaceTab, setWorkspaceSpaceTab] = useState<WorkspaceSpaceTab>(initialWorkspaceRoute?.spaceTab ?? "overview");
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<WorkspaceCreateMode>(initialWorkspaceRoute?.createMode ?? "");
  const [workspaceMemberQuery, setWorkspaceMemberQuery] = useState("");
  const [workspacePickerMemberQuery, setWorkspacePickerMemberQuery] = useState("");
  const [workspaceContextMemberQuery, setWorkspaceContextMemberQuery] = useState("");
  const [workspaceConversationQuery, setWorkspaceConversationQuery] = useState("");
  const [workspaceFileQuery, setWorkspaceFileQuery] = useState("");
  const [workspaceMemberRoleFilter, setWorkspaceMemberRoleFilter] = useState<WorkspaceMemberRoleFilter>("all");
  const [workspaceMemberKindFilter, setWorkspaceMemberKindFilter] = useState<WorkspaceMemberKindFilter>("all");
  const [workspaceVisibilityViewerId, setWorkspaceVisibilityViewerId] = useState("");
  const [workspaceMemberVisibility, setWorkspaceMemberVisibility] = useState<WorkspaceMemberVisibility | null>(null);
  const [workspaceVisibilityLoading, setWorkspaceVisibilityLoading] = useState(false);
  const [workspaceVisibilitySaving, setWorkspaceVisibilitySaving] = useState(false);
  const [workspaceGroupMemberIds, setWorkspaceGroupMemberIds] = useState<string[]>([]);
  const [workspaceFileFilter, setWorkspaceFileFilter] = useState<WorkspaceFileFilter>("all");
  const [workspaceFileCategory, setWorkspaceFileCategory] = useState<WorkspaceFileCategory>("all");
  const [workspaceFileViewMode, setWorkspaceFileViewMode] = useState<WorkspaceFileViewMode>("list");
  const [workspaceContextFileCategory, setWorkspaceContextFileCategory] = useState<WorkspaceFileCategory>("all");
  const [workspaceContextFileViewMode, setWorkspaceContextFileViewMode] = useState<WorkspaceFileViewMode>("list");
  const [workspaceSelectedFileId, setWorkspaceSelectedFileId] = useState(initialWorkspaceRoute?.fileId ?? "");
  const [workspaceSelectedMemberId, setWorkspaceSelectedMemberId] = useState(initialWorkspaceRoute?.memberId ?? "");
  const [workspaceUploading, setWorkspaceUploading] = useState(false);
  const [workspaceGroupMemberBusyId, setWorkspaceGroupMemberBusyId] = useState("");
  const [workspaceRealtimeState, setWorkspaceRealtimeState] = useState<WorkspaceRealtimeState>("idle");
  const [workspaceCreateMenuOpen, setWorkspaceCreateMenuOpen] = useState(false);
  const [workspaceUserMenuOpen, setWorkspaceUserMenuOpen] = useState(false);
  const [workspaceMemberFilterOpen, setWorkspaceMemberFilterOpen] = useState(false);
  const [workspaceReactionPendingKeys, setWorkspaceReactionPendingKeys] = useState<string[]>([]);
  const [workspacePinsByConversation, setWorkspacePinsByConversation] = useState<Record<string, WorkspacePinnedMessage[]>>({});
  const [workspacePinsExpandedByConversation, setWorkspacePinsExpandedByConversation] = useState<Record<string, boolean>>({});
  const [workspaceHistoryTargetId, setWorkspaceHistoryTargetId] = useState("");
  const [workspaceReturningToLatestConversationId, setWorkspaceReturningToLatestConversationId] = useState("");
  const [workspaceImagePreview, setWorkspaceImagePreview] = useState<WorkspaceAttachment | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [workspaceHistoryLoadingByConversation, setWorkspaceHistoryLoadingByConversation] = useState<Record<string, boolean>>({});
  const [workspaceHistoryExhaustedByConversation, setWorkspaceHistoryExhaustedByConversation] = useState<Record<string, boolean>>({});
  const localDisplayName = displayName.trim() || "访客";
  const wsRef = useRef<WebSocket | null>(null);
  const workspaceWsRef = useRef<WebSocket | null>(null);
  const workspaceRealtimeSeqRef = useRef(0);
  const workspaceNoticeSeqRef = useRef(0);
  const workspaceSeenEventIdsRef = useRef<Set<string>>(new Set());
  const workspaceRealtimeEventQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSendingRef = useRef(false);
  const workspaceReactionLocksRef = useRef<Set<string>>(new Set());
  const workspaceReactionEventSeqRef = useRef<Map<string, number>>(new Map());
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const secureKeysRef = useRef<SecureKeys | null>(null);
  const peerIdRef = useRef("");
  const p2pPeersRef = useRef<Peer[]>([]);
  const peerProfilesRef = useRef<Map<string, string>>(new Map());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const p2pDataMessageQueueRef = useRef<Promise<void>>(Promise.resolve());
  const p2pSessionGenerationRef = useRef(0);
  const pendingP2pMessageTimersRef = useRef<Map<string, number>>(new Map());
  const pendingP2pMessageAttemptsRef = useRef<Map<string, number>>(new Map());
  const pendingP2pFileAckTimersRef = useRef<Map<string, number>>(new Map());
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  const cancelledP2pFileTransfersRef = useRef<Set<string>>(new Set());
  const incomingFilesRef = useRef<Map<string, IncomingFileBuffer>>(new Map());
  const p2pDownloadUrlsRef = useRef<Map<string, string>>(new Map());
  const p2pMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceCreateSearchInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceCreateMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceCreateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceUserMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceUserTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMemberFilterRef = useRef<HTMLDivElement | null>(null);
  const workspaceMemberFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceImageViewerRef = useRef<HTMLDivElement | null>(null);
  const workspaceImageCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceLoadingRef = useRef(false);
  const workspacePreserveScrollRef = useRef(false);
  const workspacePreviousScrollHeightRef = useRef(0);
  const workspaceStickToBottomRef = useRef(true);
  const workspaceScrolledConversationIdRef = useRef("");
  const workspaceScrollPositionsRef = useRef<Map<string, number>>(new Map());
  const workspaceStickToBottomByConversationRef = useRef<Map<string, boolean>>(new Map());
  const workspaceScrollIntentUntilRef = useRef(0);
  const workspaceHandledScrollToLatestRequestRef = useRef(0);
  const workspaceUploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const workspaceComposerAttachmentsRef = useRef<Record<string, WorkspaceComposerAttachment[]>>({});
  const workspaceMarkReadInFlightRef = useRef<Set<string>>(new Set());
  const workspaceSelectedConversationIdRef = useRef("");
  const workspaceCurrentUserIdRef = useRef("");
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
  const workspaceSelectedConversation = workspaceConversations.find(
    (conversation) => conversation.id === workspaceSelectedConversationId
  );
  const workspaceTotalUnreadCount = useMemo(
    () => workspaceConversations.reduce((total, conversation) => total + Math.max(0, conversation.unreadCount ?? 0), 0),
    [workspaceConversations]
  );
  const workspaceCanManageSelectedGroup = Boolean(
    workspaceSelectedConversation?.type === "group" &&
    workspaceSelectedConversation.capabilities?.canManageMembers
  );
  const workspacePinnedMessages = workspaceSelectedConversationId
    ? workspacePinsByConversation[workspaceSelectedConversationId] ?? []
    : [];
  const workspacePinnedMessagesExpanded = workspaceSelectedConversationId
    ? Boolean(workspacePinsExpandedByConversation[workspaceSelectedConversationId])
    : false;
  const workspaceDraftDocument = workspaceSelectedConversationId
    ? workspaceDraftByConversation[workspaceSelectedConversationId] ?? { source: "", blocks: [] }
    : { source: "", blocks: [] };
  const workspaceDraft = workspaceDraftDocument.source;
  const workspaceComposerAttachments = workspaceSelectedConversationId
    ? workspaceComposerAttachmentsByConversation[workspaceSelectedConversationId] ?? []
    : [];
  const workspaceUnreadAnchor = workspaceSelectedConversationId
    ? workspaceUnreadAnchorByConversation[workspaceSelectedConversationId]
    : undefined;
  const workspaceNewMessageCount = workspaceSelectedConversationId
    ? workspaceNewMessageCountByConversation[workspaceSelectedConversationId] ?? 0
    : 0;
  const workspaceAwayFromLatest = workspaceSelectedConversationId
    ? Boolean(workspaceAwayFromLatestByConversation[workspaceSelectedConversationId])
    : false;
  const workspaceReplyToMessageId = workspaceSelectedConversationId
    ? workspaceReplyToMessageIdByConversation[workspaceSelectedConversationId] ?? ""
    : "";
  const workspaceVisibleContextTabs = useMemo(
    () =>
      ([
        { id: "overview" as const, label: "概览", visible: true },
        { id: "members" as const, label: "成员", visible: workspaceSelectedConversation?.type === "group" },
        { id: "files" as const, label: "文件", visible: true },
        { id: "settings" as const, label: "设置", visible: workspaceSelectedConversation?.type === "group" }
      ]).filter((tab) => tab.visible),
    [workspaceSelectedConversation?.type]
  );
  const workspaceFilteredConversations = useMemo(() => {
    const query = workspaceConversationQuery.trim().toLowerCase();
    if (!query) {
      return workspaceConversations;
    }
    return workspaceConversations.filter((conversation) =>
      [
        workspaceConversationTitle(conversation, workspaceBootstrap?.auth.currentUser.id),
        workspaceConversationPreview(conversation),
        conversation.type === "group" ? "群聊" : "私聊",
        ...conversation.members.map((member) => `${member.displayName} ${member.githubLogin ?? ""}`)
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [workspaceBootstrap?.auth.currentUser.id, workspaceConversationQuery, workspaceConversations]);
  const workspaceConversationFiles = useMemo(
    () =>
      workspaceSelectedConversation
        ? workspaceFiles.filter((file) => file.conversationId === workspaceSelectedConversation.id)
        : [],
    [workspaceFiles, workspaceSelectedConversation]
  );
  const workspaceFilteredConversationFiles = useMemo(
    () => workspaceConversationFiles.filter((file) => workspaceFileMatchesCategory(file, workspaceContextFileCategory)),
    [workspaceContextFileCategory, workspaceConversationFiles]
  );
  const workspaceFilteredFiles = useMemo(() => {
    const currentUserId = workspaceBootstrap?.auth.currentUser.id;
    const scopedFiles =
      workspaceFileFilter === "conversation"
          ? workspaceLibraryFiles.filter((file) => file.visibility === "conversation" || Boolean(file.conversationId))
        : workspaceFileFilter === "standalone"
          ? workspaceLibraryFiles.filter((file) => file.visibility === "space" && !file.conversationId)
        : workspaceFileFilter === "mine"
            ? workspaceLibraryFiles.filter((file) => file.uploaderId === currentUserId)
            : workspaceLibraryFiles;
    const categorizedFiles = scopedFiles.filter((file) => workspaceFileMatchesCategory(file, workspaceFileCategory));
    const query = workspaceFileQuery.trim().toLowerCase();
    if (!query) {
      return categorizedFiles;
    }
    return categorizedFiles.filter((file) =>
      [
        file.fileName,
        workspaceFileUploaderName(file),
        workspaceFileScope(file, workspaceConversations),
        workspaceFileVisibilityLabel(file),
        file.mimeType
      ].filter(Boolean).some((value) => value.toLowerCase().includes(query))
    );
  }, [workspaceBootstrap?.auth.currentUser.id, workspaceConversations, workspaceFileCategory, workspaceFileFilter, workspaceFileQuery, workspaceLibraryFiles]);
  const workspaceSelectedFile = useMemo(
    () =>
      workspaceFiles.find((file) => file.id === workspaceSelectedFileId) ??
      workspaceLibraryFiles.find((file) => file.id === workspaceSelectedFileId) ??
      null,
    [workspaceFiles, workspaceLibraryFiles, workspaceSelectedFileId]
  );
  const workspaceSelectedMember = useMemo(
    () =>
      workspaceDirectoryMembers.find((member) => member.id === workspaceSelectedMemberId) ??
      workspaceBootstrap?.members.find((member) => member.id === workspaceSelectedMemberId) ??
      null,
    [workspaceBootstrap?.members, workspaceDirectoryMembers, workspaceSelectedMemberId]
  );
  const workspaceSelectedFileConversation = useMemo(
    () =>
      workspaceSelectedFile?.conversationId
        ? workspaceConversations.find((conversation) => conversation.id === workspaceSelectedFile.conversationId) ?? null
        : null,
    [workspaceConversations, workspaceSelectedFile?.conversationId]
  );
  const workspaceImagePreviewFile = useMemo(
    () =>
      workspaceImagePreview
        ? workspaceFiles.find((file) => file.id === workspaceImagePreview.id) ??
          workspaceLibraryFiles.find((file) => file.id === workspaceImagePreview.id) ??
          null
        : null,
    [workspaceFiles, workspaceImagePreview, workspaceLibraryFiles]
  );
  const workspaceFilteredMembers = useMemo(() => {
    const query = workspaceMemberQuery.trim().toLowerCase();
    const members = workspaceDirectoryMembers;
    return members.filter((member) =>
      (workspaceMemberRoleFilter === "all" || member.role === workspaceMemberRoleFilter) &&
      (workspaceMemberKindFilter === "all" || member.kind === workspaceMemberKindFilter) &&
      (
        !query ||
        [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member), workspaceMemberKindLabel(member.kind)]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query))
      )
    );
  }, [workspaceDirectoryMembers, workspaceMemberKindFilter, workspaceMemberQuery, workspaceMemberRoleFilter]);
  const workspaceVisibilityViewers = useMemo(
    () =>
      (workspaceBootstrap?.members ?? []).filter(
        (member) =>
          member.id !== workspaceBootstrap?.auth.currentUser.id &&
          member.kind === "human" &&
          member.role !== "auditor"
      ),
    [workspaceBootstrap?.auth.currentUser.id, workspaceBootstrap?.members]
  );
  const workspaceSelectableMembers = useMemo(
    () => {
      const query = workspacePickerMemberQuery.trim().toLowerCase();
      return (workspaceBootstrap?.members ?? []).filter(
        (member) => {
          const eligible = workspaceCreateMode === "group"
            ? member.capabilities?.canJoinGroups === true
            : member.capabilities?.canStartDirectConversation === true;
          return member.id !== workspaceBootstrap?.auth.currentUser.id &&
          eligible &&
          (!query ||
            [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member), workspaceMemberKindLabel(member.kind)]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(query)));
        }
      );
    },
    [workspaceBootstrap?.auth.currentUser.id, workspaceBootstrap?.members, workspaceCreateMode, workspacePickerMemberQuery]
  );
  const workspaceAddableMembers = useMemo(
    () =>
      (workspaceBootstrap?.members ?? []).filter(
        (member) =>
          member.capabilities?.canJoinGroups === true &&
          !workspaceSelectedConversation?.members.some((item) => item.id === member.id)
      ),
    [workspaceBootstrap?.members, workspaceSelectedConversation?.members]
  );
  const workspaceContextMemberQueryText = workspaceContextMemberQuery.trim().toLowerCase();
  const workspaceConversationMembers = useMemo(() => {
    const members = workspaceSelectedConversation?.members ?? [];
    if (!workspaceContextMemberQueryText) {
      return members;
    }
    return members.filter((member) =>
      [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(workspaceContextMemberQueryText))
    );
  }, [workspaceContextMemberQueryText, workspaceSelectedConversation?.members]);
  const workspaceFilteredAddableMembers = useMemo(() => {
    if (!workspaceContextMemberQueryText) {
      return workspaceAddableMembers;
    }
    return workspaceAddableMembers.filter((member) =>
      [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(workspaceContextMemberQueryText))
    );
  }, [workspaceAddableMembers, workspaceContextMemberQueryText]);
  const workspaceMessages = useMemo<Message[]>(
    () => {
      const rawMessages = workspaceSelectedConversation?.latestMessages ?? [];
      const messageById = new Map(rawMessages.map((message) => [message.id, message]));
      const confirmedClientMessageIds = new Set(rawMessages.map((message) => message.clientMessageId).filter(Boolean));
      const serverMessages = rawMessages.map((message) => {
        const reply = message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined;
        const self = message.authorId === workspaceBootstrap?.auth.currentUser.id;
        const author = message.kind === "system" || message.authorKind === "system"
          ? "系统"
          : self
            ? "你"
            : message.authorName || message.authorGithubLogin || "成员";
        return {
          id: message.id,
          authorId: message.authorId,
          author,
          authorAvatarUrl: message.authorAvatarUrl,
          authorKind: message.authorKind,
          body: message.plainText,
          lane: "workspace" as const,
          at: formatWorkspaceTime(message.createdAt),
          createdAt: message.createdAt,
          self,
          fileName: message.attachments[0]?.fileName,
          content: message.content,
          attachments: message.attachments,
          reactions: message.reactions,
          pin: message.pin,
          recalledAt: message.recalledAt,
          recallReason: message.recallReason,
          replyTo: reply
            ? {
                author: reply.authorName || reply.authorGithubLogin || "成员",
                body: reply.plainText
              }
            : undefined
        };
      });
      const localMessages = workspaceLocalMessages
        .filter(
          (message) =>
            message.conversationId === workspaceSelectedConversation?.id &&
            !confirmedClientMessageIds.has(message.clientMessageId)
        )
        .map((message) => {
          const reply = message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined;
          return {
            id: message.id,
            authorId: workspaceBootstrap?.auth.currentUser.id,
            author: "你",
            authorAvatarUrl: workspaceBootstrap?.auth.currentUser.avatarUrl,
            authorKind: "human" as const,
            body: message.body,
            lane: "workspace" as const,
            at: formatWorkspaceTime(message.createdAt),
            createdAt: message.createdAt,
            self: true,
            localState: message.state,
            failureReason: message.failureReason,
            content: {
              blocks: message.blocks
            },
            attachments: message.attachments ?? [],
            reactions: [],
            replyTo: reply
              ? {
                  author: reply.authorName || reply.authorGithubLogin || "成员",
                  body: reply.plainText
                }
              : undefined
          };
        });
      return [...serverMessages, ...localMessages].sort(
        (left, right) => (Date.parse(left.createdAt ?? "") || 0) - (Date.parse(right.createdAt ?? "") || 0)
      );
    },
    [
      workspaceBootstrap?.auth.currentUser.avatarUrl,
      workspaceBootstrap?.auth.currentUser.id,
      workspaceLocalMessages,
      workspaceSelectedConversation?.id,
      workspaceSelectedConversation?.latestMessages
    ]
  );
  const workspaceLoadedMessageCount = workspaceSelectedConversation?.latestMessages.length ?? 0;
  const workspaceHistoryLoading = workspaceSelectedConversation
    ? Boolean(workspaceHistoryLoadingByConversation[workspaceSelectedConversation.id])
    : false;
  const workspaceCanLoadOlderMessages = Boolean(
    workspaceSelectedConversation &&
      workspaceLoadedMessageCount > 0 &&
      (workspaceSelectedConversation.messageCount ?? 0) > workspaceLoadedMessageCount &&
      workspaceReturningToLatestConversationId !== workspaceSelectedConversation.id &&
      !workspaceHistoryExhaustedByConversation[workspaceSelectedConversation.id]
  );
  const workspaceReplyTarget = useMemo(
    () => workspaceMessages.find((message) => message.id === workspaceReplyToMessageId) ?? null,
    [workspaceMessages, workspaceReplyToMessageId]
  );
  const workspaceRemainingText = useMemo(() => {
    const limit = workspaceBootstrap?.policy.dailyQuotaBytes ?? 0;
    const remaining = workspaceBootstrap?.policy.remainingQuotaBytes ?? limit;
    if (!limit) {
      return "等待空间信息";
    }
    return `${formatBytes(remaining)} 可用`;
  }, [workspaceBootstrap?.policy.dailyQuotaBytes, workspaceBootstrap?.policy.remainingQuotaBytes]);
  const workspaceQuotaDetailText = useMemo(() => {
    const limit = workspaceBootstrap?.policy.dailyQuotaBytes ?? 0;
    const used = workspaceBootstrap?.policy.usedTodayBytes ?? 0;
    if (!limit) {
      return "上传和下载共用";
    }
    return `已用 ${formatBytes(used)} / ${formatBytes(limit)}`;
  }, [workspaceBootstrap?.policy.dailyQuotaBytes, workspaceBootstrap?.policy.usedTodayBytes]);
  const workspaceSelectedFileQuotaWarning = useMemo(
    () =>
      workspaceSelectedFile
        ? getWorkspaceTransferQuotaWarning(workspaceSelectedFile.byteSize, "download", workspaceBootstrap?.policy)
        : "",
    [workspaceBootstrap?.policy, workspaceSelectedFile]
  );
  const workspaceContextAvailable = workspaceContextMode === "file"
    ? Boolean(workspaceSelectedFile)
    : workspaceContextMode === "member"
      ? Boolean(workspaceSelectedMember)
      : Boolean(workspaceSelectedConversation);
  const workspaceContextVisible = workspaceContextAvailable && !workspaceContextCollapsed;

  useEffect(() => {
    return () => {
      clearP2pMessageAckTimers();
      clearP2pFileAckTimers();
      clearIncomingP2pFiles();
      for (const controller of workspaceUploadControllersRef.current.values()) {
        controller.abort();
      }
      for (const attachments of Object.values(workspaceComposerAttachmentsRef.current)) {
        for (const attachment of attachments) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      }
    };
  }, []);

  useEffect(() => {
    workspaceComposerAttachmentsRef.current = workspaceComposerAttachmentsByConversation;
  }, [workspaceComposerAttachmentsByConversation]);

  useEffect(() => {
    workspaceSelectedConversationIdRef.current = workspaceSelectedConversationId;
  }, [workspaceSelectedConversationId]);

  useEffect(() => {
    workspaceCurrentUserIdRef.current = workspaceBootstrap?.auth.currentUser.id ?? "";
  }, [workspaceBootstrap?.auth.currentUser.id]);

  useEffect(() => {
    if (!workspaceCreateMenuOpen && !workspaceUserMenuOpen && !workspaceMemberFilterOpen) {
      return;
    }
    const openMenu = workspaceCreateMenuOpen
      ? workspaceCreateMenuRef.current
      : workspaceUserMenuOpen
        ? workspaceUserMenuRef.current
        : workspaceMemberFilterRef.current;
    const trigger = workspaceCreateMenuOpen
      ? workspaceCreateTriggerRef.current
      : workspaceUserMenuOpen
        ? workspaceUserTriggerRef.current
        : workspaceMemberFilterTriggerRef.current;
    const frame = window.requestAnimationFrame(() => {
      openMenu?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    });
    const closeMenu = () => {
      setWorkspaceCreateMenuOpen(false);
      setWorkspaceUserMenuOpen(false);
      setWorkspaceMemberFilterOpen(false);
      window.requestAnimationFrame(() => trigger?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        (workspaceCreateMenuOpen && !workspaceCreateMenuRef.current?.contains(target)) ||
        (workspaceUserMenuOpen && !workspaceUserMenuRef.current?.contains(target)) ||
        (workspaceMemberFilterOpen && !workspaceMemberFilterRef.current?.contains(target))
      ) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspaceCreateMenuOpen, workspaceMemberFilterOpen, workspaceUserMenuOpen]);

  useEffect(() => {
    if (!workspaceImagePreview || !workspaceImageViewerRef.current) {
      return;
    }
    const dialog = workspaceImageViewerRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = dialog.parentElement
      ? Array.from(dialog.parentElement.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && element !== dialog
        )
      : [];
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => workspaceImageCloseButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setWorkspaceImagePreview(null);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [workspaceImagePreview]);

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => installWorkspaceUnreadFavicon({
    active: lane === "workspace-dev" && workspaceStatus === "ready" && workspaceTotalUnreadCount > 0,
    documentVisible
  }), [documentVisible, lane, workspaceStatus, workspaceTotalUnreadCount]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.style.colorScheme = resolvedTheme;
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_CONTEXT_STORAGE_KEY, String(!workspaceContextCollapsed));
  }, [workspaceContextCollapsed]);

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
    const list = workspaceMessageListRef.current;
    if (!list) {
      return;
    }
    const forceScrollToLatest =
      workspaceReturningToLatestConversationId === workspaceSelectedConversationId &&
      workspaceScrollToLatestRequest !== workspaceHandledScrollToLatestRequestRef.current;
    if (workspacePreserveScrollRef.current && !forceScrollToLatest) {
      workspacePreserveScrollRef.current = false;
      const heightDelta = list.scrollHeight - workspacePreviousScrollHeightRef.current;
      if (heightDelta > 0) {
        list.scrollTop += heightDelta;
      }
      return;
    }
    const conversationChanged = workspaceScrolledConversationIdRef.current !== workspaceSelectedConversationId;
    workspaceScrolledConversationIdRef.current = workspaceSelectedConversationId;
    if (conversationChanged) {
      workspaceScrollIntentUntilRef.current = 0;
      workspaceStickToBottomRef.current = true;
      workspaceScrollPositionsRef.current.delete(workspaceSelectedConversationId);
      workspaceStickToBottomByConversationRef.current.set(workspaceSelectedConversationId, true);
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
      handleWorkspaceMessageListScroll(list);
      return;
    }
    if (!conversationChanged && !workspaceStickToBottomRef.current && !forceScrollToLatest) {
      return;
    }
    workspaceStickToBottomRef.current = true;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: "auto"
    });
    handleWorkspaceMessageListScroll(list);
    if (forceScrollToLatest) {
      workspaceHandledScrollToLatestRequestRef.current = workspaceScrollToLatestRequest;
      setWorkspaceHistoryExhaustedByConversation((current) => {
        if (!(workspaceSelectedConversationId in current)) return current;
        const { [workspaceSelectedConversationId]: _removed, ...rest } = current;
        return rest;
      });
      setWorkspaceReturningToLatestConversationId("");
    }
  }, [
    documentVisible,
    workspaceMessages.length,
    workspaceMobilePane,
    workspaceReturningToLatestConversationId,
    workspaceScrollToLatestRequest,
    workspaceSelectedConversationId,
    workspaceView
  ]);

  useEffect(() => {
    if (!workspaceHistoryTargetId || workspaceView !== "chat") return;
    workspaceStickToBottomRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(workspaceHistoryTargetId)}"]`
      );
      target?.scrollIntoView({ block: "center", behavior: "auto" });
      if (target && workspaceMessageListRef.current) {
        workspaceScrollPositionsRef.current.set(
          workspaceSelectedConversationId,
          workspaceMessageListRef.current.scrollTop
        );
        workspaceStickToBottomByConversationRef.current.set(workspaceSelectedConversationId, false);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceHistoryTargetId, workspaceMessages.length, workspaceSelectedConversationId, workspaceView]);

  useEffect(() => {
    const list = workspaceMessageListRef.current;
    if (!list || workspaceView !== "chat" || !workspaceSelectedConversationId) {
      return;
    }
    let frame = 0;
    const keepPinnedToBottom = () => {
      if (!workspaceStickToBottomRef.current) {
        return;
      }
      workspaceStickToBottomRef.current = true;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!workspaceStickToBottomRef.current) {
          return;
        }
        list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
        handleWorkspaceMessageListScroll(list);
      });
    };
    const observer = new ResizeObserver(keepPinnedToBottom);
    observer.observe(list);
    window.addEventListener("resize", keepPinnedToBottom);
    window.visualViewport?.addEventListener("resize", keepPinnedToBottom);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepPinnedToBottom);
      window.visualViewport?.removeEventListener("resize", keepPinnedToBottom);
      window.cancelAnimationFrame(frame);
    };
  }, [workspaceMobilePane, workspaceSelectedConversationId, workspaceView]);

  useEffect(() => {
    if (!workspaceSelectedConversation || (workspaceSelectedConversation.unreadCount ?? 0) <= 0) {
      return;
    }
    setWorkspaceUnreadAnchorByConversation((anchors) =>
      anchors[workspaceSelectedConversation.id]
        ? anchors
        : {
            ...anchors,
            [workspaceSelectedConversation.id]: {
              messageId: workspaceSelectedConversation.lastReadMessageId,
              count: workspaceSelectedConversation.unreadCount ?? 0
            }
          }
    );
  }, [
    workspaceSelectedConversation?.id,
    workspaceSelectedConversation?.lastReadMessageId,
    workspaceSelectedConversation?.unreadCount
  ]);

  useEffect(() => {
    p2pPeersRef.current = p2pPeers;
  }, [p2pPeers]);

  useEffect(() => {
    if (!selectedSavedSessionId && savedP2pSessions.length > 0) {
      setSelectedSavedSessionId(savedP2pSessions[0].id);
    }
  }, [savedP2pSessions, selectedSavedSessionId]);

  useEffect(() => {
    if (lane !== "workspace-dev") {
      return;
    }
    void loadWorkspace();
  }, [lane]);

  useEffect(() => {
    if (workspaceStatus !== "ready") {
      return;
    }
    if (workspaceConversations.length === 0) {
      if (workspaceSelectedConversationId) {
        setWorkspaceSelectedConversationId("");
        if (workspaceView === "chat") {
          replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode }));
        }
      }
      return;
    }
    if (!workspaceSelectedConversationId || !workspaceConversations.some((conversation) => conversation.id === workspaceSelectedConversationId)) {
      const fallbackId = workspaceConversations[0].id;
      const requestedId = workspaceSelectedConversationId;
      setWorkspaceSelectedConversationId(fallbackId);
      if (workspaceView === "chat") {
        replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, conversationId: fallbackId }));
        if (requestedId) showWorkspaceNotice("warning", "该会话不存在或无权访问，已返回最近会话");
      }
    }
  }, [workspaceConversations, workspacePendingInviteCode, workspaceSelectedConversationId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (workspaceSelectedConversation?.type === "group") {
      setWorkspaceGroupRenameTitle(workspaceSelectedConversation.title);
      setWorkspaceGroupAvatarEmoji(workspaceSelectedConversation.avatarEmoji ?? "");
    } else {
      setWorkspaceGroupRenameTitle("");
      setWorkspaceGroupAvatarEmoji("");
      if (workspaceContextTab === "members" || workspaceContextTab === "settings") {
        setWorkspaceContextTab("overview");
      }
    }
    setWorkspaceContextMemberQuery("");
    setWorkspaceGroupMemberBusyId("");
  }, [workspaceContextTab, workspaceSelectedConversation?.avatarEmoji, workspaceSelectedConversation?.id, workspaceSelectedConversation?.title, workspaceSelectedConversation?.type]);

  useEffect(() => {
    if (
      workspaceStatus === "ready" &&
      workspaceView === "files" &&
      workspaceSelectedFileId &&
      !workspaceFiles.some((file) => file.id === workspaceSelectedFileId) &&
      !workspaceLibraryFiles.some((file) => file.id === workspaceSelectedFileId)
    ) {
      setWorkspaceSelectedFileId("");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files" }));
      showWorkspaceNotice("warning", "该文件不存在或无权访问，已返回文件库");
    }
  }, [workspaceFiles, workspaceLibraryFiles, workspacePendingInviteCode, workspaceSelectedFileId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (
      workspaceStatus === "ready" &&
      workspaceView === "members" &&
      workspaceSelectedMemberId &&
      !workspaceDirectoryMembers.some((member) => member.id === workspaceSelectedMemberId)
    ) {
      setWorkspaceSelectedMemberId("");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "members" }));
      showWorkspaceNotice("warning", "该成员不存在或不可见，已返回成员目录");
      if (workspaceContextMode === "member") {
        setWorkspaceContextMode("conversation");
        setWorkspaceContextCollapsed(true);
      }
    }
  }, [workspaceContextMode, workspaceDirectoryMembers, workspacePendingInviteCode, workspaceSelectedMemberId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (!workspaceCreateMode) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      workspaceCreateSearchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceCreateMode]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || workspaceView !== "files") {
      return;
    }
    void refreshWorkspaceFiles();
  }, [lane, workspaceFileFilter, workspaceFileQuery, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || workspaceView !== "members") {
      return;
    }
    const timer = window.setTimeout(() => void refreshWorkspaceMembers(), 250);
    return () => window.clearTimeout(timer);
  }, [lane, workspaceMemberKindFilter, workspaceMemberQuery, workspaceMemberRoleFilter, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (workspaceStatus !== "ready" || workspaceSelectedConversation?.type !== "group") return;
    void refreshWorkspacePins(workspaceSelectedConversation.id);
  }, [workspaceSelectedConversation?.id, workspaceSelectedConversation?.type, workspaceStatus]);

  useEffect(() => {
    if (workspaceStatus !== "ready") return;
    if (
      (workspaceSpaceTab === "invites" && !workspaceBootstrap?.permissions.canCreateMemberInvite) ||
      (workspaceSpaceTab === "roles" && !workspaceBootstrap?.permissions.canCreatePrivilegedInvite) ||
      (workspaceSpaceTab === "visibility" && !workspaceBootstrap?.permissions.canManageMemberVisibility) ||
      (workspaceSpaceTab === "email" && !workspaceBootstrap?.permissions.canManageEmailSettings)
    ) {
      setWorkspaceSpaceTab("overview");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "space", spaceTab: "overview" }));
      showWorkspaceNotice("warning", "当前账号无权访问该空间设置，已返回空间概览");
    }
  }, [
    workspaceBootstrap?.permissions.canCreateMemberInvite,
    workspaceBootstrap?.permissions.canCreatePrivilegedInvite,
    workspaceBootstrap?.permissions.canManageEmailSettings,
    workspaceBootstrap?.permissions.canManageMemberVisibility,
    workspacePendingInviteCode,
    workspaceStatus,
    workspaceSpaceTab
  ]);

  useEffect(() => {
    if (workspaceBootstrap?.auth.currentUser.role !== "owner") {
      setWorkspaceStatistics(null);
      setWorkspaceStatisticsError("");
      setWorkspaceStatisticsLoading(false);
      return;
    }
    if (
      lane !== "workspace-dev" ||
      workspaceStatus !== "ready" ||
      workspaceView !== "space" ||
      workspaceSpaceTab !== "overview"
    ) {
      return;
    }
    void refreshWorkspaceStatistics();
  }, [
    lane,
    workspaceBootstrap?.auth.currentUser.role,
    workspaceSpaceTab,
    workspaceStatus,
    workspaceView
  ]);
  useEffect(() => {
    if (
      lane !== "workspace-dev" ||
      workspaceStatus !== "ready" ||
      workspaceView !== "space" ||
      workspaceSpaceTab !== "visibility" ||
      !workspaceBootstrap?.permissions.canManageMemberVisibility
    ) {
      return;
    }
    const viewerId = workspaceVisibilityViewers.some((member) => member.id === workspaceVisibilityViewerId)
      ? workspaceVisibilityViewerId
      : workspaceVisibilityViewers[0]?.id ?? "";
    if (!viewerId) {
      setWorkspaceVisibilityViewerId("");
      setWorkspaceMemberVisibility(null);
      return;
    }
    if (viewerId !== workspaceVisibilityViewerId) {
      setWorkspaceVisibilityViewerId(viewerId);
      setWorkspaceMemberVisibility(null);
      return;
    }
    void loadWorkspaceMemberVisibility(viewerId);
  }, [
    lane,
    workspaceBootstrap?.permissions.canManageMemberVisibility,
    workspaceSpaceTab,
    workspaceStatus,
    workspaceView,
    workspaceVisibilityViewerId,
    workspaceVisibilityViewers
  ]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || !workspaceBootstrap) {
      workspaceWsRef.current?.close();
      workspaceWsRef.current = null;
      setWorkspaceRealtimeState("idle");
      return;
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    let replayEventsRemaining = 0;
    let replayHasMore = false;
    workspaceRealtimeEventQueueRef.current = Promise.resolve();

    const connectWorkspaceEvents = () => {
      if (disposed) {
        return;
      }
      setWorkspaceRealtimeState("connecting");
      const socket = new WebSocket(getWorkspaceWsUrl());
      workspaceWsRef.current = socket;

      const requestEvents = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ version: 1, type: "hello", lastSeq: workspaceRealtimeSeqRef.current }));
        }
      };

      socket.addEventListener("open", () => {
        if (disposed) {
          return;
        }
        setWorkspaceRealtimeState("connected");
        requestEvents();
      });

      socket.addEventListener("message", (event) => {
        let envelope: WorkspaceRealtimeEnvelope | null = null;
        try {
          envelope = JSON.parse(String(event.data)) as WorkspaceRealtimeEnvelope;
        } catch {
          setWorkspaceRealtimeState("error");
          return;
        }
        if (envelope.error) {
          handleWorkspaceRealtimeError(envelope.error);
          return;
        }
        if (envelope.type === "ready") {
          const currentSeq = Number(envelope.currentSeq);
          replayEventsRemaining = Math.max(0, Number(envelope.replayCount) || 0);
          replayHasMore = Boolean(envelope.hasMore);
          if (envelope.replayCount === 0 && Number.isFinite(currentSeq)) {
            workspaceRealtimeSeqRef.current = Math.max(workspaceRealtimeSeqRef.current, currentSeq);
          }
          if (replayEventsRemaining === 0 && replayHasMore) {
            replayHasMore = false;
            window.setTimeout(requestEvents, 0);
          }
          setWorkspaceRealtimeState("connected");
          return;
        }
        if (envelope.type === "sync.required") {
          void syncWorkspaceRealtimeState(Number(envelope.currentSeq));
          return;
        }
        const incomingEvents = getWorkspaceRealtimeEvents(envelope);
        if (incomingEvents.length === 0) {
          setWorkspaceRealtimeState("connected");
          return;
        }
        setWorkspaceRealtimeState("syncing");
        workspaceRealtimeEventQueueRef.current = workspaceRealtimeEventQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const events = normalizeWorkspaceRealtimeEvents(incomingEvents);
            if (events.length === 0 || disposed) {
              return;
            }
            await projectWorkspaceEvents(events);
            rememberWorkspaceRealtimeEvents(events);
            if (replayEventsRemaining > 0) {
              replayEventsRemaining = Math.max(0, replayEventsRemaining - events.length);
              if (replayEventsRemaining === 0 && replayHasMore) {
                replayHasMore = false;
                window.setTimeout(requestEvents, 0);
              }
            }
          })
          .catch((error) => {
            if (!disposed) {
              showWorkspaceNotice("warning", userFacingErrorMessage(error, "同步共享空间失败"), { persistent: true });
              setWorkspaceRealtimeState("error");
            }
          })
          .finally(() => {
            if (!disposed) {
              setWorkspaceRealtimeState("connected");
            }
          });
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        setWorkspaceRealtimeState("offline");
        reconnectTimer = window.setTimeout(connectWorkspaceEvents, 3000);
      });

      socket.addEventListener("error", () => {
        if (!disposed) {
          setWorkspaceRealtimeState("error");
        }
        socket.close();
      });
    };

    connectWorkspaceEvents();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      workspaceWsRef.current?.close();
      workspaceWsRef.current = null;
    };
  }, [lane, workspaceStatus, workspaceBootstrap?.auth.currentUser.id]);

  useEffect(() => {
    if (initialParsedRoute.needsCanonicalReplace) {
      window.history.replaceState({}, "", initialParsedRoute.canonicalUrl);
    }
    applyAppRouteState(initialParsedRoute.route);

    const handlePopState = () => {
      const parsedRoute = parseAppRoute(window.location.pathname, window.location.search, window.location.hash);
      if (parsedRoute.needsCanonicalReplace) {
        window.history.replaceState({}, "", parsedRoute.canonicalUrl);
      }
      applyAppRouteState(parsedRoute.route);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
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
    const sessionKeys: SecureKeys = keys;
    const sessionGeneration = p2pSessionGenerationRef.current + 1;
    p2pSessionGenerationRef.current = sessionGeneration;

    let disposed = false;
    let iceServers: RTCIceServer[] = [];
    let peerConnection: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;
    let rtcReconnectTimer: number | undefined;
    let rtcNegotiationTimer: number | undefined;
    let socketReconnectTimer: number | undefined;
    let reconnectAllowed = true;
    let hasJoinedRoom = false;
    setP2pSocketState("connecting");
    setP2pRtcState("connecting");
    setP2pDataChannelState("idle");
    setP2pError("");
    setP2pRoomIssue("");

    const cancelRtcReconnect = () => {
      if (rtcReconnectTimer !== undefined) {
        window.clearTimeout(rtcReconnectTimer);
        rtcReconnectTimer = undefined;
      }
    };

    const cancelRtcNegotiationTimeout = () => {
      if (rtcNegotiationTimer !== undefined) {
        window.clearTimeout(rtcNegotiationTimer);
        rtcNegotiationTimer = undefined;
      }
    };

    const scheduleRtcReconnect = () => {
      if (disposed || !reconnectAllowed || rtcReconnectTimer !== undefined) {
        return;
      }
      rtcReconnectTimer = window.setTimeout(() => {
        rtcReconnectTimer = undefined;
        if (!disposed && reconnectAllowed) {
          void renegotiateRtc(true);
        }
      }, P2P_RECONNECT_DELAY_MS);
    };

    const sendSecure = async (channel: SecureChannel, payload: unknown) => {
      const activeSocket = socket;
      if (activeSocket?.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        const securePayload = await encryptSecurePayload(sessionKeys, channel, payload);
        if (disposed || socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
          return false;
        }
        activeSocket.send(JSON.stringify(securePayload));
        return true;
      } catch {
        return false;
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
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        cancelRtcReconnect();
        cancelRtcNegotiationTimeout();
        setP2pError("");
        setP2pDataChannelState("open");
        setP2pRtcState("connected");
      });
      channel.addEventListener("close", () => {
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        dataChannelRef.current = null;
        setP2pDataChannelState("closed");
        setP2pRtcState("offline");
        markInterruptedTransfers("文件通道已断开，请确认双方页面在线后重新发送");
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          markPendingP2pMessagesFailed("连接已断开，消息未送达");
        }
        scheduleRtcReconnect();
      });
      channel.addEventListener("error", () => {
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        dataChannelRef.current = null;
        setP2pDataChannelState("closed");
        setP2pRtcState("error");
        markInterruptedTransfers("文件通道异常，请等待自动重连后重新发送");
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          markPendingP2pMessagesFailed("连接异常，消息未送达");
        }
        scheduleRtcReconnect();
      });
      channel.addEventListener("message", (event) => {
        if (disposed || dataChannelRef.current !== channel || typeof event.data !== "string") {
          return;
        }
        p2pDataMessageQueueRef.current = p2pDataMessageQueueRef.current
          .then(() => {
            if (disposed || p2pSessionGenerationRef.current !== sessionGeneration) {
              return;
            }
            return handleDataChannelMessage(event.data, sessionGeneration);
          })
          .catch(() => {
            if (!disposed) {
              setP2pError("收到无效的直连数据，请让对方重试。");
            }
          });
      });
    };

    function isRtcInitiator() {
      const selfId = peerIdRef.current;
      const peers = p2pPeersRef.current;
      return Boolean(selfId && peers.length >= 2 && selfId === [...peers].sort((a, b) => a.id.localeCompare(b.id))[0]?.id);
    }

    function replacePeerConnection() {
      cancelRtcNegotiationTimeout();
      const previousChannel = dataChannelRef.current;
      if (previousChannel && previousChannel.readyState !== "closed") {
        markInterruptedTransfers("直连正在自动恢复，请等待恢复后重新发送文件");
      }
      dataChannelRef.current = null;
      previousChannel?.close();
      const previousConnection = peerConnection;
      peerConnection = null;
      previousConnection?.close();
      pendingIceRef.current = [];

      const connection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all"
      });
      peerConnection = connection;
      setP2pRtcState("connecting");
      setP2pDataChannelState("connecting");

      connection.addEventListener("icecandidate", (event) => {
        if (!disposed && peerConnection === connection && event.candidate) {
          sendSignal({ type: "signal", signal: "ice", candidate: event.candidate.toJSON() });
        }
      });
      connection.addEventListener("connectionstatechange", () => {
        if (disposed || peerConnection !== connection) {
          return;
        }
        if (connection.connectionState === "connected") {
          cancelRtcReconnect();
          cancelRtcNegotiationTimeout();
          setP2pRtcState("connected");
        } else if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        } else if (connection.connectionState === "connecting") {
          setP2pRtcState("connecting");
        }
      });
      connection.addEventListener("datachannel", (event) => {
        if (!disposed && peerConnection === connection) {
          attachChannel(event.channel);
        }
      });
      return connection;
    }

    function startRtcNegotiationTimeout(connection: RTCPeerConnection) {
      cancelRtcNegotiationTimeout();
      rtcNegotiationTimer = window.setTimeout(() => {
        rtcNegotiationTimer = undefined;
        if (disposed || peerConnection !== connection || connection.connectionState === "connected") {
          return;
        }
        replacePeerConnection();
        setP2pRtcState("offline");
        setP2pError("直连协商未收到对方响应，正在自动重试。");
        scheduleRtcReconnect();
      }, P2P_RTC_NEGOTIATION_TIMEOUT_MS);
    }

    async function renegotiateRtc(iceRestart: boolean) {
      if (disposed || !reconnectAllowed || socket?.readyState !== WebSocket.OPEN || p2pPeersRef.current.length < 2) {
        return;
      }

      let connection = peerConnection;
      if (!connection || ["closed", "failed"].includes(connection.connectionState)) {
        connection = replacePeerConnection();
      }
      if (!isRtcInitiator()) {
        return;
      }
      if (connection.signalingState !== "stable") {
        connection = replacePeerConnection();
      }

      const currentChannel = dataChannelRef.current;
      if (!currentChannel || currentChannel.readyState === "closed") {
        attachChannel(connection.createDataChannel("duallane-p2p"));
      } else if (currentChannel.readyState === "closing") {
        scheduleRtcReconnect();
        return;
      } else if (currentChannel.readyState === "open" && connection.connectionState === "connected" && !iceRestart) {
        return;
      }

      setP2pRtcState("connecting");
      try {
        const shouldRestartIce = iceRestart && connection.connectionState !== "new";
        if (shouldRestartIce) {
          connection.restartIce();
        }
        const offer = await connection.createOffer(shouldRestartIce ? { iceRestart: true } : undefined);
        if (disposed || peerConnection !== connection || connection.signalingState !== "stable") {
          return;
        }
        await connection.setLocalDescription(offer);
        const sent = await sendSecure("signal", { type: "signal", signal: "offer", description: offer });
        if (disposed || peerConnection !== connection) {
          return;
        }
        if (!sent) {
          if (peerConnection === connection) {
            replacePeerConnection();
          }
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        } else {
          startRtcNegotiationTimeout(connection);
        }
      } catch {
        if (!disposed && peerConnection === connection) {
          replacePeerConnection();
          setP2pRtcState("offline");
          setP2pError("直连恢复暂未成功，正在自动重试。");
          scheduleRtcReconnect();
        }
      }
    }

    async function applySignal(signal: SignalMessage) {
      let connection = peerConnection;
      if (
        signal.signal === "offer" &&
        (!connection || ["closed", "failed"].includes(connection.connectionState) || connection.signalingState !== "stable")
      ) {
        connection = replacePeerConnection();
      } else if (signal.signal === "ice" && (!connection || ["closed", "failed"].includes(connection.connectionState))) {
        connection = replacePeerConnection();
      }
      if (!connection || connection.connectionState === "closed") {
        return;
      }
      if (signal.signal === "answer" && connection.signalingState !== "have-local-offer") {
        return;
      }
      try {
        await handleSignalMessage(connection, sendSignal, signal);
        if (signal.signal === "answer") {
          cancelRtcNegotiationTimeout();
          setP2pError("");
        }
      } catch {
        if (!disposed && peerConnection === connection) {
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        }
      }
    }

    void (async () => {
      iceServers = await getIceServers();
      if (disposed) {
        return;
      }
      replacePeerConnection();

      function scheduleSocketReconnect() {
        if (disposed || !reconnectAllowed || socketReconnectTimer !== undefined) {
          return;
        }
        socketReconnectTimer = window.setTimeout(() => {
          socketReconnectTimer = undefined;
          connectSocket();
        }, P2P_RECONNECT_DELAY_MS);
      }

      function connectSocket() {
        if (disposed || !reconnectAllowed) {
          return;
        }
        setP2pSocketState("connecting");
        const nextSocket = new WebSocket(getWsUrl(roomId));
        socket = nextSocket;
        wsRef.current = nextSocket;

        nextSocket.addEventListener("open", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          if (socketReconnectTimer !== undefined) {
            window.clearTimeout(socketReconnectTimer);
            socketReconnectTimer = undefined;
          }
          setP2pSocketState("connected");
          setP2pError("");
          publishProfile();
        });

        nextSocket.addEventListener("message", async (event) => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          const incoming = parsePeerMessage(event.data);
          if (!incoming) {
            return;
          }
          if (incoming.systemEvent === "room-full" && hasJoinedRoom) {
            setP2pSocketState("offline");
            setP2pError("旧的信令连接仍在释放，正在自动重试。");
            nextSocket.close();
            return;
          }
          if (incoming.systemEvent === "room-not-found" || incoming.systemEvent === "room-full") {
            reconnectAllowed = false;
            cancelRtcReconnect();
            if (socketReconnectTimer !== undefined) {
              window.clearTimeout(socketReconnectTimer);
              socketReconnectTimer = undefined;
            }
            setP2pRoomIssue(incoming.systemEvent === "room-full" ? "full" : "not-found");
            setP2pSocketState("error");
            setP2pRtcState("error");
            setP2pDataChannelState("idle");
            setP2pPeers([]);
            setP2pStep("invalid-room");
            return;
          }
          if (incoming.peerId) {
            hasJoinedRoom = true;
            peerIdRef.current = incoming.peerId;
            peerProfilesRef.current.set(incoming.peerId, localDisplayName);
            publishProfile();
          }
          if (incoming.peers) {
            const resolvedPeers = resolvePeers(incoming.peers, peerProfilesRef.current, peerIdRef.current, localDisplayName);
            p2pPeersRef.current = resolvedPeers;
            setP2pPeers(resolvedPeers);
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
              const decrypted = await decryptSecurePayload<unknown>(sessionKeys, incoming.secure);
              if (
                disposed ||
                p2pSessionGenerationRef.current !== sessionGeneration ||
                socket !== nextSocket
              ) {
                return;
              }
              if (incoming.secure.channel === "signal") {
                const signal = normalizeSignalPayload(decrypted);
                if (signal) {
                  await applySignal(signal);
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
                const messageEnvelope = normalizeWsChatPayload(decrypted);
                if (messageEnvelope) {
                  await handleP2pMessageEnvelope(messageEnvelope);
                }
                return;
              }
            } catch {
              if (!disposed && p2pSessionGenerationRef.current === sessionGeneration) {
                setP2pError("收到无法解密的内容，请确认双方安全口令和邀请链接一致。");
              }
              return;
            }
          }
          const signal = incoming.signal;
          if (signal) {
            await applySignal(signal);
            return;
          }
          if (incoming.peers && incoming.peers.length >= 2 && peerIdRef.current) {
            void renegotiateRtc(false);
          }
        });

        nextSocket.addEventListener("close", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          socket = null;
          if (wsRef.current === nextSocket) {
            wsRef.current = null;
          }
          setP2pSocketState("offline");
          if (dataChannelRef.current?.readyState !== "open") {
            markPendingP2pMessagesFailed("信令连接已断开，消息未送达");
          }
          scheduleSocketReconnect();
        });

        nextSocket.addEventListener("error", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          setP2pSocketState("error");
          setP2pError("实时信令暂不可用，正在尝试重新连接。");
          nextSocket.close();
        });
      }

      connectSocket();
    })();

    return () => {
      disposed = true;
      cancelRtcReconnect();
      cancelRtcNegotiationTimeout();
      if (p2pSessionGenerationRef.current === sessionGeneration) {
        p2pSessionGenerationRef.current += 1;
      }
      p2pDataMessageQueueRef.current = Promise.resolve();
      if (socketReconnectTimer !== undefined) {
        window.clearTimeout(socketReconnectTimer);
      }
      socket?.close();
      dataChannelRef.current?.close();
      peerConnection?.close();
      wsRef.current = null;
      dataChannelRef.current = null;
      setP2pDataChannelState("idle");
      pendingIceRef.current = [];
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
        setP2pError(userFacingErrorMessage(error, "房间校验暂不可用。"));
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
      writeAppRoute({ kind: "direct", roomId: nextRoomId }, { replace: true, roomSecret: nextSecret });
      setP2pStep("waiting");
    } catch (error) {
      setRoomId("");
      setInviteLink("");
      setP2pError(userFacingErrorMessage(error, "房间 API 暂不可用。"));
    } finally {
      setP2pStatus("idle");
    }
  }

  async function loadWorkspace() {
    if (workspaceLoadingRef.current) return;
    workspaceLoadingRef.current = true;
    setWorkspaceStatus("loading");
    setWorkspaceError("");
    setWorkspaceNotice(null);
    try {
      const bootstrap = await workspaceJson<WorkspaceBootstrap>("/api/workspace/bootstrap");
      workspaceRealtimeSeqRef.current = Math.max(0, Number(bootstrap.eventCursor) || 0);
      workspaceSeenEventIdsRef.current.clear();
      const [conversations, files, members] = await Promise.all([
        bootstrap.conversations
          ? Promise.resolve({ conversations: bootstrap.conversations })
          : bootstrap.permissions.canReadConversations
          ? workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations")
          : Promise.resolve({ conversations: [] }),
        bootstrap.files
          ? Promise.resolve({ files: bootstrap.files })
          : bootstrap.permissions.canDownload
          ? workspaceJson<{ files: WorkspaceFile[] }>("/api/workspace/files")
          : Promise.resolve({ files: [] }),
        bootstrap.members
          ? Promise.resolve({ members: bootstrap.members })
          : workspaceJson<{ members: WorkspaceUser[] }>("/api/workspace/members")
      ]);
      setWorkspaceBootstrap({ ...bootstrap, members: members.members });
      setWorkspaceDirectoryMembers(members.members);
      setWorkspaceConversations(conversations.conversations);
      setWorkspaceFiles(files.files);
      setWorkspaceLibraryFiles(files.files);
      setWorkspaceHistoryLoadingByConversation({});
      setWorkspaceHistoryExhaustedByConversation({});
      setWorkspaceStatus("ready");
    } catch (error) {
      const message = userFacingErrorMessage(error, "共享空间暂时不可用");
      const code = error instanceof WorkspaceClientError ? error.code : "";
      setWorkspaceError(code === "auth.required" ? "" : message);
      setWorkspaceStatus(code === "workspace.disabled" ? "disabled" : code.startsWith("auth.") ? "auth" : "error");
    } finally {
      workspaceLoadingRef.current = false;
    }
  }

  async function refreshWorkspaceStatistics() {
    if (workspaceBootstrap?.auth.currentUser.role !== "owner") {
      return;
    }
    setWorkspaceStatisticsLoading(true);
    setWorkspaceStatisticsError("");
    try {
      const data = await workspaceJson<{ statistics: WorkspaceStatistics }>("/api/workspace/statistics");
      setWorkspaceStatistics(data.statistics);
    } catch (error) {
      setWorkspaceStatisticsError(userFacingErrorMessage(error, "系统统计暂时无法加载"));
    } finally {
      setWorkspaceStatisticsLoading(false);
    }
  }
  async function refreshWorkspaceMembers() {
    const params = new URLSearchParams();
    const query = workspaceMemberQuery.trim();
    if (query) {
      params.set("q", query);
    }
    if (workspaceMemberRoleFilter !== "all") {
      params.set("role", workspaceMemberRoleFilter);
    }
    if (workspaceMemberKindFilter !== "all") {
      params.set("kind", workspaceMemberKindFilter);
    }
    const data = await workspaceJson<{ members: WorkspaceUser[] }>(`/api/workspace/members${params.size ? `?${params.toString()}` : ""}`);
    setWorkspaceDirectoryMembers(data.members);
  }

  async function refreshWorkspaceBootstrap() {
    const data = await workspaceJson<WorkspaceBootstrap>("/api/workspace/bootstrap");
    setWorkspaceBootstrap(data);
    setWorkspaceDirectoryMembers(data.members);
    return data;
  }

  function setWorkspaceConversationDraft(conversationId: string, draft: WorkspaceComposerDocument | string) {
    if (!conversationId) {
      return;
    }
    const document = typeof draft === "string"
      ? { source: draft, blocks: draft ? [{ type: "text" as const, text: draft }] : [] }
      : draft;
    setWorkspaceDraftByConversation((drafts) => {
      if (!document.source && document.blocks.length === 0) {
        const { [conversationId]: _removed, ...rest } = drafts;
        return rest;
      }
      return { ...drafts, [conversationId]: document };
    });
  }

  function selectWorkspaceConversation(conversationId: string) {
    const previousId = workspaceSelectedConversationId;
    if (previousId && previousId !== conversationId) {
      workspaceScrollIntentUntilRef.current = 0;

      setWorkspaceUnreadAnchorByConversation((anchors) => {
        const { [previousId]: _removed, ...rest } = anchors;
        return rest;
      });
    }
    workspaceStickToBottomRef.current = true;
    setWorkspaceSelectedConversationId(conversationId);
    setWorkspaceView("chat");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, conversationId }));
    setWorkspaceContextMode("conversation");
    setWorkspaceContextTab("overview");
    setWorkspaceMobilePane("main");
    setWorkspaceCreateMenuOpen(false);
  }

  function updateWorkspaceComposerAttachments(
    conversationId: string,
    updater: (attachments: WorkspaceComposerAttachment[]) => WorkspaceComposerAttachment[]
  ) {
    setWorkspaceComposerAttachmentsByConversation((current) => {
      const nextAttachments = updater(current[conversationId] ?? []);
      if (nextAttachments.length === 0) {
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [conversationId]: nextAttachments };
    });
  }

  function stageWorkspaceAttachments(files: File[]) {
    if (!workspaceSelectedConversationId || !workspaceBootstrap?.permissions.canUpload || files.length === 0) {
      return;
    }
    const existing = workspaceComposerAttachmentsByConversation[workspaceSelectedConversationId] ?? [];
    const availableSlots = Math.max(0, WORKSPACE_MAX_STAGED_ATTACHMENTS - existing.length);
    const selected = files.slice(0, availableSlots);
    if (selected.length === 0) {
      showWorkspaceNotice("warning", `每条消息最多添加 ${WORKSPACE_MAX_STAGED_ATTACHMENTS} 个文件`);
      return;
    }
    const remainingQuota = workspaceBootstrap.policy.remainingQuotaBytes ?? workspaceBootstrap.policy.dailyQuotaBytes;
    const queuedBytes = existing
      .filter((attachment) => attachment.state !== "uploaded")
      .reduce((total, attachment) => total + attachment.file.size, 0);
    const nextBytes = selected.reduce((total, file) => total + file.size, 0);
    if (queuedBytes + nextBytes > remainingQuota) {
      showWorkspaceNotice("warning", "这些文件超过今日剩余传输额度");
      return;
    }
    const staged = selected.map<WorkspaceComposerAttachment>((file) => ({
      id: makeId("staged-file"),
      file,
      previewUrl: isPreviewableImageMimeType(file.type) ? URL.createObjectURL(file) : undefined,
      state: "queued",
      progress: 0
    }));
    updateWorkspaceComposerAttachments(workspaceSelectedConversationId, (attachments) => [...attachments, ...staged]);
    if (selected.length < files.length) {
      showWorkspaceNotice("info", `已添加 ${selected.length} 个文件，每条消息最多 ${WORKSPACE_MAX_STAGED_ATTACHMENTS} 个`);
    }
  }

  async function removeWorkspaceComposerAttachment(conversationId: string, attachmentId: string) {
    const attachment = workspaceComposerAttachmentsRef.current[conversationId]?.find((item) => item.id === attachmentId);
    if (!attachment) {
      return;
    }
    workspaceUploadControllersRef.current.get(attachmentId)?.abort();
    workspaceUploadControllersRef.current.delete(attachmentId);
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    updateWorkspaceComposerAttachments(conversationId, (attachments) =>
      attachments.filter((item) => item.id !== attachmentId)
    );
    if (attachment.attachment?.id) {
      try {
        await workspaceJson(`/api/workspace/files/${encodeURIComponent(attachment.attachment.id)}`, { method: "DELETE" });
        removeWorkspaceFileFromClient(attachment.attachment.id);
      } catch (error) {
        showWorkspaceNotice("warning", userFacingErrorMessage(error, "暂存文件移除失败"));
      }
    }
  }

  function setWorkspaceConversationReplyToMessageId(conversationId: string, messageId: string) {
    if (!conversationId) {
      return;
    }
    setWorkspaceReplyToMessageIdByConversation((replyTargets) => {
      if (!messageId) {
        const { [conversationId]: _removed, ...rest } = replyTargets;
        return rest;
      }
      return { ...replyTargets, [conversationId]: messageId };
    });
  }

  function clearWorkspaceClientState() {
    for (const controller of workspaceUploadControllersRef.current.values()) {
      controller.abort();
    }
    workspaceUploadControllersRef.current.clear();
    for (const attachments of Object.values(workspaceComposerAttachmentsRef.current)) {
      for (const attachment of attachments) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    }
    workspaceWsRef.current?.close();
    workspaceWsRef.current = null;
    workspaceRealtimeSeqRef.current = 0;
    workspaceSeenEventIdsRef.current.clear();
    workspaceRealtimeEventQueueRef.current = Promise.resolve();
    workspaceSendingRef.current = false;
    setWorkspaceBootstrap(null);
    setWorkspaceStatistics(null);
    setWorkspaceStatisticsLoading(false);
    setWorkspaceStatisticsError("");
    setWorkspaceConversations([]);
    setWorkspaceFiles([]);
    setWorkspaceLibraryFiles([]);
    setWorkspaceDirectoryMembers([]);
    setWorkspaceSelectedConversationId("");
    setWorkspaceDraftByConversation({});
    setWorkspaceReplyToMessageIdByConversation({});
    setWorkspaceComposerAttachmentsByConversation({});
    setWorkspacePinsByConversation({});
    setWorkspacePinsExpandedByConversation({});
    setWorkspaceHistoryTargetId("");
    setWorkspaceReturningToLatestConversationId("");
    setWorkspaceUnreadAnchorByConversation({});
    setWorkspaceNewMessageCountByConversation({});
    setWorkspaceAwayFromLatestByConversation({});
    setWorkspaceScrollToLatestRequest(0);
    workspaceHandledScrollToLatestRequestRef.current = 0;
    setWorkspaceSending(false);
    setWorkspaceLocalMessages([]);
    setWorkspaceError("");
    setWorkspaceNotice(null);
    setWorkspacePendingInviteCode("");
    setWorkspaceInviteCode("");
    setWorkspaceInviteCodeId("");
    setWorkspaceNewGroupTitle("");
    setWorkspaceNewGroupAvatarEmoji("");
    setWorkspaceGroupRenameTitle("");
    setWorkspaceGroupAvatarEmoji("");
    setWorkspaceView("chat");
    setWorkspaceMobilePane("list");
    setWorkspaceContextMode("conversation");
    setWorkspaceContextTab("overview");
    setWorkspaceSpaceTab("overview");
    setWorkspaceCreateMode("");
    setWorkspaceMemberQuery("");
    setWorkspacePickerMemberQuery("");
    setWorkspaceContextMemberQuery("");
    setWorkspaceConversationQuery("");
    setWorkspaceFileQuery("");
    setWorkspaceMemberRoleFilter("all");
    setWorkspaceMemberKindFilter("all");
    setWorkspaceGroupMemberIds([]);
    setWorkspaceFileFilter("all");
    setWorkspaceFileCategory("all");
    setWorkspaceFileViewMode("list");
    setWorkspaceContextFileCategory("all");
    setWorkspaceContextFileViewMode("list");
    setWorkspaceSelectedFileId("");
    setWorkspaceUploading(false);
    setWorkspaceGroupMemberBusyId("");
    setWorkspaceRealtimeState("idle");
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);
    setWorkspaceMemberFilterOpen(false);
    setWorkspaceReactionPendingKeys([]);
    workspaceReactionLocksRef.current.clear();
    setWorkspaceImagePreview(null);
    setWorkspaceHistoryLoadingByConversation({});
    setWorkspaceHistoryExhaustedByConversation({});
  }

  function handleWorkspaceRealtimeError(error: WorkspaceRealtimeEnvelope["error"]) {
    if (error?.code === "auth.required") {
      clearWorkspaceClientState();
      setWorkspaceStatus("auth");
      setWorkspaceError(error.message || "登录后进入共享空间。");
      return;
    }
    setWorkspaceRealtimeState("error");
    showWorkspaceNotice("warning", error?.message || "实时同步异常", { persistent: true });
  }

  async function logoutWorkspace() {
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } catch {
      // Local session state should still be cleared if the cookie is already gone.
    }
    clearWorkspaceClientState();
    setWorkspaceStatus("auth");
    setWorkspaceError("登录后进入共享空间。");
  }

  async function refreshWorkspaceConversations() {
    if (!workspaceBootstrap?.permissions.canReadConversations) {
      setWorkspaceConversations([]);
      return;
    }
    const data = await workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations");
    setWorkspaceConversations((conversations) => mergeWorkspaceConversationList(conversations, data.conversations));
  }

  async function refreshWorkspaceFiles() {
    if (!workspaceBootstrap?.permissions.canDownload) {
      setWorkspaceLibraryFiles([]);
      return;
    }
    const params = new URLSearchParams();
    if (workspaceFileFilter !== "all") {
      params.set("scope", workspaceFileFilter);
    }
    const query = workspaceFileQuery.trim();
    if (query) {
      params.set("q", query);
    }
    const data = await workspaceJson<{ files: WorkspaceFile[] }>(`/api/workspace/files${params.size ? `?${params.toString()}` : ""}`);
    setWorkspaceLibraryFiles(data.files);
  }

  async function refreshWorkspaceConversationMessages(conversationId: string) {
    if (!workspaceBootstrap?.permissions.canReadConversations || !conversationId) {
      return;
    }
    const params = new URLSearchParams({ limit: "40" });
    const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
    );
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, latestMessages: data.messages }
          : conversation
      )
    );
  }

  async function refreshWorkspacePins(conversationId: string) {
    const data = await workspaceJson<{ pins: WorkspacePinnedMessage[] }>(
      `/api/workspace/groups/${encodeURIComponent(conversationId)}/pins?limit=100`
    );
    setWorkspacePinsByConversation((current) => ({ ...current, [conversationId]: data.pins }));
    return data.pins;
  }

  async function toggleWorkspacePin(message: Message) {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.type !== "group") return;
    clearWorkspaceNotice();
    try {
      if (message.pin) {
        await workspaceJson(`/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/pins/${encodeURIComponent(message.id)}`, {
          method: "DELETE"
        });
        showWorkspaceNotice("success", "已取消常驻");
      } else {
        await workspaceJson(`/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/pins`, {
          method: "POST",
          body: JSON.stringify({ messageId: message.id })
        });
        showWorkspaceNotice("success", "消息已设为常驻");
      }
      await Promise.all([
        refreshWorkspacePins(workspaceSelectedConversation.id),
        refreshWorkspaceConversationMessages(workspaceSelectedConversation.id)
      ]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, message.pin ? "取消常驻失败" : "设置常驻失败"));
    }
  }

  async function removeWorkspacePin(messageId: string) {
    if (!workspaceSelectedConversation) return;
    try {
      await workspaceJson(`/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/pins/${encodeURIComponent(messageId)}`, {
        method: "DELETE"
      });
      await Promise.all([
        refreshWorkspacePins(workspaceSelectedConversation.id),
        refreshWorkspaceConversationMessages(workspaceSelectedConversation.id)
      ]);
      showWorkspaceNotice("success", "已取消常驻");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "取消常驻失败"));
    }
  }

  async function recallWorkspaceMessage(message: Message) {
    if (!message.self || message.localState || message.recalledAt) return;
    if (!window.confirm("撤回这条消息？撤回后聊天中不再显示原内容。")) return;
    try {
      await workspaceJson<{ message: WorkspaceMessage }>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/recall`,
        { method: "POST" }
      );
      if (workspaceSelectedConversation) {
        await Promise.all([
          refreshWorkspaceConversationMessages(workspaceSelectedConversation.id),
          refreshWorkspacePins(workspaceSelectedConversation.id),
          refreshWorkspaceConversations()
        ]);
        if (workspaceReplyToMessageIdByConversation[workspaceSelectedConversation.id] === message.id) {
          setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, "");
        }
      }
      showWorkspaceNotice("success", "消息已撤回");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "撤回消息失败"));
    }
  }

  async function openWorkspacePinnedMessage(messageId: string) {
    if (!workspaceSelectedConversation) return;
    const conversationId = workspaceSelectedConversation.id;
    workspaceStickToBottomRef.current = false;
    workspaceStickToBottomByConversationRef.current.set(conversationId, false);
    const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?around=${encodeURIComponent(messageId)}&limit=41`
    );
    if (workspaceSelectedConversationIdRef.current !== conversationId) return;
    setWorkspaceHistoryExhaustedByConversation((current) => {
      if (!(conversationId in current)) return current;
      const { [conversationId]: _removed, ...rest } = current;
      return rest;
    });
    setWorkspaceHistoryTargetId(messageId);
    setWorkspaceConversations((conversations) => conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, latestMessages: data.messages }
      : conversation));
    setWorkspaceContextCollapsed(true);
    setWorkspaceMobilePane("main");
  }

  async function returnWorkspaceToLatest() {
    if (!workspaceSelectedConversation) return;
    const conversationId = workspaceSelectedConversation.id;
    setWorkspaceReturningToLatestConversationId(conversationId);
    try {
      await refreshWorkspaceConversationMessages(conversationId);
      if (workspaceSelectedConversationIdRef.current !== conversationId) {
        setWorkspaceReturningToLatestConversationId((current) => current === conversationId ? "" : current);
        return;
      }
      workspacePreserveScrollRef.current = false;
      workspaceStickToBottomRef.current = true;
      workspaceStickToBottomByConversationRef.current.set(conversationId, true);
      workspaceScrollPositionsRef.current.delete(conversationId);
      setWorkspaceHistoryTargetId("");
      setWorkspaceAwayFromLatestByConversation((current) => {
        if (!current[conversationId]) return current;
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      });
      setWorkspaceScrollToLatestRequest((request) => request + 1);
    } catch (error) {
      setWorkspaceReturningToLatestConversationId((current) => current === conversationId ? "" : current);
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "返回最新消息失败"));
    }
  }

  function normalizeWorkspaceRealtimeEvents(events: WorkspaceEvent[]) {
    return [...events]
      .filter((event) => event.id && !workspaceSeenEventIdsRef.current.has(event.id))
      .sort((left, right) => left.seq - right.seq);
  }

  function rememberWorkspaceRealtimeEvents(events: WorkspaceEvent[]) {
    for (const event of events) {
      workspaceSeenEventIdsRef.current.add(event.id);
      workspaceRealtimeSeqRef.current = Math.max(workspaceRealtimeSeqRef.current, event.seq);
    }
  }

  async function syncWorkspaceRealtimeState(currentSeqValue?: number) {
    setWorkspaceRealtimeState("syncing");
    try {
      const [bootstrap] = await Promise.all([refreshWorkspaceBootstrap(), refreshWorkspaceConversations(), refreshWorkspaceFiles()]);
      const nextCursor = Number.isFinite(currentSeqValue) ? Number(currentSeqValue) : Number(bootstrap.eventCursor);
      if (Number.isFinite(nextCursor)) {
        workspaceRealtimeSeqRef.current = Math.max(0, nextCursor);
      }
      setWorkspaceRealtimeState("connected");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "同步共享空间失败"));
      setWorkspaceRealtimeState("error");
    }
  }

  async function projectWorkspaceEvents(events: WorkspaceEvent[]) {
    const tasks: Promise<unknown>[] = [];
    let needsMembers = false;
    let needsConversations = false;
    let needsFiles = false;
    let needsBootstrap = false;

    for (const event of events) {
      const payload = getWorkspaceEventPayload(event);
      if (event.type === "workspace.member_joined" || event.type === "workspace.member_updated") {
        if (payload.member) {
          upsertWorkspaceMember(payload.member);
          if (event.type === "workspace.member_updated" && payload.userId === workspaceCurrentUserIdRef.current) {
            needsBootstrap = true;
          }
        } else {
          needsMembers = true;
          if (event.type === "workspace.member_updated" && payload.userId === workspaceCurrentUserIdRef.current) {
            needsBootstrap = true;
          }
        }
        continue;
      }

      if (event.type === "workspace.member_visibility_updated") {
        const viewerUserId = payload.userId || event.targetId || "";
        if (viewerUserId === workspaceCurrentUserIdRef.current) {
          needsMembers = true;
          needsBootstrap = true;
        }
        if (
          workspaceBootstrap?.permissions.canManageMemberVisibility &&
          viewerUserId &&
          viewerUserId === workspaceVisibilityViewerId
        ) {
          tasks.push(loadWorkspaceMemberVisibility(viewerUserId));
        }
        continue;
      }

      if (event.type === "workspace.member_removed") {
        if (payload.userId) {
          removeWorkspaceMemberFromClient(payload.userId);
        } else {
          needsMembers = true;
          needsConversations = true;
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "conversation.created" || event.type === "conversation.updated") {
        if (payload.conversation) {
          upsertWorkspaceConversation(payload.conversation);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.notification_updated") {
        if (payload.conversation) {
          upsertWorkspaceConversation(payload.conversation);
        } else if (payload.conversationId && payload.notificationLevel) {
          setWorkspaceConversations((conversations) =>
            sortWorkspaceConversations(
              conversations.map((conversation) =>
                conversation.id === payload.conversationId
                  ? { ...conversation, notificationLevel: payload.notificationLevel }
                  : conversation
              )
            )
          );
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.member_added") {
        if (payload.conversationId && payload.member) {
          upsertWorkspaceConversationMember(payload.conversationId, payload.member);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.member_removed") {
        if (payload.conversationId && payload.userId) {
          removeWorkspaceConversationMember(payload.conversationId, payload.userId);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "message.created" || event.type === "message.recalled") {
        if (payload.message) {
          upsertWorkspaceMessage(payload.message, payload.conversation);
        } else if (payload.conversationId && payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        } else {
          needsConversations = true;
        }
        if (event.type === "message.recalled" && payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspacePins(payload.conversationId));
        }
        continue;
      }

      if (event.type === "reaction.added" || event.type === "reaction.removed") {
        if (payload.messageId && payload.reactions) {
          updateWorkspaceMessageReactions(payload.messageId, payload.reactions, event.seq);
        } else if (payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        }
        continue;
      }

      if (event.type === "message.pinned" || event.type === "message.unpinned") {
        if (payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspacePins(payload.conversationId));
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        }
        continue;
      }

      if (event.type === "attachment.created" || event.type === "attachment.available" || event.type === "attachment.failed") {
        if (payload.attachment) {
          upsertWorkspaceFile(payload.attachment);
        } else {
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "attachment.removed") {
        if (payload.attachmentId) {
          removeWorkspaceFileFromClient(payload.attachmentId);
        } else {
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "transfer.rejected" && event.actorId === workspaceCurrentUserIdRef.current) {
        showWorkspaceNotice("warning", payload.direction === "download" ? "今日传输额度不足，无法下载此文件。" : "今日传输额度不足，无法上传此文件。");
        needsBootstrap = true;
        continue;
      }

      if (event.conversationId) {
        needsConversations = true;
      }
    }

    if (needsMembers) tasks.push(refreshWorkspaceMembers());
    if (needsConversations) tasks.push(refreshWorkspaceConversations());
    if (needsFiles) tasks.push(refreshWorkspaceFiles());
    if (needsBootstrap) tasks.push(refreshWorkspaceBootstrap());
    await Promise.all(tasks);
  }

  function getWorkspaceEventPayload(event: WorkspaceEvent): WorkspaceEventPayload {
    return (event.payload ?? {}) as WorkspaceEventPayload;
  }

  function upsertWorkspaceMember(member: WorkspaceUser) {
    setWorkspaceDirectoryMembers((members) => upsertById(members, member).sort(compareWorkspaceMembers));
    setWorkspaceBootstrap((current) =>
      current
        ? {
            ...current,
            auth: current.auth.currentUser.id === member.id
              ? { ...current.auth, currentUser: member }
              : current.auth,
            members: upsertById(current.members, member).sort(compareWorkspaceMembers)
          }
        : current
    );
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        displayTitle: conversation.type === "direct" && conversation.otherMember?.id === member.id
          ? member.displayName
          : conversation.displayTitle,
        otherMember: conversation.otherMember?.id === member.id ? member : conversation.otherMember,
        members: conversation.members.some((candidate) => candidate.id === member.id)
          ? upsertById(conversation.members, member).sort(compareWorkspaceMembers)
          : conversation.members,
        latestMessages: conversation.latestMessages.map((message) => ({
          ...message,
          authorName: message.authorId === member.id ? member.displayName : message.authorName,
          authorAvatarUrl: message.authorId === member.id ? member.avatarUrl : message.authorAvatarUrl,
          reactions: message.reactions.map((reaction) => ({
            ...reaction,
            users: reaction.users.map((user) => user.id === member.id
              ? { ...user, displayName: member.displayName, avatarUrl: member.avatarUrl }
              : user)
          }))
        }))
      }))
    );
    const updateUploader = (file: WorkspaceFile) => file.uploaderId === member.id
      ? { ...file, uploaderName: member.displayName, uploader: { ...file.uploader, id: member.id, displayName: member.displayName } }
      : file;
    setWorkspaceFiles((files) => files.map(updateUploader));
    setWorkspaceLibraryFiles((files) => files.map(updateUploader));
  }

  function openWorkspaceMemberDetails(member: WorkspaceUser) {
    setWorkspaceSelectedMemberId(member.id);
    setWorkspaceView("members");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "members", memberId: member.id }));
    setWorkspaceContextMode("member");
    setWorkspaceContextCollapsed(false);
    setWorkspaceMobilePane("details");
  }

  function removeWorkspaceMemberFromClient(userId: string) {
    setWorkspaceDirectoryMembers((members) => members.filter((member) => member.id !== userId));
    setWorkspaceBootstrap((current) =>
      current
        ? {
            ...current,
            members: current.members.filter((member) => member.id !== userId)
          }
        : current
    );
    setWorkspaceConversations((conversations) =>
      sortWorkspaceConversations(
        conversations
          .map((conversation) => ({
            ...conversation,
            members: conversation.members.filter((member) => member.id !== userId)
          }))
          .filter((conversation) => conversation.members.length > 0)
      )
    );
    setWorkspaceFiles((files) => files.filter((file) => file.uploaderId !== userId));
    setWorkspaceLibraryFiles((files) => files.filter((file) => file.uploaderId !== userId));
  }

  function upsertWorkspaceConversation(conversation: WorkspaceConversation) {
    setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, conversation));
  }

  function upsertWorkspaceConversationMember(conversationId: string, member: WorkspaceUser) {
    setWorkspaceConversations((conversations) =>
      sortWorkspaceConversations(
        conversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                members: upsertById(conversation.members, member).sort(compareWorkspaceMembers)
              }
            : conversation
        )
      )
    );
  }

  function removeWorkspaceConversationMember(conversationId: string, userId: string) {
    const currentUserId = workspaceCurrentUserIdRef.current;
    const removedCurrentUser = userId === currentUserId;
    setWorkspaceConversations((conversations) =>
      sortWorkspaceConversations(
        conversations
          .map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  members: conversation.members.filter((member) => member.id !== userId)
                }
              : conversation
          )
          .filter((conversation) => conversation.id !== conversationId || !removedCurrentUser)
      )
    );
    if (removedCurrentUser) {
      setWorkspaceDraftByConversation((drafts) => {
        const { [conversationId]: _removed, ...rest } = drafts;
        return rest;
      });
      setWorkspaceReplyToMessageIdByConversation((replyTargets) => {
        const { [conversationId]: _removed, ...rest } = replyTargets;
        return rest;
      });
      setWorkspaceLocalMessages((messages) => messages.filter((message) => message.conversationId !== conversationId));
      setWorkspaceFiles((files) => files.filter((file) => file.conversationId !== conversationId));
      setWorkspaceLibraryFiles((files) => files.filter((file) => file.conversationId !== conversationId));
      if (workspaceSelectedFile?.conversationId === conversationId) {
        setWorkspaceSelectedFileId("");
        setWorkspaceContextMode("conversation");
      }
    }
    if (workspaceSelectedConversationIdRef.current === conversationId && removedCurrentUser) {
      setWorkspaceSelectedConversationId("");
      setWorkspaceContextMode("conversation");
      setWorkspaceContextTab("overview");
      setWorkspaceMobilePane("list");
      showWorkspaceNotice("warning", "你已不在此群聊中。");
    }
  }

  function upsertWorkspaceMessage(message: WorkspaceMessage, conversation?: WorkspaceConversation | null) {
    if (message.clientMessageId) {
      setWorkspaceLocalMessages((messages) =>
        messages.filter((item) => item.clientMessageId !== message.clientMessageId)
      );
    }
    if (
      message.conversationId === workspaceSelectedConversationIdRef.current &&
      message.authorId !== workspaceCurrentUserIdRef.current &&
      !workspaceStickToBottomRef.current
    ) {
      setWorkspaceNewMessageCountByConversation((counts) => ({
        ...counts,
        [message.conversationId]: (counts[message.conversationId] ?? 0) + 1
      }));
    }
    setWorkspaceConversations((conversations) => {
      const next = conversations.map((item) => {
        if (item.id !== message.conversationId) {
          return conversation && item.id === conversation.id ? mergeWorkspaceConversation(item, conversation) : item;
        }
        const base = conversation ? mergeWorkspaceConversation(item, conversation) : { ...item };
        const existingMessages = base.latestMessages ?? [];
        const hasMessage = existingMessages.some((candidate) => candidate.id === message.id);
        return {
          ...base,
          latestMessages: upsertWorkspaceMessageList(existingMessages, message),
          messageCount: conversation ? base.messageCount : Math.max(base.messageCount ?? 0, item.messageCount ?? 0) + (hasMessage ? 0 : 1),
          lastActivityAt: conversation?.lastActivityAt ?? message.createdAt
        };
      });
      return sortWorkspaceConversations(conversation && !next.some((item) => item.id === conversation.id) ? [conversation, ...next] : next);
    });
  }


  function updateWorkspaceMessageReactions(
    messageId: string,
    reactions: WorkspaceReactionGroup[],
    eventSeq?: number
  ) {
    if (eventSeq !== undefined) {
      const latestEventSeq = workspaceReactionEventSeqRef.current.get(messageId) ?? 0;
      if (eventSeq < latestEventSeq) {
        return;
      }
      workspaceReactionEventSeqRef.current.set(messageId, eventSeq);
    }
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        latestMessages: conversation.latestMessages.map((message) =>
          message.id === messageId ? { ...message, reactions } : message
        )
      }))
    );
  }

  async function toggleWorkspaceReaction(messageId: string, emoteKey: string) {
    const lockKey = `${messageId}::${emoteKey}`;
    if (workspaceReactionLocksRef.current.has(lockKey) || !workspaceBootstrap) {
      return;
    }
    const message = workspaceConversations
      .flatMap((conversation) => conversation.latestMessages)
      .find((candidate) => candidate.id === messageId);
    if (!message) {
      return;
    }

    const originalReactions = message.reactions ?? [];
    const reacted = originalReactions.some(
      (group) => group.emoteKey === emoteKey && group.reactedByCurrentUser
    );
    const currentUser = workspaceBootstrap.auth.currentUser;
    const eventSeqAtRequest = workspaceReactionEventSeqRef.current.get(messageId) ?? 0;
    const optimisticReactions = applyWorkspaceReactionOptimistic(originalReactions, emoteKey, {
      id: currentUser.id,
      displayName: currentUser.displayName,
      githubLogin: currentUser.githubLogin,
      avatarUrl: currentUser.avatarUrl,
      createdAt: new Date().toISOString()
    });

    workspaceReactionLocksRef.current.add(lockKey);
    setWorkspaceReactionPendingKeys((keys) => [...keys, lockKey]);
    updateWorkspaceMessageReactions(messageId, optimisticReactions);

    try {
      const response = await workspaceJson<{
        messageId: string;
        reactions: WorkspaceReactionGroup[];
      }>(
        reacted
          ? `/api/workspace/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoteKey)}`
          : `/api/workspace/messages/${encodeURIComponent(messageId)}/reactions`,
        reacted
          ? { method: "DELETE" }
          : { method: "POST", body: JSON.stringify({ emoteKey }) }
      );
      if (shouldApplyWorkspaceReactionResponse(
        workspaceReactionEventSeqRef.current.get(messageId) ?? 0,
        eventSeqAtRequest
      )) {
        updateWorkspaceMessageReactions(response.messageId, response.reactions);
      }
    } catch (error) {
      if (shouldApplyWorkspaceReactionResponse(
        workspaceReactionEventSeqRef.current.get(messageId) ?? 0,
        eventSeqAtRequest
      )) {
        updateWorkspaceMessageReactions(messageId, originalReactions);
      }
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "表情回复更新失败"));
    } finally {
      workspaceReactionLocksRef.current.delete(lockKey);
      setWorkspaceReactionPendingKeys((keys) => keys.filter((key) => key !== lockKey));
    }
  }

  async function favoriteWorkspaceMessageEmote(message: Message) {
    const source = getWorkspaceEmoteFavoriteSource(message);
    if (!source) return;
    try {
      await workspaceJson<{ emote: WorkspaceCustomEmote }>("/api/workspace/me/emotes/favorite", {
        method: "POST",
        body: JSON.stringify({ messageId: message.id, ...source })
      });
      showWorkspaceNotice("success", "已加入收藏表情");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "收藏表情失败"));
    }
  }
  function upsertWorkspaceFile(file: WorkspaceFile | WorkspaceAttachment) {
    if (!("uploaderId" in file) || !file.uploaderId || !("createdAt" in file) || !file.createdAt) {
      return;
    }
    const workspaceFile = file as WorkspaceFile;
    if (workspaceFile.status === "available") {
      setWorkspaceSelectedFileId((selectedId) => selectedId.startsWith("local-file-") ? workspaceFile.id : selectedId);
    }
    const mergeFile = (files: WorkspaceFile[]) =>
      sortWorkspaceFiles(
        upsertById(
          files.filter(
            (candidate) =>
              !candidate.localUpload ||
              candidate.fileName !== workspaceFile.fileName ||
              candidate.byteSize !== workspaceFile.byteSize ||
              candidate.conversationId !== workspaceFile.conversationId
          ),
          workspaceFile
        )
      );
    setWorkspaceFiles(mergeFile);
    setWorkspaceLibraryFiles(mergeFile);
  }

  function openWorkspaceAttachmentFile(attachment: WorkspaceAttachment) {
    const existingFile = workspaceFiles.find((file) => file.id === attachment.id);
    if (!existingFile) {
      const projectedFile: WorkspaceFile = {
        ...attachment,
        uploaderId: "",
        uploaderName: "成员",
        createdAt: new Date().toISOString(),
        conversationId: workspaceSelectedConversationId || null,
        visibility: attachment.visibility || "conversation"
      };
      const upsertProjected = (files: WorkspaceFile[]) => sortWorkspaceFiles(upsertById(files, projectedFile));
      setWorkspaceFiles(upsertProjected);
      setWorkspaceLibraryFiles(upsertProjected);
      void refreshWorkspaceFiles();
    }
    setWorkspaceSelectedFileId(attachment.id);
    setWorkspaceView("files");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: attachment.id }));
    setWorkspaceContextMode("file");
    setWorkspaceContextCollapsed(false);
    setWorkspaceMobilePane("details");
  }

  function removeWorkspaceFileFromClient(attachmentId: string) {
    setWorkspaceFiles((files) => files.filter((file) => file.id !== attachmentId));
    setWorkspaceLibraryFiles((files) => files.filter((file) => file.id !== attachmentId));
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        latestMessages: conversation.latestMessages.map((message) => ({
          ...message,
          attachments: message.attachments.map((attachment) =>
            attachment.id === attachmentId ? { ...attachment, status: "removed" } : attachment
          )
        }))
      }))
    );
  }

  async function markWorkspaceConversationRead(conversationId: string) {
    if (workspaceMarkReadInFlightRef.current.has(conversationId)) {
      return;
    }
    workspaceMarkReadInFlightRef.current.add(conversationId);
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/conversations/${encodeURIComponent(conversationId)}/read`,
        { method: "POST" }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
    } catch {
      // Read state is progressive UI; message access itself is handled by normal fetches.
    } finally {
      workspaceMarkReadInFlightRef.current.delete(conversationId);
    }
  }

  function handleWorkspaceMessageListScroll(list: HTMLDivElement) {
    const conversationId = workspaceSelectedConversationId;
    if (!conversationId) {
      return;
    }
    if (workspaceHistoryTargetId) {
      workspaceStickToBottomRef.current = false;
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
    setWorkspaceAwayFromLatestByConversation((current) => {
      if (!nearBottom && current[conversationId] !== true) {
        return { ...current, [conversationId]: true };
      }
      if (nearBottom && current[conversationId]) {
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      }
      return current;
    });
    const hasScrollIntent = performance.now() <= workspaceScrollIntentUntilRef.current;
    if (nearBottom) {
      if (workspaceStickToBottomRef.current || hasScrollIntent) {
        workspaceStickToBottomRef.current = true;
      }
    } else if (hasScrollIntent) {
      workspaceStickToBottomRef.current = false;
    }
    workspaceScrollPositionsRef.current.set(conversationId, list.scrollTop);
    workspaceStickToBottomByConversationRef.current.set(
      conversationId,
      workspaceStickToBottomRef.current
    );
    if (!nearBottom) {
      return;
    }
    setWorkspaceNewMessageCountByConversation((counts) => {
      if (!counts[conversationId]) {
        return counts;
      }
      return { ...counts, [conversationId]: 0 };
    });
    const mobileConversationHidden = window.matchMedia("(max-width: 760px)").matches && workspaceMobilePane !== "main";
    if (
      lane === "workspace-dev" &&
      workspaceStatus === "ready" &&
      workspaceRealtimeState === "connected" &&
      workspaceView === "chat" &&
      documentVisible &&
      !mobileConversationHidden &&
      ((workspaceSelectedConversation?.unreadCount ?? 0) > 0 || workspaceNewMessageCount > 0)
    ) {
      void markWorkspaceConversationRead(conversationId);
    }
  }

  function registerWorkspaceMessageListScrollIntent() {
    workspaceScrollIntentUntilRef.current = performance.now() + 3000;
  }

  function jumpWorkspaceToLatest() {
    const list = workspaceMessageListRef.current;
    const conversationId = workspaceSelectedConversationId;
    if (!list || !conversationId) {
      return;
    }
    workspaceStickToBottomRef.current = true;
    workspaceStickToBottomByConversationRef.current.set(conversationId, true);
    list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    handleWorkspaceMessageListScroll(list);
  }

  async function updateWorkspaceConversationNotification(level: WorkspaceNotificationLevel) {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.notificationLevel === level) {
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/conversations/${encodeURIComponent(workspaceSelectedConversation.id)}/notification`,
        {
          method: "PATCH",
          body: JSON.stringify({ level })
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", "会话提醒已更新");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "提醒设置保存失败"));
    }
  }

  async function loadOlderWorkspaceMessages(conversationId: string) {
    const conversation = workspaceConversations.find((item) => item.id === conversationId);
    const before = conversation?.latestMessages[0]?.id;
    if (!conversation || !before || workspaceHistoryLoadingByConversation[conversationId]) {
      return;
    }
    setWorkspaceHistoryLoadingByConversation((current) => ({ ...current, [conversationId]: true }));
    clearWorkspaceNotice();
    try {
      const params = new URLSearchParams({ before, limit: "40" });
      const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
        `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
      );
      if (data.messages.length === 0) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
        return;
      }
      const knownMessageIds = new Set(conversation.latestMessages.map((message) => message.id));
      const olderMessages = data.messages.filter((message) => !knownMessageIds.has(message.id));
      if (olderMessages.length === 0) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
        return;
      }
      workspacePreviousScrollHeightRef.current = workspaceMessageListRef.current?.scrollHeight ?? 0;
      workspacePreserveScrollRef.current = true;
      setWorkspaceConversations((conversations) =>
        conversations.map((item) => {
          if (item.id !== conversationId) {
            return item;
          }
          const existingIds = new Set(item.latestMessages.map((message) => message.id));
          return {
            ...item,
            latestMessages: [
              ...olderMessages.filter((message) => !existingIds.has(message.id)),
              ...item.latestMessages
            ]
          };
        })
      );
      if (data.messages.length < 40) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
      }
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "历史消息加载失败"));
    } finally {
      setWorkspaceHistoryLoadingByConversation((current) => ({ ...current, [conversationId]: false }));
    }
  }

  function clearWorkspaceNotice() {
    setWorkspaceNotice(null);
  }

  function showWorkspaceNotice(tone: WorkspaceNotice["tone"], text: string, options: WorkspaceNoticeOptions = {}) {
    workspaceNoticeSeqRef.current += 1;
    setWorkspaceNotice({
      id: workspaceNoticeSeqRef.current,
      tone,
      text,
      persistent: options.persistent === true,
      durationMs: options.durationMs ?? WORKSPACE_NOTICE_AUTO_DISMISS_MS
    });
  }

  function openWorkspaceCreate(mode: WorkspaceCreateMode) {
    setWorkspaceCreateMode(mode);
    writeAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "new",
      createMode: mode
    }));
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);
    clearWorkspaceNotice();
    setWorkspacePickerMemberQuery("");
    setWorkspaceMobilePane("main");
    if (mode === "group") {
      setWorkspaceGroupMemberIds([]);
      setWorkspaceNewGroupAvatarEmoji("");
    }
  }

  function closeWorkspaceCreate() {
    setWorkspaceCreateMode("");
    setWorkspaceMobilePane("list");
    writeAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      conversationId: workspaceSelectedConversationId
    }));
    window.requestAnimationFrame(() => workspaceCreateTriggerRef.current?.focus());
  }

  function handleWorkspaceCreatePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspaceCreate();
    }
  }

  function toggleWorkspaceGroupMember(userId: string) {
    setWorkspaceGroupMemberIds((selected) =>
      selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId]
    );
  }

  async function loadWorkspaceMemberVisibility(viewerUserId: string) {
    if (!workspaceBootstrap?.permissions.canManageMemberVisibility || !viewerUserId) {
      return;
    }
    setWorkspaceVisibilityLoading(true);
    try {
      const data = await workspaceJson<{ visibility: WorkspaceMemberVisibility }>(
        "/api/workspace/member-visibility/" + encodeURIComponent(viewerUserId)
      );
      setWorkspaceMemberVisibility(data.visibility);
    } catch (error) {
      setWorkspaceMemberVisibility(null);
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员可见范围加载失败"));
    } finally {
      setWorkspaceVisibilityLoading(false);
    }
  }

  function toggleWorkspaceVisibilityGrant(userId: string) {
    setWorkspaceMemberVisibility((current) => {
      if (!current || current.automaticUserIds.includes(userId)) {
        return current;
      }
      const grantedUserIds = current.grantedUserIds.includes(userId)
        ? current.grantedUserIds.filter((id) => id !== userId)
        : [...current.grantedUserIds, userId];
      return {
        ...current,
        grantedUserIds,
        visibleUserIds: Array.from(new Set([current.viewerUserId, ...current.automaticUserIds, ...grantedUserIds]))
      };
    });
  }

  async function saveWorkspaceMemberVisibility() {
    if (
      !workspaceBootstrap?.permissions.canManageMemberVisibility ||
      !workspaceVisibilityViewerId ||
      !workspaceMemberVisibility
    ) {
      return;
    }
    setWorkspaceVisibilitySaving(true);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ visibility: WorkspaceMemberVisibility }>(
        "/api/workspace/member-visibility/" + encodeURIComponent(workspaceVisibilityViewerId),
        {
          method: "PUT",
          body: JSON.stringify({ visibleUserIds: workspaceMemberVisibility.grantedUserIds })
        }
      );
      setWorkspaceMemberVisibility(data.visibility);
      showWorkspaceNotice("success", "成员可见范围已更新");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员可见范围更新失败"));
    } finally {
      setWorkspaceVisibilitySaving(false);
    }
  }

  async function updateWorkspaceMemberRole(member: WorkspaceUser, role: WorkspaceUser["role"]) {
    if (!workspaceBootstrap?.permissions.canCreatePrivilegedInvite || member.role === role) {
      return;
    }
    const currentRoleLabel = workspaceMemberRoleLabel(member);
    const nextRoleLabel = workspaceRoleLabel(role);
    const confirmation =
      role === "owner"
        ? `将 ${member.displayName} 设为空间主人？此成员将获得完整空间权限。`
        : member.role === "owner"
          ? `将 ${member.displayName} 从空间主人调整为${nextRoleLabel}？`
          : `将 ${member.displayName} 从${currentRoleLabel}调整为${nextRoleLabel}？`;
    if (!window.confirm(confirmation)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ member: WorkspaceUser }>(
        `/api/workspace/members/${encodeURIComponent(member.id)}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({ role })
        }
      );
      upsertWorkspaceMember(data.member);
      showWorkspaceNotice("success", "成员权限已更新");
      await refreshWorkspaceBootstrap();
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员权限更新失败"));
    }
  }

  async function removeWorkspaceMember(member: WorkspaceUser) {
    if (!workspaceBootstrap?.permissions.canCreatePrivilegedInvite || member.id === workspaceBootstrap.auth.currentUser.id) {
      return;
    }
    if (!window.confirm(`将 ${member.displayName} 移出共享空间？该成员将无法继续访问会话和文件。`)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; userId: string; removedAt: string }>(
        `/api/workspace/members/${encodeURIComponent(member.id)}`,
        { method: "DELETE" }
      );
      removeWorkspaceMemberFromClient(member.id);
      showWorkspaceNotice("success", "成员已移出共享空间");
      await Promise.all([refreshWorkspaceBootstrap(), refreshWorkspaceMembers(), refreshWorkspaceConversations(), refreshWorkspaceFiles()]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移出成员失败"));
    }
  }

  async function createWorkspaceDirect(targetUserId: string) {
    if (!workspaceBootstrap?.permissions.canCreateDirect) {
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>("/api/workspace/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "direct",
          targetUserId
        })
      });
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      setWorkspaceCreateMode("");
      selectWorkspaceConversation(data.conversation.id);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "发起私聊失败"));
    }
  }

  async function createWorkspaceGroup(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!workspaceBootstrap?.permissions.canCreateGroup) {
      return;
    }
    const title = workspaceNewGroupTitle.trim();
    if (!title) {
      showWorkspaceNotice("warning", "请输入群聊名称");
      return;
    }
    if (workspaceGroupMemberIds.length === 0) {
      showWorkspaceNotice("warning", "请选择至少一位群聊成员");
      return;
    }
    const avatarEmoji = normalizeWorkspaceGroupAvatarEmoji(workspaceNewGroupAvatarEmoji);
    if (avatarEmoji === null) {
      showWorkspaceNotice("warning", "群头像必须是单个 emoji");
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>("/api/workspace/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "group",
          title,
          avatarEmoji: avatarEmoji || null,
          memberIds: workspaceGroupMemberIds
        })
      });
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      setWorkspaceNewGroupTitle("");
      setWorkspaceNewGroupAvatarEmoji("");
      setWorkspaceGroupMemberIds([]);
      setWorkspaceCreateMode("");
      selectWorkspaceConversation(data.conversation.id);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "创建会话失败"));
    }
  }

  async function addWorkspaceGroupMember(userId: string) {
    if (!workspaceSelectedConversation || !workspaceBootstrap || !workspaceCanManageSelectedGroup) {
      return;
    }
    const member = workspaceBootstrap.members.find((item) => item.id === userId);
    setWorkspaceGroupMemberBusyId(userId);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/members`,
        {
          method: "POST",
          body: JSON.stringify({ userId })
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", `${member?.displayName ?? "成员"} 已加入群聊`);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "添加成员失败"));
    } finally {
      setWorkspaceGroupMemberBusyId("");
    }
  }

  async function removeWorkspaceGroupMember(userId: string) {
    if (!workspaceSelectedConversation || !workspaceBootstrap || !workspaceCanManageSelectedGroup) {
      return;
    }
    const member = workspaceSelectedConversation.members.find((item) => item.id === userId);
    const title = workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id);
    if (!window.confirm(`将 ${member?.displayName ?? "该成员"} 移出「${title}」？对方将无法继续查看此群聊和群文件。`)) {
      return;
    }
    setWorkspaceGroupMemberBusyId(userId);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/members/${encodeURIComponent(userId)}`,
        {
          method: "DELETE"
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", `${member?.displayName ?? "成员"} 已移出群聊`);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移出成员失败"));
    } finally {
      setWorkspaceGroupMemberBusyId("");
    }
  }

  async function renameWorkspaceGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceSelectedConversation || !workspaceCanManageSelectedGroup) {
      return;
    }
    const title = workspaceGroupRenameTitle.trim();
    if (!title) {
      showWorkspaceNotice("warning", "请输入群聊名称");
      return;
    }
    const avatarEmoji = normalizeWorkspaceGroupAvatarEmoji(workspaceGroupAvatarEmoji);
    if (avatarEmoji === null) {
      showWorkspaceNotice("warning", "群头像必须是单个 emoji");
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title, avatarEmoji: avatarEmoji || null })
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", "群聊名称已更新");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "群聊名称更新失败"));
    }
  }

  async function leaveWorkspaceGroup() {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.type !== "group") {
      return;
    }
    const title = workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap?.auth.currentUser.id);
    if (!window.confirm(`离开「${title}」后，你将无法继续查看此群聊。确定离开吗？`)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; conversationId: string }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/leave`,
        { method: "POST" }
      );
      setWorkspaceConversations((conversations) =>
        conversations.filter((conversation) => conversation.id !== workspaceSelectedConversation.id)
      );
      setWorkspaceSelectedConversationId("");
      setWorkspaceContextMode("conversation");
      setWorkspaceContextTab("overview");
      setWorkspaceMobilePane("list");
      showWorkspaceNotice("success", "已离开群聊");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "离开群聊失败"));
    }
  }

  async function createWorkspaceInvite() {
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ invite: WorkspaceInvite }>("/api/workspace/invites", {
        method: "POST",
        body: JSON.stringify({ defaultRole: "member", maxUses: 1 })
      });
      const invitePath = data.invite.inviteUrl || getWorkspaceEntryUrl(data.invite.code || "");
      setWorkspaceInviteCode(new URL(invitePath, window.location.origin).toString());
      setWorkspaceInviteCodeId(data.invite.id);
      await loadWorkspace();
      showWorkspaceNotice("success", "邀请已创建，可以复制发送给成员。");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "创建邀请失败"));
    }
  }

  async function copyWorkspaceInviteLink(value: string) {
    const didCopy = await copyText(value);
    showWorkspaceNotice(
      didCopy ? "success" : "warning",
      didCopy ? "邀请链接已复制。" : "复制失败，请手动选择邀请链接。"
    );
  }

  async function revokeWorkspaceInvite(invite: WorkspaceInvite) {
    if (!canRevokeWorkspaceInvite(invite)) {
      return;
    }
    if (!window.confirm("撤销后，这个邀请链接将无法继续加入共享空间。确定撤销吗？")) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ invite: Pick<WorkspaceInvite, "id" | "revokedAt"> }>(
        `/api/workspace/invites/${encodeURIComponent(invite.id)}/revoke`,
        { method: "POST" }
      );
      if (workspaceInviteCodeId === invite.id) {
        setWorkspaceInviteCode("");
        setWorkspaceInviteCodeId("");
      }
      await refreshWorkspaceBootstrap();
      showWorkspaceNotice("success", "邀请已撤销");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "撤销邀请失败"));
    }
  }

  async function sendWorkspaceMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceSelectedConversation || workspaceSendingRef.current) {
      return;
    }
    const body = workspaceDraft;
    const hasBody = body.trim().length > 0;
    const hasStructuredBody = hasBody || workspaceDraftDocument.blocks.some(
      (block) => block.type === "mention" || block.type === "emote"
    );
    let stagedAttachments = workspaceComposerAttachmentsByConversation[workspaceSelectedConversationId] ?? [];
    const shouldConvertLongMessage = isWorkspaceTextOverAttachmentLimit(body);
    const staleGeneratedAttachments = stagedAttachments.filter(
      (attachment) => attachment.generatedFromLongMessage && (!shouldConvertLongMessage || attachment.generatedSource !== body)
    );
    if (staleGeneratedAttachments.length > 0) {
      await Promise.all(staleGeneratedAttachments.map((attachment) =>
        removeWorkspaceComposerAttachment(workspaceSelectedConversationId, attachment.id)
      ));
      const staleIds = new Set(staleGeneratedAttachments.map((attachment) => attachment.id));
      stagedAttachments = stagedAttachments.filter((attachment) => !staleIds.has(attachment.id));
    }
    if (shouldConvertLongMessage && !stagedAttachments.some(
      (attachment) => attachment.generatedFromLongMessage && attachment.generatedSource === body
    )) {
      if (stagedAttachments.length >= WORKSPACE_MAX_STAGED_ATTACHMENTS) {
        showWorkspaceNotice("warning", "长消息需要转换为 TXT，请先移除一个附件");
        return;
      }
      const generatedAttachment = createWorkspaceLongMessageAttachment(body);
      stagedAttachments = [...stagedAttachments, generatedAttachment];
      updateWorkspaceComposerAttachments(workspaceSelectedConversationId, () => stagedAttachments);
    }
    if ((!hasStructuredBody && stagedAttachments.length === 0)) {
      return;
    }
    const conversation = workspaceSelectedConversation;
    workspaceSendingRef.current = true;
    setWorkspaceSending(true);
    clearWorkspaceNotice();
    try {
      const uploadedAttachments = stagedAttachments.length > 0
        ? await uploadWorkspaceComposerAttachments(conversation.id, stagedAttachments)
        : [];
      if (uploadedAttachments.length !== stagedAttachments.length) {
        showWorkspaceNotice("warning", "部分文件上传失败，请重试或移除后再发送");
        return;
      }
      const clientMessageId = makeId("wm");
      const replyToMessageId = workspaceReplyToMessageId || null;
      const localMessageId = makeId("wlm");
      const textBlocks = !shouldConvertLongMessage && hasStructuredBody
        ? workspaceComposerDocumentToContentBlocks(workspaceDraftDocument)
        : [];
      const blocks: WorkspaceContentBlock[] = [
        ...textBlocks,
        ...uploadedAttachments.map((attachment) => ({
          type: "attachment" as const,
          attachmentId: attachment.id
        }))
      ];
      const generatedAttachmentIndex = stagedAttachments.findIndex(
        (attachment) => attachment.generatedFromLongMessage && attachment.generatedSource === body
      );
      const messageBody = shouldConvertLongMessage
        ? `[长消息] ${uploadedAttachments[generatedAttachmentIndex]?.fileName ?? "长消息.txt"}`
        : hasBody ? body : `[文件] ${uploadedAttachments.map((attachment) => attachment.fileName).join("、")}`;
      setWorkspaceLocalMessages((messages) => [
        ...messages.filter((message) => message.clientMessageId !== clientMessageId),
        {
          id: localMessageId,
          clientMessageId,
          conversationId: conversation.id,
          body: messageBody,
          blocks,
          attachments: uploadedAttachments,
          replyToMessageId,
          createdAt: new Date().toISOString(),
          state: "sending"
        }
      ]);
      await submitWorkspaceMessage({
        conversationId: conversation.id,
        clientMessageId,
        replyToMessageId,
        body: messageBody,
        blocks
      });
      setWorkspaceConversationDraft(conversation.id, "");
      setWorkspaceConversationReplyToMessageId(conversation.id, "");
      clearWorkspaceComposerAttachments(conversation.id);
    } catch (error) {
      const message = userFacingErrorMessage(error, "消息发送失败");
      setWorkspaceLocalMessages((messages) => {
        const sendingMessage = [...messages].reverse().find(
          (item) => item.conversationId === conversation.id && item.state === "sending"
        );
        return sendingMessage
          ? messages.map((item) =>
              item.id === sendingMessage.id ? { ...item, state: "failed", failureReason: message } : item
            )
          : messages;
      });
      showWorkspaceNotice("warning", message);
    } finally {
      workspaceSendingRef.current = false;
      setWorkspaceSending(false);
    }
  }

  function clearWorkspaceComposerAttachments(conversationId: string) {
    const attachments = workspaceComposerAttachmentsRef.current[conversationId] ?? [];
    for (const attachment of attachments) {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    updateWorkspaceComposerAttachments(conversationId, () => []);
  }

  async function uploadWorkspaceComposerAttachments(
    conversationId: string,
    stagedAttachments: WorkspaceComposerAttachment[]
  ) {
    const results = new Array<WorkspaceAttachment | null>(stagedAttachments.length).fill(null);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(2, stagedAttachments.length) },
      async () => {
        while (cursor < stagedAttachments.length) {
          const index = cursor;
          cursor += 1;
          try {
            results[index] = await uploadWorkspaceComposerAttachment(conversationId, stagedAttachments[index]);
          } catch {
            results[index] = null;
          }
        }
      }
    );
    await Promise.all(workers);
    if (results.every(Boolean)) {
      await refreshWorkspaceBootstrap();
    }
    return results.filter((attachment): attachment is WorkspaceAttachment => Boolean(attachment));
  }

  async function uploadWorkspaceComposerAttachment(
    conversationId: string,
    stagedAttachment: WorkspaceComposerAttachment
  ): Promise<WorkspaceAttachment> {
    if (stagedAttachment.state === "uploaded" && stagedAttachment.attachment) {
      return stagedAttachment.attachment;
    }
    const controller = new AbortController();
    workspaceUploadControllersRef.current.set(stagedAttachment.id, controller);
    updateWorkspaceComposerAttachments(conversationId, (attachments) =>
      attachments.map((attachment) =>
        attachment.id === stagedAttachment.id
          ? { ...attachment, state: "uploading", progress: 3, failureReason: undefined }
          : attachment
      )
    );
    let uploadId = "";
    try {
      const reserve = await workspaceJson<{
        status: "reserved";
        id: string;
        attachment?: WorkspaceAttachment;
        upload: WorkspaceUploadContract;
      }>("/api/workspace/files/uploads/reserve", {
        method: "POST",
        body: JSON.stringify({
          fileName: stagedAttachment.file.name,
          mimeType: stagedAttachment.file.type || "application/octet-stream",
          byteSize: stagedAttachment.file.size,
          visibility: "conversation",
          conversationId
        })
      });
      uploadId = reserve.id;
      updateWorkspaceComposerAttachments(conversationId, (attachments) =>
        attachments.map((attachment) =>
          attachment.id === stagedAttachment.id
            ? { ...attachment, uploadId, progress: 7 }
            : attachment
        )
      );
      const completed = await uploadWorkspaceFileContent(
        uploadId,
        stagedAttachment.file,
        (progress) => {
          updateWorkspaceComposerAttachments(conversationId, (attachments) =>
            attachments.map((attachment) =>
              attachment.id === stagedAttachment.id ? { ...attachment, progress } : attachment
            )
          );
        },
        controller.signal,
        reserve.upload
      );
      const uploaded = completed.attachment;
      updateWorkspaceComposerAttachments(conversationId, (attachments) =>
        attachments.map((attachment) =>
          attachment.id === stagedAttachment.id
            ? { ...attachment, state: "uploaded", progress: 100, attachment: uploaded, uploadId }
            : attachment
        )
      );
      if (workspaceBootstrap) {
        upsertWorkspaceFile({
          ...uploaded,
          uploaderId: workspaceBootstrap.auth.currentUser.id,
          uploaderName: workspaceBootstrap.auth.currentUser.displayName,
          conversationId,
          visibility: "conversation",
          createdAt: new Date().toISOString()
        });
      }
      return uploaded;
    } catch (error) {
      if (uploadId) {
        await releaseWorkspaceUploadReservation(
          uploadId,
          error instanceof DOMException && error.name === "AbortError"
            ? "upload cancelled"
            : error instanceof Error ? error.message : "upload failed"
        );
      }
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = userFacingErrorMessage(error, "文件上传失败");
        updateWorkspaceComposerAttachments(conversationId, (attachments) =>
          attachments.map((attachment) =>
            attachment.id === stagedAttachment.id
              ? { ...attachment, state: "failed", failureReason: message, progress: 0, uploadId: undefined }
              : attachment
          )
        );
      }
      throw error;
    } finally {
      workspaceUploadControllersRef.current.delete(stagedAttachment.id);
    }
  }

  async function retryWorkspaceMessage(messageId: string) {
    const localMessage = workspaceLocalMessages.find((message) => message.id === messageId);
    if (!localMessage || localMessage.state === "sending") {
      return;
    }
    clearWorkspaceNotice();
    setWorkspaceLocalMessages((messages) =>
      messages.map((message) =>
        message.id === messageId ? { ...message, state: "sending", failureReason: undefined } : message
      )
    );
    try {
      await submitWorkspaceMessage(localMessage);
    } catch (error) {
      const message = userFacingErrorMessage(error, "消息发送失败");
      setWorkspaceLocalMessages((messages) =>
        messages.map((item) =>
          item.id === messageId ? { ...item, state: "failed", failureReason: message } : item
        )
      );
      showWorkspaceNotice("warning", message);
    }
  }

  async function submitWorkspaceMessage(input: {
    conversationId: string;
    clientMessageId: string;
    replyToMessageId?: string | null;
    body: string;
    blocks: WorkspaceContentBlock[];
  }) {
    const data = await workspaceJson<{ message: WorkspaceMessage }>("/api/workspace/messages", {
      method: "POST",
      body: JSON.stringify({
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        replyToMessageId: input.replyToMessageId || null,
        content: {
          format: "duallane.message+json;v=1",
          plainText: input.body,
          blocks: input.blocks
        }
      })
    });
    upsertWorkspaceMessage(data.message);
  }

  async function uploadWorkspaceFile(file: File, scope: "current" | "space" = "current") {
    if (!workspaceBootstrap?.permissions.canUpload) {
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.size, "upload", workspaceBootstrap.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    const targetConversation = scope === "current" ? workspaceSelectedConversation : undefined;
    const localFileId = makeId("local-file");
    const localFile: WorkspaceFile = {
      id: localFileId,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      byteSize: file.size,
      status: "pending",
      visibility: targetConversation ? "conversation" : "space",
      uploaderId: workspaceBootstrap.auth.currentUser.id,
      uploaderName: workspaceBootstrap.auth.currentUser.displayName,
      conversationId: targetConversation?.id ?? null,
      createdAt: new Date().toISOString(),
      localUpload: {
        file,
        scope,
        state: "uploading"
      }
    };
    setWorkspaceFiles((files) => sortWorkspaceFiles(upsertById(files, localFile)));
    setWorkspaceLibraryFiles((files) => sortWorkspaceFiles(upsertById(files, localFile)));
    setWorkspaceUploading(true);
    clearWorkspaceNotice();
    try {
      await submitWorkspaceFileUpload(localFileId, file, scope, targetConversation?.id);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      const message = userFacingErrorMessage(error, "文件上传失败");
      setWorkspaceFileLocalState(localFileId, "failed", message);
      showWorkspaceNotice("warning", message);
    } finally {
      setWorkspaceUploading(false);
    }
  }

  async function retryWorkspaceFileUpload(file: WorkspaceFile) {
    const localUpload = file.localUpload;
    if (!localUpload || localUpload.state === "uploading" || !workspaceBootstrap?.permissions.canUpload) {
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "upload", workspaceBootstrap.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    setWorkspaceFileLocalState(file.id, "uploading");
    clearWorkspaceNotice();
    try {
      await submitWorkspaceFileUpload(file.id, localUpload.file, localUpload.scope, file.conversationId || undefined);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      const message = userFacingErrorMessage(error, "文件上传失败");
      setWorkspaceFileLocalState(file.id, "failed", message);
      showWorkspaceNotice("warning", message);
    }
  }

  async function submitWorkspaceFileUpload(
    localFileId: string,
    file: File,
    scope: "current" | "space",
    conversationId?: string
  ) {
    let reservedUploadId = "";
    let uploadCompleted = false;
    try {
      const reserve = await workspaceJson<{
        status: "reserved";
        id: string;
        attachment?: WorkspaceAttachment;
        upload: WorkspaceUploadContract;
      } | {
        status: "rejected";
      }>("/api/workspace/files/uploads/reserve", {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size,
          visibility: conversationId ? "conversation" : "space",
          conversationId
        })
      });
      if (reserve.status === "rejected") {
        throw new Error("今日传输额度不足");
      }
      reservedUploadId = reserve.id;
      const completed = await uploadWorkspaceFileContent(
        reserve.id,
        file,
        () => {},
        new AbortController().signal,
        reserve.upload
      );
      uploadCompleted = true;
      const uploadedFile: WorkspaceFile = {
        ...completed.attachment,
        uploaderId: workspaceBootstrap?.auth.currentUser.id ?? "",
        uploaderName: workspaceBootstrap?.auth.currentUser.displayName ?? "我",
        createdAt: new Date().toISOString()
      };
      replaceWorkspaceLocalFile(localFileId, uploadedFile);
      if (scope === "current" && conversationId) {
        const clientMessageId = makeId("wf");
        const localMessageId = makeId("wlm");
        const body = `[文件] ${file.name}`;
        const blocks: WorkspaceContentBlock[] = [
          { type: "text", text: "分享了文件 " },
          { type: "attachment", attachmentId: completed.attachment.id }
        ];
        setWorkspaceLocalMessages((messages) => [
          ...messages.filter((message) => message.clientMessageId !== clientMessageId),
          {
            id: localMessageId,
            clientMessageId,
            conversationId,
            body,
            blocks,
            attachments: [completed.attachment],
            createdAt: new Date().toISOString(),
            state: "sending"
          }
        ]);
        try {
          await submitWorkspaceMessage({
            conversationId,
            clientMessageId,
            body,
            blocks
          });
        } catch (error) {
          const message = userFacingErrorMessage(error, "文件已上传，消息发送失败");
          setWorkspaceLocalMessages((messages) =>
            messages.map((item) =>
              item.clientMessageId === clientMessageId
                ? { ...item, state: "failed", failureReason: message }
                : item
            )
          );
          showWorkspaceNotice("warning", message);
          return;
        }
        try {
          const conversations = await workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations");
          setWorkspaceConversations((current) => mergeWorkspaceConversationList(current, conversations.conversations));
        } catch {
          // Realtime replay or the next bootstrap refresh will reconcile the conversation list.
        }
      }
    } catch (error) {
      if (reservedUploadId && !uploadCompleted) {
        await releaseWorkspaceUploadReservation(reservedUploadId, error instanceof Error ? error.message : "upload failed");
      }
      throw error;
    }
  }

  async function releaseWorkspaceUploadReservation(uploadId: string, reason: string) {
    try {
      await workspaceJson<{ transfer: { status: string } }>(
        `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/fail`,
        {
          method: "POST",
          body: JSON.stringify({ reason })
        }
      );
      await refreshWorkspaceBootstrap();
    } catch {
      // The server also releases quota when the content endpoint observed the failure.
    }
  }

  function setWorkspaceFileLocalState(fileId: string, state: "uploading" | "failed", failureReason?: string) {
    const update = (file: WorkspaceFile): WorkspaceFile =>
      file.id === fileId && file.localUpload
        ? {
            ...file,
            status: state === "failed" ? "failed" : "pending",
            localUpload: {
              ...file.localUpload,
              state,
              failureReason
            }
          }
        : file;
    setWorkspaceFiles((files) => files.map(update));
    setWorkspaceLibraryFiles((files) => files.map(update));
  }

  function replaceWorkspaceLocalFile(localFileId: string, uploadedFile: WorkspaceFile) {
    const replace = (files: WorkspaceFile[]) =>
      sortWorkspaceFiles([uploadedFile, ...files.filter((file) => file.id !== localFileId && file.id !== uploadedFile.id)]);
    setWorkspaceFiles(replace);
    setWorkspaceLibraryFiles(replace);
    setWorkspaceSelectedFileId((selectedId) => selectedId === localFileId ? uploadedFile.id : selectedId);
  }

  function removeWorkspaceLocalFile(file: WorkspaceFile) {
    if (!file.localUpload) {
      return;
    }
    setWorkspaceFiles((files) => files.filter((item) => item.id !== file.id));
    setWorkspaceLibraryFiles((files) => files.filter((item) => item.id !== file.id));
    setWorkspaceSelectedFileId((selectedId) => selectedId === file.id ? "" : selectedId);
    setWorkspaceContextMode("conversation");
    showWorkspaceNotice("success", "已移除本地上传记录");
  }

  async function reserveWorkspaceDownload(file: WorkspaceFile) {
    if (!workspaceBootstrap?.permissions.canDownload) {
      showWorkspaceNotice("warning", "你当前不能下载文件。");
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "download", workspaceBootstrap?.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    clearWorkspaceNotice();
    try {
      const reserve = await workspaceJson<
        { status: "completed"; id: string; downloadUrl?: string; expiresAt?: string } | { status: "rejected" }
      >(
        `/api/workspace/files/${encodeURIComponent(file.id)}/downloads/reserve`,
        { method: "POST", body: JSON.stringify({}) }
      );
      if (reserve.status === "rejected") {
        showWorkspaceNotice("warning", "今日传输额度不足，无法下载此文件。");
        await refreshWorkspaceBootstrap();
        return;
      }
      const params = new URLSearchParams({ downloadId: reserve.id });
      window.location.assign(`/api/workspace/files/${encodeURIComponent(file.id)}/download?${params.toString()}`);
      showWorkspaceNotice("success", `已开始下载 ${file.fileName}`);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "文件下载失败"));
    }
  }

  async function removeWorkspaceFile(file: WorkspaceFile) {
    if (!canRemoveWorkspaceFile(file, workspaceBootstrap?.auth.currentUser)) {
      return;
    }
    if (!window.confirm(`移除「${file.fileName}」？移除后成员将无法继续下载此文件。`)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; attachmentId: string }>(
        `/api/workspace/files/${encodeURIComponent(file.id)}`,
        { method: "DELETE" }
      );
      setWorkspaceFiles((files) => files.filter((item) => item.id !== file.id));
      setWorkspaceLibraryFiles((files) => files.filter((item) => item.id !== file.id));
      setWorkspaceSelectedFileId("");
      setWorkspaceContextMode("conversation");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files" }));
      showWorkspaceNotice("success", "文件已移除");
      await Promise.all([refreshWorkspaceFiles(), refreshWorkspaceConversations()]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移除文件失败"));
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
      self: true,
      localState: "sending" as const
    };
    setP2pMessages((messages) => [...messages, message]);
    setP2pDraft("");
    await transmitP2pChat(message);
  }

  async function retryP2pMessage(messageId: string) {
    const message = p2pMessages.find((item) => item.id === messageId && item.self && !item.fileTransfer);
    if (!message) {
      return;
    }
    updateP2pMessageDelivery(message.id, "sending");
    await transmitP2pChat({ ...message, localState: "sending", failureReason: undefined });
  }

  async function transmitP2pChat(message: Message) {
    clearP2pMessageAckTimer(message.id);
    const attempt = (pendingP2pMessageAttemptsRef.current.get(message.id) ?? 0) + 1;
    pendingP2pMessageAttemptsRef.current.set(message.id, attempt);
    if (dataChannelRef.current?.readyState !== "open" && p2pPeersRef.current.length < 2) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "对方尚未在线，消息未送达");
      return;
    }
    if (new TextEncoder().encode(message.body).byteLength > P2P_MAX_CHAT_BYTES) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", `消息超过 ${formatBytes(P2P_MAX_CHAT_BYTES)} 的直连上限`);
      return;
    }
    const sent = await sendP2pMessageEnvelope({
      kind: "chat",
      id: message.id,
      author: message.author,
      body: message.body,
      at: message.at
    });
    if (pendingP2pMessageAttemptsRef.current.get(message.id) !== attempt) {
      return;
    }
    if (!sent) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "当前没有可用连接，消息未送达");
      return;
    }
    const timer = window.setTimeout(() => {
      if (pendingP2pMessageAttemptsRef.current.get(message.id) !== attempt) {
        return;
      }
      pendingP2pMessageTimersRef.current.delete(message.id);
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "未收到对方确认，请检查连接后重试");
    }, P2P_MESSAGE_ACK_TIMEOUT_MS);
    pendingP2pMessageTimersRef.current.set(message.id, timer);
  }

  async function sendP2pMessageEnvelope(envelope: Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>) {
    const dataChannel = dataChannelRef.current;
    const socket = wsRef.current;
    const canUseEncryptedSocket = socket?.readyState === WebSocket.OPEN && Boolean(secureKeysRef.current);
    if (dataChannel?.readyState === "open" && (dataChannel.bufferedAmount < 512 * 1024 || !canUseEncryptedSocket)) {
      try {
        dataChannel.send(JSON.stringify(envelope));
        return true;
      } catch {
        // The encrypted WebSocket path below can still carry text acknowledgements.
      }
    }
    const keys = secureKeysRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !keys) {
      return false;
    }
    try {
      const secureEnvelope = await encryptSecurePayload(keys, "ws-chat", envelope);
      if (secureEnvelope.ciphertext.length > 16_384 || socket.readyState !== WebSocket.OPEN) {
        throw new Error("secure envelope unavailable");
      }
      socket.send(JSON.stringify(secureEnvelope));
      return true;
    } catch {
      if (dataChannel?.readyState === "open") {
        try {
          dataChannel.send(JSON.stringify(envelope));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async function handleP2pMessageEnvelope(envelope: Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>) {
    if (envelope.kind === "chat-ack") {
      pendingP2pMessageAttemptsRef.current.delete(envelope.messageId);
      clearP2pMessageAckTimer(envelope.messageId);
      updateP2pMessageDelivery(envelope.messageId, "delivered");
      return;
    }
    setP2pMessages((messages) =>
      messages.some((message) => message.id === envelope.id)
        ? messages
        : [
            ...messages,
            {
              id: envelope.id,
              author: envelope.author,
              body: envelope.body,
              lane: "p2p",
              at: envelope.at
            }
          ]
    );
    await sendP2pMessageEnvelope({ kind: "chat-ack", messageId: envelope.id });
  }

  function updateP2pMessageDelivery(messageId: string, localState?: "sending" | "delivered" | "failed", failureReason?: string) {
    setP2pMessages((messages) =>
      messages.map((message) =>
        message.id === messageId
          ? { ...message, localState, failureReason }
          : message
      )
    );
  }

  function clearP2pMessageAckTimer(messageId: string) {
    const timer = pendingP2pMessageTimersRef.current.get(messageId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingP2pMessageTimersRef.current.delete(messageId);
    }
  }

  function clearP2pMessageAckTimers() {
    for (const timer of pendingP2pMessageTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    pendingP2pMessageTimersRef.current.clear();
    pendingP2pMessageAttemptsRef.current.clear();
  }

  function clearP2pFileAckTimer(transferId: string) {
    const timer = pendingP2pFileAckTimersRef.current.get(transferId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingP2pFileAckTimersRef.current.delete(transferId);
    }
  }

  function clearP2pFileAckTimers() {
    for (const timer of pendingP2pFileAckTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    pendingP2pFileAckTimersRef.current.clear();
  }

  function startP2pFileAckTimer(transferId: string) {
    clearP2pFileAckTimer(transferId);
    const timer = window.setTimeout(() => {
      pendingP2pFileAckTimersRef.current.delete(transferId);
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "未收到对方的文件校验确认，请重试",
        retryable: pendingFilesRef.current.has(transferId)
      });
    }, P2P_FILE_ACK_TIMEOUT_MS);
    pendingP2pFileAckTimersRef.current.set(transferId, timer);
  }

  function markPendingP2pMessagesFailed(reason: string) {
    clearP2pMessageAckTimers();
    setP2pMessages((messages) =>
      messages.map((message) =>
        message.self && message.localState === "sending"
          ? { ...message, localState: "failed", failureReason: reason }
          : message
      )
    );
  }

  function addP2pFile(file: File) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: "系统",
          body: "加密直连文件传输尚未就绪。请让对方保持页面打开，或改用共享空间上传。",
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
          body: `文件未发送：${getFileLimitText()} 大文件请拆分后重试，或改用共享空间上传。`,
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
            riskNote: "大文件更适合上传到共享空间，方便稍后继续处理。"
          }
        }
      ]);
      return;
    }

    pendingFilesRef.current.set(transferId, file);
    const mimeType = file.type || "application/octet-stream";
    const previewUrl = isPreviewableImageMimeType(mimeType) ? URL.createObjectURL(file) : undefined;
    if (previewUrl) {
      p2pDownloadUrlsRef.current.set(transferId, previewUrl);
    }
    const offered = sendEnvelope({
      kind: "file-offer",
      transferId,
      author: displayName.trim() || "对方",
      name: file.name,
      size: file.size,
      mimeType,
      total: getP2pFileChunkCount(file.size)
    });
    const initialTransfer: FileTransfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      mimeType,
      status: offered ? "waiting" : "failed",
      progress: 0,
      downloadUrl: previewUrl,
      riskNote,
      retryable: true,
      failureReason: offered ? undefined : "直连数据通道已断开"
    };
    setP2pMessages((messages) => [
      ...messages,
      {
        id: transferId,
        author: displayName.trim() || "你",
        body: getFileMessageBody(initialTransfer),
        lane: "p2p",
        at: nowLabel(),
        self: true,
        fileTransfer: initialTransfer
      }
    ]);
  }

  function sendEnvelope(envelope: DataEnvelope) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      return false;
    }
    try {
      dataChannel.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  async function handleDataChannelMessage(raw: string, sessionGeneration: number) {
    if (p2pSessionGenerationRef.current !== sessionGeneration) {
      return;
    }
    const envelope = parseDataEnvelope(raw);
    if (!envelope) {
      return;
    }

    if (envelope.kind === "chat" || envelope.kind === "chat-ack") {
      await handleP2pMessageEnvelope(envelope);
      return;
    }

    if (envelope.kind === "file-offer") {
      const existingFile = incomingFilesRef.current.get(envelope.transferId);
      if (existingFile?.blob) {
        if (
          existingFile.name === envelope.name &&
          existingFile.size === envelope.size &&
          existingFile.total === envelope.total &&
          existingFile.mimeType === (envelope.mimeType || "application/octet-stream")
        ) {
          sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
        } else {
          sendEnvelope({ kind: "file-error", transferId: envelope.transferId, reason: "文件重试信息不一致" });
        }
        return;
      }
      releaseIncomingP2pFile(envelope.transferId);
      cancelledP2pFileTransfersRef.current.delete(envelope.transferId);
      incomingFilesRef.current.set(envelope.transferId, {
        name: envelope.name,
        size: envelope.size,
        total: envelope.total,
        mimeType: envelope.mimeType || "application/octet-stream",
        accepted: false,
        chunks: [],
        chunkDigests: [],
        receivedBytes: 0
      });
      const incomingMessage: Message = {
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
      };
      setP2pMessages((messages) =>
        messages.some((message) => message.id === envelope.transferId)
          ? messages.map((message) => message.id === envelope.transferId ? incomingMessage : message)
          : [...messages, incomingMessage]
      );
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
      cancelledP2pFileTransfersRef.current.delete(envelope.transferId);
      void sendP2pFile(envelope.transferId, file).catch(() => {
        clearP2pFileAckTimer(envelope.transferId);
        if (!cancelledP2pFileTransfersRef.current.has(envelope.transferId)) {
          updateP2pFileTransfer(envelope.transferId, {
            status: "failed",
            failureReason: "文件读取或加密失败，请重新发送",
            retryable: true
          });
        }
      });
      return;
    }

    if (envelope.kind === "file-reject") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      releaseIncomingP2pFile(envelope.transferId);
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
      if (!incomingFile.accepted) {
        failIncomingP2pFile(envelope.transferId, "文件尚未确认接收");
        return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = base64ToBytes(envelope.data);
      } catch {
        failIncomingP2pFile(envelope.transferId, "文件分片无法解码");
        return;
      }
      const metadataFailure = validateP2pFileChunk(incomingFile, envelope, bytes);
      const digest = await sha256Base64Url(bytes.buffer);
      if (
        p2pSessionGenerationRef.current !== sessionGeneration ||
        incomingFilesRef.current.get(envelope.transferId) !== incomingFile
      ) {
        return;
      }
      if (metadataFailure || digest !== envelope.sha256) {
        failIncomingP2pFile(envelope.transferId, metadataFailure || "文件分片校验失败");
        return;
      }
      const previousDigest = incomingFile.chunkDigests[envelope.index];
      if (previousDigest) {
        if (previousDigest !== digest) {
          failIncomingP2pFile(envelope.transferId, "收到冲突的重复分片");
        }
        return;
      }
      incomingFile.chunks[envelope.index] = bytes;
      incomingFile.chunkDigests[envelope.index] = digest;
      incomingFile.receivedBytes += bytes.byteLength;
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
      if (incomingFile.blob) {
        if (envelope.total === incomingFile.total && envelope.size === incomingFile.size) {
          sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
        } else {
          sendEnvelope({ kind: "file-error", transferId: envelope.transferId, reason: "文件完成信息不一致" });
        }
        return;
      }
      const completionFailure = validateP2pFileCompletion(incomingFile, envelope);
      if (completionFailure) {
        failIncomingP2pFile(envelope.transferId, completionFailure);
        return;
      }
      const completeChunks = incomingFile.chunks as Uint8Array<ArrayBuffer>[];
      const blob = new Blob(completeChunks, { type: incomingFile.mimeType || "application/octet-stream" });
      if (blob.size !== incomingFile.size) {
        failIncomingP2pFile(envelope.transferId, "文件组装后的大小不一致");
        return;
      }
      incomingFile.blob = blob;
      incomingFile.chunks = [];
      incomingFile.chunkDigests = [];
      const downloadUrl = URL.createObjectURL(blob);
      p2pDownloadUrlsRef.current.set(envelope.transferId, downloadUrl);
      updateP2pFileTransfer(envelope.transferId, { status: "complete", progress: 100, downloadUrl });
      sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
      return;
    }

    if (envelope.kind === "file-ack") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      pendingFilesRef.current.delete(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, { status: "complete", progress: 100, retryable: false });
      return;
    }

    if (envelope.kind === "file-error") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, {
        status: "failed",
        failureReason: envelope.reason,
        retryable: pendingFilesRef.current.has(envelope.transferId)
      });
    }
  }

  function failIncomingP2pFile(transferId: string, reason: string) {
    releaseIncomingP2pFile(transferId);
    updateP2pFileTransfer(transferId, {
      status: "failed",
      progress: 0,
      failureReason: reason,
      retryable: false
    });
    sendEnvelope({ kind: "file-error", transferId, reason });
  }

  function releaseIncomingP2pFile(transferId: string) {
    incomingFilesRef.current.delete(transferId);
    const downloadUrl = p2pDownloadUrlsRef.current.get(transferId);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      p2pDownloadUrlsRef.current.delete(transferId);
    }
  }

  function clearIncomingP2pFiles() {
    incomingFilesRef.current.clear();
    for (const downloadUrl of p2pDownloadUrlsRef.current.values()) {
      URL.revokeObjectURL(downloadUrl);
    }
    p2pDownloadUrlsRef.current.clear();
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
    clearP2pFileAckTimers();
    for (const [transferId, incomingFile] of incomingFilesRef.current) {
      if (!incomingFile.blob) {
        releaseIncomingP2pFile(transferId);
      }
    }
    setP2pMessages((messages) =>
      messages.map((message) => {
        const transfer = message.fileTransfer;
        if (!transfer || !["waiting", "sending", "receiving", "verifying", "offered"].includes(transfer.status)) {
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
    clearP2pFileAckTimer(transferId);
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道已断开，请重连后重新发送",
        retryable: true
      });
      return;
    }

    const sendTransferEnvelope = (envelope: DataEnvelope) => {
      if (dataChannelRef.current !== dataChannel || dataChannel.readyState !== "open") {
        return false;
      }
      try {
        dataChannel.send(JSON.stringify(envelope));
        return true;
      } catch {
        return false;
      }
    };

    const failInterruptedTransfer = () => {
      clearP2pFileAckTimer(transferId);
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "传输中断，请确认双方页面在线后重新发送",
        retryable: true
      });
    };

    updateP2pFileTransfer(transferId, { status: "sending", progress: 0, failureReason: undefined });
    const total = getP2pFileChunkCount(file.size);
    for (let index = 0; index < total; index += 1) {
      if (cancelledP2pFileTransfersRef.current.has(transferId)) {
        return;
      }
      const chunk = file.slice(index * P2P_FILE_CHUNK_SIZE, Math.min(file.size, (index + 1) * P2P_FILE_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      const sha256 = await sha256Base64Url(buffer);
      await waitForBufferedAmount(dataChannel);
      if (cancelledP2pFileTransfersRef.current.has(transferId)) {
        return;
      }
      if (!sendTransferEnvelope({
          kind: "file-chunk",
          transferId,
          index,
          total,
          sha256,
          data: arrayBufferToBase64(buffer)
        })) {
        failInterruptedTransfer();
        return;
      }
      updateP2pFileTransfer(transferId, { progress: Math.round(((index + 1) / total) * 100) });
    }

    startP2pFileAckTimer(transferId);
    if (!sendTransferEnvelope({ kind: "file-complete", transferId, total, size: file.size })) {
      failInterruptedTransfer();
      return;
    }
    updateP2pFileTransfer(transferId, { status: "verifying", progress: 100, retryable: true });
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
    cancelledP2pFileTransfersRef.current.delete(transferId);
    const incomingFile = incomingFilesRef.current.get(transferId);
    if (incomingFile) {
      incomingFile.accepted = true;
    }
    updateP2pFileTransfer(transferId, { status: "receiving", progress: 0, failureReason: undefined });
  }

  function rejectP2pFile(transferId: string) {
    cancelledP2pFileTransfersRef.current.add(transferId);
    releaseIncomingP2pFile(transferId);
    sendEnvelope({ kind: "file-reject", transferId, reason: "对方拒绝接收" });
    updateP2pFileTransfer(transferId, { status: "rejected", progress: 0, failureReason: "你已拒绝接收" });
  }

  function retryP2pFile(transferId: string) {
    clearP2pFileAckTimer(transferId);
    const file = pendingFilesRef.current.get(transferId);
    if (!file) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "本机已找不到原文件，请重新选择文件",
        retryable: false
      });
      return;
    }
    if (dataChannelRef.current?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道未恢复，请等待对方在线后重试",
        retryable: true
      });
      return;
    }
    cancelledP2pFileTransfersRef.current.delete(transferId);
    updateP2pFileTransfer(transferId, { status: "waiting", progress: 0, failureReason: undefined });
    const offered = sendEnvelope({
      kind: "file-offer",
      transferId,
      author: displayName.trim() || "对方",
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      total: getP2pFileChunkCount(file.size)
    });
    if (!offered) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道未恢复，请等待对方在线后重试",
        retryable: true
      });
    }
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

    const temporaryDownloadUrl = !transfer.downloadUrl;
    const downloadUrl = transfer.downloadUrl ?? URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = transfer.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (temporaryDownloadUrl) {
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
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

  function applyAppRouteState(route: AppRoute) {
    if (route.kind === "entry" || route.kind === "about") {
      setLane(route.kind);
      setWorkspaceCreateMenuOpen(false);
      setWorkspaceUserMenuOpen(false);
      return;
    }

    if (route.kind === "direct") {
      const incomingSecret = route.roomId ? getRoomSecretFromHash() : "";
      setLane("p2p");
      setRoomId(route.roomId);
      setRoomSecret(incomingSecret);
      setInviteLink(route.roomId && incomingSecret ? withRoomSecret(getInviteLink(route.roomId), incomingSecret) : "");
      setP2pError("");
      if (route.roomId && !incomingSecret) {
        setP2pRoomIssue("missing-key");
        setP2pStep("invalid-room");
      } else {
        setP2pRoomIssue("");
        setP2pStep("name");
      }
      return;
    }

    setLane("workspace-dev");
    setWorkspacePendingInviteCode(route.inviteCode);
    setWorkspaceView(workspaceViewFromRoute(route));
    if (route.view === "chat") {
      setWorkspaceSelectedConversationId(route.conversationId);
    }
    setWorkspaceSelectedFileId(route.fileId);
    setWorkspaceSelectedMemberId(route.memberId);
    setWorkspaceSpaceTab(route.spaceTab);
    setWorkspaceCreateMode(route.createMode);
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);

    if (route.view === "files" && route.fileId) {
      setWorkspaceContextMode("file");
      setWorkspaceContextCollapsed(false);
      setWorkspaceMobilePane("details");
    } else if (route.view === "members" && route.memberId) {
      setWorkspaceContextMode("member");
      setWorkspaceContextCollapsed(false);
      setWorkspaceMobilePane("details");
    } else if (route.view === "chat") {
      setWorkspaceContextMode("conversation");
      setWorkspaceMobilePane(route.conversationId ? "main" : "list");
    } else {
      setWorkspaceMobilePane("main");
    }
  }

  function writeAppRoute(route: AppRoute, options: { replace?: boolean; roomSecret?: string } = {}) {
    const hash = route.kind === "direct" && options.roomSecret
      ? `#${new URLSearchParams({ k: options.roomSecret }).toString()}`
      : "";
    const nextUrl = `${getAppRouteUrl(route)}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", nextUrl);
  }

  function navigateAppRoute(route: AppRoute, options: { replace?: boolean; roomSecret?: string } = {}) {
    writeAppRoute(route, options);
    applyAppRouteState(route);
  }

  function replaceWorkspaceRoute(route: Extract<AppRoute, { kind: "workspace" }>) {
    writeAppRoute(route, { replace: true });
  }

  function navigateWorkspaceView(view: WorkspaceView, spaceTab: WorkspaceSpaceTab = "overview") {
    const route = workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view,
      conversationId: view === "chat" ? workspaceSelectedConversationId : "",
      spaceTab
    });
    navigateAppRoute(route);
  }

  function navigateWorkspaceSpaceTab(spaceTab: WorkspaceSpaceTab) {
    navigateAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "space",
      spaceTab
    }));
  }

  function resetToEntry() {
    endP2pSocket();
    clearWorkspaceClientState();
    navigateAppRoute({ kind: "entry" });
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
    p2pSessionGenerationRef.current += 1;
    p2pDataMessageQueueRef.current = Promise.resolve();
    pendingFilesRef.current.clear();
    cancelledP2pFileTransfersRef.current.clear();
    clearIncomingP2pFiles();
    clearP2pMessageAckTimers();
    clearP2pFileAckTimers();
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
    navigateAppRoute({ kind: "direct", roomId: "" });
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
    p2pSessionGenerationRef.current += 1;
    p2pDataMessageQueueRef.current = Promise.resolve();
    pendingFilesRef.current.clear();
    cancelledP2pFileTransfersRef.current.clear();
    clearIncomingP2pFiles();
    clearP2pMessageAckTimers();
    clearP2pFileAckTimers();
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

  async function copyInviteLink() {
    const didCopy = await copyText(inviteLink);
    setCopyState(didCopy ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <main
      className={lane === "workspace-dev" ? "shell workspace-mode" : lane === "p2p" ? "shell p2p-mode" : lane === "about" ? "shell about-mode" : "shell"}
    >
      {(lane !== "workspace-dev" || workspaceStatus !== "ready" || !workspaceBootstrap) && (
        <ThemeSwitch mode={themeMode} resolvedTheme={resolvedTheme} onModeChange={setThemeMode} />
      )}
      {lane === "entry" && (
        <section className="entry page-enter" aria-labelledby="entry-title">
          <div className="entry-heading">
            <p className="eyebrow">DualLane</p>
            <h1 id="entry-title">选择沟通方式</h1>
          </div>
          <div className="lane-grid" aria-label="通信通道">
            <button className="lane-choice direct-choice" type="button" onClick={() => navigateAppRoute({ kind: "direct", roomId: "" })}>
              <span className="lane-icon" aria-hidden="true">
                <LockKeyhole size={28} />
              </span>
              <strong>一对一直连</strong>
              <span>无需登录，适合临时的一对一交流。<br />对话内容不在服务器保存。</span>
            </button>
            <button className="lane-choice workspace-choice" type="button" onClick={() => navigateAppRoute(workspaceRoute())}>
              <span className="lane-icon" aria-hidden="true">
                <ShieldCheck size={28} />
              </span>
              <strong>共享空间</strong>
              <span>和熟人或小组长期共享聊天与文件。<br />需要登录和邀请。</span>
            </button>
          </div>
          <button className="entry-about-link" type="button" onClick={() => navigateAppRoute({ kind: "about" })}>
            关于 DualLane 与版本更新
          </button>
        </section>
      )}

      {lane === "about" && <AboutPage onBack={() => navigateAppRoute({ kind: "entry" })} />}

      {lane === "p2p" && (
        <section className="lane-surface p2p-shell" aria-labelledby="p2p-title">
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
              onRetryMessage={(messageId) => void retryP2pMessage(messageId)}
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
        <section
          className="workspace-shell"
          aria-labelledby="workspace-dev-title"
          aria-busy={workspaceStatus === "idle" || workspaceStatus === "loading"}
          data-app-state={
            workspaceStatus === "idle" || workspaceStatus === "loading"
              ? "loading"
              : workspaceStatus === "ready" && workspaceBootstrap
                ? "ready"
                : "error"
          }
        >
          {workspaceStatus !== "idle" && workspaceStatus !== "loading" && (workspaceStatus !== "ready" || !workspaceBootstrap) && (
            <TopBar
              label="共享空间"
              title={workspaceBootstrap?.space.name ?? "共享空间"}
              icon={<ShieldCheck size={18} />}
              onBack={resetToEntry}
            />
          )}
          {workspaceStatus === "idle" || workspaceStatus === "loading" ? (
            <WorkspaceShellSkeleton />
          ) : workspaceStatus !== "ready" || !workspaceBootstrap ? (
            <div className="single-action development-state">
              <div className="center-icon workspace-dev-bg" aria-hidden="true">
                <ShieldCheck size={30} />
              </div>
              <p className="eyebrow">
                {workspaceStatus === "disabled" ? "暂未开放" : workspaceStatus === "error" ? "加载失败" : "需要登录"}
              </p>
              <h2 id="workspace-dev-title">
                {workspaceStatus === "disabled"
                  ? "共享空间暂未开放。"
                  : workspaceStatus === "error"
                    ? "共享空间加载失败。"
                    : "登录后进入共享空间。"}
              </h2>
              <p className="quiet">
                共享空间会保存聊天和文件，方便成员稍后查看。<br />
                进入权限由服务端校验。
              </p>
              {workspaceError && <InlineNotice tone={workspaceStatus === "disabled" ? "info" : "warning"} text={workspaceError} />}
              {(workspaceStatus === "auth" || workspaceStatus === "error") && (
                <div className="action-row">
                  {workspaceStatus === "auth" && (
                    <button className="primary workspace-login-button" type="button" onClick={() => window.location.assign(getWorkspaceLoginUrl(workspacePendingInviteCode, `${window.location.pathname}${window.location.search}`))}>
                      <Github size={18} />
                      使用 GitHub 登录
                    </button>
                  )}
                  {workspaceStatus === "error" && (
                    <button className="secondary" type="button" onClick={() => void loadWorkspace()}>
                      <RefreshCw size={18} />
                      重新加载
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {workspaceNotice && (
                <div className="toast-region" aria-live="polite" aria-atomic="true">
                  <InlineNotice
                    noticeKey={workspaceNotice.id}
                    tone={workspaceNotice.tone}
                    text={workspaceNotice.text}
                    persistent={workspaceNotice.persistent}
                    durationMs={workspaceNotice.durationMs}
                    onDismiss={clearWorkspaceNotice}
                  />
                </div>
              )}
              <WorkspaceShell mobilePane={workspaceMobilePane} contextVisible={workspaceContextVisible}>
                <aside className="workspace-rail" aria-label="共享空间导航">
                  <div className="workspace-rail-header">
                    <div className="workspace-space-identity">
                      <img className="workspace-space-logo" src="/icon-512.png" alt="" aria-hidden="true" />
                      <span>
                        <strong>{workspaceBootstrap.space.name}</strong>
                        <small>共享空间</small>
                      </span>
                    </div>
                    <div className="workspace-popover-anchor" ref={workspaceCreateMenuRef}>
                      <button
                        ref={workspaceCreateTriggerRef}
                        id="workspace-create-menu-trigger"
                        className="icon-button"
                        type="button"
                        title="新建"
                        aria-label="新建"
                        aria-haspopup="menu"
                        aria-expanded={workspaceCreateMenuOpen}
                        aria-controls={workspaceCreateMenuOpen ? "workspace-create-menu" : undefined}
                        onClick={() => {
                          setWorkspaceUserMenuOpen(false);
                          setWorkspaceCreateMenuOpen((open) => !open);
                        }}
                      >
                        <Plus size={18} />
                      </button>
                      {workspaceCreateMenuOpen && (
                        <div
                          className="workspace-popover workspace-create-menu"
                          id="workspace-create-menu"
                          role="menu"
                          aria-label="新建菜单"
                          onKeyDown={handleMenuKeyDown}
                        >
                          {workspaceBootstrap.permissions.canCreateDirect && (
                            <button role="menuitem" type="button" onClick={() => openWorkspaceCreate("direct")}>
                              <MessageSquare size={16} />
                              发起私聊
                            </button>
                          )}
                          {workspaceBootstrap.permissions.canCreateGroup && (
                            <button role="menuitem" type="button" onClick={() => openWorkspaceCreate("group")}>
                              <UsersRound size={16} />
                              创建群聊
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <nav className="workspace-tabs" aria-label="共享空间视图">
                    {[
                      { id: "chat" as const, label: "聊天", icon: <MessageSquare size={16} /> },
                      { id: "files" as const, label: "文件", icon: <FileCheck2 size={16} /> },
                      { id: "members" as const, label: "成员", icon: <UsersRound size={16} /> }
                    ].map((item) => (
                      <button
                        className={workspaceView === item.id ? "active" : ""}
                        key={item.id}
                        type="button"
                        aria-current={workspaceView === item.id ? "page" : undefined}
                        aria-controls="workspace-main-panel"
                        onClick={() => {
                          navigateWorkspaceView(item.id);
                          setWorkspaceMobilePane(item.id === "chat" ? "list" : "main");
                          setWorkspaceCreateMode("");
                          setWorkspaceCreateMenuOpen(false);
                        }}
                      >
                        {item.icon}
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </nav>
                  <label className="workspace-search compact-search">
                    <span className="sr-only">查找会话</span>
                    <input
                      value={workspaceConversationQuery}
                      onChange={(event) => setWorkspaceConversationQuery(event.target.value)}
                      placeholder="会话、成员或消息"
                    />
                  </label>
                  <div className="conversation-list workspace-conversation-list">
                    {workspaceFilteredConversations.length === 0 ? (
                      <p className="saved-empty">
                        {workspaceConversations.length === 0 ? "还没有会话。可以从成员列表发起私聊。" : "没有找到匹配的会话。"}
                      </p>
                    ) : (
                      workspaceFilteredConversations.map((conversation) => (
                        <button
                          className={conversation.id === workspaceSelectedConversationId ? "conversation active" : "conversation"}
                          type="button"
                          key={conversation.id}
                          aria-current={conversation.id === workspaceSelectedConversationId ? "true" : undefined}
                          onClick={() => selectWorkspaceConversation(conversation.id)}
                        >
                          <WorkspaceConversationAvatar
                            conversation={conversation}
                            currentUserId={workspaceBootstrap.auth.currentUser.id}
                            className="conversation-icon"
                          />
                          <span>
                            <strong>
                              <WorkspaceIdentityName
                                name={workspaceConversationTitle(conversation, workspaceBootstrap.auth.currentUser.id)}
                                kind={conversation.otherMember?.kind}
                              />
                            </strong>
                            <small>{workspaceConversationPreview(conversation)}</small>
                          </span>
                          <span className="conversation-side">
                            <time>{workspaceConversationTime(conversation)}</time>
                            {(conversation.unreadCount ?? 0) > 0 ? (
                              <em className="unread-badge">{conversation.unreadCount}</em>
                            ) : conversation.notificationLevel === "muted" ? (
                              <BellOff className="conversation-muted" size={14} aria-label="已免打扰" />
                            ) : null}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="workspace-rail-footer">
                    {workspaceRealtimeState !== "connected" && (
                      <div className={`workspace-connection-state ${workspaceRealtimeState}`} role="status">
                        <Radio size={14} />
                        <span>{workspaceRealtimeStateLabel(workspaceRealtimeState)}</span>
                      </div>
                    )}
                    <div className="workspace-popover-anchor" ref={workspaceUserMenuRef}>
                      <button
                        ref={workspaceUserTriggerRef}
                        id="workspace-user-menu-trigger"
                        className="workspace-user-trigger"
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={workspaceUserMenuOpen}
                        aria-controls={workspaceUserMenuOpen ? "workspace-user-menu" : undefined}
                        onClick={() => {
                          setWorkspaceCreateMenuOpen(false);
                          setWorkspaceUserMenuOpen((open) => !open);
                        }}
                      >
                        <WorkspaceAvatar
                          name={workspaceBootstrap.auth.currentUser.displayName}
                          avatarUrl={workspaceBootstrap.auth.currentUser.avatarUrl}
                          className="small"
                          decorative
                        />
                        <span>
                          <strong>{workspaceBootstrap.auth.currentUser.displayName}</strong>
                          <small>{workspaceRoleLabel(workspaceBootstrap.auth.currentUser.role)}</small>
                        </span>
                        <ChevronUp size={15} />
                      </button>
                      {workspaceUserMenuOpen && (
                        <div
                          className="workspace-popover workspace-user-menu"
                          id="workspace-user-menu"
                          role="menu"
                          aria-label="账号菜单"
                          onKeyDown={handleMenuKeyDown}
                        >
                          <div className="workspace-user-summary" role="presentation">
                            <span>今日传输额度</span>
                            <strong>{workspaceRemainingText}</strong>
                            <small>{workspaceQuotaDetailText}</small>
                          </div>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("account");
                              setWorkspaceMobilePane("main");
                              setWorkspaceUserMenuOpen(false);
                            }}
                          >
                            <UserRound size={16} />
                            个人设置
                          </button>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("space");
                              setWorkspaceMobilePane("main");
                              setWorkspaceUserMenuOpen(false);
                            }}
                          >
                            <Settings size={16} />
                            空间信息与设置
                          </button>
                          <button role="menuitem" type="button" onClick={() => void loadWorkspace()}>
                            <RefreshCw size={16} />
                            重新同步
                          </button>
                          <ThemeSwitch mode={themeMode} resolvedTheme={resolvedTheme} onModeChange={setThemeMode} inline />
                          <button role="menuitem" type="button" onClick={resetToEntry}>
                            <ArrowLeft size={16} />
                            返回入口
                          </button>
                          <button role="menuitem" className="danger-action" type="button" onClick={() => void logoutWorkspace()}>
                            <LogOut size={16} />
                            退出共享空间
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </aside>

                <section className="workspace-main" id="workspace-main-panel" aria-label="共享空间主视图">
                  {workspaceCreateMode && (
                    <div
                      className="workspace-task-panel"

                      role="region"
                      aria-label={workspaceCreateMode === "direct" ? "发起私聊" : "创建群聊"}
                      onKeyDown={handleWorkspaceCreatePanelKeyDown}
                    >
                      <div className="workspace-task-header">
                        <div>
                          <p className="eyebrow">{workspaceCreateMode === "direct" ? "私聊" : "群聊"}</p>
                          <h2>{workspaceCreateMode === "direct" ? "选择一个成员开始私聊" : "创建群聊"}</h2>
                        </div>
                        <button
                          className="icon-button"
                          type="button"
                          title="关闭"
                          onClick={closeWorkspaceCreate}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <label className="workspace-search">
                        <span>查找成员</span>
                        <input
                          ref={workspaceCreateSearchInputRef}
                          value={workspacePickerMemberQuery}
                          onChange={(event) => setWorkspacePickerMemberQuery(event.target.value)}
                          placeholder="输入昵称或 GitHub 登录名"
                        />
                      </label>
                      {workspaceCreateMode === "group" && (
                        <form className="workspace-group-form" onSubmit={(event) => void createWorkspaceGroup(event)}>
                          <label>
                            <span>群聊名称</span>
                            <input
                              value={workspaceNewGroupTitle}
                              onChange={(event) => setWorkspaceNewGroupTitle(event.target.value)}
                              placeholder="例如：项目讨论"
                              aria-label="群聊名称"
                            />
                          </label>
                          <WorkspaceGroupAvatarEditor
                            value={workspaceNewGroupAvatarEmoji}
                            onChange={setWorkspaceNewGroupAvatarEmoji}
                            label="群头像"
                          />
                          <div className="workspace-picker-list" aria-label="选择群成员">
                            {workspaceSelectableMembers.length === 0 ? (
                              <p className="saved-empty">没有找到可添加的成员。</p>
                            ) : (
                              workspaceSelectableMembers.map((member) => (
                                <button
                                  className={workspaceGroupMemberIds.includes(member.id) ? "workspace-picker-row selected" : "workspace-picker-row"}
                                  type="button"
                                  key={member.id}
                                  onClick={() => toggleWorkspaceGroupMember(member.id)}
                                >
                                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                                  <span>
                                    <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                    <small>{workspaceMemberSecondaryText(member)}</small>
                                  </span>
                                  {workspaceGroupMemberIds.includes(member.id) && <Check size={17} />}
                                </button>
                              ))
                            )}
                          </div>
                          <div className="workspace-task-actions">
                            <span className="workspace-selection-count">已选 {workspaceGroupMemberIds.length} 位</span>
                            <button
                              className="secondary"
                              type="button"
                              onClick={closeWorkspaceCreate}
                            >
                              取消
                            </button>
                            <button className="primary" type="submit" disabled={workspaceGroupMemberIds.length === 0}>
                              <Plus size={17} />
                              创建群聊
                            </button>
                          </div>
                        </form>
                      )}
                      {workspaceCreateMode === "direct" && (
                        <div className="workspace-picker-list" aria-label="选择私聊成员">
                          {workspaceSelectableMembers.length === 0 ? (
                            <p className="saved-empty">没有找到可发起私聊的成员。</p>
                          ) : (
                            workspaceSelectableMembers.map((member) => (
                              <button
                                className="workspace-picker-row"
                                type="button"
                                key={member.id}
                                onClick={() => void createWorkspaceDirect(member.id)}
                              >
                                <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                                <span>
                                  <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                  <small>{workspaceMemberSecondaryText(member)}</small>
                                </span>
                                <MessageSquare size={17} />
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "chat" && (
                    workspaceSelectedConversation ? (
                      <WorkspaceChatPanel
                        title={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                        titleKind={workspaceSelectedConversation.otherMember?.kind}
                        avatar={
                          <WorkspaceConversationAvatar
                            conversation={workspaceSelectedConversation}
                            currentUserId={workspaceBootstrap.auth.currentUser.id}
                            className="small"
                          />
                        }
                        subtitle={workspaceSelectedConversation.type === "group"
                          ? `${workspaceConversationMemberCount(workspaceSelectedConversation)} 位成员`
                          : workspaceSelectedConversation.otherMember?.description || "私聊"}
                        leadingAction={
                          <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => setWorkspaceMobilePane("list")}>
                            <ArrowLeft size={16} />
                          </button>
                        }
                        trailingAction={
                          <>
                            <button
                              className="icon-button desktop-only"
                              type="button"
                              title={workspaceContextVisible ? "收起详情" : "查看详情"}
                              onClick={() => {
                                setWorkspaceContextMode("conversation");
                                setWorkspaceContextCollapsed((collapsed) => !collapsed);
                              }}
                            >
                              <PanelRightOpen size={16} />
                            </button>
                            <button
                              className="secondary compact mobile-only"
                              type="button"
                              onClick={() => {
                                setWorkspaceContextMode("conversation");
                                setWorkspaceContextCollapsed(false);
                                setWorkspaceMobilePane("details");
                              }}
                            >
                              <PanelRightOpen size={16} />
                              详情
                            </button>
                          </>
                        }
                        messages={workspaceMessages}
                        messageListRef={workspaceMessageListRef}
                        onMessageListScroll={handleWorkspaceMessageListScroll}
                        onMessageListScrollIntent={registerWorkspaceMessageListScrollIntent}
                        olderMessagesAvailable={workspaceCanLoadOlderMessages}
                        olderMessagesLoading={workspaceHistoryLoading}
                        onLoadOlderMessages={() => void loadOlderWorkspaceMessages(workspaceSelectedConversation.id)}
                        unreadAnchorMessageId={workspaceUnreadAnchor?.messageId}
                        unreadAnchorCount={workspaceUnreadAnchor?.count ?? 0}
                        newMessageCount={workspaceNewMessageCount}
                        awayFromLatest={workspaceAwayFromLatest}
                        onJumpToLatest={jumpWorkspaceToLatest}
                        draft={workspaceDraft}
                        draftDocument={workspaceDraftDocument}
                        onDraft={(document) => setWorkspaceConversationDraft(workspaceSelectedConversation.id, document)}
                        onSend={sendWorkspaceMessage}
                        stagedAttachments={workspaceComposerAttachments}
                        onStageFiles={stageWorkspaceAttachments}
                        onRemoveStagedAttachment={(attachmentId) =>
                          void removeWorkspaceComposerAttachment(workspaceSelectedConversation.id, attachmentId)
                        }
                        onReply={(messageId) => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, messageId)}
                        onRetryMessage={(messageId) => void retryWorkspaceMessage(messageId)}
                        replyTarget={workspaceReplyTarget}
                        onCancelReply={() => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, "")}
                        onOpenAttachment={openWorkspaceAttachmentFile}
                        onPreviewImage={setWorkspaceImagePreview}
                        onCopyMessage={(message) => {
                          void copyText(serializeWorkspaceMessageForCopy(message)).then((copied) =>
                            showWorkspaceNotice(copied ? "success" : "warning", copied ? "消息已复制" : "消息复制失败")
                          );
                        }}
                        onToggleReaction={(messageId, emoteKey) => void toggleWorkspaceReaction(messageId, emoteKey)}
                        onFavoriteEmote={(message) => void favoriteWorkspaceMessageEmote(message)}
                        reactionPendingKeys={workspaceReactionPendingKeys}
                        currentUserId={workspaceBootstrap.auth.currentUser.id}
                        conversationType={workspaceSelectedConversation.type}
                        historyTargetId={workspaceHistoryTargetId}
                        onReturnToLatest={() => void returnWorkspaceToLatest()}
                        onTogglePin={(message) => void toggleWorkspacePin(message)}
                        onRecall={(message) => void recallWorkspaceMessage(message)}
                        mentionMembers={workspaceSelectedConversation.type === "group"
                          ? workspaceSelectedConversation.members.filter(
                            (member) => member.id !== workspaceBootstrap.auth.currentUser.id
                          )
                          : []}
                        fileInputDisabled={!workspaceBootstrap.permissions.canUpload}
                        sending={workspaceSending}
                      />
                    ) : (
                      <div className="workspace-home-panel">
                        <div className="workspace-home-hero">
                          <span className="center-icon workspace-dev-bg" aria-hidden="true">
                            <MessageSquare size={28} />
                          </span>
                          <div>
                            <p className="workspace-panel-kicker">空间首页</p>
                            <h2>从成员或文件开始</h2>
                            <p>还没有会话。可以先发起私聊，也可以查看成员和共享文件。</p>
                          </div>
                        </div>
                        <div className="workspace-home-actions">
                          {workspaceBootstrap.permissions.canCreateDirect && (
                            <button className="primary" type="button" onClick={() => openWorkspaceCreate("direct")}>
                              <MessageSquare size={17} />
                              发起私聊
                            </button>
                          )}
                          {workspaceBootstrap.permissions.canCreateGroup && (
                            <button className="secondary" type="button" onClick={() => openWorkspaceCreate("group")}>
                              <UsersRound size={17} />
                              创建群聊
                            </button>
                          )}
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("members");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <UsersRound size={17} />
                            查看成员
                          </button>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("files");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <FileCheck2 size={17} />
                            共享文件
                          </button>
                        </div>
                        <div className="workspace-home-summary" aria-label="空间概览">
                          <div>
                            <span>成员</span>
                            <strong>{workspaceBootstrap.members.length} 位</strong>
                            <small>邀请加入</small>
                          </div>
                          <div>
                            <span>今日传输额度</span>
                            <strong>{workspaceRemainingText}</strong>
                            <small>{workspaceQuotaDetailText}</small>
                          </div>
                          <div>
                            <span>消息保留</span>
                            <strong>最近 {workspaceBootstrap.policy.messageRetentionCount} 条</strong>
                            <small>按会话保留</small>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {!workspaceCreateMode && workspaceView === "files" && (
                    <div className="workspace-content-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => setWorkspaceMobilePane("list")}>
                          <ArrowLeft size={16} />
                        </button>
                        <h2>共享文件</h2>
                        <label
                          className={workspaceUploading || !workspaceBootstrap.permissions.canUpload ? "file-button disabled" : "file-button"}
                          title={workspaceUploading ? "上传中" : "上传文件"}
                        >
                          <FileUp size={17} />
                          <input
                            type="file"
                            aria-label={workspaceUploading ? "上传中" : "上传文件"}
                            disabled={workspaceUploading || !workspaceBootstrap.permissions.canUpload}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              if (file) {
                                void uploadWorkspaceFile(file, "space");
                                event.currentTarget.value = "";
                              }
                            }}
                          />
                        </label>
                      </div>
                      <div className="workspace-filter-tabs" aria-label="文件筛选">
                        {[
                          { id: "all" as const, label: "全部" },
                          { id: "conversation" as const, label: "会话文件" },
                          { id: "standalone" as const, label: "独立文件" },
                          { id: "mine" as const, label: "我上传的" }
                        ].map((filter) => (
                          <button
                            className={workspaceFileFilter === filter.id ? "active" : ""}
                            type="button"
                            key={filter.id}
                            onClick={() => setWorkspaceFileFilter(filter.id)}
                          >
                            {filter.label}
                          </button>
                        ))}
                      </div>
                      <div className="workspace-file-subnav">
                        <WorkspaceFileCategoryTabs value={workspaceFileCategory} onChange={setWorkspaceFileCategory} />
                        {workspaceFileCategory === "media" && (
                          <WorkspaceFileViewToggle value={workspaceFileViewMode} onChange={setWorkspaceFileViewMode} />
                        )}
                      </div>
                      <label className="workspace-search compact-search">
                        <span className="sr-only">查找文件</span>
                        <input
                          value={workspaceFileQuery}
                          onChange={(event) => setWorkspaceFileQuery(event.target.value)}
                          placeholder="文件名、上传者或会话"
                        />
                      </label>
                      <div className="workspace-file-browser">
                        <div className={workspaceFileCategory === "media" && workspaceFileViewMode === "grid"
                          ? "workspace-file-table media-grid"
                          : "workspace-file-table"}>
                          {workspaceFilteredFiles.length === 0 ? (
                            <p className="saved-empty">没有匹配的文件。</p>
                          ) : (
                            workspaceFilteredFiles.map((file) => {
                              const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "download", workspaceBootstrap.policy);
                              const downloadDisabled =
                                !workspaceBootstrap.permissions.canDownload ||
                                Boolean(quotaWarning) ||
                                file.status !== "available" ||
                                Boolean(file.localUpload);
                              return (
                                <div
                                  className={[
                                    workspaceSelectedFileId === file.id ? "workspace-file-row active" : "workspace-file-row",
                                    workspaceFileCategory === "media" && workspaceFileViewMode === "grid" ? "media-card" : "",
                                    file.localUpload?.state ? `local-${file.localUpload.state}` : ""
                                  ].filter(Boolean).join(" ")}
                                  key={file.id}
                                >
                                  <button
                                    className="workspace-file-row-main"
                                    type="button"
                                    onClick={() => {
                                      setWorkspaceSelectedFileId(file.id);
                                      writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: file.id }));
                                      setWorkspaceContextMode("file");
                                      setWorkspaceContextCollapsed(false);
                                      setWorkspaceMobilePane("details");
                                    }}
                                  >
                                    <WorkspaceFileThumbnail file={file} large={workspaceFileCategory === "media" && workspaceFileViewMode === "grid"} />
                                    <span>
                                      <strong>{file.fileName}</strong>
                                      <small>
                                        {formatBytes(file.byteSize)} · {workspaceFileUploaderName(file)} · {workspaceFileScope(file, workspaceConversations)}
                                        {file.localUpload?.state === "failed" ? ` · ${file.localUpload.failureReason || "上传失败"}` : ""}
                                      </small>
                                    </span>
                                    <em>{workspaceFileVisibilityLabel(file)}</em>
                                  </button>
                                  <button
                                    className="icon-button workspace-file-download"
                                    type="button"
                                    title={quotaWarning || (!workspaceBootstrap.permissions.canDownload ? "你当前不能下载文件" : "下载文件")}
                                    disabled={downloadDisabled}
                                    onClick={() => void reserveWorkspaceDownload(file)}
                                  >
                                    <Download size={16} />
                                  </button>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "members" && (
                    <div className="workspace-content-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => setWorkspaceMobilePane("list")}>
                          <ArrowLeft size={16} />
                        </button>
                        <h2>{workspaceBootstrap.auth.currentUser.role === "owner" ? "空间成员" : "可联系成员"}</h2>
                        {workspaceBootstrap.permissions.canCreateMemberInvite && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceSpaceTab("invites");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <Plus size={17} />
                            邀请成员
                          </button>
                        )}
                      </div>
                      <label className="workspace-search">
                        <span className="sr-only">查找成员</span>
                        <input
                          value={workspaceMemberQuery}
                          onChange={(event) => setWorkspaceMemberQuery(event.target.value)}
                          placeholder="输入昵称或 GitHub 登录名"
                        />
                      </label>

                      <div className="workspace-member-toolbar">
                        <div
                          className={workspaceMemberFilterOpen ? "workspace-member-filter open" : "workspace-member-filter"}
                          ref={workspaceMemberFilterRef}
                        >
                          <button
                            ref={workspaceMemberFilterTriggerRef}
                            id="workspace-member-filter-trigger"
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded={workspaceMemberFilterOpen}
                            aria-controls="workspace-member-filter-menu"
                            onClick={() => {
                              setWorkspaceCreateMenuOpen(false);
                              setWorkspaceUserMenuOpen(false);
                              setWorkspaceMemberFilterOpen((open) => !open);
                            }}
                          >
                            <Settings size={15} />
                            筛选
                            <ChevronDown size={14} />
                          </button>
                          {workspaceMemberFilterOpen && (
                            <div
                              className="workspace-member-filter-menu"
                              id="workspace-member-filter-menu"
                              role="menu"
                              aria-labelledby="workspace-member-filter-trigger"
                              onKeyDown={handleMenuKeyDown}
                            >
                              {workspaceBootstrap.auth.currentUser.role === "owner" && (
                                <div role="group" aria-label="按角色筛选">
                                  <span>角色</span>
                                  {[
                                    { id: "all" as const, label: "全部角色" },
                                    { id: "owner" as const, label: "主人" },
                                    { id: "admin" as const, label: "管理员" },
                                    { id: "member" as const, label: "成员" },
                                    { id: "auditor" as const, label: "预留角色", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite }
                                  ].filter((filter) => filter.id !== "auditor" || filter.visible).map((filter) => (
                                    <button
                                      role="menuitemradio"
                                      aria-checked={workspaceMemberRoleFilter === filter.id}
                                      type="button"
                                      key={filter.id}
                                      onClick={() => setWorkspaceMemberRoleFilter(filter.id)}
                                    >
                                      <span className="workspace-filter-check" aria-hidden="true">
                                        {workspaceMemberRoleFilter === filter.id && <Check size={14} />}
                                      </span>
                                      <span>{filter.label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div role="group" aria-label="按类型筛选">
                                <span>类型</span>
                                {[
                                  { id: "all" as const, label: "全部类型" },
                                  { id: "human" as const, label: "成员" },
                                  { id: "bot" as const, label: "机器人" },
                                  { id: "system" as const, label: "系统" }
                                ].map((filter) => (
                                  <button
                                    role="menuitemradio"
                                    aria-checked={workspaceMemberKindFilter === filter.id}
                                    type="button"
                                    key={filter.id}
                                    onClick={() => setWorkspaceMemberKindFilter(filter.id)}
                                  >
                                    <span className="workspace-filter-check" aria-hidden="true">
                                      {workspaceMemberKindFilter === filter.id && <Check size={14} />}
                                    </span>
                                    <span>{filter.label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        <span>
                          {workspaceFilteredMembers.length} {workspaceBootstrap.auth.currentUser.role === "owner" ? "位成员" : "位联系人"}
                        </span>
                      </div>                      <div className="workspace-member-grid" role="list">
                        {workspaceFilteredMembers.length === 0 ? (
                          <p className="saved-empty">没有找到匹配的成员。</p>
                        ) : (
                          workspaceFilteredMembers.map((member) => (
                          <article className="workspace-member-card" role="listitem" key={member.id}>
                            <button
                              className="workspace-member-main"
                              type="button"
                              onClick={() => openWorkspaceMemberDetails(member)}
                            >
                              <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                              <span>
                                <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                <small>{workspaceMemberSecondaryText(member)}</small>
                              </span>
                            </button>
                            {member.id !== workspaceBootstrap.auth.currentUser.id &&
                              workspaceBootstrap.permissions.canCreateDirect &&
                              member.capabilities?.canStartDirectConversation === true && (
                              <button
                                className="icon-button"
                                type="button"
                                title={`与 ${member.displayName} 私聊`}
                                onClick={() => void createWorkspaceDirect(member.id)}
                              >
                                <MessageSquare size={15} />
                              </button>
                            )}
                          </article>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "account" && (
                    <WorkspaceAccountSettings
                      currentUser={workspaceBootstrap.auth.currentUser}
                      onBack={() => setWorkspaceMobilePane("list")}
                      onUserUpdated={upsertWorkspaceMember}
                      onNotice={showWorkspaceNotice}
                    />
                  )}

                  {!workspaceCreateMode && workspaceView === "space" && (
                    <div className="workspace-content-panel workspace-space-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => setWorkspaceMobilePane("list")}>
                          <ArrowLeft size={16} />
                        </button>
                        <div>
                          <p className="eyebrow">空间</p>
                          <h2>空间信息</h2>
                        </div>
                      </div>
                      <div
                        className="workspace-context-tabs space-tabs"
                        role="tablist"
                        aria-label="空间设置"
                        onKeyDown={handleTabListKeyDown}
                      >
                        {[
                          { id: "overview" as const, label: "概览", visible: true },
                          { id: "invites" as const, label: "邀请", visible: workspaceBootstrap.permissions.canCreateMemberInvite },
                          { id: "roles" as const, label: "权限", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite },
                          { id: "visibility" as const, label: "可见范围", visible: workspaceBootstrap.permissions.canManageMemberVisibility },
                          { id: "email" as const, label: "邮件", visible: workspaceBootstrap.permissions.canManageEmailSettings }
                        ].filter((tab) => tab.visible).map((tab) => (
                          <button
                            className={workspaceSpaceTab === tab.id ? "active" : ""}
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={workspaceSpaceTab === tab.id}
                            tabIndex={workspaceSpaceTab === tab.id ? 0 : -1}
                            id={`workspace-space-tab-${tab.id}`}
                            aria-controls={`workspace-space-panel-${tab.id}`}
                            onClick={() => navigateWorkspaceSpaceTab(tab.id)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      {workspaceSpaceTab === "overview" && (
                        <div
                          className="workspace-space-tab-panel page-enter"
                          id="workspace-space-panel-overview"
                          role="tabpanel"
                          aria-labelledby="workspace-space-tab-overview"
                        >
                          <div className="workspace-info-grid">
                            <div>
                              <span>当前身份</span>
                              <strong>{workspaceRoleLabel(workspaceBootstrap.auth.currentUser.role)}</strong>
                              <small>{workspaceBootstrap.auth.currentUser.githubLogin}</small>
                            </div>
                            <div>
                              <span>{workspaceBootstrap.auth.currentUser.role === "owner" ? "成员" : "可见联系人"}</span>
                              <strong>{workspaceBootstrap.members.length} 位</strong>
                              <small>{workspaceBootstrap.auth.currentUser.role === "owner" ? "邀请加入" : "私聊及授权范围"}</small>
                            </div>
                            <div>
                              <span>今日传输额度</span>
                              <strong>{workspaceRemainingText}</strong>
                              <small>{workspaceQuotaDetailText}</small>
                            </div>
                            <div>
                              <span>消息保留</span>
                              <strong>最近 {workspaceBootstrap.policy.messageRetentionCount} 条</strong>
                              <small>按会话保留</small>
                            </div>
                          </div>
                          {workspaceBootstrap.auth.currentUser.role === "owner" && (
                            <section
                              className="workspace-system-statistics"
                              aria-labelledby="workspace-system-statistics-title"
                              aria-busy={workspaceStatisticsLoading}
                            >
                              <div className="workspace-statistics-header">
                                <div>
                                  <h3 id="workspace-system-statistics-title">系统统计</h3>
                                  <p>累计总量与今日新增</p>
                                </div>
                                {workspaceStatisticsError && (
                                  <button className="secondary compact" type="button" onClick={() => void refreshWorkspaceStatistics()}>
                                    重试
                                  </button>
                                )}
                              </div>
                              {workspaceStatistics ? (
                                <div className="workspace-statistics-grid" title={`统计截至 ${formatWorkspaceTime(workspaceStatistics.asOf)}`}>
                                  {[
                                    {
                                      label: "成员",
                                      total: `${workspaceStatistics.totals.members.toLocaleString("zh-CN")} 位`,
                                      today: `今日 +${workspaceStatistics.today.members.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "会话",
                                      total: workspaceStatistics.totals.conversations.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.conversations.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "消息",
                                      total: workspaceStatistics.totals.messages.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.messages.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "文件",
                                      total: workspaceStatistics.totals.files.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.files.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "上传量",
                                      total: formatBytes(workspaceStatistics.totals.uploadedBytes),
                                      today: `今日 +${formatBytes(workspaceStatistics.today.uploadedBytes)}`
                                    }
                                  ].map((metric) => (
                                    <div key={metric.label}>
                                      <span>{metric.label}</span>
                                      <strong>{metric.total}</strong>
                                      <small>{metric.today}</small>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className={workspaceStatisticsError ? "workspace-statistics-status error" : "workspace-statistics-status"} role="status">
                                  {workspaceStatisticsError || "正在读取统计数据..."}
                                </p>
                              )}
                            </section>
                          )}
                          <p className="workspace-space-note">共享空间保存消息和文件，方便成员稍后查看。</p>
                        </div>
                      )}
                      {workspaceSpaceTab === "invites" && workspaceBootstrap.permissions.canCreateMemberInvite && (
                        <section className="workspace-settings-section workspace-space-tab-panel page-enter" id="workspace-space-panel-invites" role="tabpanel" aria-labelledby="workspace-space-tab-invites">
                          <div className="workspace-section-header">
                            <div>
                              <h3>邀请成员</h3>
                              <p>创建一次性成员邀请，并查看每条邀请的使用情况。</p>
                            </div>
                            <button className="secondary" type="button" onClick={() => void createWorkspaceInvite()}>
                              <Plus size={17} />
                              创建成员邀请
                            </button>
                          </div>
                          {workspaceInviteCode && (
                            <div className="copy-box compact-copy">
                              <span>{workspaceInviteCode}</span>
                              <button className="secondary compact" type="button" onClick={() => void copyWorkspaceInviteLink(workspaceInviteCode)}>
                                <Clipboard size={15} />
                                复制
                              </button>
                            </div>
                          )}
                          <dl className="workspace-invite-summary" aria-label="邀请统计">
                            {[
                              ["有效邀请", workspaceBootstrap.inviteSummary.active],
                              ["已加入", workspaceBootstrap.inviteSummary.acceptedUses],
                              ["剩余名额", workspaceBootstrap.inviteSummary.availableUses],
                              ["历史邀请", workspaceBootstrap.inviteSummary.history]
                            ].map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                          {workspaceBootstrap.invites.length > 0 ? (() => {
                            const activeInvites = workspaceBootstrap.invites.filter(canRevokeWorkspaceInvite);
                            const historyInvites = workspaceBootstrap.invites.filter((invite) => !canRevokeWorkspaceInvite(invite));
                            return (
                              <div className="workspace-invite-groups">
                                <section className="workspace-invite-group" aria-labelledby="workspace-active-invites-title">
                                  <div className="workspace-invite-group-heading">
                                    <h4 id="workspace-active-invites-title">有效邀请</h4>
                                    <span>{activeInvites.length}</span>
                                  </div>
                                  {activeInvites.length > 0 ? (
                                    <div className="workspace-invite-list">
                                      {activeInvites.map((invite) => (
                                        <WorkspaceInviteRow invite={invite} key={invite.id} onRevoke={(item) => void revokeWorkspaceInvite(item)} />
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="saved-empty">当前没有生效中的邀请。</p>
                                  )}
                                </section>
                                {historyInvites.length > 0 && (
                                  <details className="workspace-invite-history">
                                    <summary>
                                      <span>历史邀请</span>
                                      <small>{historyInvites.length} 条</small>
                                      <ChevronDown size={16} aria-hidden="true" />
                                    </summary>
                                    <div className="workspace-invite-list">
                                      {historyInvites.map((invite) => (
                                        <WorkspaceInviteRow invite={invite} key={invite.id} onRevoke={(item) => void revokeWorkspaceInvite(item)} />
                                      ))}
                                    </div>
                                  </details>
                                )}
                              </div>
                            );
                          })() : (
                            <p className="saved-empty">还没有邀请记录。</p>
                          )}
                        </section>
                      )}
                      {workspaceSpaceTab === "roles" && workspaceBootstrap.permissions.canCreatePrivilegedInvite && (
                        <section className="workspace-settings-section workspace-space-tab-panel page-enter" id="workspace-space-panel-roles" role="tabpanel" aria-labelledby="workspace-space-tab-roles">
                          <div className="section-title">
                            <span>成员权限</span>
                          </div>
                          <div className="workspace-role-list">
                            {workspaceBootstrap.members.map((member) => (
                              <div className="workspace-role-row" key={member.id}>
                                <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                <span>
                                  <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                  <small>{workspaceMemberSecondaryText(member)}</small>
                                </span>
                                {member.id === workspaceBootstrap.auth.currentUser.id ? (
                                  <em>当前账号</em>
                                ) : member.capabilities?.canManage === false ? (
                                  <em>系统维护</em>
                                ) : (
                                  <span className="workspace-role-actions">
                                    <label>
                                      <span>角色</span>
                                      <select
                                        value={member.role}
                                        onChange={(event) => void updateWorkspaceMemberRole(member, event.target.value as WorkspaceUser["role"])}
                                      >
                                        {WORKSPACE_ROLE_OPTIONS.filter((role) => role !== "auditor" || workspaceBootstrap.permissions.canCreatePrivilegedInvite).map((role) => (
                                          <option value={role} key={role}>
                                            {workspaceRoleLabel(role)}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <button className="secondary compact danger-action" type="button" onClick={() => void removeWorkspaceMember(member)}>
                                      移出
                                    </button>
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {workspaceSpaceTab === "visibility" && workspaceBootstrap.permissions.canManageMemberVisibility && (
                        <section className="workspace-settings-section workspace-visibility-settings workspace-space-tab-panel page-enter" id="workspace-space-panel-visibility" role="tabpanel" aria-labelledby="workspace-space-tab-visibility">
                          <div className="workspace-section-header">
                            <div className="section-title">
                              <span>成员可见范围</span>
                            </div>
                            <button
                              className="primary compact"
                              type="button"
                              disabled={!workspaceMemberVisibility || workspaceVisibilityLoading || workspaceVisibilitySaving}
                              onClick={() => void saveWorkspaceMemberVisibility()}
                            >
                              {workspaceVisibilitySaving ? "保存中" : "保存"}
                            </button>
                          </div>
                          {workspaceVisibilityViewers.length === 0 ? (
                            <p className="saved-empty">当前没有可配置的成员。</p>
                          ) : (
                            <>
                              <label className="workspace-visibility-viewer">
                                <span>查看者</span>
                                <select
                                  value={workspaceVisibilityViewerId}
                                  onChange={(event) => {
                                    setWorkspaceVisibilityViewerId(event.target.value);
                                    setWorkspaceMemberVisibility(null);
                                  }}
                                >
                                  {workspaceVisibilityViewers.map((member) => (
                                    <option value={member.id} key={member.id}>
                                      {member.displayName} · {workspaceMemberRoleLabel(member)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <div className="workspace-visibility-list" aria-busy={workspaceVisibilityLoading}>
                                {workspaceVisibilityLoading || !workspaceMemberVisibility ? (
                                  <p className="saved-empty">正在加载可见范围。</p>
                                ) : (
                                  workspaceBootstrap.members
                                    .filter((member) => member.id !== workspaceVisibilityViewerId)
                                    .map((member) => {
                                      const automatic = workspaceMemberVisibility.automaticUserIds.includes(member.id);
                                      const granted = workspaceMemberVisibility.grantedUserIds.includes(member.id);
                                      return (
                                        <label className="workspace-visibility-row" key={member.id}>
                                          <input
                                            type="checkbox"
                                            checked={automatic || granted}
                                            disabled={automatic || workspaceVisibilitySaving}
                                            onChange={() => toggleWorkspaceVisibilityGrant(member.id)}
                                          />
                                          <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                          <span>
                                            <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                            <small>
                                              {member.description || (automatic ? "已有私聊" : granted ? "已授权" : workspaceMemberSecondaryText(member))}
                                            </small>
                                          </span>
                                        </label>
                                      );
                                    })
                                )}
                              </div>
                            </>
                          )}
                        </section>
                      )}
                      {workspaceSpaceTab === "email" && workspaceBootstrap.permissions.canManageEmailSettings && (
                        <div className="workspace-space-tab-panel page-enter" id="workspace-space-panel-email" role="tabpanel" aria-labelledby="workspace-space-tab-email">
                          <WorkspaceEmailSettingsPanel onNotice={showWorkspaceNotice} />
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {workspaceContextVisible && (
                <WorkspaceContextDrawer label={workspaceContextMode === "file" ? "文件详情" : workspaceContextMode === "member" ? "成员详情" : "当前会话详情"}>
                  <div className="workspace-context-header">
                    <button
                      className="icon-button mobile-only"
                      type="button"
                      title={workspaceContextMode === "file" ? "返回文件" : workspaceContextMode === "member" ? "返回成员" : "返回聊天"}
                      onClick={() => setWorkspaceMobilePane("main")}
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <div className="workspace-context-title">
                      <p className="eyebrow">{workspaceContextMode === "file" ? "文件详情" : workspaceContextMode === "member" ? "成员详情" : workspaceSelectedConversation ? "会话详情" : "空间概览"}</p>
                      <strong>
                        {workspaceContextMode === "file"
                          ? workspaceSelectedFile?.fileName ?? "选择文件"
                          : workspaceContextMode === "member"
                          ? workspaceSelectedMember?.displayName ?? "选择成员"
                          : workspaceSelectedConversation
                          ? workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)
                        : workspaceBootstrap.space.name}
                      </strong>
                    </div>
                    <button className="icon-button desktop-only" type="button" title="收起详情" onClick={() => setWorkspaceContextCollapsed(true)}>
                      <X size={16} />
                    </button>
                  </div>
                  {workspaceContextMode === "file" ? (
                    <div className="workspace-context-body" key={`file-${workspaceSelectedFile?.id ?? "none"}`}>
                      {workspaceSelectedFile ? (
                        <>
                          <div className="workspace-file-detail-head">
                            <FileCheck2 size={22} />
                            <div>
                              <strong title={workspaceSelectedFile.fileName}>{workspaceSelectedFile.fileName}</strong>
                              <small>{workspaceFileScope(workspaceSelectedFile, workspaceConversations)}</small>
                            </div>
                          </div>
                          <div className="workspace-info-grid compact-info">
                            <div>
                              <span>大小</span>
                              <strong>{formatBytes(workspaceSelectedFile.byteSize)}</strong>
                            </div>
                            <div>
                              <span>上传者</span>
                              <strong>{workspaceFileUploaderName(workspaceSelectedFile)}</strong>
                            </div>
                            <div>
                              <span>可见范围</span>
                              <strong>{workspaceFileVisibilityLabel(workspaceSelectedFile)}</strong>
                            </div>
                            {workspaceSelectedFileConversation && (
                              <div>
                                <span>所属会话</span>
                                <strong>{workspaceConversationTitle(workspaceSelectedFileConversation, workspaceBootstrap.auth.currentUser.id)}</strong>
                              </div>
                            )}
                            <div>
                              <span>状态</span>
                              <strong>
                                {workspaceSelectedFile.localUpload?.state === "uploading"
                                  ? "上传中"
                                  : workspaceSelectedFile.localUpload?.state === "failed"
                                  ? "上传失败"
                                  : workspaceSelectedFile.status === "available"
                                  ? "可下载"
                                  : workspaceSelectedFile.status}
                              </strong>
                            </div>
                          </div>
                          <div className="workspace-file-actions">
                            {workspaceSelectedFile.localUpload?.state === "failed" && (
                              <div className="notice warning compact-notice">
                                {workspaceSelectedFile.localUpload.failureReason || "文件上传失败，可以重试。"}
                              </div>
                            )}
                            {workspaceSelectedFileQuotaWarning && (
                              <div className="notice warning compact-notice">
                                {workspaceSelectedFileQuotaWarning}
                              </div>
                            )}
                            {workspaceSelectedFile.localUpload?.state === "failed" ? (
                              <>
                                <button className="primary" type="button" onClick={() => void retryWorkspaceFileUpload(workspaceSelectedFile)}>
                                  <RefreshCw size={17} />
                                  重新上传
                                </button>
                                <button className="secondary danger-action" type="button" onClick={() => removeWorkspaceLocalFile(workspaceSelectedFile)}>
                                  <Trash2 size={17} />
                                  移除记录
                                </button>
                              </>
                            ) : (
                              <button
                                className="primary"
                                type="button"
                                disabled={
                                  !workspaceBootstrap.permissions.canDownload ||
                                  Boolean(workspaceSelectedFileQuotaWarning) ||
                                  workspaceSelectedFile.status !== "available"
                                }
                                onClick={() => void reserveWorkspaceDownload(workspaceSelectedFile)}
                              >
                                <Download size={17} />
                                下载文件
                              </button>
                            )}
                            {workspaceSelectedFileConversation && (
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => {
                                  selectWorkspaceConversation(workspaceSelectedFileConversation.id);
                                  setWorkspaceContextMode("conversation");
                                  setWorkspaceContextCollapsed(false);
                                  setWorkspaceContextTab("files");
                                  setWorkspaceMobilePane("main");
                                }}
                              >
                                <MessageSquare size={17} />
                                打开会话
                              </button>
                            )}
                            {!workspaceSelectedFile.localUpload && canRemoveWorkspaceFile(workspaceSelectedFile, workspaceBootstrap.auth.currentUser) && (
                              <button className="secondary danger-action" type="button" onClick={() => void removeWorkspaceFile(workspaceSelectedFile)}>
                                <Trash2 size={17} />
                                移除文件
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="saved-empty">选择文件后查看详情和下载操作。</p>
                      )}
                    </div>
                  ) : workspaceContextMode === "member" ? (
                    workspaceSelectedMember ? (
                      <WorkspaceMemberDetail
                        member={workspaceSelectedMember}
                        currentUserId={workspaceBootstrap.auth.currentUser.id}
                        canCreateDirect={workspaceBootstrap.permissions.canCreateDirect}
                        onMemberUpdated={upsertWorkspaceMember}
                        onStartDirect={(memberId) => void createWorkspaceDirect(memberId)}
                        onNotice={showWorkspaceNotice}
                      />
                    ) : (
                      <div className="workspace-context-body"><p className="saved-empty">选择成员后查看详情。</p></div>
                    )
                  ) : workspaceSelectedConversation ? (
                    <>
                      <div
                        className="workspace-context-tabs"
                        role="tablist"
                        aria-label="会话详情"
                        onKeyDown={handleTabListKeyDown}
                      >
                        {workspaceVisibleContextTabs.map((tab) => (
                          <button
                            className={workspaceContextTab === tab.id ? "active" : ""}
                            key={tab.id}
                            role="tab"
                            aria-selected={workspaceContextTab === tab.id}
                            tabIndex={workspaceContextTab === tab.id ? 0 : -1}
                            type="button"
                            onClick={() => setWorkspaceContextTab(tab.id)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      {workspaceContextTab === "overview" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-overview`}>
                          <div className="workspace-context-profile">
                            <WorkspaceConversationAvatar
                              conversation={workspaceSelectedConversation}
                              currentUserId={workspaceBootstrap.auth.currentUser.id}
                            />
                            <div>
                              <strong>
                                <WorkspaceIdentityName
                                  name={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                                  kind={workspaceSelectedConversation.otherMember?.kind}
                                />
                              </strong>
                              <small>
                                {workspaceSelectedConversation.type === "group"
                                  ? `${workspaceConversationMemberCount(workspaceSelectedConversation)} 位成员`
                                  : workspaceSelectedConversation.otherMember?.description || "私聊"}
                              </small>
                            </div>
                          </div>
                          <div className="workspace-context-summary">
                            <button type="button" onClick={() => setWorkspaceContextTab("files")}>
                              <span><FileCheck2 size={16} />共享文件</span>
                              <strong>{workspaceConversationFiles.length}</strong>
                            </button>
                            {workspaceSelectedConversation.type === "group" && (
                              <button type="button" onClick={() => setWorkspaceContextTab("members")}>
                                <span><UsersRound size={16} />群聊成员</span>
                                <strong>{workspaceConversationMemberCount(workspaceSelectedConversation)}</strong>
                              </button>
                            )}
                            <div>
                              <span><History size={16} />消息保留</span>
                              <strong>最近 {workspaceSelectedConversation.retentionCount} 条</strong>
                            </div>
                            <div>
                              <span><Radio size={16} />会话提醒</span>
                              <strong>{workspaceNotificationLevelLabel(workspaceSelectedConversation.notificationLevel)}</strong>
                            </div>
                          </div>
                          {workspaceSelectedConversation.type === "group" && (
                            <section className="workspace-pinned-overview" aria-label="常驻消息">
                              <div className="workspace-context-section-header">
                                <span><Pin size={15} />常驻消息</span>
                                <span className="workspace-context-section-actions">
                                  <small>{workspacePinnedMessages.length} 条</small>
                                  {workspacePinnedMessages.length > 3 && (
                                    <button
                                      type="button"
                                      aria-expanded={workspacePinnedMessagesExpanded}
                                      onClick={() => setWorkspacePinsExpandedByConversation((current) => ({
                                        ...current,
                                        [workspaceSelectedConversation.id]: !workspacePinnedMessagesExpanded
                                      }))}
                                    >
                                      {workspacePinnedMessagesExpanded ? "收起" : "查看全部"}
                                    </button>
                                  )}
                                </span>
                              </div>
                              {workspacePinnedMessages.length === 0 ? (
                                <p className="saved-empty">群成员常驻的消息会显示在这里。</p>
                              ) : (
                                <div className="workspace-pinned-list">
                                  {(workspacePinnedMessagesExpanded ? workspacePinnedMessages : workspacePinnedMessages.slice(0, 3)).map((pin) => (
                                    <article key={pin.messageId}>
                                      <button type="button" onClick={() => void openWorkspacePinnedMessage(pin.messageId)}>
                                        <strong>{pin.message.authorName || pin.message.authorGithubLogin || "成员"}</strong>
                                        <span>{pin.message.plainText || "附件消息"}</span>
                                        <small>{formatWorkspaceTime(pin.pinnedAt)}</small>
                                      </button>
                                      {pin.canUnpin && (
                                        <button className="icon-button" type="button" title="取消常驻" onClick={() => void removeWorkspacePin(pin.messageId)}>
                                          <PinOff size={14} />
                                        </button>
                                      )}
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>
                          )}
                        </div>
                      )}
                      {workspaceContextTab === "members" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-members`}>
                          <label className="workspace-search compact-search">
                            <span>查找成员</span>
                            <input
                              value={workspaceContextMemberQuery}
                              onChange={(event) => setWorkspaceContextMemberQuery(event.target.value)}
                              placeholder="昵称、GitHub 或角色"
                            />
                          </label>
                          <div className="member-list">
                            {workspaceConversationMembers.length === 0 ? (
                              <p className="saved-empty">没有找到匹配的群聊成员。</p>
                            ) : (
                              workspaceConversationMembers.map((member) => (
                                <div className="member context-member" key={member.id}>
                                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                  <span>
                                    <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                    <small>{workspaceMemberSecondaryText(member)}</small>
                                  </span>
                                  {(member.id !== workspaceBootstrap.auth.currentUser.id &&
                                    ((workspaceBootstrap.permissions.canCreateDirect && member.capabilities?.canStartDirectConversation === true) ||
                                      (workspaceSelectedConversation.type === "group" && workspaceCanManageSelectedGroup))) && (
                                    <div className="context-member-actions">
                                    {workspaceBootstrap.permissions.canCreateDirect && member.capabilities?.canStartDirectConversation === true && (
                                      <button
                                        className="icon-button"
                                        type="button"
                                        title={`与 ${member.displayName} 私聊`}
                                        aria-label={`与 ${member.displayName} 私聊`}
                                        onClick={() => void createWorkspaceDirect(member.id)}
                                      >
                                        <MessageSquare size={15} />
                                      </button>
                                    )}
                                    {workspaceSelectedConversation.type === "group" && workspaceCanManageSelectedGroup && (
                                      <button
                                        className="secondary compact danger-action"
                                        type="button"
                                        disabled={workspaceGroupMemberBusyId === member.id}
                                        title="移出群聊"
                                        onClick={() => void removeWorkspaceGroupMember(member.id)}
                                      >
                                        <X size={15} />
                                        {workspaceGroupMemberBusyId === member.id ? "处理中" : "移出"}
                                      </button>
                                    )}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                          {workspaceSelectedConversation.type === "group" && workspaceCanManageSelectedGroup && (
                            <div className="workspace-add-member">
                              <div className="section-title">
                                <span>添加成员</span>
                              </div>
                              <div className="workspace-picker-list compact-picker">
                                {workspaceFilteredAddableMembers.length === 0 ? (
                                  <p className="saved-empty">当前没有可添加的成员。</p>
                                ) : (
                                  workspaceFilteredAddableMembers.slice(0, 6).map((member) => (
                                    <button
                                      className="workspace-picker-row"
                                      type="button"
                                      key={member.id}
                                      disabled={workspaceGroupMemberBusyId === member.id}
                                      onClick={() => void addWorkspaceGroupMember(member.id)}
                                    >
                                      <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                      <span>
                                        <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                        <small>{workspaceMemberSecondaryText(member)}</small>
                                      </span>
                                      {workspaceGroupMemberBusyId === member.id ? <RefreshCw size={15} /> : <Plus size={15} />}
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {workspaceContextTab === "files" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-files`}>
                          <div className="workspace-file-subnav context-file-subnav">
                            <WorkspaceFileCategoryTabs value={workspaceContextFileCategory} onChange={setWorkspaceContextFileCategory} />
                            {workspaceContextFileCategory === "media" && (
                              <WorkspaceFileViewToggle value={workspaceContextFileViewMode} onChange={setWorkspaceContextFileViewMode} />
                            )}
                          </div>
                          <div className={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"
                            ? "workspace-file-list media-grid"
                            : "workspace-file-list"}>
                            {workspaceFilteredConversationFiles.length === 0 ? (
                              <p className="saved-empty">此会话暂无文件。</p>
                            ) : (
                              workspaceFilteredConversationFiles.map((file) => (
                                <button
                                  className={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"
                                    ? "workspace-file media-card"
                                    : "workspace-file"}
                                  type="button"
                                  key={file.id}
                                  onClick={() => {
                                    setWorkspaceSelectedFileId(file.id);
                                    setWorkspaceView("files");
                                    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: file.id }));
                                    setWorkspaceContextMode("file");
                                    setWorkspaceContextCollapsed(false);
                                    setWorkspaceMobilePane("details");
                                  }}
                                >
                                  <WorkspaceFileThumbnail
                                    file={file}
                                    compact={workspaceContextFileViewMode !== "grid"}
                                    large={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"}
                                  />
                                  <span>
                                    <strong>{file.fileName}</strong>
                                    <small>{formatBytes(file.byteSize)} · {workspaceFileUploaderName(file)}</small>
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                      {workspaceContextTab === "settings" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-settings`}>
                          <p className="saved-empty">此会话保留最近 {workspaceSelectedConversation.retentionCount} 条消息。</p>
                          <div className="workspace-settings-section">
                            <div className="workspace-section-header">
                              <span>会话提醒</span>
                            </div>
                            <div
                              className="workspace-filter-tabs notification-tabs"
                              role="tablist"
                              aria-label="会话提醒设置"
                              onKeyDown={handleTabListKeyDown}
                            >
                              {(["all", "mentions", "muted"] as WorkspaceNotificationLevel[]).map((level) => (
                                <button
                                  className={(workspaceSelectedConversation.notificationLevel ?? "all") === level ? "active" : ""}
                                  key={level}
                                  type="button"
                                  role="tab"
                                  aria-selected={(workspaceSelectedConversation.notificationLevel ?? "all") === level}
                                  tabIndex={(workspaceSelectedConversation.notificationLevel ?? "all") === level ? 0 : -1}
                                  onClick={() => void updateWorkspaceConversationNotification(level)}
                                >
                                  {workspaceNotificationLevelLabel(level)}
                                </button>
                              ))}
                            </div>
                            <p className="saved-empty">
                              {workspaceNotificationLevelDescription(workspaceSelectedConversation.notificationLevel)}
                            </p>
                          </div>
                          {workspaceSelectedConversation.type === "group" ? (
                            <>
                              {workspaceCanManageSelectedGroup ? (
                                <form className="workspace-group-form" onSubmit={(event) => void renameWorkspaceGroup(event)}>
                                  <WorkspaceGroupAvatarEditor
                                    value={workspaceGroupAvatarEmoji}
                                    onChange={setWorkspaceGroupAvatarEmoji}
                                    label="群头像"
                                  />
                                  <label>
                                    <span>群聊名称</span>
                                    <input
                                      value={workspaceGroupRenameTitle}
                                      onChange={(event) => setWorkspaceGroupRenameTitle(event.target.value)}
                                      placeholder="输入群聊名称"
                                    />
                                  </label>
                                  <button
                                    className="secondary"
                                    type="submit"
                                    disabled={normalizeWorkspaceGroupAvatarEmoji(workspaceGroupAvatarEmoji) === null}
                                  >
                                    <Check size={16} />
                                    保存群资料
                                  </button>
                                  <p className="saved-empty">群聊成员管理在“成员”中进行。</p>
                                </form>
                              ) : (
                                <p className="saved-empty">群聊成员和名称由空间管理员维护。</p>
                              )}
                              <button className="secondary danger-action" type="button" onClick={() => void leaveWorkspaceGroup()}>
                                <LogOut size={16} />
                                离开群聊
                              </button>
                            </>
                          ) : (
                            <p className="saved-empty">私聊会复用同一对成员的会话。</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="workspace-context-body" key="conversation-none">
                      <p className="saved-empty">选择会话后可查看概览、成员和文件。</p>
                    </div>
                  )}
                </WorkspaceContextDrawer>
                )}
              </WorkspaceShell>
              <nav className="workspace-mobile-nav" aria-label="共享空间移动导航">
                {[
                  { id: "chat" as const, label: "聊天", icon: <MessageSquare size={19} /> },
                  { id: "files" as const, label: "文件", icon: <FileCheck2 size={19} /> },
                  { id: "members" as const, label: "成员", icon: <UsersRound size={19} /> },
                  { id: "space" as const, label: "空间", icon: <Settings size={19} /> }
                ].map((item) => (
                  <button
                    className={workspaceView === item.id ? "active" : ""}
                    key={item.id}
                    type="button"
                    aria-current={workspaceView === item.id ? "page" : undefined}
                    aria-controls="workspace-main-panel"
                    onClick={() => {
                      navigateWorkspaceView(item.id);
                      setWorkspaceMobilePane(item.id === "chat" ? "list" : "main");
                      setWorkspaceCreateMode("");
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>
              {workspaceImagePreview && (
                <div
                  ref={workspaceImageViewerRef}
                  className="workspace-image-viewer"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="workspace-image-viewer-title"
                  aria-describedby="workspace-image-viewer-description"
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setWorkspaceImagePreview(null);
                  }}
                  onClick={(event) => {
                    if (event.currentTarget === event.target) setWorkspaceImagePreview(null);
                  }}
                >
                  <p className="sr-only" id="workspace-image-viewer-description">
                    图片预览，可下载图片或打开文件详情。
                  </p>
                  <div className="workspace-image-viewer-toolbar">
                    <strong id="workspace-image-viewer-title">{workspaceImagePreview.fileName}</strong>
                    <div>
                      {workspaceImagePreviewFile && (
                        <>
                          <button
                            className="icon-button"
                            type="button"
                            title="下载图片"
                            onClick={() => void reserveWorkspaceDownload(workspaceImagePreviewFile)}
                          >
                            <Download size={17} />
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            title="查看文件详情"
                            onClick={() => {
                              setWorkspaceImagePreview(null);
                              openWorkspaceAttachmentFile(workspaceImagePreview);
                            }}
                          >
                            <FileCheck2 size={17} />
                          </button>
                        </>
                      )}
                      <button
                        ref={workspaceImageCloseButtonRef}
                        className="icon-button"
                        type="button"
                        title="关闭预览"
                        onClick={() => setWorkspaceImagePreview(null)}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <img
                    src={`/api/workspace/files/${encodeURIComponent(workspaceImagePreview.id)}/preview`}
                    alt={workspaceImagePreview.fileName}
                  />
                </div>
              )}
            </>
          )}
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

function normalizeWsChatPayload(value: unknown): P2pMessageEnvelope | null {
  const envelope = parseDataEnvelopeValue(value);
  return envelope?.kind === "chat" || envelope?.kind === "chat-ack" ? envelope : null;
}

function WorkspaceSwitch({
  checked,
  disabled = false,
  label,
  description,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className="workspace-setting-switch"
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="workspace-setting-switch-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <span className="workspace-setting-switch-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function WorkspaceAccountSettings({
  currentUser,
  onBack,
  onUserUpdated,
  onNotice
}: {
  currentUser: WorkspaceUser;
  onBack: () => void;
  onUserUpdated: (user: WorkspaceUser) => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
}) {
  const [nickname, setNickname] = useState(currentUser.nickname ?? "");
  const [recallReason, setRecallReason] = useState(currentUser.recallReason ?? "内容有误");
  const [searchDiscoverable, setSearchDiscoverable] = useState(Boolean(currentUser.searchDiscoverable));
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [recallReasonSaving, setRecallReasonSaving] = useState(false);
  const [discoverySaving, setDiscoverySaving] = useState(false);
  const [emoteSettings, setEmoteSettings] = useState<WorkspaceEmoteSettings | null>(null);
  const [emoteSettingsLoading, setEmoteSettingsLoading] = useState(true);
  const [emoteSettingsSaving, setEmoteSettingsSaving] = useState(false);
  const [notifications, setNotifications] = useState<WorkspaceNotificationPreferences | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsSaving, setNotificationsSaving] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [ntfy, setNtfy] = useState<WorkspaceNtfyPreferences | null>(null);
  const [ntfyLoading, setNtfyLoading] = useState(true);
  const [ntfySaving, setNtfySaving] = useState(false);
  const [ntfyHelpOpen, setNtfyHelpOpen] = useState(false);
  const [ntfyRotateConfirm, setNtfyRotateConfirm] = useState(false);
  const ntfyHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const ntfyDialogRef = useRef<HTMLDivElement>(null);
  const ntfyDialogCloseRef = useRef<HTMLButtonElement>(null);
  const lastSavedNicknameRef = useRef(currentUser.nickname ?? "");
  const nicknameSaveSequenceRef = useRef(0);
  const lastSavedRecallReasonRef = useRef(currentUser.recallReason ?? "内容有误");
  const recallReasonSaveSequenceRef = useRef(0);

  useEffect(() => {
    setNickname(currentUser.nickname ?? "");
    setRecallReason(currentUser.recallReason ?? "内容有误");
    setSearchDiscoverable(Boolean(currentUser.searchDiscoverable));
    lastSavedNicknameRef.current = currentUser.nickname ?? "";
    lastSavedRecallReasonRef.current = currentUser.recallReason ?? "内容有误";
  }, [currentUser.id]);

  useEffect(() => {
    const normalizedNickname = nickname.trim();
    if (normalizedNickname === lastSavedNicknameRef.current) return;
    const saveSequence = nicknameSaveSequenceRef.current + 1;
    nicknameSaveSequenceRef.current = saveSequence;
    const timer = window.setTimeout(() => {
      setProfileSaving(true);
      void workspaceJson<{ user: WorkspaceUser }>("/api/workspace/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ nickname: normalizedNickname || null })
      })
        .then((data) => {
          if (nicknameSaveSequenceRef.current !== saveSequence) return;
          lastSavedNicknameRef.current = data.user.nickname ?? "";
          setNickname(data.user.nickname ?? "");
          onUserUpdated(data.user);
        })
        .catch((error) => {
          if (nicknameSaveSequenceRef.current === saveSequence) {
            onNotice("warning", userFacingErrorMessage(error, "公开昵称保存失败"));
          }
        })
        .finally(() => {
          if (nicknameSaveSequenceRef.current === saveSequence) setProfileSaving(false);
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [currentUser.id, nickname]);

  useEffect(() => {
    const normalizedReason = recallReason.trim();
    if (!normalizedReason || normalizedReason === lastSavedRecallReasonRef.current) return;
    const saveSequence = recallReasonSaveSequenceRef.current + 1;
    recallReasonSaveSequenceRef.current = saveSequence;
    const timer = window.setTimeout(() => {
      setRecallReasonSaving(true);
      void workspaceJson<{ user: WorkspaceUser }>("/api/workspace/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ recallReason: normalizedReason })
      })
        .then((data) => {
          if (recallReasonSaveSequenceRef.current !== saveSequence) return;
          const savedReason = data.user.recallReason ?? "内容有误";
          lastSavedRecallReasonRef.current = savedReason;
          setRecallReason(savedReason);
          onUserUpdated(data.user);
        })
        .catch((error) => {
          if (recallReasonSaveSequenceRef.current === saveSequence) {
            onNotice("warning", userFacingErrorMessage(error, "撤回文案保存失败"));
          }
        })
        .finally(() => {
          if (recallReasonSaveSequenceRef.current === saveSequence) setRecallReasonSaving(false);
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [currentUser.id, recallReason]);

  useEffect(() => {
    let cancelled = false;
    setEmoteSettingsLoading(true);
    void workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings")
      .then((data) => {
        if (!cancelled) setEmoteSettings(data.settings);
      })
      .catch((error) => {
        if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "表情设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setEmoteSettingsLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    setNotificationsLoading(true);
    void workspaceJson<{ notifications: WorkspaceNotificationPreferences }>("/api/workspace/me/notifications")
      .then((data) => {
        if (!cancelled) setNotifications(data.notifications);
      })
      .catch((error) => {
        if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "通知设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setNotificationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    setNtfyLoading(true);
    void workspaceJson<{ ntfy: WorkspaceNtfyPreferences }>("/api/workspace/me/ntfy")
      .then((data) => {
        if (!cancelled) setNtfy(data.ntfy);
      })
      .catch((error) => {
        if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "ntfy 设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setNtfyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id]);

  useEffect(() => {
    if (!ntfyHelpOpen || !ntfyDialogRef.current) return;
    const dialog = ntfyDialogRef.current;
    const root = document.getElementById("root");
    const previousRootInert = root?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => ntfyDialogCloseRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNtfyHelpOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (root) root.inert = previousRootInert;
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => ntfyHelpTriggerRef.current?.focus());
    };
  }, [ntfyHelpOpen]);

  async function updateSearchDiscoverable(nextValue: boolean) {
    const previousValue = searchDiscoverable;
    setSearchDiscoverable(nextValue);
    setDiscoverySaving(true);
    try {
      const data = await workspaceJson<{ user: WorkspaceUser }>("/api/workspace/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ searchDiscoverable: nextValue })
      });
      onUserUpdated(data.user);
      setSearchDiscoverable(Boolean(data.user.searchDiscoverable));
    } catch (error) {
      setSearchDiscoverable(previousValue);
      onNotice("warning", userFacingErrorMessage(error, "搜索可见性保存失败"));
    } finally {
      setDiscoverySaving(false);
    }
  }

  async function uploadAvatar(blob: Blob) {
    setAvatarSaving(true);
    try {
      const response = await workspaceFetch("/api/workspace/me/avatar", {
        method: "PUT",
        headers: { "content-type": "image/webp" },
        body: blob
      });
      const data = await response.json() as { user: WorkspaceUser };
      onUserUpdated(data.user);
      onNotice("success", "头像已更新");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "头像更新失败"));
    } finally {
      setAvatarSaving(false);
    }
  }

  async function deleteAvatar() {
    setAvatarSaving(true);
    try {
      const data = await workspaceJson<{ user: WorkspaceUser }>("/api/workspace/me/avatar", { method: "DELETE" });
      onUserUpdated(data.user);
      onNotice("success", "已恢复 GitHub 头像");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "头像恢复失败"));
    } finally {
      setAvatarSaving(false);
    }
  }

  async function updateNotifications(patch: Partial<Pick<WorkspaceNotificationPreferences, "enabled" | "immediateEnabled" | "digestEnabled">>) {
    if (!notifications) return;
    const previous = notifications;
    const optimistic = { ...notifications, ...patch };
    setNotifications(optimistic);
    setNotificationsSaving(true);
    try {
      const data = await workspaceJson<{ notifications: WorkspaceNotificationPreferences }>("/api/workspace/me/notifications", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: optimistic.enabled,
          immediateEnabled: optimistic.immediateEnabled,
          digestEnabled: optimistic.digestEnabled
        })
      });
      setNotifications(data.notifications);
    } catch (error) {
      setNotifications(previous);
      onNotice("warning", userFacingErrorMessage(error, "通知偏好保存失败"));
    } finally {
      setNotificationsSaving(false);
    }
  }

  async function updateEmoteSettings(packId: WorkspaceEmoteSettings["availablePacks"][number]["id"], enabled: boolean) {
    if (!emoteSettings) return;
    const previous = emoteSettings;
    const nextEnabledPackIds = enabled
      ? [...emoteSettings.enabledPackIds, packId]
      : emoteSettings.enabledPackIds.filter((id) => id !== packId);
    setEmoteSettings({ ...emoteSettings, enabledPackIds: nextEnabledPackIds });
    setEmoteSettingsSaving(true);
    try {
      const data = await workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings", {
        method: "PUT",
        body: JSON.stringify({ enabledPackIds: nextEnabledPackIds })
      });
      setEmoteSettings(data.settings);
    } catch (error) {
      setEmoteSettings(previous);
      onNotice("warning", userFacingErrorMessage(error, "表情设置保存失败"));
    } finally {
      setEmoteSettingsSaving(false);
    }
  }

  async function sendEmailChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ challengeId: string; pendingEmail: string }>(
        "/api/workspace/me/notification-email/challenges",
        { method: "POST", body: JSON.stringify({ email: pendingEmail }) }
      );
      setChallengeId(data.challengeId);
      setVerificationCode("");
      onNotice("success", `验证码已发送至 ${data.pendingEmail}`);
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "验证码发送失败"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function verifyEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ notifications: WorkspaceNotificationPreferences }>(
        "/api/workspace/me/notification-email/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code: verificationCode }) }
      );
      setNotifications(data.notifications);
      setChallengeId("");
      setPendingEmail("");
      setVerificationCode("");
      onNotice("success", "通知邮箱已验证并启用");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "邮箱验证失败"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function useGitHubEmail() {
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ notifications: WorkspaceNotificationPreferences }>(
        "/api/workspace/me/notification-email/use-github",
        { method: "POST" }
      );
      setNotifications(data.notifications);
      setChallengeId("");
      onNotice("success", "已恢复使用 GitHub 邮箱");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "无法使用 GitHub 邮箱"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function updateNtfy(enabled: boolean) {
    if (!ntfy) return;
    const previous = ntfy;
    setNtfy({ ...ntfy, enabled });
    setNtfySaving(true);
    try {
      const data = await workspaceJson<{ ntfy: WorkspaceNtfyPreferences }>("/api/workspace/me/ntfy", {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      setNtfy(data.ntfy);
    } catch (error) {
      setNtfy(previous);
      onNotice("warning", userFacingErrorMessage(error, "ntfy 设置保存失败"));
    } finally {
      setNtfySaving(false);
    }
  }

  async function rotateNtfyTopic() {
    setNtfySaving(true);
    try {
      const data = await workspaceJson<{ ntfy: WorkspaceNtfyPreferences }>("/api/workspace/me/ntfy/rotate", {
        method: "POST"
      });
      setNtfy(data.ntfy);
      setNtfyRotateConfirm(false);
      onNotice("success", "topic 已刷新，旧 topic 已失效，请在 ntfy 中重新订阅");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "topic 刷新失败"));
    } finally {
      setNtfySaving(false);
    }
  }

  async function copyNtfyValue(value: string, label: string) {
    const copied = await copyText(value);
    onNotice(copied ? "success" : "warning", copied ? `${label}已复制` : `${label}复制失败`);
  }

  return (
    <>
    <div className="workspace-content-panel workspace-account-panel">
      <div className="workspace-panel-header">
        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <div>
          <p className="eyebrow">个人</p>
          <h2>个人设置</h2>
        </div>
      </div>
      <section className="workspace-preference-section">
        <div className="workspace-section-header">
          <div>
            <h3>公开资料</h3>
            <p>头像和昵称会显示在所有登录后的共享空间界面。</p>
          </div>
          {(profileSaving || recallReasonSaving || discoverySaving) && <span className="workspace-auto-save-state">正在保存...</span>}
        </div>
        <WorkspaceAvatarEditor
          name={currentUser.displayName}
          avatarUrl={currentUser.avatarUrl}
          busy={avatarSaving}
          onUpload={uploadAvatar}
          onDelete={deleteAvatar}
          onError={(message) => onNotice("warning", message)}
        />
        <div className="workspace-settings-grid">
          <label>
            <span>公开昵称</span>
            <input value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder={currentUser.githubLogin || "输入昵称"} />
          </label>
          <div className="workspace-readonly-field">
            <span>GitHub 账号</span>
            <strong>@{currentUser.githubLogin}</strong>
          </div>
          <label className="workspace-recall-setting">
            <span>撤回文案</span>
            <span className="workspace-recall-input">
              <span>你因</span>
              <input
                value={recallReason}
                maxLength={16}
                onChange={(event) => setRecallReason(event.target.value)}
                onBlur={() => {
                  if (!recallReason.trim()) setRecallReason(lastSavedRecallReasonRef.current);
                }}
                aria-label="自定义撤回原因"
              />
              <span>撤回了一条消息</span>
            </span>
            <small>1 至 16 个字符；只影响你之后撤回的消息。</small>
          </label>
        </div>
        <div className="workspace-setting-list">
          <WorkspaceSwitch
            checked={searchDiscoverable}
            disabled={discoverySaving}
            label="允许其他成员搜索到我"
            description="开启后，其他成员可以通过公开昵称或 GitHub 登录名找到你并发起私聊。"
            onChange={(checked) => void updateSearchDiscoverable(checked)}
          />
        </div>
      </section>

      <section className="workspace-preference-section" aria-busy={emoteSettingsLoading}>
        <div className="workspace-section-header">
          <div>
            <h3>表情面板</h3>
            <p>选择聊天时显示的表情包；收藏表情始终保留独立入口。</p>
          </div>
          {emoteSettingsSaving && <span className="workspace-auto-save-state">正在保存...</span>}
        </div>
        {emoteSettingsLoading || !emoteSettings ? (
          <p className="workspace-form-status">正在读取表情设置...</p>
        ) : (
          <div className="workspace-emote-pack-settings">
            {emoteSettings.availablePacks.map((pack) => {
              const checked = emoteSettings.enabledPackIds.includes(pack.id);
              const onlyEnabled = checked && emoteSettings.enabledPackIds.length <= emoteSettings.minimumEnabled;
              return (
                <button
                  key={pack.id}
                  type="button"
                  aria-pressed={checked}
                  disabled={emoteSettingsSaving || onlyEnabled}
                  onClick={() => void updateEmoteSettings(pack.id, !checked)}
                >
                  <span className="workspace-emote-pack-check" aria-hidden="true">{checked && <Check size={14} />}</span>
                  <span>{pack.label}</span>
                </button>
              );
            })}
            <small>至少保留一个表情包。收藏表情可在聊天表情面板中上传、使用和删除。</small>
          </div>
        )}
      </section>

      <section className="workspace-preference-section workspace-notification-settings" aria-busy={notificationsLoading || ntfyLoading}>
        <div className="workspace-section-header">
          <div>
            <h3>通知</h3>
            <p>集中管理邮件与 ntfy 推送；两种渠道都遵循会话免打扰规则。</p>
          </div>
          {(notificationsSaving || ntfySaving) && <span className="workspace-auto-save-state">正在保存...</span>}
        </div>
        {notificationsLoading || !notifications ? (
          <p className="workspace-form-status">正在读取通知设置...</p>
        ) : (
          <div className="workspace-notification-groups">
            <WorkspaceSwitch
              checked={notifications.enabled}
              disabled={notificationsSaving}
              label="接受邮件通知"
              description={notifications.maskedEmail || "尚未设置可用邮箱"}
              onChange={(checked) => void updateNotifications({ enabled: checked })}
            />
            {notifications.enabled && (
              <div className="workspace-notification-children">
                <div className="workspace-notification-email-head">
                  <span>邮件只说明存在未读消息，不包含聊天内容或附件信息。</span>
                  {notifications.emailSource === "custom" && notifications.githubEmail && (
                    <button className="secondary compact" type="button" disabled={emailBusy} onClick={() => void useGitHubEmail()}>
                      使用 GitHub 邮箱
                    </button>
                  )}
                </div>
                {!notifications.mailAvailable && (
                  <p className="workspace-form-status">空间邮件服务尚未启用。偏好会保留，但暂时不会发信。</p>
                )}
                <form className="workspace-inline-form" onSubmit={sendEmailChallenge}>
                  <label>
                    <span>更换邮箱</span>
                    <input type="email" value={pendingEmail} onChange={(event) => setPendingEmail(event.target.value)} placeholder="name@example.com" required />
                  </label>
                  <button className="secondary" type="submit" disabled={emailBusy || !notifications.mailAvailable}>
                    <Mail size={16} />
                    发送验证码
                  </button>
                </form>
                {challengeId && (
                  <form className="workspace-inline-form" onSubmit={verifyEmail}>
                    <label>
                      <span>6 位验证码</span>
                      <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ""))} required />
                    </label>
                    <button className="primary" type="submit" disabled={emailBusy || verificationCode.length !== 6}>验证邮箱</button>
                  </form>
                )}
                <div className="workspace-setting-list compact-list">
                  <WorkspaceSwitch
                    checked={notifications.immediateEnabled}
                    disabled={notificationsSaving}
                    label="每条消息都通知我"
                    description="所有设备离线且消息 60 秒后仍未读时发送。"
                    onChange={(checked) => void updateNotifications({ immediateEnabled: checked })}
                  />
                  <WorkspaceSwitch
                    checked={notifications.digestEnabled}
                    disabled={notificationsSaving}
                    label="超过 2 小时仍未读时通知我"
                    description="跨会话汇总，每个未读周期只发送一次。"
                    onChange={(checked) => void updateNotifications({ digestEnabled: checked })}
                  />
                </div>
              </div>
            )}
            <div className="workspace-notification-channel-row">
              {ntfyLoading || !ntfy ? (
                <p className="workspace-form-status">正在读取 ntfy 设置...</p>
              ) : (
                <WorkspaceSwitch
                  checked={ntfy.enabled}
                  disabled={ntfySaving}
                  label="接受 ntfy 通知"
                  description="通过独立 topic 接收不含正文的推送。"
                  onChange={(checked) => void updateNtfy(checked)}
                />
              )}
              <button
                ref={ntfyHelpTriggerRef}
                className="secondary compact"
                type="button"
                disabled={!ntfy}
                aria-haspopup="dialog"
                onClick={() => setNtfyHelpOpen(true)}
              >
                使用说明
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
    {ntfyHelpOpen && ntfy && createPortal(
      <div className="workspace-ntfy-dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setNtfyHelpOpen(false);
      }}>
        <div
          ref={ntfyDialogRef}
          className="workspace-ntfy-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-ntfy-dialog-title"
          aria-describedby="workspace-ntfy-dialog-description"
          tabIndex={-1}
        >
          <header>
            <div>
              <p className="eyebrow">移动推送</p>
              <h3 id="workspace-ntfy-dialog-title">订阅 ntfy 通知</h3>
            </div>
            <button ref={ntfyDialogCloseRef} className="icon-button" type="button" aria-label="关闭 ntfy 使用说明" title="关闭" onClick={() => setNtfyHelpOpen(false)}>
              <X size={18} />
            </button>
          </header>
          <p id="workspace-ntfy-dialog-description" className="workspace-ntfy-dialog-intro">
            在 ntfy 客户端添加新订阅，填写下方 topic，并选择“使用其他服务器”。
          </p>
          <ol className="workspace-ntfy-steps">
            <li><span>1</span><p>安装并打开 ntfy，点击“订阅主题”。</p></li>
            <li><span>2</span><p>将“我的 topic”粘贴到主题名称。</p></li>
            <li><span>3</span><p>启用“使用其他服务器”，粘贴服务器地址后订阅。</p></li>
          </ol>
          <div className="workspace-ntfy-copy-list">
            <div>
              <span>ntfy 服务器</span>
              <code>{ntfy.serverUrl}</code>
              <button className="icon-button" type="button" title="复制服务器地址" aria-label="复制 ntfy 服务器地址" onClick={() => void copyNtfyValue(ntfy.serverUrl, "服务器地址")}><Copy size={16} /></button>
            </div>
            <div>
              <span>我的 topic</span>
              <code>{ntfy.topic}</code>
              <button className="icon-button" type="button" title="复制 topic" aria-label="复制我的 ntfy topic" onClick={() => void copyNtfyValue(ntfy.topic, "topic")}><Copy size={16} /></button>
            </div>
          </div>
          <div className="workspace-ntfy-warning" role="note">
            <LockKeyhole size={18} />
            <p><strong>不要分享 topic。</strong>知道该字符串的人可能订阅你的通知。怀疑泄露时，请回到此页刷新 topic。</p>
          </div>
          {ntfyRotateConfirm ? (
            <div className="workspace-ntfy-rotate-confirm" role="group" aria-label="确认刷新 topic">
              <p>刷新后旧 topic 立即失效，现有客户端需要重新订阅。</p>
              <button className="secondary compact" type="button" disabled={ntfySaving} onClick={() => setNtfyRotateConfirm(false)}>取消</button>
              <button className="secondary compact danger-action" type="button" disabled={ntfySaving} onClick={() => void rotateNtfyTopic()}>
                {ntfySaving ? "刷新中" : "确认刷新"}
              </button>
            </div>
          ) : (
            <button className="workspace-ntfy-rotate" type="button" onClick={() => setNtfyRotateConfirm(true)}>
              <RefreshCw size={15} />
              刷新我的 topic 字符串
            </button>
          )}
          <div className="workspace-ntfy-downloads">
            <a className="secondary" href="https://ntfy.sh/" target="_blank" rel="noopener noreferrer">
              <BellRing size={16} />
              查看 ntfy 下载指引
              <ExternalLink size={14} />
            </a>
            <a className="secondary" href="https://f-droid.org/repo/io.heckel.ntfy_63.apk" target="_blank" rel="noopener noreferrer">
              <Download size={16} />
              如果您的安卓设备无法访问 Google Play，点此直接下载 ntfy 安装包
            </a>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}

function WorkspaceMemberDetail({
  member,
  currentUserId,
  canCreateDirect,
  onMemberUpdated,
  onStartDirect,
  onNotice
}: {
  member: WorkspaceUser;
  currentUserId: string;
  canCreateDirect: boolean;
  onMemberUpdated: (member: WorkspaceUser) => void;
  onStartDirect: (memberId: string) => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
}) {
  const [remark, setRemark] = useState(member.remark ?? "");
  const [saving, setSaving] = useState(false);
  const canRemark = member.kind === "human" && member.id !== currentUserId;

  useEffect(() => {
    setRemark(member.remark ?? "");
  }, [member.id, member.remark]);

  async function saveRemark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRemark) return;
    setSaving(true);
    try {
      const path = `/api/workspace/members/${encodeURIComponent(member.id)}/remark`;
      const data = await workspaceJson<{ member: WorkspaceUser }>(path, remark.trim()
        ? { method: "PUT", body: JSON.stringify({ remark: remark.trim() }) }
        : { method: "DELETE" });
      onMemberUpdated(data.member);
      setRemark(data.member.remark ?? "");
      onNotice("success", remark.trim() ? "成员备注已保存" : "成员备注已移除");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "成员备注保存失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="workspace-context-body workspace-member-detail">
      <div className="workspace-context-profile">
        <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
        <div>
          <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
          <small>{member.description || workspaceMemberRoleLabel(member)}</small>
        </div>
      </div>
      <dl className="workspace-member-facts">
        {member.remark && <div><dt>我的备注</dt><dd>{member.remark}</dd></div>}
        <div><dt>公开昵称</dt><dd>{member.nickname || "未设置"}</dd></div>
        {member.githubLogin && <div><dt>GitHub 账号</dt><dd>@{member.githubLogin}</dd></div>}
        <div><dt>空间身份</dt><dd>{workspaceMemberRoleLabel(member)}</dd></div>
      </dl>
      {canRemark && (
        <form className="workspace-remark-form" onSubmit={saveRemark}>
          <label>
            <span>私人备注</span>
            <input value={remark} maxLength={32} onChange={(event) => setRemark(event.target.value)} placeholder={member.nickname || member.githubLogin || "输入备注"} />
          </label>
          <button className="secondary" type="submit" disabled={saving || (!member.remark && !remark.trim())}>
            {saving ? "保存中" : remark.trim() || !member.remark ? "保存备注" : "移除备注"}
          </button>
        </form>
      )}
      {member.id !== currentUserId && canCreateDirect && member.capabilities?.canStartDirectConversation && (
        <button className="primary" type="button" onClick={() => onStartDirect(member.id)}>
          <MessageSquare size={16} />
          发起私聊
        </button>
      )}
    </div>
  );
}

function WorkspaceEmailSettingsPanel({ onNotice }: { onNotice: (tone: WorkspaceNotice["tone"], text: string) => void }) {
  const [settings, setSettings] = useState<WorkspaceEmailSettings | null>(null);
  const [draft, setDraft] = useState({
    enabled: false,
    smtpHost: "",
    smtpPort: 587,
    encryption: "starttls" as WorkspaceEmailSettings["encryption"],
    username: "",
    password: "",
    fromAddress: "",
    fromName: "DualLane"
  });
  const [testProof, setTestProof] = useState("");
  const [testedRecipient, setTestedRecipient] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "test" | "save">("");

  useEffect(() => {
    let cancelled = false;
    void workspaceJson<{ settings: WorkspaceEmailSettings }>("/api/workspace/settings/email")
      .then((data) => {
        if (cancelled) return;
        setSettings(data.settings);
        setDraft({
          enabled: data.settings.enabled,
          smtpHost: data.settings.smtpHost,
          smtpPort: data.settings.smtpPort,
          encryption: data.settings.encryption,
          username: data.settings.username,
          password: "",
          fromAddress: data.settings.fromAddress,
          fromName: data.settings.fromName
        });
      })
      .catch((error) => {
        if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "邮件配置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function updateDraft<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setTestProof("");
    setTestedRecipient("");
  }

  async function testSettings() {
    setBusy("test");
    try {
      const data = await workspaceJson<{ testProof: string; recipient: string; testedAt: string }>("/api/workspace/settings/email/test", {
        method: "POST",
        body: JSON.stringify(draft)
      });
      setTestProof(data.testProof);
      setTestedRecipient(data.recipient);
      setSettings((current) => current ? { ...current, lastTestedAt: data.testedAt, lastTestStatus: "success", lastTestErrorCode: null } : current);
      onNotice("success", "测试邮件发送成功，当前配置可保存");
    } catch (error) {
      setTestProof("");
      onNotice("warning", userFacingErrorMessage(error, "测试邮件发送失败"));
    } finally {
      setBusy("");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    try {
      const data = await workspaceJson<{ settings: WorkspaceEmailSettings }>("/api/workspace/settings/email", {
        method: "PUT",
        body: JSON.stringify({ ...draft, testProof })
      });
      setSettings(data.settings);
      setDraft((current) => ({ ...current, password: "" }));
      setTestProof("");
      setTestedRecipient("");
      onNotice("success", data.settings.enabled ? "空间邮件通知已启用" : "邮件配置已保存并停用");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "邮件配置保存失败"));
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return <section className="workspace-settings-section" aria-busy="true"><p className="workspace-form-status">正在读取邮件配置...</p></section>;
  }

  return (
    <form className="workspace-settings-section workspace-email-settings" onSubmit={saveSettings}>
      <div className="workspace-section-header">
        <div>
          <h3>邮件服务</h3>
          <p>SMTP 凭据加密保存。启用配置前必须先发送测试邮件。</p>
        </div>
        <label className="workspace-switch">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} />
          <span>启用</span>
        </label>
      </div>
      <div className="workspace-settings-grid three-columns">
        <label><span>SMTP 服务器</span><input value={draft.smtpHost} onChange={(event) => updateDraft("smtpHost", event.target.value)} placeholder="smtp.example.com" required /></label>
        <label><span>端口</span><input type="number" min={1} max={65535} value={draft.smtpPort} onChange={(event) => updateDraft("smtpPort", Number(event.target.value))} required /></label>
        <label>
          <span>加密方式</span>
          <select value={draft.encryption} onChange={(event) => updateDraft("encryption", event.target.value as WorkspaceEmailSettings["encryption"])}>
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
            <option value="none">不加密</option>
          </select>
        </label>
        <label><span>用户名</span><input value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} autoComplete="username" /></label>
        <label><span>密码</span><input type="password" value={draft.password} onChange={(event) => updateDraft("password", event.target.value)} autoComplete="new-password" placeholder={settings?.passwordConfigured ? "留空以保留现有密码" : "SMTP 密码"} /></label>
        <label><span>发信地址</span><input type="email" value={draft.fromAddress} onChange={(event) => updateDraft("fromAddress", event.target.value)} placeholder="可留空并使用邮箱格式用户名" /></label>
        <label><span>显示名称</span><input value={draft.fromName} onChange={(event) => updateDraft("fromName", event.target.value)} required /></label>
      </div>
      <div className="workspace-email-health" aria-label="邮件发送状态">
        <span>最近测试 <strong>{settings?.lastTestedAt ? new Date(settings.lastTestedAt).toLocaleString("zh-CN") : "暂无"}</strong></span>
        <span>最后发送 <strong>{settings?.lastDeliveryAt ? new Date(settings.lastDeliveryAt).toLocaleString("zh-CN") : "暂无"}</strong></span>
        <span>失败任务 <strong>{settings?.failedJobCount ?? 0}</strong></span>
      </div>
      {testProof && <p className="workspace-form-status success">已通过测试，将发送至 {testedRecipient}。证明 10 分钟内有效。</p>}
      <div className="workspace-form-actions">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void testSettings()}>
          <Mail size={16} />
          {busy === "test" ? "测试中" : "发送测试邮件"}
        </button>
        <button className="primary" type="submit" disabled={Boolean(busy) || (draft.enabled && !testProof)}>
          {busy === "save" ? "保存中" : draft.enabled ? "保存并启用" : "保存配置"}
        </button>
      </div>
    </form>
  );
}

function ThemeSwitch({
  mode,
  resolvedTheme,
  onModeChange,
  inline = false
}: {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  onModeChange: (mode: ThemeMode) => void;
  inline?: boolean;
}) {
  const options: Array<{ value: ThemeMode; label: string; title: string; icon: React.ReactNode }> = [
    { value: "system", label: "系统", title: `跟随系统（当前${resolvedTheme === "dark" ? "深色" : "浅色"}）`, icon: <Monitor size={15} /> },
    { value: "light", label: "浅色", title: "使用浅色模式", icon: <Sun size={15} /> },
    { value: "dark", label: "深色", title: "使用深色模式", icon: <Moon size={15} /> }
  ];

  return (
    <div
      className={inline ? "theme-switch inline-theme-switch" : "theme-switch"}
      role={inline ? "group" : undefined}
      aria-label="外观模式"
    >
      {options.map((option) => (
        <button
          className={mode === option.value ? "active" : ""}
          key={option.value}
          type="button"
          title={option.title}
          role={inline ? "menuitemradio" : undefined}
          aria-checked={inline ? mode === option.value : undefined}
          aria-pressed={inline ? undefined : mode === option.value}
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


function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
  );
  if (items.length === 0) {
    return;
  }
  event.preventDefault();
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex].focus();
}
function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')
  );
  if (tabs.length === 0) {
    return;
  }

  const currentTab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
  const currentIndex = Math.max(0, currentTab ? tabs.indexOf(currentTab) : 0);
  let nextIndex = currentIndex;

  if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  }

  event.preventDefault();
  const nextTab = tabs[nextIndex];
  nextTab.focus();
  nextTab.click();
}

function InlineNotice({
  noticeKey,
  tone,
  text,
  persistent = false,
  durationMs = WORKSPACE_NOTICE_AUTO_DISMISS_MS,
  onDismiss
}: {
  noticeKey?: string | number;
  tone: "info" | "success" | "warning";
  text: React.ReactNode;
  persistent?: boolean;
  durationMs?: number;
  onDismiss?: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState(durationMs);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (persistent || !dismissRef.current || durationMs <= 0) return;
    const startedAt = Date.now();
    setRemainingMs(durationMs);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, durationMs - (Date.now() - startedAt));
      setRemainingMs(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        dismissRef.current?.();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [durationMs, noticeKey, persistent]);

  const progress = persistent || durationMs <= 0 ? 1 : Math.max(0, remainingMs / durationMs);
  return (
    <div className={`notice ${tone}`} role={tone === "warning" ? "alert" : "status"}>
      {tone === "warning" ? <AlertCircle size={16} /> : <Check size={16} />}
      <span>{text}</span>
      {onDismiss && (
        <span className="notice-actions">
          {!persistent && durationMs > 0 && (
            <span className="notice-countdown" aria-hidden="true">{Math.max(1, Math.ceil(remainingMs / 1000))}s</span>
          )}
          <button className="notice-dismiss" type="button" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>
            <X size={15} />
          </button>
        </span>
      )}
      {!persistent && durationMs > 0 && (
        <span className="notice-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </span>
      )}
    </div>
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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const summary = getP2pStatusSummary(state, mode, peerCount);
  const tone = getP2pStatusTone(state, mode);
  const tips = advice?.items ?? getDefaultP2pStatusTips(mode, peerCount);
  const body = advice?.body ?? p2pTransportModeDescription(mode, peerCount);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("[data-close]")?.focus());
    const close = () => {
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`p2p-status-control ${tone}${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        className="p2p-status-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="p2p-status-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="status-dot" aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown className="status-chevron" size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="p2p-status-popover"
          id="p2p-status-panel"
          role="dialog"
          aria-labelledby="p2p-status-title"
          aria-describedby="p2p-status-description"
        >
          <div className="p2p-status-popover-header">
            <strong id="p2p-status-title">{advice?.title ?? p2pTransportModeLabel(mode)}</strong>
            <button className="icon-button" type="button" data-close title="关闭连接状态" onClick={() => {
              setOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}>
              <X size={16} />
            </button>
          </div>
          <p id="p2p-status-description">{body}</p>
          <small>{trustText}</small>
          {tips.length > 0 && (
            <ul>
              {tips.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
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
                    <MessageBody body={message.body} />
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
  const isActive = transfer.status === "sending" || transfer.status === "receiving" || transfer.status === "verifying";
  const canRespond = !self && transfer.status === "offered";
  const canSave = !self && transfer.status === "complete";
  const canRetry = self && transfer.retryable && (transfer.status === "failed" || transfer.status === "rejected");

  return (
    <div className={`file-transfer ${transfer.status}`}>
      {transfer.downloadUrl && isPreviewableImageMimeType(transfer.mimeType) && (
        <img className="file-transfer-image-preview" src={transfer.downloadUrl} alt={transfer.name} />
      )}
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


export function getWorkspaceSingleImageAttachment<
  T extends { id: string; status: string; mimeType: string }
>(
  blocks: Array<{ type: string; attachmentId?: string }>,
  attachments?: T[]
): T | null {
  const onlyBlock = blocks.length === 1 ? blocks[0] : null;
  return onlyBlock?.type === "attachment" &&
    attachments?.length === 1 &&
    attachments[0].id === onlyBlock.attachmentId &&
    attachments[0].status === "available" &&
    isPreviewableImageMimeType(attachments[0].mimeType)
      ? attachments[0]
      : null;
}

function WorkspaceConversationAvatar({
  conversation,
  currentUserId,
  className = ""
}: {
  conversation: WorkspaceConversation;
  currentUserId?: string;
  className?: string;
}) {
  if (conversation.type === "direct") {
    return (
      <WorkspaceAvatar
        name={workspaceConversationTitle(conversation, currentUserId)}
        avatarUrl={conversation.otherMember?.avatarUrl}
        className={className}
        decorative
      />
    );
  }
  return (
    <span className={`workspace-avatar workspace-group-avatar ${className}`.trim()} aria-hidden="true">
      {conversation.avatarEmoji || <UsersRound size={17} />}
    </span>
  );
}

function WorkspaceGroupAvatarEditor({
  value,
  onChange,
  label
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const normalized = normalizeWorkspaceGroupAvatarEmoji(value);
  return (
    <fieldset className="workspace-group-avatar-editor">
      <legend>{label}（可选）</legend>
      <div className="workspace-group-avatar-input">
        <span className="workspace-avatar workspace-group-avatar" aria-hidden="true">
          {normalized || <UsersRound size={18} />}
        </span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="text"
          maxLength={32}
          placeholder="输入单个 emoji"
          aria-label="输入群头像 emoji"
          aria-invalid={normalized === null}
        />
        {value && (
          <button className="icon-button" type="button" title="恢复默认群头像" onClick={() => onChange("")}>
            <X size={15} />
          </button>
        )}
      </div>
      <div className="workspace-group-avatar-presets" aria-label="选择群头像">
        {WORKSPACE_GROUP_AVATAR_PRESETS.map((emoji) => (
          <button
            className={normalized === emoji ? "active" : ""}
            type="button"
            key={emoji}
            aria-label={`使用 ${emoji} 作为群头像`}
            aria-pressed={normalized === emoji}
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {normalized === null && <small className="field-error">请输入一个完整的 emoji。</small>}
    </fieldset>
  );
}

function WorkspaceFileCategoryTabs({
  value,
  onChange
}: {
  value: WorkspaceFileCategory;
  onChange: (value: WorkspaceFileCategory) => void;
}) {
  return (
    <div className="workspace-file-category-tabs" aria-label="文件类型筛选">
      {([
        { id: "all", label: "全部" },
        { id: "media", label: "图片" },
        { id: "document", label: "文档" },
        { id: "other", label: "其它" }
      ] as const).map((item) => (
        <button
          className={value === item.id ? "active" : ""}
          type="button"
          key={item.id}
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function WorkspaceFileViewToggle({
  value,
  onChange
}: {
  value: WorkspaceFileViewMode;
  onChange: (value: WorkspaceFileViewMode) => void;
}) {
  return (
    <div className="workspace-file-view-toggle" aria-label="文件展示方式">
      <button
        className={value === "list" ? "active" : ""}
        type="button"
        title="列表视图"
        aria-label="列表视图"
        aria-pressed={value === "list"}
        onClick={() => onChange("list")}
      >
        <List size={16} />
      </button>
      <button
        className={value === "grid" ? "active" : ""}
        type="button"
        title="方格视图"
        aria-label="方格视图"
        aria-pressed={value === "grid"}
        onClick={() => onChange("grid")}
      >
        <LayoutGrid size={16} />
      </button>
    </div>
  );
}

function WorkspaceFileThumbnail({
  file,
  compact = false,
  large = false
}: {
  file: WorkspaceAttachment;
  compact?: boolean;
  large?: boolean;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewable = file.status === "available" && isPreviewableImageMimeType(file.mimeType);
  const category = classifyWorkspaceFile(file);

  useEffect(() => {
    setPreviewFailed(false);
  }, [file.id, file.mimeType, file.status]);

  return (
    <span className={`workspace-file-thumbnail${compact ? " compact" : ""}${large ? " large" : ""}`} aria-hidden="true">
      {previewable && !previewFailed ? (
        <img
          src={`/api/workspace/files/${encodeURIComponent(file.id)}/preview`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        category === "media" ? <FileVideo size={compact ? 16 : 20} /> :
          category === "document" ? <FileText size={compact ? 16 : 20} /> :
            <FileCheck2 size={compact ? 16 : 20} />
      )}
    </span>
  );
}

export function WorkspaceStructuredMessage({
  message,
  onOpenAttachment,
  onPreviewImage,
  mentionMembers
}: {
  message: Message;
  onOpenAttachment?: (attachment: WorkspaceAttachment) => void;
  onPreviewImage?: (attachment: WorkspaceAttachment) => void;
  mentionMembers?: WorkspaceUser[];
}) {
  const [textExpanded, setTextExpanded] = useState(false);
  const blocks = message.content?.blocks ?? [];
  const hasUnknownBlock = blocks.some((block) => !isKnownWorkspaceMessageBlock(block));
  if (message.lane !== "workspace" || blocks.length === 0 || hasUnknownBlock) {
    return <MessageBody body={message.body} />;
  }

  const attachmentsById = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const mentionLabels = new Map((mentionMembers ?? []).map((member) => [member.id, member.displayName]));
  const singleImageAttachment = getWorkspaceSingleImageAttachment(blocks, message.attachments);

  if (singleImageAttachment) {
    return (
      <div className="message-body structured-message image-only">
        <button
          className="message-image-only"
          type="button"
          aria-label={`预览图片 ${singleImageAttachment.fileName}`}
          onClick={() => onPreviewImage?.(singleImageAttachment)}
        >
          <img
            className="message-image-preview"
            src={`/api/workspace/files/${encodeURIComponent(singleImageAttachment.id)}/preview`}
            alt={singleImageAttachment.fileName}
            decoding="async"
            loading="lazy"
          />
        </button>
      </div>
    );
  }

  const contentBlocks = blocks.filter((block) => block.type !== "attachment");
  const attachmentBlocks = blocks.flatMap((block, index) => block.type === "attachment"
    ? [{ index, attachment: attachmentsById.get(block.attachmentId) }]
    : []);
  const imageAttachments = attachmentBlocks
    .map(({ attachment }) => attachment)
    .filter((attachment): attachment is WorkspaceAttachment => Boolean(
      attachment && attachment.status === "available" && isPreviewableImageMimeType(attachment.mimeType)
    ));
  const imageAttachmentIds = new Set(imageAttachments.map((attachment) => attachment.id));
  const fileAttachmentBlocks = attachmentBlocks.filter(({ attachment }) => !attachment || !imageAttachmentIds.has(attachment.id));
  const collapsible = shouldCollapseWorkspaceMessageText(contentBlocks);
  const contentId = `workspace-message-text-${message.id.replace(/[^a-z0-9_-]/gi, "")}`;

  return (
    <div className="message-body structured-message">
      {contentBlocks.length > 0 && (
        <div
          className={collapsible && !textExpanded ? "message-content-flow workspace-message-text collapsed" : "message-content-flow workspace-message-text"}
          id={contentId}
        >
          {contentBlocks.map((block, index) => {
            if (block.type === "text") {
              return <WorkspaceMarkdown key={`${index}-text`}>{block.text}</WorkspaceMarkdown>;
            }
            if (block.type === "mention") {
              return (
                <span className="message-mention" key={`${index}-mention`}>
                  @{mentionLabels.get(block.userId) || block.label}
                </span>
              );
            }
            if (block.type === "link") {
              return (
                <a className="message-link" href={block.url} key={`${index}-link`} rel="noopener noreferrer" target="_blank">
                  {block.label || block.url}
                </a>
              );
            }
            if (block.type === "emoji") {
              const customId = /^custom:([a-f0-9-]{36})$/i.exec(block.shortcode)?.[1];
              return customId ? (
                <img
                  key={`${index}-emoji`}
                  className="message-emote-image workspace-custom-emote-image"
                  src={`/api/workspace/emotes/${encodeURIComponent(customId)}/content`}
                  alt="收藏表情"
                  decoding="async"
                  loading="lazy"
                />
              ) : <span key={`${index}-emoji`}>{renderMessageParts(block.shortcode)}</span>;
            }
            return <span key={`${index}-fallback`}>{renderMessageParts(message.body)}</span>;
          })}
        </div>
      )}
      {collapsible && (
        <button
          className="workspace-message-expand"
          type="button"
          aria-controls={contentId}
          aria-expanded={textExpanded}
          onClick={() => setTextExpanded((expanded) => !expanded)}
        >
          {textExpanded ? "收起" : "展开全文"}
          {textExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
      {imageAttachments.length > 0 && (
        <div
          className={imageAttachments.length === 1 ? "message-image-grid single" : "message-image-grid multiple"}
          aria-label={`${imageAttachments.length} 张图片`}
        >
          {imageAttachments.map((attachment) => (
            <button
              className="message-image-tile"
              type="button"
              key={attachment.id}
              aria-label={`预览图片 ${attachment.fileName}`}
              onClick={() => {
                if (onPreviewImage) {
                  onPreviewImage(attachment);
                  return;
                }
                onOpenAttachment?.(attachment);
              }}
            >
              <img
                className="message-image-preview"
                src={`/api/workspace/files/${encodeURIComponent(attachment.id)}/preview`}
                alt={attachment.fileName}
                decoding="async"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {fileAttachmentBlocks.length > 0 && (
        <div className="message-file-list">
          {fileAttachmentBlocks.map(({ attachment, index }) => (
            <button
              className="message-file-card"
              type="button"
              key={`${index}-attachment`}
              aria-label={attachment ? `查看文件 ${attachment.fileName}` : "文件不可用"}
              disabled={!attachment || attachment.status !== "available"}
              onClick={() => attachment && onOpenAttachment?.(attachment)}
            >
              <FileCheck2 size={18} />
              <span>
                <strong>{attachment?.fileName || "文件"}</strong>
                <small>
                  {attachment ? `${formatBytes(attachment.byteSize)} · ${attachment.status === "available" ? "可查看" : "不可用"}` : "文件不可用"}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function shouldCollapseWorkspaceMessageText(blocks: WorkspaceContentBlock[]) {
  const visible = blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label || block.url;
    if (block.type === "emoji") return block.shortcode.startsWith("custom:") ? "[表情]" : `:${block.shortcode}:`;
    return "";
  }).join("");
  return Array.from(visible).length > 700 || visible.split(/\r?\n/).length > 10;
}
function isKnownWorkspaceMessageBlock(block: WorkspaceContentBlock) {
  return block.type === "text" ||
    block.type === "mention" ||
    block.type === "link" ||
    block.type === "emoji" ||
    block.type === "attachment";
}

type WorkspaceSkeletonVariant = "conversation" | "message" | "file" | "member" | "setting";

function WorkspaceSkeletonRows({
  variant,
  count
}: {
  variant: WorkspaceSkeletonVariant;
  count: number;
}) {
  return (
    <div className={`workspace-skeleton-list ${variant}`}>
      {Array.from({ length: count }, (_, index) => (
        <div className="workspace-skeleton-row" key={index}>
          <span className="workspace-skeleton-avatar" />
          <span className="workspace-skeleton-lines">
            <i />
            <i />
          </span>
          <span className="workspace-skeleton-tail" />
        </div>
      ))}
    </div>
  );
}

function WorkspaceShellSkeleton() {
  return (
    <div className="workspace-product-shell workspace-skeleton-shell">
      <span className="sr-only" role="status">正在加载共享空间</span>
      <aside className="workspace-rail" aria-hidden="true">
        <div className="workspace-skeleton-brand">
          <span className="workspace-skeleton-avatar" />
          <span />
        </div>
        <WorkspaceSkeletonRows variant="conversation" count={7} />
      </aside>
      <section className="workspace-main" aria-hidden="true">
        <div className="workspace-skeleton-chat-header" />
        <WorkspaceSkeletonRows variant="message" count={8} />
        <div className="workspace-skeleton-composer" />
      </section>
      <aside className="workspace-context" aria-hidden="true">
        <div className="workspace-skeleton-chat-header" />
        <WorkspaceSkeletonRows variant="setting" count={5} />
      </aside>
    </div>
  );
}
function WorkspaceShell({
  mobilePane,
  contextVisible,
  children
}: {
  mobilePane: WorkspaceMobilePane;
  contextVisible: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`workspace-product-shell mobile-pane-${mobilePane}${contextVisible ? "" : " context-hidden"}`}>
      {children}
    </div>
  );
}

function WorkspaceContextDrawer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="workspace-context" aria-label={label}>
      {children}
    </aside>
  );
}


function WorkspaceReactionBar({
  messageId,
  reactions,
  currentUserId,
  pendingKeys,
  onToggle
}: {
  messageId: string;
  reactions: WorkspaceReactionGroup[];
  currentUserId: string;
  pendingKeys: string[];
  onToggle: (messageId: string, emoteKey: string) => void;
}) {
  if (reactions.length === 0) {
    return <></>;
  }
  return (
    <div className="workspace-reaction-bar" aria-label="消息表情回复">
      {reactions.map((group) => {
        const names = group.users.map((user) => user.id === currentUserId ? "你" : user.displayName);
        const fullNames = names.join("、");
        const compactLabel = names.length <= 2 ? fullNames : String(group.count);
        const emote = getReactionEmote(group.emoteKey);
        const pending = pendingKeys.includes(`${messageId}::${group.emoteKey}`);
        return (
          <button
            className={group.reactedByCurrentUser ? "workspace-reaction active" : "workspace-reaction"}
            type="button"
            key={group.emoteKey}
            aria-label={`${emote?.item.label || "表情"}，${fullNames || `${group.count} 人`}`}
            aria-pressed={group.reactedByCurrentUser}
            disabled={pending}
            title={fullNames}
            onClick={() => onToggle(messageId, group.emoteKey)}
          >
            <ReactionEmoteGlyph emoteKey={group.emoteKey} />
            <span>{compactLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
function WorkspaceChatPanel({
  title,
  titleKind,
  avatar,
  subtitle,
  leadingAction,
  trailingAction,
  messages,
  messageListRef,
  onMessageListScroll,
  onMessageListScrollIntent,
  olderMessagesAvailable,
  olderMessagesLoading,
  onLoadOlderMessages,
  unreadAnchorMessageId,
  unreadAnchorCount,
  newMessageCount,
  awayFromLatest,
  onJumpToLatest,
  draft,
  draftDocument,
  onDraft,
  onSend,
  stagedAttachments,
  onStageFiles,
  onRemoveStagedAttachment,
  onReply,
  onRetryMessage,
  replyTarget,
  onCancelReply,
  onOpenAttachment,
  onPreviewImage,
  onCopyMessage,
  onToggleReaction,
  onFavoriteEmote,
  reactionPendingKeys,
  currentUserId,
  conversationType,
  historyTargetId,
  onReturnToLatest,
  onTogglePin,
  onRecall,
  mentionMembers,
  fileInputDisabled,
  sending
}: {
  title: string;
  titleKind?: WorkspaceUser["kind"];
  avatar?: ReactNode;
  subtitle: string;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  messages: Message[];
  messageListRef: RefObject<HTMLDivElement | null>;
  onMessageListScroll: (list: HTMLDivElement) => void;
  onMessageListScrollIntent: () => void;
  olderMessagesAvailable: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  unreadAnchorMessageId?: string | null;
  unreadAnchorCount: number;
  newMessageCount: number;
  awayFromLatest: boolean;
  onJumpToLatest: () => void;
  draft: string;
  draftDocument: WorkspaceComposerDocument;
  onDraft: (value: WorkspaceComposerDocument) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  stagedAttachments: WorkspaceComposerAttachment[];
  onStageFiles: (files: File[]) => void;
  onRemoveStagedAttachment: (attachmentId: string) => void;
  onReply: (messageId: string) => void;
  onRetryMessage: (messageId: string) => void;
  replyTarget?: Message | null;
  onCancelReply: () => void;
  onOpenAttachment: (attachment: WorkspaceAttachment) => void;
  onPreviewImage: (attachment: WorkspaceAttachment) => void;
  onCopyMessage: (message: Message) => void;
  onToggleReaction: (messageId: string, emoteKey: string) => void;
  onFavoriteEmote: (message: Message) => void;
  reactionPendingKeys: string[];
  currentUserId: string;
  conversationType: WorkspaceConversation["type"];
  historyTargetId: string;
  onReturnToLatest: () => void;
  onTogglePin: (message: Message) => void;
  onRecall: (message: Message) => void;
  mentionMembers: WorkspaceUser[];
  fileInputDisabled: boolean;
  sending: boolean;
}) {
  const [emotePanelOpen, setEmotePanelOpen] = useState(false);
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [formatToolbarOpen, setFormatToolbarOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const editorRef = useRef<WorkspaceComposerEditorHandle | null>(null);
  const emoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reactionPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const canMention = mentionMembers.length > 0;
  const filteredMentionMembers = useMemo(() => {
    const query = (mentionQuery ?? "").trim().toLocaleLowerCase();
    return mentionMembers.filter((member) => !query || [member.displayName, member.githubLogin]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query)));
  }, [mentionMembers, mentionQuery]);
  const toolPanelOpen = emotePanelOpen || mentionPanelOpen;
  const composerClassName = [
    "workspace-composer",
    toolPanelOpen && "tool-open",
    formatToolbarOpen && "formatting-open",
    composerExpanded && "expanded"
  ].filter(Boolean).join(" ");
  const sendDisabled = sending || (!draft.trim() && stagedAttachments.length === 0);
  const unreadIndex = useMemo(() => {
    if (unreadAnchorCount <= 0 || messages.length === 0) {
      return -1;
    }
    const anchorIndex = unreadAnchorMessageId
      ? messages.findIndex((message) => message.id === unreadAnchorMessageId)
      : -1;
    return anchorIndex >= 0
      ? Math.min(messages.length - 1, anchorIndex + 1)
      : Math.max(0, messages.length - unreadAnchorCount);
  }, [messages, unreadAnchorCount, unreadAnchorMessageId]);

  useEffect(() => {
    const sentinel = historySentinelRef.current;
    const root = messageListRef.current;
    if (!sentinel || !root || !olderMessagesAvailable || olderMessagesLoading) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadOlderMessages();
        }
      },
      { root, rootMargin: "120px 0px 0px", threshold: 0.01 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messageListRef, olderMessagesAvailable, olderMessagesLoading, onLoadOlderMessages]);

  const applyMarkdownFormat = (format: WorkspaceMarkdownFormat) => {
    const formats: Record<WorkspaceMarkdownFormat, [string, string?, string?]> = {
      bold: ["**", "**", "粗体文本"],
      italic: ["*", "*", "斜体文本"],
      strikethrough: ["~~", "~~", "删除线文本"],
      "inline-code": ["`", "`", "代码"],
      quote: ["> ", "", "引用内容"],
      "unordered-list": ["- ", "", "列表项"],
      "ordered-list": ["1. ", "", "列表项"],
      link: ["[", "](https://)", "链接文本"],
      "code-block": ["~~~\n", "\n~~~", "代码"],
      divider: ["\n\n---\n\n", "", ""]
    };
    editorRef.current?.applyInlineFormat(...formats[format]);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };

  const insertEmote = (item: EmoteItem) => {
    const insertText = getEmoteInsertText(item);
    editorRef.current?.insertEmote(item, insertText);
    setEmotePanelOpen(false);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const insertMention = (member: WorkspaceUser) => {
    const triggerLength = mentionQuery === null ? 0 : mentionQuery.length + 1;
    editorRef.current?.insertMention(member.id, member.displayName, triggerLength);
    setMentionPanelOpen(false);
    setMentionQuery(null);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const startReply = (messageId: string) => {
    onReply(messageId);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const closeWorkspaceComposerPopover = () => {
    setEmotePanelOpen(false);
    setMentionPanelOpen(false);
    setMentionQuery(null);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  useEffect(() => {
    if (!toolPanelOpen && !reactionPickerMessageId) {
      return;
    }
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (toolPanelOpen && !composerFormRef.current?.contains(target)) {
        setEmotePanelOpen(false);
        setMentionPanelOpen(false);
      }
      if (reactionPickerMessageId) {
        const reactionAnchor = target instanceof Element
          ? target.closest<HTMLElement>("[data-reaction-picker-message-id]")
          : null;
        if (reactionAnchor?.dataset.reactionPickerMessageId !== reactionPickerMessageId) {
          setReactionPickerMessageId("");
        }
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [reactionPickerMessageId, toolPanelOpen]);
  const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (mentionPanelOpen && filteredMentionMembers.length > 0 && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowDown") setMentionActiveIndex((index) => (index + 1) % filteredMentionMembers.length);
      else if (event.key === "ArrowUp") setMentionActiveIndex((index) => (index - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
      else insertMention(filteredMentionMembers[mentionActiveIndex] ?? filteredMentionMembers[0]);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const shortcutFormat = event.key.toLowerCase() === "b"
        ? "bold"
        : event.key.toLowerCase() === "i"
          ? "italic"
          : null;
      if (shortcutFormat) {
        event.preventDefault();
        event.stopPropagation();
        applyMarkdownFormat(shortcutFormat);
        return;
      }
    }
    if (event.key === "Escape" && toolPanelOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeWorkspaceComposerPopover();
      return;
    }
    if (event.key === "Escape" && formatToolbarOpen) {
      event.preventDefault();
      event.stopPropagation();
      setFormatToolbarOpen(false);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!sendDisabled) {
      composerFormRef.current?.requestSubmit();
    }
  };
  const handleDraftPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (fileInputDisabled || sending) {
      return;
    }
    const files = renamePastedImageFiles(Array.from(event.clipboardData.files));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onStageFiles(files);
  };
  const handleComposerSubmit = (event: FormEvent<HTMLFormElement>) => {
    onSend(event);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (fileInputDisabled || sending) {
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onStageFiles(files);
    }
  };

  return (
    <section
      className={dragActive ? "workspace-chat-panel drag-active" : "workspace-chat-panel"}
      aria-label={title}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!fileInputDisabled) setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={handleDrop}
    >
      <header className="workspace-chat-header">
        {leadingAction}
        {avatar}
        <div className="workspace-chat-heading">
          <strong><WorkspaceIdentityName name={title} kind={titleKind} /></strong>
          <span>{subtitle}</span>
        </div>
        <div className="workspace-chat-actions">{trailingAction}</div>
      </header>
      <div
        className="workspace-message-list"
        ref={messageListRef}
        aria-live="polite"
        aria-label="消息列表"
        tabIndex={0}
        onScroll={(event) => onMessageListScroll(event.currentTarget)}
        onWheel={onMessageListScrollIntent}
        onTouchStart={onMessageListScrollIntent}
        onTouchMove={onMessageListScrollIntent}
        onPointerDown={onMessageListScrollIntent}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            onMessageListScrollIntent();
          }
        }}
      >
        {historyTargetId && (
          <div className="workspace-history-window-banner" role="status">
            <span><Pin size={14} />正在查看常驻消息上下文</span>
            <button type="button" onClick={onReturnToLatest}>返回最新消息</button>
          </div>
        )}
        <div className="workspace-history-sentinel" ref={historySentinelRef}>
          {olderMessagesAvailable && (
            <button className="workspace-history-button" type="button" disabled={olderMessagesLoading} onClick={onLoadOlderMessages}>
              <History size={14} />
              {olderMessagesLoading ? "正在加载" : "加载更早消息"}
            </button>
          )}
        </div>
        {messages.length === 0 ? (
          <div className="empty-state workspace-chat-empty">
            <MessageSquare size={24} />
            <strong>开始这段对话</strong>
            <span>发送消息或分享文件。</span>
          </div>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const dayKey = getMessageDayKey(message.createdAt);
            const previousDayKey = getMessageDayKey(previous?.createdAt);
            const showDaySeparator = Boolean(message.createdAt && dayKey !== previousDayKey);
            const messageTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
            const previousTime = previous?.createdAt ? Date.parse(previous.createdAt) : Number.NaN;
            const groupedWithPrevious = Boolean(
              previous &&
                !message.recalledAt &&
                !previous.recalledAt &&
                !message.replyTo &&
                message.author === previous.author &&
                message.author !== "系统" &&
                dayKey === previousDayKey &&
                Number.isFinite(messageTime) &&
                Number.isFinite(previousTime) &&
                messageTime - previousTime >= 0 &&
                messageTime - previousTime <= 5 * 60 * 1000
            );
            if (message.author === "系统") {
              return (
                <Fragment key={message.id}>
                  {showDaySeparator && (
                    <div className="message-day-separator" role="separator"><span>{formatMessageDayLabel(message.createdAt)}</span></div>
                  )}
                  {index === unreadIndex && (
                    <div className="workspace-unread-divider" role="separator"><span>以下为未读消息</span></div>
                  )}
                  <div className="workspace-system-message">{message.body}</div>
                </Fragment>
              );
            }
            return (
              <Fragment key={message.id}>
                {showDaySeparator && (
                  <div className="message-day-separator" role="separator"><span>{formatMessageDayLabel(message.createdAt)}</span></div>
                )}
                {index === unreadIndex && (
                  <div className="workspace-unread-divider" role="separator"><span>以下为未读消息</span></div>
                )}
                <article
                  className={`workspace-message${message.self ? " self" : ""}${groupedWithPrevious ? " grouped" : ""}${historyTargetId === message.id ? " history-target" : ""}`}
                  data-message-id={message.id}
                  data-testid={`workspace-message-${message.id}`}
                >
                  <div className="workspace-message-avatar-slot" aria-hidden="true">
                    {!groupedWithPrevious && (
                      <WorkspaceAvatar
                        name={message.author}
                        avatarUrl={message.authorAvatarUrl}
                        className="workspace-message-avatar"
                        decorative
                      />
                    )}
                  </div>
                  <div className="workspace-message-content">
                    {!groupedWithPrevious && (
                      <div className="workspace-message-meta">
                        <strong><WorkspaceIdentityName name={message.author} kind={message.authorKind} /></strong>
                        <time>{message.at}</time>
                      </div>
                    )}
                    {!message.recalledAt && message.replyTo && (
                      <div className="reply-preview">
                        <strong>{message.replyTo.author}</strong>
                        <span>{message.replyTo.body}</span>
                      </div>
                    )}
                    {message.recalledAt ? (
                      <div className="workspace-recalled-message" role="status">
                        <Undo2 size={14} aria-hidden="true" />
                        <span>{message.body}</span>
                      </div>
                    ) : (
                      <WorkspaceStructuredMessage
                        message={message}
                        onOpenAttachment={onOpenAttachment}
                        onPreviewImage={onPreviewImage}
                        mentionMembers={mentionMembers}
                      />
                    )}
                    {!message.recalledAt && message.pin && (
                      <div className="workspace-message-pin-indicator" title="群常驻消息">
                        <Pin size={12} aria-hidden="true" />
                        <span>常驻</span>
                      </div>
                    )}
                    {!message.recalledAt && (
                      <WorkspaceReactionBar
                        messageId={message.id}
                        reactions={message.reactions ?? []}
                        currentUserId={currentUserId}
                        pendingKeys={reactionPendingKeys}
                        onToggle={onToggleReaction}
                      />
                    )}
                    {message.localState && (
                      <div className={`message-local-state ${message.localState}`}>
                        <span>
                          {message.localState === "sending"
                            ? "发送中"
                            : message.localState === "delivered"
                              ? "已送达"
                              : message.failureReason || "发送失败"}
                        </span>
                        {message.localState === "failed" && (
                          <button type="button" onClick={() => onRetryMessage(message.id)}>
                            <RefreshCw size={14} />
                            重试
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {!message.localState && !message.recalledAt && (
                    <div className="workspace-message-actions">
                      <div
                        className="workspace-reaction-picker-anchor"
                        data-reaction-picker-message-id={message.id}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && reactionPickerMessageId === message.id) {
                            event.preventDefault();
                            setReactionPickerMessageId("");
                            window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus());
                          }
                        }}
                      >
                        <button

                          type="button"
                          title="添加表情回复"
                          aria-haspopup="dialog"
                          aria-expanded={reactionPickerMessageId === message.id}
                          aria-controls={"workspace-reaction-picker-" + message.id}
                          onClick={(event) => {
                            reactionPickerTriggerRef.current = event.currentTarget;
                            setReactionPickerMessageId((current) => current === message.id ? "" : message.id);
                          }}
                        >
                          <Smile size={15} />
                        </button>
                        {reactionPickerMessageId === message.id && (
                          <EmotePicker
                            id={"workspace-reaction-picker-" + message.id}
                            label="选择消息表情回复"
                            workspaceFeatures="reaction"
                            onEscape={() => {
                              setReactionPickerMessageId("");
                              window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus());
                            }}
                            onSelect={(item, packId) => {
                              onToggleReaction(message.id, getReactionEmoteKey(packId, item));
                              setReactionPickerMessageId("");
                              window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus());
                            }}
                          />
                        )}
                      </div>
                      <button type="button" title="回复" onClick={() => startReply(message.id)}>
                        <MessageSquare size={15} />
                      </button>
                      <button type="button" title="复制消息" onClick={() => onCopyMessage(message)}>
                        <Copy size={15} />
                      </button>
                      {getWorkspaceEmoteFavoriteSource(message) && (
                        <button type="button" title="收藏表情" onClick={() => onFavoriteEmote(message)}>
                          <Heart size={15} />
                        </button>
                      )}
                      {conversationType === "group" && (message.pin?.canUnpin || (message.self && !message.pin)) && (
                        <button
                          type="button"
                          title={message.pin ? "取消常驻" : "设为常驻消息"}
                          aria-pressed={Boolean(message.pin)}
                          onClick={() => onTogglePin(message)}
                        >
                          {message.pin ? <PinOff size={15} /> : <Pin size={15} />}
                        </button>
                      )}
                      {message.self && (
                        <button type="button" title="撤回消息" onClick={() => onRecall(message)}>
                          <Undo2 size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </article>
              </Fragment>
            );
          })
        )}
      </div>
      <div className="workspace-composer-dock">
        {!historyTargetId && (newMessageCount > 0 || awayFromLatest) && (
          <button className="workspace-new-message-button" type="button" onClick={onJumpToLatest}>
            <ChevronDown size={15} />
            {newMessageCount > 0 ? `${newMessageCount} 条新消息` : "回到最新消息"}
          </button>
        )}
        {replyTarget && (
          <div className="composer-reply">
            <span>回复 <strong>{replyTarget.author}</strong>：{replyTarget.body}</span>
            <button className="icon-button" type="button" title="取消回复" onClick={onCancelReply}>
              <X size={15} />
            </button>
          </div>
        )}
        {stagedAttachments.length > 0 && (
          <div className="workspace-staged-files" aria-label="待发送附件">
            {stagedAttachments.map((attachment) => (
              <div className={`workspace-staged-file ${attachment.state}`} key={attachment.id}>
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <FileCheck2 size={18} />
                )}
                <span>
                  <strong>{attachment.file.name}</strong>
                  <small>
                    {formatBytes(attachment.file.size)} · {
                      attachment.state === "queued"
                        ? "待发送"
                        : attachment.state === "uploading"
                          ? `上传中 ${attachment.progress}%`
                          : attachment.state === "uploaded"
                            ? "已就绪"
                            : attachment.failureReason || "上传失败"
                    }
                  </small>
                  {attachment.state === "uploading" && (
                    <span className="workspace-upload-progress"><i style={{ width: `${attachment.progress}%` }} /></span>
                  )}
                </span>
                <button type="button" title={attachment.state === "uploading" ? "取消上传" : "移除附件"} onClick={() => onRemoveStagedAttachment(attachment.id)}>
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          ref={composerFormRef}
          className={composerClassName}
          onSubmit={handleComposerSubmit}
          onKeyDownCapture={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('[contenteditable="true"][aria-label="输入消息"]')) {
              handleDraftKeyDown(event);
              return;
            }
            if (event.key === "Escape") {
              if (toolPanelOpen) {
                event.preventDefault();
                closeWorkspaceComposerPopover();
              } else if (formatToolbarOpen) {
                event.preventDefault();
                setFormatToolbarOpen(false);
                window.requestAnimationFrame(() => editorRef.current?.focus());
              }
            }
          }}
        >
          <div className="workspace-composer-tools">
            <label className={fileInputDisabled ? "workspace-composer-icon disabled" : "workspace-composer-icon"} title="添加附件">
              <FileUp size={18} />
              <input
                type="file"
                multiple
                aria-label="添加附件"
                disabled={fileInputDisabled || sending}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  if (files.length > 0) onStageFiles(files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              ref={emoteTriggerRef}
              className="workspace-composer-icon"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={emotePanelOpen}
              aria-controls="workspace-composer-emote-picker"
              title="插入表情"
              onClick={() => {
                setMentionPanelOpen(false);
                setEmotePanelOpen((open) => !open);
              }}
            >
              <Smile size={18} />
            </button>
            {canMention && (
              <button
                ref={mentionTriggerRef}
                className="workspace-composer-icon"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={mentionPanelOpen}
                aria-controls="workspace-composer-mention-picker"
                title="提及成员"
                onClick={() => {
                setEmotePanelOpen(false);
                setMentionQuery("");
                setMentionActiveIndex(0);
                setMentionPanelOpen((open) => !open);
                }}
              >
                <AtSign size={18} />
              </button>
            )}
            <button
              className={formatToolbarOpen ? "workspace-composer-icon active" : "workspace-composer-icon"}
              type="button"
              aria-label={formatToolbarOpen ? "隐藏格式工具栏" : "显示格式工具栏"}
              aria-pressed={formatToolbarOpen}
              aria-expanded={formatToolbarOpen}
              aria-controls="workspace-composer-format-toolbar"
              title={formatToolbarOpen ? "隐藏格式工具栏" : "显示格式工具栏"}
              onClick={() => setFormatToolbarOpen((open) => !open)}
            >
              <Type size={18} />
            </button>
          </div>

          {formatToolbarOpen && (
            <div
              id="workspace-composer-format-toolbar"
              className="workspace-format-toolbar"
              role="toolbar"
              aria-label="消息格式"
            >
              {WORKSPACE_MARKDOWN_FORMAT_GROUPS.map((group, groupIndex) => (
                <Fragment key={groupIndex}>
                  {groupIndex > 0 && <span className="workspace-format-divider" aria-hidden="true" />}
                  <div
                    className="workspace-format-group"
                    role="group"
                    aria-label={groupIndex === 0 ? "文字样式" : groupIndex === 1 ? "段落格式" : "插入"}
                  >
                    {group.map(({ format, label, icon: Icon }) => (
                      <button
                        className="workspace-format-button"
                        type="button"
                        key={format}
                        aria-label={label}
                        title={label}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyMarkdownFormat(format)}
                      >
                        <Icon size={17} />
                      </button>
                    ))}
                  </div>
                </Fragment>
              ))}
            </div>
          )}

          <WorkspaceComposerEditor
            ref={editorRef}
            value={draftDocument}
            onChange={onDraft}
            onMentionQuery={(query) => {
              if (!canMention) return;
              const normalizedQuery = (query ?? "").trim().toLocaleLowerCase();
              const hasMatches = mentionMembers.some((member) => !normalizedQuery || [member.displayName, member.githubLogin]
                .filter(Boolean)
                .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery)));
              setMentionQuery(query);
              setMentionActiveIndex(0);
              setMentionPanelOpen(query !== null && hasMatches);
              if (query !== null) setEmotePanelOpen(false);
            }}
            onKeyDown={handleDraftKeyDown}
            onPaste={handleDraftPaste}
            expanded={composerExpanded}
            readOnly={sending}
          />
          <div className="workspace-composer-actions">
            <button
              className="workspace-composer-icon workspace-composer-resize"
              type="button"
              aria-label={composerExpanded ? "缩小编辑区" : "扩大编辑区"}
              aria-pressed={composerExpanded}
              title={composerExpanded ? "缩小编辑区" : "扩大编辑区"}
              onClick={() => setComposerExpanded((expanded) => !expanded)}
            >
              {composerExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button className="workspace-send-button" type="submit" disabled={sendDisabled} title={sending ? "发送中" : "发送消息"}>
              {sending ? <RefreshCw size={18} /> : <Send size={18} />}
            </button>
          </div>
          {emotePanelOpen && (
            <EmotePicker
              id="workspace-composer-emote-picker"
              workspaceFeatures="composer"
              onSelect={insertEmote}
              onEscape={closeWorkspaceComposerPopover}
            />
          )}
          {mentionPanelOpen && (
            <MentionPicker
              id="workspace-composer-mention-picker"
              members={filteredMentionMembers}
              activeIndex={mentionActiveIndex}
              onSelect={insertMention}
              onEscape={closeWorkspaceComposerPopover}
            />
          )}
        </form>
      </div>
      {dragActive && (
        <div className="workspace-drop-overlay" aria-hidden="true">
          <FileUp size={24} />
          <strong>拖到这里添加附件</strong>
        </div>
      )}
    </section>
  );
}

function ChatPanel({
  title,
  subtitle,
  hideTitle = false,
  leadingAction,
  trailingAction,
  details,
  status,
  messages,
  messageListRef,
  onMessageListScroll,
  olderMessagesAvailable = false,
  olderMessagesLoading = false,
  onLoadOlderMessages,
  draft,
  onDraft,
  onSend,
  onFile,
  onReply,
  onRetryMessage,
  replyTarget,
  onCancelReply,
  onOpenAttachment,
  mentionMembers,
  onAcceptFile,
  onRejectFile,
  onSaveFile,
  onRetryFile,
  onEnd,
  fileLabel,
  fileInputDisabled = false,
  fileInputTitle,
  sending = false
}: {
  title: string;
  subtitle: string;
  hideTitle?: boolean;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  details?: ReactNode;
  status: ReactNode;
  messages: Message[];
  messageListRef?: RefObject<HTMLDivElement | null>;
  onMessageListScroll?: (list: HTMLDivElement) => void;
  olderMessagesAvailable?: boolean;
  olderMessagesLoading?: boolean;
  onLoadOlderMessages?: () => void;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onFile: (file: File) => void;
  onReply?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  replyTarget?: Message | null;
  onCancelReply?: () => void;
  onOpenAttachment?: (attachment: WorkspaceAttachment) => void;
  mentionMembers?: WorkspaceUser[];
  onAcceptFile?: (transferId: string) => void;
  onRejectFile?: (transferId: string) => void;
  onSaveFile?: (transfer: FileTransfer) => void;
  onRetryFile?: (transferId: string) => void;
  onEnd?: () => void;
  fileLabel: string;
  fileInputDisabled?: boolean;
  fileInputTitle?: string;
  sending?: boolean;
}) {
  const [emotePanelOpen, setEmotePanelOpen] = useState(false);
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const emoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const canMention = Boolean(mentionMembers?.length);
  const insertEmote = (item: EmoteItem) => {
    const insertText = getEmoteInsertText(item);
    const nextDraft =
      item.kind === "image"
        ? `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${insertText} `
        : `${draft}${insertText}`;
    onDraft(nextDraft);
    setEmotePanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const insertMention = (member: WorkspaceUser) => {
    const insertText = `@${member.displayName}`;
    const nextDraft = `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${insertText} `;
    onDraft(nextDraft);
    setMentionPanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const closeP2pComposerPopover = () => {
    setEmotePanelOpen(false);
    setMentionPanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const toolPanelOpen = emotePanelOpen || mentionPanelOpen;
  useEffect(() => {
    if (!toolPanelOpen) {
      return;
    }
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !composerFormRef.current?.contains(target)) {
        setEmotePanelOpen(false);
        setMentionPanelOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [toolPanelOpen]);
  const sendDisabled = sending || !draft.trim();
  const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeP2pComposerPopover();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (!sendDisabled) {
      composerFormRef.current?.requestSubmit();
    }
  };
  const handleDraftPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (fileInputDisabled || sending) {
      return;
    }
    const image = Array.from(event.clipboardData.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile() ?? Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
    if (!image) {
      return;
    }
    event.preventDefault();
    onFile(renamePastedImageFiles([image])[0]);
  };

  return (
    <section className="chat-panel" aria-label={title}>
      <header className="chat-header">
        {leadingAction}
        <div className={hideTitle ? "chat-heading title-hidden" : "chat-heading"}>
          <p className="eyebrow">{subtitle}</p>
          {!hideTitle && <h2>{title}</h2>}
        </div>
        <div className="chat-status">
          {status}
          {trailingAction}
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
      <div
        className="message-list"
        ref={messageListRef}
        aria-live="polite"
        onScroll={(event) => onMessageListScroll?.(event.currentTarget)}
      >
        {olderMessagesAvailable && onLoadOlderMessages && (
          <div className="message-history-control">
            <button className="secondary compact" type="button" disabled={olderMessagesLoading} onClick={onLoadOlderMessages}>
              <History size={15} />
              {olderMessagesLoading ? "加载中" : "加载更早消息"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={26} />
            <span>还没有消息。</span>
          </div>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const dayKey = getMessageDayKey(message.createdAt);
            const previousDayKey = getMessageDayKey(previous?.createdAt);
            const showDaySeparator = Boolean(message.createdAt && dayKey !== previousDayKey);
            const messageTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
            const previousTime = previous?.createdAt ? Date.parse(previous.createdAt) : Number.NaN;
            const groupedWithPrevious = Boolean(
              previous &&
                !message.replyTo &&
                message.author === previous.author &&
                message.self === previous.self &&
                message.author !== "系统" &&
                dayKey &&
                dayKey === previousDayKey &&
                Number.isFinite(messageTime) &&
                Number.isFinite(previousTime) &&
                messageTime - previousTime >= 0 &&
                messageTime - previousTime <= 5 * 60 * 1000
            );
            const messageClassName = [
              message.self ? "message self" : message.author === "系统" ? "message system" : "message",
              groupedWithPrevious ? "grouped" : ""
            ].filter(Boolean).join(" ");
            return (
              <Fragment key={message.id}>
                {showDaySeparator && (
                  <div className="message-day-separator" role="separator">
                    <span>{formatMessageDayLabel(message.createdAt)}</span>
                  </div>
                )}
                <article className={messageClassName}>
                  {!groupedWithPrevious && (
                    <div className="message-meta">
                      <strong>{message.author}</strong>
                      <span>{message.at}</span>
                    </div>
                  )}
                  {message.replyTo && (
                    <div className="reply-preview">
                      <strong>{message.replyTo.author}</strong>
                      <span>{message.replyTo.body}</span>
                    </div>
                  )}
                  <WorkspaceStructuredMessage message={message} onOpenAttachment={onOpenAttachment} />
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
                  {message.fileName && !message.content?.blocks.some((block) => block.type === "attachment") && (
                    <span className="file-chip">
                      <FileUp size={14} />
                      {message.fileName}
                    </span>
                  )}
                  {message.localState && (
                    <div className={`message-local-state ${message.localState}`}>
                      <span>
                        {message.localState === "sending"
                          ? "发送中"
                          : message.localState === "delivered"
                            ? "已送达"
                            : message.failureReason || "发送失败"}
                      </span>
                      {message.localState === "failed" && onRetryMessage && (
                        <button type="button" onClick={() => onRetryMessage(message.id)}>
                          <RefreshCw size={14} />
                          重试
                        </button>
                      )}
                    </div>
                  )}
                  {onReply && message.author !== "系统" && !message.localState && (
                    <button className="message-reply" type="button" onClick={() => onReply(message.id)}>
                      回复
                    </button>
                  )}
                </article>
              </Fragment>
            );
          })
        )}
      </div>
      <div className="composer-dock">
        {replyTarget && (
        <div className="composer-reply">
          <span>
            回复 <strong>{replyTarget.author}</strong>：{replyTarget.body}
          </span>
          <button className="icon-button" type="button" title="取消回复" onClick={onCancelReply}>
            <X size={15} />
          </button>
        </div>
        )}
      <form
        ref={composerFormRef}
        className={toolPanelOpen ? "composer tool-open" : "composer"}
        onSubmit={onSend}
        onKeyDown={(event) => {
          if (event.key === "Escape" && toolPanelOpen) {
            event.preventDefault();
            closeP2pComposerPopover();
          }
        }}
      >
        <label
          className={fileInputDisabled ? "file-button disabled" : "file-button"}
          title={fileInputTitle ?? fileLabel}
          aria-disabled={fileInputDisabled}
        >
          <FileUp size={17} />
          <input
            type="file"
            aria-label={fileLabel}
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
        <div className="composer-tools">
          <div className="composer-tool-buttons">
            <button
              ref={emoteTriggerRef}
              className="secondary composer-tool-button"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={emotePanelOpen}
              aria-controls="p2p-composer-emote-picker"
              title="插入表情"
              onClick={() => {
                setMentionPanelOpen(false);
                setEmotePanelOpen((open) => !open);
              }}
            >
              <Smile size={17} />
            </button>
            {canMention && (
              <button
                ref={mentionTriggerRef}
                className="secondary composer-tool-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={mentionPanelOpen}
                aria-controls="p2p-composer-mention-picker"
                title="提及成员"
                onClick={() => {
                  setEmotePanelOpen(false);
                  setMentionPanelOpen((open) => !open);
                }}
              >
                <AtSign size={17} />
              </button>
            )}
          </div>
          {emotePanelOpen && (
            <EmotePicker
              id="p2p-composer-emote-picker"
              onSelect={insertEmote}
              onEscape={closeP2pComposerPopover}
            />
          )}
          {mentionPanelOpen && mentionMembers && (
            <MentionPicker
              id="p2p-composer-mention-picker"
              members={mentionMembers}
              onSelect={insertMention}
              onEscape={closeP2pComposerPopover}
            />
          )}
        </div>
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          onPaste={handleDraftPaste}
          placeholder="输入消息"
          aria-label="输入消息"
          disabled={sending}
        />
        <button className="primary send-button" type="submit" disabled={sendDisabled} title={sending ? "发送中" : "发送消息"}>
          <Send size={18} />
          <span>{sending ? "发送中" : "发送"}</span>
        </button>
      </form>
      </div>
    </section>
  );
}

function MentionPicker({
  id,
  members,
  activeIndex = -1,
  onSelect,
  onEscape
}: {
  id?: string;
  members: WorkspaceUser[];
  activeIndex?: number;
  onSelect: (member: WorkspaceUser) => void;
  onEscape?: () => void;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    pickerRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={pickerRef}
      className="mention-picker"
      id={id}
      role="dialog"
      aria-label="提及成员"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onEscape?.();
        }
      }}
    >
      {members.length === 0 ? (
        <p className="saved-empty">没有可提及的成员。</p>
      ) : (
        members.map((member, index) => (
          <button
            className={index === activeIndex ? "mention-row active" : "mention-row"}
            type="button"
            key={member.id}
            data-mention-index={index}
            aria-current={index === activeIndex ? "true" : undefined}
            onClick={() => onSelect(member)}
          >
            <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
            <span>
              <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
              <small>{workspaceMemberSecondaryText(member)}</small>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function EmotePicker({
  id,
  onSelect,
  onEscape,
  label = "选择表情",
  workspaceFeatures
}: {
  id?: string;
  onSelect: (item: EmoteItem, packId: EmotePack["id"]) => void;
  onEscape?: () => void;
  label?: string;
  workspaceFeatures?: "composer" | "reaction";
}) {
  const [activePackId, setActivePackId] = useState(visibleEmotePacks[0]?.id ?? "emoji");
  const [settings, setSettings] = useState<WorkspaceEmoteSettings | null>(null);
  const [customEmotes, setCustomEmotes] = useState<WorkspaceCustomEmote[]>([]);
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState("");
  const customInputRef = useRef<HTMLInputElement>(null);
  const enabledPackIds = settings?.enabledPackIds ?? visibleEmotePacks.map((pack) => pack.id);
  const enabledPacks = visibleEmotePacks.filter((pack) => enabledPackIds.includes(pack.id as Exclude<EmotePack["id"], "custom">));
  const customPack: EmotePack = {
    id: "custom",
    label: "收藏",
    items: customEmotes.map((emote) => ({
      kind: "image",
      id: emote.id,
      customId: emote.kind === "custom" ? emote.id : undefined,
      label: emote.label,
      token: emote.token,
      src: emote.src,
      animated: emote.animated
    }))
  };
  const packs = workspaceFeatures === "composer" ? [...enabledPacks, customPack] : enabledPacks;
  const activePack = packs.find((pack) => pack.id === activePackId) ?? packs[0];

  useEffect(() => {
    if (!workspaceFeatures) return;
    let cancelled = false;
    void Promise.all([
      workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings"),
      workspaceFeatures === "composer"
        ? workspaceJson<{ items: WorkspaceCustomEmote[] }>("/api/workspace/me/emotes")
        : Promise.resolve({ items: [] as WorkspaceCustomEmote[] })
    ]).then(([settingsResult, emotesResult]) => {
      if (cancelled) return;
      setSettings(settingsResult.settings);
      setCustomEmotes(emotesResult.items);
    }).catch(() => {
      if (!cancelled) setCustomError("表情设置暂时无法加载");
    });
    return () => { cancelled = true; };
  }, [workspaceFeatures]);

  useEffect(() => {
    if (activePack && activePack.id === activePackId) return;
    setActivePackId(packs[0]?.id ?? "emoji");
  }, [activePack, activePackId, packs]);

  async function uploadCustomEmote(file: File) {
    setCustomBusy(true);
    setCustomError("");
    try {
      const response = await workspaceFetch("/api/workspace/me/emotes", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-duallane-file-name": encodeURIComponent(file.name)
        },
        body: file
      });
      const data = await response.json() as { emote: WorkspaceCustomEmote };
      setCustomEmotes((items) => items.some((item) => item.id === data.emote.id) ? items : [...items, data.emote]);
      setActivePackId("custom");
    } catch (error) {
      setCustomError(userFacingErrorMessage(error, "收藏表情上传失败"));
    } finally {
      setCustomBusy(false);
      if (customInputRef.current) customInputRef.current.value = "";
    }
  }

  async function removeCustomEmote(emoteId: string) {
    setCustomBusy(true);
    setCustomError("");
    try {
      await workspaceJson(`/api/workspace/me/emotes/${encodeURIComponent(emoteId)}`, { method: "DELETE" });
      setCustomEmotes((items) => items.filter((item) => item.id !== emoteId));
    } catch (error) {
      setCustomError(userFacingErrorMessage(error, "收藏表情删除失败"));
    } finally {
      setCustomBusy(false);
    }
  }

  return (
    <div
      className="emote-picker"
      id={id}
      role="dialog"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onEscape?.();
        }
      }}
    >
      <div className="emote-pack-tabs" role="tablist" aria-label="表情包" onKeyDown={handleTabListKeyDown}>
        {packs.map((pack) => (
          <button
            className={pack.id === activePack.id ? "active" : ""}
            key={pack.id}
            type="button"
            role="tab"
            aria-selected={pack.id === activePack.id}
            onClick={() => setActivePackId(pack.id)}
            tabIndex={pack.id === activePack.id ? 0 : -1}
          >
            {pack.label}
          </button>
        ))}
      </div>
      <div className="emote-grid">
        {activePack.id === "custom" && (
          <label className={customBusy ? "emote-upload-tile busy" : "emote-upload-tile"} title="上传收藏表情">
            <Plus size={22} />
            <span>添加</span>
            <input
              ref={customInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
              aria-label="上传收藏表情"
              disabled={customBusy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void uploadCustomEmote(file);
              }}
            />
          </label>
        )}
        {activePack?.items.map((item) => activePack.id === "custom" ? (
          <div className="emote-custom-tile" key={item.id}>
            <button type="button" title={item.label} aria-label={item.label} onClick={() => onSelect(item, activePack.id)}>
              {item.kind === "image" && <img alt="" decoding="async" draggable={false} src={item.src} />}
            </button>
            <button className="emote-custom-remove" type="button" title="删除收藏表情" aria-label={`删除收藏表情 ${item.label}`} disabled={customBusy} onClick={() => void removeCustomEmote(item.id)}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            onClick={() => onSelect(item, activePack.id)}
          >
            {item.kind === "unicode" ? (
              <span className="unicode-emote">{item.value}</span>
            ) : (
              <img alt="" decoding="async" draggable={false} src={item.src} />
            )}
          </button>
        ))}
      </div>
      {activePack?.id === "custom" && customEmotes.length === 0 && !customError && (
        <p className="emote-picker-empty">收藏表情为空，可上传图片或从消息中收藏。</p>
      )}
      {customError && <p className="emote-picker-error" role="status">{customError}</p>}
    </div>
  );
}
