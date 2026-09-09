# Go backend capability audit — 2026-09-06

This is a read-only, pre-deployment capability audit. It compares the
currently observable Node HTTP/WebSocket surface, jobs, maintenance commands,
startup effects, and deployment flow with the Go candidates. It records
composition and verification, not just packages or route declarations.

No production owner, route status, migration history, or architecture decision
is changed by this document.

This is a historical `777fc84` snapshot, not the current capability ledger.
The parent has since accepted Bot shared transactions (`0be0335`), release
snapshots/publication (`d3dd10c`), Bot persisted request hashes (`d49dcb1`), and
the presence domain (`30fc0ef`). Runtime composition and later acceptance are
tracked in [the predeployment work item](2026-09-06-predeployment.md);
[the ownership ledger](../EVOLUTION.md) remains authoritative. References below
to missing or uncommitted code describe the snapshot, not later commits.

## Snapshot and audit rules

| Item | Observed value |
| --- | --- |
| Worktree | D:/Project/duallane |
| Branch | codex/go-backend-architecture |
| Requested comparison baseline | 418a306 and 7d8cc71 |
| Audited HEAD | 777fc84, fix(files): isolate upload attempts before locked part publication |
| Snapshot drift after the requested baseline | Current history includes 91847ca Bot quota reservation, e8bd0de Echo replay-field presence, 702d8d1 Bot REST transport, 33ba294 documentation, the Avatar commits, and 777fc84 upload-attempt isolation |
| Worktree drift | Uncommitted Bot Gateway runtime/request/WebSocket drafts, Echo delivery/solicitation/release drafts, and unrelated P2P e2e files are present |
| Additional committed facts | 91847ca reserved Agent Bot quota only; e8bd0de fixes explicit empty duplicate-ID presence in requirement replay hashes; 777fc84 commits independent request staging at workspace/uploads/{uploadID}/attempts/{uuid}. Parent reports three real PG regressions first failed then passed, normal cleanup is bounded to 2 minutes, and crash-age cleanup still must exclude active uploads. |
| Schema history | No schema history change is included in these additional facts. |
| Production owner | Node remains the observed production owner; no Go cutover is inferred |

Sources inspected include:

- Node: apps/web/server/index.mjs, apps/web/server/routes, relevant
  services, apps/web/package.json, migrations, docker-compose.yml,
  docker-compose.production.yml, Dockerfiles, deploy/production/deploy.sh,
  deploy/nginx/default.conf, deploy/caddy/fs.tsio.top.caddy, and CI.
- Go: apps/backend/cmd/p2p, cmd/workspace, cmd/worker, cmd/migrate,
  internal/workspace/httpapi, domain packages, platform storage/media, and
  current uncommitted domain drafts.

Status vocabulary used below:

- Complete candidate means the route or job has an implementation, production
  composition in the observed Go command, and focused evidence. It does not
  mean production ownership has changed.
- Transport only means a handler or interface exists, but a required service,
  adapter, or command composition is absent.
- Domain only means service/repository code exists, but an external route or
  worker composition is absent.
- Absent means no corresponding Go implementation was found.
- unknown means the source snapshot does not prove the behavior either way.
- Parent-reported pass means the parent reported a pass; this worker did not
  execute that command during this read-only audit.

An empty registry, an unwired route, a missing-service response, a 501/service
unavailable path, or an upload flow that is only reserved but not transferred
and completed is not counted as complete.

## Critical gaps for the next split

| Priority | Capability | Current evidence | Required closure |
| --- | --- | --- | --- |
| P0 | Bot Gateway runtime and WebSocket | REST transport and root/Bearer tests exist in httpapi. The current workspace command does not construct botgateway.Service, NewRuntimeAdapters, or NewWebSocketHandler; router.go does not register /ws/bot-gateway. A valid enabled request reaches missing service and returns the generic internal error. | Compose the service from the existing bot/files/messages/cards services, register REST and WebSocket dependencies, and add a real application test for Bearer auth, replay, ack, heartbeat, revocation, and shutdown. |
| P0 | Feishu card conversion | The Node Bot Gateway calls `workspace-feishu-card-converter.mjs`; the snapshot does not establish an equivalent Go converter and card-action registration. | Characterize the actual Node converter, compose the supported elements/actions and validation, and test persistence/hash compatibility. A generic card registry is not conversion parity. |
| P0 | Bot Gateway reservation/runtime boundary | 91847ca commits quota reservation only. Node POST /api/bot-gateway/v1/attachments creates a reservation and Node has no Bot-authenticated content-upload channel. The committed Go files/agent_bot.go reservation is present, while uncommitted Bot Gateway runtime wiring is still absent. The missing Go command composition is real, but the absence of a Bot bytes endpoint is a shared Node limitation, not a Go refactor omission. | Compose and test the reservation/auth/quota/audit/idempotency path. Do not invent a Bot content-upload route or require Bot reserve-to-bytes-to-complete parity unless the Node contract first adds one. |
| P0 | Echo HTTP and delivery | Node registers requirements and solicitations routes, a non-empty Echo runtime/card registry, event recovery, and a 15-second delivery worker. Go Echo requirements are tracked; solicitation, release, and delivery code is currently uncommitted. No Echo HTTP registration or worker composition is present in cmd/workspace or cmd/worker. | Add the thin HTTP adapters, non-empty production definitions, delivery composition, worker claim/retry behavior, and route plus PG/replay evidence. |
| P0 | Upload/object cleanup | Node runs inactive chunk cleanup at startup and every 30 minutes and S3 multipart cleanup every 6 hours. 777fc84 commits independent request staging under workspace/uploads/{uploadID}/attempts/{uuid}; parent reports three real PG regressions first failed then passed and normal cleanup bounded to 2 minutes. Go still has no worker processor for crash residuals. | Add bounded maintenance for crash residuals using the unique upload prefix plus age, never touching an active upload. Test stale transfers, object references, retries, and provider cleanup; keep physical-delete safety inside the object lock/reference transaction. |
| P1 | Presence-aware notification delivery | Node tracks user WebSocket presence and defers immediate email for online users. Go has Email.ProcessJobsWithPresence and StartWorkerWithPresence, but cmd/worker calls ProcessJobs and realtime has no user presence source. | Compose presence with the workspace WebSocket lifecycle and use the presence-aware email processor; test online/offline and reconnect races. |
| P1 | Bot owner connection APIs | Node exposes GET /api/workspace/bots/:botId/connection and POST /api/workspace/bots/:botId/connection/test. No corresponding Go bots service methods or routes were found. | Decide and implement the owner-facing contract, or document a deliberate compatibility exclusion before any owner migration. |
| P1 | Production candidate and gateway | Production Compose and deploy/production/deploy.sh build/start Node api, web, and migrate only. Dockerfile.workspace, Dockerfile.p2p, and the Go worker image are candidates but are not selected by Compose/deploy. Nginx proxies to the Node api; Caddy object paths bypass the Go process. | Node remains the production owner. Define any future Go candidate deployment and health/rollback path separately; no Go cutover is authorized or claimed here. |
| P1 | Cards, commands, and workflows | Go routes and services exist, but cmd/workspace constructs empty cards, command, and workflow registries. Node createEchoRuntime supplies non-empty definitions. | Compose the same definitions and add a production composition assertion; route/service unit tests alone do not prove the behavior. |
| P1 | Migration and storage maintenance | Node owns db:migrate, storage:provision, storage:migrate, and storage:dedupe. Go cmd/migrate runs canonical numbered SQL and seed only; no Go storage maintenance command was found. | Assign ownership and validation for provision, backfill, verify, dedupe, legacy cleanup, and rollback. Preserve the existing SQL history. |
| P2 | SMTP and query-generation selections | Node selects injected sendMail or nodemailer. Go defaults to a net/smtp implementation. docs/backend/TECHNOLOGY.md says sqlc and go-mail are selected but neither is pinned or integrated. | Resolve selected versus pinned versus integrated versus verified status before treating the Go stack as final. |

