import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceInteractionRoutes } from "./workspace-interactions.mjs";

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(options = {}) {
  const app = Fastify({ logger: false });
  const service = options.service ?? {
    executeCommand: vi.fn(async () => ({ ok: true })),
    startWorkflow: vi.fn(async () => ({ id: "wf_1" })),
    getWorkflow: vi.fn(async () => ({ id: "wf_1" })),
    continueWorkflow: vi.fn(async () => ({ workflow: { id: "wf_1" } })),
    cancelWorkflow: vi.fn(async () => ({ id: "wf_1", status: "cancelled" }))
  };
  registerWorkspaceInteractionRoutes(app, {
    service,
    enabled: options.enabled ?? true,
    getActorId: options.getActorId ?? ((request) => request.headers["x-workspace-user-id"] ?? null)
  });
  apps.push(app);
  return { app, service };
}

describe("Workspace interaction routes", () => {
  it("returns the disabled contract before resolving callers", async () => {
    const { app } = fixture({ enabled: false, getActorId: () => { throw new Error("must not run"); } });
    const response = await app.inject({ method: "GET", url: "/api/workspace/workflows/wf_1" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("workspace.disabled");
  });

  it("does not accept actor or space identity from command bodies", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/interactions/commands",
      headers: { "x-workspace-user-id": "usr_owner" },
      payload: {
        actorId: "usr_forged",
        spaceId: "spc_forged",
        conversationId: "conv_1",
        botUserId: "usr_system_echo",
        source: "/need",
        clientInvocationId: "invoke_1"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(service.executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "usr_owner",
      spaceId: "spc_default",
      conversationId: "conv_1"
    }));
  });

  it("requires authentication for workflow access", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "POST", url: "/api/workspace/workflows", payload: { type: "echo.requirement" } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth.required");
  });

  it("passes workflow invocation and request metadata through every mutating route", async () => {
    const { app, service } = fixture();
    const headers = { "x-workspace-user-id": "usr_owner", "user-agent": "route-test-agent" };
    await app.inject({
      method: "POST",
      url: "/api/workspace/workflows",
      headers,
      payload: {
        conversationId: "conv_1",
        botUserId: "usr_system_echo",
        type: "echo.requirement",
        clientInvocationId: "workflow-start-route-1"
      }
    });
    await app.inject({
      method: "POST",
      url: "/api/workspace/workflows/wf_1/continue",
      headers,
      payload: { expectedRevision: 1, input: { title: "secret" } }
    });
    await app.inject({ method: "POST", url: "/api/workspace/workflows/wf_1/cancel", headers, payload: {} });

    expect(service.startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      clientInvocationId: "workflow-start-route-1",
      request: expect.objectContaining({ userAgent: "route-test-agent" })
    }));
    expect(service.continueWorkflow).toHaveBeenCalledWith("usr_owner", expect.objectContaining({
      spaceId: "spc_default",
      request: expect.objectContaining({ userAgent: "route-test-agent" })
    }));
    expect(service.cancelWorkflow).toHaveBeenCalledWith("usr_owner", expect.objectContaining({
      workflowId: "wf_1",
      spaceId: "spc_default",
      request: expect.objectContaining({ userAgent: "route-test-agent" })
    }));
  });

  it("returns safe workflow conflict details", async () => {
    const error = Object.assign(new Error("已有流程"), {
      name: "WorkspaceInteractionError",
      code: "workflow.active_conflict",
      statusCode: 409,
      details: { activeWorkflowId: "wf_active" }
    });
    const { app } = fixture({ service: {
      executeCommand: vi.fn(),
      startWorkflow: vi.fn(async () => { throw error; }),
      getWorkflow: vi.fn(),
      continueWorkflow: vi.fn(),
      cancelWorkflow: vi.fn()
    } });
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/workflows",
      headers: { "x-workspace-user-id": "usr_owner" },
      payload: {
        conversationId: "conv_1",
        botUserId: "usr_system_echo",
        type: "echo.requirement",
        clientInvocationId: "workflow-conflict-route"
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "workflow.active_conflict",
        message: "已有流程",
        details: { activeWorkflowId: "wf_active" }
      }
    });
  });
});
