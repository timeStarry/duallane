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
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch {
    throw new ApiClientError("network.unreachable", "无法连接后端服务，请检查本地服务是否已启动", 0);
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  let jsonValid = true;
  if (text.trim()) {
    try {
      const candidate = JSON.parse(text) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      } else {
        jsonValid = false;
      }
    } catch {
      jsonValid = false;
    }
  }
  if (!response.ok) {
    const errObj = parsed.error as ApiErrorPayload | undefined;
    throw new ApiClientError(
      errObj?.code || (response.status >= 500 ? "server.unavailable" : "request.failed"),
      errObj?.message ||
        (response.status >= 500
          ? `后端服务暂时不可用 (HTTP ${response.status})`
          : `请求失败 (${response.status})`),
      response.status
    );
  }
  if (text.trim() && !jsonValid) {
    throw new ApiClientError(
      "response.invalid_json",
      "接口返回了非 JSON 响应，请检查开发代理与后端路由配置",
      502
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

export interface DevInviteProfileInput {
  githubId?: string;
  githubLogin: string;
  email: string;
  displayName: string;
}

export const apiV1 = {
  // Health, Auth & Bootstrap
  getHealth: () =>
    requestJSON<{ ok?: boolean; workspace?: { enabled?: boolean } }>("/api/health"),
  getBootstrap: () =>
    requestJSON<Record<string, unknown>>("/api/workspace/bootstrap"),
  getGitHubStartUrl: (inviteCode?: string) => {
    const code = inviteCode?.trim();
    return code
      ? `/api/auth/github/start?invite=${encodeURIComponent(code)}`
      : "/api/auth/github/start";
  },
  acceptInvite: (inviteCode: string, profile?: DevInviteProfileInput) => {
    const suffix = crypto.randomUUID().slice(0, 6);
    const body: DevInviteProfileInput = profile || {
      githubId: `dev_${suffix}`,
      githubLogin: `member_${suffix}`,
      email: `member_${suffix}@duallane.local`,
      displayName: `协作成员 ${suffix.toUpperCase()}`,
    };
    return requestJSON<Record<string, unknown>>(
      `/api/workspace/invites/${encodeURIComponent(inviteCode.trim())}/accept`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  },
  createInvite: (options?: { defaultRole?: "member" | "admin"; maxUses?: number; expiresInHours?: number }) =>
    requestJSON<{ invite?: { id: string; code?: string; codePreview?: string }; inviteUrl?: string; code?: string }>(
      "/api/workspace/invites",
      {
        method: "POST",
        body: JSON.stringify({
          defaultRole: options?.defaultRole || "member",
          maxUses: options?.maxUses || 10,
          expiresInHours: options?.expiresInHours || 72,
        }),
      }
    ),
  logout: () =>
    requestJSON<Record<string, unknown>>("/api/auth/logout", { method: "POST" }),

  // v1.0 Incremental Sync & Search
  sync: (sinceSeq: number) =>
    requestJSON<SyncDeltaResponse>(`/api/v1/sync?sinceSeq=${sinceSeq}`),
  search: async (q: string, scope: "all" | "messages" | "files" = "all"): Promise<SearchResponse> => {
    const params = new URLSearchParams({ q, scope });
    const raw = await requestJSON<Partial<SearchResponse>>(`/api/v1/search?${params.toString()}`);
    return {
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      files: Array.isArray(raw.files) ? raw.files : [],
    };
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
  uploadWorkspaceFile: async (
    conversationId: string,
    file: File
  ): Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    url: string;
    downloadUrl: string;
    previewUrl: string;
    usedToday?: number;
  }> => {
    const mimeType = file.type || "application/octet-stream";
    const reserved = await requestJSON<{
      status?: string;
      id?: string;
      usedToday?: number;
      attachment?: {
        id: string;
        fileName: string;
        mimeType: string;
        byteSize: number;
      };
      upload?: {
        id: string;
        mode: "single" | "chunked" | string;
        partSize: number;
        partCount: number;
      };
    }>("/api/workspace/files/uploads/reserve", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        mimeType,
        byteSize: file.size,
        visibility: "conversation",
        conversationId,
      }),
    });

    if (reserved.status === "rejected" || !reserved.upload?.id) {
      throw new ApiClientError("quota.insufficient", "今日空间文件上传配额不足", 429);
    }

    const uploadId = reserved.upload.id;
    const rawBuffer = await file.arrayBuffer();
    let finalAttachment = reserved.attachment;
    let finalUsedToday = reserved.usedToday;

    if (reserved.upload.mode === "chunked" && reserved.upload.partCount > 1) {
      const partSize = reserved.upload.partSize || 4 * 1024 * 1024;
      for (let partNumber = 1; partNumber <= reserved.upload.partCount; partNumber++) {
        const start = (partNumber - 1) * partSize;
        const end = Math.min(rawBuffer.byteLength, start + partSize);
        const chunk = rawBuffer.slice(start, end);
        const digestBuf = await crypto.subtle.digest("SHA-256", chunk);
        const sha256Hex = Array.from(new Uint8Array(digestBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        await requestJSON<Record<string, unknown>>(
          `/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Content-SHA256": sha256Hex,
            },
            body: chunk,
          }
        );
      }
      const completed = await requestJSON<{
        usedToday?: number;
        attachment?: { id: string; fileName: string; mimeType: string; byteSize: number };
      }>(`/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/complete`, {
        method: "POST",
      });
      if (completed.attachment) finalAttachment = completed.attachment;
      if (typeof completed.usedToday === "number") finalUsedToday = completed.usedToday;
    } else {
      const completed = await requestJSON<{
        usedToday?: number;
        attachment?: { id: string; fileName: string; mimeType: string; byteSize: number };
      }>(`/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/content`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: rawBuffer,
      });
      if (completed.attachment) finalAttachment = completed.attachment;
      if (typeof completed.usedToday === "number") finalUsedToday = completed.usedToday;
    }

    const attId = finalAttachment?.id || reserved.attachment?.id || "";
    if (!attId) {
      throw new ApiClientError("upload.incomplete", "文件上传未返回有效附件标识", 500);
    }
    const downloadUrl = `/api/workspace/files/${encodeURIComponent(attId)}/download`;
    const previewUrl = mimeType.startsWith("image/")
      ? `/api/workspace/files/${encodeURIComponent(attId)}/preview`
      : downloadUrl;

    return {
      id: attId,
      fileName: finalAttachment?.fileName || file.name,
      mimeType: finalAttachment?.mimeType || mimeType,
      byteSize: finalAttachment?.byteSize ?? file.size,
      url: previewUrl,
      downloadUrl,
      previewUrl,
      usedToday: finalUsedToday,
    };
  },
  sendMessage: (
    conversationId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      clientMessageId?: string;
      attachmentIds?: string[];
    }
  ) => {
    const trimmedText = text.trim();
    const attachmentIds = (options?.attachmentIds || []).filter(Boolean);
    const blocks: Array<Record<string, unknown>> = [];
    if (trimmedText) {
      blocks.push({ type: "text", text: trimmedText });
    }
    for (const attachmentId of attachmentIds) {
      blocks.push({ type: "attachment", attachmentId });
    }
    return requestJSON<Record<string, unknown>>("/api/workspace/messages", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        clientMessageId: options?.clientMessageId || `cli_${crypto.randomUUID()}`,
        replyToMessageId: options?.replyToMessageId || "",
        content: {
          format: "duallane.message+json;v=1",
          plainText: trimmedText || (attachmentIds.length > 0 ? "[文件]" : ""),
          blocks,
        },
      }),
    });
  },
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
