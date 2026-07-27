# DualLane

DualLane is a self-hosted split-lane communication tool. The private direct lane
uses browser-to-browser transfer with a signaling-only server. The shared space
lane, internally named `Workspace`, is the server-retained path for persistent
messages, shared files, capacity limits, history retention, and operation
records.

The user-facing product has two lanes:

- **私密直连:** one-to-one, no login, temporary chat and file transfer. The
  server does not store conversation content.
- **共享空间:** a long-lived shared chat and file space for familiar groups. It
  requires login and invite-only access, and content is saved so members can
  access it later.

Product details:

- [Workspace Design Index](docs/WORKSPACE_DESIGN_INDEX.md)
- [O2O Private Direct Product Design](docs/O2O_PRODUCT_DESIGN.md)
- [Shared Space Workspace Product Design](docs/WORKSPACE_PRODUCT_DESIGN.md)
- [Workspace Core User Flow Design](docs/WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace IM Product Design](docs/WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](docs/WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace UI Interaction Design](docs/WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](docs/WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Visual System Design](docs/WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace State And Feedback Design](docs/WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Workspace Client Data And View Model Design](docs/WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
- [Workspace API Contract](docs/WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](docs/WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Authentication And Invite Design](docs/WORKSPACE_AUTH_INVITE_DESIGN.md)
- [Workspace Conversation And Group Design](docs/WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
- [Workspace Member And Permission Design](docs/WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
- [Workspace File And Quota Design](docs/WORKSPACE_FILE_QUOTA_DESIGN.md)
- [Workspace Space Settings Design](docs/WORKSPACE_SPACE_SETTINGS_DESIGN.md)
- [Workspace Search And Discovery Design](docs/WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
- [Workspace Notification And Unread Design](docs/WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
- [Workspace Mobile And Accessibility Design](docs/WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace Message Protocol](docs/WORKSPACE_MESSAGE_PROTOCOL.md)
- [Workspace Realtime Event Design](docs/WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace MVP Development Contract](docs/WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
- [Workspace Productization Roadmap](docs/WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace Product Acceptance Matrix](docs/WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)

## Local Development

```bash
pnpm install
pnpm dev
```

The frontend runs at `http://127.0.0.1:5173` and proxies API/WebSocket traffic to
`http://127.0.0.1:8787`.

Run the browser-level P2P and Workspace core flows with Playwright:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

The E2E suite starts isolated local services and uses a temporary SQLite test
double for Workspace, so it does not require PostgreSQL. Keep PostgreSQL
integration coverage separate through `TEST_DATABASE_URL` and `test:postgres`.

When testing Workspace locally, set `WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173`
so the GitHub login fallback returns to the frontend dev server. Use the same
host in the browser, preferably `127.0.0.1`, so the workspace session cookie is
sent back to the API proxy.

Shared space is disabled unless `WORKSPACE_ENABLED=true` is set exactly. A
misspelled value such as `ture` keeps it disabled. For local debugging, the
minimum shared-space settings are:

- `WORKSPACE_ENABLED=true`
- `WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173`
- `DATABASE_URL=postgresql://...`

Workspace persistence requires PostgreSQL. When running the API directly,
`DATABASE_AUTO_MIGRATE=true` applies pending versioned migrations at startup.
Use `pnpm --filter @duallane/web db:migrate` to run them explicitly. P2P-only
development does not require a database while Workspace remains disabled.
The migration runner initializes PostgreSQL schemas; it does not import legacy
`duallane.sqlite` data automatically.

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` can be left empty outside
production. In that mode, the GitHub login route uses the seeded owner fallback:
`timeStarry` / `timestarry@qq.com`. The seeded owner is part of the database
bootstrap for this MVP and is not configured through `.env`.

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

Compose starts PostgreSQL, waits for its health check, runs the one-shot
`migrate` service, and only then starts the API. Set a strong
`POSTGRES_PASSWORD` before deployment. Back up both the `duallane-postgres`
database volume and the `duallane-data` file volume; Workspace attachment bytes
remain on the local file volume. `POSTGRES_IMAGE` defaults to the DaoCloud
mirror and can be changed to another trusted PostgreSQL 17 image registry.

`SERVE_STATIC=false` is set for the API container in compose so static assets are
served only by the web gateway. Running `pnpm start` directly still supports the
single-process static server unless `SERVE_STATIC=false` is set.

For a public deployment, point your outer Nginx/TLS virtual host at
`127.0.0.1:${DUALLANE_WEB_PORT:-8787}` and set `PUBLIC_BASE_URL` to the final
HTTPS origin. In a same-origin deployment, `WORKSPACE_FRONTEND_URL` can be left
empty. The bundled Compose deployment enables `TRUST_PROXY=true`; the web
gateway preserves an outer proxy's HTTPS protocol so OAuth and session cookies
are marked `Secure`. Only enable `TRUST_PROXY` when the API is behind a
controlled reverse proxy. Production WebRTC should be served over HTTPS.

If shared space is enabled in production, configure `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `PUBLIC_BASE_URL`, and a long random `SESSION_SECRET`.
Production GitHub login fails closed when the OAuth client ID or secret is
missing.

The default deployment runs one API instance. PostgreSQL supports concurrent
requests, but scaling the API horizontally also requires shared attachment
storage and a cross-instance realtime event transport.

For PostgreSQL integration tests, point `TEST_DATABASE_URL` at a disposable
database and run `pnpm --filter @duallane/web test:postgres`. Each run creates
and removes an isolated schema.

For private-lane reliability, configure TURN fallback with either
`DUALLANE_TURN_SHARED_SECRET` for coturn REST credentials or static
`DUALLANE_TURN_USERNAME` / `DUALLANE_TURN_CREDENTIAL` values. Prefer `turns:`
URLs. `DUALLANE_STUN_URLS` and `DUALLANE_TURN_URLS` accept comma-separated
server URLs, `DUALLANE_TURN_TTL_SECONDS` controls REST credential lifetime, and
`DUALLANE_EMPTY_ROOM_GRACE_MS` controls how long an empty private room remains
available for reconnecting. WebSocket fallback carries only end-to-end
encrypted envelopes; messages, profiles, and signaling are not sent to the
server as plaintext.

Access logs should avoid query strings and payloads. The bundled Nginx gateway
uses a path-only log format and security headers; put HSTS on the outer TLS
proxy, for example Caddy or public Nginx.

The shared space lane is intentionally disabled by default. Shared space UI
entry points and `/api/workspace/*` return a "功能正在开发中" state until
`WORKSPACE_ENABLED=true` is set for controlled Workspace MVP testing.
