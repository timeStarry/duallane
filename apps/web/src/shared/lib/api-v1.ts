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
  threadRootId?: string;
  authorId: string;
  authorName: string;
  plainText: string;
  createdAt: string;
}

export interface SearchFileHit {
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
  files: SearchFileHit[];
}

export interface ThreadReplyItem {
  id: string;
  conversationId: string;
  threadRootId: string;
  alsoSendToChannel: boolean;
  authorId: string;
  authorName: string;
  plainText: string;
  editedAt?: string;
  createdAt: string;
  card?: DualLaneCardKitDocument;
}

export interface ThreadViewResponse {
  rootMessageId: string;
  threadTitle?: string;
  replyCount: number;
  replies: ThreadReplyItem[];
}

export interface BotCommandSpec {
  command: string;
  description: string;
  scope?: "all" | "direct" | "group";
}

export interface QRSessionResponse {
  id: string;
  challenge: string;
  status: "pending" | "approved" | "exchanged" | "expired";
  platform?: string;
  deviceName?: string;
  expiresAt: string;
}

export const apiV1 = {
  // Auth & Bootstrap
  getBootstrap: () =>
    requestJSON<Record<string, unknown>>("/api/workspace/bootstrap"),
  getGitHubStartUrl: (inviteCode?: string) => {
    const code = inviteCode?.trim();
    return code
      ? `/api/auth/github/start?invite=${encodeURIComponent(code)}`
      : "/api/auth/github/start";
  },
  acceptInvite: (inviteCode: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/invites/${encodeURIComponent(inviteCode.trim())}/accept`,
      { method: "POST" }
    ),
  logout: () =>
    requestJSON<Record<string, unknown>>("/api/auth/logout", { method: "POST" }),

  // v1.0 Incremental Sync & Search
  sync: (sinceSeq: number) =>
    requestJSON<SyncDeltaResponse>(`/api/v1/sync?sinceSeq=${sinceSeq}`),
  search: (q: string, scope: "all" | "messages" | "files" = "all") => {
    const params = new URLSearchParams({ q, scope });
    return requestJSON<SearchResponse>(`/api/v1/search?${params.toString()}`);
  },

  // Saved Messages, Pins, Edit, Forward, Threads
  ensureSavedConversation: () =>
    requestJSON<{ conversationId: string }>("/api/v1/conversations/saved", { method: "POST" }),
  pinMessage: (conversationId: string, messageId: string) =>
    requestJSON<{ pinned: boolean }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/pins/${encodeURIComponent(messageId)}`,
      { method: "POST" }
    ),
  unpinMessage: (conversationId: string, messageId: string) =>
    requestJSON<{ pinned: boolean }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/pins/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    ),
  editMessage: (messageId: string, plainText: string) =>
    requestJSON<{ ok: boolean }>(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ plainText }),
    }),
  forwardMessages: (messageIds: string[], targetConversationId: string) =>
    requestJSON<{ createdIds: string[] }>("/api/v1/messages/forward", {
      method: "POST",
      body: JSON.stringify({ messageIds, targetConversationId }),
    }),
  getThread: (messageId: string) =>
    requestJSON<ThreadViewResponse>(`/api/v1/messages/${encodeURIComponent(messageId)}/thread`),
  replyThread: (messageId: string, plainText: string, alsoSendToChannel: boolean, threadTitle?: string) =>
    requestJSON<ThreadReplyItem>(`/api/v1/messages/${encodeURIComponent(messageId)}/thread`, {
      method: "POST",
      body: JSON.stringify({ plainText, alsoSendToChannel, threadTitle }),
    }),

  // Conversations & Messages (Workspace Core HTTP API)
  listMessages: (conversationId: string, limit = 80) =>
    requestJSON<{ messages?: Array<Record<string, unknown>> }>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`
    ),
  sendMessage: (conversationId: string, text: string, options?: { replyToMessageId?: string; clientMessageId?: string }) =>
    requestJSON<Record<string, unknown>>("/api/workspace/messages", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        clientMessageId: options?.clientMessageId || `cli_${crypto.randomUUID()}`,
        replyToMessageId: options?.replyToMessageId || "",
        content: {
          format: "duallane.message+json;v=1",
          plainText: text,
          blocks: [{ type: "text", text }],
        },
      }),
    }),
  createDirectConversation: (targetUserId: string) =>
    requestJSON<Record<string, unknown>>("/api/workspace/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "direct", targetUserId }),
    }),
  createGroupConversation: (title: string, memberIds: string[]) =>
    requestJSON<Record<string, unknown>>("/api/workspace/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "group", title, memberIds }),
    }),
  reactToMessage: (messageId: string, emoteKey: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoteKey }) }
    ),
  markConversationRead: (conversationId: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST" }
    ),
  invokeCardAction: (cardId: string, actionId: string, input?: Record<string, unknown>, expectedRevision = 1) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/cards/${encodeURIComponent(cardId)}/actions`,
      {
        method: "POST",
        body: JSON.stringify({
          actionId,
          clientActionId: `act_${crypto.randomUUID()}`,
          expectedRevision,
          input: input || {},
        }),
      }
    ),

  // Devices & QR Mobile Login
  listDevices: () =>
    requestJSON<{ devices: UserDeviceSummary[] }>("/api/v1/devices"),
  revokeDevice: (deviceId: string) =>
    requestJSON<{ revoked: boolean }>(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    }),
  startQRLogin: (platform: "ios" | "android" = "ios", deviceName = "DualLane Mobile") =>
    requestJSON<QRSessionResponse>("/api/v1/auth/qr/start", {
      method: "POST",
      body: JSON.stringify({ platform, deviceName }),
    }),
  approveQRLogin: (sessionId: string) =>
    requestJSON<QRSessionResponse>(`/api/v1/auth/qr/${encodeURIComponent(sessionId)}/approve`, {
      method: "POST",
    }),

  // Bots v2
  listBots: () => requestJSON<Record<string, unknown>>("/api/workspace/bots"),
  createBot: (name: string) =>
    requestJSON<Record<string, unknown>>("/api/v1/bots", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getBotSettings: (botId: string) =>
    requestJSON<{ settings: Record<string, unknown> }>(`/api/workspace/bots/${encodeURIComponent(botId)}/settings`),
  issueBotToken: (botId: string, scopes: string[]) =>
    requestJSON<Record<string, unknown>>(`/api/workspace/bots/${encodeURIComponent(botId)}/tokens`, {
      method: "POST",
      body: JSON.stringify({ scopes }),
    }),
  rotateBotToken: (botId: string, scopes: string[]) =>
    requestJSON<Record<string, unknown>>(`/api/workspace/bots/${encodeURIComponent(botId)}/tokens/rotate`, {
      method: "POST",
      body: JSON.stringify({ scopes }),
    }),
  updateBotSettings: (botId: string, settings: Record<string, unknown>) =>
    requestJSON<Record<string, unknown>>(`/api/workspace/bots/${encodeURIComponent(botId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  getBotCommands: (botId: string) =>
    requestJSON<{ commands: BotCommandSpec[] }>(`/api/v1/bots/${encodeURIComponent(botId)}/commands`),
  putBotCommands: (botId: string, commands: BotCommandSpec[]) =>
    requestJSON<{ updated: boolean }>(`/api/v1/bots/${encodeURIComponent(botId)}/commands`, {
      method: "PUT",
      body: JSON.stringify({ commands }),
    }),
  putBotWebhook: (botId: string, url: string, secret: string, enabled: boolean) =>
    requestJSON<Record<string, unknown>>(`/api/v1/bots/${encodeURIComponent(botId)}/webhook`, {
      method: "PUT",
      body: JSON.stringify({ url, secret, enabled }),
    }),
};
