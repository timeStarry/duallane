# Workspace Notification And Unread Design

## 1. Purpose

This document defines unread state, lightweight notifications, mentions, and
attention cues for Workspace.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The first productized loop does not need mobile push notifications, but the IM
surface needs a stable model for unread badges, local notices, mention cues, and
future notification preferences.

## 2. Principles

- Attention cues should help users return to relevant conversations.
- Actor-only failures use local notices, not shared chat messages.
- Unread counts should not require users to understand event sequences.
- Notification settings should be quiet and conversation-specific.
- P0 reserves the data model and implements minimal read-marker plus
  conversation notification behavior.
- Push notifications are out of scope for P0.

## 3. Attention Types

| Type | Meaning | P0/P1 |
| --- | --- | --- |
| Local notice | Actor-only result, such as quota rejection | P0 |
| Pending/failure badge | Local unsent message or failed upload | P0 |
| Unread badge | Conversation has new messages | P1, optional P0 if simple |
| Mention badge | Current user was mentioned | P1 |
| Notification level | All/mentions/muted preference | P0 lightweight setting |
| Push notification | OS/browser notification | P2 |

Local notices are not persisted as shared messages. They can be kept in client
state and expire after a short time.

## 4. Local Notices

Use local notices for:

- Upload quota rejected.
- Download quota rejected.
- Upload failed.
- Message send failed.
- Invite copied.
- Invite creation failed.
- Reconnect in progress.
- Access changed for current user.

Do not create shared chat messages for:

- Transfer ledger reservation.
- Transfer rejection visible only to the actor.
- OAuth provider errors.
- Request IDs.
- Local browser download failure.

Notice placement:

- Shell footer or top inline bar for reconnect.
- Composer/file area for upload/send failures.
- Toast or inline success for copy actions.
- File row for download rejection where possible.

Copy:

- `今日传输额度不足，无法上传此文件。`
- `今日传输额度不足，无法下载此文件。`
- `消息发送失败，请重试。`
- `邀请链接已复制。`
- `正在重新连接...`

## 5. Unread Model

Recommended data fields:

| Field | Where | Purpose |
| --- | --- | --- |
| `last_read_message_id` | `conversation_members` | Last read message anchor. |
| `last_read_at` | `conversation_members` | Timestamp fallback. |
| `last_read_seq` | `conversation_members` | Optional event-based anchor. |
| `unread_count` | conversation list response | Display badge. |
| `mention_count` | conversation list response, P1 | Mention badge. |

Rules:

- Messages authored by the current user do not count as unread for that user.
- A conversation open and focused can mark messages read automatically after a
  short delay.
- If the window is inactive or conversation is not selected, new messages count
  as unread.
- System messages count only when they represent conversation-visible facts.
- Actor-local transfer rejections never count as unread conversation messages.

P0 may keep unread counts lightweight, but the schema and endpoint should
already reserve last-read fields.

## 6. Mark Read Behavior

P0 endpoint:

- `POST /api/workspace/conversations/:conversationId/read`

Request:

```json
{
  "messageId": "msg_01"
}
```

Behavior:

- Backend validates conversation membership.
- Backend updates `last_read_message_id` or equivalent.
- Conversation row unread count clears or decreases.
- No operation record is required for normal read markers.

Client behavior:

- Mark read when active conversation is opened and messages are visible.
- Debounce mark-read calls.
- Do not mark read while offline.
- On reconnect, reconcile read state from conversation list response.

## 7. Conversation Row Badges

P0:

- Pending local message badge.
- Failed local message badge.
- Optional unread dot if easy from local events.

P1:

- Numeric unread badge.
- Mention badge.
- Muted indicator.

Badge rules:

- Keep badges compact.
- Do not show raw counts above a high cap; use `99+`.
- Mention badge should be visually distinct but not alarming.
- Muted conversations may still show unread count in a quieter style.

## 8. Mentions

