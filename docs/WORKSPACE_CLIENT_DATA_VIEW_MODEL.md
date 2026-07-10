# Workspace Client Data And View Model Design

## 1. Purpose

This document defines how the Workspace client should fetch, normalize, cache,
and project data into the productized shared-space UI.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

The goal is to make Workspace feel like an IM product:

- Conversation lists update without full page refresh.
- Member pickers and directories use the same member source.
- File cards, file library rows, and detail drawers reference the same
  attachment records.
- Realtime events project into the correct view without exposing event internals.
- Full refetch is a fallback, not the default answer to every change.

## 2. Client Data Domains

The client should treat Workspace data as related domains, not one flat state
object.

| Domain | Source | Primary consumers |
| --- | --- | --- |
| Session | bootstrap/auth endpoints | Shell, login state. |
| Current space | bootstrap | Rail, space info, settings. |
| Current member | bootstrap | Permission display, action gating. |
| Members | bootstrap and `GET /members` | Directory, pickers, group details. |
| Conversations | `GET /conversations`, events | Rail, mobile chat list. |
| Active messages | `GET /conversations/:id/messages`, events | Chat history. |
| Attachments | `GET /files`, message payloads, events | Chat cards, file library, details. |
| Invites | invite endpoints | Space settings only. |
| Quota summary | bootstrap or quota-capable responses | Rail, file library, transfer notices. |
| Realtime cursor | WebSocket ready/events | Reconnect and replay. |
| Local commands | client-only | Optimistic messages, uploads, retries. |

Normal members should never receive or store operation-record, ledger, IP,
request-log, OAuth-payload, or raw event-debug view models.

## 3. Bootstrap Contract

Bootstrap should answer:

- Is Workspace enabled?
- Is the user authenticated?
- Is the user an active member?
- Who is the current user?
- What is the current space?
- What capabilities should the client use for UI gating?
- What is the visible member seed list for small spaces?
- What is the quota summary?
- What is the latest known realtime sequence?

Suggested shape:

```json
{
  "workspace": {
    "enabled": true,
    "state": "ready"
  },
  "currentUser": {
    "id": "usr_01",
    "displayName": "timeStarry",
    "githubLogin": "timeStarry",
    "avatarUrl": null,
    "kind": "human"
  },
  "space": {
    "id": "spc_default",
    "name": "默认空间"
  },
  "membership": {
    "role": "owner",
    "roleLabel": "空间主人",
    "capabilities": [
      "invite.create_member",
      "conversation.create_direct",
      "conversation.create_group",
      "message.send",
      "file.upload",
      "file.download"
    ]
  },
  "members": [],
  "quota": {
    "dailyLimitBytes": 2147483648,
    "usedTodayBytes": 0,
    "reservedTodayBytes": 0,
    "remainingTodayBytes": 2147483648
  }
}
```

Rules:

- Bootstrap may include a small member list for P0.
- Bootstrap should not include all message history or all files if those lists
  can grow.
- Capability names are client hints only. The backend remains authoritative.
- User-facing role labels may be returned by the backend or mapped from a stable
  frontend table.
- Bootstrap should not expose OAuth readiness, operation-record policy markers,
  transfer ledger rows, request IDs, storage keys, or raw realtime sequence
  internals as product state.

## 4. Normalized Client Store

Recommended normalized collections:

```ts
type WorkspaceClientState = {
  session: WorkspaceSessionState;
  currentUserId: string | null;
  currentSpaceId: string | null;
  membersById: Record<string, MemberView>;
  conversationsById: Record<string, ConversationView>;
  conversationOrder: string[];
  messagesByConversationId: Record<string, MessageListView>;
  attachmentsById: Record<string, AttachmentView>;
  fileLibrary: FileLibraryView;
  invites: InviteSettingsView;
  quota: QuotaView | null;
  realtime: RealtimeView;
  localCommands: LocalCommandView;
};
```

Principles:

- Store canonical objects once and derive screen-specific rows from them.
- Keep local optimistic state separate from server-confirmed state.
- Do not store raw transport events as UI content.
- Preserve drafts and pending sends across list refreshes.

## 5. Member View Model

Member data powers directory, direct-chat picker, group creation, group details,
and future bot display.

Required fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable member ID. |
| `displayName` | Primary user-facing name. |
| `githubLogin` | Secondary identity for human users. |
| `avatarUrl` | Optional avatar. |
| `role` | Internal role for capability checks where needed. |
| `roleLabel` | Friendly label. |
| `kind` | `human` or future `bot`. |
| `status` | Active/removed if included. |
| `canStartDirect` | Derived from current user capability and member state. |

