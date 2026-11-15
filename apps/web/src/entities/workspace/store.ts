import { create } from "zustand";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import {
  ApiClientError,
  apiV1,
  type DevInviteProfileInput,
  type EmoteCollectionShareSummaryDTO,
  type ThreadReplyItem,
  type ThreadViewResponse,
} from "@/shared/lib/api-v1";
import { emotePacks } from "@/emotes";
import { useEmoteStore } from "@/entities/emote/store";
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
  description?: string;
}

export interface TypingIndicatorEntry {
  userId: string;
  displayName: string;
  kind: "human" | "bot";
  state: "typing" | "thinking";
  expiresAt: number;
}

export interface RecalledDraftEntry {
  text: string;
  replyToId?: string;
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

export type V1MessageBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string }
  | {
      type: "emote_collection";
      shareId: string;
      share?: EmoteCollectionShareSummaryDTO;
    };

export interface V1Message {
  id: string;
  clientMessageId?: string;
  conversationId: string;
  kind?: "user" | "bot" | "system";
  senderId: string;
  senderName: string;
  senderAvatarUrl?: string;
  plainText: string;
  blocks?: V1MessageBlock[];
  replyToId?: string;
  threadRootId?: string;
  threadReplyCount?: number;
  editedAt?: string;
  recalledAt?: string;
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
  peerLastReadAt?: string;
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
  typingByConv: Record<string, TypingIndicatorEntry[]>;
  recalledDrafts: Record<string, RecalledDraftEntry>;

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
  sendCustomSticker: (
    conversationId: string,
    customEmoteId: string,
    replyToId?: string
  ) => Promise<void>;
  sendStickerPackShare: (
    conversationId: string,
    share: EmoteCollectionShareSummaryDTO
  ) => Promise<void>;
  editWorkspaceMessage: (conversationId: string, messageId: string, newText: string) => Promise<void>;
  recallWorkspaceMessage: (conversationId: string, messageId: string) => Promise<void>;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  togglePinMessage: (conversationId: string, messageId: string) => Promise<void>;
  togglePinConversation: (conversationId: string) => Promise<void>;
  updateUserPreferences: (patch: Record<string, unknown>) => Promise<void>;
  createGroup: (title: string, memberIds: string[], avatar?: string) => Promise<string | null>;
  updateGroupProfile: (
    conversationId: string,
    patch: { title?: string; avatar?: string | null }
  ) => Promise<void>;
  uploadGroupAvatar: (conversationId: string, file: File) => Promise<void>;
  inviteGroupMembers: (conversationId: string, userIds: string[]) => Promise<void>;
  removeGroupMember: (conversationId: string, userId: string) => Promise<void>;
  leaveGroup: (conversationId: string) => Promise<void>;
  applyRealtimeEvent: (eventObj: Record<string, unknown>) => void;
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

const unicodeToEmoteKey = new Map<string, string>();
for (const pack of emotePacks) {
  if (pack.id !== "emoji") continue;
  for (const item of pack.items) {
    if (item.kind === "unicode" && item.value) {
      unicodeToEmoteKey.set(item.value, `emoji:${item.id}`);
    }
  }
}

export function normalizeReactionEmoteKey(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed.includes(":")) return trimmed;
  return unicodeToEmoteKey.get(trimmed) || trimmed;
}

function mapRawBlocks(rawContent: unknown): V1MessageBlock[] | undefined {
  if (!rawContent || typeof rawContent !== "object") return undefined;
  const blocksRaw = (rawContent as Record<string, unknown>).blocks;
  if (!Array.isArray(blocksRaw) || blocksRaw.length === 0) return undefined;
  const out: V1MessageBlock[] = [];
  for (const b of blocksRaw as Array<Record<string, unknown>>) {
    const t = String(b.type || "");
    if (t === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (t === "mention" && b.userId) {
      out.push({
        type: "mention",
        userId: String(b.userId),
        label: String(b.label || b.userId),
      });
    } else if (t === "link" && b.url) {
      out.push({
        type: "link",
        url: String(b.url),
        label: b.label ? String(b.label) : undefined,
      });
    } else if (t === "emoji" && b.shortcode) {
      out.push({ type: "emoji", shortcode: String(b.shortcode) });
    } else if (t === "emote_collection" && b.shareId) {
      out.push({
        type: "emote_collection",
        shareId: String(b.shareId),
        share:
          b.share && typeof b.share === "object"
            ? (b.share as EmoteCollectionShareSummaryDTO)
            : undefined,
      });
    }
  }
  return out.length > 0 ? out : undefined;
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

export function computeOwnMessageStatus(
  convKind: V1Conversation["kind"] | undefined,
  peerLastReadAt: string | undefined,
  createdAt: string
): "sent" | "read" {
  if (convKind === "saved") return "read";
  if (peerLastReadAt) {
    const msgMs = Date.parse(createdAt);
    const peerMs = Date.parse(peerLastReadAt);
    if (Number.isFinite(msgMs) && Number.isFinite(peerMs) && msgMs <= peerMs) {
      return "read";
    }
  }
  return "sent";
}

function isMentionBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return /[\s,.;:!?，。；：！？、)）\]】]/u.test(ch);
}

