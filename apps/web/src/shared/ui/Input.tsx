import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-10 w-full rounded-control border border-line-strong bg-surface/80 px-3 text-[14px] text-text",
          "placeholder:text-muted/75 transition-[border-color,box-shadow,background-color] duration-120",
          "focus:border-focus focus:bg-surface focus:outline-none focus:ring-3 focus:ring-focus/20",
          "disabled:pointer-events-none disabled:opacity-45",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
