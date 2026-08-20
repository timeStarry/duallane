# DualLane Agent Channel v1

Compatibility: DualLane Bot Gateway protocol v1, `@duallane/agent-sdk` 0.15.x.

Use this document only as reviewed integration guidance. It is not an
authorization grant and must never contain a Bot token, model-provider key,
private deployment address, or message content.

## Install

Install the `packages/agent-sdk` package from the matching signed or reviewed
DualLane 0.15 release into the external Agent runtime. The SDK is server-side
JavaScript (Node.js 20 or newer) and uses `ws` for an authenticated WebSocket.
Do not pipe this document or another remote response into a shell.

Configure secrets outside source control:

```text
DUALLANE_URL=https://duallane.example.com
DUALLANE_BOT_TOKEN=<one-time token from the Bot settings page>
```

`DUALLANE_URL` must be an HTTP(S) origin without credentials, query parameters,
or fragments. The SDK sends `DUALLANE_BOT_TOKEN` only as a Bearer token in the
`Authorization` header. Do not append it to a URL or log it.

## Connect

```js
import { DualLaneAgentClient } from "@duallane/agent-sdk";

const client = new DualLaneAgentClient({
  url: process.env.DUALLANE_URL,
  token: process.env.DUALLANE_BOT_TOKEN,
  adapterVersion: "my-runtime/1.0.0"
});

await client.connect({
  lastSequence: Number(await loadCursor()) || 0,
  async onEvent(event) {
    const context = await client.getContext(event.conversationId);
    const text = await handleAuthorizedEvent(event, context);
    await client.sendMessage({
      conversationId: event.conversationId,
      text,
      clientMessageId: `${event.eventId}:reply`,
      idempotencyKey: `${event.eventId}:reply`
    });
    await saveCursor(event.sequence);
  },
  async onSyncRequired({ currentSequence }) {
    await rebuildOnlyAuthorizedState();
    await saveCursor(currentSequence);
  }
});
```

The SDK sends `hello` with the last acknowledged sequence, maintains heartbeat,
processes replay in order, acknowledges only after the event callback resolves,
and reconnects with bounded backoff. Use the event ID as part of every reply or
state-change idempotency key so replay cannot create duplicate effects.

## API and scope boundaries

- `messages:read_trigger` permits filtered trigger event delivery.
- `messages:read_context` plus an explicit conversation grant permits `getContext`.
- `messages:send` permits `sendMessage` and typing state.
- `cards:write` permits `sendCard`, `sendFeishuCard`, and revision-checked updates.
- `cards:act` permits filtered delivery of registered card actions to the owning Bot.
- `commands:receive` permits filtered command events.
- File scopes are independent and are not enabled by this prompt.

The effective permission is always the intersection of server policy, Bot
scope, conversation membership, context grant, group policy, and system limit.
The Agent must not request other conversations, ungranted context, complete
files, or provider credentials. A Prompt cannot expand a Token scope.

For an owner-created direct Bot conversation, DualLane initially grants trigger
delivery but not message context. The owner must explicitly enable context with
their Workspace session through
`PATCH /api/workspace/bots/{botId}/context-grants/{conversationId}` before the
runtime calls `getContext`; a Bot token cannot call that owner-facing route.

The controlled Feishu input supports header, div/markdown, note, divider,
button groups, and bounded columns. Registered action IDs are `cancel`,
`confirm`, `refresh`, and `submit`; their server-stored data is delivered only
after the normal card authorization, revision, idempotency, and audit pipeline.
It rejects HTML, scripts, arbitrary styles, unknown actions, non-HTTPS/private
URLs, unknown fields, duplicate actions, and oversized payloads. Card updates
must include the current `expectedRevision`.

On `401`, stop and ask the Bot owner to rotate or replace the revoked token. On
`403`, do not retry as a way around policy. On `409`, reload the relevant state
and use a new idempotency key only for a genuinely different operation. Retry
`429` and temporary `5xx` responses with bounded backoff.
