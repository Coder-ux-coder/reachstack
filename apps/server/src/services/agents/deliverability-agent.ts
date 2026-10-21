// AI Deliverability Agent: one per workspace. Each cycle runs a set of checks over the workspace (settings, DNS,
// blocklists, bounces, warmup coverage, mailbox connections, campaign copy, duplicate leads) and keeps a feed of
// insights and recommendations. Recommendations close themselves once a later check finds the issue fixed; some
// offer one-click actions (pause the affected mailboxes, or pause their campaign sending for 14 days).
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { AccountStatus, CampaignStatus, ProviderCode, domainOf, isReservedDomain, isTaskStep } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { inUse } from "../live-workspaces";
import { config } from "../../env";
import { checkDomainAuth, checkDomainBlocklists, checkIpBlocklists, resolveA } from "../../lib/dns";
import { spamScore } from "../../lib/spam-score";
import { iso } from "../../lib/time";
import { campaignSenders } from "../campaigns";
import { getIntegration, postToSlack } from "../integrations";
import { dayOn, daysBefore, workspaceZone } from "../workspace-clock";
import { AgentStatus, AgentType, type AgentRow } from "./common";

const CY = schema.deliverabilityCycles;
const AC = schema.deliverabilityActivities;
const FI = schema.deliverabilityFeedItems;
const ACC = schema.emailAccounts;

type ActivityRow = typeof AC.$inferSelect;
type FeedRow = typeof FI.$inferSelect;
type AccountRow = typeof ACC.$inferSelect;
type Outcome = "healthy" | "needs_attention" | "info" | "skipped";

export const RUN_EVERY_MS = 24 * 3_600_000;
export const RETENTION_DAYS = 30;
export const CAMPAIGN_PAUSE_DAYS = 14;
const BOUNCE_WARN = 3; // percent over the last 7 days
const BOUNCE_CRITICAL = 5;
const WARMUP_MIN_SCORE = 80;

export interface DeliverabilityPayload {
  integrations?: { slack?: { connection_id: string; enabled: boolean; connection_name?: string | null } | null };
  next_run_at?: string | null;
}

export const daPayload = (a: AgentRow) => (a.payload ?? {}) as DeliverabilityPayload;

/** What a check found: feed items it wants open, keyed by dedupe key. */
interface Finding {
  feedCode: string;
  kind: "insight" | "recommendation";
  severity: "info" | "success" | "warning" | "critical";
  priority: number;
  dedupeKey: string;
  subjectType?: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  payload: Record<string, unknown>;
  actionCode?: "pause_affected_accounts" | "pause_campaign_sending" | "complete" | null;
}

interface CheckResult {
  outcome: Outcome;
  summary: string;
  findings: Finding[];
  /** Issues (dedupe keys) the check couldn't judge this time, such as a domain whose DNS didn't answer: left as they are. */
  inconclusive?: string[];
  metrics?: Record<string, unknown>;
}

interface CheckDef {
  code: string;
  priority: number;
  /** Feed codes this check owns; open items it no longer finds are closed as resolved. */
  feedCodes: string[];
  run: (workspaceId: string) => Promise<CheckResult>;
}

// ---------- Shared lookups ----------

async function activeCampaigns(workspaceId: string) {
  return db
    .select()
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.workspaceId, workspaceId), inArray(schema.campaigns.status, [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES])));
}

/** Mailboxes that send for at least one active campaign. */
async function sendingAccounts(workspaceId: string): Promise<AccountRow[]> {
  const byId = new Map<string, AccountRow>();
  for (const c of await activeCampaigns(workspaceId)) for (const a of await campaignSenders(c)) byId.set(a.id, a);
  return [...byId.values()];
}

/** A mailbox resting from campaigns (it only warms up until the rest ends): the rest is what the bounce and warmup advice asks for. */
const isResting = (a: AccountRow) => !!a.campaignPauseUntil && a.campaignPauseUntil.getTime() > Date.now();

const isSimulated = (a: AccountRow) => a.providerCode === ProviderCode.SANDBOX || isReservedDomain(domainOf(a.email));

