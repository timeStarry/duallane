import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SPACE_ID, openDatabase } from "./services/db.mjs";
import { getIceServers } from "./services/ice.mjs";
import { createGitHubFetch } from "./services/github-fetch.mjs";
import { attachP2PSocket, createP2PRoom, getP2PRoom } from "./services/p2p.mjs";
import {
  acceptInvite,
  addConversationMember,
  addMessageReaction,
  bindGitHubUser,
  completeUpload,
  createConversation,
  createInvite,
  createStructuredMessage,
  createWorkspaceSession,
  failUpload,
  getCompletedDownload,
  getConversationDetails,
  getDownloadableAttachment,
  getManagedMemberVisibility,
  getReservedUpload,
  getSessionUserId,
  getWorkspaceEventForUser,
  getWorkspaceEventCursor,
  getWorkspaceBootstrap,
  leaveConversation,
  listConversations,
  listFiles,
  listMembers,
  listMessages,
  listWorkspaceEvents,
  markConversationRead,
  recordGitHubLoginRejection,
  recordInviteAcceptRejection,
  removeConversationMember,
  removeAttachment,
  removeMessageReaction,
  removeSpaceMember,
  reserveDownload,
  reserveUpload,
  revokeInvite,
  revokeWorkspaceSession,
  subscribeWorkspaceEvents,
  updateMemberRole,
  updateGroupConversation,
  updateConversationNotificationLevel,
  updateManagedMemberVisibility,
  WORKSPACE_SESSION_COOKIE,
  WorkspaceError,
  WorkspaceValidationError
} from "./services/workspace.mjs";
import { blockWorkspace, isWorkspaceEnabled } from "./services/workspace-gate.mjs";
import {
  removeStoredAttachment,
  saveUploadStream,
  statStoredAttachment
} from "./services/workspace-storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const DEFAULT_GITHUB_OAUTH_TIMEOUT_MS = 8000;
const MAX_GITHUB_OAUTH_TIMEOUT_MS = 30000;
const GITHUB_API_USER_AGENT = "DualLane/0.1";

export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env.DUALLANE_DATA_DIR ?? path.resolve(rootDir, "../../data");
  const workspaceEnabled = isWorkspaceEnabled(env);
  const serveStatic = env.SERVE_STATIC !== "false";
  const trustProxy = options.trustProxy ?? env.TRUST_PROXY === "true";
  const githubClient = createGitHubFetch({
    fetchImpl: options.fetchImpl,
    proxyUrl: env.GITHUB_PROXY_URL
  });
  const githubFetch = githubClient.fetch;
  const githubOAuthTimeoutMs = Math.min(
    normalizePositiveInteger(options.githubOAuthTimeoutMs ?? env.GITHUB_OAUTH_TIMEOUT_MS)
      ?? DEFAULT_GITHUB_OAUTH_TIMEOUT_MS,
    MAX_GITHUB_OAUTH_TIMEOUT_MS
  );

  await mkdir(dataDir, { recursive: true });
  const db = options.db ?? (workspaceEnabled
    ? await openDatabase(env.DATABASE_URL, {
      migrate: env.DATABASE_AUTO_MIGRATE !== "false",
      host: env.PGHOST,
      port: normalizePositiveInteger(env.PGPORT),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
      maxConnections: normalizePositiveInteger(env.DATABASE_POOL_MAX),
      ssl: env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
        : undefined
    })
    : null);

  const app = Fastify({
    trustProxy,
    logger: options.logger ?? {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.query",
          "req.body",
          "res.body"
        ],
        remove: true
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.routerPath || request.url.split("?")[0],
            host: request.hostname,
            remoteAddress: request.ip
          };
        }
      },
      ...(options.loggerStream ? { stream: options.loggerStream } : {})
    },
    genReqId: () => crypto.randomUUID()
  });

  app.addHook("onClose", async () => {
    await githubClient.close();
  });

  if (db && !options.db) {
    app.addHook("onClose", async () => {
      await db.close();
    });
  }

