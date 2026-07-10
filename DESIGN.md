# DualLane Design Document

## 1. Product Positioning

**Engineering name / repository name:** `duallane`

**Product name:** DualLane

**Chinese positioning:** 分流式安全会话工具

DualLane is a small-scale, self-hosted communication tool with two deliberately separated trust models:

- **私密直连 / One-to-One Direct:** a short-lived one-to-one lane for temporary private chat and file transfer. It requires no login, uses the server only for signaling or encrypted fallback envelopes, and does not persist conversation content on the server.
- **共享空间 / Shared Space:** a long-lived shared chat and file space for friends, family, partners, interest groups, and small trusted teams. The internal engineering name is `Workspace`; internally it is the audited relay lane with persisted messages, file storage, permissions, quotas, retention, and operation records.

The product is not a generic chat app or an enterprise collaboration suite. Its core value is helping users choose the right lane before a conversation starts:

- Use **私密直连** when the content is temporary, one-to-one, and should stay off the server.
- Use **共享空间** when the content should be available to multiple people, recoverable later, and governed by space-level permissions.

External product copy should say "共享空间" or "空间" instead of "Workspace" whenever the user-facing meaning is intended. `Workspace` remains valid for code, APIs, database names, and engineering discussion.

## 2. Target Users

DualLane is designed for personal use, familiar small groups, and self-hosted deployments where the operator wants:

- A quick one-to-one path for temporary sensitive conversations or direct file transfer.
- A persistent shared space for friends, family, partners, hobby groups, or small trusted teams to keep messages and files together.
- Clear privacy boundaries without the operational weight or tone of enterprise messaging systems.
- A polished responsive UI suitable for ordinary users, not only administrators.

## 3. Goals

- Provide a clear two-choice entry point that separates temporary private direct sessions from persistent shared spaces.
- Keep the private lane privacy-first: no account, no server-side content storage, and no platform identity requirement.
- Keep shared spaces accountable: invite-only access, space permissions, message retention, file quotas, and operation records.
- Make the non-admin shared-space experience feel like everyday group sharing rather than system administration.
- Support small-scale self-hosting with simple deployment and maintainable code.
- Deliver a refined, modern, responsive interface suitable for open-source presentation.

## 4. Non-Goals

- No public open registration in the MVP.
- No enterprise SSO beyond GitHub OAuth in the MVP.
- No mobile push notifications in the MVP.
- No full-text search in the MVP.
- No multi-party private direct group chat in the MVP.
- No complex organization hierarchy in the MVP.
- No guarantee that private direct sessions work across every network without optional TURN support.
- No claim that shared spaces are end-to-end private; shared spaces are server-retained by design.

## 5. Product Documents

This document is the system-level design. Product details are split into lane-specific documents:

- [Workspace Design Index](docs/WORKSPACE_DESIGN_INDEX.md)
- [O2O Private Direct Product Design](docs/O2O_PRODUCT_DESIGN.md)
- [Shared Space Workspace Product Design](docs/WORKSPACE_PRODUCT_DESIGN.md)
- [Workspace Core User Flow Design](docs/WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace IM Product Design](docs/WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](docs/WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace UI Interaction Design](docs/WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](docs/WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Visual System Design](docs/WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace State And Feedback Design](docs/WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Workspace Client Data And View Model Design](docs/WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
- [Workspace API Contract](docs/WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](docs/WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Authentication And Invite Design](docs/WORKSPACE_AUTH_INVITE_DESIGN.md)
- [Workspace Conversation And Group Design](docs/WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
- [Workspace Member And Permission Design](docs/WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
- [Workspace File And Quota Design](docs/WORKSPACE_FILE_QUOTA_DESIGN.md)
- [Workspace Space Settings Design](docs/WORKSPACE_SPACE_SETTINGS_DESIGN.md)
- [Workspace Search And Discovery Design](docs/WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
- [Workspace Notification And Unread Design](docs/WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
- [Workspace Mobile And Accessibility Design](docs/WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace Message Protocol](docs/WORKSPACE_MESSAGE_PROTOCOL.md)
- [Workspace Realtime Event Design](docs/WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace MVP Development Contract](docs/WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
- [Workspace Productization Roadmap](docs/WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace Product Acceptance Matrix](docs/WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)

The split keeps the user-facing product language separate from the internal trust and implementation boundaries.

## 6. Core Workflows

### 6.1 Entry

The first screen has two primary choices:

- **私密直连**
  - One-to-one.
  - No login.
  - Server only handles temporary signaling or encrypted fallback envelopes.
  - Conversation content is not stored by the server.

- **共享空间**
  - Login required.
  - Invite-only access.
  - Supports long-lived chats, shared files, members, history, capacity, and operation records.

The entry UI should avoid marketing-style content. It should feel like a precise tool surface:

- Centered layout.
- Two large choices.
- One clear icon per choice.
- One short explanatory sentence per choice.
- No extra panels when a single action is expected.

### 6.2 私密直连 / O2O Private Lane

Flow:

1. User clicks **私密直连**.
2. User enters a public display name.
3. User starts a session.
4. The app creates a session identifier and invite link.
5. User shares the invite link externally.
6. Another user joins through the link.
7. The page becomes a chat interface.
8. Users send text messages or files over the direct connection.
9. When the session ends, each user chooses whether to save the session locally.

Behavior:

- No account is required.
- Server may temporarily relay signaling messages.
- Server must not store chat messages or transferred files.
- Session content is not persisted by default.
- At session end, ask whether to keep this session locally.
- If saved, data is stored only in the user's local browser storage or exported local file.
- If not saved, the local session state is discarded.

Suggested end-state UI:

- Center icon.
- Text: "本次直连已结束。"
- Primary action: "保存到本机"
- Secondary action: "不保存并关闭"

Privacy note:

The MVP should phrase the private-lane promise as "the server does not store conversation content." If the product later adds TURN relay support, the copy should say "content remains encrypted in transit and is not stored by the server" unless application-layer end-to-end encryption and key verification are implemented.

### 6.3 共享空间 / Workspace Relay Lane

Flow:

1. User clicks **共享空间**.
2. User signs in with GitHub.
3. Backend checks whether the GitHub identity is associated with an accepted invite or existing account.
4. If allowed, the user enters the shared space.
5. Regular members see their joined conversations, shared files, space members, and visible capacity/history information.
6. Members can start one-to-one conversations through member discovery where permitted, join group conversations they belong to, send messages, and upload or download files within quota.
7. Space owners and administrators see additional **空间设置** actions, such as inviting members, creating groups, managing permissions, and configuring retention where permitted.
8. Messages and files are stored on the server.
9. Sensitive actions and quota rejections are recorded in audit logs.

Regular member capabilities:

- View joined one-to-one and group conversations.
- Start a one-to-one conversation through the member directory or member picker
  where permitted.
- Send messages.
- Upload and download files within quota.
- View space members.
- View their own remaining transfer quota or space capacity where available.
- Understand how long messages/files are retained without seeing raw policy internals.

Privileged capabilities:

- Create invitation links.
- Create group chats.
- Manage group members.
- Manage roles and permissions.
- Configure retention where permitted.

External product copy should avoid making members feel like they are inside an admin console. Use terms such as "空间成员", "权限", "空间容量", and "消息保留". Avoid foregrounding `RBAC`, `audit`, `tenant`, `compliance`, `operation records`, or `relay lane` in normal user screens.

Shared-space messages must use a versioned structured protocol instead of plain text only. The persisted model should include a readable `plainText` summary, structured content blocks, attachment references, sender metadata, idempotency fields, and realtime event envelopes. This keeps normal chat, files, mentions, reactions, replies, system messages, and future AI bot participation on one evolvable contract. See [Workspace Message Protocol](docs/WORKSPACE_MESSAGE_PROTOCOL.md).

## 7. Roles And Permissions

Initial role set:

| Internal role | External label | Purpose |
| --- | --- | --- |
| `owner` | 空间主人 | Full space administration, role assignment, and configuration. Operation-record UI is deferred in the first full Workspace loop. |
| `admin` | 管理员 | Invite creation, group creation, member management, and operational visibility. |
| `member` | 成员 | Normal shared-space user. Can access joined conversations and use allowed chat/file features. |
| `auditor` | 预留角色 | Engineering-reserved role for possible future operation review. Hidden from normal member flows and not exposed as an operation-record product role in this loop. |

Recommended defaults:

- The seeded first owner is GitHub user `timeStarry` with email `timestarry@qq.com`.
- Invite links can specify the resulting default role, but only `owner` can create privileged invites.
- `member` is the default role for normal invites.
- External UI should present role effects as permissions, not as enterprise hierarchy.

## 8. History Retention

Each shared-space conversation supports configurable message history retention.

MVP default:

- Keep the most recent `10000` messages per conversation.

Optional future policy:

- Retain messages for a configured number of days, such as `90` days.
- If both count-based and time-based retention are enabled, whichever limit removes a message first wins.

Retention behavior:

- Message retention applies to server-side messages in the shared-space relay lane.
- Attachments are first-class records and may exist without a message. Message retention may remove message-to-attachment references, but it must not hard-delete standalone attachments by default.
- Operation records are not deleted by conversation retention.
- Operation-record retention is a separate system-level policy.

Recommended operation-record retention:

- Default: permanent for self-hosted MVP, or configurable later.
- Future option: `365` days minimum.

## 9. File Transfer And Quotas

The shared-space relay lane enforces a combined upload and download quota:

- **Limit:** `2 GiB / user / day`
- **Scope:** upload bytes plus download bytes combined.
- **Check:** before each upload or download starts.
- **Rule:** if the target file size exceeds today's remaining quota, reject the operation before transfer begins.

External UI can call this "今日可用容量" or "今日传输额度". Backend code can continue to call it quota.

Quota formula:

```text
daily_limit = 2 GiB
used_today = successful_upload_bytes + successful_download_bytes + active_reserved_bytes
remaining_today = daily_limit - used_today

if target_file_size > remaining_today:
  reject_operation
else:
  reserve_quota_and_start_transfer
```

The backend must enforce this. The frontend may show remaining quota, but frontend checks are only advisory.

To prevent concurrent quota bypass:

- Create a transfer ledger entry before transfer starts.
- Reserve the target file size in a transaction.
- Mark the entry as `completed`, `failed`, or `rejected`.
- Failed uploads release reserved quota. Failed downloads before token/stream issuance do not consume quota.

MVP recommendation:

- For uploads, reserve by declared file size before accepting the upload.
- For downloads, reserve by stored file size before issuing a download token or stream.
- On failed upload before completion, release the reservation.
- On rejected operation, write an audit entry but do not consume quota.

Audited file events:

- Upload requested.
- Upload completed.
- Upload failed.
- Upload rejected because quota is insufficient.
- Download requested.
- Download completed or token issued.
- Download rejected because quota is insufficient.

## 10. Operation Records / Audit Logging

The shared-space relay lane keeps audit logs for security, accountability, and operations. The first full Workspace loop keeps them as database-only records with no member-facing UI/API. If a later owner/admin review UI is added, user-facing copy should call them "操作记录" instead of `audit logs`.

Audit log fields:

- Actor user ID.
- Actor GitHub identity.
- Action name.
- Target type.
- Target ID.
- Result: success, failure, rejected.
- Reason or error code.
- IP address.
- User agent.
- Request ID.
- Created timestamp.

Audit-worthy actions:

- Login success or failure.
- Invite creation.
- Invite acceptance.
- Role changes.
- Conversation creation.
- Group membership changes.
- Message deletion or retention cleanup, if implemented.
- File upload/download events.
- Quota rejections.
- Admin configuration changes.

## 11. Data Model

Suggested initial tables:

| Table | Purpose |
| --- | --- |
| `users` | Platform users mapped to GitHub identities. |
| `spaces` | Shared-space records; MVP uses one default space. |
| `space_members` | Space-level membership and roles. |
| `invites` | Invite links, expiry, usage limits, and assigned default role. |
| `sessions` | Auth sessions for logged-in shared-space users. |
| `conversations` | One-to-one and group conversations. |
| `conversation_members` | Membership records and conversation-local metadata. |
| `messages` | Server-retained shared-space relay messages. |
| `message_attachments` | Links messages to one or more attachments. |
| `attachments` | Uploaded file metadata and storage references. |
| `transfer_ledger` | Upload/download quota accounting. |
| `workspace_events` | Realtime event log with per-space sequence numbers. |
| `audit_logs` | Durable operation logs. |
| `p2p_signal_rooms` | Temporary signaling room metadata, if persisted briefly. |

Important separation:

- Private direct message and file contents must not be stored in shared-space message or attachment tables.
- Signaling room state should be short-lived and safe to discard.
- Invite link `#k=` fragments are browser-only secrets and must not be sent to backend APIs.
- Shared-space messages should not remain a `body TEXT`-only protocol. Store canonical structured content, plain-text summaries, message kind, idempotency identifiers, reply/edit/delete metadata, and attachment references as described in the message protocol.
- The current Workspace prototype does not need compatibility. The first full Workspace loop should directly replace the prototype database model with the target schema from the MVP development contract.

## 12. Architecture

Recommended MVP stack:

- Frontend: React, Vite, TypeScript.
- Styling: local CSS design system with responsive layout.
- Icons: `lucide-react`.
- Backend: Node/Fastify.
- Realtime: WebSocket.
- Private direct: WebRTC DataChannel plus WebSocket signaling.
- Database: SQLite for self-hosted MVP.
- File storage: local filesystem volume.
- Deployment: Docker Compose.

Suggested services:

- `web`: frontend and API server, either integrated or reverse-proxied.
- `db`: not needed for SQLite MVP; use a mounted volume.
- `storage`: local mounted upload directory.
- Optional future `turn`: coturn for improved private-direct connection success.

MVP deployment assumption:

- Small trusted deployment.
- HTTPS required for production WebRTC and secure OAuth callbacks.
- Public access should be protected by invite-only account checks.
- Workspace APIs stay disabled by default unless `WORKSPACE_ENABLED=true`.

## 13. UI Principles

Visual target:

- Minimal.
- Modern.
- Elegant.
- Responsive.
- Tool-first, not marketing-first.
- Friendly enough for C-end users, especially regular shared-space members.

Interaction rules:

- Single-step screens should show only the current action.
- Prefer one center icon, one short explanation, and one primary action.
- Avoid dense navigation until the user enters a shared space.
- Make trust mode visible in the chat surface.
- Keep private direct and shared-space visual states distinct but within one coherent design system.
- Do not expose internal terms such as `RBAC`, `audit`, or `relay lane` in regular member UI.

Shared-space layout must use a real information hierarchy instead of placing all
features in one flat page:

- Entry: two large lane choices.
- Private direct setup: centered single-action screen.
- Private direct waiting: centered link sharing state.
- Private direct chat: compact message surface with local-save status.
- Shared space desktop: conversation list/navigation rail, active chat, and a collapsible context drawer for conversation details, files, members, or settings.
- Shared space mobile: conversation list, active chat, and details/settings as separate navigable views or sheets.
- Group chat configuration: group details surface with overview, members, files, and settings; not an always-visible admin strip.
- Member directory: a daily-use member surface for direct chat discovery and member lookup.
- File library: a dedicated file surface in addition to chat attachment cards.
- Space settings: quiet, grouped operational layout for privileged users.

Detailed shared-space IM and layout requirements live in:

- [Workspace IM Product Design](docs/WORKSPACE_IM_PRODUCT_DESIGN.md)
- [Workspace Information Architecture](docs/WORKSPACE_INFORMATION_ARCHITECTURE.md)
- [Workspace UI Interaction Design](docs/WORKSPACE_UI_INTERACTION_DESIGN.md)
- [Workspace Screen And Component Specification](docs/WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace Visual System Design](docs/WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Workspace State And Feedback Design](docs/WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Workspace Client Data And View Model Design](docs/WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
- [Workspace API Contract](docs/WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](docs/WORKSPACE_DATA_MODEL_DESIGN.md)
- [Workspace Authentication And Invite Design](docs/WORKSPACE_AUTH_INVITE_DESIGN.md)
- [Workspace Core User Flow Design](docs/WORKSPACE_USER_FLOW_DESIGN.md)
- [Workspace Conversation And Group Design](docs/WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
- [Workspace Member And Permission Design](docs/WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
- [Workspace File And Quota Design](docs/WORKSPACE_FILE_QUOTA_DESIGN.md)
- [Workspace Space Settings Design](docs/WORKSPACE_SPACE_SETTINGS_DESIGN.md)
- [Workspace Search And Discovery Design](docs/WORKSPACE_SEARCH_DISCOVERY_DESIGN.md)
- [Workspace Notification And Unread Design](docs/WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
- [Workspace Mobile And Accessibility Design](docs/WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
- [Workspace Realtime Event Design](docs/WORKSPACE_REALTIME_EVENT_DESIGN.md)
- [Workspace Productization Roadmap](docs/WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace Product Acceptance Matrix](docs/WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)

## 14. MVP Scope

Included:

- Two-lane entry screen.
- Private direct one-to-one session creation and join link.
- WebRTC DataChannel text messaging.
- WebRTC DataChannel file transfer.
- Private direct session end with local-save confirmation.
- GitHub OAuth login for shared spaces.
- Invite-only account acceptance.
- Seeded first owner: `timeStarry` / `timestarry@qq.com`.
- RBAC with `owner`, `admin`, `member`, and optional `auditor`.
- Shared-space one-to-one conversations through member picker and direct
  conversation reuse.
- Shared-space group conversations with focused creation, member selection, and
  contextual group details.
- Structured server-side message persistence for shared spaces.
- Conversation message retention by recent message count, default `10000`.
- File upload and download in shared spaces, including standalone attachments
  that may exist without messages.
- Combined upload/download quota of `2 GiB / user / day`.
- Transfer ledger.
- Realtime event log, WebSocket delivery foundation, reconnect/replay behavior,
  and permission-filtered event projection.
- Audit logs for auth, invite, role, conversation, file, and quota events.
- Responsive polished UI with non-flat shared-space information architecture:
  conversation list, active chat, contextual details, member directory, and file library.
- Docker Compose deployment.

Excluded from MVP:

- TURN relay by default.
- Multi-party private direct chat.
- Public registration.
- Push notifications.
- Full-text search.
- Complex message moderation.
- Enterprise SSO.
- Fine-grained per-room roles beyond basic membership.

## 15. Later Phases

Phase 2:

- Optional TURN relay with clear privacy copy.
- Time-based message retention.
- Export local private-direct transcript.
- Space settings for quota and storage usage.
- Search within joined shared-space conversations.
- Better file previews.

Phase 3:

- Application-layer end-to-end encryption for private direct with key verification.
- Optional encrypted shared-space room mode.
- PostgreSQL support.
- Multi-device session management.
- Public open-source deployment templates.
- Backup and restore tooling.

## 16. Validation Plan

Prototype checks:

- Create private direct session and join from a second browser profile.
- Send text over WebRTC DataChannel.
- Transfer a file over WebRTC DataChannel.
- End private direct session and confirm local save prompt.
- Verify server does not persist private direct message or file content.
- Login with GitHub OAuth.
- Accept invite and create a shared-space account.
- Verify regular member sees only allowed shared-space actions.
- Verify admin can create invite and group chat.
- Send shared-space messages and confirm they persist after reload.
- Upload and download shared-space files.
- Attempt file operation larger than remaining daily quota and confirm rejection before transfer.
- Confirm successful and rejected file operations appear in audit logs.
- Trigger retention cleanup and confirm only the configured number of messages remains.

Automated tests:

- RBAC permission checks.
- Invite acceptance rules.
- Quota reservation and rejection logic.
- Transfer ledger state transitions.
- Message retention cleanup.
- Audit log write paths.
- Private direct signaling room lifecycle.

Launch criteria:

- Works on desktop and mobile widths.
- No unauthenticated access to shared-space conversations or files.
- Private direct lane does not persist content server-side.
- Quota enforcement is backend-owned.
- Audit logs capture sensitive shared-space operations.
- Docker Compose can start the app from a clean checkout.

## 17. Open Questions

Recommended defaults are included where possible.

| Question | Recommended default |
| --- | --- |
| Database | SQLite for MVP. |
| File storage | Local mounted volume. |
| Private direct persistence | Ask at session end; default to not saving. |
| Shared-space message retention | Recent `10000` messages per conversation. |
| Shared-space file quota | Upload and download combined, `2 GiB / user / day`. |
| Operation-record retention | Permanent in MVP, configurable later. |
| TURN support | Post-MVP optional feature. |
| External shared-space label | Use `共享空间` or `空间`; avoid exposing `Workspace` to normal users. |
| Workspace implementation contract | Use [Workspace MVP Development Contract](docs/WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md). |
