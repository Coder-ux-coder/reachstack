import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Rocket, X } from "lucide-react";
import { CampaignStatus } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { num, plural } from "@/lib/format";
import type { Campaign } from "@/lib/types";
import { EmailFrame } from "@/components/EmailFrame";
import { Badge, Button, Dialog, useConfirm } from "@/components/ui";

/** Leads who'd get a blank where a {{variable}} goes, and the worst of those emails (see services/launch-check.ts). */
interface Personalization {
  leads: number;
  checked: number;
  affected: number;
  gaps: Array<{ token: string; leads: number; steps: number[] }>;
  worst: null | {
    lead: { id: string; email: string | null; name: string };
    step: number;
    missing: string[];
    subject: Array<{ text: string } | { missing: string }>;
    body: string;
  };
}

interface LaunchCheck {
  ready: boolean;
  problems: string[];
  warnings: string[];
  personalization: Personalization | null;
}

/** What launching needs to know about a campaign. */
export type LaunchTarget = Pick<Campaign, "id" | "name" | "status">;

interface Checked {
  campaign: LaunchTarget;
  check: LaunchCheck;
}

const RUNNING = new Set<number>([CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES]);

/** Statuses a launch starts from: not running, finished or suspended. */
const startable = (status: number) => !RUNNING.has(status) && status !== CampaignStatus.COMPLETED && status !== CampaignStatus.ACCOUNT_SUSPENDED;
const resumes = (c: LaunchTarget) => c.status === CampaignStatus.PAUSED || c.status === CampaignStatus.BOUNCE_PROTECT || c.status === CampaignStatus.COMPLETED;
const clean = (check: LaunchCheck) => check.ready && !check.warnings.length && !check.personalization;

const BOUNCE_RESUME =
  "If the leads that bounced came from the same source as the ones still waiting, more will bounce and hurt your mailboxes. Once resumed, bounce protection stays off for this campaign for 7 days.";

