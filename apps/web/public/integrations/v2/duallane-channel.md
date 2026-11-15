# DualLane Universal Agent Channel (v2)

Compatibility: DualLane Bot Gateway v1 + v2 extensions, `@duallane/agent-sdk` 1.0.x (Node.js 20+, zero external npm dependencies).

Works identically with **Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, OpenClaw, Hermes**, and custom HTTP / WebSocket Agent runtimes — with **zero public IP required** on the Agent machine.

> Security boundary: This document is an integration specification, never an authorization grant. Never put a Bot token in a URL, query parameter, source repository, or LLM conversation transcript.

---

## 1. Interactive Pairing Flow (No Manual Token Copy-Paste)

When the user gives you a DualLane setup URL (`https://<duallane-host>/workspace?setup=setup_<id>`):

### Path A — Using `@duallane/agent-sdk` CLI or MCP (Recommended when available)

If the local DualLane repo or `@duallane/agent-sdk` is present on disk:

```bash
node packages/agent-sdk/bin/duallane-agent.mjs setup "<setup-url>" --name "<your-agent-name>"
```

Or via the standard **Stdio MCP Server** (`duallane-agent mcp`):
1. Call `duallane_setup_start` with `{ "setupUrl": "<setup-url>", "clientName": "<your-agent-name>" }`.
2. Ask the user to click **Approve (确认授权)** in DualLane (`<origin>/workspace?setup=setup_<id>`).
3. Call `duallane_setup_finish` — the server exchanges the one-time session and stores the credential at `~/.config/duallane/agents/default.json` (`chmod 0600`) without exposing the raw token to model context.

### Path B — Direct HTTP Handshake (Universal Fallback — Works Anywhere with `curl` / `fetch` / Python)

If `@duallane/agent-sdk` is not installed locally, run the Setup Session handshake directly against `<origin>`:

1. **Check status first (supports pre-approved sessions)**:
   ```http
   GET <origin>/api/bot-gateway/v1/setup/status?setupSessionId=setup_<id>
   ```
   If `setup.status === "approved"`, skip directly to Step 3 (`exchange`).

2. **Otherwise register your pairing request** (unauthenticated, strict field allowlist):
   ```http
   POST <origin>/api/bot-gateway/v1/setup/request
   Content-Type: application/json

   {
     "setupSessionId": "setup_<id>",
     "requestedScopes": [
       "messages:read_trigger",
       "messages:read_context",
       "messages:send",
       "cards:write",
       "cards:act",
       "commands:receive"
     ],
     "clientName": "<your-agent-name>",
     "clientVersion": "1.0.0",
     "protocolVersion": "v1",
     "capabilities": ["mcp", "websocket", "cards", "stream_edit"]
   }
   ```
   *(Do not add unlisted JSON keys; the gateway enforces a strict field allowlist.)*

3. **Ask the user to approve in Browser (if not yet approved)**, then **exchange once & store outside LLM context**:
   Execute a local script/command that posts to `/api/bot-gateway/v1/setup/exchange` and writes the response directly to `~/.config/duallane/agents/default.json` with `0600` permissions **without printing `.token` to stdout**:
   ```http
   POST <origin>/api/bot-gateway/v1/setup/exchange
   Content-Type: application/json

   {
     "setupSessionId": "setup_<id>",
     "clientName": "<your-agent-name>",
     "clientVersion": "1.0.0",
     "protocolVersion": "v1"
   }
   ```

---

## 2. Standard Stdio MCP Configuration (Universal Across Agent Clients)

Add `duallane` to your Agent's standard `mcpServers` config (supported by Claude Code `.mcp.json`, Cursor `~/.cursor/mcp.json`, Codex, Windsurf, Gemini CLI, and Antigravity `mcp_config.json`):

```json
{
  "mcpServers": {
    "duallane": {
      "command": "node",
      "args": ["/path/to/duallane/packages/agent-sdk/bin/duallane-agent.mjs", "mcp", "--profile", "default"]
    }
  }
}
```

