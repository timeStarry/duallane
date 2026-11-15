import React, { useMemo, useState } from "react";
import {
  AtSign,
  Bookmark,
  Check,
  LogOut,
  Pin,
  PinOff,
  Plus,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

type FilterTab = "all" | "unread" | "mentions";
const GROUP_EMOJI_PRESETS = ["🚀", "💡", "🎨", "🛠️", "📌", "⚡", "🌿", "🎯"];

function formatShortTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function ConversationSidebar() {
  const { activeLane, mobileView, setMobileView, openDetailsInspector } = useLaneStore();
  const {
    conversations,
    conversationOrder,
    pinnedConversationIds,
    activeConversationId,
    selectConversation,
    togglePinConversation,
    createGroup,
    leaveGroup,
    drafts,
    members,
    currentUser,
    p2pRoom,
    createP2PRoom,
    leaveP2PRoom,
    p2pDraft,
  } = useWorkspaceStore();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupEmoji, setGroupEmoji] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

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
        const aPinIdx = pinnedConversationIds.indexOf(a.id);
        const bPinIdx = pinnedConversationIds.indexOf(b.id);
        const aPinned = aPinIdx !== -1;
        const bPinned = bPinIdx !== -1;
        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;
        if (aPinned && bPinned) return aPinIdx - bPinIdx;
        return 0;
      });
  }, [conversationOrder, conversations, filter, pinnedConversationIds, query]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupTitle.trim()) return;
    if (selectedMemberIds.length === 0) {
      setCreateError("请至少选择 1 位空间成员");
      return;
    }
    setCreateError("");
    setCreating(true);
    try {
      await createGroup(groupTitle.trim(), selectedMemberIds, groupEmoji || undefined);
      setGroupTitle("");
      setGroupEmoji("");
      setSelectedMemberIds([]);
      setCreateOpen(false);
      setMobileView("chat");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建群聊失败");
    } finally {
      setCreating(false);
    }
  };

  if (activeLane === "p2p") {
    return (
      <aside
        aria-label="私密直连会话列表"
        className={cn(
          "dl-glass-chrome flex h-full w-[288px] shrink-0 flex-col border-r border-dl-border-hairline",
          "max-compact:flex-1 max-compact:min-h-0 max-compact:w-full max-compact:border-r-0",
          mobileView === "chat" && "max-compact:hidden"
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-dl-border-hairline px-4 max-narrow:px-3 py-3.5">
          <h2 className="truncate text-sm font-semibold text-dl-text-primary">私密直连</h2>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0 border-dl-lane-direct/35 bg-dl-lane-direct/15 text-dl-lane-direct hover:bg-dl-lane-direct/25"
            onClick={() => {
              setMobileView("chat");
              void createP2PRoom();
            }}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            新建房间
          </Button>
        </div>

        <div className="dl-scroll flex-1 overflow-y-auto p-3 space-y-2.5">
          {p2pRoom ? (
            <div className="dl-glass-elevated rounded-2xl border border-dl-lane-direct/35 p-3 space-y-2.5">
              <Button
                variant="ghost"
                onClick={() => setMobileView("chat")}
                className="h-auto w-full flex-col items-stretch rounded-xl p-1 text-left"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary min-w-0">
                    <ShieldCheck className="size-3.5 shrink-0 text-dl-lane-direct" strokeWidth={2} />
                    <span className="truncate">房间 #{p2pRoom.roomId}</span>
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      p2pRoom.status === "peer_connected"
                        ? "bg-dl-success/16 text-dl-success"
                        : p2pRoom.status === "waiting_peer" || p2pRoom.status === "connecting"
                          ? "bg-dl-warning/16 text-dl-warning"
                          : "bg-dl-danger/14 text-dl-danger"
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        p2pRoom.status === "peer_connected"
                          ? "bg-dl-success"
                          : p2pRoom.status === "waiting_peer" || p2pRoom.status === "connecting"
                            ? "bg-dl-warning"
                            : "bg-dl-danger"
                      )}
                    />
                    {p2pRoom.status === "peer_connected"
                      ? "对端已连接 2/2"
                      : p2pRoom.status === "waiting_peer"
                        ? "等待对端 1/2"
                        : p2pRoom.status === "connecting"
                          ? "连接信令中"
                          : p2pRoom.status === "room_full"
                            ? "房间已满"
                            : p2pRoom.status === "room_not_found"
                              ? "房间已过期"
                              : "信令未连接"}
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] font-mono text-dl-text-tertiary">
                  指纹 {p2pRoom.keyFingerprint}
                </div>
                {p2pDraft.trim() ? (
                  <div className="mt-1.5 truncate text-xs">
                    <span className="font-medium text-dl-warning">[草稿] </span>
                    <span className="text-dl-text-secondary">{p2pDraft}</span>
                  </div>
                ) : null}
              </Button>

              <div className="flex items-center justify-end border-t border-dl-border-hairline pt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 px-2.5 text-xs text-dl-danger hover:bg-dl-danger/10"
                  onClick={() => {
                    leaveP2PRoom();
                    setMobileView("list");
                  }}
                >
                  <LogOut className="size-3.5" strokeWidth={1.9} />
                  退出并销毁房间
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-dl-border-strong p-5 text-center text-xs leading-relaxed text-dl-text-secondary">
              点击「新建房间」生成邀请链接
            </div>
          )}
        </div>
      </aside>
    );
  }

  const selectableMembers = Object.values(members).filter(
    (m) => m.id !== currentUser?.id && m.role !== "bot"
  );

  return (
    <aside
      aria-label="共享空间对话列表"
      className={cn(
        "dl-glass-chrome flex h-full w-[288px] shrink-0 flex-col border-r border-dl-border-hairline",
        "max-compact:flex-1 max-compact:min-h-0 max-compact:w-full max-compact:border-r-0",
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
            const isPinned = pinnedConversationIds.includes(conv.id);
            const draft = drafts[conv.id];
            const timeLabel = formatShortTime(conv.lastMessageAt);
            const directPeer =
              conv.kind === "direct"
                ? conv.memberIds
                    .map((uid) => members[uid])
                    .find((m) => m && m.id !== currentUser?.id) ||
                  conv.memberIds.map((uid) => members[uid]).find(Boolean)
                : undefined;
            const isBotDirect =
              conv.kind === "direct" &&
              Boolean(
                directPeer?.role === "bot" ||
                  conv.memberIds.some(
                    (uid) =>
                      uid !== currentUser?.id &&
                      (uid.startsWith("usr_bot_") || uid.startsWith("usr_system_"))
                  )
              );
            const rowButton = (
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
                  <Avatar
                    name={conv.title}
                    src={conv.avatarUrl || directPeer?.avatarUrl}
                    emoji={conv.avatarEmoji}
                    kind={conv.kind === "group" ? "group" : isBotDirect ? "bot" : "human"}
                    color={isBotDirect ? directPeer?.avatarColor : undefined}
                    size="md"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-dl-text-primary">
                      <span className="truncate">{conv.title}</span>
                      {isPinned && (
                        <Pin
                          aria-label="已置顶会话"
                          className="size-3 shrink-0 text-dl-lane-shared"
                          strokeWidth={2}
                        />
                      )}
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
                        <span
                          data-testid="unread-badge"
                          className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-dl-lane-shared px-1.5 text-[10px] font-semibold text-dl-on-shared tabular-nums"
                        >
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Button>
            );

            if (conv.kind === "saved") {
              return rowButton;
            }

            return (
              <ContextMenu key={conv.id}>
                <ContextMenuTrigger asChild>{rowButton}</ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    icon={isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    onSelect={() => void togglePinConversation(conv.id)}
                  >
                    {isPinned ? "取消置顶会话" : "置顶会话"}
                  </ContextMenuItem>
                  <ContextMenuItem
                    icon={<Settings2 className="size-4" />}
                    onSelect={() => {
                      selectConversation(conv.id);
                      setMobileView("chat");
                      openDetailsInspector();
                    }}
                  >
                    {conv.kind === "group" ? "群聊设置" : "会话详情"}
                  </ContextMenuItem>
                  {conv.kind === "group" && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        tone="danger"
                        icon={<LogOut className="size-4" />}
                        onSelect={() => void leaveGroup(conv.id)}
                      >
                        退出群聊
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建群聊</DialogTitle>
            <DialogDescription className="sr-only">
              设置群聊名称、可选图标与成员
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateGroup} className="space-y-3 p-6 max-narrow:p-3.5 pt-4">
            <Input
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="群聊名称"
              aria-label="群组名称"
              required
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-dl-text-secondary mr-1">群图标</span>
              {GROUP_EMOJI_PRESETS.map((emoji) => (
                <Button
                  key={emoji}
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`选择群图标 ${emoji}`}
                  onClick={() => setGroupEmoji((prev) => (prev === emoji ? "" : emoji))}
                  className={cn(
                    "size-8 rounded-lg border p-0 text-base",
                    groupEmoji === emoji
                      ? "border-dl-lane-shared bg-dl-lane-shared/14"
                      : "border-dl-border-hairline bg-dl-surface-subtle/50 hover:bg-dl-surface-subtle"
                  )}
                >
                  {emoji}
                </Button>
              ))}
            </div>
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
            {createError && (
              <div className="text-xs text-dl-danger">{createError}</div>
            )}
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
