import { create } from "zustand";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import {
  ApiClientError,
  apiV1,
  type DevInviteProfileInput,
  type ThreadReplyItem,
  type ThreadViewResponse,
} from "@/shared/lib/api-v1";
import { buildDevPreviewFixture } from "./demo-fixture";
import {
  loadWorkspaceDrafts,
  loadWorkspaceScrolls,
  saveWorkspaceDraft,
  saveWorkspaceScroll,
  setWorkspaceSyncCursor,
} from "@/shared/lib/draft-db";
import {
  buildP2PShareUrl,
  connectP2PRoomTransport,
  createRemoteP2PRoom,
  createSafeP2PBlobUrl,
  deriveAesKey,
  encryptP2PPayload,
  generateRoomKeyString,
  P2P_MAX_FILE_BYTES,
  scrubP2PRoomFromUrl,
  type P2PChatMessage,
  type P2PRoomSession,
  type P2PRoomTransport,
} from "@/shared/lib/p2p-lane";

export interface V1User {
  id: string;
  displayName: string;
  handle?: string;
  role: "owner" | "admin" | "member" | "bot";
  avatarUrl?: string;
}

export interface V1MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  url: string;
  downloadUrl?: string;
  width?: number;
  height?: number;
  thumbHash?: string;
  sourceMessageId?: string;
}

export interface V1Message {
  id: string;
  clientMessageId?: string;
  conversationId: string;
  kind?: "user" | "bot" | "system";
  senderId: string;
  senderName: string;
  plainText: string;
  replyToId?: string;
  threadRootId?: string;
  threadReplyCount?: number;
  editedAt?: string;
  createdAt: string;
  status?: "sending" | "sent" | "read" | "failed";
  reactions: Record<string, { count: number; reactedByMe: boolean }>;
  attachments?: V1MessageAttachment[];
  card?: DualLaneCardKitDocument;
}

export interface V1Conversation {
  id: string;
  kind: "saved" | "direct" | "group";
  title: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  unreadCount: number;
  mentionCount: number;
  pinnedMessageIds: string[];
  memberIds: string[];
  lastMessageText?: string;
  lastMessageAt?: string;
}

export interface DraftEntry {
  text: string;
  replyToMessageId?: string;
}

export type WorkspaceAvailability = "checking" | "ready" | "disabled" | "unreachable";

interface WorkspaceState {
  isPreviewMode: boolean;
  authStatus: "checking" | "unauthenticated" | "authenticated";
  workspaceAvailability: WorkspaceAvailability;
  workspaceStatusMessage: string | null;
  connectionStatus: "connected" | "reconnecting" | "offline";
  currentUser: V1User | null;
  quotaUsedBytes: number;
  quotaLimitBytes: number;

  conversations: Record<string, V1Conversation>;
  conversationOrder: string[];
  pinnedConversationIds: string[];
  userPreferences: Record<string, unknown>;
  messagesByConv: Record<string, V1Message[]>;
  members: Record<string, V1User>;
  activeConversationId: string | null;
  highlightedMessageId: string | null;
  threadsByRootId: Record<string, ThreadViewResponse>;

  drafts: Record<string, DraftEntry>;
  scrollTops: Record<string, number>;
  editingMessageId: string | null;

  // P2P Direct Lane (Strict RAM-only!)
  p2pRoom: P2PRoomSession | null;
  p2pAesKey: CryptoKey | null;
  p2pMessages: P2PChatMessage[];
  p2pDraft: string;

  bootstrapWorkspace: () => Promise<void>;
  acceptInviteAndBootstrap: (inviteCode: string, profile?: DevInviteProfileInput) => Promise<void>;
  logout: () => Promise<void>;
  selectConversation: (conversationId: string) => void;
  loadConversationMessages: (conversationId: string) => Promise<void>;
  jumpToMessage: (conversationId: string, messageId: string) => void;
  setDraft: (conversationId: string, text: string, replyToMessageId?: string) => void;
  setScrollTop: (conversationId: string, scrollTop: number) => void;
  setEditingMessageId: (messageId: string | null) => void;

  sendWorkspaceMessage: (
    conversationId: string,
    text: string,
    replyToId?: string,
    attachments?: V1MessageAttachment[]
  ) => Promise<void>;
  editWorkspaceMessage: (conversationId: string, messageId: string, newText: string) => Promise<void>;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  togglePinMessage: (conversationId: string, messageId: string) => Promise<void>;
  togglePinConversation: (conversationId: string) => Promise<void>;
  createGroup: (title: string, memberIds: string[], avatar?: string) => Promise<string | null>;
  updateGroupProfile: (
    conversationId: string,
    patch: { title?: string; avatar?: string | null }
  ) => Promise<void>;
  uploadGroupAvatar: (conversationId: string, file: File) => Promise<void>;
  inviteGroupMembers: (conversationId: string, userIds: string[]) => Promise<void>;
  leaveGroup: (conversationId: string) => Promise<void>;
  forwardMessage: (messageIds: string[], targetConversationId: string) => Promise<void>;
  loadThread: (rootMessageId: string) => Promise<void>;
  sendThreadReply: (rootMessageId: string, text: string, alsoSendToChannel: boolean) => Promise<void>;
  triggerCardAction: (cardId: string, actionId: string, payload?: Record<string, unknown>) => Promise<void>;

  createP2PRoom: () => Promise<string>;
  joinP2PRoom: (roomId: string, keyStr: string) => Promise<void>;
  leaveP2PRoom: () => void;
  setP2PDraft: (text: string) => void;
  sendP2PMessage: (text: string, replyToId?: string) => Promise<void>;
  sendP2PFile: (file: File, caption?: string) => Promise<void>;
}

let activeP2PTransport: P2PRoomTransport | null = null;
let activeP2PRoomToken = "";
let activeP2PJoinPromise: Promise<void> | null = null;
const queuedP2PFileBytes = new Map<
  string,
  { fileName: string; mimeType: string; bytes: Uint8Array; caption?: string }
>();
let activeWorkspaceSocket: WebSocket | null = null;
let workspaceReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function teardownWorkspaceSocket() {
  if (workspaceReconnectTimer) {
    clearTimeout(workspaceReconnectTimer);
    workspaceReconnectTimer = null;
  }
  if (activeWorkspaceSocket) {
    const ws = activeWorkspaceSocket;
    activeWorkspaceSocket = null;
    try {
      ws.close(1000, "teardown");
    } catch {
      // Ignore close errors
    }
  }
}

function teardownP2PTransport() {
  if (activeP2PTransport) {
    const t = activeP2PTransport;
    activeP2PTransport = null;
    t.close();
  }
}

function mapRawReactions(raw: unknown): Record<string, { count: number; reactedByMe: boolean }> {
  const out: Record<string, { count: number; reactedByMe: boolean }> = {};
  if (!Array.isArray(raw)) return out;
  for (const item of raw as Array<Record<string, unknown>>) {
    const key = String(item.emoteKey || item.emoji || item.key || "");
    if (!key) continue;
    const count = Number(item.count || 0);
    if (count > 0) {
      out[key] = {
        count,
        reactedByMe: Boolean(item.reactedByCurrentUser ?? item.reactedByMe),
      };
    }
  }
  return out;
}

function mapRawAttachments(
  raw: unknown,
  fallbackMessageId?: string
): V1MessageAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return (raw as Array<Record<string, unknown>>).map((a) => {
    const id = String(a.id || "");
    const mimeType = String(a.mimeType || "application/octet-stream");
    const defaultDownloadUrl = id
      ? `/api/workspace/files/${encodeURIComponent(id)}/download`
      : "";
    const defaultPreviewUrl =
      id && mimeType.startsWith("image/")
        ? `/api/workspace/files/${encodeURIComponent(id)}/preview`
        : defaultDownloadUrl;
    const downloadUrl = String(a.downloadUrl || a.url || defaultDownloadUrl);
    const url = String(a.previewUrl || a.url || a.downloadUrl || defaultPreviewUrl);
    return {
      id,
      fileName: String(a.fileName || a.name || "附件"),
      mimeType,
      byteSize: Number(a.byteSize || a.size || 0),
      url,
      downloadUrl,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
      thumbHash: typeof a.thumbHash === "string" ? a.thumbHash : undefined,
      sourceMessageId: a.sourceMessageId ? String(a.sourceMessageId) : fallbackMessageId,
    };
  });
}

function mapRawMessage(
  conversationId: string,
  m: Record<string, unknown>,
  members: Record<string, V1User>
): V1Message {
  const authorObj = (m.author && typeof m.author === "object" ? m.author : {}) as Record<
    string,
    unknown
  >;
  const rawKind = typeof m.kind === "string" ? m.kind : undefined;
  const kind: V1Message["kind"] =
    rawKind === "system" ? "system" : rawKind === "bot" ? "bot" : "user";
  const senderId = String(m.authorId || m.senderId || authorObj.id || "");
  const id = String(m.id || "");
  return {
    id,
    clientMessageId: m.clientMessageId ? String(m.clientMessageId) : undefined,
    conversationId,
    kind,
    senderId,
    senderName:
      members[senderId]?.displayName ||
      String(
        m.authorRemark ||
          m.authorNickname ||
          m.authorName ||
          m.authorDisplayName ||
          authorObj.displayName ||
          m.senderName ||
          (kind === "system" ? "系统通知" : "成员")
      ),
    plainText: String(m.plainText || m.text || ""),
    replyToId: m.replyToMessageId
      ? String(m.replyToMessageId)
      : m.replyToId
      ? String(m.replyToId)
      : undefined,
    threadRootId: m.threadRootId ? String(m.threadRootId) : undefined,
    threadReplyCount: Number(m.threadReplyCount || m.replyCount || 0),
    editedAt: m.editedAt ? String(m.editedAt) : undefined,
    createdAt: String(m.createdAt || new Date().toISOString()),
    status: "read",
    reactions: mapRawReactions(m.reactions),
    attachments: mapRawAttachments(m.attachments, id),
    card: m.card as DualLaneCardKitDocument | undefined,
  };
}

