#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import {
  DualLaneAgentClient,
  DualLaneAgentSetupClient,
  DUALLANE_AGENT_SDK_VERSION,
} from "../src/index.js";
import { startDualLaneMcpStdioServer } from "../src/mcp.js";
import {
  DEFAULT_SETUP_SCOPES,
  loadAgentProfile,
  normalizeProfileName,
  parseSetupTarget,
  sanitizeSetupClientName,
  saveAgentProfile,
  updateProfileCursor,
} from "../src/profile-store.js";

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function printHelp() {
  process.stdout.write(`DualLane Universal Agent CLI & MCP Server v${DUALLANE_AGENT_SDK_VERSION}

Usage:
  duallane-agent setup <setup-url-or-id> [--url <origin>] [--profile default] [--name <agent-name>]
  duallane-agent mcp [--profile default]
  duallane-agent status [--profile default]
  duallane-agent conversations [--profile default]
  duallane-agent updates [--ack] [--profile default]
  duallane-agent wait [--timeout 3600] [--profile default]
  duallane-agent send <conversationId> <text> [--reply-to <messageId>] [--profile default]
  duallane-agent edit <messageId> <text> [--profile default]
  duallane-agent listen --cmd "<shell-command>" [--profile default]

Works with Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI, Antigravity, and OpenClaw.
`);
}

