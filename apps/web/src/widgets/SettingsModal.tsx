import React, { useEffect, useState } from "react";
import { Bot, Check, Copy, Palette, Plus, QrCode, Smartphone, User } from "lucide-react";
import type { AccentId, ThemePreference } from "@duallane/design-tokens";
import type { UserDeviceSummary } from "@duallane/protocol";
import { useLaneStore, type SettingsTab } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type QRSessionResponse } from "@/shared/lib/api-v1";
import { useThemeStore, type TransparencyMode } from "@/shared/theme/vibrancy";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SegmentedControl,
  Switch,
} from "@/shared/ui";
import { BotSettingsPanel } from "@/widgets/BotSettingsPanel";
import { cn } from "@/shared/lib/cn";

const TABS: Array<{ id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }> = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "profile", label: "个人", icon: User },
  { id: "devices", label: "设备", icon: Smartphone },
  { id: "qr", label: "扫码", icon: QrCode },
  { id: "bots", label: "机器人", icon: Bot },
];

const ACCENTS: Array<{ id: AccentId; label: string }> = [
  { id: "azure", label: "湛蓝" },
  { id: "indigo", label: "靛青" },
  { id: "emerald", label: "翡翠" },
  { id: "copper", label: "赤铜" },
  { id: "graphite", label: "石墨" },
];

