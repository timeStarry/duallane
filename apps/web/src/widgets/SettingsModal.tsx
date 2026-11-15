import React, { useEffect, useState } from "react";
import {
  Bot,
  Building2,
  Check,
  Copy,
  Mail,
  Palette,
  Plus,
  QrCode,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Smile,
  User,
} from "lucide-react";
import {
  ACCENT_IDS,
  DESIGN_TOKENS,
  type AccentId,
  type ThemePreference,
} from "@duallane/design-tokens";
import type { UserDeviceSummary } from "@duallane/protocol";
import { useLaneStore, type SettingsTab } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1, type QRSessionResponse } from "@/shared/lib/api-v1";
import { useThemeStore, type TransparencyMode } from "@/shared/theme/vibrancy";
import {
  BrandLogo,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
  Switch,
} from "@/shared/ui";
import { BotSettingsPanel } from "@/widgets/BotSettingsPanel";
import { EmoteStudioPanel } from "@/widgets/EmoteSystem";
import { cn } from "@/shared/lib/cn";

const TABS: Array<{ id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }> = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "profile", label: "个人", icon: User },
  { id: "emotes", label: "表情", icon: Smile },
  { id: "devices", label: "设备", icon: Smartphone },
  { id: "qr", label: "扫码", icon: QrCode },
  { id: "bots", label: "机器人", icon: Bot },
];

