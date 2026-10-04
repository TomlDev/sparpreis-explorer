import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "outline" | "ghost" | "subtle" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "icon";

/** Button look for other elements (e.g. a Link that should look like a button —
 *  never nest a <button> inside an <a>). */
export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", className?: string): string {
  const variants = {
    default: "bg-primary text-primary-foreground hover:opacity-90",
    outline: "border border-border bg-transparent hover:bg-muted",
    ghost: "bg-transparent hover:bg-muted",
    subtle: "bg-secondary text-secondary-foreground hover:opacity-90",
    danger: "bg-danger text-danger-foreground hover:opacity-90",
  };
  const sizes = {
    sm: "h-8 px-3 text-sm",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
    icon: "h-10 w-10",
  };
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  className,
  variant = "default",
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-2xl border border-border bg-card text-card-foreground shadow-sm",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Badge({
  className,
  variant = "muted",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "muted" | "success" | "warning" | "danger" | "primary" | "outline";
}) {
  const variants = {
    muted: "bg-muted text-muted-foreground",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-[hsl(var(--warning))]",
    danger: "bg-danger/15 text-danger",
    primary: "bg-primary/15 text-primary",
    outline: "border border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "flex h-11 w-full rounded-xl border border-input bg-background px-3.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Chip({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card hover:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Stars({ n }: { n: number }) {
  return (
    <span className="text-warning" aria-label={`${n} von 3 Sternen`}>
      {"★".repeat(n)}
      <span className="opacity-25">{"★".repeat(Math.max(0, 3 - n))}</span>
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
      {label && <span className="text-sm">{label}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}
