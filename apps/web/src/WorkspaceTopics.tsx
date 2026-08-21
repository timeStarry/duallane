import {
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Hash,
  MessageSquare,
  Send,
  UsersRound,
  X
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import {
  WorkspaceComposerEditor,
  type WorkspaceComposerDocument,
  type WorkspaceComposerEditorHandle
} from "./WorkspaceComposerEditor";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
import { createWorkspaceJsonHeaders } from "./workspace-http";

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

export type WorkspaceTopicMessageBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string };

export type WorkspaceTopicMessage = {
  id: string;
  clientMessageId?: string;
  topicId: string;
  authorId: string;
  authorKind: "human" | "bot" | "system";
  author: { id: string; displayName: string; githubLogin?: string; avatarUrl?: string | null };
  content: { format: string; plainText: string; blocks: WorkspaceTopicMessageBlock[] };
  plainText: string;
  replyToMessageId?: string | null;
  createdAt: string;
  localState?: "sending" | "failed";
  failureReason?: string;
};

export type WorkspaceTopicMember = {
  userId: string;
  displayName: string;
  githubLogin?: string;
  avatarUrl?: string;
};

export type WorkspaceTopicConversation = {
  id: string;
  title: string;
};

export type WorkspaceTopicNotificationLevel = "all" | "mentions" | "muted";
export type WorkspaceTopicFilter = "all" | "joined" | "created" | "unread" | "closed";

export type WorkspaceTopicRefreshSignal = {
  version: number;
  listVersion: number;
  topicVersions: Record<string, number>;
  conversationVersions: Record<string, number>;
};

