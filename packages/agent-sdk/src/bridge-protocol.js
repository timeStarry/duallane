import crypto from "node:crypto";
import { inferMimeTypeFromFileName } from "./index.js";
import { decodeArtifactBase64 } from "./base64.js";

export const AGENT_BRIDGE_PROTOCOL_VERSION = 1;
export const AGENT_MAX_RESULT_BYTES = 70 * 1024 * 1024;
const BRIDGE_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const BRIDGE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class AgentRuntimeError extends Error {
  constructor(code, { retryable = false, stage = "running" } = {}) {
    super(code);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.stage = stage;
  }
}

export function safeAgentError(error, stage = "running") {
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_.]{1,63}$/u.test(error.code)
    ? error.code : "task.failed";
  return {
    code,
    stage,
    retryable: error?.retryable === true || [408, 429, 502, 503, 504].includes(error?.statusCode ?? error?.status),
  };
}

function bridgeHumanMessage(message) {
  return message && ["human", "user"].includes(message.authorKind || message.senderKind || message.kind);
}

export function resolveAgentTrigger(event, context) {
  const payload = event?.payload || {};
  if (event?.type === "command.invoked") {
    if (payload.argsComplete === false) throw new AgentRuntimeError("input.trigger_truncated");
    return null;
  }
  if (event?.type === "card.action") return null;
  const explicitId = payload.messageId || payload.message?.id || event?.messageId;
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  if (explicitId) {
    const message = payload.message?.id === explicitId ? payload.message : messages.find((item) => item?.id === explicitId);
    if (!message && payload.textComplete === true && typeof payload.text === "string") {
      return { id: explicitId, authorKind: "human", plainText: payload.text };
    }
    if (!message || ["bot", "system"].includes(message.authorKind || message.kind)) {
      throw new AgentRuntimeError("input.trigger_unavailable");
    }
    return structuredClone(message);
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return { id: null, authorKind: "human", plainText: payload.text };
  }
  const human = [...messages].reverse().find(bridgeHumanMessage);
  if (!human) throw new AgentRuntimeError("input.trigger_unavailable");
  return structuredClone(human);
}

export function buildAgentBridgeRequest({ taskId, event, context, conversation, capabilities = {}, inputs = [], artifacts = [] }) {
  if (!conversation?.id || conversation.id !== event?.conversationId) {
    throw new AgentRuntimeError("input.conversation_mismatch");
  }
  const triggerMessage = resolveAgentTrigger(event, context);
  return {
    protocol: "duallane.agent.request",
    version: AGENT_BRIDGE_PROTOCOL_VERSION,
    taskId,
    event,
    context,
    conversation,
    triggerMessage,
    capabilities: {
      resultProtocolVersion: AGENT_BRIDGE_PROTOCOL_VERSION,
      maxArtifacts: 6,
      maxArtifactBytes: BRIDGE_MAX_ARTIFACT_BYTES,
      localPathOutput: false,
      publicMedia: false,
      ...capabilities,
    },
    inputs,
    artifacts,
  };
}

function bridgeFileName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\\/\x00-\x1f\x7f]/u.test(value) || value === "." || value === "..") {
    throw new AgentRuntimeError("artifact.invalid_name");
  }
  return value.trim();
}

function bridgeDecodeBytes(data, encoding, maxBytes) {
  if (typeof data !== "string") throw new AgentRuntimeError("artifact.invalid_data");
  if (maxBytes < 1) throw new AgentRuntimeError("artifact.too_large");
  if (encoding === "base64") {
    return decodeArtifactBase64(data, { maxBytes });
  }
  if (encoding !== "utf8") throw new AgentRuntimeError("artifact.invalid_encoding");
  if (Buffer.byteLength(data) > maxBytes) throw new AgentRuntimeError("artifact.too_large");
  return Buffer.from(data, "utf8");
}

