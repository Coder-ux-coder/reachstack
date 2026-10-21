import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Download, MoreHorizontal, Pause, Pencil, Play, Rocket, Share2, Stethoscope, Trash2 } from "lucide-react";
import { CampaignStatus, NOT_SENDING_NEEDS_ATTENTION } from "@reachstack/shared";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { useCan } from "@/lib/session";
import { usePageTitle } from "@/lib/hooks";
import { dateTime, dateTimeIn, downloadBlob, humanizeTimestamps, plural } from "@/lib/format";
import { RECENTLY_DELETED_PATH, deletedToast, restorable } from "@/lib/recently-deleted";
import { CampaignStatusBadge } from "@/components/status";
import { Button, Callout, CopyButton, Dialog, FullPageSpinner, Input, LinkTabs, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Skeleton, Tooltip, buttonClass, useConfirm } from "@/components/ui";
import { RecordMissing } from "@/pages/errors";
import type { CampaignContext, CampaignDetail, PendingEdits, SendingStatus } from "./context";
import { useLaunch } from "./launch";

const RUNNING = new Set<number>([CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES]);

interface Diagnosis extends SendingStatus {
  campaign_id: string;
  checked_at: string;
  ai_summary: string | null;
  rule_summary: string;
  ai_error?: string;
}

