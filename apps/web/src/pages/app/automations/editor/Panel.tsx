// The side panel for the selected step: choose the event or action, fill in its settings, test it; or set up a
// condition, delay, paths or join.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Plus, RefreshCw, Trash2, X, XCircle } from "lucide-react";
import {
  CONDITION_OPERATORS,
  MAX_DELAY_DAYS,
  NODE_KIND_LABELS,
  actionDef,
  defaultConfig,
  delayError,
  evaluateCondition,
  nodeLabel,
  testVariables,
  triggerDef,
  type AutomationGraph,
  type AutomationNode,
  type ConditionGroup,
  type ConditionOperator,
  type ConditionRule,
  type NodeData,
  type NodeWarning,
  type RunVariables,
} from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { shortWhen } from "@/lib/format";
import { useWorkspaceZone } from "@/lib/session";
import { Badge, Button, Callout, CopyButton, Input, NumberInput, Segmented, Select, Spinner, Tabs, useConfirm } from "@/components/ui";
import { BASE, type Automation, type Options, type StepTestResult, type TriggerSample } from "../api";
import { AppIcon, FlowIcon, JsonView, useAppLabel } from "../ui";
import { PathInput, TemplateInput, type DataSource } from "./data";
import { ConfigForm } from "./fields";
import { ancestors, newId } from "./model";
import { EventList } from "./Picker";

export interface PanelProps {
  /** The automation as last saved (id, name, webhook URL). */
  wf: Automation;
  graph: AutomationGraph;
  node: AutomationNode;
  warnings: NodeWarning[];
  options: Options | undefined;
  readOnly: boolean;
  /** Merges into the step's data; edits with the same `key` close together undo as one. */
  onData(patch: Partial<NodeData>, key?: string): void;
  /** Replaces the whole graph (removing a path also removes its connections). */
  onGraph(next: AutomationGraph): void;
  onDelete(): void;
  onClose(): void;
  onSave(): Promise<boolean>;
  onWorkflow(next: Automation): void;
}

