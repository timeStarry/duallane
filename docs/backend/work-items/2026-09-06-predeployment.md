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

### Release Domain Acceptance

The reviewed release slice now preserves all six checked-in Node guide snapshots
and hashes, a synthetic Unicode/escaping guide, version casing, ID prefixes and
publication lock keys. The final independent Node fixture check passed (six
catalog entries plus one synthetic guide); fresh PostgreSQL/race tests passed
after removal of the standalone delivery-state mutator (8.606 seconds), and
integration-tag staticcheck passed. Publication, pending recipient rows and
metadata audit remain one transaction; duplicate publication is version-keyed.
Delivery claiming, state transitions and message/card effects belong exclusively
to the Echo delivery coordinator. This accepts the release domain foundation,
not command wiring, delivery execution, production ownership or deployment.

All three remote CI jobs passed for `50f8224`. Later worker changes and the
Bot raw-JSON compatibility patch still require their own final aggregate gate.

### Bot Persisted Idempotency Compatibility

The Bot message/card HTTP adapters now carry bounded raw JSON subtrees into
the hash boundary. The operation envelope keeps its fixed Node field order;
client subtrees retain insertion order, integer-index ordering, duplicate-key
semantics, binary64 formatting and UTF-16 string escaping. Raw inputs remain
subject to domain validation and cannot hash one decoded value while writing
another. Message trim/length now uses Node's ECMAScript trim and UTF-16 budget;
an explicit empty/non-string reply ID is no longer treated as omitted.

Independent actual Node service/SQLite characterization passed 18 operations
and 266 JSON edge cases. Fresh Go PostgreSQL/race passed for botgateway and
httpapi (15.725 / 3.183 seconds); the new PG regression imports Node hash
records, retries twice, tests conflicting payloads, and verifies unchanged
message/card/event/audit counts. Integration-tag staticcheck passed. The raw
parser's deep-input regression and 15-second two-worker fuzz run passed
(211,098 executions). Parser rendering uses one output buffer so container
nesting does not multiply serialized copies. CI now also verifies the actual
Node requirement, release and Bot persisted-contract fixtures.

This is hash/replay evidence, not complete Bot HTTP/WS parity, Feishu conversion
or runtime composition. In particular, lossless response/payload round-tripping
of unpaired UTF-16 surrogates is not established by the hash tests; the Go domain
uses Unicode scalar strings. Keep that distinction in aggregate compatibility
review rather than treating matching hashes as proof of every DTO byte.

### Cross-Process Presence Foundation

The additive `031_workspace_presence_leases.sql` migration stores only short-lived
connection metadata. Authenticated human realtime connections register after
successful replay, renew on heartbeat, and remove their own random lease on
disconnect. Current membership and expiry are checked in PostgreSQL; another
connection cannot be removed by an old socket's cleanup. Lookup errors defer
immediate email jobs instead of treating an uncertain result as offline.

Independent fresh PostgreSQL/race checks passed for presence, realtime, email
and migrations (12.249 / 11.049 / 4.300 / 10.944 seconds), including a real
pre-031 schema upgraded with existing members, concurrent connections, revocation
and bounded expiry cleanup. Integration-tag staticcheck passed. Runtime injection
and worker scheduling are a subsequent composition slice, not accepted by these
domain tests. The local Node aggregate rerun failed 12 tests and is being triaged;
it is not counted as a passing gate.

Remote CI for `30fc0ef` subsequently passed all three jobs, including Node
unit/lint/build/Chromium, Go PostgreSQL/race/analysis, and Go P2P browser privacy.
The separate local avatar characterization reproduced a default five-second
test timeout; no contract assertion failed in that isolated result. The local
aggregate remains a recorded failure, not a pass inferred from remote CI.

The next composition slice injects PG presence into the actual Workspace
realtime handler and email worker, and adds explicitly opted-in bounded expiry
maintenance. Independent fresh PG/race passed for Workspace, worker and config
(7.247 / 4.202 / 1.027 seconds). It tests two real WebSockets, independent lease
cleanup, online email deferral, a failed presence-table lookup with job storage
still available, and a 100-row sweep that preserves active leases. Initial
config testing caught whitespace accepted by the generic environment helper;
the new flag now compares the raw value with `true` and the exact-value
regression passes. No external mail was sent, and no production worker was
started. Deployment/Compose wiring remains a separate gate.
Integration-tag staticcheck also passed for the three composition packages.

### Local Node Gate Follow-up

Remote CI for `d018bc6` passed all three jobs. Locally, the default WSL disk-backed
temporary SQLite run was not usable as a passing gate: a four-file, one-worker
rerun took 1,439.73 seconds and failed 67 of 227 tests, including timeouts,
cleanup errors and downstream HTTP assertions. The same isolated avatar case
failed its unchanged five-second budget with disk-backed temp files but passed
in 779 ms with command-local `TMPDIR=/dev/shm`. This affects only synthetic
temporary fixtures, not application storage or production configuration.

The first full RAM-temp run passed 702 Web tests but exceeded one realtime
replay test's existing 15-second budget while other validation was running.
That case passed independently in 7.949 seconds. A fresh full
`TMPDIR=/dev/shm pnpm test` then passed: SDK 8, Web 703, with the two optional
PostgreSQL tests skipped by the default command. No timeout, assertion, retry
or global environment setting was relaxed. This replaces the local unit gate
failure with completed evidence, not the separate whole-browser or dedicated
Node PostgreSQL gates.

### Pinned SQL Generation Boundary

`sqlc` v1.31.1 is pinned in the Go tool graph and generates the existing
presence predicates from the canonical PostgreSQL migrations. No historical
migration or production ownership changed. The generated package is nested
inside presence so other domains cannot use its methods to bypass that service.
The adapter retains stable authorization errors and validates the batch bound
before conversion to the generated 32-bit parameter. Scoped LF attributes keep
generation byte-stable across Windows and Linux.

Independent Linux validation of the reviewed candidate plus this slice passed
`make verify`: generation freshness, unit/race tests, vet, staticcheck,
govulncheck and command builds. Govulncheck reported zero called vulnerable
symbols, with one imported-package and four module-level advisories not reached
by this program; this is not a claim of an advisory-free dependency graph.
Fresh PostgreSQL/race tests passed for presence, auth, Workspace and worker
(5.305 / 3.388 / 4.710 / 4.382 seconds), followed by integration-tag staticcheck.
The final adapter input/UTC regressions passed separately with `-count=1 -race`.
`go list -deps ./cmd/...` contained no sqlc, SQLite, MySQL or wazero package.
The initial query-test setup exposed a missing OAuth checksum after adding the
tool; `go mod tidy` repaired the manifest graph before the passing runs.

These checks include the tool-induced OAuth v0.34.0 and protobuf v1.36.11
updates, but exclude ongoing SMTP, Bot, Echo, Feishu and maintenance drafts.
They establish this query/tool boundary only, not whole-candidate acceptance.

### Executable Route Inventory

The actual disabled Node application confirmed 164 literal public declarations
from its entry point and six route modules. The generator captured 153 HTTP
disabled responses, all the existing safe 503 envelope. Two inventory unit tests
and a fresh actual-Node `--check` passed. CI now checks inventory freshness;
implicit HEAD and static-plugin paths are explicitly outside its scope.

