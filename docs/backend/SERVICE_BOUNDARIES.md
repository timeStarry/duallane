# Backend Service Boundaries

## 1. Boundary Rule

A process boundary is justified by a trust boundary, independent failure mode,
or independently retryable workload. A package boundary is preferred when the
behavior needs the same transaction, authorization decision, or release unit.

The target has four commands, not a service per domain noun:

| Command | Process role | Persistent/external dependencies |
| --- | --- | --- |
| `p2p` | Private-lane room and secure-envelope relay | None |
| `workspace` | Workspace HTTP, auth, domain operations, storage coordination, realtime | PostgreSQL and local/S3 object store |
| `worker` | Retryable notifications, Bot deliveries, cleanup, reconciliation | PostgreSQL and approved external targets |
| `migrate` | Ordered schema migration and required seed reconciliation | PostgreSQL |

## 2. Target Source Layout

```text
apps/backend/
  go.mod
  cmd/
    p2p/
    workspace/
    worker/
    migrate/
  internal/
    platform/
      config/
      httpserver/
      logging/
      metrics/
      postgres/
      storage/
    p2p/
      application/
      transport/
    workspace/
      auth/
      members/
      conversations/
      messages/
      files/
      emotes/
      bots/
      topics/
      echo/
      events/
    worker/
      email/
      ntfy/
      botdelivery/
      cleanup/
  api/
    openapi.yaml
    realtime/
  db/
    queries/
```

This is a placement map, not a requirement to create empty packages. Add a
package only with the first capability it owns.

## 3. Dependency Direction

```text
cmd composition
    -> transport adapters
        -> application/domain operations
            -> narrow repository/storage/delivery interfaces
                <- PostgreSQL, object store, SMTP, ntfy implementations
```

Rules:

- `cmd/*` wires dependencies and lifecycle; it contains no domain rules.
- HTTP and WebSocket transports parse, authenticate, call one operation, and
  project the result. They do not open transactions or write audit rows.
- Application/domain packages own authorization, validation, idempotency,
  transaction scope, audit intent, event intent, and state transitions.
- PostgreSQL packages implement domain-owned interfaces and never import HTTP
  transport packages.
- Storage and delivery adapters expose bounded operations and safe errors; they
  do not decide user authorization.
- Platform packages must be trust-lane neutral. A helper that knows Workspace
  membership, P2P envelope contents, or product policy belongs to that domain.
- Cross-domain imports use an explicit exported contract. Import cycles or a
  generic `common` package are design failures, not problems to hide with global
  state.

## 4. P2P Ownership

The P2P command owns only:

- room ID generation, expiry, capacity, and empty-room cleanup;
- ICE server response projection and bounded TURN credential generation;
- WebSocket lifecycle and peer membership;
- allowlisted secure-envelope version/channel/encoding/size validation;
- transient fanout and safe system events.

It must not:

- accept plaintext message/file payloads or arbitrary frame shapes;
- persist room, peer, envelope, message, file, or invite-fragment content;
- receive or reconstruct the browser `#k=` secret;
- use Workspace sessions, identities, audit tables, object storage, or jobs;
- emit logs or metrics labeled with ciphertext, nonce, display-name content, or
  complete room identifiers.

Initial room ownership remains local to one process. A future scale-out design
must remain in the P2P domain and cannot silently adopt Workspace
infrastructure.

## 5. Workspace Ownership

The Workspace command is one bounded context with internal packages. It owns:

- feature gating and public capability projection;
- GitHub OAuth, invites, users, opaque sessions, and actor resolution;
- space/conversation membership and all resource authorization;
- messages, reactions, recalls, read state, pins, topics, cards, interactions,
  Bots, and Echo behavior;
- quota reservation and transfer state;
- logical attachments, avatars, emotes, storage-object references, and
  authorized delivery;
- audit intent and persistent realtime events;
- Workspace and Bot WebSocket admission, replay, filtering, and fanout.

These responsibilities may be separate packages but remain in one service while
their accepted mutations share transactions or authorization state. In
particular, auth, messages, files, quota, audit, and events are not candidate
microservices during the initial migration.

## 6. Worker Ownership

The worker owns execution, retry, and terminal status for durable external jobs.
The Workspace command owns creation of those jobs inside the accepting domain
transaction.

Allowed worker writes are limited to:

- claim/lease timestamps and instance identity;
- attempts, next-attempt time, safe failure code, cancellation, and completion;
- delivery/provider identifiers that contain no credentials or message content;
- reconciliation checkpoints in worker-owned tables;
- calls to an explicit Workspace application operation when a resulting domain
  mutation is required.

The worker re-reads current membership, notification preferences, message
visibility, recall/deletion state, and other cancellation conditions before an
external effect. A job row is permission to evaluate delivery, not permanent
authorization to disclose content.

No external delivery occurs inside the transaction that accepted the user
command. Provider timeouts, retry classification, and idempotency are explicit
per adapter.

## 7. Database Ownership

PostgreSQL is a shared deployment dependency but not an unowned integration
surface.

| Data | Writer |
| --- | --- |
| Workspace domain rows | Workspace application operation |
| Sessions and OAuth/invite binding | Workspace auth operations |
| Quota and transfer ledger | Workspace file operation |
| Audit and realtime event rows | The accepting Workspace transaction |
| Notification/Bot job creation | The accepting Workspace transaction |
| Job lease/attempt/delivery state | Worker adapter |
| Schema version and seed reconciliation | Migration command |
| P2P state | No database writer; transient P2P process only |

Direct SQL from a transport handler is prohibited. Direct domain-table mutation
from the worker is prohibited unless it calls a reviewed application operation
that preserves authorization, audit, and event behavior.

Database roles may be separated later to enforce these permissions. Until then,
tests and review enforce ownership; the credentials do not grant architectural
permission to use every table.

## 8. Gateway And Internal Communication

Nginx routes public paths directly to the owning service. There is no initial Go
business gateway and no initial synchronous P2P-to-Workspace or
Workspace-to-worker RPC.

If a future capability requires synchronous internal communication, its design
must state:

- why a package or database-owned workflow cannot satisfy it;
- authentication, authorization, request identity, and timeout behavior;
- retry and duplicate semantics;
- safe error projection and observability;
- version compatibility during rolling deployment;
- the effect of partial outage and the fallback behavior.

The default internal protocol is HTTP/JSON over the private Compose network only
after such a decision. Do not add gRPC or a service mesh implicitly.

## 9. Media Processing Boundary

Avatar and custom-emote processing is a Workspace adapter behind a narrow
interface accepting bounded bytes/streams and returning normalized metadata plus
content. Authorization, quota/storage policy, logical records, and object
references stay in the Workspace domain.

The adapter may use govips only after the compatibility gate in
[Technology decisions](TECHNOLOGY.md). It must bound input bytes, decoded pixels,
dimensions, frames, duration, processing concurrency, and output bytes before
the normalized object is committed.

## 10. Placement Test For New Work

Place a capability by answering in order:

1. Which trust lane owns the user promise?
2. Which existing transaction must be atomic with it?
3. Which service has the authoritative authorization state?
4. Is the work a request-time domain decision or a retryable external effect?
5. Does a separate process isolate a demonstrated failure/load pattern?

If the capability shares a Workspace transaction or authorization decision, add
a Workspace package. If it is an external retryable effect, add a worker
adapter and durable job. If it handles P2P secure relay, keep it entirely in
P2P. Create another service only after documenting why none of these ownership
models is correct.
