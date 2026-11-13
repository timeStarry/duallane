import React, { useEffect, useState } from "react";
import type { UserDeviceSummary } from "@duallane/protocol";
import { useLaneStore, type SettingsTab, type ThemeMode } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type QRStartResponse } from "@/shared/lib/api-v1";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, SegmentedControl } from "@/shared/ui";
import { BotSettingsPanel } from "@/widgets/BotSettingsPanel";
import { cn } from "@/shared/lib/cn";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "profile", label: "个人" },
  { id: "devices", label: "设备" },
  { id: "qr", label: "扫码" },
  { id: "bots", label: "机器人" },
];

export function SettingsModal() {
  const { settingsOpen, closeSettings, settingsTab, setSettingsTab, themeMode, setThemeMode } =
    useLaneStore();
  const { currentUser, logout } = useWorkspaceStore();

  const [devices, setDevices] = useState<UserDeviceSummary[]>([]);
  const [qrSession, setQrSession] = useState<QRStartResponse | null>(null);
  const [qrApproved, setQrApproved] = useState(false);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "devices") return;
    void apiV1
      .listDevices()
      .then((res) => setDevices(res.devices || []))
      .catch(() => {});
  }, [settingsOpen, settingsTab]);

  const handleGenerateQR = async () => {
    setQrApproved(false);
    const res = await apiV1.startQRLogin();
    setQrSession(res);
  };

  const handleApproveQR = async () => {
    if (!qrSession) return;
    await apiV1.approveQRLogin(qrSession.sessionId);
    setQrApproved(true);
  };

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
        <div className="flex gap-4 min-h-[380px] p-6 pt-4">
        <nav className="w-32 shrink-0 space-y-1 border-r border-dl-border-hairline pr-3">
          {TABS.map((tab) => (
            <Button
              key={tab.id}
              variant={settingsTab === tab.id ? "primary" : "ghost"}
              size="sm"
              className="w-full justify-start"
              onClick={() => setSettingsTab(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto pr-1">
          {settingsTab === "appearance" && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold text-dl-text-primary">主题与毛玻璃质感</div>
                <div className="text-xs text-dl-text-tertiary mt-0.5">
                  遵循系统或手动切换浅色 / 深色 Vibrancy Glass 外观
                </div>
              </div>
              <SegmentedControl
                label="主题与毛玻璃质感"
                value={themeMode}
                onValueChange={(v) => setThemeMode(v as ThemeMode)}
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色玻璃" },
                  { value: "dark", label: "深色玻璃" },
                ]}
              />
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
                  为新版 DualLane Mobile 生成一次性会话二维码并在 Web 端授权确认
                </div>
              </div>
              <Button size="sm" variant="primary" onClick={() => void handleGenerateQR()}>
                生成新扫码会话
              </Button>
              {qrSession && (
                <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-2">
                  <div className="text-xs font-mono break-all text-dl-text-primary bg-dl-surface-subtle p-2.5 rounded-xl">
                    {qrSession.qrPayload}
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
