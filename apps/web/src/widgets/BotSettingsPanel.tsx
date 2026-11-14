import React, { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Link2,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  apiV1,
  type BotCommandSpec,
  type BotConnectionInfo,
  type BotGroupPolicy,
  type BotSetupSession,
} from "@/shared/lib/api-v1";
import { Button, IconButton, Input, Select, Switch } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

interface BotItem {
  id: string;
  botUserId?: string;
  name: string;
  status: string;
  visibilityPolicy?: string;
  triggerPolicy?: string;
}

interface BotSettingsData {
  visibilityPolicy: string;
  allowDirect: boolean;
  allowGroup: boolean;
  proactiveEnabled: boolean;
  triggerPolicy: string;
  allowedMemberIds: string[];
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
];

const SCOPE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  VALID_SCOPES.map((item) => [item.id, item.label])
);

function buildPairingPrompt(botName: string, origin: string, sessionId: string): string {
  const skillUrl = `${origin}/integrations/v2/duallane-channel.md`;
  const setupUrl = `${origin}/workspace?setup=${encodeURIComponent(sessionId)}`;
  return [
    `请接入我的 DualLane 机器人「${botName}」：`,
    `1. 先阅读接入规范：${skillUrl}`,
    `2. 使用一次性配对地址发起绑定（无需手动粘贴 Token）：${setupUrl}`,
    `发起请求后提醒我在网页点击「确认授权」，完成后即可换取凭证并收发消息或卡片。`,
  ].join("\n");
}

function buildStandardMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        duallane: {
          command: "node",
          args: [
            "/path/to/duallane/packages/agent-sdk/bin/duallane-agent.mjs",
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
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
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
  });
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
      const [settingsRes, cmdRes, connRes, gpRes] = await Promise.all([
        apiV1.getBotSettings(botId).catch(() => null),
        apiV1.getBotCommands(botId).catch(() => ({ commands: [] })),
        apiV1.getBotConnection(botId).catch(() => ({ connection: null })),
        apiV1.listBotGroupPolicies(botId).catch(() => ({ policies: [] })),
      ]);
      if (settingsRes?.settings) {
        const s = settingsRes.settings;
        setSettings({
          visibilityPolicy: String(s.visibilityPolicy || "private"),
          allowDirect: s.allowDirect !== false,
          allowGroup: s.allowGroup !== false,
          proactiveEnabled: Boolean(s.proactiveEnabled),
          triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
          allowedMemberIds: Array.isArray(s.allowedMemberIds)
            ? s.allowedMemberIds.map(String)
            : [],
        });
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
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
    ]).then(([settingsRes, cmdRes, connRes, gpRes]) => {
      if (!active) return;
      if (settingsRes?.settings) {
        const s = settingsRes.settings;
        setSettings({
          visibilityPolicy: String(s.visibilityPolicy || "private"),
          allowDirect: s.allowDirect !== false,
          allowGroup: s.allowGroup !== false,
          proactiveEnabled: Boolean(s.proactiveEnabled),
          triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
          allowedMemberIds: Array.isArray(s.allowedMemberIds)
            ? s.allowedMemberIds.map(String)
            : [],
        });
      }
      setCommands(cmdRes.commands || []);
      setConnection(connRes.connection || null);
      setGroupPolicies(Array.isArray(gpRes.policies) ? gpRes.policies : []);
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
      setStatusMessage(
        copied
          ? "配对指令已复制，粘贴给 Claude Code / Codex / Cursor / Antigravity 等任意 Agent 即可"
          : "配对会话已创建，请复制下方指令发给 Agent"
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "创建配对会话失败");
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
          ? "Token 已轮换（仅展示一次明文，请立即复制保存）"
          : "新 Token 已签发（仅展示一次明文）"
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Token 操作失败");
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
          <div className="rounded-2xl border border-dl-lane-shared/35 bg-dl-lane-shared/[0.06] p-4 space-y-3">
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
                      if (ok) markCopied("prompt");
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
              onClick={() => setSelectedBotId(bot.id)}
            >
              <Bot className="size-3.5" strokeWidth={1.9} />
              {bot.name}
            </Button>
          ))}
        </div>
      )}

      {activeBot && (
        <div className="space-y-4 rounded-2xl border border-dl-border-hairline p-4">
          {/* 1. Universal One-Click Agent Pairing */}
          <div className="space-y-2.5">
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
                <Link2 className="size-3.5" />
                生成并复制 Agent 配对指令
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
                          className="flex items-center justify-between rounded-lg bg-dl-surface-subtle/60 px-2.5 py-1 text-xs"
                        >
                          <span className="font-mono text-dl-lane-shared">/{cmd.command}</span>
                          <span className="text-dl-text-secondary">{cmd.description}</span>
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
