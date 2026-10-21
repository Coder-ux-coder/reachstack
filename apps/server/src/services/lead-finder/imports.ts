// SuperSearch imports: the people matching a search become leads in a list (or campaign). Revealing a person
// costs credits once per workspace; the enrichments requested with the import then run on the new leads.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { CREDIT_COSTS } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { HttpError } from "../../http/errors";
import { chunk } from "../../http/util";
import { chargeCredits, creditBalance, refundCredits, workspaceLimits } from "../billing-limits";
import { registerJobCleanup, registerJobHandler, type JobContext } from "../jobs";
import { addLeads, uncontactable, type LeadInput } from "../leads";
import { resolveResource, scheduleRun } from "./enrichment";
import { personLocation, searchPeopleAfter, SIGNAL_NEWS, type PersonResult, type SearchFilters } from "./search";

export type SignalRequest = string | { key: string; period_days?: number; keywords?: unknown };

export interface ImportJobData {
  resource_id: string;
  search_filters: SearchFilters;
  limit: number;
  /** Enrichment types to run on the imported leads afterwards. */
  types: string[];
  signal_enrichment?: SignalRequest[];
  supersearch_enrichment_id?: string;
  /** Leave out people without an email address: at import when no lookup runs, after the lookup otherwise. */
  skip_rows_without_email?: boolean;
}

/** How many of `wanted` items the workspace can pay for now; self-hosted installs are unmetered (free). */
export async function affordable(workspaceId: string, wanted: number, unitCost: number): Promise<{ n: number; free: boolean }> {
  if (!wanted || !unitCost) return { n: wanted, free: true };
  if ((await workspaceLimits(workspaceId)).self_hosted) return { n: wanted, free: true };
  return { n: Math.min(wanted, Math.floor((await creditBalance(workspaceId)) / unitCost)), free: false };
}

/** Records reveals and charges for the people not revealed before. Returns the people the workspace may use. */
export async function unlockPeople(workspaceId: string, userId: string | null, people: PersonResult[], reason: string): Promise<{ allowed: PersonResult[]; charged: number; outOfCredits: boolean }> {
  const fresh = people.filter((p) => !p.unlocked);
  const unit = CREDIT_COSTS.lead_finder_unlock;
  const { n, free } = await affordable(workspaceId, fresh.length, unit);
  const paid = new Set(fresh.slice(0, n).map((p) => p.id));
  if (n > 0 && !free && !(await chargeCredits(workspaceId, n * unit, reason, { userId }))) return { allowed: people.filter((p) => p.unlocked), charged: 0, outOfCredits: true };
  let charged = free ? 0 : n * unit;
  if (paid.size) {
    // In parts: each row takes four of a statement's variables, and an export reveals up to 10,000 people at once.
    let added = 0;
    for (const part of chunk([...paid], 1_000)) {
      added += (
        await db
          .insert(schema.lfUnlocks)
          .values(part.map((personId) => ({ workspaceId, personId })))
          .onConflictDoNothing()
          .returning({ personId: schema.lfUnlocks.personId })
      ).length;
    }
    // Revealed meanwhile by another import or reveal, which paid for them: given back here.
    const twice = paid.size - added;
    if (twice > 0 && charged) charged -= await refundCredits(workspaceId, twice * unit, `${reason}_refund`);
  }
  return { allowed: people.filter((p) => p.unlocked || paid.has(p.id)), charged, outOfCredits: n < fresh.length };
}

/** The people a campaign import can pay for in full, in order: the reveal (unless paid for before) and the address. */
export async function payableInFull(workspaceId: string, people: PersonResult[]): Promise<PersonResult[]> {
  let left = await creditBalance(workspaceId);
  const out: PersonResult[] = [];
  for (const p of people) {
    const cost = (p.unlocked ? 0 : CREDIT_COSTS.lead_finder_unlock) + CREDIT_COSTS.work_email_enrichment;
    if (left < cost) break;
    left -= cost;
    out.push(p);
  }
  return out;
}

async function companyNews(companyIds: string[]) {
  if (!companyIds.length) return new Map<string, Array<{ title: string; type?: string; date?: string }>>();
  const rows = await db.select({ id: schema.lfCompanies.id, news: schema.lfCompanies.news }).from(schema.lfCompanies).where(inArray(schema.lfCompanies.id, companyIds));
  return new Map(rows.map((r) => [r.id, r.news ?? []]));
}