app.addHook("onRequest", async (_request, reply) => {
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://avatars.githubusercontent.com; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
});

await app.register(fastifyCookie, {
  secret: env.SESSION_SECRET || "duallane-local-dev-secret-change-me"
});
await app.register(fastifyWebsocket);
app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
  done(null, payload);
});

app.get("/api/health", async () => ({
  ok: true,
  service: "duallane",
  lane: "ready"
}));

if (env.NODE_ENV !== "production") {
  app.get("/", async (request, reply) => {
    return reply.redirect(workspaceFrontendUrl(env, request.url));
  });
}

app.post("/api/p2p/rooms", async (request, reply) => {
  const baseUrl = env.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`;
  const maxPeers = request.body && typeof request.body === "object" ? request.body.maxPeers : undefined;
  if (maxPeers !== 2) {
    return reply.code(400).send({ error: "maxPeers must be 2 for p2p rooms" });
  }
  const room = createP2PRoom(baseUrl, { maxPeers });
  return reply.code(201).send(room);
});

app.get("/api/p2p/ice-servers", async () => ({
  iceServers: getIceServers(env)
}));

app.get("/api/p2p/rooms/:roomId", async (request, reply) => {
  const room = getP2PRoom(request.params.roomId);
  if (!room) {
    return reply.code(404).send({ error: "room not found" });
  }
  return room;
});

app.get("/ws/p2p/:roomId", { websocket: true }, (socket, request) => {
  attachP2PSocket(request.params.roomId, socket);
});

app.get("/api/auth/github/start", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const publicBaseUrl = env.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`;
  const redirectUri = new URL("/api/auth/github/callback", publicBaseUrl).toString();
  const state = crypto.randomUUID();
  const pendingInvite = normalizeQueryString(request.query?.invite);
  reply.setCookie("duallane_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth/github",
    secure: request.protocol === "https"
  });
  if (pendingInvite) {
    reply.setCookie("duallane_pending_invite", pendingInvite, {
      httpOnly: true,
      sameSite: "lax",
      path: "/api/auth/github",
      secure: request.protocol === "https"
    });
  }

  if (!clientId || !clientSecret) {
    if (env.NODE_ENV === "production") {
      return sendWorkspaceError(reply, request, new WorkspaceError("auth.github_not_configured", "GitHub 登录尚未配置", 503));
    }
    return reply.redirect(`${redirectUri}?githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry`);
  }

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "read:user user:email");
  authUrl.searchParams.set("state", state);
  return reply.redirect(authUrl.toString());
});

