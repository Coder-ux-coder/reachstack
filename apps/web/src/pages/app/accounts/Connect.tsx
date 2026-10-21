import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, FileSpreadsheet, FlaskConical, Globe, Mail, Plus, Search, ShoppingCart, Sparkles, Trash2, Upload, XCircle } from "lucide-react";
import { SHEET_MAXIMUMS, readSheetNumber, readWarmupIncrease } from "@reachstack/shared";
import { errorMessage, get, post, type Page as ApiPage } from "@/lib/api";
import { jobDone, useJob } from "@/lib/jobs";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useSession } from "@/lib/session";
import { money, num, plural } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Input, NumberInput, Page, PageHeader, Progress, Select, Spinner, SwitchRow, Tabs, type Column } from "@/components/ui";
import { ACCOUNTS_KEY } from "./Accounts";
import type { ConnectionCheck } from "./checks";

type Method = "google" | "microsoft" | "imap" | "csv" | "sandbox" | "dfy";

interface Providers {
  presets: Array<{ key: string; name: string; providerCode: number; imap: { host: string; port: number }; smtp: { host: string; port: number }; hint?: string }>;
  oauth: { google: boolean; microsoft: boolean };
}

type Check = ConnectionCheck;

const METHODS: Array<{ key: Method; title: string; body: string; icon: ReactNode; badge?: string }> = [
  { key: "google", title: "Google", body: "Gmail or Google Workspace", icon: <span aria-hidden className="text-lg font-bold text-[#4285F4]">G</span> },
  { key: "microsoft", title: "Microsoft", body: "Office 365 or Outlook", icon: <span className="grid grid-cols-2 gap-0.5">{["#f35325", "#81bc06", "#05a6f0", "#ffba08"].map((c) => <span key={c} className="h-2 w-2" style={{ background: c }} />)}</span> },
  { key: "imap", title: "Any provider", body: "IMAP and SMTP (Zoho, Yahoo, Fastmail, your own server…)", icon: <Mail size={20} className="text-brand-text" /> },
  { key: "csv", title: "Bulk import", body: "Many IMAP/SMTP accounts from a CSV file", icon: <FileSpreadsheet size={20} className="text-ok" /> },
  { key: "dfy", title: "Done for you", body: "New domains and mailboxes, set up for you", icon: <ShoppingCart size={20} className="text-warn" />, badge: "Order" },
  { key: "sandbox", title: "Test mailboxes", body: "Local mailboxes for trying campaigns without sending real email", icon: <FlaskConical size={20} className="text-info" /> },
];