function upsertRawMemberRecord(
  target: Record<string, V1User>,
  m: Record<string, unknown> | null | undefined
): string {
  if (!m || typeof m !== "object") return "";
  const id = String(m.id || m.userId || "");
  if (!id) return "";
  const prev = target[id];
  const rawKind = String(m.kind || "");
  const rawRole = String(m.role || prev?.role || "member");
  const role: V1User["role"] =
    rawKind === "bot" || rawRole === "bot"
      ? "bot"
      : rawRole === "owner" || rawRole === "admin"
      ? rawRole
      : "member";
  const candidateName =
    m.remark || m.nickname || m.displayName || m.name || m.githubLogin || m.handle;
  const resolvedName = candidateName
    ? String(candidateName)
    : prev?.displayName && !prev.displayName.startsWith("usr_")
    ? prev.displayName
    : id;
  target[id] = {
    id,
    displayName: resolvedName,
    handle: m.githubLogin
      ? String(m.githubLogin)
      : m.handle
      ? String(m.handle)
      : prev?.handle,
    role,
    avatarUrl: m.avatarUrl ? String(m.avatarUrl) : prev?.avatarUrl,
  };
  return id;
}

function backfillMemberFromMessage(
  target: Record<string, V1User>,
  msg: V1Message
): void {
  if (!msg.senderId || msg.kind === "system") return;
  const existing = target[msg.senderId];
  if (existing && existing.displayName && !existing.displayName.startsWith("usr_")) {
    return;
  }
  if (msg.senderName && msg.senderName !== "成员" && !msg.senderName.startsWith("usr_")) {
    target[msg.senderId] = {
      id: msg.senderId,
      displayName: msg.senderName,
      handle: existing?.handle,
      role: msg.kind === "bot" ? "bot" : existing?.role || "member",
      avatarUrl: existing?.avatarUrl,
    };
  }
}

function splitConversationAvatar(
  kind: V1Conversation["kind"],
  rawConv: Record<string, unknown>,
  members: Record<string, V1User>,
  memberIds: string[],
  currentUserId?: string
): { avatarUrl?: string; avatarEmoji?: string } {
  const rawVal = rawConv.avatarUrl ?? rawConv.avatarEmoji ?? rawConv.avatar;
  if (typeof rawVal === "string" && rawVal.trim()) {
    const val = rawVal.trim();
    if (
      val.startsWith("/") ||
      val.startsWith("blob:") ||
      val.startsWith("data:") ||
      val.startsWith("http://") ||
      val.startsWith("https://")
    ) {
      return { avatarUrl: val, avatarEmoji: undefined };
    }
    return { avatarUrl: undefined, avatarEmoji: val };
  }
  if (kind === "direct") {
    const otherObj =
      rawConv.otherMember && typeof rawConv.otherMember === "object"
        ? (rawConv.otherMember as Record<string, unknown>)
        : undefined;
    if (otherObj?.avatarUrl && typeof otherObj.avatarUrl === "string") {
      return { avatarUrl: otherObj.avatarUrl };
    }
    const peerId = memberIds.find((uid) => uid && uid !== currentUserId);
    if (peerId && members[peerId]?.avatarUrl) {
      return { avatarUrl: members[peerId].avatarUrl };
    }
  }
  return {};
}

export function parseBootstrapPayload(raw: Record<string, unknown>) {
  const authObj = (raw.auth || {}) as Record<string, unknown>;
  const workspaceEnabled = authObj.enabled !== false;
  const userObj = (authObj.currentUser || raw.currentUser || raw.user || {}) as Record<
    string,
    unknown
  >;
  const currentUser: V1User | null = userObj.id
    ? {
        id: String(userObj.id),
        displayName: String(userObj.nickname || userObj.displayName || userObj.name || "我"),
        handle: userObj.githubLogin
          ? String(userObj.githubLogin)
          : userObj.handle
          ? String(userObj.handle)
          : undefined,
        role: (userObj.role as V1User["role"]) || "member",
        avatarUrl: userObj.avatarUrl ? String(userObj.avatarUrl) : undefined,
      }
    : null;

  const policyObj = (raw.policy || {}) as Record<string, unknown>;
  const quotaUsedBytes = Number(policyObj.usedTodayBytes || 0);
  const quotaLimitBytes = Number(policyObj.dailyQuotaBytes || 512 * 1024 * 1024);

  const members: Record<string, V1User> = {};
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  for (const m of rawMembers as Array<Record<string, unknown>>) {
    upsertRawMemberRecord(members, m);
  }
  if (currentUser && !members[currentUser.id]) {
    members[currentUser.id] = currentUser;
  }

  const conversations: Record<string, V1Conversation> = {};
  const conversationOrder: string[] = [];
  const messagesByConv: Record<string, V1Message[]> = {};
  const rawConvs = Array.isArray(raw.conversations) ? raw.conversations : [];
  for (const c of rawConvs as Array<Record<string, unknown>>) {
    const id = String(c.id || "");
    if (!id) continue;
    conversationOrder.push(id);
    const rawType = String(c.kind || c.type || "group");
    const kind: V1Conversation["kind"] =
      rawType === "saved" ? "saved" : rawType === "direct" ? "direct" : "group";
    const lastMsg = (c.lastMessage || {}) as Record<string, unknown>;
    if (c.otherMember && typeof c.otherMember === "object") {
      upsertRawMemberRecord(members, c.otherMember as Record<string, unknown>);
    }
    const rawMemberList = Array.isArray(c.members)
      ? (c.members as Array<Record<string, unknown>>).map((item) =>
          upsertRawMemberRecord(members, item)
        )
      : Array.isArray(c.memberIds)
      ? c.memberIds.map(String)
      : [];
    const cleanedMemberIds = rawMemberList.filter(Boolean);
    const resolvedAvatar = splitConversationAvatar(
      kind,
      c,
      members,
      cleanedMemberIds,
      currentUser?.id
    );
    conversations[id] = {
      id,
      kind,
      title:
        kind === "saved"
          ? "我的收藏"
          : String(c.displayTitle || c.title || c.name || "未命名对话"),
      avatarUrl: resolvedAvatar.avatarUrl,
      avatarEmoji: resolvedAvatar.avatarEmoji,
      unreadCount: Number(c.unreadCount || 0),
      mentionCount: Number(c.mentionCount || 0),
      pinnedMessageIds: Array.isArray(c.pinnedMessageIds) ? c.pinnedMessageIds.map(String) : [],
      memberIds: cleanedMemberIds,
      lastMessageText: c.lastMessagePlainText
        ? String(c.lastMessagePlainText)
        : c.lastMessageText
        ? String(c.lastMessageText)
        : lastMsg.plainText
        ? String(lastMsg.plainText)
        : undefined,
      lastMessageAt: c.lastMessageAt
        ? String(c.lastMessageAt)
        : lastMsg.createdAt
        ? String(lastMsg.createdAt)
        : undefined,
    };
    const rawMsgs = Array.isArray(c.latestMessages)
      ? c.latestMessages
      : Array.isArray(c.messages)
      ? c.messages
      : [];
    messagesByConv[id] = rawMsgs.map((msg) => {
      const mapped = mapRawMessage(id, msg as Record<string, unknown>, members);
      backfillMemberFromMessage(members, mapped);
      return mapped;
    });
  }

  const eventCursor = Number(raw.eventCursor || 0);
  const hasEmbeddedPreferences = Boolean(
    raw.preferences && typeof raw.preferences === "object" && !Array.isArray(raw.preferences)
  );
  const userPreferences: Record<string, unknown> = hasEmbeddedPreferences
    ? { ...(raw.preferences as Record<string, unknown>) }
    : {};
  const pinnedConversationIds: string[] = Array.isArray(userPreferences.pinnedConversationIds)
    ? userPreferences.pinnedConversationIds.map(String).filter(Boolean)
    : [];

  return {
    workspaceEnabled,
    currentUser,
    quotaUsedBytes,
    quotaLimitBytes,
    members,
    conversations,
    conversationOrder,
    messagesByConv,
    eventCursor,
    hasEmbeddedPreferences,
    userPreferences,
    pinnedConversationIds,
  };
}

const BOOTSTRAP_SHELL_CACHE_KEY = "duallane:v1:shell-snapshot:v1";

interface BootstrapShellSnapshot {
  version: 1;
  savedAt: number;
  currentUser: V1User;
  quotaUsedBytes: number;
  quotaLimitBytes: number;
  members: Record<string, V1User>;
  conversations: Record<string, V1Conversation>;
  conversationOrder: string[];
  pinnedConversationIds: string[];
  userPreferences: Record<string, unknown>;
  activeConversationId: string | null;
  activeMessages: V1Message[];
}

function getSafeBrowserStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage;
  } catch {
    return null;
  }
}

function loadBootstrapShellCache(): BootstrapShellSnapshot | null {
  const storage = getSafeBrowserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BOOTSTRAP_SHELL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootstrapShellSnapshot>;
    if (
      parsed.version !== 1 ||
      !parsed.currentUser?.id ||
      !parsed.conversations ||
      typeof parsed.conversations !== "object" ||
      !Array.isArray(parsed.conversationOrder)
    ) {
      return null;
    }
    return {
      version: 1,
      savedAt: Number(parsed.savedAt || 0),
      currentUser: parsed.currentUser,
      quotaUsedBytes: Number(parsed.quotaUsedBytes || 0),
      quotaLimitBytes: Number(parsed.quotaLimitBytes || 512 * 1024 * 1024),
      members: parsed.members && typeof parsed.members === "object" ? parsed.members : {},
      conversations: parsed.conversations,
      conversationOrder: parsed.conversationOrder,
      pinnedConversationIds: Array.isArray(parsed.pinnedConversationIds)
        ? parsed.pinnedConversationIds
        : [],
      userPreferences:
        parsed.userPreferences && typeof parsed.userPreferences === "object"
          ? parsed.userPreferences
          : {},
      activeConversationId: parsed.activeConversationId ?? null,
      activeMessages: Array.isArray(parsed.activeMessages) ? parsed.activeMessages : [],
    };
  } catch {
    return null;
  }
}

