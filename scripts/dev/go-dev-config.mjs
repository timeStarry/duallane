const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_DEV_PORTS = Object.freeze({
  p2p: 8897,
  workspace: 8898,
  web: 5173
});

function nonEmptyValue(environment, key) {
  const value = environment?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function createGoDevOrigins({
  host = LOOPBACK_HOST,
  p2pPort = DEFAULT_DEV_PORTS.p2p,
  workspacePort = DEFAULT_DEV_PORTS.workspace
} = {}) {
  return Object.freeze({
    p2p: `http://${host}:${p2pPort}`,
    workspace: `http://${host}:${workspacePort}`
  });
}

export const DEFAULT_GO_DEV_ORIGINS = createGoDevOrigins();

export function toWebSocketOrigin(origin) {
  return origin.replace(/^http/i, "ws");
}

function websocketProxy(origin) {
  return { target: toWebSocketOrigin(origin), ws: true };
}

// These contexts intentionally mirror deploy/candidate/nginx.conf. Vite's
// string contexts beginning with ^ are regular expressions, so an endpoint
// such as /api/p2p-extra cannot accidentally enter the P2P lane.
export function createDevProxy(environment = process.env) {
  const legacyOrigin = nonEmptyValue(environment, "DUALLANE_API_ORIGIN");
  if (legacyOrigin) {
    // The explicit single-origin path is retained for Go/external test
    // harnesses, which start one backend and set this override deliberately.
    return {
      "/api": legacyOrigin,
      "/auth": legacyOrigin,
      "/ws": websocketProxy(legacyOrigin)
    };
  }

  const p2pOrigin = nonEmptyValue(environment, "DUALLANE_P2P_API_ORIGIN") || DEFAULT_GO_DEV_ORIGINS.p2p;
  const workspaceOrigin = nonEmptyValue(environment, "DUALLANE_WORKSPACE_API_ORIGIN") || DEFAULT_GO_DEV_ORIGINS.workspace;
  return {
    "^/api/p2p(?:/|\\?|$)": p2pOrigin,
    "^/api/auth(?:/|\\?|$)": workspaceOrigin,
    "^/api/workspace(?:/|\\?|$)": workspaceOrigin,
    "^/api/bot-gateway(?:/|\\?|$)": workspaceOrigin,
    "^/api/health(?:\\?.*)?$": workspaceOrigin,
    "^/ws/p2p(?:/|\\?|$)": websocketProxy(p2pOrigin),
    "^/ws/workspace(?:\\?.*)?$": websocketProxy(workspaceOrigin),
    "^/ws/bot-gateway(?:\\?.*)?$": websocketProxy(workspaceOrigin)
  };
}