## Layer 1: process, startup, gateway, and deployment

### Node production process

The Node app in apps/web/server/index.mjs is the observed runtime owner.
createApp:

1. Computes the exact Workspace feature gate, opens the database, and in the
   normal production Compose path consumes the successful migrate service.
2. Creates the local/S3/Hybrid object store, asserts storage readiness, and
   starts provider multipart cleanup where applicable.
3. Constructs storage-object registry and upload-chunk services, performs
   inactive upload cleanup on startup, and starts the 30-minute cleanup timer.
4. Constructs email, ntfy, workspace presence, bots, Echo runtime,
   cards/interactions, bot gateway, and topic services.
5. Starts email, ntfy, and Echo workers after their startup delay and subscribes
   them to workspace events.
6. Registers parsers, HTTP routes, Workspace WebSocket replay/presence, and Bot
   Gateway WebSocket heartbeat/replay.
7. On close, stops timers/workers/subscriptions and closes storage/database
   resources.

P2P is an in-memory Node service with room TTL and empty-room grace cleanup;
server-side plaintext message/file persistence is not part of that lane.

### Go process and gateway observation

| Process | Current composition | Gap |
| --- | --- | --- |
| cmd/p2p | Constructs the Go P2P handler and generated contract surface. | Candidate evidence exists; Node remains production owner and the current deployment does not select this Go process. |
| cmd/workspace | Checks the schema read-only before serving, constructs core Workspace services, one media processor, the blob store, Avatar service, file service, notifications, and realtime. It does not apply migrations. | No Bot Gateway service/adapters, Bot Gateway WebSocket, Echo services/delivery, presence registry, or non-empty card/interaction definitions are composed. |
| cmd/worker | Performs a read-only schema check and runs only ntfy and email processors when enabled. | No Echo delivery, upload staging, object cleanup/dedupe, or presence composition. |
| cmd/migrate | Runs the Go canonical numbered migrations and seed. | Does not replace Node storage provision/migrate/dedupe. |
| Dockerfile.workspace | Builds Go workspace, worker, and migrate binaries; its runtime entrypoint is the workspace binary. | It is not selected by the production Compose files and does not by itself start the worker. |
| Dockerfile.api/web | Node images used by current Compose. | Go is not part of the observed production candidate. |

Workspace is protected by the Go gate middleware and Node exact gate, but this
audit does not infer that their deployment/configuration owners are already
equivalent.

### Gateway and deployment flow

| Surface | Node evidence | Go relation |
| --- | --- | --- |
| Nginx API | deploy/nginx/default.conf proxies /api/ and /ws/ to api:8787 and sets an 11 MiB request cap. | No Go process is selected behind that upstream. |
| Nginx static/fallback | /emotes/, /integrations/vN/, /integrations/, and root static fallback are served/proxied outside the Go workspace router. | Go has no equivalent frontend/static owner in cmd/workspace. |
| Caddy object paths | deploy/caddy/fs.tsio.top.caddy proxies attachment/profile-avatar/custom-emote/sha256 object paths directly to the object service. | These requests bypass Go HTTP handlers; the future Go deployment must preserve storage authorization and cache semantics. |
| Production deployment | deploy/production/deploy.sh requires a clean main checkout and expected commit, dumps PostgreSQL, builds api/web/migrate, runs Node migrate, preflights Node candidates, then replaces api/web with rollback checks. | No Go build, worker, P2P, or Go health/rollback smoke is included. |
| CI | .github/workflows/ci.yml runs Go quality/integration and Node quality/build; Docker checks build web/api/migrate. | No Go production Compose build or route/worker deployment smoke is present. |

## Layer 2: external endpoint audit

The Node entries below are taken from index.mjs and the explicitly registered
workspace route modules. Each method/path is listed even when several routes
share one Go file.

