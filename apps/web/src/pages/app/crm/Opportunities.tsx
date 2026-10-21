// /app/crm/opportunities — the deal board: every lead with a positive status is a card in its status column. Drag a
// card to change the status; open it for value, recurrence, priority, owner, close date, contacts and history.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Handshake, SquarePen, UserRound } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import type { LeadLike } from "@reachstack/shared";
import { useLocation, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, errorMessage, get, patch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { calendarDay, dateOnly, money, plural } from "@/lib/format";
import { useDebounced, useLocalState, usePageTitle } from "@/lib/hooks";
import { useCan, useSession } from "@/lib/session";
import { useLeadStatuses, type StatusMeta } from "@/lib/statuses";
import { useDraft, useUnsavedChanges } from "@/lib/unsaved";
import { useCampaignNames } from "@/lib/pickers";
import { Avatar, Badge, Button, Callout, Checkbox, EmptyState, ErrorState, Field, Input, NativeSelect, NumberInput, SearchInput, Segmented, Sheet, SkeletonRows, Textarea } from "@/components/ui";
import { InterestBadge } from "@/components/status";
import { LeadSheet } from "@/components/leads/LeadSheet";
import { NewEmailDialog } from "@/components/NewEmailDialog";
import { NewMenu } from "./CrmLayout";
import { LeadTimeline, useCrmRefresh, useMembers } from "./shared";

type Recurrence = "one_time" | "monthly" | "annual";

export interface Deal {
  lead_id: string;
  lead_email: string;
  name: string | null;
  company_name: string | null;
  company_domain: string | null;
  job_title: string | null;
  phone: string | null;
  status: number;
  value: number;
  recurrence: Recurrence;
  priority: "normal" | "high";
  owner_id: string | null;
  owner_name: string | null;
  expected_close_at: string | null;
  notes: string | null;
  won_at: string | null;
  campaign: { id: string; name: string | null } | null;
  status_changed_at: string | null;
  last_activity_at: string | null;
  timestamp_created: string | null;
}

interface DealDetail extends Omit<Deal, "campaign" | "status_changed_at" | "last_activity_at" | "timestamp_created"> {
  website: string | null;
  linkedin_url: string | null;
  location: string | null;
  campaign_id: string | null;
  contacts: Array<{ lead_id: string; email: string; name: string | null; job_title: string | null; phone: string | null; status: number | null }>;
}

const RECURRENCE: Array<{ value: Recurrence; label: string }> = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annually" },
];

type SortKey = "updated" | "created" | "close" | "value";
const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Creation date" },
  { value: "close", label: "Close date" },
  { value: "value", label: "Opportunity value" },
];

