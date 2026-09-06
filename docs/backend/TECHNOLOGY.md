# Backend Technology Decisions

## 1. Decision Status

The selections below remain approved for the target Go backend. A Go candidate
now exists under `apps/backend`, but candidate code, an image recipe, or a
passing local check does not change the active production owner. The live owner
and cutover gates remain in [Evolution and migration](EVOLUTION.md); the
checked-in Compose and gateway still select the Node API.

The source manifests are authoritative for what is actually pinned and wired:
`apps/backend/go.mod` for module versions and `go.sum` for integrity hashes,
its `tool` block for executable package names (versions come from the module
requirements), `apps/backend/Makefile` for executable checks, the Dockerfiles
for image build/runtime prerequisites, `package.json` for root wrappers, and
`.github/workflows/ci.yml` for CI wiring. Adding or replacing a foundational
dependency requires an architecture decision and maintainer approval.

### Status vocabulary

Use these terms precisely in migration notes and evidence records:

| Term | Meaning |
| --- | --- |
| Selected | Approved target choice in this handbook; it may not yet be present in the candidate manifests. |
| Pinned | A module/tool version is fixed in `go.mod` requirements, or an image is fixed by digest. A tool package declaration alone is not a version pin; an image tag alone is not immutable. |
| Integrated | Candidate code or an executable repository path imports, builds, invokes, or otherwise wires the selection. Integration does not establish production ownership. |
| Verified | The relevant command or compatibility fixture was executed against a named commit/environment and passed. Presence in a manifest or CI definition is not verification. |

### Current candidate map

- The Go `1.26` language baseline and `go1.26.8` toolchain are declared in
  [`apps/backend/go.mod`](../../apps/backend/go.mod). The required module
  versions and the `staticcheck`/`govulncheck` tools are also declared there.
- The exact Go checks are integrated through
  [`apps/backend/Makefile`](../../apps/backend/Makefile), root `package.json`,
  and the Go job in [CI](../../.github/workflows/ci.yml). They are not verified
  for an arbitrary worktree until their commands are run and recorded.
- [`apps/backend/api/p2p.yaml`](../../apps/backend/api/p2p.yaml) is a checked-in
  OpenAPI 3.1.2 contract, and
  [`apps/backend/api/realtime/p2p.schema.json`](../../apps/backend/api/realtime/p2p.schema.json)
  is the checked-in realtime frame schema. These are source contracts, not
  evidence that generated code or production routing exists.
- `oapi-codegen` v2.8.0 is pinned as a Go tool, with runtime v1.6.0 and
  kin-openapi v0.142.0 for contract tests. The P2P generation config and
  `make generate`/`make check-generated` are integrated. Generated models and
  interfaces do not replace the live handler or automatically validate input.
- `sqlc` v1.31.1 is pinned as a Go tool. `sqlc.yaml` reads the canonical
  migrations and generates the presence repository's pgx/v5 query bindings;
  `make generate` and the non-mutating `make check-generated` include it.
  The tool has no runtime import and uses local schema analysis without a
  remote service or database connection. Its tool dependency graph raises
  OAuth to v0.34.0 and protobuf to v1.36.11; these remain subject to runtime
  regression checks. This does not claim all existing pgx queries are generated.
- `go-mail` v0.8.1 is pinned and integrated behind the SMTP publisher. The
  application owns the connection and an absolute operation deadline, including
  greeting, TLS, authentication, DATA and QUIT. Cancellation closes the raw
  connection rather than concurrently invoking graceful SMTP shutdown. The
  unified module graph selects x/crypto v0.55.0 and retains x/text v0.41.0.
  Loopback protocol tests do not establish real-provider delivery or credentials.
