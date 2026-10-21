import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, Download, Flame, Globe, Mail, MailPlus, Pause, Play, RefreshCw, Settings2, Tag as TagIcon, Trash2, Wrench } from "lucide-react";
import { AccountStatus, HEALTH_MIN, HEALTH_STATUS_LABELS, PROVIDER_LABELS, type MailboxHealth } from "@reachstack/shared";
import { del, errorMessage, get, post, type Page as ApiPage } from "@/lib/api";
import type { Account } from "@/lib/types";
import { useCan } from "@/lib/session";
import { useDebounced, useMediaQuery, usePageTitle, useQueryState } from "@/lib/hooks";
import { dateOnly, num, plural } from "@/lib/format";
import { AccountStatusBadge, Score } from "@/components/status";
import { TagChip, TagPicker } from "@/components/TagPicker";
import {
  Avatar,
  Button,
  ButtonLink,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MenuItem,
  MenuSeparator,
  NumberInput,
  Page,
  PageHeader,
  RowMenu,
  SearchInput,
  Select,
  SelectionBar,
  StatCard,
  Switch,
  Tooltip,
  emptySelection,
  useConfirm,
  type Column,
  type Selection,
} from "@/components/ui";
import { AccountSheet } from "./AccountSheet";
import { DnsBadge, runDnsCheck } from "./dns";
import { toastFailedTest, type ConnectionTest } from "./checks";

const FILTERS = [
  { value: "", label: "All accounts" },
  { value: "ACC_FILTER_ERROR", label: "Has errors" },
  { value: "ACC_FILTER_PAUSED", label: "Paused" },
  { value: "ACC_FILTER_W_ACTIVE", label: "Warmup active" },
  { value: "ACC_FILTER_W_PAUSED", label: "Warmup paused" },
  { value: "ACC_FILTER_W_ERROR", label: "Warmup has errors" },
  { value: "ACC_FILTER_DNS", label: "Missing DNS records" },
  { value: "ACC_FILTER_NO_CTD", label: "No custom tracking domain" },
  { value: "ACC_FILTER_DFY", label: "Done-for-you accounts" },
  { value: "ACC_FILTER_DFY_SETUP_PENDING", label: "Setup pending" },
];

const SORTS = [
  { value: "", label: "Newest first" },
  { value: "email:asc", label: "Email A–Z" },
  { value: "health_score:asc", label: "Lowest health first" },
  { value: "health_score:desc", label: "Highest health first" },
  { value: "stat_warmup_score:asc", label: "Lowest warmup score" },
  { value: "status:asc", label: "Errors first" },
];

export interface Summary {
  total: number;
  active: number;
  paused: number;
  errors: number;
  resting: number;
  warmup_active: number;
  emails_sent_7d: number;
  warmup_emails_7d: number;
  health_score: number | null;
  at_risk: number;
  daily_capacity: number;
  /** Mailboxes whose domain is missing an SPF, DKIM, DMARC or MX record. */
  dns_issues: number;
}

