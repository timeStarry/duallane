# Workspace MVP Development Contract

## 1. Purpose

This document is the implementation contract for the first full shared-space development loop.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

This loop should implement the real Workspace foundation, not another placeholder. Compatibility with the current prototype schema is not required because the feature is still under design and not publicly launched.

## 2. Required Scope For This Loop

The loop must cover:

- GitHub login.
- Invite-only access.
- Seeded first owner.
- Conversation list.
- Direct chat creation through member picker and direct-conversation reuse.
- Group creation with member selection and group details/member management.
- Structured message creation and reading.
- Basic file upload and download, including standalone attachments.
- Upload/download quota enforcement.
- Operation-record persistence.
- Realtime event model, WebSocket delivery foundation, reconnect/replay, and
  permission-filtered projection.

Explicitly out of this loop:

- AI bot execution.
- Full-text search.
- Message edit/delete UI.
- Reaction UI.
- Multi-space switching UI.
- File preview/text extraction.
- Encrypted shared-space mode.
- Public registration.

The protocol and database should leave room for those later capabilities, but they should not block this loop.

Productization requirement:

- The Workspace UI must not remain a single flat surface where login state,
  conversation list, group creation, invite creation, members, files, quota, and
  chat are all exposed at the same level.
- P0 must introduce a clear shared-space information hierarchy: conversation
  list/navigation, active conversation, contextual conversation details,
  member directory or picker, file library/drawer, and privileged settings.
- Public Workspace login shows only GitHub login. Invite creation and invite
  management live inside Workspace and only for permitted members.

Detailed product contracts:

- [Workspace Design Index](WORKSPACE_DESIGN_INDEX.md)
- [Workspace Core User Flow Design](WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace IM Product Design](WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
- [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md)
- [Workspace Conversation And Group Design](WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
- [Workspace Member And Permission Design](WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
- [Workspace File And Quota Design](WORKSPACE_FILE_QUOTA_DESIGN.md)
- [Workspace Space Settings Design](WORKSPACE_SPACE_SETTINGS_DESIGN.md)
- [Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
- [Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
- [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace Realtime Event Design](WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)

## 3. Initial Owner

The first owner is written directly into the database bootstrap:

| Field | Value |
| --- | --- |
| GitHub login | `timeStarry` |
| Email | `timestarry@qq.com` |
| Role | `owner` |
| User kind | `human` |

GitHub OAuth binding rules:

- Prefer GitHub numeric ID as the stable identity once available.
- The seeded owner may initially be identified by `github_login` and `email`.
- On first successful GitHub login, if the returned account matches `timeStarry` or `timestarry@qq.com`, bind the GitHub numeric ID to the seeded owner row.
- After `github_id` is bound, login or email matching must never replace it; a
  different numeric ID is rejected and audited as `auth.identity_conflict`.
- If a non-seeded user logs in without an accepted invite, reject access.
- If an invited user logs in, bind their GitHub identity and create membership using the invite default role.

## 4. Space Model

MVP creates one default space during bootstrap.

Suggested default:

| Field | Value |
| --- | --- |
| `id` | `spc_default` |
| `name` | `默认空间` |
| `slug` | `default` |
| `created_by` | seeded owner |

Even though the UI only needs one current space in this loop, the schema should include `space_id` on Workspace domain tables to avoid repainting the model later.

Tables that should include `space_id`:

- `space_members`
- `invites`
- `conversations`
- `conversation_members`
- `attachments`
- `transfer_ledger`
- `audit_logs`
- `workspace_events`

## 5. Permission Model

Roles:

| Role | External label | Summary |
| --- | --- | --- |
| `owner` | 空间主人 | Full control over the default space and settings. |
| `admin` | 管理员 | Manage members, invites, groups, and normal space operations. |
| `member` | 成员 | Use joined conversations and files within quota. |
| `auditor` | 预留角色 | Engineering-reserved role for possible future operation review; no operation-record UI/API in this loop. |

Capability matrix:

| Capability | owner | admin | member | auditor |
| --- | --- | --- | --- | --- |
| Login after invite or bootstrap | yes | yes | yes | yes |
| View own bootstrap state | yes | yes | yes | yes |
| View space members | yes | yes | yes | yes |
| Create member invite | yes | yes | no | no |
| Create admin invite | yes | no | no | no |
| Create owner invite | yes | no | no | no |
| Revoke invite | yes | yes | no | no |
| Create direct conversation | yes | yes | yes | no |
| Create group conversation | yes | yes | no | no |
| Add group member | yes | yes | no | no |
| Remove group member | yes | yes | no | no |
| View joined conversation | yes | yes | yes | only if joined and read-enabled later |
| Send message in joined conversation | yes | yes | yes | no |
| Upload file | yes | yes | yes | no |
| Download visible file | yes | yes | yes | no |
| Change member role | yes | no | no | no |
| Change retention policy | yes | no | no | no |
| View operation records through UI/API | no in this loop | no in this loop | no | no |

Permission rules:

- Backend permission checks are authoritative.
- Frontend checks are only for UX simplification.
- Rejected sensitive operations must write an operation record.
- Normal members must not see operation records, platform logs, request IDs, IP addresses, user agents, transfer ledgers, OAuth details, or other platform internals.

## 6. Authentication And Invites

Product-level entry states, copy, seeded-owner flow, invite creation placement,
and invite acceptance behavior are defined in
[Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md).

Required endpoints:

- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`
- `POST /api/auth/logout`
- `GET /api/workspace/bootstrap`
- `POST /api/workspace/invites`
- `POST /api/workspace/invites/:code/accept`

Invite rules:

- Invites are space-scoped.
- Invite codes should be stored hashed in the database.
- Invites have `default_role`, `max_uses`, `uses`, optional `expires_at`, `created_by`, `created_at`, and optional `revoked_at`.
- `member` is the normal default role.
- Only `owner` can create privileged invites for `admin`, `owner`, or `auditor`.
- `admin` can create `member` invites.
- Invite acceptance writes an operation record.

Unauthenticated and uninvited users:

- Can complete OAuth only enough to identify the account.
- Must not enter the shared space unless they match the seeded owner or an accepted invite.
- Should see a clear not-invited state, not platform internals.

## 7. Conversations

Required endpoints:

- `GET /api/workspace/conversations`
- `POST /api/workspace/conversations`
- `GET /api/workspace/conversations/:conversationId/messages`

Recommended productized additions:

- `GET /api/workspace/members`
- `POST /api/workspace/groups/:conversationId/members`
- `DELETE /api/workspace/groups/:conversationId/members/:userId`
- `PATCH /api/workspace/groups/:conversationId`

Conversation types:

| Type | Rule |
| --- | --- |
| `direct` | One conversation per pair per space; reuse existing direct conversation. |
| `group` | Created by `owner` or `admin`; members are explicit. |

History visibility decisions:

- A current conversation member can read the retained message history for that conversation.
- New group members can see prior retained history by default. This matches the "shared place" product model.
- Removed or left members immediately lose access to the conversation and its files.
- If a removed member is added again later, they regain access to retained history from the current membership onward by policy; no special historical blackout is required in this loop.

Product requirements:

- Conversation list rows distinguish `direct` and `group`.
- Direct conversation creation uses a member picker and reuses the existing pair conversation.
- Group creation uses a focused flow with group name and selected members.
- Group member list and file list live in a conversation details surface.
- Owner/admin group-management controls are contextual, not permanently shown in the main chat surface.

Retention:

- Default retention is the latest `10000` messages per conversation.
- Message retention soft-deletes or removes messages according to implementation needs.
- Operation records are not affected by message retention.

## 8. Structured Messages

The MVP must implement structured message creation and reading. Do not keep the plain `messages.body TEXT` protocol.

Required message blocks:

```ts
type MessageBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string }
  | { type: "attachment"; attachmentId: string };
```

Required message fields:

- `id`
- `spaceId`
- `conversationId`
- `authorId`
- `authorKind`
- `kind`
- `clientMessageId`
- `contentFormat`
- `contentJson`
- `plainText`
- `replyToMessageId`
- `createdAt`
- `editedAt`
- `deletedAt`

Required command:

- `POST /api/workspace/messages`

Rules:

- The server derives author identity from the session.
- The server validates conversation membership before message creation.
- The server validates every block.
- `plainText` must be server-generated or server-verified.
- `clientMessageId` is required for human-created messages and is unique per `(space_id, conversation_id, author_id)`.
- Duplicate submission with the same `clientMessageId` returns the original message when content matches.
- Duplicate submission with different content is rejected as an idempotency conflict.
- Replies use `replyToMessageId`, not a special block.
- Message edits, deletes, and reactions are protocol-reserved but not required as UI features in this loop.

## 9. Files And Attachments

Required endpoints:

- `POST /api/workspace/files/uploads/reserve`
- `PUT /api/workspace/files/uploads/:uploadId/content`
- `POST /api/workspace/files/uploads/:uploadId/complete`
- `POST /api/workspace/files/uploads/:uploadId/fail`
- `GET /api/workspace/files`
- `POST /api/workspace/files/:attachmentId/downloads/reserve`
- `GET /api/workspace/files/:attachmentId/download`

Attachment model:

- Attachments belong to a space.
- Attachments may exist without a message.
- Attachments may later be referenced by a message through `message_attachments`.
- Attachments have an uploader and visibility policy.

Attachment visibility:

| Visibility | Meaning |
| --- | --- |
| `private_staging` | Visible to uploader and owner/admin; used before a message or file-library publish step. |
| `conversation` | Visible to current members of the linked conversation. |
| `space` | Visible to current members of the space. |

Attachment statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Upload has been reserved but not completed. |
| `available` | File can be listed or downloaded according to visibility. |
| `failed` | Upload failed and reserved quota was released. |
| `removed` | File is no longer available. |

Lifecycle decisions:

- Attachments are independent from messages.
- Message retention does not hard-delete attachment records.
- A message can reference one or more attachments.
- A standalone space file can exist without a message reference.
- Orphan cleanup can be added later; it must not be required for this loop.

## 10. Quota And Transfer Ledger

MVP quota:

- `2 GiB / user / day`
- Upload and download share the same daily limit.
- Backend enforcement is mandatory.

Transfer ledger statuses:

| Status | Counts toward used quota | Meaning |
| --- | --- | --- |
| `reserved` | yes | Capacity reserved before transfer begins. |
| `completed` | yes | Transfer completed or download token/stream was issued. |
| `released` | no | Reservation released after upload failure/cancellation. |
| `failed` | no | Transfer failed before completion and quota was released. |
| `rejected` | no | Quota check failed before transfer. |

Upload rules:

- Reserve by declared file size before receiving file content.
- The MVP HTTP implementation uploads bytes through `PUT /api/workspace/files/uploads/:uploadId/content`; the server writes the stream under the Workspace storage root and validates the actual byte count against the reservation.
- `complete` may only mark an upload available after stored file content has been verified. A metadata-only complete request must fail if the file bytes are missing.
- If remaining quota is insufficient, reject before transfer and write an operation record.
- If upload fails or is cancelled before completion, release the reservation.
- On successful upload, mark transfer completed and attachment available.

Download rules:

- Before issuing a download token or starting a stream, calculate remaining quota.
- If stored file size exceeds remaining quota, reject before transfer and write an operation record.
- If allowed, reserve and complete the transfer before or when the token/stream is issued.
- Rejected downloads do not consume quota.

## 11. Realtime Events

Realtime delivery uses an extensible event log plus WebSocket delivery.

Required endpoint:

- `GET /ws/workspace`

Event table:

- `id`
- `space_id`
- `seq`
- `type`
- `actor_user_id`
- `conversation_id`
- `target_type`
- `target_id`
- `payload_json`
- `created_at`

Event envelope:

```json
{
  "version": 1,
  "id": "evt_01",
  "spaceId": "spc_default",
  "seq": 42,
  "type": "message.created",
  "actorId": "usr_01",
  "conversationId": "conv_01",
  "createdAt": "2026-06-25T09:00:00.000Z",
  "payload": {
    "messageId": "msg_01"
  }
}
```

MVP event types:

| Event | Required this loop | Notes |
| --- | --- | --- |
| `workspace.member_joined` | yes | Invite acceptance or owner bootstrap. |
| `conversation.created` | yes | Direct or group conversation created. |
| `conversation.member_added` | yes | Group membership change. |
| `conversation.member_removed` | yes | Group membership change. |
| `message.created` | yes | Structured message persisted. |
| `attachment.created` | yes | Upload reserved or attachment row created. |
| `attachment.available` | yes | Upload completed. |
| `attachment.failed` | yes | Upload failed and quota released. |
| `transfer.rejected` | yes | Upload/download rejected by quota or permission. |
| `message.updated` | reserved | Later. |
| `message.deleted` | reserved | Later. |
| `reaction.added` | reserved | Later. |
| `reaction.removed` | reserved | Later. |
| `bot.mentioned` | reserved | Later. |
| `bot.response.created` | reserved | Later. |

Delivery rules:

- Events are committed in the same transaction as the state change when possible.
- `seq` is monotonic per space.
- Clients can reconnect with the last seen `seq`.
- If a reconnect cursor is too old or unavailable, the client must refetch bootstrap/conversations/messages.
- Subscribers only receive events they are allowed to see.
- Normal members must not receive operation-record payloads or platform internals through events.

## 12. Operation Records

Operation records are database-only in this loop. There is no normal member UI and no public member API for operation records.

Required operation-record writes:

- Login success.
- Login rejected because user is not invited.
- Invite creation.
- Invite acceptance.
- Invite rejection/expiry/revocation.
- Role change.
- Conversation creation.
- Group member add/remove.
- Message creation rejection.
- Upload reserve/completed/failed/rejected.
- Download reserve/completed/rejected.
- Quota rejection.
- Permission rejection for sensitive operations.

Visibility:

- Normal members cannot view operation records.
- Owner/admin operation-record UI is deferred.
- Database rows may include IP address, user agent, request ID, actor, target, result, and reason.
- Fastify log redaction and payload redaction must remain intact.

## 13. Direct Database Replacement

No compatibility with the current prototype `messages.body TEXT` model is required.

Implementation should directly replace the Workspace schema with the target model. Do not spend effort on backfills or legacy reads for old Workspace messages.

The durable schema contract lives in
[Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md). That document is
authoritative for entity boundaries, state machines, indexes, retention, and
normal-member data disclosure.

Suggested core tables:

- `users`
- `spaces`
- `space_members`
- `invites`
- `sessions`
- `conversations`
- `conversation_members`
- `messages`
- `message_attachments`
- `attachments`
- `transfer_ledger`
- `workspace_events`
- `audit_logs`

Recommended user fields:

- `id`
- `github_id`
- `github_login`
- `email`
- `display_name`
- `avatar_url`
- `kind`
- `created_at`
- `last_login_at`

Recommended message fields are defined in section 8.

## 14. API Error Shape

The endpoint-level contract lives in
[Workspace API Contract](WORKSPACE_API_CONTRACT.md). This section captures the
shared error shape that all Workspace APIs should use.

Use one error shape for Workspace APIs:

```json
{
  "error": {
    "code": "quota.insufficient",
    "message": "今日传输额度不足"
  }
}
```

Rules:

- `message` is safe for users.
- `code` is stable for clients.
- Do not expose stack traces, SQL errors, OAuth internals, provider tokens, IP addresses, user agents, or request IDs in client API responses.
- Request IDs may stay in server logs and database operation records.
- Permission errors should not leak whether inaccessible resources exist unless the actor is allowed to know.

## 15. P1/P2 Decisions

The following defaults are accepted for this loop:

| Topic | Decision |
| --- | --- |
| Multi-space | Schema supports spaces; UI uses one default space. |
| New group member history | New members can see retained prior history. |
| Removed member access | Removed or left members lose access immediately. |
| Direct conversations | Reuse one direct conversation per pair per space. |
| Space total capacity | Deferred; this loop enforces per-user daily transfer quota only. |
| Operation record UI | Deferred; DB-only in this loop. |
| AI bots | Protocol-compatible but no bot execution in this loop. |
| Message edit/delete/reactions | Protocol/event reserved; not required as UI features. |
| File previews | Deferred. |
| Search | Deferred. |
| Attachment cleanup | Deferred; attachment independence is required. |
| Encrypted shared-space rooms | Deferred. |

## 16. Validation Requirements

For Workspace implementation changes, run:

```bash
pnpm test
pnpm lint
pnpm build
```

Minimum tests:

- Seeded owner can log in and bind GitHub identity.
- Uninvited GitHub user is rejected.
- Owner/admin/member permissions match the matrix.
- Member cannot create invites or group conversations.
- Conversation list only returns joined conversations.
- Structured message validation rejects malformed blocks.
- Duplicate `clientMessageId` is idempotent.
- Non-member message creation is rejected and logged.
- Upload quota is reserved before transfer.
- Failed upload releases quota.
- Download is rejected before transfer when quota is insufficient.
- Attachments can exist without messages.
- Operation records are written but not exposed to normal members.
- Realtime events use monotonic `seq` and respect visibility.

Minimum product checks:

- Public Workspace login has no invite form or invite creation UI.
- Regular member can use chat without seeing invite controls, operation records,
  request IDs, transfer ledger rows, OAuth details, or platform logs.
- Owner/admin can find invite creation from a logged-in member/settings surface.
- Conversation list, active chat, and conversation details are separate surfaces
  on desktop.
- Mobile does not squeeze conversation list, active chat, and details into one
  simultaneous page.
- Group configuration is available through group details/settings, not as a
  permanently visible flat panel.
- Member picker supports starting a direct chat and selecting group members.
- Screen/component acceptance follows
  [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md).
- Visual hierarchy, component density, icon usage, and anti-pattern checks
  follow [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md).
- Loading, empty, error, permission, quota, upload/download, and reconnect
  feedback follows [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md).
- Client data fetching, member source reuse, normalized view state, realtime
  event projection, and targeted refetch behavior follow
  [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md).
- HTTP/WebSocket endpoint behavior follows
  [Workspace API Contract](WORKSPACE_API_CONTRACT.md).
- Persistent schema, indexes, and data boundaries follow
  [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md).
- Authentication and invite behavior follows
  [Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md).
- Space information and privileged settings follow
  [Workspace Space Settings Design](WORKSPACE_SPACE_SETTINGS_DESIGN.md).
- Search/filter behavior remains scoped and permission-safe as defined in
  [Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md).
- Local notices, unread-ready state, and mention/notification reservations
  follow [Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md).
- Mobile pane behavior, keyboard focus, and accessibility checks follow
  [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md).
- P0/P1/P2 sequencing and productization gates follow
  [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md).
- Persona, screen, backend, realtime, quota, disclosure, and manual acceptance
  follow [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md).