An independent, not-yet-accepted Go registration test against the reviewed
candidate reproduced 19 missing registrations: 16 Echo paths, two owner Bot
connection paths and `/ws/bot-gateway`. A separate gate-response comparison
passed 153 paths across five non-enabled flag values without actor resolution.
This demonstrates why matching disabled responses alone cannot prove route
composition. The failing registration regression remains in the integration
queue until those worker slices are accepted; it is not hidden by an allowlist
or counted as a passing candidate gate.

### Bounded Upload Maintenance Foundation

The reviewed cleanup slice adds a one-shot upload maintenance service with PG
keyset pages, upload/quota locks, a decisive current-activity check, atomic
failure/quota/event/audit updates and post-commit staging cleanup. Terminal
artifact enumeration is explicit. Storage exposes only per-upload attempt
paths and a separate age-bounded Workspace multipart abort operation; it does
not scan or delete canonical CAS objects. No scheduler is started here.

Parent review reproduced a local pagination bug: filesystem-order `ReadDir`
followed by a lexical cursor returned only two of five synthetic attempt keys.
The adapter now reads fixed-size chunks, keeps a bounded sorted page and checks
cancellation during enumeration. The same regression passes. Parent review
also prevented new storage operations after cancellation, pruned completed
attempt cursors, made the age fixture independent of wall-clock date, and kept
hybrid multipart cleanup exclusively on the primary store.

Independent fresh PostgreSQL/race passed for files and storage (45.907 / 7.432
seconds), including a barrier-controlled touch winning after candidate selection,
quota release and exact audit/event counts. Integration-tag staticcheck passed.
Additional S3 loopback regressions verify exact prefix, age, continuation,
missing timestamp/cursor refusal and cross-upload deletion refusal; fresh storage
race tests then passed in 3.109 seconds. These are synthetic local/S3-protocol
checks, not cloud IAM or production bucket evidence.

Worker scheduling, fair cursor continuation across bounded periods, and real
candidate-container rehearsal remain separate composition gates. The default
reservation age is 30 minutes and multipart age is seven days; a five-minute
loop interval is not an object-age cutoff.

### SMTP Transport And Lifetime

The selected go-mail implementation is now pinned at v0.8.1 (MIT), with
x/crypto v0.55.0 selected by the unified module graph. Parent review rejected
the first cancellation adapter because the library's `Close` sends QUIT and
cannot safely stand in for concurrent raw-socket cancellation. The corrected
adapter tracks and closes its owned connection on cancellation and failed Dial,
and clamps every phase's socket deadline to the absolute operation budget.

Synthetic loopback regressions cover trusted/untrusted implicit TLS, mandatory
STARTTLS, authentication only after encryption, multipart plain/HTML output,
header rejection, safe provider errors, failed-Dial cleanup and indefinitely
stalled greeting/TLS/auth/DATA/QUIT phases. Cancellation tests use barriers,
not short provider sleeps that could finish within the assertion timeout.
Independent fresh PostgreSQL/race tests passed for email, worker and Workspace
(21.703 / 8.289 / 6.937 seconds); integration-tag staticcheck also passed.
Scoped govulncheck for email and both composition commands found zero called
vulnerable symbols, while reporting one imported-package and seven module-level
advisories not reached by those programs; the dependency graph is not claimed
to be advisory-free.
No actual SMTP provider, production credential or external recipient was used.

### Real Go Workspace Browser Harness

The new browser harness builds the real Go migrate/Workspace commands, applies
canonical migrations to its own random schema in explicitly opted-in disposable
loopback PostgreSQL, and reuses the existing frontend assertions. Provider
workers are disabled and runtime environment inheritance is allowlisted. Two
harness guards passed. The first selected semantic-routes/OAuth/refresh/history
case passed (21.7 seconds). A subsequent six-case run passed four and failed
two: the emote share card lacked its live sharing projection, and the two-user
flow timed out at the Beacon header's bounding-box observation after visibility
passed. Neither assertion nor its timeout was weakened.

The first failure was traced to Go message projection emitting only `shareId`
where Node also emits relation-bound, viewer-specific share metadata. A worker
is implementing and characterizing that projection. The second failure still
requires diagnosis. After both runs the synthetic browser schema count was
verified as zero; the first run's temporary directory and Go child processes
were also verified absent. These partial results are not the full twelve-case
Workspace browser gate. The harness guard is wired into CI; the actual Go
Workspace browser job awaits successful full-suite integration.

### Echo Solicitation Domain And Shared Transaction Review

The solicitation domain now characterizes create/publish/close/withdraw/vote,
owner-only voter/delivery projections, revision and idempotency behavior, and
content-free audit/event effects. The actual Node persisted-contract generator
passed all twenty cases. Independent fresh PostgreSQL/race initially passed
requirements/releases/solicitations (15.253 / 8.472 / 28.993 seconds), but parent
review found that the new transaction-scoped solicitation APIs still read
conversation membership through another pool connection.

A real PostgreSQL regression first reproduced that uncommitted conversation
revocation still permitted projection and created a vote. Both paths now use
the caller's typed transaction. Accepting membership reads hold share locks;
all three Echo transaction adapters similarly pin actor membership and identity
until completion. PostgreSQL NOWAIT regressions verify those protections.
Fresh PostgreSQL/race then passed the three domains (7.875 / 4.806 / 17.350
seconds). The shared card adapter now requires one typed solicitation view,
avoiding conflicting card/domain method signatures and removing pool fallbacks.
Its regression preserves the actual Node use of `card.revision`. After that
change solicitation PostgreSQL/race passed again (14.139 seconds), followed by
integration-tag staticcheck. Three unused delivery-write helpers left by the
ownership separation were removed after staticcheck identified them.

These are domain and adapter gates only. The HTTP routes, nonempty Echo
automation registry, outer card rejection-audit policy, delivery worker and
real composition still require separate acceptance. A domain rejection marker
does not authorize committing unrelated prior writes in an outer transaction.

### Echo Delivery Candidate Review

The delivery coordinator and sixteen thin Echo HTTP declarations are now
reviewed as a candidate foundation, not yet mounted in the application. Delivery
claims, direct-conversation creation, typed card/message handoff, state and
content-free evidence share the accepting transaction. Failed domain writes
roll back before a separate failure record; a late failure cannot overwrite a
concurrently completed delivery. The actual card/message writer remains a
composition gate, not a success inferred from a fake writer.

Parent review corrected three execution gaps: requirement recovery selected an
empty submitter instead of all requirements; permanent first-page sent/exhausted
rows could starve later work; and lease callbacks captured the outer context
instead of the bounded lease context. Work now uses explicit ID cursors, returns
partial progress, wraps at the end, and supports separately budgeted family
processors. The worker must retain each family's cursor between periods. A
single combined one-shot call is not a fairness guarantee between busy families.

