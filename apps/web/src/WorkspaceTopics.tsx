import { TopicDetails } from "./features/topics/TopicDetails";
import { createWorkspaceMessageCommands } from "./features/conversation/message-commands";
import {
  ArrowLeft,
  ChevronDown,
  Hash,
  MessageSquare,
  Share2,
  UsersRound
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { Switch, type ObjectAction } from "./ui/primitives";
import {
  type WorkspaceComposerDocument,
  type WorkspaceComposerEditorHandle
} from "./WorkspaceComposerEditor";
import { type WorkspaceAutoHidePreferences } from "./workspace-auto-hide";
import { createWorkspaceJsonHeaders } from "./workspace-http";
import { TopicCreateButton, type RegisterTopicNavigationGuard } from "./features/topics/TopicCreateDialog";
import { useTopicSession, type TopicPendingMessage, type WorkspaceTopicSessionStore } from "./features/topics/session";
import { topicMessagesForChat } from "./features/topics/chat-adapter";
import type { WorkspaceConversationMessage } from "./features/conversation/WorkspaceChatPanel";
import type { WorkspaceComposerAttachment, WorkspaceContentBlock, WorkspaceMessage } from "./features/conversation/message-model";
import { prepareWorkspaceMessageContent, workspaceDraftWithReplyMention } from "./features/conversation/message-content";
import type { TopicChatRuntime } from "./features/topics/chat-runtime";
import { getEmoteInsertText, type EmoteItem } from "./emotes";
import { useConfirmation } from "./ui/patterns/ConfirmationProvider";

export type WorkspaceTopic = {
  id: string;
  conversationId: string;
  title: string;
  description?: string;
  descriptionPreview?: string;
  createdBy: string;
  creator: { id: string; displayName: string; githubLogin?: string };
  status: "open" | "closed" | "archived";
  allowSyncToGroup: boolean;
  revision: number;
  participantCount: number;
  joined: boolean;
  canJoin: boolean;
  unreadCount?: number;
  notificationLevel?: WorkspaceTopicNotificationLevel;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceTopicMessageBlock = WorkspaceContentBlock;
export type WorkspaceTopicMessage = Omit<WorkspaceMessage, "conversationId" | "kind" | "attachments" | "reactions"> & {
  topicId: string;
  conversationId?: string;
  kind?: WorkspaceMessage["kind"];
  author?: { id: string; displayName: string; githubLogin?: string; avatarUrl?: string | null };
  attachments?: WorkspaceMessage["attachments"];
  reactions?: WorkspaceMessage["reactions"];
  pendingAttachments?: WorkspaceComposerAttachment[];
  localState?: "uploading" | "sending" | "failed";
  failureReason?: string;
};

export type WorkspaceTopicMember = {
  userId: string;
  displayName: string;
  githubLogin?: string;
  avatarUrl?: string;
  kind?: "human" | "bot" | "system";
};

export type WorkspaceTopicConversation = {
  id: string;
  title: string;
  canCreate?: boolean;
};

export type WorkspaceTopicNotificationLevel = "all" | "mentions" | "muted";
export type WorkspaceTopicFilter = "all" | "joined" | "created" | "unread" | "closed";

export type WorkspaceTopicRefreshSignal = {
  version: number;
  listVersion: number;
  topicVersions: Record<string, number>;
  conversationVersions: Record<string, number>;
  messageChanges?: Record<string, { messageId: string; version: number }>;
};

export type WorkspaceTopicRefreshScope = {
  topicId: string;
  conversationId: string;
  affectsList: boolean;
  messageId?: string;
};

export function workspaceTopicMobilePane(topicId: string): "list" | "main" {
  return topicId ? "main" : "list";
}

export function advanceWorkspaceTopicRefreshSignal(
  current: WorkspaceTopicRefreshSignal,
  scope: WorkspaceTopicRefreshScope
): WorkspaceTopicRefreshSignal {
  const version = current.version + 1;
  return {
    version,
    ...(scope.topicId && scope.messageId ? { messageChanges: { ...current.messageChanges, [scope.topicId]: { messageId: scope.messageId, version } } } : {}),
    listVersion: scope.affectsList ? version : current.listVersion,
    topicVersions: scope.topicId
      ? { ...current.topicVersions, [scope.topicId]: version }
      : current.topicVersions,
    conversationVersions: scope.affectsList && scope.conversationId
      ? { ...current.conversationVersions, [scope.conversationId]: version }
      : current.conversationVersions
  };
}

export function topicRefreshVersionForList(signal: WorkspaceTopicRefreshSignal) {
  return signal.listVersion;
}

export function topicRefreshVersionForTopic(signal: WorkspaceTopicRefreshSignal, topicId: string) {
  return topicId ? signal.topicVersions[topicId] ?? 0 : 0;
}

export function topicRefreshVersionForConversation(
  signal: WorkspaceTopicRefreshSignal,
  conversationId: string
) {
  return conversationId ? signal.conversationVersions[conversationId] ?? 0 : 0;
}

export function shouldAcknowledgeTopicMessages({
  initialLoad,
  documentVisible,
  nearBottom
}: {
  initialLoad: boolean;
  documentVisible: boolean;
  nearBottom: boolean;
}) {
  return documentVisible && (initialLoad || nearBottom);
}

export function isTopicMessageListNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight"> | null,
  threshold = 80
) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function topicMessageKey(message: Pick<WorkspaceTopicMessage, "id" | "clientMessageId">) {
  return message.clientMessageId || message.id;
}

/**
 * Reconcile a server snapshot without replacing the list object when nothing
 * changed. This keeps the message viewport and composer focus stable while a
 * realtime event causes a background refresh.
 */
export function mergeWorkspaceTopicMessages(
  current: WorkspaceTopicMessage[],
  incoming: WorkspaceTopicMessage[]
) {
  const byKey = new Map(incoming.map((message) => [topicMessageKey(message), message]));
  const next = current.map((message) => byKey.get(topicMessageKey(message)) ?? message);
  const currentKeys = new Set(current.map(topicMessageKey));
  incoming.forEach((message) => {
    if (!currentKeys.has(topicMessageKey(message))) next.push(message);
  });
  next.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
  if (next.length === current.length && next.every((message, index) => message === current[index])) return current;
  return next;
}

type TopicProjection = {
  id: string;
  topicMessageId: string;
  removedAt?: string | null;
};

const topicMessageCommands = createWorkspaceMessageCommands(topicJson);

type NoticeTone = "success" | "warning" | "info";

export function WorkspaceTopicRail({
  currentUserId,
  currentUserRole,
  selectedTopicId,
  conversations,
  refreshSignal,
  registerNavigationGuard,
  onOpen
}: {
  currentUserId: string;
  currentUserRole: "owner" | "admin" | "member" | "auditor";
  selectedTopicId: string;
  conversations: WorkspaceTopicConversation[];
  refreshSignal: WorkspaceTopicRefreshSignal;
  registerNavigationGuard?: RegisterTopicNavigationGuard;
  onOpen: (topicId: string) => void;
}) {
  const [topics, setTopics] = useState<WorkspaceTopic[]>([]);
  const [filter, setFilter] = useState<WorkspaceTopicFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshVersion = topicRefreshVersionForList(refreshSignal);
  // Parent-group access can change without a topic event (for example, rejoining).
  const conversationScope = JSON.stringify(conversations.map((conversation) => conversation.id).sort());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void topicJson<{ topics: WorkspaceTopic[] }>("/api/workspace/topics/mine")
      .then((result) => {
        if (!cancelled) {
          setTopics(result.topics);
          setError("");
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(topicErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshVersion, currentUserId, conversationScope]);

  const conversationNames = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation.title])),
    [conversations]
  );
  const visibleTopics = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return topics.filter((topic) => {
      if (!conversationNames.has(topic.conversationId)) return false;
      if (filter === "joined" && !topic.joined) return false;
      if (filter === "created" && topic.createdBy !== currentUserId) return false;
      if (filter === "unread" && !(topic.unreadCount && topic.unreadCount > 0)) return false;
      if (filter === "closed" && topic.status === "open") return false;
      if (filter !== "closed" && topic.status === "archived") return false;
      if (!normalizedQuery) return true;
      return [topic.title, topic.creator.displayName, conversationNames.get(topic.conversationId)]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [conversationNames, currentUserId, filter, query, topics]);

  return (
    <div className="workspace-topic-rail">
      <div className="dl-topic-create-rail"><TopicCreateButton conversations={conversations} canCreate={currentUserRole !== "auditor"} registerNavigationGuard={registerNavigationGuard} onCreated={(created) => { setTopics((current) => [created, ...current.filter((item) => item.id !== created.id)]); onOpen(created.id); }} /></div>
      <label className="workspace-search compact-search">
        <span className="sr-only">查找话题</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="话题、群聊或发起人" />
      </label>
      <div className="workspace-topic-filter" role="tablist" aria-label="话题筛选">
        {([
          ["all", "全部"],
          ["joined", "我参与"],
          ["created", "我发起"],
          ["unread", "未读"],
          ["closed", "已关闭"]
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="workspace-topic-list" aria-busy={loading}>
        {loading ? (
          <TopicListSkeleton />
        ) : error ? (
          <p className="workspace-inline-error" role="alert">{error}</p>
        ) : visibleTopics.length === 0 ? (
          <div className="workspace-rail-section-empty">
            <Hash size={22} />
            <span>{topics.length ? "没有匹配的话题" : "群聊中发起的话题会显示在这里"}</span>
          </div>
        ) : visibleTopics.map((topic) => (
          <button
            type="button"
            key={topic.id}
            className={selectedTopicId === topic.id ? "workspace-topic-row active" : "workspace-topic-row"}
            aria-current={selectedTopicId === topic.id ? "page" : undefined}
            onClick={() => onOpen(topic.id)}
          >
            <span className={`workspace-topic-row-icon ${topic.status}`}><Hash size={15} /></span>
            <span>
              <strong>{topic.title}</strong>
              <small>{conversationNames.get(topic.conversationId) || "群聊"} · {topic.creator.displayName}</small>
            </span>
            <span className="workspace-topic-row-side">
              <time>{formatTopicListTime(topic.updatedAt)}</time>
              {(topic.unreadCount ?? 0) > 0 && <em className="unread-badge">{topic.unreadCount}</em>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceConversationTopicsSection({
  conversationId,
  conversationTitle = "当前群聊",
  currentUserRole,
  canCreate = true,
  refreshSignal,
  registerNavigationGuard,
  onOpen
}: {
  conversationId: string;
  conversationTitle?: string;
  currentUserRole: "owner" | "admin" | "member" | "auditor";
  canCreate?: boolean;
  refreshSignal: WorkspaceTopicRefreshSignal;
  registerNavigationGuard?: RegisterTopicNavigationGuard;
  onOpen: (topicId: string) => void;
}) {
  const [topics, setTopics] = useState<WorkspaceTopic[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const refreshVersion = topicRefreshVersionForConversation(refreshSignal, conversationId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void topicJson<{ topics: WorkspaceTopic[] }>(`/api/workspace/conversations/${encodeURIComponent(conversationId)}/topics`)
      .then((result) => {
        if (!cancelled) setTopics(result.topics.filter((topic) => topic.status !== "archived"));
      })
      .catch((caught) => {
        if (!cancelled) setError(topicErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [conversationId, refreshVersion, retryVersion]);

  const visibleTopics = expanded ? topics : topics.slice(0, 3);
  return (
    <section className="workspace-conversation-topics" aria-label="本群话题">
      <div className="workspace-context-section-header">
        <span><Hash size={15} />本群话题</span>
        <span className="workspace-context-section-actions">
          <small>{topics.length} 个</small>
          {topics.length > 3 && (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "查看全部"}
            </button>
          )}
        </span>
      </div>
      <div className="dl-topic-create-rail"><TopicCreateButton conversations={[{ id: conversationId, title: conversationTitle, canCreate }]} conversationId={conversationId} canCreate={currentUserRole !== "auditor" && canCreate} registerNavigationGuard={registerNavigationGuard} onCreated={(created) => { setTopics((current) => [created, ...current.filter((item) => item.id !== created.id)]); onOpen(created.id); }} /></div>
      {loading ? (
        <p className="workspace-conversation-topic-state" aria-busy="true">正在加载话题...</p>
      ) : error ? (
        <div className="workspace-conversation-topic-state error" role="alert">
          <span>{error}</span>
          <button className="secondary" type="button" onClick={() => setRetryVersion((version) => version + 1)}>重试</button>
        </div>
      ) : visibleTopics.length === 0 ? (
        <p className="saved-empty">在群聊开头输入 #[标题](正文) 发起话题。</p>
      ) : (
        <div className="workspace-conversation-topic-list">
          {visibleTopics.map((topic) => (
            <button type="button" key={topic.id} onClick={() => onOpen(topic.id)}>
              <Hash size={14} />
              <span><strong>{topic.title}</strong><small>{topic.participantCount} 人参与</small></span>
              {(topic.unreadCount ?? 0) > 0 && <em className="unread-badge">{topic.unreadCount}</em>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkspaceTopicPage({
  chatRuntime,
  locateMessageId,
  onLocateHandled,
  sessionStore,
  topicId,
  currentUserId,
  currentUserDisplayName,
  currentUserRole,
  conversations,
  refreshSignal,
  documentVisible,
  onBack,
  onOpenConversation,
  onNotice
}: {
  chatRuntime: TopicChatRuntime;
  locateMessageId?: string;
  onLocateHandled?: () => void;
  autoHidePreferences?: WorkspaceAutoHidePreferences | null;
  sessionStore: WorkspaceTopicSessionStore;
  topicId: string;
  currentUserId: string;
  currentUserDisplayName: string;
  currentUserRole: "owner" | "admin" | "member" | "auditor";
  conversations: WorkspaceTopicConversation[];
  refreshSignal: WorkspaceTopicRefreshSignal;
  documentVisible: boolean;
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
  onNotice: (tone: NoticeTone, message: string) => void;
}) {
  const { confirm } = useConfirmation();
  const cancelledMessagesRef = useRef(new Set<string>());
  const [historyTargetId, setHistoryTargetId] = useState("");
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [reactionPendingKeys, setReactionPendingKeys] = useState<string[]>([]);
  const commandLocks = useRef(new Set<string>());
  const [topic, setTopic] = useState<WorkspaceTopic | null>(null);
  const [messages, setMessages] = useState<WorkspaceTopicMessage[]>([]);
  const [members, setMembers] = useState<WorkspaceTopicMember[]>([]);
  const [projections, setProjections] = useState<TopicProjection[]>([]);
  const session = useTopicSession(sessionStore, topicId);
  const { draft, syncToGroup, replyToMessageId, pending: pendingMessages } = session;
  const setDraft = (value: WorkspaceComposerDocument) => sessionStore.edit(topicId, { draft: value });
  const setReplyToMessageId = (value: string) => {
    const reply = messages.find((message) => message.id === value);
    sessionStore.edit(topicId, {
      replyToMessageId: value,
      draft: workspaceDraftWithReplyMention(sessionStore.get(topicId).draft, {
        enabled: Boolean(chatRuntime.replyAutoMention), currentUserId, replyAuthorId: reply?.authorId,
        members: members.map((member) => ({ id: member.userId, displayName: member.displayName, kind: member.kind }))
      })
    });
  };
  const setSyncToGroup = (value: boolean) => sessionStore.edit(topicId, { syncToGroup: value });
  const [loading, setLoading] = useState(Boolean(topicId));
  const sending = Object.values(pendingMessages).some((message) => (message.localState === "sending" || message.localState === "uploading"));
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const editorRef = useRef<WorkspaceComposerEditorHandle | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const snapshotReadyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const documentVisibleRef = useRef(documentVisible);
  documentVisibleRef.current = documentVisible;
  const lastReadMessageIdRef = useRef("");
  const readInFlightRef = useRef(false);
  const queuedReadRef = useRef<{ topic: WorkspaceTopic; messageId: string; generation: number } | null>(null);
  const refreshVersion = topicRefreshVersionForTopic(refreshSignal, topicId);

  const group = conversations.find((conversation) => conversation.id === topic?.conversationId);
  const displayMessages = useMemo(
    () => mergeWorkspaceTopicMessages(messages, Object.values(pendingMessages)),
    [messages, pendingMessages]
  );
  const chatMessages = useMemo(() => topicMessagesForChat(displayMessages, currentUserId), [displayMessages, currentUserId]);
  const replyTarget = chatMessages.find((message) => message.id === replyToMessageId) ?? null;
  const projectedMessageIds = useMemo(
    () => new Set(projections.filter((projection) => !projection.removedAt).map((projection) => projection.topicMessageId)),
    [projections]
  );
  const readOnly = currentUserRole === "auditor" || topic?.status !== "open";
  function retryMessage(messageId: string) {
    const pending = Object.values(sessionStore.get(topicId).pending).find((message) => message.id === messageId);
    if (pending) void submitTopicMessage(pending);
  }
  function topicMessageActions(message: WorkspaceConversationMessage, defaults: ObjectAction[]): ObjectAction[] {
    if (!topic?.joined) return [];
    const actions = [...defaults];
    if (!readOnly && !message.localState && !message.recalledAt && topic.allowSyncToGroup) actions.push({ id: "sync", label: projectedMessageIds.has(message.id) ? "取消同步到群聊" : "同步到群聊", icon: <Share2 size={16} />, disabled: busyAction === `sync:${message.id}`, onSelect: () => void toggleProjection(message.id) });
    return actions;
  }

  async function markTopicRead(readTopic: WorkspaceTopic, messageId: string, generation: number) {
    if (!readTopic.joined || readTopic.id !== topicId || generation !== loadGenerationRef.current || !documentVisibleRef.current || !messageId || messageId === lastReadMessageIdRef.current) return;
    if (readInFlightRef.current) {
      queuedReadRef.current = { topic: readTopic, messageId, generation };
      return;
    }
    readInFlightRef.current = true;
    try {
      await topicJson(`/api/workspace/topics/${encodeURIComponent(readTopic.id)}/read`, { method: "POST", body: JSON.stringify({ messageId }) });
      if (generation === loadGenerationRef.current) lastReadMessageIdRef.current = messageId;
    } catch {
      // Keep the last confirmed cursor; another visible scroll/refresh can retry.
    } finally {
      if (generation === loadGenerationRef.current) {
        readInFlightRef.current = false;
        const queued = queuedReadRef.current;
        queuedReadRef.current = null;
        if (queued && queued.messageId !== messageId) void markTopicRead(queued.topic, queued.messageId, queued.generation);
      }
    }
  }

  function acknowledgeVisibleTopicMessages() {
    const latest = messages.at(-1);
    if (topic?.id === topicId && topic.joined && latest && isTopicMessageListNearBottom(messageListRef.current)) {
      void markTopicRead(topic, latest.id, loadGenerationRef.current);
    }
  }

  function revokeTopicAccess(message = "你已无法访问此话题。") {
    loadGenerationRef.current += 1;
    const pending = Object.values(sessionStore.get(topicId).pending);
    for (const item of pending) {
      if (item.clientMessageId) cancelledMessagesRef.current.add(item.clientMessageId);
      chatRuntime.cancelUploads(item.pendingAttachments ?? []);
      item.pendingAttachments?.forEach((attachment) => { if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl); });
    }
    chatRuntime.stagedAttachments.forEach((attachment) => chatRuntime.removeStagedAttachment(attachment.id));
    sessionStore.update(topicId, (current) => ({ ...current, draft: { source: "", blocks: [] }, draftRevision: current.draftRevision + 1, replyToMessageId: "", pending: {} }));
    setMessages([]);
    setMembers([]);
    setProjections([]);
    setTopic(null);
    setLoading(false);
    setError(message);
  }

  useEffect(() => {
    if (topic?.id === topicId && !group) revokeTopicAccess("你已不在此话题所属的群聊中。");
  }, [topic?.id, topic?.conversationId, topicId, group?.id]);

  async function loadTopicSnapshot(generation: number, initialLoad: boolean) {
    if (!topicId) return;
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topicId)}`);
      if (generation !== loadGenerationRef.current) return;
      sessionStore.bindConversation(topicId, result.topic.conversationId);
      setTopic((current) => sameWorkspaceTopic(current, result.topic) ? current : result.topic);
      if (!result.topic.joined) {
        setMessages([]);
        setMembers([]);
        setProjections([]);
        snapshotReadyRef.current = true;
        return;
      }
      const [messageResult, memberResult, projectionResult] = await Promise.all([
        topicJson<{ messages: WorkspaceTopicMessage[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/messages?limit=100`),
        topicJson<{ members: WorkspaceTopicMember[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/members`),
        topicJson<{ projections: TopicProjection[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/projections`).catch(() => ({ projections: [] }))
      ]);
      if (generation !== loadGenerationRef.current) return;
      const changedMessageId = refreshSignal.messageChanges?.[topicId]?.messageId;
      if (!initialLoad && changedMessageId && messages.some((message) => message.id === changedMessageId) && !messageResult.messages.some((message) => message.id === changedMessageId)) {
        const changed = await topicJson<{ messages: WorkspaceTopicMessage[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/messages?around=${encodeURIComponent(changedMessageId)}&limit=1`);
        if (generation !== loadGenerationRef.current) return;
        messageResult.messages.unshift(...changed.messages);
        if (!changed.messages.length) setMessages((current) => current.filter((message) => message.id !== changedMessageId));
      }
      if (initialLoad) setHistoryAvailable(messageResult.messages.length >= 100);
      messageResult.messages.forEach((message) => {
        const pending = message.clientMessageId ? sessionStore.get(topicId).pending[message.clientMessageId] : undefined;
        if (pending) sessionStore.acknowledge(topicId, message.clientMessageId!, pending.submission.draftRevision);
      });
      const shouldAcknowledge = shouldAcknowledgeTopicMessages({
        initialLoad: initialLoad && sessionStore.get(topicId).scrollTop === null,
        documentVisible: documentVisibleRef.current,
        nearBottom: initialLoad && sessionStore.get(topicId).scrollTop !== null ? sessionStore.get(topicId).nearBottom : isTopicMessageListNearBottom(messageListRef.current)
      });
      if (!initialLoad && !shouldAcknowledge) {
        const latestCreatedAt = Date.parse(messages.at(-1)?.createdAt ?? "");
        const known = new Set(messages.map((message) => message.id));
        const added = messageResult.messages.filter((message) => !known.has(message.id) && Date.parse(message.createdAt) >= latestCreatedAt && message.authorId !== currentUserId).length;
        if (added) setNewMessageCount((count) => count + added);
      }
      setMessages((current) => initialLoad ? mergeWorkspaceTopicMessages([], messageResult.messages) : mergeWorkspaceTopicMessages(current, messageResult.messages));
      setMembers((current) => sameTopicMembers(current, memberResult.members) ? current : memberResult.members);
      setProjections((current) => sameTopicProjections(current, projectionResult.projections) ? current : projectionResult.projections);
      snapshotReadyRef.current = true;
      const latest = shouldAcknowledge ? messageResult.messages.at(-1) : null;
      if (latest) void markTopicRead(result.topic, latest.id, generation);
      if (initialLoad && sessionStore.get(topicId).scrollTop !== null && !sessionStore.get(topicId).nearBottom) {
        window.requestAnimationFrame(() => { if (generation === loadGenerationRef.current && messageListRef.current) messageListRef.current.scrollTop = sessionStore.get(topicId).scrollTop ?? 0; });
      } else if (shouldAcknowledge || stickToBottomRef.current) scrollTopicMessagesToBottom();
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      if (caught instanceof TopicApiError && [401, 403, 404].includes(caught.status)) revokeTopicAccess(topicErrorMessage(caught));
      else if (initialLoad) setError(topicErrorMessage(caught));
    } finally {
      if (initialLoad && generation === loadGenerationRef.current) setLoading(false);
    }
  }

  async function refreshTopicSnapshot() {
    if (!topicId || !snapshotReadyRef.current) return;
    const generation = loadGenerationRef.current;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      await loadTopicSnapshot(generation, false);
    } finally {
      if (generation !== loadGenerationRef.current) return;
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshTopicSnapshot();
      }
    }
  }

  function scrollTopicMessagesToBottom(acknowledge = false) {
    const generation = loadGenerationRef.current;
    window.requestAnimationFrame(() => {
      if (generation !== loadGenerationRef.current) return;
      if (messageListRef.current) messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
      if (acknowledge) acknowledgeVisibleTopicMessages();
    });
  }

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    snapshotReadyRef.current = false;
    setError("");
    setTopic(null);
    setMessages([]);
    setMembers([]);
    setProjections([]);
    setBusyAction("");
    setHistoryLoading(false);
    setHistoryAvailable(false);
    setHistoryTargetId("");
    setNewMessageCount(0);
    lastReadMessageIdRef.current = "";
    readInFlightRef.current = false;
    queuedReadRef.current = null;
    const restored = sessionStore.get(topicId);
    stickToBottomRef.current = restored.nearBottom;
    refreshQueuedRef.current = false;
    refreshInFlightRef.current = false;
    if (!topicId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadTopicSnapshot(generation, true);
    return () => { loadGenerationRef.current += 1; };
  }, [topicId, sessionStore]);

  useEffect(() => {
    if (!topicId || !snapshotReadyRef.current) return;
    void refreshTopicSnapshot();
  }, [refreshVersion, topicId]);

  useEffect(() => {
    // A send can settle after leaving and re-entering the same topic. Its old
    // component generation must not write the view, but this generation must
    // reconcile the server result once the session-owned pending item settles.
    if (!sending && snapshotReadyRef.current) {
      refreshQueuedRef.current = false;
      void refreshTopicSnapshot();
    }
  }, [sending, topicId]);

  useEffect(() => {
    if (documentVisible && snapshotReadyRef.current) acknowledgeVisibleTopicMessages();
  }, [documentVisible]);

  useEffect(() => {
    if (!loading && topic?.id === topicId && topic.joined && locateMessageId) {
      void jumpToMessage(locateMessageId).finally(() => onLocateHandled?.());
    }
  }, [loading, topic?.id, topic?.joined, topicId, locateMessageId]);

  async function joinTopic() {
    if (!topic) return;
    const generation = loadGenerationRef.current;
    setBusyAction("join");
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/join`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (generation !== loadGenerationRef.current) return;
      setTopic(result.topic);
      snapshotReadyRef.current = true;
      void refreshTopicSnapshot();
      onNotice("success", "已加入话题");
    } catch (caught) {
      if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setBusyAction("");
    }
  }

  async function leaveTopic() {
    if (!topic) return;
    const generation = loadGenerationRef.current;
    setBusyAction("leave");
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/leave`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (generation !== loadGenerationRef.current) return;
      setTopic(result.topic);
      setMessages([]);
      setMembers([]);
      onNotice("success", "已退出话题");
    } catch (caught) {
      if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setBusyAction("");
    }
  }

  async function updateNotification(notificationLevel: WorkspaceTopicNotificationLevel) {
    if (!topic || busyAction === "notification") return;
    const generation = loadGenerationRef.current;
    setBusyAction("notification");
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/notification`, {
        method: "PATCH",
        body: JSON.stringify({ notificationLevel })
      });
      if (generation === loadGenerationRef.current) setTopic(result.topic);
    } catch (caught) {
      if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setBusyAction("");
    }
  }

  async function transitionTopic(action: "close" | "archive") {
    if (!topic) return;
    const generation = loadGenerationRef.current;
    setBusyAction(action);
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: topic.revision })
      });
      if (generation !== loadGenerationRef.current) return;
      setTopic(result.topic);
      onNotice("success", action === "close" ? "话题已关闭" : "话题已归档");
    } catch (caught) {
      if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setBusyAction("");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendDocument(draft, false);
  }

  async function sendImageEmote(item: EmoteItem) {
    if (item.kind !== "image") return;
    const token = getEmoteInsertText(item);
    await sendDocument({ source: token, blocks: [{ type: "emote", token, item }] }, true);
  }

  async function sendDocument(document: WorkspaceComposerDocument, immediate: boolean) {
    if (!topic || topic.id !== topicId || !topic.joined || readOnly) return;
    const snapshot = sessionStore.get(topic.id);
    const claimedAttachments = new Set(Object.values(snapshot.pending).flatMap((message) => message.pendingAttachments?.map((attachment) => attachment.id) ?? []));
    const stagedAttachments = immediate ? [] : chatRuntime.stagedAttachments.filter((attachment) => !claimedAttachments.has(attachment.id));
    const sourceDocument = immediate ? document : snapshot.draft;
    if (!hasTopicDraftContent(sourceDocument) && stagedAttachments.length === 0) return;
    try {
      const prepared = prepareWorkspaceMessageContent(sourceDocument, stagedAttachments);
      if (!prepared) return;
      if (prepared.attachments.length && !chatRuntime.canUpload) { onNotice("warning", "当前无法上传附件，草稿已保留。"); return; }
      const clientMessageId = topicClientId();
      const pending: TopicPendingMessage = {
        ...optimisticTopicMessage({ topic, currentUserId, currentUserDisplayName, clientMessageId, blocks: prepared.blocks, replyToMessageId: replyToMessageId || null }),
        plainText: prepared.body,
        content: { format: "duallane.message+json;v=1", plainText: prepared.body, blocks: prepared.blocks },
        pendingAttachments: prepared.attachments.length ? prepared.attachments : undefined,
        localState: prepared.attachments.length ? "uploading" : "sending",
        submission: { draftRevision: snapshot.draftRevision, preserveDraft: immediate, syncToGroup: snapshot.syncToGroup && topic.allowSyncToGroup }
      };
      pending.replyToMessageId = snapshot.replyToMessageId || null;
      if (!sessionStore.enqueue(topic.id, pending)) return;
      if (!immediate) chatRuntime.takeStagedAttachments();
      await submitTopicMessage(pending);
    } catch (caught) { onNotice("warning", topicErrorMessage(caught)); }
  }

  async function submitTopicMessage(pending: TopicPendingMessage) {
    if (!topic || topic.id !== pending.topicId || !topic.joined || readOnly) return;
    const targetTopicId = pending.topicId;
    const conversationId = topic.conversationId;
    const clientMessageId = pending.clientMessageId!;
    const sendGeneration = loadGenerationRef.current;
    const claimed = sessionStore.claimDelivery(targetTopicId, clientMessageId);
    if (!claimed) return;
    pending = claimed;
    let ready = { ...pending, localState: pending.pendingAttachments?.length ? "uploading" as const : "sending" as const, failureReason: undefined };
    sessionStore.update(targetTopicId, (current) => ({ ...current, pending: { ...current.pending, [clientMessageId]: ready } }));
    if (stickToBottomRef.current) scrollTopicMessagesToBottom();
    try {
      if (pending.pendingAttachments?.length) {
        const shouldCancel = () => cancelledMessagesRef.current.has(clientMessageId) || !sessionStore.get(targetTopicId).pending[clientMessageId];
        const uploaded = await chatRuntime.uploadAttachments(conversationId, pending.pendingAttachments, (id, update) => {
          sessionStore.update(targetTopicId, (current) => {
            const active = current.pending[clientMessageId];
            return active ? { ...current, pending: { ...current.pending, [clientMessageId]: { ...active, pendingAttachments: active.pendingAttachments?.map((attachment) => attachment.id === id ? update(attachment) : attachment) } } } : current;
          });
        }, shouldCancel);
        if (shouldCancel()) { await chatRuntime.removeUploadedAttachments(uploaded); return; }
        if (uploaded.length !== pending.pendingAttachments.length) throw new Error("文件上传失败，消息尚未发送");
        ready = { ...ready, attachments: uploaded, pendingAttachments: undefined, content: { ...ready.content, blocks: [...ready.content.blocks.filter((block) => block.type !== "attachment"), ...uploaded.map((attachment) => ({ type: "attachment" as const, attachmentId: attachment.id }))] }, localState: "sending" };
        sessionStore.update(targetTopicId, (current) => ({ ...current, pending: { ...current.pending, [clientMessageId]: ready } }));
        pending.pendingAttachments.forEach((attachment) => { if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl); });
      }
      const message = await chatRuntime.submitMessage({ conversationId, topicId: targetTopicId, clientMessageId, replyToMessageId: ready.replyToMessageId, body: ready.plainText, blocks: ready.content.blocks, syncToGroup: ready.submission.syncToGroup });
      sessionStore.acknowledge(targetTopicId, clientMessageId, pending.submission.draftRevision);
      if (sendGeneration === loadGenerationRef.current) {
        setMessages((current) => mergeWorkspaceTopicMessages(current, [{ ...message, topicId: targetTopicId, clientMessageId }]));
      }
    } catch (caught) {
      sessionStore.update(targetTopicId, (current) => current.pending[clientMessageId]
        ? { ...current, pending: { ...current.pending, [clientMessageId]: { ...current.pending[clientMessageId], localState: "failed", failureReason: topicErrorMessage(caught) } } }
        : current);
      if (sendGeneration === loadGenerationRef.current && !cancelledMessagesRef.current.has(clientMessageId)) onNotice("warning", topicErrorMessage(caught));
    } finally {
      sessionStore.finishDelivery(targetTopicId, clientMessageId);
      cancelledMessagesRef.current.delete(clientMessageId);
      if (sendGeneration === loadGenerationRef.current) {
        if (refreshQueuedRef.current) { refreshQueuedRef.current = false; void refreshTopicSnapshot(); }
      }
    }
  }

  async function cancelMessage(messageId: string) {
    const pending = Object.values(sessionStore.get(topicId).pending).find((message) => message.id === messageId);
    if (!pending || !pending.pendingAttachments?.length) return;
    cancelledMessagesRef.current.add(pending.clientMessageId!);
    chatRuntime.cancelUploads(pending.pendingAttachments);
    sessionStore.update(topicId, (current) => {
      const { [pending.clientMessageId!]: _cancelled, ...rest } = current.pending;
      return { ...current, pending: rest };
    });
    pending.pendingAttachments.forEach((attachment) => { if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl); });
    if (pending.localState !== "uploading") {
      await chatRuntime.removeUploadedAttachments(pending.pendingAttachments.flatMap((attachment) => attachment.attachment ? [attachment.attachment] : []));
      cancelledMessagesRef.current.delete(pending.clientMessageId!);
    }
  }

  async function messageCommand(key: string, command: () => Promise<unknown>, messageIds: string[]) {
    if (commandLocks.current.has(key)) return;
    const generation = loadGenerationRef.current;
    commandLocks.current.add(key);
    setReactionPendingKeys([...commandLocks.current]);
    try {
      await command();
      if (generation !== loadGenerationRef.current) return;
      const windows = await Promise.all(messageIds.map((id) => topicJson<{ messages: WorkspaceTopicMessage[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/messages?around=${encodeURIComponent(id)}&limit=1`)));
      if (generation !== loadGenerationRef.current) return;
      const updates = windows.flatMap((window) => window.messages);
      const retainedIds = new Set(updates.map((message) => message.id));
      setMessages((current) => mergeWorkspaceTopicMessages(current.filter((message) => !messageIds.includes(message.id) || retainedIds.has(message.id)), updates));
      await refreshTopicSnapshot();
    }
    catch (caught) { if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught)); }
    finally { commandLocks.current.delete(key); if (generation === loadGenerationRef.current) setReactionPendingKeys([...commandLocks.current]); }
  }

  async function loadOlderMessages() {
    if (historyLoading || !historyAvailable || !messages.length) return;
    const generation = loadGenerationRef.current;
    const list = messageListRef.current;
    const anchor = list?.querySelector<HTMLElement>("[data-message-id]");
    const offset = anchor?.getBoundingClientRect().top;
    setHistoryLoading(true);
    try {
      const result = await topicJson<{ messages: WorkspaceTopicMessage[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/messages?limit=100&before=${encodeURIComponent(messages[0].id)}`);
      if (generation !== loadGenerationRef.current) return;
      setMessages((current) => mergeWorkspaceTopicMessages(current, result.messages));
      setHistoryAvailable(result.messages.length >= 100);
      window.requestAnimationFrame(() => { if (generation === loadGenerationRef.current && list && anchor?.isConnected && offset !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - offset; });
    } catch (caught) { if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught)); }
    finally { if (generation === loadGenerationRef.current) setHistoryLoading(false); }
  }

  async function toggleProjection(messageId: string) {
    if (!topic || readOnly || !topic.allowSyncToGroup) return;
    const generation = loadGenerationRef.current;
    const synced = projectedMessageIds.has(messageId);
    setBusyAction(`sync:${messageId}`);
    try {
      const result = await topicJson<{ projection: TopicProjection | null }>(
        `/api/workspace/topics/${encodeURIComponent(topic.id)}/messages/${encodeURIComponent(messageId)}/sync`,
        { method: synced ? "DELETE" : "POST", body: synced ? undefined : JSON.stringify({}) }
      );
      if (generation !== loadGenerationRef.current) return;
      setProjections((current) => {
        const without = current.filter((projection) => projection.topicMessageId !== messageId);
        return result.projection ? [...without, result.projection] : without;
      });
      onNotice("success", synced ? "已取消同步" : "已同步到群聊");
    } catch (caught) {
      if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setBusyAction("");
    }
  }

  async function jumpToMessage(messageId: string) {
    const generation = loadGenerationRef.current;
    let element = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!element) {
      try {
        const result = await topicJson<{ messages: WorkspaceTopicMessage[] }>(`/api/workspace/topics/${encodeURIComponent(topicId)}/messages?around=${encodeURIComponent(messageId)}&limit=41`);
        if (generation !== loadGenerationRef.current) return;
        if (!result.messages.some((message) => message.id === messageId)) { onNotice("info", "引用消息已不可用。"); return; }
        setMessages((current) => mergeWorkspaceTopicMessages(current, result.messages));
        setHistoryAvailable(true);
        setHistoryTargetId(messageId);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (generation !== loadGenerationRef.current) return;
        element = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      } catch (caught) { if (generation === loadGenerationRef.current) onNotice("warning", topicErrorMessage(caught)); return; }
    }
    if (!element) return;
    stickToBottomRef.current = false;
    element.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    element.classList.remove("workspace-message-locate-flash");
    window.requestAnimationFrame(() => { if (generation === loadGenerationRef.current) element?.classList.add("workspace-message-locate-flash"); });
  }

  if (!topicId) {
    return (
      <div className="workspace-topic-empty">
        <Hash size={30} />
        <h2>选择一个话题</h2>
        <p>从话题列表新建，或在群聊中使用 #[标题](正文) 快捷语法。</p>
      </div>
    );
  }
  if (loading || (!error && topic?.id !== topicId)) return <TopicPageSkeleton />;
  if (error || !topic) {
    return <div className="workspace-topic-empty" role="alert"><Hash size={30} /><h2>无法打开话题</h2><p>{error || "话题不存在或无权访问。"}</p><button className="secondary" type="button" onClick={onBack}>返回话题列表</button></div>;
  }

  const canManage = currentUserRole !== "auditor" && (currentUserRole === "owner" || currentUserRole === "admin" || topic.createdBy === currentUserId);
  const composerReadOnly = readOnly || !topic.joined;
  const readOnlyReason = !topic.joined ? "加入后参与讨论。" : readOnly
    ? currentUserRole === "auditor" ? "当前身份仅可阅读，不能发送话题消息。" : `话题已${topic.status === "archived" ? "归档" : "关闭"}，当前为只读状态。`
    : undefined;
  return (
    <section className="workspace-topic-page dl-topic-conversation" aria-label={`话题 ${topic.title}`}>
      {chatRuntime.renderChat({
        scopeKey: `topic:${currentUserId}:${topicId}`,
        title: topic.title,
        subtitle: `话题 · ${group?.title || "所属群聊"}`,
        avatar: <span className="dl-topic-avatar" aria-hidden="true"><Hash size={20} /></span>,
        leadingAction: <button className="icon-button mobile-only" type="button" title="返回话题列表" onClick={onBack}><ArrowLeft size={18} /></button>,
        trailingAction: <span className={`workspace-topic-status ${topic.status}`}>{topicStatusLabel(topic.status)}</span>,
        banner: <div className="dl-topic-banner">
          <div className="dl-topic-banner-heading">
            <button type="button" className="dl-topic-parent" onClick={() => onOpenConversation(topic.conversationId)}><MessageSquare size={15} aria-hidden="true" />{group?.title || "所属群聊"}</button>
            <span><UsersRound size={14} aria-hidden="true" />{topic.participantCount} 人参与</span>
            <TopicDetails scopeKey={`${currentUserId}:${topicId}`} topic={topic} groupTitle={group?.title}
              canJoin={topic.canJoin && currentUserRole !== "auditor"}
              canLeave={topic.createdBy !== currentUserId && currentUserRole !== "auditor"}
              canClose={canManage}
              canArchive={currentUserRole === "owner" || currentUserRole === "admin"}
              busyAction={busyAction}
              onOpenConversation={() => onOpenConversation(topic.conversationId)}
              onJoin={joinTopic} onLeave={leaveTopic} onNotificationChange={updateNotification}
              onCloseTopic={() => transitionTopic("close")} onArchiveTopic={() => transitionTopic("archive")}
            />
          </div>
        </div>,
        messages: topic.joined ? chatMessages : [],
        messageListRef: messageListRef,
        onMessageListScroll: (list) => {
          const nearBottom = isTopicMessageListNearBottom(list);
          stickToBottomRef.current = nearBottom;
          sessionStore.update(topicId, (current) => ({ ...current, scrollTop: list.scrollTop, nearBottom }));
          if (nearBottom) { setNewMessageCount(0); acknowledgeVisibleTopicMessages(); }
        },
        emptyState: !topic.joined ? <div className="empty-state workspace-chat-empty"><Hash size={25} /><strong>加入后参与讨论</strong><span>未加入成员只能查看话题摘要。</span>{topic.canJoin && currentUserRole !== "auditor" && <button type="button" className="primary" disabled={busyAction === "join"} onClick={() => void joinTopic()}>加入话题</button>}</div> : undefined,
        awayFromLatest: topic.joined && !session.nearBottom,
        onJumpToLatest: () => { setHistoryTargetId(""); setNewMessageCount(0); scrollTopicMessagesToBottom(true); },
        historyTargetId,
        newMessageCount,
        reactionPendingKeys,
        onReturnToLatest: () => { setHistoryTargetId(""); setNewMessageCount(0); scrollTopicMessagesToBottom(true); },
        draft: draft.source,
        draftDocument: draft,
        onDraft: setDraft,
        onSend: (event) => void sendMessage(event),
        onSendImageEmote: sendImageEmote,
        stagedAttachments: chatRuntime.stagedAttachments,
        onStageFiles: chatRuntime.stageFiles,
        onRemoveStagedAttachment: chatRuntime.removeStagedAttachment,
        fileInputDisabled: !chatRuntime.canUpload,
        onCancelMessage: (id) => void cancelMessage(id),
        olderMessagesAvailable: historyAvailable,
        olderMessagesLoading: historyLoading,
        onLoadOlderMessages: () => void loadOlderMessages(),
        onToggleReaction: composerReadOnly ? undefined : (id, emoteKey) => { const reacted = messages.find((message) => message.id === id)?.reactions?.some((reaction) => reaction.emoteKey === emoteKey && reaction.reactedByCurrentUser); void messageCommand(`${id}::${emoteKey}`, () => topicMessageCommands.setReaction(id, emoteKey, !reacted), [id]); },
        onTogglePin: composerReadOnly ? undefined : (message) => { void messageCommand(`pin:${message.id}`, () => topicMessageCommands.setPinned(topic.conversationId, message.id, !message.pin), [message.id]); },
        onRecall: composerReadOnly ? undefined : (message) => { void (async () => { if (await confirm("撤回这条消息？撤回后聊天中不再显示原内容。")) await messageCommand(`recall:${message.id}`, () => topicMessageCommands.recall(message.id), [message.id]); })(); },
        onHideMessage: (id) => { void messageCommand(`hide:${id}`, () => topicMessageCommands.setHidden(id, true), [id]); },
        onRestoreHiddenMessages: (ids) => { void messageCommand(`restore:${ids.join(":")}`, () => Promise.all(ids.map((id) => topicMessageCommands.setHidden(id, false))), ids); },
        readOnly: composerReadOnly,
        hideComposer: !topic.joined,
        composerDisabledReason: readOnlyReason,
        composerEditorRef: editorRef,
        composerContext: topic.joined ? <div className="dl-topic-composer-context"><p className="dl-topic-target">发送到 <strong>话题 · {topic.title}</strong></p><label className="dl-topic-sync-field"><Switch label="同步到群聊" checked={syncToGroup} disabled={!topic.allowSyncToGroup || readOnly} onCheckedChange={setSyncToGroup} />同步到群聊</label></div> : undefined,
        replyTarget: topic.joined ? replyTarget : null,
        onReply: composerReadOnly ? undefined : setReplyToMessageId,
        onCancelReply: () => setReplyToMessageId(""),
        onRetryMessage: composerReadOnly ? undefined : retryMessage,
        onJumpToMessage: jumpToMessage,
        currentUserId: currentUserId,
        conversationType: "group",
        mentionMembers: members.filter((member) => member.userId !== currentUserId).map((member) => ({ id: member.userId, displayName: member.displayName, githubLogin: member.githubLogin, avatarUrl: member.avatarUrl, kind: member.kind, secondaryText: "话题成员" })),
        getMessageActions: topicMessageActions
      })}
    </section>
  );
}

function TopicListSkeleton() {
  return <div className="workspace-topic-list-skeleton" aria-label="正在加载话题">{Array.from({ length: 6 }, (_, index) => <span key={index}><i /><b /></span>)}</div>;
}

function TopicPageSkeleton() {
  return <div className="workspace-topic-page-skeleton" aria-busy="true"><span /><span /><div>{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div></div>;
}

function hasTopicDraftContent(document: WorkspaceComposerDocument) {
  if (document.source.trim()) return true;
  return document.blocks.some((block) => {
    if (block.type === "mention" || block.type === "emote") return true;
    return block.text.trim().length > 0;
  });
}

function sameWorkspaceTopic(left: WorkspaceTopic | null, right: WorkspaceTopic) {
  if (!left) return false;
  return left.id === right.id && left.revision === right.revision && left.status === right.status &&
    left.title === right.title && left.description === right.description &&
    left.descriptionPreview === right.descriptionPreview && left.allowSyncToGroup === right.allowSyncToGroup && left.canJoin === right.canJoin &&
    left.participantCount === right.participantCount && left.joined === right.joined &&
    left.notificationLevel === right.notificationLevel && left.updatedAt === right.updatedAt;
}

function sameTopicMembers(left: WorkspaceTopicMember[], right: WorkspaceTopicMember[]) {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const next = right[index];
    return Boolean(next) && member.userId === next.userId && member.displayName === next.displayName && member.avatarUrl === next.avatarUrl;
  });
}

function sameTopicProjections(left: TopicProjection[], right: TopicProjection[]) {
  if (left.length !== right.length) return false;
  return left.every((projection, index) => {
    const next = right[index];
    return Boolean(next) && projection.id === next.id && projection.topicMessageId === next.topicMessageId && projection.removedAt === next.removedAt;
  });
}

function optimisticTopicMessage({
  topic,
  currentUserId,
  currentUserDisplayName,
  clientMessageId,
  blocks,
  replyToMessageId
}: {
  topic: WorkspaceTopic;
  currentUserId: string;
  currentUserDisplayName: string;
  clientMessageId: string;
  blocks: WorkspaceTopicMessageBlock[];
  replyToMessageId: string | null;
}): WorkspaceTopicMessage {
  const now = new Date().toISOString();
  const plainText = blocks.map((block) => block.type === "text" ? block.text : block.type === "mention" ? `@${block.label}` : block.type === "link" ? block.label || block.url : block.type === "emoji" ? `:${block.shortcode}:` : "").join("");
  return {
    id: `pending:${clientMessageId}`,
    clientMessageId,
    topicId: topic.id,
    conversationId: topic.conversationId,
    authorId: currentUserId,
    authorKind: "human",
    author: { id: currentUserId, displayName: currentUserDisplayName || "你" },
    content: { format: "duallane.message+json;v=1", plainText, blocks },
    plainText,
    replyToMessageId,
    createdAt: now,
    localState: "sending"
  };
}

class TopicApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function topicJson<T = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: createWorkspaceJsonHeaders(options) });
  if (!response.ok) {
    let message = "操作失败，请稍后重试";
    try {
      const payload = await response.json() as { error?: { message?: string } };
      message = payload.error?.message || message;
    } catch {
      // Use the stable user-facing fallback above.
    }
    throw new TopicApiError(message, response.status);
  }
  return await response.json() as T;
}

function topicErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "操作失败，请稍后重试";
}

function topicClientId() {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `topic-web:${random}`;
}

function topicStatusLabel(status: WorkspaceTopic["status"]) {
  return status === "open" ? "进行中" : status === "closed" ? "已关闭" : "已归档";
}

function formatTopicListTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}
