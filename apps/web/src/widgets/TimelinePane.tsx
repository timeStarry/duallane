import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore, type V1Message } from "@/entities/workspace/store";
import { Avatar, Button, Dialog, DialogContent, DialogHeader, DialogTitle, IconButton, Popover, PopoverContent, PopoverTrigger, Select } from "@/shared/ui";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";
import { cn } from "@/shared/lib/cn";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "🔥", "👀"];

export function TimelinePane() {
  const {
    activeLane,
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
    p2pMessages,
    p2pDraft,
    setP2PDraft,
    sendP2PMessage,
  } = useWorkspaceStore();

  const [pinIndex, setPinIndex] = useState(0);
  const [forwardMsgId, setForwardMsgId] = useState<string | null>(null);
  const [forwardTargetConvId, setForwardTargetConvId] = useState<string>("");
  const [forwarding, setForwarding] = useState(false);
  const [replyToId, setReplyToId] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = useMemo(
    () => (activeConversationId ? messagesByConv[activeConversationId] || [] : []),
    [activeConversationId, messagesByConv]
  );
  const draft = activeConversationId ? drafts[activeConversationId]?.text || "" : "";

  const pinnedMessages = useMemo(() => {
    if (!activeConv) return [];
    const byId = new Map(messages.map((m) => [m.id, m]));
    return activeConv.pinnedMessageIds.map((id) => byId.get(id)).filter((m): m is V1Message => Boolean(m));
  }, [activeConv, messages]);

  const currentPin = pinnedMessages.length > 0 ? pinnedMessages[pinIndex % pinnedMessages.length] : null;

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
      <section className="flex flex-1 flex-col min-w-0 h-full bg-dl-surface-canvas/40">
        <header className="dl-glass-chrome flex items-center justify-between border-b border-dl-border-hairline px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-dl-lane-direct/15 text-base">
              🔐
            </div>
            <div>
              <h1 className="text-sm font-semibold text-dl-text-primary">
                {p2pRoom ? `私密直连 · #${p2pRoom.roomId}` : "私密直连通道"}
              </h1>
              <p className="text-xs text-dl-lane-direct">
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
              onClick={() => void navigator.clipboard?.writeText(p2pRoom.shareUrl)}
            >
              复制邀请链接
            </Button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {!p2pRoom ? (
            <div className="flex h-full items-center justify-center text-sm text-dl-text-tertiary">
              请在左侧点击「新建房间」或打开包含 `#k=` 密钥的直连链接。
            </div>
          ) : p2pMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-dl-text-tertiary">
              直连通道已就绪，消息仅在双方设备内存中加解密。
            </div>
          ) : (
            p2pMessages.map((msg) => (
              <div
                key={msg.id}
                className={cn("flex flex-col", msg.isOwn ? "items-end" : "items-start")}
              >
                <div
                  className={cn(
                    "max-w-[72%] rounded-2xl px-3.5 py-2 text-sm shadow-xs",
                    msg.isOwn
                      ? "bg-dl-lane-direct text-white"
                      : "dl-glass-elevated border border-dl-border-hairline text-dl-text-primary"
                  )}
                >
                  <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                  <div
                    className={cn(
                      "mt-1 text-[10px] text-right",
                      msg.isOwn ? "text-white/80" : "text-dl-text-tertiary"
                    )}
                  >
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {msg.isOwn ? " ✓✓" : ""}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {p2pRoom && (
          <div className="p-4 pt-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendP2PMessage(p2pDraft);
              }}
              className="dl-glass-elevated flex items-center gap-2 rounded-2xl border border-dl-border-hairline px-3 py-2 shadow-sm"
            >
              <input
                value={p2pDraft}
                onChange={(e) => setP2PDraft(e.target.value)}
                placeholder="发送端到端加密消息…"
                className="flex-1 bg-transparent text-sm text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!p2pDraft.trim()}>
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
      <section className="flex flex-1 items-center justify-center bg-dl-surface-canvas/40 text-sm text-dl-text-tertiary">
        请从左侧选择一个对话或「我的收藏」开始交流
      </section>
    );
  }

  const editingMsg = editingMessageId ? messages.find((m) => m.id === editingMessageId) : null;
  const replyTarget = replyToId ? messages.find((m) => m.id === replyToId) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    <section className="flex flex-1 flex-col min-w-0 h-full bg-dl-surface-canvas/40">
      {/* Header */}
      <header className="dl-glass-chrome flex items-center justify-between border-b border-dl-border-hairline px-5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {activeConv.kind === "saved" ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-dl-lane-shared/15 text-base">
              🔖
            </div>
          ) : (
            <Avatar name={activeConv.title} size="md" />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-dl-text-primary">
              {activeConv.title}
            </h1>
            <p className="text-xs text-dl-text-tertiary">
              {activeConv.kind === "saved"
                ? "个人专属云端备忘与文件收藏"
                : `${activeConv.memberIds.length || 1} 位成员`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={openDetailsInspector}>
            详情与置顶
          </Button>
        </div>
      </header>

      {/* Pinned Message Banner */}
      {currentPin && (
        <div className="dl-glass-elevated flex items-center justify-between gap-3 border-b border-dl-border-hairline px-5 py-2 text-xs">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-start truncate px-1 text-left"
            onClick={() => {
              jumpToMessage(activeConv.id, currentPin.id);
              setPinIndex((i) => i + 1);
            }}
          >
            <span className="font-semibold text-dl-lane-shared mr-2">
              📌 置顶消息 {pinnedMessages.length > 1 ? `(${(pinIndex % pinnedMessages.length) + 1}/${pinnedMessages.length})` : ""}
            </span>
            <span className="truncate text-dl-text-secondary">{currentPin.plainText}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void togglePinMessage(activeConv.id, currentPin.id)}
          >
            取消置顶
          </Button>
        </div>
      )}

      {/* Timeline */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(activeConv.id, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-dl-text-tertiary">
            还没有消息，发一句打个招呼吧。
          </div>
        ) : (
          messages.map((msg) => {
            const isOwn = msg.senderId === currentUser?.id;
            const isHighlighted = highlightedMessageId === msg.id;
            return (
              <div
                key={msg.id}
                data-message-id={msg.id}
                onDoubleClick={() => setReplyToId(msg.id)}
                className={cn(
                  "group flex flex-col gap-1 rounded-2xl p-1 transition-colors",
                  isOwn ? "items-end" : "items-start",
                  isHighlighted && "bg-dl-lane-shared/15 ring-1 ring-dl-lane-shared/40"
                )}
              >
                <div className={cn("flex items-end gap-2 max-w-[78%]", isOwn && "flex-row-reverse")}>
                  {!isOwn && <Avatar name={msg.senderName} size="sm" />}

                  <div className="space-y-1.5 min-w-0">
                    {!isOwn && (
                      <div className="text-[11px] font-medium text-dl-text-secondary px-1">
                        {msg.senderName}
                      </div>
                    )}

                    {msg.card ? (
                      <DualLaneCardKit card={msg.card} onAction={triggerCardAction} />
                    ) : (
                      <div
                        className={cn(
                          "rounded-2xl px-3.5 py-2 text-sm shadow-xs",
                          isOwn
                            ? "bg-dl-lane-shared text-white"
                            : "dl-glass-elevated border border-dl-border-hairline text-dl-text-primary"
                        )}
                      >
                        {msg.replyToId && (
                          <div
                            className={cn(
                              "mb-1.5 border-l-2 pl-2 text-[11px] truncate opacity-85",
                              isOwn ? "border-white/60" : "border-dl-lane-shared"
                            )}
                          >
                            回复消息 #{msg.replyToId.slice(-6)}
                          </div>
                        )}
                        <div className="whitespace-pre-wrap break-words">{msg.plainText}</div>

                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {msg.attachments.map((att, idx) => (
                              <Button
                                key={att.id}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-auto rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-2.5 py-1.5 text-xs"
                                onClick={() => {
                                  if (att.mimeType.startsWith("image/")) {
                                    openLightbox(
                                      msg.attachments!.map((a) => ({
                                        ...a,
                                        conversationId: activeConv.id,
                                        sourceMessageId: msg.id,
                                      })),
                                      idx
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
                                📎 {att.fileName}
                              </Button>
                            ))}
                          </div>
                        )}

                        <div
                          className={cn(
                            "mt-1 flex items-center justify-end gap-1.5 text-[10px]",
                            isOwn ? "text-white/80" : "text-dl-text-tertiary"
                          )}
                        >
                          {msg.editedAt && <span>已编辑</span>}
                          <span>
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {isOwn && (
                            <span>
                              {msg.status === "sending"
                                ? "⏳"
                                : msg.status === "failed"
                                ? "!"
                                : msg.status === "read"
                                ? "✓✓"
                                : "✓"}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Reactions & Thread Pill */}
                    <div className="flex flex-wrap items-center gap-1.5 px-1">
                      {Object.entries(msg.reactions).map(([emoji, info]) => (
                        <Button
                          key={emoji}
                          size="sm"
                          variant="ghost"
                          onClick={() => void toggleReaction(activeConv.id, msg.id, emoji)}
                          className={cn(
                            "h-6 rounded-full border px-2 text-[11px]",
                            info.reactedByMe
                              ? "border-dl-lane-shared bg-dl-lane-shared/12 text-dl-lane-shared"
                              : "border-dl-border-hairline bg-dl-surface-subtle/60 text-dl-text-secondary"
                          )}
                        >
                          {emoji} {info.count}
                        </Button>
                      ))}

                      {(msg.threadReplyCount || 0) > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openThreadInspector(msg.id)}
                          className="h-6 rounded-full border border-dl-lane-shared/30 bg-dl-lane-shared/10 px-2.5 text-[11px] text-dl-lane-shared"
                        >
                          💬 {msg.threadReplyCount} 条线程回复
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Hover Quick Actions */}
                <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs">
                        ☺
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent>
                    <div className="flex items-center gap-1">
                      {QUICK_REACTIONS.map((emoji) => (
                        <Button
                          key={emoji}
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-sm"
                          onClick={() => void toggleReaction(activeConv.id, msg.id, emoji)}
                        >
                          {emoji}
                        </Button>
                      ))}
                    </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setReplyToId(msg.id)}
                  >
                    回复
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => openThreadInspector(msg.id)}
                  >
                    线程
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      setForwardMsgId(msg.id);
                      setForwardTargetConvId(conversationOrder[0] || "");
                    }}
                  >
                    转发
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void togglePinMessage(activeConv.id, msg.id)}
                  >
                    {activeConv.pinnedMessageIds.includes(msg.id) ? "取消置顶" : "置顶"}
                  </Button>
                  {isOwn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        setEditingMessageId(msg.id);
                        setDraft(activeConv.id, msg.plainText);
                      }}
                    >
                      编辑
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Minimal Floating 4-item Composer */}
      <div className="p-4 pt-2">
        {(replyTarget || editingMsg) && (
          <div className="mb-1.5 flex items-center justify-between rounded-xl bg-dl-surface-subtle/80 px-3 py-1.5 text-xs border border-dl-border-hairline">
            <span className="truncate text-dl-text-secondary">
              {editingMsg
                ? `正在编辑：${editingMsg.plainText}`
                : `回复 ${replyTarget?.senderName}：${replyTarget?.plainText}`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[11px]"
              onClick={() => {
                setReplyToId(undefined);
                setEditingMessageId(null);
                if (editingMsg) setDraft(activeConv.id, "");
              }}
            >
              取消
            </Button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="dl-glass-elevated flex items-center gap-2 rounded-2xl border border-dl-border-hairline px-3 py-2 shadow-sm"
        >
          <Popover>
            <PopoverTrigger asChild>
              <IconButton type="button" variant="ghost" label="快捷指令">
                ＋
              </IconButton>
            </PopoverTrigger>
            <PopoverContent>
            <div className="w-44 space-y-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => setDraft(activeConv.id, `${draft}/summarize `)}
              >
                /summarize 总结对话
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => setDraft(activeConv.id, `${draft}/poll `)}
              >
                /poll 发起投票卡片
              </Button>
            </div>
            </PopoverContent>
          </Popover>

          <input
            value={draft}
            onChange={(e) => setDraft(activeConv.id, e.target.value, replyToId)}
            placeholder={`发送消息到 ${activeConv.title}…（双击消息可快捷回复）`}
            className="flex-1 bg-transparent text-sm text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
          />

          <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
            {editingMsg ? "保存" : "发送"}
          </Button>
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
            placeholder="选择目标对话"
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
