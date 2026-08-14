import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot as BotIcon,
  Check,
  Clipboard,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Wifi,
  X
} from "lucide-react";
import { createWorkspaceJsonHeaders } from "./workspace-http";

export type WorkspaceBotNoticeTone = "success" | "warning" | "info";

export type WorkspaceBotSettingsProps = {
  onBack: () => void;
  onNotice: (tone: WorkspaceBotNoticeTone, text: string) => void;
  botId?: string;
  fetchImpl?: typeof fetch;
};

export type BotGroupPolicyMode = "direct_only" | "allow_group" | "approval_required";

export const BOT_GROUP_POLICY_OPTIONS: ReadonlyArray<{
  value: BotGroupPolicyMode;
  label: string;
  description: string;
}> = [
  { value: "direct_only", label: "仅私聊", description: "Bot 只响应与所有者的私聊。" },
  { value: "allow_group", label: "允许群聊", description: "群成员可在群聊中触发 Bot。" },
  { value: "approval_required", label: "群聊需审批", description: "群聊接入前需要所有者确认。" }
];

type WorkspaceBot = {
  id: string;
  name: string;
  mode?: string;
  status: "active" | "paused" | "deleting" | "deleted" | string;
  visibilityPolicy?: string;
  conversationPolicy?: string;
  createdAt?: string;
  updatedAt?: string;
  canJoinGroups?: boolean;
};

type BotSettings = {
  botId: string;
  spaceId?: string;
  visibilityPolicy: "private" | "specified_members" | "space_members" | "groups" | string;
  allowDirect: boolean;
  allowGroup: boolean;
  groupInviterPolicy?: "owner" | "group_admin" | "any_member" | string;
  requireOwnerApproval: boolean;
  proactiveEnabled: boolean;
  triggerPolicy?: string;
  welcomeMessage?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  showCreator: boolean;
  allowedMemberIds: string[];
  context?: {
    maxMessages?: number;
    maxChars?: number;
    maxTokens?: number;
    windowSeconds?: number;
    includeReplies?: boolean;
    includeSystemEvents?: boolean;
    includeAttachmentMetadata?: boolean;
    allowAttachmentPreview?: boolean;
    longTermSummaryEnabled?: boolean;
  };
  limits?: BotLimits | null;
  updatedAt?: string;
};

type BotLimits = {
  requestsPerMinute?: number;
  memberDailyRequests?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  maxConcurrency?: number;
  eventBacklogLimit?: number;
};

type BotToken = {
  id: string;
  botId: string;
  scopes: string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
  token?: string;
};

type BotConnection = {
  id?: string;
  botId?: string;
  status?: "disconnected" | "connected" | "paused" | "revoked" | string;
  adapterVersion?: string | null;
  connectedAt?: string | null;
  disconnectedAt?: string | null;
  lastHeartbeatAt?: string | null;
  lastProcessedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  updatedAt?: string;
};

type BotGroupPolicy = {
  conversationId: string;
  status?: "pending" | "active" | "rejected" | "removed" | string;
  invitedBy?: string | null;
  approvedBy?: string | null;
  maxContextMessages?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

const DEFAULT_TOKEN_SCOPES = ["messages:read_trigger", "messages:send", "commands:receive"];

export function resolveBotGroupPolicyMode(settings: Pick<BotSettings, "allowGroup" | "requireOwnerApproval">): BotGroupPolicyMode {
  if (!settings.allowGroup) return "direct_only";
  return settings.requireOwnerApproval ? "approval_required" : "allow_group";
}

export function buildBotGroupPolicyPatch(mode: BotGroupPolicyMode): Pick<BotSettings, "allowGroup" | "requireOwnerApproval"> {
  if (mode === "direct_only") return { allowGroup: false, requireOwnerApproval: true };
  if (mode === "approval_required") return { allowGroup: true, requireOwnerApproval: true };
  return { allowGroup: true, requireOwnerApproval: false };
}

export function parseBotMemberIds(value: string): string[] {
  return [...new Set(value.split(/[\s,，、]+/u).map((item) => item.trim()).filter(Boolean))];
}

function formatDate(value?: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : date.toLocaleString();
}

function formatLimit(value?: number | null, suffix = "") {
  return Number.isFinite(value) ? `${value}${suffix}` : "未设置";
}

function statusLabel(status?: string) {
  switch (status) {
    case "active": return "运行中";
    case "paused": return "已暂停";
    case "deleting": return "待停用确认";
    case "deleted": return "已停用";
    case "connected": return "已连接";
    case "disconnected": return "未连接";
    case "revoked": return "已撤销";
    default: return status || "未知";
  }
}

function visibilityLabel(value?: string) {
  switch (value) {
    case "private": return "仅自己可发现";
    case "specified_members": return "指定成员";
    case "space_members": return "空间成员";
    case "groups": return "已授权群聊";
    default: return value || "未设置";
  }
}

class WorkspaceBotHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkspaceBotHttpError";
    this.status = status;
  }
}

