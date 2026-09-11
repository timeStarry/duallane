import { BellRing, Check, ChevronRight, Copy, Download, ExternalLink, Images, LockKeyhole, Mail, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { WorkspaceAvatarEditor } from "../../WorkspaceAvatarEditor";
import { userFacingErrorMessage } from "../../user-facing-error";
import { AUTO_HIDE_LABELS, AUTO_HIDE_MESSAGE_TYPES, normalizeAutoHidePreferences, type WorkspaceAutoHidePreferences } from "../../workspace-auto-hide";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingsLayout } from "./SettingsLayout";
import { SettingsLoading, WorkspaceSettingsRow, WorkspaceSwitch } from "./SettingsControls";
import { createProfileDraft } from "./profile-draft";
import type { AccountSettingsSection, SettingsUser, SettingsNotice, SettingsServices, SettingsEmoteSettings, SettingsEmoteLibrarySummary, SettingsNotificationPreferences, SettingsNtfyPreferences, RegisterSettingsNavigationGuard } from "./contracts";

const WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT = "duallane:workspace-emote-library-changed";
const workspaceEmoteLibraryTotalItemCount = (usage: SettingsEmoteLibrarySummary["usage"]) => usage.itemCount + usage.subscribedItemCount;
const getFocusableElements = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter((element) => !element.hidden && element.getClientRects().length > 0);

