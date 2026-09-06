# Backend Validation

## 1. Validation Principle

Migration is complete by behavioral evidence, not by equivalent-looking code.
Tests scale with the affected trust lane, data invariant, concurrency risk,
external side effect, and deployment blast radius.

The Go candidate and its repository-native commands now exist, but a manifest,
Make target, CI definition, or candidate image is not a passing result. Record
the exact command, commit, environment, and status for every gate. Production
ownership and parity still require the separate migration evidence in
[Evolution and migration](EVOLUTION.md).

## 2. Current Documentation And Baseline Gates

For documentation-only work:

```bash
git diff --check
```

Also validate local links and executable examples. For changes that characterize
or modify the active Node implementation, use the existing gate from
`docs/development/TESTING_AND_RELEASE.md`, including as applicable:

```bash
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

PostgreSQL-sensitive behavior additionally uses the existing disposable
`TEST_DATABASE_URL` integration command. For the Go candidate, the exact target
is `make -C apps/backend integration-postgres`; it is separate from
`make -C apps/backend verify`.

## 3. Candidate Go Gates And Evidence

The checked-in [`apps/backend/Makefile`](../../apps/backend/Makefile) is the
source of truth for candidate checks. From the repository root, use the Make
targets below; do not substitute an unpinned global tool command. The recipes
require GNU Make and a POSIX shell, such as a configured Linux/WSL environment.

| Target | Recipe with default `GO=go` | Scope/prerequisite |
| --- | --- | --- |
| `make -C apps/backend test` | `go test ./...` | Default package tests; does not select PostgreSQL integration files. |
| `make -C apps/backend test-race` | `go test -race ./...` | Race coverage for the default package set. |
| `make -C apps/backend vet` | `go vet ./...` | Static analysis for the default package set. |
| `make -C apps/backend staticcheck` | `go tool staticcheck ./...` | Tool package declared in `go.mod`; version fixed by its module requirements. |
| `make -C apps/backend vuln` | `go tool govulncheck ./...` | Tool package declared in `go.mod`; version fixed by its module requirements. |
| `make -C apps/backend build` | `go build ./cmd/...` | Builds the checked-in command set. |
| `make -C apps/backend generate` | `go generate ./internal/p2pcontract`, then `go tool sqlc generate --no-remote` | Regenerates P2P contract and presence queries with pinned tools. |
| `make -C apps/backend check-generated` | P2P freshness test, then `go tool sqlc diff --no-remote` | Non-mutating freshness checks against source contracts, query source and canonical migrations. |
| `make -C apps/backend verify` | Prerequisites: `check-generated test test-race vet staticcheck vuln build` | Composite candidate gate; excludes PostgreSQL integration. |
| `make -C apps/backend integration-postgres` | `go test -count=1 -race -tags postgres_integration ./...` | Requires disposable real PostgreSQL via `TEST_DATABASE_URL`; required for applicable changes in the matrix below. |

Root wrappers are also checked in: `pnpm backend:check` invokes `verify`,
`pnpm backend:lint` invokes `vet staticcheck`, and the `backend:test`,
`backend:test:race`, `backend:vuln`, and `backend:build` scripts invoke their
matching Make targets. CI currently runs `make verify` and then
`make integration-postgres` in separate steps; a CI definition is wiring
evidence, not a result for this worktree.

`pnpm backend:generate` and `pnpm backend:check-generated` wrap the generation
targets. Never hand-edit `p2p.gen.go` or the nested presence query output;
edit the source/config and regenerate. The first sqlc invocation may compile a
large development-tool dependency graph; this does not add SQLite or sqlc to
the runtime service. Generated SQL preserves the handwritten authorization and
locking predicates, which must still pass real PostgreSQL/race tests.

The candidate declares Go `1.26` and toolchain `go1.26.8` in `go.mod`. Packages
that import govips require a usable CGO compiler plus libvips headers/runtime.
`Dockerfile.workspace` provisions `libvips-dev` and `pkg-config` for its image
build. The host-run Go CI job installs `gcc`, `libvips-dev`, and `pkg-config`,
sets CGO explicitly, and checks their availability before `make verify`.
The dependency-order regression test is
`node --test .github/tests/ci-go-native-dependencies.test.mjs`. These steps do
not pin OS package versions or establish image reproducibility. The P2P image
remains CGO-free.

The race gate may be split from fast unit tests, but it remains required for P2P
registries, WebSocket fanout, event delivery, presence, worker loops, and shared
caches. Pin tools through the Go module mechanism, never an unbounded `latest`
installation in CI. Missing prerequisites are an explicit remaining gate.

### Actual Node Legacy Emote Compatibility

With the pinned Node/Go dependencies and an explicit disposable PostgreSQL
`TEST_DATABASE_URL`, run:

```sh
node --test scripts/backend/workspace-emotes-legacy-parity.test.mjs
node scripts/backend/workspace-emotes-legacy-parity.mjs --go
```

The Node owner creates synthetic historical files and a small metadata manifest.
The Go probe imports those rows into its own temporary PostgreSQL schema and
uses the real Workspace application, session cookie and HTTP delivery path.
Node then rechecks the same fixture. Cases cover a null-metadata clone chain,
missing-canonical fallback, no-resource deletion, malformed keys and denied
access. The runner cleans only its own temporary directory and reports success
after cleanup. `--go` refuses a missing test database; without `--go`, the output
explicitly says Go was not run. Neither mode uses production content or proves
S3-provider interoperability. CI runs the full `--go` path separately from
ordinary Go tests, where the fixture-dependent test is intentionally skipped.

### OpenAPI 3.1.2 generation gate

[`apps/backend/api/p2p.yaml`](../../apps/backend/api/p2p.yaml) and
[`apps/backend/api/realtime/p2p.schema.json`](../../apps/backend/api/realtime/p2p.schema.json)
are checked-in contract sources. The P2P generation config, pinned Go tool,
generated models/interfaces, and conformance tests now live beside them in
`api/p2p.codegen.yaml` and `internal/p2pcontract`. Run:

```bash
make -C apps/backend generate
make -C apps/backend check-generated
cd apps/backend && go test -count=1 ./internal/p2pcontract
```

The freshness test generates into a temporary output and compares it with the
checked-in artifact. Conformance tests load the exact 3.1.2 source locally,
reject invalid request/response direct-`const` values, and exercise the existing
P2P handler. They do not install a new runtime validator/router and do not cover
WebSocket frames merely because the upgrade endpoint is present in OpenAPI.

Name the pinned tool/runtime, exact tested commit, and outcomes in the evidence
record. A passed generation gate does not establish Node/Go parity or permit
cutover. See [Technology decisions](TECHNOLOGY.md#3-http-and-contract-policy).

### Replayable evidence record

Attach a compact record to each migration slice or validation report:

```text
base_commit: <exact base commit>
candidate_commit: <exact candidate commit; identify any uncommitted patch tested>
checked_at: <timestamp and timezone>
environment: <OS, Go/tool/runtime, CGO/libvips, PostgreSQL/container versions as applicable>
command: <exact command or Make/root wrapper; redact credentials>
status: PASS | FAIL | SKIP | NOT RUN
coverage: <lane, capability, test layer, and required cases actually executed>
safe_artifacts: <redacted paths, reports, or none>
reason_or_next_gate: <required for FAIL, SKIP, or NOT RUN>
```

`PASS` and `FAIL` describe executed checks. `SKIP` identifies deliberately
omitted checks or test cases, with a reason; `NOT RUN` records no attempt.
A zero exit code with required tests skipped is not a passing capability gate.
Report cached Go test results as cached; rerun with `-count=1` when fresh
execution evidence is required. Neither skipped nor unattempted checks supply
coverage. Evidence must not contain credentials, private connection strings,
invite fragments, P2P payloads, or sensitive user data.

### Go P2P browser gate

Run `pnpm test:e2e:p2p-go` with the pinned Go/Node/pnpm toolchains and the
repository's Chromium installed. The dedicated Playwright config builds
`cmd/p2p` without CGO, starts an isolated loopback service plus Vite on ports
8897/5197, and refuses to reuse an existing server. It passes no Workspace,
database, storage, OAuth, or notification credentials to P2P. Do not terminate
an unrelated process if those ports are occupied.

The suite covers two-context direct text/file delivery, encrypted WebSocket
fallback with acknowledgements, malformed fragment refusal before transport,
and a valid-format wrong key that cannot decrypt a relayed chat. Secret and
plaintext observations remain bounded in test memory; assertions emit booleans
or counts. Traces, videos and screenshots are disabled. Failure DOM context
stays under ignored `.private-test-results/`, outside normal CI artifact paths;
never upload it or copy raw browser requests into evidence.

The Node suite deliberately excludes this spec. CI has a separate Go P2P job
without artifact uploads. Run
`node --test .github/tests/ci-go-p2p-privacy.test.mjs scripts/backend/owned-process.test.mjs`
when changing its configuration or process helper. These guards verify isolation
and bounded shutdown, including TERM escalation; they are not browser coverage.
Browser success proves this candidate's P2P flow, not Workspace parity, gateway
deployment, production routing or a completed cutover.

## 4. Change Matrix

| Change | Required evidence |
| --- | --- |
| Pure domain parser/projection | Table tests, boundary values, fuzz test where untrusted structure is parsed |
| HTTP route | Handler test plus OpenAPI conformance and active-implementation parity fixture |
| P2P room/envelope | Unit/race tests, two-peer WebSocket flow, invalid/oversized frames, disconnect/expiry, privacy log/storage test |
| Workspace mutation | Domain/service test, PostgreSQL transaction test, authorization rejection, audit, event, idempotency/revision behavior |
| Query or repository | Real PostgreSQL test for rows, nulls, constraints, affected-row checks, cancellation, and error mapping |
| Quota/transfer | Concurrent reservations, overage-before-body, failure release, duplicate/retry, audit and actor-local event tests |
| Realtime | Permission-filtered replay, ordering, duplicate wake-up, missed notification, reconnect, sync-required, slow consumer, restart |
| Worker | Claim race, lease expiry, retry schedule, current-eligibility recheck, cancellation, ambiguous provider result, safe errors |
| Storage/object registry | Local and S3-compatible contract tests, digest race, reference cleanup, signed delivery authorization, partial failure |
| Avatar/emote | Media compatibility corpus and resource-limit/failure tests in Section 8 |
| Migration | Clean bootstrap, upgrade from oldest supported state, active Node/Go compatibility, retry/refusal, forward recovery |
| Compose/Nginx/image | Compose config, image build, non-root/runtime contents, health, route/body/header/WebSocket checks |
| Deployment script | Shell/static checks, candidate failure, migration failure, daemon restart restoration, application rollback rehearsal |

## 5. Contract Parity Harness

### Executable P2P slice

Run `pnpm backend:parity:p2p` (or `make -C apps/backend parity-p2p`) with
Node 22+, Go and GNU Make on the same OS. On Windows, use WSL and prefer a
Linux-native checkout with its own frozen-lockfile dependency install; cold
imports on a Windows-mounted checkout may exhaust the startup bound. The Make
target builds a disposable CGO-free P2P executable and removes it after the run.
To reuse an explicitly built local binary:

```bash
node scripts/backend/p2p-parity.mjs --go-binary /absolute/path/to/p2p
node --test scripts/backend/p2p-parity.test.mjs
```

The runner starts the actual Node server and Go candidate sequentially on the
same ephemeral loopback port. It uses isolated temporary directories, synthetic
fixtures, a minimal child environment and `WORKSPACE_ENABLED=false`. It does not
accept a remote API endpoint or inherit database/provider credentials. Startup,
request, frame-read and total-run waits are bounded; signals trigger child and
temporary-data cleanup. Child logs are discarded, not retained as privacy proof.

The initial fixture suite observes 20 HTTP responses and 19 WebSocket frames:
health/default ICE, room creation/status/input boundaries, two peers, presence,
secure relay, plaintext/invalid-envelope rejection, leave, full/missing rooms.
The full JSON body/frame is compared, including error fields and omissions.
Only generated room/peer identities (with relationships preserved), timestamps
and release versions are normalized. Object key ordering is ignored, array
ordering is retained. HTTP headers, close codes, expiry/reconnect, oversized
input, TURN variants, browser fragments and log/storage absence are not covered
by this initial suite; the gates below still apply.

Exit zero means these observations match, not permission to route traffic.
Any mismatch exits nonzero and reports case/field paths without response values.
Do not replace error bodies with status-only assertions to make parity pass.
The runner's unit guards run in CI; the cross-implementation command is separate
from `make verify` while compatibility differences remain unresolved. Record
observed differences and the exact tested source in the slice's evidence record;
a working runner is not a blanket parity claim.

### Extending coverage

The first strict Workspace schema slices describe auth/core and emote routes.
Run their actual Node characterization checks after dependency installation:

```bash
node scripts/backend/workspace-core-contract.mjs --check
node scripts/backend/workspace-emotes-contract.mjs --check
node scripts/backend/topic-parser-fixtures.mjs --check
node scripts/backend/topic-card-fixtures.mjs --check
cd apps/backend
go test -race ./internal/workspacecontract ./internal/workspace/topics
```

CI rechecks these fixtures against Node; Go tests verify the checked-in schema
and parser/card results. The contract package does not execute Go HTTP handlers.
Prove Go route behavior separately with enabled HTTP/PostgreSQL and browser
tests. The core route inventory exceeds its initial scenario set: redirect
headers, remaining cases and remaining families are not implicitly covered.

`node scripts/backend/route-inventory.mjs --check` checks the generated
`apps/backend/api/node-routes.json` against current literal route declarations
and the actual Node application's registration/disabled responses. Regenerate
with `--write` only after reviewing changes. The script creates and removes a
unique synthetic directory, disables Workspace, uses no database, and makes no
external provider calls. It currently inventories 164 declarations and 153
disabled HTTP responses. Static-file plugin routes and implicit HEAD routes
are outside this explicit API inventory.

This inventory is a transport coverage input, not complete OpenAPI schemas or
proof that a Go route has real dependencies. Prefix-level disabled middleware
can return 503 even for an unwired route. Check registration separately, then
prove enabled authorization, DTOs and persisted effects through owning-domain
fixtures and command-composition tests.

Build parity fixtures by capability, not one snapshot for the entire API. Each
fixture contains synthetic input, prepared database/object state, expected
public response, persisted changes, audit rows, event projections, and safe
log expectations.

The same fixture runs against the active Node implementation and the Go
candidate where technically possible. Normalize only values explicitly defined
as nondeterministic, such as generated IDs and timestamps. Do not normalize
field omission, order where a contract defines it, status codes, error codes,
or authorization visibility.

Read-only comparisons may run side by side against disposable data. Production
shadow writes and Node/Go dual writes are prohibited. Mutation parity uses
separate resettable PostgreSQL databases or transactions and compares outcomes.

## 6. P2P Privacy Gate

Before routing P2P traffic to Go, prove:

- the browser `#k=` fragment is absent from HTTP requests, access logs, errors,
  metrics, and telemetry;
