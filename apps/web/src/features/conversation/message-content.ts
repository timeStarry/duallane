import type { WorkspaceComposerDocument } from "../../WorkspaceComposerEditor";
import type { WorkspaceComposerAttachment, WorkspaceContentBlock } from "./message-model";

const WORKSPACE_LONG_MESSAGE_CODE_POINTS = 30_000;
const WORKSPACE_LONG_MESSAGE_BYTES = 100 * 1024;
export const WORKSPACE_MAX_STAGED_ATTACHMENTS = 10;

export function isWorkspaceTextOverAttachmentLimit(value: string) {
  return Array.from(value).length > WORKSPACE_LONG_MESSAGE_CODE_POINTS ||
    new TextEncoder().encode(value).byteLength > WORKSPACE_LONG_MESSAGE_BYTES;
}

export function createWorkspaceLongMessageAttachment(source: string): WorkspaceComposerAttachment {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return {
    id: `long-message-${crypto.randomUUID()}`,
    file: new File([source], `长消息-${stamp}.txt`, { type: "text/plain" }),
    state: "queued",
    progress: 0,
    generatedFromLongMessage: true,
    generatedSource: source
  };
}

export function workspaceComposerDocumentToContentBlocks(document: WorkspaceComposerDocument): WorkspaceContentBlock[] {
  const blocks: WorkspaceContentBlock[] = [];
  for (const block of document.blocks) {
    if (block.type === "mention") {
      blocks.push(block);
      continue;
    }
    if (block.type === "emote" && block.item.kind === "image" && block.item.customId) {
      blocks.push({ type: "emoji", shortcode: `custom:${block.item.customId}` });
      continue;
    }
    const text = block.type === "text" ? block.text : block.token;
    if (!text) continue;
    const previous = blocks.at(-1);
    if (previous?.type === "text") previous.text += text;
    else blocks.push({ type: "text", text });
  }
  return blocks;
}

export function workspaceDraftWithReplyMention(
  document: WorkspaceComposerDocument,
  { enabled, currentUserId, replyAuthorId, members }: {
    enabled: boolean;
    currentUserId: string;
    replyAuthorId?: string;
    members: readonly { id: string; displayName: string; kind?: "human" | "bot" | "system" }[];
  }
): WorkspaceComposerDocument {
  if (!enabled || !replyAuthorId || replyAuthorId === currentUserId) return document;
  const member = members.find((candidate) => candidate.id === replyAuthorId);
  if (!member || member.kind === "system" || document.blocks.some((block) => block.type === "mention" && block.userId === member.id)) return document;
  return {
    source: `@${member.displayName}${document.source ? ` ${document.source}` : " "}`,
    blocks: [{ type: "mention", userId: member.id, label: member.displayName }, { type: "text", text: " " }, ...document.blocks]
  };
}

export type PreparedWorkspaceMessageContent = {
  body: string;
  blocks: WorkspaceContentBlock[];
  attachments: WorkspaceComposerAttachment[];
};

/** Both group and topic sends prepare the same payload before upload or delivery. */
export function prepareWorkspaceMessageContent(
  document: WorkspaceComposerDocument,
  stagedAttachments: readonly WorkspaceComposerAttachment[]
): PreparedWorkspaceMessageContent | null {
  const source = document.source;
  const hasBody = source.trim().length > 0;
  const hasStructuredBody = hasBody || document.blocks.some(
    (block) => block.type === "mention" || block.type === "emote"
  );
  if (stagedAttachments.length > WORKSPACE_MAX_STAGED_ATTACHMENTS) {
    throw new Error(`每条消息最多添加 ${WORKSPACE_MAX_STAGED_ATTACHMENTS} 个文件`);
  }

  const attachments = [...stagedAttachments];
  const shouldConvertLongMessage = isWorkspaceTextOverAttachmentLimit(source);
  let generatedAttachment = attachments.find(
    (attachment) => attachment.generatedFromLongMessage && attachment.generatedSource === source
  );
  if (shouldConvertLongMessage && !generatedAttachment) {
    if (attachments.length >= WORKSPACE_MAX_STAGED_ATTACHMENTS) {
      throw new Error("长消息需要转换为 TXT，请先移除一个附件");
    }
    generatedAttachment = createWorkspaceLongMessageAttachment(source);
    attachments.push(generatedAttachment);
  }
  if (!hasStructuredBody && attachments.length === 0) return null;

  return {
    body: shouldConvertLongMessage
      ? `[长消息] ${generatedAttachment?.file.name ?? "长消息.txt"}`
      : hasBody ? source : `[文件] ${attachments.map((attachment) => attachment.file.name).join("、")}`,
    blocks: !shouldConvertLongMessage && hasStructuredBody
      ? workspaceComposerDocumentToContentBlocks(document)
      : [],
    attachments
  };
}