/** Lead fields for a dataset person. Campaign imports carry the address (campaigns only accept leads with one). */
export function leadInput(p: PersonResult, withEmail: boolean, extra: Record<string, string | number | boolean | null>): LeadInput {
  return {
    email: withEmail ? p.email : null,
    first_name: p.first_name,
    last_name: p.last_name,
    job_title: p.title,
    company_name: p.company_name,
    company_domain: p.company_domain,
    website: p.company_domain ? `https://${p.company_domain}` : null,
    phone: p.phone,
    linkedin_url: p.linkedin_url,
    location: personLocation(p) || null,
    custom_variables: {
      lf_person_id: p.id,
      seniority: p.seniority,
      department: p.department,
      industry: p.industry,
      company_size: p.employee_count,
      ...extra,
    },
  };
}

async function importPeople({ job, progress, cancelled }: JobContext) {
  const d = job.data as unknown as ImportJobData;
  const ws = job.workspaceId;
  const resource = await resolveResource(ws, d.resource_id);
  const toCampaign = resource.type === 1;
  const L = schema.leads;
  const metered = !(await workspaceLimits(ws)).self_hosted;
  const ADDRESS = CREDIT_COSTS.work_email_enrichment;
  let after: string | null = null;
  let found = 0;
  let imported = 0;
  let duplicates = 0;
  let credits = 0;
  let stopReason: string | null = null;
  const created: string[] = [];
  const signals = (d.signal_enrichment ?? []).map((s) => (typeof s === "string" ? { key: s } : s));
  const lookup = d.types.includes("work_email_enrichment") || d.types.includes("custom_flow");
  // Without a lookup, the people the dataset has no address for will never have one.
  const needEmail = toCampaign || (!!d.skip_rows_without_email && !lookup);
  // Campaign leads get emailed, so a requested verification runs before their first email instead of afterwards.
  const verifyFirst = toCampaign && d.types.includes("email_verification");
  while (found < d.limit) {
    if (await cancelled()) {
      stopReason = "cancelled";
      break;
    }
    const want = Math.min(500, d.limit - found);
    // Each page starts after the last person seen: people added on the way drop out of a search that skips the ones
    // you already have, so counting rows to skip would jump past matches.
    const { people: page, next } = await searchPeopleAfter(ws, d.search_filters, want, after);
    if (!page.length) break;
    after = next;
    found += page.length;
    // Skip people already imported into this list/campaign (leads without an address cannot be matched by email).
    const already = new Set(
      (
        await db
          .select({ pid: sql<string>`json_extract(${L.payload}, '$.lf_person_id')` })
          .from(L)
          .where(and(eq(L.workspaceId, ws), toCampaign ? eq(L.campaignId, d.resource_id) : eq(L.listId, d.resource_id), inArray(sql`json_extract(${L.payload}, '$.lf_person_id')`, page.map((p) => p.id))))
      ).map((r) => r.pid),
    );
    let candidates = page.filter((p) => !already.has(p.id) && (!needEmail || p.email));
    // People the campaign would turn away (unsubscribed, bounced, blocked) aren't revealed or paid for.
    if (toCampaign) {
      const refused = await uncontactable(ws, candidates.map((p) => p.email ?? ""), d.resource_id);
      if (refused.size) candidates = candidates.filter((p) => !refused.has((p.email ?? "").toLowerCase()));
    }
    duplicates += page.length - candidates.length;
    // A campaign import also reveals each address (the work-email lookup's cost): only the people it can pay both for.
    const payable = toCampaign && metered ? await payableInFull(ws, candidates) : candidates;
    const unlocked = await unlockPeople(ws, job.userId, payable, "lead_finder:import");
    credits += unlocked.charged;
    let people = unlocked.allowed;
    let short = unlocked.outOfCredits || payable.length < candidates.length;
    // What this page's addresses cost: given back for every lead that doesn't go in.
    let addresses = 0;
    if (toCampaign && metered && people.length) {
      if (await chargeCredits(ws, people.length * ADDRESS, "enrichment:work_email_enrichment", { refId: job.id, userId: job.userId })) addresses = people.length * ADDRESS;
      else {
        people = [];
        short = true;
      }
    }
    const news = signals.length ? await companyNews([...new Set(people.map((p) => p.company_id).filter((x): x is string => !!x))]) : new Map();
    const leads = people.map((p) => {
      const extra: Record<string, string | null> = {};
      for (const s of signals) {
        const types = SIGNAL_NEWS[s.key];
        if (!types) continue;
        const since = s.period_days ? new Date(Date.now() - s.period_days * 86_400_000).toISOString().slice(0, 10) : "";
        const hit = (news.get(p.company_id ?? "") ?? []).find((n: { type?: string; date?: string }) => n.type && types.includes(n.type) && (!since || (n.date ?? "") >= since));
        extra[s.key] = hit ? `${hit.title}${hit.date ? ` (${hit.date})` : ""}` : null;
      }
      return leadInput(p, toCampaign, extra);
    });
    let added = 0;
    if (leads.length) {
      try {
        const r = await addLeads({
          workspaceId: ws,
          ...(toCampaign ? { campaignId: d.resource_id } : { listId: d.resource_id }),
          leads,
          userId: job.userId,
          uploadMethod: "lead-finder",
          skipIfInWorkspace: !!d.search_filters.skip_owned_leads,
          verifyOnImport: verifyFirst,
          batchId: job.id,
        });
        imported += r.leads_uploaded;
        duplicates += r.duplicated_leads + r.skipped_count + r.duplicate_email_count + r.in_blocklist + r.invalid_email_count;
        created.push(...r.created_leads.map((l) => l.id));
        added = r.created_leads.length;
        if (r.over_plan_limit) stopReason = "CONTACT_LIMIT";
      } catch (err) {
        // The plan's contact limit: the leads added so far stay, and the import ends here.
        if (!(err instanceof HttpError && err.statusCode === 402)) {
          if (addresses) await refundCredits(ws, addresses, "enrichment:work_email_enrichment_refund", { refId: job.id });
          throw err;
        }
        stopReason = "CONTACT_LIMIT";
      }
    }
    if (addresses && added < people.length) addresses -= await refundCredits(ws, (people.length - added) * ADDRESS, "enrichment:work_email_enrichment_refund", { refId: job.id });
    credits += addresses;
    await progress(Math.round((found / d.limit) * 100), { found, imported });
    if (stopReason) break;
    if (short) {
      stopReason = "OUT_OF_CREDITS";
      break;
    }
    if (page.length < want) break; // no more matches
  }
  if (d.supersearch_enrichment_id) {
    await db
      .update(schema.enrichments)
      .set({ processed: sql`${schema.enrichments.processed} + ${found}`, succeeded: sql`${schema.enrichments.succeeded} + ${imported}` })
      .where(eq(schema.enrichments.id, d.supersearch_enrichment_id));
  }
  // Auto-updating enrichments already run for every added lead (lead_added); scheduling them here too would
  // enrich, and charge for, the same leads twice.
  const auto = new Set(
    (await db.select({ type: schema.enrichments.type }).from(schema.enrichments).where(and(eq(schema.enrichments.resourceId, d.resource_id), eq(schema.enrichments.autoUpdate, true)))).map((r) => r.type),
  );
  const types = d.types.filter((t) => !auto.has(t) && !(verifyFirst && t === "email_verification"));
  const enrichJob =
    types.length && created.length
      ? await scheduleRun(ws, job.userId, d.resource_id, { leadIds: created, types, dropWithoutEmail: !!d.skip_rows_without_email && lookup, justAdded: true })
      : null;
  return { found, imported, duplicates, credits_used: credits, stop_reason: stopReason, enrichment_job_id: enrichJob?.id ?? null };
}

