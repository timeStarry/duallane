# Workspace Message Protocol

## 1. Purpose

Shared-space messages must not be a plain `body TEXT` protocol. The workspace lane needs a versioned structured protocol that can support normal chat, files, mentions, links, emoji, replies, reactions, system messages, realtime delivery, and future AI bot members without changing the trust model each time.

The protocol has three layers:

- **Client commands:** what a client asks the server to do, such as create a message or add a reaction.
- **Persisted messages:** the canonical server-stored message shape.
- **Realtime events:** server-published events for WebSocket subscribers.

The server owns canonicalization, permission checks, attachment checks, timestamps, author identity, bot eligibility, and audit decisions. Client-submitted protocol data is input, not truth.

## 2. Design Goals

- Preserve a readable `plainText` summary for previews, search, notifications, and fallback rendering.
- Store structured content blocks for mentions, links, emoji, attachments, and future extensions.
- Keep attachments as first-class records, not inline text.
- Support idempotent retries through `clientMessageId`.
- Make system and bot messages explicit instead of pretending they are user text.
- Make AI bot triggers and file access policy computable by the server.
- Keep protocol upgrades possible through versioned envelopes and content formats.

## 3. Versioning

All protocol envelopes include a numeric `version`. Message content also includes a format string:

```json
{
  "version": 1,
  "content": {
    "format": "duallane.message+json;v=1"
  }
}
```

Compatibility rules:

- Servers must reject unsupported major versions.
- Clients must tolerate unknown block types by using `plainText` fallback.
- New optional fields should be additive.
- Breaking changes require a new content format version.

## 4. Client Command Envelope

Client commands are sent to HTTP endpoints or WebSocket command channels. A command is a request, not a persisted message.

```json
{
  "version": 1,
  "type": "message.create",
  "clientCommandId": "cmd_01J0Y4H0M5V9WZ0EHQ5MZ3Q79X",
  "payload": {
    "conversationId": "conv_01",
    "clientMessageId": "local_7d5c2f",
    "replyToMessageId": null,
    "content": {
      "format": "duallane.message+json;v=1",
      "plainText": "@Alice please check demo.pdf",
      "blocks": [
        { "type": "mention", "userId": "usr_alice", "label": "Alice" },
        { "type": "text", "text": " please check " },
        { "type": "attachment", "attachmentId": "att_demo_pdf" }
      ]
    },
    "attachmentIds": ["att_demo_pdf"]
  }
}
```

Rules:

- `clientCommandId` deduplicates command submissions when the transport retries.
- `clientMessageId` deduplicates message creation and powers optimistic UI.
- The server derives `authorId` from the authenticated session.
- The client must not set `id`, `authorId`, `createdAt`, `editedAt`, `deletedAt`, `kind`, `ai`, `audit`, or operation-record fields.
- The server validates membership, permissions, retention policy, attachment ownership/availability, and quota policy before accepting the command.

## 5. Persisted Message Shape

The server stores canonical messages after validation.

```json
{
  "id": "msg_01J0Y4K1W16D4YQA8JEQ5VN9WE",
  "version": 1,
  "conversationId": "conv_01",
  "author": {
    "id": "usr_01",
    "displayName": "timeStarry",
    "kind": "human"
  },
  "clientMessageId": "local_7d5c2f",
  "kind": "user",
  "content": {
    "format": "duallane.message+json;v=1",
    "plainText": "@Alice please check demo.pdf",
    "blocks": [
      { "type": "mention", "userId": "usr_alice", "label": "Alice" },
      { "type": "text", "text": " please check " },
      { "type": "attachment", "attachmentId": "att_demo_pdf" }
    ]
  },
  "attachments": [
    {
      "id": "att_demo_pdf",
      "fileName": "demo.pdf",
      "mimeType": "application/pdf",
      "byteSize": 123456,
      "status": "available"
    }
  ],
  "replyToMessageId": null,
  "createdAt": "2026-06-25T06:30:00.000Z",
  "editedAt": null,
  "deletedAt": null
}
```

Message kinds:

| Kind | Meaning |
| --- | --- |
| `user` | Human member-created message. |
| `bot` | Bot-created message. |
| `system` | Server-created conversation-visible fact, such as group creation, member changes, or group rename. |

System messages:

- Are persisted in the normal `messages` table with `author_kind = "system"`
  and `kind = "system"`.
- Use the same structured `content` format and `plainText` preview path as
  user messages.
- Are visible only to members who can read the conversation.
- May appear through `message.created` realtime events.
- Must not expose operation records, request IDs, transfer ledger IDs, OAuth
  payloads, IP addresses, user agents, storage keys, or filesystem paths.
- Are not a substitute for audit rows; sensitive operations still write
  database operation records where required.

Storage requirements:

- Store `plainText` separately enough to support list previews and later search.
- Store canonical `content` JSON for rendering.
- Store attachment metadata in the `attachments` table and reference attachment IDs from messages.
- Do not store private direct lane content in shared-space message tables.

## 6. Content Blocks

MVP block types:

```ts
type MessageBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "link"; url: string; label?: string }
  | { type: "emoji"; shortcode: string }
  | { type: "attachment"; attachmentId: string };
```

Validation rules:

- `plainText` is required and must be generated or verified by the server.
- `text` blocks must be plain text, not HTML.
- `mention.userId` must refer to a visible member or allowed bot.
- `mention.label` is display-only; the server may replace it with canonical display data.
- `link.url` must use an allowed scheme such as `https:` or `http:`.
- `emoji.shortcode` must map to a known emoji or emote registry entry.
- `attachment.attachmentId` must refer to an attachment visible to the author and ready to attach.

Future block types can include code blocks, polls, location, rich previews, task references, or custom app cards. Clients that do not understand a block must render `plainText`.

## 7. Attachments

Attachments are not embedded as base64 or arbitrary JSON in message content. They are uploaded and stored as first-class server records.

Expected flow:

1. Client requests transfer quota reservation.
2. Server rejects or reserves quota before transfer.
3. Client uploads the file.
4. Server creates an attachment record with metadata and storage key.
5. Client creates a message that references the attachment ID.
6. Server validates that the attachment can be used in the target conversation.

Attachment statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Upload or processing has not completed. |
| `available` | File can be referenced and downloaded by allowed members. |
| `failed` | Upload or processing failed. |
| `removed` | File is no longer available. |

AI access policy for attachments is described in section 11.

## 8. Realtime Event Envelope

Realtime delivery should use events, not raw messages. Events are server-created facts.

```json
{
  "version": 1,
  "id": "evt_01J0Y4M5K3V9QKE0E0ECG9P9MK",
  "type": "message.created",
  "conversationId": "conv_01",
  "actorId": "usr_01",
  "createdAt": "2026-06-25T06:30:00.100Z",
  "payload": {
    "message": {
      "id": "msg_01J0Y4K1W16D4YQA8JEQ5VN9WE"
    }
  }
}
```

MVP event types:

| Event | Meaning |
| --- | --- |
| `message.created` | A message was accepted and persisted. |
| `message.updated` | Message content or metadata changed. |
| `message.deleted` | Message was soft-deleted or hidden. |
| `reaction.added` | A member added a reaction. |
| `reaction.removed` | A member removed a reaction. |
| `attachment.available` | An uploaded attachment became available. |
| `attachment.failed` | An attachment failed upload or processing. |
| `bot.mentioned` | Server detected a permitted bot mention. |
| `bot.response.created` | A bot response was persisted. |
| `bot.response.failed` | A bot response attempt failed. |

Subscribers only receive events for conversations they are allowed to access.

## 9. Reactions

Reactions are separate records or events, not edits to message text.

```json
{
  "version": 1,
  "type": "reaction.add",
  "payload": {
    "messageId": "msg_01J0Y4K1W16D4YQA8JEQ5VN9WE",
    "emoji": "thumbsup"
  }
}
```

Rules:

- The server derives actor identity from the session.
- The target message must be visible to the actor.
- Reaction identifiers should map to the supported emoji/emote registry.
- Reactions should be reversible without changing the original message content.

## 10. Idempotency And Ordering

Idempotency:

- `clientMessageId` should be unique per author and conversation.
- Repeated `message.create` commands with the same `(authorId, conversationId, clientMessageId)` should return the same persisted message if the original succeeded.
- If a retry conflicts with different content, the server should reject it as an idempotency conflict.

Ordering:

- Server timestamps are canonical.
- Message ordering should use server-created sequence or timestamp fields, not client timestamps.
- Clients may show optimistic messages locally, then reconcile with `message.created`.

## 11. AI Bot Integration

AI bots are special shared-space members.

```ts
type UserKind = "human" | "bot";

type BotPermission =
  | "read_joined_messages"
  | "read_file_metadata"
  | "read_file_text_preview"
  | "read_file_content"
  | "send_messages"
  | "add_reactions"
  | "create_summary";
```

Trigger rules:

- A bot can respond when it is mentioned in a visible message and has `read_joined_messages`.
- A bot can respond in direct bot conversations where that feature is enabled.
- Slash commands or automations can be added later, but should still resolve to explicit server-side bot triggers.
- The server computes bot eligibility; client-submitted `ai` or `bot` fields are never trusted.

Example mention:

```json
{
  "content": {
    "format": "duallane.message+json;v=1",
    "plainText": "@助手 summarize the last file",
    "blocks": [
      { "type": "mention", "userId": "bot_assistant", "label": "助手" },
      { "type": "text", "text": " summarize the last file" }
    ]
  }
}
```

Server-computed bot task context:

```json
{
  "botId": "bot_assistant",
  "trigger": "mention",
  "conversationId": "conv_01",
  "triggerMessageId": "msg_01",
  "contextPolicy": {
    "maxMessages": 50,
    "visibleMessagesOnly": true,
    "includeFiles": "metadata_only"
  }
}
```

Attachment access levels:

| Level | Bot access |
| --- | --- |
| `metadata_only` | File name, MIME type, size, uploader, and timestamps. |
| `text_preview` | Metadata plus server-generated text preview or extracted summary. |
| `full_content` | Full file content after explicit permission and policy checks. |

Bot safety requirements:

- Bots must not read conversations they have not joined unless an explicit future permission model allows it.
- Bots must not read attachment content just because a message references a file.
- File-content reads should write operation records.
- Bot responses should be persisted as `kind: "bot"` messages.
- Bot failures should be visible as status or operation records without leaking provider internals to regular members.

## 12. System Messages

System messages represent server-created space events that should appear in conversation history.

Examples:

- Member joined a group.
- Retention removed older messages.
- File upload failed.
- Bot response failed.

System messages should use `kind: "system"` and a structured payload. They should not pretend to be authored by a human user.

## 13. Database Replacement Guidance

The current prototype stores messages as plain `body TEXT`, but Workspace has not launched and does not need compatibility. The first full Workspace loop should directly replace the prototype schema with structured storage instead of adding legacy fallbacks.

Suggested `messages` fields:

| Field | Purpose |
| --- | --- |
| `id` | Server message ID. |
| `conversation_id` | Conversation reference. |
| `author_id` | Human or bot author. |
| `author_kind` | `human`, `bot`, or `system` author class where useful. |
| `kind` | `user`, `bot`, or `system`. |
| `client_message_id` | Idempotency key for user-created messages. |
| `content_format` | Example: `duallane.message+json;v=1`. |
| `content_json` | Canonical structured content. |
| `plain_text` | Search and preview text. |
| `reply_to_message_id` | Optional reply reference. |
| `created_at` | Server timestamp. |
| `edited_at` | Last edit timestamp. |
| `deleted_at` | Soft delete timestamp. |

Keep `attachments` as a separate table. A join table such as `message_attachments` is useful once one message can reference multiple files or one uploaded file can be reused.

Suggested additional tables later:

- `reactions`
- `message_events`
- `bot_memberships`
- `bot_permissions`
- `bot_tasks`
- `attachment_text_previews`

No `body` fallback is required. Tests should assert that new messages use structured fields and that private direct content never lands in shared-space message tables.

Detailed first-loop schema and API decisions live in [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md).

## 14. Security And Validation Checklist

- Reject unsupported protocol versions.
- Reject malformed content blocks.
- Reject HTML/script content as renderable markup.
- Derive author identity from authenticated session.
- Enforce conversation membership before message creation.
- Validate attachments before linking them to messages.
- Enforce quota before transfer.
- Keep private direct content out of shared-space tables.
- Do not trust client-supplied AI eligibility or bot access fields.
- Record sensitive bot file-content reads.
- Redact request bodies and sensitive headers from logs.
- Preserve security headers and Fastify log redaction.
