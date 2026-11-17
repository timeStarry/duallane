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

const DAEMON_VALID_AGENTS = new Set(["auto", "cmd"]);
const DAEMON_VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function getDaemonStateDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "daemons");
}

export function getDaemonLogDir(configDir) {
  return path.resolve(getAgentConfigDir(configDir), "..", "logs");
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

export function detectAvailableAgentBinary(preferred = "auto", envPath = process.env.PATH || "") {
  const normalized = String(preferred || "auto").trim().toLowerCase();
  if (!DAEMON_VALID_AGENTS.has(normalized)) {
    
  }
  return normalized;
}". `);
  }
  if (normalized === "cmd") return "cmd";

  
  if (checkBin("claude")) return "claude";
  return "codex";
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

  const latestMsgText =
    String(
      payload?.message?.plainText ||
        payload?.text ||
        (contextMessages.length > 0 ? contextMessages[contextMessages.length - 1]?.plainText : "") ||
        ""
    ).trim();

  const safetyRule = isGroup
    ? [
        `安全边界（群聊强制策略）：当前消息来自多人共享群聊「${convTitle}」。`,
        `严禁执行任何修改本机文件、修改系统配置、安装软件、读取敏感私钥凭证或具有副作用的命令；仅作为群聊智能体提供对话解答与信息协助。`,
      ].join("\n")
    : `当前消息来自主人授权的一对一私聊会话。请直接给出清晰、准确、简洁的回复。`;

  const fileGuidance = isGroup
    ? `如需向群内生成并发送文档、表格、SVG 图表或代码附件，请直接在回复中使用标签包裹文件内容：<duallane-file name="文件名.ext">文件正文</duallane-file>（二进制内容可加 encoding="base64"），外层守护进程会自动将其作为真实文件附件上传并发送到会话。`
    : `如需向主人发送你生成的文件或图片，可使用 <duallane-file name="文件名.ext">文件正文</duallane-file>（二进制内容加 encoding="base64"），或在工作目录/临时目录生成文件后在回复末尾附上 [[DUALLANE_FILE: /绝对路径/文件名.ext]]，外层守护进程会自动上传并作为会话附件发出。`;

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

