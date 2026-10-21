// Launch checks worth a second look but that don't stop a launch (the blocking ones are launchProblems): settings,
// mailboxes, links and opt-outs, and the leads who'd get an email with a gap where a {{variable}} goes, shown with
// a preview of the worst of those emails.
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  AccountStatus,
  LeadStatus,
  ProviderCode,
  SENDER_VARIABLES,
  emptyVariables,
  escapeHtml,
  renderTemplate,
  senderVariables,
  variableUses,
  type TemplateWarning,
  type VariableUse,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { templateVars } from "../engine/sender";
import { config } from "../env";
import { leadClock } from "../lib/time";
import { effectiveDailyLimit, todayStats } from "./accounts";
import type { LeadRow } from "./activity";
import { activeSteps, campaignSenders, type CampaignRow } from "./campaigns";
import { reachableFromInternet } from "./tracking";

/** A shorter gap between one mailbox's emails looks automated. */
const MIN_GAP_MINUTES = 5;
/** Mailboxes connected and warmed up for less than this are new to sending. */
const NEW_MAILBOX_DAYS = 14;
const DAY = 86_400_000;

/** One readable line per template problem (previews and launch checks show these). */
export function describeTemplateWarning(w: TemplateWarning): string {
  switch (w.kind) {
    case "unresolved":
      return `${w.token} isn't a field this lead has, so it's left empty.`;
    case "structured_leaf":
      return `${w.token} holds several values, not text, so it's left empty. Use one of its fields.`;
    case "array_index_required":
      return `${w.token} is a list, so it's left empty. Use one item, like ${w.token.replace(/}}$/, ".0}}")}.`;
    default:
      return `${w.token} matches more than one field; the first one is used.`;
  }
}

/** `{{variables}}` no lead in the campaign can fill (usually a typo), with the steps that use them. */
async function unknownVariables(c: CampaignRow): Promise<Map<string, number[]>> {
  const vars = templateVars(null, null, "UTC", "#");
  for (const k of c.customVariables ?? []) vars[k] = "x";
  // Enrichment and AI columns write straight into the leads, so their names count as well.
  const keys = await db.all<{ key: string }>(sql`select distinct j.key as key from ${schema.leads}, json_each(${schema.leads.payload}) j where ${schema.leads.campaignId} = ${c.id}`);
  for (const { key } of keys) vars[key] ??= "x";
  const found = new Map<string, number[]>();
  activeSteps(c).forEach((step, i) => {
    for (const v of step.variants) {
      if (v.v_disabled) continue;
      for (const w of [...renderTemplate(v.subject ?? "", vars).warnings, ...renderTemplate(v.body ?? "", vars).warnings]) {
        if (w.kind !== "unresolved") continue;
        const steps = found.get(w.token) ?? [];
        if (!steps.includes(i + 1)) found.set(w.token, [...steps, i + 1]);
      }
    }
  });
  return found;
}

