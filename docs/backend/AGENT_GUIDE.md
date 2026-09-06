# Backend Development Agent Guide

## 1. Purpose

This guide turns the backend architecture into an executable task workflow for
human contributors and development agents. It supplements root `AGENTS.md`; it
does not replace security, product, protocol, workflow, or release documents.

It is for humans and coding/development agents that inspect, edit, test, review,
and hand off repository changes. It is not an instruction source for product
Agent Bots. A product Agent Bot is a runtime Workspace integration that uses the
Bot Gateway/SDK, Bot authentication, and explicitly granted context to serve an
end-user workflow. Bot Gateway credentials grant only the capabilities defined
by that product contract, not repository, deployment, or migration ownership
authority. Any separately provided development tools require their own explicit
authorization. Keep Bot behavior and privacy promises in the Agent Bot
contracts; distinguish product Bots from development agents in task assignments.

## 2. Mandatory Intake

Before a backend edit:

1. Read root `AGENTS.md` and `docs/development/README.md`.
2. Read `README.md`, `DESIGN.md`, and the smallest affected lane/product
   contract.
3. Read `docs/backend/README.md` and the capability ledger in `EVOLUTION.md`.
4. Inspect the current branch, `git status`, active implementation, nearby
   tests, Compose route, and migration/schema state.
5. State observable behavior, non-goals, trust lane, data impact, compatibility,
   validation, rollout, and rollback before a broad change.

Do not assume Go owns a capability because a target document or candidate
package exists. The ledger and actual route/job claimant must agree.

For a small documentation or test-only change, use a short working note. For a
migration, cutover, cross-process change, or parallel task, the optional
[work-item and handoff record](templates/WORK_ITEM.md) captures ownership and
evidence for the next contributor.

## 3. Interpret Capability Status

| Status | Normal edit target |
| --- | --- |
| `planned` | Active Node/retained owner; Go work only inside an approved migration slice |
| `parity` | Candidate Go code and parity tests; production behavior remains with current owner |
| `routed` | Go owns production traffic and is the only writer for mutations; legacy changes are rollback compatibility only |
| `active` | Go or retained infrastructure is canonical; legacy code may remain only for tested rollback |
| `complete` | Go is canonical and legacy code/rollback dependencies are removed; do not restore them without a new approved architecture decision |

If code, routes, workers, and ledger disagree, stop the mutation, preserve
security/data invariants, and report the mismatch. Do not fix the ledger to match
an accidental route or vice versa without reviewing rollout and rollback.

## 4. Read By Change

| Change | Read |
| --- | --- |
| Go dependency, framework, module, or package layout | Technology, Service boundaries, Evolution |
| P2P room/ICE/WebSocket | Architecture, Service boundaries, Contracts/data, Validation, P2P product design, security guide |
| Workspace HTTP or authorization | Service boundaries, Contracts/data, Validation, owning Workspace API/product docs, security guide |
| Message/event/realtime | Architecture, Contracts/data, Validation, message and realtime protocols |
| Database transaction/migration | Contracts/data, Evolution, Validation, data model, testing/release guide |
| Quota/upload/storage/media | Technology, Contracts/data, Validation, file/quota design, storage runbook, security guide |
| Worker/delivery/reconciliation | Service boundaries, Contracts/data, Operations, Validation, owning notification/Bot docs |
| Container/gateway/deployment | Operations, Evolution, Validation, testing/release guide |

Read the target file and tests after this routing set. Avoid loading every
Workspace product document for a narrow capability.

This is the minimum context route, not a requirement to read the whole
repository. After a capability becomes `active` or `complete`, continue to use
the same route based on its current owner and changed surface; post-cutover work
still reads the current architecture, contract, security, and validation
guidance that applies. `EVOLUTION.md` remains the source for compatibility
history and later ownership changes.

For generated SQL, inspect `apps/backend/sqlc.yaml` and the owning `queries.sql`.
Keep generated bindings behind that domain's nested `internal` boundary; never
call them across domains or hand-edit the generated files. Run `make generate`,
`make check-generated`, and the relevant PostgreSQL/race tests. Generation
checks types and freshness, not authorization or transaction correctness.