function providerBucket(code: number): "custom_imap_smtp" | "google" | "microsoft" | "airmail" | "other" {
  if (code === ProviderCode.CUSTOM) return "custom_imap_smtp";
  if (code === ProviderCode.GOOGLE) return "google";
  if (code === ProviderCode.MICROSOFT) return "microsoft";
  if (code === ProviderCode.AIRMAIL || code === ProviderCode.AIRMAIL_INSTANT) return "airmail";
  return "other";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- Checks ----------

/** Workspace-wide sending settings on active campaigns. Each issue can be completed by hand once fixed. */
async function workspaceSettingsIssues(workspaceId: string): Promise<Finding[]> {
  const campaigns = await activeCampaigns(workspaceId);
  const out: Finding[] = [];
  const noUnsub = campaigns.filter((c) => !c.insertUnsubscribeHeader);
  if (noUnsub.length) {
    out.push({
      feedCode: "workspace_settings_recommendation",
      kind: "recommendation",
      severity: "warning",
      priority: 80,
      dedupeKey: "workspace_settings:unsubscribe_header",
      subjectType: "workspace",
      subjectId: workspaceId,
      subjectName: null,
      payload: {
        issue: "unsubscribe_header",
        title: "Add a one-click unsubscribe header",
        detail: `${plural(noUnsub.length, "active campaign")} send without a List-Unsubscribe header. Large mailbox providers expect one from bulk senders.`,
        campaigns: noUnsub.slice(0, 20).map((c) => ({ id: c.id, name: c.name })),
      },
      actionCode: "complete",
    });
  }
  const tracked = campaigns.filter((c) => c.openTracking || c.linkTracking);
  if (tracked.length) {
    const senders = new Map<string, AccountRow>();
    for (const c of tracked) for (const a of await campaignSenders(c)) senders.set(a.id, a);
    const noDomain = [...senders.values()].filter((a) => !isSimulated(a) && !(a.trackingDomainName && a.trackingDomainStatus === "verified"));
    if (noDomain.length) {
      out.push({
        feedCode: "workspace_settings_recommendation",
        kind: "recommendation",
        severity: "warning",
        priority: 70,
        dedupeKey: "workspace_settings:tracking_domain",
        subjectType: "workspace",
        subjectId: workspaceId,
        subjectName: null,
        payload: {
          issue: "tracking_domain",
          title: "Use a custom tracking domain",
          detail: `${plural(noDomain.length, "mailbox", "mailboxes")} track opens or clicks through the shared tracking domain. A verified custom domain keeps your links separate from other senders.`,
          accounts: noDomain.slice(0, 20).map((a) => a.email),
        },
        actionCode: "complete",
      });
    }
  }
  const noStop = campaigns.filter((c) => c.stopOnReply === false);
  if (noStop.length) {
    out.push({
      feedCode: "workspace_settings_recommendation",
      kind: "recommendation",
      severity: "warning",
      priority: 75,
      dedupeKey: "workspace_settings:stop_on_reply",
      subjectType: "workspace",
      subjectId: workspaceId,
      subjectName: null,
      payload: {
        issue: "stop_on_reply",
        title: "Stop sequences when a lead replies",
        detail: `${plural(noStop.length, "active campaign")} keep emailing leads after they reply, which drives complaints.`,
        campaigns: noStop.slice(0, 20).map((c) => ({ id: c.id, name: c.name })),
      },
      actionCode: "complete",
    });
  }
  return out;
}

const checkWorkspaceSettings: CheckDef = {
  code: "check_workspace_settings",
  priority: 100,
  feedCodes: ["workspace_settings_recommendation"],
  async run(ws) {
    const findings = await workspaceSettingsIssues(ws);
    return { outcome: findings.length ? "needs_attention" : "healthy", summary: findings.length ? `${plural(findings.length, "setting")} to improve` : "Sending settings follow best practice", findings };
  },
};

/** Sending domains (real ones only) with the mailboxes using them. */
async function sendingDomains(ws: string) {
  const accounts = (await sendingAccounts(ws)).filter((a) => !isSimulated(a));
  const byDomain = new Map<string, AccountRow[]>();
  for (const a of accounts) byDomain.set(domainOf(a.email), [...(byDomain.get(domainOf(a.email)) ?? []), a]);
  return byDomain;
}

const checkDnsHealth: CheckDef = {
  code: "check_dns_health",
  priority: 90,
  feedCodes: ["dns_health_recommendation"],
  async run(ws) {
    const domains = await sendingDomains(ws);
    if (!domains.size) return { outcome: "skipped", summary: "No real sending domains in active campaigns (sandbox mailboxes are simulated)", findings: [] };
    const findings: Finding[] = [];
    const inconclusive: string[] = [];
    let unknown = 0;
    for (const [domain, accounts] of domains) {
      const r = await checkDomainAuth(domain);
      const missing = (["mx", "spf", "dkim", "dmarc"] as const).filter((k) => !r[k] && !r.indeterminate.includes(k));
      if (r.indeterminate.length === 4) unknown++;
      // Records that didn't answer say nothing about whether an earlier issue was fixed.
      if (!missing.length && r.indeterminate.length) inconclusive.push(`dns_health:${domain}`);
      if (!missing.length) continue;
      findings.push({
        feedCode: "dns_health_recommendation",
        kind: "recommendation",
        severity: missing.includes("spf") || missing.includes("dkim") || missing.includes("mx") ? "critical" : "warning",
        priority: 95,
        dedupeKey: `dns_health:${domain}`,
        subjectType: "domain",
        subjectId: domain,
        subjectName: domain,
        payload: { domain, missing, title: `Fix ${missing.map((m) => m.toUpperCase()).join(", ")} for ${domain}`, account_ids: accounts.map((a) => a.id), accounts: accounts.map((a) => a.email) },
        actionCode: "pause_affected_accounts",
      });
    }
    if (unknown === domains.size) return { outcome: "info", summary: "DNS could not be reached from this server; records were not verified", findings: [] };
    return {
      outcome: findings.length ? "needs_attention" : "healthy",
      summary: findings.length ? `${plural(findings.length, "domain")} with missing DNS records` : `All ${plural(domains.size, "sending domain")} have MX, SPF, DKIM and DMARC`,
      findings,
      inconclusive,
    };
  },
};

const checkBlocklists: CheckDef = {
  code: "check_blocklists",
  priority: 85,
  feedCodes: ["blocklist_recommendation"],
  async run(ws) {
    const domains = await sendingDomains(ws);
    if (!domains.size) return { outcome: "skipped", summary: "No real sending domains in active campaigns (sandbox mailboxes are simulated)", findings: [] };
    const findings: Finding[] = [];
    const inconclusive: string[] = [];
    let errors = 0;
    for (const [domain, accounts] of domains) {
      const hits = await checkDomainBlocklists(domain);
      const ip = (await resolveA(domain).catch(() => []))[0];
      const ipHits = ip ? await checkIpBlocklists(ip) : [];
      const all = [...hits, ...ipHits];
      if (all.length && all.every((h) => h.error)) {
        errors++;
        inconclusive.push(`blocklist:${domain}`);
      }
      const listedOn = all.filter((h) => h.listed).map((h) => h.list);
      if (!listedOn.length) continue;
      findings.push({
        feedCode: "blocklist_recommendation",
        kind: "recommendation",
        severity: "critical",
        priority: 100,
        dedupeKey: `blocklist:${domain}`,
        subjectType: "domain",
        subjectId: domain,
        subjectName: domain,
        payload: { domain, ip: ip ?? null, lists: listedOn, title: `${domain} is listed on ${plural(listedOn.length, "blocklist")}`, account_ids: accounts.map((a) => a.id), accounts: accounts.map((a) => a.email) },
        actionCode: "pause_affected_accounts",
      });
    }
    if (errors === domains.size) return { outcome: "info", summary: "Blocklists could not be queried from this server", findings: [] };
    return { outcome: findings.length ? "needs_attention" : "healthy", summary: findings.length ? `${plural(findings.length, "domain")} on blocklists` : "No sending domain is blocklisted", findings, inconclusive };
  },
};

/** Campaign sends and bounces per mailbox over the last 7 days (today included) on the workspace clock. */
async function bounceStats(accountIds: string[], zone: string) {
  if (!accountIds.length) return new Map<string, { sent: number; bounced: number }>();
  const since = daysBefore(dayOn(zone), 6);
  const S = schema.accountDailyStats;
  const rows = await db
    .select({ id: S.accountId, sent: sql<number>`sum(${S.sent})`, bounced: sql<number>`sum(${S.bounced})` })
    .from(S)
    .where(and(inArray(S.accountId, accountIds), gte(S.date, since)))
    .groupBy(S.accountId);
  return new Map(rows.map((r) => [r.id, { sent: Number(r.sent ?? 0), bounced: Number(r.bounced ?? 0) }]));
}

const checkBounceHealth: CheckDef = {
  code: "check_bounce_health",
  priority: 80,
  feedCodes: ["bounce_health_recommendation"],
  async run(ws) {
    // Resting mailboxes are already doing what this advises (their last week's bounces would bring it straight back).
    const accounts = (await sendingAccounts(ws)).filter((a) => !isResting(a));
    if (!accounts.length) return { outcome: "skipped", summary: "No mailboxes are sending for active campaigns", findings: [] };
    const stats = await bounceStats(accounts.map((a) => a.id), await workspaceZone(ws));
    const bad = accounts
      .map((a) => ({ a, s: stats.get(a.id) ?? { sent: 0, bounced: 0 } }))
      .filter(({ s }) => s.sent >= 20 && (s.bounced / s.sent) * 100 >= BOUNCE_WARN)
      .map(({ a, s }) => ({ id: a.id, email: a.email, sent: s.sent, bounced: s.bounced, rate: Math.round((s.bounced / s.sent) * 1000) / 10 }));
    if (!bad.length) return { outcome: "healthy", summary: "Bounce rates are under 3% on every sending mailbox", findings: [] };
    const worst = Math.max(...bad.map((b) => b.rate));
    return {
      outcome: "needs_attention",
      summary: `${plural(bad.length, "mailbox", "mailboxes")} bounce ${BOUNCE_WARN}% or more`,
      findings: [
        {
          feedCode: "bounce_health_recommendation",
          kind: "recommendation",
          severity: worst >= BOUNCE_CRITICAL ? "critical" : "warning",
          priority: 90,
          dedupeKey: "bounce_health:workspace",
          subjectType: "workspace",
          subjectId: ws,
          payload: {
            title: `High bounce rate on ${plural(bad.length, "mailbox", "mailboxes")}`,
            detail: "Verify the lead lists these mailboxes send to and give them a rest from campaigns while warmup rebuilds their reputation.",
            account_ids: bad.map((b) => b.id),
            accounts: bad,
          },
          actionCode: "pause_campaign_sending",
        },
      ],
    };
  },
};

const checkWarmupCoverage: CheckDef = {
  code: "check_warmup_coverage",
  priority: 75,
  feedCodes: ["warmup_score_recommendation"],
  async run(ws) {
    const accounts = await sendingAccounts(ws);
    if (!accounts.length) return { outcome: "skipped", summary: "No mailboxes are sending for active campaigns", findings: [] };
    // A low score is what a rest from campaigns is for; warmup that's off needs turning on, rest or not.
    const low = (a: AccountRow) => a.warmupScore !== null && a.warmupScore < WARMUP_MIN_SCORE;
    const bad = accounts.filter((a) => a.warmupStatus !== 1 || (!isResting(a) && low(a)));
    const recovering = accounts.filter((a) => a.warmupStatus === 1 && isResting(a) && low(a)).length;
    if (!bad.length)
      return {
        outcome: "healthy",
        summary: recovering
          ? `Warmup is healthy; ${plural(recovering, "mailbox", "mailboxes")} with a low score ${recovering === 1 ? "is" : "are"} resting from campaigns to recover`
          : `All ${plural(accounts.length, "sending mailbox", "sending mailboxes")} warm up with a score of ${WARMUP_MIN_SCORE}+`,
        findings: [],
      };
    const off = bad.filter((a) => a.warmupStatus !== 1).length;
    return {
      outcome: "needs_attention",
      summary: `${plural(bad.length, "mailbox", "mailboxes")} without healthy warmup`,
      findings: [
        {
          feedCode: "warmup_score_recommendation",
          kind: "recommendation",
          severity: off ? "warning" : "info",
          priority: 85,
          dedupeKey: "warmup_score:workspace",
          subjectType: "workspace",
          subjectId: ws,
          payload: {
            title: off ? `Warmup is off on ${plural(off, "sending mailbox", "sending mailboxes")}` : `Low warmup score on ${plural(bad.length, "mailbox", "mailboxes")}`,
            detail: "Keep warmup running on every mailbox that sends campaigns, and give low-scoring mailboxes time to recover before they send again.",
            account_ids: bad.map((a) => a.id),
            accounts: bad.map((a) => ({ id: a.id, email: a.email, warmup_enabled: a.warmupStatus === 1, warmup_score: a.warmupScore })),
          },
          actionCode: "pause_campaign_sending",
        },
      ],
    };
  },
};

const checkAccountConnections: CheckDef = {
  code: "check_account_connections",
  priority: 70,
  feedCodes: ["account_connection_recommendation"],
  async run(ws) {
    const accounts = await sendingAccounts(ws);
    if (!accounts.length) return { outcome: "skipped", summary: "No mailboxes are sending for active campaigns", findings: [] };
    const broken = accounts.filter((a) => a.status < 0);
    if (!broken.length) return { outcome: "healthy", summary: "Every sending mailbox is connected", findings: [] };
    const label: Record<number, string> = { [AccountStatus.CONNECTION_ERROR]: "connection error", [AccountStatus.SOFT_BOUNCE_ERROR]: "soft bounce error", [AccountStatus.SENDING_ERROR]: "sending error" };
    return {
      outcome: "needs_attention",
      summary: `${plural(broken.length, "mailbox", "mailboxes")} disconnected`,
      findings: broken.map((a) => ({
        feedCode: "account_connection_recommendation",
        kind: "recommendation" as const,
        severity: "critical" as const,
        priority: 92,
        dedupeKey: `account_connection:${a.id}`,
        subjectType: "account",
        subjectId: a.id,
        subjectName: a.email,
        payload: { title: `Reconnect ${a.email}`, detail: `The mailbox reports a ${label[a.status] ?? "problem"} and cannot send.`, account_id: a.id, email: a.email, status: a.status, error: a.statusMessage ?? null },
        actionCode: null,
      })),
    };
  },
};

const checkCampaignCopy: CheckDef = {
  code: "check_campaign_copy",
  priority: 60,
  feedCodes: ["campaign_copy_insight"],
  async run(ws) {
    const campaigns = await activeCampaigns(ws);
    if (!campaigns.length) return { outcome: "skipped", summary: "No active campaigns", findings: [] };
    const findings: Finding[] = [];
    for (const c of campaigns) {
      const flagged: Array<{ step: number; variant: number; subject: string; score: number; threshold: number; rules: string[]; links: number }> = [];
      for (const [si, step] of (c.sequences?.[0]?.steps ?? []).entries()) {
        // A task step's note isn't an email: nothing to score.
        if (isTaskStep(step)) continue;
        for (const [vi, v] of (step.variants ?? []).entries()) {
          if ((v as { v_disabled?: boolean }).v_disabled) continue;
          const html = v.body ?? "";
          const report = await spamScore({ subject: v.subject ?? "", html });
          const links = (html.match(/<a\s/gi) ?? []).length;
          if (report.spam_score >= report.threshold * 0.6 || links > 3) {
            flagged.push({ step: si + 1, variant: vi + 1, subject: v.subject ?? "", score: report.spam_score, threshold: report.threshold, rules: report.report.slice(0, 6).map((r) => r.description || r.name), links });
          }
        }
      }
      if (!flagged.length) continue;
      const severe = flagged.some((f) => f.score >= f.threshold);
      findings.push({
        feedCode: "campaign_copy_insight",
        kind: severe ? "recommendation" : "insight",
        severity: severe ? "warning" : "info",
        priority: severe ? 70 : 40,
        dedupeKey: `campaign_copy:${c.id}`,
        subjectType: "campaign",
        subjectId: c.id,
        subjectName: c.name,
        payload: { title: `Spam-prone copy in "${c.name}"`, detail: "Rewrite the flagged phrases and keep to three links or fewer per email.", variants: flagged },
      });
    }
    return { outcome: findings.length ? "needs_attention" : "healthy", summary: findings.length ? `${plural(findings.length, "campaign")} with copy to review` : "Campaign copy looks clean", findings };
  },
};

const checkDuplicates: CheckDef = {
  code: "check_duplicates_in_campaigns",
  priority: 50,
  feedCodes: ["duplicate_leads_insight"],
  async run(ws) {
    const campaigns = await activeCampaigns(ws);
    if (campaigns.length < 2) return { outcome: "skipped", summary: "Fewer than two active campaigns", findings: [] };
    const L = schema.leads;
    const rows = await db
      .select({ email: L.email, n: sql<number>`count(distinct ${L.campaignId})` })
      .from(L)
      .where(and(eq(L.workspaceId, ws), inArray(L.campaignId, campaigns.map((c) => c.id)), eq(L.status, 1), sql`${L.email} is not null`))
      .groupBy(L.email)
      .having(sql`count(distinct ${L.campaignId}) > 1`)
      .limit(1_000);
    if (!rows.length) return { outcome: "healthy", summary: "No lead is active in more than one campaign", findings: [] };
    return {
      outcome: "info",
      summary: `${plural(rows.length, "lead")} active in several campaigns`,
      findings: [
        {
          feedCode: "duplicate_leads_insight",
          kind: "insight",
          severity: "info",
          priority: 30,
          dedupeKey: "duplicate_leads:workspace",
          subjectType: "workspace",
          subjectId: ws,
          payload: { title: `${plural(rows.length, "lead")} ${rows.length === 1 ? "receives" : "receive"} more than one campaign`, detail: "The same person getting parallel sequences raises complaint rates. Remove them from all but one campaign.", count: rows.length, sample: rows.slice(0, 10).map((r) => r.email) },
        },
      ],
    };
  },
};

export const CHECKS: CheckDef[] = [checkWorkspaceSettings, checkDnsHealth, checkBlocklists, checkBounceHealth, checkWarmupCoverage, checkAccountConnections, checkCampaignCopy, checkDuplicates];
const CHECK_BY_CODE = new Map(CHECKS.map((c) => [c.code, c]));

// ---------- Serialization ----------

export function serializeDeliverabilityAgent(a: AgentRow) {
  const p = daPayload(a);
  return {
    id: a.id,
    organization_id: a.workspaceId,
    name: a.name,
    payload: { integrations: { slack: p.integrations?.slack ?? null } },
    type: a.type,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt),
    status: a.status,
    is_auto_created: a.isAutoCreated ?? false,
    created_by: a.createdBy,
    description: a.description,
  };
}