/** Data the step's fields can use: the trigger and the actions that run before it. */
function useSources(graph: AutomationGraph, node: AutomationNode, wf: Automation): { sources: DataSource[]; vars: RunVariables } {
  return useMemo(() => {
    const vars = testVariables(graph, wf);
    const sources: DataSource[] = [];
    const trigger = graph.nodes.find((n) => n.type === "trigger");
    const tdef = triggerDef(trigger?.data.key);
    if (trigger && tdef && trigger.id !== node.id) {
      sources.push({ id: "trigger", title: nodeLabel(trigger), icon: <AppIcon app={tdef.app} size={18} />, data: vars.trigger, example: !trigger.data.sample || trigger.data.sample.example === true, prefix: "trigger" });
    }
    const before = ancestors(graph, node.id);
    const steps = graph.nodes.filter((n) => n.type === "action" && before.has(n.id) && actionDef(n.data.key)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    for (const n of steps) sources.push({ id: n.id, title: nodeLabel(n), icon: <AppIcon app={actionDef(n.data.key)!.app} size={18} />, data: (vars.steps as Record<string, unknown>)[n.id], example: !n.data.sample, prefix: `steps.${n.id}` });
    return { sources, vars };
  }, [graph, node.id, wf]);
}

function Section({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Trigger and action tests

const sameData = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function TriggerTest({ wf, node, onData, onSave, onWorkflow, readOnly }: Pick<PanelProps, "wf" | "node" | "onData" | "onSave" | "onWorkflow" | "readOnly">) {
  const def = triggerDef(node.data.key)!;
  const confirm = useConfirm();
  const [items, setItems] = useState<TriggerSample[] | null>(null);
  const [loading, setLoading] = useState(false);
  const webhook = def.key === "webhook";
  const load = async () => {
    setLoading(true);
    try {
      const r = await post<{ items: TriggerSample[] }>(`${BASE}/${wf.id}/trigger-samples`, { key: def.key, config: node.data.config ?? {} });
      setItems(r.items);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!webhook || wf.webhook_url) void load();
    // Load once when the tab opens; "Load again" refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const regenerate = async () => {
    const ok = await confirm({ title: "Get a new URL?", description: "The current URL stops working right away. Update every app that sends requests to it.", confirmLabel: "Get a new URL", danger: true });
    if (!ok) return;
    try {
      onWorkflow(await post<Automation>(`${BASE}/${wf.id}/webhook/regenerate`));
      toast.success("New URL ready");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const sample = node.data.sample;
  const choose = (output: Record<string, unknown>) => onData({ sample: output, tested: true });
  return (
    <div className="space-y-5">
      {webhook && (
        <Section title="Your URL">
          {wf.webhook_url ? (
            <>
              <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{wf.webhook_url}</code>
                <CopyButton value={wf.webhook_url} label="Copy URL" />
              </div>
              <p className="text-xs text-muted">
                Send a GET or POST request (JSON or form data) to this URL. While you build, requests are kept here to test with; once the automation is on, each request starts a run.
              </p>
              {!readOnly && (
                <Button variant="link" size="xs" onClick={regenerate}>
                  Get a new URL
                </Button>
              )}
            </>
          ) : (
            <Callout
              title="Save to get the URL"
              action={
                !readOnly && (
                  <Button size="xs" variant="primary" onClick={() => void onSave()}>
                    Save
                  </Button>
                )
              }
            >
              The automation gets its own URL once it's saved with this trigger.
            </Callout>
          )}
        </Section>
      )}
      {(!webhook || wf.webhook_url) && (
        <Section
          title={webhook ? "Requests received" : "Test with a recent record"}
          action={
            <Button variant="ghost" size="xs" icon={<RefreshCw size={12} />} onClick={load} loading={loading}>
              {items ? "Load again" : webhook ? "Load requests" : "Find records"}
            </Button>
          }
        >
          {loading && !items ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : items && items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-muted">
              {webhook ? "No requests yet. Send one to the URL above, then load again." : "Nothing recent matches this trigger. Use example data to keep building, and test again once real data arrives."}
            </p>
          ) : items ? (
            <ul className="space-y-1">
              {items.map((it) => {
                const on = sameData(sample, it.output);
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => choose(it.output)}
                      className={cn("flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left", on ? "border-brand bg-brand-soft" : "border-line hover:bg-panel-2")}
                    >
                      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={10} strokeWidth={3} />}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{it.label}</span>
                      {it.at && <span className="shrink-0 text-xs text-faint">{shortWhen(it.at)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {!readOnly && (
            <Button size="sm" variant={sample?.example ? "soft" : "secondary"} onClick={() => choose(def.example)}>
              {sample?.example ? "Using example data" : "Use example data"}
            </Button>
          )}
        </Section>
      )}
      <Section title={<span className="flex items-center gap-2">Test data {sample?.example === true && <Badge tone="warn">Example</Badge>}</span>}>
        {sample ? <JsonView value={sample} /> : <p className="text-[13px] text-muted">Choose a record above. Later steps can use its data, and tests of those steps run with it.</p>}
      </Section>
    </div>
  );
}

function ActionTest({ wf, graph, node, onData, readOnly, onTried }: Pick<PanelProps, "wf" | "graph" | "node" | "onData" | "readOnly"> & { onTried: () => void }) {
  const def = actionDef(node.data.key)!;
  const [result, setResult] = useState<StepTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"in" | "out">("out");
  const run = async () => {
    onTried();
    setBusy(true);
    try {
      const r = await post<StepTestResult>(`${BASE}/${wf.id}/test-step`, { graph, node_id: node.id });
      setResult(r);
      setView(r.status === "error" && !r.output ? "in" : "out");
      if (r.status === "success") {
        const out = r.output && typeof r.output === "object" && !Array.isArray(r.output) ? (r.output as Record<string, unknown>) : { result: r.output };
        onData({ sample: out, tested: true });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const lastOutput = !result && node.data.sample ? node.data.sample : null;
  return (
    <div className="space-y-4">
      {def.sideEffects && (
        <Callout tone="warn" title="Testing really runs this step">
          {def.description} Use test data you don't mind changing.
        </Callout>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={run} loading={busy}>
            {result || node.data.tested ? "Test again" : "Test step"}
          </Button>
          {!node.data.tested && !result && (
            <Button variant="ghost" size="sm" onClick={() => onData({ tested: true })}>
              Skip test
            </Button>
          )}
        </div>
      )}
      {result && (
        <div className="space-y-3">
          {result.status === "success" ? (
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-ok">
              <CheckCircle2 size={15} /> The step ran.
            </p>
          ) : (
            <Callout tone="bad" title="The step failed">
              {result.error}
            </Callout>
          )}
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "in", label: "Data in" },
              { value: "out", label: "Data out" },
            ]}
          />
          <JsonView value={view === "in" ? result.input : result.output} />
          {result.logs.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-line bg-panel-2 p-2.5 font-mono text-xs">
              {result.logs.map((l, i) => (
                <li key={i} className={cn(l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "")}>
                  {l.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {lastOutput && (
        <Section title="Output of the last test">
          <JsonView value={lastOutput} />
        </Section>
      )}
      {!result && !lastOutput && <p className="text-[13px] text-muted">Testing runs the step with the trigger's test data and what the earlier steps returned. Later steps can then use its output.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers and actions

function EventBody(props: PanelProps & { sources: DataSource[] }) {
  const { node, onData, readOnly, options, sources } = props;
  const isTrigger = node.type === "trigger";
  const def = isTrigger ? triggerDef(node.data.key) : actionDef(node.data.key);
  const [tab, setTab] = useState<"setup" | "configure" | "test">(def ? "configure" : "setup");
  const [showErrors, setShowErrors] = useState(false);
  const zone = useWorkspaceZone();
  const pick = (key: string | null) => {
    if (!key) return;
    if (key !== node.data.key) {
      const fields = (isTrigger ? triggerDef(key) : actionDef(key))?.fields ?? [];
      onData({ key, config: defaultConfig(fields, zone), sample: null, tested: false, name: null });
      setShowErrors(false);
    }
    setTab("configure");
  };
  const tabs = [
    { value: "setup" as const, label: isTrigger ? "Trigger" : "Action" },
    ...(def ? [{ value: "configure" as const, label: "Settings" }, { value: "test" as const, label: "Test" }] : []),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab} onChange={setTab} tabs={tabs} className="shrink-0 px-4" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "setup" && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">{isTrigger ? "Choose what starts this automation." : "Choose what this step does."}</p>
            {readOnly ? <p className="text-[13px]">{def?.label ?? "Nothing chosen yet."}</p> : <EventList mode={isTrigger ? "trigger" : "action"} selectedKey={node.data.key} onPick={(p) => pick(p.key)} />}
          </div>
        )}
        {tab === "configure" && def && (
          <div className="space-y-5">
            <p className="text-[13px] text-muted">{def.description}</p>
            <ConfigForm fields={def.fields} config={node.data.config ?? {}} onChange={(config) => onData({ config }, `config:${node.id}`)} env={{ options, sources, readOnly, showErrors }} />
            <div className="flex justify-end">
              <Button size="sm" icon={<ArrowRight size={14} />} onClick={() => setTab("test")}>
                Continue to test
              </Button>
            </div>
          </div>
        )}
        {tab === "test" && def && (isTrigger ? <TriggerTest {...props} /> : <ActionTest {...props} onTried={() => setShowErrors(true)} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Condition

const emptyRule = (): ConditionRule => ({ field: "", operator: "equals", value: "" });
const OPERATOR_OPTIONS = CONDITION_OPERATORS.map((o) => ({ value: o.value, label: o.label }));
const needsValue = (op: ConditionOperator) => CONDITION_OPERATORS.find((o) => o.value === op)?.needsValue !== false;

function show(v: unknown): string {
  if (v === undefined) return "not found";
  if (v === null || v === "") return "empty";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** "steps.n_ab12.score" as "Ask AI › score". */
function friendlyPath(path: string, sources: DataSource[]) {
  const source = sources.find((s) => path === s.prefix || path.startsWith(`${s.prefix}.`));
  const rest = source ? path.slice(source.prefix.length + 1) : path;
  return [source?.title, ...rest.split(".")].filter(Boolean).join(" › ");
}

function ConditionBody({ node, onData, readOnly, sources, vars }: Pick<PanelProps, "node" | "onData" | "readOnly"> & { sources: DataSource[]; vars: RunVariables }) {
  const groups: ConditionGroup[] = node.data.groups?.length ? node.data.groups : [{ rules: [emptyRule()] }];
  const key = `groups:${node.id}`;
  const set = (next: ConditionGroup[]) => onData({ groups: next }, key);
  const setRule = (gi: number, ri: number, patch: Partial<ConditionRule>) => set(groups.map((g, i) => (i !== gi ? g : { rules: g.rules.map((r, j) => (j === ri ? { ...r, ...patch } : r)) })));
  const removeRule = (gi: number, ri: number) => {
    const next = groups.map((g, i) => (i !== gi ? g : { rules: g.rules.filter((_, j) => j !== ri) })).filter((g) => g.rules.length);
    onData({ groups: next.length ? next : [{ rules: [emptyRule()] }] });
  };
  const test = evaluateCondition(groups, vars);
  const usesExample = sources.some((s) => s.example);
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <p className="text-[13px] text-muted">
        When the rules match, the run continues on the <span className="font-medium text-ok">true</span> branch; otherwise on the <span className="font-medium text-bad">false</span> branch (or it stops there, if nothing is connected).
      </p>
      <div>
        {groups.map((g, gi) => (
          <div key={gi}>
            {gi > 0 && (
              <div className="my-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <div className="space-y-2.5 rounded-lg border border-line p-2.5">
              {g.rules.map((r, ri) => (
                <div key={ri} className="space-y-1.5">
                  {ri > 0 && <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">and</div>}
                  <PathInput value={r.field} onChange={(field) => setRule(gi, ri, { field })} sources={sources} disabled={readOnly} />
                  <div className="flex items-start gap-1.5">
                    <Select className="w-48 shrink-0" aria-label="Operator" value={r.operator} options={OPERATOR_OPTIONS} disabled={readOnly} onChange={(operator) => setRule(gi, ri, { operator, value: r.value ?? "" })} />
                    {needsValue(r.operator) && (
                      <div className="min-w-0 flex-1">
                        <TemplateInput value={r.value ?? ""} onChange={(value) => setRule(gi, ri, { value })} sources={sources} placeholder="Value" disabled={readOnly} />
                      </div>
                    )}
                    {!readOnly && (
                      <Button variant="ghost" size="icon" className="ml-auto" aria-label="Remove rule" onClick={() => removeRule(gi, ri)}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {!readOnly && g.rules.length < 20 && (
                <Button variant="ghost" size="xs" icon={<Plus size={13} />} onClick={() => onData({ groups: groups.map((x, i) => (i === gi ? { rules: [...x.rules, emptyRule()] } : x)) })}>
                  And
                </Button>
              )}
            </div>
          </div>
        ))}
        {!readOnly && groups.length < 10 && (
          <Button variant="ghost" size="xs" className="mt-2" icon={<Plus size={13} />} onClick={() => onData({ groups: [...groups, { rules: [emptyRule()] }] })}>
            Or
          </Button>
        )}
      </div>
      <Section title={<span className="flex items-center gap-2">With the test data {usesExample && <Badge tone="warn">Example</Badge>}</span>}>
        {groups.some((g) => g.rules.some((r) => !r.field)) ? (
          <p className="text-[13px] text-muted">Choose the data for every rule to see where the run would go.</p>
        ) : (
          <p className={cn("flex items-center gap-1.5 text-[13px] font-medium", test.result ? "text-ok" : "text-bad")}>
            {test.result ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {test.result ? "True: the run would take the true branch." : "False: the run would take the false branch."}
          </p>
        )}
        <ul className="space-y-1">
          {test.groups.flatMap((g, gi) =>
            g.rules.map((r, ri) => (
              <li key={`${gi}-${ri}`} className="flex items-start gap-2 text-xs">
                {r.result ? <Check size={13} className="mt-px shrink-0 text-ok" /> : <X size={13} className="mt-px shrink-0 text-bad" />}
                {r.field ? (
                  <span className="min-w-0 break-words text-muted">
                    <span className="font-medium text-text">{friendlyPath(r.field, sources)}</span> is “{show(r.left)}”{needsValue(r.operator) && <>, compared with “{show(r.right)}”</>}
                  </span>
                ) : (
                  <span className="text-muted">Choose the data this rule checks.</span>
                )}
              </li>
            )),
          )}
        </ul>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Delay, paths, join

function DelayBody({ node, onData, readOnly }: Pick<PanelProps, "node" | "onData" | "readOnly">) {
  const error = delayError(node.data.amount, node.data.unit);
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <p className="text-[13px] text-muted">Each run waits here, then continues with the next step. A delay can be up to {MAX_DELAY_DAYS} days.</p>
      <div className="flex flex-wrap items-center gap-2">
        <NumberInput aria-label="Wait for" value={node.data.amount ?? null} min={1} className="w-28" disabled={readOnly} onChange={(amount) => onData({ amount }, `amount:${node.id}`)} />
        <Segmented
          value={node.data.unit ?? "days"}
          onChange={(unit) => !readOnly && onData({ unit })}
          options={[
            { value: "minutes", label: "Minutes" },
            { value: "hours", label: "Hours" },
            { value: "days", label: "Days" },
          ]}
        />
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      <Callout>If you change what this automation does while runs are waiting here, those runs stop instead of continuing with the new version.</Callout>
    </div>
  );
}

function PathsBody({ graph, node, onData, onGraph, readOnly }: Pick<PanelProps, "graph" | "node" | "onData" | "onGraph" | "readOnly">) {
  const paths = node.data.paths ?? [];
  const remove = (id: string) => {
    onGraph({
      nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, paths: paths.filter((p) => p.id !== id) } } : n)),
      edges: graph.edges.filter((e) => !(e.source === node.id && e.sourceHandle === id)),
    });
  };
  const nextName = () => {
    for (let i = 0; i < 26; i++) {
      const name = `Path ${String.fromCharCode(65 + i)}`;
      if (!paths.some((p) => p.name === name)) return name;
    }
    return `Path ${paths.length + 1}`;
  };
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <p className="text-[13px] text-muted">Every path runs, side by side. To carry on as one after them, add a “Join paths” step and connect the last step of each path to it.</p>
      <ul className="space-y-2">
        {paths.map((p) => (
          <li key={p.id} className="flex items-center gap-1.5">
            <Input aria-label="Path name" value={p.name} maxLength={80} disabled={readOnly} onChange={(e) => onData({ paths: paths.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)) }, `paths:${node.id}`)} />
            {!readOnly && paths.length > 1 && (
              <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}>
                <Trash2 size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && paths.length < 10 && (
        <Button variant="ghost" size="xs" icon={<Plus size={13} />} onClick={() => onData({ paths: [...paths, { id: newId("p"), name: nextName() }] })}>
          Add a path
        </Button>
      )}
    </div>
  );
}

function MergeBody({ graph, node }: Pick<PanelProps, "graph" | "node">) {
  const incoming = graph.edges.filter((e) => e.target === node.id).length;
  return (
    <div className="space-y-3 px-4 py-4 text-[13px] text-muted">
      <p>Waits for the paths connected to it, then continues once. A path that can't arrive (for example, a condition sent the run the other way) isn't waited for.</p>
      <p>
        {incoming} {incoming === 1 ? "path is" : "paths are"} connected.
        {incoming < 2 && " Connect at least two."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function StepPanel(props: PanelProps) {
  const { node, wf, graph, warnings, readOnly, onData, onDelete, onClose } = props;
  const appLabel = useAppLabel();
  const { sources, vars } = useSources(graph, node, wf);
  const def = node.type === "trigger" ? triggerDef(node.data.key) : node.type === "action" ? actionDef(node.data.key) : null;
  const fallback = nodeLabel({ type: node.type, data: { ...node.data, name: null } });
  return (
    <aside aria-label="Step settings" className="absolute inset-0 z-20 flex flex-col bg-panel md:static md:z-auto md:w-[26rem] md:shrink-0 md:border-l md:border-line">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        {def ? <AppIcon app={def.app} size={30} /> : <FlowIcon kind={node.type} size={30} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-faint">
            {NODE_KIND_LABELS[node.type]}
            {def ? ` · ${appLabel(def.app)}` : ""}
          </div>
          <input
            aria-label="Step name"
            value={node.data.name ?? ""}
            placeholder={fallback}
            maxLength={120}
            disabled={readOnly}
            onChange={(e) => onData({ name: e.target.value || null }, `name:${node.id}`)}
            className="w-full truncate rounded bg-transparent text-[15px] font-semibold outline-none placeholder:text-text focus:placeholder:text-faint disabled:cursor-default"
          />
        </div>
        {!readOnly && (
          <Button variant="ghost" size="icon-sm" aria-label="Delete step" title="Delete step" onClick={onDelete}>
            <Trash2 size={15} />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} />
        </Button>
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-1.5 border-b border-line px-4 py-3">
          {warnings.map((w) => (
            <li key={w.code + w.message} className="flex items-start gap-2 text-[13px]">
              <AlertTriangle size={14} className={cn("mt-0.5 shrink-0", w.blocking ? "text-bad" : "text-warn")} />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}
      {node.type === "trigger" || node.type === "action" ? (
        <EventBody {...props} sources={sources} />
      ) : node.type === "condition" ? (
        <ConditionBody node={node} onData={onData} readOnly={readOnly} sources={sources} vars={vars} />
      ) : node.type === "delay" ? (
        <DelayBody node={node} onData={onData} readOnly={readOnly} />
      ) : node.type === "paths" ? (
        <PathsBody graph={graph} node={node} onData={onData} onGraph={props.onGraph} readOnly={readOnly} />
      ) : (
        <MergeBody graph={graph} node={node} />
      )}
    </aside>
  );
}
