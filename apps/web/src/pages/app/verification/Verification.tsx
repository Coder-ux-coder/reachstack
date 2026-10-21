import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, Outlet, useSearchParams } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Papa from "papaparse";
import { AtSign, CheckCircle2, CircleSlash, Download, FileUp, Info, ListChecks, MailCheck, ShieldCheck, Upload, XCircle } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime, money, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import type { Job } from "@/lib/jobs";
import { useCampaignNames } from "@/lib/pickers";
import { Badge, Button, Callout, Card, CardHeader, Checkbox, EmptyState, Field, Input, LinkTabs, NativeSelect, Progress, SearchInput, Segmented, SkeletonRows, Textarea, type Tone } from "@/components/ui";
import { ScrollX } from "@/components/ui/scroll-x";

type VerifyStatus = "verified" | "invalid" | "risky" | "catch_all" | "unknown" | "pending";

const STATUS: Record<VerifyStatus, { label: string; tone: Tone }> = {
  verified: { label: "Valid", tone: "ok" },
  invalid: { label: "Invalid", tone: "bad" },
  risky: { label: "Risky", tone: "warn" },
  catch_all: { label: "Catch-all", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
  pending: { label: "Checking", tone: "info" },
};

const DOMAIN_ONLY = { label: "Domain OK", tone: "info" as Tone };

const REASONS: Record<string, string> = {
  invalid_syntax: "This isn't a valid email address.",
  disposable_domain: "A throwaway inbox provider. Mail may never be read.",
  dns_lookup_failed: "The domain couldn't be looked up. Try again later.",
  no_mail_server: "The domain has no mail server, so mail will bounce.",
  mailbox_not_found: "The mail server says this mailbox doesn't exist.",
  accepts_all: "The domain accepts mail for any address, so this one can't be confirmed.",
  role_account: "A shared team address (info@, sales@ and so on). These rarely reply and complain more.",
  accepted: "The mail server confirmed the mailbox.",
  mx_found: "The domain receives mail. The mailbox itself wasn't checked because this server doesn't probe mail servers.",
  low_quality: "Deliverable, but unlikely to be a real person's main inbox.",
};

/** A "verified" result from DNS alone only means the domain takes mail: it says so instead of "Valid". */
function StatusBadge({ status, method }: { status: string; method?: VerificationRow["method"] }) {
  const s = status === "verified" && method === "dns" ? DOMAIN_ONLY : (STATUS[status as VerifyStatus] ?? STATUS.unknown);
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

interface VerificationRow {
  id: string;
  email: string;
  verification_status: VerifyStatus;
  catch_all: boolean | "pending";
  reason: string | null;
  method: "smtp" | "dns" | "sandbox" | null;
  checks: { syntax: boolean; mx: boolean | null; disposable: boolean; role: boolean; smtp: string | null } | null;
  credits_used: number;
  job_id: string | null;
  timestamp_created: string;
}

interface Results {
  items: VerificationRow[];
  stats: { total: number; verified: number; invalid: number; risky: number; catch_all: number; unknown: number };
}

interface VerifyJob {
  id: string;
  type: "verify-emails" | "verify-leads";
  name: string;
  status: Job["status"];
  progress: number;
  processed: number | null;
  total: number | null;
  result: { total?: number; processed?: number; verified?: number; invalid?: number; risky?: number; catch_all?: number; unknown?: number; cached?: number; credits_refunded?: number } | null;
  error: string | null;
  created_at: string;
}

interface CreditInfo {
  self_hosted: boolean;
  stripe_enabled: boolean;
  usage: { verification_credits: { balance?: number | null } };
  verification_packs: Array<{ id: string; credits: number; price: number }>;
}

const JOBS_KEY = ["verification-jobs"];
const RESULTS_KEY = ["verification-results"];
const CREDITS_KEY = ["billing-overview"];

function useCredits() {
  return useQuery({ queryKey: CREDITS_KEY, queryFn: () => get<CreditInfo>("/api/app/billing/overview"), staleTime: 30_000 });
}

/** "Unlimited" on self-hosted installs, otherwise the remaining balance. */
function CreditsChip() {
  const c = useCredits();
  if (!c.data) return null;
  const balance = c.data.usage.verification_credits.balance;
  return (
    <Link to="/app/verification/billing" className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-text">
      <ShieldCheck size={13} />
      {c.data.self_hosted || balance === null || balance === undefined ? "Unlimited verification" : `${num(balance)} verification credits`}
    </Link>
  );
}

/** /app/verification — shared header and tabs. */
export function VerificationLayout() {
  const can = useCan();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Email verification</h1>
          <p className="mt-1 text-[13px] text-muted">Check addresses before you send so bounces don't hurt your sender reputation.</p>
        </div>
        <CreditsChip />
      </div>
      <LinkTabs
        className="mt-5"
        tabs={[
          { to: "/app/verification/single", label: "Single" },
          { to: "/app/verification/bulk", label: "Bulk" },
          { to: "/app/verification/leads", label: "Leads", hidden: !can.write },
          { to: "/app/verification/list", label: "History" },
          { to: "/app/verification/billing", label: "Credits" },
        ]}
      />
      <div className="pt-6">
        <Outlet />
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <li className="flex items-center gap-2 text-[13px]">
      {ok === null ? <CircleSlash size={15} className="text-faint" /> : ok ? <CheckCircle2 size={15} className="text-ok" /> : <XCircle size={15} className="text-bad" />}
      <span className={ok === null ? "text-muted" : undefined}>{label}</span>
    </li>
  );
}

function ResultCard({ r }: { r: VerificationRow & { credits_used?: number } }) {
  const c = r.checks;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <MailCheck size={18} className="text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">{r.email}</span>
        <StatusBadge status={r.verification_status} method={r.method} />
      </div>
      {r.reason && <p className="mt-3 text-[13px] text-muted">{REASONS[r.reason] ?? r.reason}</p>}
      {c && (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          <Check ok={c.syntax} label="Valid format" />
          <Check ok={c.mx} label={c.mx === null ? "Mail server not checked" : "Domain receives mail"} />
          <Check ok={!c.disposable} label={c.disposable ? "Disposable provider" : "Not a disposable provider"} />
          <Check ok={!c.role} label={c.role ? "Shared team address" : "Personal address"} />
          <Check ok={r.method === "smtp" ? r.verification_status === "verified" || r.verification_status === "catch_all" : null} label={r.method === "smtp" ? "Mailbox checked with the mail server" : r.method === "sandbox" ? "Test address (no real mail server)" : "Mailbox not probed"} />
          {r.catch_all !== "pending" && <Check ok={!r.catch_all} label={r.catch_all ? "Domain accepts any address" : "Domain rejects unknown addresses"} />}
        </ul>
      )}
    </Card>
  );
}

