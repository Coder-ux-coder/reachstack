// Canvas pieces: the step cards (with their outputs and "+" buttons) and the connections between them.
import { createContext, useContext, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Plus, X, XCircle } from "lucide-react";
import { NODE_KIND_LABELS, actionDef, nodeLabel, triggerDef, type AutomationNode, type GraphWarnings } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui";
import type { RunStep } from "../api";
import { AppIcon, FlowIcon, useAppLabel } from "../ui";
import type { FlowNode } from "./model";

export interface EditorContext {
  warnings: GraphWarnings;
  /** Step results of the test run shown on the canvas. */
  runSteps: Record<string, RunStep["status"]> | null;
  readOnly: boolean;
  /** Outputs that already lead somewhere ("<node>:<handle>"). */
  usedOutputs: Set<string>;
  addAfter(source: string, handle: string | null): void;
  insertOnEdge(edgeId: string): void;
  deleteEdge(edgeId: string): void;
}

export const EditorCtx = createContext<EditorContext | null>(null);
const useEditor = () => useContext(EditorCtx)!;

export const NODE_WIDTH = 264;

function subtitle(node: Pick<AutomationNode, "type" | "data">, appLabel: (k: string) => string): string | null {
  const d = node.data;
  if (node.type === "trigger") {
    const def = triggerDef(d.key);
    return def ? appLabel(def.app) : "Choose what starts the automation";
  }
  if (node.type === "action") {
    const def = actionDef(d.key);
    return def ? appLabel(def.app) : "Choose an action";
  }
  if (node.type === "delay") return d.amount && d.unit ? `Wait ${d.amount} ${d.amount === 1 ? d.unit.replace(/s$/, "") : d.unit}` : "Set how long to wait";
  if (node.type === "condition") {
    const rules = (d.groups ?? []).reduce((n, g) => n + (g.rules?.length ?? 0), 0);
    return rules ? `${rules} ${rules === 1 ? "rule" : "rules"}` : "Set the rules";
  }
  if (node.type === "paths") return `${d.paths?.length ?? 0} paths run side by side`;
  if (node.type === "merge") return "Continues once the paths arrive";
  return null;
}

const RUN_ICON = {
  success: { icon: CheckCircle2, tone: "text-ok", label: "Ran" },
  error: { icon: XCircle, tone: "text-bad", label: "Failed" },
  waiting: { icon: Clock3, tone: "text-warn", label: "Waiting" },
  running: { icon: CircleDashed, tone: "text-info", label: "Running" },
} as const;

function AddButton({ onClick, label, className, style }: { onClick: () => void; label: string; className?: string; style?: CSSProperties }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={style}
      className={cn("nodrag nopan absolute flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-panel text-muted shadow-card hover:border-brand hover:text-brand", className)}
    >
      <Plus size={12} strokeWidth={2.5} />
    </button>
  );
}

const handleClass = "h-2.5! w-2.5! border-2! border-panel! bg-faint!";

