# Schema 034 Compatibility Bridge

## Decision and authorization

The maintainer accepted production 0.16.1 and authorized subsequent releases
and removal of the old Node backend in this task. Production remains Go-only.
Node retirement is a separate change after the feature release; this bridge
does not delete production data, objects, migration history, backups or images.

PR #8 (`4f426772953760bb58b3c252072aa9bb10409040`) introduced additive
`034_workspace_chat_auto_hide.sql`. Preflight stopped before any production
migration: 0.16.1 requires exactly migrations 001–033 and rejects 034 during
startup, readiness and worker pre-claim checks. SQL-column compatibility alone
is not a valid old-image rollback claim.

## Release sequence

1. Temporarily defer the unshipped PR #8 feature set through a reviewable revert
   on a new branch from `origin/main`; preserve its commits for reapplication.
2. Ship 0.16.2 with the existing schema 33 and user behavior. Its read-only schema
   checker explicitly accepts the reviewed future 034, but no arbitrary future
   migration. The migration runner remains strict and does not apply 034.
3. After 0.16.2 is healthy and its private Go recovery snapshot is verified,
   reapply PR #8 in a separate PR as 0.17.0, keeping the compatibility changes.
   Validate the exact bridge against schema 34 and rehearse Go application
   rollback with the same disposable database before production migration.
4. Publish the independently reviewed Node-retirement release after 0.17.0
   passes its deployment checks. Preserve SQL, shared assets, SDK and any
   offline operator lacking an accepted replacement until it is migrated.

This explicitly approved prerequisite replaces the unshipped 0.17.0 preparation
temporarily; it does not create parallel pending product versions or rewrite
published Git history. Public release notes describe only available behavior.

## Compatibility contract

An immutable, embedded JSON policy names the baseline final migration and each
reviewed compatible future migration with its exact SQL SHA-256. This release
contains only the 033-to-034 exception. Workspace and worker opt into this
policy; generic schema checks and migration execution remain strict. Required
migrations can never be skipped. Unknown, duplicate, malformed or renamed
history remains rejected. No environment variable can add an exception.
When 034 is recorded, read-only metadata checks also require both added columns
with their reviewed type, nullability and defaults. The fixture is outside the
canonical migration directory, so the bridge cannot apply it accidentally.

The guarded Go-upgrade preflight compares the actual old/new immutable images'
canonical SQL inventories and the old image's compatibility policy **before
running migrations**. Identical history requires identical SQL bytes. Every
added migration must be explicitly declared with matching bytes by the old
image; missing or changed migrations and unsupported policy fail closed. A
legacy image with no policy can only support identical schema. Image inspection
is network-free, read-only, bounded and receives no database or provider
credentials. It never executes business startup hooks.

The normal production checkout, expected-commit, private recovery artifacts,
single-writer fencing/drain, passive candidates and gateway-last activation
remain mandatory. The bridge does not introduce down-migrations, automatic
database restoration, snapshot edits, or a permission bypass.

## Ownership and validation

The lead owns command wiring, Docker packaging, release-helper integration,
version/fixture updates, split commits, review, PRs and production activation.
Bounded luna-workers own the read-only schema policy and its focused tests,
the image compatibility verifier and its tests, and a separate Node-retirement
inventory. Workers do not modify the shared Git index or deployment state.

Required evidence: strict/default and opted-in schema checks; actual PostgreSQL
33/34 compatibility and old-query preservation; missing/unknown/corrupt cases;
image inventory/SQL hash and fail-before-migration tests; full applicable Go,
Node/frontend and browser gates; exact-image build and Go rollback rehearsal.
Only synthetic data may enter tests. Deployment and completion evidence is
added after the corresponding operation succeeds, never inferred from code.

## Current validation record

Validation uses an isolated Linux-native copy under WSL Ubuntu 24.04 with
Go 1.26.8, Node 22.23.2, pnpm 10.30.3 and libvips 8.15.1. It is not the
production checkout. Current completed checks:

- Frozen/offline dependency installation, `pnpm test` (SDK 8 passed; Web 734
  passed, 2 explicitly PostgreSQL-only cases skipped), `pnpm lint` and
  `pnpm build`. The existing Vite large-chunk warning remains.
- Actual Node release fixture regeneration/check (9 catalog versions) and
  Workspace core regeneration/check (29 scenarios, 32 routes); only synthetic
  fixtures are committed, not private runtime data.
- `make -C apps/backend verify`: generation freshness, unit/race tests, vet,
  staticcheck, vulnerability reachability and command builds. The vulnerability
  scan reports no reachable findings; uncalled dependency findings are not a
  claim that every transitive dependency is vulnerability-free.
- Release activation/rollback/cleanup unit suites: 77 passed (including rerun
  after integration hardening); the extracted real pre-migration gate now has
  7 passing cases, including authority/record failures and proof invalidation.
  Runtime asset packaging passed. Bash syntax and diff whitespace checks passed.
- Full `make -C apps/backend integration-postgres` passed on disposable
  PostgreSQL 17. After the worker's final test edits, the lead independently ran
  migration-package unit/race/PostgreSQL tests and tagged vet: passed. Cases
  include real old Go preference upserts preserving 034 columns, missing/default
  drift, undeclared 035 and a strict migration-runner refusal on 034 history.
- `pnpm test:e2e:workspace-go`: 18 passed against the actual Go server, including
  two-user chat, group, file, unread and reconnect flows. No production content
  or real-provider notifications are used.
- Image-verifier unit tests: 18 passed; combined with the migration gate and
  packaging checks, the final focused suite passed 26 cases. Actual old Workspace image
  `sha256:e7828cbd42627a3e4607744d13ca9ae9909d21ec2ef016ba5b33cfd8003b6853`
  inspected against itself: 33/33 identical migrations accepted without a
  policy. This is an inspection check, not the pending target-image rehearsal.

Local unsuccessful invocations are not passing evidence: a
release-test invocation omitted Node from child Bash's PATH (rerun passed all
77), the first browser launch found the owned disposable PostgreSQL stopped,
and a focused PostgreSQL rerun encountered the same stop/startup interval.
The WSL fixture needs a foreground owner while validations run; the lead
verified its exact container ID/label, restored only that fixture, waited for
readiness, and reran successfully. No production container was touched.

Target immutable-image/recovery rehearsal, PR CI and production activation
results are still pending at this point.
