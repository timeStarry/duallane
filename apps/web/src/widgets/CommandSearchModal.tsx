import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, FileText, Hash, Search, ShieldCheck, User, X } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type SearchResponse } from "@/shared/lib/api-v1";
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/shared/ui";

type SearchScopeTab = "all" | "messages" | "files";
const PAGE_SIZE = 20;

function formatSearchTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return sameYear ? `${mon}-${day} ${hh}:${mm}` : `${d.getFullYear()}-${mon}-${day}`;
}

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length <= 1) return text;
  const lowerQ = q.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === lowerQ ? (
      <mark
        key={idx}
        className="rounded bg-amber-300/40 px-0.5 text-inherit dark:bg-amber-400/30"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    )
  );
}

export function CommandSearchModal() {
  const {
    activeLane,
    searchOpen,
    searchConversationId,
    setSearchOpen,
    openSearchInConversation,
    setActiveLane,
    setMobileView,
    openProfileModal,
  } = useLaneStore();
  const {
    isPreviewMode,
    authStatus,
    currentUser,
    members,
    conversations,
    conversationOrder,
    activeConversationId,
    messagesByConv,
    selectConversation,
    jumpToMessage,
    p2pRoom,
    p2pMessages,
  } = useWorkspaceStore();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScopeTab>("all");
  const scopedConvId = searchConversationId;
  const setScopedConvId = (id: string | null) => openSearchInConversation(id);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState<SearchResponse>({ messages: [], files: [] });
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [hasMoreFiles, setHasMoreFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
        } else {
          openSearchInConversation(null);
        }
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "f" &&
        activeLane === "workspace" &&
        activeConversationId
      ) {
        e.preventDefault();
        openSearchInConversation(activeConversationId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeConversationId, activeLane, openSearchInConversation, searchOpen, setSearchOpen]);

  const searchLocally = useCallback(
    (trimmed: string, targetConvId: string | null): SearchResponse => {
      const q = trimmed.toLowerCase();
      const msgHits: SearchResponse["messages"] = [];
      const fileHits: SearchResponse["files"] = [];
      for (const [convId, list] of Object.entries(messagesByConv || {})) {
        if (targetConvId && convId !== targetConvId) continue;
        if (!Array.isArray(list)) continue;
        for (const m of list) {
          if (m.recalledAt) continue;
          if ((m.plainText || "").toLowerCase().includes(q)) {
            msgHits.push({
              id: m.id,
              conversationId: convId,
              authorId: m.senderId,
              authorName: m.senderName,
              plainText: m.plainText,
              createdAt: m.createdAt,
            });
          }
          for (const att of m.attachments || []) {
            if ((att.fileName || "").toLowerCase().includes(q)) {
              fileHits.push({
                id: att.id,
                fileName: att.fileName,
                mimeType: att.mimeType,
                byteSize: att.byteSize,
                conversationId: convId,
                sourceMessageId: m.id,
                createdAt: m.createdAt,
              });
            }
          }
        }
      }
      return { messages: msgHits, files: fileHits };
    },
    [messagesByConv]
  );

  useEffect(() => {
    if (!searchOpen) return;
    const trimmed = query.trim();
    if (!trimmed) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (isPreviewMode || authStatus !== "authenticated") {
        setResults(searchLocally(trimmed, scopedConvId));
        setHasMoreMessages(false);
        setHasMoreFiles(false);
        return;
      }
      setLoading(true);
      void apiV1
        .search(trimmed, scope, {
          conversationId: scopedConvId || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        })
        .then((res) => {
          if (cancelled) return;
          const msgs = Array.isArray(res?.messages) ? res.messages : [];
          const files = Array.isArray(res?.files) ? res.files : [];
          setResults({ messages: msgs, files });
          setHasMoreMessages(msgs.length >= PAGE_SIZE);
          setHasMoreFiles(files.length >= PAGE_SIZE);
          setActiveIndex(0);
        })
        .catch(() => {
          if (cancelled) return;
          setResults(searchLocally(trimmed, scopedConvId));
          setHasMoreMessages(false);
          setHasMoreFiles(false);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authStatus, isPreviewMode, query, scope, scopedConvId, searchLocally, searchOpen]);

  const handleLoadMore = async (kind: "messages" | "files") => {
    const trimmed = query.trim();
    if (!trimmed || loadingMore) return;
    const offset = kind === "messages" ? results.messages.length : results.files.length;
    setLoadingMore(true);
    try {
      const res = await apiV1.search(trimmed, kind, {
        conversationId: scopedConvId || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      if (kind === "messages") {
        const next = Array.isArray(res?.messages) ? res.messages : [];
        setResults((prev) => {
          const seen = new Set(prev.messages.map((m) => m.id));
          return {
            ...prev,
            messages: [...prev.messages, ...next.filter((m) => !seen.has(m.id))],
          };
        });
        setHasMoreMessages(next.length >= PAGE_SIZE);
      } else {
        const next = Array.isArray(res?.files) ? res.files : [];
        setResults((prev) => {
          const seen = new Set(prev.files.map((f) => f.id));
          return {
            ...prev,
            files: [...prev.files, ...next.filter((f) => !seen.has(f.id))],
          };
        });
        setHasMoreFiles(next.length >= PAGE_SIZE);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  // Instant local Contacts & Conversations hits (only when not scoped to a single conversation)
  const { contactHits, conversationHits } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || scopedConvId || scope !== "all") {
      return { contactHits: [], conversationHits: [] };
    }
    const contacts = Object.values(members)
      .filter((m) => m.id !== currentUser?.id)
      .filter(
        (m) =>
          (m.displayName || "").toLowerCase().includes(q) ||
          (m.remark || "").toLowerCase().includes(q) ||
          (m.nickname || "").toLowerCase().includes(q) ||
          (m.handle || "").toLowerCase().includes(q)
      )
      .slice(0, 6);
    const convs = conversationOrder
      .map((id) => conversations[id])
      .filter((c): c is NonNullable<typeof c> => Boolean(c && c.kind === "group"))
      .filter((c) => c.title.toLowerCase().includes(q))
      .slice(0, 5);
    return { contactHits: contacts, conversationHits: convs };
  }, [conversationOrder, conversations, currentUser?.id, members, query, scope, scopedConvId]);

  const p2pHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || scopedConvId || !Array.isArray(p2pMessages)) return [];
    return p2pMessages.filter(
      (m) =>
        (m.text || "").toLowerCase().includes(q) ||
        (m.attachment?.fileName || "").toLowerCase().includes(q)
    );
  }, [p2pMessages, query, scopedConvId]);

  const messageHits = useMemo(
    () => (Array.isArray(results?.messages) ? results.messages : []),
    [results]
  );
  const fileHits = useMemo(
    () => (Array.isArray(results?.files) ? results.files : []),
    [results]
  );

  // Flat list of navigable actions for keyboard ArrowUp/Down + Enter
  const flatActions = useMemo(() => {
    const list: Array<{ id: string; run: () => void }> = [];
    for (const c of contactHits) {
      list.push({
        id: `contact-${c.id}`,
        run: () => {
          setSearchOpen(false);
          openProfileModal(c.id);
        },
      });
    }
    for (const conv of conversationHits) {
      list.push({
        id: `conv-${conv.id}`,
        run: () => {
          setActiveLane("workspace");
          setMobileView("chat");
          selectConversation(conv.id);
          setSearchOpen(false);
        },
      });
    }
    for (const hit of messageHits) {
      list.push({
        id: `msg-${hit.id}`,
        run: () => {
          setActiveLane("workspace");
          setMobileView("chat");
          jumpToMessage(hit.conversationId, hit.id);
          setSearchOpen(false);
        },
      });
    }
    for (const att of fileHits) {
      if (att.conversationId && att.sourceMessageId) {
        list.push({
          id: `file-${att.id}`,
          run: () => {
            setActiveLane("workspace");
            setMobileView("chat");
            jumpToMessage(att.conversationId!, att.sourceMessageId!);
            setSearchOpen(false);
          },
        });
      }
    }
    return list;
  }, [
    contactHits,
    conversationHits,
    fileHits,
    jumpToMessage,
    messageHits,
    openProfileModal,
    selectConversation,
    setActiveLane,
    setMobileView,
    setSearchOpen,
  ]);

  const activeItemId = flatActions[activeIndex]?.id;
  const scopedConv = scopedConvId ? conversations[scopedConvId] : undefined;

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-8 max-narrow:pr-4">
            <DialogTitle className="flex items-center gap-2">
              <Search className="size-4 shrink-0 text-dl-lane-shared" strokeWidth={2} />
              <span>{scopedConv ? `搜索「${scopedConv.title}」` : "全局搜索"}</span>
            </DialogTitle>
            <div className="flex items-center gap-1.5 max-narrow:hidden">
              <kbd className="dl-kbd">↑↓</kbd>
              <kbd className="dl-kbd">↵</kbd>
              <kbd className="dl-kbd">ESC</kbd>
            </div>
          </div>
          <DialogDescription className="sr-only">搜索联系人、群聊、消息与附件</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-6 max-narrow:p-3.5 pt-3">
          <div className="space-y-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                const val = e.target.value;
                setQuery(val);
                if (!val.trim()) setResults({ messages: [], files: [] });
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && flatActions.length > 0) {
                  e.preventDefault();
                  setActiveIndex((prev) => (prev + 1) % flatActions.length);
                } else if (e.key === "ArrowUp" && flatActions.length > 0) {
                  e.preventDefault();
                  setActiveIndex((prev) => (prev - 1 + flatActions.length) % flatActions.length);
                } else if (e.key === "Enter" && flatActions[activeIndex]) {
                  e.preventDefault();
                  flatActions[activeIndex].run();
                }
              }}
              placeholder={
                scopedConv
                  ? `在「${scopedConv.title}」中搜索消息或文件…`
                  : "搜索联系人、群聊、消息或文件名…"
              }
              aria-label="搜索关键词"
            />

            {/* Scope tabs + In-chat scope toggle */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: "all", label: "全部" },
                    { id: "messages", label: "消息" },
                    { id: "files", label: "文件" },
                  ] as const
                ).map((tab) => (
                  <Button
                    key={tab.id}
                    type="button"
                    variant={scope === tab.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setScope(tab.id)}
                  >
                    {tab.label}
                  </Button>
                ))}
              </div>

              {scopedConv ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 rounded-full bg-dl-lane-shared/10 px-2.5 text-xs text-dl-lane-shared"
                  onClick={() => setScopedConvId(null)}
                >
                  <span className="max-w-36 truncate">仅：{scopedConv.title}</span>
                  <X className="size-3" />
                </Button>
              ) : activeConversationId && conversations[activeConversationId] ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs text-dl-text-tertiary hover:text-dl-text-primary"
                  onClick={() => setScopedConvId(activeConversationId)}
                >
                  限定当前会话
                </Button>
              ) : null}
            </div>
          </div>

          {loading && <div className="text-xs text-dl-text-tertiary">正在搜索…</div>}

          <div className="dl-scroll max-h-96 overflow-y-auto space-y-4">
            {contactHits.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-dl-text-tertiary">
                  联系人 ({contactHits.length})
                </div>
                {contactHits.map((m) => (
                  <Button
                    key={m.id}
                    variant={activeItemId === `contact-${m.id}` ? "secondary" : "ghost"}
                    className="w-full h-auto justify-between rounded-xl px-3 py-2 text-left"
                    onClick={() => {
                      setSearchOpen(false);
                      openProfileModal(m.id);
                    }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <Avatar
                        name={m.displayName}
                        src={m.avatarUrl}
                        color={m.avatarColor}
                        kind={m.role === "bot" ? "bot" : "human"}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-dl-text-primary">
                          {renderHighlightedText(m.displayName, query)}
                        </div>
                        {m.handle && (
                          <div className="truncate text-[11px] text-dl-text-tertiary">
                            @{renderHighlightedText(m.handle, query)}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      <User className="size-3" />
                      名片
                    </span>
                  </Button>
                ))}
              </div>
            )}

            {conversationHits.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-dl-text-tertiary">
                  群聊 ({conversationHits.length})
                </div>
                {conversationHits.map((conv) => (
                  <Button
                    key={conv.id}
                    variant={activeItemId === `conv-${conv.id}` ? "secondary" : "ghost"}
                    className="w-full h-auto justify-between rounded-xl px-3 py-2 text-left"
                    onClick={() => {
                      setActiveLane("workspace");
                      setMobileView("chat");
                      selectConversation(conv.id);
                      setSearchOpen(false);
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Hash className="size-4 shrink-0 text-dl-lane-shared" />
                      <span className="truncate text-sm font-medium text-dl-text-primary">
                        {renderHighlightedText(conv.title, query)}
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      打开
                      <ArrowUpRight className="size-3" strokeWidth={2} />
                    </span>
                  </Button>
                ))}
              </div>
            )}

            {p2pHits.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-dl-lane-direct">
                  私密直连内存消息 ({p2pHits.length})
                </div>
                {p2pHits.map((hit) => (
                  <Button
                    key={hit.id}
                    variant="ghost"
                    className="w-full h-auto justify-between rounded-xl px-3 py-2.5 text-left"
                    onClick={() => {
                      setActiveLane("p2p");
                      setMobileView("chat");
                      setSearchOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 text-xs font-semibold text-dl-lane-direct">
                        <ShieldCheck className="size-3" strokeWidth={2} />
                        {p2pRoom ? `房间 #${p2pRoom.roomId}` : "私密直连"} · {hit.senderName}
                      </div>
                      <div className="truncate text-sm text-dl-text-primary">
                        {renderHighlightedText(hit.text, query)}
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      查看
                      <ArrowUpRight className="size-3" strokeWidth={2} />
                    </span>
                  </Button>
                ))}
              </div>
            )}

            {messageHits.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-dl-text-tertiary">
                  消息 ({messageHits.length})
                </div>
                {messageHits.map((hit) => (
                  <Button
                    key={hit.id}
                    variant={activeItemId === `msg-${hit.id}` ? "secondary" : "ghost"}
                    className="w-full h-auto justify-between rounded-xl px-3 py-2.5 text-left"
                    onClick={() => {
                      setActiveLane("workspace");
                      setMobileView("chat");
                      jumpToMessage(hit.conversationId, hit.id);
                      setSearchOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-semibold text-dl-lane-shared">
                          {conversations[hit.conversationId]?.title || hit.conversationId} ·{" "}
                          {hit.authorName || hit.authorId}
                        </span>
                        <span className="shrink-0 text-[10px] text-dl-text-tertiary tabular-nums">
                          {formatSearchTime(hit.createdAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-dl-text-primary">
                        {renderHighlightedText(hit.plainText, query)}
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      跳转
                      <ArrowUpRight className="size-3" strokeWidth={2} />
                    </span>
                  </Button>
                ))}
                {hasMoreMessages && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs text-dl-lane-shared"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore("messages")}
                  >
                    {loadingMore ? "加载中…" : "加载更多消息"}
                  </Button>
                )}
              </div>
            )}

            {fileHits.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-dl-text-tertiary">
                  文件与媒体 ({fileHits.length})
                </div>
                {fileHits.map((att) => (
                  <Button
                    key={att.id}
                    variant={activeItemId === `file-${att.id}` ? "secondary" : "ghost"}
                    className="w-full h-auto justify-between rounded-xl px-3 py-2.5 text-left"
                    disabled={!att.conversationId || !att.sourceMessageId}
                    onClick={() => {
                      if (att.conversationId && att.sourceMessageId) {
                        setActiveLane("workspace");
                        setMobileView("chat");
                        jumpToMessage(att.conversationId, att.sourceMessageId);
                        setSearchOpen(false);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <FileText className="size-4 shrink-0 text-dl-lane-shared" strokeWidth={1.8} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-dl-text-primary">
                          {renderHighlightedText(att.fileName, query)}
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">
                          {att.mimeType} · {formatSearchTime(att.createdAt)}
                        </div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      {att.sourceMessageId ? "定位原消息" : "无来源"}
                      {att.sourceMessageId && <ArrowUpRight className="size-3" strokeWidth={2} />}
                    </span>
                  </Button>
                ))}
                {hasMoreFiles && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs text-dl-lane-shared"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore("files")}
                  >
                    {loadingMore ? "加载中…" : "加载更多文件"}
                  </Button>
                )}
              </div>
            )}

            {!loading &&
              query.trim() &&
              contactHits.length === 0 &&
              conversationHits.length === 0 &&
              p2pHits.length === 0 &&
              messageHits.length === 0 &&
              fileHits.length === 0 && (
                <div className="py-8 text-center text-xs text-dl-text-tertiary">
                  没有找到匹配的结果
                </div>
              )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