function ResultLine({ label, r }: { label: string; r: Check }) {
  return (
    <div className="flex items-start gap-2 text-[13px]">
      {r.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-bad" />}
      <span className="min-w-0 break-words">
        <span className="font-medium">{label}</span> {r.ok ? "connected" : <span className="text-muted">— {r.error ?? "failed"}</span>}
        {!r.ok && r.hint && <span className="mt-0.5 block text-text">{r.hint}</span>}
      </span>
    </div>
  );
}

function ImapForm({ preset, onBack }: { preset?: string; onBack: () => void }) {
  const providers = useQuery({ queryKey: ["account-providers"], queryFn: () => get<Providers>("/api/app/accounts/providers"), staleTime: Infinity });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState({
    email: "",
    first_name: "",
    last_name: "",
    password: "",
    imap_host: "",
    imap_port: 993 as number | null,
    imap_username: "",
    smtp_host: "",
    smtp_port: 587 as number | null,
    smtp_username: "",
    smtp_password: "",
  });
  const [separateSmtp, setSeparateSmtp] = useState(false);
  const [warmup, setWarmup] = useState(true);
  const [result, setResult] = useState<{ imap: Check; smtp: Check } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [hint, setHint] = useState<string | undefined>();
  const set = (k: keyof typeof form) => (v: string | number | null) => setForm((f) => ({ ...f, [k]: v }));

  const applyPreset = (key: string) => {
    const p = providers.data?.presets.find((x) => x.key === key);
    if (!p) return;
    setForm((f) => ({ ...f, imap_host: p.imap.host, imap_port: p.imap.port, smtp_host: p.smtp.host, smtp_port: p.smtp.port }));
    setHint(p.hint);
  };
  // Google/Microsoft app-password flows start with the provider's servers filled in.
  useEffect(() => {
    if (preset && providers.data) applyPreset(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, providers.data]);

  const detect = async () => {
    if (!form.email.includes("@") || form.imap_host) return;
    try {
      const r = await post<{ preset: Providers["presets"][number] | null }>("/api/app/accounts/detect", { email: form.email });
      if (r.preset) {
        setForm((f) => ({ ...f, imap_host: r.preset!.imap.host, imap_port: r.preset!.imap.port, smtp_host: r.preset!.smtp.host, smtp_port: r.preset!.smtp.port }));
        setHint(r.preset.hint);
      }
    } catch {
      // detection is best-effort
    }
  };

  const payload = () => ({
    email: form.email,
    first_name: form.first_name,
    last_name: form.last_name,
    provider_code: preset === "google" ? 2 : preset === "microsoft" ? 3 : 1,
    imap_host: form.imap_host,
    imap_port: form.imap_port ?? 993,
    imap_username: form.imap_username || form.email,
    imap_password: form.password,
    smtp_host: form.smtp_host,
    smtp_port: form.smtp_port ?? 587,
    smtp_username: separateSmtp ? form.smtp_username || form.email : form.imap_username || form.email,
    smtp_password: separateSmtp && form.smtp_password ? form.smtp_password : form.password,
    enable_warmup: warmup,
  });

  const test = async () => {
    setBusy("test");
    try {
      setResult(await post<{ imap: Check; smtp: Check }>("/api/app/accounts/test-connection", payload()));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      const a = await post<{ email: string }>("/api/app/accounts", payload());
      await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      nav(`/app/accounts?connected=${encodeURIComponent(a.email)}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const ready = form.email.includes("@") && form.password && form.imap_host && form.smtp_host;

  return (
    <Card className="mx-auto max-w-2xl">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> All options
      </button>
      <h2 className="text-lg font-semibold">{preset === "google" ? "Connect Google with an app password" : preset === "microsoft" ? "Connect Microsoft with IMAP/SMTP" : "Connect any provider"}</h2>
      <p className="mt-1 text-[13px] text-muted">We test both incoming (IMAP) and outgoing (SMTP) connections before saving.</p>
      {hint && (
        <Callout tone="info" className="mt-4">
          {hint}
        </Callout>
      )}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Email address" className="sm:col-span-2">
          {(id) => <Input id={id} type="email" autoFocus value={form.email} onChange={(e) => set("email")(e.target.value.trim())} onBlur={detect} placeholder="name@yourdomain.com" />}
        </Field>
        <Field label="First name">{(id) => <Input id={id} value={form.first_name} onChange={(e) => set("first_name")(e.target.value)} />}</Field>
        <Field label="Last name">{(id) => <Input id={id} value={form.last_name} onChange={(e) => set("last_name")(e.target.value)} />}</Field>
        <Field label={preset === "google" ? "App password" : "Password"} className="sm:col-span-2">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password")(e.target.value)} />}
        </Field>
        {!preset && (
          <Field label="Provider preset" optional className="sm:col-span-2">
            {(id) => <Select id={id} value="" onChange={applyPreset} placeholder="Fill in server settings for…" options={(providers.data?.presets ?? []).map((p) => ({ value: p.key, label: p.name }))} />}
          </Field>
        )}
        <Field label="IMAP host">{(id) => <Input id={id} value={form.imap_host} onChange={(e) => set("imap_host")(e.target.value.trim())} placeholder="imap.example.com" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="IMAP port">{(id) => <NumberInput id={id} value={form.imap_port} onChange={set("imap_port")} className="w-full" />}</Field>
          <Field label="IMAP username" optional>
            {(id) => <Input id={id} value={form.imap_username} onChange={(e) => set("imap_username")(e.target.value.trim())} placeholder="Same as email" />}
          </Field>
        </div>
        <Field label="SMTP host">{(id) => <Input id={id} value={form.smtp_host} onChange={(e) => set("smtp_host")(e.target.value.trim())} placeholder="smtp.example.com" />}</Field>
        <Field label="SMTP port">{(id) => <NumberInput id={id} value={form.smtp_port} onChange={set("smtp_port")} className="w-full" />}</Field>
      </div>
      <div className="mt-2">
        <SwitchRow label="Different SMTP username or password" checked={separateSmtp} onChange={setSeparateSmtp}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input value={form.smtp_username} onChange={(e) => set("smtp_username")(e.target.value.trim())} placeholder="SMTP username" />
            <Input type="password" autoComplete="new-password" value={form.smtp_password} onChange={(e) => set("smtp_password")(e.target.value)} placeholder="SMTP password" />
          </div>
        </SwitchRow>
        <SwitchRow label="Turn on warmup" description="Recommended for every new mailbox." checked={warmup} onChange={setWarmup} />
      </div>
      {result && (
        <div className="mt-3 space-y-1.5 rounded-lg bg-panel-2 p-3">
          <ResultLine label="IMAP" r={result.imap} />
          <ResultLine label="SMTP" r={result.smtp} />
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={test} loading={busy === "test"} disabled={!ready}>
          Test connection
        </Button>
        <Button variant="primary" onClick={save} loading={busy === "save"} disabled={!ready}>
          Connect account
        </Button>
      </div>
    </Card>
  );
}

function OAuthChoice({ provider, onBack, onImap }: { provider: "google" | "microsoft"; onBack: () => void; onImap: () => void }) {
  const providers = useQuery({ queryKey: ["account-providers"], queryFn: () => get<Providers>("/api/app/accounts/providers"), staleTime: Infinity });
  const [warmup, setWarmup] = useState(true);
  const [busy, setBusy] = useState(false);
  const owner = !!useSession().features.owner;
  const enabled = providers.data?.oauth[provider];
  const name = provider === "google" ? "Google" : "Microsoft";
  const start = async () => {
    setBusy(true);
    try {
      const r = await get<{ url: string }>(`/api/app/accounts/oauth/${provider}/url`, { enable_warmup: warmup });
      window.location.href = r.url;
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Card className="mx-auto max-w-xl">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> All options
      </button>
      <h2 className="text-lg font-semibold">Connect a {name} account</h2>
      {!providers.data ? (
        providers.isError ? (
          <ErrorState className="py-10" title={`Couldn't check whether ${name} sign-in is set up`} error={providers.error} onRetry={() => providers.refetch()} />
        ) : (
          <div role="status" aria-label={`Checking ${name} sign-in`} className="flex justify-center py-12">
            <Spinner size={20} />
          </div>
        )
      ) : enabled ? (
        <>
          <p className="mt-1 text-[13px] text-muted">Sign in with {name} and approve access to send and read email. No password is stored.</p>
          <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[13px] text-muted">
            <li>Make sure IMAP is allowed for the mailbox{provider === "google" ? " (Gmail settings → Forwarding and POP/IMAP)" : " and SMTP AUTH is on in the Microsoft 365 admin center"}.</li>
            <li>Sign in with the mailbox you want to send from.</li>
            <li>Approve the requested permissions.</li>
          </ol>
          <div className="mt-4">
            <SwitchRow label="Turn on warmup" checked={warmup} onChange={setWarmup} />
          </div>
          <Button variant="primary" size="lg" className="mt-4 w-full" loading={busy} onClick={start}>
            Sign in with {name}
          </Button>
        </>
      ) : provider === "google" ? (
        <Callout tone="info" className="mt-4" title="Google sign-in isn't set up on this server">
          {owner ? (
            <>
              Set it up in{" "}
              <Link to="/app/settings/installation/services" className="underline">
                Settings → Installation → Services
              </Link>{" "}
              with your own Google app.
            </>
          ) : (
            "The person who runs this installation can set it up."
          )}{" "}
          Until then, an app password works: turn on 2-Step Verification for the Google account, then create one at myaccount.google.com/apppasswords.
        </Callout>
      ) : (
        <Callout tone="warn" className="mt-4" title="Microsoft sign-in isn't set up on this server">
          Microsoft no longer accepts passwords for reading mail on Outlook.com or Microsoft 365, so Microsoft mailboxes connect by signing in.{" "}
          {owner ? (
            <>
              Set it up once in{" "}
              <Link to="/app/settings/installation/services" className="underline">
                Settings → Installation → Services
              </Link>{" "}
              with an app registered in Microsoft Entra (the page shows the redirect address to register).
            </>
          ) : (
            "Ask the person who runs this installation to set it up."
          )}
        </Callout>
      )}
      <button type="button" onClick={onImap} className="mt-4 w-full text-center text-[13px] text-brand-text hover:underline">
        {provider === "google" ? "Use an app password (IMAP/SMTP) instead" : "Try a password (IMAP/SMTP) anyway"}
      </button>
    </Card>
  );
}

/** Each column the importer reads, in the template's order, with other names spreadsheets give it (compared without case, spaces or punctuation). */
const CSV_COLUMNS: Record<string, string[]> = {
  email: ["emailaddress", "mail", "mailbox", "emailaccount", "senderemail", "fromemail", "fromaddress"],
  first_name: ["first", "givenname", "fname", "senderfirstname"],
  last_name: ["last", "surname", "familyname", "lname", "senderlastname"],
  imap_username: ["username", "user", "login", "imapuser", "imaplogin", "imapemail"],
  imap_password: ["password", "pass", "apppassword", "emailpassword", "imappass"],
  imap_host: ["imap", "imapserver", "imaphostname", "incomingserver", "incominghost", "incomingmailserver"],
  imap_port: ["incomingport"],
  smtp_username: ["smtpuser", "smtplogin", "smtpemail"],
  smtp_password: ["smtppass"],
  smtp_host: ["smtp", "smtpserver", "smtphostname", "outgoingserver", "outgoinghost", "outgoingmailserver"],
  smtp_port: ["outgoingport"],
  daily_limit: ["limit", "sendinglimit", "dailysendinglimit", "emailsperday", "dailycampaignlimit"],
  warmup_limit: ["warmupperday", "warmupdailylimit", "dailywarmuplimit", "warmupemailsperday"],
  warmup_increment: ["warmupincrease", "warmupdailyincrease", "warmuprampup"],
  reply_rate: ["warmupreplyrate"],
};
const REQUIRED_COLUMNS = ["email", "imap_password", "imap_host", "smtp_host"];
const NUMBER_LABELS: Record<keyof typeof SHEET_MAXIMUMS, string> = {
  imap_port: "IMAP port",
  smtp_port: "SMTP port",
  daily_limit: "daily limit",
  warmup_limit: "warmup emails a day",
  reply_rate: "warmup reply rate",
};

/** Values the import can't use as written: the server leaves those out (the default applies) or takes the most allowed. */
function unusableValues(rows: Array<Record<string, string>>): string[] {
  const notes: string[] = [];
  for (const row of rows) {
    for (const [col, max] of Object.entries(SHEET_MAXIMUMS) as Array<[keyof typeof SHEET_MAXIMUMS, number]>) {
      const v = row[col];
      if (v === undefined) continue;
      const n = readSheetNumber(v);
      if (n === undefined) notes.push(`${row.email}: “${v}” isn't a number (${NUMBER_LABELS[col]}), so the default is used.`);
      else if (n > max) notes.push(`${row.email}: ${NUMBER_LABELS[col]} ${num(n)} is more than the ${num(max)} allowed, so ${num(max)} is used.`);
    }
    if (row.warmup_increment !== undefined && readWarmupIncrease(row.warmup_increment) === undefined) {
      notes.push(`${row.email}: “${row.warmup_increment}” isn't a warmup increase (Recommended, Disabled, or 1 to 4 a day), so the default is used.`);
    }
  }
  return notes;
}

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

/** The header that holds each column: its own name first ("IMAP Host", "imap_host"), else the first other name for it. */
function matchColumns(headers: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CSV_COLUMNS).flatMap(([col, names]) => {
      const header = headers.find((h) => headerKey(h) === headerKey(col)) ?? headers.find((h) => names.includes(headerKey(h)));
      return header === undefined ? [] : [[col, header]];
    }),
  );
}

