# Workspace Screen And Component Specification

## 1. Purpose

This document turns the Workspace product design into screen-level and
component-level requirements. It is intended for the development loop that makes
the shared-space UI feel like a productized IM surface instead of a flat feature
page.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The design principle is:

> Rich hierarchy should reduce effort, not add ceremony.

Common actions should remain one or two steps away. Less frequent controls
should be discoverable in the correct context, not permanently visible.

Responsive pane behavior, keyboard focus, screen-reader semantics, and visual
accessibility checks are defined in
[Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md).
Visual hierarchy, component density, icon choices, and anti-pattern checks are
defined in [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md).

## 2. Screen Inventory

P0 Workspace has these screens and panels:

| Surface | Form factor | Purpose |
| --- | --- | --- |
| Public login | full page | GitHub login only. |
| Shared-space shell | desktop shell / mobile root | Hosts chat, files, members, and space info. |
| Conversation list | rail / mobile screen | Browse and start conversations. |
| Active conversation | center view / mobile screen | Read/send messages and files. |
| Conversation details | drawer / sheet | Current direct or group context. |
| Direct member picker | modal / sheet | Start a direct chat. |
| Group creation | modal / sheet | Name group and select members. |
| File library | primary view | Browse, upload, and download visible files. |
| File detail | drawer / sheet | Inspect one file and download/remove if allowed. |
| Member directory | primary view | Find members and start direct chat. |
| Space information | primary view | Show own role, quota, history, and trust copy. |
| Space settings | grouped settings view | Invite and permission controls for permitted users. |

Operation records are not a screen in P0. They remain database-only.

## 3. Public Login Screen

Goal:

- Let a visitor enter through GitHub or understand why they cannot enter.
- Keep invite creation and member management out of public view.

Visible components:

- Product label: `共享空间`.
- One short sentence: `和熟人或小组长期共享聊天与文件。`
- Primary button: `使用 GitHub 登录`.
- Small access note: `需要已有成员邀请后才能进入。`
- Optional secondary action: return to lane choice.

Hidden components:

- Invite creation.
- Invite code input as a primary form.
- Member list.
- Space capacity details.
- Role or permission tables.
- Operation records.
- OAuth provider payloads and request IDs.

States:

| State | Layout |
| --- | --- |
| Needs login | Show only GitHub login and access note. |
| Disabled | Replace login button with disabled copy and lane-choice return. |
| OAuth pending | Keep the same layout and show a compact loading indicator. |
| Not invited | Show safe access copy and retry login. |
| Invite invalid | Show contact-space-member copy. |

Acceptance:

- There is no public registration-feeling workflow.
- A user cannot create or accept an invite without GitHub identity being known
  by the backend.

## 4. Desktop Shell

Desktop shell uses three stable zones:

```text
+----------------------+--------------------------------+--------------------+
| Navigation rail      | Active work surface            | Context drawer     |
|                      |                                |                    |
| Space identity       | Chat / files / members / space | Current details    |
| Primary navigation   |                                |                    |
| Conversation list    |                                |                    |
| Sync and quota hint  |                                |                    |
+----------------------+--------------------------------+--------------------+
```

Zone rules:

- The rail is persistent on desktop.
- The center view owns the user's current task.
- The drawer is contextual and can close.
- A user can send a message without opening the drawer.
- A user can browse files or members without losing the ability to return to
  the active conversation.

Recommended dimensions:

- Rail: `280-340px`.
- Center: flexible, minimum `420px`.
- Drawer: `320-380px`.
- Below medium width, collapse the drawer before shrinking chat below usable
  width.

## 5. Mobile Shell

Mobile uses separate screens, not squeezed desktop columns.

Primary navigation:

- `聊天`
- `文件`
- `成员`
- `空间`

Mobile rules:

- Show one primary task per viewport.
- Conversation list opens conversation screen.
- Details open as a sheet or full-screen subpage.
- Member picker and group creation are sheets.
- Composer stays anchored to the chat screen.
- Back from chat returns to conversation list.
- Back from details returns to chat, not to the lane choice page.

Minimum mobile acceptance:

- A user can select a conversation, send a message, open group details, and
  return without losing message draft state.
- File and member screens are independently reachable from primary navigation.

## 6. Navigation Rail

Components:

- Space identity block.
- Current user compact identity.
- Remaining daily transfer quota.
- Primary tabs.
- Conversation search or search button.
- Create menu.
- Conversation sections.
- Realtime status footer.

Create menu:

- `发起私聊`
- `创建群聊`, shown only when permitted.

Do not:

- Mount direct-chat form in the rail by default.
- Mount group-creation form in the rail by default.
- Show invite creation in the rail unless it is inside a space/member settings
  action.

Conversation list sections:

| Section | P0 behavior |
| --- | --- |
| `最近` | All joined conversations sorted by latest activity. |
| `置顶` | Reserved for P1. |
| `未读` | Reserved for P1, can be represented by badges later. |

## 7. Conversation Row

Each row must be scannable.

Required content:

- Avatar, initials, or type icon.
- Display title.
- Type chip: `私聊` or `群聊`.
- Member count for groups.
- Latest `plainText` preview.
- Latest activity time.
- Unread badge, when implemented.
- Local pending/failure indicator, when needed.

Interaction:

- Click selects the conversation.
- Mobile click navigates to chat screen.
- If the drawer is open, it updates to the selected conversation.
- If the current user loses access, the row disappears or enters an access-lost
  state depending on event payload.

Preview rules:

- Use server `plainText`.
- Unknown message block types must not leak raw JSON.
- File-only messages use file-friendly preview, such as `发送了文件 demo.pdf`.
- System messages use concise natural copy.

## 8. Active Conversation Screen

The chat screen has three stable zones:

- Header.
- Message history.
- Composer.

Header components:

- Title.
- Type/member count.
- Trust copy: `共享空间保存消息和文件`.
- Details button.
- More menu reserved for P1 controls.

Message history components:

- Loading older messages affordance.
- Date separators.
- Author grouping.
- User, bot, and system message styles.
- Reply preview.
- File cards.
- Pending and failed local message states.

Composer components:

- Multiline text input.
- Send button.
- File button.
- Mention tool where supported.
- Emoji/emote tool where supported.
- Reply preview bar with cancel.
- Attachment staging area.

No-conversation state:

- Show a focused empty state and allowed actions.
- Do not show a disabled composer as the main visual object.

Empty conversation state:

- Show `还没有消息。`
- Keep composer available if the current user can send.

Access-lost state:

- Hide or disable composer.
- Show `你已不在此群聊中。`
- Provide action back to conversation list.

## 9. Message Components

Message row requirements:

- Sender identity is clear in group chats.
- Consecutive messages by the same sender can be visually grouped.
- Timestamp is available without dominating the row.
- Bot messages use bot identity.
- System messages are quiet and not styled like human bubbles.
- Reply preview shows the referenced sender and text fallback.
- Unknown content blocks fall back to `plainText`.

P0 message actions:

- Reply.
- Retry failed local send where local state exists.

Reserved actions:

- Reaction.
- Copy link.
- Edit.
- Delete.
- Forward.

Safety:

- Never render raw HTML from message blocks.
- Links open with safe external-link behavior.
- Attachment download always goes through backend checks.

## 10. Conversation Details Drawer

The drawer reflects the selected conversation.

Direct chat tabs:

- `概览`
- `文件`

Direct overview:

- Other member identity.
- Role label as secondary information.
- Retention copy.
- Trust copy.

Group chat tabs:

- `概览`
- `成员`
- `文件`
- `设置`, shown when useful and permissioned.

Group overview:

- Group name.
- Member count.
- Created time or creator where useful.
- Retention copy: `保留最近 10000 条消息`.

Group members:

- Search or filter, client-side in P0 if list is small.
- Member rows with avatar, display name, role label.
- `添加成员` for owner/admin.
- Row remove action for owner/admin with confirmation.

Group files:

- Files visible in this conversation.
- Download action.
- Quota warning if file exceeds remaining daily transfer amount.

Group settings:

- Rename group where implemented.
- Leave group where implemented.
- Destructive actions require confirmation.

Drawer behavior:

- It never blocks reading or sending messages unless a modal confirmation is
  active.
- It closes on medium/mobile layouts and becomes a sheet/subpage.
- It should not duplicate full space settings.

## 11. Direct Member Picker

Entry points:

- Rail create menu.
- Member directory row.

Components:

- Search input.
- Member list.
- Empty state.
- Cancel action.

Member row:

- Avatar or initials.
- Display name.
- GitHub login.
- Role label.

Rules:

- Exclude current user.
- Exclude inactive or inaccessible members.
- Reuse existing direct conversation silently.
- The picker closes after success and the conversation opens.

Empty copy:

- `还没有可发起私聊的成员。`

## 12. Group Creation Modal

Entry points:

- Create menu.
- Space quick action for owner/admin when no conversation exists.

Components:

- Group name input.
- Member picker.
- Selected member count.
- Selected member chips or compact list.
- Primary action: `创建群聊`.
- Secondary action: `取消`.

Rules:

- Creator is included automatically.
- At least one member besides the creator must be selected before submission.
- Regular members do not see the action in P0.
- Validation is inline and friendly.
- The primary action is disabled until the group name is non-empty and at least
  one member is selected.
- The modal closes after successful creation.
- The new group opens immediately.

Validation copy:

| Situation | Copy |
| --- | --- |
| Missing name | `请输入群聊名称。` |
| No selected member | `请选择至少一位群聊成员。` |
| Invalid member | `部分成员无法加入此群聊。` |
| No permission | `你当前不能创建群聊。` |
| Failure | `群聊创建失败，请重试。` |

## 13. File Library Screen

The file library is a primary view.

Top area:

- Remaining daily transfer amount.
- Upload button.
- Filters:
  - `全部`
  - `会话文件`
  - `独立文件`
  - `我上传的`
- Search, P1 or client-side P0.