const sorter = (key: SortKey) => (a: Deal, b: Deal) => {
  if (key === "value") return b.value - a.value;
  if (key === "close") return (a.expected_close_at ?? "9999").localeCompare(b.expected_close_at ?? "9999");
  if (key === "created") return (b.timestamp_created ?? "").localeCompare(a.timestamp_created ?? "");
  return (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
};

const recurrenceSuffix = (r: Recurrence) => (r === "monthly" ? "/mo" : r === "annual" ? "/yr" : "");

export default function Opportunities() {
  usePageTitle("Opportunities");
  const can = useCan();
  const me = useSession();
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const members = useMembers();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [campaign, setCampaign] = useState("");
  const [owner, setOwner] = useLocalState("crm-deals-owner", "");
  const [sort, setSort] = useLocalState<SortKey>("crm-deals-sort", "updated");
  const [showLost, setShowLost] = useLocalState("crm-deals-lost", false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [leadSheet, setLeadSheet] = useState<string | null>(null);
  const openDeal = params.get("deal");

  const campaigns = useCampaignNames();
  const filters = { search: q || undefined, campaign_id: campaign || undefined, owner: owner || undefined, include_closed: showLost || undefined };
  const key = ["crm", "deals", filters];
  const deals = useQuery({ queryKey: key, queryFn: () => get<{ items: Deal[]; total?: number }>("/api/app/crm/opportunities", filters) });
  // The board shows the 1,000 deals that changed last; it says so when there are more.
  const cut = deals.data?.total !== undefined && deals.data.total > deals.data.items.length ? deals.data.total : null;

  const columns: StatusMeta[] = useMemo(() => {
    const positive = statuses.all.filter((s) => s.sentiment === "positive");
    const lost = statuses.all.find((s) => s.code === -3);
    return showLost && lost ? [...positive, lost] : positive;
  }, [statuses.all, showLost]);
  const byStatus = useMemo(() => {
    const m = new Map<number, Deal[]>();
    for (const d of deals.data?.items ?? []) m.set(d.status, [...(m.get(d.status) ?? []), d]);
    for (const list of m.values()) list.sort(sorter(sort));
    return m;
  }, [deals.data, sort]);
  const open = (deals.data?.items ?? []).filter((d) => d.status !== -3);
  const total = open.reduce((s, d) => s + (d.value || 0), 0);

  const move = async (email: string, status: number) => {
    const deal = deals.data?.items.find((d) => d.lead_email === email);
    if (!deal || deal.status === status) return;
    const label = statuses.all.find((s) => s.code === status)?.label ?? "the new status";
    qc.setQueryData<{ items: Deal[] }>(key, (old) => old && { items: old.items.map((d) => (d.lead_email === email ? { ...d, status } : d)) });
    try {
      await patch(`/api/app/crm/opportunities/${encodeURIComponent(email)}`, { status });
      toast.success(`Moved to ${label}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      qc.invalidateQueries({ queryKey: ["crm"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    }
  };

  const setDeal = (email: string | null) =>
    setParams((p) => {
      if (email) p.set("deal", email);
      else p.delete("deal");
      return p;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3 sm:px-6">
        <SearchInput value={search} onChange={setSearch} placeholder="Search deals" className="w-full sm:w-56" />
        <NativeSelect
          size="sm"
          className="w-auto max-w-[45%] sm:max-w-56"
          value={campaign}
          onChange={setCampaign}
          aria-label="Campaign"
          options={[{ value: "", label: "All campaigns" }, ...(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
        <NativeSelect
          size="sm"
          className="w-auto max-w-[45%] sm:max-w-48"
          value={owner}
          onChange={setOwner}
          aria-label="Owner"
          options={[{ value: "", label: "All users" }, { value: "me", label: "Me" }, ...members.filter((m) => m.user_id !== me.user.id).map((m) => ({ value: m.user_id, label: m.name }))]}
        />
        <NativeSelect size="sm" className="w-auto" value={sort} onChange={(v) => setSort(v as SortKey)} aria-label="Sort cards by" options={SORTS} />
        <Checkbox checked={showLost} onChange={setShowLost} label="Show lost" />
        <p className="text-[13px] text-muted sm:ml-auto">
          {cut ? `The latest ${plural(deals.data!.items.length, "deal")} of ${cut.toLocaleString()}: ` : ""}
          {plural(open.length, "opportunity", "opportunities")} · <span className="font-medium text-text">{money(total)}</span>
        </p>
      </div>

      {deals.isLoading ? (
        <div className="p-6">
          <SkeletonRows rows={6} />
        </div>
      ) : deals.isError && !deals.data ? (
        <ErrorState className="flex-1" title="Your deals couldn't be loaded" error={deals.error} onRetry={() => deals.refetch()} />
      ) : !deals.data?.items.length && !q && !campaign && !owner ? (
        <EmptyState
          className="flex-1"
          icon={<Handshake size={22} />}
          title="You don't have any leads in your deal flow yet"
          description="Mark leads as Interested, Meeting booked, Meeting completed or Won (in the Unibox, a campaign or here) and they show up as opportunities."
        />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-max gap-3 p-4 sm:px-6">
            {columns.map((col) => {
              const list = byStatus.get(col.code) ?? [];
              const sum = list.reduce((s, d) => s + (d.value || 0), 0);
              return (
                <section
                  key={col.code}
                  aria-label={col.label}
                  onDragOver={(e) => {
                    if (!dragging || !can.write) return;
                    e.preventDefault();
                    setOver(col.code);
                  }}
                  onDragLeave={() => setOver((o) => (o === col.code ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const email = e.dataTransfer.getData("text/plain") || dragging;
                    setOver(null);
                    setDragging(null);
                    if (email) move(email, col.code);
                  }}
                  className={cn("flex h-full w-72 shrink-0 flex-col rounded-xl border bg-panel-2/60", over === col.code ? "border-brand bg-brand-soft" : "border-line")}
                >
                  <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: col.color }} />
                      <h2 className="truncate text-[13px] font-semibold">{col.label}</h2>
                      <span className="text-xs tabular-nums text-faint">{list.length}</span>
                    </div>
                    <span className="text-xs font-medium tabular-nums text-muted">{money(sum)}</span>
                  </header>
                  <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
                    {list.map((d) => (
                      <DealCard
                        key={d.lead_email}
                        deal={d}
                        draggable={can.write}
                        dragging={dragging === d.lead_email}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", d.lead_email);
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(d.lead_email);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onOpen={() => setDeal(d.lead_email)}
                      />
                    ))}
                    {!list.length && <p className="px-2 py-6 text-center text-xs text-faint">{can.write ? "Drag deals here" : "No deals"}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
      <DealSheet email={openDeal} onClose={() => setDeal(null)} onOpenLead={setLeadSheet} />
      <LeadSheet leadId={leadSheet} onClose={() => setLeadSheet(null)} onChanged={() => qc.invalidateQueries({ queryKey: ["crm"] })} />
    </div>
  );
}

function DealCard({
  deal,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  deal: Deal;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        "cursor-pointer rounded-lg border border-line bg-panel p-3 shadow-card outline-none transition hover:border-line-strong focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{deal.company_name || deal.company_domain || deal.lead_email}</p>
          <p className="truncate text-xs text-muted">{deal.name ? `${deal.name} · ${deal.lead_email}` : deal.lead_email}</p>
        </div>
        {deal.priority === "high" && <Flag size={13} className="mt-0.5 shrink-0 text-warn" aria-label="High priority" />}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium tabular-nums">
          {money(deal.value)}
          <span className="text-xs font-normal text-muted">{recurrenceSuffix(deal.recurrence)}</span>
        </span>
        <div className="flex items-center gap-1.5">
          {deal.expected_close_at && <span className="text-[11px] text-faint">Close {calendarDay(deal.expected_close_at)}</span>}
          {deal.owner_name && <Avatar name={deal.owner_name} size={20} />}
        </div>
      </div>
    </div>
  );
}

/** The deal's contact as template variables for a new email (the deal only has the full name). */
function dealLead(d: DealDetail): LeadLike {
  const [first = "", ...rest] = (d.name ?? "").trim().split(/\s+/);
  return { email: d.lead_email, first_name: first || null, last_name: rest.join(" ") || null, company_name: d.company_name, company_domain: d.company_domain, website: d.website, phone: d.phone, job_title: d.job_title };
}

/** The deal's editable fields, as the form holds them. */
function dealForm(x: DealDetail | undefined) {
  return {
    status: x?.status === null || x?.status === undefined ? "" : String(x.status),
    value: (x?.value ?? 0) as number | null,
    recurrence: x?.recurrence ?? ("one_time" as Recurrence),
    priority: x?.priority ?? ("normal" as "normal" | "high"),
    owner: x?.owner_id ?? "",
    close: x?.expected_close_at ? x.expected_close_at.slice(0, 10) : "",
    notes: x?.notes ?? "",
  };
}

function DealSheet({ email, onClose, onOpenLead }: { email: string | null; onClose: () => void; onOpenLead: (id: string) => void }) {
  const can = useCan();
  const [composing, setComposing] = useState(false);
  const me = useSession();
  const qc = useQueryClient();
  const refresh = useCrmRefresh();
  const statuses = useLeadStatuses();
  const members = useMembers(!!email);
  const q = useQuery({ queryKey: ["crm", "deal", email], queryFn: () => get<DealDetail>(`/api/app/crm/opportunities/${encodeURIComponent(email!)}`), enabled: !!email });
  const d = q.data;
  // Edits survive a reload of the deal (another tab saving, the window regaining focus); another deal starts over.
  const [form, setForm] = useDraft(dealForm(d), email ?? undefined);
  const { status, value, recurrence, priority, owner, close, notes } = form;
  const set =
    <K extends keyof typeof form>(k: K) =>
    (v: (typeof form)[K]) =>
      setForm((f) => ({ ...f, [k]: v }));
  const [setStatus, setValue, setRecurrence, setPriority, setOwner, setClose, setNotes] = [set("status"), set("value"), set("recurrence"), set("priority"), set("owner"), set("close"), set("notes")];
  const [saving, setSaving] = useState(false);

  const changes = d
    ? {
        ...(status !== String(d.status) && status !== "" ? { status: Number(status) } : {}),
        ...((value ?? 0) !== d.value ? { value: value ?? 0 } : {}),
        ...(recurrence !== d.recurrence ? { recurrence } : {}),
        ...(priority !== d.priority ? { priority } : {}),
        ...(owner !== (d.owner_id ?? "") ? { owner_id: owner || null } : {}),
        ...(close !== (d.expected_close_at?.slice(0, 10) ?? "") ? { expected_close_at: close || null } : {}),
        ...(notes.trim() !== (d.notes ?? "").trim() ? { notes: notes.trim() || null } : {}),
      }
    : {};
  const dirty = Object.keys(changes).length > 0;
  // The panel is open while the page's ?deal= names this deal: closing it (or Back) asks first.
  const { pathname } = useLocation();
  useUnsavedChanges(can.write && dirty, "Your changes to this opportunity haven't been saved yet.", (next) => next.pathname === pathname && new URLSearchParams(next.search).get("deal") === email);

  const save = async () => {
    if (!email) return;
    setSaving(true);
    try {
      await patch(`/api/app/crm/opportunities/${encodeURIComponent(email)}`, changes);
      toast.success("Opportunity updated");
      await q.refetch();
      refresh();
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const statusOptions = statuses.all.map((s) => ({ value: String(s.code), label: s.label }));
  return (
    <Sheet
      open={!!email}
      onOpenChange={(v) => !v && onClose()}
      width="max-w-2xl"
      title={d ? d.company_name || d.company_domain || d.lead_email : "Opportunity"}
      description={d ? [d.name, d.lead_email].filter(Boolean).join(" · ") : undefined}
      actions={
        d && (
          <>
            {can.perm("unibox") && can.write && (
              <>
                <Button size="icon-sm" variant="ghost" aria-label="New email" title="New email" onClick={() => setComposing(true)}>
                  <SquarePen size={15} />
                </Button>
                <NewEmailDialog open={composing} onOpenChange={setComposing} to={[d.lead_email]} lead={dealLead(d)} />
              </>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="Lead details" title="Lead details" onClick={() => onOpenLead(d.lead_id)}>
              <UserRound size={15} />
            </Button>
          </>
        )
      }
      footer={
        can.write && dirty ? (
          <>
            <Button variant="ghost" onClick={() => setForm(dealForm(d))}>
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save changes
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isError && !d ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <div className="p-5">
            <Callout tone="bad">This deal isn't available anymore: its lead may have been deleted.</Callout>
          </div>
        ) : (
          <ErrorState title="This deal couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />
        )
      ) : q.isLoading || !d ? (
        <div className="p-5">
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <div className="space-y-6 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <InterestBadge code={d.status} labels={statuses.all} />
            {d.won_at && <Badge tone="ok">Won {dateOnly(d.won_at)}</Badge>}
            {d.job_title && <span className="text-[13px] text-muted">{d.job_title}</span>}
            {can.write && (
              <div className="ml-auto">
                <NewMenu leadEmail={d.lead_email} phone={d.phone} size="xs" />
              </div>
            )}
          </div>

          <fieldset disabled={!can.write} className="grid gap-4 sm:grid-cols-2">
            <Field label="Status">{(id) => <NativeSelect id={id} value={status} onChange={setStatus} options={statusOptions} />}</Field>
            <Field label="Value">{(id) => <NumberInput id={id} value={value} onChange={setValue} min={0} step={100} suffix="USD" className="w-full" />}</Field>
            <Field label="Recurrence" className="sm:col-span-2">
              {() => <Segmented value={recurrence} onChange={setRecurrence} options={RECURRENCE} />}
            </Field>
            <Field label="Priority">
              {() => (
                <Segmented
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: "normal", label: "Normal" },
                    { value: "high", label: "High" },
                  ]}
                />
              )}
            </Field>
            <Field label="Estimated close">{(id) => <Input id={id} type="date" value={close} onChange={(e) => setClose(e.target.value)} />}</Field>
            <Field label="Owner" className="sm:col-span-2">
              {(id) => (
                <NativeSelect
                  id={id}
                  value={owner}
                  onChange={setOwner}
                  options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.user_id, label: m.user_id === me.user.id ? `${m.name} (me)` : m.name }))]}
                />
              )}
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              {(id) => <Textarea id={id} rows={3} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} placeholder="Budget, decision makers, next steps…" />}
            </Field>
          </fieldset>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-muted">Contacts at {d.company_name || d.company_domain || "this company"}</h3>
            {d.contacts.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {d.contacts.map((c) => (
                  <li key={c.lead_id} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={c.name} email={c.email} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{c.name || c.email}</p>
                      <p className="truncate text-xs text-muted">{[c.job_title, c.name ? c.email : null].filter(Boolean).join(" · ") || " "}</p>
                    </div>
                    {c.status !== null && <InterestBadge code={c.status} labels={statuses.all} />}
                    <Button size="xs" variant="ghost" onClick={() => onOpenLead(c.lead_id)}>
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">No other contacts from this company are in your leads.</p>
            )}
          </section>

          <section>
            <h3 className="mb-3 text-[13px] font-semibold text-muted">Activity</h3>
            <LeadTimeline leadEmail={d.lead_email} leadId={d.lead_id} />
          </section>
        </div>
      )}
    </Sheet>
  );
}
