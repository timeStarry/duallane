import type { FormEvent, ReactNode, RefObject } from "react";
import type { EmoteItem, EmotePack } from "../../emotes";
import type { WorkspaceComposerDocument, WorkspaceComposerEditorHandle } from "../../WorkspaceComposerEditor";
import type { ObjectAction } from "../../ui/primitives";

export type ConversationComposerAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  state: "queued" | "uploading" | "uploaded" | "failed";
  progress: number;
  failureReason?: string;
};

/** Display data only. Domain messages may extend this shape without moving their
 * API, persistence or permission contracts into the conversation renderer. */
export type WorkspaceConversationMessage = {
  id: string;
  author: string;
  authorId?: string;
  authorAvatarUrl?: string;
  authorKind?: "human" | "bot" | "system";
  body: string;
  at: string;
  createdAt?: string;
  self?: boolean;
  localState?: "uploading" | "sending" | "delivered" | "failed";
  failureReason?: string;
  attachments?: readonly unknown[];
  pendingAttachments?: ConversationComposerAttachment[];
  pin?: { canUnpin?: boolean };
  recalledAt?: string | null;
  hiddenByCurrentUser?: boolean;
  /** Keeps the reply boundary even when the referenced content is unavailable. */
  replyToMessageId?: string;
  replyTo?: { messageId?: string; author: string; body: string };
};

export type ConversationMentionMember = {
  id: string;
  displayName: string;
  githubLogin?: string;
  avatarUrl?: string | null;
  kind?: "human" | "bot" | "system";
  secondaryText?: string;
};

export type ConversationEmotePickerProps = {
  id?: string;
  label?: string;
  workspaceFeatures?: "composer" | "reaction";
  onSelect: (item: EmoteItem, packId: EmotePack["id"]) => void;
  onEscape?: () => void;
  onManageEmotes?: () => void;
};

export type WorkspaceChatPanelProps<TMessage extends WorkspaceConversationMessage = WorkspaceConversationMessage> = {
  scopeKey: string;
  title: string;
  titleKind?: ConversationMentionMember["kind"];
  avatar?: ReactNode;
  subtitle: string;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  banner?: ReactNode;
  composerContext?: ReactNode;
  hideComposer?: boolean;
  emptyState?: ReactNode;
  messages: TMessage[];
  renderMessageContent: (message: TMessage) => ReactNode;
  renderPendingAttachments?: (message: TMessage) => ReactNode;
  renderReactions?: (message: TMessage) => ReactNode;
  renderMessageMeta?: (message: TMessage) => ReactNode;
  renderEchoInteraction?: (restoreFocus: () => void) => ReactNode;
  renderEmotePicker?: (props: ConversationEmotePickerProps) => ReactNode;
  composerEditorRef?: RefObject<WorkspaceComposerEditorHandle | null>;
  messageListRef: RefObject<HTMLDivElement | null>;
  onMessageListScroll: (list: HTMLDivElement) => void;
  onMessageListScrollIntent?: () => void;
  olderMessagesAvailable?: boolean;
  olderMessagesLoading?: boolean;
  onLoadOlderMessages?: () => void;
  unreadAnchorMessageId?: string | null;
  unreadAnchorCount?: number;
  newMessageCount?: number;
  awayFromLatest?: boolean;
  onJumpToLatest?: () => void;
  draft: string;
  draftDocument: WorkspaceComposerDocument;
  onDraft: (value: WorkspaceComposerDocument) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  /** Sending may be busy while the next draft remains editable. */
  sendDisabled?: boolean;
  readOnly?: boolean;
  composerDisabled?: boolean;
  composerDisabledReason?: ReactNode;
  onSendImageEmote?: (item: EmoteItem) => Promise<void> | void;
  clickImageEmoteToSend?: boolean;
  stagedAttachments?: ConversationComposerAttachment[];
  onStageFiles?: (files: File[]) => void;
  onRemoveStagedAttachment?: (attachmentId: string) => void;
  fileInputDisabled?: boolean;
  onReply?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  onCancelMessage?: (messageId: string) => void;
  replyTarget?: TMessage | null;
  onCancelReply?: () => void;
  onCopyMessage?: (message: TMessage) => void;
  onToggleReaction?: (messageId: string, emoteKey: string) => void;
  onFavoriteEmote?: (message: TMessage) => void;
  canFavoriteMessage?: (message: TMessage) => boolean;
  onTogglePin?: (message: TMessage) => void;
  onRecall?: (message: TMessage) => void;
  onHideMessage?: (messageId: string) => void;
  onRestoreHiddenMessages?: (messageIds: string[]) => void;
  currentUserId: string;
  conversationType: "group" | "direct";
  historyTargetId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onReturnToLatest?: () => void;
  mentionMembers?: ConversationMentionMember[];
  onManageEmotes?: () => void;
  availableTopics?: Array<{ id: string; title: string; status: "open" | "closed" | "archived" }>;
  onSelectTopic?: (topic: { id: string; title: string; status: "open" | "closed" | "archived" } | null) => void;
  /** Only actions backed by supplied callbacks are in defaults. A domain adapter
   * may add supported actions or narrow them further; never pass no-op commands. */
  getMessageActions?: (message: TMessage, defaults: ObjectAction[]) => ObjectAction[];
};