type AccountImport = { imported: number; failed: number; results: Array<{ email: string; ok: boolean; error?: string }> };

function CsvImport({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; headers: string[]; columns: string[]; rows: Array<Record<string, string>>; skipped: number; notes: string[] } | null>(null);
  const [warmup, setWarmup] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useJob<AccountImport>(jobId);
  const rows = file?.rows ?? [];
  const noEmail = !!file && !file.columns.includes("email");
  const missing = file && !noEmail ? REQUIRED_COLUMNS.filter((c) => !file.columns.includes(c)) : [];
  const parse = (f: File) => {
    if (/\.(xlsx?|numbers|ods)$/i.test(f.name)) {
      setFile(null);
      return void toast.error("That's a spreadsheet file. Save it as CSV first, then choose the CSV.");
    }
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (r) => {
        const headers = r.meta.fields ?? [];
        const found = matchColumns(headers);
        const all = r.data.map((row) =>
          Object.fromEntries(
            Object.entries(found).flatMap(([col, h]) => {
              const v = row[h] ?? "";
              if (!v.trim()) return [];
              // Passwords are taken as written; numbers and the warmup increase are read the way people write them.
              return [[col, col.endsWith("_password") ? v : v.trim()]];
            }),
          ),
        );
        const withEmail = all.filter((x) => x.email);
        setFile({ name: f.name, headers, columns: Object.keys(found), rows: withEmail, skipped: all.length - withEmail.length, notes: unusableValues(withEmail) });
      },
      error: (e) => toast.error(`Couldn't read that file: ${e.message}`),
    });
  };
  const start = async () => {
    setBusy(true);
    try {
      const j = await post<{ id: string }>("/api/app/accounts/import", { accounts: rows, enable_warmup: warmup });
      setJobId(j.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const status = job.data?.status;
  const done = jobDone(job.data);
  useEffect(() => {
    if (done) qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  }, [done, qc]);
  // A failed or stopped import still lists the accounts it got to.
  const results = job.data?.result?.results ?? (done ? ((job.data?.data?.results as AccountImport["results"] | undefined) ?? []) : []);
  const failed = results.filter((r) => !r.ok);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${Object.keys(CSV_COLUMNS).join(",")}\njane@yourdomain.com,Jane,Doe,jane@yourdomain.com,app-password,imap.yourhost.com,993,jane@yourdomain.com,app-password,smtp.yourhost.com,587,30,20,,30\n`)}`;
  return (
    <Card className="mx-auto max-w-2xl">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> All options
      </button>
      <h2 className="text-lg font-semibold">Bulk import from CSV</h2>
      <p className="mt-1 text-[13px] text-muted">
        One row per mailbox. Required columns: email, imap_password, imap_host, smtp_host (names like “Email address”, “Password” or “IMAP server” work too).{" "}
        <a href={template} download="accounts-template.csv" className="text-brand-text hover:underline">
          Download a template
        </a>
      </p>
      {!jobId ? (
        <>
          <label
            className="mt-5 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong px-6 py-10 text-center hover:border-brand hover:bg-brand-soft/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) parse(f);
            }}
          >
            <Upload size={22} className="text-muted" />
            <span className="text-sm font-medium">{file?.name || "Choose a CSV file"}</span>
            <span className="text-xs text-muted">
              {!file ? "or drop it here" : `${plural(rows.length, "account")} found${file.skipped && !noEmail ? ` · ${plural(file.skipped, "row")} without an email address left out` : ""}`}
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so the same file, once fixed, can be chosen again.
                e.target.value = "";
                if (f) parse(f);
              }}
            />
          </label>
          {noEmail ? (
            <Callout tone="bad" className="mt-4" title={file.headers.length ? "No email column found" : "This file is empty"}>
              {!file.headers.length
                ? "Choose a CSV with a row of column names, then one row per mailbox."
                : file.headers.some((h) => h.includes("@"))
                  ? "The first row should name the columns, but it holds a mailbox. Add a row of column names at the top, like the template's."
                  : `The first row should name the columns, with one called email for each mailbox's address. This file's columns: ${file.headers.slice(0, 10).join(", ")}${file.headers.length > 10 ? "…" : "."}`}
            </Callout>
          ) : missing.length > 0 ? (
            <Callout tone="bad" className="mt-4" title="Missing columns">
              Add {missing.join(", ")}, then choose the file again. The template shows every column.
            </Callout>
          ) : (
            file &&
            !rows.length && (
              <Callout tone="bad" className="mt-4" title="No accounts in this file">
                No row has an email address.
              </Callout>
            )
          )}
          {!!file?.notes.length && !noEmail && !missing.length && (
            <Callout tone="warn" className="mt-4" title="Some values can't be used as written">
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {file.notes.slice(0, 5).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              {file.notes.length > 5 && <p className="mt-1">And {plural(file.notes.length - 5, "more value")}.</p>}
            </Callout>
          )}
          <SwitchRow label="Turn on warmup for every imported account" checked={warmup} onChange={setWarmup} />
          <div className="mt-3 flex justify-end">
            <Button variant="primary" disabled={!rows.length || noEmail || missing.length > 0} loading={busy} onClick={start}>
              Import {rows.length ? plural(rows.length, "account") : "accounts"}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-6 space-y-4">
          <Progress value={job.data?.progress ?? 0} />
          {status === "failed" ? (
            <Callout tone="bad" title="The import failed">
              {job.data?.error || "Something went wrong on the server."}
            </Callout>
          ) : status === "cancelled" ? (
            <Callout tone="warn" title="The import was stopped">
              Accounts connected before it stopped are kept.
            </Callout>
          ) : job.isError && !job.data ? (
            <Callout tone="bad" title="Couldn't check on the import">
              {errorMessage(job.error)} It keeps going on the server, and imported accounts show up under Email accounts.
            </Callout>
          ) : (
            <p className="text-[13px] text-muted">{done ? "Import finished." : "Testing and connecting each account…"}</p>
          )}
          {done && results.length > 0 && (
            <>
              <div className="flex gap-3">
                <Badge tone="ok">{num(results.length - failed.length)} connected</Badge>
                {failed.length > 0 && <Badge tone="bad">{num(failed.length)} failed</Badge>}
              </div>
              {failed.length > 0 && (
                <ul className="scroll-thin max-h-60 space-y-1 overflow-y-auto rounded-lg bg-panel-2 p-3 text-[13px]">
                  {failed.map((r) => (
                    <li key={r.email}>
                      <span className="font-medium">{r.email}</span> <span className="text-muted">— {r.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {done && (
            <div className="flex justify-end">
              <Link to="/app/accounts" className="text-sm font-medium text-brand-text hover:underline">
                Go to email accounts
              </Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SandboxForm({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [count, setCount] = useState<number | null>(3);
  const [domain, setDomain] = useState("");
  const [warmup, setWarmup] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mx-auto max-w-xl">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> All options
      </button>
      <h2 className="text-lg font-semibold">Create test mailboxes</h2>
      <p className="mt-1 text-[13px] text-muted">
        Test mailboxes live inside this installation. Campaigns sent from them go to local inboxes and simulated prospects reply, so you can try every feature without touching real email.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="How many">{(id) => <NumberInput id={id} value={count} min={1} max={25} onChange={setCount} className="w-full" />}</Field>
        <Field label="Domain" optional hint="Defaults to a .test domain">
          {(id) => <Input id={id} value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="acme-demo.test" />}
        </Field>
      </div>
      <SwitchRow label="Turn on warmup" checked={warmup} onChange={setWarmup} />
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          loading={busy}
          disabled={!count}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ items: Array<{ email: string }> }>("/api/app/accounts/sandbox", { count, domain: domain || undefined, enable_warmup: warmup });
              await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
              toast.success(`Created ${r.items.length} test mailboxes`);
              nav("/app/accounts");
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Create mailboxes
        </Button>
      </div>
    </Card>
  );
}

interface CartItem {
  domain: string;
  email_provider: 1 | 2 | 3;
  accounts: Array<{ email_address_prefix: string; first_name: string; last_name: string }>;
}

interface Order {
  id: string;
  domain: string;
  status: string;
  order_type: string;
  email_provider: number;
  accounts_count: number;
  price_per_month: number | null;
  is_pre_warmed_up: boolean;
  timestamp_created: string;
}

const PROVIDER_OPTIONS = [
  { value: "1", label: "Google Workspace" },
  { value: "3", label: "Microsoft 365" },
  { value: "2", label: "Managed SMTP mailbox" },
];

function DoneForYou({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"new" | "prewarmed" | "orders">("new");
  const [query, setQuery] = useState("");
  const [names, setNames] = useState({ first: "", last: "" });
  const [cart, setCart] = useState<CartItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ total_price_per_month: number; total_domains_price_per_year: number; order_error?: string } | null>(null);
  const pricing = useQuery({ queryKey: ["dfy-pricing"], queryFn: () => get<{ domain_per_year: number; prewarmed_domain_per_year: number; mailbox_per_month: Record<string, number> }>("/api/app/dfy/pricing") });
  const [suggestions, setSuggestions] = useState<Array<{ domain: string; available: boolean }>>([]);
  const prewarmed = useQuery({
    queryKey: ["dfy-prewarmed"],
    queryFn: () => post<{ domains: string[]; domains_with_type: Array<{ domain: string; account_type: number }> }>("/api/v2/dfy-email-account-orders/domains/pre-warmed-up-list", {}),
    enabled: tab === "prewarmed",
  });
  const orders = useQuery({ queryKey: ["dfy-orders"], queryFn: () => get<ApiPage<Order>>("/api/v2/dfy-email-account-orders", { limit: 50 }), enabled: tab === "orders" });

  const search = async () => {
    const term = query.trim().toLowerCase().replace(/^https?:\/\//, "");
    if (!term) return;
    setBusy("search");
    try {
      const base = term.includes(".") ? term : `${term}.com`;
      const [checked, similar] = await Promise.all([
        post<{ results: Array<{ domain: string; available: boolean }> }>("/api/v2/dfy-email-account-orders/domains/check", { domains: [base] }),
        post<{ domains: string[] }>("/api/v2/dfy-email-account-orders/domains/similar", { domain: base }),
      ]);
      // Similar names are generated, not checked; check the first few so "Add" only shows for free ones.
      const candidates = similar.domains.filter((d) => d !== base).slice(0, 11);
      const sim = candidates.length ? (await post<{ results: Array<{ domain: string; available: boolean }> }>("/api/v2/dfy-email-account-orders/domains/check", { domains: candidates })).results : [];
      setSuggestions([...checked.results, ...sim]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const addDomain = (domain: string) => {
    if (cart.some((c) => c.domain === domain)) return;
    const first = names.first.trim() || "Alex";
    const last = names.last.trim() || "Morgan";
    const prefixes = [first.toLowerCase(), `${first.toLowerCase()}.${last.toLowerCase()}`, `${first[0]!.toLowerCase()}${last.toLowerCase()}`];
    setCart([...cart, { domain, email_provider: 1, accounts: prefixes.map((p) => ({ email_address_prefix: p.replace(/[^a-z0-9.]/g, ""), first_name: first, last_name: last })) }]);
    setQuote(null);
  };
  const submit = async (simulation: boolean, orderType: "dfy" | "pre_warmed_up" = tab === "prewarmed" ? "pre_warmed_up" : "dfy") => {
    setBusy(simulation ? "quote" : "order");
    try {
      const r = await post<{ total_price_per_month: number; total_domains_price_per_year: number; order_error?: string }>("/api/v2/dfy-email-account-orders", { items: cart, order_type: orderType, simulation });
      if (simulation) setQuote(r);
      else if (r.order_error) toast.error(`Order not placed: ${r.order_error.replace(/_/g, " ")}`);
      else {
        toast.success("Order placed. The administrator sets up your mailboxes and they appear in Email accounts.");
        setCart([]);
        setQuote(null);
        setTab("orders");
        qc.invalidateQueries({ queryKey: ["dfy-orders"] });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const orderCols: Column<Order>[] = [
    { key: "domain", header: "Domain", cell: (o) => <span className="font-medium">{o.domain}</span> },
    { key: "type", header: "Type", cell: (o) => (o.is_pre_warmed_up ? "Pre-warmed" : "New domain") },
    { key: "provider", header: "Mailboxes", cell: (o) => `${o.accounts_count} × ${PROVIDER_OPTIONS.find((p) => p.value === String(o.email_provider))?.label ?? "Mailbox"}` },
    { key: "status", header: "Status", cell: (o) => <Badge tone={o.status === "fulfilled" ? "ok" : o.status === "cancelled" ? "neutral" : "warn"}>{o.status.replace(/_/g, " ")}</Badge> },
    { key: "price", header: "Monthly", cell: (o) => (o.price_per_month !== null ? money(o.price_per_month) : "–") },
  ];
  const prewarmedList = prewarmed.data?.domains_with_type ?? [];
  return (
    <div className="mx-auto max-w-4xl">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> All options
      </button>
      <Callout tone="info" className="mb-4" title="How done-for-you works here">
        You choose domains and mailbox names; the order goes to this server's administrator, who registers the domains, creates the mailboxes and connects them. Payment is handled outside the app.
      </Callout>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "new", label: "New domains" },
          { value: "prewarmed", label: "Pre-warmed domains" },
          { value: "orders", label: "Your orders" },
        ]}
      />
      {tab !== "orders" && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
          <Card>
            {tab === "new" ? (
              <>
                <div className="flex gap-2">
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Search a domain or brand name" leading={<Search size={14} />} />
                  <Button onClick={search} loading={busy === "search"}>
                    Search
                  </Button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Input inputSize="sm" value={names.first} onChange={(e) => setNames({ ...names, first: e.target.value })} placeholder="Mailbox first name" />
                  <Input inputSize="sm" value={names.last} onChange={(e) => setNames({ ...names, last: e.target.value })} placeholder="Mailbox last name" />
                </div>
                <ul className="mt-4 divide-y divide-line">
                  {suggestions.map((s) => (
                    <li key={s.domain} className="flex items-center gap-3 py-2.5">
                      <Globe size={15} className="text-faint" />
                      <span className="flex-1 text-sm">{s.domain}</span>
                      {s.available ? (
                        <>
                          {pricing.data && <span className="text-xs text-muted">{money(pricing.data.domain_per_year)}/yr</span>}
                          <Button size="xs" variant="soft" icon={<Plus size={12} />} disabled={cart.some((c) => c.domain === s.domain)} onClick={() => addDomain(s.domain)}>
                            Add
                          </Button>
                        </>
                      ) : (
                        <Badge>Taken</Badge>
                      )}
                    </li>
                  ))}
                  {!suggestions.length && <EmptyState className="py-8" title="Find a sending domain" description="Use a domain close to your brand (getacme.com, tryacme.com) so your main domain's reputation stays protected." />}
                </ul>
              </>
            ) : (
              <ul className="divide-y divide-line">
                {prewarmedList.map((d) => (
                  <li key={d.domain} className="flex items-center gap-3 py-2.5">
                    <Sparkles size={15} className="text-warn" />
                    <span className="flex-1 text-sm">{d.domain}</span>
                    <span className="text-xs text-muted">{PROVIDER_OPTIONS.find((p) => p.value === String(d.account_type))?.label}</span>
                    <Button size="xs" variant="soft" icon={<Plus size={12} />} disabled={cart.some((c) => c.domain === d.domain)} onClick={() => addDomain(d.domain)}>
                      Add
                    </Button>
                  </li>
                ))}
                {!prewarmed.isLoading && !prewarmedList.length && <EmptyState className="py-8" title="No pre-warmed domains in stock" description="The administrator adds pre-warmed inventory. Order new domains instead." />}
              </ul>
            )}
          </Card>
          <Card className="h-fit">
            <h3 className="font-semibold">Order</h3>
            {!cart.length ? (
              <p className="mt-2 text-[13px] text-muted">Add domains to start an order.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {cart.map((c, i) => (
                  <li key={c.domain} className="rounded-lg border border-line p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate text-sm font-medium">{c.domain}</span>
                      <button type="button" aria-label="Remove" className="text-faint hover:text-bad" onClick={() => (setCart(cart.filter((x) => x.domain !== c.domain)), setQuote(null))}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <Select
                      size="sm"
                      className="mt-2"
                      value={String(c.email_provider)}
                      onChange={(v) => (setCart(cart.map((x, j) => (j === i ? { ...x, email_provider: Number(v) as 1 | 2 | 3 } : x))), setQuote(null))}
                      options={PROVIDER_OPTIONS}
                    />
                    <ul className="mt-2 space-y-1">
                      {c.accounts.map((a, k) => (
                        <li key={k} className="flex items-center gap-1 text-xs">
                          <input
                            className="w-28 rounded border border-line bg-panel px-1.5 py-0.5"
                            value={a.email_address_prefix}
                            onChange={(e) =>
                              setCart(cart.map((x, j) => (j === i ? { ...x, accounts: x.accounts.map((y, m) => (m === k ? { ...y, email_address_prefix: e.target.value.toLowerCase() } : y)) } : x)))
                            }
                          />
                          <span className="truncate text-muted">@{c.domain}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {quote && (
              <div className="mt-4 space-y-1 rounded-lg bg-panel-2 p-3 text-[13px]">
                {quote.order_error ? (
                  <p className="text-bad">{quote.order_error.replace(/_/g, " ")}</p>
                ) : (
                  <>
                    <p className="flex justify-between">
                      <span className="text-muted">Domains (yearly)</span>
                      {money(quote.total_domains_price_per_year)}
                    </p>
                    <p className="flex justify-between">
                      <span className="text-muted">Mailboxes (monthly)</span>
                      {money(quote.total_price_per_month)}
                    </p>
                  </>
                )}
              </div>
            )}
            <div className="mt-4 grid gap-2">
              <Button disabled={!cart.length} loading={busy === "quote"} onClick={() => submit(true)}>
                Get a quote
              </Button>
              <Button variant="primary" disabled={!quote || !!quote.order_error} loading={busy === "order"} onClick={() => submit(false)}>
                Place order
              </Button>
            </div>
          </Card>
        </div>
      )}
      {tab === "orders" && (
        <DataTable
          className="mt-5"
          rows={orders.data?.items ?? []}
          columns={orderCols}
          rowKey={(o) => o.id}
          loading={orders.isLoading}
          error={orders.error}
          onRetry={() => orders.refetch()}
          empty={<EmptyState title="No orders yet" />}
        />
      )}
    </div>
  );
}

export default function Connect() {
  usePageTitle("Add email accounts");
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const method = params.get("method") as Method | null;
  const preset = params.get("preset") ?? undefined;
  const go = (m: Method | null, extra: Record<string, string> = {}) => setParams(m ? { method: m, ...extra } : {});
  const back = () => go(null);
  // Viewers can change their mailboxes' settings, not add mailboxes.
  const allowed = can.write && can.perm("accounts");
  return (
    <Page>
      <PageHeader
        title="Add email accounts"
        description="Connect the mailboxes your campaigns will send from."
        back={
          <Link to="/app/accounts" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
            <ArrowLeft size={14} /> Email accounts
          </Link>
        }
      />
      {!allowed && (
        <EmptyState
          icon={<Mail size={22} />}
          title="Adding mailboxes is for editors and admins"
          description="Ask an admin of this workspace to connect the mailbox, or to give you a role that can."
          action={
            <Link to="/app/accounts" className="text-[13px] font-medium text-brand-text hover:underline">
              Back to email accounts
            </Link>
          }
        />
      )}
      {allowed && !method && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => go(m.key)}
              className={cn("group flex items-start gap-4 rounded-xl border border-line bg-panel p-5 text-left shadow-card transition-colors hover:border-brand")}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-panel-2">{m.icon}</span>
              <span>
                <span className="flex items-center gap-2 font-semibold">
                  {m.title}
                  {m.badge && <Badge tone="warn">{m.badge}</Badge>}
                </span>
                <span className="mt-1 block text-[13px] text-muted">{m.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {allowed && (method === "google" || method === "microsoft") && !preset && <OAuthChoice provider={method} onBack={back} onImap={() => go(method, { preset: method })} />}
      {allowed && (method === "imap" || ((method === "google" || method === "microsoft") && preset)) && <ImapForm preset={preset} onBack={back} />}
      {allowed && method === "csv" && <CsvImport onBack={back} />}
      {allowed && method === "sandbox" && <SandboxForm onBack={back} />}
      {allowed && method === "dfy" && <DoneForYou onBack={back} />}
      {allowed && method && !["google", "microsoft", "imap", "csv", "sandbox", "dfy"].includes(method) && (
        <EmptyState title="Unknown option" action={<Button onClick={back}>See all options</Button>} />
      )}
    </Page>
  );
}
