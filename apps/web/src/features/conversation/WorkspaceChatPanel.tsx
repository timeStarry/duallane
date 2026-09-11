import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AtSign, Bold, ChevronDown, Code2, Copy, Ellipsis, EyeOff, FileCheck2, FileCode2, FileUp, Hash, Heart, History, Italic, Link2, List, ListOrdered, Maximize2, MessageSquare, Minus, Minimize2, Pin, Quote, RefreshCw, Send, Smile, Strikethrough, Type, Undo2, X } from "lucide-react";
import { WorkspaceAvatar } from "../../WorkspaceAvatar";
import { WorkspaceComposerEditor, type WorkspaceComposerEditorHandle } from "../../WorkspaceComposerEditor";
import { getEmoteInsertText, getReactionEmoteKey, type EmoteItem, type EmotePack } from "../../emotes";
import { isImeCompositionEnter } from "../../workspace-composer-ime";
import { renamePastedImageFiles } from "../../workspace-image-files";
import { groupHiddenWorkspaceMessages } from "../../workspace-hidden-messages";
import { ObjectActionMenu, type ObjectAction } from "../../ui/primitives";
import type { PopupAnchor } from "../../ui/primitives/popup";
import { ReactionPickerPopover } from "./ReactionPickerPopover";
import { useMessageActions } from "./useMessageActions";
import { getMessageGroupPositions } from "./message-grouping";
import { WorkspaceIdentityName, MentionPicker } from "./ConversationIdentity";
import { formatBytes, formatMessageDayLabel, getMessageDayKey, getWorkspacePendingAttachmentProgress, shouldDirectSendWorkspaceEmote } from "./conversation-utils";
import type { ConversationMentionMember, WorkspaceChatPanelProps, WorkspaceConversationMessage } from "./contracts";
import "./conversation.css";
export type { WorkspaceChatPanelProps, WorkspaceConversationMessage, ConversationEmotePickerProps } from "./contracts";
type WorkspaceMarkdownFormat = "bold" | "italic" | "strikethrough" | "inline-code" | "quote" | "unordered-list" | "ordered-list" | "link" | "code-block" | "divider";

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