/** /app/verification/single */
export function VerifySingle() {
  usePageTitle("Verify an email");
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerificationRow | null>(null);
  const recent = useQuery({ queryKey: [...RESULTS_KEY, "single"], queryFn: () => get<Results>("/api/app/verification/results", { single: true, limit: 10 }) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await post<{ email: string; verification_status: string; result?: VerifyStatus; reason?: string; catch_all: boolean | "pending"; method?: VerificationRow["method"]; checks?: VerificationRow["checks"]; credits_used: number }>(
        "/api/v2/email-verification",
        { email: email.trim() },
      );
      setResult({
        id: "latest",
        email: r.email,
        verification_status: r.result ?? "pending",
        catch_all: r.catch_all,
        reason: r.reason ?? null,
        method: r.method ?? null,
        checks: r.checks ?? null,
        credits_used: r.credits_used,
        job_id: null,
        timestamp_created: new Date().toISOString(),
      });
      qc.invalidateQueries({ queryKey: RESULTS_KEY });
      qc.invalidateQueries({ queryKey: CREDITS_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="name@company.com" aria-label="Email address" leading={<AtSign size={15} />} className="flex-1" autoFocus />
          <Button type="submit" variant="primary" loading={busy} disabled={!email.includes("@")}>
            Verify
          </Button>
        </form>
        {result ? (
          result.verification_status === "pending" ? (
            <Callout tone="info">The mail server is slow to answer. The result will show up in History in a moment.</Callout>
          ) : (
            <ResultCard r={result} />
          )
        ) : (
          <Card className="text-[13px] text-muted">
            <p className="font-medium text-text">What each result means</p>
            <dl className="mt-3 grid gap-2 sm:grid-cols-[6rem_1fr]">
              {(["verified", "domain", "invalid", "risky", "catch_all", "unknown"] as const).map((s) => (
                <div key={s} className="contents">
                  <dt>{s === "domain" ? <StatusBadge status="verified" method="dns" /> : <StatusBadge status={s} />}</dt>
                  <dd>
                    {
                      {
                        verified: "The mail server confirmed the mailbox. Safe to send.",
                        domain: "The domain takes mail, but the mailbox itself wasn't checked (this server doesn't probe mail servers).",
                        invalid: "Will bounce. Remove it.",
                        risky: "May deliver, but shared and throwaway inboxes hurt reply rates and reputation.",
                        catch_all: "The domain takes mail for any address, so it can't be confirmed. Send carefully.",
                        unknown: "No clear answer from the mail server. Try again later.",
                      }[s]
                    }
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
      </div>
      <Card padded={false}>
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Recent checks</h2>
        </div>
        {recent.isLoading ? (
          <SkeletonRows rows={4} />
        ) : !recent.data?.items.length ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing checked yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {recent.data.items.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setResult(r)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-panel-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{r.email}</span>
                  <StatusBadge status={r.verification_status} method={r.method} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function downloadResults(jobId?: string) {
  const qs = new URLSearchParams({ format: "csv", ...(jobId ? { job_id: jobId } : {}) });
  window.location.href = `/api/app/verification/results?${qs}`;
}

function JobsTable({ type }: { type: VerifyJob["type"] }) {
  const qc = useQueryClient();
  const jobs = useQuery({
    queryKey: JOBS_KEY,
    queryFn: () => get<VerifyJob[]>("/api/app/verification/jobs"),
    refetchInterval: (q) => ((q.state.data as VerifyJob[] | undefined)?.some((j) => j.status === "pending" || j.status === "in-progress") ? 1500 : false),
  });
  const rows = (jobs.data ?? []).filter((j) => j.type === type);
  const running = rows.some((j) => j.status === "pending" || j.status === "in-progress");
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: RESULTS_KEY });
      qc.invalidateQueries({ queryKey: CREDITS_KEY });
    }
    wasRunning.current = running;
  }, [running, qc]);
  const cancel = async (id: string) => {
    try {
      await post(`/api/app/background-jobs/${id}/cancel`);
      qc.invalidateQueries({ queryKey: JOBS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (jobs.isLoading) return <SkeletonRows rows={3} />;
  if (!rows.length) return <p className="px-4 py-8 text-center text-[13px] text-muted">No runs yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((j) => {
        const r = j.result ?? {};
        const active = j.status === "pending" || j.status === "in-progress";
        return (
          <li key={j.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{j.name}</span>
              <span className="text-xs text-muted">{dateTime(j.created_at)}</span>
            </div>
            {active ? (
              <div className="mt-2 flex items-center gap-3">
                <Progress value={j.progress} className="flex-1" />
                <span className="w-24 text-right text-xs tabular-nums text-muted">
                  {num(j.processed ?? r.processed ?? 0)} / {num(j.total ?? r.total ?? 0)}
                </span>
                <Button size="xs" variant="ghost" onClick={() => cancel(j.id)}>
                  Stop
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {j.status === "failed" ? (
                  <Badge tone="bad">Failed{j.error ? `: ${j.error}` : ""}</Badge>
                ) : (
                  <>
                    {j.status === "cancelled" && <Badge tone="neutral">Stopped</Badge>}
                    <Badge tone="ok">{num(r.verified ?? 0)} valid</Badge>
                    <Badge tone="bad">{num(r.invalid ?? 0)} invalid</Badge>
                    <Badge tone="warn">{num((r.risky ?? 0) + (r.catch_all ?? 0))} risky or catch-all</Badge>
                    {!!r.unknown && <Badge>{num(r.unknown)} unknown</Badge>}
                    {!!r.credits_refunded && <span className="text-xs text-muted">{plural(r.credits_refunded, "credit")} returned</span>}
                  </>
                )}
                <Button size="xs" variant="ghost" icon={<Download size={13} />} className="ml-auto" onClick={() => downloadResults(j.id)} disabled={j.status === "failed"}>
                  CSV
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const MAX_BULK = 100_000;

/** /app/verification/bulk */
export function VerifyBulk() {
  usePageTitle("Bulk verification");
  const can = useCan();
  const qc = useQueryClient();
  const credits = useCredits();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; columns: string[]; rows: Array<Record<string, string>> } | null>(null);
  const [column, setColumn] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const emails = useMemo(() => {
    const raw = mode === "paste" ? text.split(/[\s,;]+/) : file && column ? file.rows.map((r) => r[column] ?? "") : [];
    return [...new Set(raw.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  }, [mode, text, file, column]);
  const balance = credits.data && !credits.data.self_hosted ? (credits.data.usage.verification_credits.balance ?? 0) : null;
  const short = balance !== null && emails.length > balance;

  const pick = (f: File | undefined) => {
    if (!f) return;
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const columns = res.meta.fields ?? [];
        if (!columns.length) return toast.error("That file has no header row");
        setFile({ name: f.name, columns, rows: res.data });
        setColumn(columns.find((c) => /e-?mail/i.test(c)) ?? columns[0]!);
      },
      error: (err) => toast.error(err.message),
    });
  };
  const start = async () => {
    setBusy(true);
    try {
      await post("/api/app/verification/bulk", { emails, name: mode === "file" ? file?.name : undefined });
      toast.success(`Verifying ${plural(emails.length, "address", "addresses")}`);
      setText("");
      setFile(null);
      qc.invalidateQueries({ queryKey: JOBS_KEY });
      qc.invalidateQueries({ queryKey: CREDITS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <Card>
        <CardHeader title="Verify a list" description={`Upload a CSV or paste addresses. Up to ${num(MAX_BULK)} at a time; duplicates are checked once.`} />
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "file", label: "Upload CSV" },
            { value: "paste", label: "Paste addresses" },
          ]}
        />
        <div className="mt-4">
          {mode === "paste" ? (
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ana@northwind.com\nbo@fabrikam.io"} aria-label="Email addresses" />
          ) : file ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                <FileUp size={15} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-muted">{plural(file.rows.length, "row")}</span>
                <Button size="xs" variant="ghost" onClick={() => setFile(null)}>
                  Change
                </Button>
              </div>
              <Field label="Email column">{(id) => <NativeSelect id={id} value={column} onChange={setColumn} options={file.columns.map((c) => ({ value: c, label: c }))} />}</Field>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pick(e.dataTransfer.files[0]);
              }}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-10 text-[13px] text-muted hover:bg-panel-2"
            >
              <Upload size={20} />
              <span>
                <span className="font-medium text-text">Choose a CSV</span> or drop it here
              </span>
            </button>
          )}
          <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <span className="text-[13px] text-muted">
            {emails.length ? (
              <>
                <span className="font-medium text-text">{plural(emails.length, "address", "addresses")}</span>
                {balance !== null && ` · uses ${plural(emails.length, "credit")} of ${num(balance)}`}
              </>
            ) : (
              "No addresses yet"
            )}
          </span>
          <Button variant="primary" className="ml-auto" loading={busy} disabled={!can.write || !emails.length || emails.length > MAX_BULK || short} onClick={start}>
            Start verifying
          </Button>
        </div>
        {short && (
          <Callout tone="warn" className="mt-3" action={<Link to="/app/verification/billing" className="text-[13px] font-medium text-brand-text hover:underline">Get credits</Link>}>
            You need {plural(emails.length - (balance ?? 0), "more credit")}.
          </Callout>
        )}
      </Card>
      <Card padded={false}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold">Recent lists</h2>
        </div>
        <JobsTable type="verify-emails" />
      </Card>
    </div>
  );
}

/** /app/verification/leads */
export function VerifyLeads() {
  usePageTitle("Verify leads");
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [source, setSource] = useState<"campaign" | "list">(params.get("list_id") ? "list" : "campaign");
  const [id, setId] = useState(params.get("campaign_id") ?? params.get("list_id") ?? "");
  const [onlyNew, setOnlyNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const campaigns = useCampaignNames();
  const lists = useQuery({ queryKey: ["lead-lists", "overview"], queryFn: () => get<{ items: Array<{ id: string; name: string; lead_count?: number }> }>("/api/app/lead-lists/overview") });
  const options = source === "campaign" ? (campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })) : (lists.data?.items ?? []).map((l) => ({ value: l.id, label: l.lead_count !== undefined ? `${l.name} (${num(l.lead_count)})` : l.name }));
  useEffect(() => {
    if (!options.some((o) => o.value === id)) setId(options[0]?.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, campaigns.data, lists.data]);
  const start = async () => {
    setBusy(true);
    try {
      await post("/api/app/verification/leads", { ...(source === "campaign" ? { campaign_id: id } : { list_id: id }), only_unverified: onlyNew });
      toast.success("Verification started");
      qc.invalidateQueries({ queryKey: JOBS_KEY });
      qc.invalidateQueries({ queryKey: CREDITS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <Card>
        <CardHeader title="Verify leads you already have" description="Each lead's email status updates as it's checked. Campaigns skip invalid addresses automatically." />
        <div className="space-y-4">
          <Segmented
            size="sm"
            value={source}
            onChange={setSource}
            options={[
              { value: "campaign", label: "From a campaign" },
              { value: "list", label: "From a lead list" },
            ]}
          />
          <Field label={source === "campaign" ? "Campaign" : "Lead list"}>
            {(fid) =>
              options.length ? (
                <NativeSelect id={fid} value={id} onChange={setId} options={options} />
              ) : (
                <p className="text-[13px] text-muted">{source === "campaign" ? "No campaigns yet." : "No lead lists yet."}</p>
              )
            }
          </Field>
          <Checkbox label="Only leads that haven't been verified yet" checked={onlyNew} onChange={setOnlyNew} />
          <p className="flex gap-1.5 text-xs text-muted">
            <Info size={13} className="mt-px shrink-0" /> One credit per unique address. Addresses checked in the last 30 days reuse that result and the credit is returned.
          </p>
          <div className="flex justify-end">
            <Button variant="primary" icon={<ListChecks size={15} />} loading={busy} disabled={!id} onClick={start}>
              Verify leads
            </Button>
          </div>
        </div>
      </Card>
      <Card padded={false}>
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Recent runs</h2>
        </div>
        <JobsTable type="verify-leads" />
      </Card>
    </div>
  );
}

const PAGE_SIZE = 50;

/** /app/verification/list — every address this workspace has checked. */
export function VerifyList() {
  usePageTitle("Verification history");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status, search]);
  const q = useQuery({
    queryKey: [...RESULTS_KEY, "all", status, search.trim(), page],
    queryFn: () => get<Results>("/api/app/verification/results", { status: status || undefined, search: search.trim() || undefined, limit: PAGE_SIZE, page }),
    placeholderData: keepPreviousData,
  });
  const stats = q.data?.stats;
  const chips: Array<[string, string, number | undefined]> = [
    ["", "All", stats?.total],
    ["verified", "Valid", stats?.verified],
    ["invalid", "Invalid", stats?.invalid],
    ["risky", "Risky", stats?.risky],
    ["catch_all", "Catch-all", stats?.catch_all],
    ["unknown", "Unknown", stats?.unknown],
  ];
  const rows = q.data?.items ?? [];
  const pages = stats ? Math.max(1, Math.ceil((status ? (chips.find((c) => c[0] === status)?.[2] ?? 0) : stats.total) / PAGE_SIZE)) : 1;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map(([value, label, n]) => (
          <button
            key={label}
            type="button"
            onClick={() => setStatus(value)}
            className={cn("rounded-full border px-3 py-1 text-xs", status === value ? "border-brand bg-brand-soft font-medium text-brand-text" : "border-line text-muted hover:text-text")}
          >
            {label}
            {n !== undefined && !status && <span className="ml-1.5 tabular-nums">{num(n)}</span>}
          </button>
        ))}
        <SearchInput value={search} onChange={setSearch} placeholder="Search addresses" className="ml-auto w-56" />
        <Button icon={<Download size={15} />} onClick={() => downloadResults()} disabled={!stats?.total}>
          CSV
        </Button>
      </div>
      <Card padded={false} className="overflow-hidden">
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : !rows.length ? (
          <EmptyState icon={<ShieldCheck size={22} />} title={search || status ? "Nothing matches" : "No addresses checked yet"} description={search || status ? undefined : "Verify a single address, a CSV or your leads to see results here."} />
        ) : (
          <ScrollX>
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-b border-line bg-panel-2/50 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                  <th className="px-4 py-2.5 font-medium">Why</th>
                  <th className="px-4 py-2.5 font-medium">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-[16rem] truncate px-4 py-2.5 font-medium">{r.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={r.verification_status} method={r.method} />
                    </td>
                    <td className="max-w-sm truncate px-4 py-2.5 text-muted" title={r.reason ? REASONS[r.reason] : undefined}>
                      {r.reason ? (REASONS[r.reason] ?? r.reason) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{dateTime(r.timestamp_created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
            <span>
              Page {page} of {num(pages)}
            </span>
            <div className="flex gap-1">
              <Button size="xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

const LEDGER_REASONS: Record<string, string> = {
  purchase: "Credits bought",
  plan_period: "Monthly plan credits",
  email_verification: "Single check",
  bulk_verification: "List verification",
  lead_verification: "Lead verification",
  verification_refund: "Returned (already checked or stopped)",
};

/** /app/verification/billing */
export function VerifyCredits() {
  usePageTitle("Verification credits");
  const can = useCan();
  const credits = useCredits();
  const [busy, setBusy] = useState<string | null>(null);
  const ledger = useQuery({ queryKey: ["credit-ledger", "verification"], queryFn: () => get<Array<{ id: string; delta: number; reason: string; created_at: string }>>("/api/app/billing/credit-ledger", { pool: "verification" }) });
  const buy = async (packId: string) => {
    setBusy(packId);
    try {
      const r = await post<{ url: string }>("/api/app/billing/credit-packs", { pack_id: packId });
      window.location.href = r.url;
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };
  const d = credits.data;
  if (!d) return <SkeletonRows rows={4} />;
  const balance = d.usage.verification_credits.balance;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Card>
          <p className="text-[13px] text-muted">Balance</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{d.self_hosted || balance === null || balance === undefined ? "Unlimited" : num(balance)}</p>
          <p className="mt-2 text-[13px] text-muted">
            {d.self_hosted ? "This server is self-hosted, so verification isn't metered." : "One credit checks one address. Credits don't expire."}
          </p>
        </Card>
        {!d.self_hosted && (
          <Card>
            <CardHeader title="Buy credits" description={d.stripe_enabled ? "Paid once, added as soon as the payment clears." : "Payments aren't set up on this server. Ask its administrator to add credits."} />
            <div className="grid gap-3 sm:grid-cols-3">
              {d.verification_packs.map((p) => (
                <div key={p.id} className="rounded-lg border border-line p-4">
                  <p className="text-lg font-semibold tabular-nums">{num(p.credits)}</p>
                  <p className="text-[13px] text-muted">
                    {money(p.price)} · {money((p.price / p.credits) * 1000)} per 1,000
                  </p>
                  <Button size="sm" className="mt-3 w-full" disabled={!d.stripe_enabled || !can.admin} loading={busy === p.id} onClick={() => buy(p.id)}>
                    Buy
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
      <Card padded={false}>
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Credit history</h2>
        </div>
        {ledger.isLoading ? (
          <SkeletonRows rows={4} />
        ) : !ledger.data?.length ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">{d.self_hosted ? "Nothing is metered on this server." : "No credit activity yet."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {ledger.data.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{LEDGER_REASONS[l.reason] ?? l.reason}</p>
                  <p className="text-xs text-muted">{dateTime(l.created_at)}</p>
                </div>
                <span className={cn("font-medium tabular-nums", l.delta > 0 ? "text-ok" : "text-muted")}>
                  {l.delta > 0 ? "+" : ""}
                  {num(l.delta)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
