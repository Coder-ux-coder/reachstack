// One run of an automation: its steps with the data each used and returned, the log, attempts, retry and cancel.
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, ChevronRight, CircleDashed, Clock3, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { RUN_STATUS_LABELS } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime } from "@/lib/format";
import { Badge, Button, Callout, CopyButton, Dialog, KeyValue, Segmented, Spinner, Tooltip, useConfirm } from "@/components/ui";
import { ACTIVE_RUN, BASE, duration, keys, type RunDetail, type RunStep } from "./api";
import { JsonView, RunStatusBadge } from "./ui";

const STEP_ICON: Record<RunStep["status"], { icon: typeof CheckCircle2; tone: string }> = {
  success: { icon: CheckCircle2, tone: "text-ok" },
  error: { icon: XCircle, tone: "text-bad" },
  waiting: { icon: Clock3, tone: "text-warn" },
  running: { icon: CircleDashed, tone: "text-info" },
};

function StepRow({ step, defaultOpen }: { step: RunStep; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<"in" | "out">(step.type === "trigger" ? "out" : step.input ? "in" : "out");
  const { icon: Icon, tone } = STEP_ICON[step.status];
  const took = step.finished_at ? Date.parse(step.finished_at) - Date.parse(step.started_at) : null;
  return (
    <li className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-panel-2/60">
        <Icon size={16} className={cn("shrink-0", tone)} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{step.name}</span>
        <span className="hidden text-xs text-faint sm:inline">{step.status === "waiting" ? "Waiting" : took !== null ? duration(took) : ""}</span>
        <ChevronRight size={14} className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {step.error && <Callout tone="bad">{step.error}</Callout>}
          {step.type !== "trigger" && (
            <Segmented
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "in", label: "Data in" },
                { value: "out", label: "Data out" },
              ]}
            />
          )}
          <JsonView value={tab === "in" && step.type !== "trigger" ? step.input : step.output} />
        </div>
      )}
    </li>
  );
}

