# DualLane Universal Agent Channel (v2)

Compatibility: DualLane Bot Gateway v1 + v2 extensions, standalone single-file runtime `duallane-agent.mjs` v1.0.6+ (Node.js 20+, **zero external npm dependencies**, hosted directly on your DualLane instance — no public npm package or repo checkout required).

Works identically with **Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, OpenClaw, Hermes**, and custom HTTP / WebSocket Agent runtimes — with **zero public IP required** on the Agent machine.

> Security boundary: This document is an integration specification, never an authorization grant. Never put a Bot token in a URL, query parameter, source repository, or LLM conversation transcript.

---

## 0. One-Command Self-Hosted Agent Runtime Install (No npm Needed)

Every DualLane deployment serves the complete zero-dependency CLI, Stdio MCP server, WebSocket/HTTP-LongPoll listener, and ESM SDK directly at `<origin>/integrations/duallane-agent.mjs`:

```bash
mkdir -p ~/.duallane/bin
curl -fsSL "<origin>/integrations/duallane-agent.mjs" -o ~/.duallane/bin/duallane-agent.mjs
chmod +x ~/.duallane/bin/duallane-agent.mjs
node ~/.duallane/bin/duallane-agent.mjs --help
```

*(Replace `<origin>` with the origin of the user's DualLane setup URL, e.g. `https://duallane.tsio.top`.)*

---

## 1. Interactive Pairing Flow (No Manual Token Copy-Paste)

When the user gives you a DualLane setup URL (`https://<duallane-host>/workspace?setup=setup_<id>`):

### Path A — Using Self-Hosted `duallane-agent.mjs` CLI or MCP (Recommended)

After downloading `~/.duallane/bin/duallane-agent.mjs` from `<origin>/integrations/duallane-agent.mjs`:

```bash
node ~/.duallane/bin/duallane-agent.mjs setup "<setup-url>" --name "<your-agent-name>"
```

Or via the standard **Stdio MCP Server** (`node ~/.duallane/bin/duallane-agent.mjs mcp`):
1. Call `duallane_setup_start` with `{ "setupUrl": "<setup-url>", "clientName": "<your-agent-name>" }`.
2. Ask the user to click **Approve (确认授权)** in DualLane (`<origin>/workspace?setup=setup_<id>`).
3. Call `duallane_setup_finish` — the server exchanges the one-time session and stores the credential at `~/.config/duallane/agents/default.json` (`chmod 0600`) without exposing the raw token to model context.

### Path B — Direct HTTP Handshake (Universal Fallback — Works Anywhere with `curl` / `fetch` / Python)

If Node.js is not available, run the Setup Session handshake directly against `<origin>`:

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
     "clientVersion": "1.0.6",
     "protocolVersion": "v1",
     "capabilities": ["mcp", "websocket", "cards", "stream_edit"]
   }
   ```
   *(Do not add unlisted JSON keys; the gateway enforces a strict field allowlist.)*

3. **Ask the user to approve in Browser (if not yet approved)**, then **exchange once & store outside LLM context**:
   Execute a local script/command that posts to `/api/bot-gateway/v1/setup/exchange` and writes `{ "version": 1, "profile": "default", "url": "<origin>", "token": "<token>" }` directly to `~/.config/duallane/agents/default.json` with `0600` permissions **without printing `.token` to stdout**:
   ```http
   POST <origin>/api/bot-gateway/v1/setup/exchange
   Content-Type: application/json

   {
     "setupSessionId": "setup_<id>",
     "clientName": "<your-agent-name>",
     "clientVersion": "1.0.6",
     "protocolVersion": "v1"
   }
   ```

---

## 2. Standard Stdio MCP Configuration (Universal Across Agent Clients)

Once `~/.duallane/bin/duallane-agent.mjs` is downloaded, add `duallane` to your Agent's standard `mcpServers` config (supported by Claude Code `.mcp.json`, Codex `~/.codex/config.toml` / MCP settings, Cursor `~/.cursor/mcp.json`, Windsurf, Gemini CLI, and Antigravity `mcp_config.json`):

```json
{
  "mcpServers": {
    "duallane": {
      "command": "node",
      "args": ["~/.duallane/bin/duallane-agent.mjs", "mcp", "--profile", "default"]
    }
  }
}
```
*(Expand `~` to your absolute home directory path if your MCP host does not expand tilde.)*

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
| `duallane_set_typing` | Broadcast live Bot status (`thinking` / `typing`) and advance read receipt |
| `duallane_wait_for_event` | Wait in real time (WebSocket with automatic HTTP long-poll fallback) for user replies, `@mentions`, `/commands`, or card clicks |
| `duallane_unbind` | Revoke current Bot token on DualLane and delete local credential profile |

---

## 3. Live Event Receiving & Wakeup (Outbound WebSocket + Automatic HTTP Long-Polling Fallback)

DualLane Bots connect **outbound** to `wss://<host>/ws/bot-gateway` (and automatically fall back to HTTP long-polling `GET /api/bot/v2/updates?afterSequence=<seq>&timeout=20` if outbound WebSocket upgrades are blocked by a sandbox or HTTP proxy):

