# Workspace Information Architecture

## 1. Purpose

This document defines the Workspace information hierarchy, layout, and window
model. It exists because shared spaces have enough product surface that a flat
page cannot stay usable.

Component-level interaction rules for these surfaces live in
[Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md).

The design goal is not to add friction. The goal is to put each action in the
place where users naturally look for it:

- Chat actions stay in the chat.
- Conversation context stays near the current conversation.
- Space-level controls stay in space settings.
- Platform records stay in the database unless a privileged UI is deliberately
  added later.

## 2. Hierarchy Model

Workspace uses four levels:

| Level | Scope | Examples | Normal member visibility |
| --- | --- | --- | --- |
| Lane | Product mode | 私密直连, 共享空间 | yes |
| Space | Shared place | 默认空间, members, quota, files | yes |
| Conversation | Chat room | 私聊, 群聊, messages, conversation files | joined conversations only |
| Context | Focused panel | group details, member picker, file details, invite creation | permission-dependent |

This means a regular member does not need to see every feature at once. The UI
should reveal context when the user selects a conversation, opens details, or
enters settings.

## 3. Desktop Layout

Use a three-zone shell on desktop:

```text
+------------------+-------------------------------+----------------------+
| Space rail/list  | Active conversation            | Context drawer       |
|                  |                               |                      |
| Space header     | Conversation header            | Details / Files      |
| Chat/File tabs   | Message history                | Members / Settings   |
| Conversation     | Composer                       |                      |
| list             |                               |                      |
+------------------+-------------------------------+----------------------+
```

Recommended widths:

- Left rail: `280-340px`.
- Center conversation: flexible, minimum `420px`.
- Right context drawer: `320-380px`, collapsible.

Desktop zones:

- **Left rail:** space identity, navigation tabs, conversation list, create menu.
- **Center:** selected conversation and composer.
- **Right drawer:** selected conversation details, files, members, or settings.

The right drawer is contextual. It should not permanently show every space
feature. When no conversation is selected, it can show space info or remain
closed.

## 4. Mobile Layout

Mobile should use a stacked navigation model:

1. Space home / conversation list.
2. Conversation screen.
3. Details sheet or full-screen subpage.

Mobile rules:

- Do not squeeze left rail, chat, and right drawer into one viewport.
- Conversation list and active chat are separate views.
- Conversation details open as a bottom sheet or full-screen panel.
- Member picker opens as a searchable sheet.
- File upload progress stays attached to the composer or file sheet.
- Space settings are a separate screen for privileged users.

Minimum mobile tabs:

- `聊天`
- `文件`
- `成员`
- `空间`

Privileged mobile entry:

- `空间` screen includes `空间设置` when permitted.

## 5. Navigation

Primary navigation:

- `聊天`
- `文件`
- `成员`
- `空间`

Privileged navigation:

- `空间设置`

Conversation-level tabs inside details:

- `概览`
- `成员`
- `文件`
- `设置` when allowed

The same concept should not appear in multiple primary locations. For example,
invite creation belongs under `空间设置` or a member-management action, not on
the login page and not inside the normal chat composer.

## 6. Window And Panel Types

Use predictable UI containers:

| Container | Use for | Examples |
| --- | --- | --- |
| Persistent rail | Main navigation and lists | conversation list, space tabs |
| Active view | Primary work | chat, file library, member directory |
| Context drawer | Details for current object | group details, file details |
| Modal | Short blocking decision | create group, confirm removal |
| Sheet | Mobile contextual task | member picker, file detail |
| Popover/menu | Small option sets | create menu, message more menu |
| Toast/inline notice | Non-blocking result | upload failed, copied invite |

Avoid:

- Cards inside cards for main layout.
- All settings visible at once.
- Admin strips inside normal member content.
- Long explanatory copy replacing actual controls.

## 7. Space Home

The Workspace home state appears after login when no conversation is selected or
on narrow screens before a chat is opened.

Content:

- Space name.
- Current user identity.
- Today's remaining transfer quota.
- History retention copy.
- Quick actions:
  - `发起私聊`
  - `创建群聊` if permitted
  - `上传文件` if file library supports standalone upload
- Recent conversations.
- Recent visible files.

Do not include operation records in the member home state.

## 8. Conversation List Rail

The rail contains:

- Space switch/header, even if only one space exists in MVP.
- Navigation tabs.
- Search input or search button.
- Create menu.
- Conversation sections.
- Compact status footer for sync/reconnect state.

Create menu:

- `发起私聊`
- `创建群聊` when permitted

The create group form should not be permanently mounted above the list. It opens
as a modal/sheet so the list remains readable.

## 9. Active Conversation View

Header:

- Title.
- Type/member count.
- Trust copy: `共享空间保存消息和文件`.
- Details button.
- More menu.

Body:

- Message history.
- Date separators.
- System event rows.
- File cards.
- Loading older messages affordance.

Composer:

- Text input.
- Send button.
- File button.
- Optional emoji/mention tools.
- Upload progress and errors.