function DiagnoseDialog({ campaignId, open, onOpenChange }: { campaignId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [details, setDetails] = useState(false);
  const q = useQuery({
    queryKey: ["campaign", campaignId, "diagnosis"],
    queryFn: () => post<Diagnosis>(`/api/app/campaigns/${campaignId}/diagnose`),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const d = q.data;
  // Times in what it says are on the schedule's clock, which it names (each lead's own clock: this browser's).
  const zone = d && !d.diagnostics.lead_timezone ? d.diagnostics.timezone : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Campaign diagnostics" description={<span className="font-mono text-xs">Campaign ID {campaignId}</span>}>
      {q.isLoading ? (
        <div className="space-y-3 py-2">
          <p className="text-[13px] text-muted">Checking accounts, schedule and leads…</p>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : q.isError ? (
        <Callout tone="bad" title="Couldn't run diagnostics" action={<Button size="xs" onClick={() => q.refetch()}>Retry</Button>}>
          {errorMessage(q.error)}
        </Callout>
      ) : d ? (
        <div className="space-y-4">
          <div className={`rounded-lg border p-3 ${d.summary.is_sending ? "border-ok/30 bg-ok-soft" : "border-warn/30 bg-warn-soft"}`}>
            <p className="text-sm font-medium">{d.summary.title}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed">{humanizeTimestamps(d.ai_summary ?? d.rule_summary, zone)}</p>
            {d.ai_summary && <p className="mt-2 text-[11px] text-muted">Summary written by AI from the data below.</p>}
            {d.ai_error && <p className="mt-2 text-[11px] text-muted">AI summary unavailable: {d.ai_error}</p>}
          </div>
          {!!d.summary.reasons.length && (
            <ul className="space-y-1.5 text-[13px]">
              {d.summary.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
                  {humanizeTimestamps(r, zone)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDetails(!details)}>
              {details ? "Hide full details" : "See full details"}
            </Button>
            <Button size="sm" variant="ghost" icon={<Download size={14} />} onClick={() => downloadBlob(`diagnostics-${campaignId}.json`, JSON.stringify(d, null, 2), "application/json")}>
              Download JSON
            </Button>
            <span className="ml-auto text-xs text-faint">Last checked {dateTime(d.checked_at)}</span>
          </div>
          {details && (
            <div className="grid gap-3 text-[13px] sm:grid-cols-2">
              <div className="rounded-lg border border-line p-3">
                <p className="mb-1.5 text-xs font-medium text-muted">Schedule</p>
                <p>
                  {d.diagnostics.schedule_open
                    ? "Inside a sending window"
                    : `Closed · next opening ${d.diagnostics.next_schedule_opening ? (zone ? dateTimeIn(new Date(d.diagnostics.next_schedule_opening), zone) : dateTime(d.diagnostics.next_schedule_opening)) : "none"}`}
                </p>
                <p className="text-muted">{d.diagnostics.lead_timezone ? `Each lead's timezone (${d.diagnostics.timezone.replace(/_/g, " ")} when unknown)` : `Timezone ${d.diagnostics.timezone.replace(/_/g, " ")}`}</p>
                <p className="text-muted">
                  Sent today {d.diagnostics.sent_today}
                  {d.diagnostics.daily_limit !== null ? ` of ${d.diagnostics.daily_limit}` : ""}
                </p>
              </div>
              <div className="rounded-lg border border-line p-3">
                <p className="mb-1.5 text-xs font-medium text-muted">Leads</p>
                <p>
                  {d.diagnostics.leads.active} active · {d.diagnostics.leads.due_now} due now
                </p>
                <p className="text-muted">{d.diagnostics.leads.completed} completed</p>
                {d.diagnostics.leads.next_due_at && <p className="text-muted">Next due {dateTime(d.diagnostics.leads.next_due_at)}</p>}
              </div>
              <div className="rounded-lg border border-line p-3 sm:col-span-2">
                <p className="mb-1.5 text-xs font-medium text-muted">
                  Accounts · {d.diagnostics.accounts.healthy} healthy of {d.diagnostics.accounts.total}, {d.diagnostics.accounts.with_capacity} with capacity left today
                </p>
                <ul className="space-y-1">
                  {d.diagnostics.accounts.items.map((a) => (
                    <li key={a.email} className="flex justify-between gap-3">
                      <span className="truncate">{a.email}</span>
                      <span className="tabular-nums text-muted">
                        {a.sent_today}/{a.daily_limit} today
                      </span>
                    </li>
                  ))}
                  {!d.diagnostics.accounts.items.length && <li className="text-muted">No sending accounts selected.</li>}
                </ul>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export default function CampaignLayout() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const can = useCan();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [diagnose, setDiagnose] = useState(false);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  // Unsaved edits in the open tab: Launch saves them first, so what goes out is what's on screen.
  const [pending, setPending] = useState<PendingEdits | null>(null);
  const launcher = useLaunch();
  const readOnly = !(can.perm("edit_campaigns") && can.write);

  const q = useQuery({ queryKey: ["campaign", id], queryFn: () => get<CampaignDetail>(`/api/v2/campaigns/${id}`) });
  const campaign = q.data;
  usePageTitle(campaign?.name ?? "Campaign");
  const running = !!campaign && RUNNING.has(campaign.status);
  const finished = campaign?.status === CampaignStatus.COMPLETED;
  const sending = useQuery({
    queryKey: ["campaign", id, "sending-status"],
    queryFn: () => get<SendingStatus>(`/api/v2/campaigns/${id}/sending-status`),
    // A finished campaign is asked too: leads added after it finished wait until it's resumed.
    enabled: running || finished,
    refetchInterval: 60_000,
  });
  const waiting = finished ? (sending.data?.diagnostics.leads.active ?? 0) : 0;

  if (q.isLoading) return <FullPageSpinner />;
  if (!campaign)
    return (
      <RecordMissing
        error={q.error}
        retry={() => q.refetch()}
        notFound={{
          title: "Campaign not found",
          description: (
            <>
              It was deleted, or it belongs to another workspace. A campaign deleted in the last 30 days can be restored from{" "}
              <Link to={RECENTLY_DELETED_PATH} className="text-brand-text hover:underline">
                Recently deleted
              </Link>
              .
            </>
          ),
          back: { to: "/app/campaigns", label: "All campaigns" },
        }}
      />
    );

  const save: CampaignContext["save"] = async (body) => {
    const updated = await patch<CampaignDetail>(`/api/v2/campaigns/${id}`, body);
    qc.setQueryData(["campaign", id], { ...campaign, ...updated, tags: campaign.tags });
    qc.invalidateQueries({ queryKey: ["campaigns"] });
    // Accounts, limits and the schedule decide whether it's sending.
    qc.invalidateQueries({ queryKey: ["campaign", id, "sending-status"], exact: true });
    return updated;
  };

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["campaign", id] });
    await qc.invalidateQueries({ queryKey: ["campaigns"] });
  };

  const pause = async () => {
    setBusy(true);
    try {
      await post(`/api/v2/campaigns/${id}/pause`);
      await refresh();
      toast.success("Campaign paused");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!renaming?.trim() || renaming.trim() === campaign.name) return setRenaming(null);
    try {
      await save({ name: renaming.trim() });
      setRenaming(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const base = `/app/campaign/${id}`;
  const inSubsequence = /\/subsequences\/(?!$)/.test(location.pathname);
  const notSending = running && sending.data && !sending.data.summary.is_sending;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/app/campaigns" className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" aria-label="Back to campaigns">
          <ArrowLeft size={18} />
        </Link>
        {renaming !== null ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              rename();
            }}
          >
            <Input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} className="w-72" />
          </form>
        ) : (
          <button type="button" disabled={readOnly} onClick={() => setRenaming(campaign.name)} className="group flex min-w-0 items-center gap-2 text-left">
            <h1 className="truncate text-lg font-semibold">{campaign.name}</h1>
            {!readOnly && <Pencil size={14} className="shrink-0 text-faint opacity-0 group-hover:opacity-100" />}
          </button>
        )}
        <CampaignStatusBadge status={campaign.status} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" icon={<Stethoscope size={14} />} onClick={() => setDiagnose(true)}>
            Diagnose
          </Button>
          {!readOnly &&
            campaign.status !== CampaignStatus.ACCOUNT_SUSPENDED &&
            (running ? (
              <Button size="sm" icon={<Pause size={14} />} loading={busy} onClick={pause}>
                Pause campaign
              </Button>
            ) : finished && !waiting ? null : (
              <Tooltip content={pending ? `Saves your changes to the ${pending.what} first` : null}>
                <Button
                  size="sm"
                  variant="primary"
                  icon={campaign.status === CampaignStatus.DRAFT ? <Rocket size={14} /> : <Play size={14} />}
                  loading={launcher.busy === id}
                  onClick={() => launcher.start(campaign, pending?.save)}
                >
                  {campaign.status === CampaignStatus.DRAFT ? (pending ? "Save and launch" : "Launch") : pending ? "Save and resume" : "Resume campaign"}
                </Button>
              </Tooltip>
            ))}
          {!readOnly && (
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" aria-label="More campaign actions">
                  <MoreHorizontal size={16} />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Share2 size={14} />} onSelect={() => setShare(true)}>
                  Share sequence
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 size={14} />}
                  onSelect={async () => {
                    if (await confirm({ title: `Delete “${campaign.name}”?`, description: `Its leads, subsequences and analytics go with it. ${restorable()}`, confirmLabel: "Delete campaign", danger: true })) {
                      try {
                        const r = await del<{ recently_deleted_id?: string }>(`/api/v2/campaigns/${id}`);
                        await qc.invalidateQueries({ queryKey: ["campaigns"] });
                        deletedToast("Campaign deleted", r.recently_deleted_id);
                        navigate("/app/campaigns", { replace: true });
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }
                  }}
                >
                  Delete campaign
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>

      {notSending && (
        <Callout
          tone={sending.data!.summary.waiting_for_tasks ? "info" : NOT_SENDING_NEEDS_ATTENTION.has(sending.data!.diagnostics.not_sending_status ?? 0) ? "bad" : "warn"}
          className="mb-4"
          title={sending.data!.summary.title}
          action={
            sending.data!.summary.waiting_for_tasks ? (
              <Link to="/app/today" className={buttonClass("secondary", "xs")}>
                Open Today
              </Link>
            ) : (
              <Button size="xs" onClick={() => setDiagnose(true)}>
                Diagnose
              </Button>
            )
          }
        >
          {humanizeTimestamps(sending.data!.summary.reasons[0] ?? "", sending.data!.diagnostics.lead_timezone ? undefined : sending.data!.diagnostics.timezone)}
        </Callout>
      )}
      {waiting > 0 && (
        <Callout tone="warn" className="mb-4" title={`${plural(waiting, "lead")} added since this campaign finished`}>
          Nothing has been sent to them yet. Resume the campaign to send them the sequence; it finishes again once they're through it.
        </Callout>
      )}
      {campaign.status === CampaignStatus.BOUNCE_PROTECT && (
        <Callout tone="bad" className="mb-4" title="Paused by bounce protection">
          {campaign.bounce_stats?.sent
            ? `In its last 7 days of sending, ${campaign.bounce_stats.bounced.toLocaleString()} of ${campaign.bounce_stats.sent.toLocaleString()} emails hard-bounced (${campaign.bounce_stats.rate}%), so sending stopped to protect your mailboxes.`
            : "Too many emails bounced, so sending stopped to protect your mailboxes."}{" "}
          Verify or clean the leads that are left, then resume.
        </Callout>
      )}
      {campaign.status === CampaignStatus.ACCOUNTS_UNHEALTHY && (
        <Callout tone="bad" className="mb-4" title="Sending accounts need attention">
          Every selected account has an error. Fix them on the Email accounts page and the campaign resumes on its own.
        </Callout>
      )}

      {!inSubsequence && (
        <LinkTabs
          className="mb-5"
          tabs={[
            // Analytics and leads only for roles that include them.
            ...(can.perm("analytics") ? [{ to: `${base}/analytics`, label: "Analytics" }] : []),
            ...(can.perm("leads") ? [{ to: `${base}/leads`, label: "Leads" }] : []),
            { to: `${base}/sequences`, label: "Sequences" },
            { to: `${base}/schedule`, label: "Schedule" },
            { to: `${base}/options`, label: "Options" },
            { to: `${base}/subsequences`, label: "Subsequences" },
          ]}
        />
      )}

      <Outlet context={{ campaign, save, readOnly, setPending } satisfies CampaignContext} />

      <DiagnoseDialog campaignId={id} open={diagnose} onOpenChange={setDiagnose} />
      {launcher.dialog}
      <Dialog open={share} onOpenChange={setShare} title="Share sequence" description="Anyone with the link can view this sequence and import a copy for the next 7 days. Leads and stats stay private.">
        <ShareLink id={id} enabled={share} />
      </Dialog>
    </div>
  );
}

function ShareLink({ id, enabled }: { id: string; enabled: boolean }) {
  const q = useQuery({ queryKey: ["campaign", id, "share"], queryFn: () => post(`/api/v2/campaigns/${id}/share`).then(() => true), enabled });
  const link = `${window.location.origin}/share/campaign?id=${id}`;
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={q.data ? link : "Creating link…"} onFocus={(e) => e.target.select()} />
      <CopyButton value={link} />
    </div>
  );
}
