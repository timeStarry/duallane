import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  AtSign,
  Bookmark,
  Check,
  CheckCheck,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  FileText,
  Forward,
  Heart,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Reply,
  RotateCcw,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  Slash,
  Smile,
  Upload,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { isSingleImageEmoteText, renderMessageParts } from "@/emotes";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore } from "@/entities/lane/store";
import {
  useWorkspaceStore,
  type V1Message,
  type V1MessageAttachment,
} from "@/entities/workspace/store";
import { apiV1, type BotCommandSpec } from "@/shared/lib/api-v1";
import { triggerBrowserDownload } from "@/shared/lib/download";
import {
  createSafeP2PBlobUrl,
  safeInlineImageMime,
  scrubP2PRoomFromUrl,
} from "@/shared/lib/p2p-lane";
import {
  Avatar,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Tooltip,
} from "@/shared/ui";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";
import {
  EmoteStickerPopover,
  extractFavoritableSource,
  isEmotePackShareOnlyMessage,
  isJumboStickerMessage,
  MessageRichContent,
  ReactionKeyDisplay,
  ReactionPickerPopoverContent,
} from "@/widgets/EmoteSystem";
import { cn } from "@/shared/lib/cn";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function isSameLocalCalendarDay(isoA: string, isoB: string): boolean {
  const dA = new Date(isoA);
  const dB = new Date(isoB);
  if (Number.isNaN(dA.getTime()) || Number.isNaN(dB.getTime())) return true;
  return (
    dA.getFullYear() === dB.getFullYear() &&
    dA.getMonth() === dB.getMonth() &&
    dA.getDate() === dB.getDate()
  );
}

function formatDateDividerLabel(iso: string): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfTarget) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (target.getFullYear() === now.getFullYear()) {
    return `${target.getMonth() + 1}月${target.getDate()}日`;
  }
  return `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`;
}

function isGroupedPair(a?: V1Message, b?: V1Message): boolean {
  if (!a || !b) return false;
  if (a.recalledAt || b.recalledAt) return false;
  if (a.kind === "system" || b.kind === "system") return false;
  if (a.senderId !== b.senderId) return false;
  if (a.card || b.card) return false;
  if (!isSameLocalCalendarDay(a.createdAt, b.createdAt)) return false;
  const delta = Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return Number.isFinite(delta) && delta <= GROUP_WINDOW_MS;
}