function saveBootstrapShellCache(state: {
  currentUser: V1User | null;
  quotaUsedBytes: number;
  quotaLimitBytes: number;
  members: Record<string, V1User>;
  conversations: Record<string, V1Conversation>;
  conversationOrder: string[];
  pinnedConversationIds: string[];
  userPreferences: Record<string, unknown>;
  activeConversationId: string | null;
  messagesByConv: Record<string, V1Message[]>;
}): void {
  if (!state.currentUser) return;
  const storage = getSafeBrowserStorage();
  if (!storage) return;
  try {
    const cappedOrder = state.conversationOrder.slice(0, 100);
    const cappedConversations: Record<string, V1Conversation> = {};
    for (const id of cappedOrder) {
      if (state.conversations[id]) {
        cappedConversations[id] = state.conversations[id];
      }
    }
    const activeId =
      state.activeConversationId && cappedConversations[state.activeConversationId]
        ? state.activeConversationId
        : cappedOrder[0] || null;
    const activeMessages = activeId ? (state.messagesByConv[activeId] || []).slice(-30) : [];
    const payload: BootstrapShellSnapshot = {
      version: 1,
      savedAt: Date.now(),
      currentUser: state.currentUser,
      quotaUsedBytes: state.quotaUsedBytes,
      quotaLimitBytes: state.quotaLimitBytes,
      members: state.members,
      conversations: cappedConversations,
      conversationOrder: cappedOrder,
      pinnedConversationIds: state.pinnedConversationIds,
      userPreferences: state.userPreferences,
      activeConversationId: activeId,
      activeMessages,
    };
    storage.setItem(BOOTSTRAP_SHELL_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
}

function clearBootstrapShellCache(): void {
  const storage = getSafeBrowserStorage();
  if (!storage) return;
  try {
    storage.removeItem(BOOTSTRAP_SHELL_CACHE_KEY);
  } catch {
    // Ignore
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const wireP2PSession = (roomId: string, key: CryptoKey) => {
    teardownP2PTransport();
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;

    const flushQueuedMessages = async (transport: P2PRoomTransport) => {
      const queued = get().p2pMessages.filter((m) => m.isOwn && m.deliveryStatus === "queued");
      for (const item of queued) {
        set((s) => ({
          p2pMessages: s.p2pMessages.map((m) =>
            m.id === item.id ? { ...m, deliveryStatus: "sending" } : m
          ),
        }));
        const queuedFile = queuedP2PFileBytes.get(item.id);
        let ok = false;
        if (queuedFile) {
          ok = await transport.sendFile({
            id: item.id,
            author: item.senderName,
            fileName: queuedFile.fileName,
            mimeType: queuedFile.mimeType,
            bytes: queuedFile.bytes,
            caption: queuedFile.caption,
            at: item.createdAt,
          });
          if (ok) {
            queuedP2PFileBytes.delete(item.id);
          }
        } else {
          ok = await transport.sendChat({
            id: item.id,
            author: item.senderName,
            body: item.text,
            at: item.createdAt,
            replyToId: item.replyToId,
          });
        }
        set((s) => ({
          p2pMessages: s.p2pMessages.map((m) =>
            m.id === item.id
              ? {
                  ...m,
                  deliveryStatus: ok
                    ? m.deliveryStatus === "delivered"
                      ? "delivered"
                      : "sent"
                    : "queued",
                }
              : m
          ),
        }));
      }
    };

    const transport = connectP2PRoomTransport(roomId, key, {
      onPresenceChange: (update) => {
        set((s) =>
          s.p2pRoom && s.p2pRoom.roomId === roomId
            ? {
                p2pRoom: {
                  ...s.p2pRoom,
                  status: update.status,
                  connectedPeers: update.connectedPeers,
                  remotePeerCount: update.remotePeerCount,
                  errorMessage: update.errorMessage,
                },
              }
            : s
        );
        if (update.remotePeerCount > 0 && activeP2PTransport) {
          void flushQueuedMessages(activeP2PTransport);
        }
      },
      onIncomingChat: (incoming) => {
        set((s) => {
          if (s.p2pMessages.some((m) => m.id === incoming.id)) return s;
          const nextMsg: P2PChatMessage = {
            id: incoming.id,
            senderName: incoming.author,
            isOwn: false,
            text: incoming.body,
            replyToId: incoming.replyToId,
            createdAt: incoming.at,
            deliveryStatus: "delivered",
            reactions: {},
          };
          return {
            p2pMessages: [...s.p2pMessages, nextMsg],
            p2pRoom: s.p2pRoom
              ? { ...s.p2pRoom, keyMismatchWarning: false }
              : s.p2pRoom,
          };
        });
      },
      onIncomingFile: (incoming) => {
        set((s) => {
          if (s.p2pMessages.some((m) => m.id === incoming.id)) return s;
          const nextMsg: P2PChatMessage = {
            id: incoming.id,
            senderName: incoming.author,
            isOwn: false,
            text: incoming.caption || "",
            createdAt: incoming.at,
            deliveryStatus: "delivered",
            reactions: {},
            attachment: incoming.attachment,
          };
          return {
            p2pMessages: [...s.p2pMessages, nextMsg],
            p2pRoom: s.p2pRoom
              ? { ...s.p2pRoom, keyMismatchWarning: false }
              : s.p2pRoom,
          };
        });
      },
      onDeliveryAck: (messageId) => {
        set((s) => ({
          p2pMessages: s.p2pMessages.map((m) =>
            m.id === messageId ? { ...m, deliveryStatus: "delivered" } : m
          ),
        }));
      },
      onKeyMismatch: () => {
        set((s) => ({
          p2pRoom: s.p2pRoom
            ? {
                ...s.p2pRoom,
                keyMismatchWarning: true,
              }
            : s.p2pRoom,
        }));
      },
    });
    activeP2PTransport = transport;
  };

  const connectWorkspaceRealtime = (initialCursor: number) => {
    teardownWorkspaceSocket();
    if (
      typeof window === "undefined" ||
      typeof WebSocket === "undefined" ||
      get().isPreviewMode
    ) {
      return;
    }

    let cursor = Math.max(0, Math.trunc(initialCursor || 0));
    const openSocket = () => {
      if (get().authStatus !== "authenticated" || get().isPreviewMode) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/workspace`);
      activeWorkspaceSocket = ws;

      ws.addEventListener("open", () => {
        if (activeWorkspaceSocket !== ws) return;
        ws.send(JSON.stringify({ type: "hello", version: 1, lastSeq: cursor }));
      });

      ws.addEventListener("message", (ev) => {
        if (activeWorkspaceSocket !== ws || typeof ev.data !== "string") return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame.type === "ready") {
          if (typeof frame.currentSeq === "number" && frame.currentSeq > cursor) {
            cursor = frame.currentSeq;
            void setWorkspaceSyncCursor(cursor);
          }
          set({ connectionStatus: "connected" });
          return;
        }

        if (frame.type === "sync.required") {
          if (typeof frame.currentSeq === "number") {
            cursor = frame.currentSeq;
            void setWorkspaceSyncCursor(cursor);
          }
          void get().bootstrapWorkspace();
          return;
        }

        if (frame.type === "event" && frame.event && typeof frame.event === "object") {
          const eventObj = frame.event as Record<string, unknown>;
          const seq = Number(eventObj.seq || 0);
          if (seq > cursor) {
            cursor = seq;
            void setWorkspaceSyncCursor(cursor);
          }
          const evType = String(eventObj.type || "");
          const payload = (eventObj.payload && typeof eventObj.payload === "object"
            ? eventObj.payload
            : {}) as Record<string, unknown>;

          if (evType === "workspace.member_joined" || evType === "workspace.member_updated") {
            const m = (payload.member || {}) as Record<string, unknown>;
            const id = String(m.id || payload.userId || "");
            if (id) {
              set((s) => ({
                members: {
                  ...s.members,
                  [id]: {
                    id,
                    displayName: String(m.remark || m.nickname || m.displayName || id),
                    handle: m.githubLogin ? String(m.githubLogin) : undefined,
                    role: (m.role as V1User["role"]) || "member",
                    avatarUrl: m.avatarUrl ? String(m.avatarUrl) : undefined,
                  },
                },
              }));
            }
            return;
          }

          if (evType === "conversation.created" || evType === "conversation.updated") {
            const c = (payload.conversation || {}) as Record<string, unknown>;
            const convId = String(c.id || eventObj.conversationId || "");
            if (!convId) return;
            const rawType = String(c.kind || c.type || "group");
            const kind: V1Conversation["kind"] =
              rawType === "saved" ? "saved" : rawType === "direct" ? "direct" : "group";
            set((s) => {
              const exists = Boolean(s.conversations[convId]);
              const prev = s.conversations[convId];
              const nextMembers = { ...s.members };
              if (c.otherMember && typeof c.otherMember === "object") {
                upsertRawMemberRecord(nextMembers, c.otherMember as Record<string, unknown>);
              }
              const parsedMemberIds = Array.isArray(c.members)
                ? (c.members as Array<Record<string, unknown>>)
                    .map((m) => upsertRawMemberRecord(nextMembers, m))
                    .filter(Boolean)
                : Array.isArray(c.memberIds)
                ? c.memberIds.map(String).filter(Boolean)
                : prev?.memberIds || [];
              const hasExplicitAvatarKey =
                "avatarEmoji" in c || "avatarEmoji" in payload || "avatarUrl" in c;
              const parsedAvatar = splitConversationAvatar(
                kind,
                {
                  ...c,
                  ...(payload.avatarEmoji !== undefined ? { avatarEmoji: payload.avatarEmoji } : {}),
                },
                nextMembers,
                parsedMemberIds,
                s.currentUser?.id
              );
              const nextConv: V1Conversation = {
                id: convId,
                kind,
                title:
                  kind === "saved"
                    ? "我的收藏"
                    : String(
                        c.displayTitle ||
                          c.title ||
                          payload.title ||
                          prev?.title ||
                          "未命名对话"
                      ),
                avatarUrl: hasExplicitAvatarKey ? parsedAvatar.avatarUrl : prev?.avatarUrl,
                avatarEmoji: hasExplicitAvatarKey ? parsedAvatar.avatarEmoji : prev?.avatarEmoji,
                unreadCount:
                  convId === s.activeConversationId
                    ? 0
                    : Number(c.unreadCount ?? prev?.unreadCount ?? 0),
                mentionCount: prev?.mentionCount || 0,
                pinnedMessageIds: prev?.pinnedMessageIds || [],
                memberIds: parsedMemberIds,
                lastMessageText: c.lastMessagePlainText
                  ? String(c.lastMessagePlainText)
                  : prev?.lastMessageText,
                lastMessageAt: c.lastMessageAt
                  ? String(c.lastMessageAt)
                  : prev?.lastMessageAt,
              };

              let nextMessagesByConv = s.messagesByConv;
              if (Array.isArray(c.latestMessages) && c.latestMessages.length > 0) {
                const incoming = (c.latestMessages as Array<Record<string, unknown>>)
                  .filter((m) => Boolean(m && m.id))
                  .map((m) => {
                    const mappedMsg = mapRawMessage(convId, m, nextMembers);
                    backfillMemberFromMessage(nextMembers, mappedMsg);
                    return mappedMsg;
                  });
                const existing = s.messagesByConv[convId] || [];
                if (existing.length === 0) {
                  nextMessagesByConv = { ...s.messagesByConv, [convId]: incoming };
                } else {
                  const merged = [...existing];
                  for (const msg of incoming) {
                    const idx = merged.findIndex(
                      (item) =>
                        item.id === msg.id ||
                        (msg.clientMessageId && item.clientMessageId === msg.clientMessageId)
                    );
                    if (idx >= 0) {
                      merged[idx] = { ...msg, status: "read" as const };
                    } else {
                      merged.push(msg);
                    }
                  }
                  nextMessagesByConv = { ...s.messagesByConv, [convId]: merged };
                }
              }

              return {
                members: nextMembers,
                messagesByConv: nextMessagesByConv,
                conversations: { ...s.conversations, [convId]: nextConv },
                conversationOrder: exists
                  ? s.conversationOrder
                  : [...s.conversationOrder, convId],
              };
            });
            return;
          }

          if (evType === "message.created" || evType === "message.recalled") {
            const rawMsg = (payload.message || {}) as Record<string, unknown>;
            const convId = String(
              rawMsg.conversationId || payload.conversationId || eventObj.conversationId || ""
            );
            if (!convId || !rawMsg.id) return;
            const mapped = mapRawMessage(convId, rawMsg, get().members);
            const convPayload =
              payload.conversation && typeof payload.conversation === "object"
                ? (payload.conversation as Record<string, unknown>)
                : undefined;
            const serverUnread =
              typeof convPayload?.unreadCount === "number"
                ? convPayload.unreadCount
                : undefined;
            const isSystemMessage =
              mapped.kind === "system" || String(rawMsg.kind || "") === "system";

            set((s) => {
              const existing = s.messagesByConv[convId] || [];
              const matchIndex = existing.findIndex(
                (item) =>
                  item.id === mapped.id ||
                  (mapped.clientMessageId && item.clientMessageId === mapped.clientMessageId)
              );
              const alreadyExisted = matchIndex >= 0;
              const nextList = alreadyExisted
                ? existing.map((item, idx) =>
                    idx === matchIndex ? { ...mapped, status: "read" as const } : item
                  )
                : [...existing, mapped];

              const prevConv = s.conversations[convId];
              const isOwn = Boolean(s.currentUser?.id && mapped.senderId === s.currentUser.id);
              const isActive = convId === s.activeConversationId;
              const baseUnread = prevConv?.unreadCount || 0;
              const nextUnreadCount = isActive
                ? 0
                : typeof serverUnread === "number"
                ? serverUnread
                : evType === "message.created" && !alreadyExisted && !isOwn && !isSystemMessage
                ? baseUnread + 1
                : baseUnread;

              const nextConv: V1Conversation = prevConv
                ? {
                    ...prevConv,
                    lastMessageText: mapped.plainText,
                    lastMessageAt: mapped.createdAt,
                    unreadCount: nextUnreadCount,
                  }
                : {
                    id: convId,
                    kind: "group",
                    title: String(
                      convPayload?.displayTitle || convPayload?.title || "新对话"
                    ),
                    unreadCount: nextUnreadCount,
                    mentionCount: 0,
                    pinnedMessageIds: [],
                    memberIds: [],
                    lastMessageText: mapped.plainText,
                    lastMessageAt: mapped.createdAt,
                  };

              const nextMembers = { ...s.members };
              if (Array.isArray(convPayload?.members)) {
                for (const m of convPayload.members as Array<Record<string, unknown>>) {
                  upsertRawMemberRecord(nextMembers, m);
                }
              }
              backfillMemberFromMessage(nextMembers, mapped);

              return {
                members: nextMembers,
                messagesByConv: {
                  ...s.messagesByConv,
                  [convId]: nextList,
                },
                conversations: {
                  ...s.conversations,
                  [convId]: nextConv,
                },
                conversationOrder: prevConv
                  ? s.conversationOrder
                  : [...s.conversationOrder, convId],
              };
            });
            return;
          }

          if (evType === "reaction.added" || evType === "reaction.removed") {
            const msgId = String(payload.messageId || eventObj.targetId || "");
            const convId = String(payload.conversationId || eventObj.conversationId || "");
            if (!msgId || !convId) return;
            const nextReactions = mapRawReactions(payload.reactions);
            set((s) => ({
              messagesByConv: {
                ...s.messagesByConv,
                [convId]: (s.messagesByConv[convId] || []).map((m) =>
                  m.id === msgId ? { ...m, reactions: nextReactions } : m
                ),
              },
            }));
            return;
          }

          if (evType === "conversation.member_added") {
            const convId = String(payload.conversationId || eventObj.conversationId || "");
            const userId = String(payload.userId || eventObj.targetId || "");
            if (!convId || !userId) return;
            set((s) => {
              const prevConv = s.conversations[convId];
              const nextMembers = { ...s.members };
              if (payload.member && typeof payload.member === "object") {
                upsertRawMemberRecord(nextMembers, payload.member as Record<string, unknown>);
              }
              if (!prevConv) {
                return { members: nextMembers };
              }
              const nextMemberIds = prevConv.memberIds.includes(userId)
                ? prevConv.memberIds
                : [...prevConv.memberIds, userId];
              return {
                members: nextMembers,
                conversations: {
                  ...s.conversations,
                  [convId]: { ...prevConv, memberIds: nextMemberIds },
                },
              };
            });
            return;
          }

          if (evType === "conversation.member_removed") {
            const convId = String(payload.conversationId || eventObj.conversationId || "");
            const userId = String(payload.userId || eventObj.targetId || "");
            if (!convId || !userId) return;
            set((s) => {
              const prevConv = s.conversations[convId];
              if (!prevConv) return s;
              if (s.currentUser?.id && userId === s.currentUser.id) {
                const nextConversations = { ...s.conversations };
                delete nextConversations[convId];
                const nextOrder = s.conversationOrder.filter((id) => id !== convId);
                return {
                  conversations: nextConversations,
                  conversationOrder: nextOrder,
                  pinnedConversationIds: s.pinnedConversationIds.filter((id) => id !== convId),
                  activeConversationId:
                    s.activeConversationId === convId ? nextOrder[0] || null : s.activeConversationId,
                };
              }
              return {
                conversations: {
                  ...s.conversations,
                  [convId]: {
                    ...prevConv,
                    memberIds: prevConv.memberIds.filter((id) => id !== userId),
                  },
                },
              };
            });
            return;
          }

          if (evType === "message.pinned" || evType === "message.unpinned") {
            const convId = String(payload.conversationId || eventObj.conversationId || "");
            const msgId = String(payload.messageId || eventObj.targetId || "");
            if (!convId || !msgId) return;
            set((s) => {
              const prevConv = s.conversations[convId];
              if (!prevConv) return s;
              const nextPins =
                evType === "message.pinned"
                  ? prevConv.pinnedMessageIds.includes(msgId)
                    ? prevConv.pinnedMessageIds
                    : [msgId, ...prevConv.pinnedMessageIds]
                  : prevConv.pinnedMessageIds.filter((id) => id !== msgId);
              return {
                conversations: {
                  ...s.conversations,
                  [convId]: { ...prevConv, pinnedMessageIds: nextPins },
                },
              };
            });
          }
        }
      });

      ws.addEventListener("close", () => {
        if (activeWorkspaceSocket !== ws) return;
        activeWorkspaceSocket = null;
        if (get().authStatus === "authenticated" && !get().isPreviewMode) {
          set({ connectionStatus: "reconnecting" });
          workspaceReconnectTimer = setTimeout(openSocket, 1800);
        }
      });
    };

    openSocket();
  };

  return {
    isPreviewMode: false,
    authStatus: "checking",
    workspaceAvailability: "checking",
    workspaceStatusMessage: null,
    connectionStatus: "connected",
    currentUser: null,
    quotaUsedBytes: 0,
    quotaLimitBytes: 512 * 1024 * 1024,
    conversations: {},
    conversationOrder: [],
    pinnedConversationIds: [],
    userPreferences: {},
    messagesByConv: {},
    members: {},
    activeConversationId: null,
    highlightedMessageId: null,
    threadsByRootId: {},
    drafts: {},
    scrollTops: {},
    editingMessageId: null,

    p2pRoom: null,
    p2pAesKey: null,
    p2pMessages: [],
    p2pDraft: "",

    bootstrapWorkspace: async () => {
      if (
        import.meta.env.DEV &&
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("preview") === "1"
      ) {
        const fixture = buildDevPreviewFixture();
        set({
          isPreviewMode: true,
          authStatus: "authenticated",
          workspaceAvailability: "ready",
          workspaceStatusMessage: null,
          connectionStatus: "connected",
          currentUser: fixture.currentUser,
          quotaUsedBytes: fixture.quotaUsedBytes,
          quotaLimitBytes: fixture.quotaLimitBytes,
          members: fixture.members,
          conversations: fixture.conversations,
          conversationOrder: fixture.conversationOrder,
          messagesByConv: fixture.messagesByConv,
          activeConversationId: fixture.activeConversationId,
          threadsByRootId: fixture.threadsByRootId,
          drafts: fixture.drafts,
        });
        return;
      }

      if (
        get().authStatus !== "authenticated" &&
        typeof window !== "undefined" &&
        window.location?.pathname?.startsWith("/workspace")
      ) {
        const cached = loadBootstrapShellCache();
        if (cached) {
          set({
            authStatus: "authenticated",
            workspaceAvailability: "ready",
            workspaceStatusMessage: null,
            connectionStatus: "reconnecting",
            currentUser: cached.currentUser,
            quotaUsedBytes: cached.quotaUsedBytes,
            quotaLimitBytes: cached.quotaLimitBytes,
            members: cached.members,
            conversations: cached.conversations,
            conversationOrder: cached.conversationOrder,
            pinnedConversationIds: cached.pinnedConversationIds,
            userPreferences: cached.userPreferences,
            activeConversationId: cached.activeConversationId,
            messagesByConv: cached.activeConversationId
              ? { [cached.activeConversationId]: cached.activeMessages }
              : {},
          });
        }
      }

      try {
        const [raw, drafts, scrollTops] = await Promise.all([
          apiV1.getBootstrap(),
          loadWorkspaceDrafts(),
          loadWorkspaceScrolls(),
        ]);
        const parsed = parseBootstrapPayload(raw);
        if (!parsed.workspaceEnabled) {
          clearBootstrapShellCache();
          teardownWorkspaceSocket();
          set({
            authStatus: "unauthenticated",
            workspaceAvailability: "disabled",
            workspaceStatusMessage:
              "当前环境未开启共享空间（WORKSPACE_ENABLED=false）。如需测试共享空间，请配置开发数据库并启用 WORKSPACE_ENABLED=true；你也可以直接免登录使用私密直连通道。",
          });
          return;
        }
        if (!parsed.currentUser) {
          clearBootstrapShellCache();
          teardownWorkspaceSocket();
          set({
            authStatus: "unauthenticated",
            workspaceAvailability: "ready",
            workspaceStatusMessage: null,
          });
          return;
        }

        const hasSavedConv = Object.values(parsed.conversations).some((c) => c.kind === "saved");
        if (!hasSavedConv) {
          try {
            const savedRes = await apiV1.ensureSavedConversation();
            if (savedRes.conversationId && !parsed.conversations[savedRes.conversationId]) {
              parsed.conversations[savedRes.conversationId] = {
                id: savedRes.conversationId,
                kind: "saved",
                title: "我的收藏",
                unreadCount: 0,
                mentionCount: 0,
                pinnedMessageIds: [],
                memberIds: [parsed.currentUser.id],
              };
              parsed.conversationOrder.unshift(savedRes.conversationId);
              parsed.messagesByConv[savedRes.conversationId] = [];
            }
          } catch {
            // Non-fatal if migration pending
          }
        }

        let userPreferences = parsed.userPreferences;
        let pinnedConversationIds = parsed.pinnedConversationIds;
        if (!parsed.hasEmbeddedPreferences) {
          try {
            const prefRes = await apiV1.getPreferences();
            if (prefRes.preferences && typeof prefRes.preferences === "object") {
              userPreferences = prefRes.preferences;
              if (Array.isArray(prefRes.preferences.pinnedConversationIds)) {
                pinnedConversationIds = prefRes.preferences.pinnedConversationIds
                  .map(String)
                  .filter(Boolean);
              }
            }
          } catch {
            // Non-fatal
          }
        }

        const prevState = get();
        const currentActive = prevState.activeConversationId;
        const firstConvId =
          currentActive && parsed.conversations[currentActive]
            ? currentActive
            : parsed.conversationOrder[0] || null;

        const mergedMessagesByConv: Record<string, V1Message[]> = {};
        for (const convId of Object.keys(parsed.conversations)) {
          const incoming = parsed.messagesByConv[convId] || [];
          const existing =
            prevState.currentUser?.id === parsed.currentUser.id
              ? prevState.messagesByConv[convId] || []
              : [];
          mergedMessagesByConv[convId] = incoming.length > 0 ? incoming : existing;
        }

        set({
          authStatus: "authenticated",
          workspaceAvailability: "ready",
          workspaceStatusMessage: null,
          connectionStatus: "connected",
          currentUser: parsed.currentUser,
          quotaUsedBytes: parsed.quotaUsedBytes,
          quotaLimitBytes: parsed.quotaLimitBytes,
          members: parsed.members,
          conversations: parsed.conversations,
          conversationOrder: parsed.conversationOrder,
          pinnedConversationIds,
          userPreferences,
          messagesByConv: mergedMessagesByConv,
          activeConversationId: firstConvId,
          drafts,
          scrollTops,
        });

        saveBootstrapShellCache(get());
        connectWorkspaceRealtime(parsed.eventCursor);
        void setWorkspaceSyncCursor(parsed.eventCursor);

        if (firstConvId) {
          void get().loadConversationMessages(firstConvId);
        }
      } catch (err) {
        teardownWorkspaceSocket();
        if (err instanceof ApiClientError) {
          if (err.code === "workspace.disabled") {
            clearBootstrapShellCache();
            set({
              authStatus: "unauthenticated",
              workspaceAvailability: "disabled",
              workspaceStatusMessage:
                "当前环境未开启共享空间（WORKSPACE_ENABLED=false）。如需验证共享空间，请配置本地开发数据库并设置 WORKSPACE_ENABLED=true，或直接进入私密直连通道。",
            });
            return;
          }
          if (err.code === "auth.required" || err.status === 401) {
            clearBootstrapShellCache();
            set({
              authStatus: "unauthenticated",
              workspaceAvailability: "ready",
              workspaceStatusMessage: null,
            });
            return;
          }
        }
        try {
          const health = await apiV1.getHealth();
          if (health.workspace?.enabled !== true) {
            set({
              authStatus: "unauthenticated",
              workspaceAvailability: "disabled",
              workspaceStatusMessage:
                "当前环境未开启共享空间（仅直连信令服务在线或 WORKSPACE_ENABLED=false）。启用开发库后即可登录，或直接使用私密直连通道。",
            });
            return;
          }
          set({
            authStatus: "unauthenticated",
            workspaceAvailability: "unreachable",
            workspaceStatusMessage:
              "共享空间初始化接口返回异常，请检查 PostgreSQL 连接与 036 数据库迁移状态，或直接使用私密直连通道。",
          });
        } catch {
          set({
            authStatus: "unauthenticated",
            workspaceAvailability: "unreachable",
            workspaceStatusMessage:
              "共享空间后端服务 (127.0.0.1:8898) 未连接或尚未执行 036 数据库迁移。请运行 pnpm dev 启动完整双通道后端。",
          });
        }
      }
    },

    acceptInviteAndBootstrap: async (inviteCode, profile) => {
      await apiV1.acceptInvite(inviteCode, profile);
      await get().bootstrapWorkspace();
    },

    logout: async () => {
      clearBootstrapShellCache();
      teardownWorkspaceSocket();
      await apiV1.logout().catch(() => {});
      if (typeof window !== "undefined" && window.location?.pathname?.startsWith("/workspace")) {
        window.history?.replaceState?.(null, "", "/");
      }
      set({
        authStatus: "unauthenticated",
        currentUser: null,
        conversations: {},
        conversationOrder: [],
        pinnedConversationIds: [],
        userPreferences: {},
        messagesByConv: {},
        activeConversationId: null,
      });
    },

    loadConversationMessages: async (conversationId) => {
      if (get().isPreviewMode) return;
      try {
        const res = await apiV1.listMessages(conversationId);
        if (!Array.isArray(res.messages)) return;
        const nextMembers = { ...get().members };
        const mapped = res.messages.map((m) => {
          const msg = mapRawMessage(conversationId, m, nextMembers);
          backfillMemberFromMessage(nextMembers, msg);
          return msg;
        });
        set((s) => ({
          members: { ...s.members, ...nextMembers },
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: mapped,
          },
        }));
        if (get().activeConversationId === conversationId) {
          saveBootstrapShellCache(get());
        }
      } catch {
        // Keep existing cached messages
      }
    },

    selectConversation: (conversationId) => {
      set((s) => ({
        activeConversationId: conversationId,
        highlightedMessageId: null,
        conversations: s.conversations[conversationId]
          ? {
              ...s.conversations,
              [conversationId]: {
                ...s.conversations[conversationId],
                unreadCount: 0,
                mentionCount: 0,
              },
            }
          : s.conversations,
      }));
      if (!get().isPreviewMode) {
        void get().loadConversationMessages(conversationId);
        void apiV1.markConversationRead(conversationId).catch(() => {});
      }
    },

    jumpToMessage: (conversationId, messageId) => {
      get().selectConversation(conversationId);
      set({ highlightedMessageId: messageId });
      setTimeout(() => {
        if (get().highlightedMessageId === messageId) {
          set({ highlightedMessageId: null });
        }
      }, 2400);
    },

    setDraft: (conversationId, text, replyToMessageId) => {
      set((s) => {
        const next = { ...s.drafts };
        if (!text.trim()) {
          delete next[conversationId];
        } else {
          next[conversationId] = { text, replyToMessageId };
        }
        return { drafts: next };
      });
      void saveWorkspaceDraft(conversationId, text, replyToMessageId);
    },

    setScrollTop: (conversationId, scrollTop) => {
      set((s) => ({
        scrollTops: { ...s.scrollTops, [conversationId]: scrollTop },
      }));
      void saveWorkspaceScroll(conversationId, scrollTop);
    },

    setEditingMessageId: (editingMessageId) => set({ editingMessageId }),

    sendWorkspaceMessage: async (conversationId, text, replyToId, attachments) => {
      const user = get().currentUser;
      const trimmed = text.trim();
      const attList = attachments && attachments.length > 0 ? attachments : undefined;
      if (!user || (!trimmed && !attList)) return;
      const clientMessageId = `cli_${crypto.randomUUID()}`;
      const tempId = `opt_${clientMessageId}`;
      const displayPlain = trimmed || (attList ? "[文件]" : "");
      const optimistic: V1Message = {
        id: tempId,
        clientMessageId,
        conversationId,
        senderId: user.id,
        senderName: user.displayName,
        plainText: displayPlain,
        replyToId,
        createdAt: new Date().toISOString(),
        status: "sending",
        reactions: {},
        attachments: attList,
      };
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: [...(s.messagesByConv[conversationId] || []), optimistic],
        },
      }));
      get().setDraft(conversationId, "");

      if (get().isPreviewMode) {
        set((s) => ({
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
              m.id === tempId ? { ...m, status: "read" } : m
            ),
          },
          conversations: s.conversations[conversationId]
            ? {
                ...s.conversations,
                [conversationId]: {
                  ...s.conversations[conversationId],
                  lastMessageText: displayPlain,
                  lastMessageAt: optimistic.createdAt,
                },
              }
            : s.conversations,
        }));
        return;
      }

      try {
        const res = await apiV1.sendMessage(conversationId, trimmed, {
          replyToMessageId: replyToId,
          clientMessageId,
          attachmentIds: attList?.map((a) => a.id),
        });
        const msgObj = (res.message || {}) as Record<string, unknown>;
        const realId = msgObj.id ? String(msgObj.id) : tempId;
        const serverMapped = msgObj.id
          ? mapRawMessage(conversationId, msgObj, get().members)
          : null;
        set((s) => {
          const list = s.messagesByConv[conversationId] || [];
          const alreadyDeliveredByWs = list.some((m) => m.id === realId && m.id !== tempId);
          const nextList = alreadyDeliveredByWs
            ? list.filter((m) => m.id !== tempId)
            : list.map((m) =>
                m.id === tempId
                  ? serverMapped
                    ? { ...serverMapped, status: "sent" as const }
                    : { ...m, id: realId, status: "sent" as const }
                  : m
              );
          return {
            messagesByConv: {
              ...s.messagesByConv,
              [conversationId]: nextList,
            },
            conversations: s.conversations[conversationId]
              ? {
                  ...s.conversations,
                  [conversationId]: {
                    ...s.conversations[conversationId],
                    lastMessageText: serverMapped?.plainText || displayPlain,
                    lastMessageAt: optimistic.createdAt,
                  },
                }
              : s.conversations,
          };
        });
      } catch {
        set((s) => ({
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
              m.id === tempId ? { ...m, status: "failed" } : m
            ),
          },
        }));
      }
    },

    editWorkspaceMessage: async (conversationId, messageId, newText) => {
      const trimmed = newText.trim();
      if (!trimmed) return;
      const editedAt = new Date().toISOString();
      set((s) => ({
        editingMessageId: null,
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
            m.id === messageId ? { ...m, plainText: trimmed, editedAt } : m
          ),
        },
      }));
      if (!get().isPreviewMode) {
        await apiV1.editMessage(messageId, trimmed);
      }
    },

    toggleReaction: async (conversationId, messageId, emoji) => {
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: (s.messagesByConv[conversationId] || []).map((m) => {
            if (m.id !== messageId) return m;
            const prev = m.reactions[emoji] || { count: 0, reactedByMe: false };
            const nextReacted = !prev.reactedByMe;
            const nextCount = Math.max(0, prev.count + (nextReacted ? 1 : -1));
            const nextReactions = { ...m.reactions };
            if (nextCount === 0) {
              delete nextReactions[emoji];
            } else {
              nextReactions[emoji] = { count: nextCount, reactedByMe: nextReacted };
            }
            return { ...m, reactions: nextReactions };
          }),
        },
      }));
      if (!get().isPreviewMode) {
        await apiV1.reactToMessage(messageId, emoji).catch(() => {});
      }
    },

    togglePinMessage: async (conversationId, messageId) => {
      const conv = get().conversations[conversationId];
      if (!conv) return;
      const isPinned = conv.pinnedMessageIds.includes(messageId);
      const nextPins = isPinned
        ? conv.pinnedMessageIds.filter((id) => id !== messageId)
        : [messageId, ...conv.pinnedMessageIds];

      set((s) => ({
        conversations: {
          ...s.conversations,
          [conversationId]: { ...conv, pinnedMessageIds: nextPins },
        },
      }));
      if (get().isPreviewMode) return;
      if (isPinned) {
        await apiV1.unpinMessage(conversationId, messageId);
      } else {
        await apiV1.pinMessage(conversationId, messageId);
      }
    },

    togglePinConversation: async (conversationId) => {
      const state = get();
      const conv = state.conversations[conversationId];
      if (!conv || conv.kind === "saved") return;
      const isPinned = state.pinnedConversationIds.includes(conversationId);
      const nextPinned = isPinned
        ? state.pinnedConversationIds.filter((id) => id !== conversationId)
        : [conversationId, ...state.pinnedConversationIds];
      const nextPrefs = {
        ...state.userPreferences,
        pinnedConversationIds: nextPinned,
      };
      set({
        pinnedConversationIds: nextPinned,
        userPreferences: nextPrefs,
      });
      if (!state.isPreviewMode) {
        await apiV1.savePreferences(nextPrefs).catch(() => {});
      }
    },

    createGroup: async (title, memberIds, avatar) => {
      const trimmedTitle = title.trim();
      const peers = Array.from(new Set(memberIds.filter(Boolean)));
      if (!trimmedTitle || peers.length === 0) return null;

      if (get().isPreviewMode) {
        const newId = `conv_grp_${crypto.randomUUID().slice(0, 8)}`;
        const meId = get().currentUser?.id || "usr_owner_1";
        const allMembers = Array.from(new Set([meId, ...peers]));
        const avatarSplit = avatar
          ? splitConversationAvatar("group", { avatarEmoji: avatar }, get().members, allMembers, meId)
          : {};
        set((s) => ({
          conversations: {
            ...s.conversations,
            [newId]: {
              id: newId,
              kind: "group",
              title: trimmedTitle,
              avatarUrl: avatarSplit.avatarUrl,
              avatarEmoji: avatarSplit.avatarEmoji,
              unreadCount: 0,
              mentionCount: 0,
              pinnedMessageIds: [],
              memberIds: allMembers,
              lastMessageText: `${s.currentUser?.displayName || "我"} 创建了群聊「${trimmedTitle}」`,
              lastMessageAt: new Date().toISOString(),
            },
          },
          conversationOrder: [newId, ...s.conversationOrder],
          messagesByConv: {
            ...s.messagesByConv,
            [newId]: [],
          },
          activeConversationId: newId,
        }));
        return newId;
      }

      const res = await apiV1.createGroupConversation(trimmedTitle, peers, avatar);
      const convObj = (res.conversation || res) as Record<string, unknown>;
      const newId = String(convObj.id || "");
      if (!newId) {
        await get().bootstrapWorkspace();
        return null;
      }
      set((s) => {
        const nextMembers = { ...s.members };
        const parsedMemberIds = Array.isArray(convObj.members)
          ? (convObj.members as Array<Record<string, unknown>>)
              .map((m) => upsertRawMemberRecord(nextMembers, m))
              .filter(Boolean)
          : Array.isArray(convObj.memberIds)
          ? convObj.memberIds.map(String).filter(Boolean)
          : Array.from(new Set([s.currentUser?.id || "", ...peers])).filter(Boolean);
        const avatarSplit = splitConversationAvatar(
          "group",
          convObj,
          nextMembers,
          parsedMemberIds,
          s.currentUser?.id
        );
        const nextConv: V1Conversation = {
          id: newId,
          kind: "group",
          title: String(convObj.title || trimmedTitle),
          avatarUrl: avatarSplit.avatarUrl,
          avatarEmoji: avatarSplit.avatarEmoji,
          unreadCount: 0,
          mentionCount: 0,
          pinnedMessageIds: [],
          memberIds: parsedMemberIds,
          lastMessageAt: String(convObj.createdAt || new Date().toISOString()),
        };
        const exists = s.conversationOrder.includes(newId);
        return {
          members: nextMembers,
          conversations: { ...s.conversations, [newId]: nextConv },
          conversationOrder: exists ? s.conversationOrder : [newId, ...s.conversationOrder],
          activeConversationId: newId,
        };
      });
      void get().loadConversationMessages(newId);
      return newId;
    },

    updateGroupProfile: async (conversationId, patch) => {
      const state = get();
      const prevConv = state.conversations[conversationId];
      if (!prevConv || prevConv.kind !== "group") return;

      const optimisticTitle =
        patch.title !== undefined ? patch.title.trim() || prevConv.title : prevConv.title;
      const optimisticAvatar =
        patch.avatar !== undefined
          ? patch.avatar
            ? splitConversationAvatar(
                "group",
                { avatarEmoji: patch.avatar },
                state.members,
                prevConv.memberIds,
                state.currentUser?.id
              )
            : { avatarUrl: undefined, avatarEmoji: undefined }
          : { avatarUrl: prevConv.avatarUrl, avatarEmoji: prevConv.avatarEmoji };

      set((s) => ({
        conversations: {
          ...s.conversations,
          [conversationId]: {
            ...prevConv,
            title: optimisticTitle,
            avatarUrl: optimisticAvatar.avatarUrl,
            avatarEmoji: optimisticAvatar.avatarEmoji,
          },
        },
      }));

      if (state.isPreviewMode) return;

      const res = await apiV1.updateGroupConversation(conversationId, patch);
      const convObj = res.conversation;
      if (convObj && typeof convObj === "object") {
        set((s) => {
          const current = s.conversations[conversationId] || prevConv;
          const nextMembers = { ...s.members };
          const parsedMemberIds = Array.isArray(convObj.members)
            ? (convObj.members as Array<Record<string, unknown>>)
                .map((m) => upsertRawMemberRecord(nextMembers, m))
                .filter(Boolean)
            : current.memberIds;
          const serverAvatar = splitConversationAvatar(
            "group",
            convObj,
            nextMembers,
            parsedMemberIds,
            s.currentUser?.id
          );
          return {
            members: nextMembers,
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...current,
                title: String(convObj.title || optimisticTitle),
                avatarUrl: serverAvatar.avatarUrl,
                avatarEmoji: serverAvatar.avatarEmoji,
                memberIds: parsedMemberIds,
              },
            },
          };
        });
      }
      void get().loadConversationMessages(conversationId);
    },

    uploadGroupAvatar: async (conversationId, file) => {
      if (get().isPreviewMode) {
        const blobUrl = URL.createObjectURL(file);
        await get().updateGroupProfile(conversationId, { avatar: blobUrl });
        return;
      }
      const uploaded = await apiV1.uploadWorkspaceFile(conversationId, file);
      if (typeof uploaded.usedToday === "number") {
        set({ quotaUsedBytes: uploaded.usedToday });
      }
      await get().updateGroupProfile(conversationId, { avatar: uploaded.previewUrl });
    },

    inviteGroupMembers: async (conversationId, userIds) => {
      const cleaned = Array.from(new Set(userIds.filter(Boolean)));
      if (cleaned.length === 0) return;
      const state = get();
      const prevConv = state.conversations[conversationId];
      if (!prevConv || prevConv.kind !== "group") return;

      const mergedIds = Array.from(new Set([...prevConv.memberIds, ...cleaned]));
      set((s) => ({
        conversations: {
          ...s.conversations,
          [conversationId]: {
            ...prevConv,
            memberIds: mergedIds,
          },
        },
      }));

      if (state.isPreviewMode) return;

      const res = await apiV1.addGroupMembers(conversationId, cleaned);
      const convObj = res.conversation;
      if (convObj && typeof convObj === "object") {
        set((s) => {
          const current = s.conversations[conversationId] || prevConv;
          const nextMembers = { ...s.members };
          const parsedMemberIds = Array.isArray(convObj.members)
            ? (convObj.members as Array<Record<string, unknown>>)
                .map((m) => upsertRawMemberRecord(nextMembers, m))
                .filter(Boolean)
            : mergedIds;
          return {
            members: nextMembers,
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...current,
                memberIds: parsedMemberIds,
              },
            },
          };
        });
      }
      void get().loadConversationMessages(conversationId);
    },

    leaveGroup: async (conversationId) => {
      const state = get();
      const prevConv = state.conversations[conversationId];
      if (!prevConv || prevConv.kind !== "group") return;

      if (!state.isPreviewMode) {
        await apiV1.leaveGroupConversation(conversationId);
      }

      set((s) => {
        const nextConversations = { ...s.conversations };
        delete nextConversations[conversationId];
        const nextOrder = s.conversationOrder.filter((id) => id !== conversationId);
        return {
          conversations: nextConversations,
          conversationOrder: nextOrder,
          pinnedConversationIds: s.pinnedConversationIds.filter((id) => id !== conversationId),
          activeConversationId:
            s.activeConversationId === conversationId ? nextOrder[0] || null : s.activeConversationId,
        };
      });
    },

    forwardMessage: async (messageIds, targetConversationId) => {
      if (get().isPreviewMode) return;
      await apiV1.forwardMessages(messageIds, targetConversationId);
    },

    loadThread: async (rootMessageId) => {
      if (get().isPreviewMode) return;
      const res = await apiV1.getThread(rootMessageId);
      set((s) => ({
        threadsByRootId: {
          ...s.threadsByRootId,
          [rootMessageId]: res,
        },
      }));
    },

    sendThreadReply: async (rootMessageId, text, alsoSendToChannel) => {
      if (get().isPreviewMode) {
        const user = get().currentUser;
        const convId = get().activeConversationId || "conv_arch";
        const reply: ThreadReplyItem = {
          id: `tr_${crypto.randomUUID().slice(0, 8)}`,
          conversationId: convId,
          threadRootId: rootMessageId,
          alsoSendToChannel,
          authorId: user?.id || "usr_owner_1",
          authorName: user?.displayName || "我",
          plainText: text,
          createdAt: new Date().toISOString(),
        };
        set((s) => {
          const existing = s.threadsByRootId[rootMessageId] || {
            rootMessageId,
            replyCount: 0,
            replies: [],
          };
          return {
            threadsByRootId: {
              ...s.threadsByRootId,
              [rootMessageId]: {
                ...existing,
                replyCount: existing.replyCount + 1,
                replies: [...existing.replies, reply],
              },
            },
          };
        });
        return;
      }
      const reply: ThreadReplyItem = await apiV1.replyThread(
        rootMessageId,
        text,
        alsoSendToChannel
      );
      set((s) => {
        const existing = s.threadsByRootId[rootMessageId] || {
          rootMessageId,
          replyCount: 0,
          replies: [],
        };
        return {
          threadsByRootId: {
            ...s.threadsByRootId,
            [rootMessageId]: {
              ...existing,
              replyCount: existing.replyCount + 1,
              replies: [...existing.replies, reply],
            },
          },
        };
      });
    },

    triggerCardAction: async (cardId, actionId, payload) => {
      if (get().isPreviewMode) return;
      await apiV1.invokeCardAction(cardId, actionId, payload);
    },

    createP2PRoom: async () => {
      teardownP2PTransport();
      const keyStr = await generateRoomKeyString();
      const { key, fingerprint } = await deriveAesKey(keyStr);

      if (get().isPreviewMode) {
        const previewId = crypto.randomUUID().slice(0, 12);
        const shareUrl = buildP2PShareUrl(previewId, keyStr);
        window.history.replaceState(null, "", `/direct/${previewId}#k=${keyStr}`);
        set({
          p2pAesKey: key,
          p2pRoom: {
            roomId: previewId,
            keyFingerprint: fingerprint,
            connectedPeers: 1,
            remotePeerCount: 0,
            status: "waiting_peer",
            shareUrl,
          },
          p2pMessages: [],
        });
        return shareUrl;
      }

      try {
        const created = await createRemoteP2PRoom();
        const shareUrl = buildP2PShareUrl(created.roomId, keyStr);
        activeP2PRoomToken = `${created.roomId}#${keyStr}`;
        activeP2PJoinPromise = null;
        window.history.replaceState(
          null,
          "",
          `/direct/${encodeURIComponent(created.roomId)}#k=${keyStr}`
        );
        set({
          p2pAesKey: key,
          p2pRoom: {
            roomId: created.roomId,
            keyFingerprint: fingerprint,
            connectedPeers: 1,
            remotePeerCount: 0,
            status: "connecting",
            shareUrl,
            expiresAt: created.expiresAt,
          },
          p2pMessages: [],
        });
        wireP2PSession(created.roomId, key);
        return shareUrl;
      } catch (err) {
        activeP2PRoomToken = "";
        activeP2PJoinPromise = null;
        const errorMessage =
          err instanceof Error
            ? err.message
            : "无法连接 Go P2P 信令服务，请运行 pnpm dev 启动完整服务";
        set({
          p2pAesKey: null,
          p2pRoom: {
            roomId: "未连接",
            keyFingerprint: fingerprint,
            connectedPeers: 0,
            remotePeerCount: 0,
            status: "error",
            shareUrl: "",
            errorMessage,
          },
          p2pMessages: [],
        });
        return "";
      }
    },

    joinP2PRoom: async (roomId, keyStr) => {
      const targetToken = `${roomId}#${keyStr}`;
      if (activeP2PRoomToken === targetToken) {
        if (activeP2PJoinPromise) {
          return activeP2PJoinPromise;
        }
        const existingStatus = get().p2pRoom?.status;
        if (
          get().isPreviewMode ||
          (activeP2PTransport &&
            existingStatus &&
            existingStatus !== "disconnected" &&
            existingStatus !== "error")
        ) {
          return;
        }
      }

      teardownP2PTransport();
      activeP2PRoomToken = targetToken;

      let task: Promise<void> | null = null;
      task = (async () => {
        try {
          const { key, fingerprint } = await deriveAesKey(keyStr);
          if (activeP2PRoomToken !== targetToken) return;
          const shareUrl = buildP2PShareUrl(roomId, keyStr);
          window.history.replaceState(
            null,
            "",
            `/direct/${encodeURIComponent(roomId)}#k=${keyStr}`
          );
          set({
            p2pAesKey: key,
            p2pRoom: {
              roomId,
              keyFingerprint: fingerprint,
              connectedPeers: 1,
              remotePeerCount: 0,
              status: get().isPreviewMode ? "waiting_peer" : "connecting",
              shareUrl,
            },
            p2pMessages: [],
          });
          if (!get().isPreviewMode) {
            wireP2PSession(roomId, key);
          }
        } catch (err) {
          if (activeP2PRoomToken !== targetToken) return;
          activeP2PRoomToken = "";
          scrubP2PRoomFromUrl("/direct");
          set({
            p2pAesKey: null,
            p2pRoom: {
              roomId,
              keyFingerprint: "--",
              connectedPeers: 0,
              remotePeerCount: 0,
              status: "error",
              shareUrl: "",
              errorMessage:
                err instanceof Error ? err.message : "房间加密密钥无效，请核对完整 #k= 邀请链接",
            },
          });
        } finally {
          if (activeP2PJoinPromise === task) {
            activeP2PJoinPromise = null;
          }
        }
      })();

      activeP2PJoinPromise = task;
      return task;
    },

    leaveP2PRoom: () => {
      activeP2PRoomToken = "";
      activeP2PJoinPromise = null;
      queuedP2PFileBytes.clear();
      for (const msg of get().p2pMessages) {
        if (msg.attachment?.blobUrl) {
          try {
            URL.revokeObjectURL(msg.attachment.blobUrl);
          } catch {
            // Ignore revoke errors
          }
        }
      }
      teardownP2PTransport();
      scrubP2PRoomFromUrl("/direct");
      set({
        p2pRoom: null,
        p2pAesKey: null,
        p2pMessages: [],
        p2pDraft: "",
      });
    },

    setP2PDraft: (p2pDraft) => set({ p2pDraft }),

    sendP2PMessage: async (text, replyToId) => {
      const key = get().p2pAesKey;
      const room = get().p2pRoom;
      const trimmed = text.trim();
      if (!key || !room || !trimmed) return;

      // Validate local WebCrypto encryption immediately in RAM
      await encryptP2PPayload(key, trimmed);

      const id = `p2p_${crypto.randomUUID()}`;
      const senderName = get().currentUser?.displayName || "直连节点";
      const createdAt = new Date().toISOString();
      const canSendImmediately =
        room.status === "peer_connected" &&
        room.remotePeerCount > 0 &&
        Boolean(activeP2PTransport?.isOpen());

      const msg: P2PChatMessage = {
        id,
        senderName,
        isOwn: true,
        text: trimmed,
        replyToId,
        createdAt,
        deliveryStatus: canSendImmediately ? "sending" : "queued",
        reactions: {},
      };
      set((s) => ({
        p2pMessages: [...s.p2pMessages, msg],
        p2pDraft: "",
      }));

      if (!canSendImmediately || !activeP2PTransport) {
        return;
      }

      const ok = await activeP2PTransport.sendChat({
        id,
        author: senderName,
        body: trimmed,
        at: createdAt,
        replyToId,
      });
      set((s) => ({
        p2pMessages: s.p2pMessages.map((m) =>
          m.id === id
            ? {
                ...m,
                deliveryStatus: ok
                  ? m.deliveryStatus === "delivered"
                    ? "delivered"
                    : "sent"
                  : "failed",
              }
            : m
        ),
      }));
    },

    sendP2PFile: async (file, caption) => {
      const key = get().p2pAesKey;
      const room = get().p2pRoom;
      if (!key || !room) return;
      if (file.size > P2P_MAX_FILE_BYTES) {
        throw new Error("直连内存模式单文件上限为 8 MB，大文件请使用共享空间传输");
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const mimeType = file.type || "application/octet-stream";
      const blobUrl = createSafeP2PBlobUrl(bytes, mimeType);
      const id = `p2pf_${crypto.randomUUID()}`;
      const senderName = get().currentUser?.displayName || "直连节点";
      const createdAt = new Date().toISOString();
      const trimmedCaption = (caption || "").trim();

      const canSendImmediately =
        room.status === "peer_connected" &&
        room.remotePeerCount > 0 &&
        Boolean(activeP2PTransport?.isOpen());

      const msg: P2PChatMessage = {
        id,
        senderName,
        isOwn: true,
        text: trimmedCaption,
        createdAt,
        deliveryStatus: canSendImmediately ? "sending" : "queued",
        reactions: {},
        attachment: {
          fileName: file.name,
          mimeType,
          byteSize: file.size,
          blobUrl,
        },
      };

      if (!canSendImmediately || !activeP2PTransport) {
        queuedP2PFileBytes.set(id, {
          fileName: file.name,
          mimeType,
          bytes,
          caption: trimmedCaption || undefined,
        });
        set((s) => ({
          p2pMessages: [...s.p2pMessages, msg],
          p2pDraft: "",
        }));
        return;
      }

      set((s) => ({
        p2pMessages: [...s.p2pMessages, msg],
        p2pDraft: "",
      }));

      const ok = await activeP2PTransport.sendFile({
        id,
        author: senderName,
        fileName: file.name,
        mimeType,
        bytes,
        caption: trimmedCaption || undefined,
        at: createdAt,
      });

      set((s) => ({
        p2pMessages: s.p2pMessages.map((m) =>
          m.id === id
            ? {
                ...m,
                deliveryStatus: ok
                  ? m.deliveryStatus === "delivered"
                    ? "delivered"
                    : "sent"
                  : "failed",
              }
            : m
        ),
      }));
    },
  };
});
