import type { DualLaneCardKitDocument } from "@duallane/protocol";

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
  constructor(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch });
  getUpdates(afterSequence?: number, limit?: number): Promise<{ events: unknown[]; nextSequence: number }>;
  sendMessage(
    conversationId: string,
    text: string,
    options?: { replyToMessageId?: string; clientMessageId?: string; idempotencyKey?: string }
  ): Promise<{ message?: { id: string } }>;
  editMessage(messageId: string, plainText: string): Promise<{ message: unknown }>;
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
