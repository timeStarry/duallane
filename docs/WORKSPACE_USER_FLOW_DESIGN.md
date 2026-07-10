# Workspace Core User Flow Design

## 1. Purpose

This document defines the core shared-space user flows for DualLane Workspace.
It turns the product rules from the higher-level design documents into
step-by-step interaction contracts.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is comprehensive behavior without complicated operation. The product
should expose the right action at the right moment:

- A visitor sees only GitHub login.
- A regular member sees chat, files, members, and space information.
- An owner/admin sees additional management actions only where they are useful.
- Platform records and implementation internals stay out of normal member flows.

## 2. Interaction Principles

Use progressive disclosure:

- Public entry has one action: `使用 GitHub 登录`.
- Daily chat keeps the conversation list, active chat, and details separated.
- Member and file tasks open focused panels, sheets, or views.
- Settings are grouped by intent and shown only to permitted users.

Prefer safe defaults:

- Member invites default to `member`.
- Direct conversations reuse existing pair conversations.
- Group creation includes the creator automatically.
- New group members can see retained history in MVP.
- Upload/download quota is checked by the backend before transfer.

Avoid unnecessary ceremony:

- Do not require a confirmation for normal sending, normal upload, or normal
  download when quota is sufficient.
- Confirm destructive or surprising actions such as removing a group member,
  revoking an invite, demoting an admin, or leaving a space.
- Explain denial by outcome, not internal policy names.

## 3. Primary User Types

| User type | Entry state | Main intent |
| --- | --- | --- |
| Visitor | Not logged in | Sign in with GitHub after receiving access. |
| Invited user | Has invite link/code | Complete GitHub login and join the space. |
| Regular member | Active membership | Chat, find members, upload/download files. |
| Admin | Active membership with management permissions | Invite members and manage groups. |
| Owner | Seeded or assigned owner | Manage roles, policy, and privileged settings. |

Future bot members should follow the same member visibility model but with a
clear bot identity and separate permission policy.

## 4. Public Workspace Entry

Entry point:

- User selects `共享空间` from the DualLane lane choice.
- User opens an invite link that points to Workspace.

Visible UI:

- Product label: `共享空间`
- Primary button: `使用 GitHub 登录`
- Optional concise note: `需要已有成员邀请后才能进入。`

Must not show:

- Invite creation.
- Invite code input as a primary public registration flow.
- Member list.
- Operation records.
- Admin or platform terms.

Backend checkpoints:

- `WORKSPACE_ENABLED=true` is required.
- If feature flag is off, return a disabled state before any Workspace data is
  exposed.
- OAuth callback identifies the GitHub user.
- User enters only if they match the seeded owner or a valid invite acceptance.

Failure states:

| State | Copy |
| --- | --- |
| Feature disabled | `共享空间暂未开放。` |
| OAuth failed | `登录未完成，请重试。` |
| Not invited | `这个 GitHub 账号还没有加入共享空间。` |
| Invite expired | `邀请已过期，请联系空间成员重新邀请。` |

## 5. First Owner Flow

Seeded owner:

- GitHub login: `timeStarry`
- Email: `timestarry@qq.com`
- Role: `owner`

Flow:

1. Backend bootstraps the default space and owner row.
2. Owner clicks `使用 GitHub 登录`.
3. OAuth callback returns GitHub identity.
4. Backend matches login or email against the seeded owner.
5. Backend binds the GitHub numeric ID when available.
6. Owner enters the default space.

Owner first-run surface:

- Show empty conversation state.
- Show `发起私聊`, `创建群聊`, and `邀请成员`.
- Show quota and retention copy in space information.
- Do not show raw audit rows or platform logs in this loop.

## 6. Invited Member Flow

Invite creation happens only inside Workspace:

1. Owner/admin opens `空间 -> 邀请成员`.
2. Owner/admin creates a member invite.
3. UI shows a copyable invite link/code.
4. Invited user opens the link and signs in with GitHub.
5. Backend validates invite status, max uses, expiry, and role.
6. Backend creates or activates the user membership.
7. User enters the space as the invite default role.

Invite acceptance behavior:

- Invite code is validated after OAuth identity is known.
- A successful acceptance writes an operation record.
- Expired, revoked, or over-used invites fail with user-safe copy.
- Normal members cannot create invites.