function bridgeLegacyResult(text) {
  if (/\[\[DUALLANE_FILE:/u.test(text)) throw new AgentRuntimeError("artifact.local_path_denied");
  const artifacts = [];
  const cleanText = text.replace(/<duallane-file\s+([^>]*)>([\s\S]*?)<\/duallane-file>/giu, (_full, attrs, inner) => {
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(attrs)?.[1];
    const fileName = attr("name") || "generated.txt";
    artifacts.push({ id: `legacy-${artifacts.length + 1}`, source: "inline", fileName,
      mimeType: attr("mime") || inferMimeTypeFromFileName(fileName),
      encoding: attr("encoding") || "utf8", data: inner.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "") });
    return "";
  }).replace(/\n{3,}/gu, "\n\n").trim();
  return { protocol: "duallane.agent.result", version: 1, status: "completed", text: cleanText, artifacts };
}

export function parseAgentBridgeResult(raw, { taskId, validateBytes } = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > AGENT_MAX_RESULT_BYTES) throw new AgentRuntimeError("bridge.output_limit");
  let result;
  try { result = JSON.parse(raw); } catch { /* Plain stdout is a supported compatibility format. */ }
  if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "protocol")) result = bridgeLegacyResult(raw);
  if (result.protocol !== "duallane.agent.result" || result.version !== 1) throw new AgentRuntimeError("bridge.protocol_unsupported");
  if (result.taskId !== undefined && result.taskId !== taskId) throw new AgentRuntimeError("bridge.task_mismatch");
  if (result.status !== "completed") throw new AgentRuntimeError(result.status === "cancelled" ? "bridge.cancelled" : "bridge.incomplete");
  if (typeof result.text !== "string" || result.text.length > 28_000) throw new AgentRuntimeError("bridge.invalid_text");
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 6) throw new AgentRuntimeError("artifact.count_limit");
  const seen = new Set(); let totalBytes = 0;
  const artifacts = result.artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(artifact.id) || seen.has(artifact.id)) {
      throw new AgentRuntimeError("artifact.invalid_id");
    }
    seen.add(artifact.id);
    if (artifact.source === "artifact") {
      if (typeof artifact.artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.artifactId)) throw new AgentRuntimeError("artifact.invalid_reference");
      return { id: artifact.id, source: "artifact", artifactId: artifact.artifactId };
    }
    if (artifact.source === "https") {
      if (typeof artifact.url !== "string" || artifact.url.length > 4096) throw new AgentRuntimeError("media.invalid_url");
      return { id: artifact.id, source: "https", url: artifact.url,
        ...(artifact.fileName !== undefined ? { fileName: bridgeFileName(artifact.fileName) } : {}) };
    }
    if (artifact.source !== "inline") throw new AgentRuntimeError("artifact.source_unsupported");
    const fileName = bridgeFileName(artifact.fileName);
    const mimeType = String(artifact.mimeType || inferMimeTypeFromFileName(fileName)).toLowerCase();
    const bytes = bridgeDecodeBytes(artifact.data, artifact.encoding, Math.min(BRIDGE_MAX_ARTIFACT_BYTES, BRIDGE_MAX_TOTAL_BYTES - totalBytes));
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > BRIDGE_MAX_ARTIFACT_BYTES || totalBytes > BRIDGE_MAX_TOTAL_BYTES) throw new AgentRuntimeError("artifact.too_large");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (artifact.byteSize !== undefined && artifact.byteSize !== bytes.length) throw new AgentRuntimeError("artifact.size_mismatch");
    if (artifact.sha256 !== undefined && artifact.sha256 !== sha256) throw new AgentRuntimeError("artifact.digest_mismatch");
    validateBytes?.(bytes, mimeType);
    return { id: artifact.id, source: "inline", fileName, mimeType, bytes, sha256 };
  });
  if (!result.text.trim() && !artifacts.length) throw new AgentRuntimeError("bridge.empty_result");
  return { text: result.text.trim(), artifacts };
}
