// /app/crm/leads — every lead by list, campaign or Salesflow, and /app/crm/dynamic-views — the Salesflows
// themselves: saved lead queues ("replied this week", "opened twice, no reply") that refresh as activity happens.
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Filter, FolderOpen, ListPlus, Pencil, Plus, Send, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useLeadStatuses, type StatusMeta } from "@/lib/statuses";
import { useCampaignNames, useListNames } from "@/lib/pickers";
import { Button, Card, DataTable, Dialog, EmptyState, ErrorState, Field, Input, NativeSelect, NumberInput, Page, PageHeader, Segmented, SkeletonRows, useConfirm, type Column } from "@/components/ui";
import { InterestBadge, VisitedMark } from "@/components/status";
import { LeadSheet } from "@/components/leads/LeadSheet";
import { LeadsTable } from "@/components/leads/LeadsTable";

type ActionType = "reply" | "email-open" | "last-contacted" | "link-click" | "lead-status" | "lead-status-change";

export interface FlowQuery {
  actionType: ActionType;
  values: {
    "occurrence-days"?: number;
    "occurrence-count"?: { condition: "more" | "less" | "equal"; count: number };
    "lead-status"?: { status: number; condition: "is" | "is-not" };
  };
}

export interface SalesFlow {
  id: string;
  name: string;
  is_default: boolean;
  queries: FlowQuery[];
  list_id: string | null;
  campaign_id: string | null;
  list_name: string | null;
  campaign_name: string | null;
  timestamp_created: string;
}

interface FlowLead {
  id: string;
  email: string;
  name: string | null;
  company_name: string | null;
  job_title: string | null;
  phone: string | null;
  status: number | null;
  open_count: number;
  reply_count: number;
  click_count: number;
  last_contact_at: string | null;
  last_reply_at: string | null;
  last_open_at: string | null;
  is_website_visitor?: boolean;
}

const ACTIONS: Array<{ value: ActionType; label: string }> = [
  { value: "email-open", label: "Opened an email" },
  { value: "link-click", label: "Clicked a link" },
  { value: "reply", label: "Replied to an email" },
  { value: "last-contacted", label: "Last contacted" },
  { value: "lead-status", label: "Lead status" },
  { value: "lead-status-change", label: "Lead status changed" },
];

const COUNTED: ActionType[] = ["email-open", "link-click", "reply"];
const FLOWS_KEY = ["crm", "sales-flows"];

export function useSalesFlows() {
  return useQuery({ queryKey: FLOWS_KEY, queryFn: () => get<{ items: SalesFlow[] }>("/api/app/crm/sales-flows") });
}

const blankQuery = (): FlowQuery => ({ actionType: "reply", values: { "occurrence-days": 7 } });

/** "Replied to an email in the past 7 days and lead status is not Interested". */
export function describeFlow(queries: FlowQuery[], statuses: StatusMeta[]) {
  const part = (q: FlowQuery) => {
    const days = q.values["occurrence-days"] ?? 7;
    const label = ACTIONS.find((a) => a.value === q.actionType)?.label ?? q.actionType;
    if (q.actionType === "lead-status") {
      const s = q.values["lead-status"];
      const name = statuses.find((x) => x.code === s?.status)?.label ?? "a status";
      return `Lead status ${s?.condition === "is-not" ? "is not" : "is"} "${name}"`;
    }
    if (q.actionType === "last-contacted") return `Last contacted more than ${plural(days, "day")} ago`;
    if (q.actionType === "lead-status-change") return `Lead status changed in the past ${plural(days, "day")}`;
    const c = q.values["occurrence-count"];
    const times = c ? ` ${c.condition === "more" ? "more than" : c.condition === "less" ? "less than" : "exactly"} ${plural(c.count, "time")}` : "";
    return `${label}${times} in the past ${plural(days, "day")}`;
  };
  return queries
    .map(part)
    .map((s, i) => (i ? s.charAt(0).toLowerCase() + s.slice(1) : s))
    .join(" and ");
}

