# Workspace IM Product Design

## 1. Purpose

This document defines the product-grade instant messaging experience for
DualLane shared spaces.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

共享空间不是企业协作后台，也不是把所有能力平铺出来的管理页。它首先是一个熟人、小组和固定伙伴能长期使用的 IM 空间：会话清楚、成员好找、文件能留存、群聊能配置、权限不打扰普通使用。

The goal is a richer IM product surface with a simple daily-use path:

1. Open the shared space.
2. Pick or create a conversation.
3. Chat, share files, and see relevant members/context.
4. Use settings only when the user has that intent and permission.

## 2. Product Principles

- Daily chat is the primary surface; settings are nearby but not foregrounded.
- A regular member should understand what they can do without learning RBAC,
  audit logs, transfer ledgers, or platform internals.
- Professional controls should be grouped into purposeful panels, not scattered
  across the chat screen.
- Group chat should feel like a normal group chat: name, members, files, history,
  and quiet membership controls.
- File sharing should feel like part of chat and also work as a standalone file
  library.
- Quota and retention must be visible enough to prevent surprises, but they
  should not dominate the interface.
- The implementation remains strict: backend-owned permissions, quota checks,
  retention, structured messages, realtime events, and operation records.

## 3. Core Objects

| Object | User-facing name | Product role |
| --- | --- | --- |
| `space` | 空间 | The current shared place. MVP has one default space. |
| `conversation` | 会话 | A direct or group chat inside the space. |
| `direct conversation` | 私聊 | A one-to-one retained chat between two space members. |
| `group conversation` | 群聊 | A retained chat with explicit members and group settings. |
| `member` | 成员 | A human or future bot account that belongs to the space. |
| `message` | 消息 | A structured server-retained chat item. |
| `attachment` | 文件 | A first-class uploaded file, optionally referenced by messages. |
| `invite` | 邀请代码 / 邀请链接 | A permissioned way to let someone join. Not shown on the login page. |
| `quota` | 今日传输额度 | Upload and download capacity available to a user today. |

## 4. Daily Member Navigation

Regular members should see:

- `聊天`: joined direct and group conversations.
- `文件`: files visible to the member.
- `成员`: visible space members and lightweight profiles.
- `空间信息`: space name, own role, today's transfer quota, retention copy.

Privileged members additionally see:

- `空间设置`: grouped controls for invites, groups, permissions, and space policy.

Normal members must not see:

- Operation records or audit logs.
- Request IDs, IP addresses, user agents, OAuth provider details, platform logs.
- Transfer ledger rows.
- Internal event sequences.
- Admin-only invite or role controls.

## 5. Conversation List

The conversation list is the main entry to shared-space work. It should not be a
simple flat dump of conversations.

Required fields per row:

- Conversation avatar or type icon.
- Title.
- Conversation type indicator: `私聊` or `群聊`.
- Member count for groups.
- Latest message preview using `plainText`.
- Latest activity time.
- Unread count when implemented.
- Upload/message failure badge when the current user has unresolved local state.

List sections:

- `置顶` for pinned conversations, when implemented.
- `最近` for normal recent conversations.
- `暂未开始` empty state when the user has no conversations.

List controls:

- Search/filter entry, P1 if backend search is not ready.
- Create button with a menu:
  - `发起私聊`
  - `创建群聊` when permitted
- Refresh action.

Sorting:

1. Pinned conversations first.
2. Conversations with unread messages.
3. Latest message/event time descending.
4. Stable fallback by creation time.

Empty states:

- Member with no conversations: `还没有会话。可以从成员列表发起私聊。`
- Admin/owner with no conversations: `还没有会话。可以创建群聊或从成员列表发起私聊。`
- Permission-limited user: `你当前没有可访问的会话。`

## 6. Direct Conversations

Direct conversations are one-to-one retained Workspace chats.

Creation flow:

1. User clicks `发起私聊`.
2. A member picker opens.
3. User selects one visible space member.
4. Backend reuses the existing direct conversation for the pair if it exists.
5. UI navigates to that conversation.

Rules:

- Members can create direct conversations when `conversation.create_direct` is
  allowed.
- There is one direct conversation per member pair per space.
- Direct conversation title defaults to the other member's display name.
- Direct conversation files are visible only to current members of that
  conversation.
- If a member loses space membership, they lose access immediately.

P0:

- Create/reuse direct conversations.
- Conversation list shows direct conversations.
- Header shows the other member and status copy.

P1:

- Member picker search.
- Mute/pin local preferences.
- Lightweight profile drawer.

## 7. Group Conversations

Group conversations need a real configuration model. A group is not just a
conversation row with more members.

Group creation flow:

1. User clicks `创建群聊`.
2. User enters group name.
3. User selects at least one initial member.
4. UI shows a summary before creation.
5. Backend creates the conversation and membership rows.
6. UI opens the new group.

Required group settings:

- Group name.
- Group members.
- Group file visibility.
- Retention copy: `保留最近 10000 条消息`.
- Member add/remove controls for owner/admin.
- Rename group controls for owner/admin.
- Leave group action for current group members.
- Conversation notification preference.
- Dissolve group action for owner/admin, P2 depending on deletion policy.

Group settings should live in a conversation details drawer or a dedicated
settings sheet, not as always-visible controls in the chat column.

Group member management:

- Owners/admins can add and remove group members.
- Regular members can view group members.
- Removed members lose access to messages and files immediately.
- New members can see retained prior history by default in MVP.
- Membership changes create realtime events and operation records.

Group detail panels:

- `概览`: group name, member count, history policy.
- `成员`: searchable member list with add/remove where allowed.
- `文件`: files shared in this group.
- `设置`: privileged group-level controls.

P0:

- Create group with at least one selected member besides the creator.
- View group details.
- View group member list.
- Add/remove group members for owner/admin if backend endpoint exists in loop.
- Rename group, leave group, and notification-level foundation.

P1:

- Group avatar or color marker.
- Pin/mute polish beyond the basic notification level.
- Stronger confirmation and recovery polish for leave/rename flows.

P2:

- Dissolve group with retention/archive policy.
- Join approval for larger groups.
- Per-group posting restrictions.

## 8. Member Directory

The member directory is a product surface, not an admin table.

Required visible fields:

- Avatar.
- Display name.
- GitHub login as secondary identity.
- User kind: human or bot, once bots exist.
- Role label in friendly terms: `空间主人`, `管理员`, `成员`.
- Optional local presence/status later.

Member actions:

- `发起私聊` for visible human members.
- `添加到群聊` inside group management for permitted users.
- `复制成员 ID` can be hidden behind a more menu if needed for debugging, not
  shown as a primary action.
- Role changes only in privileged settings, not inline in the normal directory.

Fetch behavior:

- P0 can load members through bootstrap when member count is small.
- The product contract should still reserve `GET /api/workspace/members` for a
  paginated/searchable member list.
- Member picker and group settings should use the same member source.
- UI must handle loading, empty, no-result, and permission states.

Search behavior:

- P0: client-side search over loaded members.
- P1: backend search by display name and GitHub login.
- P2: richer filters such as role, bot/human, recent activity.

## 9. Chat Window

The chat window has three stable zones:

- Header.
- Message history.
- Composer.

Header content:

- Conversation title.
- Type/member count.
- Trust/status copy: `共享空间保存消息和文件`.
- Details button that opens the conversation drawer.
- Search button, P1.
- More menu for group settings, mute/pin, and leave group when implemented.

Message history:

- Date separators.
- Message bubbles or grouped message rows.
- Author name/avatar for group chats.
- Sender grouping for consecutive messages.
- File chips/cards for attachments.
- Reply preview when `replyToMessageId` is present.
- System messages rendered quietly and separately from human messages.
- Failed/pending local message states.

Composer:

- Plain text input.
- Send button.
- File upload button.
- Mention support by typing `@`, P1 if member picker is not ready in P0.
- Emoji/emote picker, P1.
- Attachment staging area before send.
- Clear disabled states when no conversation is selected or quota/permission is
  insufficient.

Composer should not expose protocol fields. Users send messages and files; the
client converts that into structured blocks.

## 10. Structured Message Rendering

The UI should render from `content.blocks` and fall back to `plainText`.

Block rendering:

| Block | UI behavior |
| --- | --- |
| `text` | Plain escaped text. |
| `mention` | Member chip or highlighted text. |
| `link` | Safe external link with visible domain. |
| `emoji` | Emoji/emote glyph from supported registry. |
| `attachment` | File chip/card resolved from attachment metadata. |

Rules:

- Never render raw HTML from message content.
- Unknown blocks render through `plainText` fallback.
- Attachments referenced by a message must still be permission-checked on
  download.
- System and bot messages must not appear as human-authored text.
- P0 system messages cover conversation-visible group facts such as group
  creation, member add/remove, member leaving, and group rename.
- System messages are not operation records and must not reveal platform
  internals.

Reserved P1/P2 interactions:

- Reply.
- Edit.
- Delete.
- Reactions.
- Copy message link.
- Forward or quote into another conversation.

## 11. File Experience

Workspace files have two entry points:

- From chat: upload a file and reference it in the current conversation.
- From file library: upload a standalone file visible according to policy.