const DEFAULT_FALLBACK_SLASH_COMMANDS: BotCommandSpec[] = [
  { command: "summarize", description: "总结对话与线程要点" },
  { command: "poll", description: "发起交互式投票卡片" },
];

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
    members,
    conversations,
    conversationOrder,
    activeConversationId,
    messagesByConv,
    highlightedMessageId,
    drafts,
    editingMessageId,
    typingByConv,
    recalledDrafts,
    setDraft,
    setScrollTop,
    setEditingMessageId,
    sendWorkspaceMessage,
    editWorkspaceMessage,
    recallWorkspaceMessage,
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
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionMenuIdx, setMentionMenuIdx] = useState(0);
  const [slashMenuIdx, setSlashMenuIdx] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState("");
  const [convBotCommandsByConv, setConvBotCommandsByConv] = useState<
    Record<string, BotCommandSpec[]>
  >({});
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [typingClockTick, setTypingClockTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const wsFileInputRef = useRef<HTMLInputElement | null>(null);
  const p2pFileInputRef = useRef<HTMLInputElement | null>(null);
  const prevMsgStateRef = useRef<{ convId: string | null; count: number }>({
    convId: null,
    count: 0,
  });
  const dragDepthRef = useRef(0);
  const lastTypingSentAtRef = useRef<Record<string, number>>({});

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

  const hasBotInConversation = useMemo(() => {
    if (!activeConv || activeConv.kind === "saved") return false;
    const memberHasBot = activeConv.memberIds.some((id) => {
      const m = members[id];
      return m?.role === "bot" || id.startsWith("usr_bot_") || id.startsWith("usr_system_");
    });
    if (memberHasBot) return true;
    return messages.some(
      (m) =>
        m.kind === "bot" ||
        m.senderId.startsWith("usr_bot_") ||
        m.senderId.startsWith("usr_system_")
    );
  }, [activeConv, members, messages]);

  const directPeer = useMemo(() => {
    if (!activeConv || activeConv.kind !== "direct") return undefined;
    const peerId = activeConv.memberIds.find((id) => id && id !== currentUser?.id);
    return peerId ? members[peerId] : undefined;
  }, [activeConv, currentUser?.id, members]);

  // Load dynamic bot Slash commands for conversations containing bots
  useEffect(() => {
    const convId = activeConv?.id;
    if (activeLane !== "workspace" || isPreviewMode || !convId || !hasBotInConversation) {
      return;
    }
    let cancelled = false;
    void apiV1
      .listConversationBotCommands(convId)
      .then((res) => {
        if (cancelled) return;
        setConvBotCommandsByConv((prev) => ({
          ...prev,
          [convId]: Array.isArray(res.commands) ? res.commands : [],
        }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeLane, isPreviewMode, activeConv?.id, hasBotInConversation]);

  const effectiveSlashCommands = useMemo(() => {
    if (!hasBotInConversation) return [];
    const custom = activeConv ? convBotCommandsByConv[activeConv.id] : undefined;
    return custom && custom.length > 0 ? custom : DEFAULT_FALLBACK_SLASH_COMMANDS;
  }, [activeConv, convBotCommandsByConv, hasBotInConversation]);

  const rawTypingEntries = useMemo(
    () => (activeConv ? typingByConv[activeConv.id] || [] : []),
    [activeConv, typingByConv]
  );
  useEffect(() => {
    if (rawTypingEntries.length === 0) return;
    const timer = setInterval(() => setTypingClockTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [rawTypingEntries.length]);

  const activeTypingText = useMemo(() => {
    void typingClockTick;
    const now = Date.now();
    const valid = rawTypingEntries.filter(
      (entry) => entry.userId !== currentUser?.id && entry.expiresAt > now
    );
    if (valid.length === 0) return "";
    if (valid.length === 1) {
      const item = valid[0]!;
      return `${item.displayName} ${item.state === "thinking" ? "正在思考…" : "正在输入…"}`;
    }
    return `${valid.map((item) => item.displayName).join("、")} 正在输入…`;
  }, [rawTypingEntries, currentUser?.id, typingClockTick]);

  const mentionAutocomplete = useMemo(() => {
    if (!activeConv || activeConv.kind === "saved" || editingMessageId) return null;
    const pos = Math.max(0, Math.min(cursorPos || draft.length, draft.length));
    const before = draft.slice(0, pos);
    const match = /(?:^|\s)@([^\s@]{0,24})$/u.exec(before);
    if (!match) return null;
    const query = match[1] || "";
    const atIndex = pos - query.length - 1;
    const triggerKey = `mention:${atIndex}:${query}`;
    if (dismissedTriggerKey === triggerKey) return null;

    const qLower = query.toLowerCase();
    const items: Array<{
      id: string;
      displayName: string;
      subtitle?: string;
      avatarUrl?: string;
      isBot: boolean;
      isAll: boolean;
    }> = [];

    if (
      activeConv.kind === "group" &&
      (!query || "所有人".includes(query) || "all".includes(qLower))
    ) {
      items.push({
        id: "all",
        displayName: "所有人",
        subtitle: "提醒群内全部成员",
        isBot: false,
        isAll: true,
      });
    }

    for (const memberId of activeConv.memberIds) {
      if (!memberId || memberId === currentUser?.id) continue;
      const member = members[memberId];
      if (!member) continue;
      const matchName = member.displayName.toLowerCase().includes(qLower);
      const matchHandle = (member.handle || "").toLowerCase().includes(qLower);
      if (!query || matchName || matchHandle) {
        items.push({
          id: member.id,
          displayName: member.displayName,
          subtitle:
            member.description ||
            (member.role === "bot" ? "机器人 / Agent" : member.handle ? `@${member.handle}` : undefined),
          avatarUrl: member.avatarUrl,
          isBot:
            member.role === "bot" ||
            member.id.startsWith("usr_bot_") ||
            member.id.startsWith("usr_system_"),
          isAll: false,
        });
      }
    }

    if (items.length === 0) return null;
    return { items, atIndex, endIndex: pos, query, triggerKey };
  }, [activeConv, cursorPos, currentUser?.id, dismissedTriggerKey, draft, editingMessageId, members]);

  const slashAutocomplete = useMemo(() => {
    if (!activeConv || !hasBotInConversation || editingMessageId) return null;
    const match = /^\/([a-z0-9_-]{0,24})$/i.exec(draft);
    if (!match) return null;
    const query = (match[1] || "").toLowerCase();
    const triggerKey = `slash:${query}`;
    if (dismissedTriggerKey === triggerKey) return null;
    const items = effectiveSlashCommands.filter(
      (cmd) =>
        !query ||
        cmd.command.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query)
    );
    if (items.length === 0) return null;
    return { items, query, triggerKey };
  }, [activeConv, dismissedTriggerKey, draft, editingMessageId, effectiveSlashCommands, hasBotInConversation]);

  const uploadWorkspaceFiles = useCallback(
    async (convId: string, files: File[]) => {
      if (!convId || files.length === 0) return;
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
              fileName: file.name || `image-${Date.now()}.png`,
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
    },
    [isPreviewMode]
  );

  const emitHumanTypingThrottled = useCallback(
    (convId: string, convKind: string) => {
      if (isPreviewMode || !convId || convKind === "saved") return;
      const now = Date.now();
      const lastSent = lastTypingSentAtRef.current[convId] || 0;
      if (now - lastSent < 2600) return;
      lastTypingSentAtRef.current[convId] = now;
      void apiV1.sendConversationTyping(convId, "typing").catch(() => {});
    },
    [isPreviewMode]
  );

  const copyMessagePlainText = async (plainText: string) => {
    const text = plainText || "";
    if (!text) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        useEmoteStore.getState().showToast("已复制消息内容");
        return;
      }
    } catch {
      // Fallback below
    }
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      useEmoteStore.getState().showToast("已复制消息内容");
    } catch {
      // Ignore
    }
  };

  // Auto-resize composer textarea height cleanly
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(132, Math.max(24, el.scrollHeight))}px`;
  }, [draft, activeConversationId, activeLane]);

  // Restore pixel scroll position per conversation & reset transient overlays
  useEffect(() => {
    setIsNearBottom(true);
    setUnreadBelowCount(0);
    setIsDraggingFiles(false);
    dragDepthRef.current = 0;
    if (!scrollRef.current || activeLane !== "workspace" || !activeConversationId) return;
    const saved = useWorkspaceStore.getState().scrollTops[activeConversationId];
    if (typeof saved === "number") {
      scrollRef.current.scrollTop = saved;
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversationId, activeLane]);

  // Keep timeline pinned to bottom when near bottom or sending own messages; otherwise count unread below
  useEffect(() => {
    if (activeLane !== "workspace" || !activeConversationId) return;
    const prev = prevMsgStateRef.current;
    prevMsgStateRef.current = { convId: activeConversationId, count: messages.length };
    if (prev.convId !== activeConversationId || messages.length <= prev.count) {
      return;
    }
    const delta = messages.length - prev.count;
    const newest = messages[messages.length - 1];
    const isOwnNewest = Boolean(newest && newest.senderId === currentUser?.id);
    if (isOwnNewest || isNearBottom) {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      setUnreadBelowCount(0);
    } else {
      setUnreadBelowCount((n) => n + delta);
    }
  }, [activeConversationId, activeLane, currentUser?.id, isNearBottom, messages]);

  // Auto-scroll to highlighted message when jumping from Search / Pin / File backlink
  useEffect(() => {
    if (!highlightedMessageId || !scrollRef.current) return;
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(highlightedMessageId)
        : highlightedMessageId.replace(/["\\]/g, "\\$&");
    const el = scrollRef.current.querySelector(`[data-message-id="${escapedId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedMessageId, messages]);

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
                  {p2pRoom ? `私密直连 · #${p2pRoom.roomId}` : "私密直连"}
                </h1>
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
                指纹 {p2pRoom.keyFingerprint}
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
              <div className="text-sm font-semibold text-dl-text-primary">
                创建端到端加密临时会话
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
              <div className="dl-glass-elevated w-full max-w-md rounded-2xl border border-dl-border-hairline p-5 max-narrow:p-3.5 space-y-2.5">
                <div className="text-sm font-semibold text-dl-text-primary">
                  {hasRoomError
                    ? "加密房间不可用"
                    : p2pRoom.status === "peer_connected"
                      ? "对端已连接 · 2/2 在线"
                      : "等待对端加入（1/2）"}
                </div>
                {(hasRoomError || p2pRoom.status !== "peer_connected") && (
                  <p className="text-xs leading-relaxed text-dl-text-secondary">
                    {hasRoomError
                      ? p2pRoom.errorMessage || "链接中的房间或密钥已失效，请重新创建加密房间。"
                      : "复制下方邀请链接发送给对方，即可开始加密对话。"}
                  </p>
                )}
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
                        {copiedLink ? "已复制邀请链接" : "复制邀请链接"}
                      </span>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            p2pMessages.map((msg) => {
              const isInlineP2PImg = Boolean(
                msg.attachment && safeInlineImageMime(msg.attachment.mimeType)
              );
              const isImageOnlyP2P = !msg.text && isInlineP2PImg;
              const isJumboP2PSticker = !msg.attachment && isSingleImageEmoteText(msg.text || "");
              return (
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
                    data-frameless-image={isImageOnlyP2P ? "true" : undefined}
                    className={cn(
                      "max-w-[72%] max-compact:max-w-[88%] text-[14px] leading-relaxed",
                      isJumboP2PSticker
                        ? "p-0.5 text-dl-text-primary"
                        : isImageOnlyP2P
                        ? "p-0 text-dl-text-primary"
                        : cn(
                            "rounded-[18px] px-3.5 py-2 shadow-2xs",
                            msg.isOwn
                              ? "rounded-br-[6px] bg-dl-lane-direct text-dl-on-direct"
                              : "rounded-bl-[6px] dl-glass-elevated border border-dl-border-hairline text-dl-text-primary"
                          )
                    )}
                  >
                    {msg.text && (
                      <div
                        className={cn(
                          "whitespace-pre-wrap break-words",
                          isJumboP2PSticker && "dl-jumbo-sticker p-1"
                        )}
                      >
                        {renderMessageParts(msg.text)}
                      </div>
                    )}

                    {msg.attachment && (
                      <div className={cn("space-y-1.5", msg.text && "mt-2")}>
                        {isInlineP2PImg ? (
                          <div className="relative inline-block overflow-hidden rounded-2xl ring-1 ring-black/8 dark:ring-white/10 shadow-xs">
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-auto w-full overflow-hidden rounded-2xl p-0"
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
                                className="max-h-64 max-w-full rounded-2xl object-contain"
                              />
                            </Button>
                            {isImageOnlyP2P && (
                              <div className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-black/55 backdrop-blur-md px-2 py-0.5 text-[10px] font-medium tabular-nums text-white shadow-xs">
                                <span>
                                  {new Date(msg.createdAt).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                                {msg.isOwn && (
                                  <span className="inline-flex items-center">
                                    {msg.deliveryStatus === "delivered" ? (
                                      <CheckCheck className="size-3.5" strokeWidth={2.1} />
                                    ) : msg.deliveryStatus === "sent" ? (
                                      <Check className="size-3" strokeWidth={2} />
                                    ) : msg.deliveryStatus === "failed" ? (
                                      <AlertCircle className="size-3 text-red-300" strokeWidth={2} />
                                    ) : (
                                      <Clock className="size-3" strokeWidth={2} />
                                    )}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
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
                        )}
                      </div>
                    )}

                    {!isImageOnlyP2P && (
                      <div
                        className={cn(
                          "mt-1 flex items-center justify-end gap-1.5 text-[10px] tabular-nums",
                          msg.isOwn && !isJumboP2PSticker ? "opacity-90" : "text-dl-text-tertiary"
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
                    )}
                  </div>
                </motion.div>
              );
            })
          )}
        </div>

        {p2pRoom && (
          <div className="px-5 max-compact:px-3 max-narrow:px-2.5 pb-4 max-narrow:pb-3 pt-1.5 space-y-1.5">
            {p2pFileError && (
              <div className="rounded-xl border border-dl-danger/30 bg-dl-danger/10 px-3 py-1.5 text-xs text-dl-danger">
                {p2pFileError}
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
              <EmoteStickerPopover
                lane="p2p"
                disabled={Boolean(hasRoomError)}
                onInsertText={(t) => setP2PDraft(`${p2pDraft}${t}`)}
              />
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
    await uploadWorkspaceFiles(activeConv.id, files);
  };

  const insertMentionForAuthor = (authorName: string) => {
    const clean = authorName.replace(/^@+/, "").trim();
    if (!clean) return;
    const needsSpace = draft.length > 0 && !/\s$/.test(draft);
    const next = `${draft}${needsSpace ? " " : ""}@${clean} `;
    setDraft(activeConv.id, next, replyToId);
    setCursorPos(next.length);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(next.length, next.length);
        } catch {
          // Ignore selection errors in non-DOM test environments
        }
      }
    });
  };

  const applyMentionCandidate = (displayName: string) => {
    if (!mentionAutocomplete) return;
    const prefix = draft.slice(0, mentionAutocomplete.atIndex);
    const suffix = draft.slice(mentionAutocomplete.endIndex);
    const inserted = `@${displayName} `;
    const next = `${prefix}${inserted}${suffix.replace(/^\s+/, "")}`;
    const nextCursor = prefix.length + inserted.length;
    setDraft(activeConv.id, next, replyToId);
    setCursorPos(nextCursor);
    setMentionMenuIdx(0);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(nextCursor, nextCursor);
        } catch {
          // Ignore
        }
      }
    });
  };

  const applySlashCandidate = (command: string) => {
    const clean = command.replace(/^\/+/, "").trim();
    if (!clean) return;
    const next = `/${clean} `;
    setDraft(activeConv.id, next, replyToId);
    setCursorPos(next.length);
    setSlashMenuIdx(0);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(next.length, next.length);
        } catch {
          // Ignore
        }
      }
    });
  };

  const scrollToTimelineBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo?.({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    setIsNearBottom(true);
    setUnreadBelowCount(0);
  };

  const submitCurrentMessage = async () => {
    if (editingMsg) {
      if (!draft.trim()) return;
      await editWorkspaceMessage(activeConv.id, editingMsg.id, draft);
      setDraft(activeConv.id, "");
      setCursorPos(0);
      return;
    }
    if (!draft.trim() && pendingAttachments.length === 0) return;
    const convId = activeConv.id;
    const text = draft;
    const reply = replyToId;
    const attachmentsToSend = pendingAttachments;
    setReplyToId(undefined);
    setCursorPos(0);
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
      onDragEnter={(e) => {
        if (editingMsg || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingFiles(true);
      }}
      onDragOver={(e) => {
        if (editingMsg || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setIsDraggingFiles(false);
        }
      }}
      onDrop={(e) => {
        dragDepthRef.current = 0;
        setIsDraggingFiles(false);
        if (editingMsg) return;
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        e.preventDefault();
        void uploadWorkspaceFiles(activeConv.id, files);
      }}
      className={cn(
        "relative flex flex-1 flex-col min-w-0 min-h-0 h-full bg-dl-surface-canvas/35",
        mobileView === "list" && "max-compact:hidden"
      )}
    >
      {isDraggingFiles && (
        <div className="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-dl-lane-shared bg-dl-surface-elevated/88 backdrop-blur-md text-dl-lane-shared shadow-lg">
          <Upload className="size-7" strokeWidth={1.9} />
          <div className="text-sm font-semibold">松开鼠标上传图片或文件到「{activeConv.title}」</div>
          <div className="text-xs text-dl-text-secondary">支持单张或多张图片、常见文档与附件</div>
        </div>
      )}

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

          <Button
            type="button"
            variant="ghost"
            onClick={openDetailsInspector}
            className="h-auto min-w-0 flex-1 justify-start gap-2.5 max-narrow:gap-2 rounded-xl px-1.5 py-0.5 -mx-1.5 text-left font-normal hover:bg-dl-surface-subtle/50"
          >
            {activeConv.kind === "saved" ? (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/16 text-dl-lane-shared max-narrow:hidden">
                <Bookmark className="size-[18px]" strokeWidth={1.9} />
              </div>
            ) : (
              <div className="shrink-0 max-narrow:hidden">
                <Avatar
                  name={activeConv.title}
                  src={activeConv.avatarUrl || directPeer?.avatarUrl}
                  emoji={activeConv.avatarEmoji}
                  kind={
                    activeConv.kind === "group"
                      ? "group"
                      : hasBotInConversation
                      ? "bot"
                      : "human"
                  }
                  size="md"
                />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold tracking-tight text-dl-text-primary">
                {activeConv.title}
              </h1>
              {activeTypingText ? (
                <p
                  data-testid="header-typing-status"
                  className="truncate text-xs font-medium text-dl-lane-shared animate-pulse"
                >
                  {activeTypingText}
                </p>
              ) : activeConv.kind === "group" ? (
                <p className="truncate text-xs text-dl-text-secondary">
                  {activeConv.memberIds.length || 1} 人
                </p>
              ) : directPeer?.description ? (
                <p className="truncate text-xs text-dl-text-secondary">
                  {directPeer.description}
                </p>
              ) : null}
            </div>
          </Button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip content={activeConv.kind === "group" ? "群聊设置" : "会话详情"} side="bottom">
            <Button
              size="sm"
              variant="ghost"
              aria-label={activeConv.kind === "group" ? "群聊设置" : "会话详情"}
              className="gap-1.5 text-xs text-dl-text-secondary hover:text-dl-text-primary max-narrow:px-2"
              onClick={openDetailsInspector}
            >
              {activeConv.kind === "group" ? (
                <Settings2 className="size-4 shrink-0" strokeWidth={1.8} />
              ) : (
                <PanelRightOpen className="size-4 shrink-0" strokeWidth={1.75} />
              )}
              <span className="max-compact:hidden">
                {activeConv.kind === "group" ? "群聊设置" : "会话详情"}
              </span>
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
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(activeConv.id, el.scrollTop);
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
          const near = dist < 160;
          setIsNearBottom(near);
          if (near) {
            setUnreadBelowCount(0);
          }
        }}
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
            const showDateDivider =
              !prevMsg || !isSameLocalCalendarDay(prevMsg.createdAt, msg.createdAt);
            const dateDividerLabel = showDateDivider ? formatDateDividerLabel(msg.createdAt) : "";
            const groupedWithPrev = isGroupedPair(prevMsg, msg);
            const groupedWithNext = isGroupedPair(msg, nextMsg);

            if (msg.recalledAt) {
              const recalledDraft = isOwn ? recalledDrafts[msg.id] : undefined;
              return (
                <React.Fragment key={msg.id}>
                  {dateDividerLabel && (
                    <div
                      data-testid="timeline-date-divider"
                      className="my-3 flex justify-center select-none"
                    >
                      <span className="dl-glass-pill rounded-full border border-dl-border-hairline px-3 py-0.5 text-[11px] font-medium text-dl-text-tertiary">
                        {dateDividerLabel}
                      </span>
                    </div>
                  )}
                  <div
                    data-message-id={msg.id}
                    data-testid="recalled-message-pill"
                    className="my-2.5 flex items-center justify-center"
                  >
                    <div className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full bg-dl-surface-subtle/75 px-3 py-1 text-[11px] text-dl-text-tertiary">
                      <span>
                        {isOwn ? "你撤回了一条消息" : `${msg.senderName} 撤回了一条消息`}
                      </span>
                      {recalledDraft && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-5 rounded-full px-1.5 py-0 text-[11px] font-semibold text-dl-lane-shared hover:bg-dl-lane-shared/12"
                          onClick={() => {
                            setReplyToId(recalledDraft.replyToId);
                            setDraft(activeConv.id, recalledDraft.text, recalledDraft.replyToId);
                            setCursorPos(recalledDraft.text.length);
                            composerRef.current?.focus();
                          }}
                        >
                          重新编辑
                        </Button>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            if (msg.kind === "system") {
              return (
                <React.Fragment key={msg.id}>
                  {dateDividerLabel && (
                    <div
                      data-testid="timeline-date-divider"
                      className="my-3 flex justify-center select-none"
                    >
                      <span className="dl-glass-pill rounded-full border border-dl-border-hairline px-3 py-0.5 text-[11px] font-medium text-dl-text-tertiary">
                        {dateDividerLabel}
                      </span>
                    </div>
                  )}
                  <div
                    data-message-id={msg.id}
                    className="my-2.5 flex items-center justify-center"
                  >
                    <span className="rounded-full bg-dl-surface-subtle/75 px-3 py-1 text-[11px] text-dl-text-tertiary">
                      {msg.plainText}
                    </span>
                  </div>
                </React.Fragment>
              );
            }

            const repliedMsg = msg.replyToId ? messageMap.get(msg.replyToId) : undefined;
            const isPinned = activeConv.pinnedMessageIds.includes(msg.id);
            const hasReactionsOrThread =
              Object.keys(msg.reactions).length > 0 || (msg.threadReplyCount || 0) > 0;
            const favoritableSource = extractFavoritableSource(msg);
            const isEditableTextMsg =
              isOwn &&
              !msg.card &&
              !msg.blocks?.some(
                (b) => b.type === "emoji" || b.type === "emote_collection"
              );
            const senderMember = members[msg.senderId];
            const senderAvatarSrc = senderMember?.avatarUrl || msg.senderAvatarUrl;
            const senderAvatarKind =
              msg.kind === "bot" ||
              senderMember?.role === "bot" ||
              msg.senderId.startsWith("usr_bot_") ||
              msg.senderId.startsWith("usr_system_")
                ? "bot"
                : "human";

            const triggerFavoriteSticker = () => {
              if (!favoritableSource) return;
              void useEmoteStore
                .getState()
                .favoriteFromMessage(
                  { messageId: msg.id, ...favoritableSource },
                  undefined,
                  isPreviewMode
                );
            };

            const triggerStartReply = () => {
              setReplyToId(msg.id);
              composerRef.current?.focus();
            };

            const triggerStartEdit = () => {
              setEditingMessageId(msg.id);
              setDraft(activeConv.id, msg.plainText);
              setCursorPos(msg.plainText.length);
              composerRef.current?.focus();
            };

            const triggerOpenForward = () => {
              setForwardMsgId(msg.id);
              setForwardTargetConvId(conversationOrder[0] || "");
            };

            const receiptStatus = msg.status || "sent";

            return (
              <React.Fragment key={msg.id}>
                {dateDividerLabel && (
                  <div
                    data-testid="timeline-date-divider"
                    className="my-3 flex justify-center select-none"
                  >
                    <span className="dl-glass-pill rounded-full border border-dl-border-hairline px-3 py-0.5 text-[11px] font-medium text-dl-text-tertiary">
                      {dateDividerLabel}
                    </span>
                  </div>
                )}

                <div
                  data-message-id={msg.id}
                  onDoubleClick={triggerStartReply}
                  className={cn(
                    "group relative flex flex-col rounded-2xl px-1.5 py-0.5 transition-colors",
                    idx === 0 && !dateDividerLabel ? "mt-0" : groupedWithPrev ? "mt-1" : "mt-4",
                    isOwn ? "items-end" : "items-start",
                    isHighlighted && "bg-dl-lane-shared/14 ring-1 ring-dl-lane-shared/40 py-1.5"
                  )}
                >
                  <div
                    className={cn(
                      "flex items-end gap-2 max-w-[85%] max-compact:max-w-[95%]",
                      isOwn && "flex-row-reverse"
                    )}
                  >
                    {!isOwn &&
                      (groupedWithNext ? (
                        <div className="w-7 shrink-0" aria-hidden="true" />
                      ) : (
                        <Avatar
                          name={msg.senderName}
                          src={senderAvatarSrc}
                          kind={senderAvatarKind}
                          size="sm"
                        />
                      ))}

                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "flex flex-col min-w-0",
                            isOwn ? "items-end" : "items-start"
                          )}
                        >
                          {!isOwn && !groupedWithPrev && (
                            <div className="mb-0.5 flex items-center gap-1 px-0.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                data-testid="sender-mention-trigger"
                                aria-label={`提及 ${msg.senderName}`}
                                onClick={() => insertMentionForAuthor(msg.senderName)}
                                className="group/author h-5 gap-0.5 rounded-md px-1 py-0 text-[11px] font-semibold text-dl-text-secondary hover:bg-dl-lane-shared/10 hover:text-dl-lane-shared"
                              >
                                <span className="inline-block max-w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/author:max-w-[12px] group-hover/author:opacity-100">
                                  @
                                </span>
                                <span>{msg.senderName}</span>
                              </Button>
                            </div>
                          )}

                          {msg.card ? (
                            <DualLaneCardKit card={msg.card} onAction={triggerCardAction} />
                          ) : (
                            (() => {
                              const isJumboSticker = isJumboStickerMessage(msg);
                              const isPackShareOnly = isEmotePackShareOnlyMessage(msg);

                              if (isJumboSticker || isPackShareOnly) {
                                return (
                                  <div
                                    className={cn(
                                      "flex flex-col",
                                      isOwn ? "items-end" : "items-start"
                                    )}
                                  >
                                    <MessageRichContent msg={msg} jumbo={isJumboSticker} />
                                    <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] tabular-nums text-dl-text-tertiary select-none">
                                      {msg.editedAt && <span>(已编辑)</span>}
                                      <span>
                                        {new Date(msg.createdAt).toLocaleTimeString([], {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        })}
                                      </span>
                                      {isOwn && (
                                        <span
                                          data-receipt-status={receiptStatus}
                                          className="inline-flex items-center"
                                        >
                                          {receiptStatus === "sending" ? (
                                            <Clock className="size-3" strokeWidth={2} />
                                          ) : receiptStatus === "failed" ? (
                                            <AlertCircle
                                              className="size-3 text-dl-danger"
                                              strokeWidth={2}
                                            />
                                          ) : receiptStatus === "read" ? (
                                            <CheckCheck
                                              className="size-3.5 text-dl-lane-shared"
                                              strokeWidth={2}
                                            />
                                          ) : (
                                            <Check className="size-3" strokeWidth={2} />
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              }

                              const hasVisibleText =
                                Boolean(msg.blocks && msg.blocks.length > 0) ||
                                Boolean(
                                  msg.plainText &&
                                    (!msg.attachments?.length ||
                                      !/^(?:\[文件\]\s*)+$/.test(msg.plainText.trim()))
                                );
                              const allInlineImages =
                                Boolean(msg.attachments?.length) &&
                                msg.attachments!.every(
                                  (att) => safeInlineImageMime(att.mimeType) && Boolean(att.url)
                                );
                              const isImageOnlyMsg =
                                !hasVisibleText && !msg.replyToId && allInlineImages;

                              if (isImageOnlyMsg && msg.attachments) {
                                return (
                                  <div
                                    data-frameless-image="true"
                                    className={cn(
                                      "flex flex-col gap-1.5",
                                      isOwn ? "items-end" : "items-start"
                                    )}
                                  >
                                    {msg.attachments.map((att, attIdx) => {
                                      const isLastImage = attIdx === msg.attachments!.length - 1;
                                      return (
                                        <div
                                          key={att.id}
                                          className="relative inline-block overflow-hidden rounded-2xl ring-1 ring-black/8 dark:ring-white/10 shadow-xs"
                                        >
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            className="h-auto w-full overflow-hidden rounded-2xl p-0"
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
                                              className="max-h-72 max-w-full rounded-2xl object-contain"
                                            />
                                          </Button>
                                          {isLastImage && (
                                            <div className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-black/55 backdrop-blur-md px-2 py-0.5 text-[10px] font-medium tabular-nums text-white shadow-xs select-none">
                                              {msg.editedAt && <span>(已编辑)</span>}
                                              <span>
                                                {new Date(msg.createdAt).toLocaleTimeString([], {
                                                  hour: "2-digit",
                                                  minute: "2-digit",
                                                })}
                                              </span>
                                              {isOwn && (
                                                <span
                                                  data-receipt-status={receiptStatus}
                                                  className="inline-flex items-center"
                                                >
                                                  {receiptStatus === "sending" ? (
                                                    <Clock className="size-3" strokeWidth={2} />
                                                  ) : receiptStatus === "failed" ? (
                                                    <AlertCircle
                                                      className="size-3 text-red-300"
                                                      strokeWidth={2}
                                                    />
                                                  ) : receiptStatus === "read" ? (
                                                    <CheckCheck
                                                      className="size-3.5"
                                                      strokeWidth={2.1}
                                                    />
                                                  ) : (
                                                    <Check className="size-3" strokeWidth={2} />
                                                  )}
                                                </span>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              }

                              return (
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
                                        {repliedMsg
                                          ? repliedMsg.plainText
                                          : `#${msg.replyToId.slice(-6)}`}
                                      </span>
                                    </Button>
                                  )}

                                  {hasVisibleText && <MessageRichContent msg={msg} />}

                                  {msg.attachments && msg.attachments.length > 0 && (
                                    <div
                                      className={cn(
                                        "flex flex-col gap-1.5",
                                        hasVisibleText && "mt-2"
                                      )}
                                    >
                                      {msg.attachments.map((att, attIdx) => {
                                        const dlHref = att.downloadUrl || att.url;
                                        const isSafeImg =
                                          safeInlineImageMime(att.mimeType) && Boolean(att.url);
                                        return (
                                          <div key={att.id}>
                                            {isSafeImg ? (
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
                                                  className="max-h-60 max-w-full rounded-xl object-contain"
                                                />
                                              </Button>
                                            ) : (
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
                                                  onClick={() =>
                                                    openFileInspector({
                                                      ...att,
                                                      conversationId: activeConv.id,
                                                      sourceMessageId: msg.id,
                                                    })
                                                  }
                                                >
                                                  <FileText
                                                    className="size-4 shrink-0 opacity-85"
                                                    strokeWidth={1.8}
                                                  />
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
                                                    onClick={() =>
                                                      triggerBrowserDownload(dlHref, att.fileName)
                                                    }
                                                  >
                                                    <Download
                                                      className="size-3.5"
                                                      strokeWidth={2}
                                                    />
                                                  </IconButton>
                                                )}
                                              </div>
                                            )}
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
                                      <span
                                        data-receipt-status={receiptStatus}
                                        className="inline-flex items-center"
                                      >
                                        {receiptStatus === "sending" ? (
                                          <Clock className="size-3" strokeWidth={2} />
                                        ) : receiptStatus === "failed" ? (
                                          <AlertCircle
                                            className="size-3 text-dl-danger"
                                            strokeWidth={2}
                                          />
                                        ) : receiptStatus === "read" ? (
                                          <CheckCheck className="size-3.5" strokeWidth={2} />
                                        ) : (
                                          <Check className="size-3" strokeWidth={2} />
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })()
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
                                  <ReactionKeyDisplay emoteKey={emoji} />
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
                      </ContextMenuTrigger>

                      <ContextMenuContent
                        onQuickReaction={(emoji) =>
                          void toggleReaction(activeConv.id, msg.id, emoji)
                        }
                      >
                        <ContextMenuItem
                          icon={<Reply className="size-4" strokeWidth={1.85} />}
                          onSelect={triggerStartReply}
                        >
                          引用回复
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={<MessageSquareText className="size-4" strokeWidth={1.85} />}
                          onSelect={() => openThreadInspector(msg.id)}
                        >
                          展开话题讨论
                        </ContextMenuItem>
                        {msg.plainText && (
                          <ContextMenuItem
                            icon={<Copy className="size-4" strokeWidth={1.85} />}
                            onSelect={() => void copyMessagePlainText(msg.plainText)}
                          >
                            复制消息内容
                          </ContextMenuItem>
                        )}
                        {favoritableSource && (
                          <ContextMenuItem
                            icon={<Heart className="size-4" strokeWidth={1.85} />}
                            onSelect={triggerFavoriteSticker}
                          >
                            收藏贴纸
                          </ContextMenuItem>
                        )}
                        {isEditableTextMsg && (
                          <ContextMenuItem
                            icon={<Pencil className="size-4" strokeWidth={1.85} />}
                            onSelect={triggerStartEdit}
                          >
                            编辑消息
                          </ContextMenuItem>
                        )}
                        {isOwn && !msg.recalledAt && (
                          <ContextMenuItem
                            icon={<RotateCcw className="size-4" strokeWidth={1.85} />}
                            onSelect={() => void recallWorkspaceMessage(activeConv.id, msg.id)}
                          >
                            撤回消息
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          icon={<Forward className="size-4" strokeWidth={1.85} />}
                          onSelect={triggerOpenForward}
                        >
                          转发消息
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={
                            isPinned ? (
                              <PinOff className="size-4" strokeWidth={1.85} />
                            ) : (
                              <Pin className="size-4" strokeWidth={1.85} />
                            )
                          }
                          onSelect={() => void togglePinMessage(activeConv.id, msg.id)}
                        >
                          {isPinned ? "取消置顶" : "置顶到对话顶部"}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    {/* Non-overlapping Inline Side Action Pill */}
                    <div
                      className={cn(
                        "dl-glass-pill mb-0.5 flex shrink-0 items-center gap-0.5 self-center rounded-full border border-dl-border-hairline px-1 py-0.5",
                        "opacity-0 pointer-events-none transition-opacity duration-150",
                        "group-hover:opacity-100 group-hover:pointer-events-auto",
                        "focus-within:opacity-100 focus-within:pointer-events-auto"
                      )}
                    >
                      <Popover>
                        <PopoverTrigger asChild>
                          <IconButton
                            size="sm"
                            variant="ghost"
                            className="size-6 rounded-full"
                            label="添加表情回应"
                          >
                            <Smile className="size-3.5" strokeWidth={1.85} />
                          </IconButton>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align={isOwn ? "end" : "start"}
                          className="p-1.5"
                        >
                          <ReactionPickerPopoverContent
                            onSelectReaction={(key) =>
                              void toggleReaction(activeConv.id, msg.id, key)
                            }
                          />
                        </PopoverContent>
                      </Popover>

                      <IconButton
                        size="sm"
                        variant="ghost"
                        className="size-6 rounded-full"
                        label="引用回复"
                        onClick={triggerStartReply}
                      >
                        <Reply className="size-3.5" strokeWidth={1.85} />
                      </IconButton>

                      {favoritableSource && (
                        <IconButton
                          size="sm"
                          variant="ghost"
                          className="size-6 rounded-full hover:text-dl-danger"
                          label="收藏贴纸"
                          onClick={triggerFavoriteSticker}
                        >
                          <Heart className="size-3.5" strokeWidth={1.85} />
                        </IconButton>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            size="sm"
                            variant="ghost"
                            className="size-6 rounded-full"
                            label="更多消息操作"
                          >
                            <MoreHorizontal className="size-3.5" strokeWidth={1.9} />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align={isOwn ? "end" : "start"}
                          onQuickReaction={(emoji) =>
                            void toggleReaction(activeConv.id, msg.id, emoji)
                          }
                        >
                          <DropdownMenuItem
                            icon={<Reply className="size-4" strokeWidth={1.85} />}
                            onSelect={triggerStartReply}
                          >
                            引用回复
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={<MessageSquareText className="size-4" strokeWidth={1.85} />}
                            onSelect={() => openThreadInspector(msg.id)}
                          >
                            展开话题讨论
                          </DropdownMenuItem>
                          {msg.plainText && (
                            <DropdownMenuItem
                              icon={<Copy className="size-4" strokeWidth={1.85} />}
                              onSelect={() => void copyMessagePlainText(msg.plainText)}
                            >
                              复制消息内容
                            </DropdownMenuItem>
                          )}
                          {favoritableSource && (
                            <DropdownMenuItem
                              icon={<Heart className="size-4" strokeWidth={1.85} />}
                              onSelect={triggerFavoriteSticker}
                            >
                              收藏贴纸
                            </DropdownMenuItem>
                          )}
                          {isEditableTextMsg && (
                            <DropdownMenuItem
                              icon={<Pencil className="size-4" strokeWidth={1.85} />}
                              onSelect={triggerStartEdit}
                            >
                              编辑消息
                            </DropdownMenuItem>
                          )}
                          {isOwn && !msg.recalledAt && (
                            <DropdownMenuItem
                              icon={<RotateCcw className="size-4" strokeWidth={1.85} />}
                              onSelect={() => void recallWorkspaceMessage(activeConv.id, msg.id)}
                            >
                              撤回消息
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            icon={<Forward className="size-4" strokeWidth={1.85} />}
                            onSelect={triggerOpenForward}
                          >
                            转发消息
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={
                              isPinned ? (
                                <PinOff className="size-4" strokeWidth={1.85} />
                              ) : (
                                <Pin className="size-4" strokeWidth={1.85} />
                              )
                            }
                            onSelect={() => void togglePinMessage(activeConv.id, msg.id)}
                          >
                            {isPinned ? "取消置顶" : "置顶到对话顶部"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Floating Multi-line Vibrancy Composer */}
      <div className="relative px-5 max-compact:px-3 max-narrow:px-2.5 pb-4 max-narrow:pb-3 pt-1.5 space-y-1.5">
        {!isNearBottom && messages.length > 0 && (
          <div className="pointer-events-none absolute right-6 -top-10 z-20 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="scroll-to-bottom-btn"
              onClick={scrollToTimelineBottom}
              className="pointer-events-auto dl-glass-elevated h-8 gap-1.5 rounded-full border border-dl-border-hairline px-3 text-xs shadow-md"
            >
              <ArrowDown className="size-3.5 text-dl-lane-shared" strokeWidth={2} />
              <span>回到底部</span>
              {unreadBelowCount > 0 && (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-dl-lane-shared px-1 text-[10px] font-bold text-dl-on-shared">
                  {unreadBelowCount}
                </span>
              )}
            </Button>
          </div>
        )}

        {activeTypingText && (
          <div
            data-testid="timeline-typing-bar"
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 px-1.5 py-0.5 text-xs font-medium text-dl-lane-shared"
          >
            <span className="inline-flex items-center gap-0.5" aria-hidden="true">
              <span className="size-1.5 rounded-full bg-dl-lane-shared animate-bounce" />
              <span className="size-1.5 rounded-full bg-dl-lane-shared animate-bounce [animation-delay:140ms]" />
              <span className="size-1.5 rounded-full bg-dl-lane-shared animate-bounce [animation-delay:280ms]" />
            </span>
            <span className="truncate">{activeTypingText}</span>
          </div>
        )}

        {workspaceUploadError && (
          <div className="rounded-xl border border-dl-danger/30 bg-dl-danger/10 px-3 py-1.5 text-xs text-dl-danger">
            {workspaceUploadError}
          </div>
        )}

        {mentionAutocomplete && (
          <div
            data-testid="mention-autocomplete-popover"
            role="listbox"
            aria-label="选择要提及的成员"
            className="dl-glass-elevated max-h-56 overflow-y-auto rounded-2xl border border-dl-border-hairline p-1.5 shadow-lg space-y-0.5"
          >
            <div className="px-2 py-1 text-[11px] font-semibold text-dl-text-tertiary">
              提及会话成员
            </div>
            {mentionAutocomplete.items.map((item, itemIdx) => {
              const selected =
                itemIdx === mentionMenuIdx % Math.max(1, mentionAutocomplete.items.length);
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => applyMentionCandidate(item.displayName)}
                  className={cn(
                    "h-auto w-full justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs",
                    selected && "bg-dl-lane-shared/12 text-dl-lane-shared"
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {item.isAll ? (
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/15 text-dl-lane-shared">
                        <AtSign className="size-3.5" strokeWidth={2} />
                      </span>
                    ) : (
                      <Avatar
                        name={item.displayName}
                        src={item.avatarUrl}
                        kind={item.isBot ? "bot" : "human"}
                        size="sm"
                      />
                    )}
                    <span className="truncate font-semibold text-dl-text-primary">
                      {item.displayName}
                    </span>
                    {item.isBot && (
                      <span className="rounded-full bg-dl-lane-shared/14 px-1.5 py-0.5 text-[10px] font-semibold text-dl-lane-shared">
                        BOT
                      </span>
                    )}
                  </span>
                  {item.subtitle && (
                    <span className="truncate max-w-[180px] text-[11px] text-dl-text-tertiary">
                      {item.subtitle}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        )}

        {!mentionAutocomplete && slashAutocomplete && (
          <div
            data-testid="slash-autocomplete-popover"
            role="listbox"
            aria-label="选择机器人指令"
            className="dl-glass-elevated max-h-52 overflow-y-auto rounded-2xl border border-dl-border-hairline p-1.5 shadow-lg space-y-0.5"
          >
            <div className="px-2 py-1 text-[11px] font-semibold text-dl-text-tertiary">
              机器人快捷指令
            </div>
            {slashAutocomplete.items.map((cmd, cmdIdx) => {
              const selected =
                cmdIdx === slashMenuIdx % Math.max(1, slashAutocomplete.items.length);
              return (
                <Button
                  key={`${cmd.botId || "bot"}:${cmd.command}`}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => applySlashCandidate(cmd.command)}
                  className={cn(
                    "h-auto w-full justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs",
                    selected && "bg-dl-lane-shared/12 text-dl-lane-shared"
                  )}
                >
                  <span className="font-mono font-semibold text-dl-lane-shared">
                    /{cmd.command}
                  </span>
                  <span className="truncate text-[11px] text-dl-text-tertiary">
                    {cmd.botName ? `${cmd.botName} · ` : ""}
                    {cmd.description}
                  </span>
                </Button>
              );
            })}
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
            {pendingAttachments.map((att) => {
              const isThumb = safeInlineImageMime(att.mimeType) && Boolean(att.url);
              return (
                <div
                  key={att.id}
                  data-testid="pending-attachment-chip"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dl-border-hairline bg-dl-surface-elevated/90 px-2 py-1 text-xs text-dl-text-primary"
                >
                  {isThumb ? (
                    <img
                      src={att.url}
                      alt={att.fileName}
                      className="size-7 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <FileText
                      className="size-3.5 shrink-0 text-dl-lane-shared"
                      strokeWidth={1.85}
                    />
                  )}
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
              );
            })}
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

          {hasBotInConversation && (
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
                <div className="w-60 space-y-1 p-0.5">
                  <div className="px-2 py-1 text-[11px] font-semibold text-dl-text-tertiary">
                    机器人 Slash 指令
                  </div>
                  {effectiveSlashCommands.map((cmd) => (
                    <Button
                      key={`${cmd.botId || "bot"}:${cmd.command}`}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-between gap-2 text-xs"
                      onClick={() => applySlashCandidate(cmd.command)}
                    >
                      <span className="font-mono text-dl-lane-shared">/{cmd.command}</span>
                      <span className="truncate text-dl-text-tertiary">
                        {cmd.botName ? `${cmd.botName} · ` : ""}
                        {cmd.description}
                      </span>
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

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

          <EmoteStickerPopover
            lane="workspace"
            conversationId={activeConv.id}
            replyToId={replyToId}
            disabled={Boolean(editingMsg)}
            onInsertText={(t) => {
              const next = `${draft}${t}`;
              setDraft(activeConv.id, next, replyToId);
              setCursorPos(next.length);
              composerRef.current?.focus();
            }}
          />

          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            aria-label={`发送消息到 ${activeConv.title}`}
            onClick={(e) => setCursorPos(e.currentTarget.selectionStart || 0)}
            onSelect={(e) => setCursorPos(e.currentTarget.selectionStart || 0)}
            onPaste={(e) => {
              if (editingMsg) return;
              const files = Array.from(e.clipboardData?.files || []);
              if (files.length === 0) return;
              e.preventDefault();
              void uploadWorkspaceFiles(activeConv.id, files);
            }}
            onChange={(e) => {
              const val = e.target.value;
              setCursorPos(e.target.selectionStart ?? val.length);
              setMentionMenuIdx(0);
              setSlashMenuIdx(0);
              setDraft(activeConv.id, val, replyToId);
              if (val.trim()) {
                emitHumanTypingThrottled(activeConv.id, activeConv.kind);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;

              if (mentionAutocomplete && mentionAutocomplete.items.length > 0) {
                const count = mentionAutocomplete.items.length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionMenuIdx((i) => (i + 1) % count);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionMenuIdx((i) => (i - 1 + count) % count);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const chosen = mentionAutocomplete.items[mentionMenuIdx % count];
                  if (chosen) applyMentionCandidate(chosen.displayName);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedTriggerKey(mentionAutocomplete.triggerKey);
                  return;
                }
              }

              if (slashAutocomplete && slashAutocomplete.items.length > 0) {
                const count = slashAutocomplete.items.length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashMenuIdx((i) => (i + 1) % count);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashMenuIdx((i) => (i - 1 + count) % count);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const chosen = slashAutocomplete.items[slashMenuIdx % count];
                  if (chosen) applySlashCandidate(chosen.command);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedTriggerKey(slashAutocomplete.triggerKey);
                  return;
                }
              }

              if (e.key === "Escape" && (editingMsg || replyTarget)) {
                e.preventDefault();
                setReplyToId(undefined);
                setEditingMessageId(null);
                if (editingMsg) setDraft(activeConv.id, "");
                return;
              }

              if (
                e.key === "ArrowUp" &&
                !draft &&
                !editingMsg &&
                pendingAttachments.length === 0
              ) {
                const lastEditable = [...messages]
                  .reverse()
                  .find(
                    (m) =>
                      m.senderId === currentUser?.id &&
                      !m.recalledAt &&
                      !m.card &&
                      Boolean(m.plainText) &&
                      m.plainText !== "[文件]" &&
                      !m.blocks?.some(
                        (b) => b.type === "emoji" || b.type === "emote_collection"
                      )
                  );
                if (lastEditable) {
                  e.preventDefault();
                  setEditingMessageId(lastEditable.id);
                  setDraft(activeConv.id, lastEditable.plainText);
                  setCursorPos(lastEditable.plainText.length);
                  return;
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
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
