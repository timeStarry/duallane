# DualLane Universal Agent Channel

Stable channel specification targeting DualLane Bot Gateway v1/v2 and zero-dependency `@duallane/agent-sdk` 1.0.x.

Compatible with **Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, OpenClaw, Hermes**, and any HTTP/WebSocket Agent runtime.

- Canonical stable Skill URL: `https://duallane.tsio.top/integrations/duallane-channel.md`
- Versioned v2 Skill URL (Universal MCP + CLI + Setup Handshake): `https://duallane.tsio.top/integrations/v2/duallane-channel.md`
- Immutable v1 Skill URL: `https://duallane.tsio.top/integrations/v1/duallane-channel.md`

## Quick Onboarding Workflow

When a user provides a DualLane setup link (`https://<host>/workspace?setup=setup_<id>`):

1. **Read the full v2 specification**: Fetch `/integrations/v2/duallane-channel.md` on the same DualLane origin.
2. **Submit pairing request** (no manual token needed):
   - Either run `duallane-agent setup "<setup-url>" --name "<agent-name>"` (or MCP tool `duallane_setup_start`),
   - Or `POST <origin>/api/bot-gateway/v1/setup/request` with `{ "setupSessionId": "setup_<id>", "requestedScopes": ["messages:read_trigger", "messages:read_context", "messages:send", "cards:write", "cards:act", "commands:receive"], "clientName": "<agent-name>", "protocolVersion": "v1" }`.
3. **User browser confirmation**: Ask the user to approve at `<origin>/workspace?setup=setup_<id>` (or in **DualLane 设置 → 机器人**).
4. **One-time token exchange**: Poll `GET <origin>/api/bot-gateway/v1/setup/status?setupSessionId=setup_<id>` until `approved`, then call `POST <origin>/api/bot-gateway/v1/setup/exchange` and save the credential to `~/.config/duallane/agents/default.json` (`0600` mode) without printing the raw token into LLM chat output.
5. **Discover & interact**: Call `GET <origin>/api/bot/v2/conversations` (or MCP `duallane_list_conversations`) to find authorized chats, send messages/interactive cards, stream edits via `PATCH /api/bot/v2/messages/{messageId}`, or listen for live replies via `wss://<host>/ws/bot-gateway` (`duallane_wait_for_event` / `duallane-agent listen`).

This document is integration guidance only and never embeds credentials or private data.
