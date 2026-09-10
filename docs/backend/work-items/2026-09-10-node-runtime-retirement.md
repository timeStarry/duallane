# Work Item: 0.18.0 Node Online Runtime Retirement

**Date:** 2026-09-10 (Asia/Shanghai)

**Status:** `pending` — this record is a gate ledger, not a completion claim.
**Scope:** remove the online Node implementation while preserving the
canonical PostgreSQL migration path, frontend/shared contracts, SDK, offline
storage compatibility, and exact 0.17 Go rollback authority.

## Baseline and evidence boundary

The 0.17 production baseline is the merged PR10 release at commit
`8d346a04317d0d3396293caca14ca1c65c7b5163`, schema 34. The
[bridge/release record](2026-09-10-chat-0170-after-bridge.md) records the exact
release identity and the official plus independent public/TLS/health/snapshot/
volume verification. Logged-in UI acceptance was not verified because the
browser connection failed; native macOS IME was not verified. Those facts are
transparent baseline gaps, not 0.18 acceptance.

The first iteration reported 76 release/recovery/actual-Compose tests passing
(`production-deploy`, `release-activation`, `go-production-workers`, and
`release-compose-image-contract`) plus two retired-entry/orphan-discovery
tests. This is iteration evidence only. It does not advance any final-head
gate, prove the new image rehearsal, or mark this work item `complete`.

## Accepted 0.18 architecture boundary

The online topology is Go-only. The current tree must have no online Node API,
worker, gateway, or Node startup/migration path:

- retain canonical ordered SQL at `apps/web/server/migrations`;
- retain `apps/web/shared`, the Vite/React frontend, and
  `packages/agent-sdk`;
- keep `tools/node-compat` as a minimal, profile-only, offline package using
  only `pg` and AWS SDK storage access for `storage:migrate`, `storage:dedupe`,
  and `storage:provision`;
- importing Node-compat must not connect, listen, migrate, seed, or start a
  worker; its image defaults to help and never selects an operation;
- `finalize` remains a separately authorized destructive operation requiring
  authority identification, verified backup/restore evidence, and a complete
  writer/claimer fence;
- retain historical `release-helper.sh`, immutable old-image recovery, and
  synthetic old-image tests only as frozen recovery/provenance material; do not
  retain online Node source or run it beside Go.

Local `pnpm dev` uses the Go runner and starts P2P `8897`, Workspace `8898`,
and Vite `5173`. `DUALLANE_API_ORIGIN` is an explicit single-origin
Go/external-test harness override; normal development uses the split Go origins.
The runner does not start Docker, a worker, a database, or an automatic
migration/seed. The default E2E command is Go P2P-only; the complete Workspace
browser gate uses `pnpm test:e2e:workspace-go` with an explicit loopback
disposable PostgreSQL URL and `DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION=true`.

## Gate ledger

