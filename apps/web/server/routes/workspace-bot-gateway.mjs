import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import { BOT_GATEWAY_VERSION, WorkspaceBotGatewayError, extractBearerToken } from "../services/workspace-bot-gateway.mjs";

export function registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled = true, getSpaceId, blockDisabled, sendError } = {}) {
  if (!app || (workspaceEnabled && !gateway)) throw new TypeError("Bot Gateway routes require app and gateway when enabled");
  const resolveSpaceId = typeof getSpaceId === "function" ? getSpaceId : () => DEFAULT_SPACE_ID;
  const disabled = (_request, reply) => typeof blockDisabled === "function"
    ? blockDisabled(reply)
    : reply.code(503).send({ error: { code: "workspace.disabled", message: "共享空间暂未开放" } });
  const fail = (request, reply, error) => {
    if (typeof sendError === "function") return sendError(reply, request, error);
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return reply.code(statusCode).send({ error: { code: error?.code || "internal.error", message: statusCode >= 500 ? "服务暂时不可用" : String(error?.message || "请求无效") } });
  };
  const authenticated = (handler) => async (request, reply) => {
    if (!workspaceEnabled) return disabled(request, reply);
    try {
      const auth = await gateway.authenticate(extractBearerToken(request.headers.authorization), { spaceId: await resolveSpaceId(request) });
      return await handler(request, reply, auth);
    } catch (error) {
      return fail(request, reply, error);
    }
  };

  app.get("/api/bot-gateway/v1/me", authenticated(async (_request, _reply, auth) => gateway.getMe(auth)));
  app.post("/api/bot-gateway/v1/events/ack", authenticated(async (request, _reply, auth) => gateway.acknowledge(auth, request.body ?? {})));
  // Message bodies are intentionally not exposed here until the deployment
  // supplies an explicit per-conversation context grant and content egress
  // policy; the Gateway service remains the single enforcement boundary.
  app.get("/api/bot-gateway/v1/conversations/:conversationId/context", authenticated(async (_request, reply) => reply.code(403).send({ error: { code: "bot.context_forbidden", message: "Bot 未获准读取该会话上下文" } })));
  app.post("/api/bot-gateway/v1/messages", authenticated(async (request, reply, auth) => reply.code(201).send(await gateway.sendMessage(auth, request.body ?? {}))));
  app.post("/api/bot-gateway/v1/cards", authenticated(async (request, reply, auth) => reply.code(201).send(await gateway.sendCard(auth, request.body ?? {}))));
  app.patch("/api/bot-gateway/v1/cards/:cardId", authenticated(async (request, _reply, auth) => gateway.updateCard(auth, request.params.cardId, request.body ?? {})));
  app.get("/api/bot-gateway/v1/attachments/:attachmentId", authenticated(async (request, _reply, auth) => gateway.getAttachment(auth, request.params.attachmentId)));
  app.post("/api/bot-gateway/v1/attachments", authenticated(async (request, reply, auth) => reply.code(201).send(await gateway.createAttachment(auth, request.body ?? {}))));
  app.post("/api/bot-gateway/v1/typing", authenticated(async (request, _reply, auth) => gateway.typing(auth, request.body ?? {})));

  app.get("/ws/bot-gateway", { websocket: true }, (socket, request) => {
    if (!workspaceEnabled) {
      socket.close(1013, "workspace disabled");
      return;
    }
    let auth;
    let cleanup = async () => {};
    let helloReceived = false;
    let closed = false;
    const heartbeat = setInterval(() => {
      void (async () => {
        if (socket.readyState !== 1 || !auth || closed) return;
        try {
          auth = await gateway.validateAuth(auth);
          socket.ping();
        } catch {
          socket.close(1008, "bot token revoked");
          await close();
        }
      })();
    }, 30_000);
    heartbeat.unref?.();
    const close = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await cleanup();
    };
    socket.on("close", () => { void close(); });
    socket.on("error", () => { void close(); });

    void (async () => {
      try {
        auth = await gateway.authenticate(extractBearerToken(request.headers.authorization), { spaceId: await resolveSpaceId(request) });
        cleanup = await gateway.registerConnection(auth, {
          adapterVersion: typeof request.headers["x-duallane-adapter-version"] === "string" ? request.headers["x-duallane-adapter-version"] : null,
          connectionNonce: crypto.randomUUID(),
          send: (message) => socket.send(message),
          close: (code, reason) => socket.close(code, reason)
        });
      } catch {
        socket.close(1008, "bot authentication required");
      }
    })();

    socket.on("message", async (raw) => {
      if (!auth || closed) return;
      try {
        auth = await gateway.validateAuth(auth);
        const parsed = JSON.parse(raw.toString());
        if (!helloReceived) {
          if (parsed?.type !== "hello" || parsed.version !== BOT_GATEWAY_VERSION) throw new WorkspaceBotGatewayError("gateway.invalid_hello", "Gateway Hello 无效");
          helloReceived = true;
          const replay = await gateway.replay(auth, parsed.lastSequence ?? parsed.lastSeq ?? 0);
          if (replay.syncRequired) socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "sync_required", currentSequence: replay.currentSequence, reason: replay.reason }));
          else {
            socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "ready", currentSequence: replay.currentSequence, replayCount: replay.events.length, hasMore: replay.hasMore }));
            for (const event of replay.events) socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "event", event }));
          }
          return;
        }
        if (parsed?.type === "heartbeat") {
          const result = await gateway.heartbeat(auth);
          socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "heartbeat", id: parsed.id ?? null, timestamp: result.timestamp }));
        } else if (parsed?.type === "ack") {
          socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "ack", ...(await gateway.acknowledge(auth, parsed)) }));
        } else {
          socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "error", error: { code: "gateway.invalid_message", message: "Gateway 消息无效" } }));
        }
      } catch (error) {
        if (error?.code === "bot.invalid_token") {
          socket.close(1008, "bot token revoked");
          await close();
          return;
        }
        socket.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "error", error: { code: error?.code || "gateway.invalid_message", message: error?.message || "Gateway 消息无效" } }));
      }
    });
  });
  return app;
}
