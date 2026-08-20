# Workspace API Contract

## 1. Purpose

This document defines the productized HTTP and WebSocket API contract for
DualLane shared spaces.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is to make the API support a full IM-like product without forcing the
UI to expose internal platform concepts. Normal members should see chats,
files, members, quota, and clear action results. The API can still enforce
permissions, quotas, retention, idempotency, realtime delivery, and operation
records behind that surface.

This document complements:

- [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
- [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Message Protocol](WORKSPACE_MESSAGE_PROTOCOL.md)
- [Workspace Realtime Event Design](WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)

## 2. API Principles

- Workspace APIs are disabled unless `WORKSPACE_ENABLED=true`.
- Session identity is server-derived. Clients never submit `actorId` for
  privileged decisions.
- Backend authorization is authoritative; client capability flags are only UI
  hints.
- Public Workspace entry supports GitHub login only. Invite creation and invite
  management require an authenticated member with permission.
- Normal member responses must not include operation records, transfer ledger
  rows, request IDs, IP addresses, user agents, OAuth provider payloads, storage
  keys, filesystem paths, or event sequence internals as visible product data.
- Every mutation that affects security, membership, file access, quota, or
  conversation access writes an operation record on success or rejection.
- API responses should provide display-ready product fields where that prevents
  unsafe or inconsistent client inference.
- Error responses use stable codes and user-safe copy.

## 3. Common API Shape

Base path:

```text
/api/workspace
```

Authentication:

- Browser session cookie created after GitHub OAuth.
- Workspace routes require an active session except GitHub OAuth start/callback
  and invite-link landing handling.
- If the session exists but no active space membership exists, the API returns a
  not-invited state and no Workspace data.

Workspace success responses use route-specific resource envelopes. There is no
mandatory top-level `data` or `meta` wrapper in the P0 implementation. This keeps
the frontend contract lightweight while still making each response explicit:

```json
{
  "conversation": {},
  "conversations": [],
  "message": {},
  "files": []
}
```

Common error envelope:

```json
{
  "error": {
    "code": "quota.insufficient",
    "message": "今日传输额度不足"
  }
}
```

Rules:

- `message` is safe to show directly to users.
- `code` is stable for branching.
- Debug details may be logged server-side with redaction, but must not be sent
  to normal clients.
- `requestId` can be kept in server logs and operation records. It is not shown
  to normal members in P0.

Recommended status mapping:

| Situation | HTTP status | Error code |
| --- | --- | --- |
| Workspace disabled | `404` or `503` | `workspace.disabled` |
| No session | `401` | `auth.required` |
| OAuth account not invited | `401` or `403` | `auth.not_invited` |
| OAuth identity conflicts with a bound provider ID | `401` | `auth.identity_conflict` |
| Permission denied | `403` | `permission.denied` |
| Resource hidden or missing | `404` | Domain-specific safe code, such as `conversation.not_found` or `file.not_found` |
| Validation failed | `400` | Domain-specific safe code, such as `file.invalid_size` |
| Idempotency conflict | `409` | `message.idempotency_conflict` |
| Quota insufficient | `409` | `quota.insufficient` |
| Upload state conflict | `400` or `409` | Domain-specific safe code, such as `upload.size_mismatch` |
| Rate or size limit | `413` or `429` | `limit.exceeded` |

## 4. Bootstrap Contract

Endpoint:

```text
GET /api/workspace/bootstrap
```

Purpose:

- Return the minimum state needed to render the ready shared-space shell.
- Avoid separate first-load calls for members, conversations, quota, and core
  capabilities in small MVP deployments.

Ready response:

```json
{
  "auth": {
    "mode": "development",
    "inviteOnly": true,
    "currentUser": {
      "id": "usr_01",
      "displayName": "timeStarry",
      "githubLogin": "timeStarry",
      "avatarUrl": "https://...",
      "role": "owner",
      "roleLabel": "空间主人",
      "kind": "human"
    }
  },
  "space": {
    "id": "spc_default",
    "name": "默认空间",
    "slug": "default",
    "createdBy": "usr_owner",
    "createdAt": "2026-06-26T08:00:00.000Z"
  },
  "policy": {
    "dailyQuotaBytes": 2147483648,
    "usedTodayBytes": 1048576,
    "remainingQuotaBytes": 2146435072,
    "messageRetentionCount": 10000
  },
  "permissions": {
    "canCreateMemberInvite": true,
    "canCreatePrivilegedInvite": true,
    "canReadConversations": true,
    "canCreateGroup": true,
    "canCreateDirect": true,
    "canUpload": true,
    "canDownload": true,
    "canViewOperationRecords": false
  },
  "members": [],
  "conversations": [],
  "files": [],
  "invites": []
}
```

Entry-state responses:

| State | Meaning | Required client behavior |
| --- | --- | --- |
| `disabled` | Feature flag is off | Show disabled shared-space state. |
| `needs_login` | No valid session | Show GitHub login only. |
| `not_invited` | OAuth identity is known but not accepted | Show safe access copy. |
| `ready` | Active member | Render Workspace shell. |

Bootstrap must not include:

- Operation records.
- Transfer ledger rows.
- OAuth provider raw payloads.
- IP address, user agent, request ID.
- Storage keys or local filesystem paths.
- Events that the viewer cannot see.

## 5. Authentication And Invite APIs

GitHub login:

```text
GET /api/auth/github/start
GET /api/auth/github/callback
POST /api/auth/logout
```

Rules:

- `start` may accept an invite code through a safe query or OAuth state value.
- In production, `callback` must reject missing or mismatched OAuth state before
  exchanging the GitHub authorization code.
- The public login page still shows only `使用 GitHub 登录`.
- OAuth callback binds the seeded owner when GitHub login/email matches
  `timeStarry` / `timestarry@qq.com`.
- OAuth callback accepts an invited account only after invite validation.
- Rejected login writes an operation record.

Create invite:

```text
POST /api/workspace/invites
```

Request:

```json
{
  "defaultRole": "member",
  "maxUses": 1,
  "expiresInHours": 168
}
```

Response:

```json
{
  "invite": {
    "id": "inv_01",
    "code": "LANE-6F8K",
    "defaultRole": "member",
    "maxUses": 1,
    "uses": 0,
    "expiresAt": "2026-07-03T08:00:00.000Z",
    "inviteUrl": "https://example.com/?lane=workspace&invite=LANE-6F8K"
  }
}
```

Rules:

- `admin` can create `member` invites.
- Only `owner` can create privileged invites.
- Invite codes are stored hashed.
- Invite creation is never available on the public login screen.
- The response may return the raw code only at creation time.

Revoke invite:

```text
POST /api/workspace/invites/:inviteId/revoke
```

Invite list:

- P0 returns visible invite rows in bootstrap for owner/admin settings.
- A separate `GET /api/workspace/invites` remains a P1 pagination/search
  endpoint when spaces need larger invite administration.

## 6. Member APIs

List members:

```text
GET /api/workspace/members?q=&role=&kind=&cursor=&limit=
```

P0 can serve members through bootstrap for small spaces, but this endpoint is
the stable product direction for member directory, direct-chat picker, group
creation, and group member management.

Member item:

```json
{
  "id": "usr_02",
  "displayName": "Lane Member",
  "githubLogin": "lane-member",
  "avatarUrl": "https://...",
  "role": "member",
  "roleLabel": "成员",
  "kind": "human",
  "status": "active",
  "capabilities": {
    "canStartDirectConversation": true
  }
}
```

Rules:

- Normal members can see visible active members.
- Role-management fields are not embedded as inline actions unless the viewer
  can manage roles and is in a settings surface.
- Member directory responses must not include provider tokens, raw OAuth
  payloads, database internals, or operation records.

Privileged member management:

```text
PATCH /api/workspace/members/:userId/role
DELETE /api/workspace/members/:userId
```

Role changes and member removal require owner permission and must block
self-removal plus last-owner removal.

## 7. Conversation APIs

List conversations:

```text
GET /api/workspace/conversations
```

Response item:

```json
{
  "id": "conv_01",
  "type": "group",
  "displayTitle": "Design Review",
  "memberCount": 4,
  "lastMessagePlainText": "明天看一下最终版本",
  "lastMessageAt": "2026-06-26T07:55:00.000Z",
  "lastActivityAt": "2026-06-26T07:55:00.000Z",
  "unreadCount": 0,
  "notificationLevel": "all",
  "retentionText": "保留最近 10000 条消息",
  "capabilities": {
    "canSendMessage": true,
    "canUploadFile": true,
    "canManageMembers": true
  }
}
```

Create or reuse direct conversation:

```text
POST /api/workspace/conversations
```

Request:

```json
{
  "type": "direct",
  "memberIds": ["usr_02"]
}
```

Rules:

- Exactly one target member.
- Existing direct conversation for the pair is returned if it already exists.
- Active space membership is required for both users.

Create group conversation:

```json
{
  "type": "group",
  "title": "Design Review",
  "memberIds": ["usr_02", "usr_03"]
}
```

Rules:

- Owner/admin only in P0.
- `title` is required and should be trimmed.
- Creator is included automatically.
- `memberIds` must contain at least one selected member other than the creator.
- Initial members must be active space members.
- Empty or creator-only `memberIds` returns `conversation.invalid_members`.
- Creation is transactional and emits conversation/member events.

Group member management:

```text
GET /api/workspace/conversations/:conversationId
POST /api/workspace/groups/:conversationId/members
DELETE /api/workspace/groups/:conversationId/members/:userId
PATCH /api/workspace/groups/:conversationId
POST /api/workspace/groups/:conversationId/leave
```

P0 supports details, member list, group rename, group leave, and group
member-management foundation. Archive/dissolve policy remains P2.

Mark read:

```text
POST /api/workspace/conversations/:conversationId/read
```

Rules:

- Active conversation membership is required.
- The server updates only the current member's read marker.
- Read-marker failures should not block normal message rendering.
- Normal read-marker writes do not need to create operation records.

Update conversation notification level:

```text
PATCH /api/workspace/conversations/:conversationId/notification
```

Request:

```json
{
  "level": "all"
}
```

Allowed levels:

- `all`: normal conversation reminders.
- `mentions`: emphasize mentions only.
- `muted`: quiet conversation; unread state can still exist.

Rules:

- Active conversation membership is required.
- The setting is personal to the current member and must not update or leak to
  other members.
- The response returns the current viewer's conversation projection.
- The realtime event is actor-local and should not be delivered to other
  conversation members.

Personal ntfy push settings:

```text
GET   /api/workspace/me/ntfy
PATCH /api/workspace/me/ntfy
POST  /api/workspace/me/ntfy/rotate
```

Rules:

- Only the current active human member can read or update the setting.
- Push is enabled by default. The generated topic remains stable until that
  member explicitly calls the rotate endpoint.
- Rotation invalidates the old topic and cancels pending deliveries; clients
  must subscribe to the newly returned topic.
- `all`, `mentions`, and `muted` conversation levels gate ntfy delivery in the
  same way as other personal conversation reminders.
- Push content may identify the projected sender and group title, but never
  includes message text, attachment names, file links, or download secrets.

## 8. Message APIs

Load messages:

```text
GET /api/workspace/conversations/:conversationId/messages?before=&limit=
```

Rules:

- Active conversation membership is required.
- Response is ordered for rendering and includes enough author/attachment data
  to avoid additional per-message fetches in P0.
- Retention-hidden messages are not returned.
- `kind: "system"` messages are conversation-visible facts and should render
  quietly; they are not operation records and must not contain platform
  internals.

Create message:

```text
POST /api/workspace/messages
```

Request:

```json
{
  "conversationId": "conv_01",
  "clientMessageId": "client-uuid-01",
  "content": {
    "format": "duallane.message+json;v=1",
    "blocks": [
      { "type": "text", "text": "看这个文件" },
      { "type": "attachment", "attachmentId": "att_01" }
    ]
  },
  "replyToMessageId": null
}
```

Rules:

- Server derives author from session.
- Conversation membership is required.
- `clientMessageId` is unique per `(space_id, conversation_id, author_id)`.
- Duplicate matching content returns the original message.
- Duplicate different content returns `message.idempotency_conflict`.
- Server validates all blocks and derives or verifies `plainText`.
- Attachment blocks require visibility and availability checks.

Message response:

```json
{
  "message": {
    "id": "msg_01",
    "conversationId": "conv_01",
    "authorId": "usr_01",
    "authorName": "timeStarry",
    "authorKind": "human",
    "kind": "user",
    "content": {
      "format": "duallane.message+json;v=1",
      "blocks": []
    },
    "plainText": "看这个文件",
    "attachments": [],
    "replyToMessageId": null,
    "createdAt": "2026-06-26T07:55:00.000Z"
  }
}
```

Reserved P1/P2:

```text
POST /api/workspace/messages/:messageId/reactions
PATCH /api/workspace/messages/:messageId
DELETE /api/workspace/messages/:messageId
```

## 9. File APIs

Reserve upload:

```text
POST /api/workspace/files/uploads/reserve
```

Request:

```json
{
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "byteSize": 123456,
  "visibility": "conversation",
  "conversationId": "conv_01"
}
```

Response:

```json
{
  "id": "upl_01",
  "status": "reserved",
  "usedToday": 123456,
  "remainingBytes": 2147350192,
  "dailyQuotaBytes": 2147483648,
  "upload": {
    "id": "upl_01",
    "mode": "chunked",
    "partSize": 4194304,
    "partCount": 3
  },
  "attachment": {
    "id": "att_01",
    "fileName": "report.pdf",
    "status": "pending",
    "visibility": "conversation"
  }
}
```

Upload content and completion:

```text
GET /api/workspace/files/uploads/:uploadId
PUT /api/workspace/files/uploads/:uploadId/parts/:partNumber
PUT /api/workspace/files/uploads/:uploadId/content
POST /api/workspace/files/uploads/:uploadId/complete
POST /api/workspace/files/uploads/:uploadId/fail
```

Rules:

- Reserve succeeds before bytes are accepted.
- Files larger than one advertised part use the chunked path. Every part has a
  fixed expected size and requires `X-DualLane-Part-SHA256`.
- Uploading the same part number with the same size and digest is idempotent;
  conflicting content returns `upload.part_conflict`.
- The status endpoint returns received part numbers and hashes so the browser
  can skip parts already accepted during the current upload task. Part activity
  refreshes the stale reservation deadline.
- Actual stored size must match the reservation.
- `complete` with `{ "mode": "chunked" }` fails if any part is missing, then
  assembles parts in order and verifies the final object before marking it
  available.
- `fail` releases reserved quota.
- Stale pending upload cleanup is a server responsibility. P0 performs
  opportunistic cleanup during quota reads/reservations so abandoned browser
  uploads do not hold daily transfer amount indefinitely.

## 9.1 Personal Emote APIs

```text
GET    /api/workspace/me/emote-settings
PUT    /api/workspace/me/emote-settings
GET    /api/workspace/me/emotes
GET    /api/workspace/me/emote-library
POST   /api/workspace/me/emotes
POST   /api/workspace/me/emotes/favorite
PUT    /api/workspace/me/emote-library/order
PUT    /api/workspace/me/emotes/order
DELETE /api/workspace/me/emotes/:emoteId
GET    /api/workspace/emotes/:emoteId/content
POST   /api/workspace/me/emote-collections
PATCH  /api/workspace/me/emote-collections/:collectionId
DELETE /api/workspace/me/emote-collections/:collectionId
POST   /api/workspace/me/emote-collections/:collectionId/items
DELETE /api/workspace/me/emote-collections/:collectionId/items/:emoteId
PUT    /api/workspace/me/emote-collections/:collectionId/order
PUT    /api/workspace/me/emote-collections/:collectionId/source-subscription
POST   /api/workspace/me/emote-collections/:collectionId/shares
DELETE /api/workspace/me/emote-collection-shares/:shareId
GET    /api/workspace/emote-collection-shares/:shareId
POST   /api/workspace/emote-collection-shares/:shareId/import
```

Rules:

- At least one built-in pack must remain enabled. The personal favorites pack
  remains available even when empty.
- Source uploads accept JPEG, PNG, WebP, GIF, and BMP up to 10 MiB. The API decodes,
  strips metadata, bounds dimensions/frames/duration, and stores normalized
  WebP content under the caller's private collection.
- There is no total item or collection-count limit. Each collection remains
  limited to 100 items. Locally owned or snapshot content has a 1 GiB logical
  byte limit per user; active subscription-only content is excluded.
- Personal-emote bytes do not consume the daily chat transfer quota. The
  response reports this separate allowance through `usage` and `limits`.
- Favoriting a message image requires active membership in that message's
  conversation. Stored copies remain independent from later message or
  attachment removal.
- Custom content is available to its owner and to members of conversations
  containing a message that references that custom emote. Object keys and S3
  credentials are never returned by these APIs.

Library responses include:

```json
{
  "usage": {
    "itemCount": 12,
    "totalBytes": 7340032,
    "subscribedItemCount": 40,
    "subscribedTotalBytes": 18874368,
    "totalItemCount": 52,
    "allTotalBytes": 26214400,
    "collectionCount": 4,
    "subscribedCollectionCount": 1,
    "overLimit": false
  },
  "limits": {
    "maxItems": null,
    "maxCollections": null,
    "maxTotalBytes": 1073741824,
    "maxCollectionItems": 100
  }
}
```

Imported collection subscription contract:

- `POST .../:shareId/import` accepts optional boolean
  `subscribeToSourceChanges`; omission and `false` create an editable snapshot.
- `true` is valid only for a complete collection whose canonical original
  source still exists. The imported collection is read-only while subscribed.
- `PUT .../:collectionId/source-subscription` accepts `{ "enabled": true }` or
  `{ "enabled": false }` and returns `{ "collection": ..., "library": ... }`.
- Disabling is preflighted against the 1 GiB local allowance because the
  retained snapshot becomes locally metered. Exactly 1 GiB is allowed; an
  additional byte is rejected with `emote.storage_limit_reached`.
- Source deletion retains the subscriber's last synchronized snapshot and
  changes the subscription to `detached`. Share revocation does not detach a
  subscription while its canonical source still exists.

Each collection projects:

```json
{
  "sourceSubscription": {
    "eligible": true,
    "enabled": true,
    "status": "synced",
    "sourceCollectionId": "collection_source",
    "sourceRevision": 7,
    "lastSyncedAt": "2026-08-20T10:00:00.000Z",
    "readOnly": true
  }
}
```

`status` is `off`, `synced`, or `detached`. Manual disable produces `off` with
`eligible: true`; only loss of the canonical source produces `detached` with
`eligible: false`. `readOnly` is true only while `status` is `synced`.
Share projections expose `canSubscribeToSourceChanges`; a retained share
snapshot can remain importable even when this field is false.

List files:

```text
GET /api/workspace/files?scope=&conversationId=&uploaderId=&q=&cursor=&limit=
```

Scopes:

| Scope | Meaning |
| --- | --- |
| `all` | All files visible to the viewer. |
| `conversation` | Files visible through a conversation. |
| `standalone` | Space-visible files not tied to a message. |
| `mine` | Files uploaded by the viewer. |

File item:

```json
{
  "id": "att_01",
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "byteSize": 123456,
  "status": "available",
  "visibility": "conversation",
  "conversationId": "conv_01",
  "conversationTitle": "Design Review",
  "uploader": {
    "id": "usr_01",
    "displayName": "timeStarry"
  },
  "createdAt": "2026-06-26T07:56:00.000Z",
  "availableAt": "2026-06-26T07:56:10.000Z",
  "capabilities": {
    "canDownload": true,
    "canRemove": false
  }
}
```

Download:

```text
POST /api/workspace/files/:attachmentId/downloads/reserve
GET /api/workspace/files/:attachmentId/download?downloadId=<reserve id>
```

Rules:

- Visibility and quota are checked before any bytes are sent.
- Download reserve rejection does not consume quota.
- Successful stream/token issuance counts as completed in P0.
- The UI should call reserve first and pass the returned `id` as `downloadId`
  when requesting the stream. The stream endpoint may still perform its own
  reserve/check when `downloadId` is omitted as a backend safety net.
- UI may warn when a known file size exceeds remaining quota, but backend
  remains authoritative.

## 10. Realtime WebSocket Contract

Endpoint:

```text
GET /ws/workspace?lastSeq=42
```

Client hello:

```json
{
  "type": "hello",
  "version": 1,
  "lastSeq": 42
}
```

Server ready:

```json
{
  "type": "ready",
  "version": 1,
  "spaceId": "spc_default",
  "currentSeq": 45,
  "replayFrom": 43,
  "replayCount": 2,
  "hasMore": false
}
```

Event frame:

```json
{
  "type": "event",
  "event": {
    "version": 1,
    "id": "evt_01",
    "spaceId": "spc_default",
    "seq": 46,
    "type": "message.created",
    "actorId": "usr_01",
    "conversationId": "conv_01",
    "createdAt": "2026-06-26T08:00:00.000Z",
    "payload": {
      "message": {}
    }
  }
}
```

Rules:

- Server filters events by viewer permission before delivery.
- Replay is filtered by viewer permission before applying the replay limit.
- Server sends one `event` frame per visible replay event after `ready`.
- `replayCount` is the number of visible event frames that follow the `ready`
  frame for the current hello.
- `hasMore` tells the client to immediately send another `hello` after applying
  the current replay batch, instead of waiting for the normal polling interval.
- `transfer.rejected` is actor-local.
- `emote.library.updated` is visible only to its target user. Its payload is
  `{ userId, collectionId, sourceRevision, status }`; clients refetch the emote
  library rather than receiving private item content in the event.
- Normal members never receive operation-record payloads.
- If replay cannot be satisfied, or the client cursor is ahead of the current
  server sequence, server sends `sync.required`; client refetches bootstrap or
  the affected surface and resets its internal cursor to `currentSeq` when
  present.
- The UI should not display raw `seq` values.

## 11. Capability Flags

API responses can include `capabilities` objects for UI simplification.

Rules:

- Capability names should describe product actions, such as `canCreateGroup`,
  `canInviteMembers`, `canDownload`, not raw permission strings.
- Missing capability means false.
- Capability flags are not security. Every endpoint rechecks permission.
- Capabilities should be scoped to the object when possible.

Examples:

```json
{
  "canSendMessage": true,
  "canUploadFile": true,
  "canManageMembers": false
}
```

## 12. Operation Record Boundaries

The API does not expose operation records in P0.

Required database record writes:

- Login success/rejection.
- Invite create/accept/revoke/reject.
- Conversation and group create.
- Group member add/remove.
- Message creation rejection.
- Upload reserve/complete/fail/reject.
- Download reserve/complete/reject.
- Quota rejection.
- Permission rejection for sensitive operations.

Owner/admin operation-record review is P2 unless a concrete product need is
confirmed. It must be a separate privileged settings section, not part of daily
chat.

## 13. Endpoint Priority

P0:

- GitHub OAuth start/callback/logout.
- Bootstrap.
- Invite creation and acceptance.
- Invite revoke and visible invite rows in bootstrap.
- Member list through bootstrap or `GET /members`.
- Basic member role update and removal for owner.
- Conversation list/create.
- Conversation messages list.
- Mark-read and conversation notification level foundation.
- Message create.
- Group member add/remove, group rename, and group leave if the UI exposes
  management.
- File upload reserve/content/complete/fail.
- File list.
- File download reserve/download and file remove.
- Workspace WebSocket.

P1:

- Paginated member search.
- Invite expiry, max-use, search, and history controls.
- Message reactions.
- Richer unread counts and mention surfacing.
- File search/filter polish and retry flows.

P2:

- Message edit/delete.
- Bot execution and bot access approval.
- Operation-record review UI/API.
- Multi-space switching.
- Export/backup.

## 14. Acceptance Checklist

- Public login can be implemented with GitHub login only.
- Bootstrap gives enough data to render the shell without exposing internals.
- Conversation, member, file, and group APIs return product-shaped objects, not
  raw database rows.
- All mutations derive actor identity from the session.
- Unauthorized and quota-rejected mutations write operation records.
- Structured messages are idempotent and validated server-side.
- Upload quota is reserved before bytes; failed uploads release quota.
- Download quota is checked before stream/token issuance.
- WebSocket events are permission-filtered and replay-capable.
- Normal member APIs do not expose operation records, ledgers, OAuth internals,
  storage keys, request IDs, IP addresses, or user agents.

## 15. Member Visibility Contract

GET /api/workspace/members is viewer-scoped. Owners receive all active members;
non-owners receive self, direct contacts, and owner-granted contacts. For a
non-owner response, an owner is serialized as role admin and roleLabel 管理员.

Owner-only management endpoints:

- GET /api/workspace/member-visibility/:userId
- PUT /api/workspace/member-visibility/:userId

The PUT body is an object with visibleUserIds. The response includes:

- basis: direct_contacts
- viewerUserId
- automaticUserIds
- grantedUserIds
- visibleUserIds

bootstrap.policy.memberVisibilityBasis is direct_contacts, and
bootstrap.permissions.canManageMemberVisibility identifies the owner management
surface. Conversation and group-member mutations enforce the same visibility
scope server-side.