export function serializeFeedItem(f: FeedRow) {
  return {
    id: f.id,
    organization_id: f.workspaceId,
    agent_id: f.agentId,
    source_activity_id: f.sourceActivityId,
    feed_code: f.feedCode,
    kind: f.kind,
    status: f.status,
    severity: f.severity,
    priority: f.priority,
    subject_type: f.subjectType,
    subject_id: f.subjectId,
    subject_name: f.subjectName,
    payload: f.payload,
    result_payload: f.resultPayload,
    action_code: f.actionCode,
    action_status: f.actionStatus,
    action_payload: f.actionPayload,
    dedupe_key: f.dedupeKey,
    timestamp_created: iso(f.createdAt),
    timestamp_updated: iso(f.updatedAt),
    completed_at: iso(f.completedAt),
    dismissed_at: iso(f.dismissedAt),
    expires_at: iso(f.expiresAt),
  };
}

export function serializeActivity(a: ActivityRow) {
  return {
    id: a.id,
    organization_id: a.workspaceId,
    agent_id: a.agentId,
    cycle_id: a.cycleId,
    activity_code: a.activityCode,
    status: a.status,
    priority: a.priority,
    subject_type: a.subjectType,
    subject_id: a.subjectId,
    subject_name: a.subjectName,
    payload: a.payload ?? {},
    result_payload: a.result,
    error_code: a.errorCode,
    error_message: a.errorMessage,
    idempotency_key: a.cycleId ? `${a.cycleId}:${a.activityCode}` : null,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt ?? a.createdAt),
    queued_at: iso(a.createdAt),
    started_at: iso(a.startedAt),
    completed_at: iso(a.completedAt),
    expires_at: a.completedAt ? iso(new Date(a.completedAt.getTime() + RETENTION_DAYS * 86_400_000)) : null,
  };
}

