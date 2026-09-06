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

## 3. Initial Capability Ledger

This ledger reflects the repository at approval of the target architecture.
Update it in every cutover or rollback PR.

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
| Static Web and edge gateway | Nginx/Web image | Nginx/Web image | `active` | Add target upstreams without weakening headers/logging/body limits |
| P2P room, ICE, and secure WebSocket relay | Node API | Go P2P | `planned` | Scaffold, parity tests, privacy gate, candidate route |
| Workspace feature gate and health | Node API | Go Workspace | `planned` | Exact disabled behavior and release-health contract |
| GitHub OAuth and Workspace sessions | Node API | Go Workspace | `planned` | Cookie/redirect/crypto/session parity and security review |
| Workspace read APIs | Node API | Go Workspace | `planned` | OpenAPI characterization and authorization projection parity |
| Workspace conversation/message mutations | Node API | Go Workspace | `planned` | PostgreSQL transaction/idempotency/audit/event parity |
| Workspace realtime WebSocket | Node API | Go Workspace | `planned` | Persisted replay plus notification-loss and permission tests |
| Quota, upload/download, and object registry | Node API | Go Workspace | `planned` | Concurrent quota/storage/reference and rollback evidence |
| Avatar and custom-emote processing | Node/Sharp | Go Workspace/govips | `planned` | Conditional media compatibility gate |
| Topics, cards, interactions, Agent Bots, and Echo | Node API | Go Workspace | `planned` | Capability-by-capability contract and workflow safety parity |
| Email, ntfy, Bot delivery, cleanup/reconciliation | Node API workers | Go Worker | `planned` | Durable lease, eligibility, retry, presence, and provider tests |
| PostgreSQL migration and seed runner | Node migrate command | Go migrate | `planned` | Existing history/bootstrap/upgrade compatibility |
| PostgreSQL database | PostgreSQL 17 deployment | PostgreSQL deployment | `active` | Preserve authoritative volume, backup, and supported upgrade path |
| Local/S3 content-addressed storage | Node adapters and current stores | Go Workspace adapters and same stores | `planned` | Cross-implementation object compatibility and recovery tests |

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
