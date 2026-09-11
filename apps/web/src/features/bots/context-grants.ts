export type BotGrantOwner = { id: string; botUserId: string; ownerUserId: string; status: string };
export type BotGrantSettings = { allowDirect: boolean; allowGroup: boolean; visibilityPolicy: string; context?: { maxMessages?: number } };
export type BotGroupPolicy = {
  conversationId: string; status?: string; grantId?: string | null;
  allowTrigger?: boolean; allowContext?: boolean;
  maxContextMessages?: number | null; contextMaxMessages?: number | null;
  invitedBy?: string | null; approvedBy?: string | null; createdAt?: string; updatedAt?: string;
};
export type GrantConversation = {
  id: string; type: string; title?: string; displayTitle?: string;
  members: Array<{ id: string }>;
  capabilities?: { canManageMembers?: boolean };
};
export type BotContextGrant = {
  botId: string; conversationId: string; grantId: string;
  allowTrigger: boolean; allowContext: boolean; maxMessages: number | null;
};
export type ContextGrantTarget = {
  id: string; kind: "direct" | "group"; title: string; policy?: BotGroupPolicy;
  known: boolean; allowTrigger: boolean; allowContext: boolean; maxMessages: number | null;
  readOnlyReason: string;
};
export type ContextGrantDraft = { allowTrigger: boolean; allowContext: boolean; maxMessages: string };
export type BotGrantJson = <T>(path: string, options?: RequestInit) => Promise<T>;
export type BotGrantNavigationGuard = { message: string; confirmLabel?: string; save?: () => Promise<boolean>; discard: () => boolean };

/** The owner-only Bot response and authenticated conversation projections define the candidate set. */
export function contextGrantTargets(bot: BotGrantOwner, settings: BotGrantSettings, conversations: readonly GrantConversation[], policies: readonly BotGroupPolicy[]): ContextGrantTarget[] {
  const targets: ContextGrantTarget[] = conversations
    .filter(conversation => conversation.type === "direct" && conversation.members.length === 2 && conversation.members.some(member => member.id === bot.botUserId) && conversation.members.some(member => member.id === bot.ownerUserId))
    .map(conversation => ({ id: conversation.id, kind: "direct", title: "与 Bot 的所有者私聊", known: false, allowTrigger: false, allowContext: false, maxMessages: null,
      readOnlyReason: bot.status !== "active" ? "仅运行中的 Bot 可以修改私聊授权。" : !settings.allowDirect ? "Bot 当前未开启私聊，不能修改此授权。" : "" }));
  for (const policy of policies) {
    const conversation = conversations.find(candidate => candidate.id === policy.conversationId && candidate.type === "group");
    let readOnlyReason = "";
    if (!conversation || !conversation.capabilities?.canManageMembers) readOnlyReason = "只读：需要仍在此群中的空间主人或管理员，同时是该 Bot 的所有者。";
    else if (bot.status !== "active" && bot.status !== "paused") readOnlyReason = "当前 Bot 状态不允许管理授权。";
    else if (policy.status !== "active") readOnlyReason = "此群授权尚未生效或已移除；本页不会自动批准或重新加入群聊。";
    else if (!settings.allowGroup || settings.visibilityPolicy === "private") readOnlyReason = "当前 Bot 群聊或发现策略不允许有效群授权，请先检查群聊策略。";
    targets.push({ id: policy.conversationId, kind: "group", title: conversation?.displayTitle || conversation?.title || "已返回的群授权", policy,
      known: typeof policy.allowTrigger === "boolean" && typeof policy.allowContext === "boolean",
      allowTrigger: policy.allowTrigger === true, allowContext: policy.allowContext === true,
      maxMessages: policy.contextMaxMessages ?? policy.maxContextMessages ?? null, readOnlyReason });
  }
  return targets;
}

export function initialGrantDraft(target: ContextGrantTarget, defaultMaxMessages = 50): ContextGrantDraft {
  return { allowTrigger: target.allowTrigger, allowContext: target.allowContext, maxMessages: String(target.maxMessages ?? Math.min(200, Math.max(1, defaultMaxMessages))) };
}

export function grantSubmission(botId: string, target: ContextGrantTarget, draft: ContextGrantDraft) {
  if (target.readOnlyReason) throw new Error(target.readOnlyReason);
  const maxMessages = Number(draft.maxMessages);
  if (!draft.maxMessages.trim() || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 200) throw new Error("消息数量必须是 1 到 200 之间的整数。");
  const fields = { allowTrigger: draft.allowTrigger, allowContext: draft.allowContext, maxMessages };
  // Group mutation also changes membership when its status changes. Preserve the returned active status.
  return target.kind === "group"
    ? { path: `/api/workspace/bots/${encodeURIComponent(botId)}/group-policies/${encodeURIComponent(target.id)}`, body: { status: "active", ...fields } }
    : { path: `/api/workspace/bots/${encodeURIComponent(botId)}/context-grants/${encodeURIComponent(target.id)}`, body: fields };
}