The accepting requirement delivery rechecks current owner-or-submitter access,
and member/identity share locks protect authorization through commit. Existing
conversation creation uses compatible share locks instead of lock upgrades;
new deterministic IDs also include the space. Public operational JSON preserves
Node's lower-case fields, publicId/version distinction, explicit successful null
references and replay flag. It never includes the private card payload.

Independent fresh PostgreSQL/race passed (6.467 seconds), including three pages
for each delivery family and transaction-local role demotion. Unit regressions
cover cancellation before an unfinished row, cursor continuation/wrap, separate
family selection, the lease callback deadline and status-dependent public JSON.
Echo HTTP/race passed (1.138 seconds), followed by integration-tag staticcheck
for both HTTP and delivery. Six capitalization findings were corrected before
the passing staticcheck run. Real command/router composition, actual Node/Go
delivery effect fixtures and the full Workspace browser gate remain open.

### Message Share And Bot Conversation Projection Review

The message, conversation latest/pin, and realtime read paths now hydrate emote
share previews from persisted message junctions and viewer-specific remarks.
Client-supplied share metadata is discarded. The reader independently checks
active Workspace and conversation membership, including uncommitted removal in
the caller's transaction. Covers use only the trusted catalog or the authorized
custom-emote content endpoint. Static custom covers retain Node's explicit
`animated: false`; built-in covers omit that field. Invalid typed message JSON
fails closed instead of falling back to untrusted raw content.

Realtime direct-conversation projection now preserves `otherMember`, its Bot
kind/description and viewer-facing title. This corrects the Beacon header
replacement that the isolated two-user browser rerun reproduced at the missing
BOT label, clarifying the earlier bounding-box timeout. The existing ordinary
conversation Bot projection is also covered by a focused regression.

Independent fresh PostgreSQL/race passed messages, conversations and events
(8.031 / 2.983 / 2.931 seconds), followed by integration-tag staticcheck. These
are read-projection gates; trusted catalog composition and the unchanged full
Go Workspace browser suite remain separate acceptance steps. CI for the prior
delivery commit `89b1449` passed all three existing jobs; it does not cover these
new local changes or establish complete Go Workspace parity.

### Native Media Owner Compatibility

The differential corpus calls the actual Node avatar/custom-emote services,
using Sharp only to generate synthetic inputs and inspect normalized output.
The Go probe runs the real govips processor. Twenty-seven initial cases passed
independently, including orientation, metadata stripping, transparency, GIF/
WebP animation, BMP, declared-MIME mismatches, byte/pixel/edge/frame/duration
limits and malformed data. Every accepted output receives sampled pixel and
alpha comparison as well as format, dimensions and animation metadata checks.

Parent review added a deterministic high-entropy 180-frame GIF which reaches
the actual 2 MiB output-overage rejection after fallback compression. This
first failed because Go's public rejection copy differed from Node. The copy
was corrected without changing either runtime's limits or conversion settings;
all 28 cases then passed (16 accepted, 12 rejected, 16 pixel comparisons;
60.421 seconds). The test requires that this fixture reaches the named owner
rejection, so two accidental acceptances cannot count as boundary evidence.

Independent final media/race passed (2.312 seconds), followed by staticcheck.
The corpus is now part of the native-dependency CI job. Local evidence used
Node 22.23.2, Sharp 0.35.3 with bundled libvips 8.18.3, Go 1.26.8 and system
libvips 8.15.1. Queue cancellation, slot release and output overage are covered;
interrupting an already-running native libvips call is not claimed. Imported
emote assets were untouched, and all generated media/database objects were
synthetic and removed by the harness.

### Upload And Multipart Maintenance Composition

The opt-in worker now composes stale-upload/staging cleanup only when both
Workspace and maintenance are enabled. It retains upload keyset and bounded
attempt cursors across periods, advances past attempted transient failures,
preserves unfinished work on cancellation, and wraps only at the end.

Parent review split upload and multipart maintenance into independent
processors so slow staging I/O cannot consume the multipart worker's entire
budget indefinitely. Upload work keeps its 30-second cycle and 15-second object
budgets; multipart keeps the existing six-hour cadence and a separate bounded
provider call. S3 readiness is also bounded. A scheduler regression proves
multipart runs while upload processing is blocked and both join on shutdown.
The S3 adapter now returns its last finished record on mid-page cancellation,
not the provider's whole-page successor, and starts no further provider I/O
after cancellation. HTTP provider tests retain prefix/age/cursor coverage.

The worker's initial PostgreSQL test was skipped by its author because the
environment was not configured. Parent then independently ran the real
disposable PostgreSQL tests, including two composed workers racing on one
stale upload: exactly one failure event and one content-free audit persisted.
After the review corrections, fresh PostgreSQL/race passed worker, files and
storage (2.944 / 18.493 / 4.585 seconds), followed by integration-tag
staticcheck. No production worker was started. Node's S3 multipart timer remains
the current owner; the deployment handoff must disable it before enabling the
candidate maintenance worker.

### Card Action Transaction Isolation

Card actions now run domain writes, payload validation, card revision CAS and
events inside a savepoint on the original typed transaction. A controlled 4xx
rejection rolls those effects back before the outer transaction records the
failed action and content-free audit. Infrastructure errors, including a
registered payload validator failing unexpectedly or a savepoint unwind
failure, abort the entire transaction. Savepoint identifiers use a bounded
digest of the action-run ID, avoiding PostgreSQL identifier truncation.

Independent fresh PostgreSQL/race passed (4.856 seconds) and integration-tag
staticcheck passed after parent review corrections. Regressions cover domain
writes followed by rejection, revision conflict, invalid action output and
unexpected validator failure. Trusted action executors can explicitly report
that they already wrote the domain action event, avoiding a duplicate generic
event; the original stored payload JSON is available to typed executors for
order-sensitive adapters. This is the safety boundary, not evidence that all
Echo or Feishu card definitions have been composed.

### Bot Owner Connection API

Owner connection reads and tests now expose a typed public projection without
gateway nonces, credentials or socket state. Missing durable configuration is
repaired as in the Node owner service. The test operation rechecks ownership
inside the lifecycle transaction, clears only connection error state, and
commits its content-free audit atomically. Audit failure preserves the previous
error projection; removed members cannot mutate it.

Parent ran the actual Node route/service fixture against disposable SQLite and
corrected the initial Go request-body restriction: omitted or valid JSON bodies
are ignored, including objects, null and scalars; malformed/empty declared JSON
is rejected. Go retains its bounded JSON parser and established safe error
envelope, not Fastify's framework-specific parser error shape. No request-body
fields enter the typed owner operation. Fresh PostgreSQL/race passed the Bot
package (4.170 seconds); focused HTTP/race passed (1.219 seconds), followed by
integration-tag staticcheck. WebSocket shutdown and application composition
remain independently validated changes.

### Read-Only Storage Operator

The candidate storage command can obtain one repeatable-read/read-only
PostgreSQL snapshot and verify canonical objects through local or S3 read-only
adapters. Parent review added explicit catalog row limits, cancellation-aware
verification, signal handling and secret-safe flag diagnostics. Manifest
assertions never mark a run mutation-ready; a live runtime fence remains a
separate required integration. No backfill or finalization is enabled here.

