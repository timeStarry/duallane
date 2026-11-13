import React from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { Avatar, Button, IconButton, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

export function PrimaryRail() {
  const {
    activeLane,
    setActiveLane,
    setSearchOpen,
    openSettings,
  } = useLaneStore();
  const {
    currentUser,
    connectionStatus,
    quotaUsedBytes,
    quotaLimitBytes,
    p2pRoom,
    logout,
  } = useWorkspaceStore();

  const quotaPct = Math.min(100, Math.round((quotaUsedBytes / Math.max(1, quotaLimitBytes)) * 100));

  return (
    <aside className="dl-glass-chrome flex h-full w-[72px] shrink-0 flex-col items-center justify-between border-r border-dl-border-hairline py-3.5 select-none">
      {/* Top: Brand & Dual-Lane Switcher */}
      <div className="flex flex-col items-center gap-3 w-full px-2">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-dl-lane-shared to-dl-lane-direct text-white font-bold text-sm shadow-sm"
          title="DualLane v1.0"
        >
          DL
        </div>

        <div className="h-px w-8 bg-dl-border-hairline" />

        <Tooltip content="共享空间 · 团队协作、话题与机器人 (⌘1)" side="right">
          <Button
            variant={activeLane === "workspace" ? "primary" : "ghost"}
            size="md"
            onClick={() => setActiveLane("workspace")}
            className={cn(
              "relative h-11 w-11 rounded-2xl p-0 flex-col gap-0.5",
              activeLane === "workspace" && "shadow-sm"
            )}
            aria-label="共享空间"
          >
            <span className="text-base leading-none">🏢</span>
            <span className="text-[10px] font-medium leading-none">空间</span>
          </Button>
        </Tooltip>

        <Tooltip
          content={`私密直连 · 端到端加密点对点${p2pRoom ? " (房间活跃)" : ""} (⌘2)`}
          side="right"
        >
          <Button
            variant={activeLane === "p2p" ? "secondary" : "ghost"}
            size="md"
            onClick={() => setActiveLane("p2p")}
            className={cn(
              "relative h-11 w-11 rounded-2xl p-0 flex-col gap-0.5",
              activeLane === "p2p" &&
                "bg-dl-lane-direct/15 text-dl-lane-direct border border-dl-lane-direct/30"
            )}
            aria-label="私密直连"
          >
            <span className="text-base leading-none">🔐</span>
            <span className="text-[10px] font-medium leading-none">直连</span>
            {p2pRoom && (
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-dl-lane-direct animate-pulse" />
            )}
          </Button>
        </Tooltip>

        <div className="h-px w-8 bg-dl-border-hairline" />

        <Tooltip content="全局搜索 (⌘K)" side="right">
          <IconButton
            variant="ghost"
            onClick={() => setSearchOpen(true)}
            className="h-10 w-10 rounded-xl"
            label="全局搜索"
          >
            <span className="text-base">🔍</span>
          </IconButton>
        </Tooltip>

        <Tooltip content="机器人与集成" side="right">
          <IconButton
            variant="ghost"
            onClick={() => openSettings("bots")}
            className="h-10 w-10 rounded-xl"
            label="机器人与集成"
          >
            <span className="text-base">🤖</span>
          </IconButton>
        </Tooltip>
      </div>

      {/* Bottom: Connection Status, Quota & User Menu */}
      <div className="flex flex-col items-center gap-2.5 w-full px-2">
        <Tooltip
          content={
            connectionStatus === "connected"
              ? "实时连接正常"
              : connectionStatus === "reconnecting"
              ? "正在重连…"
              : "离线"
          }
          side="right"
        >
          <div className="flex items-center gap-1.5 rounded-full px-2 py-1 bg-dl-surface-subtle/70 border border-dl-border-hairline">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                connectionStatus === "connected"
                  ? "bg-dl-success"
                  : connectionStatus === "reconnecting"
                  ? "bg-dl-warning animate-pulse"
                  : "bg-dl-danger"
              )}
            />
            <span className="text-[10px] text-dl-text-tertiary tabular-nums">{quotaPct}%</span>
          </div>
        </Tooltip>

        <Tooltip content="设置中心" side="right">
          <IconButton
            variant="ghost"
            onClick={() => openSettings("appearance")}
            className="h-9 w-9 rounded-xl"
            label="设置中心"
          >
            <span className="text-base">⚙️</span>
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
          <PopoverContent align="start" side="right">
          <div className="w-52 space-y-2 p-1">
            <div className="px-2 py-1">
              <div className="text-sm font-semibold text-dl-text-primary truncate">
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
              className="w-full justify-start"
              onClick={() => openSettings("profile")}
            >
              个人资料与状态
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => openSettings("devices")}
            >
              活跃设备与安全
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => openSettings("qr")}
            >
              手机扫码登录
            </Button>
            <div className="h-px bg-dl-border-hairline" />
            <Button
              variant="danger"
              size="sm"
              className="w-full justify-start"
              onClick={() => void logout()}
            >
              退出当前账号
            </Button>
          </div>
          </PopoverContent>
        </Popover>
      </div>
    </aside>
  );
}
