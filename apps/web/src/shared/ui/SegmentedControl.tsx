import { DESIGN_TOKENS } from "@duallane/design-tokens";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  label: string;
  className?: string;
}) {
  const layoutGroupId = useId();

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-1 rounded-control border border-line bg-soft/75 p-1 backdrop-blur-sm",
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "relative inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium select-none",
              "transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              active ? "text-text" : "text-muted hover:text-text"
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutGroupId}
                transition={{
                  type: "spring",
                  stiffness: DESIGN_TOKENS.motion.spring.stiffness,
                  damping: DESIGN_TOKENS.motion.spring.damping
                }}
                className="absolute inset-0 rounded-[7px] border border-line bg-surface shadow-xs"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {option.icon}
              <span>{option.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
