import { Bot, Bookmark } from "lucide-react";
import { cn } from "@/shared/lib/cn";

export type AvatarKind = "human" | "group" | "bot" | "saved";

export function Avatar({
  name,
  src,
  kind = "human",
  size = "md",
  online,
  className
}: {
  name: string;
  src?: string | null;
  kind?: AvatarKind;
  size?: "sm" | "md" | "lg";
  online?: boolean;
  className?: string;
}) {
  const sizeClass = size === "sm" ? "size-8 text-[12px]" : size === "lg" ? "size-12 text-[16px]" : "size-10 text-[14px]";
  const shapeClass = kind === "human" || kind === "saved" ? "rounded-full" : "rounded-entity";
  const initial = (name.trim().slice(0, 1) || "?").toUpperCase();

  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center select-none", sizeClass, className)}>
      {kind === "saved" ? (
        <span className={cn("flex size-full items-center justify-center bg-shared-soft text-shared border border-shared/25", shapeClass)}>
          <Bookmark className="size-[46%]" />
        </span>
      ) : src ? (
        <img
          src={src}
          alt={name}
          className={cn("size-full object-cover border border-line", shapeClass)}
        />
      ) : (
        <span
          className={cn(
            "flex size-full items-center justify-center font-semibold border border-line",
            kind === "bot" ? "bg-accent-soft text-accent" : "bg-soft text-text",
            shapeClass
          )}
        >
          {kind === "bot" ? <Bot className="size-[48%]" /> : initial}
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