Fetch rules:

- P0 can seed members through bootstrap and refresh with `GET /members`.
- Directory, member picker, and group details should use the same source.
- Client-side search is acceptable for small P0 spaces.
- Backend search should be added before large spaces.

Projection:

- `workspace.member_joined` adds or updates member.
- `member.role_changed`, reserved, updates role label and capabilities if
  relevant.
- Removed members should no longer be offered in pickers.

## 6. Conversation View Model

Conversation rows should be derived from conversation view objects.

Required fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable conversation ID. |
| `type` | `direct` or `group`. |
| `displayTitle` | Row/header title. |
| `memberCount` | Group count or direct pair count. |
| `members` | Optional member IDs for small active contexts. |
| `otherMemberId` | Direct conversation helper. |
| `lastMessagePlainText` | Preview. |
| `lastActivityAt` | Sort key. |
| `createdAt` | Stable fallback sort key. |
| `canSendMessage` | Current-user capability for this conversation. |
| `canManageMembers` | Group details controls. |
| `unreadCount` | P1. |

Fetch rules:

- `GET /conversations` loads current joined conversations.
- Selecting a conversation loads messages for that conversation if not already
  fresh.
- Creating or reusing a direct conversation returns the canonical conversation
  and selects it.
- Creating a group returns the canonical conversation and selects it.

Ordering:

1. Pinned conversations, P1.
2. Unread conversations, P1.
3. `lastActivityAt` descending.
4. `createdAt` descending.

Projection:

- `conversation.created` inserts visible conversation.
- `conversation.member_added` updates count and member list; if current user was
  added, insert the conversation.
- `conversation.member_removed` updates count; if current user was removed,
  close composer and remove or mark inaccessible.
- `message.created` updates preview and sort order.

## 7. Active Message View Model

Message lists are conversation-scoped.

Recommended fields:

| Field | Purpose |
| --- | --- |
| `items` | Ordered message IDs or message objects. |
| `hasOlder` | Older retained history may exist. |
| `loadingOlder` | Pagination state. |
| `loadedAt` | Freshness check. |
| `pendingClientMessageIds` | Local optimistic messages. |
| `error` | Local fetch/send error. |

Message object fields:

- `id`
- `conversationId`
- `author`
- `kind`
- `clientMessageId`
- `plainText`
- `content`
- `attachments`
- `replyToMessageId`
- `createdAt`
- `status`, local-only for pending/failed

Projection:

- `message.created` appends or reconciles by `clientMessageId`.
- If active message payload is partial, fetch the message or recent messages.
- Unknown message event for inactive conversation only updates preview.
- Event gaps trigger active conversation refetch.

Retention:

- Message list should tolerate older messages disappearing after retention.
- UI should not show retention internals unless explaining history policy in
  details.

## 8. Attachment And File View Model

Attachments are first-class records.

Required fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable attachment ID. |
| `fileName` | Display name. |
| `mimeType` | File type. |
| `byteSize` | Size and quota comparison. |
| `uploaderId` | Display uploader. |
| `visibility` | `conversation` or `space`, with staging hidden in normal lists. |
| `conversationId` | Related conversation if applicable. |
| `status` | `pending`, `available`, `failed`, `removed`. |
| `createdAt` | Sort/filter. |
| `availableAt` | Display upload completion. |
| `canDownload` | Derived from visibility and current user capability. |
| `canRemove` | Derived for privileged actions. |

File library filters:

- `all`
- `conversation`
- `standalone`
- `mine`

Projection:

- `attachment.created` creates pending row only for the uploader or permitted
  context.
- `attachment.available` updates chat card and file library.
- `attachment.failed` updates uploader-local state.
- `attachment.removed`, reserved, marks file unavailable.
- `transfer.rejected` creates local notice and refreshes quota.

Rules:

- File detail, chat card, and file-library row should reference the same
  attachment view.
- Download never uses a stored file URL. It calls the backend download endpoint.
- Unknown or removed files remain understandable in old messages.

## 9. Quota View Model

Quota summary should be small and user-facing.

Fields:

| Field | Purpose |
| --- | --- |
| `dailyLimitBytes` | Total daily upload/download limit. |
| `usedTodayBytes` | Completed usage. |
| `reservedTodayBytes` | Optional active reservation summary. |
| `remainingTodayBytes` | Main user-facing value. |
| `resetsAt` | Optional future copy. |

Refresh triggers:

- Bootstrap.
- Upload reserve success or rejection.
- Upload complete/fail/cancel.
- Download reserve/rejection.
- `transfer.rejected` event.
- Manual refresh if state appears stale.

UI rules:

- Display remaining quota as friendly size.
- Do not show ledger details.
- Known impossible upload/download can warn before request.
- Backend remains authoritative.

## 10. Invite Settings View Model

Invite data belongs only to settings for permitted users.

Fields:

| Field | Purpose |
| --- | --- |
| `id` | Invite ID, if backend exposes it. |
| `code` | Copyable code when newly created or list policy allows. |
| `url` | Copyable invite URL. |
| `defaultRole` | Usually `member`. |
| `status` | `active`, `revoked`, `expired`, `used_up`. |
| `uses` | Used count. |
| `maxUses` | Max uses. |
| `expiresAt` | Optional. |
| `createdAt` | Display. |

Rules:

- Normal members do not have this view model.
- Public login never shows this view model.
- Revocation updates only settings state and does not create a shared chat
  message.

## 11. Realtime Projection

The client should use realtime events for targeted projection.

Event handling strategy:

| Event | Default client action |
| --- | --- |
| `workspace.member_joined` | Upsert member. |
| `conversation.created` | Upsert conversation if visible. |
| `conversation.member_added` | Update group members/count; insert conversation if current user added. |
| `conversation.member_removed` | Update group members/count; close current chat if current user removed. |
| `message.created` | Append/reconcile active messages; update row preview/order. |
| `attachment.created` | Show pending file for uploader/context. |
| `attachment.available` | Upsert attachment and update related cards/lists. |
| `attachment.failed` | Mark upload failed for uploader. |
| `transfer.rejected` | Show local notice and refresh quota. |
| Unknown active-scope event | Refetch relevant object. |

Rules:

- Deduplicate by event ID.
- Apply events in `seq` order.
- If a sequence gap is detected, enter `sync_required`.
- Do not show event IDs, sequence numbers, or raw payloads in normal UI.
- Do not project operation-record events into member UI in P0.

## 12. Refetch Policy

Use the smallest refetch that restores correctness.

| Situation | Refetch |
| --- | --- |
| Event gap at connection resume | Bootstrap, conversations, active messages, file library as needed. |
| Unknown active conversation event | Active conversation detail/messages. |
| Unknown file event | File library or attachment detail. |
| Permission denied on current conversation | Conversations list and active state. |
| Quota rejection | Quota summary. |
| Member picker stale | Members list. |
| Role/capability changed | Bootstrap. |

Avoid:

- Full page reload for every message.
- Refetching all messages for every `message.created` event when payload is
  enough to append or when a targeted latest fetch is enough.
- Destroying drafts or pending uploads during refetch.

## 13. Local Command Model

Local commands should be explicit client state.

Track:

- Pending message sends by `clientMessageId`.
- Failed message sends with retry data.
- Draft text by conversation ID.
- Pending uploads by upload ID.
- Upload failure/retry state.
- Local notices.
- Last seen realtime sequence.

Rules:

- Local command state must not be persisted as server truth.
- Optimistic messages reconcile with server messages.
- Failed uploads that released quota should not be shown as available files.
- Reconnect does not clear drafts or pending commands.

## 14. Screen Derivations

Screens derive their view data from normalized state.

Conversation rail:

- `conversationOrder`
- `conversationsById`
- `membersById` for direct titles/avatars
- local pending/failure indicators

Active chat:

- selected conversation
- message list for selected conversation
- attachment metadata by ID
- member metadata for authors and mentions
- local draft and pending commands

Details drawer:

- selected conversation
- member IDs and `membersById`
- attachments filtered by conversation
- current-user capabilities

File library:

- `attachmentsById`
- filter state
- `quota`
- member uploader metadata

Member directory:

- `membersById`
- current-user capabilities
- direct conversation creation state

Space settings:

- bootstrap membership/capabilities
- invite settings state
- members for role controls

## 15. P0 Acceptance Checklist

- Bootstrap does not expose operation records, transfer ledgers, OAuth payloads,
  or platform logs to normal members.
- Member directory, direct picker, and group picker share one member source.
- Conversation rows derive from canonical conversation state and update on
  message events.
- Active messages reconcile by `clientMessageId`.
- Attachments are shared across chat cards, file library, and detail surfaces.
- Quota summary updates after transfer-related actions.
- Realtime events are deduplicated and projected without raw event display.
- Event gaps trigger targeted refetch without losing drafts or pending commands.
- Full refresh is a fallback, not the normal projection path.
