# Workspace Space Settings Design

## 1. Purpose

This document defines the productized `空间` and `空间设置` experience for
DualLane shared spaces.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

Space settings should not be the center of daily usage. The daily product is an
IM/shared-file space; settings exist so permitted members can manage access,
groups, capacity, and history without turning every screen into an admin panel.

## 2. Product Principle

> 设置是为了让空间可控，不是为了让普通成员感觉自己被管理。

Rules:

- Regular members see a useful `空间` information page.
- Owner/admin members see grouped management actions.
- Operation records remain database-only in P0.
- Settings are grouped by user intent, not by database table.
- Dangerous actions require confirmation.
- Daily chat, member discovery, and file sharing should not require opening
  settings.

## 3. Settings Layers

Workspace has two settings layers:

| Layer | Visible to | Purpose |
| --- | --- | --- |
| `空间信息` | all active members | Own identity, role, quota, history, trust copy. |
| `空间设置` | capability-based owner/admin | Invites, member roles, groups, capacity/history controls. |

Normal member `空间` view should feel like account/status information, not a
disabled admin console.

## 4. Regular Member Space View

Required content:

- Space name.
- Current user avatar/name.
- Friendly role label.
- Member count.
- Today's remaining transfer amount.
- Retention copy, such as `消息保留最近 10000 条`.
- Trust copy: `共享空间保存消息和文件，方便成员稍后查看。`
- Optional quick links:
  - `查看成员`
  - `查看文件`
  - `发起私聊`, if allowed

Hidden:

- Invite creation.
- Role management.
- Operation records.
- Request IDs.
- IP addresses and user agents.
- OAuth provider payloads.
- Transfer ledger rows.
- Raw permission names.

Empty/error treatment:

- If quota cannot load, keep the rest visible and show `传输额度暂时无法获取。`
- If membership changes remove the user, exit to access-lost state.

## 5. Privileged Settings Navigation

Owner/admin sees a grouped settings surface.

Recommended groups:

| Group | Purpose | P0/P1 |
| --- | --- | --- |
| `空间资料` | Name and basic display | P1 editable, P0 read-only. |
| `邀请成员` | Create/copy/revoke invites | P0 create/copy/list/revoke. |
| `成员权限` | View roles and change role where allowed | P0 basic owner controls, P1 confirmation polish. |
| `群聊管理` | Aggregate group overview when needed | P1; P0 group controls live in group details. |
| `容量与历史` | Quota and retention summaries/settings | P0 summary, P1 owner edits. |
| `危险操作` | Leave/archive/destructive actions | P1/P2. |

Operation records:

- Not visible in P0.
- If added later, use a separate privileged section and keep it away from daily
  chat surfaces.

## 6. Space Profile

P0:

- Display current space name, such as `默认空间`.
- Show internal slug only if needed for debugging and only in non-member
  developer surfaces.

P1:

- Owner can rename space.
- Optional space avatar/color.
- Basic display description.

Validation:

| Field | Rule | Copy |
| --- | --- | --- |
| Space name | Required, trimmed, reasonable length | `请输入空间名称。` |
| Duplicate/invalid | Backend validates | `空间名称暂不可用，请调整后重试。` |

UX:

- Rename is an inline form or small modal.
- No confirmation needed for simple rename.
- Realtime updates refresh rail and space view.

## 7. Invite Settings

P0 controls:

- `创建邀请`.
- Default role fixed to `成员` for admin.
- Copy invite link/code.
- Active invite list.
- Revoke invite where permitted.

Owner additions:

- Create privileged invite, if exposed.

P1 controls:

- Expiry.
- Max uses.
- Invite search/filter/history.
- Stronger confirmation flow for privileged-role invites.

Invite row fields:

- Invite status.
- Default role.
- Uses/max uses.
- Expiry.
- Created time.
- Copy action.
- Revoke action where permitted.

Copy:

- `邀请链接已复制。`
- `邀请已撤销。`
- `你当前不能邀请成员。`

Confirmation:

- Revoke invite requires confirmation.
- Creating a normal member invite does not require confirmation.
- Creating admin/owner invite requires confirmation if exposed.

## 8. Member Permission Settings

Member permission management belongs under `空间设置 -> 成员权限`, not in the
normal member directory.

P0:

- Show friendly role labels in member directory and settings.
- Role changes can remain backend-reserved if not needed for the current loop.

P1:

- Owner can promote member to admin.
- Owner can demote admin to member.
- Owner can transfer or add owner only through explicit confirmation.
- Last active owner cannot be demoted or removed.

Member permission row:

- Avatar.
- Display name.
- GitHub login.
- Current role label.
- Status.
- Capability summary, optional.
- Action menu, owner-only.