### Public health, authentication, P2P, and static entry

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET / | Node production fastify-static plus index fallback. | No Go equivalent in cmd/workspace. Node/web gateway remains the production owner. |
| GET /api/health | Go workspace router health handler and Go P2P health/contract handler are separate process surfaces. | Go candidate evidence in cmd/p2p and cmd/workspace health tests/integration; Node remains the production owner and no Go routing cutover is claimed. |
| POST /api/p2p/rooms | internal/p2p/transport.go Handler.RegisterRoutes and cmd/p2p. | P2P transport/contract tests and security tests cover body validation and room privacy. Node remains production owner; no Go routing cutover is claimed. |
| GET /api/p2p/ice-servers | internal/p2p/transport.go and cmd/p2p. | P2P transport/security/contract tests cover projections; the Go candidate is not selected by the current production deployment. |
| GET /api/p2p/rooms/:roomId | internal/p2p/transport.go and cmd/p2p. | P2P transport/security tests cover missing rooms and non-secret responses; Node remains production owner. |
| GET /ws/p2p/:roomId | internal/p2p/transport.go and cmd/p2p. | transport_test.go and transport_security_test.go cover secure-envelope-only relay, size and close behavior; the Go candidate is not selected by the current production deployment. |
| GET /api/auth/github/start | httpapi/router.go auth routes with auth.HTTPHandler, composed by cmd/workspace. | auth/auth_test.go and request metadata tests cover the handler; no Go production deployment cutover. |
| GET /api/auth/github/callback | httpapi/router.go auth routes with auth.HTTPHandler, composed by cmd/workspace. | auth/auth_test.go covers callback state/development behavior; Node remains production owner, while external GitHub configuration is a separate unknown. |
| POST /api/auth/logout | httpapi/router.go auth routes with auth.HTTPHandler, composed by cmd/workspace. | auth/auth_test.go covers logout; production owner remains Node. |

### Workspace bootstrap, profile, member, settings, and avatar

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET /api/workspace/bootstrap | httpapi bootstrap route and bootstrap.Service, composed by cmd/workspace. | bootstrap route/service tests exist; startup cleanup is not equivalent to a scheduled cleanup worker. |
| GET /api/workspace/statistics | httpapi core route and overview.Service, composed by cmd/workspace. | core/overview tests exist; parent-reported workspace checks are not independently rerun here. |
| GET /api/workspace/conversations | httpapi core route listConversations and conversations.Service. | core route/service/PG tests exist. |
| GET /api/workspace/conversations/:conversationId | httpapi core route getConversation and conversations.Service. | core route/service/PG tests exist. |
| GET /api/workspace/members | httpapi core route listMembers and members.Service. | core route/service/PG tests exist. |
| PATCH /api/workspace/me/profile | httpapi core route updateOwnProfile and members.Service. | core route/service tests exist. |
| PUT /api/workspace/me/avatar | httpapi/avatar_routes.go RegisterAvatarRoutes and avatars.Service, media.Processor, blob store, and LegacyReader; composed by cmd/workspace. | 0b9c6c1 added real workspace HTTP/PG/media composition evidence in cmd/workspace/main_integration_test.go; avatar_routes_test.go and the Node avatar contract test cover transport. This is not a current implementation gap; Node remains the production owner. |
| DELETE /api/workspace/me/avatar | httpapi/avatar_routes.go and avatars.Service, composed by cmd/workspace. | Same Avatar integration and route evidence; Node remains production owner and no Go cutover is claimed. |
| GET /api/workspace/avatars/:userId/:version | httpapi/avatar_routes.go delivery path with domain authorization and legacy read, composed by cmd/workspace. | Avatar route tests and real HTTP/PG/media integration exist in the observed HEAD; no production Go deployment. |
| GET /api/workspace/settings/email | httpapi/email_routes.go and email.Service, composed by cmd/workspace. | email route/service/PG tests exist. Go uses the default SMTPMailer unless explicitly overridden. |
| POST /api/workspace/settings/email/test | httpapi/email_routes.go and email.Service. | Email service tests inject a Mailer; no real Go SMTP integration evidence or go-mail integration. |
| PUT /api/workspace/settings/email | httpapi/email_routes.go and email.Service. | Email route/service/PG tests exist; SMTP implementation selection is a technology gap described below. |
| GET /api/workspace/me/notifications | httpapi/email_routes.go and email.Service. | Email route/service/PG tests exist. |
| PATCH /api/workspace/me/notifications | httpapi/email_routes.go and email.Service. | Email route/service/PG tests exist. |
| POST /api/workspace/me/notification-email/challenges | httpapi/email_routes.go and email.Service. | Email route/service tests cover challenge behavior; production sender selection remains open. |
| POST /api/workspace/me/notification-email/verify | httpapi/email_routes.go and email.Service. | Email route/service/PG tests exist. |
| POST /api/workspace/me/notification-email/use-github | httpapi/email_routes.go and email.Service. | Email route/service tests exist. |
| GET /api/workspace/me/ntfy | httpapi/ntfy_routes.go and ntfy.Service, composed by cmd/workspace. | ntfy route/service/PG tests exist. |
| PATCH /api/workspace/me/ntfy | httpapi/ntfy_routes.go and ntfy.Service. | ntfy route/service/PG tests exist. |
| POST /api/workspace/me/ntfy/rotate | httpapi/ntfy_routes.go and ntfy.Service. | ntfy route/service/PG tests exist; worker composition is separately incomplete. |
| POST /api/workspace/invites | router.go invite handler and invites.Service. | auth/invite/service/PG tests exist. |
| POST /api/workspace/invites/:inviteId/revoke | router.go invite handler and invites.Service. | auth/invite/service/PG tests exist. |
| POST /api/workspace/invites/:code/accept | router.go development invite adapter to auth.HTTPHandler. | auth tests cover this development path; production invite/session semantics require the normal auth configuration. |
| PUT /api/workspace/members/:userId/remark | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |
| DELETE /api/workspace/members/:userId/remark | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |
| GET /api/workspace/member-visibility/:userId | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |
| PUT /api/workspace/member-visibility/:userId | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |
| PATCH /api/workspace/members/:userId/role | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |
| DELETE /api/workspace/members/:userId | httpapi/core_routes.go and members.Service. | core route/service/PG tests exist. |

