import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none",
    "rounded-control border transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-120 ease-out",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    "disabled:pointer-events-none disabled:opacity-45",
    "active:scale-[0.98] cursor-pointer"
  ],
  {
    variants: {
      variant: {
        primary: "border-transparent bg-accent text-on-shared shadow-sm hover:brightness-105",
        secondary: "border-line-strong bg-surface/80 text-text hover:bg-soft",
        glass: "border-line bg-glass-pill text-text backdrop-blur-md hover:bg-glass-elevated",
        ghost: "border-transparent bg-transparent text-text hover:bg-soft/80",
        danger: "border-danger/30 bg-danger-soft text-danger hover:bg-danger hover:text-white"
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-[14px]",
        lg: "h-11 px-5 text-[15px]"
      }
    },
    defaultVariants: {
      variant: "secondary",
      size: "md"
    }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, busy = false, disabled, children, type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {busy && <Loader2 className="size-4 animate-spin shrink-0" aria-hidden="true" />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

const iconButtonVariants = cva(
  [
    "inline-flex items-center justify-center shrink-0 select-none rounded-control border",
    "transition-[background-color,border-color,color,opacity,transform] duration-120 ease-out",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    "disabled:pointer-events-none disabled:opacity-40",
    "active:scale-[0.95] cursor-pointer"
  ],
  {
    variants: {
      variant: {
        ghost: "border-transparent bg-transparent text-muted hover:bg-soft/85 hover:text-text",
        glass: "border-line bg-glass-pill text-text backdrop-blur-md hover:bg-glass-elevated",
        secondary: "border-line-strong bg-surface/80 text-text hover:bg-soft",
        primary: "border-transparent bg-accent text-on-shared hover:brightness-105",
        danger: "border-transparent bg-transparent text-danger hover:bg-danger-soft"
      },
      size: {
        sm: "size-8",
        md: "size-9",
        lg: "size-11"
      }
    },
    defaultVariants: {
      variant: "ghost",
      size: "md"
    }
  }
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, label, type = "button", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={props.title ?? label}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);
IconButton.displayName = "IconButton";
