# Workspace State And Feedback Design

## 1. Purpose

This document defines Workspace state, loading, empty, error, permission,
quota, reconnect, and confirmation behavior. It exists so the product can be
comprehensive without making normal operations feel complicated.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The product rule is:

> Feedback should explain the next useful action, not expose backend internals.

## 2. State Categories

Workspace UI state is grouped into these categories:

| Category | Examples | User-facing treatment |
| --- | --- | --- |
| Entry state | disabled, login needed, not invited | Full-page or entry-card state. |
| Session state | loading bootstrap, logged out, expired | Shell-level notice or redirect to login. |
| Data state | loading conversations, empty files | Local skeleton, empty copy, or retry. |
| Permission state | cannot invite, cannot create group | Hide action or show outcome copy. |
| Transfer state | upload pending, quota rejected | Local notice and file-row state. |
| Realtime state | connected, reconnecting, sync required | Quiet status in shell. |
| Local command state | sending, failed, retryable | Inline pending or failure affordance. |
| Destructive decision | revoke, remove, demote, leave | Confirmation modal/sheet. |

Operation records and platform logs are not user-facing state in P0.

## 3. Global State Model

Workspace shell states:

| State | Meaning | UI |
| --- | --- | --- |
| `disabled` | Feature flag is off | Show disabled shared-space state and return option. |
| `needs_login` | No valid Workspace session | Show public login screen. |
| `oauth_pending` | Login is in progress | Show compact loading state. |
| `not_invited` | GitHub identity has no access | Show safe not-invited copy. |
| `bootstrap_loading` | Session exists, data loading | Show shell skeleton. |
| `ready` | Member can use Workspace | Show shell. |
| `session_expired` | Session no longer valid | Show login-required notice and login action. |
| `offline` | Realtime unavailable | Keep shell usable where HTTP still works. |
| `fatal_error` | Cannot recover locally | Show retry and safe message. |

The app should avoid blank screens. Every global state needs a visible next
action.

## 4. Loading States

Use local loading, not full-shell blocking, whenever session identity is known.

Loading patterns:

| Surface | Pattern |
| --- | --- |
| Bootstrap | Shell skeleton with rail and center placeholders. |
| Conversation list | Compact list skeleton. |
| Message history | Top or center loading row. |
| File library | File-row skeleton. |
| Member directory | Member-row skeleton. |
| Details drawer | Drawer-local loading. |
| Upload | File chip/card progress. |
| Send message | Pending message row. |

Rules:

- Do not replace the whole shell when only one panel is loading.
- Keep existing data visible during refresh.
- Prefer `正在同步最新内容...` only when a replay gap requires refetch.
- Avoid spinner-only layouts when a skeleton or retained data is possible.

## 5. Empty States

Empty states should suggest a valid next action.

| Surface | Member copy | Owner/admin copy |
| --- | --- | --- |
| Conversations | `还没有会话。可以从成员列表发起私聊。` | `还没有会话。可以创建群聊或从成员列表发起私聊。` |
| Active chat | `还没有消息。` | `还没有消息。` |
| Files | `还没有文件。` | `还没有文件。可以上传一个文件。` |
| Members search | `没有找到成员。` | `没有找到成员。` |
| Group members | `还没有添加其他成员。` | `还没有添加其他成员。可以添加成员。` |
| Invite list | hidden for members | `还没有可用邀请。` |
| File filter | `没有找到匹配的文件。` | `没有找到匹配的文件。` |

Rules:

- Empty chat keeps composer available if sending is allowed.
- Empty conversation list should not show group creation to members who cannot
  create groups.
- Empty file library should not imply upload permission if the member cannot
  upload.
- Do not use long educational text to compensate for missing controls.

## 6. Permission Feedback

Permission feedback should be capability-based.

Action visibility:

| Action | Member treatment when not allowed |
| --- | --- |
| Create invite | Hidden. |
| Create group | Hidden in primary create menu. |
| Add/remove group member | Hidden in row actions. |
| Change role | Hidden outside owner settings. |
| View operation records | No screen/API in P0. |
| Download inaccessible file | Show safe denial if attempted through stale UI. |
| Send to inaccessible conversation | Hide composer or show access-lost state. |

Copy:

| Situation | Copy |
| --- | --- |
| Cannot create group | `你当前不能创建群聊。` |
| Cannot invite | `你当前不能邀请成员。` |
| Not conversation member | `你无法访问此会话。` |
| Removed from group | `你已不在此群聊中。` |
| Cannot access file | `你无法访问此文件。` |
| Need login | `登录后进入共享空间。` |

Rules:

- Backend permission errors remain authoritative.
- Frontend hiding is only a convenience.
- Do not show raw permission names such as `conversation.member.manage`.
- Do not leak resource existence through errors unless the actor could already
  know it exists.

## 7. Error Shape And User Copy

Workspace APIs should return stable error codes with safe messages.

Preferred shape:

```json
{
  "error": {
    "code": "quota.insufficient",
    "message": "今日传输额度不足"
  }
}
```

UI rules:

- Show `message` only if it is user-safe.
- Use `code` for client branching.
- Do not include or display `requestId` in normal UI responses.
- Do not display SQL errors, stack traces, OAuth payloads, IP addresses, user
  agents, transfer ledger statuses, or event sequences.

Common mappings:

| Code | UI copy |
| --- | --- |
| `auth.required` | `登录后进入共享空间。` |
| `auth.not_invited` | `这个 GitHub 账号还没有加入共享空间。` |
| `auth.identity_conflict` | `GitHub 身份与已有账号不一致，请联系空间主人。` |
| `workspace.disabled` | `共享空间暂未开放。` |
| `permission.denied` | `你当前不能执行此操作。` |
| `conversation.not_found` | `你无法访问此会话。` |
| `quota.insufficient` | `今日传输额度不足。` |
| `file.not_available` | `文件已不可用。` |
| `upload.failed` | `文件上传失败，请重试。` |
| `message.invalid_content` | `消息内容无法发送，请调整后重试。` |
| `message.idempotency_conflict` | `这条消息已发生变化，请重新发送。` |

## 8. Message Send States

Message send lifecycle:

```text
draft -> sending -> sent
draft -> sending -> failed -> retrying -> sent
```

States:

| State | UI |
| --- | --- |
| `draft` | Text in composer. |
| `sending` | Optimistic message row with pending state. |
| `sent` | Server message replaces optimistic row. |
| `failed` | Inline failure with retry/remove. |
| `retrying` | Pending style again. |

Rules:

- Reconcile by `clientMessageId`.
- Preserve draft on temporary network failure.
- Do not duplicate messages after retry.
- If server rejects for permission, stop retry loop and show safe denial.
- If idempotency conflict occurs, ask user to resend rather than silently
  changing content.

## 9. Upload States

Upload lifecycle:

```text
selecting -> reserving -> uploading -> completing -> available
selecting -> reserving -> quota_rejected
uploading -> failed_released
uploading -> cancelled_released
```

States:

| State | UI |
| --- | --- |
| `selecting` | Native file picker or drop target. |
| `reserving` | Small local progress indicator. |
| `uploading` | Progress chip/card. |
| `completing` | `正在完成上传...` where needed. |
| `available` | Normal file card/row. |
| `quota_rejected` | Local notice, no bytes transferred. |
| `failed_released` | Failure copy and retry if useful. |
| `cancelled_released` | Remove staged file. |

Copy:

- `今日传输额度不足，无法上传此文件。`
- `文件上传失败，请重试。`
- `文件大小与上传信息不一致，请重新选择文件。`

Rules:

- Backend reserve happens before bytes transfer.
- Failed or cancelled upload releases reserved quota.
- The UI should refresh remaining quota after reserve, complete, fail, or
  rejection.
- Failed upload should not appear to other members as an available file.

## 10. Download States

Download lifecycle:

```text
idle -> checking -> downloading
idle -> checking -> quota_rejected
idle -> checking -> access_denied
idle -> checking -> unavailable
```

States:

| State | UI |
| --- | --- |
| `idle` | Download button enabled if file appears available. |
| `checking` | Button local loading. |
| `downloading` | Browser download starts. |
| `quota_rejected` | Local notice. |
| `access_denied` | Safe denial copy. |
| `unavailable` | File removed/unavailable state. |

Copy:

- `今日传输额度不足，无法下载此文件。`
- `你无法访问此文件。`
- `文件已不可用。`

Rules:

- Backend checks visibility and quota before stream/token.
- Known insufficient quota can be warned in UI before click, but backend remains
  authoritative.
- Successful stream/token issuance counts as completed in P0.
- Rejected download does not consume quota.

## 11. Quota Feedback

Quota should prevent surprise without becoming an accounting UI.

Visible places:

- Rail compact hint: `今日还可传输 1.4 GiB`.
- File library top area.
- File detail warning.
- Upload/download rejection notices.

Not visible to normal members:

- Transfer ledger rows.
- Reservation IDs.
- Daily accounting queries.
- Request IDs.

States:

| State | UI |
| --- | --- |
| Enough quota | Normal upload/download controls. |
| Low quota | Compact hint, no interruption. |
| Known impossible transfer | Warning before request. |
| Backend rejected | Local notice and refreshed quota. |
| Reservation active | Optional local pending state, not ledger detail. |