When no conversation is selected:

- Show an empty state with actions based on permission.
- Do not show a disabled composer.

## 10. Conversation Context Drawer

The drawer changes with the active conversation.

Direct conversation drawer:

- Other member profile.
- Shared files in this conversation.
- History retention copy.
- Leave/delete controls only when policy supports them.

Group conversation drawer:

- Group overview.
- Member list.
- Shared files.
- Group settings for owner/admin.

Drawer behavior:

- Collapsed by default on medium screens.
- Open when user clicks details.
- Remember local open/closed state if it improves continuity.
- Never block message sending unless a modal confirmation is active.

## 11. File Library

File library is a primary view, not just a side list.

Top-level filters:

- `全部`
- `会话文件`
- `独立文件`
- `我上传的`

Row/card fields:

- File icon.
- File name.
- Size.
- Uploader.
- Visibility.
- Related conversation where applicable.
- Status.
- Download action.

File detail drawer:

- Metadata.
- Visibility.
- Related messages/conversation when available.
- Download button.
- Quota warning if not enough daily transfer quota remains.

P0 can implement a simpler list, but it should still reserve this hierarchy.

## 12. Member Directory

Member directory is a primary view.

Top controls:

- Search.
- Role/type filter later.
- Invite button only for users who can invite.

Member row:

- Avatar.
- Display name.
- GitHub login.
- Friendly role label.
- Action menu:
  - `发起私聊`
  - `添加到群聊` only in group-management context
  - role/settings actions only for owner/admin in settings

The directory should not expose audit details, login provider internals, or
database IDs as primary information.

## 13. Space Settings

Space settings are grouped by intent:

- `空间资料`: name and basic display.
- `邀请成员`: create/revoke invite codes.
- `成员权限`: role management.
- `群聊管理`: manage groups and membership.
- `容量与历史`: quota and retention copy/settings when editable.

Operation records:

- Database-only in the first full Workspace loop.
- No normal member UI.
- Owner/admin operation-record UI is deferred and should be a separate settings
  section later, not mixed into daily chat.

## 14. Login And Invite Entry

Workspace login page:

- Shows only `使用 GitHub 登录`.
- Does not show invite code input.
- Does not show invite creation.
- May show concise copy: `需要已有成员邀请后才能进入。`

Invite flow:

- Authorized member creates an invite code/link inside Workspace.
- The invite link starts GitHub login with the invite code attached.
- Backend validates the invite after OAuth identity is known.
- If accepted, user enters the space.
- If rejected, show a safe not-invited/expired state.

This keeps public entry simple and prevents the login page from looking like a
registration console.

## 15. State Model

Workspace shell states:

- `disabled`: feature flag off.
- `loading`: bootstrap in progress.
- `needs_login`: no valid session.
- `not_invited`: OAuth succeeded but no accepted invite or owner match.
- `ready`: member has entered the space.
- `offline/reconnecting`: realtime disconnected but HTTP may still work.
- `error`: user-safe fallback.

Conversation states:

- `empty`: no messages yet.
- `loading_history`: fetching retained messages.
- `ready`: message list loaded.
- `sending`: optimistic local message exists.
- `send_failed`: local retry affordance.
- `removed`: current user lost access.

File states:

- `reserved`.
- `uploading`.
- `available`.
- `failed`.
- `removed`.
- `quota_rejected`.

## 16. Information Disclosure Rules

Show to regular members:

- Their conversations.
- Visible members.
- Visible files.
- Their remaining daily transfer quota.
- Friendly retention copy.
- Permission-denied messages that explain the action, not internals.

Hide from regular members:

- Audit logs.
- Raw operation records.
- OAuth errors and provider details.
- Transfer ledger rows.
- IP addresses and user agents.
- Request IDs unless support/debug mode is explicitly added later.
- Internal event sequences.

Show to owner/admin:

- Invite and group-management controls.
- Member role controls based on permission.
- Space policy summaries.

Still hidden in first loop:

- Operation record UI/API.
- Platform logs.

## 17. P0 Layout Requirements

The next Workspace development loop should at minimum deliver:

- A login-only Workspace entry page.
- A non-flat shell with conversation list, active chat, and context surface.
- A member picker for direct/group creation.
- A conversation details drawer or equivalent.
- A member directory view.
- A file library view or a clearly separated file drawer.
- Privileged invite creation outside public login.
- Mobile navigation that separates list, chat, and details.

P0 can keep some advanced controls disabled or reserved, but it should not
continue with a single page where every function is permanently visible.

## 18. Acceptance Checklist

- A new user understands the difference between chat, files, members, and space
  settings.
- The primary chat path is one or two actions deep, not buried in settings.
- Invite creation is not visible before login.
- Group configuration lives in a group details/settings surface.
- Member directory supports direct-chat discovery.
- File library is navigable without opening every chat.
- Desktop and mobile have explicit, different layout models.
- Normal members cannot see platform internals.
- Owner/admin controls are discoverable without making the product feel like an
  admin console.
