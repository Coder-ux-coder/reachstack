// Website visitor dialogs: tracking filters (views), adding best contacts to a campaign or list, and a view's
// delivery history.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Search, Send, X } from "lucide-react";
import { toast } from "sonner";
import { EMPLOYEE_BANDS, INDUSTRIES, LF_DEPARTMENTS, REVENUE_BANDS } from "@reachstack/shared";
import { errorMessage, get, patch, post, type Page } from "@/lib/api";
import type { Campaign, LeadList } from "@/lib/types";
import { cn } from "@/lib/cn";
import { ago, num, plural } from "@/lib/format";
import { Badge, Button, Callout, Checkbox, Dialog, Field, Input, NumberInput, Popover, Segmented, Select, Sheet, SkeletonRows, Switch, TagInput } from "@/components/ui";
import { useIntegrations } from "@/pages/app/agents/shared";
import { contactName, invalidateVisitors, type Contact, type ViewDestinations, type ViewFilters, type VisitorSite, type VisitorView } from "./api";

export const SENIORITIES = ["C-Level", "Owner", "VP-Level", "Director-Level", "Manager-Level", "Senior", "Staff", "Entry level"];
export const EMPLOYEE_OPTIONS = Object.keys(EMPLOYEE_BANDS);

/** Compact multi-select: a field-like button that opens a searchable checklist. */
export function MultiPick({
  options,
  value,
  onChange,
  placeholder = "Any",
  searchable,
  id,
  "aria-label": ariaLabel,
}: {
  options: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  searchable?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const [q, setQ] = useState("");
  const shown = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <Popover
      className="w-72 p-2"
      trigger={
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-panel px-3 text-left text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        >
          <span className={cn("truncate", !value.length && "text-faint")}>{value.length ? value.join(", ") : placeholder}</span>
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      }
    >
      {searchable && <Input inputSize="sm" className="mb-1.5" leading={<Search size={13} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search options" />}
      <div className="scroll-thin max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} type="button" onClick={() => toggle(o)} aria-pressed={on} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-panel-2">
              <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={11} strokeWidth={3} />}</span>
              <span className="truncate">{o}</span>
            </button>
          );
        })}
        {!shown.length && <p className="px-1.5 py-1 text-xs text-muted">Nothing matches.</p>}
      </div>
      {value.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="mt-1.5 flex items-center gap-1 px-1.5 text-xs font-medium text-muted hover:text-text">
          <X size={12} /> Clear
        </button>
      )}
    </Popover>
  );
}

function useTargets(open: boolean) {
  const lists = useQuery({ queryKey: ["lead-lists", "all"], queryFn: () => get<Page<LeadList>>("/api/v2/lead-lists", { limit: 100 }), enabled: open });
  const campaigns = useQuery({ queryKey: ["campaigns", "picker"], queryFn: () => get<Page<Campaign>>("/api/v2/campaigns", { limit: 100 }), enabled: open });
  return { lists: lists.data?.items ?? [], campaigns: campaigns.data?.items ?? [] };
}

type Target = "none" | "campaign" | "list";

// ---------- Tracking filter (view) editor ----------

const EMPTY_FILTERS: ViewFilters = {};

function filterCount(f: ViewFilters) {
  return Object.values(f).filter((v) => (Array.isArray(v) ? v.length > 0 : !!v)).length;
}