### Emotes

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET /api/workspace/me/emote-settings | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists; emote service is composed by cmd/workspace. |
| PUT /api/workspace/me/emote-settings | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| GET /api/workspace/me/emotes | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| GET /api/workspace/me/emote-library | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/me/emotes | httpapi/emote_routes.go and emotes.Service with media/storage integration. | Focused route/service/PG tests and declared-overage rejection work exist; the Node custom-emote body cap and Go error mapping should remain contract-tested. |
| PUT /api/workspace/me/emote-library/order | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/me/emote-collections | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| PATCH /api/workspace/me/emote-collections/:collectionId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| PUT /api/workspace/me/emote-collections/:collectionId/source-subscription | httpapi/emote_routes.go and emotes.Service. | Source-subscription synchronization has current work and focused tests; composition is present. |
| DELETE /api/workspace/me/emote-collections/:collectionId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/me/emote-collections/:collectionId/items | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| DELETE /api/workspace/me/emote-collections/:collectionId/items/:emoteId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| PUT /api/workspace/me/emote-collections/:collectionId/order | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/me/emote-collections/:collectionId/shares | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| DELETE /api/workspace/emote-collection-shares/:shareId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| GET /api/workspace/emote-collection-shares/:shareId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/emote-collection-shares/:shareId/import | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| POST /api/workspace/me/emotes/favorite | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| PUT /api/workspace/me/emotes/order | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| PATCH /api/workspace/me/emotes/:emoteId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| DELETE /api/workspace/me/emotes/:emoteId | httpapi/emote_routes.go and emotes.Service. | Route/service/PG coverage exists. |
| GET /api/workspace/emotes/:emoteId/content | httpapi/emote_routes.go and emotes.Service/blob store. | Content authorization and storage tests exist; Node remains the production owner. |

The Node custom-emote upload has a declared body limit. Fastify's rejected
body contract is request.too_large; that code comes from the request parser,
not a custom Fastify route code. Any Go compatibility test must compare the
actual response contract rather than assume a domain overage code.

### Conversations, messages, and topics

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| POST /api/workspace/conversations | httpapi/core_routes.go createConversation and conversations.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/groups/:conversationId/members | httpapi/core_routes.go addConversationMember and conversations.Service. | Core route/service/PG tests exist. |
| DELETE /api/workspace/groups/:conversationId/members/:userId | httpapi/core_routes.go removeConversationMember and conversations.Service. | Core route/service/PG tests exist. |
| PATCH /api/workspace/groups/:conversationId | httpapi/core_routes.go updateGroupConversation and conversations.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/groups/:conversationId/leave | httpapi/core_routes.go leaveConversation and conversations.Service. | Core route/service/PG tests exist. |
| GET /api/workspace/conversations/:conversationId/messages | httpapi/core_routes.go listMessages and messages.Service. | Core route/service/PG tests exist. |
| GET /api/workspace/groups/:conversationId/pins | httpapi/core_routes.go listPins and conversations.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/groups/:conversationId/pins | httpapi/core_routes.go pinMessage and conversations.Service. | Core route/service/PG tests exist. |
| DELETE /api/workspace/groups/:conversationId/pins/:messageId | httpapi/core_routes.go unpinMessage and conversations.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/conversations/:conversationId/read | httpapi/core_routes.go markConversationRead and conversations.Service. | Core route/service/PG tests exist; email digest reconciliation is a service-side concern. |
| PATCH /api/workspace/conversations/:conversationId/notification | httpapi/core_routes.go updateConversationNotification and conversations.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/messages | httpapi/core_routes.go createMessage and messages.Service. | Core route/service/PG/idempotency tests exist; notification scheduling is composed through messagejobs/service dependencies. |
| POST /api/workspace/messages/:messageId/recall | httpapi/core_routes.go recallMessage and messages.Service. | Core route/service/PG tests exist. |
| PUT /api/workspace/messages/:messageId/hidden | httpapi/core_routes.go hideMessage and messages.Service. | Core route/service/PG tests exist. |
| DELETE /api/workspace/messages/:messageId/hidden | httpapi/core_routes.go unhideMessage and messages.Service. | Core route/service/PG tests exist. |
| POST /api/workspace/messages/:messageId/reactions | httpapi/core_routes.go addReaction and messages.Service. | Core route/service/PG tests exist. |
| DELETE /api/workspace/messages/:messageId/reactions/:emoteKey | httpapi/core_routes.go removeReaction and messages.Service. | Core route/service/PG tests exist. |
| GET /api/workspace/topics/mine | httpapi/topic_routes.go listOwnTopics and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/topics | httpapi/topic_routes.go listTopics and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/conversations/:conversationId/topics | httpapi/topic_routes.go listConversationTopics and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/conversations/:conversationId/topics | httpapi/topic_routes.go createTopic and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/topics/:topicId/messages | httpapi/topic_routes.go listTopicMessages and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/messages | httpapi/topic_routes.go createTopicMessage and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/read | httpapi/topic_routes.go markTopicRead and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/topics/:topicId/members | httpapi/topic_routes.go listTopicMembers and topics.Service. | Topic route/service/PG tests exist. |
| PATCH /api/workspace/topics/:topicId/notification | httpapi/topic_routes.go updateTopicNotification and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/messages/:messageId/sync | httpapi/topic_routes.go syncTopicMessage and topics.Service. | Topic route/service/PG tests exist. |
| DELETE /api/workspace/topics/:topicId/messages/:messageId/sync | httpapi/topic_routes.go unsyncTopicMessage and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/topics/:topicId/projections | httpapi/topic_routes.go listTopicProjections and topics.Service. | Topic route/service/PG tests exist. |
| GET /api/workspace/topics/:topicId | httpapi/topic_routes.go getTopic and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/join | httpapi/topic_routes.go joinTopic and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/leave | httpapi/topic_routes.go leaveTopic and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/close | httpapi/topic_routes.go closeTopic and topics.Service. | Topic route/service/PG tests exist. |
| POST /api/workspace/topics/:topicId/archive | httpapi/topic_routes.go archiveTopic and topics.Service. | Topic route/service/PG tests exist. |

