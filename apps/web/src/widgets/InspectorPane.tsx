import React, { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  Download,
  FileText,
  LocateFixed,
  LogOut,
  MessageSquareText,
  PinOff,
  RotateCcw,
  SendHorizontal,
  Settings2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { renderMessageParts } from "@/emotes";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { cn } from "@/shared/lib/cn";
import { triggerBrowserDownload } from "@/shared/lib/download";
import { Avatar, Button, IconButton, Input, Switch } from "@/shared/ui";
import { MessageRichContent } from "@/widgets/EmoteSystem";

const GROUP_EMOJI_PRESETS = ["🚀", "💡", "🎨", "🛠️", "📌", "⚡", "🌿", "🎯"];

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
    pinnedConversationIds,
    messagesByConv,
    members,
    threadsByRootId,
    loadThread,
    sendThreadReply,
    jumpToMessage,
    togglePinMessage,
    togglePinConversation,
    updateGroupProfile,
    uploadGroupAvatar,
    inviteGroupMembers,
    leaveGroup,
  } = useWorkspaceStore();

  const [replyText, setReplyText] = useState("");
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [sending, setSending] = useState(false);

  const [titleDraftByConv, setTitleDraftByConv] = useState<Record<string, string>>({});
  const [savingGroup, setSavingGroup] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [invitingOpenConvId, setInvitingOpenConvId] = useState<string | null>(null);
  const [selectedInviteIdsByConv, setSelectedInviteIdsByConv] = useState<Record<string, string[]>>(
    {}
  );
  const [invitingBusy, setInvitingBusy] = useState(false);
  const [confirmLeaveConvId, setConfirmLeaveConvId] = useState<string | null>(null);
  const [groupErrorByConv, setGroupErrorByConv] = useState<Record<string, string>>({});
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inspectorOpen && inspectorTab === "thread" && inspectorThreadRootId) {
      void loadThread(inspectorThreadRootId).catch(() => {});
    }
  }, [inspectorOpen, inspectorTab, inspectorThreadRootId, loadThread]);

  useEffect(() => {
    if (!inspectorOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeInspector();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpen, closeInspector]);

  const showPane = inspectorOpen && activeLane === "workspace";
  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = activeConversationId ? messagesByConv[activeConversationId] || [] : [];

  const convKey = activeConv?.id || "";
  const titleDraft = activeConv ? (titleDraftByConv[convKey] ?? activeConv.title) : "";
  const invitingOpen = Boolean(convKey && invitingOpenConvId === convKey);
  const selectedInviteIds = convKey ? selectedInviteIdsByConv[convKey] || [] : [];
  const confirmLeave = Boolean(convKey && confirmLeaveConvId === convKey);
  const groupActionError = convKey ? groupErrorByConv[convKey] || "" : "";
  const setGroupError = (convId: string, msg: string) =>
    setGroupErrorByConv((prev) => ({ ...prev, [convId]: msg }));

  const handleSaveGroupTitle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConv || activeConv.kind !== "group") return;
    const convId = activeConv.id;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === activeConv.title) return;
    setGroupError(convId, "");
    setSavingGroup(true);
    try {
      await updateGroupProfile(convId, { title: trimmed });
      setTitleDraftByConv((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    } catch (err) {
      setGroupError(convId, err instanceof Error ? err.message : "更新群聊名称失败");
    } finally {
      setSavingGroup(false);
    }
  };

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeConv || activeConv.kind !== "group") return;
    const convId = activeConv.id;
    setGroupError(convId, "");
    setUploadingAvatar(true);
    try {
      await uploadGroupAvatar(convId, file);
    } catch (err) {
      setGroupError(convId, err instanceof Error ? err.message : "上传群头像失败");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleEmojiAvatarSelect = async (emoji: string | null) => {
    if (!activeConv || activeConv.kind !== "group") return;
    const convId = activeConv.id;
    setGroupError(convId, "");
    setSavingGroup(true);
    try {
      await updateGroupProfile(convId, { avatar: emoji });
    } catch (err) {
      setGroupError(convId, err instanceof Error ? err.message : "更新群头像失败");
    } finally {
      setSavingGroup(false);
    }
  };

  const handleConfirmInvite = async () => {
    if (!activeConv || selectedInviteIds.length === 0) return;
    const convId = activeConv.id;
    setGroupError(convId, "");
    setInvitingBusy(true);
    try {
      await inviteGroupMembers(convId, selectedInviteIds);
      setSelectedInviteIdsByConv((prev) => ({ ...prev, [convId]: [] }));
      setInvitingOpenConvId(null);
    } catch (err) {
      setGroupError(convId, err instanceof Error ? err.message : "邀请成员失败");
    } finally {
      setInvitingBusy(false);
    }
  };

  const handleConfirmLeaveGroup = async () => {
    if (!activeConv || activeConv.kind !== "group") return;
    const convId = activeConv.id;
    setGroupError(convId, "");
    setSavingGroup(true);
    try {
      await leaveGroup(convId);
      setConfirmLeaveConvId(null);
      closeInspector();
    } catch (err) {
      setGroupError(convId, err instanceof Error ? err.message : "退出群聊失败");
    } finally {
      setSavingGroup(false);
    }
  };

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
            aria-label="对话右侧检查器"
            data-inspector-drawer="true"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.85 }}
            className="dl-glass-chrome flex h-full w-[340px] max-compact:w-[min(340px,88vw)] max-narrow:w-full shrink-0 flex-col border-l border-dl-border-hairline max-wide:fixed max-wide:right-0 max-wide:inset-y-0 max-wide:z-drawer max-wide:shadow-dialog"
          >
            <div className="flex items-center justify-between border-b border-dl-border-hairline px-4 py-3">
              <div className="flex items-center gap-2">
                {inspectorTab === "thread" ? (
                  <MessageSquareText className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                ) : inspectorTab === "file" ? (
                  <FileText className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                ) : activeConv?.kind === "group" ? (
                  <Settings2 className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                ) : (
                  <Users className="size-4 text-dl-lane-shared" strokeWidth={1.85} />
                )}
                <h2 className="text-sm font-semibold text-dl-text-primary">
                  {inspectorTab === "thread"
                    ? "话题线程"
                    : inspectorTab === "file"
                    ? "文件预览与溯源"
                    : activeConv?.kind === "group"
                    ? "群聊设置"
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
                            {localRoot ? (
                              <MessageRichContent msg={localRoot} />
                            ) : (
                              renderMessageParts(rootText)
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 px-1">
                          <span className="text-[11px] font-medium text-dl-text-secondary">
                            {replies.length} 条线程回复
                          </span>
                          <div className="h-px flex-1 bg-dl-border-hairline" />
                        </div>

                        {replies.map((reply) => {
                          const replyMember = members[reply.authorId];
                          const authorName =
                            replyMember?.displayName ||
                            reply.authorName ||
                            reply.authorId;
                          const authorKind =
                            replyMember?.role === "bot" || reply.authorId.startsWith("usr_bot_")
                              ? "bot"
                              : "human";
                          return (
                            <div
                              key={reply.id}
                              className="flex items-start gap-2.5 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-3"
                            >
                              <Avatar
                                name={authorName}
                                src={replyMember?.avatarUrl}
                                kind={authorKind}
                                size="sm"
                              />
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
                                  {renderMessageParts(reply.plainText)}
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
                    <Switch
                      label="同时发送到主对话"
                      checked={alsoSendToChannel}
                      onCheckedChange={setAlsoSendToChannel}
                    />
                  </div>
                  <div className="dl-glass-pill flex items-center gap-2 rounded-xl border border-dl-border-hairline px-2.5 py-1.5">
                    <input
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="在线程中回复…"
                      aria-label="在线程中回复"
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
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
                {activeConv.kind === "group" && (
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/45 p-3.5 space-y-3.5">
                    <div className="flex items-center gap-3">
                      <div className="relative shrink-0">
                        <input
                          ref={avatarFileInputRef}
                          type="file"
                          accept="image/*"
                          aria-label="上传群头像图片"
                          className="sr-only"
                          onChange={(e) => void handleAvatarFileChange(e)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => avatarFileInputRef.current?.click()}
                          disabled={uploadingAvatar}
                          aria-label="更换群头像图片"
                          className="group relative h-auto w-auto rounded-entity p-0 hover:bg-transparent"
                        >
                          <Avatar
                            name={activeConv.title}
                            src={activeConv.avatarUrl}
                            emoji={activeConv.avatarEmoji}
                            kind="group"
                            size="lg"
                          />
                          <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-dl-border-hairline bg-surface text-dl-text-primary shadow-2xs group-hover:text-dl-lane-shared">
                            <Camera className="size-3" strokeWidth={2} />
                          </span>
                        </Button>
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-dl-text-secondary">
                            群头像
                          </span>
                          {(activeConv.avatarUrl || activeConv.avatarEmoji) && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleEmojiAvatarSelect(null)}
                              disabled={savingGroup}
                              className="h-5 gap-1 px-1.5 text-[11px] text-dl-text-tertiary hover:text-dl-text-primary"
                            >
                              <RotateCcw className="size-2.5" strokeWidth={2} />
                              恢复默认
                            </Button>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {GROUP_EMOJI_PRESETS.map((emoji) => {
                            const selected = activeConv.avatarEmoji === emoji && !activeConv.avatarUrl;
                            return (
                              <Button
                                key={emoji}
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`群头像 ${emoji}`}
                                onClick={() => void handleEmojiAvatarSelect(emoji)}
                                disabled={savingGroup}
                                className={cn(
                                  "size-7 rounded-lg border p-0 text-sm",
                                  selected
                                    ? "border-dl-lane-shared bg-dl-lane-shared/15"
                                    : "border-dl-border-hairline bg-surface/70 hover:bg-dl-surface-subtle"
                                )}
                              >
                                {emoji}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <form onSubmit={(e) => void handleSaveGroupTitle(e)} className="space-y-1.5">
                      <label className="block text-xs font-semibold text-dl-text-secondary">
                        群聊名称
                      </label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={titleDraft}
                          onChange={(e) =>
                            setTitleDraftByConv((prev) => ({
                              ...prev,
                              [activeConv.id]: e.target.value,
                            }))
                          }
                          aria-label="群聊名称"
                          placeholder="输入群聊名称"
                          className="h-8 text-xs"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          busy={savingGroup}
                          disabled={!titleDraft.trim() || titleDraft.trim() === activeConv.title}
                          className="h-8 shrink-0 px-3 text-xs"
                        >
                          保存
                        </Button>
                      </div>
                    </form>

                    {groupActionError && (
                      <div className="text-xs text-dl-danger">{groupActionError}</div>
                    )}
                  </div>
                )}

                {activeConv.kind !== "saved" && (
                  <div className="flex items-center justify-between rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2">
                    <span className="text-xs font-semibold text-dl-text-primary">置顶会话</span>
                    <Switch
                      label="置顶会话"
                      checked={pinnedConversationIds.includes(activeConv.id)}
                      onCheckedChange={() => void togglePinConversation(activeConv.id)}
                    />
                  </div>
                )}

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
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-dl-text-secondary">
                      成员 ({activeConv.memberIds.length})
                    </span>
                    {activeConv.kind === "group" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-xs text-dl-lane-shared"
                        onClick={() =>
                          setInvitingOpenConvId((prev) =>
                            prev === activeConv.id ? null : activeConv.id
                          )
                        }
                      >
                        <UserPlus className="size-3.5" strokeWidth={1.9} />
                        邀请成员
                      </Button>
                    )}
                  </div>

                  {activeConv.kind === "group" && invitingOpen && (() => {
                    const invitable = Object.values(members).filter(
                      (m) => m.role !== "bot" && !activeConv.memberIds.includes(m.id)
                    );
                    return (
                      <div className="mb-2.5 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-2.5 space-y-2">
                        {invitable.length === 0 ? (
                          <div className="text-xs text-dl-text-tertiary py-1 text-center">
                            所有可见成员均已在群内
                          </div>
                        ) : (
                          <>
                            <div className="dl-scroll max-h-36 overflow-y-auto space-y-1">
                              {invitable.map((m) => {
                                const checked = selectedInviteIds.includes(m.id);
                                return (
                                  <Button
                                    key={m.id}
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setSelectedInviteIdsByConv((prev) => {
                                        const cur = prev[activeConv.id] || [];
                                        return {
                                          ...prev,
                                          [activeConv.id]: checked
                                            ? cur.filter((id) => id !== m.id)
                                            : [...cur, m.id],
                                        };
                                      })
                                    }
                                    className={cn(
                                      "h-auto w-full justify-between rounded-lg px-2 py-1.5 text-xs",
                                      checked
                                        ? "bg-dl-lane-shared/14 text-dl-lane-shared font-medium"
                                        : "text-dl-text-primary hover:bg-surface/70"
                                    )}
                                  >
                                    <span className="truncate">{m.displayName}</span>
                                    {checked && <Check className="size-3.5 shrink-0" strokeWidth={2} />}
                                  </Button>
                                );
                              })}
                            </div>
                            <div className="flex justify-end gap-1.5 pt-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2.5 text-xs"
                                onClick={() => {
                                  setInvitingOpenConvId(null);
                                  setSelectedInviteIdsByConv((prev) => ({
                                    ...prev,
                                    [activeConv.id]: [],
                                  }));
                                }}
                              >
                                取消
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                busy={invitingBusy}
                                disabled={selectedInviteIds.length === 0}
                                className="h-7 px-2.5 text-xs"
                                onClick={() => void handleConfirmInvite()}
                              >
                                确认邀请
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div className="space-y-1">
                    {activeConv.memberIds.map((id) => {
                      const m = members[id];
                      const displayLabel =
                        m?.displayName && !m.displayName.startsWith("usr_")
                          ? m.displayName
                          : m?.handle || "空间成员";
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-dl-surface-subtle/50 transition-colors"
                        >
                          <Avatar
                            name={displayLabel}
                            src={m?.avatarUrl}
                            kind={m?.role === "bot" || id.startsWith("usr_bot_") ? "bot" : "human"}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-dl-text-primary">
                              {displayLabel}
                            </div>
                            <div className="text-[11px] text-dl-text-tertiary">
                              {m?.role === "bot" ? "智能体机器人" : "空间成员"}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {activeConv.kind === "group" && (
                  <div className="border-t border-dl-border-hairline pt-3">
                    {confirmLeave ? (
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-dl-danger/8 p-2.5">
                        <span className="text-xs font-medium text-dl-danger">确认退出当前群聊？</span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => setConfirmLeaveConvId(null)}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            busy={savingGroup}
                            className="h-7 px-2.5 text-xs"
                            onClick={() => void handleConfirmLeaveGroup()}
                          >
                            确认退出
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        className="w-full gap-1.5"
                        onClick={() => setConfirmLeaveConvId(activeConv.id)}
                      >
                        <LogOut className="size-3.5" strokeWidth={1.9} />
                        退出群聊
                      </Button>
                    )}
                  </div>
                )}
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

                {(inspectorFile.downloadUrl || inspectorFile.url) && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full gap-1.5"
                    onClick={() =>
                      triggerBrowserDownload(
                        inspectorFile.downloadUrl || inspectorFile.url,
                        inspectorFile.fileName
                      )
                    }
                  >
                    <Download className="size-3.5" strokeWidth={1.9} />
                    下载文件
                  </Button>
                )}

                {inspectorFile.sourceMessageId && inspectorFile.conversationId && (
                  <Button
                    variant="secondary"
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
