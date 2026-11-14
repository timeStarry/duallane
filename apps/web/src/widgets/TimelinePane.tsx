import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bookmark,
  Check,
  CheckCheck,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  FileText,
  Forward,
  LogOut,
  MessageSquareText,
  PanelRightOpen,
  Paperclip,
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
import {
  useWorkspaceStore,
  type V1Message,
  type V1MessageAttachment,
} from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { triggerBrowserDownload } from "@/shared/lib/download";
import {
  createSafeP2PBlobUrl,
  safeInlineImageMime,
  scrubP2PRoomFromUrl,
} from "@/shared/lib/p2p-lane";
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
    isPreviewMode,
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
    leaveP2PRoom,
    p2pMessages,
    p2pDraft,
    setP2PDraft,
    sendP2PMessage,
    sendP2PFile,
  } = useWorkspaceStore();

  const [pinIndex, setPinIndex] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [forwardMsgId, setForwardMsgId] = useState<string | null>(null);
  const [forwardTargetConvId, setForwardTargetConvId] = useState<string>("");
  const [forwarding, setForwarding] = useState(false);
  const [replyToId, setReplyToId] = useState<string | undefined>(undefined);
  const [pendingAttachmentsByConv, setPendingAttachmentsByConv] = useState<
    Record<string, V1MessageAttachment[]>
  >({});
  const [uploadingWorkspaceFile, setUploadingWorkspaceFile] = useState(false);
  const [workspaceUploadErrorByConv, setWorkspaceUploadErrorByConv] = useState<
    Record<string, string>
  >({});
  const [uploadingP2PFile, setUploadingP2PFile] = useState(false);
  const [p2pFileError, setP2PFileError] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const wsFileInputRef = useRef<HTMLInputElement | null>(null);
  const p2pFileInputRef = useRef<HTMLInputElement | null>(null);

  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = useMemo(
    () => (activeConversationId ? messagesByConv[activeConversationId] || [] : []),
    [activeConversationId, messagesByConv]
  );
  const messageMap = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const draft = activeConversationId ? drafts[activeConversationId]?.text || "" : "";
  const pendingAttachments = activeConversationId
    ? pendingAttachmentsByConv[activeConversationId] || []
    : [];
  const workspaceUploadError = activeConversationId
    ? workspaceUploadErrorByConv[activeConversationId] || ""
    : "";

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
    const peerStatusLabel = p2pRoom
      ? p2pRoom.status === "peer_connected"
        ? "对端已连接 · 2/2 在线"
        : p2pRoom.status === "waiting_peer"
          ? "等待对端加入 · 仅本机在线 1/2"
          : p2pRoom.status === "connecting"
            ? "正在连接信令服务…"
            : p2pRoom.status === "room_not_found"
              ? "房间不存在或已过期"
              : p2pRoom.status === "room_full"
                ? "房间已满 (2/2)"
                : "信令未连接"
      : "";

    const hasRoomError =
      p2pRoom &&
      (p2pRoom.status === "room_not_found" ||
        p2pRoom.status === "room_full" ||
        p2pRoom.status === "disconnected" ||
        p2pRoom.status === "error");

    const handleP2PFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length === 0) return;
      setP2PFileError("");
      setUploadingP2PFile(true);
      try {
        for (const file of files) {
          await sendP2PFile(file);
        }
      } catch (err) {
        setP2PFileError(err instanceof Error ? err.message : "加密文件发送失败");
      } finally {
        setUploadingP2PFile(false);
      }
    };

    return (
      <section
        aria-label="私密直连对话"
        className={cn(
          "flex flex-1 flex-col min-w-0 min-h-0 h-full bg-dl-surface-canvas/35",
          mobileView === "list" && "max-compact:hidden"
        )}
      >
        <header className="dl-glass-chrome border-b border-dl-border-hairline px-5 max-compact:px-3.5 max-narrow:px-2.5 py-3 max-narrow:py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <IconButton
                variant="ghost"
                size="sm"
                className="hidden max-compact:inline-flex shrink-0"
                onClick={() => {
                  scrubP2PRoomFromUrl("/");
                  setMobileView("list");
                }}
                label="返回列表"
              >
                <ChevronLeft className="size-4" strokeWidth={2} />
              </IconButton>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-direct/16 text-dl-lane-direct max-narrow:hidden">
                <ShieldCheck className="size-[18px]" strokeWidth={1.9} />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold text-dl-text-primary">
                  {p2pRoom ? `私密直连 · #${p2pRoom.roomId}` : "私密直连通道"}
                </h1>
                {!p2pRoom && (
                  <p className="truncate text-xs text-dl-lane-direct mt-0.5">
                    端到端加密 · 刷新页面即清空内存
                  </p>
                )}
              </div>
            </div>

            {p2pRoom && (
              <div className="flex items-center gap-1 shrink-0">
                {p2pRoom.shareUrl && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={copiedLink ? "已复制链接" : "复制加密链接"}
                    className="gap-1.5 shrink-0 max-narrow:px-2.5"
                    onClick={() => {
                      void navigator.clipboard?.writeText(p2pRoom.shareUrl);
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 1800);
                    }}
                  >
                    {copiedLink ? (
                      <>
                        <Check className="size-3.5 shrink-0 text-dl-success" strokeWidth={2} />
                        <span className="max-narrow:hidden">已复制链接</span>
                        <span className="hidden max-narrow:inline">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5 shrink-0" strokeWidth={1.8} />
                        <span className="max-narrow:hidden">复制加密链接</span>
                        <span className="hidden max-narrow:inline">复制</span>
                      </>
                    )}
                  </Button>
                )}
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-dl-text-secondary hover:text-dl-danger"
                  label="退出直连房间"
                  onClick={() => {
                    leaveP2PRoom();
                    setMobileView("list");
                  }}
                >
                  <LogOut className="size-4" strokeWidth={1.85} />
                </IconButton>
              </div>
            )}
          </div>

          {p2pRoom && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
              <span
                data-testid="p2p-peer-status"
                role="status"
                aria-live="polite"
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                  p2pRoom.status === "peer_connected"
                    ? "bg-dl-success/16 text-dl-success"
                    : p2pRoom.status === "waiting_peer" || p2pRoom.status === "connecting"
                      ? "bg-dl-warning/16 text-dl-warning"
                      : "bg-dl-danger/14 text-dl-danger"
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    p2pRoom.status === "peer_connected"
                      ? "bg-dl-success"
                      : p2pRoom.status === "waiting_peer" || p2pRoom.status === "connecting"
                        ? "bg-dl-warning"
                        : "bg-dl-danger"
                  )}
                />
                <span className="truncate">{peerStatusLabel}</span>
              </span>
              <span className="truncate text-[11px] text-dl-lane-direct">
                AES-256-GCM · 指纹 {p2pRoom.keyFingerprint}
              </span>
            </div>
          )}
        </header>

        {hasRoomError && p2pRoom && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dl-danger/25 bg-dl-danger/10 px-5 max-compact:px-3 py-2 text-xs text-dl-danger">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="size-4 shrink-0" strokeWidth={2} />
              <span className="break-words">
                {p2pRoom.errorMessage || "直连房间连接异常，请重新创建加密房间。"}
              </span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 shrink-0 text-xs"
              onClick={() => void createP2PRoom()}
            >
              重新创建加密房间
            </Button>
          </div>
        )}

        {p2pRoom?.keyMismatchWarning && (
          <div className="flex items-start gap-2 border-b border-dl-warning/30 bg-dl-warning/12 px-5 max-compact:px-3 py-2 text-xs text-dl-warning">
            <AlertCircle className="size-4 shrink-0 mt-0.5" strokeWidth={2} />
            <span>
              检测到无法解密的对端密文：双方链接中的 #k= 密钥不一致，请重新复制完整加密链接发送给对方。
            </span>
          </div>
        )}

        <div className="dl-scroll flex-1 overflow-y-auto px-5 max-compact:px-3 py-4 space-y-2.5">
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
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="dl-glass-elevated w-full max-w-md rounded-2xl border border-dl-border-hairline p-5 max-narrow:p-3.5 space-y-3">
                <div className="text-sm font-semibold text-dl-text-primary">
                  {hasRoomError
                    ? "加密房间不可用"
                    : p2pRoom.status === "peer_connected"
                      ? "对端已连接（2/2 在线）· 端到端加密已就绪"
                      : "等待对端加入房间（当前仅本机在线 · 1/2）"}
                </div>
                <p className="text-xs leading-relaxed text-dl-text-secondary">
                  {hasRoomError
                    ? p2pRoom.errorMessage || "链接中的房间或密钥已失效，请重新创建加密房间。"
                    : p2pRoom.status === "peer_connected"
                      ? "双方已建立 AES-256-GCM 内存加密通道，发送的消息与文件将实时直达对端设备内存并回执确认。"
                      : "请复制下方完整加密链接（含 #k= 密钥片段）发送给对方；在对端加入前发送的消息与文件将暂存本机内存，对端上线后自动加密送达。"}
                </p>
                {p2pRoom.status !== "peer_connected" && !hasRoomError && p2pRoom.shareUrl && (
                  <div className="pt-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="max-w-full gap-1.5 border-dl-lane-direct/35 bg-dl-lane-direct/15 text-dl-lane-direct hover:bg-dl-lane-direct/25"
                      onClick={() => {
                        void navigator.clipboard?.writeText(p2pRoom.shareUrl);
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 1800);
                      }}
                    >
                      <Copy className="size-3.5 shrink-0" strokeWidth={1.8} />
                      <span className="truncate">
                        {copiedLink ? "已复制完整加密邀请链接" : "复制完整加密邀请链接"}
                      </span>
                    </Button>
                  </div>
                )}
              </div>
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
                {!msg.isOwn && (
                  <span className="mb-1 px-1 text-[11px] font-semibold text-dl-text-secondary">
                    {msg.senderName}
                  </span>
                )}
                <div
                  data-p2p-message-id={msg.id}
                  data-delivery-status={msg.deliveryStatus}
                  className={cn(
                    "max-w-[72%] max-compact:max-w-[88%] rounded-[18px] px-3.5 py-2 text-[14px] leading-relaxed shadow-2xs",
                    msg.isOwn
                      ? "rounded-br-[6px] bg-dl-lane-direct text-dl-on-direct"
                      : "rounded-bl-[6px] dl-glass-elevated border border-dl-border-hairline text-dl-text-primary"
                  )}
                >
                  {msg.text && <div className="whitespace-pre-wrap break-words">{msg.text}</div>}

                  {msg.attachment && (
                    <div className={cn("space-y-1.5", msg.text && "mt-2")}>
                      {safeInlineImageMime(msg.attachment.mimeType) && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto w-full overflow-hidden rounded-xl p-0"
                          aria-label={`预览图片 ${msg.attachment.fileName}`}
                          onClick={() =>
                            openLightbox(
                              [
                                {
                                  id: msg.id,
                                  url: msg.attachment!.blobUrl,
                                  downloadUrl: msg.attachment!.blobUrl,
                                  fileName: msg.attachment!.fileName,
                                  mimeType: msg.attachment!.mimeType,
                                  byteSize: msg.attachment!.byteSize,
                                },
                              ],
                              0
                            )
                          }
                        >
                          <img
                            src={msg.attachment.blobUrl}
                            alt={msg.attachment.fileName}
                            className="max-h-44 max-w-full rounded-xl object-contain"
                          />
                        </Button>
                      )}
                      <div
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-xs",
                          msg.isOwn
                            ? "border-current/25 bg-black/10 text-dl-on-direct"
                            : "border-dl-border-hairline bg-dl-surface-subtle/65 text-dl-text-primary"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="size-4 shrink-0 opacity-85" strokeWidth={1.8} />
                          <div className="min-w-0">
                            <div className="truncate font-medium max-w-[160px]">
                              {msg.attachment.fileName}
                            </div>
                            <div className="text-[10px] opacity-80">
                              {formatBytes(msg.attachment.byteSize)}
                            </div>
                          </div>
                        </div>
                        <IconButton
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={cn(
                            "size-7 shrink-0 rounded-lg",
                            msg.isOwn && "text-dl-on-direct hover:bg-black/15"
                          )}
                          label={`下载 ${msg.attachment.fileName}`}
                          onClick={() =>
                            triggerBrowserDownload(
                              msg.attachment!.blobUrl,
                              msg.attachment!.fileName
                            )
                          }
                        >
                          <Download className="size-3.5" strokeWidth={2} />
                        </IconButton>
                      </div>
                    </div>
                  )}

                  <div
                    className={cn(
                      "mt-1 flex items-center justify-end gap-1.5 text-[10px] tabular-nums",
                      msg.isOwn ? "opacity-90" : "text-dl-text-tertiary"
                    )}
                  >
                    <span>
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {msg.isOwn && (
                      <span className="inline-flex items-center gap-0.5 font-medium">
                        {msg.deliveryStatus === "delivered" ? (
                          <>
                            <CheckCheck className="size-3.5" strokeWidth={2.1} />
                            <span>对端已收</span>
                          </>
                        ) : msg.deliveryStatus === "sent" ? (
                          <>
                            <Check className="size-3" strokeWidth={2} />
                            <span>已发出</span>
                          </>
                        ) : msg.deliveryStatus === "sending" ? (
                          <>
                            <Clock className="size-3" strokeWidth={2} />
                            <span>加密发送中</span>
                          </>
                        ) : msg.deliveryStatus === "failed" ? (
                          <>
                            <AlertCircle className="size-3" strokeWidth={2} />
                            <span>未送达</span>
                          </>
                        ) : (
                          <>
                            <Clock className="size-3" strokeWidth={2} />
                            <span>等待对端加入</span>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </div>

        {p2pRoom && (
          <div className="px-5 max-compact:px-3 max-narrow:px-2.5 pb-4 max-narrow:pb-3 pt-1.5 space-y-1.5">
            {p2pFileError && (
              <div className="rounded-xl border border-dl-danger/30 bg-dl-danger/10 px-3 py-1.5 text-xs text-dl-danger">
                {p2pFileError}
              </div>
            )}
            {p2pRoom.status !== "peer_connected" && !hasRoomError && (
              <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-xl border border-dl-warning/25 bg-dl-warning/8 px-3 py-1.5 text-[11px] text-dl-text-secondary">
                <span>
                  对端尚未加入房间 · 当前发送的消息与文件将暂存本机内存，待对端连接后自动加密送达
                </span>
                <span className="shrink-0 font-semibold text-dl-warning">仅本机在线 (1/2)</span>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendP2PMessage(p2pDraft);
              }}
              className="dl-glass-pill flex items-center gap-1.5 rounded-2xl border border-dl-border-hairline px-3 max-narrow:px-2 py-2 max-narrow:py-1.5"
            >
              <input
                ref={p2pFileInputRef}
                type="file"
                className="hidden"
                aria-label="选择端到端加密传输文件"
                onChange={(e) => void handleP2PFileSelect(e)}
              />
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 rounded-xl text-dl-text-secondary hover:text-dl-lane-direct"
                disabled={Boolean(hasRoomError) || uploadingP2PFile}
                label="发送加密文件"
                onClick={() => p2pFileInputRef.current?.click()}
              >
                <Paperclip className="size-4" strokeWidth={1.85} />
              </IconButton>
              <input
                value={p2pDraft}
                onChange={(e) => setP2PDraft(e.target.value)}
                placeholder={
                  p2pRoom.status === "peer_connected"
                    ? "发送端到端加密消息…"
                    : "输入消息（对端加入后自动送达）…"
                }
                aria-label="发送端到端加密消息"
                className="min-w-0 flex-1 bg-transparent text-sm text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                aria-label={p2pRoom.status === "peer_connected" ? "加密发送" : "暂存待发"}
                disabled={!p2pDraft.trim() || Boolean(hasRoomError)}
                className="shrink-0 gap-1.5 max-narrow:px-2.5 border-transparent bg-dl-lane-direct text-dl-on-direct hover:brightness-105 disabled:opacity-40"
              >
                <SendHorizontal className="size-3.5 shrink-0" strokeWidth={2} />
                <span className="max-narrow:hidden">
                  {p2pRoom.status === "peer_connected" ? "加密发送" : "暂存待发"}
                </span>
                <span className="hidden max-narrow:inline">
                  {p2pRoom.status === "peer_connected" ? "发送" : "暂存"}
                </span>
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

  const handleWorkspaceFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    const convId = activeConv.id;

    setWorkspaceUploadErrorByConv((prev) => ({ ...prev, [convId]: "" }));
    setUploadingWorkspaceFile(true);
    try {
      const uploaded: V1MessageAttachment[] = [];
      for (const file of files) {
        if (isPreviewMode) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const blobUrl = createSafeP2PBlobUrl(bytes, file.type);
          uploaded.push({
            id: `local-att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            byteSize: file.size,
            url: blobUrl,
            downloadUrl: blobUrl,
          });
        } else {
          const att = await apiV1.uploadWorkspaceFile(convId, file);
          uploaded.push(att);
        }
      }
      setPendingAttachmentsByConv((prev) => ({
        ...prev,
        [convId]: [...(prev[convId] || []), ...uploaded],
      }));
    } catch (err) {
      setWorkspaceUploadErrorByConv((prev) => ({
        ...prev,
        [convId]: err instanceof Error ? err.message : "文件上传失败，请稍后重试",
      }));
    } finally {
      setUploadingWorkspaceFile(false);
    }
  };

  const submitCurrentMessage = async () => {
    if (editingMsg) {
      if (!draft.trim()) return;
      await editWorkspaceMessage(activeConv.id, editingMsg.id, draft);
      setDraft(activeConv.id, "");
      return;
    }
    if (!draft.trim() && pendingAttachments.length === 0) return;
    const convId = activeConv.id;
    const text = draft;
    const reply = replyToId;
    const attachmentsToSend = pendingAttachments;
    setReplyToId(undefined);
    setPendingAttachmentsByConv((prev) => ({ ...prev, [convId]: [] }));
    setWorkspaceUploadErrorByConv((prev) => ({ ...prev, [convId]: "" }));
    await sendWorkspaceMessage(convId, text, reply, attachmentsToSend);
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
      aria-label="共享空间对话"
      className={cn(
        "flex flex-1 flex-col min-w-0 min-h-0 h-full bg-dl-surface-canvas/35",
        mobileView === "list" && "max-compact:hidden"
      )}
    >
      {/* Header */}
      <header className="dl-glass-chrome flex items-center justify-between gap-2 border-b border-dl-border-hairline px-5 max-compact:px-3.5 max-narrow:px-2.5 py-3 max-narrow:py-2.5">
        <div className="flex items-center gap-2.5 max-narrow:gap-2 min-w-0 flex-1">
          <IconButton
            variant="ghost"
            size="sm"
            className="hidden max-compact:inline-flex shrink-0"
            onClick={() => setMobileView("list")}
            label="返回对话列表"
          >
            <ChevronLeft className="size-4" strokeWidth={2} />
          </IconButton>

          {activeConv.kind === "saved" ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/16 text-dl-lane-shared max-narrow:hidden">
              <Bookmark className="size-[18px]" strokeWidth={1.9} />
            </div>
          ) : (
            <div className="shrink-0 max-narrow:hidden">
              <Avatar name={activeConv.title} size="md" />
            </div>
          )}

          <div className="min-w-0 flex-1">
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
              aria-label="详情与置顶"
              className="gap-1.5 text-xs text-dl-text-secondary hover:text-dl-text-primary max-narrow:px-2"
              onClick={openDetailsInspector}
            >
              <PanelRightOpen className="size-4 shrink-0" strokeWidth={1.75} />
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

                        {(!msg.attachments?.length || msg.plainText !== "[文件]") &&
                          msg.plainText && (
                            <div className="whitespace-pre-wrap break-words">{msg.plainText}</div>
                          )}

                        {msg.attachments && msg.attachments.length > 0 && (
                          <div
                            className={cn(
                              "flex flex-col gap-1.5",
                              (!msg.attachments.length || msg.plainText !== "[文件]") &&
                                msg.plainText &&
                                "mt-2"
                            )}
                          >
                            {msg.attachments.map((att, attIdx) => {
                              const dlHref = att.downloadUrl || att.url;
                              const isSafeImg = safeInlineImageMime(att.mimeType) && Boolean(att.url);
                              return (
                                <div key={att.id} className="space-y-1.5">
                                  {isSafeImg && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="h-auto w-full overflow-hidden rounded-xl p-0"
                                      aria-label={`预览图片 ${att.fileName}`}
                                      onClick={() =>
                                        openLightbox(
                                          msg.attachments!.map((a) => ({
                                            ...a,
                                            conversationId: activeConv.id,
                                            sourceMessageId: msg.id,
                                          })),
                                          attIdx
                                        )
                                      }
                                    >
                                      <img
                                        src={att.url}
                                        alt={att.fileName}
                                        className="max-h-44 max-w-full rounded-xl object-contain"
                                      />
                                    </Button>
                                  )}
                                  <div
                                    className={cn(
                                      "flex items-center justify-between gap-1.5 rounded-xl border px-2 py-1 text-xs",
                                      isOwn
                                        ? "border-current/25 bg-black/10 text-dl-on-shared"
                                        : "border-dl-border-hairline bg-dl-surface-subtle/60 text-dl-text-primary"
                                    )}
                                  >
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      aria-label={`查看附件 ${att.fileName}`}
                                      className={cn(
                                        "h-auto min-w-0 flex-1 justify-start gap-2 px-1 py-0.5 text-left text-xs",
                                        isOwn && "text-dl-on-shared hover:bg-black/10"
                                      )}
                                      onClick={() => {
                                        if (isSafeImg) {
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
                                        <div className="truncate font-medium max-w-[160px]">
                                          {att.fileName}
                                        </div>
                                        <div className="text-[10px] opacity-75">
                                          {formatBytes(att.byteSize)}
                                        </div>
                                      </div>
                                    </Button>
                                    {dlHref && (
                                      <IconButton
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className={cn(
                                          "size-7 shrink-0 rounded-lg",
                                          isOwn && "text-dl-on-shared hover:bg-black/15"
                                        )}
                                        label={`下载 ${att.fileName}`}
                                        onClick={() => triggerBrowserDownload(dlHref, att.fileName)}
                                      >
                                        <Download className="size-3.5" strokeWidth={2} />
                                      </IconButton>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
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
      <div className="px-5 max-compact:px-3 max-narrow:px-2.5 pb-4 max-narrow:pb-3 pt-1.5 space-y-1.5">
        {workspaceUploadError && (
          <div className="rounded-xl border border-dl-danger/30 bg-dl-danger/10 px-3 py-1.5 text-xs text-dl-danger">
            {workspaceUploadError}
          </div>
        )}

        <AnimatePresence initial={false}>
          {(replyTarget || editingMsg) && (
            <motion.div
              key="composer-context-bar"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.14 }}
              className="dl-glass-elevated flex items-center justify-between gap-2 rounded-xl border border-dl-border-hairline px-3 py-1.5 text-xs"
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
                className="size-6 rounded-full shrink-0"
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

        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/60 px-2.5 py-1.5">
            {pendingAttachments.map((att) => (
              <div
                key={att.id}
                data-testid="pending-attachment-chip"
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dl-border-hairline bg-dl-surface-elevated/90 px-2 py-1 text-xs text-dl-text-primary"
              >
                <FileText className="size-3.5 shrink-0 text-dl-lane-shared" strokeWidth={1.85} />
                <span className="truncate max-w-[150px] font-medium">{att.fileName}</span>
                <span className="shrink-0 text-[10px] text-dl-text-tertiary">
                  {formatBytes(att.byteSize)}
                </span>
                <IconButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="size-5 rounded-full shrink-0"
                  label={`移除待发附件 ${att.fileName}`}
                  onClick={() =>
                    setPendingAttachmentsByConv((prev) => ({
                      ...prev,
                      [activeConv.id]: (prev[activeConv.id] || []).filter(
                        (item) => item.id !== att.id
                      ),
                    }))
                  }
                >
                  <X className="size-3" strokeWidth={2} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="dl-glass-pill flex items-end gap-1.5 rounded-2xl border border-dl-border-hairline px-2.5 max-narrow:px-2 py-2 max-narrow:py-1.5 transition-shadow focus-within:border-dl-lane-shared/45"
        >
          <input
            ref={wsFileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-label="选择共享空间上传文件"
            onChange={(e) => void handleWorkspaceFileSelect(e)}
          />

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

          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-xl shrink-0 text-dl-text-secondary hover:text-dl-lane-shared"
            disabled={Boolean(editingMsg) || uploadingWorkspaceFile}
            label="上传文件附件"
            onClick={() => wsFileInputRef.current?.click()}
          >
            <Paperclip className="size-4" strokeWidth={1.85} />
          </IconButton>

          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            aria-label={`发送消息到 ${activeConv.title}`}
            onChange={(e) => setDraft(activeConv.id, e.target.value, replyToId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submitCurrentMessage();
              }
            }}
            placeholder={`发送消息到 ${activeConv.title}…`}
            className="dl-scroll max-h-[132px] min-h-[24px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none"
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
              busy={uploadingWorkspaceFile}
              disabled={
                editingMsg
                  ? !draft.trim()
                  : !draft.trim() && pendingAttachments.length === 0
              }
              className="h-8 gap-1.5 rounded-xl px-3 max-narrow:px-2.5"
            >
              <SendHorizontal className="size-3.5 shrink-0" strokeWidth={2} />
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
          <div className="space-y-3 p-6 max-narrow:p-4 pt-4">
            <Select
              label="选择转发目标对话"
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
