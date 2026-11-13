import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bookmark,
  Check,
  CheckCheck,
  ChevronLeft,
  Clock,
  Copy,
  FileText,
  Forward,
  MessageSquareText,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Reply,
  SendHorizontal,
  ShieldCheck,
  Slash,
  Smile,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore, type V1Message } from "@/entities/workspace/store";
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Tooltip,
} from "@/shared/ui";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";
import { cn } from "@/shared/lib/cn";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "🔥", "👀"];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function isGroupedPair(a?: V1Message, b?: V1Message): boolean {
  if (!a || !b) return false;
  if (a.senderId !== b.senderId) return false;
  if (a.card || b.card) return false;
  const delta = Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return Number.isFinite(delta) && delta <= GROUP_WINDOW_MS;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TimelinePane() {
  const {
    activeLane,
    mobileView,
    setMobileView,
    openThreadInspector,
    openDetailsInspector,
    openFileInspector,
    openLightbox,
  } = useLaneStore();
  const {
    currentUser,
    conversations,
    conversationOrder,
    activeConversationId,
    messagesByConv,
    highlightedMessageId,
    drafts,
    editingMessageId,
    setDraft,
    setScrollTop,
    setEditingMessageId,
    sendWorkspaceMessage,
    editWorkspaceMessage,
    toggleReaction,
    togglePinMessage,
    forwardMessage,
    jumpToMessage,
    triggerCardAction,
    p2pRoom,
    createP2PRoom,
    p2pMessages,
    p2pDraft,
    setP2PDraft,
    sendP2PMessage,
  } = useWorkspaceStore();

  const [pinIndex, setPinIndex] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [forwardMsgId, setForwardMsgId] = useState<string | null>(null);
  const [forwardTargetConvId, setForwardTargetConvId] = useState<string>("");
  const [forwarding, setForwarding] = useState(false);
  const [replyToId, setReplyToId] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = useMemo(
    () => (activeConversationId ? messagesByConv[activeConversationId] || [] : []),
    [activeConversationId, messagesByConv]
  );
  const messageMap = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const draft = activeConversationId ? drafts[activeConversationId]?.text || "" : "";

  const pinnedMessages = useMemo(() => {
    if (!activeConv) return [];
    return activeConv.pinnedMessageIds
      .map((id) => messageMap.get(id))
      .filter((m): m is V1Message => Boolean(m));
  }, [activeConv, messageMap]);

  const currentPin =
    pinnedMessages.length > 0 ? pinnedMessages[pinIndex % pinnedMessages.length] : null;

  // Auto-resize composer textarea height cleanly
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(132, Math.max(24, el.scrollHeight))}px`;
  }, [draft, activeConversationId, activeLane]);

  // Restore pixel scroll position per conversation
  useEffect(() => {
    if (!scrollRef.current || activeLane !== "workspace" || !activeConversationId) return;
    const saved = useWorkspaceStore.getState().scrollTops[activeConversationId];
    if (typeof saved === "number") {
      scrollRef.current.scrollTop = saved;
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversationId, activeLane]);

  // Auto-scroll to highlighted message when jumping from Search / Pin / File backlink
  useEffect(() => {
    if (!highlightedMessageId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-message-id="${highlightedMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedMessageId]);

  if (activeLane === "p2p") {
    return (
      <section
        className={cn(
          "flex flex-1 flex-col min-w-0 h-full bg-dl-surface-canvas/35",
          mobileView === "list" && "max-compact:hidden"
        )}
      >
        <header className="dl-glass-chrome flex items-center justify-between border-b border-dl-border-hairline px-5 max-compact:px-3.5 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <IconButton
              variant="ghost"
              size="sm"
              className="hidden max-compact:inline-flex"
              onClick={() => setMobileView("list")}
              label="返回列表"
            >
              <ChevronLeft className="size-4" strokeWidth={2} />
            </IconButton>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-direct/16 text-dl-lane-direct">
              <ShieldCheck className="size-[18px]" strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-dl-text-primary">
                {p2pRoom ? `私密直连 · #${p2pRoom.roomId}` : "私密直连通道"}
              </h1>
              <p className="truncate text-xs text-dl-lane-direct">
                {p2pRoom
                  ? `AES-256-GCM · 密钥指纹 ${p2pRoom.keyFingerprint}`
                  : "端到端加密 · 刷新页面即清空内存"}
              </p>
            </div>
          </div>
          {p2pRoom && (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => {
                void navigator.clipboard?.writeText(p2pRoom.shareUrl);
                setCopiedLink(true);
                setTimeout(() => setCopiedLink(false), 1800);
              }}
            >
              {copiedLink ? (
                <>
                  <Check className="size-3.5 text-dl-success" strokeWidth={2} />
                  已复制链接
                </>
              ) : (
                <>
                  <Copy className="size-3.5" strokeWidth={1.8} />
                  复制加密链接
                </>
              )}
            </Button>
          )}
        </header>

        <div className="dl-scroll flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          {!p2pRoom ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-dl-lane-direct/14 text-dl-lane-direct">
                <ShieldCheck className="size-6" strokeWidth={1.75} />
              </div>
              <div className="space-y-1 max-w-xs">
                <div className="text-sm font-semibold text-dl-text-primary">
                  开启零落盘端到端加密会话
                </div>
                <p className="text-xs leading-relaxed text-dl-text-secondary">
                  直连密钥仅驻留在 URL <code className="font-mono text-dl-lane-direct">#k=</code> 片段与双方设备内存中，从不发往服务端。
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="border-dl-lane-direct/35 bg-dl-lane-direct/15 text-dl-lane-direct hover:bg-dl-lane-direct/25"
                onClick={() => void createP2PRoom()}
              >
                <Plus className="size-3.5" strokeWidth={2} />
                立即创建加密房间
              </Button>
            </div>
          ) : p2pMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-dl-text-secondary">
              直连通道已就绪，消息采用 AES-256-GCM 在内存中实时加解密。
            </div>
          ) : (
            p2pMessages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
                className={cn("flex flex-col", msg.isOwn ? "items-end" : "items-start")}
              >
                <div
                  className={cn(
                    "max-w-[72%] max-compact:max-w-[86%] rounded-[18px] px-3.5 py-2 text-[14px] leading-relaxed shadow-2xs",
                    msg.isOwn
                      ? "rounded-br-[6px] bg-dl-lane-direct text-dl-on-direct"
                      : "rounded-bl-[6px] dl-glass-elevated border border-dl-border-hairline text-dl-text-primary"
                  )}
                >
                  <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                  <div
                    className={cn(
                      "mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums",
                      msg.isOwn ? "opacity-75" : "text-dl-text-tertiary"
                    )}
                  >
                    <span>
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {msg.isOwn && <CheckCheck className="size-3" strokeWidth={2} />}
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </div>

        {p2pRoom && (
          <div className="px-5 max-compact:px-3 pb-4 pt-1.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendP2PMessage(p2pDraft);
              }}
              className="dl-glass-pill flex items-center gap-2 rounded-2xl border border-dl-border-hairline px-3.5 py-2"
            >
              <input
                value={p2pDraft}
                onChange={(e) => setP2PDraft(e.target.value)}
                placeholder="发送端到端加密消息…"
                className="flex-1 bg-transparent text-sm text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={!p2pDraft.trim()}
                className="gap-1.5 border-transparent bg-dl-lane-direct text-dl-on-direct hover:brightness-105 disabled:opacity-40"
              >
                <SendHorizontal className="size-3.5" strokeWidth={2} />
                发送
              </Button>
            </form>
          </div>
        )}
      </section>
    );
  }

  if (!activeConv) {
    return (
      <section
        className={cn(
          "flex flex-1 items-center justify-center bg-dl-surface-canvas/35 text-sm text-dl-text-tertiary",
          mobileView === "list" && "max-compact:hidden"
        )}
      >
        请从左侧选择一个对话或「我的收藏」开始交流
      </section>
    );
  }

  const editingMsg = editingMessageId ? messageMap.get(editingMessageId) || null : null;
  const replyTarget = replyToId ? messageMap.get(replyToId) || null : null;

  const submitCurrentMessage = async () => {
    if (!draft.trim()) return;
    if (editingMsg) {
      await editWorkspaceMessage(activeConv.id, editingMsg.id, draft);
      setDraft(activeConv.id, "");
      return;
    }
    const text = draft;
    const reply = replyToId;
    setReplyToId(undefined);
    await sendWorkspaceMessage(activeConv.id, text, reply);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCurrentMessage();
  };

  const handleForwardSubmit = async () => {
    if (!forwardMsgId || !forwardTargetConvId) return;
    setForwarding(true);
    try {
      await forwardMessage([forwardMsgId], forwardTargetConvId);
      setForwardMsgId(null);
    } finally {
      setForwarding(false);
    }
  };

  return (
    <section
      className={cn(
        "flex flex-1 flex-col min-w-0 h-full bg-dl-surface-canvas/35",
        mobileView === "list" && "max-compact:hidden"
      )}
    >
      {/* Header */}
      <header className="dl-glass-chrome flex items-center justify-between border-b border-dl-border-hairline px-5 max-compact:px-3.5 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <IconButton
            variant="ghost"
            size="sm"
            className="hidden max-compact:inline-flex"
            onClick={() => setMobileView("list")}
            label="返回对话列表"
          >
            <ChevronLeft className="size-4" strokeWidth={2} />
          </IconButton>

          {activeConv.kind === "saved" ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/16 text-dl-lane-shared">
              <Bookmark className="size-[18px]" strokeWidth={1.9} />
            </div>
          ) : (
            <Avatar name={activeConv.title} size="md" />
          )}

          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-dl-text-primary">
              {activeConv.title}
            </h1>
            <p className="truncate text-xs text-dl-text-secondary">
              {activeConv.kind === "saved"
                ? "个人专属云端备忘与跨设备收藏"
                : `${activeConv.memberIds.length || 1} 位空间成员 · 支持置顶与线程讨论`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip content="对话详情、成员与置顶管理" side="bottom">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-xs text-dl-text-secondary hover:text-dl-text-primary"
              onClick={openDetailsInspector}
            >
              <PanelRightOpen className="size-4" strokeWidth={1.75} />
              <span className="max-compact:hidden">详情与置顶</span>
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* Pinned Message Carousel Banner */}
      <AnimatePresence initial={false}>
        {currentPin && (
          <motion.div
            key="pinned-banner"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16 }}
            className="dl-glass-elevated z-10 flex items-center justify-between gap-2 border-b border-dl-border-hairline px-5 max-compact:px-3.5 py-1.5 text-xs"
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-7 min-w-0 flex-1 justify-start gap-2 truncate px-1.5 text-left"
              onClick={() => {
                jumpToMessage(activeConv.id, currentPin.id);
                setPinIndex((i) => i + 1);
              }}
            >
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-dl-lane-shared">
                <Pin className="size-3.5" strokeWidth={2} />
                置顶
                {pinnedMessages.length > 1
                  ? ` ${(pinIndex % pinnedMessages.length) + 1}/${pinnedMessages.length}`
                  : ""}
              </span>
              <span className="h-3 w-px shrink-0 bg-dl-border-strong" />
              <span className="truncate text-dl-text-secondary">{currentPin.plainText}</span>
            </Button>
            <IconButton
              variant="ghost"
              size="sm"
              className="size-7"
              onClick={() => void togglePinMessage(activeConv.id, currentPin.id)}
              label="取消置顶此消息"
            >
              <PinOff className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Message Timeline */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(activeConv.id, e.currentTarget.scrollTop)}
        className="dl-scroll flex-1 overflow-y-auto px-5 max-compact:px-3 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-dl-text-tertiary">
            还没有消息，发一句打个招呼吧。
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isOwn = msg.senderId === currentUser?.id;
            const isHighlighted = highlightedMessageId === msg.id;
            const prevMsg = messages[idx - 1];
            const nextMsg = messages[idx + 1];
            const groupedWithPrev = isGroupedPair(prevMsg, msg);
            const groupedWithNext = isGroupedPair(msg, nextMsg);
            const repliedMsg = msg.replyToId ? messageMap.get(msg.replyToId) : undefined;
            const isPinned = activeConv.pinnedMessageIds.includes(msg.id);
            const hasReactionsOrThread =
              Object.keys(msg.reactions).length > 0 || (msg.threadReplyCount || 0) > 0;

            return (
              <div
                key={msg.id}
                data-message-id={msg.id}
                onDoubleClick={() => setReplyToId(msg.id)}
                className={cn(
                  "group relative flex flex-col rounded-2xl px-1.5 py-0.5 transition-colors",
                  idx === 0 ? "mt-0" : groupedWithPrev ? "mt-1" : "mt-4",
                  isOwn ? "items-end" : "items-start",
                  isHighlighted && "bg-dl-lane-shared/14 ring-1 ring-dl-lane-shared/40 py-1.5"
                )}
              >
                {/* Floating Hover Quick Action Pill (Zero vertical layout shift!) */}
                <div
                  className={cn(
                    "dl-glass-pill absolute -top-3.5 z-sticky flex items-center gap-0.5 rounded-full border border-dl-border-hairline px-1 py-0.5",
                    "opacity-0 pointer-events-none translate-y-1 transition-all duration-150",
                    "group-hover:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0",
                    "focus-within:opacity-100 focus-within:pointer-events-auto focus-within:translate-y-0",
                    isOwn ? "right-2" : "left-11"
                  )}
                >
                  <Popover>
                    <PopoverTrigger asChild>
                      <IconButton size="sm" variant="ghost" className="size-6 rounded-full" label="添加表情回应">
                        <Smile className="size-3.5" strokeWidth={1.85} />
                      </IconButton>
                    </PopoverTrigger>
                    <PopoverContent side="top" align={isOwn ? "end" : "start"} className="p-1">
                      <div className="flex items-center gap-0.5">
                        {QUICK_REACTIONS.map((emoji) => (
                          <Button
                            key={emoji}
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 rounded-full p-0 text-sm"
                            onClick={() => void toggleReaction(activeConv.id, msg.id, emoji)}
                          >
                            {emoji}
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>

                  <IconButton
                    size="sm"
                    variant="ghost"
                    className="size-6 rounded-full"
                    label="引用回复"
                    onClick={() => {
                      setReplyToId(msg.id);
                      composerRef.current?.focus();
                    }}
                  >
                    <Reply className="size-3.5" strokeWidth={1.85} />
                  </IconButton>

                  <IconButton
                    size="sm"
                    variant="ghost"
                    className="size-6 rounded-full"
                    label="在右侧展开线程讨论"
                    onClick={() => openThreadInspector(msg.id)}
                  >
                    <MessageSquareText className="size-3.5" strokeWidth={1.85} />
                  </IconButton>

                  <IconButton
                    size="sm"
                    variant="ghost"
                    className="size-6 rounded-full"
                    label="转发消息"
                    onClick={() => {
                      setForwardMsgId(msg.id);
                      setForwardTargetConvId(conversationOrder[0] || "");
                    }}
                  >
                    <Forward className="size-3.5" strokeWidth={1.85} />
                  </IconButton>

                  <IconButton
                    size="sm"
                    variant="ghost"
                    className={cn("size-6 rounded-full", isPinned && "text-dl-lane-shared")}
                    label={isPinned ? "取消置顶" : "置顶到对话顶部"}
                    onClick={() => void togglePinMessage(activeConv.id, msg.id)}
                  >
                    {isPinned ? (
                      <PinOff className="size-3.5" strokeWidth={1.85} />
                    ) : (
                      <Pin className="size-3.5" strokeWidth={1.85} />
                    )}
                  </IconButton>

                  {isOwn && !msg.card && (
                    <IconButton
                      size="sm"
                      variant="ghost"
                      className="size-6 rounded-full"
                      label="编辑消息"
                      onClick={() => {
                        setEditingMessageId(msg.id);
                        setDraft(activeConv.id, msg.plainText);
                        composerRef.current?.focus();
                      }}
                    >
                      <Pencil className="size-3.5" strokeWidth={1.85} />
                    </IconButton>
                  )}
                </div>

                <div
                  className={cn(
                    "flex items-end gap-2.5 max-w-[76%] max-compact:max-w-[88%]",
                    isOwn && "flex-row-reverse"
                  )}
                >
                  {!isOwn &&
                    (groupedWithNext ? (
                      <div className="w-7 shrink-0" aria-hidden="true" />
                    ) : (
                      <Avatar name={msg.senderName} size="sm" />
                    ))}

                  <div className={cn("flex flex-col min-w-0", isOwn ? "items-end" : "items-start")}>
                    {!isOwn && !groupedWithPrev && (
                      <div className="mb-1 flex items-center gap-1.5 px-1">
                        <span className="text-[11px] font-semibold text-dl-text-secondary">
                          {msg.senderName}
                        </span>
                      </div>
                    )}

                    {msg.card ? (
                      <DualLaneCardKit card={msg.card} onAction={triggerCardAction} />
                    ) : (
                      <div
                        className={cn(
                          "rounded-[18px] px-3.5 py-2 text-[14px] leading-[1.52] shadow-2xs transition-colors",
                          isOwn
                            ? cn(
                                "bg-dl-lane-shared text-dl-on-shared",
                                groupedWithPrev && "rounded-tr-[6px]",
                                !groupedWithNext && "rounded-br-[6px]"
                              )
                            : cn(
                                "dl-glass-elevated border border-dl-border-hairline text-dl-text-primary",
                                groupedWithPrev && "rounded-tl-[6px]",
                                !groupedWithNext && "rounded-bl-[6px]"
                              )
                        )}
                      >
                        {msg.replyToId && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => jumpToMessage(activeConv.id, msg.replyToId!)}
                            className={cn(
                              "mb-1.5 flex h-auto w-full flex-col items-start gap-0.5 rounded-lg border-l-2 px-2 py-1 text-left text-[11px]",
                              isOwn
                                ? "border-current/50 bg-black/10 text-dl-on-shared hover:bg-black/15"
                                : "border-dl-lane-shared bg-dl-lane-shared/8 text-dl-text-secondary hover:bg-dl-lane-shared/14"
                            )}
                          >
                            <span className="font-semibold">
                              {repliedMsg ? repliedMsg.senderName : "引用消息"}
                            </span>
                            <span className="w-full truncate opacity-85">
                              {repliedMsg ? repliedMsg.plainText : `#${msg.replyToId.slice(-6)}`}
                            </span>
                          </Button>
                        )}

                        <div className="whitespace-pre-wrap break-words">{msg.plainText}</div>

                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {msg.attachments.map((att, attIdx) => (
                              <Button
                                key={att.id}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={cn(
                                  "h-auto gap-2 rounded-xl border px-2.5 py-1.5 text-left text-xs",
                                  isOwn
                                    ? "border-current/25 bg-black/10 text-dl-on-shared hover:bg-black/15"
                                    : "border-dl-border-hairline bg-dl-surface-subtle/60 text-dl-text-primary"
                                )}
                                onClick={() => {
                                  if (att.mimeType.startsWith("image/")) {
                                    openLightbox(
                                      msg.attachments!.map((a) => ({
                                        ...a,
                                        conversationId: activeConv.id,
                                        sourceMessageId: msg.id,
                                      })),
                                      attIdx
                                    );
                                  } else {
                                    openFileInspector({
                                      ...att,
                                      conversationId: activeConv.id,
                                      sourceMessageId: msg.id,
                                    });
                                  }
                                }}
                              >
                                <FileText className="size-4 shrink-0 opacity-85" strokeWidth={1.8} />
                                <div className="min-w-0">
                                  <div className="truncate font-medium max-w-[200px]">
                                    {att.fileName}
                                  </div>
                                  <div className="text-[10px] opacity-75">
                                    {formatBytes(att.byteSize)}
                                  </div>
                                </div>
                              </Button>
                            ))}
                          </div>
                        )}

                        <div
                          className={cn(
                            "mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums select-none",
                            isOwn ? "opacity-75" : "text-dl-text-tertiary"
                          )}
                        >
                          {msg.editedAt && <span>(已编辑)</span>}
                          <span>
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {isOwn && (
                            <span className="inline-flex items-center">
                              {msg.status === "sending" ? (
                                <Clock className="size-3" strokeWidth={2} />
                              ) : msg.status === "failed" ? (
                                <AlertCircle className="size-3 text-dl-danger" strokeWidth={2} />
                              ) : msg.status === "read" ? (
                                <CheckCheck className="size-3.5" strokeWidth={2} />
                              ) : (
                                <Check className="size-3" strokeWidth={2} />
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Reactions & Thread Entry Pill */}
                    {hasReactionsOrThread && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 px-0.5">
                        {Object.entries(msg.reactions).map(([emoji, info]) => (
                          <Button
                            key={emoji}
                            size="sm"
                            variant="ghost"
                            onClick={() => void toggleReaction(activeConv.id, msg.id, emoji)}
                            className={cn(
                              "h-6 gap-1 rounded-full border px-2 text-[11px] tabular-nums",
                              info.reactedByMe
                                ? "border-dl-lane-shared/40 bg-dl-lane-shared/14 text-dl-lane-shared font-semibold"
                                : "border-dl-border-hairline bg-dl-surface-subtle/75 text-dl-text-secondary"
                            )}
                          >
                            <span>{emoji}</span>
                            <span>{info.count}</span>
                          </Button>
                        ))}

                        {(msg.threadReplyCount || 0) > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openThreadInspector(msg.id)}
                            className="h-6 gap-1 rounded-full border border-dl-lane-shared/35 bg-dl-lane-shared/12 px-2.5 text-[11px] font-medium text-dl-lane-shared hover:bg-dl-lane-shared/20"
                          >
                            <MessageSquareText className="size-3" strokeWidth={2} />
                            {msg.threadReplyCount} 条线程回复
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Floating Multi-line Vibrancy Composer */}
      <div className="px-5 max-compact:px-3 pb-4 pt-1.5">
        <AnimatePresence initial={false}>
          {(replyTarget || editingMsg) && (
            <motion.div
              key="composer-context-bar"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.14 }}
              className="dl-glass-elevated mb-1.5 flex items-center justify-between gap-2 rounded-xl border border-dl-border-hairline px-3 py-1.5 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                {editingMsg ? (
                  <Pencil className="size-3.5 shrink-0 text-dl-lane-shared" strokeWidth={1.9} />
                ) : (
                  <Reply className="size-3.5 shrink-0 text-dl-lane-shared" strokeWidth={1.9} />
                )}
                <span className="truncate text-dl-text-secondary">
                  {editingMsg ? (
                    <>
                      <strong className="font-semibold text-dl-text-primary">正在编辑：</strong>
                      {editingMsg.plainText}
                    </>
                  ) : (
                    <>
                      <strong className="font-semibold text-dl-text-primary">
                        回复 {replyTarget?.senderName}：
                      </strong>
                      {replyTarget?.plainText}
                    </>
                  )}
                </span>
              </div>
              <IconButton
                size="sm"
                variant="ghost"
                className="size-6 rounded-full"
                label="取消回复或编辑"
                onClick={() => {
                  setReplyToId(undefined);
                  setEditingMessageId(null);
                  if (editingMsg) setDraft(activeConv.id, "");
                }}
              >
                <X className="size-3.5" strokeWidth={1.9} />
              </IconButton>
            </motion.div>
          )}
        </AnimatePresence>

        <form
          onSubmit={handleSubmit}
          className="dl-glass-pill flex items-end gap-2 rounded-2xl border border-dl-border-hairline px-2.5 py-2 transition-shadow focus-within:border-dl-lane-shared/45"
        >
          <Popover>
            <PopoverTrigger asChild>
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-xl shrink-0"
                label="Slash 快捷指令与动作"
              >
                <Slash className="size-4" strokeWidth={1.85} />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent side="top" align="start">
              <div className="w-52 space-y-1 p-0.5">
                <div className="px-2 py-1 text-[11px] font-semibold text-dl-text-tertiary">
                  机器人 Slash 指令
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between text-xs"
                  onClick={() => {
                    setDraft(activeConv.id, `${draft}/summarize `);
                    composerRef.current?.focus();
                  }}
                >
                  <span className="font-mono text-dl-lane-shared">/summarize</span>
                  <span className="text-dl-text-tertiary">总结对话</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between text-xs"
                  onClick={() => {
                    setDraft(activeConv.id, `${draft}/poll `);
                    composerRef.current?.focus();
                  }}
                >
                  <span className="font-mono text-dl-lane-shared">/poll</span>
                  <span className="text-dl-text-tertiary">发起投票卡片</span>
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(activeConv.id, e.target.value, replyToId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submitCurrentMessage();
              }
            }}
            placeholder={`发送消息到 ${activeConv.title}…`}
            className="dl-scroll max-h-[132px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
          />

          <div className="flex items-center gap-2 shrink-0">
            <span className="hidden wide:inline-flex items-center gap-1 text-[10px] text-dl-text-tertiary select-none">
              <kbd className="dl-kbd">↵</kbd>
              <span>发送</span>
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!draft.trim()}
              className="h-8 gap-1.5 rounded-xl px-3"
            >
              <SendHorizontal className="size-3.5" strokeWidth={2} />
              <span>{editingMsg ? "保存" : "发送"}</span>
            </Button>
          </div>
        </form>
      </div>

      {/* Forward Dialog */}
      <Dialog
        open={Boolean(forwardMsgId)}
        onOpenChange={(open) => {
          if (!open) setForwardMsgId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>转发消息</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 p-6 pt-4">
            <Select
              value={forwardTargetConvId}
              onValueChange={setForwardTargetConvId}
              options={conversationOrder.map((id) => ({
                value: id,
                label: conversations[id]?.title || id,
              }))}
              placeholder="选择目标对话（含「我的收藏」）"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForwardMsgId(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                busy={forwarding}
                disabled={!forwardTargetConvId}
                onClick={() => void handleForwardSubmit()}
              >
                确认转发
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