export function StepNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const ctx = useEditor();
  const appLabel = useAppLabel();
  const node: Pick<AutomationNode, "type" | "data"> = { type: type!, data };
  const warnings = ctx.warnings.nodes[id] ?? [];
  const blocking = warnings.filter((w) => w.blocking);
  const def = type === "trigger" ? triggerDef(data.key) : type === "action" ? actionDef(data.key) : null;
  const run = ctx.runSteps?.[id];
  const outputs: Array<{ id: string | null; label?: string; tone?: string; left: string }> =
    type === "condition"
      ? [
          { id: "true", label: "True", tone: "bg-ok!", left: "28%" },
          { id: "false", label: "False", tone: "bg-bad!", left: "72%" },
        ]
      : type === "paths"
        ? (data.paths ?? []).map((p, i, all) => ({ id: p.id, label: p.name, left: `${((i + 1) / (all.length + 1)) * 100}%` }))
        : [{ id: null, left: "50%" }];
  const RunIcon = run ? RUN_ICON[run].icon : null;
  return (
    <div
      style={{ width: NODE_WIDTH }}
      className={cn(
        "relative rounded-xl border bg-panel shadow-card transition-shadow",
        selected ? "border-brand ring-2 ring-[var(--ring)]" : blocking.length ? "border-bad/60" : "border-line hover:border-line-strong",
      )}
    >
      {type !== "trigger" && <Handle type="target" position={Position.Top} className={handleClass} />}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {def ? <AppIcon app={def.app} size={32} /> : <FlowIcon kind={type!} size={32} />}
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-medium uppercase tracking-wide text-faint">{NODE_KIND_LABELS[type!]}</div>
          <div className="truncate text-[13px] font-semibold leading-snug">{nodeLabel(node)}</div>
          <div className="truncate text-xs text-muted">{subtitle(node, appLabel)}</div>
        </div>
        {RunIcon ? (
          <Tooltip content={`Test run: ${RUN_ICON[run!].label}`}>
            <span className={cn("shrink-0", RUN_ICON[run!].tone)}>
              <RunIcon size={17} />
            </span>
          </Tooltip>
        ) : warnings.length ? (
          <Tooltip
            content={
              <ul className="space-y-1">
                {warnings.map((w) => (
                  <li key={w.code + w.message}>{w.message}</li>
                ))}
              </ul>
            }
          >
            <span className={cn("shrink-0", blocking.length ? "text-bad" : "text-warn")} aria-label={`${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`}>
              <AlertTriangle size={16} />
            </span>
          </Tooltip>
        ) : null}
      </div>
      {outputs.map((o) => (
        <Handle key={o.id ?? "out"} type="source" position={Position.Bottom} id={o.id ?? undefined} style={{ left: o.left }} className={cn(handleClass, o.tone)} />
      ))}
      {outputs.some((o) => o.label) && (
        <div className="pointer-events-none absolute inset-x-0 top-full h-0">
          {outputs.map((o) => (
            <span key={o.id ?? "out"} style={{ left: o.left }} className="absolute top-1.5 max-w-[7rem] -translate-x-1/2 truncate rounded bg-bg px-1 text-[10.5px] font-medium text-muted">
              {o.label}
            </span>
          ))}
        </div>
      )}
      {!ctx.readOnly &&
        outputs
          .filter((o) => !ctx.usedOutputs.has(`${id}:${o.id ?? ""}`))
          .map((o) => (
            <AddButton key={o.id ?? "out"} label={o.label ? `Add a step to “${o.label}”` : "Add the next step"} onClick={() => ctx.addAfter(id, o.id)} style={{ left: o.left, top: `calc(100% + ${o.label ? 26 : 14}px)` }} />
          ))}
    </div>
  );
}

export function StepEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, sourceHandleId, markerEnd }: EdgeProps) {
  const ctx = useEditor();
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 14 });
  const stroke = selected ? "var(--brand)" : sourceHandleId === "true" ? "var(--ok)" : sourceHandleId === "false" ? "var(--bad)" : "var(--line-strong)";
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth: selected ? 2.25 : 1.75 }} />
      {!ctx.readOnly && (
        <EdgeLabelRenderer>
          <div style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }} className="nodrag nopan absolute flex items-center gap-1">
            <button
              type="button"
              aria-label="Add a step here"
              title="Add a step here"
              onClick={() => ctx.insertOnEdge(id)}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-panel text-muted opacity-70 shadow-card hover:border-brand hover:text-brand hover:opacity-100"
            >
              <Plus size={12} strokeWidth={2.5} />
            </button>
            {selected && (
              <button
                type="button"
                aria-label="Delete connection"
                title="Delete connection"
                onClick={() => ctx.deleteEdge(id)}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-bad/40 bg-panel text-bad shadow-card hover:bg-bad-soft"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
