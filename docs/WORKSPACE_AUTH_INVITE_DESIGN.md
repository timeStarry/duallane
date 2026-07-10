# Workspace Authentication And Invite Design

## 1. Purpose

This document defines the productized authentication and invite experience for
DualLane shared spaces.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The design goal is simple:

> 进入共享空间应该像打开一个被邀请的熟人空间，而不是填写企业注册表。

Public entry stays minimal. Invite creation and member admission are powerful
actions, so they live inside Workspace and are visible only to permitted
members.

## 2. Principles

- The public Workspace page has one primary action: `使用 GitHub 登录`.
- Invite codes are created only after login by owner/admin members.
- Invite validation happens after GitHub identity is known.
- A user who is not invited gets a clear access state, not OAuth or database
  details.
- The first owner can enter through the seeded GitHub identity.
- Normal members do not see invite administration unless they have permission.
- Authentication state should never make the product feel like an enterprise
  console.

## 3. Public Entry Surface

Visible:

- Product label: `共享空间`.
- Short copy: `和熟人或小组长期共享聊天与文件。`
- Primary button: `使用 GitHub 登录`.
- Small note: `需要已有成员邀请后才能进入。`
- Optional secondary action: return to lane choice.

Hidden:

- Invite code input as a normal public form.
- Invite creation.
- Invite list.
- Member list.
- Role selector.
- Operation records.
- OAuth provider payloads.
- Request IDs, IP addresses, user agents, and platform logs.

The login page must not include text that implies open registration. It is an
entry screen for people who already have access or have received an invite link.

## 4. Entry States

| State | Meaning | Product behavior |
| --- | --- | --- |
| `workspace_disabled` | `WORKSPACE_ENABLED` is not true | Show `共享空间暂未开放。` and a return action. |
| `needs_login` | No valid session | Show GitHub login only. |
| `oauth_pending` | OAuth flow started | Keep page stable and show compact loading. |
| `owner_bootstrap` | Seeded owner identity matched | Create/bind owner session and enter. |
| `invite_pending` | Invite code is present but identity not known | Start/continue GitHub login; do not expose invite internals. |
| `invite_accepted` | Invite valid after OAuth | Create membership and enter. |
| `not_invited` | GitHub identity has no access | Show safe access copy and retry/login-switch action. |
| `invite_invalid` | Code expired, revoked, over-used, or malformed | Show contact-member copy. |
| `session_expired` | Existing session is invalid | Show login-required state and preserve lane context. |

Recommended copy:

| State | Copy |
| --- | --- |
| Disabled | `共享空间暂未开放。` |
| OAuth failed | `登录未完成，请重试。` |
| Not invited | `这个 GitHub 账号还没有加入共享空间。` |
| Invite invalid | `邀请不可用，请联系空间成员重新邀请。` |
| Session expired | `登录状态已过期，请重新进入共享空间。` |

Do not display raw OAuth errors, provider response payloads, stack traces, SQL
errors, or request IDs in normal UI.

## 5. First Owner Flow

Seeded owner:

| Field | Value |
| --- | --- |
| GitHub login | `timeStarry` |
| Email | `timestarry@qq.com` |
| Role | `owner` |
| User kind | `human` |

Flow:

1. Backend bootstraps default space and owner row.
2. Owner opens Workspace public entry.
3. Owner clicks `使用 GitHub 登录`.
4. OAuth callback returns GitHub identity.
5. Backend matches `github_login` or email to seeded owner.
6. Backend binds GitHub numeric ID when available.
7. Owner enters the default space.
8. Owner sees empty Workspace shell with actions appropriate to owner.

Owner first-run UI:

- Conversation list empty state.
- Quick actions: `发起私聊`, `创建群聊`, `邀请成员`.
- Space info: own role, quota, retention copy.
- No operation-record table or platform log surface in P0.

Security rules:

- Only the configured seeded identity can become the first owner.
- If a different GitHub account logs in without invite, reject access.
- The match should prefer GitHub numeric ID after the first successful bind.
- Login or email may bind an account only while its `github_id` is empty. Once
  bound, a different numeric ID must fail with `auth.identity_conflict` and
  write a rejected operation record.

## 6. Invite Creation Surface

Invite creation belongs inside Workspace:

- `空间 -> 邀请成员`
- `成员 -> 邀请成员`, if the member directory exposes a shortcut for owner/admin
- Empty-state shortcut for owner/admin when the space has no other members

Invite creation must not appear on:

- Public login page.
- Lane choice screen.
- Normal chat composer.
- Normal member directory for users without permission.

P0 invite UI:

- Button: `创建邀请`.
- Default role: `成员`.
- Create result: copyable invite link and invite code.
- One-click copy action.
- Short state copy: `邀请链接已复制。`
- Active invite list for owner/admin.
- Revoke action where permitted.

P1 invite UI:

- Expiry setting.
- Max-use setting.
- Richer invite filters/history.
- Safer privileged-role creation polish for owner.

## 7. Invite Data Model

Recommended fields:

| Field | Purpose |
| --- | --- |
| `id` | Internal invite ID. |
| `space_id` | Space scope. |
| `code_hash` | Hashed invite code. |
| `default_role` | Role granted after acceptance. |
| `max_uses` | Maximum accepted uses. |
| `uses` | Accepted use count. |
| `expires_at` | Optional expiry. |
| `revoked_at` | Revocation timestamp. |
| `created_by` | Member who created invite. |
| `created_at` | Creation timestamp. |
| `last_used_at` | Optional last accepted time. |

Rules:

- Store only hashed invite codes where practical.
- `member` is the default role.
- `admin` can create only member invites.
- `owner` can create privileged invites if the product exposes that control.
- Invite acceptance must be transactional with membership creation.
- Invite creation, acceptance, rejection, expiry, and revocation write operation
  records.

## 8. Invite Link Shape

Recommended external shape:

```text
https://example.com/?lane=workspace&invite=INVITE_CODE
```

Rules:

- Workspace invite codes are not private-lane `#k=` fragments.
- Private direct invite fragments remain browser-only and must not be sent to
  backend APIs.
- Workspace invite codes can be sent to the backend for validation after OAuth.
- Invite codes should not appear in server logs where avoidable.
- If a reverse proxy logs URLs, prefer short-lived codes and avoid exposing
  sensitive invite metadata in query parameters.

UX behavior:

- Opening an invite link shows the same public login page.
- The page still shows only GitHub login.
- After login, the backend validates the invite code and identity.
- If accepted, the user enters the space.
- If invalid, the page shows safe invite-unavailable copy.

## 9. Invite Acceptance Flow

Flow:

1. Invited person opens invite link.
2. Client stores invite context only for the login flow.
3. User clicks `使用 GitHub 登录`.
4. OAuth callback returns identity.
5. Backend checks feature flag, invite status, max uses, expiry, revocation, and
   role.
6. Backend creates or updates the user row.
7. Backend creates active `space_member`.
8. Backend increments invite use count.
9. Backend writes operation record.
10. Backend creates session and returns to Workspace shell.

Failure behavior:

| Cause | UI copy | Operation record |
| --- | --- | --- |
| Expired invite | `邀请已过期，请联系空间成员重新邀请。` | yes |
| Revoked invite | `邀请不可用，请联系空间成员重新邀请。` | yes |
| Max uses reached | `邀请已被使用完，请联系空间成员重新邀请。` | yes |
| User already member | Enter space or show already-joined state | optional |
| OAuth identity rejected | `这个 GitHub 账号还没有加入共享空间。` | yes |

The UI does not need to ask the user to paste an invite code in P0. A future
manual-code entry can be added inside a focused access recovery flow, but it
should not become the default public registration pattern.

## 10. Session Model

Session behavior:

- Workspace session is required for all Workspace APIs.
- Session cookie should be HTTP-only where applicable.
- Session expiry returns `auth.required` or `session.expired`.
- Logout returns the user to the entry state.
- Switching GitHub account is handled through GitHub OAuth/account selection,
  not through Workspace account forms.

Client behavior:

- Bootstrap decides whether the shell is `ready`, `needs_login`, `not_invited`,
  or `disabled`.
- Expired session preserves current lane and sends user to login.
- Pending drafts should remain local if session expiry occurs while composing,
  but they must not be sent until login succeeds again.

## 11. Permission Rules

Capability matrix:

| Action | owner | admin | member | auditor |
| --- | --- | --- | --- | --- |
| Enter after valid membership | yes | yes | yes | yes |
| Create member invite | yes | yes | no | no |
| Create admin invite | yes | no | no | no |
| Create owner invite | yes | no | no | no |
| Revoke own/member invite | yes | yes | no | no |
| Revoke privileged invite | yes | no | no | no |
| View active invite list | yes | yes | no | no |

Frontend gating is advisory. Backend permission checks are authoritative.

Denied action copy:

- `你当前不能邀请成员。`
- `你当前不能创建此类邀请。`
- `邀请操作失败，请重试。`

Do not display raw capability strings such as `invite.create_admin` in normal UI.

## 12. Operation Records

Database-only in P0:

- Login success.
- Login rejected: not invited.
- Invite created.
- Invite accepted.
- Invite rejected.
- Invite revoked.
- Session logout, optional.
- Permission rejection for invite actions.

Operation record fields may include actor, target, result, reason, IP, user
agent, request ID, and timestamp. These are not shown to normal members.
Owner/admin operation-record UI is deferred.

## 13. API Contract

Required:

- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`
- `POST /api/auth/logout`
- `GET /api/workspace/bootstrap`
- `POST /api/workspace/invites`
- `POST /api/workspace/invites/:code/accept`
- `POST /api/workspace/invites/:inviteId/revoke`

Invite list delivery:

- P0 may include visible invite rows in `GET /api/workspace/bootstrap` for
  owner/admin, instead of a separate list endpoint.
- A separate `GET /api/workspace/invites` remains a pagination/search endpoint
  for P1 if the space grows.

Error shape:

```json
{
  "error": {
    "code": "auth.not_invited",
    "message": "这个 GitHub 账号还没有加入共享空间。"
  }
}
```

Client must not rely on platform-specific OAuth errors for product branching.
Use stable Workspace codes.

Production OAuth callback rules:

- `start` stores an HTTP-only OAuth state cookie.
- `callback` must reject missing or mismatched OAuth state before exchanging the
  GitHub authorization code.
- Local development may use a seeded-owner fallback when GitHub OAuth config is
  absent; production must fail closed.

## 14. P0 / P1 / P2

P0:

- GitHub-only public login.
- Seeded owner binding.
- Invite-only access.
- Owner/admin create member invite inside Workspace.
- Copy invite link.
- Active invite list and revoke action for permitted owner/admin members.
- User-safe not-invited/invalid-invite states.
- Operation records persisted but hidden.

P1:

- Expiry and max-use controls.
- Invite search/filter/history.
- Privileged invite creation polish and stronger confirmations for owner.
- Manual code recovery flow if users need it.

P2:

- Multi-space invite routing.
- Additional identity providers.
- Device/session management.
- Invite request workflow, if the product needs a user-initiated access request.

## 15. Acceptance Checklist

- Public Workspace page shows only GitHub login as the primary action.
- Invite creation is impossible before login.
- Invite creation is visible only to owner/admin members.
- First owner `timeStarry` / `timestarry@qq.com` can bootstrap access.
- Uninvited GitHub users cannot enter Workspace.
- Invalid, expired, revoked, and over-used invites show safe copy.
- Invite acceptance writes operation records.
- Normal members cannot see invite internals, operation records, request IDs, or
  OAuth payloads.
- Private direct `#k=` invite fragments remain browser-only and are not mixed
  with Workspace invite handling.
