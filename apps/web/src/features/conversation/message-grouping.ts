import type { WorkspaceConversationMessage } from "./contracts";
import { getMessageDayKey } from "./conversation-utils";

export type MessageGroupPosition = "single" | "start" | "middle" | "end";

function canContinueGroup(previous: WorkspaceConversationMessage | undefined, message: WorkspaceConversationMessage) {
  if (!previous || !message.authorId || message.authorId !== previous.authorId) return false;
  if ((message.authorKind ?? "human") !== (previous.authorKind ?? "human") || Boolean(message.self) !== Boolean(previous.self)) return false;
  if ([previous, message].some((entry) => entry.authorKind === "system" || entry.hiddenByCurrentUser || entry.recalledAt || entry.replyTo || entry.replyToMessageId)) return false;
  const previousTime = Date.parse(previous.createdAt ?? "");
  const messageTime = Date.parse(message.createdAt ?? "");
  return Number.isFinite(previousTime) && Number.isFinite(messageTime) &&
    messageTime >= previousTime && messageTime - previousTime <= 5 * 60 * 1000 &&
    getMessageDayKey(previous.createdAt) === getMessageDayKey(message.createdAt);
}

/** Derive adjacent edges without wrapping/remounting message rows. Source indices
 * include hidden messages, so hidden runs and unread dividers remain boundaries. */
export function getMessageGroupPositions(messages: readonly WorkspaceConversationMessage[], unreadIndex = -1): MessageGroupPosition[] {
  const continues = messages.map((message, index) => index !== unreadIndex && canContinueGroup(messages[index - 1], message));
  return continues.map((fromPrevious, index) => {
    const toNext = continues[index + 1] ?? false;
    return fromPrevious ? toNext ? "middle" : "end" : toNext ? "start" : "single";
  });
}
