import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  Copy,
  Database,
  Eye,
  HardDrive,
  KeyRound,
  Mail,
  Megaphone,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  UserMinus,
  Users,
} from "lucide-react";
import { useLaneStore, type SpaceAdminTab } from "@/entities/lane/store";
import {
  parseRawSystemAnnouncement,
  useWorkspaceStore,
  type V1User,
} from "@/entities/workspace/store";
import {
  apiV1,
  type AdminAuditLogItem,
  type AdminEmailSettingsDTO,
  type AdminEmailSettingsInput,
  type AdminInviteItem,
  type AdminInviteListResponse,
  type AdminOverviewResponse,
  type MemberVisibilityRule,
  type SystemAnnouncementDTO,
} from "@/shared/lib/api-v1";
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
  Select,
  Switch,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

const ADMIN_TABS: Array<{
  id: SpaceAdminTab;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}> = [
  { id: "overview", label: "概览与审计", icon: Activity },
  { id: "announcement", label: "系统通告", icon: Megaphone },
  { id: "members", label: "成员与可见性", icon: Users },
  { id: "invites", label: "邀请码治理", icon: KeyRound },
  { id: "storage", label: "存储与配额", icon: HardDrive },
  { id: "mail", label: "邮件发信", icon: Mail },
];

const QUOTA_PRESETS: Array<{ label: string; bytes: number }> = [
  { label: "512 MB", bytes: 512 * 1024 * 1024 },
  { label: "2 GB", bytes: 2 * 1024 * 1024 * 1024 },
  { label: "5 GB", bytes: 5 * 1024 * 1024 * 1024 },
  { label: "10 GB", bytes: 10 * 1024 * 1024 * 1024 },
];

