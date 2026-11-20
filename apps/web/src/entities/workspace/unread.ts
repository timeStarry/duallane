import type { V1Conversation, V1Message } from "./store";

export function isReadAnchor(message: V1Message): boolean {
  return !message.hiddenByCurrentUser && !message.id.startsWith("opt_");
}

export function unreadMessage(message: V1Message, currentUserId?: string): boolean {
  return isReadAnchor(message) && message.kind !== "system" &&
    message.senderId !== currentUserId && !message.recalledAt;
}

export type ConversationUnread = Pick<
  V1Conversation,
  "unreadCount" | "mentionCount" | "firstUnreadMessageId" | "lastReadMessageId" | "lastReadSeq"
>;

export function readConversationUnread(
  raw: Record<string, unknown> | undefined,
  previous?: ConversationUnread
): ConversationUnread {
  const incomingSeq = raw?.lastReadSeq;
  const hasPrevSeq = typeof previous?.lastReadSeq === "number" && Number.isSafeInteger(previous.lastReadSeq);
  const hasIncomingSeq = typeof incomingSeq === "number" && Number.isSafeInteger(incomingSeq);
  const isStaleSeq = hasIncomingSeq && hasPrevSeq && incomingSeq < (previous!.lastReadSeq as number);
  const projection = isStaleSeq ? undefined : raw;
  const seq = projection?.lastReadSeq;
  const count = projection?.unreadCount;
  const mentionRaw = projection?.mentionCount;
  const unreadCount =
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? count
      : previous?.unreadCount ?? 0;
  const mentionCount =
    unreadCount === 0
      ? 0
      : typeof mentionRaw === "number" && Number.isSafeInteger(mentionRaw) && mentionRaw >= 0
        ? Math.min(mentionRaw, unreadCount)
        : Math.min(previous?.mentionCount ?? 0, unreadCount);
  const first = projection?.firstUnreadMessageId;
  const last = projection?.lastReadMessageId;
  return {
    unreadCount,
    mentionCount,
    firstUnreadMessageId:
      unreadCount === 0
        ? null
        : typeof first === "string" || first === null
          ? first
          : previous?.firstUnreadMessageId,
    lastReadMessageId:
      typeof last === "string" || last === null ? last : previous?.lastReadMessageId,
    lastReadSeq:
      typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0
        ? seq
        : previous?.lastReadSeq,
  };
}

export function resolveReturnUnread(
  snapshot: ConversationUnread & { lastMessageAt?: string },
  messages: readonly V1Message[],
  currentUserId: string | undefined,
  laterIncomingIds: ReadonlySet<string>,
) {
  if (snapshot.unreadCount === 0) return { targetId: undefined, availableCount: 0, exact: true };

  const firstIndex = messages.findIndex((message) => message.id === snapshot.firstUnreadMessageId);
  const readIndex = messages.findIndex((message) => message.id === snapshot.lastReadMessageId);
  const cutoff = Date.parse(snapshot.lastMessageAt ?? "");
  const eligible = messages.filter((message, index) => {
    if (!unreadMessage(message, currentUserId) || laterIncomingIds.has(message.id) ||
      (Number.isFinite(cutoff) && Date.parse(message.createdAt) > cutoff)) return false;
    if (firstIndex >= 0 && index < firstIndex) return false;
    if (snapshot.lastReadSeq !== undefined && message.creationSeq !== undefined) {
      return message.creationSeq > snapshot.lastReadSeq;
    }
    return firstIndex >= 0 || index > readIndex;
  });
  const available = firstIndex >= 0 ? eligible.slice(0, snapshot.unreadCount) : eligible.slice(-snapshot.unreadCount);
  const exact = (firstIndex >= 0 && available[0]?.id === snapshot.firstUnreadMessageId) ||
    (snapshot.firstUnreadMessageId == null && available.length === snapshot.unreadCount);
  return {
    targetId: available[0]?.id,
    availableCount: available.length,
    exact,
  };
}
