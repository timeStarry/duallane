import { useState } from "react";
import { Bot, Bookmark } from "lucide-react";
import { cn } from "@/shared/lib/cn";

export type AvatarKind = "human" | "group" | "bot" | "saved";

export type BotAvatarColor =
  | "azure"
  | "indigo"
  | "violet"
  | "emerald"
  | "cyan"
  | "amber"
  | "rose"
  | "slate";

export interface BotColorPreset {
  id: BotAvatarColor;
  label: string;
  solid: string;
  gradient: string;
}

export const BOT_AVATAR_COLORS: readonly BotColorPreset[] = [
  {
    id: "azure",
    label: "晴空蓝",
    solid: "#0071E3",
    gradient: "linear-gradient(145deg, #3296FF 0%, #0062CC 100%)",
  },
  {
    id: "indigo",
    label: "星际靛",
    solid: "#5856D6",
    gradient: "linear-gradient(145deg, #7674FF 0%, #4643CC 100%)",
  },
  {
    id: "violet",
    label: "极光紫",
    solid: "#8E44EC",
    gradient: "linear-gradient(145deg, #AD62FF 0%, #732CD1 100%)",
  },
  {
    id: "emerald",
    label: "翡翠绿",
    solid: "#10B981",
    gradient: "linear-gradient(145deg, #2ED39A 0%, #099264 100%)",
  },
  {
    id: "cyan",
    label: "冰川青",
    solid: "#06B6D4",
    gradient: "linear-gradient(145deg, #22CEEB 0%, #0888A6 100%)",
  },
  {
    id: "amber",
    label: "琥珀金",
    solid: "#F59E0B",
    gradient: "linear-gradient(145deg, #FFB338 0%, #D97706 100%)",
  },
  {
    id: "rose",
    label: "珊瑚粉",
    solid: "#F43F5E",
    gradient: "linear-gradient(145deg, #FF6682 0%, #D62849 100%)",
  },
  {
    id: "slate",
    label: "钛金灰",
    solid: "#475569",
    gradient: "linear-gradient(145deg, #64748B 0%, #334155 100%)",
  },
] as const;

const BOT_COLOR_MAP: Record<string, BotColorPreset> = Object.fromEntries(
  BOT_AVATAR_COLORS.map((item) => [item.id, item])
);

export function resolveBotAvatarPalette(
  name: string,
  color?: string | null
): BotColorPreset {
  const normalized = color?.trim().toLowerCase() || "";
  if (normalized && BOT_COLOR_MAP[normalized]) {
    return BOT_COLOR_MAP[normalized]!;
  }
  const autoPool = BOT_AVATAR_COLORS.slice(0, 7);
  let hash = 0;
  const seed = name.trim() || "Bot";
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return autoPool[hash % autoPool.length] || BOT_AVATAR_COLORS[0]!;
}

export function Avatar({
  name,
  src,
  emoji,
  kind = "human",
  color,
  size = "md",
  online,
  className,
}: {
  name: string;
  src?: string | null;
  emoji?: string | null;
  kind?: AvatarKind;
  color?: string | null;
  size?: "sm" | "md" | "lg";
  online?: boolean;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const sizeClass =
    size === "sm"
      ? "size-8 text-[12px]"
      : size === "lg"
      ? "size-12 text-[16px]"
      : "size-10 text-[14px]";
  const emojiSizeClass =
    size === "sm" ? "text-[16px]" : size === "lg" ? "text-[24px]" : "text-[19px]";
  const shapeClass = kind === "human" || kind === "saved" ? "rounded-full" : "rounded-entity";
  const initial = (name.trim().slice(0, 1) || "?").toUpperCase();
  const cleanEmoji = emoji?.trim();
  const cleanSrc = src?.trim();
  const hasValidImg = Boolean(cleanSrc && failedSrc !== cleanSrc);
  const botPalette = kind === "bot" ? resolveBotAvatarPalette(name, color) : null;
  const explicitBotColor =
    kind === "bot" && color?.trim() && BOT_COLOR_MAP[color.trim().toLowerCase()]
      ? BOT_COLOR_MAP[color.trim().toLowerCase()]
      : null;

  return (
    <span
      data-avatar-kind={kind}
      data-bot-color={kind === "bot" ? botPalette?.id : undefined}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center select-none",
        sizeClass,
        className
      )}
    >
      {kind === "saved" ? (
        <span
          className={cn(
            "flex size-full items-center justify-center bg-shared-soft text-shared border border-shared/25",
            shapeClass
          )}
        >
          <Bookmark className="size-[46%]" />
        </span>
      ) : hasValidImg ? (
        <img
          src={cleanSrc}
          alt={name}
          onError={() => {
            if (cleanSrc) setFailedSrc(cleanSrc);
          }}
          style={
            explicitBotColor
              ? { boxShadow: `0 0 0 1.75px ${explicitBotColor.solid}` }
              : undefined
          }
          className={cn(
            "size-full object-cover",
            explicitBotColor ? "border border-white/60 dark:border-black/40" : "border border-line",
            shapeClass
          )}
        />
      ) : cleanEmoji ? (
        <span
          className={cn(
            "flex size-full items-center justify-center border border-line bg-soft leading-none",
            emojiSizeClass,
            shapeClass
          )}
        >
          {cleanEmoji}
        </span>
      ) : kind === "bot" && botPalette ? (
        <span
          style={{ backgroundImage: botPalette.gradient }}
          className={cn(
            "flex size-full items-center justify-center text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.34),0_1px_2px_rgba(15,23,42,0.14)] ring-1 ring-black/8 dark:ring-white/14",
            shapeClass
          )}
        >
          <Bot
            className="size-[52%] drop-shadow-[0_1px_1px_rgba(0,0,0,0.18)]"
            strokeWidth={2.15}
          />
        </span>
      ) : (
        <span
          className={cn(
            "flex size-full items-center justify-center font-semibold border border-line bg-soft text-text",
            shapeClass
          )}
        >
          {initial}
        </span>
      )}
      {online && (
        <span
          aria-label="在线"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface bg-success"
        />
      )}
    </span>
  );
}
