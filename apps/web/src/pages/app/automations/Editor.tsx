// The automation editor: the flow canvas, the selected step's panel, saving, turning on and off, and test runs.
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Background,
  BackgroundVariant,
  Panel as FlowPanel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { AlertTriangle, ArrowLeft, Copy, History, LayoutGrid, Maximize, Minus, MoreHorizontal, Pencil, Play, Plus, Redo2, Save, Sparkles, Trash2, Undo2, X, Zap } from "lucide-react";
import { NODE_GAP, actionDef, automationWarnings, graphSignature, layoutGraph, nodeLabel, triggerDef, type AutomationGraph, type NodeData } from "@reachstack/shared";
import { errorMessage, get, patch, post, del } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import { Button, ButtonLink, Dialog, EmptyState, Field, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Page, Popover, PopoverClose, Spinner, Switch, Textarea, Tooltip, useConfirm } from "@/components/ui";
import { BASE, keys, useOptions, type Automation, type RunDetail, type RunSummary } from "./api";
import { RunDialog } from "./RunDialog";
import { RunStatusBadge } from "./ui";
import { AskAiDialog, type AiDraft } from "./editor/AskAi";
import { EditorCtx, NODE_WIDTH, StepEdge, StepNode, type EditorContext } from "./editor/canvas";
import { addAfter, insertOnEdge, makeNode, newId, removeNodes, removeStep, toFlow, toGraph, useHistory, type FlowData, type FlowEdge, type FlowNode } from "./editor/model";
import { StepPanel } from "./editor/Panel";
import { PickerDialog, type PickedStep } from "./editor/Picker";

const nodeTypes = { trigger: StepNode, action: StepNode, condition: StepNode, delay: StepNode, paths: StepNode, merge: StepNode };
const edgeTypes = { step: StepEdge };

/** The graph as the editor would save it (same key order and defaults), for comparing with what's saved. */
function normalize(graph: AutomationGraph): AutomationGraph {
  const f = toFlow(graph);
  return toGraph(f.nodes, f.edges);
}