async function requestJson<T>(fetchImpl: typeof fetch, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetchImpl(path, {
    ...options,
    credentials: "same-origin",
    headers: createWorkspaceJsonHeaders(options)
  });
  if (!response.ok) {
    let message = "请求失败";
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (typeof payload.error?.message === "string" && payload.error.message.trim()) message = payload.error.message;
    } catch {
      // Keep the user-facing fallback when the response is not JSON.
    }
    throw new WorkspaceBotHttpError(message, response.status);
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

function operationError(error: unknown, fallback: string) {
  if (error instanceof WorkspaceBotHttpError && error.message && error.message !== "请求失败") return error.message;
  return fallback;
}

export function WorkspaceBotSettings({ onBack, onNotice, botId: requestedBotId, fetchImpl = fetch }: WorkspaceBotSettingsProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bot, setBot] = useState<WorkspaceBot | null>(null);
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [tokens, setTokens] = useState<BotToken[]>([]);
  const [connection, setConnection] = useState<BotConnection | null>(null);
  const [groupPolicies, setGroupPolicies] = useState<BotGroupPolicy[]>([]);
  const [botName, setBotName] = useState("");
  const [description, setDescription] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [showCreator, setShowCreator] = useState(false);
  const [visibilityPolicy, setVisibilityPolicy] = useState<BotSettings["visibilityPolicy"]>("private");
  const [memberIds, setMemberIds] = useState("");
  const [groupPolicyMode, setGroupPolicyMode] = useState<BotGroupPolicyMode>("direct_only");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingGroupPolicy, setSavingGroupPolicy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const loadBot = useCallback(async (preferredBotId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await requestJson<{ bots?: WorkspaceBot[] }>(fetchImpl, "/api/workspace/bots");
      const bots = Array.isArray(list.bots) ? list.bots : [];
      let nextBot = preferredBotId ? bots.find((candidate) => candidate.id === preferredBotId) : bots[0];
      if (!nextBot && preferredBotId) {
        const detail = await requestJson<{ bot: WorkspaceBot }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(preferredBotId)}`);
        nextBot = detail.bot;
      }
      if (!nextBot) {
        setBot(null);
        setSettings(null);
        setTokens([]);
        setConnection(null);
        setGroupPolicies([]);
        return;
      }

      const id = encodeURIComponent(nextBot.id);
      const [settingsResult, tokensResult, connectionResult, groupsResult] = await Promise.all([
        requestJson<{ settings: BotSettings }>(fetchImpl, `/api/workspace/bots/${id}/settings`),
        requestJson<{ tokens: BotToken[] }>(fetchImpl, `/api/workspace/bots/${id}/tokens`),
        requestJson<{ connection: BotConnection | null }>(fetchImpl, `/api/workspace/bots/${id}/connection`),
        requestJson<{ policies: BotGroupPolicy[] }>(fetchImpl, `/api/workspace/bots/${id}/group-policies`)
      ]);
      const nextSettings = settingsResult.settings;
      setBot(nextBot);
      setBotName(nextBot.name);
      setSettings(nextSettings);
      setDescription(nextSettings.description ?? "");
      setWelcomeMessage(nextSettings.welcomeMessage ?? "");
      setShowCreator(Boolean(nextSettings.showCreator));
      setVisibilityPolicy(nextSettings.visibilityPolicy);
      setMemberIds(nextSettings.allowedMemberIds.join("\n"));
      setGroupPolicyMode(resolveBotGroupPolicyMode(nextSettings));
      setTokens(Array.isArray(tokensResult.tokens) ? tokensResult.tokens : []);
      setConnection(connectionResult.connection ?? null);
      setGroupPolicies(Array.isArray(groupsResult.policies) ? groupsResult.policies : []);
      setRevealedToken(null);
    } catch (loadError) {
      setError(operationError(loadError, "Bot 设置暂时无法加载"));
    } finally {
      setLoading(false);
    }
  }, [fetchImpl]);

  useEffect(() => {
    void loadBot(requestedBotId);
  }, [loadBot, requestedBotId]);

  const visibleGroupPolicyCount = useMemo(
    () => groupPolicies.filter((policy) => policy.status === "active").length,
    [groupPolicies]
  );

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    if (!name) {
      onNotice("warning", "请输入 Bot 名称");
      return;
    }
    setCreateBusy(true);
    try {
      const result = await requestJson<{ bot: WorkspaceBot }>(fetchImpl, "/api/workspace/bots", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setCreateName("");
      onNotice("success", "Bot 已创建");
      await loadBot(result.bot.id);
    } catch (createError) {
      onNotice("warning", operationError(createError, "Bot 创建失败"));
    } finally {
      setCreateBusy(false);
    }
  }

  async function saveIdentityAndDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bot || !settings) return;
    setSavingSettings(true);
    try {
      const next = await requestJson<{ settings: BotSettings }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          description: description.trim() || null,
          welcomeMessage: welcomeMessage.trim() || null,
          showCreator,
          visibilityPolicy,
          allowedMemberIds: parseBotMemberIds(memberIds)
        })
      });
      setSettings(next.settings);
      setVisibilityPolicy(next.settings.visibilityPolicy);
      setMemberIds(next.settings.allowedMemberIds.join("\n"));
      onNotice("success", "Bot 身份与发现设置已保存");
    } catch (saveError) {
      onNotice("warning", operationError(saveError, "Bot 设置保存失败"));
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveGroupPolicy() {
    if (!bot || !settings) return;
    setSavingGroupPolicy(true);
    try {
      const patch = buildBotGroupPolicyPatch(groupPolicyMode);
      const next = await requestJson<{ settings: BotSettings }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/settings`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setSettings(next.settings);
      setGroupPolicyMode(resolveBotGroupPolicyMode(next.settings));
      onNotice("success", "群聊策略已保存");
    } catch (saveError) {
      onNotice("warning", operationError(saveError, "群聊策略保存失败"));
    } finally {
      setSavingGroupPolicy(false);
    }
  }

  async function testConnection() {
    if (!bot) return;
    setConnectionBusy(true);
    try {
      const result = await requestJson<{ connection: BotConnection }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/connection/test`, { method: "POST" });
      setConnection(result.connection);
      onNotice("success", "连接状态已刷新");
    } catch (connectionError) {
      onNotice("warning", operationError(connectionError, "连接状态刷新失败"));
    } finally {
      setConnectionBusy(false);
    }
  }

  async function issueToken(rotate: boolean) {
    if (!bot || bot.status !== "active") return;
    setTokenBusy(true);
    try {
      const endpoint = rotate
        ? `/api/workspace/bots/${encodeURIComponent(bot.id)}/tokens/rotate`
        : `/api/workspace/bots/${encodeURIComponent(bot.id)}/tokens`;
      const result = await requestJson<{ token: string; tokenRecord: BotToken }>(fetchImpl, endpoint, {
        method: "POST",
        body: JSON.stringify({ scopes: DEFAULT_TOKEN_SCOPES })
      });
      setRevealedToken(result.token);
      setTokens((previous) => [result.tokenRecord, ...previous.filter((token) => token.id !== result.tokenRecord.id)]);
      onNotice("success", rotate ? "Token 已轮换，请立即保存新 Token" : "Token 已生成，请立即保存");
    } catch (tokenError) {
      onNotice("warning", operationError(tokenError, rotate ? "Token 轮换失败" : "Token 生成失败"));
    } finally {
      setTokenBusy(false);
    }
  }

  async function revokeToken(tokenId: string) {
    if (!bot) return;
    setTokenBusy(true);
    try {
      const result = await requestJson<{ token: BotToken }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/tokens/${encodeURIComponent(tokenId)}/revoke`, { method: "POST" });
      setTokens((previous) => previous.map((token) => token.id === tokenId ? result.token : token));
      setRevealedToken(null);
      onNotice("success", "Token 已撤销");
    } catch (tokenError) {
      onNotice("warning", operationError(tokenError, "Token 撤销失败"));
    } finally {
      setTokenBusy(false);
    }
  }

  async function changeLifecycle(action: "pause" | "resume") {
    if (!bot) return;
    try {
      const result = await requestJson<{ bot: WorkspaceBot }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/${action}`, { method: "POST" });
      setBot(result.bot);
      onNotice("success", action === "pause" ? "Bot 已暂停" : "Bot 已恢复");
    } catch (lifecycleError) {
      onNotice("warning", operationError(lifecycleError, action === "pause" ? "Bot 暂停失败" : "Bot 恢复失败"));
    }
  }

  async function requestDisable() {
    if (!bot) return;
    setDeleteBusy(true);
    try {
      const result = await requestJson<{ bot: WorkspaceBot }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}`, { method: "DELETE" });
      setBot(result.bot);
      setDeleteConfirm(true);
      onNotice("info", "Bot 已进入待停用状态，请确认完成停用");
    } catch (deleteError) {
      onNotice("warning", operationError(deleteError, "Bot 停用请求失败"));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function confirmDisable() {
    if (!bot) return;
    setDeleteBusy(true);
    try {
      const result = await requestJson<{ bot: WorkspaceBot }>(fetchImpl, `/api/workspace/bots/${encodeURIComponent(bot.id)}/delete/confirm`, { method: "POST" });
      setBot(result.bot);
      setDeleteConfirm(false);
      setTokens([]);
      setRevealedToken(null);
      onNotice("success", "Bot 已停用");
    } catch (deleteError) {
      onNotice("warning", operationError(deleteError, "Bot 停用确认失败"));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function copyToken() {
    if (!revealedToken || !navigator.clipboard) {
      onNotice("warning", "当前浏览器不支持复制，请手动保存");
      return;
    }
    try {
      await navigator.clipboard.writeText(revealedToken);
      onNotice("success", "Token 已复制");
    } catch {
      onNotice("warning", "Token 复制失败，请手动保存");
    }
  }

  if (loading) {
    return (
      <section className="workspace-bot-settings workspace-content-panel" aria-busy="true">
        <header className="workspace-bot-header">
          <button className="icon-button" type="button" aria-label="返回个人设置" title="返回" onClick={onBack}><ArrowLeft size={17} /></button>
          <div><p className="eyebrow">个人 · Bot</p><h2>我的 Bot</h2></div>
        </header>
        <div className="workspace-bot-state workspace-bot-loading" role="status"><RefreshCw size={18} className="workspace-bot-spin" />读取 Bot 设置...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="workspace-bot-settings workspace-content-panel" aria-live="polite">
        <header className="workspace-bot-header">
          <button className="icon-button" type="button" aria-label="返回个人设置" title="返回" onClick={onBack}><ArrowLeft size={17} /></button>
          <div><p className="eyebrow">个人 · Bot</p><h2>我的 Bot</h2></div>
        </header>
        <div className="workspace-bot-state workspace-bot-error" role="alert"><AlertTriangle size={20} /><p>{error}</p><button className="secondary" type="button" onClick={() => void loadBot(requestedBotId)}><RefreshCw size={16} />重试</button></div>
      </section>
    );
  }

  if (!bot) {
    return (
      <section className="workspace-bot-settings workspace-content-panel">
        <header className="workspace-bot-header">
          <button className="icon-button" type="button" aria-label="返回个人设置" title="返回" onClick={onBack}><ArrowLeft size={17} /></button>
          <div><p className="eyebrow">个人 · Bot</p><h2>我的 Bot</h2></div>
        </header>
        <div className="workspace-bot-empty" role="status">
          <BotIcon size={30} aria-hidden="true" />
          <h3>创建你的 Bot</h3>
          <p>自定义 Bot 只在你授权的空间范围内工作，连接凭据不会显示在日志中。</p>
          <form className="workspace-bot-create-form" onSubmit={createBot}>
            <label><span>Bot 名称</span><input value={createName} maxLength={64} onChange={(event) => setCreateName(event.target.value)} placeholder="例如：项目助手" autoComplete="off" /></label>
            <button className="primary" type="submit" disabled={createBusy}>{createBusy ? <RefreshCw size={16} className="workspace-bot-spin" /> : <BotIcon size={16} />}创建 Bot</button>
          </form>
        </div>
      </section>
    );
  }

  const isActive = bot.status === "active";
  const isPaused = bot.status === "paused";
  const isDeleting = bot.status === "deleting";
  const isDeleted = bot.status === "deleted";

  return (
    <section className="workspace-bot-settings workspace-content-panel" aria-busy={savingSettings || savingGroupPolicy || tokenBusy || connectionBusy || deleteBusy}>
      <header className="workspace-bot-header">
        <button className="icon-button" type="button" aria-label="返回个人设置" title="返回" onClick={onBack}><ArrowLeft size={17} /></button>
        <div className="workspace-bot-title"><p className="eyebrow">个人 · Bot</p><h2>{bot.name}</h2><span className={`workspace-bot-status workspace-bot-status-${bot.status}`}><span aria-hidden="true" />{statusLabel(bot.status)}</span></div>
        <div className="workspace-bot-header-actions">
          {isActive && <button className="secondary compact" type="button" disabled={deleteBusy} onClick={() => void changeLifecycle("pause")}><Pause size={15} />暂停</button>}
          {isPaused && <button className="secondary compact" type="button" disabled={deleteBusy} onClick={() => void changeLifecycle("resume")}><Play size={15} />恢复</button>}
        </div>
      </header>

      {isDeleting && <div className="workspace-bot-confirm workspace-bot-confirm-danger" role="alert"><AlertTriangle size={18} /><div><strong>Bot 即将停用</strong><p>停用会撤销所有 Token 并移除 Bot 的空间成员身份。</p></div>{deleteConfirm ? <><button className="secondary compact" type="button" disabled={deleteBusy} onClick={() => setDeleteConfirm(false)}><X size={15} />取消</button><button className="danger compact" type="button" disabled={deleteBusy} onClick={() => void confirmDisable()}><Check size={15} />确认停用</button></> : <button className="danger compact" type="button" disabled={deleteBusy} onClick={() => setDeleteConfirm(true)}>继续停用</button>}</div>}
      {isDeleted && <div className="workspace-bot-confirm workspace-bot-confirm-muted" role="status"><ShieldCheck size={18} /><span>此 Bot 已停用，设置与凭据均不可再使用。</span></div>}

      {!isDeleted && settings && (
        <div className="workspace-bot-sections">
          <section className="workspace-bot-section" aria-labelledby="workspace-bot-identity-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-identity-title">身份与发现</h3><p>控制 Bot 的公开资料、触发入口和可见范围。</p></div>
            <form className="workspace-bot-form" onSubmit={saveIdentityAndDiscovery}>
              <div className="workspace-bot-form-grid">
                <div className="workspace-bot-readonly"><span>Bot 名称</span><strong>{botName}</strong></div>
                <div className="workspace-bot-readonly"><span>Bot ID</span><code>{bot.id}</code></div>
              </div>
              <label><span>简介</span><textarea value={description} maxLength={4000} rows={3} disabled={!isActive && !isPaused} onChange={(event) => setDescription(event.target.value)} placeholder="告诉成员这个 Bot 负责什么" /></label>
              <label><span>欢迎语</span><textarea value={welcomeMessage} maxLength={4000} rows={2} disabled={!isActive && !isPaused} onChange={(event) => setWelcomeMessage(event.target.value)} placeholder="可选，在 Bot 首次响应时显示" /></label>
              <label className="workspace-bot-select-field"><span>成员发现</span><select value={visibilityPolicy} disabled={!isActive && !isPaused} onChange={(event) => setVisibilityPolicy(event.target.value as BotSettings["visibilityPolicy"])}><option value="private">仅自己可发现</option><option value="specified_members">指定成员</option><option value="space_members">空间成员</option><option value="groups">已授权群聊</option></select><small>{visibilityLabel(visibilityPolicy)}</small></label>
              {visibilityPolicy === "specified_members" && <label><span>指定成员 ID</span><textarea value={memberIds} maxLength={4000} rows={2} disabled={!isActive && !isPaused} onChange={(event) => setMemberIds(event.target.value)} placeholder="每行一个成员 ID" /><small>仅保存成员 ID，不会读取或显示成员消息。</small></label>}
              <label className="workspace-bot-switch"><input type="checkbox" checked={showCreator} disabled={!isActive && !isPaused} onChange={(event) => setShowCreator(event.target.checked)} /><span><strong>显示创建者</strong><small>在 Bot 资料中显示你的空间身份。</small></span></label>
              <div className="workspace-bot-form-actions"><button className="primary" type="submit" disabled={savingSettings || (!isActive && !isPaused)}>{savingSettings ? <RefreshCw size={16} className="workspace-bot-spin" /> : <Check size={16} />}保存身份设置</button></div>
            </form>
          </section>

          <section className="workspace-bot-section" aria-labelledby="workspace-bot-group-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-group-title">群聊策略</h3><p>私聊始终受发现范围控制；群聊需要单独开启。</p></div>
            <fieldset className="workspace-bot-policy-options" disabled={!isActive && !isPaused}>
              <legend className="sr-only">群聊策略</legend>
              {BOT_GROUP_POLICY_OPTIONS.map((option) => <label key={option.value} className={groupPolicyMode === option.value ? "workspace-bot-policy-option is-selected" : "workspace-bot-policy-option"}><input type="radio" name="workspace-bot-group-policy" value={option.value} checked={groupPolicyMode === option.value} onChange={() => setGroupPolicyMode(option.value)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
            </fieldset>
            <div className="workspace-bot-policy-meta"><span>已授权群聊</span><strong>{visibleGroupPolicyCount} 个</strong><span>邀请策略</span><strong>{settings.groupInviterPolicy === "group_admin" ? "群管理员" : settings.groupInviterPolicy === "any_member" ? "任意成员" : "Bot 所有者"}</strong></div>
            <div className="workspace-bot-form-actions"><button className="primary" type="button" disabled={savingGroupPolicy || (!isActive && !isPaused)} onClick={() => void saveGroupPolicy()}>{savingGroupPolicy ? <RefreshCw size={16} className="workspace-bot-spin" /> : <ShieldCheck size={16} />}保存群聊策略</button></div>
          </section>

          <section className="workspace-bot-section" aria-labelledby="workspace-bot-quota-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-quota-title">限额</h3><p>这些额度由空间策略控制，超过限额的请求会在执行前被拒绝。</p></div>
            <div className="workspace-bot-quota-grid"><div><span>每分钟请求</span><strong>{formatLimit(settings.limits?.requestsPerMinute)}</strong></div><div><span>成员每日请求</span><strong>{formatLimit(settings.limits?.memberDailyRequests)}</strong></div><div><span>输入 Token</span><strong>{formatLimit(settings.limits?.inputTokenLimit)}</strong></div><div><span>输出 Token</span><strong>{formatLimit(settings.limits?.outputTokenLimit)}</strong></div><div><span>最大并发</span><strong>{formatLimit(settings.limits?.maxConcurrency)}</strong></div><div><span>事件积压</span><strong>{formatLimit(settings.limits?.eventBacklogLimit)}</strong></div></div>
          </section>

          <section className="workspace-bot-section" aria-labelledby="workspace-bot-connection-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-connection-title">连接状态</h3><p>连接器只接收经过授权的事件，不会把 Token 写入页面日志。</p></div>
            <div className="workspace-bot-connection-card"><div className="workspace-bot-connection-status"><Wifi size={19} /><strong>{statusLabel(connection?.status)}</strong><span>{connection?.adapterVersion ? `适配器 ${connection.adapterVersion}` : "尚未报告适配器"}</span></div><dl><div><dt>最近心跳</dt><dd>{formatDate(connection?.lastHeartbeatAt)}</dd></div><div><dt>最近处理</dt><dd>{formatDate(connection?.lastProcessedAt)}</dd></div><div><dt>最近错误</dt><dd>{connection?.lastErrorCode || "无"}</dd></div></dl></div>
            <div className="workspace-bot-form-actions"><button className="secondary" type="button" disabled={connectionBusy || isDeleted} onClick={() => void testConnection()}>{connectionBusy ? <RefreshCw size={16} className="workspace-bot-spin" /> : <RefreshCw size={16} />}刷新连接状态</button></div>
          </section>

          <section className="workspace-bot-section" aria-labelledby="workspace-bot-token-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-token-title">访问 Token</h3><p>Token 只在生成或轮换时展示一次；服务器只保存不可逆摘要。</p></div>
            {revealedToken && <div className="workspace-bot-token-reveal" role="alert"><KeyRound size={18} /><div><strong>请立即保存这个 Token</strong><code>{revealedToken}</code><small>离开此页后不会再次显示完整值。</small></div><button className="icon-button" type="button" title="复制 Token" aria-label="复制 Token" onClick={() => void copyToken()}><Clipboard size={16} /></button><button className="icon-button" type="button" title="关闭 Token" aria-label="关闭 Token 提示" onClick={() => setRevealedToken(null)}><X size={16} /></button></div>}
            <div className="workspace-bot-token-actions"><button className="primary" type="button" disabled={tokenBusy || !isActive} onClick={() => void issueToken(false)}><KeyRound size={16} />生成 Token</button><button className="secondary" type="button" disabled={tokenBusy || !isActive} onClick={() => void issueToken(true)}><RotateCcw size={16} />轮换 Token</button></div>
            <div className="workspace-bot-token-list">{tokens.length === 0 ? <p className="workspace-bot-muted">尚未生成 Token。</p> : tokens.map((token) => <div className="workspace-bot-token-row" key={token.id}><div><code>{token.token || "dl_bot_••••••••"}</code><small>{token.revokedAt ? "已撤销" : `创建于 ${formatDate(token.createdAt)}`} · {token.scopes.join(", ")}</small></div><div><span>{token.lastUsedAt ? `上次使用 ${formatDate(token.lastUsedAt)}` : "尚未使用"}</span>{!token.revokedAt && <button className="icon-button danger-action" type="button" disabled={tokenBusy || !isActive} title="撤销 Token" aria-label="撤销 Token" onClick={() => void revokeToken(token.id)}><Trash2 size={16} /></button>}</div></div>)}</div>
          </section>

          <section className="workspace-bot-section workspace-bot-danger-section" aria-labelledby="workspace-bot-danger-title">
            <div className="workspace-bot-section-intro"><h3 id="workspace-bot-danger-title">停用 Bot</h3><p>停用会撤销所有 Token，并移除 Bot 的空间成员身份。此操作不可恢复。</p></div>
            <button className="danger" type="button" disabled={deleteBusy || isDeleting || !isActive && !isPaused} onClick={() => void requestDisable()}><Trash2 size={16} />停用 Bot</button>
          </section>
        </div>
      )}
    </section>
  );
}

export default WorkspaceBotSettings;
