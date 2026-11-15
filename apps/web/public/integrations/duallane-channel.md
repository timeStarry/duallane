# DualLane Universal Agent Channel

Stable channel specification targeting DualLane Bot Gateway v1/v2 and the self-hosted zero-dependency runtime `duallane-agent.mjs` (Node.js 20+, no npm required).

Compatible with **Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, OpenClaw, Hermes**, and any HTTP/WebSocket Agent runtime.

- Canonical stable Skill URL: `https://duallane.tsio.top/integrations/duallane-channel.md`
- Versioned v2 Skill URL (Universal MCP + CLI + Setup Handshake + Long-Polling): `https://duallane.tsio.top/integrations/v2/duallane-channel.md`
- Self-hosted standalone Agent CLI / MCP / SDK (zero npm dependencies): `https://duallane.tsio.top/integrations/duallane-agent.mjs`
- Immutable v1 Skill URL: `https://duallane.tsio.top/integrations/v1/duallane-channel.md`

## Quick Onboarding Workflow

When a user provides a DualLane setup link (`https://<host>/workspace?setup=setup_<id>`):

1. **Install the self-hosted zero-dependency Agent runtime directly from `<origin>`** (no npm or git clone required):
   ```bash
   mkdir -p ~/.duallane/bin && curl -fsSL "<origin>/integrations/duallane-agent.mjs" -o ~/.duallane/bin/duallane-agent.mjs && chmod +x ~/.duallane/bin/duallane-agent.mjs
   ```
2. **Read the full v2 specification**: Fetch `<origin>/integrations/v2/duallane-channel.md` on the same DualLane origin.
3. **Submit pairing request** (no manual token needed):
   - Run `node ~/.duallane/bin/duallane-agent.mjs setup "<setup-url>" --name "<agent-name>"` (or MCP tool `duallane_setup_start`),
   - Or `POST <origin>/api/bot-gateway/v1/setup/request` with `{ "setupSessionId": "setup_<id>", "requestedScopes": ["messages:read_trigger", "messages:read_context", "messages:send", "cards:write", "cards:act", "commands:receive"], "clientName": "<agent-name>", "protocolVersion": "v1" }`.
4. **User browser confirmation & one-time exchange**: Ask the user to approve at `<origin>/workspace?setup=setup_<id>` (or in **DualLane 设置 → 机器人**); `duallane-agent.mjs setup` automatically polls approval, exchanges once, and stores the credential at `~/.config/duallane/agents/default.json` (`0600` mode) without printing the raw token into LLM chat output.
5. **Receive & reply in real time**:
   - Run `node ~/.duallane/bin/duallane-agent.mjs wait --profile default --timeout 3600` (connects via `wss://<host>/ws/bot-gateway` and automatically falls back to HTTP long-polling `GET /api/bot/v2/updates?afterSequence=<seq>&timeout=20` when WebSocket upgrades are blocked by a sandbox proxy),
   - Or register `node ~/.duallane/bin/duallane-agent.mjs mcp --profile default` as a standard Stdio MCP server,
   - Or run `node ~/.duallane/bin/duallane-agent.mjs listen --cmd "<agent-cli>" --profile default` as a local daemon.

This document is integration guidance only and never embeds credentials or private data.