export function SettingsModal() {
  const { settingsOpen, closeSettings, settingsTab, setSettingsTab } = useLaneStore();
  const {
    preference,
    accent,
    transparency,
    reducedMotion,
    setPreference,
    setAccent,
    setTransparency,
    setReducedMotion,
  } = useThemeStore();
  const { isPreviewMode, currentUser, logout } = useWorkspaceStore();

  const [devices, setDevices] = useState<UserDeviceSummary[]>(() =>
    isPreviewMode
      ? [
          {
            id: "dev_mac_1",
            platform: "web",
            deviceName: "MacBook Pro · Safari / Chrome",
            appVersion: "1.0.0",
            lastActiveAt: new Date().toISOString(),
            current: true,
          },
          {
            id: "dev_ios_1",
            platform: "ios",
            deviceName: "iPhone 16 Pro · DualLane Mobile",
            appVersion: "1.0.0",
            lastActiveAt: new Date(Date.now() - 180_000).toISOString(),
            current: false,
          },
        ]
      : []
  );
  const [qrSession, setQrSession] = useState<QRSessionResponse | null>(null);
  const [qrApproved, setQrApproved] = useState(false);
  const [generatedInviteCode, setGeneratedInviteCode] = useState<string>("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string>("");

  const canManageInvites =
    isPreviewMode || currentUser?.role === "owner" || currentUser?.role === "admin";

  const handleCreateInvite = async () => {
    setInviteError("");
    setCreatingInvite(true);
    try {
      if (isPreviewMode) {
        setGeneratedInviteCode(`DL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
        return;
      }
      const res = await apiV1.createInvite({ defaultRole: "member", maxUses: 10, expiresInHours: 72 });
      const code = res.invite?.code || res.code || "";
      if (code) {
        setGeneratedInviteCode(code);
      }
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "生成邀请码失败");
    } finally {
      setCreatingInvite(false);
    }
  };

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "devices" || isPreviewMode) return;
    let active = true;
    void apiV1
      .listDevices()
      .then((res) => {
        if (active) setDevices(res.devices || []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isPreviewMode, settingsOpen, settingsTab]);

  const handleGenerateQR = async () => {
    setQrApproved(false);
    if (isPreviewMode) {
      setQrSession({
        id: `qrs_${crypto.randomUUID().slice(0, 10)}`,
        challenge: crypto.randomUUID().replace(/-/g, ""),
        status: "pending",
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      });
      return;
    }
    const res = await apiV1.startQRLogin("ios", "DualLane Mobile");
    setQrSession(res);
  };

  const handleApproveQR = async () => {
    if (!qrSession) return;
    if (!isPreviewMode) {
      await apiV1.approveQRLogin(qrSession.id);
    }
    setQrApproved(true);
  };

  const qrUri = qrSession
    ? `duallane://qr-login?sessionId=${encodeURIComponent(qrSession.id)}&challenge=${encodeURIComponent(qrSession.challenge)}`
    : "";

  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>DualLane 设置中心</DialogTitle>
        </DialogHeader>
        <div className="flex max-compact:flex-col gap-4 min-h-[380px] max-h-[72vh] p-6 pt-4">
          <nav className="w-36 max-compact:w-full shrink-0 max-compact:flex max-compact:overflow-x-auto space-y-1 max-compact:space-y-0 max-compact:gap-1 border-r max-compact:border-r-0 max-compact:border-b border-dl-border-hairline pr-3 max-compact:pr-0 max-compact:pb-2.5">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  variant={settingsTab === tab.id ? "primary" : "ghost"}
                  size="sm"
                  className="w-full max-compact:w-auto justify-start gap-2"
                  onClick={() => setSettingsTab(tab.id)}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.85} />
                  {tab.label}
                </Button>
              );
            })}
          </nav>

          <div className="dl-scroll flex-1 min-w-0 overflow-y-auto pr-1">
            {settingsTab === "appearance" && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-dl-text-primary">明暗模式</div>
                  <SegmentedControl
                    label="明暗模式"
                    value={preference}
                    onValueChange={(v) => setPreference(v as ThemePreference)}
                    options={[
                      { value: "system", label: "跟随系统" },
                      { value: "light", label: "浅色玻璃" },
                      { value: "dark", label: "深色玻璃" },
                    ]}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-dl-text-primary">主题强调色</div>
                  <SegmentedControl
                    label="主题强调色"
                    value={accent}
                    onValueChange={(v) => setAccent(v as AccentId)}
                    options={ACCENTS.map((a) => ({ value: a.id, label: a.label }))}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-dl-text-primary">材质通透度</div>
                  <SegmentedControl
                    label="材质通透度"
                    value={transparency}
                    onValueChange={(v) => setTransparency(v as TransparencyMode)}
                    options={[
                      { value: "glass", label: "Vibrancy 毛玻璃" },
                      { value: "solid", label: "纯色高对比" },
                    ]}
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div>
                    <div className="text-sm font-semibold text-dl-text-primary">减弱动态效果</div>
                    <div className="text-xs text-dl-text-tertiary">关闭弹性过渡动画以降低视觉干扰</div>
                  </div>
                  <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} />
                </div>
              </div>
            )}

            {settingsTab === "profile" && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-1">
                  <div className="text-sm font-semibold text-dl-text-primary">
                    {currentUser?.displayName || "当前成员"}
                  </div>
                  <div className="text-xs text-dl-text-tertiary">
                    ID: {currentUser?.id} · 角色: {currentUser?.role}
                  </div>
                </div>

                {canManageInvites && (
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-dl-text-primary">
                          空间成员邀请码
                        </div>
                        <div className="text-xs text-dl-text-tertiary mt-0.5">
                          生成一次性或多用途邀请链接，供新成员加入共享空间
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={creatingInvite}
                        className="gap-1.5 shrink-0"
                        onClick={() => void handleCreateInvite()}
                      >
                        <Plus className="size-3.5" strokeWidth={2} />
                        生成邀请码
                      </Button>
                    </div>

                    {inviteError && (
                      <div className="text-xs text-dl-danger">{inviteError}</div>
                    )}

                    {generatedInviteCode && (
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle p-2.5">
                        <code
                          data-testid="generated-invite-code"
                          className="text-xs font-mono font-semibold text-dl-text-primary select-all break-all"
                        >
                          {generatedInviteCode}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 shrink-0 text-xs"
                          onClick={() => {
                            const url = `${window.location.origin}/?invite=${encodeURIComponent(generatedInviteCode)}`;
                            void navigator.clipboard?.writeText(url);
                            setCopiedInvite(true);
                            setTimeout(() => setCopiedInvite(false), 1800);
                          }}
                        >
                          {copiedInvite ? (
                            <>
                              <Check className="size-3.5 text-dl-success" strokeWidth={2} />
                              已复制邀请链接
                            </>
                          ) : (
                            <>
                              <Copy className="size-3.5" strokeWidth={1.8} />
                              复制邀请链接
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <Button variant="danger" size="sm" onClick={() => void logout()}>
                  退出登录
                </Button>
              </div>
            )}

            {settingsTab === "devices" && (
              <div className="space-y-3">
                <div className="text-sm font-semibold text-dl-text-primary">活跃设备与会话</div>
                {devices.length === 0 ? (
                  <div className="text-xs text-dl-text-tertiary">暂无已登记的移动端或桌面设备</div>
                ) : (
                  devices.map((dev) => (
                    <div
                      key={dev.id}
                      className={cn(
                        "flex items-center justify-between rounded-xl border border-dl-border-hairline p-3",
                        dev.current && "border-dl-lane-shared/40 bg-dl-lane-shared/5"
                      )}
                    >
                      <div>
                        <div className="text-xs font-semibold text-dl-text-primary">
                          {dev.deviceName} ({dev.platform})
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">
                          v{dev.appVersion} · 最近活跃 {new Date(dev.lastActiveAt).toLocaleString()}
                        </div>
                      </div>
                      {!dev.current && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() =>
                            void apiV1
                              .revokeDevice(dev.id)
                              .then(() => setDevices((prev) => prev.filter((d) => d.id !== dev.id)))
                          }
                        >
                          下线
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {settingsTab === "qr" && (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-semibold text-dl-text-primary">移动端扫码登录</div>
                  <div className="text-xs text-dl-text-tertiary mt-0.5">
                    为新版 DualLane Mobile 生成一次性会话载荷并在当前 Web 会话确认授权
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => void handleGenerateQR()}>
                  生成新扫码会话
                </Button>
                {qrSession && (
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-2">
                    <div className="text-xs font-mono break-all text-dl-text-primary bg-dl-surface-subtle p-2.5 rounded-xl">
                      {qrUri}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-dl-text-tertiary">
                        有效期至 {new Date(qrSession.expiresAt).toLocaleTimeString()}
                      </span>
                      <Button
                        size="sm"
                        variant={qrApproved ? "secondary" : "primary"}
                        disabled={qrApproved}
                        onClick={() => void handleApproveQR()}
                      >
                        {qrApproved ? "✓ 已授权移动端登录" : "授权此扫码会话"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {settingsTab === "bots" && <BotSettingsPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