// ---------- Agent lifecycle ----------

export async function defaultAgent(workspaceId: string): Promise<AgentRow | null> {
  const A = schema.aiAgents;
  const [row] = await db.select().from(A).where(and(eq(A.workspaceId, workspaceId), eq(A.type, AgentType.DELIVERABILITY))).orderBy(asc(A.createdAt)).limit(1);
  return row ?? null;
}

/** Creates (or reactivates) the workspace's agent and queues a first cycle. */
export async function deployAgent(workspaceId: string, userId: string | null) {
  const A = schema.aiAgents;
  let agent = await defaultAgent(workspaceId);
  const already = agent?.status === AgentStatus.ACTIVE;
  if (!agent) {
    [agent] = await db
      .insert(A)
      .values({ workspaceId, name: "Deliverability Agent", type: AgentType.DELIVERABILITY, status: AgentStatus.ACTIVE, payload: { integrations: {} }, createdBy: userId, description: "Monitors campaigns and sending accounts and recommends fixes" })
      .returning();
  } else if (!already) {
    [agent] = await db.update(A).set({ status: AgentStatus.ACTIVE }).where(eq(A.id, agent.id)).returning();
  }
  const cycle = already ? null : await startCycle(agent!);
  return { agent: agent!, already, cycle };
}

/** Queues a cycle with one activity per check; returns the running one when a cycle is already underway. */
export async function startCycle(agent: AgentRow) {
  const [running] = await db.select().from(CY).where(and(eq(CY.agentId, agent.id), eq(CY.status, "running"))).limit(1);
  if (running) return { cycle: running, enqueued: false };
  const [cycle] = await db.insert(CY).values({ workspaceId: agent.workspaceId, agentId: agent.id, status: "running", totalChecks: CHECKS.length }).returning();
  await db.insert(AC).values(CHECKS.map((c) => ({ workspaceId: agent.workspaceId, agentId: agent.id, cycleId: cycle!.id, activityCode: c.code, priority: c.priority, status: "queued", subjectType: "workspace", subjectId: agent.workspaceId, updatedAt: new Date() })));
  const next = new Date(Date.now() + RUN_EVERY_MS).toISOString();
  await db.update(schema.aiAgents).set({ payload: { ...(agent.payload ?? {}), next_run_at: next } }).where(eq(schema.aiAgents.id, agent.id));
  return { cycle: cycle!, enqueued: true };
}

