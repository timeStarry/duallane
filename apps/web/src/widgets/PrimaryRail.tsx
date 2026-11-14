import React from "react";
import {
  Bot,
  Building2,
  LogOut,
  QrCode,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  User,
} from "lucide-react";
import { motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  Avatar,
  BrandLogo,
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

export function PrimaryRail() {
  const { activeLane, mobileView, setActiveLane, setSearchOpen, openSettings } = useLaneStore();
  const {
    isPreviewMode,
    authStatus,
    currentUser,
    connectionStatus,
    quotaUsedBytes,
    quotaLimitBytes,
    p2pRoom,
    logout,
  } = useWorkspaceStore();

  const isAuthenticated =
    isPreviewMode || (authStatus === "authenticated" && Boolean(currentUser));
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);

  const quotaPct = Math.min(
    100,
    Math.round((quotaUsedBytes / Math.max(1, quotaLimitBytes)) * 100)
  );

  return (
    <nav
      aria-label="主通道导航"
      className={cn(
        "dl-glass-chrome z-sticky flex h-full w-[68px] shrink-0 flex-col items-center justify-between border-r border-dl-border-hairline py-3.5 select-none",
        "max-compact:order-last max-compact:h-14 max-compact:w-full max-compact:flex-row max-compact:justify-around max-compact:border-r-0 max-compact:border-t max-compact:px-2 max-compact:py-1",
        mobileView === "chat" && "max-compact:hidden"
      )}
    >
      {/* Top: Brand & Dual-Lane Live Switcher */}
      <div className="flex w-full flex-col items-center gap-2.5 px-2 max-compact:w-auto max-compact:flex-1 max-compact:flex-row max-compact:justify-around max-compact:gap-1 max-compact:px-0">
        <Tooltip content="DualLane v1.0 · Two Trust Lanes. Crystal Clear." side="right">
          <div className="max-compact:hidden">
            <BrandLogo size={38} withTile label="DualLane" />
          </div>
        </Tooltip>

        <div className="my-0.5 h-px w-8 bg-dl-border-hairline max-compact:hidden" />

        <div className="relative flex w-full justify-center max-compact:w-auto">
          {activeLane === "workspace" && (
            <motion.span
              layoutId="rail-active-lane"
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full bg-dl-lane-shared max-compact:hidden"
            />
          )}
          <Tooltip content="共享空间 · 团队协作、线程与机器人 (⌘1)" side="right">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setActiveLane("workspace")}
              className={cn(
                "relative h-11 w-11 max-compact:h-10 max-compact:w-12 rounded-2xl p-0 flex-col gap-1 transition-colors",
                activeLane === "workspace"
                  ? "bg-dl-lane-shared text-dl-on-shared hover:bg-dl-lane-shared shadow-sm"
                  : "text-dl-text-secondary hover:bg-dl-surface-subtle/80 hover:text-dl-text-primary"
              )}
              aria-label="共享空间"
            >
              <Building2 className="size-[18px]" strokeWidth={1.75} />
              <span className="text-[10px] font-semibold leading-none">空间</span>
            </Button>
          </Tooltip>
        </div>

        <div className="relative flex w-full justify-center max-compact:w-auto">
          {activeLane === "p2p" && (
            <motion.span
              layoutId="rail-active-lane"
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full bg-dl-lane-direct max-compact:hidden"
            />
          )}
          <Tooltip
            content={`私密直连 · 端到端加密点对点${p2pRoom ? " (房间活跃)" : ""} (⌘2)`}
            side="right"
          >
            <Button
              variant="ghost"
              size="md"
              onClick={() => setActiveLane("p2p")}
              className={cn(
                "relative h-11 w-11 max-compact:h-10 max-compact:w-12 rounded-2xl p-0 flex-col gap-1 transition-colors",
                activeLane === "p2p"
                  ? "bg-dl-lane-direct text-dl-on-direct hover:bg-dl-lane-direct shadow-sm"
                  : "text-dl-text-secondary hover:bg-dl-surface-subtle/80 hover:text-dl-text-primary"
              )}
              aria-label="私密直连"
            >
              <ShieldCheck className="size-[18px]" strokeWidth={1.75} />
              <span className="text-[10px] font-semibold leading-none">直连</span>
              {p2pRoom && (
                <span
                  className={cn(
                    "absolute top-1.5 right-1.5 h-2 w-2 rounded-full animate-pulse",
                    activeLane === "p2p" ? "bg-dl-on-direct" : "bg-dl-lane-direct"
                  )}
                />
              )}
            </Button>
          </Tooltip>
        </div>

        <div className="my-0.5 h-px w-8 bg-dl-border-hairline max-compact:hidden" />

        <Tooltip content="全局搜索 (⌘K)" side="right">
          <IconButton
            variant="ghost"
            onClick={() => setSearchOpen(true)}
            className="h-9 w-9 rounded-xl"
            label="全局搜索"
          >
            <Search className="size-[18px]" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>

        {isAuthenticated && (
          <Tooltip content="机器人与集成" side="right">
            <IconButton
              variant="ghost"
              onClick={() => openSettings("bots")}
              className="h-9 w-9 rounded-xl max-compact:hidden"
              label="机器人与集成"
            >
              <Bot className="size-[18px]" strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
        )}
      </div>

      {/* Bottom: Connection Status, Quota, Settings & User Menu */}
      <div className="flex w-full flex-col items-center gap-2.5 px-2 max-compact:w-auto max-compact:flex-row max-compact:gap-2 max-compact:px-1">
        {isAuthenticated && (
          <Tooltip
            content={
              connectionStatus === "connected"
                ? `实时连接正常 · 今日配额已用 ${quotaPct}%`
                : connectionStatus === "reconnecting"
                ? "正在重连…"
                : "离线"
            }
            side="right"
          >
            <div className="flex items-center gap-1 rounded-full border border-dl-border-hairline bg-dl-surface-subtle/80 px-2 py-0.5 max-compact:hidden">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  connectionStatus === "connected"
                    ? "bg-dl-success"
                    : connectionStatus === "reconnecting"
                    ? "bg-dl-warning animate-pulse"
                    : "bg-dl-danger"
                )}
              />
              <span className="text-[10px] font-medium text-dl-text-secondary tabular-nums">
                {quotaPct}%
              </span>
            </div>
          </Tooltip>
        )}

        <Tooltip content="设置中心" side="right">
          <IconButton
            variant="ghost"
            onClick={() => openSettings("appearance")}
            className="h-9 w-9 rounded-xl"
            label="设置中心"
          >
            <Settings className="size-[18px]" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>

        <Popover open={userMenuOpen} onOpenChange={setUserMenuOpen}>
          <PopoverTrigger asChild>
            <IconButton
              variant="ghost"
              className="h-10 w-10 max-compact:h-9 max-compact:w-9 rounded-full p-0"
              label="个人菜单"
            >
              <Avatar
                name={isAuthenticated ? currentUser?.displayName || "当前成员" : "访客"}
                src={isAuthenticated ? currentUser?.avatarUrl : undefined}
                size="md"
                online={isAuthenticated ? connectionStatus === "connected" : Boolean(p2pRoom)}
              />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" side="top">
            <div className="w-52 space-y-1.5 p-1">
              {isAuthenticated ? (
                <>
                  <div className="px-2.5 py-1.5">
                    <div className="truncate text-sm font-semibold text-dl-text-primary">
                      {currentUser?.displayName || "当前成员"}
                    </div>
                    <div className="text-xs text-dl-text-tertiary">
                      {currentUser?.role === "owner"
                        ? "空间所有者"
                        : currentUser?.role === "admin"
                        ? "空间管理员"
                        : "空间成员"}
                    </div>
                  </div>
                  <div className="h-px bg-dl-border-hairline" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      openSettings("profile");
                    }}
                  >
                    <User className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                    个人资料与状态
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      openSettings("devices");
                    }}
                  >
                    <Smartphone className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                    活跃设备与安全
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      openSettings("qr");
                    }}
                  >
                    <QrCode className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                    手机扫码登录
                  </Button>
                  <div className="h-px bg-dl-border-hairline" />
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void logout();
                    }}
                  >
                    <LogOut className="size-4" strokeWidth={1.75} />
                    退出当前账号
                  </Button>
                </>
              ) : (
                <>
                  <div className="px-2.5 py-1.5">
                    <div className="truncate text-sm font-semibold text-dl-text-primary">
                      免登录访客
                    </div>
                    <div className="text-xs text-dl-text-tertiary">私密直连模式</div>
                  </div>
                  <div className="h-px bg-dl-border-hairline" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      openSettings("appearance");
                    }}
                  >
                    <Settings className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                    外观与界面偏好
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      openSettings("profile");
                    }}
                  >
                    <User className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                    访客状态说明
                  </Button>
                  <div className="h-px bg-dl-border-hairline" />
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setActiveLane("workspace");
                    }}
                  >
                    <Building2 className="size-4" strokeWidth={1.75} />
                    前往登录共享空间
                  </Button>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </nav>
  );
}
