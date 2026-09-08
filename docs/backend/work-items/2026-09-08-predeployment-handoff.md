# Pre-deployment Handoff — 2026-09-08

> Candidate closeout record for contributors and the maintainer. It is not a
> second owner ledger, deployment authorization, or replacement for the long
> [2026-09-06 work record](2026-09-06-predeployment.md).

## Authority and scope

Read the [backend agent guide](../AGENT_GUIDE.md), [Evolution ledger](../EVOLUTION.md),
[runtime/operations contract](../OPERATIONS.md), and [validation contract](../VALIDATION.md)
for canonical rules. This sidecar records the current acceptance boundary and
does not change production code, configuration, owners, the shared index, or
branch history.

The current trust boundary is unchanged: P2P content remains transient and
separate from Workspace persistence; Workspace retains authorization,
quota-before-transfer, retention, idempotency/concurrency, audit, event, and
object-access invariants. Candidate and rehearsal evidence uses disposable state.

## Current snapshot

| Item | State |
| --- | --- |
| Current clean candidate | `077085b3c6e8267a3334023abbb5ff2b1bc95e68` — Markdown change committed/pushed; parent has a clean native snapshot. |
| Historical CI anchor | `623dc6975f25672ebc0a10aad33f3ec8c9b5f7e8`, CI `34245844380` — Node, Go Workspace, Go P2P, and Go aggregate all `SUCCESS`. Retain as history, not as the final candidate identity. |
| Latest CI | `077085b3…`, run `34247169256` — complete: Go aggregate/PostgreSQL/native, Node, and P2P `SUCCESS`; Go Workspace 17/18 `FAIL` on the same Echo check. |
| Current open defect | Clean `077085b` Go Workspace run: 17/18 (3.2m); original Echo release card at line 34 intermittently absent despite success confirmation. RCA required; no retries/timeouts/assertions changed. |
| Production owner | The [Evolution ledger](../EVOLUTION.md) remains authoritative. Candidate code, images, and rehearsals do not by themselves move ownership from Node. |
| Goldmark | v1.8.6 is approved and integrated. Go summary compatibility passes 59 single-block cases plus 5 concatenated cases; this is all Go coverage, not merely 5 Go goldens. |

## Implemented pre-deployment boundary

- Go P2P, Workspace, worker, and migration candidates have composition,
  readiness/passive modes, and release checks. The executable boundaries are the
  [backend Makefile](../../../apps/backend/Makefile), [candidate Compose overlay](../../../deploy/production/go-candidate.compose.yml),
  [release manifest](../../../deploy/production/release-manifest.mjs), and
  [release helper](../../../deploy/production/release-helper.sh).