### Exposed MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `duallane_setup_start` | Initiate pairing from a `?setup=setup_...` URL |
| `duallane_setup_finish` | Poll approval, exchange once, and save `0600` credential profile |
| `duallane_status` | Inspect Bot identity, scopes, connection state, and conversations |
| `duallane_list_conversations` | Discover authorized direct/group `conversationId`s & grants |
| `duallane_get_context` | Read recent authorized messages (`messages:read_context` + owner grant) |
| `duallane_send_message` | Send Markdown text or reply to a specific message |
| `duallane_edit_message` | Stream / update a Bot-authored message in real time |
| `duallane_send_card` | Send interactive approval/action cards (`confirm`, `cancel`, `submit`, `refresh`) |
| `duallane_wait_for_event` | Wait via outbound WebSocket for user replies, `@mentions`, `/commands`, or card clicks |

---

## 3. Outbound WebSocket & Live Event Wakeup (Feishu / Telegram Style)

DualLane Bots connect **outbound** to `wss://<host>/ws/bot-gateway` with `Authorization: Bearer <bot-token>`, so local laptops, NAT workstations, and private containers receive `@Bot` mentions, DMs, `/commands`, and card button clicks in real time without exposing any inbound port or webhook:

- **Reactive Session Wakeup (for interactive coding agents with background task notifications, such as Antigravity or Claude Code)**:
  Launch a one-shot background listener before ending your turn:
  ```bash
  node packages/agent-sdk/bin/duallane-agent.mjs wait --profile default --timeout 3600
  ```
  When a DualLane message arrives, `wait` automatically marks typing, acks the sequence cursor, prints `{ status: "event", event, context }`, and exits `0` — waking your agent turn to reply via `duallane-agent send` and re-arm `wait`!

- **Standalone 24/7 Local Channel Daemon**:
  ```bash
  node packages/agent-sdk/bin/duallane-agent.mjs listen --cmd "<local-agent-cli-command>" --profile default
  ```
  Each authorized incoming event is piped as JSON (`{ event, context }`) to `<local-agent-cli-command>` stdin (with `DUALLANE_CONVERSATION_ID`, `DUALLANE_EVENT_TYPE`, `DUALLANE_MESSAGE_TEXT` env vars, never leaking the Bot token to child processes), and non-empty stdout is sent back as an idempotent reply.

---

## 4. Direct REST & Streaming Reference

All authenticated calls require `Authorization: Bearer <bot-token>` (never query strings):

- `GET /api/bot-gateway/v1/me` — Bot profile, active scopes, and connection status
- `GET /api/bot/v2/conversations` — Authorized direct/group conversations (`allowSend`, `allowTrigger`, `allowContext`, `maxMessages`)
- `GET /api/bot-gateway/v1/conversations/{conversationId}/context?limit=30` — Recent authorized context (requires `messages:read_context` + conversation context grant)
- `POST /api/bot-gateway/v1/messages` — `{ conversationId, text, replyToMessageId?, clientMessageId, idempotencyKey }`
- `PATCH /api/bot/v2/messages/{messageId}` — `{ plainText }` (real-time streaming message edit for messages authored by this Bot)
- `POST /api/bot-gateway/v1/cards` — Interactive cards (`format: "feishu-card"`, registered button action IDs: `confirm`, `cancel`, `submit`, `refresh`)
- `GET /api/bot/v2/updates?afterSequence=0&limit=50` & `POST /api/bot-gateway/v1/events/ack` — HTTP long-poll / replay alternative to WebSocket

### Error Handling Rules
- **`401 bot.invalid_token`**: Token expired or revoked — ask the user for a new pairing link.
- **`403 bot.context_forbidden`**: Conversation owner has not enabled Context Grant yet — ask the user to toggle **上下文读取** for that chat in **DualLane 设置 → 机器人**.
- **`403 bot.scope_denied` / `bot.conversation_forbidden`**: Respect policy boundaries; do not retry around `403`.
- **`429` / `5xx`**: Retry with bounded exponential backoff and reuse the same `idempotencyKey`.
