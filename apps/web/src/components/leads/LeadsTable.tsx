import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowRightLeft, CheckCheck, Download, Eye, MessageSquareReply, MousePointerClick, Pause, PencilLine, Play, ShieldCheck, ShieldHalf, Trash2, UserPlus, Users } from "lucide-react";
import { ESG_LABELS, ESP_LABELS, EsgCode, EspCode, LeadStatus } from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { todayIn } from "@/lib/dates";
import { waitForJob, type Job } from "@/lib/jobs";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useDebounced } from "@/lib/hooks";
import { useLeadStatuses } from "@/lib/statuses";
import { ago, downloadBlob, fullName, num, plural } from "@/lib/format";
import { deletedToast, restorable } from "@/lib/recently-deleted";
import type { Lead } from "@/lib/types";
import { useCampaignNames, useListNames } from "@/lib/pickers";
import { InterestBadge, LeadStatusBadge, VerificationBadge, VisitedMark } from "@/components/status";
import {
  Avatar,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Progress,
  SearchInput,
  Segmented,
  Select,
  SelectionBar,
  emptySelection,
  useConfirm,
  type Column,
  type Selection,
} from "@/components/ui";
import { AddLeadsDialog } from "./AddLeadsDialog";
import { EditFieldDialog } from "./EditFieldDialog";
import { useEnrichmentColumns } from "./EnrichmentColumns";
import { apiRules, useFilterBuilder, useLeadQuery } from "./LeadFilters";
import { LeadSheet } from "./LeadSheet";

const FILTERS = [
  { value: "", label: "All leads" },
  { value: "FILTER_VAL_NOT_CONTACTED", label: "Not yet contacted" },
  { value: "FILTER_VAL_CONTACTED", label: "Contacted" },
  { value: "FILTER_VAL_ACTIVE", label: "In progress" },
  { value: "FILTER_VAL_REPLIED", label: "Replied" },
  { value: "FILTER_VAL_OPENED_NO_REPLY", label: "Opened, no reply" },
  { value: "FILTER_VAL_NO_OPENS", label: "Contacted, no opens" },
  { value: "FILTER_VAL_LINK_CLICKED", label: "Clicked a link" },
  { value: "FILTER_VAL_COMPLETED", label: "Completed" },
  { value: "FILTER_VAL_COMPLETED_NO_REPLY", label: "Completed, no reply" },
  { value: "FILTER_VAL_BOUNCED", label: "Bounced" },
  { value: "FILTER_VAL_UNSUBSCRIBED", label: "Unsubscribed" },
  { value: "FILTER_VAL_SKIPPED", label: "Skipped" },
  { value: "FILTER_VAL_IN_SUBSEQUENCE", label: "In a subsequence" },
  { value: "FILTER_VAL_WEBSITE_VISITOR", label: "Visited your website" },
  { value: "FILTER_VAL_VALID", label: "Verified emails" },
  { value: "FILTER_VAL_RISKY", label: "Risky emails" },
  { value: "FILTER_VAL_CATCH_ALL", label: "Catch-all emails" },
  { value: "FILTER_VAL_INVALID", label: "Invalid emails" },
  { value: "FILTER_VAL_NOT_VERIFIED", label: "Not verified" },
];

const LIST_FILTERS = new Set(["", "FILTER_VAL_VALID", "FILTER_VAL_RISKY", "FILTER_VAL_CATCH_ALL", "FILTER_VAL_INVALID", "FILTER_VAL_NOT_VERIFIED", "FILTER_VAL_WEBSITE_VISITOR"]);

interface ListPage {
  items: Lead[];
  next_starting_after: string | null;
  total?: number;
}

/** What the provider line says when no provider is named. */
const ESP_TEXT: Record<number, string> = { [EspCode.IN_QUEUE]: "Checking…", [EspCode.OTHER]: "Other provider", [EspCode.NOT_FOUND]: "No mail server" };
/** Gateway codes that name no gateway: not looked up yet, or none. */
const UNNAMED_ESG: number[] = [EsgCode.IN_QUEUE, EsgCode.NONE];

