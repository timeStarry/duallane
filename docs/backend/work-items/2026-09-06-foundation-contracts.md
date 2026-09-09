# Go Foundation And P2P Contract Slice — 2026-09-06

This is candidate implementation evidence, not a second ownership ledger.
Read [Evolution](../EVOLUTION.md) for the current owner and
[Validation](../VALIDATION.md) for the remaining cutover gates.

## Scope And Ownership

- Base: `7ff0795` on `codex/go-backend-architecture`.
- Behavior: make the existing Go candidate verifiable, generate the P2P HTTP
  contract reproducibly, and characterize Node/Go behavior with synthetic data.
- Current owner: Node API; Go P2P and Workspace remain `planned`.
- Trust lanes: operational build/test tooling and the isolated P2P candidate.
- Data impact: no schema, production data, object, job, writer, or routing
  changes. PostgreSQL tests use a disposable local database only.
- Non-goals: completing Workspace Bot/Avatar/Echo drafts, adopting the generated
  router, adding services to production Compose, deploying, or advancing ownership
  status.
- Rollback: revert the relevant candidate/tooling commit; no database rollback.

Three `luna-worker` assignments ran with disjoint writes. The lead reviewed the
actual patches, ran independent checks, and exclusively staged split commits.

| Owner | Write scope | Handoff |
| --- | --- | --- |
| CI worker | `.github/workflows/ci.yml`, `.github/tests/` | Native dependency prerequisites and ordering regression |
| Contract worker | `apps/backend/api/p2p.codegen.yaml`, `internal/p2pcontract/` | Generated models/interfaces, conformance and freshness checks |
| P2P worker | `scripts/backend/` and focused `internal/p2p/` fixes only if proven | Real-process synthetic comparison, safe failure reporting |
| CI worker, second bounded assignment | `internal/platform/media/webp_dependency_test.go` | Synthetic dependency regression |
| Lead | Module pins, Make/root wrappers, handbook, evidence, serialized index | Integration, security/compatibility decisions and acceptance |

The pre-existing tracked Bot Gateway/router edits and untracked Workspace
Avatar/Echo files were excluded from every commit. They were not reverted or
silently made part of a passing clean-checkout claim.

## Decisions And Split Commits

| Commit | Reviewable unit |
| --- | --- |
| `49bc09f` | Provision CGO/compiler/libvips in host-run Go CI, with a focused ordering test |
| `11f2ec6` | Upgrade `x/image` to v0.43.0 and add a malformed WebP regression |
| `5dddf12` | Pin oapi-codegen v2.8.0/runtime v1.6.0/kin-openapi v0.142.0; generation, conformance, wrappers, handbook |
| `caa577e` | Bounded real-process P2P comparison, fixtures, runner regression tests, CI/Make/root entry points and validation guide |

The follow-up integration commit records acceptance, adds source references to
the WebP regression comment, and marks `x/image` as directly required because
the regression imports it. `go mod tidy -diff` identified only that dependency
classification change; no version or runtime behavior changes with it.

