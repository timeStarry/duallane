# DualLane Channel for OpenClaw, v1

Compatibility: DualLane Bot Gateway protocol v1, DualLane SDK 0.15.x, and the
current OpenClaw channel-plugin model.

Review `/integrations/v1/duallane-channel.md` first. Install the reviewed
DualLane SDK package, then import its official transport bridge:

```js
import { DualLaneAgentClient } from "@duallane/agent-sdk";
import { createOpenClawDualLaneAdapter } from "@duallane/agent-sdk/openclaw";

const client = new DualLaneAgentClient({
  url: process.env.DUALLANE_URL,
  token: process.env.DUALLANE_BOT_TOKEN,
  adapterVersion: "openclaw-duallane/0.15.0"
});

export const transport = createOpenClawDualLaneAdapter({
  client,
  async dispatchInbound(input) {
    // Hand input.event and input.context to the OpenClaw-owned inbound
    // lifecycle. Return final text or call input.reply.text/card exactly once.
    return dispatchThroughOpenClaw(input);
  }
});
```

Register `transport.start` from the plugin's runtime activation path. Map the
OpenClaw outbound text adapter to `transport.sendText`, typing to
`transport.setTyping`, and structured card output to `transport.sendCard`.
Keep setup/discovery imports side-effect free and do not start a connection
while OpenClaw is only inspecting configuration.

Store `DUALLANE_BOT_TOKEN` through OpenClaw's secret/config facility. It must
not appear in a plugin manifest, docs URL, session key, target ID, error log, or
model prompt. DualLane remains the authority for member checks, group policy,
scopes, context limits, card revisions, and rate limits; OpenClaw output cannot
override a rejection.

The bridge intentionally takes an injected `dispatchInbound` function because
OpenClaw owns its inbound session lifecycle. This keeps the DualLane transport
independent from model, memory, and tool execution and avoids importing the
OpenClaw runtime during setup discovery.
