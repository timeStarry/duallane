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

Build stages pin Go and Debian base digests and direct libvips, certificate and
timezone package versions. Transitive APT resolution is still repository-dependent:
record and reuse the exact built image digest; do not assume a later rebuild is
byte-identical. The Workspace image also carries `duallane-storage` and the
bounded read-only `duallane-permission-probe`. Its baked-in ownership does not
repair existing volumes; follow the [storage permission gate](STORAGE_OPERATOR.md).
No compiler, package manager cache, source tree, test fixture, or secret belongs
in the final runtime layer.

### Immutable public image resources

The final image has an explicit permission contract for public or non-secret
immutable resources only. It does not relax permissions for `/app/data`, named
volumes, host bind mounts, `/run/secrets`, credentials, recovery artifacts, or
Workspace user objects; those keep their existing owner and mode contracts.

| Image | Baked-in resources | File mode | Directory mode | Required non-root reader |
| --- | --- | --- | --- | --- |
| Workspace | `/app/migrations/*.sql`, `/app/assets/emote-packs.json`, and `/app/assets/echo-release-guides.json` | `0644` | `/app/migrations` and `/app/assets`: `0755` | Go `migrate`, Workspace/catalog startup, and the release-drain path as applicable, under `65532:65532` |
| Web | `/usr/share/nginx/html/**` regular files and candidate `/etc/nginx/nginx.conf` | `0644` | Every directory below `/usr/share/nginx/html`: `0755` | Nginx under its configured non-root user (`101:101` in the candidate Compose) |

