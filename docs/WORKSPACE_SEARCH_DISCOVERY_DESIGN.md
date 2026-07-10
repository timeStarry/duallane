# Workspace Search And Discovery Design

## 1. Purpose

This document defines search, filtering, and discovery behavior for Workspace.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

Search is a product aid, not a replacement for clear navigation. P0 can use
client-side filtering for small spaces, but the information architecture should
reserve paths for conversation, member, and file search without flattening the
whole product into one global results page.

## 2. Principles

- Put search near the object being searched.
- P0 filters can be local when the loaded data set is small.
- Full-text message search is not required in P0.
- Results must respect permissions and visibility.
- Search should never expose hidden conversations, files, members, operation
  records, or platform internals.
- Empty results should suggest the next useful action.
- Search should speed up normal tasks, not add required steps.

## 3. Search Surfaces

| Surface | P0 behavior | P1 behavior |
| --- | --- | --- |
| Conversation list | Local filter over loaded conversations | Backend conversation search. |
| Member directory | Local filter over loaded members | Backend member search/pagination. |
| Member picker | Same member source as directory | Backend search for large spaces. |
| File library | Local filter over loaded files if available | Backend file search/filter. |
| Group details members | Local filter | Backend search if group is large. |
| Messages | Not required | Conversation-scoped message search. |
| Global search | Not required | Optional command palette or unified search. |

P0 should still include visible search fields or filter affordances where the
list can become hard to scan, but the backend does not need full-text indexes in
the first loop.

## 4. Conversation Discovery

Conversation list controls:

- Search input or search button.
- Create menu:
  - `发起私聊`
  - `创建群聊` when permitted.
- Sections:
  - `最近`
  - `置顶`, P1.

Conversation search fields:

- Display title.
- Other member display name for direct chat.
- GitHub login of other member for direct chat.
- Group member names, P1/P2 if backend supports it.
- Latest `plainText` preview, local P0 optional.

Result row:

- Same as normal conversation row.
- Do not create a different visual language for search results.

Empty copy:

- `没有找到会话。`
- If user can start direct chat: `可以从成员列表发起私聊。`
- If owner/admin can create group: `也可以创建一个群聊。`

Rules:

- Search only over conversations the member can access.
- Do not reveal inaccessible conversation names through search.
- Selecting a result opens the conversation and clears or preserves the query
  based on local UX continuity.

## 5. Member Discovery

Member directory search fields:

- Display name.
- GitHub login.
- Friendly role label, filter P1.
- User kind, future bot/human filter.

Member picker behavior:

- Direct-chat picker excludes current user.
- Group-add picker excludes existing group members.
- Removed/inactive members are hidden unless an owner settings context needs to
  show status.
- Directory and pickers share the same member source.

Member result row:

- Avatar or initials.
- Display name.
- GitHub login.
- Friendly role label.
- Contextual action:
  - `发起私聊` in directory/direct picker.
  - `添加` in group-add picker.
  - Role settings only under `空间设置 -> 成员权限`.

Empty copy:

- Directory: `没有找到成员。`
- Direct picker: `还没有可发起私聊的成员。`
- Group add picker: `没有可添加的成员。`

Rules:

- Normal member directory does not expose database IDs.
- Search does not expose audit or login provider metadata.
- Future bot members should be findable by display name and marked clearly as
  bot members.

## 6. File Discovery

File library filters:

- `全部`
- `会话文件`
- `独立文件`
- `我上传的`

P1 filters:

- Conversation.
- Uploader.
- File type.
- Date range.
- Status.

Search fields:

- File name.
- Uploader display name.
- Related conversation title.
- MIME/type category, P1.

File result row:

- File icon.
- File name.
- Size.
- Uploader.
- Upload time.
- Visibility/scope.
- Related conversation when applicable.
- Status.
- Download action.

Empty copy:

- `没有找到匹配的文件。`
- If no files at all: `还没有文件。`

Rules:

- Search only returns files visible to the current member.
- Download still goes through backend quota and visibility checks.
- Storage keys, filesystem paths, transfer ledger rows, and request IDs are
  never searchable or displayed.

