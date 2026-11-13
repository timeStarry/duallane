import { create } from "zustand";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import { apiV1, type ThreadReplyItem, type ThreadViewResponse } from "@/shared/lib/api-v1";
import {
  getWorkspaceSyncCursor,
  loadWorkspaceDrafts,
  loadWorkspaceScrolls,
  saveWorkspaceDraft,
  saveWorkspaceScroll,
  setWorkspaceSyncCursor,
} from "@/shared/lib/draft-db";
import {
  deriveAesKey,
  encryptP2PPayload,
  generateRoomKeyString,
  type P2PChatMessage,
  type P2PRoomSession,
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
  width?: number;
  height?: number;
  thumbHash?: string;
  sourceMessageId?: string;
}

export interface V1Message {
  id: string;
  conversationId: string;
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

interface WorkspaceState {
  authStatus: "checking" | "unauthenticated" | "authenticated";
  connectionStatus: "connected" | "reconnecting" | "offline";
  currentUser: V1User | null;
  quotaUsedBytes: number;
  quotaLimitBytes: number;

  conversations: Record<string, V1Conversation>;
  conversationOrder: string[];
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
  acceptInviteAndBootstrap: (inviteCode: string) => Promise<void>;
  logout: () => Promise<void>;
  selectConversation: (conversationId: string) => void;
  loadConversationMessages: (conversationId: string) => Promise<void>;
  jumpToMessage: (conversationId: string, messageId: string) => void;
  setDraft: (conversationId: string, text: string, replyToMessageId?: string) => void;
  setScrollTop: (conversationId: string, scrollTop: number) => void;
  setEditingMessageId: (messageId: string | null) => void;

  sendWorkspaceMessage: (conversationId: string, text: string, replyToId?: string) => Promise<void>;
  editWorkspaceMessage: (conversationId: string, messageId: string, newText: string) => Promise<void>;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  togglePinMessage: (conversationId: string, messageId: string) => Promise<void>;
  forwardMessage: (messageIds: string[], targetConversationId: string) => Promise<void>;
  loadThread: (rootMessageId: string) => Promise<void>;
  sendThreadReply: (rootMessageId: string, text: string, alsoSendToChannel: boolean) => Promise<void>;
  triggerCardAction: (cardId: string, actionId: string, payload?: Record<string, unknown>) => Promise<void>;

  createP2PRoom: () => Promise<string>;
  joinP2PRoom: (roomId: string, keyStr: string) => Promise<void>;
  leaveP2PRoom: () => void;
  setP2PDraft: (text: string) => void;
  sendP2PMessage: (text: string, replyToId?: string) => Promise<void>;
}

function mapRawMessage(
  conversationId: string,
  m: Record<string, unknown>,
  members: Record<string, V1User>
): V1Message {
  const senderId = String(m.authorId || m.senderId || "");
  return {
    id: String(m.id || ""),
    conversationId,
    senderId,
    senderName:
      members[senderId]?.displayName ||
      String(m.authorDisplayName || m.senderName || "成员"),
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
    reactions: {},
    card: m.card as DualLaneCardKitDocument | undefined,
  };
}

export function parseBootstrapPayload(raw: Record<string, unknown>) {
  const authObj = (raw.auth || {}) as Record<string, unknown>;
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
    const id = String(m.id || m.userId || "");
    if (!id) continue;
    members[id] = {
      id,
      displayName: String(m.remark || m.nickname || m.displayName || m.name || id),
      handle: m.githubLogin ? String(m.githubLogin) : m.handle ? String(m.handle) : undefined,
      role: (m.role as V1User["role"]) || "member",
      avatarUrl: m.avatarUrl ? String(m.avatarUrl) : undefined,
    };
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
    conversations[id] = {
      id,
      kind,
      title: kind === "saved" ? "我的收藏" : String(c.title || c.name || "未命名对话"),
      unreadCount: Number(c.unreadCount || 0),
      mentionCount: Number(c.mentionCount || 0),
      pinnedMessageIds: Array.isArray(c.pinnedMessageIds) ? c.pinnedMessageIds.map(String) : [],
      memberIds: Array.isArray(c.memberIds) ? c.memberIds.map(String) : [],
      lastMessageText: c.lastMessageText
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
    const rawMsgs = Array.isArray(c.messages) ? c.messages : [];
    messagesByConv[id] = rawMsgs.map((msg) =>
      mapRawMessage(id, msg as Record<string, unknown>, members)
    );
  }

  const eventCursor = Number(raw.eventCursor || 0);

  return {
    currentUser,
    quotaUsedBytes,
    quotaLimitBytes,
    members,
    conversations,
    conversationOrder,
    messagesByConv,
    eventCursor,
  };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  authStatus: "checking",
  connectionStatus: "connected",
  currentUser: null,
  quotaUsedBytes: 0,
  quotaLimitBytes: 512 * 1024 * 1024,
  conversations: {},
  conversationOrder: [],
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
    try {
      const [drafts, scrollTops, raw] = await Promise.all([
        loadWorkspaceDrafts(),
        loadWorkspaceScrolls(),
        apiV1.getBootstrap(),
      ]);
      const parsed = parseBootstrapPayload(raw);
      if (!parsed.currentUser) {
        set({ authStatus: "unauthenticated", drafts, scrollTops });
        return;
      }

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

      const lastSeq = await getWorkspaceSyncCursor();
      try {
        const syncRes = await apiV1.sync(lastSeq || parsed.eventCursor);
        if (syncRes.currentSeq > lastSeq) {
          await setWorkspaceSyncCursor(syncRes.currentSeq);
        }
      } catch {
        // Non-fatal
      }

      const firstConvId = parsed.conversationOrder[0] || null;
      set({
        authStatus: "authenticated",
        connectionStatus: "connected",
        currentUser: parsed.currentUser,
        quotaUsedBytes: parsed.quotaUsedBytes,
        quotaLimitBytes: parsed.quotaLimitBytes,
        members: parsed.members,
        conversations: parsed.conversations,
        conversationOrder: parsed.conversationOrder,
        messagesByConv: parsed.messagesByConv,
        activeConversationId: firstConvId,
        drafts,
        scrollTops,
      });

      if (firstConvId) {
        void get().loadConversationMessages(firstConvId);
      }
    } catch {
      set({ authStatus: "unauthenticated" });
    }
  },