app.get("/api/auth/github/callback", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  reply.clearCookie("duallane_oauth_state", { path: "/api/auth/github" });

  try {
    const profile = await resolveGitHubProfile(request);
    const pendingInvite = normalizeQueryString(request.cookies?.duallane_pending_invite);
    let user;
    try {
      user = await bindGitHubUser(db, request, profile);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "auth.not_invited" || !pendingInvite) {
        throw error;
      }
      try {
        user = await acceptInvite(db, request, { ...profile, code: pendingInvite });
      } catch (inviteError) {
        if (inviteError instanceof WorkspaceError && inviteError.code.startsWith("invite.")) {
          reply.clearCookie("duallane_pending_invite", { path: "/api/auth/github" });
        }
        throw inviteError;
      }
    }

    const session = await createWorkspaceSession(db, user.id);
    reply.setCookie(WORKSPACE_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: request.protocol === "https",
      expires: new Date(session.expiresAt)
    });
    reply.clearCookie("duallane_pending_invite", { path: "/api/auth/github" });

    if (request.headers.accept?.includes("application/json") || request.query?.format === "json") {
      return { user: publicWorkspaceUser(user), session: { expiresAt: session.expiresAt } };
    }
    return reply.redirect(workspaceFrontendUrl(env, "/?lane=workspace"));
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = request.cookies?.[WORKSPACE_SESSION_COOKIE];
  if (workspaceEnabled) {
    await revokeWorkspaceSession(db, token);
  }
  reply.clearCookie(WORKSPACE_SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

app.get("/api/workspace/bootstrap", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return await getWorkspaceBootstrap(db, await getWorkspaceUserId(request));
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/invites", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const invite = await createInvite(db, request, { ...(request.body ?? {}), actorId: await getWorkspaceUserId(request) });
    return reply.code(201).send({ invite: withInviteUrl(env, invite) });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/invites/:inviteId/revoke", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const invite = await revokeInvite(db, request, {
      actorId: await getWorkspaceUserId(request),
      inviteId: request.params.inviteId
    });
    return reply.send({ invite });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/invites/:code/accept", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  if (env.NODE_ENV === "production") {
    await recordInviteAcceptRejection(db, request, "auth.github_required");
    return sendWorkspaceError(reply, request, new WorkspaceError("auth.github_required", "请通过 GitHub 登录接受邀请", 401));
  }
  try {
    const user = await acceptInvite(db, request, { ...(request.body ?? {}), code: request.params.code });
    const session = await createWorkspaceSession(db, user.id);
    reply.setCookie(WORKSPACE_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: request.protocol === "https",
      expires: new Date(session.expiresAt)
    });
    return reply.code(201).send({ user: publicWorkspaceUser(user) });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/conversations", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return { conversations: await listConversations(db, await getWorkspaceUserId(request), request) };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/conversations/:conversationId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return { conversation: await getConversationDetails(db, await getWorkspaceUserId(request), request.params.conversationId, request) };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/members", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return {
      members: await listMembers(db, await getWorkspaceUserId(request), {
        query: request.query?.q,
        role: request.query?.role,
        kind: request.query?.kind,
        limit: request.query?.limit
      })
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/member-visibility/:userId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return {
      visibility: await getManagedMemberVisibility(db, request, {
        actorId: await getWorkspaceUserId(request),
        userId: request.params.userId
      })
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.put("/api/workspace/member-visibility/:userId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return {
      visibility: await updateManagedMemberVisibility(db, request, {
        ...(request.body ?? {}),
        actorId: await getWorkspaceUserId(request),
        userId: request.params.userId
      })
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.patch("/api/workspace/members/:userId/role", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const member = await updateMemberRole(db, request, {
      ...(request.body ?? {}),
      actorId: await getWorkspaceUserId(request),
      userId: request.params.userId
    });
    return { member };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.delete("/api/workspace/members/:userId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return await removeSpaceMember(db, request, {
      actorId: await getWorkspaceUserId(request),
      userId: request.params.userId
    });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/conversations", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await createConversation(db, request, { ...(request.body ?? {}), actorId: await getWorkspaceUserId(request) });
    return reply.code(201).send({ conversation });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/groups/:conversationId/members", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await addConversationMember(db, request, {
      ...(request.body ?? {}),
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId
    });
    return reply.code(201).send({ conversation });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.delete("/api/workspace/groups/:conversationId/members/:userId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await removeConversationMember(db, request, {
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId,
      userId: request.params.userId
    });
    return { conversation };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.patch("/api/workspace/groups/:conversationId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await updateGroupConversation(db, request, {
      ...(request.body ?? {}),
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId
    });
    return { conversation };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/groups/:conversationId/leave", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return await leaveConversation(db, request, {
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId
    });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/conversations/:conversationId/messages", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return {
      messages: await listMessages(db, await getWorkspaceUserId(request), request.params.conversationId, {
        request,
        before: request.query?.before,
        limit: request.query?.limit
      })
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/conversations/:conversationId/read", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await markConversationRead(db, request, {
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId
    });
    return { conversation };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.patch("/api/workspace/conversations/:conversationId/notification", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const conversation = await updateConversationNotificationLevel(db, request, {
      ...(request.body ?? {}),
      actorId: await getWorkspaceUserId(request),
      conversationId: request.params.conversationId
    });
    return { conversation };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/messages", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const message = await createStructuredMessage(db, request, { ...(request.body ?? {}), actorId: await getWorkspaceUserId(request) });
    return reply.code(201).send({ message });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/messages/:messageId/reactions", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const result = await addMessageReaction(db, request, {
      ...(request.body ?? {}),
      actorId: await getWorkspaceUserId(request),
      messageId: request.params.messageId
    });
    return reply.code(result.created ? 201 : 200).send({
      messageId: result.messageId,
      reactions: result.reactions
    });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.delete("/api/workspace/messages/:messageId/reactions/:emoteKey", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const result = await removeMessageReaction(db, request, {
      actorId: await getWorkspaceUserId(request),
      messageId: request.params.messageId,
      emoteKey: request.params.emoteKey
    });
    return {
      messageId: result.messageId,
      reactions: result.reactions
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/files/uploads/reserve", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const reservation = await reserveUpload(db, request, { ...(request.body ?? {}), actorId: await getWorkspaceUserId(request) });
    const statusCode = reservation.status === "rejected" ? 409 : 201;
    return reply.code(statusCode).send(reservation);
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/files/uploads/:uploadId/complete", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  const actorId = await getWorkspaceUserId(request);
  let upload;
  try {
    upload = await getReservedUpload(db, actorId, request.params.uploadId);
    const stored = await statStoredAttachment(dataDir, upload.attachment.storageKey, upload.attachment.byteSize);
    return await completeUpload(db, request, {
      ...(request.body ?? {}),
      actorId,
      uploadId: request.params.uploadId,
      storageVerifiedByteSize: stored.byteSize
    });
  } catch (error) {
    if (upload) {
      await removeStoredAttachment(dataDir, upload.attachment.storageKey);
      try {
        await failUpload(db, request, {
          actorId,
          uploadId: request.params.uploadId,
          reason: error instanceof Error ? error.message : "upload complete failed"
        });
      } catch {
        // Preserve the original completion/storage error for the client.
      }
    }
    return sendWorkspaceError(reply, request, error);
  }
});