export function RunDialog({ runId, open, onOpenChange }: { runId: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [current, setCurrent] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const id = current ?? runId;
  const q = useQuery({
    queryKey: keys.run(id ?? ""),
    queryFn: () => get<RunDetail>(`${BASE}/executions/${id}`),
    enabled: open && !!id,
    // Live while it runs; slower while it waits on a delay.
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "queued" || s === "running" ? 1_500 : s === "waiting" ? 15_000 : false;
    },
  });
  const run = q.data;
  const close = (v: boolean) => {
    if (!v) {
      setCurrent(null);
      setRaw(false);
    }
    onOpenChange(v);
  };

  const retry = async () => {
    if (!run) return;
    const step = run.current_step?.name ?? "the failed step";
    const ok = await confirm({
      title: "Retry this run?",
      description: `A new attempt starts again at “${step}”, using the data the earlier steps already produced. If that step had done part of its work (sent a request, created a record), retrying can do it again.`,
      confirmLabel: "Retry",
    });
    if (!ok) return;
    setBusy("retry");
    try {
      const next = await post<{ id: string }>(`${BASE}/executions/${run.id}/retry`);
      await qc.invalidateQueries({ queryKey: keys.runs });
      setCurrent(next.id);
      toast.success("Retry started");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!run) return;
    const ok = await confirm({ title: "Cancel this run?", description: "The run stops where it is. Steps that already ran aren't undone.", confirmLabel: "Cancel run", danger: true });
    if (!ok) return;
    setBusy("cancel");
    try {
      await post(`${BASE}/executions/${run.id}/cancel`);
      await qc.invalidateQueries({ queryKey: keys.runs });
      toast.success("Run cancelled");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const failedStep = run?.status === "error" ? run.current_step : null;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Run details
          {run && <RunStatusBadge status={run.status} />}
          {run?.is_test && <Badge tone="info">Test</Badge>}
        </span>
      }
      description={run?.workflow_name ? <Link to={`/app/automations/${run.workflow_id}`} className="hover:underline">{run.workflow_name}</Link> : undefined}
      footer={
        run && (
          <>
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setRaw(!raw)}>
              {raw ? "Show steps" : "View JSON"}
            </Button>
            {(run.status === "queued" || run.status === "waiting") && (
              <Button size="sm" onClick={cancel} loading={busy === "cancel"}>
                Cancel run
              </Button>
            )}
            {run.status === "error" && (
              <Tooltip content={run.retry.available ? null : run.retry.message}>
                <span>
                  <Button size="sm" variant="primary" icon={<RotateCcw size={14} />} onClick={retry} loading={busy === "retry"} disabled={!run.retry.available}>
                    Retry
                  </Button>
                </span>
              </Tooltip>
            )}
            <Button size="sm" onClick={() => close(false)}>
              Close
            </Button>
          </>
        )
      }
    >
      {!run ? (
        <div className="flex justify-center py-12">{q.error ? <p className="text-[13px] text-bad">{errorMessage(q.error)}</p> : <Spinner />}</div>
      ) : raw ? (
        <JsonView value={run} maxHeight="max-h-[60vh]" />
      ) : (
        <div className="space-y-5">
          {failedStep && (
            <Callout tone="bad" title={`Failed at “${failedStep.name}”`}>
              {run.error}
            </Callout>
          )}
          {run.status === "error" && !run.retry.available && run.retry.message && <p className="text-xs text-muted">{run.retry.message}</p>}
          {run.status === "cancelled" && run.error && <Callout tone="info">{run.error}</Callout>}
          <KeyValue
            items={[
              [
                "Run ID",
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  {run.id}
                  <CopyButton value={run.id} />
                </span>,
              ],
              ["Started", dateTime(run.timestamp_created)],
              [run.timestamp_finished ? "Finished" : "Updated", dateTime(run.timestamp_finished ?? run.timestamp_updated)],
              ["Duration", run.timestamp_finished ? duration(run.duration_ms) : ACTIVE_RUN.includes(run.status) ? RUN_STATUS_LABELS[run.status] : "–"],
              ...(run.lead_email ? ([["Lead", run.lead_email]] as Array<[string, string]>) : []),
              ...(run.status === "waiting" && run.resume_at ? ([["Continues", dateTime(run.resume_at)]] as Array<[string, string]>) : []),
            ]}
          />
          {run.attempts.length > 1 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-[13px] font-semibold">Attempts</h4>
                <Button variant="ghost" size="xs" icon={<RefreshCw size={12} />} onClick={() => q.refetch()}>
                  Refresh
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {run.attempts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setCurrent(a.id)}
                    className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", a.id === run.id ? "border-brand bg-brand-soft text-brand-text" : "border-line hover:bg-panel-2")}
                  >
                    {a.attempt === 0 ? "Original" : `Retry ${a.attempt}`}
                    <span className={cn("h-1.5 w-1.5 rounded-full", a.status === "success" ? "bg-ok" : a.status === "error" ? "bg-bad" : "bg-warn")} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Steps</h4>
            {run.steps.length ? (
              <ul className="space-y-1.5">
                {run.steps.map((s) => (
                  <StepRow key={`${run.id}-${s.id}`} step={s} defaultOpen={s.status === "error"} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">{run.status === "queued" ? "Waiting to start…" : "No steps ran."}</p>
            )}
          </div>
          {run.logs.length > 0 && (
            <div>
              <h4 className="mb-2 text-[13px] font-semibold">Log</h4>
              <ul className="scroll-thin max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel-2 p-2.5 font-mono text-xs">
                {run.logs.map((l, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-faint">{new Date(l.at).toLocaleTimeString()}</span>
                    {l.level !== "info" && <AlertCircle size={13} className={cn("mt-px shrink-0", l.level === "error" ? "text-bad" : "text-warn")} />}
                    <span className="min-w-0 break-words">{l.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