export function SettingsModal() {
  const {
    settingsOpen,
    closeSettings,
    settingsTab,
    setSettingsTab,
    setActiveLane,
    openAdminConsole,
  } = useLaneStore();
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
  const {
    isPreviewMode,
    authStatus,
    currentUser,
    boundEmail,
    setBoundEmailLocal,
    logout,
  } = useWorkspaceStore();

  const isAuthenticated =
    isPreviewMode || (authStatus === "authenticated" && Boolean(currentUser));
  const visibleTabs = isAuthenticated
    ? TABS
    : TABS.filter((tab) => tab.id === "appearance" || tab.id === "profile");

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

  // Bound Login Email state
  const [editingBoundEmail, setEditingBoundEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [emailCodeInput, setEmailCodeInput] = useState("");
  const [bindChallengeId, setBindChallengeId] = useState("");
  const [emailMaskedTarget, setEmailMaskedTarget] = useState("");
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [emailBusy, setEmailBusy] = useState<"" | "send" | "verify" | "unbind">("");
  const [emailError, setEmailError] = useState("");
  const [emailFeedback, setEmailFeedback] = useState("");

  useEffect(() => {
    if (emailCooldown <= 0) return;
    const timer = setTimeout(() => {
      setEmailCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [emailCooldown]);

  const handleSendBindCode = async () => {
    const trimmed = emailInput.trim();
    if (!trimmed) {
      setEmailError("请输入邮箱地址");
      return;
    }
    setEmailError("");
    setEmailFeedback("");
    setEmailBusy("send");
    try {
      if (isPreviewMode) {
        setBindChallengeId("ech_preview_1");
        setEmailMaskedTarget(trimmed);
        setEmailCooldown(60);
        setEmailFeedback(`验证码已发送至 ${trimmed}`);
        return;
      }
      const res = await apiV1.sendBindEmailCode(trimmed);
      setBindChallengeId(res.challengeId);
      setEmailMaskedTarget(res.maskedEmail);
      setEmailCooldown(60);
      setEmailFeedback(`验证码已发送至 ${res.maskedEmail}`);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "发送验证码失败");
    } finally {
      setEmailBusy("");
    }
  };

  const handleVerifyBindCode = async () => {
    const code = emailCodeInput.trim();
    if (!bindChallengeId) {
      setEmailError("请先获取验证码");
      return;
    }
    if (code.length !== 6) {
      setEmailError("请输入 6 位数字验证码");
      return;
    }
    setEmailError("");
    setEmailFeedback("");
    setEmailBusy("verify");
    try {
      if (isPreviewMode) {
        setBoundEmailLocal(emailInput.trim());
        setEditingBoundEmail(false);
        setBindChallengeId("");
        setEmailCodeInput("");
        setEmailFeedback("登录邮箱已绑定");
        return;
      }
      const res = await apiV1.verifyBindEmail(bindChallengeId, code);
      setBoundEmailLocal(res.email || emailInput.trim());
      setEditingBoundEmail(false);
      setBindChallengeId("");
      setEmailCodeInput("");
      setEmailInput("");
      setEmailFeedback("登录邮箱已绑定");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "验证码校验失败");
    } finally {
      setEmailBusy("");
    }
  };

  const handleUnbindEmail = async () => {
    setEmailError("");
    setEmailFeedback("");
    setEmailBusy("unbind");
    try {
      if (!isPreviewMode) {
        await apiV1.unbindAccountEmail();
      }
      setBoundEmailLocal("");
      setEditingBoundEmail(false);
      setBindChallengeId("");
      setEmailCodeInput("");
      setEmailFeedback("已解除登录邮箱绑定");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "解除绑定失败");
    } finally {
      setEmailBusy("");
    }
  };

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
    if (!isAuthenticated && settingsTab !== "appearance" && settingsTab !== "profile") {
      setSettingsTab("profile");
    }
  }, [isAuthenticated, settingsTab, setSettingsTab]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "devices" || isPreviewMode || !isAuthenticated) return;
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
  }, [isAuthenticated, isPreviewMode, settingsOpen, settingsTab]);

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
          <DialogTitle className="flex items-center gap-2.5">
            <BrandLogo size={24} withTile />
            <span className="tracking-[-0.025em]">设置</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            外观、个人身份、设备与机器人设置
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-compact:flex-col gap-4 min-h-[300px] max-h-[72vh] p-6 max-narrow:p-3.5 pt-4">
          <nav
            aria-label="设置分类"
            className="w-36 max-compact:w-full shrink-0 max-compact:flex max-compact:flex-wrap max-compact:overflow-x-auto space-y-1 max-compact:space-y-0 max-compact:gap-1 border-r max-compact:border-r-0 max-compact:border-b border-dl-border-hairline pr-3 max-compact:pr-0 max-compact:pb-2.5"
          >
            {visibleTabs.map((tab) => {
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
                      { value: "light", label: "浅色" },
                      { value: "dark", label: "深色" },
                    ]}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-dl-text-primary">主题色</div>
                  <SegmentedControl
                    label="主题色"
                    value={accent}
                    onValueChange={(v) => setAccent(v as AccentId)}
                    options={ACCENT_IDS.map((id) => ({
                      value: id,
                      label: DESIGN_TOKENS.accents[id].label,
                      icon: (
                        <span
                          data-testid={`theme-swatch-${id}`}
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-full ring-1 ring-black/15"
                          style={{ backgroundColor: DESIGN_TOKENS.accents[id].swatch }}
                        />
                      ),
                    }))}
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-dl-text-primary">材质通透度</div>
                  <SegmentedControl
                    label="材质通透度"
                    value={transparency}
                    onValueChange={(v) => setTransparency(v as TransparencyMode)}
                    options={[
                      { value: "glass", label: "毛玻璃" },
                      { value: "solid", label: "纯色" },
                    ]}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="text-sm font-semibold text-dl-text-primary">减弱动态效果</div>
                  <Switch
                    label="减弱动态效果"
                    checked={reducedMotion}
                    onCheckedChange={setReducedMotion}
                  />
                </div>
              </div>
            )}

            {settingsTab === "profile" &&
              (isAuthenticated && currentUser ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-1">
                    <div className="text-sm font-semibold text-dl-text-primary">
                      {currentUser.displayName || "当前成员"}
                    </div>
                    <div className="text-xs text-dl-text-tertiary">
                      {currentUser.handle ? `@${currentUser.handle} · ` : ""}
                      {currentUser.role === "owner"
                        ? "空间所有者"
                        : currentUser.role === "admin"
                        ? "空间管理员"
                        : "空间成员"}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-dl-text-primary">
                          <Mail className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                          <span>登录邮箱</span>
                        </div>
                        <div className="text-xs text-dl-text-tertiary">
                          绑定后可使用邮箱验证码快捷登录双端（GitHub 仍为主账号凭证）
                        </div>
                      </div>
                      {boundEmail && !editingBoundEmail && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setEditingBoundEmail(true);
                              setEmailInput("");
                              setEmailCodeInput("");
                              setBindChallengeId("");
                              setEmailError("");
                              setEmailFeedback("");
                            }}
                          >
                            更换
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={emailBusy === "unbind"}
                            disabled={Boolean(emailBusy)}
                            onClick={() => void handleUnbindEmail()}
                          >
                            解绑
                          </Button>
                        </div>
                      )}
                    </div>

                    {boundEmail && !editingBoundEmail ? (
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle px-3 py-2">
                        <span className="text-xs font-mono font-medium text-dl-text-primary break-all">
                          {boundEmail}
                        </span>
                        <span className="shrink-0 rounded-full bg-dl-success/12 px-2 py-0.5 text-[11px] font-medium text-dl-success">
                          已绑定
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex max-narrow:flex-col gap-2">
                          <Input
                            type="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            placeholder="name@example.com"
                            aria-label="绑定登录邮箱"
                            className="flex-1"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            busy={emailBusy === "send"}
                            disabled={Boolean(emailBusy) || emailCooldown > 0}
                            className="shrink-0"
                            onClick={() => void handleSendBindCode()}
                          >
                            {emailCooldown > 0 ? `${emailCooldown}s 后重发` : "获取验证码"}
                          </Button>
                        </div>

                        {bindChallengeId && (
                          <div className="flex max-narrow:flex-col gap-2">
                            <Input
                              value={emailCodeInput}
                              onChange={(e) =>
                                setEmailCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))
                              }
                              inputMode="numeric"
                              maxLength={6}
                              placeholder="6 位数字验证码"
                              aria-label="邮箱绑定验证码"
                              className="flex-1 font-mono tracking-[0.2em]"
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              busy={emailBusy === "verify"}
                              disabled={Boolean(emailBusy) || emailCodeInput.trim().length !== 6}
                              className="shrink-0"
                              onClick={() => void handleVerifyBindCode()}
                            >
                              确认绑定
                            </Button>
                          </div>
                        )}

                        {editingBoundEmail && (
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingBoundEmail(false);
                                setBindChallengeId("");
                                setEmailCodeInput("");
                                setEmailError("");
                              }}
                            >
                              取消更换
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {emailError && <div className="text-xs text-dl-danger">{emailError}</div>}
                    {emailFeedback && !emailError && (
                      <div className="text-xs text-dl-text-secondary">
                        {emailFeedback}
                        {emailMaskedTarget && bindChallengeId ? " · 10 分钟内有效" : ""}
                      </div>
                    )}
                  </div>

                  {canManageInvites && (
                    <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-dl-text-primary">
                          空间成员邀请码
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5 shrink-0"
                            onClick={() => {
                              closeSettings();
                              openAdminConsole("invites");
                            }}
                          >
                            <SlidersHorizontal className="size-3.5" strokeWidth={1.9} />
                            打开空间治理台
                          </Button>
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
                      </div>

                      {inviteError && (
                        <div className="text-xs text-dl-danger">{inviteError}</div>
                      )}

                      {generatedInviteCode && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-dl-surface-subtle p-2.5">
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
              ) : (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-dl-border-hairline p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-dl-lane-direct/15 text-dl-lane-direct">
                        <ShieldCheck className="size-4" strokeWidth={1.9} />
                      </span>
                      <div>
                        <div className="text-sm font-semibold text-dl-text-primary">
                          免登录访客
                        </div>
                        <div className="text-xs text-dl-text-tertiary">
                          未绑定共享空间账号
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        closeSettings();
                        setActiveLane("workspace");
                      }}
                    >
                      <Building2 className="size-3.5" strokeWidth={1.85} />
                      前往登录共享空间
                    </Button>
                  </div>
                </div>
              ))}

            {isAuthenticated && settingsTab === "devices" && (
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

            {isAuthenticated && settingsTab === "qr" && (
              <div className="space-y-4">
                <div className="text-sm font-semibold text-dl-text-primary">移动端扫码登录</div>
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

            {isAuthenticated && settingsTab === "emotes" && <EmoteStudioPanel />}

            {isAuthenticated && settingsTab === "bots" && <BotSettingsPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
