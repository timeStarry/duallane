# Backend Pre-deployment Completion Work Record

## Objective And Authority

User request: complete the Go backend refactor's pre-deployment work and submit
a pull request. Base `25121ae`, branch `codex/go-backend-architecture`; fetched
`origin/main` is `b6dd0c66ed00a7c6a6f252cac537b43ef262e743` (already an ancestor).

The acceptance boundary is a fully implemented, integrated, reviewed and tested
candidate release, with deployment/rollback tooling and an accurate PR. No
production deployment, merge, data import, external notification delivery or
production ownership transition is authorized. Keep Node rollback support until
the separately authorized cutover and observation window. The canonical owner
ledger remains [Evolution](../EVOLUTION.md); this is implementation evidence and
a work queue, not a second owner ledger.

Observable behavior remains the existing P2P/Workspace/SDK contract. Every
deviation requires an explicit compatibility/security decision and tests. P2P
remains transient and isolated from database/storage credentials. Workspace
retains server authorization, quota-before-body, retention, idempotency, audit,
event and object-reference invariants. All rehearsals use disposable synthetic
state; historical SQL migrations are immutable.

## Ordered Acceptance Queue

Unchecked work is not complete, and a test command listed here is not evidence
that it passed. Each accepted slice records exact commits and commands below.

- [ ] Close P2P error/HTTP/WebSocket parity and privacy/lifecycle gaps.
- [x] Run browser P2P text/file/fallback/fragment acceptance against Go.
- [ ] Complete and integrate Avatar, Emote, Bot Gateway and Echo candidates.
- [ ] Inventory all active Node endpoints, jobs, maintenance operations and Go
      composition; account for each capability without placeholder services.
- [ ] Prove Workspace auth/read/write/realtime and extended-domain compatibility,
      including persisted effects, audit, retries, concurrency and permissions.
- [ ] Prove local/S3 object and native media compatibility, failure cleanup and
      resource bounds.
- [ ] Complete worker delivery/leases, cross-process presence, cleanup and
      maintenance command ownership; test with synthetic local providers.
- [ ] Rehearse Node/Go bootstrap, upgrade, schema coexistence and rollback.
- [ ] Build candidate images and validate private-container/gateway configuration,
      readiness, failure refusal, restoration and application rollback.
- [ ] Restore a passing whole-tree baseline, run required Go/Node/PostgreSQL/
      browser/container gates, and independently review the aggregate diff.
- [ ] Update durable backend/Agent/operator guidance and release compatibility
      notes without claiming production is already Go.
- [ ] Push split commits, submit the PR with exact evidence and review risks,
      and address actionable CI/review failures before readiness.

Production observation and final legacy removal occur after this task's boundary;
they remain explicit operator gates, never fabricated pre-deployment passes.

## Parallel Ownership — Wave 1

All workers read mandatory and owning product/security guides. Workers edit
directly but never stage, commit, switch branches, push or deploy. The lead owns
the shared index, contract decisions, schema, dependencies, command composition,
shared routers, gateway/CI, and handbook integration. No overlapping writes.

| Worker | Owned writes | Acceptance / parent dependency |
| --- | --- | --- |
| P2P safety | New P2P tests, room/envelope tests, parity runner/tests/fixtures | Bounded privacy/lifecycle coverage; parent owns transport error fix, schemas and Node route |
| Avatar | Existing `internal/workspace/avatars` draft; new avatar HTTP/test files | Complete repository/service/transport and focused tests; return router/composition requirements |
| Echo requirements | Existing `internal/workspace/echo/requirements` draft | Complete requirement domain and PG tests; report adjacent Echo integration needs |
| Node emote baseline / schema check | First the emote test fixture only; then new read-only platform migration-check files | Preserve test volume/time limit; return read-only startup schema verification for parent composition |
| Bot Gateway | `internal/workspace/botgateway` only | Real v1 WebSocket and domain adapters; parent owns HTTP/router/commands |
| Emote subscriptions | `internal/workspace/emotes` only | Replace fixed 501 and prove source sync/detach/readonly/quota/reference/audit/event atomicity |

The original Bot Gateway/router, Avatar and Echo drafts were preserved through
the preceding foundation slice. This broader user request brings completion of
those candidate domains into scope. Extend and review their existing intent;
never silently discard drafts or present them as previously validated.

### Parallel Ownership — Wave 2

After parent acceptance of the first bounded slices, the same Luna workers
continue on disjoint scopes: Go P2P browser acceptance; a read-only exhaustive
capability audit; Echo solicitations; Echo releases; Bot Gateway atomic runtime
adapters (including narrow typed message/card transaction seams); and Echo
delivery. The parent now owns Avatar, Emote, files, shared HTTP/command wiring,
dependencies and final validation. Returning a domain package does not establish
that its HTTP route, registry, worker or container has been composed.

