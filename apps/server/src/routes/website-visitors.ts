// Website visitors: the public snippet and its collector, plus the app API behind /app/website-visitors
// (identified companies, setup, tracking filters, credits and the visitor terms).
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { EMPLOYEE_BANDS, planById, REVENUE_BANDS } from "@reachstack/shared";
import { db, escapeLike, schema } from "../db/client";
import type { VisitorViewDestinations, VisitorViewFilters } from "../db/schema/growth";
import { config } from "../env";
import { ctx } from "../http/context";
import { assertFound, badRequest, forbidden, HttpError, notFound, tooMany } from "../http/errors";
import { body, chunk, clientIp, query, zBool, zInt } from "../http/util";
import { assertPublicHttpUrl } from "../lib/net";
import { iso } from "../lib/time";
import { creditBalance, workspaceLimits } from "../services/billing-limits";
import { getIntegration } from "../services/integrations";
import { unlockPeople } from "../services/lead-finder/imports";
import { peopleByIds } from "../services/lead-finder/search";
import { VISITOR_SCRIPT } from "../services/visitor-script";
import {
  acceptTerms,
  addVisitorLeads,
  bestContacts,
  checkLookupToken,
  collect,
  contactView,
  createSite,
  deleteSite,
  fitsIcp,
  forgetSite,
  identifiedThisMonth,
  identifyWaiting,
  LookupError,
  lookupSource,
  saveLookupToken,
  serializeSite,
  termsAccepted,
  testSite,
  testViewDestinations,
  visitorSettings,
  VISITOR_TERMS_VERSION,
  type VisitorCompany,
  type VisitRow,
} from "../services/visitors";
import { localDateSql, startOfLastDaysOn, workspaceToday, workspaceZone } from "../services/workspace-clock";
import { toCsv } from "../lib/csv";
const S = schema.visitorSites;
const V = schema.visitorSessions;
const P = schema.visitorPageviews;
const VV = schema.visitorViews;
const A = schema.visitorAlerts;

const read = { perm: "crm" as const };
const write = { perm: "crm" as const, write: true };
const admin = { perm: "crm" as const, admin: true };

// ---------- Collector rate limits (per address and per site, per minute) ----------

const hits = new Map<string, { start: number; n: number }>();
function allow(key: string, max: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > 60_000) {
    if (hits.size > 50_000) hits.clear();
    hits.set(key, { start: now, n: 1 });
    return true;
  }
  return ++h.n <= max;
}

const collectSchema = z.object({
  k: z.string().min(4).max(64),
  v: z.string().max(64).optional(),
  e: z.enum(["pageview", "leave", "test", "conflict"]),
  u: z.string().max(2_000),
  r: z.string().max(2_000).optional(),
  t: z.string().max(500).optional(),
  d: z.number().min(0).max(86_400).optional(),
});

// ---------- Filters ----------

const bandKeys = Object.keys(EMPLOYEE_BANDS) as [string, ...string[]];
const strList = (max: number, len = 120) => z.array(z.string().trim().min(1).max(len)).max(max).optional();
const filtersSchema = z
  .object({
    industries: strList(50),
    employees: z.array(z.enum(bandKeys)).max(bandKeys.length).optional(),
    revenue: z.array(z.enum(REVENUE_BANDS)).max(REVENUE_BANDS.length).optional(),
    countries: strList(60, 80),
    seniority: strList(20, 60),
    departments: strList(20, 60),
    url_contains: strList(20, 200),
    referrer_contains: strList(20, 200),
    icp_only: z.boolean().optional(),
  })
  .strict();
const destinationsSchema = z
  .object({
    slack_connection_id: z.string().nullable().optional(),
    webhook_url: z.string().trim().max(2_000).nullable().optional(),
    campaign_id: z.string().nullable().optional(),
    list_id: z.string().nullable().optional(),
    verify: z.boolean().optional(),
    check_duplicates: z.boolean().optional(),
  })
  .strict();
const icpSchema = z
  .object({ industries: strList(50), employees: z.array(z.enum(bandKeys)).optional(), revenue: z.array(z.enum(REVENUE_BANDS)).optional(), countries: strList(60, 80) })
  .strict();

const any = (xs?: string[]) => !!xs && xs.length > 0;
const list = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const like = (t: string) => `%${escapeLike(t.toLowerCase())}%`;
const cd = (field: string) => sql.raw(`json_extract(s.company_data, '$.${field}')`);

