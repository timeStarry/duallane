import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import { WorkspaceAgentBotError } from "../services/workspace-agent-bots.mjs";

/**
 * Register owner-facing custom Agent Bot management routes.
 *
 * The factory deliberately receives the authenticated actor resolver and the
 * workspace gate from the application. This keeps Bot routes independent from
 * the monolithic server entrypoint while making it impossible for a request
 * body to choose its acting user or space.
 */
export function registerWorkspaceAgentBotRoutes({
  app,
  service,
  getActorId,
  getSpaceId,
  workspaceEnabled = true,
  blockDisabled,
  sendError
} = {}) {
  if (!app || typeof app.route !== "function") {
    throw new TypeError("workspace Bot routes require a Fastify app");
  }
  if (workspaceEnabled && (!service || typeof service.createBot !== "function")) {
    throw new TypeError("workspace Bot routes require an Agent Bot service when enabled");
  }
  if (typeof getActorId !== "function") {
    throw new TypeError("workspace Bot routes require an actor resolver");
  }

  const resolveSpaceId = typeof getSpaceId === "function"
    ? getSpaceId
    : () => DEFAULT_SPACE_ID;

  const disabled = (request, reply) => {
    if (typeof blockDisabled === "function") {
      return blockDisabled(reply, request);
    }
    return reply.code(503).send({
      error: {
        code: "workspace.disabled",
        message: "共享空间暂未开放"
      }
    });
  };

  const fail = (request, reply, error) => {
    if (typeof sendError === "function") {
      return sendError(reply, request, error);
    }
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const code = error?.code || "internal.error";
    const message = error instanceof WorkspaceAgentBotError
      ? error.message
      : statusCode >= 500
        ? "服务暂时不可用"
        : String(error?.message || "请求无效");
    return reply.code(statusCode).send({ error: { code, message } });
  };

  const actor = async (request) => {
    const actorId = await getActorId(request);
    if (typeof actorId !== "string" || actorId.trim().length === 0) {
      throw new WorkspaceAgentBotError("auth.required", "请先登录共享空间", 401);
    }
    return actorId;
  };

  const space = async (request) => {
    const value = await resolveSpaceId(request);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new WorkspaceAgentBotError("space.invalid", "Workspace 空间无效");
    }
    return value;
  };

  const call = (handler) => async (request, reply) => {
    if (!workspaceEnabled) return disabled(request, reply);
    reply.header("cache-control", "no-store");
    try {
      if (request.validationError) {
        throw new WorkspaceAgentBotError("bot.invalid_request", "请求参数无效", 400);
      }
      return await handler(request, reply);
    } catch (error) {
      return fail(request, reply, error);
    }
  };

  app.post("/api/workspace/bots", {
    attachValidation: true,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } }
      }
    }
  }, call(async (request, reply) => {
    const bot = await service.createBot(await actor(request), {
      name: request.body?.name,
      spaceId: await space(request)
    });
    return reply.code(201).send({ bot });
  }));

  app.get("/api/workspace/bots", call(async (request) => ({
    bots: await service.listOwnedBots(await actor(request), await space(request))
  })));

  app.get("/api/workspace/bots/:botId", call(async (request) => ({
    bot: await service.getOwnedBot(await actor(request), await space(request), request.params.botId)
  })));

  app.get("/api/workspace/bots/:botId/settings", call(async (request) => ({
    settings: await service.getSettings(await actor(request), request.params.botId, await space(request))
  })));

  app.patch("/api/workspace/bots/:botId/settings", call(async (request) => ({
    settings: await service.updateSettings(await actor(request), request.params.botId, {
      ...(request.body || {}),
      spaceId: await space(request)
    })
  })));

  app.get("/api/workspace/bots/:botId/group-policies", call(async (request) => ({
    policies: await service.listGroupPolicies(await actor(request), request.params.botId, await space(request))
  })));

  app.patch("/api/workspace/bots/:botId/group-policies/:conversationId", call(async (request) => ({
    policy: await service.updateGroupPolicy(await actor(request), request.params.botId, {
      ...(request.body || {}),
      conversationId: request.params.conversationId,
      spaceId: await space(request)
    })
  })));

  app.patch("/api/workspace/bots/:botId/context-grants/:conversationId", call(async (request) => ({
    grant: await service.updateContextGrant(await actor(request), request.params.botId, {
      ...(request.body || {}),
      conversationId: request.params.conversationId,
      spaceId: await space(request)
    })
  })));

  app.post("/api/workspace/bots/:botId/tokens", {
    attachValidation: true,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopes: { type: "array", items: { type: "string" }, minItems: 1 },
          expiresAt: { type: ["string", "null"] }
        }
      }
    }
  }, call(async (request, reply) => {
    const issued = await service.issueToken(await actor(request), request.params.botId, {
      ...(request.body || {}),
      spaceId: await space(request)
    });
    // The raw credential is returned only from this issuance response. The
    // service already persists only its SHA-256 hash and future projections
    // contain a fixed mask.
    const { token, ...tokenRecord } = issued;
    return reply.code(201).send({ token, tokenRecord });
  }));

  app.post("/api/workspace/bots/:botId/setup-sessions", {
    attachValidation: true,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          requestedScopes: { type: "array", items: { type: "string" }, maxItems: 10 },
          conversationIds: { type: "array", items: { type: "string" }, maxItems: 200 }
        }
      }
    }
  }, call(async (request, reply) => {
    const session = await service.createSetupSession(await actor(request), request.params.botId, {
      ...(request.body || {}),
      spaceId: await space(request)
    });
    return reply.code(201).send({
      session,
      // Resolve the relative handle in the trusted browser origin. Never use
      // a client-controlled Origin header to construct an authorization host.
      setupUrl: `/workspace/account/bot?setup=${encodeURIComponent(session.id)}`
    });
  }));

  app.get("/api/workspace/bot-setup/:sessionId", call(async (request) => ({
    session: await service.getSetupSession(await actor(request), request.params.sessionId, await space(request))
  })));

  app.post("/api/workspace/bot-setup/:sessionId/approve", {
    attachValidation: true,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopes: { type: "array", items: { type: "string" }, maxItems: 10 },
          conversationIds: { type: "array", items: { type: "string" }, maxItems: 200 }
        }
      }
    }
  }, call(async (request) => ({
    session: await service.approveSetupSession(await actor(request), request.params.sessionId, {
      ...(request.body || {}),
      spaceId: await space(request)
    })
  })));

  app.post("/api/workspace/bot-setup/:sessionId/deny", call(async (request) => ({
    session: await service.denySetupSession(await actor(request), request.params.sessionId, await space(request))
  })));

  app.post("/api/workspace/bots/:botId/tokens/rotate", call(async (request, reply) => {
    const issued = await service.rotateToken(await actor(request), request.params.botId, {
      ...(request.body || {}),
      spaceId: await space(request)
    });
    const { token, ...tokenRecord } = issued;
    return reply.code(201).send({ token, tokenRecord });
  }));

  app.get("/api/workspace/bots/:botId/tokens", call(async (request) => ({
    tokens: await service.listTokens(await actor(request), request.params.botId, await space(request))
  })));

  app.post("/api/workspace/bots/:botId/tokens/:tokenId/revoke", call(async (request) => ({
    token: await service.revokeToken(
      await actor(request),
      request.params.botId,
      request.params.tokenId,
      await space(request)
    )
  })));

  app.post("/api/workspace/bots/:botId/pause", call(async (request) => ({
    bot: await service.pauseBot(await actor(request), request.params.botId, await space(request))
  })));

  app.post("/api/workspace/bots/:botId/resume", call(async (request) => ({
    bot: await service.resumeBot(await actor(request), request.params.botId, await space(request))
  })));

  app.get("/api/workspace/bots/:botId/connection", call(async (request) => ({
    connection: await service.getConnectionStatus(await actor(request), request.params.botId, await space(request))
  })));

  app.post("/api/workspace/bots/:botId/connection/test", call(async (request) => ({
    connection: await service.testConnection(await actor(request), request.params.botId, await space(request))
  })));

  app.delete("/api/workspace/bots/:botId", call(async (request) => ({
    bot: await service.beginDeleteBot(await actor(request), request.params.botId, await space(request))
  })));

  // Deletion is deliberately two-stage. A separate confirmation endpoint
  // prevents accidental one-request permanent removal and makes retries
  // idempotent through the service state machine.
  const finalizeDelete = call(async (request) => ({
    bot: await service.finalizeDeleteBot(await actor(request), request.params.botId, await space(request))
  }));
  app.post("/api/workspace/bots/:botId/delete/confirm", finalizeDelete);

  return app;
}
