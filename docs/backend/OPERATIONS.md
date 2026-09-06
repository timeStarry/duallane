# Backend Runtime And Operations

## 1. Runtime Status

The commands and Compose services in this document are the approved target.
The checked-in Compose files remain the executable source of truth until a
migration PR adds each service and updates
[Evolution and migration](EVOLUTION.md).

Production deployment remains single-host Docker Compose through the guarded
script in `deploy/production`. This architecture does not authorize direct
production deployment from the development checkout.

## 2. Target Containers

| Compose service | Command/image role | Public exposure |
| --- | --- | --- |
| `web` | Nginx static frontend and edge gateway | The only published application port |
| `p2p` | Go `p2p` command | Docker network only |
| `workspace` | Go `workspace` command | Docker network only |
| `worker` | Go `worker` command | Docker network only; private health/metrics only |
| `migrate` | Go `migrate` one-shot command | None |
| `postgres` | Authoritative PostgreSQL | Docker network only |
| Storage maintenance profiles | Provision, backfill, dedupe, or verification commands | None |
| Optional GitHub proxy | Existing explicit profile | Docker network only |

During migration, the existing Node `api` service may coexist with target
services. Nginx routes only the capabilities identified in `EVOLUTION.md` to a
Go service. Removing `api` is a final cutover action, not an initial rename.

## 3. Images

Use one Go module and two runtime image families:

- **P2P image:** CGO disabled, contains only the P2P binary and runtime material
  needed for certificates/time zones, runs as a non-root user, and has no data
  volume or Workspace credentials.
- **Workspace image:** contains the Workspace, worker, migration, and explicitly
  retained storage-maintenance commands. It uses a pinned minimal Debian-family
  runtime because govips requires libvips/CGO after the media gate passes.

Workspace, worker, and migrate use the same immutable image digest for one
release. Compose selects the command. Images carry the product version and full
Git commit labels required by the deployment verifier.

Build stages pin the Go toolchain, OS packages, and base-image digest according
to repository policy. No compiler, package manager cache, source tree, test
fixture, or secret belongs in the final runtime layer.

## 4. Ports And Routing

The external Web binding and port remain controlled by the existing
`DUALLANE_WEB_BIND` and `DUALLANE_WEB_PORT` contract. Internal ports are private
Compose details and become canonical only when declared in Compose and `.env`
documentation.

The final edge routes are:

| Public path | Upstream |
| --- | --- |
| `/api/p2p/*`, `/ws/p2p/*` | P2P service |
| `/api/auth/*`, `/api/workspace/*`, `/api/bot-gateway/*` | Workspace service |
| `/ws/workspace`, `/ws/bot-gateway` | Workspace service |
| `/api/health` | Release health projection defined by the active gateway configuration |
| `/integrations/*`, frontend assets, application routes | Web container filesystem |

The OAuth callback keeps a dedicated safe error-log policy so codes and state do
not appear in gateway errors. WebSocket timeouts, upgrade headers, upload part
limits, avatar/emote limits, CSP, referrer policy, and MIME protections remain
at least as strict as the current Nginx configuration.

## 5. Configuration And Secrets

Existing environment names and defaults remain compatible unless a separately
documented transition changes them. Go configuration is typed and validated at
startup. Boolean behavior does not use permissive parsing when the current
contract requires an exact value; in particular, Workspace is disabled unless
`WORKSPACE_ENABLED=true` exactly.

Pass each service only what it owns:

| Service | Allowed configuration classes |
| --- | --- |
| P2P | Host/port, public base URL, room expiry/grace, ICE/TURN settings, safe logging/metrics |
| Workspace | Database, sessions/OAuth, Workspace gate, object storage, public/frontend URLs, request limits |
| Worker | Database, enabled delivery adapters, encrypted SMTP key, ntfy/Bot endpoints, job timings, optional storage cleanup |
| Migrate | Database and explicit seed/migration controls only |
| Web | Upstream names, public binding, request/security policy, static build metadata |

P2P never receives database, S3, SMTP, OAuth-client-secret, Bot-token, or
Workspace encryption credentials. Secrets remain in environment variables only
where already required or in Compose-mounted `0600` files; they are never build
arguments, image layers, command-line flags, health output, or logs.

The Go Workspace command loads the existing imported emote catalog through
`DUALLANE_EMOTE_CATALOG_PATH`. The image sets `/app/assets/emote-packs.json`;
local runs from `apps/backend` default to `../web/shared/emote-packs.json`.
Enabled Workspace fails startup if the catalog cannot be read or decoded. A
disabled Workspace does not open the catalog, initialize the native media
processor, or connect to its database/object store. Media normalization uses
one shared bounded processor; domain services retain authorization, logical
quota, audit and storage-reference ownership.

The same enabled startup loads the canonical Echo release guide catalog via
`DUALLANE_ECHO_RELEASE_CATALOG_PATH` (image:
`/app/assets/echo-release-guides.json`; local backend working directory:
`../web/shared/echo-release-guides.json`). Missing or invalid guides fail before
database initialization; disabled Workspace does not read this asset either.
The catalog is a public build asset, not a runtime secret or a second copy to
edit independently.