Every row remains `pending` until the lead records the final-head commit,
exact command, environment, result, and safe artifact. A previous release
record or a synthetic rehearsal cannot satisfy a new head gate.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Online source retirement | Final tree has no non-migration `apps/web/server` source/tests, old Node gateway, `Dockerfile.api`, or old `Dockerfile.web`; retained SQL/shared/frontend/SDK paths are intact | `pending` |
| Workspace documentation regression | `apps/web/src/workspace-config-docs.test.js` preserves the old protocol/documentation/frontend-copy assertions, maps Node implementation assertions to the real Go/Compose paths, and focused Vitest passes; the old server test is removed by the main agent | `pending` |
| Other test migrations | `v2ray-render-config` and `workspace-agent-integration-assets` migrations are owned by the stated agent; no safety gate is removed because files move | `pending` |
| Go local runner | Actual `scripts/dev/go-dev-config.mjs` defaults, environment forwarding, no automatic migration/seed, and explicit single-origin override are verified | `pending` |
| Compose default | Root Compose extends `docker-compose.go-production.yml`, has no online `api`, and its required `DUALLANE_APP_VERSION`/`DUALLANE_GIT_COMMIT` metadata contract is checked | `pending` |
| Offline compatibility fence | Node-compat has only the three explicit storage operators, `pg`/AWS dependencies, profile-only image behavior, no online startup, no default CLI, no automatic migration/seed, and finalize authorization text | `pending` |
| Deploy entry-point rejection | Current `deploy.sh` accepts only Go-to-Go upgrades and rejects Node-default/bootstrap/permission-preparation forms; old-install first migration/permission work points to the retained 0.17 checkout/runbook | `pending` |
| Go candidate rehearsal | New Compose removes `api`; four application owners (`p2p`, `workspace`, `worker`, `web`) pass image/metadata, health, authority, fence/drain, and gateway-last checks; an old orphan is found by exact Docker labels even when the new Compose has no `api` | `pending` |
| Frozen Node golden | Node golden hash and source commit `8d346a04317d0d3396293caca14ca1c65c7b5163` are recorded; no golden is regenerated by pretending current Go output is Node output | `pending` |
| Release/rollback | Exact 0.17 Go image IDs and private snapshot sidecars are verified; rollback preserves same authority and never rolls schema 34 to 0.16.1 or a stale database | `pending` |
| Final validation | Required Go unit/race/static/vulnerability, PostgreSQL, focused browser, Compose, release, and storage/media/P2P gates pass on the final head; unavailable UI login/native IME evidence remains explicitly `not run` | `pending` |

## Production upgrade and rollback contract

The next upgrade uses the private base snapshot
`backups/production/duallane-20260910T080211Z-8d346a04317d.recovery.go-compose.snapshot.json`
and its adjacent `.compose.json`, `.external.json`, and `.volumes.json`
sidecars. The release must verify four application candidates, same database and
storage authority, exact image/metadata identity, old-owner fence and bounded
drain, then replace the gateway last. A candidate check, orphan-discovery test,
or agent handoff does not authorize production.

If activation fails, keep confirmed fences, re-identify and re-fence all four
owners (including owners not recreated), and restore the exact previous Go
images and authority through the guarded procedure. Do not run a bare Compose
replacement, start online Node code, issue a down migration, restore a stale
volume, or claim database rollback from an application-image rollback.

## Implementation and review evidence

Bounded luna-worker slices extracted offline tools, migrated documentation and
local-development tests, prepared release metadata, and replaced live Node
characterization with frozen historical inputs. The lead reviewed, integrated,
and committed these slices separately. Final validation uses a clean
Linux-native checkout with the frozen pnpm lockfile, Node 22.23.2, Go 1.26.8,
CGO/libvips, and task-owned disposable PostgreSQL/Docker state. No production
content is used as a test fixture.

Pre-final integration evidence (not a substitute for the final-head gates):

- offline package: 20 unit tests passed in a clean Linux checkout;
- private S3 report directories: three focused Linux tests passed;
- offline PostgreSQL adapter: real transaction/savepoint/lock and owned-schema
  cleanup test passed, with no skipped case;
- migrated Workspace documentation and V2Ray checks: 22 tests passed;
- frozen provenance/P2P/legacy harness checks: 13 tests passed;
- frozen Go P2P: 21 HTTP and 22 WebSocket observations passed;
- frozen files/emotes: two file Go tests and one real PostgreSQL/HTTP emote
  test passed; fixture cleanup was verified;
- frozen media: 28 cases, 16 accepted, 12 rejected, 16 pixel checks and focused
  `go vet` passed; exact-image native validation remains a final gate;
- release/recovery checks: 133 passed and nine optional cases were not selected;
  real release-image rehearsal must still be selected and completed separately.

These changes do not broaden merge authority or alter the repository's default
deployment/SSH policy. The existing maintainer authorization governs this
release; the guarded production coordinator and independent verification remain
mandatory. The completed 0.17 release record is retained unchanged.

## Final evidence to be filled by lead

```text
final_head:
checked_at:
environment:
commands_and_results:
focused_workspace_docs_test:
go_only_e2e_and_workspace_e2e:
compose_and_orphan_rehearsal:
frozen_node_golden_hash_and_source:
production_snapshot_and_image_ids:
known_not_run_or_blocked:
status: pending
```
