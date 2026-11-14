import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  LockKeyhole,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from "lucide-react";
import type { ThemePreference } from "@duallane/design-tokens";
import { motion } from "motion/react";
import {
  inferEntryViewFromLocation,
  inferLaneFromLocation,
  inferMobileViewFromLocation,
  useLaneStore,
} from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { extractP2PRoomFromUrl } from "@/shared/lib/p2p-lane";
import { useThemeStore } from "@/shared/theme/vibrancy";
import { BrandLogo, Button, Input, SegmentedControl, TooltipProvider } from "@/shared/ui";
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
  const { activeLane, entryView, mobileView, setActiveLane, setEntryView, adminConsoleOpen } =
    useLaneStore();
  const { preference, setPreference } = useThemeStore();
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
    const hadOAuthErrorParam =
      params.has("error") || params.has("error_description") || params.has("authError");
    if (hadOAuthErrorParam) {
      params.delete("error");
      params.delete("error_description");
      params.delete("authError");
      const rest = params.toString();
      const basePath =
        window.location.pathname === "/" ? "/workspace" : window.location.pathname;
      const nextUrl = `${basePath}${rest ? `?${rest}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    const syncRouteFromLocation = (forceWorkspaceEntry = false) => {
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
      const nextEntryView = forceWorkspaceEntry
        ? "workspace"
        : inferEntryViewFromLocation(window.location);
      useLaneStore.setState({
        activeLane: nextLane,
        entryView: nextEntryView,
        mobileView: nextMobileView,
      });
    };

    syncRouteFromLocation(hadOAuthErrorParam);
    void bootstrapWorkspace();

    const handleLocationChange = () => syncRouteFromLocation(false);
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
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
      return;
    }

    // Unauthenticated & returned to "/" (e.g. after logout) -> return to calm two-card entry portal
    if (
      authStatus === "unauthenticated" &&
      pathname === "/" &&
      !new URLSearchParams(search).has("invite") &&
      !authError &&
      useLaneStore.getState().entryView !== "entry"
    ) {
      useLaneStore.setState({ entryView: "entry" });
    }
  }, [activeLane, authError, authStatus, mobileView, p2pRoom]);

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

  const enterDirectSession = () => {
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
  };

  if (authStatus === "checking" && activeLane !== "p2p") {
    return (
      <main className="dl-canvas-ambient flex h-screen w-screen items-center justify-center">
        <div className="dl-glass-elevated flex items-center gap-3 rounded-dialog px-5 py-3.5 text-sm text-dl-text-secondary">
          <BrandLogo size={28} animated />
          <span>正在连接 DualLane…</span>
        </div>
      </main>
    );
  }

  if (authStatus !== "authenticated" && activeLane !== "p2p") {
    const showServiceBanner =
      workspaceAvailability === "disabled" || workspaceAvailability === "unreachable";

    const themeControl = (
      <SegmentedControl
        label="外观模式"
        value={preference}
        onValueChange={(v) => setPreference(v as ThemePreference)}
        options={[
          { value: "system", label: "系统", icon: <Monitor className="size-3.5 max-narrow:hidden" strokeWidth={1.9} /> },
          { value: "light", label: "浅色", icon: <Sun className="size-3.5 max-narrow:hidden" strokeWidth={1.9} /> },
          { value: "dark", label: "深色", icon: <Moon className="size-3.5 max-narrow:hidden" strokeWidth={1.9} /> },
        ]}
      />
    );

    if (entryView === "workspace" || Boolean(authError)) {
      return (
        <main
          aria-label="共享空间登录"
          className="dl-canvas-ambient flex min-h-dvh w-screen flex-col px-6 py-5 max-compact:px-4 max-narrow:px-3 max-narrow:py-3"
        >
          <header className="mx-auto flex w-full max-w-[880px] flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-dl-text-secondary hover:text-dl-text-primary"
              onClick={() => {
                setAuthError("");
                setEntryView("entry", true);
              }}
            >
              <ArrowLeft className="size-4 shrink-0" strokeWidth={1.9} />
              <span>返回选择</span>
            </Button>
            {themeControl}
          </header>

          <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-8 max-narrow:py-5">
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              aria-labelledby="workspace-signin-title"
              className="rounded-[20px] border border-dl-border-hairline bg-surface p-8 max-narrow:p-5 shadow-xs space-y-5"
            >
              <div className="space-y-2.5">
                <div className="mb-3 flex size-[52px] items-center justify-center rounded-2xl bg-dl-lane-shared/12 text-dl-lane-shared">
                  <ShieldCheck className="size-6" strokeWidth={1.9} />
                </div>
                <p className="text-xs font-semibold text-dl-text-secondary">
                  {workspaceAvailability === "disabled" ? "暂未开放" : "共享通道"}
                </p>
                <h1
                  id="workspace-signin-title"
                  className="text-2xl max-narrow:text-xl font-bold tracking-[-0.02em] text-dl-text-primary"
                >
                  登录后进入共享空间
                </h1>
                <p className="text-sm leading-relaxed text-dl-text-secondary">
                  共享空间会保存聊天和文件，方便成员稍后查看。进入权限由服务端校验。
                </p>
              </div>

              {showServiceBanner && (
                <div className="rounded-xl border border-dl-warning/30 bg-dl-warning/10 p-3.5 space-y-2.5 text-xs">
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
                        {workspaceStatusMessage || "请确认共享空间服务已启动，或切换至免登录一对一直连。"}
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
                      重新检测
                    </Button>
                  </div>
                </div>
              )}

              {authError && (
                <div className="rounded-control bg-dl-danger/10 px-3 py-2 text-xs text-dl-danger border border-dl-danger/25">
                  {authError}
                </div>
              )}

              <div className="space-y-3 pt-1">
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

              <div className="pt-1 border-t border-dl-border-hairline">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center gap-1.5 text-xs text-dl-text-secondary hover:text-dl-text-primary"
                  onClick={enterDirectSession}
                >
                  <span>免登录进入私密直连通道</span>
                  <ArrowRight className="size-3.5 shrink-0" strokeWidth={2} />
                </Button>
              </div>
            </motion.section>
          </div>
        </main>
      );
    }

    return (
      <main
        aria-labelledby="entry-title"
        className="dl-canvas-ambient flex min-h-dvh w-screen flex-col px-6 py-5 max-compact:px-4 max-narrow:px-3.5 max-narrow:py-3.5"
      >
        <div className="flex w-full justify-end">
          {themeControl}
        </div>

        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="mx-auto flex w-full max-w-[880px] flex-1 flex-col justify-center pb-10 pt-4 max-compact:py-6"
        >
          <div className="mb-9 max-w-[660px] max-compact:mb-6">
            <div className="mb-8 flex items-center gap-2.5 max-compact:mb-5">
              <BrandLogo size={26} />
              <span className="text-[20px] font-semibold tracking-[-0.02em] text-dl-text-primary">
                DualLane
              </span>
            </div>
            <p className="mb-2 text-xs font-semibold text-dl-text-secondary">
              两种连接，一处交流
            </p>
            <h1
              id="entry-title"
              className="text-[32px] max-narrow:text-[26px] font-bold leading-[1.2] tracking-[-0.02em] text-dl-text-primary"
            >
              选择沟通方式
            </h1>
            <p className="mt-3.5 text-[16px] max-narrow:text-[14px] leading-[1.6] text-dl-text-secondary">
              临时私密交谈，或与熟悉的人持续协作。
            </p>
          </div>

          <div
            role="group"
            aria-label="通信通道"
            data-testid="home-dual-direction-cards"
            className="grid grid-cols-2 max-compact:grid-cols-1 gap-5 max-narrow:gap-3.5"
          >
            <Button
              type="button"
              variant="ghost"
              data-testid="home-card-direct"
              onClick={enterDirectSession}
              className="group h-auto min-h-[296px] max-compact:min-h-[236px] w-full flex-col items-start justify-start gap-3 rounded-[20px] border border-dl-border-hairline bg-surface p-7 max-narrow:p-5 text-left whitespace-normal shadow-xs hover:border-dl-border-strong hover:bg-surface active:scale-[0.995]"
            >
              <span
                aria-hidden="true"
                className="mb-2 flex size-[52px] items-center justify-center rounded-2xl bg-dl-lane-direct text-dl-on-direct"
              >
                <LockKeyhole className="size-6" strokeWidth={1.9} />
              </span>
              <span className="text-xs font-medium text-dl-text-secondary">
                私密通道
              </span>
              <strong className="text-[24px] max-narrow:text-[20px] font-bold leading-[1.3] tracking-[-0.02em] text-dl-text-primary">
                一对一直连
              </strong>
              <span className="max-w-[380px] text-[15px] max-narrow:text-[14px] font-normal leading-[1.55] text-dl-text-secondary">
                无需登录，用邀请链接开始。
                <br />
                对话内容不在服务器保存。
              </span>
              <span className="mt-auto pt-4 inline-flex items-center gap-2 text-[14px] font-semibold text-dl-lane-direct">
                <span>开始临时会话</span>
                <ArrowRight
                  className="size-[17px] transition-transform duration-150 group-hover:translate-x-0.5"
                  strokeWidth={2}
                />
              </span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              data-testid="home-card-workspace"
              onClick={() => setEntryView("workspace", true)}
              className="group h-auto min-h-[296px] max-compact:min-h-[236px] w-full flex-col items-start justify-start gap-3 rounded-[20px] border border-dl-border-hairline bg-surface p-7 max-narrow:p-5 text-left whitespace-normal shadow-xs hover:border-dl-border-strong hover:bg-surface active:scale-[0.995]"
            >
              <span
                aria-hidden="true"
                className="mb-2 flex size-[52px] items-center justify-center rounded-2xl bg-dl-lane-shared/12 text-dl-lane-shared"
              >
                <ShieldCheck className="size-6" strokeWidth={1.9} />
              </span>
              <span className="text-xs font-medium text-dl-text-secondary">
                共享通道
              </span>
              <strong className="text-[24px] max-narrow:text-[20px] font-bold leading-[1.3] tracking-[-0.02em] text-dl-text-primary">
                共享空间
              </strong>
              <span className="max-w-[380px] text-[15px] max-narrow:text-[14px] font-normal leading-[1.55] text-dl-text-secondary">
                和熟人或小组持续聊天、共享文件。
                <br />
                需要登录和邀请，内容按空间规则保留。
              </span>
              <span className="mt-auto pt-4 inline-flex items-center gap-2 text-[14px] font-semibold text-dl-lane-shared">
                <span>进入共享空间</span>
                <ArrowRight
                  className="size-[17px] transition-transform duration-150 group-hover:translate-x-0.5"
                  strokeWidth={2}
                />
              </span>
            </Button>
          </div>
        </motion.section>
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
