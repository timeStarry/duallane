# DualLane Agent Guide

This file is the mandatory entry point for humans and coding agents working in
this repository. It contains the rules that must always be loaded; detailed
guidance is disclosed through the links below only when the task needs it.

## Start Every Task

1. Read this file and [the development index](docs/development/README.md).
2. Read `README.md`, `DESIGN.md`, and the smallest relevant product or protocol
   document before editing.
3. Inspect `git status`, the current branch, and nearby tests. Existing changes
   belong to their author; do not overwrite or revert them.
4. State the observable behavior, trust lane, data impact, compatibility needs,
   and required validation before broad changes.
5. Prefer the existing local pattern. Add a new abstraction or dependency only
   when it removes demonstrated complexity.

When instructions conflict, preserve security and data invariants first, then
follow this file, the detailed development standards, domain design documents,
and finally historical implementation patterns. Code and tests describe current
behavior, but do not override higher-level safety requirements.

## Non-Negotiable Invariants

- DualLane has two trust lanes: the P2P private lane and the audited Workspace
  relay lane. Never blur their storage or privacy promises.
- P2P message and file content must not be persisted by the server. P2P server
  code may relay only validated secure envelopes, never plaintext chat payloads.
- Invite-link `#k=` fragments are browser-only secrets and must never be sent to
  backend APIs, telemetry, logs, or rendered server pages.
- Workspace is disabled unless `WORKSPACE_ENABLED=true` exactly.
- Workspace changes must preserve server-side authorization, quota enforcement,
  message retention, idempotency/concurrency behavior, and audit logging.
- Reject upload overages before accepting the transfer. Rejected sensitive
  operations must create content-free audit records where the domain requires it.
- Do not weaken Fastify redaction, response security headers, secret handling, or
  object access control without a written threat analysis and maintainer approval.
- Do not modify imported emote assets unless the task is specifically about them.

Read [Security and data](docs/development/SECURITY_AND_DATA.md) before changing
authentication, authorization, P2P, Workspace persistence, uploads, quotas,
notifications, audit, logs, or deployment configuration.

## Task Routing

| When the task involves | Read before implementation |
| --- | --- |
| Branches, bugs, commits, reviews, or pull requests | [Workflow](docs/development/WORKFLOW.md) |
| Module ownership, dependencies, API boundaries, migrations | [Architecture](docs/development/ARCHITECTURE.md) |
| TypeScript, React, Fastify, SQL, events, CSS, tests | [Code standards](docs/development/CODE_STANDARDS.md) |
| Layout, components, copy, responsive behavior, accessibility | [UI/UX standards](docs/development/UI_UX_STANDARDS.md) and the linked Workspace visual specifications |
| Validation, versions, release notes, Docker, production | [Testing and release](docs/development/TESTING_AND_RELEASE.md) |
| Workspace product or protocol behavior | [Workspace design index](docs/WORKSPACE_DESIGN_INDEX.md) |
| P2P product behavior | [P2P product design](docs/O2O_PRODUCT_DESIGN.md) and `DESIGN.md` |

## Branches, Commits, And Pull Requests

- Never develop directly on `main`. Start a short-lived branch from the latest
  `origin/main` and keep unrelated changes in separate branches.
- Use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `release/`
  followed by a short kebab-case topic. Codex-created branches use `codex/`.
- Commits must be reviewable, buildable units with imperative summaries. Do not
  mix generated files, formatting churn, or unrelated cleanup into a feature.
- Every change to `main` goes through a pull request. Only GitHub user
  **`timestarry`** is authorized to perform the final merge into `main`.
- Authors and agents may prepare, update, review, and validate a PR, but must not
  bypass review, branch protection, or the maintainer's merge decision.
- Bug fixes require a reproducible case, a root-cause explanation, and a focused
  regression test unless a test is technically impossible and the PR says why.

The complete lifecycle and PR contract are in
[Workflow](docs/development/WORKFLOW.md). Use the repository PR template.

## Implementation Discipline

- Keep edits inside the owning module and behavioral surface. Avoid opportunistic
  refactors in the same change.
- Preserve public API and persisted-data compatibility unless the change includes
  a documented migration or version transition.
- Keep routes thin, domain rules in services, and persistence details behind the
  database or storage boundary. Validate and authorize on the server.
- Treat retries, duplicate delivery, concurrent writes, stale revisions, aborted
  requests, and partial failure as normal cases for state-changing operations.
- Frontend effects must tolerate React Strict Mode setup/cleanup. Realtime events
  and optimistic updates must be idempotent.
- Reuse the shared conversation, composer, message, feedback, and settings
  patterns. Do not fork behavior that users expect to be consistent.
- Comments explain non-obvious constraints, not line-by-line mechanics.
- Keep UI copy consistent with implemented privacy and security guarantees.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Run the smallest relevant check while iterating, then the required gate from
[Testing and release](docs/development/TESTING_AND_RELEASE.md). Do not claim a
check passed unless it completed in the current worktree.

## Definition Of Done

A change is complete only when:

- acceptance behavior and non-goals are explicit;
- relevant security, privacy, data, quota, audit, and accessibility effects were
  reviewed;
- implementation and migration paths are backward compatible or documented;
- focused regression tests cover the changed behavior;
- the required validation matrix passes;
- user-facing behavior, configuration, API contracts, and release notes are
  updated where applicable;
- the diff contains no secrets, unrelated edits, debug code, or avoidable churn;
- the PR explains risks, evidence, rollout, and rollback.

## Production Deployment

- Use `/home/timestarry/projects/duallane` only for development, validation,
  commits, and pushes.
- Deploy production only from the local checkout at `/home/timestarry/duallane`.
  Use the local Docker daemon. Do not use SSH or SCP for this deployment.
- Validate, commit, and push first. In the production checkout, use
  `git pull --ff-only`, verify the exact `origin/main` commit, then run
  `deploy/production/deploy.sh` with `--expected-commit`.
- Never run that script from the development checkout and never replace an
  existing production deployment with a bare `docker compose up`.
- Keep `DUALLANE_PRODUCTION_DIR=/home/timestarry/duallane` in production `.env`.
- Candidate API and Web containers must be healthy before replacement. If Docker
  must restart, record and restore every application container that was running.

The full release and rollback procedure is in
[Testing and release](docs/development/TESTING_AND_RELEASE.md).