export function WorkspaceChatPanel<TMessage extends WorkspaceConversationMessage>({
  scopeKey,
  title,
  titleKind,
  avatar,
  subtitle,
  leadingAction,
  trailingAction,
  banner,
  composerContext,
  hideComposer = false,
  emptyState,
  messages,
  renderMessageContent,
  renderPendingAttachments,
  renderReactions,
  renderMessageMeta,
  renderEchoInteraction,
  renderEmotePicker,
  messageListRef,
  onMessageListScroll,
  onMessageListScrollIntent,
  olderMessagesAvailable = false,
  olderMessagesLoading = false,
  onLoadOlderMessages,
  unreadAnchorMessageId,
  unreadAnchorCount = 0,
  newMessageCount = 0,
  awayFromLatest = false,
  onJumpToLatest,
  draft,
  draftDocument,
  onDraft,
  onSend,
  sendDisabled: externalSendDisabled = false,
  readOnly = false,
  composerDisabled = false,
  composerDisabledReason,
  composerEditorRef,
  onSendImageEmote,
  clickImageEmoteToSend = false,
  stagedAttachments = [],
  onStageFiles,
  onRemoveStagedAttachment,
  onReply,
  onRetryMessage,
  onCancelMessage,
  replyTarget,
  onCancelReply,
  onCopyMessage,
  onToggleReaction,
  onFavoriteEmote,
  canFavoriteMessage,
  currentUserId,
  conversationType,
  historyTargetId = "",
  onJumpToMessage,
  onReturnToLatest,
  onTogglePin,
  onRecall,
  onHideMessage,
  onRestoreHiddenMessages,
  mentionMembers = [],
  fileInputDisabled = false,
  onManageEmotes,
  availableTopics = [],
  onSelectTopic,
  getMessageActions
}: WorkspaceChatPanelProps<TMessage>) {
  const [emotePanelOpen, setEmotePanelOpen] = useState(false);
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState("");
  const messageActions = useMessageActions(scopeKey, messages.map((message) => message.id), messageListRef);
  const [dragActive, setDragActive] = useState(false);
  const [formatToolbarOpen, setFormatToolbarOpen] = useState(false);
  const [topicPickerOpen, setTopicPickerOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const internalEditorRef = useRef<WorkspaceComposerEditorHandle | null>(null);
  const editorRef = composerEditorRef ?? internalEditorRef;
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;
  const editingDisabled = readOnly || composerDisabled;
  const canUpload = Boolean(onStageFiles) && !editingDisabled;
  const uploadsDisabled = fileInputDisabled || !canUpload;
  const emoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reactionPickerTriggerRef = useRef<HTMLElement | null>(null);
  const reactionPickerAnchorRef = useRef<PopupAnchor | null>(null);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const canMention = mentionMembers.length > 0 && !editingDisabled;
  const filteredMentionMembers = useMemo(() => {
    const query = (mentionQuery ?? "").trim().toLocaleLowerCase();
    return mentionMembers.filter((member) => !query || [member.displayName, member.githubLogin]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query)));
  }, [mentionMembers, mentionQuery]);
  const toolPanelOpen = emotePanelOpen || mentionPanelOpen || topicPickerOpen;
  const composerClassName = [
    "workspace-composer",
    toolPanelOpen && "tool-open",
    formatToolbarOpen && "formatting-open",
    composerExpanded && "expanded"
  ].filter(Boolean).join(" ");
  const sendDisabled = externalSendDisabled || editingDisabled || (!draft.trim() && stagedAttachments.length === 0);
  const messageDisplayItems = useMemo(() => groupHiddenWorkspaceMessages(messages), [messages]);
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
  const messageGroupPositions = useMemo(() => getMessageGroupPositions(messages, unreadIndex), [messages, unreadIndex]);

  useEffect(() => {
    setEmotePanelOpen(false);
    setMentionPanelOpen(false);
    setTopicPickerOpen(false);
    setReactionPickerMessageId("");
    setMentionQuery(null);
    setDragActive(false);
  }, [scopeKey, editingDisabled]);



  useEffect(() => {
    const sentinel = historySentinelRef.current;
    const root = messageListRef.current;
    if (!sentinel || !root || !olderMessagesAvailable || olderMessagesLoading) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadOlderMessages?.();
        }
      },
      { root, rootMargin: "120px 0px 0px", threshold: 0.01 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messageListRef, olderMessagesAvailable, olderMessagesLoading, onLoadOlderMessages]);

  const applyMarkdownFormat = (format: WorkspaceMarkdownFormat) => {
    if (editingDisabled) return;
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

  const insertEmote = (item: EmoteItem, packId: EmotePack["id"]) => {
    if (editingDisabled) return;
    if (onSendImageEmote && shouldDirectSendWorkspaceEmote(item, packId, clickImageEmoteToSend)) {
      const sendingScope = scopeKey;
      const sendingEditor = editorRef.current;
      window.requestAnimationFrame(() => {
        if (liveScope.current === sendingScope && editorRef.current === sendingEditor) sendingEditor?.focus();
      });
      void Promise.resolve(onSendImageEmote(item)).finally(() => {
        // A delayed response must not focus another conversation or pull focus
        // back after the user has deliberately moved into search or details.
        const editable = composerFormRef.current?.querySelector('[contenteditable="true"]');
        if (liveScope.current !== sendingScope || editorRef.current !== sendingEditor || document.activeElement !== editable) return;
        window.requestAnimationFrame(() => {
          if (liveScope.current === sendingScope && editorRef.current === sendingEditor && document.activeElement === editable) sendingEditor?.focus();
        });
      });
      setEmotePanelOpen(false);
      return;
    }
    const insertText = getEmoteInsertText(item);
    editorRef.current?.insertEmote(item, insertText);
    setEmotePanelOpen(false);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const insertAuthorMention = (member: ConversationMentionMember) => {
    if (editingDisabled) return;
    editorRef.current?.insertMention(member.id, member.displayName, 0);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const insertMention = (member: ConversationMentionMember) => {
    if (editingDisabled) return;
    const triggerLength = mentionQuery === null ? 0 : mentionQuery.length + 1;
    editorRef.current?.insertMention(member.id, member.displayName, triggerLength);
    setMentionPanelOpen(false);
    setMentionQuery(null);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const startReply = (messageId: string) => {
    if (editingDisabled || !onReply) return;
    onReply(messageId);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const closeWorkspaceComposerPopover = () => {
    setEmotePanelOpen(false);
    setMentionPanelOpen(false);
    setTopicPickerOpen(false);
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
    if (editingDisabled || isImeCompositionEnter(event.nativeEvent)) return;
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
    if (uploadsDisabled) {
      return;
    }
    const files = renamePastedImageFiles(Array.from(event.clipboardData.files));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onStageFiles?.(files);
  };
  const handleComposerSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (sendDisabled) { event.preventDefault(); return; }
    onSend(event);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };
  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (uploadsDisabled) {
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onStageFiles?.(files);
    }
  };

  const actionsForMessage = (message: TMessage): ObjectAction[] => {
    const actions: ObjectAction[] = [];
    if (onReply && !editingDisabled && message.authorKind !== "system" && !message.recalledAt && !message.localState) actions.push({ id: "reply", label: "回复", icon: <MessageSquare size={16} />, onSelect: () => startReply(message.id) });
    if (onCopyMessage) actions.push({ id: "copy", label: "复制消息", icon: <Copy size={16} />, onSelect: () => onCopyMessage(message) });
    if (onHideMessage && !message.localState) actions.push({ id: "hide", label: "隐藏消息", icon: <EyeOff size={16} />, onSelect: () => { onHideMessage(message.id); window.requestAnimationFrame(() => editorRef.current?.focus()); } });
    if (onToggleReaction && renderEmotePicker && !readOnly && !message.localState && !message.recalledAt && message.authorKind !== "system") actions.push({ id: "react", label: "添加表情回复", icon: <Smile size={16} />, onSelect: () => { reactionPickerTriggerRef.current = messageActions.menuProps.returnFocus ?? null; reactionPickerAnchorRef.current = messageActions.menuProps.anchor; setReactionPickerMessageId(message.id); } });
    if (onFavoriteEmote && canFavoriteMessage?.(message)) actions.push({ id: "favorite", label: "收藏表情", icon: <Heart size={16} />, onSelect: () => onFavoriteEmote(message) });
    if (onTogglePin && !readOnly && !message.localState && !message.recalledAt && conversationType === "group" && (message.pin?.canUnpin || (message.self && !message.pin))) actions.push({ id: "pin", label: message.pin ? "取消常驻" : "设为常驻消息", icon: <Pin size={16} />, onSelect: () => onTogglePin(message) });
    if (onRecall && !readOnly && message.self && !message.recalledAt && !message.localState) actions.push({ id: "recall", label: "撤回消息", icon: <Undo2 size={16} />, danger: true, onSelect: () => onRecall(message) });
    if (onRetryMessage && !readOnly && message.localState === "failed") actions.push({ id: "retry", label: "重试发送", icon: <RefreshCw size={16} />, disabled: externalSendDisabled || composerDisabled, onSelect: () => onRetryMessage(message.id) });
    return getMessageActions ? getMessageActions(message, actions) : actions;
  };

  return (
    <section
      className={dragActive ? "workspace-chat-panel drag-active" : "workspace-chat-panel"}
      data-conversation-banner={Boolean(banner)}
      data-composer-hidden={hideComposer}
      aria-label={title}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!uploadsDisabled) setDragActive(true);
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
      {banner && <div className="workspace-conversation-banner">{banner}</div>}
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
            onMessageListScrollIntent?.();
          }
        }}
      >
        {historyTargetId && onReturnToLatest && (
          <div className="workspace-history-window-banner" role="status">
            <span><History size={14} />正在查看历史消息上下文</span>
            <button type="button" onClick={onReturnToLatest}>返回最新消息</button>
          </div>
        )}
        <div className="workspace-history-sentinel" ref={historySentinelRef}>
          {olderMessagesAvailable && onLoadOlderMessages && (
            <button className="workspace-history-button" type="button" disabled={olderMessagesLoading} onClick={onLoadOlderMessages}>
              <History size={14} />
              {olderMessagesLoading ? "正在加载" : "加载更早消息"}
            </button>
          )}
        </div>
        {messages.length === 0 ? (
          emptyState ?? <div className="empty-state workspace-chat-empty">
            <MessageSquare size={24} />
            <strong>开始这段对话</strong>
            <span>{readOnly ? "暂时没有可查看的消息。" : canUpload ? "发送消息或分享文件。" : "发送消息，开始讨论。"}</span>
          </div>
        ) : (
          messageDisplayItems.map((displayItem) => {
            const index = displayItem.sourceIndex;
            if (displayItem.kind === "hidden") {
              const hiddenMessageIds = displayItem.messages.map((message) => message.id);
              const firstHiddenMessage = displayItem.messages[0];
              const previousMessage = messages[index - 1];
              const showHiddenDaySeparator = Boolean(
                firstHiddenMessage.createdAt &&
                getMessageDayKey(firstHiddenMessage.createdAt) !== getMessageDayKey(previousMessage?.createdAt)
              );
              const containsUnreadAnchor = unreadIndex >= index && unreadIndex < index + displayItem.messages.length;
              return (
                <Fragment key={`hidden-${hiddenMessageIds.join("-")}`}>
                  {showHiddenDaySeparator && (
                    <div className="message-day-separator" role="separator"><span>{formatMessageDayLabel(firstHiddenMessage.createdAt)}</span></div>
                  )}
                  {containsUnreadAnchor && (
                    <div className="workspace-unread-divider" role="separator"><span>以下为未读消息</span></div>
                  )}
                  <div className="workspace-hidden-message-run" role="status">
                    <EyeOff size={14} aria-hidden="true" />
                    <span>已隐藏 {hiddenMessageIds.length} 条消息</span>
                    {onRestoreHiddenMessages && <button type="button" onClick={() => onRestoreHiddenMessages(hiddenMessageIds)}>恢复</button>}
                  </div>
                </Fragment>
              );
            }
            const message = displayItem.message;
            const authorMentionMember = canMention && conversationType === "group" && !message.self
              ? mentionMembers.find((member) => member.id === message.authorId)
              : undefined;
            const previous = messages[index - 1]?.hiddenByCurrentUser ? undefined : messages[index - 1];
            const dayKey = getMessageDayKey(message.createdAt);
            const previousDayKey = getMessageDayKey(previous?.createdAt);
            const showDaySeparator = Boolean(message.createdAt && dayKey !== previousDayKey);
            const groupPosition = messageGroupPositions[index];
            const groupedWithPrevious = groupPosition === "middle" || groupPosition === "end";
            if (message.authorKind === "system") {
              return (
                <Fragment key={message.id}>
                  {showDaySeparator && (
                    <div className="message-day-separator" role="separator"><span>{formatMessageDayLabel(message.createdAt)}</span></div>
                  )}
                  {index === unreadIndex && (
                    <div className="workspace-unread-divider" role="separator"><span>以下为未读消息</span></div>
                  )}
                  <article
                    className="workspace-system-message-row"
                    data-message-id={message.id}
                    {...(actionsForMessage(message).length ? messageActions.bindMessage(message.id) : {})}
                  >
                    <div className="workspace-system-message" data-native-context>{message.body}</div>
                    {actionsForMessage(message).length > 0 && <div className="workspace-message-actions">
                      {onHideMessage && !message.localState && <button className="workspace-message-hide-action" type="button" title="隐藏消息" onClick={() => onHideMessage(message.id)}>
                        <EyeOff size={15} />
                      </button>}
                      <button
                        type="button"
                        title="更多消息操作"
                        aria-haspopup="menu"
                        aria-expanded={messageActions.menuProps.open && messageActions.messageId === message.id}
                        onClick={(event) => { setReactionPickerMessageId(""); messageActions.openFromTrigger(message.id, event.currentTarget); }}
                      >
                        <Ellipsis size={16} />
                      </button>
                    </div>}
                  </article>
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
                  className={`workspace-message${message.self ? " self" : ""}${groupedWithPrevious ? " grouped" : ""}`}
                  data-message-group={groupPosition}
                  data-message-id={message.id}
                  data-testid={`workspace-message-${message.id}`}
                  {...(actionsForMessage(message).length ? messageActions.bindMessage(message.id) : {})}
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
                        {authorMentionMember ? (
                          <button
                            className="workspace-message-author-mention"
                            type="button"
                            aria-label={`提及 ${authorMentionMember.displayName}`}
                            title={`提及 ${authorMentionMember.displayName}`}
                            onClick={() => insertAuthorMention(authorMentionMember)}
                          >
                            <AtSign size={12} aria-hidden="true" />
                            <WorkspaceIdentityName name={message.author} kind={message.authorKind} />
                          </button>
                        ) : (
                          <strong><WorkspaceIdentityName name={message.author} kind={message.authorKind} /></strong>
                        )}
                        <time>{message.at}</time>
                        {renderMessageMeta?.(message)}
                      </div>
                    )}
                    {!message.recalledAt && message.replyTo?.messageId && onJumpToMessage && (
                      <button
                        className="reply-preview workspace-reply-jump"
                        type="button"
                        aria-label={`跳转到 ${message.replyTo.author || "成员"} 的原消息`}
                        onClick={() => onJumpToMessage(message.replyTo!.messageId!)}
                      >
                        <strong>{message.replyTo.author}</strong>
                        <span>{message.replyTo.body}</span>
                      </button>
                    )}
                    {message.recalledAt ? (
                      <div className="workspace-recalled-message" role="status">
                        <Undo2 size={14} aria-hidden="true" />
                        <span>{message.body}</span>
                      </div>
                    ) : (
                      renderMessageContent(message)
                    )}
                    {message.pendingAttachments && message.pendingAttachments.length > 0 && (
                      renderPendingAttachments?.(message)
                    )}
                    {!message.recalledAt && message.pin && (
                      <div className="workspace-message-pin-indicator" title="群常驻消息">
                        <Pin size={12} aria-hidden="true" />
                        <span>常驻</span>
                      </div>
                    )}
                    {!message.recalledAt && (
                      renderReactions?.(message)
                    )}
                    {message.localState && (
                      <div className={`message-local-state ${message.localState}`}>
                        {(message.localState === "uploading" || message.localState === "sending") && (
                          <RefreshCw className="workspace-message-state-spinner" size={13} aria-hidden="true" />
                        )}
                        <span>
                          {message.localState === "uploading"
                            ? `后台上传 ${getWorkspacePendingAttachmentProgress(message.pendingAttachments ?? [])}% · 完成后自动发送`
                            : message.localState === "sending"
                              ? message.attachments?.length ? "文件已上传 · 正在发送消息" : "发送中"
                            : message.localState === "delivered"
                              ? "已送达"
                              : message.failureReason || "发送失败"}
                        </span>
                        {message.localState === "failed" && onRetryMessage && !readOnly && (
                          <button type="button" disabled={externalSendDisabled || composerDisabled} onClick={() => onRetryMessage(message.id)}>
                            <RefreshCw size={14} />
                            {message.pendingAttachments?.length ? "重试上传" : "重试发送"}
                          </button>
                        )}
                        {onCancelMessage && message.pendingAttachments?.length && (message.localState === "uploading" || message.localState === "failed") ? (
                          <button className="message-local-cancel" type="button" onClick={() => onCancelMessage(message.id)}>
                            <X size={14} />
                            {message.localState === "uploading" ? "取消" : "移除"}
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                  {actionsForMessage(message).length > 0 && (
                    <div className="workspace-message-actions">
                      {!message.recalledAt && !message.localState && !readOnly && onToggleReaction && renderEmotePicker && (
                        <div
                          className="workspace-reaction-picker-anchor"
                          data-reaction-picker-message-id={message.id}
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && reactionPickerMessageId === message.id) {
                              event.preventDefault();
                              setReactionPickerMessageId("");
                              window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus({ preventScroll: true }));
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
                              reactionPickerAnchorRef.current = event.currentTarget;
                              setReactionPickerMessageId((current) => current === message.id ? "" : message.id);
                            }}
                          >
                            <Smile size={15} />
                          </button>
                          {reactionPickerMessageId === message.id && (
                            <ReactionPickerPopover anchor={reactionPickerTriggerRef.current} placementAnchor={reactionPickerAnchorRef.current} messageId={message.id} onDismiss={() => setReactionPickerMessageId("")}>
                              {renderEmotePicker?.({ id: "workspace-reaction-picker-" + message.id, label: "选择消息表情回复", workspaceFeatures: "reaction", onEscape: () => {
                                setReactionPickerMessageId("");
                                window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus({ preventScroll: true }));
                              }, onSelect: (item, packId) => {
                                onToggleReaction(message.id, getReactionEmoteKey(packId, item));
                                setReactionPickerMessageId("");
                                window.requestAnimationFrame(() => reactionPickerTriggerRef.current?.focus({ preventScroll: true }));
                              } })}
                            </ReactionPickerPopover>
                          )}
                        </div>
                      )}
                      {onHideMessage && !message.localState && <button className="workspace-message-hide-action" type="button" title="隐藏消息" onClick={() => onHideMessage(message.id)}>
                        <EyeOff size={15} />
                      </button>}
                      <button
                        type="button"
                        title="更多消息操作"
                        aria-haspopup="menu"
                        aria-expanded={messageActions.menuProps.open && messageActions.messageId === message.id}
                        onClick={(event) => { setReactionPickerMessageId(""); messageActions.openFromTrigger(message.id, event.currentTarget); }}
                      >
                        <Ellipsis size={16} />
                      </button>
                    </div>
                  )}
                </article>
              </Fragment>
            );
          })
        )}
        {(() => {
          const message = messages.find((candidate) => candidate.id === messageActions.messageId);
          if (!message) return null;
          const actions = actionsForMessage(message);
          if (!actions.length) return null;
          return <ObjectActionMenu {...messageActions.menuProps} fallbackFocus={messageListRef?.current} label="消息操作" summary={message.author} actions={actions} />;
        })()}     </div>
      {!hideComposer && <div className="workspace-composer-dock">
        {!historyTargetId && onJumpToLatest && (newMessageCount > 0 || awayFromLatest) && (
          <button className="workspace-new-message-button" type="button" onClick={onJumpToLatest}>
            <ChevronDown size={15} />
            {newMessageCount > 0 ? `${newMessageCount} 条新消息` : "回到最新消息"}
          </button>
        )}
        {replyTarget && (
          <div className="composer-reply">
            <span>回复 <strong>{replyTarget.author}</strong>：{replyTarget.body}</span>
            {onCancelReply && <button className="icon-button" type="button" title="取消回复" onClick={onCancelReply}>
              <X size={15} />
            </button>}
          </div>
        )}
        {renderEchoInteraction?.(() => window.requestAnimationFrame(() => editorRef.current?.focus()))}
        {composerContext}
        {composerDisabledReason && <div className="workspace-composer-disabled-reason" role="status">{composerDisabledReason}</div>}
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
                <button type="button" title={attachment.state === "uploading" ? "取消上传" : "移除附件"} onClick={() => onRemoveStagedAttachment?.(attachment.id)}>
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
            {onStageFiles && <label className={uploadsDisabled ? "workspace-composer-icon disabled" : "workspace-composer-icon"} title="添加附件">
              <FileUp size={18} />
              <input
                type="file"
                multiple
                aria-label="添加附件"
                disabled={uploadsDisabled}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  if (files.length > 0) onStageFiles?.(files);
                  event.currentTarget.value = "";
                }}
              />
            </label>}
            {renderEmotePicker && <button
              ref={emoteTriggerRef}
              disabled={editingDisabled}
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
            </button>}
            {availableTopics.length > 0 && onSelectTopic && !editingDisabled && (
              <button
                className="workspace-composer-icon"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={topicPickerOpen}
                title="打开话题"
                onClick={() => {
                  setEmotePanelOpen(false);
                  setMentionPanelOpen(false);
                  setTopicPickerOpen((open) => !open);
                }}
              >
                <Hash size={18} />
              </button>
            )}
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
              disabled={editingDisabled}
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

          {formatToolbarOpen && !editingDisabled && (
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
            readOnly={editingDisabled}
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
            <button className="workspace-send-button" type="submit" disabled={sendDisabled} title="发送消息">
              <Send size={18} />
            </button>
          </div>
          {emotePanelOpen && !editingDisabled && (
            renderEmotePicker?.({ id: "workspace-composer-emote-picker", workspaceFeatures: "composer", onSelect: insertEmote, onEscape: closeWorkspaceComposerPopover, onManageEmotes: onManageEmotes })
          )}
          {mentionPanelOpen && !editingDisabled && (
            <MentionPicker
              id="workspace-composer-mention-picker"
              members={filteredMentionMembers}
              activeIndex={mentionActiveIndex}
              onSelect={insertMention}
              onEscape={closeWorkspaceComposerPopover}
            />
          )}
          {topicPickerOpen && onSelectTopic && !editingDisabled && (
            <div className="workspace-topic-picker" role="listbox" aria-label="打开已有话题">
              <button
                className="active"
                type="button"
                role="option"
                aria-selected={true}
                onClick={() => { onSelectTopic(null); setTopicPickerOpen(false); }}
              >
                <MessageSquare size={15} />
                <span><strong>群聊消息</strong><small>发送到当前群聊</small></span>
              </button>
              {availableTopics.map((topic) => (
                <button
                  className=""
                  type="button"
                  role="option"
                  aria-selected={false}
                  key={topic.id}
                  onClick={() => { setTopicPickerOpen(false); onSelectTopic(topic); }}
                >
                  <Hash size={15} />
                  <span><strong>#{topic.title}</strong><small>打开话题，群聊草稿保留</small></span>
                </button>
              ))}
            </div>
          )}
        </form>
      </div>}
      {dragActive && (
        <div className="workspace-drop-overlay" aria-hidden="true">
          <FileUp size={24} />
          <strong>拖到这里添加附件</strong>
        </div>
      )}
    </section>
  );
}
