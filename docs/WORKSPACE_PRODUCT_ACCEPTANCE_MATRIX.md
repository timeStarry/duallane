# Workspace Product Acceptance Matrix

## 1. Purpose

This document defines how to judge whether Workspace is productized enough for
the first full development loop.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The acceptance goal is not "more screens." The goal is that Workspace feels
like a clear, friendly IM space while still enforcing login, invitations,
permissions, structured messages, file quota, realtime sync, and operation
records.

Use this matrix with:

- [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md)
- [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
- [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
- [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)

## 2. Release Gates

P0 cannot pass if any gate fails:

| Gate | Required result |
| --- | --- |
| Workspace feature flag | Disabled by default unless `WORKSPACE_ENABLED=true`. |
| Public entry | Shows GitHub login only; no invite management. |
| Invite-only access | Uninvited GitHub accounts cannot enter. |
| Seeded owner | `timeStarry` / `timestarry@qq.com` can become first owner. |
| UI hierarchy | Desktop separates rail, active surface, and context drawer. |
| Mobile hierarchy | Mobile shows one primary task at a time. |
| Member privacy | Normal members cannot see operation records or platform internals. |
| Message protocol | Shared-space messages are structured, not plain body-only. |
| Files | Attachments can exist without messages. |
| Upload quota | Quota is reserved before bytes are accepted. |
| Upload failure | Failed upload releases quota. |
| Download quota | Quota is checked before stream/token issuance. |
| Operation records | Sensitive successes/rejections are persisted. |
| P2P boundary | P2P plaintext message/file content is not persisted by Workspace. |

## 3. Persona Matrix

### Visitor

| Scenario | Acceptance |
| --- | --- |
| Opens shared-space entry | Sees `共享空间`, concise copy, and `使用 GitHub 登录`. |
| Looks for invite form | No invite form or invite creation exists on public page. |
| Workspace disabled | Sees disabled shared-space copy and path back to lane choice. |
| OAuth rejected | Sees safe not-invited copy, no provider internals. |

### Invited member

| Scenario | Acceptance |
| --- | --- |
| Opens invite link | Login remains GitHub-only; invite code is not a public form. |
| Completes GitHub OAuth | Backend accepts invite transactionally and creates membership. |
| Invite expired/revoked | Sees contact-space-member copy. Operation record is written. |
| Enters first time | Lands in shared-space shell, not settings by default. |

### Regular member

| Scenario | Acceptance |
| --- | --- |
| Opens Workspace | Sees joined conversations, files, members, and space info. |
| Starts direct chat | Can select a visible member from picker/directory. |
| Opens group chat | Can read messages and inspect group members/files. |
| Sends message | Composer accepts user text and creates structured message. |
| Uploads file in chat | Upload reserves quota, then file appears as chat file card. |
| Uploads standalone file | File appears in file library and is not tied to a message. |
| Downloads file | Backend checks visibility and quota before transfer. |
| Quota insufficient | Sees friendly quota notice; no bytes transfer. |
| Looks for logs | Cannot see operation records, ledgers, request IDs, OAuth data, IP, or user agent. |
| Uses mobile | Can move between list, chat, details, files, members, and space without compressed columns. |

### Owner/admin

| Scenario | Acceptance |
| --- | --- |
| Invites member | Finds invite creation after login in space/member settings. |
| Creates group | Uses focused modal/sheet with group name and member selection. |
| Manages group members | Uses group details member tab, not an always-visible admin strip. |
| Sees settings | Settings are grouped by intent and not mixed into daily chat. |
| Attempts risky action | Confirmation is required for revokes/removals/role changes. |
| Reviews operation records | No UI in P0; rows exist in database only. |

### Removed or permission-limited user

| Scenario | Acceptance |
| --- | --- |
| Removed from group | Loses message/file access immediately. |
| Opens old group URL | Sees safe access copy without leaked resource details. |
| Attempts forbidden mutation | Request is rejected, operation record is written. |
| Receives realtime update | Inaccessible event payloads are not delivered. |

## 4. Screen Matrix

| Screen/surface | P0 acceptance |
| --- | --- |
| Public login | One primary GitHub login action; no invite/admin controls. |
| Shell | Product navigation for chat, files, members, space. |
| Conversation list | Direct/group distinction, preview, activity time, create menu. |
| Active chat | Header, message history, composer, file button, details action. |
| Conversation details | Overview, members, files, settings where permitted. |
| Direct member picker | Search/filter over visible members; current user excluded. |
| Group creation | Name input, member selection, selected count, inline validation. |
| File library | Visible files, upload, filters or scoped sections, download. |
| File detail | Metadata, visibility, related conversation, quota warning. |
| Member directory | Avatar/name/GitHub/role label and direct-chat action. |
| Space info | Own identity, role, quota, retention, trust copy. |
| Space settings | Invite creation and privileged controls grouped by intent. |
| Local notices | Quota, upload, copy, reconnect, and operation result feedback. |

## 5. Task Path Targets

Common paths should stay short:

| Task | Target path |
| --- | --- |
| Open recent chat | Enter Workspace -> select conversation. |
| Start direct chat | Members or create menu -> pick member. |
| Create group | Create menu -> enter name and select members -> create. |
| Inspect group members | Group chat -> details -> members. |
| Upload chat file | Chat -> file button -> choose file. |
| Find file | Files -> filter/search or select row. |
| Download file | File row/card -> download. |
| Invite member | Space/settings -> invite -> create/copy. |
| Check quota | Rail or space info; context warning near file actions. |

Anti-target:

- Regular chat/file tasks must not require opening space settings.
- Public entry must not require invite-code form interaction.
- Normal download must not require confirmation when quota is sufficient.

## 6. Backend Behavior Matrix

| Area | Acceptance |
| --- | --- |
| Auth | Session is cookie-backed; actor identity server-derived. |
| Invite | Code stored hashed; accept is transactional. |
| Permissions | Every endpoint rechecks permission server-side. |
| Conversations | Direct reuse works; group creation validates role and members. |
| Messages | Blocks validated; `plainText` generated/verified; idempotency works. |
| Files | Reservation/content/complete/fail lifecycle is enforced. |
| Quota | Reserved and completed bytes count; failed/rejected do not. |
| Events | Per-space `seq` monotonic; visibility filtering applied. |
| Audit | Sensitive success/rejection rows are written. |
| Errors | Stable code and user-safe message; no internals. |

## 7. Realtime Matrix

| Event | Product result |
| --- | --- |
| `conversation.created` | Conversation appears for accessible members. |
| `conversation.member_added` | Group member list/count updates. |
| `conversation.member_removed` | Removed user loses access; remaining members see updated list. |
| `message.created` | Active chat appends; list preview/order updates. |
| `attachment.created` | Uploader sees pending/uploading state. |
| `attachment.available` | File appears in chat/library/details. |
| `attachment.failed` | Uploader sees failure and quota is released. |
| `transfer.rejected` | Actor sees local quota/permission notice only. |
| `sync.required` | Client refetches affected product surface. |

The UI must not render event sequence numbers or raw event payloads as product
content.

## 8. File And Quota Matrix

| Scenario | Acceptance |
| --- | --- |
| File smaller than remaining quota | Reserve succeeds; upload/download proceeds. |
| File larger than remaining quota | Reject before transfer; show quota copy; write operation record. |
| Upload network failure | Client calls fail when possible; server releases reserved quota. |
| Complete without content | Completion rejected; attachment not available. |
| Actual byte mismatch | Upload fails safely; quota released or corrected by policy. |
| Download after access loss | Rejected before stream/token. |
| Standalone file | Listed in file library without message reference. |
| Message retention cleanup | Does not hard-delete standalone attachment by default. |

## 9. Information Disclosure Matrix

Normal members may see:

- Own identity and role label.
- Space member list.
- Joined conversations.
- Visible files.
- Remaining daily transfer quota.
- Retention copy.
- Friendly permission/quota errors.

Normal members must not see:

- Operation records.
- Transfer ledger rows.
- OAuth raw payloads or provider tokens.
- Request IDs.
- IP addresses.
- User agents.
- Storage keys.
- Filesystem paths.
- Raw SQL or stack traces.
- Event sequence/debug payloads.

Owner/admin may see:

- Invite controls.
- Group creation and group member controls.
- Role labels and future role-management settings.
- Capacity/history summaries.

Still hidden in P0:

- Operation-record UI/API.
- Platform logs.

## 10. Manual Review Script

Run these checks before considering P0 complete:

1. Start with `WORKSPACE_ENABLED` unset or false and confirm Workspace is gated.
2. Enable Workspace and open public entry. Confirm only GitHub login is shown.
3. Login as seeded owner and verify owner bootstrap.
4. Create a member invite inside Workspace.
5. Login as invited user and verify regular member shell.
6. As regular member, start a direct chat from member directory.
7. As owner/admin, create a group with selected members.
8. Send text, link, and attachment messages.
9. Upload a standalone file from file library.
10. Download a visible file.
11. Attempt an upload/download larger than remaining quota.
12. Remove a group member and verify access loss.
13. Refresh/reconnect and verify realtime replay or refetch.
14. Inspect normal member UI for hidden internals.
15. Inspect database for operation records for sensitive operations.
16. Verify P2P private direct content has not been persisted in Workspace
    message/file tables.

## 11. Automated Validation

Required commands for Workspace implementation changes:

```bash
pnpm test
pnpm lint
pnpm build
```

Minimum durable tests:

- Seeded owner binding.
- Uninvited rejection.
- Invite acceptance.
- Role capability matrix.
- Direct conversation reuse.
- Group create/member add/remove permission.
- Structured message validation and idempotency.
- Attachment can exist without message.
- Upload reserve before bytes.
- Failed upload quota release.
- Download quota rejection before transfer.
- Event sequence and visibility filtering.
- Operation records written but not exposed to normal members.
- Workspace disabled by default.
- P2P content boundary.

## 12. Product Completion Definition

Workspace P0 is complete when:

- Release gates pass.
- Manual review script passes on desktop and mobile widths.
- Required automated validation passes.
- UI hierarchy matches the screen matrix.
- Regular member experience is daily-use oriented.
- Owner/admin controls are discoverable but contained.
- API/data contracts are implemented without exposing platform internals.
- Remaining gaps are explicitly classified as P1/P2 and do not block the normal
  chat, member, file, invite, quota, or realtime foundation.
