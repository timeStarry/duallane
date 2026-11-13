import React, { useEffect, useState } from "react";
import { FileText, LocateFixed, MessageSquareText, PinOff, SendHorizontal, Users, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { Avatar, Button, IconButton, Switch } from "@/shared/ui";

export function InspectorPane() {
  const {
    activeLane,
    inspectorOpen,
    inspectorTab,
    inspectorThreadRootId,
    inspectorFile,
    closeInspector,
  } = useLaneStore();
  const {
    activeConversationId,
    conversations,
    messagesByConv,
    members,
    threadsByRootId,
    loadThread,
    sendThreadReply,
    jumpToMessage,
    togglePinMessage,
  } = useWorkspaceStore();

  const [replyText, setReplyText] = useState("");
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (inspectorOpen && inspectorTab === "thread" && inspectorThreadRootId) {
      void loadThread(inspectorThreadRootId).catch(() => {});
    }
  }, [inspectorOpen, inspectorTab, inspectorThreadRootId, loadThread]);

  const showPane = inspectorOpen && activeLane === "workspace";
  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = activeConversationId ? messagesByConv[activeConversationId] || [] : [];

  const handleThreadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectorThreadRootId || !replyText.trim()) return;
    setSending(true);
    try {
      await sendThreadReply(inspectorThreadRootId, replyText.trim(), alsoSendToChannel);
      setReplyText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence initial={false}>
      {showPane && (
        <>
          {/* Subtle scrim only on narrow (< 1100px) screens where Inspector floats as an overlay drawer */}
          <motion.div
            key="inspector-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={closeInspector}
            className="hidden max-wide:block fixed inset-0 z-popover bg-backdrop/40 backdrop-blur-[2px]"
          />

          <motion.aside
            key="inspector-pane"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.85 }}
            className="dl-glass-chrome flex h-full w-[340px] max-compact:w-[min(340px,88vw)] shrink-0 flex-col border-l border-dl-border-hairline max-wide:fixed max-wide:right-0 max-wide:inset-y-0 max-wide:z-drawer max-wide:shadow-dialog"
          >
            <div className="flex items-center justify-between border-b border-dl-border-hairline px-4 py-3">
              <div className="flex items-center gap-2">
                {inspectorTab === "thread" ? (
                  <MessageSquareText className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                ) : inspectorTab === "file" ? (
                  <FileText className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                ) : (
                  <Users className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                )}
                <h2 className="text-sm font-semibold text-dl-text-primary">
                  {inspectorTab === "thread"
                    ? "话题线程"
                    : inspectorTab === "file"
                    ? "文件预览与溯源"
                    : "对话详情"}
                </h2>
              </div>
              <IconButton variant="ghost" size="sm" onClick={closeInspector} label="关闭检查器">
                <X className="size-4" strokeWidth={1.85} />
              </IconButton>
            </div>

            {inspectorTab === "thread" && inspectorThreadRootId && (
              <div className="flex flex-1 flex-col min-h-0">
                <div className="dl-scroll flex-1 overflow-y-auto p-4 space-y-3">
                  {(() => {
                    const thread = threadsByRootId[inspectorThreadRootId];
                    const localRoot = messages.find((m) => m.id === inspectorThreadRootId);
                    const rootText =
                      localRoot?.plainText ||
                      thread?.threadTitle ||
                      `消息 #${inspectorThreadRootId.slice(-6)}`;
                    const replies = thread?.replies || [];
                    return (
                      <>
                        <div className="dl-glass-elevated rounded-2xl border border-dl-border-hairline p-3.5">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-dl-lane-shared">
                              {localRoot?.senderName ? `${localRoot.senderName} · 根消息` : "根消息"}
                            </span>
                          </div>
                          <div className="text-[13px] leading-relaxed text-dl-text-primary whitespace-pre-wrap">
                            {rootText}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 px-1">
                          <span className="text-[11px] font-medium text-dl-text-secondary">
                            {replies.length} 条线程回复
                          </span>
                          <div className="h-px flex-1 bg-dl-border-hairline" />
                        </div>

                        {replies.map((reply) => {
                          const authorName =
                            reply.authorName ||
                            members[reply.authorId]?.displayName ||
                            reply.authorId;
                          return (
                            <div
                              key={reply.id}
                              className="flex items-start gap-2.5 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-3"
                            >
                              <Avatar name={authorName} size="sm" />
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-xs font-semibold text-dl-text-primary">
                                    {authorName}
                                  </span>
                                  {reply.alsoSendToChannel && (
                                    <span className="shrink-0 rounded-full bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared">
                                      已同步主对话
                                    </span>
                                  )}
                                </div>
                                <div className="text-[13px] leading-relaxed text-dl-text-primary whitespace-pre-wrap break-words">
                                  {reply.plainText}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>

                <form
                  onSubmit={handleThreadSubmit}
                  className="border-t border-dl-border-hairline p-3 space-y-2.5 bg-dl-surface-subtle/30"
                >
                  <div className="flex items-center justify-between px-0.5 text-xs text-dl-text-secondary">
                    <span>同时发送到主对话</span>
                    <Switch checked={alsoSendToChannel} onCheckedChange={setAlsoSendToChannel} />
                  </div>
                  <div className="dl-glass-pill flex items-center gap-2 rounded-xl border border-dl-border-hairline px-2.5 py-1.5">
                    <input
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="在线程中回复…"
                      className="flex-1 bg-transparent text-[13px] text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
                    />
                    <IconButton
                      type="submit"
                      size="sm"
                      variant="primary"
                      disabled={!replyText.trim() || sending}
                      label="发送线程回复"
                    >
                      <SendHorizontal className="size-3.5" strokeWidth={2} />
                    </IconButton>
                  </div>
                </form>
              </div>
            )}

            {inspectorTab === "details" && activeConv && (
              <div className="dl-scroll flex-1 overflow-y-auto p-4 space-y-5">
                <div>
                  <div className="mb-2 text-xs font-semibold text-dl-text-secondary">
                    置顶消息 ({activeConv.pinnedMessageIds.length})
                  </div>
                  {activeConv.pinnedMessageIds.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-dl-border-hairline p-3 text-xs text-dl-text-tertiary">
                      暂无置顶消息
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {activeConv.pinnedMessageIds.map((id) => {
                        const msg = messages.find((m) => m.id === id);
                        return (
                          <div
                            key={id}
                            className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-3 text-xs space-y-2"
                          >
                            <div className="text-dl-text-primary line-clamp-2 leading-relaxed">
                              {msg?.plainText || `消息 #${id}`}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 gap-1 px-2 text-[11px]"
                                onClick={() => jumpToMessage(activeConv.id, id)}
                              >
                                <LocateFixed className="size-3" strokeWidth={1.8} />
                                定位
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 gap-1 px-2 text-[11px] text-dl-text-secondary"
                                onClick={() => void togglePinMessage(activeConv.id, id)}
                              >
                                <PinOff className="size-3" strokeWidth={1.8} />
                                取消置顶
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-2 text-xs font-semibold text-dl-text-secondary">
                    成员列表 ({activeConv.memberIds.length})
                  </div>
                  <div className="space-y-1">
                    {activeConv.memberIds.map((id) => {
                      const m = members[id];
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-dl-surface-subtle/50 transition-colors"
                        >
                          <Avatar name={m?.displayName || id} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-dl-text-primary">
                              {m?.displayName || id}
                            </div>
                            <div className="text-[11px] text-dl-text-tertiary">
                              {m?.role === "bot"
                                ? "智能体机器人"
                                : m?.role === "owner"
                                ? "空间所有者"
                                : m?.role === "admin"
                                ? "管理员"
                                : "成员"}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {inspectorTab === "file" && inspectorFile && (
              <div className="dl-scroll flex-1 overflow-y-auto p-4 space-y-4">
                <div className="dl-glass-elevated rounded-2xl border border-dl-border-hairline p-5 text-center space-y-2.5">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-dl-lane-shared/14 text-dl-lane-shared">
                    <FileText className="size-6" strokeWidth={1.75} />
                  </div>
                  <div className="text-sm font-semibold text-dl-text-primary break-all">
                    {inspectorFile.fileName}
                  </div>
                  <div className="text-xs text-dl-text-tertiary">{inspectorFile.mimeType}</div>
                </div>

                {inspectorFile.sourceMessageId && inspectorFile.conversationId && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full gap-1.5"
                    onClick={() =>
                      jumpToMessage(inspectorFile.conversationId!, inspectorFile.sourceMessageId!)
                    }
                  >
                    <LocateFixed className="size-3.5" strokeWidth={1.9} />
                    在对话中定位原消息
                  </Button>
                )}
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