- `Dockerfile.p2p` and `Dockerfile.workspace` provide candidate image recipes;
  their existence does not add a Go service to Compose or establish a cutover.
  Their current defaults use mutable image tags and unversioned OS package
  installs. Immutable release inputs remain a gate in
  [Runtime and operations](OPERATIONS.md#3-images), not completed pinning.

## 2. Selected Stack

| Concern | Selection | Required use |
| --- | --- | --- |
| Language | Go 1.26 with candidate toolchain `go1.26.8` | Source authority is `apps/backend/go.mod`; test an upgrade before changing the `go` or toolchain directive |
| Module layout | One module at `apps/backend` | Multiple commands, shared internal packages, no separate repositories |
| HTTP server | Standard `net/http` | Server lifecycle, timeouts, cancellation, streaming, and middleware contracts |
| Router | `github.com/go-chi/chi/v5` | Thin route grouping and parameters while retaining `http.Handler` compatibility |
| HTTP contract | OpenAPI 3.1.2 | Versioned external request/response and error schema |
| HTTP generation | `github.com/oapi-codegen/oapi-codegen/v2` | Pinned P2P models/interfaces; generate contract adapters, never domain behavior |
| WebSocket | `github.com/coder/websocket` | Context-bounded P2P and Workspace connections, explicit size limits and close handling |
| WebSocket contract | Versioned JSON Schema | Preserve existing JSON frames and `version: 1` behavior |
| PostgreSQL | `github.com/jackc/pgx/v5` and `pgxpool` | Native transactions, savepoints where needed, advisory locks, `LISTEN/NOTIFY`, and pool control |
| Query generation | `sqlc` with `pgx/v5` output | Static queries and row types; explicit repository code remains allowed for justified dynamic queries |
| OAuth | `golang.org/x/oauth2` plus bounded `net/http` clients | GitHub authorization flow; application code still owns state, invite binding, host allowlists, and safe errors |
| IDs | `github.com/google/uuid` | Compatible random UUID generation; retain existing public prefixes where present |
| S3 | AWS SDK for Go v2 | Private S3-compatible bucket access, multipart operations, cleanup, and presigned delivery |
| Local objects | Standard `io`, `os`, and `path/filepath` behind `BlobStore` | Bounded streaming, atomic staging/rename, path containment, and reference-aware deletion |
| SMTP | `github.com/wneessen/go-mail` behind `Mailer` | TLS/STARTTLS modes, authentication, deadlines, plain/HTML alternatives, and testability |
| Image processing | `github.com/davidbyttow/govips/v2/vips` and libvips | Conditional on the compatibility spike in Section 5 |
| Configuration | Typed application structs and `os.LookupEnv` | Explicit defaults and fail-closed validation; no reflection-heavy configuration framework |
| Cryptography | Go standard library | `crypto/rand`, SHA-256/HMAC, constant-time comparison, AES-256-GCM, and compatible encodings |
| Logging | `log/slog` JSON handler with project-owned safe-field policy | Operational logs only; audit remains a separate Workspace database concern |
| Metrics | Prometheus Go client | Private per-process metrics endpoint; no mandatory bundled monitoring stack |
| Testing | Standard `testing`, `httptest`, fuzzing, and race detector | Table-driven domain tests, real PostgreSQL integration, transport tests, and concurrency evidence |
| Vulnerability checks | `govulncheck` | Tool declared and version fixed through `go.mod`; invoked as `go tool govulncheck` by `make verify` |
| Deployment | Existing Nginx and Docker Compose | Same-origin edge, private service network, candidate health checks, and guarded rollback |

Official references:

- [Go release policy and history](https://go.dev/doc/devel/release)
- [Go tool directives](https://go.dev/ref/mod#go-mod-file-tool)
- [OpenAPI Specification 3.1.2](https://spec.openapis.org/oas/v3.1.2.html)
- [chi](https://github.com/go-chi/chi)
- [coder/websocket](https://github.com/coder/websocket)
- [pgx](https://github.com/jackc/pgx)
- [sqlc](https://docs.sqlc.dev/en/latest/)
- [sqlc v1.31.1 release](https://github.com/sqlc-dev/sqlc/releases/tag/v1.31.1)
- [sqlc v1.31.1 module requirements](https://github.com/sqlc-dev/sqlc/blob/v1.31.1/go.mod)
- [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen)
- [oapi-codegen v2.8.0 release notes](https://github.com/oapi-codegen/oapi-codegen/releases/tag/v2.8.0)
- [AWS SDK for Go v2](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/)
- [govips](https://github.com/davidbyttow/govips)
- [go-mail](https://github.com/wneessen/go-mail)
- [go-mail v0.8.1 release](https://github.com/wneessen/go-mail/releases/tag/v0.8.1)
- [go-mail v0.8.1 module requirements](https://github.com/wneessen/go-mail/blob/v0.8.1/go.mod)

## 3. HTTP And Contract Policy

`chi` is the only routing framework. Handlers accept standard HTTP types and
perform only transport work: bounded decoding, authentication normalization,
calling one application operation, and stable response projection.

OpenAPI is introduced capability by capability during migration. Generated
types do not override existing product/API contracts or observed compatibility.
The migration PR must characterize nullable fields, omitted fields, unknown
input fields, numeric limits, headers, status codes, and error bodies before a
generated type becomes authoritative.

The candidate map above distinguishes source schemas, generated artifacts,
test validation, and live runtime ownership.

The official [oapi-codegen v2.8.0 release notes](https://github.com/oapi-codegen/oapi-codegen/releases/tag/v2.8.0)
document initial OpenAPI 3.1 support, including version-aware handling of
selected 3.1 idioms such as `type: [T, "null"]` and enum-via-`oneOf` with
`const`. The release notes require Go 1.25+ for the tool and generated code
using the newer features requires `github.com/oapi-codegen/runtime` v1.6.0+.
This establishes a supported upstream range, not compatibility evidence for an
unpinned generator against this exact contract. The [OpenAPI Specification
3.1.2](https://spec.openapis.org/oas/v3.1.2.html) says that 3.1 patch versions
share the 3.1 feature set, but the checked-in P2P schemas use direct property
`const` values (for example `maxPeers` and health fields), which need explicit
compatibility tests.

The P2P slice pins that generator/runtime pair and an explicit config in
`apps/backend/api/p2p.codegen.yaml`. Generated artifacts live in
`internal/p2pcontract`, separate from the hand-authored runtime handler. Tests
load the exact local 3.1.2 source with external references disabled and check
request/response constraints through kin-openapi. Compiling a model alone does
not enforce a direct `const`: decoding and validation remain separate steps.

The pinned generator/runtime are Apache-2.0 and kin-openapi is MIT (verified
from their pinned module license files). The generator is build-time tooling;
kin-openapi is used by contract tests, not the P2P executable. This adds module
download/build inputs but no database, network hop, image runtime library, or
production route. Continue to review upstream fixes and run the pinned
vulnerability gate when updating these modules.

Every later capability must repeat this gate for its used schema features,
including nullable/omitted fields and public errors. Keep the 3.1.2 document
and realtime schema authoritative; do not downgrade to 3.0 or equate generated
code with active-implementation parity. See
[Backend validation](VALIDATION.md#openapi-312-generation-gate) for the
evidence record.

OpenAPI 3.2 is deferred until the selected stable generator supports the used
features without an experimental toolchain. gRPC is not selected because the
initial target has no required synchronous service-to-service API and the
browser/Agent contracts are JSON.

## 4. PostgreSQL And SQL Policy

### Persisted JSON And URL Compatibility

Persisted Node request hashes are a data contract, not an implementation detail.
Characterize the actual producer before translating `JSON.stringify`: object
field order, omitted/null values, escaping, whitespace and URL normalization
can all change a digest. Echo requirement fixtures are generated by
`node scripts/backend/echo-requirement-fixtures.mjs`; `--check` compares the
active Node service with the checked-in synthetic goldens. The Go tests compare
both hashes and PostgreSQL replay without additional audit/event writes.

The narrowly scoped URL compatibility utility
[`github.com/nlnwa/whatwg-url`](https://github.com/nlnwa/whatwg-url/tree/v0.6.2)
is pinned at v0.6.2 (Apache-2.0), with bitset v1.20.0 as a new transitive input;
the existing newer x/net and x/text pins are retained. Actual Node fixtures
demonstrated `net/url` differences for IDNs, default ports, dot segments,
special slashes and numeric IPv4 aliases. This removes a hand-written browser
URL normalization algorithm; it adds no external call, process or service.
Input remains bounded and the owning domain still rejects credentials, unsafe
schemes and private addresses after normalization. Upstream conformance claims
are not a substitute for our pinned Node/Go fixture and vulnerability gates.

Echo deliberately does not reproduce the old Node hostname-regex gap for
bracketed private IPv6. New Go submissions reject those links; existing stored
records are not rewritten. Cutover notes must identify this validation tightening
and the fact that retrying such an old submission is rejected before replay.
The requirement hash helper supports its fixed ordered records, not arbitrary
JavaScript objects; other domains must characterize their own producer.

### Queries And Transactions

Use native pgx interfaces instead of `database/sql`; DualLane supports only
PostgreSQL in production and relies on PostgreSQL-specific locks, constraints,
returning rows, and notifications.

`sqlc` is the default for new static SQL. A dynamic query may use explicit pgx
when forcing every optional filter into generated SQL would reduce clarity.
Dynamic fragments are assembled only from constant allowlisted clauses;
untrusted values remain parameters.

The initial generated boundary is `internal/workspace/presence/queries.sql`.
Edit that source and run `make generate`; never edit its nested
`internal/presencequeries` output. The nested internal package prevents other
domains from bypassing presence authorization through generated query methods.
The parent repository keeps validation, stable errors and deadline policy.
Existing reviewed explicit pgx repositories remain in place; convert them in
focused, tested slices when changing their queries, not as formatting churn.

Do not port the SQLite test double into Go. Unit tests use narrow fakes at
package boundaries; transaction, constraint, lock, migration, and query behavior
uses a disposable PostgreSQL database.

## 5. Conditional Image Decision

The candidate Workspace image already uses govips and libvips: the checked-in
`Dockerfile.workspace` installs `libvips-dev`/`pkg-config`, builds the Workspace
binary with `CGO_ENABLED=1`, and installs `libvips42` in the runtime image.
`Dockerfile.p2p` builds the P2P binary with `CGO_ENABLED=0` and must not inherit
the media runtime. This is an image prerequisite and candidate integration, not
proof of media parity, production ownership, or a completed cutover.

Production adoption of the Go media adapter remains gated on a compatibility
spike that proves the current Sharp behavior for:

- JPEG, PNG, WebP, GIF, and the accepted BMP variants;
- EXIF orientation and centered avatar crop;
- static and animated WebP output;
- width, height, pixel, frame-count, duration, input-byte, and output-byte
  limits;
- corrupt, truncated, misleading-MIME, decompression-heavy, and unsupported
  inputs;
- deterministic public metadata and compatible failure codes.

The spike uses synthetic fixtures and golden metadata, not imported emote
assets or production files. It does not require byte-for-byte identical encoded
output unless content hashes or client behavior depend on that identity.

Until this gate passes, avatar and custom-emote processing remain owned by the
Node/Sharp implementation even if the Go candidate can compile. Local media
checks require a usable CGO toolchain and libvips headers/runtime; an
environment without them must record media coverage as `SKIP` or `NOT RUN`, not
as a passing full Go gate. A permanent synchronous media microservice is not the
default fallback; it would add a network and failure boundary to an otherwise
transactional request path.

Because govips uses CGO and libvips, the release Workspace runtime requires a
pinned minimal Debian-family base with the required shared libraries. The P2P
image remains CGO-free and does not inherit the media runtime.

## 6. Observability Decision

Initial observability consists of safe structured logs, request IDs, health and
readiness, PostgreSQL pool/job metrics, WebSocket counts, event lag, and worker
backlog metrics. The metrics endpoint remains private to the Compose network.

OpenTelemetry traces may be added when there is a real synchronous cross-process
path or production diagnosis shows request IDs are insufficient. OpenTelemetry
logs, a collector, and a tracing backend are not initial deployment
requirements.

## 7. Explicitly Rejected For The Initial Target

| Alternative | Reason not selected |
| --- | --- |
| Gin, Echo, Fiber | A second full HTTP framework adds behavior and middleware surface that `net/http` plus chi does not need |
| GORM or another ORM | Hides SQL, lock order, affected-row checks, and transaction boundaries that are security/data requirements |
| JWT browser sessions | Weakens current revocation and server-side membership checks without solving an existing problem |
| Redis | No initial cache requirement; P2P persistence defaults could violate the lane promise; Workspace can use PostgreSQL |
| Kafka, NATS, RabbitMQ | Operational cost is not justified by the current workload; durable jobs/outbox already fit PostgreSQL |
| gRPC or Connect RPC | No required initial internal RPC and no benefit to the existing browser JSON contract |
| Temporal or a workflow platform | Current jobs have bounded states, leases, and retries that remain understandable in PostgreSQL |
| Dependency injection framework | Manual constructors make ownership and test dependencies explicit at this scale |
| Kong, Envoy, Traefik | Existing Nginx already owns the needed single-origin edge behavior |
| Kubernetes or service mesh | Conflicts with the single-host self-hosting and guarded Compose deployment target |
