import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { toast } from "sonner";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { LEAD_IMPORT_MAX, emailFromCell, isValidEmailSyntax, peopleIn, splitFullName, unescapeCsvFormula } from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { followJob, jobDone, useJob, type Job } from "@/lib/jobs";
import { num, plural } from "@/lib/format";
import { Badge, Button, Callout, Checkbox, Dialog, Field, Input, NativeSelect, Progress, Segmented, Tabs, Textarea } from "@/components/ui";

type Mode = "csv" | "paste" | "sheet" | "single";

const TARGETS = [
  ["email", "Email"],
  ["full_name", "Full name (first and last)"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["company_name", "Company name"],
  ["company_domain", "Company domain"],
  ["job_title", "Job title"],
  ["website", "Website"],
  ["phone", "Phone"],
  ["linkedin_url", "LinkedIn URL"],
  ["location", "Location"],
  ["timezone", "Timezone"],
  ["personalization", "Personalization"],
] as const;
// "Full name" isn't a lead field: it's split into first and last name.
const STANDARD = new Set<string>(TARGETS.map(([k]) => k).filter((k) => k !== "full_name"));

/** Guess the lead field for a spreadsheet header ("First Name", "e-mail", "Company"…). */
function guess(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z]/g, "");
  const table: Record<string, string> = {
    email: "email",
    emailaddress: "email",
    mail: "email",
    workemail: "email",
    firstname: "first_name",
    first: "first_name",
    givenname: "first_name",
    name: "full_name",
    fullname: "full_name",
    contactname: "full_name",
    contact: "full_name",
    leadname: "full_name",
    personname: "full_name",
    lastname: "last_name",
    last: "last_name",
    surname: "last_name",
    familyname: "last_name",
    company: "company_name",
    companyname: "company_name",
    organization: "company_name",
    organisation: "company_name",
    account: "company_name",
    domain: "company_domain",
    companydomain: "company_domain",
    title: "job_title",
    jobtitle: "job_title",
    position: "job_title",
    role: "job_title",
    website: "website",
    url: "website",
    companywebsite: "website",
    phone: "phone",
    phonenumber: "phone",
    mobile: "phone",
    linkedin: "linkedin_url",
    linkedinurl: "linkedin_url",
    linkedinprofile: "linkedin_url",
    location: "location",
    city: "location",
    timezone: "timezone",
    tz: "timezone",
    timezonename: "timezone",
    leadtimezone: "timezone",
    personalization: "personalization",
    icebreaker: "personalization",
    personalisedline: "personalization",
  };
  return table[h] ?? `custom:${header.trim()}`;
}

/** Leads a request carries: a bigger file goes in parts, the rest following while the import runs. */
const IMPORT_PART = 2000;

interface ImportResult {
  leads_uploaded: number;
  in_blocklist: number;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  duplicate_email_count: number;
  over_plan_limit?: number;
}

/** Leads an import added before it failed or was stopped (its running count). */
const addedSoFar = (job: Job<ImportResult>) => ((job.data?.counts as Partial<ImportResult> | undefined)?.leads_uploaded ?? 0);

/** Once an import ends, however it ends and whether or not the dialog is still open: refresh what it changed and say how it went. */
function importEnded(qc: QueryClient, job: Job<ImportResult> | null) {
  for (const queryKey of [["leads"], ["campaign"], ["campaigns"], ["lead-lists"]]) qc.invalidateQueries({ queryKey });
  if (!job) {
    toast.warning("Lost track of the import. The new leads show up in the list once it's done.");
    return;
  }
  const added = job.status === "success" ? (job.result?.leads_uploaded ?? 0) : addedSoFar(job);
  const over = job.status === "success" ? (job.result?.over_plan_limit ?? 0) : 0;
  if (over) toast.warning(`Import finished: ${plural(added, "lead")} added`, { description: `${num(over)} more weren't added: your plan's contact limit was reached.` });
  else if (job.status === "success") toast.success(`Import finished: ${plural(added, "lead")} added`);
  else if (job.status === "cancelled") toast.warning(`Import stopped${added ? ` after adding ${plural(added, "lead")}` : ""}`);
  else toast.error(`Import failed${added ? ` after adding ${plural(added, "lead")}` : ""}`, { description: job.error ?? undefined });
}

