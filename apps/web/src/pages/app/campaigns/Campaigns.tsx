import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, BarChart3, Copy, Download, FileInput, MoreHorizontal, Pause, Pencil, Play, Plus, Send, Share2, Tag as TagIcon, Trash2 } from "lucide-react";
import { CampaignStatus, NOT_SENDING_LABELS, NOT_SENDING_NEEDS_ATTENTION, NOT_SENDING_SHORT } from "@reachstack/shared";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import type { Campaign } from "@/lib/types";
import { useCan } from "@/lib/session";
import { useDebounced, usePageTitle, useQueryState } from "@/lib/hooks";
import { downloadBlob, money, num, pct, plural } from "@/lib/format";
import { deletedToast, restorable } from "@/lib/recently-deleted";
import { CampaignStatusBadge } from "@/components/status";
import { TagChip, TagPicker, useTags } from "@/components/TagPicker";
import {
  Button,
  ButtonLink,
  Checkbox,
  CopyButton,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Page,
  PageHeader,
  Progress,
  RowMenu,
  SearchInput,
  Select,
  SelectionBar,
  Tooltip,
  emptySelection,
  useConfirm,
  type Column,
  type Selection,
} from "@/components/ui";
import { useBulkLaunch, useLaunch } from "./launch";
import { toCsv } from "@/lib/csv";

export interface CampaignRow extends Campaign {
  tags?: string[];
  stats: {
    leads: number;
    completed: number;
    /** Leads still to be emailed (on a finished campaign: added after it finished). */
    waiting: number;
    progress: number;
    sent: number;
    contacted: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    opportunities: number;
    opportunity_value: number;
  };
}

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Has errors" },
  { value: "completed", label: "Completed" },
  { value: "subsequences", label: "Running subsequences" },
  { value: "evergreen", label: "Evergreen" },
];

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

const PAGE_SIZE = 25;
const RUNNING = new Set<number>([CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES]);

/** Why a running campaign isn't sending right now, in a few words; the full sentence on hover. */
function NotSending({ code }: { code: number }) {
  const attention = NOT_SENDING_NEEDS_ATTENTION.has(code);
  return (
    <Tooltip content={NOT_SENDING_LABELS[code]}>
      <span className={attention ? "inline-flex items-center gap-1 text-xs font-medium text-warn" : "text-xs text-muted"}>
        {attention && <AlertTriangle size={12} className="shrink-0" />}
        {NOT_SENDING_SHORT[code] ?? "Not sending"}
      </span>
    </Tooltip>
  );
}

function RenameDialog({ campaign, onClose }: { campaign: CampaignRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(campaign?.name ?? ""), [campaign]);
  const save = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      await patch(`/api/v2/campaigns/${campaign.id}`, { name: name.trim() });
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      await qc.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!campaign}
      onOpenChange={(v) => !v && onClose()}
      size="sm"
      title="Rename campaign"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && save()} />
    </Dialog>
  );
}

function DuplicateDialog({ campaign, onClose }: { campaign: CampaignRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [copyLeads, setCopyLeads] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(campaign ? `${campaign.name} (copy)` : "");
    setCopyLeads(false);
  }, [campaign]);
  const run = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const c = await post<Campaign>(`/api/v2/campaigns/${campaign.id}/duplicate`, { name: name.trim(), copy_leads: copyLeads });
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign duplicated");
      onClose();
      navigate(`/app/campaign/${c.id}/sequences`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!campaign}
      onOpenChange={(v) => !v && onClose()}
      size="sm"
      title="Duplicate campaign"
      description="Copies the sequence, schedule, sending accounts and options. The copy starts as a draft."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={run}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Checkbox label="Copy the leads too" checked={copyLeads} onChange={setCopyLeads} />
      </div>
    </Dialog>
  );
}

