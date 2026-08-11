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

Production uses the tracked override in `docker-compose.production.yml`. Set
`POSTGRES_VOLUME_NAME` to a pre-provisioned authoritative volume; never rely on
an untracked recovery override or a project-generated default volume. For a
first installation:

```bash
cp .env.example .env
docker volume create duallane-postgres-production
# Set POSTGRES_VOLUME_NAME=duallane-postgres-production and all other secrets in .env.
bash deploy/production/deploy.sh --bootstrap --expected-commit "$(git rev-parse HEAD)"
```

Routine upgrades use the same guarded entry point:

```bash
git pull --ff-only
bash deploy/production/deploy.sh --expected-commit "$(git rev-parse HEAD)"
```

Do not use a bare `docker compose up` for an existing production deployment.
The deployment script validates that the configured PostgreSQL volume matches
the current container, creates a private logical backup with a SHA-256 sidecar,
builds through an isolated `docker-container` BuildKit instance, runs
migrations, starts API/Web without refreshing unrelated services, and checks
the bound web gateway directly. Before replacing either service it starts an
unpublished candidate from the exact production image and waits for its health
check; the live API is then replaced and verified before the Web candidate and
live Web service are started. It preserves the previous API/Web images for
automatic application rollback. If the Docker daemon restarts during a failed
deployment, the script restores the existing containers before returning the
error. Database volume switches remain an explicit recovery operation outside
the routine script.

The production Compose pair exposes only the `web` service on
`DUALLANE_WEB_BIND:DUALLANE_WEB_PORT` and keeps the API service inside the Docker
network. The web container serves the built frontend through Nginx and forwards
`/api` plus `/ws` to the private API container, including WebSocket upgrade
headers.

The script provisions `DUALLANE_BUILDX_BUILDER` on first use with the configured
`DUALLANE_BUILDKIT_IMAGE`. Production services use `restart: always`, so a
daemon restart does not leave the database, proxy, API, or web gateway stopped.
Public HTTPS smoke checks should run from an external client; the application
host may not support hairpin access through the public gateway.

Compose starts PostgreSQL, waits for its health check, runs the one-shot
`migrate` service, and only then starts the API. Set a strong
`POSTGRES_PASSWORD` before deployment. Back up both the `duallane-postgres`
database volume and the `duallane-data` file volume. The local storage driver
keeps Workspace attachment, avatar, and personal emote bytes in `duallane-data`; the production
S3 driver uses a private S3-compatible bucket while the local volume remains
available for staged migration and rollback. `POSTGRES_IMAGE` defaults to the
DaoCloud mirror and can be changed to another trusted PostgreSQL 17 image
registry.

For S3-compatible storage, keep the bucket private and mount a JSON credential
file containing only `accessKey` and `secretKey`. Set its host path through
`WORKSPACE_S3_CREDENTIALS_FILE`; Compose exposes it to the API as a `0600`
secret. The API uploads bytes only after Workspace quota and permission checks,
and authenticated download or preview requests receive a short-lived signed
URL. Internal object keys never use the original file name.

Workspace attachment reservations advertise a 4 MiB application part size.
Larger files are uploaded as independently hashed, idempotent parts and are
assembled only after every part is present. Keep the gateway request cap above
one part but bounded; the bundled Nginx configuration uses 11 MiB so avatar and
personal-emote source uploads also fit without allowing an unbounded body.

Provision bucket versioning, restricted CORS, and seven-day incomplete
multipart cleanup before the first backfill:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-migration run --rm storage-provision
```

Some MinIO releases return `NotImplemented` for bucket-level CORS. In that
case the provisioner reports gateway CORS mode and still requires versioning,
private policy verification, and multipart cleanup to pass; use the bundled
`deploy/caddy/fs.tsio.top.caddy` rules to restrict public paths, methods, and
preflight origin.

MinIO releases that reject the S3 incomplete-multipart lifecycle rule use an
application cleanup fallback. Provisioning creates and immediately aborts a
canary multipart upload to verify the limited credential can list and abort
uploads. The API then removes incomplete uploads older than seven days at
startup and every six hours; an access failure still blocks startup.

For an existing local volume, choose a stable run ID and preserve it when
resuming. The backfill uploads active attachments and current avatars to their
feature prefixes, archives other existing Workspace bytes, then performs a
complete remote GET and SHA-256 verification for every object. A private report
is written under `/app/data/workspace-s3-migration-reports`:

```bash
WORKSPACE_STORAGE_MIGRATION_RUN_ID=production-YYYYMMDD \
  docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-migration run --rm storage-migrate
