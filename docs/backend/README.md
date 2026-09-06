# Backend Architecture Guide

This directory is the progressive-disclosure entry point for the DualLane Go
backend transition and for backend development after that transition completes.
It defines an approved target architecture. Candidate code can exist before
production ownership moves. Use the status and evidence in
[Evolution and migration](EVOLUTION.md) to distinguish implementation progress
from production routing; `routed`, `active`, and `complete` are different gates.

## Start Here

Every backend task must first read:

1. [`AGENTS.md`](../../AGENTS.md) and the
   [development index](../development/README.md).
2. [`README.md`](../../README.md), [`DESIGN.md`](../../DESIGN.md), and the
   smallest relevant product or protocol contract.
3. This index and [Evolution and migration](EVOLUTION.md) to identify the
   current implementation owner.
4. Only the topic documents routed below.

The current implementation remains authoritative for runtime wiring while a
capability is `planned` or `parity`. The product and security documents remain
authoritative for behavior and invariants at every status.

## Document Map

| Document | Canonical responsibility |
| --- | --- |
| [Target architecture](ARCHITECTURE.md) | System shape, trust lanes, process topology, consistency model, and scaling boundaries |
| [Technology decisions](TECHNOLOGY.md) | Approved Go stack, dependency policy, conditional choices, and rejected alternatives |
| [Service boundaries](SERVICE_BOUNDARIES.md) | Runtime and package ownership, dependency direction, database access, and placement rules |
| [Contracts and data](CONTRACTS_AND_DATA.md) | HTTP/WebSocket compatibility, sessions, transactions, events, migrations, storage, and sensitive data handling |
| [Runtime and operations](OPERATIONS.md) | Containers, configuration, health, startup, shutdown, observability, deployment, and rollback |
| [Validation](VALIDATION.md) | Required test layers, parity evidence, security checks, concurrency checks, and release gates |
| [Evolution and migration](EVOLUTION.md) | Capability status, migration sequence, cutover rules, completion criteria, and future architecture changes |
| [Backend agent guide](AGENT_GUIDE.md) | Minimal task intake, reading routes, edit rules, validation, and handoff for development agents |

## Read By Task

| Task | Required backend documents | Also read |
| --- | --- | --- |
| Create or move a service/package | Architecture, Service boundaries, Evolution | Development architecture and workflow |
| Add or change an HTTP API | Contracts and data, Service boundaries, Validation | Owning product/API contract and security guide |
| Add or change WebSocket behavior | Architecture, Contracts and data, Validation | P2P or Workspace realtime protocol |
| Change authentication or authorization | Contracts and data, Service boundaries, Validation | Security and data; Workspace auth/invite design |
| Change PostgreSQL schema or a transaction | Contracts and data, Evolution, Validation | Data model; testing and release |
| Change upload, object storage, avatar, or emote processing | Technology, Contracts and data, Validation | Security and data; file/quota design; storage runbook |
| Change a worker or external delivery | Service boundaries, Operations, Validation | Notification or Bot product contract |
| Change Compose, images, health, or release order | Operations, Evolution, Validation | Testing and release |
| Migrate a Node capability to Go | Evolution, Agent guide, owning topic documents | Current implementation and nearby tests |
| Coordinate parallel development or hand off a backend task | [Agent collaboration rules](AGENT_GUIDE.md#10-parallel-work-review-and-handoff); optional [work-item record](templates/WORK_ITEM.md) | Development workflow; only the owning domain guides |

## Current And Target Shape

The current backend is the Node.js 22 and Fastify service under
`apps/web/server`. Nginx serves the frontend and proxies `/api` and `/ws` to
that service. PostgreSQL and the local or S3-compatible object store retain
Workspace data. Several realtime registries and workers still depend on
in-process state.

The approved target is one Go module containing separate P2P, Workspace,
worker, and migration commands. Nginx remains the only public application
gateway. PostgreSQL remains the Workspace system of record. P2P remains a
physically and logically separate no-persistence lane.

See [Evolution and migration](EVOLUTION.md) for the live owner of each
capability. A directory, binary, image, or passing test is not sufficient to
change ownership; the status ledger and production route must agree.

## Find The Executable Evidence

Read only the row needed for the task. These are repository entry points, not
a claim that every candidate capability is integrated, verified, or deployed.

| Question | Inspect |
| --- | --- |
| Which backend does the checked-in deployment select? | [Compose](../../docker-compose.yml), [production override](../../docker-compose.production.yml), and [Nginx routes](../../deploy/nginx/default.conf) |
| Where is a Go candidate composed? | [P2P](../../apps/backend/cmd/p2p/main.go), [Workspace](../../apps/backend/cmd/workspace/main.go), [worker](../../apps/backend/cmd/worker/main.go), or [migration](../../apps/backend/cmd/migrate/main.go) |
| Which versions and checks are executable? | [Go module](../../apps/backend/go.mod), [Makefile](../../apps/backend/Makefile), [root scripts](../../package.json), and [CI](../../.github/workflows/ci.yml); see [Validation](VALIDATION.md) for the required evidence |
| Which candidate images exist? | [P2P image](../../Dockerfile.p2p) and [Workspace image](../../Dockerfile.workspace); image existence does not establish a Compose service or cutover |
| Which contracts and migrations are present? | [Candidate API directory](../../apps/backend/api) and [canonical SQL migrations](../../apps/web/server/migrations); inspect coverage before assuming a whole API family is characterized |
| Where is the foundation/contract slice evidence? | [2026-09-06 work record](work-items/2026-09-06-foundation-contracts.md); includes exact tested commits and excluded draft failures |

The checked-in Compose and gateway still select Node `api`; the Go entry points
are candidates. Repository configuration is not a live production inspection.
A cutover record must additionally identify the deployed release and operator
evidence. Update this map in the same change that moves an entry point.

## Authority And Conflict Resolution

Use this order when sources disagree:

1. Security and data invariants in `AGENTS.md` and
   `docs/development/SECURITY_AND_DATA.md`.
2. Product and protocol contracts for the affected lane.
3. The active-owner status in `EVOLUTION.md`.
4. The durable backend rules in this directory.
5. Current code and tests as evidence of implemented behavior.

Do not silently resolve a disagreement. Record it in the migration PR and
update the canonical contract together with the intended implementation.

## Documentation Lifecycle

These documents are deliberately written as durable backend support material:

- During migration, `EVOLUTION.md` distinguishes current and target ownership.
- Each cutover PR updates the status ledger and any rule made executable by the
  slice.
- After final cutover, this index changes from "approved target" to "current
  architecture"; the architecture, technology, boundary, contract, operations,
  validation, and agent documents remain in place.
- `EVOLUTION.md` retains the completed migration record and becomes the entry
  point for later architecture changes and compatibility transitions.
- Historical Node implementation details are removed only when the matching
  migration is `complete` and rollback no longer depends on them.

## Canonical Terms

- **P2P private lane:** temporary direct communication; the server may relay
  validated secure envelopes but never persists plaintext message or file
  content.
- **Workspace relay lane:** authenticated, authorized, server-retained shared
  space with quotas, retention, audit, and realtime projections.
- **Edge gateway:** the existing Nginx/Caddy-facing public ingress. It routes and
  applies transport controls but is not the sole authorization boundary.
- **Capability:** a user-visible or operational behavior that can be migrated
  and routed as one unit.
- **Active owner:** the only implementation allowed to serve production writes
  for a capability.
