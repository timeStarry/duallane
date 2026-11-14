import React, { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type BrandLogoSize = "xs" | "sm" | "md" | "lg" | number;

export interface BrandLogoProps {
  /** Pixel dimension or preset token (`xs`=16, `sm`=24, `md`=36, `lg`=48). */
  size?: BrandLogoSize;
  /** Wrap the Dichroic Prism mark inside an Obsidian Dark Glass squircle tile. */
  withTile?: boolean;
  /** Render in single-color `currentColor` optical silhouette mode. */
  monochrome?: boolean;
  /** Enable subtle optical beam refraction entrance motion. */
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
 * DualLane v1.0 Master Brand Mark — Lateral Dichroic Prism Splitter (`棱镜横轴分光`).
 *
 * Geometry (`256×256` optical grid, zero letterforms, zero legacy arcs):
 * - Left 45° frosted dichroic incident crystal centered at `(76, 128)`
 * - Upper-right reflected Obsidian Amber beam (`Private Direct · E2EE RAM-only`)
 * - Lower-right transmitted Abyssal Electric Blue beam (`Shared Space · Persisted`)
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
  const innerSvgSize = withTile ? Math.max(14, Math.round(pixelSize * 0.76)) : pixelSize;
  const isSmallOptical = innerSvgSize <= 20;

  const amberGradId = `dl-prism-amber-${rawId}`;
  const blueGradId = `dl-prism-blue-${rawId}`;
  const crystalGradId = `dl-prism-crystal-${rawId}`;
  const rimGradId = `dl-prism-rim-${rawId}`;

  const fillCrystal = monochrome ? "currentColor" : `url(#${crystalGradId})`;
  const fillAmber = monochrome ? "currentColor" : `url(#${amberGradId})`;
  const fillBlue = monochrome ? "currentColor" : `url(#${blueGradId})`;
  const strokeRim = monochrome || isSmallOptical ? "none" : `url(#${rimGradId})`;
  const strokeWidth = monochrome || isSmallOptical ? 0 : 1.5;

  const crystalPath =
    "M 70 90 Q 76 84 82 90 L 114 122 Q 120 128 114 134 L 82 166 Q 76 172 70 166 L 38 134 Q 32 128 38 122 Z";
  const reflectedAmberBeamPath =
    "M 99 69 Q 93 71 97 76 L 131 110 Q 135 114 141 112 L 212 86 Q 218 84 218 77 L 218 51 Q 218 44 211 46 Z";
  const transmittedBlueBeamPath =
    "M 99 187 Q 93 185 97 180 L 131 146 Q 135 142 141 144 L 212 170 Q 218 172 218 179 L 218 205 Q 218 212 211 210 Z";

  const svgElement = (
    <svg
      viewBox="0 0 256 256"
      width={innerSvgSize}
      height={innerSvgSize}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-brand-mark="dichroic-prism"
      data-optical-mode={isSmallOptical ? "compact" : "detail"}
      aria-hidden={withTile || !label ? true : undefined}
      role={!withTile && label ? "img" : undefined}
      aria-label={!withTile && label ? label : undefined}
      className={cn("shrink-0 select-none", !withTile && className)}
    >
      {!monochrome && (
        <defs>
          <linearGradient id={amberGradId} x1="12%" y1="15%" x2="90%" y2="85%">
            <stop offset="0%" stopColor="#FCD34D" />
            <stop offset="46%" stopColor="#F97316" />
            <stop offset="100%" stopColor="#C2410C" />
          </linearGradient>
          <linearGradient id={blueGradId} x1="12%" y1="15%" x2="90%" y2="88%">
            <stop offset="0%" stopColor="#7DD3FC" />
            <stop offset="46%" stopColor="#0EA5E9" />
            <stop offset="100%" stopColor="#0369A1" />
          </linearGradient>
          <linearGradient id={crystalGradId} x1="15%" y1="10%" x2="85%" y2="90%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.96" />
            <stop offset="55%" stopColor="#CBD5E1" stopOpacity="0.84" />
            <stop offset="100%" stopColor="#64748B" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id={rimGradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.58" />
            <stop offset="55%" stopColor="#FFFFFF" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}

      <path
        d={crystalPath}
        fill={fillCrystal}
        fillOpacity={monochrome ? 0.55 : undefined}
        stroke={strokeRim}
        strokeWidth={strokeWidth}
      />

      {!isSmallOptical && !monochrome && (
        <line
          x1="55"
          y1="107"
          x2="97"
          y2="149"
          stroke="#FFFFFF"
          strokeOpacity="0.46"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}

      {animated ? (
        <>
          <motion.path
            d={reflectedAmberBeamPath}
            fill={fillAmber}
            stroke={strokeRim}
            strokeWidth={strokeWidth}
            initial={{ opacity: 0.72, x: -4, y: 2 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
          />
          <motion.path
            d={transmittedBlueBeamPath}
            fill={fillBlue}
            fillOpacity={monochrome ? 0.78 : undefined}
            stroke={strokeRim}
            strokeWidth={strokeWidth}
            initial={{ opacity: 0.72, x: -4, y: -2 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ duration: 0.38, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
          />
        </>
      ) : (
        <>
          <path
            d={reflectedAmberBeamPath}
            fill={fillAmber}
            stroke={strokeRim}
            strokeWidth={strokeWidth}
          />
          <path
            d={transmittedBlueBeamPath}
            fill={fillBlue}
            fillOpacity={monochrome ? 0.78 : undefined}
            stroke={strokeRim}
            strokeWidth={strokeWidth}
          />
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
          "radial-gradient(120% 120% at 22% 15%, #1A2639 0%, #0B111B 62%, #060A11 100%)",
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