- only allowlisted, versioned secure envelopes cross WebSocket fallback;
- plaintext message/file payloads and invalid frame shapes are rejected;
- room/peer/envelope data is absent from PostgreSQL, object storage, job tables,
  audit rows, and filesystem artifacts;
- log capture contains no ciphertext, nonce, profile/display-name content, full
  room ID, or raw frame;
- the two-peer limit, expiry, empty-room grace, reconnect, and cleanup match the
  active contract;
- race and resource-exhaustion tests cover concurrent join/leave/send/close and
  oversized input.

## 7. Workspace Data And Concurrency Gate

Use real PostgreSQL to prove the cases SQLite or mocks cannot establish:

- last-owner and membership races;
- quota reservation under concurrent uploads/downloads;
- idempotency replay versus conflicting key reuse;
- stable lock order and deadlock handling;
- compare-and-swap revision conflicts;
- event sequence allocation and transaction rollback;
- object digest acquire/bind/release/cleanup races;
- worker job claim/lease races;
- session revocation and permission changes during active requests or sockets;
- migration advisory locking and concurrent startup refusal.

Tests assert safe public errors and required content-free rejection audits, not
only database success.

## 8. Media Compatibility Gate

The govips decision requires a checked-in synthetic corpus or deterministic
fixture generator covering:

- valid JPEG, PNG, WebP, animated WebP, GIF, animated GIF, and accepted BMP;
- EXIF rotations, transparency, one-pixel and maximum-boundary dimensions;
- near-limit input bytes, decoded pixels, dimensions, frames, duration, and
  output bytes;
- corrupt/truncated headers, MIME mismatch, unsupported compression, animation
  bombs, and decompression-heavy samples.

For each fixture compare accepted/rejected status, stable error code, detected
format, dimensions, frame count, duration, output MIME, size limit, orientation,
and visual/frame preservation. Compare bytes only where byte identity is part of
deduplication or an existing externally observable contract.

Run media tests with bounded concurrency and observe peak memory. Imported emote
assets and production user content are not test fixtures.

`node --test scripts/backend/media-compatibility.test.mjs` runs the actual
Node owners against the host Go/libvips toolchain. A host pass is not the native
image gate. On a Linux Docker host, build the Workspace Dockerfile's `build`
target from the reviewed snapshot, inspect its exact local image ID, then run
`node scripts/backend/media-compatibility.mjs --go-image sha256:<64-hex-image-id>`.
Tags are rejected. The runner checks the created container's ID, image and unique
run label before starting it and removes only that owned container.

The native probe has no network, capabilities or production mounts. Only its
generated corpus directory is mounted read/write with the invoking Linux UID/GID;
Go compiles in a bounded executable tmpfs. This build-target test does not loosen
the production runtime's filesystem policy. The report reads actual Go/CGO and
libvips versions from bounded container evidence files. It compares all existing
metadata stripping, pixel, animation, rejection and resource-limit assertions
without adjusting them for the native version. Record a mismatch as a failed
image compatibility gate, even if the host tests passed.