  acceptInviteAndBootstrap: async (inviteCode) => {
    await apiV1.acceptInvite(inviteCode);
    await get().bootstrapWorkspace();
  },

  logout: async () => {
    await apiV1.logout().catch(() => {});
    set({
      authStatus: "unauthenticated",
      currentUser: null,
      conversations: {},
      conversationOrder: [],
      messagesByConv: {},
      activeConversationId: null,
    });
  },

  loadConversationMessages: async (conversationId) => {
    try {
      const res = await apiV1.listMessages(conversationId);
      if (!Array.isArray(res.messages)) return;
      const members = get().members;
      const mapped = res.messages.map((m) => mapRawMessage(conversationId, m, members));
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: mapped,
        },
      }));
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
    void get().loadConversationMessages(conversationId);
    void apiV1.markConversationRead(conversationId).catch(() => {});
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

  sendWorkspaceMessage: async (conversationId, text, replyToId) => {
    const user = get().currentUser;
    if (!user || !text.trim()) return;
    const tempId = `opt_${crypto.randomUUID()}`;
    const optimistic: V1Message = {
      id: tempId,
      conversationId,
      senderId: user.id,
      senderName: user.displayName,
      plainText: text,
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
    get().setDraft(conversationId, "");

    try {
      const res = await apiV1.sendMessage(conversationId, text, { replyToMessageId: replyToId });
      const msgObj = (res.message || {}) as Record<string, unknown>;
      const realId = msgObj.id ? String(msgObj.id) : tempId;
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [conversationId]: (s.messagesByConv[conversationId] || []).map((m) =>
            m.id === tempId ? { ...m, id: realId, status: "sent" } : m
          ),
        },
        conversations: s.conversations[conversationId]
          ? {
              ...s.conversations,
              [conversationId]: {
                ...s.conversations[conversationId],
                lastMessageText: text,
                lastMessageAt: optimistic.createdAt,
              },
            }
          : s.conversations,
      }));
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
    await apiV1.editMessage(messageId, trimmed);
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
    await apiV1.reactToMessage(messageId, emoji).catch(() => {});
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
    if (isPinned) {
      await apiV1.unpinMessage(conversationId, messageId);
    } else {
      await apiV1.pinMessage(conversationId, messageId);
    }
  },

  forwardMessage: async (messageIds, targetConversationId) => {
    await apiV1.forwardMessages(messageIds, targetConversationId);
  },

  loadThread: async (rootMessageId) => {
    const res = await apiV1.getThread(rootMessageId);
    set((s) => ({
      threadsByRootId: {
        ...s.threadsByRootId,
        [rootMessageId]: res,
      },
    }));
  },

  sendThreadReply: async (rootMessageId, text, alsoSendToChannel) => {
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
    await apiV1.invokeCardAction(cardId, actionId, payload);
  },

  createP2PRoom: async () => {
    const roomId = crypto.randomUUID().slice(0, 12);
    const keyStr = await generateRoomKeyString();
    const { key, fingerprint } = await deriveAesKey(keyStr);
    const shareUrl = `${window.location.origin}/r/${roomId}#k=${keyStr}`;
    window.history.replaceState(null, "", `/r/${roomId}#k=${keyStr}`);
    set({
      p2pAesKey: key,
      p2pRoom: {
        roomId,
        keyFingerprint: fingerprint,
        connectedPeers: 1,
        status: "connected",
        shareUrl,
      },
      p2pMessages: [],
    });
    return shareUrl;
  },

  joinP2PRoom: async (roomId, keyStr) => {
    const { key, fingerprint } = await deriveAesKey(keyStr);
    const shareUrl = `${window.location.origin}/r/${roomId}#k=${keyStr}`;
    set({
      p2pAesKey: key,
      p2pRoom: {
        roomId,
        keyFingerprint: fingerprint,
        connectedPeers: 1,
        status: "connected",
        shareUrl,
      },
    });
  },

  leaveP2PRoom: () =>
    set({
      p2pRoom: null,
      p2pAesKey: null,
      p2pMessages: [],
      p2pDraft: "",
    }),

  setP2PDraft: (p2pDraft) => set({ p2pDraft }),

  sendP2PMessage: async (text, replyToId) => {
    const key = get().p2pAesKey;
    if (!key || !text.trim()) return;
    await encryptP2PPayload(key, text);
    const msg: P2PChatMessage = {
      id: `p2p_${crypto.randomUUID()}`,
      senderName: get().currentUser?.displayName || "本机节点",
      isOwn: true,
      text: text.trim(),
      replyToId,
      createdAt: new Date().toISOString(),
      reactions: {},
    };
    set((s) => ({
      p2pMessages: [...s.p2pMessages, msg],
      p2pDraft: "",
    }));
  },
}));
