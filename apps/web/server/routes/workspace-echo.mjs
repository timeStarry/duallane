import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import {
  createEchoRequirementService,
  EchoRequirementError
} from "../services/echo-requirements.mjs";
import {
  createEchoSolicitationService,
  EchoSolicitationError
} from "../services/echo-solicitations.mjs";

/**
 * Register the private Echo requirement workflow without coupling it to the
 * monolithic Workspace application. The host application supplies its normal
 * session resolver through `getActorId`; development/test hosts may use a
 * header resolver explicitly.
 *
 * The service owns visibility and transition policy. These handlers only
 * translate HTTP input/output and never project requirement content into
 * events or audit records themselves.
 */
export function registerWorkspaceEchoRequirementRoutes(app, options = {}) {
  if (!app || typeof app.post !== "function" || typeof app.get !== "function") {
    throw new TypeError("Echo routes require a Fastify application");
  }
  // The main app registers the route module even while Workspace is disabled,
  // at which point no database is opened. Defer the dependency error until a
  // request actually passes the feature gate so disabled hosts stay inert.
  const service = options.service ?? (options.db
    ? createEchoRequirementService({
      db: options.db,
      spaceId: options.spaceId ?? DEFAULT_SPACE_ID,
      now: options.now
    })
    : null);
  const solicitationService = options.solicitationService ?? (options.db
    ? createEchoSolicitationService({
      db: options.db,
      spaceId: options.spaceId ?? DEFAULT_SPACE_ID,
      now: options.now
    })
    : null);
  const spaceId = options.spaceId ?? DEFAULT_SPACE_ID;
  const enabled = options.ensureWorkspaceEnabled ?? options.enabled ?? true;
  const getActorId = options.getActorId ?? defaultActorId;
  const errorHandler = options.sendError ?? sendEchoError;

  const handle = (operation, serviceRef = service) => async (request, reply) => {
    try {
      if (typeof enabled === "function" ? !(await enabled(request)) : !enabled) {
        return reply.code(503).send({
          error: { code: "workspace.disabled", message: "共享空间暂未开放" }
        });
      }
      if (!serviceRef) {
        return reply.code(503).send({
          error: { code: "echo.unavailable", message: "回声服务暂不可用" }
        });
      }
      const actorId = await getActorId(request);
      const requestMeta = requestMetadata(request);
      const result = await operation({ request, actorId, requestMeta });
      if (result && result.statusCode) {
        const { statusCode, ...payload } = result;
        return reply.code(statusCode).send(payload);
      }
      return result;
    } catch (error) {
      return errorHandler(reply, request, error);
    }
  };

  app.post("/api/workspace/echo/requirements", handle(async ({ request, actorId, requestMeta }) => {
    const body = requireObjectBody(request.body);
    const requirement = await service.submit({
      ...body,
      actorId,
      spaceId,
      request: requestMeta
    });
    return { requirement, statusCode: 201 };
  }));

  app.get("/api/workspace/echo/requirements", handle(async ({ request, actorId, requestMeta }) => {
    const query = request.query && typeof request.query === "object" ? request.query : {};
    const listInput = {
      actorId,
      spaceId,
      state: query.state,
      phase: query.phase,
      status: query.status,
      archiveOutcome: query.archiveOutcome,
      type: query.type,
      submitterUserId: query.submitterUserId,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      offset: query.offset,
      limit: query.limit,
      request: requestMeta
    };
    if (typeof service.listPage === "function") {
      const page = await service.listPage(listInput);
      return { requirements: page.items, total: page.total, pageInfo: page.pageInfo };
    }
    return { requirements: await service.list(listInput) };
  }));

  app.get("/api/workspace/echo/requirements/stats", handle(async ({ request, actorId, requestMeta }) => ({
    stats: await service.stats({ actorId, spaceId, request: requestMeta })
  })));

  app.get("/api/workspace/echo/requirements/:publicId", handle(async ({ request, actorId, requestMeta }) => {
    const requirement = await service.get({
      actorId,
      spaceId,
      publicId: request.params?.publicId,
      request: requestMeta
    });
    return { requirement };
  }));

  app.get("/api/workspace/echo/requirements/:publicId/history", handle(async ({ request, actorId, requestMeta }) => {
    const history = await service.history({
      actorId,
      spaceId,
      publicId: request.params?.publicId,
      request: requestMeta
    });
    return { history };
  }));

  app.post("/api/workspace/echo/requirements/:publicId/transition", handle(async ({ request, actorId, requestMeta }) => {
    const body = requireObjectBody(request.body);
    const requirement = await service.transition({
      ...body,
      actorId,
      spaceId,
      publicId: request.params?.publicId,
      request: requestMeta
    });
    return { requirement };
  }));

  app.post("/api/workspace/echo/solicitations", handle(async ({ request, actorId, requestMeta }) => {
    const body = requireObjectBody(request.body);
    const solicitation = await solicitationService.create({ ...body, actorId, spaceId, request: requestMeta });
    return { solicitation, statusCode: 201 };
  }, solicitationService));

  app.get("/api/workspace/echo/solicitations", handle(async ({ request, actorId, requestMeta }) => {
    const query = request.query && typeof request.query === "object" ? request.query : {};
    return {
      solicitations: await solicitationService.list({
        actorId,
        spaceId,
        status: query.status,
        limit: query.limit,
        request: requestMeta
      })
    };
  }, solicitationService));

  app.get("/api/workspace/echo/solicitations/:publicId", handle(async ({ request, actorId, requestMeta }) => ({
    solicitation: await solicitationService.get({ actorId, spaceId, publicId: request.params?.publicId, request: requestMeta })
  }), solicitationService));

  app.post("/api/workspace/echo/solicitations/:publicId/publish", handle(async ({ request, actorId, requestMeta }) => ({
    solicitation: await solicitationService.publish({
      ...asObject(request.body), actorId, spaceId, publicId: request.params?.publicId, request: requestMeta
    })
  }), solicitationService));

  app.post("/api/workspace/echo/solicitations/:publicId/close", handle(async ({ request, actorId, requestMeta }) => ({
    solicitation: await solicitationService.close({
      ...asObject(request.body), actorId, spaceId, publicId: request.params?.publicId, request: requestMeta
    })
  }), solicitationService));

  app.post("/api/workspace/echo/solicitations/:publicId/withdraw", handle(async ({ request, actorId, requestMeta }) => ({
    solicitation: await solicitationService.withdraw({
      ...asObject(request.body), actorId, spaceId, publicId: request.params?.publicId, request: requestMeta
    })
  }), solicitationService));

  app.post("/api/workspace/echo/solicitations/:publicId/vote", handle(async ({ request, actorId, requestMeta }) => ({
    solicitation: await solicitationService.vote({
      ...asObject(request.body), actorId, spaceId, publicId: request.params?.publicId, request: requestMeta
    })
  }), solicitationService));

  app.get("/api/workspace/echo/solicitations/:publicId/votes", handle(async ({ request, actorId, requestMeta }) => ({
    votes: await solicitationService.listVotes({ actorId, spaceId, publicId: request.params?.publicId, request: requestMeta })
  }), solicitationService));

  app.get("/api/workspace/echo/solicitations/:publicId/deliveries", handle(async ({ request, actorId, requestMeta }) => ({
    deliveries: await solicitationService.listDeliveries({ actorId, spaceId, publicId: request.params?.publicId, request: requestMeta })
  }), solicitationService));

  return service;
}

// Short alias for hosts that group all Echo endpoints under one route module.
export const registerWorkspaceEchoRoutes = registerWorkspaceEchoRequirementRoutes;

function defaultActorId(request) {
  if (request?.user?.id) return request.user.id;
  return null;
}

function requestMetadata(request) {
  return {
    requestId: request?.id,
    ipAddress: request?.ip,
    userAgent: request?.headers?.["user-agent"]
  };
}

function requireObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EchoRequirementError("echo.body_invalid", "请求内容无效", 400);
  }
  return body;
}

function asObject(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

export function sendEchoError(reply, _request, error) {
  if (error instanceof EchoRequirementError || error instanceof EchoSolicitationError || error?.name === "EchoRequirementError" || error?.name === "EchoSolicitationError") {
    return reply.code(error.statusCode ?? 400).send({
      error: {
        code: error.code,
        message: error.message
      }
    });
  }
  return reply.code(500).send({
    error: {
      code: "internal.error",
      message: "服务暂时不可用"
    }
  });
}