- The guarded `go-full` path includes exact commit/image checks, fencing,
  read-only drain/authority checks, private recovery artifacts, and application
  rollback. See the [operator runbook](../../../deploy/production/README.md) and
  [release order](../OPERATIONS.md#9-release-order).
- Later accepted slices cover bounded Workspace projections and regressions
  (events/summaries, pins, access, emote ordering, upload response ordering,
  and client response ordering). They are slice evidence, not whole-Workspace
  parity or a production route change.
- The recent 18/18 Go Workspace browser result took about 2.3 minutes on Linux,
  but used `8d27574` plus overlays and omitted the reorder route and Markdown
  adapter. It remains supporting overlay evidence only.

## Final acceptance ledger

The table below is the latest recorded evidence. Commands and results remain
separate; a result from an overlay, old implementation, or different commit is
not silently promoted to final-candidate evidence.

| Evidence | Latest result | Final acceptance use |
| --- | --- | --- |
| Go Markdown summary | 59 single-block + 5 concatenated cases — `PASS` | Scoped compatibility evidence; tie to `077…` and the final CI record. |
| `messages` real PG/race | `PASS`, 10.690s | Scoped package result. |
| `events` real PG/race | `PASS`, 10.724s | Scoped package result. |
| `conversations` real PG/race | `PASS`, 6.795s | Scoped package result. |
| Summary + bounded fuzz seeds, final race | `PASS`, 1.274s | Scoped parser/race result. |
| Old five-summary PG subcases | `FAIL`, 1.538s | Old/baseline result; retain as negative-control provenance and identify its exact command before treating it as a final-candidate failure. |
| `govulncheck` | 0 reachable findings; 5 packages + 3 modules unreachable recorded | Keep reachability limits explicit; the new Goldmark dependency is not in the reported finding set. |
| Parent native `077` checks | Node: 8 SDK, 732 Web, 2 original skips, lint/build — `PASS`; Go `verify` and full PostgreSQL/race — `PASS` | Native evidence for `077`; unresolved browser defect and final CI remain separate gates. |
| CI `623dc69` / `34245844380` | All reported jobs `SUCCESS` | Historical anchor only. |
| CI `077` / `34247169256` | Three jobs `SUCCESS`; Go Workspace 17/18 `FAIL` | Confirms the Echo failure also occurs in CI; not an all-green aggregate. |
| Native Node Chromium | 23/23 `PASS`, 3.2m | Exact `077`, including the original Echo and full flow. |
| Native Go P2P | 4/4 Chromium `PASS`, 9.4s; 21 HTTP + 22 WebSocket parity observations match | Exact `077`, actual Node/Go implementations and unchanged browser cases. |
| Node PostgreSQL and schema coexistence | Node 2/2 `PASS`, 1.19s; real Node/Go coexistence 9/9 `PASS`, 10.100s, no skips | Exact `077`, disposable PostgreSQL 17.11. |
| Native image media | 28 cases: 16 accepted, 12 rejected, 16 pixel checks, zero failures | Exact `077` build-target image below; runtime libvips 8.14.1 versus Node Sharp/libvips 8.18.3. |
| Runtime permissions | 6/6 `PASS`, 5.398s, UID/GID 65532 | Exact Workspace image below; optional synthetic-S3 stage not selected. Owned cleanup passed. |
| Restart-policy fencing | 3/3 `PASS`, 6.859s, no skips | Exact Workspace image; real `always` and `on-failure:3` policy cases, no Docker daemon restart. |
| Coordinated release | 2 static `PASS`, 4 lifecycle `FAIL`, 1 upgrade `SKIP`, 266.654s; fresh drain 1 static `PASS`, 1 real migration `FAIL`, 3.329s | Runtime SQL/JSON and candidate Nginx config retained root-owned `0600` modes from a restrictive checkout. Packaging fix and complete rerun required. Exact labeled rehearsal containers, volumes and networks were cleaned; the pre-existing healthy stack was untouched. |

### Commands to record (not run by this documentation sidecar)

Use the repository-native commands and disposable PostgreSQL described in
[candidate gates](../VALIDATION.md#3-candidate-go-gates-and-evidence):

```sh
node scripts/backend/workspace-markdown-contract.mjs --check
make -C apps/backend verify
TEST_DATABASE_URL="postgres://<disposable-user>:<disposable-password>@127.0.0.1:<port>/<disposable-db>?sslmode=disable" \
  make -C apps/backend integration-postgres
TEST_DATABASE_URL="postgres://<disposable-user>:<disposable-password>@127.0.0.1:<port>/<disposable-db>?sslmode=disable" \
  DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION=true pnpm test:e2e:workspace-go
```

The deployment matrix and opt-in real-image gates are defined in
[deployment acceptance](../VALIDATION.md#10-deployment-acceptance). Record each
command, exact candidate commit, environment, and `PASS`/`FAIL`/`SKIP`/`NOT RUN`
using the [replayable evidence format](../VALIDATION.md#replayable-evidence-record).

## Parent final-fill table

The known evidence is above. Only values that require final artifact identity or
the then-current CI result remain open:

```text
candidate_commit: 077085b3c6e8267a3334023abbb5ff2b1bc95e68
ci_run: 34247169256
ci_final_status: FAILURE (Go Workspace Echo; other three jobs SUCCESS)
checked_at/environment: 2026-09-09 Asia/Shanghai; Ubuntu 24.04 WSL,
  Node 22.23.2, pnpm 10.30.3, Go 1.26.8, CGO=1, libvips 8.14.1,
  disposable PostgreSQL 17.11, local Docker

image_ids:
  p2p: sha256:4abcabe239cdb3449cd23cf2a5f5abef0852466bdeb15f5c4696f988f1cf6beb
  workspace_worker_migrate: sha256:6855404bf5dcfdc458a8e9e513fa2d5580e15a6196ae66db613f9d6e3a2b25dd
  web: sha256:f5cc6b139b0808f021f06efdcdcd3a516177ece12e4aa74a8dbc94d9da9eddbb
  postgres_or_rehearsal_base: sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
  media_build_target: sha256:0ccc5e8e5c8895353a13ab52d6b21e5cfc20f17b2e653aa973374e24f9166e65

release_evidence: Parent verified all three runtime image revision/version labels
  as candidate_commit / 0.16.0. Coordinated release rerun is not yet passing.
```

Do not call the aggregate green when a required case is skipped, the CI commit
differs from `077…`, or the result comes only from the `8d27574` overlays.

## Explicitly post-deployment and non-authorized here

This sidecar does not authorize a production command, owner switch, live data or
provider access, observation sign-off, or Node legacy deletion. If deployment is
explicitly authorized later, use the [guarded entry point](../../../deploy/production/deploy.sh)
from the production checkout and its [runbook](../../../deploy/production/README.md),
with the exact commit/image identity and private recovery artifacts.

Owner status is recorded at the real transition, not deferred until observation:

1. Record `routed` in the [Evolution ledger](../EVOLUTION.md#7-status-transitions)
   when the complete capability is actually switched and Go is the sole writer.
2. Record `active` only after the authorized observation window and its evidence
   are accepted.
3. Record `complete` only after the legacy implementation, tests/configuration,
   and rollback dependency are removed under the ledger's completion criteria.

Rollback remains application/image recovery, not an automatic down migration or
database restore. Keep Node recovery until the relevant transition is accepted;
use the [release snapshot validator](../../../deploy/production/release-compose-snapshot.mjs)
and the rollback rules in [Operations](../OPERATIONS.md#10-rolling-compatibility-and-rollback).

## Remaining parent confirmations

- [ ] Resolve and causally test intermittent Echo card visibility, then repeat
      the complete browser suite without weakening the original case.
- [ ] CI `34247169256` and the final clean `077…` aggregate/PG result are recorded.
- [ ] Final P2P, Web, and shared Workspace/worker/migrate image digests and labels
      are tied to the same candidate; any rehearsal artifacts are private.
- [ ] Goldmark command identity and the old five-summary PG negative-control
      identity are recorded without reclassifying either result.
- [ ] Final release/rollback evidence is reviewed against the exact candidate;
      no candidate or synthetic rehearsal is called a deployment.
- [ ] Any owner transition and later legacy deletion are recorded only at the
      real `routed`, observed `active`, and legacy-free `complete` boundaries.

The initial documentation-only sidecar ran no large test or production command.
The parent subsequently added the executed candidate evidence above. Private
browser output, Compose recovery files and synthetic secrets are not PR artifacts.