## 5. Pre-Edit Contract

Write a compact task contract in the issue/PR or working update:

```text
Behavior:
Non-goals:
Trust lane:
Current owner/status:
Data read/write set:
Transaction/idempotency/concurrency:
Public compatibility:
Security/audit/logging:
Validation:
Rollout and rollback:
```

A missing answer is a design gap. Resolve it before introducing another service,
table, dependency, protocol, or cross-process call.

For a tiny docs or test change, a one-line behavior/scope/check note is sufficient
when no runtime, data, ownership, or rollout contract changes.

## 6. Go Implementation Rules

- Keep `cmd/*` as composition and lifecycle only.
- Keep HTTP/WebSocket handlers thin and use standard HTTP types.
- Put authorization, domain validation, transaction, audit intent, and event/job
  intent in the owning application/domain operation.
- Use explicit constructors; do not use service locators, package-level mutable
  dependencies, or a dependency injection framework.
- Use `context.Context` as the first parameter for request/database/storage/
  delivery operations. Do not store a context in a long-lived struct.
- Bound request bodies, WebSocket frames, streams, external calls, worker batches,
  retries, image processing, and shutdown waits.
- Use `errors.Is`/`errors.As` with typed domain errors projected once at the
  transport boundary. Do not expose underlying SQL/provider errors.
- Prefer immutable value inputs and explicit result types. Avoid untyped maps at
  domain boundaries except for deliberately versioned JSON payloads.
- Use pgx/sqlc repositories and explicit transactions. No ORM or SQL in handlers.
- Keep generated files identifiable and reproducible; never hand-edit generated
  output.
- Add a dependency only when the standard library and selected stack cannot
  reasonably satisfy the requirement. Record license, maintenance, security,
  image, and migration impact.

## 7. Trust-Lane Checks

For P2P work, prove the service still has no database/object/job dependency and
that only validated secure envelopes are relayed transiently. Never add request
body/frame logs for diagnosis.

For Workspace work, prove authentication and current resource authorization in
the service, exact feature gating, quota-before-transfer, content-free rejection
audit, transaction/event consistency, retention, object access control, and safe
error/log projection.

Shared platform helpers must be neutral. If a helper understands room payload,
membership, Bot scope, quota, audit, or object visibility, move it into the
owning domain instead of `platform` or `common`.

## 8. Migration Slice Rules

- Characterize before rewriting.
- Implement and test one vertical capability at a time.
- Do not dual-write, mirror production content, or split one transaction across
  Node and Go.
- Preserve current schema/object compatibility; use additive migrations.
- Add candidate health and rollback before changing the edge route.
- Update the capability ledger in the same PR that changes production ownership.
- Move or recreate required tests with the new owner before deleting legacy
  tests.
- Keep rollback-only legacy code frozen except for compatibility/security fixes.

## 9. Validation And Review

Run the smallest focused test while iterating and the complete gate required by
[Backend validation](VALIDATION.md) and the development release matrix. Record
exact commands, current-worktree results, environment-dependent omissions, and
manual evidence.

Review the final diff for:

- secrets, raw content, signed URLs, query/body logging, and unsafe metrics
  labels;
- accidental P2P persistence or Workspace authorization movement;
- unbounded input, network waits, goroutines, queues, retries, and shutdown;
- duplicate writers, job claimers, migration runners, or gateway routes;
- schema/contract incompatibility with rollout and rollback versions;
- generated or formatting churn and unrelated cleanup;
- imported emote asset changes.

A worker's summary is a handoff, not independent proof. The lead or named
integrator inspects the actual worktree diff and changed paths, checks that the
no-touch scope was preserved, and runs the validation needed to accept the
change. `not run`, `blocked`, and `failed` remain distinct from `passed`.

## 10. Parallel Work, Review, And Handoff

Parallel work is an execution choice, not a change to architectural ownership.
The lead coordinates trust-lane, data, compatibility, and architecture decisions
within the approved task scope, obtaining maintainer approval where required.
It owns task decomposition, dependency order, integration, independent
validation, final deliverables, and serialized split commits. A development
worker owns only its bounded assignment and must escalate a contract or
ownership conflict instead of widening its scope.

