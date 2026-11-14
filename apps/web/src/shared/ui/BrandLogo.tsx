import React, { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type BrandLogoSize = "xs" | "sm" | "md" | "lg" | number;

export interface BrandLogoProps {
  /** Pixel dimension or preset token (`xs`=16, `sm`=24, `md`=36, `lg`=48). */
  size?: BrandLogoSize;
  /** Wrap the Liquid Vibrancy Panes mark inside an Obsidian Dark Glass squircle tile. */
  withTile?: boolean;
  /** Render in single-color `currentColor` optical silhouette mode. */
  monochrome?: boolean;
  /** Enable subtle glass pane alignment entrance motion. */
  animated?: boolean;
  /** Accessible label when rendered standalone without adjacent `DualLane` text. */
  label?: string;
  className?: string;
}

const SIZE_MAP: Record<Exclude<BrandLogoSize, number>, number> = {
  xs: 16,
  sm: 24,
  md: 36,
  lg: 48,
};

/**
 * DualLane v1.0 Master Brand Mark — 叠境双晶 (`Liquid Vibrancy Panes`).
 *
 * Geometry (`256×256` optical grid, zero letterforms, zero legacy arcs):
 * - Left tilted squircle glass pane (`rotate(-12 101 134)`): Shared Space · Abyssal Electric Blue
 * - Right tilted squircle glass pane (`rotate(12 155 122)`): Private Direct · Obsidian Amber
 * - Central intersection lens: Pearlescent Liquid Vibrancy refraction highlight
 */
export function BrandLogo({
  size = "md",
  withTile = false,
  monochrome = false,
  animated = false,
  label,
  className,
}: BrandLogoProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const pixelSize = typeof size === "number" ? size : SIZE_MAP[size];
  const innerSvgSize = withTile ? Math.max(14, Math.round(pixelSize * 0.78)) : pixelSize;
  const isSmallOptical = innerSvgSize <= 20;

  const amberGradId = `dl-pane-amber-${rawId}`;
  const blueGradId = `dl-pane-blue-${rawId}`;
  const lensGradId = `dl-pane-lens-${rawId}`;
  const specGradId = `dl-pane-spec-${rawId}`;
  const clipBlueId = `dl-pane-clip-${rawId}`;

  const fillBlue = monochrome ? "currentColor" : `url(#${blueGradId})`;
  const fillAmber = monochrome ? "currentColor" : `url(#${amberGradId})`;
  const fillLens = monochrome ? "currentColor" : `url(#${lensGradId})`;
  const strokeSpec = monochrome || isSmallOptical ? "none" : `url(#${specGradId})`;
  const strokeWidth = monochrome || isSmallOptical ? 0 : 2;

  const bluePaneTransform = "rotate(-12 101 134)";
  const amberPaneTransform = "rotate(12 155 122)";

  const svgElement = (
    <svg
      viewBox="0 0 256 256"
      width={innerSvgSize}
      height={innerSvgSize}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-brand-mark="vibrancy-panes"
      data-optical-mode={isSmallOptical ? "compact" : "detail"}
      aria-hidden={withTile || !label ? true : undefined}
      role={!withTile && label ? "img" : undefined}
      aria-label={!withTile && label ? label : undefined}
      className={cn("shrink-0 select-none", !withTile && className)}
    >
      <defs>
        <clipPath id={clipBlueId}>
          <rect
            x="44"
            y="64"
            width="114"
            height="140"
            rx="34"
            transform={bluePaneTransform}
          />
        </clipPath>
        {!monochrome && (
          <>
            <linearGradient id={blueGradId} x1="0%" y1="12%" x2="95%" y2="88%">
              <stop offset="0%" stopColor="#BAE6FD" />
              <stop offset="45%" stopColor="#0EA5E9" />
              <stop offset="100%" stopColor="#0369A1" />
            </linearGradient>
            <linearGradient id={amberGradId} x1="0%" y1="12%" x2="95%" y2="88%">
              <stop offset="0%" stopColor="#FDE68A" />
              <stop offset="45%" stopColor="#F97316" />
              <stop offset="100%" stopColor="#C2410C" />
            </linearGradient>
            <linearGradient id={lensGradId} x1="20%" y1="10%" x2="80%" y2="90%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
              <stop offset="55%" stopColor="#E0F2FE" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#FED7AA" stopOpacity="0.76" />
            </linearGradient>
            <linearGradient id={specGradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.72" />
              <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
            </linearGradient>
          </>
        )}
      </defs>

      {animated ? (
        <>
          <motion.g
            initial={{ opacity: 0.76, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
          >
            <rect
              x="44"
              y="64"
              width="114"
              height="140"
              rx="34"
              transform={bluePaneTransform}
              fill={fillBlue}
              fillOpacity={monochrome ? 0.56 : undefined}
              stroke={strokeSpec}
              strokeWidth={strokeWidth}
            />
          </motion.g>
          <motion.g
            initial={{ opacity: 0.76, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.38, delay: 0.03, ease: [0.16, 1, 0.3, 1] }}
          >
            <rect
              x="98"
              y="52"
              width="114"
              height="140"
              rx="34"
              transform={amberPaneTransform}
              fill={fillAmber}
              fillOpacity={monochrome ? 0.78 : 0.9}
              stroke={strokeSpec}
              strokeWidth={strokeWidth}
            />
          </motion.g>
          <motion.g
            clipPath={`url(#${clipBlueId})`}
            initial={{ opacity: 0.5 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.42, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            <rect
              x="98"
              y="52"
              width="114"
              height="140"
              rx="34"
              transform={amberPaneTransform}
              fill={fillLens}
              stroke={monochrome || isSmallOptical ? "none" : "#FFFFFF"}
              strokeOpacity={monochrome || isSmallOptical ? undefined : 0.7}
              strokeWidth={monochrome || isSmallOptical ? 0 : 1.5}
            />
          </motion.g>
        </>
      ) : (
        <>
          <rect
            x="44"
            y="64"
            width="114"
            height="140"
            rx="34"
            transform={bluePaneTransform}
            fill={fillBlue}
            fillOpacity={monochrome ? 0.56 : undefined}
            stroke={strokeSpec}
            strokeWidth={strokeWidth}
          />
          <rect
            x="98"
            y="52"
            width="114"
            height="140"
            rx="34"
            transform={amberPaneTransform}
            fill={fillAmber}
            fillOpacity={monochrome ? 0.78 : 0.9}
            stroke={strokeSpec}
            strokeWidth={strokeWidth}
          />
          <g clipPath={`url(#${clipBlueId})`}>
            <rect
              x="98"
              y="52"
              width="114"
              height="140"
              rx="34"
              transform={amberPaneTransform}
              fill={fillLens}
              stroke={monochrome || isSmallOptical ? "none" : "#FFFFFF"}
              strokeOpacity={monochrome || isSmallOptical ? undefined : 0.7}
              strokeWidth={monochrome || isSmallOptical ? 0 : 1.5}
            />
          </g>
        </>
      )}
    </svg>
  );

  if (!withTile) {
    return svgElement;
  }

  const tileRadius = Math.max(6, Math.round(pixelSize * 0.28));

  return (
    <div
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{
        width: pixelSize,
        height: pixelSize,
        borderRadius: tileRadius,
        background:
          "radial-gradient(120% 120% at 22% 15%, #1E2D45 0%, #0B111B 62%, #060A11 100%)",
        boxShadow:
          "inset 0 1px 1px rgba(255, 255, 255, 0.2), 0 8px 18px -6px rgba(6, 10, 17, 0.42)",
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center select-none text-slate-100",
        className
      )}
    >
      {svgElement}
    </div>
  );
}
