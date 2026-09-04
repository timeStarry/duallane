# Backend Technology Decisions

## 1. Decision Status

The selections below are approved for the target Go backend. Until
`apps/backend/go.mod`, container images, and validation commands exist, versions
listed here are design baselines rather than installed dependencies. The files
checked into the repository become the exact version authority after each
component is scaffolded.

All dependencies must be pinned through `go.mod`, `go.sum`, generated-tool
declarations, and container image references. Adding or replacing a foundational
dependency requires an architecture decision and maintainer approval.

## 2. Selected Stack

| Concern | Selection | Required use |
| --- | --- | --- |
| Language | Go 1.26, latest supported patch | Initial conservative production baseline; test an upgrade before changing the `go` or toolchain directive |
| Module layout | One module at `apps/backend` | Multiple commands, shared internal packages, no separate repositories |
| HTTP server | Standard `net/http` | Server lifecycle, timeouts, cancellation, streaming, and middleware contracts |
| Router | `github.com/go-chi/chi/v5` | Thin route grouping and parameters while retaining `http.Handler` compatibility |
| HTTP contract | OpenAPI 3.1.2 | Versioned external request/response and error schema |
| HTTP generation | `github.com/oapi-codegen/oapi-codegen/v2` | Generate models and server interfaces; never generate domain behavior |
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
| Vulnerability checks | `govulncheck` | Required for the Go dependency gate once the module is active |
| Deployment | Existing Nginx and Docker Compose | Same-origin edge, private service network, candidate health checks, and guarded rollback |

Official references:

- [Go release policy and history](https://go.dev/doc/devel/release)
- [chi](https://github.com/go-chi/chi)
- [coder/websocket](https://github.com/coder/websocket)
- [pgx](https://github.com/jackc/pgx)
- [sqlc](https://docs.sqlc.dev/en/latest/)
- [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen)
- [AWS SDK for Go v2](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/)
- [govips](https://github.com/davidbyttow/govips)
- [go-mail](https://github.com/wneessen/go-mail)

## 3. HTTP And Contract Policy

`chi` is the only routing framework. Handlers accept standard HTTP types and
perform only transport work: bounded decoding, authentication normalization,
calling one application operation, and stable response projection.

OpenAPI is introduced capability by capability during migration. Generated
types do not override existing product/API contracts or observed compatibility.
The migration PR must characterize nullable fields, omitted fields, unknown
input fields, numeric limits, headers, status codes, and error bodies before a
generated type becomes authoritative.

OpenAPI 3.2 is deferred until the selected stable generator supports the used
features without an experimental toolchain. gRPC is not selected because the
initial target has no required synchronous service-to-service API and the
browser/Agent contracts are JSON.

## 4. PostgreSQL And SQL Policy

Use native pgx interfaces instead of `database/sql`; DualLane supports only
PostgreSQL in production and relies on PostgreSQL-specific locks, constraints,
returning rows, and notifications.

`sqlc` is the default for new static SQL. A dynamic query may use explicit pgx
when forcing every optional filter into generated SQL would reduce clarity.
Dynamic fragments are assembled only from constant allowlisted clauses;
untrusted values remain parameters.

Do not port the SQLite test double into Go. Unit tests use narrow fakes at
package boundaries; transaction, constraint, lock, migration, and query behavior
uses a disposable PostgreSQL database.

## 5. Conditional Image Decision

The Go Workspace image may adopt govips only after a focused compatibility
spike proves the current Sharp behavior for:

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
Node/Sharp implementation. A permanent synchronous media microservice is not
the default fallback; it would add a network and failure boundary to an
otherwise transactional request path.

Because govips uses CGO and libvips, the Workspace runtime image uses a pinned
minimal Debian-family base with the required shared libraries. The P2P image
remains CGO-free and does not inherit the media runtime.

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