/** Session-level SQL for a view's filters (alias `s` = visitor_sessions). */
function filterConditions(ws: string, f: VisitorViewFilters): SQL[] {
  const out: SQL[] = [];
  if (any(f.industries)) out.push(sql`${cd("industry")} in (${list(f.industries!)})`);
  if (any(f.revenue)) out.push(sql`${cd("revenue_range")} in (${list(f.revenue!)})`);
  if (any(f.countries)) out.push(sql`lower(${cd("country")}) in (${list(f.countries!.map((c) => c.toLowerCase()))})`);
  if (any(f.employees)) {
    const parts = f.employees!.map((b) => EMPLOYEE_BANDS[b]).filter((r): r is [number, number] => !!r).map(([lo, hi]) => sql`(${cd("employee_count")} between ${lo} and ${hi})`);
    if (parts.length) out.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (f.icp_only) out.push(sql`s.matches_icp = 1`);
  if (any(f.url_contains)) {
    out.push(sql`exists (select 1 from visitor_pageviews pv where pv.session_id = s.id and (${sql.join(f.url_contains!.map((t) => sql`lower(pv.url) like ${like(t)} escape '\\'`), sql` or `)}))`);
  }
  if (any(f.referrer_contains)) {
    out.push(
      sql`(${sql.join(
        f.referrer_contains!.map((t) => sql`(lower(coalesce(s.referrer, '')) like ${like(t)} escape '\\' or lower(coalesce(json_extract(s.utm, '$.utm_source'), '')) like ${like(t)} escape '\\')`),
        sql` or `,
      )})`,
    );
  }
  if (any(f.seniority) || any(f.departments)) {
    const pc: SQL[] = [sql`p.company_id = s.company_id`, sql`(p.workspace_id is null or p.workspace_id = ${ws})`];
    if (any(f.seniority)) pc.push(sql`p.seniority in (${list(f.seniority!)})`);
    if (any(f.departments)) pc.push(sql`p.department in (${list(f.departments!)})`);
    out.push(sql`exists (select 1 from lf_people p where ${sql.join(pc, sql` and `)})`);
  }
  return out;
}

const listQuery = z.object({
  site_id: z.string().optional(),
  view_id: z.string().optional(),
  days: zInt(1, 365).optional(),
  search: z.string().trim().max(200).optional(),
  fit: zBool,
  include_hidden: zBool,
  page: zInt(1).optional(),
  page_size: zInt(1, 100).optional(),
  sort: z.enum(["last_seen", "visits", "pageviews", "duration"]).optional(),
});
type ListQuery = z.infer<typeof listQuery>;

async function loadView(ws: string, id: string | undefined) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(VV)
    .where(and(eq(VV.id, id), eq(VV.workspaceId, ws)))
    .limit(1);
  return assertFound(row, "View");
}

/** Where "the last N days" starts: midnight N - 1 days ago on the workspace's clock, like the days on the chart. */
async function since(ws: string, days: number | undefined) {
  return startOfLastDaysOn(await workspaceZone(ws), days ?? 30);
}

async function companyConditions(ws: string, q: ListQuery) {
  const view = await loadView(ws, q.view_id);
  const conds: SQL[] = [sql`s.workspace_id = ${ws}`, sql`s.identified = 1`, sql`s.company_domain is not null`, sql`s.last_seen_at >= ${await since(ws, q.days)}`];
  if (!q.include_hidden) conds.push(sql`s.hidden = 0`);
  const site = q.site_id ?? view?.siteId ?? null;
  if (site) conds.push(sql`s.site_id = ${site}`);
  if (q.search) conds.push(sql`(lower(s.company_name) like ${like(q.search)} escape '\\' or s.company_domain like ${like(q.search)} escape '\\')`);
  if (q.fit) conds.push(sql`s.matches_icp = 1`);
  if (view) conds.push(...filterConditions(ws, view.filters));
  return { conds, view };
}

interface Agg {
  domain: string;
  visits: number;
  pageviews: number;
  duration_sec: number;
  first_seen_at: number;
  last_seen_at: number;
  fits: number;
  lead_id: string | null;
}

const ORDER = {
  last_seen: sql.raw("last_seen_at desc"),
  visits: sql.raw("visits desc, last_seen_at desc"),
  pageviews: sql.raw("pageviews desc, last_seen_at desc"),
  duration: sql.raw("duration_sec desc, last_seen_at desc"),
};

/** The latest identified visit of each company, however many visits each one has. */
async function latestVisits(ws: string, domains: string[]): Promise<Map<string, VisitRow>> {
  const latest = new Map<string, VisitRow>();
  for (const part of chunk(domains, 500)) {
    const ids = await db.all<{ id: string }>(
      sql`select id from (select s.id as id, row_number() over (partition by s.company_domain order by s.last_seen_at desc) as rn from visitor_sessions s
          where s.workspace_id = ${ws} and s.identified = 1 and s.company_domain in (${list(part)})) where rn = 1`,
    );
    if (!ids.length) continue;
    const rows = await db
      .select()
      .from(V)
      .where(
        inArray(
          V.id,
          ids.map((r) => r.id),
        ),
      );
    for (const v of rows) if (v.companyDomain) latest.set(v.companyDomain, v);
  }
  return latest;
}

/** Latest identified visit per domain, and the five most viewed pages per domain since `from`. */
async function companyDetails(ws: string, domains: string[], from: number) {
  const latest = await latestVisits(ws, domains);
  const pages = new Map<string, Array<{ path: string; views: number }>>();
  for (const part of chunk(domains, 500)) {
    const rows = await db.all<{ domain: string; path: string; views: number }>(
      sql`select domain, path, views from (select domain, path, views, row_number() over (partition by domain order by views desc, path) as rn from (
            select s.company_domain as domain, pv.path as path, count(*) as views from visitor_pageviews pv join visitor_sessions s on s.id = pv.session_id
            where s.workspace_id = ${ws} and s.company_domain in (${list(part)}) and pv.created_at >= ${from} group by 1, 2)) where rn <= 5 order by domain, rn`,
    );
    for (const r of rows) {
      const arr = pages.get(r.domain) ?? [];
      arr.push({ path: r.path, views: Number(r.views) });
      pages.set(r.domain, arr);
    }
  }
  return { latest, pages };
}

