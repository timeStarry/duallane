import type { DualLaneCardKitDocument } from "@duallane/protocol";

export interface AgentEvent {
  eventId: string;
  sequence: number;
  type: string;
  conversationId: string;
  payload: Record<string, unknown>;
}

export interface AgentAttachmentInput {
  conversationId: string;
  attachmentId: string;
  messageId: string;
  mode?: "content" | "preview";
  maxBytes?: number;
  signal?: AbortSignal;
}

export class DualLaneAgentError extends Error {
  code: string;
  statusCode: number | null;
  retryable: boolean;
}

export class DualLaneAgentClient {
  constructor(options: { url: string; token: string; fetch?: typeof fetch; adapterVersion?: string; requestTimeoutMs?: number });
  readonly connected: boolean;
  readonly lastSequence: number;
  getMe(): Promise<Record<string, unknown>>;
  getDoctor(): Promise<Record<string, unknown>>;
  listConversations(): Promise<{ conversations: Array<Record<string, unknown>> }>;
  getContext(conversationId: string, options?: { limit?: number }): Promise<{ conversation: Record<string, unknown>; messages: Array<Record<string, unknown>> }>;
  acknowledge(input: { eventId: string; sequence: number }): Promise<{ acknowledged: true; eventId: string; sequence: number }>;
  getUpdates(options?: { afterSequence?: number; limit?: number; timeout?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<{ events: AgentEvent[]; syncRequired?: boolean; currentSequence?: number }>;
  pollNextEvent(options?: { afterSequence?: number; conversationId?: string; timeoutMs?: number; signal?: AbortSignal; ack?: boolean; onCursorAdvance?: (sequence: number) => void; onSyncRequired?: (state: { currentSequence: number; reason: string }) => void }): Promise<{ timeout: boolean; event?: AgentEvent; lastSequence: number; nextSequence?: number; requiresAck?: boolean; transport: "poll" }>;
  connect(options?: { lastSequence?: number; ack?: boolean; signal?: AbortSignal; onEvent?: (event: AgentEvent) => Promise<void> | void; onError?: (error: DualLaneAgentError) => void; onStatus?: (state: Record<string, unknown>) => void; onSyncRequired?: (state: { currentSequence: number; reason: string }) => Promise<void> | void }): Promise<this>;
  stop(): void;
  sendMessage(input: { conversationId: string; text?: string; content?: Record<string, unknown>; replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string }): Promise<{ message: { id: string } }>;
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
  getUpdates(afterSequence?: number, limit?: number): Promise<{ events: unknown[]; nextSequence: number }>;
  sendMessage(
    conversationId: string,
    text: string,
    options?: { replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string }
  ): Promise<{ message?: { id: string } }>;
  editMessage(messageId: string, plainText: string): Promise<{ ok: boolean; messageId: string }>;
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
