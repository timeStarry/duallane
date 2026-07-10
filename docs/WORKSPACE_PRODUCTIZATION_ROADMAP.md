# Workspace Productization Roadmap

## 1. Purpose

This document turns the Workspace design set into an implementation-ready
productization roadmap.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is not to add ceremony. The goal is to keep the development loop from
shipping a technically capable but flat and confusing Workspace.

## 2. Productization Definition

Workspace is productized when a normal member can:

1. Enter through GitHub after being invited.
2. See joined conversations in a clear IM layout.
3. Start a direct chat from members.
4. Use group chat with a real details surface.
5. Send structured messages.
6. Upload and download files with quota feedback.
7. Browse files without finding the original message.
8. Understand space status, quota, and history without seeing platform internals.

Owner/admin can additionally:

1. Invite members from inside Workspace.
2. Create groups.
3. Manage group members contextually.
4. See settings grouped by intent.

Operation records are persisted but not surfaced in P0.

## 3. Non-Negotiable Gates

P0 Workspace cannot be considered productized if any of these are false:

- Public Workspace login shows only GitHub login.
- Invite creation is inside Workspace and permissioned.
- Workspace remains disabled unless `WORKSPACE_ENABLED=true`.
- Regular members cannot see operation records, transfer ledgers, request IDs,
  OAuth payloads, IP addresses, user agents, or platform logs.
- Conversation list, active chat, and details are separate surfaces.
- Mobile does not squeeze rail, chat, and drawer into one screen.
- Structured message protocol is used instead of a plain text-only body.
- Attachments can exist without messages.
- Upload/download quota is checked before transfer.
- Failed upload releases quota.
- Rejected sensitive operations write database records.
- P2P private direct content is not persisted by Workspace services.

## 4. P0 Implementation Slices

Recommended sequence:

| Slice | Outcome | Why first |
| --- | --- | --- |
| 1. Auth and invite entry | GitHub-only login, owner bootstrap, invite-only access | Establishes safe gate. |
| 2. Data model foundation | Spaces, members, conversations, messages, attachments, ledger, events, audit | Avoids prototype compatibility work. |
| 3. Permission and operation records | RBAC enforcement and DB records | Prevents UI from masking backend gaps. |
| 4. API contract | Product-shaped bootstrap, members, conversations, messages, files, and WS payloads | Prevents raw table leakage and client guesswork. |
| 5. Shell IA | Rail, active view, context drawer, mobile panes | Fixes flat product structure early. |
| 6. Conversations | List, direct chat, group creation/details | Core IM experience. |
| 7. Structured messages | Blocks, idempotency, render fallback | Enables future bot/mentions/files. |
| 8. Files and quota | Reserve/upload/complete/fail/download, library | High-risk quota behavior. |
| 9. Realtime projection | Events, replay, targeted client updates | Makes product feel alive. |
| 10. Settings surfaces | Space info, invite controls, quota/history summaries | Keeps privileged controls contained. |
| 11. Visual/mobile/accessibility pass | Component density, pane transitions, focus, text fit | Prevents desktop-only or flat finish. |

The slices can overlap in code, but each should have a reviewable outcome.

## 5. P0 Screen Acceptance

Public login:

- One primary button: `使用 GitHub 登录`.
- No invite form or invite creation.
- Disabled/not-invited states are safe and understandable.

Workspace shell:

- Desktop rail, active surface, context drawer.
- Mobile list/main/details panes.
- Primary tabs: `聊天`, `文件`, `成员`, `空间`.

Chat:

- Conversation rows distinguish `私聊` and `群聊`.
- Rows show preview and activity time.
- Chat header shows title, type/member count, trust copy, details action.
- Empty chat keeps composer available if allowed.
- Failed/pending messages are visible.

Groups:

- Group creation is a modal/sheet.
- Group details have overview, members, files, settings.
- Regular members do not see add/remove controls.

Files:

- File library is a primary view.
- Chat file card and file library row use the same attachment model.
- Download action always calls backend.
- Quota rejection is local notice.

Members:

- Directory shows avatar/name/GitHub login/role label.
- Direct chat starts from member row or picker.
- Role management is not inline in the normal directory.

Space:

- Regular member sees own status, role, quota, history, trust copy.
- Owner/admin can create, list, copy, and revoke invites from settings.
- Operation records are not shown.

## 6. P0 Backend Acceptance

Authentication:

- Seeded owner can bind GitHub identity.
- Uninvited user is rejected.
- Invite acceptance is transactional.

Permissions:

- Member cannot create invite or group.
- Non-member cannot read/send conversation.
- Removed group member loses access.
- Backend is authoritative.