The processor normalizes the freshly encoded WebP container after native
export: only structural image/alpha/animation chunks survive, metadata feature
bits are cleared, and lengths/padding are reconstructed without modifying the
encoded pixel payloads. This is a defense against native saver version drift,
not a general sanitizer for an arbitrary user-supplied WebP. Keep the real
Node/native-image corpus as the acceptance gate; a parser unit test alone does
not establish color, orientation, transparency or animation preservation.

## 9. Realtime And Failure Injection

### Workspace browser candidate

`pnpm test:e2e:workspace-go` runs the existing `e2e/workspace*.spec.ts`
assertions against freshly built Go migrate/Workspace commands and Vite, with
one Chromium worker and no retries. It requires Go/CGO/libvips, installed pnpm
dependencies, Chromium, and an explicit disposable loopback PostgreSQL URL in
`TEST_DATABASE_URL`. Set `DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION=true` exactly
only for that disposable database: the harness creates and drops its own random
schema. It refuses non-loopback hosts, system databases and connection options
that could override the synthetic search path.

The fixed loopback ports 8898/5198 must be free. Existing servers are never
reused. Children receive a minimal environment, synthetic local storage and
disabled email/ntfy/maintenance workers; no real provider configuration is
forwarded. Shutdown awaits owned processes before dropping the random schema
and temporary files. Failure details remain in the ignored
`.private-test-results/workspace-go-browser` directory; do not publish these
artifacts. Guard tests run with
`node --test scripts/backend/go-workspace-browser.test.mjs`.

