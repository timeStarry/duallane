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
  botId?: string;
  botName?: string;
}

export interface BotTokenRecord {
  id: string;
  botId?: string;
  scopes: string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
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
  getBootstrap: async () => {
    try {
      return await requestJSON<Record<string, unknown>>("/api/v1/bootstrap");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        return requestJSON<Record<string, unknown>>("/api/workspace/bootstrap");
      }
      throw err;
    }
  },
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
  createInvite: (options?: {
    defaultRole?: "member" | "admin" | "owner";
    maxUses?: number;
    expiresInHours?: number;
    code?: string;
  }) =>
    requestJSON<{ invite?: { id: string; code?: string; codePreview?: string; inviteUrl?: string }; inviteUrl?: string; code?: string }>(
      "/api/workspace/invites",
      {
        method: "POST",
        body: JSON.stringify({
          defaultRole: options?.defaultRole || "member",
          maxUses: options?.maxUses || 10,
          expiresInHours: options?.expiresInHours || 72,
          ...(options?.code ? { code: options.code } : {}),
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
  recallMessage: (messageId: string, reason?: string) =>
    requestJSON<{ message?: Record<string, unknown> }>(
      `/api/workspace/messages/${encodeURIComponent(messageId)}/recall`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      }
    ),
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
      blocks?: Array<Record<string, unknown>>;
    }
  ) => {
    const trimmedText = text.trim();
    const attachmentIds = (options?.attachmentIds || []).filter(Boolean);
    const blocks: Array<Record<string, unknown>> = options?.blocks
      ? [...options.blocks]
      : [];
    if (!options?.blocks) {
      if (trimmedText) {
        blocks.push({ type: "text", text: trimmedText });
      }
      for (const attachmentId of attachmentIds) {
        blocks.push({ type: "attachment", attachmentId });
      }
    }
    return requestJSON<Record<string, unknown>>("/api/workspace/messages", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        clientMessageId: options?.clientMessageId || `cli_${crypto.randomUUID()}`,
        replyToMessageId: options?.replyToMessageId || "",
        content: {
          format: "duallane.message+json;v=1",
          plainText: trimmedText || (attachmentIds.length > 0 ? "[文件]" : "[表情]"),
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
  createGroupConversation: (title: string, memberIds: string[], avatar?: string) =>
    requestJSON<Record<string, unknown>>("/api/v1/conversations/groups", {
      method: "POST",
      body: JSON.stringify({
        title,
        memberIds,
        ...(avatar ? { avatar } : {}),
      }),
    }),
  updateGroupConversation: (
    conversationId: string,
    patch: { title?: string; avatar?: string | null }
  ) =>
    requestJSON<{ conversation?: Record<string, unknown> }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),
  addGroupMembers: (conversationId: string, userIds: string[]) =>
    requestJSON<{ conversation?: Record<string, unknown> }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userIds }),
      }
    ),
  removeGroupMember: (conversationId: string, userId: string) =>
    requestJSON<{ ok: boolean; conversationId: string; userId: string }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    ),
  leaveGroupConversation: (conversationId: string) =>
    requestJSON<{ ok: boolean; conversationId: string }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/leave`,
      { method: "POST" }
    ),
  listConversationBotCommands: (conversationId: string) =>
    requestJSON<{ commands: BotCommandSpec[] }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/bot-commands`
    ),
  getPreferences: () =>
    requestJSON<{ preferences?: Record<string, unknown> }>("/api/v1/preferences"),
  savePreferences: (preferences: Record<string, unknown>) =>
    requestJSON<{ saved: boolean }>("/api/v1/preferences", {
      method: "PUT",
      body: JSON.stringify({ preferences }),
    }),
  reactToMessage: (messageId: string, emoteKey: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoteKey }) }
    ),
  markConversationRead: (conversationId: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST" }
    ),
  sendConversationTyping: (conversationId: string, state: "typing" | "thinking" = "typing") =>
    requestJSON<{ ok: boolean }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
      {
        method: "POST",
        body: JSON.stringify({ state }),
      }
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
  listBotTokens: (botId: string) =>
    requestJSON<{ tokens: BotTokenRecord[] }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/tokens`
    ),
  revokeBotToken: (botId: string, tokenId: string) =>
    requestJSON<{ token?: BotTokenRecord }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
      { method: "POST" }
    ),
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
  pauseBot: (botId: string) =>
    requestJSON<{ bot?: Record<string, unknown> }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/pause`,
      { method: "POST" }
    ),
  resumeBot: (botId: string) =>
    requestJSON<{ bot?: Record<string, unknown> }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/resume`,
      { method: "POST" }
    ),
  beginDeleteBot: (botId: string) =>
    requestJSON<{ bot?: Record<string, unknown>; confirmationToken?: string }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}`,
      { method: "DELETE" }
    ),
  confirmDeleteBot: (botId: string) =>
    requestJSON<{ bot?: Record<string, unknown> }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/delete/confirm`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  updateBotProfile: (
    botId: string,
    patch: { name?: string; description?: string; color?: string }
  ) =>
    requestJSON<{
      ok?: boolean;
      name?: string;
      description?: string;
      avatarUrl?: string;
      avatarColor?: string;
    }>(`/api/v1/bots/${encodeURIComponent(botId)}/profile`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  uploadBotAvatar: async (botId: string, file: File) => {
    const rawBuffer = await file.arrayBuffer();
    return requestJSON<{ avatarUrl: string }>(
      `/api/v1/bots/${encodeURIComponent(botId)}/avatar`,
      {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "image/png",
        },
        body: rawBuffer,
      }
    );
  },
  deleteBotAvatar: (botId: string) =>
    requestJSON<{ ok: boolean }>(`/api/v1/bots/${encodeURIComponent(botId)}/avatar`, {
      method: "DELETE",
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
  createBotSetupSession: (
    botId: string,
    requestedScopes: string[],
    conversationIds?: string[]
  ) =>
    requestJSON<{ session: BotSetupSession; setupUrl: string }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/setup-sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          requestedScopes,
          ...(conversationIds ? { conversationIds } : {}),
        }),
      }
    ),
  getBotSetupSession: (sessionId: string) =>
    requestJSON<{ session: BotSetupSession }>(
      `/api/workspace/bot-setup/${encodeURIComponent(sessionId)}`
    ),
  approveBotSetupSession: (
    sessionId: string,
    scopes: string[],
    conversationIds?: string[]
  ) =>
    requestJSON<{ session: BotSetupSession }>(
      `/api/workspace/bot-setup/${encodeURIComponent(sessionId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          scopes,
          ...(conversationIds ? { conversationIds } : {}),
        }),
      }
    ),
  denyBotSetupSession: (sessionId: string) =>
    requestJSON<{ session: BotSetupSession }>(
      `/api/workspace/bot-setup/${encodeURIComponent(sessionId)}/deny`,
      { method: "POST" }
    ),
  getBotConnection: (botId: string) =>
    requestJSON<{ connection: BotConnectionInfo | null }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/connection`
    ),
  testBotConnection: (botId: string) =>
    requestJSON<{ connection: BotConnectionInfo | null }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/connection/test`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    ),
  updateBotContextGrant: (
    botId: string,
    conversationId: string,
    patch: { allowTrigger?: boolean; allowContext?: boolean; maxMessages?: number }
  ) =>
    requestJSON<{ grant: BotContextGrant }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/context-grants/${encodeURIComponent(conversationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),
  listBotGroupPolicies: (botId: string) =>
    requestJSON<{ policies: BotGroupPolicy[] }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/group-policies`
    ),
  updateBotGroupPolicy: (
    botId: string,
    conversationId: string,
    patch: {
      status?: string;
      allowTrigger?: boolean;
      allowContext?: boolean;
      maxMessages?: number;
    }
  ) =>
    requestJSON<{ policy: BotGroupPolicy }>(
      `/api/workspace/bots/${encodeURIComponent(botId)}/group-policies/${encodeURIComponent(conversationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),

  // Space Governance Console (Owner / Admin only)
  getAdminOverview: () =>
    requestJSON<AdminOverviewResponse>("/api/v1/admin/overview"),
  listAdminInvites: () =>
    requestJSON<AdminInviteListResponse>("/api/v1/admin/invites"),
  revokeInvite: (inviteId: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/invites/${encodeURIComponent(inviteId)}/revoke`,
      { method: "POST" }
    ),
  listAdminAuditLogs: async (params?: {
    result?: "all" | "success" | "rejected" | "failure";
    q?: string;
    limit?: number;
  }): Promise<AdminAuditLogItem[]> => {
    const query = new URLSearchParams();
    if (params?.result && params.result !== "all") query.set("result", params.result);
    if (params?.q?.trim()) query.set("q", params.q.trim());
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    const res = await requestJSON<{ items?: AdminAuditLogItem[] }>(
      `/api/v1/admin/audit-logs${qs ? `?${qs}` : ""}`
    );
    return Array.isArray(res.items) ? res.items : [];
  },
  updateAdminPolicy: (input: {
    spaceName?: string;
    dailyQuotaBytes: number;
    messageRetentionCount: number;
  }) =>
    requestJSON<{ policy: AdminSpacePolicy }>("/api/v1/admin/policy", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  cleanupAdminStorage: () =>
    requestJSON<AdminStorageCleanupResult>("/api/v1/admin/storage/cleanup", {
      method: "POST",
    }),
  getAdminAnnouncement: () =>
    requestJSON<{ announcement: SystemAnnouncementDTO }>("/api/v1/admin/announcement"),
  updateAdminAnnouncement: (input: SystemAnnouncementUpdateInput) =>
    requestJSON<{ announcement: SystemAnnouncementDTO }>("/api/v1/admin/announcement", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getAdminMobileRelease: () =>
    requestJSON<{ release: MobileClientReleaseDTO }>("/api/v1/admin/mobile-release"),
  updateAdminMobileRelease: (input: MobileClientReleaseMetadataInput) =>
    requestJSON<{ release: MobileClientReleaseDTO }>("/api/v1/admin/mobile-release", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  uploadAdminMobileAPK: async (
    file: File,
    overrides?: { version?: string; versionCode?: number }
  ): Promise<{ release: MobileClientReleaseDTO }> => {
    const params = new URLSearchParams();
    if (overrides?.version?.trim()) {
      params.set("version", overrides.version.trim());
    }
    if (overrides?.versionCode && overrides.versionCode > 0) {
      params.set("versionCode", String(overrides.versionCode));
    }
    const qs = params.toString();
    const rawBuffer = await file.arrayBuffer();
    return requestJSON<{ release: MobileClientReleaseDTO }>(
      `/api/v1/admin/mobile-release/apk${qs ? `?${qs}` : ""}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
        },
        body: rawBuffer,
      }
    );
  },
  ackAnnouncement: (id: string) =>
    requestJSON<{ ok: boolean }>("/api/v1/announcement/ack", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  sendBindEmailCode: (email: string) =>
    requestJSON<EmailChallengeSummaryDTO>("/api/v1/account/email/send-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyBindEmail: (challengeId: string, code: string) =>
    requestJSON<BoundEmailStatusDTO>("/api/v1/account/email/verify", {
      method: "POST",
      body: JSON.stringify({ challengeId, code }),
    }),
  unbindAccountEmail: () =>
    requestJSON<{ ok: boolean }>("/api/v1/account/email", {
      method: "DELETE",
    }),
  sendLoginEmailCode: (email: string) =>
    requestJSON<EmailChallengeSummaryDTO>("/api/v1/auth/email/send-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyLoginEmail: (email: string, challengeId: string, code: string) =>
    requestJSON<EmailVerifyLoginResponseDTO>("/api/v1/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ email, challengeId, code, client: "web" }),
    }),
  getWorkspaceEmailSettings: () =>
    requestJSON<{ settings: AdminEmailSettingsDTO }>("/api/workspace/settings/email"),
  testWorkspaceEmailSettings: (input: AdminEmailSettingsInput) =>
    requestJSON<{ testProof: string; recipient: string; testedAt: string }>(
      "/api/workspace/settings/email/test",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ),
  saveWorkspaceEmailSettings: (input: AdminEmailSettingsInput & { testProof?: string }) =>
    requestJSON<{ settings: AdminEmailSettingsDTO }>("/api/workspace/settings/email", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  listWorkspaceMembers: () =>
    requestJSON<{ members?: Array<Record<string, unknown>> }>("/api/workspace/members"),
  updateMemberRole: (userId: string, role: "owner" | "admin" | "member") =>
    requestJSON<{ member?: Record<string, unknown> }>(
      `/api/workspace/members/${encodeURIComponent(userId)}/role`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }
    ),
  removeSpaceMember: (userId: string) =>
    requestJSON<{ ok: boolean }>(`/api/workspace/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),
  getMemberVisibility: (userId: string) =>
    requestJSON<{ visibility: MemberVisibilityRule }>(
      `/api/workspace/member-visibility/${encodeURIComponent(userId)}`
    ),
  updateMemberVisibility: (userId: string, visibleUserIds: string[]) =>
    requestJSON<{ visibility: MemberVisibilityRule }>(
      `/api/workspace/member-visibility/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ visibleUserIds }),
      }
    ),

  // Personal Profile, Custom Avatar, Private Member Remarks & Notification Preferences
  updateMyProfile: (patch: { nickname?: string; searchDiscoverable?: boolean }) =>
    requestJSON<{ user?: Record<string, unknown> }>("/api/workspace/me/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  uploadMyAvatar: async (file: File) => {
    const rawBuffer = await file.arrayBuffer();
    return requestJSON<{ user?: Record<string, unknown>; avatarUrl?: string }>(
      "/api/workspace/me/avatar",
      {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "image/png",
        },
        body: rawBuffer,
      }
    );
  },
  deleteMyAvatar: () =>
    requestJSON<{ user?: Record<string, unknown>; avatarUrl?: string }>(
      "/api/workspace/me/avatar",
      {
        method: "DELETE",
      }
    ),
  setMemberRemark: (userId: string, remark: string) => {
    const trimmed = remark.trim();
    const url = `/api/workspace/members/${encodeURIComponent(userId)}/remark`;
    if (trimmed) {
      return requestJSON<{ member?: Record<string, unknown>; remark?: string }>(url, {
        method: "PUT",
        body: JSON.stringify({ remark: trimmed }),
      });
    }
    return requestJSON<{ member?: Record<string, unknown>; ok?: boolean }>(url, {
      method: "DELETE",
    });
  },
  updateConversationNotification: (
    conversationId: string,
    level: ConversationNotificationLevel
  ) =>
    requestJSON<{ conversation?: Record<string, unknown>; level?: ConversationNotificationLevel }>(
      `/api/workspace/conversations/${encodeURIComponent(conversationId)}/notification`,
      {
        method: "PATCH",
        body: JSON.stringify({ level }),
      }
    ),
  getMyNotifications: () =>
    requestJSON<{ notifications: OfflineEmailNotificationsDTO }>(
      "/api/workspace/me/notifications"
    ),
  updateMyNotifications: (patch: {
    enabled: boolean;
    immediateEnabled: boolean;
    digestEnabled: boolean;
  }) =>
    requestJSON<{ notifications: OfflineEmailNotificationsDTO }>(
      "/api/workspace/me/notifications",
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),

  // Emotes, Stickers & Collections (Telegram-style Pack & Subscription System)
  getEmoteSettings: () =>
    requestJSON<{ settings: EmoteSettingsDTO }>("/api/workspace/me/emote-settings"),
  updateEmoteSettings: (patch: {
    enabledPackIds?: string[];
    clickImageEmoteToSend?: boolean;
    replyAutoMention?: boolean;
  }) =>
    requestJSON<{ settings: EmoteSettingsDTO }>("/api/workspace/me/emote-settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  getEmoteLibrary: () =>
    requestJSON<EmoteLibraryDTO>("/api/workspace/me/emote-library"),
  uploadCustomEmote: async (
    file: File,
    options?: { collectionId?: string; addToLibrary?: boolean }
  ): Promise<{ emote: CustomEmoteDTO }> => {
    const params = new URLSearchParams();
    if (options?.collectionId) {
      params.set("collectionId", options.collectionId);
      if (options.addToLibrary === false) {
        params.set("addToLibrary", "false");
      }
    }
    const qs = params.toString();
    const rawBuffer = await file.arrayBuffer();
    return requestJSON<{ emote: CustomEmoteDTO }>(
      `/api/workspace/me/emotes${qs ? `?${qs}` : ""}`,
      {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-DualLane-File-Name": encodeURIComponent(file.name),
        },
        body: rawBuffer,
      }
    );
  },
  favoriteMessageEmote: (input: {
    messageId: string;
    customEmoteId?: string;
    attachmentId?: string;
    emoteKey?: string;
  }) =>
    requestJSON<{ emote: CustomEmoteDTO }>("/api/workspace/me/emotes/favorite", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  renameCustomEmote: (emoteId: string, label: string) =>
    requestJSON<{ emote: CustomEmoteDTO }>(
      `/api/workspace/me/emotes/${encodeURIComponent(emoteId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ label }),
      }
    ),
  deleteCustomEmote: (emoteId: string) =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/me/emotes/${encodeURIComponent(emoteId)}`,
      { method: "DELETE" }
    ),
  createEmoteCollection: (name: string, emoteIds?: string[]) =>
    requestJSON<{ collection: EmoteCollectionDTO }>("/api/workspace/me/emote-collections", {
      method: "POST",
      body: JSON.stringify({ name, ...(emoteIds?.length ? { emoteIds } : {}) }),
    }),
  renameEmoteCollection: (collectionId: string, name: string) =>
    requestJSON<{ collection: EmoteCollectionDTO }>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }
    ),
  deleteEmoteCollection: (collectionId: string, disposition: "keep" | "remove" = "keep") =>
    requestJSON<Record<string, unknown>>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}?itemDisposition=${disposition}`,
      { method: "DELETE" }
    ),
  addEmotesToCollection: (collectionId: string, emoteIds: string[]) =>
    requestJSON<{ collection: EmoteCollectionDTO }>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}/items`,
      {
        method: "POST",
        body: JSON.stringify({ emoteIds }),
      }
    ),
  removeEmoteFromCollection: (collectionId: string, emoteId: string) =>
    requestJSON<{ collection: EmoteCollectionDTO }>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(emoteId)}`,
      { method: "DELETE" }
    ),
  updateEmoteCollectionSubscription: (collectionId: string, enabled: boolean) =>
    requestJSON<{ collection?: EmoteCollectionDTO; library?: EmoteLibraryDTO }>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}/source-subscription`,
      {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }
    ),
  createEmoteCollectionShare: (collectionId: string) =>
    requestJSON<{ share: EmoteCollectionShareDetailDTO }>(
      `/api/workspace/me/emote-collections/${encodeURIComponent(collectionId)}/shares`,
      { method: "POST" }
    ),
  getEmoteCollectionShare: (shareId: string) =>
    requestJSON<{ share: EmoteCollectionShareDetailDTO }>(
      `/api/workspace/emote-collection-shares/${encodeURIComponent(shareId)}`
    ),
  importEmoteCollectionShare: (
    shareId: string,
    payload: {
      emoteIds?: string[];
      asCollection?: boolean;
      collectionName?: string;
      subscribeToSourceChanges?: boolean;
    }
  ) =>
    requestJSON<{
      importedCount?: number;
      collection?: EmoteCollectionDTO;
      library?: EmoteLibraryDTO;
    }>(`/api/workspace/emote-collection-shares/${encodeURIComponent(shareId)}/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revokeEmoteCollectionShare: (shareId: string) =>
    requestJSON<{ share: EmoteCollectionShareDetailDTO }>(
      `/api/workspace/me/emote-collection-shares/${encodeURIComponent(shareId)}`,
      { method: "DELETE" }
    ),
};

export interface AdminCounts {
  members: number;
  conversations: number;
  messages: number;
  files: number;
  uploadedBytes: number;
}

export interface AdminSpacePolicy {
  dailyQuotaBytes: number;
  messageRetentionCount: number;
  updatedAt?: string;
}

export interface StorageOperatorRunSummary {
  id: string;
  operation: string;
  state: string;
  phase: string;
  totalItems: number;
  processedItems: number;
  lastErrorCode?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AdminOverviewResponse {
  space: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  };
  totals: AdminCounts;
  today: AdminCounts;
  policy: AdminSpacePolicy;
  storage: {
    activeAttachments: number;
    activeBytes: number;
    pendingUploads: number;
    pendingBytes: number;
    reclaimableAttachments: number;
    reclaimableBytes: number;
    casObjects: number;
    casBytes: number;
    recentOperatorRuns: StorageOperatorRunSummary[];
  };
  viewerRole: "owner" | "admin" | string;
}

export interface AdminInviteItem {
  id: string;
  codePreview: string;
  defaultRole: string;
  maxUses: number;
  uses: number;
  status: "active" | "exhausted" | "expired" | "revoked" | string;
  createdByName: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface AdminInviteListResponse {
  total: number;
  active: number;
  acceptedUses: number;
  availableUses: number;
  invites: AdminInviteItem[];
}

export interface AdminAuditLogItem {
  id: string;
  actorUserId?: string;
  actorDisplayName: string;
  actorGitHubLogin?: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: "success" | "rejected" | "failure" | string;
  reason?: string;
  ipAddress?: string;
  requestId?: string;
  createdAt: string;
}

export interface AdminStorageCleanupResult {
  releasedTransfers: number;
  cleanedAttachments: number;
  reclaimedBytes: number;
}

export interface SystemAnnouncementDTO {
  id: string;
  enabled: boolean;
  displayMode: "once" | "always";
  badge?: string;
  title: string;
  content: string;
  ctaLabel?: string;
  ctaUrl?: string;
  updatedAt?: string;
  updatedBy?: string;
  shouldShow?: boolean;
}

export interface SystemAnnouncementUpdateInput {
  enabled: boolean;
  displayMode: "once" | "always";
  badge?: string;
  title: string;
  content: string;
  ctaLabel?: string;
  ctaUrl?: string;
  resetAck?: boolean;
}

export interface EmailChallengeSummaryDTO {
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
}

export interface BoundEmailStatusDTO {
  bound: boolean;
  email?: string;
  maskedEmail?: string;
}

export interface EmailVerifyLoginResponseDTO {
  ok: boolean;
  client: "web" | "mobile" | string;
  user?: Record<string, unknown>;
}

export interface AdminEmailSettingsDTO {
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
}

export interface AdminEmailSettingsInput {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  encryption: "starttls" | "tls" | "none";
  username: string;
  password?: string;
  fromAddress: string;
  fromName: string;
}

export interface MemberVisibilityRule {
  basis: string;
  viewerUserId: string;
  automaticUserIds: string[];
  grantedUserIds: string[];
  visibleUserIds: string[];
}

export interface BotSetupSession {
  id: string;
  bot?: {
    id: string;
    botUserId?: string;
    name: string;
    status?: string;
  } | null;
  status:
    | "created"
    | "awaiting_user"
    | "approved"
    | "exchanged"
    | "denied"
    | "expired"
    | "revoked"
    | string;
  requestedScopes: string[];
  approvedScopes: string[];
  requestedConversations: string[];
  approvedConversations: string[];
  clientName?: string | null;
  clientVersion?: string | null;
  protocolVersion?: string;
  capabilities?: string[];
  expiresAt: string;
  approvedAt?: string | null;
  exchangedAt?: string | null;
  deniedAt?: string | null;
  createdAt: string;
}

export interface BotConnectionInfo {
  id?: string;
  botId: string;
  status: "connected" | "disconnected" | "paused" | "revoked" | string;
  adapterVersion?: string | null;
  connectedAt?: string | null;
  disconnectedAt?: string | null;
  lastHeartbeatAt?: string | null;
  lastProcessedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  updatedAt?: string;
  testedAt?: string;
}

export interface BotContextGrant {
  grantId: string;
  botId: string;
  conversationId: string;
  allowTrigger: boolean;
  allowContext: boolean;
  maxMessages?: number | null;
  updatedAt?: string;
}

export interface BotGroupPolicy {
  botId?: string;
  conversationId: string;
  status: "active" | "pending" | "revoked" | string;
  allowTrigger: boolean;
  allowContext: boolean;
  contextMaxMessages?: number | null;
  updatedAt?: string;
}

export interface CustomEmoteDTO {
  id: string;
  kind: "image" | string;
  label: string;
  token: string;
  src?: string;
  emoteKey?: string;
  animated: boolean;
  byteSize?: number;
  width?: number;
  height?: number;
  sourceType?: string;
  originalFileName?: string;
  createdAt: string;
}

export interface EmoteCollectionSubscriptionDTO {
  eligible: boolean;
  enabled: boolean;
  status: "off" | "synced" | "paused" | "detached" | string;
  sourceCollectionId?: string | null;
  sourceRevision?: number | null;
  lastSyncedAt?: string | null;
  readOnly: boolean;
}

export interface EmoteCollectionDTO {
  id: string;
  name: string;
  sourceCollectionId?: string | null;
  originalCreatorUserId: string;
  originalCreator: { id: string; displayName: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceSubscription: EmoteCollectionSubscriptionDTO;
  items: CustomEmoteDTO[];
  itemCount: number;
}

export interface EmoteLibraryDTO {
  entries: Array<{
    id: string;
    type: "emote" | "collection" | string;
    emote?: CustomEmoteDTO;
    collection?: EmoteCollectionDTO;
  }>;
  emotes: CustomEmoteDTO[];
  collections: EmoteCollectionDTO[];
  usage: {
    itemCount: number;
    totalBytes: number;
    subscribedItemCount?: number;
    subscribedTotalBytes?: number;
    totalItemCount?: number;
    allTotalBytes?: number;
    collectionCount?: number;
    subscribedCollectionCount?: number;
    overLimit?: boolean;
  };
  limits: {
    maxItems?: number | null;
    maxTotalBytes: number;
    maxInputBytes: number;
    maxCollections?: number | null;
    maxCollectionItems: number;
    maxBatchItems: number;
  };
}

export interface EmoteSettingsDTO {
  availablePacks: Array<{ id: string; label: string; defaultEnabled: boolean }>;
  enabledPackIds: string[];
  clickImageEmoteToSend: boolean;
  replyAutoMention: boolean;
  autoHideMessages?: boolean;
  autoHideMessageTypes?: string[];
  minimumEnabled?: number;
}

export interface EmoteCollectionShareCoverDTO {
  id: string;
  label: string;
  src: string;
  animated?: boolean;
}

export interface EmoteCollectionShareSummaryDTO {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
  revokedAt?: string | null;
  sharedBy: { id: string; displayName: string };
  originalCreator: { id: string; displayName: string };
  canRevoke: boolean;
  covers?: EmoteCollectionShareCoverDTO[];
  sharePath: string;
}

export interface EmoteCollectionShareDetailDTO extends EmoteCollectionShareSummaryDTO {
  sourceCollectionId: string;
  canSubscribeToSourceChanges: boolean;
  items: CustomEmoteDTO[];
}

export interface MobileOTABundleDTO {
  enabled: boolean;
  version: string;
  bundleId: string;
  minNativeVersionCode: number;
  byteSize: number;
  sha256: string;
  downloadUrl: string;
  publishedAt?: string;
}

export interface MobileClientReleaseDTO {
  enabled: boolean;
  version: string;
  versionCode: number;
  tagName: string;
  title: string;
  notes: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  downloadUrl: string;
  publishedAt?: string;
  updatedBy?: string;
  ota?: MobileOTABundleDTO;
}

export interface MobileClientReleaseMetadataInput {
  enabled: boolean;
  version: string;
  versionCode: number;
  title: string;
  notes: string;
}

export type ConversationNotificationLevel = "all" | "mentions" | "muted";

export interface OfflineEmailNotificationsDTO {
  enabled: boolean;
  immediateEnabled: boolean;
  digestEnabled: boolean;
  email?: string | null;
  verified?: boolean;
  source?: string;
}
