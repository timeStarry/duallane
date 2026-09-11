import type { ReactNode } from "react";
import type { WorkspaceChatPanelProps } from "../conversation/contracts";
import type { WorkspaceAttachment, WorkspaceComposerAttachment, WorkspaceContentBlock, WorkspaceDisplayMessage, WorkspaceMessage } from "../conversation/message-model";

/** Topic lifecycle supplies the scope; all content and media use the ordinary
 * Workspace experience and its authenticated transport. */
export type TopicChatRuntime = {
  renderChat: (props: Omit<WorkspaceChatPanelProps<WorkspaceDisplayMessage>, "renderMessageContent"> & { reactionPendingKeys?: string[] }) => ReactNode;
  stagedAttachments: WorkspaceComposerAttachment[];
  canUpload: boolean;
  replyAutoMention?: boolean;
  stageFiles: (files: File[]) => void;
  removeStagedAttachment: (attachmentId: string) => void;
  takeStagedAttachments: () => void;
  uploadAttachments: (conversationId: string, attachments: WorkspaceComposerAttachment[], onUpdate: (id: string, update: (attachment: WorkspaceComposerAttachment) => WorkspaceComposerAttachment) => void, shouldCancel?: () => boolean) => Promise<WorkspaceAttachment[]>;
  cancelUploads: (attachments: WorkspaceComposerAttachment[]) => void;
  removeUploadedAttachments: (attachments: WorkspaceAttachment[]) => Promise<boolean>;
  submitMessage: (input: { conversationId: string; topicId: string; clientMessageId: string; replyToMessageId?: string | null; body: string; blocks: WorkspaceContentBlock[]; syncToGroup?: boolean }) => Promise<WorkspaceMessage>;
};
