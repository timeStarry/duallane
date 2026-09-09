# Pre-deployment Handoff — 2026-09-09

> Current acceptance evidence for PR #2. The long
> [work record](2026-09-06-predeployment.md) retains historical failures and slice
> provenance. This document does not authorize deployment or replace the
> [capability ledger](../EVOLUTION.md).

## Boundary and identity

The runtime candidate is clean commit
`205f470f09852c9f36aeac37926b710e0f267940` (version `0.16.0`).
Subsequent closeout commits edit documentation only; their PR-head CI is recorded
in the PR without relabeling these already-built images.

Production routing, writers, claimers and migration ownership remain Node.
P2P content remains transient; Workspace retains exact opt-in, authorization,
quota-before-transfer, retention, idempotency, audit and object-access rules.
All local evidence below uses disposable synthetic state and local Docker.

Environment: 2026-09-09 Asia/Shanghai, Ubuntu 24.04 WSL, Node 22.23.2,
pnpm 10.30.3, Go 1.26.8, CGO enabled, native libvips 8.14.1, PostgreSQL 17.11.
The native snapshot was cloned with restrictive `umask 077`; tracked files were
clean. Image builds use the checked-in digest-pinned bases and Docker BuildKit,
`GOPROXY=https://goproxy.cn,direct`, and the allowlisted USTC Debian mirror.

## Final candidate evidence

Commands below run from the repository root unless otherwise stated. Environment
variables for disposable databases and exact image IDs are supplied as specified
by [Validation](../VALIDATION.md), never production credentials.

