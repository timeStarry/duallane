import React, { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Building2, RefreshCw, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
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

export function AppV1() {
  const { activeLane, setActiveLane } = useLaneStore();
  const {
    authStatus,
    workspaceAvailability,
    workspaceStatusMessage,
    bootstrapWorkspace,
    acceptInviteAndBootstrap,
    joinP2PRoom,
    createP2PRoom,
  } = useWorkspaceStore();

  const [inviteCode, setInviteCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("invite") || "";
  });
  const [devDisplayName, setDevDisplayName] = useState("");
  const [authError, setAuthError] = useState(() => {
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

    const syncRoomFromLocation = () => {
      const p2p = extractP2PRoomFromUrl();
      if (!p2p) return;
      const currentRoom = useWorkspaceStore.getState().p2pRoom;
      setActiveLane("p2p");
      useLaneStore.getState().setMobileView("chat");
      if (currentRoom?.roomId === p2p.roomId && currentRoom.shareUrl === window.location.href) {
        return;
      }
      void joinP2PRoom(p2p.roomId, p2p.keyStr);
    };

    syncRoomFromLocation();
    void bootstrapWorkspace();

    window.addEventListener("popstate", syncRoomFromLocation);
    window.addEventListener("hashchange", syncRoomFromLocation);
    return () => {
      window.removeEventListener("popstate", syncRoomFromLocation);
      window.removeEventListener("hashchange", syncRoomFromLocation);
    };
  }, [bootstrapWorkspace, joinP2PRoom, setActiveLane]);

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
        className="dl-canvas-ambient flex min-h-dvh w-screen items-center justify-center p-6 max-narrow:p-3"
      >
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="dl-glass-dialog w-full max-w-[440px] rounded-dialog border border-dl-border-hairline p-7 max-narrow:p-4 space-y-6 max-narrow:space-y-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3.5 min-w-0">
              <BrandLogo size={46} withTile animated />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg font-bold tracking-[-0.032em] text-dl-text-primary">
                    DualLane
                  </h1>
                  <span className="rounded-full bg-dl-lane-shared/14 px-2 py-0.5 text-[10px] font-semibold text-dl-lane-shared">
                    v1.0
                  </span>
                </div>
                <p className="text-xs text-dl-text-secondary mt-0.5 leading-snug">
                  分流式安全会话 · 共享空间与私密直连
                </p>
                <div className="text-[11px] font-mono text-dl-text-secondary mt-0.5 truncate">
                  Two Trust Lanes. Crystal Clear.
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 max-narrow:grid-cols-1 gap-2.5 text-xs">
            <div className="rounded-2xl border border-dl-lane-shared/25 bg-dl-lane-shared/8 p-3 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-dl-lane-shared">
                <Building2 className="size-3.5" strokeWidth={2} />
                共享空间
              </div>
              <p className="text-[11px] leading-relaxed text-dl-text-secondary">
                群组置顶、右侧线程、我的收藏与 Card Kit 智能体
              </p>
            </div>
            <div className="rounded-2xl border border-dl-lane-direct/25 bg-dl-lane-direct/8 p-3 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-dl-lane-direct">
                <ShieldCheck className="size-3.5" strokeWidth={2} />
                私密直连
              </div>
              <p className="text-[11px] leading-relaxed text-dl-text-secondary">
                免登录一键建房，AES-256-GCM 密钥仅驻留内存
              </p>
            </div>
          </div>

          {showServiceBanner && (
            <div className="rounded-2xl border border-dl-warning/35 bg-dl-warning/10 p-3.5 space-y-2.5 text-xs">
              <div className="flex items-start gap-2 text-dl-text-primary">
                <AlertTriangle className="size-4 shrink-0 text-dl-warning mt-0.5" strokeWidth={2} />
                <div className="space-y-1">
                  <div className="font-semibold">
                    {workspaceAvailability === "disabled"
                      ? "共享空间服务当前未启用"
                      : "共享空间后端暂未就绪"}
                  </div>
                  <p className="text-[11px] leading-relaxed text-dl-text-secondary">
                    {workspaceStatusMessage ||
                      "请确认本地 Go Workspace 服务与 PostgreSQL 已启动；你也可以直接免登录使用私密直连通道。"}
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

          <div className="space-y-3">
            <Input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="可选：输入空间邀请码"
              aria-label="空间邀请码"
            />
            <Button
              type="button"
              variant="primary"
              busy={probingBackend}
              className="w-full justify-center gap-2"
              onClick={() => void handleGitHubSignIn()}
            >
              <span>使用 GitHub 登录共享空间</span>
              <ArrowRight className="size-4 shrink-0" strokeWidth={2} />
            </Button>
            <Button
              type="button"
              variant="glass"
              className="w-full justify-center gap-2 border-dl-lane-direct/30 text-dl-lane-direct hover:bg-dl-lane-direct/12"
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
              <ShieldCheck className="size-4 shrink-0" strokeWidth={1.9} />
              <span>免登录进入私密直连通道</span>
            </Button>
          </div>

          {inviteCode.trim() && (
            <form
              onSubmit={handleInviteQuickAccept}
              className="pt-3 border-t border-dl-border-hairline space-y-2.5"
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
      </main>
    </TooltipProvider>
  );
}
