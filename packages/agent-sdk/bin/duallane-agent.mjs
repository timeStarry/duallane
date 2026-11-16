#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  compareRuntimeSemver,
  DualLaneAgentClient,
  DualLaneAgentError,
  DualLaneAgentSetupClient,
  DUALLANE_AGENT_SDK_VERSION,
  DUALLANE_GATEWAY_VERSION,
  inferMimeTypeFromFileName,
} from "../src/index.js";
import { createDualLaneMcpServer, DUALLANE_MCP_TOOLS, startDualLaneMcpStdioServer } from "../src/mcp.js";
import {
  buildDaemonAgentPrompt,
  buildLaunchdPlistXml,
  buildSystemdUnitFile,
  checkRuntimeUpdate,
  extractGeneratedFilesFromReply,
  manageDaemonCli,
  resolveStandaloneScriptPath,
  restartInstalledDaemons,
  runResidentDaemon,
  stageRuntimeSelfUpdate,
} from "../src/daemon.js";
import {
  DEFAULT_SETUP_SCOPES,
  deleteAgentProfile,
  loadAgentProfile,
  normalizeProfileName,
  parseSetupTarget,
  sanitizeSetupClientName,
  saveAgentProfile,
  updateProfileCursor,
} from "../src/profile-store.js";

export {
  compareRuntimeSemver,
  DualLaneAgentClient,
  DualLaneAgentError,
  DualLaneAgentSetupClient,
  DUALLANE_AGENT_SDK_VERSION,
  DUALLANE_GATEWAY_VERSION,
  inferMimeTypeFromFileName,
  DUALLANE_MCP_TOOLS,
  createDualLaneMcpServer,
  startDualLaneMcpStdioServer,
  manageDaemonCli,
  runResidentDaemon,
  checkRuntimeUpdate,
  stageRuntimeSelfUpdate,
  restartInstalledDaemons,
  resolveStandaloneScriptPath,
  buildDaemonAgentPrompt,
  extractGeneratedFilesFromReply,
  buildLaunchdPlistXml,
  buildSystemdUnitFile,
  loadAgentProfile,
  saveAgentProfile,
  deleteAgentProfile,
};

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
  duallane-agent version [--check] [--profile default] [--url <origin>]
  duallane-agent update [--check] [--force] [--no-restart] [--profile default] [--url <origin>]
  duallane-agent doctor [--profile default]
  duallane-agent daemon <install|start|stop|restart|uninstall|status|logs|run> [--agent auto|codex|claude|cmd] [--workdir <dir>] [--sandbox read-only|workspace-write] [--profile default]
  duallane-agent mcp [--profile default]
  duallane-agent status [--profile default]
  duallane-agent conversations [--profile default]
  duallane-agent updates [--ack] [--timeout 20] [--profile default]
  duallane-agent wait [--timeout 3600] [--transport auto|ws|poll] [--profile default]
  duallane-agent send <conversationId> <text> [--reply-to <messageId>] [--profile default]
  duallane-agent send-file <conversationId> <filePath> [--name <fileName>] [--mime <mimeType>] [--text <caption>] [--reply-to <messageId>] [--profile default]
  duallane-agent edit <messageId> <text> [--profile default]
  duallane-agent typing <conversationId> [--state thinking|typing] [--profile default]
  duallane-agent publish-mobile <apkPath> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]
  duallane-agent publish-mobile-ota <wwwDirOrZip> --version <semver> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]
  duallane-agent unbind [--profile default]
  duallane-agent listen --cmd "<shell-command>" [--transport auto|ws|poll] [--profile default]

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
  const transportMode = String(flags.transport || "auto").trim().toLowerCase();
  const { client, profile, profileName } = requireClient(flags.profile);
  const me = await client.getMe();
  process.stderr.write(
    `[DualLane] Listening as "${me?.bot?.name || profile.botName || "Bot"}" (${profile.url}) -> forwarding events to: ${cmd}\n`
  );

  let stopped = false;
  const handleIncomingEvent = async (event) => {
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
  };

  const runPollLoop = async (initialSeq) => {
    let cursor = initialSeq;
    process.stderr.write(`[DualLane] HTTP long-polling active (seq=${cursor})\n`);
    while (!stopped) {
      try {
        const polled = await client.pollNextEvent({
          afterSequence: cursor,
          timeoutMs: 25_000,
          onCursorAdvance: (seq) => {
            cursor = seq;
            updateProfileCursor(profileName, seq);
          },
          onSyncRequired: ({ currentSequence }) => {
            cursor = currentSequence;
            updateProfileCursor(profileName, currentSequence);
          },
        });
        cursor = polled.lastSequence;
        if (!polled.timeout && polled.event) {
          await handleIncomingEvent(polled.event);
        }
      } catch (err) {
        if (stopped) break;
        process.stderr.write(`[DualLane] Poll error (${err?.code || "poll_failed"}): ${err?.message || err}\n`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const shutdown = () => {
    stopped = true;
    process.stderr.write("\n[DualLane] Stopping listener...\n");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (transportMode === "poll") {
    await runPollLoop(profile.lastSequence || 0);
    return;
  }

  try {
    await client.connect({
      lastSequence: profile.lastSequence || 0,
      onStatus(state) {
        if (state.status === "connected") {
          process.stderr.write(`[DualLane] WebSocket connected (seq=${state.currentSequence ?? state.lastSequence})\n`);
        } else if (state.status === "disconnected") {
          process.stderr.write(`[DualLane] Disconnected, retrying in ${state.retryInMs}ms...\n`);
        }
      },
      onEvent: handleIncomingEvent,
      async onSyncRequired({ currentSequence }) {
        updateProfileCursor(profileName, currentSequence);
      },
      onError(err) {
        process.stderr.write(`[DualLane] Gateway error (${err.code}): ${err.message}\n`);
      },
    });
  } catch (err) {
    if (transportMode === "auto" && err?.retryable) {
      client.stop();
      process.stderr.write(`[DualLane] WebSocket unavailable (${err.code}), falling back to HTTP long-polling...\n`);
      await runPollLoop(client.lastSequence || profile.lastSequence || 0);
      return;
    }
    throw err;
  }
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const subcommand = positionals[0];

  if (flags.version || subcommand === "-v" || subcommand === "version") {
    const profile = loadAgentProfile(normalizeProfileName(flags.profile || "default"));
    const origin = String(flags.url || profile?.url || "").trim();
    if (flags.check && origin) {
      const check = await checkRuntimeUpdate({ origin });
      process.stdout.write(JSON.stringify(check, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      JSON.stringify(
        {
          version: DUALLANE_AGENT_SDK_VERSION,
          gatewayVersion: DUALLANE_GATEWAY_VERSION,
          node: process.version,
          scriptPath: resolveStandaloneScriptPath(),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (!subcommand || flags.help || flags.h || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "update" || subcommand === "upgrade") {
    const profile = loadAgentProfile(normalizeProfileName(flags.profile || "default"));
    const origin = String(flags.url || profile?.url || "https://duallane.tsio.top").trim();
    if (flags.check) {
      const check = await checkRuntimeUpdate({ origin });
      process.stdout.write(JSON.stringify(check, null, 2) + "\n");
      return;
    }
    const staged = await stageRuntimeSelfUpdate({
      origin,
      targetPath: typeof flags.target === "string" ? flags.target : "",
      force: Boolean(flags.force),
    });
    let restartedProfiles = [];
    if (staged.updated && !flags["no-restart"]) {
      restartedProfiles = await restartInstalledDaemons({ quiet: true });
    }
    process.stdout.write(
      JSON.stringify(
        {
          ...staged,
          restartedProfiles,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "doctor") {
    const { client, profile } = requireClient(flags.profile);
    const [doctor, me, updateInfo] = await Promise.all([
      client.getDoctor().catch(() => null),
      client.getMe().catch(() => null),
      checkRuntimeUpdate({ origin: profile.url }).catch(() => null),
    ]);
    process.stdout.write(
      JSON.stringify(
        {
          ok: Boolean(doctor?.ok || me?.bot?.id),
          profile: profile.profile,
          origin: profile.url,
          localSdkVersion: DUALLANE_AGENT_SDK_VERSION,
          runtimeUpdate: updateInfo,
          connection: me?.connection || null,
          bot: doctor?.bot || me?.bot || null,
          scopes: doctor?.scopes || me?.scopes || [],
          conversations: doctor?.conversations || [],
          recentDeliveries: doctor?.recentDeliveries || [],
        },
        null,
        2
      ) + "\n"
    );
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
    const remoteLatest = String(convs?.latestSdkVersion || "").trim();
    const updateAvailable =
      remoteLatest.length > 0 && compareRuntimeSemver(remoteLatest, DUALLANE_AGENT_SDK_VERSION) > 0;
    if (updateAvailable) {
      process.stderr.write(
        `[DualLane] New runtime available: v${DUALLANE_AGENT_SDK_VERSION} -> v${remoteLatest}. Run: duallane-agent update\n`
      );
    }
    process.stdout.write(
      JSON.stringify(
        {
          profile: profile.profile,
          origin: profile.url,
          sdkVersion: DUALLANE_AGENT_SDK_VERSION,
          latestSdkVersion: remoteLatest || DUALLANE_AGENT_SDK_VERSION,
          updateAvailable,
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
    const timeout = flags.timeout !== undefined ? Number(flags.timeout) : 0;
    let res = await client.getUpdates({ afterSequence, limit: Number(flags.limit || 50), timeout });
    if (res?.syncRequired && Number(res.currentSequence) > 0 && afterSequence === 0) {
      const fallbackSeq = Math.max(0, Number(res.currentSequence) - 100);
      const retry = await client
        .getUpdates({ afterSequence: fallbackSeq, limit: Number(flags.limit || 50), timeout })
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
    const transportMode = String(flags.transport || "auto").trim().toLowerCase();
    const startedAtMs = Date.now();

    const waitViaPoll = async (cursor) => {
      const remainingMs = Math.max(1000, timeoutSeconds * 1000 - (Date.now() - startedAtMs));
      const polled = await client.pollNextEvent({
        afterSequence: cursor,
        timeoutMs: remainingMs,
        conversationId: filterConv,
        onCursorAdvance: (seq) => updateProfileCursor(profileName, seq),
        onSyncRequired: ({ currentSequence }) => updateProfileCursor(profileName, currentSequence),
      });
      if (polled.timeout || !polled.event) {
        return {
          status: "timeout",
          profile: profileName,
          waitedSeconds: timeoutSeconds,
          lastSequence: polled.lastSequence,
          transport: "poll",
        };
      }
      const ev = polled.event;
      if (ev.conversationId) {
        await client.setTyping(ev.conversationId).catch(() => {});
      }
      let context = null;
      if (ev.conversationId && profile.scopes?.includes("messages:read_context")) {
        context = await client.getContext(ev.conversationId, { limit: 15 }).catch(() => null);
      }
      return {
        status: "event",
        profile: profileName,
        lastSequence: polled.lastSequence,
        transport: "poll",
        event: ev,
        context,
      };
    };

    const result =
      transportMode === "poll"
        ? await waitViaPoll(startSeq)
        : await new Promise((resolve, reject) => {
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
                transport: "ws",
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
                    transport: "ws",
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
                if (transportMode === "auto" && err?.retryable) {
                  waitViaPoll(client.lastSequence || startSeq).then(resolve, reject);
                  return;
                }
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

  if (subcommand === "send-file") {
    const [conversationId, filePath] = positionals.slice(1);
    if (!conversationId || !filePath) {
      throw new Error(
        "Usage: duallane-agent send-file <conversationId> <filePath> [--name <fileName>] [--mime <mimeType>] [--text <caption>] [--reply-to <msgId>]"
      );
    }
    const resolvedPath = path.resolve(filePath);
    const bytes = fs.readFileSync(resolvedPath);
    const fileName =
      typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : path.basename(resolvedPath);
    const mimeType =
      typeof flags.mime === "string" && flags.mime.trim()
        ? flags.mime.trim()
        : inferMimeTypeFromFileName(fileName);
    const { client } = requireClient(flags.profile);
    const res = await client.sendFile({
      conversationId,
      bytes,
      fileName,
      mimeType,
      text: typeof flags.text === "string" ? flags.text : undefined,
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

  if (subcommand === "typing") {
    const [conversationId] = positionals.slice(1);
    if (!conversationId) {
      throw new Error("Usage: duallane-agent typing <conversationId> [--state thinking|typing] [--profile default]");
    }
    const { client } = requireClient(flags.profile);
    const state = flags.state === "typing" ? "typing" : "thinking";
    const res = await client.setTyping(conversationId, { state });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packDirectoryToZipBuffer(rootDir) {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        files.push({ name: rel, data: fs.readFileSync(full) });
      }
    }
  };
  walk(rootDir, "");
  if (files.length === 0) {
    throw new Error(`Directory "${rootDir}" contains no files to pack`);
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const raw = file.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32Buffer(raw);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(8, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0x5421, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(compressed.length, 18);
    localHdr.writeUInt32LE(raw.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, compressed);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(8, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0x5421, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(compressed.length, 20);
    centralHdr.writeUInt32LE(raw.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

  if (subcommand === "publish-mobile") {
    const [apkPath] = positionals.slice(1);
    if (!apkPath) {
      throw new Error(
        "Usage: duallane-agent publish-mobile <apkPath> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]"
      );
    }
    const apkBytes = fs.readFileSync(apkPath);
    let notes = typeof flags.notes === "string" ? flags.notes : undefined;
    if (typeof flags["notes-file"] === "string" && flags["notes-file"].trim()) {
      notes = fs.readFileSync(flags["notes-file"].trim(), "utf8");
    }
    const minNativeCode = flags["min-native-code"] ? Number(flags["min-native-code"]) : undefined;
    const { client } = requireClient(flags.profile);
    const res = await client.publishMobileRelease({
      apkBytes,
      version: typeof flags.version === "string" ? flags.version : undefined,
      versionCode: flags["version-code"] ? Number(flags["version-code"]) : undefined,
      minNativeVersionCode: minNativeCode,
      title: typeof flags.title === "string" ? flags.title : undefined,
      notes,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "publish-mobile-ota") {
    const [targetPath] = positionals.slice(1);
    if (!targetPath || typeof flags.version !== "string" || !flags.version.trim()) {
      throw new Error(
        "Usage: duallane-agent publish-mobile-ota <wwwDirOrZip> --version <semver> [--min-native-code <code>] [--title <title>] [--notes <md> | --notes-file <file>] [--profile default]"
      );
    }
    const stat = fs.statSync(targetPath);
    const zipBytes = stat.isDirectory() ? packDirectoryToZipBuffer(targetPath) : fs.readFileSync(targetPath);
    let notes = typeof flags.notes === "string" ? flags.notes : undefined;
    if (typeof flags["notes-file"] === "string" && flags["notes-file"].trim()) {
      notes = fs.readFileSync(flags["notes-file"].trim(), "utf8");
    }
    const minNativeCode = flags["min-native-code"] ? Number(flags["min-native-code"]) : undefined;
    const { client } = requireClient(flags.profile);
    const res = await client.publishMobileOTA({
      zipBytes,
      version: flags.version.trim(),
      minNativeVersionCode: minNativeCode,
      title: typeof flags.title === "string" ? flags.title : undefined,
      notes,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (subcommand === "unbind") {
    const { client, profileName } = requireClient(flags.profile);
    const revoked = await client.unbind().catch(() => ({ ok: false }));
    const deleted = deleteAgentProfile(profileName);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          profile: profileName,
          serverRevoked: Boolean(revoked?.ok),
          localDeleted: deleted,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (subcommand === "daemon") {
    await manageDaemonCli(positionals.slice(1), flags);
    return;
  }

  if (subcommand === "listen") {
    await runListen(flags);
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Run "duallane-agent --help".`);
}

const isDirectCli = (() => {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isDirectCli) {
  main().catch((err) => {
    const safeMsg = String(err?.message || err).replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
    process.stderr.write(`[DualLane Error] ${safeMsg}\n`);
    process.exit(1);
  });
}
