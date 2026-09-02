# Testing And Release

## 1. Validation Matrix

Run focused tests while iterating, then the complete gate for the highest-risk
part of the change.

| Change | Required before PR is ready |
| --- | --- |
| Documentation only | `git diff --check`; validate local links and executable examples |
| Frontend behavior or styling | focused Vitest/Playwright coverage, `pnpm lint`, `pnpm build`, desktop and 390×844 visual review |
| Service or API logic | focused regression tests, `pnpm test`, `pnpm lint` |
| P2P, Workspace, auth, quota, audit, database, storage, realtime, or deployment | `pnpm test`, `pnpm lint`, `pnpm build`, plus focused failure/concurrency coverage |
| PostgreSQL-sensitive behavior | the above plus `pnpm --filter @duallane/web test:postgres` with a disposable `TEST_DATABASE_URL` |
| Docker, Nginx, Caddy, or Compose | the above plus `docker compose config` for affected profiles and build the affected image |
| User-critical end-to-end flow | focused Playwright flow; full `pnpm test:e2e` when shared chat/auth/navigation behavior changes |

If a required environment is unavailable, do not report the gate as passed. Say
exactly what was not run, why, and what remains for the PR owner or CI.

## 2. Test Layers

- Unit tests cover parsers, projections, state transitions, and pure policy.
- Service tests cover authorization, transactions, quotas, audit, idempotency,
  concurrency, storage reference behavior, and event targeting.
- Route tests cover authentication, boundary validation, public status/error shape,
  disabled Workspace behavior, and safe projection.
- PostgreSQL tests cover SQL, constraints, locks, migrations, and behavior the
  SQLite test double cannot prove.
- Component tests cover render states, interaction, keyboard/focus, retry, and
  Strict Mode lifecycle.
- Playwright covers complete user-visible flows, responsive layout, integration
  boundaries, and regressions that depend on real navigation or browser behavior.

Prefer the lowest layer that proves the behavior, but keep one end-to-end path for
critical contracts.

## 3. Browser Tests

Install the repository browser once:

```bash
pnpm exec playwright install chromium
```

Run all or a focused specification:

```bash
pnpm test:e2e
pnpm exec playwright test e2e/workspace-agent-bot.spec.ts --project=chromium
```

Replace the focused spec path with the flow being changed.

Playwright starts isolated API and Vite services with a temporary SQLite Workspace
test database. When another process owns the defaults, assign non-conflicting
ports with `E2E_API_PORT` and `E2E_WEB_PORT`; do not terminate an unknown process.

Tests wait on observable state or responses, not arbitrary sleeps. Capture traces
or screenshots only when useful, remove personal data, and keep generated output
untracked.

## 4. Database And Migration Verification

For a migration or data tool, prove:

- clean bootstrap and upgrade from the oldest supported schema state;
- correct constraints, indexes, foreign keys, and default values;
- idempotent retry or an explicit stable refusal;
- rollback of application transactions and forward recovery for migrations;
- concurrent behavior under PostgreSQL when locks or unique constraints matter;
- bounded, resumable backfill with progress and private reporting;
- application compatibility before, during, and after cleanup.

Use a disposable database. Never point tests, migration rehearsals, or cleanup
tools at production without a separately approved operator plan.

## 5. Version And Release Notes

- Keep root and Web package versions aligned for a product release. Version the
  Agent SDK independently only when its published contract changes.
- Follow semantic intent: patch for compatible fixes/refinement, minor for
  backward-compatible capability, major for an approved compatibility break.
- Add the user-facing release entry in the existing release data and update any
  Echo release guidance in the same PR.
- Release notes describe new features, settings, behavior changes, migration or
  operator action, and where the user can find each capability. Do not merely copy
  commit summaries.
- Update public Agent Skill manifests, hashes, cache metadata, SDK docs, and
  compatibility tests when their content or protocol changes.

## 6. Pre-Merge Checklist

1. Rebase or merge current `origin/main` according to maintainer direction.
2. Review the final diff and untracked files for secrets, debug code, generated
   output, unrelated edits, and accidental asset changes.
3. Run the validation matrix and record exact results in the PR.
4. Verify migrations, configuration defaults, compatibility, rollout, health
   checks, and rollback for the affected surface.
5. Verify UI evidence and accessibility for visible changes.
6. Ensure docs, API/event contracts, release entries, and version files agree.
7. Obtain review. Only `timestarry` performs the final merge into `main`.

Merge does not authorize deployment. Deployment begins only on explicit operator
instruction after the intended commit is on `origin/main`.

## 7. Production Deployment On This Host

Development, validation, commit, and push happen only in:

```text
/home/timestarry/projects/duallane
```

Production deploys happen only in:

```text
/home/timestarry/duallane
```

Use the local Docker daemon; do not SSH or SCP for this host. After validation,
merge authorization, commit, and push:

```bash
cd /home/timestarry/duallane
git pull --ff-only
release_commit="$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "${release_commit}"
bash deploy/production/deploy.sh --expected-commit "${release_commit}"
```

The production `.env` must keep
`DUALLANE_PRODUCTION_DIR=/home/timestarry/duallane`. Never run the production
script from the development checkout and never substitute a bare
`docker compose up` for an existing production deployment.

The guarded script must build/start candidates, confirm API and Web health, then
replace the running application. If Docker must restart, record all running
application containers first and restore them afterward.

## 8. Health Check And Rollback

After deployment, verify the deployed commit/version, public Web response, API
health, authentication boundary, Workspace enabled/disabled expectation, static
assets, WebSocket connection, and the critical changed path. Inspect redacted logs
for migration, storage, and startup errors.

Rollback uses the repository's guarded deployment procedure and a known-good
compatible commit/image. Before rollback, check schema and data compatibility;
never revert code across a destructive migration blindly. Record the reason,
affected interval, data implications, and follow-up fix in the release issue.

Operator-specific details remain in `README.md` and runbooks under `deploy/` and
`docs/`; this document defines the required engineering gate.
