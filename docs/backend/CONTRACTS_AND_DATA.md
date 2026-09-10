# Backend Contracts And Data

## 1. Compatibility Principle

Changing the backend language or process topology is not permission to change
product behavior. Unless a separately approved contract version says otherwise,
the Go implementation must preserve the current public HTTP fields, status and
error codes, cookies, redirects, WebSocket frames, event visibility, SDK
behavior, database contents, and object delivery semantics.

Product and protocol documents define intended behavior. Characterization tests
against the active implementation define details that those documents leave
unspecified. A migration PR must resolve disagreements explicitly rather than
selecting whichever behavior is easier to implement in Go.

## 2. Contract Sources

| Surface | Canonical sources |
| --- | --- |
| P2P behavior and privacy | `DESIGN.md`, `docs/O2O_PRODUCT_DESIGN.md`, security guide, P2P tests |
| Workspace HTTP | `docs/WORKSPACE_API_CONTRACT.md`, owning product design, route/service tests |
| Workspace messages | `docs/WORKSPACE_MESSAGE_PROTOCOL.md` |
| Workspace realtime | `docs/WORKSPACE_REALTIME_EVENT_DESIGN.md`, message protocol, client projection tests |
| Agent Bot API/SDK | Agent Bot requirements, integration assets, `packages/agent-sdk`, compatibility tests |
| Workspace data | Workspace data/file/quota documents, immutable migrations, PostgreSQL tests |
| Production behavior | Compose files, Nginx configuration, production script, testing/release guide |

OpenAPI and JSON Schema become executable projections of these sources as
capabilities migrate. They do not silently replace higher-level security or
product requirements.

The current Workspace schema slices are
[`workspace-core.yaml`](../../apps/backend/api/workspace-core.yaml) and
[`workspace-emotes.yaml`](../../apps/backend/api/workspace-emotes.yaml).
Their actual Node characterization fixtures and strict schema tests live in
`internal/workspacecontract`. These are contract projections, not evidence that
every Go handler or service matches them. See the validation guide for the
check-only commands; do not regenerate goldens to conceal a runtime mismatch.

## 3. HTTP Contract

Every migrated route must preserve or deliberately version:

- method, public path, query and path decoding;
- authentication transport and disabled-Workspace behavior;
- request content type, body limit, accepted field shapes, and normalization;
- unknown, omitted, empty, `null`, and boundary-value behavior;
- response status, headers, JSON field names, omission/nullability, and number
  representation;
- stable error `code`, safe user message, and allowed details;
- retry, idempotency, revision, and concurrency semantics;
- redirects and browser-visible cookie changes;
- audit and realtime effects, including rejected operations.

Handlers use a bounded decoder. Large uploads are streamed or accepted only as
the declared bounded part; general JSON helpers must not buffer an unbounded
body. Nginx limits are defense in depth, not a substitute for service limits.

Resource authorization is repeated in the owning Workspace operation even when
the gateway or middleware has authenticated an actor. A hidden route or client
control is never authorization.

### P2P JSON Parser Compatibility

The lockfile's Fastify 5.8.5 parser converts invalid JSON to a fixed error, not a
raw JavaScript parser diagnostic. The Go candidate must preserve that safe
response rather than replacing it with the room-domain validation error:

| Input to room creation with JSON content type | HTTP status | Stable code |
| --- | --- | --- |
| Empty body | 400 | `FST_ERR_CTP_EMPTY_JSON_BODY` |
| Invalid JSON, including trailing JSON values | 400 | `FST_ERR_CTP_INVALID_JSON_BODY` |
| Body exceeding the existing 1 MiB parser bound | 413 | `FST_ERR_CTP_BODY_TOO_LARGE` |

These parser responses retain `statusCode`, `code`, `error` and the fixed
content-free `message`. Valid JSON with an unsupported room shape continues to
return the existing domain `{error: ...}` response. Never copy a raw decoder
error, body excerpt or offset-dependent diagnostic into Go responses or logs.
This is candidate compatibility with the active pinned Node parser, not a Node
protocol change. Synthetic route and schema tests must lock the full objects.