Messages:

- Structured content is validated.
- `clientMessageId` idempotency works.
- Unknown/invalid blocks are rejected or safely handled.

Files/quota:

- Upload reserve happens before bytes.
- Upload content validates byte count.
- Upload failure releases quota.
- Download checks quota before stream/token.
- Attachments can be standalone.

Events:

- Event `seq` is monotonic per space.
- Event visibility is filtered.
- Reconnect can replay or trigger sync.
- `transfer.rejected` is actor-local.

Operation records:

- Sensitive successes/rejections are persisted.
- No normal member API exposes records.

## 7. P0 Client Data Acceptance

- Bootstrap does not include platform internals.
- Member directory and pickers share data.
- Conversations are normalized and sorted by latest activity.
- Messages reconcile by `clientMessageId`.
- Attachments are reused across chat/file/detail surfaces.
- Quota summary refreshes after transfer actions.
- Events project into the right views.
- Full refetch is fallback, not every-event default.
- Drafts and pending commands survive reconnect/refetch.

## 8. P1 Productization

P1 improves daily polish after P0 is structurally correct:

- Conversation/member/file search with backend pagination.
- Invite expiry, max-use, search, and history controls.
- Group settings polish around rename, leave, and archive/dissolve affordances.
- Richer unread counts and mention badges beyond the mark-read foundation.
- Mentions and mention badges.
- Reactions.
- File detail drawer and retry failed upload.
- Role-management confirmation and recovery polish for owner.
- Better tablet layout.

P1 should not start until P0 avoids the flat-page failure mode.

## 9. P2 Productization

P2 expands capability:

- Message edit/delete.
- Rich previews and file text extraction.
- Browser/OS push notifications.
- Bot execution and bot access approval.
- Storage usage dashboard.
- Backup/export.
- Owner/admin operation-record review UI if product need is confirmed.
- Multi-space switching.
- Optional encrypted shared-space rooms with a separate trust explanation.

## 10. Review Checklist By Role

Regular member review:

- Can I chat without opening settings?
- Can I find files without knowing which message had them?
- Can I find a member and start a direct chat?
- Do I understand today's transfer capacity?
- Am I shielded from logs, request IDs, ledgers, and OAuth details?

Owner/admin review:

- Can I invite someone after logging in?
- Can I create a group without cluttering the chat screen?
- Can I add/remove group members from group details?
- Can I understand where capacity/history settings will live?
- Are dangerous actions confirmed?

Developer review:

- Does every visible action have backend authorization?
- Are sensitive rejections recorded?
- Are P2P content boundaries preserved?
- Is the UI using product terms instead of internal terms?
- Can realtime projection update without full reload?
- Do API responses and database projections hide internal fields by default?
- Does the UI pass the visual anti-pattern checks?

## 11. Documentation Map For Development

Before implementing a slice:

1. Read [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md).
2. Read the relevant domain document:
   - Auth/invite: [Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md)
   - Layout/UI: [Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md)
   - Screens: [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
   - Visual system: [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
   - API contract: [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
   - Data model: [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)
   - Conversations: [Workspace Conversation And Group Design](WORKSPACE_CONVERSATION_GROUP_DESIGN.md)
   - Members: [Workspace Member And Permission Design](WORKSPACE_MEMBER_PERMISSION_DESIGN.md)
   - Files/quota: [Workspace File And Quota Design](WORKSPACE_FILE_QUOTA_DESIGN.md)
   - Messages: [Workspace Message Protocol](WORKSPACE_MESSAGE_PROTOCOL.md)
   - Events: [Workspace Realtime Event Design](WORKSPACE_REALTIME_EVENT_DESIGN.md)
   - Client data: [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
   - Mobile/a11y: [Workspace Mobile And Accessibility Design](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)
3. Check P0 gates in this roadmap.
4. Check the relevant persona/screen/backend rows in
   [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md).
5. Implement the smallest slice that leaves the product more coherent.
6. Run required validation from `AGENTS.md`.

## 12. Completion Definition

P0 is complete when:

- Required tests pass: `pnpm test`, `pnpm lint`, `pnpm build`.
- Manual product checks pass for desktop and mobile.
- Public login and invite surfaces follow this design.
- Regular member and owner/admin experiences are clearly different but coherent.
- No normal member surface exposes platform internals.
- The UI hierarchy matches the IM product model.
- Visual hierarchy follows [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md).
- API and schema behavior follow [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
  and [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md).
- Persona, screen, backend, realtime, quota, and disclosure checks pass
  [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md).
- Backend permission, quota, retention, event, and operation-record guarantees
  are enforced.