// ---------------------------------------------------------------------------------------------------------------
// Salesflow editor

function ConditionRow({ q, onChange, onRemove, statuses }: { q: FlowQuery; onChange: (q: FlowQuery) => void; onRemove?: () => void; statuses: StatusMeta[] }) {
  const days = q.values["occurrence-days"] ?? 7;
  const count = q.values["occurrence-count"];
  const setType = (actionType: ActionType) =>
    onChange({
      actionType,
      values: actionType === "lead-status" ? { "lead-status": { status: statuses.find((s) => s.sentiment === "positive")?.code ?? 1, condition: "is" } } : { "occurrence-days": days },
    });
  const daysInput = (
    <NumberInput aria-label="Days" value={days} onChange={(v) => onChange({ ...q, values: { ...q.values, "occurrence-days": Math.max(1, Math.min(3650, v ?? 1)) } })} min={1} max={3650} suffix="days" className="w-28" />
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2/50 p-2.5">
      <NativeSelect size="sm" className="w-auto" aria-label="Condition" value={q.actionType} onChange={(v) => setType(v as ActionType)} options={ACTIONS} />
      {COUNTED.includes(q.actionType) && (
        <>
          <NativeSelect
            size="sm"
            className="w-auto"
            aria-label="How often"
            value={count?.condition ?? "any"}
            onChange={(v) =>
              onChange({ ...q, values: { ...q.values, "occurrence-count": v === "any" ? undefined : { condition: v as "more" | "less" | "equal", count: count?.count ?? 1 } } })
            }
            options={[
              { value: "any", label: "at least once" },
              { value: "more", label: "more than" },
              { value: "less", label: "less than" },
              { value: "equal", label: "exactly" },
            ]}
          />
          {count && (
            <NumberInput
              aria-label="Times"
              value={count.count}
              onChange={(v) => onChange({ ...q, values: { ...q.values, "occurrence-count": { ...count, count: Math.max(0, v ?? 0) } } })}
              min={0}
              max={10000}
              suffix="times"
              className="w-28"
            />
          )}
          <span className="text-[13px] text-muted">in the past</span>
          {daysInput}
        </>
      )}
      {q.actionType === "last-contacted" && (
        <>
          <span className="text-[13px] text-muted">more than</span>
          {daysInput}
          <span className="text-[13px] text-muted">ago</span>
        </>
      )}
      {q.actionType === "lead-status-change" && (
        <>
          <span className="text-[13px] text-muted">in the past</span>
          {daysInput}
        </>
      )}
      {q.actionType === "lead-status" && (
        <>
          <NativeSelect
            size="sm"
            className="w-auto"
            aria-label="Is or is not"
            value={q.values["lead-status"]?.condition ?? "is"}
            onChange={(v) => onChange({ ...q, values: { "lead-status": { status: q.values["lead-status"]?.status ?? 1, condition: v as "is" | "is-not" } } })}
            options={[
              { value: "is", label: "is" },
              { value: "is-not", label: "is not" },
            ]}
          />
          <NativeSelect
            size="sm"
            className="w-auto"
            aria-label="Status"
            value={String(q.values["lead-status"]?.status ?? 1)}
            onChange={(v) => onChange({ ...q, values: { "lead-status": { condition: q.values["lead-status"]?.condition ?? "is", status: Number(v) } } })}
            options={statuses.map((s) => ({ value: String(s.code), label: s.label }))}
          />
        </>
      )}
      {onRemove && (
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Remove condition" onClick={onRemove}>
          <X size={14} />
        </Button>
      )}
    </div>
  );
}