## 7. Message Search

Message search is deferred to P1 because P0 already has enough product surface:
login, invite, conversations, structured messages, files, quota, realtime, and
settings.

Reserved P1 behavior:

- Search within current conversation first.
- Later, search across joined conversations.
- Results use server `plainText`.
- Structured blocks are not rendered as raw JSON.
- Unknown blocks remain searchable through `plainText` fallback only if the
  server indexed them safely.

Message result row:

- Conversation title.
- Sender.
- Snippet.
- Timestamp.
- Attachment indicator if file-only.

Permission rules:

- Only joined, visible conversations.
- Removed members do not search conversations they can no longer access.
- Search does not expose retained/deleted messages beyond current policy.

## 8. Global Search

Global search is optional P2. If added, it should be a command palette or
dedicated search surface, not a replacement for tabs.

Potential scopes:

- Conversations.
- Members.
- Files.
- Current conversation messages.

Do not include:

- Operation records in normal member search.
- Transfer ledger rows.
- OAuth payloads.
- Request IDs.
- IP addresses.
- User agents.

## 9. Ranking And Sorting

P0 local sorting:

Conversation results:

1. Exact title/member match.
2. Prefix title/member match.
3. Recent activity.
4. Created time.

Member results:

1. Exact display name or GitHub login.
2. Prefix match.
3. Current group/direct relevance.
4. Stable display name order.

File results:

1. Exact file name match.
2. Prefix file name match.
3. Recent upload/availability time.
4. Larger context relevance, such as current conversation.

P1 backend search should preserve permission filtering before ranking.

## 10. Query Interaction

Rules:

- Search fields should be clearable.
- Empty query returns the normal list.
- Search should not block realtime updates.
- If a new matching item arrives through realtime, it appears in the filtered
  list.
- If an item no longer matches or access is removed, it disappears.
- Keep keyboard focus stable while filtering.

Mobile:

- Search opens inline at top of the current screen or as a focused sheet.
- The back action closes search before leaving the screen.
- Results should not cover the composer unless user is searching in chat.

## 11. API Contract

P0:

- Existing list endpoints may return enough data for client-side filtering:
  - `GET /api/workspace/conversations`
  - `GET /api/workspace/members`
  - `GET /api/workspace/files`

P1 recommended:

- `GET /api/workspace/conversations?q=&cursor=&limit=`
- `GET /api/workspace/members?q=&role=&kind=&cursor=&limit=`
- `GET /api/workspace/files?q=&scope=&uploaderId=&conversationId=&cursor=&limit=`
- `GET /api/workspace/conversations/:conversationId/messages/search?q=&cursor=&limit=`

Response requirements:

- Return only visible objects.
- Include display-ready fields.
- Avoid raw storage paths, internal IDs that are not product IDs, provider
  payloads, request IDs, and ledger data.

## 12. State And Feedback

Loading:

- Local filtering has no loading state.
- Backend search uses row skeletons or compact `正在搜索...`.

Empty:

- `没有找到会话。`
- `没有找到成员。`
- `没有找到匹配的文件。`
- `没有找到消息。`, P1.

Errors:

- `搜索失败，请重试。`
- Keep existing list visible when search fails if possible.

Permission:

- Do not show `permission denied` for absent results unless user attempted to
  open a stale result.

## 13. P0 / P1 / P2

P0:

- Conversation list local filter.
- Member directory and picker local filter.
- File library basic filters.
- Permission-safe result handling.

P1:

- Backend search and pagination for members/files/conversations.
- Conversation-scoped message search.
- File filters by conversation/uploader/type.

P2:

- Unified command palette.
- Cross-conversation message search.
- Saved filters or recent searches.
- Search result keyboard navigation.

## 14. Acceptance Checklist

- Search is scoped to the current product surface.
- Search never exposes inaccessible conversations, files, members, or internals.
- Member directory and pickers share the same member source.
- File search/filter does not bypass download quota checks.
- Empty results provide useful next actions.
- P0 can work with client-side filtering without blocking future backend search.