/**
 * Under the email check: the lead's mailbox provider, or the security gateway in front of it when there is one (the
 * provider is then in the tooltip). The lead panel shows both.
 */
function MailRoute({ lead }: { lead: Lead }) {
  if (!lead.email) return null;
  const provider = ESP_TEXT[lead.esp_code] ?? ESP_LABELS[lead.esp_code] ?? ESP_TEXT[EspCode.OTHER]!;
  const gateway = UNNAMED_ESG.includes(lead.esg_code) ? null : ESG_LABELS[lead.esg_code];
  return (
    <p className="mt-0.5 flex items-center gap-1 whitespace-nowrap text-xs text-muted" title={gateway ? `${provider}, behind ${gateway}: a security gateway that checks links and attachments` : undefined}>
      {gateway ? (
        <>
          <ShieldHalf size={11} className="shrink-0" aria-hidden />
          <span className="sr-only">Security gateway: </span>
          {gateway}
        </>
      ) : (
        provider
      )}
    </p>
  );
}

function Counter({ icon, n, title }: { icon: ReactNode; n: number; title: string }) {
  return (
    <span title={title} className={n ? "inline-flex items-center gap-1 text-text" : "inline-flex items-center gap-1 text-faint"}>
      {icon}
      <span className="tabular-nums">{n}</span>
    </span>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  target,
  count,
  excludeCampaign,
  excludeList,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: Record<string, unknown>;
  count: number;
  excludeCampaign?: string;
  excludeList?: string;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"campaign" | "list">("campaign");
  const [dest, setDest] = useState("");
  const [copy, setCopy] = useState(false);
  const [skipDupes, setSkipDupes] = useState(true);
  const [skipInvalid, setSkipInvalid] = useState(true);
  const [resetStatus, setResetStatus] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const campaigns = useCampaignNames(open);
  const lists = useListNames(open);
  useEffect(() => {
    if (open) {
      setDest("");
      setProgress(null);
    }
  }, [open, kind]);
  const options = (kind === "campaign" ? campaigns.data?.items.filter((c) => c.id !== excludeCampaign) : lists.data?.items.filter((l) => l.id !== excludeList)) ?? [];
  const run = async () => {
    setProgress(0);
    try {
      const job = await post<Job>("/api/v2/leads/move", {
        ...target,
        ...(kind === "campaign" ? { to_campaign_id: dest } : { to_list_id: dest }),
        copy_leads: copy,
        check_duplicates: skipDupes,
        check_duplicates_in_campaigns: skipDupes && kind === "campaign",
        skip_invalid_emails: kind === "campaign" && skipInvalid,
        reset_interest_status: resetStatus,
      });
      const done = await waitForJob<{ moved_count: number; skipped_count: number }>(job.id, setProgress);
      if (done.status !== "success") throw new Error(done.error ?? "The move failed");
      await qc.invalidateQueries({ queryKey: ["leads"] });
      await qc.invalidateQueries({ queryKey: ["campaign"] });
      const r = done.result;
      toast.success(`${copy ? "Copied" : "Moved"} ${plural(r?.moved_count ?? 0, "lead")}${r?.skipped_count ? ` · ${num(r.skipped_count)} left behind` : ""}`);
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
      setProgress(null);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${num(count)} lead${count === 1 ? "" : "s"}`}
      description="Leads moved into a campaign start its sequence from the first step."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!dest} loading={progress !== null} onClick={run}>
            {copy ? "Copy leads" : "Move leads"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented value={kind} onChange={setKind} options={[{ value: "campaign", label: "To a campaign" }, { value: "list", label: "To a list" }]} />
        <Field label={kind === "campaign" ? "Campaign" : "List"}>
          {(id) => <Select id={id} value={dest} onChange={setDest} placeholder={options.length ? "Choose…" : "Nothing to choose from yet"} options={options.map((o) => ({ value: o.id, label: o.name }))} />}
        </Field>
        <div className="space-y-2.5">
          <Checkbox label="Keep a copy here (copy instead of move)" checked={copy} onChange={setCopy} />
          <Checkbox label={kind === "campaign" ? "Leave out people who are in another campaign" : "Leave out people who are in another list"} checked={skipDupes} onChange={setSkipDupes} />
          {kind === "campaign" && <Checkbox label="Leave out invalid and risky addresses" checked={skipInvalid} onChange={setSkipInvalid} />}
          <Checkbox label="Clear their lead status (interested, meeting booked…)" checked={resetStatus} onChange={setResetStatus} />
        </div>
        {progress !== null && <Progress value={progress} />}
      </div>
    </Dialog>
  );
}

/**
 * Leads of a campaign, a list, or the whole workspace, with filters, bulk actions and the lead panel.
 * The open lead lives in the `lead` query parameter so links into a lead work.
 */
export function LeadsTable({ campaignId, listId, actions }: { campaignId?: string; listId?: string; actions?: ReactNode }) {
  const qc = useQueryClient();
  const can = useCan();
  const zone = useWorkspaceZone();
  const confirm = useConfirm();
  const statuses = useLeadStatuses();
  const [params, setParams] = useSearchParams();
  // Search, quick filter, filter rules and sort live in the URL, so a filtered table can be bookmarked.
  const query = useLeadQuery();
  const [search, setSearch] = useState(query.search);
  const q = useDebounced(search.trim());
  useEffect(() => {
    if (q !== query.search) query.set({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const filter = query.preset;
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [addOpen, setAddOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const openLead = params.get("lead");
  const writable = can.perm("leads") && can.write;

  const scope = { campaign: campaignId, list_id: listId };
  const filters = {
    ...scope,
    search: query.search || undefined,
    filter: filter || undefined,
    rules: query.rules.length ? apiRules(query.rules) : undefined,
    sort_by: query.sort?.by,
    sort_order: query.sort?.order,
  };
  const list = useInfiniteQuery({
    queryKey: ["leads", "table", filters],
    queryFn: ({ pageParam }) => post<ListPage>("/api/v2/leads/list", { ...filters, limit: 50, starting_after: pageParam, with_total: !pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_starting_after ?? undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total;

  useEffect(() => setSelection(emptySelection()), [query.filterKey, campaignId, listId]);

  // "Select all" with no filter means every lead here, and says so (the server never takes a missing filter for that).
  const target = selection.all ? { ...filters, all_leads: true } : { ...scope, ids: [...selection.ids] };
  const count = selection.all ? (total ?? rows.length) : selection.ids.size;

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["leads"] });
      if (success) toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (action: "pause" | "resume" | "mark_completed") =>
    run(action, () => post("/api/app/leads/status", { ...target, action }), { pause: "Leads paused", resume: "Leads resumed", mark_completed: "Leads marked as completed" }[action]);

  const exportLeads = () =>
    run("export", async () => {
      const job = await post<Job>("/api/app/leads/export", target);
      const done = await waitForJob(job.id);
      if (done.status !== "success") throw new Error(done.error ?? "The export failed");
      const res = await fetch(`/api/app/exports/${job.id}/download`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("The export file could not be downloaded");
      downloadBlob(`leads-${todayIn(zone)}.csv`, await res.blob());
    });

  const verify = () =>
    run(
      "verify",
      async () => {
        await post("/api/app/verification/leads", selection.all ? { ...filters, only_unverified: true } : { ids: [...selection.ids] });
      },
      "Verification started. Results appear on each lead as they finish.",
    );

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${num(count)} lead${count === 1 ? "" : "s"}?`,
      description: `Their emails stay in the Unibox. ${restorable(count !== 1)}`,
      confirmLabel: "Delete leads",
      danger: true,
      typeToConfirm: count > 100 ? "DELETE" : undefined,
    });
    if (!ok) return;
    await run("delete", async () => {
      const r = await post<{ count: number; recently_deleted_id?: string | null }>("/api/app/leads/delete", target);
      deletedToast(r.count === 1 ? "Lead deleted" : `${num(r.count)} leads deleted`, r.recently_deleted_id, r.count !== 1);
    }).then(() => setSelection(emptySelection()));
  };

  const builder = useFilterBuilder({ query, campaignId, listId, onSearchText: setSearch });
  const enrichment = useEnrichmentColumns({ campaignId, listId, rows, filters, selection, selectedCount: selection.all ? count : selection.ids.size, total, writable });

  const columns: Column<Lead>[] = [
    {
      key: "lead",
      header: "Lead",
      cell: (l) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={fullName(l)} email={l.email} size={30} />
          {/* A width limit, so a long address is cut short instead of widening the table. */}
          <div className="min-w-0 max-w-[14rem] sm:max-w-[18rem]">
            <p className="flex items-center gap-1.5 font-medium">
              <span className="truncate">{fullName(l) || l.email}</span>
              {l.is_website_visitor && <VisitedMark />}
            </p>
            <p className="truncate text-xs text-muted" title={fullName(l) ? (l.email ?? undefined) : undefined}>
              {fullName(l) ? l.email : l.job_title}
            </p>
            {/* Phones show status and interest here instead of in their own columns. */}
            {(campaignId || l.lt_interest_status !== null) && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:hidden">
                {campaignId && <LeadStatusBadge status={l.status} />}
                <InterestBadge code={l.lt_interest_status} labels={statuses.all} />
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "company",
      header: "Company",
      hideBelow: "md",
      cell: (l) => (
        <div className="min-w-0 max-w-[14rem]">
          <p className="truncate">{l.company_name || <span className="text-faint">—</span>}</p>
          {l.job_title && fullName(l) && <p className="truncate text-xs text-muted">{l.job_title}</p>}
        </div>
      ),
    },
    ...(campaignId
      ? [
          {
            key: "status",
            header: "Status",
            hideBelow: "sm" as const,
            cell: (l: Lead) => (
              <div className="flex flex-wrap items-center gap-1.5">
                <LeadStatusBadge status={l.status} />
                {l.subsequence_id && <span className="text-xs text-muted">in subsequence</span>}
              </div>
            ),
          },
        ]
      : []),
    { key: "interest", header: "Interest", hideBelow: "sm", cell: (l) => <InterestBadge code={l.lt_interest_status} labels={statuses.all} /> },
    {
      key: "verification",
      header: "Email",
      hideBelow: "lg",
      cell: (l) => (
        <div>
          <VerificationBadge status={l.verification_status} />
          <MailRoute lead={l} />
        </div>
      ),
    },
    ...(campaignId
      ? [
          {
            key: "activity",
            header: "Activity",
            hideBelow: "sm" as const,
            cell: (l: Lead) => (
              <div className="flex items-center gap-3 text-xs">
                <Counter icon={<Eye size={13} />} n={l.email_open_count} title="Opens" />
                <Counter icon={<MousePointerClick size={13} />} n={l.email_click_count} title="Clicks" />
                <Counter icon={<MessageSquareReply size={13} />} n={l.email_reply_count} title="Replies" />
              </div>
            ),
          },
          {
            key: "contacted",
            header: "Last contacted",
            hideBelow: "xl" as const,
            cell: (l: Lead) => <span className="whitespace-nowrap text-muted">{l.timestamp_last_contact ? ago(l.timestamp_last_contact) : "Not yet"}</span>,
          },
        ]
      : [{ key: "added", header: "Added", hideBelow: "lg" as const, cell: (l: Lead) => <span className="whitespace-nowrap text-muted">{ago(l.timestamp_created)}</span> }]),
    ...enrichment.columns,
  ];

  const filterOptions = campaignId ? FILTERS : FILTERS.filter((f) => LIST_FILTERS.has(f.value));
  const filtered = !!(query.search || filter || query.rules.length);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, email, company" className="w-full sm:w-64" />
        <Select size="sm" className="w-44 sm:w-48" value={filter} onChange={(v) => query.set({ filter: v || null })} options={filterOptions} aria-label="Quick filter" />
        {builder.addButton}
        {builder.sortMenu}
        {builder.viewsMenu(writable)}
        <span className="text-xs text-muted">{total !== undefined && `${num(total)} lead${total === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {enrichment.button}
          {writable && (campaignId || listId) && (
            <Button variant="primary" size="sm" icon={<UserPlus size={14} />} onClick={() => setAddOpen(true)}>
              Add leads
            </Button>
          )}
        </div>
      </div>

      {builder.chips}

      <SelectionBar count={selection.ids.size} total={total} allSelected={selection.all} onSelectAll={() => setSelection({ ids: new Set(), all: true })} onClear={() => setSelection(emptySelection())}>
        <Menu>
          <MenuTrigger asChild>
            <Button size="xs" loading={busy === "interest"}>
              Set interest
            </Button>
          </MenuTrigger>
          <MenuContent>
            {statuses.all.map((s) => (
              <MenuItem key={s.code} onSelect={() => run("interest", () => post("/api/app/leads/status", { ...target, action: "interest", interest_value: s.code }), `Marked as ${s.label}`)}>
                <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => run("interest", () => post("/api/app/leads/status", { ...target, action: "interest", interest_value: null }), "Interest status cleared")}>Clear status</MenuItem>
          </MenuContent>
        </Menu>
        {campaignId && (
          <>
            <Button size="xs" icon={<Pause size={13} />} loading={busy === "pause"} onClick={() => setStatus("pause")}>
              Pause
            </Button>
            <Button size="xs" icon={<Play size={13} />} loading={busy === "resume"} onClick={() => setStatus("resume")}>
              Resume
            </Button>
            <Button size="xs" icon={<CheckCheck size={13} />} loading={busy === "mark_completed"} onClick={() => setStatus("mark_completed")}>
              Mark completed
            </Button>
          </>
        )}
        <Button size="xs" icon={<PencilLine size={13} />} onClick={() => setEditOpen(true)}>
          Edit
        </Button>
        <Button size="xs" icon={<ArrowRightLeft size={13} />} onClick={() => setMoveOpen(true)}>
          Move
        </Button>
        <Button size="xs" icon={<ShieldCheck size={13} />} loading={busy === "verify"} onClick={verify}>
          Verify
        </Button>
        <Button size="xs" icon={<Download size={13} />} loading={busy === "export"} onClick={exportLeads}>
          Export
        </Button>
        <Button size="xs" variant="danger" icon={<Trash2 size={13} />} loading={busy === "delete"} onClick={remove}>
          Delete
        </Button>
      </SelectionBar>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        selection={writable ? selection : undefined}
        onSelectionChange={setSelection}
        onRowClick={(l) => setParams((p) => (p.set("lead", l.id), p))}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        rowClassName={(l) => (l.status === LeadStatus.BOUNCED || l.status === LeadStatus.UNSUBSCRIBED ? "opacity-70" : undefined)}
        empty={
          filtered ? (
            <EmptyState
              title="No leads match"
              description="Try another search or filter."
              action={<Button onClick={builder.clear}>Clear filters</Button>}
            />
          ) : (
            <EmptyState
              icon={<Users size={22} />}
              title="No leads yet"
              description={campaignId ? "Upload a CSV, paste emails, or move leads in from a list." : "Import leads, or save them here from the lead finder."}
              action={
                writable && (campaignId || listId) ? (
                  <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => setAddOpen(true)}>
                    Add leads
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />

      <AddLeadsDialog open={addOpen} onOpenChange={setAddOpen} campaignId={campaignId} listId={listId} />
      <MoveDialog open={moveOpen} onOpenChange={setMoveOpen} target={target} count={count} excludeCampaign={campaignId} excludeList={listId} />
      <EditFieldDialog open={editOpen} onOpenChange={setEditOpen} target={target} count={count} campaignId={campaignId} listId={listId} />
      {enrichment.dialogs}
      <LeadSheet leadId={openLead} onClose={() => setParams((p) => (p.delete("lead"), p))} onChanged={() => qc.invalidateQueries({ queryKey: ["leads"] })} />
    </div>
  );
}