export function FlowDialog({ open, onOpenChange, flow, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; flow?: SalesFlow | null; onSaved?: (f: SalesFlow) => void }) {
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"all" | "campaign" | "list">("all");
  const [campaignId, setCampaignId] = useState("");
  const [listId, setListId] = useState("all-lists");
  const [queries, setQueries] = useState<FlowQuery[]>([blankQuery()]);
  const [busy, setBusy] = useState(false);
  const campaigns = useCampaignNames(open);
  const lists = useListNames(open);

  useEffect(() => {
    if (!open) return;
    setName(flow?.name ?? "");
    setScope(flow?.campaign_id ? "campaign" : flow?.list_id ? "list" : "all");
    setCampaignId(flow?.campaign_id ?? "");
    setListId(flow?.list_id ?? "all-lists");
    setQueries(flow?.queries.length ? flow.queries : [blankQuery()]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!name.trim()) return toast.error("Please set a name");
    if (scope === "campaign" && !campaignId) return toast.error("Select a campaign");
    setBusy(true);
    try {
      const body = { name: name.trim(), queries, campaign_id: scope === "campaign" ? campaignId : null, list_id: scope === "list" ? listId : null };
      const saved = flow ? await patch<SalesFlow>(`/api/app/crm/sales-flows/${flow.id}`, body) : await post<SalesFlow>("/api/app/crm/sales-flows", body);
      toast.success(flow ? "Salesflow updated" : "Salesflow created");
      qc.invalidateQueries({ queryKey: ["crm", "sales-flows"] });
      onSaved?.(saved);
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
      size="lg"
      title={flow ? "Edit Salesflow" : "Create new Salesflow"}
      description="A saved queue of leads that match your conditions. It updates on its own as leads open, click, reply and change status."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {flow ? "Save Salesflow" : "Create Salesflow"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name">{(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Hot leads to call today" />}</Field>
        <Field label="Leads from">
          {() => (
            <div className="space-y-2">
              <Segmented
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: "All leads" },
                  { value: "campaign", label: "Campaign leads" },
                  { value: "list", label: "List leads" },
                ]}
              />
              {scope === "campaign" && (
                <NativeSelect aria-label="Campaign" value={campaignId} onChange={setCampaignId} options={[{ value: "", label: "Select campaign" }, ...(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
              )}
              {scope === "list" && (
                <NativeSelect aria-label="List" value={listId} onChange={setListId} options={[{ value: "all-lists", label: "All lists" }, ...(lists.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
              )}
            </div>
          )}
        </Field>
        <div>
          <p className="text-sm font-medium">Conditions</p>
          <p className="mb-2 text-xs text-muted">Leads must match every condition.</p>
          <div className="space-y-2">
            {queries.map((q, i) => (
              <div key={i}>
                {i > 0 && <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">and</p>}
                <ConditionRow q={q} statuses={statuses.all} onChange={(n) => setQueries((qs) => qs.map((x, j) => (j === i ? n : x)))} onRemove={queries.length > 1 ? () => setQueries((qs) => qs.filter((_, j) => j !== i)) : undefined} />
              </div>
            ))}
          </div>
          {queries.length < 10 && (
            <Button size="sm" variant="ghost" className="mt-2" icon={<Plus size={14} />} onClick={() => setQueries((qs) => [...qs, blankQuery()])}>
              Add condition
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// /app/crm/dynamic-views

export function SalesFlows() {
  usePageTitle("Salesflows");
  const can = useCan();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const flows = useSalesFlows();
  const [editing, setEditing] = useState<SalesFlow | null | "new">(null);

  const remove = async (f: SalesFlow) => {
    if (!(await confirm({ title: `Delete "${f.name}"?`, description: "The Salesflow is deleted. Its leads stay where they are.", confirmLabel: "Delete Salesflow", danger: true }))) return;
    try {
      await del(`/api/app/crm/sales-flows/${f.id}`);
      toast.success("Salesflow deleted");
      qc.invalidateQueries({ queryKey: FLOWS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Salesflows"
        description="Saved lead queues built from activity: who replied, opened, clicked or changed status recently. Work them top to bottom."
        actions={
          can.write && (
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
              Create Salesflow
            </Button>
          )
        }
      />
      {flows.isLoading ? (
        <SkeletonRows rows={4} />
      ) : flows.isError && !flows.data ? (
        <Card>
          <ErrorState title="Your Salesflows couldn't be loaded" error={flows.error} onRetry={() => flows.refetch()} />
        </Card>
      ) : !flows.data?.items.length ? (
        <Card>
          <EmptyState
            icon={<Filter size={22} />}
            title="Create a Salesflow to get started"
            description="For example: leads who opened your emails more than twice in the past 14 days but haven't replied."
            action={
              can.write && (
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
                  Create Salesflow
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {flows.data.items.map((f) => (
            <Card key={f.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/app/crm/leads?flowId=${f.id}`} className="-my-1 min-w-0 truncate py-1 text-[15px] font-semibold hover:underline">
                  {f.name}
                </Link>
                {can.write && (
                  <div className="-mr-1 -mt-1 flex shrink-0">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f)}>
                      <Pencil size={14} />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${f.name}`} onClick={() => remove(f)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-1 text-[13px] text-muted">{describeFlow(f.queries, statuses.all)}</p>
              <p className="mt-3 text-xs text-faint">
                {f.campaign_id ? `Campaign: ${f.campaign_name ?? "deleted campaign"}` : f.list_id ? (f.list_id === "all-lists" ? "All lists" : `List: ${f.list_name ?? "deleted list"}`) : "All leads"}
              </p>
              <div className="mt-auto pt-4">
                <Link to={`/app/crm/leads?flowId=${f.id}`} className="text-[13px] font-medium text-brand-text hover:underline">
                  View leads →
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
      <FlowDialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)} flow={editing === "new" ? null : editing} />
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// /app/crm/leads

function FlowLeads({ flow }: { flow: SalesFlow }) {
  const statuses = useLeadStatuses();
  const [lead, setLead] = useState<string | null>(null);
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: ["crm", "flow-leads", flow.id, flow.queries],
    // Each page follows the last lead shown, so leads that become active meanwhile aren't skipped or shown twice.
    queryFn: ({ pageParam }) => get<{ total: number; items: FlowLead[]; next_after: string | null }>(`/api/app/crm/sales-flows/${flow.id}/leads`, { limit: 50, after: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_after ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const columns: Column<FlowLead>[] = [
    {
      key: "lead",
      header: "Lead",
      cell: (l) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{l.name || l.email}</span>
            {l.is_website_visitor && <VisitedMark />}
          </p>
          <p className="truncate text-xs text-muted">{l.name ? l.email : l.job_title}</p>
        </div>
      ),
    },
    { key: "company", header: "Company", cell: (l) => <span className="block max-w-[14rem] truncate whitespace-nowrap">{l.company_name ?? "–"}</span>, hideBelow: "md" },
    { key: "status", header: "Status", cell: (l) => <InterestBadge code={l.status} labels={statuses.all} />, hideBelow: "sm" },
    { key: "activity", header: "Opens · Clicks · Replies", cell: (l) => `${num(l.open_count)} · ${num(l.click_count)} · ${num(l.reply_count)}`, hideBelow: "lg" },
    { key: "last", header: "Last reply", cell: (l) => (l.last_reply_at ? ago(l.last_reply_at) : "–"), hideBelow: "lg" },
    { key: "contacted", header: "Last contacted", cell: (l) => (l.last_contact_at ? ago(l.last_contact_at) : "–"), hideBelow: "xl" },
  ];
  const total = q.data?.pages[0]?.total;
  return (
    <>
      <p className="mb-3 text-[13px] text-muted">{total === undefined ? " " : `${plural(total, "lead")} match right now.`}</p>
      <Card padded={false}>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(l) => l.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          onRowClick={(l) => setLead(l.id)}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => q.fetchNextPage()}
          empty={<EmptyState title="No leads match yet" description="Leads join this Salesflow as soon as their activity matches its conditions." />}
        />
      </Card>
      <LeadSheet leadId={lead} onClose={() => setLead(null)} onChanged={() => qc.invalidateQueries({ queryKey: ["crm", "flow-leads"] })} />
    </>
  );
}

function SideLink({ to, active, icon, children }: { to: string; active: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink to={to} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]", active ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-panel-2 hover:text-text")}>
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="truncate">{children}</span>
    </NavLink>
  );
}

function SideGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between px-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export default function CrmLeads() {
  usePageTitle("Leads");
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const listId = params.get("listId");
  const campaignId = params.get("campaignId");
  const flowId = params.get("flowId");
  const lists = useListNames();
  const campaigns = useCampaignNames();
  const agents = useQuery({ queryKey: ["crm", "sales-agents"], queryFn: () => get<{ items: Array<{ id: string; name: string }> }>("/api/v2/ai-agents/sales", { limit: 100 }) });
  const flows = useSalesFlows();
  const [newList, setNewList] = useState(false);
  const [listName, setListName] = useState("");
  const [creating, setCreating] = useState(false);
  const [flowDialog, setFlowDialog] = useState<SalesFlow | null | "new">(null);

  const flow = flowId ? flows.data?.items.find((f) => f.id === flowId) : undefined;
  const list = listId ? lists.data?.items.find((l) => l.id === listId) : undefined;
  const campaign = campaignId ? campaigns.data?.items.find((c) => c.id === campaignId) : undefined;
  const title = flow?.name ?? list?.name ?? campaign?.name ?? (flowId || listId || campaignId ? " " : "All leads");

  const createList = async () => {
    // Enter in the name field skips the button, so a second press can't make the list twice.
    if (creating) return;
    if (!listName.trim()) return toast.error("Please enter the name of the list");
    setCreating(true);
    try {
      const created = await post<{ id: string }>("/api/v2/lead-lists", { name: listName.trim() });
      toast.success("List created");
      setNewList(false);
      setListName("");
      await qc.invalidateQueries({ queryKey: ["lead-lists"] });
      navigate(`/app/crm/leads?listId=${created.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };
  const removeFlow = async (f: SalesFlow) => {
    if (!(await confirm({ title: `Delete "${f.name}"?`, description: "The Salesflow is deleted. Its leads stay where they are.", confirmLabel: "Delete Salesflow", danger: true }))) return;
    try {
      await del(`/api/app/crm/sales-flows/${f.id}`);
      toast.success("Salesflow deleted");
      qc.invalidateQueries({ queryKey: FLOWS_KEY });
      navigate("/app/crm/leads");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const scopeOptions = [
    { value: "", label: "All leads" },
    ...(flows.data?.items.length ? [{ group: "Salesflows", options: flows.data.items.map((f) => ({ value: `flowId=${f.id}`, label: f.name })) }] : []),
    ...(lists.data?.items.length ? [{ group: "Lists", options: lists.data.items.map((l) => ({ value: `listId=${l.id}`, label: l.name })) }] : []),
    ...(campaigns.data?.items.length ? [{ group: "Campaigns", options: campaigns.data.items.map((c) => ({ value: `campaignId=${c.id}`, label: c.name })) }] : []),
  ];
  const scopeValue = flowId ? `flowId=${flowId}` : listId ? `listId=${listId}` : campaignId ? `campaignId=${campaignId}` : "";

  return (
    <div className="flex min-h-full">
      <aside className="scroll-thin hidden w-60 shrink-0 space-y-5 overflow-y-auto border-r border-line bg-panel px-2.5 py-4 lg:block">
        <SideLink to="/app/crm/leads" active={!listId && !campaignId && !flowId} icon={<Users size={14} />}>
          All leads
        </SideLink>
        <SideGroup
          title="Salesflows"
          action={
            can.write && (
              <button type="button" className="rounded p-0.5 text-faint hover:bg-panel-2 hover:text-text" aria-label="Create Salesflow" onClick={() => setFlowDialog("new")}>
                <Plus size={14} />
              </button>
            )
          }
        >
          {(flows.data?.items ?? []).map((f) => (
            <SideLink key={f.id} to={`/app/crm/leads?flowId=${f.id}`} active={flowId === f.id} icon={<Filter size={14} />}>
              {f.name}
            </SideLink>
          ))}
          {!flows.data?.items.length && <p className="px-2 text-xs text-faint">No Salesflows yet</p>}
        </SideGroup>
        <SideGroup
          title="Lists"
          action={
            can.write && (
              <button type="button" className="rounded p-0.5 text-faint hover:bg-panel-2 hover:text-text" aria-label="Create new list" onClick={() => setNewList(true)}>
                <Plus size={14} />
              </button>
            )
          }
        >
          {(lists.data?.items ?? []).map((l) => (
            <SideLink key={l.id} to={`/app/crm/leads?listId=${l.id}`} active={listId === l.id} icon={<FolderOpen size={14} />}>
              {l.name || "Unnamed list"}
            </SideLink>
          ))}
          {!lists.data?.items.length && <p className="px-2 text-xs text-faint">Create a list to get started</p>}
        </SideGroup>
        <SideGroup title="Campaigns">
          {(campaigns.data?.items ?? []).map((c) => (
            <SideLink key={c.id} to={`/app/crm/leads?campaignId=${c.id}`} active={campaignId === c.id} icon={<Send size={14} />}>
              {c.name}
            </SideLink>
          ))}
        </SideGroup>
        {!!agents.data?.items.length && (
          <SideGroup title="AI sales agents">
            {agents.data.items.map((a) => (
              <SideLink key={a.id} to={`/app/ai-sales-agent/${a.id}/leads`} active={false} icon={<Bot size={14} />}>
                {a.name}
              </SideLink>
            ))}
          </SideGroup>
        )}
      </aside>

      <div className="min-w-0 flex-1 px-4 py-5 sm:px-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto min-w-0 truncate text-lg font-semibold tracking-tight">{title}</h2>
          <NativeSelect className="w-full lg:hidden" aria-label="Show leads from" value={scopeValue} onChange={(v) => navigate(`/app/crm/leads${v ? `?${v}` : ""}`)} options={scopeOptions} />
          {flow && can.write && (
            <>
              <Button size="sm" icon={<Pencil size={13} />} onClick={() => setFlowDialog(flow)}>
                Edit Salesflow
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Delete Salesflow" onClick={() => removeFlow(flow)}>
                <Trash2 size={14} />
              </Button>
            </>
          )}
          {!flowId && can.write && (
            <Button size="sm" className="lg:hidden" icon={<ListPlus size={14} />} onClick={() => setNewList(true)}>
              New list
            </Button>
          )}
        </div>
        {flowId ? (
          flow ? (
            <FlowLeads key={flow.id} flow={flow} />
          ) : flows.isLoading ? (
            <SkeletonRows rows={6} />
          ) : flows.isError ? (
            <ErrorState title="This Salesflow couldn't be loaded" error={flows.error} onRetry={() => flows.refetch()} />
          ) : (
            <EmptyState title="Salesflow not found" description="It may have been deleted." action={<Button onClick={() => navigate("/app/crm/leads")}>Show all leads</Button>} />
          )
        ) : (
          <LeadsTable key={`${listId}:${campaignId}`} listId={listId ?? undefined} campaignId={campaignId ?? undefined} />
        )}
      </div>

      <Dialog
        open={newList}
        onOpenChange={setNewList}
        size="sm"
        title="Create new list"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewList(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={createList}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          {(id) => <Input id={id} autoFocus value={listName} maxLength={200} onChange={(e) => setListName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createList()} placeholder="Enter the name of the list" />}
        </Field>
      </Dialog>
      <FlowDialog
        open={flowDialog !== null}
        onOpenChange={(v) => !v && setFlowDialog(null)}
        flow={flowDialog === "new" ? null : flowDialog}
        onSaved={(f) => navigate(`/app/crm/leads?flowId=${f.id}`)}
      />
    </div>
  );
}
