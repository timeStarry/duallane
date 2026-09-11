import type {
  WorkspaceComposerAttachment,
  WorkspaceDisplayMessage,
  WorkspaceMessage
} from "./message-model";

export type WorkspaceMessageProjectionInput = Omit<
  WorkspaceMessage,
  "conversationId" | "kind" | "attachments" | "reactions"
> & Partial<Pick<WorkspaceMessage, "conversationId" | "kind" | "attachments" | "reactions">> & {
  author?: { displayName: string; avatarUrl?: string | null; githubLogin?: string };
  localState?: WorkspaceDisplayMessage["localState"];
  failureReason?: string;
  pendingAttachments?: WorkspaceComposerAttachment[];
};

function workspaceMessageAuthor(message: WorkspaceMessageProjectionInput) {
  return message.authorName || message.author?.displayName ||
    message.authorGithubLogin || message.author?.githubLogin || "成员";
}

function workspaceMessageReplyPreview(
  reply: WorkspaceMessageProjectionInput | undefined,
  replyToMessageId?: string | null
): WorkspaceDisplayMessage["replyTo"] {
  if (!reply) return replyToMessageId ? { messageId: replyToMessageId, author: "", body: "查看引用消息" } : undefined;
  if (reply.hiddenByCurrentUser) return { messageId: reply.id, author: "", body: "已隐藏的消息" };
  if (reply.recalledAt) return { messageId: reply.id, author: "", body: "已撤回的消息" };
  return {
    messageId: reply.id,
    author: reply.kind === "system" || reply.authorKind === "system" ? "系统" : workspaceMessageAuthor(reply),
    body: reply.plainText
  };
}

/** Group and topic snapshots use one projection; reply targets stay within the supplied snapshot. */
export function workspaceMessagesForChat(
  messages: readonly WorkspaceMessageProjectionInput[],
  currentUserId: string
): WorkspaceDisplayMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return messages.map((message) => {
    const self = message.authorId === currentUserId;
    const system = message.kind === "system" || message.authorKind === "system";
    const createdAt = new Date(message.createdAt);
    const attachments = message.attachments ?? [];
    const reply = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined;
    return {
      id: message.id,
      authorId: message.authorId,
      author: system ? "系统" : self ? "你" : workspaceMessageAuthor(message),
      authorAvatarUrl: message.authorAvatarUrl ?? message.author?.avatarUrl ?? undefined,
      authorKind: system ? "system" : message.authorKind,
      body: message.plainText,
      lane: "workspace",
      at: Number.isNaN(createdAt.getTime())
        ? ""
        : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(createdAt),
      createdAt: message.createdAt,
      self,
      localState: message.localState,
      failureReason: message.failureReason,
      fileName: attachments[0]?.fileName,
      content: message.content.blocks.length || message.pendingAttachments?.length
        ? message.content
        : { ...message.content, blocks: [{ type: "text", text: message.plainText }] },
      attachments,
      pendingAttachments: message.pendingAttachments,
      reactions: message.reactions ?? [],
      pin: message.pin,
      recalledAt: message.recalledAt,
      recallReason: message.recallReason,
      hiddenByCurrentUser: message.hiddenByCurrentUser,
      replyToMessageId: message.replyToMessageId ?? undefined,
      replyTo: workspaceMessageReplyPreview(reply, message.replyToMessageId)
    };
  });
}