export function extractGeneratedFilesFromReply(rawReply, options = {}) {
  const allowLocalPath = Boolean(options.allowLocalPath);
  const workdir = options.workdir ? path.resolve(options.workdir) : "";
  const files = [];

  let text = String(rawReply || "");

  // 1. Parse inline <duallane-file name="..." [mime="..."] [encoding="base64"]>...</duallane-file>
  const inlineFileRe = /<duallane-file\s+([^>]*)>([\s\S]*?)<\/duallane-file>/giu;
  text = text.replace(inlineFileRe, (_full, attrRaw, innerBody) => {
    const nameMatch = /\bname\s*=\s*["']([^"']+)["']/iu.exec(attrRaw);
    const mimeMatch = /\bmime\s*=\s*["']([^"']+)["']/iu.exec(attrRaw);
    const encMatch = /\bencoding\s*=\s*["']([^"']+)["']/iu.exec(attrRaw);
    const rawName = path.basename(String(nameMatch?.[1] || "generated.txt").trim()) || "generated.txt";
    const isBase64 = String(encMatch?.[1] || "").trim().toLowerCase() === "base64";
    const bodyTrimmed = String(innerBody || "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const bytes = isBase64
      ? Buffer.from(bodyTrimmed.replace(/\s+/gu, ""), "base64")
      : Buffer.from(bodyTrimmed, "utf8");
    if (bytes.byteLength > 0 && files.length < 6) {
      files.push({
        fileName: rawName,
        mimeType: String(mimeMatch?.[1] || inferMimeTypeFromFileName(rawName)).trim(),
        bytes,
      });
    }
    return "";
  });

  // 2. Parse [[DUALLANE_FILE: /path/to/file]] (strictly allowed only in private 1-on-1 DM within workdir or tmpdir)
  const localFileRe = /\[\[DUALLANE_FILE:\s*([^\]]+?)\s*\]\]/gu;
  text = text.replace(localFileRe, (_full, rawPath) => {
    if (!allowLocalPath || files.length >= 6) return "";
    try {
      const candidate = path.resolve(workdir || process.cwd(), String(rawPath || "").trim());
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return "";
      const realCandidate = fs.realpathSync(candidate);
      const allowedRoots = [os.tmpdir(), workdir].filter(Boolean).map((r) => {
        try {
          return fs.realpathSync(r);
        } catch {
          return path.resolve(r);
        }
      });
      const withinAllowed = allowedRoots.some(
        (root) => realCandidate === root || realCandidate.startsWith(root + path.sep)
      );
      if (!withinAllowed) return "";
      const segments = realCandidate.split(path.sep);
      if (segments.some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")) {
        return "";
      }
      const bytes = fs.readFileSync(realCandidate);
      if (bytes.byteLength > 0 && bytes.byteLength <= 50 * 1024 * 1024) {
        const fileName = path.basename(realCandidate);
        files.push({
          fileName,
          mimeType: inferMimeTypeFromFileName(fileName),
          bytes,
        });
      }
    } catch {
      /* ignore inaccessible local path */
    }
    return "";
  });

  const cleanText = text.replace(/\n{3,}/gu, "\n\n").trim();
  return { cleanText, files };
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

export async function checkRuntimeUpdate({
  origin,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
} = {}) {
  const cleanOrigin = String(origin || "").trim().replace(/\/+$/u, "");
  if (!cleanOrigin || typeof fetchImpl !== "function") {
    throw new Error("A DualLane server origin is required to check runtime updates.");
  }
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const manifestUrl = `${cleanOrigin}/integrations/duallane-agent.manifest.json?t=${Math.floor(
    Date.now() / 60000
  )}`;
  const downloadUrl = `${cleanOrigin}/integrations/duallane-agent.mjs`;

  const res = await fetchImpl(manifestUrl, {
    method: "GET",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    ...(signal ? { signal } : {}),
  });

  if (res.ok) {
    const manifest = await res.json();
    const latestVersion = String(manifest?.version || "").trim();
    if (!latestVersion) {
      throw new Error("Invalid runtime manifest: missing version.");
    }
    return {
      currentVersion: DUALLANE_AGENT_SDK_VERSION,
      latestVersion,
      updateAvailable: compareRuntimeSemver(latestVersion, DUALLANE_AGENT_SDK_VERSION) > 0,
      sha256: String(manifest?.sha256 || "").trim().toLowerCase(),
      byteSize: Number(manifest?.byteSize || 0),
      downloadUrl,
      highlights: Array.isArray(manifest?.highlights) ? manifest.highlights : [],
    };
  }

  // Fallback for older servers before manifest endpoint existed
  const scriptRes = await fetchImpl(downloadUrl, {
    method: "GET",
    headers: { "Cache-Control": "no-cache" },
    ...(signal ? { signal } : {}),
  });
  if (!scriptRes.ok) {
    throw new Error(`Runtime update check failed with HTTP ${scriptRes.status}`);
  }
  const scriptText = await scriptRes.text();
  const verMatch = /DUALLANE_AGENT_SDK_VERSION\s*=\s*["']([^"']+)["']/u.exec(scriptText);
  const latestVersion = String(verMatch?.[1] || DUALLANE_AGENT_SDK_VERSION).trim();
  const digest = crypto.createHash("sha256").update(scriptText, "utf8").digest("hex");
  return {
    currentVersion: DUALLANE_AGENT_SDK_VERSION,
    latestVersion,
    updateAvailable: compareRuntimeSemver(latestVersion, DUALLANE_AGENT_SDK_VERSION) > 0,
    sha256: digest,
    byteSize: Buffer.byteLength(scriptText, "utf8"),
    downloadUrl,
    highlights: [],
  };
}

export async function stageRuntimeSelfUpdate({
  origin,
  targetPath = "",
  force = false,
  skipSyntaxCheck = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const check = await checkRuntimeUpdate({ origin, fetchImpl, timeoutMs });
  const resolvedTarget = resolveStandaloneScriptPath(targetPath);
  if (!check.updateAvailable && !force) {
    return {
      ...check,
      updated: false,
      targetPath: resolvedTarget,
    };
  }

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const sep = check.downloadUrl.includes("?") ? "&" : "?";
  const dlRes = await fetchImpl(
    `${check.downloadUrl}${sep}v=${encodeURIComponent(check.latestVersion)}&t=${Date.now()}`,
    {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      ...(signal ? { signal } : {}),
    }
  );
  if (!dlRes.ok) {
    throw new Error(`Failed to download runtime bundle (HTTP ${dlRes.status})`);
  }
  const rawBytes = Buffer.from(await dlRes.arrayBuffer());
  if (rawBytes.byteLength < 1024) {
    throw new Error("Downloaded runtime bundle is unexpectedly small; aborting update.");
  }
  const actualSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  if (check.sha256 && actualSha256 !== check.sha256) {
    throw new Error(
      `Runtime SHA-256 mismatch (expected ${check.sha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...)`
    );
  }

  const targetDir = path.dirname(resolvedTarget);
  fs.mkdirSync(targetDir, { recursive: true });
  const tmpPath = path.join(
    targetDir,
    `.${path.basename(resolvedTarget, ".mjs")}.tmp.${process.pid}.${Date.now()}.mjs`
  );
  fs.writeFileSync(tmpPath, rawBytes, { mode: 0o755 });
  try {
    fs.chmodSync(tmpPath, 0o755);
    if (!skipSyntaxCheck) {
      const syntax = spawnSync(process.execPath, ["--check", tmpPath], { encoding: "utf8" });
      if (syntax.status !== 0) {
        throw new Error(`Downloaded runtime failed syntax check: ${syntax.stderr || "invalid JS"}`);
      }
    }
    fs.renameSync(tmpPath, resolvedTarget);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  return {
    ...check,
    sha256: actualSha256,
    updated: true,
    targetPath: resolvedTarget,
  };
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

async function invokeDaemonAgentTurn({
  agentMode,
  customCmd,
  workdir,
  sandboxMode,
  model,
  botName,
  conversation,
  event,
  context,
}) {
  if (agentMode === "cmd" || customCmd) {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.DUALLANE_BOT_TOKEN;
      env.DUALLANE_CONVERSATION_ID = String(event?.conversationId || "");
      env.DUALLANE_EVENT_TYPE = String(event?.type || "");
      env.DUALLANE_MESSAGE_TEXT = String(
        event?.payload?.message?.plainText || event?.payload?.text || ""
      );
      const child = spawn(customCmd, {
        cwd: workdir,
        shell: true,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
      child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Custom bridge command exited with code ${code}: ${stderr.slice(-300)}`));
          return;
        }
        resolve(stdout.trim());
      });
      child.stdin.end(JSON.stringify({ event, context, conversation }));
    });
  }

  const prompt = buildDaemonAgentPrompt({ botName, conversation, event, context });
  const isGroup = conversation?.type === "group" || conversation?.kind === "group";
  const effectiveSandbox = isGroup ? "read-only" : sandboxMode;

  if (agentMode === "claude") { throw new Error("Claude mode removed"); };
      delete env.DUALLANE_BOT_TOKEN;
      const child = spawn("claude", args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
      child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude -p exited with code ${code}: ${stderr.slice(-300)}`));
          return;
        }
        resolve(stdout.trim());
      });
      child.stdin.end(prompt);
    });
  }

  const tmpOut = path.join(
    os.tmpdir(),
    `duallane-codex-reply-${process.pid}-${crypto.randomUUID()}.txt`
  );
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    effectiveSandbox,
    "-C",
    workdir,
    "-o",
    tmpOut,
  ];
  if (model) {
    args.push("-m", model);
  }
  args.push("-");

  try {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.DUALLANE_BOT_TOKEN;
      const child = spawn("codex", args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
      child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`codex exec exited with code ${code}: ${stderr.slice(-400)}`));
          return;
        }
        let reply = "";
        if (fs.existsSync(tmpOut)) {
          reply = fs.readFileSync(tmpOut, "utf8").trim();
        }
        if (!reply) {
          reply = stdout.trim();
        }
        resolve(reply);
      });
      child.stdin.end(prompt);
    });
  } finally {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
  }
}

