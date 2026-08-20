# DualLane Agent SDK

`@duallane/agent-sdk` is the versioned JavaScript client for Bot Gateway
protocol v1. It is intended for server-side Agent runtimes. Bot tokens are sent
only in the `Authorization` header and are never accepted in the DualLane URL.

```js
import { DualLaneAgentClient } from "@duallane/agent-sdk";

const client = new DualLaneAgentClient({
  url: process.env.DUALLANE_URL,
  token: process.env.DUALLANE_BOT_TOKEN,
  adapterVersion: "my-agent/1.0.0"
});

await client.connect({
  lastSequence: Number(loadCursor() ?? 0),
  async onEvent(event) {
    const context = await client.getContext(event.conversationId);
    await client.sendMessage({
      conversationId: event.conversationId,
      text: await answer(context),
      idempotencyKey: `${event.eventId}:reply`,
      clientMessageId: `${event.eventId}:message`
    });
  },
  async onSyncRequired(state) {
    await rebuildAuthorizedState(state.currentSequence);
  }
});
```

The SDK handles Gateway `hello`, heartbeat, ordered event consumption,
acknowledgement, bounded reconnect backoff, and replay from the last
acknowledged sequence. An event is acknowledged only after `onEvent` resolves.
Persist `client.lastSequence` after processing if the runtime needs durable
resume across process restarts.

Available REST helpers include `getMe`, `getContext`, `acknowledge`,
`sendMessage`, `sendCard`, `sendFeishuCard`, `updateCard`,
`updateFeishuCard`, and `setTyping`. Every operation is still limited by the
Bot token scopes and DualLane conversation policy.

The `@duallane/agent-sdk/openclaw` export provides the minimal official
DualLane transport bridge. OpenClaw channel-plugin registration remains in the
OpenClaw process; pass its inbound dispatcher as `dispatchInbound` and map its
outbound adapter to `sendText`, `sendCard`, and `setTyping`.
