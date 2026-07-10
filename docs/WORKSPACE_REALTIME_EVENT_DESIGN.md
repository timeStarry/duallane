# Workspace Realtime Event Design

## 1. Purpose

This document defines Workspace realtime events, client projection behavior,
reconnect rules, notification states, and future extensibility.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

Realtime is the mechanism that makes Workspace feel like an IM product. Events
must update messages, conversations, group members, files, quota notices, and
future bot responses without exposing platform internals to normal members.

Client-side projection and refetch rules live in
[Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md).
Unread, mentions, local notices, and future notification preferences live in
[Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md).

## 2. Design Principles

- Events are server-created facts.
- Client commands are requests; events are accepted state changes or safe
  notifications.
- Persisted event log supports reconnect and replay.
- Event `seq` is monotonic per space.
- Subscribers receive only events they are allowed to see.
- Operation records are not realtime member events in the first loop.
- Unknown event types must be safely ignored or trigger a refetch.
- The event envelope should be stable enough for AI bots, notifications, and
  future multi-device clients.

## 3. Event Layers

Workspace has three related but separate layers:

| Layer | Purpose | Visible to normal members |
| --- | --- | --- |
| Client command | Ask server to do something | Only local request/result. |
| Realtime event | Server fact for UI projection | Yes, if permission allows. |
| Operation record | Security/accountability log | No in first loop. |

Example:

- User sends `message.create` command.
- Server persists message.
- Server emits `message.created`.
- Server may write an operation record only for rejection or sensitive cases.

Do not send audit-log payloads through the realtime stream for normal members.

## 4. Event Envelope

Canonical event shape:

```json
{
  "version": 1,
  "id": "evt_01J0Y4M5K3V9QKE0E0ECG9P9MK",
  "spaceId": "spc_default",
  "seq": 42,
  "type": "message.created",
  "actorId": "usr_01",
  "conversationId": "conv_01",
  "target": {
    "type": "message",
    "id": "msg_01"
  },
  "createdAt": "2026-06-25T09:00:00.000Z",
  "payload": {
    "messageId": "msg_01"
  }
}
```

Required fields:

| Field | Purpose |
| --- | --- |
| `version` | Envelope version. |
| `id` | Stable event ID. |
| `spaceId` | Space scope. |
| `seq` | Monotonic per-space sequence. |
| `type` | Event type string. |
| `actorId` | User/bot/system actor when safe to expose. |
| `conversationId` | Conversation scope when applicable. |
| `target` | Typed target reference. |
| `createdAt` | Server timestamp. |
| `payload` | Type-specific safe data. |

Rules:

- `seq` is assigned by the server.
- `createdAt` is server time.
- Payload must be user-safe for every recipient.
- Permission filtering happens before delivery.
- Clients deduplicate by `id`.
- Clients order by `seq` within a space.

## 5. Event Persistence

Recommended `workspace_events` table:

| Field | Purpose |
| --- | --- |
| `id` | Event ID. |
| `space_id` | Space scope. |
| `seq` | Monotonic per-space sequence. |
| `type` | Event type. |
| `actor_user_id` | Actor reference. |
| `conversation_id` | Optional conversation reference. |
| `target_type` | Target type. |
| `target_id` | Target ID. |
| `payload_json` | Safe payload. |
| `created_at` | Server timestamp. |

Persistence rules:

- Emit events in the same transaction as the state change when possible.
- If same-transaction emit is impractical, use an outbox-style pattern later.
- Event log retention can be shorter than messages, but replay must either work
  from the requested `seq` or tell the client to refetch.
- Operation records have separate retention and storage.

## 6. Connection Model

Endpoint:

- `GET /ws/workspace`

Client handshake:

```json
{
  "version": 1,
  "type": "hello",
  "lastSeq": 41
}
```

Server response:

```json
{
  "version": 1,
  "type": "ready",
  "spaceId": "spc_default",
  "currentSeq": 42,
  "replayFrom": 42,
  "replayCount": 1
}
```

Rules:

- HTTP session or equivalent auth is required.
- If `lastSeq` is present and replayable, server sends missed events.
- Replay is filtered by viewer permission before applying the replay limit.
- The server sends one `event` frame per visible replay event after `ready`.
- `replayCount` tells the client how many visible replay event frames follow
  the `ready` frame for that hello.
- If replay is unavailable, or the client cursor is ahead of the server cursor,
  server sends `sync.required`.
- Client then refetches bootstrap, conversations, active messages, and file
  lists as needed, and resets its internal cursor to the server `currentSeq`
  when present.
- Heartbeat keeps the connection state clear.

Connection states:

| State | UI copy |
| --- | --- |
| `connecting` | `正在连接...` |
| `ready` | No intrusive copy; optional synced indicator. |
| `reconnecting` | `正在重新连接...` |
| `sync_required` | `正在同步最新内容...` |
| `offline` | `连接暂时不可用。` |

Do not expose raw sequence numbers in normal UI.

## 7. MVP Event Types

| Event | Required | Scope | Product effect |
| --- | --- | --- | --- |
| `workspace.member_joined` | yes | space | Member appears in directory. |
| `conversation.created` | yes | conversation/space | Conversation appears for allowed members. |
| `conversation.member_added` | yes | conversation | Group member list updates. |
| `conversation.member_removed` | yes | conversation | Access/list updates. |
| `message.created` | yes | conversation | Message appears and list preview updates. |
| `attachment.created` | yes | uploader/admin local | Pending upload state for uploader. |
| `attachment.available` | yes | file/conversation/space | File appears available. |
| `attachment.failed` | yes | file/conversation/space | Upload failure shown to uploader. |
| `transfer.rejected` | yes | actor/local | Quota/permission rejection notice. |

Reserved event types:

- `conversation.updated`
- `conversation.archived`
- `message.updated`
- `message.deleted`
- `reaction.added`
- `reaction.removed`
- `attachment.removed`
- `member.role_changed`
- `invite.created`
- `invite.revoked`
- `bot.mentioned`
- `bot.response.created`
- `bot.response.failed`

Reserved events should use the same envelope and filtering model.

## 8. Conversation Event Payloads

`conversation.created`:

```json
{
  "conversation": {
    "id": "conv_01",
    "type": "group",
    "displayTitle": "Design Review",
    "memberCount": 3,
    "lastActivityAt": "2026-06-25T09:00:00.000Z"
  }
}
```

`conversation.member_added`:

```json
{
  "conversationId": "conv_01",
  "member": {
    "id": "usr_02",
    "displayName": "Alice",
    "roleLabel": "成员"
  }
}
```

`conversation.member_removed`:

```json
{
  "conversationId": "conv_01",
  "userId": "usr_02"
}
```

Projection:

- Add/update conversation list row.
- Update active context drawer member count.
- If the current user is removed, close composer and show access copy.
- Do not show IP address, request ID, operator user agent, or audit reason.

## 9. Message Event Payloads

`message.created`:

```json
{
  "message": {
    "id": "msg_01",
    "conversationId": "conv_01",
    "authorId": "usr_01",
    "kind": "user",
    "plainText": "Please check demo.pdf",
    "createdAt": "2026-06-25T09:00:00.000Z"
  }
}
```

Payload strategy:

- P0 can include enough message data to render immediately, or only `messageId`
  and require message fetch.
- If full content is included, it must already be permission-filtered and safe.
- Clients reconcile optimistic messages through `clientMessageId` when present
  in the message object or fetch response.

Projection:

- Append to active conversation.
- Update conversation preview.
- Move conversation to top of recent list.
- Increment unread count when implemented and conversation is not active.
- If `message.kind` is `system`, render it as a quiet conversation fact, not as
  a human-authored chat bubble.
- System message payloads remain product-safe and must not include operation
  records, request IDs, transfer ledger IDs, OAuth details, storage keys, IP
  addresses, or user agents.

## 10. File And Transfer Event Payloads

`attachment.available`:

```json
{
  "attachment": {
    "id": "att_01",
    "fileName": "demo.pdf",
    "byteSize": 123456,
    "visibility": "conversation",
    "conversationId": "conv_01",
    "status": "available"
  }
}
```

`attachment.failed`:

```json
{
  "attachmentId": "att_01",
  "reason": "upload_failed"
}
```

`transfer.rejected`:

```json
{
  "direction": "upload",
  "code": "quota.insufficient",
  "reason": "quota.insufficient",
  "message": "今日传输额度不足"
}
```

Projection:

- Available files update chat cards and file library rows.
- Failed uploads show retry/failure only where useful, usually to uploader.
- Attachment-created events do not expose upload transfer IDs to normal clients.
- Non-uploader members do not receive pending/failed upload state; they receive
  the file once it becomes available and visible to them.
- Transfer rejection is a local notice, not a chat message to everyone.
- Transfer rejection events do not expose transfer ledger IDs; `target.id` is
  null in the normal client stream.
- Quota numbers can refresh from bootstrap or quota endpoint.

## 11. Visibility Filtering

Delivery filters:

- Space-level event requires active space membership.
- Conversation event requires active conversation membership, except when the
  event grants access to the recipient.
- File event requires file visibility to the recipient.
- Actor-local events such as transfer rejection should go only to the actor.
- Operation records are not delivered through this stream in the first loop.

