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

## Production Shape

```bash
cp .env.example .env
docker compose up --build
```

Production WebRTC and GitHub OAuth callbacks should be served over HTTPS. Keep
the relay workspace invite-only before exposing it beyond a trusted LAN/VPN.
