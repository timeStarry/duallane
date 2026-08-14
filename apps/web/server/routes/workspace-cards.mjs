import { WorkspaceCardInteractionError } from "../services/workspace-card-interactions.mjs";

export function registerWorkspaceCardRoutes(app, options = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("Workspace card routes require a Fastify application");
  }
  const service = options.service ?? null;
  const enabled = options.enabled ?? true;
  const getActorId = options.getActorId ?? ((request) => request?.user?.id ?? null);
  const sendError = options.sendError ?? sendWorkspaceCardError;

  const handle = (operation) => async (request, reply) => {
    try {
      if (typeof enabled === "function" ? !(await enabled(request)) : !enabled) {
        return reply.code(503).send({ error: { code: "workspace.disabled", message: "共享空间暂未开放" } });
      }
      if (!service) {
        return reply.code(503).send({ error: { code: "card.unavailable", message: "卡片服务暂不可用" } });
      }
      const actorId = await getActorId(request);
      if (!actorId) throw new WorkspaceCardInteractionError("auth.required", "请先登录共享空间", 401);
      return await operation({ request, reply, actorId });
    } catch (error) {
      return sendError(reply, request, error);
    }
  };

  app.get("/api/workspace/cards/:cardId", handle(async ({ request, actorId }) => ({
    card: await service.resolveCard(actorId, request.params?.cardId, requestMetadata(request))
  })));

  app.post("/api/workspace/cards/:cardId/actions", handle(async ({ request, actorId }) => {
    const body = requireObject(request.body);
    return {
      action: await service.executeAction(actorId, {
        cardId: request.params?.cardId,
        actionId: body.actionId,
        input: body.input ?? {},
        expectedRevision: body.expectedRevision,
        clientActionId: body.clientActionId,
        request: requestMetadata(request)
      })
    };
  }));

  return service;
}

export function sendWorkspaceCardError(reply, _request, error) {
  if (error instanceof WorkspaceCardInteractionError || error?.name === "WorkspaceCardInteractionError") {
    return reply.code(error.statusCode ?? 400).send({
      error: { code: error.code, message: error.message }
    });
  }
  return reply.code(500).send({
    error: { code: "internal.error", message: "服务暂时不可用" }
  });
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceCardInteractionError("card.invalid_request", "请求内容无效");
  }
  return value;
}

function requestMetadata(request) {
  return {
    requestId: request?.id,
    ipAddress: request?.ip,
    userAgent: request?.headers?.["user-agent"]
  };
}