/** The graph to open: one made without positions (several steps on the same spot) is laid out first. */
function openingGraph(graph: AutomationGraph): AutomationGraph {
  const spots = new Set(graph.nodes.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`));
  return normalize(spots.size < graph.nodes.length ? layoutGraph(graph) : graph);
}

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Key presses meant for a field or an open dialog, not the canvas. */
function busyTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (document.querySelector("[role=dialog]")) return true;
  if (!el?.closest) return false;
  return !!el.closest("input, textarea, select, [contenteditable=true], [role=listbox], [role=menu]");
}

type PickerState = { mode: "trigger" } | { mode: "action"; after: { source: string; handle: string | null } } | { mode: "action"; edge: string } | null;

function RunBar({ run, onOpen, onClose }: { run: RunDetail | undefined; onOpen: () => void; onClose: () => void }) {
  const text = !run
    ? "Starting the test run…"
    : run.status === "queued"
      ? "Starting the test run…"
      : run.status === "running"
        ? `Running${run.current_step ? ` “${run.current_step.name}”` : ""}…`
        : run.status === "success"
          ? "Test run finished."
          : run.status === "error"
            ? `Failed at “${run.current_step?.name ?? "a step"}”.`
            : run.status === "waiting"
              ? "Waiting on a delay."
              : "Test run cancelled.";
  return (
    <div className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-xl border border-line bg-panel py-1.5 pl-3 pr-1.5 shadow-lg">
      {run ? <RunStatusBadge status={run.status} /> : <Spinner size={14} />}
      <span className="min-w-0 truncate text-[13px]">{text}</span>
      <Button size="xs" onClick={onOpen} disabled={!run}>
        View details
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Hide test run" onClick={onClose}>
        <X size={14} />
      </Button>
    </div>
  );
}

function CanvasButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label} side="top">
      <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className="flex h-8 w-8 items-center justify-center text-muted hover:bg-panel-2 hover:text-text disabled:pointer-events-none disabled:opacity-40">
        {children}
      </button>
    </Tooltip>
  );
}

function DescriptionDialog({ open, onOpenChange, wf, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; wf: Automation; onSaved: (w: Automation) => void }) {
  const [text, setText] = useState(wf.description ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setText(wf.description ?? "");
  }, [open, wf.description]);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await patch<Automation>(`${BASE}/${wf.id}`, { description: text.trim() || null }));
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Description"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <Field label="What it's for, so teammates know">{(id) => <Textarea id={id} autoFocus rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
    </Dialog>
  );
}

function EditorView({ initial }: { initial: Automation }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const can = useCan();
  const zone = useWorkspaceZone();
  const readOnly = !can.write;
  const options = useOptions();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const { push: pushHistory, undo: undoHistory, redo: redoHistory, canUndo, canRedo } = useHistory();
  const dark = useDarkMode();

  const [wf, setWfState] = useState(initial);
  const [opening] = useState(() => openingGraph(initial.graph));
  // Laying out a graph on open doesn't count as a change: positions are saved with the next real one.
  const [saved, setSaved] = useState(() => ({ name: initial.name, graph: opening }));
  const [name, setName] = useState(initial.name);
  const [nodes, setNodes] = useState<FlowNode[]>(() => toFlow(opening).nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(() => toFlow(opening).edges);
  const [picker, setPicker] = useState<PickerState>(null);
  const [saving, setSaving] = useState(false);
  const [testRun, setTestRun] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [askAi, setAskAi] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  usePageTitle(name.trim() || "Automation");

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const savedJson = useMemo(() => JSON.stringify(saved.graph), [saved.graph]);
  const warnings = useMemo(() => automationWarnings(graph), [graph]);
  const dirty = !leaveTo && ((name.trim() || "Untitled automation") !== saved.name || graphJson !== savedJson);
  useUnsavedChanges(dirty && !readOnly, "Your changes to this automation haven't been saved yet.");

  // Latest values for callbacks that outlive a render (keyboard shortcuts, async saves).
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const setWf = useCallback(
    (w: Automation) => {
      setWfState(w);
      qc.setQueryData(keys.one(w.id), w);
      void qc.invalidateQueries({ queryKey: keys.list, exact: true });
    },
    [qc],
  );

  useEffect(() => {
    if (leaveTo) navigate(leaveTo);
  }, [leaveTo, navigate]);

  // ---------- Graph changes ----------

  /** Shows a graph on the canvas, keeping what React Flow measured; `select` picks the one selected step. */
  const applyGraph = useCallback((g: AutomationGraph, select?: string | null) => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return g.nodes.map((n): FlowNode => {
        const o = old.get(n.id);
        return { ...o, id: n.id, type: n.type, position: { ...n.position }, data: { ...n.data } as FlowData, selected: select !== undefined ? n.id === select : (o?.selected ?? false) };
      });
    });
    setEdges((prev) => {
      const old = new Map(prev.map((e) => [e.id, e]));
      return g.edges.map((e): FlowEdge => ({ ...old.get(e.id), id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, type: "step", selected: select !== undefined ? false : (old.get(e.id)?.selected ?? false) }));
    });
  }, []);

  const commit = useCallback(
    (next: AutomationGraph, opts: { key?: string; select?: string | null } = {}) => {
      pushHistory(graphRef.current, opts.key);
      applyGraph(next, opts.select);
    },
    [applyGraph, pushHistory],
  );

  const undo = useCallback(() => {
    const prev = undoHistory(graphRef.current);
    if (prev) applyGraph(prev);
  }, [applyGraph, undoHistory]);
  const redo = useCallback(() => {
    const next = redoHistory(graphRef.current);
    if (next) applyGraph(next);
  }, [applyGraph, redoHistory]);

  /** Scrolls the canvas to a step, measured once the panel has opened beside it. */
  const canvasRef = useRef<HTMLDivElement>(null);
  const focusAt = useCallback(
    (p: { x: number; y: number }) => {
      setTimeout(() => {
        const box = canvasRef.current?.getBoundingClientRect();
        if (!box) return;
        const zoom = Math.max(flow.getZoom(), 0.8);
        void flow.setViewport({ x: box.width / 2 - (p.x + NODE_WIDTH / 2) * zoom, y: box.height / 2 - (p.y + 40) * zoom, zoom }, { duration: 300 });
      }, 50);
    },
    [flow],
  );

  const select = useCallback((id: string | null) => {
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
    setEdges((es) => (es.some((e) => e.selected) ? es.map((e) => (e.selected ? { ...e, selected: false } : e)) : es));
  }, []);

  const updateData = useCallback(
    (nodeId: string, patchData: Partial<NodeData>, key?: string) => {
      const g = graphRef.current;
      commit({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patchData } } : n)) }, { key });
    },
    [commit],
  );

  const deleteSelection = useCallback(() => {
    const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id);
    const edgeIds = new Set(edgesRef.current.filter((e) => e.selected).map((e) => e.id));
    if (!ids.length && !edgeIds.size) return;
    const g = graphRef.current;
    const next = ids.length === 1 ? removeStep(g, ids[0]!) : removeNodes(g, ids);
    commit({ ...next, edges: next.edges.filter((e) => !edgeIds.has(e.id)) }, { select: null });
  }, [commit]);

  const pickStep = (p: PickedStep) => {
    const g = graphRef.current;
    const state = picker;
    if (!state) return;
    const node = makeNode(p.kind, p.key, { x: 0, y: 0 }, zone);
    if (state.mode === "trigger") {
      // Steps already on the canvas without a trigger: put it above the first one and connect them.
      const roots = g.nodes.filter((n) => !g.edges.some((e) => e.target === n.id));
      const next: AutomationGraph = { nodes: [...g.nodes, node], edges: [...g.edges] };
      if (roots.length === 1) {
        node.position = { x: roots[0]!.position.x, y: roots[0]!.position.y - NODE_GAP.y };
        next.edges.push({ id: newId("e"), source: node.id, target: roots[0]!.id, sourceHandle: null });
      }
      commit(next, { select: node.id });
    } else if ("after" in state) {
      commit(addAfter(g, state.after.source, state.after.handle, node), { select: node.id });
    } else {
      commit(insertOnEdge(g, state.edge, node), { select: node.id });
    }
    focusAt(node.position);
  };

  const tidy = () => {
    commit(layoutGraph(graphRef.current));
    requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }));
  };

  // ---------- React Flow events ----------

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es)), []);
  const dragStart = useRef<AutomationGraph | null>(null);
  const onConnect = useCallback(
    (c: Connection) => {
      const g = graphRef.current;
      const handle = c.sourceHandle ?? null;
      if (readOnly || c.source === c.target || g.edges.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === handle)) return;
      commit({ ...g, edges: [...g.edges, { id: newId("e"), source: c.source, target: c.target, sourceHandle: handle }] });
    },
    [commit, readOnly],
  );
  const isValidConnection: IsValidConnection<FlowEdge> = useCallback((c) => c.source !== c.target, []);

  // ---------- Saving, status, test runs ----------

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly) return false;
    const g = graphRef.current;
    const nextName = name.trim() || "Untitled automation";
    if (JSON.stringify(g) === savedJson && nextName === saved.name) return true;
    setSaving(true);
    try {
      if (wf.status === "active" && graphSignature(g) !== graphSignature(saved.graph)) {
        const impact = await get<{ waiting: number; running: number }>(`${BASE}/${wf.id}/save-impact`);
        if (impact.waiting > 0) {
          const ok = await confirm({
            title: "Save and stop waiting runs?",
            description: `${impact.waiting === 1 ? "1 run is" : `${impact.waiting} runs are`} waiting on a delay. Because what the automation does has changed, ${impact.waiting === 1 ? "it stops" : "they stop"} instead of continuing. New runs use the new version.`,
            confirmLabel: "Save",
          });
          if (!ok) return false;
        }
      }
      const res = await patch<Automation>(`${BASE}/${wf.id}`, { name: nextName, graph: g });
      setSaved({ name: res.name, graph: normalize(res.graph) });
      setName((n) => (n.trim() ? n : res.name));
      setWf(res);
      if (res.turned_off) toast.warning("Saved, and turned off: fix the problems marked on the steps to turn it back on.");
      else toast.success("Saved");
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [confirm, name, readOnly, saved, savedJson, setWf, wf.id, wf.status]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const setStatus = async (on: boolean) => {
    try {
      setWf(await post<Automation>(`${BASE}/${wf.id}/status`, { status: on ? "active" : "paused" }));
      toast.success(on ? "The automation is on" : "The automation is off");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const runQ = useQuery({
    queryKey: keys.run(testRun ?? ""),
    queryFn: () => get<RunDetail>(`${BASE}/executions/${testRun}`),
    enabled: !!testRun,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return !s || s === "queued" || s === "running" ? 1_000 : false;
    },
  });
  const runSteps = useMemo(() => (testRun && runQ.data ? Object.fromEntries(runQ.data.steps.map((s) => [s.id, s.status])) : null), [testRun, runQ.data]);

  const runTest = async () => {
    const trigger = graphRef.current.nodes.find((n) => n.type === "trigger");
    if (!trigger || !triggerDef(trigger.data.key)) {
      toast.error("Choose a trigger before running a test.");
      return;
    }
    if (!(await saveRef.current())) return;
    const effects = graphRef.current.nodes.filter((n) => n.type === "action" && actionDef(n.data.key)?.sideEffects).map((n) => `“${nodeLabel(n)}”`);
    const ok = await confirm({
      title: "Run a test?",
      description: effects.length
        ? `The automation runs once with the trigger's test data, and its steps really happen: ${effects.join(", ")}. Delays are waited out as usual.`
        : "The automation runs once with the trigger's test data.",
      confirmLabel: "Run test",
    });
    if (!ok) return;
    try {
      const run = await post<RunSummary>(`${BASE}/${wf.id}/run-test`);
      setTestRun(run.id);
      void qc.invalidateQueries({ queryKey: keys.runs });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const duplicate = async () => {
    if (!(await saveRef.current())) return;
    try {
      const copy = await post<Automation>(`${BASE}/${wf.id}/duplicate`);
      void qc.invalidateQueries({ queryKey: keys.list, exact: true });
      toast.success("Automation duplicated", { action: { label: "Open", onClick: () => navigate(`/app/automations/${copy.id}`) } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: `Delete “${wf.name}”?`, description: "The automation and its run history are deleted. Runs that are waiting stop. This can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await del(`${BASE}/${wf.id}`);
      void qc.invalidateQueries({ queryKey: keys.list, exact: true });
      toast.success("Automation deleted");
      setLeaveTo("/app/automations");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const applyDraft = (d: AiDraft) => {
    commit(d.graph, { select: null });
    if (d.name && (!name.trim() || name.trim() === "Untitled automation")) setName(d.name);
    requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }));
    toast.success("Drafted. Check each step, then test it.", { description: d.explanation, duration: 12_000, action: { label: "Undo", onClick: () => undo() } });
  };

  // ---------- Keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") {
        e.preventDefault();
        void saveRef.current();
        return;
      }
      if (readOnly || busyTarget(e.target)) return;
      if (mod && k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelection, readOnly, redo, select, undo]);

  // ---------- Render ----------

  const usedOutputs = useMemo(() => new Set(graph.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}`)), [graph.edges]);
  const ctx: EditorContext = useMemo(
    () => ({
      warnings,
      runSteps,
      readOnly,
      usedOutputs,
      addAfter: (source, handle) => setPicker({ mode: "action", after: { source, handle } }),
      insertOnEdge: (edge) => setPicker({ mode: "action", edge }),
      deleteEdge: (edgeId) => {
        const g = graphRef.current;
        commit({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) });
      },
    }),
    [commit, readOnly, runSteps, usedOutputs, warnings],
  );

  const selected = nodes.filter((n) => n.selected);
  const panelNode = selected.length === 1 ? graph.nodes.find((n) => n.id === selected[0]!.id) : undefined;
  const hasTrigger = graph.nodes.some((n) => n.type === "trigger");
  const problems = [
    ...warnings.graph.map((w) => ({ node: null as string | null, w })),
    ...graph.nodes.flatMap((n) => (warnings.nodes[n.id] ?? []).map((w) => ({ node: n.id as string | null, w }))),
  ];
  const blocking = warnings.blocking;
  const active = wf.status === "active";
  const statusBlock = readOnly ? "You can't change automations in this workspace." : !active && dirty ? "Save your changes first." : !active && blocking ? `Fix ${blocking === 1 ? "the problem" : `the ${blocking} problems`} first.` : null;

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 sm:px-4">
          <Link to="/app/automations" aria-label="Back to automations" title="Automations" className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text">
            <ArrowLeft size={16} />
          </Link>
          <input
            aria-label="Automation name"
            value={name}
            maxLength={120}
            disabled={readOnly}
            placeholder="Untitled automation"
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold outline-none hover:border-line focus:border-brand focus:ring-2 focus:ring-[var(--ring)] disabled:hover:border-transparent sm:max-w-sm"
          />
          <Tooltip content={statusBlock ?? (active ? "Turn off" : "Turn on")}>
            <span className="flex items-center gap-2">
              <Switch size="sm" checked={active} disabled={!!statusBlock && !(active && !readOnly)} onChange={setStatus} aria-label="Automation on or off" />
              <span className={cn("text-xs font-medium", active ? "text-ok" : "text-muted")}>{active ? "On" : wf.status === "draft" ? "Draft" : "Off"}</span>
            </span>
          </Tooltip>
          {problems.length > 0 && (
            <Popover
              align="start"
              className="w-[min(24rem,calc(100vw-2rem))] p-2"
              trigger={
                <button type="button" className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", blocking ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}>
                  <AlertTriangle size={12} />
                  {blocking ? `${blocking} ${blocking === 1 ? "problem" : "problems"}` : `${problems.length} ${problems.length === 1 ? "tip" : "tips"}`}
                </button>
              }
            >
              <ul className="scroll-thin max-h-80 space-y-0.5 overflow-y-auto">
                {problems.map((p, i) => {
                  const n = p.node ? graph.nodes.find((x) => x.id === p.node) : null;
                  return (
                    <li key={i}>
                      <PopoverClose asChild>
                        <button
                          type="button"
                          onClick={() => {
                            if (!n) return;
                            select(n.id);
                            focusAt(n.position);
                          }}
                          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2"
                        >
                          <AlertTriangle size={13} className={cn("mt-0.5 shrink-0", p.w.blocking ? "text-bad" : "text-warn")} />
                          <span className="min-w-0 text-[13px]">
                            {n && <span className="font-medium">{nodeLabel(n)}: </span>}
                            <span className="text-muted">{p.w.message}</span>
                          </span>
                        </button>
                      </PopoverClose>
                    </li>
                  );
                })}
              </ul>
            </Popover>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {!readOnly && (
              <Button variant="ghost" size="sm" icon={<Sparkles size={14} />} aria-label="Ask AI" title="Ask AI" onClick={() => setAskAi(true)}>
                <span className="hidden xl:inline">Ask AI</span>
              </Button>
            )}
            <ButtonLink variant="ghost" size="sm" to={`/app/automations/history?workflow_id=${wf.id}`} icon={<History size={14} />} aria-label="History" title="Run history">
              <span className="hidden xl:inline">History</span>
            </ButtonLink>
            {!readOnly && (
              <>
                <Button size="sm" icon={<Play size={14} />} aria-label="Run test" title="Run a test" onClick={runTest} disabled={!hasTrigger || saving}>
                  <span className="hidden sm:inline">Run test</span>
                </Button>
                <Button size="sm" variant="primary" icon={<Save size={14} />} onClick={() => void save()} loading={saving} disabled={!dirty}>
                  {dirty ? "Save" : "Saved"}
                </Button>
              </>
            )}
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal size={16} />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Pencil size={14} />} disabled={readOnly} onSelect={() => setDescribing(true)}>
                  {wf.description ? "Edit description" : "Add a description"}
                </MenuItem>
                <MenuItem icon={<LayoutGrid size={14} />} disabled={readOnly || !graph.nodes.length} onSelect={tidy}>
                  Tidy up the steps
                </MenuItem>
                <MenuItem icon={<Copy size={14} />} disabled={readOnly} onSelect={duplicate}>
                  Duplicate
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} danger disabled={readOnly} onSelect={remove}>
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          <div ref={canvasRef} className="relative min-w-0 flex-1">
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeDragStart={() => (dragStart.current = graphRef.current)}
              onNodeDragStop={() => {
                const before = dragStart.current;
                dragStart.current = null;
                if (before && JSON.stringify(before.nodes.map((n) => n.position)) !== JSON.stringify(graphRef.current.nodes.map((n) => n.position))) pushHistory(before);
              }}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={null}
              colorMode={dark ? "dark" : "light"}
              // Fit what's loaded; an empty canvas stays put, so the first step added isn't fitted under the panel.
              fitView={initial.graph.nodes.length > 0}
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.5}
              connectionRadius={30}
              style={{ "--xy-background-color": "var(--bg)", "--xy-edge-stroke": "var(--line-strong)", "--xy-connectionline-stroke": "var(--brand)" } as CSSProperties}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--line-strong)" />
              <FlowPanel position="bottom-left" className="flex overflow-hidden rounded-lg border border-line bg-panel shadow-card">
                {!readOnly && (
                  <>
                    <CanvasButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
                      <Undo2 size={15} />
                    </CanvasButton>
                    <CanvasButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
                      <Redo2 size={15} />
                    </CanvasButton>
                    <span className="w-px bg-line" />
                  </>
                )}
                <CanvasButton label="Zoom out" onClick={() => void flow.zoomOut({ duration: 150 })}>
                  <Minus size={15} />
                </CanvasButton>
                <CanvasButton label="Zoom in" onClick={() => void flow.zoomIn({ duration: 150 })}>
                  <Plus size={15} />
                </CanvasButton>
                <CanvasButton label="Fit to screen" onClick={() => void flow.fitView({ padding: 0.25, maxZoom: 1, duration: 300 })}>
                  <Maximize size={14} />
                </CanvasButton>
                {!readOnly && (
                  <CanvasButton label="Tidy up the steps" onClick={tidy} disabled={!graph.nodes.length}>
                    <LayoutGrid size={14} />
                  </CanvasButton>
                )}
              </FlowPanel>
              {!hasTrigger && graph.nodes.length > 0 && !readOnly && (
                <FlowPanel position="top-center">
                  <Button size="sm" variant="primary" icon={<Zap size={14} />} onClick={() => setPicker({ mode: "trigger" })}>
                    Add a trigger
                  </Button>
                </FlowPanel>
              )}
            </ReactFlow>
            {graph.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
                <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-line bg-panel p-6 text-center shadow-card">
                  <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand-text">
                    <Zap size={20} />
                  </div>
                  <h2 className="text-[15px] font-semibold">Start with a trigger</h2>
                  <p className="mt-1 text-[13px] text-muted">Choose what starts the automation: a reply, a click, a schedule, a request from another app…</p>
                  {!readOnly && (
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setPicker({ mode: "trigger" })}>
                        Add a trigger
                      </Button>
                      <Button icon={<Sparkles size={15} />} onClick={() => setAskAi(true)}>
                        Ask AI
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {testRun && <RunBar run={runQ.data} onOpen={() => setRunOpen(true)} onClose={() => setTestRun(null)} />}
          </div>
          {panelNode && (
            <StepPanel
              key={panelNode.id}
              wf={wf}
              graph={graph}
              node={panelNode}
              warnings={warnings.nodes[panelNode.id] ?? []}
              options={options.data}
              readOnly={readOnly}
              onData={(p, key) => updateData(panelNode.id, p, key)}
              onGraph={(next) => commit(next)}
              onDelete={() => commit(removeStep(graphRef.current, panelNode.id), { select: null })}
              onClose={() => select(null)}
              onSave={save}
              onWorkflow={setWf}
            />
          )}
        </div>
      </div>
      <PickerDialog open={!!picker} onOpenChange={(v) => !v && setPicker(null)} mode={picker?.mode ?? "action"} onPick={pickStep} />
      <AskAiDialog open={askAi} onOpenChange={setAskAi} graph={graph} available={!!options.data?.ai} onDraft={applyDraft} />
      <DescriptionDialog open={describing} onOpenChange={setDescribing} wf={wf} onSaved={setWf} />
      <RunDialog runId={testRun} open={runOpen && !!testRun} onOpenChange={setRunOpen} />
    </EditorCtx.Provider>
  );
}

export default function AutomationEditor() {
  const { workflow_id: id = "" } = useParams();
  const q = useQuery({ queryKey: keys.one(id), queryFn: () => get<Automation>(`${BASE}/${id}`) });
  if (q.error) {
    return (
      <Page>
        <EmptyState title="Automation not found" description={errorMessage(q.error)} action={<ButtonLink to="/app/automations">Back to automations</ButtonLink>} />
      </Page>
    );
  }
  // The editor starts from what's loaded, so wait for a fresh copy rather than a cached one.
  if (!q.data || (q.isFetching && !q.isFetchedAfterMount)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <ReactFlowProvider key={id}>
      <EditorView initial={q.data} />
    </ReactFlowProvider>
  );
}
