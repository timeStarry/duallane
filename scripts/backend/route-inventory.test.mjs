import assert from "node:assert/strict";
import test from "node:test";
import { extractRoutes } from "./route-inventory.mjs";

test("route inventory preserves methods, parameters and transport", () => {
  const routes = extractRoutes(`app.get("/ws/p2p/:roomId", handler);
    app.patch('/api/workspace/bots/:botId', handler);`, "fixture.mjs");
  assert.deepEqual(routes.map(({ method, path, lane, transport }) => ({ method, path, lane, transport })), [
    { method: "GET", path: "/ws/p2p/{roomId}", lane: "p2p", transport: "websocket" },
    { method: "PATCH", path: "/api/workspace/bots/{botId}", lane: "workspace", transport: "http" }
  ]);
});

test("route inventory refuses unsupported registrations instead of dropping them", () => {
  for (const source of ["app.get(dynamicPath, handler)", "app.route({})", "app.all('/api/x', handler)"]) {
    assert.throws(() => extractRoutes(source, "fixture.mjs"));
  }
});