/** Opens, refreshes and closes feed items for one finished check. */
async function syncFeed(agent: AgentRow, activity: ActivityRow, check: CheckDef, result: CheckResult): Promise<FeedRow[]> {
  const opened: FeedRow[] = [];
  const seen = new Set<string>();
  for (const f of result.findings) {
    seen.add(f.dedupeKey);
    const [open] = await db.select().from(FI).where(and(eq(FI.agentId, agent.id), eq(FI.dedupeKey, f.dedupeKey), eq(FI.status, "todo"))).limit(1);
    const values = {
      sourceActivityId: activity.id,
      feedCode: f.feedCode,
      kind: f.kind,
      severity: f.severity,
      priority: f.priority,
      subjectType: f.subjectType ?? null,
      subjectId: f.subjectId ?? null,
      subjectName: f.subjectName ?? null,
      payload: f.payload,
      actionCode: f.actionCode ?? null,
    };
    if (open) await db.update(FI).set(values).where(eq(FI.id, open.id));
    else {
      // A dismissed item stays dismissed until the issue changes enough to deserve another look (7 days).
      const [dismissed] = await db
        .select({ id: FI.id })
        .from(FI)
        .where(and(eq(FI.agentId, agent.id), eq(FI.dedupeKey, f.dedupeKey), eq(FI.status, "dismissed"), gte(FI.dismissedAt, new Date(Date.now() - 7 * 86_400_000))))
        .limit(1);
      if (dismissed) continue;
      const [row] = await db.insert(FI).values({ workspaceId: agent.workspaceId, agentId: agent.id, status: "todo", dedupeKey: f.dedupeKey, ...values }).returning();
      opened.push(row!);
    }
  }
  // Skipped or inconclusive checks say nothing about whether old issues are fixed.
  if (result.outcome === "skipped" || (result.outcome === "info" && !result.findings.length)) return opened;
  const stale = await db.select().from(FI).where(and(eq(FI.agentId, agent.id), eq(FI.status, "todo"), inArray(FI.feedCode, check.feedCodes)));
  for (const item of stale) {
    if (seen.has(item.dedupeKey) || result.inconclusive?.includes(item.dedupeKey)) continue;
    await db
      .update(FI)
      .set({ status: "done", completedAt: new Date(), resultPayload: { ...(item.resultPayload ?? {}), resolved: "automatically", resolved_by_activity_id: activity.id } })
      .where(eq(FI.id, item.id));
  }
  return opened;
}

