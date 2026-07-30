# Workspace Member And Permission Design

## 1. Purpose

This document defines Workspace membership, invites, roles, and permissioned
surfaces from a product perspective. It complements the backend contract by
describing what users should see and how actions should be grouped.

Detailed GitHub login, seeded owner, public entry, invite-link, and invite
acceptance rules live in
[Workspace Authentication And Invite Design](WORKSPACE_AUTH_INVITE_DESIGN.md).
Settings placement for invites and roles lives in
[Workspace Space Settings Design](WORKSPACE_SPACE_SETTINGS_DESIGN.md).

The product rule is simple:

> 权限要保护空间，但不应该让普通成员觉得自己在操作后台。

## 2. Member Lifecycle

Member states:

| State | Meaning | User-facing behavior |
| --- | --- | --- |
| `seeded_owner` | First owner inserted during bootstrap | Can enter after matching GitHub login/email. |
| `invited` | Invite exists but user has not completed OAuth | Not a member yet. |
| `active` | User belongs to the space | Can use permitted Workspace surfaces. |
| `removed` | Membership ended or was revoked | Loses access immediately. |
| `bot_reserved` | Future bot member | Display as bot, not human. |

MVP bootstrap:

- First owner: GitHub `timeStarry`, email `timestarry@qq.com`.
- The seeded owner is written into the database.
- On first successful OAuth match, GitHub numeric ID is bound to that user row.

Invite acceptance:

1. A permitted member creates an invite.
2. The invite is copied as a link or code inside Workspace.
3. The invited person opens the link.
4. The login page shows only GitHub login.
5. Backend validates OAuth identity and invite code.
6. If valid, user becomes an active member with the invite default role.

## 3. Roles

| Role | External label | Product meaning |
| --- | --- | --- |
| `owner` | 空间主人 | Owns the shared space and can change roles/policy. |
| `admin` | 管理员 | Helps manage members, invites, and groups. |
| `member` | 成员 | Normal daily user. |
| `auditor` | 预留角色 | Engineering-reserved role; no operation-record UI/API in first loop. |

Role tone:

- Use role labels only where they help users understand access.
- Avoid turning normal views into hierarchy displays.
- Show capabilities as actions: `邀请成员`, `创建群聊`, `管理成员`.

## 4. Capability Matrix

| Capability | owner | admin | member | auditor |
| --- | --- | --- | --- | --- |
| Enter after valid login/invite | yes | yes | yes | yes |
| View own space status | yes | yes | yes | yes |
| View visible space members | yes | yes | yes | yes |
| Create member invite | yes | yes | no | no |
| Create admin invite | yes | no | no | no |
| Create owner invite | yes | no | no | no |
| Revoke invite | yes | yes | no | no |
| Start direct conversation | yes | yes | yes | no |
| Create group conversation | yes | yes | no | no |
| Add/remove group member | yes | yes | no | no |
| View joined conversation | yes | yes | yes | limited/reserved |
| Send message | yes | yes | yes | no |
| Upload file | yes | yes | yes | no |
| Download visible file | yes | yes | yes | no |
| Change member role | yes | no | no | no |
| Change retention/quota policy | yes | no | no | no |
| View operation records | deferred | deferred | no | deferred |

Backend checks are authoritative. Frontend checks only hide unavailable actions
or provide clearer copy.

## 5. Permission Layers

Workspace permissions apply at multiple layers:

| Layer | Question answered |
| --- | --- |
| Space membership | Can this user enter the space? |
| Space role | Can this user invite, create groups, or manage policy? |
| Conversation membership | Can this user read/send in this conversation? |
| File visibility | Can this user see or download this attachment? |
| Transfer quota | Does this user have enough daily quota for upload/download? |
| Bot policy | Can a bot read messages or file content? Future. |

The UI should not expose these layers as a technical checklist. It should use
clear outcomes:

- `你可以发送消息`
- `你没有创建群聊的权限`
- `今日传输额度不足`
- `此文件只对会话成员可见`

## 6. Invite Design

Public login page:

- Only GitHub login.
- No invite input.
- No create-invite action.
- Optional short note: `需要空间成员邀请后才能进入。`

Inside Workspace:

- Owner/admin sees `邀请成员`.
- Invite creation is grouped under member management or space settings.
- Default invite creates `member`.
- Owner can create privileged invites if needed.
- Invite link copy should be one click.
- Invite code display should be readable and revocable where supported.

Invite fields:

- Role to grant.
- Max uses.
- Optional expiry.
- Created by.
- Created at.
- Revoked at.
- Uses count.

P0 invite UI:

- Create one-use member invite.
- Copy invite link.
- Show active invites to owner/admin if backend returns them.
- Revoke active invite where permitted.

P1 invite UI:

- Set expiry.
- Set max uses.
- Show used/expired state.

## 7. Member Directory And Fetching

Member data should be fetched once for the shell and reused where possible.

P0:

- Bootstrap includes visible members for small spaces.
- Member directory, group creation, and direct-chat picker reuse this data.
- Client-side filtering is acceptable.

Reserved API:

- `GET /api/workspace/members`
- Query support later:
  - `q`
  - `role`
  - `kind`
  - `cursor`
  - `limit`

Member item:

- Avatar.
- Display name.
- GitHub login.
- Friendly role.
- Action menu.

Action visibility:

- `发起私聊`: visible when direct conversations are allowed.
- `添加到群聊`: visible in group management context for owner/admin.
- `移出群聊`: visible in group management context for owner/admin.
- `修改权限`: visible only in space settings for owner.

## 8. Group Membership

Group membership is conversation-level access.

Rules:

- Owners/admins create groups.
- Group creator is included automatically.
- Initial members are selected during group creation.
- Owners/admins can add/remove group members.
- Regular members can view group members.
- Removed members lose access to group messages and group files immediately.
- New group members can see retained prior history in MVP.

Group member UI:

- Searchable list.
- Add member button for owner/admin.
- Remove action in row menu for owner/admin.
- Member count in header.
- Empty state for group with only creator: `还没有添加其他成员。`

Operation records:

- Group creation.
- Member added.
- Member removed.
- Permission rejection.

These records are stored in the database and not visible to normal members.

## 9. Role Management

Role management belongs under `空间设置 -> 成员权限`.

P0:

- Role data is shown as labels.
- Role changes can remain backend-reserved if not needed for the loop UI.

P1:

- Owner can change `member` and `admin` roles.
- Owner cannot accidentally remove the last owner.
- Confirmation modal for privilege escalation.
- Confirmation modal for owner/admin demotion.

P2:

- Custom capability bundles, if the product truly needs them.
- Separate bot policy management.

Role-change UX:

- Show current role.
- Explain outcome in one sentence.
- Confirm risky changes.
- Show user-safe error on rejection.

## 10. Member Removal And Leaving

P0 implements the basic removal and leaving foundation where the backend
endpoints are present. P1 can improve confirmation copy, recovery states, and
larger-space administration.

- Owner/admin can remove members from groups.
- Owner can remove members from space.
- Regular member can leave groups.
- Leaving the entire space requires confirmation.
- Removed users immediately lose access to conversations/files.
- Historical messages remain unless retention/deletion policy removes them.

Do not hard-delete user rows by default. Prefer membership state and removed
timestamps so audit records and message authors remain understandable.

## 11. Operation Records

Operation records are security and recovery data, not regular member content.

First loop:

- Write database rows.
- No normal member UI.
- No normal member API.
- Owner/admin operation-record UI deferred.

Record-worthy actions:

- Login success/rejection.
- Invite create/accept/reject/revoke.
- Conversation create.
- Group member add/remove.
- Message create rejection.
- File upload/download reserve/completed/failed/rejected.
- Quota rejection.
- Permission rejection.
- Role change, when implemented.

Do not expose:

- IP address.
- User agent.
- Request ID.
- OAuth provider errors.
- Stack traces.

## 12. Error And Empty-State Copy

Use action-oriented copy:

| Situation | Copy |
| --- | --- |
| Not logged in | `登录后进入共享空间。` |
| Not invited | `这个 GitHub 账号还没有加入共享空间。` |
| Invite expired | `邀请已过期，请联系空间成员重新邀请。` |
| No create-group permission | `你当前不能创建群聊。` |
| No invite permission | `你当前不能邀请成员。` |
| Not conversation member | `你无法访问此会话。` |
| Quota insufficient | `今日传输额度不足。` |

Avoid:

- `RBAC denied`
- `audit failure`
- SQL or stack traces
- OAuth provider internals
- `tenant` language

## 13. Backend Contract Notes

Required existing/near-term endpoints:

- `GET /api/workspace/bootstrap`
- `POST /api/workspace/invites`
- `POST /api/workspace/invites/:code/accept`
- `GET /api/workspace/conversations`
- `POST /api/workspace/conversations`
- `GET /api/workspace/conversations/:conversationId/messages`
- `POST /api/workspace/messages`
- File upload/download endpoints from the development contract.

Recommended additions for productized IM:

- `GET /api/workspace/members`
- `PATCH /api/workspace/groups/:conversationId`
- `POST /api/workspace/groups/:conversationId/members`
- `DELETE /api/workspace/groups/:conversationId/members/:userId`
- `PATCH /api/workspace/members/:userId/role`
- `POST /api/workspace/invites/:inviteId/revoke`

These additions can be P1 if P0 can meet the loop goal with existing endpoints,
but the UI should be designed around the stable concepts.

## 14. Acceptance Checklist

- Public Workspace entry has no invite form.
- Invite creation is available only after login and only to permitted users.
- Regular members can see members without seeing platform internals.
- Member picker is reused by direct-chat and group creation flows.
- Group membership is visible and configurable in a group details surface.
- Backend rejects unauthorized sensitive actions and writes operation records.
- User-facing errors are understandable and do not leak internals.
- Owner/admin controls are grouped under settings or contextual group/member
  management.

## 15. Implemented Member Visibility Policy

- Stored RBAC keeps owner as the authority role. When the viewer is not an
  owner, an owner is projected as admin / 管理员; authorization never uses this
  projected role.
- Owners can discover all active space members. Other roles can discover only
  themselves, users with an existing direct conversation, and users explicitly
  granted by an owner.
- Group membership is visible inside that group context but does not expand the
  global member directory.
- Direct-chat creation, group creation, and group-member addition all use the
  same server-side visibility check. Supplying a guessed user ID does not bypass
  discovery policy.
- Owner-managed grants use GET and PUT
  /api/workspace/member-visibility/:userId; rejected management attempts are
  audited.