const listSteps = (steps: number[]) => (steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}`);

const blankHeadline = (p: Personalization) =>
  `${p.affected === p.checked ? (p.checked === 1 ? "The lead" : `All ${num(p.checked)} leads`) : `${num(p.affected)} of ${plural(p.checked, "lead")}`} would get an email with a blank in it`;

function TabLink({ campaignId, tab, onClose }: { campaignId: string; tab: "sequences" | "options"; onClose: () => void }) {
  return (
    <Link className="text-brand-text hover:underline" to={`/app/campaign/${campaignId}/${tab}`} onClick={onClose}>
      Open {tab}
    </Link>
  );
}

function GapReport({ p, campaignId, onClose }: { p: Personalization; campaignId: string; onClose: () => void }) {
  const w = p.worst;
  return (
    <div className="space-y-3 rounded-lg border border-warn/30 bg-warn/5 p-3.5">
      <div className="flex gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium">{blankHeadline(p)}</p>
          <ul className="space-y-0.5 text-muted">
            {p.gaps.map((g) => (
              <li key={g.token}>
                <code className="rounded bg-panel-2 px-1 text-[12px] text-text">{g.token}</code> is empty for {plural(g.leads, "lead")} in {listSteps(g.steps)}.
              </li>
            ))}
          </ul>
          <p className="text-muted">
            Give each a fallback, like <code className="rounded bg-panel-2 px-1 text-[12px] text-text">{"{{firstName|there}}"}</code>, or fill in those leads.{" "}
            <TabLink campaignId={campaignId} tab="sequences" onClose={onClose} />
          </p>
          {p.checked < p.leads && <p className="text-xs text-faint">Checked the first {num(p.checked)} of {plural(p.leads, "lead")}.</p>}
        </div>
      </div>
      {w && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">
            What {w.lead.name || w.lead.email || "this lead"} would get in step {w.step} (blanks highlighted)
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <p className="border-b border-line px-3 py-2 text-[13px]">
              <span className="text-muted">Subject: </span>
              {w.subject.length ? (
                w.subject.map((part, i) =>
                  "missing" in part ? (
                    <mark key={i} title="Empty for this lead" className="rounded bg-amber-100 px-1 text-[12px] text-amber-800">
                      {part.missing}
                    </mark>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )
              ) : (
                <span className="text-faint">same as the previous email (a reply in the same thread)</span>
              )}
            </p>
            <EmailFrame html={w.body} className="px-3 py-2" minHeight={60} />
          </div>
        </div>
      )}
    </div>
  );
}

/** What the check found, each with where to fix it. `full` shows the blank-variable report with the worst email. */
function Findings({ check, campaignId, onClose, full }: { check: LaunchCheck; campaignId: string; onClose: () => void; full?: boolean }) {
  return (
    <>
      {check.problems.map((p) => (
        <div key={p} className="flex gap-2">
          <X size={15} className="mt-0.5 shrink-0 text-bad" />
          <span>
            {p}{" "}
            {/sequence|step|subject|body|variant/i.test(p) ? (
              <TabLink campaignId={campaignId} tab="sequences" onClose={onClose} />
            ) : /account/i.test(p) ? (
              <TabLink campaignId={campaignId} tab="options" onClose={onClose} />
            ) : null}
          </span>
        </div>
      ))}
      {check.personalization &&
        (full ? (
          <GapReport p={check.personalization} campaignId={campaignId} onClose={onClose} />
        ) : (
          <div className="flex gap-2 text-muted">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
            <span>
              {blankHeadline(check.personalization)}. <TabLink campaignId={campaignId} tab="sequences" onClose={onClose} />
            </span>
          </div>
        ))}
      {check.warnings.map((w) => (
        <div key={w} className="flex gap-2 text-muted">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          {w}
        </div>
      ))}
    </>
  );
}

function LaunchDialog({ review, onClose, onLaunch, busy }: { review: Checked | null; onClose: () => void; onLaunch: () => void; busy: boolean }) {
  const check = review?.check;
  const gaps = !!check?.personalization;
  const verb = review && resumes(review.campaign) ? "resume" : "launch";
  return (
    <Dialog
      open={!!review}
      onOpenChange={(v) => !v && onClose()}
      size={gaps ? "lg" : "md"}
      title={check?.ready ? `Ready to ${verb}?` : `A few things before you ${verb}`}
      description={review?.campaign.name}
      footer={
        check?.ready ? (
          <>
            <Button onClick={onClose}>Not yet</Button>
            <Button variant="primary" icon={<Rocket size={15} />} loading={busy} onClick={onLaunch}>
              {gaps ? `${verb === "resume" ? "Resume" : "Launch"} anyway` : `${verb === "resume" ? "Resume" : "Launch"} campaign`}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Got it</Button>
        )
      }
    >
      {review && (
        <div className="space-y-3 text-[13px]">
          <Findings check={review.check} campaignId={review.campaign.id} onClose={onClose} full />
          {clean(review.check) && (
            <p className="flex gap-2">
              <Check size={15} className="mt-0.5 text-ok" /> Everything looks good. Sending starts at the next scheduled window.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * Launches or resumes a campaign after the pre-launch check: problems, warnings and blank variables show in a dialog
 * first, and a resume with nothing to look at starts right away. Render `dialog` once.
 */
export function useLaunch() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [review, setReview] = useState<Checked | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One launch at a time: a second click (here or on another row) waits until the first has finished.
  const working = useRef(false);

  const launch = async (c: LaunchTarget) => {
    if (working.current) return;
    working.current = true;
    setBusy(c.id);
    try {
      await post(`/api/v2/campaigns/${c.id}/activate`);
      await Promise.all([qc.invalidateQueries({ queryKey: ["campaign", c.id] }), qc.invalidateQueries({ queryKey: ["campaigns"] })]);
      toast.success(resumes(c) ? "Campaign resumed" : "Campaign launched");
      setReview(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  /** `prepare` runs once the user has agreed, before the check (it saves unsaved edits); false stops the launch. */
  const start = async (c: LaunchTarget, prepare?: () => Promise<boolean>) => {
    if (working.current) return;
    const bouncePaused = c.status === CampaignStatus.BOUNCE_PROTECT;
    if (bouncePaused && !(await confirm({ title: "Resume after a bounce pause?", description: BOUNCE_RESUME, confirmLabel: "Resume campaign" }))) return;
    if (working.current) return;
    working.current = true;
    setBusy(c.id);
    let check: LaunchCheck;
    try {
      if (prepare && !(await prepare())) return;
      check = await get<LaunchCheck>(`/api/app/campaigns/${c.id}/launch-check`);
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    } finally {
      working.current = false;
      setBusy(null);
    }
    if (clean(check) && resumes(c)) await launch(c);
    else setReview({ campaign: c, check });
  };

  const dialog = <LaunchDialog review={review} onClose={() => setReview(null)} onLaunch={() => review && launch(review.campaign)} busy={!!review && busy === review.campaign.id} />;
  return { start, busy, dialog };
}

function BulkLaunchDialog({ items, busy, onClose, onLaunch }: { items: Checked[] | null; busy: boolean; onClose: () => void; onLaunch: (ids: string[]) => void }) {
  const ready = items?.filter((i) => i.check.ready) ?? [];
  const count = items?.length ?? 0;
  return (
    <Dialog
      open={!!items}
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={count === 1 ? "1 campaign wasn't launched" : `${num(count)} campaigns weren't launched`}
      description={ready.length ? "The check found things to look at. Launch anyway, or open a campaign to fix them first." : "Open each campaign to fix what the check found."}
      footer={
        ready.length ? (
          <>
            <Button onClick={onClose}>Not yet</Button>
            <Button variant="primary" icon={<Rocket size={15} />} loading={busy} onClick={() => onLaunch(ready.map((i) => i.campaign.id))}>
              {ready.length === count ? "Launch anyway" : `Launch ${num(ready.length)} anyway`}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Got it</Button>
        )
      }
    >
      <ul className="space-y-3 text-[13px]">
        {items?.map(({ campaign, check }) => (
          <li key={campaign.id} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <Link to={`/app/campaign/${campaign.id}/analytics`} onClick={onClose} className="min-w-0 flex-1 truncate font-medium hover:text-brand-text">
                {campaign.name}
              </Link>
              {!check.ready && <Badge tone="bad">Can't launch yet</Badge>}
            </div>
            {campaign.status === CampaignStatus.BOUNCE_PROTECT && (
              <div className="flex gap-2 text-muted">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
                <span>Paused by bounce protection. {BOUNCE_RESUME}</span>
              </div>
            )}
            <Findings check={check} campaignId={campaign.id} onClose={onClose} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/**
 * Launch for several campaigns at once. Each gets the pre-launch check; the ones with nothing to look at start right
 * away and the rest are listed with what the check found, to launch anyway or open. Nothing starts if a check fails.
 * Resolves true once the checks ran. Render `dialog` once.
 */
export function useBulkLaunch() {
  const qc = useQueryClient();
  const [review, setReview] = useState<Checked[] | null>(null);
  const [busy, setBusy] = useState(false);

  const activate = async (ids: string[]) => {
    const r = await post<{ updated: number; failed: Array<{ name: string; reason: string }> }>("/api/app/campaigns/bulk", { ids, action: "activate" });
    await Promise.all([qc.invalidateQueries({ queryKey: ["campaigns"] }), qc.invalidateQueries({ queryKey: ["campaign"] })]);
    if (r.updated) toast.success(r.updated === 1 ? "Campaign launched" : `${num(r.updated)} campaigns launched`);
    if (r.failed.length) toast.warning(`${plural(r.failed.length, "campaign")} couldn't launch: ${r.failed[0]!.name} — ${r.failed[0]!.reason}`);
  };

  const start = async (ids: string[]) => {
    setBusy(true);
    try {
      const checked = await Promise.all(
        ids.map(async (id): Promise<Checked | null> => {
          const campaign = await get<Campaign>(`/api/v2/campaigns/${id}`);
          return startable(campaign.status) ? { campaign, check: await get<LaunchCheck>(`/api/app/campaigns/${id}/launch-check`) } : null;
        }),
      );
      const items = checked.filter((c): c is Checked => !!c);
      // Resuming after a bounce pause always asks first, as it does for one campaign.
      const go = items.filter((i) => clean(i.check) && i.campaign.status !== CampaignStatus.BOUNCE_PROTECT);
      if (go.length) await activate(go.map((i) => i.campaign.id));
      const rest = items.filter((i) => !go.includes(i));
      if (rest.length) setReview(rest);
      else if (!go.length) toast.info(ids.length === 1 ? "That campaign is already running or finished." : "Those campaigns are already running or finished.");
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const launchAnyway = async (ids: string[]) => {
    setBusy(true);
    try {
      await activate(ids);
      setReview(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return { start, busy, dialog: <BulkLaunchDialog items={review} busy={busy} onClose={() => setReview(null)} onLaunch={launchAnyway} /> };
}
