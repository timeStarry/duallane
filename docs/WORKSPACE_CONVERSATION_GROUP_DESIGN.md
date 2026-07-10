# Workspace Conversation And Group Design

## 1. Purpose

This document defines the product and implementation contract for Workspace
conversations and group chats.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is to make Workspace feel like a real IM product: users can find
conversations, start direct chats, create groups, inspect group members and
files, and understand access without seeing a flat admin page.

Conversation search/discovery rules live in
[Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md).
Unread, mention, and attention-state reservations live in
[Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md).

## 2. Product Principles

- Conversation list is the main daily entry point.
- Direct chat creation starts from members, not from raw user IDs.
- Group chat has a dedicated detail/configuration surface.
- Regular members can understand group membership without seeing internal
  permission mechanics.
- Owner/admin controls are contextual and quiet.
- Backend permission checks are authoritative.
- Realtime events keep the list, active chat, and details in sync.

## 3. Conversation Types

| Type | External label | Purpose |
| --- | --- | --- |
| `direct` | 私聊 | One retained conversation between two space members. |
| `group` | 群聊 | Retained conversation with explicit members and settings. |

Reserved future types:

- `bot_direct`: one-to-one conversation with a bot member.
- `announcement`: read-heavy system or owner broadcast conversation.

The MVP implements `direct` and `group` only.

## 4. Conversation Data Contract

Recommended fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable conversation ID. |
| `space_id` | Owning space. MVP uses one default space. |
| `type` | `direct` or `group`. |
| `title` | Group name or optional direct override. |
| `created_by` | Creator user ID. |
| `created_at` | Server timestamp. |
| `updated_at` | Last metadata update. |
| `last_message_id` | Latest visible message reference. |
| `last_activity_at` | Sorting timestamp. |
| `retention_count` | Default `10000` in MVP. |
| `status` | `active`, `archived`, or `removed` when later supported. |

List response should also include display helpers:

- `displayTitle`
- `memberCount`
- `otherMember` for direct conversations
- `lastMessagePlainText`
- `lastMessageAt`
- `unreadCount` when implemented
- `canSendMessage`
- `canManageMembers`

The server can compute display helpers; the client should not infer access from
hidden data.

## 5. Conversation Membership

Recommended fields:

| Field | Purpose |
| --- | --- |
| `conversation_id` | Conversation reference. |
| `user_id` | Member reference. |
| `role` | Conversation-local role, reserved; default `member`. |
| `added_by` | User who added the member. |
| `joined_at` | Access start timestamp. |
| `removed_at` | Access end timestamp. |
| `last_read_message_id` | P0 read-marker foundation, richer unread UI in P1. |
| `last_read_seq` | P0 replay/read marker foundation, richer unread UI in P1. |
| `notification_level` | P0 conversation notification preference. |

Rules:

- Active membership is required to read and send messages.
- Removed members lose access immediately.
- New group members can read retained prior history in MVP.
- Message authors remain visible after membership changes.
- Do not hard-delete membership rows by default; use `removed_at` for history.

## 6. Conversation List Experience

The list should support quick recognition and action.

Row content:

- Avatar or type icon.
- Title.
- Type chip: `私聊` or `群聊`.
- Group member count.
- Latest message preview from `plainText`.
- Latest activity time.
- Unread badge when implemented.
- Local pending/failure badge when needed.

Sections:

- `置顶`, P1.
- `最近`.
- `暂未开始` empty state.

Controls:

- Search, P1 if backend search is not ready.
- Create menu:
  - `发起私聊`
  - `创建群聊` for owner/admin.
- Refresh or reconnect indicator.

Sorting:

1. Pinned conversations.
2. Unread conversations.
3. `last_activity_at` descending.
4. `created_at` descending.

Empty copy:

| User state | Copy |
| --- | --- |
| Regular member with no conversations | `还没有会话。可以从成员列表发起私聊。` |
| Owner/admin with no conversations | `还没有会话。可以创建群聊或从成员列表发起私聊。` |
| No visible conversations | `你当前没有可访问的会话。` |

## 7. Direct Conversation Flow

Entry points:

- Conversation create menu: `发起私聊`.
- Member directory row: `发起私聊`.

Flow:

1. Open member picker.
2. Exclude current user and unavailable members.
3. User selects one member.
4. Backend validates direct-conversation permission.
5. Backend reuses existing direct conversation for the pair, or creates one.
6. UI selects the returned conversation.

Rules:

- `owner`, `admin`, and `member` can start direct conversations.
- `auditor` is reserved and cannot start direct conversations in MVP.
- Direct uniqueness is per `(space_id, lower_user_id, higher_user_id)`.
- The display title defaults to the other member's display name.
- Direct files are visible only to active members of that direct conversation.

P0:

- Member picker.
- Create/reuse endpoint.
- List row distinction.
- Header with other member.

P1:

- Member search.
- Direct conversation profile drawer.
- Local pin/mute.

## 8. Group Creation Flow

Entry point:

- `创建群聊` in the conversation create menu.

Flow:

1. Open focused modal or mobile sheet.
2. Enter group name.
3. Select initial members.
4. Show selected count.
5. Submit.
6. Backend validates role and members.
7. Backend creates conversation and membership rows transactionally.
8. Backend emits `conversation.created` and member-added events.
9. UI opens the new group.

Rules:

- Owner/admin can create groups.
- Regular members cannot create groups in MVP.
- Creator is included automatically.
- P0 requires at least one selected member besides the creator.
- Empty creator-only groups are deferred to a later policy decision.
- Initial selected members must be active space members.

Validation copy:

| Situation | Copy |
| --- | --- |
| Missing name | `请输入群聊名称。` |
| No selected member | `请选择至少一位群聊成员。` |
| No permission | `你当前不能创建群聊。` |
| Invalid member | `部分成员无法加入此群聊。` |
| Server conflict | `群聊创建失败，请重试。` |

## 9. Group Details Surface

Group configuration must not live as an always-visible admin strip. It belongs
in a contextual drawer on desktop and a sheet/subpage on mobile.

Tabs:

- `概览`
- `成员`
- `文件`
- `设置`

Overview:

- Group name.
- Member count.
- Creator or created time where useful.
- Retention copy: `保留最近 10000 条消息`.
- Space-retained trust copy.

Members:

- Searchable member list.
- Add member action for owner/admin.
- Remove action for owner/admin.
- Friendly role labels.

Files:

- Files shared in this group.
- Download actions.
- Quota warning when needed.

Settings:

- Rename group for owner/admin.
- Leave group for current group member, with last-member protection.
- Conversation notification level: `全部`, `提及`, `免打扰`.
- Dissolve/archive group, P2.

## 10. Group Member Management

Add member flow:

1. Owner/admin opens group details.
2. Clicks `添加成员`.
3. Member picker shows space members not already in the group.
4. User selects members.
5. Backend validates permission and active space membership.
6. Backend adds membership rows and emits events.
7. UI updates member count and list.

Remove member flow:

1. Owner/admin opens member row menu.
2. Clicks `移出群聊`.
3. UI confirms if removal is disruptive.
4. Backend validates permission.
5. Backend sets `removed_at`.
6. Removed member loses access immediately.
7. Backend writes operation record and event.

Rules:

- Regular members can view group members but cannot add/remove members.
- Owner/admin cannot remove themselves through the same accidental row action in
  P0; leaving group should be a separate explicit action when implemented.
- Removing the last active member should be rejected unless group archival is
  implemented.
- Adding a member who was previously removed reactivates access according to the
  current retained-history policy.

## 11. Conversation Header And Active Chat

Header content:

- Conversation title.
- Type/member count.
- Trust copy: `共享空间保存消息和文件`.
- Details button.
- More menu, P1.

Chat body:

- Message history.
- Date separators.
- Author grouping.
- System messages.
- File cards.
- Pending and failed local messages.

Composer:

- Text input.
- Send button.
- File button.
- Mention/emoji controls reserved for P1.
- Disabled only when the user cannot send or no conversation is selected.

When no conversation is selected:

- Show useful empty state.
- Do not show a disabled composer as the main experience.

## 12. Conversation States