This is a separate gate from the active Node browser suite and the Go P2P
browser suite. A harness commit or passing guards does not mean all Workspace
browser cases passed; record the complete selected test count and any failure.

CI runs this complete command in the independent `go-workspace-browser` job
with disposable PostgreSQL 17, the module-selected Go toolchain, Node 22,
pnpm 10.30.3, native CGO/libvips dependencies and Chromium. It has a 30-minute
job limit and publishes no browser artifacts. Configuration/privacy guards in
`.github/tests/ci-go-workspace-privacy.test.mjs` ensure that the job does not
silently filter tests, change test timeouts/retries or upload private failure
output. These guards are part of the general backend tooling gate; their pass
does not substitute for the browser job itself.

Realtime validation includes:

- notify before/after listener startup race;
- dropped/coalesced/duplicate PostgreSQL notifications;
- event committed while replay is in progress;
- permission removed before projection or during a socket;
- database disconnect and listener reconnect with backoff;
- socket heartbeat timeout, slow reader, oversized message, abrupt close, and
  server shutdown;
- current cursor, cursor ahead, replay limit, and unknown future event type;
- multiple Workspace instances only when scale-out is being enabled.

Correctness is measured from persisted cursor recovery; low-latency wake-up is
secondary.

## 10. Deployment Acceptance