export function WorkspaceAccountSettings({
  onChatSettingsUpdated: notifyChatSettingsUpdated,
  currentUser,
  section,
  onBack,
  onNavigate,
  onUserUpdated: notifyUserUpdated,
  onNotice: notify,
  onManageEmotes,
  onLogout,
  services,
  registerNavigationGuard,
  onDirtyChange
}: {
  onChatSettingsUpdated: (userId: string, settings: SettingsEmoteSettings) => void;
  currentUser: SettingsUser;
  section: AccountSettingsSection;
  onBack: () => void;
  onNavigate: (section: AccountSettingsSection) => void;
  onUserUpdated: (user: SettingsUser) => void;
  onNotice: (tone: Parameters<SettingsNotice>[0], text: string) => void;
  onManageEmotes: () => void;
  onLogout: () => void;
  services: SettingsServices;
  registerNavigationGuard?: RegisterSettingsNavigationGuard;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { json: workspaceJson, fetch: workspaceFetch, loadEmoteLibrary: loadWorkspaceEmoteLibrary, copyText } = services;
  const scopeRef = useRef({ active: true, userId: currentUser.id });
  useEffect(() => { scopeRef.current = { active: true, userId: currentUser.id }; return () => { scopeRef.current.active = false; }; }, [currentUser.id]);
  const isCurrent = () => scopeRef.current.active && scopeRef.current.userId === currentUser.id;
  const onUserUpdated = (user: SettingsUser) => { if (isCurrent() && user.id === currentUser.id) notifyUserUpdated(user); };
  const onNotice: SettingsNotice = (tone, message) => { if (isCurrent()) notify(tone, message); };
  const onChatSettingsUpdated = (userId: string, settings: SettingsEmoteSettings) => { if (isCurrent() && userId === currentUser.id) notifyChatSettingsUpdated(userId, settings); };
  type SaveKey = "privacy" | "chat" | "notifications" | "push";
  const [saveFeedback, setSaveFeedback] = useState<Partial<Record<SaveKey, { status: "saving" | "saved" | "error"; message: string; retry?: () => void }>>>({});
  const saveStarted = (key: SaveKey) => { if (isCurrent()) setSaveFeedback((current) => ({ ...current, [key]: { status: "saving", message: "正在保存…", retry: current[key]?.retry } })); };
  const saveSucceeded = (key: SaveKey) => { if (isCurrent()) setSaveFeedback((current) => ({ ...current, [key]: { status: "saved", message: "已保存", retry: current[key]?.retry } })); };
  const saveFailed = (key: SaveKey, error: unknown, fallback: string, retry: () => void) => { if (isCurrent()) setSaveFeedback((current) => ({ ...current, [key]: { status: "error", message: userFacingErrorMessage(error, fallback), retry } })); };
  const [notificationLoadRevision, setNotificationLoadRevision] = useState(0);
  const [notificationLoadError, setNotificationLoadError] = useState("");
  const [ntfyLoadRevision, setNtfyLoadRevision] = useState(0);
  const [ntfyLoadError, setNtfyLoadError] = useState("");

  const callbacks = useRef({ onUserUpdated, onNotice });
  callbacks.current = { onUserUpdated, onNotice };
  const profile = useMemo(() => createProfileDraft(currentUser.nickname ?? "", (nickname) => services.json<{ user: SettingsUser }>("/api/workspace/me/profile", { method: "PATCH", body: JSON.stringify({ nickname }) }).then((result) => result.user), (user) => callbacks.current.onUserUpdated(user), (error) => userFacingErrorMessage(error, "公开昵称保存失败，请重试")), [currentUser.id]);
  const profileState = useSyncExternalStore(profile.subscribe, profile.getSnapshot, profile.getSnapshot);
  const nickname = profileState.draft;
  const setNickname = profile.edit;
  const profileSaving = profileState.status === "saving";
  const profileDirty = nickname.trim() !== profileState.saved;
  useEffect(() => { profile.activate(); return () => profile.deactivate(); }, [profile]);
  useEffect(() => {
    onDirtyChange?.(profileDirty);
    registerNavigationGuard?.(profileDirty ? { message: "个人资料还有未保存的修改。保存成功后才会离开；放弃只清除本次草稿，不撤销已提交的保存。", save: profile.save, discard: profile.discard } : null);
    return () => { registerNavigationGuard?.(null); onDirtyChange?.(false); };
  }, [profileDirty, profile, registerNavigationGuard, onDirtyChange]);
  const [recallReason, setRecallReason] = useState(currentUser.recallReason ?? "内容有误");
  const [searchDiscoverable, setSearchDiscoverable] = useState(Boolean(currentUser.searchDiscoverable));
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [recallReasonSaving, setRecallReasonSaving] = useState(false);
  const [discoverySaving, setDiscoverySaving] = useState(false);
  const [emoteSettings, setEmoteSettings] = useState<SettingsEmoteSettings | null>(null);
  const [emoteSettingsLoading, setEmoteSettingsLoading] = useState(true);
  const [emoteSettingsLoadRevision, setEmoteSettingsLoadRevision] = useState(0);
  const [emoteSettingsSaving, setEmoteSettingsSaving] = useState(false);
  const emoteSettingsRequestRef = useRef(0);
  const [emoteLibrarySummary, setEmoteLibrarySummary] = useState<SettingsEmoteLibrarySummary | null>(null);
  const [notifications, setNotifications] = useState<SettingsNotificationPreferences | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsSaving, setNotificationsSaving] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [ntfy, setNtfy] = useState<SettingsNtfyPreferences | null>(null);
  const [ntfyLoading, setNtfyLoading] = useState(true);
  const [ntfySaving, setNtfySaving] = useState(false);
  const [ntfyHelpOpen, setNtfyHelpOpen] = useState(false);
  const [ntfyRotateConfirm, setNtfyRotateConfirm] = useState(false);
  const ntfyHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const ntfyDialogRef = useRef<HTMLDivElement>(null);
  const ntfyDialogCloseRef = useRef<HTMLButtonElement>(null);
  const lastSavedRecallReasonRef = useRef(currentUser.recallReason ?? "内容有误");
  const recallReasonSaveSequenceRef = useRef(0);
  const recallSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    emoteSettingsRequestRef.current += 1;
    return () => { emoteSettingsRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    setRecallReason(currentUser.recallReason ?? "内容有误");
    setSearchDiscoverable(Boolean(currentUser.searchDiscoverable));
    lastSavedRecallReasonRef.current = currentUser.recallReason ?? "内容有误";
  }, [currentUser.id]);


  function persistRecallReason(value: string, sequence: number) {
    recallSaveQueueRef.current = recallSaveQueueRef.current.then(async () => {
      if (!isCurrent() || sequence !== recallReasonSaveSequenceRef.current) return;
      setRecallReasonSaving(true); saveStarted("chat");
      try {
        const data = await workspaceJson<{ user: SettingsUser }>("/api/workspace/me/profile", { method: "PATCH", body: JSON.stringify({ recallReason: value }) });
        if (!isCurrent() || sequence !== recallReasonSaveSequenceRef.current) return;
        const saved = data.user.recallReason ?? "内容有误";
        lastSavedRecallReasonRef.current = saved; setRecallReason(saved); onUserUpdated(data.user); saveSucceeded("chat");
      } catch (error) {
        if (!isCurrent() || sequence !== recallReasonSaveSequenceRef.current) return;
        saveFailed("chat", error, "撤回文案保存失败，输入已保留", () => persistRecallReason(value, ++recallReasonSaveSequenceRef.current));
      } finally { if (isCurrent()) setRecallReasonSaving(false); }
    });
  }
  useEffect(() => {
    const value = recallReason.trim();
    const sequence = ++recallReasonSaveSequenceRef.current;
    if (!value || value === lastSavedRecallReasonRef.current) return;
    const timer = window.setTimeout(() => persistRecallReason(value, sequence), 650);
    return () => window.clearTimeout(timer);
  }, [currentUser.id, recallReason]);

  useEffect(() => {
    let cancelled = false;
    setEmoteSettingsLoading(true);
    setEmoteSettings(null);
    void Promise.all([
      workspaceJson<{ settings: SettingsEmoteSettings }>("/api/workspace/me/emote-settings"),
      loadWorkspaceEmoteLibrary()
    ])
      .then(([data, library]) => {
        if (!cancelled) {
          setEmoteSettings(data.settings);
          setEmoteLibrarySummary(library);
          onChatSettingsUpdated(currentUser.id, data.settings);
        }
      })
      .catch((error) => {
        if (!cancelled) onNotice("warning", userFacingErrorMessage(error, "表情设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setEmoteSettingsLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentUser.id, emoteSettingsLoadRevision]);

  useEffect(() => {
    let cancelled = false;
    const refreshEmoteLibrarySummary = () => {
      void loadWorkspaceEmoteLibrary(true)
        .then((library) => {
          if (!cancelled) setEmoteLibrarySummary(library);
        })
        .catch(() => undefined);
    };
    window.addEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshEmoteLibrarySummary);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshEmoteLibrarySummary);
    };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    setNotificationsLoading(true);
    setNotificationLoadError("");
    void workspaceJson<{ notifications: SettingsNotificationPreferences }>("/api/workspace/me/notifications")
      .then((data) => {
        if (!cancelled) setNotifications(data.notifications);
      })
      .catch((error) => {
        if (!cancelled) setNotificationLoadError(userFacingErrorMessage(error, "通知设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setNotificationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, notificationLoadRevision]);

  useEffect(() => {
    let cancelled = false;
    setNtfyLoading(true);
    setNtfyLoadError("");
    void workspaceJson<{ ntfy: SettingsNtfyPreferences }>("/api/workspace/me/ntfy")
      .then((data) => {
        if (!cancelled) setNtfy(data.ntfy);
      })
      .catch((error) => {
        if (!cancelled) setNtfyLoadError(userFacingErrorMessage(error, "ntfy 设置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setNtfyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, ntfyLoadRevision]);

  useEffect(() => {
    if (!ntfyHelpOpen || !ntfyDialogRef.current) return;
    const dialog = ntfyDialogRef.current;
    const root = document.getElementById("root");
    const previousRootInert = root?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => ntfyDialogCloseRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNtfyHelpOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (root) root.inert = previousRootInert;
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => ntfyHelpTriggerRef.current?.focus());
    };
  }, [ntfyHelpOpen]);

  async function updateSearchDiscoverable(nextValue: boolean) {
    const previousValue = searchDiscoverable;
    setSearchDiscoverable(nextValue);
    setDiscoverySaving(true); saveStarted("privacy");
    try {
      const data = await workspaceJson<{ user: SettingsUser }>("/api/workspace/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ searchDiscoverable: nextValue })
      });
      onUserUpdated(data.user);
      setSearchDiscoverable(Boolean(data.user.searchDiscoverable)); saveSucceeded("privacy");
    } catch (error) {
      setSearchDiscoverable(previousValue);
      saveFailed("privacy", error, "保存失败，已恢复上次确认值", () => void updateSearchDiscoverable(nextValue));
    } finally {
      setDiscoverySaving(false);
    }
  }

  async function uploadAvatar(blob: Blob) {
    setAvatarSaving(true);
    try {
      const response = await workspaceFetch("/api/workspace/me/avatar", {
        method: "PUT",
        headers: { "content-type": "image/webp" },
        body: blob
      });
      const data = await response.json() as { user: SettingsUser };
      onUserUpdated(data.user);
      onNotice("success", "头像已更新");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "头像更新失败"));
    } finally {
      setAvatarSaving(false);
    }
  }

  async function deleteAvatar() {
    setAvatarSaving(true);
    try {
      const data = await workspaceJson<{ user: SettingsUser }>("/api/workspace/me/avatar", { method: "DELETE" });
      onUserUpdated(data.user);
      onNotice("success", "已恢复 GitHub 头像");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "头像恢复失败"));
    } finally {
      setAvatarSaving(false);
    }
  }

  async function updateNotifications(patch: Partial<Pick<SettingsNotificationPreferences, "enabled" | "immediateEnabled" | "digestEnabled">>) {
    if (!notifications) return;
    const previous = notifications;
    const optimistic = { ...notifications, ...patch };
    setNotifications(optimistic);
    setNotificationsSaving(true); saveStarted("notifications");
    try {
      const data = await workspaceJson<{ notifications: SettingsNotificationPreferences }>("/api/workspace/me/notifications", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: optimistic.enabled,
          immediateEnabled: optimistic.immediateEnabled,
          digestEnabled: optimistic.digestEnabled
        })
      });
      setNotifications(data.notifications); saveSucceeded("notifications");
    } catch (error) {
      setNotifications(previous);
      saveFailed("notifications", error, "保存失败，已恢复上次确认值", () => void updateNotifications(patch));
    } finally {
      setNotificationsSaving(false);
    }
  }

  async function updateEmoteSettings(packId: SettingsEmoteSettings["availablePacks"][number]["id"], enabled: boolean) {
    if (!emoteSettings) return;
    const nextEnabledPackIds = enabled
      ? [...emoteSettings.enabledPackIds, packId]
      : emoteSettings.enabledPackIds.filter((id) => id !== packId);
    await saveChatSettings({ enabledPackIds: nextEnabledPackIds }, "表情设置保存失败");
  }

  async function updateImageEmoteDirectSend(enabled: boolean) {
    await saveChatSettings({ clickImageEmoteToSend: enabled }, "表情发送方式保存失败");
  }

  async function updateReplyAutoMention(enabled: boolean) {
    await saveChatSettings({ replyAutoMention: enabled }, "回复提及设置保存失败");
  }

  async function updateAutoHidePreferences(patch: Partial<WorkspaceAutoHidePreferences>) {
    await saveChatSettings(patch, "消息显示设置保存失败");
  }

  async function saveChatSettings(patch: Partial<SettingsEmoteSettings>, failureMessage: string) {
    if (!emoteSettings || emoteSettingsSaving) return;
    const requestSequence = ++emoteSettingsRequestRef.current;
    const previous = emoteSettings;
    setEmoteSettings({ ...emoteSettings, ...normalizeAutoHidePreferences(emoteSettings), ...patch });
    setEmoteSettingsSaving(true); saveStarted("chat");
    try {
      const data = await workspaceJson<{ settings: SettingsEmoteSettings }>("/api/workspace/me/emote-settings", {
        method: "PUT", body: JSON.stringify(patch)
      });
      if (requestSequence !== emoteSettingsRequestRef.current) return;
      setEmoteSettings(data.settings);
      onChatSettingsUpdated(currentUser.id, data.settings); saveSucceeded("chat");
    } catch (error) {
      if (requestSequence !== emoteSettingsRequestRef.current) return;
      setEmoteSettings(previous);
      saveFailed("chat", error, `${failureMessage}，已恢复上次确认值`, () => void saveChatSettings(patch, failureMessage));
    } finally {
      if (requestSequence === emoteSettingsRequestRef.current) setEmoteSettingsSaving(false);
    }
  }

  async function sendEmailChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ challengeId: string; pendingEmail: string }>(
        "/api/workspace/me/notification-email/challenges",
        { method: "POST", body: JSON.stringify({ email: pendingEmail }) }
      );
      setChallengeId(data.challengeId);
      setVerificationCode("");
      onNotice("success", `验证码已发送至 ${data.pendingEmail}`);
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "验证码发送失败"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function verifyEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ notifications: SettingsNotificationPreferences }>(
        "/api/workspace/me/notification-email/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code: verificationCode }) }
      );
      setNotifications(data.notifications);
      setChallengeId("");
      setPendingEmail("");
      setVerificationCode("");
      onNotice("success", "通知邮箱已验证并启用");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "邮箱验证失败"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function useGitHubEmail() {
    setEmailBusy(true);
    try {
      const data = await workspaceJson<{ notifications: SettingsNotificationPreferences }>(
        "/api/workspace/me/notification-email/use-github",
        { method: "POST" }
      );
      setNotifications(data.notifications);
      setChallengeId("");
      onNotice("success", "已恢复使用 GitHub 邮箱");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "无法使用 GitHub 邮箱"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function updateNtfy(enabled: boolean) {
    if (!ntfy) return;
    const previous = ntfy;
    setNtfy({ ...ntfy, enabled });
    setNtfySaving(true); saveStarted("push");
    try {
      const data = await workspaceJson<{ ntfy: SettingsNtfyPreferences }>("/api/workspace/me/ntfy", {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      setNtfy(data.ntfy); saveSucceeded("push");
    } catch (error) {
      setNtfy(previous);
      saveFailed("push", error, "保存失败，已恢复上次确认值", () => void updateNtfy(enabled));
    } finally {
      setNtfySaving(false);
    }
  }

  async function rotateNtfyTopic() {
    setNtfySaving(true);
    try {
      const data = await workspaceJson<{ ntfy: SettingsNtfyPreferences }>("/api/workspace/me/ntfy/rotate", {
        method: "POST"
      });
      setNtfy(data.ntfy);
      setNtfyRotateConfirm(false);
      onNotice("success", "推送凭据已重新生成，所有设备需要重新配置");
    } catch (error) {
      onNotice("warning", userFacingErrorMessage(error, "topic 刷新失败"));
    } finally {
      setNtfySaving(false);
    }
  }

  async function copyNtfyValue(value: string, label: string) {
    const copied = await copyText(value);
    onNotice(copied ? "success" : "warning", copied ? `${label}已复制` : `${label}复制失败`);
  }

  const visibleSection = section;
  const feedbackKey = section === "email" || section === "notifications" ? "notifications" : section === "chat" || section === "privacy" || section === "push" ? section : null;
  const currentFeedback = feedbackKey ? saveFeedback[feedbackKey] : undefined;
  return (
    <>
    <SettingsLayout section={section} currentUser={currentUser} onNavigate={onNavigate} onBack={onBack} onLogout={onLogout}>
      {visibleSection === "appearance" && <AppearanceSettings />}
      {visibleSection === "emotes" && <section className="workspace-settings-detail"><div className="workspace-settings-detail-intro"><h3>我的表情</h3><p>收藏、上传、合集与订阅统一管理；聊天中的选择器继续服务于当前输入框。</p></div><WorkspaceSettingsRow icon={<Images size={18} />} title="管理我的表情" description="上传、排序、管理合集与分享" value={emoteLibrarySummary ? `${workspaceEmoteLibraryTotalItemCount(emoteLibrarySummary.usage)} 张` : "读取中"} onClick={onManageEmotes} /></section>}
      {visibleSection === "profile" && (
        <section className="workspace-settings-detail" aria-labelledby="workspace-profile-settings-title">
          <div className="workspace-settings-detail-intro"><h3 id="workspace-profile-settings-title">公开资料</h3><p>头像和昵称会显示在所有登录后的共享空间界面。</p></div>
          <div className="dl-profile-avatar"><WorkspaceAvatarEditor name={currentUser.displayName} avatarUrl={currentUser.avatarUrl} busy={avatarSaving} onUpload={uploadAvatar} onDelete={deleteAvatar} onError={(message) => onNotice("warning", message)} /></div>
          <div className="dl-profile-fields">
            <label>
              <span>公开昵称</span>
              <input
                aria-label="公开昵称"
                aria-describedby="workspace-nickname-description"
                value={nickname}
                disabled={profileSaving}
                maxLength={32}
                onChange={(event) => setNickname(event.target.value)}
                placeholder={currentUser.githubLogin || "输入昵称"}
              />
              <small id="workspace-nickname-description">最多 32 个字符；留空时使用 GitHub 账号名称。</small>
            </label>
          </div>
            <footer className="dl-settings-profile-actions">
              <div className="dl-settings-save-feedback" role="status" aria-live="polite">{profileSaving ? "正在保存资料…" : profileState.error ? profileState.error : profileDirty ? "有未保存的修改" : profileState.status === "saved" ? "资料已保存" : ""}</div>
              <div className="button-row"><button type="button" className="secondary" disabled={!profileDirty || profileSaving} onClick={profile.discard}>取消修改</button><button type="button" className="primary" aria-disabled={!profileDirty || profileSaving} onClick={() => { if (profileDirty && !profileSaving) void profile.save(); }}>{profileSaving ? "正在保存" : profileState.status === "error" ? "重试保存资料" : "保存资料"}</button></div>
            </footer>
          <div className="dl-profile-account"><span>登录账号</span><strong>@{currentUser.githubLogin}</strong><small>通过 GitHub 登录；公开昵称不改变登录身份。</small></div>
        </section>
      )}

      {visibleSection === "privacy" && (
        <section className="workspace-settings-detail" aria-labelledby="workspace-privacy-settings-title">
          <div className="workspace-settings-detail-intro"><h3 id="workspace-privacy-settings-title">成员发现</h3><p>控制不在联系人范围内的空间成员是否能找到你。</p></div>
          <div className="workspace-setting-list">
            <WorkspaceSwitch checked={searchDiscoverable} disabled={discoverySaving} label="允许其他成员搜索到我" description="开启后，其他成员可以通过公开昵称或 GitHub 登录名找到你并发起私聊。" onChange={(checked) => void updateSearchDiscoverable(checked)} />
          </div>
          <p className="workspace-settings-footnote">已有会话和联系人关系不受此设置影响。</p>
        </section>
      )}

      {visibleSection === "chat" && (
        <div className="workspace-settings-detail-stack">
          <section className="workspace-settings-detail" aria-labelledby="workspace-auto-hide-title" aria-busy={emoteSettingsLoading}>
            <div className="workspace-settings-detail-intro"><h3 id="workspace-auto-hide-title">消息显示</h3><p>只影响你在聊天和话题中看到的内容，不删除消息，也不影响其他成员。</p></div>
            {emoteSettingsLoading ? <SettingsLoading count={1} /> : !emoteSettings ? <div className="workspace-empty-inline"><p>聊天设置暂时无法加载。</p><button type="button" onClick={() => setEmoteSettingsLoadRevision((revision) => revision + 1)}>重试加载聊天设置</button></div> : <>
              <div className="workspace-setting-list">
                <WorkspaceSwitch checked={emoteSettings.autoHideMessages === true} disabled={emoteSettingsSaving} label="在聊天中自动隐藏消息" description="默认关闭。开启后，包含所选内容的消息会折叠，可随时手动展开。" onChange={(checked) => void updateAutoHidePreferences({ autoHideMessages: checked })} />
              </div>
              {emoteSettings.autoHideMessages === true && <>
                <fieldset className="dl-settings-choice-group"><legend>自动隐藏的消息类型</legend><div className="workspace-emote-pack-settings" role="group" aria-label="自动隐藏的消息类型">
                  {AUTO_HIDE_MESSAGE_TYPES.map((type) => {
                    const types = normalizeAutoHidePreferences(emoteSettings).autoHideMessageTypes;
                    const checked = types.includes(type);
                    return <button key={type} type="button" aria-pressed={checked} disabled={emoteSettingsSaving} onClick={() => void updateAutoHidePreferences({ autoHideMessageTypes: checked ? types.filter((item) => item !== type) : [...types, type] })}><span className="workspace-emote-pack-check" aria-hidden="true">{checked && <Check size={14} />}</span><span>{AUTO_HIDE_LABELS[type]}</span></button>;
                  })}
                </div></fieldset>
                <p className="workspace-settings-footnote">长消息指超过 700 字或 10 行的消息。未选择类型时不会自动隐藏；关闭后保留选择。</p>
              </>}
            </>}
          </section>
          <section className="workspace-settings-detail" aria-labelledby="workspace-recall-settings-title">
            <div className="workspace-settings-detail-intro"><h3 id="workspace-recall-settings-title">撤回提示</h3><p>这段原因会显示在你之后撤回的消息中。</p></div>
            <label className="workspace-settings-field"><span>撤回原因</span><input value={recallReason} maxLength={16} onChange={(event) => setRecallReason(event.target.value)} onBlur={() => { if (!recallReason.trim()) setRecallReason(lastSavedRecallReasonRef.current); }} aria-label="自定义撤回原因" /><small>消息中将显示“你因{recallReason || "..."}撤回了一条消息”。</small></label>
          </section>
          <section className="workspace-settings-detail" aria-labelledby="workspace-emote-panel-title" aria-busy={emoteSettingsLoading}>
            <div className="workspace-settings-detail-intro"><h3 id="workspace-emote-panel-title">表情面板</h3><p>选择聊天时显示的内置表情包，至少保留一个。</p></div>
            {emoteSettingsLoading ? <SettingsLoading count={3} /> : !emoteSettings ? <p className="workspace-settings-footnote">请重试加载聊天设置。</p> : (
              <>
                <div className="workspace-emote-pack-settings">
                  {emoteSettings.availablePacks.map((pack) => {
                    const checked = emoteSettings.enabledPackIds.includes(pack.id);
                    const onlyEnabled = checked && emoteSettings.enabledPackIds.length <= emoteSettings.minimumEnabled;
                    return <button key={pack.id} type="button" aria-pressed={checked} disabled={emoteSettingsSaving || onlyEnabled} onClick={() => void updateEmoteSettings(pack.id, !checked)}><span className="workspace-emote-pack-check" aria-hidden="true">{checked && <Check size={14} />}</span><span>{pack.label}</span></button>;
                  })}
                </div>
                <div className="workspace-setting-list compact-list workspace-emote-behavior-settings">
                  <WorkspaceSwitch
                    checked={emoteSettings.clickImageEmoteToSend}
                    disabled={emoteSettingsSaving}
                    label="点击图片表情直接发送"
                    description="开启后，选择图片表情会立即发送；Emoji 仍会插入输入框。"
                    onChange={(checked) => void updateImageEmoteDirectSend(checked)}
                  />
                  <WorkspaceSwitch
                    checked={emoteSettings.replyAutoMention}
                    disabled={emoteSettingsSaving}
                    label="回复群消息时自动提及对方"
                    description="开启后，点击回复会在输入框中自动带入被回复者的提及。默认关闭。"
                    onChange={(checked) => void updateReplyAutoMention(checked)}
                  />
                </div>
              </>
            )}
            <div className="workspace-settings-list single-row">
              <WorkspaceSettingsRow icon={<Images size={18} />} title="我的表情" description="上传、排序、管理合集与分享" value={emoteLibrarySummary ? `${workspaceEmoteLibraryTotalItemCount(emoteLibrarySummary.usage)} 张` : "读取中"} onClick={onManageEmotes} />
            </div>
          </section>
        </div>
      )}

      {visibleSection === "notifications" && (
        <section className="workspace-settings-detail" aria-labelledby="workspace-notification-settings-title" aria-busy={notificationsLoading || ntfyLoading}>
          <div className="workspace-settings-detail-intro"><h3 id="workspace-notification-settings-title">通知渠道</h3><p>所有渠道都遵循每个会话的提醒与免打扰规则。</p></div>
          {notificationsLoading || ntfyLoading ? <SettingsLoading count={2} /> : !notifications || !ntfy ? <p className="workspace-settings-footnote">通知渠道暂时无法完整读取，请重试。</p> : (
            <div className="workspace-settings-list">
              <WorkspaceSettingsRow icon={<Mail size={18} />} title="邮件通知" description="未读消息提醒与通知邮箱" value={notifications.enabled ? "开启" : "关闭"} onClick={() => onNavigate("email")} />
              <WorkspaceSettingsRow icon={<BellRing size={18} />} title="移动推送" description="通过 ntfy 客户端接收" value={ntfy.enabled ? "已启用" : "未启用"} onClick={() => onNavigate("push")} />
            </div>
          )}
          <p className="workspace-settings-footnote">会话级提醒方式可在聊天详情中单独设置。</p>
        </section>
      )}

      {visibleSection === "email" && (
        <div className="workspace-settings-detail-stack" aria-busy={notificationsLoading}>
        <section className="workspace-settings-detail" aria-labelledby="workspace-email-notification-title">
          <div className="workspace-settings-detail-intro"><h3 id="workspace-email-notification-title">邮件提醒</h3><p>邮件仅说明存在未读消息，不包含聊天内容或附件信息。</p></div>
          {notificationsLoading ? <SettingsLoading count={4} /> : !notifications ? <p className="workspace-settings-footnote">邮件偏好暂时无法读取。</p> : (
            <>
              <div className="workspace-setting-list"><WorkspaceSwitch checked={notifications.enabled} disabled={notificationsSaving} label="接受邮件通知" description={notifications.maskedEmail || "尚未设置可用邮箱"} onChange={(checked) => void updateNotifications({ enabled: checked })} /></div>
              {notifications.enabled && !notifications.mailAvailable && <p className="workspace-form-status">空间邮件服务尚未启用。偏好会保留，但暂时不会发信。</p>}
            </>
          )}
        </section>
        {!notificationsLoading && notifications?.enabled && <>
          <section className="workspace-settings-detail" aria-labelledby="workspace-email-frequency-title">
            <div className="workspace-settings-detail-intro"><h3 id="workspace-email-frequency-title">接收频率</h3><p>这些提醒仍遵循每个会话的免打扰设置。</p></div>
            <div className="workspace-setting-list compact-list"><WorkspaceSwitch checked={notifications.immediateEnabled} disabled={notificationsSaving} label="每条消息都通知我" description="所有设备离线且消息 60 秒后仍未读时发送。" onChange={(checked) => void updateNotifications({ immediateEnabled: checked })} /><WorkspaceSwitch checked={notifications.digestEnabled} disabled={notificationsSaving} label="超过 2 小时仍未读时通知我" description="跨会话汇总，每个未读周期只发送一次。" onChange={(checked) => void updateNotifications({ digestEnabled: checked })} /></div>
          </section>
          <section className="workspace-settings-detail" aria-labelledby="workspace-email-address-title">
            <div className="workspace-settings-detail-intro"><h3 id="workspace-email-address-title">通知邮箱</h3><p>更换邮箱后，输入验证码完成验证。</p></div>
                <div className="workspace-notification-email-head"><span>当前邮箱 <strong>{notifications.maskedEmail || "未设置"}</strong></span>{notifications.emailSource === "custom" && notifications.githubEmail && <button className="secondary compact" type="button" disabled={emailBusy} onClick={() => void useGitHubEmail()}>使用 GitHub 邮箱</button>}</div>
                <form className="workspace-inline-form" onSubmit={sendEmailChallenge}><label><span>更换通知邮箱</span><input type="email" value={pendingEmail} onChange={(event) => setPendingEmail(event.target.value)} placeholder="name@example.com" required /></label><button className="secondary" type="submit" disabled={emailBusy || !notifications.mailAvailable}><Mail size={16} />发送验证码</button></form>
                {challengeId && <form className="workspace-inline-form" onSubmit={verifyEmail}><label><span>6 位验证码</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ""))} required /></label><button className="primary" type="submit" disabled={emailBusy || verificationCode.length !== 6}>验证邮箱</button></form>}
          </section>
        </>}
        </div>
      )}

      {visibleSection === "push" && (
        <section className="workspace-settings-detail" aria-labelledby="workspace-push-notification-title" aria-busy={ntfyLoading}>
          <div className="workspace-settings-detail-intro"><h3 id="workspace-push-notification-title">推送状态</h3><p>通过 ntfy 客户端接收不含消息正文的提醒。</p></div>
          {ntfyLoading ? <SettingsLoading count={2} /> : !ntfy ? <p className="workspace-settings-footnote">推送偏好暂时无法读取。</p> : <>
            <div className="workspace-setting-list"><WorkspaceSwitch checked={ntfy.enabled} disabled={ntfySaving} label="接受移动推送" description={ntfy.enabled ? "已配置，可在使用说明中查看订阅信息。" : "开启后可按说明配置 ntfy 客户端。"} onChange={(checked) => void updateNtfy(checked)} /></div>
            <button ref={ntfyHelpTriggerRef} className="dl-settings-link" type="button" aria-haspopup="dialog" onClick={() => setNtfyHelpOpen(true)}><span aria-hidden="true"><BellRing size={18} /></span><span><strong>配置 ntfy 客户端</strong><small>查看安装、服务器和个人订阅信息</small></span><ChevronRight size={17} aria-hidden="true" /></button>
          </>}
        </section>
      )}
      {currentFeedback && <div className="dl-settings-save-feedback" data-state={currentFeedback.status} role="status"><span>{currentFeedback.message}</span>{currentFeedback.retry && <button type="button" aria-disabled={currentFeedback.status !== "error"} onClick={() => { if (currentFeedback.status === "error") currentFeedback.retry?.(); }}>{currentFeedback.status === "saving" ? "正在重试" : currentFeedback.status === "saved" ? "已保存" : "重试保存"}</button>}</div>}
      {(section === "notifications" || section === "email") && notificationLoadError && <div className="dl-settings-save-feedback" data-state="error" role="status"><span>{notificationLoadError}</span><button type="button" onClick={() => setNotificationLoadRevision((value) => value + 1)}>重新加载邮件偏好</button></div>}
      {(section === "notifications" || section === "push") && ntfyLoadError && <div className="dl-settings-save-feedback" data-state="error" role="status"><span>{ntfyLoadError}</span><button type="button" onClick={() => setNtfyLoadRevision((value) => value + 1)}>重新加载推送偏好</button></div>}
    </SettingsLayout>
    {ntfyHelpOpen && ntfy && createPortal(
      <div className="workspace-ntfy-dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setNtfyHelpOpen(false);
      }}>
        <div
          ref={ntfyDialogRef}
          className="workspace-ntfy-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-ntfy-dialog-title"
          aria-describedby="workspace-ntfy-dialog-description"
          tabIndex={-1}
        >
          <header>
            <div>
              <p className="eyebrow">移动推送</p>
              <h3 id="workspace-ntfy-dialog-title">订阅 ntfy 通知</h3>
            </div>
            <button ref={ntfyDialogCloseRef} className="icon-button" type="button" aria-label="关闭 ntfy 使用说明" title="关闭" onClick={() => setNtfyHelpOpen(false)}>
              <X size={18} />
            </button>
          </header>
          <p id="workspace-ntfy-dialog-description" className="workspace-ntfy-dialog-intro">
            在 ntfy 客户端添加新订阅，填写下方 topic，并选择“使用其他服务器”。
          </p>
          <ol className="workspace-ntfy-steps">
            <li><span>1</span><p>安装并打开 ntfy，点击“订阅主题”。</p></li>
            <li><span>2</span><p>将“我的 topic”粘贴到主题名称。</p></li>
            <li><span>3</span><p>启用“使用其他服务器”，粘贴服务器地址后订阅。</p></li>
          </ol>
          <div className="workspace-ntfy-copy-list">
            <div>
              <span>ntfy 服务器</span>
              <code>{ntfy.serverUrl}</code>
              <button className="icon-button" type="button" title="复制服务器地址" aria-label="复制 ntfy 服务器地址" onClick={() => void copyNtfyValue(ntfy.serverUrl, "服务器地址")}><Copy size={16} /></button>
            </div>
            <div>
              <span>我的 topic</span>
              <code>{ntfy.topic}</code>
              <button className="icon-button" type="button" title="复制 topic" aria-label="复制我的 ntfy topic" onClick={() => void copyNtfyValue(ntfy.topic, "topic")}><Copy size={16} /></button>
            </div>
          </div>
          <div className="workspace-ntfy-warning" role="note">
            <LockKeyhole size={18} />
            <p><strong>不要分享 topic。</strong>知道该字符串的人可能订阅你的通知。怀疑泄露时，请回到此页刷新 topic。</p>
          </div>
          {ntfyRotateConfirm ? (
            <div className="workspace-ntfy-rotate-confirm" role="group" aria-label="确认重新生成推送凭据">
              <p><strong>所有已订阅设备将停止接收。</strong>重新生成后，需要在每台设备上重新配置订阅。</p>
              <button className="secondary compact" type="button" disabled={ntfySaving} onClick={() => setNtfyRotateConfirm(false)}>取消</button>
              <button className="secondary compact danger-action" type="button" disabled={ntfySaving} onClick={() => void rotateNtfyTopic()}>
                {ntfySaving ? "正在生成" : "确认重新生成"}
              </button>
            </div>
          ) : (
            <button className="workspace-ntfy-rotate danger-action" type="button" onClick={() => setNtfyRotateConfirm(true)}>
              <RefreshCw size={15} />
              重新生成推送凭据
            </button>
          )}
          <div className="workspace-ntfy-downloads">
            <a className="secondary" href="https://ntfy.sh/" target="_blank" rel="noopener noreferrer">
              <BellRing size={16} />
              查看 ntfy 下载指引
              <ExternalLink size={14} />
            </a>
            <a className="secondary" href="https://f-droid.org/repo/io.heckel.ntfy_63.apk" target="_blank" rel="noopener noreferrer">
              <Download size={16} />
              如果您的安卓设备无法访问 Google Play，点此直接下载 ntfy 安装包
            </a>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}