registerJobHandler("lead-finder-import", importPeople);

// However the import ended (finished, failed, a company list deleted meanwhile, stopped before it started), the search
// stops showing as running, unless another import of it is still waiting or going.
registerJobCleanup("lead-finder-import", async (job) => {
  const id = (job.data as unknown as ImportJobData).supersearch_enrichment_id;
  if (!id) return;
  const J = schema.backgroundJobs;
  const [other] = await db
    .select({ id: J.id })
    .from(J)
    .where(and(eq(J.type, "lead-finder-import"), inArray(J.status, ["pending", "in-progress"]), ne(J.id, job.id), sql`json_extract(${J.data}, '$.supersearch_enrichment_id') = ${id}`))
    .limit(1);
  if (!other) await db.update(schema.enrichments).set({ inProgress: false }).where(eq(schema.enrichments.id, id));
});

/** People revealed by this workspace (for the "owned" badge and exports). */
export async function unlockedIds(workspaceId: string, personIds: string[]): Promise<Set<string>> {
  if (!personIds.length) return new Set();
  const rows = await db
    .select({ id: schema.lfUnlocks.personId })
    .from(schema.lfUnlocks)
    .where(and(eq(schema.lfUnlocks.workspaceId, workspaceId), inArray(schema.lfUnlocks.personId, personIds)));
  return new Set(rows.map((r) => r.id));
}