The Go realtime handler records a random per-connection PostgreSQL presence
lease after authenticated replay. The Go email worker uses that shared lookup
to defer immediate mail while any active human connection remains online;
lookup failure also defers, never sends. Leases default to 90 seconds and require
synchronized host clocks. No P2P connection, token, address, or message is stored.

`WORKSPACE_MAINTENANCE_WORKER_ENABLED=true` explicitly enables Go worker expiry
cleanup; all other values leave it off. Workspace itself must also be enabled.
The presence sweep runs once per minute after worker startup delay, removes at
most 100 expired leases per cycle, and has a five-second database deadline.
Logical expiry applies to lookups even if the sweeper is stopped. Enable this
only on a synthetic candidate or after the capability's Go ownership is
authorized; this switch does not authorize cutover or start another writer.

`WORKSPACE_ECHO_WORKER_ENABLED=true` is a separate exact opt-in, default off.
It composes requirement, solicitation and release delivery plus active-human
member reconciliation. The four loops run independently every 30 seconds after
the worker startup delay, with 25-item keyset pages and independent cursors.
Errors or cancellation retain the previous cursor for a later retry. Member
reconciliation has a 15-second cycle budget and does not publish old releases.
Messages/cards and configured email/ntfy jobs use the same durable transactional
writer as HTTP requests. Enabling this switch does not enable external
notification sending; those providers retain their own switches and ownership.
Do not enable Node and Go Echo claimers together.

## 6. Startup And Readiness

Both candidate Go images include `/usr/local/bin/duallane-healthcheck`. It
accepts one literal-loopback HTTP URL, only `/api/health` or `/readyz`, and
performs a bounded read-only GET with no proxy/redirect or response logging.
It requires HTTP 200 and `ok: true`; `/readyz` additionally requires state
`ready`, so a healthy-but-disabled Workspace cannot pass candidate readiness.
Image-specific Docker ignore files restrict build inputs and exclude local
environment files, dependencies and runtime data. Use BuildKit; the legacy
builder does not reliably apply these per-Dockerfile context rules.

`GOPROXY` is an optional build-stage argument, defaulting to the Go public
proxy/direct chain. Candidate builds may select a reachable public module
proxy while retaining `go.sum` verification. Never pass credential-bearing
proxy URLs as build arguments. This does not configure the runtime network.

Target dependency order:

1. PostgreSQL becomes healthy.
2. The one-shot migration service applies compatible migrations and exits zero.
3. Workspace and worker start from the same release image and verify the
   required schema.
4. P2P starts independently of PostgreSQL and Workspace.
5. Candidate health checks pass before Nginx begins routing a newly migrated
   capability.

Every long-running Go command exposes private liveness and readiness checks.
The implementation may choose the final internal path/port, but must distinguish:

- **Liveness:** process event loop and HTTP health server respond without
  depending on external providers.
- **Readiness:** required configuration is valid and owned dependencies are
  usable. Workspace includes PostgreSQL and the selected object-store readiness
  when enabled. Worker includes schema/lease capability, not the availability of
  every optional provider. P2P has no Workspace dependency.

Health responses contain only status, service, version, commit, and safe
dependency categories. They never include connection strings, hosts requiring
secrecy, bucket keys, tokens, provider responses, or stack traces.

The Go candidate reads `DUALLANE_MIGRATIONS_DIR` (image: `/app/migrations`;
local `apps/backend` default: `../web/server/migrations`). Enabled Workspace
and enabled worker processors verify the exact canonical filename set and
`schema_migrations` structure before constructing domain dependencies. Missing,
unknown or incompatible history fails startup; the check never applies SQL or
seeds data. Metadata queries run in read-only PostgreSQL transactions. Startup
has a ten-second schema-check budget; private readiness rechecks the expected
set with the existing two-second request budget. An intentionally disabled
Workspace or idle worker does not connect to the database for this check.
Worker cycles also check compatibility before claiming jobs; an incompatible
schema suspends claims until a compatible state is restored.

File canonical promotion (after bounded staging) and physical cleanup hold the
shared digest advisory lock through storage I/O and registry changes. The
server-side mutation has a two-minute ceiling, shortened by the caller's
deadline. Failed physical deletion rolls back its tombstone, allowing a later
maintenance retry; never treat a logical resource removal as proof that bytes
were deleted.

### Candidate Side-Effect Isolation

An unpublished port does not make a candidate passive. Startup hooks, job
claimers, retention, object cleanup, seed reconciliation, and migration runners
can change production data without receiving an HTTP request.

Before a candidate uses production dependencies, the release implementation
must prove that it cannot run those effects. Record each enabled background
loop, its current owner, and the tested mechanism that prevents the candidate
from claiming or mutating that owner's work. Do not invent an undocumented
environment switch or assume disabling external delivery also disables claims.
Use a disposable environment for mutation smoke tests. If a service has no
verified passive candidate mode, adding and testing that mode is a cutover gate.

