# DualLane Agent SDK (`@duallane/agent-sdk`)

Zero-dependency universal JavaScript SDK, CLI (`duallane-agent`), and Standard Stdio MCP Server for the DualLane Agent Bot Gateway (Node.js 20+, zero external npm packages required).

Works out-of-the-box with **Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, OpenClaw**, and custom Node.js runtimes.

## 1. One-Command Interactive Pairing (CLI)

Generate a pairing link in **DualLane → 设置 → 机器人 → 一键配对 AI Agent**, then run:

```bash
node packages/agent-sdk/bin/duallane-agent.mjs setup "https://duallane.example.com/workspace?setup=setup_..." --name "My Agent"
```

After you click **确认授权** in DualLane, credentials are saved with `0600` permissions to `~/.config/duallane/agents/default.json` (never printed to stdout).

## 2. Standard Stdio MCP Server

Configure in any MCP-compatible coding agent (`.mcp.json`, `~/.cursor/mcp.json`, `mcp_config.json`, etc.):

```json
{
  "mcpServers": {
    "duallane": {
      "command": "node",
      "args": ["/absolute/path/to/duallane/packages/agent-sdk/bin/duallane-agent.mjs", "mcp", "--profile", "default"]
    }
  }
}
```

Tools provided: `duallane_setup_start`, `duallane_setup_finish`, `duallane_status`, `duallane_list_conversations`, `duallane_get_context`, `duallane_send_message`, `duallane_edit_message`, `duallane_send_card`, and `duallane_wait_for_event`.

## 3. Local Incoming Channel Bridge (`listen`)

Bridge incoming `@Bot` mentions, DMs, `/commands`, and interactive card clicks over outbound WebSocket (`wss://.../ws/bot-gateway`, zero public IP needed) to any local CLI command:

```bash
node packages/agent-sdk/bin/duallane-agent.mjs listen --cmd "my-local-agent-handler"
```

## 4. Programmatic SDK (`DualLaneAgentClient` & `DualLaneBotV2`)

```js
import { DualLaneAgentClient } from "@duallane/agent-sdk";

const client = new DualLaneAgentClient({
  url: process.env.DUALLANE_URL,
  token: process.env.DUALLANE_BOT_TOKEN,
  adapterVersion: "my-agent/1.0.0"
});

const { conversations } = await client.listConversations();

await client.connect({
  lastSequence: 0,
  async onEvent(event) {
    const context = await client.getContext(event.conversationId);
    await client.sendMessage({
      conversationId: event.conversationId,
      text: await answer(context),
      idempotencyKey: `${event.eventId}:reply`,
      clientMessageId: `${event.eventId}:message`
    });
  }
});
```

Bot tokens are sent exclusively in `Authorization: Bearer ...` headers and are redacted from all SDK error messages.
