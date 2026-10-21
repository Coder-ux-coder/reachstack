// Home screen: the workspace activity feed and the getting-started checklist.
import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { CampaignStatus } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { query, zInt, zList } from "../http/util";
import { iso } from "../lib/time";

const FEED_TYPES = ["reply", "auto_reply", "open", "click", "bounce", "unsubscribe", "opportunity", "interest_change"] as const;
const DEFAULT_FEED = FEED_TYPES.filter((t) => t !== "auto_reply");

export default async function dashboardRoutes(app: FastifyInstance) {
  const E = schema.emailEvents;

  app.get("/api/app/activity-feed", { config: { perm: "dashboard" } }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).default(30),
        starting_after: z.string().optional(),
        types: zList,
        campaign_id: z.string().optional(),
      }),
    );
    const wanted = q.types?.length ? FEED_TYPES.filter((t) => q.types!.includes(t)) : DEFAULT_FEED;
    if (!wanted.length) return { items: [], next_starting_after: null };
    const conds = [
      eq(E.workspaceId, c.wsId),
      inArray(E.type, wanted),
      // Only the first open of each email; repeat opens are noise in a feed. (`isFirst` is the lead's first open ever,
      // which would leave out every later email's.) Looked up through the lead's own events.
      or(ne(E.type, "open"), sql`not exists (select 1 from ${E} o where o.lead_id = ${E.leadId} and o.email_id = ${E.emailId} and o.type = 'open' and o.id < ${E.id})`),
    ];
    if (q.campaign_id) conds.push(or(eq(E.campaignId, q.campaign_id), eq(E.subsequenceId, q.campaign_id))!);
    if (q.starting_after) conds.push(lt(E.id, q.starting_after));
    const rows = await db
      .select()
      .from(E)
      .where(and(...conds))
      .orderBy(desc(E.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);

    const leadIds = [...new Set(page.map((r) => r.leadId).filter((x): x is string => !!x))];
    const campaignIds = [...new Set(page.flatMap((r) => [r.campaignId, r.subsequenceId]).filter((x): x is string => !!x))];
    const leads = leadIds.length
      ? await db
          .select({ id: schema.leads.id, firstName: schema.leads.firstName, lastName: schema.leads.lastName, companyName: schema.leads.companyName })
          .from(schema.leads)
          .where(inArray(schema.leads.id, leadIds))
      : [];
    const campaigns = campaignIds.length
      ? await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds))
      : [];
    const subs = campaignIds.length
      ? await db.select({ id: schema.subsequences.id, name: schema.subsequences.name }).from(schema.subsequences).where(inArray(schema.subsequences.id, campaignIds))
      : [];
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const nameById = new Map([...campaigns, ...subs].map((x) => [x.id, x.name]));

    return {
      items: page.map((r) => {
        const lead = r.leadId ? leadById.get(r.leadId) : undefined;
        return {
          id: r.id,
          type: r.type,
          timestamp: iso(r.createdAt),
          lead_id: r.leadId,
          lead_email: r.leadEmail,
          lead_name: lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null : null,
          company_name: lead?.companyName ?? null,
          campaign_id: r.campaignId,
          campaign_name: (r.subsequenceId && nameById.get(r.subsequenceId)) || (r.campaignId ? nameById.get(r.campaignId) : null) || null,
          account_email: r.accountEmail,
          email_id: r.emailId,
          step: r.step,
          url: r.url,
          value: r.value,
        };
      }),
      next_starting_after: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  });

  /** What a new workspace still has to do before its first campaign sends. */
  app.get("/api/app/dashboard/setup", { config: {} }, async (req) => {
    const c = ctx(req);
    const ws = c.wsId;
    const A = schema.emailAccounts;
    const C = schema.campaigns;
    const [[accounts], [warming], [campaigns], [launched], [leads], [replies]] = await Promise.all([
      db.select({ n: count() }).from(A).where(eq(A.workspaceId, ws)),
      db.select({ n: count() }).from(A).where(and(eq(A.workspaceId, ws), eq(A.warmupStatus, 1))),
      db.select({ n: count() }).from(C).where(eq(C.workspaceId, ws)),
      // Launched once is launched: a campaign the engine stopped since (bounces, mailboxes) still counts.
      db
        .select({ n: count() })
        .from(C)
        .where(and(eq(C.workspaceId, ws), or(isNotNull(C.launchedAt), ne(C.status, CampaignStatus.DRAFT)))),
      db.select({ n: count() }).from(schema.leads).where(eq(schema.leads.workspaceId, ws)),
      db.select({ n: count() }).from(E).where(and(eq(E.workspaceId, ws), eq(E.type, "reply"))),
    ]);
    const [{ verified } = { verified: false }] = await db
      .select({ verified: sql<boolean>`${schema.users.emailVerifiedAt} is not null` })
      .from(schema.users)
      .where(eq(schema.users.id, c.user.id));
    const steps = [
      // Confirming the address takes an email this installation can send; without one it could never be ticked off.
      ...(config.systemSmtp.host ? [{ key: "verify_email", done: !!verified }] : []),
      { key: "connect_account", done: (accounts?.n ?? 0) > 0 },
      { key: "enable_warmup", done: (warming?.n ?? 0) > 0 },
      { key: "create_campaign", done: (campaigns?.n ?? 0) > 0 },
      { key: "add_leads", done: (leads?.n ?? 0) > 0 },
      { key: "launch_campaign", done: (launched?.n ?? 0) > 0 },
      { key: "first_reply", done: (replies?.n ?? 0) > 0 },
    ];
    return {
      steps,
      completed: steps.filter((s) => s.done).length,
      total: steps.length,
      counts: { accounts: accounts?.n ?? 0, warming: warming?.n ?? 0, campaigns: campaigns?.n ?? 0, launched: launched?.n ?? 0, leads: leads?.n ?? 0, replies: replies?.n ?? 0 },
    };
  });
}