### Files and upload/download endpoints

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| POST /api/workspace/files/uploads/reserve | httpapi/file_routes.go reserveFileUpload and files.Service. | file_routes_test.go and files PG tests cover the common Workspace contract. Bot Gateway has a separate narrow reservation draft; no full Bot HTTP composition evidence. |
| GET /api/workspace/files/uploads/:uploadId | httpapi/file_routes.go getFileUploadStatus and files.Service. | Focused route/service/PG tests exist. |
| PUT /api/workspace/files/uploads/:uploadId/parts/:partNumber | httpapi/file_routes.go uploadFilePart and files.Service/blob store. | Focused route/service/storage tests exist; Node uses 4 MiB parts and a 10,000-part cap. Worker cleanup composition is missing in Go. |
| POST /api/workspace/files/uploads/:uploadId/complete | httpapi/file_routes.go completeFileUpload and files.Service/blob store. | Focused route/service/storage tests exist. Node has no Bot-specific content-upload channel, so a Bot reservation-to-complete parity test is not a current Node contract requirement. |
| PUT /api/workspace/files/uploads/:uploadId/content | httpapi/file_routes.go uploadFileContent and files.Service/blob store. | Focused route/service/storage tests exist; the request body bound and bot authorization handoff need an end-to-end compatibility test. |
| POST /api/workspace/files/uploads/:uploadId/fail | httpapi/file_routes.go failFileUpload and files.Service. | Focused route/service tests exist; no scheduled stale-transfer worker composition. |
| GET /api/workspace/files | httpapi/file_routes.go listFiles and files.Service. | Focused route/service/PG tests exist. |
| DELETE /api/workspace/files/:attachmentId | httpapi/file_routes.go removeFile and files.Service/blob store. | Storage lock/reference tests exist; object cleanup must remain protected by the object lock and committed reference check. |
| POST /api/workspace/files/:attachmentId/downloads/reserve | httpapi/file_routes.go reserveFileDownload and files.Service. | Focused route/service/PG tests exist. |
| GET /api/workspace/files/:attachmentId/preview | httpapi/file_routes.go previewFile and files.Service/blob store. | Focused route/storage tests exist. |
| GET /api/workspace/files/:attachmentId/download | httpapi/file_routes.go downloadFile and files.Service/blob store. | Focused route/storage tests exist. |

Bot attachment behavior is deliberately split. Node's Bot Gateway
POST /api/bot-gateway/v1/attachments creates a reservation, and 91847ca adds
quota reservation only; Node has no Bot-authenticated content-upload channel.
The common Workspace upload endpoints listed above are a separate surface, and
the inspected Node source does not establish them as a Bot content channel.
Therefore the missing Bot bytes endpoint is a shared Node limitation/non-goal,
not a Go refactor omission. The committed Go files/agent_bot.go reservation and
the uncommitted botgateway/runtime_adapters.go runtime adapter correctly narrow
the reservation to a bot-authorized domain operation rather than falling back
to the human ReserveUpload API. The remaining Go gap is command/runtime
composition and reservation contract evidence; do not invent a new Bot content
route.

### Agent-bot owner HTTP endpoints

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| POST /api/workspace/bots | httpapi/bot_routes.go and bots.Service, composed by cmd/workspace. | bot_routes_test.go and bots service/PG tests exist. |
| GET /api/workspace/bots | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bots/:botId | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bots/:botId/settings | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| PATCH /api/workspace/bots/:botId/settings | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bots/:botId/group-policies | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| PATCH /api/workspace/bots/:botId/group-policies/:conversationId | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| PATCH /api/workspace/bots/:botId/context-grants/:conversationId | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/tokens | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/setup-sessions | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bot-setup/:sessionId | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bot-setup/:sessionId/approve | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bot-setup/:sessionId/deny | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/tokens/rotate | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bots/:botId/tokens | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/tokens/:tokenId/revoke | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/pause | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/resume | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| GET /api/workspace/bots/:botId/connection | No Go bots service method or route was found. | Absent; Node owner API must be assigned before any compatibility claim. |
| POST /api/workspace/bots/:botId/connection/test | No Go bots service method or route was found. | Absent; SMTP/HTTP connection testing semantics are unknown on the Go side. |
| DELETE /api/workspace/bots/:botId | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |
| POST /api/workspace/bots/:botId/delete/confirm | httpapi/bot_routes.go and bots.Service. | bot route/service/PG tests exist. |

### Cards and interactions

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET /api/workspace/cards/:cardId | httpapi/card_routes.go and cards.Service. | card_routes_test.go and card service/PG tests exist, but cmd/workspace uses an empty cards.Registry. |
| POST /api/workspace/cards/:cardId/actions | httpapi/card_routes.go and cards.Service. | Route/service tests exist, but production card definitions are not registered in cmd/workspace. |
| POST /api/workspace/interactions/commands | httpapi/interaction_routes.go and interactions.Service. | interaction_routes_test.go and service tests exist; cmd/workspace constructs an empty command registry. |
| POST /api/workspace/workflows | httpapi/interaction_routes.go and interactions.Service. | Route/service tests exist; cmd/workspace constructs an empty workflow registry. |
| GET /api/workspace/workflows/:workflowId | httpapi/interaction_routes.go and interactions.Service. | Route/service tests exist; empty production registry prevents Node command/workflow behavior. |
| POST /api/workspace/workflows/:workflowId/continue | httpapi/interaction_routes.go and interactions.Service. | Route/service tests exist; composition is incomplete. |
| POST /api/workspace/workflows/:workflowId/cancel | httpapi/interaction_routes.go and interactions.Service. | Route/service tests exist; composition is incomplete. |

Node createEchoRuntime supplies non-empty definitions for help, cancel,
publish, release, need, feedback, list, view, collect, implement, reject,
publish/requirement workflows, and requirement/solicitation/release cards.
The Go registry unit tests do not prove that those definitions are supplied by
the production command.