- **Feishu-Style 24/7 Resident Background Daemon (Recommended — Never Drops Offline)**:
  ```bash
  node ~/.duallane/bin/duallane-agent.mjs daemon install --profile default --agent auto
  ```
  Registers an OS-supervised `launchd` (`KeepAlive=true` on macOS) or `systemd --user` (`Restart=always` on Linux) background listener that stays connected across terminal closes, sleep/wake, and DualLane server deployments, automatically waking `codex exec` / `claude -p` (or `--cmd "<custom>"`) per conversation while enforcing strict read-only safety in group chats. Inspect anytime via `daemon status` or `daemon logs`.

- **Reactive Session Wakeup (Single-Shot CLI Debugging)**:
  ```bash
  node ~/.duallane/bin/duallane-agent.mjs wait --profile default --timeout 3600
  ```
  *(Pass `--transport poll` if your sandbox forces HTTP-only proxies.)*
  When a DualLane message arrives, `wait` automatically marks typing, acks the sequence cursor, prints `{ status: "event", event, context }`, and exits `0`.

- **Foreground Custom Shell Bridge**:
  ```bash
  node ~/.duallane/bin/duallane-agent.mjs listen --cmd "<local-agent-cli-command>" --profile default
  ```
  Each authorized incoming event is piped as JSON (`{ event, context }`) to `<local-agent-cli-command>` stdin (with `DUALLANE_CONVERSATION_ID`, `DUALLANE_EVENT_TYPE`, `DUALLANE_MESSAGE_TEXT` env vars, never leaking the Bot token to child processes), and non-empty stdout is sent back as an idempotent reply.

- **Zero-Node Pure HTTP Long-Polling Loop (Works with `curl` / Python / Any HTTP Client)**:
  1. Call `GET <origin>/api/bot/v2/updates?afterSequence=<cursor>&limit=50&timeout=20` with `Authorization: Bearer <bot-token>`. The server holds the request up to `20s` until a new event arrives (or returns `{ events: [] }` on timeout).
  2. For each event, advance `<cursor> = event.sequence`, emit `POST <origin>/api/bot/v2/typing` (`{ "conversationId": "..." }`), process & reply via `POST <origin>/api/bot-gateway/v1/messages`, and acknowledge via `POST <origin>/api/bot-gateway/v1/events/ack` (`{ "sequence": <cursor>, "eventId": "<eventId>" }`).

---

## 4. Direct REST & Streaming Reference

All authenticated calls require `Authorization: Bearer <bot-token>` (never query strings):

- `GET /api/bot-gateway/v1/me` — Bot profile, active scopes, and connection status
- `GET /api/bot/v2/conversations` — Authorized direct/group conversations (`allowSend`, `allowTrigger`, `allowContext`, `maxMessages`)
- `GET /api/bot-gateway/v1/conversations/{conversationId}/context?limit=30` — Recent authorized context (requires `messages:read_context` + conversation context grant)
- `POST /api/bot-gateway/v1/messages` — `{ conversationId, text, replyToMessageId?, clientMessageId, idempotencyKey }`
- `PATCH /api/bot/v2/messages/{messageId}` — `{ plainText }` (real-time streaming message edit for messages authored by this Bot)
- `POST /api/bot-gateway/v1/cards` — Interactive cards (`format: "feishu-card"`, registered button action IDs: `confirm`, `cancel`, `submit`, `refresh`)
- `POST /api/bot/v2/typing` — `{ conversationId, state?: "thinking" | "typing" }` (live processing indicator + read receipt advance)
- `POST /api/bot/v2/unbind` — Self-revoke current Bot credential token (or run `node ~/.duallane/bin/duallane-agent.mjs unbind`)
- `GET /api/bot/v2/updates?afterSequence=0&limit=50&timeout=20` & `POST /api/bot-gateway/v1/events/ack` — Server-held HTTP long-polling (`timeout=1..25` seconds) & replay cursor acknowledgement

### Error Handling Rules
- **`401 bot.invalid_token`**: Token expired or revoked — ask the user for a new pairing link.
- **`403 bot.context_forbidden`**: Conversation owner has not enabled Context Grant yet — ask the user to toggle **上下文读取** for that chat in **DualLane 设置 → 机器人**.
- **`403 bot.scope_denied` / `bot.conversation_forbidden`**: Respect policy boundaries; do not retry around `403`.
- **`429` / `5xx`**: Retry with bounded exponential backoff and reuse the same `idempotencyKey`.
