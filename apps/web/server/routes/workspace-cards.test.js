import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCardRoutes } from "./workspace-cards.mjs";
import { WorkspaceCardInteractionError } from "../services/workspace-card-interactions.mjs";

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(options = {}) {
  const app = Fastify({ logger: false });
  const service = options.service ?? {
    resolveCard: vi.fn(async (_actorId, cardId) => ({ block: { cardId }, revision: 1 })),
    executeAction: vi.fn(async () => ({ ok: true, replayed: false, revision: 2, result: {} }))
  };
  registerWorkspaceCardRoutes(app, {
    service,
    enabled: options.enabled ?? true,
    getActorId: options.getActorId ?? ((request) => request.headers["x-workspace-user-id"] ?? null)
  });
  apps.push(app);
  return { app, service };
}

describe("Workspace card routes", () => {
  it("keeps the Workspace disabled gate ahead of authentication and service access", async () => {
    const service = { resolveCard: vi.fn(), executeAction: vi.fn() };
    const { app } = fixture({ enabled: false, service, getActorId: () => { throw new Error("must not run"); } });
    const response = await app.inject({ method: "GET", url: "/api/workspace/cards/card_1" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("workspace.disabled");
    expect(service.resolveCard).not.toHaveBeenCalled();
  });

  it("requires a human Workspace session before resolving cards", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/api/workspace/cards/card_1" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth.required");
  });

  it("returns the latest actor-scoped card registry projection", async () => {
    const projection = {
      type: "card_fallback",
      block: {
        type: "card",
        cardId: "card_1",
        cardType: "future.poll",
        schemaVersion: 1,
        fallbackText: "新投票卡片"
      },
      fallbackText: "新投票卡片",
      revision: 2,
      status: "active"
    };
    const service = {
      resolveCard: vi.fn(async () => projection),
      executeAction: vi.fn()
    };
    const { app } = fixture({ service });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/cards/card_1",
      headers: { "x-workspace-user-id": "usr_member", "user-agent": "vitest" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ card: projection });
    expect(service.resolveCard).toHaveBeenCalledWith("usr_member", "card_1", expect.objectContaining({
      requestId: expect.any(String),
      userAgent: "vitest"
    }));
  });

  it("forwards stable action contracts without trusting actor fields from the body", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/cards/card_1/actions",
      headers: { "x-workspace-user-id": "usr_member", "user-agent": "vitest" },
      payload: {
        actorId: "usr_forged",
        actionId: "vote",
        expectedRevision: 3,
        clientActionId: "client-action-1",
        input: { optionId: "opt_1" }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(service.executeAction).toHaveBeenCalledWith("usr_member", expect.objectContaining({
      cardId: "card_1",
      actionId: "vote",
      expectedRevision: 3,
      clientActionId: "client-action-1",
      input: { optionId: "opt_1" }
    }));
  });

  it("returns service error codes without leaking internal errors", async () => {
    const { app } = fixture({
      service: {
        resolveCard: vi.fn(async () => { throw new WorkspaceCardInteractionError("card.not_found", "卡片不存在或不可访问", 404); }),
        executeAction: vi.fn()
      }
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/cards/card_missing",
      headers: { "x-workspace-user-id": "usr_member" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "card.not_found", message: "卡片不存在或不可访问" } });
  });
});
