// Run history across automations: filters, live status and the run detail dialog.
import { useState } from "react";
import { Link } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, History as HistoryIcon } from "lucide-react";
import { RUN_STATUSES, RUN_STATUS_LABELS } from "@reachstack/shared";
import { get } from "@/lib/api";
import { dateTime, num, shortWhen } from "@/lib/format";
import { useDebounced, usePageTitle, useQueryState } from "@/lib/hooks";
import { Badge, Button, ButtonLink, Checkbox, DataTable, EmptyState, Page, PageHeader, SearchInput, Select, Tooltip, type Column } from "@/components/ui";
import { ACTIVE_RUN, BASE, duration, keys, type AutomationSummary, type RunSummary } from "./api";
import { RunDialog } from "./RunDialog";
import { RunStatusBadge } from "./ui";

const LIMIT = 25;

export default function AutomationHistory() {
  usePageTitle("Automation history");
  const [workflowId, setWorkflowId] = useQueryState("workflow_id");
  const [status, setStatus] = useQueryState("status");
  const [search, setSearch] = useQueryState("search");
  const [hideTests, setHideTests] = useQueryState("hide_tests");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const debounced = useDebounced(search, 300);
  const flows = useQuery({ queryKey: keys.list, queryFn: () => get<{ items: AutomationSummary[] }>(BASE) });
  const q = useQuery({
    queryKey: [...keys.runs, "list", { workflowId, status, debounced, hideTests, page }],
    queryFn: () => get<{ items: RunSummary[]; total: number }>(`${BASE}/executions`, { workflow_id: workflowId, status, search: debounced, tests: hideTests ? false : undefined, page, limit: LIMIT }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === "queued" || r.status === "running") ? 3_000 : false),
  });
  const filter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const columns: Column<RunSummary>[] = [
    {
      key: "date",
      header: "Date",
      cell: (r) => (
        <Tooltip content={dateTime(r.timestamp_created)}>
          <span className="whitespace-nowrap text-muted">{shortWhen(r.timestamp_created)}</span>
        </Tooltip>
      ),
    },
    {
      key: "automation",
      header: "Automation",
      cell: (r) =>
        r.workflow_name ? (
          <Link to={`/app/automations/${r.workflow_id}`} onClick={(e) => e.stopPropagation()} title={r.workflow_name} className="block max-w-[14rem] truncate font-medium hover:underline">
            {r.workflow_name}
          </Link>
        ) : (
          <span className="text-faint">Deleted automation</span>
        ),
    },
    { key: "lead", header: "Lead", hideBelow: "md", cell: (r) => (r.lead_email ? <span className="block max-w-[14rem] truncate text-muted">{r.lead_email}</span> : <span className="text-faint">–</span>) },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <div className="min-w-0 max-w-[14rem]">
          <div className="flex flex-wrap items-center gap-1.5">
            <RunStatusBadge status={r.status} />
            {r.is_test && <Badge tone="info">Test</Badge>}
            {r.attempt > 0 && <Badge>Retry {r.attempt}</Badge>}
          </div>
          {r.status === "error" && r.error ? (
            <Tooltip content={r.error}>
              <span className="mt-1 block truncate text-xs text-bad">
                {r.current_step ? `${r.current_step.name}: ` : ""}
                {r.error}
              </span>
            </Tooltip>
          ) : r.status === "waiting" && r.resume_at ? (
            <span className="mt-1 block text-xs text-muted">Continues {shortWhen(r.resume_at)}</span>
          ) : null}
        </div>
      ),
    },
    { key: "duration", header: "Duration", hideBelow: "sm", cell: (r) => <span className="tabular-nums text-muted">{ACTIVE_RUN.includes(r.status) ? "–" : duration(r.duration_ms)}</span> },
  ];
  return (
    <Page>
      <PageHeader
        back={
          <Link to="/app/automations" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
            <ArrowLeft size={14} /> Automations
          </Link>
        }
        title="History"
        description="Every run, with the data each step used and returned. Failed runs can be retried from the step that failed."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={filter(setSearch)} placeholder="Search by lead email" className="w-full sm:w-60" />
        <Select
          size="sm"
          className="w-56"
          aria-label="Automation"
          value={workflowId}
          onChange={filter(setWorkflowId)}
          options={[{ value: "", label: "All automations" }, ...(flows.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))]}
        />
        <Select size="sm" className="w-36" aria-label="Status" value={status} onChange={filter(setStatus)} options={[{ value: "", label: "All statuses" }, ...RUN_STATUSES.map((s) => ({ value: s, label: RUN_STATUS_LABELS[s] }))]} />
        <Checkbox label="Hide test runs" checked={!!hideTests} onChange={(v) => filter(setHideTests)(v ? "1" : "")} className="ml-1" />
      </div>
      <DataTable
        rows={q.data?.items ?? []}
        columns={columns}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        dense
        onRowClick={(r) => setOpen(r.id)}
        empty={
          <EmptyState
            icon={<HistoryIcon size={22} />}
            title="No runs found"
            description={workflowId || status || search ? "Try other filters." : "Runs show up here once an automation starts."}
            action={!workflowId && !status && !search ? <ButtonLink to="/app/automations">Go to automations</ButtonLink> : undefined}
          />
        }
      />
      {total > LIMIT && (
        <div className="mt-3 flex items-center justify-end gap-3 text-[13px] text-muted">
          <span>
            {num((page - 1) * LIMIT + 1)}–{num(Math.min(page * LIMIT, total))} of {num(total)}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={16} />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight size={16} />
          </Button>
        </div>
      )}
      <RunDialog runId={open} open={!!open} onOpenChange={(v) => !v && setOpen(null)} />
    </Page>
  );
}
