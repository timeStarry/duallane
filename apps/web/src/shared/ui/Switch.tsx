import { DESIGN_TOKENS } from "@duallane/design-tokens";
import { motion } from "motion/react";
import { Switch as RadixSwitch } from "radix-ui";
import { cn } from "@/shared/lib/cn";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  className
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex size-11 shrink-0 items-center justify-center", className)}>
      <RadixSwitch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "relative inline-flex h-[26px] w-[44px] shrink-0 cursor-pointer items-center rounded-full border border-transparent p-[3px]",
          "transition-colors duration-160 ease-out",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          "disabled:pointer-events-none disabled:opacity-45",
          checked ? "bg-accent" : "bg-control/75"
        )}
      >
        <RadixSwitch.Thumb asChild>
          <motion.span
            layout
            transition={{
              type: "spring",
              stiffness: DESIGN_TOKENS.motion.spring.stiffness,
              damping: DESIGN_TOKENS.motion.spring.damping
            }}
            className={cn(
              "block size-[20px] rounded-full shadow-sm",
              checked ? "translate-x-[18px] bg-on-accent" : "translate-x-0 bg-white"
            )}
          />
        </RadixSwitch.Thumb>
      </RadixSwitch.Root>
    </span>
  );
}