app.put("/api/workspace/files/uploads/:uploadId/content", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  const actorId = await getWorkspaceUserId(request);
  let upload;
  try {
    upload = await getReservedUpload(db, actorId, request.params.uploadId);
    const stored = await saveUploadStream(dataDir, upload.attachment.storageKey, request.body, upload.attachment.byteSize);
    return await completeUpload(db, request, {
      actorId,
      uploadId: request.params.uploadId,
      storageVerifiedByteSize: stored.byteSize
    });
  } catch (error) {
    if (upload) {
      await removeStoredAttachment(dataDir, upload.attachment.storageKey);
      try {
        await failUpload(db, request, {
          actorId,
          uploadId: request.params.uploadId,
          reason: error instanceof Error ? error.message : "upload failed"
        });
      } catch {
        // Preserve the original upload/storage error for the client.
      }
    }
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/files/uploads/:uploadId/fail", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return await failUpload(db, request, { ...(request.body ?? {}), actorId: await getWorkspaceUserId(request), uploadId: request.params.uploadId });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/files", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return {
      files: await listFiles(db, await getWorkspaceUserId(request), {
        scope: request.query?.scope,
        conversationId: request.query?.conversationId,
        uploaderId: request.query?.uploaderId,
        q: request.query?.q,
        limit: request.query?.limit
      }, request)
    };
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.delete("/api/workspace/files/:attachmentId", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    return await removeAttachment(db, request, {
      actorId: await getWorkspaceUserId(request),
      attachmentId: request.params.attachmentId
    });
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.post("/api/workspace/files/:attachmentId/downloads/reserve", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const actorId = await getWorkspaceUserId(request);
    const candidate = await getDownloadableAttachment(db, request, actorId, request.params.attachmentId);
    await statStoredAttachment(dataDir, candidate.storageKey, candidate.byteSize);
    const reservation = await reserveDownload(db, request, { ...(request.body ?? {}), actorId, attachmentId: request.params.attachmentId });
    const statusCode = reservation.status === "rejected" ? 409 : 201;
    return reply.code(statusCode).send(reservation);
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/files/:attachmentId/preview", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const actorId = await getWorkspaceUserId(request);
    const attachment = await getDownloadableAttachment(db, request, actorId, request.params.attachmentId);
    if (!isPreviewableImageMimeType(attachment.mimeType)) {
      throw new WorkspaceValidationError("file.preview_unsupported", "该文件不支持图片预览");
    }
    const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
    reply.header("Content-Type", attachment.mimeType);
    reply.header("Content-Length", String(attachment.byteSize));
    reply.header("Content-Disposition", `inline; filename="${encodeHeaderValue(attachment.fileName)}"`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(stored.path));
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/api/workspace/files/:attachmentId/download", async (request, reply) => {
  if (!workspaceEnabled) {
    return blockWorkspace(reply);
  }
  try {
    const actorId = await getWorkspaceUserId(request);
    const candidate = await getDownloadableAttachment(db, request, actorId, request.params.attachmentId);
    await statStoredAttachment(dataDir, candidate.storageKey, candidate.byteSize);
    const downloadId = normalizeQueryString(request.query?.downloadId);
    let attachment;
    if (downloadId) {
      ({ attachment } = await getCompletedDownload(db, actorId, request.params.attachmentId, downloadId));
    } else {
      const reservation = await reserveDownload(db, request, { actorId, attachmentId: request.params.attachmentId });
      if (reservation.status === "rejected") {
        return reply.code(409).send(reservation);
      }
      ({ attachment } = await getCompletedDownload(db, actorId, request.params.attachmentId, reservation.id));
    }
    const stored = await statStoredAttachment(dataDir, attachment.storageKey, attachment.byteSize);
    reply.header("Content-Type", attachment.mimeType || "application/octet-stream");
    reply.header("Content-Length", String(attachment.byteSize));
    reply.header("Content-Disposition", `attachment; filename="${encodeHeaderValue(attachment.fileName)}"`);
    return reply.send(createReadStream(stored.path));
  } catch (error) {
    return sendWorkspaceError(reply, request, error);
  }
});

app.get("/ws/workspace", { websocket: true }, (socket, request) => {
  if (!workspaceEnabled) {
    socket.close(1013, "workspace disabled");
    return;
  }

  let subscribedUserId = null;
  let lastDeliveredSeq = 0;
  let replayInProgress = false;
  let replayCatchUpRequired = false;

  async function deliverWorkspaceEvents(writtenEvent) {
    let replayAfterSeq = lastDeliveredSeq;
    if (writtenEvent) {
      const pushedEvent = await getWorkspaceEventForUser(db, subscribedUserId, writtenEvent.id);
      if (!pushedEvent) {
        return;
      }
      replayAfterSeq = Math.min(lastDeliveredSeq, pushedEvent.seq - 1);
    }
    const events = await listWorkspaceEvents(db, subscribedUserId, replayAfterSeq);
    for (const event of events) {
      socket.send(JSON.stringify({ version: 1, type: "event", event }));
      lastDeliveredSeq = Math.max(lastDeliveredSeq, event.seq);
    }
    if (events.hasMore) {
      socket.send(JSON.stringify({
        version: 1,
        type: "sync.required",
        spaceId: DEFAULT_SPACE_ID,
        currentSeq: await getWorkspaceEventCursor(db),
        reason: "replay_limit"
      }));
    }
  }

  const unsubscribe = subscribeWorkspaceEvents(async (writtenEvent) => {
    if (!subscribedUserId || socket.readyState !== 1) {
      return;
    }
    if (replayInProgress) {
      replayCatchUpRequired = true;
      return;
    }
    try {
      await deliverWorkspaceEvents(writtenEvent);
    } catch (error) {
      socket.send(JSON.stringify(toWorkspaceSocketError(request, error)));
      socket.close(error instanceof WorkspaceError ? 1008 : 1011, "workspace access changed");
    }
  });

  socket.on("close", unsubscribe);
  socket.on("error", unsubscribe);

  socket.on("message", async (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const userId = await getWorkspaceUserId(request);
      if (parsed.type !== "hello") {
        socket.send(JSON.stringify({ version: 1, type: "error", error: { code: "realtime.invalid", message: "实时同步请求无效" } }));
        return;
      }
      const lastSeq = Math.max(0, Number(parsed.lastSeq) || 0);
      const currentSeq = await getWorkspaceEventCursor(db);
      if (lastSeq > currentSeq) {
        socket.send(JSON.stringify({
          version: 1,
          type: "sync.required",
          spaceId: DEFAULT_SPACE_ID,
          currentSeq,
          reason: "cursor_ahead"
        }));
        return;
      }
      subscribedUserId = userId;
      replayInProgress = true;
      replayCatchUpRequired = false;
      try {
        const events = await listWorkspaceEvents(db, userId, lastSeq);
        const replayCurrentSeq = events.length > 0
          ? Math.max(currentSeq, ...events.map((event) => event.seq))
          : currentSeq;
        socket.send(JSON.stringify({
          version: 1,
          type: "ready",
          spaceId: DEFAULT_SPACE_ID,
          currentSeq: replayCurrentSeq,
          replayFrom: lastSeq + 1,
          replayCount: events.length,
          hasMore: Boolean(events.hasMore)
        }));
        for (const event of events) {
          socket.send(JSON.stringify({ version: 1, type: "event", event }));
        }
        lastDeliveredSeq = events.length > 0
          ? Math.max(lastSeq, ...events.map((event) => event.seq))
          : replayCurrentSeq;
        while (replayCatchUpRequired && socket.readyState === 1) {
          replayCatchUpRequired = false;
          await deliverWorkspaceEvents();
        }
      } catch (error) {
        subscribedUserId = null;
        replayCatchUpRequired = false;
        throw error;
      } finally {
        replayInProgress = false;
      }
    } catch (error) {
      socket.send(JSON.stringify(toWorkspaceSocketError(request, error)));
      if (error instanceof WorkspaceError && error.statusCode === 401) {
        socket.close(1008, "workspace access required");
      }
    }
  });
});

if (env.NODE_ENV === "production" && serveStatic) {
  const distDir = path.resolve(rootDir, "dist");
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: "/"
  });
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html");
  });
}

