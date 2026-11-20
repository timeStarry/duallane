import React, { useEffect, useRef, useState } from "react";
import {
  Bell,
  Bot,
  Building2,
  Camera,
  Check,
  Copy,
  EyeOff,
  Mail,
  Palette,
  Plus,
  QrCode,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Trash2,
  User,
} from "lucide-react";
import {
  ACCENT_IDS,
  DESIGN_TOKENS,
  type AccentId,
  type ThemePreference,
} from "@duallane/design-tokens";
import type { UserDeviceSummary } from "@duallane/protocol";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore, type SettingsTab } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  apiV1,
  type OfflineEmailNotificationsDTO,
  type QRSessionResponse,
} from "@/shared/lib/api-v1";
import {
  useDisplayPrefsStore,
  type DisplayPrefsScope,
} from "@/shared/lib/display-prefs";
import { useThemeStore, type TransparencyMode } from "@/shared/theme/vibrancy";
import {
  Avatar,
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

const TABS: Array<{
  id: SettingsTab;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}> = [
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
    userPreferences,
    setBoundEmailLocal,
    updateUserPreferences,
    updateMyProfile,
    uploadMyAvatar,
    deleteMyAvatar,
    logout,
  } = useWorkspaceStore();
  const {
    hydrated: emoteHydrated,
    settings: emoteSettings,
    loadEmoteState,
    updateSettingsPatch,
  } = useEmoteStore();
  const {
    collapseImagesByDefault,
    collapseStickersByDefault,
    collapseLongMessagesByDefault,
    displayPrefsScope,
    setScope: setDisplayPrefsScope,
    updateDisplayPref,
  } = useDisplayPrefsStore();

  const isAuthenticated =
    isPreviewMode || (authStatus === "authenticated" && Boolean(currentUser));
  const visibleTabs = isAuthenticated
    ? TABS
    : TABS.filter((tab) => tab.id === "appearance" || tab.id === "profile");

  useEffect(() => {
    if (settingsOpen && isAuthenticated && !emoteHydrated) {
      void loadEmoteState(isPreviewMode);
    }
  }, [emoteHydrated, isAuthenticated, isPreviewMode, loadEmoteState, settingsOpen]);

  // Profile Nickname & Avatar editing state (A2)
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [nicknameDraftByUser, setNicknameDraftByUser] = useState<Record<string, string>>({});
  const [profileBusy, setProfileBusy] = useState<"" | "nickname" | "avatar" | "deleteAvatar">("");
  const [profileError, setProfileError] = useState("");
  const [profileFeedback, setProfileFeedback] = useState("");

  const activeUserId = currentUser?.id || "";
  const baseNickname = currentUser?.nickname || currentUser?.displayName || "";
  const nicknameDraft = activeUserId
    ? nicknameDraftByUser[activeUserId] ?? baseNickname
    : "";

  const handleSaveNickname = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nicknameDraft.trim();
    if (!trimmed || !currentUser) return;
    setProfileError("");
    setProfileFeedback("");
    setProfileBusy("nickname");
    try {
      await updateMyProfile({ nickname: trimmed });
      setNicknameDraftByUser((prev) => {
        const next = { ...prev };
        delete next[currentUser.id];
        return next;
      });
      setProfileFeedback("个人昵称已保存");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "保存昵称失败");
    } finally {
      setProfileBusy("");
    }
  };

  const handleAvatarFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setProfileError("头像文件大小不能超过 10 MB");
      return;
    }
    setProfileError("");
    setProfileFeedback("");
    setProfileBusy("avatar");
    try {
      await uploadMyAvatar(file);
      setProfileFeedback("个人头像已更新");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "上传头像失败");
    } finally {
      setProfileBusy("");
    }
  };

  const handleRemoveAvatar = async () => {
    setProfileError("");
    setProfileFeedback("");
    setProfileBusy("deleteAvatar");
    try {
      await deleteMyAvatar();
      setProfileFeedback("已恢复默认头像");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "移除头像失败");
    } finally {
      setProfileBusy("");
    }
  };

  // Offline Email Notifications state (A4 — NO ntfy)
  const [emailNotifs, setEmailNotifs] = useState<OfflineEmailNotificationsDTO | null>(() =>
    isPreviewMode
      ? {
          enabled: true,
          immediateEnabled: true,
          digestEnabled: false,
        }
      : null
  );
  const [emailNotifsSaving, setEmailNotifsSaving] = useState(false);
  const [emailNotifsError, setEmailNotifsError] = useState("");
  const emailNotifsLoading =
    isAuthenticated && !isPreviewMode && emailNotifs === null && !emailNotifsError;

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "profile" || !isAuthenticated || isPreviewMode) {
      return;
    }
    let active = true;
    void apiV1
      .getMyNotifications()
      .then((res) => {
        if (active && res.notifications) {
          setEmailNotifs(res.notifications);
          setEmailNotifsError("");
        }
      })
      .catch((err) => {
        if (active) {
          setEmailNotifsError(err instanceof Error ? err.message : "加载邮件提醒设置失败");
        }
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, isPreviewMode, settingsOpen, settingsTab]);

  const handlePatchEmailNotifs = async (
    patch: Partial<
      Pick<OfflineEmailNotificationsDTO, "enabled" | "immediateEnabled" | "digestEnabled">
    >
  ) => {
    const base: OfflineEmailNotificationsDTO = emailNotifs || {
      enabled: false,
      immediateEnabled: true,
      digestEnabled: false,
    };
    const next: OfflineEmailNotificationsDTO = { ...base, ...patch };
    setEmailNotifs(next);
    setEmailNotifsError("");
    if (isPreviewMode) return;
    setEmailNotifsSaving(true);
    try {
      const res = await apiV1.updateMyNotifications({
        enabled: Boolean(next.enabled),
        immediateEnabled: Boolean(next.immediateEnabled),
        digestEnabled: Boolean(next.digestEnabled),
      });
      if (res.notifications) {
        setEmailNotifs(res.notifications);
      }
    } catch (err) {
      setEmailNotifs(base);
      setEmailNotifsError(err instanceof Error ? err.message : "保存离线邮件提醒失败");
    } finally {
      setEmailNotifsSaving(false);
    }
  };

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
      const res = await apiV1.createInvite({
        defaultRole: "member",
        maxUses: 10,
        expiresInHours: 72,
      });
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

  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (panelScrollRef.current) {
      panelScrollRef.current.scrollTop = 0;
    }
  }, [settingsTab]);

  const syncAccountPrefs = isAuthenticated
    ? (patch: Record<string, unknown>) => void updateUserPreferences(patch)
    : undefined;

  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent size="lg" className="p-0 overflow-hidden">
        <DialogHeader className="bg-dl-surface-subtle/35 shrink-0">
          <DialogTitle className="flex items-center gap-2.5">
            <BrandLogo size={24} withTile />
            <span className="tracking-[-0.025em]">设置</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            外观、阅读折叠、个人资料、通知、设备与机器人设置
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-compact:flex-col h-[min(580px,calc(86dvh-72px))] min-h-0">
          <nav
            aria-label="设置分类"
            className="w-44 max-compact:w-full shrink-0 border-r max-compact:border-r-0 max-compact:border-b border-dl-border-hairline bg-dl-surface-subtle/40 p-3.5 max-compact:p-2.5 flex flex-col max-compact:flex-row max-compact:flex-wrap gap-1 overflow-y-auto"
          >
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  variant={settingsTab === tab.id ? "primary" : "ghost"}
                  size="sm"
                  className="w-full max-compact:w-auto justify-start gap-2 shrink-0"
                  onClick={() => setSettingsTab(tab.id)}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.85} />
                  {tab.label}
                </Button>
              );
            })}
          </nav>

          <div
            ref={panelScrollRef}
            data-testid="settings-modal-scroll-pane"
            className="dl-scroll flex-1 min-w-0 min-h-0 overflow-y-auto p-6 max-compact:p-4 [scrollbar-gutter:stable]"
          >
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

                {/* Boss-Key / Auto-Hide Media & Long Messages (A1) */}
                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/35 p-4 space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-dl-text-primary">
                        <EyeOff className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                        <span>内容默认折叠（防窥 / 清爽阅读）</span>
                      </div>
                      <div className="text-xs text-dl-text-tertiary">
                        默认仅对当前浏览器生效，办公电脑折叠图片与贴纸不会影响私人手机
                      </div>
                    </div>
                    {isAuthenticated && (
                      <SegmentedControl
                        label="折叠设置生效范围"
                        value={displayPrefsScope}
                        onValueChange={(v) =>
                          setDisplayPrefsScope(
                            v as DisplayPrefsScope,
                            userPreferences,
                            syncAccountPrefs
                          )
                        }
                        options={[
                          { value: "device", label: "仅本机" },
                          { value: "account", label: "跟随账号" },
                        ]}
                      />
                    )}
                  </div>

                  <div className="space-y-2.5 border-t border-dl-border-hairline pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-dl-text-primary">
                          默认折叠聊天图片
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">
                          显示为「[图片 · 点击展开]」毛玻璃胶囊，按需点击查看
                        </div>
                      </div>
                      <Switch
                        label="默认折叠聊天图片"
                        checked={collapseImagesByDefault}
                        onCheckedChange={(checked) =>
                          updateDisplayPref({ collapseImagesByDefault: checked }, syncAccountPrefs)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-dl-text-primary">
                          默认折叠贴纸表情
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">
                          大号贴纸默认收起为「[贴纸 · 点击展开]」
                        </div>
                      </div>
                      <Switch
                        label="默认折叠贴纸表情"
                        checked={collapseStickersByDefault}
                        onCheckedChange={(checked) =>
                          updateDisplayPref(
                            { collapseStickersByDefault: checked },
                            syncAccountPrefs
                          )
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-dl-text-primary">
                          默认折叠超长消息
                        </div>
                        <div className="text-[11px] text-dl-text-tertiary">
                          超过 12 行或 600 字的消息仅预览前 6 行，支持行内展开全文
                        </div>
                      </div>
                      <Switch
                        label="默认折叠超长消息"
                        checked={collapseLongMessagesByDefault}
                        onCheckedChange={(checked) =>
                          updateDisplayPref(
                            { collapseLongMessagesByDefault: checked },
                            syncAccountPrefs
                          )
                        }
                      />
                    </div>

                    {isAuthenticated && (
                      <div className="flex items-center justify-between gap-3 border-t border-dl-border-hairline pt-2.5">
                        <div>
                          <div className="text-xs font-semibold text-dl-text-primary">
                            群聊回复消息时自动 @对方
                          </div>
                          <div className="text-[11px] text-dl-text-tertiary">
                            引用回复群友消息时自动前置 @提及，确保对方收到提醒
                          </div>
                        </div>
                        <Switch
                          label="群聊回复消息时自动 @对方"
                          checked={Boolean(emoteSettings.replyAutoMention)}
                          onCheckedChange={(checked) =>
                            void updateSettingsPatch({ replyAutoMention: checked }, isPreviewMode)
                          }
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {settingsTab === "profile" &&
              (isAuthenticated && currentUser ? (
                <div className="space-y-4">
                  {/* Profile Avatar & Nickname Editor (A2) */}
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="relative shrink-0">
                          <input
                            ref={avatarInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            aria-label="上传自定义头像"
                            className="sr-only"
                            onChange={(e) => void handleAvatarFileSelect(e)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={Boolean(profileBusy)}
                            aria-label="点击更换个人头像"
                            onClick={() => avatarInputRef.current?.click()}
                            className="group relative h-auto w-auto rounded-full p-0 hover:bg-transparent"
                          >
                            <Avatar
                              name={currentUser.displayName || "当前成员"}
                              src={currentUser.avatarUrl}
                              size="lg"
                            />
                            <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full border border-dl-border-hairline bg-surface text-dl-text-primary shadow-xs group-hover:text-dl-lane-shared">
                              <Camera className="size-3.5" strokeWidth={2} />
                            </span>
                          </Button>
                        </div>

                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-dl-text-primary">
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
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          busy={profileBusy === "avatar"}
                          disabled={Boolean(profileBusy)}
                          className="gap-1.5"
                          onClick={() => avatarInputRef.current?.click()}
                        >
                          <Camera className="size-3.5" strokeWidth={1.9} />
                          更换头像
                        </Button>
                        {currentUser.avatarUrl && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            busy={profileBusy === "deleteAvatar"}
                            disabled={Boolean(profileBusy)}
                            className="gap-1 text-dl-text-secondary hover:text-dl-danger"
                            onClick={() => void handleRemoveAvatar()}
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.85} />
                            移除
                          </Button>
                        )}
                      </div>
                    </div>

                    <form
                      onSubmit={(e) => void handleSaveNickname(e)}
                      className="space-y-1.5 border-t border-dl-border-hairline pt-3"
                    >
                      <label className="block text-xs font-semibold text-dl-text-secondary">
                        空间显示昵称
                      </label>
                      <div className="flex max-narrow:flex-col gap-2">
                        <Input
                          value={nicknameDraft}
                          onChange={(e) =>
                            setNicknameDraftByUser((prev) => ({
                              ...prev,
                              [currentUser.id]: e.target.value,
                            }))
                          }
                          placeholder="输入你的空间昵称"
                          aria-label="空间显示昵称"
                          maxLength={32}
                          className="flex-1"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          busy={profileBusy === "nickname"}
                          disabled={
                            Boolean(profileBusy) ||
                            !nicknameDraft.trim() ||
                            nicknameDraft.trim() === baseNickname
                          }
                          className="shrink-0"
                        >
                          保存昵称
                        </Button>
                      </div>
                    </form>

                    {profileError && <div className="text-xs text-dl-danger">{profileError}</div>}
                    {profileFeedback && !profileError && (
                      <div className="text-xs text-dl-success">{profileFeedback}</div>
                    )}
                  </div>

                  {/* Bound Login Email */}
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-dl-text-primary">
                          <Mail className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                          <span>登录邮箱</span>
                        </div>
                        <div className="text-xs text-dl-text-tertiary">
                          绑定地址优先用于验证码登录，未绑定时可使用通过 GitHub 登录同步的已验证主邮箱。
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

                  {/* Offline Email Notifications (A4 — NO ntfy) */}
                  <div className="rounded-2xl border border-dl-border-hairline p-4 space-y-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-dl-text-primary">
                        <Bell className="size-3.5 text-dl-lane-shared" strokeWidth={1.9} />
                        <span>离线邮件提醒</span>
                      </div>
                      <div className="text-xs text-dl-text-tertiary">
                        当你离线且有未读提及或私聊消息时，通过已绑定邮箱接收提醒
                      </div>
                    </div>

                    {emailNotifsLoading && !emailNotifs ? (
                      <div className="text-xs text-dl-text-tertiary">正在读取通知设置…</div>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold text-dl-text-primary">
                              启用离线邮件通知
                            </div>
                            <div className="text-[11px] text-dl-text-tertiary">
                              在线活跃期间不会发送打扰邮件
                            </div>
                          </div>
                          <Switch
                            label="启用离线邮件通知"
                            disabled={emailNotifsSaving}
                            checked={Boolean(emailNotifs?.enabled)}
                            onCheckedChange={(checked) =>
                              void handlePatchEmailNotifs({ enabled: checked })
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold text-dl-text-primary">
                              私聊与 @提及 即时邮件
                            </div>
                            <div className="text-[11px] text-dl-text-tertiary">
                              离线收到重要提及时尽快投递邮件提醒
                            </div>
                          </div>
                          <Switch
                            label="私聊与 @提及 即时邮件"
                            disabled={emailNotifsSaving || !emailNotifs?.enabled}
                            checked={Boolean(emailNotifs?.immediateEnabled)}
                            onCheckedChange={(checked) =>
                              void handlePatchEmailNotifs({ immediateEnabled: checked })
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold text-dl-text-primary">
                              未读消息汇总摘要
                            </div>
                            <div className="text-[11px] text-dl-text-tertiary">
                              按周期合并发送未读会话摘要，减少邮件频次
                            </div>
                          </div>
                          <Switch
                            label="未读消息汇总摘要"
                            disabled={emailNotifsSaving || !emailNotifs?.enabled}
                            checked={Boolean(emailNotifs?.digestEnabled)}
                            onCheckedChange={(checked) =>
                              void handlePatchEmailNotifs({ digestEnabled: checked })
                            }
                          />
                        </div>
                      </div>
                    )}

                    {emailNotifsError && (
                      <div className="text-xs text-dl-danger">{emailNotifsError}</div>
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
                              .then(() =>
                                setDevices((prev) => prev.filter((d) => d.id !== dev.id))
                              )
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
