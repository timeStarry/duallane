# Architecture Requirements

## 1. Supported Stack

DualLane is a pnpm workspace targeting Node.js 22. The current implementation
uses:

- React 19, TypeScript in strict mode, and Vite for the Web client;
- Fastify and native ESM (`.mjs`) for the API and WebSocket services;
- PostgreSQL 17 with ordered SQL migrations for Workspace persistence;
- an in-process SQLite database as a deterministic Workspace test double;
- local filesystem or S3-compatible storage behind the content-addressed object
  store;
- Playwright for browser flows and Vitest for unit/integration tests;
- the versioned `@duallane/agent-sdk` package for Agent Bot integrations;
- Docker Compose, Nginx, and Caddy-facing deployment configuration for production.

Use the versions declared in `package.json`, `pnpm-lock.yaml`, container files,
and workspace package manifests. Do not introduce a parallel framework, state
library, database abstraction, UI kit, or build system without an architecture
decision and maintainer approval.

## 2. Repository Map

| Path | Responsibility |
| --- | --- |
| `apps/web/src` | React application, routes, shared UI, client state, and styles |
| `apps/web/server/routes` | HTTP/WebSocket boundary: parse, authenticate, call a service, project response |
| `apps/web/server/services` | Workspace domain rules, authorization, transactions, audit, events, storage coordination |
| `apps/web/server/services/db.mjs` | Production PostgreSQL adapter |
| `apps/web/server/services/test-database.mjs` | SQLite Workspace test double |
| `apps/web/server/migrations` | Ordered PostgreSQL schema migrations |
| `packages/agent-sdk` | Public versioned Agent Bot client and protocol helpers |
| `e2e` | Browser acceptance flows and isolated test-server fixtures |
| `docs` | Product, protocol, data, visual, operations, and development contracts |
| `deploy` | Guarded production deployment and operator checks |
| `apps/web/public/integrations` | Reviewed, secret-free Agent integration instructions and version manifests |

Keep new code with the component that owns the behavior. A route is not a domain
service, a React component is not a persistence layer, and product documentation
is not a substitute for executable validation.

## 3. Trust-Lane Boundary

The architecture has two independent data paths:

```text
P2P private lane
browser -> signaling validation -> peer
         no plaintext persistence

Workspace relay lane
authenticated client -> Fastify route -> authorized domain service
                     -> PostgreSQL / object storage / audit / realtime event
```

P2P server modules may coordinate sessions and relay validated encrypted
envelopes. They must not import Workspace persistence to retain P2P payloads or
add plaintext observability. Workspace APIs may persist only after authentication,
authorization, validation, and quota checks.

Read [Security and data](SECURITY_AND_DATA.md) for the required checks.

## 4. Backend Boundaries

### Routes

Routes should:

- declare request and response schemas when the local framework supports them;
- authenticate and normalize boundary inputs;
- pass request metadata needed for audit or idempotency;
- call one domain operation;
- translate known service errors to stable HTTP status and error codes;
- avoid implementing transactions or duplicating authorization policy.

### Services

Services own authorization, domain validation, transactions, revision checks,
idempotency, audit records, and event publication. Sensitive reads are also
authorized in the service; route visibility is not sufficient.

A state-changing operation that spans multiple tables must have one explicit
transaction boundary. External object cleanup or notification work that cannot be
transactional must be designed for retry and reconciliation.

### Database And Storage

- Add immutable, ordered migrations. Never edit a migration that may have shipped.
- Migrations must tolerate the supported upgrade path, preserve existing data, and
  define rollback or forward-recovery behavior in the PR.
- Use parameterized queries and explicit column lists. Check affected-row counts
  for compare-and-swap and ownership updates.
- Acquire locks in a stable order. Keep transactions short and do not perform
  uncontrolled network waits while holding them.
- Workspace binary content uses the content-addressed object registry. Logical
  attachments, avatars, and emotes reference an object; they do not invent new
  physical storage keys.
- Legacy-read compatibility may remain during migration, but new writes use the
  canonical path and cleanup is reference-aware.

## 5. Frontend Boundaries

- Route-level components orchestrate data and page structure; focused components
  own reusable presentation and interaction behavior.
- Use the existing API client, authentication, event, composer, message, settings,
  and feedback patterns before adding local variants.
- Keep server state authoritative. Optimistic state needs a stable client ID,
  reconciliation, rollback, and duplicate-event handling.
- Effects must survive React Strict Mode re-execution, route changes, aborted
  requests, stale responses, and component unmount.
- Do not continue expanding a large assembly component such as `App.tsx` when a
  feature has an independent lifecycle that can be extracted without duplicating
  global state.
- Lazy-load genuinely secondary surfaces when it improves initial behavior, but
  do not conceal required state or create layout shifts.

See [UI/UX standards](UI_UX_STANDARDS.md) for presentation requirements.

## 6. API And Realtime Compatibility

- Public JSON fields, error codes, WebSocket event types, and SDK behavior are
  contracts. Additive evolution is preferred within a version.
- Do not expose database IDs, object keys, hashes, internal paths, or stack traces
  unless the public contract explicitly requires them.
- Events target the smallest authorized audience and contain only the projection
  that audience may read.
- Client event application is idempotent. Reconnect/replay can deliver data that
  the initial HTTP load or optimistic path already applied.
- Use stable client invocation/message IDs for retryable mutations. A duplicate
  with the same identity and request returns the prior result; conflicting reuse
  must fail explicitly.

## 7. Architecture Decisions

Add or update a design document before implementation when a change introduces:

- a new trust boundary or persistence category;
- a new shared framework, package, service, external dependency, or protocol
  version;
- a database migration with material backfill or destructive cleanup;
- a new public API family, realtime delivery model, or compatibility break;
- a production topology or recovery-path change.

Record context, decision, alternatives, trade-offs, data migration, rollout,
observability, and rollback. Keep small local implementation choices in the PR.

## 8. Known Scaling Boundary

The current application is designed around the checked-in deployment topology.
Do not assume in-process queues, locks, caches, or WebSocket registries coordinate
multiple API replicas. A horizontal-scaling change must first provide shared
coordination and event transport with tests for ordering, replay, and failure.
