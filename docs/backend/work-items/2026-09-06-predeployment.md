# Backend Pre-deployment Completion Work Record

## Objective And Authority

User request: complete the Go backend refactor's pre-deployment work and submit
a pull request. Base `25121ae`, branch `codex/go-backend-architecture`; fetched
`origin/main` is `b6dd0c66ed00a7c6a6f252cac537b43ef262e743` (already an ancestor).

The acceptance boundary is a fully implemented, integrated, reviewed and tested
candidate release, with deployment/rollback tooling and an accurate PR. No
production deployment, merge, data import, external notification delivery or
production ownership transition is authorized. Keep Node rollback support until
the separately authorized cutover and observation window. The canonical owner
ledger remains [Evolution](../EVOLUTION.md); this is implementation evidence and
a work queue, not a second owner ledger.

Observable behavior remains the existing P2P/Workspace/SDK contract. Every
deviation requires an explicit compatibility/security decision and tests. P2P
remains transient and isolated from database/storage credentials. Workspace
retains server authorization, quota-before-body, retention, idempotency, audit,
event and object-reference invariants. All rehearsals use disposable synthetic
state; historical SQL migrations are immutable.

## Ordered Acceptance Queue

Unchecked work is not complete, and a test command listed here is not evidence
that it passed. Each accepted slice records exact commits and commands below.

- [ ] Close P2P error/HTTP/WebSocket parity and privacy/lifecycle gaps.
- [ ] Run browser P2P text/file/fallback/fragment acceptance against Go.
- [ ] Complete and integrate Avatar, Emote, Bot Gateway and Echo candidates.
- [ ] Inventory all active Node endpoints, jobs, maintenance operations and Go
      composition; account for each capability without placeholder services.
- [ ] Prove Workspace auth/read/write/realtime and extended-domain compatibility,
      including persisted effects, audit, retries, concurrency and permissions.
- [ ] Prove local/S3 object and native media compatibility, failure cleanup and
      resource bounds.
- [ ] Complete worker delivery/leases, cross-process presence, cleanup and
      maintenance command ownership; test with synthetic local providers.
- [ ] Rehearse Node/Go bootstrap, upgrade, schema coexistence and rollback.
- [ ] Build candidate images and validate private-container/gateway configuration,
      readiness, failure refusal, restoration and application rollback.
- [ ] Restore a passing whole-tree baseline, run required Go/Node/PostgreSQL/
      browser/container gates, and independently review the aggregate diff.
- [ ] Update durable backend/Agent/operator guidance and release compatibility
      notes without claiming production is already Go.
- [ ] Push split commits, submit the PR with exact evidence and review risks,
      and address actionable CI/review failures before readiness.

Production observation and final legacy removal occur after this task's boundary;
they remain explicit operator gates, never fabricated pre-deployment passes.

## Parallel Ownership — Wave 1

All workers read mandatory and owning product/security guides. Workers edit
directly but never stage, commit, switch branches, push or deploy. The lead owns
the shared index, contract decisions, schema, dependencies, command composition,
shared routers, gateway/CI, and handbook integration. No overlapping writes.

| Worker | Owned writes | Acceptance / parent dependency |
| --- | --- | --- |
| P2P safety | New P2P tests, room/envelope tests, parity runner/tests/fixtures | Bounded privacy/lifecycle coverage; parent owns transport error fix, schemas and Node route |
| Avatar | Existing `internal/workspace/avatars` draft; new avatar HTTP/test files | Complete repository/service/transport and focused tests; return router/composition requirements |
| Echo requirements | Existing `internal/workspace/echo/requirements` draft | Complete requirement domain and PG tests; report adjacent Echo integration needs |
| Node emote baseline / schema check | First the emote test fixture only; then new read-only platform migration-check files | Preserve test volume/time limit; return read-only startup schema verification for parent composition |
| Bot Gateway | `internal/workspace/botgateway` only | Real v1 WebSocket and domain adapters; parent owns HTTP/router/commands |
| Emote subscriptions | `internal/workspace/emotes` only | Replace fixed 501 and prove source sync/detach/readonly/quota/reference/audit/event atomicity |

The original Bot Gateway/router, Avatar and Echo drafts were preserved through
the preceding foundation slice. This broader user request brings completion of
those candidate domains into scope. Extend and review their existing intent;
never silently discard drafts or present them as previously validated.

## Validation Environment

