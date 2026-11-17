import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpCircle,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Link2,
  Lock,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Puzzle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlink,
  Users,
  X,
} from "lucide-react";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  apiV1,
  type BotCommandSpec,
  type BotConnectionInfo,
  type BotConversationOverviewItem,
  type BotDeliveryDiagnosticItem,
  type BotGroupPolicy,
  type BotSetupSession,
  type BotTokenRecord,
} from "@/shared/lib/api-v1";
import {
  Avatar,
  BOT_AVATAR_COLORS,
  Button,
  IconButton,
  Input,
  Select,
  Switch,
  type BotAvatarColor,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import {
  buildBotAccessPolicyPatch,
  cloneBotAccessPolicy,
  describeBotAccessPolicy,
  isSelectableBotSourceMember,
  makePrivateAssistantGroupPolicy,
  parseBotAccessPolicy,
  toggleStringId,
  type BotAccessPolicy,
  type BotGroupAudience,
  type BotPolicyAudience,
} from "./bot-access-policy";

type BotChapterId = "runtime" | "permissions" | "persona" | "extensions";
type GroupAccessPreset = "disabled" | "owner_only" | "approval_required" | "open";

interface BotItem {
  id: string;
  botUserId?: string;
  name: string;
  status: string;
  visibilityPolicy?: string;
  triggerPolicy?: string;
  description?: string;
  avatarUrl?: string;
  avatarColor?: string;
}

interface BotSettingsData {
  accessPolicy: BotAccessPolicy | null;
  visibilityPolicy: "private" | "specified_members" | "space_members" | string;
  allowDirect: boolean;
  allowGroup: boolean;
  groupInviterPolicy: "owner" | "group_admin" | "any_member" | string;
  requireOwnerApproval: boolean;
  proactiveEnabled: boolean;
  triggerPolicy: string;
  allowedMemberIds: string[];
  description: string;
  welcomeMessage: string;
  avatarUrl: string;
  maxContextMessages: number;
  maxContextChars: number;
  maxContextTokens: number;
  contextWindowSeconds: number;
  includeReplies: boolean;
  includeSystemEvents: boolean;
  includeAttachmentMetadata: boolean;
  allowAttachmentPreview: boolean;
}

const VALID_SCOPES = [
  { id: "messages:read_trigger", label: "读取触发消息" },
  { id: "messages:read_context", label: "读取对话上下文" },
  { id: "messages:send", label: "发送回复消息" },
  { id: "cards:write", label: "发送与更新卡片" },
  { id: "cards:act", label: "接收卡片交互" },
  { id: "commands:receive", label: "接收 Slash 指令" },
  { id: "files:read_metadata", label: "读取附件元数据" },
  { id: "files:read_preview", label: "读取附件预览（受限）" },
  { id: "files:read_content", label: "读取附件完整内容（敏感）" },
  { id: "files:write", label: "上传生成文件" },
];

const DEFAULT_PAIRING_SCOPES = VALID_SCOPES
  .filter((item) => item.id !== "files:read_preview" && item.id !== "files:read_content")
  .map((item) => item.id);

const SCOPE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  VALID_SCOPES.map((item) => [item.id, item.label])
);

const CHAPTER_TABS: ReadonlyArray<{
  id: BotChapterId;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}> = [
  { id: "runtime", label: "连接与运行", icon: Activity },
  { id: "permissions", label: "权限与会话", icon: Users },
  { id: "persona", label: "资料与上下文", icon: Sparkles },
  { id: "extensions", label: "扩展与安全", icon: Puzzle },
];

function normalizeMemberVisibility(raw?: string): "private" | "specified_members" | "space_members" {
  if (raw === "space_members") return "space_members";
  if (raw === "specified_members") return "specified_members";
  return "private";
}

function resolveGroupAccessPreset(settings: Pick<BotSettingsData, "allowGroup" | "groupInviterPolicy" | "requireOwnerApproval">): GroupAccessPreset {
  if (!settings.allowGroup) return "disabled";
  if (settings.groupInviterPolicy === "owner") return "owner_only";
  if (settings.requireOwnerApproval) return "approval_required";
  return "open";
}

function buildGroupAccessPatch(preset: GroupAccessPreset): Record<string, unknown> {
  switch (preset) {
    case "disabled":
      return { allowGroup: false, groupInviterPolicy: "owner", requireOwnerApproval: true };
    case "owner_only":
      return { allowGroup: true, groupInviterPolicy: "owner", requireOwnerApproval: true };
    case "approval_required":
      return { allowGroup: true, groupInviterPolicy: "any_member", requireOwnerApproval: true };
    case "open":
      return { allowGroup: true, groupInviterPolicy: "any_member", requireOwnerApproval: false };
  }
}

function extractSemverFromAdapter(adapterVersion?: string | null): string {
  if (!adapterVersion) return "";
  const match = /(\d+\.\d+\.\d+)/u.exec(adapterVersion);
  return match ? match[1] : "";
}

function isSemverOlder(currentVer: string, latestVer: string): boolean {
  if (!currentVer || !latestVer) return false;
  const pa = currentVer.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = latestVer.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function formatBlockReason(reason?: string): string {
  switch (reason) {
    case "bot_paused":
      return "机器人已暂停";
    case "direct_disabled":
      return "成员私聊已关闭";
    case "peer_not_in_visibility":
      return "不在可用成员范围";
    case "trigger_grant_off":
      return "会话触发已关闭";
    case "group_disabled":
      return "未开启群聊准入";
    case "group_pending_approval":
      return "等待群管理员批准";
    case "group_not_authorized":
      return "群聊尚未授权";
    default:
      return "策略限制";
  }
}

function formatDeliveryStatus(status: string): { label: string; toneClass: string } {
  switch (status) {
    case "acked":
      return { label: "已处理", toneClass: "bg-dl-success/14 text-dl-success" };
    case "delivered":
      return { label: "投递中", toneClass: "bg-dl-lane-shared/14 text-dl-lane-shared" };
    case "queued":
      return { label: "排队中", toneClass: "bg-dl-warning/15 text-dl-warning" };
    case "expired":
      return { label: "已过期", toneClass: "bg-dl-surface-subtle text-dl-text-tertiary" };
    default:
      return { label: status, toneClass: "bg-dl-surface-subtle text-dl-text-secondary" };
  }
}

export function buildPairingPrompt(botName: string, origin: string, sessionId: string): string {
  const skillUrl = `${origin}/integrations/duallane-agent/SKILL.md`;
  const manifestUrl = `${origin}/integrations/duallane-agent.manifest.json`;
  const setupUrl = `${origin}/workspace?setup=${encodeURIComponent(sessionId)}`;
  return [
    `请接入我的 DualLane 机器人「${botName}」：`,
    `1. 安装并加载接入 Skill：${skillUrl}；宿主不支持 Skill 时，读取其中引用的契约与工具 Schema。`,
    `2. 官方运行包清单：${manifestUrl}。平台最低要求兼容的 SDK 1.2.1；按契约核验版本、摘要和桥接能力。`,
    `3. 如果已有配对，请复用已有 profile、凭证与可信桥接，使用官方 update 更新；不要覆盖自定义文件、重复配对或启动第二个消费者。`,
    `4. 仅新接入使用一次性配对地址：${setupUrl}。先说明所需会话和权限，再提醒我在网页确认授权；不要索要、回显或把 Token 放进提示词。`,
    `5. 依据宿主能力明确选择可信桥接命令，以 daemon install --profile <已有或新建的名称> --cmd <可信桥接命令> 安装。群任务仅获得任务限定工具，实际模型、搜索、生图、记忆与执行隔离由桥接提供。`,
    `完成后验证单一消费者、真实消息与附件收发，并报告当前权限、工具能力与尚不支持的能力。`,
  ].join("\n");
}

function buildStandardMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        duallane: {
          command: "node",
          args: ["~/.duallane/bin/duallane-agent.mjs", "mcp", "--profile", "default"],
        },
      },
    },
    null,
    2
  );
}

