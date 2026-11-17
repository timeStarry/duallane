import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SETUP_ID_RE = /^setup_[A-Za-z0-9_-]{16,}$/u;

export const DEFAULT_SETUP_SCOPES = Object.freeze([
  "messages:read_trigger",
  "messages:read_context",
  "messages:send",
  "files:read_metadata",
  "files:write",
  "cards:write",
  "cards:act",
  "commands:receive",
]);

export function normalizeProfileName(profile = "default") {
  const trimmed = String(profile || "default").trim() || "default";
  if (!SAFE_PROFILE.test(trimmed)) {
    throw new TypeError(`Invalid profile name: ${trimmed}`);
  }
  return trimmed;
}

export function sanitizeSetupClientName(raw, fallback = "duallane-agent/1.0.0") {
  const cleaned = String(raw || "")
    .replace(/[^A-Za-z0-9._/+ -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 120);
  return cleaned || fallback;
}

export function getAgentConfigDir(overrideDir) {
  if (overrideDir) return path.resolve(overrideDir);
  if (process.env.DUALLANE_AGENT_CONFIG_DIR) {
    return path.resolve(process.env.DUALLANE_AGENT_CONFIG_DIR);
  }
  return path.join(os.homedir(), ".config", "duallane", "agents");
}

export function resolveProfilePath(profile = "default", configDir) {
  return path.join(getAgentConfigDir(configDir), `${normalizeProfileName(profile)}.json`);
}

export function resolvePendingSetupPath(profile = "default", configDir) {
  return path.join(getAgentConfigDir(configDir), `${normalizeProfileName(profile)}.pending.json`);
}

export function parseSetupTarget(setupUrlOrId, explicitUrl) {
  const raw = String(setupUrlOrId || "").trim();
  if (!raw) {
    throw new TypeError("setupUrl or setupSessionId is required");
  }

  if (SETUP_ID_RE.test(raw)) {
    const base = String(explicitUrl || process.env.DUALLANE_URL || "").trim();
    if (!base) {
      throw new TypeError("Full setup URL or --url <origin> is required when passing a bare setupSessionId");
    }
    const parsedBase = new URL(base);
    const origin = parsedBase.origin;
    return {
      origin,
      setupSessionId: raw,
      approvalUrl: `${origin}/workspace?setup=${encodeURIComponent(raw)}`,
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("setupUrl must be a valid DualLane setup URL or setup_<id>");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("setupUrl must use http:// or https://");
  }
  const setupSessionId = (parsed.searchParams.get("setup") || parsed.searchParams.get("setupSessionId") || "").trim();
  if (!SETUP_ID_RE.test(setupSessionId)) {
    throw new TypeError("setupUrl does not contain a valid ?setup=setup_<id> parameter");
  }
  const origin = parsed.origin;
  return {
    origin,
    setupSessionId,
    approvalUrl: `${origin}/workspace?setup=${encodeURIComponent(setupSessionId)}`,
  };
}

export function loadAgentProfile(profile = "default", options = {}) {
  const normalized = normalizeProfileName(profile);
  const filePath = resolveProfilePath(normalized, options.configDir);
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.url && parsed?.token) {
      return {
        source: "profile",
        profile: normalized,
        filePath,
        url: parsed.url,
        token: parsed.token,
        botId: parsed.botId || null,
        botName: parsed.botName || null,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
        lastSequence: Number.isSafeInteger(parsed.lastSequence) && parsed.lastSequence >= 0 ? parsed.lastSequence : 0,
        updatedAt: parsed.updatedAt || null,
      };
    }
  }

  const envUrl = String(process.env.DUALLANE_URL || "").trim();
  const envToken = String(process.env.DUALLANE_BOT_TOKEN || "").trim();
  if (envUrl && envToken) {
    return {
      source: "env",
      profile: normalized,
      filePath: null,
      url: new URL(envUrl).origin,
      token: envToken,
      botId: null,
      botName: null,
      scopes: [],
      lastSequence: 0,
      updatedAt: null,
    };
  }

  return null;
}

export function saveAgentProfile(profile = "default", data = {}, options = {}) {
  const normalized = normalizeProfileName(profile);
  const dir = getAgentConfigDir(options.configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = resolveProfilePath(normalized, options.configDir);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    profile: normalized,
    url: new URL(data.url).origin,
    token: String(data.token || "").trim(),
    botId: data.botId || null,
    botUserId: data.botUserId || null,
    botName: data.botName || null,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    lastSequence: Number.isSafeInteger(data.lastSequence) && data.lastSequence >= 0 ? data.lastSequence : 0,
    clientName: data.clientName || null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return { profile: normalized, filePath };
}

export function updateProfileCursor(profile = "default", lastSequence, options = {}) {
  const existing = loadAgentProfile(profile, options);
  if (!existing || existing.source !== "profile" || !existing.filePath) return;
  if (!Number.isSafeInteger(lastSequence) || lastSequence <= existing.lastSequence) return;
  const raw = JSON.parse(fs.readFileSync(existing.filePath, "utf8"));
  raw.lastSequence = lastSequence;
  raw.updatedAt = new Date().toISOString();
  const tmpPath = `${existing.filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, existing.filePath);
}

export function savePendingSetup(profile = "default", pending = {}, options = {}) {
  const normalized = normalizeProfileName(profile);
  const dir = getAgentConfigDir(options.configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = resolvePendingSetupPath(normalized, options.configDir);
  const payload = {
    profile: normalized,
    origin: pending.origin,
    setupSessionId: pending.setupSessionId,
    approvalUrl: pending.approvalUrl,
    clientName: pending.clientName || "duallane-agent",
    clientVersion: pending.clientVersion || "1.0.0",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function loadPendingSetup(profile = "default", options = {}) {
  const filePath = resolvePendingSetupPath(profile, options.configDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function clearPendingSetup(profile = "default", options = {}) {
  const filePath = resolvePendingSetupPath(profile, options.configDir);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function deleteAgentProfile(profile = "default", options = {}) {
  const normalized = normalizeProfileName(profile);
  const filePath = resolveProfilePath(normalized, options.configDir);
  clearPendingSetup(normalized, options);
  let removed = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed = true;
    }
  } catch {
    /* ignore */
  }
  return { profile: normalized, filePath, removed };
}
