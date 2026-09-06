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
| `make -C apps/backend verify` | Prerequisites: `test test-race vet staticcheck vuln build` | Composite candidate gate; excludes PostgreSQL integration. |
| `make -C apps/backend integration-postgres` | `go test -count=1 -race -tags postgres_integration ./...` | Requires disposable real PostgreSQL via `TEST_DATABASE_URL`; required for applicable changes in the matrix below. |

Root wrappers are also checked in: `pnpm backend:check` invokes `verify`,
`pnpm backend:lint` invokes `vet staticcheck`, and the `backend:test`,
`backend:test:race`, `backend:vuln`, and `backend:build` scripts invoke their
matching Make targets. CI currently runs `make verify` and then
`make integration-postgres` in separate steps; a CI definition is wiring
evidence, not a result for this worktree.

The candidate declares Go `1.26` and toolchain `go1.26.8` in `go.mod`. Packages
that import govips require a usable CGO compiler plus libvips headers/runtime.
`Dockerfile.workspace` provisions `libvips-dev` and `pkg-config` for its image
build, while the host-run Go CI job has no explicit `libvips-dev`/`pkg-config`
installation step. This is a reproducibility gap to resolve before treating the
host-run Go gate as portable, not evidence of an observed CI failure. The P2P
image remains CGO-free.

The race gate may be split from fast unit tests, but it remains required for P2P
registries, WebSocket fanout, event delivery, presence, worker loops, and shared
caches. Pin tools through the Go module mechanism, never an unbounded `latest`
installation in CI. Missing prerequisites are an explicit remaining gate.

### OpenAPI 3.1.2 generation gate

[`apps/backend/api/p2p.yaml`](../../apps/backend/api/p2p.yaml) and
[`apps/backend/api/realtime/p2p.schema.json`](../../apps/backend/api/realtime/p2p.schema.json)
are checked-in contract sources. The current candidate has no pinned
oapi-codegen tool, generation configuration, or Make target; generation remains
unverified until the capability gate in
[Technology decisions](TECHNOLOGY.md#3-http-and-contract-policy) is completed.
Do not report generated parity or downgrade the document to OpenAPI 3.0.
An ad hoc generator experiment may supply dated research evidence, but does not
establish a reproducible repository gate.

When that gate is added, its evidence must name the pinned tool/runtime and
record exact 3.1.2 parsing, generated-code compilation, and contract/parity
checks. Test that request/response validation rejects invalid direct-`const`
values from the checked-in spec, not just that a generated type compiles. A
failed or unresolved generation attempt leaves the existing contract source
authoritative.

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

## 9. Realtime And Failure Injection

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

## 11. Performance Evidence

Do not invent capacity targets. Before a scale or performance claim, record a
repeatable baseline for representative HTTP requests, active WebSockets, event
replay, upload parts, PostgreSQL pool contention, image processing, and worker
backlog. Define an acceptance threshold in the owning migration slice before
optimizing or adding replicas.

Performance tests use synthetic content and bounded resource limits. They must
not weaken correctness assertions or privacy controls to improve throughput.
