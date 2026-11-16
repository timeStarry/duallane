import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Link2,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  apiV1,
  type BotCommandSpec,
  type BotConnectionInfo,
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
  visibilityPolicy: string;
  allowDirect: boolean;
  allowGroup: boolean;
  proactiveEnabled: boolean;
  triggerPolicy: string;
  allowedMemberIds: string[];
  description: string;
  avatarUrl: string;
}

const VALID_SCOPES = [
  { id: "messages:read_trigger", label: "读取触发消息" },
  { id: "messages:read_context", label: "读取对话上下文" },
  { id: "messages:send", label: "发送回复消息" },
  { id: "cards:write", label: "发送与更新卡片" },
  { id: "cards:act", label: "接收卡片交互" },
  { id: "commands:receive", label: "接收 Slash 指令" },
  { id: "files:read_metadata", label: "读取附件元数据" },
  { id: "files:write", label: "上传生成文件" },
];

const DEFAULT_PAIRING_SCOPES = [
  "messages:read_trigger",
  "messages:read_context",
  "messages:send",
  "cards:write",
  "cards:act",
  "commands:receive",
  "files:read_metadata",
  "files:write",
];

const SCOPE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  VALID_SCOPES.map((item) => [item.id, item.label])
);

function buildPairingPrompt(botName: string, origin: string, sessionId: string): string {
  const skillUrl = `${origin}/integrations/duallane-channel.md`;
  const runtimeUrl = `${origin}/integrations/duallane-agent.mjs`;
  const setupUrl = `${origin}/workspace?setup=${encodeURIComponent(sessionId)}`;
  return [
    `请接入我的 DualLane 机器人「${botName}」：`,
    `1. 先阅读接入规范：${skillUrl}`,
    `2. 无需 npm，直接从当前实例下载零依赖单文件运行时（含 CLI / MCP / 实时监听）：`,
    `   mkdir -p ~/.duallane/bin && curl -fsSL "${runtimeUrl}" -o ~/.duallane/bin/duallane-agent.mjs && chmod +x ~/.duallane/bin/duallane-agent.mjs`,
    `3. 使用一次性配对地址发起绑定（无需手动粘贴 Token）：${setupUrl}`,
    `发起请求后提醒我在网页点击「确认授权」；授权完成后请运行 node ~/.duallane/bin/duallane-agent.mjs daemon install --profile default --agent auto 注册常驻后台守护服务（支持断线自愈重连、私聊/群聊自动唤醒回复与群聊只读安全隔离）。`,
  ].join("\n");
}

function buildStandardMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        duallane: {
          command: "node",
          args: [
            "~/.duallane/bin/duallane-agent.mjs",
            "mcp",
            "--profile",
            "default",
          ],
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
    clientName: status === "awaiting_user" ? "duallane-mcp/1.0.0" : undefined,
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
            visibilityPolicy: "groups",
            triggerPolicy: "mention-or-command",
          },
        ]
      : []
  );
  const [selectedBotId, setSelectedBotId] = useState<string>(() =>
    isPreviewMode ? "bot_echo_1" : ""
  );
  const [settings, setSettings] = useState<BotSettingsData>({
    visibilityPolicy: isPreviewMode ? "space_members" : "private",
    allowDirect: true,
    allowGroup: true,
    proactiveEnabled: isPreviewMode,
    triggerPolicy: "mention-or-command",
    allowedMemberIds: [],
    description: isPreviewMode ? "负责架构评审、会议纪要总结与发布卡片流转" : "",
    avatarUrl: "",
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
  const [profileDraftsByBot, setProfileDraftsByBot] = useState<
    Record<string, { name?: string; bio?: string }>
  >({});
  const [confirmDeleteBotId, setConfirmDeleteBotId] = useState<string>("");
  const botAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const setupCardRef = useRef<HTMLDivElement | null>(null);
  const [connection, setConnection] = useState<BotConnectionInfo | null>(() =>
    isPreviewMode
      ? {
          botId: "bot_echo_1",
          status: "connected",
          adapterVersion: "duallane-mcp/1.0.0",
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
  const [copiedKey, setCopiedKey] = useState<"" | "prompt" | "mcp">("");
  const [busyAction, setBusyAction] = useState<string>("");

  const [newName, setNewName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
      const [settingsRes, cmdRes, connRes, gpRes, tokensRes] = await Promise.all([
        apiV1.getBotSettings(botId).catch(() => null),
        apiV1.getBotCommands(botId).catch(() => ({ commands: [] })),
        apiV1.getBotConnection(botId).catch(() => ({ connection: null })),
        apiV1.listBotGroupPolicies(botId).catch(() => ({ policies: [] })),
        apiV1.listBotTokens(botId).catch(() => ({ tokens: [] })),
      ]);
      if (settingsRes?.settings) {
        const s = settingsRes.settings;
        const desc = typeof s.description === "string" ? s.description : "";
        const avatar = typeof s.avatarUrl === "string" ? s.avatarUrl : "";
        setSettings({
          visibilityPolicy: String(s.visibilityPolicy || "private"),
          allowDirect: s.allowDirect !== false,
          allowGroup: s.allowGroup !== false,
          proactiveEnabled: Boolean(s.proactiveEnabled),
          triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
          allowedMemberIds: Array.isArray(s.allowedMemberIds)
            ? s.allowedMemberIds.map(String)
            : [],
          description: desc,
          avatarUrl: avatar,
        });
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
      setTokens(Array.isArray(tokensRes.tokens) ? tokensRes.tokens : []);
    },
    [isPreviewMode]
  );

  useEffect(() => {
    if (!selectedBotId || isPreviewMode) return;
    let active = true;
    void Promise.all([
      apiV1.getBotSettings(selectedBotId).catch(() => null),
      apiV1.getBotCommands(selectedBotId).catch(() => ({ commands: [] })),
      apiV1.getBotConnection(selectedBotId).catch(() => ({ connection: null })),
      apiV1.listBotGroupPolicies(selectedBotId).catch(() => ({ policies: [] })),
      apiV1.listBotTokens(selectedBotId).catch(() => ({ tokens: [] })),
    ]).then(([settingsRes, cmdRes, connRes, gpRes, tokensRes]) => {
      if (!active) return;
      if (settingsRes?.settings) {
        const s = settingsRes.settings;
        const desc = typeof s.description === "string" ? s.description : "";
        const avatar = typeof s.avatarUrl === "string" ? s.avatarUrl : "";
        setSettings({
          visibilityPolicy: String(s.visibilityPolicy || "private"),
          allowDirect: s.allowDirect !== false,
          allowGroup: s.allowGroup !== false,
          proactiveEnabled: Boolean(s.proactiveEnabled),
          triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
          allowedMemberIds: Array.isArray(s.allowedMemberIds)
            ? s.allowedMemberIds.map(String)
            : [],
          description: desc,
          avatarUrl: avatar,
        });
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
      setTokens(Array.isArray(tokensRes.tokens) ? tokensRes.tokens : []);
    });
    return () => {
      active = false;
    };
  }, [isPreviewMode, selectedBotId]);

  // Load setup session if user arrived via ?setup=setup_... deep link
  useEffect(() => {
    if (!pendingBotSetupId || isPreviewMode) return;
    let active = true;
    void apiV1
      .getBotSetupSession(pendingBotSetupId)
      .then((res) => {
        if (!active || !res.session) return;
        setSetupSession(res.session);
        setApprovalScopes(res.session.requestedScopes || DEFAULT_PAIRING_SCOPES);
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

  // Live-poll active setup session so Agent request & token exchange appear automatically
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
  const profileNameDraft = activeBot
    ? (profileDraftsByBot[activeBot.id]?.name ?? activeBot.name)
    : "";
  const profileBioDraft = activeBot
    ? (profileDraftsByBot[activeBot.id]?.bio ??
      activeBot.description ??
      settings.description ??
      "")
    : "";
  const setProfileNameDraft = (name: string) => {
    if (!selectedBotId) return;
    setProfileDraftsByBot((prev) => ({
      ...prev,
      [selectedBotId]: { ...prev[selectedBotId], name },
    }));
  };
  const setProfileBioDraft = (bio: string) => {
    if (!selectedBotId) return;
    setProfileDraftsByBot((prev) => ({
      ...prev,
      [selectedBotId]: { ...prev[selectedBotId], bio },
    }));
  };

  const botConversations = activeBot?.botUserId
    ? Object.values(conversations).filter(
        (c) =>
          (c.kind === "direct" || c.kind === "group") &&
          c.memberIds.includes(activeBot.botUserId!)
      )
    : [];

  const markCopied = (key: "prompt" | "mcp") => {
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
        setStatusMessage("新机器人已创建");
        return;
      }
      const res = await apiV1.createBot(newName.trim());
      setNewName("");
      await loadBots();
      if (res.botId) setSelectedBotId(String(res.botId));
      setStatusMessage("新机器人已创建");
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
      if (isPreviewMode) {
        setSetupSession(null);
        setPendingBotSetupId("");
        setStatusMessage("已拒绝本次配对请求");
        return;
      }
      await apiV1.denyBotSetupSession(setupSession.id);
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
            maxMessages: 50,
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
      setStatusMessage(
        res.connection?.status === "connected"
          ? "连接检测通过：Agent 实时通道在线"
          : "机器人就绪（当前无常驻 WebSocket，仍可通过 MCP 或 REST 收发消息）"
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "连接检测失败");
    } finally {
      setBusyAction("");
    }
  };

  const handleGrantConversationContext = async (
    conversationId: string,
    kind: "direct" | "group"
  ) => {
    if (!activeBot) return;
    setErrorMessage("");
    try {
      if (!isPreviewMode) {
        if (kind === "group") {
          await apiV1.updateBotGroupPolicy(activeBot.id, conversationId, {
            status: "active",
            allowTrigger: true,
            allowContext: true,
            maxMessages: 50,
          });
        } else {
          await apiV1.updateBotContextGrant(activeBot.id, conversationId, {
            allowTrigger: true,
            allowContext: true,
            maxMessages: 50,
          });
        }
        await refreshBotRuntimeState(activeBot.id);
      }
      setStatusMessage("已开启该会话的触发与上下文读取（最近 50 条）");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "会话授权更新失败");
    }
  };

  const patchSettings = async (patch: Record<string, unknown>) => {
    if (!selectedBotId) return;
    setErrorMessage("");
    try {
      if (!isPreviewMode) {
        await apiV1.updateBotSettings(selectedBotId, patch);
      }
      setSettings((prev) => ({ ...prev, ...patch }));
      setStatusMessage("机器人策略已更新");
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
      if (!isPreviewMode) {
        await apiV1.updateBotProfile(activeBot.id, {
          name: nextName,
          description: nextBio,
        });
        await loadBots();
        await bootstrapWorkspace().catch(() => {});
      } else {
        setBots((prev) =>
          prev.map((b) =>
            b.id === activeBot.id
              ? { ...b, name: nextName, description: nextBio }
              : b
          )
        );
      }
      setSettings((prev) => ({ ...prev, description: nextBio }));
      setStatusMessage("机器人资料已更新");
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
      setStatusMessage("Outbound Webhook 已保存");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Webhook 配置无效（密钥至少 16 位）");
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

      {/* Pending / Active Setup Session Approval Card */}
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

      {/* Multi-Bot Create */}
      <form onSubmit={handleCreateBot} className="flex flex-wrap items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="输入新机器人名称"
          aria-label="新机器人名称"
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>
          创建机器人
        </Button>
      </form>

      {bots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {bots.map((bot) => (
            <Button
              key={bot.id}
              size="sm"
              variant={bot.id === selectedBotId ? "primary" : "secondary"}
              className="gap-1.5"
              onClick={() => {
                setSelectedBotId(bot.id);
                setConfirmDeleteBotId("");
              }}
            >
              <Bot className="size-3.5" strokeWidth={1.9} />
              {bot.name}
            </Button>
          ))}
        </div>
      )}

      {activeBot && (
        <div className="space-y-4 rounded-2xl border border-dl-border-hairline p-4">
          {/* 0. Bot Profile, Avatar & Lifecycle Bar (Feishu / BotFather Style) */}
          <form onSubmit={(e) => void handleSaveBotProfile(e)} className="space-y-3">
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
                    <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-dl-border-hairline bg-surface text-dl-text-primary shadow-2xs group-hover:text-dl-lane-shared">
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
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction === "avatar"}
                      onClick={() => botAvatarInputRef.current?.click()}
                      className="h-6 px-2 text-[11px] text-dl-lane-shared"
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
                        className="h-6 gap-1 px-2 text-[11px] text-dl-text-tertiary hover:text-dl-text-primary"
                      >
                        <RotateCcw className="size-2.5" strokeWidth={2} />
                        恢复默认
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
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

            <div className="grid grid-cols-1 wide:grid-cols-2 gap-2">
              <Input
                value={profileNameDraft}
                onChange={(e) => setProfileNameDraft(e.target.value)}
                placeholder="机器人显示名称"
                aria-label="机器人显示名称"
                className="h-8 text-xs"
              />
              <div className="flex items-center gap-2">
                <Input
                  value={profileBioDraft}
                  onChange={(e) => setProfileBioDraft(e.target.value)}
                  placeholder="机器人职责简介（如：负责会议纪要与工单分发）"
                  aria-label="机器人职责简介"
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!profileNameDraft.trim() || busyAction === "profile"}
                  className="h-8 shrink-0 px-3 text-xs"
                >
                  保存资料
                </Button>
              </div>
            </div>

            <div
              data-testid="bot-color-picker"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/55 px-3 py-2"
            >
              <span className="text-[11px] font-medium text-dl-text-secondary">
                机器人主题色
              </span>
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
                        "relative size-6 min-w-0 rounded-full p-0 text-white shadow-2xs transition-transform hover:scale-105 hover:bg-transparent",
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

          {/* 1. Universal One-Click Agent Pairing */}
          <div className="space-y-2.5 border-t border-dl-border-hairline pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-dl-text-primary">
                  一键连接 AI Agent
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
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
                    ? `实时在线${connection?.adapterVersion ? ` · ${connection.adapterVersion}` : ""}`
                    : "待机 / 按需调用"}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                {activeBot.botUserId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
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
                  variant="ghost"
                  className="gap-1"
                  disabled={busyAction === "test"}
                  onClick={() => void handleTestConnection()}
                >
                  <RefreshCw className={cn("size-3.5", busyAction === "test" && "animate-spin")} />
                  检测
                </Button>
              </div>
            </div>

            <div className="text-[11px] text-dl-text-secondary">
              通用适配 Claude Code、Codex、Cursor、Antigravity、OpenClaw 等客户端，无需公网 IP 或手动复制密钥。
            </div>

            <div className="flex flex-wrap items-center gap-2">
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

          {/* 1.5 Bound Agent Credentials & One-Click Unbind */}
          <div className="space-y-2 border-t border-dl-border-hairline pt-3">
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
                当前未绑定任何 Agent 客户端凭证。点击上方「生成并复制 Agent 配对指令」即可完成无密钥配对。
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
                        <span className="rounded-full bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared">
                          {tok.scopes?.length || 0} 项权限
                        </span>
                      </div>
                      <div className="text-[11px] text-dl-text-tertiary">
                        绑定于 {new Date(tok.createdAt).toLocaleDateString()}
                        {tok.lastUsedAt
                          ? ` · 最近活跃 ${new Date(tok.lastUsedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : ""}
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
                <div className="text-[11px] text-dl-text-tertiary">
                  提示：也可在 Agent 终端运行 <code className="font-mono text-dl-text-secondary">duallane-agent unbind</code> 主动解绑并清除本地凭证。
                </div>
              </div>
            )}
          </div>

          {/* 2. Conversation Context Grants */}
          {botConversations.length > 0 && (
            <div className="space-y-2 border-t border-dl-border-hairline pt-3">
              <div className="text-xs font-semibold text-dl-text-primary">会话上下文授权</div>
              <div className="space-y-1.5">
                {botConversations.map((conv) => {
                  const gp = groupPolicies.find((p) => p.conversationId === conv.id);
                  const groupGranted =
                    conv.kind === "group" && gp?.status === "active" && gp.allowContext;
                  return (
                    <div
                      key={conv.id}
                      className="flex items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle/60 px-3 py-1.5 text-xs"
                    >
                      <span className="truncate text-dl-text-primary">
                        {conv.kind === "direct" ? `私聊 · ${conv.title}` : `群聊 · ${conv.title}`}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant={groupGranted ? "ghost" : "secondary"}
                        onClick={() =>
                          void handleGrantConversationContext(
                            conv.id,
                            conv.kind === "group" ? "group" : "direct"
                          )
                        }
                      >
                        {groupGranted ? "✓ 已授权上下文" : "授权读取最近 50 条"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. Core Bot Policies */}
          <div className="space-y-3 border-t border-dl-border-hairline pt-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-dl-text-primary">群组隐私模式</div>
                <div className="text-[11px] text-dl-text-tertiary">仅响应 `@提及` 与 `/指令`</div>
              </div>
              <Switch
                label="Telegram 群组隐私模式"
                checked={settings.triggerPolicy !== "all-messages"}
                onCheckedChange={(privacyOn) =>
                  void patchSettings({
                    triggerPolicy: privacyOn ? "mention-or-command" : "all-messages",
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-dl-text-primary">允许主动推送消息与卡片</div>
              <Switch
                label="允许主动推送消息或卡片"
                checked={settings.proactiveEnabled}
                onCheckedChange={(checked) => void patchSettings({ proactiveEnabled: checked })}
              />
            </div>

            <div className="space-y-2 pt-1">
              <div className="text-xs font-semibold text-dl-text-primary">可见范围</div>
              <Select
                value={settings.visibilityPolicy}
                onValueChange={(val) => void patchSettings({ visibilityPolicy: val })}
                options={[
                  { value: "private", label: "仅自己可见" },
                  { value: "specified_members", label: "指定空间成员可用" },
                  { value: "space_members", label: "全空间成员可用" },
                  { value: "groups", label: "允许加入群组" },
                ]}
              />
              {settings.visibilityPolicy === "specified_members" && (
                <div className="max-h-36 overflow-y-auto rounded-xl border border-dl-border-hairline p-2 space-y-1">
                  {Object.values(members).map((m) => {
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
                          void patchSettings({ allowedMemberIds: next });
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
          </div>

          {/* 4. Collapsible Developer Options */}
          <div className="border-t border-dl-border-hairline pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen((prev) => !prev)}
              className="w-full justify-between px-1.5 text-xs font-semibold text-dl-text-secondary hover:text-dl-text-primary"
            >
              <span>开发者选项（Slash 指令 / 手动 Token / Webhook）</span>
              {advancedOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </Button>

            {advancedOpen && (
              <div className="mt-3 space-y-4">
                {/* Slash Commands */}
                <form onSubmit={handleAddCommand} className="space-y-2">
                  <div className="text-xs font-semibold text-dl-text-primary">
                    Slash 指令菜单 ({commands.length})
                  </div>
                  {commands.length > 0 && (
                    <div className="space-y-1">
                      {commands.map((cmd) => (
                        <div
                          key={cmd.command}
                          className="flex items-center justify-between gap-2 rounded-lg bg-dl-surface-subtle/60 px-2.5 py-1 text-xs"
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

                {/* Scopes & Manual Token Issuance */}
                <div className="space-y-2 border-t border-dl-border-hairline pt-3">
                  <div className="text-xs font-semibold text-dl-text-primary">
                    手动签发 Token（服务集成用）
                  </div>
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
                    <div className="rounded-xl bg-dl-surface-subtle p-2.5 text-xs font-mono break-all select-all border border-dl-border-hairline">
                      {issuedToken}
                    </div>
                  )}
                </div>

                {/* Outbound Webhook */}
                <form
                  onSubmit={handleSaveWebhook}
                  className="space-y-2 border-t border-dl-border-hairline pt-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-dl-text-primary">
                      Outbound Webhook（HMAC-SHA256）
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
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