### Bot Gateway REST and WebSocket

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET /api/bot-gateway/v1/me | httpapi/bot_gateway_routes.go transport. | Root/Bearer route tests exist. RouterOptions.BotGateway is nil in cmd/workspace, so a valid enabled request fails the missingService guard. |
| POST /api/bot-gateway/v1/events/ack | httpapi/bot_gateway_routes.go transport. | Root/Bearer/shape tests exist; service and command composition are absent. |
| GET /api/bot-gateway/v1/conversations/:conversationId/context | httpapi/bot_gateway_routes.go transport. | Transport tests exist; no composed runtime service. |
| POST /api/bot-gateway/v1/messages | httpapi/bot_gateway_routes.go plus uncommitted botgateway.Service/runtime adapter drafts. | Route tests and adapter/transaction tests exist in the worktree; no cmd/workspace composition or real HTTP/PG application test. |
| POST /api/bot-gateway/v1/cards | httpapi/bot_gateway_routes.go plus cards runtime adapter draft. | Transport and adapter/transaction evidence exists; no command composition or real application test. |
| PATCH /api/bot-gateway/v1/cards/:cardId | httpapi/bot_gateway_routes.go plus cards runtime adapter draft. | Same composition gap. |
| GET /api/bot-gateway/v1/attachments/:attachmentId | httpapi/bot_gateway_routes.go and botgateway service draft. | Transport tests exist; file authorization/runtime service composition and delivery evidence are missing. |
| POST /api/bot-gateway/v1/attachments | httpapi/bot_gateway_routes.go and the committed narrow Agent Bot reservation adapter from 91847ca. | Reservation shape/quota work is committed, but command composition is absent. Node has no Bot content-upload endpoint, so no Bot bytes-to-complete test should be required without a new Node contract. |
| POST /api/bot-gateway/v1/typing | httpapi/bot_gateway_routes.go and botgateway service draft. | Transport tests exist; no command composition. |
| POST /api/bot-gateway/v1/setup/request | httpapi/bot_gateway_routes.go and bots.Service setup interface. | Transport/setup tests exist; RouterOptions.BotGatewaySetup is nil in cmd/workspace. |
| GET /api/bot-gateway/v1/setup/status | httpapi/bot_gateway_routes.go and bots.Service setup interface. | Same missing setup composition. |
| POST /api/bot-gateway/v1/setup/exchange | httpapi/bot_gateway_routes.go and bots.Service setup interface. | Same missing setup composition; raw-token response privacy needs the real application test. |
| GET /ws/bot-gateway | Node route has Bearer authentication, connection registration, 30-second heartbeat, hello/replay/ack, and shutdown cleanup. Go has an uncommitted botgateway/websocket.go handler and websocket unit tests, but router.go does not register it and cmd/workspace does not construct it. | Transport implementation is not an external Go capability until route and runtime composition plus a real app test exist. |

The phrase Bot REST exists therefore means only transport/root/Bearer coverage
from 702d8d1, not a usable composed Bot capability.

### Echo HTTP entries

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| POST /api/workspace/echo/requirements | Go echo/requirements service and PG repository exist; e8bd0de fixes requirement-field presence. | No Go httpapi route or cmd/workspace composition. Domain tests and Node replay/PG tests exist; the presence fix is domain compatibility evidence, not route/worker composition. |
| GET /api/workspace/echo/requirements | Go echo/requirements service and PG repository exist. | No Go route/composition. |
| GET /api/workspace/echo/requirements/stats | Go requirements domain may expose query support; no Go route was found. | No external composition or route test. |
| GET /api/workspace/echo/requirements/:publicId | Go requirements domain exists. | No Go route/composition. |
| GET /api/workspace/echo/requirements/:publicId/history | Go requirements domain exists. | No Go route/composition. |
| POST /api/workspace/echo/requirements/:publicId/transition | Go requirements transition service/domain exists. | No Go route/composition; domain replay/PG evidence exists. |
| POST /api/workspace/echo/solicitations | Uncommitted Go echo/solicitations service/repository draft. | No Go route/composition; tests are uncommitted and not application-wired. |
| GET /api/workspace/echo/solicitations | Uncommitted Go echo/solicitations service/repository draft. | No Go route/composition. |
| GET /api/workspace/echo/solicitations/:publicId | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| POST /api/workspace/echo/solicitations/:publicId/publish | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| POST /api/workspace/echo/solicitations/:publicId/close | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| POST /api/workspace/echo/solicitations/:publicId/withdraw | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| POST /api/workspace/echo/solicitations/:publicId/vote | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| GET /api/workspace/echo/solicitations/:publicId/votes | Uncommitted Go solicitation domain draft. | No Go route/composition. |
| GET /api/workspace/echo/solicitations/:publicId/deliveries | Uncommitted Go delivery/repository drafts. | No Go route/composition. |
| POST /api/workspace/echo/solicitations/:publicId/deliveries/retry | Uncommitted Go delivery/repository drafts. | No Go route/composition. |

Node has no direct release HTTP route in workspace-echo; release behavior is
entered through interaction commands and projected/delivered through cards and
messages. Therefore a missing Go release route is not, by itself, a missing
Node endpoint; the missing Go Echo interaction and delivery compositions are.

### Workspace WebSocket

| Node method and path | Go implementation and composition | Evidence and gap |
| --- | --- | --- |
| GET /ws/workspace | httpapi/router.go gates the realtime handler; cmd/workspace constructs the realtime handler and starts the PG event listener. | Go candidate provides durable replay, heartbeat, and event delivery tests. It does not provide Node's user presence map, so presence-aware email behavior is incomplete even though the WebSocket transport exists. |

## Layer 3: jobs, leases, timers, and presence

| Node job or side effect | Node schedule/contract | Go observation | Closure |
| --- | --- | --- | --- |
| Workspace immediate email | Startup delay 60 seconds, interval 30 seconds, 2-minute lease, retry delays 1/5/30 minutes; digest state is delayed 2 hours. Presence defers immediate delivery while the user is online. | email.Service has ProcessJobs, ProcessJobsWithPresence, StartWorker, and StartWorkerWithPresence. cmd/worker calls ProcessJobs with no presence. | Compose a presence provider and call the presence-aware variant. |
| Workspace ntfy | Startup delay 60 seconds, interval 5 seconds, 2-minute lease, retry delays 1/5/30 minutes, 10-second provider timeout. | ntfy.Service and cmd/worker processor are composed. | Candidate job exists; Node remains production owner and no independent production Go worker deployment is selected. |
| Echo delivery | Startup delay 60 seconds, interval 15 seconds, event-triggered recovery, idempotent card/message writes, durable delivery rows for requirements/solicitations/releases. | Uncommitted echo/delivery.Service has ProcessJobs and PG repository drafts. | Add worker processor, runtime card/message writers, event subscription, retry/lease tests, and command composition. |
| Upload chunk staging cleanup | Startup cleanup plus every 30 minutes; 4 MiB parts, at most 10,000 parts; per-part lock/hash validation. | files.Service has ReleaseStaleUploadReservations and cleanup methods; bootstrap can call stale reservation cleanup. No cmd/worker processor invokes it. | Add a bounded scheduler and prove stale DB/staging cleanup without racing active upload/bind. |
| Go request-attempt staging | 777fc84 commits workspace/uploads/{uploadID}/attempts/{uuid}; parent reports three real PG regressions first failed then passed and normal request cleanup bounded to 2 minutes. Crash residues remain possible after process failure. | The committed attempt isolation closes concurrent staging overwrite/failed-delete cases; no worker maintenance processor is composed for crash residues. | Add maintenance that derives the unique upload prefix, applies an age threshold, and never removes an active upload or an attempt that is still being written. |
| S3 multipart cleanup | Storage assertReady cleanup at startup and every 6 hours. | No Go cmd/worker storage-provider maintenance composition found. | Assign provider cleanup ownership and verify it in the candidate deployment. |
| Storage object cleanup | Node storage registry holds the object lock across acquire/bind/reference check/physical delete. | Go files/Avatar drafts contain object cleanup and current lock tests; parent is separately correcting files cleanup. | Keep all physical delete under the same object lock and committed reference check. Do not count a delayed post-unlock delete as equivalent. |
| Workspace WebSocket heartbeat/replay | Heartbeat every 30 seconds; hello/subscription/replay and live event catch-up; presence registration/unregistration follows socket lifecycle. | realtime handler has heartbeat/replay; no user presence registry or IsOnline source is composed. | Add presence lifecycle and race tests before using presence-aware email. |
| Bot Gateway WebSocket | Heartbeat every 30 seconds; hello/replay/ack, connection registration, token revocation, cleanup on close. | Uncommitted websocket.go plus unit tests; no route or command registration. | Compose and add full app integration. |
| P2P room cleanup | In-memory room TTL is 2 hours; empty-room grace is 10 seconds; peer limit is 2. | Go P2P manager/transport contains corresponding lifecycle behavior and transport/security tests. | Node remains production owner; no Go process/gateway cutover is claimed. |