function companyOf(v: VisitRow): VisitorCompany {
  return v.companyData as unknown as VisitorCompany;
}

function visitSource(v: Pick<VisitRow, "referrer" | "utm">) {
  if (v.utm?.utm_source) return v.utm.utm_source;
  if (!v.referrer) return null;
  try {
    return new URL(v.referrer).hostname.replace(/^www\./, "");
  } catch {
    return v.referrer;
  }
}

/** Every company a list query finds (for "select all"), with the view it applied. */
async function companyDomains(ws: string, q: ListQuery) {
  const { conds, view } = await companyConditions(ws, q);
  const rows = await db.all<{ domain: string }>(sql`select distinct s.company_domain as domain from visitor_sessions s where ${sql.join(conds, sql` and `)}`);
  return { domains: rows.map((r) => r.domain), view };
}

/** A page of companies, or with `all` every one (the export). */
async function listCompanies(ws: string, q: ListQuery, opts: { all?: boolean } = {}) {
  const { conds, view } = await companyConditions(ws, q);
  const where = sql.join(conds, sql` and `);
  const size = q.page_size ?? 25;
  const page = opts.all ? sql`` : sql` limit ${size} offset ${((q.page ?? 1) - 1) * size}`;
  const [{ n }] = (await db.all<{ n: number }>(sql`select count(distinct s.company_domain) as n from visitor_sessions s where ${where}`)) as [{ n: number }];
  const aggs = await db.all<Agg>(
    sql`select s.company_domain as domain, count(*) as visits, sum(s.pageviews) as pageviews, sum(s.duration_sec) as duration_sec,
        min(s.first_seen_at) as first_seen_at, max(s.last_seen_at) as last_seen_at, max(coalesce(s.matches_icp, 0)) as fits, max(s.lead_id) as lead_id
        from visitor_sessions s where ${where} group by s.company_domain order by ${ORDER[q.sort ?? "last_seen"]}${page}`,
  );
  const { latest, pages } = await companyDetails(
    ws,
    aggs.map((a) => a.domain),
    await since(ws, q.days),
  );
  const unlimited = (await workspaceLimits(ws)).self_hosted;
  const items = [];
  for (const a of aggs) {
    const v = latest.get(a.domain);
    if (!v) continue;
    const c = companyOf(v);
    const contact = v.companyId ? ((await bestContacts(ws, v.companyId, { seniority: view?.filters.seniority, departments: view?.filters.departments }))[0] ?? null) : null;
    items.push({
      domain: a.domain,
      name: c.name,
      logo_url: c.logo_url,
      industry: c.industry,
      employee_count: c.employee_count,
      revenue_range: c.revenue_range,
      company_location: [c.city, c.country].filter(Boolean).join(", ") || null,
      linkedin_url: c.linkedin_url,
      in_dataset: !!v.companyId,
      fits_icp: !!a.fits,
      visits: Number(a.visits),
      pageviews: Number(a.pageviews ?? 0),
      duration_sec: Number(a.duration_sec ?? 0),
      first_seen_at: iso(Number(a.first_seen_at)),
      last_seen_at: iso(Number(a.last_seen_at)),
      top_pages: pages.get(a.domain) ?? [],
      source: visitSource(v),
      visitor_location: [v.city, v.region, v.country].filter(Boolean).join(", ") || null,
      lead_id: a.lead_id,
      best_contact: contact ? contactView(contact, unlimited) : null,
    });
  }
  return { total: Number(n), items, view };
}

// ---------- Serializers ----------

function serializeView(v: typeof VV.$inferSelect) {
  return {
    id: v.id,
    name: v.name,
    site_id: v.siteId,
    filters: v.filters,
    destinations: v.destinations,
    enabled: v.enabled,
    matches: v.matches,
    last_match_at: iso(v.lastMatchAt),
    created_at: iso(v.createdAt),
    updated_at: iso(v.updatedAt),
  };
}