function ShareDialog({ campaign, onClose }: { campaign: CampaignRow | null; onClose: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!campaign) return;
    post(`/api/v2/campaigns/${campaign.id}/share`)
      .then(() => setReady(true))
      .catch((e) => toast.error(errorMessage(e)));
  }, [campaign]);
  const link = campaign ? `${window.location.origin}/share/campaign?id=${campaign.id}` : "";
  return (
    <Dialog
      open={!!campaign}
      onOpenChange={(v) => !v && onClose()}
      title="Share campaign"
      description="Anyone with the link can view the sequence (not your leads or stats) and import a copy into their own workspace. The link works for 7 days."
    >
      <div className="flex items-center gap-2">
        <Input readOnly value={ready ? link : "Creating link…"} onFocus={(e) => e.target.select()} />
        <CopyButton value={link} />
      </div>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const id = /share\/campaign(?:\/|\?id=)([\w-]+)/.exec(value)?.[1] ?? (/^[\w-]{20,}$/.test(value.trim()) ? value.trim() : null);
  const run = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const c = await post<Campaign>(`/api/v2/campaigns/${id}/from-export`);
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success(`Imported “${c.name}”`);
      onOpenChange(false);
      navigate(`/app/campaign/${c.id}/sequences`);
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
      title="Import a shared campaign"
      description="Paste the share link you received. The sequence and settings are copied into a new draft campaign."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!id} onClick={run}>
            Import
          </Button>
        </>
      }
    >
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={`${window.location.origin}/share/campaign?id=…`} />
    </Dialog>
  );
}

async function downloadAnalytics(ids: string[] | null, filename: string) {
  const rows = await get<Array<Record<string, unknown>>>("/api/v2/campaigns/analytics", ids ? { ids: ids.join(",") } : {});
  downloadBlob(filename, toCsv(rows));
}

