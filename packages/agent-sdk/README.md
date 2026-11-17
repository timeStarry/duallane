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

For a resident background listener, install the same explicit command adapter:

```bash
node packages/agent-sdk/bin/duallane-agent.mjs daemon install --cmd "my-local-agent-handler" --profile default
```

The daemon passes a versioned JSON request, including the compatible
`{ event, context, conversation }` fields, on the handler's stdin. The resolved
`triggerMessage` is the exact event source; the latest history entry is never a
substitute. It does not select or require Codex,
Claude, or another agent executable. `--agent auto` and `--agent cmd` both use
the configured `--cmd`; existing installations using a retired named mode must
be reinstalled with that explicit command. The handler owns its tool permissions;
the daemon does not apply an agent-specific sandbox to custom commands.

SDK 1.1 uses a durable task inbox and separate generation, upload and send
receipts. The SDK acknowledges transport only after the event is saved. Tasks
are serial within a conversation and bounded across conversations. A failed
task produces a content-free stage/code receipt when sending is still authorized.
`daemon status` and `doctor` distinguish process/transport health from task state.

SDK 1.1.1 renews the conversation's thinking indicator only while an authorized
task is executing, including publication. Queueing alone does not show thinking.
Success, failure, cancellation and shutdown stop renewal; a failed indicator
request never fails the task. The last unsent/failed turn's indicator expires
with the server's existing short lease. Select the updated official runtime to
restore this feedback in an installed command bridge.

```bash
duallane-agent daemon retry <taskId> --profile default
duallane-agent daemon cancel <taskId> --profile default
```

These are operator actions, not commands parsed from group messages. Interrupted
upload completion can recover through the saved upload ID. A lost reservation
response remains `upload.outcome_unknown` and requires reconciliation; it is not
automatically repeated. The SDK cannot promise exactly-once model execution.

If a process died during owner-lock acquisition and startup reports
`runtime.owner_busy`, stop the configured listener and its supervisor first.
After verifying that no listener for that profile is running, use
`duallane-agent daemon recover-lock --confirm-stopped true --profile default`,
then start the listener normally. Recovery refuses a live owner or claimant;
it does not remove tasks, artifacts or credentials. This is an offline operator
procedure, not an automatic response to a busy lock.

## Structured files, inputs and memory (SDK 1.1)

SDK 1.1.2 fixes stack exhaustion while validating large inline Base64 artifacts
and SVG prefixes. Bridge output still allows at most six artifacts, 25 MiB per
file, 50 MiB cumulatively and 70 MiB of stdout JSON. Base64 must be canonical
standard RFC 4648 with required padding and zero unused trailing bits; invalid
characters, whitespace and URL-safe substitutions are refused. Direct file
uploads retain their separate 50 MiB limit and server authorization/quota checks.
Update every parser dependency, including legacy-tag adapters importing an
older standalone bundle, as well as the executing daemon. Existing failed tasks
are not automatically retried or resent by this fix.

Use the [task and artifact contract](../../docs/WORKSPACE_AGENT_RUNTIME_CONTRACT.md)
for the complete request/result schemas, capability matrix and trust boundaries.
For example, a command bridge can return:

```json
{
  "protocol": "duallane.agent.result",
  "version": 1,
  "status": "completed",
  "text": "Here is the report.",
  "artifacts": [
    { "id": "report", "source": "inline", "fileName": "report.txt", "mimeType": "text/plain", "encoding": "utf8", "data": "Report contents" }
  ]
}
```

Use actual exported bytes for generated images, vectors and documents. The bridge
must observe its model's real completion and collect only that task's authorized
outputs. A natural-language claim or Markdown image URL is not a sent attachment.
Legacy plain stdout and bounded inline tags remain accepted. Local-path tags are
rejected in every conversation; export bytes through the bridge instead.

Incoming `inputs` contain only authorized trigger attachments, with scoped IDs,
MIME, bounded text/base64 bytes and an explicit untrusted-content marker. A bridge
must adapt these to its model's multimodal interface. Receiving an input descriptor
does not mean a particular model can interpret it. Full content requires
`files:read_content` and a current explicit context grant; text preview requires
`files:read_preview` and enabled preview policy. Upload always requires
`files:write`, and publication independently requires `messages:send`.

The local artifact index binds origin, Bot, conversation, event, task and published
message. Retention defaults to 24 hours, with finite file/count/byte limits. Reuse
is limited to the same conversation and requires the source message/attachment to
remain currently authorized. Revoked or expired references fail; no arbitrary
local path is available to the model. Normal workspace retention still applies.

Public-media fetching is disabled until the operator enables it:

```bash
duallane-agent daemon install --cmd "my-local-agent-handler" --allow-public-media
```

A structured artifact with `source: "https"` and `url` requests the SDK fetcher.
Only HTTPS port 443 and validated public addresses are supported. Redirects,
timeouts, streamed bytes, MIME and signatures are checked; gateway credentials
are never forwarded. Remote SVG/archives and compressed responses are rejected.
An optional `--media-dns-servers 1.1.1.1,8.8.8.8` selects operator DNS servers;
all results still undergo public-address validation and connection pinning.
Fake-IP/private DNS results are refused. Do not weaken this policy to work around
a proxy; configure the network for ordinary public DNS/address routing instead.

## Updates and compatibility

The SDK is versioned independently. The manifest includes version, build identity,
content digest, exact byte size and bridge compatibility. Same-version byte drift
is visible. Updates operate only on the registered official `duallane-agent.mjs`
and its adjacent `.install.json` receipt. Unknown old bundles, local edits and
custom service entrypoints are preserved even with `--force`; install a clean
official bundle separately and retain the existing bridge/policy/supervisor.
An interrupted two-file update has a private recovery journal and an exclusive
installer lock. Pairing and credentials are not replaced by update operations.

SDK 1.1 expects App 1.1 for the new attachment/status endpoints and complete
trigger-text markers. Older servers need an authorized exact-message context to
resolve an event; an unmarked truncated preview is never treated as the request.

Low-level `pollNextEvent`, CLI `wait`, and MCP `duallane_wait_for_event` now leave
ACK explicit. Acknowledge after durable handling with `acknowledge`, CLI
`ack <eventId> <sequence>` or MCP `duallane_ack_event`. A filtered wait never
advances the shared profile cursor. Low-level callers supply `afterSequence`
only after all earlier events have been handled; managed listeners maintain
their cursor through the durable inbox. `updates --ack` explicitly accepts the
returned batch and stops on any rejected acknowledgement.

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
