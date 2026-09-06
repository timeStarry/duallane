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
