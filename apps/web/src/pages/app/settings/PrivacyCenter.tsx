// /app/settings/privacy — the installation admin's side of the public privacy center: requests people send about
// their data, abuse reports from email recipients, and the do-not-add list that keeps them out.
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, FileText, Flag, Inbox, ShieldOff, Trash2, UserX } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ago, dateTime, num, plural } from "@/lib/format";
import { useDebounced, usePageTitle } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { Badge, Button, Callout, DataTable, EmptyState, KeyValue, NativeSelect, SearchInput, Segmented, Sheet, StatCard, TabPanel, Tabs, Textarea, useConfirm, type Column, type Tone } from "@/components/ui";
import { SettingsHeader } from "./parts";

// ---------- Types ----------

type Choice = "access" | "delete" | "opt_out" | "correct" | "other";
type RequestStatus = "pending" | "verified" | "resolved" | "rejected";
type RequestType = "opt_out" | "data_request" | "removal";

interface PrivacyRequest {
  id: string;
  type: RequestType;
  status: RequestStatus;
  email: string;
  name: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  applicant_type: "self" | "agent" | null;
  country: string | null;
  state: string | null;
  requests: Choice[];
  message: string | null;
  matched: number | null;
  note: string | null;
  created_at: string;
  verified_at: string | null;
  resolved_at: string | null;
}

interface AbuseReport {
  id: string;
  status: "open" | "reviewed";
  lead_email: string;
  account_email: string | null;
  subject: string | null;
  workspace_id: string;
  workspace_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface Suppression {
  id: string;
  type: "email" | "linkedin";
  value: string;
  reason: "opt_out" | "removal" | "abuse";
  block_sending: boolean;
  created_at: string;
}

interface Summary {
  requests: { pending: number; waiting: number; total: number };
  abuse: { open: number; total: number };
  suppressions: number;
}

const TYPE_LABEL: Record<RequestType, string> = { opt_out: "Opt-out", data_request: "Data request", removal: "Privacy request" };
const CHOICE_LABEL: Record<Choice, string> = { access: "Copy of data", delete: "Delete", opt_out: "Stop using", correct: "Correct", other: "Other" };
const STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  pending: { label: "Unconfirmed", tone: "neutral" },
  verified: { label: "Needs you", tone: "warn" },
  resolved: { label: "Done", tone: "ok" },
  rejected: { label: "Closed", tone: "neutral" },
};
const REASON_LABEL: Record<Suppression["reason"], string> = { opt_out: "Opted out", removal: "Removal request", abuse: "Abuse report" };

const PAGE = 50;
const SUMMARY_KEY = ["privacy-admin", "summary"];