The existing `x/image` v0.38.0 pin failed the vulnerability gate for
[GO-2026-5061](https://pkg.go.dev/vuln/GO-2026-5061). The same synthetic fixture
panics with the old decoder and is rejected with v0.43.0. This is a direct
dependency regression, not a claim that the native libvips production decoder
has the same defect. The language/toolchain baseline did not change.

OpenAPI stays at 3.1.2. Generated decoding is not validation: tests demonstrate
that a model can decode `maxPeers=3`, while schema validation rejects it. All six
direct `const` fields are covered, along with unknown/omitted/null fields and
ICE alternatives. The live P2P handler remains hand-authored and independent of
the test validator. Generation freshness uses a bounded subprocess and a
temporary output, not writes to the checked-in artifact.

## Environment And Replay

Checked on 2026-09-06, Asia/Shanghai:

- Windows worktree: `D:/Project/duallane`, executed through Ubuntu 24.04 WSL.
- Clean validation checkout: user-local Linux directory
  `/home/timestarry/.local/share/duallane-validation/20260906/repo`.
- Go 1.26.8; Node 22.23.2; pnpm 10.30.3; GCC and pkg-config; libvips 8.15.1.
- PostgreSQL 17.11, disposable loopback-only container, image digest
  `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
- Go/Node/pnpm executables were put on the command-local `PATH`. Module download
  used command-local `GOPROXY=https://goproxy.cn,direct` because the default
  proxy timed out; checksum verification remained enabled. No global project
  dependency versions or production environment files were changed.

Use the repository commands below from the named checkout. For the PostgreSQL
command, set `TEST_DATABASE_URL` to a freshly initialized disposable PostgreSQL
instance; never use an application database. No credentials belong in this
record.

| Command / observation | Tested source | Result and actual coverage |
| --- | --- | --- |
| `node --test .github/tests/ci-go-native-dependencies.test.mjs` | CI patch committed as `49bc09f` | PASS: native packages/checks precede Go validation; CRLF-safe |
| `make -C apps/backend generate check-generated` | Contract patch committed as `5dddf12` | PASS: pinned regeneration and non-mutating freshness |
| `go test -count=1 -race ./internal/p2pcontract` in `apps/backend` | Contract patch | PASS: actual handler conformance, invalid request/response constraints |
| `go test -count=1 -race ./internal/platform/media` | Security patch committed as `11f2ec6` | PASS: media tests including malformed WebP rejection |
| `go test -count=1 <absolute-path-to-webp_dependency_test.go>` from the clean `49bc09f` backend module | Old v0.38.0 dependency | FAIL as intended: recovered out-of-range alpha-plane panic; establishes regression |
| `make -C apps/backend verify` | Clean `5dddf12` | PASS: package tests, race tests, vet, staticcheck, govulncheck and all commands build; observed package results were not cached |
| `make -C apps/backend integration-postgres` with disposable `TEST_DATABASE_URL` | Clean `5dddf12` | PASS: fresh `-count=1 -race -tags postgres_integration ./...` |
| `pnpm lint` and `pnpm build` | Windows-mounted worktree, Node source unchanged | PASS: existing large-chunk build warning remains |
| `node --test .github/tests/ci-go-native-dependencies.test.mjs scripts/backend/p2p-parity.test.mjs` | Clean `caa577e`, Node 22.23.2; also Windows Node 24.19.0 | PASS: 8 tooling guards, including complete errors/omissions, ID associations, bounded/sticky WebSocket failures and safe summaries |
| `pnpm backend:parity:p2p` | Clean `caa577e` | FAIL: both implementations completed 20 HTTP and 19 WebSocket observations; 3 HTTP error-body key mismatches, all other observations matched |
| `node scripts/backend/p2p-parity.mjs --go-binary /usr/bin/false` | Clean `caa577e` | FAIL as intended: Node characterization succeeds, non-server binary fails Go startup; no false passing result |
| `go mod tidy -diff` in `apps/backend` | Clean `caa577e` plus only the direct-`x/image` classification patch described above | PASS after correcting the classification; no sum or version change required |

`govulncheck` reports no reachable vulnerable symbols after the upgrade. Its
full-package scan also reports one imported-package and four required-module
advisories with no observed call path; this is not a claim that every dependency
has zero published advisories.

## Observed P2P Compatibility Gaps

The remaining failing fixture names are `create-missing-body`,
`create-invalid-json`, and `create-trailing-json`. All return HTTP 400 on both
implementations, but their JSON object keys differ. Node's pre-handler Fastify
JSON parser supplies framework error responses; the Go candidate's bounded
decoder supplies its existing fixed `error` response. These are external
compatibility differences, not transport startup failures or ignorable metadata.

No response fields were stripped to manufacture parity, and no raw parser error
or request-body reflection was added to Go. Choose and review a stable,
content-free error contract before changing either implementation, update the
OpenAPI characterization and compatibility transition if necessary, then rerun
the same failing fixtures. Do not mark this capability `parity` on the strength
of the 19 matching WebSocket observations alone.

The runner's CI tests exercise the validator itself; they do not replace the
separately failing Node/Go comparison. The initial comparison does not inspect
headers, WebSocket close codes, TURN variants, expiry/reconnect, oversized input,
browser fragments or storage/log contents. It uses synthetic frames and discards
child logs; passing rejection cases is not proof of log/storage privacy.

## Baseline Failures And Remaining Gates

- The initial full `go test -count=1 ./...` in the dirty Windows worktree failed:
  the pre-existing Avatar draft has an undefined repository and unused symbols;
  the pre-existing Echo draft has replay assertions and a nil-dereference failure.
  Those files remain their author's work. The clean-checkout Go passes above do
  not validate those drafts.
- `pnpm test` on the Windows-mounted directory failed 11 existing Web cases at
  their 5-second timeout (686 passed, 2 PostgreSQL cases skipped). A first clean
  Linux run reduced this to one large custom-emote timeout (696 passed, 2
  skipped). `pnpm --filter @duallane/web test --maxWorkers=2 --reporter=dot`
  in the Linux-native validation checkout also failed that same existing
  5-second case: `workspace-custom-emotes.test.js:612`, allowing more than 20
  collections and 500 locally metered emotes (696 passed, 2 skipped). The replay
  began on `49bc09f`; the isolated checkout advanced to `5dddf12` while it ran,
  but Node source and lockfile are identical between those commits. Agent SDK
  tests passed separately (8 cases). No assertion or timeout threshold was
  weakened. Node's two PostgreSQL cases were skipped without its database test
  configuration; passing Go PostgreSQL tests does not cover those Node cases.
- Attempts to start the parity baseline in the Windows-mounted directory timed
  out without completing characterization. The clean Linux-native `caa577e`
  replay above successfully started both processes and established the actual
  contract differences. The mount-related startup failure is not parity evidence.
- Full browser privacy/fragment, storage/log absence, exhaustion, image-build,
  gateway/cutover, production observation and rollback rehearsals are NOT RUN
  for this slice. Local handler/schema tests do not replace those gates.
- No production route, writer, claimer, migration ownership or ledger status was
  changed. No deployment, remote push, PR merge, or production inspection was
  performed.

## Cleanup And Handoff

The task-owned PostgreSQL container was stopped and auto-removed after tests;
its synthetic database was disposable and is not retained for recovery. No
production database or container was affected. Final inspection found no
remaining Node/P2P test processes or parity temporary directories. The isolated
validation checkout/toolchain remains available for replay; temporary parity
patch copies were stashed only inside that validation clone, not this branch.

The protected Workspace diff and all ten initial untracked draft files were
hash-checked unchanged before handoff. All candidate changes remain local commits
on `codex/go-backend-architecture`; no push is implied by this record.

Next: complete P2P behavior parity and the privacy/two-browser gate, then prepare
an independently reviewed candidate routing/rollback slice. Resolve the excluded
Workspace drafts as separately owned work, not as incidental cleanup here.
