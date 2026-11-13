import React, { useEffect, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { extractP2PRoomFromUrl } from "@/shared/lib/p2p-lane";
import { Button, Input, SegmentedControl } from "@/shared/ui";
import { CommandSearchModal } from "@/widgets/CommandSearchModal";
import { ConversationSidebar } from "@/widgets/ConversationSidebar";
import { InspectorPane } from "@/widgets/InspectorPane";
import { MediaLightbox } from "@/widgets/MediaLightbox";
import { PrimaryRail } from "@/widgets/PrimaryRail";
import { SettingsModal } from "@/widgets/SettingsModal";
import { TimelinePane } from "@/widgets/TimelinePane";

export function AppV1() {
  const { activeLane, setActiveLane, setThemeMode } = useLaneStore();
  const {
    authStatus,
    bootstrapWorkspace,
    login,
    register,
    joinP2PRoom,
    createP2PRoom,
  } = useWorkspaceStore();

  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setThemeMode("system");
    const p2p = extractP2PRoomFromUrl();
    if (p2p) {
      setActiveLane("p2p");
      void joinP2PRoom(p2p.roomId, p2p.keyStr);
    }
    void bootstrapWorkspace();
  }, [bootstrapWorkspace, joinP2PRoom, setActiveLane, setThemeMode]);

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

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setSubmitting(true);
    try {
      if (authMode === "login") {
        await login(email, password);
      } else {
        await register(inviteCode, displayName, email, password);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "登录失败，请检查输入");
    } finally {
      setSubmitting(false);
    }
  };

  if (authStatus === "checking") {
    return (
      <main className="dl-ambient-canvas flex h-screen w-screen items-center justify-center">
        <div className="dl-glass-elevated rounded-3xl px-6 py-4 text-sm text-dl-text-secondary">
          正在连接 DualLane v1.0…
        </div>
      </main>
    );
  }

  // Unauthenticated Dual-Lane Entry (allows instant P2P or Workspace Sign-In)
  if (authStatus === "unauthenticated" && activeLane !== "p2p") {
    return (
      <main className="dl-ambient-canvas flex min-h-screen w-screen items-center justify-center p-6">
        <div className="dl-glass-dialog w-full max-w-md rounded-3xl border border-dl-border-hairline p-6 shadow-xl space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-dl-text-primary">DualLane v1.0</h1>
              <p className="text-xs text-dl-text-tertiary">共享空间协作 · 私密直连加密</p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setActiveLane("p2p");
                void createP2PRoom();
              }}
            >
              🔐 免登录发起 P2P 直连
            </Button>
          </div>

          <SegmentedControl
            label="登录或注册"
            value={authMode}
            onValueChange={(v) => setAuthMode(v as "login" | "register")}
            options={[
              { value: "login", label: "账号登录" },
              { value: "register", label: "邀请码注册" },
            ]}
          />

          {authError && (
            <div className="rounded-xl bg-dl-danger/10 px-3 py-2 text-xs text-dl-danger border border-dl-danger/25">
              {authError}
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className="space-y-3">
            {authMode === "register" && (
              <>
                <Input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="邀请码"
                  required
                />
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="显示名称"
                  required
                />
              </>
            )}
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="邮箱地址"
              required
            />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              required
            />
            <Button type="submit" variant="primary" className="w-full" busy={submitting}>
              {authMode === "login" ? "进入共享空间" : "注册并加入空间"}
            </Button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="dl-ambient-canvas flex h-screen w-screen overflow-hidden text-dl-text-primary">
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
