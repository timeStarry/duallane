import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { IconButton } from "@/shared/ui/Button";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

interface DialogContentProps extends ComponentPropsWithoutRef<typeof RadixDialog.Content> {
  size?: "sm" | "md" | "lg" | "xl";
  showCloseButton?: boolean;
  children: ReactNode;
}

const SIZE_CLASSES = {
  sm: "w-[min(420px,calc(100vw-24px))]",
  md: "w-[min(560px,calc(100vw-24px))]",
  lg: "w-[min(780px,calc(100vw-24px))]",
  xl: "w-[min(960px,calc(100vw-24px))] h-[min(720px,calc(100dvh-32px))]"
};

export function DialogContent({
  size = "md",
  showCloseButton = true,
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay
        className={cn(
          "dl-anim-scrim fixed inset-0 z-dialog bg-backdrop backdrop-blur-[6px]"
        )}
      />
      <div className="fixed inset-0 z-dialog flex items-center justify-center p-4 pointer-events-none">
        <RadixDialog.Content
          className={cn(
            "dl-anim-dialog dl-glass-dialog relative pointer-events-auto",
            "max-h-[calc(100dvh-32px)] overflow-hidden rounded-dialog border border-line text-text",
            "flex flex-col focus:outline-none",
            SIZE_CLASSES[size],
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <RadixDialog.Close asChild>
              <IconButton
                label="关闭弹窗"
                size="sm"
                variant="ghost"
                className="absolute right-3.5 top-3.5 z-10 rounded-full"
              >
                <X className="size-4" />
              </IconButton>
            </RadixDialog.Close>
          )}
        </RadixDialog.Content>
      </div>
    </RadixDialog.Portal>
  );
}

export function DialogHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1 border-b border-line px-6 py-4 pr-14", className)}>
      {children}
    </div>
  );
}

export function DialogTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <RadixDialog.Title className={cn("text-[17px] font-semibold tracking-tight text-text", className)}>
      {children}
    </RadixDialog.Title>
  );
}

export function DialogDescription({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <RadixDialog.Description className={cn("text-[13px] text-muted leading-relaxed", className)}>
      {children}
    </RadixDialog.Description>
  );
}

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex items-center justify-end gap-2.5 border-t border-line px-6 py-3.5", className)}>
      {children}
    </div>
  );
}