Special cases:

- `conversation.member_added` can be delivered to the newly added member so the
  conversation appears.
- `conversation.member_removed` can be delivered to the removed member with
  minimal payload so UI can close access.
- Invite events are reserved for privileged settings and should not be broadcast
  to normal members.

## 12. Client Projection Model

Client stores or derives:

- Current user and role.
- Visible member directory.
- Conversation list.
- Active conversation messages.
- File library.
- Context drawer data.
- Last seen event `seq`.
- Pending local commands.

Projection rules:

- Apply events idempotently.
- If an event references unknown data, fetch the target or trigger a small
  refetch.
- If event gap is detected, call bootstrap/list endpoints and reset projection.
- Preserve pending local messages during reconnect.
- Reconcile successful messages by `clientMessageId`.
- Mark stale pending messages as retryable after timeout.

Unknown event behavior:

- If event type is unknown and scope is not active, store/ignore safely.
- If event type is unknown and scope is active, refetch the relevant object.
- Never render unknown payload as raw HTML or debug JSON.

## 13. Notification And Unread States

P1/P2 design, reserved in P0:

Unread model:

- Track `last_read_message_id` or `last_read_seq` per conversation member.
- Increment unread on `message.created` when the conversation is not active.
- Do not count messages authored by the current user as unread.
- System messages may count or not based on event importance.

Notification levels:

| Level | Meaning |
| --- | --- |
| `all` | Notify for all new messages. |
| `mentions` | Notify only on mentions. |
| `muted` | No active notification, unread still tracked. |

P0 can omit notifications, but event design should not block them.

## 14. AI Bot Event Compatibility

Future bot flow:

1. User sends a message mentioning a bot.
2. Server validates bot membership and policy.
3. Server emits or records `bot.mentioned`.
4. Bot worker creates a response task.
5. Bot response is persisted as `kind: "bot"` message.
6. Server emits `bot.response.created` or `bot.response.failed`.

Bot event rules:

- Bot eligibility is server-computed.
- Client-submitted bot fields are never trusted.
- Bot file-content access requires explicit policy and operation records.
- Bot provider errors must not leak to normal members.
- Bot messages render with clear bot identity.

P0 does not execute bots. The event envelope and message kinds reserve the path.

## 15. Error Events And Local Notices

Use errors as local result notices rather than shared chat content unless the
event affects the conversation.

Local examples:

- Upload rejected for quota.
- Download rejected for quota.
- Message send failed due to permission.
- Reconnect failed.

Shared examples:

- Member added to group.
- Member removed from group.
- File became available in group.

Error payloads should use stable codes:

```json
{
  "code": "quota.insufficient",
  "message": "今日传输额度不足"
}
```

Do not expose stack traces, SQL errors, provider tokens, OAuth internals, request
IDs, IP addresses, or user agents.

## 16. Operational Boundaries

Realtime events are product state. Operation records are operational evidence.

Operation records:

- Login success/rejection.
- Invite create/accept/reject.
- Role changes.
- Conversation creation.
- Group member changes.
- File transfer reserve/completed/failed/rejected.
- Permission and quota rejection.

Normal member realtime stream must not include:

- Raw operation records.
- Transfer ledger rows.
- Request IDs.
- IP addresses.
- User agents.
- OAuth provider payloads.
- Internal stack traces.

Owner/admin operation-record UI is deferred and should be separate from the
daily realtime event stream.

## 17. P0 / P1 / P2

P0:

- WebSocket endpoint for authenticated Workspace members.
- Event persistence with per-space `seq`.
- Replay from last seen `seq` where available.
- `sync.required` fallback.
- Events for conversations, group membership, messages, attachments, and
  transfer rejection.
- Permission-filtered delivery.
- Client projection and reconnect state.

P1:

- Unread counts.
- Last-read markers.
- Conversation pin/mute events or local preferences.
- Reaction events.
- Group rename events.
- File removal events.

P2:

- Push notifications.
- Bot execution events.
- Multi-device session projection.
- Event retention policy and compaction.
- Owner/admin operation-record UI separate from member realtime stream.

## 18. Acceptance Checklist

- Events are server-created and versioned.
- Event `seq` is monotonic per space.
- Clients can reconnect with last seen `seq`.
- Replay gap triggers refetch instead of corrupt UI state.
- Subscribers receive only events they are allowed to see.
- Message, conversation, group member, file, and quota rejection updates can be
  projected without page refresh.
- Transfer rejection appears as a local notice, not shared chat spam.
- Operation records are not visible to normal members through realtime.
- Unknown future events do not break the current client.
- Event model supports future bot responses without changing the base envelope.