## 4. Authentication And Sessions

The migration preserves the existing server-side opaque session model:

- generate 32 cryptographically random bytes and encode them with unpadded
  base64url;
- return the token only in the defined `HttpOnly`, `SameSite=Lax` cookie;
- store only its SHA-256 digest in PostgreSQL;
- check expiry, revocation, human identity, active space membership, and the
  exact `WORKSPACE_ENABLED=true` gate when resolving the actor;
- revoke the database session on logout before clearing the cookie when
  Workspace is enabled;
- never place session, OAuth, Bot, invite, or setup tokens in logs, URLs outside
  their defined flow, telemetry, or audit details.

OAuth state, pending invite, return target, callback behavior, GitHub host
allowlists, proxy restrictions, external timeouts, and safe failure codes remain
compatible. Development login fallback remains explicitly non-production.

The Go email adapter must read existing `v1` SMTP credential ciphertext. The
format remains AES-256-GCM with a 12-byte nonce, space ID as associated data,
and unpadded base64url segments. A cryptographic format change requires a
versioned, backward-readable transition and focused known-answer tests.

JWT is not an internal replacement for the current session or Bot token model.

## 5. WebSocket Contracts

### P2P

The P2P service accepts only documented system actions and versioned secure
envelopes. It validates the frame type, version, allowlisted channel, base64url
syntax, and size before relay. It never accepts a plaintext chat/file frame,
persists a relayed envelope, or adds its fields to logs and metrics.

Room-not-found, capacity, joined/left, peer list, reconnect grace, expiry, and
close behavior require compatibility tests. The URL fragment containing `#k=`
must never appear in an HTTP request or server-rendered/logged value.

Node's room-full, room-not-found and explicit-leave paths use `ws.close()`
without a status. Preserve that empty wire close frame: browser clients observe
1005 (no status received), not an explicit normal-close 1000 or policy-close
1008. The Go library's `StatusNoStatusRcvd` requests an empty frame; reserved
status 1005 must never be encoded as an on-wire close code. The candidate parity
runner asserts these observations independently against both implementations.

The Go candidate deliberately narrows three permissive Node behaviors; these
are compatibility exceptions, not claims of byte-for-byte acceptance parity:

- A browser-supplied WebSocket `Origin` must pass the pinned library's default
  request-host check. Cross-host browser origins accepted by the Node plugin
  are rejected by Go. The supported frontend uses the existing same-origin
  gateway; do not disable this check to expose an alternate origin. Origin is
  not authentication, and a non-browser client can omit or forge it.
- The complete incoming WebSocket message has a 64 KiB default limit, including
  ignored JSON fields and whitespace; exceeding it closes with 1009. The
  existing 16,384-character limit on each opaque nonce/ciphertext value is
  unchanged. Small unknown fields remain ignored, but padding an otherwise
  valid envelope beyond the transport bound is not supported. Node's larger
  plugin-level limit must not be mistaken for a required application payload.