With an explicit disposable `TEST_DATABASE_URL`, run
`go test -count=1 -race -tags postgres_integration ./cmd/release-check ./internal/platform/releasecheck ./internal/platform/storage`
from `apps/backend`. The command integration covers local readiness, database
upload blockers with zero S3 requests, and ready/blocked/denied synthetic S3
responses. It runs canonical migrations in its own random schemas and checks
that seeded row counts and upload/attachment states remain unchanged. The
storage unit tests additionally check signed GET-only observation, exact and
over-limit XML, truncation, cancellation and private-error redaction. Missing
database configuration is `SKIP`, not an integration pass.

Private recovery-file checks run with
`node --test scripts/backend/release-external-files.test.mjs` on Linux in CI.
They cover frozen Compose binding, external-file selection, identity/content/
permission changes, symlinks, unavailable files, exclusive 0600 output, bounded
file/total bytes and content-free CLI errors. They do not create application
containers or prove named-volume or live writer authority.

The retained offline storage boundary is guarded by
`node --test scripts/backend/storage-operator-retained.test.mjs` in CI. It
checks the actual Node command modes, opt-in one-shot storage Compose services,
Go plan/verify/provision dispatch and absence of Node-tool startup hooks in the
Go entrypoints. This is a static entrypoint contract, not a whole-program
proof or permission to execute a data-changing operator command. The canonical
boundary and destructive-finalization conditions are in
[Storage operator](STORAGE_OPERATOR.md#retained-offline-compatibility-tools).

A service is not production-ready until the guarded deployment can:

1. Build the exact labeled image from a clean commit.
2. Run compatible migrations once.
3. Start an unpublished candidate and distinguish liveness/readiness.
4. Reject a candidate with invalid config, missing schema, unavailable required
   storage, or wrong version/commit.
5. Route only after the candidate is ready.
6. Preserve or restore every previously running application container if Docker
   restarts.
7. Roll application images/routes back without an unsafe schema rollback.
8. Verify external Web, `/api/health`, authentication boundary, P2P, Workspace
   gate, WebSocket, static assets, and the changed capability.

Record exact commands and results in the PR. An unavailable external environment
is a remaining gate, not a pass.

The isolated real-Docker restart-policy gate requires an explicit local
shell-capable immutable image on Linux:

```sh
DUALLANE_RESTART_POLICY_TEST_IMAGE=sha256:<64-hex-image-id> \
  node --test scripts/backend/release-restart-policy.docker.test.mjs
```

It creates two private, network-free, mount-free synthetic containers and
exercises the real release helper's label checks, `restart=no` fencing, stop
confirmation and selected-owner policy restoration. Both `always` and
`on-failure:3` are covered. Cleanup rechecks exact IDs/image/ownership and
removes only these containers. It never restarts Docker or exercises a
production release. Without the explicit image the test reports `SKIP`;
that is not evidence for this gate. The separate release harness covers
partial failures and daemon-recovery decisions.

## 11. Performance Evidence

Do not invent capacity targets. Before a scale or performance claim, record a
repeatable baseline for representative HTTP requests, active WebSockets, event
replay, upload parts, PostgreSQL pool contention, image processing, and worker
backlog. Define an acceptance threshold in the owning migration slice before
optimizing or adding replicas.

Performance tests use synthetic content and bounded resource limits. They must
not weaken correctness assertions or privacy controls to improve throughput.