/** Offset paging over `{items, total}` lists. */
function usePaged<T>(key: unknown[], path: string, params: Record<string, string | undefined>) {
  return useInfiniteQuery({
    queryKey: ["privacy-admin", ...key],
    queryFn: ({ pageParam }) => get<{ items: T[]; total: number }>(path, { ...params, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

/** Saves a note when the field loses focus and changed. */
function NoteField({ value, onSave, placeholder }: { value: string | null; onSave: (note: string | null) => Promise<void>; placeholder: string }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <Textarea
      rows={3}
      value={text}
      placeholder={placeholder}
      aria-label="Internal note"
      maxLength={2000}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== (value ?? "").trim()) void onSave(text.trim() || null);
      }}
    />
  );
}

// ---------- Requests ----------

function RequestSheet({ request, onClose, onChanged }: { request: PrivacyRequest | null; onClose: () => void; onChanged: (r: PrivacyRequest) => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const r = request;
  /** Runs an action on the request, then says what happened. */
  const run = async (what: string, fn: () => Promise<{ request: PrivacyRequest; message: string }>) => {
    setBusy(what);
    try {
      const { request: updated, message } = await fn();
      onChanged(updated);
      toast.success(message);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (!r) return null;
  const closed = r.status === "resolved" || r.status === "rejected";
  const setStatus = (status: "verified" | "resolved" | "rejected", message: string) =>
    run(status, async () => ({ request: await patch<PrivacyRequest>(`/api/app/admin/privacy/requests/${r.id}`, { status }), message }));
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={r.name || r.email}
      description={`${TYPE_LABEL[r.type]} · received ${dateTime(r.created_at)}`}
      footer={
        closed ? (
          <Button loading={busy === "verified"} onClick={() => setStatus("verified", "Request reopened")}>
            Reopen
          </Button>
        ) : (
          <>
            <Button loading={busy === "rejected"} onClick={() => setStatus("rejected", "Request closed")}>
              Close without action
            </Button>
            <Button variant="primary" loading={busy === "resolved"} onClick={() => setStatus("resolved", "Marked as done")}>
              Mark as done
            </Button>
          </>
        )
      }
    >
      <div className="space-y-6 p-5">
        {r.status === "pending" && (
          <Callout tone="warn" title="Not confirmed yet">
            The person hasn't opened the link we emailed, so we don't know the request came from the owner of {r.email}. A data report only ever goes to that address.
          </Callout>
        )}
        {r.status === "verified" && (
          <Callout tone="info" title="Waiting for you">
            The person confirmed the request. The parts we can't do automatically are below: reply to them by email, then mark the request as done.
          </Callout>
        )}
        <KeyValue
          items={[
            ["Status", <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>],
            ["Email", <a href={`mailto:${r.email}`} className="text-brand-text hover:underline">{r.email}</a>],
            ["Name", r.name],
            ["Company", r.company_name],
            [
              "LinkedIn",
              r.linkedin_url ? (
                <a href={/^https?:\/\//i.test(r.linkedin_url) ? r.linkedin_url : `https://${r.linkedin_url}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                  {r.linkedin_url} <ExternalLink size={12} />
                </a>
              ) : null,
            ],
            ["Made by", r.applicant_type === "agent" ? "Someone acting for them" : r.applicant_type === "self" ? "The person themselves" : null],
            ["Where", [r.state, r.country].filter(Boolean).join(", ") || null],
            [
              "Asked for",
              <span className="flex flex-wrap gap-1">
                {r.requests.map((c) => (
                  <Badge key={c} tone={c === "correct" || c === "other" ? "warn" : "neutral"}>
                    {CHOICE_LABEL[c]}
                  </Badge>
                ))}
              </span>,
            ],
            ["Profiles found", r.matched === null ? <span className="text-faint">Not searched yet</span> : num(r.matched)],
            ["Confirmed", r.verified_at ? dateTime(r.verified_at) : null],
            ["Closed", r.resolved_at ? dateTime(r.resolved_at) : null],
          ]}
        />
        {r.message && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Their message</p>
            <p className="whitespace-pre-wrap rounded-lg border border-line bg-panel-2/60 px-3 py-2.5 text-[13px]">{r.message}</p>
          </div>
        )}
        <div>
          <p className="mb-2 text-[13px] font-medium">Lead Finder data</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<FileText size={14} />}
              loading={busy === "report"}
              onClick={() =>
                run("report", async () => ({
                  request: (await post<{ matched: number; request: PrivacyRequest }>(`/api/app/admin/privacy/requests/${r.id}/send-report`)).request,
                  message: `Data report sent to ${r.email}`,
                }))
              }
            >
              Email them their data
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<UserX size={14} />}
              loading={busy === "remove"}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: "Remove this person's profiles?",
                    description: r.linkedin_url
                      ? `Every shared profile matching ${r.email} or their LinkedIn link is deleted, and both go on the do-not-add list.`
                      : `Every shared profile matching ${r.email} is deleted, and the address goes on the do-not-add list.`,
                    confirmLabel: "Remove",
                    danger: true,
                  }))
                )
                  return;
                await run("remove", async () => {
                  const res = await post<{ removed: number; request: PrivacyRequest }>(`/api/app/admin/privacy/requests/${r.id}/remove`);
                  return {
                    request: res.request,
                    message: res.removed ? `Removed ${plural(res.removed, "profile")}. The address is on the do-not-add list.` : "No profile matched. The address is on the do-not-add list anyway.",
                  };
                });
              }}
            >
              Remove from the data
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">Both act on the shared directory only. Workspaces keep the leads they already added.</p>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Internal note</p>
          <NoteField
            value={r.note}
            placeholder="What you did or told them. Only admins see this."
            onSave={async (note) => {
              try {
                onChanged(await patch<PrivacyRequest>(`/api/app/admin/privacy/requests/${r.id}`, { note }));
                toast.success("Note saved");
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          />
        </div>
      </div>
    </Sheet>
  );
}

function RequestsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"all" | RequestStatus>("verified");
  const [type, setType] = useState<"" | RequestType>("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [open, setOpen] = useState<PrivacyRequest | null>(null);
  const list = usePaged<PrivacyRequest>(["requests", status, type, q], "/api/app/admin/privacy/requests", {
    status: status === "all" ? undefined : status,
    type: type || undefined,
    search: q || undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<PrivacyRequest>[] = [
    {
      key: "person",
      header: "Person",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.name || r.email}</p>
          {r.name && <p className="truncate text-xs text-muted">{r.email}</p>}
        </div>
      ),
    },
    { key: "type", header: "Type", cell: (r) => TYPE_LABEL[r.type], hideBelow: "sm" },
    {
      key: "asked",
      header: "Asked for",
      hideBelow: "md",
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.requests.map((c) => (
            <Badge key={c} tone={c === "correct" || c === "other" ? "warn" : "neutral"}>
              {CHOICE_LABEL[c]}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: "status", header: "Status", cell: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> },
    { key: "received", header: "Received", cell: (r) => <span className="whitespace-nowrap text-muted">{ago(r.created_at)}</span>, hideBelow: "sm" },
  ];
  const changed = (r: PrivacyRequest) => {
    setOpen(r);
    void qc.invalidateQueries({ queryKey: ["privacy-admin"] });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: "verified", label: "Needs you" },
            { value: "pending", label: "Unconfirmed" },
            { value: "resolved", label: "Done" },
            { value: "rejected", label: "Closed" },
            { value: "all", label: "All" },
          ]}
        />
        <NativeSelect
          size="sm"
          className="w-40"
          value={type}
          onChange={(v) => setType(v as "" | RequestType)}
          aria-label="Request type"
          options={[
            { value: "", label: "All types" },
            { value: "opt_out", label: "Opt-outs" },
            { value: "data_request", label: "Data requests" },
            { value: "removal", label: "Privacy requests" },
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or email" className="w-full sm:ml-auto sm:w-60" />
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowClick={setOpen}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={
          <EmptyState
            icon={<Inbox size={22} />}
            title={status === "verified" ? "Nothing needs you" : "No requests here"}
            description={status === "verified" ? "Requests land here once the person confirms them and something can't be done automatically, like a correction." : "Try another filter."}
          />
        }
      />
      <RequestSheet request={open} onClose={() => setOpen(null)} onChanged={changed} />
    </div>
  );
}

// ---------- Abuse reports ----------

function AbuseSheet({ report, onClose, onChanged }: { report: AbuseReport | null; onClose: () => void; onChanged: (patch: Partial<AbuseReport>) => void }) {
  const [busy, setBusy] = useState(false);
  if (!report) return null;
  const r = report;
  const save = async (body: { status?: "open" | "reviewed"; note?: string | null }, done: string) => {
    setBusy(true);
    try {
      await patch(`/api/app/admin/privacy/abuse-reports/${r.id}`, body);
      // Only what changed: a note saved on blur and a status click can finish in either order.
      onChanged({ ...body, ...(body.status ? { reviewed_at: body.status === "reviewed" ? new Date().toISOString() : null } : {}) });
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={r.subject || "(no subject)"}
      description={`Reported ${dateTime(r.created_at)}`}
      footer={
        r.status === "open" ? (
          <Button variant="primary" loading={busy} onClick={() => save({ status: "reviewed" }, "Marked as reviewed")}>
            Mark as reviewed
          </Button>
        ) : (
          <Button loading={busy} onClick={() => save({ status: "open" }, "Report reopened")}>
            Reopen
          </Button>
        )
      }
    >
      <div className="space-y-6 p-5">
        <Callout tone="info">
          The recipient is already unsubscribed from that workspace and on the do-not-add list, so no campaign here can email them. The workspace's owners and admins were told.
        </Callout>
        <KeyValue
          items={[
            ["Status", <Badge tone={r.status === "open" ? "warn" : "ok"}>{r.status === "open" ? "Open" : "Reviewed"}</Badge>],
            ["Reported by", r.lead_email],
            ["Sent from", r.account_email],
            ["Workspace", r.workspace_name ?? <span className="text-faint">Deleted</span>],
            ["Campaign", r.campaign_name ?? (r.campaign_id ? <span className="text-faint">Deleted</span> : <span className="text-faint">Not from a campaign</span>)],
            ["Reviewed", r.reviewed_at ? dateTime(r.reviewed_at) : null],
          ]}
        />
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Internal note</p>
          <NoteField value={r.note} placeholder="What you found, or what you told the workspace." onSave={(note) => save({ note }, "Note saved")} />
        </div>
      </div>
    </Sheet>
  );
}

function AbuseTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"open" | "reviewed" | "all">("open");
  const [open, setOpen] = useState<AbuseReport | null>(null);
  const list = usePaged<AbuseReport>(["abuse", status], "/api/app/admin/privacy/abuse-reports", { status: status === "all" ? undefined : status });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<AbuseReport>[] = [
    { key: "who", header: "Reported by", cell: (r) => <span className="font-medium">{r.lead_email}</span> },
    {
      key: "email",
      header: "Email",
      hideBelow: "md",
      cell: (r) => (
        <div className="min-w-0 max-w-xs">
          <p className="truncate">{r.subject || "(no subject)"}</p>
          {r.account_email && <p className="truncate text-xs text-muted">from {r.account_email}</p>}
        </div>
      ),
    },
    { key: "ws", header: "Workspace", hideBelow: "lg", cell: (r) => <span className="text-muted">{[r.workspace_name, r.campaign_name].filter(Boolean).join(" · ") || "–"}</span> },
    { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "open" ? "warn" : "ok"}>{r.status === "open" ? "Open" : "Reviewed"}</Badge> },
    { key: "when", header: "Received", hideBelow: "sm", cell: (r) => <span className="whitespace-nowrap text-muted">{ago(r.created_at)}</span> },
  ];
  return (
    <div className="space-y-3">
      <Segmented
        size="sm"
        value={status}
        onChange={setStatus}
        options={[
          { value: "open", label: "Open" },
          { value: "reviewed", label: "Reviewed" },
          { value: "all", label: "All" },
        ]}
      />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowClick={setOpen}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={<EmptyState icon={<Flag size={22} />} title={status === "open" ? "No open reports" : "No reports here"} description="People emailed after being found in the Lead Finder data can report it through the link in the email's X-Report-Abuse header." />}
      />
      <AbuseSheet
        report={open}
        onClose={() => setOpen(null)}
        onChanged={(patch) => {
          setOpen((cur) => (cur ? { ...cur, ...patch } : cur));
          void qc.invalidateQueries({ queryKey: ["privacy-admin"] });
        }}
      />
    </div>
  );
}

// ---------- Do-not-add list ----------

function SuppressionsTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const list = usePaged<Suppression>(["suppressions", q], "/api/app/admin/privacy/suppressions", { search: q || undefined });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const lift = async (s: Suppression) => {
    if (
      !(await confirm({
        title: `Take ${s.value} off the list?`,
        description: s.block_sending
          ? "It can be imported into the Lead Finder data again, and campaigns can email it again. Only do this if the report or request was a mistake."
          : "It can be imported into the Lead Finder data again. Only do this if the request was a mistake.",
        confirmLabel: "Take off the list",
        danger: true,
      }))
    )
      return;
    try {
      await del(`/api/app/admin/privacy/suppressions/${s.id}`);
      toast.success("Taken off the list");
      await qc.invalidateQueries({ queryKey: ["privacy-admin"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const columns: Column<Suppression>[] = [
    {
      key: "value",
      header: "Email or profile",
      cell: (s) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{s.value}</p>
          <p className="text-xs text-muted sm:hidden">{REASON_LABEL[s.reason]}</p>
        </div>
      ),
    },
    { key: "reason", header: "Why", hideBelow: "sm", cell: (s) => REASON_LABEL[s.reason] },
    { key: "sending", header: "Campaigns", hideBelow: "md", cell: (s) => (s.block_sending ? <Badge tone="bad">Blocked</Badge> : <span className="text-muted">Allowed</span>) },
    { key: "when", header: "Added", hideBelow: "md", cell: (s) => <span className="whitespace-nowrap text-muted">{ago(s.created_at)}</span> },
    {
      key: "lift",
      header: <span className="sr-only">Actions</span>,
      className: "w-px text-right",
      cell: (s) => (
        <Button size="icon-sm" variant="ghost" aria-label={`Take ${s.value} off the list`} onClick={() => lift(s)}>
          <Trash2 size={14} />
        </Button>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        These addresses and LinkedIn profiles are never imported into the shared Lead Finder data. Entries from abuse reports also stop every campaign on this installation from emailing the address.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search emails or profiles" className="w-full sm:w-64" />
        <span className="text-[13px] text-muted">{total !== undefined ? `${num(total)} ${total === 1 ? "entry" : "entries"}` : ""}</span>
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(s) => s.id}
        loading={list.isLoading}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={<EmptyState icon={<ShieldOff size={22} />} title={q ? "No matches" : "The list is empty"} description={q ? "Try another search." : "People who opt out, ask for removal or report an email are added here."} />}
      />
    </div>
  );
}

// ---------- Page ----------

export default function PrivacyCenter() {
  usePageTitle("Privacy center");
  const me = useSession();
  const [tab, setTab] = useState<"requests" | "abuse" | "suppressions">("requests");
  const summary = useQuery({ queryKey: SUMMARY_KEY, queryFn: () => get<Summary>("/api/app/admin/privacy/summary"), enabled: !!me.features.instance_admin });
  const s = summary.data;
  if (!me.features.instance_admin)
    return <EmptyState icon={<ShieldOff size={24} />} title="Only installation admins can open this page" description="Ask whoever runs this installation if you need to handle a privacy request." />;
  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Privacy center"
        description="Requests from people in the Lead Finder data, unwanted-email reports from recipients, and the do-not-add list. This page covers the whole installation, not just this workspace."
        actions={
          <a href="/privacy/info" target="_blank" rel="noreferrer" className="-my-1 inline-flex items-center gap-1.5 py-1 text-[13px] font-medium text-brand-text hover:underline">
            Public page <ExternalLink size={13} />
          </a>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Needs you" value={s ? num(s.requests.waiting) : "–"} tone={s?.requests.waiting ? "warn" : undefined} icon={<Inbox size={14} />} onClick={() => setTab("requests")} />
        <StatCard label="Unconfirmed requests" value={s ? num(s.requests.pending) : "–"} sub={s ? `${num(s.requests.total)} in total` : undefined} />
        <StatCard label="Open abuse reports" value={s ? num(s.abuse.open) : "–"} tone={s?.abuse.open ? "bad" : undefined} icon={<Flag size={14} />} onClick={() => setTab("abuse")} />
        <StatCard label="Do-not-add list" value={s ? num(s.suppressions) : "–"} icon={<ShieldOff size={14} />} onClick={() => setTab("suppressions")} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "requests", label: "Requests" },
          { value: "abuse", label: "Abuse reports" },
          { value: "suppressions", label: "Do-not-add list" },
        ]}
      >
        <TabPanel value="requests" className="pt-4">
          <RequestsTab />
        </TabPanel>
        <TabPanel value="abuse" className="pt-4">
          <AbuseTab />
        </TabPanel>
        <TabPanel value="suppressions" className="pt-4">
          <SuppressionsTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}
