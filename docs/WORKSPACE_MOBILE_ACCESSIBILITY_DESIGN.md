# Workspace Mobile And Accessibility Design

## 1. Purpose

This document defines responsive behavior, mobile navigation, keyboard access,
and accessibility expectations for Workspace.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

Workspace has enough product surface that responsive design must be deliberate.
Mobile should not be a compressed desktop dashboard. Accessibility should be a
baseline engineering constraint, not a polish pass at the end.

## 2. Product Principle

> 信息层级用来减少认知负担，而不是增加操作步骤。

Desktop can show rail, chat, and context together. Mobile should show one
primary task at a time with clear transitions.

## 3. Breakpoint Model

Recommended layout bands:

| Width | Layout |
| --- | --- |
| `<= 760px` | Mobile stacked screens. |
| `761px - 1100px` | Tablet/medium: rail plus active view, context drawer collapses. |
| `> 1100px` | Desktop three-zone shell. |

Rules:

- Do not shrink the chat column below usable width to preserve three columns.
- Collapse the context drawer before making the composer cramped.
- On mobile, show only one primary pane at a time.
- Keep stable dimensions for toolbars, buttons, message composer, and file rows
  so dynamic content does not shift the layout unexpectedly.

## 4. Mobile Navigation Model

Primary mobile panes:

| Pane | Purpose |
| --- | --- |
| `list` | Conversation list and chat navigation. |
| `main` | Active chat, file library, member directory, or space view. |
| `details` | Conversation details or file detail. |

Primary tabs:

- `聊天`
- `文件`
- `成员`
- `空间`

Navigation rules:

- Opening Workspace on mobile starts at conversation list unless a specific
  conversation is deep-linked.
- Selecting a conversation opens active chat.
- Back from chat returns to conversation list.
- Details button opens details pane.
- Back from details returns to chat.
- File/member/space tabs open their own main views.
- Modals such as member picker and group creation open as sheets.

The browser back button should follow the same mental model where feasible, but
the product must still provide visible back controls.

## 5. Mobile Chat Screen

Header:

- Back to conversation list.
- Conversation title.
- Compact type/member count.
- Details button.

Body:

- Message history fills available height.
- Date separators and sender names remain readable.
- Pending and failed states remain visible.

Composer:

- Anchored to bottom of chat screen.
- File button and send button remain reachable.
- Multiline input grows only within a controlled max height.
- Keyboard opening must not hide the active input or send button.

Rules:

- Details drawer is not shown beside chat on mobile.
- Chat draft should survive opening details and returning.
- Empty chat keeps composer available when user can send.

## 6. Mobile Details

Conversation details as sheet or full-screen pane:

- Header with back/close.
- Tabs:
  - `概览`
  - `成员`
  - `文件`
  - `设置` when permitted.

Rules:

- Details should not reset scroll position in chat unless necessary.
- Add/remove member flows open nested sheets with clear back/cancel.
- Destructive confirmations appear as modal/sheet above details.
- Regular members see context only; hidden admin controls should not leave empty
  dead sections.

## 7. Mobile Files And Members

File library:

- Top quota hint.
- Upload button if allowed.
- Compact filters.
- File rows with download action.
- File detail opens as details pane/sheet.

Member directory:

- Search.
- Member rows.
- `发起私聊` action.
- Invite action only for permitted members.

Rules:

- Search should not obscure the entire screen once results appear.
- Long file names and member names wrap or truncate predictably.
- Download quota rejection appears inline or as local notice.

## 8. Mobile Space And Settings

Regular member:

- Space name.
- Own identity and role.
- Member count.
- Quota and history copy.
- Links to files/members where useful.

Owner/admin:

- Settings section list.
- Invite creation/copy.
- Privileged actions as section details.

Rules:

- Do not show all settings groups expanded on a small screen.
- One settings task per screen or sheet.
- Confirm destructive actions with object names.

## 9. Keyboard And Focus

Baseline:

- All buttons and interactive rows are keyboard reachable.
- Focus order follows visual order.
- Icon-only buttons have accessible names.
- Modals and sheets trap focus while open.
- Escape closes non-destructive dialogs, popovers, and pickers.
- Destructive confirmations require explicit action.
- After a modal closes, focus returns to the invoking control or a logical next
  target.

