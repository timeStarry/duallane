# DualLane

DualLane is a self-hosted split-lane communication tool. The private lane uses
browser-to-browser transfer with a signaling-only server. The workspace lane is
the auditable relay path with persisted messages, quotas, and audit logs.

## Local Development

```bash
pnpm install
pnpm dev
```

The frontend runs at `http://127.0.0.1:5173` and proxies API/WebSocket traffic to
`http://127.0.0.1:8787`.

Invite links are generated from the browser origin, so the public URL should be
the frontend URL. In a reverse-proxy deployment, expose one origin and route
`/api` plus `/ws` to the backend service.

P2P invite links include a browser-only `#k=` fragment. Copy the complete link;
the server never receives this secret. The optional safety passphrase is used
only in the browser key derivation and is not sent to the backend.

## Production Shape

```bash
cp .env.example .env
docker compose up -d --build
```

The production compose file exposes only the `web` service on
`DUALLANE_WEB_BIND:DUALLANE_WEB_PORT` and keeps the API service inside the Docker
network. The web container serves the built frontend through Nginx and forwards
`/api` plus `/ws` to the private API container, including WebSocket upgrade
headers.

`SERVE_STATIC=false` is set for the API container in compose so static assets are
served only by the web gateway. Running `pnpm start` directly still supports the
single-process static server unless `SERVE_STATIC=false` is set.

For a public deployment, point your outer Nginx/TLS virtual host at
`127.0.0.1:${DUALLANE_WEB_PORT:-8787}` and set `PUBLIC_BASE_URL` to the final
HTTPS origin. Production WebRTC should be served over HTTPS.

For private-lane reliability, configure TURN fallback with either
`DUALLANE_TURN_SHARED_SECRET` for coturn REST credentials or static
`DUALLANE_TURN_USERNAME` / `DUALLANE_TURN_CREDENTIAL` values. Prefer `turns:`
URLs. WebSocket fallback carries only end-to-end encrypted envelopes; messages,
profiles, and signaling are not sent to the server as plaintext.

Access logs should avoid query strings and payloads. The bundled Nginx gateway
uses a path-only log format and security headers; put HSTS on the outer TLS
proxy, for example Caddy or public Nginx.

The workspace relay lane is intentionally disabled by default. Workspace UI
entry points and `/api/workspace/*` return a "功能正在开发中" state until
`WORKSPACE_ENABLED=true` is set for future development or controlled testing.