The Go worker's current schema recheck is a useful safety gate but does not
substitute for missing processors. The worker/main_test.go tests cover the
generic loop and schema refusal, not a production processor registry containing
Echo, presence, and cleanup.

## Layer 4: migration and storage maintenance

| Node operation | Node source and behavior | Go source and behavior | Audit result |
| --- | --- | --- | --- |
| db:migrate | apps/web/package.json invokes server/migrate.mjs; Compose runs a dedicated successful migrate service before api. Node opens the DB with migrations enabled. | cmd/migrate runs the Go canonical numbered migration Runner and seed; workspace/worker only check schema read-only. | Two candidate migration paths exist. Production migration owner remains Node; no Go migration transition is claimed. Do not alter SQL history in this audit. |
| storage:provision | server/storage-provision.mjs verifies S3 bucket readiness/versioning/CORS and cleans multipart uploads. | No Go storage provisioning command found. | Missing Go maintenance candidate. |
| storage:migrate | server/storage-migrate.mjs supports backfill/verify, run IDs, inventory, hashing, verification, and reports. | No Go storage migration command found. | Missing Go maintenance candidate. |
| storage:dedupe | server/storage-dedupe.mjs supports backfill/verify/finalize, registry reconciliation, reports, and legacy cleanup under object locks. | No Go storage dedupe command found. | Missing Go maintenance candidate. |
| Legacy object read | Node opens/re-hashes legacy objects when digest is absent, then binds the canonical object; missing-only fallback is used. | Parent has added platform/storage LegacyReader implementations. Avatar domain now uses its LegacyReader interface; no additional platform change is needed in this audit. | Verify each Go domain's size bound, authorization, and missing-only fallback in its own tests. |
| Upload staging cleanup | Node startup and timer cleanup inactive transfer rows/staging. | 777fc84 provides request-attempt staging and normal 2-minute bounded defer cleanup; no worker composition handles crash leftovers. | Add a bounded crash-residue sweeper keyed by unique prefix and age, with an active-upload exclusion. |
| Object/multipart cleanup | Node storage registry and object store perform cleanup. | Go platform/file drafts contain cleanup methods; command ownership and provider maintenance are not composed. | P0/P1 maintenance gap. |

Node Compose also has storage-migration and storage-dedupe profiles. Those
profiles are not included in the normal Go or production deployment path.

Schema history was not changed by the 91847ca, e8bd0de, or parent-reported
request-staging facts.

## Layer 5: registries, adapters, SMTP, SQL, and startup wiring

### Composition differences

| Capability | Node composition | Go composition observed |
| --- | --- | --- |
| Bot Gateway | createApp constructs bot gateway, supplies bot/auth/message/card/file services, registers REST and WebSocket routes. | httpapi has interfaces and REST route registration, but cmd/workspace does not construct or inject the service, setup service, runtime adapters, or WebSocket handler. |
| Echo | createEchoRuntime supplies requirements, solicitations, releases, cards, command/workflow registries, and delivery. | Requirements are available as a domain candidate; other Echo packages are uncommitted drafts and none are wired in cmd/workspace or httpapi. |
| Cards | Echo runtime registers requirement, solicitation, release, and topic card definitions. | cards.NewRegistry() is called without definitions in cmd/workspace. |
| Commands/workflows | Node interaction registry contains the Echo commands/workflows listed above. | NewCommandRegistry and NewWorkflowRegistry are called without definitions in cmd/workspace. |
| Avatar | Node uses profile upload/storage and Go HEAD 0b9c6c1 composes one media processor, blob store, LegacyReader, PG repository, service, routes, and integration test. | This vertical is the strongest current Go composition evidence; it is still not production-selected. |
| Files | Node object store, chunk uploads, legacy reader, and registry are composed together. Node has no Bot content-upload channel. | Go file service/blob store are composed for common routes. 91847ca commits Agent Bot quota/reservation code, but it is not injected into Bot Gateway runtime composition. 777fc84 commits request-attempt staging with bounded normal cleanup; crash-residue maintenance remains pending. |
| Realtime/presence | Node workspace WebSocket registers presence and feeds email worker. | Go realtime handler is composed, but the presence dependency is absent. |

### SMTP selection

Node workspace-email.mjs imports nodemailer and selects an injected sendMail
function when supplied, otherwise sendWithNodemailer. Its SMTP contract
supports TLS/STARTTLS/none modes, timeout handling, encrypted settings, and
test injection.

Go email/service.go defaults a nil Mailer to SMTPMailer. publisher.go uses the
standard library net/smtp and its own TLS/STARTTLS classification. cmd/workspace
does not inject a different Mailer. Email tests use MailerFunc fakes, not a
real external SMTP server.

