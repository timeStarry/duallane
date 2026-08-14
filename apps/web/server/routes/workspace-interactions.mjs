import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import { WorkspaceInteractionError } from "../services/workspace-interactions.mjs";

export function registerWorkspaceInteractionRoutes(app, options = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("Workspace interaction routes require a Fastify application");
  }
  const service = options.service ?? null;
  const enabled = options.enabled ?? true;
  const getActorId = options.getActorId ?? ((request) => request?.user?.id ?? null);
  const spaceId = options.spaceId ?? DEFAULT_SPACE_ID;

  const handle = (operation) => async (request, reply) => {
    try {
      if (typeof enabled === "function" ? !(await enabled(request)) : !enabled) {
        return reply.code(503).send({ error: { code: "workspace.disabled", message: "共享空间暂未开放" } });
      }
      if (!service) return reply.code(503).send({ error: { code: "interaction.unavailable", message: "交互服务暂不可用" } });
      const actorId = await getActorId(request);
      if (!actorId) throw new WorkspaceInteractionError("auth.required", "请先登录共享空间", 401);
      return await operation({ request, actorId });
    } catch (error) {
      return sendWorkspaceInteractionError(reply, request, error);
    }
  };

  app.post("/api/workspace/interactions/commands", handle(async ({ request, actorId }) => {
    const body = requireObject(request.body);
    return {
      command: await service.executeCommand({
        actorId,
        spaceId,
        conversationId: body.conversationId,
        botUserId: body.botUserId,
        source: body.source,
        mentionedBotIds: body.mentionedBotIds,
        clientInvocationId: body.clientInvocationId,
        request: requestMetadata(request)
      })
    };
  }));

  app.post("/api/workspace/workflows", handle(async ({ request, actorId }) => {
    const body = requireObject(request.body);
    return {
      workflow: await service.startWorkflow({
        actorId,
        spaceId,
        conversationId: body.conversationId,
        botUserId: body.botUserId,
        type: body.type,
        version: body.version,
        input: body.input,
        ttlMs: body.ttlMs
      })
    };
  }));

  app.get("/api/workspace/workflows/:workflowId", handle(async ({ request, actorId }) => ({
    workflow: await service.getWorkflow(actorId, request.params?.workflowId)
  })));

  app.post("/api/workspace/workflows/:workflowId/continue", handle(async ({ request, actorId }) => {
    const body = requireObject(request.body);
    return service.continueWorkflow(actorId, {
      workflowId: request.params?.workflowId,
      expectedRevision: body.expectedRevision,
      input: body.input
    });
  }));

  app.post("/api/workspace/workflows/:workflowId/cancel", handle(async ({ request, actorId }) => ({
    workflow: await service.cancelWorkflow(actorId, request.params?.workflowId)
  })));
}

export function sendWorkspaceInteractionError(reply, _request, error) {
  if (error instanceof WorkspaceInteractionError || error?.name === "WorkspaceInteractionError") {
    return reply.code(error.statusCode ?? 400).send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({ error: { code: "internal.error", message: "服务暂时不可用" } });
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceInteractionError("interaction.invalid_request", "请求内容无效");
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