```

Only after that report completes should `WORKSPACE_STORAGE_DRIVER=s3` be
enabled. Keep `WORKSPACE_STORAGE_LOCAL_READ_FALLBACK=true` and
`WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE=true` for the migration window. Disable
read fallback after the verified cutover, retain mirror writes for seven days,
and keep the source volume and backup for at least thirty days. Switching the
driver back to `local` is the rollback path; the database storage keys do not
change.

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
missing. `GITHUB_OAUTH_TIMEOUT_MS` sets the total time budget shared by the
GitHub token, profile, and email requests and defaults to `8000` milliseconds.

Workspace email settings also require an independent 32-byte Base64 key in
`WORKSPACE_SMTP_ENCRYPTION_KEY`. Configure it before testing or enabling SMTP;
do not reuse `SESSION_SECRET`. For example, generate one with
`openssl rand -base64 32`. Changing the key later makes the stored SMTP
password unreadable, so disable mail and save a newly tested configuration
when rotating it. `WORKSPACE_EMAIL_WORKER_ENABLED=false` disables delivery
without discarding user notification preferences.

Workspace ntfy push defaults to `https://ntfy.tsio.top`. Override it with
`WORKSPACE_NTFY_BASE_URL` only when moving the self-hosted ntfy service;
production values must use HTTPS. `WORKSPACE_NTFY_WORKER_ENABLED=false`
stops delivery without changing each user's switch or generated topic. Topics
are generated once per human Workspace member and rotate only when that user
explicitly refreshes the topic from personal settings.

If the deployment host cannot reach GitHub OAuth directly, enable the optional
GitHub-only V2Ray profile. Put the subscription URL in an untracked host file
with mode `600`, then set `COMPOSE_PROFILES=github-proxy`,
`GITHUB_PROXY_URL=http://v2ray:10809`, and `V2RAY_SUBSCRIPTION_FILE` to that
file's absolute path. The generated V2Ray config lives in a private Docker
volume, the proxy port is exposed only to the Compose network, and routing
rejects non-GitHub destinations. Subscription refresh is intentionally separate
from application deployment. Provision or refresh, validate, and start it with:

```bash
docker compose --profile github-proxy-refresh run --rm v2ray-config
docker compose --profile github-proxy run --rm --no-deps v2ray test -c /etc/v2ray/config.json
docker compose --profile github-proxy up -d --no-deps v2ray
```

The renderer replaces the config atomically only after a successful download
and parse. A failed refresh leaves the last-known-good config untouched and
must not restart the running proxy. Never store the subscription URL in `.env`,
Git, or command output; only the secret file path belongs in `.env`.

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
proxy, for example Caddy or public Nginx. The outer proxy must also use
path-only access logs and suppress raw request-line error logs specifically for
`/api/auth/github/callback`, because its query contains one-time OAuth secrets.

The shared space lane is intentionally disabled by default. Shared space UI
entry points and `/api/workspace/*` return a "功能正在开发中" state until
`WORKSPACE_ENABLED=true` is set for controlled Workspace MVP testing.

## Release convention

- Keep the root package, `apps/web/package.json`, and the newest entry in `apps/web/src/releases.ts` on the same semantic version.
- Add the new release entry before changing package versions. Versions must be unique and ordered newest first.
- Each release records a date, title, summary, and categorized user-visible changes; the release-history test intentionally fails when these fields or version synchronization are missing.
- The public changelog contains only behavior ordinary members can see or use. Keep databases, protocols, deployment, privileged configuration, and other implementation details out of `/about`.
- Review `/about` and its expandable historical timeline before publishing.
