import { Popover as RadixPopover } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

interface PopoverContentProps extends ComponentPropsWithoutRef<typeof RadixPopover.Content> {
  children: ReactNode;
}

export function PopoverContent({
  className,
  sideOffset = 8,
  collisionPadding = 12,
  children,
  ...props
}: PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "dl-anim-popover dl-glass-elevated z-popover rounded-panel border border-line p-2 text-text focus:outline-none",
          className
        )}
        {...props}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
