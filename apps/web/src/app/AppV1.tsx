import React, { useEffect, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import { extractP2PRoomFromUrl } from "@/shared/lib/p2p-lane";
import { Button, Input } from "@/shared/ui";
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
        <div className="dl-glass-dialog w-full max-w-md rounded-dialog border border-dl-border-hairline p-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-dl-text-primary">DualLane v1.0</h1>
              <p className="text-xs text-dl-text-tertiary mt-0.5">
                共享空间自洽协作 · 私密直连端到端加密
              </p>
            </div>
            <Button
              size="sm"
              variant="glass"
              onClick={() => {
                setActiveLane("p2p");
                void createP2PRoom();
              }}
            >
              🔐 免登录直连
            </Button>
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
              className="w-full"
              onClick={handleGitHubSignIn}
            >
              使用 GitHub 登录共享空间
            </Button>
          </div>

          {inviteCode.trim() && (
            <form onSubmit={handleInviteQuickAccept} className="pt-2 border-t border-dl-border-hairline">
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
      </main>
    );
  }

  return (
    <main className="dl-canvas-ambient flex h-screen w-screen overflow-hidden text-dl-text-primary">
      <PrimaryRail />
      <ConversationSidebar />
      <TimelinePane />
      <InspectorPane />
      <SettingsModal />
      <CommandSearchModal />
      <MediaLightbox />
    </main>
  );
}
