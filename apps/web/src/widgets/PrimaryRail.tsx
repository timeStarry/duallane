import React from "react";
import {
  Bot,
  Building2,
  LogOut,
  QrCode,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  User,
} from "lucide-react";
import { motion } from "motion/react";
import { useLaneStore } from "@/entities/lane/store";
import {
  computeGlobalAlertUnreadCount,
  useWorkspaceStore,
} from "@/entities/workspace/store";
import {
  Avatar,
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";
import { DualLaneDeckSwitch } from "@/widgets/DualLaneDeckSwitch";

export function PrimaryRail() {
  const { activeLane, mobileView, setActiveLane, setSearchOpen, openSettings, openAdminConsole } =
    useLaneStore();
  const {
    isPreviewMode,
    authStatus,
    currentUser,
    connectionStatus,
    quotaUsedBytes,
    quotaLimitBytes,
    conversations,
    p2pRoom,
    logout,
  } = useWorkspaceStore();

  const isAuthenticated =
    isPreviewMode || (authStatus === "authenticated" && Boolean(currentUser));
  const isSpaceManager =
    isAuthenticated &&
    (isPreviewMode || currentUser?.role === "owner" || currentUser?.role === "admin");
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);

  const workspaceUnreadCount = React.useMemo(
    () => computeGlobalAlertUnreadCount(conversations),
    [conversations]
  );

  const quotaPct = Math.min(
    100,
    Math.round((quotaUsedBytes / Math.max(1, quotaLimitBytes)) * 100)
  );

  return (
    <nav
      aria-label="主通道导航"
      className={cn(
        "dl-glass-chrome z-sticky flex h-full w-[68px] shrink-0 flex-col items-center justify-between border-r border-dl-border-hairline py-3.5 select-none",
        "max-compact:order-last max-compact:h-14 max-compact:w-full max-compact:flex-row max-compact:justify-between max-compact:border-r-0 max-compact:border-t max-compact:px-2.5 max-compact:py-1",
        mobileView === "chat" && "max-compact:hidden"
      )}
    >
      {/* Top: Interactive Brand Emblem · Card-Shuffling Dual-Lane Switcher */}
      <div className="flex w-full flex-col items-center gap-2.5 px-1.5 max-compact:w-auto max-compact:flex-1 max-compact:flex-row max-compact:justify-start max-compact:gap-2 max-compact:px-0">
        <div className="relative flex w-full justify-center max-compact:w-auto">
          <motion.span
            layoutId="rail-active-lane"
            transition={{ type: "spring", stiffness: 440, damping: 32 }}
            className={cn(
              "absolute -left-1.5 top-2 bottom-5 w-1 rounded-r-full transition-colors max-compact:hidden",
              activeLane === "workspace" ? "bg-dl-lane-shared" : "bg-dl-lane-direct"
            )}
          />
          <DualLaneDeckSwitch
            activeLane={activeLane}
            onToggleLane={setActiveLane}
            hasActiveP2PRoom={Boolean(p2pRoom)}
            workspaceUnreadCount={isAuthenticated ? workspaceUnreadCount : 0}
          />
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

        {isSpaceManager && (
          <Tooltip content="空间治理台" side="right">
            <IconButton
              variant="ghost"
              onClick={() => openAdminConsole("overview")}
              className="h-9 w-9 rounded-xl max-compact:hidden text-dl-lane-shared hover:bg-dl-lane-shared/12"
              label="空间治理台"
            >
              <SlidersHorizontal className="size-[18px]" strokeWidth={1.75} />
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
                ? "加载中…"
                : "未连接"
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
                  {isSpaceManager && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-2 text-dl-lane-shared hover:bg-dl-lane-shared/10"
                      onClick={() => {
                        setUserMenuOpen(false);
                        openAdminConsole("overview");
                      }}
                    >
                      <SlidersHorizontal className="size-4 shrink-0" strokeWidth={1.8} />
                      空间治理台
                    </Button>
                  )}
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
