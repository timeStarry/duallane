import React, { useMemo, useState } from "react";
import { AtSign, Bookmark, Check, Plus, ShieldCheck } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

type FilterTab = "all" | "unread" | "mentions";

function formatShortTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function ConversationSidebar() {
  const { activeLane, mobileView, setMobileView } = useLaneStore();
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
      <aside
        className={cn(
          "dl-glass-chrome flex h-full w-[288px] shrink-0 flex-col border-r border-dl-border-hairline",
          "max-compact:flex-1 max-compact:w-auto max-compact:border-r-0",
          mobileView === "chat" && "max-compact:hidden"
        )}
      >
        <div className="flex items-center justify-between border-b border-dl-border-hairline px-4 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-dl-text-primary">私密直连</h2>
            <p className="text-[11px] font-medium text-dl-lane-direct">
              端到端加密 · 零服务端落盘
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="border-dl-lane-direct/35 bg-dl-lane-direct/15 text-dl-lane-direct hover:bg-dl-lane-direct/25"
            onClick={() => {
              void createP2PRoom();
              setMobileView("chat");
            }}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            新建房间
          </Button>
        </div>

        <div className="p-3 space-y-2">
          {p2pRoom ? (
            <Button
              variant="ghost"
              onClick={() => setMobileView("chat")}
              className="dl-glass-elevated h-auto w-full flex-col items-stretch rounded-2xl border border-dl-lane-direct/35 p-3 text-left"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                  <ShieldCheck className="size-3.5 text-dl-lane-direct" strokeWidth={2} />
                  房间 #{p2pRoom.roomId}
                </span>
                <span className="h-2 w-2 rounded-full bg-dl-lane-direct" />
              </div>
              <div className="mt-1 text-[11px] font-mono text-dl-text-tertiary">
                指纹 {p2pRoom.keyFingerprint}
              </div>
              {p2pDraft.trim() ? (
                <div className="mt-1.5 truncate text-xs">
                  <span className="font-medium text-dl-warning">[草稿] </span>
                  <span className="text-dl-text-secondary">{p2pDraft}</span>
                </div>
              ) : null}
            </Button>
          ) : (
            <div className="rounded-2xl border border-dashed border-dl-border-strong p-5 text-center text-xs leading-relaxed text-dl-text-secondary">
              点击右上角「新建房间」生成端到端加密直连链接，密钥仅保存在 URL <code className="font-mono text-dl-lane-direct">#k=</code> 与浏览器内存中。
            </div>
          )}
        </div>
      </aside>
    );
  }

  const selectableMembers = Object.values(members).filter((m) => m.id !== currentUser?.id);

  return (
    <aside
      className={cn(
        "dl-glass-chrome flex h-full w-[288px] shrink-0 flex-col border-r border-dl-border-hairline",
        "max-compact:flex-1 max-compact:w-auto max-compact:border-r-0",
        mobileView === "chat" && "max-compact:hidden"
      )}
    >
      <div className="space-y-2.5 border-b border-dl-border-hairline p-3">
        <div className="flex items-center justify-between px-0.5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-dl-text-primary">共享空间</h2>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-dl-text-secondary hover:text-dl-text-primary"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            新建群组
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

      <div className="dl-scroll flex-1 overflow-y-auto p-2 space-y-1">
        {visibleConversations.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-dl-text-tertiary">
            没有匹配的对话
          </div>
        ) : (
          visibleConversations.map((conv) => {
            const active = conv.id === activeConversationId;
            const draft = drafts[conv.id];
            const timeLabel = formatShortTime(conv.lastMessageAt);
            return (
              <Button
                key={conv.id}
                variant="ghost"
                onClick={() => {
                  selectConversation(conv.id);
                  setMobileView("chat");
                }}
                className={cn(
                  "w-full h-auto justify-start gap-2.5 rounded-2xl px-2.5 py-2.5 text-left transition-all",
                  active
                    ? "bg-dl-lane-shared/14 border border-dl-lane-shared/30 shadow-2xs"
                    : "hover:bg-dl-surface-subtle/75 border border-transparent"
                )}
              >
                {conv.kind === "saved" ? (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-dl-lane-shared/16 text-dl-lane-shared">
                    <Bookmark className="size-4" strokeWidth={1.9} />
                  </div>
                ) : (
                  <Avatar name={conv.title} size="md" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-dl-text-primary">
                      {conv.title}
                    </span>
                    {timeLabel && (
                      <span className="shrink-0 text-[10px] tabular-nums text-dl-text-tertiary">
                        {timeLabel}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-1.5">
                    <div className="truncate text-xs text-dl-text-secondary">
                      {draft?.text ? (
                        <>
                          <span className="font-semibold text-dl-warning">[草稿] </span>
                          <span>{draft.text}</span>
                        </>
                      ) : (
                        conv.lastMessageText || "暂无消息"
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {conv.mentionCount > 0 && (
                        <span
                          className="inline-flex h-[18px] items-center gap-0.5 rounded-full bg-dl-warning/18 px-1.5 text-[10px] font-semibold text-dl-warning"
                          title="有人 @提及你"
                        >
                          <AtSign className="size-2.5" strokeWidth={2.2} />
                        </span>
                      )}
                      {conv.unreadCount > 0 && (
                        <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-dl-lane-shared px-1.5 text-[10px] font-semibold text-dl-on-shared tabular-nums">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
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
            <DialogDescription>
              选择要加入的成员，创建后所有成员均可置顶消息与发起线程讨论。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateGroup} className="space-y-3 p-6 pt-4">
            <Input
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="群组名称，例如：产品设计与架构"
              required
            />
            <div className="dl-scroll max-h-48 overflow-y-auto space-y-1 rounded-xl border border-dl-border-hairline p-2">
              {selectableMembers.length === 0 ? (
                <div className="p-2 text-xs text-dl-text-tertiary">暂无其他空间成员</div>
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
                        checked && "bg-dl-lane-shared/12 text-dl-lane-shared"
                      )}
                    >
                      <span>{m.displayName}</span>
                      <span className="inline-flex items-center gap-1 text-xs">
                        {checked ? (
                          <>
                            <Check className="size-3.5" strokeWidth={2} />
                            已选
                          </>
                        ) : (
                          "选择"
                        )}
                      </span>
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