| Gate / command | Evidence |
| --- | --- |
| CI on exact runtime commit | [34254215437](https://github.com/timeStarry/duallane/actions/runs/34254215437): all four jobs PASS. Previous exact `88dd742` [34252796868](https://github.com/timeStarry/duallane/actions/runs/34252796868) also passed all four jobs. |
| Go aggregate in CI | `make -C apps/backend verify`, full `integration-postgres`, actual Node/Go schema, media, local files and legacy emote checks. Final job status is recorded above; ordinary tests alone do not select PostgreSQL cases. |
| Node quality and browser CI | `pnpm test`, `pnpm lint`, `pnpm build`, persisted Node fixture/oracle checks, Compose config/image builds and full `pnpm test:e2e` PASS on `205f470`. The two ordinary-suite PostgreSQL skips are separately covered below. |
| Native Node PostgreSQL | `pnpm --filter @duallane/web test:postgres`: 2/2 PASS, 1.38s. |
| Native schema coexistence | `DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION=true DUALLANE_SCHEMA_COEXISTENCE_RUN_PG=true node --test scripts/backend/schema-coexistence.test.mjs`, with disposable `TEST_DATABASE_URL`: 9/9 PASS, 7.766s; actual migration owners, no skips. |
| Native Go Workspace browser | `DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION=true pnpm test:e2e:workspace-go`, with disposable `TEST_DATABASE_URL`: 18/18 PASS, 1.7m. Echo 1.8s, StrictMode 1.3s, original chat/file/reconnect flow 47.0s. |
| Native P2P protocol parity | `make -C apps/backend parity-p2p`: actual Node and Go implementations match 21 HTTP and 22 WebSocket observations. The full Go P2P browser job also passes in the exact-commit CI above. |
| Route and Markdown oracles | `node scripts/backend/route-inventory.mjs --check`: 164 declarations / 153 disabled HTTP observations; `node scripts/backend/workspace-markdown-contract.mjs --check`: 59 single-block and 5 joined cases PASS. These are scoped observations, not a claim that every endpoint has a full dual-runtime scenario. |
| Native media image | `node scripts/backend/media-compatibility.mjs --go-image <media-build-id>`: 28 cases, 16 accepted, 12 rejected, 16 pixel checks, zero failures. Actual Go/libvips 8.14.1 versus Node Sharp 0.35.3/libvips 8.18.3. Build-target image, not runtime image. |
| Immutable image resources | Static `docker-runtime-assets.test.mjs` PASS separately. Actual non-root reads PASS: 33 SQL + 2 JSON files, all `0644`, their two directories `0755`; Web 797 files `0644`, 17 directories `0755`, Nginx config `0644`. Readers are UID/GID 65532 and 101, with no network and read-only filesystems. |
| Fresh image migration/drain | `node --test scripts/backend/release-drain-run.docker.test.mjs` with exact Workspace/PG IDs: 2/2 PASS, 4.599s. |
| Runtime private-data permissions | `node scripts/backend/runtime-permissions.mjs --docker --image <workspace-id> --init-image <workspace-id>`: 6/6 PASS, including root-owned data/secret refusal, size bounds and symlinks; exact owned cleanup PASS. Optional fake-S3 stage NOT RUN; not claimed as provider compatibility. |
| Restart-policy isolation | `node --test scripts/backend/release-restart-policy.docker.test.mjs`, exact Workspace ID: parent plus `always` and `on-failure:3`, 3/3 PASS, 7.113s; no daemon restart. |
| Node and physical-volume authority | `node --test scripts/backend/release-node-authority.docker.test.mjs scripts/backend/release-volume-authority.docker.test.mjs`, exact Node/Workspace/PG IDs and opt-ins: 2/2 PASS, 24.093s, no skips. |
| Coordinated release | `node --test scripts/backend/release-coordinator.docker.test.mjs`, six exact IDs: 6 PASS / 0 FAIL / 1 unselected upgrade, 447.987s. Positive Node→Go→Node PASS (115.530s), after-backend recovery PASS (90.027s), after-capture recovery PASS (106.311s), passive candidates/cutover/recovery PASS (136.032s). Upgrade is covered separately below, not counted as a pass in this invocation. |
| Go upgrade and rollback | Same coordinator with upgrade opt-in, exact base/upgrade IDs and `--test-name-pattern="real Go-to-Go"`: 1/1 PASS, 188.312s, no skips. Actual newer Go activation, exact previous-Go rollback, then exact Node recovery. |

The coordinator exercises the real scoped release functions, gateway HTTP/WS
smoke, all four private recovery artifacts and unchanged PostgreSQL identity.
It does not invoke the production deployment entrypoint. The positive upgrade
case is not exhaustive evidence for every possible upgrade failure timing.
Both coordinator invocations completed their exact owned cleanup. Parent also
confirmed zero matching containers, volumes and networks afterward. The
pre-existing healthy validation stack and the loopback disposable PostgreSQL
fixture were retained; no browser servers remain from these completed runs.
No production containers or provider endpoints were selected.

## Immutable image identities

All three candidate runtime labels were independently inspected as
`205f470f09852c9f36aeac37926b710e0f267940 / 0.16.0`.

| Role | Exact local image ID |
| --- | --- |
| Workspace / worker / migrate | `sha256:e7828cbd42627a3e4607744d13ca9ae9909d21ec2ef016ba5b33cfd8003b6853` |
| P2P | `sha256:7ff62e9ee93462628a802a880023ba389b07d5a229016a25787ef87fc16cb1dc` |
| Web | `sha256:2d6ce9232c7405c864c0cd354698bdc3c0e987d33bafd4404940f72e7a25905f` |
| Media build target (no runtime label claim) | `sha256:bd1575839aabe435aea28bba8bee61f4e7b545dacbe73dc26b0e2fb6728205c1` |
| Disposable PostgreSQL | `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` |

Retained Node base `37ae06131a7bb38e6d2e77599f48aabc78e0492e / 0.15.5`:

- API: `sha256:e5e42b53d293a942ba8e541b34d9ea7bfa83990e1619272ad057858d300c2c6f`
- Web: `sha256:46d94eb4a6befc0af8bc3c3765fbe0512099cf88863a38c9e20e903c79d2327b`

The upgrade gate starts from known-good Go
`469176d34d05df0bb38c6f6e7ad6dbcffb2ec084 / 0.16.0`:

- Workspace: `sha256:27faeccce635d52fb094d8946f35114be1779f886d053026574a8b2ddeeaab09`
- P2P: `sha256:ade5078f1b61966042c4208557807274b07ac56aa11f6be631b76acc911d3a9b`
- Web: `sha256:71eb95c381e143fc4e6d316c98fbf057ad226e344375a814694383c17079286f`

Its newer candidate uses the same final `205f470…` source with
**test-only `0.16.1` metadata**, not a published product release:

- Workspace: `sha256:ce46e7eda514470dd58093906d7d789b972e4e56bcd5eda3c53d1738b8625b79`
- P2P: `sha256:d2417248298c2ddb3d6efbe2b18034cabbee280b5f25299ecadc374c9ecdeaf6`
- Web: `sha256:cbbeee5ae569645cde679bbdb7357ba0a843075d36956d7751eea98ccb584817`

## Closed defects and retained negative evidence

- Goldmark v1.8.6 (MIT), approved by the user, replaces the incompatible
  simplified Markdown summary. It produces plain summaries only. The actual
  Node oracle and Go stored-retry/member-read/event tests retain content bytes,
  authorization and audit/event idempotency. Historical five-case old-parser
  PostgreSQL failure (1.538s) was overlay evidence, not a final snapshot result.
  `govulncheck` reported zero reachable findings, with five imported-package and
  three module-only unreachable findings; Goldmark was not among them. This is
  not a zero-advisory claim for the whole dependency graph.
- `a49afb0` fixes cancellation after a committed Echo publication and concurrent
  replay. Delivery keeps its 30-second bound and any earlier request deadline.
  Parent-controlled browser negative/positive overlays share the same synthetic
  fixture: old code fails at actual card visibility (12.1s; zero messages/cards,
  pending delivery); fixed code passes (2.4s; one message/card/WS event, sent
  delivery). This proves the controlled defect, not the exact timing of the
  historical intermittent CI failure. New unit regressions fail on old logic
  and pass on the fix. Original browser assertions/timeouts/retries are intact.
- `90ea1fc`, `88dd742`, `205f470` fix restrictive checkout modes in immutable
  SQL/JSON, COPY-created directories and Vite-copied public files respectively.
  Historical `077` coordinator: 2 static passes / 4 lifecycle failures;
  `53`: 2 static passes / 4 failures; `88`: 3 passes / 3 failures. Each left
  its unselected upgrade case explicit. These are retained failures, superseded
  only by the exact final-image gates above; no mounted secret/data mode was
  widened.
- Local `88` Workspace browser: 17/18, a pre-login timeout; its CI passed.
  The unchanged complete final `205` local and CI browser suites both pass.
  The `88` media invocation failed at WSL transport startup, not at a corpus
  assertion; the final native-image corpus above completes successfully.

## Durable support and remaining authority

Start development through the [backend Agent guide](../AGENT_GUIDE.md);
[Operations](../OPERATIONS.md), [Validation](../VALIDATION.md) and
[Storage operator](../STORAGE_OPERATOR.md) remain canonical support documents.
The parent reviewed and integrated bounded luna-worker changes and split commits.
Only `timestarry` may merge [PR #2](https://github.com/timeStarry/duallane/pull/2).

No production data import, real provider delivery, deployment, writer/claimer
switch or Node deletion occurred. The retained Node offline
archive/backfill/verify/finalize tools are compatibility operators, not Go
startup hooks. Go exposes read-only plan/verify, explicit bucket provisioning,
and journal/CAS libraries; it does not expose a complete mutating backfill CLI.

After explicit deployment authorization and merge, use the guarded production
runbook with the exact commit and private recovery files. Record `routed` at
the real single-owner switch, `active` after accepted observation, and
`complete` only after legacy and rollback retirement. Application rollback
does not perform a down migration or restore a stale data copy.
