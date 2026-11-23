import { approvalNamespace, readCitedMessage, safeText } from "./channel.mjs";
import { identifier } from "./config.mjs";
import { ticketId } from "./store.mjs";

const demand = /^(?:@Comet\s*)?DL(?:需求|反馈)(?:[：:]\s*|\s+|$)([\s\S]*)$/iu;
const validTicket = (id) => typeof id === "string" && /^DL-[a-f0-9]{24}$/u.test(id);
const reply = (text) => ({ status: "completed", text });

function demandMatch(request) {
  const text = request?.triggerMessage?.plainText;
  return typeof text === "string" ? demand.exec(text.trim()) : null;
}

export function isReleaseBridgeIntent(request) {
  if (request?.protocol !== "duallane.agent.request" || request.version !== 1) return false;
  if (request.event?.type === "card.action") return request.event.payload?.data?.namespace === approvalNamespace;
  return request.event?.type === "message.created" && request.conversation?.type === "group" && Boolean(demandMatch(request));
}

export async function handleReleaseBridge(request, { config, store, authorizeOwner, readQuote = readCitedMessage, now = Date.now }) {
  const { channel } = config;
  const { event, conversation, triggerMessage } = request ?? {};
  const payload = event?.payload;
  if (request?.protocol !== "duallane.agent.request" || request.version !== 1 || !identifier(request.taskId) ||
      !conversation?.id || event?.conversationId !== conversation.id) return null;

  if (event.type === "card.action" && payload?.data?.namespace === approvalNamespace) {
    const actor = payload.actorUserId;
    const { ticketId, fingerprint, nonce } = payload.data;
    if (conversation.type !== "direct" || conversation.id !== channel.ownerConversationId ||
        actor !== channel.ownerUserId || payload.botId !== channel.botId || !validTicket(ticketId) ||
        !identifier(payload.cardId) || !identifier(payload.clientActionId) || !["confirm", "cancel"].includes(payload.actionId)) {
      return reply("这次操作未获得发布审批权限。");
    }
    const ticket = store.get(ticketId);
    const approval = ticket?.approval;
    if (!approval || approval.ownerUserId !== actor || approval.conversationId !== conversation.id ||
        approval.fingerprint !== fingerprint || approval.nonce !== nonce || ticket.cardId !== payload.cardId) {
      if (ticket) store.audit(ticketId, actor, "approval_refused", "card_mismatch");
      return reply("这张确认卡已失效，请使用当前工单的确认卡。");
    }
    if (ticket.state !== "awaiting_approval") return reply(`${ticket.id} 的确认已处理。`);
    if (approval.expiresAt <= now() || approval.mode !== config.mode) {
      store.transition(ticket, { state: "expired", text: null, context: null }, { actor, action: "approval_refused" });
      return reply(`${ticket.id} 的确认已过期，需要重新生成候选。`);
    }
    try {
      await authorizeOwner();
    } catch {
      store.audit(ticketId, actor, "approval_refused", "channel_denied");
      return reply("当前私聊权限无法核验，请稍后重新确认。");
    }
    if (approval.expiresAt <= now()) {
      store.transition(ticket, { state: "expired" }, { actor, action: "approval_refused" });
      return reply(`${ticket.id} 的确认已过期，需要重新生成候选。`);
    }
    const state = payload.actionId === "cancel" ? "deferred" : config.mode === "pilot" ? "pilot_confirmed" : "approved";
    const changed = store.transition(ticket, { state, actionReceipt: { id: payload.clientActionId, actor, at: now() } },
      { actor, action: "approval" });
    if (!changed) return reply(`${ticket.id} 的确认已处理。`);
    if (state === "deferred") return reply(`${ticket.id} 已暂缓。`);
    if (state === "pilot_confirmed") return reply(`${ticket.id} 的试运行确认已记录。`);
    return reply(`${ticket.id} 的发版确认已记录。合入通过检查的候选后将开始发布。`);
  }

  if (event.type !== "message.created" || conversation.type !== "group" || conversation.id !== channel.groupConversationId) return null;
  const match = demandMatch(request);
  if (!match) return null;
  if (!identifier(payload?.messageId) || !identifier(payload?.actorUserId) || payload.textComplete === false ||
      triggerMessage.id !== payload.messageId || !["user", "human"].includes(triggerMessage.authorKind ?? triggerMessage.senderKind) ||
      (triggerMessage.conversationId && triggerMessage.conversationId !== conversation.id) ||
      (triggerMessage.authorId ?? triggerMessage.senderId) !== payload.actorUserId) {
    return reply("无法核对这条需求的原消息，请重新发送完整需求。");
  }
  const text = safeText(match[1], 6000);
  if (!text) return reply("请在「DL需求」后写明问题或预期行为，移除凭据信息后再发送。");
  const source = { spaceId: channel.spaceId, conversationId: conversation.id, messageId: payload.messageId, actorId: payload.actorUserId };
  const existing = store.get(ticketId(source));
  if (existing) return reply(`${existing.id} 已进入需求评估，结论会回复这条消息。`);
  const quoteId = triggerMessage.replyToMessageId || payload.replyToMessageId;
  const context = quoteId && quoteId !== source.messageId ? await readQuote(request, quoteId) : null;
  const result = store.take({ source, text, context, maxDailyTickets: config.maxDailyTickets });
  if (result.quota) return reply("今天的需求评估额度已用完，请稍后再提交。");
  return reply(`${result.ticket.id} 已进入需求评估，结论会回复这条消息。`);
}