P0 UI:

- One-click member invite creation for owner/admin.
- Copy invite link.
- Show created invite code/link inside settings or member management.
- Show active invite rows and revoke action for owner/admin.

P1 UI:

- Expiry and max-use controls.
- Invite search/filter/history with active, expired, revoked, and used states.

## 7. Daily Member Home

After login, regular members land in the shared-space shell.

Primary areas:

- `聊天`: joined direct and group conversations.
- `文件`: visible shared files.
- `成员`: visible space members.
- `空间`: own role, quota, retention, and permitted settings entry.

Default state:

- If the user has recent conversations, select the most recent conversation.
- If no conversation exists, show a focused empty state with allowed next
  actions.
- Do not show a disabled composer without context.

Member home status:

- `今日还可传输 ...`
- `消息保留按会话设置`
- `共享空间保存消息和文件`

Normal members must not see:

- Operation records.
- Request IDs.
- IP addresses or user agents.
- OAuth details.
- Transfer ledger rows.
- Raw realtime sequence numbers.

## 8. Start Direct Chat Flow

Entry points:

- `发起私聊` in the conversation list.
- `发起私聊` on a member row.

Flow:

1. User opens the member picker.
2. Picker lists visible space members.
3. User selects one human member.
4. Backend creates or reuses the direct conversation for that pair.
5. UI navigates to the conversation.

Rules:

- Direct chat creation is allowed for `owner`, `admin`, and `member`.
- Auditor is reserved and cannot start chats in this loop.
- A user cannot start a direct conversation with themselves.
- One direct conversation exists per member pair per space.
- Removed space members lose access immediately.

Friendly copy:

- Empty picker: `还没有可发起私聊的成员。`
- No permission: `你当前不能发起私聊。`
- Existing direct reused silently; no duplicate-warning dialog is needed.

## 9. Create Group Flow

Entry point:

- `创建群聊` in the conversation list create menu or space quick action.

Flow:

1. User clicks `创建群聊`.
2. A focused modal/sheet opens.
3. User enters group name.
4. User selects initial members.
5. UI shows selected member count.
6. Backend creates the group conversation.
7. Backend adds creator and selected members.
8. UI opens the new group and its context drawer.

Rules:

- Owner/admin can create groups.
- Regular members cannot create groups in MVP.
- Creator is always included automatically.
- P0 requires at least one selected member besides the creator.
- Empty creator-only groups are deferred to a later policy decision.
- New members can see retained prior history after being added.

Validation:

| Field | Rule | Copy |
| --- | --- | --- |
| Name | Required, trimmed, reasonable length | `请输入群聊名称。` |
| Members | At least one active space member besides creator | `请选择至少一位群聊成员。` |
| Permission | Owner/admin only | `你当前不能创建群聊。` |

Do not keep the group creation form permanently visible in the main chat layout.

## 10. Send Message Flow

Entry point:

- Active conversation composer.

Flow:

1. User types text or composes content with attachments.
2. Client creates structured content blocks.
3. Client sends `message.create` with `clientMessageId`.
4. Backend validates membership, content, attachments, and idempotency.
5. Backend persists the canonical message.
6. Backend writes a realtime event.
7. UI reconciles optimistic message with server message.

User-facing behavior:

- Press Enter or click send to submit text.
- Show pending state only while waiting.
- On failure, show retry affordance.
- Unknown structured blocks render through `plainText` fallback.

Backend-owned truth:

- Author identity.
- Server timestamp.
- Message kind.
- Attachment visibility.
- Bot eligibility.
- Operation-record decisions.

## 11. Upload File Flow

Chat attachment:

1. User clicks file button in the composer.
2. Client asks backend to reserve upload quota.
3. Backend rejects or reserves quota before bytes are accepted.
4. Client uploads file content.
5. Client completes upload.
6. Backend marks attachment available.
7. User sends or has already sent a message referencing the attachment.

Standalone file:

1. User opens `文件`.
2. User uploads a file to the space file library.
3. Backend applies the same quota and storage lifecycle.
4. File appears in the library without requiring a message.

Failure behavior:

- Quota rejection: `今日传输额度不足，无法上传此文件。`
- Upload failure before completion releases reserved quota.
- Failed upload remains local/retryable where useful, but failed reservation does
  not consume quota.

