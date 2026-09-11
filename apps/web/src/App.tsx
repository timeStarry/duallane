import { workspaceMessagesForChat } from "./features/conversation/message-projection";
import { createWorkspaceMessageCommands } from "./features/conversation/message-commands";
import type { WorkspaceReactionUser, WorkspaceReactionGroup, WorkspaceContentBlock, WorkspaceAttachment, WorkspaceMessage, WorkspaceMessagePin, WorkspaceComposerAttachment, WorkspaceEmoteCollectionShareSummary, WorkspaceDisplayMessage } from "./features/conversation/message-model";
import { prepareWorkspaceMessageContent, workspaceComposerDocumentToContentBlocks, workspaceDraftWithReplyMention, WORKSPACE_MAX_STAGED_ATTACHMENTS } from "./features/conversation/message-content";
export { isWorkspaceTextOverAttachmentLimit } from "./features/conversation/message-content";
import { WorkspaceChatPanel as SharedWorkspaceChatPanel, type WorkspaceChatPanelProps } from "./features/conversation/WorkspaceChatPanel";
import { WorkspaceIdentityName, WorkspaceBotBadge, MentionPicker as SharedMentionPicker } from "./features/conversation/ConversationIdentity";
import { formatBytes, formatMessageDayLabel, getMessageDayKey, getWorkspacePendingAttachmentProgress, shouldDirectSendWorkspaceEmote } from "./features/conversation/conversation-utils";
export { getWorkspacePendingAttachmentProgress, shouldDirectSendWorkspaceEmote } from "./features/conversation/conversation-utils";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { useConfirmation } from "./ui/patterns/ConfirmationProvider";
import { useObjectActionScope } from "./ui/patterns";
import { createWorkspaceTopicSessionStore } from "./features/topics/session";
import "./ui/patterns/object-actions.css";
import { WorkspaceAccountSettings } from "./features/settings/WorkspaceAccountSettings";
import { WorkspaceEmailSettingsPanel } from "./features/settings/WorkspaceEmailSettingsPanel";
import { WorkspaceSwitch } from "./features/settings/SettingsControls";
import { ObjectActionMenu, SegmentedControl, Select, Switch, ViewModeSwitch, type ObjectAction } from "./ui/primitives";
import { useMessageActions } from "./features/conversation/useMessageActions";
import { useAppearance } from "./ui/theme";
import { useNavigationGuard, type NavigationGuard } from "./shell/useNavigationGuard";
import { EntryPage } from "./features/entry/EntryPage";
import { WorkspaceNavigation } from "./shell/WorkspaceNavigation";
import { MemberPickerDialog, type MemberPickerSubmission } from "./features/members/MemberPickerDialog";
import {
  AlertCircle,
  AtSign,
  ArrowLeft,
  BellRing,
  BellOff,
  Bot,
  Bold,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  Clipboard,
  Code2,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  EyeOff,
  FileCheck2,
  FileCode2,
  FileText,
  FileUp,
  FileVideo,
  Github,
  GripVertical,
  Heart,
  Hash,
  History,
  Images,
  Italic,
  Link2,
  LayoutGrid,
  List,
  ListOrdered,
  LockKeyhole,
  LogOut,
  Mail,
  Maximize2,
  MessageSquare,
  Minus,
  Minimize2,
  Monitor,
  Moon,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Quote,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Smile,
  Strikethrough,
  Sun,
  Trash2,
  Type,
  Undo2,
  UserRound,
  UsersRound,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { Fragment, FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  MessageBody,
  ReactionEmoteGlyph,
  getEmoteInsertText,
  findFirstImageEmoteKey,
  getReactionEmote,
  getReactionEmoteKey,
  isSingleImageEmoteText,
  renderMessageParts,
  visibleEmotePacks,
  type EmoteItem,
  type EmotePack
} from "./emotes";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { WorkspaceAvatarEditor } from "./WorkspaceAvatarEditor";
import {
  WorkspaceComposerEditor,
  type WorkspaceComposerDocument,
  type WorkspaceComposerEditorHandle
} from "./WorkspaceComposerEditor";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
import { isImeCompositionEnter } from "./workspace-composer-ime";
import { WorkspaceInteractiveCard, supportsWorkspaceInteractiveCard } from "./WorkspaceInteractiveCard";
import {
  P2P_FILE_CHUNK_SIZE,
  P2P_MAX_CHAT_BYTES,
  P2P_MAX_FILE_BYTES,
  getP2pFileChunkCount,
  parseDataEnvelope,
  parseDataEnvelopeValue,
  sha256Base64Url,
  validateP2pFileChunk,
  validateP2pFileCompletion,
  type DataEnvelope
} from "./p2p-protocol";
import { createWorkspaceJsonHeaders } from "./workspace-http";
import { AboutPage } from "./AboutPage";
import {
  getAppRouteUrl,
  parseAppRoute,
  workspaceRoute,
  type AppRoute,
  type WorkspaceRouteAccountSection
} from "./app-route";
import { getWorkspaceEntryUrl, getWorkspaceLoginUrl } from "./workspace-url";
import { formatWorkspaceConversationTime } from "./workspace-conversation-time";
import { isPreviewableImageMimeType, renamePastedImageFiles } from "./workspace-image-files";
import {
  isWorkspaceBootstrapResponseCurrent,
  isWorkspaceConversationAccessCurrent,
  isWorkspaceConversationListResponseCurrent,
  mergeWorkspaceMessageWindow,
  shouldAdvanceWorkspaceConversationHistoryEpoch,
  type WorkspaceMessageWindowMergeContext
} from "./workspace-conversation-state";
import {
  classifyWorkspaceFile,
  workspaceFileMatchesCategory,
  type WorkspaceFileCategory,
  type WorkspaceFileViewMode
} from "./workspace-file-category";
import {
  normalizeWorkspaceGroupAvatarEmoji,
  WORKSPACE_GROUP_AVATAR_PRESETS
} from "./workspace-group-avatar";
import { userFacingErrorMessage } from "./user-facing-error";
import { installWorkspaceUnreadFavicon } from "./workspace-unread-favicon";
import { isServerVersionNewer } from "./app-version";
import { groupHiddenWorkspaceMessages } from "./workspace-hidden-messages";
import {
  AUTO_HIDE_LABELS, AUTO_HIDE_MESSAGE_TYPES, DEFAULT_AUTO_HIDE_PREFERENCES,
  isWorkspaceDisplayBlock as isKnownWorkspaceMessageBlock,
  normalizeAutoHidePreferences, shouldCollapseWorkspaceMessageText,
  WorkspaceAutoHiddenContent, type WorkspaceAutoHidePreferences
} from "./workspace-auto-hide";
export { shouldCollapseWorkspaceMessageText } from "./workspace-auto-hide";
import {
  getPreferredEmotePickerPack,
  rememberEmotePickerPackOnClose,
  rememberPreferredEmotePickerPack,
  type EmotePickerPreferenceScope
} from "./emote-picker-preference";
import { getRecentEmojiIds, recordRecentEmojiUse } from "./recent-emojis";
import { CachedEmoteImage } from "./emote-image-cache";
import {
  WorkspaceConversationTopicsSection,
  WorkspaceTopicPage,
  WorkspaceTopicRail,
  advanceWorkspaceTopicRefreshSignal,
  workspaceTopicMobilePane,
  type WorkspaceTopic,
  type WorkspaceTopicRefreshSignal
} from "./WorkspaceTopics";
import { WorkspaceEchoRequirements } from "./WorkspaceEchoRequirements";
import {
  ECHO_BOT_USER_ID,
  WorkspaceEchoInteraction,
  clearStoredWorkspaceEchoWorkflowDrafts,
  recognizeWorkspaceEchoCommand,
  reusableWorkspaceEchoCommandRequest,
  type WorkspaceEchoCommandRequest,
  type WorkspaceEchoInteractionSlot
} from "./WorkspaceEchoInteraction";
import { WorkspaceBotSettings } from "./WorkspaceBotSettings";

type Lane = "entry" | "about" | "p2p" | "workspace-dev";
type P2pStep = "name" | "chat" | "ended" | "invalid-room";
type ConnectionState = "idle" | "connecting" | "connected" | "offline" | "error";
type P2pTransportMode = "waiting" | "direct" | "relay-text" | "offline" | "error";
type DataChannelState = "idle" | RTCDataChannelState;
type P2pRoomIssue = "" | "not-found" | "full" | "missing-key";
type CopyState = "idle" | "copied" | "failed";
type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
const WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT = "duallane:workspace-emote-library-changed";
const VERSION_UPDATE_DISMISSED_STORAGE_PREFIX = "duallane-version-update-dismissed:";
const VERSION_CHECK_INTERVAL_MS = 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 8 * 1000;
let workspaceEmoteLibraryCache: WorkspaceEmoteLibrary | null = null;
let workspaceEmoteLibraryRequest: Promise<WorkspaceEmoteLibrary> | null = null;

function notifyWorkspaceEmoteLibraryChanged() {
  workspaceEmoteLibraryCache = null;
  window.dispatchEvent(new Event(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT));
}

function clearWorkspaceEmoteLibraryCache() {
  workspaceEmoteLibraryCache = null;
  workspaceEmoteLibraryRequest = null;
}

type SecureChannel = "signal" | "ws-chat" | "profile";
type SecureEnvelope = {
  type: "secure";
  v: 1;
  channel: SecureChannel;
  nonce: string;
  ciphertext: string;
};
type SecureKeys = Record<SecureChannel, CryptoKey>;
type IceServersResponse = {
  iceServers?: RTCIceServer[];
};
type FileTransferStatus = "offered" | "waiting" | "sending" | "receiving" | "verifying" | "complete" | "rejected" | "failed";
type FileTransfer = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: FileTransferStatus;
  progress: number;
  downloadUrl?: string;
  failureReason?: string;
  riskNote?: string;
  retryable?: boolean;
};
type Message = WorkspaceDisplayMessage & { fileTransfer?: FileTransfer };

type WorkspaceUser = {
  id: string;
  githubLogin?: string;
  displayName: string;
  nickname?: string | null;
  remark?: string;
  description?: string;
  avatarUrl?: string;
  searchDiscoverable?: boolean;
  recallReason?: string;
  kind: "human" | "bot" | "system";
  role: "owner" | "admin" | "member" | "auditor";
  roleLabel?: string;
  capabilities?: {
    canStartDirectConversation?: boolean;
    canJoinGroups?: boolean;
    canManage?: boolean;
  };
  joinedAt: string;
};
type WorkspacePermissions = {
  canCreateMemberInvite: boolean;
  canCreatePrivilegedInvite: boolean;
  canManageMemberVisibility: boolean;
  canManageEmailSettings: boolean;
  canReadConversations: boolean;
  canCreateGroup: boolean;
  canCreateDirect: boolean;
  canUpload: boolean;
  canDownload: boolean;
  canViewOperationRecords: boolean;
};

function workspacePermissionsChanged(previous: WorkspacePermissions, next: WorkspacePermissions) {
  return previous.canCreateMemberInvite !== next.canCreateMemberInvite ||
    previous.canCreatePrivilegedInvite !== next.canCreatePrivilegedInvite ||
    previous.canManageMemberVisibility !== next.canManageMemberVisibility ||
    previous.canManageEmailSettings !== next.canManageEmailSettings ||
    previous.canReadConversations !== next.canReadConversations ||
    previous.canCreateGroup !== next.canCreateGroup ||
    previous.canCreateDirect !== next.canCreateDirect ||
    previous.canUpload !== next.canUpload ||
    previous.canDownload !== next.canDownload ||
    previous.canViewOperationRecords !== next.canViewOperationRecords;
}

type WorkspacePolicy = {
  dailyQuotaBytes: number;
  usedTodayBytes?: number;
  remainingQuotaBytes?: number;
  messageRetentionCount: number;
  memberVisibilityBasis: "direct_contacts";
};
type WorkspaceMemberVisibility = {
  basis: "direct_contacts";
  viewerUserId: string;
  automaticUserIds: string[];
  grantedUserIds: string[];
  visibleUserIds: string[];
};
type WorkspaceBootstrap = {
  appVersion?: string;
  auth: {
    mode: string;
    inviteOnly: boolean;
    currentUser: WorkspaceUser;
  };
  space: {
    id: string;
    name: string;
    slug: string;
    createdBy: string;
    createdAt: string;
  };
  policy: WorkspacePolicy;
  permissions: WorkspacePermissions;
  members: WorkspaceUser[];
  conversations?: WorkspaceConversation[];
  files?: WorkspaceFile[];
  invites: WorkspaceInvite[];
  inviteSummary: WorkspaceInviteSummary;
  eventCursor?: number;
};
type WorkspaceInviteSummary = {
  total: number;
  active: number;
  history: number;
  acceptedUses: number;
  availableUses: number;
};
type WorkspaceStatisticsValues = {
  members: number;
  conversations: number;
  messages: number;
  files: number;
  uploadedBytes: number;
};
type WorkspaceStatistics = {
  asOf: string;
  dayStartedAt: string;
  totals: WorkspaceStatisticsValues;
  today: WorkspaceStatisticsValues;
};
type WorkspaceInvite = {
  id: string;
  code?: string;
  inviteUrl?: string;
  codePreview: string;
  defaultRole: WorkspaceUser["role"];
  maxUses: number;
  uses: number;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  acceptedMemberCount: number;
  acceptedMembers: Array<WorkspaceUser & { acceptedAt: string }>;
};
type WorkspacePinnedMessage = WorkspaceMessagePin & {
  messageId: string;
  message: WorkspaceMessage;
};
type WorkspaceConversation = {
  id: string;
  spaceId: string;
  type: "direct" | "group";
  title: string;
  avatarEmoji?: string | null;
  displayTitle?: string;
  otherMember?: WorkspaceUser | null;
  retentionCount: number;
  retentionText?: string;
  createdAt: string;
  lastActivityAt?: string;
  messageCount: number;
  memberCount?: number;
  lastMessagePlainText?: string;
  lastMessageAt?: string | null;
  unreadCount?: number;
  lastReadMessageId?: string | null;
  lastReadAt?: string | null;
  lastReadSeq?: number | null;
  notificationLevel?: "all" | "mentions" | "muted";
  capabilities?: {
    canSendMessage?: boolean;
    canUploadFile?: boolean;
    canManageMembers?: boolean;
  };
  members: WorkspaceUser[];
  latestMessages: WorkspaceMessage[];
};
type WorkspaceConversationMessageRequest = {
  kind: "list" | "messages" | "around" | "read" | "history";
  baselineMessages: WorkspaceMessage[];
  requestRevision: number;
  requestGeneration: number;
  sessionEpoch: number;
  accessEpoch: number;
  membershipEpoch: number;
  historyEpoch: number;
};
type WorkspaceFile = WorkspaceAttachment & {
  uploaderId: string;
  uploaderName: string;
  uploader?: {
    id?: string;
    displayName?: string;
  };
  conversationId?: string | null;
  createdAt: string;
  completedAt?: string | null;
  availableAt?: string | null;
  capabilities?: {
    canDownload?: boolean;
    canRemove?: boolean;
  };
  localUpload?: {
    file: File;
    scope: "current" | "space";
    state: "uploading" | "failed";
    failureReason?: string;
  };
};
type WorkspaceView = "chat" | "topics" | "files" | "members" | "space" | "account";
type WorkspaceMobilePane = "list" | "main" | "details";
type WorkspaceCreateMode = "" | "direct" | "group";
type WorkspaceContextMode = "conversation" | "file" | "member";
type WorkspaceContextTab = "overview" | "topics" | "members" | "files" | "settings";
type WorkspaceSpaceTab = "overview" | "invites" | "roles" | "visibility" | "email" | "requirements";
type WorkspaceFileFilter = "all" | "conversation" | "standalone" | "mine";
type WorkspaceMemberRoleFilter = "all" | WorkspaceUser["role"];
type WorkspaceMemberKindFilter = "all" | WorkspaceUser["kind"];
type WorkspaceNotificationLevel = "all" | "mentions" | "muted";
type WorkspaceRealtimeState = "idle" | "connecting" | "connected" | "syncing" | "offline" | "error";
const WORKSPACE_NOTICE_AUTO_DISMISS_MS = 5000;
type WorkspaceNoticeOptions = {
  persistent?: boolean;
  durationMs?: number;
};
type WorkspaceNotice = {
  id: number;
  tone: "info" | "success" | "warning";
  text: string;
  persistent: boolean;
  durationMs: number;
};
type WorkspaceNotificationPreferences = {
  email: string | null;
  maskedEmail: string | null;
  emailSource: "github" | "custom";
  emailVerified: boolean;
  githubEmail: string | null;
  enabled: boolean;
  immediateEnabled: boolean;
  digestEnabled: boolean;
  mailAvailable: boolean;
};
type WorkspaceNtfyPreferences = {
  enabled: boolean;
  topic: string;
  serverUrl: string;
  subscriptionUrl: string;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
};
type WorkspaceEmoteSettings = WorkspaceAutoHidePreferences & {
  availablePacks: Array<{ id: Exclude<EmotePack["id"], "custom">; label: string; defaultEnabled: boolean }>;
  enabledPackIds: Array<Exclude<EmotePack["id"], "custom">>;
  clickImageEmoteToSend: boolean;
  replyAutoMention: boolean;
  minimumEnabled: number;
};
type WorkspaceCustomEmote = {
  id: string;
  kind: "builtin" | "custom";
  label: string;
  token: string;
  src: string;
  emoteKey?: string;
  animated: boolean;
  byteSize?: number;
  width?: number;
  height?: number;
  sourceType?: "upload" | "attachment" | "builtin" | "custom";
  originalFileName?: string;
  originalMimeType?: string;
  createdAt: string;
};
type WorkspaceEmoteCollection = {
  id: string;
  name: string;
  sourceCollectionId?: string | null;
  originalCreator: { id: string; displayName: string };
  sourceSubscription: {
    eligible: boolean;
    enabled: boolean;
    status: "off" | "synced" | "detached";
    sourceCollectionId: string | null;
    sourceRevision: number | null;
    lastSyncedAt: string | null;
    readOnly: boolean;
  };
  items: WorkspaceCustomEmote[];
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};
type WorkspaceEmoteLibraryEntry =
  | { id: string; type: "emote"; emote: WorkspaceCustomEmote }
  | { id: string; type: "collection"; collection: WorkspaceEmoteCollection };
type WorkspaceEmoteLibrary = {
  entries: WorkspaceEmoteLibraryEntry[];
  emotes: WorkspaceCustomEmote[];
  collections: WorkspaceEmoteCollection[];
  usage: {
    itemCount: number;
    totalBytes: number;
    subscribedItemCount: number;
    subscribedTotalBytes: number;
    collectionCount: number;
    subscribedCollectionCount: number;
    overLimit: boolean;
  };
  limits: {
    maxItems: number | null;
    maxTotalBytes: number;
    maxInputBytes: number;
    maxCollections: number | null;
    maxCollectionItems: number;
    maxBatchItems: number;
  };
};
type WorkspaceEmoteCollectionShare = WorkspaceEmoteCollectionShareSummary & {
  items: WorkspaceCustomEmote[];
  sourceCollectionId?: string | null;
};
type WorkspaceEmoteUploadItem = {
  id: string;
  file: File;
  collectionId: string;
  state: "queued" | "uploading" | "complete" | "failed";
  progress: number;
  error?: string;
};
type WorkspaceEmailSettings = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  encryption: "starttls" | "tls" | "none";
  username: string;
  fromAddress: string;
  fromName: string;
  passwordConfigured: boolean;
  activeFrom?: string | null;
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestErrorCode: string | null;
  lastDeliveryAt?: string | null;
  failedJobCount: number;
};
type WorkspaceTransferDirection = "upload" | "download";
type WorkspaceEvent = {
  id: string;
  spaceId: string;
  seq: number;
  type: string;
  actorId?: string | null;
  conversationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown>;
  createdAt: string;
};
type WorkspaceRealtimeEnvelope = {
  version?: number;
  type?: string;
  currentSeq?: number;
  replayCount?: number;
  hasMore?: boolean;
  event?: WorkspaceEvent;
  events?: WorkspaceEvent[];
  error?: {
    code: string;
    message: string;
  };
};
type WorkspaceEventPayload = {
  topicMessageId?: string;
  userId?: string;
  notificationLevel?: WorkspaceNotificationLevel;
  member?: WorkspaceUser | null;
  conversationId?: string;
  conversation?: WorkspaceConversation | null;
  messageId?: string;
  message?: WorkspaceMessage | null;
  reactions?: WorkspaceReactionGroup[];
  attachmentId?: string;
  attachment?: WorkspaceFile | null;
  status?: WorkspaceAttachment["status"];
  direction?: "upload" | "download";
  reason?: string;
  topicId?: string;
  topicCard?: boolean;
  cardId?: string;
  revision?: number;
  card?: {
    cardId?: string;
    revision?: number;
  } | null;
};
type WorkspaceLocalMessage = {
  id: string;
  clientMessageId: string;
  conversationId: string;
  body: string;
  blocks: WorkspaceContentBlock[];
  attachments?: WorkspaceAttachment[];
  pendingAttachments?: WorkspaceComposerAttachment[];
  replyToMessageId?: string | null;
  createdAt: string;
  state: "uploading" | "sending" | "failed";
  failureReason?: string;
};
type WorkspaceUploadContract = {
  id: string;
  mode: "single" | "chunked";
  partSize: number;
  partCount: number;
};
const WORKSPACE_ROLE_OPTIONS: WorkspaceUser["role"][] = ["owner", "admin", "member", "auditor"];
const WORKSPACE_CONTEXT_STORAGE_KEY = "duallane.workspace.context-open";
type WorkspaceErrorPayload = {
  error?: {
    code: string;
    message: string;
  };
};
const WORKSPACE_ERROR_COPY: Record<string, string> = {
  "auth.required": "登录后进入共享空间。",
  "auth.not_invited": "这个 GitHub 账号还没有加入共享空间。",
  "auth.identity_conflict": "GitHub 身份与已有账号不一致，请联系空间主人。",
  "auth.github_required": "请通过 GitHub 登录接受邀请。",
  "auth.github_not_configured": "GitHub 登录尚未配置。",
  "workspace.disabled": "共享空间暂未开放。",
  "permission.denied": "你当前不能执行此操作。",
  "conversation.not_found": "你无法访问此会话。",
  "conversation.required": "你无法访问此会话。",
  "file.not_found": "文件已不可用。",
  "file.storage_missing": "文件内容暂时不可用。",
  "file.storage_mismatch": "文件内容暂时不可用。",
  "quota.insufficient": "今日传输额度不足。",
  "upload.size_mismatch": "文件上传失败，请重试。",
  "upload.invalid_content": "文件上传失败，请重试。",
  "upload.part_size_mismatch": "文件分片大小不正确，请重试。",
  "upload.part_hash_mismatch": "文件分片校验失败，已自动重试。",
  "upload.parts_incomplete": "文件分片尚未上传完整，请重试。",
  "http.413": "单次上传内容过大，请使用受支持的文件或刷新后重试。",
  "message.invalid_content": "消息内容无法发送，请调整后重试。",
  "message.idempotency_conflict": "这条消息已发生变化，请重新发送。",
  "message.too_long": "消息正文过长，请作为 TXT 文件发送。",
  "message.recall_unsupported": "该消息不能撤回。",
  "profile.recall_reason_invalid": "撤回文案应为 1 至 16 个有效字符。",
  "pin.group_only": "只有群聊支持常驻消息。",
  "pin.not_author": "只能常驻自己发送的消息。",
  "pin.limit_reached": "每人在每个群聊最多常驻 3 条消息。",
  "avatar.unsupported_format": "头像仅支持 JPEG、PNG 或 WebP。",
  "avatar.invalid_size": "头像文件大小不符合要求。",
  "avatar.invalid_image": "头像图片无法解析。",
  "emote.invalid_format": "收藏表情仅支持 JPEG、PNG、WebP、GIF 或 BMP。",
  "emote.input_too_large": "收藏表情原图不能超过 10 MiB。",
  "emote.animation_too_complex": "动图帧数或时长超出限制。",
  "emote.storage_limit_reached": "本地表情容量已达到上限，请删除部分本地表情后重试。",
  "emote.collection_not_found": "表情合集不存在或已被删除。",
  "emote.collection_limit_reached": "每个合集最多保存 100 张表情。",
  "emote.invalid_collection_name": "合集名称应为 1 至 32 个有效字符。",
  "emote.collection_empty": "空合集不能分享。",
  "emote.share_not_found": "表情合集分享不存在。",
  "emote.share_revoked": "这个表情合集已停止分享。",
  "emote.subscription_read_only": "订阅中的合集为只读，请先关闭订阅再修改。",
  "emote.subscription_source_unavailable": "原合集已不可用，当前快照会继续保留。",
  "emote.subscription_requires_collection": "只能为完整导入的合集开启订阅。",
  "emote.invalid_subscription": "订阅设置无效，请刷新后重试。",
  "message.invalid_emote_collection": "表情合集分享已不可用。"
};
class WorkspaceClientError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceClientError";
    this.code = code;
  }
}
type Peer = {
  id: string;
  name?: string;
  self?: boolean;
};
type PeerProfile = {
  kind: "profile";
  peerId?: string;
  name: string;
};
type P2pMessageEnvelope = Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>;
type SignalMessage = {
  signal?: "offer" | "answer" | "ice";
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type PeerSocketMessage = {
  author: string;
  body?: string;
  peers?: Peer[];
  peerId?: string;
  from?: Peer;
  signal?: SignalMessage;
  secure?: SecureEnvelope;
  systemEvent?: "room-not-found" | "room-full" | "joined" | "peer-joined" | "peer-left" | "peer-list";
};
type IncomingFileBuffer = {
  name: string;
  size: number;
  total: number;
  mimeType: string;
  accepted: boolean;
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>;
  chunkDigests: Array<string | undefined>;
  receivedBytes: number;
  blob?: Blob;
};
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};
type RoomDetail = {
  label: string;
  value: string;
};
type SavedP2pSession = {
  id: string;
  roomId: string;
  displayName: string;
  savedAt: string;
  messages: Message[];
};
type ConnectionAdvice = {
  title: string;
  body: string;
  items: string[];
};

const P2P_LARGE_FILE_WARNING_BYTES = 100 * 1024 * 1024;
const P2P_SAVED_SESSIONS_KEY = "duallane-p2p-sessions";

const P2P_SECRET_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const SECURE_ENVELOPE_VERSION = 1;
const P2P_MAX_PARTICIPANTS = 2;
const P2P_DEFAULT_PARTICIPANTS = 2;
const P2P_MESSAGE_ACK_TIMEOUT_MS = 10_000;
const P2P_FILE_ACK_TIMEOUT_MS = 10_000;
const P2P_RECONNECT_DELAY_MS = 1_500;
const P2P_RTC_NEGOTIATION_TIMEOUT_MS = 5_000;

const secureChannels: SecureChannel[] = ["signal", "ws-chat", "profile"];

function normalizePassphrase(value: string) {
  return value.trim().normalize("NFKC");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function generateRoomSecret() {
  const bytes = new Uint8Array(P2P_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function getRoomSecretFromHash(hash = window.location.hash) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const secret = params.get("k");
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : "";
}

function withRoomSecret(link: string, secret: string) {
  const url = new URL(link);
  url.hash = new URLSearchParams({ k: secret }).toString();
  return url.toString();
}

async function deriveP2pKeys(roomId: string, secret: string, passphrase: string): Promise<SecureKeys> {
  const encoder = new TextEncoder();
  const ikm = base64UrlToBytes(secret);
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = encoder.encode(`duallane-p2p:${roomId}:${normalizePassphrase(passphrase)}`);
  const entries = await Promise.all(
    secureChannels.map(async (channel) => {
      const key = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: encoder.encode(`duallane-p2p-v1:${channel}`)
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      return [channel, key] as const;
    })
  );
  return Object.fromEntries(entries) as SecureKeys;
}

async function getP2pVerificationCode(roomId: string, secret: string, passphrase: string) {
  const encoder = new TextEncoder();
  const ikm = base64UrlToBytes(secret);
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`duallane-p2p:${roomId}:${normalizePassphrase(passphrase)}`),
      info: encoder.encode("duallane-p2p-v1:verify")
    },
    baseKey,
    32
  );
  const value = new DataView(bits).getUint32(0);
  return String(value % 1_000_000).padStart(6, "0");
}

async function encryptSecurePayload(keys: SecureKeys, channel: SecureChannel, payload: unknown): Promise<SecureEnvelope> {
  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, keys[channel], plaintext);
  return {
    type: "secure",
    v: SECURE_ENVELOPE_VERSION,
    channel,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

async function decryptSecurePayload<T>(keys: SecureKeys, envelope: SecureEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.nonce) },
    keys[envelope.channel],
    base64UrlToBytes(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}





function makeId(prefix: string) {
  return `${prefix}-${randomId()}`;
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "请求失败"}`);
  }
  return (await response.json()) as T;
}

async function workspaceJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: createWorkspaceJsonHeaders(options)
  });
  if (!response.ok) {
    let payload: WorkspaceErrorPayload | null = null;
    try {
      payload = (await response.json()) as WorkspaceErrorPayload;
    } catch {
      // Fall back to the HTTP status below.
    }
    throw createWorkspaceClientError(response, payload);
  }
  return (await response.json()) as T;
}

const workspaceMessageCommands = createWorkspaceMessageCommands(workspaceJson);

async function loadWorkspaceEmoteLibrary(force = false) {
  if (!force && workspaceEmoteLibraryCache) return workspaceEmoteLibraryCache;
  if (!force && workspaceEmoteLibraryRequest) return workspaceEmoteLibraryRequest;
  const request = workspaceJson<WorkspaceEmoteLibrary>("/api/workspace/me/emote-library");
  workspaceEmoteLibraryRequest = request;
  try {
    const library = await request;
    workspaceEmoteLibraryCache = library;
    return library;
  } finally {
    if (workspaceEmoteLibraryRequest === request) workspaceEmoteLibraryRequest = null;
  }
}

async function workspaceFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let payload: WorkspaceErrorPayload | null = null;
    try {
      payload = (await response.json()) as WorkspaceErrorPayload;
    } catch {
      // Non-JSON responses fall back to the HTTP status below.
    }
    throw createWorkspaceClientError(response, payload);
  }
  return response;
}

function uploadWorkspaceEmote(path: string, file: File, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.responseType = "json";
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.setRequestHeader("x-duallane-file-name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(96, Math.max(8, Math.round((event.loaded / event.total) * 96))));
      }
    });
    request.addEventListener("load", () => {
      const payload = request.response && typeof request.response === "object"
        ? request.response as WorkspaceErrorPayload
        : null;
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(createWorkspaceClientError(new Response(null, {
        status: request.status || 500,
        statusText: request.statusText || "请求失败"
      }), payload));
    });
    request.addEventListener("error", () => reject(new WorkspaceClientError("network.error", "网络连接失败，请稍后重试")));
    request.send(file);
  });
}

function uploadWorkspaceFileContent(
  uploadId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  upload?: WorkspaceUploadContract
): Promise<{ attachment: WorkspaceAttachment }> {
  if (upload?.mode === "chunked") {
    return uploadWorkspaceFileInChunks(uploadId, file, upload, onProgress, signal);
  }
  return uploadWorkspaceFileSingleRequest(uploadId, file, onProgress, signal);
}

function uploadWorkspaceFileSingleRequest(
  uploadId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal
): Promise<{ attachment: WorkspaceAttachment }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.open("PUT", `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/content`);
    request.responseType = "json";
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(96, Math.max(8, Math.round((event.loaded / event.total) * 88))));
      }
    });
    request.addEventListener("load", () => {
      signal.removeEventListener("abort", abort);
      const payload = request.response && typeof request.response === "object"
        ? request.response as { attachment?: WorkspaceAttachment; error?: { code?: string; message?: string } }
        : {};
      if (request.status >= 200 && request.status < 300 && payload.attachment) {
        onProgress(100);
        resolve({ attachment: payload.attachment });
        return;
      }
      const code = payload.error?.code || `http.${request.status || 0}`;
      reject(new WorkspaceClientError(code, WORKSPACE_ERROR_COPY[code] || payload.error?.message || "文件上传失败"));
    });
    request.addEventListener("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new WorkspaceClientError("network.error", "网络连接失败，请稍后重试"));
    });
    request.addEventListener("abort", () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    request.send(file);
  });
}

async function uploadWorkspaceFileInChunks(
  uploadId: string,
  file: File,
  upload: WorkspaceUploadContract,
  onProgress: (progress: number) => void,
  signal: AbortSignal
): Promise<{ attachment: WorkspaceAttachment }> {
  const status = await workspaceJson<{
    parts: Array<{ partNumber: number; byteSize: number; sha256: string }>;
  }>(`/api/workspace/files/uploads/${encodeURIComponent(uploadId)}`);
  const received = new Map(status.parts.map((part) => [part.partNumber, part]));
  const completedBytes = new Map<number, number>();
  const activeBytes = new Map<number, number>();
  const updateProgress = () => {
    const loaded = [...completedBytes.values(), ...activeBytes.values()].reduce((total, value) => total + value, 0);
    onProgress(Math.min(96, Math.max(8, Math.round(8 + (loaded / file.size) * 88))));
  };
  let cursor = 1;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.min(2, upload.partCount) }, async () => {
    while (!failure && cursor <= upload.partCount) {
      const partNumber = cursor;
      cursor += 1;
      const start = (partNumber - 1) * upload.partSize;
      const blob = file.slice(start, Math.min(file.size, start + upload.partSize));
      const sha256 = await sha256Blob(blob);
      if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const existing = received.get(partNumber);
      if (existing?.byteSize === blob.size && existing.sha256 === sha256) {
        completedBytes.set(partNumber, blob.size);
        updateProgress();
        continue;
      }
      try {
        await retryWorkspaceUploadPart({
          uploadId,
          partNumber,
          blob,
          sha256,
          signal,
          onProgress: (loaded) => {
            activeBytes.set(partNumber, loaded);
            updateProgress();
          }
        });
        activeBytes.delete(partNumber);
        completedBytes.set(partNumber, blob.size);
        updateProgress();
      } catch (error) {
        failure = error;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  const completed = await workspaceJson<{ attachment: WorkspaceAttachment }>(
    `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: "POST", body: JSON.stringify({ mode: "chunked" }) }
  );
  onProgress(100);
  return completed;
}

async function retryWorkspaceUploadPart({
  uploadId,
  partNumber,
  blob,
  sha256,
  signal,
  onProgress
}: {
  uploadId: string;
  partNumber: number;
  blob: Blob;
  sha256: string;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await uploadWorkspacePartRequest(uploadId, partNumber, blob, sha256, signal, onProgress);
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function uploadWorkspacePartRequest(
  uploadId: string,
  partNumber: number,
  blob: Blob,
  sha256: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.open("PUT", `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`);
    request.responseType = "json";
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-duallane-part-sha256", sha256);
    request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    request.addEventListener("load", () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      const payload = request.response && typeof request.response === "object"
        ? request.response as { error?: { code?: string; message?: string } }
        : {};
      const code = payload.error?.code || `http.${request.status || 0}`;
      reject(new WorkspaceClientError(code, WORKSPACE_ERROR_COPY[code] || payload.error?.message || "文件分片上传失败"));
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(new WorkspaceClientError("network.error", "网络连接失败，请稍后重试"));
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
    request.send(blob);
  });
}

async function sha256Blob(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function createWorkspaceClientError(response: Response, payload: WorkspaceErrorPayload | null) {
  const code = payload?.error?.code || `http.${response.status}`;
  const safeMessage = WORKSPACE_ERROR_COPY[code] || payload?.error?.message || `${response.status} ${response.statusText || "请求失败"}`;
  return new WorkspaceClientError(code, safeMessage);
}

function getWsUrl(roomId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}`;
}

function getWorkspaceWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/workspace`;
}

function getInviteLink(roomId: string) {
  return `${window.location.origin}/direct/${encodeURIComponent(roomId)}`;
}

function routeLane(route: AppRoute): Lane {
  if (route.kind === "about") return "about";
  if (route.kind === "direct") return "p2p";
  if (route.kind === "workspace") return "workspace-dev";
  return "entry";
}

function workspaceViewFromRoute(route: Extract<AppRoute, { kind: "workspace" }> | null): WorkspaceView {
  if (!route || route.view === "new") return "chat";
  return route.view;
}

async function getIceServers() {
  try {
    const data = await fetch("/api/p2p/ice-servers").then((response) => parseJson<IceServersResponse>(response));
    return Array.isArray(data.iceServers) && data.iceServers.length > 0
      ? data.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];
  } catch {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to the legacy path below for LAN HTTP browsers.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function getO2OState(peerCount: number, socketState: ConnectionState, rtcState: ConnectionState): ConnectionState {
  if (socketState === "error" || socketState === "connecting") {
    return socketState;
  }
  if (socketState === "connected" && peerCount >= 2) {
    return "connected";
  }
  if (peerCount >= 2) {
    return rtcState === "error" || rtcState === "offline" ? rtcState : "connecting";
  }
  if (socketState === "offline") {
    return "offline";
  }
  return "idle";
}

function getP2pTransportMode(
  peerCount: number,
  socketState: ConnectionState,
  rtcState: ConnectionState
): P2pTransportMode {
  if (rtcState === "connected") {
    return "direct";
  }
  if (socketState === "error") {
    return "error";
  }
  if (socketState === "connected" && peerCount >= 2) {
    return "relay-text";
  }
  if (rtcState === "error") {
    return "error";
  }
  if (socketState === "connected") {
    return "waiting";
  }
  if (socketState === "offline" || rtcState === "offline") {
    return "offline";
  }
  return "waiting";
}

function connectionStateLabel(state: ConnectionState) {
  const labels: Record<ConnectionState, string> = {
    idle: "等待中",
    connecting: "连接中",
    connected: "已连接",
    offline: "离线",
    error: "异常"
  };

  return labels[state];
}

function p2pTransportModeLabel(mode: P2pTransportMode) {
  const labels: Record<P2pTransportMode, string> = {
    waiting: "等待连接路径",
    direct: "浏览器直连",
    "relay-text": "临时中转文本",
    offline: "连接已断开",
    error: "连接异常"
  };

  return labels[mode];
}

function p2pTransportModeDescription(mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return "消息和文件走浏览器直连。";
  }
  if (mode === "relay-text") {
    return "文本暂走信令中转。文件等待直连通道。";
  }
  if (mode === "offline") {
    return "对方离线或连接已断开。";
  }
  if (mode === "error") {
    return "连接异常，请检查网络或重建房间。";
  }
  return peerCount >= 2 ? "正在协商直连路径。" : "等待对方加入房间。";
}

function p2pTrustText(mode: P2pTransportMode) {
  if (mode === "direct") {
    return "当前为浏览器直连。服务器不保存对话内容";
  }
  if (mode === "relay-text") {
    return "当前文本走临时中转。服务器不保存对话内容";
  }
  return "服务器不保存对话内容";
}

function workspaceRoleLabel(role: WorkspaceUser["role"]) {
  const labels: Record<WorkspaceUser["role"], string> = {
    owner: "空间主人",
    admin: "管理员",
    member: "成员",
    auditor: "成员"
  };
  return labels[role];
}

function workspaceMemberRoleLabel(member: Pick<WorkspaceUser, "role" | "roleLabel">) {
  return member.roleLabel || workspaceRoleLabel(member.role);
}

function workspaceMemberKindLabel(kind: WorkspaceUser["kind"]) {
  const labels: Record<WorkspaceUser["kind"], string> = {
    human: "成员",
    bot: "机器人",
    system: "系统"
  };
  return labels[kind];
}





function workspaceRealtimeStateLabel(state: WorkspaceRealtimeState) {
  const labels: Record<WorkspaceRealtimeState, string> = {
    idle: "等待实时同步",
    connecting: "正在连接实时同步",
    connected: "实时同步",
    syncing: "正在同步",
    offline: "实时同步已断开",
    error: "实时同步异常"
  };
  return labels[state];
}

function workspaceNotificationLevelLabel(level: WorkspaceNotificationLevel = "all") {
  const labels: Record<WorkspaceNotificationLevel, string> = {
    all: "所有消息",
    mentions: "仅提到我",
    muted: "免打扰"
  };
  return labels[level];
}

function workspaceNotificationLevelDescription(level: WorkspaceNotificationLevel = "all") {
  const descriptions: Record<WorkspaceNotificationLevel, string> = {
    all: "会话有新消息时正常提醒并计入未读。",
    mentions: "只有提到你时重点提醒，普通未读保持安静。",
    muted: "不主动提醒，仍保留未读状态。"
  };
  return descriptions[level];
}

function getWorkspaceRealtimeEvents(envelope: WorkspaceRealtimeEnvelope) {
  const events = envelope.event ? [envelope.event] : Array.isArray(envelope.events) ? envelope.events : [];
  return events.filter((item) => Number.isFinite(item.seq));
}

function formatWorkspaceTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nowLabel();
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function workspaceConversationTitle(conversation: WorkspaceConversation, currentUserId?: string) {
  if (conversation.displayTitle) {
    return conversation.displayTitle;
  }
  if (conversation.type === "direct") {
    const otherMember = conversation.members.find((member) => member.id !== currentUserId);
    return otherMember?.displayName || conversation.title;
  }
  return conversation.title;
}

function workspaceConversationMemberCount(conversation: { memberCount?: number; members: unknown[] }) {
  return conversation.memberCount ?? conversation.members.length;
}

type WorkspaceConversationPreviewInput = Pick<
  WorkspaceConversation,
  "type" | "lastMessagePlainText" | "memberCount" | "members"
> & {
  latestMessages: Array<Pick<WorkspaceMessage, "authorName" | "kind" | "plainText" | "hiddenByCurrentUser">>;
};

export function workspaceConversationPreview(conversation: WorkspaceConversationPreviewInput) {
  const latest = [...conversation.latestMessages].reverse().find((message) => !message.hiddenByCurrentUser);
  const preview = latest?.plainText || conversation.lastMessagePlainText;
  if (preview) {
    const authorName = latest?.authorName?.trim();
    if (conversation.type === "group" && latest?.kind !== "system" && authorName) {
      return `${authorName}：${preview}`;
    }
    return preview;
  }
  return conversation.type === "group"
    ? `${workspaceConversationMemberCount(conversation)} 位成员`
    : "还没有消息";
}

export function workspaceReplyPreview(
  reply?: Pick<WorkspaceMessage, "authorName" | "authorGithubLogin" | "plainText" | "hiddenByCurrentUser"> & { id?: string },
  replyToMessageId = ""
) {
  if (!reply) {
    return replyToMessageId
      ? { messageId: replyToMessageId, author: "", body: "查看引用消息" }
      : undefined;
  }
  const messageId = reply.id || replyToMessageId;
  if (reply.hiddenByCurrentUser) {
    return messageId
      ? { messageId, author: "", body: "已隐藏的消息" }
      : { author: "", body: "已隐藏的消息" };
  }
  const preview = {
    author: reply.authorName || reply.authorGithubLogin || "成员",
    body: reply.plainText
  };
  return messageId ? { messageId, ...preview } : preview;
}



export function clampWorkspaceImageZoom(value: number) {
  return Math.min(4, Math.max(1, Math.round(value * 4) / 4));
}

function workspaceConversationTime(conversation: WorkspaceConversation) {
  return formatWorkspaceConversationTime(
    conversation.lastActivityAt || conversation.latestMessages.at(-1)?.createdAt || conversation.createdAt
  );
}

function workspaceConversationTimestamp(conversation: WorkspaceConversation) {
  return Date.parse(conversation.lastActivityAt || conversation.latestMessages.at(-1)?.createdAt || conversation.createdAt) || 0;
}

function sortWorkspaceConversations(conversations: WorkspaceConversation[]) {
  return [...conversations].sort((left, right) => {
    const activityDelta = workspaceConversationTimestamp(right) - workspaceConversationTimestamp(left);
    if (activityDelta !== 0) return activityDelta;
    return (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
  });
}

function sortWorkspaceFiles(files: WorkspaceFile[]) {
  return [...files].sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
}

function compareWorkspaceMembers(left: WorkspaceUser, right: WorkspaceUser) {
  return left.displayName.localeCompare(right.displayName, "zh-CN");
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...items, item];
}

function upsertWorkspaceMessageList(messages: WorkspaceMessage[], message: WorkspaceMessage, preserveReadingWindow = false) {
  const hasMessage = messages.some(
    (candidate) =>
      candidate.id === message.id ||
      (candidate.clientMessageId && candidate.clientMessageId === message.clientMessageId)
  );
  if (hasMessage) {
    return messages.map((candidate) =>
      candidate.id === message.id ||
      (candidate.clientMessageId && candidate.clientMessageId === message.clientMessageId)
        ? message
        : candidate
    );
  }
  const next = [...messages, message];
  // A live append must not evict the visible head while its older page is
  // pending (or failed). Loaded history already follows the untrimmed path.
  return preserveReadingWindow || messages.length > 20 ? next : next.slice(-20);
}

function mergeWorkspaceConversation(
  local: WorkspaceConversation,
  incoming: WorkspaceConversation,
  messageMergeContext?: WorkspaceMessageWindowMergeContext<WorkspaceMessage>
) {
  return {
    ...incoming,
    latestMessages: mergeWorkspaceMessageWindow(local.latestMessages, incoming.latestMessages, messageMergeContext)
  };
}

function upsertWorkspaceConversationList(
  conversations: WorkspaceConversation[],
  conversation: WorkspaceConversation,
  messageMergeContext?: WorkspaceMessageWindowMergeContext<WorkspaceMessage>
) {
  const hasConversation = conversations.some((item) => item.id === conversation.id);
  return sortWorkspaceConversations(
    hasConversation
      ? conversations.map((item) => item.id === conversation.id
        ? mergeWorkspaceConversation(item, conversation, messageMergeContext)
        : item)
      : [conversation, ...conversations]
  );
}

function mergeWorkspaceConversationList(
  local: WorkspaceConversation[],
  incoming: WorkspaceConversation[],
  messageMergeContexts?: ReadonlyMap<string, WorkspaceMessageWindowMergeContext<WorkspaceMessage>>
) {
  const localById = new Map(local.map((conversation) => [conversation.id, conversation]));
  return sortWorkspaceConversations(
    incoming.map((conversation) => {
      const existing = localById.get(conversation.id);
      return existing
        ? mergeWorkspaceConversation(existing, conversation, messageMergeContexts?.get(conversation.id))
        : conversation;
    })
  );
}

function workspaceFileScope(file: WorkspaceFile, conversations: WorkspaceConversation[]) {
  if (file.visibility === "space") {
    return "空间文件";
  }
  const conversation = conversations.find((item) => item.id === file.conversationId);
  return conversation ? workspaceConversationTitle(conversation) : "会话文件";
}

function workspaceFileUploaderName(file: WorkspaceFile) {
  return file.uploader?.displayName || file.uploaderName;
}

function workspaceFileVisibilityLabel(file: WorkspaceFile) {
  if (file.localUpload?.state === "uploading") {
    return "上传中";
  }
  if (file.localUpload?.state === "failed") {
    return "失败";
  }
  if (file.visibility === "space") {
    return "空间";
  }
  if (file.visibility === "conversation") {
    return "会话";
  }
  if (file.visibility === "private_staging") {
    return "暂存";
  }
  return "文件";
}

function workspaceMemberInitial(name: string) {
  return (name.trim().slice(0, 1) || "?").toUpperCase();
}

function workspaceInviteStatus(invite: WorkspaceInvite) {
  if (invite.revokedAt) {
    return "已撤销";
  }
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
    return "已过期";
  }
  if (invite.uses >= invite.maxUses) {
    return "已用完";
  }
  return "有效";
}

function canRevokeWorkspaceInvite(invite: WorkspaceInvite) {
  return workspaceInviteStatus(invite) === "有效";
}

function formatWorkspaceInviteDate(value?: string | null) {
  if (!value) {
    return "长期有效";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function WorkspaceInviteRow({
  invite,
  onRevoke
}: {
  invite: WorkspaceInvite;
  onRevoke: (invite: WorkspaceInvite) => void;
}) {
  const status = workspaceInviteStatus(invite);
  const hiddenAcceptedMemberCount = Math.max(0, invite.acceptedMemberCount - invite.acceptedMembers.length);
  return (
    <div className="workspace-invite-row">
      <div className="workspace-invite-main">
        <div className="workspace-invite-heading">
          <strong>{invite.codePreview}</strong>
          <span className={`workspace-invite-status ${status === "有效" ? "active" : "history"}`}>{status}</span>
        </div>
        <small>
          {workspaceRoleLabel(invite.defaultRole)} · 已使用 {invite.uses}/{invite.maxUses} · 创建于 {formatWorkspaceInviteDate(invite.createdAt)}
        </small>
        <small>{invite.expiresAt ? `有效至 ${formatWorkspaceInviteDate(invite.expiresAt)}` : "无到期时间"}</small>
        {invite.acceptedMemberCount > 0 && (
          <div className="workspace-invite-acceptances" aria-label="通过此邀请加入的成员">
            <span>已加入</span>
            <div className="workspace-invite-member-list">
              {invite.acceptedMembers.map((member) => (
                <span className="workspace-invite-member" key={member.id} title={`${member.displayName} · ${formatWorkspaceInviteDate(member.acceptedAt)}`}>
                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="tiny" decorative />
                  <span><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></span>
                </span>
              ))}
              {hiddenAcceptedMemberCount > 0 && <em>另有 {hiddenAcceptedMemberCount} 位成员</em>}
            </div>
          </div>
        )}
      </div>
      {canRevokeWorkspaceInvite(invite) && (
        <button className="secondary compact danger-action" type="button" onClick={() => onRevoke(invite)}>
          撤销
        </button>
      )}
    </div>
  );
}

function canRemoveWorkspaceFile(file: WorkspaceFile, currentUser?: WorkspaceUser) {
  if (typeof file.capabilities?.canRemove === "boolean") {
    return file.capabilities.canRemove;
  }
  return Boolean(currentUser && (file.uploaderId === currentUser.id || currentUser.role === "owner" || currentUser.role === "admin"));
}

export function buildWorkspaceMessageBlocks(text: string, mentionMembers: WorkspaceUser[] = []): WorkspaceContentBlock[] {
  const blocks: WorkspaceContentBlock[] = [];
  let cursor = 0;
  const mentionOptions = getWorkspaceMentionOptions(mentionMembers);

  while (cursor < text.length) {
    const nextMention = findNextWorkspaceMention(text, cursor, mentionOptions);
    if (!nextMention) {
      blocks.push({ type: "text", text: text.slice(cursor) });
      break;
    }

    if (nextMention.start > cursor) {
      blocks.push({ type: "text", text: text.slice(cursor, nextMention.start) });
    }
    blocks.push(nextMention.block);
    cursor = nextMention.end;
  }

  return blocks.filter((block) => block.type !== "text" || block.text.length > 0);
}

export function serializeWorkspaceMessageForCopy(message: Pick<Message, "body" | "content" | "attachments">) {
  const blocks = message.content?.blocks ?? [];
  if (blocks.length === 0) return message.body;
  const attachments = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment.fileName]));
  const source = blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label ? `[${block.label}](${block.url})` : block.url;
    if (block.type === "emoji") return block.shortcode.startsWith("custom:")
      ? `[${block.shortcode}]`
      : `:${block.shortcode}:`;
    if (block.type === "attachment") return attachments.get(block.attachmentId) ?? "";
    if (block.type === "emote_collection") {
      const name = block.share?.name || "表情合集";
      return `[${name}](/workspace/emotes/shared/${block.shareId})`;
    }
    return "";
  }).join("");
  return source || message.body;
}

function getWorkspaceEmoteFavoriteSource(message: Pick<Message, "content" | "attachments">) {
  const customBlock = message.content?.blocks.find((block) =>
    block.type === "emoji" && /^custom:[a-f0-9-]{36}$/i.test(block.shortcode)
  );
  if (customBlock?.type === "emoji") {
    return { customEmoteId: customBlock.shortcode.slice("custom:".length) };
  }
  const text = message.content?.blocks
    .filter((block): block is Extract<WorkspaceContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("") ?? "";
  const emoteKey = findFirstImageEmoteKey(text);
  if (emoteKey) return { emoteKey };
  const attachment = message.attachments?.find((item) =>
    item.status === "available" && isPreviewableImageMimeType(item.mimeType)
  );
  return attachment ? { attachmentId: attachment.id } : null;
}

function getWorkspaceMentionOptions(members: WorkspaceUser[]) {
  return members.flatMap((member) => {
    const labels = Array.from(new Set(
      [member.displayName, member.githubLogin].filter((value): value is string => Boolean(value)).map((value) => value.trim())
    ));
    return labels.map((label) => ({
      token: `@${label}`,
      member
    }));
  }).sort((a, b) => b.token.length - a.token.length);
}

function findNextWorkspaceMention(
  text: string,
  cursor: number,
  options: Array<{ token: string; member: WorkspaceUser }>
) {
  let best: { start: number; end: number; block: WorkspaceContentBlock } | null = null;

  for (const option of options) {
    let start = text.indexOf(option.token, cursor);
    while (start !== -1) {
      const end = start + option.token.length;
      if (isWorkspaceMentionBoundary(text[start - 1]) && isWorkspaceMentionBoundary(text[end])) {
        const candidate = {
          start,
          end,
          block: {
            type: "mention",
            userId: option.member.id,
            label: option.member.displayName
          } satisfies WorkspaceContentBlock
        };
        if (!best || candidate.start < best.start || (candidate.start === best.start && candidate.end > best.end)) {
          best = candidate;
        }
        break;
      }
      start = text.indexOf(option.token, start + option.token.length);
    }
  }

  return best;
}

function isWorkspaceMentionBoundary(value?: string) {
  return !value || /[\s,，.。!?！？;；:：()[\]{}"'“”‘’<>]/.test(value);
}


function getConnectionAdvice({
  roomIssue,
  peerCount,
  socketState,
  rtcState,
  mode
}: {
  roomIssue: P2pRoomIssue;
  peerCount: number;
  socketState: ConnectionState;
  rtcState: ConnectionState;
  mode: P2pTransportMode;
}): ConnectionAdvice | null {
  if (roomIssue === "not-found") {
    return {
      title: "房间不存在或已过期",
      body: "这个邀请链接已经不可用。请让发起方重新创建房间，并复制新的邀请链接。",
      items: ["返回后重新创建房间", "确认复制的是最新链接", "房间开启后让双方都保持页面打开"]
    };
  }
  if (roomIssue === "full") {
    return {
      title: "房间已满",
      body: "一对一直连房间只允许两端加入。请确认是否已经有另一端在线，或重新创建一个房间。",
      items: ["关闭多余窗口后重试", "需要新的对象时重新创建房间", "多人协作请改用共享空间"]
    };
  }
  if (mode === "error" || socketState === "error" || rtcState === "error") {
    return {
      title: "连接异常",
      body: "信令或浏览器直连协商暂时失败，系统正在自动重连。当前页面会保留本地消息记录。",
      items: ["双方保持页面打开并等待几秒", "长时间未恢复时重新打开同一链接", "需要稳定保留时上传到共享空间"]
    };
  }
  if (mode === "offline") {
    return {
      title: "对方离线或连接已断开",
      body: "直连会话依赖双方页面同时在线，系统会在页面保持打开时自动尝试恢复连接。",
      items: ["等待对方重新上线并保持页面打开", "长时间未恢复时重新打开同一链接", "重要文件建议上传到共享空间"]
    };
  }
  if (mode === "relay-text" && peerCount >= 2) {
    return {
      title: "文件通道还未就绪",
      body: "文本可以临时通过信令中转，文件需要等待浏览器直连数据通道建立。",
      items: ["双方保持页面打开 10 到 20 秒", "检查浏览器是否禁用了 WebRTC", "仍无法建立时上传到共享空间"]
    };
  }
  if (mode === "waiting") {
    return {
      title: "等待对方加入",
      body: "复制邀请链接给对方。对方打开页面并输入名称后，系统会自动协商直连路径。",
      items: ["确认对方打开的是最新链接", "让对方不要关闭页面", "房间过期后需要重新创建"]
    };
  }
  return null;
}

function transferStatusLabel(status: FileTransferStatus) {
  const labels: Record<FileTransferStatus, string> = {
    offered: "等待确认",
    waiting: "等待对方",
    sending: "发送中",
    receiving: "接收中",
    verifying: "等待校验",
    complete: "已完成",
    rejected: "已拒绝",
    failed: "失败"
  };

  return labels[status];
}

function getFileMessageBody(transfer: FileTransfer) {
  if (transfer.status === "offered") {
    return "收到一个加密文件传输请求。";
  }
  if (transfer.status === "waiting") {
    return "文件请求已发送，等待对方接受。";
  }
  if (transfer.status === "sending") {
    return "正在发送加密文件，请双方保持页面在线。";
  }
  if (transfer.status === "receiving") {
    return "正在接收加密文件，请双方保持页面在线。";
  }
  if (transfer.status === "verifying") {
    return "文件已发送，等待对方完成完整性校验。";
  }
  if (transfer.status === "complete") {
    return "文件传输已完成。";
  }
  if (transfer.status === "rejected") {
    return "文件传输已被拒绝。";
  }
  return transfer.failureReason ? `文件传输失败：${transfer.failureReason}` : "文件传输失败。";
}

function getTransferProgress(doneBytes: number, totalBytes: number) {
  if (totalBytes <= 0) {
    return 100;
  }
  return Math.min(100, Math.round((doneBytes / totalBytes) * 100));
}


function workspaceMemberSecondaryText(member: WorkspaceUser) {
  const details: string[] = [];
  if (member.description) {
    details.push(member.description);
  } else if (member.githubLogin) {
    details.push(`@${member.githubLogin}`);
  }
  if (member.role !== "member") {
    details.push(workspaceMemberRoleLabel(member));
  }
  if (member.kind === "system") {
    details.push(workspaceMemberKindLabel(member.kind));
  }
  return details.join(" · ");
}


export function isWorkspaceEmoteCollectionReadOnly(
  collection: { sourceSubscription?: { readOnly?: boolean } | null } | null | undefined
) {
  return collection?.sourceSubscription?.readOnly === true;
}

export function shouldShowWorkspaceEmoteSourceSubscription(
  subscription: { eligible: boolean; status: "off" | "synced" | "detached" } | null | undefined
) {
  return Boolean(subscription && (subscription.eligible || subscription.status === "detached"));
}

export function workspaceEmoteLibraryTotalItemCount(usage: {
  itemCount: number;
  subscribedItemCount?: number;
}) {
  return usage.itemCount + (usage.subscribedItemCount ?? 0);
}

function getWorkspaceTransferQuotaWarning(
  byteSize: number,
  direction: WorkspaceTransferDirection,
  policy?: WorkspacePolicy
) {
  if (!policy || byteSize <= 0) {
    return "";
  }
  const remaining =
    typeof policy.remainingQuotaBytes === "number" && Number.isFinite(policy.remainingQuotaBytes)
      ? Math.max(0, policy.remainingQuotaBytes)
      : null;
  const dailyLimit =
    typeof policy.dailyQuotaBytes === "number" && Number.isFinite(policy.dailyQuotaBytes)
      ? Math.max(0, policy.dailyQuotaBytes)
      : null;
  const comparableQuota = remaining ?? dailyLimit;
  if (comparableQuota === null || byteSize <= comparableQuota) {
    return "";
  }
  const action = direction === "download" ? "下载" : "上传";
  const quotaText = remaining === null ? `单日上限 ${formatBytes(comparableQuota)}` : `今日还可传输 ${formatBytes(comparableQuota)}`;
  return `今日传输额度不足，无法${action}此文件。此文件 ${formatBytes(byteSize)}，${quotaText}。`;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function waitForBufferedAmount(channel: RTCDataChannel) {
  if (channel.readyState !== "open" || channel.bufferedAmount < 1024 * 1024) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      if (channel.readyState !== "open" || channel.bufferedAmount < 512 * 1024) {
        window.clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

function getFileRiskNote(fileSize: number) {
  if (fileSize >= P2P_LARGE_FILE_WARNING_BYTES) {
    return `大文件 ${formatBytes(fileSize)} 对网络稳定性要求较高，中断后需要重新发送。`;
  }
  return undefined;
}

function getFileLimitText() {
  return `当前直连通道建议单个文件不超过 ${formatBytes(P2P_MAX_FILE_BYTES)}。`;
}

function sanitizeMessagesForStorage(messages: Message[]) {
  return messages.map((message) => ({
    ...message,
    fileTransfer: message.fileTransfer
      ? {
          ...message.fileTransfer,
          downloadUrl: undefined
        }
      : undefined
  }));
}

function getSavedP2pSessions(): SavedP2pSession[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  const sessions: SavedP2pSession[] = [];
  try {
    const stored = localStorage.getItem(P2P_SAVED_SESSIONS_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      for (const session of parsed) {
        if (
          session &&
          typeof session.id === "string" &&
          typeof session.roomId === "string" &&
          typeof session.savedAt === "string" &&
          Array.isArray(session.messages)
        ) {
          sessions.push({
            id: session.id,
            roomId: session.roomId,
            displayName: typeof session.displayName === "string" ? session.displayName : "本机",
            savedAt: session.savedAt,
            messages: session.messages as Message[]
          });
        }
      }
    }
  } catch {
    // Ignore malformed local records and keep the UI usable.
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || key === P2P_SAVED_SESSIONS_KEY || !key.startsWith("duallane-p2p-")) {
      continue;
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(parsed)) {
        continue;
      }
      const roomId = key.replace("duallane-p2p-", "") || "legacy";
      const legacyId = `legacy-${roomId}`;
      if (!sessions.some((session) => session.id === legacyId)) {
        sessions.push({
          id: legacyId,
          roomId,
          displayName: "本机",
          savedAt: new Date(0).toISOString(),
          messages: parsed as Message[]
        });
      }
    } catch {
      // Ignore malformed legacy records.
    }
  }

  return sessions.sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt));
}

function writeSavedP2pSessions(sessions: SavedP2pSession[]) {
  localStorage.setItem(P2P_SAVED_SESSIONS_KEY, JSON.stringify(sessions));
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    return "早期记录";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
}


export type WorkspaceMarkdownFormat =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inline-code"
  | "quote"
  | "unordered-list"
  | "ordered-list"
  | "link"
  | "code-block"
  | "divider";

export type WorkspaceMarkdownEdit = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

function workspaceMarkdownSelection(value: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(value.length, Math.min(selectionStart, selectionEnd)));
  const end = Math.max(start, Math.min(value.length, Math.max(selectionStart, selectionEnd)));
  return { start, end };
}

function wrapWorkspaceMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
  suffix: string,
  placeholder: string
): WorkspaceMarkdownEdit {
  const { start, end } = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const content = value.slice(start, end) || placeholder;
  return {
    value: value.slice(0, start) + prefix + content + suffix + value.slice(end),
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + content.length
  };
}

function prefixWorkspaceMarkdownLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefixForLine: (index: number) => string
): WorkspaceMarkdownEdit {
  const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const lineStart = value.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const nextLineBreak = value.indexOf("\n", selection.end);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  const formatted = value
    .slice(lineStart, lineEnd)
    .split("\n")
    .map((line, index) => prefixForLine(index) + line)
    .join("\n");
  return {
    value: value.slice(0, lineStart) + formatted + value.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + formatted.length
  };
}

export function applyWorkspaceMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: WorkspaceMarkdownFormat
): WorkspaceMarkdownEdit {
  if (format === "bold") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "**", "**", "粗体文本");
  }
  if (format === "italic") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "*", "*", "斜体文本");
  }
  if (format === "strikethrough") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "~~", "~~", "删除线文本");
  }
  if (format === "inline-code") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "`", "`", "代码");
  }
  if (format === "code-block") {
    return wrapWorkspaceMarkdownSelection(value, selectionStart, selectionEnd, "~~~\n", "\n~~~", "代码");
  }
  if (format === "quote") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, () => "> ");
  }
  if (format === "unordered-list") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, () => "- ");
  }
  if (format === "ordered-list") {
    return prefixWorkspaceMarkdownLines(value, selectionStart, selectionEnd, (index) => String(index + 1) + ". ");
  }
  if (format === "divider") {
    const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
    const before = value.slice(0, selection.start).replace(/\s*$/, "");
    const after = value.slice(selection.end).replace(/^\s*/, "");
    const prefix = before ? "\n\n" : "";
    const suffix = after ? "\n\n" : "";
    const inserted = `${prefix}---${suffix}`;
    return {
      value: before + inserted + after,
      selectionStart: before.length + prefix.length + 3,
      selectionEnd: before.length + prefix.length + 3
    };
  }

  const selection = workspaceMarkdownSelection(value, selectionStart, selectionEnd);
  const label = value.slice(selection.start, selection.end) || "链接文本";
  const prefix = "[" + label + "](";
  const url = "https://";
  return {
    value: value.slice(0, selection.start) + prefix + url + ")" + value.slice(selection.end),
    selectionStart: selection.start + prefix.length,
    selectionEnd: selection.start + prefix.length + url.length
  };
}

export function applyWorkspaceReactionOptimistic(
  groups: WorkspaceReactionGroup[],
  emoteKey: string,
  user: WorkspaceReactionUser
) {
  const existing = groups.find((group) => group.emoteKey === emoteKey);
  if (existing?.reactedByCurrentUser) {
    return groups
      .map((group) => {
        if (group.emoteKey !== emoteKey) {
          return group;
        }
        const users = group.users.filter((candidate) => candidate.id !== user.id);
        return {
          ...group,
          count: users.length,
          reactedByCurrentUser: false,
          users
        };
      })
      .filter((group) => group.count > 0);
  }
  if (existing) {
    return groups.map((group) =>
      group.emoteKey === emoteKey
        ? {
            ...group,
            count: group.users.some((candidate) => candidate.id === user.id)
              ? group.users.length
              : group.users.length + 1,
            reactedByCurrentUser: true,
            users: group.users.some((candidate) => candidate.id === user.id)
              ? group.users
              : [...group.users, user]
          }
        : group
    );
  }
  return [
    ...groups,
    {
      emoteKey,
      count: 1,
      reactedByCurrentUser: true,
      users: [user]
    }
  ];
}

export function shouldApplyWorkspaceReactionResponse(currentEventSeq: number, eventSeqAtRequest: number) {
  return currentEventSeq <= eventSeqAtRequest;
}
export function App() {
  const { confirm: confirmCommand, cancelPending: cancelPendingCommand } = useConfirmation();
  async function confirm(message: string) {
    const sessionEpoch = workspaceSessionEpochRef.current;
    return await confirmCommand(message) && sessionEpoch === workspaceSessionEpochRef.current;
  }
  const initialParsedRouteRef = useRef<ReturnType<typeof parseAppRoute> | null>(null);
  if (!initialParsedRouteRef.current) {
    initialParsedRouteRef.current = parseAppRoute(window.location.pathname, window.location.search, window.location.hash);
  }
  const initialParsedRoute = initialParsedRouteRef.current;
  const initialRoute = initialParsedRoute.route;
  const initialRoomId = initialRoute.kind === "direct" ? initialRoute.roomId : "";
  const initialRoomSecret = initialRoute.kind === "direct" && initialRoomId ? getRoomSecretFromHash() : "";
  const initialWorkspaceRoute = initialRoute.kind === "workspace" ? initialRoute : null;
  const appearance = useAppearance();
  const themeMode = appearance.preferences.mode;
  const resolvedTheme = appearance.resolved.mode;
  const setThemeMode = (mode: ThemeMode) => { appearance.setPreferences({ mode }); };
  const navigation = useNavigationGuard();
  const settingsGuardRef = useRef<NavigationGuard | null>(null);
  const registerSettingsGuard = useCallback((guard: NavigationGuard | null) => {
    settingsGuardRef.current = guard;
    navigation.register(guard);
  }, [navigation.register]);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const routeIndexRef = useRef(0);
  const routeUrlRef = useRef(window.location.pathname + window.location.search + window.location.hash);
  const historyResumeRef = useRef<null | (() => void)>(null);
  const historyIgnoreRef = useRef(false);
  const [lane, setLane] = useState<Lane>(() => routeLane(initialRoute));
  const [p2pStep, setP2pStep] = useState<P2pStep>(() => initialRoomId && !initialRoomSecret ? "invalid-room" : "name");
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState(initialRoomId);
  const [inviteLink, setInviteLink] = useState(() => initialRoomId && initialRoomSecret
    ? withRoomSecret(getInviteLink(initialRoomId), initialRoomSecret)
    : "");
  const p2pCreateInFlightRef = useRef(false);
  const [p2pCreating, setP2pCreating] = useState(false);
  const [p2pStatus, setP2pStatus] = useState<ConnectionState>("idle");
  const [p2pError, setP2pError] = useState("");
  const [p2pRoomIssue, setP2pRoomIssue] = useState<P2pRoomIssue>(() => initialRoomId && !initialRoomSecret ? "missing-key" : "");
  const [roomSecret, setRoomSecret] = useState(initialRoomSecret);
  const [securityPassphrase, setSecurityPassphrase] = useState("");
  const [p2pParticipantCount, setP2pParticipantCount] = useState(P2P_DEFAULT_PARTICIPANTS);
  const [verificationCode, setVerificationCode] = useState("");
  const [p2pMessages, setP2pMessages] = useState<Message[]>([]);
  const [p2pDraft, setP2pDraft] = useState("");
  const [sessionSaved, setSessionSaved] = useState<"idle" | "saved">("idle");
  const [savedP2pSessions, setSavedP2pSessions] = useState<SavedP2pSession[]>(() => getSavedP2pSessions());
  const [selectedSavedSessionId, setSelectedSavedSessionId] = useState("");
  const [savedSessionsOpen, setSavedSessionsOpen] = useState(false);
  const [p2pPeers, setP2pPeers] = useState<Peer[]>([]);
  const [p2pSocketState, setP2pSocketState] = useState<ConnectionState>("idle");
  const [p2pRtcState, setP2pRtcState] = useState<ConnectionState>("idle");
  const [p2pDataChannelState, setP2pDataChannelState] = useState<DataChannelState>("idle");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [roomDetailsOpen, setRoomDetailsOpen] = useState(false);
  const [workspaceBootstrap, setWorkspaceBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [workspaceChatSettings, setWorkspaceChatSettings] = useState<{
    userId: string; preferences: WorkspaceAutoHidePreferences; replyAutoMention: boolean;
  } | null>(null);
  const currentChatSettings = workspaceChatSettings?.userId === workspaceBootstrap?.auth.currentUser.id ? workspaceChatSettings : null;
  const workspaceReplyAutoMention = currentChatSettings?.replyAutoMention ?? false;
  const workspaceAutoHidePreferences = currentChatSettings?.preferences ?? null;
  const [workspaceChatSettingsRevision, setWorkspaceChatSettingsRevision] = useState(0);
  const [workspaceStatistics, setWorkspaceStatistics] = useState<WorkspaceStatistics | null>(null);
  const [workspaceStatisticsLoading, setWorkspaceStatisticsLoading] = useState(false);
  const [workspaceStatisticsError, setWorkspaceStatisticsError] = useState("");
  const [workspaceConversations, setWorkspaceConversations] = useState<WorkspaceConversation[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceLibraryFiles, setWorkspaceLibraryFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceDirectoryMembers, setWorkspaceDirectoryMembers] = useState<WorkspaceUser[]>([]);
  const [workspaceSelectedConversationId, setWorkspaceSelectedConversationId] = useState(initialWorkspaceRoute?.conversationId ?? "");
  const [workspaceSelectedTopicId, setWorkspaceSelectedTopicId] = useState(initialWorkspaceRoute?.topicId ?? "");
  const [workspaceTopicLocateRequest, setWorkspaceTopicLocateRequest] = useState<{ topicId: string; messageId: string } | null>(null);
  const [workspaceTopicRefreshSignal, setWorkspaceTopicRefreshSignal] = useState<WorkspaceTopicRefreshSignal>({
    version: 0,
    listVersion: 0,
    topicVersions: {},
    conversationVersions: {}
  });
  const [workspaceConversationTopicsById, setWorkspaceConversationTopicsById] = useState<Record<string, Array<Pick<WorkspaceTopic, "id" | "title" | "status">>>>({});

  const [workspaceCardRevisionById, setWorkspaceCardRevisionById] = useState<Record<string, number>>({});
  const [workspaceDraftByConversation, setWorkspaceDraftByConversation] = useState<Record<string, WorkspaceComposerDocument>>({});
  const [workspaceEchoInteractionByConversation, setWorkspaceEchoInteractionByConversation] = useState<
    Record<string, WorkspaceEchoInteractionSlot>
  >({});
  const workspaceEchoInteractionByConversationRef = useRef<Record<string, WorkspaceEchoInteractionSlot>>({});
  const [workspaceReplyToMessageIdByConversation, setWorkspaceReplyToMessageIdByConversation] = useState<Record<string, string>>({});
  const [workspaceComposerAttachmentsByConversation, setWorkspaceComposerAttachmentsByConversation] = useState<
    Record<string, WorkspaceComposerAttachment[]>
  >({});
  const [workspaceUnreadAnchorByConversation, setWorkspaceUnreadAnchorByConversation] = useState<
    Record<string, { messageId?: string | null; count: number }>
  >({});
  const [workspaceNewMessageCountByConversation, setWorkspaceNewMessageCountByConversation] = useState<Record<string, number>>({});
  const [workspaceAwayFromLatestByConversation, setWorkspaceAwayFromLatestByConversation] = useState<Record<string, boolean>>({});
  const [workspaceScrollToLatestRequest, setWorkspaceScrollToLatestRequest] = useState(0);
  const [workspaceLocalMessages, setWorkspaceLocalMessages] = useState<WorkspaceLocalMessage[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = useState<"idle" | "loading" | "ready" | "disabled" | "auth" | "error">("idle");
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceNotice, setWorkspaceNotice] = useState<WorkspaceNotice | null>(null);
  const [workspacePendingInviteCode, setWorkspacePendingInviteCode] = useState(initialWorkspaceRoute?.inviteCode ?? "");
  const [workspaceInviteCode, setWorkspaceInviteCode] = useState("");
  const [workspaceInviteCodeId, setWorkspaceInviteCodeId] = useState("");
  const [workspaceNewGroupTitle, setWorkspaceNewGroupTitle] = useState("");
  const [workspaceNewGroupAvatarEmoji, setWorkspaceNewGroupAvatarEmoji] = useState("");
  const [workspaceGroupRenameTitle, setWorkspaceGroupRenameTitle] = useState("");
  const [workspaceGroupAvatarEmoji, setWorkspaceGroupAvatarEmoji] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => workspaceViewFromRoute(initialWorkspaceRoute));
  const [workspaceMobilePane, setWorkspaceMobilePane] = useState<WorkspaceMobilePane>("list");
  const [workspaceRailCollapsed, setWorkspaceRailCollapsed] = useState(false);
  const [workspaceMemberPickerOpen, setWorkspaceMemberPickerOpen] = useState(false);
  const workspaceMemberPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const [workspaceContextMode, setWorkspaceContextMode] = useState<WorkspaceContextMode>("conversation");
  const [workspaceContextCollapsed, setWorkspaceContextCollapsed] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(WORKSPACE_CONTEXT_STORAGE_KEY) !== "true"
  );
  const [workspaceContextTab, setWorkspaceContextTab] = useState<WorkspaceContextTab>("overview");
  const [workspaceSpaceTab, setWorkspaceSpaceTab] = useState<WorkspaceSpaceTab>(initialWorkspaceRoute?.spaceTab ?? "overview");
  const [workspaceRoleMemberQuery, setWorkspaceRoleMemberQuery] = useState("");
  const [workspaceVisibilityMemberQuery, setWorkspaceVisibilityMemberQuery] = useState("");
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<WorkspaceCreateMode>(initialWorkspaceRoute?.createMode ?? "");
  const [workspaceAccountSection, setWorkspaceAccountSection] = useState(initialWorkspaceRoute?.accountSection ?? "");
  const [workspaceEmoteManagerOpen, setWorkspaceEmoteManagerOpen] = useState(false);
  const closeWorkspaceEmoteManager = useCallback(() => setWorkspaceEmoteManagerOpen(false), []);
  const [workspaceSetupSessionId, setWorkspaceSetupSessionId] = useState(initialWorkspaceRoute?.setupSessionId ?? "");
  const [workspaceSharedEmoteCollectionId, setWorkspaceSharedEmoteCollectionId] = useState(
    initialWorkspaceRoute?.sharedEmoteCollectionId ?? ""
  );
  const [workspaceMemberQuery, setWorkspaceMemberQuery] = useState("");
  const [workspacePickerMemberQuery, setWorkspacePickerMemberQuery] = useState("");
  const [workspaceContextMemberQuery, setWorkspaceContextMemberQuery] = useState("");
  const [workspaceConversationQuery, setWorkspaceConversationQuery] = useState("");
  const [workspaceFileQuery, setWorkspaceFileQuery] = useState("");
  const [workspaceMemberRoleFilter, setWorkspaceMemberRoleFilter] = useState<WorkspaceMemberRoleFilter>("all");
  const [workspaceMemberKindFilter, setWorkspaceMemberKindFilter] = useState<WorkspaceMemberKindFilter>("all");
  const [workspaceVisibilityViewerId, setWorkspaceVisibilityViewerId] = useState("");
  const [workspaceMemberVisibility, setWorkspaceMemberVisibility] = useState<WorkspaceMemberVisibility | null>(null);
  const [workspaceVisibilityLoading, setWorkspaceVisibilityLoading] = useState(false);
  const [workspaceVisibilitySaving, setWorkspaceVisibilitySaving] = useState(false);
  const workspaceVisibilityViewerRef = useRef(workspaceVisibilityViewerId);
  const workspaceVisibilityActorRef = useRef(workspaceBootstrap?.auth.currentUser.id ?? "");
  const workspaceCanManageVisibilityRef = useRef(Boolean(workspaceBootstrap?.permissions.canManageMemberVisibility));
  const workspaceVisibilityRequestRef = useRef(0);
  const workspaceVisibilitySaveRef = useRef<object | null>(null);
  workspaceVisibilityViewerRef.current = workspaceVisibilityViewerId;
  workspaceVisibilityActorRef.current = workspaceBootstrap?.auth.currentUser.id ?? "";
  workspaceCanManageVisibilityRef.current = Boolean(workspaceBootstrap?.permissions.canManageMemberVisibility);
  const [workspaceGroupMemberIds, setWorkspaceGroupMemberIds] = useState<string[]>([]);
  const [workspaceFileFilter, setWorkspaceFileFilter] = useState<WorkspaceFileFilter>("all");
  const [workspaceFileCategory, setWorkspaceFileCategory] = useState<WorkspaceFileCategory>("all");
  const [workspaceFileViewMode, setWorkspaceFileViewMode] = useState<WorkspaceFileViewMode>("list");
  const [workspaceContextFileCategory, setWorkspaceContextFileCategory] = useState<WorkspaceFileCategory>("all");
  const [workspaceContextFileViewMode, setWorkspaceContextFileViewMode] = useState<WorkspaceFileViewMode>("list");
  const [workspaceSelectedFileId, setWorkspaceSelectedFileId] = useState(initialWorkspaceRoute?.fileId ?? "");
  const [workspaceSelectedMemberId, setWorkspaceSelectedMemberId] = useState(initialWorkspaceRoute?.memberId ?? "");
  const [workspaceUploading, setWorkspaceUploading] = useState(false);
  const [workspaceGroupMemberBusyId, setWorkspaceGroupMemberBusyId] = useState("");
  const [workspaceRealtimeState, setWorkspaceRealtimeState] = useState<WorkspaceRealtimeState>("idle");
  const [workspaceCreateMenuOpen, setWorkspaceCreateMenuOpen] = useState(false);
  const [workspaceUserMenuOpen, setWorkspaceUserMenuOpen] = useState(false);
  const [workspaceMemberFilterOpen, setWorkspaceMemberFilterOpen] = useState(false);
  const [workspaceReactionPendingKeys, setWorkspaceReactionPendingKeys] = useState<string[]>([]);
  const [workspacePinsByConversation, setWorkspacePinsByConversation] = useState<Record<string, WorkspacePinnedMessage[]>>({});
  const [workspacePinsExpandedByConversation, setWorkspacePinsExpandedByConversation] = useState<Record<string, boolean>>({});
  const [workspaceHistoryTargetId, setWorkspaceHistoryTargetId] = useState("");
  const [workspaceMessageLocateTarget, setWorkspaceMessageLocateTarget] = useState<{ messageId: string; sequence: number } | null>(null);
  const [workspaceReturningToLatestConversationId, setWorkspaceReturningToLatestConversationId] = useState("");
  const [workspaceImagePreview, setWorkspaceImagePreview] = useState<WorkspaceAttachment | null>(null);
  const [workspaceImageZoom, setWorkspaceImageZoom] = useState(1);
  const [workspaceEmoteCollectionPreviewId, setWorkspaceEmoteCollectionPreviewId] = useState("");
  const [serverAppVersion, setServerAppVersion] = useState("");
  const [versionUpdateDismissed, setVersionUpdateDismissed] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [workspaceHistoryLoadingByConversation, setWorkspaceHistoryLoadingByConversation] = useState<Record<string, boolean>>({});
  const [workspaceHistoryExhaustedByConversation, setWorkspaceHistoryExhaustedByConversation] = useState<Record<string, boolean>>({});
  const localDisplayName = displayName.trim() || "访客";
  const wsRef = useRef<WebSocket | null>(null);
  const workspaceWsRef = useRef<WebSocket | null>(null);
  const workspaceRealtimeSeqRef = useRef(0);
  const workspaceNoticeSeqRef = useRef(0);
  const workspaceSeenEventIdsRef = useRef<Set<string>>(new Set());
  const workspaceRealtimeEventQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSendingRef = useRef(false);
  const workspaceReactionLocksRef = useRef<Set<string>>(new Set());
  const workspaceReactionEventSeqRef = useRef<Map<string, number>>(new Map());
  const workspaceSessionEpochRef = useRef(0);
  const workspaceAccessEpochRef = useRef(0);
  const workspaceBootstrapRequestGenerationRef = useRef(0);
  const workspaceCanReadConversationsRef = useRef(false);
  const workspaceCanDownloadRef = useRef(false);
  const workspaceConversationsRef = useRef<WorkspaceConversation[]>([]);
  const workspaceConversationMembershipEpochRef = useRef<Map<string, number>>(new Map());
  const workspaceConversationHistoryEpochRef = useRef<Map<string, number>>(new Map());
  const workspaceConversationMessageRevisionRef = useRef<Map<string, number>>(new Map());
  const workspaceConversationListRequestTokenRef = useRef(0);
  const workspaceConversationResponseGenerationRef = useRef<
    Map<string, Map<WorkspaceConversationMessageRequest["kind"], number>>
  >(new Map());
  const versionCheckInFlightRef = useRef(false);
  const versionCheckAbortControllerRef = useRef<AbortController | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const secureKeysRef = useRef<SecureKeys | null>(null);
  const peerIdRef = useRef("");
  const p2pPeersRef = useRef<Peer[]>([]);
  const peerProfilesRef = useRef<Map<string, string>>(new Map());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const p2pDataMessageQueueRef = useRef<Promise<void>>(Promise.resolve());
  const p2pSessionGenerationRef = useRef(0);
  const pendingP2pMessageTimersRef = useRef<Map<string, number>>(new Map());
  const pendingP2pMessageAttemptsRef = useRef<Map<string, number>>(new Map());
  const pendingP2pFileAckTimersRef = useRef<Map<string, number>>(new Map());
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  const cancelledP2pFileTransfersRef = useRef<Set<string>>(new Set());
  const incomingFilesRef = useRef<Map<string, IncomingFileBuffer>>(new Map());
  const p2pDownloadUrlsRef = useRef<Map<string, string>>(new Map());
  const p2pMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceCreateSearchInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceCreateMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceCreateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceUserMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceUserTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMemberFilterRef = useRef<HTMLDivElement | null>(null);
  const workspaceMemberFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceImageViewerRef = useRef<HTMLDivElement | null>(null);
  const workspaceImageCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceLoadingRef = useRef(false);
  const workspacePrependScrollRef = useRef<{
    conversationId: string;
    request: WorkspaceConversationMessageRequest;
    prependedMessageId: string;
    list: HTMLDivElement;
    top: number;
    height: number;
    anchor?: { element: HTMLElement; offset: number };
  } | null>(null);
  const workspaceStickToBottomRef = useRef(true);
  const workspaceScrolledConversationIdRef = useRef("");
  const workspaceScrollPositionsRef = useRef<Map<string, number>>(new Map());
  const workspaceStickToBottomByConversationRef = useRef<Map<string, boolean>>(new Map());
  const workspaceScrollIntentUntilRef = useRef(0);
  const workspaceHandledScrollToLatestRequestRef = useRef(0);
  const workspaceUploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const workspaceComposerAttachmentsRef = useRef<Record<string, WorkspaceComposerAttachment[]>>({});
  const workspaceLocalMessagesRef = useRef<WorkspaceLocalMessage[]>([]);
  const workspaceCancelledLocalMessageIdsRef = useRef<Set<string>>(new Set());
  const workspaceMarkReadInFlightRef = useRef<Set<string>>(new Set());
  const workspaceSelectedConversationIdRef = useRef("");
  const workspaceCurrentUserIdRef = useRef("");
  const p2pConnectionState = getO2OState(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pTransportMode = getP2pTransportMode(p2pPeers.length, p2pSocketState, p2pRtcState);
  const p2pCanTransferFiles = p2pDataChannelState === "open";
  const canStartPeerSession = Boolean(roomId && roomSecret && verificationCode);
  const selectedSavedSession = savedP2pSessions.find((session) => session.id === selectedSavedSessionId);
  const p2pRoomIssueTitle =
    p2pRoomIssue === "missing-key"
      ? "邀请链接不完整。"
      : p2pRoomIssue === "full"
        ? "房间已满。"
        : "房间不存在或已过期。";
  const p2pRoomIssueText =
    p2pRoomIssue === "missing-key"
      ? "这个邀请链接缺少安全密钥。请让发起方重新复制完整链接，确认链接包含 #k=... 后再打开。"
      : p2pRoomIssue === "full"
      ? "一对一直连房间只允许两端加入。请关闭多余窗口后重试，或重新创建房间。"
      : "这个邀请链接已经无法加入。请重新创建房间，并把新的邀请链接发给对方。";
  const connectionAdvice = useMemo(
    () =>
      getConnectionAdvice({
        roomIssue: p2pRoomIssue,
        peerCount: p2pPeers.length,
        socketState: p2pSocketState,
        rtcState: p2pRtcState,
        mode: p2pTransportMode
      }),
    [p2pPeers.length, p2pRoomIssue, p2pRtcState, p2pSocketState, p2pTransportMode]
  );
  const roomDetails = useMemo<RoomDetail[]>(
    () => [
      { label: "房间 ID", value: roomId || "本地预览" },
      { label: "安全校验码", value: verificationCode || "等待密钥" },
      { label: "你", value: localDisplayName },
      { label: "信令", value: connectionStateLabel(p2pSocketState) },
      { label: "直连数据通道", value: connectionStateLabel(p2pRtcState) },
      { label: "消息路径", value: p2pTransportModeDescription(p2pTransportMode, p2pPeers.length) },
      {
        label: "文件路径",
        value: p2pCanTransferFiles
          ? "浏览器直连文件传输可用。"
          : p2pDataChannelState === "connecting"
            ? "文件通道正在打开。"
            : "等待直连数据通道。"
      },
      {
        label: "保存方式",
        value:
          "支持的浏览器会询问保存位置。其他浏览器会按下载设置保存。"
      }
    ],
    [
      localDisplayName,
      p2pCanTransferFiles,
      p2pDataChannelState,
      p2pPeers,
      p2pRtcState,
      p2pSocketState,
      p2pTransportMode,
      roomId,
      verificationCode
    ]
  );
  const workspaceSelectedConversation = workspaceConversations.find(
    (conversation) => conversation.id === workspaceSelectedConversationId
  );

  function currentWorkspaceConversationEpoch(
    epochs: Map<string, number>,
    conversationId: string
  ) {
    return epochs.get(conversationId) ?? 0;
  }

  function advanceWorkspaceConversationEpoch(
    epochs: Map<string, number>,
    conversationId: string
  ) {
    if (!conversationId) return;
    epochs.set(conversationId, currentWorkspaceConversationEpoch(epochs, conversationId) + 1);
  }

  function advanceWorkspaceAccessEpoch() {
    workspaceAccessEpochRef.current += 1;
  }

  function invalidateWorkspaceConversationAccess(conversationId?: string, removeConversation = true) {
    advanceWorkspaceAccessEpoch();
    if (conversationId) {
      advanceWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversationId);
      workspaceMarkReadInFlightRef.current.delete(conversationId);
      setWorkspaceHistoryLoadingByConversation((current) => {
        if (!(conversationId in current)) return current;
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      });
      if (removeConversation) {
        workspaceConversationsRef.current = workspaceConversationsRef.current.filter((item) => item.id !== conversationId);
      }
      return;
    }
    for (const conversation of workspaceConversationsRef.current) {
      advanceWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversation.id);
    }
    workspaceMarkReadInFlightRef.current.clear();
    workspaceConversationsRef.current = [];
  }

  function clearWorkspaceConversationAccessState() {
    invalidateWorkspaceConversationAccess();
    for (const controller of workspaceUploadControllersRef.current.values()) {
      controller.abort();
    }
    workspaceUploadControllersRef.current.clear();
    for (const attachments of Object.values(workspaceComposerAttachmentsRef.current)) {
      for (const attachment of attachments) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    }
    for (const message of workspaceLocalMessagesRef.current) {
      workspaceCancelledLocalMessageIdsRef.current.add(message.id);
      for (const attachment of message.pendingAttachments ?? []) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    }
    workspaceComposerAttachmentsRef.current = {};
    workspaceLocalMessagesRef.current = [];
    workspaceSelectedConversationIdRef.current = "";
    setWorkspaceConversations([]);
    setWorkspaceSelectedConversationId("");
    setWorkspaceConversationTopicsById({});

    setWorkspaceDraftByConversation({});
    setWorkspaceReplyToMessageIdByConversation({});
    setWorkspaceComposerAttachmentsByConversation({});
    setWorkspacePinsByConversation({});
    setWorkspacePinsExpandedByConversation({});
    setWorkspaceHistoryTargetId("");
    setWorkspaceMessageLocateTarget(null);
    setWorkspaceReturningToLatestConversationId("");
    setWorkspaceUnreadAnchorByConversation({});
    setWorkspaceNewMessageCountByConversation({});
    setWorkspaceAwayFromLatestByConversation({});
    setWorkspaceLocalMessages([]);
    setWorkspaceSelectedFileId("");
    setWorkspaceImagePreview(null);
    setWorkspaceHistoryLoadingByConversation({});
    setWorkspaceHistoryExhaustedByConversation({});
  }

  function advanceWorkspaceConversationMessageRevision(conversationId: string) {
    if (!conversationId) return;
    const revision = workspaceConversationMessageRevisionRef.current.get(conversationId) ?? 0;
    workspaceConversationMessageRevisionRef.current.set(conversationId, revision + 1);
  }

  function nextWorkspaceConversationResponseGeneration(
    conversationId: string,
    kind: WorkspaceConversationMessageRequest["kind"]
  ) {
    const generations = workspaceConversationResponseGenerationRef.current.get(conversationId) ??
      new Map<WorkspaceConversationMessageRequest["kind"], number>();
    const generation = (generations.get(kind) ?? 0) + 1;
    generations.set(kind, generation);
    workspaceConversationResponseGenerationRef.current.set(conversationId, generations);
    return generation;
  }

  function beginWorkspaceConversationMessageRequest(
    conversationId: string,
    kind: WorkspaceConversationMessageRequest["kind"],
    invalidatesHistory = false
  ): WorkspaceConversationMessageRequest {
    const generation = nextWorkspaceConversationResponseGeneration(conversationId, kind);
    if (shouldAdvanceWorkspaceConversationHistoryEpoch(kind, invalidatesHistory)) {
      advanceWorkspaceConversationEpoch(workspaceConversationHistoryEpochRef.current, conversationId);
    }
    const conversation = workspaceConversationsRef.current.find((item) => item.id === conversationId);
    return {
      kind,
      baselineMessages: conversation ? [...conversation.latestMessages] : [],
      requestRevision: workspaceConversationMessageRevisionRef.current.get(conversationId) ?? 0,
      requestGeneration: generation,
      sessionEpoch: workspaceSessionEpochRef.current,
      accessEpoch: workspaceAccessEpochRef.current,
      membershipEpoch: currentWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversationId),
      historyEpoch: currentWorkspaceConversationEpoch(workspaceConversationHistoryEpochRef.current, conversationId)
    };
  }

  function workspaceConversationMessageMergeContext(
    conversationId: string,
    request: WorkspaceConversationMessageRequest
  ): WorkspaceMessageWindowMergeContext<WorkspaceMessage> {
    return {
      baselineMessages: request.baselineMessages,
      requestRevision: request.requestRevision,
      currentRevision: workspaceConversationMessageRevisionRef.current.get(conversationId) ?? 0,
      requestGeneration: request.requestGeneration,
      latestGeneration: workspaceConversationResponseGenerationRef.current.get(conversationId)?.get(request.kind) ?? request.requestGeneration
    };
  }

  function isCurrentWorkspaceConversationMessageRequest(
    conversationId: string,
    request: WorkspaceConversationMessageRequest,
    requireConversation = true
  ) {
    if (request.sessionEpoch !== workspaceSessionEpochRef.current) return false;
    if (!isWorkspaceConversationAccessCurrent(request.accessEpoch, workspaceAccessEpochRef.current)) return false;
    if (
      request.membershipEpoch !== currentWorkspaceConversationEpoch(
        workspaceConversationMembershipEpochRef.current,
        conversationId
      )
    ) {
      return false;
    }
    if (
      (request.kind === "messages" || request.kind === "around" || request.kind === "history") &&
      request.historyEpoch !== currentWorkspaceConversationEpoch(workspaceConversationHistoryEpochRef.current, conversationId)
    ) {
      return false;
    }
    if (requireConversation && !workspaceConversationsRef.current.some((item) => item.id === conversationId)) {
      return false;
    }
    return workspaceConversationResponseGenerationRef.current.get(conversationId)?.get(request.kind) === request.requestGeneration;
  }

  useEffect(() => {
    const userId = workspaceBootstrap?.auth.currentUser.id;
    if (!userId) {
      setWorkspaceChatSettings(null);
      return;
    }
    let cancelled = false;
    void workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings")
      .then((data) => {
        if (!cancelled) {
          setWorkspaceChatSettings({ userId, preferences: normalizeAutoHidePreferences(data.settings), replyAutoMention: Boolean(data.settings.replyAutoMention) });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceChatSettings((current) => current?.userId === userId ? current : {
            userId, preferences: DEFAULT_AUTO_HIDE_PREFERENCES, replyAutoMention: false
          });
        }
      });
    return () => { cancelled = true; };
  }, [workspaceBootstrap?.auth.currentUser.id, workspaceChatSettingsRevision]);
  useEffect(() => {
    const conversation = workspaceSelectedConversation;
    if (!conversation || conversation.type !== "group") {
      return;
    }
    let cancelled = false;
    void workspaceJson<{ topics: WorkspaceTopic[] }>(
      `/api/workspace/conversations/${encodeURIComponent(conversation.id)}/topics?status=open`
    ).then((data) => {
      if (cancelled) return;
      const topics = data.topics.map(({ id, title, status }) => ({ id, title, status }));
      setWorkspaceConversationTopicsById((current) => ({ ...current, [conversation.id]: topics }));

    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [workspaceSelectedConversation?.id, workspaceSelectedConversation?.type, workspaceTopicRefreshSignal.conversationVersions[workspaceSelectedConversation?.id ?? ""]]);
  const workspaceTotalUnreadCount = useMemo(
    () => workspaceConversations.reduce((total, conversation) => total + Math.max(0, conversation.unreadCount ?? 0), 0),
    [workspaceConversations]
  );
  const workspaceCanManageSelectedGroup = Boolean(
    workspaceSelectedConversation?.type === "group" &&
    workspaceSelectedConversation.capabilities?.canManageMembers
  );
  const workspaceRoleMembers = (workspaceBootstrap?.members ?? []).filter((member) =>
    `${member.displayName} ${member.githubLogin ?? ""}`.toLocaleLowerCase().includes(workspaceRoleMemberQuery.trim().toLocaleLowerCase())
  );
  const workspaceVisibilityMembers = (workspaceBootstrap?.members ?? []).filter((member) =>
    member.id !== workspaceVisibilityViewerId && `${member.displayName} ${member.githubLogin ?? ""}`.toLocaleLowerCase().includes(workspaceVisibilityMemberQuery.trim().toLocaleLowerCase())
  );
  useEffect(() => { setWorkspaceRoleMemberQuery(""); setWorkspaceVisibilityMemberQuery(""); }, [workspaceBootstrap?.auth.currentUser.id]);
  const workspacePinnedMessages = workspaceSelectedConversationId
    ? workspacePinsByConversation[workspaceSelectedConversationId] ?? []
    : [];
  const workspacePinnedMessagesExpanded = workspaceSelectedConversationId
    ? Boolean(workspacePinsExpandedByConversation[workspaceSelectedConversationId])
    : false;
  const workspaceDraftDocument = workspaceSelectedConversationId
    ? workspaceDraftByConversation[workspaceSelectedConversationId] ?? { source: "", blocks: [] }
    : { source: "", blocks: [] };
  const workspaceDraft = workspaceDraftDocument.source;
  const workspaceComposerAttachments = workspaceSelectedConversationId
    ? workspaceComposerAttachmentsByConversation[workspaceSelectedConversationId] ?? []
    : [];
  const workspaceUnreadAnchor = workspaceSelectedConversationId
    ? workspaceUnreadAnchorByConversation[workspaceSelectedConversationId]
    : undefined;
  const workspaceNewMessageCount = workspaceSelectedConversationId
    ? workspaceNewMessageCountByConversation[workspaceSelectedConversationId] ?? 0
    : 0;
  const workspaceAwayFromLatest = workspaceSelectedConversationId
    ? Boolean(workspaceAwayFromLatestByConversation[workspaceSelectedConversationId])
    : false;
  const workspaceReplyToMessageId = workspaceSelectedConversationId
    ? workspaceReplyToMessageIdByConversation[workspaceSelectedConversationId] ?? ""
    : "";
  const workspaceVisibleContextTabs = useMemo(
    () =>
      ([
        { id: "overview" as const, label: "概览", visible: true },
        { id: "topics" as const, label: "话题", visible: workspaceSelectedConversation?.type === "group" },
        { id: "members" as const, label: "成员", visible: workspaceSelectedConversation?.type === "group" },
        { id: "files" as const, label: "文件", visible: true },
        { id: "settings" as const, label: "设置", visible: workspaceSelectedConversation?.type === "group" }
      ]).filter((tab) => tab.visible),
    [workspaceSelectedConversation?.type]
  );
  const workspaceFilteredConversations = useMemo(() => {
    const query = workspaceConversationQuery.trim().toLowerCase();
    if (!query) {
      return workspaceConversations;
    }
    return workspaceConversations.filter((conversation) =>
      [
        workspaceConversationTitle(conversation, workspaceBootstrap?.auth.currentUser.id),
        workspaceConversationPreview(conversation),
        conversation.type === "group" ? "群聊" : "私聊",
        ...conversation.members.map((member) => `${member.displayName} ${member.githubLogin ?? ""}`)
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [workspaceBootstrap?.auth.currentUser.id, workspaceConversationQuery, workspaceConversations]);
  const workspaceConversationFiles = useMemo(
    () =>
      workspaceSelectedConversation
        ? workspaceFiles.filter((file) => file.conversationId === workspaceSelectedConversation.id)
        : [],
    [workspaceFiles, workspaceSelectedConversation]
  );
  const workspaceFilteredConversationFiles = useMemo(
    () => workspaceConversationFiles.filter((file) => workspaceFileMatchesCategory(file, workspaceContextFileCategory)),
    [workspaceContextFileCategory, workspaceConversationFiles]
  );
  const workspaceFilteredFiles = useMemo(() => {
    const currentUserId = workspaceBootstrap?.auth.currentUser.id;
    const scopedFiles =
      workspaceFileFilter === "conversation"
          ? workspaceLibraryFiles.filter((file) => file.visibility === "conversation" || Boolean(file.conversationId))
        : workspaceFileFilter === "standalone"
          ? workspaceLibraryFiles.filter((file) => file.visibility === "space" && !file.conversationId)
        : workspaceFileFilter === "mine"
            ? workspaceLibraryFiles.filter((file) => file.uploaderId === currentUserId)
            : workspaceLibraryFiles;
    const categorizedFiles = scopedFiles.filter((file) => workspaceFileMatchesCategory(file, workspaceFileCategory));
    const query = workspaceFileQuery.trim().toLowerCase();
    if (!query) {
      return categorizedFiles;
    }
    return categorizedFiles.filter((file) =>
      [
        file.fileName,
        workspaceFileUploaderName(file),
        workspaceFileScope(file, workspaceConversations),
        workspaceFileVisibilityLabel(file),
        file.mimeType
      ].filter(Boolean).some((value) => value.toLowerCase().includes(query))
    );
  }, [workspaceBootstrap?.auth.currentUser.id, workspaceConversations, workspaceFileCategory, workspaceFileFilter, workspaceFileQuery, workspaceLibraryFiles]);
  const workspaceSelectedFile = useMemo(
    () =>
      workspaceFiles.find((file) => file.id === workspaceSelectedFileId) ??
      workspaceLibraryFiles.find((file) => file.id === workspaceSelectedFileId) ??
      null,
    [workspaceFiles, workspaceLibraryFiles, workspaceSelectedFileId]
  );
  const workspaceSelectedMember = useMemo(
    () =>
      workspaceDirectoryMembers.find((member) => member.id === workspaceSelectedMemberId) ??
      workspaceBootstrap?.members.find((member) => member.id === workspaceSelectedMemberId) ??
      null,
    [workspaceBootstrap?.members, workspaceDirectoryMembers, workspaceSelectedMemberId]
  );
  const workspaceSelectedFileConversation = useMemo(
    () =>
      workspaceSelectedFile?.conversationId
        ? workspaceConversations.find((conversation) => conversation.id === workspaceSelectedFile.conversationId) ?? null
        : null,
    [workspaceConversations, workspaceSelectedFile?.conversationId]
  );
  const workspaceImagePreviewFile = useMemo(
    () =>
      workspaceImagePreview
        ? workspaceFiles.find((file) => file.id === workspaceImagePreview.id) ??
          workspaceLibraryFiles.find((file) => file.id === workspaceImagePreview.id) ??
          null
        : null,
    [workspaceFiles, workspaceImagePreview, workspaceLibraryFiles]
  );
  const workspaceFilteredMembers = useMemo(() => {
    const query = workspaceMemberQuery.trim().toLowerCase();
    const members = workspaceDirectoryMembers;
    return members.filter((member) =>
      (workspaceMemberRoleFilter === "all" || member.role === workspaceMemberRoleFilter) &&
      (workspaceMemberKindFilter === "all" || member.kind === workspaceMemberKindFilter) &&
      (
        !query ||
        [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member), workspaceMemberKindLabel(member.kind)]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query))
      )
    );
  }, [workspaceDirectoryMembers, workspaceMemberKindFilter, workspaceMemberQuery, workspaceMemberRoleFilter]);
  const workspaceConversationListRef = useRef<HTMLDivElement>(null);
  const workspaceFileListRef = useRef<HTMLDivElement>(null);
  const workspaceMemberListRef = useRef<HTMLDivElement>(null);
  const workspaceGroupMemberListRef = useRef<HTMLDivElement>(null);
  const workspaceObjectScope = `${workspaceBootstrap?.auth.currentUser.id ?? "anonymous"}:${lane}:${workspaceStatus}:${workspaceView}:${workspaceCreateMode}`;
  const workspaceConversationActions = useObjectActionScope(
    `${workspaceObjectScope}:conversations`,
    workspaceView === "chat" && !workspaceCreateMode ? workspaceFilteredConversations.map((conversation) => conversation.id) : [],
    workspaceConversationListRef
  );
  const workspaceFileActions = useObjectActionScope(
    `${workspaceObjectScope}:files`,
    workspaceView === "files" && !workspaceCreateMode ? workspaceFilteredFiles.map((file) => file.id) : [],
    workspaceFileListRef
  );
  const workspaceMemberActions = useObjectActionScope(
    `${workspaceObjectScope}:members`,
    workspaceView === "members" && !workspaceCreateMode ? workspaceFilteredMembers.map((member) => member.id) : [],
    workspaceMemberListRef
  );
  const workspaceActionConversation = workspaceFilteredConversations.find((conversation) => conversation.id === workspaceConversationActions.targetId);
  const workspaceActionFile = workspaceFilteredFiles.find((file) => file.id === workspaceFileActions.targetId);
  const workspaceActionMember = workspaceFilteredMembers.find((member) => member.id === workspaceMemberActions.targetId);
  const workspaceActionableGroupMemberIds = (workspaceSelectedConversation?.members ?? [])
    .filter((member) => member.id !== workspaceBootstrap?.auth.currentUser.id &&
      ((workspaceBootstrap?.permissions.canCreateDirect && member.capabilities?.canStartDirectConversation === true) || workspaceCanManageSelectedGroup))
    .map((member) => member.id);
  const workspaceGroupMemberActions = useObjectActionScope(
    `${workspaceObjectScope}:group-members:${workspaceSelectedConversationId}:${workspaceContextCollapsed}:${workspaceContextTab}`,
    workspaceContextTab === "members" && !workspaceContextCollapsed ? workspaceActionableGroupMemberIds : [],
    workspaceGroupMemberListRef
  );
  const workspaceActionGroupMember = workspaceSelectedConversation?.members.find((member) => member.id === workspaceGroupMemberActions.targetId);
  const workspaceTopicSessionStore = useMemo(() => createWorkspaceTopicSessionStore(), [workspaceBootstrap?.auth.currentUser.id]);
  const workspaceVisibilityViewers = useMemo(
    () =>
      (workspaceBootstrap?.members ?? []).filter(
        (member) =>
          member.id !== workspaceBootstrap?.auth.currentUser.id &&
          member.kind === "human" &&
          member.role !== "auditor"
      ),
    [workspaceBootstrap?.auth.currentUser.id, workspaceBootstrap?.members]
  );
  const workspaceSelectableMembers = useMemo(
    () => {
      const query = workspacePickerMemberQuery.trim().toLowerCase();
      return (workspaceBootstrap?.members ?? []).filter(
        (member) => {
          const eligible = workspaceCreateMode === "group"
            ? member.capabilities?.canJoinGroups === true
            : member.capabilities?.canStartDirectConversation === true;
          return member.id !== workspaceBootstrap?.auth.currentUser.id &&
          eligible &&
          (!query ||
            [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member), workspaceMemberKindLabel(member.kind)]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(query)));
        }
      );
    },
    [workspaceBootstrap?.auth.currentUser.id, workspaceBootstrap?.members, workspaceCreateMode, workspacePickerMemberQuery]
  );
  const workspaceAddableMembers = useMemo(
    () =>
      (workspaceBootstrap?.members ?? []).filter(
        (member) =>
          member.capabilities?.canJoinGroups === true &&
          !workspaceSelectedConversation?.members.some((item) => item.id === member.id)
      ),
    [workspaceBootstrap?.members, workspaceSelectedConversation?.members]
  );
  const workspaceContextMemberQueryText = workspaceContextMemberQuery.trim().toLowerCase();
  const workspaceConversationMembers = useMemo(() => {
    const members = workspaceSelectedConversation?.members ?? [];
    if (!workspaceContextMemberQueryText) {
      return members;
    }
    return members.filter((member) =>
      [member.displayName, member.githubLogin, workspaceMemberRoleLabel(member)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(workspaceContextMemberQueryText))
    );
  }, [workspaceContextMemberQueryText, workspaceSelectedConversation?.members]);
  const workspaceMessages = useMemo<Message[]>(
    () => {
      const rawMessages = workspaceSelectedConversation?.latestMessages ?? [];
      const confirmedClientMessageIds = new Set(rawMessages.map((message) => message.clientMessageId).filter(Boolean));
      const localMessages = workspaceLocalMessages
        .filter((message) => message.conversationId === workspaceSelectedConversation?.id && !confirmedClientMessageIds.has(message.clientMessageId))
        .map((message) => ({
          id: message.id,
          conversationId: message.conversationId,
          authorId: workspaceBootstrap?.auth.currentUser.id ?? "",
          authorName: workspaceBootstrap?.auth.currentUser.displayName,
          authorAvatarUrl: workspaceBootstrap?.auth.currentUser.avatarUrl,
          authorKind: "human" as const,
          kind: "user" as const,
          plainText: message.body,
          createdAt: message.createdAt,
          localState: message.state,
          failureReason: message.failureReason,
          content: { format: "duallane.message+json;v=1", plainText: message.body, blocks: message.blocks },
          attachments: message.attachments ?? [],
          pendingAttachments: message.pendingAttachments,
          reactions: [],
          replyToMessageId: message.replyToMessageId
        }));
      return workspaceMessagesForChat([...rawMessages, ...localMessages], workspaceBootstrap?.auth.currentUser.id ?? "")
        .sort((left, right) => (Date.parse(left.createdAt ?? "") || 0) - (Date.parse(right.createdAt ?? "") || 0));
    },
    [
      workspaceBootstrap?.auth.currentUser.avatarUrl,
      workspaceBootstrap?.auth.currentUser.id,
      workspaceLocalMessages,
      workspaceSelectedConversation?.id,
      workspaceSelectedConversation?.latestMessages
    ]
  );
  const workspaceLoadedMessageCount = workspaceSelectedConversation?.latestMessages.length ?? 0;
  const workspaceHistoryLoading = workspaceSelectedConversation
    ? Boolean(workspaceHistoryLoadingByConversation[workspaceSelectedConversation.id])
    : false;
  const workspaceCanLoadOlderMessages = Boolean(
    workspaceSelectedConversation &&
      workspaceLoadedMessageCount > 0 &&
      (workspaceSelectedConversation.messageCount ?? 0) > workspaceLoadedMessageCount &&
      workspaceReturningToLatestConversationId !== workspaceSelectedConversation.id &&
      !workspaceHistoryExhaustedByConversation[workspaceSelectedConversation.id]
  );
  const workspaceReplyTarget = useMemo(
    () => workspaceMessages.find((message) => message.id === workspaceReplyToMessageId) ?? null,
    [workspaceMessages, workspaceReplyToMessageId]
  );
  const workspaceRemainingText = useMemo(() => {
    const limit = workspaceBootstrap?.policy.dailyQuotaBytes ?? 0;
    const remaining = workspaceBootstrap?.policy.remainingQuotaBytes ?? limit;
    if (!limit) {
      return "等待空间信息";
    }
    return `${formatBytes(remaining)} 可用`;
  }, [workspaceBootstrap?.policy.dailyQuotaBytes, workspaceBootstrap?.policy.remainingQuotaBytes]);
  const workspaceQuotaDetailText = useMemo(() => {
    const limit = workspaceBootstrap?.policy.dailyQuotaBytes ?? 0;
    const used = workspaceBootstrap?.policy.usedTodayBytes ?? 0;
    if (!limit) {
      return "上传和下载共用";
    }
    return `已用 ${formatBytes(used)} / ${formatBytes(limit)}`;
  }, [workspaceBootstrap?.policy.dailyQuotaBytes, workspaceBootstrap?.policy.usedTodayBytes]);
  const workspaceUpdateAvailable = isServerVersionNewer(__DUALLANE_APP_VERSION__, serverAppVersion) && !versionUpdateDismissed;
  const dismissVersionUpdate = () => {
    setVersionUpdateDismissed(true);
    if (serverAppVersion) {
      try {
        localStorage.setItem(`${VERSION_UPDATE_DISMISSED_STORAGE_PREFIX}${serverAppVersion}`, "true");
      } catch {
        // Storage may be unavailable in restricted browsing contexts.
      }
    }
  };
  const workspaceSelectedFileQuotaWarning = useMemo(
    () =>
      workspaceSelectedFile
        ? getWorkspaceTransferQuotaWarning(workspaceSelectedFile.byteSize, "download", workspaceBootstrap?.policy)
        : "",
    [workspaceBootstrap?.policy, workspaceSelectedFile]
  );
  const workspaceContextMatchesView = workspaceView === "files" ? workspaceContextMode === "file"
    : workspaceView === "members" ? workspaceContextMode === "member"
      : workspaceView === "chat" && workspaceContextMode === "conversation";
  const workspaceContextAvailable = workspaceContextMatchesView && (workspaceContextMode === "file"
    ? Boolean(workspaceSelectedFile)
    : workspaceContextMode === "member"
      ? Boolean(workspaceSelectedMember)
      : Boolean(workspaceSelectedConversation));
  const workspaceContextVisible = workspaceContextAvailable && !workspaceContextCollapsed;
  const workspaceMemberPickerScope = `${workspaceSessionEpochRef.current}:${workspaceAccessEpochRef.current}:${workspaceBootstrap?.auth.currentUser.id ?? ""}:${workspaceSelectedConversationId}:${workspaceCanManageSelectedGroup}:${workspaceView}:${workspaceContextMode}:${workspaceContextTab}:${workspaceContextVisible}:${workspaceMobilePane}`;
  useEffect(() => { setWorkspaceMemberPickerOpen(false); }, [workspaceMemberPickerScope]);

  useEffect(() => {
    return () => {
      clearP2pMessageAckTimers();
      clearP2pFileAckTimers();
      clearIncomingP2pFiles();
      for (const controller of workspaceUploadControllersRef.current.values()) {
        controller.abort();
      }
      for (const attachments of Object.values(workspaceComposerAttachmentsRef.current)) {
        for (const attachment of attachments) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      }
      for (const message of workspaceLocalMessagesRef.current) {
        for (const attachment of message.pendingAttachments ?? []) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      }
    };
  }, []);

  useEffect(() => {
    workspaceComposerAttachmentsRef.current = workspaceComposerAttachmentsByConversation;
  }, [workspaceComposerAttachmentsByConversation]);

  useEffect(() => {
    workspaceLocalMessagesRef.current = workspaceLocalMessages;
  }, [workspaceLocalMessages]);

  useEffect(() => {
    const previousIds = new Set(workspaceConversationsRef.current.map((conversation) => conversation.id));
    const nextIds = new Set(workspaceConversations.map((conversation) => conversation.id));
    for (const conversationId of previousIds) {
      if (!nextIds.has(conversationId)) {
        advanceWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversationId);
      }
    }
    workspaceConversationsRef.current = workspaceConversations;
  }, [workspaceConversations]);

  useEffect(() => {
    workspaceSelectedConversationIdRef.current = workspaceSelectedConversationId;
  }, [workspaceSelectedConversationId]);

  useEffect(() => {
    workspaceCurrentUserIdRef.current = workspaceBootstrap?.auth.currentUser.id ?? "";
  }, [workspaceBootstrap?.auth.currentUser.id]);

  useEffect(() => {
    if (!workspaceCreateMenuOpen && !workspaceUserMenuOpen && !workspaceMemberFilterOpen) {
      return;
    }
    const openMenu = workspaceCreateMenuOpen
      ? workspaceCreateMenuRef.current
      : workspaceUserMenuOpen
        ? workspaceUserMenuRef.current
        : workspaceMemberFilterRef.current;
    const trigger = workspaceCreateMenuOpen
      ? workspaceCreateTriggerRef.current
      : workspaceUserMenuOpen
        ? workspaceUserTriggerRef.current
        : workspaceMemberFilterTriggerRef.current;
    const frame = window.requestAnimationFrame(() => {
      const entry = workspaceMemberFilterOpen
        ? '[role="menuitemradio"][aria-checked="true"], [role="radio"][tabindex="0"], button[role="combobox"]'
        : '[role^="menuitem"]:not(:disabled)';
      openMenu?.querySelector<HTMLButtonElement>(entry)?.focus();
    });
    const closeMenu = () => {
      setWorkspaceCreateMenuOpen(false);
      setWorkspaceUserMenuOpen(false);
      setWorkspaceMemberFilterOpen(false);
      window.requestAnimationFrame(() => trigger?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        (workspaceCreateMenuOpen && !workspaceCreateMenuRef.current?.contains(target)) ||
        (workspaceUserMenuOpen && !workspaceUserMenuRef.current?.contains(target)) ||
        (workspaceMemberFilterOpen && !workspaceMemberFilterRef.current?.contains(target))
      ) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspaceCreateMenuOpen, workspaceMemberFilterOpen, workspaceUserMenuOpen]);

  useEffect(() => {
    if (!workspaceImagePreview || !workspaceImageViewerRef.current) {
      return;
    }
    setWorkspaceImageZoom(1);
    const dialog = workspaceImageViewerRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = dialog.parentElement
      ? Array.from(dialog.parentElement.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && element !== dialog
        )
      : [];
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => workspaceImageCloseButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setWorkspaceImagePreview(null);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setWorkspaceImageZoom((zoom) => clampWorkspaceImageZoom(zoom + 0.25));
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setWorkspaceImageZoom((zoom) => clampWorkspaceImageZoom(zoom - 0.25));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setWorkspaceImageZoom(1);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [workspaceImagePreview]);

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkVersion = async () => {
      if (cancelled || versionCheckInFlightRef.current) return;
      versionCheckInFlightRef.current = true;
      const controller = new AbortController();
      versionCheckAbortControllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
      try {
        const response = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { appVersion?: string };
        const nextVersion = typeof payload.appVersion === "string" ? payload.appVersion : "";
        if (!nextVersion || cancelled) return;
        setServerAppVersion(nextVersion);
        try {
          setVersionUpdateDismissed(localStorage.getItem(`${VERSION_UPDATE_DISMISSED_STORAGE_PREFIX}${nextVersion}`) === "true");
        } catch {
          setVersionUpdateDismissed(false);
        }
      } catch {
        // A transient health check failure must not interrupt the current session.
      } finally {
        window.clearTimeout(timeout);
        if (versionCheckAbortControllerRef.current === controller) {
          versionCheckAbortControllerRef.current = null;
          versionCheckInFlightRef.current = false;
        }
      }
    };
    void checkVersion();
    const interval = window.setInterval(() => void checkVersion(), VERSION_CHECK_INTERVAL_MS);
    const handleFocus = () => void checkVersion();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      versionCheckAbortControllerRef.current?.abort();
      versionCheckAbortControllerRef.current = null;
      versionCheckInFlightRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => installWorkspaceUnreadFavicon({
    active: lane === "workspace-dev" && workspaceStatus === "ready" && workspaceTotalUnreadCount > 0,
    documentVisible
  }), [documentVisible, lane, workspaceStatus, workspaceTotalUnreadCount]);


  useEffect(() => {
    localStorage.setItem(WORKSPACE_CONTEXT_STORAGE_KEY, String(!workspaceContextCollapsed));
  }, [workspaceContextCollapsed]);


  useEffect(() => {
    p2pMessageListRef.current?.scrollTo({
      top: p2pMessageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [p2pMessages.length]);

  useLayoutEffect(() => {
    const list = workspaceMessageListRef.current;
    if (!list) {
      return;
    }
    const forceScrollToLatest =
      workspaceReturningToLatestConversationId === workspaceSelectedConversationId &&
      workspaceScrollToLatestRequest !== workspaceHandledScrollToLatestRequestRef.current;
    const prepend = workspacePrependScrollRef.current;
    const currentPrepend = prepend && !forceScrollToLatest && prepend.list === list &&
      prepend.conversationId === workspaceSelectedConversationId &&
      isCurrentWorkspaceConversationMessageRequest(prepend.conversationId, prepend.request);
    if (prepend && !currentPrepend) workspacePrependScrollRef.current = null;
    // An HTTP response may finish after an earlier commit but before its
    // passive effects. Consume the snapshot only with its actual prepend DOM,
    // before paint; an unrelated or in-progress commit must leave it pending.
    if (currentPrepend && workspaceMessages.some((message) => message.id === prepend.prependedMessageId)) {
      workspacePrependScrollRef.current = null;
      if (prepend.anchor && list.contains(prepend.anchor.element)) {
        // Grouping may remove the old first row's author header. Follow its
        // visible body rather than assuming the entire height delta is above it.
        list.scrollTop += prepend.anchor.element.getBoundingClientRect().top -
          list.getBoundingClientRect().top - prepend.anchor.offset;
      } else if (list.scrollHeight > prepend.height) {
        // The browser may already anchor the visible row after a prepend.
        // Restore from the pre-render snapshot rather than compensating twice.
        list.scrollTop = prepend.top + list.scrollHeight - prepend.height;
      }
      return;
    }
    const conversationChanged = workspaceScrolledConversationIdRef.current !== workspaceSelectedConversationId;
    workspaceScrolledConversationIdRef.current = workspaceSelectedConversationId;
    if (conversationChanged) {
      workspaceScrollIntentUntilRef.current = 0;
      workspaceStickToBottomRef.current = true;
      workspaceScrollPositionsRef.current.delete(workspaceSelectedConversationId);
      workspaceStickToBottomByConversationRef.current.set(workspaceSelectedConversationId, true);
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
      handleWorkspaceMessageListScroll(list);
      return;
    }
    if (!conversationChanged && !workspaceStickToBottomRef.current && !forceScrollToLatest) {
      return;
    }
    workspaceStickToBottomRef.current = true;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: "auto"
    });
    handleWorkspaceMessageListScroll(list);
    if (forceScrollToLatest) {
      workspaceHandledScrollToLatestRequestRef.current = workspaceScrollToLatestRequest;
      setWorkspaceHistoryExhaustedByConversation((current) => {
        if (!(workspaceSelectedConversationId in current)) return current;
        const { [workspaceSelectedConversationId]: _removed, ...rest } = current;
        return rest;
      });
      setWorkspaceReturningToLatestConversationId("");
    }
  }, [
    documentVisible,
    workspaceMessages.length,
    workspaceMobilePane,
    workspaceReturningToLatestConversationId,
    workspaceScrollToLatestRequest,
    workspaceSelectedConversationId,
    workspaceView
  ]);

  useEffect(() => {
    if (!workspaceMessageLocateTarget || workspaceView !== "chat") return;
    workspaceStickToBottomRef.current = false;
    let removeTimer = 0;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(workspaceMessageLocateTarget.messageId)}"]`
      );
      target?.scrollIntoView({ block: "center", behavior: "auto" });
      if (target && workspaceMessageListRef.current) {
        target.classList.remove("message-locate");
        void target.offsetWidth;
        target.classList.add("message-locate");
        removeTimer = window.setTimeout(() => target.classList.remove("message-locate"), 1900);
        workspaceScrollPositionsRef.current.set(
          workspaceSelectedConversationId,
          workspaceMessageListRef.current.scrollTop
        );
        workspaceStickToBottomByConversationRef.current.set(workspaceSelectedConversationId, false);
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(removeTimer);
    };
  }, [workspaceMessageLocateTarget, workspaceSelectedConversationId, workspaceView]);

  useEffect(() => {
    const list = workspaceMessageListRef.current;
    if (!list || workspaceView !== "chat" || !workspaceSelectedConversationId) {
      return;
    }
    let frame = 0;
    const keepPinnedToBottom = () => {
      if (!workspaceStickToBottomRef.current) {
        return;
      }
      workspaceStickToBottomRef.current = true;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!workspaceStickToBottomRef.current) {
          return;
        }
        list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
        handleWorkspaceMessageListScroll(list);
      });
    };
    const observer = new ResizeObserver(keepPinnedToBottom);
    observer.observe(list);
    window.addEventListener("resize", keepPinnedToBottom);
    window.visualViewport?.addEventListener("resize", keepPinnedToBottom);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepPinnedToBottom);
      window.visualViewport?.removeEventListener("resize", keepPinnedToBottom);
      window.cancelAnimationFrame(frame);
    };
  }, [workspaceMobilePane, workspaceSelectedConversationId, workspaceView]);

  useEffect(() => {
    if (!workspaceSelectedConversation || (workspaceSelectedConversation.unreadCount ?? 0) <= 0) {
      return;
    }
    setWorkspaceUnreadAnchorByConversation((anchors) =>
      anchors[workspaceSelectedConversation.id]
        ? anchors
        : {
            ...anchors,
            [workspaceSelectedConversation.id]: {
              messageId: workspaceSelectedConversation.lastReadMessageId,
              count: workspaceSelectedConversation.unreadCount ?? 0
            }
          }
    );
  }, [
    workspaceSelectedConversation?.id,
    workspaceSelectedConversation?.lastReadMessageId,
    workspaceSelectedConversation?.unreadCount
  ]);

  useEffect(() => {
    p2pPeersRef.current = p2pPeers;
  }, [p2pPeers]);

  useEffect(() => {
    if (!selectedSavedSessionId && savedP2pSessions.length > 0) {
      setSelectedSavedSessionId(savedP2pSessions[0].id);
    }
  }, [savedP2pSessions, selectedSavedSessionId]);

  useEffect(() => {
    if (lane !== "workspace-dev") {
      return;
    }
    void loadWorkspace();
  }, [lane]);

  useEffect(() => {
    if (workspaceStatus !== "ready") {
      return;
    }
    if (workspaceConversations.length === 0) {
      if (workspaceSelectedConversationId) {
        setWorkspaceSelectedConversationId("");
        if (workspaceView === "chat") {
          replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode }));
        }
      }
      return;
    }
    if (!workspaceSelectedConversationId && window.matchMedia("(max-width: 760px)").matches) return;
    if (!workspaceSelectedConversationId || !workspaceConversations.some((conversation) => conversation.id === workspaceSelectedConversationId)) {
      const fallbackId = workspaceConversations[0].id;
      const requestedId = workspaceSelectedConversationId;
      setWorkspaceSelectedConversationId(fallbackId);
      if (workspaceView === "chat") {
        replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, conversationId: fallbackId }));
        if (requestedId) showWorkspaceNotice("warning", "该会话不存在或无权访问，已返回最近会话");
      }
    }
  }, [workspaceConversations, workspacePendingInviteCode, workspaceSelectedConversationId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (workspaceSelectedConversation?.type === "group") {
      setWorkspaceGroupRenameTitle(workspaceSelectedConversation.title);
      setWorkspaceGroupAvatarEmoji(workspaceSelectedConversation.avatarEmoji ?? "");
    } else {
      setWorkspaceGroupRenameTitle("");
      setWorkspaceGroupAvatarEmoji("");
      if (workspaceContextTab === "members" || workspaceContextTab === "settings") {
        setWorkspaceContextTab("overview");
      }
    }
    setWorkspaceContextMemberQuery("");
    setWorkspaceGroupMemberBusyId("");
  }, [workspaceContextTab, workspaceSelectedConversation?.avatarEmoji, workspaceSelectedConversation?.id, workspaceSelectedConversation?.title, workspaceSelectedConversation?.type]);

  useEffect(() => {
    if (
      workspaceStatus === "ready" &&
      workspaceView === "files" &&
      workspaceSelectedFileId &&
      !workspaceFiles.some((file) => file.id === workspaceSelectedFileId) &&
      !workspaceLibraryFiles.some((file) => file.id === workspaceSelectedFileId)
    ) {
      setWorkspaceSelectedFileId("");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files" }));
      showWorkspaceNotice("warning", "该文件不存在或无权访问，已返回文件库");
    }
  }, [workspaceFiles, workspaceLibraryFiles, workspacePendingInviteCode, workspaceSelectedFileId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (
      workspaceStatus === "ready" &&
      workspaceView === "members" &&
      workspaceSelectedMemberId &&
      !workspaceDirectoryMembers.some((member) => member.id === workspaceSelectedMemberId)
    ) {
      setWorkspaceSelectedMemberId("");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "members" }));
      showWorkspaceNotice("warning", "该成员不存在或不可见，已返回成员目录");
      if (workspaceContextMode === "member") {
        setWorkspaceContextMode("conversation");
        setWorkspaceContextCollapsed(true);
      }
    }
  }, [workspaceContextMode, workspaceDirectoryMembers, workspacePendingInviteCode, workspaceSelectedMemberId, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (!workspaceCreateMode) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      workspaceCreateSearchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceCreateMode]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || workspaceView !== "files") {
      return;
    }
    void refreshWorkspaceFiles();
  }, [lane, workspaceFileFilter, workspaceFileQuery, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || workspaceView !== "members") {
      return;
    }
    const timer = window.setTimeout(() => void refreshWorkspaceMembers(), 250);
    return () => window.clearTimeout(timer);
  }, [lane, workspaceMemberKindFilter, workspaceMemberQuery, workspaceMemberRoleFilter, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (workspaceStatus !== "ready" || workspaceSelectedConversation?.type !== "group") return;
    void refreshWorkspacePins(workspaceSelectedConversation.id);
  }, [workspaceSelectedConversation?.id, workspaceSelectedConversation?.type, workspaceStatus, workspaceView]);

  useEffect(() => {
    if (workspaceStatus !== "ready") return;
    if (
      (workspaceSpaceTab === "invites" && !workspaceBootstrap?.permissions.canCreateMemberInvite) ||
      (workspaceSpaceTab === "roles" && !workspaceBootstrap?.permissions.canCreatePrivilegedInvite) ||
      (workspaceSpaceTab === "visibility" && !workspaceBootstrap?.permissions.canManageMemberVisibility) ||
      (workspaceSpaceTab === "email" && !workspaceBootstrap?.permissions.canManageEmailSettings) ||
      (workspaceSpaceTab === "requirements" && workspaceBootstrap?.auth.currentUser.role !== "owner")
    ) {
      setWorkspaceSpaceTab("overview");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "space", spaceTab: "overview" }));
      showWorkspaceNotice("warning", "当前账号无权访问该空间设置，已返回空间概览");
    }
  }, [
    workspaceBootstrap?.permissions.canCreateMemberInvite,
    workspaceBootstrap?.permissions.canCreatePrivilegedInvite,
    workspaceBootstrap?.permissions.canManageEmailSettings,
    workspaceBootstrap?.permissions.canManageMemberVisibility,
    workspaceBootstrap?.auth.currentUser.role,
    workspacePendingInviteCode,
    workspaceStatus,
    workspaceSpaceTab
  ]);

  useEffect(() => {
    if (workspaceBootstrap?.auth.currentUser.role !== "owner") {
      setWorkspaceStatistics(null);
      setWorkspaceStatisticsError("");
      setWorkspaceStatisticsLoading(false);
      return;
    }
    if (
      lane !== "workspace-dev" ||
      workspaceStatus !== "ready" ||
      workspaceView !== "space" ||
      workspaceSpaceTab !== "overview"
    ) {
      return;
    }
    void refreshWorkspaceStatistics();
  }, [
    lane,
    workspaceBootstrap?.auth.currentUser.role,
    workspaceSpaceTab,
    workspaceStatus,
    workspaceView
  ]);
  useEffect(() => {
    if (
      lane !== "workspace-dev" ||
      workspaceStatus !== "ready" ||
      workspaceView !== "space" ||
      workspaceSpaceTab !== "visibility" ||
      !workspaceBootstrap?.permissions.canManageMemberVisibility
    ) {
      return;
    }
    const viewerId = workspaceVisibilityViewers.some((member) => member.id === workspaceVisibilityViewerId)
      ? workspaceVisibilityViewerId
      : workspaceVisibilityViewers[0]?.id ?? "";
    if (!viewerId) {
      selectWorkspaceVisibilityViewer("");
      return;
    }
    if (viewerId !== workspaceVisibilityViewerId) {
      selectWorkspaceVisibilityViewer(viewerId);
      return;
    }
    void loadWorkspaceMemberVisibility(viewerId);
  }, [
    lane,
    workspaceBootstrap?.permissions.canManageMemberVisibility,
    workspaceSpaceTab,
    workspaceStatus,
    workspaceView,
    workspaceVisibilityViewerId,
    workspaceVisibilityViewers
  ]);

  useEffect(() => {
    if (lane !== "workspace-dev" || workspaceStatus !== "ready" || !workspaceBootstrap) {
      workspaceWsRef.current?.close();
      workspaceWsRef.current = null;
      setWorkspaceRealtimeState("idle");
      return;
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    let replayEventsRemaining = 0;
    let replayHasMore = false;
    workspaceRealtimeEventQueueRef.current = Promise.resolve();

    const connectWorkspaceEvents = () => {
      if (disposed) {
        return;
      }
      setWorkspaceRealtimeState("connecting");
      const socket = new WebSocket(getWorkspaceWsUrl());
      workspaceWsRef.current = socket;

      const requestEvents = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ version: 1, type: "hello", lastSeq: workspaceRealtimeSeqRef.current }));
        }
      };

      socket.addEventListener("open", () => {
        if (disposed) {
          return;
        }
        setWorkspaceRealtimeState("connected");
        requestEvents();
      });

      socket.addEventListener("message", (event) => {
        let envelope: WorkspaceRealtimeEnvelope | null = null;
        try {
          envelope = JSON.parse(String(event.data)) as WorkspaceRealtimeEnvelope;
        } catch {
          setWorkspaceRealtimeState("error");
          return;
        }
        if (envelope.error) {
          handleWorkspaceRealtimeError(envelope.error);
          return;
        }
        if (envelope.type === "ready") {
          const currentSeq = Number(envelope.currentSeq);
          replayEventsRemaining = Math.max(0, Number(envelope.replayCount) || 0);
          replayHasMore = Boolean(envelope.hasMore);
          if (envelope.replayCount === 0 && Number.isFinite(currentSeq)) {
            workspaceRealtimeSeqRef.current = Math.max(workspaceRealtimeSeqRef.current, currentSeq);
          }
          if (replayEventsRemaining === 0 && replayHasMore) {
            replayHasMore = false;
            window.setTimeout(requestEvents, 0);
          }
          setWorkspaceRealtimeState("connected");
          return;
        }
        if (envelope.type === "sync.required") {
          void syncWorkspaceRealtimeState(Number(envelope.currentSeq));
          return;
        }
        const incomingEvents = getWorkspaceRealtimeEvents(envelope);
        if (incomingEvents.length === 0) {
          setWorkspaceRealtimeState("connected");
          return;
        }
        setWorkspaceRealtimeState("syncing");
        workspaceRealtimeEventQueueRef.current = workspaceRealtimeEventQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const events = normalizeWorkspaceRealtimeEvents(incomingEvents);
            if (events.length === 0 || disposed) {
              return;
            }
            await projectWorkspaceEvents(events);
            rememberWorkspaceRealtimeEvents(events);
            if (replayEventsRemaining > 0) {
              replayEventsRemaining = Math.max(0, replayEventsRemaining - events.length);
              if (replayEventsRemaining === 0 && replayHasMore) {
                replayHasMore = false;
                window.setTimeout(requestEvents, 0);
              }
            }
          })
          .catch((error) => {
            if (!disposed) {
              showWorkspaceNotice("warning", userFacingErrorMessage(error, "同步共享空间失败"), { persistent: true });
              setWorkspaceRealtimeState("error");
            }
          })
          .finally(() => {
            if (!disposed) {
              setWorkspaceRealtimeState("connected");
            }
          });
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        setWorkspaceRealtimeState("offline");
        reconnectTimer = window.setTimeout(connectWorkspaceEvents, 3000);
      });

      socket.addEventListener("error", () => {
        if (!disposed) {
          setWorkspaceRealtimeState("error");
        }
        socket.close();
      });
    };

    connectWorkspaceEvents();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      workspaceWsRef.current?.close();
      workspaceWsRef.current = null;
    };
  }, [lane, workspaceStatus, workspaceBootstrap?.auth.currentUser.id]);

  useEffect(() => {
    routeIndexRef.current = Number.isInteger(window.history.state?.duallaneIndex) ? window.history.state.duallaneIndex : 0;
    window.history.replaceState({ ...window.history.state, duallaneIndex: routeIndexRef.current }, "", initialParsedRoute.canonicalUrl);
    routeUrlRef.current = initialParsedRoute.canonicalUrl;
    applyAppRouteState(initialParsedRoute.route);
    const handlePopState = () => {
      if (historyIgnoreRef.current) { historyIgnoreRef.current = false; const resume = historyResumeRef.current; historyResumeRef.current = null; resume?.(); return; }
      const parsed = parseAppRoute(window.location.pathname, window.location.search, window.location.hash);
      const index = Number.isInteger(window.history.state?.duallaneIndex) ? window.history.state.duallaneIndex : routeIndexRef.current - 1;
      const delta = index - routeIndexRef.current;
      const apply = () => {
        routeIndexRef.current = index;
        routeUrlRef.current = parsed.canonicalUrl;
        window.history.replaceState({ ...window.history.state, duallaneIndex: index }, "", parsed.canonicalUrl);
        applyAppRouteState(parsed.route);
      };
      if (!navigationRef.current.isBlocked()) { apply(); return; }
      // Restore the current entry before presenting a choice. Cancel preserves forward history.
      if (delta !== 0) {
        historyIgnoreRef.current = true;
        historyResumeRef.current = () => navigationRef.current.request(() => {
          historyIgnoreRef.current = true;
          historyResumeRef.current = apply;
          window.history.go(delta);
        });
        window.history.go(-delta);
      } else {
        window.history.replaceState({ duallaneIndex: routeIndexRef.current }, "", routeUrlRef.current);
        navigationRef.current.request(() => { window.history.pushState({ duallaneIndex: index }, "", parsed.canonicalUrl); apply(); });
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    secureKeysRef.current = null;
    setVerificationCode("");
    if (!roomId || !roomSecret) {
      return;
    }

    deriveP2pKeys(roomId, roomSecret, securityPassphrase)
      .then(async (keys) => {
        const code = await getP2pVerificationCode(roomId, roomSecret, securityPassphrase);
        if (cancelled) {
          return;
        }
        secureKeysRef.current = keys;
        setVerificationCode(code);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        secureKeysRef.current = null;
        setVerificationCode("");
        setP2pError("安全密钥不可用，请重新复制完整邀请链接。");
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, roomSecret, securityPassphrase]);

  useEffect(() => {
    if (p2pStep !== "chat" || !canStartPeerSession) {
      return;
    }

    const keys = secureKeysRef.current;
    if (!keys) {
      setP2pError("正在准备端到端加密密钥，请稍后再进入聊天。");
      return;
    }
    const sessionKeys: SecureKeys = keys;
    const sessionGeneration = p2pSessionGenerationRef.current + 1;
    p2pSessionGenerationRef.current = sessionGeneration;

    let disposed = false;
    let iceServers: RTCIceServer[] = [];
    let peerConnection: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;
    let rtcReconnectTimer: number | undefined;
    let rtcNegotiationTimer: number | undefined;
    let socketReconnectTimer: number | undefined;
    let reconnectAllowed = true;
    let hasJoinedRoom = false;
    setP2pSocketState("connecting");
    setP2pRtcState("connecting");
    setP2pDataChannelState("idle");
    setP2pError("");
    setP2pRoomIssue("");

    const cancelRtcReconnect = () => {
      if (rtcReconnectTimer !== undefined) {
        window.clearTimeout(rtcReconnectTimer);
        rtcReconnectTimer = undefined;
      }
    };

    const cancelRtcNegotiationTimeout = () => {
      if (rtcNegotiationTimer !== undefined) {
        window.clearTimeout(rtcNegotiationTimer);
        rtcNegotiationTimer = undefined;
      }
    };

    const scheduleRtcReconnect = () => {
      if (disposed || !reconnectAllowed || rtcReconnectTimer !== undefined) {
        return;
      }
      rtcReconnectTimer = window.setTimeout(() => {
        rtcReconnectTimer = undefined;
        if (!disposed && reconnectAllowed) {
          void renegotiateRtc(true);
        }
      }, P2P_RECONNECT_DELAY_MS);
    };

    const sendSecure = async (channel: SecureChannel, payload: unknown) => {
      const activeSocket = socket;
      if (activeSocket?.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        const securePayload = await encryptSecurePayload(sessionKeys, channel, payload);
        if (disposed || socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
          return false;
        }
        activeSocket.send(JSON.stringify(securePayload));
        return true;
      } catch {
        return false;
      }
    };

    const sendSignal = (payload: unknown) => {
      void sendSecure("signal", payload);
    };

    const publishProfile = () => {
      if (peerIdRef.current) {
        peerProfilesRef.current.set(peerIdRef.current, localDisplayName);
      }
      void sendSecure("profile", {
        kind: "profile",
        peerId: peerIdRef.current || undefined,
        name: localDisplayName
      } satisfies PeerProfile);
    };

    const attachChannel = (channel: RTCDataChannel) => {
      dataChannelRef.current = channel;
      setP2pDataChannelState(channel.readyState);
      channel.addEventListener("open", () => {
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        cancelRtcReconnect();
        cancelRtcNegotiationTimeout();
        setP2pError("");
        setP2pDataChannelState("open");
        setP2pRtcState("connected");
      });
      channel.addEventListener("close", () => {
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        dataChannelRef.current = null;
        setP2pDataChannelState("closed");
        setP2pRtcState("offline");
        markInterruptedTransfers("文件通道已断开，请确认双方页面在线后重新发送");
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          markPendingP2pMessagesFailed("连接已断开，消息未送达");
        }
        scheduleRtcReconnect();
      });
      channel.addEventListener("error", () => {
        if (disposed || dataChannelRef.current !== channel) {
          return;
        }
        dataChannelRef.current = null;
        setP2pDataChannelState("closed");
        setP2pRtcState("error");
        markInterruptedTransfers("文件通道异常，请等待自动重连后重新发送");
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          markPendingP2pMessagesFailed("连接异常，消息未送达");
        }
        scheduleRtcReconnect();
      });
      channel.addEventListener("message", (event) => {
        if (disposed || dataChannelRef.current !== channel || typeof event.data !== "string") {
          return;
        }
        p2pDataMessageQueueRef.current = p2pDataMessageQueueRef.current
          .then(() => {
            if (disposed || p2pSessionGenerationRef.current !== sessionGeneration) {
              return;
            }
            return handleDataChannelMessage(event.data, sessionGeneration);
          })
          .catch(() => {
            if (!disposed) {
              setP2pError("收到无效的直连数据，请让对方重试。");
            }
          });
      });
    };

    function isRtcInitiator() {
      const selfId = peerIdRef.current;
      const peers = p2pPeersRef.current;
      return Boolean(selfId && peers.length >= 2 && selfId === [...peers].sort((a, b) => a.id.localeCompare(b.id))[0]?.id);
    }

    function replacePeerConnection() {
      cancelRtcNegotiationTimeout();
      const previousChannel = dataChannelRef.current;
      if (previousChannel && previousChannel.readyState !== "closed") {
        markInterruptedTransfers("直连正在自动恢复，请等待恢复后重新发送文件");
      }
      dataChannelRef.current = null;
      previousChannel?.close();
      const previousConnection = peerConnection;
      peerConnection = null;
      previousConnection?.close();
      pendingIceRef.current = [];

      const connection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all"
      });
      peerConnection = connection;
      setP2pRtcState("connecting");
      setP2pDataChannelState("connecting");

      connection.addEventListener("icecandidate", (event) => {
        if (!disposed && peerConnection === connection && event.candidate) {
          sendSignal({ type: "signal", signal: "ice", candidate: event.candidate.toJSON() });
        }
      });
      connection.addEventListener("connectionstatechange", () => {
        if (disposed || peerConnection !== connection) {
          return;
        }
        if (connection.connectionState === "connected") {
          cancelRtcReconnect();
          cancelRtcNegotiationTimeout();
          setP2pRtcState("connected");
        } else if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        } else if (connection.connectionState === "connecting") {
          setP2pRtcState("connecting");
        }
      });
      connection.addEventListener("datachannel", (event) => {
        if (!disposed && peerConnection === connection) {
          attachChannel(event.channel);
        }
      });
      return connection;
    }

    function startRtcNegotiationTimeout(connection: RTCPeerConnection) {
      cancelRtcNegotiationTimeout();
      rtcNegotiationTimer = window.setTimeout(() => {
        rtcNegotiationTimer = undefined;
        if (disposed || peerConnection !== connection || connection.connectionState === "connected") {
          return;
        }
        replacePeerConnection();
        setP2pRtcState("offline");
        setP2pError("直连协商未收到对方响应，正在自动重试。");
        scheduleRtcReconnect();
      }, P2P_RTC_NEGOTIATION_TIMEOUT_MS);
    }

    async function renegotiateRtc(iceRestart: boolean) {
      if (disposed || !reconnectAllowed || socket?.readyState !== WebSocket.OPEN || p2pPeersRef.current.length < 2) {
        return;
      }

      let connection = peerConnection;
      if (!connection || ["closed", "failed"].includes(connection.connectionState)) {
        connection = replacePeerConnection();
      }
      if (!isRtcInitiator()) {
        return;
      }
      if (connection.signalingState !== "stable") {
        connection = replacePeerConnection();
      }

      const currentChannel = dataChannelRef.current;
      if (!currentChannel || currentChannel.readyState === "closed") {
        attachChannel(connection.createDataChannel("duallane-p2p"));
      } else if (currentChannel.readyState === "closing") {
        scheduleRtcReconnect();
        return;
      } else if (currentChannel.readyState === "open" && connection.connectionState === "connected" && !iceRestart) {
        return;
      }

      setP2pRtcState("connecting");
      try {
        const shouldRestartIce = iceRestart && connection.connectionState !== "new";
        if (shouldRestartIce) {
          connection.restartIce();
        }
        const offer = await connection.createOffer(shouldRestartIce ? { iceRestart: true } : undefined);
        if (disposed || peerConnection !== connection || connection.signalingState !== "stable") {
          return;
        }
        await connection.setLocalDescription(offer);
        const sent = await sendSecure("signal", { type: "signal", signal: "offer", description: offer });
        if (disposed || peerConnection !== connection) {
          return;
        }
        if (!sent) {
          if (peerConnection === connection) {
            replacePeerConnection();
          }
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        } else {
          startRtcNegotiationTimeout(connection);
        }
      } catch {
        if (!disposed && peerConnection === connection) {
          replacePeerConnection();
          setP2pRtcState("offline");
          setP2pError("直连恢复暂未成功，正在自动重试。");
          scheduleRtcReconnect();
        }
      }
    }

    async function applySignal(signal: SignalMessage) {
      let connection = peerConnection;
      if (
        signal.signal === "offer" &&
        (!connection || ["closed", "failed"].includes(connection.connectionState) || connection.signalingState !== "stable")
      ) {
        connection = replacePeerConnection();
      } else if (signal.signal === "ice" && (!connection || ["closed", "failed"].includes(connection.connectionState))) {
        connection = replacePeerConnection();
      }
      if (!connection || connection.connectionState === "closed") {
        return;
      }
      if (signal.signal === "answer" && connection.signalingState !== "have-local-offer") {
        return;
      }
      try {
        await handleSignalMessage(connection, sendSignal, signal);
        if (signal.signal === "answer") {
          cancelRtcNegotiationTimeout();
          setP2pError("");
        }
      } catch {
        if (!disposed && peerConnection === connection) {
          setP2pRtcState("offline");
          scheduleRtcReconnect();
        }
      }
    }

    void (async () => {
      iceServers = await getIceServers();
      if (disposed) {
        return;
      }
      replacePeerConnection();

      function scheduleSocketReconnect() {
        if (disposed || !reconnectAllowed || socketReconnectTimer !== undefined) {
          return;
        }
        socketReconnectTimer = window.setTimeout(() => {
          socketReconnectTimer = undefined;
          connectSocket();
        }, P2P_RECONNECT_DELAY_MS);
      }

      function connectSocket() {
        if (disposed || !reconnectAllowed) {
          return;
        }
        setP2pSocketState("connecting");
        const nextSocket = new WebSocket(getWsUrl(roomId));
        socket = nextSocket;
        wsRef.current = nextSocket;

        nextSocket.addEventListener("open", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          if (socketReconnectTimer !== undefined) {
            window.clearTimeout(socketReconnectTimer);
            socketReconnectTimer = undefined;
          }
          setP2pSocketState("connected");
          setP2pError("");
          publishProfile();
        });

        nextSocket.addEventListener("message", async (event) => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          const incoming = parsePeerMessage(event.data);
          if (!incoming) {
            return;
          }
          if (incoming.systemEvent === "room-full" && hasJoinedRoom) {
            setP2pSocketState("offline");
            setP2pError("旧的信令连接仍在释放，正在自动重试。");
            nextSocket.close();
            return;
          }
          if (incoming.systemEvent === "room-not-found" || incoming.systemEvent === "room-full") {
            reconnectAllowed = false;
            cancelRtcReconnect();
            if (socketReconnectTimer !== undefined) {
              window.clearTimeout(socketReconnectTimer);
              socketReconnectTimer = undefined;
            }
            setP2pRoomIssue(incoming.systemEvent === "room-full" ? "full" : "not-found");
            setP2pSocketState("error");
            setP2pRtcState("error");
            setP2pDataChannelState("idle");
            setP2pPeers([]);
            setP2pStep("invalid-room");
            return;
          }
          if (incoming.peerId) {
            hasJoinedRoom = true;
            peerIdRef.current = incoming.peerId;
            peerProfilesRef.current.set(incoming.peerId, localDisplayName);
            publishProfile();
          }
          if (incoming.peers) {
            const resolvedPeers = resolvePeers(incoming.peers, peerProfilesRef.current, peerIdRef.current, localDisplayName);
            p2pPeersRef.current = resolvedPeers;
            setP2pPeers(resolvedPeers);
          }
          if (incoming.systemEvent === "peer-joined" || (incoming.systemEvent === "joined" && (incoming.peers?.length ?? 0) >= 2)) {
            publishProfile();
          }
          if (incoming.body && ["joined", "peer-joined", "peer-left"].includes(incoming.systemEvent || "")) {
            setP2pMessages((messages) => [
              ...messages,
              {
                id: makeId("system"),
                author: "系统",
                body: incoming.body || "",
                lane: "p2p",
                at: nowLabel()
              }
            ]);
          }
          if (incoming.secure) {
            try {
              const decrypted = await decryptSecurePayload<unknown>(sessionKeys, incoming.secure);
              if (
                disposed ||
                p2pSessionGenerationRef.current !== sessionGeneration ||
                socket !== nextSocket
              ) {
                return;
              }
              if (incoming.secure.channel === "signal") {
                const signal = normalizeSignalPayload(decrypted);
                if (signal) {
                  await applySignal(signal);
                }
                return;
              }
              if (incoming.secure.channel === "profile") {
                const profile = normalizeProfilePayload(decrypted);
                if (profile) {
                  const senderId = profile.peerId ?? incoming.from?.id ?? findRemotePeerId(incoming.peers ?? p2pPeersRef.current, peerIdRef.current);
                  if (senderId) {
                    peerProfilesRef.current.set(senderId, profile.name);
                    setP2pPeers((peers) => resolvePeers(peers, peerProfilesRef.current, peerIdRef.current, localDisplayName));
                  }
                }
                return;
              }
              if (incoming.secure.channel === "ws-chat") {
                const messageEnvelope = normalizeWsChatPayload(decrypted);
                if (messageEnvelope) {
                  await handleP2pMessageEnvelope(messageEnvelope);
                }
                return;
              }
            } catch {
              if (!disposed && p2pSessionGenerationRef.current === sessionGeneration) {
                setP2pError("收到无法解密的内容，请确认双方安全口令和邀请链接一致。");
              }
              return;
            }
          }
          const signal = incoming.signal;
          if (signal) {
            await applySignal(signal);
            return;
          }
          if (incoming.peers && incoming.peers.length >= 2 && peerIdRef.current) {
            void renegotiateRtc(false);
          }
        });

        nextSocket.addEventListener("close", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          socket = null;
          if (wsRef.current === nextSocket) {
            wsRef.current = null;
          }
          setP2pSocketState("offline");
          if (dataChannelRef.current?.readyState !== "open") {
            markPendingP2pMessagesFailed("信令连接已断开，消息未送达");
          }
          scheduleSocketReconnect();
        });

        nextSocket.addEventListener("error", () => {
          if (disposed || socket !== nextSocket) {
            return;
          }
          setP2pSocketState("error");
          setP2pError("实时信令暂不可用，正在尝试重新连接。");
          nextSocket.close();
        });
      }

      connectSocket();
    })();

    return () => {
      disposed = true;
      cancelRtcReconnect();
      cancelRtcNegotiationTimeout();
      if (p2pSessionGenerationRef.current === sessionGeneration) {
        p2pSessionGenerationRef.current += 1;
      }
      p2pDataMessageQueueRef.current = Promise.resolve();
      if (socketReconnectTimer !== undefined) {
        window.clearTimeout(socketReconnectTimer);
      }
      socket?.close();
      dataChannelRef.current?.close();
      peerConnection?.close();
      wsRef.current = null;
      dataChannelRef.current = null;
      setP2pDataChannelState("idle");
      pendingIceRef.current = [];
    };
  }, [canStartPeerSession, localDisplayName, p2pStep, roomId]);

  async function createP2pRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      return;
    }

    if (p2pCreateInFlightRef.current) return;
    p2pCreateInFlightRef.current = true;
    setP2pCreating(true);
    const creationSession = p2pSessionGenerationRef.current;
    try {
    setP2pStatus("connecting");
    setP2pSocketState("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setSessionSaved("idle");

    if (roomId) {
      if (!roomSecret) {
        setP2pStatus("error");
        setP2pRoomIssue("missing-key");
        setP2pStep("invalid-room");
        return;
      }
      try {
        const response = await fetch(`/api/p2p/rooms/${encodeURIComponent(roomId)}`);
        if (creationSession !== p2pSessionGenerationRef.current) return;
        if (response.status === 404) {
          setP2pStatus("error");
          setP2pSocketState("error");
          setP2pRtcState("error");
          setP2pDataChannelState("idle");
          setP2pRoomIssue("not-found");
          setP2pStep("invalid-room");
          return;
        }
        if (!response.ok) {
          setP2pError(`房间校验暂不可用：${response.status} ${response.statusText || "请求失败"}`);
        }
        setInviteLink(withRoomSecret(getInviteLink(roomId), roomSecret));
        setP2pStatus("idle");
        setP2pStep("chat");
      } catch (error) {
      if (creationSession !== p2pSessionGenerationRef.current) return;
        setP2pError(userFacingErrorMessage(error, "房间校验暂不可用。"));
        setInviteLink(withRoomSecret(getInviteLink(roomId), roomSecret));
        setP2pStatus("idle");
        setP2pStep("chat");
      }
      return;
    }

    try {
      const nextSecret = generateRoomSecret();
      const data = await fetch("/api/p2p/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPeers: p2pParticipantCount })
      }).then((response) => parseJson<{ roomId?: string; id?: string; inviteLink?: string }>(response));
      if (creationSession !== p2pSessionGenerationRef.current) return;
      const nextRoomId = data.roomId ?? data.id;
      if (!nextRoomId) {
        throw new Error("房间 API 未返回房间 ID");
      }
      setRoomId(nextRoomId);
      setRoomSecret(nextSecret);
      setInviteLink(withRoomSecret(getInviteLink(nextRoomId), nextSecret));
      writeAppRoute({ kind: "direct", roomId: nextRoomId }, { replace: true, roomSecret: nextSecret });
      setRoomDetailsOpen(false);
      setP2pStep("chat");
    } catch (error) {
      if (creationSession !== p2pSessionGenerationRef.current) return;
      setRoomId("");
      setInviteLink("");
      setP2pError(userFacingErrorMessage(error, "房间 API 暂不可用。"));
    } finally {
      setP2pStatus("idle");
    }
      } finally {
      p2pCreateInFlightRef.current = false;
      setP2pCreating(false);
    }
  }

  async function loadWorkspace() {
    if (workspaceLoadingRef.current) return;
    const sessionEpoch = workspaceSessionEpochRef.current + 1;
    workspaceSessionEpochRef.current = sessionEpoch;
    const bootstrapRequestGeneration = workspaceBootstrapRequestGenerationRef.current + 1;
    workspaceBootstrapRequestGenerationRef.current = bootstrapRequestGeneration;
    advanceWorkspaceAccessEpoch();
    const accessEpoch = workspaceAccessEpochRef.current;
    workspaceCanReadConversationsRef.current = false;
    workspaceCanDownloadRef.current = false;
    workspaceConversationMembershipEpochRef.current.clear();
    workspaceConversationHistoryEpochRef.current.clear();
    workspaceConversationMessageRevisionRef.current.clear();
    workspaceConversationListRequestTokenRef.current += 1;
    workspaceConversationResponseGenerationRef.current.clear();
    workspaceLoadingRef.current = true;
    setWorkspaceStatus("loading");
    setWorkspaceError("");
    setWorkspaceNotice(null);
    try {
      const bootstrap = await workspaceJson<WorkspaceBootstrap>("/api/workspace/bootstrap");
      if (
        !isWorkspaceBootstrapResponseCurrent(
          sessionEpoch,
          workspaceSessionEpochRef.current,
          bootstrapRequestGeneration,
          workspaceBootstrapRequestGenerationRef.current
        ) ||
        !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current)
      ) return;
      workspaceRealtimeSeqRef.current = Math.max(0, Number(bootstrap.eventCursor) || 0);
      workspaceSeenEventIdsRef.current.clear();
      const [conversations, files, members] = await Promise.all([
        bootstrap.conversations
          ? Promise.resolve({ conversations: bootstrap.conversations })
          : bootstrap.permissions.canReadConversations
          ? workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations")
          : Promise.resolve({ conversations: [] }),
        bootstrap.files
          ? Promise.resolve({ files: bootstrap.files })
          : bootstrap.permissions.canDownload
          ? workspaceJson<{ files: WorkspaceFile[] }>("/api/workspace/files")
          : Promise.resolve({ files: [] }),
        bootstrap.members
          ? Promise.resolve({ members: bootstrap.members })
          : workspaceJson<{ members: WorkspaceUser[] }>("/api/workspace/members")
      ]);
      if (
        !isWorkspaceBootstrapResponseCurrent(
          sessionEpoch,
          workspaceSessionEpochRef.current,
          bootstrapRequestGeneration,
          workspaceBootstrapRequestGenerationRef.current
        ) ||
        !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current)
      ) return;
      workspaceCanReadConversationsRef.current = bootstrap.permissions.canReadConversations;
      workspaceCanDownloadRef.current = bootstrap.permissions.canDownload;
      setWorkspaceBootstrap({ ...bootstrap, members: members.members });
      setWorkspaceDirectoryMembers(members.members);
      workspaceConversationsRef.current = conversations.conversations;
      setWorkspaceConversations(conversations.conversations);
      setWorkspaceFiles(files.files);
      setWorkspaceLibraryFiles(files.files);
      setWorkspaceHistoryLoadingByConversation({});
      setWorkspaceHistoryExhaustedByConversation({});
      setWorkspaceStatus("ready");
    } catch (error) {
      if (
        !isWorkspaceBootstrapResponseCurrent(
          sessionEpoch,
          workspaceSessionEpochRef.current,
          bootstrapRequestGeneration,
          workspaceBootstrapRequestGenerationRef.current
        ) ||
        !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current)
      ) return;
      const message = userFacingErrorMessage(error, "共享空间暂时不可用");
      const code = error instanceof WorkspaceClientError ? error.code : "";
      setWorkspaceError(code === "auth.required" ? "" : message);
      setWorkspaceStatus(code === "workspace.disabled" ? "disabled" : code.startsWith("auth.") ? "auth" : "error");
    } finally {
      if (sessionEpoch === workspaceSessionEpochRef.current) {
        workspaceLoadingRef.current = false;
      }
    }
  }

  async function refreshWorkspaceStatistics() {
    if (workspaceBootstrap?.auth.currentUser.role !== "owner") {
      return;
    }
    setWorkspaceStatisticsLoading(true);
    setWorkspaceStatisticsError("");
    try {
      const data = await workspaceJson<{ statistics: WorkspaceStatistics }>("/api/workspace/statistics");
      setWorkspaceStatistics(data.statistics);
    } catch (error) {
      setWorkspaceStatisticsError(userFacingErrorMessage(error, "系统统计暂时无法加载"));
    } finally {
      setWorkspaceStatisticsLoading(false);
    }
  }
  async function refreshWorkspaceMembers() {
    const params = new URLSearchParams();
    const query = workspaceMemberQuery.trim();
    if (query) {
      params.set("q", query);
    }
    if (workspaceMemberRoleFilter !== "all") {
      params.set("role", workspaceMemberRoleFilter);
    }
    if (workspaceMemberKindFilter !== "all") {
      params.set("kind", workspaceMemberKindFilter);
    }
    const data = await workspaceJson<{ members: WorkspaceUser[] }>(`/api/workspace/members${params.size ? `?${params.toString()}` : ""}`);
    setWorkspaceDirectoryMembers(data.members);
  }

  async function refreshWorkspaceBootstrap() {
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const bootstrapRequestGeneration = workspaceBootstrapRequestGenerationRef.current + 1;
    workspaceBootstrapRequestGenerationRef.current = bootstrapRequestGeneration;
    let data: WorkspaceBootstrap;
    try {
      data = await workspaceJson<WorkspaceBootstrap>("/api/workspace/bootstrap");
    } catch (error) {
      if (
        !isWorkspaceBootstrapResponseCurrent(
          sessionEpoch,
          workspaceSessionEpochRef.current,
          bootstrapRequestGeneration,
          workspaceBootstrapRequestGenerationRef.current
        ) ||
        !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current)
      ) {
        return null;
      }
      throw error;
    }
    if (!isWorkspaceBootstrapResponseCurrent(
      sessionEpoch,
      workspaceSessionEpochRef.current,
      bootstrapRequestGeneration,
      workspaceBootstrapRequestGenerationRef.current
    ) || !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current)) {
      return null;
    }
    const previousPermissions = workspaceBootstrap?.permissions;
    const previousRole = workspaceBootstrap?.auth.currentUser.role;
    const readAccessRestored = Boolean(
      !workspaceCanReadConversationsRef.current &&
      data.permissions.canReadConversations
    );
    const downloadAccessRestored = Boolean(
      !workspaceCanDownloadRef.current &&
      data.permissions.canDownload
    );
    if (
      previousPermissions &&
      (workspacePermissionsChanged(previousPermissions, data.permissions) ||
        previousRole !== data.auth.currentUser.role)
    ) {
      advanceWorkspaceAccessEpoch();
    }
    workspaceCanReadConversationsRef.current = data.permissions.canReadConversations;
    workspaceCanDownloadRef.current = data.permissions.canDownload;
    if (!data.permissions.canReadConversations) {
      clearWorkspaceConversationAccessState();
    }
    if (!data.permissions.canDownload) {
      setWorkspaceFiles([]);
      setWorkspaceLibraryFiles([]);
      setWorkspaceImagePreview(null);
    }
    if (readAccessRestored) {
      if (data.conversations) {
        workspaceConversationsRef.current = data.conversations;
        setWorkspaceConversations(data.conversations);
        setWorkspaceHistoryLoadingByConversation({});
        setWorkspaceHistoryExhaustedByConversation({});
      } else {
        void refreshWorkspaceConversations().catch(() => undefined);
      }
    }
    if (downloadAccessRestored) {
      if (data.files) {
        setWorkspaceFiles(data.files);
        setWorkspaceLibraryFiles(data.files);
      } else {
        void refreshWorkspaceFiles().catch(() => undefined);
      }
    }
    setWorkspaceBootstrap(data);
    setWorkspaceDirectoryMembers(data.members);
    return data;
  }

  function setWorkspaceConversationDraft(conversationId: string, draft: WorkspaceComposerDocument | string) {
    if (!conversationId) {
      return;
    }
    const document = typeof draft === "string"
      ? { source: draft, blocks: draft ? [{ type: "text" as const, text: draft }] : [] }
      : draft;
    setWorkspaceDraftByConversation((drafts) => {
      if (!document.source && document.blocks.length === 0) {
        const { [conversationId]: _removed, ...rest } = drafts;
        return rest;
      }
      return { ...drafts, [conversationId]: document };
    });
  }

  function selectWorkspaceConversation(conversationId: string, showDetails = false) {
    navigation.request(() => {
    const previousId = workspaceSelectedConversationId;
    if (previousId && previousId !== conversationId) {
      workspaceScrollIntentUntilRef.current = 0;

      setWorkspaceUnreadAnchorByConversation((anchors) => {
        const { [previousId]: _removed, ...rest } = anchors;
        return rest;
      });
    }
    setWorkspaceHistoryTargetId("");
    setWorkspaceMessageLocateTarget(null);
    workspaceStickToBottomRef.current = true;
    setWorkspaceSelectedConversationId(conversationId);
    setWorkspaceView("chat");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, conversationId }));
    setWorkspaceContextMode("conversation");
    setWorkspaceContextTab("overview");
    setWorkspaceMobilePane(showDetails ? "details" : "main");
    if (showDetails) setWorkspaceContextCollapsed(false);
    setWorkspaceCreateMenuOpen(false);

    });
  }

  function updateWorkspaceComposerAttachments(
    conversationId: string,
    updater: (attachments: WorkspaceComposerAttachment[]) => WorkspaceComposerAttachment[]
  ) {
    setWorkspaceComposerAttachmentsByConversation((current) => {
      const nextAttachments = updater(current[conversationId] ?? []);
      if (nextAttachments.length === 0) {
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [conversationId]: nextAttachments };
    });
  }

  function stageWorkspaceAttachments(files: File[], scopeKey = workspaceSelectedConversationId) {
    if (!scopeKey || !workspaceBootstrap?.permissions.canUpload || files.length === 0) {
      return;
    }
    const existing = workspaceComposerAttachmentsByConversation[scopeKey] ?? [];
    const availableSlots = Math.max(0, WORKSPACE_MAX_STAGED_ATTACHMENTS - existing.length);
    const selected = files.slice(0, availableSlots);
    if (selected.length === 0) {
      showWorkspaceNotice("warning", `每条消息最多添加 ${WORKSPACE_MAX_STAGED_ATTACHMENTS} 个文件`);
      return;
    }
    const remainingQuota = workspaceBootstrap.policy.remainingQuotaBytes ?? workspaceBootstrap.policy.dailyQuotaBytes;
    const queuedBytes = existing
      .filter((attachment) => attachment.state !== "uploaded")
      .reduce((total, attachment) => total + attachment.file.size, 0);
    const nextBytes = selected.reduce((total, file) => total + file.size, 0);
    if (queuedBytes + nextBytes > remainingQuota) {
      showWorkspaceNotice("warning", "这些文件超过今日剩余传输额度");
      return;
    }
    const staged = selected.map<WorkspaceComposerAttachment>((file) => ({
      id: makeId("staged-file"),
      file,
      previewUrl: isPreviewableImageMimeType(file.type) ? URL.createObjectURL(file) : undefined,
      state: "queued",
      progress: 0
    }));
    updateWorkspaceComposerAttachments(scopeKey, (attachments) => [...attachments, ...staged]);
    if (selected.length < files.length) {
      showWorkspaceNotice("info", `已添加 ${selected.length} 个文件，每条消息最多 ${WORKSPACE_MAX_STAGED_ATTACHMENTS} 个`);
    }
  }

  async function removeWorkspaceComposerAttachment(conversationId: string, attachmentId: string) {
    const attachment = workspaceComposerAttachmentsRef.current[conversationId]?.find((item) => item.id === attachmentId);
    if (!attachment) {
      return;
    }
    workspaceUploadControllersRef.current.get(attachmentId)?.abort();
    workspaceUploadControllersRef.current.delete(attachmentId);
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    updateWorkspaceComposerAttachments(conversationId, (attachments) =>
      attachments.filter((item) => item.id !== attachmentId)
    );
    if (attachment.attachment?.id) {
      try {
        await workspaceJson(`/api/workspace/files/${encodeURIComponent(attachment.attachment.id)}`, { method: "DELETE" });
        removeWorkspaceFileFromClient(attachment.attachment.id);
      } catch (error) {
        showWorkspaceNotice("warning", userFacingErrorMessage(error, "暂存文件移除失败"));
      }
    }
  }

  function setWorkspaceConversationReplyToMessageId(conversationId: string, messageId: string) {
    if (!conversationId) {
      return;
    }
    setWorkspaceReplyToMessageIdByConversation((replyTargets) => {
      if (!messageId) {
        const { [conversationId]: _removed, ...rest } = replyTargets;
        return rest;
      }
      return { ...replyTargets, [conversationId]: messageId };
    });
    if (messageId && workspaceReplyAutoMention) {
      const conversation = workspaceConversations.find((item) => item.id === conversationId);
      const target = conversation?.latestMessages.find((message) => message.id === messageId);
      const author = target && conversation?.members.find((member) => member.id === target.authorId);
      const currentUserId = workspaceBootstrap?.auth.currentUser.id;
      if (conversation?.type === "group" && author && author.id !== currentUserId) {
        setWorkspaceDraftByConversation((drafts) => {
          const current = drafts[conversationId] ?? { source: "", blocks: [] };
          const next = workspaceDraftWithReplyMention(current, { enabled: workspaceReplyAutoMention, currentUserId: currentUserId ?? "", replyAuthorId: author.id, members: conversation.members });
          return next === current ? drafts : { ...drafts, [conversationId]: next };
        });
      }
    }
  }

  function clearWorkspaceClientState() {
    workspaceTopicSessionStore.clear();
    setWorkspaceTopicLocateRequest(null);
    cancelPendingCommand();
    setWorkspaceEmoteManagerOpen(false);
    workspaceSessionEpochRef.current += 1;
    advanceWorkspaceAccessEpoch();
    workspaceBootstrapRequestGenerationRef.current += 1;
    workspaceLoadingRef.current = false;
    workspaceCanReadConversationsRef.current = false;
    workspaceCanDownloadRef.current = false;
    clearStoredWorkspaceEchoWorkflowDrafts();
    clearWorkspaceEmoteLibraryCache();
    setWorkspaceChatSettings(null);
    for (const controller of workspaceUploadControllersRef.current.values()) {
      controller.abort();
    }
    workspaceUploadControllersRef.current.clear();
    for (const attachments of Object.values(workspaceComposerAttachmentsRef.current)) {
      for (const attachment of attachments) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    }
    for (const message of workspaceLocalMessagesRef.current) {
      workspaceCancelledLocalMessageIdsRef.current.add(message.id);
      for (const attachment of message.pendingAttachments ?? []) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    }
    workspaceWsRef.current?.close();
    workspaceWsRef.current = null;
    workspaceRealtimeSeqRef.current = 0;
    workspaceSeenEventIdsRef.current.clear();
    workspaceRealtimeEventQueueRef.current = Promise.resolve();
    workspaceSendingRef.current = false;
    workspaceMarkReadInFlightRef.current.clear();
    workspaceConversationsRef.current = [];
    workspaceConversationMembershipEpochRef.current.clear();
    workspaceConversationHistoryEpochRef.current.clear();
    workspaceConversationMessageRevisionRef.current.clear();
    workspaceConversationListRequestTokenRef.current += 1;
    workspaceConversationResponseGenerationRef.current.clear();
    setWorkspaceBootstrap(null);
    setWorkspaceStatistics(null);
    setWorkspaceStatisticsLoading(false);
    setWorkspaceStatisticsError("");
    setWorkspaceConversations([]);
    setWorkspaceConversationTopicsById({});

    setWorkspaceFiles([]);
    setWorkspaceLibraryFiles([]);
    setWorkspaceDirectoryMembers([]);
    setWorkspaceSelectedConversationId("");
    setWorkspaceDraftByConversation({});
    workspaceEchoInteractionByConversationRef.current = {};
    setWorkspaceEchoInteractionByConversation({});
    setWorkspaceReplyToMessageIdByConversation({});
    setWorkspaceComposerAttachmentsByConversation({});
    setWorkspacePinsByConversation({});
    setWorkspacePinsExpandedByConversation({});
    setWorkspaceHistoryTargetId("");
    setWorkspaceMessageLocateTarget(null);
    setWorkspaceReturningToLatestConversationId("");
    setWorkspaceUnreadAnchorByConversation({});
    setWorkspaceNewMessageCountByConversation({});
    setWorkspaceAwayFromLatestByConversation({});
    setWorkspaceScrollToLatestRequest(0);
    workspaceHandledScrollToLatestRequestRef.current = 0;
    setWorkspaceLocalMessages([]);
    setWorkspaceError("");
    setWorkspaceNotice(null);
    setWorkspacePendingInviteCode("");
    setWorkspaceInviteCode("");
    setWorkspaceInviteCodeId("");
    setWorkspaceNewGroupTitle("");
    setWorkspaceNewGroupAvatarEmoji("");
    setWorkspaceGroupRenameTitle("");
    setWorkspaceGroupAvatarEmoji("");
    setWorkspaceView("chat");
    setWorkspaceMobilePane("list");
    setWorkspaceContextMode("conversation");
    setWorkspaceContextTab("overview");
    setWorkspaceSpaceTab("overview");
    setWorkspaceCreateMode("");
    setWorkspaceMemberQuery("");
    setWorkspacePickerMemberQuery("");
    setWorkspaceContextMemberQuery("");
    clearWorkspaceMemberVisibilityState();
    setWorkspaceConversationQuery("");
    setWorkspaceFileQuery("");
    setWorkspaceMemberRoleFilter("all");
    setWorkspaceMemberKindFilter("all");
    setWorkspaceGroupMemberIds([]);
    setWorkspaceFileFilter("all");
    setWorkspaceFileCategory("all");
    setWorkspaceFileViewMode("list");
    setWorkspaceContextFileCategory("all");
    setWorkspaceContextFileViewMode("list");
    setWorkspaceSelectedFileId("");
    setWorkspaceUploading(false);
    setWorkspaceGroupMemberBusyId("");
    setWorkspaceRealtimeState("idle");
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);
    setWorkspaceMemberFilterOpen(false);
    setWorkspaceReactionPendingKeys([]);
    workspaceReactionLocksRef.current.clear();
    setWorkspaceImagePreview(null);
    setWorkspaceHistoryLoadingByConversation({});
    setWorkspaceHistoryExhaustedByConversation({});
  }

  function handleWorkspaceRealtimeError(error: WorkspaceRealtimeEnvelope["error"]) {
    if (error?.code === "auth.required") {
      clearWorkspaceClientState();
      setWorkspaceStatus("auth");
      setWorkspaceError(error.message || "登录后进入共享空间。");
      return;
    }
    setWorkspaceRealtimeState("error");
    showWorkspaceNotice("warning", error?.message || "实时同步异常", { persistent: true });
  }

  async function logoutWorkspace() {
    requestWorkspaceExit(async () => {
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } catch {
      // Local session state should still be cleared if the cookie is already gone.
    }
    clearWorkspaceClientState();
    setWorkspaceStatus("auth");
    setWorkspaceError("登录后进入共享空间。");

    });
  }

  async function refreshWorkspaceConversations() {
    const listRequestToken = workspaceConversationListRequestTokenRef.current + 1;
    workspaceConversationListRequestTokenRef.current = listRequestToken;
    if (!workspaceCanReadConversationsRef.current) {
      invalidateWorkspaceConversationAccess();
      setWorkspaceConversations([]);
      return;
    }
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const requests = new Map(
      workspaceConversationsRef.current.map((conversation) => [
        conversation.id,
        beginWorkspaceConversationMessageRequest(conversation.id, "list")
      ])
    );
    const data = await workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations");
    if (
      sessionEpoch !== workspaceSessionEpochRef.current ||
      !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current) ||
      !workspaceCanReadConversationsRef.current ||
      !isWorkspaceConversationListResponseCurrent(
        listRequestToken,
        workspaceConversationListRequestTokenRef.current
      )
    ) {
      return;
    }
    const currentConversations = data.conversations.filter((conversation) => {
      const request = requests.get(conversation.id);
      return !request || isCurrentWorkspaceConversationMessageRequest(conversation.id, request);
    });
    const returnedConversationIds = new Set(currentConversations.map((conversation) => conversation.id));
    for (const conversation of workspaceConversationsRef.current) {
      if (!returnedConversationIds.has(conversation.id)) {
        advanceWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversation.id);
        workspaceMarkReadInFlightRef.current.delete(conversation.id);
      }
    }
    setWorkspaceConversations((conversations) => mergeWorkspaceConversationList(
      conversations,
      currentConversations,
      new Map(
        [...requests].map(([conversationId, request]) => [
          conversationId,
          workspaceConversationMessageMergeContext(conversationId, request)
        ])
      )
    ));
  }

  async function refreshWorkspaceFiles() {
    if (!workspaceCanDownloadRef.current) {
      setWorkspaceLibraryFiles([]);
      return;
    }
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const params = new URLSearchParams();
    if (workspaceFileFilter !== "all") {
      params.set("scope", workspaceFileFilter);
    }
    const query = workspaceFileQuery.trim();
    if (query) {
      params.set("q", query);
    }
    const data = await workspaceJson<{ files: WorkspaceFile[] }>(`/api/workspace/files${params.size ? `?${params.toString()}` : ""}`);
    if (
      sessionEpoch !== workspaceSessionEpochRef.current ||
      !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current) ||
      !workspaceCanDownloadRef.current
    ) return;
    setWorkspaceLibraryFiles(data.files);
  }

  async function refreshWorkspaceConversationMessages(conversationId: string) {
    if (!workspaceCanReadConversationsRef.current || !conversationId) {
      return;
    }
    const request = beginWorkspaceConversationMessageRequest(conversationId, "messages", true);
    const params = new URLSearchParams({ limit: "40" });
    const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
    );
    if (!isCurrentWorkspaceConversationMessageRequest(conversationId, request)) return;
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              latestMessages: mergeWorkspaceMessageWindow(
                conversation.latestMessages,
                data.messages,
                {
                  ...workspaceConversationMessageMergeContext(conversationId, request),
                  preserveLoadedHistory: false,
                  authoritativeWindow: true,
                  preservePostRequestMessages: true
                }
              )
            }
          : conversation
      )
    );
  }

  async function refreshWorkspacePins(conversationId: string) {
    if (!workspaceCanReadConversationsRef.current || !conversationId) {
      return [];
    }
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const data = await workspaceJson<{ pins: WorkspacePinnedMessage[] }>(
      `/api/workspace/groups/${encodeURIComponent(conversationId)}/pins?limit=100`
    );
    if (
      sessionEpoch !== workspaceSessionEpochRef.current ||
      !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current) ||
      !workspaceCanReadConversationsRef.current
    ) return [];
    setWorkspacePinsByConversation((current) => ({ ...current, [conversationId]: data.pins }));
    return data.pins;
  }

  async function toggleWorkspacePin(message: Message) {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.type !== "group") return;
    clearWorkspaceNotice();
    try {
      if (message.pin) {
        await workspaceMessageCommands.setPinned(workspaceSelectedConversation.id, message.id, false);
        showWorkspaceNotice("success", "已取消常驻");
      } else {
        await workspaceMessageCommands.setPinned(workspaceSelectedConversation.id, message.id, true);
        showWorkspaceNotice("success", "消息已设为常驻");
      }
      await Promise.all([
        refreshWorkspacePins(workspaceSelectedConversation.id),
        refreshWorkspaceConversationMessages(workspaceSelectedConversation.id)
      ]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, message.pin ? "取消常驻失败" : "设置常驻失败"));
    }
  }

  async function removeWorkspacePin(messageId: string) {
    if (!workspaceSelectedConversation) return;
    try {
      await workspaceJson(`/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/pins/${encodeURIComponent(messageId)}`, {
        method: "DELETE"
      });
      await Promise.all([
        refreshWorkspacePins(workspaceSelectedConversation.id),
        refreshWorkspaceConversationMessages(workspaceSelectedConversation.id)
      ]);
      showWorkspaceNotice("success", "已取消常驻");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "取消常驻失败"));
    }
  }

  async function recallWorkspaceMessage(message: Message) {
    if (!message.self || message.localState || message.recalledAt) return;
    if (!await confirm("撤回这条消息？撤回后聊天中不再显示原内容。")) return;
    try {
      await workspaceMessageCommands.recall(message.id);
      if (workspaceSelectedConversation) {
        await Promise.all([
          refreshWorkspaceConversationMessages(workspaceSelectedConversation.id),
          refreshWorkspacePins(workspaceSelectedConversation.id),
          refreshWorkspaceConversations()
        ]);
        if (workspaceReplyToMessageIdByConversation[workspaceSelectedConversation.id] === message.id) {
          setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, "");
        }
      }
      showWorkspaceNotice("success", "消息已撤回");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "撤回消息失败"));
    }
  }

  async function jumpToWorkspaceMessage(messageId: string) {
    if (!workspaceSelectedConversation) return;
    const conversationId = workspaceSelectedConversation.id;
    workspaceStickToBottomRef.current = false;
    workspaceStickToBottomByConversationRef.current.set(conversationId, false);
    try {
      const alreadyLoaded = workspaceSelectedConversation.latestMessages.some((message) => message.id === messageId);
      const request = alreadyLoaded ? null : beginWorkspaceConversationMessageRequest(conversationId, "around", true);
      if (!alreadyLoaded) {
        const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
          `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?around=${encodeURIComponent(messageId)}&limit=41`
        );
        if (
          workspaceSelectedConversationIdRef.current !== conversationId ||
          !request ||
          !isCurrentWorkspaceConversationMessageRequest(conversationId, request)
        ) return;
        setWorkspaceHistoryExhaustedByConversation((current) => {
          if (!(conversationId in current)) return current;
          const { [conversationId]: _removed, ...rest } = current;
          return rest;
        });
        setWorkspaceHistoryTargetId(messageId);
        setWorkspaceConversations((conversations) => conversations.map((conversation) => conversation.id === conversationId
          ? {
              ...conversation,
              latestMessages: mergeWorkspaceMessageWindow(
                conversation.latestMessages,
                data.messages,
                request
                  ? {
                      ...workspaceConversationMessageMergeContext(conversationId, request),
                      preserveLoadedHistory: false,
                      authoritativeWindow: true,
                      preservePostRequestMessages: false
                    }
                  : undefined
              )
            }
          : conversation));
      }
      setWorkspaceMessageLocateTarget((current) => ({
        messageId,
        sequence: (current?.sequence ?? 0) + 1
      }));
      setWorkspaceContextCollapsed(true);
      setWorkspaceMobilePane("main");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "无法定位这条消息"));
    }
  }

  async function returnWorkspaceToLatest() {
    if (!workspaceSelectedConversation) return;
    const conversationId = workspaceSelectedConversation.id;
    setWorkspaceReturningToLatestConversationId(conversationId);
    try {
      await refreshWorkspaceConversationMessages(conversationId);
      if (workspaceSelectedConversationIdRef.current !== conversationId) {
        setWorkspaceReturningToLatestConversationId((current) => current === conversationId ? "" : current);
        return;
      }
      workspacePrependScrollRef.current = null;
      workspaceStickToBottomRef.current = true;
      workspaceStickToBottomByConversationRef.current.set(conversationId, true);
      workspaceScrollPositionsRef.current.delete(conversationId);
      setWorkspaceHistoryTargetId("");
      setWorkspaceMessageLocateTarget(null);
      setWorkspaceAwayFromLatestByConversation((current) => {
        if (!current[conversationId]) return current;
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      });
      setWorkspaceScrollToLatestRequest((request) => request + 1);
    } catch (error) {
      setWorkspaceReturningToLatestConversationId((current) => current === conversationId ? "" : current);
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "返回最新消息失败"));
    }
  }

  function normalizeWorkspaceRealtimeEvents(events: WorkspaceEvent[]) {
    return [...events]
      .filter((event) => event.id && !workspaceSeenEventIdsRef.current.has(event.id))
      .sort((left, right) => left.seq - right.seq);
  }

  function rememberWorkspaceRealtimeEvents(events: WorkspaceEvent[]) {
    for (const event of events) {
      workspaceSeenEventIdsRef.current.add(event.id);
      workspaceRealtimeSeqRef.current = Math.max(workspaceRealtimeSeqRef.current, event.seq);
    }
  }

  async function syncWorkspaceRealtimeState(currentSeqValue?: number) {
    const sessionEpoch = workspaceSessionEpochRef.current;
    setWorkspaceRealtimeState("syncing");
    try {
      const bootstrap = await refreshWorkspaceBootstrap();
      if (!bootstrap || sessionEpoch !== workspaceSessionEpochRef.current) return;
      await Promise.all([refreshWorkspaceConversations(), refreshWorkspaceFiles()]);
      const nextCursor = Number.isFinite(currentSeqValue) ? Number(currentSeqValue) : Number(bootstrap.eventCursor);
      if (Number.isFinite(nextCursor)) {
        workspaceRealtimeSeqRef.current = Math.max(0, nextCursor);
      }
      setWorkspaceRealtimeState("connected");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "同步共享空间失败"));
      setWorkspaceRealtimeState("error");
    }
  }

  async function projectWorkspaceEvents(events: WorkspaceEvent[]) {
    const tasks: Promise<unknown>[] = [];
    let needsMembers = false;
    let needsConversations = false;
    let needsFiles = false;
    let needsBootstrap = false;

    for (const event of events) {
      const payload = getWorkspaceEventPayload(event);
      if (event.type === "emote.library.updated") {
        const affectedUserId = payload.userId || (event.targetType === "user" ? event.targetId : "") || "";
        if (affectedUserId === workspaceCurrentUserIdRef.current) {
          notifyWorkspaceEmoteLibraryChanged();
        }
        continue;
      }

      if (event.type === "workspace.member_joined" || event.type === "workspace.member_updated") {
        const changedUserId = payload.userId || payload.member?.id || "";
        if (event.type === "workspace.member_updated" && changedUserId === workspaceCurrentUserIdRef.current) {
          advanceWorkspaceAccessEpoch();
          needsBootstrap = true;
        }
        if (payload.member) {
          upsertWorkspaceMember(payload.member);
        } else {
          needsMembers = true;
        }
        continue;
      }

      if (event.type.startsWith("topic.")) {
        const topicId = payload.topicId || (event.targetType === "topic" ? event.targetId : "") || "";
        const conversationId = payload.conversationId || event.conversationId || "";
        const affectsList = event.type !== "topic.notification.updated" &&
          event.type !== "topic.message.synced" &&
          event.type !== "topic.message.unsynced";
        setWorkspaceTopicRefreshSignal((current) => advanceWorkspaceTopicRefreshSignal(current, {
          topicId,
          conversationId,
          affectsList,
          messageId: payload.topicMessageId || payload.messageId
        }));
        if (event.type === "topic.created" || event.type === "topic.message.synced" || event.type === "topic.message.unsynced") {
          needsConversations = true;
        }
        if (conversationId && /(?:pinned|unpinned|recalled|closed|archived|member\.)/.test(event.type)) tasks.push(refreshWorkspacePins(conversationId));
        continue;
      }

      if (event.type === "card.created" || event.type === "card.updated" || event.type === "card.invalidated") {
        const cardId = payload.cardId || payload.card?.cardId || event.targetId || "";
        const revision = Number(payload.revision ?? payload.card?.revision ?? 0);
        if (cardId) {
          setWorkspaceCardRevisionById((current) => {
            const previous = current[cardId] ?? 0;
            if (revision <= previous && event.type !== "card.invalidated") return current;
            return { ...current, [cardId]: Math.max(previous + (event.type === "card.invalidated" && revision <= previous ? 1 : 0), revision) };
          });
        }
        // A card mutation changes only its projection. Keep the message list
        // stable and let the card component refetch the actor-scoped payload.
        continue;
      }

      if (event.type === "emote.settings.updated") {
        if ((payload.userId || event.actorId) === workspaceCurrentUserIdRef.current) {
          setWorkspaceChatSettingsRevision((revision) => revision + 1);
        }
        continue;
      }

      if (event.type === "workspace.member_visibility_updated") {
        const viewerUserId = payload.userId || event.targetId || "";
        if (viewerUserId === workspaceCurrentUserIdRef.current) {
          advanceWorkspaceAccessEpoch();
          needsMembers = true;
          needsBootstrap = true;
        }
        if (
          workspaceBootstrap?.permissions.canManageMemberVisibility &&
          viewerUserId &&
          viewerUserId === workspaceVisibilityViewerId
        ) {
          tasks.push(loadWorkspaceMemberVisibility(viewerUserId));
        }
        continue;
      }

      if (event.type === "workspace.member_removed") {
        if (payload.userId) {
          removeWorkspaceMemberFromClient(payload.userId);
          if (payload.userId === workspaceCurrentUserIdRef.current) {
            needsBootstrap = true;
          }
        } else {
          needsMembers = true;
          needsConversations = true;
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "conversation.created" || event.type === "conversation.updated") {
        // Realtime conversation projections can omit viewer capabilities. Read a
        // complete authorized snapshot instead of briefly revoking UI actions.
        if (payload.conversation?.capabilities) {
          upsertWorkspaceConversation(payload.conversation);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.notification_updated") {
        if (payload.conversation && !payload.conversation.capabilities) needsConversations = true;
        if (payload.conversation?.capabilities) {
          upsertWorkspaceConversation(payload.conversation);
        } else if (payload.conversationId && payload.notificationLevel) {
          setWorkspaceConversations((conversations) =>
            sortWorkspaceConversations(
              conversations.map((conversation) =>
                conversation.id === payload.conversationId
                  ? { ...conversation, notificationLevel: payload.notificationLevel }
                  : conversation
              )
            )
          );
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.member_added") {
        if (payload.conversationId && payload.member) {
          upsertWorkspaceConversationMember(payload.conversationId, payload.member);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "conversation.member_removed") {
        if (payload.conversationId && payload.userId) {
          removeWorkspaceConversationMember(payload.conversationId, payload.userId);
        } else {
          needsConversations = true;
        }
        continue;
      }

      if (event.type === "message.created" || event.type === "message.recalled") {
        const topicMessage = Boolean(
          payload.topicId ||
          (payload.message && (payload.message as WorkspaceMessage).topicId) ||
          (payload.topicCard === false)
        );
        if (topicMessage && !payload.topicCard) {
          const topicId = payload.topicId || (payload.message && (payload.message as WorkspaceMessage).topicId) || "";
          setWorkspaceTopicRefreshSignal((current) => advanceWorkspaceTopicRefreshSignal(current, {
            topicId,
            conversationId: payload.conversationId || event.conversationId || "",
            affectsList: true
          }));
          continue;
        }
        if (payload.message) {
          upsertWorkspaceMessage(payload.message, payload.conversation?.capabilities ? payload.conversation : undefined);
          if (payload.conversation && !payload.conversation.capabilities) needsConversations = true;
        } else if (payload.conversationId && payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        } else {
          needsConversations = true;
        }
        if (event.type === "message.recalled" && payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspacePins(payload.conversationId));
        }
        continue;
      }

      if (event.type === "reaction.added" || event.type === "reaction.removed") {
        if (payload.messageId && payload.reactions) {
          updateWorkspaceMessageReactions(payload.messageId, payload.reactions, event.seq);
        } else if (payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        }
        continue;
      }

      if (event.type === "message.pinned" || event.type === "message.unpinned") {
        if (payload.conversationId === workspaceSelectedConversationIdRef.current) {
          tasks.push(refreshWorkspacePins(payload.conversationId));
          tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));
        }
        continue;
      }

      if (event.type === "attachment.created" || event.type === "attachment.available" || event.type === "attachment.failed") {
        if (payload.attachment) {
          upsertWorkspaceFile(payload.attachment);
        } else {
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "attachment.removed") {
        if (payload.attachmentId) {
          removeWorkspaceFileFromClient(payload.attachmentId);
        } else {
          needsFiles = true;
        }
        continue;
      }

      if (event.type === "transfer.rejected" && event.actorId === workspaceCurrentUserIdRef.current) {
        showWorkspaceNotice("warning", payload.direction === "download" ? "今日传输额度不足，无法下载此文件。" : "今日传输额度不足，无法上传此文件。");
        needsBootstrap = true;
        continue;
      }

      if (event.conversationId) {
        needsConversations = true;
      }
    }

    if (needsMembers) tasks.push(refreshWorkspaceMembers());
    if (needsConversations) tasks.push(refreshWorkspaceConversations());
    if (needsFiles) tasks.push(refreshWorkspaceFiles());
    if (needsBootstrap) tasks.push(refreshWorkspaceBootstrap());
    await Promise.all(tasks);
  }

  function getWorkspaceEventPayload(event: WorkspaceEvent): WorkspaceEventPayload {
    return (event.payload ?? {}) as WorkspaceEventPayload;
  }

  function upsertWorkspaceMember(member: WorkspaceUser) {
    for (const conversation of workspaceConversationsRef.current) {
      if (conversation.latestMessages.some((message) =>
        message.authorId === member.id ||
        message.reactions.some((reaction) => reaction.users.some((user) => user.id === member.id))
      )) {
        advanceWorkspaceConversationMessageRevision(conversation.id);
      }
    }
    setWorkspaceDirectoryMembers((members) => upsertById(members, member).sort(compareWorkspaceMembers));
    setWorkspaceBootstrap((current) =>
      current
        ? {
            ...current,
            auth: current.auth.currentUser.id === member.id
              ? { ...current.auth, currentUser: member }
              : current.auth,
            members: upsertById(current.members, member).sort(compareWorkspaceMembers)
          }
        : current
    );
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        displayTitle: conversation.type === "direct" && conversation.otherMember?.id === member.id
          ? member.displayName
          : conversation.displayTitle,
        otherMember: conversation.otherMember?.id === member.id ? member : conversation.otherMember,
        members: conversation.members.some((candidate) => candidate.id === member.id)
          ? upsertById(conversation.members, member).sort(compareWorkspaceMembers)
          : conversation.members,
        latestMessages: conversation.latestMessages.map((message) => ({
          ...message,
          authorName: message.authorId === member.id ? member.displayName : message.authorName,
          authorAvatarUrl: message.authorId === member.id ? member.avatarUrl : message.authorAvatarUrl,
          reactions: message.reactions.map((reaction) => ({
            ...reaction,
            users: reaction.users.map((user) => user.id === member.id
              ? { ...user, displayName: member.displayName, avatarUrl: member.avatarUrl }
              : user)
          }))
        }))
      }))
    );
    const updateUploader = (file: WorkspaceFile) => file.uploaderId === member.id
      ? { ...file, uploaderName: member.displayName, uploader: { ...file.uploader, id: member.id, displayName: member.displayName } }
      : file;
    setWorkspaceFiles((files) => files.map(updateUploader));
    setWorkspaceLibraryFiles((files) => files.map(updateUploader));
  }

  function openWorkspaceMemberDetails(member: WorkspaceUser) {
    setWorkspaceSelectedMemberId(member.id);
    setWorkspaceView("members");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "members", memberId: member.id }));
    setWorkspaceContextMode("member");
    setWorkspaceContextCollapsed(false);
    setWorkspaceMobilePane("details");
  }

  function removeWorkspaceMemberFromClient(userId: string) {
    const removedCurrentUser = userId === workspaceCurrentUserIdRef.current;
    if (removedCurrentUser) {
      workspaceCanReadConversationsRef.current = false;
      workspaceCanDownloadRef.current = false;
      clearWorkspaceConversationAccessState();
    }
    setWorkspaceDirectoryMembers((members) => members.filter((member) => member.id !== userId));
    setWorkspaceBootstrap((current) =>
      current
        ? {
            ...current,
            members: current.members.filter((member) => member.id !== userId)
          }
        : current
    );
    if (!removedCurrentUser) {
      setWorkspaceConversations((conversations) =>
        sortWorkspaceConversations(
          conversations
            .map((conversation) => ({
              ...conversation,
              members: conversation.members.filter((member) => member.id !== userId)
            }))
            .filter((conversation) => conversation.members.length > 0)
        )
      );
      setWorkspaceFiles((files) => files.filter((file) => file.uploaderId !== userId));
      setWorkspaceLibraryFiles((files) => files.filter((file) => file.uploaderId !== userId));
    } else {
      setWorkspaceFiles([]);
      setWorkspaceLibraryFiles([]);
    }
  }

  function upsertWorkspaceConversation(conversation: WorkspaceConversation) {
    if (!workspaceCanReadConversationsRef.current) return;
    setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, conversation));
  }

  function upsertWorkspaceConversationMember(conversationId: string, member: WorkspaceUser) {
    if (!workspaceCanReadConversationsRef.current) return;
    setWorkspaceConversations((conversations) =>
      sortWorkspaceConversations(
        conversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                members: upsertById(conversation.members, member).sort(compareWorkspaceMembers)
              }
            : conversation
        )
      )
    );
  }

  function removeWorkspaceConversationMember(conversationId: string, userId: string) {
    const currentUserId = workspaceCurrentUserIdRef.current;
    const removedCurrentUser = userId === currentUserId;
    if (removedCurrentUser) {
      invalidateWorkspaceConversationAccess(conversationId);
    }
    setWorkspaceConversations((conversations) =>
      sortWorkspaceConversations(
        conversations
          .map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  members: conversation.members.filter((member) => member.id !== userId)
                }
              : conversation
          )
          .filter((conversation) => conversation.id !== conversationId || !removedCurrentUser)
      )
    );
    if (removedCurrentUser) {
      const revokedTopics = workspaceTopicSessionStore.removeConversation(conversationId, (attachments) => {
        attachments.forEach((attachment) => workspaceUploadControllersRef.current.get(attachment.id)?.abort());
      });
      revokedTopics.forEach((id) => {
        (workspaceComposerAttachmentsRef.current[`topic:${id}`] ?? []).forEach((attachment) => { void removeWorkspaceComposerAttachment(`topic:${id}`, attachment.id); });
      });
      setWorkspaceTopicRefreshSignal((current) => advanceWorkspaceTopicRefreshSignal(current, { topicId: "", conversationId, affectsList: true }));
      setWorkspaceTopicLocateRequest((current) => current && revokedTopics.includes(current.topicId) ? null : current);
      const outgoingMessages = workspaceLocalMessagesRef.current.filter((message) => message.conversationId === conversationId);
      for (const message of outgoingMessages) {
        void cancelWorkspaceLocalMessage(message.id);
      }
      setWorkspaceDraftByConversation((drafts) => {
        const { [conversationId]: _removed, ...rest } = drafts;
        return rest;
      });
      setWorkspaceReplyToMessageIdByConversation((replyTargets) => {
        const { [conversationId]: _removed, ...rest } = replyTargets;
        return rest;
      });
      setWorkspaceLocalMessages((messages) => messages.filter((message) => message.conversationId !== conversationId));
      setWorkspaceFiles((files) => files.filter((file) => file.conversationId !== conversationId));
      setWorkspaceLibraryFiles((files) => files.filter((file) => file.conversationId !== conversationId));
      if (workspaceSelectedFile?.conversationId === conversationId) {
        setWorkspaceSelectedFileId("");
        setWorkspaceContextMode("conversation");
      }
    }
    if (workspaceSelectedConversationIdRef.current === conversationId && removedCurrentUser) {
      setWorkspaceSelectedConversationId("");
      setWorkspaceContextMode("conversation");
      setWorkspaceContextTab("overview");
      setWorkspaceMobilePane("list");
      showWorkspaceNotice("warning", "你已不在此群聊中。");
    }
  }

  function upsertWorkspaceMessage(message: WorkspaceMessage, conversation?: WorkspaceConversation | null) {
    if (!workspaceCanReadConversationsRef.current) return;
    advanceWorkspaceConversationMessageRevision(message.conversationId);
    const preserveReadingWindow = message.conversationId === workspaceSelectedConversationIdRef.current &&
      !workspaceStickToBottomRef.current;
    if (message.clientMessageId) {
      setWorkspaceLocalMessages((messages) =>
        messages.filter((item) => item.clientMessageId !== message.clientMessageId)
      );
    }
    if (
      message.conversationId === workspaceSelectedConversationIdRef.current &&
      message.authorId !== workspaceCurrentUserIdRef.current &&
      !workspaceStickToBottomRef.current
    ) {
      setWorkspaceNewMessageCountByConversation((counts) => ({
        ...counts,
        [message.conversationId]: (counts[message.conversationId] ?? 0) + 1
      }));
    }
    setWorkspaceConversations((conversations) => {
      const next = conversations.map((item) => {
        if (item.id !== message.conversationId) {
          return conversation && item.id === conversation.id ? mergeWorkspaceConversation(item, conversation) : item;
        }
        const base = conversation ? mergeWorkspaceConversation(item, conversation) : { ...item };
        const existingMessages = base.latestMessages ?? [];
        const hasMessage = existingMessages.some((candidate) => candidate.id === message.id);
        return {
          ...base,
          latestMessages: upsertWorkspaceMessageList(existingMessages, message, preserveReadingWindow),
          messageCount: conversation ? base.messageCount : Math.max(base.messageCount ?? 0, item.messageCount ?? 0) + (hasMessage ? 0 : 1),
          lastActivityAt: conversation?.lastActivityAt ?? message.createdAt
        };
      });
      return sortWorkspaceConversations(conversation && !next.some((item) => item.id === conversation.id) ? [conversation, ...next] : next);
    });
  }


  function updateWorkspaceMessageReactions(
    messageId: string,
    reactions: WorkspaceReactionGroup[],
    eventSeq?: number
  ) {
    if (eventSeq !== undefined) {
      const latestEventSeq = workspaceReactionEventSeqRef.current.get(messageId) ?? 0;
      if (eventSeq < latestEventSeq) {
        return;
      }
      workspaceReactionEventSeqRef.current.set(messageId, eventSeq);
    }
    for (const conversation of workspaceConversationsRef.current) {
      if (conversation.latestMessages.some((message) => message.id === messageId)) {
        advanceWorkspaceConversationMessageRevision(conversation.id);
      }
    }
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        latestMessages: conversation.latestMessages.map((message) =>
          message.id === messageId ? { ...message, reactions } : message
        )
      }))
    );
  }

  function updateWorkspaceMessagesHidden(messageIds: string[], hidden: boolean) {
    const targetIds = new Set(messageIds);
    for (const conversation of workspaceConversationsRef.current) {
      if (conversation.latestMessages.some((message) => targetIds.has(message.id))) {
        advanceWorkspaceConversationMessageRevision(conversation.id);
      }
    }
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        latestMessages: conversation.latestMessages.map((message) =>
          targetIds.has(message.id) ? { ...message, hiddenByCurrentUser: hidden } : message
        )
      }))
    );
  }

  async function setWorkspaceMessagesHidden(messageIds: string[], hidden: boolean) {
    if (messageIds.length === 0) return;
    updateWorkspaceMessagesHidden(messageIds, hidden);
    try {
      await Promise.all(messageIds.map((messageId) => workspaceMessageCommands.setHidden(messageId, hidden)));
    } catch (error) {
      updateWorkspaceMessagesHidden(messageIds, !hidden);
      if (workspaceSelectedConversationIdRef.current) {
        await refreshWorkspaceConversationMessages(workspaceSelectedConversationIdRef.current).catch(() => undefined);
      }
      showWorkspaceNotice("warning", userFacingErrorMessage(error, hidden ? "隐藏消息失败" : "恢复消息失败"));
    }
  }

  async function toggleWorkspaceReaction(messageId: string, emoteKey: string) {
    const lockKey = `${messageId}::${emoteKey}`;
    if (workspaceReactionLocksRef.current.has(lockKey) || !workspaceBootstrap) {
      return;
    }
    const message = workspaceConversations
      .flatMap((conversation) => conversation.latestMessages)
      .find((candidate) => candidate.id === messageId);
    if (!message) {
      return;
    }

    const originalReactions = message.reactions ?? [];
    const reacted = originalReactions.some(
      (group) => group.emoteKey === emoteKey && group.reactedByCurrentUser
    );
    const currentUser = workspaceBootstrap.auth.currentUser;
    const eventSeqAtRequest = workspaceReactionEventSeqRef.current.get(messageId) ?? 0;
    const optimisticReactions = applyWorkspaceReactionOptimistic(originalReactions, emoteKey, {
      id: currentUser.id,
      displayName: currentUser.displayName,
      githubLogin: currentUser.githubLogin,
      avatarUrl: currentUser.avatarUrl,
      createdAt: new Date().toISOString()
    });

    workspaceReactionLocksRef.current.add(lockKey);
    setWorkspaceReactionPendingKeys((keys) => [...keys, lockKey]);
    updateWorkspaceMessageReactions(messageId, optimisticReactions);

    try {
      const response = await workspaceMessageCommands.setReaction(messageId, emoteKey, !reacted);
      if (shouldApplyWorkspaceReactionResponse(
        workspaceReactionEventSeqRef.current.get(messageId) ?? 0,
        eventSeqAtRequest
      )) {
        updateWorkspaceMessageReactions(response.messageId, response.reactions);
      }
    } catch (error) {
      if (shouldApplyWorkspaceReactionResponse(
        workspaceReactionEventSeqRef.current.get(messageId) ?? 0,
        eventSeqAtRequest
      )) {
        updateWorkspaceMessageReactions(messageId, originalReactions);
      }
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "表情回复更新失败"));
    } finally {
      workspaceReactionLocksRef.current.delete(lockKey);
      setWorkspaceReactionPendingKeys((keys) => keys.filter((key) => key !== lockKey));
    }
  }

  async function favoriteWorkspaceMessageEmote(message: Message) {
    const source = getWorkspaceEmoteFavoriteSource(message);
    if (!source) return;
    try {
      await workspaceJson<{ emote: WorkspaceCustomEmote }>("/api/workspace/me/emotes/favorite", {
        method: "POST",
        body: JSON.stringify({ messageId: message.id, ...source })
      });
      notifyWorkspaceEmoteLibraryChanged();
      showWorkspaceNotice("success", "已加入收藏表情");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "收藏表情失败"));
    }
  }
  function upsertWorkspaceFile(file: WorkspaceFile | WorkspaceAttachment) {
    if (!("uploaderId" in file) || !file.uploaderId || !("createdAt" in file) || !file.createdAt) {
      return;
    }
    const workspaceFile = file as WorkspaceFile;
    if (workspaceFile.status === "available") {
      setWorkspaceSelectedFileId((selectedId) => selectedId.startsWith("local-file-") ? workspaceFile.id : selectedId);
    }
    const mergeFile = (files: WorkspaceFile[]) =>
      sortWorkspaceFiles(
        upsertById(
          files.filter(
            (candidate) =>
              !candidate.localUpload ||
              candidate.fileName !== workspaceFile.fileName ||
              candidate.byteSize !== workspaceFile.byteSize ||
              candidate.conversationId !== workspaceFile.conversationId
          ),
          workspaceFile
        )
      );
    setWorkspaceFiles(mergeFile);
    setWorkspaceLibraryFiles(mergeFile);
  }

  function openWorkspaceAttachmentFile(attachment: WorkspaceAttachment) {
    const existingFile = workspaceFiles.find((file) => file.id === attachment.id);
    if (!existingFile) {
      const projectedFile: WorkspaceFile = {
        ...attachment,
        uploaderId: "",
        uploaderName: "成员",
        createdAt: new Date().toISOString(),
        conversationId: workspaceSelectedConversationId || null,
        visibility: attachment.visibility || "conversation"
      };
      const upsertProjected = (files: WorkspaceFile[]) => sortWorkspaceFiles(upsertById(files, projectedFile));
      setWorkspaceFiles(upsertProjected);
      setWorkspaceLibraryFiles(upsertProjected);
      void refreshWorkspaceFiles();
    }
    setWorkspaceSelectedFileId(attachment.id);
    setWorkspaceView("files");
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: attachment.id }));
    setWorkspaceContextMode("file");
    setWorkspaceContextCollapsed(false);
    setWorkspaceMobilePane("details");
  }

  function removeWorkspaceFileFromClient(attachmentId: string) {
    for (const conversation of workspaceConversationsRef.current) {
      if (conversation.latestMessages.some((message) => message.attachments.some((attachment) => attachment.id === attachmentId))) {
        advanceWorkspaceConversationMessageRevision(conversation.id);
      }
    }
    setWorkspaceFiles((files) => files.filter((file) => file.id !== attachmentId));
    setWorkspaceLibraryFiles((files) => files.filter((file) => file.id !== attachmentId));
    setWorkspaceConversations((conversations) =>
      conversations.map((conversation) => ({
        ...conversation,
        latestMessages: conversation.latestMessages.map((message) => ({
          ...message,
          attachments: message.attachments.map((attachment) =>
            attachment.id === attachmentId ? { ...attachment, status: "removed" } : attachment
          )
        }))
      }))
    );
  }

  async function markWorkspaceConversationRead(conversationId: string) {
    if (!workspaceCanReadConversationsRef.current) {
      return;
    }
    if (workspaceMarkReadInFlightRef.current.has(conversationId)) {
      return;
    }
    workspaceMarkReadInFlightRef.current.add(conversationId);
    const request = beginWorkspaceConversationMessageRequest(conversationId, "read");
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/conversations/${encodeURIComponent(conversationId)}/read`,
        { method: "POST" }
      );
      if (!isCurrentWorkspaceConversationMessageRequest(conversationId, request)) return;
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(
        conversations,
        data.conversation,
        workspaceConversationMessageMergeContext(conversationId, request)
      ));
    } catch {
      // Read state is progressive UI; message access itself is handled by normal fetches.
    } finally {
      if (
        request.sessionEpoch === workspaceSessionEpochRef.current &&
        request.membershipEpoch === currentWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversationId)
      ) {
        workspaceMarkReadInFlightRef.current.delete(conversationId);
      }
    }
  }

  function handleWorkspaceMessageListScroll(list: HTMLDivElement) {
    const conversationId = workspaceSelectedConversationId;
    if (!conversationId) {
      return;
    }
    if (workspaceHistoryTargetId) {
      workspaceStickToBottomRef.current = false;
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
    setWorkspaceAwayFromLatestByConversation((current) => {
      if (!nearBottom && current[conversationId] !== true) {
        return { ...current, [conversationId]: true };
      }
      if (nearBottom && current[conversationId]) {
        const { [conversationId]: _removed, ...rest } = current;
        return rest;
      }
      return current;
    });
    const hasScrollIntent = performance.now() <= workspaceScrollIntentUntilRef.current;
    if (nearBottom) {
      if (workspaceStickToBottomRef.current || hasScrollIntent) {
        workspaceStickToBottomRef.current = true;
      }
    } else if (hasScrollIntent) {
      workspaceStickToBottomRef.current = false;
    }
    workspaceScrollPositionsRef.current.set(conversationId, list.scrollTop);
    workspaceStickToBottomByConversationRef.current.set(
      conversationId,
      workspaceStickToBottomRef.current
    );
    if (!nearBottom) {
      return;
    }
    setWorkspaceNewMessageCountByConversation((counts) => {
      if (!counts[conversationId]) {
        return counts;
      }
      return { ...counts, [conversationId]: 0 };
    });
    const mobileConversationHidden = window.matchMedia("(max-width: 760px)").matches && workspaceMobilePane !== "main";
    if (
      lane === "workspace-dev" &&
      workspaceStatus === "ready" &&
      workspaceRealtimeState === "connected" &&
      workspaceView === "chat" &&
      documentVisible &&
      !mobileConversationHidden &&
      ((workspaceSelectedConversation?.unreadCount ?? 0) > 0 || workspaceNewMessageCount > 0)
    ) {
      void markWorkspaceConversationRead(conversationId);
    }
  }

  function registerWorkspaceMessageListScrollIntent() {
    workspaceScrollIntentUntilRef.current = performance.now() + 3000;
  }

  useEffect(() => {
    // Replay may reach the bottom before the socket becomes connected. Revisit
    // read state after reconnect (or a refreshed unread count), without moving
    // the reader or requiring another scroll gesture.
    const list = workspaceMessageListRef.current;
    const mobileConversationHidden = window.matchMedia("(max-width: 760px)").matches && workspaceMobilePane !== "main";
    if (list && list.getClientRects().length > 0 && lane === "workspace-dev" && workspaceStatus === "ready" &&
      workspaceRealtimeState === "connected" && workspaceView === "chat" && documentVisible && !mobileConversationHidden) {
      handleWorkspaceMessageListScroll(list);
    }
  }, [lane, workspaceStatus, workspaceRealtimeState, workspaceSelectedConversation?.unreadCount, workspaceNewMessageCount, workspaceSelectedConversationId, workspaceView, workspaceMobilePane, documentVisible]);

  function jumpWorkspaceToLatest() {
    const list = workspaceMessageListRef.current;
    const conversationId = workspaceSelectedConversationId;
    if (!list || !conversationId) {
      return;
    }
    workspaceStickToBottomRef.current = true;
    workspaceStickToBottomByConversationRef.current.set(conversationId, true);
    setWorkspaceHistoryExhaustedByConversation((current) => {
      if (!(conversationId in current)) return current;
      const { [conversationId]: _removed, ...rest } = current;
      return rest;
    });
    list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    handleWorkspaceMessageListScroll(list);
  }

  async function updateWorkspaceConversationNotification(level: WorkspaceNotificationLevel) {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.notificationLevel === level) {
      return;
    }
    const conversationId = workspaceSelectedConversation.id;
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const membershipEpoch = currentWorkspaceConversationEpoch(
      workspaceConversationMembershipEpochRef.current,
      conversationId
    );
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/conversations/${encodeURIComponent(conversationId)}/notification`,
        {
          method: "PATCH",
          body: JSON.stringify({ level })
        }
      );
      if (
        sessionEpoch !== workspaceSessionEpochRef.current ||
        !isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current) ||
        membershipEpoch !== currentWorkspaceConversationEpoch(
          workspaceConversationMembershipEpochRef.current,
          conversationId
        ) ||
        !workspaceCanReadConversationsRef.current ||
        !workspaceConversationsRef.current.some((conversation) => conversation.id === conversationId)
      ) {
        return;
      }
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", "会话提醒已更新");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "提醒设置保存失败"));
    }
  }

  async function loadOlderWorkspaceMessages(conversationId: string) {
    const conversation = workspaceConversationsRef.current.find((item) => item.id === conversationId);
    const before = conversation?.latestMessages[0]?.id;
    if (!conversation || !before || workspaceHistoryLoadingByConversation[conversationId]) {
      return;
    }
    const request = beginWorkspaceConversationMessageRequest(conversationId, "history");
    setWorkspaceHistoryLoadingByConversation((current) => ({ ...current, [conversationId]: true }));
    clearWorkspaceNotice();
    try {
      const params = new URLSearchParams({ before, limit: "40" });
      const data = await workspaceJson<{ messages: WorkspaceMessage[] }>(
        `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
      );
      if (!isCurrentWorkspaceConversationMessageRequest(conversationId, request)) return;
      if (data.messages.length === 0) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
        return;
      }
      const knownMessageIds = new Set(conversation.latestMessages.map((message) => message.id));
      const olderMessages = data.messages.filter((message) => !knownMessageIds.has(message.id));
      if (olderMessages.length === 0) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
        return;
      }
      advanceWorkspaceConversationMessageRevision(conversationId);
      const list = workspaceMessageListRef.current;
      if (list && workspaceSelectedConversationIdRef.current === conversationId) {
        const bounds = list.getBoundingClientRect();
        const element = [...list.querySelectorAll<HTMLElement>(".workspace-message-text, .message-body, .structured-message")]
          .find((body) => {
            const rect = body.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          });
        workspacePrependScrollRef.current = {
          conversationId, request, prependedMessageId: olderMessages[0].id,
          list, top: list.scrollTop, height: list.scrollHeight,
          anchor: element ? { element, offset: element.getBoundingClientRect().top - bounds.top } : undefined
        };
      }
      setWorkspaceConversations((conversations) =>
        conversations.map((item) => {
          if (item.id !== conversationId) {
            return item;
          }
          const existingIds = new Set(item.latestMessages.map((message) => message.id));
          return {
            ...item,
            latestMessages: [
              ...olderMessages.filter((message) => !existingIds.has(message.id)),
              ...item.latestMessages
            ]
          };
        })
      );
      if (data.messages.length < 40) {
        setWorkspaceHistoryExhaustedByConversation((current) => ({ ...current, [conversationId]: true }));
      }
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "历史消息加载失败"));
    } finally {
      if (
        request.sessionEpoch === workspaceSessionEpochRef.current &&
        request.membershipEpoch === currentWorkspaceConversationEpoch(workspaceConversationMembershipEpochRef.current, conversationId)
      ) {
        setWorkspaceHistoryLoadingByConversation((current) => ({ ...current, [conversationId]: false }));
      }
    }
  }

  function clearWorkspaceNotice() {
    setWorkspaceNotice(null);
  }

  function showWorkspaceNotice(tone: WorkspaceNotice["tone"], text: string, options: WorkspaceNoticeOptions = {}) {
    workspaceNoticeSeqRef.current += 1;
    setWorkspaceNotice({
      id: workspaceNoticeSeqRef.current,
      tone,
      text,
      persistent: options.persistent === true,
      durationMs: options.durationMs ?? WORKSPACE_NOTICE_AUTO_DISMISS_MS
    });
  }

  function openWorkspaceCreate(mode: WorkspaceCreateMode) {
    navigation.request(() => {
    setWorkspaceCreateMode(mode);
    writeAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "new",
      createMode: mode
    }));
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);
    clearWorkspaceNotice();
    setWorkspacePickerMemberQuery("");
    setWorkspaceMobilePane("main");
    if (mode === "group") {
      setWorkspaceGroupMemberIds([]);
      setWorkspaceNewGroupAvatarEmoji("");
    }

    });
  }

  function closeWorkspaceCreate() {
    setWorkspaceCreateMode("");
    setWorkspaceMobilePane("list");
    writeAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      conversationId: workspaceSelectedConversationId
    }));
    window.requestAnimationFrame(() => workspaceCreateTriggerRef.current?.focus());
  }

  function handleWorkspaceCreatePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspaceCreate();
    }
  }

  function toggleWorkspaceGroupMember(userId: string) {
    setWorkspaceGroupMemberIds((selected) =>
      selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId]
    );
  }

  function clearWorkspaceMemberVisibilityState() {
    workspaceVisibilityRequestRef.current += 1;
    workspaceVisibilitySaveRef.current = null;
    workspaceVisibilityViewerRef.current = "";
    workspaceVisibilityActorRef.current = "";
    workspaceCanManageVisibilityRef.current = false;
    setWorkspaceVisibilityViewerId("");
    setWorkspaceMemberVisibility(null);
    setWorkspaceVisibilityLoading(false);
    setWorkspaceVisibilitySaving(false);
  }

  function selectWorkspaceVisibilityViewer(viewerUserId: string) {
    if (workspaceVisibilitySaveRef.current || viewerUserId === workspaceVisibilityViewerRef.current) return;
    workspaceVisibilityViewerRef.current = viewerUserId;
    workspaceVisibilityRequestRef.current += 1;
    setWorkspaceVisibilityViewerId(viewerUserId);
    setWorkspaceMemberVisibility(null);
  }

  function beginWorkspaceVisibilityRequest(viewerUserId: string) {
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const actorId = workspaceVisibilityActorRef.current;
    const requestGeneration = ++workspaceVisibilityRequestRef.current;
    return () => viewerUserId === workspaceVisibilityViewerRef.current &&
      actorId === workspaceVisibilityActorRef.current && sessionEpoch === workspaceSessionEpochRef.current &&
      accessEpoch === workspaceAccessEpochRef.current && requestGeneration === workspaceVisibilityRequestRef.current &&
      workspaceCanManageVisibilityRef.current;
  }

  async function loadWorkspaceMemberVisibility(viewerUserId: string) {
    if (!workspaceCanManageVisibilityRef.current || !viewerUserId || viewerUserId !== workspaceVisibilityViewerRef.current || workspaceVisibilitySaveRef.current) {
      return;
    }
    const isCurrent = beginWorkspaceVisibilityRequest(viewerUserId);
    setWorkspaceVisibilityLoading(true);
    try {
      const data = await workspaceJson<{ visibility: WorkspaceMemberVisibility }>(
        "/api/workspace/member-visibility/" + encodeURIComponent(viewerUserId)
      );
      if (isCurrent() && data.visibility.viewerUserId === viewerUserId) setWorkspaceMemberVisibility(data.visibility);
    } catch (error) {
      if (!isCurrent()) return;
      setWorkspaceMemberVisibility(null);
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员可见范围加载失败"));
    } finally {
      if (isCurrent()) setWorkspaceVisibilityLoading(false);
    }
  }

  function toggleWorkspaceVisibilityGrant(userId: string) {
    setWorkspaceMemberVisibility((current) => {
      if (!current || current.automaticUserIds.includes(userId)) {
        return current;
      }
      const grantedUserIds = current.grantedUserIds.includes(userId)
        ? current.grantedUserIds.filter((id) => id !== userId)
        : [...current.grantedUserIds, userId];
      return {
        ...current,
        grantedUserIds,
        visibleUserIds: Array.from(new Set([current.viewerUserId, ...current.automaticUserIds, ...grantedUserIds]))
      };
    });
  }

  async function saveWorkspaceMemberVisibility() {
    if (
      !workspaceCanManageVisibilityRef.current || workspaceVisibilitySaveRef.current ||
      !workspaceVisibilityViewerId ||
      !workspaceMemberVisibility || workspaceMemberVisibility.viewerUserId !== workspaceVisibilityViewerId ||
      workspaceVisibilityViewerRef.current !== workspaceVisibilityViewerId
    ) {
      return;
    }
    const viewerUserId = workspaceVisibilityViewerId;
    const isCurrent = beginWorkspaceVisibilityRequest(viewerUserId);
    const operation = {};
    workspaceVisibilitySaveRef.current = operation;
    setWorkspaceVisibilitySaving(true);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ visibility: WorkspaceMemberVisibility }>(
        "/api/workspace/member-visibility/" + encodeURIComponent(viewerUserId),
        {
          method: "PUT",
          body: JSON.stringify({ visibleUserIds: workspaceMemberVisibility.grantedUserIds })
        }
      );
      if (!isCurrent() || data.visibility.viewerUserId !== viewerUserId) return;
      setWorkspaceMemberVisibility(data.visibility);
      showWorkspaceNotice("success", "成员可见范围已更新");
    } catch (error) {
      if (!isCurrent()) return;
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员可见范围更新失败"));
    } finally {
      if (workspaceVisibilitySaveRef.current === operation) {
        workspaceVisibilitySaveRef.current = null;
        setWorkspaceVisibilitySaving(false);
      }
    }
  }

  async function updateWorkspaceMemberRole(member: WorkspaceUser, role: WorkspaceUser["role"]) {
    if (!workspaceBootstrap?.permissions.canCreatePrivilegedInvite || member.role === role) {
      return;
    }
    const currentRoleLabel = workspaceMemberRoleLabel(member);
    const nextRoleLabel = workspaceRoleLabel(role);
    const confirmation =
      role === "owner"
        ? `将 ${member.displayName} 设为空间主人？此成员将获得完整空间权限。`
        : member.role === "owner"
          ? `将 ${member.displayName} 从空间主人调整为${nextRoleLabel}？`
          : `将 ${member.displayName} 从${currentRoleLabel}调整为${nextRoleLabel}？`;
    if (!await confirm(confirmation)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ member: WorkspaceUser }>(
        `/api/workspace/members/${encodeURIComponent(member.id)}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({ role })
        }
      );
      upsertWorkspaceMember(data.member);
      showWorkspaceNotice("success", "成员权限已更新");
      await refreshWorkspaceBootstrap();
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "成员权限更新失败"));
    }
  }

  async function removeWorkspaceMember(member: WorkspaceUser) {
    if (!workspaceBootstrap?.permissions.canCreatePrivilegedInvite || member.id === workspaceBootstrap.auth.currentUser.id) {
      return;
    }
    if (!await confirm(`将 ${member.displayName} 移出共享空间？该成员将无法继续访问会话和文件。`)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; userId: string; removedAt: string }>(
        `/api/workspace/members/${encodeURIComponent(member.id)}`,
        { method: "DELETE" }
      );
      removeWorkspaceMemberFromClient(member.id);
      showWorkspaceNotice("success", "成员已移出共享空间");
      await Promise.all([refreshWorkspaceBootstrap(), refreshWorkspaceMembers(), refreshWorkspaceConversations(), refreshWorkspaceFiles()]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移出成员失败"));
    }
  }

  async function createWorkspaceDirect(targetUserId: string) {
    if (!workspaceBootstrap?.permissions.canCreateDirect) {
      return;
    }
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const isCurrent = () => sessionEpoch === workspaceSessionEpochRef.current &&
      isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>("/api/workspace/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "direct",
          targetUserId
        })
      });
      if (!isCurrent()) return;
      // Older full-list snapshots must not remove the just-created conversation.
      workspaceConversationListRequestTokenRef.current += 1;
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      setWorkspaceCreateMode("");
      selectWorkspaceConversation(data.conversation.id);
      void refreshWorkspaceConversations().catch((error) => {
        if (isCurrent()) showWorkspaceNotice("warning", userFacingErrorMessage(error, "私聊已打开，会话列表暂时无法刷新"));
      });
    } catch (error) {
      if (!isCurrent()) return;
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "发起私聊失败"));
    }
  }

  async function createWorkspaceGroup(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!workspaceBootstrap?.permissions.canCreateGroup) {
      return;
    }
    const title = workspaceNewGroupTitle.trim();
    if (!title) {
      showWorkspaceNotice("warning", "请输入群聊名称");
      return;
    }
    if (workspaceGroupMemberIds.length === 0) {
      showWorkspaceNotice("warning", "请选择至少一位群聊成员");
      return;
    }
    const avatarEmoji = normalizeWorkspaceGroupAvatarEmoji(workspaceNewGroupAvatarEmoji);
    if (avatarEmoji === null) {
      showWorkspaceNotice("warning", "群头像必须是单个 emoji");
      return;
    }
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    const isCurrent = () => sessionEpoch === workspaceSessionEpochRef.current &&
      isWorkspaceConversationAccessCurrent(accessEpoch, workspaceAccessEpochRef.current);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>("/api/workspace/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "group",
          title,
          avatarEmoji: avatarEmoji || null,
          memberIds: workspaceGroupMemberIds
        })
      });
      if (!isCurrent()) return;
      workspaceConversationListRequestTokenRef.current += 1;
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      setWorkspaceNewGroupTitle("");
      setWorkspaceNewGroupAvatarEmoji("");
      setWorkspaceGroupMemberIds([]);
      setWorkspaceCreateMode("");
      selectWorkspaceConversation(data.conversation.id);
      void refreshWorkspaceConversations().catch((error) => {
        if (isCurrent()) showWorkspaceNotice("warning", userFacingErrorMessage(error, "群聊已创建，会话列表暂时无法刷新"));
      });
    } catch (error) {
      if (!isCurrent()) return;
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "创建会话失败"));
    }
  }

  async function inviteWorkspaceGroupMembers(userIds: readonly string[], context: MemberPickerSubmission) {
    const conversationId = workspaceSelectedConversation?.id;
    const sessionEpoch = workspaceSessionEpochRef.current;
    const accessEpoch = workspaceAccessEpochRef.current;
    if (!conversationId || !workspaceCanManageSelectedGroup || !context.isCurrent()) return;
    let invitedCount = 0;
    for (const userId of userIds) {
      if (!context.isCurrent() || sessionEpoch !== workspaceSessionEpochRef.current || accessEpoch !== workspaceAccessEpochRef.current) return;
      if (!context.isAvailable(userId)) continue;
      try {
        const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
          `/api/workspace/groups/${encodeURIComponent(conversationId)}/members`,
          { method: "POST", body: JSON.stringify({ userId }), signal: context.signal }
        );
        if (!context.isCurrent() || sessionEpoch !== workspaceSessionEpochRef.current || accessEpoch !== workspaceAccessEpochRef.current) return;
        setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
        invitedCount += 1;
      } catch (error) {
        if (!context.isCurrent() || sessionEpoch !== workspaceSessionEpochRef.current || accessEpoch !== workspaceAccessEpochRef.current) return;
        const reason = userFacingErrorMessage(error, "邀请失败，请重试");
        throw new Error(invitedCount ? `${invitedCount} 位成员已加入。${reason}，其余选择已保留。` : reason);
      }
    }
    if (context.isCurrent() && invitedCount) showWorkspaceNotice("success", `${invitedCount} 位成员已加入群聊`);
  }

  async function removeWorkspaceGroupMember(userId: string) {
    if (!workspaceSelectedConversation || !workspaceBootstrap || !workspaceCanManageSelectedGroup) {
      return;
    }
    const member = workspaceSelectedConversation.members.find((item) => item.id === userId);
    const title = workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id);
    if (!await confirm(`将 ${member?.displayName ?? "该成员"} 移出「${title}」？对方将无法继续查看此群聊和群文件。`)) {
      return;
    }
    setWorkspaceGroupMemberBusyId(userId);
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}/members/${encodeURIComponent(userId)}`,
        {
          method: "DELETE"
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", `${member?.displayName ?? "成员"} 已移出群聊`);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移出成员失败"));
    } finally {
      setWorkspaceGroupMemberBusyId("");
    }
  }

  async function renameWorkspaceGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceSelectedConversation || !workspaceCanManageSelectedGroup) {
      return;
    }
    const title = workspaceGroupRenameTitle.trim();
    if (!title) {
      showWorkspaceNotice("warning", "请输入群聊名称");
      return;
    }
    const avatarEmoji = normalizeWorkspaceGroupAvatarEmoji(workspaceGroupAvatarEmoji);
    if (avatarEmoji === null) {
      showWorkspaceNotice("warning", "群头像必须是单个 emoji");
      return;
    }
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ conversation: WorkspaceConversation }>(
        `/api/workspace/groups/${encodeURIComponent(workspaceSelectedConversation.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title, avatarEmoji: avatarEmoji || null })
        }
      );
      setWorkspaceConversations((conversations) => upsertWorkspaceConversationList(conversations, data.conversation));
      showWorkspaceNotice("success", "群聊名称已更新");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "群聊名称更新失败"));
    }
  }

  async function leaveWorkspaceGroup() {
    if (!workspaceSelectedConversation || workspaceSelectedConversation.type !== "group") {
      return;
    }
    const conversationId = workspaceSelectedConversation.id;
    const title = workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap?.auth.currentUser.id);
    if (!await confirm(`离开「${title}」后，你将无法继续查看此群聊。确定离开吗？`)) {
      return;
    }
    invalidateWorkspaceConversationAccess(conversationId, false);
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; conversationId: string }>(
        `/api/workspace/groups/${encodeURIComponent(conversationId)}/leave`,
        { method: "POST" }
      );
      invalidateWorkspaceConversationAccess(conversationId);
      if (workspaceSelectedConversationIdRef.current === conversationId) {
        workspaceSelectedConversationIdRef.current = "";
      }
      const outgoingMessages = workspaceLocalMessagesRef.current.filter((message) => message.conversationId === conversationId);
      for (const message of outgoingMessages) {
        void cancelWorkspaceLocalMessage(message.id);
      }
      setWorkspaceLocalMessages((messages) => messages.filter((message) => message.conversationId !== conversationId));
      setWorkspaceConversations((conversations) =>
        conversations.filter((conversation) => conversation.id !== conversationId)
      );
      setWorkspaceSelectedConversationId("");
      setWorkspaceContextMode("conversation");
      setWorkspaceContextTab("overview");
      setWorkspaceMobilePane("list");
      showWorkspaceNotice("success", "已离开群聊");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "离开群聊失败"));
    }
  }

  async function createWorkspaceInvite() {
    clearWorkspaceNotice();
    try {
      const data = await workspaceJson<{ invite: WorkspaceInvite }>("/api/workspace/invites", {
        method: "POST",
        body: JSON.stringify({ defaultRole: "member", maxUses: 1 })
      });
      const invitePath = data.invite.inviteUrl || getWorkspaceEntryUrl(data.invite.code || "");
      setWorkspaceInviteCode(new URL(invitePath, window.location.origin).toString());
      setWorkspaceInviteCodeId(data.invite.id);
      await loadWorkspace();
      showWorkspaceNotice("success", "邀请已创建，可以复制发送给成员。");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "创建邀请失败"));
    }
  }

  async function copyWorkspaceInviteLink(value: string) {
    const didCopy = await copyText(value);
    showWorkspaceNotice(
      didCopy ? "success" : "warning",
      didCopy ? "邀请链接已复制。" : "复制失败，请手动选择邀请链接。"
    );
  }

  async function revokeWorkspaceInvite(invite: WorkspaceInvite) {
    if (!canRevokeWorkspaceInvite(invite)) {
      return;
    }
    if (!await confirm("撤销后，这个邀请链接将无法继续加入共享空间。确定撤销吗？")) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ invite: Pick<WorkspaceInvite, "id" | "revokedAt"> }>(
        `/api/workspace/invites/${encodeURIComponent(invite.id)}/revoke`,
        { method: "POST" }
      );
      if (workspaceInviteCodeId === invite.id) {
        setWorkspaceInviteCode("");
        setWorkspaceInviteCodeId("");
      }
      await refreshWorkspaceBootstrap();
      showWorkspaceNotice("success", "邀请已撤销");
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "撤销邀请失败"));
    }
  }

  function updateWorkspaceEchoInteractions(
    updater: (current: Record<string, WorkspaceEchoInteractionSlot>) => Record<string, WorkspaceEchoInteractionSlot>
  ) {
    const next = updater(workspaceEchoInteractionByConversationRef.current);
    workspaceEchoInteractionByConversationRef.current = next;
    setWorkspaceEchoInteractionByConversation(next);
  }

  function acceptWorkspaceEchoCommand(request: WorkspaceEchoCommandRequest) {
    setWorkspaceDraftByConversation((drafts) => {
      const current = drafts[request.conversationId];
      if (!current || JSON.stringify(current.blocks) !== request.draftSignature) return drafts;
      const { [request.conversationId]: _removed, ...rest } = drafts;
      return rest;
    });
    setWorkspaceConversationReplyToMessageId(request.conversationId, "");
    updateWorkspaceEchoInteractions((interactions) => {
      const current = interactions[request.conversationId];
      if (!current || current.request.clientInvocationId !== request.clientInvocationId) return interactions;
      return { ...interactions, [request.conversationId]: { ...current, accepted: true } };
    });
  }

  function setWorkspaceEchoWorkflowId(conversationId: string, workflowId: string | null) {
    updateWorkspaceEchoInteractions((interactions) => {
      const current = interactions[conversationId];
      if (!current) return interactions;
      if (workflowId) return { ...interactions, [conversationId]: { ...current, activeWorkflowId: workflowId } };
      const { activeWorkflowId: _removed, ...withoutWorkflow } = current;
      return { ...interactions, [conversationId]: withoutWorkflow };
    });
  }

  function dismissWorkspaceEchoInteraction(conversationId: string) {
    updateWorkspaceEchoInteractions((interactions) => {
      const { [conversationId]: _removed, ...rest } = interactions;
      return rest;
    });
  }

  async function sendWorkspaceMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceSelectedConversation) {
      return;
    }
    let stagedAttachments = workspaceComposerAttachmentsByConversation[workspaceSelectedConversationId] ?? [];


    const echoCommand = recognizeWorkspaceEchoCommand({
      conversationType: workspaceSelectedConversation.type,
      echoIsParticipant: workspaceSelectedConversation.members.some(
        (member) => member.id === ECHO_BOT_USER_ID && member.kind === "bot"
      ),
      source: workspaceDraftDocument.source,
      blocks: workspaceDraftDocument.blocks
    });
    if (echoCommand) {

      if (stagedAttachments.length > 0) {
        showWorkspaceNotice("warning", "回声命令不能同时发送附件。附件和命令草稿已保留，请移除附件或改为普通消息后重试。");
        return;
      }
      const draftSignature = JSON.stringify(workspaceDraftDocument.blocks);
      const previous = workspaceEchoInteractionByConversationRef.current[workspaceSelectedConversation.id];
      const reusableRequest = reusableWorkspaceEchoCommandRequest(previous, draftSignature);
      const request = reusableRequest
        ? reusableRequest
        : {
            ...echoCommand,
            conversationId: workspaceSelectedConversation.id,
            botUserId: ECHO_BOT_USER_ID,
            clientInvocationId: makeId("echo-command"),
            draftSignature
          };
      updateWorkspaceEchoInteractions((interactions) => ({
        ...interactions,
        [workspaceSelectedConversation.id]: {
          request,
          ...(previous?.activeWorkflowId ? { activeWorkflowId: previous.activeWorkflowId } : {})
        }
      }));
      clearWorkspaceNotice();
      return;
    }
    let prepared;
    try { prepared = prepareWorkspaceMessageContent(workspaceDraftDocument, stagedAttachments); }
    catch (error) { showWorkspaceNotice("warning", userFacingErrorMessage(error, "消息准备失败")); return; }
    if (!prepared) return;
    stagedAttachments = prepared.attachments;
    const conversation = workspaceSelectedConversation;
    const clientMessageId = makeId("wm");
    const localMessageId = makeId("wlm");
    const replyToMessageId = workspaceReplyToMessageId || null;
    const textBlocks = prepared.blocks;
    const messageBody = prepared.body;

    const localMessage: WorkspaceLocalMessage = {
      id: localMessageId,
      clientMessageId,
      conversationId: conversation.id,
      body: messageBody,
      blocks: textBlocks,
      pendingAttachments: stagedAttachments.length > 0 ? stagedAttachments : undefined,
      replyToMessageId,
      createdAt: new Date().toISOString(),
      state: stagedAttachments.length > 0 ? "uploading" : "sending"
    };

    setWorkspaceLocalMessages((messages) => [
      ...messages.filter((message) => message.clientMessageId !== clientMessageId),
      localMessage
    ]);
    setWorkspaceConversationDraft(conversation.id, "");
    setWorkspaceConversationReplyToMessageId(conversation.id, "");
    if (stagedAttachments.length > 0) {
      updateWorkspaceComposerAttachments(conversation.id, () => []);
    }
    clearWorkspaceNotice();
    void deliverWorkspaceLocalMessage(localMessage);
  }

  async function sendWorkspaceImageEmote(item: EmoteItem) {
    if (item.kind !== "image" || !workspaceSelectedConversation || workspaceSendingRef.current) return;
    const conversation = workspaceSelectedConversation;
    const token = getEmoteInsertText(item);
    const blocks = workspaceComposerDocumentToContentBlocks({
      source: token,
      blocks: [{ type: "emote", token, item }]
    });
    const clientMessageId = makeId("wm");
    const localMessageId = makeId("wlm");
    const replyToMessageId = workspaceReplyToMessageId || null;

    workspaceSendingRef.current = true;
    clearWorkspaceNotice();

      setWorkspaceLocalMessages((messages) => [
        ...messages,
        {
          id: localMessageId,
          clientMessageId,
          conversationId: conversation.id,
          body: token,
          blocks,
          attachments: [],
          replyToMessageId,
          createdAt: new Date().toISOString(),
          state: "sending"
        }
      ]);

    try {
      await submitWorkspaceMessage({
        conversationId: conversation.id,
        clientMessageId,
        replyToMessageId,
        body: token,
        blocks
      });
      setWorkspaceConversationReplyToMessageId(conversation.id, "");

    } catch (error) {
      const message = userFacingErrorMessage(error, "表情发送失败");

        setWorkspaceLocalMessages((messages) => messages.map((localMessage) =>
          localMessage.id === localMessageId
            ? { ...localMessage, state: "failed", failureReason: message }
            : localMessage
        ));

      showWorkspaceNotice("warning", message);
    } finally {
      workspaceSendingRef.current = false;
    }
  }

  function updateWorkspaceLocalMessageAttachment(
    messageId: string,
    attachmentId: string,
    updater: (attachment: WorkspaceComposerAttachment) => WorkspaceComposerAttachment
  ) {
    setWorkspaceLocalMessages((messages) => messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            pendingAttachments: message.pendingAttachments?.map((attachment) =>
              attachment.id === attachmentId ? updater(attachment) : attachment
            )
          }
        : message
    ));
  }

  async function uploadWorkspaceComposerAttachments(
    conversationId: string,
    stagedAttachments: WorkspaceComposerAttachment[],
    onUpdate: (
      attachmentId: string,
      updater: (attachment: WorkspaceComposerAttachment) => WorkspaceComposerAttachment
    ) => void,
    visibility: "conversation" | "private_staging" = "conversation",
    shouldCancel: () => boolean = () => false
  ) {
    const results = new Array<WorkspaceAttachment | null>(stagedAttachments.length).fill(null);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(2, stagedAttachments.length) },
      async () => {
        while (cursor < stagedAttachments.length) {
          if (shouldCancel()) return;
          const index = cursor;
          cursor += 1;
          try {
            results[index] = await uploadWorkspaceComposerAttachment(
              conversationId,
              stagedAttachments[index],
              onUpdate,
              visibility
            );
          } catch {
            results[index] = null;
          }
        }
      }
    );
    await Promise.all(workers);
    if (results.every(Boolean)) {
      void refreshWorkspaceBootstrap().catch(() => undefined);
    }
    return results.filter((attachment): attachment is WorkspaceAttachment => Boolean(attachment));
  }

  async function uploadWorkspaceComposerAttachment(
    conversationId: string,
    stagedAttachment: WorkspaceComposerAttachment,
    onUpdate: (
      attachmentId: string,
      updater: (attachment: WorkspaceComposerAttachment) => WorkspaceComposerAttachment
    ) => void,
    visibility: "conversation" | "private_staging" = "conversation"
  ): Promise<WorkspaceAttachment> {
    if (stagedAttachment.state === "uploaded" && stagedAttachment.attachment) {
      return stagedAttachment.attachment;
    }
    const controller = new AbortController();
    workspaceUploadControllersRef.current.set(stagedAttachment.id, controller);
    onUpdate(
      stagedAttachment.id,
      (attachment) => ({ ...attachment, state: "uploading", progress: 3, failureReason: undefined })
    );
    let uploadId = "";
    try {
      const reserve = await workspaceJson<{
        status: "reserved";
        id: string;
        attachment?: WorkspaceAttachment;
        upload: WorkspaceUploadContract;
      }>("/api/workspace/files/uploads/reserve", {
        method: "POST",
        body: JSON.stringify({
          fileName: stagedAttachment.file.name,
          mimeType: stagedAttachment.file.type || "application/octet-stream",
          byteSize: stagedAttachment.file.size,
          visibility,
          ...(visibility === "conversation" ? { conversationId } : {})
        })
      });
      uploadId = reserve.id;
      onUpdate(stagedAttachment.id, (attachment) => ({ ...attachment, uploadId, progress: 7 }));
      const completed = await uploadWorkspaceFileContent(
        uploadId,
        stagedAttachment.file,
        (progress) => {
          onUpdate(stagedAttachment.id, (attachment) => ({ ...attachment, progress }));
        },
        controller.signal,
        reserve.upload
      );
      const uploaded = completed.attachment;
      onUpdate(
        stagedAttachment.id,
        (attachment) => ({ ...attachment, state: "uploaded", progress: 100, attachment: uploaded, uploadId })
      );
      if (workspaceBootstrap) {
        upsertWorkspaceFile({
          ...uploaded,
          uploaderId: workspaceBootstrap.auth.currentUser.id,
          uploaderName: workspaceBootstrap.auth.currentUser.displayName,
          conversationId: visibility === "conversation" ? conversationId : undefined,
          visibility,
          createdAt: new Date().toISOString()
        });
      }
      return uploaded;
    } catch (error) {
      if (uploadId) {
        await releaseWorkspaceUploadReservation(
          uploadId,
          error instanceof DOMException && error.name === "AbortError"
            ? "upload cancelled"
            : error instanceof Error ? error.message : "upload failed"
        );
      }
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      const message = cancelled ? "上传已取消" : userFacingErrorMessage(error, "文件上传失败");
      onUpdate(
        stagedAttachment.id,
        (attachment) => ({ ...attachment, state: "failed", failureReason: message, progress: 0, uploadId: undefined })
      );
      throw error;
    } finally {
      workspaceUploadControllersRef.current.delete(stagedAttachment.id);
    }
  }

  async function removeWorkspaceUploadedAttachments(attachments: WorkspaceAttachment[]) {
    let cleanupFailed = false;
    await Promise.all(attachments.map((attachment) =>
      workspaceJson(`/api/workspace/files/${encodeURIComponent(attachment.id)}`, { method: "DELETE" })
        .then(() => removeWorkspaceFileFromClient(attachment.id))
        .catch(() => { cleanupFailed = true; })
    ));
    return !cleanupFailed;
  }

  async function deliverWorkspaceLocalMessage(localMessage: WorkspaceLocalMessage) {
    try {
      let readyMessage = localMessage;
      const pendingAttachments = localMessage.pendingAttachments ?? [];
      if (pendingAttachments.length > 0) {
        const uploadedAttachments = await uploadWorkspaceComposerAttachments(
          localMessage.conversationId,
          pendingAttachments,
          (attachmentId, updater) => updateWorkspaceLocalMessageAttachment(localMessage.id, attachmentId, updater),
          "conversation",
          () => workspaceCancelledLocalMessageIdsRef.current.has(localMessage.id)
        );
        if (workspaceCancelledLocalMessageIdsRef.current.has(localMessage.id)) {
          const cleaned = await removeWorkspaceUploadedAttachments(uploadedAttachments);
          if (!cleaned && workspaceSelectedConversationIdRef.current === localMessage.conversationId) {
            showWorkspaceNotice("warning", "消息已取消，部分已上传文件请在文件页中处理");
          }
          return;
        }
        if (uploadedAttachments.length !== pendingAttachments.length) {
          setWorkspaceLocalMessages((messages) => messages.map((message) =>
            message.id === localMessage.id
              ? { ...message, state: "failed", failureReason: "文件上传失败，消息尚未发送" }
              : message
          ));
          return;
        }
        const blocks: WorkspaceContentBlock[] = [
          ...localMessage.blocks.filter((block) => block.type !== "attachment"),
          ...uploadedAttachments.map((attachment) => ({
            type: "attachment" as const,
            attachmentId: attachment.id
          }))
        ];
        readyMessage = {
          ...localMessage,
          blocks,
          attachments: uploadedAttachments,
          pendingAttachments: undefined,
          state: "sending",
          failureReason: undefined
        };
        setWorkspaceLocalMessages((messages) => messages.map((message) =>
          message.id === localMessage.id ? readyMessage : message
        ));
        for (const attachment of pendingAttachments) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      }
      await submitWorkspaceMessage(readyMessage);
    } catch (error) {
      if (workspaceCancelledLocalMessageIdsRef.current.has(localMessage.id)) {
        return;
      }
      const message = userFacingErrorMessage(error, "消息发送失败");
      setWorkspaceLocalMessages((messages) => messages.map((item) =>
        item.id === localMessage.id ? { ...item, state: "failed", failureReason: message } : item
      ));
      if (workspaceSelectedConversationIdRef.current === localMessage.conversationId) {
        showWorkspaceNotice("warning", message);
      }
    } finally {
      workspaceCancelledLocalMessageIdsRef.current.delete(localMessage.id);
    }
  }

  async function retryWorkspaceMessage(messageId: string) {
    const localMessage = workspaceLocalMessagesRef.current.find((message) => message.id === messageId);
    if (!localMessage || localMessage.state === "uploading" || localMessage.state === "sending") {
      return;
    }
    clearWorkspaceNotice();
    const retryingMessage: WorkspaceLocalMessage = {
      ...localMessage,
      state: localMessage.pendingAttachments?.length ? "uploading" : "sending",
      failureReason: undefined
    };
    setWorkspaceLocalMessages((messages) =>
      messages.map((message) =>
        message.id === messageId ? retryingMessage : message
      )
    );
    await deliverWorkspaceLocalMessage(retryingMessage);
  }

  async function cancelWorkspaceLocalMessage(messageId: string) {
    const localMessage = workspaceLocalMessagesRef.current.find((message) => message.id === messageId);
    if (!localMessage || !localMessage.pendingAttachments?.length) {
      return;
    }
    const wasUploading = localMessage.state === "uploading";
    workspaceCancelledLocalMessageIdsRef.current.add(messageId);
    for (const attachment of localMessage.pendingAttachments) {
      workspaceUploadControllersRef.current.get(attachment.id)?.abort();
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    setWorkspaceLocalMessages((messages) => messages.filter((message) => message.id !== messageId));

    const cleanupSucceeded = wasUploading || await removeWorkspaceUploadedAttachments(
      localMessage.pendingAttachments.flatMap((attachment) => attachment.attachment ? [attachment.attachment] : [])
    );
    if (!wasUploading) {
      workspaceCancelledLocalMessageIdsRef.current.delete(messageId);
    }
    if (!cleanupSucceeded) {
      showWorkspaceNotice("warning", "消息已移除，部分已上传文件请在文件页中处理");
    }
  }

  async function submitWorkspaceMessage(input: {
    conversationId: string;
    topicId?: string;
    syncToGroup?: boolean;
    clientMessageId: string;
    replyToMessageId?: string | null;
    body: string;
    blocks: WorkspaceContentBlock[];
  }) {
    const endpoint = input.topicId
      ? `/api/workspace/topics/${encodeURIComponent(input.topicId)}/messages`
      : "/api/workspace/messages";
    const data = await workspaceJson<{ message: WorkspaceMessage }>(endpoint, {
      method: "POST",
      body: JSON.stringify({
        conversationId: input.conversationId,
        ...(input.topicId ? { topicId: input.topicId } : {}),
        clientMessageId: input.clientMessageId,
        ...(input.topicId ? { syncToGroup: input.syncToGroup ?? false } : {}),
        replyToMessageId: input.replyToMessageId || null,
        content: {
          format: "duallane.message+json;v=1",
          plainText: input.body,
          blocks: input.blocks
        }
      })
    });
    if (!input.topicId) upsertWorkspaceMessage(data.message);
    return data.message;
  }

  async function uploadWorkspaceFile(file: File, scope: "current" | "space" = "current") {
    if (!workspaceBootstrap?.permissions.canUpload) {
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.size, "upload", workspaceBootstrap.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    const targetConversation = scope === "current" ? workspaceSelectedConversation : undefined;
    const localFileId = makeId("local-file");
    const localFile: WorkspaceFile = {
      id: localFileId,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      byteSize: file.size,
      status: "pending",
      visibility: targetConversation ? "conversation" : "space",
      uploaderId: workspaceBootstrap.auth.currentUser.id,
      uploaderName: workspaceBootstrap.auth.currentUser.displayName,
      conversationId: targetConversation?.id ?? null,
      createdAt: new Date().toISOString(),
      localUpload: {
        file,
        scope,
        state: "uploading"
      }
    };
    setWorkspaceFiles((files) => sortWorkspaceFiles(upsertById(files, localFile)));
    setWorkspaceLibraryFiles((files) => sortWorkspaceFiles(upsertById(files, localFile)));
    setWorkspaceUploading(true);
    clearWorkspaceNotice();
    try {
      await submitWorkspaceFileUpload(localFileId, file, scope, targetConversation?.id);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      const message = userFacingErrorMessage(error, "文件上传失败");
      setWorkspaceFileLocalState(localFileId, "failed", message);
      showWorkspaceNotice("warning", message);
    } finally {
      setWorkspaceUploading(false);
    }
  }

  async function retryWorkspaceFileUpload(file: WorkspaceFile) {
    const localUpload = file.localUpload;
    if (!localUpload || localUpload.state === "uploading" || !workspaceBootstrap?.permissions.canUpload) {
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "upload", workspaceBootstrap.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    setWorkspaceFileLocalState(file.id, "uploading");
    clearWorkspaceNotice();
    try {
      await submitWorkspaceFileUpload(file.id, localUpload.file, localUpload.scope, file.conversationId || undefined);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      const message = userFacingErrorMessage(error, "文件上传失败");
      setWorkspaceFileLocalState(file.id, "failed", message);
      showWorkspaceNotice("warning", message);
    }
  }

  async function submitWorkspaceFileUpload(
    localFileId: string,
    file: File,
    scope: "current" | "space",
    conversationId?: string
  ) {
    let reservedUploadId = "";
    let uploadCompleted = false;
    try {
      const reserve = await workspaceJson<{
        status: "reserved";
        id: string;
        attachment?: WorkspaceAttachment;
        upload: WorkspaceUploadContract;
      } | {
        status: "rejected";
      }>("/api/workspace/files/uploads/reserve", {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size,
          visibility: conversationId ? "conversation" : "space",
          conversationId
        })
      });
      if (reserve.status === "rejected") {
        throw new Error("今日传输额度不足");
      }
      reservedUploadId = reserve.id;
      const completed = await uploadWorkspaceFileContent(
        reserve.id,
        file,
        () => {},
        new AbortController().signal,
        reserve.upload
      );
      uploadCompleted = true;
      const uploadedFile: WorkspaceFile = {
        ...completed.attachment,
        uploaderId: workspaceBootstrap?.auth.currentUser.id ?? "",
        uploaderName: workspaceBootstrap?.auth.currentUser.displayName ?? "我",
        createdAt: new Date().toISOString()
      };
      replaceWorkspaceLocalFile(localFileId, uploadedFile);
      if (scope === "current" && conversationId) {
        const clientMessageId = makeId("wf");
        const localMessageId = makeId("wlm");
        const body = `[文件] ${file.name}`;
        const blocks: WorkspaceContentBlock[] = [
          { type: "text", text: "分享了文件 " },
          { type: "attachment", attachmentId: completed.attachment.id }
        ];
        setWorkspaceLocalMessages((messages) => [
          ...messages.filter((message) => message.clientMessageId !== clientMessageId),
          {
            id: localMessageId,
            clientMessageId,
            conversationId,
            body,
            blocks,
            attachments: [completed.attachment],
            createdAt: new Date().toISOString(),
            state: "sending"
          }
        ]);
        try {
          await submitWorkspaceMessage({
            conversationId,
            clientMessageId,
            body,
            blocks
          });
        } catch (error) {
          const message = userFacingErrorMessage(error, "文件已上传，消息发送失败");
          setWorkspaceLocalMessages((messages) =>
            messages.map((item) =>
              item.clientMessageId === clientMessageId
                ? { ...item, state: "failed", failureReason: message }
                : item
            )
          );
          showWorkspaceNotice("warning", message);
          return;
        }
        try {
          await refreshWorkspaceConversations();
        } catch {
          // Realtime replay or the next bootstrap refresh will reconcile the conversation list.
        }
      }
    } catch (error) {
      if (reservedUploadId && !uploadCompleted) {
        await releaseWorkspaceUploadReservation(reservedUploadId, error instanceof Error ? error.message : "upload failed");
      }
      throw error;
    }
  }

  async function releaseWorkspaceUploadReservation(uploadId: string, reason: string) {
    try {
      await workspaceJson<{ transfer: { status: string } }>(
        `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/fail`,
        {
          method: "POST",
          body: JSON.stringify({ reason })
        }
      );
      await refreshWorkspaceBootstrap();
    } catch {
      // The server also releases quota when the content endpoint observed the failure.
    }
  }

  function setWorkspaceFileLocalState(fileId: string, state: "uploading" | "failed", failureReason?: string) {
    const update = (file: WorkspaceFile): WorkspaceFile =>
      file.id === fileId && file.localUpload
        ? {
            ...file,
            status: state === "failed" ? "failed" : "pending",
            localUpload: {
              ...file.localUpload,
              state,
              failureReason
            }
          }
        : file;
    setWorkspaceFiles((files) => files.map(update));
    setWorkspaceLibraryFiles((files) => files.map(update));
  }

  function replaceWorkspaceLocalFile(localFileId: string, uploadedFile: WorkspaceFile) {
    const replace = (files: WorkspaceFile[]) =>
      sortWorkspaceFiles([uploadedFile, ...files.filter((file) => file.id !== localFileId && file.id !== uploadedFile.id)]);
    setWorkspaceFiles(replace);
    setWorkspaceLibraryFiles(replace);
    setWorkspaceSelectedFileId((selectedId) => selectedId === localFileId ? uploadedFile.id : selectedId);
  }

  function removeWorkspaceLocalFile(file: WorkspaceFile) {
    if (!file.localUpload) {
      return;
    }
    setWorkspaceFiles((files) => files.filter((item) => item.id !== file.id));
    setWorkspaceLibraryFiles((files) => files.filter((item) => item.id !== file.id));
    setWorkspaceSelectedFileId((selectedId) => selectedId === file.id ? "" : selectedId);
    setWorkspaceContextMode("conversation");
    showWorkspaceNotice("success", "已移除本地上传记录");
  }

  function openWorkspaceFileDetails(file: WorkspaceFile) {
    setWorkspaceSelectedFileId(file.id);
    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: file.id }));
    setWorkspaceContextMode("file");
    setWorkspaceContextCollapsed(false);
    setWorkspaceMobilePane("details");
  }

  function workspaceFileDownloadDisabledReason(file: WorkspaceFile) {
    if (!workspaceBootstrap?.permissions.canDownload || file.capabilities?.canDownload === false) return "你当前不能下载此文件";
    if (file.localUpload?.state === "failed") return "上传失败，请先重试上传";
    if (file.localUpload || file.status === "pending") return "文件正在上传，完成后可下载";
    if (file.status !== "available") return "文件当前不可下载";
    return getWorkspaceTransferQuotaWarning(file.byteSize, "download", workspaceBootstrap.policy) || "";
  }

  function workspaceFileMenuActions(file: WorkspaceFile): ObjectAction[] {
    const downloadReason = workspaceFileDownloadDisabledReason(file);
    const actions: ObjectAction[] = [
      { id: "details", label: "查看文件详情", icon: <PanelRightOpen size={17} />, onSelect: () => openWorkspaceFileDetails(file) },
      { id: "download", label: "下载文件", icon: <Download size={17} />, disabled: Boolean(downloadReason), disabledReason: downloadReason, onSelect: () => void reserveWorkspaceDownload(file) }
    ];
    if (file.localUpload?.state === "failed") {
      const retryReason = !workspaceBootstrap?.permissions.canUpload
        ? "你当前不能上传文件"
        : getWorkspaceTransferQuotaWarning(file.byteSize, "upload", workspaceBootstrap.policy) || "";
      actions.push(
        { id: "retry", label: "重试上传", icon: <RefreshCw size={17} />, disabled: Boolean(retryReason), disabledReason: retryReason, onSelect: () => void retryWorkspaceFileUpload(file) },
        { id: "remove-local", label: "移除本地上传记录", icon: <Trash2 size={17} />, danger: true, onSelect: () => removeWorkspaceLocalFile(file) }
      );
    } else if (!file.localUpload && canRemoveWorkspaceFile(file, workspaceBootstrap?.auth.currentUser)) {
      actions.push({ id: "remove", label: "移除文件", icon: <Trash2 size={17} />, danger: true, onSelect: () => void removeWorkspaceFile(file) });
    }
    return actions;
  }

  async function reserveWorkspaceDownload(file: WorkspaceFile) {
    if (!workspaceBootstrap?.permissions.canDownload) {
      showWorkspaceNotice("warning", "你当前不能下载文件。");
      return;
    }
    const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "download", workspaceBootstrap?.policy);
    if (quotaWarning) {
      showWorkspaceNotice("warning", quotaWarning);
      return;
    }
    clearWorkspaceNotice();
    try {
      const reserve = await workspaceJson<
        { status: "completed"; id: string; downloadUrl?: string; expiresAt?: string } | { status: "rejected" }
      >(
        `/api/workspace/files/${encodeURIComponent(file.id)}/downloads/reserve`,
        { method: "POST", body: JSON.stringify({}) }
      );
      if (reserve.status === "rejected") {
        showWorkspaceNotice("warning", "今日传输额度不足，无法下载此文件。");
        await refreshWorkspaceBootstrap();
        return;
      }
      const params = new URLSearchParams({ downloadId: reserve.id });
      window.location.assign(`/api/workspace/files/${encodeURIComponent(file.id)}/download?${params.toString()}`);
      showWorkspaceNotice("success", `已开始下载 ${file.fileName}`);
      await refreshWorkspaceBootstrap();
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "文件下载失败"));
    }
  }

  async function removeWorkspaceFile(file: WorkspaceFile) {
    if (!canRemoveWorkspaceFile(file, workspaceBootstrap?.auth.currentUser)) {
      return;
    }
    if (!await confirm(`移除「${file.fileName}」？移除后成员将无法继续下载此文件。`)) {
      return;
    }
    clearWorkspaceNotice();
    try {
      await workspaceJson<{ ok: boolean; attachmentId: string }>(
        `/api/workspace/files/${encodeURIComponent(file.id)}`,
        { method: "DELETE" }
      );
      setWorkspaceFiles((files) => files.filter((item) => item.id !== file.id));
      setWorkspaceLibraryFiles((files) => files.filter((item) => item.id !== file.id));
      setWorkspaceSelectedFileId("");
      setWorkspaceContextMode("conversation");
      replaceWorkspaceRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files" }));
      showWorkspaceNotice("success", "文件已移除");
      await Promise.all([refreshWorkspaceFiles(), refreshWorkspaceConversations()]);
    } catch (error) {
      showWorkspaceNotice("warning", userFacingErrorMessage(error, "移除文件失败"));
    }
  }

  async function sendP2pMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = p2pDraft.trim();
    if (!body) {
      return;
    }

    const message = {
      id: makeId("p2p"),
      author: displayName.trim() || "你",
      body,
      lane: "p2p" as const,
      at: nowLabel(),
      self: true,
      localState: "sending" as const
    };
    setP2pMessages((messages) => [...messages, message]);
    setP2pDraft("");
    await transmitP2pChat(message);
  }

  async function retryP2pMessage(messageId: string) {
    const message = p2pMessages.find((item) => item.id === messageId && item.self && !item.fileTransfer);
    if (!message) {
      return;
    }
    updateP2pMessageDelivery(message.id, "sending");
    await transmitP2pChat({ ...message, localState: "sending", failureReason: undefined });
  }

  async function transmitP2pChat(message: Message) {
    clearP2pMessageAckTimer(message.id);
    const attempt = (pendingP2pMessageAttemptsRef.current.get(message.id) ?? 0) + 1;
    pendingP2pMessageAttemptsRef.current.set(message.id, attempt);
    if (dataChannelRef.current?.readyState !== "open" && p2pPeersRef.current.length < 2) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "对方尚未在线，消息未送达");
      return;
    }
    if (new TextEncoder().encode(message.body).byteLength > P2P_MAX_CHAT_BYTES) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", `消息超过 ${formatBytes(P2P_MAX_CHAT_BYTES)} 的直连上限`);
      return;
    }
    const sent = await sendP2pMessageEnvelope({
      kind: "chat",
      id: message.id,
      author: message.author,
      body: message.body,
      at: message.at
    });
    if (pendingP2pMessageAttemptsRef.current.get(message.id) !== attempt) {
      return;
    }
    if (!sent) {
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "当前没有可用连接，消息未送达");
      return;
    }
    const timer = window.setTimeout(() => {
      if (pendingP2pMessageAttemptsRef.current.get(message.id) !== attempt) {
        return;
      }
      pendingP2pMessageTimersRef.current.delete(message.id);
      pendingP2pMessageAttemptsRef.current.delete(message.id);
      updateP2pMessageDelivery(message.id, "failed", "未收到对方确认，请检查连接后重试");
    }, P2P_MESSAGE_ACK_TIMEOUT_MS);
    pendingP2pMessageTimersRef.current.set(message.id, timer);
  }

  async function sendP2pMessageEnvelope(envelope: Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>) {
    const dataChannel = dataChannelRef.current;
    const socket = wsRef.current;
    const canUseEncryptedSocket = socket?.readyState === WebSocket.OPEN && Boolean(secureKeysRef.current);
    if (dataChannel?.readyState === "open" && (dataChannel.bufferedAmount < 512 * 1024 || !canUseEncryptedSocket)) {
      try {
        dataChannel.send(JSON.stringify(envelope));
        return true;
      } catch {
        // The encrypted WebSocket path below can still carry text acknowledgements.
      }
    }
    const keys = secureKeysRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !keys) {
      return false;
    }
    try {
      const secureEnvelope = await encryptSecurePayload(keys, "ws-chat", envelope);
      if (secureEnvelope.ciphertext.length > 16_384 || socket.readyState !== WebSocket.OPEN) {
        throw new Error("secure envelope unavailable");
      }
      socket.send(JSON.stringify(secureEnvelope));
      return true;
    } catch {
      if (dataChannel?.readyState === "open") {
        try {
          dataChannel.send(JSON.stringify(envelope));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async function handleP2pMessageEnvelope(envelope: Extract<DataEnvelope, { kind: "chat" | "chat-ack" }>) {
    if (envelope.kind === "chat-ack") {
      pendingP2pMessageAttemptsRef.current.delete(envelope.messageId);
      clearP2pMessageAckTimer(envelope.messageId);
      updateP2pMessageDelivery(envelope.messageId, "delivered");
      return;
    }
    setP2pMessages((messages) =>
      messages.some((message) => message.id === envelope.id)
        ? messages
        : [
            ...messages,
            {
              id: envelope.id,
              author: envelope.author,
              body: envelope.body,
              lane: "p2p",
              at: envelope.at
            }
          ]
    );
    await sendP2pMessageEnvelope({ kind: "chat-ack", messageId: envelope.id });
  }

  function updateP2pMessageDelivery(messageId: string, localState?: "sending" | "delivered" | "failed", failureReason?: string) {
    setP2pMessages((messages) =>
      messages.map((message) =>
        message.id === messageId
          ? { ...message, localState, failureReason }
          : message
      )
    );
  }

  function clearP2pMessageAckTimer(messageId: string) {
    const timer = pendingP2pMessageTimersRef.current.get(messageId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingP2pMessageTimersRef.current.delete(messageId);
    }
  }

  function clearP2pMessageAckTimers() {
    for (const timer of pendingP2pMessageTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    pendingP2pMessageTimersRef.current.clear();
    pendingP2pMessageAttemptsRef.current.clear();
  }

  function clearP2pFileAckTimer(transferId: string) {
    const timer = pendingP2pFileAckTimersRef.current.get(transferId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingP2pFileAckTimersRef.current.delete(transferId);
    }
  }

  function clearP2pFileAckTimers() {
    for (const timer of pendingP2pFileAckTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    pendingP2pFileAckTimersRef.current.clear();
  }

  function startP2pFileAckTimer(transferId: string) {
    clearP2pFileAckTimer(transferId);
    const timer = window.setTimeout(() => {
      pendingP2pFileAckTimersRef.current.delete(transferId);
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "未收到对方的文件校验确认，请重试",
        retryable: pendingFilesRef.current.has(transferId)
      });
    }, P2P_FILE_ACK_TIMEOUT_MS);
    pendingP2pFileAckTimersRef.current.set(transferId, timer);
  }

  function markPendingP2pMessagesFailed(reason: string) {
    clearP2pMessageAckTimers();
    setP2pMessages((messages) =>
      messages.map((message) =>
        message.self && message.localState === "sending"
          ? { ...message, localState: "failed", failureReason: reason }
          : message
      )
    );
  }

  function addP2pFile(file: File) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: "系统",
          body: "加密直连文件传输尚未就绪。请让对方保持页面打开，或改用共享空间上传。",
          lane: "p2p",
          at: nowLabel()
        }
      ]);
      return;
    }

    const transferId = makeId("file");
    const riskNote = getFileRiskNote(file.size);
    if (file.size > P2P_MAX_FILE_BYTES) {
      setP2pMessages((messages) => [
        ...messages,
        {
          id: transferId,
          author: displayName.trim() || "你",
          body: `文件未发送：${getFileLimitText()} 大文件请拆分后重试，或改用共享空间上传。`,
          lane: "p2p",
          at: nowLabel(),
          self: true,
          fileTransfer: {
            id: transferId,
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            status: "failed",
            progress: 0,
            failureReason: `超过 ${formatBytes(P2P_MAX_FILE_BYTES)} 的直连上限`,
            riskNote: "大文件更适合上传到共享空间，方便稍后继续处理。"
          }
        }
      ]);
      return;
    }

    pendingFilesRef.current.set(transferId, file);
    const mimeType = file.type || "application/octet-stream";
    const previewUrl = isPreviewableImageMimeType(mimeType) ? URL.createObjectURL(file) : undefined;
    if (previewUrl) {
      p2pDownloadUrlsRef.current.set(transferId, previewUrl);
    }
    const offered = sendEnvelope({
      kind: "file-offer",
      transferId,
      author: displayName.trim() || "对方",
      name: file.name,
      size: file.size,
      mimeType,
      total: getP2pFileChunkCount(file.size)
    });
    const initialTransfer: FileTransfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      mimeType,
      status: offered ? "waiting" : "failed",
      progress: 0,
      downloadUrl: previewUrl,
      riskNote,
      retryable: true,
      failureReason: offered ? undefined : "直连数据通道已断开"
    };
    setP2pMessages((messages) => [
      ...messages,
      {
        id: transferId,
        author: displayName.trim() || "你",
        body: getFileMessageBody(initialTransfer),
        lane: "p2p",
        at: nowLabel(),
        self: true,
        fileTransfer: initialTransfer
      }
    ]);
  }

  function sendEnvelope(envelope: DataEnvelope) {
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      return false;
    }
    try {
      dataChannel.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  async function handleDataChannelMessage(raw: string, sessionGeneration: number) {
    if (p2pSessionGenerationRef.current !== sessionGeneration) {
      return;
    }
    const envelope = parseDataEnvelope(raw);
    if (!envelope) {
      return;
    }

    if (envelope.kind === "chat" || envelope.kind === "chat-ack") {
      await handleP2pMessageEnvelope(envelope);
      return;
    }

    if (envelope.kind === "file-offer") {
      const existingFile = incomingFilesRef.current.get(envelope.transferId);
      if (existingFile?.blob) {
        if (
          existingFile.name === envelope.name &&
          existingFile.size === envelope.size &&
          existingFile.total === envelope.total &&
          existingFile.mimeType === (envelope.mimeType || "application/octet-stream")
        ) {
          sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
        } else {
          sendEnvelope({ kind: "file-error", transferId: envelope.transferId, reason: "文件重试信息不一致" });
        }
        return;
      }
      releaseIncomingP2pFile(envelope.transferId);
      cancelledP2pFileTransfersRef.current.delete(envelope.transferId);
      incomingFilesRef.current.set(envelope.transferId, {
        name: envelope.name,
        size: envelope.size,
        total: envelope.total,
        mimeType: envelope.mimeType || "application/octet-stream",
        accepted: false,
        chunks: [],
        chunkDigests: [],
        receivedBytes: 0
      });
      const incomingMessage: Message = {
        id: envelope.transferId,
        author: envelope.author || "对方",
        body: "收到一个加密文件传输请求。",
        lane: "p2p",
        at: nowLabel(),
        fileTransfer: {
          id: envelope.transferId,
          name: envelope.name,
          size: envelope.size,
          mimeType: envelope.mimeType,
          status: "offered",
          progress: 0,
          riskNote: getFileRiskNote(envelope.size)
        }
      };
      setP2pMessages((messages) =>
        messages.some((message) => message.id === envelope.transferId)
          ? messages.map((message) => message.id === envelope.transferId ? incomingMessage : message)
          : [...messages, incomingMessage]
      );
      return;
    }

    if (envelope.kind === "file-accept") {
      const file = pendingFilesRef.current.get(envelope.transferId);
      if (!file) {
        updateP2pFileTransfer(envelope.transferId, {
          status: "failed",
          failureReason: "本机已找不到待发送文件，请重新选择文件发送",
          retryable: false
        });
        return;
      }
      cancelledP2pFileTransfersRef.current.delete(envelope.transferId);
      void sendP2pFile(envelope.transferId, file).catch(() => {
        clearP2pFileAckTimer(envelope.transferId);
        if (!cancelledP2pFileTransfersRef.current.has(envelope.transferId)) {
          updateP2pFileTransfer(envelope.transferId, {
            status: "failed",
            failureReason: "文件读取或加密失败，请重新发送",
            retryable: true
          });
        }
      });
      return;
    }

    if (envelope.kind === "file-reject") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      releaseIncomingP2pFile(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, {
        status: "rejected",
        progress: 0,
        failureReason: envelope.reason || "对方拒绝接收"
      });
      return;
    }

    if (envelope.kind === "file-chunk") {
      const incomingFile = incomingFilesRef.current.get(envelope.transferId);
      if (!incomingFile) {
        return;
      }
      if (!incomingFile.accepted) {
        failIncomingP2pFile(envelope.transferId, "文件尚未确认接收");
        return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = base64ToBytes(envelope.data);
      } catch {
        failIncomingP2pFile(envelope.transferId, "文件分片无法解码");
        return;
      }
      const metadataFailure = validateP2pFileChunk(incomingFile, envelope, bytes);
      const digest = await sha256Base64Url(bytes.buffer);
      if (
        p2pSessionGenerationRef.current !== sessionGeneration ||
        incomingFilesRef.current.get(envelope.transferId) !== incomingFile
      ) {
        return;
      }
      if (metadataFailure || digest !== envelope.sha256) {
        failIncomingP2pFile(envelope.transferId, metadataFailure || "文件分片校验失败");
        return;
      }
      const previousDigest = incomingFile.chunkDigests[envelope.index];
      if (previousDigest) {
        if (previousDigest !== digest) {
          failIncomingP2pFile(envelope.transferId, "收到冲突的重复分片");
        }
        return;
      }
      incomingFile.chunks[envelope.index] = bytes;
      incomingFile.chunkDigests[envelope.index] = digest;
      incomingFile.receivedBytes += bytes.byteLength;
      updateP2pFileTransfer(envelope.transferId, {
        status: "receiving",
        progress: getTransferProgress(incomingFile.receivedBytes, incomingFile.size)
      });
      return;
    }

    if (envelope.kind === "file-complete") {
      const incomingFile = incomingFilesRef.current.get(envelope.transferId);
      if (!incomingFile) {
        return;
      }
      if (incomingFile.blob) {
        if (envelope.total === incomingFile.total && envelope.size === incomingFile.size) {
          sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
        } else {
          sendEnvelope({ kind: "file-error", transferId: envelope.transferId, reason: "文件完成信息不一致" });
        }
        return;
      }
      const completionFailure = validateP2pFileCompletion(incomingFile, envelope);
      if (completionFailure) {
        failIncomingP2pFile(envelope.transferId, completionFailure);
        return;
      }
      const completeChunks = incomingFile.chunks as Uint8Array<ArrayBuffer>[];
      const blob = new Blob(completeChunks, { type: incomingFile.mimeType || "application/octet-stream" });
      if (blob.size !== incomingFile.size) {
        failIncomingP2pFile(envelope.transferId, "文件组装后的大小不一致");
        return;
      }
      incomingFile.blob = blob;
      incomingFile.chunks = [];
      incomingFile.chunkDigests = [];
      const downloadUrl = URL.createObjectURL(blob);
      p2pDownloadUrlsRef.current.set(envelope.transferId, downloadUrl);
      updateP2pFileTransfer(envelope.transferId, { status: "complete", progress: 100, downloadUrl });
      sendEnvelope({ kind: "file-ack", transferId: envelope.transferId });
      return;
    }

    if (envelope.kind === "file-ack") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      pendingFilesRef.current.delete(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, { status: "complete", progress: 100, retryable: false });
      return;
    }

    if (envelope.kind === "file-error") {
      clearP2pFileAckTimer(envelope.transferId);
      cancelledP2pFileTransfersRef.current.add(envelope.transferId);
      updateP2pFileTransfer(envelope.transferId, {
        status: "failed",
        failureReason: envelope.reason,
        retryable: pendingFilesRef.current.has(envelope.transferId)
      });
    }
  }

  function failIncomingP2pFile(transferId: string, reason: string) {
    releaseIncomingP2pFile(transferId);
    updateP2pFileTransfer(transferId, {
      status: "failed",
      progress: 0,
      failureReason: reason,
      retryable: false
    });
    sendEnvelope({ kind: "file-error", transferId, reason });
  }

  function releaseIncomingP2pFile(transferId: string) {
    incomingFilesRef.current.delete(transferId);
    const downloadUrl = p2pDownloadUrlsRef.current.get(transferId);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      p2pDownloadUrlsRef.current.delete(transferId);
    }
  }

  function clearIncomingP2pFiles() {
    incomingFilesRef.current.clear();
    for (const downloadUrl of p2pDownloadUrlsRef.current.values()) {
      URL.revokeObjectURL(downloadUrl);
    }
    p2pDownloadUrlsRef.current.clear();
  }

  async function handleSignalMessage(
    peerConnection: RTCPeerConnection,
    sendSignal: (payload: unknown) => void,
    signal: SignalMessage
  ) {
    if (signal.signal === "offer" && signal.description) {
      await peerConnection.setRemoteDescription(signal.description);
      await drainPendingIce(peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendSignal({ type: "signal", signal: "answer", description: answer });
      return;
    }

    if (signal.signal === "answer" && signal.description) {
      await peerConnection.setRemoteDescription(signal.description);
      await drainPendingIce(peerConnection);
      return;
    }

    if (signal.signal === "ice" && signal.candidate) {
      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(signal.candidate);
      } else {
        pendingIceRef.current.push(signal.candidate);
      }
    }
  }

  async function drainPendingIce(peerConnection: RTCPeerConnection) {
    const candidates = pendingIceRef.current.splice(0);
    for (const candidate of candidates) {
      await peerConnection.addIceCandidate(candidate);
    }
  }

  function updateP2pFileTransfer(transferId: string, patch: Partial<FileTransfer>) {
    setP2pMessages((messages) =>
      messages.map((message) => {
        if (message.fileTransfer?.id !== transferId) {
          return message;
        }
        return {
          ...message,
          body: getFileMessageBody({ ...message.fileTransfer, ...patch }),
          fileTransfer: {
            ...message.fileTransfer,
            ...patch
          }
        };
      })
    );
  }

  function markInterruptedTransfers(reason: string) {
    clearP2pFileAckTimers();
    for (const [transferId, incomingFile] of incomingFilesRef.current) {
      if (!incomingFile.blob) {
        releaseIncomingP2pFile(transferId);
      }
    }
    setP2pMessages((messages) =>
      messages.map((message) => {
        const transfer = message.fileTransfer;
        if (!transfer || !["waiting", "sending", "receiving", "verifying", "offered"].includes(transfer.status)) {
          return message;
        }
        const nextTransfer = {
          ...transfer,
          status: "failed" as const,
          failureReason: reason,
          retryable: Boolean(message.self && pendingFilesRef.current.has(transfer.id))
        };
        return {
          ...message,
          body: getFileMessageBody(nextTransfer),
          fileTransfer: nextTransfer
        };
      })
    );
  }

  async function sendP2pFile(transferId: string, file: File) {
    clearP2pFileAckTimer(transferId);
    const dataChannel = dataChannelRef.current;
    if (dataChannel?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道已断开，请重连后重新发送",
        retryable: true
      });
      return;
    }

    const sendTransferEnvelope = (envelope: DataEnvelope) => {
      if (dataChannelRef.current !== dataChannel || dataChannel.readyState !== "open") {
        return false;
      }
      try {
        dataChannel.send(JSON.stringify(envelope));
        return true;
      } catch {
        return false;
      }
    };

    const failInterruptedTransfer = () => {
      clearP2pFileAckTimer(transferId);
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "传输中断，请确认双方页面在线后重新发送",
        retryable: true
      });
    };

    updateP2pFileTransfer(transferId, { status: "sending", progress: 0, failureReason: undefined });
    const total = getP2pFileChunkCount(file.size);
    for (let index = 0; index < total; index += 1) {
      if (cancelledP2pFileTransfersRef.current.has(transferId)) {
        return;
      }
      const chunk = file.slice(index * P2P_FILE_CHUNK_SIZE, Math.min(file.size, (index + 1) * P2P_FILE_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      const sha256 = await sha256Base64Url(buffer);
      await waitForBufferedAmount(dataChannel);
      if (cancelledP2pFileTransfersRef.current.has(transferId)) {
        return;
      }
      if (!sendTransferEnvelope({
          kind: "file-chunk",
          transferId,
          index,
          total,
          sha256,
          data: arrayBufferToBase64(buffer)
        })) {
        failInterruptedTransfer();
        return;
      }
      updateP2pFileTransfer(transferId, { progress: Math.round(((index + 1) / total) * 100) });
    }

    startP2pFileAckTimer(transferId);
    if (!sendTransferEnvelope({ kind: "file-complete", transferId, total, size: file.size })) {
      failInterruptedTransfer();
      return;
    }
    updateP2pFileTransfer(transferId, { status: "verifying", progress: 100, retryable: true });
  }

  async function acceptP2pFile(transferId: string) {
    const accepted = sendEnvelope({ kind: "file-accept", transferId });
    if (!accepted) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "接受时直连通道已断开，请让对方重新发送"
      });
      return;
    }
    cancelledP2pFileTransfersRef.current.delete(transferId);
    const incomingFile = incomingFilesRef.current.get(transferId);
    if (incomingFile) {
      incomingFile.accepted = true;
    }
    updateP2pFileTransfer(transferId, { status: "receiving", progress: 0, failureReason: undefined });
  }

  function rejectP2pFile(transferId: string) {
    cancelledP2pFileTransfersRef.current.add(transferId);
    releaseIncomingP2pFile(transferId);
    sendEnvelope({ kind: "file-reject", transferId, reason: "对方拒绝接收" });
    updateP2pFileTransfer(transferId, { status: "rejected", progress: 0, failureReason: "你已拒绝接收" });
  }

  function retryP2pFile(transferId: string) {
    clearP2pFileAckTimer(transferId);
    const file = pendingFilesRef.current.get(transferId);
    if (!file) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "本机已找不到原文件，请重新选择文件",
        retryable: false
      });
      return;
    }
    if (dataChannelRef.current?.readyState !== "open") {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道未恢复，请等待对方在线后重试",
        retryable: true
      });
      return;
    }
    cancelledP2pFileTransfersRef.current.delete(transferId);
    updateP2pFileTransfer(transferId, { status: "waiting", progress: 0, failureReason: undefined });
    const offered = sendEnvelope({
      kind: "file-offer",
      transferId,
      author: displayName.trim() || "对方",
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      total: getP2pFileChunkCount(file.size)
    });
    if (!offered) {
      updateP2pFileTransfer(transferId, {
        status: "failed",
        failureReason: "直连数据通道未恢复，请等待对方在线后重试",
        retryable: true
      });
    }
  }

  async function saveP2pFile(transfer: FileTransfer) {
    const incomingFile = incomingFilesRef.current.get(transfer.id);
    const blob = incomingFile?.blob;
    if (!blob) {
      return;
    }

    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({ suggestedName: transfer.name });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    const temporaryDownloadUrl = !transfer.downloadUrl;
    const downloadUrl = transfer.downloadUrl ?? URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = transfer.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (temporaryDownloadUrl) {
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
  }

  function saveP2pSession() {
    const now = new Date().toISOString();
    const session: SavedP2pSession = {
      id: makeId("session"),
      roomId: roomId || "本地",
      displayName: displayName.trim() || "本机",
      savedAt: now,
      messages: sanitizeMessagesForStorage(p2pMessages)
    };
    const nextSessions = [session, ...savedP2pSessions].slice(0, 30);
    writeSavedP2pSessions(nextSessions);
    setSavedP2pSessions(nextSessions);
    setSelectedSavedSessionId(session.id);
    setSessionSaved("saved");
  }

  function exportP2pSession(session: SavedP2pSession) {
    downloadJson(`duallane-p2p-${session.roomId}-${session.savedAt.slice(0, 10)}.json`, session);
  }

  function clearSavedP2pSessions() {
    writeSavedP2pSessions([]);
    setSavedP2pSessions([]);
    setSelectedSavedSessionId("");
    setSavedSessionsOpen(false);
  }

  function discardP2pSession() {
    navigation.runConfirmed(() => { setP2pMessages([]); resetToEntry(); });
  }

  function requestP2pEnd() {
    navigation.request(() => {}, {
      message: "结束后连接会关闭，尚未完成的传输会停止。你可以在下一步选择保存本机记录；取消会继续保持连接。",
      discard: () => { endP2pSocket(); setP2pStep("ended"); }
    });
  }

  function endP2pSocket() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "leave" }));
    }
    wsRef.current?.close();
    dataChannelRef.current?.close();
  }

  function applyAppRouteState(route: AppRoute) {
    setWorkspaceEmoteCollectionPreviewId("");
    setWorkspaceEmoteManagerOpen(false);
    if (route.kind === "entry" || route.kind === "about") {
      setLane(route.kind);
      setWorkspaceCreateMenuOpen(false);
      setWorkspaceUserMenuOpen(false);
      return;
    }

    if (route.kind === "direct") {
      const incomingSecret = route.roomId ? getRoomSecretFromHash() : "";
      setLane("p2p");
      setRoomId(route.roomId);
      setRoomSecret(incomingSecret);
      setInviteLink(route.roomId && incomingSecret ? withRoomSecret(getInviteLink(route.roomId), incomingSecret) : "");
      setP2pError("");
      if (route.roomId && !incomingSecret) {
        setP2pRoomIssue("missing-key");
        setP2pStep("invalid-room");
      } else {
        setP2pRoomIssue("");
        setP2pStep("name");
      }
      return;
    }

    setLane("workspace-dev");
    setWorkspacePendingInviteCode(route.inviteCode);
    setWorkspaceView(workspaceViewFromRoute(route));
    if (route.view === "chat") {
      setWorkspaceSelectedConversationId(route.conversationId);
    }
    setWorkspaceSelectedTopicId(route.topicId);
    setWorkspaceSelectedFileId(route.fileId);
    setWorkspaceSelectedMemberId(route.memberId);
    setWorkspaceSpaceTab(route.spaceTab);
    setWorkspaceCreateMode(route.createMode);
    setWorkspaceAccountSection(route.accountSection);
    setWorkspaceSetupSessionId(route.setupSessionId);
    setWorkspaceSharedEmoteCollectionId(route.sharedEmoteCollectionId);
    setWorkspaceCreateMenuOpen(false);
    setWorkspaceUserMenuOpen(false);

    if (route.view === "files") {
      setWorkspaceContextMode("file");
      if (route.fileId) setWorkspaceContextCollapsed(false);
      setWorkspaceMobilePane(route.fileId ? "details" : "main");
    } else if (route.view === "members") {
      setWorkspaceContextMode("member");
      if (route.memberId) setWorkspaceContextCollapsed(false);
      setWorkspaceMobilePane(route.memberId ? "details" : "main");
    } else if (route.view === "chat") {
      setWorkspaceContextMode("conversation");
      setWorkspaceMobilePane(route.conversationId ? "main" : "list");
    } else if (route.view === "topics") {
      setWorkspaceMobilePane(workspaceTopicMobilePane(route.topicId));
    } else {
      setWorkspaceMobilePane("main");
    }
  }

  function writeAppRoute(route: AppRoute, options: { replace?: boolean; roomSecret?: string } = {}) {
    const hash = route.kind === "direct" && options.roomSecret
      ? `#${new URLSearchParams({ k: options.roomSecret }).toString()}`
      : "";
    const nextUrl = `${getAppRouteUrl(route)}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
        if (!options.replace) routeIndexRef.current += 1;
    window.history[options.replace ? "replaceState" : "pushState"]({ duallaneIndex: routeIndexRef.current }, "", nextUrl);
    routeUrlRef.current = nextUrl;
  }

  function navigateAppRoute(route: AppRoute, options: { replace?: boolean; roomSecret?: string } = {}) {
    navigation.request(() => {
    writeAppRoute(route, options);
    applyAppRouteState(route);

    });
  }

  function replaceWorkspaceRoute(route: Extract<AppRoute, { kind: "workspace" }>) {
    writeAppRoute(route, { replace: true });
  }

  function navigateWorkspaceView(view: WorkspaceView, spaceTab: WorkspaceSpaceTab = "overview") {
    const route = workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view,
      conversationId: view === "chat" && !window.matchMedia("(max-width: 760px)").matches ? workspaceSelectedConversationId : "",
      topicId: view === "topics" ? workspaceSelectedTopicId : "",
      spaceTab
    });
    navigateAppRoute(route);
  }

  function openWorkspaceTopic(topicId: string, messageId?: string) {
    navigation.request(() => {
    setWorkspaceSelectedTopicId(topicId);
    setWorkspaceTopicLocateRequest(messageId ? { topicId, messageId } : null);
    navigateAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "topics",
      topicId
    }));
    setWorkspaceMobilePane("main");
    setWorkspaceCreateMode("");

    });
  }

  function navigateWorkspaceSpaceTab(spaceTab: WorkspaceSpaceTab) {
    navigateAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "space",
      spaceTab
    }));
  }

  function openWorkspaceEmoteManager() {
    setWorkspaceEmoteManagerOpen(true);
  }

  function navigateWorkspaceAccountSection(accountSection: WorkspaceRouteAccountSection) {
    navigateAppRoute(workspaceRoute({
      inviteCode: workspacePendingInviteCode,
      view: "account",
      accountSection
    }));
  }

  async function sendWorkspaceEmoteCollectionShare(conversationId: string, share: WorkspaceEmoteCollectionShareSummary) {
    const clientMessageId = makeId("wm-share");
    await submitWorkspaceMessage({
      conversationId,
      clientMessageId,
      body: `[表情合集] ${share.name}`,
      blocks: [{ type: "emote_collection", shareId: share.id }]
    });
    setWorkspaceSelectedConversationId(conversationId);
    navigateAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, conversationId }));
    showWorkspaceNotice("success", "表情合集已发送");
  }

  function hasWorkspaceDrafts() {
    return workspaceTopicSessionStore.hasUnsaved() || Object.values(workspaceDraftByConversation).some((document) => document.source.trim()) || Object.values(workspaceComposerAttachmentsByConversation).some((attachments) => attachments.length > 0);
  }

  function requestWorkspaceExit(action: () => void) {
    if (lane !== "workspace-dev" || !hasWorkspaceDrafts()) { navigation.request(action); return; }
    const profile = settingsGuardRef.current;
    navigation.request(action, {
      title: "离开前处理未发送的内容",
      message: "你还有未发送的聊天、话题草稿或待添加附件。继续会清除这些设备内的草稿。" + (profile ? "当前表单也有未完成的修改；继续会按确认选项处理。" : "取消可返回继续编辑。"),
      save: profile?.save,
      saveLabel: "保存当前修改并放弃聊天草稿",
      confirmLabel: "放弃草稿并继续",
      discard: () => profile?.discard()
    });
  }

  function resetToEntry() {
    requestWorkspaceExit(() => {
    endP2pSocket();
    clearWorkspaceClientState();
    navigateAppRoute({ kind: "entry" });
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setP2pMessages([]);
    setP2pDraft("");
    setSessionSaved("idle");
    setP2pPeers([]);
    setP2pSocketState("idle");
    setP2pRtcState("idle");
    setP2pDataChannelState("idle");
    setRoomDetailsOpen(false);
    setSavedSessionsOpen(false);
    setCopyState("idle");
    p2pSessionGenerationRef.current += 1;
    p2pDataMessageQueueRef.current = Promise.resolve();
    pendingFilesRef.current.clear();
    cancelledP2pFileTransfersRef.current.clear();
    clearIncomingP2pFiles();
    clearP2pMessageAckTimers();
    clearP2pFileAckTimers();
    peerProfilesRef.current.clear();
    secureKeysRef.current = null;
    peerIdRef.current = "";
    setRoomId("");
    setInviteLink("");
    setRoomSecret("");
    setSecurityPassphrase("");
    setP2pParticipantCount(P2P_DEFAULT_PARTICIPANTS);
    setVerificationCode("");

    });
  }

  function startNewP2pRoom() {
    navigation.request(() => {
    endP2pSocket();
    navigateAppRoute({ kind: "direct", roomId: "" });
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pRoomIssue("");
    setP2pMessages([]);
    setP2pDraft("");
    setP2pPeers([]);
    setP2pSocketState("idle");
    setP2pRtcState("idle");
    setP2pDataChannelState("idle");
    setRoomDetailsOpen(false);
    setSavedSessionsOpen(false);
    setCopyState("idle");
    setSessionSaved("idle");
    p2pSessionGenerationRef.current += 1;
    p2pDataMessageQueueRef.current = Promise.resolve();
    pendingFilesRef.current.clear();
    cancelledP2pFileTransfersRef.current.clear();
    clearIncomingP2pFiles();
    clearP2pMessageAckTimers();
    clearP2pFileAckTimers();
    peerProfilesRef.current.clear();
    secureKeysRef.current = null;
    peerIdRef.current = "";
    setRoomId("");
    setInviteLink("");
    setRoomSecret("");
    setSecurityPassphrase("");
    setP2pParticipantCount(P2P_DEFAULT_PARTICIPANTS);
    setVerificationCode("");

    });
  }

  useEffect(() => {
    if (lane !== "p2p") return;
    if (p2pStep === "chat") {
      navigation.register({
        message: "结束后连接会关闭，尚未完成的传输会停止。接下来可以选择保存本机记录；取消会继续保持连接。",
        discard: () => {},
        continue: () => { endP2pSocket(); setP2pStep("ended"); }
      });
    } else if (p2pStep === "ended" && sessionSaved !== "saved" && p2pMessages.length) {
      navigation.register({
        title: "保存本机会话记录？",
        message: "记录只会保存到当前浏览器，包含消息明文。离开后，未保存的本次记录将被清除。",
        save: async () => { try { saveP2pSession(); return true; } catch { setP2pError("浏览器未能保存记录，请重试或导出后再离开。"); return false; } },
        discard: () => setP2pMessages([])
      });
    } else { navigation.register(null); }
    return () => navigation.register(null);
  }, [lane, p2pStep, sessionSaved, p2pMessages, navigation.register]);

  useEffect(() => {
    if (lane !== "workspace-dev") return;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (hasWorkspaceDrafts()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [lane, workspaceDraftByConversation, workspaceComposerAttachmentsByConversation, workspaceTopicSessionStore]);

  async function copyInviteLink() {
    const didCopy = await copyText(inviteLink);
    setCopyState(didCopy ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <main
      className={lane === "workspace-dev" ? "shell workspace-mode" : lane === "p2p" ? "shell p2p-mode" : lane === "about" ? "shell about-mode" : "shell"}
    >
      {navigation.confirmation}
      {(lane !== "workspace-dev" || workspaceStatus !== "ready" || !workspaceBootstrap) && (
        <ThemeSwitch mode={themeMode} resolvedTheme={resolvedTheme} onModeChange={setThemeMode} />
      )}
      {workspaceUpdateAvailable && (
        <div className="app-version-update" role="status">
          <RefreshCw size={15} aria-hidden="true" />
          <span>发现新版本，请刷新页面</span>
          <button type="button" onClick={() => requestWorkspaceExit(() => window.location.reload())}>刷新</button>
          <button className="app-version-update-close" type="button" aria-label="关闭新版本提示" title="关闭提示" onClick={dismissVersionUpdate}>
            <X size={15} />
          </button>
        </div>
      )}
      {lane === "entry" && <EntryPage
        onDirect={() => navigateAppRoute({ kind: "direct", roomId: "" })}
        onWorkspace={() => navigateAppRoute(workspaceRoute())}
        onAbout={() => navigateAppRoute({ kind: "about" })}
      />}

      {lane === "about" && <AboutPage onBack={() => navigateAppRoute({ kind: "entry" })} />}

      {lane === "p2p" && (
        <section className="lane-surface p2p-shell" aria-labelledby="p2p-title">
          <TopBar
            label="P2P 私密通道"
            title="一对一直连"
            icon={<LockKeyhole size={18} />}
            onBack={() => p2pStep === "chat" ? requestP2pEnd() : resetToEntry()}
          />

          {p2pStep === "name" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Radio size={30} />
              </div>
              <p className="eyebrow">无需账号</p>
              <h2 id="p2p-title">{roomId ? "加入私密直连会话。" : "发起私密直连会话。"}</h2>
              <p className="quiet">
                {roomId
                  ? `输入显示名称即可加入房间 ${roomId}。`
                  : "显示名称只会在本次本地会话中展示给对方。"}
              </p>
              <form className="stack-form" onSubmit={createP2pRoom} aria-busy={p2pCreating}>
                <label>
                  <span>显示名称</span>
                  <input
                    autoFocus
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={40}
                    placeholder="会话显示名称"
                  />
                </label>
                <details className="p2p-security-options"><summary>额外安全设置</summary>
                <label>
                  <span>安全口令（可选）</span>
                  <input
                    value={securityPassphrase}
                    onChange={(event) => setSecurityPassphrase(event.target.value)}
                    maxLength={64}
                    placeholder="双方输入同一口令"
                    autoComplete="off"
                  />
                </label>
                </details>
                {!roomId && <p className="p2p-participant-note">一对一交流 · 最多 {P2P_MAX_PARTICIPANTS} 人</p>}
                <button className="primary direct-button" type="submit" disabled={!displayName.trim() || p2pCreating}>
                  {roomId ? <MessageSquare size={18} /> : <Plus size={18} />}
                  {p2pCreating ? "正在准备…" : roomId ? "加入会话" : "开始会话"}
                </button>
              </form>
              <InlineNotice
                tone="info"
                text={
                  <>
                    邀请链接包含端到端加密密钥；<br />
                    安全口令只在本机参与派生，不会发送到服务器。
                  </>
                }
              />
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
              {savedP2pSessions.length > 0 && (
                <div className="local-records-block">
                  <button className="secondary compact" type="button" onClick={() => setSavedSessionsOpen((open) => !open)}>
                    <History size={16} />
                    {savedSessionsOpen ? "收起已保存记录" : "查看已保存记录"}
                  </button>
                  {savedSessionsOpen && (
                    <SavedSessionsPanel
                      sessions={savedP2pSessions}
                      selectedSession={selectedSavedSession}
                      selectedSessionId={selectedSavedSessionId}
                      onSelect={setSelectedSavedSessionId}
                      onExport={exportP2pSession}
                      onClear={clearSavedP2pSessions}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {p2pStep === "chat" && (
            <ChatPanel
              scopeKey={`p2p:${roomId || "local"}`}
              title="一对一直连"
              subtitle={`房间 ${roomId || "本地"}`}
              hideTitle
              waitingContent={p2pPeers.length < 2 ? (
                <div className="p2p-waiting-invite" role="status">
                  <Link2 size={22} aria-hidden="true" />
                  <div><h2>邀请对方，开始交流</h2><p>会话已经就绪。对方加入后，你可以直接在这里交流。</p></div>
                  <div className="copy-box"><span>{inviteLink}</span><button className="secondary" type="button" onClick={() => void copyInviteLink()}><Clipboard size={16} />{copyState === "copied" ? "已复制" : "复制邀请链接"}</button></div>
                  {copyState === "failed" && <p>复制失败，请手动选择上方链接。</p>}
                </div>
              ) : undefined}
              details={
                <RoomDetails
                  open={roomDetailsOpen}
                  details={roomDetails}
                  peers={p2pPeers}
                  shareLink={inviteLink}
                  onCopyShare={copyInviteLink}
                  copyState={copyState}
                  onToggle={() => setRoomDetailsOpen((open) => !open)}
                />
              }
              status={
                <P2pStatusControl
                  state={p2pConnectionState}
                  mode={p2pTransportMode}
                  peerCount={p2pPeers.length}
                  advice={connectionAdvice}
                  trustText={p2pTrustText(p2pTransportMode)}
                />
              }
              messages={p2pMessages}
              messageListRef={p2pMessageListRef}
              draft={p2pDraft}
              onDraft={setP2pDraft}
              onSend={sendP2pMessage}
              onRetryMessage={(messageId) => void retryP2pMessage(messageId)}
              onFile={addP2pFile}
              onAcceptFile={(transferId) => void acceptP2pFile(transferId)}
              onRejectFile={rejectP2pFile}
              onSaveFile={(transfer) => void saveP2pFile(transfer)}
              onRetryFile={retryP2pFile}
              onEnd={requestP2pEnd}
              fileLabel="选择文件"
              fileInputDisabled={!p2pCanTransferFiles}
              fileInputTitle={
                p2pCanTransferFiles ? "选择文件进行加密点对点传输" : "等待对方数据通道上线"
              }
            />
          )}

          {p2pStep === "invalid-room" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <AlertCircle size={30} />
              </div>
              <p className="eyebrow">房间不可用</p>
              <h2>{p2pRoomIssueTitle}</h2>
              <p className="quiet">{p2pRoomIssueText}</p>
              <div className="action-row">
                <button className="primary direct-button" type="button" onClick={startNewP2pRoom}>
                  <RefreshCw size={18} />
                  重新创建房间
                </button>
                <button className="secondary" type="button" onClick={resetToEntry}>
                  <ArrowLeft size={18} />
                  返回通道选择
                </button>
              </div>
              <InlineNotice
                tone="warning"
                text={
                  <>
                    房间只保存短时信令状态；<br />
                    过期或服务重启后，需要使用新链接。
                  </>
                }
              />
            </div>
          )}

          {p2pStep === "ended" && (
            <div className="single-action">
              <div className="center-icon ended-bg" aria-hidden="true">
                <Check size={30} />
              </div>
              <p className="eyebrow">会话已关闭</p>
              <h2>本次会话已结束。</h2>
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
              <p className="quiet">
                服务器不保存对话内容；<br />
                选择本地保存或导出时，记录会以明文保存在本机浏览器或文件中。
              </p>
              <div className="action-row">
                {sessionSaved === "saved" ? (
                  <button className="primary direct-button" type="button" onClick={resetToEntry}>
                    <ArrowLeft size={18} />
                    返回首页
                  </button>
                ) : (
                  <>
                    <button
                      className="primary direct-button"
                      type="button"
                      onClick={() => { try { saveP2pSession(); } catch { setP2pError("浏览器未能保存记录，请重试。"); } }}
                    >
                      <Save size={18} />
                      保存到本地
                    </button>
                    <button className="secondary" type="button" onClick={() => exportP2pSession({ id: makeId("session"), roomId, displayName: displayName.trim(), savedAt: new Date().toISOString(), messages: sanitizeMessagesForStorage(p2pMessages) })}><Download size={18} />导出本次记录</button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={discardP2pSession}
                    >
                      <X size={18} />
                      不保存并关闭
                    </button>
                  </>
                )}
              </div>
              {sessionSaved === "saved" && <InlineNotice tone="success" text="已保存到本机浏览器明文存储。" />}
              <SavedSessionsPanel
                sessions={savedP2pSessions}
                selectedSession={selectedSavedSession}
                selectedSessionId={selectedSavedSessionId}
                onSelect={setSelectedSavedSessionId}
                onExport={exportP2pSession}
                onClear={clearSavedP2pSessions}
              />
            </div>
          )}
        </section>
      )}

      {lane === "workspace-dev" && (
        <section
          className="workspace-shell"
          aria-labelledby="workspace-dev-title"
          aria-busy={workspaceStatus === "idle" || workspaceStatus === "loading"}
          data-app-state={
            workspaceStatus === "idle" || workspaceStatus === "loading"
              ? "loading"
              : workspaceStatus === "ready" && workspaceBootstrap
                ? "ready"
                : "error"
          }
        >
          {workspaceStatus !== "idle" && workspaceStatus !== "loading" && (workspaceStatus !== "ready" || !workspaceBootstrap) && (
            <TopBar
              label="共享空间"
              title={workspaceBootstrap?.space.name ?? "共享空间"}
              icon={<ShieldCheck size={18} />}
              onBack={resetToEntry}
            />
          )}
          {workspaceStatus === "idle" || workspaceStatus === "loading" ? (
            <WorkspaceShellSkeleton />
          ) : workspaceStatus !== "ready" || !workspaceBootstrap ? (
            <div className="single-action development-state">
              <div className="center-icon workspace-dev-bg" aria-hidden="true">
                <ShieldCheck size={30} />
              </div>
              <p className="eyebrow">
                {workspaceStatus === "disabled" ? "暂未开放" : workspaceStatus === "error" ? "加载失败" : "需要登录"}
              </p>
              <h2 id="workspace-dev-title">
                {workspaceStatus === "disabled"
                  ? "共享空间暂未开放。"
                  : workspaceStatus === "error"
                    ? "共享空间加载失败。"
                    : "登录后进入共享空间。"}
              </h2>
              <p className="quiet">
                共享空间会保存聊天和文件，方便成员稍后查看。<br />
                进入权限由服务端校验。
              </p>
              {workspaceError && <InlineNotice tone={workspaceStatus === "disabled" ? "info" : "warning"} text={workspaceError} />}
              {(workspaceStatus === "auth" || workspaceStatus === "error") && (
                <div className="action-row">
                  {workspaceStatus === "auth" && (
                    <button className="primary workspace-login-button" type="button" onClick={() => window.location.assign(getWorkspaceLoginUrl(workspacePendingInviteCode, `${window.location.pathname}${window.location.search}`))}>
                      <Github size={18} />
                      使用 GitHub 登录
                    </button>
                  )}
                  {workspaceStatus === "error" && (
                    <button className="secondary" type="button" onClick={() => void loadWorkspace()}>
                      <RefreshCw size={18} />
                      重新加载
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {workspaceNotice && (
                <div className="toast-region" aria-live="polite" aria-atomic="true">
                  <InlineNotice
                    noticeKey={workspaceNotice.id}
                    tone={workspaceNotice.tone}
                    text={workspaceNotice.text}
                    persistent={workspaceNotice.persistent}
                    durationMs={workspaceNotice.durationMs}
                    onDismiss={clearWorkspaceNotice}
                  />
                </div>
              )}
              <WorkspaceShell mobilePane={workspaceMobilePane} contextVisible={workspaceContextVisible} railCollapsed={workspaceRailCollapsed} hasObjectList={workspaceView === "chat" || workspaceView === "topics"}>
                <aside className="workspace-rail" aria-label="共享空间导航">
                  <div className="workspace-rail-header">
                    <div className="workspace-space-identity">
                      <img className="workspace-space-logo" src="/icon-512.png" alt="" aria-hidden="true" />
                      <span>
                        <strong>{workspaceBootstrap.space.name}</strong>
                        <small>共享空间</small>
                      </span>
                    </div>
                    <div className="workspace-popover-anchor" ref={workspaceCreateMenuRef}>
                      <button
                        ref={workspaceCreateTriggerRef}
                        id="workspace-create-menu-trigger"
                        className="icon-button"
                        type="button"
                        title="新建"
                        aria-label="新建"
                        aria-haspopup="menu"
                        aria-expanded={workspaceCreateMenuOpen}
                        aria-controls={workspaceCreateMenuOpen ? "workspace-create-menu" : undefined}
                        onClick={() => {
                          setWorkspaceUserMenuOpen(false);
                          setWorkspaceCreateMenuOpen((open) => !open);
                        }}
                      >
                        <Plus size={18} />
                      </button>
                      {workspaceCreateMenuOpen && (
                        <div
                          className="workspace-popover workspace-create-menu"
                          id="workspace-create-menu"
                          role="menu"
                          aria-label="新建菜单"
                          onKeyDown={handleMenuKeyDown}
                        >
                          {workspaceBootstrap.permissions.canCreateDirect && (
                            <button role="menuitem" type="button" onClick={() => openWorkspaceCreate("direct")}>
                              <MessageSquare size={16} />
                              发起私聊
                            </button>
                          )}
                          {workspaceBootstrap.permissions.canCreateGroup && (
                            <button role="menuitem" type="button" onClick={() => openWorkspaceCreate("group")}>
                              <UsersRound size={16} />
                              创建群聊
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <WorkspaceNavigation view={workspaceView} onNavigate={navigateWorkspaceView} canManageSpace={workspaceBootstrap.auth.currentUser.role === "owner" || workspaceBootstrap.auth.currentUser.role === "admin"} railCollapsed={workspaceRailCollapsed} onToggleRail={() => { setWorkspaceUserMenuOpen(false); setWorkspaceCreateMenuOpen(false); setWorkspaceRailCollapsed((collapsed) => !collapsed); }} />
                  <div className={`workspace-rail-content ${workspaceView}`} id="workspace-object-list">
                  {workspaceView === "chat" ? (
                    <>
                      <label className="workspace-search compact-search">
                        <span className="sr-only">查找会话</span>
                        <input value={workspaceConversationQuery} onChange={(event) => setWorkspaceConversationQuery(event.target.value)} placeholder="查找会话" />
                      </label>
                      <div className="conversation-list workspace-conversation-list" ref={workspaceConversationListRef} tabIndex={-1} aria-label="会话列表">
                        {workspaceFilteredConversations.length === 0 ? <p className="saved-empty">{workspaceConversations.length === 0 ? "还没有会话。可以从成员列表发起私聊。" : "没有找到匹配的会话。"}</p> : workspaceFilteredConversations.map((conversation) => (
                          <div className="dl-object-row dl-conversation-object" key={conversation.id}>
                          <button {...workspaceConversationActions.bindObject(conversation.id)} data-object-action-root className={conversation.id === workspaceSelectedConversationId ? "conversation active" : "conversation"} type="button" aria-current={conversation.id === workspaceSelectedConversationId ? "true" : undefined} onClick={() => selectWorkspaceConversation(conversation.id)}>
                            <WorkspaceConversationAvatar conversation={conversation} currentUserId={workspaceBootstrap.auth.currentUser.id} className="conversation-icon" />
                            <span><strong><WorkspaceIdentityName name={workspaceConversationTitle(conversation, workspaceBootstrap.auth.currentUser.id)} kind={conversation.otherMember?.kind} /></strong><small>{workspaceConversationPreview(conversation)}</small></span>
                            <span className="conversation-side"><time>{workspaceConversationTime(conversation)}</time>{(conversation.unreadCount ?? 0) > 0 ? <em className="unread-badge">{conversation.unreadCount}</em> : conversation.notificationLevel === "muted" ? <BellOff className="conversation-muted" size={14} aria-label="已免打扰" /> : null}</span>
                          </button>
                          <button className="dl-object-more" type="button" aria-label={`更多会话操作：${workspaceConversationTitle(conversation, workspaceBootstrap.auth.currentUser.id)}`} title="更多会话操作" aria-haspopup="menu" aria-expanded={workspaceConversationActions.menuProps.open && workspaceConversationActions.targetId === conversation.id} onClick={(event) => workspaceConversationActions.openFromTrigger(conversation.id, event.currentTarget)}><Ellipsis size={18} /></button>
                          </div>
                        ))}
                        {workspaceActionConversation && <ObjectActionMenu {...workspaceConversationActions.menuProps} label="会话操作" summary={workspaceConversationTitle(workspaceActionConversation, workspaceBootstrap.auth.currentUser.id)} actions={[
                          { id: "open", label: "打开会话", icon: <MessageSquare size={17} />, onSelect: () => selectWorkspaceConversation(workspaceActionConversation.id) },
                          { id: "details", label: "查看会话详情", icon: <PanelRightOpen size={17} />, onSelect: () => selectWorkspaceConversation(workspaceActionConversation.id, true) }
                        ]} />}
                      </div>
                    </>
                  ) : workspaceView === "topics" ? (
                    <WorkspaceTopicRail
                      registerNavigationGuard={registerSettingsGuard}
                      currentUserId={workspaceBootstrap.auth.currentUser.id}
                      currentUserRole={workspaceBootstrap.auth.currentUser.role}
                      selectedTopicId={workspaceSelectedTopicId}
                      conversations={workspaceConversations
                        .filter((conversation) => conversation.type === "group")
                        .map((conversation) => ({
                          id: conversation.id,
                          title: workspaceConversationTitle(conversation, workspaceBootstrap.auth.currentUser.id)
                        }))}
                      refreshSignal={workspaceTopicRefreshSignal}
                      onOpen={openWorkspaceTopic}
                    />
                  ) : null}
                  </div>
                  <div className="workspace-rail-footer">
                    {workspaceRealtimeState !== "connected" && (
                      <div className={`workspace-connection-state ${workspaceRealtimeState}`} role="status">
                        <Radio size={14} />
                        <span>{workspaceRealtimeStateLabel(workspaceRealtimeState)}</span>
                      </div>
                    )}
                    <div className="workspace-popover-anchor" ref={workspaceUserMenuRef}>
                      <button
                        ref={workspaceUserTriggerRef}
                        id="workspace-user-menu-trigger"
                        className="workspace-user-trigger"
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={workspaceUserMenuOpen}
                        aria-controls={workspaceUserMenuOpen ? "workspace-user-menu" : undefined}
                        onClick={() => {
                          setWorkspaceCreateMenuOpen(false);
                          setWorkspaceUserMenuOpen((open) => !open);
                        }}
                      >
                        <WorkspaceAvatar
                          name={workspaceBootstrap.auth.currentUser.displayName}
                          avatarUrl={workspaceBootstrap.auth.currentUser.avatarUrl}
                          className="small"
                          decorative
                        />
                        <span>
                          <strong>{workspaceBootstrap.auth.currentUser.displayName}</strong>
                          <small>{workspaceRoleLabel(workspaceBootstrap.auth.currentUser.role)}</small>
                        </span>
                        <ChevronUp size={15} />
                      </button>
                      {workspaceUserMenuOpen && (
                        <div
                          className="workspace-popover workspace-user-menu"
                          id="workspace-user-menu"
                          role="menu"
                          aria-label="账号菜单"
                          onKeyDown={handleMenuKeyDown}
                        >
                          <div className="workspace-user-summary" role="presentation">
                            <span>今日传输额度</span>
                            <strong>{workspaceRemainingText}</strong>
                            <small>{workspaceQuotaDetailText}</small>
                          </div>
                          <button role="menuitem" type="button" onClick={() => void loadWorkspace()}>
                            <RefreshCw size={16} />
                            重新同步
                          </button>
                          <button role="menuitem" type="button" onClick={resetToEntry}>
                            <ArrowLeft size={16} />
                            返回入口
                          </button>
                          <button role="menuitem" className="danger-action" type="button" onClick={() => void logoutWorkspace()}>
                            <LogOut size={16} />
                            退出共享空间
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </aside>

                <section className="workspace-main" id="workspace-main-panel" aria-label="共享空间主视图">
                  {workspaceCreateMode && (
                    <div
                      className="workspace-task-panel"

                      role="region"
                      aria-label={workspaceCreateMode === "direct" ? "发起私聊" : "创建群聊"}
                      onKeyDown={handleWorkspaceCreatePanelKeyDown}
                    >
                      <div className="workspace-task-header">
                        <div>
                          <p className="eyebrow">{workspaceCreateMode === "direct" ? "私聊" : "群聊"}</p>
                          <h2>{workspaceCreateMode === "direct" ? "选择一个成员开始私聊" : "创建群聊"}</h2>
                        </div>
                        <button
                          className="icon-button"
                          type="button"
                          title="关闭"
                          onClick={closeWorkspaceCreate}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <label className="workspace-search">
                        <span>查找成员</span>
                        <input
                          ref={workspaceCreateSearchInputRef}
                          value={workspacePickerMemberQuery}
                          onChange={(event) => setWorkspacePickerMemberQuery(event.target.value)}
                          placeholder="输入昵称或 GitHub 登录名"
                        />
                      </label>
                      {workspaceCreateMode === "group" && (
                        <form className="workspace-group-form" onSubmit={(event) => void createWorkspaceGroup(event)}>
                          <label>
                            <span>群聊名称</span>
                            <input
                              value={workspaceNewGroupTitle}
                              onChange={(event) => setWorkspaceNewGroupTitle(event.target.value)}
                              placeholder="例如：项目讨论"
                              aria-label="群聊名称"
                            />
                          </label>
                          <WorkspaceGroupAvatarEditor
                            value={workspaceNewGroupAvatarEmoji}
                            onChange={setWorkspaceNewGroupAvatarEmoji}
                            label="群头像"
                          />
                          <div className="workspace-picker-list" aria-label="选择群成员">
                            {workspaceSelectableMembers.length === 0 ? (
                              <p className="saved-empty">没有找到可添加的成员。</p>
                            ) : (
                              workspaceSelectableMembers.map((member) => (
                                <button
                                  className={workspaceGroupMemberIds.includes(member.id) ? "workspace-picker-row selected" : "workspace-picker-row"}
                                  type="button"
                                  key={member.id}
                                  onClick={() => toggleWorkspaceGroupMember(member.id)}
                                >
                                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                                  <span>
                                    <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                    <small>{workspaceMemberSecondaryText(member)}</small>
                                  </span>
                                  {workspaceGroupMemberIds.includes(member.id) && <Check size={17} />}
                                </button>
                              ))
                            )}
                          </div>
                          <div className="workspace-task-actions">
                            <span className="workspace-selection-count">已选 {workspaceGroupMemberIds.length} 位</span>
                            <button
                              className="secondary"
                              type="button"
                              onClick={closeWorkspaceCreate}
                            >
                              取消
                            </button>
                            <button className="primary" type="submit" disabled={workspaceGroupMemberIds.length === 0}>
                              <Plus size={17} />
                              创建群聊
                            </button>
                          </div>
                        </form>
                      )}
                      {workspaceCreateMode === "direct" && (
                        <div className="workspace-picker-list" aria-label="选择私聊成员">
                          {workspaceSelectableMembers.length === 0 ? (
                            <p className="saved-empty">没有找到可发起私聊的成员。</p>
                          ) : (
                            workspaceSelectableMembers.map((member) => (
                              <button
                                className="workspace-picker-row"
                                type="button"
                                key={member.id}
                                onClick={() => void createWorkspaceDirect(member.id)}
                              >
                                <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                                <span>
                                  <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                  <small>{workspaceMemberSecondaryText(member)}</small>
                                </span>
                                <MessageSquare size={17} />
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "chat" && (
                    workspaceSelectedConversation ? (
                      <WorkspaceChatPanel
                        scopeKey={workspaceSelectedConversationId}
                        autoHidePreferences={workspaceAutoHidePreferences}
                        title={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                        titleKind={workspaceSelectedConversation.otherMember?.kind}
                        avatar={
                          <WorkspaceConversationAvatar
                            conversation={workspaceSelectedConversation}
                            currentUserId={workspaceBootstrap.auth.currentUser.id}
                            className="small"
                          />
                        }
                        subtitle={workspaceSelectedConversation.type === "group"
                          ? `${workspaceConversationMemberCount(workspaceSelectedConversation)} 位成员`
                          : workspaceSelectedConversation.otherMember?.description || "私聊"}
                        leadingAction={
                          <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => navigateWorkspaceView("chat")}>
                            <ArrowLeft size={16} />
                          </button>
                        }
                        trailingAction={
                          <>
                            <button
                              className="icon-button desktop-only"
                              type="button"
                              title={workspaceContextVisible ? "收起详情" : "查看详情"}
                              onClick={() => {
                                setWorkspaceContextMode("conversation");
                                setWorkspaceContextCollapsed((collapsed) => !collapsed);
                              }}
                            >
                              <PanelRightOpen size={16} />
                            </button>
                            <button
                              className="secondary compact mobile-only"
                              type="button"
                              onClick={() => {
                                setWorkspaceContextMode("conversation");
                                setWorkspaceContextCollapsed(false);
                                setWorkspaceMobilePane("details");
                              }}
                            >
                              <PanelRightOpen size={16} />
                              详情
                            </button>
                          </>
                        }
                        messages={workspaceMessages}
                        messageListRef={workspaceMessageListRef}
                        onMessageListScroll={handleWorkspaceMessageListScroll}
                        onMessageListScrollIntent={registerWorkspaceMessageListScrollIntent}
                        olderMessagesAvailable={workspaceCanLoadOlderMessages}
                        olderMessagesLoading={workspaceHistoryLoading}
                        onLoadOlderMessages={() => void loadOlderWorkspaceMessages(workspaceSelectedConversation.id)}
                        unreadAnchorMessageId={workspaceUnreadAnchor?.messageId}
                        unreadAnchorCount={workspaceUnreadAnchor?.count ?? 0}
                        newMessageCount={workspaceNewMessageCount}
                        awayFromLatest={workspaceAwayFromLatest}
                        onJumpToLatest={jumpWorkspaceToLatest}
                        draft={workspaceDraft}
                        draftDocument={workspaceDraftDocument}
                        onDraft={(document) => setWorkspaceConversationDraft(workspaceSelectedConversation.id, document)}
                        onSend={sendWorkspaceMessage}
                        onSendImageEmote={sendWorkspaceImageEmote}
                        stagedAttachments={workspaceComposerAttachments}
                        onStageFiles={stageWorkspaceAttachments}
                        onRemoveStagedAttachment={(attachmentId) =>
                          void removeWorkspaceComposerAttachment(workspaceSelectedConversation.id, attachmentId)
                        }
                        onReply={(messageId) => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, messageId)}
                        onRetryMessage={(messageId) => void retryWorkspaceMessage(messageId)}
                        onCancelMessage={(messageId) => void cancelWorkspaceLocalMessage(messageId)}
                        replyTarget={workspaceReplyTarget}
                        onCancelReply={() => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, "")}
                        onOpenAttachment={openWorkspaceAttachmentFile}
                        onPreviewImage={setWorkspaceImagePreview}
                        onPreviewEmoteCollection={setWorkspaceEmoteCollectionPreviewId}
                        onOpenTopic={openWorkspaceTopic}
                        cardRevisionById={workspaceCardRevisionById}
                        onCopyMessage={(message) => {
                          void copyText(serializeWorkspaceMessageForCopy(message)).then((copied) =>
                            showWorkspaceNotice(copied ? "success" : "warning", copied ? "消息已复制" : "消息复制失败")
                          );
                        }}
                        onToggleReaction={(messageId, emoteKey) => void toggleWorkspaceReaction(messageId, emoteKey)}
                        onFavoriteEmote={(message) => void favoriteWorkspaceMessageEmote(message)}
                        reactionPendingKeys={workspaceReactionPendingKeys}
                        currentUserId={workspaceBootstrap.auth.currentUser.id}
                        conversationType={workspaceSelectedConversation.type}
                        historyTargetId={workspaceHistoryTargetId}
                        onJumpToMessage={(messageId) => void jumpToWorkspaceMessage(messageId)}
                        onReturnToLatest={() => void returnWorkspaceToLatest()}
                        onTogglePin={(message) => void toggleWorkspacePin(message)}
                        onRecall={(message) => void recallWorkspaceMessage(message)}
                        onHideMessage={(messageId) => void setWorkspaceMessagesHidden([messageId], true)}
                        onRestoreHiddenMessages={(messageIds) => void setWorkspaceMessagesHidden(messageIds, false)}
                        mentionMembers={workspaceSelectedConversation.type === "group"
                          ? workspaceSelectedConversation.members.filter(
                            (member) => member.id !== workspaceBootstrap.auth.currentUser.id
                          )
                          : []}
                        echoInteractionSlot={workspaceEchoInteractionByConversation[workspaceSelectedConversation.id]}
                        onEchoCommandAccepted={acceptWorkspaceEchoCommand}
                        onEchoWorkflowIdChange={(workflowId) => setWorkspaceEchoWorkflowId(workspaceSelectedConversation.id, workflowId)}
                        onDismissEchoInteraction={() => dismissWorkspaceEchoInteraction(workspaceSelectedConversation.id)}
                        fileInputDisabled={!workspaceBootstrap.permissions.canUpload}
                        onManageEmotes={openWorkspaceEmoteManager}
                        availableTopics={workspaceConversationTopicsById[workspaceSelectedConversation.id] ?? []}
                        onSelectTopic={(topic) => { if (topic) openWorkspaceTopic(topic.id); }}
                      />
                    ) : (
                      <div className="workspace-home-panel">
                        <div className="workspace-home-hero">
                          <span className="center-icon workspace-dev-bg" aria-hidden="true">
                            <MessageSquare size={28} />
                          </span>
                          <div>
                            <p className="workspace-panel-kicker">空间首页</p>
                            <h2>从成员或文件开始</h2>
                            <p>还没有会话。可以先发起私聊，也可以查看成员和共享文件。</p>
                          </div>
                        </div>
                        <div className="workspace-home-actions">
                          {workspaceBootstrap.permissions.canCreateDirect && (
                            <button className="primary" type="button" onClick={() => openWorkspaceCreate("direct")}>
                              <MessageSquare size={17} />
                              发起私聊
                            </button>
                          )}
                          {workspaceBootstrap.permissions.canCreateGroup && (
                            <button className="secondary" type="button" onClick={() => openWorkspaceCreate("group")}>
                              <UsersRound size={17} />
                              创建群聊
                            </button>
                          )}
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("members");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <UsersRound size={17} />
                            查看成员
                          </button>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceView("files");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <FileCheck2 size={17} />
                            共享文件
                          </button>
                        </div>
                        <div className="workspace-home-summary" aria-label="空间概览">
                          <div>
                            <span>成员</span>
                            <strong>{workspaceBootstrap.members.length} 位</strong>
                            <small>邀请加入</small>
                          </div>
                          <div>
                            <span>今日传输额度</span>
                            <strong>{workspaceRemainingText}</strong>
                            <small>{workspaceQuotaDetailText}</small>
                          </div>
                          <div>
                            <span>消息保留</span>
                            <strong>最近 {workspaceBootstrap.policy.messageRetentionCount} 条</strong>
                            <small>按会话保留</small>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {!workspaceCreateMode && workspaceView === "topics" && (
                    <WorkspaceTopicPage
                      chatRuntime={{
                        renderChat: (props) => <WorkspaceChatPanel {...props}
                          autoHidePreferences={workspaceAutoHidePreferences}
                          onOpenAttachment={openWorkspaceAttachmentFile}
                          onPreviewImage={setWorkspaceImagePreview}
                          onPreviewEmoteCollection={setWorkspaceEmoteCollectionPreviewId}
                          onOpenTopic={openWorkspaceTopic}
                          cardRevisionById={workspaceCardRevisionById}
                          onCopyMessage={(message) => { void copyText(serializeWorkspaceMessageForCopy(message)).then((copied) => showWorkspaceNotice(copied ? "success" : "warning", copied ? "消息已复制" : "消息复制失败")); }}
                          onFavoriteEmote={(message) => void favoriteWorkspaceMessageEmote(message)}
                          onManageEmotes={openWorkspaceEmoteManager}
                        />,
                        stagedAttachments: workspaceComposerAttachmentsByConversation[`topic:${workspaceSelectedTopicId}`] ?? [],
                        canUpload: workspaceBootstrap.permissions.canUpload,
                        replyAutoMention: workspaceReplyAutoMention,
                        stageFiles: (files) => stageWorkspaceAttachments(files, `topic:${workspaceSelectedTopicId}`),
                        removeStagedAttachment: (id) => { void removeWorkspaceComposerAttachment(`topic:${workspaceSelectedTopicId}`, id); },
                        takeStagedAttachments: () => updateWorkspaceComposerAttachments(`topic:${workspaceSelectedTopicId}`, () => []),
                        uploadAttachments: (conversationId, attachments, update, shouldCancel) => uploadWorkspaceComposerAttachments(conversationId, attachments, update, "private_staging", shouldCancel),
                        cancelUploads: (attachments) => { attachments.forEach((attachment) => workspaceUploadControllersRef.current.get(attachment.id)?.abort()); },
                        removeUploadedAttachments: removeWorkspaceUploadedAttachments,
                        submitMessage: submitWorkspaceMessage
                      }}
                      locateMessageId={workspaceTopicLocateRequest?.topicId === workspaceSelectedTopicId ? workspaceTopicLocateRequest.messageId : undefined}
                      onLocateHandled={() => setWorkspaceTopicLocateRequest((current) => current === workspaceTopicLocateRequest ? null : current)}
                      sessionStore={workspaceTopicSessionStore}
                      autoHidePreferences={workspaceAutoHidePreferences}
                      topicId={workspaceSelectedTopicId}
                      currentUserId={workspaceBootstrap.auth.currentUser.id}
                      currentUserDisplayName={workspaceBootstrap.auth.currentUser.displayName}
                      currentUserRole={workspaceBootstrap.auth.currentUser.role}
                      conversations={workspaceConversations
                        .filter((conversation) => conversation.type === "group")
                        .map((conversation) => ({
                          id: conversation.id,
                          title: workspaceConversationTitle(conversation, workspaceBootstrap.auth.currentUser.id)
                        }))}
                      refreshSignal={workspaceTopicRefreshSignal}
                      documentVisible={documentVisible}
                      onBack={() => {
                        setWorkspaceSelectedTopicId("");
                        navigateAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "topics" }));
                        setWorkspaceMobilePane("list");
                      }}
                      onOpenConversation={(conversationId) => selectWorkspaceConversation(conversationId)}
                      onNotice={showWorkspaceNotice}
                    />
                  )}

                  {!workspaceCreateMode && workspaceView === "files" && (
                    <div className="workspace-content-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => navigateWorkspaceView("chat")}>
                          <ArrowLeft size={16} />
                        </button>
                        <h2>共享文件</h2>
                        <label
                          className={workspaceUploading || !workspaceBootstrap.permissions.canUpload ? "file-button disabled" : "file-button"}
                          title={workspaceUploading ? "上传中" : "上传文件"}
                        >
                          <FileUp size={17} />
                          <input
                            type="file"
                            aria-label={workspaceUploading ? "上传中" : "上传文件"}
                            disabled={workspaceUploading || !workspaceBootstrap.permissions.canUpload}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              if (file) {
                                void uploadWorkspaceFile(file, "space");
                                event.currentTarget.value = "";
                              }
                            }}
                          />
                        </label>
                      </div>
                      <SegmentedControl className="dl-file-scope-control" label="文件筛选" hideLabel value={workspaceFileFilter} onValueChange={(value) => { if (value === "all" || value === "conversation" || value === "standalone" || value === "mine") setWorkspaceFileFilter(value); }} options={[
                        { value: "all", label: "全部" }, { value: "conversation", label: "会话文件" },
                        { value: "standalone", label: "独立文件" }, { value: "mine", label: "我上传的" }
                      ]} />
                      <div className="workspace-file-subnav">
                        <WorkspaceFileCategoryTabs value={workspaceFileCategory} onChange={setWorkspaceFileCategory} />
                        {workspaceFileCategory === "media" && (
                          <WorkspaceFileViewToggle value={workspaceFileViewMode} onChange={setWorkspaceFileViewMode} />
                        )}
                      </div>
                      <label className="workspace-search compact-search">
                        <span className="sr-only">查找文件</span>
                        <input
                          value={workspaceFileQuery}
                          onChange={(event) => setWorkspaceFileQuery(event.target.value)}
                          placeholder="文件名、上传者或会话"
                        />
                      </label>
                      <div className="workspace-file-browser">
                        <div ref={workspaceFileListRef} tabIndex={-1} aria-label="文件列表" className={workspaceFileCategory === "media" && workspaceFileViewMode === "grid"
                          ? "workspace-file-table media-grid"
                          : "workspace-file-table"}>
                          {workspaceFilteredFiles.length === 0 ? (
                            <p className="saved-empty">没有匹配的文件。</p>
                          ) : (
                            workspaceFilteredFiles.map((file) => {
                              const downloadReason = workspaceFileDownloadDisabledReason(file);
                              return (
                                <div
                                  className={[
                                    workspaceSelectedFileId === file.id ? "workspace-file-row active" : "workspace-file-row",
                                    "dl-file-object",
                                    workspaceFileCategory === "media" && workspaceFileViewMode === "grid" ? "media-card" : "",
                                    file.localUpload?.state ? `local-${file.localUpload.state}` : ""
                                  ].filter(Boolean).join(" ")}
                                  key={file.id}
                                >
                                  <button
                                    {...workspaceFileActions.bindObject(file.id)}
                                    data-object-action-root
                                    className="workspace-file-row-main"
                                    type="button"
                                    onClick={() => openWorkspaceFileDetails(file)}
                                  >
                                    <WorkspaceFileThumbnail file={file} large={workspaceFileCategory === "media" && workspaceFileViewMode === "grid"} />
                                    <span>
                                      <strong>{file.fileName}</strong>
                                      <small>
                                        {formatBytes(file.byteSize)} · {workspaceFileUploaderName(file)} · {workspaceFileScope(file, workspaceConversations)}
                                        {file.localUpload?.state === "failed" ? ` · ${file.localUpload.failureReason || "上传失败"}` : ""}
                                      </small>
                                    </span>
                                    <em>{workspaceFileVisibilityLabel(file)}</em>
                                  </button>
                                  <button
                                    className="icon-button workspace-file-download"
                                    type="button"
                                    title={downloadReason || "下载文件"}
                                    aria-label={`下载文件：${file.fileName}`}
                                    disabled={Boolean(downloadReason)}
                                    onClick={() => void reserveWorkspaceDownload(file)}
                                  >
                                    <Download size={16} />
                                  </button>
                                  <button className="dl-object-more" type="button" aria-label={`更多文件操作：${file.fileName}`} title="更多文件操作" aria-haspopup="menu" aria-expanded={workspaceFileActions.menuProps.open && workspaceFileActions.targetId === file.id} onClick={(event) => workspaceFileActions.openFromTrigger(file.id, event.currentTarget)}><Ellipsis size={18} /></button>
                                </div>
                              );
                            })
                          )}
                          {workspaceActionFile && <ObjectActionMenu {...workspaceFileActions.menuProps} label="文件操作" summary={workspaceActionFile.fileName} actions={workspaceFileMenuActions(workspaceActionFile)} />}
                        </div>
                      </div>
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "members" && (
                    <div className="workspace-content-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => navigateWorkspaceView("chat")}>
                          <ArrowLeft size={16} />
                        </button>
                        <h2>{workspaceBootstrap.auth.currentUser.role === "owner" ? "空间成员" : "可联系成员"}</h2>
                        {workspaceBootstrap.permissions.canCreateMemberInvite && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => {
                              navigateWorkspaceSpaceTab("invites");
                              setWorkspaceMobilePane("main");
                            }}
                          >
                            <Plus size={17} />
                            邀请成员
                          </button>
                        )}
                      </div>
                      <label className="workspace-search">
                        <span className="sr-only">查找成员</span>
                        <input
                          value={workspaceMemberQuery}
                          onChange={(event) => setWorkspaceMemberQuery(event.target.value)}
                          placeholder="输入昵称或 GitHub 登录名"
                        />
                      </label>

                      <div className="workspace-member-toolbar">
                        <div
                          className={workspaceMemberFilterOpen ? "workspace-member-filter open" : "workspace-member-filter"}
                          ref={workspaceMemberFilterRef}
                        >
                          <button
                            ref={workspaceMemberFilterTriggerRef}
                            id="workspace-member-filter-trigger"
                            type="button"
                            aria-haspopup="dialog"
                            aria-expanded={workspaceMemberFilterOpen}
                            aria-controls="workspace-member-filter-menu"
                            onClick={() => {
                              setWorkspaceCreateMenuOpen(false);
                              setWorkspaceUserMenuOpen(false);
                              setWorkspaceMemberFilterOpen((open) => !open);
                            }}
                          >
                            <Settings size={15} />
                            筛选
                            <ChevronDown size={14} />
                          </button>
                          {workspaceMemberFilterOpen && (
                            <div
                              className="workspace-member-filter-menu"
                              id="workspace-member-filter-menu"
                              role="dialog"
                              aria-label="成员筛选"
                            >
                              {workspaceBootstrap.auth.currentUser.role === "owner" && (
                                <div className="workspace-member-filter-roles" role="menu" aria-label="按角色筛选" onKeyDown={handleMenuKeyDown}>
                                  <span>角色</span>
                                  {[
                                    { id: "all" as const, label: "全部角色" },
                                    { id: "owner" as const, label: "主人" },
                                    { id: "admin" as const, label: "管理员" },
                                    { id: "member" as const, label: "成员" },
                                    { id: "auditor" as const, label: "预留角色", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite }
                                  ].filter((filter) => filter.id !== "auditor" || filter.visible).map((filter) => (
                                    <button
                                      role="menuitemradio"
                                      aria-checked={workspaceMemberRoleFilter === filter.id}
                                      tabIndex={workspaceMemberRoleFilter === filter.id ? 0 : -1}
                                      type="button"
                                      key={filter.id}
                                      onClick={() => setWorkspaceMemberRoleFilter(filter.id)}
                                    >
                                      <span className="workspace-filter-check" aria-hidden="true">
                                        {workspaceMemberRoleFilter === filter.id && <Check size={14} />}
                                      </span>
                                      <span>{filter.label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                              <SegmentedControl label="按类型筛选" value={workspaceMemberKindFilter} onValueChange={(value) => {
                                if (value === "all" || value === "human" || value === "bot" || value === "system") setWorkspaceMemberKindFilter(value);
                              }} options={[
                                { value: "all", label: "全部", accessibleLabel: "全部类型" },
                                { value: "human", label: "成员" },
                                { value: "bot", label: "机器人" },
                                { value: "system", label: "系统" }
                              ]} />
                            </div>
                          )}
                        </div>
                        <span>
                          {workspaceFilteredMembers.length} {workspaceBootstrap.auth.currentUser.role === "owner" ? "位成员" : "位联系人"}
                        </span>
                      </div>
                      <div className="workspace-member-grid" role="list" ref={workspaceMemberListRef} tabIndex={-1} aria-label="成员列表">
                        {workspaceFilteredMembers.length === 0 ? (
                          <p className="saved-empty">没有找到匹配的成员。</p>
                        ) : (
                          workspaceFilteredMembers.map((member) => (
                          <article className="workspace-member-card dl-member-object" role="listitem" key={member.id}>
                            <button
                              {...workspaceMemberActions.bindObject(member.id)}
                              data-object-action-root
                              className="workspace-member-main"
                              type="button"
                              onClick={() => openWorkspaceMemberDetails(member)}
                            >
                              <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
                              <span>
                                <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                <small>{workspaceMemberSecondaryText(member)}</small>
                              </span>
                            </button>
                            {member.id !== workspaceBootstrap.auth.currentUser.id &&
                              workspaceBootstrap.permissions.canCreateDirect &&
                              member.capabilities?.canStartDirectConversation === true && (
                              <button
                                className="icon-button"
                                type="button"
                                title={`与 ${member.displayName} 私聊`}
                                onClick={() => void createWorkspaceDirect(member.id)}
                              >
                                <MessageSquare size={15} />
                              </button>
                            )}
                            <button className="dl-object-more" type="button" aria-label={`更多成员操作：${member.displayName}`} title="更多成员操作" aria-haspopup="menu" aria-expanded={workspaceMemberActions.menuProps.open && workspaceMemberActions.targetId === member.id} onClick={(event) => workspaceMemberActions.openFromTrigger(member.id, event.currentTarget)}><Ellipsis size={18} /></button>
                          </article>
                          ))
                        )}
                        {workspaceActionMember && <ObjectActionMenu {...workspaceMemberActions.menuProps} label="成员操作" summary={workspaceActionMember.displayName} actions={[
                          { id: "details", label: "查看成员详情", icon: <UserRound size={17} />, onSelect: () => openWorkspaceMemberDetails(workspaceActionMember) },
                          ...(workspaceActionMember.id !== workspaceBootstrap.auth.currentUser.id && workspaceBootstrap.permissions.canCreateDirect && workspaceActionMember.capabilities?.canStartDirectConversation === true
                            ? [{ id: "direct", label: "发起私聊", icon: <MessageSquare size={17} />, onSelect: () => void createWorkspaceDirect(workspaceActionMember.id) }]
                            : [])
                        ]} />}
                      </div>
                    </div>
                  )}

                  {!workspaceCreateMode && workspaceView === "account" && (
                    workspaceSharedEmoteCollectionId ? (
                      <WorkspaceSharedEmoteCollectionPage
                        shareId={workspaceSharedEmoteCollectionId}
                        onBack={() => navigateAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "account" }))}
                        onNotice={showWorkspaceNotice}
                      />
                    ) : workspaceAccountSection === "bot" ? (
                      <SettingsLayout section="bot" currentUser={workspaceBootstrap.auth.currentUser} onNavigate={navigateWorkspaceAccountSection} onBack={() => navigateWorkspaceView("chat")} onLogout={() => void logoutWorkspace()}>
                      <WorkspaceBotSettings embedded
                        registerNavigationGuard={registerSettingsGuard}
                        onBack={() => navigateWorkspaceAccountSection("")}
                        onNotice={showWorkspaceNotice}
                        setupSessionId={workspaceSetupSessionId}
                      />
                      </SettingsLayout>
                    ) : (
                      <>
                        <WorkspaceAccountSettings
                          key={workspaceBootstrap.auth.currentUser.id}
                          services={{ json: workspaceJson, fetch: workspaceFetch, loadEmoteLibrary: loadWorkspaceEmoteLibrary, copyText }}
                          registerNavigationGuard={registerSettingsGuard}
                          onChatSettingsUpdated={(userId, settings) => {
                            if (userId !== workspaceCurrentUserIdRef.current) return;
                            setWorkspaceChatSettings({ userId, preferences: normalizeAutoHidePreferences(settings), replyAutoMention: Boolean(settings.replyAutoMention) });
                            setWorkspaceChatSettingsRevision((revision) => revision + 1);
                          }}
                          currentUser={workspaceBootstrap.auth.currentUser}
                          section={workspaceAccountSection}
                          onBack={() => navigateWorkspaceView("chat")}
                          onNavigate={navigateWorkspaceAccountSection}
                          onUserUpdated={upsertWorkspaceMember}
                          onNotice={showWorkspaceNotice}
                          onManageEmotes={openWorkspaceEmoteManager}
                          onLogout={() => void logoutWorkspace()}
                        />
                      </>
                    )
                  )}

                  {!workspaceCreateMode && workspaceView === "space" && (
                    <div className="workspace-content-panel workspace-space-panel">
                      <div className="workspace-panel-header">
                        <button className="icon-button mobile-only" type="button" title="返回会话列表" onClick={() => navigateWorkspaceView("chat")}>
                          <ArrowLeft size={16} />
                        </button>
                        <div>
                          <p className="eyebrow">空间</p>
                          <h2>空间信息</h2>
                        </div>
                      </div>
                      <div
                        className="workspace-context-tabs space-tabs"
                        role="tablist"
                        aria-label="空间设置"
                        onKeyDown={handleTabListKeyDown}
                      >
                        {[
                          { id: "overview" as const, label: "概览", visible: true },
                          { id: "invites" as const, label: "邀请", visible: workspaceBootstrap.permissions.canCreateMemberInvite },
                          { id: "roles" as const, label: "权限", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite },
                          { id: "visibility" as const, label: "可见范围", visible: workspaceBootstrap.permissions.canManageMemberVisibility },
                          { id: "email" as const, label: "邮件", visible: workspaceBootstrap.permissions.canManageEmailSettings },
                          { id: "requirements" as const, label: "需求", visible: workspaceBootstrap.auth.currentUser.role === "owner" }
                        ].filter((tab) => tab.visible).map((tab) => (
                          <button
                            className={workspaceSpaceTab === tab.id ? "active" : ""}
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={workspaceSpaceTab === tab.id}
                            tabIndex={workspaceSpaceTab === tab.id ? 0 : -1}
                            id={`workspace-space-tab-${tab.id}`}
                            aria-controls={`workspace-space-panel-${tab.id}`}
                            onClick={() => navigateWorkspaceSpaceTab(tab.id)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      {workspaceSpaceTab === "overview" && (
                        <div
                          className="workspace-space-tab-panel page-enter"
                          id="workspace-space-panel-overview"
                          role="tabpanel"
                          aria-labelledby="workspace-space-tab-overview"
                        >
                          <div className="workspace-info-grid">
                            <div>
                              <span>当前身份</span>
                              <strong>{workspaceRoleLabel(workspaceBootstrap.auth.currentUser.role)}</strong>
                              <small>{workspaceBootstrap.auth.currentUser.githubLogin}</small>
                            </div>
                            <div>
                              <span>{workspaceBootstrap.auth.currentUser.role === "owner" ? "成员" : "可见联系人"}</span>
                              <strong>{workspaceBootstrap.members.length} 位</strong>
                              <small>{workspaceBootstrap.auth.currentUser.role === "owner" ? "邀请加入" : "私聊及授权范围"}</small>
                            </div>
                            <div>
                              <span>今日传输额度</span>
                              <strong>{workspaceRemainingText}</strong>
                              <small>{workspaceQuotaDetailText}</small>
                            </div>
                            <div>
                              <span>消息保留</span>
                              <strong>最近 {workspaceBootstrap.policy.messageRetentionCount} 条</strong>
                              <small>按会话保留</small>
                            </div>
                          </div>
                          {workspaceBootstrap.auth.currentUser.role === "owner" && (
                            <section
                              className="workspace-system-statistics"
                              aria-labelledby="workspace-system-statistics-title"
                              aria-busy={workspaceStatisticsLoading}
                            >
                              <div className="workspace-statistics-header">
                                <div>
                                  <h3 id="workspace-system-statistics-title">系统统计</h3>
                                  <p>累计总量与今日新增</p>
                                </div>
                                {workspaceStatisticsError && (
                                  <button className="secondary compact" type="button" onClick={() => void refreshWorkspaceStatistics()}>
                                    重试
                                  </button>
                                )}
                              </div>
                              {workspaceStatistics ? (
                                <div className="workspace-statistics-grid" title={`统计截至 ${formatWorkspaceTime(workspaceStatistics.asOf)}`}>
                                  {[
                                    {
                                      label: "成员",
                                      total: `${workspaceStatistics.totals.members.toLocaleString("zh-CN")} 位`,
                                      today: `今日 +${workspaceStatistics.today.members.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "会话",
                                      total: workspaceStatistics.totals.conversations.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.conversations.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "消息",
                                      total: workspaceStatistics.totals.messages.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.messages.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "文件",
                                      total: workspaceStatistics.totals.files.toLocaleString("zh-CN"),
                                      today: `今日 +${workspaceStatistics.today.files.toLocaleString("zh-CN")}`
                                    },
                                    {
                                      label: "上传量",
                                      total: formatBytes(workspaceStatistics.totals.uploadedBytes),
                                      today: `今日 +${formatBytes(workspaceStatistics.today.uploadedBytes)}`
                                    }
                                  ].map((metric) => (
                                    <div key={metric.label}>
                                      <span>{metric.label}</span>
                                      <strong>{metric.total}</strong>
                                      <small>{metric.today}</small>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className={workspaceStatisticsError ? "workspace-statistics-status error" : "workspace-statistics-status"} role="status">
                                  {workspaceStatisticsError || "正在读取统计数据..."}
                                </p>
                              )}
                            </section>
                          )}
                          <p className="workspace-space-note">共享空间保存消息和文件，方便成员稍后查看。</p>
                        </div>
                      )}
                      {workspaceSpaceTab === "invites" && workspaceBootstrap.permissions.canCreateMemberInvite && (
                        <section className="workspace-settings-section workspace-space-tab-panel page-enter" id="workspace-space-panel-invites" role="tabpanel" aria-labelledby="workspace-space-tab-invites">
                          <div className="workspace-section-header">
                            <div>
                              <h3>邀请成员</h3>
                              <p>创建一次性成员邀请，并查看每条邀请的使用情况。</p>
                            </div>
                            <button className="secondary" type="button" onClick={() => void createWorkspaceInvite()}>
                              <Plus size={17} />
                              创建成员邀请
                            </button>
                          </div>
                          {workspaceInviteCode && (
                            <div className="copy-box compact-copy">
                              <span>{workspaceInviteCode}</span>
                              <button className="secondary compact" type="button" onClick={() => void copyWorkspaceInviteLink(workspaceInviteCode)}>
                                <Clipboard size={15} />
                                复制
                              </button>
                            </div>
                          )}
                          <dl className="workspace-invite-summary" aria-label="邀请统计">
                            {[
                              ["有效邀请", workspaceBootstrap.inviteSummary.active],
                              ["已加入", workspaceBootstrap.inviteSummary.acceptedUses],
                              ["剩余名额", workspaceBootstrap.inviteSummary.availableUses],
                              ["历史邀请", workspaceBootstrap.inviteSummary.history]
                            ].map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                          {workspaceBootstrap.invites.length > 0 ? (() => {
                            const activeInvites = workspaceBootstrap.invites.filter(canRevokeWorkspaceInvite);
                            const historyInvites = workspaceBootstrap.invites.filter((invite) => !canRevokeWorkspaceInvite(invite));
                            return (
                              <div className="workspace-invite-groups">
                                <section className="workspace-invite-group" aria-labelledby="workspace-active-invites-title">
                                  <div className="workspace-invite-group-heading">
                                    <h4 id="workspace-active-invites-title">有效邀请</h4>
                                    <span>{activeInvites.length}</span>
                                  </div>
                                  {activeInvites.length > 0 ? (
                                    <div className="workspace-invite-list">
                                      {activeInvites.map((invite) => (
                                        <WorkspaceInviteRow invite={invite} key={invite.id} onRevoke={(item) => void revokeWorkspaceInvite(item)} />
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="saved-empty">当前没有生效中的邀请。</p>
                                  )}
                                </section>
                                {historyInvites.length > 0 && (
                                  <details className="workspace-invite-history">
                                    <summary>
                                      <span>历史邀请</span>
                                      <small>{historyInvites.length} 条</small>
                                      <ChevronDown size={16} aria-hidden="true" />
                                    </summary>
                                    <div className="workspace-invite-list">
                                      {historyInvites.map((invite) => (
                                        <WorkspaceInviteRow invite={invite} key={invite.id} onRevoke={(item) => void revokeWorkspaceInvite(item)} />
                                      ))}
                                    </div>
                                  </details>
                                )}
                              </div>
                            );
                          })() : (
                            <p className="saved-empty">还没有邀请记录。</p>
                          )}
                        </section>
                      )}
                      {workspaceSpaceTab === "roles" && workspaceBootstrap.permissions.canCreatePrivilegedInvite && (
                        <section className="workspace-settings-section workspace-space-tab-panel page-enter" id="workspace-space-panel-roles" role="tabpanel" aria-labelledby="workspace-space-tab-roles">
                          <div className="section-title">
                            <span>成员权限</span>
                          </div>
                          <label className="workspace-search"><span className="sr-only">查找需要管理的成员</span><input type="search" value={workspaceRoleMemberQuery} onChange={(event) => setWorkspaceRoleMemberQuery(event.currentTarget.value)} placeholder="查找姓名或 GitHub 账号" /></label>
                          <div className="workspace-role-list">
                            {workspaceRoleMembers.length === 0 && <p className="saved-empty">没有找到匹配的成员。</p>}
                            {workspaceRoleMembers.map((member) => (
                              <div className="workspace-role-row" key={member.id}>
                                <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                <span>
                                  <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                  <small>{workspaceMemberSecondaryText(member)}</small>
                                </span>
                                {member.id === workspaceBootstrap.auth.currentUser.id ? (
                                  <em>当前账号</em>
                                ) : member.capabilities?.canManage === false ? (
                                  <em>系统维护</em>
                                ) : (
                                  <span className="workspace-role-actions">
                                    <SegmentedControl label="角色" value={member.role} onValueChange={(value) => void updateWorkspaceMemberRole(member, value as WorkspaceUser["role"])} options={WORKSPACE_ROLE_OPTIONS.filter((role) => role !== "auditor" || workspaceBootstrap.permissions.canCreatePrivilegedInvite).map((role) => ({ value: role, label: workspaceRoleLabel(role) }))} />
                                    <button className="secondary compact danger-action" type="button" onClick={() => void removeWorkspaceMember(member)}>
                                      移出
                                    </button>
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {workspaceSpaceTab === "visibility" && workspaceBootstrap.permissions.canManageMemberVisibility && (
                        <section className="workspace-settings-section workspace-visibility-settings workspace-space-tab-panel page-enter" id="workspace-space-panel-visibility" role="tabpanel" aria-labelledby="workspace-space-tab-visibility">
                          <div className="workspace-section-header">
                            <div className="section-title">
                              <span>成员可见范围</span>
                            </div>
                            <button
                              className="primary compact"
                              type="button"
                              disabled={!workspaceMemberVisibility || workspaceVisibilityLoading || workspaceVisibilitySaving}
                              onClick={() => void saveWorkspaceMemberVisibility()}
                            >
                              {workspaceVisibilitySaving ? "保存中" : "保存"}
                            </button>
                          </div>
                          {workspaceVisibilityViewers.length === 0 ? (
                            <p className="saved-empty">当前没有可配置的成员。</p>
                          ) : (
                            <>
                              <Select className="workspace-visibility-viewer" label="查看者" value={workspaceVisibilityViewerId} disabled={workspaceVisibilitySaving} onValueChange={selectWorkspaceVisibilityViewer} options={workspaceVisibilityViewers.map((member) => ({ value: member.id, label: member.displayName + " · " + workspaceMemberRoleLabel(member) }))} />
                              <label className="workspace-search"><span className="sr-only">查找可见范围中的成员</span><input type="search" value={workspaceVisibilityMemberQuery} onChange={(event) => setWorkspaceVisibilityMemberQuery(event.currentTarget.value)} placeholder="在成员范围中查找" /></label>
                              <div className="workspace-visibility-list" aria-busy={workspaceVisibilityLoading}>
                                {workspaceVisibilityLoading || !workspaceMemberVisibility ? (
                                  <p className="saved-empty">正在加载可见范围。</p>
                                ) : (
                                  workspaceVisibilityMembers.length === 0 ? <p className="saved-empty">没有找到匹配的成员。</p> : workspaceVisibilityMembers.map((member) => {
                                      const automatic = workspaceMemberVisibility.automaticUserIds.includes(member.id);
                                      const granted = workspaceMemberVisibility.grantedUserIds.includes(member.id);
                                      return (
                                        <label className="workspace-visibility-row" key={member.id}>
                                          <input
                                            type="checkbox"
                                            checked={automatic || granted}
                                            disabled={automatic || workspaceVisibilitySaving}
                                            onChange={() => toggleWorkspaceVisibilityGrant(member.id)}
                                          />
                                          <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                          <span>
                                            <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                            <small>
                                              {member.description || (automatic ? "已有私聊" : granted ? "已授权" : workspaceMemberSecondaryText(member))}
                                            </small>
                                          </span>
                                        </label>
                                      );
                                    })
                                )}
                              </div>
                            </>
                          )}
                        </section>
                      )}
                      {workspaceSpaceTab === "email" && workspaceBootstrap.permissions.canManageEmailSettings && (
                        <div className="workspace-space-tab-panel page-enter" id="workspace-space-panel-email" role="tabpanel" aria-labelledby="workspace-space-tab-email">
                          <WorkspaceEmailSettingsPanel onNotice={showWorkspaceNotice} services={{ json: workspaceJson }} />
                        </div>
                      )}
                      {workspaceSpaceTab === "requirements" && workspaceBootstrap.auth.currentUser.role === "owner" && (
                        <div className="workspace-space-tab-panel workspace-requirements-panel page-enter" id="workspace-space-panel-requirements" role="tabpanel" aria-labelledby="workspace-space-tab-requirements">
                          <WorkspaceEchoRequirements
                            onBack={() => navigateWorkspaceSpaceTab("overview")}
                            onNotice={showWorkspaceNotice}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {workspaceContextVisible && (
                <WorkspaceContextDrawer label={workspaceContextMode === "file" ? "文件详情" : workspaceContextMode === "member" ? "成员详情" : "当前会话详情"}>
                  <div className="workspace-context-header">
                    <button
                      className="icon-button mobile-only"
                      type="button"
                      title={workspaceContextMode === "file" ? "返回文件" : workspaceContextMode === "member" ? "返回成员" : "返回聊天"}
                      onClick={() => setWorkspaceMobilePane("main")}
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <div className="workspace-context-title">
                      <strong>
                        {workspaceContextMode === "file"
                          ? "文件信息"
                          : workspaceContextMode === "member"
                          ? "成员资料"
                          : workspaceSelectedConversation
                          ? "会话详情"
                          : "空间概览"}
                      </strong>
                    </div>
                    <button className="icon-button desktop-only" type="button" title="收起详情" onClick={() => setWorkspaceContextCollapsed(true)}>
                      <X size={16} />
                    </button>
                  </div>
                  {workspaceContextMode === "file" ? (
                    <div className="workspace-context-body" key={`file-${workspaceSelectedFile?.id ?? "none"}`}>
                      {workspaceSelectedFile ? (
                        <>
                          <div className="workspace-file-detail-head">
                            <FileCheck2 size={22} />
                            <div>
                              <strong title={workspaceSelectedFile.fileName}>{workspaceSelectedFile.fileName}</strong>
                              <small>{workspaceFileScope(workspaceSelectedFile, workspaceConversations)}</small>
                            </div>
                          </div>
                          <div className="workspace-info-grid compact-info">
                            <div>
                              <span>大小</span>
                              <strong>{formatBytes(workspaceSelectedFile.byteSize)}</strong>
                            </div>
                            <div>
                              <span>上传者</span>
                              <strong>{workspaceFileUploaderName(workspaceSelectedFile)}</strong>
                            </div>
                            <div>
                              <span>可见范围</span>
                              <strong>{workspaceFileVisibilityLabel(workspaceSelectedFile)}</strong>
                            </div>
                            {workspaceSelectedFileConversation && (
                              <div>
                                <span>所属会话</span>
                                <strong>{workspaceConversationTitle(workspaceSelectedFileConversation, workspaceBootstrap.auth.currentUser.id)}</strong>
                              </div>
                            )}
                            <div>
                              <span>状态</span>
                              <strong>
                                {workspaceSelectedFile.localUpload?.state === "uploading"
                                  ? "上传中"
                                  : workspaceSelectedFile.localUpload?.state === "failed"
                                  ? "上传失败"
                                  : workspaceSelectedFile.status === "available"
                                  ? "可下载"
                                  : workspaceSelectedFile.status}
                              </strong>
                            </div>
                          </div>
                          <div className="workspace-file-actions">
                            {workspaceSelectedFile.localUpload?.state === "failed" && (
                              <div className="notice warning compact-notice">
                                {workspaceSelectedFile.localUpload.failureReason || "文件上传失败，可以重试。"}
                              </div>
                            )}
                            {workspaceSelectedFileQuotaWarning && (
                              <div className="notice warning compact-notice">
                                {workspaceSelectedFileQuotaWarning}
                              </div>
                            )}
                            {workspaceSelectedFile.localUpload?.state === "failed" ? (
                              <>
                                <button className="primary" type="button" onClick={() => void retryWorkspaceFileUpload(workspaceSelectedFile)}>
                                  <RefreshCw size={17} />
                                  重新上传
                                </button>
                                <button className="secondary danger-action" type="button" onClick={() => removeWorkspaceLocalFile(workspaceSelectedFile)}>
                                  <Trash2 size={17} />
                                  移除记录
                                </button>
                              </>
                            ) : (
                              <button
                                className="primary"
                                type="button"
                                disabled={
                                  !workspaceBootstrap.permissions.canDownload ||
                                  Boolean(workspaceSelectedFileQuotaWarning) ||
                                  workspaceSelectedFile.status !== "available"
                                }
                                onClick={() => void reserveWorkspaceDownload(workspaceSelectedFile)}
                              >
                                <Download size={17} />
                                下载文件
                              </button>
                            )}
                            {workspaceSelectedFileConversation && (
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => {
                                  selectWorkspaceConversation(workspaceSelectedFileConversation.id);
                                  setWorkspaceContextMode("conversation");
                                  setWorkspaceContextCollapsed(false);
                                  setWorkspaceContextTab("files");
                                  setWorkspaceMobilePane("main");
                                }}
                              >
                                <MessageSquare size={17} />
                                打开会话
                              </button>
                            )}
                            {!workspaceSelectedFile.localUpload && canRemoveWorkspaceFile(workspaceSelectedFile, workspaceBootstrap.auth.currentUser) && (
                              <button className="secondary danger-action" type="button" onClick={() => void removeWorkspaceFile(workspaceSelectedFile)}>
                                <Trash2 size={17} />
                                移除文件
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="saved-empty">选择文件后查看详情和下载操作。</p>
                      )}
                    </div>
                  ) : workspaceContextMode === "member" ? (
                    workspaceSelectedMember ? (
                      <WorkspaceMemberDetail
                        member={workspaceSelectedMember}
                        currentUserId={workspaceBootstrap.auth.currentUser.id}
                        canCreateDirect={workspaceBootstrap.permissions.canCreateDirect}
                        onMemberUpdated={upsertWorkspaceMember}
                        onStartDirect={(memberId) => void createWorkspaceDirect(memberId)}
                        onNotice={showWorkspaceNotice}
                      />
                    ) : (
                      <div className="workspace-context-body"><p className="saved-empty">选择成员后查看详情。</p></div>
                    )
                  ) : workspaceSelectedConversation ? (
                    <>
                      <div
                        className="workspace-context-tabs"
                        role="tablist"
                        aria-label="会话详情"
                        onKeyDown={handleTabListKeyDown}
                      >
                        {workspaceVisibleContextTabs.map((tab) => (
                          <button
                            className={workspaceContextTab === tab.id ? "active" : ""}
                            key={tab.id}
                            role="tab"
                            aria-selected={workspaceContextTab === tab.id}
                            id={`workspace-context-tab-${tab.id}`}
                            aria-controls={`workspace-context-panel-${tab.id}`}
                            tabIndex={workspaceContextTab === tab.id ? 0 : -1}
                            type="button"
                            onClick={() => setWorkspaceContextTab(tab.id)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      {workspaceContextTab === "overview" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-overview`} role="tabpanel" id="workspace-context-panel-overview" aria-labelledby="workspace-context-tab-overview">
                          <div className="workspace-context-profile">
                            <WorkspaceConversationAvatar
                              conversation={workspaceSelectedConversation}
                              currentUserId={workspaceBootstrap.auth.currentUser.id}
                            />
                            <div>
                              <strong>
                                <WorkspaceIdentityName
                                  name={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                                  kind={workspaceSelectedConversation.otherMember?.kind}
                                />
                              </strong>
                              <small>
                                {workspaceSelectedConversation.type === "group"
                                  ? `${workspaceConversationMemberCount(workspaceSelectedConversation)} 位成员`
                                  : workspaceSelectedConversation.otherMember?.description || "私聊"}
                              </small>
                            </div>
                          </div>
                          <div className="workspace-context-summary">
                            <button type="button" onClick={() => setWorkspaceContextTab("files")}>
                              <span><FileCheck2 size={16} />共享文件</span>
                              <strong>{workspaceConversationFiles.length}</strong>
                            </button>
                            {workspaceSelectedConversation.type === "group" && (
                              <button type="button" onClick={() => setWorkspaceContextTab("members")}>
                                <span><UsersRound size={16} />群聊成员</span>
                                <strong>{workspaceConversationMemberCount(workspaceSelectedConversation)}</strong>
                              </button>
                            )}
                            <div>
                              <span><History size={16} />消息保留</span>
                              <strong>最近 {workspaceSelectedConversation.retentionCount} 条</strong>
                            </div>
                            <div>
                              <span><Radio size={16} />会话提醒</span>
                              <strong>{workspaceNotificationLevelLabel(workspaceSelectedConversation.notificationLevel)}</strong>
                            </div>
                          </div>
                          {workspaceSelectedConversation.type === "group" && (
                            <>
                            <section className="workspace-pinned-overview" aria-label="常驻消息">
                              <div className="workspace-context-section-header">
                                <span><Pin size={15} />常驻消息</span>
                                <span className="workspace-context-section-actions">
                                  <small>{workspacePinnedMessages.length} 条</small>
                                  {workspacePinnedMessages.length > 3 && (
                                    <button
                                      type="button"
                                      aria-expanded={workspacePinnedMessagesExpanded}
                                      onClick={() => setWorkspacePinsExpandedByConversation((current) => ({
                                        ...current,
                                        [workspaceSelectedConversation.id]: !workspacePinnedMessagesExpanded
                                      }))}
                                    >
                                      {workspacePinnedMessagesExpanded ? "收起" : "查看全部"}
                                    </button>
                                  )}
                                </span>
                              </div>
                              {workspacePinnedMessages.length === 0 ? (
                                <p className="saved-empty">群成员常驻的消息会显示在这里。</p>
                              ) : (
                                <div className="workspace-pinned-list">
                                  {(workspacePinnedMessagesExpanded ? workspacePinnedMessages : workspacePinnedMessages.slice(0, 3)).map((pin) => (
                                    <article key={pin.messageId}>
                                      <button type="button" onClick={() => { if (pin.message.topicId) openWorkspaceTopic(pin.message.topicId, pin.messageId); else void jumpToWorkspaceMessage(pin.messageId); }}>
                                        <strong>{pin.message.authorName || pin.message.authorGithubLogin || "成员"}</strong>
                                        <span>{pin.message.plainText || "附件消息"}</span>
                                        <small>{pin.message.topicId ? "话题消息 · " : ""}{formatWorkspaceTime(pin.pinnedAt)}</small>
                                      </button>
                                      {pin.canUnpin && (
                                        <button className="icon-button" type="button" title="取消常驻" onClick={() => void removeWorkspacePin(pin.messageId)}>
                                          <PinOff size={14} />
                                        </button>
                                      )}
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>
                            <button className="workspace-context-link" type="button" onClick={() => setWorkspaceContextTab("topics")}><Hash size={18} aria-hidden="true" /><span><strong>群聊话题</strong><small>查看讨论与创建话题</small></span><ChevronRight size={17} aria-hidden="true" /></button>
                            </>
                          )}
                        </div>
                      )}
                      {workspaceContextTab === "members" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-members`} role="tabpanel" id="workspace-context-panel-members" aria-labelledby="workspace-context-tab-members">
                          <div className="workspace-context-members-heading">
                            <div><h3>会话成员</h3><p>{workspaceConversationMemberCount(workspaceSelectedConversation)} 位成员</p></div>
                            {workspaceCanManageSelectedGroup && <button ref={workspaceMemberPickerTriggerRef} type="button" className="secondary" onClick={() => setWorkspaceMemberPickerOpen(true)}><Plus size={17} aria-hidden="true" />邀请成员</button>}
                          </div>
                          <label className="workspace-search compact-search">
                            <span>查找成员</span>
                            <input
                              value={workspaceContextMemberQuery}
                              onChange={(event) => setWorkspaceContextMemberQuery(event.target.value)}
                              placeholder="昵称、GitHub 或角色"
                            />
                          </label>
                          <div className="member-list" ref={workspaceGroupMemberListRef} tabIndex={-1} aria-label="群聊成员">
                            {workspaceConversationMembers.length === 0 ? (
                              <p className="saved-empty">没有找到匹配的群聊成员。</p>
                            ) : (
                              workspaceConversationMembers.map((member) => (
                                <div className="member context-member" key={member.id} tabIndex={workspaceActionableGroupMemberIds.includes(member.id) ? 0 : undefined} {...(workspaceActionableGroupMemberIds.includes(member.id) ? workspaceGroupMemberActions.bindObject(member.id) : {})}>
                                  <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
                                  <span>
                                    <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
                                    <small>{workspaceMemberSecondaryText(member)}</small>
                                  </span>
                                  {(member.id !== workspaceBootstrap.auth.currentUser.id &&
                                    ((workspaceBootstrap.permissions.canCreateDirect && member.capabilities?.canStartDirectConversation === true) ||
                                      (workspaceSelectedConversation.type === "group" && workspaceCanManageSelectedGroup))) && (
                                    <button className="icon-button" type="button" title={`更多成员操作：${member.displayName}`} aria-label={`更多成员操作：${member.displayName}`} aria-haspopup="menu" aria-expanded={workspaceGroupMemberActions.menuProps.open && workspaceGroupMemberActions.targetId === member.id} onClick={(event) => workspaceGroupMemberActions.openFromTrigger(member.id, event.currentTarget)}><Ellipsis size={18} aria-hidden="true" /></button>
                                  )}
                                </div>
                              ))
                            )}
                          </div>

                          {workspaceActionGroupMember && <ObjectActionMenu {...workspaceGroupMemberActions.menuProps} label="群聊成员操作" summary={workspaceActionGroupMember.displayName} actions={[
                            ...(workspaceActionGroupMember.id !== workspaceBootstrap.auth.currentUser.id && workspaceBootstrap.permissions.canCreateDirect && workspaceActionGroupMember.capabilities?.canStartDirectConversation === true ? [{ id: "direct", label: "发起私聊", icon: <MessageSquare size={17} />, onSelect: () => void createWorkspaceDirect(workspaceActionGroupMember.id) }] : []),
                            ...(workspaceActionGroupMember.id !== workspaceBootstrap.auth.currentUser.id && workspaceCanManageSelectedGroup ? [{ id: "remove", label: "移出群聊", icon: <UsersRound size={17} />, danger: true, disabled: workspaceGroupMemberBusyId === workspaceActionGroupMember.id, disabledReason: "正在处理", onSelect: () => void removeWorkspaceGroupMember(workspaceActionGroupMember.id) }] : [])
                          ]} />}

                        </div>
                      )}
                      {workspaceContextTab === "topics" && workspaceSelectedConversation.type === "group" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-topics`} role="tabpanel" id="workspace-context-panel-topics" aria-labelledby="workspace-context-tab-topics">
                          <WorkspaceConversationTopicsSection
                            registerNavigationGuard={registerSettingsGuard}
                            conversationId={workspaceSelectedConversation.id}
                            currentUserRole={workspaceBootstrap.auth.currentUser.role}
                            conversationTitle={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                            canCreate={workspaceSelectedConversation.capabilities?.canSendMessage !== false}
                            refreshSignal={workspaceTopicRefreshSignal}
                            onOpen={openWorkspaceTopic}
                          />
                        </div>
                      )}
                      {workspaceContextTab === "files" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-files`} role="tabpanel" id="workspace-context-panel-files" aria-labelledby="workspace-context-tab-files">
                          <div className="workspace-file-subnav context-file-subnav">
                            <WorkspaceFileCategoryTabs value={workspaceContextFileCategory} onChange={setWorkspaceContextFileCategory} />
                            {workspaceContextFileCategory === "media" && (
                              <WorkspaceFileViewToggle value={workspaceContextFileViewMode} onChange={setWorkspaceContextFileViewMode} />
                            )}
                          </div>
                          <div className={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"
                            ? "workspace-file-list media-grid"
                            : "workspace-file-list"}>
                            {workspaceFilteredConversationFiles.length === 0 ? (
                              <p className="saved-empty">此会话暂无文件。</p>
                            ) : (
                              workspaceFilteredConversationFiles.map((file) => (
                                <button
                                  className={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"
                                    ? "workspace-file media-card"
                                    : "workspace-file"}
                                  type="button"
                                  key={file.id}
                                  onClick={() => {
                                    setWorkspaceSelectedFileId(file.id);
                                    setWorkspaceView("files");
                                    writeAppRoute(workspaceRoute({ inviteCode: workspacePendingInviteCode, view: "files", fileId: file.id }));
                                    setWorkspaceContextMode("file");
                                    setWorkspaceContextCollapsed(false);
                                    setWorkspaceMobilePane("details");
                                  }}
                                >
                                  <WorkspaceFileThumbnail
                                    file={file}
                                    compact={workspaceContextFileViewMode !== "grid"}
                                    large={workspaceContextFileCategory === "media" && workspaceContextFileViewMode === "grid"}
                                  />
                                  <span>
                                    <strong>{file.fileName}</strong>
                                    <small>{formatBytes(file.byteSize)} · {workspaceFileUploaderName(file)}</small>
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                      {workspaceContextTab === "settings" && (
                        <div className="workspace-context-body" key={`conversation-${workspaceSelectedConversation.id}-settings`} role="tabpanel" id="workspace-context-panel-settings" aria-labelledby="workspace-context-tab-settings">
                          <p className="saved-empty">此会话保留最近 {workspaceSelectedConversation.retentionCount} 条消息。</p>
                          <div className="workspace-settings-section">
                            <div className="workspace-section-header">
                              <span>会话提醒</span>
                            </div>
                            <SegmentedControl label="会话提醒设置" hideLabel value={workspaceSelectedConversation.notificationLevel ?? "all"} onValueChange={(value) => { if (value === "all" || value === "mentions" || value === "muted") void updateWorkspaceConversationNotification(value); }} options={(["all", "mentions", "muted"] as const).map((value) => ({ value, label: workspaceNotificationLevelLabel(value) }))} />
                            <p className="saved-empty">
                              {workspaceNotificationLevelDescription(workspaceSelectedConversation.notificationLevel)}
                            </p>
                          </div>
                          {workspaceSelectedConversation.type === "group" ? (
                            <>
                              {workspaceCanManageSelectedGroup ? (
                                <form className="workspace-group-form" onSubmit={(event) => void renameWorkspaceGroup(event)}>
                                  <WorkspaceGroupAvatarEditor
                                    value={workspaceGroupAvatarEmoji}
                                    onChange={setWorkspaceGroupAvatarEmoji}
                                    label="群头像"
                                  />
                                  <label>
                                    <span>群聊名称</span>
                                    <input
                                      value={workspaceGroupRenameTitle}
                                      onChange={(event) => setWorkspaceGroupRenameTitle(event.target.value)}
                                      placeholder="输入群聊名称"
                                    />
                                  </label>
                                  <button
                                    className="secondary"
                                    type="submit"
                                    disabled={normalizeWorkspaceGroupAvatarEmoji(workspaceGroupAvatarEmoji) === null}
                                  >
                                    <Check size={16} />
                                    保存群资料
                                  </button>
                                  <p className="saved-empty">群聊成员管理在“成员”中进行。</p>
                                </form>
                              ) : (
                                <p className="saved-empty">群聊成员和名称由空间管理员维护。</p>
                              )}
                              <button className="secondary danger-action" type="button" onClick={() => void leaveWorkspaceGroup()}>
                                <LogOut size={16} />
                                离开群聊
                              </button>
                            </>
                          ) : (
                            <p className="saved-empty">私聊会复用同一对成员的会话。</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="workspace-context-body" key="conversation-none">
                      <p className="saved-empty">选择会话后可查看概览、成员和文件。</p>
                    </div>
                  )}
                </WorkspaceContextDrawer>
                )}
              </WorkspaceShell>
              {workspaceSelectedConversation && <MemberPickerDialog
                open={workspaceMemberPickerOpen && workspaceCanManageSelectedGroup}
                scopeKey={workspaceMemberPickerScope}
                groupName={workspaceConversationTitle(workspaceSelectedConversation, workspaceBootstrap.auth.currentUser.id)}
                candidates={workspaceAddableMembers.map((member) => ({ id: member.id, displayName: member.displayName, secondaryText: workspaceMemberSecondaryText(member), avatarUrl: member.avatarUrl }))}
                existingMemberIds={workspaceSelectedConversation.members.map((member) => member.id)}
                returnFocus={workspaceMemberPickerTriggerRef.current}
                onClose={() => setWorkspaceMemberPickerOpen(false)}
                onConfirm={inviteWorkspaceGroupMembers}
              />}

              {workspaceImagePreview && (
                <div
                  ref={workspaceImageViewerRef}
                  className="workspace-image-viewer"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="workspace-image-viewer-title"
                  aria-describedby="workspace-image-viewer-description"
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setWorkspaceImagePreview(null);
                  }}
                  onClick={(event) => {
                    if (event.currentTarget === event.target) setWorkspaceImagePreview(null);
                  }}
                >
                  <p className="sr-only" id="workspace-image-viewer-description">
                    图片预览，可缩放、下载图片或打开文件详情。
                  </p>
                  <div className="workspace-image-viewer-toolbar">
                    <strong id="workspace-image-viewer-title">{workspaceImagePreview.fileName}</strong>
                    <div>
                      <span className="workspace-image-zoom-controls" role="group" aria-label="图片缩放">
                        <button
                          className="icon-button"
                          type="button"
                          title="缩小图片"
                          aria-label="缩小图片"
                          disabled={workspaceImageZoom <= 1}
                          onClick={() => setWorkspaceImageZoom((zoom) => clampWorkspaceImageZoom(zoom - 0.25))}
                        >
                          <ZoomOut size={17} />
                        </button>
                        <button
                          className="workspace-image-zoom-value"
                          type="button"
                          title="恢复 100%"
                          onClick={() => setWorkspaceImageZoom(1)}
                        >
                          {Math.round(workspaceImageZoom * 100)}%
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="放大图片"
                          aria-label="放大图片"
                          disabled={workspaceImageZoom >= 4}
                          onClick={() => setWorkspaceImageZoom((zoom) => clampWorkspaceImageZoom(zoom + 0.25))}
                        >
                          <ZoomIn size={17} />
                        </button>
                      </span>
                      {workspaceImagePreviewFile && (
                        <>
                          <button
                            className="icon-button"
                            type="button"
                            title="下载图片"
                            onClick={() => void reserveWorkspaceDownload(workspaceImagePreviewFile)}
                          >
                            <Download size={17} />
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            title="查看文件详情"
                            onClick={() => {
                              setWorkspaceImagePreview(null);
                              openWorkspaceAttachmentFile(workspaceImagePreview);
                            }}
                          >
                            <FileCheck2 size={17} />
                          </button>
                        </>
                      )}
                      <button
                        ref={workspaceImageCloseButtonRef}
                        className="icon-button"
                        type="button"
                        title="关闭预览"
                        onClick={() => setWorkspaceImagePreview(null)}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="workspace-image-viewer-stage">
                    <div
                      className="workspace-image-viewer-canvas"
                      style={{
                        width: `${workspaceImageZoom * 100}%`,
                        height: `${workspaceImageZoom * 100}%`
                      }}
                    >
                      <img
                        src={`/api/workspace/files/${encodeURIComponent(workspaceImagePreview.id)}/preview`}
                        alt={workspaceImagePreview.fileName}
                        onDoubleClick={() => setWorkspaceImageZoom((zoom) => zoom === 1 ? 2 : 1)}
                      />
                    </div>
                  </div>
                </div>
              )}
              {workspaceEmoteManagerOpen && (
                <WorkspaceEmoteManagerDialog
                  key={workspaceBootstrap.auth.currentUser.id}
                  conversations={workspaceConversations}
                  onClose={closeWorkspaceEmoteManager}
                  onNotice={showWorkspaceNotice}
                  onSendShare={sendWorkspaceEmoteCollectionShare}
                />
              )}
              {workspaceEmoteCollectionPreviewId && (
                <WorkspaceSharedEmoteCollectionDialog
                  key={workspaceEmoteCollectionPreviewId}
                  shareId={workspaceEmoteCollectionPreviewId}
                  onClose={() => setWorkspaceEmoteCollectionPreviewId("")}
                  onNotice={showWorkspaceNotice}
                />
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}

function parsePeerMessage(raw: unknown): PeerSocketMessage | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      event?: string;
      peers?: Peer[];
      peerId?: string;
      from?: Peer;
      v?: number;
      channel?: SecureChannel;
      nonce?: string;
      ciphertext?: string;
    };

    if (parsed.type === "system") {
      if (parsed.event === "room-not-found") {
        return {
          author: "系统",
          body: "房间不存在或已过期，请重新创建。",
          systemEvent: "room-not-found"
        };
      }
      if (parsed.event === "room-full") {
        return {
          author: "系统",
          body: "房间已满，请重新创建。",
          systemEvent: "room-full"
        };
      }
      if (parsed.event === "joined") {
        return {
          author: "系统",
          body: parsed.peers && parsed.peers.length >= 2 ? "你已加入房间，正在建立连接。" : "你已进入房间，等待对方加入。",
          systemEvent: "joined",
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      if (parsed.event === "peer-joined") {
        return {
          author: "系统",
          body: "对方已加入房间，正在建立连接。",
          systemEvent: "peer-joined",
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-left") {
        return {
          author: "系统",
          body: "对方已离开房间。",
          systemEvent: "peer-left",
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-list") {
        return {
          author: "系统",
          systemEvent: "peer-list",
          peers: parsed.peers,
          peerId: parsed.peerId
        };
      }
      return parsed.event ? { author: "系统", body: parsed.event, peers: parsed.peers } : null;
    }

    if (parsed.type === "secure" && parsed.v === SECURE_ENVELOPE_VERSION && isSecureChannel(parsed.channel)) {
      return {
        author: "对方",
        peers: parsed.peers,
        from: parsed.from,
        secure: {
          type: "secure",
          v: SECURE_ENVELOPE_VERSION,
          channel: parsed.channel,
          nonce: String(parsed.nonce || ""),
          ciphertext: String(parsed.ciphertext || "")
        }
      };
    }

    return null;
  } catch {
    return null;
  }
}

function isSecureChannel(value: unknown): value is SecureChannel {
  return value === "signal" || value === "ws-chat" || value === "profile";
}

function resolvePeers(peers: Peer[] = [], profiles: Map<string, string>, selfPeerId: string, selfName: string) {
  return peers.map((peer) => ({
    id: peer.id,
    name: peer.id === selfPeerId ? selfName : profiles.get(peer.id) ?? "对方",
    self: peer.id === selfPeerId
  }));
}

function formatPeerName(peer: Peer) {
  return peer.self ? `你（${peer.name || "访客"}）` : peer.name || "对方";
}

function findRemotePeerId(peers: Peer[], selfPeerId: string) {
  return peers.find((peer) => peer.id !== selfPeerId)?.id ?? "";
}

function normalizeSignalPayload(value: unknown): SignalMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as SignalMessage & { type?: string };
  if (payload.type !== "signal" || !payload.signal) {
    return null;
  }
  return {
    signal: payload.signal,
    description: payload.description,
    candidate: payload.candidate
  };
}

function normalizeProfilePayload(value: unknown): PeerProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as { kind?: string; peerId?: string; name?: string };
  if (payload.kind !== "profile" || typeof payload.name !== "string") {
    return null;
  }
  return {
    kind: "profile",
    peerId: typeof payload.peerId === "string" ? payload.peerId : undefined,
    name: payload.name.trim().slice(0, 40) || "对方"
  };
}

function normalizeWsChatPayload(value: unknown): P2pMessageEnvelope | null {
  const envelope = parseDataEnvelopeValue(value);
  return envelope?.kind === "chat" || envelope?.kind === "chat-ack" ? envelope : null;
}

function WorkspaceSharedEmoteCollectionPage({
  shareId,
  onBack,
  onNotice,
  presentation = "page",
  closeButtonRef
}: {
  shareId: string;
  onBack: () => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
  presentation?: "page" | "dialog";
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [share, setShare] = useState<WorkspaceEmoteCollectionShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<"collection" | string | null>(null);
  const [importedEmoteIds, setImportedEmoteIds] = useState<string[]>([]);
  const [subscribeToSourceChanges, setSubscribeToSourceChanges] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setShare(null);
    setLoading(true);
    setImportedEmoteIds([]);
    setSubscribeToSourceChanges(false);
    void workspaceJson<{ share: WorkspaceEmoteCollectionShare }>(
      `/api/workspace/emote-collection-shares/${encodeURIComponent(shareId)}`
    ).then((data) => {
      if (!cancelled) setShare(data.share);
    }).catch((error) => {
      if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "表情合集暂时无法打开"));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [shareId]);

  async function importShare(emoteIds?: string[]) {
    if (!share || share.revokedAt) return;
    const action = emoteIds?.[0] || "collection";
    setImporting(action);
    try {
      await workspaceJson(`/api/workspace/emote-collection-shares/${encodeURIComponent(share.id)}/import`, {
        method: "POST",
        body: JSON.stringify(emoteIds
          ? { emoteIds, asCollection: false }
          : { asCollection: true, subscribeToSourceChanges })
      });
      notifyWorkspaceEmoteLibraryChanged();
      onNotice("success", emoteIds ? "表情已添加到我的收藏" : "表情合集已添加到我的表情");
      if (emoteIds) {
        setImportedEmoteIds((current) => [...new Set([...current, ...emoteIds])]);
      } else {
        onBack();
      }
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "导入表情失败"));
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className={presentation === "dialog" ? "workspace-shared-emote-page dialog" : "workspace-content-panel workspace-shared-emote-page"}>
      <header className="workspace-panel-header workspace-shared-emote-header">
        <div className="workspace-shared-emote-heading">
          {presentation === "page" && (
            <button className="icon-button" type="button" title="返回个人设置" aria-label="返回个人设置" onClick={onBack}>
              <ArrowLeft size={17} />
            </button>
          )}
          <div><p className="eyebrow">表情合集</p><h2>{loading ? "正在读取..." : share?.name || "合集分享"}</h2></div>
        </div>
        <div className="workspace-shared-emote-header-actions">
          {share && !share.revokedAt && (
            <button className="primary compact" type="button" disabled={importing !== null} onClick={() => void importShare()}>
              <Plus size={15} />
              {importing === "collection" ? "正在添加" : "添加整套"}
            </button>
          )}
          {presentation === "dialog" && (
            <button ref={closeButtonRef} className="icon-button" type="button" title="关闭预览" aria-label="关闭表情合集预览" onClick={onBack}>
              <X size={17} />
            </button>
          )}
        </div>
      </header>
      <div className="workspace-shared-emote-body">
        {share?.revokedAt ? (
          <div className="workspace-empty-state"><Images size={28} /><strong>合集已停止分享</strong><p>分享者已撤销该链接，已导入的表情不受影响。</p></div>
        ) : share ? (
          <>
          <div className="workspace-shared-emote-import-options">
            <div className="workspace-shared-emote-meta">
              <span>{share.itemCount} 张表情</span>
              <span>{share.originalCreator.displayName} 创建</span>
              <span>{share.sharedBy.displayName} 分享</span>
            </div>
            {share.canSubscribeToSourceChanges === true && (
              <WorkspaceSwitch
                checked={subscribeToSourceChanges}
                disabled={importing !== null}
                label="订阅原作者更新"
                description="添加整套后自动同步合集名称、表情、顺序和短名称"
                onChange={setSubscribeToSourceChanges}
              />
            )}
          </div>
          <div className="workspace-shared-emote-grid">
            {share.items.map((emote) => {
              const imported = importedEmoteIds.includes(emote.id);
              const isImporting = importing === emote.id;
              return (
                <button
                  className={imported ? "workspace-shared-emote-item imported" : "workspace-shared-emote-item"}
                  key={emote.id}
                  type="button"
                  title={imported ? `${emote.label} 已添加` : `添加 ${emote.label}`}
                  aria-label={imported ? `已添加表情 ${emote.label}` : `添加表情 ${emote.label}`}
                  disabled={importing !== null || imported}
                  onClick={() => void importShare([emote.id])}
                >
                  <img src={emote.src} alt="" loading="lazy" decoding="async" />
                  <span className="workspace-shared-emote-item-action" aria-hidden="true">
                    {imported ? <Check size={16} /> : isImporting ? <span className="workspace-shared-emote-item-pending" /> : <Plus size={16} />}
                  </span>
                </button>
              );
            })}
          </div>
          </>
        ) : !loading ? (
          <div className="workspace-empty-state"><Images size={28} /><strong>找不到这个合集</strong></div>
        ) : (
          <WorkspaceSkeletonRows variant="setting" count={4} />
        )}
      </div>
    </div>
  );
}

function WorkspaceSharedEmoteCollectionDialog({
  shareId,
  onClose,
  onNotice
}: {
  shareId: string;
  onClose: () => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div
      className="workspace-shared-emote-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="workspace-shared-emote-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="表情合集预览"
        tabIndex={-1}
      >
        <WorkspaceSharedEmoteCollectionPage
          shareId={shareId}
          onBack={onClose}
          onNotice={onNotice}
          presentation="dialog"
          closeButtonRef={closeButtonRef}
        />
      </div>
    </div>,
    document.body
  );
}

function WorkspaceEmoteManagerDialog({
  conversations,
  onClose,
  onNotice,
  onSendShare
}: {
  conversations: WorkspaceConversation[];
  onClose: () => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
  onSendShare: (conversationId: string, share: WorkspaceEmoteCollectionShareSummary) => Promise<void>;
}) {
  const { confirm, choose } = useConfirmation();
  const [library, setLibrary] = useState<WorkspaceEmoteLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [collectionId, setCollectionId] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [selectedEmoteId, setSelectedEmoteId] = useState("");
  const [selectedEmoteLabel, setSelectedEmoteLabel] = useState("");
  const [editingCollectionId, setEditingCollectionId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [share, setShare] = useState<WorkspaceEmoteCollectionShareSummary | null>(null);
  const [shareConversationId, setShareConversationId] = useState("");
  const [uploadItems, setUploadItems] = useState<WorkspaceEmoteUploadItem[]>([]);
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [selectedExistingIds, setSelectedExistingIds] = useState<string[]>([]);
  const [draggedEntryId, setDraggedEntryId] = useState("");
  const [draggedEmoteId, setDraggedEmoteId] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const emoteDetailCloseRef = useRef<HTMLButtonElement | null>(null);
  const emoteDetailTriggerRef = useRef<HTMLElement | null>(null);
  const layerStateRef = useRef({
    selectedEmoteId: "",
    addExistingOpen: false,
    shareOpen: false,
    editingCollectionId: "",
    newCollectionOpen: false,
    collectionId: ""
  });
  layerStateRef.current = {
    selectedEmoteId,
    addExistingOpen,
    shareOpen: Boolean(share),
    editingCollectionId,
    newCollectionOpen,
    collectionId
  };

  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnUrl = window.location.href;
    // A chat picker can close while the manager is open. Keep its owning editor
    // as a fallback, without focusing a different page after route navigation.
    const returnEditor = triggerRef.current?.closest(".workspace-composer")
      ?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
    let cancelled = false;
    void loadWorkspaceEmoteLibrary()
      .then((data) => { if (!cancelled) setLibrary(data); })
      .catch((err) => { if (!cancelled) setError(userFacingErrorMessage(err, "我的表情暂时无法加载")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const root = document.getElementById("root");
    const oldInert = root?.inert ?? false;
    const oldOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const layer = layerStateRef.current;
        if (layer.selectedEmoteId) setSelectedEmoteId("");
        else if (layer.addExistingOpen) setAddExistingOpen(false);
        else if (layer.shareOpen) setShare(null);
        else if (layer.editingCollectionId) setEditingCollectionId("");
        else if (layer.newCollectionOpen) setNewCollectionOpen(false);
        else if (layer.collectionId) setCollectionId("");
        else onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (root) root.inert = oldInert;
      document.body.style.overflow = oldOverflow;
      requestAnimationFrame(() => {
        if (window.location.href !== returnUrl) return;
        const target = triggerRef.current?.isConnected ? triggerRef.current : returnEditor;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [onClose]);

  useEffect(() => {
    if (!selectedEmoteId) return;
    emoteDetailTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => emoteDetailCloseRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      requestAnimationFrame(() => emoteDetailTriggerRef.current?.focus());
    };
  }, [selectedEmoteId]);

  useEffect(() => {
    let cancelled = false;
    const refreshLibrary = () => {
      void loadWorkspaceEmoteLibrary(true)
        .then((next) => {
          if (!cancelled) setLibrary(next);
        })
        .catch((err) => {
          if (!cancelled) setError(userFacingErrorMessage(err, "我的表情暂时无法刷新"));
        });
    };
    window.addEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshLibrary);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshLibrary);
    };
  }, []);

  async function reload() {
    const next = await loadWorkspaceEmoteLibrary(true);
    setLibrary(next);
    return next;
  }
  async function reloadAfterMutation() {
    const next = await reload();
    notifyWorkspaceEmoteLibraryChanged();
    return next;
  }
  function contentEditingBlocked(collection: WorkspaceEmoteCollection | null | undefined) {
    if (!isWorkspaceEmoteCollectionReadOnly(collection)) return false;
    setError("该合集正在订阅原作者更新。关闭订阅后才能修改合集内容。");
    return true;
  }
  async function createCollection() {
    const name = newCollectionName.trim();
    if (!name) return;
    setBusy(true); setError("");
    try { await workspaceJson("/api/workspace/me/emote-collections", { method: "POST", body: JSON.stringify({ name }) }); setNewCollectionName(""); setNewCollectionOpen(false); await reloadAfterMutation(); onNotice("success", "表情合集已创建"); }
    catch (err) { setError(userFacingErrorMessage(err, "合集创建失败")); }
    finally { setBusy(false); }
  }
  async function renameCollection(id: string) {
    if (contentEditingBlocked(library?.collections.find((collection) => collection.id === id))) return;
    if (!editingName.trim()) return;
    setBusy(true);
    try { await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name: editingName.trim() }) }); setEditingCollectionId(""); await reloadAfterMutation(); }
    catch (err) { setError(userFacingErrorMessage(err, "合集重命名失败")); }
    finally { setBusy(false); }
  }
  async function deleteCollection(collection: WorkspaceEmoteCollection) {
    const choice = await choose({ title: "删除表情合集", message: `删除“${collection.name}”时，如何处理仅属于该合集的表情？`, confirmLabel: "删除合集及表情", alternativeLabel: "仅删除合集，保留表情" });
    if (choice === "cancel") return;
    const remove = choice === "confirm";
    setBusy(true);
    try { await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}?itemDisposition=${remove ? "remove" : "keep"}`, { method: "DELETE" }); setCollectionId(""); await reloadAfterMutation(); onNotice("success", "表情合集已删除"); }
    catch (err) { setError(userFacingErrorMessage(err, "合集删除失败")); }
    finally { setBusy(false); }
  }
  async function deleteEmote(emote: WorkspaceCustomEmote) {
    if (contentEditingBlocked(selectedCollection)) return;
    if (!await confirm(`从“我的表情”中删除“${emote.label}”？`)) return;
    setBusy(true); setError("");
    try {
      await workspaceJson(`/api/workspace/me/emotes/${encodeURIComponent(emote.id)}`, { method: "DELETE" });
      setSelectedEmoteId("");
      await reloadAfterMutation();
      onNotice("success", "表情已删除");
    } catch (err) {
      setError(userFacingErrorMessage(err, "表情删除失败"));
    } finally {
      setBusy(false);
    }
  }
  async function renameEmote(emote: WorkspaceCustomEmote) {
    if (contentEditingBlocked(selectedCollection)) return;
    const label = selectedEmoteLabel.trim();
    if (!label || label === emote.label) return;
    setBusy(true); setError("");
    try {
      await workspaceJson(`/api/workspace/me/emotes/${encodeURIComponent(emote.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label })
      });
      await reloadAfterMutation();
      setSelectedEmoteLabel(label);
      onNotice("success", "表情名称已更新");
    } catch (err) {
      setError(userFacingErrorMessage(err, "表情名称保存失败"));
    } finally {
      setBusy(false);
    }
  }
  async function moveEntry(index: number, delta: number) {
    if (!library) return;
    const next = [...library.entries]; const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setLibrary({ ...library, entries: next });
    try { await workspaceJson<WorkspaceEmoteLibrary>("/api/workspace/me/emote-library/order", { method: "PUT", body: JSON.stringify({ entryIds: next.map((entry) => entry.id) }) }); notifyWorkspaceEmoteLibraryChanged(); }
    catch (err) { await reload(); setError(userFacingErrorMessage(err, "排序保存失败")); }
  }
  async function moveEntryTo(entryId: string, targetEntryId: string) {
    if (!library || entryId === targetEntryId) return;
    const from = library.entries.findIndex((entry) => entry.id === entryId);
    const to = library.entries.findIndex((entry) => entry.id === targetEntryId);
    if (from < 0 || to < 0) return;
    const next = [...library.entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setLibrary({ ...library, entries: next });
    try {
      await workspaceJson<WorkspaceEmoteLibrary>("/api/workspace/me/emote-library/order", {
        method: "PUT",
        body: JSON.stringify({ entryIds: next.map((entry) => entry.id) })
      });
      notifyWorkspaceEmoteLibraryChanged();
    } catch (err) {
      await reload();
      setError(userFacingErrorMessage(err, "排序保存失败"));
    }
  }
  async function moveCollectionItem(collection: WorkspaceEmoteCollection, index: number, delta: number) {
    if (contentEditingBlocked(collection)) return;
    const next = [...collection.items]; const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setLibrary((current) => current ? { ...current, collections: current.collections.map((item) => item.id === collection.id ? { ...item, items: next } : item) } : current);
    try { await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/order`, { method: "PUT", body: JSON.stringify({ emoteIds: next.map((item) => item.id) }) }); notifyWorkspaceEmoteLibraryChanged(); }
    catch (err) { await reload(); setError(userFacingErrorMessage(err, "合集排序保存失败")); }
  }
  async function moveCollectionItemTo(collection: WorkspaceEmoteCollection, emoteId: string, targetEmoteId: string) {
    if (contentEditingBlocked(collection)) return;
    if (emoteId === targetEmoteId) return;
    const from = collection.items.findIndex((item) => item.id === emoteId);
    const to = collection.items.findIndex((item) => item.id === targetEmoteId);
    if (from < 0 || to < 0) return;
    const next = [...collection.items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setLibrary((current) => current ? {
      ...current,
      collections: current.collections.map((item) => item.id === collection.id ? { ...item, items: next, itemCount: next.length } : item),
      entries: current.entries.map((entry) => entry.type === "collection" && entry.collection.id === collection.id
        ? { ...entry, collection: { ...entry.collection, items: next, itemCount: next.length } }
        : entry)
    } : current);
    try {
      await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/order`, {
        method: "PUT",
        body: JSON.stringify({ emoteIds: next.map((item) => item.id) })
      });
      notifyWorkspaceEmoteLibraryChanged();
    } catch (err) {
      await reload();
      setError(userFacingErrorMessage(err, "合集排序保存失败"));
    }
  }
  async function uploadFiles(files: FileList | null) {
    const targetCollection = collectionId
      ? library?.collections.find((collection) => collection.id === collectionId)
      : null;
    if (contentEditingBlocked(targetCollection)) {
      if (uploadRef.current) uploadRef.current.value = "";
      return;
    }
    const selected = Array.from(files ?? []).slice(0, library?.limits.maxBatchItems ?? 50);
    if (selected.length === 0) return;
    const targetCollectionId = collectionId;
    const queued = selected.map((file) => ({
      id: makeId("emote-upload"),
      file,
      collectionId: targetCollectionId,
      state: "queued" as const,
      progress: 0
    }));
    setUploadItems(queued);
    setBusy(true); setError(""); let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(2, selected.length) }, async () => {
        while (cursor < queued.length) {
          const item = queued[cursor++];
          await uploadEmoteItem(item);
        }
      }));
      await reloadAfterMutation();
    } finally { setBusy(false); if (uploadRef.current) uploadRef.current.value = ""; }
  }
  async function uploadEmoteItem(item: WorkspaceEmoteUploadItem) {
    setUploadItems((current) => current.map((candidate) => candidate.id === item.id
      ? { ...candidate, state: "uploading", progress: 12, error: undefined }
      : candidate));
    try {
      const query = item.collectionId ? `?collectionId=${encodeURIComponent(item.collectionId)}&addToLibrary=false` : "";
      await uploadWorkspaceEmote(`/api/workspace/me/emotes${query}`, item.file, (progress) => {
        setUploadItems((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, progress }
          : candidate));
      });
      setUploadItems((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, state: "complete", progress: 100 }
        : candidate));
    } catch (err) {
      setUploadItems((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, state: "failed", progress: 0, error: userFacingErrorMessage(err, "上传失败") }
        : candidate));
    }
  }
  async function retryUpload(item: WorkspaceEmoteUploadItem) {
    const targetCollection = item.collectionId
      ? library?.collections.find((collection) => collection.id === item.collectionId)
      : null;
    if (contentEditingBlocked(targetCollection)) return;
    setBusy(true);
    try {
      await uploadEmoteItem(item);
      await reloadAfterMutation();
    } finally {
      setBusy(false);
    }
  }
  async function addExistingToCollection(collection: WorkspaceEmoteCollection) {
    if (contentEditingBlocked(collection)) return;
    if (selectedExistingIds.length === 0) return;
    const selectedCount = selectedExistingIds.length;
    setBusy(true); setError("");
    try {
      await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/items`, {
        method: "POST",
        body: JSON.stringify({ emoteIds: selectedExistingIds })
      });
      setSelectedExistingIds([]);
      setAddExistingOpen(false);
      await reloadAfterMutation();
      onNotice("success", `已添加 ${selectedCount} 张表情`);
    } catch (err) {
      setError(userFacingErrorMessage(err, "添加到合集失败"));
    } finally {
      setBusy(false);
    }
  }
  async function removeCollectionItem(collection: WorkspaceEmoteCollection, emote: WorkspaceCustomEmote) {
    if (contentEditingBlocked(collection)) return;
    setBusy(true); setError("");
    try {
      await workspaceJson(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/items/${encodeURIComponent(emote.id)}`, { method: "DELETE" });
      await reloadAfterMutation();
    } catch (err) {
      setError(userFacingErrorMessage(err, "移出合集失败"));
    } finally {
      setBusy(false);
    }
  }
  async function createShare(collection: WorkspaceEmoteCollection) {
    setBusy(true);
    try {
      const data = await workspaceJson<{ share: WorkspaceEmoteCollectionShareSummary }>(`/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/shares`, { method: "POST" });
      setShare(data.share); setShareConversationId("");
    } catch (err) { setError(userFacingErrorMessage(err, "合集分享创建失败")); }
    finally { setBusy(false); }
  }
  async function updateSourceSubscription(collection: WorkspaceEmoteCollection, enabled: boolean) {
    const subscription = collection.sourceSubscription;
    if (!subscription.eligible || subscription.status === "detached" || subscription.enabled === enabled) return;
    setBusy(true); setError("");
    try {
      await workspaceJson<{ collection: WorkspaceEmoteCollection }>(
        `/api/workspace/me/emote-collections/${encodeURIComponent(collection.id)}/source-subscription`,
        { method: "PUT", body: JSON.stringify({ enabled }) }
      );
      setEditingCollectionId("");
      setAddExistingOpen(false);
      await reloadAfterMutation();
      onNotice("success", enabled ? "已订阅原作者更新" : "已关闭订阅并保留当前内容");
    } catch (err) {
      setError(userFacingErrorMessage(err, enabled ? "订阅开启失败" : "订阅关闭失败"));
    } finally {
      setBusy(false);
    }
  }
  async function revokeShare() {
    if (!share?.canRevoke || share.revokedAt) return;
    setBusy(true); setError("");
    try {
      const data = await workspaceJson<{ share: WorkspaceEmoteCollectionShareSummary }>(`/api/workspace/me/emote-collection-shares/${encodeURIComponent(share.id)}`, { method: "DELETE" });
      setShare(data.share);
      onNotice("success", "合集分享已撤销");
    } catch (err) {
      setError(userFacingErrorMessage(err, "撤销分享失败"));
    } finally {
      setBusy(false);
    }
  }

  const selectedCollection = library?.collections.find((item) => item.id === collectionId) ?? null;
  const selectedEmote = library?.emotes.find((item) => item.id === selectedEmoteId) ?? null;
  const selectedCollectionReadOnly = isWorkspaceEmoteCollectionReadOnly(selectedCollection);
  const selectedSourceSubscription = selectedCollection?.sourceSubscription;
  const selectedCollectionIds = new Set(selectedCollection?.items.map((item) => item.id) ?? []);
  const availableExistingEmotes = library?.emotes.filter((emote) => !selectedCollectionIds.has(emote.id)) ?? [];
  const visibleUploadItems = uploadItems.filter((item) => item.state !== "complete");
  return createPortal(
    <div className="workspace-emote-manager-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="workspace-emote-manager" role="dialog" aria-modal="true" aria-labelledby="workspace-emote-manager-title">
        <header className="workspace-emote-manager-header">
          <div><p className="eyebrow">个人设置</p><h2 id="workspace-emote-manager-title">我的表情</h2></div>
          <button ref={closeRef} className="icon-button" type="button" title="关闭" aria-label="关闭我的表情管理" onClick={onClose}><X size={18} /></button>
        </header>
        {loading ? <WorkspaceSkeletonRows variant="setting" count={5} /> : !library ? <p className="workspace-form-status">{error || "暂无数据"}</p> : (
          <div className="workspace-emote-manager-body">
            <div className="workspace-emote-manager-toolbar">
              <div>
                <strong>{workspaceEmoteLibraryTotalItemCount(library.usage)} 张表情</strong>
                <small>本地 {library.usage.itemCount} 张 · {formatBytes(library.usage.totalBytes)} / {formatBytes(library.limits.maxTotalBytes)}</small>
                <small>订阅 {library.usage.subscribedItemCount ?? 0} 张 · {formatBytes(library.usage.subscribedTotalBytes ?? 0)} · {library.usage.subscribedCollectionCount ?? 0} 个合集</small>
              </div>
              <span className="workspace-emote-manager-actions">
                <button className={organizing ? "secondary compact active" : "secondary compact"} type="button" onClick={() => setOrganizing((value) => !value)}>{organizing ? <Check size={16} /> : <GripVertical size={16} />}{organizing ? "完成" : "整理"}</button>
                <button className="secondary compact" type="button" onClick={() => setNewCollectionOpen((value) => !value)}><Images size={16} />新建合集</button>
                <label className={busy || selectedCollectionReadOnly ? "icon-button workspace-emote-upload-button disabled" : "icon-button workspace-emote-upload-button"} title={selectedCollectionReadOnly ? "关闭订阅后才能向合集上传" : "上传表情"} aria-label="上传表情" aria-disabled={busy || selectedCollectionReadOnly}><FileUp size={17} /><input ref={uploadRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" disabled={busy || selectedCollectionReadOnly} onChange={(event) => void uploadFiles(event.currentTarget.files)} /></label>
              </span>
            </div>
            {library.usage.overLimit && <p className="workspace-emote-limit-warning" role="alert"><AlertCircle size={16} />本地表情容量已超过上限，请先删除部分本地表情再上传。</p>}
            {newCollectionOpen && <form className="workspace-emote-create-collection" onSubmit={(event) => { event.preventDefault(); void createCollection(); }}><label><span>合集名称</span><input value={newCollectionName} maxLength={32} autoFocus onChange={(event) => setNewCollectionName(event.target.value)} placeholder="例如：猫猫日常" /></label><button className="primary compact" type="submit" disabled={busy || !newCollectionName.trim()}>创建</button><button className="secondary compact" type="button" onClick={() => setNewCollectionOpen(false)}>取消</button></form>}
            {error && <p className="emote-picker-error" role="status">{error}</p>}
            {selectedCollection ? (
              <section className="workspace-emote-manager-collection">
                <div className="workspace-emote-manager-section-head">
                  <button className="workspace-emote-manager-back" type="button" onClick={() => { setCollectionId(""); setSelectedEmoteId(""); }}><ArrowLeft size={17} /><span><strong>{selectedCollection.name}</strong><small>{selectedCollection.items.length} / {library.limits.maxCollectionItems} 张</small></span></button>
                  <div className="workspace-emote-manager-actions">
                    <button className="secondary compact" type="button" disabled={busy || selectedCollectionReadOnly || availableExistingEmotes.length === 0} title={selectedCollectionReadOnly ? "关闭订阅后才能添加已有表情" : undefined} onClick={() => { setSelectedExistingIds([]); setAddExistingOpen(true); }}><Plus size={15} /> 添加已有</button>
                    <button className="secondary compact" type="button" disabled={busy} onClick={() => void createShare(selectedCollection)}><Share2 size={15} /> 分享合集</button>
                    <button className="icon-button" type="button" disabled={busy || selectedCollectionReadOnly} title={selectedCollectionReadOnly ? "关闭订阅后才能重命名合集" : "重命名合集"} aria-label={selectedCollectionReadOnly ? `${selectedCollection.name} 正在订阅，不能重命名` : `重命名 ${selectedCollection.name}`} onClick={() => { setEditingCollectionId(selectedCollection.id); setEditingName(selectedCollection.name); }}><Type size={16} /></button>
                  </div>
                </div>
                {shouldShowWorkspaceEmoteSourceSubscription(selectedSourceSubscription) && selectedSourceSubscription && (
                  <section className={`workspace-emote-subscription-panel ${selectedSourceSubscription.status}`} aria-label="合集来源订阅">
                    <div className="workspace-emote-subscription-summary">
                      <span className="workspace-emote-subscription-status">
                        {selectedSourceSubscription.status === "synced" ? "已同步" : selectedSourceSubscription.status === "detached" ? "已断开" : "未订阅"}
                      </span>
                      <span>
                        <strong>原作者 {selectedCollection.originalCreator.displayName}</strong>
                        <small>
                          {selectedSourceSubscription.status === "detached"
                            ? "原合集已删除，当前内容作为快照保留。"
                            : selectedSourceSubscription.status === "synced"
                              ? `跟随原合集${selectedSourceSubscription.sourceRevision === null ? "" : ` · 版本 ${selectedSourceSubscription.sourceRevision}`}${selectedSourceSubscription.lastSyncedAt ? ` · ${formatWorkspaceTime(selectedSourceSubscription.lastSyncedAt)}` : ""}`
                              : "当前内容独立保存，开启后会跟随原合集更新。"}
                        </small>
                      </span>
                    </div>
                    <WorkspaceSwitch
                      checked={selectedSourceSubscription.enabled}
                      disabled={busy || selectedSourceSubscription.status === "detached"}
                      label="订阅原作者更新"
                      description={selectedSourceSubscription.status === "detached"
                        ? "原合集已不可用，无法继续订阅；保留的快照仍可使用。"
                        : selectedSourceSubscription.enabled
                          ? "同步期间合集内容只读；关闭后会保留当前内容。"
                          : "自动同步名称、表情增删、顺序和短名称。"}
                      onChange={(enabled) => void updateSourceSubscription(selectedCollection, enabled)}
                    />
                  </section>
                )}
                {editingCollectionId === selectedCollection.id && !selectedCollectionReadOnly && <form className="workspace-emote-rename-collection" onSubmit={(event) => { event.preventDefault(); void renameCollection(selectedCollection.id); }}><input value={editingName} maxLength={32} onChange={(event) => setEditingName(event.target.value)} autoFocus /><button className="primary compact" type="submit">保存</button><button className="secondary compact" type="button" onClick={() => setEditingCollectionId("")}>取消</button></form>}
                <div className={organizing && !selectedCollectionReadOnly ? "workspace-emote-library-grid organizing" : "workspace-emote-library-grid"}>
                  {selectedCollection.items.map((emote, index) => <EmoteLibraryTile
                    key={emote.id} emote={emote} index={index} total={selectedCollection.items.length} organizing={organizing && !selectedCollectionReadOnly} dragging={draggedEmoteId === emote.id}
                    onOpen={() => { setSelectedEmoteId(emote.id); setSelectedEmoteLabel(emote.label); }} onDragStart={() => setDraggedEmoteId(emote.id)} onDragEnd={() => setDraggedEmoteId("")}
                    onDrop={() => { void moveCollectionItemTo(selectedCollection, draggedEmoteId, emote.id); setDraggedEmoteId(""); }} onMove={(delta) => void moveCollectionItem(selectedCollection, index, delta)} onRemove={() => void removeCollectionItem(selectedCollection, emote)}
                  />)}
                  {selectedCollection.items.length === 0 && <p className="saved-empty">{selectedCollectionReadOnly ? "原合集当前没有表情。" : "合集还没有表情，可使用上方上传按钮添加。"}</p>}
                </div>
              </section>
            ) : (
              <section>
                <div className="workspace-emote-manager-section-head"><div><h3>表情库</h3><small>{organizing ? "拖动或使用方向按钮调整顺序" : "单张表情与合集按你设定的顺序显示"}</small></div></div>
                <div className={organizing ? "workspace-emote-library-grid organizing" : "workspace-emote-library-grid"}>
                  {library.entries.map((entry, index) => entry.type === "emote" ? <EmoteLibraryTile
                    key={entry.id} emote={entry.emote} index={index} total={library.entries.length} organizing={organizing} dragging={draggedEntryId === entry.id}
                    onOpen={() => { setSelectedEmoteId(entry.emote.id); setSelectedEmoteLabel(entry.emote.label); }} onDragStart={() => setDraggedEntryId(entry.id)} onDragEnd={() => setDraggedEntryId("")}
                    onDrop={() => { void moveEntryTo(draggedEntryId, entry.id); setDraggedEntryId(""); }} onMove={(delta) => void moveEntry(index, delta)} onRemove={() => void deleteEmote(entry.emote)}
                  /> : <EmoteCollectionTile key={entry.id} collection={entry.collection} index={index} total={library.entries.length} organizing={organizing} dragging={draggedEntryId === entry.id}
                    onOpen={() => { setCollectionId(entry.collection.id); setSelectedEmoteId(""); }} onDragStart={() => setDraggedEntryId(entry.id)} onDragEnd={() => setDraggedEntryId("")}
                    onDrop={() => { void moveEntryTo(draggedEntryId, entry.id); setDraggedEntryId(""); }} onMove={(delta) => void moveEntry(index, delta)} onRename={isWorkspaceEmoteCollectionReadOnly(entry.collection) ? undefined : () => { setEditingCollectionId(entry.collection.id); setEditingName(entry.collection.name); setCollectionId(entry.collection.id); }} onRemove={() => void deleteCollection(entry.collection)} />)}
                  {library.entries.length === 0 && <p className="saved-empty">还没有收藏表情。使用上传按钮开始建立个人表情库。</p>}
                </div>
              </section>
            )}
            {visibleUploadItems.length > 0 && (
              <section className="workspace-emote-upload-queue" aria-label="表情上传状态">
                <div className="workspace-emote-manager-section-head"><div><h3>上传任务</h3><small>完成后自动收起，仅保留失败项目</small></div><button className="secondary compact" type="button" onClick={() => setUploadItems([])}>清除</button></div>
                {visibleUploadItems.map((item) => <div className={`workspace-emote-upload-item ${item.state}`} key={item.id}><span>{item.file.name}</span><span className="workspace-upload-progress"><i style={{ width: `${item.progress}%` }} /></span><small>{item.state === "queued" ? "等待中" : item.state === "uploading" ? `${item.progress}%` : item.error || "上传失败"}</small>{item.state === "failed" && <button className="secondary compact" type="button" disabled={busy} onClick={() => void retryUpload(item)}>重试</button>}</div>)}
              </section>
            )}
          </div>
        )}
        {selectedEmote && (
          <div className="workspace-emote-detail" role="dialog" aria-label="表情详情">
            <header><strong>表情详情</strong><button ref={emoteDetailCloseRef} className="icon-button" type="button" title="关闭详情" aria-label="关闭表情详情" onClick={() => setSelectedEmoteId("")}><X size={17} /></button></header>
            <div className="workspace-emote-detail-preview"><img src={selectedEmote.src} alt={selectedEmote.label} /></div>
            {selectedCollectionReadOnly ? (
              <p className="workspace-emote-readonly-note"><LockKeyhole size={16} />短名称由原作者同步。关闭合集订阅后可编辑。</p>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); void renameEmote(selectedEmote); }}>
                <label><span>短名称</span><input value={selectedEmoteLabel} maxLength={16} onChange={(event) => setSelectedEmoteLabel(event.target.value)} /><small>只用于识别、搜索和无障碍说明，不会显示在表情网格中。</small></label>
                <button className="primary compact" type="submit" disabled={busy || !selectedEmoteLabel.trim() || selectedEmoteLabel.trim() === selectedEmote.label}>保存名称</button>
              </form>
            )}
            <dl><div><dt>类型</dt><dd>{selectedEmote.animated ? "动态表情" : "静态表情"}</dd></div>{selectedEmote.width && selectedEmote.height && <div><dt>尺寸</dt><dd>{selectedEmote.width} × {selectedEmote.height}</dd></div>}{selectedEmote.byteSize && <div><dt>大小</dt><dd>{formatBytes(selectedEmote.byteSize)}</dd></div>}<div><dt>来源</dt><dd title={selectedEmote.originalFileName}>{selectedEmote.originalFileName || (selectedEmote.sourceType === "builtin" ? "内置表情" : "从聊天收藏")}</dd></div></dl>
            <div className="workspace-emote-detail-actions">
              {selectedCollection && <button className="secondary" type="button" disabled={busy || selectedCollectionReadOnly} title={selectedCollectionReadOnly ? "关闭订阅后才能移出表情" : undefined} onClick={() => void removeCollectionItem(selectedCollection, selectedEmote)}>移出当前合集</button>}
              <button className="secondary danger-action" type="button" disabled={busy || selectedCollectionReadOnly} title={selectedCollectionReadOnly ? "关闭订阅后才能删除表情" : undefined} onClick={() => void deleteEmote(selectedEmote)}>从我的表情删除</button>
            </div>
          </div>
        )}
        {addExistingOpen && selectedCollection && !selectedCollectionReadOnly && <div className="workspace-emote-share-dialog workspace-emote-existing-dialog" role="dialog" aria-label={`添加表情到 ${selectedCollection.name}`}><h3>添加已有表情</h3><p>可一次选择多张，原表情仍保留在表情库中。</p><div className="workspace-emote-existing-grid">{availableExistingEmotes.map((emote) => <label key={emote.id} title={emote.label} aria-label={emote.label} className={selectedExistingIds.includes(emote.id) ? "selected" : ""}><input type="checkbox" checked={selectedExistingIds.includes(emote.id)} onChange={(event) => setSelectedExistingIds((current) => event.target.checked ? [...current, emote.id] : current.filter((id) => id !== emote.id))} /><img src={emote.src} alt="" />{selectedExistingIds.includes(emote.id) && <span className="workspace-emote-selected-mark"><Check size={15} /></span>}</label>)}</div><div className="workspace-section-actions"><button className="secondary" type="button" onClick={() => setAddExistingOpen(false)}>取消</button><button className="primary" type="button" disabled={busy || selectedExistingIds.length === 0} onClick={() => void addExistingToCollection(selectedCollection)}>添加 {selectedExistingIds.length || ""} 张</button></div></div>}
        {share && (
          <div className="workspace-emote-share-dialog workspace-emote-share-panel" role="dialog" aria-label="分享表情合集">
            <div className="workspace-emote-share-heading">
              <div>
                <h3>分享“{share.name}”</h3>
                {!share.revokedAt && <p>复制登录后链接，或发送到空间内会话。</p>}
              </div>
              <button className="icon-button" type="button" title="关闭分享" aria-label="关闭分享" onClick={() => setShare(null)}><X size={16} /></button>
            </div>
            {share.revokedAt ? (
              <p className="workspace-emote-share-revoked">该分享已撤销，历史卡片会显示为不可用。</p>
            ) : (
              <div className="workspace-emote-share-body">
                <div className="workspace-emote-share-field">
                  <label htmlFor="workspace-emote-share-link">登录后链接</label>
                  <span className="workspace-inline-form">
                    <input id="workspace-emote-share-link" readOnly value={`${window.location.origin}${share.sharePath}`} />
                    <button className="secondary" type="button" onClick={() => void copyText(`${window.location.origin}${share.sharePath}`)}><Copy size={16} />复制链接</button>
                  </span>
                </div>
                <div className="workspace-emote-share-field">
                  <Select id="workspace-emote-share-conversation" label="发送到会话" value={shareConversationId} onValueChange={setShareConversationId} options={[{ value: "", label: "选择会话" }, ...conversations.map((conversation) => ({ value: conversation.id, label: conversation.displayTitle || conversation.title }))]} />
                </div>
                <div className="workspace-section-actions workspace-emote-share-actions">
                  <button className="primary" type="button" disabled={!shareConversationId || busy} onClick={() => void onSendShare(shareConversationId, share)}><Send size={16} />发送分享卡片</button>
                  {share.canRevoke && <button className="secondary danger-action" type="button" disabled={busy} onClick={() => void revokeShare()}>撤销分享</button>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function EmoteLibraryTile({ emote, index, total, organizing, dragging, onOpen, onDragStart, onDrop, onDragEnd, onMove, onRemove }: { emote: WorkspaceCustomEmote; index: number; total: number; organizing: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDrop: () => void; onDragEnd: () => void; onMove: (delta: number) => void; onRemove: () => void }) {
  return <article className={dragging ? "workspace-emote-library-tile emote dragging" : "workspace-emote-library-tile emote"} onDragOver={(event) => { if (organizing) event.preventDefault(); }} onDrop={onDrop}><button className="workspace-emote-library-preview" type="button" title={emote.label} aria-label={`查看表情 ${emote.label}`} onClick={onOpen}><img src={emote.src} alt="" loading="lazy" decoding="async" />{emote.animated && <span>GIF</span>}</button>{organizing && <EmoteTileControls label={emote.label} index={index} total={total} onMove={onMove} onRemove={onRemove} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />}</article>;
}

function EmoteCollectionTile({ collection, index, total, organizing, dragging, onOpen, onDragStart, onDrop, onDragEnd, onMove, onRename, onRemove }: { collection: WorkspaceEmoteCollection; index: number; total: number; organizing: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDrop: () => void; onDragEnd: () => void; onMove: (delta: number) => void; onRename?: () => void; onRemove: () => void }) {
  const subscription = collection.sourceSubscription;
  const subscriptionLabel = shouldShowWorkspaceEmoteSourceSubscription(subscription)
    ? subscription.status === "synced"
      ? "订阅中"
      : subscription.status === "detached"
        ? "快照保留"
        : "未订阅"
    : "";
  return <article className={dragging ? "workspace-emote-library-tile collection dragging" : "workspace-emote-library-tile collection"} onDragOver={(event) => { if (organizing) event.preventDefault(); }} onDrop={onDrop}><button className="workspace-emote-collection-preview" type="button" onClick={onOpen} aria-label={`打开合集 ${collection.name}`}><span className="workspace-emote-collection-cover">{collection.items.slice(0, 4).map((emote) => <img key={emote.id} src={emote.src} alt="" loading="lazy" decoding="async" />)}{collection.items.length === 0 && <Images size={28} />}</span><span><strong>{collection.name}</strong><small>{collection.items.length} 张{subscriptionLabel ? ` · ${subscriptionLabel} · ${collection.originalCreator.displayName}` : ""}</small></span></button>{organizing && <EmoteTileControls label={collection.name} index={index} total={total} onMove={onMove} onRemove={onRemove} onRename={onRename} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />}</article>;
}

function EmoteTileControls({ label, index, total, draggable, onMove, onRemove, onRename, onDragStart, onDragEnd }: { label: string; index: number; total: number; draggable: boolean; onMove: (delta: number) => void; onRemove: () => void; onRename?: () => void; onDragStart: () => void; onDragEnd: () => void }) {
  return <div className="workspace-emote-tile-controls"><span className="workspace-emote-drag-handle" draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} title="拖拽排序"><GripVertical size={16} /></span>{onRename && <button type="button" title="重命名" aria-label={`重命名 ${label}`} onClick={onRename}><Type size={14} /></button>}<button type="button" title="前移" aria-label={`前移 ${label}`} disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp size={15} /></button><button type="button" title="后移" aria-label={`后移 ${label}`} disabled={index === total - 1} onClick={() => onMove(1)}><ChevronDown size={15} /></button><button className="danger-action" type="button" title="删除" aria-label={`删除 ${label}`} onClick={onRemove}><Trash2 size={14} /></button></div>;
}

function WorkspaceMemberDetail({
  member,
  currentUserId,
  canCreateDirect,
  onMemberUpdated,
  onStartDirect,
  onNotice
}: {
  member: WorkspaceUser;
  currentUserId: string;
  canCreateDirect: boolean;
  onMemberUpdated: (member: WorkspaceUser) => void;
  onStartDirect: (memberId: string) => void;
  onNotice: (tone: WorkspaceNotice["tone"], text: string) => void;
}) {
  const [remark, setRemark] = useState(member.remark ?? "");
  const [saving, setSaving] = useState(false);
  const canRemark = member.kind === "human" && member.id !== currentUserId;

  useEffect(() => {
    setRemark(member.remark ?? "");
  }, [member.id, member.remark]);

  async function saveRemark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRemark) return;
    setSaving(true);
    try {
      const path = `/api/workspace/members/${encodeURIComponent(member.id)}/remark`;
      const data = await workspaceJson<{ member: WorkspaceUser }>(path, remark.trim()
        ? { method: "PUT", body: JSON.stringify({ remark: remark.trim() }) }
        : { method: "DELETE" });
      onMemberUpdated(data.member);
      setRemark(data.member.remark ?? "");
      onNotice("success", remark.trim() ? "成员备注已保存" : "成员备注已移除");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "成员备注保存失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="workspace-context-body workspace-member-detail">
      <div className="workspace-context-profile">
        <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} decorative />
        <div>
          <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
          <small>{member.description || workspaceMemberRoleLabel(member)}</small>
        </div>
      </div>
      <dl className="workspace-member-facts">
        {member.remark && <div><dt>我的备注</dt><dd>{member.remark}</dd></div>}
        <div><dt>公开昵称</dt><dd>{member.nickname || "未设置"}</dd></div>
        {member.githubLogin && <div><dt>GitHub 账号</dt><dd>@{member.githubLogin}</dd></div>}
        <div><dt>空间身份</dt><dd>{workspaceMemberRoleLabel(member)}</dd></div>
      </dl>
      {canRemark && (
        <form className="workspace-remark-form" onSubmit={saveRemark}>
          <label>
            <span>私人备注</span>
            <input value={remark} maxLength={32} onChange={(event) => setRemark(event.target.value)} placeholder={member.nickname || member.githubLogin || "输入备注"} />
          </label>
          <button className="secondary" type="submit" disabled={saving || (!member.remark && !remark.trim())}>
            {saving ? "保存中" : remark.trim() || !member.remark ? "保存备注" : "移除备注"}
          </button>
        </form>
      )}
      {member.id !== currentUserId && canCreateDirect && member.capabilities?.canStartDirectConversation && (
        <button className="primary" type="button" onClick={() => onStartDirect(member.id)}>
          <MessageSquare size={16} />
          发起私聊
        </button>
      )}
    </div>
  );
}

function ThemeSwitch({ mode, resolvedTheme, onModeChange }: {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  onModeChange: (mode: ThemeMode) => void;
}) {
  return <SegmentedControl className="dl-theme-switch" label="外观模式" hideLabel value={mode} onValueChange={(value) => { if (value === "system" || value === "light" || value === "dark") onModeChange(value); }} options={[
    { value: "system", label: "系统", accessibleLabel: `跟随系统（当前${resolvedTheme === "dark" ? "深色" : "浅色"}）`, icon: <Monitor /> },
    { value: "light", label: "浅色", accessibleLabel: "使用浅色模式", icon: <Sun /> },
    { value: "dark", label: "深色", accessibleLabel: "使用深色模式", icon: <Moon /> }
  ]} />;
}

function TopBar({
  label,
  title,
  icon,
  onBack
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button" type="button" onClick={onBack} title="返回通道选择">
        <ArrowLeft size={18} />
      </button>
      <div className="topbar-title">
        <span>
          {icon}
          {label}
        </span>
        <h1>{title}</h1>
      </div>
    </header>
  );
}


function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
  );
  if (items.length === 0) {
    return;
  }
  event.preventDefault();
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex].focus();
}
function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')
  );
  if (tabs.length === 0) {
    return;
  }

  const currentTab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
  const currentIndex = Math.max(0, currentTab ? tabs.indexOf(currentTab) : 0);
  let nextIndex = currentIndex;

  if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  }

  event.preventDefault();
  const nextTab = tabs[nextIndex];
  nextTab.focus();
  nextTab.click();
}

function InlineNotice({
  noticeKey,
  tone,
  text,
  persistent = false,
  durationMs = WORKSPACE_NOTICE_AUTO_DISMISS_MS,
  onDismiss
}: {
  noticeKey?: string | number;
  tone: "info" | "success" | "warning";
  text: React.ReactNode;
  persistent?: boolean;
  durationMs?: number;
  onDismiss?: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState(durationMs);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (persistent || !dismissRef.current || durationMs <= 0) return;
    const startedAt = Date.now();
    setRemainingMs(durationMs);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, durationMs - (Date.now() - startedAt));
      setRemainingMs(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        dismissRef.current?.();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [durationMs, noticeKey, persistent]);

  const progress = persistent || durationMs <= 0 ? 1 : Math.max(0, remainingMs / durationMs);
  return (
    <div className={`notice ${tone}`} role={tone === "warning" ? "alert" : "status"}>
      {tone === "warning" ? <AlertCircle size={16} /> : <Check size={16} />}
      <span>{text}</span>
      {onDismiss && (
        <span className="notice-actions">
          {!persistent && durationMs > 0 && (
            <span className="notice-countdown" aria-hidden="true">{Math.max(1, Math.ceil(remainingMs / 1000))}s</span>
          )}
          <button className="notice-dismiss" type="button" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>
            <X size={15} />
          </button>
        </span>
      )}
      {!persistent && durationMs > 0 && (
        <span className="notice-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </span>
      )}
    </div>
  );
}

function getP2pStatusSummary(state: ConnectionState, mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return "浏览器直连";
  }
  if (mode === "relay-text") {
    return "文本中转";
  }
  if (mode === "error" || state === "error") {
    return "连接异常";
  }
  if (mode === "offline" || state === "offline") {
    return "对方离线";
  }
  if (peerCount >= 2) {
    return "协商直连";
  }
  return "等待对方";
}

function getP2pStatusTone(state: ConnectionState, mode: P2pTransportMode) {
  if (mode === "direct") {
    return "direct";
  }
  if (mode === "error" || state === "error") {
    return "error";
  }
  if (mode === "offline" || state === "offline") {
    return "offline";
  }
  if (mode === "relay-text") {
    return "relay";
  }
  return "waiting";
}

function getDefaultP2pStatusTips(mode: P2pTransportMode, peerCount: number) {
  if (mode === "direct") {
    return ["可以发送文本和文件", "双方关闭页面后会话结束"];
  }
  if (mode === "relay-text") {
    return ["文本可继续发送", "文件需等待直连通道", "长时间未恢复时复制新链接重试"];
  }
  if (mode === "waiting" && peerCount >= 2) {
    return ["双方保持页面打开", "浏览器会继续协商直连路径"];
  }
  return ["复制邀请链接给对方", "双方保持页面打开"];
}


function P2pStatusControl({
  state,
  mode,
  peerCount,
  advice,
  trustText
}: {
  state: ConnectionState;
  mode: P2pTransportMode;
  peerCount: number;
  advice: ConnectionAdvice | null;
  trustText: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const summary = getP2pStatusSummary(state, mode, peerCount);
  const tone = getP2pStatusTone(state, mode);
  const tips = advice?.items ?? getDefaultP2pStatusTips(mode, peerCount);
  const body = advice?.body ?? p2pTransportModeDescription(mode, peerCount);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("[data-close]")?.focus());
    const close = () => {
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`p2p-status-control ${tone}${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        className="p2p-status-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="p2p-status-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="status-dot" aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown className="status-chevron" size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="p2p-status-popover"
          id="p2p-status-panel"
          role="dialog"
          aria-labelledby="p2p-status-title"
          aria-describedby="p2p-status-description"
        >
          <div className="p2p-status-popover-header">
            <strong id="p2p-status-title">{advice?.title ?? p2pTransportModeLabel(mode)}</strong>
            <button className="icon-button" type="button" data-close title="关闭连接状态" onClick={() => {
              setOpen(false);
              window.requestAnimationFrame(() => triggerRef.current?.focus());
            }}>
              <X size={16} />
            </button>
          </div>
          <p id="p2p-status-description">{body}</p>
          <small>{trustText}</small>
          {tips.length > 0 && (
            <ul>
              {tips.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
function RoomDetails({
  open,
  details,
  peers,
  shareLink,
  onCopyShare,
  copyState,
  onToggle
}: {
  open: boolean;
  details: RoomDetail[];
  peers: Peer[];
  shareLink?: string;
  onCopyShare?: () => void;
  copyState?: CopyState;
  onToggle: () => void;
}) {
  return (
    <section className={open ? "room-details open" : "room-details"} aria-label="会话信息">
      <button className="room-details-toggle" type="button" onClick={onToggle} aria-expanded={open}>
        <span>
          <UsersRound size={16} />
          会话信息
        </span>
        {open ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
      </button>
      {open && (
        <div className="room-details-body">
          <dl className="detail-grid">
            {details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
          <p className="verification-help">
            安全校验码由邀请链接密钥和可选安全口令派生。双方看到的数字一致，说明使用的是同一组端到端加密密钥。
          </p>
          <div className="peer-list-inline" aria-label="在线状态">
            <span className="presence online" aria-hidden="true" />
            <strong>{peers.length ? `${peers.length}/2 在线` : "等待对方"}</strong>
            {peers.length ? (
              <span>{peers.map(formatPeerName).join("、")}</span>
            ) : (
              <span>复制邀请链接给对方加入</span>
            )}
          </div>
          {shareLink && (
            <div className="share-strip">
              <div className="share-meta">
                <Link2 size={16} />
                <span>邀请</span>
              </div>
              <span className="share-link-text">{shareLink}</span>
              <button
                className="secondary compact"
                type="button"
                title="复制邀请链接"
                onClick={onCopyShare}
              >
                <Clipboard size={16} />
                {copyState === "copied" ? "已复制" : "复制"}
              </button>
            </div>
          )}
          {copyState === "failed" && <p className="copy-fallback">复制失败，请手动选择链接。</p>}
        </div>
      )}
    </section>
  );
}

function SavedSessionsPanel({
  sessions,
  selectedSession,
  selectedSessionId,
  onSelect,
  onExport,
  onClear
}: {
  sessions: SavedP2pSession[];
  selectedSession?: SavedP2pSession;
  selectedSessionId: string;
  onSelect: (sessionId: string) => void;
  onExport: (session: SavedP2pSession) => void;
  onClear: () => void;
}) {
  return (
    <section className="saved-sessions" aria-label="已保存会话记录">
      <div className="saved-sessions-header">
        <span>
          <History size={16} />
          已保存记录
        </span>
        <button className="secondary compact" type="button" onClick={onClear} disabled={!sessions.length}>
          <Trash2 size={15} />
          清除
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="saved-empty">暂无本地保存记录。</p>
      ) : (
        <>
          <p className="saved-empty">
            这些记录仅保存在本机浏览器，内容为明文；<br />
            导出文件同样为明文 JSON。
          </p>
          <div className="saved-session-list">
            {sessions.map((session) => (
              <button
                className={session.id === selectedSessionId ? "saved-session active" : "saved-session"}
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
              >
                <strong>房间 {session.roomId}</strong>
                <span>
                  {formatSavedAt(session.savedAt)} · {session.messages.length} 条
                </span>
              </button>
            ))}
          </div>
          {selectedSession && (
            <div className="saved-session-preview">
              <div className="saved-preview-toolbar">
                <span>{selectedSession.messages.length} 条消息</span>
                <button className="secondary compact" type="button" onClick={() => onExport(selectedSession)}>
                  <Download size={15} />
                  导出
                </button>
              </div>
              <div className="saved-message-list">
                {selectedSession.messages.slice(0, 8).map((message) => (
                  <article key={message.id}>
                    <strong>{message.author}</strong>
                    <span>{message.at}</span>
                    <MessageBody body={message.body} />
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FileTransferCard({
  transfer,
  self,
  onAccept,
  onReject,
  onSave,
  onRetry
}: {
  transfer: FileTransfer;
  self: boolean;
  onAccept?: (transferId: string) => void;
  onReject?: (transferId: string) => void;
  onSave?: (transfer: FileTransfer) => void;
  onRetry?: (transferId: string) => void;
}) {
  const isActive = transfer.status === "sending" || transfer.status === "receiving" || transfer.status === "verifying";
  const canRespond = !self && transfer.status === "offered";
  const canSave = !self && transfer.status === "complete";
  const canRetry = self && transfer.retryable && (transfer.status === "failed" || transfer.status === "rejected");

  return (
    <div className={`file-transfer ${transfer.status}`}>
      {transfer.downloadUrl && isPreviewableImageMimeType(transfer.mimeType) && (
        <img className="file-transfer-image-preview" src={transfer.downloadUrl} alt={transfer.name} />
      )}
      <div className="file-transfer-main">
        <span className="file-transfer-icon" aria-hidden="true">
          {transfer.status === "complete" ? <FileCheck2 size={18} /> : <FileUp size={18} />}
        </span>
        <span className="file-transfer-text">
          <strong>{transfer.name}</strong>
          <small>
            {formatBytes(transfer.size)} · {transferStatusLabel(transfer.status)}
          </small>
        </span>
      </div>
      {(isActive || transfer.progress > 0) && (
        <div className="transfer-progress" aria-label={`传输进度 ${transfer.progress}%`}>
          <span style={{ width: `${transfer.progress}%` }} />
        </div>
      )}
      {isActive && (
        <p className="transfer-tip">提示：文件加密传输期间，双方应保持页面在线。</p>
      )}
      {transfer.riskNote && <p className="transfer-tip">{transfer.riskNote}</p>}
      {transfer.failureReason && <p className="transfer-tip">原因：{transfer.failureReason}</p>}
      {canRespond && (
        <div className="file-transfer-actions">
          <button className="primary compact direct-button" type="button" onClick={() => onAccept?.(transfer.id)}>
            <Check size={16} />
            接受
          </button>
          <button className="secondary compact" type="button" onClick={() => onReject?.(transfer.id)}>
            <X size={16} />
            拒绝
          </button>
        </div>
      )}
      {canSave && (
        <>
          <p className="transfer-tip">
            浏览器支持时会选择保存位置；<br />
            否则会按默认下载设置保存。
          </p>
          <div className="file-transfer-actions">
            <button className="primary compact direct-button" type="button" onClick={() => onSave?.(transfer)}>
              <Download size={16} />
              保存
            </button>
          </div>
        </>
      )}
      {canRetry && (
        <div className="file-transfer-actions">
          <button className="secondary compact" type="button" onClick={() => onRetry?.(transfer.id)}>
            <RefreshCw size={16} />
            重新发送
          </button>
        </div>
      )}
    </div>
  );
}


export function getWorkspaceSingleImageAttachment<
  T extends { id: string; status: string; mimeType: string }
>(
  blocks: Array<{ type: string; attachmentId?: string }>,
  attachments?: T[]
): T | null {
  const onlyBlock = blocks.length === 1 ? blocks[0] : null;
  return onlyBlock?.type === "attachment" &&
    attachments?.length === 1 &&
    attachments[0].id === onlyBlock.attachmentId &&
    attachments[0].status === "available" &&
    isPreviewableImageMimeType(attachments[0].mimeType)
      ? attachments[0]
      : null;
}

function WorkspaceConversationAvatar({
  conversation,
  currentUserId,
  className = ""
}: {
  conversation: WorkspaceConversation;
  currentUserId?: string;
  className?: string;
}) {
  if (conversation.type === "direct") {
    return (
      <WorkspaceAvatar
        name={workspaceConversationTitle(conversation, currentUserId)}
        avatarUrl={conversation.otherMember?.avatarUrl}
        className={className}
        decorative
      />
    );
  }
  return (
    <span className={`workspace-avatar workspace-group-avatar ${className}`.trim()} aria-hidden="true">
      {conversation.avatarEmoji || <UsersRound size={17} />}
    </span>
  );
}

function WorkspaceGroupAvatarEditor({
  value,
  onChange,
  label
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const normalized = normalizeWorkspaceGroupAvatarEmoji(value);
  return (
    <fieldset className="workspace-group-avatar-editor">
      <legend>{label}（可选）</legend>
      <div className="workspace-group-avatar-input">
        <span className="workspace-avatar workspace-group-avatar" aria-hidden="true">
          {normalized || <UsersRound size={18} />}
        </span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="text"
          maxLength={32}
          placeholder="输入单个 emoji"
          aria-label="输入群头像 emoji"
          aria-invalid={normalized === null}
        />
        {value && (
          <button className="icon-button" type="button" title="恢复默认群头像" onClick={() => onChange("")}>
            <X size={15} />
          </button>
        )}
      </div>
      <div className="workspace-group-avatar-presets" aria-label="选择群头像">
        {WORKSPACE_GROUP_AVATAR_PRESETS.map((emoji) => (
          <button
            className={normalized === emoji ? "active" : ""}
            type="button"
            key={emoji}
            aria-label={`使用 ${emoji} 作为群头像`}
            aria-pressed={normalized === emoji}
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {normalized === null && <small className="field-error">请输入一个完整的 emoji。</small>}
    </fieldset>
  );
}

function WorkspaceFileCategoryTabs({
  value,
  onChange,
  ariaLabel = "文件类型筛选"
}: {
  value: WorkspaceFileCategory;
  onChange: (value: WorkspaceFileCategory) => void;
  ariaLabel?: string;
}) {
  return (
    <SegmentedControl className="dl-file-category-control" label={ariaLabel} hideLabel value={value} onValueChange={(next) => { if (next === "all" || next === "media" || next === "document" || next === "other") onChange(next); }} options={[
      { value: "all", label: "全部" }, { value: "media", label: "图片" },
      { value: "document", label: "文档" }, { value: "other", label: "其它" }
    ]} />
  );
}

function WorkspaceFileViewToggle({
  value,
  onChange
}: {
  value: WorkspaceFileViewMode;
  onChange: (value: WorkspaceFileViewMode) => void;
}) {
  return <ViewModeSwitch label="文件展示方式" value={value} onValueChange={onChange} />;
}

function WorkspaceFileThumbnail({
  file,
  compact = false,
  large = false
}: {
  file: WorkspaceAttachment;
  compact?: boolean;
  large?: boolean;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewable = file.status === "available" && isPreviewableImageMimeType(file.mimeType);
  const category = classifyWorkspaceFile(file);

  useEffect(() => {
    setPreviewFailed(false);
  }, [file.id, file.mimeType, file.status]);

  return (
    <span className={`workspace-file-thumbnail${compact ? " compact" : ""}${large ? " large" : ""}`} aria-hidden="true">
      {previewable && !previewFailed ? (
        <img
          src={`/api/workspace/files/${encodeURIComponent(file.id)}/preview`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        category === "media" ? <FileVideo size={compact ? 16 : 20} /> :
          category === "document" ? <FileText size={compact ? 16 : 20} /> :
            <FileCheck2 size={compact ? 16 : 20} />
      )}
    </span>
  );
}



function WorkspacePendingAttachmentList({ attachments }: { attachments: WorkspaceComposerAttachment[] }) {
  return (
    <div className="workspace-pending-attachment-list" aria-label="后台上传附件">
      {attachments.map((attachment) => (
        <div className={`workspace-pending-attachment ${attachment.state}`} key={attachment.id}>
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <span className="workspace-pending-attachment-icon" aria-hidden="true">
              <FileUp size={17} />
            </span>
          )}
          <span className="workspace-pending-attachment-copy">
            <strong>{attachment.file.name}</strong>
            <small>
              {formatBytes(attachment.file.size)} · {
                attachment.state === "queued"
                  ? "等待上传"
                  : attachment.state === "uploading"
                    ? `上传中 ${attachment.progress}%`
                    : attachment.state === "uploaded"
                      ? "上传完成，等待发送"
                      : attachment.failureReason || "上传失败"
              }
            </small>
            {(attachment.state === "queued" || attachment.state === "uploading") && (
              <span className="workspace-upload-progress" aria-hidden="true">
                <i style={{ width: `${attachment.progress}%` }} />
              </span>
            )}
          </span>
          {attachment.state === "uploaded" && <Check size={16} className="workspace-pending-attachment-check" aria-hidden="true" />}
          {attachment.state === "failed" && <AlertCircle size={16} className="workspace-pending-attachment-error" aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

export function WorkspaceStructuredMessage({
  message,
  onOpenAttachment,
  onPreviewImage,
  onPreviewEmoteCollection,
  onOpenTopic,
  cardRevisionById,
  mentionMembers
}: {
  message: Message;
  onOpenAttachment?: (attachment: WorkspaceAttachment) => void;
  onPreviewImage?: (attachment: WorkspaceAttachment) => void;
  onPreviewEmoteCollection?: (shareId: string) => void;
  onOpenTopic?: (topicId: string) => void;
  cardRevisionById?: Record<string, number>;
  mentionMembers?: Array<{ id: string; displayName: string }>;
}) {
  const [textExpanded, setTextExpanded] = useState(false);
  const blocks = message.content?.blocks ?? [];
  const hasUnknownBlock = blocks.some((block) => !isKnownWorkspaceMessageBlock(block));
  if (message.lane === "workspace" && blocks.length === 0 && message.pendingAttachments?.length) {
    return <></>;
  }
  if (message.lane !== "workspace" || blocks.length === 0 || hasUnknownBlock) {
    return <MessageBody body={message.body} />;
  }

  const attachmentsById = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const mentionLabels = new Map((mentionMembers ?? []).map((member) => [member.id, member.displayName]));
  const singleImageAttachment = getWorkspaceSingleImageAttachment(blocks, message.attachments);

  if (singleImageAttachment) {
    return (
      <div data-native-context className="message-body structured-message image-only">
        <button
          className="message-image-only"
          type="button"
          aria-label={`预览图片 ${singleImageAttachment.fileName}`}
          onClick={() => onPreviewImage?.(singleImageAttachment)}
        >
          <img
            className="message-image-preview"
            src={`/api/workspace/files/${encodeURIComponent(singleImageAttachment.id)}/preview`}
            alt={singleImageAttachment.fileName}
            decoding="async"
            loading="lazy"
          />
        </button>
      </div>
    );
  }

  const contentBlocks = blocks.filter((block) => block.type !== "attachment");
  const singleImageEmote = contentBlocks.length === 1 && (
    (contentBlocks[0]?.type === "text" && isSingleImageEmoteText(contentBlocks[0].text)) ||
    (contentBlocks[0]?.type === "emoji" && /^custom:[a-f0-9-]{36}$/i.test(contentBlocks[0].shortcode))
  );
  const attachmentBlocks = blocks.flatMap((block, index) => block.type === "attachment"
    ? [{ index, attachment: attachmentsById.get(block.attachmentId) }]
    : []);
  const imageAttachments = attachmentBlocks
    .map(({ attachment }) => attachment)
    .filter((attachment): attachment is WorkspaceAttachment => Boolean(
      attachment && attachment.status === "available" && isPreviewableImageMimeType(attachment.mimeType)
    ));
  const imageAttachmentIds = new Set(imageAttachments.map((attachment) => attachment.id));
  const fileAttachmentBlocks = attachmentBlocks.filter(({ attachment }) => !attachment || !imageAttachmentIds.has(attachment.id));
  const collapsible = shouldCollapseWorkspaceMessageText(contentBlocks);
  const contentId = `workspace-message-text-${message.id.replace(/[^a-z0-9_-]/gi, "")}`;

  return (
    <div data-native-context className="message-body structured-message">
      {contentBlocks.length > 0 && (
        <div
          className={`${collapsible && !textExpanded ? "message-content-flow workspace-message-text collapsed" : "message-content-flow workspace-message-text"}${singleImageEmote ? " emote-only" : ""}`}
          id={contentId}
        >
          {contentBlocks.map((block, index) => {
            if (block.type === "text") {
              return <WorkspaceMarkdown key={`${index}-text`}>{block.text}</WorkspaceMarkdown>;
            }
            if (block.type === "mention") {
              return (
                <span className="message-mention" key={`${index}-mention`}>
                  @{mentionLabels.get(block.userId) || block.label}
                </span>
              );
            }
            if (block.type === "link") {
              return (
                <a className="message-link" href={block.url} key={`${index}-link`} rel="noopener noreferrer" target="_blank">
                  {block.label || block.url}
                </a>
              );
            }
            if (block.type === "emoji") {
              const customId = /^custom:([a-f0-9-]{36})$/i.exec(block.shortcode)?.[1];
              return customId ? (
                <img
                  key={`${index}-emoji`}
                  className="message-emote-image workspace-custom-emote-image"
                  src={`/api/workspace/emotes/${encodeURIComponent(customId)}/content`}
                  alt="收藏表情"
                  decoding="async"
                  loading="lazy"
                />
              ) : <span key={`${index}-emoji`}>{renderMessageParts(block.shortcode)}</span>;
            }
            if (block.type === "emote_collection") {
              return <WorkspaceEmoteCollectionMessageCard key={`${index}-emote-collection`} block={block} onOpen={onPreviewEmoteCollection} />;
            }
            if (block.type === "topic_reference") {
              return (
                <button
                  className="workspace-topic-reference"
                  key={`${index}-topic-reference`}
                  type="button"
                  onClick={() => onOpenTopic?.(block.topicId)}
                >
                  <Hash size={14} aria-hidden="true" />
                  <span>#{block.title}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              );
            }
            if (block.type === "card") {
              return supportsWorkspaceInteractiveCard(block) ? (
                <WorkspaceInteractiveCard key={`${index}-card`} block={block} onOpenTopic={onOpenTopic} revisionSignal={cardRevisionById?.[block.cardId] ?? 0} />
              ) : (
                <div className="workspace-card-fallback" key={`${index}-card`} role="status">
                  <strong>{block.fallbackText}</strong>
                  <small>此卡片暂不支持交互</small>
                </div>
              );
            }
            return <span key={`${index}-fallback`}>{renderMessageParts(message.body)}</span>;
          })}
        </div>
      )}
      {collapsible && (
        <button
          className="workspace-message-expand"
          type="button"
          aria-controls={contentId}
          aria-expanded={textExpanded}
          onClick={() => setTextExpanded((expanded) => !expanded)}
        >
          {textExpanded ? "收起" : "展开全文"}
          {textExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
      {imageAttachments.length > 0 && (
        <div
          className={imageAttachments.length === 1 ? "message-image-grid single" : "message-image-grid multiple"}
          aria-label={`${imageAttachments.length} 张图片`}
        >
          {imageAttachments.map((attachment) => (
            <button
              className="message-image-tile"
              type="button"
              key={attachment.id}
              aria-label={`预览图片 ${attachment.fileName}`}
              onClick={() => {
                if (onPreviewImage) {
                  onPreviewImage(attachment);
                  return;
                }
                onOpenAttachment?.(attachment);
              }}
            >
              <img
                className="message-image-preview"
                src={`/api/workspace/files/${encodeURIComponent(attachment.id)}/preview`}
                alt={attachment.fileName}
                decoding="async"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {fileAttachmentBlocks.length > 0 && (
        <div className="message-file-list">
          {fileAttachmentBlocks.map(({ attachment, index }) => (
            <button
              className="message-file-card"
              type="button"
              key={`${index}-attachment`}
              aria-label={attachment ? `查看文件 ${attachment.fileName}` : "文件不可用"}
              disabled={!attachment || attachment.status !== "available"}
              onClick={() => attachment && onOpenAttachment?.(attachment)}
            >
              <FileCheck2 size={18} />
              <span>
                <strong>{attachment?.fileName || "文件"}</strong>
                <small>
                  {attachment ? `${formatBytes(attachment.byteSize)} · ${attachment.status === "available" ? "可查看" : "不可用"}` : "文件不可用"}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


function WorkspaceEmoteCollectionMessageCard({
  block,
  onOpen
}: {
  block: Extract<WorkspaceContentBlock, { type: "emote_collection" }>;
  onOpen?: (shareId: string) => void;
}) {
  const share = block.share;
  if (!share || share.revokedAt) {
    return (
      <div className="workspace-emote-share-card unavailable" aria-label="表情合集已停止分享">
        <Images size={20} />
        <span><strong>合集已停止分享</strong><small>历史消息仍保留，但无法再预览或导入。</small></span>
      </div>
    );
  }
  return (
    <button className="workspace-emote-share-card" type="button" onClick={() => onOpen?.(share.id)}>
      <span className="workspace-emote-share-cover" aria-hidden="true">
        {(share.covers ?? []).slice(0, 4).map((item) => <img key={item.id} src={item.src} alt="" />)}
        {(share.covers?.length ?? 0) === 0 && <Images size={24} />}
      </span>
      <span>
        <strong>{share.name}</strong>
        <small>{share.itemCount} 张 · {share.originalCreator.displayName} 创建</small>
        <em>{share.sharedBy.displayName} 分享</em>
      </span>
      <ChevronDown size={16} className="workspace-emote-share-open" />
    </button>
  );
}

type WorkspaceSkeletonVariant = "conversation" | "message" | "file" | "member" | "setting";

function WorkspaceSkeletonRows({
  variant,
  count
}: {
  variant: WorkspaceSkeletonVariant;
  count: number;
}) {
  return (
    <div className={`workspace-skeleton-list ${variant}`}>
      {Array.from({ length: count }, (_, index) => (
        <div className="workspace-skeleton-row" key={index}>
          <span className="workspace-skeleton-avatar" />
          <span className="workspace-skeleton-lines">
            <i />
            <i />
          </span>
          <span className="workspace-skeleton-tail" />
        </div>
      ))}
    </div>
  );
}

function WorkspaceShellSkeleton() {
  return (
    <div className="workspace-product-shell workspace-skeleton-shell">
      <span className="sr-only" role="status">正在加载共享空间</span>
      <aside className="workspace-rail" aria-hidden="true">
        <div className="workspace-skeleton-brand">
          <span className="workspace-skeleton-avatar" />
          <span />
        </div>
        <WorkspaceSkeletonRows variant="conversation" count={7} />
      </aside>
      <section className="workspace-main" aria-hidden="true">
        <div className="workspace-skeleton-chat-header" />
        <WorkspaceSkeletonRows variant="message" count={8} />
        <div className="workspace-skeleton-composer" />
      </section>
      <aside className="workspace-context" aria-hidden="true">
        <div className="workspace-skeleton-chat-header" />
        <WorkspaceSkeletonRows variant="setting" count={5} />
      </aside>
    </div>
  );
}

function WorkspaceShell({
  mobilePane,
  contextVisible,
  railCollapsed,
  hasObjectList = true,
  children
}: {
  mobilePane: WorkspaceMobilePane;
  contextVisible: boolean;
  railCollapsed?: boolean;
  hasObjectList?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`workspace-product-shell mobile-pane-${mobilePane}${contextVisible ? "" : " context-hidden"}${railCollapsed ? " rail-collapsed" : ""}${hasObjectList ? "" : " object-list-hidden"}`}>
      {children}
    </div>
  );
}

function WorkspaceContextDrawer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="workspace-context" aria-label={label}>
      {children}
    </aside>
  );
}


function WorkspaceReactionBar({
  messageId,
  reactions,
  currentUserId,
  pendingKeys,
  onToggle
}: {
  messageId: string;
  reactions: WorkspaceReactionGroup[];
  currentUserId: string;
  pendingKeys: string[];
  onToggle?: (messageId: string, emoteKey: string) => void;
}) {
  if (reactions.length === 0) {
    return <></>;
  }
  return (
    <div className="workspace-reaction-bar" aria-label="消息表情回复">
      {reactions.map((group) => {
        const names = group.users.map((user) => user.id === currentUserId ? "你" : user.displayName);
        const fullNames = names.join("、");
        const compactLabel = names.length <= 2 ? fullNames : String(group.count);
        const emote = getReactionEmote(group.emoteKey);
        const pending = pendingKeys.includes(`${messageId}::${group.emoteKey}`);
        return (
          <button
            className={group.reactedByCurrentUser ? "workspace-reaction active" : "workspace-reaction"}
            type="button"
            key={group.emoteKey}
            aria-label={`${emote?.item.label || "表情"}，${fullNames || `${group.count} 人`}`}
            aria-pressed={group.reactedByCurrentUser}
            disabled={pending || !onToggle}
            title={fullNames}
            onClick={() => onToggle?.(messageId, group.emoteKey)}
          >
            <ReactionEmoteGlyph emoteKey={group.emoteKey} />
            <span>{compactLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
type WorkspaceChatExperienceProps = Omit<WorkspaceChatPanelProps<Message>, "renderMessageContent"> & {
  autoHidePreferences?: WorkspaceAutoHidePreferences | null;
  onOpenAttachment?: (attachment: WorkspaceAttachment) => void;
  onPreviewImage?: (attachment: WorkspaceAttachment) => void;
  onPreviewEmoteCollection?: (shareId: string) => void;
  onOpenTopic?: (topicId: string) => void;
  cardRevisionById?: Record<string, number>;
  reactionPendingKeys?: string[];
  echoInteractionSlot?: WorkspaceEchoInteractionSlot;
  onEchoCommandAccepted?: (request: WorkspaceEchoCommandRequest) => void;
  onEchoWorkflowIdChange?: (workflowId: string | null) => void;
  onDismissEchoInteraction?: () => void;
};

/** One complete Workspace experience for a conversation or its topic. */
function WorkspaceChatPanel(props: WorkspaceChatExperienceProps) {
  const { autoHidePreferences, onOpenAttachment, onPreviewImage, onPreviewEmoteCollection,
    onOpenTopic, cardRevisionById, mentionMembers = [], onToggleReaction,
    reactionPendingKeys = [], currentUserId, echoInteractionSlot,
    onEchoCommandAccepted, onEchoWorkflowIdChange, onDismissEchoInteraction } = props;
  const [clickImageEmoteToSend, setClickImageEmoteToSend] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings")
      .then((data) => {
        if (!cancelled) setClickImageEmoteToSend(data.settings.clickImageEmoteToSend);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return <SharedWorkspaceChatPanel<Message>
    {...props}
    clickImageEmoteToSend={clickImageEmoteToSend}
    renderMessageContent={(message) => <WorkspaceAutoHiddenContent preferences={autoHidePreferences} blocks={message.content?.blocks ?? []} fallbackText={message.body} attachments={message.attachments}><WorkspaceStructuredMessage message={message} onOpenAttachment={onOpenAttachment} onPreviewImage={onPreviewImage} onPreviewEmoteCollection={onPreviewEmoteCollection} onOpenTopic={onOpenTopic} cardRevisionById={cardRevisionById} mentionMembers={mentionMembers} /></WorkspaceAutoHiddenContent>}
    renderPendingAttachments={(message) => message.pendingAttachments?.length ? <WorkspacePendingAttachmentList attachments={message.pendingAttachments} /> : null}
    renderReactions={(message) => <WorkspaceReactionBar messageId={message.id} reactions={message.reactions ?? []} currentUserId={currentUserId} pendingKeys={reactionPendingKeys} onToggle={onToggleReaction} />}
    canFavoriteMessage={(message) => Boolean(getWorkspaceEmoteFavoriteSource(message))}
    renderEchoInteraction={(restoreFocus) => echoInteractionSlot && onEchoCommandAccepted && onEchoWorkflowIdChange && onDismissEchoInteraction ? <WorkspaceEchoInteraction slot={echoInteractionSlot} onCommandAccepted={onEchoCommandAccepted} onWorkflowIdChange={onEchoWorkflowIdChange} onDismiss={onDismissEchoInteraction} onRestoreFocus={restoreFocus} /> : null}
    renderEmotePicker={(pickerProps) => <EmotePicker {...pickerProps} />}
  />;
}

function ChatPanel({
  scopeKey,
  title,
  subtitle,
  hideTitle = false,
  leadingAction,
  trailingAction,
  details,
  status,
  waitingContent,
  messages,
  messageListRef,
  onMessageListScroll,
  olderMessagesAvailable = false,
  olderMessagesLoading = false,
  onLoadOlderMessages,
  draft,
  onDraft,
  onSend,
  onFile,
  onReply,
  onRetryMessage,
  replyTarget,
  onCancelReply,
  onOpenAttachment,
  mentionMembers,
  onAcceptFile,
  onRejectFile,
  onSaveFile,
  onRetryFile,
  onEnd,
  fileLabel,
  fileInputDisabled = false,
  fileInputTitle,
  sending = false
}: {
  scopeKey: string;
  title: string;
  subtitle: string;
  hideTitle?: boolean;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  details?: ReactNode;
  status: ReactNode;
  waitingContent?: ReactNode;
  messages: Message[];
  messageListRef?: RefObject<HTMLDivElement | null>;
  onMessageListScroll?: (list: HTMLDivElement) => void;
  olderMessagesAvailable?: boolean;
  olderMessagesLoading?: boolean;
  onLoadOlderMessages?: () => void;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onFile: (file: File) => void;
  onReply?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  replyTarget?: Message | null;
  onCancelReply?: () => void;
  onOpenAttachment?: (attachment: WorkspaceAttachment) => void;
  mentionMembers?: WorkspaceUser[];
  onAcceptFile?: (transferId: string) => void;
  onRejectFile?: (transferId: string) => void;
  onSaveFile?: (transfer: FileTransfer) => void;
  onRetryFile?: (transferId: string) => void;
  onEnd?: () => void;
  fileLabel: string;
  fileInputDisabled?: boolean;
  fileInputTitle?: string;
  sending?: boolean;
}) {
  const localMessageListRef = useRef<HTMLDivElement | null>(null);
  const actionListRef = messageListRef ?? localMessageListRef;
  const objectActions = useObjectActionScope(scopeKey, messages.map((message) => message.id), actionListRef);
  const actionMessage = messages.find((message) => message.id === objectActions.targetId);
  const currentObjectScope = useRef(scopeKey);
  currentObjectScope.current = scopeKey;
  const [copyFeedback, setCopyFeedback] = useState<{ scopeKey: string; copied: boolean } | null>(null);
  const [emotePanelOpen, setEmotePanelOpen] = useState(false);
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const emoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const canMention = Boolean(mentionMembers?.length);
  const messageObjectActions = (message: Message): ObjectAction[] => {
    const actions: ObjectAction[] = [];
    if (message.body.trim()) actions.push({
      id: "copy", label: "复制正文", icon: <Copy size={17} />,
      onSelect: () => {
        const trigger = objectActions.menuProps.returnFocus;
        void copyText(message.body).catch(() => false).then((copied) => {
          if (currentObjectScope.current !== scopeKey) return;
          setCopyFeedback({ scopeKey, copied });
          // The legacy clipboard fallback briefly focuses a temporary textarea.
          if ((document.activeElement === document.body || document.activeElement === actionListRef.current) && trigger?.isConnected) trigger.focus({ preventScroll: true });
        });
      }
    });
    if (message.localState === "failed" && onRetryMessage) actions.push({ id: "retry-message", label: "重试发送", icon: <RefreshCw size={17} />, onSelect: () => onRetryMessage(message.id) });
    const transfer = message.fileTransfer;
    if (transfer) {
      // Match FileTransferCard's current state/ownership gates. These callbacks
      // continue to own encrypted transport and explicit browser-only saving.
      if (!message.self && transfer.status === "offered") {
        if (onAcceptFile) actions.push({ id: "accept", label: "接受文件", icon: <Check size={17} />, onSelect: () => onAcceptFile(transfer.id) });
        if (onRejectFile) actions.push({ id: "reject", label: "拒绝文件", icon: <X size={17} />, onSelect: () => onRejectFile(transfer.id) });
      }
      if (!message.self && transfer.status === "complete" && onSaveFile) actions.push({ id: "save", label: "保存到本机", icon: <Download size={17} />, onSelect: () => onSaveFile(transfer) });
      if (message.self && transfer.retryable && (transfer.status === "failed" || transfer.status === "rejected") && onRetryFile) actions.push({ id: "retry-file", label: "重新发送文件", icon: <RefreshCw size={17} />, onSelect: () => onRetryFile(transfer.id) });
    }
    return actions;
  };
  const insertEmote = (item: EmoteItem) => {
    const insertText = getEmoteInsertText(item);
    const nextDraft =
      item.kind === "image"
        ? `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${insertText} `
        : `${draft}${insertText}`;
    onDraft(nextDraft);
    setEmotePanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const insertMention = (member: WorkspaceUser) => {
    const insertText = `@${member.displayName}`;
    const nextDraft = `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${insertText} `;
    onDraft(nextDraft);
    setMentionPanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const closeP2pComposerPopover = () => {
    setEmotePanelOpen(false);
    setMentionPanelOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const toolPanelOpen = emotePanelOpen || mentionPanelOpen;
  useEffect(() => {
    if (!toolPanelOpen) {
      return;
    }
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !composerFormRef.current?.contains(target)) {
        setEmotePanelOpen(false);
        setMentionPanelOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [toolPanelOpen]);
  const sendDisabled = sending || !draft.trim();
  const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeCompositionEnter(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeP2pComposerPopover();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (!sendDisabled) {
      composerFormRef.current?.requestSubmit();
    }
  };
  const handleDraftPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (fileInputDisabled || sending) {
      return;
    }
    const image = Array.from(event.clipboardData.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile() ?? Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
    if (!image) {
      return;
    }
    event.preventDefault();
    onFile(renamePastedImageFiles([image])[0]);
  };

  return (
    <section className="chat-panel" aria-label={title}>
      <header className="chat-header">
        {leadingAction}
        <div className={hideTitle ? "chat-heading title-hidden" : "chat-heading"}>
          <p className="eyebrow">{subtitle}</p>
          {!hideTitle && <h2>{title}</h2>}
        </div>
        <div className="chat-status">
          {status}
          {trailingAction}
          {onEnd && (
            <button className="secondary compact" type="button" onClick={onEnd}>
              <LogOut size={16} />
              结束
            </button>
          )}
        </div>
      </header>
      <div className="chat-extras">
        {details}
      </div>
      <div
        className="message-list"
        ref={actionListRef}
        tabIndex={-1}
        aria-label="直连消息列表"
        aria-live="polite"
        onScroll={(event) => onMessageListScroll?.(event.currentTarget)}
      >
        {waitingContent}
        {olderMessagesAvailable && onLoadOlderMessages && (
          <div className="message-history-control">
            <button className="secondary compact" type="button" disabled={olderMessagesLoading} onClick={onLoadOlderMessages}>
              <History size={15} />
              {olderMessagesLoading ? "加载中" : "加载更早消息"}
            </button>
          </div>
        )}
        {messages.length === 0 && !waitingContent ? (
          <div className="empty-state">
            <MessageSquare size={26} />
            <span>还没有消息。</span>
          </div>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const dayKey = getMessageDayKey(message.createdAt);
            const previousDayKey = getMessageDayKey(previous?.createdAt);
            const showDaySeparator = Boolean(message.createdAt && dayKey !== previousDayKey);
            const messageTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
            const previousTime = previous?.createdAt ? Date.parse(previous.createdAt) : Number.NaN;
            const groupedWithPrevious = Boolean(
              previous &&
                !message.replyTo &&
                message.author === previous.author &&
                message.self === previous.self &&
                message.author !== "系统" &&
                dayKey &&
                dayKey === previousDayKey &&
                Number.isFinite(messageTime) &&
                Number.isFinite(previousTime) &&
                messageTime - previousTime >= 0 &&
                messageTime - previousTime <= 5 * 60 * 1000
            );
            const messageClassName = [
              message.self ? "message self" : message.author === "系统" ? "message system" : "message",
              groupedWithPrevious ? "grouped" : ""
            ].filter(Boolean).join(" ");
            return (
              <Fragment key={message.id}>
                {showDaySeparator && (
                  <div className="message-day-separator" role="separator">
                    <span>{formatMessageDayLabel(message.createdAt)}</span>
                  </div>
                )}
                <article {...objectActions.bindObject(message.id)} className={messageClassName} data-message-id={message.id}>
                  <div className="p2p-object-heading">
                  {!groupedWithPrevious && (
                    <div className="message-meta">
                      <strong>{message.author}</strong>
                      <span>{message.at}</span>
                    </div>
                  )}
                  {messageObjectActions(message).length > 0 && <button className="dl-object-more" type="button" title="更多直连消息操作" aria-label={`更多直连消息操作：${message.author}`} aria-haspopup="menu" aria-expanded={objectActions.menuProps.open && objectActions.targetId === message.id} onClick={(event) => objectActions.openFromTrigger(message.id, event.currentTarget)}><Ellipsis size={18} /></button>}
                  </div>
                  {message.replyTo && (
                    <div className="reply-preview" data-native-context>
                      <strong>{message.replyTo.author}</strong>
                      <span>{message.replyTo.body}</span>
                    </div>
                  )}
                  <div data-native-context><WorkspaceStructuredMessage message={message} onOpenAttachment={onOpenAttachment} /></div>
                  {message.fileTransfer && (
                    <FileTransferCard
                      transfer={message.fileTransfer}
                      self={Boolean(message.self)}
                      onAccept={onAcceptFile}
                      onReject={onRejectFile}
                      onSave={onSaveFile}
                      onRetry={onRetryFile}
                    />
                  )}
                  {message.fileName && !message.content?.blocks.some((block) => block.type === "attachment") && (
                    <span className="file-chip" data-native-context>
                      <FileUp size={14} />
                      {message.fileName}
                    </span>
                  )}
                  {message.localState && (
                    <div className={`message-local-state ${message.localState}`}>
                      <span>
                        {message.localState === "sending"
                          ? "发送中"
                          : message.localState === "delivered"
                            ? "已送达"
                            : message.failureReason || "发送失败"}
                      </span>
                      {message.localState === "failed" && onRetryMessage && (
                        <button type="button" onClick={() => onRetryMessage(message.id)}>
                          <RefreshCw size={14} />
                          重试
                        </button>
                      )}
                    </div>
                  )}
                  {onReply && message.author !== "系统" && !message.localState && (
                    <button className="message-reply" type="button" onClick={() => onReply(message.id)}>
                      回复
                    </button>
                  )}
                </article>
              </Fragment>
            );
          })
        )}
        {actionMessage && <ObjectActionMenu {...objectActions.menuProps} label="直连消息操作" summary={actionMessage.fileTransfer?.name || actionMessage.author} actions={messageObjectActions(actionMessage)} />}
      </div>
      {copyFeedback?.scopeKey === scopeKey && <div className="p2p-object-feedback" data-copied={copyFeedback.copied} role="status"><span>{copyFeedback.copied ? "正文已复制" : "复制失败，请选择正文后手动复制"}</span><button className="dl-object-more" type="button" aria-label="关闭复制提示" onClick={() => setCopyFeedback(null)}><X size={16} /></button></div>}
      <div className="composer-dock">
        {replyTarget && (
        <div className="composer-reply">
          <span>
            回复 <strong>{replyTarget.author}</strong>：{replyTarget.body}
          </span>
          <button className="icon-button" type="button" title="取消回复" onClick={onCancelReply}>
            <X size={15} />
          </button>
        </div>
        )}
      <form
        ref={composerFormRef}
        className={toolPanelOpen ? "composer tool-open" : "composer"}
        onSubmit={onSend}
        onKeyDown={(event) => {
          if (event.key === "Escape" && toolPanelOpen) {
            event.preventDefault();
            closeP2pComposerPopover();
          }
        }}
      >
        <label
          className={fileInputDisabled ? "file-button disabled" : "file-button"}
          title={fileInputTitle ?? fileLabel}
          aria-disabled={fileInputDisabled}
        >
          <FileUp size={17} />
          <input
            type="file"
            aria-label={fileLabel}
            disabled={fileInputDisabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                onFile(file);
                event.currentTarget.value = "";
              }
            }}
          />
        </label>
        <div className="composer-tools">
          <div className="composer-tool-buttons">
            <button
              ref={emoteTriggerRef}
              className="secondary composer-tool-button"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={emotePanelOpen}
              aria-controls="p2p-composer-emote-picker"
              title="插入表情"
              onClick={() => {
                setMentionPanelOpen(false);
                setEmotePanelOpen((open) => !open);
              }}
            >
              <Smile size={17} />
            </button>
            {canMention && (
              <button
                ref={mentionTriggerRef}
                className="secondary composer-tool-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={mentionPanelOpen}
                aria-controls="p2p-composer-mention-picker"
                title="提及成员"
                onClick={() => {
                  setEmotePanelOpen(false);
                  setMentionPanelOpen((open) => !open);
                }}
              >
                <AtSign size={17} />
              </button>
            )}
          </div>
          {emotePanelOpen && (
            <EmotePicker
              id="p2p-composer-emote-picker"
              onSelect={insertEmote}
              onEscape={closeP2pComposerPopover}
            />
          )}
          {mentionPanelOpen && mentionMembers && (
            <MentionPicker
              id="p2p-composer-mention-picker"
              members={mentionMembers}
              onSelect={insertMention}
              onEscape={closeP2pComposerPopover}
            />
          )}
        </div>
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          onPaste={handleDraftPaste}
          placeholder="输入消息"
          aria-label="输入消息"
          disabled={sending}
        />
        <button className="primary send-button" type="submit" disabled={sendDisabled} title={sending ? "发送中" : "发送消息"}>
          <Send size={18} />
          <span>{sending ? "发送中" : "发送"}</span>
        </button>
      </form>
      </div>
    </section>
  );
}



function MentionPicker({ members, ...props }: {
  id?: string;
  members: WorkspaceUser[];
  activeIndex?: number;
  onSelect: (member: WorkspaceUser) => void;
  onEscape?: () => void;
}) {
  return <SharedMentionPicker {...props} members={members.map((member) => ({ ...member, secondaryText: workspaceMemberSecondaryText(member) }))} />;
}

function EmotePicker({
  id,
  onSelect,
  onEscape,
  label = "选择表情",
  workspaceFeatures,
  onManageEmotes
}: {
  id?: string;
  onSelect: (item: EmoteItem, packId: EmotePack["id"]) => void;
  onEscape?: () => void;
  label?: string;
  workspaceFeatures?: "composer" | "reaction";
  onManageEmotes?: () => void;
}) {
  const initialPackIds = workspaceFeatures === "composer"
    ? ["custom" as const, ...visibleEmotePacks.map((pack) => pack.id)]
    : visibleEmotePacks.map((pack) => pack.id);
  const fallbackPackId = workspaceFeatures === "composer" ? "custom" : visibleEmotePacks[0]?.id ?? "emoji";
  const preferenceScope: EmotePickerPreferenceScope = workspaceFeatures === "composer"
    ? "workspace-composer"
    : workspaceFeatures === "reaction"
      ? "workspace-reaction"
      : "p2p";
  const [activePackId, setActivePackId] = useState<EmotePack["id"]>(() =>
    getPreferredEmotePickerPack(preferenceScope, initialPackIds, fallbackPackId)
  );
  const [settings, setSettings] = useState<WorkspaceEmoteSettings | null>(null);
  const [library, setLibrary] = useState<WorkspaceEmoteLibrary | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState("");
  const customInputRef = useRef<HTMLInputElement>(null);
  const customScrollRef = useRef<HTMLDivElement>(null);
  const customHomeScrollRef = useRef(0);
  const activePackIdRef = useRef(activePackId);
  const enabledPackIds = settings?.enabledPackIds ?? visibleEmotePacks.filter((pack) => pack.defaultEnabled !== false).map((pack) => pack.id);
  const enabledPacks = visibleEmotePacks.filter((pack) => enabledPackIds.includes(pack.id as Exclude<EmotePack["id"], "custom">));
  const packs = workspaceFeatures === "composer"
    ? [{ id: "custom" as const, label: "收藏" }, ...enabledPacks.map(({ id, label }) => ({ id, label }))]
    : enabledPacks.map(({ id, label }) => ({ id, label }));
  const activePack = enabledPacks.find((pack) => pack.id === activePackId) ?? enabledPacks[0];
  const activeCollection = library?.collections.find((collection) => collection.id === activeCollectionId) ?? null;
  const activeCollectionReadOnly = isWorkspaceEmoteCollectionReadOnly(activeCollection);
  const unicodeEmojiItems = visibleEmotePacks.find((pack) => pack.id === "emoji")?.items.filter((item) => item.kind === "unicode") ?? [];
  const unicodeEmojiIds = unicodeEmojiItems.map((item) => item.id);
  const [recentEmojiIds, setRecentEmojiIds] = useState(() => getRecentEmojiIds(unicodeEmojiIds));
  const recentEmojiItems = recentEmojiIds.flatMap((id) => {
    const item = unicodeEmojiItems.find((candidate) => candidate.id === id);
    return item ? [item] : [];
  });

  useEffect(() => {
    if (!workspaceFeatures) return;
    let cancelled = false;
    void Promise.all([
      workspaceJson<{ settings: WorkspaceEmoteSettings }>("/api/workspace/me/emote-settings"),
        workspaceFeatures === "composer"
        ? loadWorkspaceEmoteLibrary()
        : Promise.resolve(null)
    ]).then(([settingsResult, libraryResult]) => {
      if (cancelled) return;
      setSettings(settingsResult.settings);
      setLibrary(libraryResult);
    }).catch(() => {
      if (!cancelled) setCustomError("表情设置暂时无法加载");
    });
    return () => { cancelled = true; };
  }, [workspaceFeatures]);

  useEffect(() => {
    if (workspaceFeatures !== "composer") return;
    let cancelled = false;
    const refreshLibrary = () => {
      void loadWorkspaceEmoteLibrary(true)
        .then((next) => {
          if (!cancelled) setLibrary(next);
        })
        .catch(() => {
          if (!cancelled) setCustomError("收藏表情暂时无法刷新");
        });
    };
    window.addEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshLibrary);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshLibrary);
    };
  }, [workspaceFeatures]);

  useEffect(() => {
    if (workspaceFeatures && !settings) return;
    if (packs.some((pack) => pack.id === activePackId)) return;
    setActivePackId(packs[0]?.id ?? "emoji");
  }, [activePackId, packs, settings, workspaceFeatures]);

  useEffect(() => {
    activePackIdRef.current = activePackId;
  }, [activePackId]);

  useEffect(() => () => {
    rememberEmotePickerPackOnClose(preferenceScope, activePackIdRef.current);
  }, [preferenceScope]);

  async function reloadLibrary() {
    setLibrary(await loadWorkspaceEmoteLibrary(true));
  }

  async function uploadCustomEmotes(files: File[]) {
    if (activeCollectionReadOnly) {
      setCustomError("该合集正在订阅原作者更新。关闭订阅后才能上传表情。");
      if (customInputRef.current) customInputRef.current.value = "";
      return;
    }
    const limit = library?.limits.maxBatchItems ?? 50;
    const selected = files.slice(0, limit);
    if (selected.length === 0) return;
    setCustomBusy(true);
    setCustomError("");
    const failures: string[] = [];
    let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(2, selected.length) }, async () => {
        while (cursor < selected.length) {
          const file = selected[cursor++];
          try {
            const query = activeCollectionId
              ? `?collectionId=${encodeURIComponent(activeCollectionId)}&addToLibrary=false`
              : "";
            const uploadResponse = await workspaceFetch(`/api/workspace/me/emotes${query}`, {
              method: "POST",
              headers: {
                "content-type": file.type || "application/octet-stream",
                "x-duallane-file-name": encodeURIComponent(file.name)
              },
              body: file
            });
            await uploadResponse.arrayBuffer();
          } catch (error) {
            failures.push(`${file.name}：${userFacingErrorMessage(error, "上传失败")}`);
          }
        }
      }));
      await reloadLibrary();
      notifyWorkspaceEmoteLibraryChanged();
      if (failures.length > 0) setCustomError(`${failures.length} 张上传失败：${failures[0]}`);
    } finally {
      setCustomBusy(false);
      if (customInputRef.current) customInputRef.current.value = "";
    }
  }

  function selectCustomEmote(emote: WorkspaceCustomEmote) {
    onSelect(workspaceCustomEmoteToItem(emote), "custom");
  }

  function selectBuiltinEmote(item: EmoteItem, packId: EmotePack["id"]) {
    if (packId === "emoji" && item.kind === "unicode") {
      setRecentEmojiIds(recordRecentEmojiUse(item.id, unicodeEmojiIds));
    }
    onSelect(item, packId);
  }

  function openCollection(collectionId: string) {
    customHomeScrollRef.current = customScrollRef.current?.scrollTop ?? 0;
    setActiveCollectionId(collectionId);
    window.requestAnimationFrame(() => customScrollRef.current?.scrollTo({ top: 0 }));
  }

  function closeCollection() {
    setActiveCollectionId("");
    window.requestAnimationFrame(() => customScrollRef.current?.scrollTo({ top: customHomeScrollRef.current }));
  }

  return (
    <div
      className="emote-picker"
      id={id}
      role="dialog"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onEscape?.();
        }
      }}
    >
      <div className="emote-pack-tabs" role="tablist" aria-label="表情包" onKeyDown={handleTabListKeyDown}>
        {packs.map((pack) => (
          <button
            className={pack.id === activePackId ? "active" : ""}
            key={pack.id}
            type="button"
            role="tab"
            aria-selected={pack.id === activePackId}
            onClick={() => {
              setActivePackId(pack.id);
              rememberPreferredEmotePickerPack(preferenceScope, pack.id);
              if (pack.id !== "custom") setActiveCollectionId("");
            }}
            tabIndex={pack.id === activePackId ? 0 : -1}
          >
            {pack.label}
          </button>
        ))}
      </div>
      {activePackId === "custom" ? (
        <div className="emote-custom-pane">
          <div className="emote-custom-toolbar">
            {activeCollection ? (
              <button type="button" className="emote-custom-back" onClick={closeCollection}>
                <ArrowLeft size={15} />
                <span>{activeCollection.name}</span>
                <small>{activeCollection.itemCount}</small>
              </button>
            ) : <span>我的表情</span>}
            {onManageEmotes && (
              <button type="button" className="icon-button" title="管理我的表情" aria-label="管理我的表情" onClick={onManageEmotes}>
                <Settings size={16} />
              </button>
            )}
          </div>
          <div className="emote-grid emote-custom-grid" ref={customScrollRef}>
            <label className={customBusy || activeCollectionReadOnly ? "emote-upload-tile busy" : "emote-upload-tile"} title={activeCollectionReadOnly ? "关闭订阅后才能向合集上传表情" : "批量上传收藏表情"} aria-disabled={customBusy || activeCollectionReadOnly}>
              <Plus size={22} />
              <span>添加</span>
              <input
                ref={customInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
                aria-label={activeCollection ? `向 ${activeCollection.name} 批量上传表情` : "批量上传收藏表情"}
                disabled={customBusy || activeCollectionReadOnly}
                onChange={(event) => void uploadCustomEmotes(Array.from(event.currentTarget.files ?? []))}
              />
            </label>
            {(activeCollection ? activeCollection.items : []).map((emote) => (
              <span className="emote-library-item" key={emote.id}>
                <button className="emote-library-emote" type="button" title={emote.label} aria-label={emote.label} onClick={() => selectCustomEmote(emote)}>
                  <CachedEmoteImage alt="" decoding="async" draggable={false} src={emote.src} />
                </button>
              </span>
            ))}
            {!activeCollection && library?.entries.map((entry) => entry.type === "emote" ? (
              <span className="emote-library-item" key={entry.id}>
                <button className="emote-library-emote" type="button" title={entry.emote.label} aria-label={entry.emote.label} onClick={() => selectCustomEmote(entry.emote)}>
                  <CachedEmoteImage alt="" decoding="async" draggable={false} src={entry.emote.src} />
                </button>
              </span>
            ) : (
              <button className="emote-collection-tile" type="button" key={entry.id} title={`打开合集 ${entry.collection.name}`} onClick={() => openCollection(entry.collection.id)}>
                <span className="emote-collection-cover" aria-hidden="true">
                  {entry.collection.items.slice(0, 4).map((emote) => <CachedEmoteImage key={emote.id} alt="" src={emote.src} />)}
                  {entry.collection.items.length === 0 && <Images size={22} />}
                </span>
                <span>{entry.collection.name}</span>
              </button>
            ))}
          </div>
          {!customBusy && (activeCollection ? activeCollection.items.length === 0 : library?.entries.length === 0) && !customError && (
            <p className="emote-picker-empty">{activeCollection ? activeCollectionReadOnly ? "原合集当前没有表情。" : "合集还没有表情。" : "收藏表情为空，可批量上传或从消息中收藏。"}</p>
          )}
          {customError && <p className="emote-picker-error" role="status">{customError}</p>}
        </div>
      ) : (
        <div className={activePackId === "emoji" ? "emote-builtin-pane with-recents" : "emote-builtin-pane"}>
          <div className="emote-grid emote-builtin-grid">
            {activePack?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                aria-label={item.label}
                onClick={() => selectBuiltinEmote(item, activePack.id)}
              >
                {item.kind === "unicode" ? (
                  <span className="unicode-emote">{item.value}</span>
                ) : (
                  <CachedEmoteImage alt="" decoding="async" draggable={false} src={item.src} />
                )}
              </button>
            ))}
          </div>
          {activePackId === "emoji" && (
            <section className="emote-recent" aria-label="近期常用表情">
              <span>近期常用</span>
              {recentEmojiItems.length > 0 ? (
                <div className="emote-recent-list">
                  {recentEmojiItems.map((item) => (
                    <button key={item.id} type="button" title={item.label} aria-label={`近期常用：${item.label}`} onClick={() => selectBuiltinEmote(item, "emoji")}>
                      <span className="unicode-emote">{item.value}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <small>使用过的 Emoji 会显示在这里</small>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function workspaceCustomEmoteToItem(emote: WorkspaceCustomEmote): EmoteItem {
  return {
    kind: "image",
    id: emote.id,
    customId: emote.kind === "custom" ? emote.id : undefined,
    label: emote.label,
    token: emote.token,
    src: emote.src,
    animated: emote.animated
  };
}
