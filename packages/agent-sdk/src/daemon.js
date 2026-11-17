import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareRuntimeSemver,
  DualLaneAgentClient,
  DUALLANE_AGENT_SDK_VERSION,
  inferMimeTypeFromFileName,
} from "./index.js";
import { getAgentConfigDir, loadAgentProfile, normalizeProfileName, updateProfileCursor } from "./profile-store.js";
import { AgentRuntimeError, AGENT_MAX_RESULT_BYTES, parseAgentBridgeResult, resolveAgentTrigger, safeAgentError } from "./bridge-protocol.js";
import { createAgentTaskRuntime, readAgentTaskSummary, recoverAgentTaskOwner, requestAgentTaskControl } from "./task-runtime.js";
import { fetchPublicMedia, validateArtifactBytes } from "./media.js";
import { prepareAgentInputs } from "./inbound.js";
import { inspectOfficialRuntime, installOfficialRuntime } from "./runtime-update.js";

const DAEMON_VALID_AGENTS = new Set(["auto", "cmd"]);
const DAEMON_VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function getDaemonStateDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "daemons");
}

export function getDaemonLogDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "logs");
}

export function createDaemonMediaResolver({ enabled, dnsServers = [], fetchMedia = fetchPublicMedia }) {
  if (!enabled) return undefined;
  return (url, { signal } = {}) => fetchMedia(url, { enabled: true, signal,
    ...(dnsServers.length ? { dnsServers } : {}) });
}

export function getDaemonServiceLabel(profileName) {
  return `top.tsio.duallane.agent.${normalizeProfileName(profileName)}`;
}

export function getMacLaunchAgentPath(profileName, homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${getDaemonServiceLabel(profileName)}.plist`);
}

export function getLinuxSystemdUnitName(profileName) {
  return `duallane-agent-${normalizeProfileName(profileName)}.service`;
}

export function getLinuxSystemdUnitPath(profileName, homeDir = os.homedir()) {
  return path.join(homeDir, ".config", "systemd", "user", getLinuxSystemdUnitName(profileName));
}

function escapeDaemonXml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function buildLaunchdPlistXml(spec) {
  const argsXml = spec.programArguments
    .map((arg) => `      <string>${escapeDaemonXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.env || {})
    .filter(([, val]) => typeof val === "string" && val.length > 0)
    .map(
      ([k, v]) => `      <key>${escapeDaemonXml(k)}</key>\n      <string>${escapeDaemonXml(v)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeDaemonXml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeDaemonXml(spec.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeDaemonXml(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeDaemonXml(spec.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
  </dict>
</plist>
`;
}

export function buildSystemdUnitFile(spec) {
  const quotedArgs = spec.programArguments
    .map((arg) => `"${String(arg).replace(/(["\\])/gu, "\\$1")}"`)
    .join(" ");
  const envLines = Object.entries(spec.env || {})
    .filter(([, val]) => typeof val === "string" && val.length > 0)
    .map(([k, v]) => `Environment="${k}=${String(v).replace(/(["\\])/gu, "\\$1")}"`)
    .join("\n");

  return `[Unit]
Description=DualLane Agent Resident Listener (${spec.profileName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDirectory}
ExecStart=${quotedArgs}
Restart=always
RestartSec=3
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
${envLines}

[Install]
WantedBy=default.target
`;
}

export function detectAvailableAgentBinary(preferred = "auto") {
  const normalized = String(preferred || "auto").trim().toLowerCase();
  if (!DAEMON_VALID_AGENTS.has(normalized)) {
    throw new TypeError(`Unsupported --agent "${preferred}". Use auto or cmd with --cmd <command>.`);
  }
  return normalized;
}

export function buildDaemonAgentPrompt({ botName, conversation, event, context }) {
  const isGroup = conversation?.type === "group" || conversation?.kind === "group";
  const convTitle = conversation?.title || (isGroup ? "群聊" : "私聊");
  const eventType = String(event?.type || event?.eventType || "message.created");
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};

  const contextMessages = Array.isArray(context?.messages) ? context.messages : [];
  const historyLines = contextMessages.slice(-20).map((m) => {
    const speaker =
      m.authorName ||
      m.senderName ||
      (m.authorKind === "bot" || m.kind === "bot" ? botName || "Bot" : "成员");
    const ts = m.createdAt ? String(m.createdAt).slice(11, 19) : "";
    const text = String(m.plainText || "").trim() || "[媒体/卡片消息]";
    return `[${ts}] ${speaker}: ${text}`;
  });

  const latestMsgText = String(resolveAgentTrigger(event, context)?.plainText || "").trim();

  const safetyRule = isGroup
    ? [
        `安全边界（群聊强制策略）：当前消息来自多人共享群聊「${convTitle}」。`,
        `严禁执行任何修改本机文件、修改系统配置、安装软件、读取敏感私钥凭证或具有副作用的命令；仅作为群聊智能体提供对话解答与信息协助。`,
      ].join("\n")
    : `当前消息来自主人授权的一对一私聊会话。请直接给出清晰、准确、简洁的回复。`;

  const fileGuidance = `生成产物应通过 duallane.agent.result v1 结构化协议导出真实字节。兼容文本模式可使用 <duallane-file name="文件名.ext">文件正文</duallane-file>（二进制内容加 encoding="base64"）。不得提供本机路径；只有渠道返回发送回执后才能确认附件已经发出。`;

  const sections = [
    `你是接入在 DualLane 协作空间中的 AI 智能体「${botName || "Bot"}」。`,
    `请直接输出你要发送到当前聊天窗口的最终回复正文（支持 Markdown，不要输出“以下是回复”等多余包装语，也不要调用 duallane-agent send 发送，外层守护进程会自动将你的最终回复发出）。`,
    fileGuidance,
    safetyRule,
  ];

  if (historyLines.length > 0) {
    sections.push(`最近会话上下文（按时间顺序）：\n${historyLines.join("\n")}`);
  }

  if (eventType === "card.action") {
    sections.push(
      `触发事件：用户点击了交互卡片按钮 actionId="${payload.actionId || ""}"，附加数据：${JSON.stringify(payload.data || {})}`
    );
  } else if (eventType === "command.invoked") {
    sections.push(
      `触发事件：用户调用了指令 /${payload.command || ""} ${payload.args || ""}`.trim()
    );
  } else if (latestMsgText) {
    sections.push(`最新待回复消息：\n${latestMsgText}`);
  }

  return sections.join("\n\n");
}