async function runSetup(positionals, flags) {
  const setupInput = positionals[0];
  if (!setupInput) {
    throw new Error("Missing setup URL. Usage: duallane-agent setup \"https://<host>/workspace?setup=setup_...\"");
  }
  const profile = normalizeProfileName(flags.profile || "default");
  const clientName = sanitizeSetupClientName(flags.name, `duallane-cli/${DUALLANE_AGENT_SDK_VERSION} ${os.hostname()}`);
  const target = parseSetupTarget(setupInput, flags.url);
  const scopes = flags.scopes
    ? String(flags.scopes)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_SETUP_SCOPES];

  const setupClient = new DualLaneAgentSetupClient({ url: target.origin });
  const initialCheck = await setupClient.status(target.setupSessionId).catch(() => null);
  const initialSession = initialCheck?.setup || initialCheck?.session || null;
  const initialStatus = initialSession ? String(initialSession.status || "") : "";

  if (initialStatus !== "approved") {
    await setupClient.request(target.setupSessionId, {
      requestedScopes: scopes,
      clientName,
      clientVersion: DUALLANE_AGENT_SDK_VERSION,
      protocolVersion: "v1",
      capabilities: ["cli", "mcp", "websocket", "cards", "stream_edit"],
    });

    process.stderr.write(`\n[DualLane] Pairing request submitted as "${clientName}".\n`);
    process.stderr.write(`[DualLane] Approve in DualLane Settings -> Bots or open:\n  ${target.approvalUrl}\n\n`);

    if (flags["no-wait"]) {
      process.stdout.write(JSON.stringify({ status: "pending_approval", profile, approvalUrl: target.approvalUrl }, null, 2) + "\n");
      return;
    }
  } else {
    process.stderr.write(`\n[DualLane] Setup session is already pre-approved — exchanging credentials now...\n`);
  }

  const waitSeconds = Math.min(300, Math.max(5, Number(flags.wait || 180)));
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const check = await setupClient.status(target.setupSessionId);
    const session = check?.setup || check?.session || {};
    const status = String(session.status || "pending");
    if (status === "approved") {
      const exchanged = await setupClient.exchange(target.setupSessionId, {
        clientName,
        clientVersion: DUALLANE_AGENT_SDK_VERSION,
        protocolVersion: "v1",
      });
      const rawToken = String(exchanged?.token || "").trim();
      const client = new DualLaneAgentClient({ url: target.origin, token: rawToken });
      const me = await client.getMe().catch(() => null);
      const convs = await client.listConversations().catch(() => ({ conversations: [] }));

      const saved = saveAgentProfile(profile, {
        url: target.origin,
        token: rawToken,
        botId: me?.bot?.id || exchanged?.session?.botId || null,
        botUserId: me?.bot?.botUserId || null,
        botName: me?.bot?.name || null,
        scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
        lastSequence: Number(me?.connection?.currentSequence || 0),
        clientName,
      });

      process.stderr.write(`[DualLane] Connected! Token saved securely (0600) to ${saved.filePath}\n`);
      process.stdout.write(
        JSON.stringify(
          {
            status: "connected",
            profile: saved.profile,
            credentialsFile: saved.filePath,
            origin: target.origin,
            bot: me?.bot || null,
            scopes: me?.scopes || [],
            conversations: convs?.conversations || [],
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    if (status === "denied" || status === "expired" || status === "exchanged") {
      throw new Error(`Setup session ${status}. Generate a new pairing link in DualLane Settings -> Bots.`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(`Timed out after ${waitSeconds}s waiting for approval at ${target.approvalUrl}`);
}

function requireClient(profileFlag) {
  const profileName = normalizeProfileName(profileFlag || "default");
  const profile = loadAgentProfile(profileName);
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" is not configured. Run: duallane-agent setup "<setupUrl>" --profile ${profileName}`
    );
  }
  const client = new DualLaneAgentClient({
    url: profile.url,
    token: profile.token,
    adapterVersion: `duallane-cli/${DUALLANE_AGENT_SDK_VERSION}`,
  });
  return { client, profile, profileName };
}

async function runBridgeCommand(shellCmd, payload) {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DUALLANE_BOT_TOKEN;
    env.DUALLANE_CONVERSATION_ID = String(payload.event?.conversationId || "");
    env.DUALLANE_EVENT_TYPE = String(payload.event?.type || "");
    env.DUALLANE_MESSAGE_TEXT = String(
      payload.event?.payload?.message?.plainText || payload.event?.payload?.plainText || ""
    );

    const child = spawn(shellCmd, {
      shell: true,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Bridge command exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runListen(flags) {
  const cmd = typeof flags.cmd === "string" ? flags.cmd.trim() : "";
  if (!cmd) {
    throw new Error("Missing --cmd \"<shell-command>\" for incoming event bridge.");
  }
  const { client, profile, profileName } = requireClient(flags.profile);
  const me = await client.getMe();
  process.stderr.write(
    `[DualLane] Listening as "${me?.bot?.name || profile.botName || "Bot"}" (${profile.url}) -> forwarding events to: ${cmd}\n`
  );

  await client.connect({
    lastSequence: profile.lastSequence || 0,
    onStatus(state) {
      if (state.status === "connected") {
        process.stderr.write(`[DualLane] WebSocket connected (seq=${state.currentSequence ?? state.lastSequence})\n`);
      } else if (state.status === "disconnected") {
        process.stderr.write(`[DualLane] Disconnected, retrying in ${state.retryInMs}ms...\n`);
      }
    },
    async onEvent(event) {
      updateProfileCursor(profileName, event.sequence);
      if (!event.conversationId) return;

      await client.setTyping(event.conversationId).catch(() => {});
      let context = null;
      if (profile.scopes.includes("messages:read_context")) {
        context = await client.getContext(event.conversationId, { limit: 20 }).catch(() => null);
      }

      const replyText = await runBridgeCommand(cmd, { event, context });
      if (replyText) {
        await client.sendMessage({
          conversationId: event.conversationId,
          text: replyText,
          replyToMessageId: event.payload?.message?.id || event.payload?.messageId,
          clientMessageId: `${event.eventId}:reply`,
          idempotencyKey: `${event.eventId}:reply`,
        });
      }
    },
    async onSyncRequired({ currentSequence }) {
      updateProfileCursor(profileName, currentSequence);
    },
    onError(err) {
      process.stderr.write(`[DualLane] Gateway error (${err.code}): ${err.message}\n`);
    },
  });

  const shutdown = () => {
    process.stderr.write("\n[DualLane] Stopping listener...\n");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const subcommand = positionals[0];

  if (!subcommand || flags.help || flags.h || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "mcp") {
    startDualLaneMcpStdioServer({ defaultProfile: flags.profile || "default" });
    return;
  }

  if (subcommand === "setup") {
    await runSetup(positionals.slice(1), flags);
    return;
  }

  if (subcommand === "status") {
    const { client, profile } = requireClient(flags.profile);
    const [me, convs] = await Promise.all([
      client.getMe(),
      client.listConversations().catch(() => ({ conversations: [] })),
    ]);
    process.stdout.write(
      JSON.stringify(
        {
          profile: profile.profile,
          origin: profile.url,
          bot: me?.bot,
          scopes: me?.scopes,
          connection: me?.connection,
          conversations: convs?.conversations || [],
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "conversations") {
    const { client } = requireClient(flags.profile);
    const res = await client.listConversations();
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "updates") {
    const { client, profile, profileName } = requireClient(flags.profile);
    const afterSequence =
      flags["after-sequence"] !== undefined
        ? Number(flags["after-sequence"])
        : profile.lastSequence || 0;
    let res = await client.getUpdates({ afterSequence, limit: Number(flags.limit || 50) });
    if (res?.syncRequired && Number(res.currentSequence) > 0 && afterSequence === 0) {
      const fallbackSeq = Math.max(0, Number(res.currentSequence) - 100);
      const retry = await client
        .getUpdates({ afterSequence: fallbackSeq, limit: Number(flags.limit || 50) })
        .catch(() => null);
      if (retry && !retry.syncRequired) {
        res = retry;
      }
    }
    const events = Array.isArray(res?.events) ? res.events : [];
    if (flags.ack) {
      const maxSeq =
        events.length > 0
          ? Math.max(...events.map((e) => Number(e.sequence || 0)))
          : Number(res?.currentSequence || 0);
      if (maxSeq > 0) {
        await client.acknowledge({ sequence: maxSeq }).catch(() => {});
        updateProfileCursor(profileName, maxSeq);
      }
    }
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "wait") {
    const { client, profile, profileName } = requireClient(flags.profile);
    const timeoutSeconds = Math.min(86400, Math.max(5, Number(flags.timeout || 3600)));
    const startSeq =
      flags["after-sequence"] !== undefined
        ? Number(flags["after-sequence"])
        : profile.lastSequence || 0;
    const filterConv = typeof flags.conversation === "string" ? flags.conversation.trim() : "";

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.stop();
        resolve({
          status: "timeout",
          profile: profileName,
          waitedSeconds: timeoutSeconds,
          lastSequence: client.lastSequence || startSeq,
        });
      }, timeoutSeconds * 1000);

      client
        .connect({
          lastSequence: startSeq,
          async onEvent(event) {
            updateProfileCursor(profileName, event.sequence);
            await client
              .acknowledge({ eventId: event.eventId, sequence: event.sequence })
              .catch(() => {});
            if (filterConv && event.conversationId !== filterConv) {
              return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (event.conversationId) {
              await client.setTyping(event.conversationId).catch(() => {});
            }
            let context = null;
            if (event.conversationId && profile.scopes?.includes("messages:read_context")) {
              context = await client.getContext(event.conversationId, { limit: 15 }).catch(() => null);
            }
            setImmediate(() => client.stop());
            resolve({
              status: "event",
              profile: profileName,
              lastSequence: event.sequence,
              event,
              context,
            });
          },
          async onSyncRequired({ currentSequence }) {
            updateProfileCursor(profileName, currentSequence);
          },
          onError(err) {
            if (!settled && !err?.retryable) {
              settled = true;
              clearTimeout(timer);
              client.stop();
              reject(err);
            }
          },
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.stop();
          reject(err);
        });
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (subcommand === "send") {
    const [conversationId, ...rest] = positionals.slice(1);
    const text = rest.join(" ").trim();
    if (!conversationId || !text) {
      throw new Error("Usage: duallane-agent send <conversationId> <text> [--reply-to <msgId>]");
    }
    const { client } = requireClient(flags.profile);
    const res = await client.sendMessage({
      conversationId,
      text,
      replyToMessageId: typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "edit") {
    const [messageId, ...rest] = positionals.slice(1);
    const text = rest.join(" ").trim();
    if (!messageId || !text) {
      throw new Error("Usage: duallane-agent edit <messageId> <text> [--profile default]");
    }
    const { client } = requireClient(flags.profile);
    const res = await client.editMessage(messageId, text);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "listen") {
    await runListen(flags);
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Run "duallane-agent --help".`);
}

main().catch((err) => {
  const safeMsg = String(err?.message || err).replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
  process.stderr.write(`[DualLane Error] ${safeMsg}\n`);
  process.exit(1);
});