Independent fresh PostgreSQL/race passed storageops and its real command
(5.618 / 1.310 seconds), followed by integration-tag staticcheck. A newly
generated actual Node backfill/verify fixture then passed Go canonical-byte
verification: one object, 37 bytes, zero failures and zero Go mutations.
See [Storage operator](../STORAGE_OPERATOR.md) for the durable operating contract,
including the distinction from Node's timestamp-writing dedupe verification.

### Composed Bot Transport And Workspace Browser Gate

Workspace now composes the actual Bot Gateway runtime adapters, shared card/
message transaction bridges, owner connection provider and gated WebSocket
transport. Trusted catalog lookup is wired into message/conversation/event
share projections. Gateway shutdown closes admission, cancels operations and
waits for admitted handlers plus nonce-scoped durable cleanup. Independent
bounded cleanup contexts do not inherit the canceled application root; failures
aggregate to a safe sentinel. The application waits before closing PostgreSQL.

Parent independently ran fresh PostgreSQL/race for gateway and the actual
application (9.003 / 3.177 seconds), followed by integration-tag staticcheck.
The application test issues a real owner token, opens the routed Bot WebSocket,
reads/tests its connected projection, calls application Close, then verifies the
disconnected row through an independent connection after the pool is closed.
The actual Node WebSocket fixture also passed its checked-in transport goldens.

The unchanged full Go Workspace browser suite then completed: five of twelve
tests passed, seven failed (2.2 minutes). Share preview, emote subscriptions,
semantic navigation and focus checks passed. Open failures are four Echo
command/workflow cases, gateway message creation returning 401, inline topic
creation not producing a topic, and a durable unread count remaining two after
the UI cleared it. The two-user test now passes the previously failing Beacon
header and reaches the unread check. These failures are acceptance work, not
waivers or reasons to relax browser assertions. The PR remains draft.

### Validated Ordered Card Payloads

The card registry now offers an explicit raw-JSON canonicalizer for registered
order-sensitive card types. Both input and canonical output pass generic byte,
depth, node, text, field-name and URL/content checks. Only the registered
validator's cloned output is preserved; unknown types and definitions without
the callback follow ordinary domain normalization instead of storing raw input.
Create/update inputs accept this optional internal raw field without changing
the public API. Status-only actions and invalidation preserve existing payload
order; invalid persisted JSON fails instead of being silently replaced by an
empty object.

Independent fresh PostgreSQL/race passed (4.950 seconds), followed by
integration-tag staticcheck after removing a redundant decode found by analysis.
Tests exercise create, resolution, update, action and invalidation against real
PostgreSQL, retaining member order and escaped lone UTF-16 code units. Unit tests
cover input/output safety and mutable-buffer isolation. Actual Feishu conversion,
gateway ingress and card-action bridge acceptance remain separate gates.

### Inline Group Topic Transaction Bridge

The normal message entry point now recognizes eligible leading topic syntax
through a trusted adapter. The message and topic PostgreSQL adapters share one
transaction, retaining their typed domain surfaces. Authorization and normalized
content precede conversion; replies and mixed/non-text content remain ordinary
messages. The original client key is acknowledged only in the response, while
storage and events retain the topic-card key. Stable locks serialize ordinary
versus topic-shaped requests and direct versus inline topic creation.

Fresh independent PostgreSQL/race passed messageblocks, topics, messages and
the application (6.114 / 3.766 / 13.295 / 5.728 seconds); focused staticcheck
passed. Regressions cover eight concurrent retries, changed intent, mixed
content/replies, competing request shapes and a late card-write failure that
rolls back topic, member, message, event and success-audit effects. Twenty
actual Node parser goldens verify whitespace, balanced parentheses, code-point
limits and raw body byte limits. Topic creation intentionally retains Node's
existing notification behavior; the transaction bridge does not add delivery.

The unchanged two-member topic browser test now passes topic creation but stops
at the group card display. Registry composition and the remainder of that full
browser workflow remain required; this slice is not a topic parity completion.

### Registered Topic Cards And Full Browser Workflow

The actual Workspace application now registers the created-topic and synced-
message card definitions. They project only the allowlisted Node fields, retain
the generic no-public-URL limits, and rely on the existing card membership
authorization. Twenty-seven actual Node validator goldens cover payload shape,
numeric coercion, preview limits, control handling and invalid references.

Fresh independent PostgreSQL/race passed topics, messageblocks and application
composition (3.134 / 4.255 / 2.827 seconds); focused staticcheck and actual Node
fixture verification passed. The unchanged two-member Chromium/Go Workspace
test passed end to end (12.3 seconds, 27.8-second run): create, join, notification
settings, sync, unsync, close and archive. It used only disposable synthetic
data. This closes the browser failure recorded in the preceding slice, not the
separate all-Workspace browser, complete contract or production-cutover gates.

### Bot Message Service Composition Boundary

The Gateway now receives a separate message service configured to accept Bot
actors through its already authorized, shared transaction. The human HTTP
service remains Bot-disabled; neither Bot Tokens on human routes nor inline
topic conversion are enabled by this composition. Message jobs retain the
same required scheduler and repository configuration.

Fresh independent application PostgreSQL/race passed (3.058 seconds), including
real token issuance, Bot send/replay, author identity and rejection of a Bot
Token on the human message route. Integration-tag staticcheck passed. The
unchanged Agent Bot Chromium/Go Workspace acceptance passed (9.7 seconds,
19.2-second run), including Gateway REST authorization boundaries. Actual
Feishu conversion/action integration is a separate remaining gate.

### Core And Emote Contract Projections

Two strict OpenAPI 3.1.2 documents describe the existing Node contract: 32
auth/core operations with 29 actual Node scenarios, and 22 emote operations
with 39 scenarios. The emote corpus exercises every declared emote route;
the core inventory is broader than its first scenario set. Null versus omitted
fields, closed response DTOs, binary content, private emote access and selected
audit/event effects are explicitly represented. These tests validate actual
Node fixtures against the schemas, not Go runtime equivalence or every OAuth
response/header branch.

Parent independently regenerated both fixtures in check-only mode against fresh
synthetic SQLite (command-local RAM temp), then ran combined Go/race contract
tests (5.077 seconds) and staticcheck. All completed successfully. ESLint is
not a configured/installed project dependency; no ESLint pass is claimed.
Family-by-family Go HTTP/PG replay, the remaining operations, complete security
and response-header checks remain separate acceptance gates.

### Echo HTTP Composition And Exhaustive Registration Gate

All sixteen Echo requirements/solicitation HTTP declarations are now mounted
inside the exact Workspace gate and receive the actual PostgreSQL domain
services. Conversation checks reuse the existing message repository's read
boundary. The Node-derived route inventory now verifies every Workspace public
route is registered, and compares all disabled responses across five values
that must not enable Workspace. Registration is not a response-parity claim.

Fresh independent PostgreSQL/race passed application composition (4.470 seconds),
HTTP (2.266 seconds), requirements (10.455 seconds) and solicitations (15.889
seconds). The application test exercises unauthenticated rejection, durable
requirement submission and replay, detail/list/history/statistics reads, and
solicitation creation/publication with durable recipient rows. Focused
integration-tag staticcheck passed. Card/message delivery, nonempty command and
workflow registries, and delivery recovery remain separate composition gates.

