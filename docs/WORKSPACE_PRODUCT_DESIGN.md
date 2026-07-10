# Shared Space Workspace Product Design

## 1. Product Definition

**External name:** 共享空间 / 空间

**Internal engineering name:** `Workspace`

共享空间是 DualLane 的长期多人共享通道。它适合朋友、家人、搭子、兴趣小组或小团队保存聊天和文件，让内容可以被空间成员稍后查看、下载和管理。

User-facing definition:

> 共享空间是一个可长期保存、可多人访问的聊天与文件空间，适合和熟人、小组或固定伙伴共享内容。

Engineering definition:

> Workspace is the audited relay lane with login, invite-only accounts, RBAC, server-retained messages/files, quota enforcement, retention, and audit logging.

The external experience should be C-end and familiar. The internal implementation can remain professional and security-oriented.

## 2. Naming Rules

Use these terms in user-facing UI and docs:

| Internal term | External term |
| --- | --- |
| Workspace | 共享空间 / 空间 |
| Workspace user | 空间成员 |
| RBAC / role assignment | 权限 |
| Quota | 空间容量 / 今日传输额度 |
| Audit log | 操作记录, database-only in P0 |
| Retention | 消息保留 |
| Admin console | 空间设置 |
| Owner | 空间主人 |
| Admin | 管理员 |
| Member | 成员 |
| Auditor | 预留角色 |
| Relay lane | 共享空间通道 / server-retained lane in technical docs only |

Avoid in normal member UI:

- `RBAC`
- `audit`
- `tenant`
- `compliance`
- `relay lane`
- `workspace relay`
- `enterprise`

These terms are acceptable in internal engineering docs, code comments, tests, API names, and deployment notes.

## 3. Product Principles

- Shared spaces are for familiar groups, not enterprise org charts.
- Regular members should feel they are joining a shared place, not being managed.
- Professional controls should be present but placed under **空间设置**.
- Privacy copy must not imply P2P or end-to-end private behavior.
- Server retention should be explicit and understandable: shared-space content is saved so members can access it later.
- Security controls should be explained through outcomes: who can join, who can see, how much can be transferred, and how long history is kept.
- Message exchange should be structured and versioned, not plain text only, so mentions, files, replies, system messages, and AI bot interactions remain explicit and controllable.

## 4. Target Users And Situations

Target users:

- Friends or partners who often exchange files.
- Family or personal groups that need a persistent shared place.
- Hobby groups, open-source maintainers, or trusted small teams.
- A self-hosted operator who wants accountable shared storage without enterprise tone.

Best-fit situations:

- A group wants one place for files and chat history.
- Members may not be online at the same time.
- Files should be downloadable later.
- Someone needs to know who joined, uploaded, downloaded, or changed settings.
- A self-hosted instance needs quota and retention controls.

Poor-fit situations:

- Temporary one-to-one sensitive exchange that should not touch server storage.
- Large public community chat with open registration.
- Formal enterprise hierarchy or compliance suite.
- Anonymous dropbox-style uploads.

## 5. Trust Model

Shared spaces are server-retained by design:

- Login is required.
- Membership is invite-only.
- Messages are stored on the server.
- File metadata and file content are stored on the server.
- File uploads/downloads are subject to quota.
- History retention is enforced by the server.
- Sensitive operations write operation records.
- Permissions determine what members can see and do.

Safe external copy:

- "共享空间会保存聊天和文件，方便成员稍后查看。"
- "空间成员可访问自己加入的会话。"
- "上传和下载会受到空间容量限制。"
- "重要操作会在服务端留档，用于安全和问题排查。"

Required boundary:

- Do not call shared spaces private direct sessions.
- Do not say shared-space content stays only in browsers.
- Do not say the server cannot access shared-space content unless encryption is added later.
- Keep private direct and shared spaces visually and verbally distinct.

## 6. Regular Member Experience

Regular members should primarily see daily-use concepts:

- My spaces or current space.
- Joined conversations.
- Shared files.
- Space members.
- Recent history.
- Remaining capacity or today's available transfer amount.
- Invite or request access where allowed.
- Leave space.

Regular members should not need to understand:

- RBAC internals.
- Audit-log schemas.
- Transfer ledger states.
- Retention job details.
- Tenant architecture.
- Backend relay implementation.

Suggested member navigation:

- `聊天`
- `文件`
- `成员`
- `空间信息`

Member-visible status examples:

- `今日还可传输 1.4 GiB`
- `此会话保留最近 10000 条消息`
- `你可以查看和发送消息`
- `你没有邀请成员的权限`

## 7. AI Bot Experience

AI bots are a special type of space member, not background services with unlimited access.

Product rules:

- Bots can only read conversations they have joined or where they are explicitly allowed.
- Bot replies should appear as messages from a bot member, with clear identity.
- Mentioning a bot can trigger a response when the bot has permission.
- Bot access to file content must be explicit and policy-controlled.
- Bot actions should write operation records when they read file content, create summaries, or perform sensitive operations.

Member-facing copy should be concrete:

- `@助手 总结一下上面的内容`
- `助手只能查看它所在会话中的消息`
- `此文件仅允许助手读取文件名和类型`
- `允许助手读取文件内容后继续`

Attachment access levels for bots:

| Level | Meaning |
| --- | --- |
| `metadata_only` | Bot can see file name, type, size, and uploader metadata only. |
| `text_preview` | Bot can read a server-generated text preview or extracted summary. |
| `full_content` | Bot can read the full file content after explicit permission and quota/policy checks. |

Detailed command, event, content-block, and bot-trigger rules live in [Workspace Message Protocol](WORKSPACE_MESSAGE_PROTOCOL.md).
First-loop implementation decisions live in [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md).
The complete document map lives in [Workspace Design Index](WORKSPACE_DESIGN_INDEX.md).
Product-grade IM, layout, and member-permission surfaces live in:

- [Workspace Core User Flow Design](WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace IM Product Design](WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
- [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md)
- [Workspace Conversation And Group Design](WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
- [Workspace Member And Permission Design](WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
- [Workspace File And Quota Design](WORKSPACE_FILE_QUOTA_DESIGN.md)
- [Workspace Space Settings Design](WORKSPACE_SPACE_SETTINGS_DESIGN.md)
- [Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
- [Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
- [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace Realtime Event Design](WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)

## 8. Space Settings Experience

Owners and administrators access advanced controls through **空间设置**:

- Space profile.
- Invite links.
- Members.
- Permissions.
- Groups.
- Capacity and transfer limits.
- History retention.
- Operation records are database-only in the first full Workspace loop; owner/admin UI can be added later.

Settings should remain calm and table-first, but not framed as an enterprise admin console.

Suggested settings labels:

- `邀请成员`
- `成员权限`
- `群聊管理`
- `容量设置`
- `消息保留`

## 9. Core Flow

1. User chooses **共享空间** from the entry screen.
2. User signs in with GitHub.
3. Backend checks accepted invite or existing membership.
4. User enters the shared space.
5. Member sees conversations, files, members, and space status.
6. Member sends messages or uploads/downloads files within permission and quota.
7. Owner/admin manages space settings where permitted.
8. Server persists messages/files and writes operation records for sensitive actions.

Entry card:

- Label: `共享空间`
- Short copy: `和熟人或小组长期共享聊天与文件，可稍后查看。`
- Secondary note where needed: `需要登录和邀请。`

Disabled-state copy:

- Title: `共享空间暂未开放。`
- Body: `共享空间会保存聊天和文件，并包含登录、权限、容量和消息保留。当前版本默认关闭，避免误用未完成能力。`

## 10. Functional Requirements

MVP:

- Workspace remains disabled by default unless `WORKSPACE_ENABLED=true`.
- GitHub OAuth login.
- Invite-only account acceptance.
- Seeded first owner: GitHub `timeStarry`, email `timestarry@qq.com`.
- Basic roles: `owner`, `admin`, `member`, optional `auditor`.
- Conversation list for joined one-to-one and group conversations.
- Server-retained messages.
- Group conversations.
- File upload and download.
- Combined upload/download quota of `2 GiB / user / day`.
- Quota rejection before transfer starts.
- Transfer ledger.
- Message retention by latest message count, default `10000`.
- Operation records for sensitive actions.
- Member UI that avoids enterprise terminology.
- Space settings UI for privileged users.
- Versioned structured message protocol with plain-text summaries, content blocks, attachment references, and idempotent client message IDs.
- Realtime event log and WebSocket delivery foundation.

Later:

- Search within joined conversations.
- Better file previews.
- Time-based retention.
- Storage usage dashboard.
- Export and backup tools.
- AI bot members with mention-based triggers and explicit attachment-access policies.
- Optional encrypted shared-space room mode with a new trust-model explanation.

## 11. Permission Model

Initial roles:

| Role | External label | Baseline capability |
| --- | --- | --- |
| `owner` | 空间主人 | Full control over settings, permissions, records, and configuration. |
| `admin` | 管理员 | Invite members, create groups, and manage members as allowed. |
| `member` | 成员 | Use joined conversations and files within quota. |
| `auditor` | 预留角色 | Engineering-reserved for possible future operation review; no operation-record UI/API in the first full Workspace loop. |

Permission design rules:

- Backend must enforce permissions.
- Frontend permission checks are advisory and should only simplify the UI.
- Regular member screens should show unavailable actions as absent or clearly unavailable, not as technical errors.
- Rejected sensitive operations should write operation records.
- Full first-loop capability details are defined in [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md).

## 12. Capacity And Retention

Capacity:

- MVP limit: `2 GiB / user / day`.
- Upload and download share the same daily limit.
- Quota is checked before transfer.
- Upload failures release reserved quota.
- Downloads must verify remaining quota before issuing a token or stream.
- Rejections do not consume quota.
- Rejections are written to operation records.

Retention:

- MVP default: most recent `10000` messages per conversation.
- Attachments are first-class records and can exist without messages. Message retention may remove message references, but standalone attachments are not hard-deleted by default.
- Operation records have separate retention.

Member-facing language:

- `今日传输额度`
- `空间容量`
- `消息保留`
- `保留最近 10000 条消息`

Engineering language:

- `quota`
- `transfer_ledger`
- `retention_count`
- `audit_logs`

## 13. Operation Records

Operation records are for accountability and recovery, not for making the product feel like compliance software.

Record-worthy actions:

- Login success or failure.
- Invite creation and acceptance.
- Role or permission changes.
- Conversation creation.
- Group membership changes.
- File upload/download events.
- Quota rejections.
- Message deletion or retention cleanup when implemented.
- Space setting changes.
- Bot file-content reads.
- Bot-created summaries or automated replies where enabled.

Operation records are database-only in the first full Workspace loop. Normal members cannot see operation records, platform logs, request IDs, IP addresses, user agents, OAuth details, or transfer ledgers. Owner/admin operation-record UI is deferred.

Future owner/admin-facing summaries should be readable:

- `timeStarry 邀请了 lane-member`
- `lane-member 上传了 report.zip`
- `文件下载被拒绝：今日传输额度不足`
- `助手读取了 report.txt 的文本预览`

Internal records can retain structured fields for actor, action, target, result, reason, IP, user agent, request ID, and timestamp.

## 14. UI Structure

Desktop:

- Left rail: space identity, primary tabs, conversation list, and create menu.
- Center: active conversation, message history, and composer.
- Right context drawer: conversation overview, group members, conversation files, file detail, or settings.
- Settings accessible from a compact space menu and grouped by intent.

Mobile:

- Conversation list and chat are separate navigable views.
- Files and members are tabs, sheets, or secondary views.
- Settings are reserved for privileged users.

Visual rules:

- Avoid enterprise dashboard density in regular member views.
- Use compact, clear controls.
- Keep capacity/history/status copy understandable.
- Keep trust-mode indicator visible.
- Do not present "operation records" as the main experience.
- Do not keep group creation, invite creation, member lists, file lists, and chat all permanently visible in one flat surface.
- Put group configuration in a conversation details drawer or settings sheet.
- Put invite creation behind logged-in owner/admin member-management flows, never on the public login page.

Next-loop productization requirements:

- Public Workspace entry must stay login-only; invite creation is available only
  after login to permitted members.
- Conversation list rows must distinguish direct and group chats and show useful previews.
- Direct chats should start through a member picker.
- Group creation should collect name and members in a focused modal/sheet.
- Group details should expose overview, members, files, and settings through a contextual surface.
- Member directory should support lookup and direct-chat discovery.
- File library should exist as a navigable surface, even if P0 starts with a simple list.
- Files should support both chat attachment and standalone library upload flows.
- Realtime updates should cover new messages, group membership changes, file
  status changes, and local quota rejection notices.
- Desktop and mobile must have separate layout models rather than a compressed flat page.

See [Workspace Information Architecture](WORKSPACE_INFORMATION_ARCHITECTURE.md) for the full layout contract.
Use [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
for screen-level implementation requirements, and
[Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md) for
loading, empty, error, permission, quota, and reconnect states.
Use [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
for member fetching, normalized UI state, realtime projection, and targeted
refetch policy.
Use [Workspace API Contract](WORKSPACE_API_CONTRACT.md) for HTTP/WebSocket
request/response shapes, capability flags, and error contracts.
Use [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md) for schema
boundaries, state machines, retention, event sequences, and operation records.
Use [Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md)
for GitHub-only public entry, seeded owner binding, and invite-only access.
Use [Workspace Space Settings Design](WORKSPACE_SPACE_SETTINGS_DESIGN.md) for
member-facing space information and owner/admin settings grouping.
Use [Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
for scoped conversation, member, and file discovery.
Use [Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
for local notices, unread state, mentions, and future notification preferences.
Use [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
for mobile pane behavior, focus, and accessibility acceptance.
Use [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md) for
visual hierarchy, density, icons, responsive component patterns, and UI
anti-pattern review.
Use [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md) for
P0/P1/P2 sequencing and productization gates.
Use [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)
for persona, screen, backend, realtime, file/quota, disclosure, and manual
acceptance.

## 15. Validation Checklist

- Workspace APIs return the disabled response by default.
- Enabling `WORKSPACE_ENABLED=true` exposes only authenticated shared-space APIs.
- Regular members only see joined conversations.
- Non-members cannot create messages in a conversation and rejection is recorded.
- Quota is rejected before upload/download transfer begins.
- Failed upload releases reserved quota.
- Rejected quota operation writes an operation record.
- Operation records are persisted but not exposed to normal members.
- Message retention removes older messages beyond the configured count.
- UI copy uses "共享空间" or "空间" for external surfaces.
- UI does not describe shared-space content as browser-only or P2P.
- Message creation rejects invalid structured content and does not trust client-supplied bot/AI eligibility fields.
- Bot access to attachments follows `metadata_only`, `text_preview`, or `full_content` policy.