| State | Meaning | UI behavior |
| --- | --- | --- |
| `loading` | Fetching list or history | Skeleton or compact loading state. |
| `empty` | Conversation exists but has no messages | Show start-chat copy and composer. |
| `ready` | Normal conversation state | Show history and composer. |
| `sending` | Optimistic local message pending | Show pending message row. |
| `send_failed` | Message failed | Show retry/remove controls. |
| `removed` | Current user lost access | Close composer and show access copy. |
| `archived` | Future read-only state | Hide composer, keep readable history if allowed. |

Access copy:

- `你无法访问此会话。`
- `你已不在此群聊中。`
- `此会话暂不可发送消息。`

## 13. Realtime Updates

Conversation-related event types:

- `conversation.created`
- `conversation.updated`
- `conversation.member_added`
- `conversation.member_removed`
- `conversation.notification_updated`
- `message.created`
- `message.updated`, reserved.
- `message.deleted`, reserved.
- `attachment.available`
- `attachment.failed`

Projection rules:

- A new accessible conversation appears in the list.
- A removed conversation disappears or changes to inaccessible state.
- Active group member list updates without refresh.
- New messages append if the conversation is open.
- Conversation preview and sort order update from message events.
- Clients deduplicate events by event ID and message ID.

Normal members must not receive audit-log payloads or internal event metadata as
visible content.

## 14. Permission And Audit

Permission checks:

- Space membership before any conversation access.
- Conversation membership before reading messages or files.
- Role check before group creation and member management.
- Sender check before message creation.
- Attachment visibility before message attachment and download.

Operation records:

- Conversation creation.
- Unauthorized conversation create attempt.
- Group member added.
- Group member removed.
- Unauthorized group-management attempt.
- Message creation rejection.

Operation records stay database-only in the first full Workspace loop.

## 15. API Contract

Required:

- `GET /api/workspace/conversations`
- `POST /api/workspace/conversations`
- `GET /api/workspace/conversations/:conversationId/messages`
- `POST /api/workspace/messages`
- `POST /api/workspace/conversations/:conversationId/read`
- `PATCH /api/workspace/conversations/:conversationId/notification`

Productized additions:

- `GET /api/workspace/members`
- `POST /api/workspace/groups/:conversationId/members`
- `DELETE /api/workspace/groups/:conversationId/members/:userId`
- `PATCH /api/workspace/groups/:conversationId`
- `POST /api/workspace/groups/:conversationId/leave`

Conversation create request:

```json
{
  "type": "group",
  "title": "Design Review",
  "memberIds": ["usr_01", "usr_02"]
}
```

Group create rules:

- `memberIds` must contain at least one selected active space member other than
  the creator.
- The server includes the creator automatically and canonicalizes duplicates.
- Empty or creator-only `memberIds` is rejected with
  `conversation.invalid_members`.

Direct create request:

```json
{
  "type": "direct",
  "memberIds": ["usr_02"]
}
```

Response should return the canonical conversation object and current user's
capabilities for that conversation.

## 16. P0 / P1 / P2

P0:

- Direct conversation create/reuse.
- Group conversation creation.
- Conversation list with type and preview.
- Active chat with structured messages.
- Group details drawer with overview, members, and files.
- Owner/admin add/remove group members where endpoints exist.
- Group rename and leave group foundation.
- Read marker and conversation notification level foundation.

P1:

- Conversation search.
- Local pin/mute polish beyond the basic notification level.
- Replies and reactions.
- Unread count and last-read markers.
- Richer unread/mention surfacing.

P2:

- Group archival/dissolve policy.
- Per-group posting restrictions.
- Join approval.
- Announcement conversations.
- Bot direct conversations.

## 17. Acceptance Checklist

- Conversation list is not a raw table; it exposes useful IM preview data.
- Direct chats start from a member picker and reuse an existing pair
  conversation.
- Group creation is a focused modal/sheet.
- Group details contain overview, members, files, and settings without
  cluttering the chat column.
- Regular members can view group context but cannot see management controls they
  cannot use.
- Removed group members lose access immediately.
- New group members can see retained prior history in MVP.
- Sensitive rejections write operation records.
