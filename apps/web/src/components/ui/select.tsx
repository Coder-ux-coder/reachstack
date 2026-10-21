import * as RS from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Option<V extends string = string> {
  value: V;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

// Radix Select can't hold an empty-string value, so "" round-trips through a sentinel.
const EMPTY = "__empty__";

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  size = "md",
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: V | null | undefined;
  onChange: (v: V) => void;
  options: Option<V>[];
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  // "" is a choice when an option has it; otherwise nothing is chosen yet, and Radix shows the placeholder for "".
  const current = value === "" ? (options.some((o) => o.value === "") ? EMPTY : "") : (value ?? "");
  return (
    <RS.Root value={current} onValueChange={(v) => onChange((v === EMPTY ? "" : v) as V)} disabled={disabled}>
      <RS.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-panel px-3 text-left",
          "focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60 data-[placeholder]:text-faint",
          size === "sm" ? "h-8 text-[13px]" : "h-9 text-sm",
          className,
        )}
      >
        <span className="truncate">
          <RS.Value placeholder={placeholder} />
        </span>
        <RS.Icon>
          <ChevronDown size={14} className="text-faint" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content position="popper" sideOffset={4} className="animate-in z-50 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-panel shadow-lg">
          <RS.Viewport className="scroll-thin p-1">
            {options.map((o) => (
              <RS.Item
                key={o.value || EMPTY}
                value={o.value === "" ? EMPTY : o.value}
                disabled={o.disabled}
                className="relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-3 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-panel-2"
              >
                <RS.ItemIndicator className="absolute left-2">
                  <Check size={14} className="text-brand" />
                </RS.ItemIndicator>
                <div>
                  <RS.ItemText>{o.label}</RS.ItemText>
                  {o.hint && <div className="text-xs text-muted">{o.hint}</div>}
                </div>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

/** Native <select> for dense forms and long lists (timezones). */
export function NativeSelect({
  value,
  onChange,
  options,
  className,
  id,
  disabled,
  size = "md",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string } | { group: string; options: Array<{ value: string; label: string }> }>;
  className?: string;
  id?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-lg border border-line-strong bg-panel px-2.5 focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--ring)]",
        size === "sm" ? "h-8 text-[13px]" : "h-9 text-sm",
        className,
      )}
    >
      {options.map((o) =>
        "group" in o ? (
          <optgroup key={o.group} label={o.group}>
            {o.options.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ),
      )}
    </select>
  );
}
