import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Camera,
  Check,
  Download,
  FileText,
  Image as ImageIcon,
  LocateFixed,
  LogOut,
  MessageSquareText,
  Pencil,
  PinOff,
  RotateCcw,
  SendHorizontal,
  Settings2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore, type LightboxItem } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  apiV1,
  type ConversationNotificationLevel,
  type SearchFileHit,
} from "@/shared/lib/api-v1";
import { renderChatMarkdown } from "@/shared/lib/chat-markdown";
import { cn } from "@/shared/lib/cn";
import { triggerBrowserDownload } from "@/shared/lib/download";
import { safeInlineImageMime } from "@/shared/lib/p2p-lane";
import {
  Avatar,
  Button,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Switch,
} from "@/shared/ui";
import { MessageRichContent } from "@/widgets/EmoteSystem";
import { GroupBotRequests } from "@/widgets/GroupBotRequests";

const GROUP_EMOJI_PRESETS = ["🚀", "💡", "🎨", "🛠️", "📌", "⚡", "🌿", "🎯"];

type DetailsSubTab = "settings" | "media";

function formatFileBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MemberRemarkPopoverButton({
  userId,
  currentRemark,
  originalNickname,
  displayLabel,
}: {
  userId: string;
  currentRemark?: string;
  originalNickname?: string;
  displayLabel: string;
}) {
  const setMemberRemark = useWorkspaceStore((s) => s.setMemberRemark);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(currentRemark || "");
  const [busy, setBusy] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraft(currentRemark || "");
    }
    setOpen(nextOpen);
  };

  const handleSave = async (nextVal: string) => {
    setBusy(true);
    try {
      await setMemberRemark(userId, nextVal);
      useEmoteStore
        .getState()
        .showToast(nextVal.trim() ? "成员备注已保存" : "已清除成员备注");
      setOpen(false);
    } catch (err) {
      useEmoteStore
        .getState()
        .showToast(err instanceof Error ? err.message : "设置备注失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          title="仅自己可见的个人备注"
          aria-label={`为 ${displayLabel} 设置个人备注（仅自己可见）`}
          className="h-6 shrink-0 gap-1 px-2 text-[11px] text-dl-text-tertiary hover:text-dl-lane-shared"
        >
          <Pencil className="size-3" strokeWidth={1.85} />
          <span>个人备注</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="left" align="center" className="w-64 p-3 space-y-2.5">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-dl-text-primary">
            设置成员备注（仅自己可见）
          </div>
          {originalNickname && (
            <div className="truncate text-[11px] text-dl-text-tertiary">
              原昵称：{originalNickname}
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave(draft);
          }}
          className="space-y-2"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="输入备注名，留空恢复原昵称"
            aria-label="成员备注名"
            maxLength={32}
            className="h-8 text-xs"
          />
          <div className="flex items-center justify-between gap-1.5">
            {currentRemark ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                className="h-7 px-2 text-xs text-dl-text-tertiary hover:text-dl-danger"
                onClick={() => void handleSave("")}
              >
                清除备注
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                className="h-7 px-2 text-xs"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                busy={busy}
                className="h-7 px-2.5 text-xs"
              >
                保存
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function InspectorPane() {
  const {
    activeLane,
    inspectorOpen,
    inspectorTab,
    inspectorThreadRootId,
    inspectorFile,
    closeInspector,
    openLightbox,
    openProfileModal,
  } = useLaneStore();
  const {
    isPreviewMode,
    currentUser,
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
    setConversationNotificationLevel,
    updateGroupProfile,
    uploadGroupAvatar,
    inviteGroupMembers,
    removeGroupMember,
    leaveGroup,
  } = useWorkspaceStore();

  const [replyText, setReplyText] = useState("");
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [sending, setSending] = useState(false);

  const [detailsSubTab, setDetailsSubTab] = useState<DetailsSubTab>("settings");
  const [remoteFilesByConv, setRemoteFilesByConv] = useState<Record<string, SearchFileHit[]>>({});
  const [remoteFilesHasMoreByConv, setRemoteFilesHasMoreByConv] = useState<Record<string, boolean>>({});
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);

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
    if (
      !inspectorOpen ||
      inspectorTab !== "details" ||
      detailsSubTab !== "media" ||
      !activeConversationId ||
      isPreviewMode
    ) {
      return;
    }
    let active = true;
    const convId = activeConversationId;
    void apiV1
      .listConversationMedia(convId, "all", 40, 0)
      .then((res) => {
        if (!active) return;
        setRemoteFilesByConv((prev) => ({ ...prev, [convId]: res.items || [] }));
        setRemoteFilesHasMoreByConv((prev) => ({ ...prev, [convId]: Boolean(res.hasMore) }));
      })
      .catch(() => {
        if (!active) return;
        setRemoteFilesByConv((prev) => ({ ...prev, [convId]: prev[convId] || [] }));
      });
    return () => {
      active = false;
    };
  }, [activeConversationId, detailsSubTab, inspectorOpen, inspectorTab, isPreviewMode]);

  const handleLoadMoreMedia = async () => {
    if (!activeConversationId || loadingMoreMedia) return;
    const convId = activeConversationId;
    const existing = remoteFilesByConv[convId] || [];
    setLoadingMoreMedia(true);
    try {
      const res = await apiV1.listConversationMedia(convId, "all", 40, existing.length);
      setRemoteFilesByConv((prev) => {
        const cur = prev[convId] || [];
        const seen = new Set(cur.map((f) => f.id));
        return {
          ...prev,
          [convId]: [...cur, ...(res.items || []).filter((f) => !seen.has(f.id))],
        };
      });
      setRemoteFilesHasMoreByConv((prev) => ({ ...prev, [convId]: Boolean(res.hasMore) }));
    } finally {
      setLoadingMoreMedia(false);
    }
  };

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
  const loadingRemoteFiles = Boolean(
    !isPreviewMode && activeConv && remoteFilesByConv[activeConv.id] === undefined
  );
  const messages = useMemo(
    () => (activeConversationId ? messagesByConv[activeConversationId] || [] : []),
    [activeConversationId, messagesByConv]
  );

  // Deduplicated conversation media & files (loaded messages + /api/v1/search?scope=files)
  const { convImageItems, convFileItems } = useMemo(() => {
    if (!activeConv) {
      return { convImageItems: [] as LightboxItem[], convFileItems: [] as LightboxItem[] };
    }
    const mergedMap = new Map<string, LightboxItem>();

    // Reverse iterate messages so newest attachments come first
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]!;
      if (msg.recalledAt || !msg.attachments?.length) continue;
      for (const att of msg.attachments) {
        if (!att.id || mergedMap.has(att.id)) continue;
        mergedMap.set(att.id, {
          id: att.id,
          url: att.url,
          downloadUrl: att.downloadUrl || att.url,
          fileName: att.fileName,
          mimeType: att.mimeType,
          byteSize: att.byteSize,
          width: att.width,
          height: att.height,
          sourceMessageId: att.sourceMessageId || msg.id,
          conversationId: activeConv.id,
        });
      }
    }

    const remoteHits = remoteFilesByConv[activeConv.id] || [];
    for (const hit of remoteHits) {
      if (!hit.id || mergedMap.has(hit.id)) continue;
      const downloadUrl = `/api/workspace/files/${encodeURIComponent(hit.id)}/download`;
      const previewUrl = hit.mimeType.startsWith("image/")
        ? `/api/workspace/files/${encodeURIComponent(hit.id)}/preview`
        : downloadUrl;
      mergedMap.set(hit.id, {
        id: hit.id,
        url: previewUrl,
        downloadUrl,
        fileName: hit.fileName,
        mimeType: hit.mimeType,
        byteSize: hit.byteSize,
        width: hit.width,
        height: hit.height,
        sourceMessageId: hit.sourceMessageId,
        conversationId: activeConv.id,
      });
    }

    const images: LightboxItem[] = [];
    const files: LightboxItem[] = [];
    for (const item of mergedMap.values()) {
      if (safeInlineImageMime(item.mimeType) && Boolean(item.url)) {
        images.push(item);
      } else {
        files.push(item);
      }
    }
    return { convImageItems: images, convFileItems: files };
  }, [activeConv, messages, remoteFilesByConv]);

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
                          <div className="min-w-0 max-w-full overflow-hidden text-[13px] leading-relaxed text-dl-text-primary whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {localRoot ? (
                              <MessageRichContent msg={localRoot} />
                            ) : (
                              renderChatMarkdown(rootText, "workspace", `thr_root_${inspectorThreadRootId}`)
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
                                color={replyMember?.avatarColor}
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
                                <div className="min-w-0 max-w-full overflow-hidden text-[13px] leading-relaxed text-dl-text-primary whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                                  {renderChatMarkdown(reply.plainText, "workspace", `thr_${reply.id}`)}
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
                  <div className="dl-glass-pill flex items-end gap-2 rounded-xl border border-dl-border-hairline px-2.5 py-1.5">
                    <textarea
                      rows={1}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          if (replyText.trim() && !sending) {
                            e.currentTarget.form?.requestSubmit();
                          }
                        }
                      }}
                      placeholder="在线程中回复… (Shift+Enter 换行)"
                      aria-label="在线程中回复"
                      className="min-w-0 max-h-28 flex-1 resize-none bg-transparent py-1 text-[13px] leading-snug text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
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
              <div className="flex flex-1 flex-col min-h-0">
                <div className="border-b border-dl-border-hairline px-4 py-2.5 bg-dl-surface-subtle/25 shrink-0">
                  <SegmentedControl
                    label="会话详情栏目"
                    value={detailsSubTab}
                    onValueChange={(v) => setDetailsSubTab(v as DetailsSubTab)}
                    options={[
                      { value: "settings", label: "成员与设置" },
                      {
                        value: "media",
                        label: `媒体与文件${
                          convImageItems.length + convFileItems.length > 0
                            ? ` (${convImageItems.length + convFileItems.length})`
                            : ""
                        }`,
                      },
                    ]}
                  />
                </div>

                {detailsSubTab === "media" ? (
                  <div className="dl-scroll flex-1 overflow-y-auto p-4 space-y-5">
                    {loadingRemoteFiles &&
                      convImageItems.length === 0 &&
                      convFileItems.length === 0 && (
                        <div className="py-6 text-center text-xs text-dl-text-tertiary">
                          正在汇总本会话媒体与文件…
                        </div>
                      )}

                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-secondary">
                        <ImageIcon className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                        <span>聊天图片 ({convImageItems.length})</span>
                      </div>
                      {convImageItems.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-dl-border-hairline p-4 text-center text-xs text-dl-text-tertiary">
                          本会话暂无图片
                        </div>
                      ) : (
                        <div
                          data-testid="inspector-media-grid"
                          className="grid grid-cols-3 gap-2"
                        >
                          {convImageItems.map((img, idx) => (
                            <Button
                              key={img.id}
                              type="button"
                              variant="ghost"
                              aria-label={`预览图片 ${img.fileName}`}
                              onClick={() => openLightbox(convImageItems, idx)}
                              className="group relative aspect-square h-auto w-full overflow-hidden rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/60 p-0"
                            >
                              <img
                                src={img.url}
                                alt={img.fileName}
                                loading="lazy"
                                className="size-full object-cover transition-transform duration-150 group-hover:scale-105"
                              />
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-secondary">
                        <FileText className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                        <span>共享文件 ({convFileItems.length})</span>
                      </div>
                      {convFileItems.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-dl-border-hairline p-4 text-center text-xs text-dl-text-tertiary">
                          本会话暂无文件附件
                        </div>
                      ) : (
                        <div data-testid="inspector-file-list" className="space-y-2">
                          {convFileItems.map((file) => (
                            <div
                              key={file.id}
                              className="flex items-center justify-between gap-2 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-2.5 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <FileText
                                  className="size-4 shrink-0 text-dl-lane-shared"
                                  strokeWidth={1.85}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium text-dl-text-primary">
                                    {file.fileName}
                                  </div>
                                  <div className="text-[10.5px] text-dl-text-tertiary">
                                    {formatFileBytes(file.byteSize)}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {file.sourceMessageId && (
                                  <IconButton
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="size-7 rounded-lg"
                                    label={`定位 ${file.fileName} 所在消息`}
                                    onClick={() =>
                                      jumpToMessage(activeConv.id, file.sourceMessageId!)
                                    }
                                  >
                                    <LocateFixed className="size-3.5" strokeWidth={1.85} />
                                  </IconButton>
                                )}
                                <IconButton
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="size-7 rounded-lg"
                                  label={`下载 ${file.fileName}`}
                                  onClick={() =>
                                    triggerBrowserDownload(
                                      file.downloadUrl || file.url,
                                      file.fileName
                                    )
                                  }
                                >
                                  <Download className="size-3.5" strokeWidth={1.9} />
                                </IconButton>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {remoteFilesHasMoreByConv[activeConv.id] && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-full text-xs"
                        disabled={loadingMoreMedia}
                        onClick={() => void handleLoadMoreMedia()}
                      >
                        {loadingMoreMedia ? "正在加载更多…" : "加载更多历史图片与文件"}
                      </Button>
                    )}
                  </div>
                ) : (
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
                                const selected =
                                  activeConv.avatarEmoji === emoji && !activeConv.avatarUrl;
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

                    {activeConv.kind === "direct" && (() => {
                      const peerId = activeConv.memberIds.find((id) => id !== currentUser?.id);
                      const peer = peerId ? members[peerId] : undefined;
                      const peerIsBot =
                        !peer ||
                        peer.role === "bot" ||
                        peer.id === "usr_system_beacon" ||
                        peer.id === "usr_system_echo" ||
                        peer.id.startsWith("usr_bot_");
                      if (!peer || peerIsBot) return null;
                      return (
                        <div className="flex items-center justify-between gap-2 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2.5">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-dl-text-primary">
                              好友个人备注
                            </div>
                            <div className="truncate text-[11px] text-dl-text-tertiary">
                              {peer.remark ? `${peer.remark}（仅自己可见）` : "未设置（仅自己可见）"}
                            </div>
                          </div>
                          <MemberRemarkPopoverButton
                            userId={peer.id}
                            currentRemark={peer.remark}
                            originalNickname={peer.nickname || peer.handle}
                            displayLabel={peer.displayName}
                          />
                        </div>
                      );
                    })()}

                    {activeConv.kind !== "saved" && (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2">
                          <span className="text-xs font-semibold text-dl-text-primary">
                            置顶会话
                          </span>
                          <Switch
                            label="置顶会话"
                            checked={pinnedConversationIds.includes(activeConv.id)}
                            onCheckedChange={() => void togglePinConversation(activeConv.id)}
                          />
                        </div>

                        <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-3 space-y-2">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                            <Bell className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                            <span>消息提醒级别</span>
                          </div>
                          <SegmentedControl
                            label="消息提醒级别"
                            value={activeConv.notificationLevel || "all"}
                            onValueChange={(v) =>
                              void setConversationNotificationLevel(
                                activeConv.id,
                                v as ConversationNotificationLevel
                              )
                            }
                            options={[
                              { value: "all", label: "全部提醒" },
                              { value: "mentions", label: "仅 @我" },
                              { value: "muted", label: "免打扰" },
                            ]}
                          />
                        </div>
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
                            邀请成员 / 机器人
                          </Button>
                        )}
                      </div>

                      {activeConv.kind === "group" &&
                        invitingOpen &&
                        (() => {
                          const invitable = Object.values(members).filter(
                            (m) =>
                              !m.id.startsWith("usr_system_") &&
                              !activeConv.memberIds.includes(m.id)
                          );
                          return (
                            <div className="mb-2.5 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/55 p-2.5 space-y-2">
                              {invitable.length === 0 ? (
                                <div className="text-xs text-dl-text-tertiary py-1 text-center">
                                  所有可见成员与机器人均已在群内
                                </div>
                              ) : (
                                <>
                                  <div className="dl-scroll max-h-40 overflow-y-auto space-y-1">
                                    {invitable.map((m) => {
                                      const checked = selectedInviteIds.includes(m.id);
                                      const isBotCandidate =
                                        m.role === "bot" || m.id.startsWith("usr_bot_");
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
                                          <span className="flex items-center gap-1.5 min-w-0">
                                            <span className="truncate">{m.displayName}</span>
                                            {isBotCandidate && (
                                              <span className="shrink-0 rounded-full bg-dl-lane-shared/14 px-1.5 py-0.5 text-[9px] font-semibold text-dl-lane-shared">
                                                BOT
                                              </span>
                                            )}
                                          </span>
                                          {checked && (
                                            <Check className="size-3.5 shrink-0" strokeWidth={2} />
                                          )}
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
                          const isBotMember =
                            m?.role === "bot" ||
                            id.startsWith("usr_bot_") ||
                            id.startsWith("usr_system_");
                          const canSetRemark =
                            !isBotMember && id !== currentUser?.id && !id.startsWith("usr_system_");
                          const canRemoveFromGroup =
                            activeConv.kind === "group" &&
                            !id.startsWith("usr_system_") &&
                            id !== currentUser?.id &&
                            (isBotMember ||
                              Boolean(activeConv.capabilities?.canRemoveMembers) ||
                              currentUser?.role === "owner" ||
                              currentUser?.role === "admin");
                          return (
                            <div
                              key={id}
                              className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-dl-surface-subtle/50 transition-colors"
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-0 py-0 text-left hover:bg-transparent"
                                onClick={() => openProfileModal(id)}
                              >
                                <Avatar
                                  name={displayLabel}
                                  src={m?.avatarUrl}
                                  kind={isBotMember ? "bot" : "human"}
                                  color={m?.avatarColor}
                                  size="sm"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="truncate text-xs font-medium text-dl-text-primary">
                                      {displayLabel}
                                    </span>
                                    {m?.remark && (
                                      <span className="shrink-0 rounded-full bg-dl-lane-shared/12 px-1.5 py-0.5 text-[9px] font-medium text-dl-lane-shared">
                                        已备注
                                      </span>
                                    )}
                                    {isBotMember && (
                                      <span className="shrink-0 rounded-full bg-dl-lane-shared/14 px-1.5 py-0.5 text-[9px] font-semibold text-dl-lane-shared">
                                        BOT
                                      </span>
                                    )}
                                  </div>
                                  <div className="truncate text-[11px] text-dl-text-tertiary">
                                    {isBotMember
                                      ? m?.description || "智能体机器人"
                                      : m?.statusText
                                      ? m.statusText
                                      : m?.remark && m.nickname
                                      ? `原昵称：${m.nickname}`
                                      : "空间成员"}
                                  </div>
                                </div>
                              </Button>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {canSetRemark && (
                                  <MemberRemarkPopoverButton
                                    userId={id}
                                    currentRemark={m?.remark}
                                    originalNickname={m?.nickname || m?.handle}
                                    displayLabel={displayLabel}
                                  />
                                )}
                                {canRemoveFromGroup && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`将 ${displayLabel} 移出群聊`}
                                    className="h-6 shrink-0 px-2 text-[11px] text-dl-text-tertiary hover:text-dl-danger"
                                    onClick={() => {
                                      setGroupError(activeConv.id, "");
                                      void removeGroupMember(activeConv.id, id).catch((err) => {
                                        setGroupError(
                                          activeConv.id,
                                          err instanceof Error ? err.message : "移出成员失败"
                                        );
                                      });
                                    }}
                                  >
                                    移出
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {activeConv.kind === "group" && (
                      <GroupBotRequests
                        key={activeConv.id}
                        conversationId={activeConv.id}
                        previewMode={isPreviewMode}
                      />
                    )}

                    {activeConv.kind === "group" && (
                      <div className="border-t border-dl-border-hairline pt-3">
                        {confirmLeave ? (
                          <div className="flex items-center justify-between gap-2 rounded-xl bg-dl-danger/8 p-2.5">
                            <span className="text-xs font-medium text-dl-danger">
                              确认退出当前群聊？
                            </span>
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