## Validation Environment

Use the toolchain and isolation guidance in the
[foundation record](2026-09-06-foundation-contracts.md). Node startup/browser
validation should use a Linux-native checkout in WSL. Do not weaken timeouts or
assertions merely to hide the previous large-emote baseline timeout. Required
database/provider/storage tests must not target a production account or instance.

## Evidence And Handoff

This work is in progress. No acceptance checkbox above is satisfied solely by
the inherited foundation results. Append reviewed slice commits, exact fresh
checks, failures, environment limitations and cleanup as work progresses.

### Accepted Slices — 2026-09-06

- `3998567`: Go now preserves the locked Fastify 5.8.5 safe empty/invalid/
  oversize JSON error contract. The new regression failed before the fix;
  scoped Go race and staticcheck, generated-contract freshness and conformance
  passed after it. Node runtime is unchanged; five Node characterization cases
  passed. Independent clean-process `pnpm backend:parity:p2p` passed 20 HTTP
  and 19 WebSocket observations. Expanded privacy/lifecycle and browser gates
  are still pending; this is not a full P2P acceptance claim.
- `c575549`: composed the real catalog, bounded native processor and Emote
  service in the Workspace command, reusing that service for message references.
  `go test -tags=postgres_integration -count=1 -race ./cmd/workspace
  ./internal/platform/config` passed on disposable PostgreSQL, including real
  session-authenticated HTTP upload, libvips normalization, local read and audit.
  Scoped staticcheck passed. No production writer changed.
- `e58b30f`: bounded legacy local/S3/hybrid reads for pre-registry records,
  without a canonical-key/digest bypass. Storage race tests passed, including
  containment/symlink rejection, cancellation, overage-before-GET and missing-only
  fallback. Staticcheck passed on the adapter before the final canonical-alias
  rejection assertion; the final whole-tree gate remains required.
- `bd9cdc6`: test-fixture-only SQLite batching removes 1,002 standalone writes
  from the large-emote case; runtime, assertions, item/collection counts and
  the five-second timeout are unchanged. Parent independently passed all 21
  focused tests in both mounted and Linux-native checkouts. Clean `bd9cdc6`
  `pnpm test` passed 8 SDK and 702 Web tests, with the two explicitly gated
  PostgreSQL cases skipped. This resolves the previously recorded Node timeout;
  skipped PostgreSQL checks still require their separate gate.
- `e5c1141`: suppress raw native image diagnostics before first libvips startup.
  A fresh-process regression reproduced unfiltered startup logs before the fix;
  media `go test -count=1 -race` and staticcheck passed after it. Typed safe
  domain errors and content-free audit remain the operational error surface.

All PostgreSQL checks above used synthetic data in isolated schemas of the
task-owned disposable database. No production credentials, volumes, providers,
notifications or deployment were used. The original draft domains and new
worker slices remain under review until separately accepted below.

- `d3f12da`: private Workspace/worker readiness rechecks required dependencies
  with a two-second request budget and refuses readiness during shutdown. Local
  storage inspection performs no writes or directory recreation. Scoped race
  and staticcheck passed. A mounted command integration attempt overlapped an
  incomplete worker Emote edit and could not compile; independent clean
  `34e5d5e` command PostgreSQL/race tests subsequently passed.
- `34e5d5e`: expanded P2P privacy/dependency/lifecycle/oversize/header/ICE
  coverage, parser assertions, storage-artifact checks and close-frame parity.
  Parent corrected the worker's initial 1000 close-code assumption: real Node
  sends an empty close frame, observed as 1005. Node characterization passed
  while old Go failed; the corrected candidate independently passed 21 HTTP /
  22 WebSocket observations, fresh P2P/contract race tests, staticcheck and all
  eight parity-runner unit tests. Browser/fragment acceptance is delegated and
  remains open.

### PR And Independent Gates

