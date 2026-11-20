import type { DualLaneCardKitDocument } from "@duallane/protocol";

export interface AgentEvent {
  eventId: string;
  sequence: number;
  type: string;
  conversationId: string;
  payload: Record<string, unknown>;
}

export interface AgentReplaySyncState {
  readonly currentSequence: number;
  readonly reason: string;
  /** Server-certified scan position. Use for this scan without checkpointing it. */
  readonly resumeSequence?: number;
}

export interface AgentReplayPage {
  events: AgentEvent[];
  currentSequence?: number;
  hasMore?: boolean;
  syncRequired?: boolean;
  reason?: string;
  /** Inspect all returned events before using this position for the next request. */
  resumeSequence?: number;
}

export type AgentMessageBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label?: string }
  | { type: "link"; url: string; label?: string }
  | { type: "attachment"; attachmentId: string }
  | { type: "emoji"; shortcode: string }
  | { type: "emote_collection"; shareId: string }
  | { type: "topic_reference"; topicId: string; title: string }
  | { type: "card"; cardId: string; cardType: string; schemaVersion: number; fallbackText: string };
export interface AgentMessageContent { format: "duallane.message+json;v=1"; plainText?: string; blocks: AgentMessageBlock[] }
export interface AgentTask { id: string; conversationId: string; triggerMessageId: string; expiresAt: string | number; status?: string }
export type AgentOperation = "message.send" | "message.edit" | "card.send" | "card.update";
export interface AgentOperationReference { taskId: string; operation: AgentOperation; key: string }
export type AgentOperationResult = { status: "committed"; result: Record<string, unknown>; humanRead: false } | { status: "unknown"; safeToRetry: false };
/** This request attempt only; rejected does not rule out an earlier commit for its key. */
export type AgentWriteAttemptOutcome = "rejected" | "unknown";
export interface AgentMessageUpdate { plainText?: string; content?: AgentMessageContent; expectedVersion?: string }
export interface AgentMessageRecord extends Record<string, unknown> { id?: string; conversationId?: string; version?: string }
export interface AgentHistoryQuery { before?: string; limit?: number; query?: string; authorId?: string; startTime?: string | Date; endTime?: string | Date; signal?: AbortSignal }
export interface AgentHistoryPage { messages: Array<Record<string, unknown>>; nextCursor?: string | null; hasMore: boolean; coverage: Record<string, unknown> }
export interface AgentTaskClient {
  readonly task: Readonly<AgentTask>;
  close(): void;
  validate(): Promise<{ valid: true }>;
  budget(): { calls: number; maxCalls: number; resultBytes: number; maxResultBytes: number; expiresAt: number };
  getCapabilities(): Promise<Record<string, unknown>>;
  getOperation(operation: AgentOperation, key: string): Promise<AgentOperationResult>;
  getContext(conversationId?: string, options?: { limit?: number }): Promise<{ messages: Array<Record<string, unknown>> }>;
  getMessage(messageId: string): Promise<{ message: AgentMessageRecord; coverage?: Record<string, unknown> }>;
  listHistory(conversationId?: string, options?: AgentHistoryQuery): Promise<AgentHistoryPage>;
  searchMessages(conversationId: string, options: AgentHistoryQuery & { query: string }): Promise<AgentHistoryPage>;
  listMembers(conversationId?: string): Promise<{ members: Array<Record<string, unknown>> }>;
  sendMessage(input: Parameters<DualLaneAgentClient["sendMessage"]>[0]): ReturnType<DualLaneAgentClient["sendMessage"]>;
  editMessage(messageId: string, input: string | AgentMessageUpdate, options?: { expectedVersion?: string }): ReturnType<DualLaneAgentClient["editMessage"]>;
  sendCard(input: Parameters<DualLaneAgentClient["sendCard"]>[0]): ReturnType<DualLaneAgentClient["sendCard"]>;
  sendFeishuCard(input: Parameters<DualLaneAgentClient["sendFeishuCard"]>[0]): ReturnType<DualLaneAgentClient["sendFeishuCard"]>;
  updateCard(cardId: string, input: { expectedRevision: number; [key: string]: unknown }): ReturnType<DualLaneAgentClient["updateCard"]>;
  updateFeishuCard(cardId: string, input: { card: Record<string, unknown>; expectedRevision: number; fallbackText?: string }): ReturnType<DualLaneAgentClient["updateFeishuCard"]>;
  sendFile(input: Parameters<DualLaneAgentClient["sendFile"]>[0]): ReturnType<DualLaneAgentClient["sendFile"]>;
  readAttachment(input: AgentAttachmentInput): ReturnType<DualLaneAgentClient["readAttachment"]>;
  uploadFile(input: Parameters<DualLaneAgentClient["uploadFile"]>[0]): ReturnType<DualLaneAgentClient["uploadFile"]>;
  reserveUpload(input: Parameters<DualLaneAgentClient["reserveUpload"]>[0]): ReturnType<DualLaneAgentClient["reserveUpload"]>;
  completeUploadContent(uploadId: string, bytes: Uint8Array, mimeType?: string): ReturnType<DualLaneAgentClient["completeUploadContent"]>;
  getUploadStatus(uploadId: string): ReturnType<DualLaneAgentClient["getUploadStatus"]>;
  setTyping(conversationId: string, options?: { state?: "typing" | "thinking"; signal?: AbortSignal; timeoutMs?: number }): ReturnType<DualLaneAgentClient["setTyping"]>;
}
export const AGENT_MESSAGE_FORMAT: "duallane.message+json;v=1";
export function messageText(text: string): AgentMessageBlock;
export function messageMention(userId: string, label?: string): AgentMessageBlock;
export function messageAttachment(attachmentId: string): AgentMessageBlock;
export function messageLink(url: string, label?: string): AgentMessageBlock;
export function buildMessageContent(input: AgentMessageBlock[] | AgentMessageContent): AgentMessageContent;
export function parseMessageContent(input: unknown): { format: string; plainText: string; blocks: Array<AgentMessageBlock | { type: "unsupported"; originalType: string }>; unsupportedBlockTypes: string[]; complete: boolean };
export interface AgentTaskTool { name: string; description: string; inputSchema: Record<string, unknown> }
export const DUALLANE_TASK_TOOLS: readonly AgentTaskTool[];
export function createTaskToolServer(client: AgentTaskClient, options?: { capabilities?: Record<string, unknown> }): { callTool(name: string, input?: Record<string, unknown>, operationId?: string): Promise<unknown>; handleJsonRpc(message: Record<string, unknown>): Promise<unknown>; getTools(): Promise<AgentTaskTool[]>; availableTools(): AgentTaskTool[] };
export function createTaskToolBroker(client: AgentTaskClient, options?: { signal?: AbortSignal; capabilities?: Record<string, unknown> }): Promise<{ descriptor: Record<string, unknown>; environment: Record<string, string>; close(): void }>;
export function createTaskBrokerMcpAdapter(options?: { url?: string; key?: string; fetchImpl?: typeof fetch }): { handleJsonRpc(message: Record<string, unknown>): Promise<unknown> };