Role-change confirmation:

| Action | Confirmation copy |
| --- | --- |
| Promote to admin | `确认让此成员管理邀请和群聊？` |
| Demote admin | `确认取消此成员的管理权限？` |
| Add owner | `空间主人可以管理所有设置，请确认继续。` |
| Remove member | `移出后此成员将无法访问共享空间。` |

Normal UI should not show raw capability names.

## 9. Group Management Settings

Most group management is contextual:

- Create group from conversation create menu.
- Add/remove members from group details.
- Group files from group details.

Aggregate `群聊管理` settings are P1 and should be quiet:

- List groups.
- Member count.
- Last activity.
- Owner/admin shortcut to open group details.
- Archive/dissolve status if implemented later.

Do not duplicate all group settings in both aggregate settings and the group
drawer. The drawer is the source of normal group work.

## 10. Capacity And History Settings

P0 member-visible summary:

- `今日还可传输 ...`
- `每日上传和下载共用 2 GiB。`
- `此空间按会话保留最近 10000 条消息。`

P0 owner/admin view:

- Same summary.
- No ledger rows.
- No raw accounting table.

P1 owner controls:

- Change default retention count.
- Optional per-conversation retention summary.
- Storage usage overview, if implemented.

Rules:

- Backend quota enforcement remains authoritative.
- UI quota is advisory.
- Retention changes should explain the outcome and require confirmation if they
  can remove history sooner.
- Operation records are unaffected by message retention.

## 11. Dangerous Actions

Reserve a separate area for destructive actions.

Potential actions:

- Revoke invite.
- Remove member from space.
- Leave group.
- Leave space.
- Archive/dissolve group.
- Remove file.
- Change retention to a stricter policy.

Rules:

- Destructive actions are not inline primary buttons.
- Require confirmation with object name and outcome.
- Use clear action button text.
- Keep cancel available.
- Never expose internal IDs as confirmation proof.

P0 can implement only the actions that backend supports. The settings IA should
reserve room so later additions do not invade the chat surface.

## 12. Mobile Settings

Mobile settings use a stacked navigation model:

1. `空间` tab.
2. Section list.
3. Section detail.
4. Modal/sheet for confirmations.

Rules:

- Do not show settings beside chat on mobile.
- Keep back action clear.
- Forms should not cover active chat unless the user intentionally entered
  settings.
- Invite copy should be one tap.

## 13. State And Feedback

Loading:

- Show section-level skeletons.
- Keep loaded settings visible during refresh.

Empty states:

| Section | Copy |
| --- | --- |
| Invites | `还没有可用邀请。` |
| Members | `没有找到成员。` |
| Groups | `还没有群聊。` |
| Capacity | `容量信息暂时无法获取。` |

Errors:

- `设置保存失败，请重试。`
- `你当前不能修改此设置。`
- `无法撤销此邀请，请重试。`

Do not show stack traces, SQL errors, request IDs, OAuth details, IP addresses,
user agents, or ledger rows.

## 14. API Contract

Required or existing:

- `GET /api/workspace/bootstrap`
- `POST /api/workspace/invites`
- `GET /api/workspace/members`
- `POST /api/workspace/invites/:inviteId/revoke`
- `PATCH /api/workspace/members/:userId/role`
- `DELETE /api/workspace/members/:userId`
- Group member endpoints from the conversation/group contract.

Recommended P1:

- `GET /api/workspace/invites`
- `PATCH /api/workspace/space`
- `PATCH /api/workspace/policies/retention`

Responses should include capability hints, but backend authorization remains the
source of truth.

## 15. P0 / P1 / P2

P0:

- Regular member `空间` information view.
- Owner/admin invite creation, list, copy, and revoke inside settings/member
  surfaces.
- Basic owner member-role changes and member removal, with backend authority.
- Friendly quota and retention summary.
- No operation-record UI.
- No raw platform internals.

P1:

- Invite expiry/max-use/search polish.
- Stronger role-change and removal confirmations.
- Space rename.
- Group overview.
- Retention edit with confirmation.

P2:

- Operation-record review UI if product need is confirmed.
- Storage usage dashboard.
- Backup/export settings.
- Bot policy settings.
- Multi-space settings.

## 16. Acceptance Checklist

- Regular member space view is useful without showing admin controls.
- Owner/admin can find invite creation without using public login.
- Role controls do not appear in the normal member directory.
- Group settings are contextual to groups, with aggregate settings optional.
- Capacity/history copy is understandable and not ledger-like.
- Destructive settings require confirmation.
- Operation records stay database-only in P0.
- Settings do not become the default landing surface for daily Workspace usage.
