export type WorkspaceReactionUser = {
  id: string;
  displayName: string;
  githubLogin?: string;
  avatarUrl?: string;
  createdAt: string;
};

export type WorkspaceReactionGroup = {
  emoteKey: string;
  count: number;
  reactedByCurrentUser: boolean;
  users: WorkspaceReactionUser[];
};

export type WorkspaceEmoteCollectionShareSummary = {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
  revokedAt: string | null;
  sharedBy: { id: string; displayName: string };
  originalCreator: { id: string; displayName: string };
  canSubscribeToSourceChanges?: boolean;
  canRevoke: boolean;
  covers?: Array<{ id: string; label: string; src: string; animated: boolean }>;
  sharePath: string;
};

export type WorkspaceContentBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string }
  | { type: "attachment"; attachmentId: string }
  | { type: "emote_collection"; shareId: string; share?: WorkspaceEmoteCollectionShareSummary }
  | { type: "topic_reference"; topicId: string; title: string }
  | { type: "card"; cardId: string; cardType: string; schemaVersion: number; fallbackText: string };

export type WorkspaceAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: "pending" | "available" | "failed" | "removed";
  visibility?: "private_staging" | "conversation" | "space";
};

export type WorkspaceMessagePin = {
  pinnedByUserId: string;
  pinnedAt: string;
  canUnpin: boolean;
};

export type WorkspaceMessage = {
  id: string;
  conversationId: string;
  authorId: string;
  authorName?: string;
  authorGithubLogin?: string;
  authorAvatarUrl?: string;
  authorKind: "human" | "bot" | "system";
  kind: "user" | "bot" | "system";
  clientMessageId?: string;
  content: {
    format: string;
    plainText: string;
    blocks: WorkspaceContentBlock[];
  };
  plainText: string;
  replyToMessageId?: string | null;
  topicId?: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  recalledAt?: string | null;
  recallReason?: string | null;
  hiddenByCurrentUser?: boolean;
  attachments: WorkspaceAttachment[];
  reactions: WorkspaceReactionGroup[];
  pin?: WorkspaceMessagePin;
};

export type WorkspaceComposerAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  state: "queued" | "uploading" | "uploaded" | "failed";
  progress: number;
  attachment?: WorkspaceAttachment;
  uploadId?: string;
  failureReason?: string;
  generatedFromLongMessage?: boolean;
  generatedSource?: string;
};

/** Shared rendered message data; P2P transfer state remains owned by its lane. */
export type WorkspaceDisplayMessage = {
  id: string;
  authorId?: string;
  author: string;
  authorAvatarUrl?: string;
  authorKind?: "human" | "bot" | "system";
  body: string;
  lane: "p2p" | "workspace";
  at: string;
  createdAt?: string;
  self?: boolean;
  localState?: "uploading" | "sending" | "delivered" | "failed";
  failureReason?: string;
  fileName?: string;
  content?: { blocks: WorkspaceContentBlock[] };
  attachments?: WorkspaceAttachment[];
  pendingAttachments?: WorkspaceComposerAttachment[];
  reactions?: WorkspaceReactionGroup[];
  pin?: WorkspaceMessagePin;
  recalledAt?: string | null;
  recallReason?: string | null;
  hiddenByCurrentUser?: boolean;
  replyToMessageId?: string;
  replyTo?: {
    messageId?: string;
    author: string;
    body: string;
  };
};
