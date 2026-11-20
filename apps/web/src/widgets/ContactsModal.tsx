import React, { useMemo, useState } from "react";
import { Bot, MessageSquare, Pencil, Search, Users, X } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore, type V1User } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { Avatar, Button, Dialog, DialogContent, DialogHeader, DialogTitle, IconButton, Input } from "@/shared/ui";

function isBotMember(member: V1User): boolean {
  return (
    member.role === "bot" ||
    member.id === "usr_system_beacon" ||
    member.id === "usr_system_echo" ||
    member.id.startsWith("usr_bot_")
  );
}

export function ContactsModal() {
  const { contactsOpen, setContactsOpen, setActiveLane, setMobileView } = useLaneStore();
  const {
    currentUser,
    members,
    conversations,
    conversationOrder,
    selectConversation,
    setMemberRemark,
    bootstrapWorkspace,
  } = useWorkspaceStore();

  const [query, setQuery] = useState("");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [startingUserId, setStartingUserId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const { humans, bots, groups } = useMemo(() => {
    const allMembers = Object.values(members).filter((m) => m.id !== currentUser?.id);
    const matchesMember = (m: V1User) => {
      if (!normalizedQuery) return true;
      return (
        (m.displayName || "").toLowerCase().includes(normalizedQuery) ||
        (m.remark || "").toLowerCase().includes(normalizedQuery) ||
        (m.nickname || "").toLowerCase().includes(normalizedQuery) ||
        (m.handle || "").toLowerCase().includes(normalizedQuery)
      );
    };
    const humanList = allMembers
      .filter((m) => !isBotMember(m) && matchesMember(m))
      .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "zh-CN"));
    const botList = allMembers
      .filter((m) => isBotMember(m) && matchesMember(m))
      .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "zh-CN"));
    const groupList = conversationOrder
      .map((id) => conversations[id])
      .filter((c): c is NonNullable<typeof c> => Boolean(c && c.kind === "group"))
      .filter((c) => !normalizedQuery || c.title.toLowerCase().includes(normalizedQuery));
    return { humans: humanList, bots: botList, groups: groupList };
  }, [members, currentUser?.id, normalizedQuery, conversationOrder, conversations]);

  const handleOpenDirect = async (targetUserId: string) => {
    // Check if a direct conversation already exists locally
    const existing = Object.values(conversations).find(
      (c) =>
        c.kind === "direct" &&
        c.memberIds.includes(targetUserId) &&
        (!currentUser?.id || c.memberIds.includes(currentUser.id))
    );
    if (existing) {
      setActiveLane("workspace");
      selectConversation(existing.id);
      setMobileView("chat");
      setContactsOpen(false);
      return;
    }
    setStartingUserId(targetUserId);
    try {
      const res = await apiV1.createDirectConversation(targetUserId);
      const convObj = (res.conversation as Record<string, unknown> | undefined) || res;
      const newConvId = String(convObj.id || "");
      await bootstrapWorkspace();
      if (newConvId) {
        setActiveLane("workspace");
        selectConversation(newConvId);
        setMobileView("chat");
      }
      setContactsOpen(false);
    } catch (err) {
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : "发起私聊失败" });
    } finally {
      setStartingUserId(null);
    }
  };

  const handleSaveRemark = async (memberId: string, nextValue: string) => {
    setSavingRemark(true);
    setFeedback(null);
    try {
      const trimmed = nextValue.trim();
      await setMemberRemark(memberId, trimmed);
      setFeedback({ kind: "ok", text: trimmed ? "已保存个人备注（仅自己可见）" : "已清除个人备注" });
      setEditingMemberId(null);
    } catch (err) {
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : "保存备注失败" });
    } finally {
      setSavingRemark(false);
    }
  };

  return (
    <Dialog open={contactsOpen} onOpenChange={setContactsOpen}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-dl-border-hairline">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Users className="size-4 text-dl-lane-shared" strokeWidth={1.9} />
            <span>通讯录</span>
            <span className="text-xs font-normal text-dl-text-tertiary">
              · 空间成员、机器人与群聊
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 pt-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-dl-text-tertiary" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索成员、个人备注、机器人或群聊…"
              aria-label="搜索通讯录"
              className="h-9 pl-8 pr-8 text-xs"
            />
            {query && (
              <IconButton
                variant="ghost"
                size="sm"
                label="清除搜索"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 text-dl-text-tertiary hover:text-dl-text-primary"
              >
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>
        </div>

        {feedback && (
          <div
            className={`mx-5 mb-2 rounded-lg px-3 py-1.5 text-xs ${
              feedback.kind === "error"
                ? "bg-dl-danger/10 text-dl-danger"
                : "bg-dl-success/10 text-dl-success"
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="dl-scroll max-h-[60vh] overflow-y-auto px-5 pb-5 space-y-4">
          {/* Human Space Members */}
          <section className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-dl-text-tertiary px-1">
              空间成员 ({humans.length})
            </div>
            {humans.length === 0 ? (
              <div className="rounded-xl border border-dl-border-hairline/70 px-3 py-4 text-center text-xs text-dl-text-tertiary">
                暂无匹配的成员
              </div>
            ) : (
              <div className="space-y-1">
                {humans.map((member) => {
                  const isEditing = editingMemberId === member.id;
                  const originalName =
                    member.nickname || member.handle || member.displayName;
                  return (
                    <div
                      key={member.id}
                      className="rounded-xl border border-dl-border-hairline/70 bg-dl-surface-subtle/35 px-3 py-2 space-y-2"
                    >
                      <div className="flex items-center gap-2.5">
                        <Avatar
                          name={member.displayName}
                          src={member.avatarUrl}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate text-xs font-medium text-dl-text-primary">
                              {member.displayName}
                            </span>
                            {member.remark && (
                              <span className="shrink-0 rounded bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared">
                                已备注
                              </span>
                            )}
                            {member.role === "owner" && (
                              <span className="shrink-0 rounded bg-dl-surface-subtle px-1.5 py-0.5 text-[10px] text-dl-text-tertiary">
                                空间所有者
                              </span>
                            )}
                          </div>
                          {member.remark && originalName && originalName !== member.displayName && (
                            <div className="truncate text-[11px] text-dl-text-tertiary">
                              原昵称：{originalName}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 px-2 text-[11px] text-dl-text-secondary hover:text-dl-lane-shared"
                            onClick={() => {
                              if (isEditing) {
                                setEditingMemberId(null);
                              } else {
                                setEditingMemberId(member.id);
                                setRemarkDraft(member.remark || "");
                              }
                            }}
                          >
                            <Pencil className="size-3" strokeWidth={1.85} />
                            <span>个人备注</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            busy={startingUserId === member.id}
                            className="h-7 gap-1 px-2.5 text-[11px]"
                            onClick={() => void handleOpenDirect(member.id)}
                          >
                            <MessageSquare className="size-3" strokeWidth={1.85} />
                            <span>私聊</span>
                          </Button>
                        </div>
                      </div>

                      {isEditing && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleSaveRemark(member.id, remarkDraft);
                          }}
                          className="flex items-center gap-1.5 pt-1 border-t border-dl-border-hairline/60"
                        >
                          <Input
                            value={remarkDraft}
                            onChange={(e) => setRemarkDraft(e.target.value)}
                            placeholder="输入个人备注（仅自己可见），留空清除"
                            maxLength={40}
                            className="h-7 flex-1 text-xs"
                            autoFocus
                          />
                          {member.remark && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={savingRemark}
                              className="h-7 px-2 text-[11px] text-dl-text-tertiary"
                              onClick={() => void handleSaveRemark(member.id, "")}
                            >
                              清除
                            </Button>
                          )}
                          <Button
                            type="submit"
                            size="sm"
                            variant="primary"
                            busy={savingRemark}
                            className="h-7 px-2.5 text-[11px]"
                          >
                            保存
                          </Button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* AI Bots */}
          {bots.length > 0 && (
            <section className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-dl-text-tertiary px-1">
                AI 机器人 ({bots.length})
              </div>
              <div className="space-y-1">
                {bots.map((bot) => (
                  <div
                    key={bot.id}
                    className="flex items-center gap-2.5 rounded-xl border border-dl-border-hairline/70 bg-dl-surface-subtle/35 px-3 py-2"
                  >
                    <Avatar name={bot.displayName} src={bot.avatarUrl} size="sm" />
                    <div className="min-w-0 flex-1 flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-dl-text-primary">
                        {bot.displayName}
                      </span>
                      <span className="inline-flex items-center gap-0.5 rounded bg-dl-lane-shared/10 px-1.5 py-0.5 text-[10px] text-dl-lane-shared">
                        <Bot className="size-2.5" />
                        Bot
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      busy={startingUserId === bot.id}
                      className="h-7 gap-1 px-2.5 text-[11px]"
                      onClick={() => void handleOpenDirect(bot.id)}
                    >
                      <MessageSquare className="size-3" strokeWidth={1.85} />
                      <span>私聊</span>
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Group Conversations */}
          {groups.length > 0 && (
            <section className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-dl-text-tertiary px-1">
                我的群聊 ({groups.length})
              </div>
              <div className="space-y-1">
                {groups.map((group) => (
                  <Button
                    key={group.id}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setActiveLane("workspace");
                      selectConversation(group.id);
                      setMobileView("chat");
                      setContactsOpen(false);
                    }}
                    className="h-auto w-full justify-start gap-2.5 rounded-xl border border-dl-border-hairline/70 bg-dl-surface-subtle/35 px-3 py-2 text-left font-normal transition-colors hover:bg-dl-surface-subtle"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-dl-lane-shared/12 text-sm">
                      {group.avatarEmoji || "👥"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-dl-text-primary">
                        {group.title}
                      </div>
                      <div className="text-[11px] text-dl-text-tertiary">
                        {group.memberIds.length} 位成员
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
