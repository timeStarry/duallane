import React, { useState } from "react";
import { AtSign, Bot, Check, MessageSquare, Pencil, Settings2, X } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore, type V1User } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { Avatar, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@/shared/ui";

function isBotMember(member: V1User): boolean {
  return (
    member.role === "bot" ||
    member.id === "usr_system_beacon" ||
    member.id === "usr_system_echo" ||
    member.id.startsWith("usr_bot_")
  );
}

export function MemberProfileModal() {
  const { profileModalUserId, closeProfileModal } = useLaneStore();
  const { members } = useWorkspaceStore();
  const member = profileModalUserId ? members[profileModalUserId] : undefined;

  if (!profileModalUserId || !member) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && closeProfileModal()}>
      <MemberProfileModalInner key={profileModalUserId} member={member} />
    </Dialog>
  );
}

function MemberProfileModalInner({ member }: { member: V1User }) {
  const {
    closeProfileModal,
    setActiveLane,
    setMobileView,
    openSettings,
    openLightbox,
    requestMention,
  } = useLaneStore();
  const {
    currentUser,
    conversations,
    activeConversationId,
    selectConversation,
    setMemberRemark,
    bootstrapWorkspace,
  } = useWorkspaceStore();

  const isSelf = Boolean(currentUser && member.id === currentUser.id);
  const isBot = isBotMember(member);
  const canRemark = !isSelf && !isBot;

  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(member.remark || "");
  const [savingRemark, setSavingRemark] = useState(false);
  const [startingDM, setStartingDM] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const isOnline = isBot ? member.botOnline === true : member.online === true;
  const hasPresence = isBot ? typeof member.botOnline === "boolean" : typeof member.online === "boolean";
  const roleLabel = isBot
    ? "机器人"
    : member.role === "owner"
    ? "空间所有者"
    : member.role === "admin"
    ? "管理员"
    : "成员";

  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const canMentionInActiveConv = Boolean(
    activeConv && activeConv.kind !== "saved" && !isSelf && activeConv.memberIds.includes(member.id)
  );

  const handleSaveRemark = async () => {
    setSavingRemark(true);
    setFeedback(null);
    try {
      await setMemberRemark(member.id, remarkDraft.trim());
      setEditingRemark(false);
      setFeedback({ kind: "ok", text: remarkDraft.trim() ? "个人备注已保存（仅自己可见）" : "已清除个人备注" });
    } catch (err) {
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : "备注保存失败" });
    } finally {
      setSavingRemark(false);
    }
  };

  const handleStartDM = async () => {
    setStartingDM(true);
    setFeedback(null);
    try {
      const existing = Object.values(conversations).find(
        (c) => c.kind === "direct" && c.memberIds.includes(member.id)
      );
      if (existing) {
        selectConversation(existing.id);
        setActiveLane("workspace");
        setMobileView("chat");
        closeProfileModal();
        return;
      }
      const res = await apiV1.createDirectConversation(member.id);
      await bootstrapWorkspace();
      const targetConvId =
        (res as { conversationId?: string; id?: string; conversation?: { id?: string } })
          ?.conversationId ||
        (res as { id?: string })?.id ||
        (res as { conversation?: { id?: string } })?.conversation?.id;
      if (targetConvId) {
        selectConversation(targetConvId);
        setActiveLane("workspace");
        setMobileView("chat");
      }
      closeProfileModal();
    } catch (err) {
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : "无法发起私聊" });
    } finally {
      setStartingDM(false);
    }
  };

  const handleMention = () => {
    if (!activeConv) return;
    requestMention(activeConv.id, member.id, member.displayName);
    closeProfileModal();
  };

  return (
    <DialogContent className="max-w-sm overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{member.displayName} 的个人名片</DialogTitle>
        </DialogHeader>

        {/* Banner + Avatar Header */}
        <div className="relative bg-gradient-to-br from-dl-lane-shared/15 via-dl-surface-raised to-dl-surface px-5 pb-4 pt-6">
          <div className="flex items-start gap-3.5">
            <div className="relative shrink-0">
              {member.avatarUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-full p-0 hover:opacity-90"
                  aria-label="查看大图头像"
                  onClick={() =>
                    openLightbox(
                      [
                        {
                          id: `avatar-${member.id}`,
                          url: member.avatarUrl!,
                          downloadUrl: member.avatarUrl!,
                          fileName: `${member.displayName}.png`,
                          mimeType: "image/png",
                        },
                      ],
                      0
                    )
                  }
                >
                  <Avatar
                    name={member.displayName}
                    src={member.avatarUrl}
                    color={member.avatarColor}
                    kind={isBot ? "bot" : "human"}
                    size="lg"
                  />
                </Button>
              ) : (
                <Avatar
                  name={member.displayName}
                  color={member.avatarColor}
                  kind={isBot ? "bot" : "human"}
                  size="lg"
                />
              )}
              {hasPresence && (
                <span
                  title={isOnline ? "在线" : "离线"}
                  className={`absolute bottom-0 right-0 size-3.5 rounded-full border-2 border-dl-surface ${
                    isOnline ? "bg-emerald-500" : "bg-dl-text-tertiary/60"
                  }`}
                />
              )}
            </div>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-base font-semibold text-dl-text-primary">
                  {member.displayName}
                </span>
                {isBot && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-dl-lane-shared/15 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared">
                    <Bot className="size-2.5" />
                    Bot
                  </span>
                )}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-dl-text-tertiary">
                {member.handle && <span className="truncate">@{member.handle}</span>}
                <span>·</span>
                <span>{roleLabel}</span>
                {hasPresence && (
                  <>
                    <span>·</span>
                    <span className={isOnline ? "text-emerald-600 dark:text-emerald-400" : ""}>
                      {isOnline ? "在线" : "离线"}
                    </span>
                  </>
                )}
              </div>

              {member.remark && member.nickname && member.remark !== member.nickname && (
                <p className="mt-1 truncate text-xs text-dl-text-secondary">
                  原昵称：{member.nickname}
                </p>
              )}
            </div>
          </div>

          {member.statusText && (
            <div className="mt-3 inline-flex max-w-full items-center rounded-full border border-dl-border-hairline bg-dl-surface/80 px-2.5 py-1 text-xs text-dl-text-secondary">
              <span className="truncate">{member.statusText}</span>
            </div>
          )}
        </div>

        {/* Details Body */}
        <div className="space-y-3.5 px-5 py-4">
          {(member.bio || member.description) && (
            <div>
              <div className="text-[11px] font-medium text-dl-text-tertiary">
                {isBot ? "机器人简介" : "个人简介"}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-dl-text-secondary">
                {isBot ? member.description : member.bio}
              </p>
            </div>
          )}

          {canRemark && (
            <div className="rounded-lg border border-dl-border-hairline bg-dl-surface-raised/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-dl-text-tertiary">
                  个人备注（仅自己可见）
                </span>
                {!editingRemark && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs text-dl-lane-shared"
                    onClick={() => {
                      setRemarkDraft(member.remark || "");
                      setEditingRemark(true);
                      setFeedback(null);
                    }}
                  >
                    <Pencil className="size-3" />
                    {member.remark ? "修改" : "添加备注"}
                  </Button>
                )}
              </div>
              {editingRemark ? (
                <div className="mt-2 flex items-center gap-1.5">
                  <Input
                    value={remarkDraft}
                    onChange={(e) => setRemarkDraft(e.target.value)}
                    placeholder="输入备注名，留空可清除"
                    className="h-8 text-xs"
                    maxLength={40}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveRemark();
                      } else if (e.key === "Escape") {
                        setEditingRemark(false);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="h-8 px-2.5 text-xs"
                    disabled={savingRemark}
                    onClick={() => void handleSaveRemark()}
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    disabled={savingRemark}
                    onClick={() => setEditingRemark(false)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-dl-text-primary">
                  {member.remark || <span className="text-dl-text-tertiary">未设置备注</span>}
                </p>
              )}
            </div>
          )}

          {feedback && (
            <p
              className={`text-xs ${
                feedback.kind === "error"
                  ? "text-dl-danger"
                  : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {feedback.text}
            </p>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 pt-1">
            {isSelf ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() => {
                  closeProfileModal();
                  openSettings("profile");
                }}
              >
                <Settings2 className="size-3.5" />
                编辑个人资料
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="flex-1 gap-1.5"
                  disabled={startingDM}
                  onClick={() => void handleStartDM()}
                >
                  <MessageSquare className="size-3.5" />
                  {startingDM ? "打开中…" : "发消息"}
                </Button>
                {canMentionInActiveConv && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleMention}
                  >
                    <AtSign className="size-3.5" />
                    提及
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
  );
}
