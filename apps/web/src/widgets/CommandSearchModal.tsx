import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, FileText, Search, ShieldCheck } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type SearchResponse } from "@/shared/lib/api-v1";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/shared/ui";

export function CommandSearchModal() {
  const { searchOpen, setSearchOpen, setActiveLane, setMobileView } = useLaneStore();
  const {
    isPreviewMode,
    authStatus,
    conversations,
    messagesByConv,
    jumpToMessage,
    p2pRoom,
    p2pMessages,
  } = useWorkspaceStore();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchSource, setSearchSource] = useState<"remote" | "local">("local");
  const [results, setResults] = useState<SearchResponse>({ messages: [], files: [] });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(!searchOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, setSearchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const trimmed = query.trim();
    if (!trimmed) return;

    const searchLocally = (): SearchResponse => {
      const q = trimmed.toLowerCase();
      const msgHits: SearchResponse["messages"] = [];
      const fileHits: SearchResponse["files"] = [];
      for (const [convId, list] of Object.entries(messagesByConv || {})) {
        if (!Array.isArray(list)) continue;
        for (const m of list) {
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
    };

    let cancelled = false;
    const timer = setTimeout(() => {
      if (isPreviewMode || authStatus !== "authenticated") {
        setSearchSource("local");
        setResults(searchLocally());
        return;
      }
      setLoading(true);
      void apiV1
        .search(trimmed)
        .then((res) => {
          if (cancelled) return;
          setSearchSource("remote");
          setResults({
            messages: Array.isArray(res?.messages) ? res.messages : [],
            files: Array.isArray(res?.files) ? res.files : [],
          });
        })
        .catch(() => {
          if (cancelled) return;
          setSearchSource("local");
          setResults(searchLocally());
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authStatus, isPreviewMode, messagesByConv, query, searchOpen]);

  const p2pHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !Array.isArray(p2pMessages)) return [];
    return p2pMessages.filter((m) => (m.text || "").toLowerCase().includes(q));
  }, [p2pMessages, query]);

  const messageHits = Array.isArray(results?.messages) ? results.messages : [];
  const fileHits = Array.isArray(results?.files) ? results.files : [];

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <div className="flex items-center justify-between pr-8">
            <DialogTitle className="flex items-center gap-2">
              <Search className="size-4 text-dl-lane-shared" strokeWidth={2} />
              全局搜索
              <span className="rounded-full bg-dl-surface-subtle px-2 py-0.5 text-[10px] font-medium text-dl-text-secondary">
                {searchSource === "remote" && authStatus === "authenticated"
                  ? "服务端全文检索"
                  : "本机内存检索"}
              </span>
            </DialogTitle>
            <kbd className="dl-kbd">ESC</kbd>
          </div>
          <DialogDescription>
            搜索共享空间消息正文、附件文件与当前私密直连内存记录，点击结果直接定位原上下文。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 p-6 pt-4">
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              const val = e.target.value;
              setQuery(val);
              if (!val.trim()) setResults({ messages: [], files: [] });
            }}
            placeholder="输入关键词、文件名或指令…"
          />

          {loading && <div className="text-xs text-dl-text-tertiary">正在搜索…</div>}

          <div className="dl-scroll max-h-80 overflow-y-auto space-y-4">
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
                      <div className="truncate text-sm text-dl-text-primary">{hit.text}</div>
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
                    variant="ghost"
                    className="w-full h-auto justify-between rounded-xl px-3 py-2.5 text-left"
                    onClick={() => {
                      setActiveLane("workspace");
                      setMobileView("chat");
                      jumpToMessage(hit.conversationId, hit.id);
                      setSearchOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-dl-lane-shared">
                        {conversations[hit.conversationId]?.title || hit.conversationId} ·{" "}
                        {hit.authorName || hit.authorId}
                      </div>
                      <div className="truncate text-sm text-dl-text-primary">{hit.plainText}</div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      跳转
                      <ArrowUpRight className="size-3" strokeWidth={2} />
                    </span>
                  </Button>
                ))}
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
                    variant="ghost"
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
                          {att.fileName}
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">{att.mimeType}</div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                      {att.sourceMessageId ? "定位原消息" : "无来源"}
                      {att.sourceMessageId && <ArrowUpRight className="size-3" strokeWidth={2} />}
                    </span>
                  </Button>
                ))}
              </div>
            )}

            {!loading &&
              query.trim() &&
              p2pHits.length === 0 &&
              messageHits.length === 0 &&
              fileHits.length === 0 && (
                <div className="py-8 text-center text-xs text-dl-text-tertiary">
                  没有找到匹配的消息或文件
                </div>
              )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