const listSteps = (steps: number[]) => (steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}`);
const listEmails = (emails: string[]) => (emails.length <= 2 ? emails.join(" and ") : `${emails.slice(0, 2).join(", ")} and ${emails.length - 2} more`);

export async function launchWarnings(c: CampaignRow): Promise<string[]> {
  const out: string[] = [];
  for (const [token, steps] of await unknownVariables(c)) {
    out.push(`${token} in ${listSteps(steps)} isn't a lead field or custom variable, so it will be left empty. Check the spelling, or give it a fallback like {{firstName|there}}.`);
  }
  out.push(...(await senderGaps(c)), ...linkWarnings(c));
  const optOut = optOutWarning(c);
  if (optOut) out.push(optOut);
  const gap = c.emailGap ?? 10;
  if (gap < MIN_GAP_MINUTES) out.push(`Each mailbox sends an email every ${gap === 0 ? "few seconds" : gap === 1 ? "minute" : `${gap} minutes`}. At least ${MIN_GAP_MINUTES} minutes apart looks more like a person and lands in the inbox more often (Options → Sending pattern).`);

  const senders = (await campaignSenders(c)).filter((a) => a.status === AccountStatus.ACTIVE);
  const real = senders.filter((a) => a.providerCode !== ProviderCode.SANDBOX);
  const stats = await todayStats(senders);
  const capacity = senders.reduce((n, a) => n + effectiveDailyLimit(a, stats.get(a.id)), 0);
  if (senders.length && c.dailyLimit && c.dailyLimit > capacity) {
    out.push(`The campaign may send ${c.dailyLimit} emails a day, but its mailboxes can only send ${capacity} between them, so it will send at most ${capacity}. Add mailboxes or raise their daily limits to reach ${c.dailyLimit}.`);
  }
  const now = Date.now();
  const fresh = real.filter((a) => now - a.createdAt.getTime() < NEW_MAILBOX_DAYS * DAY && (!a.warmupStartedAt || now - a.warmupStartedAt.getTime() < NEW_MAILBOX_DAYS * DAY));
  if (fresh.length) {
    out.push(`${listEmails(fresh.map((a) => a.email))} ${fresh.length === 1 ? "was" : "were"} connected less than two weeks ago and ${fresh.length === 1 ? "hasn't" : "haven't"} been warmed up that long. New mailboxes that send campaigns right away often land in spam.`);
  }
  const untracked = real.filter((a) => !(a.trackingDomainName && a.trackingDomainStatus === "verified"));
  const tracking = c.openTracking ? (c.linkTracking ? "Open and link tracking are" : "Open tracking is") : c.linkTracking ? "Link tracking is" : null;
  if (untracked.length && !reachableFromInternet(config.trackingBaseUrl)) {
    // Run on a computer without a public address: nobody who gets the email can reach this server.
    const where = new URL(config.trackingBaseUrl).host;
    const unsub = c.insertUnsubscribeHeader || usesUnsubscribeLink(c);
    if (tracking || unsub) {
      out.push(
        [
          `This server's address (${where}) can't be reached from the internet, so emails from ${untracked.length === real.length ? "your mailboxes" : listEmails(untracked.map((a) => a.email))} can't link back to it.`,
          tracking ? `${tracking} on, but links stay as written and opens and clicks aren't counted (replies and bounces still are).` : "",
          unsub ? "The unsubscribe link asks to unsubscribe by email instead, which works: the reply unsubscribes them." : "",
          tracking ? "To track opens and clicks, run Reachstack on a server with a public address." : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  } else if (tracking && untracked.length) {
    out.push(
      `${tracking} on, but ${untracked.length === real.length ? "your mailboxes have" : `${listEmails(untracked.map((a) => a.email))} ${untracked.length === 1 ? "has" : "have"}`} no custom tracking domain, so tracked emails point at this server's address. A tracking domain of your own lands better (Email accounts → the mailbox → Custom tracking domain).`,
    );
  }
  return out;
}

/** Whether an email of the campaign has an unsubscribe link ({{unsubscribe_url}}). */
function usesUnsubscribeLink(c: CampaignRow): boolean {
  return activeSteps(c).some((s) => s.type !== "task" && s.variants.some((v) => !v.v_disabled && /\{\{\s*(?:unsubscribe_url|unsubscribeLink)\b/.test(v.body ?? "")));
}

// ---------- Every email the leads would get ----------

/** The enabled variants of each email step, with the variables they use parsed once (a task step has none: a person reads it). */
function parsedSteps(c: CampaignRow) {
  return activeSteps(c).map((s) =>
    s.type === "task" ? [] : s.variants.flatMap((v, variant) => (v.v_disabled ? [] : [{ variant, uses: [...variableUses(v.subject ?? ""), ...variableUses(v.body ?? "")] }])),
  );
}

/** An empty signature is a choice, not a gap. */
const OPTIONAL = new Set(["{{accountSignature}}"]);
const SENDER_KEYS = new Set<string>(SENDER_VARIABLES.map((v) => v.key));
/** Leads checked at most; a bigger campaign is judged on its first leads. */
const MAX_LEADS_CHECKED = 20_000;
/** Marks a gap in the worst-case preview: a character no email text contains. */
const GAP = "\u0000";
const GAP_RE = /\u0000(\{\{[^\u0000]*\}\})\u0000/g;
/** A gap however it came out: in a link's address it's percent-encoded, and in a query value its marks too. */
const ANY_GAP = /\u0000[^\u0000]*\u0000|%00.*?%00/g;

export interface PersonalizationGap {
  token: string;
  /** Leads still to be emailed who'd get the gap. */
  leads: number;
  /** Steps (from 1) where it happens. */
  steps: number[];
}

export interface WorstCase {
  lead: { id: string; email: string | null; name: string };
  /** The step (from 1) of the email shown. */
  step: number;
  missing: string[];
  /** The subject as written, with each gap as its own part. */
  subject: Array<{ text: string } | { missing: string }>;
  /** The email's HTML with each gap marked. */
  body: string;
}

export interface PersonalizationCheck {
  /** Leads still to be emailed (active or paused). */
  leads: number;
  /** How many of them were checked. */
  checked: number;
  /** Leads who'd get at least one gap. */
  affected: number;
  gaps: PersonalizationGap[];
  worst: WorstCase | null;
}

/**
 * The `{{variables}}` some leads have no value for (and that have no fallback), in the emails each lead still has
 * to get, with a preview of the email with the most gaps. Variables no lead has at all are reported by
 * launchWarnings as a likely typo instead. Null when no lead would get a gap.
 */
export async function personalizationCheck(c: CampaignRow): Promise<PersonalizationCheck | null> {
  const steps = parsedSteps(c);
  if (!steps.some((s) => s.some((v) => v.uses.some((u) => u.fallback === null)))) return null;
  const L = schema.leads;
  const toEmail = and(eq(L.campaignId, c.id), inArray(L.status, [LeadStatus.ACTIVE, LeadStatus.PAUSED]));
  const total = Number((await db.select({ n: count() }).from(L).where(toEmail))[0]?.n ?? 0);
  if (!total) return null;
  const leads = await db.select().from(L).where(toEmail).orderBy(asc(L.createdAt), asc(L.id)).limit(MAX_LEADS_CHECKED);
  const typos = new Set((await unknownVariables(c)).keys());

  const gaps = new Map<string, { leads: number; steps: Set<number> }>();
  let affected = 0;
  let worst: { lead: LeadRow; step: number; variant: number; missing: string[] } | null = null;
  for (const lead of leads) {
    // Sample sender values: a mailbox without a name is its own warning, not every lead's gap.
    const vars = templateVars(lead, null, leadClock(c.schedule, lead.timezone), "#");
    const theirs = new Set<string>();
    for (let i = Math.max(0, lead.nextStep ?? 0); i < steps.length; i++) {
      for (const v of steps[i]!) {
        const missing = emptyVariables(v.uses, vars).filter((t) => !OPTIONAL.has(t));
        for (const token of missing) {
          theirs.add(token);
          if (typos.has(token)) continue;
          const g = gaps.get(token) ?? { leads: 0, steps: new Set<number>() };
          g.steps.add(i + 1);
          gaps.set(token, g);
        }
        if (missing.length && (!worst || missing.length > worst.missing.length)) worst = { lead, step: i, variant: v.variant, missing };
      }
    }
    for (const token of theirs) {
      const g = gaps.get(token);
      if (g) g.leads++;
    }
    if ([...theirs].some((t) => gaps.has(t))) affected++;
  }
  if (!gaps.size) return null;
  return {
    leads: total,
    checked: leads.length,
    affected,
    gaps: [...gaps].map(([token, g]) => ({ token, leads: g.leads, steps: [...g.steps].sort((a, b) => a - b) })).sort((a, b) => b.leads - a.leads),
    worst: worst ? await renderWorst(c, worst) : null,
  };
}

/** The worst email as that lead would get it from the campaign's first mailbox, with its gaps marked. */
async function renderWorst(c: CampaignRow, w: { lead: LeadRow; step: number; variant: number; missing: string[] }): Promise<WorstCase> {
  const [account] = await campaignSenders(c);
  const vars = templateVars(w.lead, account ?? null, leadClock(c.schedule, w.lead.timezone), "#unsubscribe");
  for (const token of w.missing) vars[token.slice(2, -2)] = `${GAP}${token}${GAP}`;
  const v = activeSteps(c)[w.step]!.variants[w.variant]!;
  // The first spintax option, as in the sequence preview.
  const subject = renderTemplate(v.subject ?? "", vars, { random: () => 0 }).output;
  const html = renderTemplate(v.body ?? "", vars, { escapeHtml: true, random: () => 0 }).output;
  const mark = (token: string) =>
    `<mark title="Empty for this lead" style="background:#fef3c7;color:#92400e;border-radius:4px;padding:0 4px;font-size:90%">${escapeHtml(token)}</mark>`;
  return {
    lead: { id: w.lead.id, email: w.lead.email, name: [w.lead.firstName, w.lead.lastName].filter(Boolean).join(" ") },
    step: w.step + 1,
    missing: w.missing,
    subject: subject.split(GAP_RE).flatMap((part, i): WorstCase["subject"] => (i % 2 ? [{ missing: part }] : part ? [{ text: part }] : [])),
    // A gap inside a tag (a link's address) just disappears; elsewhere it's marked.
    body: html.replace(/<[^>]*>/g, (tag) => tag.replace(ANY_GAP, "")).replace(GAP_RE, (_, token: string) => mark(token)),
  };
}

/** Mailboxes without a name, when the emails use it (`Hi, I'm {{sendingAccountFirstName}}`). */
async function senderGaps(c: CampaignRow): Promise<string[]> {
  const uses: VariableUse[] = parsedSteps(c)
    .flat()
    .flatMap((v) => v.uses)
    .filter((u) => SENDER_KEYS.has(u.name));
  if (!uses.length) return [];
  const missing = new Map<string, string[]>();
  for (const a of (await campaignSenders(c)).filter((a) => a.status === AccountStatus.ACTIVE)) {
    const vars = senderVariables({ email: a.email, first_name: a.firstName, last_name: a.lastName, signature: a.signature });
    for (const token of emptyVariables(uses, vars).filter((t) => !OPTIONAL.has(t))) missing.set(token, [...(missing.get(token) ?? []), a.email]);
  }
  return [...missing].map(
    ([token, emails]) => `${listEmails(emails)} ${emails.length === 1 ? "has" : "have"} no name set, so ${token} comes out empty in ${emails.length === 1 ? "its" : "their"} emails. Add it in Email accounts → the mailbox → Settings, or give it a fallback.`,
  );
}

// ---------- Links and opting out ----------

const HREF = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gis;
const PLACEHOLDER_HOST = /^(?:www\.)?(?:example\.(?:com|org|net)|your-?(?:domain|website|site|company|link|url)\.[a-z]+|(?:website|domain|company|link|url|mysite|site)\.com)$/i;
const PRIVATE_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$|\.(?:local|localhost|internal|test|invalid)$/i;

/** Links people can't open: no address, not a web address, a placeholder or an address only your network has. */
export function linkWarnings(c: CampaignRow): string[] {
  const found = new Map<string, number[]>();
  activeSteps(c).forEach((s, i) => {
    if (s.type === "task") return;
    for (const v of s.variants) {
      if (v.v_disabled) continue;
      for (const m of (v.body ?? "").matchAll(HREF)) {
        const href = m[2]!.trim().replace(/&amp;/g, "&");
        // Personalized addresses are covered by the gap check; mailto and tel links aren't web pages.
        if (href.includes("{{") || /^(?:mailto|tel):/i.test(href)) continue;
        let problem: string | null = null;
        if (!href || href === "#") problem = "a link without an address";
        else {
          let url: URL | null = null;
          try {
            url = new URL(href);
          } catch {
            // reported below
          }
          const notWeb = `a link to "${href.slice(0, 80)}", which isn't a full web address (start it with https://)`;
          if (!url || !/^https?:$/.test(url.protocol) || /\s/.test(href)) problem = notWeb;
          else if (PRIVATE_HOST.test(url.hostname)) problem = `a link to ${url.hostname}, which people outside your network can't open`;
          else if (!url.hostname.includes(".")) problem = notWeb;
          else if (PLACEHOLDER_HOST.test(url.hostname)) problem = `a link to ${url.hostname}, which looks like a placeholder`;
        }
        if (problem) found.set(problem, [...new Set([...(found.get(problem) ?? []), i + 1])]);
      }
    }
  });
  return [...found].map(([problem, steps]) => `${steps.length === 1 ? `Step ${steps[0]} has` : `Steps ${steps.join(", ")} have`} ${problem}.`);
}

/** Words that offer a way out: an unsubscribe link, or a line asking them to reply. */
const OPT_OUT = /\{\{\s*(?:unsubscribe_url|unsubscribeLink)\b|unsubscribe|opt[\s-]?out|\breply\s+(?:with\s+)?["“'‘]?(?:stop|no|remove|unsubscribe)\b|not (?:the right (?:person|time)|interested)|(?:rather|prefer) not (?:to )?hear|(?:won't|will not) (?:email|reach out|contact you) again|remove you from|stop (?:receiving|getting) (?:these|my|emails)/i;

/** A warning when no email offers a way to opt out and the unsubscribe header is off. */
export function optOutWarning(c: CampaignRow): string | null {
  if (c.insertUnsubscribeHeader) return null;
  const steps = activeSteps(c);
  if (!steps.length) return null;
  const offered = steps.some((s) => s.type !== "task" && s.variants.some((v) => !v.v_disabled && OPT_OUT.test(`${v.subject ?? ""}\n${(v.body ?? "").replace(/<[^>]+>/g, " ")}`)));
  if (offered) return null;
  return "None of the emails offers a way to opt out. Add a line like \"Not the right time? Just reply 'stop'.\" (a reply like that unsubscribes the lead), or turn on \"Insert unsubscribe link header\" in Options. Gmail and Yahoo expect an easy way out from anyone sending a lot.";
}