function buildPreviewSetupSession(
  id: string,
  status: BotSetupSession["status"],
  bot: BotSetupSession["bot"] = {
    id: "bot_echo_1",
    botUserId: "usr_bot_echo_1",
    name: "通用协作助手",
  }
): BotSetupSession {
  return {
    id,
    bot,
    status,
    requestedScopes: DEFAULT_PAIRING_SCOPES,
    approvedScopes: [],
    requestedConversations: [],
    approvedConversations: [],
    clientName: status === "awaiting_user" ? "duallane-mcp/1.0.14" : undefined,
    expiresAt: "2099-01-01T00:10:00.000Z",
    createdAt: "2099-01-01T00:00:00.000Z",
  };
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const container =
      (typeof document !== "undefined" &&
        (document.querySelector('[role="dialog"]') as HTMLElement | null)) ||
      document.body;
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    container.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    container.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function BotSettingsPanel() {
  const {
    isPreviewMode,
    members,
    conversations,
    bootstrapWorkspace,
    selectConversation,
    patchMemberLocal,
  } = useWorkspaceStore();
  const { pendingBotSetupId, setPendingBotSetupId, closeSettings } = useLaneStore();

  const [activeChapter, setActiveChapter] = useState<BotChapterId>("runtime");
  const [bots, setBots] = useState<BotItem[]>(() =>
    isPreviewMode
      ? [
          {
            id: "bot_echo_1",
            botUserId: "usr_bot_echo_1",
            name: "通用协作助手",
            status: "active",
            visibilityPolicy: "space_members",
            triggerPolicy: "mention-or-command",
          },
          {
            id: "bot_release_2",
            botUserId: "usr_bot_release_2",
            name: "Release 审批官",
            status: "active",
            visibilityPolicy: "private",
            triggerPolicy: "mention-or-command",
          },
        ]
      : []
  );
  const [selectedBotId, setSelectedBotId] = useState<string>(() =>
    isPreviewMode ? "bot_echo_1" : ""
  );
  const [settings, setSettings] = useState<BotSettingsData>({
    accessPolicy: null,
    visibilityPolicy: isPreviewMode ? "space_members" : "private",
    allowDirect: true,
    allowGroup: true,
    groupInviterPolicy: "owner",
    requireOwnerApproval: true,
    proactiveEnabled: isPreviewMode,
    triggerPolicy: "mention-or-command",
    allowedMemberIds: [],
    description: isPreviewMode ? "负责架构评审、会议纪要总结与发布卡片流转" : "",
    welcomeMessage: "",
    avatarUrl: "",
    maxContextMessages: 50,
    maxContextChars: 20_000,
    maxContextTokens: 8_000,
    contextWindowSeconds: 86_400,
    includeReplies: true,
    includeSystemEvents: false,
    includeAttachmentMetadata: false,
    allowAttachmentPreview: false,
  });
  const [tokens, setTokens] = useState<BotTokenRecord[]>(() =>
    isPreviewMode
      ? [
          {
            id: "btk_preview_active_01",
            botId: "bot_echo_1",
            scopes: DEFAULT_PAIRING_SCOPES,
            createdAt: "2026-11-15T00:00:00.000Z",
            lastUsedAt: "2026-11-15T00:50:00.000Z",
          },
        ]
      : []
  );
  const [overviewConversations, setOverviewConversations] = useState<BotConversationOverviewItem[]>([]);
  const [recentDeliveries, setRecentDeliveries] = useState<BotDeliveryDiagnosticItem[]>([]);
  const [latestSdkVersion, setLatestSdkVersion] = useState<string>("1.0.14");

  const [profileDraftsByBot, setProfileDraftsByBot] = useState<
    Record<string, { name?: string; bio?: string; welcome?: string }>
  >({});
  const [confirmDeleteBotId, setConfirmDeleteBotId] = useState<string>("");
  const botAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const setupCardRef = useRef<HTMLDivElement | null>(null);

  const [connection, setConnection] = useState<BotConnectionInfo | null>(() =>
    isPreviewMode
      ? {
          botId: "bot_echo_1",
          status: "connected",
          adapterVersion: "duallane-daemon/1.0.14",
          lastHeartbeatAt: new Date().toISOString(),
        }
      : null
  );
  const [groupPolicies, setGroupPolicies] = useState<BotGroupPolicy[]>([]);
  const [setupSession, setSetupSession] = useState<BotSetupSession | null>(() =>
    isPreviewMode && pendingBotSetupId
      ? buildPreviewSetupSession(pendingBotSetupId, "awaiting_user")
      : null
  );
  const [approvalScopes, setApprovalScopes] = useState<string[]>(DEFAULT_PAIRING_SCOPES);
  const [enableDmContextOnApprove, setEnableDmContextOnApprove] = useState(true);
  const [pairingPromptText, setPairingPromptText] = useState("");
  const [copiedKey, setCopiedKey] = useState<"" | "prompt" | "mcp" | "update">("");
  const [busyAction, setBusyAction] = useState<string>("");

  const [newName, setNewName] = useState("");
  const [expandedSlot, setExpandedSlot] = useState<"" | "commands" | "webhook" | "manual_token">("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    "messages:read_trigger",
    "messages:read_context",
    "messages:send",
    "cards:write",
    "cards:act",
    "commands:receive",
  ]);
  const [issuedToken, setIssuedToken] = useState<string>("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [commands, setCommands] = useState<BotCommandSpec[]>(() =>
    isPreviewMode
      ? [
          { command: "summarize", description: "总结当前对话与线程结论", scope: "all" },
          { command: "poll", description: "生成 Card Kit v1 投票卡片", scope: "all" },
        ]
      : []
  );
  const [cmdName, setCmdName] = useState("");
  const [cmdDesc, setCmdDesc] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://duallane.tsio.top";

  const applyServerSettings = useCallback((s: Record<string, unknown>) => {
    const ctxObj = (s.context && typeof s.context === "object" ? s.context : {}) as Record<
      string,
      unknown
    >;
    const rawVis = String(s.visibilityPolicy || "private");
    const accessPolicy = parseBotAccessPolicy(s.accessPolicy);
    setSettings({
      accessPolicy,
      visibilityPolicy: normalizeMemberVisibility(rawVis),
      allowDirect: s.allowDirect !== false,
      allowGroup: rawVis === "groups" ? true : s.allowGroup !== false,
      groupInviterPolicy: String(s.groupInviterPolicy || "owner"),
      requireOwnerApproval: s.requireOwnerApproval !== false,
      proactiveEnabled: Boolean(s.proactiveEnabled),
      triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
      allowedMemberIds: Array.isArray(s.allowedMemberIds) ? s.allowedMemberIds.map(String) : [],
      description: typeof s.description === "string" ? s.description : "",
      welcomeMessage: typeof s.welcomeMessage === "string" ? s.welcomeMessage : "",
      avatarUrl: typeof s.avatarUrl === "string" ? s.avatarUrl : "",
      maxContextMessages: Number(ctxObj.maxMessages || s.maxContextMessages || 50),
      maxContextChars: Number(ctxObj.maxChars || s.maxContextChars || 20_000),
      maxContextTokens: Number(ctxObj.maxTokens || s.maxContextTokens || 8_000),
      contextWindowSeconds: Number(ctxObj.windowSeconds || s.contextWindowSeconds || 86_400),
      includeReplies: ctxObj.includeReplies !== false,
      includeSystemEvents: Boolean(ctxObj.includeSystemEvents),
      includeAttachmentMetadata: Boolean(ctxObj.includeAttachmentMetadata),
      allowAttachmentPreview: Boolean(ctxObj.allowAttachmentPreview),
    });
  }, []);

  const loadBots = useCallback(async () => {
    if (isPreviewMode) return;
    try {
      const res = await apiV1.listBots();
      const list = Array.isArray(res.bots) ? (res.bots as BotItem[]) : [];
      setBots(list);
      setSelectedBotId((prev) => prev || list[0]?.id || "");
    } catch {
      // Non-fatal
    }
  }, [isPreviewMode]);

  useEffect(() => {
    if (isPreviewMode) return;
    let active = true;
    void apiV1
      .listBots()
      .then((res) => {
        if (!active) return;
        const list = Array.isArray(res.bots) ? (res.bots as BotItem[]) : [];
        setBots(list);
        setSelectedBotId((prev) => prev || list[0]?.id || "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isPreviewMode]);

  const refreshBotRuntimeState = useCallback(
    async (botId: string) => {
      if (!botId || isPreviewMode) return;
      const [overviewRes, settingsRes, cmdRes, connRes, gpRes, tokensRes] = await Promise.all([
        apiV1.getBotOverview(botId).catch(() => null),
        apiV1.getBotSettings(botId).catch(() => null),
        apiV1.getBotCommands(botId).catch(() => ({ commands: [] })),
        apiV1.getBotConnection(botId).catch(() => ({ connection: null })),
        apiV1.listBotGroupPolicies(botId).catch(() => ({ policies: [] })),
        apiV1.listBotTokens(botId).catch(() => ({ tokens: [] })),
      ]);
      if (settingsRes?.settings) {
        applyServerSettings(settingsRes.settings);
      }
      if (overviewRes) {
        setOverviewConversations(
          Array.isArray(overviewRes.conversations) ? overviewRes.conversations : []
        );
        setRecentDeliveries(
          Array.isArray(overviewRes.recentDeliveries) ? overviewRes.recentDeliveries : []
        );
        if (overviewRes.latestSdkVersion) {
          setLatestSdkVersion(overviewRes.latestSdkVersion);
        }
        if (overviewRes.webhook) {
          setWebhookUrl(overviewRes.webhook.url || "");
          setWebhookEnabled(Boolean(overviewRes.webhook.enabled));
        } else {
          setWebhookUrl("");
          setWebhookEnabled(false);
        }
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
      setTokens(Array.isArray(tokensRes.tokens) ? tokensRes.tokens : []);
    },
    [applyServerSettings, isPreviewMode]
  );

  useEffect(() => {
    if (!selectedBotId || isPreviewMode) return;
    let active = true;
    void Promise.all([
      apiV1.getBotOverview(selectedBotId).catch(() => null),
      apiV1.getBotSettings(selectedBotId).catch(() => null),
      apiV1.getBotCommands(selectedBotId).catch(() => ({ commands: [] })),
      apiV1.getBotConnection(selectedBotId).catch(() => ({ connection: null })),
      apiV1.listBotGroupPolicies(selectedBotId).catch(() => ({ policies: [] })),
      apiV1.listBotTokens(selectedBotId).catch(() => ({ tokens: [] })),
    ]).then(([overviewRes, settingsRes, cmdRes, connRes, gpRes, tokensRes]) => {
      if (!active) return;
      if (settingsRes?.settings) {
        applyServerSettings(settingsRes.settings);
      }
      if (overviewRes) {
        setOverviewConversations(
          Array.isArray(overviewRes.conversations) ? overviewRes.conversations : []
        );
        setRecentDeliveries(
          Array.isArray(overviewRes.recentDeliveries) ? overviewRes.recentDeliveries : []
        );
        if (overviewRes.latestSdkVersion) {
          setLatestSdkVersion(overviewRes.latestSdkVersion);
        }
        if (overviewRes.webhook) {
          setWebhookUrl(overviewRes.webhook.url || "");
          setWebhookEnabled(Boolean(overviewRes.webhook.enabled));
        } else {
          setWebhookUrl("");
          setWebhookEnabled(false);
        }
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
      setTokens(Array.isArray(tokensRes.tokens) ? tokensRes.tokens : []);
    });
    return () => {
      active = false;
    };
  }, [applyServerSettings, isPreviewMode, selectedBotId]);

  useEffect(() => {
    if (!pendingBotSetupId || isPreviewMode) return;
    let active = true;
    void apiV1
      .getBotSetupSession(pendingBotSetupId)
      .then((res) => {
        if (!active || !res.session) return;
        setSetupSession(res.session);
        setApprovalScopes(res.session.requestedScopes || DEFAULT_PAIRING_SCOPES);
        setActiveChapter("runtime");
        if (res.session.bot?.id) {
          setSelectedBotId(res.session.bot.id);
        }
      })
      .catch((err) => {
        if (!active) return;
        setErrorMessage(err instanceof Error ? err.message : "配对会话不存在或已过期");
      });
    return () => {
      active = false;
    };
  }, [isPreviewMode, pendingBotSetupId]);

  useEffect(() => {
    const activeId = setupSession?.id;
    const status = setupSession?.status;
    if (
      !activeId ||
      isPreviewMode ||
      (status !== "created" && status !== "awaiting_user" && status !== "approved")
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void apiV1
        .getBotSetupSession(activeId)
        .then((res) => {
          if (!res.session) return;
          setSetupSession((prev) => {
            const next = res.session;
            if (prev?.status === "created" && next.status === "awaiting_user") {
              setApprovalScopes(next.requestedScopes || DEFAULT_PAIRING_SCOPES);
            }
            if (prev?.status !== "exchanged" && next.status === "exchanged") {
              setStatusMessage("Agent 已完成凭证换取并成功绑定");
              if (next.bot?.id) {
                void refreshBotRuntimeState(next.bot.id);
              }
            }
            return next;
          });
        })
        .catch(() => {});
    }, 2200);
    return () => window.clearInterval(timer);
  }, [isPreviewMode, refreshBotRuntimeState, setupSession?.id, setupSession?.status]);

  const activeBot = bots.find((b) => b.id === selectedBotId);
  const activeBotUserId = activeBot?.botUserId || "";
  const profileNameDraft = activeBot
    ? (profileDraftsByBot[activeBot.id]?.name ?? activeBot.name)
    : "";
  const profileBioDraft = activeBot
    ? (profileDraftsByBot[activeBot.id]?.bio ??
      activeBot.description ??
      settings.description ??
      "")
    : "";
  const profileWelcomeDraft = activeBot
    ? (profileDraftsByBot[activeBot.id]?.welcome ?? settings.welcomeMessage ?? "")
    : "";

  const setProfileDraftField = (field: "name" | "bio" | "welcome", val: string) => {
    if (!selectedBotId) return;
    setProfileDraftsByBot((prev) => ({
      ...prev,
      [selectedBotId]: { ...prev[selectedBotId], [field]: val },
    }));
  };

  // Merge server overview conversations with local store fallback for preview mode
  const effectiveConversations: BotConversationOverviewItem[] =
    overviewConversations.length > 0
      ? overviewConversations
      : !activeBotUserId
      ? []
      : Object.values(conversations)
          .filter(
            (c) =>
              (c.kind === "direct" || c.kind === "group") &&
              c.memberIds.includes(activeBotUserId)
          )
          .map((c) => {
            const gp = groupPolicies.find((p) => p.conversationId === c.id);
            const isGroup = c.kind === "group";
            const groupActive = !isGroup || gp?.status === "active";
            return {
              id: c.id,
              type: c.kind,
              title: c.title,
              isOwnerDirect: c.kind === "direct",
              allowSend: groupActive,
              allowTrigger: isGroup ? Boolean(gp?.allowTrigger) : true,
              allowContext: isGroup ? Boolean(gp?.allowContext) : true,
              maxMessages: 50,
              triggerMode: isGroup
                ? settings.triggerPolicy === "all-messages"
                  ? "all_messages"
                  : "mention_or_command"
                : "direct",
              groupPolicyStatus: gp?.status || "",
              updatedAt: c.lastMessageAt || new Date().toISOString(),
            };
          });

  const markCopied = (key: "prompt" | "mcp" | "update") => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? "" : prev));
    }, 2000);
  };

  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setErrorMessage("");
    try {
      if (isPreviewMode) {
        const createdId = `bot_${crypto.randomUUID().slice(0, 8)}`;
        const created: BotItem = {
          id: createdId,
          botUserId: `usr_${createdId}`,
          name: newName.trim(),
          status: "active",
        };
        setBots((prev) => [...prev, created]);
        setSelectedBotId(createdId);
        setNewName("");
        setStatusMessage("新机器人已创建，创建者专属私聊已自动就绪");
        return;
      }
      const res = await apiV1.createBot(newName.trim());
      setNewName("");
      await loadBots();
      await bootstrapWorkspace().catch(() => {});
      if (res.botId) setSelectedBotId(String(res.botId));
      setStatusMessage("新机器人已创建，创建者专属私聊已自动开启");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "创建失败");
    }
  };

  const handleStartPairing = async () => {
    if (!activeBot) return;
    if (activeBot.status === "paused") {
      const msg = "机器人处于暂停状态，请先恢复运行后再生成配对指令";
      setErrorMessage(msg);
      useEmoteStore.getState().showToast(msg);
      return;
    }
    setErrorMessage("");
    setBusyAction("pair");
    setActiveChapter("runtime");
    try {
      if (isPreviewMode) {
        const mockId = `setup_${crypto.randomUUID().replace(/-/g, "")}`;
        const prompt = buildPairingPrompt(activeBot.name, origin, mockId);
        setPairingPromptText(prompt);
        setSetupSession(
          buildPreviewSetupSession(mockId, "created", {
            id: activeBot.id,
            botUserId: activeBot.botUserId,
            name: activeBot.name,
          })
        );
        setApprovalScopes(DEFAULT_PAIRING_SCOPES);
        await copyTextSafe(prompt);
        markCopied("prompt");
        setStatusMessage("配对指令已复制，发给任意 AI Agent 即可发起连接");
        useEmoteStore.getState().showToast("Agent 配对指令已复制");
        window.requestAnimationFrame(() => {
          setupCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
        return;
      }

      const res = await apiV1.createBotSetupSession(activeBot.id, DEFAULT_PAIRING_SCOPES);
      const session = res.session;
      const prompt = buildPairingPrompt(activeBot.name, origin, session.id);
      setSetupSession(session);
      setApprovalScopes(session.requestedScopes || DEFAULT_PAIRING_SCOPES);
      setPairingPromptText(prompt);
      const copied = await copyTextSafe(prompt);
      if (copied) markCopied("prompt");
      const msg = copied
        ? "配对指令已复制，粘贴给 Claude Code / Codex / Cursor / Antigravity 等任意 Agent 即可"
        : "配对会话已就绪，请点击下方卡片中的「复制配对指令」";
      setStatusMessage(msg);
      useEmoteStore
        .getState()
        .showToast(copied ? "Agent 配对指令已复制" : "配对指令已生成，请点击复制按钮");
      window.requestAnimationFrame(() => {
        setupCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "创建配对会话失败";
      setErrorMessage(errMsg);
      useEmoteStore.getState().showToast(errMsg);
    } finally {
      setBusyAction("");
    }
  };

  const handleApproveSetup = async () => {
    if (!setupSession) return;
    const validScopes = approvalScopes.filter((s) =>
      setupSession.requestedScopes.includes(s)
    );
    if (validScopes.length === 0) {
      setErrorMessage("请至少勾选一项授权能力");
      return;
    }
    setErrorMessage("");
    setBusyAction("approve");
    try {
      const targetBotId = setupSession.bot?.id || selectedBotId;
      const targetBotUserId =
        setupSession.bot?.botUserId ||
        bots.find((b) => b.id === targetBotId)?.botUserId;

      if (isPreviewMode) {
        setSetupSession((prev) =>
          prev ? { ...prev, status: "approved", approvedScopes: validScopes } : null
        );
        setPendingBotSetupId("");
        setStatusMessage("已确认授权，Agent 正在自动换取凭证");
        return;
      }

      const res = await apiV1.approveBotSetupSession(
        setupSession.id,
        validScopes,
        setupSession.requestedConversations?.length
          ? setupSession.requestedConversations
          : undefined
      );
      setSetupSession(res.session);
      setPendingBotSetupId("");

      if (enableDmContextOnApprove && targetBotId && targetBotUserId) {
        await apiV1.updateBotSettings(targetBotId, { allowDirect: true }).catch(() => {});
        const dmRes = await apiV1.createDirectConversation(targetBotUserId).catch(() => null);
        const convObj = (dmRes?.conversation || dmRes) as Record<string, unknown> | null;
        const dmConvId = convObj?.id ? String(convObj.id) : "";
        if (dmConvId) {
          await apiV1
            .updateBotContextGrant(targetBotId, dmConvId, {
              allowTrigger: true,
              allowContext: true,
              maxMessages: 50,
            })
            .catch(() => {});
        }
        await bootstrapWorkspace().catch(() => {});
      }

      setStatusMessage("已确认授权，等待 Agent 完成一次性凭证换取");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "确认授权失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleDenySetup = async () => {
    if (!setupSession) return;
    setErrorMessage("");
    setBusyAction("deny");
    try {
      if (!isPreviewMode) {
        await apiV1.denyBotSetupSession(setupSession.id);
      }
      setSetupSession(null);
      setPendingBotSetupId("");
      setStatusMessage("已拒绝本次配对请求");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "拒绝配对失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleOpenBotDirectChat = async () => {
    if (!activeBot?.botUserId) return;
    setErrorMessage("");
    setBusyAction("dm");
    try {
      if (isPreviewMode) {
        closeSettings();
        return;
      }
      await apiV1.updateBotSettings(activeBot.id, { allowDirect: true }).catch(() => {});
      const dmRes = await apiV1.createDirectConversation(activeBot.botUserId);
      const convObj = (dmRes?.conversation || dmRes) as Record<string, unknown>;
      const dmConvId = String(convObj?.id || "");
      if (dmConvId) {
        await apiV1
          .updateBotContextGrant(activeBot.id, dmConvId, {
            allowTrigger: true,
            allowContext: true,
            maxMessages: settings.maxContextMessages || 50,
          })
          .catch(() => {});
        await bootstrapWorkspace();
        selectConversation(dmConvId);
        closeSettings();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "打开机器人私聊失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleTestConnection = async () => {
    if (!activeBot) return;
    setErrorMessage("");
    setBusyAction("test");
    try {
      if (isPreviewMode) {
        setStatusMessage("连接状态正常（WebSocket 在线）");
        return;
      }
      const res = await apiV1.testBotConnection(activeBot.id);
      setConnection(res.connection || null);
      await refreshBotRuntimeState(activeBot.id);
      setStatusMessage(
        res.connection?.status === "connected"
          ? "连接检测通过：守护进程实时通道在线"
          : "机器人就绪（当前无常驻 WebSocket，仍可通过 MCP 或轮询收发消息）"
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "连接检测失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleRequestRemoteUpgrade = async () => {
    if (!activeBot) return;
    setErrorMessage("");
    setBusyAction("upgrade");
    try {
      if (!isPreviewMode) {
        const res = await apiV1.requestBotRuntimeUpgrade(activeBot.id);
        useEmoteStore
          .getState()
          .showToast(`已向守护进程下发 v${res.targetVersion} 空闲静默热更指令`);
      }
      setStatusMessage("已下发远程热更新通知，在线守护进程将在空闲时自动完成 SHA-256 校验并重启生效");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "下发升级指令失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleToggleConversationAccess = async (
    conv: BotConversationOverviewItem,
    nextContextEnabled: boolean
  ) => {
    if (!activeBot) return;
    setErrorMessage("");
    let returnedGroupStatus: string | undefined;
    try {
      if (!isPreviewMode) {
        if (conv.type === "group") {
          const result = await apiV1.updateBotGroupPolicy(activeBot.id, conv.id, {
            status: "active",
            allowTrigger: true,
            allowContext: nextContextEnabled,
            maxMessages: settings.maxContextMessages || 50,
          });
          returnedGroupStatus = result.policy?.status;
        } else {
          await apiV1.updateBotContextGrant(activeBot.id, conv.id, {
            allowTrigger: true,
            allowContext: nextContextEnabled,
            maxMessages: settings.maxContextMessages || 50,
          });
        }
        await refreshBotRuntimeState(activeBot.id);
      }
      if (conv.type === "group" && returnedGroupStatus === "pending") {
        setStatusMessage("已提交入群请求，等待群管理员批准；当前尚未激活");
        return;
      }
      setStatusMessage(
        nextContextEnabled
          ? `已开启「${conv.title}」的触发与上下文读取`
          : `已仅保留「${conv.title}」触发（关闭历史上下文读取）`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "会话授权更新失败");
    }
  };

  const patchSettings = async (patch: Record<string, unknown>, customNotice?: string) => {
    if (!selectedBotId) return;
    setErrorMessage("");
    try {
      if (!isPreviewMode) {
        const res = await apiV1.updateBotSettings(selectedBotId, patch);
        if (res?.settings && typeof res.settings === "object") {
          applyServerSettings(res.settings as Record<string, unknown>);
        } else {
          setSettings((prev) => ({ ...prev, ...patch }));
        }
        await refreshBotRuntimeState(selectedBotId);
      } else {
        setSettings((prev) => ({ ...prev, ...patch }));
      }
      setStatusMessage(customNotice || "机器人策略已保存");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新策略失败");
    }
  };

  const handleIssueOrRotateToken = async (rotate: boolean) => {
    if (!selectedBotId || selectedScopes.length === 0) return;
    setErrorMessage("");
    try {
      const res = rotate
        ? await apiV1.rotateBotToken(selectedBotId, selectedScopes)
        : await apiV1.issueBotToken(selectedBotId, selectedScopes);
      setIssuedToken(String(res.token || ""));
      setStatusMessage(
        rotate
          ? "凭证已轮换（仅展示一次明文，请立即复制保存）"
          : "新凭证已签发（仅展示一次明文）"
      );
      if (!isPreviewMode) {
        await refreshBotRuntimeState(selectedBotId);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "凭证操作失败");
    }
  };

  const handleSaveBotProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBot || !profileNameDraft.trim()) return;
    setErrorMessage("");
    setBusyAction("profile");
    try {
      const nextName = profileNameDraft.trim();
      const nextBio = profileBioDraft.trim();
      const nextWelcome = profileWelcomeDraft.trim();
      if (!isPreviewMode) {
        await apiV1.updateBotProfile(activeBot.id, {
          name: nextName,
          description: nextBio,
        });
        if (nextWelcome !== settings.welcomeMessage) {
          await apiV1.updateBotSettings(activeBot.id, {
            welcomeMessage: nextWelcome || null,
          });
        }
        await loadBots();
        await bootstrapWorkspace().catch(() => {});
      } else {
        setBots((prev) =>
          prev.map((b) =>
            b.id === activeBot.id ? { ...b, name: nextName, description: nextBio } : b
          )
        );
      }
      setSettings((prev) => ({
        ...prev,
        description: nextBio,
        welcomeMessage: nextWelcome,
      }));
      setStatusMessage("机器人资料与欢迎语已保存");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "保存资料失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleSelectBotColor = async (nextColor: BotAvatarColor | "") => {
    if (!activeBot) return;
    setErrorMessage("");
    const prevColor =
      activeBot.avatarColor ??
      (activeBot.botUserId ? members[activeBot.botUserId]?.avatarColor : undefined) ??
      "";
    setBots((prev) =>
      prev.map((b) => (b.id === activeBot.id ? { ...b, avatarColor: nextColor } : b))
    );
    if (activeBot.botUserId) {
      patchMemberLocal(activeBot.botUserId, {
        displayName: activeBot.name,
        role: "bot",
        avatarColor: nextColor || undefined,
      });
    }
    try {
      if (!isPreviewMode) {
        await apiV1.updateBotProfile(activeBot.id, { color: nextColor });
        void bootstrapWorkspace().catch(() => {});
      }
      const label = BOT_AVATAR_COLORS.find((c) => c.id === nextColor)?.label;
      setStatusMessage(label ? `机器人主题色已设为「${label}」` : "已恢复默认自动配色");
    } catch (err) {
      setBots((prev) =>
        prev.map((b) => (b.id === activeBot.id ? { ...b, avatarColor: prevColor } : b))
      );
      if (activeBot.botUserId) {
        patchMemberLocal(activeBot.botUserId, {
          avatarColor: prevColor || undefined,
        });
      }
      setErrorMessage(err instanceof Error ? err.message : "更新机器人主题色失败");
    }
  };

  const handleBotAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeBot) return;
    setErrorMessage("");
    setBusyAction("avatar");
    try {
      if (isPreviewMode) {
        const previewUrl = URL.createObjectURL(file);
        setSettings((prev) => ({ ...prev, avatarUrl: previewUrl }));
        setBots((prev) =>
          prev.map((b) => (b.id === activeBot.id ? { ...b, avatarUrl: previewUrl } : b))
        );
        setStatusMessage("机器人头像已更新");
        return;
      }
      const res = await apiV1.uploadBotAvatar(activeBot.id, file);
      setSettings((prev) => ({ ...prev, avatarUrl: res.avatarUrl }));
      setBots((prev) =>
        prev.map((b) => (b.id === activeBot.id ? { ...b, avatarUrl: res.avatarUrl } : b))
      );
      await bootstrapWorkspace().catch(() => {});
      setStatusMessage("机器人头像已更新");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "上传机器人头像失败（上限 512 KB）");
    } finally {
      setBusyAction("");
    }
  };

  const handleResetBotAvatar = async () => {
    if (!activeBot) return;
    setErrorMessage("");
    setBusyAction("avatar");
    try {
      if (!isPreviewMode) {
        await apiV1.deleteBotAvatar(activeBot.id);
        await bootstrapWorkspace().catch(() => {});
      }
      setSettings((prev) => ({ ...prev, avatarUrl: "" }));
      setBots((prev) =>
        prev.map((b) => (b.id === activeBot.id ? { ...b, avatarUrl: "" } : b))
      );
      setStatusMessage("已恢复默认机器人头像");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "重置头像失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    if (!activeBot) return;
    setErrorMessage("");
    setBusyAction(`revoke:${tokenId}`);
    try {
      if (!isPreviewMode) {
        await apiV1.revokeBotToken(activeBot.id, tokenId);
        await refreshBotRuntimeState(activeBot.id);
      } else {
        setTokens((prev) =>
          prev.map((t) =>
            t.id === tokenId ? { ...t, revokedAt: new Date().toISOString() } : t
          )
        );
        setConnection((prev) => (prev ? { ...prev, status: "disconnected" } : prev));
      }
      setStatusMessage("已解绑该 Agent 授权凭证，对应客户端连接已立即失效");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "解绑凭证失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleRevokeAllTokens = async () => {
    if (!activeBot) return;
    const activeList = tokens.filter((t) => !t.revokedAt);
    if (activeList.length === 0) return;
    setErrorMessage("");
    setBusyAction("revoke-all");
    try {
      if (!isPreviewMode) {
        for (const t of activeList) {
          await apiV1.revokeBotToken(activeBot.id, t.id);
        }
        await refreshBotRuntimeState(activeBot.id);
      } else {
        const nowIso = new Date().toISOString();
        setTokens((prev) => prev.map((t) => ({ ...t, revokedAt: t.revokedAt || nowIso })));
        setConnection((prev) => (prev ? { ...prev, status: "disconnected" } : prev));
      }
      setStatusMessage("已解绑全部 Agent 授权凭证");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "批量解绑失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleTogglePauseBot = async () => {
    if (!activeBot) return;
    const isPaused = activeBot.status === "paused";
    setErrorMessage("");
    setBusyAction("pause");
    try {
      if (!isPreviewMode) {
        if (isPaused) {
          await apiV1.resumeBot(activeBot.id);
        } else {
          await apiV1.pauseBot(activeBot.id);
        }
        await loadBots();
        await refreshBotRuntimeState(activeBot.id);
      } else {
        setBots((prev) =>
          prev.map((b) =>
            b.id === activeBot.id
              ? { ...b, status: isPaused ? "active" : "paused" }
              : b
          )
        );
      }
      setStatusMessage(isPaused ? "机器人已恢复运行" : "机器人已暂停响应");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "切换运行状态失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleConfirmDeleteBot = async () => {
    if (!activeBot) return;
    setErrorMessage("");
    setBusyAction("delete");
    try {
      const deletingId = activeBot.id;
      if (!isPreviewMode) {
        await apiV1.beginDeleteBot(deletingId);
        await apiV1.confirmDeleteBot(deletingId);
        const res = await apiV1.listBots();
        const nextList = Array.isArray(res.bots) ? (res.bots as BotItem[]) : [];
        setBots(nextList);
        setSelectedBotId(nextList[0]?.id || "");
        await bootstrapWorkspace().catch(() => {});
      } else {
        const nextList = bots.filter((b) => b.id !== deletingId);
        setBots(nextList);
        setSelectedBotId(nextList[0]?.id || "");
      }
      setConfirmDeleteBotId("");
      setStatusMessage("机器人已永久删除，所有绑定凭证均已吊销");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "删除机器人失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleRemoveCommand = async (commandName: string) => {
    if (!selectedBotId) return;
    setErrorMessage("");
    const next = commands.filter((c) => c.command !== commandName);
    try {
      if (!isPreviewMode) {
        await apiV1.putBotCommands(selectedBotId, next);
      }
      setCommands(next);
      setStatusMessage(`已移除指令 /${commandName}`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "移除指令失败");
    }
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBotId) return;
    setErrorMessage("");
    try {
      await apiV1.putBotWebhook(selectedBotId, webhookUrl, webhookSecret, webhookEnabled);
      setWebhookSecret("");
      setStatusMessage("Outbound Webhook 已保存");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Webhook 设置无效（密钥至少 16 位）");
    }
  };

  const handleAddCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBotId || !cmdName.trim()) return;
    setErrorMessage("");
    const cleaned = cmdName.trim().replace(/^\//, "").toLowerCase();
    const next: BotCommandSpec[] = [
      ...commands.filter((c) => c.command !== cleaned),
      { command: cleaned, description: cmdDesc.trim() || "自定义指令", scope: "all" },
    ];
    try {
      if (!isPreviewMode) {
        await apiV1.putBotCommands(selectedBotId, next);
      }
      setCommands(next);
      setCmdName("");
      setCmdDesc("");
      setStatusMessage("Slash 指令已注册");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "指令注册失败");
    }
  };

  const isConnected = connection?.status === "connected";
  const isPaused = activeBot?.status === "paused";
  const activeTokens = tokens.filter((t) => !t.revokedAt);
  const connectedSdkVer = extractSemverFromAdapter(connection?.adapterVersion);
  const sdkUpdateAvailable = isSemverOlder(connectedSdkVer, latestSdkVersion);
  const groupPreset = resolveGroupAccessPreset(settings);
  const activeAccessPolicy = settings.accessPolicy;
  const accessPolicyEnabled = activeAccessPolicy !== null;
  const selectableBotSources = Object.values(members).filter((member) =>
    isSelectableBotSourceMember(member, activeBot?.botUserId)
  );
  const accessPolicySummary = activeAccessPolicy
    ? describeBotAccessPolicy(activeAccessPolicy)
    : "沿用当前旧版权限规则；尚未启用独立的发现、私聊与群内来源策略";

  const updateAccessPolicy = (update: (current: BotAccessPolicy) => BotAccessPolicy, notice: string) => {
    const current = settings.accessPolicy || makePrivateAssistantGroupPolicy();
    const next = update(cloneBotAccessPolicy(current));
    void patchSettings(buildBotAccessPolicyPatch(next), notice);
  };

  const enableAccessPolicy = () => {
    void patchSettings(
      buildBotAccessPolicyPatch(makePrivateAssistantGroupPolicy()),
      "已启用独立权限策略：仅创建者私聊，获批群内当前成员可使用"
    );
  };

  const renderMemberPicker = (
    title: string,
    memberIds: readonly string[],
    updateMemberIds: (current: BotAccessPolicy, memberId: string) => BotAccessPolicy
  ) => (
    <div className="rounded-lg border border-dl-border-hairline p-2.5 space-y-2">
      <div className="text-[11px] font-medium text-dl-text-secondary">{title}</div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {Object.values(members)
          .filter((member) => member.role !== "bot")
          .map((member) => {
            const selected = memberIds.includes(member.id);
            return (
              <Button
                key={member.id}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={selected}
                aria-label={`${member.displayName}：${selected ? "已允许" : "未允许"}`}
                className={cn(
                  "w-full justify-between px-2.5 text-left",
                  selected && "bg-dl-lane-shared/10 text-dl-lane-shared"
                )}
                onClick={() =>
                  updateAccessPolicy(
                    (current) => updateMemberIds(current, member.id),
                    `${title}已更新`
                  )
                }
              >
                <span className="truncate">{member.displayName}</span>
                <span className="shrink-0 text-[10px] text-dl-text-tertiary">
                  {selected ? "已允许" : "未允许"}
                </span>
              </Button>
            );
          })}
        {Object.values(members).filter((member) => member.role !== "bot").length === 0 && (
          <div className="text-[11px] text-dl-text-tertiary sm:col-span-2">
            当前空间没有可选的人类成员。
          </div>
        )}
      </div>
      <div className="text-[10px] leading-4 text-dl-text-tertiary">
        只影响“{title}”这一项；其他维度的名单保持独立。
      </div>
    </div>
  );

  const activeBotAvatarUrl =
    settings.avatarUrl ||
    activeBot?.avatarUrl ||
    (activeBot?.botUserId ? members[activeBot.botUserId]?.avatarUrl : undefined);
  const activeBotColor =
    activeBot?.avatarColor ??
    (activeBot?.botUserId ? members[activeBot.botUserId]?.avatarColor : undefined) ??
    "";

  return (
    <div className="space-y-4">
      {statusMessage && (
        <div className="rounded-xl bg-dl-lane-shared/10 px-3 py-2 text-xs text-dl-lane-shared border border-dl-lane-shared/25">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="rounded-xl bg-dl-danger/10 px-3 py-2 text-xs text-dl-danger border border-dl-danger/25">
          {errorMessage}
        </div>
      )}

      {/* Pending / Active Setup Session Approval Banner */}
      {setupSession &&
        setupSession.status !== "denied" &&
        setupSession.status !== "expired" &&
        setupSession.status !== "revoked" && (
          <div
            ref={setupCardRef}
            className="rounded-2xl border border-dl-lane-shared/35 bg-dl-lane-shared/[0.06] p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                  <ShieldCheck className="size-4 text-dl-lane-shared" strokeWidth={2} />
                  <span>
                    {setupSession.status === "exchanged"
                      ? "Agent 配对已完成"
                      : setupSession.status === "approved"
                      ? "已授权，等待 Agent 换取凭证…"
                      : setupSession.status === "awaiting_user"
                      ? "收到 Agent 配对请求，请确认授权"
                      : "配对会话已就绪，等待 Agent 发起请求…"}
                  </span>
                </div>
                <div className="text-[11px] text-dl-text-secondary">
                  目标机器人：{setupSession.bot?.name || activeBot?.name || "当前机器人"}
                  {setupSession.clientName ? ` · 客户端：${setupSession.clientName}` : ""}
                </div>
              </div>
              <IconButton
                label="关闭配对卡片"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSetupSession(null);
                  setPendingBotSetupId("");
                }}
              >
                <X className="size-3.5" />
              </IconButton>
            </div>

            {pairingPromptText && setupSession.status === "created" && (
              <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-raised p-2.5 space-y-2">
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-dl-text-secondary">
                  {pairingPromptText}
                </pre>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() => {
                    void copyTextSafe(pairingPromptText).then((ok) => {
                      if (ok) {
                        markCopied("prompt");
                        useEmoteStore.getState().showToast("Agent 配对指令已复制");
                      }
                    });
                  }}
                >
                  {copiedKey === "prompt" ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copiedKey === "prompt" ? "已复制配对指令" : "复制配对指令"}
                </Button>
              </div>
            )}

            {(setupSession.status === "created" || setupSession.status === "awaiting_user") && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {setupSession.requestedScopes.map((scope) => {
                    const checked = approvalScopes.includes(scope);
                    return (
                      <Button
                        key={scope}
                        type="button"
                        size="sm"
                        variant={checked ? "primary" : "ghost"}
                        onClick={() =>
                          setApprovalScopes((prev) =>
                            checked ? prev.filter((item) => item !== scope) : [...prev, scope]
                          )
                        }
                      >
                        {checked ? "✓ " : ""}
                        {SCOPE_LABEL_MAP[scope] || scope}
                      </Button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs text-dl-text-primary">
                    同时开启与该机器人的私聊及上下文读取（最近 50 条）
                  </span>
                  <Switch
                    label="开启机器人私聊与上下文授权"
                    checked={enableDmContextOnApprove}
                    onCheckedChange={setEnableDmContextOnApprove}
                  />
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={busyAction === "approve"}
                    onClick={() => void handleApproveSetup()}
                  >
                    确认授权
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busyAction === "deny"}
                    onClick={() => void handleDenySetup()}
                  >
                    拒绝
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

      {/* Top Switcher & Quick Create Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {bots.map((bot) => {
            const selected = bot.id === selectedBotId;
            const botOnline =
              bot.botUserId && members[bot.botUserId]?.botOnline && bot.status !== "paused";
            return (
              <Button
                key={bot.id}
                size="sm"
                variant={selected ? "primary" : "secondary"}
                className="gap-1.5"
                onClick={() => {
                  setSelectedBotId(bot.id);
                  setConfirmDeleteBotId("");
                }}
              >
                <Bot className="size-3.5" strokeWidth={1.9} />
                <span>{bot.name}</span>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    bot.status === "paused"
                      ? "bg-dl-warning"
                      : botOnline
                      ? "bg-emerald-400"
                      : selected
                      ? "bg-white/60"
                      : "bg-dl-text-tertiary/60"
                  )}
                />
              </Button>
            );
          })}
        </div>

        <form onSubmit={handleCreateBot} className="flex items-center gap-1.5 min-w-[220px] flex-1 max-w-xs">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="输入新机器人名称"
            aria-label="新机器人名称"
            className="h-8 min-w-0 flex-1 text-xs"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>
            创建机器人
          </Button>
        </form>
      </div>

      {activeBot && (
        <div className="rounded-2xl border border-dl-border-hairline overflow-hidden bg-surface">
          {/* Sticky Bot Overview Header */}
          <div className="p-4 border-b border-dl-border-hairline bg-dl-surface-subtle/35 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                  <input
                    ref={botAvatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    aria-label="上传机器人头像"
                    className="sr-only"
                    onChange={(e) => void handleBotAvatarChange(e)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label="更换机器人头像"
                    disabled={busyAction === "avatar"}
                    onClick={() => botAvatarInputRef.current?.click()}
                    className="group relative h-auto w-auto rounded-entity p-0 hover:bg-transparent"
                  >
                    <Avatar
                      name={profileNameDraft || activeBot.name}
                      src={activeBotAvatarUrl}
                      kind="bot"
                      color={activeBotColor}
                      size="lg"
                    />
                    <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-dl-border-hairline bg-surface text-dl-text-primary shadow-2xs group-hover:text-dl-lane-shared transition-colors duration-150">
                      <Camera className="size-3" strokeWidth={2} />
                    </span>
                  </Button>
                </div>

                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-dl-text-primary truncate">
                      {activeBot.name}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        isPaused
                          ? "bg-dl-warning/15 text-dl-warning"
                          : "bg-dl-success/14 text-dl-success"
                      )}
                    >
                      {isPaused ? "已暂停" : "运行中"}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums",
                        isConnected
                          ? "bg-dl-lane-shared/12 text-dl-lane-shared"
                          : "bg-dl-surface-subtle text-dl-text-secondary"
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          isConnected ? "bg-dl-lane-shared" : "bg-dl-text-tertiary"
                        )}
                      />
                      {isConnected
                        ? `实时在线${connectedSdkVer ? ` · v${connectedSdkVer}` : ""}`
                        : "待机 / 按需调用"}
                    </span>
                    {sdkUpdateAvailable && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-dl-warning/15 px-2 py-0.5 text-[10px] font-semibold text-dl-warning tabular-nums">
                        可升至 v{latestSdkVersion}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-dl-text-secondary truncate">
                    {settings.description || activeBot.description || "暂未填写机器人职责简介"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {activeBot.botUserId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    className="gap-1"
                    disabled={busyAction === "dm"}
                    onClick={() => void handleOpenBotDirectChat()}
                  >
                    <MessageSquare className="size-3.5" />
                    发起私聊
                  </Button>
                )}

                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busyAction === "pause"}
                  onClick={() => void handleTogglePauseBot()}
                  className="gap-1"
                >
                  {isPaused ? (
                    <>
                      <PlayCircle className="size-3.5" strokeWidth={1.9} />
                      恢复运行
                    </>
                  ) : (
                    <>
                      <PauseCircle className="size-3.5" strokeWidth={1.9} />
                      暂停响应
                    </>
                  )}
                </Button>

                {confirmDeleteBotId === activeBot.id ? (
                  <div className="inline-flex items-center gap-1 rounded-xl bg-dl-danger/10 px-2 py-0.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busyAction === "delete"}
                      onClick={() => void handleConfirmDeleteBot()}
                      className="h-6 px-2 text-[11px]"
                    >
                      确认删除
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDeleteBotId("")}
                      className="h-6 px-1.5 text-[11px]"
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDeleteBotId(activeBot.id)}
                    className="gap-1 text-dl-text-secondary hover:text-dl-danger"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.85} />
                    删除
                  </Button>
                )}
              </div>
            </div>

            {/* 4-Chapter Modular Navigation */}
            <div
              role="tablist"
              aria-label="机器人设置章节"
              className="grid grid-cols-4 max-narrow:grid-cols-2 gap-1 rounded-xl bg-dl-surface-subtle/80 p-1"
            >
              {CHAPTER_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = activeChapter === tab.id;
                return (
                  <Button
                    key={tab.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveChapter(tab.id)}
                    className={cn(
                      "h-8 w-full justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium",
                      active
                        ? "bg-surface text-dl-text-primary shadow-2xs font-semibold hover:bg-surface"
                        : "text-dl-text-secondary hover:text-dl-text-primary hover:bg-surface/40"
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" strokeWidth={active ? 2.1 : 1.8} />
                    <span className="truncate">{tab.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="p-4">
            {/* =================================================================
                CHAPTER 1: 连接与运行 (Runtime, SDK Updater & Delivery Diagnostics)
               ================================================================= */}
            <div className={cn(activeChapter !== "runtime" && "hidden", "space-y-4")}>
              {/* One-Click Agent Pairing */}
              <div className="space-y-2.5 rounded-xl border border-dl-border-hairline p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-dl-text-primary">
                      一键连接 AI Agent
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      通用适配 Claude Code、Codex、Cursor、Antigravity、OpenClaw 等客户端，无需公网 IP 或手动粘贴密钥。
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="gap-1"
                    disabled={busyAction === "test"}
                    onClick={() => void handleTestConnection()}
                  >
                    <RefreshCw className={cn("size-3.5", busyAction === "test" && "animate-spin")} />
                    检测连接
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    className="gap-1.5"
                    disabled={busyAction === "pair"}
                    onClick={() => void handleStartPairing()}
                  >
                    {busyAction === "pair" ? (
                      <RefreshCw className="size-3.5 animate-spin" />
                    ) : copiedKey === "prompt" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Link2 className="size-3.5" />
                    )}
                    {busyAction === "pair"
                      ? "正在生成配对指令…"
                      : copiedKey === "prompt"
                      ? "已复制 Agent 配对指令"
                      : "生成并复制 Agent 配对指令"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={() => {
                      void copyTextSafe(buildStandardMcpConfig()).then((ok) => {
                        if (ok) {
                          markCopied("mcp");
                          setStatusMessage("标准 MCP 配置 JSON 已复制");
                          useEmoteStore.getState().showToast("标准 MCP 配置 JSON 已复制");
                        }
                      });
                    }}
                  >
                    {copiedKey === "mcp" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copiedKey === "mcp" ? "已复制 MCP 配置" : "复制标准 MCP 配置"}
                  </Button>
                </div>
              </div>

              {/* Runtime SDK Version & Silent Hot-Update Card */}
              <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-dl-text-primary">
                      <span>运行时版本与自动热更</span>
                      <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] text-dl-text-secondary border border-dl-border-hairline tabular-nums">
                        最新 SDK v{latestSdkVersion}
                      </span>
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      {connection?.adapterVersion
                        ? `当前上报客户端：${connection.adapterVersion}`
                        : "当前暂无活跃长连接上报版本号"}
                      {" · 常驻守护进程会在空闲时自动校验 SHA-256 并静默升级"}
                    </div>
                    <p className="text-[11px] leading-5 text-dl-text-secondary">
                      最低要求 SDK 1.2.1，旧版无法连接。请先使用下方命令升级，并按接入 Skill 核验；原有配对、桥接与权限配置会保留。
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {isConnected && (
                      <Button
                        type="button"
                        size="sm"
                        variant={sdkUpdateAvailable ? "primary" : "secondary"}
                        className="gap-1"
                        disabled={busyAction === "upgrade"}
                        onClick={() => void handleRequestRemoteUpgrade()}
                      >
                        <ArrowUpCircle className="size-3.5" />
                        {sdkUpdateAvailable ? "立即远程热更" : "推送升级检查"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="gap-1 text-xs"
                      onClick={() => {
                        const cmd = "node ~/.duallane/bin/duallane-agent.mjs update";
                        void copyTextSafe(cmd).then((ok) => {
                          if (ok) {
                            markCopied("update");
                            useEmoteStore.getState().showToast("CLI 升级指令已复制");
                          }
                        });
                      }}
                    >
                      {copiedKey === "update" ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      {copiedKey === "update" ? "已复制升级命令" : "复制 CLI 更新命令"}
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg bg-surface/80 px-2.5 py-1.5 font-mono text-[11px] text-dl-text-tertiary border border-dl-border-hairline">
                  体检与更新命令：duallane-agent doctor · duallane-agent update
                </div>
              </div>

              {/* Recent Delivery Queue Diagnostics */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-dl-text-primary">
                    最近触发投递记录
                  </span>
                  <span className="text-[11px] text-dl-text-tertiary tabular-nums">
                    最近 {recentDeliveries.length} 条
                  </span>
                </div>
                {recentDeliveries.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-dl-border-hairline px-3 py-2.5 text-[11px] text-dl-text-tertiary">
                    暂无近期触发记录。可在私聊发送消息或在已授权群聊 `@` 提及机器人进行测试。
                  </div>
                ) : (
                  <div className="space-y-1">
                    {recentDeliveries.slice(0, 6).map((item) => {
                      const badge = formatDeliveryStatus(item.status);
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/55 px-3 py-1.5 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[11px] text-dl-text-tertiary tabular-nums shrink-0">
                              #{item.sequence}
                            </span>
                            <span className="truncate text-dl-text-primary">
                              {item.conversationTitle ||
                                (item.eventType === "bot.runtime_upgrade"
                                  ? "远程热更新通知"
                                  : item.eventType)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                badge.toneClass
                              )}
                            >
                              {badge.label}
                            </span>
                            <span className="text-[11px] text-dl-text-tertiary tabular-nums">
                              {new Date(item.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* =================================================================
                CHAPTER 2: 权限与会话 (Orthogonal Permissions & Conversation Grants)
               ================================================================= */}
            <div className={cn(activeChapter !== "permissions" && "hidden", "space-y-4")}>
              {/* Creator Sovereignty Guarantee Banner */}
              <div className="flex items-center justify-between gap-3 rounded-xl bg-dl-lane-shared/[0.07] border border-dl-lane-shared/20 px-3.5 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Lock className="size-3.5 text-dl-lane-shared shrink-0" strokeWidth={2.1} />
                  <div className="text-xs text-dl-text-primary">
                    <span className="font-semibold">创建者保留私聊资格</span>
                    <span className="text-dl-text-secondary">
                      {" · 允许私聊时，创建者始终在准入范围内；关闭私聊或停用机器人仍会生效"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Explicit v2 policy: legacy settings remain untouched until the owner opts in. */}
              <div
                data-testid="bot-access-policy"
                className={cn(
                  "rounded-xl border p-3.5 space-y-3",
                  accessPolicyEnabled
                    ? "border-dl-lane-shared/30 bg-dl-lane-shared/[0.035]"
                    : "border-dl-border-hairline"
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-xs font-semibold text-dl-text-primary">
                      独立权限策略（发现、私聊、群内使用）
                    </div>
                    <div className="text-[11px] leading-5 text-dl-text-tertiary">
                      {accessPolicySummary}
                    </div>
                    <div className="text-[10px] leading-4 text-dl-text-tertiary">
                      推荐预设：私有助手，指定群共享（群邀请、创建者同意与群管理仍在下方独立设置）
                    </div>
                  </div>
                  {!accessPolicyEnabled && (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      onClick={enableAccessPolicy}
                      disabled={busyAction !== ""}
                      className="shrink-0"
                    >
                      启用“私有助手，指定群共享”
                    </Button>
                  )}
                </div>

                {!activeAccessPolicy ? (
                  <div className="rounded-lg bg-dl-surface-subtle/60 px-3 py-2 text-[11px] leading-5 text-dl-text-secondary">
                    旧版设置不会在打开页面时自动转换。启用后，目录发现、私聊准入和群内使用会分别保存；
                    群内当前成员可用也不会自动开放其他 Bot 互相触发。
                    平台要求助手运行包至少为兼容的 1.2.1 版本；请按接入 Skill 确认会话任务工具可用。
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1.5">
                        <span className="text-[11px] font-medium text-dl-text-secondary">目录发现</span>
                        <Select
                          value={activeAccessPolicy.discovery.audience}
                          onValueChange={(value) =>
                            updateAccessPolicy(
                              (current) => ({
                                ...current,
                                discovery: {
                                  ...current.discovery,
                                  audience: value as BotPolicyAudience,
                                },
                              }),
                              "目录发现范围已更新"
                            )
                          }
                          options={[
                            { value: "owner_only", label: "仅创建者可发现" },
                            { value: "specified_members", label: "创建者与指定成员" },
                            { value: "space_members", label: "空间成员" },
                          ]}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-[11px] font-medium text-dl-text-secondary">发起私聊</span>
                        <Select
                          value={activeAccessPolicy.direct.audience}
                          onValueChange={(value) =>
                            updateAccessPolicy(
                              (current) => ({
                                ...current,
                                direct: {
                                  ...current.direct,
                                  audience: value as BotPolicyAudience,
                                },
                              }),
                              "私聊准入范围已更新"
                            )
                          }
                          options={[
                            { value: "owner_only", label: "仅创建者可私聊" },
                            { value: "specified_members", label: "创建者与指定成员" },
                            { value: "space_members", label: "空间成员" },
                          ]}
                        />
                      </label>
                      <label className="space-y-1.5 md:col-span-2">
                        <span className="text-[11px] font-medium text-dl-text-secondary">已批准群内的使用者</span>
                        <Select
                          value={activeAccessPolicy.groups.audience}
                          onValueChange={(value) =>
                            updateAccessPolicy(
                              (current) => ({
                                ...current,
                                groups: {
                                  ...current.groups,
                                  audience: value as BotGroupAudience,
                                },
                              }),
                              "群内使用范围已更新"
                            )
                          }
                          options={[
                            { value: "owner_only", label: "仅创建者可在群内使用" },
                            { value: "specified_members", label: "创建者与指定成员" },
                            { value: "current_members", label: "该群当前成员（推荐）" },
                          ]}
                        />
                      </label>
                    </div>

                    {activeAccessPolicy.discovery.audience === "specified_members" &&
                      renderMemberPicker(
                        "可发现成员",
                        activeAccessPolicy.discovery.memberIds,
                        (current, memberId) => ({
                          ...current,
                          discovery: {
                            ...current.discovery,
                            memberIds: toggleStringId(current.discovery.memberIds, memberId),
                          },
                        })
                      )}
                    {activeAccessPolicy.direct.audience === "specified_members" &&
                      renderMemberPicker(
                        "可发起私聊的成员",
                        activeAccessPolicy.direct.memberIds,
                        (current, memberId) => ({
                          ...current,
                          direct: {
                            ...current.direct,
                            memberIds: toggleStringId(current.direct.memberIds, memberId),
                          },
                        })
                      )}
                    {activeAccessPolicy.groups.audience === "specified_members" &&
                      renderMemberPicker(
                        "可在已批准群内使用的成员",
                        activeAccessPolicy.groups.memberIds,
                        (current, memberId) => ({
                          ...current,
                          groups: {
                            ...current.groups,
                            memberIds: toggleStringId(current.groups.memberIds, memberId),
                          },
                        })
                      )}

                    <div className="rounded-lg bg-dl-surface-subtle/60 px-3 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-medium text-dl-text-primary">允许其他 Bot 触发</div>
                          <div className="text-[11px] leading-5 text-dl-text-tertiary">
                            默认关闭。开启后仍需逐个指定来源 Bot，并受服务端因果链、预算和停止控制约束。
                          </div>
                        </div>
                        <Switch
                          label="允许其他 Bot 触发"
                          checked={activeAccessPolicy.groups.allowBotTriggers}
                          onCheckedChange={(checked) =>
                            updateAccessPolicy(
                              (current) => ({
                                ...current,
                                groups: {
                                  ...current.groups,
                                  allowBotTriggers: checked,
                                  allowedBotIds: checked ? current.groups.allowedBotIds : [],
                                },
                              }),
                              checked ? "已开启受控 Bot 来源触发" : "已关闭 Bot 来源触发"
                            )
                          }
                        />
                      </div>
                      {activeAccessPolicy.groups.allowBotTriggers && (
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {selectableBotSources.map((member) => {
                            const botId = member.botId.trim();
                            const selected = activeAccessPolicy.groups.allowedBotIds.includes(botId);
                            return (
                              <Button
                                key={member.id}
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-pressed={selected}
                                aria-label={`${member.displayName}：${selected ? "已允许" : "未允许"}`}
                                className={cn(
                                  "w-full justify-between px-2.5 text-left",
                                  selected && "bg-dl-lane-shared/10 text-dl-lane-shared"
                                )}
                                onClick={() =>
                                  updateAccessPolicy(
                                    (current) => ({
                                      ...current,
                                      groups: {
                                        ...current.groups,
                                        allowedBotIds: toggleStringId(current.groups.allowedBotIds, botId),
                                      },
                                    }),
                                    "允许来源 Bot 已更新"
                                  )
                                }
                              >
                                <span className="truncate">{member.displayName}</span>
                                <span className="text-[10px] text-dl-text-tertiary">
                                  {selected ? "已允许" : "未允许"}
                                </span>
                              </Button>
                            );
                          })}
                          {selectableBotSources.length === 0 && (
                            <div className="text-[11px] text-dl-text-tertiary sm:col-span-2">
                              当前空间没有可选的其他 Bot；开启后仍不会自动允许未来新增的 Bot。
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Axis 1: Member Discovery & Direct Chat Scope */}
              <div
                className={cn(
                  "rounded-xl border border-dl-border-hairline p-3.5 space-y-3",
                  accessPolicyEnabled && "hidden"
                )}
              >
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-dl-text-primary">
                    1. 成员可用范围（谁可以发现并与机器人私聊）
                  </div>
                  <div className="text-[11px] text-dl-text-tertiary">
                    独立控制成员私聊可见性，不再与群聊权限耦合
                  </div>
                </div>
                <Select
                  value={normalizeMemberVisibility(settings.visibilityPolicy)}
                  onValueChange={(val) =>
                    void patchSettings(
                      { visibilityPolicy: val, allowDirect: true },
                      "成员可用范围已更新"
                    )
                  }
                  options={[
                    { value: "private", label: "仅创建者本人可用（默认）" },
                    { value: "specified_members", label: "创建者 + 指定空间成员可用" },
                    { value: "space_members", label: "全空间成员可用" },
                  ]}
                />

                {normalizeMemberVisibility(settings.visibilityPolicy) === "specified_members" && (
                  <div className="max-h-36 overflow-y-auto rounded-xl border border-dl-border-hairline p-2 space-y-1">
                    {Object.values(members)
                      .filter((m) => m.role !== "bot")
                      .map((m) => {
                        const selected = settings.allowedMemberIds.includes(m.id);
                        return (
                          <Button
                            key={m.id}
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={cn(
                              "w-full justify-between px-2.5",
                              selected && "bg-dl-lane-shared/10 text-dl-lane-shared"
                            )}
                            onClick={() => {
                              const next = selected
                                ? settings.allowedMemberIds.filter((id) => id !== m.id)
                                : [...settings.allowedMemberIds, m.id];
                              void patchSettings(
                                { allowedMemberIds: next },
                                "指定成员白名单已更新"
                              );
                            }}
                          >
                            <span>{m.displayName}</span>
                            <span>{selected ? "✓ 已授权" : "点击授权"}</span>
                          </Button>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* Axis 2: Group Chat Admission & Trigger Policy */}
              <div className="rounded-xl border border-dl-border-hairline p-3.5 space-y-3">
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-dl-text-primary">
                    2. 群聊准入与唤醒规则
                  </div>
                  <div className="text-[11px] text-dl-text-tertiary">
                    设置谁可以将该机器人拉入群聊，以及群内的消息触发条件
                  </div>
                </div>

                <Select
                  value={groupPreset}
                  onValueChange={(val) =>
                    void patchSettings(
                      buildGroupAccessPatch(val as GroupAccessPreset),
                      "群聊准入策略已更新"
                    )
                  }
                  options={[
                    { value: "owner_only", label: "允许入群 · 仅创建者本人可拉入（推荐）" },
                    { value: "approval_required", label: "允许入群 · 其他成员拉入需我审批" },
                    { value: "open", label: "允许入群 · 可用范围内的成员可直接拉入" },
                    { value: "disabled", label: "禁止加入任何群聊（仅限私聊）" },
                  ]}
                />

                {settings.allowGroup && (
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-dl-surface-subtle/60 px-3 py-2">
                    <div>
                      <div className="text-xs font-medium text-dl-text-primary">群组隐私模式</div>
                      <div className="text-[11px] text-dl-text-tertiary">
                        开启后群内仅响应 `@提及`、回复机器人消息或 `/指令`；关闭则响应群内全部消息
                      </div>
                    </div>
                    <Switch
                      label="Telegram 群组隐私模式"
                      checked={settings.triggerPolicy !== "all-messages"}
                      onCheckedChange={(privacyOn) =>
                        void patchSettings(
                          { triggerPolicy: privacyOn ? "mention-or-command" : "all-messages" },
                          privacyOn
                            ? "已开启群组隐私模式（仅 @提及/回复/指令唤醒）"
                            : "已开启群聊全量消息响应模式"
                        )
                      }
                    />
                  </div>
                )}
              </div>

              {/* Connected Conversations & Effective Trigger Status */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-dl-text-primary">
                    已接入会话与实际生效状态 ({effectiveConversations.length})
                  </span>
                  <span className="text-[11px] text-dl-text-tertiary">
                    网关实时鉴权真值
                  </span>
                </div>

                {effectiveConversations.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-dl-border-hairline px-3 py-2.5 text-[11px] text-dl-text-tertiary">
                    当前尚未加入任何群聊或私聊。点击上方「发起私聊」即可一键开启专属对话。
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {effectiveConversations.map((conv) => {
                      const triggerLabel = !conv.allowTrigger
                        ? formatBlockReason(conv.blockReason)
                        : conv.type === "direct"
                        ? "私聊实时响应"
                        : conv.triggerMode === "all_messages"
                        ? "群内全量响应"
                        : "群内 @提及 / 回复唤醒";
                      return (
                        <div
                          key={conv.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/60 px-3 py-2 text-xs"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-dl-text-primary truncate">
                                {conv.type === "direct"
                                  ? `私聊 · ${conv.title}`
                                  : `群聊 · ${conv.title}`}
                              </span>
                              {conv.isOwnerDirect && (
                                <span className="rounded bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-semibold text-dl-lane-shared shrink-0">
                                  创建者专属
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 font-medium",
                                  conv.allowTrigger ? "text-dl-success" : "text-dl-warning"
                                )}
                              >
                                <span
                                  className={cn(
                                    "size-1.5 rounded-full",
                                    conv.allowTrigger ? "bg-dl-success" : "bg-dl-warning"
                                  )}
                                />
                                {triggerLabel}
                              </span>
                              <span className="text-dl-text-tertiary">
                                ·{" "}
                                {conv.allowContext
                                  ? `可读最近 ${conv.maxMessages} 条上下文`
                                  : "仅读取单条触发消息"}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {conv.type === "group" && conv.groupPolicyStatus !== "active" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="primary"
                                onClick={() => void handleToggleConversationAccess(conv, true)}
                              >
                                批准接入该群
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant={conv.allowContext ? "ghost" : "secondary"}
                                onClick={() =>
                                  void handleToggleConversationAccess(conv, !conv.allowContext)
                                }
                              >
                                {conv.allowContext ? "✓ 已授权上下文" : "开启上下文读取"}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* =================================================================
                CHAPTER 3: 资料与上下文 (Persona, Theme Color & Context Budget)
               ================================================================= */}
            <div className={cn(activeChapter !== "persona" && "hidden", "space-y-4")}>
              <form onSubmit={(e) => void handleSaveBotProfile(e)} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-dl-text-primary">
                    身份资料与欢迎语
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction === "avatar"}
                      onClick={() => botAvatarInputRef.current?.click()}
                      className="h-7 px-2 text-xs text-dl-lane-shared"
                    >
                      更换头像
                    </Button>
                    {activeBotAvatarUrl && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busyAction === "avatar"}
                        onClick={() => void handleResetBotAvatar()}
                        className="h-7 gap-1 px-2 text-xs text-dl-text-tertiary hover:text-dl-text-primary"
                      >
                        <RotateCcw className="size-3" strokeWidth={2} />
                        恢复默认
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 wide:grid-cols-2 gap-2.5">
                  <Input
                    value={profileNameDraft}
                    onChange={(e) => setProfileDraftField("name", e.target.value)}
                    placeholder="机器人显示名称"
                    aria-label="机器人显示名称"
                    className="h-8 text-xs"
                  />
                  <Input
                    value={profileBioDraft}
                    onChange={(e) => setProfileDraftField("bio", e.target.value)}
                    placeholder="职责简介（如：负责日常巡检、纪要总结与卡片分发）"
                    aria-label="机器人职责简介"
                    className="h-8 text-xs"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    value={profileWelcomeDraft}
                    onChange={(e) => setProfileDraftField("welcome", e.target.value)}
                    placeholder="首次对话欢迎语（选填，例如：你好，发给我任意问题或直接拖入文档即可）"
                    aria-label="机器人欢迎语"
                    className="h-8 flex-1 text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={!profileNameDraft.trim() || busyAction === "profile"}
                    className="h-8 shrink-0 px-3 text-xs"
                  >
                    保存资料
                  </Button>
                </div>

                <div
                  data-testid="bot-color-picker"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/55 px-3 py-2.5"
                >
                  <span className="text-xs font-medium text-dl-text-primary">机器人主题色</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleSelectBotColor("")}
                      aria-label="自动配色"
                      aria-pressed={!activeBotColor}
                      className={cn(
                        "h-6 rounded-full px-2 text-[11px] font-medium",
                        !activeBotColor
                          ? "bg-dl-lane-shared/15 text-dl-lane-shared ring-1 ring-dl-lane-shared/40"
                          : "bg-surface/80 text-dl-text-secondary hover:text-dl-text-primary border border-dl-border-hairline"
                      )}
                    >
                      自动
                    </Button>
                    {BOT_AVATAR_COLORS.map((preset) => {
                      const selected = activeBotColor === preset.id;
                      return (
                        <Button
                          key={preset.id}
                          type="button"
                          size="sm"
                          variant="ghost"
                          title={preset.label}
                          aria-label={`配色：${preset.label}`}
                          aria-pressed={selected}
                          onClick={() => void handleSelectBotColor(preset.id)}
                          style={{ backgroundImage: preset.gradient }}
                          className={cn(
                            "relative size-6 min-w-0 rounded-full p-0 text-white shadow-2xs transition-transform duration-150 hover:scale-105 hover:bg-transparent",
                            selected
                              ? "ring-2 ring-offset-2 ring-offset-surface ring-dl-text-primary scale-105"
                              : "ring-1 ring-black/10 dark:ring-white/15"
                          )}
                        >
                          {selected && <Check className="size-3 stroke-[2.6]" />}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </form>

              {/* Context Window Budget Controls */}
              <div className="rounded-xl border border-dl-border-hairline p-3.5 space-y-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-dl-text-primary">
                    上下文读取窗口策略
                  </div>
                  <div className="text-[11px] text-dl-text-tertiary">
                    控制机器人在已授权会话中每次唤醒可读取的历史上下文范围
                  </div>
                </div>

                <Select
                  value={String(settings.maxContextMessages || 50)}
                  onValueChange={(val) =>
                    void patchSettings(
                      { maxContextMessages: Number.parseInt(val, 10) || 50 },
                      `单次上下文窗口已设为最近 ${val} 条`
                    )
                  }
                  options={[
                    { value: "20", label: "轻量上下文 · 最近 20 条消息" },
                    { value: "50", label: "标准上下文 · 最近 50 条消息（推荐）" },
                    { value: "100", label: "深度上下文 · 最近 100 条消息" },
                  ]}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className="text-[11px] font-medium text-dl-text-secondary">可检索时间范围</span>
                    <Select
                      value={String(settings.contextWindowSeconds || 86_400)}
                      onValueChange={(val) =>
                        void patchSettings(
                          { contextWindowSeconds: Number.parseInt(val, 10) || 86_400 },
                          "历史检索时间范围已更新"
                        )
                      }
                      options={[
                        { value: "86400", label: "最近 24 小时" },
                        { value: "604800", label: "最近 7 天" },
                        { value: "2592000", label: "最近 30 天" },
                      ]}
                    />
                  </label>
                  <div className="rounded-lg bg-dl-surface-subtle/60 px-3 py-2 text-[11px] leading-5 text-dl-text-tertiary">
                    这是服务端允许检索的范围，不是每次都注入模型的消息数。Agent 可以在此范围内按需分页、搜索和展开。
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <div>
                    <div className="text-xs font-medium text-dl-text-primary">
                      附带话题与引用回复上下文
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary">
                      允许机器人理解消息所引用的原消息及话题脉络
                    </div>
                  </div>
                  <Switch
                    label="附带话题与引用回复"
                    checked={settings.includeReplies}
                    onCheckedChange={(checked) =>
                      void patchSettings({ includeReplies: checked }, "话题回复上下文策略已更新")
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-dl-text-primary">
                      附带文件与图片附件元数据
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary">
                      在上下文中包含附件文件名、类型与大小摘要
                    </div>
                  </div>
                  <Switch
                    label="附带附件元数据"
                    checked={settings.includeAttachmentMetadata}
                    onCheckedChange={(checked) =>
                      void patchSettings(
                        { includeAttachmentMetadata: checked },
                        "附件元数据读取策略已更新"
                      )
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-dl-text-primary">允许读取附件预览</div>
                    <div className="text-[11px] text-dl-text-tertiary">
                      只返回受限预览，仍需 files:read_preview Scope；完整文件还需单独的 files:read_content Scope
                    </div>
                  </div>
                  <Switch
                    label="允许读取附件预览"
                    checked={settings.allowAttachmentPreview}
                    onCheckedChange={(checked) =>
                      void patchSettings(
                        { allowAttachmentPreview: checked },
                        checked ? "已允许附件预览读取" : "已关闭附件预览读取"
                      )
                    }
                  />
                </div>

                <div className="rounded-lg border border-dl-border-hairline px-3 py-2 text-[11px] leading-5 text-dl-text-tertiary">
                  助手默认围绕触发消息接收少量近期上下文。Agent 可使用获准的历史工具按需拉取，
                  返回会标注分页、截断和覆盖范围；拿到读取权限不代表会把全部历史送入模型。
                </div>
              </div>
            </div>

            {/* =================================================================
                CHAPTER 4: 扩展与安全 (Modular Capability Slots & Bound Credentials)
               ================================================================= */}
            <div className={cn(activeChapter !== "extensions" && "hidden", "space-y-3")}>
              {/* Slot 1: Proactive Push Switch */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-dl-border-hairline px-3.5 py-3">
                <div>
                  <div className="text-xs font-semibold text-dl-text-primary">
                    允许主动推送消息与交互卡片
                  </div>
                  <div className="text-[11px] text-dl-text-tertiary">
                    用于定时巡检日报、CI 构建通知或异步长任务主动回传结果
                  </div>
                </div>
                <Switch
                  label="允许主动推送消息或卡片"
                  checked={settings.proactiveEnabled}
                  onCheckedChange={(checked) =>
                    void patchSettings({ proactiveEnabled: checked }, "主动推送权限已更新")
                  }
                />
              </div>

              {/* Slot 2: Bound Agent Credentials & One-Click Unbind */}
              <div className="rounded-xl border border-dl-border-hairline p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                    <KeyRound className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                    <span>已绑定凭证与解绑 ({activeTokens.length})</span>
                  </div>
                  {activeTokens.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction === "revoke-all"}
                      onClick={() => void handleRevokeAllTokens()}
                      className="h-6 gap-1 px-2 text-[11px] text-dl-danger hover:bg-dl-danger/10"
                    >
                      <Unlink className="size-3" strokeWidth={2} />
                      解绑全部凭证
                    </Button>
                  )}
                </div>

                {activeTokens.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-dl-border-hairline px-3 py-2 text-[11px] text-dl-text-tertiary">
                    当前未绑定任何 Agent 客户端凭证。可在「连接与运行」标签页一键免密配对。
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {activeTokens.map((tok) => (
                      <div
                        key={tok.id}
                        data-testid="bound-agent-token-row"
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/60 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] font-semibold text-dl-text-primary">
                              凭证 #{tok.id.slice(-8)}
                            </span>
                            <span className="rounded-full bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared tabular-nums">
                              {tok.scopes?.length || 0} 项权限
                            </span>
                          </div>
                          <div className="text-[11px] text-dl-text-tertiary tabular-nums">
                            绑定于 {new Date(tok.createdAt).toLocaleDateString()}
                            {tok.lastUsedAt
                              ? ` · 最近活跃 ${new Date(tok.lastUsedAt).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`
                              : ""}
                          </div>
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {(tok.scopes || []).map((scope) => (
                              <span
                                key={scope}
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[10px]",
                                  scope === "files:read_content"
                                    ? "bg-dl-warning/15 text-dl-warning"
                                    : "bg-dl-surface-subtle text-dl-text-tertiary"
                                )}
                              >
                                {SCOPE_LABEL_MAP[scope] || scope}
                              </span>
                            ))}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busyAction === `revoke:${tok.id}`}
                          onClick={() => void handleRevokeToken(tok.id)}
                          className="h-7 gap-1 px-2.5 text-xs hover:text-dl-danger"
                        >
                          <Unlink className="size-3.5" strokeWidth={1.9} />
                          解绑凭证
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Modular Extension Slots Header */}
              <div className="pt-1 text-[11px] font-semibold text-dl-text-tertiary px-0.5">
                开发者选项（Slash 指令 / 手动 Token / Webhook）
              </div>

              {/* Slot 3: Slash Commands Slot */}
              <div className="rounded-xl border border-dl-border-hairline overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setExpandedSlot((prev) => (prev === "commands" ? "" : "commands"))
                  }
                  className="h-auto w-full justify-between gap-2 rounded-none px-3.5 py-2.5 text-left hover:bg-dl-surface-subtle/50"
                >
                  <div>
                    <div className="text-xs font-semibold text-dl-text-primary">
                      Slash 快捷指令菜单
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary font-normal">
                      在聊天输入框键入 `/` 时展示给成员的快捷指令（已注册 {commands.length} 个）
                    </div>
                  </div>
                  {expandedSlot === "commands" ? (
                    <ChevronDown className="size-4 text-dl-text-tertiary shrink-0" />
                  ) : (
                    <ChevronRight className="size-4 text-dl-text-tertiary shrink-0" />
                  )}
                </Button>

                {expandedSlot === "commands" && (
                  <form
                    onSubmit={handleAddCommand}
                    className="border-t border-dl-border-hairline p-3.5 space-y-2.5 bg-dl-surface-subtle/25"
                  >
                    {commands.length > 0 && (
                      <div className="space-y-1">
                        {commands.map((cmd) => (
                          <div
                            key={cmd.command}
                            className="flex items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-xs border border-dl-border-hairline"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono font-medium text-dl-lane-shared shrink-0">
                                /{cmd.command}
                              </span>
                              <span className="truncate text-dl-text-secondary">
                                {cmd.description}
                              </span>
                            </div>
                            <IconButton
                              type="button"
                              size="sm"
                              variant="ghost"
                              label={`移除指令 /${cmd.command}`}
                              className="size-6 shrink-0 text-dl-text-tertiary hover:text-dl-danger"
                              onClick={() => void handleRemoveCommand(cmd.command)}
                            >
                              <X className="size-3" strokeWidth={2} />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-3 max-narrow:grid-cols-1 gap-2">
                      <Input
                        value={cmdName}
                        onChange={(e) => setCmdName(e.target.value)}
                        placeholder="/summarize"
                        aria-label="Slash 指令名"
                      />
                      <Input
                        value={cmdDesc}
                        onChange={(e) => setCmdDesc(e.target.value)}
                        placeholder="总结当前线程"
                        aria-label="Slash 指令描述"
                      />
                      <Button type="submit" size="sm" variant="secondary">
                        注册指令
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {/* Slot 4: Outbound Webhook Slot */}
              <div className="rounded-xl border border-dl-border-hairline overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setExpandedSlot((prev) => (prev === "webhook" ? "" : "webhook"))
                  }
                  className="h-auto w-full justify-between gap-2 rounded-none px-3.5 py-2.5 text-left hover:bg-dl-surface-subtle/50"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-dl-text-primary">
                      <span>Outbound Webhook（HMAC-SHA256）</span>
                      {webhookEnabled && webhookUrl && (
                        <span className="rounded-full bg-dl-success/14 px-1.5 py-0.5 text-[10px] font-medium text-dl-success">
                          已启用
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary truncate font-normal">
                      {webhookUrl ? `推送目标：${webhookUrl}` : "适用于无守护进程的外部 Serverless / HTTP 回调接入"}
                    </div>
                  </div>
                  {expandedSlot === "webhook" ? (
                    <ChevronDown className="size-4 text-dl-text-tertiary shrink-0" />
                  ) : (
                    <ChevronRight className="size-4 text-dl-text-tertiary shrink-0" />
                  )}
                </Button>

                {expandedSlot === "webhook" && (
                  <form
                    onSubmit={handleSaveWebhook}
                    className="border-t border-dl-border-hairline p-3.5 space-y-2.5 bg-dl-surface-subtle/25"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-dl-text-primary">
                        启用 HTTP 签名推送
                      </span>
                      <Switch
                        label="启用 Outbound Webhook"
                        checked={webhookEnabled}
                        onCheckedChange={setWebhookEnabled}
                      />
                    </div>
                    <div className="grid grid-cols-2 max-narrow:grid-cols-1 gap-2">
                      <Input
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        placeholder="https://agent.example.com/webhook"
                        aria-label="Webhook 地址"
                      />
                      <Input
                        value={webhookSecret}
                        onChange={(e) => setWebhookSecret(e.target.value)}
                        placeholder="签名密钥（至少 16 位）"
                        aria-label="Webhook 签名密钥"
                      />
                    </div>
                    <Button type="submit" size="sm" variant="secondary">
                      保存 Webhook
                    </Button>
                  </form>
                )}
              </div>

              {/* Slot 5: Manual Service Token Slot */}
              <div className="rounded-xl border border-dl-border-hairline overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setExpandedSlot((prev) => (prev === "manual_token" ? "" : "manual_token"))
                  }
                  className="h-auto w-full justify-between gap-2 rounded-none px-3.5 py-2.5 text-left hover:bg-dl-surface-subtle/50"
                >
                  <div>
                    <div className="text-xs font-semibold text-dl-text-primary">
                      手动签发服务集成 Token
                    </div>
                    <div className="text-[11px] text-dl-text-tertiary font-normal">
                      按最小权限勾选 Scope 手动签发或轮换 CI / 自研脚本密钥
                    </div>
                  </div>
                  {expandedSlot === "manual_token" ? (
                    <ChevronDown className="size-4 text-dl-text-tertiary shrink-0" />
                  ) : (
                    <ChevronRight className="size-4 text-dl-text-tertiary shrink-0" />
                  )}
                </Button>

                {expandedSlot === "manual_token" && (
                  <div className="border-t border-dl-border-hairline p-3.5 space-y-2.5 bg-dl-surface-subtle/25">
                    <div className="flex flex-wrap gap-1.5">
                      {VALID_SCOPES.map((s) => {
                        const active = selectedScopes.includes(s.id);
                        return (
                          <Button
                            key={s.id}
                            type="button"
                            size="sm"
                            variant={active ? "primary" : "ghost"}
                            onClick={() =>
                              setSelectedScopes((prev) =>
                                active ? prev.filter((x) => x !== s.id) : [...prev, s.id]
                              )
                            }
                          >
                            {active ? "✓ " : ""}
                            {s.label}
                          </Button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleIssueOrRotateToken(false)}
                      >
                        签发新 Token
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleIssueOrRotateToken(true)}
                      >
                        轮换 Token
                      </Button>
                    </div>
                    {issuedToken && (
                      <div className="rounded-xl bg-surface p-2.5 text-xs font-mono break-all select-all border border-dl-border-hairline">
                        {issuedToken}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