async function validateDestinations(ws: string, d: VisitorViewDestinations): Promise<VisitorViewDestinations> {
  const out: VisitorViewDestinations = {
    slack_connection_id: d.slack_connection_id || null,
    webhook_url: d.webhook_url?.trim() || null,
    campaign_id: d.campaign_id || null,
    list_id: d.list_id || null,
    verify: !!d.verify,
    check_duplicates: !!d.check_duplicates,
  };
  if (out.campaign_id && out.list_id) throw badRequest("Choose a campaign or a list, not both");
  if (!out.slack_connection_id && !out.webhook_url && !out.campaign_id && !out.list_id) {
    throw badRequest("Choose at least one destination: a Slack channel, a campaign or list, or a webhook URL.");
  }
  if (out.slack_connection_id && !(await getIntegration(ws, out.slack_connection_id, "slack"))) throw badRequest("That Slack connection no longer exists");
  if (out.webhook_url) {
    if (!/^https:\/\//i.test(out.webhook_url) && config.isProduction) throw badRequest("Webhook URLs must start with https://");
    await assertPublicHttpUrl(out.webhook_url);
  }
  if (out.campaign_id) {
    const [c] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.id, out.campaign_id), eq(schema.campaigns.workspaceId, ws)))
      .limit(1);
    if (!c) throw badRequest("Campaign not found");
  }
  if (out.list_id) {
    const [l] = await db
      .select({ id: schema.leadLists.id })
      .from(schema.leadLists)
      .where(and(eq(schema.leadLists.id, out.list_id), eq(schema.leadLists.workspaceId, ws)))
      .limit(1);
    if (!l) throw badRequest("Lead list not found");
  }
  return out;
}

function compactFilters(f: VisitorViewFilters): VisitorViewFilters {
  const out: VisitorViewFilters = {};
  for (const [k, v] of Object.entries(f) as Array<[keyof VisitorViewFilters, unknown]>) {
    if (Array.isArray(v) ? v.length : v) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function siteFor(ws: string, id: string) {
  const [row] = await db
    .select()
    .from(S)
    .where(and(eq(S.id, id), eq(S.workspaceId, ws)))
    .limit(1);
  return assertFound(row, "Domain");
}

async function termsState(ws: string) {
  const row = await visitorSettings(ws);
  let acceptedBy: string | null = null;
  if (row?.termsAcceptedBy) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, row.termsAcceptedBy)).limit(1);
    acceptedBy = u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email : null;
  }
  return { version: VISITOR_TERMS_VERSION, accepted: termsAccepted(row), accepted_at: iso(row?.termsAcceptedAt), accepted_by: acceptedBy };
}

