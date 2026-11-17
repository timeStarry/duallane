import { ContextMenu as RadixContextMenu, DropdownMenu as RadixDropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "👀"];

export function ContextMenuContent({
  className,
  quickReactions,
  onQuickReaction,
  children
}: {
  className?: string;
  quickReactions?: string[];
  onQuickReaction?: (emoji: string) => void;
  children: ReactNode;
}) {
  const emojis = quickReactions ?? QUICK_REACTIONS;
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content
        className={cn(
          "dl-anim-popover dl-glass-elevated z-popover min-w-[208px] rounded-panel border border-line p-1.5 text-text focus:outline-none",
          className
        )}
      >
        {onQuickReaction && (
          <>
            <div className="mb-1 flex items-center justify-between gap-1 px-1 py-0.5">
              {emojis.map((emoji) => (
                <RadixContextMenu.Item
                  key={emoji}
                  onSelect={() => onQuickReaction(emoji)}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-control text-[17px] transition-transform duration-120 hover:scale-125 hover:bg-soft/90 focus:bg-soft/90 focus:outline-none"
                >
                  {emoji}
                </RadixContextMenu.Item>
              ))}
            </div>
            <RadixContextMenu.Separator className="my-1 h-px bg-line" />
          </>
        )}
        {children}
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  icon,
  tone = "default",
  disabled,
  onSelect,
  children
}: {
  icon?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <RadixContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex h-9 cursor-pointer items-center gap-2.5 rounded-control px-2.5 text-[13.5px] font-medium select-none",
        "transition-colors duration-100 focus:outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        tone === "danger"
          ? "text-danger data-[highlighted]:bg-danger-soft"
          : "text-text data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent"
      )}
    >
      {icon && <span className="size-4 shrink-0 opacity-80">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className="my-1 h-px bg-line" />;
}

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  quickReactions,
  onQuickReaction,
  children
}: {
  className?: string;
  sideOffset?: number;
  align?: "start" | "center" | "end";
  quickReactions?: string[];
  onQuickReaction?: (emoji: string) => void;
  children: ReactNode;
}) {
  const emojis = quickReactions ?? QUICK_REACTIONS;
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        className={cn(
          "dl-anim-popover dl-glass-elevated z-popover min-w-[208px] rounded-panel border border-line p-1.5 text-text focus:outline-none",
          className
        )}
      >
        {onQuickReaction && (
          <>
            <div className="mb-1 flex items-center justify-between gap-1 px-1 py-0.5">
              {emojis.map((emoji) => (
                <RadixDropdownMenu.Item
                  key={emoji}
                  onSelect={() => onQuickReaction(emoji)}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-control text-[17px] transition-transform duration-120 hover:scale-125 hover:bg-soft/90 focus:bg-soft/90 focus:outline-none"
                >
                  {emoji}
                </RadixDropdownMenu.Item>
              ))}
            </div>
            <RadixDropdownMenu.Separator className="my-1 h-px bg-line" />
          </>
        )}
        {children}
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
}

export function DropdownMenuItem({
  icon,
  tone = "default",
  disabled,
  onSelect,
  children
}: {
  icon?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <RadixDropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex h-9 cursor-pointer items-center gap-2.5 rounded-control px-2.5 text-[13.5px] font-medium select-none",
        "transition-colors duration-100 focus:outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        tone === "danger"
          ? "text-danger data-[highlighted]:bg-danger-soft"
          : "text-text data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent"
      )}
    >
      {icon && <span className="size-4 shrink-0 opacity-80">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
    </RadixDropdownMenu.Item>
  );
}

export function DropdownMenuSeparator() {
  return <RadixDropdownMenu.Separator className="my-1 h-px bg-line" />;
}
