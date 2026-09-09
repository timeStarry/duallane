# Backend Evolution And Migration

## 1. Purpose

This document is the canonical source for backend capability ownership during
the Node-to-Go transition. After final cutover it remains the architecture
evolution process and historical migration record.

Target documents describe where the system is going. This status ledger says
which implementation may be changed, routed, and trusted today.

## 2. Status Vocabulary

| Status | Meaning |
| --- | --- |
| `planned` | Target boundary is approved; active behavior remains entirely with the current owner |
| `parity` | Go implementation and disposable-environment evidence exist, but it receives no production writes |
| `routed` | The complete capability is routed to Go; Go is the only writer for any mutation and tested legacy rollback remains available |
| `active` | Go or retained infrastructure is canonical; normal development targets it and legacy routing/claiming is removed |
| `complete` | Go remains canonical and the legacy implementation, tests, config, and rollback dependency are removed or archived |

A passing build does not advance status. Each change requires the evidence and
route/rollback conditions below. A capability cannot be simultaneously written
by Node and Go.

## 3. Capability Ledger

The approval baseline below is historical. The ledger records the latest
accepted evidence and inspected production owners. Update it in every
parity, cutover or rollback PR.

### Ownership Is Not Implementation Progress

The status column records migration acceptance and production ownership, not a
percentage of code written. A `planned` capability may already have Go packages,
handlers, tests, or an image while still lacking complete parity evidence.
Inspect the [executable evidence map](README.md#find-the-executable-evidence)
and the owning migration PR before starting duplicate implementation work.

Track candidate progress in that PR or task record: implemented transport and
domain scope, composition, contract coverage, checks actually executed, and
remaining gates. Do not create a second production-owner ledger. Split a broad
capability row before independently routing its sub-capabilities; each row must
identify a complete, non-overlapping write/claim unit.

An ownership transition record must identify:

- the capability, previous/new owner, and status transition;
- the exact tested base/candidate commits, environment, and dated validation
  evidence required by [Validation](VALIDATION.md);
- the route configuration and any background writer, job claimer, scheduler,
  or migration-runner ownership affected by the change;
- for production transitions, the deployed release/image identity, authorized
  operator record, observation window/results, and rollback evidence;
- the reviewer and outstanding gates, with `not run` distinct from `passed`.

An approved design or merged PR is not deployment evidence. If production
cannot be inspected, state that limitation; do not infer a live cutover from a
repository file. The approval baseline below remains historical evidence only,
not test results for the current worktree.

### Owner Ledger

| Capability | Current owner | Target owner | Status | Required next gate |
| --- | --- | --- | --- | --- |
| Static Web and edge gateway | Nginx/Go Web image | Nginx/Web image | `active` | Preserve verified Go upstreams, private paths and security headers |
| P2P room, ICE, and secure WebSocket relay | Go P2P | Go P2P | `routed` | Longer observation and real two-browser WebRTC/transfer acceptance |
| Workspace feature gate and health | Go Workspace | Go Workspace | `routed` | Retain exact feature-gate tests; observe enabled production |
| GitHub OAuth and Workspace sessions | Go Workspace | Go Workspace | `routed` | Normal authorized real OAuth/session smoke |
| Workspace read APIs | Go Workspace | Go Workspace | `routed` | Authenticated current-membership projection observation |
| Workspace conversation/message mutations | Go Workspace | Go Workspace | `routed` | Dedicated synthetic conversation and production data-integrity observation |
| Workspace realtime WebSocket | Go Workspace | Go Workspace | `routed` | Authenticated replay/reconnect observation |
| Quota, upload/download, and object registry | Go Workspace | Go Workspace | `routed` | Authorized synthetic upload/download and legacy-byte acceptance |
| Avatar and custom-emote processing | Go Workspace/govips | Go Workspace/govips | `routed` | Authorized real legacy/media reads and resource observation |
| Topics, cards, interactions, Agent Bots, and Echo | Go Workspace | Go Workspace | `routed` | Dedicated critical workflow observation without real-recipient test notifications |
| Email, ntfy, Bot delivery, cleanup/reconciliation | Go Worker | Go Worker | `routed` | Longer exclusive-claimer observation and authorized real-provider validation |
| PostgreSQL migration and seed runner | Go migrate | Go migrate | `routed` | Retain verified schema-33 compatibility and recovery artifacts |
| PostgreSQL database | PostgreSQL 17 deployment | PostgreSQL deployment | `active` | Preserve authoritative volume, backup, and supported upgrade path |
| Local/S3 content-addressed storage | Go Workspace adapters and same stores | Go Workspace adapters and same stores | `routed` | Real S3/legacy read acceptance; retain offline Node compatibility tools |

### Production routing — 2026-09-10

The authorized guarded cutover activated release 0.16.0 at
`76e579f6887f3abcfe4cee45a4eaf3929c3ea6ae`. All four candidate services passed;
Node admission/claims were fenced and drained before Go activation, with Web
replaced last. Exact-image/runtime checks confirm Go-only routing and worker
ownership, retained stopped Node with restart disabled, unchanged database/
storage authority, and a verified private recovery snapshot. The
[cutover record](work-items/2026-09-10-go-production-cutover.md) separates passing
public/P2P/permission checks from pending authenticated/provider and full S3
acceptance. The preceding failed attempt exercised actual same-authority Node
recovery after schema and permission preparation.

This advances twelve rows from `parity` to `routed`, not `active` or `complete`.
It is not a claim that real OAuth, authenticated business flows, every S3 byte
or a sustained observation window passed. Keep Node images, code, tests,
offline operators and recovery until a separately validated later release.

### Candidate acceptance — 2026-09-09

At this historical acceptance, the twelve Go-target rows advanced from `planned` to `parity`, not
`routed`. Parent integration review accepted runtime source
`205f470f09852c9f36aeac37926b710e0f267940`, based on bounded luna-worker
implementation/review slices, the complete four-job
[CI run](https://github.com/timeStarry/duallane/actions/runs/34254215437), and
the exact-image disposable rehearsals in the
[final handoff](work-items/2026-09-08-predeployment-handoff.md). Maintainer PR
review/merge and all production transitions remain separate decisions.

Evidence includes actual Node-derived contract fixtures, Go unit/race/analysis
and full PostgreSQL integration, the complete Node/Go browser suites, native
media and legacy-object compatibility, single-runner schema coexistence, and
coordinated passive/activation/failure/upgrade/rollback tests. The handoff records
exact commands, coverage limits, image IDs, historical failures and unselected
optional cases. It is not a claim of exhaustive equivalence for every possible
input, real-provider interoperability or production observation.

No checked-in default production route, running writer, claimer or migration
owner changes with this acceptance. The Go candidate supports one P2P process
and the documented Workspace/worker topology; it is not scale-out evidence.
The [retained offline storage tools](STORAGE_OPERATOR.md#retained-offline-compatibility-tools)
remain Node compatibility operators, not running Go-service dependencies or an
implemented Go mutating backfill CLI. Do not remove them or legacy recovery
because a capability is now `parity`.

### Approval Baseline

The runtime baseline is repository commit `b6dd0c6`, the `origin/main` revision
from which this migration branch was created. At that revision:

- the Node backend registered 164 HTTP/WebSocket endpoints: 4 P2P, 3 browser
  authentication, 142 Workspace, 13 Bot Gateway, and 2 health/static endpoints;
- `apps/web/server/migrations` contained 29 immutable PostgreSQL migrations;
- `apps/web/server` contained approximately 28,000 lines across runtime services
  and routes, excluding tests;
- `pnpm test` passed 8 Agent SDK tests and 697 Web tests, with 2 Web tests
  skipped;
- `pnpm lint` and `pnpm build` passed; the existing Vite large-chunk warning
  remained non-blocking.

These counts are coverage checks, not architecture targets. A capability is
complete only when its behavior and invariants pass the gates in
[Backend validation](VALIDATION.md). Update this baseline only to correct an
error; record later scope changes in the capability ledger and their own PRs.

## 4. Migration Principles

- Use a strangler transition behind the existing Nginx origin.
- Migrate complete vertical capabilities, including transport, authorization,
  transaction, audit, event, storage/job effects, tests, routing, observability,
  and rollback.
- Keep one production writer for every command and database effect.
- Prefer read-only parity in disposable environments; do not mirror sensitive
  production content merely to compare implementations.
- Keep the current public paths, protocols, cookies, database, and object store
  unless a separately approved migration changes them.
- Use expand-contract schema changes compatible with every version in the
  rollout and rollback window.
- Do not route based on user identity or secret-bearing values. A canary uses a
  safe explicit operator mechanism or a complete low-risk path boundary.
- Remove legacy code only after the Go owner is stable, observable, documented,
  and independently testable.

## 5. Migration Phases

### Phase 0: Architecture And Baseline

- Approve this documentation suite.
- Inventory public routes, WebSocket frames, cookies, environment variables,
  migrations, database tables, object formats, and release behavior.
- Capture current correctness, privacy, concurrency, and resource baselines.
- Define the first slice acceptance criteria and rollback.

Exit: docs are linked from the mandatory agent path and no target component is
misrepresented as current.

### Phase 1: Go Foundation

- Create `apps/backend` with pinned Go module/toolchain and minimal command
  composition.
- Add repository-native build/test/lint/vulnerability commands and CI.
- Add safe config, logging, metrics, HTTP lifecycle, error, and test helpers only
  when used by the first slice.
- Introduce OpenAPI/JSON Schema incrementally and establish Node/Go parity
  fixtures.
- Add target image builds without changing production routes.

Exit: foundation gates pass; no production behavior has changed.

### Phase 2: P2P Private Lane

- Implement room, ICE/TURN projection, WebSocket lifecycle, secure-envelope
  validation, and transient relay.
- Prove the P2P privacy gate and two-browser critical flow.
- Extend Compose, Nginx, health checks, deployment candidates, and rollback.
- Route all P2P API/WebSocket traffic to the single Go P2P instance.

Exit: P2P is `active`; Node P2P remains rollback-only until final removal marks
the migration `complete`.

### Phase 3: Workspace Foundation And Reads

- Implement exact Workspace feature gating, PostgreSQL access, actor/session
  resolution, OAuth, invites, and safe errors.
- Migrate bootstrap and bounded read APIs in coherent authorization slices.
- Keep Node as writer where mutation slices are not yet migrated.
- Prove that mixed Node/Go releases read the same additive schema safely.

Exit: foundation/read capabilities are individually `active`; mutations remain
with their recorded owner.

### Phase 4: Workspace Core Mutations And Realtime

- Migrate membership/conversation/message commands with their transactions,
  idempotency, audit, and event rows.
- Implement Workspace WebSocket replay and PostgreSQL wake-up.
- Route a mutation only when its entire write unit has one Go owner.
- Validate reconnect, permission changes, event ordering, and process restart.

Exit: core chat and realtime capabilities are `active` with no cross-runtime
transaction.

### Phase 5: Files, Quota, Objects, And Media

- Migrate quota reservations, upload parts, completion/failure, download grants,
  logical objects, signed/local delivery, and cleanup.
- Prove local and S3-compatible object behavior and content-addressed races.
- Complete the govips compatibility gate before routing avatars/emotes.
- Retain Node/Sharp ownership for media until that independent gate passes.

Exit: each file/media capability is `active`, or a documented remaining Node
owner is explicit rather than hidden.

### Phase 6: Extended Workspace Domains

- Migrate topics, cards, interactions, Agent Bots, Bot gateway, Echo, and other
  extended domains as separate vertical slices.
- Preserve SDK assets, hashes, rate limits, grants, revisions, and workflow
  safety.

Exit: all request-serving Workspace capabilities are `active` in Go.

### Phase 7: Workers And Migration Ownership

- Move email, ntfy, Bot deliveries, cleanup, and reconciliation only after job
  lease and current-eligibility parity.
- Resolve cross-process presence before moving presence-dependent suppression.
- Switch migration ownership after clean-bootstrap and existing-database upgrade
  rehearsals.

Exit: worker and migration commands are `active`; no Node background loop can
claim the same job.

### Phase 8: Final Cutover And Documentation Conversion

- Remove Node API routes, workers, server dependencies, image, and obsolete test
  doubles only after every capability is `active` and rollback no longer needs
  them.
- Update Compose, deployment restoration, version checks, backups, runbooks,
  README, and release notes for the final service set.
- Run the full validation and production rollback rehearsal.
- Convert the backend index from target wording to current architecture wording.

Exit: every backend migration is `complete`; this documentation suite is the
active backend handbook.

## 6. Slice Cutover Checklist

Every migration slice records:

1. Observable behavior and explicit non-goals.
2. Trust lane and current/target owner.
3. Data read/write set and transaction boundary.
4. External HTTP/WebSocket/cookie/event/SDK compatibility.
5. Authorization, quota, audit, retention, idempotency, and failure effects.
6. OpenAPI/JSON Schema plus characterization fixtures.
7. Focused unit, PostgreSQL, concurrency, privacy, and end-to-end evidence.
8. Compose/gateway route, health, metrics, log review, and pool/resource impact.
9. Deployment order, compatibility window, observation signal, and rollback.
10. Ledger update from `planned` to `parity`, `routed`, `active`, `complete`, or
    back to the prior safe state.

The PR must not bundle unrelated cleanup or advance multiple high-risk slices
that cannot be rolled back independently.

## 7. Status Transitions

```text
planned -> parity -> routed -> active -> complete
                 \-> planned (candidate abandoned)
routed/active -> prior active owner (tested rollback only)
```

- `planned -> parity` requires executable contract and disposable-environment
  evidence.
- `parity -> routed` requires production route changes, candidate health,
  security review, and tested rollback.
- `routed -> active` requires the observation window and removal of legacy
  routing/claiming for that capability.
- `active -> complete` requires removal or archival of legacy-only
  dependencies/tests/docs and the end of legacy rollback support.

Do not mark a status based on intent, code completion alone, or an unexecuted
test plan.

## 8. Rollback Rules

Rollback restores a single known-good owner. It never enables both writers.
Before routing back, verify that the old implementation can read the current
schema, stored rows, object format, event cursor, and pending jobs.

If the schema is forward-compatible, restore the gateway route/application image
and leave the database in place. Database restore is a separately authorized
recovery action because it can discard valid writes. Record routed duration,
affected capabilities, possible external duplicate effects, and reconciliation
required.

## 9. Documentation Conversion At Completion

Final cutover is incomplete until documentation reflects the new current state:

- `docs/backend/README.md` states that the Go architecture is current and routes
  all backend tasks directly to its durable guides.
- `docs/development/ARCHITECTURE.md`, `CODE_STANDARDS.md`,
  `TESTING_AND_RELEASE.md`, `README.md`, and root `AGENTS.md` remove obsolete
  Node/Fastify ownership while preserving historical compatibility notes only
  where operationally necessary.
- Architecture, technology, boundaries, contracts/data, operations, validation,
  and Agent guidance remain canonical support documents.
- This file retains the completed ledger and phase history, then governs future
  service, dependency, protocol, persistence, and topology changes using the
  same explicit status and compatibility process.
- Obsolete migration-only commands and examples are deleted in the same PR that
  removes their implementation.

## 10. Future Architecture Change Record

After migration, a change that adds a service, shared dependency, persistence
category, protocol version, horizontal coordination mechanism, or production
topology must append a short decision record here or link a focused decision
document. Record context, decision, alternatives, trust/data impact,
compatibility, rollout, validation, observability, and rollback.
