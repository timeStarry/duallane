# Workspace Visual System Design

## 1. Purpose

This document defines the visual and component system for DualLane shared
spaces.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is a polished IM product surface that feels friendly to normal users
while still supporting professional controls. More hierarchy should make
Workspace easier to use, not more complicated.

This document complements:

- [Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md)

## 2. Visual Direction

Workspace should feel:

- Calm.
- Clear.
- Modern.
- Small-group friendly.
- Reliable without looking like an enterprise admin console.

Workspace should not feel:

- Like a marketing landing page after login.
- Like a dense compliance dashboard for regular members.
- Like every feature is equally important.
- Like a single-page form collection.

User-facing surfaces should prioritize:

- Conversations.
- Members.
- Files.
- Space status.

Privileged controls should be visually available but quiet:

- Invites.
- Group member management.
- Permissions.
- Capacity and history settings.

## 3. Layout Tokens

Desktop shell:

| Token | Recommended value |
| --- | --- |
| Rail width | `280-340px` |
| Center minimum | `420px` |
| Drawer width | `320-380px` |
| Shell gap | `0-12px`, depending on existing layout |
| Main surface radius | `0-8px` |
| Repeated item radius | `6-8px` |
| Touch target | `40px` minimum |

Mobile:

| Token | Recommended value |
| --- | --- |
| Breakpoint | around `760px` |
| Visible panes | one primary pane at a time |
| Bottom/top nav target | `44px` minimum |
| Composer minimum height | `48px` |
| Sheet max height | `85vh` |

Spacing:

- Use compact, repeated increments such as `4`, `8`, `12`, `16`, `24`.
- Lists should be dense enough for scanning.
- Settings groups can use more vertical space, but should not become card
  stacks inside card stacks.

## 4. Color System

Use a balanced palette rather than a one-hue theme.

Recommended roles:

| Role | Purpose |
| --- | --- |
| Neutral surface | Page background, shell background, list areas. |
| Elevated surface | Rows, modals, drawers. |
| Text primary | Message and title text. |
| Text secondary | Metadata, role labels, timestamps. |
| Border | Low-contrast separation. |
| Accent | Primary actions and active navigation. |
| Success | Completed transfer, copied invite. |
| Warning | Quota warning, reconnect. |
| Danger | Remove member, revoke invite, destructive confirmation. |

Rules:

- Avoid dominant purple/purple-blue gradients.
- Avoid beige/cream/sand as the dominant identity.
- Avoid making the entire app dark blue/slate.
- Use accent color sparingly for active state and primary action.
- Warning/danger colors must not be the only indicator; include text or icon.
- Do not use decorative orbs, bokeh blobs, or gradient decorations.

## 5. Typography

Principles:

- Chat and list text should scan quickly.
- Hero-scale type is not used inside Workspace after login.
- Compact panels use compact headings.
- Letter spacing stays `0`.
- Font size does not scale with viewport width.

Suggested sizes:

| Use | Size |
| --- | --- |
| Shell title | `16-18px` |
| Conversation title | `16-18px` |
| Row title | `14-15px` |
| Message text | `14-15px` |
| Metadata | `12-13px` |
| Button text | `13-14px` |

Text fitting rules:

- Long filenames and GitHub logins truncate with accessible full title where
  appropriate.
- Buttons should use icons for common actions and avoid long labels in tight
  areas.
- Message text wraps naturally and never overlaps file cards or metadata.

## 6. Iconography

Use `lucide-react` icons where available.

Recommended icons:

| Action/object | Icon direction |
| --- | --- |
| Chat | message icon |
| Files | file/folder icon |
| Members | users icon |
| Space | home/info icon |
| Settings | settings icon |
| Create | plus icon |
| Direct chat | user-plus or message-circle icon |
| Group chat | users icon |
| Upload | upload icon |
| Download | download icon |
| Details | panel/right/info icon |
| Search | search icon |
| Warning | triangle alert icon |
| Remove | trash/x icon |

Rules:

- Icon-only buttons need accessible labels and hover/focus tooltips when the
  meaning is not obvious.
- Do not manually draw SVG icons when an existing icon exists.
- Do not use rounded text pills where a common icon button would be clearer.

## 7. Component Patterns

### Navigation rail

The rail is for orientation and chat discovery.

Contains:

- Space identity.
- Viewer compact identity.
- Primary tabs.
- Quota hint.
- Create menu.
- Conversation list.
- Realtime status footer.

The rail should not contain:

- Permanent invite form.
- Permanent group creation form.
- Operation records.
- Transfer ledger.
- Role-management table.

### Conversation row

Row content:

- Avatar/type icon.
- Title.
- Type chip.
- Latest message preview.
- Activity time.
- Member count for groups.
- Unread/failure badge when implemented.

Interaction:

- Entire row selects conversation.
- Secondary actions appear on hover/menu, not as a row full of buttons.
- Active row is visibly selected.

### Chat header

Content:

- Title.
- Type/member count.
- Trust copy: `共享空间保存消息和文件`.
- Details icon button.
- More menu later.

The header should stay compact. It is not a settings page.

### Message list

Message rendering:

- Group consecutive messages by same author when close in time.
- Show author identity clearly in group chats.
- Use quiet system rows for membership/system events.
- Render file cards inline without breaking message flow.
- Pending/failed local states attach to the relevant row.