Mention support depends on structured message blocks:

```ts
{ type: "mention"; userId: string; label: string }
```

Rules:

- Backend validates mentioned member visibility.
- Server computes mention targets from canonical blocks.
- Client-submitted mention labels are display hints only.
- Future bot mentions use the same block type but server computes bot
  eligibility.

P1 mention UI:

- Type `@` to open member picker.
- Selected member becomes mention block.
- Message row highlights mentions of current user.
- Conversation row shows mention badge.

P0 can render existing mention blocks if present without offering a full picker.

## 9. Notification Preferences

Recommended levels:

| Level | User-facing label | Behavior |
| --- | --- | --- |
| `all` | 所有消息 | Count and future notify all new messages. |
| `mentions` | 仅提到我 | Count unread quietly, emphasize mentions. |
| `muted` | 免打扰 | No active notification, unread still tracked quietly. |

Scope:

- Conversation-level preference.
- Stored in `conversation_members.notification_level`.
- Global space default can be added later.

P0:

- Conversation details `设置` tab exposes notification level.
- The setting is personal to the current member and stored on
  `conversation_members.notification_level`.
- Updates emit an actor-local realtime event so another session for the same
  user can refresh without exposing the preference to other members.

## 10. Browser Push And OS Notifications

Out of scope for P0.

Future requirements:

- User opt-in is required.
- Respect conversation notification level.
- Do not include sensitive content if user chooses privacy mode.
- Never include internal request IDs or platform errors.
- Push payload should use `plainText` summary only when allowed.

## 11. Realtime Event Interaction

Events that may affect attention:

- `message.created`
- `conversation.member_added`
- `conversation.member_removed`
- `attachment.available`
- `attachment.failed`
- `transfer.rejected`
- `reaction.added`, P1/P2

Projection rules:

- `message.created` updates unread if conversation is not active.
- `message.created` reconciles pending local message if `clientMessageId`
  matches.
- `attachment.failed` creates local notice for uploader.
- `transfer.rejected` creates actor-local notice only.
- Group membership changes may create system rows or quiet notices depending on
  whether they are conversation-visible facts.

Do not expose raw event sequence numbers.

## 12. State And Error Copy

Unread/read failures:

- If mark-read fails, keep UI usable and retry later.
- Do not show an error toast for every read-marker failure.

Notification preference failures:

- `提醒设置保存失败，请重试。`

Local notice timeout:

- Success copy can disappear quickly.
- Failures should stay until user acts or changes context.

## 13. API Contract

P0 fields:

- `conversation_members.last_read_message_id`
- `conversation_members.last_read_seq`
- `conversation_members.notification_level`

P0 endpoints:

- `POST /api/workspace/conversations/:conversationId/read`
- `PATCH /api/workspace/conversations/:conversationId/notification`

Conversation list response:

```json
{
  "id": "conv_01",
  "displayTitle": "Design Review",
  "unreadCount": 3,
  "mentionCount": 1,
  "notificationLevel": "all"
}
```

## 14. P0 / P1 / P2

P0:

- Local notices.
- Pending/failed local message or upload indicators.
- Data model for unread/read markers.
- Mark-read endpoint.
- Conversation notification levels.
- Event projection does not treat actor-local failures as shared unread content.

P1:

- Persisted unread counts.
- Mention picker and mention badges.

P2:

- Browser/OS push notifications.
- Multi-device read state.
- Notification privacy settings.
- Digest or summary notifications.

## 15. Acceptance Checklist

- Quota and transfer failures are local notices, not shared chat messages.
- Pending and failed local sends are visible and retryable.
- Unread state can be added without changing the event envelope.
- Current user's own messages do not count as unread.
- Mention blocks are server-validated and safe to render.
- Notification preferences are conversation-scoped when implemented.
- No notification surface exposes operation records, request IDs, OAuth details,
  transfer ledgers, IP addresses, or user agents.
