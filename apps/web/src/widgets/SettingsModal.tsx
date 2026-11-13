import React, { useEffect, useState } from "react";
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

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "profile", label: "个人" },
  { id: "devices", label: "设备" },
  { id: "qr", label: "扫码" },
  { id: "bots", label: "机器人" },
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
  const { currentUser, logout } = useWorkspaceStore();

  const [devices, setDevices] = useState<UserDeviceSummary[]>([]);
  const [qrSession, setQrSession] = useState<QRSessionResponse | null>(null);
  const [qrApproved, setQrApproved] = useState(false);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "devices") return;
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
  }, [settingsOpen, settingsTab]);

  const handleGenerateQR = async () => {
    setQrApproved(false);
    const res = await apiV1.startQRLogin("ios", "DualLane Mobile");
    setQrSession(res);
  };

  const handleApproveQR = async () => {
    if (!qrSession) return;
    await apiV1.approveQRLogin(qrSession.id);
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