const RETENTION_PRESETS: Array<{ label: string; count: number }> = [
  { label: "1,000 条", count: 1000 },
  { label: "10,000 条", count: 10000 },
  { label: "50,000 条", count: 50000 },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatShortTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mapRawAdminMember(raw: Record<string, unknown>): V1User {
  const roleRaw = String(raw.role || "member");
  const kindRaw = String(raw.kind || "human");
  const role: V1User["role"] =
    kindRaw === "bot"
      ? "bot"
      : roleRaw === "owner" || roleRaw === "admin"
        ? roleRaw
        : "member";
  return {
    id: String(raw.id || ""),
    displayName: String(raw.displayName || raw.nickname || raw.githubLogin || "成员"),
    handle: raw.githubLogin ? String(raw.githubLogin) : undefined,
    role,
    avatarUrl: raw.avatarUrl ? String(raw.avatarUrl) : undefined,
  };
}

export function SpaceAdminConsole() {
  const { adminConsoleOpen, closeAdminConsole, adminConsoleTab, setAdminConsoleTab } =
    useLaneStore();
  const { isPreviewMode, authStatus, currentUser, members } = useWorkspaceStore();

  const isSpaceManager =
    isPreviewMode ||
    (authStatus === "authenticated" &&
      (currentUser?.role === "owner" || currentUser?.role === "admin"));
  const isOwner = isPreviewMode || currentUser?.role === "owner";

  const [loading, setLoading] = useState(false);
  const [bannerError, setBannerError] = useState("");
  const [bannerSuccess, setBannerSuccess] = useState("");

  // Overview & Audit state
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogItem[]>([]);
  const [auditResultFilter, setAuditResultFilter] = useState<"all" | "success" | "rejected">("all");
  const [auditQuery, setAuditQuery] = useState("");

  // Members & Visibility state
  const [directory, setDirectory] = useState<V1User[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [selectedVisUserId, setSelectedVisUserId] = useState<string | null>(null);
  const [visRule, setVisRule] = useState<MemberVisibilityRule | null>(null);
  const [visGrantedDraft, setVisGrantedDraft] = useState<string[]>([]);
  const [savingVisibility, setSavingVisibility] = useState(false);

  // Invites state
  const [inviteData, setInviteData] = useState<AdminInviteListResponse>({
    total: 0,
    active: 0,
    acceptedUses: 0,
    availableUses: 0,
    invites: [],
  });
  const [newInviteRole, setNewInviteRole] = useState<"member" | "admin">("member");
  const [newInviteMaxUses, setNewInviteMaxUses] = useState<number>(10);
  const [newInviteHours, setNewInviteHours] = useState<number>(72);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [latestCreatedInvite, setLatestCreatedInvite] = useState<{
    code: string;
    url: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Storage & Policy state
  const [policySpaceName, setPolicySpaceName] = useState("");
  const [policyQuotaBytes, setPolicyQuotaBytes] = useState<number>(2 * 1024 * 1024 * 1024);
  const [policyRetention, setPolicyRetention] = useState<number>(10000);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [cleaningStorage, setCleaningStorage] = useState(false);

  // System Announcement state
  const [annMeta, setAnnMeta] = useState<SystemAnnouncementDTO | null>(null);
  const [annEnabled, setAnnEnabled] = useState(false);
  const [annDisplayMode, setAnnDisplayMode] = useState<"once" | "always">("once");
  const [annBadge, setAnnBadge] = useState("");
  const [annTitle, setAnnTitle] = useState("");
  const [annContent, setAnnContent] = useState("");
  const [annCtaLabel, setAnnCtaLabel] = useState("");
  const [annCtaUrl, setAnnCtaUrl] = useState("");
  const [savingAnnMode, setSavingAnnMode] = useState<"" | "save" | "repush">("");

  // Space Email SMTP state
  const [emailSettings, setEmailSettings] = useState<AdminEmailSettingsDTO | null>(null);
  const [emailDraft, setEmailDraft] = useState<AdminEmailSettingsInput>({
    enabled: false,
    smtpHost: "",
    smtpPort: 587,
    encryption: "starttls",
    username: "",
    password: "",
    fromAddress: "",
    fromName: "DualLane",
  });
  const [emailTestProof, setEmailTestProof] = useState("");
  const [emailTestedRecipient, setEmailTestedRecipient] = useState("");
  const [busyEmailAction, setBusyEmailAction] = useState<"" | "test" | "save">("");

  const loadOverviewAndAudits = useCallback(async () => {
    if (isPreviewMode) {
      const memberCount = Object.keys(members).length;
      const demoOverview: AdminOverviewResponse = {
        space: {
          id: "spc_default",
          name: "DualLane 核心协作空间",
          slug: "duallane-core",
          createdAt: new Date().toISOString(),
        },
        totals: {
          members: memberCount,
          conversations: 4,
          messages: 128,
          files: 14,
          uploadedBytes: 48 * 1024 * 1024,
        },
        today: {
          members: 1,
          conversations: 1,
          messages: 19,
          files: 3,
          uploadedBytes: 6 * 1024 * 1024,
        },
        policy: {
          dailyQuotaBytes: 2 * 1024 * 1024 * 1024,
          messageRetentionCount: 10000,
        },
        storage: {
          activeAttachments: 14,
          activeBytes: 48 * 1024 * 1024,
          pendingUploads: 0,
          pendingBytes: 0,
          reclaimableAttachments: 1,
          reclaimableBytes: 512 * 1024,
          casObjects: 12,
          casBytes: 41 * 1024 * 1024,
          recentOperatorRuns: [],
        },
        viewerRole: "owner",
      };
      setOverview(demoOverview);
      setPolicySpaceName(demoOverview.space.name);
      setPolicyQuotaBytes(demoOverview.policy.dailyQuotaBytes);
      setPolicyRetention(demoOverview.policy.messageRetentionCount);
      setAuditLogs([
        {
          id: "aud_demo_1",
          actorDisplayName: currentUser?.displayName || "Owner",
          action: "invite.create",
          targetType: "invite",
          result: "success",
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }

    const [ov, logs] = await Promise.all([
      apiV1.getAdminOverview(),
      apiV1.listAdminAuditLogs({ result: auditResultFilter, q: auditQuery, limit: 60 }),
    ]);
    setOverview(ov);
    setPolicySpaceName(ov.space.name);
    setPolicyQuotaBytes(ov.policy.dailyQuotaBytes);
    setPolicyRetention(ov.policy.messageRetentionCount);
    setAuditLogs(logs);
  }, [auditQuery, auditResultFilter, currentUser?.displayName, isPreviewMode, members]);

  const loadMembersDirectory = useCallback(async () => {
    if (isPreviewMode) {
      setDirectory(Object.values(members));
      return;
    }
    const res = await apiV1.listWorkspaceMembers();
    const list = Array.isArray(res.members) ? res.members.map(mapRawAdminMember) : [];
    setDirectory(list);
  }, [isPreviewMode, members]);

  const loadInvites = useCallback(async () => {
    if (isPreviewMode) {
      return;
    }
    const res = await apiV1.listAdminInvites();
    setInviteData(res);
  }, [isPreviewMode]);

  const loadAnnouncement = useCallback(async () => {
    if (isPreviewMode) {
      return;
    }
    const res = await apiV1.getAdminAnnouncement();
    const ann = res.announcement;
    setAnnMeta(ann || null);
    if (ann) {
      setAnnEnabled(Boolean(ann.enabled));
      setAnnDisplayMode(ann.displayMode === "always" ? "always" : "once");
      setAnnBadge(ann.badge || "");
      setAnnTitle(ann.title || "");
      setAnnContent(ann.content || "");
      setAnnCtaLabel(ann.ctaLabel || "");
      setAnnCtaUrl(ann.ctaUrl || "");
    }
  }, [isPreviewMode]);

  const loadEmailSettings = useCallback(async () => {
    if (isPreviewMode) {
      return;
    }
    const res = await apiV1.getWorkspaceEmailSettings();
    const s = res.settings;
    setEmailSettings(s);
    if (s) {
      setEmailDraft({
        enabled: s.enabled,
        smtpHost: s.smtpHost || "",
        smtpPort: s.smtpPort || 587,
        encryption: s.encryption || "starttls",
        username: s.username || "",
        password: "",
        fromAddress: s.fromAddress || "",
        fromName: s.fromName || "DualLane",
      });
    }
  }, [isPreviewMode]);

  useEffect(() => {
    if (!adminConsoleOpen || !isSpaceManager) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      try {
        if (adminConsoleTab === "overview" || adminConsoleTab === "storage") {
          await loadOverviewAndAudits();
        } else if (adminConsoleTab === "members") {
          await loadMembersDirectory();
        } else if (adminConsoleTab === "announcement") {
          await loadAnnouncement();
        } else if (adminConsoleTab === "mail") {
          await loadEmailSettings();
        } else {
          await loadInvites();
        }
      } catch (err) {
        if (!cancelled) {
          setBannerError(err instanceof Error ? err.message : "加载空间治理数据失败");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    adminConsoleOpen,
    adminConsoleTab,
    isSpaceManager,
    loadAnnouncement,
    loadEmailSettings,
    loadInvites,
    loadMembersDirectory,
    loadOverviewAndAudits,
  ]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return directory.filter((m) => {
      if (m.id === "usr_system_beacon" || m.id === "usr_system_echo") return false;
      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        (m.handle || "").toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
      );
    });
  }, [directory, memberSearch]);

  if (!isSpaceManager) {
    return null;
  }

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
    } catch {
      // Ignore clipboard permission blocks in headless contexts.
    }
  };

  const handleRoleChange = async (target: V1User, nextRole: "owner" | "admin" | "member") => {
    if (target.role === nextRole) return;
    setBannerError("");
    setBannerSuccess("");
    setBusyMemberId(target.id);
    try {
      if (!isPreviewMode) {
        await apiV1.updateMemberRole(target.id, nextRole);
      }
      setDirectory((prev) =>
        prev.map((m) => (m.id === target.id ? { ...m, role: nextRole } : m))
      );
      useWorkspaceStore.setState((s) => ({
        members: s.members[target.id]
          ? { ...s.members, [target.id]: { ...s.members[target.id], role: nextRole } }
          : s.members,
      }));
      setBannerSuccess(`已更新「${target.displayName}」权限级别`);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "修改成员权限失败");
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleRemoveMember = async (target: V1User) => {
    setBannerError("");
    setBannerSuccess("");
    setBusyMemberId(target.id);
    try {
      if (!isPreviewMode) {
        await apiV1.removeSpaceMember(target.id);
      }
      setDirectory((prev) => prev.filter((m) => m.id !== target.id));
      if (selectedVisUserId === target.id) {
        setSelectedVisUserId(null);
        setVisRule(null);
      }
      setBannerSuccess(`已将「${target.displayName}」移出空间并吊销其活跃会话`);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "移出成员失败");
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleOpenVisibility = async (target: V1User) => {
    setBannerError("");
    setSelectedVisUserId(target.id);
    try {
      if (isPreviewMode) {
        const rule: MemberVisibilityRule = {
          basis: "direct_contacts",
          viewerUserId: target.id,
          automaticUserIds: [],
          grantedUserIds: [],
          visibleUserIds: [],
        };
        setVisRule(rule);
        setVisGrantedDraft([]);
        return;
      }
      const res = await apiV1.getMemberVisibility(target.id);
      setVisRule(res.visibility);
      setVisGrantedDraft(res.visibility.grantedUserIds || []);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "读取成员可见性配置失败");
    }
  };

  const handleSaveVisibility = async () => {
    if (!selectedVisUserId) return;
    setSavingVisibility(true);
    setBannerError("");
    setBannerSuccess("");
    try {
      if (!isPreviewMode) {
        const res = await apiV1.updateMemberVisibility(selectedVisUserId, visGrantedDraft);
        setVisRule(res.visibility);
        setVisGrantedDraft(res.visibility.grantedUserIds || []);
      }
      setBannerSuccess("已保存成员通讯录可见性白名单");
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "保存可见性配置失败");
    } finally {
      setSavingVisibility(false);
    }
  };

  const handleCreateAdminInvite = async () => {
    setCreatingInvite(true);
    setBannerError("");
    setBannerSuccess("");
    try {
      if (isPreviewMode) {
        const code = `DL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const url = `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
        setLatestCreatedInvite({ code, url });
        return;
      }
      const res = await apiV1.createInvite({
        defaultRole: isOwner ? newInviteRole : "member",
        maxUses: newInviteMaxUses,
        expiresInHours: newInviteHours,
      });
      const code = res.invite?.code || res.code || "";
      const url =
        res.invite?.inviteUrl ||
        res.inviteUrl ||
        `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
      if (code) {
        setLatestCreatedInvite({ code, url });
      }
      await loadInvites();
      setBannerSuccess("已签发新空间邀请码");
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "生成邀请码失败");
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleRevokeInvite = async (item: AdminInviteItem) => {
    setBannerError("");
    setBannerSuccess("");
    try {
      if (!isPreviewMode) {
        await apiV1.revokeInvite(item.id);
        await loadInvites();
      }
      setBannerSuccess(`已吊销邀请码 ${item.codePreview}`);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "吊销邀请码失败");
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPolicy(true);
    setBannerError("");
    setBannerSuccess("");
    try {
      if (!isPreviewMode) {
        const res = await apiV1.updateAdminPolicy({
          spaceName: policySpaceName,
          dailyQuotaBytes: policyQuotaBytes,
          messageRetentionCount: policyRetention,
        });
        setPolicyQuotaBytes(res.policy.dailyQuotaBytes);
        setPolicyRetention(res.policy.messageRetentionCount);
        useWorkspaceStore.setState({ quotaLimitBytes: res.policy.dailyQuotaBytes });
        await loadOverviewAndAudits();
      }
      setBannerSuccess("已更新空间全局配额与保留策略");
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "保存空间策略失败");
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleCleanupStorage = async () => {
    setCleaningStorage(true);
    setBannerError("");
    setBannerSuccess("");
    try {
      if (!isPreviewMode) {
        const res = await apiV1.cleanupAdminStorage();
        await loadOverviewAndAudits();
        setBannerSuccess(
          `清理完成：释放预留传输 ${res.releasedTransfers} 笔，归档超时挂起附件 ${res.cleanedAttachments} 个`
        );
      } else {
        setBannerSuccess("清理完成：当前无超时挂起分片");
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "执行存储清理失败");
    } finally {
      setCleaningStorage(false);
    }
  };

  const handleFillMobilePromoTemplate = () => {
    setAnnEnabled(true);
    setAnnBadge("移动端发布");
    setAnnTitle("DualLane Android 客户端现已可用");
    setAnnContent(
      "轻量原生的 DualLane Android 客户端已上线，支持共享空间实时会话、系统通告与已绑定邮箱快捷登录。"
    );
    setAnnCtaLabel("下载 Android 安装包");
    setAnnCtaUrl(
      "https://github.com/timeStarry/duallane-mobile/releases/latest/download/app-release.apk"
    );
  };

  const handleSaveAnnouncement = async (resetAck: boolean) => {
    setBannerError("");
    setBannerSuccess("");
    if (annEnabled && (!annTitle.trim() || !annContent.trim())) {
      setBannerError("启用通告时请填写标题与正文");
      return;
    }
    setSavingAnnMode(resetAck ? "repush" : "save");
    try {
      if (isPreviewMode) {
        const previewAnn: SystemAnnouncementDTO = {
          id: resetAck || !annMeta?.id ? `ann_${Date.now()}` : annMeta.id,
          enabled: annEnabled,
          displayMode: annDisplayMode,
          badge: annBadge.trim() || undefined,
          title: annTitle.trim() || "系统通告",
          content: annContent.trim() || "通告预览正文",
          ctaLabel: annCtaLabel.trim() || undefined,
          ctaUrl: annCtaUrl.trim() || undefined,
          updatedAt: new Date().toISOString(),
          shouldShow: annEnabled,
        };
        setAnnMeta(previewAnn);
        useWorkspaceStore.setState({
          systemAnnouncement: annEnabled ? previewAnn : null,
          ...(resetAck ? { dismissedAnnouncementKey: null } : {}),
        });
        setBannerSuccess(resetAck ? "已生成新通告并全员重推" : "系统通告已保存");
        return;
      }

      const res = await apiV1.updateAdminAnnouncement({
        enabled: annEnabled,
        displayMode: annDisplayMode,
        badge: annBadge.trim(),
        title: annTitle.trim(),
        content: annContent.trim(),
        ctaLabel: annCtaLabel.trim(),
        ctaUrl: annCtaUrl.trim(),
        resetAck,
      });
      const nextAnn = parseRawSystemAnnouncement(res.announcement);
      setAnnMeta(res.announcement || null);
      if (resetAck) {
        useWorkspaceStore.setState({
          systemAnnouncement: nextAnn && nextAnn.enabled ? { ...nextAnn, shouldShow: true } : null,
          dismissedAnnouncementKey: null,
        });
      }
      setBannerSuccess(
        !annEnabled
          ? "系统通告已关闭"
          : resetAck
          ? "已作为新通告全员重推（双端登录时强提示）"
          : "系统通告已保存并同步至双端"
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "保存系统通告失败");
    } finally {
      setSavingAnnMode("");
    }
  };

  const updateEmailDraftField = <K extends keyof AdminEmailSettingsInput>(
    key: K,
    value: AdminEmailSettingsInput[K]
  ) => {
    setEmailDraft((prev) => ({ ...prev, [key]: value }));
    setEmailTestProof("");
    setEmailTestedRecipient("");
  };

  const handleTestEmailSettings = async () => {
    setBannerError("");
    setBannerSuccess("");
    setBusyEmailAction("test");
    try {
      if (isPreviewMode) {
        setEmailTestProof("proof_preview");
        setEmailTestedRecipient("owner@duallane.local");
        setBannerSuccess("测试邮件发送成功，可保存并启用");
        return;
      }
      const res = await apiV1.testWorkspaceEmailSettings(emailDraft);
      setEmailTestProof(res.testProof);
      setEmailTestedRecipient(res.recipient);
      setEmailSettings((prev) =>
        prev
          ? {
              ...prev,
              lastTestedAt: res.testedAt,
              lastTestStatus: "success",
              lastTestErrorCode: null,
            }
          : prev
      );
      setBannerSuccess(`测试邮件已发送至 ${res.recipient}，请保存以生效`);
    } catch (err) {
      setEmailTestProof("");
      setBannerError(err instanceof Error ? err.message : "测试邮件发送失败");
    } finally {
      setBusyEmailAction("");
    }
  };

  const handleSaveEmailSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBannerError("");
    setBannerSuccess("");
    setBusyEmailAction("save");
    try {
      if (isPreviewMode) {
        setBannerSuccess("邮件发信设置已保存");
        return;
      }
      const res = await apiV1.saveWorkspaceEmailSettings({
        ...emailDraft,
        ...(emailTestProof ? { testProof: emailTestProof } : {}),
      });
      setEmailSettings(res.settings);
      setEmailDraft((prev) => ({ ...prev, password: "" }));
      setEmailTestProof("");
      setEmailTestedRecipient("");
      setBannerSuccess(
        res.settings.enabled ? "空间发信邮箱已启用（同时用于通知与邮箱验证码发放）" : "发信设置已保存并停用"
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "保存邮件发信设置失败");
    } finally {
      setBusyEmailAction("");
    }
  };

  return (
    <Dialog open={adminConsoleOpen} onOpenChange={(open) => !open && closeAdminConsole()}>
      <DialogContent
        className="w-[min(920px,calc(100vw-20px))] max-narrow:w-[calc(100vw-16px)] max-w-[920px] p-0 overflow-hidden"
      >
        <DialogHeader className="bg-dl-surface-subtle/35">
          <DialogTitle className="flex items-center gap-2.5">
            <BrandLogo size={26} withTile />
            <span className="tracking-[-0.025em]">空间治理台</span>
          </DialogTitle>
          <DialogDescription className="sr-only">空间治理与策略设置</DialogDescription>
        </DialogHeader>

        <div className="flex max-compact:flex-col h-[min(620px,calc(88dvh-84px))] min-h-0">
          {/* Navigation Rail (Vertical on Desktop, Clean 2x2 Grid Below Header on Mobile) */}
          <nav
            aria-label="空间治理模块"
            className="w-48 max-compact:w-full shrink-0 border-r max-compact:border-r-0 max-compact:border-b border-dl-border-hairline bg-dl-surface-subtle/45 p-3.5 max-compact:p-2.5 flex flex-col max-compact:grid max-compact:grid-cols-2 gap-1.5"
          >
            {ADMIN_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = adminConsoleTab === tab.id;
              return (
                <Button
                  key={tab.id}
                  type="button"
                  variant={active ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => {
                    setBannerError("");
                    setBannerSuccess("");
                    setAdminConsoleTab(tab.id);
                  }}
                  className={cn(
                    "justify-start gap-2 rounded-xl px-3 py-2 max-compact:px-2 max-compact:py-1.5 text-xs font-medium shrink-0 min-w-0",
                    !active && "text-dl-text-secondary hover:text-dl-text-primary"
                  )}
                >
                  <Icon className="size-3.5 shrink-0" strokeWidth={1.85} />
                  <span className="truncate">{tab.label}</span>
                </Button>
              );
            })}
          </nav>

          {/* Right Workspace Panel */}
          <div className="dl-scroll flex-1 overflow-y-auto p-5 max-compact:p-3.5 space-y-4">
            {bannerError && (
              <div className="rounded-xl border border-dl-danger/30 bg-dl-danger/10 px-3.5 py-2 text-xs text-dl-danger">
                {bannerError}
              </div>
            )}
            {bannerSuccess && (
              <div className="rounded-xl border border-dl-success/30 bg-dl-success/10 px-3.5 py-2 text-xs text-dl-text-primary">
                {bannerSuccess}
              </div>
            )}

            {/* TAB 1: Overview & Security Audit Logs */}
            {adminConsoleTab === "overview" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-dl-text-primary">
                    {overview?.space.name || "共享空间运行概览"}
                  </h3>
                  <Button
                    size="sm"
                    variant="secondary"
                    busy={loading}
                    onClick={() => void loadOverviewAndAudits()}
                    className="gap-1.5"
                  >
                    <RefreshCw className="size-3.5" strokeWidth={1.9} />
                    刷新数据
                  </Button>
                </div>

                <div className="grid grid-cols-2 wide:grid-cols-4 gap-2.5">
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3.5 space-y-1">
                    <div className="text-xs text-dl-text-secondary">活跃成员</div>
                    <div className="text-lg font-bold tabular-nums text-dl-text-primary">
                      {overview?.totals.members ?? 0}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      今日新增 +{overview?.today.members ?? 0}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3.5 space-y-1">
                    <div className="text-xs text-dl-text-secondary">累计消息</div>
                    <div className="text-lg font-bold tabular-nums text-dl-text-primary">
                      {overview?.totals.messages ?? 0}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      今日 +{overview?.today.messages ?? 0} · {overview?.totals.conversations ?? 0} 个会话
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3.5 space-y-1">
                    <div className="text-xs text-dl-text-secondary">空间文件占用</div>
                    <div className="text-lg font-bold tabular-nums text-dl-text-primary">
                      {formatBytes(overview?.totals.uploadedBytes ?? 0)}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      共 {overview?.totals.files ?? 0} 个可用附件
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3.5 space-y-1">
                    <div className="text-xs text-dl-text-secondary">单人日配额策略</div>
                    <div className="text-lg font-bold tabular-nums text-dl-text-primary">
                      {formatBytes(overview?.policy.dailyQuotaBytes ?? 2 * 1024 * 1024 * 1024)}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      保留上限 {overview?.policy.messageRetentionCount ?? 10000} 条/会话
                    </div>
                  </div>
                </div>

                {/* Security Audit Trail */}
                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/35 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                      <ShieldCheck className="size-4 text-dl-lane-shared" strokeWidth={1.9} />
                      安全与治理审计日志
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SegmentedControl<"all" | "success" | "rejected">
                        label="审计结果筛选"
                        value={auditResultFilter}
                        onValueChange={setAuditResultFilter}
                        options={[
                          { value: "all", label: "全部" },
                          { value: "success", label: "成功" },
                          { value: "rejected", label: "拦截" },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Input
                      value={auditQuery}
                      onChange={(e) => setAuditQuery(e.target.value)}
                      placeholder="按动作（如 invite.create / member.role_update）、成员或 IP 过滤…"
                      aria-label="过滤审计日志"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void loadOverviewAndAudits()}
                    >
                      查询
                    </Button>
                  </div>

                  <div className="space-y-1.5 max-h-[290px] overflow-y-auto dl-scroll">
                    {auditLogs.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-dl-border-hairline p-4 text-center text-xs text-dl-text-secondary">
                        暂无匹配的审计记录
                      </div>
                    ) : (
                      auditLogs.map((log) => (
                        <div
                          key={log.id}
                          data-testid="admin-audit-row"
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dl-border-hairline bg-dl-surface-canvas/70 px-3 py-2 text-xs"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-dl-text-primary">
                                {log.actorDisplayName}
                              </span>
                              <span className="rounded-md bg-dl-surface-subtle px-1.5 py-0.5 font-mono text-[11px] text-dl-text-primary">
                                {log.action}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  log.result === "success"
                                    ? "bg-dl-success/15 text-dl-text-primary"
                                    : "bg-dl-danger/15 text-dl-danger"
                                )}
                              >
                                {log.result === "success"
                                  ? "成功"
                                  : log.result === "rejected"
                                    ? "已拦截"
                                    : "失败"}
                              </span>
                            </div>
                            <div className="text-[11px] text-dl-text-secondary truncate">
                              目标：{log.targetType}
                              {log.targetId ? ` (${log.targetId.slice(0, 12)})` : ""}
                              {log.reason ? ` · 原因：${log.reason}` : ""}
                              {log.ipAddress ? ` · IP：${log.ipAddress}` : ""}
                            </div>
                          </div>
                          <div className="text-[11px] tabular-nums text-dl-text-secondary shrink-0">
                            {formatShortTime(log.createdAt)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: Members, Roles & Visibility Matrix */}
            {adminConsoleTab === "members" && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-dl-text-primary">
                  成员与通讯录可见性
                </h3>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-dl-text-secondary" />
                  <Input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="搜索成员昵称、GitHub 账号或 ID…"
                    aria-label="搜索空间成员"
                    className="pl-9"
                  />
                </div>

                <div className="space-y-2">
                  {filteredMembers.map((m) => {
                    const isSelf = m.id === currentUser?.id;
                    const isBot = m.role === "bot";
                    return (
                      <div
                        key={m.id}
                        data-testid={`admin-member-row-${m.id}`}
                        className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/45 p-3"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar
                            name={m.displayName}
                            src={m.avatarUrl}
                            kind={isBot ? "bot" : "human"}
                            color={m.avatarColor}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="truncate text-xs font-semibold text-dl-text-primary">
                                {m.displayName}
                              </span>
                              {isSelf && (
                                <span className="rounded-full bg-dl-lane-shared/15 px-1.5 py-0.5 text-[10px] font-semibold text-dl-lane-shared">
                                  当前登录
                                </span>
                              )}
                              {isBot && (
                                <span className="rounded-full bg-dl-surface-subtle px-1.5 py-0.5 text-[10px] font-medium text-dl-text-secondary">
                                  机器人
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-dl-text-secondary truncate">
                              {m.handle ? `@${m.handle} · ` : ""}
                              {m.role === "owner"
                                ? "Owner（空间主理人）"
                                : m.role === "admin"
                                  ? "Admin（协管员）"
                                  : isBot
                                    ? "智能体集成"
                                    : "Member（普通成员）"}
                            </div>
                          </div>
                        </div>

                        {!isBot && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {isOwner && (
                              <Select
                                label={`${m.displayName} 权限角色`}
                                disabled={busyMemberId === m.id}
                                value={m.role}
                                onValueChange={(val) =>
                                  void handleRoleChange(
                                    m,
                                    val as "owner" | "admin" | "member"
                                  )
                                }
                                options={[
                                  { value: "member", label: "普通成员" },
                                  { value: "admin", label: "协管员 (Admin)" },
                                  { value: "owner", label: "主理人 (Owner)" },
                                ]}
                                className="h-7 w-36 rounded-lg px-2.5 text-xs"
                              />
                            )}

                            {isOwner && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 gap-1 px-2.5 text-xs"
                                onClick={() => void handleOpenVisibility(m)}
                              >
                                <Eye className="size-3.5" strokeWidth={1.85} />
                                可见性
                              </Button>
                            )}

                            {isOwner && !isSelf && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyMemberId === m.id}
                                className="h-7 gap-1 px-2 text-xs text-dl-danger hover:bg-dl-danger/10"
                                onClick={() => void handleRemoveMember(m)}
                              >
                                <UserMinus className="size-3.5" strokeWidth={1.85} />
                                移出
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Per-Member Visibility Matrix Drawer Card */}
                {selectedVisUserId && visRule && (
                  <div className="rounded-2xl border border-dl-lane-shared/35 bg-dl-lane-shared/6 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-dl-text-primary">
                          通讯录可见性隔离矩阵 ·{" "}
                          {directory.find((u) => u.id === selectedVisUserId)?.displayName ||
                            selectedVisUserId}
                        </div>
                        <p className="text-[11px] text-dl-text-secondary">
                          除已有私聊往来的联系人外，勾选允许该成员在空间名录中直接看到的成员：
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => {
                          setSelectedVisUserId(null);
                          setVisRule(null);
                        }}
                      >
                        收起
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 compact:grid-cols-2 gap-2 max-h-48 overflow-y-auto dl-scroll">
                      {directory
                        .filter(
                          (peer) =>
                            peer.id !== selectedVisUserId &&
                            peer.role !== "bot" &&
                            peer.id !== "usr_system_beacon" &&
                            peer.id !== "usr_system_echo"
                        )
                        .map((peer) => {
                          const isAuto = visRule.automaticUserIds?.includes(peer.id);
                          const isGranted = visGrantedDraft.includes(peer.id);
                          return (
                            <label
                              key={peer.id}
                              className="flex items-center justify-between gap-2 rounded-xl border border-dl-border-hairline bg-dl-surface-canvas/80 px-3 py-2 text-xs cursor-pointer"
                            >
                              <span className="truncate font-medium text-dl-text-primary">
                                {peer.displayName}
                              </span>
                              {isAuto ? (
                                <span className="text-[10px] font-medium text-dl-text-secondary">
                                  自动可见（已建联）
                                </span>
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={isGranted}
                                  onChange={(e) => {
                                    setVisGrantedDraft((prev) =>
                                      e.target.checked
                                        ? [...prev, peer.id]
                                        : prev.filter((id) => id !== peer.id)
                                    );
                                  }}
                                  className="h-4 w-4 accent-sky-500"
                                />
                              )}
                            </label>
                          );
                        })}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="primary"
                        busy={savingVisibility}
                        onClick={() => void handleSaveVisibility()}
                      >
                        保存可见性白名单
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: Invite Lifecycle Management */}
            {adminConsoleTab === "invites" && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-dl-text-primary">邀请码管理</h3>

                <div className="grid grid-cols-3 gap-2.5">
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3">
                    <div className="text-xs text-dl-text-secondary">当前有效</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {inviteData.active} 枚
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3">
                    <div className="text-xs text-dl-text-secondary">剩余可用名额</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {inviteData.availableUses} 次
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3">
                    <div className="text-xs text-dl-text-secondary">累计核销加入</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {inviteData.acceptedUses} 人
                    </div>
                  </div>
                </div>

                {/* Invite Issuance Card */}
                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/45 p-4 space-y-3">
                  <div className="text-xs font-semibold text-dl-text-primary">签发新邀请码</div>
                  <div className="grid grid-cols-1 compact:grid-cols-3 gap-2.5 text-xs">
                    <div className="space-y-1">
                      <span className="text-dl-text-secondary">默认赋予角色</span>
                      <Select
                        label="邀请默认角色"
                        value={isOwner ? newInviteRole : "member"}
                        disabled={!isOwner}
                        onValueChange={(val) => setNewInviteRole(val as "member" | "admin")}
                        options={
                          isOwner
                            ? [
                                { value: "member", label: "普通成员 (Member)" },
                                { value: "admin", label: "协管员 (Admin)" },
                              ]
                            : [{ value: "member", label: "普通成员 (Member)" }]
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-dl-text-secondary">最大使用次数</span>
                      <Select
                        label="邀请最大使用次数"
                        value={String(newInviteMaxUses)}
                        onValueChange={(val) => setNewInviteMaxUses(Number(val))}
                        options={[
                          { value: "1", label: "1 次（单人专属）" },
                          { value: "5", label: "5 次" },
                          { value: "10", label: "10 次" },
                          { value: "50", label: "50 次" },
                        ]}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-dl-text-secondary">有效期</span>
                      <Select
                        label="邀请有效期"
                        value={String(newInviteHours)}
                        onValueChange={(val) => setNewInviteHours(Number(val))}
                        options={[
                          { value: "24", label: "24 小时" },
                          { value: "72", label: "72 小时（3 天）" },
                          { value: "168", label: "7 天" },
                          { value: "720", label: "30 天" },
                        ]}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="primary"
                      busy={creatingInvite}
                      onClick={() => void handleCreateAdminInvite()}
                    >
                      签发邀请码
                    </Button>
                  </div>

                  {latestCreatedInvite && (
                    <div className="rounded-xl border border-dl-lane-shared/35 bg-dl-lane-shared/8 p-3 space-y-2">
                      <div className="text-[11px] font-medium text-dl-text-secondary">
                        完整邀请码仅在签发时明文展示一次，请立即复制分发：
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code
                          data-testid="admin-created-invite-code"
                          className="font-mono text-xs font-bold text-dl-text-primary select-all"
                        >
                          {latestCreatedInvite.code}
                        </code>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 gap-1 text-xs"
                            onClick={() => void copyText("code", latestCreatedInvite.code)}
                          >
                            {copiedKey === "code" ? (
                              <Check className="size-3.5 text-dl-success" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                            复制邀请码
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 gap-1 text-xs"
                            onClick={() => void copyText("url", latestCreatedInvite.url)}
                          >
                            {copiedKey === "url" ? (
                              <Check className="size-3.5 text-dl-success" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                            复制完整链接
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Invite History List */}
                <div className="space-y-2">
                  {inviteData.invites.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-dl-border-hairline p-4 text-center text-xs text-dl-text-secondary">
                      暂无已签发的邀请码记录
                    </div>
                  ) : (
                    inviteData.invites.map((item) => (
                      <div
                        key={item.id}
                        data-testid={`admin-invite-row-${item.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2.5 text-xs"
                      >
                        <div className="space-y-0.5 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold text-dl-text-primary">
                              {item.codePreview}
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                item.status === "active"
                                  ? "bg-dl-success/15 text-dl-text-primary"
                                  : "bg-dl-surface-subtle text-dl-text-secondary"
                              )}
                            >
                              {item.status === "active"
                                ? "有效"
                                : item.status === "revoked"
                                  ? "已吊销"
                                  : item.status === "expired"
                                    ? "已过期"
                                    : "名额已满"}
                            </span>
                            <span className="text-[11px] text-dl-text-secondary">
                              已用 {item.uses}/{item.maxUses}
                            </span>
                          </div>
                          <div className="text-[11px] text-dl-text-secondary">
                            角色：{item.defaultRole === "admin" ? "Admin" : "Member"} · 创建于{" "}
                            {formatShortTime(item.createdAt)}
                            {item.expiresAt ? ` · 到期 ${formatShortTime(item.expiresAt)}` : ""}
                          </div>
                        </div>

                        {item.status === "active" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 px-2.5 text-xs text-dl-danger hover:bg-dl-danger/10"
                            onClick={() => void handleRevokeInvite(item)}
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.85} />
                            吊销
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: Storage, Quota Policy & CAS Snapshots */}
            {adminConsoleTab === "storage" && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-dl-text-primary">存储与配额策略</h3>

                {/* Storage Breakdown */}
                <div className="grid grid-cols-2 wide:grid-cols-4 gap-2.5">
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3 space-y-0.5">
                    <div className="text-xs text-dl-text-secondary">活跃附件占用</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {formatBytes(overview?.storage.activeBytes ?? 0)}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      {overview?.storage.activeAttachments ?? 0} 个可用文件
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3 space-y-0.5">
                    <div className="text-xs text-dl-text-secondary">CAS 去重对象池</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {formatBytes(overview?.storage.casBytes ?? 0)}
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      {overview?.storage.casObjects ?? 0} 个唯一 SHA-256 实体
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3 space-y-0.5">
                    <div className="text-xs text-dl-text-secondary">传输中挂起分片</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {overview?.storage.pendingUploads ?? 0} 笔
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      预占 {formatBytes(overview?.storage.pendingBytes ?? 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3 space-y-0.5">
                    <div className="text-xs text-dl-text-secondary">失败/已移除记录</div>
                    <div className="text-base font-bold tabular-nums text-dl-text-primary">
                      {overview?.storage.reclaimableAttachments ?? 0} 个
                    </div>
                    <div className="text-[11px] text-dl-text-secondary">
                      累计 {formatBytes(overview?.storage.reclaimableBytes ?? 0)}
                    </div>
                  </div>
                </div>

                {/* Quota & Retention Policy Editor */}
                <form
                  onSubmit={handleSavePolicy}
                  className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/45 p-4 space-y-3.5"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                    <SlidersHorizontal className="size-4 text-dl-lane-shared" strokeWidth={1.9} />
                    全局空间名称与配额策略
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs text-dl-text-secondary" htmlFor="admin-space-name">
                      空间名称
                    </label>
                    <Input
                      id="admin-space-name"
                      value={policySpaceName}
                      disabled={!isOwner}
                      onChange={(e) => setPolicySpaceName(e.target.value)}
                      placeholder="共享空间名称"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs text-dl-text-secondary">单成员每日传输配额上限</div>
                    <div className="flex flex-wrap gap-2">
                      {QUOTA_PRESETS.map((preset) => (
                        <Button
                          key={preset.bytes}
                          type="button"
                          size="sm"
                          variant={policyQuotaBytes === preset.bytes ? "primary" : "secondary"}
                          disabled={!isOwner}
                          onClick={() => setPolicyQuotaBytes(preset.bytes)}
                          className="h-8 px-3 text-xs"
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs text-dl-text-secondary">单会话消息保留条数上限</div>
                    <div className="flex flex-wrap gap-2">
                      {RETENTION_PRESETS.map((preset) => (
                        <Button
                          key={preset.count}
                          type="button"
                          size="sm"
                          variant={policyRetention === preset.count ? "primary" : "secondary"}
                          disabled={!isOwner}
                          onClick={() => setPolicyRetention(preset.count)}
                          className="h-8 px-3 text-xs"
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {isOwner && (
                    <div className="flex justify-end">
                      <Button type="submit" size="sm" variant="primary" busy={savingPolicy}>
                        保存空间策略
                      </Button>
                    </div>
                  )}
                </form>

                {/* Storage Maintenance & Operator Runs */}
                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-dl-text-primary">
                        <Database className="size-4 text-dl-lane-shared" strokeWidth={1.9} />
                        分片回收与存储算子状态
                      </div>
                      <p className="text-[11px] text-dl-text-secondary">
                        释放超过 15 分钟未完成的挂起上传分片与传输账本预占额度
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      busy={cleaningStorage}
                      onClick={() => void handleCleanupStorage()}
                    >
                      清理超时挂起上传
                    </Button>
                  </div>

                  {overview?.storage.recentOperatorRuns &&
                    overview.storage.recentOperatorRuns.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        <div className="text-[11px] font-medium text-dl-text-secondary">
                          最近存储迁移 / Backfill 记录：
                        </div>
                        {overview.storage.recentOperatorRuns.map((run) => (
                          <div
                            key={run.id}
                            className="flex items-center justify-between rounded-xl border border-dl-border-hairline bg-dl-surface-canvas/70 px-3 py-2 text-xs"
                          >
                            <span>
                              {run.operation} ({run.phase}) · {run.processedItems}/{run.totalItems}
                            </span>
                            <span className="font-mono text-[11px] text-dl-text-secondary">
                              {run.state}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* TAB 5: System-Wide Modal Announcement */}
            {adminConsoleTab === "announcement" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-dl-text-primary">
                      系统级强提示通告
                    </h3>
                    <p className="text-xs text-dl-text-secondary">
                      成员登录 PC 或移动端后弹出模态框强提示，适用于移动端推广、版本变更与重要通知。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={handleFillMobilePromoTemplate}
                  >
                    <Smartphone className="size-3.5" strokeWidth={1.9} />
                    填入移动端推广模板
                  </Button>
                </div>

                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-dl-text-primary">启用全员弹窗通告</div>
                      <div className="text-[11px] text-dl-text-tertiary">
                        {annMeta?.updatedAt
                          ? `最近更新：${formatShortTime(annMeta.updatedAt)}`
                          : "尚未发布过系统通告"}
                      </div>
                    </div>
                    <Switch
                      label="启用全员弹窗通告"
                      checked={annEnabled}
                      onCheckedChange={setAnnEnabled}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-dl-text-primary">展示策略</div>
                    <SegmentedControl
                      label="通告展示策略"
                      value={annDisplayMode}
                      onValueChange={(v) => setAnnDisplayMode(v as "once" | "always")}
                      options={[
                        { value: "once", label: "任一端见过一次即可" },
                        { value: "always", label: "每次登录一直显示" },
                      ]}
                    />
                    <p className="text-[11px] text-dl-text-tertiary">
                      {annDisplayMode === "once"
                        ? "成员在 PC 或移动端任意一端点击确认后，服务端记录已读，双端均不再重复弹出。"
                        : "每次成员登录或重新进入会话均会弹出提醒，直至关闭通告或切换为见过一次即可。"}
                    </p>
                  </div>

                  <div className="grid grid-cols-3 max-compact:grid-cols-1 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">角标标签（可选）</label>
                      <Input
                        value={annBadge}
                        onChange={(e) => setAnnBadge(e.target.value)}
                        placeholder="如：移动端发布"
                        maxLength={24}
                      />
                    </div>
                    <div className="col-span-2 max-compact:col-span-1 space-y-1">
                      <label className="text-xs text-dl-text-secondary">通告标题</label>
                      <Input
                        value={annTitle}
                        onChange={(e) => setAnnTitle(e.target.value)}
                        placeholder="简洁明确的弹窗主标题"
                        maxLength={80}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-dl-text-secondary">通告正文</label>
                    <textarea
                      rows={4}
                      value={annContent}
                      onChange={(e) => setAnnContent(e.target.value)}
                      placeholder="输入通告正文，支持换行展示…"
                      className="w-full rounded-xl border border-dl-border-hairline bg-control/60 px-3.5 py-2.5 text-sm text-dl-text-primary placeholder:text-dl-text-tertiary focus:outline-none focus:ring-2 focus:ring-dl-lane-shared/40"
                    />
                  </div>

                  <div className="grid grid-cols-2 max-compact:grid-cols-1 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">主按钮文案（可选）</label>
                      <Input
                        value={annCtaLabel}
                        onChange={(e) => setAnnCtaLabel(e.target.value)}
                        placeholder="如：下载 Android 安装包"
                        maxLength={32}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">跳转或下载链接（可选）</label>
                      <Input
                        value={annCtaUrl}
                        onChange={(e) => setAnnCtaUrl(e.target.value)}
                        placeholder="https://..."
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      busy={savingAnnMode === "repush"}
                      disabled={Boolean(savingAnnMode)}
                      onClick={() => void handleSaveAnnouncement(true)}
                    >
                      作为新通告全员重推
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      busy={savingAnnMode === "save"}
                      disabled={Boolean(savingAnnMode)}
                      onClick={() => void handleSaveAnnouncement(false)}
                    >
                      保存通告
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 6: Space SMTP Email Sender */}
            {adminConsoleTab === "mail" && (
              <form onSubmit={handleSaveEmailSettings} className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-dl-text-primary">
                      空间通知与验证码发信邮箱
                    </h3>
                    <p className="text-xs text-dl-text-secondary">
                      离线通知邮件与成员邮箱绑定、登录验证码统一使用此 SMTP 发信通道。
                    </p>
                  </div>
                  <Switch
                    label="启用空间邮件服务"
                    checked={emailDraft.enabled}
                    disabled={!isOwner || Boolean(busyEmailAction)}
                    onCheckedChange={(v) => updateEmailDraftField("enabled", v)}
                  />
                </div>

                <div className="grid grid-cols-3 max-compact:grid-cols-1 gap-2.5">
                  <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2.5">
                    <div className="text-[11px] text-dl-text-tertiary">当前发信状态</div>
                    <div className="mt-0.5 text-xs font-semibold text-dl-text-primary">
                      {emailSettings?.enabled ? "已启用" : "未启用"}
                      {emailSettings?.activeFrom ? ` · ${emailSettings.activeFrom}` : ""}
                    </div>
                  </div>
                  <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2.5">
                    <div className="text-[11px] text-dl-text-tertiary">最近连通测试</div>
                    <div className="mt-0.5 text-xs font-semibold text-dl-text-primary">
                      {emailSettings?.lastTestedAt ? formatShortTime(emailSettings.lastTestedAt) : "暂无"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 px-3.5 py-2.5">
                    <div className="text-[11px] text-dl-text-tertiary">最近发信投递</div>
                    <div className="mt-0.5 text-xs font-semibold text-dl-text-primary">
                      {emailSettings?.lastDeliveryAt ? formatShortTime(emailSettings.lastDeliveryAt) : "暂无"}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-4 space-y-3.5">
                  <div className="grid grid-cols-3 max-compact:grid-cols-1 gap-3">
                    <div className="col-span-2 max-compact:col-span-1 space-y-1">
                      <label className="text-xs text-dl-text-secondary">SMTP 服务器</label>
                      <Input
                        value={emailDraft.smtpHost}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("smtpHost", e.target.value)}
                        placeholder="smtp.example.com"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">端口</label>
                      <Input
                        type="number"
                        value={String(emailDraft.smtpPort)}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("smtpPort", Number(e.target.value) || 587)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-dl-text-secondary">加密传输</label>
                    <SegmentedControl
                      label="SMTP 加密方式"
                      value={emailDraft.encryption}
                      onValueChange={(v) =>
                        updateEmailDraftField("encryption", v as "starttls" | "tls" | "none")
                      }
                      options={[
                        { value: "starttls", label: "STARTTLS" },
                        { value: "tls", label: "SSL / TLS" },
                        { value: "none", label: "无加密" },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-2 max-compact:grid-cols-1 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">SMTP 用户名</label>
                      <Input
                        value={emailDraft.username}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("username", e.target.value)}
                        placeholder="user@example.com"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">SMTP 密码 / 授权码</label>
                      <Input
                        type="password"
                        value={emailDraft.password || ""}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("password", e.target.value)}
                        placeholder={emailSettings?.passwordConfigured ? "留空则保留已加密保存的密码" : "输入密码或客户端授权码"}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 max-compact:grid-cols-1 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">发信地址</label>
                      <Input
                        type="email"
                        value={emailDraft.fromAddress}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("fromAddress", e.target.value)}
                        placeholder="留空默认使用邮箱格式用户名"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dl-text-secondary">发件人名称</label>
                      <Input
                        value={emailDraft.fromName}
                        disabled={!isOwner || Boolean(busyEmailAction)}
                        onChange={(e) => updateEmailDraftField("fromName", e.target.value)}
                        placeholder="DualLane"
                      />
                    </div>
                  </div>

                  {emailTestProof && emailTestedRecipient && (
                    <div className="text-xs text-dl-success">
                      已通过发信验证（收件地址：{emailTestedRecipient}），10 分钟内可直接保存启用。
                    </div>
                  )}

                  {isOwner && (
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        busy={busyEmailAction === "test"}
                        disabled={Boolean(busyEmailAction)}
                        onClick={() => void handleTestEmailSettings()}
                      >
                        发送测试邮件
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        busy={busyEmailAction === "save"}
                        disabled={Boolean(busyEmailAction) || (emailDraft.enabled && !emailTestProof && !emailSettings?.enabled)}
                      >
                        保存发信设置
                      </Button>
                    </div>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
