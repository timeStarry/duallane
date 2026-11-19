import { DualLaneAgentClient } from "../../packages/agent-sdk/src/index.js";
import { loadAgentProfile } from "../../packages/agent-sdk/src/profile-store.js";
import { buildAgentInteractiveCard, createTaskBrokerMcpAdapter } from "../../packages/agent-sdk/src/task-tools.js";
import { identifier, releaseAgentError, repositoryNames } from "./config.mjs";

export const approvalNamespace = "duallane.release-agent.v1";
const privateMaterial = /#k=|\bBearer\s+[a-z0-9._~+/-]{12,}|\b(?:gh[pousr]_|github_pat_|sk-)[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/[^\s/]+:[^\s/]+@|[?&](?:access_token|token|signature|x-amz-signature)=/iu;

export function safeText(value, limit) {
  return typeof value === "string" && !privateMaterial.test(value) && Buffer.byteLength(value) <= limit
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim() : "";
}

function cardProse(value) {
  return value.replace(/https?:\/\/[^\s)]+/giu, "［链接］").replace(/\s+/gu, " ").replace(/[[\]<>`*_]/gu, "\\$&");
}

export function approvalCard(ticket) {
  const { candidate, approval } = ticket;
  const title = `${ticket.id} ${approval.mode === "pilot" ? "试运行确认" : "发布确认"}`;
  const changes = candidate.changes.map((change) => {
    const repo = repositoryNames[change.repo];
    const reference = change.number ? `[${repo} #${change.number}](https://github.com/${repo}/pull/${change.number})` : `${repo} 本地候选`;
    return `- ${reference} · \`${change.head}\``;
  });
  const routes = [];
  if (candidate.goWeb) routes.push(`Go/Web ${candidate.goWeb.version}`);
  if (candidate.ota) routes.push(`Android OTA ${candidate.ota.version}（兼容原生版本码 ${candidate.ota.minNativeVersionCode}）`);
  if (candidate.native) routes.push("签名 APK（维护者处理）");
  const baselines = [approval.baseline?.goWeb?.version && `Go/Web ${approval.baseline.goWeb.version}`,
    approval.baseline?.ota?.version && `OTA ${approval.baseline.ota.version}`].filter(Boolean);
  const markdown = [cardProse(candidate.summary), ...changes, `发布顺序 · ${routes.join(" → ") || "合入后结束"}`,
    ...(candidate.ota ? [`OTA SHA-256 · \`${candidate.ota.sha256}\``] : []),
    ...(baselines.length ? [`回退基线 · ${baselines.join("，")}`] : []),
    `候选摘要 · \`${approval.fingerprint}\``, `有效期 · ${new Date(approval.expiresAt).toISOString()}`,
    ...candidate.evidence.map((item) => `- ${cardProse(item)}`)].join("\n\n");
  const value = { namespace: approvalNamespace, ticketId: ticket.id, fingerprint: approval.fingerprint, nonce: approval.nonce };
  return { fallbackText: title, card: buildAgentInteractiveCard({ title, markdown,
    buttons: [{ actionId: "confirm", label: approval.mode === "pilot" ? "确认试运行" : "确认发版", style: "primary", value },
      { actionId: "cancel", label: "暂缓", value }] }) };
}

export function createCometChannel({ config, client }) {
  const channel = config.channel;
  if (!client) {
    const profile = loadAgentProfile(channel.profile, { configDir: channel.profileDirectory });
    if (profile?.source !== "profile" || profile.url !== channel.origin || profile.botName !== "Comet") {
      throw releaseAgentError("release_agent.comet_profile");
    }
    client = new DualLaneAgentClient({ url: profile.url, token: profile.token, requestTimeoutMs: 15_000,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }) });
  }

  async function authorize(conversationId, type, requiredScopes = ["messages:send"]) {
    const [identity, access, capability] = await Promise.all([
      client.getMe(), client.listConversations(), client.getCapabilities(conversationId),
    ]);
    const conversation = access.conversations?.find((row) => row.id === conversationId && row.type === type);
    if (identity.bot?.id !== channel.botId || identity.spaceId !== channel.spaceId || identity.bot?.name !== "Comet" ||
        !conversation?.allowSend || capability.taskRequired !== false ||
        !requiredScopes.every((scope) => identity.scopes?.includes(scope)) ||
        (type === "direct" ? conversation.isOwnerDirect !== true : conversation.allowTrigger !== true)) {
      throw releaseAgentError("release_agent.conversation_denied");
    }
    return capability;
  }

  async function sendMessage(conversationId, text, key, replyToMessageId) {
    const result = await client.sendMessage({ conversationId, text, replyToMessageId,
      clientMessageId: key, idempotencyKey: key, signal: AbortSignal.timeout(15_000) });
    const messageId = result?.message?.id;
    if (!identifier(messageId)) throw releaseAgentError("release_agent.message_receipt", { retryable: true });
    return { messageId };
  }

  return {
    async check() {
      const group = await authorize(channel.groupConversationId, "group", ["messages:read_trigger", "messages:send"]);
      if (group.features?.taskAuthorization !== true) throw releaseAgentError("release_agent.task_scope_unavailable");
      await authorize(channel.ownerConversationId, "direct", ["messages:send", "cards:write", "cards:act"]);
    },
    async authorizeOwner() {
      await authorize(channel.ownerConversationId, "direct", ["messages:send", "cards:act"]);
    },
    async sendGroup(ticket, text, key) {
      const source = ticket.source;
      if (source.spaceId !== channel.spaceId || source.conversationId !== channel.groupConversationId) throw releaseAgentError("release_agent.source_denied");
      await authorize(source.conversationId, "group");
      return sendMessage(source.conversationId, text, key, source.messageId);
    },
    async sendApproval(ticket, key) {
      if (ticket.approval.ownerUserId !== channel.ownerUserId || ticket.approval.conversationId !== channel.ownerConversationId) {
        throw releaseAgentError("release_agent.approval_destination");
      }
      await authorize(channel.ownerConversationId, "direct", ["messages:send", "cards:write"]);
      const result = await client.sendFeishuCard({ conversationId: channel.ownerConversationId, ...approvalCard(ticket),
        clientMessageId: key, idempotencyKey: key, signal: AbortSignal.timeout(15_000) });
      if (!identifier(result?.card?.id) || !identifier(result?.message?.id)) {
        throw releaseAgentError("release_agent.card_receipt", { retryable: true });
      }
      return { cardId: result.card.id, messageId: result.message.id };
    },
    async notifyOwner(text, key) {
      if (!safeText(text, 1600) || !identifier(key)) throw releaseAgentError("release_agent.notification_input");
      await authorize(channel.ownerConversationId, "direct");
      return sendMessage(channel.ownerConversationId, text, key);
    },
  };
}

// The running turn owns the broker key. Capture at most the explicitly cited
// message while the scoped grant is live. Workers receive no live chat tools.
export async function readCitedMessage(request, messageId) {
  if (!request.toolSession || !identifier(messageId)) return null;
  try {
    const tool = createTaskBrokerMcpAdapter();
    const output = await tool.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "duallane_get_message", arguments: { messageId } } });
    const value = output?.result?.structuredContent ?? JSON.parse(output?.result?.content?.[0]?.text || "null");
    const message = value?.message;
    if (message?.id !== messageId || message.conversationId !== request.conversation.id || message.authorKind !== "human") return null;
    return safeText(message.plainText, 2000) || null;
  } catch {
    return null;
  }
}