return app;

async function getWorkspaceUserId(request) {
  const headerUserId = request.headers["x-workspace-user-id"];
  if (env.NODE_ENV !== "production" && typeof headerUserId === "string" && headerUserId) {
    return headerUserId;
  }
  return await getSessionUserId(db, request.cookies?.[WORKSPACE_SESSION_COOKIE]);
}

async function resolveGitHubProfile(request) {
  const query = request.query ?? {};
  if (env.NODE_ENV !== "production" && (query.githubLogin || query.email || query.githubId)) {
    return {
      githubId: query.githubId,
      githubLogin: query.githubLogin,
      email: query.email,
      displayName: query.displayName,
      avatarUrl: query.avatarUrl
    };
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !query.code) {
    if (env.NODE_ENV === "production") {
      throw new WorkspaceError("auth.github_not_configured", "GitHub 登录尚未配置", 503);
    }
    return {
      githubLogin: "timeStarry",
      email: "timestarry@qq.com",
      displayName: "timeStarry"
    };
  }

  if (env.NODE_ENV === "production" && !request.cookies?.duallane_oauth_state) {
    throw new WorkspaceError("auth.invalid_state", "登录状态校验失败", 400);
  }

  if (request.cookies?.duallane_oauth_state && query.state !== request.cookies.duallane_oauth_state) {
    throw new WorkspaceError("auth.invalid_state", "登录状态校验失败", 400);
  }

  const publicBaseUrl = env.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`;
  const redirectUri = new URL("/api/auth/github/callback", publicBaseUrl).toString();
  let phase = "token";

  try {
    const signal = AbortSignal.timeout(githubOAuthTimeoutMs);
    const tokenResponse = await githubFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": GITHUB_API_USER_AGENT
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: query.code,
        redirect_uri: redirectUri
      }),
      signal
    });
    if (!tokenResponse.ok) {
      throw githubOAuthFailure();
    }
    const tokenPayload = await tokenResponse.json();
    const accessToken = normalizeQueryString(tokenPayload?.access_token);
    if (!accessToken) {
      throw githubOAuthFailure();
    }

    phase = "profile";
    const userResponse = await githubFetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": GITHUB_API_USER_AGENT
      },
      signal
    });
    if (!userResponse.ok) {
      throw githubOAuthFailure();
    }
    const userPayload = await userResponse.json();
    const githubId = userPayload?.id === undefined || userPayload?.id === null
      ? ""
      : String(userPayload.id).trim();
    const githubLogin = normalizeQueryString(userPayload?.login);
    if (!githubId || !githubLogin) {
      throw githubOAuthFailure();
    }

    phase = "email";
    const email = normalizeQueryString(userPayload.email) || await fetchPrimaryGitHubEmail(accessToken, signal);
    return {
      githubId,
      githubLogin,
      email,
      displayName: normalizeQueryString(userPayload.name) || githubLogin,
      avatarUrl: normalizeQueryString(userPayload.avatar_url)
    };
  } catch {
    request.log.warn({ event: "github_oauth_failed", phase }, "GitHub OAuth exchange failed");
    await recordGitHubLoginRejection(db, request, phase);
    throw githubOAuthFailure();
  }
}

async function fetchPrimaryGitHubEmail(accessToken, signal) {
  const response = await githubFetch("https://api.github.com/user/emails", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": GITHUB_API_USER_AGENT
    },
    signal
  });
  if (!response.ok) {
    throw githubOAuthFailure();
  }
  const emails = await response.json();
  if (!Array.isArray(emails)) {
    throw githubOAuthFailure();
  }
  const primary = emails.find((email) => email.primary && email.verified) || emails.find((email) => email.verified);
  return normalizeQueryString(primary?.email);
}

function githubOAuthFailure() {
  return new WorkspaceError("auth.github_failed", "GitHub 登录失败", 502);
}

function sendWorkspaceError(reply, request, error) {
  const payload = toWorkspaceError(request, error);
  return reply.code(error instanceof WorkspaceError ? error.statusCode : 500).send(payload);
}

function publicWorkspaceUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    githubLogin: user.githubLogin,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    kind: user.kind,
    role: user.role,
    joinedAt: user.joinedAt
  };
}

function toWorkspaceError(request, error) {
  if (error instanceof WorkspaceError) {
    return {
      error: {
        code: error.code,
        message: error.message
      }
    };
  }
  return {
    error: {
      code: "internal.error",
      message: "服务暂时不可用"
    }
  };
}

function toWorkspaceSocketError(request, error) {
  return {
    version: 1,
    type: "error",
    ...toWorkspaceError(request, error)
  };
}

function encodeHeaderValue(value) {
  return String(value ?? "download").replace(/["\\\r\n]/g, "_");
}

function isPreviewableImageMimeType(mimeType) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(String(mimeType).toLowerCase());
}

function normalizeQueryString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function workspaceFrontendUrl(env, pathnameAndQuery) {
  const configured = normalizeQueryString(env.WORKSPACE_FRONTEND_URL || env.FRONTEND_BASE_URL);
  if (configured) {
    return new URL(pathnameAndQuery, configured).toString();
  }
  if (env.NODE_ENV !== "production") {
    return new URL(pathnameAndQuery, "http://127.0.0.1:5173").toString();
  }
  return pathnameAndQuery;
}

function withInviteUrl(env, invite) {
  if (!invite?.code) {
    return invite;
  }
  return {
    ...invite,
    inviteUrl: workspaceFrontendUrl(env, `/?lane=workspace&invite=${encodeURIComponent(invite.code)}`)
  };
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await createApp();
  await app.listen({ port, host });
}
