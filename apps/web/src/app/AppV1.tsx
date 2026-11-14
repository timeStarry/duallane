import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { motion } from "motion/react";
import {
  inferLaneFromLocation,
  inferMobileViewFromLocation,
  useLaneStore,
} from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { extractP2PRoomFromUrl } from "@/shared/lib/p2p-lane";
import { BrandLogo, Button, Input, TooltipProvider } from "@/shared/ui";
import { CommandSearchModal } from "@/widgets/CommandSearchModal";
import { ConversationSidebar } from "@/widgets/ConversationSidebar";
import { InspectorPane } from "@/widgets/InspectorPane";
import { MediaLightbox } from "@/widgets/MediaLightbox";
import { PrimaryRail } from "@/widgets/PrimaryRail";
import { SettingsModal } from "@/widgets/SettingsModal";
import { TimelinePane } from "@/widgets/TimelinePane";

const SpaceAdminConsole = React.lazy(() =>
  import("@/widgets/SpaceAdminConsole").then((m) => ({ default: m.SpaceAdminConsole }))
);

export function AppV1() {
  const { activeLane, mobileView, setActiveLane, adminConsoleOpen } = useLaneStore();
  const {
    isPreviewMode,
    authStatus,
    currentUser,
    p2pRoom,
    workspaceAvailability,
    workspaceStatusMessage,
    bootstrapWorkspace,
    acceptInviteAndBootstrap,
    joinP2PRoom,
    createP2PRoom,
  } = useWorkspaceStore();

  const isSpaceManager =
    isPreviewMode ||
    (authStatus === "authenticated" &&
      (currentUser?.role === "owner" || currentUser?.role === "admin"));

  const [inviteCode, setInviteCode] = useState(() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.search);
    return params.get("invite") || "";
  });
  const [devDisplayName, setDevDisplayName] = useState("");
  const [authError, setAuthError] = useState(() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get("authError") || params.get("error") || "";
    if (!errParam) return "";
    const desc = params.get("error_description") || "";
    if (errParam === "access_denied") {
      return "GitHub 授权已取消，如需进入共享空间请重新发起登录。";
    }
    return desc ? `登录验证未完成：${desc}` : `登录验证未完成 (${errParam})`;
  });
  const [submitting, setSubmitting] = useState(false);
  const [probingBackend, setProbingBackend] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("error") || params.has("error_description") || params.has("authError")) {
      params.delete("error");
      params.delete("error_description");
      params.delete("authError");
      const rest = params.toString();
      const nextUrl = `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    const syncRouteFromLocation = () => {
      const p2p = extractP2PRoomFromUrl();
      if (p2p) {
        const currentRoom = useWorkspaceStore.getState().p2pRoom;
        useLaneStore.setState({ activeLane: "p2p", mobileView: "chat" });
        if (currentRoom?.roomId === p2p.roomId && currentRoom.shareUrl === window.location.href) {
          return;
        }
        void joinP2PRoom(p2p.roomId, p2p.keyStr);
        return;
      }
      const nextLane = inferLaneFromLocation(window.location);
      const nextMobileView = inferMobileViewFromLocation(window.location);
      useLaneStore.setState({ activeLane: nextLane, mobileView: nextMobileView });
    };

    syncRouteFromLocation();
    void bootstrapWorkspace();

    window.addEventListener("popstate", syncRouteFromLocation);
    window.addEventListener("hashchange", syncRouteFromLocation);
    return () => {
      window.removeEventListener("popstate", syncRouteFromLocation);
      window.removeEventListener("hashchange", syncRouteFromLocation);
    };
  }, [bootstrapWorkspace, joinP2PRoom]);

  // Keep browser address bar canonically aligned with activeLane so page refresh restores the exact lane
  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.replaceState) return;
    const pathname = window.location.pathname || "/";
    const search = window.location.search || "";

    if (activeLane === "p2p") {
      if (p2pRoom?.shareUrl && mobileView === "chat") {
        try {
          const parsed = new URL(p2pRoom.shareUrl);
          const target = `${parsed.pathname}${parsed.hash}`;
          if (`${pathname}${window.location.hash}` !== target) {
            window.history.replaceState(null, "", target);
          }
          return;
        } catch {
          // Fall through if shareUrl is non-standard
        }
      }
      const urlHasValidRoom = Boolean(extractP2PRoomFromUrl(window.location));
      if (!urlHasValidRoom && (pathname !== "/direct" || window.location.hash !== "")) {
        window.history.replaceState(null, "", "/direct");
      }
      return;
    }

    // activeLane === "workspace"
    if (authStatus === "authenticated") {
      const params = new URLSearchParams(search);
      params.delete("invite");
      const rest = params.toString();
      const target = `/workspace${rest ? `?${rest}` : ""}`;
      if (`${pathname}${search}${window.location.hash}` !== target) {
        window.history.replaceState(null, "", target);
      }
    }
  }, [activeLane, authStatus, mobileView, p2pRoom]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setActiveLane("workspace");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "2") {
        e.preventDefault();
        setActiveLane("p2p");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        const current = useLaneStore.getState().activeLane;
        setActiveLane(current === "workspace" ? "p2p" : "workspace");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveLane]);

  const handleRetryBackend = async () => {
    setAuthError("");
    setProbingBackend(true);
    try {
      await bootstrapWorkspace();
    } finally {
      setProbingBackend(false);
    }
  };

  const handleGitHubSignIn = async () => {
    setAuthError("");
    if (workspaceAvailability !== "ready") {
      setProbingBackend(true);
      try {
        await bootstrapWorkspace();
      } finally {
        setProbingBackend(false);
      }
      const nextState = useWorkspaceStore.getState();
      if (nextState.authStatus === "authenticated") {
        return;
      }
      if (nextState.workspaceAvailability !== "ready") {
        setAuthError(
          nextState.workspaceStatusMessage ||
            "共享空间后端当前不可用，已拦截页面跳转以避免 HTTP 500 错误页。"
        );
        return;
      }
    }
    window.location.assign(apiV1.getGitHubStartUrl(inviteCode));
  };

  const handleInviteQuickAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setAuthError("");
    setSubmitting(true);
    try {
      const trimmedName = devDisplayName.trim();
      if (trimmedName) {
        const suffix = crypto.randomUUID().slice(0, 6);
        await acceptInviteAndBootstrap(inviteCode, {
          githubId: `dev_${suffix}`,
          githubLogin: `member_${suffix}`,
          email: `member_${suffix}@duallane.local`,
          displayName: trimmedName,
        });
      } else {
        await acceptInviteAndBootstrap(inviteCode);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "邀请码验证失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (authStatus === "checking" && activeLane !== "p2p") {
    return (
      <main className="dl-canvas-ambient flex h-screen w-screen items-center justify-center">
        <div className="dl-glass-elevated flex items-center gap-3 rounded-dialog px-5 py-3.5 text-sm text-dl-text-secondary">
          <BrandLogo size={32} withTile animated />
          <span>正在连接 DualLane v1.0…</span>
        </div>
      </main>
    );
  }

  if (authStatus !== "authenticated" && activeLane !== "p2p") {
    const showServiceBanner =
      workspaceAvailability === "disabled" || workspaceAvailability === "unreachable";

    return (
      <main
        aria-label="DualLane 登录与通道入口"
        className="dl-canvas-ambient flex min-h-dvh w-screen items-center justify-center px-6 py-8 max-compact:px-4 max-compact:py-6 max-narrow:px-3 max-narrow:py-4"
      >
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 360, damping: 32 }}
          className="w-full max-w-[940px] space-y-7 max-compact:space-y-5 max-narrow:space-y-4"
        >
          {/* Architectural Brand Stage Header */}
          <header className="flex flex-col items-center text-center space-y-2.5 max-narrow:space-y-2">
            <div className="flex items-center gap-3">
              <BrandLogo size={48} withTile animated />
              <div className="text-left">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold tracking-[-0.03em] text-dl-text-primary">
                    DualLane
                  </span>
                  <span className="rounded-full bg-dl-lane-shared/14 px-2 py-0.5 text-[11px] font-semibold text-dl-lane-shared">
                    v1.0
                  </span>
                </div>
                <div className="text-[11px] font-mono text-dl-text-secondary">
                  Two Trust Lanes. Crystal Clear.
                </div>
              </div>
            </div>
            <h1 className="text-2xl max-compact:text-xl max-narrow:text-lg font-bold tracking-[-0.03em] text-dl-text-primary pt-1">
              选择沟通方式，两条通道各司其职
            </h1>
            <p className="max-w-[540px] text-sm max-narrow:text-xs text-dl-text-secondary leading-relaxed">
              临时敏感交谈走免登录一对一直连，熟人与团队持续协作进入受邀共享空间。
            </p>
          </header>

          {/* Grand Two-Direction Hero Cards */}
          <div
            data-testid="home-dual-direction-cards"
            className="grid grid-cols-2 max-compact:grid-cols-1 gap-5 max-narrow:gap-3.5 items-stretch"
          >
            {/* Direction 1: Shared Workspace Hero Card */}
            <section
              aria-labelledby="home-card-workspace-title"
              data-testid="home-card-workspace"
              className="dl-glass-dialog relative flex flex-col justify-between overflow-hidden rounded-dialog border border-dl-lane-shared/30 p-7 max-compact:p-6 max-narrow:p-4 space-y-6 max-narrow:space-y-4"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-dl-lane-shared/85"
              />

              <div className="space-y-4 max-narrow:space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 max-narrow:h-10 max-narrow:w-10 shrink-0 items-center justify-center rounded-2xl bg-dl-lane-shared/14 text-dl-lane-shared border border-dl-lane-shared/25">
                    <Building2 className="size-6 max-narrow:size-5" strokeWidth={1.85} />
                  </div>
                  <span className="rounded-full border border-dl-lane-shared/25 bg-dl-lane-shared/10 px-2.5 py-1 text-[11px] font-semibold text-dl-lane-shared">
                    共享通道 · 邀请制
                  </span>
                </div>

                <div className="space-y-1.5">
                  <h2
                    id="home-card-workspace-title"
                    className="text-xl max-narrow:text-lg font-bold tracking-[-0.025em] text-dl-text-primary"
                  >
                    共享空间
                  </h2>
                  <p className="text-xs leading-relaxed text-dl-text-secondary">
                    与熟悉的人或团队持续会话、共享文件与协作沉淀，需要登录与空间邀请，数据按空间规则安全保留。
                  </p>
                </div>

                <ul className="space-y-2 text-xs text-dl-text-primary">
                  <li className="flex items-start gap-2">
                    <CheckCircle2
                      className="size-4 shrink-0 text-dl-lane-shared mt-0.5"
                      strokeWidth={1.9}
                    />
                    <span>群聊置顶、右侧独立线程讨论、全文检索与个人云端收藏</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2
                      className="size-4 shrink-0 text-dl-lane-shared mt-0.5"
                      strokeWidth={1.9}
                    />
                    <span>支持高清原图灯箱预览、大文件分片上传与 Card Kit 智能体交互</span>
                  </li>
                </ul>

                {showServiceBanner && (
                  <div className="rounded-2xl border border-dl-warning/35 bg-dl-warning/10 p-3.5 space-y-2.5 text-xs">
                    <div className="flex items-start gap-2 text-dl-text-primary">
                      <AlertTriangle
                        className="size-4 shrink-0 text-dl-warning mt-0.5"
                        strokeWidth={2}
                      />
                      <div className="space-y-1">
                        <div className="font-semibold">
                          {workspaceAvailability === "disabled"
                            ? "共享空间服务当前未启用"
                            : "共享空间后端暂未就绪"}
                        </div>
                        <p className="text-[11px] leading-relaxed text-dl-text-secondary">
                          {workspaceStatusMessage ||
                            "请确认本地 Go Workspace 服务与 PostgreSQL 已启动；你也可以直接进入右侧私密直连通道。"}
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        busy={probingBackend}
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => void handleRetryBackend()}
                      >
                        <RefreshCw className="size-3" strokeWidth={2} />
                        重新检测服务
                      </Button>
                    </div>
                  </div>
                )}

                {authError && (
                  <div className="rounded-control bg-dl-danger/10 px-3 py-2 text-xs text-dl-danger border border-dl-danger/25">
                    {authError}
                  </div>
                )}
              </div>

              <div className="space-y-3 pt-2 border-t border-dl-border-hairline">
                <Input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="可选：输入空间邀请码"
                  aria-label="空间邀请码"
                />
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  busy={probingBackend}
                  className="w-full justify-center gap-2 font-semibold"
                  onClick={() => void handleGitHubSignIn()}
                >
                  <span>使用 GitHub 登录共享空间</span>
                  <ArrowRight className="size-4 shrink-0" strokeWidth={2} />
                </Button>

                {inviteCode.trim() && (
                  <form
                    onSubmit={handleInviteQuickAccept}
                    className="pt-2.5 border-t border-dl-border-hairline space-y-2"
                  >
                    <Input
                      value={devDisplayName}
                      onChange={(e) => setDevDisplayName(e.target.value)}
                      placeholder="可选：测试成员昵称（双窗口联调推荐使用）"
                      aria-label="测试成员昵称"
                    />
                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      busy={submitting}
                    >
                      通过邀请码直接加入（开发环境快捷入口）
                    </Button>
                  </form>
                )}
              </div>
            </section>

            {/* Direction 2: Private Direct Hero Card */}
            <section
              aria-labelledby="home-card-direct-title"
              data-testid="home-card-direct"
              className="dl-glass-dialog relative flex flex-col justify-between overflow-hidden rounded-dialog border border-dl-lane-direct/35 p-7 max-compact:p-6 max-narrow:p-4 space-y-6 max-narrow:space-y-4"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-dl-lane-direct/85"
              />

              <div className="space-y-4 max-narrow:space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 max-narrow:h-10 max-narrow:w-10 shrink-0 items-center justify-center rounded-2xl bg-dl-lane-direct/14 text-dl-lane-direct border border-dl-lane-direct/25">
                    <LockKeyhole className="size-6 max-narrow:size-5" strokeWidth={1.85} />
                  </div>
                  <span className="rounded-full border border-dl-lane-direct/30 bg-dl-lane-direct/10 px-2.5 py-1 text-[11px] font-semibold text-dl-lane-direct">
                    私密通道 · 无需账号
                  </span>
                </div>

                <div className="space-y-1.5">
                  <h2
                    id="home-card-direct-title"
                    className="text-xl max-narrow:text-lg font-bold tracking-[-0.025em] text-dl-text-primary"
                  >
                    一对一直连
                  </h2>
                  <p className="text-xs leading-relaxed text-dl-text-secondary">
                    无需注册登录，一键创建专属加密房间并分享链接开始交谈，消息与文件不在服务器保存。
                  </p>
                </div>

                <ul className="space-y-2 text-xs text-dl-text-primary">
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="size-4 shrink-0 text-dl-lane-direct mt-0.5"
                      strokeWidth={1.9}
                    />
                    <span>AES-256-GCM 端到端加密，#k= 密钥仅驻留本地内存与链接片段</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="size-4 shrink-0 text-dl-lane-direct mt-0.5"
                      strokeWidth={1.9}
                    />
                    <span>支持对端离线暂存待发、送达回执与最大 8 MB 内存分片文件直传</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="size-4 shrink-0 text-dl-lane-direct mt-0.5"
                      strokeWidth={1.9}
                    />
                    <span>服务端零历史落盘，销毁房间或关闭标签页后会话痕迹立即清空</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5 pt-2 border-t border-dl-border-hairline">
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="w-full justify-center gap-2 border-transparent bg-dl-lane-direct text-dl-on-direct hover:opacity-92 font-semibold"
                  onClick={() => {
                    setActiveLane("p2p");
                    useLaneStore.getState().setMobileView("chat");
                    const existingRoom = useWorkspaceStore.getState().p2pRoom;
                    if (!existingRoom) {
                      void createP2PRoom();
                    } else if (existingRoom.shareUrl) {
                      try {
                        const parsed = new URL(existingRoom.shareUrl);
                        window.history.replaceState(null, "", `${parsed.pathname}${parsed.hash}`);
                      } catch {
                        // Keep in-memory room active even if shareUrl is relative.
                      }
                    }
                  }}
                >
                  <ShieldCheck className="size-4 shrink-0" strokeWidth={2} />
                  <span>免登录进入私密直连通道</span>
                  <ArrowRight className="size-4 shrink-0" strokeWidth={2} />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-xs text-dl-text-secondary hover:text-dl-text-primary"
                  onClick={() => {
                    setActiveLane("p2p");
                    useLaneStore.getState().setMobileView("list");
                  }}
                >
                  仅进入直连通道列表
                </Button>
              </div>
            </section>
          </div>
        </motion.div>
      </main>
    );
  }

  return (
    <TooltipProvider delayDuration={240}>
      <main
        aria-label="DualLane 工作台"
        className="dl-canvas-ambient relative flex max-compact:flex-col h-dvh w-screen overflow-hidden text-dl-text-primary"
      >
        <PrimaryRail />
        <ConversationSidebar />
        <TimelinePane />
        <InspectorPane />
        <SettingsModal />
        <CommandSearchModal />
        <MediaLightbox />
        {isSpaceManager && adminConsoleOpen && (
          <React.Suspense fallback={null}>
            <SpaceAdminConsole />
          </React.Suspense>
        )}
      </main>
    </TooltipProvider>
  );
}