export interface AgentAttachmentInput {
  conversationId: string;
  attachmentId: string;
  messageId: string;
  mode?: "content" | "preview";
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface AgentSdkUpgradeInfo {
  minimumSdkVersion: string;
  latestSdkVersion: string;
  runtimeManifestUrl: string;
  docsUrl: string;
  skillUrl: string;
}
export class DualLaneAgentError extends Error {
  code: string;
  statusCode: number | null;
  retryable: boolean;
  operation?: AgentOperationReference;
  attemptOutcome?: AgentWriteAttemptOutcome;
  safeToRetry?: false;
  upgrade?: Readonly<AgentSdkUpgradeInfo>;
}

export interface AgentSetupClientInput {
  clientName?: string;
  /** Host/adapter metadata. The SDK compatibility header always declares the installed SDK version. */
  clientVersion?: string;
  protocolVersion?: string;
}
export class DualLaneAgentSetupClient {
  constructor(options: { url: string; fetch?: typeof fetch });
  request(setupSessionId: string, input?: AgentSetupClientInput & { requestedScopes?: string[]; conversationIds?: string[]; capabilities?: string[] }): Promise<Record<string, unknown>>;
  status(setupSessionId: string): Promise<Record<string, unknown>>;
  exchange(setupSessionId: string, input?: AgentSetupClientInput): Promise<Record<string, unknown>>;
}

export class DualLaneAgentClient {
  constructor(options: { url: string; token: string; fetch?: typeof fetch; adapterVersion?: string; requestTimeoutMs?: number; taskId?: string; onUpgradeRequired?: (error: DualLaneAgentError) => void });
  readonly connected: boolean;
  readonly lastSequence: number;
  getMe(): Promise<Record<string, unknown>>;
  getCapabilities(conversationId?: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  createTask(input: { eventId: string }, options?: { signal?: AbortSignal }): Promise<{ task: AgentTask }>;
  getTask(taskId: string, options?: { signal?: AbortSignal }): Promise<{ task: AgentTask }>;
  cancelAgentTask(taskId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  getOperation(taskId: string, operation: AgentOperation, key: string, options?: { signal?: AbortSignal }): Promise<AgentOperationResult>;
  forTask(task: AgentTask, options?: { maxCalls?: number; maxResultBytes?: number; timeoutMs?: number; signal?: AbortSignal }): AgentTaskClient;
  getMessage(messageId: string, options?: { conversationId?: string; signal?: AbortSignal }): Promise<{ message: AgentMessageRecord; coverage?: Record<string, unknown> }>;
  listHistory(conversationId: string, options?: AgentHistoryQuery): Promise<AgentHistoryPage>;
  searchMessages(conversationId: string, options: AgentHistoryQuery & { query: string }): Promise<AgentHistoryPage>;
  listMembers(conversationId: string, options?: { signal?: AbortSignal }): Promise<{ members: Array<Record<string, unknown>> }>;
  getDoctor(): Promise<Record<string, unknown>>;
  setTyping(conversationId: string, options?: { state?: "typing" | "thinking"; signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
  listConversations(): Promise<{ conversations: Array<Record<string, unknown>> }>;
  getContext(conversationId: string, options?: { limit?: number }): Promise<{ conversation: Record<string, unknown>; messages: Array<Record<string, unknown>> }>;
  acknowledge(input: { eventId: string; sequence: number }): Promise<{ acknowledged: true; eventId: string; sequence: number }>;
  getUpdates(options?: { afterSequence?: number; limit?: number; timeout?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<AgentReplayPage>;
  /** An unfiltered timeout may return a transient resumeSequence. */
  pollNextEvent(options?: { afterSequence?: number; conversationId?: string; timeoutMs?: number; signal?: AbortSignal; ack?: boolean; onCursorAdvance?: (sequence: number) => Promise<void> | void; onSyncRequired?: (state: AgentReplaySyncState) => Promise<void> | void }): Promise<{ timeout: boolean; event?: AgentEvent; lastSequence: number; nextSequence?: number; resumeSequence?: number; requiresAck?: boolean; transport: "poll" }>;
  connect(options?: { lastSequence?: number; ack?: boolean; signal?: AbortSignal; onEvent?: (event: AgentEvent) => Promise<void> | void; onCursorAdvance?: (sequence: number) => Promise<void> | void; onError?: (error: DualLaneAgentError) => void; onStatus?: (state: Record<string, unknown>) => void; onSyncRequired?: (state: AgentReplaySyncState) => Promise<void> | void }): Promise<this>;
  stop(): void;
  sendMessage(input: { conversationId: string; text?: string; content?: AgentMessageContent | Record<string, unknown>; replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string; signal?: AbortSignal }): Promise<{ message: { id: string }; operation?: AgentOperationReference }>;
  editMessage(messageId: string, input: string | AgentMessageUpdate, options?: { signal?: AbortSignal; expectedVersion?: string }): Promise<{ message: { id: string; version?: string }; operation?: AgentOperationReference }>;
  sendCard(input: { conversationId: string; card?: Record<string, unknown>; signal?: AbortSignal; [key: string]: unknown }): Promise<Record<string, unknown> & { operation?: AgentOperationReference }>;
  sendFeishuCard(input: { conversationId: string; card: Record<string, unknown>; signal?: AbortSignal; [key: string]: unknown }): Promise<Record<string, unknown> & { operation?: AgentOperationReference }>;
  updateCard(cardId: string, input: { expectedRevision?: number; signal?: AbortSignal; [key: string]: unknown }): Promise<Record<string, unknown> & { operation?: AgentOperationReference }>;
  updateFeishuCard(cardId: string, input: { card: Record<string, unknown>; expectedRevision?: number; fallbackText?: string; signal?: AbortSignal }): Promise<Record<string, unknown> & { operation?: AgentOperationReference }>;
  sendFile(input: { conversationId: string; bytes: Uint8Array | string; fileName: string; mimeType?: string; text?: string; replyToMessageId?: string; clientMessageId?: string; sendMessage?: boolean }): Promise<{ attachment?: { id: string }; message?: { id: string } }>;
  uploadFile(input: { conversationId: string; bytes: Uint8Array | string; fileName: string; mimeType?: string }): Promise<{ attachment: { id: string } }>;
  reserveUpload(input: { conversationId: string; fileName: string; mimeType?: string; byteSize: number }): Promise<{ upload: { id: string; status: string; attachment?: { id: string } } }>;
  completeUploadContent(uploadId: string, bytes: Uint8Array, mimeType?: string): Promise<{ attachment?: { id: string } }>;
  getUploadStatus(uploadId: string): Promise<{ upload: { uploadId: string; status: "reserved" | "completed" | "failed"; attachment?: { id: string; status: string } } }>;
  readAttachment(input: AgentAttachmentInput): Promise<{ bytes: Buffer; mimeType: string; byteSize: number }>;
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds?: number
): boolean;

export interface CardKitBuilder {
  header(
    title: string,
    options?: {
      subtitle?: string;
      badge?: string;
      tone?: "neutral" | "shared" | "direct" | "success" | "warning" | "danger";
    }
  ): CardKitBuilder;
  markdown(content: string): CardKitBuilder;
  fields(items: Array<{ label: string; value: string; short?: boolean }>): CardKitBuilder;
  poll(
    pollId: string,
    options: Array<{ id: string; label: string; votes: number; selected?: boolean }>,
    config?: { multiSelect?: boolean; closed?: boolean }
  ): CardKitBuilder;
  actions(
    elements: Array<
      | {
          type: "button";
          actionId: string;
          label: string;
          style?: "default" | "primary" | "danger";
          disabled?: boolean;
          payload?: Record<string, unknown>;
          opensModal?: boolean;
        }
      | {
          type: "select";
          actionId: string;
          placeholder?: string;
          value?: string;
          options: Array<{ value: string; label: string }>;
          disabled?: boolean;
        }
    >
  ): CardKitBuilder;
  divider(): CardKitBuilder;
  fallback(text: string): CardKitBuilder;
  build(): DualLaneCardKitDocument;
}

export function createCardKitBuilder(cardId?: string, cardType?: string): CardKitBuilder;

export class DualLaneBotV2 {
  constructor(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number });
  readAttachment(input: AgentAttachmentInput): Promise<{ bytes: Buffer; mimeType: string; byteSize: number }>;
  getMe(): Promise<unknown>;
  getCapabilities(conversationId?: string): Promise<Record<string, unknown>>;
  createTask(input: { eventId: string }): Promise<{ task: AgentTask }>;
  getTask(taskId: string): Promise<{ task: AgentTask }>;
  cancelAgentTask(taskId: string): Promise<Record<string, unknown>>;
  getOperation(taskId: string, operation: AgentOperation, key: string): Promise<AgentOperationResult>;
  forTask(task: AgentTask, options?: { maxCalls?: number; maxResultBytes?: number; timeoutMs?: number; signal?: AbortSignal }): AgentTaskClient;
  getMessage(messageId: string, options?: { conversationId?: string; signal?: AbortSignal }): Promise<{ message: AgentMessageRecord; coverage?: Record<string, unknown> }>;
  listHistory(conversationId: string, options?: AgentHistoryQuery): Promise<AgentHistoryPage>;
  searchMessages(conversationId: string, options: AgentHistoryQuery & { query: string }): Promise<AgentHistoryPage>;
  listMembers(conversationId: string): Promise<{ members: Array<Record<string, unknown>> }>;
  listConversations(): Promise<{
    conversations: Array<{
      id: string;
      type: "direct" | "group";
      title: string;
      allowSend: boolean;
      allowTrigger: boolean;
      allowContext: boolean;
      maxMessages: number;
      groupPolicyStatus?: string;
      updatedAt: string;
    }>;
  }>;
  getContext(conversationId: string, limit?: number): Promise<{ conversation: unknown; messages: unknown[] }>;
  getUpdates(afterSequence?: number, limit?: number): Promise<AgentReplayPage>;
  sendMessage(
    conversationId: string,
    text: string,
    options?: { replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string }
  ): Promise<{ message?: { id: string } }>;
  editMessage(messageId: string, input: string | AgentMessageUpdate, options?: { signal?: AbortSignal; expectedVersion?: string }): ReturnType<DualLaneAgentClient["editMessage"]>;
  sendFile(
    conversationId: string,
    bytes: Uint8Array | Buffer | string,
    fileName: string,
    options?: {
      mimeType?: string;
      text?: string;
      replyToMessageId?: string;
      clientMessageId?: string;
      sendMessage?: boolean;
    }
  ): Promise<{ ok: boolean; attachment?: unknown; message?: { id: string } }>;
  sendCard(
    conversationId: string,
    cardDoc: DualLaneCardKitDocument,
    options?: { replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string }
  ): Promise<unknown>;
  streamReply(
    conversationId: string,
    chunksAsyncIterable: AsyncIterable<string>,
    options?: { replyToMessageId?: string; placeholder?: string; flushIntervalMs?: number }
  ): Promise<{ messageId: string; text: string }>;
}