The preceding exact commit `2d5bfd4` completed all three CI jobs successfully
in run `34029306873`, including actual Node fixture freshness checks. This does
not extend that CI result to later commits or unaccepted worker changes.

### Transaction-Bound Echo Card Refresh

The cards domain now exposes a narrow internal Echo upsert with a fixed official
author, conversation visibility, immutable recipient/resource binding and the
Node revision floor. It reuses generic payload validation and card creation;
updates use a typed PostgreSQL compare-and-swap extension, not generic SQL in
the delivery coordinator. Replays do not write another event. Shared source
locks serialize creation and refresh across processes.

Independent fresh PostgreSQL/race passed the card package (11.455 seconds),
including revision jumps, eight concurrent refreshes, source-rebinding rejection,
forged-human Echo rejection and an outer failure rolling back the update/event.
The existing card action and raw JSON tests also passed. Integration-tag
staticcheck passed after correcting one capitalization diagnostic. This accepts
the card write seam, not Echo's registered projection/action definitions.

### Atomic Echo Message And Job Handoff

The new runtime writer accepts only the fixed Echo identity, registered Echo
card families, an active human recipient and a direct conversation. Configured
typed card/message views share the delivery transaction; card references are
validated against the newly written card inside that same transaction. The
normal message service retains authorization, retention, idempotency, audit,
event and required notification-job scheduling. No network sender is present.

Node `index.mjs` and the real system-bot message writer establish that Echo
enqueues preference-filtered email/ntfy work. The earlier delivery interface
comment incorrectly prohibited that enqueue. `InternalOnly` now correctly means
no external send in this transaction, not suppressed durable notification jobs.

Independent fresh PostgreSQL/race passed runtime (3.647 seconds), delivery
(9.383), messages (8.755) and application composition (4.549); focused staticcheck
passed. A transaction-local synthetic scheduling probe verifies all writes roll
back after a late scheduler failure, eight concurrent retries yield one message
and one job, and a card revision refresh creates neither again. The probe cannot
send notifications. Real notification preference fixtures, actual Node delivery
effect comparisons, application registration and worker recovery remain gates.

### Feishu Conversion Safety Foundation

The restricted converter and registered action adapter preserve Node's ordered
canonical JSON, duplicate-key semantics, UTF-16 payload units and error priority.
Parent review required fixes for non-finite numbers, WHATWG private IPv4 aliases,
IPv4-mapped IPv6 (including mapped public addresses), and ECMAScript whitespace.
The existing approved WHATWG parser is reused; no dependency was added. Raw
payload output is revalidated before it can cross the cards persistence seam.

Independent Node converter/action/raw-boundary tests passed 31/31. Go/race
passed Feishu (1.081 seconds) and cards (1.028 seconds), followed by staticcheck
after removing six unused helpers/assignments. These accept the converter and
typed action foundation, not the real action PostgreSQL bridge or Gateway/main
registration. Final persisted fallback-text behavior for lone UTF-16 units is
being characterized separately against the actual Node HTTP writer.

### Bot Gateway Message DTO Compatibility

The actual Node Gateway route plus SQLite message writer confirms that its
message response omits the nested `author` property. The Go adapter no longer
adds that incompatible field. Four actual Node cases cover text/content/nullish
selection and client-key aliases; replay is also observed. The application test
now checks the response omission and separately verifies the persisted Bot
author identity, preserving the security assertion without inventing a DTO.

Parent independently regenerated the fixture in check-only mode against fresh
synthetic SQLite. PostgreSQL/race passed Gateway (10.985 seconds), HTTP (1.874)
and application composition (3.896), followed by integration-tag staticcheck.
The narrow projection golden does not replace full Go HTTP request parity.

### Card Authorization Race Correction

Parent PostgreSQL reproductions showed that a Bot removed from the space or
changed to a human between preliminary checks and transaction entry could still
update or invalidate a card. Both mutations now recheck the Bot writer in the
accepting transaction. Card transaction reads pin user identity, space and
conversation membership, and active custom-Bot state with compatible share locks
until commit; read-only repository calls do not acquire those locks.

Regressions cover update/invalidate after membership, identity and active-Bot
revocation, unchanged cards/events on rejection, and a separate transaction
unable to revoke any of four pinned authorization records before commit. A test
fixture initially used an invalid Bot status; it was corrected to `paused` and
now explicitly fails if establishing the revocation itself fails.

Fresh independent PostgreSQL/race passed cards (22.063 seconds), Gateway
(14.815), Echo runtime (3.030) and application composition (5.357), followed by
integration-tag staticcheck. The four initial membership/identity reproductions
failed before the fix. No public API or production ownership changed.

### Disposable Node Unit Fixture Storage

CI runs `34029982272` and `34030618278` passed the Go/PostgreSQL/media and P2P
jobs but hit the existing five-second Node unit deadline in SQLite fixtures
with hundreds of tiny WAL commits. The two affected files passed unchanged
locally (120 tests, 78.76 seconds). Only the Node unit step now sets
`TMPDIR=/dev/shm`; no test timeout, assertion, SQLite transaction, retry or
production storage setting changed. A workflow guard confines this setting to
that single step, excluding executable Go/browser and PostgreSQL fixtures.

The parent reran the complete unchanged Node unit suite with that scoped
environment: SDK 8 passed; web 703 passed and two explicit PostgreSQL cases
skipped, in 25.48 seconds. The three CI guards passed. These local results are
not a claim that the new commit passed remote CI or the dedicated Node
PostgreSQL gate.

### Bot Gateway Feishu Ingress

The Gateway selects the existing Node Feishu branch using field presence and
nullish source precedence, persists only validated converter output, and hashes
the canonical converted payload. Native card hashing remains unchanged. Updates
verify stored card ownership/type before conversion and retain the accepting
cards transaction's authorization checks. Human routes do not accept Bot tokens.

Parent added a successful real PostgreSQL update to the worker's create/hash,
replay and non-owner rejection coverage; the update checks canonical payload,
revision and fallback persistence. Fresh independent PostgreSQL/race passed
Gateway (10.969 seconds) and HTTP (1.878), followed by integration-tag staticcheck
and both Node hash-fixture tests. Main registry/action composition and the
actual Node lone-surrogate fallback request-hash comparison remain separate
gates; converter-only hash fixtures do not prove those boundaries.

### Feishu Action PostgreSQL And Application Composition

The Feishu action repository wraps the configured cards repository on one
transaction and retains its ID factory and action savepoint. It derives the
active Bot from the stored card creator/source/space, pins that Bot row through
commit, and forwards canonical action data to the cards-owned event writer.
Parent review added a caller-owned transaction factory and the active-Bot lock.

Fresh independent PostgreSQL/race passed Feishu (7.019 seconds), covering
successful action/replay, source/creator/space/inactive-Bot rejection with audit,
savepoint and outer rollback, and blocked concurrent pause. Main now registers
the definition and wrapper; its real HTTP/PG test passed (2.971 seconds) through
Bot create, human resolution, action and replay with one canonical action event.
Integration-tag staticcheck passed. This does not enable external Bot delivery
or close the separate lone-surrogate request-hash compatibility gate.

