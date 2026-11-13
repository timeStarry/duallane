import React, { useEffect, useState } from "react";
import { ArrowRight, Building2, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { extractP2PRoomFromUrl } from "@/shared/lib/p2p-lane";
import { Button, Input, TooltipProvider } from "@/shared/ui";
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
    bootstrapWorkspace,
    acceptInviteAndBootstrap,
    joinP2PRoom,
    createP2PRoom,
  } = useWorkspaceStore();

  const [inviteCode, setInviteCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("invite") || "";
  });
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const p2p = extractP2PRoomFromUrl();
    if (p2p) {
      setActiveLane("p2p");
      void joinP2PRoom(p2p.roomId, p2p.keyStr);
    }
    void bootstrapWorkspace();
  }, [bootstrapWorkspace, joinP2PRoom, setActiveLane]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setActiveLane("workspace");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "2") {
        e.preventDefault();
        setActiveLane("p2p");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveLane]);

  const handleGitHubSignIn = () => {
    window.location.assign(apiV1.getGitHubStartUrl(inviteCode));
  };

  const handleInviteQuickAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setAuthError("");
    setSubmitting(true);
    try {
      await acceptInviteAndBootstrap(inviteCode);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "邀请码验证失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (authStatus === "checking") {
    return (
      <main className="dl-canvas-ambient flex h-screen w-screen items-center justify-center">
        <div className="dl-glass-elevated rounded-dialog px-6 py-4 text-sm text-dl-text-secondary">
          正在连接 DualLane v1.0…
        </div>
      </main>
    );
  }

  if (authStatus === "unauthenticated" && activeLane !== "p2p") {
    return (
      <main className="dl-canvas-ambient flex min-h-screen w-screen items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="dl-glass-dialog w-full max-w-[440px] rounded-dialog border border-dl-border-hairline p-7 space-y-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-dl-lane-shared to-dl-lane-direct text-dl-on-shared font-bold text-sm shadow-sm">
                DL
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold tracking-tight text-dl-text-primary">
                    DualLane
                  </h1>
                  <span className="rounded-full bg-dl-lane-shared/14 px-2 py-0.5 text-[10px] font-semibold text-dl-lane-shared">
                    v1.0
                  </span>
                </div>
                <p className="text-xs text-dl-text-secondary mt-0.5">
                  共享空间自洽协作 · 私密直连端到端加密
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-xs">
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
            />
            <Button
              type="button"
              variant="primary"
              className="w-full justify-center gap-2"
              onClick={handleGitHubSignIn}
            >
              <span>使用 GitHub 登录共享空间</span>
              <ArrowRight className="size-4" strokeWidth={2} />
            </Button>
            <Button
              type="button"
              variant="glass"
              className="w-full justify-center gap-2 border-dl-lane-direct/30 text-dl-lane-direct hover:bg-dl-lane-direct/12"
              onClick={() => {
                setActiveLane("p2p");
                void createP2PRoom();
              }}
            >
              <ShieldCheck className="size-4" strokeWidth={1.9} />
              <span>免登录进入私密直连通道</span>
            </Button>
          </div>

          {inviteCode.trim() && (
            <form
              onSubmit={handleInviteQuickAccept}
              className="pt-2 border-t border-dl-border-hairline"
            >
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
      <main className="dl-canvas-ambient relative flex h-screen w-screen overflow-hidden text-dl-text-primary">
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