const NOTIFY_SEVERITIES = new Set(["warning", "critical"]);

/** Closes a cycle whose checks are all done (once, however many callers notice). */
async function finishCycle(agent: AgentRow, cycleId: string) {
  const [left] = await db.select({ n: sql<number>`count(*)` }).from(AC).where(and(eq(AC.cycleId, cycleId), inArray(AC.status, ["queued", "in_progress"])));
  if (Number(left?.n ?? 0)) return;
  const acts = await db.select().from(AC).where(eq(AC.cycleId, cycleId));
  const outcomes = acts.map((a) => (a.status === "failed" ? "failed" : ((a.result?.outcome as Outcome | undefined) ?? "skipped")));
  const healthy = outcomes.filter((o) => o === "healthy").length;
  const attention = outcomes.filter((o) => o === "needs_attention").length;
  const info = outcomes.filter((o) => o === "info").length;
  const failed = outcomes.filter((o) => o === "failed").length;
  const scored = healthy + attention + info;
  const score = scored ? Math.round(((healthy + info * 0.5) / scored) * 100) : null;
  const [closed] = await db
    .update(CY)
    .set({ status: "completed", completedAt: new Date(), healthyCount: healthy, needsAttentionCount: attention, infoCount: info, failedCount: failed, score })
    .where(and(eq(CY.id, cycleId), eq(CY.status, "running")))
    .returning();
  if (!closed) return;
  const slack = daPayload(agent).integrations?.slack;
  if (slack?.enabled && slack.connection_id) {
    const fresh = await db.select().from(FI).where(and(eq(FI.agentId, agent.id), eq(FI.status, "todo"), gte(FI.createdAt, new Date(Date.now() - 3_600_000))));
    const urgent = fresh.filter((f) => NOTIFY_SEVERITIES.has(f.severity));
    if (urgent.length) {
      const lines = urgent.slice(0, 8).map((f) => `• ${f.severity === "critical" ? "🔴" : "🟠"} ${String(f.payload.title ?? f.feedCode)}`);
      await postToSlack(agent.workspaceId, slack.connection_id, `Deliverability check: score ${score ?? "n/a"}/100, ${plural(urgent.length, "new issue")}\n${lines.join("\n")}\n${config.webUrl}/app/ai-agents/deliverability`);
    }
  }
}

/** A check running this long was cut short (the app stopped mid-check). */
const INTERRUPTED_AFTER_MS = 15 * 60_000;

/** Fails checks cut short by a restart, so their cycle finishes and the next one can start. */
async function closeInterruptedChecks() {
  const cut = await db
    .update(AC)
    .set({ status: "failed", completedAt: new Date(), updatedAt: new Date(), errorCode: "INTERRUPTED", errorMessage: "The app stopped while this check ran. It runs again with the next check." })
    .where(and(eq(AC.status, "in_progress"), lt(AC.startedAt, new Date(Date.now() - INTERRUPTED_AFTER_MS))))
    .returning();
  for (const act of cut) {
    if (!act.cycleId) continue;
    const [agent] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, act.agentId)).limit(1);
    if (agent) await finishCycle(agent, act.cycleId);
  }
}

/** Runs queued activities one at a time, closing cycles as they finish. */
export async function processDeliverability(maxActivities = 4) {
  await closeInterruptedChecks();
  for (let i = 0; i < maxActivities; i++) {
    const [next] = await db.select().from(AC).where(eq(AC.status, "queued")).orderBy(asc(AC.createdAt), desc(AC.priority)).limit(1);
    if (!next) break;
    const [agent] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, next.agentId)).limit(1);
    if (!agent || agent.status !== AgentStatus.ACTIVE) {
      await db.update(AC).set({ status: "cancelled", updatedAt: new Date(), completedAt: new Date() }).where(and(eq(AC.agentId, next.agentId), eq(AC.status, "queued")));
      if (next.cycleId) await db.update(CY).set({ status: "completed", completedAt: new Date() }).where(and(eq(CY.id, next.cycleId), eq(CY.status, "running")));
      continue;
    }
    const check = CHECK_BY_CODE.get(next.activityCode);
    // Taken in one statement, so two processes never run the same check.
    const [claimed] = await db.update(AC).set({ status: "in_progress", startedAt: new Date(), updatedAt: new Date() }).where(and(eq(AC.id, next.id), eq(AC.status, "queued"))).returning();
    if (!claimed) continue;
    try {
      if (!check) throw new Error(`Unknown check ${next.activityCode}`);
      const result = await check.run(agent.workspaceId);
      const opened = await syncFeed(agent, next, check, result);
      await db
        .update(AC)
        .set({ status: result.outcome === "skipped" ? "skipped" : "completed", completedAt: new Date(), updatedAt: new Date(), result: { outcome: result.outcome, summary: result.summary, findings: result.findings.length, new_feed_items: opened.length, ...(result.metrics ?? {}) } })
        .where(eq(AC.id, next.id));
    } catch (err) {
      await db
        .update(AC)
        .set({ status: "failed", completedAt: new Date(), updatedAt: new Date(), errorCode: "CHECK_FAILED", errorMessage: (err as Error).message?.slice(0, 500) ?? "Check failed" })
        .where(eq(AC.id, next.id));
    }
    if (next.cycleId) await finishCycle(agent, next.cycleId);
  }
}

/** Starts the daily cycle for agents that are due and trims old completed activities. */
export async function scheduleDeliverability() {
  const agents = await db
    .select()
    .from(schema.aiAgents)
    .where(and(eq(schema.aiAgents.type, AgentType.DELIVERABILITY), eq(schema.aiAgents.status, AgentStatus.ACTIVE), await inUse(schema.aiAgents.workspaceId)));
  for (const a of agents) {
    const due = Date.parse(daPayload(a).next_run_at ?? "") || 0;
    if (due <= Date.now()) await startCycle(a);
  }
  await db.delete(AC).where(and(inArray(AC.status, ["completed", "skipped", "failed", "cancelled"]), lt(AC.completedAt, new Date(Date.now() - RETENTION_DAYS * 86_400_000))));
}

