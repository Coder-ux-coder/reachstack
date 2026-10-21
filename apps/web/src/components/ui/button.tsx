import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "soft" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-hover shadow-card disabled:hover:bg-brand",
  secondary: "border border-line-strong bg-panel text-text hover:bg-panel-2 shadow-card",
  ghost: "text-muted hover:bg-panel-2 hover:text-text",
  danger: "bg-bad-fill text-white hover:opacity-90 shadow-card",
  soft: "bg-brand-soft text-brand-text hover:brightness-95 dark:hover:brightness-125",
  link: "text-brand-text hover:underline underline-offset-2 px-0! h-auto!",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-xs gap-1 rounded-md",
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-lg",
  icon: "h-9 w-9 rounded-lg justify-center",
  "icon-sm": "h-7 w-7 rounded-md justify-center",
};

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) =>
  cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors select-none",
    "disabled:cursor-not-allowed disabled:opacity-50",
    variants[variant],
    sizes[size],
    className,
  );

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={14} className="text-current" /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({ variant = "secondary", size = "md", icon, className, children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