### Realtime Viewer Read State

Conversation event projections incorrectly forced `unreadCount` to zero and
omitted the read marker. They now reuse the conversations repository's visible
record and its existing read-boundary calculation; the transport allowlist
preserves nullable marker ID/time/sequence. The database mutation was already
correct and was not changed. Synthetic tests cover system/other-author messages,
own-message exclusion, marker progression and event replay.

Independent PostgreSQL/race passed events (4.173 seconds) and conversations
(3.670), followed by integration-tag staticcheck. The unchanged dual-user
Chromium scenario advanced past its earlier unread failure, then failed at
the remote member reaction display (line 983, 32.5 seconds). That is a new
remaining realtime projection issue, not a full browser pass.

### File, Invite And Notification Contracts

Strict OpenAPI 3.1.2 schemas cover 11 file, three invitation and 11 notification
operations. Actual Node fixtures characterize 16/4/14 scenarios, including
multipart/local-object flows, invitation acceptance/revocation, SMTP test-proof
configuration and email verification. SMTP is an injected synthetic sender;
background external delivery is disabled. These fixtures do not establish full
Go response parity or exhaustive denied-resource coverage.

Parent independently regenerated all three fixtures in check-only mode,
passed combined Go/race contract tests (6.625 seconds) and staticcheck. Parent
also added failure-path cleanup for each owned temporary database/directory
and disabled fixture request logging; all three check-only producers passed
again after those changes. No live credentials or external sends were used.

Remote CI run `34032028949` completed all three jobs successfully on exact
commit `5ba8a90`, including the scoped tmpfs Node unit step, Node browser,
Go quality/PostgreSQL/media, and Go P2P browser checks. It does not cover later
read-state, reaction, contract or unaccepted automation changes.

### Reaction Runtime Composition And Replay

Two missing runtime links were found while following the unchanged browser
scenario: reaction events lacked the current viewer's groups, and the human
message service had no reaction catalog validator, rejecting valid reactions
after the client's optimistic display. Main now reuses the immutable imported
catalog: additions require visible entries; removal permits known hidden entries.
Replay reconstructs the viewer's names and selected state from current rows,
never stored caller projections. No imported asset changed.

The PostgreSQL projection regression failed before the fix. Fresh independent
PostgreSQL/race then passed events (4.628 seconds) and application composition
(4.471); staticcheck passed. Real HTTP tests cover visible add/remove, unknown
and hidden-add rejection; the adapter unit test preserves hidden removal.
Browser reruns still failed: once at the earlier reaction display before the
catalog was connected, then twice at rapid history-message catch-up (line 728,
20.5/22.6 seconds). No complete browser pass is claimed. Catch-up remains a
separate active investigation; assertions and deadlines are unchanged.

### Shared Echo And Feishu Card Transaction Composition

The candidate Echo runtime now provides a cards repository that preserves
Feishu's typed action/savepoint extension and adds requirement and solicitation
views over the same accepting PostgreSQL transaction. It retains each configured
repository's ID factory. This adapter is not yet selected by the application;
registered Echo definitions and end-to-end action wiring remain separate gates.

Independent PostgreSQL/race passed runtime (2.620 seconds), including a one-
connection-pool regression: a late failure rolls back both domain writes, and
the cards-owned savepoint rolls back both views before successful retry using
the same configured IDs. Integration-tag staticcheck passed. An initial test
placement polluted the existing writer fixture's zero-audit assertion; moving
the independent subtest after those assertions fixed only fixture isolation.

### Realtime Projection Pool Exhaustion

Conversation/member and message/attachment projection held a pool connection
while issuing a nested pool query. Both now collect IDs and close rows before
hydration. The regression reserves a listener connection in a two-connection
pool and concurrently replays 28 durable events for two actors. Worker observed
failure before the fix and a pass afterwards. Parent made synthetic-schema
cleanup failures visible and independently passed PostgreSQL/race events
(9.349 seconds), realtime (4.893), and integration-tag staticcheck.

The unchanged dual-user browser still failed at history-27 catch-up, line 728
(31.9 seconds), so this is a verified pool bug fix, not closure of browser parity.
Actual WebSocket/cursor recovery remains under investigation. Remote CI run
`34032657515` passed all three jobs on `9367d5f`; later changes are not covered.

### Echo Delivery Construction And Release Snapshot Binding

A shared runtime constructor binds the already-configured message scheduler,
base cards transaction (including Echo revision extension), domain projectors
and atomic writer. It starts no worker and sends no external notification.
The release adapter carries the recipient, space, version and immutable
publication ID; release projection rejects mismatched IDs while preserving
existing version-only reads for other internal callers.

Independent PostgreSQL/race passed runtime (2.936 seconds) and releases (4.565),
followed by integration-tag staticcheck. Unit tests check input mapping and
failure propagation; the PG release test rejects another publication identity.
Application registration, worker recovery and real delivery through those
entry points remain the next integration gate.

### Interaction Infrastructure Rollback

The generic interaction executor now distinguishes expected input/business
rejections from infrastructure failures before retaining a failed-run/audit.
Unknown failures, 5xx, cancellation, savepoint failures and joined error graphs
roll back the outer transaction. Caller-owned workflow cancellation and a
configured PG transaction factory support Echo's shared transaction without
extra pool reads; transaction authorization pins the active actor membership.

Parent review additionally rejected unknown errors with empty `Unwrap`, bounded
cyclic graphs, and invalid server-generated command/workflow results. Generated
output failures now return internal 500 and roll back, rather than incorrectly
committing partial domain state as a client 4xx. Actual invalid client/domain
input still retains its normal rejection contract and content-free audit.

Fresh independent PostgreSQL/race passed interactions (19.512 seconds) and the
uncommitted automation consumer (7.917); integration-tag staticcheck passed.
PG cases cover late event/output failure, empty-unwrap failure, savepoint
rollback/release failure, and legitimate 4xx with no partial domain writes.

### Echo Command And Workflow Definitions

Echo's 11 commands and two workflows now have candidate definitions and a PG
repository that supplies configured interaction/requirement/solicitation/release
views over one transaction. Solicitation create/publish share their existing
mutation implementations with caller-owned `InTx` entry points. Multi-step
publish and requirement operations use savepoints and preserve only safe
rejection evidence after rollback; adapters inspect all error leaves before
converting domain 4xx errors.

Parent removed an unused helper and added no-cause 503/typed-nil error tests.
Independent PostgreSQL/race passed automation (7.917 seconds), interactions
(19.512), and solicitations in the earlier combined run (25.030); staticcheck
passed after cleanup. Both Node automation and parser fixture checks passed.
Parser fixtures include JavaScript whitespace and the current Node quoted-token
behavior, without pretending that pre-parsing in the generic command registry
is already characterized. Application composition, post-commit delivery, generic
parser parity and the unchanged Echo browser scenarios remain integration gates.

### Echo Card Definitions And Provenance

