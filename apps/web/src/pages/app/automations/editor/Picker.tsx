// Choosing what a step is: a trigger event, an action, or a flow step (condition, delay, paths, join).
import { useMemo, useState } from "react";
import { AUTOMATION_ACTIONS, AUTOMATION_APPS, AUTOMATION_TRIGGERS, type AppKey, type NodeKind } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { Dialog, SearchInput } from "@/components/ui";
import { AppIcon, FlowIcon, useAppLabel } from "../ui";

export interface PickedStep {
  kind: NodeKind;
  key: string | null;
}

interface Item {
  kind: NodeKind;
  key: string | null;
  app: AppKey | null;
  label: string;
  description: string;
}

const FLOW: Item[] = [
  { kind: "condition", key: null, app: null, label: "Condition", description: "Continue on the true or false branch, depending on the data." },
  { kind: "delay", key: null, app: null, label: "Delay", description: "Wait minutes, hours or days before the next step." },
  { kind: "paths", key: null, app: null, label: "Paths", description: "Run several branches side by side." },
  { kind: "merge", key: null, app: null, label: "Join paths", description: "Wait for branches to arrive, then continue once." },
];

function sections(mode: "trigger" | "action", includeFlow: boolean, appLabel: (k: string) => string) {
  if (mode === "trigger") {
    return AUTOMATION_APPS.map((app) => ({
      title: app.key === "core" ? appLabel("core") : app.label,
      items: AUTOMATION_TRIGGERS.filter((t) => t.app === app.key).map((t): Item => ({ kind: "trigger", key: t.key, app: t.app, label: t.label, description: t.description })),
    })).filter((s) => s.items.length);
  }
  const of = (group: "apps" | "tools") =>
    AUTOMATION_APPS.filter((a) => a.group === group).flatMap((app) => AUTOMATION_ACTIONS.filter((a) => a.app === app.key).map((a): Item => ({ kind: "action", key: a.key, app: a.app, label: a.label, description: a.description })));
  return [
    { title: "Apps", items: of("apps") },
    { title: "Built-in tools", items: of("tools") },
    ...(includeFlow ? [{ title: "Flow", items: FLOW }] : []),
  ];
}

export function EventList({ mode, includeFlow = false, onPick, selectedKey, autoFocus }: { mode: "trigger" | "action"; includeFlow?: boolean; onPick: (p: PickedStep) => void; selectedKey?: string | null; autoFocus?: boolean }) {
  const appLabel = useAppLabel();
  const [search, setSearch] = useState("");
  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sections(mode, includeFlow, appLabel)
      .map((s) => ({ ...s, items: s.items.filter((i) => !needle || `${i.label} ${i.description} ${i.app ? appLabel(i.app) : ""}`.toLowerCase().includes(needle)) }))
      .filter((s) => s.items.length);
  }, [mode, includeFlow, search, appLabel]);
  return (
    <div className="space-y-3">
      <SearchInput value={search} onChange={setSearch} placeholder={mode === "trigger" ? "Search triggers" : "Search steps"} className="w-full" autoFocus={autoFocus} />
      {list.length === 0 && <p className="py-6 text-center text-[13px] text-muted">Nothing matches “{search}”.</p>}
      {list.map((s) => (
        <div key={s.title}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{s.title}</h4>
          <ul className="space-y-0.5">
            {s.items.map((i) => (
              <li key={`${i.kind}:${i.key}`}>
                <button
                  type="button"
                  onClick={() => onPick({ kind: i.kind, key: i.key })}
                  className={cn("flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-panel-2", selectedKey && selectedKey === i.key && "bg-brand-soft hover:bg-brand-soft")}
                >
                  {i.app ? <AppIcon app={i.app} size={28} /> : <FlowIcon kind={i.kind} size={28} />}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{i.label}</span>
                    <span className="block text-xs text-muted">{i.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function PickerDialog({ open, onOpenChange, mode, onPick }: { open: boolean; onOpenChange: (v: boolean) => void; mode: "trigger" | "action"; onPick: (p: PickedStep) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "trigger" ? "Add a trigger" : "Add a step"}
      description={mode === "trigger" ? "Choose what starts this automation." : "Choose an action, or a step that shapes the flow."}
    >
      {open && (
        <EventList
          mode={mode}
          includeFlow={mode === "action"}
          autoFocus
          onPick={(p) => {
            onPick(p);
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}
