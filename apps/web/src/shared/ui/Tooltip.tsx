import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({
  content,
  side = "right",
  children
}: {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <RadixTooltip.Root delayDuration={260}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          className={cn(
            "dl-anim-popover dl-glass-elevated z-toast rounded-tag border border-line px-2.5 py-1 text-[12px] font-medium text-text"
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