export default function Campaigns() {
  usePageTitle("Campaigns");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const confirm = useConfirm();
  const tags = useTags();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [status, setStatus] = useQueryState("status", "all");
  const [sort, setSort] = useQueryState("sort", "newest");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<CampaignRow | null>(null);
  const [duplicating, setDuplicating] = useState<CampaignRow | null>(null);
  const [sharing, setSharing] = useState<CampaignRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const launcher = useLaunch();
  const bulkLauncher = useBulkLaunch();
  const writable = can.perm("edit_campaigns") && can.write;

  useEffect(() => {
    setPage(1);
    setSelection(emptySelection());
  }, [q, status, sort, tagFilter.join(",")]);

  const list = useQuery({
    queryKey: ["campaigns", "table", { q, status, sort, tags: tagFilter, page }],
    queryFn: () =>
      get<{ total: number; page: number; items: CampaignRow[] }>("/api/app/campaigns", {
        search: q || undefined,
        status: status === "all" ? undefined : status,
        sort,
        tag_ids: tagFilter.length ? tagFilter.join(",") : undefined,
        limit: PAGE_SIZE,
        page,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Deleting the last campaigns of the last page shows the page before, not an empty table.
  useEffect(() => {
    if (list.data && page > pages) setPage(pages);
  }, [list.data, page, pages]);
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const ids = [...selection.ids];

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      if (success) toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const bulk = (action: "pause" | "delete") =>
    run(action, async () => {
      const r = await post<{ updated: number; recently_deleted_ids?: string[] }>("/api/app/campaigns/bulk", { ids, action });
      if (action === "delete") deletedToast(r.updated === 1 ? "Campaign deleted" : "Campaigns deleted", r.recently_deleted_ids);
      else toast.success("Campaigns paused");
      setSelection(emptySelection());
    });

  // Launching goes through the same pre-launch check as the campaign page.
  const launchSelected = async () => {
    if (await bulkLauncher.start(ids)) setSelection(emptySelection());
  };

  const toggle = (c: CampaignRow) => (RUNNING.has(c.status) ? run(`row-${c.id}`, () => post(`/api/v2/campaigns/${c.id}/pause`), "Campaign paused") : launcher.start(c));

  // A finished campaign with leads added since can be resumed to email them.
  const waiting = (c: CampaignRow) => (c.status === CampaignStatus.COMPLETED ? c.stats.waiting : 0);
  const statusOf = (c: CampaignRow) =>
    RUNNING.has(c.status) && c.not_sending_status !== null ? (
      <div className="flex flex-col items-start gap-1">
        <CampaignStatusBadge status={c.status} />
        <NotSending code={c.not_sending_status} />
      </div>
    ) : waiting(c) ? (
      <div className="flex flex-col items-start gap-1">
        <CampaignStatusBadge status={c.status} />
        <span className="text-xs text-warn">{plural(waiting(c), "new lead")} waiting</span>
      </div>
    ) : (
      <CampaignStatusBadge status={c.status} />
    );
  const canToggle = (c: CampaignRow) => writable && c.status !== CampaignStatus.ACCOUNT_SUSPENDED && (c.status !== CampaignStatus.COMPLETED || waiting(c) > 0);
  const startLabel = (c: CampaignRow) => (c.status === CampaignStatus.DRAFT ? "Launch campaign" : "Resume campaign");

  const columns: Column<CampaignRow>[] = [
    {
      key: "name",
      header: "Name",
      cell: (c) => (
        <div className="min-w-[10rem] max-w-[22rem] sm:min-w-[13rem]">
          <Link to={`/app/campaign/${c.id}/analytics`} className="font-medium hover:text-brand-text" onClick={(e) => e.stopPropagation()}>
            {c.name}
          </Link>
          {!!c.tags?.length && (
            <div className="mt-1 flex flex-wrap gap-1">
              {c.tags.map((id) => {
                const t = tagById.get(id);
                return t ? <TagChip key={id} tag={t} /> : null;
              })}
            </div>
          )}
          {/* Phones show the status here instead of in its own column. */}
          <div className="mt-1.5 sm:hidden">{statusOf(c)}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", hideBelow: "sm", cell: statusOf },
    {
      key: "progress",
      header: "Progress",
      hideBelow: "md",
      cell: (c) => (
        <div className="w-32">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>{c.stats.progress}%</span>
            <span className="tabular-nums">{plural(c.stats.leads, "lead")}</span>
          </div>
          <Progress value={c.stats.progress} tone={c.stats.progress >= 100 ? "ok" : "brand"} />
        </div>
      ),
    },
    { key: "sent", header: "Sent", hideBelow: "sm", cell: (c) => <span className="tabular-nums">{num(c.stats.sent)}</span> },
    {
      key: "clicks",
      header: "Clicks",
      hideBelow: "lg",
      cell: (c) => (
        <span className="tabular-nums">
          {num(c.stats.clicked)} <span className="text-faint">· {pct(c.stats.clicked, c.stats.contacted)}</span>
        </span>
      ),
    },
    {
      key: "replied",
      header: "Replied",
      hideBelow: "sm",
      cell: (c) => (
        <span className="tabular-nums">
          {num(c.stats.replied)} <span className="text-faint">· {pct(c.stats.replied, c.stats.contacted)}</span>
        </span>
      ),
    },
    {
      key: "opportunities",
      header: "Opportunities",
      hideBelow: "lg",
      cell: (c) => (
        <span className="tabular-nums">
          {num(c.stats.opportunities)}
          {c.stats.opportunity_value ? <span className="text-faint"> · {money(c.stats.opportunity_value)}</span> : null}
        </span>
      ),
    },
    {
      key: "toggle",
      header: "",
      className: "w-12",
      hideBelow: "sm",
      cell: (c) =>
        canToggle(c) ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={RUNNING.has(c.status) ? "Pause campaign" : startLabel(c)}
            title={RUNNING.has(c.status) ? "Pause" : waiting(c) ? `Resume to email the ${plural(waiting(c), "new lead")}` : startLabel(c)}
            loading={busy === `row-${c.id}` || launcher.busy === c.id}
            disabled={!!launcher.busy && launcher.busy !== c.id}
            onClick={(e) => {
              e.stopPropagation();
              toggle(c);
            }}
          >
            {RUNNING.has(c.status) ? <Pause size={15} /> : <Play size={15} className="text-ok" />}
          </Button>
        ) : null,
    },
    {
      key: "menu",
      header: "",
      className: "w-10",
      cell: (c) => (
        <RowMenu>
          <MenuItem icon={<BarChart3 size={14} />} onSelect={() => navigate(`/app/campaign/${c.id}/analytics`)}>
            Open analytics
          </MenuItem>
          {canToggle(c) && (
            <MenuItem icon={RUNNING.has(c.status) ? <Pause size={14} /> : <Play size={14} />} onSelect={() => toggle(c)}>
              {RUNNING.has(c.status) ? "Pause campaign" : startLabel(c)}
            </MenuItem>
          )}
          {writable && (
            <>
              <MenuItem icon={<Pencil size={14} />} onSelect={() => setRenaming(c)}>
                Rename
              </MenuItem>
              <MenuItem icon={<Copy size={14} />} onSelect={() => setDuplicating(c)}>
                Duplicate
              </MenuItem>
            </>
          )}
          <MenuItem icon={<Download size={14} />} onSelect={() => run("csv", () => downloadAnalytics([c.id], `${c.name}-analytics.csv`))}>
            Download analytics CSV
          </MenuItem>
          {writable && (
            <MenuItem icon={<Share2 size={14} />} onSelect={() => setSharing(c)}>
              Share
            </MenuItem>
          )}
          {writable && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onSelect={async () => {
                  if (await confirm({ title: `Delete “${c.name}”?`, description: `Its leads, subsequences and analytics go with it. ${restorable()}`, confirmLabel: "Delete campaign", danger: true }))
                    run("row", async () => deletedToast("Campaign deleted", (await del<{ recently_deleted_id?: string }>(`/api/v2/campaigns/${c.id}`)).recently_deleted_id));
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </RowMenu>
      ),
    },
  ];

  const filtered = !!(q || status !== "all" || tagFilter.length);
  return (
    <Page wide>
      <PageHeader
        title="Campaigns"
        description="Sequences sent from your connected accounts on a schedule, with replies landing in the Unibox."
        actions={
          <>
            <Menu>
              <MenuTrigger asChild>
                <Button icon={<MoreHorizontal size={15} />} className="hidden sm:inline-flex">
                  More
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Download size={14} />} onSelect={() => run("csv", () => downloadAnalytics(null, "campaign-analytics.csv"))}>
                  Download analytics for all campaigns
                </MenuItem>
                {writable && (
                  <MenuItem icon={<FileInput size={14} />} onSelect={() => setImportOpen(true)}>
                    Import a shared campaign
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
            {writable && (
              <ButtonLink to="/app/campaign/create" variant="primary" icon={<Plus size={15} />}>
                Add new
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search campaigns" />
        <Select size="sm" className="w-48" value={status} onChange={setStatus} options={STATUS_FILTERS} aria-label="Status" />
        <TagPicker value={tagFilter} onChange={setTagFilter} title="Filter by tag" />
        <Select size="sm" className="ml-auto w-40" value={sort} onChange={setSort} options={SORTS} aria-label="Sort" />
      </div>

      <SelectionBar count={selection.ids.size} onClear={() => setSelection(emptySelection())}>
        <Button size="xs" icon={<Play size={13} />} loading={bulkLauncher.busy} onClick={launchSelected}>
          Launch
        </Button>
        <Button size="xs" icon={<Pause size={13} />} loading={busy === "pause"} onClick={() => bulk("pause")}>
          Pause
        </Button>
        <TagPicker
          value={[]}
          title="Add tags"
          trigger={
            <Button size="xs" icon={<TagIcon size={13} />}>
              Add tags
            </Button>
          }
          onChange={(tagIds) => tagIds.length && run("tags", () => post("/api/v2/custom-tags/toggle-resource", { tag_ids: tagIds, resource_type: 2, resource_ids: ids, assign: true }), "Tags added")}
        />
        <Button size="xs" icon={<Download size={13} />} loading={busy === "csv"} onClick={() => run("csv", () => downloadAnalytics(ids, "campaign-analytics.csv"))}>
          Analytics CSV
        </Button>
        <Button
          size="xs"
          variant="danger"
          icon={<Trash2 size={13} />}
          loading={busy === "delete"}
          onClick={async () => {
            if (await confirm({ title: `Delete ${ids.length} campaign${ids.length === 1 ? "" : "s"}?`, description: `Their leads, subsequences and analytics go with them. ${restorable(ids.length > 1)}`, confirmLabel: "Delete", danger: true, typeToConfirm: ids.length > 3 ? "DELETE" : undefined }))
              bulk("delete");
          }}
        >
          Delete
        </Button>
      </SelectionBar>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        selection={writable ? selection : undefined}
        onSelectionChange={setSelection}
        empty={
          filtered ? (
            <EmptyState title="No campaigns match" description="Try another search, status or tag." />
          ) : (
            <EmptyState
              icon={<Send size={22} />}
              title="Launch your first campaign"
              description="Write a short sequence, add leads, pick sending accounts and a schedule. Replies show up in the Unibox."
              action={
                writable ? (
                  <ButtonLink to="/app/campaign/create" variant="primary" icon={<Plus size={15} />}>
                    Create campaign
                  </ButtonLink>
                ) : undefined
              }
            />
          )
        }
      />

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-muted">
          <span>
            Page {page} of {pages} · {plural(total, "campaign")}
          </span>
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}

      <RenameDialog campaign={renaming} onClose={() => setRenaming(null)} />
      <DuplicateDialog campaign={duplicating} onClose={() => setDuplicating(null)} />
      <ShareDialog campaign={sharing} onClose={() => setSharing(null)} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      {launcher.dialog}
      {bulkLauncher.dialog}
    </Page>
  );
}
