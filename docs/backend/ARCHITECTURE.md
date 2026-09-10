# Backend Architecture

## 1. Status And Scope

This document defines the Go backend architecture selected by the current
Compose and gateway. The status and release evidence in
[Evolution and migration](EVOLUTION.md) identify the actual production version
and outstanding gates. A topology diagram does not prove a release passed. Use the
[executable evidence map](README.md#find-the-executable-evidence) to locate
service wiring and the guarded deployment entrypoint.

The architecture is sized for personal and small-team self-hosting on one
Docker host. It improves ownership, failure isolation, testability, and future
horizontal scaling without introducing a general distributed platform.

The selected shape is a coarse-grained microservice architecture: one Go source
module, three long-running service commands, one migration command, separate
containers, and the existing Nginx edge gateway as the single public entry.

## 2. Goals

- Make the P2P and Workspace trust lanes separate runtime responsibilities.
- Keep the Go packages and commands maintainable while preserving the
  historical public and persisted-data contracts.
- Keep Workspace authorization, quota, audit, idempotency, event, and data
  mutations inside explicit PostgreSQL transaction boundaries.
- Separate retryable external work from request handling without adding an
  external message broker.
- Preserve the guarded single-host Docker Compose deployment and rollback
  model.
- Give humans and development agents unambiguous module ownership and
  validation requirements.

## 3. Non-Goals

- A service per entity or feature.
- Kubernetes, a service mesh, dynamic service discovery, or multi-region
  operation.
- Kafka, NATS, RabbitMQ, or Redis as a prerequisite for the first Go cutover.
- A new public API version, frontend rewrite, database redesign, or object-key
  migration merely because the implementation language changes.
- Independent databases for tightly coupled Workspace capabilities.
- Stronger P2P privacy or end-to-end identity claims than the product currently
  implements.

## 4. Runtime Topology

```text
public client
    |
    v
Caddy / external TLS (deployment-specific)
    |
    v
Nginx edge gateway + static Web application
    |                         |
    |                         +-- /api/health
    |
    +-- /api/p2p, /ws/p2p ----------> p2p command
    |
    +-- /api/auth, /api/workspace,
    |   /api/bot-gateway,
    |   /ws/workspace,
    |   /ws/bot-gateway ------------> workspace command
    |                                      |
    |                                      +-- PostgreSQL
    |                                      +-- local/S3 object store
    |
    +-- static integration assets

worker command --------------------------> PostgreSQL jobs/events
    |                                      |
    +-- SMTP / ntfy / approved Bot targets

migrate command -------------------------> PostgreSQL
```

The four Go commands live in one Go module and share reviewed platform and
domain packages. Process separation does not imply separate repositories,
separate databases, or network calls between every package.

## 5. Runtime Responsibilities

### 5.1 Edge Gateway

Nginx remains the only public application container. It owns static delivery,
same-origin routing, WebSocket upgrade, bounded request bodies, security
headers, and safe access-log formatting.

The edge gateway may reject malformed transport requests and apply coarse rate
limits. It must not be the only resource authorization layer, decode or log P2P
secure envelope content, or turn internal object identifiers into public
contracts.

### 5.2 P2P Command

The P2P command owns room creation and lookup, ICE configuration projection,
WebSocket admission, peer presence inside a room, secure-envelope validation,
and transient relay.

It must not connect to PostgreSQL, mount the Workspace data volume, initialize
an object-store client, enqueue Workspace work, or log envelope bodies. Initial
production topology is one replica because room ownership is in process. A
separate design and failure test are required before adding replicas.

### 5.3 Workspace Command

The Workspace command owns browser and Bot HTTP APIs, OAuth callbacks, opaque
sessions, resource authorization, domain transactions, realtime event
persistence and projection, upload/download coordination, and authorized object
delivery.

Messages, membership, quota reservations, audit records, and matching realtime
events stay in the same service and transaction where the domain operation
requires atomicity. They are packages, not independent network services.

### 5.4 Worker Command

The worker command owns retryable external effects: email, ntfy, Bot delivery,
scheduled cleanup, and reconciliation explicitly assigned to it. Durable jobs
and leases live in PostgreSQL. A process restart may delay work but must not
lose an accepted job or repeat a non-idempotent effect without detection.

The worker may update only its owned job/delivery state or call an explicit
Workspace domain operation. It must not reproduce authorization or mutate
conversation state through ad hoc SQL.

### 5.5 Migration Command

The migration command is a one-shot deployment role. It applies immutable,
ordered PostgreSQL migrations under an advisory lock and preserves the existing
`schema_migrations` compatibility contract. It is never embedded as an
uncontrolled side effect of normal production process startup.

## 6. Trust-Lane Separation

```text
P2P private lane
browser -> edge -> P2P validation -> peer
                  transient memory only

Workspace relay lane
authenticated actor -> edge -> Workspace authorization/domain transaction
                            -> PostgreSQL/object store/audit/event
```

Shared code is allowed only below the trust distinction, such as safe ID
generation, configuration primitives, HTTP lifecycle, and metrics. P2P code
must not import Workspace repositories, storage adapters, sessions, audit
payloads, or worker packages.

Infrastructure must not blur the lanes. In particular, a future ephemeral P2P
coordination store requires a separate decision, credentials, retention model,
logging review, and proof that persistence is disabled. It cannot reuse a
Workspace queue merely for convenience.

## 7. Consistency Model

PostgreSQL is the Workspace source of truth. For accepted state changes:

1. Authenticate and authorize the current actor.
2. Validate the command and any expected revision/idempotency key.
3. Lock or compare-and-swap in a stable order.
4. Change domain rows, quota/transfer state, audit evidence, and the persistent
   event/outbox row in one transaction where required.
5. Commit before notifying realtime connections or workers.
6. Treat notification as a wake-up hint; consumers recover from the persisted
   cursor or job state.

No migration phase may introduce dual writes from Node and Go. Each command has
one active writer, even when both implementations can perform read-only parity
checks.

## 8. Realtime Model

Workspace events remain persisted with a monotonic per-space sequence. A Go
instance uses PostgreSQL `LISTEN/NOTIFY` only to wake local subscribers; it
queries and permission-filters persisted events before delivery. Reconnect and
missed notifications recover through the existing cursor/replay contract.

Presence is short-lived and cannot be inferred from the event log. Workspace
and worker share bounded-expiry PostgreSQL presence leases; current membership
and expiry predicates remain mandatory. Presence is a delivery-suppression
hint, never authorization evidence. Multiple Workspace replicas still require
explicit scale-out, replay, pool-budget and failure acceptance.

P2P room membership remains in process for the initial target. Sticky routing
alone is insufficient unless room creation, reconnect, ownership, and instance
failure semantics are all defined and tested.

## 9. Failure Model

- A request cancellation propagates through `context.Context` to database,
  storage, and external HTTP work.
- An external network wait never occurs while a Workspace transaction is held
  unless a domain-specific decision documents why it is bounded and safe.
- A failed transaction publishes no realtime success event and leaves no
  completed external effect.
- A committed event remains replayable if immediate WebSocket delivery fails.
- A worker lease expires and becomes reclaimable after process failure.
- Object-store success followed by database rollback invokes idempotent,
  reference-aware cleanup; cleanup failure becomes observable reconciliation
  work.
- Graceful shutdown stops admission, drains bounded HTTP work, closes or hands
  off WebSockets with reconnect-safe semantics, and releases resources.

## 10. Scaling Stages

| Stage | Supported shape | Required coordination |
| --- | --- | --- |
| Current single-host deployment | One P2P, one Workspace, one worker | In-process P2P; PostgreSQL presence leases, jobs and events |
| Worker scale-out | Multiple workers | Durable leases, idempotent delivery, stable claim order |
| Workspace scale-out | Multiple Workspace instances | Database event wake-up, replay tests, cross-instance presence, pool budget |
| P2P scale-out | Multiple P2P instances | Explicit room ownership/routing and non-persistent cross-instance relay design |

Scale only in response to measured connection, latency, availability, or worker
backlog pressure. Do not add distributed coordination in anticipation of
unmeasured demand.