The five Echo card definitions now bind requirement transitions and solicitation
votes to the same accepting card transaction. Requirement projection can reuse
that transaction, including its membership checks and content-free rejection
audit. Before either mutation, the adapter checks the stored card's source,
space, type/version, ID and resource binding; a custom Bot's Echo-shaped payload
cannot authorize a mutation of an unrelated resource.

Independent PostgreSQL/race passed carddefinitions (1.071 seconds), requirements
(11.614) and runtime (3.292); staticcheck and the Node five-definition fixture
check passed. A real application test subsequently passed requirement create,
card delivery, collect/replay and solicitation delivery. Full command/workflow,
vote and browser acceptance remains separate from these focused checks.

### Echo Request Runtime Composition

Workspace now registers the 11 commands, two workflows, five card definitions,
shared accepting transactions and the configured durable-message delivery
writer. Enabled startup validates the canonical release asset before opening
dependencies; disabled startup remains dependency-free. Successful domain/card
operations trigger post-commit projection delivery, without converting a
durable success into a retryable rejection when delivery fails. Recovery worker
composition remains a separate gate.

Integration found that blindly copying Node's Echo action adapter injected an
idempotency key into Feishu's empty-input action contract. The candidate narrows
injection to actor-authorized Echo requirement/solicitation card types. Generic
card execution still rechecks authorization and stored provenance in its own
transaction; non-Echo inputs are unchanged. This intentional correction avoids
weakening Feishu's arbitrary-input rejection.

Independent PostgreSQL/race passed application composition (4.632 seconds) and
runtime (2.766), including real HTTP collect/vote/replay, release invocation/
replay and sent delivery rows. Integration-tag staticcheck passed. Three of four
unchanged Echo browser scenarios passed (StrictMode, guided workflow and release
viewports); the release scenario still failed waiting for its card after the
success title appeared. The PG test confirms durable release delivery, but live
browser projection is not yet accepted. Release result-counter parity and
durable recovery are also open; this commit is not whole-Echo parity.

### Feishu Fallback Hash Compatibility

Feishu conversion now retains a validated hash-only UTF-16 representation for
its generated fallback. The HTTP boundary also preserves explicit fallback
presence/raw JSON through validation, including lone surrogate units and
JavaScript trimming. Only canonical validated values enter the hash; database,
message and public fallback strings still use replacement-safe Unicode. Native
card hashing is unchanged.

Independent PostgreSQL/race passed botgateway (38.754 seconds), HTTP API (12.723),
Feishu (23.972) and application composition (11.211). Integration-tag staticcheck
and seven actual Node fixture cases passed. Parent added Go rejection assertions
for the fixture's empty/null cases and made synthetic schema cleanup errors
visible; focused PostgreSQL/race then passed gateway (4.002) and HTTP (4.402).

### Generic Command Whitespace Compatibility

The generic registry now uses ECMAScript whitespace for command recognition
and command/workflow names: BOM and JavaScript Unicode spaces are recognized;
U+0085 is not a delimiter and is retained in arguments. The 4096-code-point
pre-recognition limit remains unchanged. Parent review corrected the command
name boundary so skipping delimiters cannot append those delimiters to the
name. Independent PostgreSQL/race passed interactions (42.636 seconds), Echo
automation (18.208) and application composition (10.541); staticcheck passed.

### Storage Backfill Journal And Safety Review

The additive `032` journal and backfill library bind canonical objects, logical
references and completed items in one transaction. Review added full-stream
digest verification including maximum-size EOF, private-schema isolation,
bounded clone chains, run/item fence and revision checks, late-created cleanup
deadlines, panic rollback and rejection of unbound completion. Concurrent
reference-only changes are rejected against the captured target snapshot.

Independent PostgreSQL/race passed storageops (9.136 seconds); integration-tag
staticcheck and the actual Node backfill/replay contract passed. Parent then
corrected report-only logical bytes to include completed clone references like
Node, with an explicit deduplicated-byte regression. The corrected PostgreSQL/
race rerun passed in 12.307 seconds. Trusted owner coordination,
CLI mutation admission and recovery remain separate uncompleted gates. No
production schema, reference, object or quota was modified.

### Candidate Health Probe And Build Inputs

The loopback-only health helper passed independent race (4.030 seconds),
CGO-disabled tests (3.017) and staticcheck. Both Go Dockerfiles build/copy it;
per-image context allowlists exclude local environments, runtime data and
dependencies. The first local legacy-builder attempt was stopped after it
ignored the per-file context restriction. Installing only Ubuntu's buildx
package required no daemon restart; the BuildKit P2P context was 5.44 MB.

The first BuildKit build failed reaching the default Go module proxy. With the
new build-only public `GOPROXY` override, the P2P image built and its real health
probe exited zero in a non-root, read-only, network-none disposable container.
Workspace image and full candidate gateway readiness remain uncompleted; no
production container, daemon configuration or persistent volume was changed.

### Echo Card References In Realtime Projection

The real PostgreSQL listener/hub/WebSocket test isolated the missing release
card: message events arrived, but the strict block allowlist dropped `cardId`,
`cardType` and `schemaVersion`. Only these public reference fields are restored
for card blocks, with a positive integral schema version; card bodies remain
excluded. Parent added negative allowlist/version tests.

Independent PostgreSQL/race passed events (9.094 seconds), realtime (9.608),
focused allowlist race (1.026) and integration-tag staticcheck. All four unchanged
Echo browser scenarios now pass (32.8 seconds total), including mobile release
delivery/replay, StrictMode, viewport workflow and complete/cancel behavior.
The Vite harness logged an ECONNRESET during page teardown; assertions still
passed. Full Workspace browser, release result finalization and worker recovery
remain separate gates.

### Bot API Contract Inventory

The owner and Gateway OpenAPI documents now cover 35 HTTP/WebSocket route
operations and distinguish browser-session, Bot-token and public setup
boundaries. Two executable response scenarios cover owner creation and Gateway
message DTOs; this is not full behavioral coverage of those 35 operations.
Parent replaced the handwritten owner response with actual Node Fastify,
service and synthetic SQLite execution. Its output matches the existing golden;
no token is issued. The Gateway scenario consumes the separate actual Node
message-writer golden. Go OpenAPI/race validation passed (13.009 seconds), and
the updated Node fixture freshness check passed. Negative schema validation
rejects an extra author field in the deliberately smaller Gateway message DTO.

### Member Post-Commit Echo Delivery

Successful invite-backed GitHub authentication and human role updates now
request a bounded five-second Echo member sync after the underlying transaction
commits. The adapter does not forward GitHub profiles, invite hashes or secrets,
and an ordinary login does not repeat invite delivery. Delivery failure cannot
undo or misreport durable authentication/membership success. The independently
composed member-reconciliation worker repairs missed hooks.

Independent PostgreSQL/race passed application composition (7.221 seconds) and
runtime (4.358); staticcheck and focused post-commit/failure tests passed. The
worker recovery evidence is recorded separately; this hook does not grant any
new production job ownership.

### Migration Coexistence And CI Contract Gates

