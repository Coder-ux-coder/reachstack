import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";

const fieldBase =
  "w-full rounded-lg border border-line-strong bg-panel text-text placeholder:text-faint transition-colors " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-bad";

/** A field with no label of its own (no id for a <label>, no aria-label) is named by its placeholder. */
const ownName = (p: { id?: string; placeholder?: string; "aria-label"?: string; "aria-labelledby"?: string }) =>
  p["aria-label"] ?? (p.id || p["aria-labelledby"] ? undefined : p.placeholder);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  inputSize?: "sm" | "md";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, leading, trailing, inputSize = "md", ...rest }, ref) {
  const h = inputSize === "sm" ? "h-8 text-[13px]" : "h-9 text-sm";
  if (!leading && !trailing) return <input ref={ref} aria-invalid={invalid || undefined} className={cn(fieldBase, h, "px-3", className)} {...rest} aria-label={ownName(rest)} />;
  return (
    <div className={cn("relative flex items-center", className)}>
      {leading && <span className="pointer-events-none absolute left-2.5 flex text-faint">{leading}</span>}
      <input ref={ref} aria-invalid={invalid || undefined} className={cn(fieldBase, h, leading ? "pl-8" : "pl-3", trailing ? "pr-9" : "pr-3")} {...rest} aria-label={ownName(rest)} />
      {trailing && <span className="absolute right-2 flex items-center text-faint">{trailing}</span>}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, rows = 4, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn(fieldBase, "px-3 py-2 text-sm leading-relaxed", className)} {...rest} aria-label={ownName(rest)} />;
});

export function Label({ htmlFor, children, className, optional }: { htmlFor?: string; children: ReactNode; className?: string; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1.5 block text-[13px] font-medium text-text", className)}>
      {children}
      {optional && <span className="ml-1 font-normal text-faint">(optional)</span>}
    </label>
  );
}

/** Label + control + hint/error. Pass a render function to receive the generated id. */
export function Field({
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  className?: string;
  children: ReactNode | ((id: string) => ReactNode);
}) {
  const id = useId();
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={id} optional={optional}>
          {label}
        </Label>
      )}
      {typeof children === "function" ? children(id) : children}
      {error ? <p className="mt-1.5 text-xs text-bad">{error}</p> : hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <Input
      className={cn("w-64", className)}
      inputSize="sm"
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      leading={<Search size={14} />}
      trailing={
        value ? (
          <button type="button" aria-label="Clear search" className="rounded p-0.5 hover:bg-panel-2" onClick={() => onChange("")}>
            <X size={13} />
          </button>
        ) : undefined
      }
    />
  );
}

/** Comma/enter separated chips (emails, domains, keywords). */
export function TagInput({
  value,
  onChange,
  placeholder,
  validate,
  className,
  id,
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  validate?: (v: string) => boolean;
  className?: string;
  id?: string;
  disabled?: boolean;
}) {
  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.includes(s) && (!validate || validate(s)));
    if (parts.length) onChange([...value, ...parts]);
  };
  return (
    <div className={cn(fieldBase, "flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1.5", disabled && "opacity-60", className)}>
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-2 py-0.5 text-xs">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} className="hit-24 text-faint hover:text-text" onClick={() => onChange(value.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        aria-label={id ? undefined : placeholder}
        disabled={disabled}
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        placeholder={value.length ? "" : placeholder}
        onKeyDown={(e) => {
          const t = e.currentTarget;
          if ((e.key === "Enter" || e.key === ",") && t.value.trim()) {
            e.preventDefault();
            add(t.value);
            t.value = "";
          } else if (e.key === "Backspace" && !t.value && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim()) {
            add(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[,\n;]/.test(text)) {
            e.preventDefault();
            add(text);
          }
        }}
      />
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  className,
  suffix,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  suffix?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="number"
      inputMode="numeric"
      className={cn("w-32", className)}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      trailing={suffix ? <span className="pointer-events-none text-xs">{suffix}</span> : undefined}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : Number(v));
      }}
    />
  );
}