[Draft PR #2](https://github.com/timeStarry/duallane/pull/2) is open. The first
remote CI at `1dca0d3` passed both Go/PostgreSQL and Node/lint/build/Chromium E2E
jobs. Those existing browser tests run against Node, not the new Go browser
candidate. Clean `e5c1141` also passed `make verify` and a fresh complete
`make integration-postgres` against the disposable task database. These gates
exclude uncommitted worker slices and must be repeated after final integration.

The GitHub connector could not create the PR with its integration permissions;
the already-authenticated local GitHub CLI successfully created the same scoped
draft. No token/permission settings changed. The PR remains draft until every
pre-deployment acceptance item and aggregate review is complete.

### Further Reviewed Slices

- `a048bca`: file promotion and physical deletion now hold the shared digest
  advisory lock through the storage operation and registry mutation. Three real
  PostgreSQL regressions failed before the fix (missing bytes, unlocked deletion,
  premature tombstone); fresh files race/integration tests and scoped staticcheck
  passed after it. Independent clean command integration also passed. Forward
  promotion and detached failure cleanup have explicit two-minute budgets.
- `4d20550`, `418a306`: pinned WHATWG URL normalization and implemented private
  Echo requirements. Thirteen fixtures generated by the actual Node service
  characterize normalization and persisted submit/transition hashes. Initial Go
  JSON escaping and URL normalization failed those fixtures; corrected Go tests,
  fresh PostgreSQL replay/concurrency/race tests, scoped staticcheck and the clean
  fixture `--check` passed. Scoped govulncheck found no vulnerabilities. HTTP,
  command/card registries and Echo delivery are still separate acceptance items.
  **Intentional security difference:** Go rejects bracketed private IPv6 links
  that the historical Node hostname check accepts; existing records are not
  rewritten. This needs explicit release/cutover visibility.
- `e2515e9`, `7d8cc71`: read-only schema compatibility checks run before enabled
  Workspace startup and worker startup/claims, and during private readiness.
  The expected migration set is frozen from the binary's catalog. The PG adapter
  uses read-only transactions, never migration runners, DDL or seeds. Parent
  corrected a test that ignored deferred `Rows.Err()` from PostgreSQL; fresh
  migration/postgres/command integration and race tests passed, including missing
  history refusal before object-directory creation and recovery before claims.
- `a5e84ad`, `eee3fcc`: Emote source subscriptions now synchronize, disable and
  detach with quota, read-only, reference and audit/event rules. Parent reproduced
  an existing rejected-placement transaction retaining an Emote and physical
  object; rejection now rolls back domain writes before a separate content-free
  audit transaction. Canonical Put holds the digest lock and cleanup is bounded.
  Declared upload overage reaches domain auditing without reading the body.
  Fresh Emote PG/race, HTTP/command PG/race and scoped staticcheck passed. HTTP
  checks used the shared working tree, so a clean aggregate rerun is still due.
- `4fe9ebb`: Avatar domain preserves membership/visibility, exact legacy keys,
  bounded native normalization, shared registry references, audit and events.
  Parent corrected forward storage cancellation and removed unsafe direct object
  deletion on bad Put metadata. A real PG regression proves another user's
  shared object survives the rejected upload. Fresh Avatar PG/race and scoped
  staticcheck passed. HTTP contract review and runtime wiring are not yet claimed.

Remote CI for `a79254b` passed both existing jobs. These reviewed commits and
worker slices postdate that run: its result does not validate the final candidate.
All database evidence continues to use task-owned synthetic isolated schemas.

- `702d8d1`: wired the existing Bot REST adapter into the root router, including
  exact Workspace gating and Bearer-only credentials (never browser cookies or
  query tokens). Its HTTP race suite and staticcheck passed independently against
  committed domain code, excluding the worker's draft runtime adapters.
- `0b9c6c1`: composed Avatar service and routes using the same bounded media
  processor and local/S3/hybrid store. Real session-authenticated native-image
  upload/read/remove and audit checks passed with PostgreSQL, as did HTTP/race
  and scoped staticcheck. The actual Node raw-stream route returns
  `400 avatar.invalid_size` on both declared and chunked overages; a new Node
  characterization proves this, and the old Go 413 expectation failed before
  correction. The fixture verifies chunked requests really omit Content-Length.
- `91847ca`: introduced the narrow `ReserveAgentBotUpload` domain entry point.
  It revalidates an active custom bot and active membership inside the quota
  transaction; ordinary human file APIs still reject Bot identities. PG/race
  covers concurrent quota contention, paused/removed identities, revocation
  between preflight and reservation, atomic audit failure and refusal to grant
  content completion. Unauthenticated reservations no longer trigger stale
  cleanup. Scoped staticcheck passed. **Existing product limitation:** Node's
  Bot endpoint reserves metadata/quota but does not provide a Bot content upload
  channel. A refactor must not silently invent that permission or claim it works.
- `e8bd0de`: preserves explicit empty `duplicateOfPublicId` versus omitted/null
  in Echo transition hashes. The Node fixture set now contains 15 cases; the old
  Go implementation failed the empty-string golden, and corrected unit/PG/race,
  replay side-effect checks, staticcheck and independent Node `--check` passed.
  Future HTTP/command adapters must carry string-field presence into the service.

Independent clean `33ba294` passed fresh `make integration-postgres` and
`make verify` (unit/race/vet/staticcheck/govulncheck/build). Govulncheck reported
zero reachable vulnerabilities, with one imported-package and four required-module
advisories without an apparent call path; do not describe this as zero advisories.
Remote CI for that commit also passed both existing jobs. Newer commits and
uncommitted workers still require the final aggregate gate.

Echo releases' first draft is **not accepted**: parent review found persisted
snapshot escaping, version-case and ID-prefix differences. The worker is revising
it against the actual Node service. No release, solicitation, delivery or Bot
runtime acceptance is implied by this work record until recorded separately.

- `777fc84`: each file part/single/assembled upload now uses an independent
  request-attempt object before publishing under the upload lock. Three real PG
  regressions first failed: a failed duplicate deleted a committed part, a slow
  conflicting part overwrote/deleted the winner, and concurrent whole uploads
  shared staging so neither could complete. Fresh complete files PG/race and
  scoped staticcheck passed after the fix. Revalidation follows the locks;
  cleanup cannot remove a committed part or another request's staging. Forward
  publication and detached cleanup have two-minute budgets. Crashes can still
  leave attempt objects: bounded age cleanup excluding active uploads remains
  an explicit maintenance gate, not a claimed completed feature.
- `4fdf9ed`: four real Go P2P Chromium cases passed independently on the clean
  validation clone with the exact reviewed browser patch (13.1 seconds): direct
  text/file, encrypted fallback/ack, malformed fragment, and valid-format wrong
  key. The initial wrong-key assertion expected a visible warning, but the
  current chat UI does not render that internal error state; the corrected test
  observes actual WebCrypto rejection, no delivered plaintext and disabled file
  transfer, without changing application behavior. CI now runs a separate Go
  browser job and excludes the suite from Node's default runner. No P2P failure
  artifacts are uploaded. Thirteen tooling/runner tests and the three Playwright
  files' TypeScript check passed. The check also corrected the existing default
  config's `reducedMotion` placement into `contextOptions`. A new remote CI result
  and final aggregate gate remain due; this is not deployment evidence.

### Runtime Review And Browser Baseline Correction

`0be0335` adds Bot domain adapters with typed card/message transactions. Parent
independent fresh PostgreSQL/race tests passed for botgateway, messages and cards;
staticcheck first found two unused message wrappers and passed after their
removal. The fault tests cover card/message audit failure, the final idempotency
insert failing, concurrent replay and token revocation before commit. Narrow Bot
file reservation also passed with the runtime adapter. This does **not** accept
the draft WebSocket, runtime command wiring, arbitrary JSON request hash parity
or Node's Feishu conversion. Those remain explicit Bot integration gates.

Remote CI for `f4ab6d9` passed Go/PostgreSQL and all four Go P2P browser cases,
but the Node Chromium job failed on the topic unsync click; local whole-suite
results were 16 passed / 1 failed. Fresh local `make verify` passed with cached
unchanged package results and the same unreachable dependency advisories noted
above. No full green result is claimed for this commit.

The original default Playwright config used an unsupported top-level
`use.reducedMotion` option. Moving it into `contextOptions` in `4fdf9ed`
unintentionally changed the legacy browser environment. In reduce mode, the
topic click failed three out of three diagnostic repetitions: pointer-down
and pointer-up hit different rows, no DELETE request was sent, and adding an
explicit hover did not fix it. Removing the newly effective option restored
the previous default motion behavior; the unchanged test then passed three out
of three repetitions. Keep the old gate's effective environment rather than
altering application behavior in a backend test split. The reduced-motion
topic interaction remains an identified UI/testing limitation, not a fixed
backend issue. Go P2P keeps its own explicit reduce setting and passing gate.
Temporary click diagnostics/hover experiments were confined to the disposable
validation checkout and removed; no debug code or failure artifacts are committed.

Remote CI for `36cc4d9` passed the full Node job (including Chromium) and the
four Go P2P Chromium tests. Go unit/race passed, but staticcheck found two
WebSocket-only error helpers accidentally included in the preceding runtime
commit while their consumers remained uncommitted. The helpers now belong to
the draft WebSocket file. Independent staticcheck on clean `36cc4d9` plus only
this removal passed for botgateway, messages and cards. A new aggregate run is
still required. The local whole-browser rerun also recorded a separate failure
waiting for `workspace-e2e-history-27`; do not report it as a local full pass or
hide it behind the successful remote run.