## 12. Realtime And Reconnect States

Connection states:

| State | Copy |
| --- | --- |
| `connecting` | `正在连接...` |
| `ready` | No intrusive copy. Optional synced icon/text. |
| `reconnecting` | `正在重新连接...` |
| `sync_required` | `正在同步最新内容...` |
| `offline` | `连接暂时不可用。` |

Projection states:

- New message appends to active conversation.
- Conversation row preview and ordering update.
- New accessible conversation appears.
- Removed access closes composer and updates list.
- Group member list updates.
- File state updates in chat and file library.
- Transfer rejection appears as local notice.

Rules:

- Deduplicate by event ID.
- Reconcile messages by message ID and `clientMessageId`.
- On event gap, refetch relevant lists and active messages.
- Preserve pending local messages during reconnect.
- Do not expose event `seq` or debug payloads in normal UI.

## 13. Invite States

Invite creation is inside Workspace only.

Invite lifecycle:

```text
creating -> active -> copied
active -> revoked
active -> expired
active -> used_up
```

States:

| State | UI |
| --- | --- |
| `creating` | Button loading. |
| `active` | Show invite code/link and copy action. |
| `copied` | Toast or inline `已复制`. |
| `revoked` | Mark unavailable or remove from active list. |
| `expired` | Show expired state if list includes it. |
| `used_up` | Show used state if list includes it. |

Copy:

- `邀请链接已复制。`
- `邀请已过期，请重新创建。`
- `邀请已撤销。`
- `你当前不能邀请成员。`

Rules:

- Members without permission do not see invite creation.
- Public login does not show invite creation.
- Revoking invite requires confirmation.

## 14. Group Member Management States

Add member states:

| State | UI |
| --- | --- |
| Picker loading | Member picker skeleton. |
| No candidates | `没有可添加的成员。` |
| Adding | Button loading. |
| Added | Drawer member list updates. |
| Failed | Inline safe error. |

Remove member states:

| State | UI |
| --- | --- |
| Confirming | Modal with member name and group name. |
| Removing | Button loading. |
| Removed | Member list updates. |
| Failed | Inline safe error. |

Rules:

- Removing a member requires confirmation.
- Owner/admin cannot accidentally remove themselves from a row action in P0.
- Removing the last active member is rejected unless archive/dissolve is
  implemented.
- Removed current user sees access-lost state.

## 15. Destructive Confirmations

Confirm:

- Revoke invite.
- Remove group member.
- Remove space member.
- Change role to a more privileged role.
- Demote owner/admin.
- Remove file.
- Leave group or space.
- Dissolve/archive group when implemented.

Do not confirm:

- Normal message send.
- Normal upload when quota is sufficient.
- Normal download when quota is sufficient.
- Start direct chat.
- Open group details.

Confirmation requirements:

- Title describes the object and action.
- Body explains outcome in one sentence.
- Primary destructive button uses action text.
- Cancel is always available.
- The modal/sheet does not expose internal IDs.

## 16. Local Notices

Use local notices for actor-only outcomes.

Examples:

- Upload rejected.
- Download rejected.
- Message send failed.
- Invite copied.
- Reconnect in progress.
- Group member add failed.

Do not create shared chat messages for:

- Transfer ledger changes.
- Quota reservation/rejection.
- OAuth details.
- Local browser download failure.

Shared system messages are only for conversation-visible facts, such as member
joined/left or future group setting changes.

## 17. Accessibility And Responsiveness

Baseline state behavior:

- Loading and error states are reachable by keyboard.
- Buttons keep focus indication.
- Icon-only state buttons have labels or tooltips.
- Modal and sheet focus is contained.
- Error copy is not color-only.
- Long file names and member names truncate or wrap without breaking layout.
- Mobile sheets have clear close/back actions.

State copy should remain short. Long explanatory copy belongs in docs, not in
the active product surface.

## 18. P0 Acceptance Checklist

- No blank global states.
- Public login, disabled, not-invited, and ready states are distinct.
- Empty states suggest allowed next actions.
- Member-hidden actions do not appear as broken controls.
- Permission errors use safe outcome copy.
- Message retry does not duplicate accepted messages.
- Upload rejection occurs before bytes transfer and uses local notice.
- Failed upload releases quota and updates UI state.
- Download rejection occurs before stream/token and uses local notice.
- Reconnect preserves pending local commands and refetches on event gaps.
- Operation records, ledgers, request IDs, IP/user-agent data, OAuth internals,
  and event sequences are not shown to normal members.
