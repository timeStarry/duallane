import React, { useEffect, useId, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { LaneId } from "@/entities/lane/store";
import { useThemeStore } from "@/shared/theme/vibrancy";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

export interface DualLaneDeckSwitchProps {
  activeLane: LaneId;
  onToggleLane: (nextLane: LaneId) => void;
  /** Whether an encrypted P2P session is currently active in memory. */
  hasActiveP2PRoom?: boolean;
  /** Aggregate unread count across Shared Workspace conversations. */
  workspaceUnreadCount?: number;
  className?: string;
}

type CardPose = {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  opacity: number;
};

const POSES: {
  workspaceFront: {
    blue: CardPose;
    blueHover: CardPose;
    amber: CardPose;
    amberHover: CardPose;
  };
  p2pFront: {
    amber: CardPose;
    amberHover: CardPose;
    blue: CardPose;
    blueHover: CardPose;
  };
  fanToP2P: {
    amberIncoming: CardPose;
    blueOutgoing: CardPose;
  };
  fanToWorkspace: {
    blueIncoming: CardPose;
    amberOutgoing: CardPose;
  };
} = {
  workspaceFront: {
    blue: { x: -11, y: 9, rotate: -8, scale: 1, opacity: 1 },
    blueHover: { x: -15, y: 11, rotate: -10, scale: 1.02, opacity: 1 },
    amber: { x: 22, y: -13, rotate: 15, scale: 0.87, opacity: 0.85 },
    amberHover: { x: 33, y: -19, rotate: 22, scale: 0.91, opacity: 0.96 },
  },
  p2pFront: {
    amber: { x: 11, y: 9, rotate: 8, scale: 1, opacity: 1 },
    amberHover: { x: 15, y: 11, rotate: 10, scale: 1.02, opacity: 1 },
    blue: { x: -22, y: -13, rotate: -15, scale: 0.87, opacity: 0.85 },
    blueHover: { x: -33, y: -19, rotate: -22, scale: 0.91, opacity: 0.96 },
  },
  fanToP2P: {
    amberIncoming: { x: 50, y: -22, rotate: 27, scale: 1.05, opacity: 1 },
    blueOutgoing: { x: -44, y: 15, rotate: -23, scale: 0.89, opacity: 0.86 },
  },
  fanToWorkspace: {
    blueIncoming: { x: -50, y: -22, rotate: -27, scale: 1.05, opacity: 1 },
    amberOutgoing: { x: 44, y: 15, rotate: 23, scale: 0.89, opacity: 0.86 },
  },
};

const FAN_OUT_MS = 160;

/**
 * Interactive Top-Left Brand Deck Switcher (`叠境双晶 · 卡片叠换切换器`).
 *
 * Turns the DualLane v1.0 Liquid Vibrancy Panes mark into a tactile two-card deck:
 * - Sky-Blue Crystal Card = Shared Workspace (`空间`)
 * - Warm-Amber Crystal Card = Private Direct (`直连`)
 *
 * Clicking (or `⌘1` / `⌘2` / `⌘\`) fans the rear crystal card outward along an arc,
 * swaps physical z-order at peak separation so the cards never clip through each other,
 * and settles the new active card crisply onto the foreground stage.
 */
export function DualLaneDeckSwitch({
  activeLane,
  onToggleLane,
  hasActiveP2PRoom = false,
  workspaceUnreadCount = 0,
  className,
}: DualLaneDeckSwitchProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const osReducedMotion = useReducedMotion();
  const storeReducedMotion = useThemeStore((s) => s.reducedMotion);
  const preferReducedMotion = Boolean(osReducedMotion || storeReducedMotion);

  const [trackedLane, setTrackedLane] = useState<LaneId>(activeLane);
  const [frontCard, setFrontCard] = useState<LaneId>(activeLane);
  const [shufflePhase, setShufflePhase] = useState<"idle" | "fan-to-p2p" | "fan-to-workspace">(
    "idle"
  );
  const [hovered, setHovered] = useState(false);

  if (trackedLane !== activeLane) {
    setTrackedLane(activeLane);
    if (preferReducedMotion) {
      setFrontCard(activeLane);
      setShufflePhase("idle");
    } else {
      setShufflePhase(activeLane === "p2p" ? "fan-to-p2p" : "fan-to-workspace");
    }
  }

  const effectiveFrontCard = preferReducedMotion ? activeLane : frontCard;

  useEffect(() => {
    if (shufflePhase === "idle") {
      return;
    }
    const targetLane: LaneId = shufflePhase === "fan-to-p2p" ? "p2p" : "workspace";
    const swapTimer = setTimeout(() => {
      setFrontCard(targetLane);
      setShufflePhase("idle");
    }, FAN_OUT_MS);

    return () => {
      clearTimeout(swapTimer);
    };
  }, [shufflePhase]);

  const nextLane: LaneId = activeLane === "workspace" ? "p2p" : "workspace";

  let bluePose: CardPose;
  let amberPose: CardPose;

  if (shufflePhase === "fan-to-p2p") {
    amberPose = POSES.fanToP2P.amberIncoming;
    bluePose = POSES.fanToP2P.blueOutgoing;
  } else if (shufflePhase === "fan-to-workspace") {
    bluePose = POSES.fanToWorkspace.blueIncoming;
    amberPose = POSES.fanToWorkspace.amberOutgoing;
  } else if (activeLane === "workspace") {
    bluePose = hovered ? POSES.workspaceFront.blueHover : POSES.workspaceFront.blue;
    amberPose = hovered ? POSES.workspaceFront.amberHover : POSES.workspaceFront.amber;
  } else {
    amberPose = hovered ? POSES.p2pFront.amberHover : POSES.p2pFront.amber;
    bluePose = hovered ? POSES.p2pFront.blueHover : POSES.p2pFront.blue;
  }

  const cardTransition = preferReducedMotion
    ? { duration: 0.14, ease: "easeOut" as const }
    : shufflePhase !== "idle"
      ? { duration: FAN_OUT_MS / 1000, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }
      : { type: "spring" as const, stiffness: 410, damping: 26, mass: 0.84 };

  const blueGradId = `dl-deck-blue-${rawId}`;
  const amberGradId = `dl-deck-amber-${rawId}`;
  const lensGradId = `dl-deck-lens-${rawId}`;
  const specGradId = `dl-deck-spec-${rawId}`;
  const backClipId = `dl-deck-back-clip-${rawId}`;
  const dropShadowId = `dl-deck-shadow-${rawId}`;

  const backPose = effectiveFrontCard === "workspace" ? amberPose : bluePose;
  const frontPose = effectiveFrontCard === "workspace" ? bluePose : amberPose;

  const renderBlueCard = (isFront: boolean) => (
    <motion.g
      key="card-workspace"
      data-card-lane="workspace"
      data-card-depth={isFront ? "front" : "back"}
      initial={false}
      animate={bluePose}
      transition={cardTransition}
      style={{ transformOrigin: "128px 128px" }}
      filter={isFront ? `url(#${dropShadowId})` : undefined}
    >
      <rect
        x="70"
        y="57"
        width="116"
        height="142"
        rx="34"
        fill={`url(#${blueGradId})`}
        stroke={`url(#${specGradId})`}
        strokeWidth={isFront ? 2.6 : 1.6}
      />
      {/* Subtle crystalline workspace channel motif */}
      <rect
        x="93"
        y="95"
        width="56"
        height="9"
        rx="4.5"
        fill="#FFFFFF"
        fillOpacity={isFront ? 0.32 : 0.16}
      />
      <rect
        x="93"
        y="114"
        width="70"
        height="9"
        rx="4.5"
        fill="#FFFFFF"
        fillOpacity={isFront ? 0.22 : 0.12}
      />
      <circle
        cx="102"
        cy="151"
        r="7"
        fill="#E0F2FE"
        fillOpacity={isFront ? 0.38 : 0.18}
      />
    </motion.g>
  );

  const renderAmberCard = (isFront: boolean) => (
    <motion.g
      key="card-p2p"
      data-card-lane="p2p"
      data-card-depth={isFront ? "front" : "back"}
      initial={false}
      animate={amberPose}
      transition={cardTransition}
      style={{ transformOrigin: "128px 128px" }}
      filter={isFront ? `url(#${dropShadowId})` : undefined}
    >
      <rect
        x="70"
        y="57"
        width="116"
        height="142"
        rx="34"
        fill={`url(#${amberGradId})`}
        stroke={`url(#${specGradId})`}
        strokeWidth={isFront ? 2.6 : 1.6}
      />
      {/* Subtle crystalline E2EE shield-keyhole motif */}
      <circle
        cx="128"
        cy="115"
        r="14"
        stroke="#FFFFFF"
        strokeOpacity={isFront ? 0.36 : 0.18}
        strokeWidth="6"
      />
      <rect
        x="122"
        y="126"
        width="12"
        height="26"
        rx="6"
        fill="#FFFBEB"
        fillOpacity={isFront ? 0.34 : 0.16}
      />
    </motion.g>
  );

  const showBgP2PPulse = activeLane === "workspace" && hasActiveP2PRoom;
  const showBgWorkspaceUnread = activeLane === "p2p" && workspaceUnreadCount > 0;

  const ariaLabel =
    activeLane === "workspace"
      ? `通道叠换：当前共享空间，点击切换至私密直连${hasActiveP2PRoom ? "（直连房间活跃）" : ""}`
      : `通道叠换：当前私密直连，点击切换至共享空间${
          workspaceUnreadCount > 0 ? `（${workspaceUnreadCount} 条未读）` : ""
        }`;

  const tooltipText =
    activeLane === "workspace"
      ? `当前：共享空间 · 点击叠换至私密直连${hasActiveP2PRoom ? " (房间活跃)" : ""} (⌘2 / ⌘\\)`
      : `当前：私密直连 · 点击叠换至共享空间${
          workspaceUnreadCount > 0 ? ` (${workspaceUnreadCount} 条未读)` : ""
        } (⌘1 / ⌘\\)`;

  return (
    <Tooltip content={tooltipText} side="right">
      <motion.button
        type="button"
        data-testid="dual-lane-deck-switch"
        data-active-lane={activeLane}
        data-front-card={effectiveFrontCard}
        aria-label={ariaLabel}
        whileTap={preferReducedMotion ? undefined : { scale: 0.93 }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => onToggleLane(nextLane)}
        className={cn(
          "group relative flex flex-col items-center gap-1.5 rounded-2xl p-1 outline-none transition-colors cursor-pointer",
          "focus-visible:ring-2 focus-visible:ring-focus",
          "max-compact:flex-row max-compact:gap-1.5 max-compact:rounded-xl max-compact:bg-dl-surface-subtle/75 max-compact:px-2 max-compact:py-1 max-compact:border max-compact:border-dl-border-hairline",
          className
        )}
      >
        {/* Obsidian Squircle Stage housing the 2-Card Crystal Deck */}
        <div
          style={{
            background:
              activeLane === "workspace"
                ? "radial-gradient(125% 125% at 20% 15%, #19324E 0%, #0B121E 62%, #060A11 100%)"
                : "radial-gradient(125% 125% at 80% 15%, #3B2314 0%, #121016 62%, #07090F 100%)",
            boxShadow:
              activeLane === "workspace"
                ? "inset 0 1px 1px rgba(186, 230, 253, 0.28), 0 8px 18px -6px rgba(14, 165, 233, 0.36)"
                : "inset 0 1px 1px rgba(253, 230, 138, 0.28), 0 8px 18px -6px rgba(249, 115, 22, 0.36)",
          }}
          className={cn(
            "relative flex h-[42px] w-[42px] max-compact:h-7 max-compact:w-7 shrink-0 items-center justify-center rounded-[13px] max-compact:rounded-[9px] transition-shadow duration-200",
            activeLane === "workspace"
              ? "ring-1 ring-sky-400/35 group-hover:ring-sky-300/60"
              : "ring-1 ring-amber-400/40 group-hover:ring-amber-300/65"
          )}
        >
          <svg
            viewBox="0 0 256 256"
            className="h-[34px] w-[34px] max-compact:h-[23px] max-compact:w-[23px] overflow-visible select-none"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            data-brand-mark="vibrancy-panes"
            aria-hidden="true"
          >
            <defs>
              <clipPath id={backClipId}>
                <motion.rect
                  x="70"
                  y="57"
                  width="116"
                  height="142"
                  rx="34"
                  initial={false}
                  animate={backPose}
                  transition={cardTransition}
                  style={{ transformOrigin: "128px 128px" }}
                />
              </clipPath>
              <filter
                id={dropShadowId}
                x="-25%"
                y="-25%"
                width="150%"
                height="150%"
              >
                <feDropShadow
                  dx="0"
                  dy="8"
                  stdDeviation="8"
                  floodColor="#020617"
                  floodOpacity="0.48"
                />
              </filter>
              <linearGradient id={blueGradId} x1="0%" y1="10%" x2="95%" y2="90%">
                <stop offset="0%" stopColor="#BAE6FD" />
                <stop offset="46%" stopColor="#0EA5E9" />
                <stop offset="100%" stopColor="#0369A1" />
              </linearGradient>
              <linearGradient id={amberGradId} x1="0%" y1="10%" x2="95%" y2="90%">
                <stop offset="0%" stopColor="#FDE68A" />
                <stop offset="46%" stopColor="#F97316" />
                <stop offset="100%" stopColor="#C2410C" />
              </linearGradient>
              <linearGradient id={lensGradId} x1="18%" y1="12%" x2="82%" y2="88%">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.62" />
                <stop offset="55%" stopColor="#E0F2FE" stopOpacity="0.34" />
                <stop offset="100%" stopColor="#FED7AA" stopOpacity="0.3" />
              </linearGradient>
              <linearGradient id={specGradId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.82" />
                <stop offset="52%" stopColor="#FFFFFF" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {/* Dynamic SVG z-order: back crystal card first, active front crystal card on top */}
            {effectiveFrontCard === "workspace" ? (
              <>
                {renderAmberCard(false)}
                {renderBlueCard(true)}
              </>
            ) : (
              <>
                {renderBlueCard(false)}
                {renderAmberCard(true)}
              </>
            )}

            {/* Pearlescent Liquid Vibrancy intersection shimmer across the card overlap */}
            <g clipPath={`url(#${backClipId})`} style={{ pointerEvents: "none" }}>
              <motion.rect
                x="70"
                y="57"
                width="116"
                height="142"
                rx="34"
                initial={false}
                animate={frontPose}
                transition={cardTransition}
                style={{ transformOrigin: "128px 128px" }}
                fill={`url(#${lensGradId})`}
              />
            </g>
          </svg>

          {/* Background-lane live status dot (tucked card activity cue) */}
          {(showBgP2PPulse || (activeLane === "p2p" && hasActiveP2PRoom)) && (
            <span
              data-testid="deck-p2p-active-dot"
              className={cn(
                "absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[#0B121E]",
                "bg-amber-400 animate-pulse"
              )}
            />
          )}
          {showBgWorkspaceUnread && (
            <span
              data-testid="deck-workspace-unread-dot"
              className="absolute -top-1 -left-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-dl-lane-shared px-1 text-[9px] font-bold leading-none text-dl-on-shared ring-2 ring-[#0B121E]"
            >
              {workspaceUnreadCount > 9 ? "9+" : workspaceUnreadCount}
            </span>
          )}
        </div>

        {/* Crisp Current-Lane Micro-Pill + Shuffle Affordance */}
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-colors",
            "max-compact:px-0.5 max-compact:py-0 max-compact:text-[11px]",
            activeLane === "workspace"
              ? "bg-dl-lane-shared/14 text-dl-text-primary group-hover:bg-dl-lane-shared/22 max-compact:bg-transparent"
              : "bg-dl-lane-direct/16 text-dl-text-primary group-hover:bg-dl-lane-direct/24 max-compact:bg-transparent"
          )}
        >
          <span>{activeLane === "workspace" ? "空间" : "直连"}</span>
          <ArrowLeftRight
            className="size-2.5 text-dl-text-secondary opacity-80 transition-transform duration-200 group-hover:translate-x-0.5 max-compact:size-2.5"
            strokeWidth={2.2}
          />
        </span>
      </motion.button>
    </Tooltip>
  );
}