File list fields:

- File name.
- Size.
- Uploader.
- Upload time.
- Visibility: conversation or space.
- Status: uploading, available, failed, removed.
- Download action.

File behavior:

- Upload reserve happens before bytes are accepted.
- Failed upload releases reserved quota.
- Download checks remaining quota before issuing a stream/token.
- Rejected transfer shows user-safe copy: `今日传输额度不足`.
- Attachments can exist without messages.
- Message retention does not hard-delete standalone attachments.

Chat file card:

- File icon based on MIME/type.
- File name and size.
- Uploader and time where useful.
- Download button.
- Quota warning only when the file is larger than remaining daily quota.

File library tabs:

- `全部文件`
- `会话文件`
- `我上传的`
- `独立文件`

P0:

- Upload to current conversation.
- Upload standalone file where UI exposes file library.
- List visible files.
- Download after quota check.

P1:

- File detail drawer.
- Filter by conversation/uploader/type.
- Retry failed upload.

P2:

- Preview text/images when safe.
- Expiry/cleanup policy.
- Storage usage overview.

## 12. Quota And Retention UX

Quota should be visible in context:

- Top status: `今日还可传输 1.4 GiB`.
- File picker warning when a file exceeds remaining quota.
- Download confirmation only when useful, not for every normal file.
- Error message on rejection: `今日传输额度不足，无法上传/下载此文件。`

Retention should be visible without feeling like system policy:

- Conversation info: `此会话保留最近 10000 条消息`.
- Space info: `消息保留按会话设置`.
- Do not show retention cleanup internals to normal members.

## 13. Realtime Product Behavior

Realtime updates should feel natural:

- New messages append without page refresh.
- New conversations appear in the list when the user gains access.
- Group membership changes update the member drawer.
- File upload status changes from uploading to available/failed.
- Quota rejection appears as a local notice, not a chat message unless it affects
  other members.
- Reconnect should use last seen event sequence and fall back to refetch.

Member-visible event examples:

- `Alice 加入了群聊`
- `Bob 离开了群聊`
- `report.pdf 已上传`
- `文件上传失败，请重试`

Hidden/internal event examples:

- Audit row created.
- Transfer ledger reserved.
- OAuth provider callback details.
- Event sequence numbers.

## 14. AI Bot Compatibility

The product surface should allow bots later without redesigning chat:

- Bots appear as members with a clear bot identity.
- Bot messages render as `kind: "bot"`.
- Mentioning a bot can trigger a response when policy allows.
- Bot file access is explicit and visible when it reaches file content.
- Bot operations that read file content or create summaries write operation
  records.

No bot execution is required in the first Workspace loop. The IM UI should only
avoid blocking future bot member display and bot-authored message rendering.

## 15. Productization Priorities

P0 for the next development loop:

- Login-only Workspace entry; no invite fields on the public login page.
- Conversation list with direct/group distinction and useful previews.
- Direct conversation creation through member picker.
- Group creation with member selection.
- Conversation details drawer with members/files/info.
- Member directory sourced from backend data.
- Structured message sending and rendering.
- File upload/download with quota-aware states.
- Privileged invite creation under settings or member-management surfaces.
- Responsive desktop/mobile layout matching the information architecture doc.

P1:

- Search/filter for conversations, members, and files.
- Group settings polish around rename, leave, and local pin/mute.
- Replies and reactions.
- File detail drawer and retry.
- Richer unread counts and mention badges.

P2:

- Message edit/delete.
- Rich previews.
- Bot execution.
- Advanced group policy.
- Export/backup.
- Search backed by server indexes.

## 16. Acceptance Checklist

- Regular member can complete common chat/file tasks without opening settings.
- Owner/admin controls are discoverable but not mixed into daily chat content.
- Group chat has a dedicated details/configuration surface.
- Member list is useful for starting direct chats and understanding group
  membership.
- File library and chat attachments share the same attachment model.
- Quota and retention are explained with user-facing language.
- Operation records and platform internals stay hidden from normal members.
- The UI hierarchy has at least two levels beyond the lane entry: conversation
  list and conversation details/context.
- Mobile layout uses navigation or sheets instead of shrinking three desktop
  columns into an unusable page.

## 17. Contact-Scoped Discovery

- The member view is a contact directory for non-owners, not a list of every
  account in the space.
- A new member initially sees only their own directory entry. The owner can
  establish the first direct conversation or grant specific contacts.
- After a direct conversation exists, both participants remain automatic
  contacts. An owner grant can be removed without removing automatic contacts.
- Non-owners see the highest role label as 管理员, including for the actual
  space owner.
- Group participants remain visible in group details without being promoted
  into the contact directory.