export default async function websiteVisitorRoutes(app: FastifyInstance) {
  // ---------- Public: snippet and collector ----------

  app.get("/wv.js", { config: { auth: "public" } }, async (_req, reply) =>
    reply.header("content-type", "application/javascript; charset=utf-8").header("cache-control", "public, max-age=3600").send(VISITOR_SCRIPT),
  );

  app.post("/wv/collect", { config: { auth: "public" }, bodyLimit: 16_384 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const ip = clientIp(req);
    let raw: unknown = req.body;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return reply.code(204).send();
      }
    }
    const parsed = collectSchema.safeParse(raw);
    if (!parsed.success) return reply.code(204).send();
    const e = parsed.data;
    if (!allow(`ip:${ip}`, 120) || !allow(`site:${e.k}`, 6_000)) return reply.code(204).send();
    await collect(
      { key: e.k, visitor: e.v, event: e.e, url: e.u, referrer: e.r, title: e.t, duration: e.d },
      { ip, userAgent: String(req.headers["user-agent"] ?? ""), origin: typeof req.headers.origin === "string" ? req.headers.origin : null },
    ).catch((err) => req.log.error(err));
    return reply.code(204).send();
  });

  // ---------- Overview ----------

  app.get("/api/app/website-visitors/overview", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ site_id: z.string().optional(), days: zInt(1, 365).optional() }));
    const from = await since(c.wsId, q.days);
    const siteCond = q.site_id ? sql` and s.site_id = ${q.site_id}` : sql``;
    const [tot] = await db.all<{ visits: number; companies: number; fits: number; pageviews: number; duration_sec: number; unresolved: number }>(
      sql`select count(*) as visits, count(distinct case when s.identified = 1 then s.company_domain end) as companies,
          count(distinct case when s.identified = 1 and s.matches_icp = 1 then s.company_domain end) as fits,
          coalesce(sum(s.pageviews), 0) as pageviews, coalesce(sum(s.duration_sec), 0) as duration_sec,
          sum(case when s.resolve_status = 'unresolved' then 1 else 0 end) as unresolved
          from visitor_sessions s where s.workspace_id = ${c.wsId} and s.hidden = 0 and s.last_seen_at >= ${from}${siteCond}`,
    );
    const [waiting] = await db.all<{ pending: number; limited: number }>(
      sql`select sum(case when s.resolve_status = 'pending' then 1 else 0 end) as pending, sum(case when s.resolve_status = 'limit' then 1 else 0 end) as limited
          from visitor_sessions s where s.workspace_id = ${c.wsId}${siteCond}`,
    );
    // Days on the workspace's clock, like the rest of the app.
    const day = localDateSql(sql`s.first_seen_at`, await workspaceZone(c.wsId), from, Date.now());
    const daily = await db.all<{ day: string; visits: number; companies: number }>(
      sql`select ${day} as day, count(*) as visits, count(distinct case when s.identified = 1 then s.company_domain end) as companies
          from visitor_sessions s where s.workspace_id = ${c.wsId} and s.hidden = 0 and s.first_seen_at >= ${from}${siteCond} group by 1 order by 1`,
    );
    const pages = await db.all<{ path: string; views: number; visits: number }>(
      sql`select pv.path as path, count(*) as views, count(distinct pv.session_id) as visits from visitor_pageviews pv join visitor_sessions s on s.id = pv.session_id
          where s.workspace_id = ${c.wsId} and s.hidden = 0 and pv.created_at >= ${from}${siteCond} group by 1 order by views desc limit 8`,
    );
    const refs = await db.all<{ referrer: string | null; src: string | null; n: number }>(
      sql`select s.referrer as referrer, json_extract(s.utm, '$.utm_source') as src, count(*) as n from visitor_sessions s
          where s.workspace_id = ${c.wsId} and s.hidden = 0 and s.first_seen_at >= ${from}${siteCond} group by 1, 2`,
    );
    const sources = new Map<string, number>();
    for (const r of refs) {
      const key = visitSource({ referrer: r.referrer, utm: r.src ? { utm_source: r.src } : null }) ?? "Direct";
      sources.set(key, (sources.get(key) ?? 0) + Number(r.n));
    }
    const [sites, settings, source, limits] = await Promise.all([
      db.select().from(S).where(eq(S.workspaceId, c.wsId)).orderBy(S.createdAt),
      visitorSettings(c.wsId),
      lookupSource(c.wsId),
      workspaceLimits(c.wsId),
    ]);
    return {
      sites: sites.map(serializeSite),
      terms_accepted: termsAccepted(settings),
      lookup: source,
      totals: {
        companies: Number(tot?.companies ?? 0),
        visits: Number(tot?.visits ?? 0),
        fits: Number(tot?.fits ?? 0),
        pageviews: Number(tot?.pageviews ?? 0),
        duration_sec: Number(tot?.duration_sec ?? 0),
        unresolved: Number(tot?.unresolved ?? 0),
      },
      waiting: { pending: Number(waiting?.pending ?? 0), limited: Number(waiting?.limited ?? 0) },
      daily: daily.map((d) => ({ date: d.day, visits: Number(d.visits), companies: Number(d.companies) })),
      top_pages: pages.map((p) => ({ path: p.path, views: Number(p.views), visits: Number(p.visits) })),
      top_sources: [...sources.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, visits]) => ({ name, visits })),
      usage: {
        self_hosted: limits.self_hosted,
        identified_this_month: await identifiedThisMonth(c.wsId),
        monthly_limit: limits.identified_visitors,
      },
    };
  });

  // ---------- Companies ----------

  app.get("/api/app/website-visitors/companies", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, listQuery);
    const { total, items } = await listCompanies(c.wsId, q);
    return { total, page: q.page ?? 1, page_size: q.page_size ?? 25, items };
  });

  app.get("/api/app/website-visitors/companies/:domain", { config: read }, async (req) => {
    const c = ctx(req);
    const domain = (req.params as { domain: string }).domain.toLowerCase();
    const q = query(req, z.object({ site_id: z.string().optional() }));
    const visits = await db
      .select()
      .from(V)
      .where(and(eq(V.workspaceId, c.wsId), eq(V.companyDomain, domain), eq(V.identified, true), ...(q.site_id ? [eq(V.siteId, q.site_id)] : [])))
      .orderBy(desc(V.lastSeenAt))
      .limit(50);
    if (!visits.length) throw notFound("Company");
    const latest = visits[0]!;
    const company = companyOf(latest);
    const pages = await db
      .select()
      .from(P)
      .where(
        inArray(
          P.sessionId,
          visits.map((v) => v.id),
        ),
      )
      .orderBy(P.createdAt);
    const byVisit = new Map<string, typeof pages>();
    for (const p of pages) byVisit.set(p.sessionId, [...(byVisit.get(p.sessionId) ?? []), p]);
    const contacts = latest.companyId ? await bestContacts(c.wsId, latest.companyId, {}, 10) : [];
    const unlimited = (await workspaceLimits(c.wsId)).self_hosted;
    const [{ n }] = (await db.all<{ n: number }>(sql`select count(*) as n from leads where workspace_id = ${c.wsId} and company_domain = ${domain}`)) as [{ n: number }];
    return {
      company: { ...company, company_id: latest.companyId },
      fits_icp: visits.some((v) => v.matchesIcp),
      hidden: latest.hidden,
      visits: visits.map((v) => ({
        id: v.id,
        site_id: v.siteId,
        first_seen_at: iso(v.firstSeenAt),
        last_seen_at: iso(v.lastSeenAt),
        pageviews: v.pageviews,
        duration_sec: v.durationSec,
        referrer: v.referrer,
        source: visitSource(v),
        utm: v.utm ?? {},
        landing_url: v.landingUrl,
        visitor_location: [v.city, v.region, v.country].filter(Boolean).join(", ") || null,
        lead_id: v.leadId,
        pages: (byVisit.get(v.id) ?? []).map((p) => ({ url: p.url, path: p.path, title: p.title, duration_sec: p.durationSec, viewed_at: iso(p.createdAt) })),
      })),
      contacts: contacts.map((p) => contactView(p, unlimited)),
      leads_in_workspace: Number(n),
    };
  });

  app.post("/api/app/website-visitors/companies/hide", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ domains: z.array(z.string().max(253)).min(1).max(500), hidden: z.boolean().default(true) }));
    await db
      .update(V)
      .set({ hidden: b.hidden })
      .where(
        and(
          eq(V.workspaceId, c.wsId),
          inArray(
            V.companyDomain,
            b.domains.map((d) => d.toLowerCase()),
          ),
        ),
      );
    return { success: true };
  });

  app.post("/api/app/website-visitors/reveal", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ person_ids: z.array(z.string()).min(1).max(100) }));
    const people = await peopleByIds(c.wsId, b.person_ids);
    if (!people.length) throw notFound("People");
    const res = await unlockPeople(c.wsId, c.userId, people, "website_visitors:reveal");
    const allowed = new Set(res.allowed.map((p) => p.id));
    return {
      contacts: people.filter((p) => allowed.has(p.id)).map((p) => contactView({ ...p, unlocked: 1 })),
      credits_used: res.charged,
      out_of_credits: res.outOfCredits,
    };
  });

  /** Adds the best contact of each company (or chosen people) to a campaign or list. */
  app.post("/api/app/website-visitors/add-leads", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        domains: z.array(z.string().max(253)).max(500).optional(),
        person_ids: z.array(z.string()).max(100).optional(),
        all: listQuery.partial().optional(),
        campaign_id: z.string().optional(),
        list_id: z.string().optional(),
        per_company: z.number().int().min(1).max(5).default(1),
        verify: z.boolean().optional(),
        check_duplicates: z.boolean().optional(),
      }),
    );
    if (!b.campaign_id === !b.list_id) throw badRequest("Choose a campaign or a list");
    let domains = (b.domains ?? []).map((d) => d.toLowerCase());
    let filters: VisitorViewFilters | undefined;
    if (b.all) {
      const r = await companyDomains(c.wsId, b.all as ListQuery);
      domains = r.domains;
      filters = r.view?.filters;
    }
    if (!domains.length && !b.person_ids?.length) throw badRequest("Choose companies or people to add");
    const latest = await latestVisits(c.wsId, domains);
    const people: Parameters<typeof addVisitorLeads>[0]["people"] = [];
    let noContact = 0;
    const pagesOf = async (visitId: string) =>
      db.select({ url: P.url, title: P.title, durationSec: P.durationSec, createdAt: P.createdAt }).from(P).where(eq(P.sessionId, visitId)).orderBy(P.createdAt);
    for (const [, v] of latest) {
      const found = v.companyId ? await bestContacts(c.wsId, v.companyId, { seniority: filters?.seniority, departments: filters?.departments }, b.per_company) : [];
      if (!found.length) noContact++;
      const pages = found.length ? await pagesOf(v.id) : [];
      for (const person of found) people.push({ person, company: companyOf(v), visit: v, pages });
    }
    if (b.person_ids?.length) {
      const known = [...latest.values()];
      for (const person of await peopleByIds(c.wsId, b.person_ids)) {
        const v = (person.company_id ? known.find((x) => x.companyId === person.company_id) : undefined) ?? (await visitForCompany(c.wsId, person.company_id));
        if (v) people.push({ person, company: companyOf(v), visit: v, pages: await pagesOf(v.id) });
      }
    }
    const r = await addVisitorLeads({
      workspaceId: c.wsId,
      userId: c.userId,
      people,
      campaignId: b.campaign_id,
      listId: b.list_id,
      verify: b.verify,
      checkDuplicates: b.check_duplicates,
      reason: "website_visitors:add",
    });
    return {
      companies: latest.size,
      without_contact: noContact,
      without_email: r.no_email,
      revealed: r.revealed,
      credits_used: r.credits_used,
      out_of_credits: r.out_of_credits,
      leads_uploaded: r.result?.leads_uploaded ?? 0,
      duplicated_leads: (r.result?.duplicated_leads ?? 0) + (r.result?.skipped_count ?? 0),
      in_blocklist: r.result?.in_blocklist ?? 0,
    };
  });

  async function visitForCompany(ws: string, companyId: string | null) {
    if (!companyId) return null;
    const [v] = await db
      .select()
      .from(V)
      .where(and(eq(V.workspaceId, ws), eq(V.companyId, companyId), eq(V.identified, true)))
      .orderBy(desc(V.lastSeenAt))
      .limit(1);
    return v ?? null;
  }

  app.get("/api/app/website-visitors/export", { config: read }, async (req, reply) => {
    const c = ctx(req);
    const q = query(req, listQuery);
    const { items } = await listCompanies(c.wsId, q, { all: true });
    const fields = [
      "Company",
      "Domain",
      "Industry",
      "Employees",
      "Revenue",
      "Company location",
      "Fits ideal customer profile",
      "Visits",
      "Pages viewed",
      "Time on site (seconds)",
      "First seen",
      "Last seen",
      "Top pages",
      "Source",
      "Best contact",
      "Best contact title",
      "Best contact LinkedIn",
      "Best contact email",
    ];
    const data = items.map((i) => [
      i.name,
      i.domain,
      i.industry ?? "",
      i.employee_count ?? "",
      i.revenue_range ?? "",
      i.company_location ?? "",
      i.fits_icp ? "yes" : "no",
      i.visits,
      i.pageviews,
      i.duration_sec,
      i.first_seen_at ?? "",
      i.last_seen_at ?? "",
      i.top_pages.map((p) => p.path).join(" | "),
      i.source ?? "",
      i.best_contact?.full_name ?? "",
      i.best_contact?.title ?? "",
      i.best_contact?.linkedin_url ?? "",
      i.best_contact?.email ?? "",
    ]);
    const name = `website-visitors-${await workspaceToday(c.wsId)}.csv`;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(toCsv({ fields, data }));
  });

  app.post("/api/app/website-visitors/identify", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ limit: z.number().int().min(1).max(500).default(100) }));
    if (!(await lookupSource(c.wsId))) throw badRequest("Set up an IP lookup token first (Website visitors → Setup).");
    return identifyWaiting(c.wsId, b.limit);
  });

  // ---------- Sites ----------

  app.get("/api/app/website-visitors/sites", { config: read }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(S).where(eq(S.workspaceId, c.wsId)).orderBy(S.createdAt);
    const settings = await visitorSettings(c.wsId);
    return {
      items: rows.map(serializeSite),
      terms: await termsState(c.wsId),
      lookup: { source: await lookupSource(c.wsId), workspace_token_set: !!settings?.ipinfoTokenEnc, server_token_set: !!config.ipinfoToken },
      script_url: `${config.trackingBaseUrl}/wv.js`,
    };
  });

  app.post("/api/app/website-visitors/sites", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ domain: z.string().trim().min(3).max(253) }));
    if (!termsAccepted(await visitorSettings(c.wsId))) throw new HttpError(403, "An admin needs to accept the website visitor terms first", "terms_required");
    return serializeSite(await createSite(c.wsId, b.domain));
  });

  app.patch("/api/app/website-visitors/sites/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const site = await siteFor(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ icp: icpSchema.optional(), exclude_paths: z.array(z.string().trim().min(1).max(200)).max(50).optional() }).strict());
    const settings = { ...(site.settings ?? {}) };
    if (b.icp) settings.icp = b.icp;
    if (b.exclude_paths) settings.exclude_paths = b.exclude_paths.map((p) => (p.startsWith("/") ? p : `/${p}`));
    const [row] = await db.update(S).set({ settings }).where(eq(S.id, site.id)).returning();
    forgetSite(site.pixelKey);
    if (b.icp) {
      // Re-score this site's identified visits against the new profile.
      const visits = await db
        .select({ id: V.id, companyData: V.companyData })
        .from(V)
        .where(and(eq(V.siteId, site.id), eq(V.identified, true)));
      const scored = new Map<boolean | null, string[]>();
      for (const v of visits) {
        const fits = fitsIcp(b.icp, v.companyData as unknown as VisitorCompany);
        const ids = scored.get(fits) ?? [];
        ids.push(v.id);
        scored.set(fits, ids);
      }
      for (const [fits, ids] of scored) for (const part of chunk(ids, 500)) await db.update(V).set({ matchesIcp: fits }).where(inArray(V.id, part));
    }
    return serializeSite(row!);
  });

  app.delete("/api/app/website-visitors/sites/:id", { config: write }, async (req) => {
    const c = ctx(req);
    await deleteSite(await siteFor(c.wsId, (req.params as { id: string }).id));
    return { success: true };
  });

  app.post("/api/app/website-visitors/sites/:id/test", { config: write }, async (req) => {
    const c = ctx(req);
    const site = await siteFor(c.wsId, (req.params as { id: string }).id);
    const result = await testSite(site);
    return { ...result, site: serializeSite(await siteFor(c.wsId, site.id)) };
  });

  // ---------- Terms and lookup token ----------

  app.get("/api/app/website-visitors/terms", { config: read }, async (req) => termsState(ctx(req).wsId));

  app.post("/api/app/website-visitors/terms/accept", { config: { perm: "crm" } }, async (req) => {
    const c = ctx(req);
    if (c.auth.role !== "owner" && c.auth.role !== "admin") throw forbidden("Only a workspace owner or admin can accept the website visitor terms");
    await acceptTerms(c.wsId, c.userId);
    return termsState(c.wsId);
  });

  app.put("/api/app/website-visitors/lookup", { config: admin }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ token: z.string().trim().max(200).nullable() }));
    if (b.token) {
      try {
        await checkLookupToken(b.token);
      } catch (err) {
        throw badRequest(err instanceof LookupError ? err.message : "The token could not be checked");
      }
    }
    await saveLookupToken(c.wsId, b.token || null);
    const settings = await visitorSettings(c.wsId);
    return { source: await lookupSource(c.wsId), workspace_token_set: !!settings?.ipinfoTokenEnc, server_token_set: !!config.ipinfoToken };
  });

  // ---------- Views (tracking filters) ----------

  app.get("/api/app/website-visitors/views", { config: read }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(VV).where(eq(VV.workspaceId, c.wsId)).orderBy(VV.createdAt);
    return { items: rows.map(serializeView) };
  });

  const viewBody = z.object({
    name: z.string().trim().min(1).max(100),
    site_id: z.string().nullable().optional(),
    filters: filtersSchema.default({}),
    destinations: destinationsSchema,
    enabled: z.boolean().optional(),
  });

  app.post("/api/app/website-visitors/views", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, viewBody);
    if (b.site_id) await siteFor(c.wsId, b.site_id);
    const [row] = await db
      .insert(VV)
      .values({
        workspaceId: c.wsId,
        name: b.name,
        siteId: b.site_id ?? null,
        filters: compactFilters(b.filters),
        destinations: await validateDestinations(c.wsId, b.destinations),
        enabled: b.enabled ?? true,
        createdBy: c.userId,
      })
      .returning();
    return serializeView(row!);
  });

  app.patch("/api/app/website-visitors/views/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const view = assertFound(await loadView(c.wsId, (req.params as { id: string }).id), "View");
    const b = body(req, viewBody.partial());
    if (b.site_id) await siteFor(c.wsId, b.site_id);
    const [row] = await db
      .update(VV)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.site_id !== undefined ? { siteId: b.site_id } : {}),
        ...(b.filters !== undefined ? { filters: compactFilters(b.filters) } : {}),
        ...(b.destinations !== undefined ? { destinations: await validateDestinations(c.wsId, b.destinations) } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      })
      .where(eq(VV.id, view.id))
      .returning();
    return serializeView(row!);
  });

  app.delete("/api/app/website-visitors/views/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const view = assertFound(await loadView(c.wsId, (req.params as { id: string }).id), "View");
    await db.delete(A).where(eq(A.viewId, view.id));
    await db.delete(VV).where(eq(VV.id, view.id));
    return { success: true };
  });

  /** Sends a sample alert to the destinations being edited (Slack and webhook only). */
  app.post("/api/app/website-visitors/views/test", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().max(100).default("Test view"), destinations: destinationsSchema }));
    const d = b.destinations;
    if (!d.slack_connection_id && !d.webhook_url) throw badRequest("Add a Slack channel or a webhook URL to send a test");
    if (d.slack_connection_id && !(await getIntegration(c.wsId, d.slack_connection_id, "slack"))) throw badRequest("That Slack connection no longer exists");
    if (d.webhook_url) await assertPublicHttpUrl(d.webhook_url);
    if (!allow(`wv-test:${c.wsId}`, 10)) throw tooMany("Too many test alerts; try again in a minute");
    return { results: await testViewDestinations(c.wsId, { slack_connection_id: d.slack_connection_id, webhook_url: d.webhook_url }, b.name) };
  });

  app.get("/api/app/website-visitors/views/:id/alerts", { config: read }, async (req) => {
    const c = ctx(req);
    const view = assertFound(await loadView(c.wsId, (req.params as { id: string }).id), "View");
    const q = query(req, z.object({ limit: zInt(1, 100).optional() }));
    const rows = await db
      .select({ alert: A, companyName: V.companyName })
      .from(A)
      .leftJoin(V, eq(V.id, A.sessionId))
      .where(eq(A.viewId, view.id))
      .orderBy(desc(A.createdAt))
      .limit(q.limit ?? 30);
    const people = await peopleByIds(
      c.wsId,
      rows.map((r) => r.alert.personId).filter((x): x is string => !!x),
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    const unlimited = (await workspaceLimits(c.wsId)).self_hosted;
    return {
      items: rows.map(({ alert, companyName }) => {
        const p = alert.personId ? byId.get(alert.personId) : undefined;
        return {
          id: alert.id,
          company_domain: alert.companyDomain,
          company_name: companyName,
          contact: p ? contactView(p, unlimited) : null,
          lead_id: alert.leadId,
          results: alert.results ?? {},
          created_at: iso(alert.createdAt),
        };
      }),
    };
  });

  // ---------- Credits and plan ----------

  app.get("/api/app/website-visitors/billing", { config: read }, async (req) => {
    const c = ctx(req);
    const ws = c.workspace;
    const [limits, used, credits, source] = await Promise.all([workspaceLimits(ws.id), identifiedThisMonth(ws.id), creditBalance(ws.id, "credits"), lookupSource(ws.id)]);
    const planId = ws.planIds?.website_visitors ?? null;
    const plan = planById(planId);
    const L = schema.creditLedger;
    const ledger = await db
      .select()
      .from(L)
      .where(and(eq(L.workspaceId, ws.id), sql`${L.reason} like 'website_visitors:%'`))
      .orderBy(desc(L.createdAt))
      .limit(30);
    const [waiting] = await db.all<{ limited: number }>(sql`select count(*) as limited from visitor_sessions where workspace_id = ${ws.id} and resolve_status = 'limit'`);
    return {
      self_hosted: limits.self_hosted,
      on_trial: limits.on_trial,
      plan: plan ? { id: plan.id, name: plan.name, monthly_price: plan.monthly_price } : null,
      identified_this_month: used,
      monthly_limit: limits.identified_visitors,
      credits_available: limits.self_hosted ? null : credits,
      waiting_over_limit: Number(waiting?.limited ?? 0),
      lookup: source,
      ledger: ledger.map((l) => ({ id: l.id, delta: l.delta, reason: l.reason, created_at: iso(l.createdAt) })),
    };
  });
}