export function AddLeadsDialog({
  open,
  onOpenChange,
  campaignId,
  listId,
  title = "Add leads",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId?: string;
  listId?: string;
  title?: string;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("csv");
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  // How many rows the file or sheet had, when that's more than one import takes (only the first LEAD_IMPORT_MAX go in).
  const [cut, setCut] = useState<number | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [paste, setPaste] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [single, setSingle] = useState<Record<string, string>>({});
  // Duplicates in the destination itself are always left out; the choice is how much wider to look.
  const [dupScope, setDupScope] = useState<"target" | "same_kind" | "workspace">(campaignId ? "same_kind" : "target");
  const [verify, setVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  // The import couldn't be followed to its end (the server stopped answering about it): the dialog can still close.
  const [lost, setLost] = useState(false);
  const job = useJob<ImportResult>(jobId);

  useEffect(() => {
    if (!open) {
      setRows([]);
      setHeaders([]);
      setMapping({});
      setFileName("");
      setPaste("");
      setSheetUrl("");
      setSingle({});
      setJobId(null);
    }
  }, [open]);

  const loadTable = (data: Array<Record<string, string>>, cols: string[], total = data.length) => {
    setRows(data.length > LEAD_IMPORT_MAX ? data.slice(0, LEAD_IMPORT_MAX) : data);
    setCut(total > LEAD_IMPORT_MAX ? total : null);
    setHeaders(cols);
    setMapping(Object.fromEntries(cols.map((c) => [c, guess(c)])));
  };

  const parseFile = (file: File) => {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transform: unescapeCsvFormula,
      complete: (r) => loadTable(r.data, r.meta.fields ?? []),
      error: (e) => toast.error(e.message),
    });
  };

  const fetchSheet = async () => {
    setBusy(true);
    try {
      const r = await post<{ columns: string[]; rows: Array<Record<string, string>>; total: number }>("/api/app/leads/import-sheet", { url: sheetUrl, campaign_id: campaignId, list_id: listId });
      loadTable(r.rows, r.columns, r.total);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const mapped = useMemo(() => {
    if (mode === "paste") {
      // Addresses however they're pasted: one per line, comma-separated, or "Jo Doe <jo@x.com>" from an email (the name
      // is kept).
      return peopleIn(paste).filter((p) => isValidEmailSyntax(p.email));
    }
    if (mode === "single") return single.email ? [Object.fromEntries(Object.entries(single).filter(([, v]) => v.trim()))] : [];
    return rows.map((r) => {
      const lead: Record<string, unknown> = {};
      const custom: Record<string, string> = {};
      let fullName = "";
      // Two columns for one field ("Email" and "Work email"): the first that has something wins, the next fills in where
      // it's empty, so neither quietly replaces the other.
      for (const [col, target] of Object.entries(mapping)) {
        const v = (r[col] ?? "").trim();
        if (!v || target === "skip") continue;
        if (target.startsWith("custom:")) custom[target.slice(7)] ??= v;
        else if (target === "full_name") fullName ||= v;
        else if (STANDARD.has(target) && lead[target] === undefined) lead[target] = target === "email" ? emailFromCell(v) : v;
      }
      // First and last name columns, when there are any, win over the parts of a full name.
      if (fullName) {
        const n = splitFullName(fullName);
        if (!lead.first_name && n.first_name) lead.first_name = n.first_name;
        if (!lead.last_name && n.last_name) lead.last_name = n.last_name;
      }
      if (Object.keys(custom).length) lead.custom_variables = custom;
      return lead;
    });
  }, [mode, paste, single, rows, mapping]);

  const withEmail = mapped.filter((l) => typeof l.email === "string" && l.email).length;
  const hasEmailColumn = mode !== "csv" && mode !== "sheet" ? true : Object.values(mapping).includes("email");

  const start = async () => {
    setBusy(true);
    try {
      const parts = Array.from({ length: Math.ceil(mapped.length / IMPORT_PART) }, (_, i) => mapped.slice(i * IMPORT_PART, (i + 1) * IMPORT_PART));
      const j = await post<{ id: string }>("/api/app/leads/import", {
        campaign_id: campaignId,
        list_id: listId,
        leads: parts[0],
        ...(parts.length > 1 ? { parts: parts.length, total: mapped.length } : {}),
        skip_if_in_workspace: dupScope === "workspace",
        skip_if_in_campaign: dupScope === "same_kind" && !!campaignId,
        skip_if_in_list: dupScope === "same_kind" && !campaignId && !!listId,
        verify_leads_on_import: verify,
        source: mode === "csv" ? "csv" : mode === "sheet" ? "sheet" : "manual",
      });
      setJobId(j.id);
      setLost(false);
      // Followed to the end even after the dialog closes, so the list always refreshes.
      followJob<ImportResult>(qc, j.id, (done) => {
        importEnded(qc, done);
        if (!done) setLost(true);
      });
      // The rest of a big file, a part at a time while the import works through what came before (a part that doesn't
      // get through is tried twice more).
      for (let i = 1; i < parts.length; i++) {
        for (let attempt = 1; ; attempt++) {
          try {
            await post(`/api/app/leads/import/${j.id}/parts`, { seq: i + 1, leads: parts[i] });
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        }
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const r = job.data?.result;
  const finished = jobDone(job.data);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={title}
      description={campaignId ? "New leads start the sequence from step 1 when the campaign runs." : "Leads are saved to the list; add them to a campaign whenever you're ready."}
      footer={
        jobId ? (
          <Button variant="primary" onClick={() => onOpenChange(false)} disabled={!finished && !lost}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!withEmail || !hasEmailColumn} onClick={start}>
              {withEmail ? `Import ${num(withEmail)} lead${withEmail === 1 ? "" : "s"}` : "Import"}
            </Button>
          </>
        )
      }
    >
      {jobId ? (
        <div className="space-y-4 py-2">
          {!finished && lost ? (
            <Callout tone="warn" title="Lost track of the import">
              It may still be running on the server. The new leads show up in the list once it's done.
            </Callout>
          ) : !finished ? (
            <>
              <Progress value={job.data?.progress ?? 0} />
              <p className="text-[13px] text-muted">Importing… you can close this window; the import keeps running.</p>
            </>
          ) : job.data?.status !== "success" ? (
            <Callout tone="bad" title={job.data?.status === "cancelled" ? "Import stopped" : "Import failed"}>
              {job.data?.error}
              {job.data && addedSoFar(job.data) > 0 && <p>{plural(addedSoFar(job.data), "lead")} added before it stopped.</p>}
            </Callout>
          ) : (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 size={18} className="text-ok" /> {plural(r?.leads_uploaded ?? 0, "lead")} added
              </p>
              <div className="flex flex-wrap gap-2">
                {!!r?.duplicated_leads && <Badge>{num(r.duplicated_leads)} already there</Badge>}
                {!!r?.skipped_count && <Badge>{num(r.skipped_count)} skipped</Badge>}
                {!!r?.in_blocklist && <Badge tone="warn">{num(r.in_blocklist)} on the block list</Badge>}
                {!!r?.invalid_email_count && <Badge tone="bad">{num(r.invalid_email_count)} invalid emails</Badge>}
                {!!r?.duplicate_email_count && <Badge>{num(r.duplicate_email_count)} duplicate rows</Badge>}
                {!!r?.over_plan_limit && <Badge tone="warn">{num(r.over_plan_limit)} over your plan's contact limit</Badge>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <Tabs
          value={mode}
          onChange={(m) => {
            setMode(m);
            setRows([]);
            setHeaders([]);
          }}
          tabs={[
            { value: "csv", label: "Upload CSV" },
            { value: "paste", label: "Paste emails" },
            { value: "sheet", label: "Google Sheet" },
            { value: "single", label: "One lead" },
          ]}
        >
          <div className="space-y-4 pt-4">
            {mode === "csv" && !rows.length && (
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong px-6 py-10 text-center hover:border-brand hover:bg-brand-soft/40">
                <Upload size={22} className="text-muted" />
                <span className="text-sm font-medium">{fileName || "Choose a CSV file"}</span>
                <span className="text-xs text-muted">Any columns work — you'll map them in the next step.</span>
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && parseFile(e.target.files[0])} />
              </label>
            )}
            {mode === "sheet" && !rows.length && (
              <div className="space-y-2">
                <Field label="Sheet link" hint="Share the sheet as “Anyone with the link can view”. The first row must contain column names.">
                  {(id) => <Input id={id} value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />}
                </Field>
                <Button onClick={fetchSheet} loading={busy} disabled={!sheetUrl.includes("docs.google.com")} icon={<FileSpreadsheet size={14} />}>
                  Load sheet
                </Button>
              </div>
            )}
            {(mode === "csv" || mode === "sheet") && rows.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[13px] font-medium">
                    Map {plural(headers.length, "column")} · {plural(rows.length, "row")}
                  </p>
                  <button type="button" className="text-xs text-brand-text hover:underline" onClick={() => (setRows([]), setHeaders([]))}>
                    Choose another file
                  </button>
                </div>
                {!hasEmailColumn && <Callout tone="bad" className="mb-2">Map one column to Email.</Callout>}
                {cut !== null && (
                  <Callout tone="warn" className="mb-2">
                    This {mode === "sheet" ? "sheet" : "file"} has {num(cut)} rows. One import takes up to {num(LEAD_IMPORT_MAX)}, so the first {num(LEAD_IMPORT_MAX)} are imported. Put the rest in{" "}
                    {mode === "sheet" ? "another sheet" : "a second file"} and import that afterwards.
                  </Callout>
                )}
                <div className="scroll-thin max-h-72 overflow-y-auto rounded-lg border border-line">
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-panel-2 text-left text-xs text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Column</th>
                        <th className="px-3 py-2 font-medium">Example</th>
                        <th className="px-3 py-2 font-medium">Import as</th>
                      </tr>
                    </thead>
                    <tbody>
                      {headers.map((h, i) => (
                        <tr key={h} className="border-t border-line">
                          <td className="px-3 py-1.5 font-medium">{h}</td>
                          <td className="max-w-[12rem] truncate px-3 py-1.5 text-muted">{rows.find((r) => r[h])?.[h] ?? ""}</td>
                          <td className="px-3 py-1.5">
                            <NativeSelect
                              size="sm"
                              aria-label={`Import ${h.trim() || "this column"} as`}
                              value={mapping[h] ?? "skip"}
                              onChange={(v) => setMapping({ ...mapping, [h]: v })}
                              options={[
                                { value: "skip", label: "Don't import" },
                                { group: "Lead fields", options: TARGETS.map(([k, l]) => ({ value: k, label: l })) },
                                { group: "Custom variable", options: [{ value: `custom:${h.trim()}`, label: `{{${h.trim()}}}` }] },
                              ]}
                            />
                            {(() => {
                              const target = mapping[h];
                              const first = target && target !== "skip" && !target.startsWith("custom:") ? headers.slice(0, i).find((e) => mapping[e] === target) : undefined;
                              return first ? <p className="mt-0.5 text-[11px] text-muted">Used where “{first}” is empty</p> : null;
                            })()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {mode === "paste" && (
              <Field label="Email addresses" hint={`${plural(mapped.length, "valid address", "valid addresses")} found. Separate with new lines, commas or spaces; a name in front, as in Jo Doe <jo@acme.com>, is kept.`}>
                {(id) => <Textarea id={id} rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"jane@acme.com\nsam@example.org"} />}
              </Field>
            )}
            {mode === "single" && (
              <div className="grid gap-3 sm:grid-cols-2">
                {TARGETS.filter(([k]) => STANDARD.has(k)).map(([k, l]) => (
                  <Field key={k} label={l} className={k === "personalization" ? "sm:col-span-2" : undefined}>
                    {(id) => (
                      <Input
                        id={id}
                        type={k === "email" ? "email" : "text"}
                        value={single[k] ?? ""}
                        placeholder={k === "timezone" ? "From the location when left empty" : undefined}
                        onChange={(e) => setSingle({ ...single, [k]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}
            <div className="space-y-3 rounded-lg bg-panel-2 p-3">
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium">Leave out people already in</p>
                <Segmented
                  size="sm"
                  value={dupScope}
                  onChange={setDupScope}
                  options={[
                    { value: "target", label: campaignId ? "This campaign" : listId ? "This list" : "Nowhere" },
                    ...(campaignId || listId ? [{ value: "same_kind" as const, label: campaignId ? "Any campaign" : "Any list" }] : []),
                    { value: "workspace", label: "Anywhere" },
                  ]}
                />
                <p className="text-xs text-muted">
                  {dupScope === "workspace"
                    ? "Leaves out anyone who is already in a campaign or a list."
                    : dupScope === "same_kind"
                      ? campaignId
                        ? "Leaves out people who are in another campaign too, so nobody gets two sequences at once."
                        : "Leaves out people who are already in another list."
                      : campaignId || listId
                        ? `People already in this ${campaignId ? "campaign" : "list"} are always left out.`
                        : "Everyone in the file is added."}
                </p>
              </div>
              <Checkbox label="Verify emails while importing" checked={verify} onChange={setVerify} />
            </div>
          </div>
        </Tabs>
      )}
    </Dialog>
  );
}
