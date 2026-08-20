import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceBotGatewayRoutes } from "./workspace-bot-gateway.mjs";

describe("Bot Gateway context route", () => {
  let app;

  afterEach(async () => app?.close());

  it("delegates context authorization and limits to the Gateway service", async () => {
    const gateway = {
      authenticate: vi.fn(async () => ({ botId: "bot_context", spaceId: "spc_default" })),
      getContext: vi.fn(async (_auth, conversationId, query) => ({ conversation: { id: conversationId }, messages: [], limit: Number(query.limit) }))
    };
    app = Fastify({ logger: false });
    registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled: true });
    const response = await app.inject({
      method: "GET",
      url: "/api/bot-gateway/v1/conversations/conv_context/context?limit=10",
      headers: { authorization: `Bearer dl_bot_${"x".repeat(32)}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conversation: { id: "conv_context" }, messages: [], limit: 10 });
    expect(gateway.getContext).toHaveBeenCalledWith(
      { botId: "bot_context", spaceId: "spc_default" },
      "conv_context",
      { limit: "10" }
    );
  });
});
