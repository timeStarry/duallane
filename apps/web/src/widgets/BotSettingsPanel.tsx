import React, { useCallback, useEffect, useState } from "react";
import { apiV1, type BotCommandSpec } from "@/shared/lib/api-v1";
import { Button, Input, Switch } from "@/shared/ui";

interface BotItem {
  id: string;
  displayName: string;
  handle: string;
  proactiveEnabled?: boolean;
  privacyMode?: boolean;
}

const ALL_SCOPES = [
  { id: "messages:send", label: "发送消息" },
  { id: "cards:send", label: "发送交互卡片" },
  { id: "cards:update", label: "更新卡片状态" },
  { id: "context:read", label: "读取触发上下文" },
];

export function BotSettingsPanel() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newHandle, setNewHandle] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["messages:send", "cards:send"]);
  const [issuedToken, setIssuedToken] = useState<string>("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [commands, setCommands] = useState<BotCommandSpec[]>([]);
  const [cmdName, setCmdName] = useState("");
  const [cmdDesc, setCmdDesc] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const loadBots = useCallback(async () => {
    try {
      const res = await apiV1.listBots();
      const list = Array.isArray(res.bots) ? (res.bots as BotItem[]) : [];
      setBots(list);
      setSelectedBotId((prev) => prev || list[0]?.id || "");
    } catch {
      // Ignore if not owner/admin
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
    void apiV1
      .getBotCommands(selectedBotId)
      .then((res) => setCommands(res.commands || []))
      .catch(() => {});
  }, [selectedBotId]);

  const activeBot = bots.find((b) => b.id === selectedBotId);

  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newHandle.trim()) return;
    await apiV1.createBot(newName.trim(), newHandle.trim());
    setNewName("");
    setNewHandle("");
    await loadBots();
    setStatusMessage("机器人已创建");
  };

  const handleIssueToken = async () => {
    if (!selectedBotId) return;
    const res = await apiV1.issueBotToken(selectedBotId, selectedScopes);
    const token = String(res.token || (res.raw as string) || "");
    setIssuedToken(token);
    setStatusMessage("新 Token 已签发，旧 Token 保留 24 小时宽限期。");
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBotId) return;
    await apiV1.putBotWebhook(selectedBotId, webhookUrl, webhookSecret, webhookEnabled);
    setStatusMessage("Webhook 配置已保存（HMAC-SHA256 签名投递）");
  };

  const handleAddCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBotId || !cmdName.trim()) return;
    const next = [...commands, { command: cmdName.trim(), description: cmdDesc.trim() || "自定义指令" }];
    const res = await apiV1.putBotCommands(selectedBotId, next);
    setCommands(res.commands || next);
    setCmdName("");
    setCmdDesc("");
    setStatusMessage("指令菜单已更新");
  };

  return (
    <div className="space-y-5">
      {statusMessage && (
        <div className="rounded-xl bg-dl-lane-shared/10 px-3 py-2 text-xs text-dl-lane-shared border border-dl-lane-shared/25">
          {statusMessage}
        </div>
      )}

      {/* Create Bot */}
      <form onSubmit={handleCreateBot} className="grid grid-cols-3 gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="机器人名称"
        />
        <Input
          value={newHandle}
          onChange={(e) => setNewHandle(e.target.value)}
          placeholder="@handle"
        />
        <Button type="submit" variant="primary" size="sm">
          创建机器人
        </Button>
      </form>

      {/* Bot List */}
      {bots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {bots.map((bot) => (
            <Button
              key={bot.id}
              size="sm"
              variant={bot.id === selectedBotId ? "primary" : "secondary"}
              onClick={() => setSelectedBotId(bot.id)}
            >
              🤖 {bot.displayName} (@{bot.handle})
            </Button>
          ))}
        </div>
      )}

      {activeBot && (
        <div className="space-y-4 rounded-2xl border border-dl-border-hairline p-3.5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-dl-text-primary">Telegram 隐私模式</div>
              <div className="text-[11px] text-dl-text-tertiary">
                开启后在群组仅接收 @提及 与 `/` 指令消息
              </div>
            </div>
            <Switch
              checked={activeBot.privacyMode !== false}
              onCheckedChange={(checked) =>
                void apiV1.updateBotSettings(activeBot.id, { privacyMode: checked }).then(loadBots)
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-dl-text-primary">主动推送权限</div>
              <div className="text-[11px] text-dl-text-tertiary">
                允许机器人不依赖回复上下文主动发送通知卡片
              </div>
            </div>
            <Switch
              checked={Boolean(activeBot.proactiveEnabled)}
              onCheckedChange={(checked) =>
                void apiV1
                  .updateBotSettings(activeBot.id, { proactiveEnabled: checked })
                  .then(loadBots)
              }
            />
          </div>

          {/* Scopes & Token */}
          <div className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="text-xs font-semibold text-dl-text-primary">Token 权限范围与签发</div>
            <div className="flex flex-wrap gap-2">
              {ALL_SCOPES.map((s) => {
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
            <Button type="button" size="sm" variant="secondary" onClick={() => void handleIssueToken()}>
              签发 / 轮换 Bot Token
            </Button>
            {issuedToken && (
              <div className="rounded-xl bg-dl-surface-subtle p-2 text-xs font-mono break-all select-all">
                {issuedToken}
              </div>
            )}
          </div>

          {/* Outbound Webhook */}
          <form onSubmit={handleSaveWebhook} className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-dl-text-primary">Outbound Webhook (HMAC)</span>
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
                placeholder="Signing Secret"
              />
            </div>
            <Button type="submit" size="sm" variant="secondary">
              保存 Webhook
            </Button>
          </form>

          {/* Slash Commands */}
          <form onSubmit={handleAddCommand} className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="text-xs font-semibold text-dl-text-primary">
              Slash 指令注册 ({commands.length})
            </div>
            <div className="space-y-1">
              {commands.map((cmd, i) => (
                <div key={i} className="flex items-center justify-between text-xs px-2 py-1 rounded-lg bg-dl-surface-subtle/60">
                  <span className="font-mono text-dl-lane-shared">{cmd.command}</span>
                  <span className="text-dl-text-secondary">{cmd.description}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input
                value={cmdName}
                onChange={(e) => setCmdName(e.target.value)}
                placeholder="/summarize"
              />
              <Input
                value={cmdDesc}
                onChange={(e) => setCmdDesc(e.target.value)}
                placeholder="指令说明"
              />
              <Button type="submit" size="sm" variant="secondary">
                添加指令
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
