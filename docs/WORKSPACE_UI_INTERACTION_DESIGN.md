# Workspace UI Interaction Design

## 1. Purpose

This document defines the productized Workspace interaction model at the
component, window, and state level.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is a real IM-style shared-space product, not a flattened settings page.
Comprehensive capability does not mean complex operation. The interface should
keep common chat and file tasks fast, while putting less frequent or privileged
controls in the right contextual surfaces.

This document complements:

- [Workspace IM Product Design](WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace Core User Flow Design](WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
- [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)

## 2. Interaction Promise

Daily member tasks should stay short:

| Task | Target path |
| --- | --- |
| Open recent chat | Enter shared space -> select conversation. |
| Start direct chat | Members or create menu -> pick member -> chat opens. |
| Create group | Create menu -> group name and members -> chat opens. |
| Send file in chat | Conversation -> file button -> upload -> file card appears. |
| Find a file | Files tab -> filter/search -> file detail or download. |
| Invite someone | Space tab -> invite section -> create/copy invite. |
| Manage group members | Group chat -> details -> members tab. |

Rules:

- Do not make users visit settings for normal chat, file, or member lookup
  tasks.
- Do not show owner/admin controls in the public login view.
- Do not expose platform records, raw IDs, ledgers, event sequences, request
  IDs, or OAuth details in normal member flows.
- Use the same underlying data model for simple and advanced interactions, but
  present it through progressive disclosure.

## 3. UI Surfaces

Workspace has these visible product surfaces:

| Surface | Primary use | Member access | Owner/admin access |
| --- | --- | --- | --- |
| Public login | Enter with GitHub | GitHub login only | GitHub login only |
| Space shell | Shared-space navigation | yes | yes |
| Conversation list | Find/start chats | joined chats | joined chats plus group creation |
| Active conversation | Read/send messages and files | joined chats | joined chats |
| Context drawer | Current chat details | details, members, files | plus group controls |
| File library | Browse/download/upload files | visible files | visible files |
| Member directory | Find members and start direct chat | visible members | visible members |
| Space information | Own status, quota, history | yes | yes |
| Space settings | Invites, roles, policy groups | hidden or read-only summaries | yes, capability-based |
| Operation records | Internal accountability | no UI/API in first loop | database-only in first loop |

The same object may appear in multiple surfaces, but each surface has a clear
intent. For example, a file card appears in chat, the same file appears in the
file library, and its metadata appears in the file detail drawer.

## 4. Public Login

The public Workspace entry is intentionally simple.

Visible:

- Product label: `共享空间`
- Primary button: `使用 GitHub 登录`
- Short note: `需要已有成员邀请后才能进入。`

Hidden:

- Invite creation.
- Invite code input as a primary public form.
- Member list.
- Space settings.
- Operation records.
- Technical terms such as `Workspace`, `RBAC`, `audit`, `tenant`, or `relay`.

States:

| State | UI behavior |
| --- | --- |
| Feature disabled | Show disabled shared-space copy and return to lane choice. |
| Needs login | Show GitHub login only. |
| OAuth in progress | Show compact loading state. |
| Not invited | Show safe access copy and GitHub retry action. |
| Invite expired/revoked | Show contact-space-member copy. |

Invite codes may be carried by the OAuth flow or link query state, but the login
page should not become a registration console.

## 5. Desktop Shell

Desktop uses three zones:

```text
+--------------------+----------------------------------+----------------------+
| Navigation rail    | Active work surface              | Context drawer       |
|                    |                                  |                      |
| Space identity     | Conversation header              | Overview             |
| Primary tabs       | Message history / file/member UI | Members              |
| Conversation list  | Composer or active task          | Files                |
| Compact status     |                                  | Settings             |
+--------------------+----------------------------------+----------------------+
```

Recommended behavior:

- Left rail is persistent on desktop.
- Center panel owns the current task.
- Right drawer is contextual and collapsible.
- Settings are not permanently visible in the rail or chat body.
- The selected object controls the drawer content.

Recommended widths:

- Rail: `280-340px`.
- Active work surface: flexible, minimum `420px`.
- Drawer: `320-380px`, collapsible on medium widths.

The shell should avoid nested cards for the main layout. Repeated items such as
conversation rows, member cards, and file rows may use compact framed elements,
but page sections should stay unframed or use clear bands.

## 6. Mobile Shell

Mobile uses stacked navigation instead of squeezing three desktop zones into one
screen.

Primary mobile screens:

1. Conversation list / space home.
2. Active conversation.
3. Details sheet or full-screen details page.
4. File library.
5. Member directory.
6. Space information/settings.

Rules:

- Only one primary task is visible at a time.
- Bottom or top tab navigation can expose `聊天`, `文件`, `成员`, `空间`.
- Conversation details open as a sheet or subpage.
- Member picker and group creation open as sheets.
- The composer remains anchored to the active conversation screen.
- Back behavior returns to the previous product surface, not the browser landing
  page unless the user is leaving Workspace.

Mobile must not show the conversation list, active chat, and detail drawer
simultaneously.

## 7. Navigation Rail

Rail content:

- Space name and current identity.
- Remaining daily transfer quota in compact form.
- Primary tabs:
  - `聊天`
  - `文件`
  - `成员`
  - `空间`
- Conversation search.
- Create menu.
- Conversation list.
- Realtime status footer.

Create menu:

- `发起私聊` for roles that can create direct conversations.
- `创建群聊` for roles that can create groups.

Do not permanently mount direct-chat or group-creation forms above the list.
Those flows open as a modal or sheet so the list remains readable.

Conversation sections:

- `最近` in P0.
- `置顶` later.
- Optional local failure section later if pending messages need recovery.

Rail empty states:

| State | Copy |
| --- | --- |
| No conversations, member | `还没有会话。可以从成员列表发起私聊。` |
| No conversations, owner/admin | `还没有会话。可以创建群聊或从成员列表发起私聊。` |
| Search has no result | `没有找到会话。` |
| Reconnecting | `正在重新连接...` |

## 8. Conversation Rows

Each row should be scannable without exposing raw data.

Required row content:

- Avatar, initials, or type icon.
- Display title.
- Type label: `私聊` or `群聊`.
- Group member count.
- Latest message preview from server `plainText`.
- Latest activity time.
- Unread badge when implemented.
- Pending/failure indicator for local unsent messages when implemented.

Sorting:

1. Pinned conversations, later.
2. Unread conversations, later.
3. `lastActivityAt` descending.
4. `createdAt` descending.

Clicking a row:

- Selects the conversation.
- Opens the active conversation screen on mobile.
- Opens or updates the context drawer depending on local drawer state.
- Marks read through a lightweight read endpoint when implemented.

## 9. Active Conversation

The active conversation has three stable zones:

- Header.
- Message history.
- Composer.

Header:

- Conversation title.
- Type/member count.
- Trust copy: `共享空间保存消息和文件`.
- Details button.
- More menu later for pin, mute, leave, or group settings.

Message history:

- Date separators.
- Author grouping for consecutive messages.
- Author name/avatar in group chats.
- User, bot, and system message styles.
- Reply preview when present.
- File cards/chips.
- Pending and failed local states.

Empty conversation:

- Show a light start-chat copy and keep the composer available if the user can
  send.
- Do not show a disabled composer as the main empty state.

Access-lost state:

- Hide or disable the composer.
- Show: `你已不在此群聊中。`
- Keep a path back to the conversation list.

## 10. Context Drawer

The drawer is the place for current-object context, not a second settings page.

Direct chat drawer:

- Other member profile summary.
- Shared files in this direct chat.
- History retention copy.
- Future local preferences such as pin/mute.

Group chat drawer:

- `概览`: group name, member count, retention, trust copy.
- `成员`: member list and add/remove controls where permitted.
- `文件`: files shared in this group.
- `设置`: rename/leave/future archive controls where permitted.

Drawer rules:

- Regular members can inspect context but cannot see controls they cannot use.
- Owner/admin controls appear in the relevant tab, not as a global admin strip.
- Removing a group member requires confirmation.
- Renaming a group is a small form inside `设置`, not a separate page.
- Leave group is a deliberate action in `设置`, not a row-level accidental
  action.

## 11. Direct Chat Flow

Entry points:

- Rail create menu: `发起私聊`.
- Member directory row: `发起私聊`.

Interaction:

1. Open member picker.
2. Search/filter visible members.
3. Select one member.
4. Backend creates or reuses the direct conversation.
5. UI selects the returned conversation.

Picker rules:

- Exclude the current user.
- Exclude removed or inaccessible members.
- Show avatar/initial, display name, GitHub login, and role label.
- Existing direct conversations are reused silently.

Empty copy:

- `还没有可发起私聊的成员。`

## 12. Group Creation Flow

Entry point:

- Rail create menu: `创建群聊`.

Modal/sheet content:

- Group name input.
- Member picker with search.
- Selected member count.
- Primary action: `创建群聊`.
- Secondary action: `取消`.

Rules:

- Creator is included automatically.
- At least one member besides the creator must be selected before submission.
- Selected members must be active space members.
- Regular members do not see this action in P0.
- Validation appears inline and uses friendly copy.
- The primary action is disabled until the group name is non-empty and at least
  one member is selected.

Validation copy:

| Situation | Copy |
| --- | --- |
| Missing name | `请输入群聊名称。` |
| No selected member | `请选择至少一位群聊成员。` |
| No permission | `你当前不能创建群聊。` |
| Invalid member | `部分成员无法加入此群聊。` |
| Network/server failure | `群聊创建失败，请重试。` |

After success:

- Close the modal.
- Select the new group.
- Open the group details drawer if useful.

## 13. Composer

The composer should feel like a normal chat input. It must not expose message
protocol fields.

P0 controls:

- Multiline text input.
- Send button.
- File button.
- Reply preview and cancel action.
- Disabled state only when no conversation is selected or sending is not
  allowed.

Structured content behavior:

- Client converts entered text into structured blocks.
- URLs become safe `link` blocks.
- Mentions become `mention` blocks once mention picker exists.
- Uploaded files become `attachment` blocks.
- `plainText` is generated or verified by the server.

Keyboard:

- Enter sends when the input is single-line behavior or when product convention
  chooses send-on-enter.
- Shift+Enter inserts a newline when multiline is supported.
- Escape cancels reply or closes an open picker.

Attachment staging:

- If upload happens before message send, show a staging chip.
- Upload failure shows `文件上传失败，请重试。`
- Quota rejection shows `今日传输额度不足，无法上传此文件。`
- Staged attachments are removable before send.

## 14. Structured Message Rendering

Rendering must be safe and clear.

Block display:

| Block | Display |
| --- | --- |
| `text` | Escaped plain text. |
| `mention` | Member chip or highlighted inline mention. |
| `link` | External link with visible label/domain. |
| `emoji` | Emoji or supported emote. |
| `attachment` | File chip/card with metadata. |

Rules:

- Never render raw HTML from message content.
- Unknown blocks fall back to server `plainText`.
- Link clicks open a new tab/window with safe rel attributes.
- Attachment download always calls backend visibility and quota checks.
- Bot messages use a bot identity; system messages use quiet system styling.

Message actions:

- P0: reply.
- P1: reactions, copy link, retry failed send.
- P2: edit, delete, forward.

## 15. File Library

The file library is a primary Workspace view.

Top controls:

- Upload button.
- Filters:
  - `全部`
  - `会话文件`
  - `独立文件`
  - `我上传的`
- Search, client-side in P0 if backend search is not ready.

List row fields:

- File icon.
- File name.
- Size.
- Uploader.
- Upload time.
- Scope: space or conversation.
- Status.
- Download action.

File detail drawer/panel:

- File name.
- Size and type.
- Uploader.
- Visibility.
- Related conversation when applicable.
- Status.
- Download button.
- Remove button only when policy allows.
- Quota warning when the file is larger than remaining daily quota.

Hidden:

- Storage key.
- Filesystem path.
- Transfer ledger rows.
- Request ID.
- IP address or user agent.

## 16. Upload And Download UX

Upload:

1. User chooses a file.
2. UI asks backend to reserve upload quota.
3. If rejected, show quota or permission copy before bytes transfer.
4. If accepted, upload content.
5. Complete upload.
6. File appears in chat or library.

Download:

1. User clicks download.
2. Backend checks visibility and quota before bytes are sent.
3. Download starts when allowed.
4. Rejection is shown as local notice.

Confirmation rules:

- No confirmation for normal upload/download when quota is sufficient.
- Confirm file removal.
- Warn before a known quota-impossible transfer, but still rely on backend.

## 17. Member Directory

The member directory is a daily-use discovery surface.

Top controls:

- Search input.
- Invite entry only for users who can invite.

Member row/card:

- Avatar or initials.
- Display name.
- GitHub login.
- Friendly role label.
- Action: `发起私聊` when allowed.

Role and removal controls:

- Role changes live in `空间 -> 成员权限`.
- Space member removal lives in privileged settings with confirmation.
- Group member add/remove lives in group details.

Normal directory views should not expose database IDs, raw provider payloads, or
operation details.

## 18. Space Information And Settings

The `空间` view has two layers.

Regular member layer:

- Current identity.
- Role label.
- Member count.
- Remaining daily transfer quota.
- History retention copy.
- Trust copy: `共享空间保存消息和文件。`

Privileged settings layer:

- `邀请成员`
- `成员权限`
- `群聊管理` if a separate aggregate view is later needed.
- `容量与历史`

Invite section:

- Create member invite.
- Copy invite link/code.
- Show active invites if backend returns them.
- Revoke invite where supported.

Permission section:

- Owner can change member/admin roles.
- Confirm owner/admin demotion or privilege escalation.
- Do not allow removing or demoting the last owner.

Operation records:

- Database-only in the first full Workspace loop.
- No normal member UI.
- Owner/admin operation-record UI is deferred and should become a separate
  settings section only if product need is confirmed.

## 19. Permission Disclosure

Use capability-based UI, but avoid making normal members feel managed.

Rules:

- Hide actions the member cannot use when the action is not relevant.
- Disable actions only when the disabled state teaches something useful.
- Use clear outcome copy: `你当前不能创建群聊。`
- Do not display raw permission names such as `conversation.member.manage`.
- Backend errors remain authoritative and user-safe.

Rejected sensitive operations:

- Write operation records in the database.
- Show a safe local notice.
- Do not leak resource existence unless the actor is allowed to know.

## 20. Realtime And Offline UX

Realtime state should be visible but quiet.

Status copy:

| State | Copy |
| --- | --- |
| Connecting | `正在连接...` |
| Connected | Optional synced indicator only. |
| Reconnecting | `正在重新连接...` |
| Sync required | `正在同步最新内容...` |
| Offline | `连接暂时不可用。` |

Projection behavior:

- New messages append to the active conversation.
- Conversation preview and ordering update.
- New accessible conversations appear in the list.
- Group member changes update the context drawer.
- File availability updates chat/file library rows.
- Transfer rejection shows a local notice, not a shared chat message.

Clients must not show raw event sequence numbers or debug payloads.

## 21. AI Bot Compatibility

No bot execution is required in the first loop, but the UI should avoid blocking
future bot members.

Reserved behavior:

- Bot members appear in the member directory with a clear bot identity.
- Bot messages render as bot-authored messages.
- Bot mentions use normal mention chips.
- Bot file-content access requires explicit future permission UI.
- Bot provider errors should not leak into normal chat.

The UI should never trust client-submitted bot or AI fields. Bot eligibility is
computed by the backend.

## 22. Empty, Loading, And Error States

Every primary surface needs a useful state model.

Loading:

- Use compact skeletons or inline loading copy.
- Avoid blocking the whole shell after the user is already inside unless session
  state is unknown.

Empty states:

- Chat: `还没有消息。`
- Files: `还没有文件。`
- Members: `没有找到成员。`
- Space: show own status even when no conversations/files exist.

Errors:

- Show user-safe copy near the failed action.
- Keep the rest of the shell usable when possible.
- Do not show stack traces, SQL errors, OAuth payloads, request IDs, or raw event
  data.

## 23. Accessibility And Keyboard

Baseline requirements:

- Buttons and interactive rows have visible focus states.
- Icon-only buttons have labels or tooltips.
- Modal/sheet focus is contained while open.
- Escape closes non-destructive popovers/sheets.
- Destructive confirmations require an explicit button.
- Color is not the only indicator for role, status, or failure.
- Text remains readable at mobile widths.

Keyboard shortcuts are optional in P0. Do not show shortcut training text until
the shortcuts are stable.

## 24. Complexity Control Rules

Use these rules when adding new Workspace features:

1. Daily actions stay in the daily surface.
2. Object-specific controls stay in the object's details.
3. Space-wide controls stay in the space settings.
4. Platform evidence stays in the database unless an owner/admin review product
   is explicitly added.
5. A new feature should add a new tab/sheet only when it has a distinct user
   intent.
6. Do not duplicate the same action in more than two places unless it is a core
   shortcut.
7. Avoid permanent forms in list surfaces.
8. Prefer local notices over shared system messages for actor-only failures.
9. Keep normal member copy concrete and friendly.
10. Keep implementation terminology out of normal UI.

## 25. P0 Implementation Checklist

The first productized Workspace loop should satisfy:

- Public Workspace entry shows only GitHub login.
- Login/not-invited/disabled states are distinct and user-safe.
- Desktop shell has rail, active work surface, and context drawer.
- Mobile shell separates list, chat, and details.
- Conversation list distinguishes direct and group chats.
- Direct chat uses a member picker and reuses existing conversations.
- Group creation uses a modal/sheet with name and member selection.
- Group details expose overview, members, files, and settings.
- Regular members do not see invite controls, role controls, operation records,
  ledgers, request IDs, OAuth internals, or platform logs.
- File library exists as a primary view.
- Chat file cards and standalone files use the same attachment model.
- Composer sends structured message content without exposing protocol fields.
- Realtime state is projected into chat/list/files/details.
- Quota failures are local notices.
- Destructive actions require confirmation.

## 26. Later Interaction Work

P1:

- Search conversations, files, and members with backend support.
- Mention picker and emoji picker.
- Unread counts and last-read markers.
- Reactions.
- Group rename polish and local pin/mute.
- File detail drawer with retry for failed uploads.

P2:

- Message edit/delete.
- Rich previews.
- Bot execution and bot access approval UI.
- Advanced group policies.
- Export/backup flows.
- Owner/admin operation-record review, if product need is confirmed.

## 27. Stable Chat Viewport Behavior

- The Workspace shell owns one 100dvh viewport and passes remaining height
  through the product grid and active chat column with min-height: 0.
- Only the message list scrolls. Header, conversation extras, and composer dock
  remain visible.
- Reply preview and the composer form are one dock/grid child, so opening a
  reply cannot create an implicit layout row or push the input off-screen.
- New messages auto-scroll only while the user is within 80 px of the bottom.
  Loading older messages or reading history does not force a jump to the latest
  message.
- Desktop and mobile layouts must keep the textarea and active reply preview
  inside the viewport for long conversations.
