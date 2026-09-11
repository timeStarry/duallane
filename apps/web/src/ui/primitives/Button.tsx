import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  lane?: "shared" | "direct";
  busy?: boolean;
  leadingIcon?: ReactNode;
};

export function Button({ variant = "secondary", lane = "shared", busy = false, leadingIcon, children, className = "", disabled, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined} data-variant={variant} data-lane={lane} className={`dl-button ${className}`}>
    {busy ? <LoaderCircle className="dl-spinner" size={18} aria-hidden="true" /> : leadingIcon}
    <span>{children}</span>
  </button>;
}

export type IconButtonProps = Omit<ButtonProps, "children" | "leadingIcon"> & { label: string; children: ReactNode };

export function IconButton({ label, children, className = "", variant = "quiet", ...props }: IconButtonProps) {
  return <Button {...props} variant={variant} aria-label={label} title={label} className={`dl-icon-button ${className}`}>{children}</Button>;
}