export function buildTextAndMentionBlocks(
  text: string,
  conv: V1Conversation | undefined,
  members: Record<string, V1User>,
  currentUserId?: string
): Array<Record<string, unknown>> {
  if (!text) return [];
  const candidateIds = conv?.memberIds || [];
  const candidates = candidateIds
    .filter((uid) => Boolean(uid && uid !== currentUserId && members[uid]?.displayName))
    .map((uid) => ({ id: uid, displayName: members[uid].displayName.trim() }))
    .filter((item) => item.displayName.length > 0)
    .sort((a, b) => b.displayName.length - a.displayName.length);

  if (candidates.length === 0 || !text.includes("@")) {
    return [{ type: "text", text }];
  }

  const blocks: Array<Record<string, unknown>> = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const atIdx = text.indexOf("@", cursor);
    if (atIdx === -1) break;

    let matched: { id: string; displayName: string } | null = null;
    for (const c of candidates) {
      if (text.startsWith(c.displayName, atIdx + 1)) {
        const nextChar = text[atIdx + 1 + c.displayName.length];
        if (isMentionBoundaryChar(nextChar)) {
          matched = c;
          break;
        }
      }
    }

    if (matched) {
      if (atIdx > textStart) {
        const plainSlice = text.slice(textStart, atIdx);
        if (plainSlice) {
          blocks.push({ type: "text", text: plainSlice });
        }
      }
      blocks.push({
        type: "mention",
        userId: matched.id,
        label: matched.displayName,
      });
      cursor = atIdx + 1 + matched.displayName.length;
      textStart = cursor;
    } else {
      cursor = atIdx + 1;
    }
  }

  if (textStart < text.length) {
    const tail = text.slice(textStart);
    if (tail) {
      blocks.push({ type: "text", text: tail });
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text }];
}

