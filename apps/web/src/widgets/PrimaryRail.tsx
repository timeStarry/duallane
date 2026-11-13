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
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

export function PrimaryRail() {
  const { activeLane, setActiveLane, setSearchOpen, openSettings } = useLaneStore();
  const {
    currentUser,
    connectionStatus,
    quotaUsedBytes,
    quotaLimitBytes,
    p2pRoom,
    logout,
  } = useWorkspaceStore();

  const quotaPct = Math.min(
    100,
    Math.round((quotaUsedBytes / Math.max(1, quotaLimitBytes)) * 100)
  );

  return (
    <aside className="dl-glass-chrome z-sticky flex h-full w-[68px] max-compact:w-[60px] shrink-0 flex-col items-center justify-between border-r border-dl-border-hairline py-3.5 select-none">
      {/* Top: Brand & Dual-Lane Live Switcher */}
      <div className="flex w-full flex-col items-center gap-2.5 px-2">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-dl-lane-shared to-dl-lane-direct text-dl-on-shared font-bold text-[13px] tracking-tight shadow-sm"
          title="DualLane v1.0"
        >
          DL
        </div>

        <div className="my-0.5 h-px w-8 bg-dl-border-hairline" />

        <div className="relative flex w-full justify-center">
          {activeLane === "workspace" && (
            <motion.span
              layoutId="rail-active-lane"
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full bg-dl-lane-shared"
            />
          )}
          <Tooltip content="共享空间 · 团队协作、线程与机器人 (⌘1)" side="right">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setActiveLane("workspace")}
              className={cn(
                "relative h-11 w-11 rounded-2xl p-0 flex-col gap-1 transition-colors",
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

        <div className="relative flex w-full justify-center">
          {activeLane === "p2p" && (
            <motion.span
              layoutId="rail-active-lane"
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full bg-dl-lane-direct"
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
                "relative h-11 w-11 rounded-2xl p-0 flex-col gap-1 transition-colors",
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

        <div className="my-0.5 h-px w-8 bg-dl-border-hairline" />

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

        <Tooltip content="机器人与集成" side="right">
          <IconButton
            variant="ghost"
            onClick={() => openSettings("bots")}
            className="h-9 w-9 rounded-xl"
            label="机器人与集成"
          >
            <Bot className="size-[18px]" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      </div>

      {/* Bottom: Connection Status, Quota, Settings & User Menu */}
      <div className="flex w-full flex-col items-center gap-2.5 px-2">
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
          <div className="flex items-center gap-1 rounded-full border border-dl-border-hairline bg-dl-surface-subtle/80 px-2 py-0.5">
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

        <Popover>
          <PopoverTrigger asChild>
            <IconButton
              variant="ghost"
              className="h-10 w-10 rounded-full p-0"
              label="个人菜单"
            >
              <Avatar
                name={currentUser?.displayName || "访客"}
                src={currentUser?.avatarUrl}
                size="md"
                online={connectionStatus === "connected"}
              />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" side="right">
            <div className="w-52 space-y-1.5 p-1">
              <div className="px-2.5 py-1.5">
                <div className="truncate text-sm font-semibold text-dl-text-primary">
                  {currentUser?.displayName || "未登录"}
                </div>
                <div className="text-xs text-dl-text-tertiary">
                  {currentUser?.role === "owner" ? "空间所有者" : "空间成员"}
                </div>
              </div>
              <div className="h-px bg-dl-border-hairline" />
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => openSettings("profile")}
              >
                <User className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                个人资料与状态
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => openSettings("devices")}
              >
                <Smartphone className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                活跃设备与安全
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => openSettings("qr")}
              >
                <QrCode className="size-4 text-dl-text-secondary" strokeWidth={1.75} />
                手机扫码登录
              </Button>
              <div className="h-px bg-dl-border-hairline" />
              <Button
                variant="danger"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => void logout()}
              >
                <LogOut className="size-4" strokeWidth={1.75} />
                退出当前账号
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </aside>
  );
}
