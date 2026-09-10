# Work Item: 0.18.0 Node Online Runtime Retirement

**Date:** 2026-09-10 (Asia/Shanghai)

**Status:** pre-deployment validation recorded; production activation is a
separate step recorded in [PR11](https://github.com/timeStarry/duallane/pull/11).
This document does not claim a production deployment before that record exists.
**Scope:** retire the online Node implementation, preserving canonical SQL,
frontend/shared contracts, SDK, offline storage maintenance and exact Go rollback.

## Baseline and accepted boundary

The verified 0.17 Go baseline is PR10 merge
`8d346a04317d0d3396293caca14ca1c65c7b5163`, schema 34. See the
[0.17 activation record](2026-09-10-chat-0170-after-bridge.md). The maintainer
authorized this next release and Node online-source cleanup after accepting
0.16.1; related PR merges and the guarded production deployment are authorized.

The 0.18 online topology is Go P2P, Workspace, worker, explicit migrator and
Nginx Web gateway. It has no online Node API/worker or Node bootstrap path.

- `apps/web/server` retains only the 34 canonical SQL migrations.
- React/Vite, shared assets, imported emotes and the Agent SDK remain intact.
- `tools/node-compat` contains only explicit offline storage provision,
  migration and deduplication operators with pg/AWS dependencies. Its default
  image shows help. Importing it does not connect, listen, migrate, seed or
  claim work; Compose operations require explicit profiles.
- Offline `finalize`, full production S3 inventory verification and physical
  legacy-object cleanup are not part of this release. They retain their
  separate authorization, backup/restore and writer-fence requirements.
- Frozen historical Node outputs and immutable-image recovery tests remain
  evidence, not a second production owner or a source rebuild path.
- `pnpm dev` starts loopback Go P2P/Workspace and Vite on 8897/8898/5173;
  no Docker, database, worker or automatic migration/seed is started.
- Public release copy is member-focused; engineering retirement details belong
  here, not in the ordinary user's changelog.

No API, event, schema, storage-layout, authorization, quota, retention,
idempotency or audit contract is deliberately changed. No production content
was copied into tests. Production data, rollback images and snapshots are
retained; removing source does not authorize deleting historical objects.

## Tested revisions and environment

- Core retirement: `7913ffea5603e4ca1e4632452e6d682a45da0af8`.
- Final runtime/content revision:
  `1d8559231efaa61316097ddf2bac9cb6cc790d83`.
  The four-file delta from the core revision is public release text and its
  matching Web/Go assertions; release helpers and browser behavior are unchanged.
- This ledger/handbook follow-up is documentation-only. PR11 records its final
  head, CI result and merged commit separately; tested source revisions are not
  relabeled as the later merge commit.
- Clean Linux-native Git worktrees; Ubuntu 24.04 WSL, Node 22.23.2,
  pnpm 10.30.3, Go 1.26.8, CGO/libvips, task-owned loopback PostgreSQL and
  the local Docker daemon. Frozen offline installation resolved 286 packages.
- Final-runtime CI: [run 34462620363](https://github.com/timeStarry/duallane/actions/runs/34462620363),
  all four jobs passed. The core revision also passed all four CI jobs.

Bounded luna-worker slices handled offline tools, dev/CI/test migrations,
frozen compatibility inputs and documentation. The lead reviewed and integrated
them as separate commits, then executed the clean-checkout and exact-image gates.

## Validation ledger

All commands below ran with the pinned toolchain; PostgreSQL URLs selected
only disposable loopback data. Private artifacts are not uploaded.

| Gate | Executed evidence | Result |
| --- | --- | --- |
| Source and dependency retirement | Reviewed tree and lockfile; only canonical SQL remains under the old server path; obsolete Node Dockerfiles/gateway/runtime dependencies removed | PASS |
| JavaScript workspace | `pnpm install --frozen-lockfile --offline`, `pnpm test`, `pnpm lint`, `pnpm build` at final runtime revision | PASS; SDK 8, Web 234, offline tools 20 unit tests |
| Go quality | `make -C apps/backend verify` at final runtime revision | PASS; unit/race, generated checks, vet, staticcheck, vulnerability scan and command builds |
| PostgreSQL | `make -C apps/backend integration-postgres` at final runtime revision | PASS; real PostgreSQL/race, explicitly uncached |
| Offline adapter | `NODE_COMPAT_TEST_POSTGRES=true node --test tools/node-compat/test/database.postgres.test.mjs` with disposable `TEST_DATABASE_URL` | PASS, 1 real PostgreSQL case; the normal unit suite's opt-in skip is covered separately |
| Default browser | `pnpm test:e2e` at final runtime revision | PASS, 6 |
| Complete Workspace browser | `pnpm test:e2e:workspace-go` at final runtime revision | PASS, 21, no retries; initial local failure and repeat evidence below |
| P2P privacy browser | `pnpm test:e2e:p2p-go` at final runtime revision | PASS, 5 locally and in CI |
| Frozen historical provenance | `node --test .github/tests/frozen-node-artifacts.test.mjs` | PASS; exact 28-artifact set and hashes |
| Frozen P2P | `node scripts/backend/p2p-frozen-contract.mjs` | PASS, 21 HTTP / 22 WebSocket observations |
| Frozen files/emotes | `node scripts/backend/frozen-legacy-contract.test.mjs --all` at final runtime revision | PASS, 2 real file cases and 1 PostgreSQL/HTTP emote case, including cleanup |
| Host/native media | Go media package in normal gates and exact Docker build target with network disabled, read-only rootfs and UID 65532 | PASS, 28 corpus cases: 16 accepted / 12 rejected / 16 pixel checks; tolerances unchanged |
| Go dev lifecycle | Real Go/Vite startup, split proxy responses, SIGTERM and owned port/process cleanup | PASS on core revision; runner unchanged in final runtime revision |
| Release/tooling guards | `node --test --test-concurrency=4` over `.github/tests/*.test.mjs`, `scripts/backend/*.test.mjs` (excluding the separately run legacy harness), `scripts/dev/*.test.mjs`; actual Compose opt-ins enabled | PASS on core: 302 passed / 14 optional skips; selected real-image gates below cover their own cases |
| Permission-denied guard | Explicit non-root run of the private-file unreadability case skipped by root | PASS, 1 |
| Docker components | Opt-in drain-run, Node authority, restart-policy and volume-authority test files using exact local image IDs | PASS, 7 |
| Real drain runtime | `release-drain-runtime.docker.test.mjs` with exact Go image and isolated migrated PostgreSQL | PASS, 8 |
| Full release coordinator | `release-coordinator.docker.test.mjs` with all documented immutable-image opt-ins | PASS on core, 9 total: 2 pure and 7 real lifecycle/fault/permission/upgrade scenarios |
| Final image Go upgrade | Same coordinator, `--test-name-pattern='real Go-to-Go'`, exact final runtime images | PASS, 1; 0.17 → 0.18 → exact 0.17 rollback on the same database, before historical fixture cleanup |
| SQL compatibility | `release-schema-compatibility.mjs verify --previous-image … --target-image …` | PASS; 34 common, 0 added, 0 removed; no schema expansion policy needed |
| Image boundaries | Read-only/no-network offline imports; UID 65532 reads 34 SQL and 2 catalog files; UID 101 reads Web assets; `runtime-permissions.mjs --docker` | PASS for final images; 6 permission scenarios with owned cleanup |
| Previous production authority | Read-only private snapshot/external-file/volume checks, exact image availability and dump SHA verification | PASS for the 0.17 baseline, rechecked before release preparation |

The Go vulnerability scan found no reachable vulnerability in current code.
It also reported unreachable dependency findings (five imported-package and
three required-module items); this is not a claim that all dependencies are
vulnerability-free. Go outputs explicitly marked cached remain cached evidence;
the PostgreSQL and native media commands above use uncached execution.

### Local browser failure and repeat evidence

One additional local final-runtime run, concurrent with heavyweight Docker/Go
validation, produced 19 passes and two failures: emote-subscription timeout
with a Chromium context-disposal error, and a missing chat region during initial
navigation in the around/read race case. No OOM kill or database restart was
observed. Load is a possible explanation, not a proven root cause.

After heavyweight runs finished, the unchanged emote-subscription and both
state-race tests passed three explicit repetitions (9/9, 32.8 seconds), followed
by a complete unchanged Workspace suite (21/21, 1.7 minutes). Independent CI
also passed all 21 tests on that revision. No timeout, assertion, retry policy
or application code was relaxed. The original failure remains recorded; this
is a non-reproduced local test failure, not a claimed application fix.

An initial repeat invocation under the wrong local user could not locate that
user's installed Chromium and supplied no browser evidence. It was corrected
to the existing toolchain/browser owner without installing or changing Chromium.
Private failure contexts and synthetic screenshots remain ignored.

## Frozen evidence identity

Last regenerable historical source:
`8d346a04317d0d3396293caca14ca1c65c7b5163`. New binary observations were
captured from the clean pre-merge source tree
`6ebc0f6858d67cf2be516d19ecf062c3ae75b505`, verified identical to that merge
tree. No current Go output was substituted for historical Node expectations.

SHA-256 (UTF-8/LF for JSON; decoded byte hashes are also verified):

| Artifact | SHA-256 |
| --- | --- |
| 28-artifact provenance manifest | `22617b81d290cce7b545b770d236c87703ebf57a381a6078183aa13df022ddf6` |
| Frozen P2P observations | `fac7ca6d74f37906e36a2ef51abde599dd49acbbbe6f2854f6ba8d49ea78d253` |
| Frozen legacy files | `1895a6b5f8396e865c28fc8deafa531da0601f42deb0f25ed108886c111dd520` |
| Frozen legacy emotes | `40a2734c3a4ef893ebf84d321fe8644b07fa7ca5e9f46e844c2980285c1b92bd` |
| Frozen media corpus | `0795d77a0f0cd82fafbc87fe83125242f22da2f2fe7a838dc4d4a8bb7b918ef6` |

## Exact final-runtime rehearsal images

These are **local test images**, not an assertion of production image identity.
All were built from `1d8559231efaa61316097ddf2bac9cb6cc790d83`.

| Image | Local immutable ID |
| --- | --- |
| Workspace/worker | `sha256:6d5b79354ff006bbdc76561ec2fd332941f9cd35d6b2a890b3707d93cdb57b60` |
| P2P | `sha256:189f7cf716fb51f2abc4df1117ff6cb4113c2bad08ef6cc3bceb0de895ae9195` |
| Web | `sha256:a19c6f6bafefae606182359209f149954174fe358bca61e1cc2ee869cb60af61` |
| Offline tools | `sha256:1ffb2aca9ce0a22c5dbd150e642e7fbc9d83bf31edaa97d62a43fd73e1294ba5` |
| Native build target | `sha256:28f7c7e68b1863de7bf0834f7ae6604e6cfd95b3d6ac8c45f1936be65cf28581` |

The full coordinator used immutable historical Node images only as isolated
synthetic recovery fixtures. The real Go-upgrade case completed before its
final Node fixture recovery; no Node owner ran beside active Go owners.
The current production entry point rejects Node-default/bootstrap and
permission-preparation forms before touching Docker.

## Production upgrade and rollback

The 0.18 transition uses the successful private 0.17 base
`backups/production/duallane-20260910T080211Z-8d346a04317d.recovery.go-compose.snapshot.json`
and adjacent `.compose.json`, `.external.json`, `.volumes.json` sidecars.
Later upgrades must use their latest verified successful snapshot, not
indefinitely reuse this historical example.

After final documentation review and CI, merge normally through authorized
GitHub user `timeStarry`. Pull exact `origin/main` with `git pull --ff-only`
as the production checkout owner. Run the official coordinator only from
`/home/timestarry/duallane` with the full `--expected-commit`,
`--release-profile go-full --go-upgrade --previous-release-snapshot`.
The maintainer's explicit host access exception applies only to this task;
the repository's default deployment/SSH policy is unchanged.

Verify passive candidates, exact image metadata, same database and object
authority, old-owner fence/drain, and gateway-last activation. Independently
verify public TLS/assets/health/auth boundaries/WebSockets, all four owners,
schema 34, restart policy, private recovery artifacts and dump checksum.
Record the merged commit, exact production image IDs, safe artifact names and
remaining limitations in PR11's activation comment.

If activation fails, re-identify and fence all four owners, including any not
recreated, then restore exact previous Go images against the same authority.
Do not run bare Compose replacement, restart online Node, down-migrate schema,
restore stale data or describe image rollback as database rollback.

## Remaining verification limits and safe artifacts

- Real signed-in production UI remains unverified: the browser connector
  repeatedly returned `nodeRepl.fetch request failed`. No browser profile,
  cookies or credentials were extracted as a workaround.
- Native macOS IME and real external notification-provider delivery remain
  unverified. Synthetic Chromium IME and local provider contract tests do not
  establish those environment-dependent results.
- No full production S3 inventory, offline backfill/finalize or legacy-object
  deletion was run or authorized by this source-retirement release.
- Safe summaries live in this record, CI and PR11. Local detailed logs remain
  under ignored `backups/validation/` in the clean validation worktrees;
  browser contexts/screenshots and private recovery artifacts are not published.