export function ViewDialog({ open, onOpenChange, view, sites }: { open: boolean; onOpenChange: (v: boolean) => void; view: VisitorView | null; sites: VisitorSite[] }) {
  const qc = useQueryClient();
  const integrations = useIntegrations();
  const slack = (integrations.data?.items ?? []).filter((i) => i.type === "slack");
  const { lists, campaigns } = useTargets(open);
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [dest, setDest] = useState<ViewDestinations>({});
  const [target, setTarget] = useState<Target>("none");
  const [enabled, setEnabled] = useState(true);
  const [showFilters, setShowFilters] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(view?.name ?? "");
    setSiteId(view?.site_id ?? "");
    setFilters(view?.filters ?? EMPTY_FILTERS);
    setDest(view?.destinations ?? {});
    setTarget(view?.destinations.campaign_id ? "campaign" : view?.destinations.list_id ? "list" : "none");
    setEnabled(view?.enabled ?? true);
    setShowFilters(!view || filterCount(view.filters) > 0);
    setError(null);
  }, [open, view]);

  const set = (patch: Partial<ViewFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const destinations = (): ViewDestinations => ({
    slack_connection_id: dest.slack_connection_id || null,
    webhook_url: dest.webhook_url?.trim() || null,
    campaign_id: target === "campaign" ? dest.campaign_id || null : null,
    list_id: target === "list" ? dest.list_id || null : null,
    verify: target !== "none" && !!dest.verify,
    check_duplicates: target !== "none" && !!dest.check_duplicates,
  });

  const save = async () => {
    const d = destinations();
    if (!name.trim()) return setError("Give the view a name.");
    if (target !== "none" && !d.campaign_id && !d.list_id) return setError(target === "campaign" ? "Choose a campaign." : "Choose a list.");
    if (!d.slack_connection_id && !d.webhook_url && !d.campaign_id && !d.list_id) return setError("Choose at least one destination: a Slack channel, a campaign or list, or a webhook URL.");
    setBusy("save");
    setError(null);
    try {
      const payload = { name: name.trim(), site_id: siteId || null, filters, destinations: d, enabled };
      if (view) await patch(`/api/app/website-visitors/views/${view.id}`, payload);
      else await post("/api/app/website-visitors/views", payload);
      await invalidateVisitors(qc);
      toast.success(view ? "View updated" : "View created");
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await post<{ results: Record<string, { ok: boolean; detail: string | null }> }>("/api/app/website-visitors/views/test", { name: name.trim() || "Test view", destinations: destinations() });
      const failed = Object.entries(r.results).filter(([, v]) => !v.ok);
      if (failed.length) toast.error(failed.map(([k, v]) => `${k === "slack" ? "Slack" : "Webhook"}: ${v.detail ?? "failed"}`).join(" · "));
      else toast.success("Test alert sent");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const canTest = !!dest.slack_connection_id || !!dest.webhook_url?.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={view ? "Edit view" : "New view"}
      description="Visitors that match get sent where you choose, once per company per day."
      footer={
        <>
          {canTest && (
            <Button variant="ghost" className="mr-auto" icon={<Send size={14} />} loading={busy === "test"} onClick={() => void test()}>
              Send test alert
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy === "save"} onClick={() => void save()}>
            {view ? "Save view" : "Create view"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pricing page visitors" autoFocus maxLength={100} />}</Field>
          {sites.length > 1 && (
            <Field label="Domain">
              {(id) => (
                <Select
                  id={id}
                  className="sm:w-52"
                  value={siteId}
                  onChange={setSiteId}
                  options={[{ value: "", label: "All domains" }, ...sites.map((s) => ({ value: s.id, label: s.domain }))]}
                />
              )}
            </Field>
          )}
        </div>

        <div>
          <button type="button" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} className="flex items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline">
            <ChevronDown size={14} className={cn("transition-transform", showFilters && "rotate-180")} />
            {showFilters ? "Hide filters" : "Show filters"}
            {filterCount(filters) > 0 && <Badge tone="brand">{filterCount(filters)}</Badge>}
          </button>
          {showFilters && (
            <div className="mt-3 grid gap-4 rounded-lg border border-line p-4 sm:grid-cols-2">
              <Field label="Primary industry">{(id) => <MultiPick id={id} options={INDUSTRIES} value={filters.industries ?? []} onChange={(v) => set({ industries: v })} searchable />}</Field>
              <Field label="Employees">{(id) => <MultiPick id={id} options={EMPLOYEE_OPTIONS} value={filters.employees ?? []} onChange={(v) => set({ employees: v })} />}</Field>
              <Field label="Revenue">{(id) => <MultiPick id={id} options={REVENUE_BANDS} value={filters.revenue ?? []} onChange={(v) => set({ revenue: v })} />}</Field>
              <Field label="Company country">{(id) => <TagInput id={id} value={filters.countries ?? []} onChange={(v) => set({ countries: v })} placeholder="United States, Germany" />}</Field>
              <Field label="Seniority level" hint="The best contact is picked from these levels.">
                {(id) => <MultiPick id={id} options={SENIORITIES} value={filters.seniority ?? []} onChange={(v) => set({ seniority: v })} />}
              </Field>
              <Field label="Department">{(id) => <MultiPick id={id} options={LF_DEPARTMENTS} value={filters.departments ?? []} onChange={(v) => set({ departments: v })} />}</Field>
              <Field label="Page URL contains" hint="Any page of the visit.">
                {(id) => <TagInput id={id} value={filters.url_contains ?? []} onChange={(v) => set({ url_contains: v })} placeholder="/pricing, /demo" />}
              </Field>
              <Field label="Referrer contains" hint="Where the visit came from, or its utm_source.">
                {(id) => <TagInput id={id} value={filters.referrer_contains ?? []} onChange={(v) => set({ referrer_contains: v })} placeholder="google, linkedin" />}
              </Field>
              <Checkbox className="sm:col-span-2" checked={!!filters.icp_only} onChange={(v) => set({ icp_only: v })} label="Only companies that fit the ideal customer profile set on the Setup page" />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-[13px] font-semibold">Destinations</h3>
          <Field label="Send Slack notifications to" optional hint={slack.length ? undefined : "No Slack channel is connected yet."}>
            {(id) =>
              slack.length ? (
                <Select
                  id={id}
                  value={dest.slack_connection_id ?? ""}
                  onChange={(v) => setDest({ ...dest, slack_connection_id: v || null })}
                  options={[{ value: "", label: "Don't notify Slack" }, ...slack.map((s) => ({ value: s.id, label: s.name }))]}
                />
              ) : (
                <Link to="/app/settings/integrations" className="text-[13px] font-medium text-brand-text hover:underline">
                  Connect Slack in Settings → Integrations & API → Apps
                </Link>
              )
            }
          </Field>

          <div>
            <p className="mb-1.5 text-[13px] font-medium">Automatically add the best contact at each matching company to</p>
            <Segmented
              value={target}
              onChange={setTarget}
              options={[
                { value: "none", label: "Nothing" },
                { value: "campaign", label: "A campaign" },
                { value: "list", label: "A list" },
              ]}
            />
            {target !== "none" && (
              <div className="mt-3 space-y-2.5">
                <Select
                  aria-label={target === "campaign" ? "Campaign" : "List"}
                  value={(target === "campaign" ? dest.campaign_id : dest.list_id) ?? ""}
                  onChange={(v) => setDest({ ...dest, campaign_id: target === "campaign" ? v : null, list_id: target === "list" ? v : null })}
                  placeholder={target === "campaign" ? "Select the campaign to add leads to" : "Select the list to add leads to"}
                  options={(target === "campaign" ? campaigns : lists).map((x) => ({ value: x.id, label: x.name }))}
                />
                <Checkbox checked={!!dest.verify} onChange={(v) => setDest({ ...dest, verify: v })} label={`Verify emails before adding to the ${target}`} />
                <Checkbox
                  checked={!!dest.check_duplicates}
                  onChange={(v) => setDest({ ...dest, check_duplicates: v })}
                  label={target === "campaign" ? "Skip people already in any campaign" : "Skip people already in any list"}
                />
              </div>
            )}
          </div>

          <Field label="Webhook URL" optional hint="Each match is POSTed as JSON (event_type website_visitor.identified).">
            {(id) => <Input id={id} value={dest.webhook_url ?? ""} onChange={(e) => setDest({ ...dest, webhook_url: e.target.value })} placeholder="https://example.com/hooks/visitors" inputMode="url" />}
          </Field>
        </div>

        {view && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium">{enabled ? "Active" : "Paused"}</p>
              <p className="text-xs text-muted">Paused views keep their filters but send nothing.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} aria-label="View active" />
          </div>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Dialog>
  );
}

// ---------- Add best contacts to a campaign or list ----------

export interface AddRequest {
  /** Shown in the description, e.g. "3 companies" or "Hiroshi Schmidt". */
  label: string;
  domains?: string[];
  person_ids?: string[];
  all?: Record<string, unknown>;
  target?: "campaign" | "list";
}

interface AddResult {
  companies: number;
  without_contact: number;
  without_email: number;
  revealed: number;
  credits_used: number;
  out_of_credits: boolean;
  leads_uploaded: number;
  duplicated_leads: number;
  in_blocklist: number;
}

export function AddLeadsDialog({ request, onClose, selfHosted }: { request: AddRequest | null; onClose: () => void; selfHosted: boolean }) {
  const qc = useQueryClient();
  const open = !!request;
  const { lists, campaigns } = useTargets(open);
  const [target, setTarget] = useState<"campaign" | "list">("campaign");
  const [id, setId] = useState("");
  const [perCompany, setPerCompany] = useState<number | null>(1);
  const [verify, setVerify] = useState(false);
  const [dupes, setDupes] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setId("");
      setPerCompany(1);
      setTarget(request?.target ?? "campaign");
    }
  }, [open, request?.target]);
  const people = !!request?.person_ids?.length;
  const run = async () => {
    if (!request) return;
    if (!id) return toast.error(target === "campaign" ? "Please select a campaign" : "Please select a list");
    setBusy(true);
    try {
      const r = await post<AddResult>("/api/app/website-visitors/add-leads", {
        domains: request.domains,
        person_ids: request.person_ids,
        all: request.all,
        campaign_id: target === "campaign" ? id : undefined,
        list_id: target === "list" ? id : undefined,
        per_company: people ? undefined : Math.min(5, Math.max(1, perCompany ?? 1)),
        verify,
        check_duplicates: dupes,
      });
      const notes = [
        r.duplicated_leads ? `${num(r.duplicated_leads)} already there` : null,
        r.without_contact ? `${plural(r.without_contact, "company", "companies")} without contacts in your data` : null,
        r.without_email ? `${num(r.without_email)} without an email address` : null,
        r.in_blocklist ? `${num(r.in_blocklist)} on your blocklist` : null,
        r.out_of_credits ? "out of credits" : null,
        r.credits_used ? `${plural(r.credits_used, "credit")} used` : null,
      ].filter(Boolean);
      const msg = `Added ${plural(r.leads_uploaded, "lead")} to the ${target}${notes.length ? ` (${notes.join(", ")})` : ""}`;
      if (r.leads_uploaded) toast.success(msg);
      else toast.warning(msg);
      await invalidateVisitors(qc);
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead-lists"] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={target === "campaign" ? "Add to campaign" : "Add to list"}
      description={people ? `Adds ${request?.label} as a lead.` : `Adds the best contact at ${request?.label} as leads.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            {target === "campaign" ? "Add to campaign" : "Add to list"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={target}
          onChange={(v) => {
            setTarget(v);
            setId("");
          }}
          options={[
            { value: "campaign", label: "Campaign" },
            { value: "list", label: "List" },
          ]}
        />
        <Select
          aria-label={target === "campaign" ? "Campaign" : "List"}
          value={id}
          onChange={setId}
          placeholder={target === "campaign" ? "Select a campaign" : "Select a list"}
          options={(target === "campaign" ? campaigns : lists).map((x) => ({ value: x.id, label: x.name }))}
        />
        {!people && (
          <Field label="Contacts per company" hint="The most senior people first.">
            {(fid) => <NumberInput id={fid} value={perCompany} onChange={setPerCompany} min={1} max={5} />}
          </Field>
        )}
        <Checkbox checked={verify} onChange={setVerify} label={`Verify emails before adding to the ${target}`} />
        <Checkbox checked={dupes} onChange={setDupes} label={target === "campaign" ? "Check for duplicates across all campaigns" : "Check for duplicates across all lists"} />
        <p className="text-xs text-muted">
          {selfHosted ? "Contacts' emails are revealed as they're added (free on this server)." : "Revealing a contact uses 1 credit the first time; people you've already revealed are free."}
          {target === "campaign" && " Campaigns only take people with an email address."}
        </p>
      </div>
    </Dialog>
  );
}

// ---------- Delivery history ----------

interface AlertRow {
  id: string;
  company_domain: string;
  company_name: string | null;
  contact: Contact | null;
  lead_id: string | null;
  results: Record<string, { ok: boolean; detail?: string | null }>;
  created_at: string;
}

const DEST_LABEL: Record<string, string> = { slack: "Slack", webhook: "Webhook", campaign: "Campaign", list: "List" };

export function AlertsSheet({ view, onClose }: { view: VisitorView | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["website-visitors", "alerts", view?.id],
    queryFn: () => get<{ items: AlertRow[] }>(`/api/app/website-visitors/views/${view!.id}/alerts`, { limit: 50 }),
    enabled: !!view,
  });
  const items = q.data?.items ?? [];
  const failed = useMemo(() => items.filter((a) => Object.values(a.results).some((r) => !r.ok)).length, [items]);
  return (
    <Sheet open={!!view} onOpenChange={(v) => !v && onClose()} title={view ? `${view.name}: deliveries` : ""} description={view ? `${plural(view.matches, "match", "matches")}${failed ? ` · ${failed} with a failed destination` : ""}` : undefined}>
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : !items.length ? (
        <p className="px-5 py-12 text-center text-[13px] text-muted">Nothing delivered yet. Matching visits show up here as they're identified.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li key={a.id} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-[13px] font-medium">{a.company_name ?? a.company_domain}</p>
                <span className="shrink-0 text-xs text-faint" title={a.created_at}>
                  {ago(a.created_at)}
                </span>
              </div>
              {a.contact && (
                <p className="mt-0.5 truncate text-xs text-muted">
                  {contactName(a.contact)}
                  {a.contact.title ? `, ${a.contact.title}` : ""}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {Object.entries(a.results).map(([k, r]) => (
                  <Badge key={k} tone={r.ok ? "ok" : "bad"}>
                    {DEST_LABEL[k] ?? k}: {r.ok ? "sent" : (r.detail ?? "failed")}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
