## Purpose

<!-- What user/operator problem does this solve? Link the issue when available. -->

## Changes

<!-- Describe observable behavior and important implementation decisions. -->

## Scope And Non-Goals

<!-- Name affected trust lane(s), modules, and behavior deliberately left out. -->

## Risk Review

- [ ] P2P plaintext and files remain unpersisted by the server.
- [ ] Workspace remains disabled unless `WORKSPACE_ENABLED=true` exactly.
- [ ] Authentication and resource-level authorization are preserved.
- [ ] Quota, retention, idempotency/concurrency, and audit behavior were reviewed.
- [ ] Logs, errors, screenshots, fixtures, and the diff contain no secrets or
      unnecessary private content.
- [ ] API, event, database, storage, and client compatibility were reviewed.
- [ ] Not applicable items are explained below.

Risk notes:

<!-- Explain relevant threats, failure modes, migrations, and mitigations. -->

## Validation

<!-- List exact commands and results. Do not mark a check that was not run. -->

- [ ] Focused regression tests
- [ ] `pnpm test`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] PostgreSQL integration tests, when required
- [ ] `docker compose config` and affected image build, when required
- [ ] Playwright flow, when required

Not run or remaining environment-dependent validation:

## UI/UX Evidence

<!-- For visible changes: attach desktop and 390x844 evidence and cover loading,
empty, success, error, disabled, long-content, keyboard, and focus states. -->

## Migration, Release, And Rollback

<!-- Include config changes, data migration, release notes, rollout health checks,
and rollback. Write "Not applicable" with a reason when none are needed. -->

## Merge Authorization

- [ ] I understand that only GitHub user **`timestarry`** may perform the final
      merge into `main`; this PR does not authorize deployment.