Chat-specific:

- Composer can be focused by normal tab order.
- Send button is reachable.
- Attachment button is reachable.
- Enter/Shift+Enter behavior should be consistent and documented in code, but
  not over-explained in UI.

## 10. Screen Reader Semantics

Recommended semantics:

- Navigation tabs use tab/list or button semantics consistently.
- Conversation rows are buttons or links with clear labels.
- Message list uses a readable feed/list structure.
- New local notices use polite live regions.
- Error notices use accessible text, not color alone.
- File download buttons include file name in accessible label.
- Avatar-only identity needs text alternative.

Example accessible labels:

- `打开群聊 Design Review，3 位成员`
- `下载文件 demo.pdf，120 KB`
- `打开会话详情`
- `返回会话列表`

Do not include request IDs or raw internal identifiers in accessible labels.

## 11. Visual Accessibility

Requirements:

- Text remains readable on mobile widths.
- Buttons have visible focus and pressed/disabled states.
- Color is not the only indicator for role, status, failure, or unread.
- Long words, file names, and GitHub logins do not overflow containers.
- Touch targets should be large enough for mobile use.
- Avoid dense nested cards and tiny admin controls.
- Keep iconography consistent, preferably using the existing icon library.

Message rendering:

- Links are visually distinct.
- Mention chips remain readable.
- System messages are quiet but still legible.
- Failed/pending states include text or accessible labels.

## 12. Motion And Responsiveness

Motion should be useful and minimal:

- Pane transitions can slide/fade, but must not block interaction.
- Respect reduced-motion preferences.
- Reconnect/loading states should not pulse aggressively.
- Layout should not jump when realtime events arrive.

Stable layout rules:

- Conversation row height should tolerate badges/previews.
- Composer controls should not resize unpredictably.
- File rows should reserve action space.
- Details tabs should not shift when settings tab appears; hide or show in a
  stable location based on permission.

## 13. Error And Offline Behavior On Mobile

Offline/reconnect:

- Show compact status.
- Keep current view usable where cached data exists.
- Preserve drafts.
- Preserve selected conversation.

Errors:

- Keep error near failed action.
- Avoid full-screen error unless the entire shell cannot function.
- Provide retry where useful.

Copy:

- `连接暂时不可用。`
- `正在重新连接...`
- `消息发送失败，请重试。`
- `文件上传失败，请重试。`

## 14. Testing Checklist

Manual viewport checks:

- `375 x 667`: small mobile.
- `390 x 844`: common mobile.
- `768 x 1024`: tablet.
- `1280 x 800`: desktop.
- Wide desktop, if available.

Core mobile flows:

- Login page shows GitHub login only.
- Open conversation list.
- Select conversation.
- Send message.
- Open details and return to chat.
- Open file library and download or see quota rejection.
- Open member directory and start direct chat.
- Owner/admin creates invite from space settings.
- Group creation sheet does not obscure validation.

Accessibility checks:

- Tab through public login.
- Tab through shell navigation.
- Open and close modal with keyboard.
- Confirm focus returns after modal close.
- Verify icon-only buttons have labels/tooltips.
- Verify long file/member names do not overflow.

## 15. P0 / P1 / P2

P0:

- Mobile pane model: list, main, details.
- Visible back controls.
- Mobile chat composer remains usable.
- Member picker and group creation as sheets/modals.
- Basic keyboard focus and accessible labels.
- No three-column squeeze on mobile.

P1:

- More complete screen-reader feed semantics.
- Reduced-motion polish.
- Keyboard shortcuts after behavior stabilizes.
- Better tablet split view.

P2:

- Push notification permission UX.
- Advanced command palette keyboard flow.
- Offline draft persistence across reloads.

## 16. Acceptance Checklist

- Mobile shows one primary task at a time.
- Back paths are clear from chat, details, files, members, and settings.
- Composer remains usable with virtual keyboard.
- Details/settings do not erase chat draft.
- Icon-only controls have accessible names.
- Focus is trapped in modals/sheets and restored after close.
- Long text does not overlap or break the layout.
- Normal members do not see hidden admin/platform internals on small screens.