Readiness may inspect configuration/schema/dependencies, but must not deliver
notifications, claim jobs, execute migrations, or create user-domain records as
a health probe. A read-only startup check is not proof of write-path parity;
that evidence comes from the disposable-environment tests.

## 7. Graceful Shutdown

On `SIGTERM` or deployment replacement, a Go service:

1. Marks readiness false and stops accepting new work.
2. Cancels root context and bounded background loops.
3. Drains HTTP requests for the configured grace period.
4. Closes WebSockets with a reconnect-safe status when possible.
5. Stops taking worker jobs; active leases either complete safely or expire for
   reclaim.
6. Closes listener, database pool, object clients, and metrics server.

The initial single-replica P2P service cannot transfer in-memory rooms during an
upgrade. Its replacement interrupts active direct sessions, as the current
single-process topology does. Zero-disruption P2P deployment requires the
separate scale-out/room-ownership design; it must not be implied by candidate
health checks.

## 8. Observability

Each service emits JSON logs to stdout/stderr using the safe-field policy in
[Contracts and data](CONTRACTS_AND_DATA.md). Docker log rotation remains
mandatory.

Private metrics cover at least:

- HTTP request count/duration by method, route template, status class, and
  service;
- active/rejected P2P rooms and sockets without room/user identifiers;
- Workspace WebSocket connections, replay count/lag, and sync-required count;
- PostgreSQL pool use/wait time and query error class without SQL values;
- worker eligible/claimed/completed/failed counts, backlog age, and lease expiry;
- object operations, bytes, failures, and cleanup backlog by safe operation
  class;
- process/runtime health.

Metrics endpoints are never proxied publicly by Nginx. Alerts and dashboards are
optional deployment integrations; their absence does not remove the need to
expose the bounded metrics.

## 9. Release Order

Before any Go production cutover, `deploy/production/deploy.sh` must be extended
and tested to understand every live application service. The target release
sequence is:

1. Verify clean `main`, exact `origin/main` commit, semantic version, production
   path, authoritative PostgreSQL volume, and required tools.
2. Capture a private logical database backup and checksum.
3. Capture rollback image IDs for Web and every active backend/worker service.
4. Build all affected images from the exact commit.
5. Run migrations once.
6. Start unpublished candidates for affected request-serving services and wait
   for readiness.
7. Replace/start backend services before changing edge routes.
8. Start the worker only after its compatible schema and owning API are ready.
9. Replace the Web/Nginx gateway last, then verify direct gateway and public
   smoke paths.
10. Retain previous images until the rollback window closes.

For every changing writer or background claimant, insert an explicit ownership
handoff before activation: stop admission/claims on the old owner, drain its
in-flight transactions and leases (or wait for a verified expiry/fencing
mechanism), confirm it can no longer complete conflicting work, then enable the
new owner. A temporary bounded pause is preferable to unproven overlap. Existing
WebSockets and internal jobs can still mutate data after an edge route changes;
include them in the drain plan. Record recovery for each interrupted handoff
step. Unpublished candidates remain passive throughout this sequence.

Do not use a bare `docker compose up` to replace an existing production
deployment. Do not run production deployment from the development checkout.

## 10. Rolling Compatibility And Rollback

Schema and contracts use expand-contract evolution. The new migration must be
safe for every Node/Go version that can run during rollout or automatic
application rollback. Destructive cleanup occurs only after the old owner is
removed, the migration is `complete`, backups are verified, and rollback no
longer needs the old shape.

Rollback first fences the failed writer/claimer and verifies that the selected
known-good owner can read the current schema, stored data, objects, cursors, and
pending jobs. Start that owner only after conflicting work is drained or safely
fenced; expose its route only after readiness passes. Restoring an edge route
alone does not stop background or existing-socket writes. If the old owner is
already safely running, routing back may be sufficient, but the release record
must prove those conditions. Database restoration is a separate operator
decision and is never an automatic response to an application failure.

If Docker restarts during a failed deployment, record and restore all previously
running DualLane application containers, not only Web and one API container.

## 11. Scaling And Capacity

- Keep one P2P replica until room ownership and non-persistent cross-instance
  relay are designed and tested.
- Keep one Workspace replica until persisted wake-up, replay, presence, and
  aggregate connection-pool budgets pass multi-instance tests.
- Worker replicas may scale first after lease and ambiguous-provider-failure
  tests pass.
- Set an aggregate PostgreSQL pool budget across Workspace, worker, migration,
  maintenance, and temporary candidates. Per-process defaults must not multiply
  beyond the server limit during deployment.
- Add resource limits from measured memory/CPU/file-descriptor behavior,
  especially WebSockets and libvips concurrency.

No scale change weakens authorization, quota serialization, event ordering,
audit completeness, object locking, or the P2P no-persistence promise.
