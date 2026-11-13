import type {
  DualLaneCardKitDocument,
  SyncDeltaResponse,
  UserDeviceSummary,
} from "@duallane/protocol";

export interface ApiErrorPayload {
  code: string;
  message: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers,
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    const errObj = parsed.error as ApiErrorPayload | undefined;
    throw new ApiClientError(
      errObj?.code || "request.failed",
      errObj?.message || `请求失败 (${response.status})`,
      response.status
    );
  }
  return parsed as T;
}

export interface SearchMessageHit {
  id: string;
  conversationId: string;
  senderId: string;
  plainText: string;
  threadRootId?: string;
  createdAt: string;
}

export interface SearchAttachmentHit {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  conversationId?: string;
  sourceMessageId?: string;
  width?: number;
  height?: number;
  thumbHash?: string;
  createdAt: string;
}

export interface SearchResponse {
  messages: SearchMessageHit[];
  attachments: SearchAttachmentHit[];
}

export interface ThreadMessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  plainText: string;
  threadRootId?: string;
  replyToId?: string;
  editedAt?: string;
  createdAt: string;
  card?: DualLaneCardKitDocument;
}

export interface ThreadResponse {
  root: ThreadMessageItem;
  replies: ThreadMessageItem[];
}

export interface BotCommandSpec {
  id?: string;
  botId?: string;
  command: string;
  description: string;
  usageHint?: string;
}

export interface QRStartResponse {
  sessionId: string;
  qrPayload: string;
  expiresAt: string;
}

export const apiV1 = {
  // Auth & Bootstrap
  getBootstrap: () =>
    requestJSON<Record<string, unknown>>("/api/workspace/bootstrap"),
  loginWithPassword: (email: string, password: string) =>
    requestJSON<Record<string, unknown>>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  registerWithInvite: (inviteCode: string, displayName: string, email: string, password: string) =>
    requestJSON<Record<string, unknown>>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ inviteCode, displayName, email, password }),
    }),
  logout: () =>
    requestJSON<Record<string, unknown>>("/api/auth/logout", { method: "POST" }),

  // v1.0 Incremental Sync & Search
  sync: (afterSeq: number, limit = 100) =>
    requestJSON<SyncDeltaResponse>(`/api/v1/sync?afterSeq=${afterSeq}&limit=${limit}`),
  search: (q: string, conversationId?: string, limit = 30) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (conversationId) params.set("conversationId", conversationId);
    return requestJSON<SearchResponse>(`/api/v1/search?${params.toString()}`);
  },

  // Saved Messages, Pins, Edit, Forward, Threads
  ensureSavedConversation: () =>
    requestJSON<{ conversationId: string }>("/api/v1/conversations/saved", { method: "POST" }),
  pinMessage: (conversationId: string, messageId: string) =>
    requestJSON<{ pinned: boolean }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/pins/${encodeURIComponent(messageId)}`, {
      method: "POST",
    }),
  unpinMessage: (conversationId: string, messageId: string) =>
    requestJSON<{ pinned: boolean }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/pins/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    }),
  editMessage: (messageId: string, plainText: string) =>
    requestJSON<{ message: ThreadMessageItem }>(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ plainText }),
    }),
  forwardMessages: (messageIds: string[], targetConversationId: string) =>
    requestJSON<{ forwardedIds: string[] }>("/api/v1/messages/forward", {
      method: "POST",
      body: JSON.stringify({ messageIds, targetConversationId }),
    }),
  getThread: (messageId: string, limit = 100) =>
    requestJSON<ThreadResponse>(`/api/v1/messages/${encodeURIComponent(messageId)}/thread?limit=${limit}`),
  replyThread: (messageId: string, plainText: string, alsoSendToChannel: boolean, threadTitle?: string) =>
    requestJSON<{ message: ThreadMessageItem }>(`/api/v1/messages/${encodeURIComponent(messageId)}/thread`, {
      method: "POST",
      body: JSON.stringify({ plainText, alsoSendToChannel, threadTitle }),
    }),

  // Conversations & Messages (Workspace Core)
  sendMessage: (conversationId: string, text: string, options?: { replyToMessageId?: string; clientMessageId?: string }) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          text,
          replyToMessageId: options?.replyToMessageId,
          clientMessageId: options?.clientMessageId || `cli_${crypto.randomUUID()}`,
        }),
      }
    ),
  createDirectConversation: (memberId: string) =>
    requestJSON<Record<string, unknown>>("/api/workspace/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ memberId }),
    }),
  createGroupConversation: (title: string, memberIds: string[]) =>
    requestJSON<Record<string, unknown>>("/api/workspace/conversations/group", {
      method: "POST",
      body: JSON.stringify({ title, memberIds }),
    }),
  reactToMessage: (messageId: string, emoji: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) }
    ),
  markConversationRead: (conversationId: string, messageId: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST", body: JSON.stringify({ messageId }) }
    ),
  invokeCardAction: (cardId: string, actionId: string, payload?: Record<string, unknown>) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/cards/${encodeURIComponent(cardId)}/actions`,
      { method: "POST", body: JSON.stringify({ actionId, data: payload || {} }) }
    ),

  // Devices & QR Mobile Login
  listDevices: () =>
    requestJSON<{ devices: UserDeviceSummary[] }>("/api/v1/devices"),
  revokeDevice: (deviceId: string) =>
    requestJSON<{ revoked: boolean }>(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    }),
  startQRLogin: () =>
    requestJSON<QRStartResponse>("/api/v1/auth/qr/start", { method: "POST" }),
  approveQRLogin: (sessionId: string) =>
    requestJSON<{ approved: boolean }>(`/api/v1/auth/qr/${encodeURIComponent(sessionId)}/approve`, {
      method: "POST",
    }),

  // Bots v2
  listBots: () => requestJSON<Record<string, unknown>>("/api/workspace/bots"),
  createBot: (displayName: string, handle: string) =>
    requestJSON<Record<string, unknown>>("/api/workspace/bots", {
      method: "POST",
      body: JSON.stringify({ displayName, handle }),
    }),
  issueBotToken: (botId: string, scopes: string[]) =>
    requestJSON<Record<string, unknown>>(`/api/workspace/bots/${encodeURIComponent(botId)}/tokens`, {
      method: "POST",
      body: JSON.stringify({ scopes }),
    }),
  updateBotSettings: (botId: string, settings: Record<string, unknown>) =>
    requestJSON<Record<string, unknown>>(`/api/workspace/bots/${encodeURIComponent(botId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  getBotCommands: (botId: string) =>
    requestJSON<{ commands: BotCommandSpec[] }>(`/api/v1/bot/commands?botId=${encodeURIComponent(botId)}`),
  putBotCommands: (botId: string, commands: BotCommandSpec[]) =>
    requestJSON<{ commands: BotCommandSpec[] }>("/api/v1/bot/commands", {
      method: "PUT",
      body: JSON.stringify({ botId, commands }),
    }),
  putBotWebhook: (botId: string, webhookUrl: string, webhookSecret: string, enabled: boolean) =>
    requestJSON<Record<string, unknown>>("/api/v1/bot/webhook", {
      method: "PUT",
      body: JSON.stringify({ botId, webhookUrl, webhookSecret, enabled }),
    }),
};
