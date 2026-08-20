# Workspace File And Quota Design

## 1. Purpose

This document defines the Workspace file product surface, attachment lifecycle,
visibility rules, and transfer quota behavior.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

Workspace files are not only chat attachments. They are first-class shared-space
records that can be attached to messages, listed in the file library, downloaded
later, and controlled by quota and visibility rules.

File search/filter behavior is defined in
[Workspace Search And Discovery Design](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md).
Quota rejection and file failure notices are defined in
[Workspace Notification And Unread Design](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md)
and [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md).

## 2. Product Principles

- File sharing should feel natural inside chat.
- The file library should work without forcing users to find the original
  message.
- Attachments can exist without messages.
- Upload and download are quota-controlled before transfer starts.
- Failed uploads release reserved quota.
- Download must check remaining quota before issuing a stream or token.
- Quota copy should be clear and friendly, not accounting terminology.
- Backend quota enforcement is authoritative.
- Content-addressed storage can deduplicate physical bytes, but visibility and
  quota remain properties of each logical Workspace resource or transfer.

## 3. User-Facing Concepts

| Internal term | External term | Meaning |
| --- | --- | --- |
| Attachment | 文件 | Uploaded file metadata and stored content. |
| Message attachment | 聊天文件 | File referenced by a message. |
| Standalone attachment | 独立文件 | File uploaded to the file library without a message. |
| Transfer quota | 今日传输额度 | Combined upload/download capacity for today. |
| Transfer ledger | Transfer record | Internal accounting table, not shown to normal members. |
| Reservation | Pre-transfer hold | Internal capacity reservation before transfer. |

Normal UI should say:

- `今日还可传输 1.4 GiB`
- `今日传输额度不足`
- `此文件对会话成员可见`
- `此文件对空间成员可见`

Avoid normal UI terms:

- `ledger`
- `reservation`
- `quota transaction`
- `storage key`

## 4. File Entry Points

Workspace files have two primary entry points.

Chat attachment:

- User is in an active conversation.
- User clicks file button in the composer.
- File is uploaded and referenced by a message or displayed as a chat file card.
- Visibility defaults to the current conversation.

File library:

- User opens `文件`.
- User uploads a standalone file.
- File is visible according to its selected policy, defaulting to space-visible
  in MVP if standalone upload is exposed.
- File can be downloaded later without finding a message.

Secondary entry points:

- Group details `文件` tab lists files in that group.
- Direct conversation details show files shared in that direct chat.
- Member profile can later show files shared with that member, P2.

## 5. Attachment Data Contract

Recommended fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable attachment ID. |
| `space_id` | Owning space. |
| `uploader_id` | User who uploaded the file. |
| `file_name` | Original safe display name. |
| `mime_type` | Detected or declared MIME type. |
| `byte_size` | Stored byte size. |
| `sha256` | Optional content hash. |
| `storage_object_id` | Canonical content-addressed object reference. |
| `storage_key` | Legacy compatibility path/key. |
| `visibility` | `private_staging`, `conversation`, or `space`. |
| `conversation_id` | Required for conversation-visible attachments. |
| `status` | `pending`, `available`, `failed`, `removed`. |
| `created_at` | Reservation/metadata creation time. |
| `available_at` | Upload completion time. |
| `failed_at` | Failure time. |
| `removed_at` | Removal time. |

Message attachment link table:

| Field | Purpose |
| --- | --- |
| `message_id` | Message reference. |
| `attachment_id` | Attachment reference. |
| `created_at` | Link time. |

The same attachment may be referenced by a message and still remain a first-class
file record.

## 6. Visibility Model

| Visibility | Visible to | Typical use |
| --- | --- | --- |
| `private_staging` | Uploader and privileged operators | Upload reserved but not published. |
| `conversation` | Active members of one conversation | Chat attachment or group file. |
| `space` | Active members of the space | Standalone shared file. |

Rules:

- A file must be `available` before normal download.
- Conversation-visible files require active conversation membership.
- Space-visible files require active space membership.
- Removed space members lose access to space-visible and conversation-visible
  files.
- Removed group members lose access to files visible only through that group.
- Owner/admin operational access can be policy-controlled, but normal UI should
  not expose bypass semantics.

P0 default:

- Chat upload uses `conversation` visibility.
- File library upload uses `space` visibility.
- `private_staging` is used internally during upload.

## 7. Attachment Lifecycle

```text
private_staging/pending
  -> available/conversation
  -> removed

private_staging/pending
  -> available/space
  -> removed

private_staging/pending
  -> failed
```

Lifecycle states:

| Status | Meaning | User-facing behavior |
| --- | --- | --- |
| `pending` | Upload reserved or content in progress | Show uploading/progress state. |
| `available` | File can be listed/downloaded | Show normal file row/card. |
| `failed` | Upload failed and quota released | Show retry or failure copy to uploader. |
| `removed` | File no longer downloadable | Show removed state where references remain. |

Message retention interaction:

- Message retention may remove old message rows or message-to-attachment links.
- Message retention must not hard-delete standalone attachments by default.
- A chat attachment remains a file record even if the referencing message ages
  out, unless a separate file cleanup policy removes it.

Standalone file interaction:

- Standalone files are valid product objects.
- They can later be referenced in messages if policy allows.
- They appear in the file library with `独立文件` visibility/type copy.

## 8. Upload Flow

P0 upload endpoints:

- `POST /api/workspace/files/uploads/reserve`
- `PUT /api/workspace/files/uploads/:uploadId/content`
- `POST /api/workspace/files/uploads/:uploadId/complete`
- `POST /api/workspace/files/uploads/:uploadId/fail`

Flow:

1. Client sends file metadata and intended visibility.
2. Backend verifies authentication and permission.
3. Backend calculates remaining daily transfer quota.
4. If file size exceeds remaining quota, backend rejects before bytes are
   accepted and writes an operation record.
5. If allowed, backend creates a transfer ledger reservation and pending
   attachment.
6. Client uploads bytes.
7. Backend validates actual bytes against declared size.
8. Client completes upload.
9. Backend marks transfer completed and attachment available.
10. Backend emits realtime events.

Reserve request:

```json
{
  "fileName": "demo.pdf",
  "mimeType": "application/pdf",
  "byteSize": 123456,
  "visibility": "conversation",
  "conversationId": "conv_01"
}
```

Rules:

- Declared `byteSize` is required.
- Backend must not accept content before quota reservation succeeds.
- Actual stored size must match the reservation or fail safely.
- Failed or cancelled upload releases reserved quota.
- Rejected upload does not consume quota.
- Upload rejection writes an operation record.

## 9. Upload Failure And Release

Failure cases:

| Case | Quota result | File result |
| --- | --- | --- |
| Quota insufficient at reserve | No quota consumed | No available attachment. |
| Permission rejected at reserve | No quota consumed | No available attachment. |
| Network failure before complete | Reserved quota released on fail/timeout cleanup | Attachment `failed`. |
| Actual byte mismatch | Reserved quota released or corrected by policy | Attachment `failed`. |
| Storage write failed | Reserved quota released | Attachment `failed`. |
| Complete called without content | Reserved quota released or stays pending until timeout | Completion rejected. |

Product copy:

- `文件上传失败，请重试。`
- `今日传输额度不足，无法上传此文件。`
- `文件大小与上传信息不一致，请重新选择文件。`

Implementation requirement:

- Provide an explicit fail/cancel path where the client can release quota.
- P0 performs server-side opportunistic cleanup for stale `pending` uploads
  during quota reads/reservations.
- A later scheduled cleanup job can make this proactive, but quota correctness
  must not rely only on the client releasing abandoned uploads.

## 10. Download Flow

P0 download endpoints:

- `POST /api/workspace/files/:attachmentId/downloads/reserve`
- `GET /api/workspace/files/:attachmentId/download`

Flow:

1. User clicks download.
2. Backend verifies file exists, is available, and is visible to the user.
3. Backend checks today's remaining transfer quota.
4. If file size exceeds remaining quota, backend rejects before stream/token and
   writes an operation record.
5. If allowed, backend reserves and completes the download ledger step when the
   stream or token is issued.
6. File downloads.

Rules:

- The backend must check quota before any file bytes are sent.
- Rejected downloads do not consume quota.
- A successful token/stream issuance counts as completed in MVP.
- Failed client-side save after stream issuance does not release quota in MVP
  because bytes may already have left the server.

User-facing behavior:

- Normal download starts immediately.
- If insufficient quota is known from UI state, warn before the request.
- Backend rejection is still authoritative.

Copy:

- `今日传输额度不足，无法下载此文件。`
- `你无法访问此文件。`
- `文件已不可用。`

## 11. Quota Contract

MVP quota:

- `2 GiB / user / day`
- Upload and download share the same limit.
- Day boundary uses server time unless a later deployment setting specifies a
  timezone.

Formula:

```text
daily_limit = 2 GiB
used_today = completed_upload_bytes + completed_download_bytes + active_reserved_bytes
remaining_today = daily_limit - used_today

if requested_bytes > remaining_today:
  reject_before_transfer
else:
  reserve_and_continue
```

Important distinction:

- `reserved` counts temporarily so concurrent transfers cannot bypass quota.
- `completed` counts as used.
- `released`, `failed`, and `rejected` do not count.

### Content-Addressed Storage And Logical Accounting

- Attachments, profile avatars, and custom emotes can reference one canonical
  object for the same SHA-256 digest. Only one active primary physical object is
  retained, and it is removed after the last logical reference is released.
- Deduplication does not grant access across resources. Every attachment,
  avatar, or emote still applies its own owner, visibility, membership, and
  lifecycle checks.
- Daily transfer quota continues to count the logical bytes uploaded or
  downloaded for each request. Reusing an existing canonical object does not
  make an accepted transfer free, and multiple downloads count independently.
- The registry is limited to server-retained Workspace content. P2P message and
  file payloads are excluded and must not be persisted for deduplication.

Personal emotes have a separate storage allowance rather than using the daily
transfer ledger:

```text
local_emote_limit = 1 GiB per user
local_emote_bytes = unique logical emote rows with local placement
subscription_only_bytes = active subscription targets without local placement
```

- `local_emote_bytes <= 1 GiB` is allowed; `1 GiB + 1 byte` is rejected.
- There is no total emote-item or collection-count limit. One collection remains
  limited to 100 items.
- Active subscription-only bytes are reported separately and do not count
  toward `local_emote_bytes`.
- Disabling a subscription converts its retained snapshot to local accounting,
  so the server preflights the full post-disable byte total.
- Source deletion must preserve a detached snapshot even when that snapshot
  places the user over 1 GiB. Existing content remains readable, while later
  local additions are rejected until usage is back within the limit.

Transfer ledger fields:

| Field | Purpose |
| --- | --- |
| `id` | Transfer record ID. |
| `space_id` | Space scope. |
| `user_id` | Accounted user. |
| `attachment_id` | File reference when available. |
| `direction` | `upload` or `download`. |
| `byte_size` | Reserved/accounted bytes. |
| `status` | `reserved`, `completed`, `released`, `failed`, `rejected`. |
| `reason` | Failure or rejection reason. |
| `created_at` | Ledger creation time. |
| `completed_at` | Completion time. |
| `released_at` | Release time. |

## 12. File Library Experience

Primary view: `文件`

Top controls:

- Search/filter, P1.
- Upload button.
- Tabs:
  - `全部`
  - `会话文件`
  - `独立文件`
  - `我上传的`

List fields:

- File icon.
- Name.
- Size.
- Uploader.
- Upload time.
- Visibility: `空间`, `会话`, or `独立文件`.
- Related conversation when applicable.
- Status.
- Download action.

Empty states:

| State | Copy |
| --- | --- |
| No files | `还没有文件。` |
| No filtered results | `没有找到匹配的文件。` |
| Upload not allowed | `你当前不能上传文件。` |
| Quota exhausted | `今日传输额度已用完。` |

The file library is a primary Workspace view. It should not be only a sidebar
inside chat.

## 13. Chat File Cards

Chat file card fields:

- File icon.
- File name.
- Size.
- Uploader or sender.
- Status.
- Download button.

States:

- Uploading.
- Available.
- Failed.
- Removed.
- Quota warning.

Rules:

- Download buttons still call backend quota/visibility checks.
- Removed files remain understandable in old messages.
- Unknown file types use a generic file icon.
- Do not show internal storage paths.

## 14. File Detail Drawer

P1 feature, but reserve the design:

Content:

- File name.
- Size and MIME/type.
- Uploader.
- Upload time.
- Visibility.
- Related conversation/message.
- Download action.
- Quota warning.

Privileged actions, later:

- Remove file.
- Change visibility.
- View operation summary if owner/admin UI is added.

Normal members should not see storage key, filesystem path, request ID, ledger
records, IP address, or user agent.

## 15. Realtime Events

File-related events:

- `attachment.created`
- `attachment.available`
- `attachment.failed`
- `attachment.removed`, reserved
- `transfer.rejected`

Product behavior:

- Uploading file appears as pending for the uploader.
- Available file appears in chat and/or file library.
- Failed upload changes to retry/failure state for uploader.
- Download rejection appears as local notice, not a group chat system message.
- Other members should see available files, not internal reservation states.

Payload should not expose ledger internals to normal clients.

## 16. Permissions And Operation Records

Permission checks:

- Space membership before listing space files.
- Conversation membership before listing conversation files.
- Upload permission before reserve.
- Download visibility and quota before stream/token.
- Attachment must be available before download.

Operation records:

- Upload reserve.
- Upload completed.
- Upload failed/released.
- Upload rejected.
- Download reserve/completed.
- Download rejected.
- Permission rejection.
- File removal when implemented.

Operation records are database-only in the first full Workspace loop.

## 17. AI Bot File Access

Bot-compatible design:

- Bots can see files only according to explicit policy.
- Bot file access levels:
  - `metadata_only`
  - `text_preview`
  - `full_content`
- A message referencing a file does not automatically grant full file-content
  access to a bot.
- Bot file-content reads should write operation records.

No bot execution or file extraction is required in P0. The file model should
only avoid blocking future bot policies.

## 18. P0 / P1 / P2

P0:

- Upload reserve/content/complete/fail.
- Upload failure releases quota.
- Download checks quota before transfer.
- Chat attachment upload.
- Standalone file upload.
- File library list.
- Conversation/group file list.
- User-safe quota and visibility errors.
- Canonical content-addressed objects with logical attachment/avatar/emote
  references and last-reference cleanup.
- Separate 1 GiB personal-emote accounting with active subscription-only bytes
  excluded.

P1:

- File search/filter.
- File detail drawer.
- Retry failed upload.
- File removal.
- Invite or permission-aware file visibility choices.
- Scheduled stale upload cleanup job.

P2:

- File preview and text extraction.
- Storage usage dashboard.
- Expiry/cleanup policy.
- Backup/export.
- Bot file-content approval workflow.

## 19. Acceptance Checklist

- Attachments can exist without messages.
- Chat attachments and standalone files use the same attachment model.
- Upload is rejected before bytes when quota is insufficient.
- Failed upload releases reserved quota.
- Download checks remaining quota before stream/token issuance.
- Rejected download does not consume quota.
- File list hides storage paths and ledger internals.
- Normal members cannot see transfer ledger rows or operation records.
- Message retention does not hard-delete standalone files by default.
- Backend permission and quota checks are authoritative.
- Physical CAS deduplication does not reduce logical transfer accounting or
  merge resource visibility.
- P2P file bytes are never written to the Workspace object registry.
