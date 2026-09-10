# Backend Architecture Guide

This directory is the progressive-disclosure entry point for the DualLane Go
backend and the 0.18 Node-runtime retirement. The verified 0.17.0 baseline is
recorded in the bridge/release record; the checked-in 0.18 online architecture is Go-only for P2P,
Workspace, Web, worker, and migration ownership. Use [Evolution and migration](EVOLUTION.md)
for ownership and the [retirement work item](work-items/2026-09-10-node-runtime-retirement.md)
for validation and activation status; these records distinguish a checked-in
target from a deployed release.

## Start Here

Every backend task must first read:

1. [`AGENTS.md`](../../AGENTS.md) and the
   [development index](../development/README.md).
2. [`README.md`](../../README.md), [`DESIGN.md`](../../DESIGN.md), and the
   smallest relevant product or protocol contract.
3. This index and [Evolution and migration](EVOLUTION.md) to identify the
   current implementation owner.
4. Only the topic documents routed below.

The [0.17 bridge/release record](work-items/2026-09-10-chat-0170-after-bridge.md)
identifies the historical deployed commit/images, schema-34 evidence,
single-owner checks, and recovery artifacts. The [0.18 retirement work item](work-items/2026-09-10-node-runtime-retirement.md)
records the new owner boundary, validation/activation ledger, and rollback
contract. The product and security documents remain authoritative for behavior
throughout the transition.

## Document Map

| Document | Canonical responsibility |
| --- | --- |
| [Target architecture](ARCHITECTURE.md) | System shape, trust lanes, process topology, consistency model, and scaling boundaries |
| [Technology decisions](TECHNOLOGY.md) | Approved Go stack, dependency policy, conditional choices, and rejected alternatives |
| [Service boundaries](SERVICE_BOUNDARIES.md) | Runtime and package ownership, dependency direction, database access, and placement rules |
| [Contracts and data](CONTRACTS_AND_DATA.md) | HTTP/WebSocket compatibility, sessions, transactions, events, migrations, storage, and sensitive data handling |
| [Runtime and operations](OPERATIONS.md) | Containers, configuration, health, startup, shutdown, observability, deployment, and rollback |
| [Storage operator](STORAGE_OPERATOR.md) | Candidate catalog/byte verification, explicit bucket provisioning, container permission gates and mutation safety boundaries |
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

Production uses one Go module containing separate P2P, Workspace, worker and
migration commands. Nginx is the only public application gateway; it routes
P2P to `p2p` and authenticated Workspace/auth/Bot traffic to `workspace`.
PostgreSQL remains the Workspace system of record, with the same S3 primary
and local mirror. P2P remains a separate no-persistence lane. The online owner
is Go; the old Node API/worker/gateway is retired from the current tree. Keep
only canonical SQL under `apps/web/server/migrations`, the shared/frontend
contract assets, package SDK code, and the isolated `tools/node-compat`
offline storage operators. Historical release-helper/immutable-image recovery
and frozen Node golden evidence remain compatibility records, not startup code
or a second writer.

See [Evolution and migration](EVOLUTION.md) for the live owner of each
capability. A directory, binary, image, or passing test is not sufficient to
change ownership; the status ledger and production route must agree.

## Find The Executable Evidence

Read only the row needed for the task. These are repository entry points, not
a claim that every candidate capability is integrated, verified, or deployed.

| Question | Inspect |
| --- | --- |
| Which backend does the checked-in deployment select? | [root Go-only Compose](../../docker-compose.yml), [Go runtime definitions](../../docker-compose.go-production.yml), [production override](../../docker-compose.production.yml), and [candidate gateway](../../deploy/candidate/nginx.conf) |
| Where is a Go candidate composed? | [P2P](../../apps/backend/cmd/p2p/main.go), [Workspace](../../apps/backend/cmd/workspace/main.go), [worker](../../apps/backend/cmd/worker/main.go), or [migration](../../apps/backend/cmd/migrate/main.go) |
| Which versions and checks are executable? | [Go module](../../apps/backend/go.mod), [Makefile](../../apps/backend/Makefile), [root scripts](../../package.json), and [CI](../../.github/workflows/ci.yml); see [Validation](VALIDATION.md) for the required evidence |
| Which candidate images exist? | [P2P image](../../Dockerfile.p2p) and [Workspace image](../../Dockerfile.workspace); image existence does not establish a Compose service or cutover |
| Which contracts and migrations are present? | [Candidate API directory](../../apps/backend/api) and [canonical SQL migrations](../../apps/web/server/migrations); inspect coverage before assuming a whole API family is characterized |
| Where is the foundation/contract slice evidence? | [2026-09-06 work record](work-items/2026-09-06-foundation-contracts.md); includes exact tested commits and excluded draft failures |
| What records retirement validation and activation status? | [0.18 Node-runtime retirement work item](work-items/2026-09-10-node-runtime-retirement.md) for the acceptance ledger and artifact identities; [historical work record](work-items/2026-09-06-predeployment.md) for slice provenance and parallel ownership |

The root Compose pair is Go-only by default: `docker-compose.yml` extends
`docker-compose.go-production.yml` and has no online `api` service. Live
production uses the same Go service topology and the
[candidate gateway](../../deploy/candidate/nginx.conf) through the guarded
release entry point. Do not infer exact deployed commit/image state from a
Compose file or iteration test; consult the 0.17 bridge/release record and the
0.18 retirement work item before an upgrade. Subsequent Go upgrades require the
prior private recovery snapshot.

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
- The current tree may remove retired online Node source before the acceptance
  ledger records final status; final-head evidence and activation status live in
  the work item. Historical Node material may remain only as frozen
  release-helper/immutable-image recovery, synthetic tests, golden provenance,
  or the isolated offline storage package.

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