export async function runResidentDaemon(flags = {}) {
  const profileName = normalizeProfileName(flags.profile || "default");
  const profile = loadAgentProfile(profileName);
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" is not configured. Run: duallane-agent setup "<setupUrl>" --profile ${profileName}`
    );
  }

  const savedCfg = readDaemonRecord(profileName) || {};
  const customCmd = typeof flags.cmd === "string" ? flags.cmd.trim() : (savedCfg.cmd || "");
  const requestedAgent = String(flags.agent || savedCfg.agent || (customCmd ? "cmd" : "auto")).trim();
  const agentMode = detectAvailableAgentBinary(requestedAgent);
  const workdir = path.resolve(String(flags.workdir || savedCfg.workdir || os.homedir()));
  const rawSandbox = String(flags.sandbox || savedCfg.sandbox || "read-only").trim();
  const sandboxMode = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
  const model = typeof flags.model === "string" ? flags.model.trim() : (savedCfg.model || "");
  const transportMode = String(flags.transport || savedCfg.transport || "auto").trim().toLowerCase();

  const client = new DualLaneAgentClient({
    url: profile.url,
    token: profile.token,
    adapterVersion: `duallane-daemon/${DUALLANE_AGENT_SDK_VERSION}`,
  });

  const logLine = (msg) => {
    process.stderr.write(`[${new Date().toISOString()}] [DualLane Daemon:${profileName}] ${msg}\n`);
  };

  let botName = profile.botName || "Bot";
  const convMetaMap = new Map();
  const refreshConversations = async () => {
    try {
      const [me, convs] = await Promise.all([
        client.getMe().catch(() => null),
        client.listConversations().catch(() => null),
      ]);
      if (me?.bot?.name) botName = me.bot.name;
      for (const c of convs?.conversations || []) {
        if (c?.id) convMetaMap.set(c.id, c);
      }
    } catch {
      /* non-fatal */
    }
  };
  await refreshConversations();

  let initialSeq = Number(profile.lastSequence || 0);
  if (initialSeq === 0) {
    const probe = await client.getUpdates({ afterSequence: 0, limit: 1 }).catch(() => null);
    if (probe?.syncRequired && Number(probe.currentSequence) > 0) {
      initialSeq = Math.max(0, Number(probe.currentSequence) - 20);
      updateProfileCursor(profileName, initialSeq);
    }
  }

  logLine(
    `Started resident listener for "${botName}" (agent=${agentMode}, sandbox=${sandboxMode}, seq=${initialSeq}, pid=${process.pid})`
  );

  writeDaemonRecord(profileName, {
    ...savedCfg,
    profile: profileName,
    botName,
    agent: agentMode,
    cmd: customCmd || undefined,
    workdir,
    sandbox: sandboxMode,
    model: model || undefined,
    transport: transportMode,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  let stopped = false;
  let inFlightTurns = 0;
  let pendingRestartVersion = "";
  let updateCheckBusy = false;
  const autoUpdateEnabled = flags["auto-update"] !== "false" && flags["auto-update"] !== false;
  const activeScriptPath = path.resolve(process.argv[1] || resolveStandaloneScriptPath());
  const isStandaloneRuntime =
    activeScriptPath.endsWith("duallane-agent.mjs") &&
    !activeScriptPath.includes(`${path.sep}packages${path.sep}agent-sdk${path.sep}bin${path.sep}`);

  const maybeRestartForPendingUpdate = () => {
    if (stopped || !pendingRestartVersion || inFlightTurns > 0) return;
    stopped = true;
    const targetVer = pendingRestartVersion;
    logLine(`Idle window reached -> applying silent auto-update to v${targetVer} now...`);
    client.stop();
    const rec = readDaemonRecord(profileName) || savedCfg;
    if (rec?.manager === "detached") {
      try {
        const logDir = getDaemonLogDir();
        const logPath = rec.logPath || path.join(logDir, `${profileName}.log`);
        const logFd = fs.openSync(logPath, "a");
        const args = [
          activeScriptPath,
          "daemon",
          "run",
          "--profile",
          profileName,
          "--agent",
          agentMode,
          "--workdir",
          workdir,
          "--sandbox",
          sandboxMode,
          "--transport",
          transportMode,
        ];
        if (model) args.push("--model", model);
        if (customCmd) args.push("--cmd", customCmd);
        const child = spawn(process.execPath, args, {
          cwd: workdir,
          env: process.env,
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        fs.closeSync(logFd);
        writeDaemonRecord(profileName, { ...rec, pid: child.pid });
      } catch (err) {
        logLine(`Detached respawn failed: ${err?.message || err}`);
      }
    }
    setTimeout(() => process.exit(0), 120);
  };

  const checkAndStageSilentUpdate = async (reason = "periodic") => {
    if (stopped || updateCheckBusy || pendingRestartVersion || !isStandaloneRuntime) return;
    updateCheckBusy = true;
    try {
      const res = await stageRuntimeSelfUpdate({
        origin: profile.url,
        targetPath: activeScriptPath,
      });
      if (res.updated) {
        pendingRestartVersion = res.latestVersion;
        logLine(
          `Downloaded & verified runtime v${res.latestVersion} (${reason}, sha256=${res.sha256.slice(
            0,
            12
          )}). ${inFlightTurns > 0 ? "Waiting for active reply to finish..." : "Restarting daemon..."}`
        );
        maybeRestartForPendingUpdate();
      }
    } catch (err) {
      if (reason === "remote_request") {
        logLine(`Silent update check warning: ${err?.message || err}`);
      }
    } finally {
      updateCheckBusy = false;
    }
  };

  if (autoUpdateEnabled && isStandaloneRuntime) {
    const initialUpdateTimer = setTimeout(() => {
      void checkAndStageSilentUpdate("startup");
    }, 15_000);
    initialUpdateTimer.unref?.();
    const periodicUpdateTimer = setInterval(() => {
      void checkAndStageSilentUpdate("periodic");
    }, 20 * 60 * 1000);
    periodicUpdateTimer.unref?.();
  }

  const conversationQueues = new Map();
  const processedSequences = new Set();

  const processSingleEvent = async (event) => {
    const seq = Number(event?.sequence || 0);
    if (seq > 0) {
      if (processedSequences.has(seq)) return;
      processedSequences.add(seq);
      if (processedSequences.size > 500) {
        const oldest = processedSequences.values().next().value;
        processedSequences.delete(oldest);
      }
      updateProfileCursor(profileName, seq);
    }
    if (event?.type === "bot.runtime_upgrade") {
      logLine(
        `Received remote runtime upgrade signal (target=${
          event?.payload?.targetVersion || "latest"
        })`
      );
      void checkAndStageSilentUpdate("remote_request");
      return;
    }
    const convId = String(event?.conversationId || "").trim();
    if (!convId) return;

    inFlightTurns += 1;
    try {
      if (!convMetaMap.has(convId)) {
        await refreshConversations();
      }
      const conversation = convMetaMap.get(convId) || { id: convId };

      logLine(`Processing event seq=${seq} type=${event.type || "message.created"} conv=${convId}`);
      await client.setTyping(convId, { state: "thinking" }).catch(() => {});
      const typingTimer = setInterval(() => {
        if (!stopped) {
          void client.setTyping(convId, { state: "thinking" }).catch(() => {});
        }
      }, 3800);
      typingTimer.unref?.();

      try {
        let context = null;
        if (!profile.scopes || profile.scopes.includes("messages:read_context")) {
          context = await client.getContext(convId, { limit: 20 }).catch(() => null);
        }
        const replyText = await invokeDaemonAgentTurn({
          agentMode,
          customCmd,
          workdir,
          sandboxMode,
          model,
          botName,
          conversation,
          event,
          context,
        });
        if (replyText) {
          const replyToId =
            event.payload?.message?.id ||
            event.payload?.messageId ||
            (Array.isArray(context?.messages) && context.messages.length > 0
              ? context.messages[context.messages.length - 1]?.id
              : undefined);
          const isGroupConv = conversation?.type === "group" || conversation?.kind === "group";
          const { cleanText, files: generatedFiles } = extractGeneratedFilesFromReply(replyText, {
            allowLocalPath: !isGroupConv,
            workdir,
          });

          if (generatedFiles.length > 0) {
            for (let idx = 0; idx < generatedFiles.length; idx += 1) {
              const gf = generatedFiles[idx];
              await client.sendFile({
                conversationId: convId,
                bytes: gf.bytes,
                fileName: gf.fileName,
                mimeType: gf.mimeType,
                text: idx === 0 && cleanText ? cleanText.slice(0, 28_000) : undefined,
                replyToMessageId: idx === 0 ? replyToId : undefined,
                clientMessageId: `${event.eventId}:file:${idx}`,
              });
            }
            logLine(`Sent ${generatedFiles.length} generated file(s) to conv=${convId} seq=${seq}`);
          } else if (cleanText) {
            await client.sendMessage({
              conversationId: convId,
              text: cleanText.slice(0, 28_000),
              replyToMessageId: replyToId,
              clientMessageId: `${event.eventId}:reply`,
              idempotencyKey: `${event.eventId}:reply`,
            });
            logLine(`Replied to conv=${convId} seq=${seq} (${cleanText.length} chars)`);
          }
        }
      } catch (err) {
        const safeErr = String(err?.message || err).replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
        logLine(`Turn error on conv=${convId} seq=${seq}: ${safeErr}`);
      } finally {
        clearInterval(typingTimer);
      }
    } finally {
      inFlightTurns = Math.max(0, inFlightTurns - 1);
      maybeRestartForPendingUpdate();
    }
  };

  const enqueueConversationEvent = (event) => {
    const convId = String(event?.conversationId || "__global__");
    const prev = conversationQueues.get(convId) || Promise.resolve();
    const next = prev
      .then(() => processSingleEvent(event))
      .catch((err) => logLine(`Queue error: ${err?.message || err}`));
    conversationQueues.set(convId, next);
    return next;
  };

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    logLine("Shutting down resident daemon...");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const runPollingSupervisor = async (startCursor) => {
    let cursor = startCursor;
    logLine(`HTTP long-polling supervisor active (seq=${cursor})`);
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
          await enqueueConversationEvent(polled.event);
        }
      } catch (err) {
        if (stopped) break;
        logLine(`Long-poll error (${err?.code || "network"}): ${err?.message || err}; retrying in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  if (transportMode === "poll") {
    await runPollingSupervisor(initialSeq);
    return;
  }

  while (!stopped) {
    try {
      await client.connect({
        lastSequence: Number(loadAgentProfile(profileName)?.lastSequence ?? initialSeq),
        onStatus(state) {
          if (state.status === "connected") {
            logLine(`WebSocket connected (seq=${state.currentSequence ?? state.lastSequence})`);
          } else if (state.status === "disconnected") {
            logLine(`WebSocket disconnected (attempt=${state.attempt}), reconnecting in ${state.retryInMs}ms...`);
          }
        },
        onEvent(event) {
          return enqueueConversationEvent(event);
        },
        async onSyncRequired({ currentSequence, reason }) {
          logLine(`Cursor sync_required (${reason}) -> advancing to seq=${currentSequence}`);
          updateProfileCursor(profileName, currentSequence);
        },
        onError(err) {
          logLine(`Gateway warning (${err.code}): ${err.message}`);
        },
      });
      await new Promise(() => {});
    } catch (err) {
      if (stopped) break;
      client.stop();
      if (transportMode === "auto" && err?.retryable) {
        logLine(`WebSocket initial handshake unavailable (${err.code}), switching to HTTP long-polling...`);
        await runPollingSupervisor(client.lastSequence || initialSeq);
        return;
      }
      logLine(`Connection failed (${err?.code || "error"}): ${err?.message || err}; retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
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
      flags.agent || prev.agent || (customCmd ? "cmd" : "auto")
    );
    const workdir = path.resolve(String(flags.workdir || prev.workdir || process.cwd()));
    const rawSandbox = String(flags.sandbox || prev.sandbox || "read-only").trim();
    const sandbox = DAEMON_VALID_SANDBOXES.has(rawSandbox) ? rawSandbox : "read-only";
    const model = typeof flags.model === "string" ? flags.model.trim() : (prev.model || "");
    const transport = String(flags.transport || prev.transport || "auto").trim().toLowerCase();

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

    let remoteConnection = null;
    const profile = loadAgentProfile(profileName);
    if (profile) {
      const client = new DualLaneAgentClient({
        url: profile.url,
        token: profile.token,
        adapterVersion: `duallane-cli/${DUALLANE_AGENT_SDK_VERSION}`,
      });
      const me = await client.getMe().catch(() => null);
      remoteConnection = me?.connection || null;
    }

    process.stdout.write(
      JSON.stringify(
        {
          profile: profileName,
          running: serviceRunning,
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
    `Unknown daemon action "${action}". Usage: duallane-agent daemon <install|start|stop|restart|uninstall|status|logs|run> [--profile default]`
  );
}
