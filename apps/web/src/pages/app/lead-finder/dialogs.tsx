import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Database, Download, ExternalLink, Linkedin, MapPin, Newspaper, Phone, Upload, Users } from "lucide-react";
import { CREDIT_COSTS } from "@reachstack/shared";
import { api, del, errorMessage, get, post } from "@/lib/api";
import { compact as compactNum, dateOnly, num, plural } from "@/lib/format";
import { useJob, waitForJob, type Job } from "@/lib/jobs";
import { useCan } from "@/lib/session";
import type { LeadList } from "@/lib/types";
import { useCampaignNames } from "@/lib/pickers";
import { Badge, Button, Callout, Dialog, Field, Input, NumberInput, Progress, Segmented, Select, Sheet, Skeleton, Switch } from "@/components/ui";
import { compact, humanize, type Filters } from "./filters";
import { useLeadFinderCredits } from "./shared";

// ---------- Add to list / campaign ----------

interface ImportResult {
  found: number;
  imported: number;
  duplicates: number;
  credits_used: number;
  stop_reason: string | null;
}

export function AddLeadsDialog({ open, onOpenChange, filters, total }: { open: boolean; onOpenChange: (v: boolean) => void; filters: Filters; total: number }) {
  const qc = useQueryClient();
  const [dest, setDest] = useState<"new_list" | "list" | "campaign">("new_list");
  const [listName, setListName] = useState("");
  const [listId, setListId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [limit, setLimit] = useState<number | null>(100);
  const [findEmails, setFindEmails] = useState(true);
  const [verify, setVerify] = useState(false);
  const [profile, setProfile] = useState(false);
  const [skipNoEmail, setSkipNoEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; type: "list" | "campaign"; name: string } | null>(null);
  const job = useJob<ImportResult>(jobId);
  const unlimited = !!useLeadFinderCredits().data?.unlimited;
  // Every list, with how many leads each has.
  const lists = useQuery({ queryKey: ["lead-lists", "overview"], queryFn: () => get<{ items: LeadList[] }>("/api/app/lead-lists/overview"), enabled: open });
  const campaigns = useCampaignNames(open);

  useEffect(() => {
    if (!open) return;
    setJobId(null);
    setTarget(null);
    setLimit(Math.min(100, Math.max(1, total)));
    setListName("");
  }, [open, total]);

  const n = Math.max(1, Math.min(limit ?? 1, total, 50_000));
  const perLead = CREDIT_COSTS.lead_finder_unlock + (dest === "campaign" || findEmails ? CREDIT_COSTS.work_email_enrichment : 0) + (verify ? CREDIT_COSTS.email_verification : 0) + (profile ? CREDIT_COSTS.fully_enriched_profile : 0);
  const run = async () => {
    setBusy(true);
    try {
      const resource_id = dest === "list" ? listId : dest === "campaign" ? campaignId : undefined;
      if (dest !== "new_list" && !resource_id) throw new Error(dest === "list" ? "Choose a list" : "Choose a campaign");
      const r = await post<{ resource_id: string; resource_type: number; list_name: string; background_job_id: string }>("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", {
        search_filters: compact(filters),
        limit: n,
        resource_id,
        list_name: dest === "new_list" ? listName.trim() || undefined : undefined,
        // Campaign imports always reveal the address; lists can hold people until their email is looked up.
        work_email_enrichment: dest !== "campaign" && findEmails,
        email_verification: verify,
        fully_enriched_profile: profile,
        skip_rows_without_email: dest !== "campaign" ? skipNoEmail : undefined,
      });
      setTarget({ id: r.resource_id, type: r.resource_type === 1 ? "campaign" : "list", name: r.list_name });
      setJobId(r.background_job_id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const done = job.data && ["success", "failed", "cancelled"].includes(job.data.status);
  useEffect(() => {
    if (done) {
      qc.invalidateQueries({ queryKey: ["lead-lists"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead-finder", "search"] });
      qc.invalidateQueries({ queryKey: ["lead-finder", "credits"] });
    }
  }, [done, qc]);
  const res = job.data?.result;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add leads"
      description={`${total === 1 ? "1 person matches" : `${num(total)} people match`} this search.`}
      footer={
        jobId ? (
          <>
            {done && target && (
              <Link to={target.type === "campaign" ? `/app/campaign/${target.id}/leads` : `/app/lead-finder/leads?list=${target.id}`} className="mr-auto text-[13px] font-medium text-brand-text hover:underline">
                Open {target.type === "campaign" ? "campaign" : "list"}
              </Link>
            )}
            <Button variant={done ? "primary" : "secondary"} onClick={() => onOpenChange(false)}>
              {done ? "Done" : "Close (keeps running)"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={run} disabled={!total}>
              Add {plural(n, "lead")}
            </Button>
          </>
        )
      }
    >
      {jobId ? (
        <div className="space-y-3 text-[13px]">
          {!done ? (
            <>
              <p>
                Adding leads to <span className="font-medium">{target?.name}</span>…
              </p>
              <Progress value={job.data?.progress ?? 0} />
            </>
          ) : job.data?.status === "success" && res ? (
            <>
              <p>
                Added <span className="font-semibold">{plural(res.imported, "lead")}</span> to <span className="font-medium">{target?.name}</span>.
              </p>
              <ul className="space-y-1 text-muted">
                {res.duplicates > 0 && <li>{plural(res.duplicates, "lead")} skipped: already there, invalid, blocked, unsubscribed or bounced.</li>}
                {!unlimited && <li>{res.credits_used ? `${plural(res.credits_used, "credit")} used.` : "No credits used."}</li>}
              </ul>
              {res.stop_reason === "OUT_OF_CREDITS" && <Callout tone="warn">You ran out of credits before every lead was added.</Callout>}
              {res.stop_reason === "CONTACT_LIMIT" && <Callout tone="warn">Your plan's contact limit was reached before every lead was added.</Callout>}
            </>
          ) : (
            <Callout tone="bad">{job.data?.error ?? "The import didn't finish."}</Callout>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Segmented
            value={dest}
            onChange={setDest}
            options={[
              { value: "new_list", label: "New list" },
              { value: "list", label: "Existing list" },
              { value: "campaign", label: "Campaign" },
            ]}
          />
          {dest === "new_list" && <Field label="List name" optional>{(id) => <Input id={id} value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Named after your search if left empty" />}</Field>}
          {dest === "list" && (
            <Field label="List">
              {(id) => <Select id={id} value={listId} onChange={setListId} placeholder={lists.isLoading ? "Loading…" : "Choose a list"} options={(lists.data?.items ?? []).map((l) => ({ value: l.id, label: l.name, hint: l.lead_count !== undefined ? plural(l.lead_count, "lead") : undefined }))} />}
            </Field>
          )}
          {dest === "campaign" && (
            <Field label="Campaign" hint="Leads go straight into the campaign with their work email revealed.">
              {(id) => <Select id={id} value={campaignId} onChange={setCampaignId} placeholder={campaigns.isLoading ? "Loading…" : "Choose a campaign"} options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
            </Field>
          )}
          <Field label="How many leads" hint={`Up to ${num(Math.min(total, 50_000))}. The best-matching people are added first.`}>
            {(id) => <NumberInput id={id} value={limit} onChange={setLimit} min={1} max={Math.min(total, 50_000)} className="w-40" />}
          </Field>
          <div className="space-y-2.5 rounded-lg border border-line p-3 text-[13px]">
            {dest !== "campaign" && (
              <label className="flex items-center justify-between gap-3">
                <span>
                  Find work emails
                  <span className="block text-xs text-muted">Looks up each person's work address after they're added.</span>
                </span>
                <Switch checked={findEmails} onChange={setFindEmails} aria-label="Find work emails" />
              </label>
            )}
            <label className="flex items-center justify-between gap-3">
              <span>
                Verify emails
                <span className="block text-xs text-muted">{dest === "campaign" ? "Leads get their first email only after their address checks out." : "Checks each address once it's known."}</span>
              </span>
              <Switch checked={verify} onChange={setVerify} aria-label="Verify emails" />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>
                Full profile
                <span className="block text-xs text-muted">Adds phone, LinkedIn and company details.</span>
              </span>
              <Switch checked={profile} onChange={setProfile} aria-label="Full profile" />
            </label>
            {dest !== "campaign" && (
              <label className="flex items-center justify-between gap-3">
                <span>
                  Skip people without an email address
                  <span className="block text-xs text-muted">{findEmails ? "People the lookup finds no address for are removed from the list." : "Only people with a known address are added."}</span>
                </span>
                <Switch checked={skipNoEmail} onChange={setSkipNoEmail} aria-label="Skip people without an email address" />
              </label>
            )}
          </div>
          {!unlimited && (
            <p className="text-xs text-muted">
              Up to {plural(Math.ceil(n * perLead), "credit")} ({perLead} per lead). People you already revealed aren't charged again.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------- Export ----------

export function ExportDialog({ open, onOpenChange, filters, total, personIds }: { open: boolean; onOpenChange: (v: boolean) => void; filters: Filters; total: number; personIds?: string[] }) {
  const qc = useQueryClient();
  const [limit, setLimit] = useState<number | null>(100);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const unlimited = !!useLeadFinderCredits().data?.unlimited;
  useEffect(() => {
    if (open) {
      setLimit(Math.min(100, Math.max(1, personIds?.length || total)));
      setProgress(null);
    }
  }, [open, total, personIds?.length]);
  const count = personIds?.length ? personIds.length : Math.max(1, Math.min(limit ?? 1, total, 10_000));
  const run = async () => {
    setBusy(true);
    setProgress(0);
    try {
      const job = await post<Job>("/api/app/lead-finder/export", personIds?.length ? { person_ids: personIds } : { filters: compact(filters), limit: count });
      const done = await waitForJob<{ count: number; credits_used: number; out_of_credits: boolean }>(job.id, setProgress);
      if (done.status !== "success") throw new Error(done.error ?? "The export failed");
      const exports = await get<Array<{ id: string; job_id: string | null }>>("/api/app/lead-finder/exports");
      const row = exports.find((e) => e.job_id === job.id);
      if (row) window.location.href = `/api/app/lead-finder/exports/${row.id}/download`;
      toast.success(`Exported ${plural(done.result?.count ?? 0, "lead")}${done.result?.credits_used ? ` · ${plural(done.result.credits_used, "credit")}` : ""}`);
      if (done.result?.out_of_credits) toast.warning("You ran out of credits, so the file has fewer leads than requested.");
      qc.invalidateQueries({ queryKey: ["lead-finder"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Export to CSV"
      description={unlimited ? "Saves the people, with their emails, to a CSV file." : "Exported people are revealed, which uses credits for anyone you haven't revealed before."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" icon={<Download size={14} />} loading={busy} onClick={run}>
            Export {plural(count, "lead")}
          </Button>
        </>
      }
    >
      {personIds?.length ? (
        <p className="text-[13px]">Exports the {plural(personIds.length, "person", "people")} you selected.</p>
      ) : (
        <Field label="How many leads" hint={`Up to ${num(Math.min(total, 10_000))} per file.`}>
          {(id) => <NumberInput id={id} value={limit} onChange={setLimit} min={1} max={Math.min(total, 10_000)} className="w-40" />}
        </Field>
      )}
      {progress !== null && <Progress className="mt-3" value={progress} />}
    </Dialog>
  );
}

// ---------- Save search ----------

export function SaveSearchDialog({ open, onOpenChange, filters, existing }: { open: boolean; onOpenChange: (v: boolean) => void; filters: Filters; existing?: { id: string; name: string } | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(existing?.name ?? "");
  }, [open, existing]);
  const save = async (asNew: boolean) => {
    setBusy(true);
    try {
      if (existing && !asNew) await api(`/api/v2/supersearch-enrichment/saved-searches/${existing.id}`, { method: "PATCH", body: { name: name.trim(), search_filters: compact(filters) } });
      else await post("/api/v2/supersearch-enrichment/saved-searches", { name: name.trim(), search_filters: compact(filters) });
      qc.invalidateQueries({ queryKey: ["lead-finder", "saved"] });
      toast.success(existing && !asNew ? "Search updated" : "Search saved");
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
      size="sm"
      title={existing ? "Update saved search" : "Save search"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          {existing && (
            <Button disabled={!name.trim()} loading={busy} onClick={() => save(true)}>
              Save as new
            </Button>
          )}
          <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => save(false)}>
            {existing ? "Update" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Search name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. US sales leaders, 50–250 people" maxLength={200} />}</Field>
    </Dialog>
  );
}

// ---------- Company drawer ----------

interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  sub_industry: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  founded_year: number | null;
  location: string;
  description: string | null;
  keywords: string | null;
  technologies: string[];
  funding: { stage?: string; amount?: number; date?: string } | null;
  linkedin_url: string | null;
  phone: string | null;
  news: Array<{ type?: string; title?: string; date?: string; url?: string }>;
  job_postings: Array<{ title?: string; location?: string; date?: string; url?: string }>;
  people_count: number;
}

export function CompanySheet({ companyId, onClose, onFindPeople, onLookalike }: { companyId: string | null; onClose: () => void; onFindPeople: (name: string, domain: string | null) => void; onLookalike: (domain: string) => void }) {
  const q = useQuery({ queryKey: ["lead-finder", "company", companyId], queryFn: () => get<Company>(`/api/app/lead-finder/companies/${companyId}`), enabled: !!companyId });
  const c = q.data;
  const [tab, setTab] = useState<"overview" | "news" | "jobs">("overview");
  useEffect(() => setTab("overview"), [companyId]);
  return (
    <Sheet open={!!companyId} onOpenChange={(v) => !v && onClose()} title={c?.name ?? "Company"} description={c?.domain ?? undefined}>
      {!c ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-5 p-5 text-[13px]">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<Users size={14} />} onClick={() => onFindPeople(c.name, c.domain)}>
              Find people here ({num(c.people_count)})
            </Button>
            {c.domain && (
              <Button size="sm" icon={<Building2 size={14} />} onClick={() => onLookalike(c.domain!)}>
                Find similar companies
              </Button>
            )}
          </div>
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "news", label: `News (${c.news.length})` },
              { value: "jobs", label: `Jobs (${c.job_postings.length})` },
            ]}
          />
          {tab === "overview" && (
            <div className="space-y-4">
              {c.description && <p className="leading-relaxed text-muted">{c.description}</p>}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {[
                  ["Industry", [c.industry, c.sub_industry].filter(Boolean).join(" · ")],
                  ["Employees", c.employee_count ? num(c.employee_count) : null],
                  ["Revenue", c.revenue_range],
                  ["Founded", c.founded_year],
                  ["Headquarters", c.location],
                  ["Funding", c.funding?.stage ? `${humanize(c.funding.stage)}${c.funding.amount ? ` · $${compactNum(c.funding.amount)}` : ""}` : null],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="mt-0.5">{v || <span className="text-faint">Not available</span>}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-3 text-xs">
                {c.domain && (
                  <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                    <ExternalLink size={12} /> {c.domain}
                  </a>
                )}
                {c.linkedin_url && (
                  <a href={c.linkedin_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                    <Linkedin size={12} /> LinkedIn
                  </a>
                )}
                {c.phone && (
                  <span className="inline-flex items-center gap-1 text-muted">
                    <Phone size={12} /> {c.phone}
                  </span>
                )}
              </div>
              {!!c.technologies.length && (
                <div>
                  <p className="mb-1.5 text-xs text-muted">Technologies</p>
                  <div className="flex flex-wrap gap-1.5">
                    {c.technologies.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {c.keywords && (
                <div>
                  <p className="mb-1.5 text-xs text-muted">Keywords</p>
                  <p className="text-muted">{c.keywords}</p>
                </div>
              )}
            </div>
          )}
          {tab === "news" &&
            (c.news.length ? (
              <ul className="space-y-3">
                {c.news.map((n, i) => (
                  <li key={i} className="flex gap-3">
                    <Newspaper size={14} className="mt-0.5 shrink-0 text-faint" />
                    <div className="min-w-0">
                      <p>{n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{n.title}</a> : n.title}</p>
                      <p className="text-xs text-muted">
                        {n.type ? humanize(n.type) : ""} {n.date ? `· ${dateOnly(n.date)}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No news on record for this company.</p>
            ))}
          {tab === "jobs" &&
            (c.job_postings.length ? (
              <ul className="space-y-3">
                {c.job_postings.map((j, i) => (
                  <li key={i} className="flex gap-3">
                    <Users size={14} className="mt-0.5 shrink-0 text-faint" />
                    <div className="min-w-0">
                      <p>{j.url ? <a href={j.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{j.title}</a> : j.title}</p>
                      <p className="flex items-center gap-1 text-xs text-muted">
                        {j.location && (
                          <>
                            <MapPin size={11} /> {j.location}
                          </>
                        )}
                        {j.date ? ` · ${dateOnly(j.date)}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No open roles on record.</p>
            ))}
        </div>
      )}
    </Sheet>
  );
}

// ---------- Data source ----------

interface DatasetStats {
  shared: { companies: number; people: number; demo_companies: number };
  workspace: { companies: number; people: number };
  instance_admin: boolean;
}

export function DataSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const stats = useQuery({ queryKey: ["lead-finder", "dataset"], queryFn: () => get<DatasetStats>("/api/app/lead-finder/dataset"), enabled: open });
  const file = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<"workspace" | "shared">("workspace");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["lead-finder"] });
  };
  const runJob = async (label: string, start: () => Promise<Job>) => {
    setBusy(label);
    setProgress(0);
    try {
      const job = await start();
      const done = await waitForJob<Record<string, unknown>>(job.id, setProgress);
      if (done.status !== "success") throw new Error(done.error ?? "The job failed");
      toast.success(label === "import" ? "Import finished" : "Demo data loaded");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setProgress(null);
      if (file.current) file.current.value = "";
    }
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("scope", scope);
    fd.append("file", f, f.name);
    void runJob("import", () => api<Job>("/api/app/lead-finder/dataset/import", { method: "POST", body: fd }));
  };
  const s = stats.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Where the people come from" description="Lead Finder searches the people and companies stored on this server." size="md">
      <div className="space-y-4 text-[13px]">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line p-3">
            <p className="text-xs text-muted">Shared with every workspace</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{s ? num(s.shared.people) : "–"} people</p>
            <p className="text-xs text-muted">
              {s ? num(s.shared.companies) : "–"} companies{s?.shared.demo_companies ? ` · ${num(s.shared.demo_companies)} are fictional demo data` : ""}
            </p>
          </div>
          <div className="rounded-lg border border-line p-3">
            <p className="text-xs text-muted">This workspace only</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{s ? num(s.workspace.people) : "–"} people</p>
            <p className="text-xs text-muted">{s ? num(s.workspace.companies) : "–"} companies</p>
          </div>
        </div>
        {s && s.shared.demo_companies > 0 && <Callout tone="info">The demo data uses made-up people at made-up companies (.test domains). Emails sent to them go nowhere real.</Callout>}
        {can.admin && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="font-medium">Import your own data</p>
            <p className="text-xs text-muted">
              A CSV with one person per row. Useful columns: first_name, last_name, email, title, seniority, department, company_name, company_domain, industry, employee_count, city, state, country, linkedin_url.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {s?.instance_admin && (
                <Segmented
                  size="sm"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "workspace", label: "This workspace" },
                    { value: "shared", label: "All workspaces" },
                  ]}
                />
              )}
              <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
              <Button size="sm" icon={<Upload size={13} />} loading={busy === "import"} disabled={!!busy} onClick={() => file.current?.click()}>
                Upload CSV
              </Button>
            </div>
          </div>
        )}
        {can.admin && (
          <div className="flex flex-wrap items-center gap-2">
            {s?.instance_admin && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Database size={13} />}
              loading={busy === "demo"}
              disabled={!!busy}
              onClick={() => runJob("demo", () => post<Job>("/api/app/admin/lead-finder/demo-dataset", { companies: 1500 }))}
            >
              Load demo data
            </Button>
            )}
            {!!s?.workspace.people && (
              <Button
                size="sm"
                variant="ghost"
                className="text-bad"
                disabled={!!busy}
                onClick={async () => {
                  try {
                    await del("/api/app/lead-finder/dataset");
                    toast.success("Workspace data removed");
                    refresh();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Remove this workspace's data
              </Button>
            )}
          </div>
        )}
        {progress !== null && <Progress value={progress} />}
      </div>
    </Dialog>
  );
}
