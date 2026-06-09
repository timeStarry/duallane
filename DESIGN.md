# DualLane Design Document

## 1. Product Positioning

**Engineering name / repository name:** `duallane`

**Product name:** DualLane

**Chinese positioning:** 分流式安全会话工具

DualLane is a small-scale, self-hosted communication tool with two deliberately separated trust models:

- **P2P private lane:** one-to-one, no login, signaling-only server, content stays local unless the user explicitly saves it.
- **Audited relay lane:** GitHub login, invite-only accounts, RBAC, server-side message and file retention, and complete audit logs.

The product is not a generic chat app. Its core value is helping users choose the right communication lane before a conversation starts: private local-first transfer or managed auditable collaboration.

## 2. Target Users

DualLane is designed for personal use, small trusted teams, and self-hosted deployments where the operator wants:

- A quick private one-to-one transfer path for sensitive temporary conversations.
- A persistent workspace path for team chats, file exchange, and accountable operations.
- A polished responsive UI without the operational complexity of enterprise messaging systems.

## 3. Goals

- Provide a clear two-button entry point that separates private P2P conversations from audited server-side conversations.
- Keep the P2P lane privacy-first: no login, no server-side content storage, no platform account.
- Keep the relay lane accountable: invite-only GitHub login, RBAC, message retention, file quotas, and audit logs.
- Support small-scale self-hosting with simple deployment and maintainable code.
- Deliver a refined, modern, responsive interface suitable for open-source presentation.

## 4. Non-Goals

- No public open registration in the MVP.
- No enterprise SSO beyond GitHub OAuth in the MVP.
- No mobile push notifications in the MVP.
- No full-text search in the MVP.
- No multi-party P2P group chat in the MVP.
- No complex organization hierarchy in the MVP.
- No guarantee that P2P works across every network without optional TURN support.

## 5. Core Workflows

### 5.1 Entry

The first screen has two primary choices:

- **One-to-One Direct**
  - Privacy-first.
  - No login.
  - Server only handles temporary signaling.
  - Content is not stored by the server.

- **Workspace**
  - GitHub login required.
  - Invite-only platform account.
  - Supports one-to-one chats, group chats, files, retention, and audits.

The entry UI should avoid marketing-style content. It should feel like a precise tool surface:

- Centered layout.
- Two large choices.
- One clear icon per choice.
- One short explanatory sentence per choice.
- No extra panels when a single action is expected.

### 5.2 P2P Private Lane

Flow:

1. User clicks **One-to-One Direct**.
2. User enters a public display name.
3. User starts a session.
4. The app creates a session identifier and invite link.
5. User shares the invite link externally.
6. Another user joins through the link.
7. The page becomes a chat interface.
8. Users send text messages or files over the P2P connection.
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
- Text: "This session has ended."
- Primary action: "Save locally"
- Secondary action: "Close without saving"

Privacy note:

The MVP should phrase the P2P promise as "the server does not store conversation content." If the product later adds TURN relay support, the copy should say "content remains encrypted in transit and is not stored by the server" unless application-layer end-to-end encryption and key verification are implemented.

### 5.3 Audited Relay Lane

Flow:

1. User clicks **Workspace**.
2. User signs in with GitHub.
3. Backend checks whether the GitHub identity is associated with an accepted invite or existing account.
4. If allowed, the user enters the workspace.
5. Regular members see their conversation list and can start one-to-one chats by user ID.
6. Privileged users see additional actions such as creating invites, creating groups, managing members, and viewing audits.
7. Messages and files are stored on the server.
8. Actions are recorded in audit logs.

Regular member capabilities:

- View joined one-to-one and group conversations.
- Start a one-to-one conversation by user ID.
- Send messages.
- Upload and download files within quota.

Privileged capabilities:

- Create invitation links.
- Create group chats.
- Manage group members.
- View audit logs according to role.
- Configure retention where permitted.

## 6. Roles And Permissions

Initial role set:

| Role | Purpose |
| --- | --- |
| `owner` | Full system administration, role assignment, configuration, audit visibility. |
| `admin` | Invite creation, group creation, member management, operational audit visibility. |
| `member` | Normal chat user. Can start one-to-one chats by user ID and access joined conversations. |
| `auditor` | Optional read-only audit role. |

Recommended defaults:

- The first configured user becomes `owner`.
- Invite links can specify the resulting default role, but only `owner` can create privileged invites.
- `member` is the default role for normal invites.

## 7. Message Retention

Each relay conversation supports configurable retention.

MVP default:

- Keep the most recent `10000` messages per conversation.

Optional future policy:

- Retain messages for a configured number of days, such as `90` days.
- If both count-based and time-based retention are enabled, whichever limit removes a message first wins.

Retention behavior:

- Message retention applies to server-side messages in the relay lane.
- Attachments follow message lifecycle by default.
- Audit logs are not deleted by conversation retention.
- Audit retention is a separate system-level policy.

Recommended audit retention:

- Default: permanent for self-hosted MVP, or configurable later.
- Future option: `365` days minimum.

## 8. File Transfer And Quotas

The relay lane enforces a combined upload and download quota:

- **Limit:** `2 GiB / user / day`
- **Scope:** upload bytes plus download bytes combined.
- **Check:** before each upload or download starts.
- **Rule:** if the target file size exceeds today's remaining quota, reject the operation before transfer begins.

Quota formula:

```text
daily_limit = 2 GiB
used_today = successful_upload_bytes + successful_download_bytes
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
- Failed transfers should either release reserved quota or settle by actual transferred bytes, depending on implementation complexity.

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

## 9. Audit Logging

The relay lane keeps audit logs for security, accountability, and operations.

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

## 10. Data Model

Suggested initial tables:

| Table | Purpose |
| --- | --- |
| `users` | Platform users mapped to GitHub identities. |
| `invites` | Invite links, expiry, usage limits, and assigned default role. |
| `sessions` | Auth sessions for logged-in workspace users. |
| `conversations` | One-to-one and group conversations. |
| `conversation_members` | Membership records and conversation-local metadata. |
| `messages` | Server-retained relay lane messages. |
| `attachments` | Uploaded file metadata and storage references. |
| `transfer_ledger` | Upload/download quota accounting. |
| `audit_logs` | Durable operation logs. |
| `p2p_signal_rooms` | Temporary signaling room metadata, if persisted briefly. |

Important separation:

- P2P lane message and file contents must not be stored in relay message or attachment tables.
- Signaling room state should be short-lived and safe to discard.

## 11. Architecture

Recommended MVP stack:

- Frontend: React, Vite, TypeScript.
- Styling: local CSS design system with responsive layout.
- Icons: `lucide-react`.
- Backend: Go or Node/Fastify.
- Realtime: WebSocket.
- P2P: WebRTC DataChannel plus WebSocket signaling.
- Database: SQLite for self-hosted MVP.
- File storage: local filesystem volume.
- Deployment: Docker Compose.

Suggested services:

- `web`: frontend and API server, either integrated or reverse-proxied.
- `db`: not needed for SQLite MVP; use a mounted volume.
- `storage`: local mounted upload directory.
- Optional future `turn`: coturn for improved P2P connection success.

MVP deployment assumption:

- Small trusted deployment.
- HTTPS required for production WebRTC and secure OAuth callbacks.
- Public access should be protected by invite-only account checks.

## 12. UI Principles

Visual target:

- Minimal.
- Modern.
- Elegant.
- Responsive.
- Tool-first, not marketing-first.

Interaction rules:

- Single-step screens should show only the current action.
- Prefer one center icon, one short explanation, and one primary action.
- Avoid dense navigation until the user enters the workspace.
- Make trust mode visible in the chat surface.
- Keep P2P and relay visual states distinct but within one coherent design system.

Suggested layout:

- Entry: two large lane choices.
- P2P setup: centered single-action screen.
- P2P waiting: centered link sharing state.
- P2P chat: compact message surface with local-save status.
- Workspace desktop: conversation list on the left, active chat on the right.
- Workspace mobile: list and chat as separate navigable views.
- Admin/audit: quiet, table-first operational layout.

## 13. MVP Scope

Included:

- Two-lane entry screen.
- P2P one-to-one session creation and join link.
- WebRTC DataChannel text messaging.
- WebRTC DataChannel file transfer.
- P2P session end with local-save confirmation.
- GitHub OAuth login for relay lane.
- Invite-only account acceptance.
- RBAC with `owner`, `admin`, `member`, and optional `auditor`.
- Relay one-to-one conversations by user ID.
- Relay group conversations.
- Server-side message persistence.
- Conversation message retention by recent message count, default `10000`.
- File upload and download in relay lane.
- Combined upload/download quota of `2 GiB / user / day`.
- Transfer ledger.
- Audit logs for auth, invite, role, conversation, file, and quota events.
- Responsive polished UI.
- Docker Compose deployment.

Excluded from MVP:

- TURN relay by default.
- Multi-party P2P.
- Public registration.
- Push notifications.
- Full-text search.
- Complex message moderation.
- Enterprise SSO.
- Fine-grained per-room roles beyond basic membership.

## 14. Later Phases

Phase 2:

- Optional TURN relay with clear privacy copy.
- Time-based message retention.
- Export local P2P transcript.
- Admin dashboard for quota and storage usage.
- Search within joined relay conversations.
- Better file previews.

Phase 3:

- Application-layer end-to-end encryption for P2P with key verification.
- Optional encrypted relay-room mode.
- PostgreSQL support.
- Multi-device session management.
- Public open-source deployment templates.
- Backup and restore tooling.

## 15. Validation Plan

Prototype checks:

- Create P2P session and join from a second browser profile.
- Send text over WebRTC DataChannel.
- Transfer a file over WebRTC DataChannel.
- End P2P session and confirm local save prompt.
- Verify server does not persist P2P message or file content.
- Login with GitHub OAuth.
- Accept invite and create a workspace account.
- Verify regular user sees only allowed workspace actions.
- Verify admin can create invite and group chat.
- Send relay messages and confirm they persist after reload.
- Upload and download relay files.
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
- P2P signaling room lifecycle.

Launch criteria:

- Works on desktop and mobile widths.
- No unauthenticated access to relay conversations or files.
- P2P lane does not persist content server-side.
- Quota enforcement is backend-owned.
- Audit logs capture sensitive relay operations.
- Docker Compose can start the app from a clean checkout.

## 16. Open Questions

Recommended defaults are included where possible.

| Question | Recommended default |
| --- | --- |
| Backend language | Go for a compact self-hosted binary, or Node/Fastify if frontend velocity matters more. |
| Database | SQLite for MVP. |
| File storage | Local mounted volume. |
| P2P persistence | Ask at session end; default to not saving. |
| Relay message retention | Recent `10000` messages per conversation. |
| Relay file quota | Upload and download combined, `2 GiB / user / day`. |
| Audit retention | Permanent in MVP, configurable later. |
| TURN support | Post-MVP optional feature. |