export type WorkspaceTopicRefreshScope = {
  topicId: string;
  conversationId: string;
  affectsList: boolean;
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

type NoticeTone = "success" | "warning" | "info";

export function WorkspaceTopicRail({
  currentUserId,
  selectedTopicId,
  conversations,
  refreshSignal,
  onOpen
}: {
  currentUserId: string;
  selectedTopicId: string;
  conversations: WorkspaceTopicConversation[];
  refreshSignal: WorkspaceTopicRefreshSignal;
  onOpen: (topicId: string) => void;
}) {
  const [topics, setTopics] = useState<WorkspaceTopic[]>([]);
  const [filter, setFilter] = useState<WorkspaceTopicFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshVersion = topicRefreshVersionForList(refreshSignal);

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
  }, [refreshVersion]);

  const conversationNames = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation.title])),
    [conversations]
  );
  const visibleTopics = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return topics.filter((topic) => {
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
  refreshSignal,
  onOpen
}: {
  conversationId: string;
  refreshSignal: WorkspaceTopicRefreshSignal;
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
  const [topic, setTopic] = useState<WorkspaceTopic | null>(null);
  const [messages, setMessages] = useState<WorkspaceTopicMessage[]>([]);
  const [pendingMessages, setPendingMessages] = useState<Record<string, WorkspaceTopicMessage>>({});
  const [members, setMembers] = useState<WorkspaceTopicMember[]>([]);
  const [projections, setProjections] = useState<TopicProjection[]>([]);
  const [draft, setDraft] = useState<WorkspaceComposerDocument>(emptyComposerDocument());
  const [syncToGroup, setSyncToGroup] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [loading, setLoading] = useState(Boolean(topicId));
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const editorRef = useRef<WorkspaceComposerEditorHandle | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const snapshotReadyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const sendingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const documentVisibleRef = useRef(documentVisible);
  documentVisibleRef.current = documentVisible;
  const refreshVersion = topicRefreshVersionForTopic(refreshSignal, topicId);

  const group = conversations.find((conversation) => conversation.id === topic?.conversationId);
  const filteredMentionMembers = useMemo(() => {
    const query = (mentionQuery ?? "").trim().toLocaleLowerCase();
    return members.filter((member) => member.userId !== currentUserId && (!query || [member.displayName, member.githubLogin]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query))));
  }, [currentUserId, members, mentionQuery]);
  const displayMessages = useMemo(
    () => mergeWorkspaceTopicMessages(messages, Object.values(pendingMessages)),
    [messages, pendingMessages]
  );
  const replyTarget = displayMessages.find((message) => message.id === replyToMessageId) ?? null;
  const projectedMessageIds = useMemo(
    () => new Set(projections.filter((projection) => !projection.removedAt).map((projection) => projection.topicMessageId)),
    [projections]
  );

  async function loadTopicSnapshot(generation: number, initialLoad: boolean) {
    if (!topicId) return;
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topicId)}`);
      if (generation !== loadGenerationRef.current) return;
      setTopic((current) => sameWorkspaceTopic(current, result.topic) ? current : result.topic);
      if (!result.topic.joined) {
        setMessages([]);
        setPendingMessages({});
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
      const shouldAcknowledge = shouldAcknowledgeTopicMessages({
        initialLoad,
        documentVisible: documentVisibleRef.current,
        nearBottom: isTopicMessageListNearBottom(messageListRef.current)
      });
      setMessages((current) => initialLoad ? mergeWorkspaceTopicMessages([], messageResult.messages) : mergeWorkspaceTopicMessages(current, messageResult.messages));
      setMembers((current) => sameTopicMembers(current, memberResult.members) ? current : memberResult.members);
      setProjections((current) => sameTopicProjections(current, projectionResult.projections) ? current : projectionResult.projections);
      snapshotReadyRef.current = true;
      const latest = shouldAcknowledge ? messageResult.messages.at(-1) : null;
      if (latest) {
        void topicJson(`/api/workspace/topics/${encodeURIComponent(topicId)}/read`, {
          method: "POST",
          body: JSON.stringify({ messageId: latest.id })
        }).catch(() => undefined);
      }
      if (shouldAcknowledge || stickToBottomRef.current) scrollTopicMessagesToBottom();
    } catch (caught) {
      if (initialLoad && generation === loadGenerationRef.current) setError(topicErrorMessage(caught));
    } finally {
      if (initialLoad && generation === loadGenerationRef.current) setLoading(false);
    }
  }

  async function refreshTopicSnapshot() {
    if (!topicId || !snapshotReadyRef.current) return;
    const generation = loadGenerationRef.current;
    if (sendingRef.current || refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      await loadTopicSnapshot(generation, false);
    } finally {
      refreshInFlightRef.current = false;
      if (generation !== loadGenerationRef.current) {
        refreshQueuedRef.current = false;
        return;
      }
      if (refreshQueuedRef.current && !sendingRef.current) {
        refreshQueuedRef.current = false;
        void refreshTopicSnapshot();
      }
    }
  }

  function scrollTopicMessagesToBottom() {
    window.requestAnimationFrame(() => {
      if (messageListRef.current) messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    });
  }

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    snapshotReadyRef.current = false;
    setError("");
    setTopic(null);
    setMessages([]);
    setPendingMessages({});
    setMembers([]);
    setProjections([]);
    sendingRef.current = false;
    refreshQueuedRef.current = false;
    setSending(false);
    if (!topicId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadTopicSnapshot(generation, true);
  }, [topicId]);

  useEffect(() => {
    if (!topicId || !snapshotReadyRef.current) return;
    void refreshTopicSnapshot();
  }, [refreshVersion, topicId]);

  useEffect(() => {
    if (mentionQuery === null) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || mentionMenuRef.current?.contains(event.target)) return;
      setMentionQuery(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [mentionQuery]);

  async function joinTopic() {
    if (!topic) return;
    setBusyAction("join");
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/join`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setTopic(result.topic);
      snapshotReadyRef.current = true;
      void refreshTopicSnapshot();
      onNotice("success", "已加入话题");
    } catch (caught) {
      onNotice("warning", topicErrorMessage(caught));
    } finally {
      setBusyAction("");
    }
  }

  async function leaveTopic() {
    if (!topic) return;
    setBusyAction("leave");
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/leave`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setTopic(result.topic);
      setMessages([]);
      setPendingMessages({});
      setMembers([]);
      onNotice("success", "已退出话题");
    } catch (caught) {
      onNotice("warning", topicErrorMessage(caught));
    } finally {
      setBusyAction("");
    }
  }

  async function updateNotification(notificationLevel: WorkspaceTopicNotificationLevel) {
    if (!topic) return;
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/notification`, {
        method: "PATCH",
        body: JSON.stringify({ notificationLevel })
      });
      setTopic(result.topic);
    } catch (caught) {
      onNotice("warning", topicErrorMessage(caught));
    }
  }

  async function transitionTopic(action: "close" | "archive") {
    if (!topic) return;
    setBusyAction(action);
    try {
      const result = await topicJson<{ topic: WorkspaceTopic }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: topic.revision })
      });
      setTopic(result.topic);
      onNotice("success", action === "close" ? "话题已关闭" : "话题已归档");
    } catch (caught) {
      onNotice("warning", topicErrorMessage(caught));
    } finally {
      setBusyAction("");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!topic || sending || !hasTopicDraftContent(draft)) return;
    const clientMessageId = topicClientId();
    const sendGeneration = loadGenerationRef.current;
    const contentBlocks = topicComposerDocumentToBlocks(draft);
    const optimisticMessage = optimisticTopicMessage({
      topic,
      currentUserId,
      currentUserDisplayName,
      clientMessageId,
      blocks: contentBlocks,
      replyToMessageId: replyToMessageId || null
    });
    const shouldScroll = stickToBottomRef.current;
    setSending(true);
    sendingRef.current = true;
    setPendingMessages((current) => ({ ...current, [clientMessageId]: optimisticMessage }));
    setDraft(emptyComposerDocument());
    setReplyToMessageId("");
    setSyncToGroup(false);
    if (shouldScroll) scrollTopicMessagesToBottom();
    try {
      const result = await topicJson<{ message: WorkspaceTopicMessage }>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          clientMessageId,
          content: { format: "duallane.message+json;v=1", blocks: contentBlocks },
          replyToMessageId: replyToMessageId || undefined,
          syncToGroup
        })
      });
      if (sendGeneration === loadGenerationRef.current) {
        setMessages((current) => mergeWorkspaceTopicMessages(current, [{ ...result.message, clientMessageId }]));
        setPendingMessages((current) => {
          const { [clientMessageId]: _sent, ...rest } = current;
          return rest;
        });
        window.requestAnimationFrame(() => editorRef.current?.focus());
      }
    } catch (caught) {
      if (sendGeneration === loadGenerationRef.current) {
        setPendingMessages((current) => ({
          ...current,
          [clientMessageId]: { ...optimisticMessage, localState: "failed", failureReason: topicErrorMessage(caught) }
        }));
        onNotice("warning", topicErrorMessage(caught));
      }
    } finally {
      if (sendGeneration === loadGenerationRef.current) {
        setSending(false);
        sendingRef.current = false;
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          void refreshTopicSnapshot();
        }
      }
    }
  }

  async function toggleProjection(messageId: string) {
    if (!topic) return;
    const synced = projectedMessageIds.has(messageId);
    setBusyAction(`sync:${messageId}`);
    try {
      const result = await topicJson<{ projection: TopicProjection | null }>(
        `/api/workspace/topics/${encodeURIComponent(topic.id)}/messages/${encodeURIComponent(messageId)}/sync`,
        { method: synced ? "DELETE" : "POST", body: synced ? undefined : JSON.stringify({}) }
      );
      setProjections((current) => {
        const without = current.filter((projection) => projection.topicMessageId !== messageId);
        return result.projection ? [...without, result.projection] : without;
      });
      onNotice("success", synced ? "已取消同步" : "已同步到群聊");
    } catch (caught) {
      onNotice("warning", topicErrorMessage(caught));
    } finally {
      setBusyAction("");
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (mentionQuery !== null && filteredMentionMembers.length > 0 && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowDown") setMentionActiveIndex((index) => (index + 1) % filteredMentionMembers.length);
      else if (event.key === "ArrowUp") setMentionActiveIndex((index) => (index - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
      else insertMention(filteredMentionMembers[mentionActiveIndex] ?? filteredMentionMembers[0]);
      return;
    }
    if (event.key === "Escape" && mentionQuery !== null) {
      event.preventDefault();
      setMentionQuery(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
    }
  }

  function insertMention(member: WorkspaceTopicMember) {
    editorRef.current?.insertMention(member.userId, member.displayName, (mentionQuery?.length ?? -1) + 1);
    setMentionQuery(null);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }

  function jumpToMessage(messageId: string) {
    const element = messageListRef.current?.querySelector<HTMLElement>(`[data-topic-message-id="${CSS.escape(messageId)}"]`);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.classList.remove("workspace-message-locate-flash");
    window.requestAnimationFrame(() => element.classList.add("workspace-message-locate-flash"));
  }

  if (!topicId) {
    return (
      <div className="workspace-topic-empty">
        <Hash size={30} />
        <h2>选择一个话题</h2>
        <p>群聊中在消息开头输入 #[标题](正文)，即可发起独立话题。</p>
      </div>
    );
  }
  if (loading) return <TopicPageSkeleton />;
  if (error || !topic) {
    return <div className="workspace-topic-empty" role="alert"><Hash size={30} /><h2>无法打开话题</h2><p>{error || "话题不存在或无权访问。"}</p><button className="secondary" type="button" onClick={onBack}>返回话题列表</button></div>;
  }

  const canManage = currentUserRole === "owner" || currentUserRole === "admin" || topic.createdBy === currentUserId;
  return (
    <section className="workspace-topic-page" aria-label={`话题 ${topic.title}`}>
      <header className="workspace-topic-header">
        <button className="icon-button mobile-only" type="button" title="返回话题列表" onClick={onBack}><ArrowLeft size={17} /></button>
        <span className={`workspace-topic-header-icon ${topic.status}`}><Hash size={18} /></span>
        <div>
          <strong>{topic.title}</strong>
          <button type="button" onClick={() => onOpenConversation(topic.conversationId)}>{group?.title || "所属群聊"}</button>
        </div>
        <span className={`workspace-topic-status ${topic.status}`}>{topicStatusLabel(topic.status)}</span>
      </header>

      <div className="workspace-topic-summary">
        <p>{topic.description || topic.descriptionPreview || "加入后查看话题正文。"}</p>
        <div className="workspace-topic-meta">
          <span><WorkspaceAvatar name={topic.creator.displayName} className="tiny" decorative />{topic.creator.displayName}</span>
          <span><UsersRound size={14} />{topic.participantCount} 人参与</span>
          <time>{formatTopicDate(topic.createdAt)}</time>
        </div>
        <div className="workspace-topic-actions">
          {!topic.joined && topic.canJoin && <button className="primary" type="button" disabled={busyAction === "join"} onClick={() => void joinTopic()}><Check size={16} />加入话题</button>}
          {topic.joined && topic.createdBy !== currentUserId && topic.status === "open" && <button className="secondary" type="button" disabled={busyAction === "leave"} onClick={() => void leaveTopic()}><X size={16} />退出话题</button>}
          {topic.joined && (
            <div className="workspace-topic-notification" role="group" aria-label="话题提醒">
              {(["all", "mentions", "muted"] as const).map((level) => (
                <button key={level} type="button" aria-pressed={(topic.notificationLevel ?? "all") === level} className={(topic.notificationLevel ?? "all") === level ? "active" : ""} onClick={() => void updateNotification(level)}>
                  {level === "muted" ? <BellOff size={14} /> : <Bell size={14} />}{topicNotificationLabel(level)}
                </button>
              ))}
            </div>
          )}
          {canManage && topic.status === "open" && <button className="secondary" type="button" disabled={busyAction === "close"} onClick={() => void transitionTopic("close")}><MessageSquare size={15} />关闭</button>}
          {(currentUserRole === "owner" || currentUserRole === "admin") && topic.status !== "archived" && <button className="secondary" type="button" disabled={busyAction === "archive"} onClick={() => void transitionTopic("archive")}><Archive size={15} />归档</button>}
        </div>
      </div>

      {!topic.joined ? (
        <div className="workspace-topic-join-state"><Hash size={25} /><strong>加入后参与讨论</strong><span>未加入成员只能查看话题摘要。</span></div>
      ) : (
        <>
          <div
            className="workspace-topic-message-list"
            ref={messageListRef}
            onScroll={() => { stickToBottomRef.current = isTopicMessageListNearBottom(messageListRef.current); }}
            aria-live="polite"
            aria-label="话题消息"
          >
            {displayMessages.length === 0 ? <p className="saved-empty">还没有话题消息。</p> : displayMessages.map((message) => {
              const reply = message.replyToMessageId ? displayMessages.find((candidate) => candidate.id === message.replyToMessageId) : null;
              const synced = projectedMessageIds.has(message.id);
              return (
                <article className={`workspace-message workspace-topic-message${message.authorId === currentUserId ? " self" : ""}`} key={topicMessageKey(message)} data-topic-message-id={message.id} tabIndex={-1}>
                  <div className="workspace-message-avatar-slot">
                    <WorkspaceAvatar name={message.author.displayName} avatarUrl={message.author.avatarUrl ?? undefined} className="workspace-message-avatar" decorative />
                  </div>
                  <div className="workspace-message-content">
                    <div className="workspace-message-meta"><strong>{message.author.displayName}</strong><time>{formatTopicMessageTime(message.createdAt)}</time></div>
                    {reply && <button className="reply-preview workspace-reply-jump" type="button" onClick={() => jumpToMessage(reply.id)}><strong>{reply.author.displayName}</strong><span>{reply.plainText}</span></button>}
                    <TopicMessageBody message={message} />
                    {message.localState && <div className={`message-local-state ${message.localState}`} role="status"><span>{message.localState === "sending" ? "发送中" : message.failureReason || "发送失败"}</span></div>}
                  </div>
                  <div className="workspace-message-actions workspace-topic-message-actions">
                    {!message.localState && <button type="button" onClick={() => { setReplyToMessageId(message.id); window.requestAnimationFrame(() => editorRef.current?.focus()); }}>回复</button>}
                    {topic.allowSyncToGroup && !message.localState && <button type="button" disabled={busyAction === `sync:${message.id}`} aria-pressed={synced} onClick={() => void toggleProjection(message.id)}>{synced ? "已同步" : "同步到群聊"}</button>}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="workspace-composer-dock workspace-topic-composer-dock">
            {replyTarget && <div className="composer-reply"><span>回复 <strong>{replyTarget.author.displayName}</strong>：{replyTarget.plainText}</span><button className="icon-button" type="button" title="取消回复" onClick={() => setReplyToMessageId("")}><X size={15} /></button></div>}
            <form className="workspace-composer workspace-topic-composer" aria-busy={sending} onSubmit={(event) => void sendMessage(event)}>
              <WorkspaceComposerEditor
                ref={editorRef}
                value={draft}
                onChange={setDraft}
                onMentionQuery={(query) => { setMentionQuery(query); setMentionActiveIndex(0); }}
                onKeyDown={handleComposerKeyDown}
                onPaste={() => undefined}
                expanded={false}
                readOnly={topic.status !== "open"}
              />
              {mentionQuery !== null && filteredMentionMembers.length > 0 && (
                <div className="workspace-topic-mention-menu" ref={mentionMenuRef} role="listbox" aria-label="选择要提及的成员">
                  {filteredMentionMembers.slice(0, 8).map((member, index) => (
                    <button key={member.userId} type="button" role="option" aria-selected={index === mentionActiveIndex} className={index === mentionActiveIndex ? "active" : ""} onPointerDown={(event) => event.preventDefault()} onClick={() => insertMention(member)}>
                      <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="tiny" decorative />
                      <span><strong>{member.displayName}</strong><small>{member.githubLogin ? `@${member.githubLogin}` : "群成员"}</small></span>
                    </button>
                  ))}
                </div>
              )}
              <div className="workspace-topic-composer-actions">
                <label className={topic.allowSyncToGroup ? "workspace-topic-sync-toggle" : "workspace-topic-sync-toggle disabled"}>
                  <input type="checkbox" checked={syncToGroup} disabled={!topic.allowSyncToGroup || topic.status !== "open"} onChange={(event) => setSyncToGroup(event.target.checked)} />
                  <span><Check size={13} /></span>
                  同步到群聊
                </label>
                <button className="primary icon-button" type="submit" title="发送话题消息" disabled={sending || topic.status !== "open" || !hasTopicDraftContent(draft)}><Send size={17} /></button>
              </div>
            </form>
            {topic.status !== "open" && <p className="workspace-topic-readonly">话题已{topic.status === "archived" ? "归档" : "关闭"}，当前为只读状态。</p>}
          </div>
        </>
      )}
    </section>
  );
}

function TopicMessageBody({ message }: { message: WorkspaceTopicMessage }) {
  const blocks = message.content.blocks.length > 0
    ? message.content.blocks
    : message.plainText.trim()
      ? [{ type: "text" as const, text: message.plainText }]
      : [];
  return (
    <div className="workspace-topic-message-body">
      {blocks.map((block, index) => {
        if (block.type === "text") return <WorkspaceMarkdown key={`${index}-text`}>{block.text}</WorkspaceMarkdown>;
        if (block.type === "mention") return <span className="message-mention" key={`${index}-mention`}>@{block.label}</span>;
        if (block.type === "link") return <a className="message-link" key={`${index}-link`} href={block.url} target="_blank" rel="noopener noreferrer">{block.label || block.url}</a>;
        return <span key={`${index}-emoji`}>:{block.shortcode}:</span>;
      })}
    </div>
  );
}

function TopicListSkeleton() {
  return <div className="workspace-topic-list-skeleton" aria-label="正在加载话题">{Array.from({ length: 6 }, (_, index) => <span key={index}><i /><b /></span>)}</div>;
}

function TopicPageSkeleton() {
  return <div className="workspace-topic-page-skeleton" aria-busy="true"><span /><span /><div>{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div></div>;
}

function emptyComposerDocument(): WorkspaceComposerDocument {
  return { source: "", blocks: [{ type: "text", text: "" }] };
}

function hasTopicDraftContent(document: WorkspaceComposerDocument) {
  if (document.source.trim()) return true;
  return document.blocks.some((block) => {
    if (block.type === "mention" || block.type === "emote") return true;
    return block.text.trim().length > 0;
  });
}

function topicComposerDocumentToBlocks(document: WorkspaceComposerDocument): WorkspaceTopicMessageBlock[] {
  if (document.blocks.length === 0 && document.source.trim()) {
    return [{ type: "text", text: document.source }];
  }
  return document.blocks.map((block): WorkspaceTopicMessageBlock => {
    if (block.type === "mention") return { type: "mention", userId: block.userId, label: block.label };
    if (block.type === "emote") return { type: "text", text: block.token };
    return { type: "text", text: block.text };
  }).filter((block) => block.type !== "text" || block.text.length > 0);
}

function sameWorkspaceTopic(left: WorkspaceTopic | null, right: WorkspaceTopic) {
  if (!left) return false;
  return left.id === right.id && left.revision === right.revision && left.status === right.status &&
    left.title === right.title && left.description === right.description &&
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
  const plainText = blocks.map((block) => block.type === "text" ? block.text : block.type === "mention" ? `@${block.label}` : block.type === "link" ? block.label || block.url : `:${block.shortcode}:`).join("");
  return {
    id: `pending:${clientMessageId}`,
    clientMessageId,
    topicId: topic.id,
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
    throw new Error(message);
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

function topicNotificationLabel(level: WorkspaceTopicNotificationLevel) {
  return level === "all" ? "全部" : level === "mentions" ? "仅提及" : "免打扰";
}

function formatTopicListTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatTopicDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function formatTopicMessageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