When a `luna-worker` is available in the current Codex task environment, the
lead should prefer it for a bounded, disjoint file/module assignment. Worker or
model availability is task-local; this guide does not promise a worker, model,
plugin, or tool in a future run. Development authority must be explicitly
assigned; a Workspace Bot credential is not such an assignment.

Before starting parallel work, the lead records or states:

1. the capability, current and target owner/status, trust lane, and data impact;
2. observable acceptance behavior and explicit non-goals;
3. the exact read set, write set, and no-touch set for each worker;
4. dependencies, contract decisions, required predecessor outputs, and the
   handoff artifact each worker must return;
5. the validation commands/evidence and commit boundaries; and
6. the rollout owner and authorization required before a route, writer, job
   claimer, migration runner, or production setting changes.

Do not start a worker until those dependencies and handoff expectations are
clear. If a dependency changes, pause the affected work and update the contract;
do not resolve it by overlapping edits.

### Disjoint Scope And Single Writers

Independent work may proceed when the file/module scopes do not overlap and the
dependency graph permits it. Reserve shared integration surfaces to one named
integrator for the task, including:

- `cmd/*` composition and lifecycle wiring;
- shared router or gateway route tables;
- `go.mod`/`go.sum` and other shared dependency manifests;
- database schema, migrations, and shared generated contract outputs; and
- repository or backend index files, including `docs/backend/README.md`.

Other workers may read these files or return a proposed hunk, but must not edit
them concurrently. Parallel workers must also have disjoint domain ownership:
one capability write unit has one active implementation owner for each writer,
claimer, scheduler, or migration role. That implementation may run approved
replicas, such as multiple Go workers with leases; replicas are not a second
owner. Do not introduce Node/Go dual writes or uncoordinated claimers/runners for
the same role. Read-only characterization and independent tests may run in
parallel when they cannot mutate the same state.

### Shared-Tree Integration

Never run concurrent Git index operations in a shared worktree. Workers leave
the shared index untouched: no `git add`, commit, interactive staging, branch
switch, reset, cleanup, or equivalent operation. The lead/integrator inspects
the actual diff, stages exact paths, and serializes reviewable split commits.
Broad staging is not a substitute for file ownership. Before accepting a worker
claim, the lead verifies `git status`, the diff for the assigned paths, the
no-touch paths, and the focused checks independently; a claimed pass without a
current result is not accepted as evidence.

### Required Handoff

Each worker returns the exact changed paths, contract decisions, data/schema or
object effects, tests/checks run with their results, checks not run and why,
active processes or secret references (never credential values), and remaining
risks/blockers. The lead reviews that handoff against the actual diff and
acceptance criteria before
integrating it. A handoff does not authorize rollout or production ownership;
the lead records the authorized operator and status transition separately.

## 11. Documentation Updates

Update the owning canonical document rather than copying its rule elsewhere:

- topology or consistency: `ARCHITECTURE.md`;
- dependency/technology: `TECHNOLOGY.md`;
- ownership/import boundary: `SERVICE_BOUNDARIES.md`;
- protocol/data/security mechanics: `CONTRACTS_AND_DATA.md`;
- container/config/release behavior: `OPERATIONS.md`;
- required evidence: `VALIDATION.md`;
- current owner, phase, or cutover: `EVOLUTION.md`.

Root and development indexes receive links and short routing rules only. Update
product documents when user behavior changes; backend docs do not override the
product contract.

## 12. Handoff Template

Use the compact block below for routine work. For a migration, cutover,
parallel assignment, or handoff with compatibility/rollout risk, use the
[optional task and handoff record](templates/WORK_ITEM.md).

```text
Capability and status:
Observable result:
Files/modules changed:
Data/schema/object effects:
Security and trust-lane review:
Compatibility evidence:
Tests and exact results:
Deployment/route status:
Rollback path:
Remaining risks or gates:
```

Do not claim completion while required gates, route changes, status updates, or
rollback evidence remain outstanding.