export function extractGeneratedFilesFromReply(rawReply) {
  const result = parseAgentBridgeResult(String(rawReply || ""), { validateBytes: validateArtifactBytes });
  if (result.artifacts.some((artifact) => artifact.source !== "inline")) throw new AgentRuntimeError("artifact.runtime_required");
  return { cleanText: result.text, files: result.artifacts.map(({ fileName, mimeType, bytes }) => ({ fileName, mimeType, bytes })) };
}

function readDaemonRecord(profileName, configDir) {
  const filePath = path.join(getDaemonStateDir(configDir), `${normalizeProfileName(profileName)}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeDaemonRecord(profileName, record, configDir) {
  const dir = getDaemonStateDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${normalizeProfileName(profileName)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return filePath;
}

function isDaemonPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 1) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveStandaloneScriptPath(explicitPath = "") {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  const argvScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (
    argvScript &&
    argvScript.endsWith("duallane-agent.mjs") &&
    !argvScript.includes(`${path.sep}packages${path.sep}agent-sdk${path.sep}bin${path.sep}`)
  ) {
    return argvScript;
  }
  return path.join(os.homedir(), ".duallane", "bin", "duallane-agent.mjs");
}

export async function checkRuntimeUpdate(options = {}) {
  return inspectOfficialRuntime(options);
}

export async function stageRuntimeSelfUpdate(options = {}) {
  return installOfficialRuntime({ ...options, targetPath: resolveStandaloneScriptPath(options.targetPath) });
}

export async function restartInstalledDaemons({ configDir, quiet = true } = {}) {
  const dir = getDaemonStateDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const restarted = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const profileName = entry.slice(0, -5);
    const rec = readDaemonRecord(profileName, configDir);
    if (!rec) continue;
    try {
      await manageDaemonCli(["restart"], { profile: profileName, quiet });
      restarted.push(profileName);
    } catch {
      /* ignore stale profile */
    }
  }
  return restarted;
}

export async function invokeDaemonAgentTurn({ customCmd, workdir, request, signal, toolEnvironment, timeoutMs = 300_000 }) {
  if (!customCmd) throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new AgentRuntimeError("bridge.input_limit");
  if (signal?.aborted) throw new AgentRuntimeError("bridge.cancelled");
  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DUALLANE_BOT_TOKEN;
    delete env.DUALLANE_TOKEN;
    delete env.DUALLANE_MESSAGE_TEXT;
    delete env.DUALLANE_TASK_BROKER_URL;
    delete env.DUALLANE_TASK_BROKER_KEY;
    if (toolEnvironment) {
      env.DUALLANE_TASK_BROKER_URL = toolEnvironment.DUALLANE_TASK_BROKER_URL;
      env.DUALLANE_TASK_BROKER_KEY = toolEnvironment.DUALLANE_TASK_BROKER_KEY;
    }
    env.DUALLANE_CONVERSATION_ID = String(request.event.conversationId);
    env.DUALLANE_EVENT_TYPE = String(request.event.type || "");
    const child = spawn(customCmd, { cwd: workdir, shell: true, windowsHide: true,
      detached: process.platform !== "win32", env, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBytes = 0, stderrBytes = 0, failure, settled = false;
    const chunks = [];
    const terminate = (code) => {
      if (failure) return;
      failure = new AgentRuntimeError(code);
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
    };
    const aborted = () => terminate("bridge.cancelled");
    const timer = setTimeout(() => terminate("bridge.timeout"), Math.min(600_000, Math.max(100, timeoutMs)));
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > AGENT_MAX_RESULT_BYTES) terminate("bridge.output_limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) terminate("bridge.stderr_limit");
    });
    child.stdin.on("error", () => { /* Exit/error below determines the safe result. */ });
    child.on("error", () => finish(new AgentRuntimeError("bridge.spawn_failed")));
    child.on("close", (code) => finish(failure || (code !== 0 ? new AgentRuntimeError("bridge.failed") : null), Buffer.concat(chunks).toString("utf8").trim()));
    child.stdin.end(input);
  });
}

export async function runResidentDaemon(flags = {}) {
  const profileName = normalizeProfileName(flags.profile || "default");
  const profile = loadAgentProfile(profileName);
  if (!profile) throw new Error(`Profile "${profileName}" is not configured. Run setup first.`);
  const savedCfg = readDaemonRecord(profileName) || {};
  if (savedCfg.pausedReason) {
    // Revoked credentials remain paused across supervisor restarts until an
    // operator explicitly runs daemon start/restart with the updated profile.
    writeDaemonRecord(profileName, { ...savedCfg, pid: process.pid, healthy: false });
    await new Promise((resolve) => {
      const timer = setInterval(() => {}, 60_000);
      const resume = () => { clearInterval(timer); process.removeListener("SIGINT", resume); process.removeListener("SIGTERM", resume); resolve(); };
      process.once("SIGINT", resume); process.once("SIGTERM", resume);
    });
    return;
  }
  const customCmd = typeof flags.cmd === "string" ? flags.cmd.trim() : (savedCfg.cmd || "");
  const agentMode = detectAvailableAgentBinary(flags.agent || (typeof flags.cmd === "string" && flags.cmd.trim() ? "cmd" : savedCfg.agent) || (customCmd ? "cmd" : "auto"));
  if (!customCmd) throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
  const workdir = path.resolve(String(flags.workdir || savedCfg.workdir || os.homedir()));
  const rawSandbox = String(flags.sandbox || savedCfg.sandbox || "read-only").trim();
  const sandboxMode = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
  const model = typeof flags.model === "string" ? flags.model.trim() : (savedCfg.model || "");
  const transportMode = String(flags.transport || savedCfg.transport || "auto").trim().toLowerCase();
  const allowPublicMedia = flags["allow-public-media"] === true || flags["allow-public-media"] === "true" || (flags["allow-public-media"] === undefined && savedCfg.allowPublicMedia === true);
  const mediaDnsServers = typeof flags["media-dns-servers"] === "string" ? flags["media-dns-servers"].split(",").map((value) => value.trim()).filter(Boolean) : (savedCfg.mediaDnsServers || []);
  const autoUpdateEnabled = flags["auto-update"] === undefined ? savedCfg.autoUpdateEnabled !== false : flags["auto-update"] !== "false" && flags["auto-update"] !== false;
  const stateDir = path.join(getDaemonStateDir(), "tasks");
  const client = new DualLaneAgentClient({ url: profile.url, token: profile.token, adapterVersion: `duallane-daemon/${DUALLANE_AGENT_SDK_VERSION}` });
  const log = (code) => process.stderr.write(`[${new Date().toISOString()}] [DualLane] ${code}\n`);
  let record = { ...savedCfg, profile: profileName, agent: agentMode, cmd: customCmd,
    workdir, sandbox: sandboxMode, model: model || undefined, transport: transportMode,
    allowPublicMedia, mediaDnsServers, autoUpdateEnabled, pid: process.pid, healthy: false, probeError: null,
    startedAt: new Date().toISOString() };
  let me;
  try { me = await client.getMe(); }
  catch (error) {
    if ([401, 403].includes(error?.statusCode ?? error?.status)) {
      writeDaemonRecord(profileName, { ...record, pausedReason: safeAgentError(error).code, probeError: safeAgentError(error).code });
    }
    throw error;
  }
  const botId = me?.bot?.id || profile.botId;
  const scopes = Array.isArray(me?.scopes) ? me.scopes : [];
  let stopped = false, runtime, pendingRestart = false, updateBusy = false, stopResolve;
  const shutdownSignal = new Promise((resolve) => { stopResolve = resolve; });
  const timers = [];
  const updateRecord = (patch) => {
    record = { ...record, ...patch, updatedAt: new Date().toISOString() };
    writeDaemonRecord(profileName, record);
  };
  const shutdown = async () => {
    if (stopped) return;
    stopped = true; client.stop(); timers.forEach(clearInterval);
    await runtime?.close(); stopResolve();
  };
  const signalShutdown = () => { void shutdown(); };
  process.once("SIGINT", signalShutdown); process.once("SIGTERM", signalShutdown);
  runtime = createAgentTaskRuntime({ stateDir, origin: profile.url, botId, client, scopes,
    maxConcurrency: Number(flags.concurrency || savedCfg.concurrency || 2),
    prepareInputs: prepareAgentInputs,
    validateBytes: validateArtifactBytes,
    resolveMedia: createDaemonMediaResolver({ enabled: allowPublicMedia, dnsServers: mediaDnsServers }),
    invoke: (request, { signal, toolEnvironment }) => invokeDaemonAgentTurn({ customCmd, workdir, request, signal, toolEnvironment }),
    onState(summary) {
      updateRecord({ taskSummary: summary });
      if (pendingRestart && summary.pending === 0 && summary.active === 0) void shutdown();
    },
  });
  try { writeDaemonRecord(profileName, record); runtime.start(); }
  catch (error) {
    await runtime.close(); process.removeListener("SIGINT", signalShutdown); process.removeListener("SIGTERM", signalShutdown); throw error;
  }
  let cursor = Number(profile.lastSequence || 0);
  const acceptEvent = (event) => {
    const isBusinessEvent = ["message.created", "bot.mentioned", "command.invoked", "card.action"].includes(event.type);
    const accepted = runtime.accept(isBusinessEvent ? event : { ...event, conversationId: event.conversationId || "__runtime__" }, { completed: !isBusinessEvent });
    if (event.type === "bot.runtime_upgrade") void checkUpdate();
    return accepted;
  };
  const activeScriptPath = path.resolve(process.argv[1] || resolveStandaloneScriptPath());
  const isStandalone = activeScriptPath.endsWith("duallane-agent.mjs") && !activeScriptPath.includes(`${path.sep}packages${path.sep}agent-sdk${path.sep}bin${path.sep}`);
  const checkUpdate = async () => {
    if (!autoUpdateEnabled || !isStandalone || stopped || updateBusy || pendingRestart) return;
    updateBusy = true;
    try {
      const result = await stageRuntimeSelfUpdate({ origin: profile.url, targetPath: activeScriptPath });
      if (result.updated) {
        pendingRestart = true;
        if (runtime.summary().pending === 0 && runtime.summary().active === 0) await shutdown();
      }
    } catch (error) { log(`update.${safeAgentError(error).code}`); }
    finally { updateBusy = false; }
  };
  if (autoUpdateEnabled && isStandalone) {
    const first = setTimeout(() => { void checkUpdate(); }, 15_000); first.unref?.(); timers.push(first);
    const periodic = setInterval(() => { void checkUpdate(); }, 20 * 60_000); periodic.unref?.(); timers.push(periodic);
  }
  const polling = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const result = await client.pollNextEvent({ afterSequence: cursor, timeoutMs: 25_000, ack: false,
          onSyncRequired({ currentSequence }) {
            cursor = currentSequence; updateProfileCursor(profileName, cursor);
          } });
        if (result.event) {
          acceptEvent(result.event);
          await client.acknowledge({ eventId: result.event.eventId, sequence: result.event.sequence });
          cursor = result.event.sequence;
          updateProfileCursor(profileName, cursor);
        }
        failures = 0; updateRecord({ healthy: true, probeError: null });
      } catch (error) {
        const safe = safeAgentError(error); failures += 1;
        updateRecord({ healthy: false, probeError: safe.code }); log(safe.code);
        if ([401, 403].includes(error?.statusCode ?? error?.status)) updateRecord({ pausedReason: safe.code });
        if ([401, 403].includes(error?.statusCode ?? error?.status) || !safe.retryable || failures >= 3) throw new AgentRuntimeError(safe.code);
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, failures * 1000)));
      }
    }
  };
  try {
    if (transportMode === "poll") await polling();
    else {
      try {
        await client.connect({ lastSequence: cursor,
          onEvent(event) { acceptEvent(event); updateProfileCursor(profileName, event.sequence); },
          onStatus(state) { updateRecord({ healthy: state.status === "connected", probeError: state.status === "connected" ? null : "gateway.disconnected" }); },
          onSyncRequired({ currentSequence }) { cursor = currentSequence; updateProfileCursor(profileName, cursor); },
          onError(error) {
            const safe = safeAgentError(error); updateRecord({ healthy: false, probeError: safe.code }); log(safe.code);
            if ([401, 403].includes(error?.statusCode ?? error?.status)) { updateRecord({ pausedReason: safe.code }); void shutdown(); }
          },
        });
        await shutdownSignal;
      } catch (error) {
        client.stop();
        if (transportMode === "auto" && error?.retryable) await polling();
        else throw error;
      }
    }
  } finally {
    await shutdown();
    process.removeListener("SIGINT", signalShutdown); process.removeListener("SIGTERM", signalShutdown);
    updateRecord({ healthy: false, stoppedAt: new Date().toISOString() });
  }
  if (pendingRestart && record.manager === "detached") {
    const args = [activeScriptPath, "daemon", "run", "--profile", profileName];
    const logPath = record.logPath || path.join(getDaemonLogDir(), `${profileName}.log`);
    const logFd = fs.openSync(logPath, "a", 0o600);
    try {
      const child = spawn(process.execPath, args, { cwd: workdir, env: process.env, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] });
      child.unref(); updateRecord({ pid: child.pid });
    } finally { fs.closeSync(logFd); }
  }
}

function stopDetachedPidIfRunning(profileName, configDir) {
  const rec = readDaemonRecord(profileName, configDir);
  if (rec?.pid && isDaemonPidAlive(rec.pid)) {
    try {
      process.kill(Number(rec.pid), "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function manageDaemonCli(positionals = [], flags = {}) {
  const action = String(positionals[0] || "status").trim().toLowerCase();
  const profileName = normalizeProfileName(flags.profile || "default");

  if (action === "recover-lock") {
    const profile = loadAgentProfile(profileName);
    if (!profile?.botId) throw new AgentRuntimeError("runtime.identity_required");
    const recovered = recoverAgentTaskOwner({ stateDir: path.join(getDaemonStateDir(), "tasks"), origin: profile.url, botId: profile.botId },
      { confirmStopped: flags["confirm-stopped"] === true || flags["confirm-stopped"] === "true" });
    process.stdout.write(JSON.stringify(recovered) + "\n");
    return;
  }

  if (action === "retry" || action === "cancel") {
    const profile = loadAgentProfile(profileName);
    if (!profile?.botId) throw new AgentRuntimeError("runtime.identity_required");
    const control = requestAgentTaskControl({ stateDir: path.join(getDaemonStateDir(), "tasks"),
      origin: profile.url, botId: profile.botId }, String(positionals[1] || ""), action);
    process.stdout.write(JSON.stringify(control) + "\n");
    return;
  }

  if (action === "run") {
    await runResidentDaemon(flags);
    return;
  }

  const scriptPath = resolveStandaloneScriptPath(flags.script);
  const nodePath = process.execPath;
  const logDir = getDaemonLogDir();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${profileName}.log`);
  const label = getDaemonServiceLabel(profileName);

  if (action === "logs") {
    const maxLines = Math.max(10, Math.min(500, Number(flags.lines || 60)));
    if (!fs.existsSync(logPath)) {
      process.stdout.write(`No daemon logs yet at ${logPath}\n`);
      return;
    }
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    process.stdout.write(lines.slice(-maxLines).join("\n") + "\n");
    return;
  }

  if (action === "install" || action === "start" || action === "restart") {
    const profile = loadAgentProfile(profileName);
    if (!profile) {
      throw new Error(
        `Profile "${profileName}" is not configured. Run: duallane-agent setup "<setupUrl>" --profile ${profileName}`
      );
    }
    const prev = readDaemonRecord(profileName) || {};
    const customCmd = typeof flags.cmd === "string" ? flags.cmd.trim() : (prev.cmd || "");
    const agentMode = detectAvailableAgentBinary(
      flags.agent ||
      (typeof flags.cmd === "string" && flags.cmd.trim() ? "cmd" : prev.agent) ||
      (customCmd ? "cmd" : "auto")
    );
    if (!customCmd) {
      throw new TypeError("Resident daemons require --cmd <command>; no agent executable is selected automatically.");
    }
    const workdir = path.resolve(String(flags.workdir || prev.workdir || process.cwd()));
    const rawSandbox = String(flags.sandbox || prev.sandbox || "read-only").trim();
    const sandbox = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
    const model = typeof flags.model === "string" ? flags.model.trim() : (prev.model || "");
    const transport = String(flags.transport || prev.transport || "auto").trim().toLowerCase();
    const allowPublicMedia = flags["allow-public-media"] === undefined ? prev.allowPublicMedia === true : [true, "true"].includes(flags["allow-public-media"]);
    const mediaDnsServers = typeof flags["media-dns-servers"] === "string" ? flags["media-dns-servers"].split(",").map((value) => value.trim()).filter(Boolean) : (prev.mediaDnsServers || []);
    const autoUpdateEnabled = flags["auto-update"] === undefined ? prev.autoUpdateEnabled !== false : ![false, "false"].includes(flags["auto-update"]);

    const programArguments = [
      nodePath,
      scriptPath,
      "daemon",
      "run",
      "--profile",
      profileName,
      "--agent",
      agentMode,
      "--workdir",
      workdir,
      "--sandbox",
      sandbox,
      "--transport",
      transport,
    ];
    if (model) programArguments.push("--model", model);
    if (customCmd) programArguments.push("--cmd", customCmd);
    programArguments.push("--allow-public-media", String(allowPublicMedia), "--auto-update", String(autoUpdateEnabled));
    if (mediaDnsServers.length) programArguments.push("--media-dns-servers", mediaDnsServers.join(","));

    const env = {
      HOME: os.homedir(),
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG || "en_US.UTF-8",
    };

    let manager = "detached";
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const plistPath = getMacLaunchAgentPath(profileName);
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(
        plistPath,
        buildLaunchdPlistXml({
          label,
          programArguments,
          workingDirectory: workdir,
          logPath,
          env,
        }),
        "utf8"
      );
      const domain = `gui/${process.getuid()}`;
      spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
      stopDetachedPidIfRunning(profileName);
      const boot = spawnSync("launchctl", ["bootstrap", domain, plistPath], { encoding: "utf8" });
      if (boot.status === 0) {
        spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
        manager = "launchd";
      }
    } else if (process.platform === "linux") {
      const unitPath = getLinuxSystemdUnitPath(profileName);
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(
        unitPath,
        buildSystemdUnitFile({
          profileName,
          programArguments,
          workingDirectory: workdir,
          logPath,
          env,
        }),
        "utf8"
      );
      stopDetachedPidIfRunning(profileName);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      const enable = spawnSync(
        "systemctl",
        ["--user", "enable", "--now", getLinuxSystemdUnitName(profileName)],
        { encoding: "utf8" }
      );
      if (enable.status === 0) {
        spawnSync("systemctl", ["--user", "restart", getLinuxSystemdUnitName(profileName)], {
          stdio: "ignore",
        });
        manager = "systemd";
      }
    }

    let spawnedPid = null;
    if (manager === "detached") {
      stopDetachedPidIfRunning(profileName);
      const logFd = fs.openSync(logPath, "a");
      const child = spawn(programArguments[0], programArguments.slice(1), {
        cwd: workdir,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);
      spawnedPid = child.pid;
    }

    const record = {
      profile: profileName,
      botName: profile.botName || null,
      manager,
      label,
      agent: agentMode,
      cmd: customCmd || undefined,
      workdir,
      sandbox,
      model: model || undefined,
      transport,
      allowPublicMedia,
      mediaDnsServers,
      autoUpdateEnabled,
      logPath,
      pid: spawnedPid || undefined,
      installedAt: new Date().toISOString(),
    };
    writeDaemonRecord(profileName, record);

    if (!flags.quiet) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            action,
            profile: profileName,
            manager,
            agent: agentMode,
            sandbox,
            workdir,
            logPath,
            ...(spawnedPid ? { pid: spawnedPid } : {}),
          },
          null,
          2
        ) + "\n"
      );
    }
    return;
  }

  if (action === "stop" || action === "uninstall") {
    const stoppedVia = [];
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const plistPath = getMacLaunchAgentPath(profileName);
      const domain = `gui/${process.getuid()}`;
      const res = spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
      if (res.status === 0) stoppedVia.push("launchd");
      if (action === "uninstall" && fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }
    } else if (process.platform === "linux") {
      const unitName = getLinuxSystemdUnitName(profileName);
      const unitPath = getLinuxSystemdUnitPath(profileName);
      const res = spawnSync(
        "systemctl",
        ["--user", action === "uninstall" ? "disable" : "stop", "--now", unitName],
        { stdio: "ignore" }
      );
      if (res.status === 0) stoppedVia.push("systemd");
      if (action === "uninstall" && fs.existsSync(unitPath)) {
        fs.unlinkSync(unitPath);
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      }
    }
    if (stopDetachedPidIfRunning(profileName)) {
      stoppedVia.push("pid");
    }
    if (action === "uninstall") {
      const recFile = path.join(getDaemonStateDir(), `${profileName}.json`);
      if (fs.existsSync(recFile)) fs.unlinkSync(recFile);
    }
    process.stdout.write(
      JSON.stringify({ ok: true, action, profile: profileName, stoppedVia }, null, 2) + "\n"
    );
    return;
  }

  if (action === "status") {
    const rec = readDaemonRecord(profileName);
    let serviceRunning = false;
    if (process.platform === "darwin" && typeof process.getuid === "function") {
      const check = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
        encoding: "utf8",
      });
      if (check.status === 0 && /state\s*=\s*running/iu.test(String(check.stdout || ""))) {
        serviceRunning = true;
      }
    } else if (process.platform === "linux") {
      const check = spawnSync("systemctl", ["--user", "is-active", getLinuxSystemdUnitName(profileName)], {
        encoding: "utf8",
      });
      if (check.status === 0 && String(check.stdout || "").trim() === "active") {
        serviceRunning = true;
      }
    }
    if (!serviceRunning && rec?.pid && isDaemonPidAlive(rec.pid)) {
      serviceRunning = true;
    }

    let remoteConnection = null, probeError = null, taskSummary = null;
    const profile = loadAgentProfile(profileName);
    if (profile) {
      const client = new DualLaneAgentClient({
        url: profile.url,
        token: profile.token,
        adapterVersion: `duallane-cli/${DUALLANE_AGENT_SDK_VERSION}`,
      });
      try {
        const me = await client.getMe();
        remoteConnection = me?.connection || null;
        if (me?.bot?.id) taskSummary = readAgentTaskSummary({ stateDir: path.join(getDaemonStateDir(), "tasks"), origin: profile.url, botId: me.bot.id });
      } catch (error) { probeError = safeAgentError(error).code; }
    }

    process.stdout.write(
      JSON.stringify(
        {
          profile: profileName,
          running: serviceRunning,
          healthy: serviceRunning && !probeError && rec?.healthy === true,
          probeError,
          taskSummary,
          daemon: rec || null,
          gatewayConnection: remoteConnection,
          logPath,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  throw new Error(
    `Unknown daemon action "${action}". Usage: duallane-agent daemon <install|start|stop|restart|uninstall|status|logs|run|retry|cancel> [taskId] [--profile default]`
  );
}
