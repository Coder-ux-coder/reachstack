import * as RT from "@radix-ui/react-tabs";
import { useEffect, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { revealSideways, useScrollFade } from "./scroll-x";

const tabClass = (active: boolean) =>
  cn(
    "relative -mb-px inline-flex h-10 min-w-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-1 text-[13px] font-medium transition-colors",
    active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
  );

/** Route-driven tabs (each tab is a URL). */
export function LinkTabs({ tabs, className, end = true }: { tabs: Array<{ to: string; label: ReactNode; badge?: ReactNode; hidden?: boolean }>; className?: string; end?: boolean }) {
  const [ref, fade] = useScrollFade<HTMLElement>();
  const { pathname } = useLocation();
  useEffect(() => revealSideways(ref.current, ref.current?.querySelector("[aria-current=page]")), [pathname, ref]);
  return (
    <nav ref={ref} style={fade} className={cn("scroll-none flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line", className)}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <NavLink key={t.to} to={t.to} end={end} className={({ isActive }) => tabClass(isActive)}>
            {t.label}
            {t.badge}
          </NavLink>
        ))}
    </nav>
  );
}

/** In-page tabs. */
export function Tabs<V extends string>({
  value,
  onChange,
  tabs,
  className,
  children,
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: Array<{ value: V; label: ReactNode; badge?: ReactNode }>;
  className?: string;
  children?: ReactNode;
}) {
  const [ref, fade] = useScrollFade<HTMLDivElement>();
  useEffect(() => revealSideways(ref.current, ref.current?.querySelector("[data-state=active]")), [value, ref]);
  return (
    <RT.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <RT.List ref={ref} style={fade} className={cn("scroll-none flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line", className)}>
        {tabs.map((t) => (
          <RT.Trigger key={t.value} value={t.value} className={tabClass(value === t.value)}>
            {t.label}
            {t.badge}
          </RT.Trigger>
        ))}
      </RT.List>
      {children}
    </RT.Root>
  );
}

export const TabPanel = ({ value, children, className }: { value: string; children: ReactNode; className?: string }) => (
  <RT.Content value={value} className={cn("focus:outline-none", className)}>
    {children}
  </RT.Content>
);

export const CountPill = ({ n }: { n: number | undefined | null }) =>
  n ? <span className="rounded-full bg-panel-2 px-1.5 text-[11px] font-semibold tabular-nums text-muted">{n > 999 ? "999+" : n}</span> : null;