File row/card:

- File icon.
- File name.
- Size.
- Uploader.
- Upload time.
- Scope: `空间` or `会话`.
- Related conversation when applicable.
- Status.
- Download action.

Interaction:

- Click row opens file detail drawer/sheet when implemented.
- Download checks backend quota and visibility.
- Upload uses the same reserve/content/complete flow as chat attachments.

Empty copy:

- `还没有文件。`
- Filter empty: `没有找到匹配的文件。`

## 14. File Detail Drawer

P0 may keep this simple, but the component contract should be reserved.

Visible fields:

- File name.
- Size.
- Type.
- Uploader.
- Upload time.
- Visibility.
- Related conversation or standalone status.
- Status.
- Download action.
- Remove action only when policy allows.

Quota:

- If the file is larger than remaining daily transfer amount, show warning
  before the user clicks download.
- Backend rejection remains authoritative.

Hidden:

- Storage key.
- Filesystem path.
- Ledger rows.
- Request ID.
- IP address.
- User agent.

## 15. Member Directory Screen

The member directory is a daily-use surface, not an admin table.

Top area:

- Search input.
- Invite button only for permitted users.
- Optional count summary.

Member row/card:

- Avatar or initials.
- Display name.
- GitHub login.
- Friendly role label.
- Action: `发起私聊`.

Rules:

- Role changes are not inline in the normal directory.
- Group add/remove actions appear only in group management context.
- Debug identifiers are hidden from primary UI.
- Bot members later appear with clear bot identity.

Empty copy:

- `没有找到成员。`

## 16. Space Information Screen

Regular members see:

- Space name.
- Own identity.
- Own role label.
- Member count.
- Today's remaining transfer amount.
- Retention copy.
- Trust copy: `共享空间保存消息和文件。`

Owner/admin additions:

- Settings entry.
- Invite section or shortcut.
- Group creation shortcut only where it helps empty-state onboarding.

Do not show:

- Operation records.
- Raw platform logs.
- OAuth payloads.
- Transfer ledger rows.

## 17. Space Settings Screen

Settings are grouped by intent:

- `空间资料`
- `邀请成员`
- `成员权限`
- `群聊管理`
- `容量与历史`

P0 required behavior:

- Owner/admin can create member invites.
- Owner/admin can see and revoke active invites where backend supports it.
- Owner can change roles where backend supports it.
- Last-owner destructive changes are blocked.

Interaction rules:

- Confirm revoke invite.
- Confirm privilege escalation.
- Confirm admin/owner demotion.
- Use friendly copy, not permission codes.

Operation records:

- Not shown in P0.
- Later, if added, they must be a separate privileged settings section.

## 18. Component Reuse Rules

Reusable components should represent product objects:

| Component | Used in |
| --- | --- |
| Member row | Member directory, member picker, group details. |
| Conversation row | Rail, recent conversations, search result. |
| File row/card | Chat, file library, details drawer. |
| Quota hint | Rail, file library, upload/download flows. |
| Empty state | Chat, files, members, space home. |
| Local notice | Quota rejection, upload failure, reconnect. |

Do not create separate visual languages for the same object in different
surfaces unless the context needs a compact variant.

## 19. Complexity Control

The UI should stay easy even when capability grows.

Rules:

- A primary screen should have one main job.
- Forms should appear only after the user asks for that task.
- Settings should not be the default landing place.
- Group controls belong to group details.
- Space controls belong to space settings.
- Actor-only failures use local notices, not shared chat messages.
- Normal members should see outcomes, not internal policy names.

Anti-patterns:

- One screen showing conversations, group creation, invites, members, files,
  quota, and settings at the same time.
- A login page that looks like registration and invite management.
- A chat column that permanently contains admin controls.
- A file library that only exists as a tiny group detail sidebar.

## 20. P0 Acceptance Checklist

- Public login has one primary action: GitHub login.
- Desktop has rail, active surface, and contextual drawer.
- Mobile separates conversation list, chat, and details.
- Conversation rows show direct/group distinction, preview, and activity time.
- Direct chat starts from a member picker.
- Group creation is a modal/sheet.
- Group details contain overview, members, files, and settings.
- File library is a primary view.
- Member directory supports direct-chat discovery.
- Space information is useful to regular members.
- Space settings are available only to permitted users.
- Normal members do not see operation records, ledgers, request IDs, OAuth
  internals, or platform logs.
- The implementation can satisfy daily chat/file/member tasks without forcing
  users through settings.

## 21. Contact Directory And Composer Dock

Non-owner member screen:

- Heading: 可联系成员.
- Count suffix: 位联系人.
- No 主人 role filter.
- Owners are rendered as 管理员.

Owner visibility settings:

- Viewer selector.
- Contact checklist.
- Automatic direct contacts are checked and disabled.
- Explicit grants are editable and saved as one replacement set.

Chat surface:

- message-list is the only vertical scroll container.
- composer-dock contains both optional reply preview and the composer form.
- Opening emoji, mention, or reply UI must not change the chat column height.