Image builds must not depend on checkout mode bits or checkout `umask`. Use
explicit `COPY --chmod=0644` for individual immutable files/file globs, then
restore `0755` on any destination directories that `COPY` created before the
service user is selected. After the build-stage Web copy, normalize every
published regular file and directory under `/usr/share/nginx/html`; Vite can
preserve restrictive source modes in the copied output. Prove the resulting
permissions from the exact image as the actual non-root reader, not from host
source metadata. The required evidence is defined in the [immutable image
resource gate](VALIDATION.md#immutable-image-resource-gate).

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

One explicit P2P transition is `DUALLANE_TURN_TTL_SECONDS`: unset/blank uses
600 seconds, while a configured value must be an integer in `1..86400`.
Node previously fell back for zero, negative or malformed values; Go rejects
them during configuration validation. Correct or remove an invalid legacy
value before candidate startup. Do not log TURN credentials while diagnosing
the configuration. The other P2P transport acceptance exceptions are listed
in [WebSocket contracts](CONTRACTS_AND_DATA.md#p2p).

`DUALLANE_DATA_DIR` is the application data directory, with the same meaning as
Node. Workspace and worker local/hybrid adapters resolve their physical object
root to `<DUALLANE_DATA_DIR>/workspace-files`. For the container default this is
`/app/data/workspace-files`; canonical objects, legacy attachments, profile
avatars and custom emotes all retain their existing relative keys below it.
Do not flatten or move an existing volume to accommodate a different Go path.
The storage operator's explicit `--object-root` takes this physical subdirectory,
not the parent data directory. Permission transitions are a separate gate in
[Storage operator](STORAGE_OPERATOR.md).

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

`WORKSPACE_ECHO_WORKER_ENABLED=true` is a separate exact opt-in, default off
when running the standalone command. The explicit `go-full` Compose profile
supplies `true` by default for both Echo and maintenance, as described below.
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

The explicit `go-full` active profile defaults email, ntfy, Echo and maintenance
processors on in the separate worker; their explicit `false` overrides remain
available to operators. The Workspace HTTP process keeps these loops off.
These defaults do not enable Go in the Node-default deployment. Candidate
launches must still use the guarded release helper's passive environment; the
read-only mount overlay alone does not disable processors.

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

The Workspace command now supports exact `WORKSPACE_CANDIDATE_HEALTH_ONLY=true`:
it constructs the configured dependencies, native media and schema checker,
but registers only health/readiness handlers and starts no listener or business
WebSocket. All other paths return a content-free 503. The worker's exact
`WORKER_VALIDATE_ONLY=true` validates its configured processors and schema but
blocks both the run loop and individual ticks. Both require enabled Workspace.
An idle validate-only worker still verifies PostgreSQL, unlike an active worker
with all processors intentionally disabled.

Passive local storage construction requires an existing accessible directory
and never creates it or changes its mode. S3 readiness remains a read-only bucket
check. This is not a filesystem ownership migration: legacy root-owned private
objects and mounted credential files must be checked for the Go UID 65532 before
cutover. The release must fail closed on inaccessible dependencies, never run
the active Go service as root or silently chmod/chown a live data volume.

Private readiness includes `mode: candidate-health-only`, `validate-only` or
`active`. The image helper accepts a second argument
`--expect-mode=<one of those values>` only with `/readyz`, and requires an exact
response match plus `ok: true` and `state: ready`. The public health contract is
unchanged. A release script must check the actual response, not only environment
variables. Metrics and readiness remain inaccessible through the public gateway.

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

P2P peer shutdown uses one two-second graceful batch budget, not a separate
timeout per room. If peers do not acknowledge close, the transport closes the
underlying sockets to interrupt pending handshakes. Graceful and force phases
each use at most 32 close callbacks (at most 64 during overlap). All concurrent
manager shutdown callers wait for this batch to finish. This bounds peer
handshake waiting; it does not promise uninterrupted P2P sessions or replace
the process supervisor's shutdown timeout.

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

Storage observation is configured only on the outermost local, S3 or hybrid
store. A hybrid operation must not count both its logical call and delegated
primary/mirror calls in the same registry. The concrete adapters retain their
legacy-reader, upload-cleanup and multipart capabilities. Labels contain only
fixed service, operation and outcome categories, never keys or provider errors.
An `open` success means a handle was acquired, not that its content was consumed
or verified. `verify` describes stream completion under that adapter's available
size/hash checks: EOF succeeds; read errors, cancellation and early close fail.
It is not a catalog-wide verification or a proof of a higher-level domain hash
check. Put/read byte counts describe bytes consumed, not logical quota or unique
stored bytes; delete counts use the supplied object size, not a billing meter.
Concurrent close must still interrupt blocked provider reads, and every returned
read count remains bounded by the object's expected size even during close.

## 9. Release Order

The `internal/platform/releasecheck` package provides a bounded repeatable-read,
read-only PostgreSQL observation. Every reserved upload blocks handoff, including
stale reservations and attachment anomalies. Email/ntfy `sending` rows block
regardless of missing or expired leases; lease anomalies, active unnotified
digest leases and incompatible schema also fail closed. Pending jobs and Echo
reconciliation are counted without claiming them. It never cleans up a row.

This observation is not a writer fence. Before using it, stop admission and
claims, disable the old containers' restart policies and verify they are stopped.
SQL cannot prove S3 multipart or external delivery state. Resolve ambiguous
provider results through the existing owner's explicit recovery process;
expiring a lease or clearing SQL is not proof that a provider did not deliver.

The Workspace image includes `/usr/local/bin/duallane-release-check`. By default
it reads only `DATABASE_URL`/`PG*` using one connection and an overall ten-second
command deadline, without contacting providers. Its content-free JSON uses
schema `duallane.release-check/v1`: exit 0 means the observed snapshot is ready,
exit 2 means observed blockers, and exit 1 means the check failed.

Explicit `--check-provider` changes the report scope to
`database_and_provider_snapshot`. Only after the database is ready does it read
the existing `WORKSPACE_STORAGE_DRIVER`/`WORKSPACE_S3_*` settings. Local storage
reports `not_applicable` for provider multipart state. S3 performs one signed
`ListMultipartUploads` GET over the entire configured bucket, with `MaxUploads=1`,
no prefix, no retry, a two-second deadline and a 64 KiB response-body budget
(at most one additional overflow-probe byte). Only a complete non-truncated
empty page is ready. Uploads block; truncation, missing fields, oversized XML,
denial, unsupported operations and timeouts fail closed. The command never
aborts an upload, provisions storage, changes rows or starts a worker.

`deploy/production/release-drain-config.mjs create` derives a private, one-shot
Compose file from a canonical resolved Go configuration and an exact Workspace
image ID. It copies only database and storage-check authority, references
already-existing bridge networks, and excludes business services, data volumes,
OAuth/notification settings and published ports. S3 credentials must use a
supported file-backed secret; unsupported PG environment or secret sources
fail closed. Creation does not start Docker or establish a writer fence.
The companion report validator requires the expected local/S3 driver and
rejects contradictory ready flags, blocking counts or overstated writer proof.

`deploy/production/release-drain-run.mjs run` executes that one-shot check with
`--compose`, `--workspace-image`, `--output`, `--report` and `--run-id`. The
inputs are a private canonical Go Compose file, an exact local image ID and a
64-hex release-run identity; outputs must be new private paths. It verifies the
existing PostgreSQL bridge network, creates without pulling/building, checks
the created container's image, environment, read-only secret source and
isolation, then starts and observes only that exact container. Docker command
output is bounded to 64 KiB and checker waiting to 20 seconds. A valid blocked
report is retained with exit 2; other failures return 1. Cleanup requires the
exact container ID, image and run/project/service labels. Ambiguous ownership
is left for operator review, never removed by a guessed name. This component
does not stop writers or authorize a handoff; the coordinator must do so first.

For the first Node-to-Go cutover, `release-node-authority.mjs verify --compose
<private-go.json> --node-compose <private-node.json>` compares the resolved
database, local/S3 storage and physical named-volume authority with the actual
retained Node API and PostgreSQL containers. The Node API may be stopped but
must remain a unique identifiable owner. The supported database form is the
standard Compose `PGHOST=postgres`, port 5432, database and user shared by every
client/migration process; unsupported connection overrides fail closed. The
credential mount must point to the same file and remain read-only. This is a
read-only identity check, not backup, data migration or a writer fence.

The database snapshot still reports `writers: not_proven` and
`provider: not_checked`; the additional provider observation is a separate
outer field. Neither observation proves an admission fence or the absence of
ambiguous external delivery. The credential file must be a private regular
non-symlink file; its pre-open check assumes trusted operator-controlled paths
and is not an atomic defense against a malicious filesystem owner. The guarded
release coordinator must enforce fencing, file integrity and recovery order.
Running this command by itself is not a deployment or cleanup procedure.

`scripts/backend/gateway-readonly-smoke.mjs` checks an explicit local HTTP
gateway without credentials or mutations. Supply `--base-url`,
`--expected-version`, `--full-commit`, `--profile node-default|go-full` and
`--workspace-enabled true|false` (Go full requires true). It bounds requests,
HTML/assets and WebSocket frames, refuses redirects and external targets, checks
unauthenticated Workspace denial and private endpoints, and prints only safe
stage/count results. The immutable commit must be checked against actual image
and container identities separately: public health exposes version, not commit,
and the smoke report explicitly says `publicCommit: not-exposed`.

The release coordinator derives the smoke URL from the exact current Web
container's single published `8080/tcp` binding, after checking its Compose
ownership and release labels. Wildcard bindings are probed through loopback;
an explicitly bound non-loopback address must be a literal IPv4 address assigned
to the host running the checker. Non-loopback IPv6 remains unsupported. Merely
belonging to a private subnet is not
evidence that an address is local. An unassigned address or arbitrary DNS name
must fail before a request is sent. Keep the existing narrow production bind
when possible; changing it to `0.0.0.0` can expose the gateway on additional
interfaces and needs a separate ingress/firewall review. This address check
does not change the edge listener, authentication, body limits or private
endpoint policy. The [production preflight work record](work-items/2026-09-09-production-preflight.md)
records the reproduction, threat review and remaining operator gates.

Go private paths must return 404. The retained Node gateway may instead return
its exact static SPA HTML; that is classified as no private endpoint exposure,
not backend readiness. These unauthenticated read-only probes cannot replace
the disposable authenticated browser, upload, provider and recovery gates.

The guarded `deploy/production/deploy.sh` is an executable candidate workflow,
not evidence that a full production rehearsal has passed and not deployment
authorization. An explicitly authorized operator must still use the required
production checkout and release procedure. The coordinator's release sequence
is:

1. Verify clean `main`, the exact requested `origin/main` commit, semantic version, production
   path, authoritative PostgreSQL volume, and required tools.
2. Capture a private logical database backup and checksum plus the application
   state needed for recovery. Before building, freeze the previous Node API/Web
   recovery Compose and external-file manifest for a first Node-to-Go cutover,
   or verify the previous Go snapshot and all three sidecars for an upgrade.
3. Build the exact image IDs, then freeze the image-pinned activation Compose.
4. Verify physical database/storage authority before the one-shot migration.
5. Start unpublished candidates and wait for their private readiness checks.
6. Fence the old writers and claimers: Node `api` for the first Node-to-Go
   cutover, or every previous Go owner for a Go-to-Go upgrade. Disable their
   restart policies and confirm they are stopped.
7. Run the bounded drain observation and recheck authority; the observation is
   not itself a writer fence.
8. Start Go backend and worker services, then replace the Web/Nginx gateway
   last. Verify application health and the direct gateway smoke paths.
9. After the final smoke gate, capture the new private Go recovery snapshot and
   retain the previous images and artifacts through the rollback window.

For every changing writer or background claimant, insert an explicit ownership
handoff before activation: stop admission/claims on the old owner, drain its
in-flight transactions and leases (or wait for a verified expiry/fencing
mechanism), confirm it can no longer complete conflicting work, then enable the
new owner. A temporary bounded pause is preferable to unproven overlap. Existing
WebSockets and internal jobs can still mutate data after an edge route changes;
include them in the drain plan. Record recovery for each interrupted handoff
step. Unpublished candidates remain passive throughout this sequence.

### Guarded Go activation and upgrade inputs

The first candidate invocation has the following shape; the expected commit is
mandatory and the profile must be explicit:

```text
deploy/production/deploy.sh --expected-commit <40-hex-commit> --release-profile go-full
```

A Go-to-Go upgrade additionally requires the base snapshot from the last
successful Go release:

```text
deploy/production/deploy.sh --expected-commit <40-hex-commit> \
  --release-profile go-full --go-upgrade \
  --previous-release-snapshot /absolute/private/go-compose.snapshot.json
```

That argument names one of four matching private mode-0600 artifacts, kept
outside Git and normal logs:

1. `go-compose.snapshot.json` — profile/project, commit/version, schema, five
   exact image IDs, and the canonical resolved Compose input.
2. `go-compose.snapshot.json.compose.json` — recovered old Go Compose.
3. `go-compose.snapshot.json.external.json` — external bind/config/secret
   fingerprints.
4. `go-compose.snapshot.json.volumes.json` — physical PostgreSQL/Workspace/
   worker volume authority.

The base path is the CLI value; the three sidecars must remain beside it,
unchanged, regular non-symlink 0600 files. The coordinator also creates a
private image-pinned Go activation artifact and, for the first Node-to-Go
cutover, a private image-pinned Node recovery artifact. All post-freeze Compose
operations use those artifacts; later `.env` or tag changes must not silently
move authority.

Fencing records each original restart policy and retry limit, temporarily sets
`restart=no`, and verifies the owner is stopped. A known-good replacement gets
the recorded policy only after authority, readiness, and recovery checks pass.
Cleanup of a new Go service is allowed only when the service was absent from the
old snapshot and the exact current container has the release-run/image/Compose
ownership labels, a completed fence, `restart=no`, and a stopped state; remove
that exact ID without `compose rm` or force. A pre-existing stopped Go service
present in the old snapshot is not an unowned cleanup target.

If authority, fencing, drain, readiness, or smoke fails, the coordinator fails
closed: confirmed fences stay in place and ambiguous writer state requires
manual review; a failed stop is never reported as a stopped owner. It does not
infer that Node ownership changed or let generic daemon recovery bypass a
failed application-recovery gate. Node recovery uses only the pinned old artifact after the same
authority and drain gates. A successful candidate check or synthetic rehearsal
does not constitute the pending full rehearsal or grant deployment authority.

For a Go-to-Go rollback retry, recovery is exhaustive: it re-identifies and
re-fences all four current owners (`p2p`, `workspace`, `worker`, and `web`),
including an owner whose recreation was never attempted or only partially
completed, before running the recovery drain or starting any old owner. The
original restart policy is restored only after the recovered owner is healthy.

Do not use a bare `docker compose up` to replace an existing production
deployment. Do not run production deployment from the development checkout.

## 10. Rolling Compatibility And Rollback

`deploy/production/release-compose-snapshot.mjs` validates a private Go recovery
artifact containing profile/project, full release commit/version, schema version,
five exact image IDs and the full canonical `docker compose config --format json`
output. The Workspace, worker and migrate IDs must match. Capture and recovery
files use exclusive creation and mode 0600; reads reject symlinks, non-regular
files, oversized input and unsafe permissions. Summaries do not print the
environment. Keep these artifacts outside Git and normal logs.

Canonical Compose output already escapes literal dollar values. Preserve that
serialization exactly when recovering; raw container environment inspection is
not interchangeable with canonical Compose input. A real Compose round-trip
test checks recovery against a changed process/environment file. The artifact
does not freeze external bind/config/secret file bytes or prove live ownership,
schema compatibility, draining or provider state. The caller must verify those
separately before recovery. This helper alone does not enable `--go-upgrade`.

`release-external-files.mjs` adds a Linux-only fingerprint sidecar for that
private, pinned canonical Compose JSON. `capture --compose <absolute-json>
--services p2p,workspace,worker,web,migrate --output <new-absolute-manifest>`
records only external files used by those five services; `verify --compose
<same-json> --input <manifest>` rechecks the exact reference set, canonical
configuration hash, file identity, owner/mode, byte size and SHA-256. Both JSON
inputs and the exclusively created manifest require mode 0600. It rejects
non-file/external/environment secret sources, writable/directory binds,
symlinks and symlinked parent directories. Limits are 32 files, 8 MiB per file
and 32 MiB total; changed sizes are rejected before reading beyond the budget.

This sidecar does not copy or repair secrets, freeze named volumes, or authorize
recovery. Keep versioned old secret/config files unchanged and readable through
the rollback window; rotate to a new file path instead of editing the old file
in place. Missing or changed old files block recovery rather than substituting
current values. Run as a trusted deployment identity controlling the parent
directories: pre/post identity checks are not protection from malicious root
path swaps. Keep the manifest's private paths and hashes outside Git and normal
logs; CLI summaries contain only counts and fixed outcome codes.

`release-volume-authority.mjs capture --compose <private-go.json> --output
<new-private-manifest>` records the running Workspace, worker and PostgreSQL
physical named-volume identities and metadata. `verify --previous-compose
<old-private-go.json> --current-compose <new-private-go.json> --input
<manifest>` rechecks database/storage authority and the physical volumes without
changing Docker state. It requires the standard PostgreSQL connection, shared
`/app/data` root and matching read-only S3 credential binding where configured.
Capture requires unique running holders; recovery verification permits stopped
or absent Workspace/worker holders only while the exact recorded volumes and
canonical authority remain unchanged. PostgreSQL must still be identifiable.
This private sidecar complements the external-file fingerprint; neither check
proves quiescence, data contents or backup recoverability.

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