The isolated schema rehearsal executes the actual Node and Go migration
commands against loopback PostgreSQL, with generated owned schemas and explicit
opt-in. It covers bootstrap through 029, both owners waiting on the same
advisory migration lock, current-history no-op, exactly-once seeds and a failing
031 upgrade rolling the full pending batch back to 030. Canonical SQL hashes
are checked before/after; the existing history table still stores only names
and applied times, not checksums. Parent independently passed all seven CI/
schema tests with PostgreSQL enabled (7.475 seconds; 33 files in the reviewed
worktree, including the pending additive command-finalization migration).

The CI Node contract step now runs 23 actual fixture/check scripts with their
supported flags. Parent independently reran all 23 successfully, including the
new actual-owner Bot creation fixture. The PostgreSQL coexistence rehearsal is
also in the Go CI job. No Go Workspace browser gate is enabled yet: the latest
full browser run passed 9/12, with Bot card update 404, intermittent release
card visibility and reaction-removal projection failures still under review.

### Echo Worker Recovery Composition

Four default-off bounded processors now compose the actual repositories,
delivery service, five card definitions and durable message-jobs scheduler.
Separate cursors cover requirement/solicitation/release queues and active-human
member reconciliation. The latter repairs a join whose HTTP hook never ran,
without broadcasting historical releases. Errors/cancellation retain the
previous page cursor; successful short pages wrap.

Independent PostgreSQL/race passed worker/config (4.245/1.020 seconds). Parent
corrected staticcheck error-string findings, then staticcheck passed. The
expanded real worker test passed in 4.068 seconds: reconstruction retains one
message/card/delivery and one pending email/ntfy job each, with zero provider
attempts. Schema cleanup failures are reported. No notification was sent and
no production worker was enabled.

### Composed Bot Card Authorization

The full browser failure exposed a lost optional interface: Gateway card
creation used the base transaction, but updates entered the Echo/Feishu action
repository whose embedded read interface hid `CustomBotActive`. The adapter
now forwards the base repository check and the same-transaction authorization
view. It does not bypass inactive-Bot checks or open a nested transaction.

An actual application HTTP regression now creates, acts on and updates the
Feishu card through the composed Gateway. Independent PostgreSQL/race passed
application/runtime (11.124/7.008 seconds), integration-tag staticcheck passed,
and the unchanged full Bot owner/Gateway browser scenario passed (19.5 seconds;
45.7 including startup). Existing Vite teardown ECONNRESET was observed. This
fix does not claim the remaining Workspace browser failures are resolved.

### PostgreSQL File And Invite HTTP Contracts

The shared disposable fixture now exercises actual authentication, domain
services, PostgreSQL repositories and HTTP routing. File cases cover reserved
upload, completion/list projection, early quota rejection without orphan objects,
and auditor denial. Invite cases cover unauthenticated access, null-body creation,
hash-only persistence, member denial, owner revocation and missing-resource audit.
Cleanup errors fail the test. Parent independently passed the frozen fixture,
file and invite tests with PostgreSQL and race detection (8.008 seconds).
These focused cases do not claim exhaustive parity for every route or status.

### Stable Release Delivery Result

Migration 033 adds a nullable finalization timestamp without changing Node's
history or result contract. The interaction service revalidates original command
recognition/hash, actor and membership under the existing invocation lock, then
freezes only the five delivery counts of a successful `release-published`
result. Non-count identity cannot change; counts must be nonnegative JavaScript
safe integers with a consistent total. Concurrent finalizers and crash replay
return the first persisted result. Failed post-commit work preserves the accepted
command and remains retryable, rather than returning an ambiguous command failure.

The runtime now reads the all-recipient publication summary after delivery and
wires the finalizer in the actual Workspace application. Parent independently
passed PostgreSQL/race interactions (36.829 seconds), runtime (6.397), application
(10.335), and tagged staticcheck. HTTP first/replay assertions verify one sent
recipient, no pending recipient and a durable frozen timestamp. A fresh browser
run passed 11/12, including release, Bot and Strict Mode; the dual-user latest
message visibility failure remains open and is not attributed to finalization.

### Passive Candidate Dependency Validation

The real Workspace application now validates its entire graph on a read-only
PostgreSQL connection with business admission and background listeners absent.
The worker validates all eight local-storage processors against the same
read-only mode and leaves a pending email job unchanged. No provider is invoked.
Local store construction in these modes never provisions or chmods the root;
the health helper requires the exact runtime mode when requested.

Independent PostgreSQL/race passed Workspace (10.335 seconds), health helper
(4.083), local storage (4.142), gate (1.022), and, after correcting raw exact-flag
parsing and the test's missing catalog path, worker/config (7.522/1.017).
Tagged staticcheck passed. Full container mode proof and deployment harness
integration are separate gates and are not claimed by these tests.

### Real HTTP Writer And Dual WebSocket Regressions

Two synthetic PostgreSQL tests now exercise the actual message/reaction HTTP
services with two authenticated WebSockets and a live PostgreSQL listener.
They verify a 28-message burst, ordered durable replay, viewer-specific
reaction add/remove snapshots and reconnect after removal. Messages and event
rows are created through the API, not directly inserted. Parent independently
passed the realtime package with PostgreSQL/race (19.604 seconds). These focused
regressions passed while the full browser visibility issue remained open; they
are stronger writer/transport evidence, not a claim that the issue is resolved.

### Notification Null Compatibility

Actual Node characterization found that explicitly null email preference flags
mean false, while omitted flags retain their value. The Go HTTP adapter now
preserves this distinction without changing the shared optional-field decoder
or ntfy's boolean-only contract. The three email PATCH fields also accept null
in OpenAPI. The seven-case actual Node fixture and three schema cases retain
their source links; PostgreSQL tests prime true values before testing null and
omission, verify persistence, and assert no provider calls.

Parent independently passed the Node fixture (7 cases), PostgreSQL/race HTTP
package (9.624 seconds), complete contract/race package (11.687), and three CI
wiring tests. CI now runs 24 Node fixture commands. This review separately
identified logical file-not-found 400/404 drift; its fix is tracked with the
file-owner slice and is not claimed here.

### Isolated Six-Service Gateway Candidate

The candidate Compose project isolates Web, P2P, Workspace, worker, migration
and PostgreSQL with project-owned synthetic volumes and one loopback Web port.
Go processes run as 65532 and Web as 101; the Nginx cache tmpfs has explicit
owner permissions. Only migration is one-shot. P2P has no database/storage
configuration, secrets or mounts. Notifications default off. Public gateway
routes explicitly deny all three private health/metrics paths.

Parent independently passed the six-service Compose guard and started project
`duallane-predeployment-stack-20260906`: five long-running containers became
healthy and migration exited zero. Gateway smoke passed ten assertions on
loopback port 18788, including the protocol-correct unauthenticated hello error
and close 1008, security headers, private endpoint denial, and a content-free
transient P2P room. The new gateway Web image ID is
`sha256:6c3c24cc083a0f3a36e52603188c2098962df8b95e3b45db722cca750e38fcf8`.
These are preliminary container checks: the backend image was an earlier
candidate snapshot. Final full-commit images, passive mode, data permissions,
worker behavior and rollback still require their separate rehearsal evidence.
