import * as RSwitch from "@radix-ui/react-switch";
import * as RCheckbox from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  size = "md",
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        // The ::after box makes the tap target at least 24px tall without changing the look (it's wide enough).
        "relative shrink-0 rounded-full bg-line-strong transition-colors after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] data-[state=checked]:bg-brand disabled:opacity-50",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
      )}
    >
      <RSwitch.Thumb
        className={cn(
          "block rounded-full bg-white shadow transition-transform",
          size === "sm" ? "h-3 w-3 translate-x-0.5 data-[state=checked]:translate-x-3.5" : "h-4 w-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]",
        )}
      />
    </RSwitch.Root>
  );
}

/** A labelled switch row used throughout settings screens. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        {checked && children && <div className="mt-3">{children}</div>}
      </div>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean | "indeterminate";
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const autoId = useId();
  const cid = id ?? autoId;
  const box = (
    <RCheckbox.Root
      id={cid}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onCheckedChange={(v) => onChange(v === true)}
      onClick={(e) => e.stopPropagation()}
      className="hit-24 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line-strong bg-panel data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand disabled:opacity-50"
    >
      <RCheckbox.Indicator className="text-on-brand">{checked === "indeterminate" ? <Minus size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {box}
      <label htmlFor={cid} className="cursor-pointer text-sm">
        {label}
      </label>
    </div>
  );
}

/** Segmented control for 2–5 mutually exclusive options. */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  value: V;
  onChange: (v: V) => void;
  options: Array<{ value: V; label: ReactNode }>;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex rounded-lg bg-panel-2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]",
            value === o.value ? "bg-panel text-text shadow-card" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