Use the toolchain and isolation guidance in the
[foundation record](2026-09-06-foundation-contracts.md). Node startup/browser
validation should use a Linux-native checkout in WSL. Do not weaken timeouts or
assertions merely to hide the previous large-emote baseline timeout. Required
database/provider/storage tests must not target a production account or instance.

## Evidence And Handoff

This work is in progress. No acceptance checkbox above is satisfied solely by
the inherited foundation results. Append reviewed slice commits, exact fresh
checks, failures, environment limitations and cleanup as work progresses.

### Accepted Slices — 2026-09-06

- `3998567`: Go now preserves the locked Fastify 5.8.5 safe empty/invalid/
  oversize JSON error contract. The new regression failed before the fix;
  scoped Go race and staticcheck, generated-contract freshness and conformance
  passed after it. Node runtime is unchanged; five Node characterization cases
  passed. Independent clean-process `pnpm backend:parity:p2p` passed 20 HTTP
  and 19 WebSocket observations. Expanded privacy/lifecycle and browser gates
  are still pending; this is not a full P2P acceptance claim.
- `c575549`: composed the real catalog, bounded native processor and Emote
  service in the Workspace command, reusing that service for message references.
  `go test -tags=postgres_integration -count=1 -race ./cmd/workspace
  ./internal/platform/config` passed on disposable PostgreSQL, including real
  session-authenticated HTTP upload, libvips normalization, local read and audit.
  Scoped staticcheck passed. No production writer changed.
- `e58b30f`: bounded legacy local/S3/hybrid reads for pre-registry records,
  without a canonical-key/digest bypass. Storage race tests passed, including
  containment/symlink rejection, cancellation, overage-before-GET and missing-only
  fallback. Staticcheck passed on the adapter before the final canonical-alias
  rejection assertion; the final whole-tree gate remains required.
- `bd9cdc6`: test-fixture-only SQLite batching removes 1,002 standalone writes
  from the large-emote case; runtime, assertions, item/collection counts and
  the five-second timeout are unchanged. Parent independently passed all 21
  focused tests in both mounted and Linux-native checkouts. Clean `bd9cdc6`
  `pnpm test` passed 8 SDK and 702 Web tests, with the two explicitly gated
  PostgreSQL cases skipped. This resolves the previously recorded Node timeout;
  skipped PostgreSQL checks still require their separate gate.
- `e5c1141`: suppress raw native image diagnostics before first libvips startup.
  A fresh-process regression reproduced unfiltered startup logs before the fix;
  media `go test -count=1 -race` and staticcheck passed after it. Typed safe
  domain errors and content-free audit remain the operational error surface.

All PostgreSQL checks above used synthetic data in isolated schemas of the
task-owned disposable database. No production credentials, volumes, providers,
notifications or deployment were used. The original draft domains and new
worker slices remain under review until separately accepted below.

- `d3f12da`: private Workspace/worker readiness rechecks required dependencies
  with a two-second request budget and refuses readiness during shutdown. Local
  storage inspection performs no writes or directory recreation. Scoped race
  and staticcheck passed. A mounted command integration attempt overlapped an
  incomplete worker Emote edit and could not compile; independent clean
  `34e5d5e` command PostgreSQL/race tests subsequently passed.
- `34e5d5e`: expanded P2P privacy/dependency/lifecycle/oversize/header/ICE
  coverage, parser assertions, storage-artifact checks and close-frame parity.
  Parent corrected the worker's initial 1000 close-code assumption: real Node
  sends an empty close frame, observed as 1005. Node characterization passed
  while old Go failed; the corrected candidate independently passed 21 HTTP /
  22 WebSocket observations, fresh P2P/contract race tests, staticcheck and all
  eight parity-runner unit tests. Browser/fragment acceptance is delegated and
  remains open.

### PR And Independent Gates

[Draft PR #2](https://github.com/timeStarry/duallane/pull/2) is open. The first
remote CI at `1dca0d3` passed both Go/PostgreSQL and Node/lint/build/Chromium E2E
jobs. Those existing browser tests run against Node, not the new Go browser
candidate. Clean `e5c1141` also passed `make verify` and a fresh complete
`make integration-postgres` against the disposable task database. These gates
exclude uncommitted worker slices and must be repeated after final integration.

The GitHub connector could not create the PR with its integration permissions;
the already-authenticated local GitHub CLI successfully created the same scoped
draft. No token/permission settings changed. The PR remains draft until every
pre-deployment acceptance item and aggregate review is complete.
