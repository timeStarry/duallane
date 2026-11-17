import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { cn } from "@/shared/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  disabled,
  label,
  className
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={label || placeholder}
        className={cn(
          "inline-flex h-10 w-full items-center justify-between gap-2 rounded-control border border-line-strong",
          "bg-surface/80 px-3 text-[14px] text-text transition-colors duration-120",
          "hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          "disabled:pointer-events-none disabled:opacity-45 cursor-pointer",
          className
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="text-muted">
          <ChevronDown className="size-4" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "dl-anim-popover dl-glass-elevated z-popover min-w-[var(--radix-select-trigger-width)]",
            "max-h-[300px] overflow-hidden rounded-panel border border-line p-1.5 text-text"
          )}
        >
          <RadixSelect.Viewport className="flex flex-col gap-0.5">
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={cn(
                  "relative flex min-h-10 cursor-pointer items-center gap-2 rounded-control py-1.5 pl-8 pr-3 text-[13.5px] select-none",
                  "focus:outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                )}
              >
                <span className="absolute left-2.5 flex size-4 items-center justify-center">
                  <RadixSelect.ItemIndicator>
                    <Check className="size-3.5 text-accent" />
                  </RadixSelect.ItemIndicator>
                </span>
                <span className="flex flex-col">
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  {opt.description && <span className="text-[11.5px] text-muted">{opt.description}</span>}
                </span>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
