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

## Completed image, CI and production evidence

[PR #9](https://github.com/timeStarry/duallane/pull/9) was normally merged by
`timeStarry` after verification. Tested head
`8aaa934f81c3e879958f6116b8130be00d1b73f1` and merge
`c15d5569ccc5f8a169b3ef2e8e6952c76e84b1fd` have identical trees.
The [four-job CI run](https://github.com/timeStarry/duallane/actions/runs/34446951547)
passed. The first Go Workspace browser job failed with a disabled group-send
button after editor input; the same-head diagnostic rerun passed all 18 cases
without code, timeout, retry or assertion changes. Local Go Workspace also
passed 18/18. This intermittent composer boundary is not a proven backend
cause or native macOS IME acceptance; retain that limitation when restoring
the feature release.

The lead built real Linux images at tested head 8aaa934, preserving pinned
dependencies and using the supported Go/ Debian mirror arguments after the
default Go module proxy timed out. Exact Workspace image
`sha256:ab1b753c2643647ed252c0cddb4f1f618b5f5f6f440cfb9010c00c02b9341b5e`
passed the old-to-target 33/33 SQL hash check. The real Docker Go-to-Go
coordinator test passed (one selected test, 188.2 seconds), including exact
previous Go restoration, exact retained Node restoration, private snapshots,
same disposable PostgreSQL/storage authority, and owned-resource cleanup.
The initial invocation selected an obsolete Node image lacking its offline
pnpm cache and failed before migration; the successful invocation used the
documented offline-ready image from the predeployment handoff. No guard was
relaxed. This 33-to-33 rehearsal is not the subsequent 33-to-34 proof.

The official production `go-full --go-upgrade` deployment completed on
2026-09-10 around 07:22 UTC from the exact merge commit above, in the production
checkout with the previous successful 0.16.1 private snapshot. The first build
attempt timed out at `proxy.golang.org`, before migrations, fencing or service
replacement. The second used existing `DUALLANE_GO_BUILD_PROXY` and
`DUALLANE_DEBIAN_BUILD_MIRROR` process arguments; it did not change `.env`,
dependency versions, checksum verification, Docker daemon configuration or
network bindings. All passive candidates and the 13-check gateway smoke passed.

| Service | Production 0.16.2 image ID |
| --- | --- |
| P2P | `sha256:848e337a586e17f43c1dac7cd05f9b7952852532ac0f5c70b2e91b361ab339ef` |
| Workspace, worker, migrate | `sha256:c6b6b98505d5e9935554e8ea7953653fa4bc13f4c0d6756fb97dbdc1b5268926` |
| Web | `sha256:845d4a41fe9793265d154a82b123a6ed68b9a90d0cf7b233d2886706786e013e` |

Independent verification confirmed matching image/container labels, healthy
services with zero restarts, restored `always` policies, non-root users and
read-only roots. Workspace/worker active readiness passed; Node remains stopped
with restart disabled. PostgreSQL container/volume and Workspace data/S3
authority are unchanged. History remains exactly 33 migrations. No production
034 has been applied by this release. Old recovery images remain present.

The new private artifact basename is
`backups/production/duallane-20260910T071832Z-c15d5569ccc5` in the production
checkout. The `.recovery.go-compose.snapshot.json` plus `.compose.json`,
`.external.json` and `.volumes.json` sidecars verified as regular mode-0600
artifacts. Both new snapshot authority and old-to-new authority verification
passed. Do not commit their contents or edit them for the next rollout.

Independent public HTTPS/WSS verification passed: version 0.16.2, home/security
headers, referenced JS/CSS, ICE, anonymous Workspace denial, private endpoint
404s and unauthenticated WebSocket close 1008. Curl TLS reset attempts were not
passing evidence; the bounded verified-TLS Node probe passed. An initial
hand-written readiness probe used the wrong P2P path; the corrected probe used
its actual `/api/health` contract, not Workspace's `/readyz`. Bounded redacted
Go log samples had no warnings/errors. The production checkout remained clean
with its index owned by `timestarry`; the official cache cap left about 9.4 GB
free. No data, private backup, retained image or unrelated container was removed.

The bridge prerequisite is now deployed and verified. Feature 0.17.0 still
requires its own current-source checks, exact-image expanded-schema rollback
rehearsal, PR and production evidence; Node retirement remains separate.