Safety:

- Never render raw HTML.
- Unknown blocks fall back to `plainText`.
- Bot messages have a distinct bot identity.

### Composer

Controls:

- Text input.
- Send icon/button.
- File upload icon.
- Reply preview.
- Attachment staging area.

Rules:

- Composer stays available in empty chats if the user can send.
- Disabled composer states explain the outcome.
- Protocol fields are never visible.
- Quota rejection appears as local notice or inline composer warning.

### Context drawer

Drawer content depends on selected object:

- Direct chat overview and files.
- Group overview, members, files, settings.
- File detail.

Rules:

- Drawer is contextual, not a second global settings page.
- It can collapse without losing chat state.
- On mobile, it becomes a sheet or full-screen details page.

### File row/card

Content:

- File icon.
- File name.
- Size.
- Uploader.
- Scope.
- Status.
- Download action.

Rules:

- Long names truncate but remain inspectable in detail.
- Quota warning appears only when useful.
- Storage keys and filesystem paths are hidden.

### Member row/card

Content:

- Avatar or initials.
- Display name.
- GitHub login.
- Friendly role label.
- Primary action: `发起私聊` where allowed.

Rules:

- Role changes do not appear inline in the normal directory.
- Group add/remove actions appear only in group-management context.
- Bot members later use a clear bot marker.

### Settings group

Settings are grouped by user intent:

- `空间资料`
- `邀请成员`
- `成员权限`
- `群聊管理`
- `容量与历史`

Rules:

- Use quiet group headings and concise controls.
- Confirm destructive or privilege-changing actions.
- Do not show operation records in P0.

## 8. State Components

Loading:

- Use skeleton rows for lists.
- Use compact inline loading for buttons and modals.
- Avoid full-shell blocking once the user is already inside Workspace unless
  session state is unknown.

Empty:

- Empty states include one useful next action when available.
- Empty states do not replace the actual daily surface with long explanation.

Examples:

| Surface | Empty copy |
| --- | --- |
| Chat list | `还没有会话。可以从成员列表发起私聊。` |
| Chat | `还没有消息。` |
| Files | `还没有文件。` |
| Members | `没有找到成员。` |

Errors:

- Show user-safe copy near the failed action.
- Keep unaffected surfaces usable.
- Do not show stack traces, SQL errors, OAuth payloads, request IDs, or raw
  event data.

Local notices:

- Use for copied invite, quota rejection, upload failure, reconnect, and save
  results.
- Notices should be short and dismissible.
- Actor-only failures should not become chat messages.

## 9. Interaction Density

Daily surfaces should be efficient:

- One click to open a recent conversation.
- Two actions to start direct chat: open picker, choose member.
- One focused modal/sheet to create group.
- One click to open file detail from file library.
- One click to download when quota is sufficient.

Do not add confirmation for:

- Normal send.
- Normal upload when quota is sufficient.
- Normal download when quota is sufficient.
- Opening details.

Require confirmation for:

- Removing a group member.
- Revoking an invite.
- Role escalation or demotion.
- Removing files.
- Leaving or archiving group when implemented.

## 10. Responsive Behavior

Desktop:

- Show rail, active surface, and drawer when space allows.
- Collapse drawer before making chat unusable.
- Keep composer anchored.

Tablet:

- Rail can narrow.
- Drawer can become overlay.
- Active chat should remain the priority.

Mobile:

- Show one primary pane at a time.
- Use bottom/top tabs for `聊天`, `文件`, `成员`, `空间`.
- Details use sheet or subpage.
- Member picker and group creation use sheets.
- Back behavior returns to previous Workspace surface.

## 11. Accessibility

Baseline:

- Interactive rows are keyboard reachable.
- Buttons have visible focus state.
- Icon-only buttons have labels.
- Modals/sheets trap focus while open.
- Escape closes non-destructive overlays.
- Destructive confirmations require explicit action.
- Color is not the only status indicator.
- Text has sufficient contrast.
- Mobile targets are at least `40-44px`.

Screen-reader naming:

- Navigation tabs identify current page.
- Conversation rows announce title, type, unread/pending state where available.
- File rows announce name, size, status, and action.
- Quota warnings are announced as status text.

## 12. Anti-Patterns

Reject these designs during review:

- Login page includes invite creation or member management.
- One page permanently shows chat, members, files, invites, quota, group forms,
  and settings at the same level.
- Group controls are always visible in the chat column.
- Normal member directory looks like a database table.
- File library exists only as a small sidebar.
- Operation records appear in normal member navigation.
- Quota/ledger internals are displayed instead of friendly capacity copy.
- Main layout uses nested cards inside cards.
- Decorative gradients/orbs dominate the actual product surface.

## 13. Implementation Checklist

- Primary post-login surfaces are `聊天`, `文件`, `成员`, `空间`.
- Desktop has rail, active surface, and contextual drawer.
- Mobile has separate panes/screens for list, chat, details, files, members,
  and space.
- Every repeated product object has a reusable compact component.
- Common actions use icons with accessible labels.
- Normal member screens hide platform internals.
- Owner/admin controls are grouped by intent.
- Empty/loading/error states are implemented for every primary surface.
- Text fits on mobile and desktop.
- UI copy uses `共享空间` or `空间`, not internal `Workspace`, in normal
  product surfaces.
