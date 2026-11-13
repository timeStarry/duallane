import React, { useCallback, useEffect, useState } from "react";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type BotCommandSpec } from "@/shared/lib/api-v1";
import { Button, Input, Select, Switch } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

interface BotItem {
  id: string;
  name: string;
  status: string;
  visibilityPolicy?: string;
  triggerPolicy?: string;
}

interface BotSettingsData {
  visibilityPolicy: string;
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

export function BotSettingsPanel() {
  const { members } = useWorkspaceStore();
  const [bots, setBots] = useState<BotItem[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [settings, setSettings] = useState<BotSettingsData>({
    visibilityPolicy: "private",
    proactiveEnabled: false,
    triggerPolicy: "mention-or-command",
    allowedMemberIds: [],
  });
  const [newName, setNewName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    "messages:read_trigger",
    "messages:send",
    "cards:write",
    "commands:receive",
  ]);
  const [issuedToken, setIssuedToken] = useState<string>("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [commands, setCommands] = useState<BotCommandSpec[]>([]);
  const [cmdName, setCmdName] = useState("");
  const [cmdDesc, setCmdDesc] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const loadBots = useCallback(async () => {
    try {
      const res = await apiV1.listBots();
      const list = Array.isArray(res.bots) ? (res.bots as BotItem[]) : [];
      setBots(list);
      setSelectedBotId((prev) => prev || list[0]?.id || "");
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!selectedBotId) return;
    let active = true;
    void Promise.all([
      apiV1.getBotSettings(selectedBotId).catch(() => null),
      apiV1.getBotCommands(selectedBotId).catch(() => ({ commands: [] })),
    ]).then(([settingsRes, cmdRes]) => {
      if (!active) return;
      if (settingsRes?.settings) {
        const s = settingsRes.settings;
        setSettings({
          visibilityPolicy: String(s.visibilityPolicy || "private"),
          proactiveEnabled: Boolean(s.proactiveEnabled),
          triggerPolicy: String(s.triggerPolicy || "mention-or-command"),
          allowedMemberIds: Array.isArray(s.allowedMemberIds)
            ? s.allowedMemberIds.map(String)
            : [],
        });
      }
      setCommands(cmdRes.commands || []);
    });
    return () => {
      active = false;
    };
  }, [selectedBotId]);

  const activeBot = bots.find((b) => b.id === selectedBotId);

  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setErrorMessage("");
    try {
      const res = await apiV1.createBot(newName.trim());
      setNewName("");
      await loadBots();
      if (res.botId) setSelectedBotId(String(res.botId));
      setStatusMessage("新机器人已创建");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "创建失败");
    }
  };

  const patchSettings = async (patch: Record<string, unknown>) => {
    if (!selectedBotId) return;
    setErrorMessage("");
    try {
      await apiV1.updateBotSettings(selectedBotId, patch);
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
          ? "Token 已安全轮换（仅展示一次明文，请立即复制保存）"
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
      setStatusMessage("Outbound Webhook 已保存（HMAC-SHA256 签名投递）");
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
      await apiV1.putBotCommands(selectedBotId, next);
      setCommands(next);
      setCmdName("");
      setCmdDesc("");
      setStatusMessage("Slash 指令已注册");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "指令注册失败");
    }
  };

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

      {/* Multi-Bot Create */}
      <form onSubmit={handleCreateBot} className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="输入新机器人名称（支持一人创建多个 Bot）"
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
              onClick={() => setSelectedBotId(bot.id)}
            >
              🤖 {bot.name}
            </Button>
          ))}
        </div>
      )}

      {activeBot && (
        <div className="space-y-4 rounded-2xl border border-dl-border-hairline p-4">
          {/* Privacy Mode & Proactive Push */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-dl-text-primary">Telegram 群组隐私模式</div>
              <div className="text-[11px] text-dl-text-tertiary">
                开启时仅接收 `@提及` 与 `/指令`；关闭后接收所在群组全部消息
              </div>
            </div>
            <Switch
              checked={settings.triggerPolicy !== "all-messages"}
              onCheckedChange={(privacyOn) =>
                void patchSettings({
                  triggerPolicy: privacyOn ? "mention-or-command" : "all-messages",
                })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-dl-text-primary">允许主动推送消息/卡片</div>
              <div className="text-[11px] text-dl-text-tertiary">
                允许不依赖回复触发上下文主动投递通知与 Card Kit 卡片
              </div>
            </div>
            <Switch
              checked={settings.proactiveEnabled}
              onCheckedChange={(checked) => void patchSettings({ proactiveEnabled: checked })}
            />
          </div>

          {/* Visibility Policy + Visual Member Selector (no raw IDs!) */}
          <div className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="text-xs font-semibold text-dl-text-primary">可见性与成员授权</div>
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

          {/* Scopes & Token Issuance */}
          <div className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="text-xs font-semibold text-dl-text-primary">Token 细粒度权限范围</div>
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
                variant="primary"
                onClick={() => void handleIssueOrRotateToken(false)}
              >
                签发新 Token
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
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
              <Switch checked={webhookEnabled} onCheckedChange={setWebhookEnabled} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://agent.example.com/webhook"
              />
              <Input
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="签名密钥（至少 16 位）"
              />
            </div>
            <Button type="submit" size="sm" variant="secondary">
              保存 Webhook
            </Button>
          </form>

          {/* Slash Commands */}
          <form
            onSubmit={handleAddCommand}
            className="space-y-2 border-t border-dl-border-hairline pt-3"
          >
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
            <div className="grid grid-cols-3 gap-2">
              <Input
                value={cmdName}
                onChange={(e) => setCmdName(e.target.value)}
                placeholder="/summarize"
              />
              <Input
                value={cmdDesc}
                onChange={(e) => setCmdDesc(e.target.value)}
                placeholder="总结当前线程"
              />
              <Button type="submit" size="sm" variant="secondary">
                注册指令
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