docs/backend/TECHNOLOGY.md explicitly records go-mail as selected but not
pinned or integrated. Therefore the Go SMTP implementation is a working
candidate, but the selected stack is not integrated/verified as documented.

### sqlc selection

docs/backend/TECHNOLOGY.md selects sqlc with pgx/v5 for new static SQL but says
sqlc is not pinned or integrated. The current apps/backend/go.mod has no sqlc
tool/dependency or generated sqlc package; repositories are explicit pgx SQL.
This is a technology integration decision, not a reason to alter current
repositories during this audit.

### Authorization and privacy checkpoints

- Node and Go must keep the exact Workspace enabled gate; a false or differently
  parsed value cannot expose these routes.
- P2P remains a separate private lane: no plaintext content persistence or
  secret logging is counted as acceptable.
- Bot REST requires the Bearer envelope. Query-string token and cookie
  fallback are not accepted by the Go transport tests.
- Workspace attachment/avatar/emote delivery must retain domain authorization,
  quota, audit, idempotency, legacy-read bounds, and object reference safety.
- Bot attachment reservation alone is not a completed upload capability.
- A route declaration with a nil service is an unavailable implementation, not
  a passing endpoint.

## Layer 6: verification matrix and exact follow-up evidence

| Capability | Existing Go evidence | Missing verification |
| --- | --- | --- |
| P2P HTTP/WebSocket | internal/p2p/transport_test.go, transport_security_test.go, internal/p2pcontract/contract_test.go | Candidate deployment/gateway smoke and owner decision. |
| Auth/core Workspace | internal/workspace/auth/auth_test.go and httpapi core/bootstrap/route tests; domain PG tests | One composed application matrix for every route group; Node remains the current production owner. |
| Avatar | internal/workspace/httpapi/avatar_routes_test.go, cmd/workspace/main_integration_test.go, apps/web/server/avatar-http-contract.test.js | No missing implementation gate found in this snapshot; production Go deployment remains unselected. |
| Files/common uploads | internal/workspace/httpapi/file_routes_test.go, files service/PG tests, files/storage_lock_pg_integration_test.go, and the committed upload-attempt PG integration tests | 777fc84 regression coverage passed after three initial real-PG failures; normal cleanup is bounded to 2 minutes. Remaining gap is crash-age maintenance with active-upload exclusion, plus scheduled worker composition. A Bot bytes-to-complete test is not required by the current Node contract because Node has no Bot content-upload channel. |
| Bot REST | httpapi/bot_gateway_routes_test.go, committed 91847ca reservation/PG tests, and uncommitted botgateway runtime/PG/transaction tests | Real newApplication test proving non-nil Gateway/Setup, Bearer auth, message/card transaction rollback, and quota-bounded reservation contract. Do not add a Bot content route solely to fill the Node limitation. |
| Bot WebSocket | uncommitted botgateway/websocket_test.go | Router registration, cmd composition, token revocation/replay/heartbeat application test. |
| Cards | httpapi/card_routes_test.go and card service tests | Production non-empty registry assertion and Echo card integration. |
| Interactions | httpapi/interaction_routes_test.go and interaction service tests | Production non-empty command/workflow registry assertion and HTTP behavior for every Node command/workflow. |
| Echo requirements | tracked requirements service/PG/Node compatibility/replay tests | HTTP adapters, cmd composition, and worker/delivery integration. |
| Echo solicitations/releases/delivery | uncommitted domain/PG/Node compatibility/replay tests and delivery service draft | Commit-independent route tests, production composition, worker lease/retry/event tests. |
| Email/ntfy | route/service/PG tests; worker/main_test.go generic scheduler tests | Go presence lifecycle and real composition of presence-aware email processing; production worker deployment. |
| Maintenance/migration | migration checker/runner tests and Node maintenance scripts | Go storage maintenance command or explicit continued Node owner, with operational evidence. |
| SMTP/sqlc | Mailer fakes and explicit pgx repositories | Decision record for selected/pinned/integrated/verified stack; no external SMTP or generated-query evidence. |
| Deploy/gateway | Go candidate Dockerfiles and Node deploy/CI checks | Go Compose/candidate health, rollback, object gateway, worker, and P2P routing checks. |

## Suggested next-round allocation

These are reviewable work boundaries, not implementation performed by this
audit worker:

1. Bot transport/runtime: compose botgateway.Service, setup, RuntimeAdapters,
   REST, WebSocket, and a reservation contract test. Preserve the shared Node
   product limitation that no Bot content-upload channel exists; do not invent
   a bytes-to-complete route in the Go refactor.
2. Echo HTTP: add route adapters for requirements and solicitations, wire
   definitions and card registry, then add route/PG/replay tests.
3. Echo delivery: compose delivery processor, message/card writers, event
   recovery, bounded leases, retries, and worker health evidence.
4. Presence and notifications: bind realtime socket lifecycle to presence and
   use ProcessJobsWithPresence; test online deferral and reconnect.
5. Cleanup and storage maintenance: schedule stale uploads/object cleanup and
   assign storage provision/migrate/dedupe ownership without changing schema
   history.
6. Bot owner compatibility: cover connection and connection-test endpoints or
   document a deliberate non-goal.
7. Candidate deployment: separately review Go image/Compose/gateway/rollback
   selection; do not infer a cutover from this document.
8. Technology selections: resolve sqlc and go-mail status after the runtime
   capability owner is agreed.

## Audit limitations

- This document is a static snapshot. Concurrent uncommitted files may change
  after the audit and are intentionally not normalized, staged, committed, or
  reverted.
- Parent review added the explicit Feishu conversion gap; the initial static
  audit did not enumerate that dependency. The table is a work inventory, not
  proof that every implementation or compatibility edge has been discovered.
- The current worktree has uncommitted Bot Gateway, Echo, files, and unrelated
  P2P changes. Their presence is recorded as draft evidence, not as a merged
  capability.
- The parent reported that httpapi/workspace PG/race/staticcheck checks passed
  around the Avatar/Bot work. This worker did not rerun them.
- No tests, builds, race runs, static analysis, database connection, container,
  migration, deployment, or production mutation was run for this read-only
  audit. Validation for this worker is NOT RUN by design.
- Node remains the production owner; no Go cutover is claimed. A future cutover
  date and exact post-cutover gateway topology are not defined by this audit,
  and current uncommitted drafts remain subject to parent review.
