import React, { useMemo, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { Avatar, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, SegmentedControl } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

type FilterTab = "all" | "unread" | "mentions";

export function ConversationSidebar() {
  const { activeLane } = useLaneStore();
  const {
    conversations,
    conversationOrder,
    activeConversationId,
    selectConversation,
    drafts,
    members,
    currentUser,
    bootstrapWorkspace,
    p2pRoom,
    createP2PRoom,
    p2pDraft,
  } = useWorkspaceStore();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const visibleConversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversationOrder
      .map((id) => conversations[id])
      .filter(Boolean)
      .filter((conv) => {
        if (filter === "unread" && conv.unreadCount === 0) return false;
        if (filter === "mentions" && conv.mentionCount === 0) return false;
        if (q && !conv.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.kind === "saved" && b.kind !== "saved") return -1;
        if (b.kind === "saved" && a.kind !== "saved") return 1;
        return 0;
      });
  }, [conversationOrder, conversations, filter, query]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupTitle.trim()) return;
    setCreating(true);
    try {
      await apiV1.createGroupConversation(groupTitle.trim(), selectedMemberIds);
      setGroupTitle("");
      setSelectedMemberIds([]);
      setCreateOpen(false);
      await bootstrapWorkspace();
    } finally {
      setCreating(false);
    }
  };

  if (activeLane === "p2p") {
    return (
      <aside className="dl-glass-chrome flex h-full w-[280px] shrink-0 flex-col border-r border-dl-border-hairline">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-dl-border-hairline">
          <div>
            <h2 className="text-sm font-semibold text-dl-text-primary">私密直连</h2>
            <p className="text-[11px] text-dl-lane-direct">端到端加密 · 零服务端落盘</p>
          </div>
          <Button size="sm" variant="primary" onClick={() => void createP2PRoom()}>
            新建房间
          </Button>
        </div>

        <div className="p-3 space-y-2">
          {p2pRoom ? (
            <div className="dl-glass-elevated rounded-2xl p-3 border border-dl-lane-direct/30">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-dl-text-primary">
                  房间 #{p2pRoom.roomId}
                </span>
                <span className="h-2 w-2 rounded-full bg-dl-lane-direct" />
              </div>
              <div className="mt-1 text-[11px] font-mono text-dl-text-tertiary">
                指纹 {p2pRoom.keyFingerprint}
              </div>
              {p2pDraft.trim() ? (
                <div className="mt-1.5 text-xs truncate">
                  <span className="text-dl-warning font-medium">[草稿] </span>
                  <span className="text-dl-text-secondary">{p2pDraft}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-dl-border-hairline p-4 text-center text-xs text-dl-text-tertiary">
              点击右上角「新建房间」生成端到端加密直连链接，密钥仅保存在 URL `#k=` 与浏览器内存中。
            </div>
          )}
        </div>
      </aside>
    );
  }

  const selectableMembers = Object.values(members).filter((m) => m.id !== currentUser?.id);

  return (
    <aside className="dl-glass-chrome flex h-full w-[280px] shrink-0 flex-col border-r border-dl-border-hairline">
      <div className="p-3 space-y-2.5 border-b border-dl-border-hairline">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-dl-text-primary">共享空间</h2>
          <Button size="sm" variant="ghost" onClick={() => setCreateOpen(true)}>
            ＋ 新建群组
          </Button>
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选对话…"
          aria-label="筛选对话"
        />

        <SegmentedControl
          label="筛选对话"
          value={filter}
          onValueChange={(v) => setFilter(v as FilterTab)}
          options={[
            { value: "all", label: "全部" },
            { value: "unread", label: "未读" },
            { value: "mentions", label: "@我" },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {visibleConversations.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-dl-text-tertiary">
            没有匹配的对话
          </div>
        ) : (
          visibleConversations.map((conv) => {
            const active = conv.id === activeConversationId;
            const draft = drafts[conv.id];
            return (
              <Button
                key={conv.id}
                variant="ghost"
                onClick={() => selectConversation(conv.id)}
                className={cn(
                  "w-full h-auto justify-start gap-2.5 rounded-2xl px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-dl-lane-shared/12 border border-dl-lane-shared/25"
                    : "hover:bg-dl-surface-subtle/60 border border-transparent"
                )}
              >
                {conv.kind === "saved" ? (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/15 text-base">
                    🔖
                  </div>
                ) : (
                  <Avatar name={conv.title} size="md" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-xs font-semibold text-dl-text-primary">
                      {conv.title}
                    </span>
                    {conv.unreadCount > 0 && (
                      <span className="shrink-0 rounded-full bg-dl-lane-shared px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                        {conv.unreadCount}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-dl-text-secondary">
                    {draft?.text ? (
                      <>
                        <span className="font-medium text-dl-warning">[草稿] </span>
                        <span>{draft.text}</span>
                      </>
                    ) : (
                      conv.lastMessageText || "暂无消息"
                    )}
                  </div>
                </div>
              </Button>
            );
          })
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建群组对话</DialogTitle>
            <DialogDescription>选择要加入的成员，创建后所有成员均可置顶消息与发起线程讨论。</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateGroup} className="space-y-3 p-6 pt-4">
          <Input
            value={groupTitle}
            onChange={(e) => setGroupTitle(e.target.value)}
            placeholder="群组名称，例如：产品设计与架构"
            required
          />
          <div className="max-h-48 overflow-y-auto space-y-1 rounded-xl border border-dl-border-hairline p-2">
            {selectableMembers.length === 0 ? (
              <div className="text-xs text-dl-text-tertiary p-2">暂无其他空间成员</div>
            ) : (
              selectableMembers.map((m) => {
                const checked = selectedMemberIds.includes(m.id);
                return (
                  <Button
                    key={m.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSelectedMemberIds((prev) =>
                        checked ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                      )
                    }
                    className={cn(
                      "w-full justify-between rounded-xl px-2.5",
                      checked && "bg-dl-lane-shared/10 text-dl-lane-shared"
                    )}
                  >
                    <span>{m.displayName}</span>
                    <span>{checked ? "✓ 已选" : "选择"}</span>
                  </Button>
                );
              })
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" busy={creating}>
              创建群组
            </Button>
          </div>
        </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