function mapRawMessage(
  conversationId: string,
  m: Record<string, unknown>,
  members: Record<string, V1User>,
  statusContext?: {
    currentUserId?: string;
    convKind?: V1Conversation["kind"];
    peerLastReadAt?: string;
  }
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
  const createdAt = String(m.createdAt || new Date().toISOString());
  const recalledAt =
    typeof m.recalledAt === "string" && m.recalledAt.trim() ? m.recalledAt.trim() : undefined;
  const isOwn = Boolean(statusContext?.currentUserId && senderId === statusContext.currentUserId);
  const resolvedStatus: V1Message["status"] = isOwn
    ? computeOwnMessageStatus(statusContext?.convKind, statusContext?.peerLastReadAt, createdAt)
    : "read";
  const rawAvatar =
    typeof m.authorAvatarUrl === "string" && m.authorAvatarUrl.trim()
      ? m.authorAvatarUrl.trim()
      : typeof authorObj.avatarUrl === "string" && authorObj.avatarUrl.trim()
      ? authorObj.avatarUrl.trim()
      : typeof m.senderAvatarUrl === "string" && m.senderAvatarUrl.trim()
      ? m.senderAvatarUrl.trim()
      : undefined;
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
    senderAvatarUrl: members[senderId]?.avatarUrl || rawAvatar,
    plainText: String(m.plainText || m.text || ""),
    blocks: recalledAt ? [] : mapRawBlocks(m.content),
    replyToId: recalledAt
      ? undefined
      : m.replyToMessageId
      ? String(m.replyToMessageId)
      : m.replyToId
      ? String(m.replyToId)
      : undefined,
    threadRootId: m.threadRootId ? String(m.threadRootId) : undefined,
    threadReplyCount: Number(m.threadReplyCount || m.replyCount || 0),
    editedAt: m.editedAt ? String(m.editedAt) : undefined,
    recalledAt,
    createdAt,
    status: resolvedStatus,
    reactions: recalledAt ? {} : mapRawReactions(m.reactions),
    attachments: recalledAt ? undefined : mapRawAttachments(m.attachments, id),
    card: recalledAt ? undefined : (m.card as DualLaneCardKitDocument | undefined),
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
  const hasExplicitAvatar = "avatarUrl" in m;
  const nextAvatarUrl = hasExplicitAvatar
    ? typeof m.avatarUrl === "string" && m.avatarUrl.trim()
      ? m.avatarUrl.trim()
      : undefined
    : prev?.avatarUrl;
  const nextDescription =
    typeof m.description === "string"
      ? m.description.trim() || undefined
      : prev?.description;
  target[id] = {
    id,
    displayName: resolvedName,
    handle: m.githubLogin
      ? String(m.githubLogin)
      : m.handle
      ? String(m.handle)
      : prev?.handle,
    role,
    avatarUrl: nextAvatarUrl,
    description: nextDescription,
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
    if (!existing.avatarUrl && msg.senderAvatarUrl) {
      target[msg.senderId] = { ...existing, avatarUrl: msg.senderAvatarUrl };
    }
    return;
  }
  if (msg.senderName && msg.senderName !== "成员" && !msg.senderName.startsWith("usr_")) {
    target[msg.senderId] = {
      id: msg.senderId,
      displayName: msg.senderName,
      handle: existing?.handle,
      role: msg.kind === "bot" ? "bot" : existing?.role || "member",
      avatarUrl: existing?.avatarUrl || msg.senderAvatarUrl,
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
    const peerLastReadAt =
      typeof c.peerLastReadAt === "string" && c.peerLastReadAt.trim()
        ? c.peerLastReadAt.trim()
        : undefined;
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
      peerLastReadAt,
    };
    const rawMsgs = Array.isArray(c.latestMessages)
      ? c.latestMessages
      : Array.isArray(c.messages)
      ? c.messages
      : [];
    messagesByConv[id] = rawMsgs.map((msg) => {
      const mapped = mapRawMessage(id, msg as Record<string, unknown>, members, {
        currentUserId: currentUser?.id,
        convKind: kind,
        peerLastReadAt,
      });
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
          get().applyRealtimeEvent(eventObj);
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

  const applyRealtimeEvent = (eventObj: Record<string, unknown>) => {
    const evType = String(eventObj.type || "");
    const payload = (eventObj.payload && typeof eventObj.payload === "object"
      ? eventObj.payload
      : {}) as Record<string, unknown>;

    if (evType === "workspace.member_joined" || evType === "workspace.member_updated") {
      const m = (payload.member || payload) as Record<string, unknown>;
      const id = String(m.id || payload.userId || eventObj.targetId || "");
      if (id) {
        set((s) => {
          const nextMembers = { ...s.members };
          upsertRawMemberRecord(nextMembers, { ...m, id });
          const updatedMember = nextMembers[id];
          let nextConversations = s.conversations;
          if (updatedMember) {
            let changed = false;
            const patchedConvs: Record<string, V1Conversation> = { ...s.conversations };
            for (const [cid, conv] of Object.entries(s.conversations)) {
              if (
                conv.kind === "direct" &&
                conv.memberIds.includes(id) &&
                id !== s.currentUser?.id
              ) {
                patchedConvs[cid] = {
                  ...conv,
                  title: updatedMember.displayName || conv.title,
                  avatarUrl: updatedMember.avatarUrl,
                };
                changed = true;
              }
            }
            if (changed) nextConversations = patchedConvs;
          }
          return {
            members: nextMembers,
            conversations: nextConversations,
            currentUser:
              s.currentUser?.id === id && updatedMember
                ? { ...s.currentUser, ...updatedMember }
                : s.currentUser,
          };
        });
      }
      return;
    }

    if (evType === "emote.library.updated") {
      void useEmoteStore.getState().refreshLibrary(false);
      return;
    }

    if (evType === "conversation.read") {
      const convId = String(payload.conversationId || eventObj.conversationId || "");
      const readerId = String(payload.userId || eventObj.actorId || "");
      const readAt = String(payload.readAt || payload.lastReadAt || eventObj.createdAt || "");
      if (!convId || !readerId || !readAt) return;
      const readMs = Date.parse(readAt);
      if (!Number.isFinite(readMs)) return;

      set((s) => {
        if (s.currentUser?.id && readerId === s.currentUser.id) {
          const prevConv = s.conversations[convId];
          if (!prevConv) return s;
          return {
            conversations: {
              ...s.conversations,
              [convId]: { ...prevConv, unreadCount: 0, mentionCount: 0 },
            },
          };
        }
        const prevConv = s.conversations[convId];
        const prevPeerMs = prevConv?.peerLastReadAt ? Date.parse(prevConv.peerLastReadAt) : 0;
        const nextPeerLastReadAt =
          !Number.isFinite(prevPeerMs) || readMs > prevPeerMs
            ? readAt
            : prevConv?.peerLastReadAt;

        const existingMsgs = s.messagesByConv[convId] || [];
        let msgChanged = false;
        const nextMsgs = existingMsgs.map((msg) => {
          if (
            s.currentUser?.id &&
            msg.senderId === s.currentUser.id &&
            msg.status === "sent"
          ) {
            const mMs = Date.parse(msg.createdAt);
            if (Number.isFinite(mMs) && mMs <= readMs) {
              msgChanged = true;
              return { ...msg, status: "read" as const };
            }
          }
          return msg;
        });

        if (!prevConv && !msgChanged) return s;
        return {
          ...(msgChanged
            ? {
                messagesByConv: {
                  ...s.messagesByConv,
                  [convId]: nextMsgs,
                },
              }
            : {}),
          ...(prevConv
            ? {
                conversations: {
                  ...s.conversations,
                  [convId]: {
                    ...prevConv,
                    peerLastReadAt: nextPeerLastReadAt,
                  },
                },
              }
            : {}),
        };
      });
      return;
    }

    if (evType === "conversation.typing") {
      const convId = String(payload.conversationId || eventObj.conversationId || "");
      const typerId = String(payload.userId || eventObj.actorId || "");
      if (!convId || !typerId) return;
      if (get().currentUser?.id && typerId === get().currentUser?.id) return;

      const parsedExpires = Date.parse(String(payload.expiresAt || ""));
      const expiresAt = Number.isFinite(parsedExpires) ? parsedExpires : Date.now() + 5000;
      const now = Date.now();
      if (expiresAt <= now) return;

      const kind: "human" | "bot" =
        payload.kind === "bot" || get().members[typerId]?.role === "bot" ? "bot" : "human";
      const state: "typing" | "thinking" =
        payload.state === "thinking" ? "thinking" : "typing";
      const displayName = String(
        payload.displayName ||
          get().members[typerId]?.displayName ||
          (kind === "bot" ? "机器人" : "对方")
      );

      set((s) => {
        const currentList = (s.typingByConv[convId] || []).filter(
          (entry) => entry.expiresAt > now && entry.userId !== typerId
        );
        return {
          typingByConv: {
            ...s.typingByConv,
            [convId]: [
              ...currentList,
              { userId: typerId, displayName, kind, state, expiresAt },
            ],
          },
        };
      });

      const cleanupDelay = Math.min(12000, Math.max(250, expiresAt - now + 80));
      setTimeout(() => {
        const ts = Date.now();
        set((s) => {
          const list = s.typingByConv[convId];
          if (!list || list.length === 0) return s;
          const filtered = list.filter((entry) => entry.expiresAt > ts);
          if (filtered.length === list.length) return s;
          const nextTyping = { ...s.typingByConv };
          if (filtered.length === 0) {
            delete nextTyping[convId];
          } else {
            nextTyping[convId] = filtered;
          }
          return { typingByConv: nextTyping };
        });
      }, cleanupDelay);
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
        const peerLastReadAt =
          typeof c.peerLastReadAt === "string" && c.peerLastReadAt.trim()
            ? c.peerLastReadAt.trim()
            : prev?.peerLastReadAt;
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
          peerLastReadAt,
        };

        let nextMessagesByConv = s.messagesByConv;
        if (Array.isArray(c.latestMessages) && c.latestMessages.length > 0) {
          const incoming = (c.latestMessages as Array<Record<string, unknown>>)
            .filter((m) => Boolean(m && m.id))
            .map((m) => {
              const mappedMsg = mapRawMessage(convId, m, nextMembers, {
                currentUserId: s.currentUser?.id,
                convKind: kind,
                peerLastReadAt,
              });
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
                const resolvedStatus =
                  s.currentUser?.id && msg.senderId === s.currentUser.id
                    ? computeOwnMessageStatus(kind, peerLastReadAt, msg.createdAt)
                    : ("read" as const);
                merged[idx] = { ...msg, status: resolvedStatus };
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

    if (
      evType === "message.created" ||
      evType === "message.recalled" ||
      evType === "message.edited"
    ) {
      const rawMsg = (payload.message || {}) as Record<string, unknown>;
      const convId = String(
        rawMsg.conversationId || payload.conversationId || eventObj.conversationId || ""
      );
      if (!convId || !rawMsg.id) return;
      const stateSnap = get();
      const snapConv = stateSnap.conversations[convId];
      const mapped = mapRawMessage(convId, rawMsg, stateSnap.members, {
        currentUserId: stateSnap.currentUser?.id,
        convKind: snapConv?.kind,
        peerLastReadAt: snapConv?.peerLastReadAt,
      });
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
      const isOwnSnap = Boolean(
        stateSnap.currentUser?.id && mapped.senderId === stateSnap.currentUser.id
      );

      if (
        evType === "message.created" &&
        !isOwnSnap &&
        !isSystemMessage &&
        convId === stateSnap.activeConversationId &&
        !stateSnap.isPreviewMode
      ) {
        void apiV1.markConversationRead(convId).catch(() => {});
      }

      set((s) => {
        const prevConv = s.conversations[convId];
        const isOwn = Boolean(s.currentUser?.id && mapped.senderId === s.currentUser.id);
        let nextPeerLastReadAt = prevConv?.peerLastReadAt;
        if (evType === "message.created" && !isOwn && !isSystemMessage) {
          const msgMs = Date.parse(mapped.createdAt);
          const prevMs = nextPeerLastReadAt ? Date.parse(nextPeerLastReadAt) : 0;
          if (Number.isFinite(msgMs) && (!Number.isFinite(prevMs) || msgMs > prevMs)) {
            nextPeerLastReadAt = mapped.createdAt;
          }
        }

        const resolvedMappedStatus: V1Message["status"] = isOwn
          ? computeOwnMessageStatus(prevConv?.kind, nextPeerLastReadAt, mapped.createdAt)
          : "read";

        const existing = s.messagesByConv[convId] || [];
        const matchIndex = existing.findIndex(
          (item) =>
            item.id === mapped.id ||
            (mapped.clientMessageId && item.clientMessageId === mapped.clientMessageId)
        );
        const alreadyExisted = matchIndex >= 0;
        const recalledTimestamp =
          evType === "message.recalled"
            ? mapped.recalledAt || String(eventObj.createdAt || new Date().toISOString())
            : mapped.recalledAt;

        let nextList = alreadyExisted
          ? existing.map((item, idx) =>
              idx === matchIndex
                ? evType === "message.recalled"
                  ? {
                      ...item,
                      ...mapped,
                      recalledAt: recalledTimestamp,
                      blocks: [],
                      reactions: {},
                      attachments: undefined,
                      card: undefined,
                      replyToId: undefined,
                      status: item.status === "read" ? "read" : resolvedMappedStatus,
                    }
                  : {
                      ...item,
                      ...mapped,
                      blocks:
                        mapped.blocks && mapped.blocks.length > 0
                          ? mapped.blocks
                          : [{ type: "text" as const, text: mapped.plainText }],
                      reactions:
                        rawMsg.reactions !== undefined ? mapped.reactions : item.reactions,
                      attachments: mapped.attachments || item.attachments,
                      threadReplyCount:
                        rawMsg.threadReplyCount !== undefined || rawMsg.replyCount !== undefined
                          ? mapped.threadReplyCount
                          : item.threadReplyCount,
                      replyToId: mapped.replyToId || item.replyToId,
                      senderAvatarUrl: mapped.senderAvatarUrl || item.senderAvatarUrl,
                      status: item.status === "read" ? "read" : resolvedMappedStatus,
                    }
                : item
            )
          : [
              ...existing,
              {
                ...mapped,
                recalledAt: recalledTimestamp,
                status: resolvedMappedStatus,
              },
            ];

        if (evType === "message.created" && !isOwn && !isSystemMessage && nextPeerLastReadAt) {
          const peerMs = Date.parse(nextPeerLastReadAt);
          if (Number.isFinite(peerMs)) {
            nextList = nextList.map((item) => {
              if (
                s.currentUser?.id &&
                item.senderId === s.currentUser.id &&
                item.status === "sent" &&
                Date.parse(item.createdAt) <= peerMs
              ) {
                return { ...item, status: "read" as const };
              }
              return item;
            });
          }
        }

        const isActive = convId === s.activeConversationId;
        const baseUnread = prevConv?.unreadCount || 0;
        const nextUnreadCount = isActive
          ? 0
          : typeof serverUnread === "number"
          ? serverUnread
          : evType === "message.created" && !alreadyExisted && !isOwn && !isSystemMessage
          ? baseUnread + 1
          : baseUnread;

        const isLatestInConv =
          evType === "message.created" ||
          nextList[nextList.length - 1]?.id === mapped.id;

        const summaryText =
          evType === "message.recalled"
            ? isOwn
              ? "你撤回了一条消息"
              : `${mapped.senderName} 撤回了一条消息`
            : mapped.plainText;

        const nextConv: V1Conversation = prevConv
          ? {
              ...prevConv,
              lastMessageText: isLatestInConv
                ? summaryText
                : prevConv.lastMessageText,
              lastMessageAt:
                evType === "message.edited" || evType === "message.recalled"
                  ? prevConv.lastMessageAt || mapped.createdAt
                  : mapped.createdAt,
              unreadCount: nextUnreadCount,
              peerLastReadAt: nextPeerLastReadAt,
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
              lastMessageText: summaryText,
              lastMessageAt: mapped.createdAt,
              peerLastReadAt: nextPeerLastReadAt,
            };

        const nextMembers = { ...s.members };
        if (Array.isArray(convPayload?.members)) {
          for (const m of convPayload.members as Array<Record<string, unknown>>) {
            upsertRawMemberRecord(nextMembers, m);
          }
        }
        backfillMemberFromMessage(nextMembers, mapped);

        let nextTypingByConv = s.typingByConv;
        if (evType === "message.created" && s.typingByConv[convId]?.length) {
          const remaining = s.typingByConv[convId].filter(
            (t) => t.userId !== mapped.senderId
          );
          if (remaining.length !== s.typingByConv[convId].length) {
            nextTypingByConv = { ...s.typingByConv };
            if (remaining.length === 0) {
              delete nextTypingByConv[convId];
            } else {
              nextTypingByConv[convId] = remaining;
            }
          }
        }

        return {
          members: nextMembers,
          typingByConv: nextTypingByConv,
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
    typingByConv: {},
    recalledDrafts: {},

    applyRealtimeEvent,

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
          useEmoteStore
            .getState()
            .hydrateTabOrderFromPreferences(cached.userPreferences?.emoteTabOrder);
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
        useEmoteStore.getState().hydrateTabOrderFromPreferences(userPreferences.emoteTabOrder);
        connectWorkspaceRealtime(parsed.eventCursor);
        void setWorkspaceSyncCursor(parsed.eventCursor);
        void useEmoteStore.getState().loadEmoteState(false);

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
        const snap = get();
        const conv = snap.conversations[conversationId];
        const nextMembers = { ...snap.members };
        const mapped = res.messages.map((m) => {
          const msg = mapRawMessage(conversationId, m, nextMembers, {
            currentUserId: snap.currentUser?.id,
            convKind: conv?.kind,
            peerLastReadAt: conv?.peerLastReadAt,
          });
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
      const stateSnap = get();
      const user = stateSnap.currentUser;
      const trimmed = text.trim();
      const attList = attachments && attachments.length > 0 ? attachments : undefined;
      if (!user || (!trimmed && !attList)) return;
      const convSnap = stateSnap.conversations[conversationId];
      const clientMessageId = `cli_${crypto.randomUUID()}`;
      const tempId = `opt_${clientMessageId}`;
      const displayPlain = trimmed || (attList ? "[文件]" : "");
      const parsedBlocks = buildTextAndMentionBlocks(
        trimmed,
        convSnap,
        stateSnap.members,
        user.id
      );
      const optimisticBlocks: V1MessageBlock[] | undefined =
        parsedBlocks.length > 0
          ? (parsedBlocks.map((b) =>
              b.type === "mention"
                ? {
                    type: "mention" as const,
                    userId: String(b.userId),
                    label: String(b.label),
                  }
                : { type: "text" as const, text: String(b.text) }
            ) as V1MessageBlock[])
          : undefined;

      const optimistic: V1Message = {
        id: tempId,
        clientMessageId,
        conversationId,
        senderId: user.id,
        senderName: user.displayName,
        plainText: displayPlain,
        blocks: optimisticBlocks,
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
        const previewStatus = convSnap?.kind === "saved" ? "read" : "sent";
        set((s) => ({
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
              m.id === tempId ? { ...m, status: previewStatus } : m
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
        const requestBlocks: Array<Record<string, unknown>> = [...parsedBlocks];
        for (const a of attList || []) {
          if (a.id) {
            requestBlocks.push({ type: "attachment", attachmentId: a.id });
          }
        }
        const res = await apiV1.sendMessage(conversationId, trimmed, {
          replyToMessageId: replyToId,
          clientMessageId,
          attachmentIds: attList?.map((a) => a.id),
          blocks: requestBlocks.length > 0 ? requestBlocks : undefined,
        });
        const msgObj = (res.message || {}) as Record<string, unknown>;
        const realId = msgObj.id ? String(msgObj.id) : tempId;
        const latestState = get();
        const latestConv = latestState.conversations[conversationId];
        const serverMapped = msgObj.id
          ? mapRawMessage(conversationId, msgObj, latestState.members, {
              currentUserId: user.id,
              convKind: latestConv?.kind,
              peerLastReadAt: latestConv?.peerLastReadAt,
            })
          : null;
        const finalStatus = computeOwnMessageStatus(
          latestConv?.kind,
          latestConv?.peerLastReadAt,
          serverMapped?.createdAt || optimistic.createdAt
        );
        set((s) => {
          const list = s.messagesByConv[conversationId] || [];
          const alreadyDeliveredByWs = list.some((m) => m.id === realId && m.id !== tempId);
          const nextList = alreadyDeliveredByWs
            ? list.filter((m) => m.id !== tempId)
            : list.map((m) =>
                m.id === tempId
                  ? serverMapped
                    ? { ...serverMapped, status: finalStatus }
                    : { ...m, id: realId, status: finalStatus }
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

    sendCustomSticker: async (conversationId, customEmoteId, replyToId) => {
      const user = get().currentUser;
      const cleanedId = customEmoteId.trim();
      if (!user || !cleanedId) return;
      const shortcode = cleanedId.startsWith("custom:") ? cleanedId : `custom:${cleanedId}`;
      const clientMessageId = `cli_${crypto.randomUUID()}`;
      const tempId = `opt_${clientMessageId}`;
      const stickerBlock: V1MessageBlock = { type: "emoji", shortcode };
      const optimistic: V1Message = {
        id: tempId,
        clientMessageId,
        conversationId,
        senderId: user.id,
        senderName: user.displayName,
        plainText: "[表情]",
        blocks: [stickerBlock],
        replyToId,
        createdAt: new Date().toISOString(),
        status: "sending",
        reactions: {},
      };
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: [...(s.messagesByConv[conversationId] || []), optimistic],
        },
      }));

      if (get().isPreviewMode) {
        const previewStatus =
          get().conversations[conversationId]?.kind === "saved" ? "read" : "sent";
        set((s) => ({
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
              m.id === tempId ? { ...m, status: previewStatus } : m
            ),
          },
        }));
        return;
      }

      try {
        const res = await apiV1.sendMessage(conversationId, "[表情]", {
          replyToMessageId: replyToId,
          clientMessageId,
          blocks: [{ type: "emoji", shortcode }],
        });
        const msgObj = (res.message || {}) as Record<string, unknown>;
        const realId = msgObj.id ? String(msgObj.id) : tempId;
        const latestState = get();
        const latestConv = latestState.conversations[conversationId];
        const serverMapped = msgObj.id
          ? mapRawMessage(conversationId, msgObj, latestState.members, {
              currentUserId: user.id,
              convKind: latestConv?.kind,
              peerLastReadAt: latestConv?.peerLastReadAt,
            })
          : null;
        const finalStatus = computeOwnMessageStatus(
          latestConv?.kind,
          latestConv?.peerLastReadAt,
          serverMapped?.createdAt || optimistic.createdAt
        );
        set((s) => {
          const list = s.messagesByConv[conversationId] || [];
          const alreadyDeliveredByWs = list.some((m) => m.id === realId && m.id !== tempId);
          const nextList = alreadyDeliveredByWs
            ? list.filter((m) => m.id !== tempId)
            : list.map((m) =>
                m.id === tempId
                  ? serverMapped
                    ? { ...serverMapped, status: finalStatus }
                    : { ...m, id: realId, status: finalStatus }
                  : m
              );
          return {
            messagesByConv: { ...s.messagesByConv, [conversationId]: nextList },
            conversations: s.conversations[conversationId]
              ? {
                  ...s.conversations,
                  [conversationId]: {
                    ...s.conversations[conversationId],
                    lastMessageText: "[表情]",
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

    sendStickerPackShare: async (conversationId, share) => {
      const user = get().currentUser;
      if (!user || !share?.id) return;
      const clientMessageId = `cli_${crypto.randomUUID()}`;
      const tempId = `opt_${clientMessageId}`;
      const displayPlain = `[表情包] ${share.name}`;
      const shareBlock: V1MessageBlock = {
        type: "emote_collection",
        shareId: share.id,
        share,
      };
      const optimistic: V1Message = {
        id: tempId,
        clientMessageId,
        conversationId,
        senderId: user.id,
        senderName: user.displayName,
        plainText: displayPlain,
        blocks: [shareBlock],
        createdAt: new Date().toISOString(),
        status: "sending",
        reactions: {},
      };
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: [...(s.messagesByConv[conversationId] || []), optimistic],
        },
      }));

      if (get().isPreviewMode) {
        const previewStatus =
          get().conversations[conversationId]?.kind === "saved" ? "read" : "sent";
        set((s) => ({
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
              m.id === tempId ? { ...m, status: previewStatus } : m
            ),
          },
        }));
        return;
      }

      try {
        const res = await apiV1.sendMessage(conversationId, displayPlain, {
          clientMessageId,
          blocks: [{ type: "emote_collection", shareId: share.id }],
        });
        const msgObj = (res.message || {}) as Record<string, unknown>;
        const realId = msgObj.id ? String(msgObj.id) : tempId;
        const latestState = get();
        const latestConv = latestState.conversations[conversationId];
        const serverMapped = msgObj.id
          ? mapRawMessage(conversationId, msgObj, latestState.members, {
              currentUserId: user.id,
              convKind: latestConv?.kind,
              peerLastReadAt: latestConv?.peerLastReadAt,
            })
          : null;
        const finalStatus = computeOwnMessageStatus(
          latestConv?.kind,
          latestConv?.peerLastReadAt,
          serverMapped?.createdAt || optimistic.createdAt
        );
        set((s) => {
          const list = s.messagesByConv[conversationId] || [];
          const alreadyDeliveredByWs = list.some((m) => m.id === realId && m.id !== tempId);
          const nextList = alreadyDeliveredByWs
            ? list.filter((m) => m.id !== tempId)
            : list.map((m) =>
                m.id === tempId
                  ? serverMapped
                    ? { ...serverMapped, status: finalStatus }
                    : { ...m, id: realId, status: finalStatus }
                  : m
              );
          return {
            messagesByConv: { ...s.messagesByConv, [conversationId]: nextList },
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
      const prevMessages = get().messagesByConv[conversationId] || [];
      const prevTarget = prevMessages.find((m) => m.id === messageId);
      const editedAt = new Date().toISOString();
      const updatedBlocks: V1MessageBlock[] = [{ type: "text", text: trimmed }];
      set((s) => {
        const list = (s.messagesByConv[conversationId] || []).map((m) =>
          m.id === messageId
            ? {
                ...m,
                plainText: trimmed,
                blocks: updatedBlocks,
                editedAt,
              }
            : m
        );
        const isLast = list[list.length - 1]?.id === messageId;
        const prevConv = s.conversations[conversationId];
        return {
          editingMessageId: null,
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: list,
          },
          conversations:
            prevConv && isLast
              ? {
                  ...s.conversations,
                  [conversationId]: {
                    ...prevConv,
                    lastMessageText: trimmed,
                  },
                }
              : s.conversations,
        };
      });
      if (!get().isPreviewMode) {
        try {
          await apiV1.editMessage(messageId, trimmed);
        } catch (err) {
          if (prevTarget) {
            set((s) => ({
              messagesByConv: {
                ...s.messagesByConv,
                [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
                  m.id === messageId ? prevTarget : m
                ),
              },
            }));
          }
          useEmoteStore
            .getState()
            .showToast(err instanceof Error ? err.message : "编辑消息失败，请稍后重试");
        }
      }
    },

    recallWorkspaceMessage: async (conversationId, messageId) => {
      const prevMessages = get().messagesByConv[conversationId] || [];
      const prevTarget = prevMessages.find((m) => m.id === messageId);
      if (!prevTarget) return;
      const isOwn = Boolean(
        get().currentUser?.id && prevTarget.senderId === get().currentUser?.id
      );
      const savedText = prevTarget.plainText?.trim() || "";
      const savedDraft: RecalledDraftEntry | undefined =
        isOwn &&
        savedText &&
        savedText !== "[文件]" &&
        savedText !== "[表情]" &&
        !savedText.startsWith("[表情包]")
          ? { text: savedText, replyToId: prevTarget.replyToId }
          : undefined;
      const recalledAt = new Date().toISOString();

      set((s) => {
        const list = (s.messagesByConv[conversationId] || []).map((m) =>
          m.id === messageId
            ? {
                ...m,
                recalledAt,
                blocks: [],
                reactions: {},
                attachments: undefined,
                card: undefined,
                replyToId: undefined,
              }
            : m
        );
        const isLast = list[list.length - 1]?.id === messageId;
        const prevConv = s.conversations[conversationId];
        return {
          editingMessageId: s.editingMessageId === messageId ? null : s.editingMessageId,
          recalledDrafts: savedDraft
            ? { ...s.recalledDrafts, [messageId]: savedDraft }
            : s.recalledDrafts,
          messagesByConv: {
            ...s.messagesByConv,
            [conversationId]: list,
          },
          conversations:
            prevConv && isLast
              ? {
                  ...s.conversations,
                  [conversationId]: {
                    ...prevConv,
                    lastMessageText: isOwn
                      ? "你撤回了一条消息"
                      : `${prevTarget.senderName} 撤回了一条消息`,
                  },
                }
              : s.conversations,
        };
      });

      if (!get().isPreviewMode) {
        try {
          await apiV1.recallMessage(messageId);
        } catch (err) {
          set((s) => ({
            messagesByConv: {
              ...s.messagesByConv,
              [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
                m.id === messageId ? prevTarget : m
              ),
            },
          }));
          useEmoteStore
            .getState()
            .showToast(err instanceof Error ? err.message : "撤回消息失败，请稍后重试");
        }
      }
    },

    toggleReaction: async (conversationId, messageId, emoji) => {
      const normalizedKey = normalizeReactionEmoteKey(emoji);
      if (!normalizedKey) return;
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: (s.messagesByConv[conversationId] || []).map((m) => {
            if (m.id !== messageId) return m;
            const prev = m.reactions[normalizedKey] || { count: 0, reactedByMe: false };
            const nextReacted = !prev.reactedByMe;
            const nextCount = Math.max(0, prev.count + (nextReacted ? 1 : -1));
            const nextReactions = { ...m.reactions };
            if (nextCount === 0) {
              delete nextReactions[normalizedKey];
            } else {
              nextReactions[normalizedKey] = { count: nextCount, reactedByMe: nextReacted };
            }
            return { ...m, reactions: nextReactions };
          }),
        },
      }));
      if (!get().isPreviewMode) {
        await apiV1.reactToMessage(messageId, normalizedKey).catch(() => {});
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

    updateUserPreferences: async (patch) => {
      const state = get();
      const nextPrefs = {
        ...state.userPreferences,
        ...patch,
      };
      set({ userPreferences: nextPrefs });
      saveBootstrapShellCache(get());
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

    removeGroupMember: async (conversationId, userId) => {
      if (!userId) return;
      const state = get();
      const prevConv = state.conversations[conversationId];
      if (!prevConv || prevConv.kind !== "group") return;

      set((s) => ({
        conversations: {
          ...s.conversations,
          [conversationId]: {
            ...prevConv,
            memberIds: prevConv.memberIds.filter((id) => id !== userId),
          },
        },
      }));

      if (state.isPreviewMode) return;

      try {
        await apiV1.removeGroupMember(conversationId, userId);
        void get().loadConversationMessages(conversationId);
      } catch (err) {
        set((s) => ({
          conversations: {
            ...s.conversations,
            [conversationId]: prevConv,
          },
        }));
        throw err;
      }
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
