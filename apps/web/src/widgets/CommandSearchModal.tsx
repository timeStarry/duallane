import React, { useEffect, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type SearchResponse } from "@/shared/lib/api-v1";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@/shared/ui";

export function CommandSearchModal() {
  const { searchOpen, setSearchOpen } = useLaneStore();
  const { conversations, jumpToMessage } = useWorkspaceStore();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse>({ messages: [], attachments: [] });

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
    if (!trimmed) {
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      void apiV1
        .search(trimmed)
        .then(setResults)
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [query, searchOpen]);

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>全局搜索</DialogTitle>
          <DialogDescription>搜索共享空间消息正文与附件文件，点击结果直接跳转。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 p-6 pt-4">
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            const val = e.target.value;
            setQuery(val);
            if (!val.trim()) setResults({ messages: [], attachments: [] });
          }}
          placeholder="输入关键词、文件名或指令…"
        />

        {loading && <div className="text-xs text-dl-text-tertiary">正在搜索…</div>}

        <div className="max-h-80 overflow-y-auto space-y-4">
          {results.messages.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-dl-text-tertiary">
                消息 ({results.messages.length})
              </div>
              {results.messages.map((hit) => (
                <Button
                  key={hit.id}
                  variant="ghost"
                  className="w-full h-auto justify-between rounded-xl px-3 py-2 text-left"
                  onClick={() => {
                    jumpToMessage(hit.conversationId, hit.id);
                    setSearchOpen(false);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-dl-lane-shared">
                      {conversations[hit.conversationId]?.title || hit.conversationId}
                    </div>
                    <div className="truncate text-sm text-dl-text-primary">{hit.plainText}</div>
                  </div>
                  <span className="text-[11px] text-dl-text-tertiary shrink-0 ml-2">跳转</span>
                </Button>
              ))}
            </div>
          )}

          {results.attachments.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-dl-text-tertiary">
                文件与媒体 ({results.attachments.length})
              </div>
              {results.attachments.map((att) => (
                <Button
                  key={att.id}
                  variant="ghost"
                  className="w-full h-auto justify-between rounded-xl px-3 py-2 text-left"
                  disabled={!att.conversationId || !att.sourceMessageId}
                  onClick={() => {
                    if (att.conversationId && att.sourceMessageId) {
                      jumpToMessage(att.conversationId, att.sourceMessageId);
                      setSearchOpen(false);
                    }
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-dl-text-primary">
                      📎 {att.fileName}
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary">{att.mimeType}</div>
                  </div>
                  <span className="text-[11px] text-dl-text-tertiary shrink-0 ml-2">
                    {att.sourceMessageId ? "定位原消息" : "无来源"}
                  </span>
                </Button>
              ))}
            </div>
          )}

          {!loading && query.trim() && results.messages.length === 0 && results.attachments.length === 0 && (
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