/** The list's health column: the score, with what it means and the biggest problem on hover. */
function HealthCell({ health }: { health: MailboxHealth | null | undefined }) {
  if (!health || health.score === null) {
    return (
      <Tooltip content={`Not enough activity yet. A score shows up once ${HEALTH_MIN.placement} warmup emails have landed or about ${HEALTH_MIN.sends} emails have gone out.`}>
        <span className="text-faint">–</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={`${HEALTH_STATUS_LABELS[health.status]}. ${health.issues[0] ?? "No problems in the last 14 days."}`}>
      <span>
        <Score value={health.score} />
      </span>
    </Tooltip>
  );
}

export const ACCOUNTS_KEY = ["accounts"] as const;

function BulkEditDialog({ open, onOpenChange, target, count }: { open: boolean; onOpenChange: (v: boolean) => void; target: Record<string, unknown>; count: number }) {
  const qc = useQueryClient();
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [warmupLimit, setWarmupLimit] = useState<number | null>(null);
  const [replyRate, setReplyRate] = useState<number | null>(null);
  const [increment, setIncrement] = useState("");
  const [slowRamp, setSlowRamp] = useState<"" | "on" | "off">("");
  const [busy, setBusy] = useState(false);
  // "Only the fields you fill in are changed": opened again, nothing is filled in from last time.
  useEffect(() => {
    if (!open) return;
    setDailyLimit(null);
    setGap(null);
    setWarmupLimit(null);
    setReplyRate(null);
    setIncrement("");
    setSlowRamp("");
  }, [open]);
  const patch = {
    ...(dailyLimit !== null ? { daily_limit: dailyLimit } : {}),
    ...(gap !== null ? { sending_gap: gap } : {}),
    ...(slowRamp ? { enable_slow_ramp: slowRamp === "on" } : {}),
    ...(warmupLimit !== null || replyRate !== null || increment
      ? { warmup: { ...(warmupLimit !== null ? { limit: warmupLimit } : {}), ...(replyRate !== null ? { reply_rate: replyRate } : {}), ...(increment ? { increment } : {}) } }
      : {}),
  };
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/app/accounts/bulk", { ...target, action: "update", patch });
      await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      toast.success(`Updated ${plural(count, "account")}`);
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
      title={`Edit ${plural(count, "account")}`}
      description="Only the fields you fill in are changed."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!Object.keys(patch).length} onClick={save}>
            Apply changes
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Daily campaign limit" hint="Emails per day per account">
          {(id) => <NumberInput id={id} value={dailyLimit} onChange={setDailyLimit} min={0} max={10000} className="w-full" />}
        </Field>
        <Field label="Minimum gap between emails" hint="Minutes">
          {(id) => <NumberInput id={id} value={gap} onChange={setGap} min={0} max={1440} className="w-full" />}
        </Field>
        <Field label="Slow ramp-up">
          {(id) => <Select id={id} value={slowRamp} onChange={(v) => setSlowRamp(v as "" | "on" | "off")} options={[{ value: "", label: "Don't change" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />}
        </Field>
        <div />
        <Field label="Warmup emails per day">{(id) => <NumberInput id={id} value={warmupLimit} onChange={setWarmupLimit} min={0} max={200} className="w-full" />}</Field>
        <Field label="Warmup reply rate" hint="Percent">
          {(id) => <NumberInput id={id} value={replyRate} onChange={setReplyRate} min={0} max={100} className="w-full" />}
        </Field>
        <Field label="Daily warmup increase">
          {(id) => (
            <Select id={id}
              value={increment}
              onChange={setIncrement}
              options={[
                { value: "", label: "Don't change" },
                { value: "disabled", label: "Disabled" },
                { value: "0", label: "Recommended" },
                { value: "1", label: "+1 per day" },
                { value: "2", label: "+2 per day" },
                { value: "3", label: "+3 per day" },
                { value: "4", label: "+4 per day" },
              ]}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export default function Accounts() {
  usePageTitle("Email accounts");
  const can = useCan();
  const phone = useMediaQuery("(max-width: 639px)");
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useQueryState("q");
  const [filter, setFilter] = useQueryState("filter", params.get("status") === "errors" ? "ACC_FILTER_ERROR" : "");
  const [sort, setSort] = useQueryState("sort");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useDebounced(search);
  const openEmail = params.get("account");

  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) toast.success(params.get("reconnected") ? `${connected} reconnected` : `${connected} connected`);
    if (error) toast.error(error);
    if (connected || error) {
      const next = new URLSearchParams(params);
      next.delete("connected");
      next.delete("reconnected");
      next.delete("error");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  const [sortBy, sortOrder] = sort ? sort.split(":") : [undefined, undefined];
  const listQuery = { search: q || undefined, filter: filter || undefined, tag_ids: tagFilter.length ? tagFilter.join(",") : undefined, include_tags: true, limit: 50, sort_by: sortBy, sort_order: sortOrder };
  const list = useInfiniteQuery({
    queryKey: [...ACCOUNTS_KEY, "list", listQuery],
    queryFn: ({ pageParam }) => get<ApiPage<Account>>("/api/v2/accounts", { ...listQuery, ...(pageParam ? (sortBy ? { skip: pageParam } : { starting_after: pageParam }) : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_starting_after ?? undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const summary = useQuery({ queryKey: [...ACCOUNTS_KEY, "summary"], queryFn: () => get<Summary>("/api/app/accounts/summary") });

  useEffect(() => setSelection(emptySelection()), [q, filter, sort, tagFilter.join(",")]);

  const filtered = !!(q || filter || tagFilter.length);
  const matchQuery = { search: q || undefined, filter: filter || undefined, tag_ids: tagFilter.length ? tagFilter.join(",") : undefined };
  // The summary counts the whole workspace, so filtered matches past the first page are counted here once something is selected.
  const matching = useQuery({
    queryKey: [...ACCOUNTS_KEY, "matching", matchQuery],
    queryFn: async ({ signal }) => {
      let n = 0;
      let after: string | undefined;
      do {
        const page = await get<ApiPage<Account>>("/api/v2/accounts", { ...matchQuery, limit: 1000, starting_after: after }, signal);
        n += page.items.length;
        after = page.next_starting_after ?? undefined;
      } while (after);
      return n;
    },
    enabled: filtered && !!list.hasNextPage && (selection.all || selection.ids.size > 0),
  });
  const total = !filtered ? summary.data?.total : list.data && !list.hasNextPage ? rows.length : matching.data;

  // "Select all" means everything the filters match; the bulk endpoints read the tag filter from inside `filter`.
  const target = selection.all
    ? { include_all_emails: true, filter: { filter: filter || undefined, tag_ids: tagFilter.length ? tagFilter : undefined }, search: q || undefined }
    : { emails: [...selection.ids] };
  const count = selection.all ? (total ?? rows.length) : selection.ids.size;
  const refresh = () => qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setWarmup = (emails: string[] | null, on: boolean) =>
    run(`warmup-${on}`, async () => {
      const r = await post<{ result: { success_count: number; failed_count: number } | null }>(`/api/v2/accounts/warmup/${on ? "enable" : "disable"}`, emails ? { emails } : target);
      const ok = r.result?.success_count ?? 0;
      const failed = r.result?.failed_count ?? 0;
      if (failed) toast.warning(`Warmup ${on ? "enabled" : "paused"} for ${ok} of ${ok + failed} accounts — paused or broken accounts were skipped`);
      else toast.success(`Warmup ${on ? "enabled" : "paused"}${ok > 1 ? ` for ${ok} accounts` : ""}`);
    });

  const bulk = (action: string, label: string) =>
    run(action, () => post("/api/app/accounts/bulk", { ...target, action }), label);

  const warmupToday = (a: Account) =>
    a.warmup_status === 1 ? `${a.warmup_sent_today ?? 0}/${a.warmup_target_today ?? a.warmup?.limit ?? 0}` : a.warmup_status < 0 ? <span className="text-bad">Error</span> : "Off";
  const canWarmup = (a: Account) => can.perm("accounts") && a.warmup_status >= -2;

  const columns: Column<Account>[] = [
    {
      key: "email",
      header: "Account",
      // Phones: this column takes the width the others leave and cuts a long address short.
      className: "max-sm:w-full max-sm:max-w-0",
      cell: (a) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={`${a.first_name} ${a.last_name}`} email={a.email} size={30} />
          <div className="min-w-0">
            <p className="truncate font-medium" title={a.email}>
              {a.email}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span>
                {[a.first_name, a.last_name].filter(Boolean).join(" ") || "No sender name"} <span className="text-faint">·</span> {PROVIDER_LABELS[a.provider_code] ?? "Mailbox"}
              </span>
              {a.tags?.map((t) => <TagChip key={t.id} tag={t} />)}
            </div>
            {/* Phones: the Status and Warmup columns are hidden, so their gist sits here. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted sm:hidden">
              <AccountStatusBadge status={a.status} />
              <span>Warmup {warmupToday(a)}</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      hideBelow: "sm",
      cell: (a) => (
        <div className="space-y-1">
          <AccountStatusBadge status={a.status} />
          {a.status < 0 && a.status_message?.e_message && <p className="max-w-[16rem] truncate text-xs text-bad">{a.status_message.e_message}</p>}
          {a.campaign_pause_until && new Date(a.campaign_pause_until) > new Date() && <p className="text-xs text-warn">Resting until {dateOnly(a.campaign_pause_until)}</p>}
        </div>
      ),
    },
    {
      key: "sent",
      header: "Sent today",
      hideBelow: "md",
      cell: (a) => {
        const limit = a.daily_limit_today ?? a.daily_limit;
        const ramping = a.daily_limit_today !== undefined && a.daily_limit !== null && a.daily_limit_today < a.daily_limit;
        return (
          <Tooltip content={ramping ? `Slow ramp-up: ${num(a.daily_limit_today)} today, rising to ${num(a.daily_limit)} a day.` : null}>
            <span className="tabular-nums">
              {num(a.sent_today ?? 0)}
              <span className="text-faint"> / {limit ?? "∞"}</span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: "warmup",
      header: "Warmup",
      hideBelow: "sm",
      cell: (a) => (
        <div className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
          <Tooltip content={a.warmup_status === 1 ? "Pause warmup" : a.warmup_status < 0 ? "Warmup has an error — open the account" : "Enable warmup"}>
            <span>
              <Switch size="sm" checked={a.warmup_status === 1} disabled={!canWarmup(a)} onChange={(v) => setWarmup([a.email], v)} aria-label="Warmup" />
            </span>
          </Tooltip>
          <span className="text-xs tabular-nums text-muted">{warmupToday(a)}</span>
        </div>
      ),
    },
    { key: "health", header: "Health", hideBelow: "sm", cell: (a) => <HealthCell health={a.health} /> },
    { key: "dns", header: "DNS", hideBelow: "lg", cell: (a) => <DnsBadge account={a} /> },
    {
      key: "menu",
      header: "",
      className: "w-10",
      cell: (a) => (
        <RowMenu>
          <MenuItem icon={<Settings2 size={14} />} onSelect={() => setParams((p) => (p.set("account", a.email), p))}>
            Open settings
          </MenuItem>
          {a.status === AccountStatus.PAUSED ? (
            <MenuItem icon={<Play size={14} />} onSelect={() => run("row", () => post(`/api/v2/accounts/${encodeURIComponent(a.email)}/resume`), "Account resumed")}>
              Resume sending
            </MenuItem>
          ) : (
            <MenuItem icon={<Pause size={14} />} onSelect={() => run("row", () => post(`/api/v2/accounts/${encodeURIComponent(a.email)}/pause`), "Account paused")}>
              Pause sending
            </MenuItem>
          )}
          {phone && canWarmup(a) && (
            <MenuItem icon={<Flame size={14} />} onSelect={() => setWarmup([a.email], a.warmup_status !== 1)}>
              {a.warmup_status === 1 ? "Pause warmup" : "Enable warmup"}
            </MenuItem>
          )}
          <MenuItem
            icon={<RefreshCw size={14} />}
            onSelect={() =>
              run("row", async () => {
                const r = await post<ConnectionTest>(`/api/app/accounts/${encodeURIComponent(a.email)}/reconnect`);
                if (r.ok) toast.success("Connection works");
                else toastFailedTest(r);
              })
            }
          >
            Test connection
          </MenuItem>
          {a.connection !== "sandbox" && (
            <MenuItem icon={<Globe size={14} />} onSelect={() => run("row", () => runDnsCheck({ emails: [a.email] }))}>
              Check DNS
            </MenuItem>
          )}
          {a.status < 0 && (
            <MenuItem icon={<Wrench size={14} />} onSelect={() => run("row", () => post(`/api/v2/accounts/${encodeURIComponent(a.email)}/mark-fixed`), "Marked as fixed")}>
              Mark as fixed
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 size={14} />}
            onSelect={async () => {
              if (await confirm({ title: `Delete ${a.email}?`, description: "The account is removed from every campaign. Its sent emails and replies stay in the inbox history.", confirmLabel: "Delete account", danger: true }))
                run("row", () => del(`/api/v2/accounts/${encodeURIComponent(a.email)}`), "Account deleted");
            }}
          >
            Delete
          </MenuItem>
        </RowMenu>
      ),
    },
  ];

  const s = summary.data;
  return (
    <Page wide>
      <PageHeader
        title="Email accounts"
        description="Mailboxes your campaigns send from. Each one keeps its own daily limit and warmup."
        actions={
          <>
            <a href="/api/app/accounts/export" className="hidden sm:block" download>
              <Button icon={<Download size={15} />}>Export</Button>
            </a>
            <Tooltip content="Looks up SPF, DKIM, DMARC and MX for every sending domain">
              <Button icon={<Globe size={15} />} loading={busy === "dns"} onClick={() => run("dns", () => runDnsCheck({ include_all_emails: true }))}>
                Check DNS
              </Button>
            </Tooltip>
            {can.perm("accounts") && can.write && (
              <ButtonLink to="/app/account/connect" variant="primary" icon={<MailPlus size={15} />}>
                Add accounts
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Accounts" icon={<Mail size={15} />} tone="brand" value={s ? num(s.total) : "–"} sub={s ? `${num(s.active)} active · ${num(s.paused)} paused${s.resting ? ` · ${num(s.resting)} resting` : ""}` : undefined} onClick={() => setFilter("")} active={!filter} />
        <StatCard label="Need attention" icon={<AlertTriangle size={15} />} tone={s?.errors ? "bad" : "neutral"} value={s ? num(s.errors) : "–"} sub="Connection or sending errors" onClick={() => setFilter("ACC_FILTER_ERROR")} active={filter === "ACC_FILTER_ERROR"} />
        <StatCard label="Warming up" icon={<Flame size={15} />} tone="warn" value={s ? num(s.warmup_active) : "–"} sub={s ? `${plural(s.warmup_emails_7d, "warmup email")} in 7 days` : undefined} onClick={() => setFilter("ACC_FILTER_W_ACTIVE")} active={filter === "ACC_FILTER_W_ACTIVE"} />
        <StatCard label="Average health" value={s ? <Score value={s.health_score} /> : "–"} sub={s ? `${s.at_risk ? `${num(s.at_risk)} at risk · ` : ""}${num(s.daily_capacity)} emails/day capacity` : undefined} onClick={() => setSort("health_score:asc")} active={sort === "health_score:asc"} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search email or name" />
        <Select size="sm" className="w-52" value={filter} onChange={setFilter} options={FILTERS} aria-label="Filter" />
        <TagPicker value={tagFilter} onChange={setTagFilter} title="Filter by tag" />
        <Select size="sm" className="ml-auto w-48" value={sort} onChange={setSort} options={SORTS} aria-label="Sort" />
      </div>

      <SelectionBar count={selection.ids.size} total={total} allSelected={selection.all} onSelectAll={() => setSelection({ ids: new Set(), all: true })} onClear={() => setSelection(emptySelection())}>
        <Button size="xs" icon={<Flame size={13} />} loading={busy === "warmup-true"} onClick={() => setWarmup(null, true)}>
          Enable warmup
        </Button>
        <Button size="xs" loading={busy === "warmup-false"} onClick={() => setWarmup(null, false)}>
          Pause warmup
        </Button>
        <Button size="xs" icon={<Pause size={13} />} loading={busy === "pause"} onClick={() => bulk("pause", "Accounts paused")}>
          Pause
        </Button>
        <Button size="xs" icon={<Play size={13} />} loading={busy === "resume"} onClick={() => bulk("resume", "Accounts resumed")}>
          Resume
        </Button>
        <TagPicker
          value={[]}
          title="Add tags"
          trigger={
            <Button size="xs" icon={<TagIcon size={13} />}>
              Add tags
            </Button>
          }
          onChange={(ids) => ids.length && run("tags", () => post("/api/app/accounts/tags", { ...target, tag_ids: ids, assign: true }), "Tags added")}
        />
        <Button size="xs" icon={<RefreshCw size={13} />} loading={busy === "reconnect"} onClick={() => bulk("reconnect", "Connections re-tested")}>
          Test connection
        </Button>
        <Button size="xs" icon={<Globe size={13} />} loading={busy === "dns-selected"} onClick={() => run("dns-selected", () => runDnsCheck(target))}>
          Check DNS
        </Button>
        <Button size="xs" icon={<Settings2 size={13} />} onClick={() => setBulkEdit(true)}>
          Edit settings
        </Button>
        <Button
          size="xs"
          variant="danger"
          icon={<Trash2 size={13} />}
          onClick={async () => {
            if (await confirm({ title: `Delete ${plural(count, "account")}?`, description: "They are removed from all campaigns. This can't be undone.", confirmLabel: "Delete", danger: true, typeToConfirm: count > 5 ? "DELETE" : undefined }))
              bulk("delete", "Accounts deleted").then(() => setSelection(emptySelection()));
          }}
        >
          Delete
        </Button>
      </SelectionBar>

      {s?.dns_issues && filter !== "ACC_FILTER_DNS" ? (
        <Callout tone="warn" className="mb-3" action={<Button size="xs" onClick={() => setFilter("ACC_FILTER_DNS")}>Show them</Button>}>
          {s.dns_issues === 1 ? "1 account sends" : `${s.dns_issues} accounts send`} from a domain that's missing DNS records, so more of its emails go to spam. Open one to see what to add.
        </Callout>
      ) : null}
      {s?.errors ? (
        filter !== "ACC_FILTER_ERROR" && (
          <Callout tone="bad" className="mb-3" action={<Button size="xs" onClick={() => setFilter("ACC_FILTER_ERROR")}>Show them</Button>}>
            {s.errors === 1 ? "1 account can't send right now." : `${s.errors} accounts can't send right now.`} Fix the connection and mark them as fixed to resume.
          </Callout>
        )
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(a) => a.email}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        selection={can.perm("accounts") && can.write ? selection : undefined}
        onSelectionChange={setSelection}
        onRowClick={(a) => setParams((p) => (p.set("account", a.email), p))}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={
          filtered ? (
            <EmptyState title="No matching accounts" description="Try a different search or filter." />
          ) : (
            <EmptyState
              icon={<Mail size={22} />}
              title="Connect your first mailbox"
              description="Add Google, Microsoft or any IMAP/SMTP account. You can connect as many as you need."
              action={
                can.perm("accounts") &&
                can.write && (
                  <ButtonLink to="/app/account/connect" variant="primary" icon={<MailPlus size={15} />}>
                    Add accounts
                  </ButtonLink>
                )
              }
            />
          )
        }
      />

      <BulkEditDialog open={bulkEdit} onOpenChange={setBulkEdit} target={target} count={count} />
      <AccountSheet email={openEmail} onClose={() => setParams((p) => (p.delete("account"), p))} />
    </Page>
  );
}