- Invalid non-empty TURN TTL configuration fails startup instead of silently
  falling back to ten minutes; see the configuration transition in
  [Operations](OPERATIONS.md#5-configuration-and-secrets).

These boundaries reduce cross-host browser access and resource-exhaustion risk
without decoding or persisting P2P content. Validate standard same-origin
browser transfer/fallback and the explicit cross-origin/oversize refusals. A
deployment with custom clients or invalid legacy environment values must resolve
these differences before selecting the Go profile; it must not silently weaken
the privacy or resource limits to make an old configuration start.

### Workspace

The Workspace service preserves the `version: 1` hello/ready/event/error and
`sync.required` flow. It authenticates each hello, permission-filters replay
before applying its visible-event limit, sends events in sequence order, and
advances the connection cursor idempotently.

Immediate wake-up is not the source of truth. After reconnect, process restart,
missed PostgreSQL notification, or duplicate notification, the service queries
the persistent event sequence and safely replays or requests a scoped refetch.

Message-size limits, heartbeat, origin policy, close codes, slow-consumer
behavior, and graceful shutdown must be explicit in implementation and tests.

## 6. Transaction Contract

A Workspace command that changes related state uses one explicit transaction.
The transaction owns, as applicable:

- authorization re-checks and locked/current resource state;
- domain rows and revision/compare-and-swap changes;
- idempotency result;
- quota reservation or transfer ledger state;
- content-free audit evidence;
- persistent realtime event or durable worker job.

Locks are acquired in a stable documented order. Transactions remain short and
do not include uncontrolled OAuth, SMTP, ntfy, Bot, S3 delivery, or image
processing waits.

Publishing a successful event before commit is prohibited. If a state change
cannot atomically create its delivery record, the owning design must specify an
outbox/reconciliation mechanism and prove crash recovery.

## 7. Events, Outbox, And Realtime Wake-Up

`workspace_events` remains the durable realtime record with a monotonic
per-space sequence. State and event rows are committed together where the
current contract requires it.

PostgreSQL `LISTEN/NOTIFY` is only a low-latency wake-up mechanism:

- the payload contains only a bounded opaque event ID or cursor, never content;
- listeners fetch the authorized event projection from PostgreSQL;
- startup performs listen registration and a cursor catch-up in a race-safe
  order;
- reconnect, duplicates, coalescing, and notification loss do not affect
  correctness;
- a failed listener reconnects with bounded backoff and resumes from persisted
  state.

Worker jobs follow the same principle. The accepting transaction writes durable
job state; a wake-up can reduce latency but cannot be required for eventual
processing.

## 8. Jobs And Leases

Job claims are durable, bounded, and safe with more than one worker:

- select eligible work in a stable order and claim through a lock or conditional
  update that only one worker can win;
- record a lease owner and expiry without storing process secrets;
- re-check current delivery eligibility after claim;
- increment attempts and classify failures with safe stable codes;
- use bounded retry delays and a terminal state;
- make provider submission idempotent where supported, or detect possible
  duplicate delivery after ambiguous failure;
- allow an expired lease to be reclaimed after a crash;
- keep message bodies, credentials, signed URLs, and tokens out of job errors.

Presence-dependent notification suppression cannot use a process-local map from
another container. Until cross-process presence is implemented and validated,
keep that worker capability with its active owner.

## 9. Data Classification And Ownership

| Data | Lane | Storage rule |
| --- | --- | --- |
| P2P room and peer state | P2P | Process memory with bounded expiry only |
| P2P secure envelope | P2P | Validate and relay transiently; no persistence/logging |
| Invite `#k=` fragment | Browser only | Must never reach backend or telemetry |
| Workspace users/sessions/members/content | Workspace | PostgreSQL under authorization and retention rules |
| Workspace file/avatar/emote bytes | Workspace | Authorized content-addressed local/S3 object store |
| Workspace events | Workspace | PostgreSQL, permission-filtered projection and bounded retention |
| Audit evidence | Workspace | PostgreSQL, content-free safe metadata, separate retention |
| Delivery jobs | Workspace | PostgreSQL with leases and safe failure metadata |
| Presence | Workspace | Ephemeral process state initially; later short-TTL coordination only after approval |
| Logs/metrics | Operational | Safe metadata only; never an alternate content store |

P2P data must not enter Workspace tables, object storage, backups, job queues,
audit rows, metrics labels, or tracing attributes.

## 10. Database Migrations

Existing numbered SQL files and `schema_migrations(name, applied_at)` are a
persisted compatibility contract. The transition must preserve their names,
ordering, and applied state.

During coexistence, one migration command owns schema changes. A Go-compatible
runner must prove clean bootstrap and upgrade from an existing Node-managed
database before it becomes active. It must:

- discover only the canonical numbered SQL files;
- serialize execution with the existing advisory-lock identity;
- create/read the existing version table without rewriting applied rows;
- apply each pending file transactionally in lexical order;
- record success only after the migration statements commit;
- fail closed on duplicate/renamed history, checksum policy changes, or an
  unsupported database state;
- keep seeding/reconciliation idempotent and separate from user data import.

Never edit a migration that may have shipped. Use expand-contract changes so
the active Node and Go versions required during rollout and rollback can both
operate safely.

## 11. Object Storage

Logical Workspace resources own authorization and metadata; the object registry
owns canonical physical bytes. Go adapters preserve:

- SHA-256 plus byte-size identity and digest locking;
- reference-aware bind/release/cleanup;
- private bucket policy and opaque internal keys;
- authorization before local stream or signed URL issuance;
- pre-transfer quota reservation independent of deduplication;
- bounded multipart staging, part digest/idempotency, and incomplete cleanup;
- local-read and mirror-write behavior during the documented storage migration
  window;
- cleanup/reconciliation after partial database or object-store failure.

Original filenames are logical resource metadata only and never form internal
paths or object keys.

Legacy profile avatars have different physical layouts: Node used
`profile-avatars/<user>/<version>.webp` below the local object root, but
`workspace/profile-avatars/<user>/<version>.webp` in S3. The nullable legacy
database key retains the local form even when S3 is primary. A Go read must
preserve both identity-derived layouts after avatar authorization; do not use
the database key verbatim as the only S3 locator. Canonical objects remain the
first choice. Only explicit missing-object errors permit compatibility reads;
provider failures, invalid paths and resource-limit errors must fail closed.
This is read compatibility, not a data backfill or permission to enable global
local-read fallback. Keep provider locators out of public responses and logs.
The compatibility candidates still pass through the configured generic reader:
in hybrid mode a missing prefixed key followed by a 403 on the unprefixed S3
key fails closed, even if a local copy exists. This patch does not introduce a
provider-aware local-only fallback or reinterpret access denial as absence.
The shared Node key oracle and real Go S3-reader regression are described in
[Validation](VALIDATION.md#legacy-avatar-provider-layout).

Legacy emote reads use the read-only `LegacyReader`, not a canonical-object
identity bypass. After actor/resource authorization, accept only the exact
`custom-emotes/<owner>/<emote>/content.webp` or historical
`workspace/custom-emotes/<owner>/<emote>/content.webp` key derived from the
resolved source identity. Follow source-clone chains without inventing missing
metadata. Only a genuinely missing canonical object may fall back; tombstoned
registry rows, inconsistent identity/size/hash, malformed paths and provider
failures must not resurrect legacy bytes.

Before returning an emote body, consume at most its allowed size plus one byte
(maximum 2 MiB plus the overage sentinel), validate exact size and the available
digest, and close the source. A mismatch fails before HTTP delivery. Historical
rows may have null size/hash; use bounded actual-object metadata rather than
treating null as zero or fabricating a digest. A removed library entry whose
storage is retained for message/clone references remains readable under Node's
authorization contract; a removed registry object is a different, authoritative
storage tombstone. New writes remain canonical and no legacy backfill runs on
read. See the executable Node/Go fixture in [Validation](VALIDATION.md).

## 12. Logs, Metrics, Audit, And Errors

HTTP request logs use an allowlist: request ID, method, matched route template,
status, duration, service, version, and a deliberately normalized remote
address when operationally required. They never include raw URL query, body,
response body, Cookie, Authorization, OAuth code/state, signed URL, object key,
hash, or P2P frame.

Metrics use bounded labels. User IDs, room IDs, conversation IDs, filenames,
tokens, error strings, and content must not become labels.

Audit remains domain evidence and is written by the accepting Workspace
operation. Operational logs do not replace required success/rejection audit
rows. Public errors contain stable safe codes and never reveal SQL, stack,
filesystem, bucket, hash, or credential details.

## 13. Capability Cutover Contract

For each migrated capability:

1. Record current behavior and owner in `EVOLUTION.md`.
2. Add or update executable OpenAPI/JSON Schema and compatibility fixtures.
3. Implement Go behavior against a disposable database/object store.
4. Prove response, persistence, audit, event, retry, and failure parity.
5. Route the complete write unit to Go; do not split one transaction across
   Node and Go.
6. Observe the routed slice and retain a tested rollback route.
7. Mark it `active` only after legacy routing is removed.
8. Remove legacy code only after the target is stable, then mark the migration
   `complete` with required docs and tests moved to the active owner.
