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

## Start Developing

Prerequisites are Node.js 22, Corepack/pnpm 10, the pinned Go 1.26/toolchain
1.26.8 backend toolchain, Git, and (for host-run Workspace/media work) a CGO
compiler, `pkg-config`, and libvips headers/runtime. See the [backend validation
prerequisites](docs/backend/VALIDATION.md#3-candidate-go-gates-and-evidence)
before running host Go gates. Create a short-lived branch from current
`origin/main`, then install the JavaScript workspace and start the Go-only local
runner:

```bash
git fetch origin
git switch -c feat/topic-notifications origin/main
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Replace the example topic with the scope of the change. Codex-created branches
use `codex/<short-topic>`. `pnpm dev` starts Go P2P on `127.0.0.1:8897`, Go
Workspace on `127.0.0.1:8898`, and Vite on `127.0.0.1:5173`. It does not start
the retired Node API/worker, Docker, a database, or an automatic migration or
seed. `DUALLANE_API_ORIGIN` is an explicit single-origin Go/external test
harness override; normal development uses the split Go origins.

Before opening a pull request, run the gate required for the affected code. The
common full checks are:

```bash
pnpm lint
pnpm test
pnpm build
```

[`AGENTS.md`](AGENTS.md) is the mandatory contributor and coding-agent entry
point. It links progressively to the detailed
[development guide](docs/development/README.md), covering workflow and PR rules,
architecture, code, UI/UX, security/data, testing, release, and deployment. Only
GitHub user **`timestarry`** may perform the final merge into `main`.

The [backend architecture index](docs/backend/README.md) is the Go backend
handbook and live migration ledger. The checked-in 0.18 architecture is Go-only
for online P2P, Workspace, Web, and worker paths. The verified 0.17.0 baseline
is recorded in the [bridge/release record](docs/backend/work-items/2026-09-10-chat-0170-after-bridge.md);
the [Node-runtime retirement work item](docs/backend/work-items/2026-09-10-node-runtime-retirement.md)
is the canonical record for validation and activation status. Retired Node
online code is not a development or production owner.

Product behavior is defined separately in [`DESIGN.md`](DESIGN.md), the
[Workspace design index](docs/WORKSPACE_DESIGN_INDEX.md), and the
[P2P product design](docs/O2O_PRODUCT_DESIGN.md). Read the smallest relevant
contract before changing behavior.

## Product Documentation

- [System and trust-lane design](DESIGN.md)
- [Workspace Design Index](docs/WORKSPACE_DESIGN_INDEX.md)
- [O2O Private Direct Product Design](docs/O2O_PRODUCT_DESIGN.md)
- [Workspace Content-Addressed Storage Runbook](docs/WORKSPACE_CONTENT_ADDRESSED_STORAGE.md)

## Local Runtime Details

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The frontend runs at `http://127.0.0.1:5173`. The default Vite proxy routes
P2P traffic to `http://127.0.0.1:8897` and Workspace/auth traffic to
`http://127.0.0.1:8898`; set `DUALLANE_API_ORIGIN` only when a focused browser
harness intentionally uses one backend origin.

Run the default Go P2P browser gate with Playwright:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

The default `pnpm test:e2e` suite is P2P-only. The complete Go Workspace browser
gate is separate and requires an explicit loopback disposable PostgreSQL URL and
schema-creation opt-in:

```bash
DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION=true \
TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:<port>/<disposable-db> \
pnpm test:e2e:workspace-go
```

Use a non-default database name; the harness creates and drops a temporary
schema and rejects non-loopback or provider-override URLs. Do not substitute the
retired Node API or an implicit SQLite compatibility service. Keep PostgreSQL
integration coverage separate through `TEST_DATABASE_URL` and the repository's
PostgreSQL gate.

Agent Bot runtimes use the versioned JavaScript client in
`packages/agent-sdk`. A running deployment publishes reviewed, secret-free
integration instructions at `/integrations/duallane-channel.md`, with the
immutable protocol-v1 content and SHA-256 manifest under `/integrations/v1/`.
OpenClaw and Hermes entry documents are available below their matching
`/integrations/openclaw/` and `/integrations/hermes/` paths. Bot tokens belong
only in the runtime's `Authorization` header; they must not be added to these
URLs, source files, or logs.

Creating a direct conversation with an owned custom Bot enables trigger
delivery only. The owner can explicitly grant bounded context for that
conversation through `PATCH /api/workspace/bots/{botId}/context-grants/{conversationId}`;
the external Bot token cannot change this policy.

When testing Workspace locally, set `WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173`
so the GitHub login fallback returns to the frontend dev server. Use the same
host in the browser, preferably `127.0.0.1`, so the workspace session cookie is
sent back through the Go Workspace proxy.

Shared space is disabled unless `WORKSPACE_ENABLED=true` is set exactly. A
misspelled value such as `ture` keeps it disabled. For local debugging, the
minimum shared-space settings are:

- `WORKSPACE_ENABLED=true`
- `WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173`
- `DATABASE_URL=postgresql://...`

Workspace persistence requires PostgreSQL. The Go runner never migrates or
seeds a database at startup. Run the explicit Go migrator against a disposable
development database when needed:

```bash
(cd apps/backend && go run ./cmd/migrate)
```

P2P-only development does not require a database while Workspace remains
disabled. The canonical SQL remains under `apps/web/server/migrations`; the
migrator does not import legacy `duallane.sqlite` data automatically. The
isolated `tools/node-compat` package is an offline storage operator, not a
startup migration path.

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

The verified 0.17.0 Go baseline comprises Web, Go P2P, Go Workspace, Go worker,
the one-shot Go migrator, and PostgreSQL. The root `docker-compose.yml` extends
`docker-compose.go-production.yml` and is Go-only by default; it has no `api`
service. The Go Compose contract requires `DUALLANE_APP_VERSION` and
`DUALLANE_GIT_COMMIT`. `.env.example` supplies local-build values
(`0.18.0`/`development`); production deployment overwrites them from verified
release metadata. See [runtime and upgrade operations](docs/backend/OPERATIONS.md)
before changing this live deployment.

The checked-in 0.18 tree preserves this Go-only online topology and has no Node
online API/worker/gateway or Node production bootstrap path. The [Node-runtime
retirement work item](docs/backend/work-items/2026-09-10-node-runtime-retirement.md)
records validation and activation status. An installation based on 0.17.0 must
perform its first migration and permission preparation from the retained 0.17
checkout and its approved runbook; do not invent or copy a bootstrap command
from this tree.

On this host, development happens in `/home/timestarry/projects/duallane` and
the only production checkout is `/home/timestarry/duallane`. Deployment uses
the local Docker daemon; do not SSH to another host or run the production script
from the development checkout. Other installations may set a different
absolute `DUALLANE_PRODUCTION_DIR`; when it is empty, the script defaults to
`${HOME}/duallane` and verifies the physical path before touching Docker.

Routine upgrades of this live installation use the guarded Go-to-Go entry point
with `--release-profile go-full --go-upgrade --previous-release-snapshot` and
the latest verified private snapshot from the preceding successful release,
following the
[Go upgrade procedure](docs/backend/OPERATIONS.md#guarded-go-activation-and-upgrade-inputs).
For the historical 0.18 transition example, the 0.17.0 private base was
`backups/production/duallane-20260910T080211Z-8d346a04317d.recovery.go-compose.snapshot.json`
with its three adjacent private sidecars. Future upgrades must use the latest
verified snapshot captured by the preceding successful release, not this
historical example. Pull exact `origin/main` as the checkout owner before the
privileged release; verify a clean checkout and pass the full
`--expected-commit`. The current entry point rejects Node-default, bootstrap,
and `--prepare-go-permissions` forms.

Before pushing a release, increment the root and Web package versions together,
add the matching user-facing release entry, and run `pnpm test`, `pnpm lint`,
and `pnpm build`. Merge the validated release through its authorized PR into
`origin/main`, then update the
production checkout with `git pull --ff-only`. The deployment entry point
requires a clean `main` worktree whose HEAD exactly matches the fetched
`origin/main`; it also requires a full `--expected-commit` and rejects a new
commit unless its semantic version is greater than the running version. Passing
the same commit again is an idempotent redeployment.

Do not use a bare `docker compose up` for an existing production deployment.
The deployment script validates that the configured PostgreSQL volume matches
the current container, creates a private logical backup with a SHA-256 sidecar,
builds through an isolated `docker-container` BuildKit instance, runs
migrations and passive candidates from exact image IDs, and checks the bound
web gateway. For Go upgrades it verifies the previous snapshot, fences/drains
old owners, activates new backends/worker and replaces Web last. Recovery keeps
the same database/storage authority and uses captured immutable images; an
ambiguous fence/drain fails closed for operator review. Database volume switches
remain an explicit recovery operation outside the routine script.

Only `web` publishes `DUALLANE_WEB_BIND:DUALLANE_WEB_PORT`. Its Go gateway
forwards P2P API/WebSockets to `p2p` and Workspace/auth/Bot API/WebSockets to
`workspace`; private health/metrics endpoints are not public. Neither backend
nor worker publishes a host port. There is no current Node gateway route.

The script provisions `DUALLANE_BUILDX_BUILDER` on first use with the configured
`DUALLANE_BUILDKIT_IMAGE`. It starts that builder only for the image build,
constrains retained cache to `DUALLANE_BUILDX_CACHE_MAX` after a successful
release, and stops the builder on every exit path so it does not retain memory
between releases. Active production services use `restart: always`; no Node
service may be started alongside Go. The database, proxy, Go services and Web
resume through guarded restoration. Their Docker JSON logs rotate at
`DUALLANE_LOG_MAX_SIZE` and retain at most `DUALLANE_LOG_MAX_FILE` files per
service.
Public HTTPS smoke checks should run from an external client; the application
host may not support hairpin access through the public gateway.

### Offline compatibility and storage reference

The isolated `tools/node-compat` package retains only the explicitly invoked
offline storage operators (`storage:provision`, `storage:migrate`, and
`storage:dedupe`). It is not an online API, worker, startup hook, or complete Go
replacement. Before using any operator, follow the [Go storage operator safety
boundary](docs/backend/STORAGE_OPERATOR.md): obtain authorization, identify the
exact authority, fence every writer/claimer/finalizer, preserve and verify
backups, and validate the target. Do not run Node beside Go, run backfill or
finalize to silence a read-only verifier, or change storage drivers as an
unguarded rollback.

The Go Compose path starts PostgreSQL, the one-shot Go `migrate` service, and
then Go Workspace/worker. Set a strong `POSTGRES_PASSWORD` before deployment.
Back up both the `duallane-postgres` database volume and the `duallane-data`
file volume. The local storage driver keeps Workspace attachment, avatar, and
personal emote bytes in `duallane-data`; the production S3 driver uses a
private S3-compatible bucket while the local volume remains available for
staged migration and rollback. `POSTGRES_IMAGE` defaults to the DaoCloud mirror
and can be changed to another trusted PostgreSQL 17 image registry.

For S3-compatible storage, keep the bucket private and mount a JSON credential
file containing only `accessKey` and `secretKey`. Set its host path through
`WORKSPACE_S3_CREDENTIALS_FILE`. Compose bind-backed secrets retain host
ownership/modes: the Go deployment requires the verified UID/GID 65532, mode-0600
file, mounted read-only. The Go HTTP boundary authorizes quota before upload
and streams authorized objects without exposing the provider locator. Internal
object keys never use the original file name.

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

MinIO releases that reject the S3 incomplete-multipart lifecycle rule remain an
operator-managed cleanup concern. Provisioning creates and immediately aborts a
canary multipart upload to verify the limited credential can list and abort
uploads; it does not install an online cleanup loop or change Go startup.

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

Migration 025 adds a shared SHA-256 object namespace for Workspace attachments,
profile avatars, and personal emotes. Both local and S3 storage drivers support
the retained offline maintenance flow. With the separate operator approval and
fencing described above, use one stable run ID for `backfill` and `verify`.
`finalize` is a separate destructive operation, not their routine next step:

```bash
WORKSPACE_STORAGE_DEDUPE_RUN_ID=dedupe-YYYYMMDD \
WORKSPACE_STORAGE_DEDUPE_MODE=backfill \
  docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-dedupe run --rm storage-dedupe
```

Repeat the command with `WORKSPACE_STORAGE_DEDUPE_MODE=verify` and validate its
private `0600` report and deployment health; stop there while the compatibility
window is open. Backfill creates canonical objects and binds references while
retaining legacy bytes. Verify reads and hashes complete canonical objects.

The current Go rollout still has an open Node/legacy compatibility window and
outstanding full S3/legacy verification. Do **not** run `finalize` for this
rollout. Only a separately authorized later operation may explicitly close
that window, verify an independent recoverable database/object backup and its
restore path, complete the required full inventory verification, and fence
every writer/claimer before deleting legacy objects. Deletion removes the
rollback path that depended on those bytes. Keep database and storage backups;
resume only the same authorized phase with its stable run ID. The
[content-addressed storage runbook](docs/WORKSPACE_CONTENT_ADDRESSED_STORAGE.md)
contains the full cutover and rollback procedure.

The Go Web image serves the Vite build and the Go gateway proxies only the
declared P2P and Workspace paths. There is no Node single-process static/API
fallback in the 0.18 tree.

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

The default deployment runs separate Go P2P, Workspace, worker, and Web
services. PostgreSQL supports concurrent requests; scaling Workspace or worker
replicas still requires the documented shared storage, realtime, and job-lease
contracts.

For PostgreSQL integration tests, set `TEST_DATABASE_URL` to a non-default,
loopback disposable database and run the Go gate:

```bash
TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:<port>/<disposable-db> \
  make -C apps/backend integration-postgres
```

The gate creates and removes isolated schemas; never point it at production or
reuse a shared database.

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
entry points and `/api/workspace/*` remain unavailable until
`WORKSPACE_ENABLED=true` is set for controlled Workspace testing.

## Release convention

- Keep the root package, `apps/web/package.json`, and the newest entry in `apps/web/src/releases.ts` on the same semantic version.
- Treat every set of changes not yet deployed to production as one pending release. Add new user-visible work to that single newest version instead of creating another version before the current pending release is deployed.
- Start the next semantic version only after the previous version has been deployed and the production health endpoint reports that version ready.
- Add the new release entry before changing package versions. Versions must be unique and ordered newest first.
- Each release records a date, title, summary, and categorized user-visible changes; the release-history test intentionally fails when these fields or version synchronization are missing.
- The public changelog contains only behavior ordinary members can see or use. Keep databases, protocols, deployment, privileged configuration, and other implementation details out of `/about`.
- Review `/about` and its expandable historical timeline before publishing.