// ---------- State ----------

export async function feedPage(agentId: string, filter: "all" | "todo" | "done", limit: number, startingAfter?: string) {
  const conds = [eq(FI.agentId, agentId)];
  if (filter === "todo") conds.push(eq(FI.status, "todo"));
  if (filter === "done") conds.push(inArray(FI.status, ["done", "dismissed", "failed"]));
  if (startingAfter) conds.push(lt(FI.id, startingAfter));
  const rows = await db.select().from(FI).where(and(...conds)).orderBy(desc(FI.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(serializeFeedItem), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
}

const cycleChecks = (acts: ActivityRow[]) =>
  acts
    .sort((x, y) => y.priority - x.priority)
    .map((a) => ({
      activity_id: a.id,
      activity_code: a.activityCode,
      status: a.status,
      outcome: a.status === "completed" || a.status === "skipped" ? ((a.result?.outcome as string) ?? "unknown") : a.status === "in_progress" ? "running" : a.status,
      summary: (a.result?.summary as string | undefined) ?? a.errorMessage ?? null,
      completed_at: iso(a.completedAt),
    }));

export async function agentState(agent: AgentRow | null, q: { limit: number; startingAfter?: string; feedFilter: "all" | "todo" | "done" }) {
  if (!agent) {
    return {
      agent: null,
      current_activity: { active: null, queued: [], completed_summary: { count: 0, retention_days: RETENTION_DAYS, last_completed_at: null } },
      schedule: { next_run_at: null },
      run_summary: { latest: { cycle_id: null, status: "empty", started_at: null, completed_at: null, total_checks: 0, completed_checks: 0, healthy_count: 0, needs_attention_count: 0, info_count: 0, failed_count: 0, checks: [], feed_items: [] }, trend: [] },
      activity_feed: { items: [], next_starting_after: null },
    };
  }
  const [active] = await db.select().from(AC).where(and(eq(AC.agentId, agent.id), eq(AC.status, "in_progress"))).limit(1);
  const queued = await db.select().from(AC).where(and(eq(AC.agentId, agent.id), eq(AC.status, "queued"))).orderBy(desc(AC.priority)).limit(50);
  const [done] = await db
    .select({ n: sql<number>`count(*)`, last: sql<number | null>`max(${AC.completedAt})` })
    .from(AC)
    .where(and(eq(AC.agentId, agent.id), inArray(AC.status, ["completed", "skipped", "failed"]), gte(AC.completedAt, new Date(Date.now() - RETENTION_DAYS * 86_400_000))));
  const [latestCycle] = await db.select().from(CY).where(eq(CY.agentId, agent.id)).orderBy(desc(CY.startedAt)).limit(1);
  let latest: Record<string, unknown>;
  if (latestCycle) {
    const acts = await db.select().from(AC).where(eq(AC.cycleId, latestCycle.id));
    const feed = await db.select().from(FI).where(and(eq(FI.agentId, agent.id), inArray(FI.sourceActivityId, acts.map((a) => a.id).concat([""])))).orderBy(desc(FI.priority)).limit(50);
    const outcomes = acts.map((a) => (a.status === "failed" ? "failed" : (a.result?.outcome as string | undefined)));
    latest = {
      cycle_id: latestCycle.id,
      status: latestCycle.status,
      started_at: iso(latestCycle.startedAt),
      completed_at: iso(latestCycle.completedAt),
      total_checks: latestCycle.totalChecks,
      completed_checks: acts.filter((a) => ["completed", "skipped", "failed", "cancelled"].includes(a.status)).length,
      healthy_count: outcomes.filter((o) => o === "healthy").length,
      needs_attention_count: outcomes.filter((o) => o === "needs_attention").length,
      info_count: outcomes.filter((o) => o === "info").length,
      failed_count: outcomes.filter((o) => o === "failed").length,
      score: latestCycle.score,
      checks: cycleChecks(acts),
      feed_items: feed.map(serializeFeedItem),
    };
  } else {
    latest = { cycle_id: null, status: "scheduled", started_at: null, completed_at: null, total_checks: 0, completed_checks: 0, healthy_count: 0, needs_attention_count: 0, info_count: 0, failed_count: 0, checks: [], feed_items: [] };
  }
  const trendRows = await db.select().from(CY).where(and(eq(CY.agentId, agent.id), eq(CY.status, "completed"))).orderBy(desc(CY.completedAt)).limit(14);
  return {
    agent: serializeDeliverabilityAgent(agent),
    current_activity: {
      active: active ? serializeActivity(active) : null,
      queued: queued.map(serializeActivity),
      completed_summary: { count: Number(done?.n ?? 0), retention_days: RETENTION_DAYS, last_completed_at: done?.last ? new Date(Number(done.last)).toISOString() : null },
    },
    schedule: { next_run_at: agent.status === AgentStatus.ACTIVE ? (daPayload(agent).next_run_at ?? null) : null },
    run_summary: {
      latest,
      trend: trendRows.reverse().map((c) => ({
        cycle_id: c.id,
        completed_at: iso(c.completedAt),
        score: c.score,
        total_checks: c.totalChecks,
        healthy_count: c.healthyCount,
        needs_attention_count: c.needsAttentionCount,
        info_count: c.infoCount,
        failed_count: c.failedCount,
      })),
    },
    activity_feed: await feedPage(agent.id, q.feedFilter, q.limit, q.startingAfter),
  };
}

// ---------- Feed actions ----------

const accountsOf = async (item: FeedRow) => {
  const ids = (item.payload.account_ids as string[] | undefined) ?? [];
  return ids.length ? db.select().from(ACC).where(and(eq(ACC.workspaceId, item.workspaceId), inArray(ACC.id, ids))) : [];
};

/**
 * Re-runs the check behind an item and reports whether its issue is still present: null when the check couldn't
 * tell (it was skipped, or DNS or the blocklists didn't answer).
 */
async function stillPresent(item: FeedRow): Promise<{ present: boolean | null; finding?: Finding }> {
  const owner = CHECKS.find((c) => c.feedCodes.includes(item.feedCode));
  if (!owner) return { present: true };
  const result = await owner.run(item.workspaceId);
  if (result.outcome === "skipped" || (result.outcome === "info" && !result.findings.length) || result.inconclusive?.includes(item.dedupeKey)) return { present: null };
  const finding = result.findings.find((f) => f.dedupeKey === item.dedupeKey);
  return { present: !!finding, finding };
}

export async function pauseAffectedAccounts(item: FeedRow) {
  const base = { affected_account_count: 0, affected_domain_count: 0, paused_account_count: 0, paused_provider_counts: { custom_imap_smtp: 0, google: 0, microsoft: 0, airmail: 0, other: 0 }, paused_managed_account_count: 0, paused_self_managed_account_count: 0 };
  if (item.status === "done" && item.actionCode === "pause_affected_accounts" && item.actionStatus === "completed") {
    return { item, ...base, ...((item.actionPayload ?? {}) as object) };
  }
  const check = await stillPresent(item);
  // Gone for sure: nothing to pause. When the check can't tell, the mailboxes are paused as asked.
  if (check.present === false) {
    const [row] = await db.update(FI).set({ status: "done", completedAt: new Date(), resultPayload: { resolved: "revalidated" } }).where(eq(FI.id, item.id)).returning();
    return { item: row!, ...base };
  }
  const ids = ((check.finding?.payload.account_ids as string[] | undefined) ?? (item.payload.account_ids as string[] | undefined)) ?? [];
  const accounts = ids.length ? await db.select().from(ACC).where(and(eq(ACC.workspaceId, item.workspaceId), inArray(ACC.id, ids))) : [];
  const toPause = accounts.filter((a) => a.status === AccountStatus.ACTIVE);
  if (toPause.length) await db.update(ACC).set({ status: AccountStatus.PAUSED }).where(inArray(ACC.id, toPause.map((a) => a.id)));
  const counts = { ...base.paused_provider_counts };
  for (const a of toPause) counts[providerBucket(a.providerCode)]++;
  const result = {
    affected_account_count: accounts.length,
    affected_domain_count: new Set(accounts.map((a) => domainOf(a.email))).size,
    paused_account_count: toPause.length,
    paused_provider_counts: counts,
    paused_managed_account_count: toPause.filter((a) => a.isManaged || a.dfyOrderId).length,
    paused_self_managed_account_count: toPause.filter((a) => !a.isManaged && !a.dfyOrderId).length,
  };
  const [row] = await db
    .update(FI)
    .set({ status: "done", completedAt: new Date(), actionCode: "pause_affected_accounts", actionStatus: "completed", actionPayload: result, resultPayload: { resolved: "action", paused_account_ids: toPause.map((a) => a.id) } })
    .where(eq(FI.id, item.id))
    .returning();
  return { item: row!, ...result };
}

export async function pauseCampaignSending(item: FeedRow) {
  if (item.status === "done" && item.actionCode === "pause_campaign_sending" && item.actionStatus === "completed") {
    return { item, ...((item.actionPayload ?? {}) as object) };
  }
  const accounts = await accountsOf(item);
  const until = new Date(Date.now() + CAMPAIGN_PAUSE_DAYS * 86_400_000);
  // Managed (ready-made / done-for-you) mailboxes are looked after by the provider and are left alone.
  const managed = accounts.filter((a) => a.isManaged || a.dfyOrderId);
  const self = accounts.filter((a) => !a.isManaged && !a.dfyOrderId);
  const already = self.filter((a) => a.campaignPauseUntil && a.campaignPauseUntil.getTime() > Date.now());
  const toPause = self.filter((a) => !already.includes(a));
  if (toPause.length) await db.update(ACC).set({ campaignPauseUntil: until }).where(inArray(ACC.id, toPause.map((a) => a.id)));
  const result = {
    affected_account_count: accounts.length,
    paused_account_count: toPause.length,
    already_paused_account_count: already.length,
    managed_account_count: managed.filter((a) => a.isManaged).length,
    ready_made_account_count: managed.filter((a) => !!a.dfyOrderId).length,
    pause_sending_campaigns_until: until.toISOString(),
    duration_days: CAMPAIGN_PAUSE_DAYS,
  };
  const [row] = await db
    .update(FI)
    .set({ status: "done", completedAt: new Date(), actionCode: "pause_campaign_sending", actionStatus: "completed", actionPayload: result, resultPayload: { resolved: "action", paused_account_ids: toPause.map((a) => a.id) } })
    .where(eq(FI.id, item.id))
    .returning();
  return { item: row!, ...result };
}

/** Manual completion: allowed for workspace-settings recommendations once the issue is really gone. */
export async function completeItem(item: FeedRow): Promise<{ item: FeedRow } | { error: string }> {
  if (item.status === "done") return { item };
  if (item.feedCode !== "workspace_settings_recommendation") return { error: "Only workspace settings recommendations can be completed by hand; the others close automatically once the next check finds them fixed." };
  const check = await stillPresent(item);
  if (check.present === null) return { error: "The check couldn't run just now, so it can't tell whether this is fixed. Try again in a while." };
  if (check.present) return { error: `The issue is still present: ${String(item.payload.title ?? item.feedCode)}` };
  const [row] = await db.update(FI).set({ status: "done", completedAt: new Date(), resultPayload: { resolved: "manual" } }).where(eq(FI.id, item.id)).returning();
  return { item: row! };
}

export async function slackSettings(workspaceId: string, slack: { connection_id: string; enabled: boolean } | null) {
  if (!slack) return null;
  const conn = await getIntegration(workspaceId, slack.connection_id, "slack");
  if (!conn) return undefined;
  return { connection_id: conn.id, enabled: slack.enabled, connection_name: conn.name };
}