## 12. Download File Flow

Flow:

1. User clicks download on a visible file.
2. Backend checks file visibility.
3. Backend checks remaining daily transfer quota.
4. If sufficient, backend reserves/completes the download ledger step and serves
   or authorizes the file.
5. If insufficient, backend rejects before transfer begins.

UX:

- Normal downloads should not need confirmation.
- Warn only when the file appears larger than today's remaining quota.
- Rejection is shown as an inline notice or toast, not as a chat message.

Copy:

- `今日传输额度不足，无法下载此文件。`
- `你无法访问此文件。`

## 13. Group Details Flow

Entry point:

- Details button in group conversation header.

Panels:

- `概览`: group name, member count, retention copy.
- `成员`: group member list and add/remove controls when permitted.
- `文件`: files visible in this group.
- `设置`: group-level controls for owner/admin.

Rules:

- Regular members can view group members and files.
- Owner/admin can add/remove group members.
- Removed members lose access immediately.
- Operation records are written for group membership changes.

Mobile:

- Open as a sheet or full-screen subpage.
- Keep message sending accessible after closing the details view.

## 14. Space Settings Flow

Entry point:

- `空间` primary tab or compact space menu.

Groups:

- `空间资料`
- `邀请成员`
- `成员权限`
- `群聊管理`
- `容量与历史`

Visibility:

- Regular members see space information and their own status.
- Owner/admin see invite and group-management actions.
- Owner sees role/policy controls when implemented.
- Operation-record UI is deferred for this loop.

Settings should be quiet and task-based. Do not turn daily member views into an
admin console.

## 15. Reconnect And Offline Flow

When WebSocket disconnects:

- Keep HTTP actions available if session is valid.
- Show compact status: `正在重新连接...`
- Reconnect with the last seen event sequence.
- If event replay is unavailable, refetch bootstrap, conversations, and active
  messages.

On conflict:

- Preserve local pending messages.
- Reconcile accepted messages through `clientMessageId`.
- Show failed messages with retry.

Do not expose raw event sequence numbers to normal members.

## 16. Error Handling Rules

Use stable backend error codes and user-safe messages.

| Situation | Copy |
| --- | --- |
| Not authenticated | `登录后进入共享空间。` |
| Not invited | `这个 GitHub 账号还没有加入共享空间。` |
| No conversation access | `你无法访问此会话。` |
| Cannot create group | `你当前不能创建群聊。` |
| Cannot invite | `你当前不能邀请成员。` |
| Quota insufficient | `今日传输额度不足。` |
| Upload failed | `文件上传失败，请重试。` |
| Reconnect failed | `连接暂时不可用，请稍后重试。` |

Avoid leaking SQL errors, OAuth internals, request IDs, IP addresses, stack
traces, transfer ledger states, or raw permission names.

## 17. P0 / P1 / P2

P0:

- GitHub-only public login.
- Seeded owner login.
- Invite-only acceptance.
- Conversation list.
- Direct chat through member picker.
- Group creation for owner/admin.
- Structured message sending.
- Chat attachment upload and standalone file upload.
- Download with quota check.
- Member directory.
- File library.
- Group details drawer.
- Database-only operation records.

P1:

- Search conversations, files, and members.
- Invite expiry/max-use/search polish.
- Local pin/mute polish beyond basic notification levels.
- Reply and reaction UI.
- File detail drawer and retry.
- Richer read/unread counts and mention badges.

P2:

- Message edit/delete.
- Rich previews and text extraction.
- Bot execution.
- Advanced group policies.
- Export/backup.
- Owner/admin operation-record UI, if product need is confirmed.

## 18. Acceptance Checklist

- Login page has only GitHub login and concise access copy.
- Invite creation is available only after login and permission check.
- Regular members can reach chat, files, members, and space information without
  opening settings.
- Owner/admin can create invites and groups without those controls dominating
  normal chat.
- Direct chat starts from a member picker and reuses existing conversations.
- Group creation and group details are focused flows, not permanently mounted
  admin panels.
- Upload failure releases quota.
- Download checks remaining quota before transfer.
- Operation records are persisted but hidden from normal members.
- Reconnect behavior updates chat naturally without exposing event internals.
