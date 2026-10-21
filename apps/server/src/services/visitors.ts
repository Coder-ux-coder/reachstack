// Website visitors. The snippet's events become visits; a visit's IP address is looked up (ipinfo) to find the
// company behind it, and tracking filters ("views") alert Slack or a webhook and add the best contact at that
// company to a campaign or list. Identification is company-level only: people are never identified, the
// "best contact" is the most senior matching person in the lead finder data. IP addresses are kept only until
// the lookup has run (at most 30 days).
import { isIP } from "node:net";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { EMPLOYEE_BANDS } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { inUse } from "./live-workspaces";
import type { VisitorSiteSettings, VisitorViewDestinations, VisitorViewFilters } from "../db/schema/growth";
import { config } from "../env";
import { badRequest, conflict } from "../http/errors";
import { decrypt, encrypt } from "../lib/crypto";
import { randomToken } from "../lib/ids";
import { describeFetchError, isPrivateIp, readCapped, safeFetch } from "../lib/net";
import { iso } from "../lib/time";
import { chargeCredits, refundCredits, workspaceLimits } from "./billing-limits";
import { emit } from "./bus";
import { isHostname, normalizeDomain } from "./domains";
import { postToSlack } from "./integrations";
import { addLeads, type AddLeadsResult } from "./leads";
import { leadInput, unlockPeople } from "./lead-finder/imports";
import { peopleByIds, personLocation, SENIORITY_RANK, type PersonResult } from "./lead-finder/search";
import { isLikelyBot } from "./tracking";
import { startOfMonthOn, workspaceToday, workspaceZone } from "./workspace-clock";

export type SiteRow = typeof schema.visitorSites.$inferSelect;
export type VisitRow = typeof schema.visitorSessions.$inferSelect;
export type ViewRow = typeof schema.visitorViews.$inferSelect;

const S = schema.visitorSites;
const V = schema.visitorSessions;
const P = schema.visitorPageviews;
const VV = schema.visitorViews;
const A = schema.visitorAlerts;

/** Bumped when the visitor terms change; admins accept each version once. */
export const VISITOR_TERMS_VERSION = "2026-10";
/** A new visit starts after this much inactivity. */
const VISIT_GAP_MS = 30 * 60_000;
/** Addresses still waiting for a lookup are dropped after this long. */
const PENDING_TTL_MS = 30 * 86_400_000;
const MAX_PAGE_SECONDS = 30 * 60;

export interface VisitorCompany {
  name: string;
  domain: string;
  industry: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  country: string | null;
  city: string | null;
  logo_url: string | null;
  linkedin_url: string | null;
  description: string | null;
  /** ip_lookup: the lookup named the company; network_name: the network owner's name matched a company in the data. */
  source: "ip_lookup" | "network_name";
  network: string | null;
}

// ---------- Workspace settings: terms and the lookup token ----------

export async function visitorSettings(workspaceId: string) {
  const [row] = await db.select().from(schema.visitorSettings).where(eq(schema.visitorSettings.workspaceId, workspaceId)).limit(1);
  return row ?? null;
}

export const termsAccepted = (row: Awaited<ReturnType<typeof visitorSettings>>) => row?.termsVersion === VISITOR_TERMS_VERSION;

async function upsertSettings(workspaceId: string, set: Partial<typeof schema.visitorSettings.$inferInsert>) {
  await db
    .insert(schema.visitorSettings)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: schema.visitorSettings.workspaceId, set: { ...set, updatedAt: new Date() } });
}

export async function acceptTerms(workspaceId: string, userId: string | null) {
  await upsertSettings(workspaceId, { termsVersion: VISITOR_TERMS_VERSION, termsAcceptedAt: new Date(), termsAcceptedBy: userId });
}

export async function saveLookupToken(workspaceId: string, token: string | null) {
  await upsertSettings(workspaceId, { ipinfoTokenEnc: token ? encrypt(token) : null });
}

async function lookupToken(workspaceId: string): Promise<string | null> {
  return decrypt((await visitorSettings(workspaceId))?.ipinfoTokenEnc) || config.ipinfoToken || null;
}

/** Where the IP lookup token comes from: this workspace, the server's IPINFO_TOKEN, or nowhere. */
export async function lookupSource(workspaceId: string): Promise<"workspace" | "server" | null> {
  if ((await visitorSettings(workspaceId))?.ipinfoTokenEnc) return "workspace";
  return config.ipinfoToken ? "server" : null;
}

// ---------- IP lookup ----------

interface IpinfoAnswer {
  ip?: string;
  bogon?: boolean;
  city?: string;
  region?: string;
  country?: string;
  org?: string;
  company?: { name?: string; domain?: string; type?: string };
  asn?: { asn?: string; name?: string; domain?: string; type?: string };
  privacy?: { vpn?: boolean; proxy?: boolean; tor?: boolean; relay?: boolean; hosting?: boolean };
}

export class LookupError extends Error {}

const ipCache = new Map<string, { at: number; answer: IpinfoAnswer }>();

async function ipinfo(ip: string, token: string): Promise<IpinfoAnswer> {
  const hit = ipCache.get(ip);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.answer;
  let res: Response;
  try {
    res = await fetch(`${config.ipinfoBaseUrl}/${encodeURIComponent(ip)}/json`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
  } catch (err) {
    throw new LookupError(`The IP lookup service could not be reached (${describeFetchError(err)})`);
  }
  if (res.status === 401 || res.status === 403) throw new LookupError("The IP lookup token was rejected");
  if (res.status === 429) throw new LookupError("The IP lookup service's request limit was reached");
  if (!res.ok) throw new LookupError(`The IP lookup service answered HTTP ${res.status}`);
  const answer = (await res.json()) as IpinfoAnswer;
  if (ipCache.size >= 5_000) ipCache.delete(ipCache.keys().next().value!);
  ipCache.set(ip, { at: Date.now(), answer });
  return answer;
}

/** Checks a token by looking up a well-known public address. */
export async function checkLookupToken(token: string): Promise<void> {
  ipCache.delete("8.8.8.8");
  await ipinfo("8.8.8.8", token);
  ipCache.delete("8.8.8.8");
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Network owners that are almost never the visitor's employer. */
const NETWORK_WORDS = /\b(telecom\w*|communications?|cable|broadband|mobile|wireless|internet|isp|hosting|cloud|data ?cent(er|re)s?|networks?|online|fib(er|re)|vpn|proxy|tor|telekom|telefonica|vodafone|verizon|comcast|at&t|orange|t-mobile)\b/i;
const NAME_SUFFIX = /[,.]?\s+(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|sa|ag|bv|nv|pty|srl|oy|ab|as)\.?$/i;

async function companyByName(workspaceId: string, raw: string) {
  const plain = raw.replace(NAME_SUFFIX, "").trim().toLowerCase();
  const names = [...new Set([raw.trim().toLowerCase(), plain])].filter((n) => n.length >= 3);
  if (!names.length) return null;
  const C = schema.lfCompanies;
  const rows = await db
    .select()
    .from(C)
    .where(and(sql`lower(${C.name}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`, or(isNull(C.workspaceId), eq(C.workspaceId, workspaceId))))
    .limit(2);
  // Only an unambiguous match counts.
  return rows.length === 1 ? rows[0]! : null;
}

async function datasetCompany(workspaceId: string, domain: string) {
  const C = schema.lfCompanies;
  const rows = await db
    .select()
    .from(C)
    .where(and(eq(C.domain, domain), or(isNull(C.workspaceId), eq(C.workspaceId, workspaceId))))
    .limit(5);
  // A workspace's own import wins over the shared dataset.
  return rows.find((r) => r.workspaceId === workspaceId) ?? rows[0] ?? null;
}

type Resolution = { kind: "company"; name: string; domain: string; source: VisitorCompany["source"]; network: string | null } | { kind: "none"; note: string };

async function classify(workspaceId: string, a: IpinfoAnswer): Promise<Resolution> {
  if (a.bogon) return { kind: "none", note: "Private or reserved address" };
  const p = a.privacy;
  if (p?.hosting) return { kind: "none", note: "Cloud or hosting network (often automated traffic)" };
  if (p && (p.vpn || p.proxy || p.tor || p.relay)) return { kind: "none", note: "VPN, proxy or relay" };
  const network = a.org?.replace(/^AS\d+\s+/i, "").trim() || a.asn?.name || null;
  for (const c of [a.company, a.asn]) {
    if (c?.type === "business" && c.domain && c.name) {
      const domain = normalizeDomain(c.domain);
      if (isHostname(domain)) return { kind: "company", name: c.name, domain, source: "ip_lookup", network };
    }
  }
  const typed = a.company?.type ?? a.asn?.type;
  if (typed) {
    const label =
      ({ isp: "Home or mobile internet provider", education: "School or university network", hosting: "Cloud or hosting network" } as Record<string, string>)[typed] ??
      "Not a company network";
    return { kind: "none", note: network ? `${label} (${network})` : label };
  }
  // Lookup plans without company data only name the network owner; use it when it is a company in the data.
  if (network && !NETWORK_WORDS.test(network)) {
    const match = await companyByName(workspaceId, network);
    if (match?.domain) return { kind: "company", name: match.name, domain: match.domain, source: "network_name", network };
  }
  return { kind: "none", note: network ? `No company found for this network (${network})` : "No company found for this address" };
}

function inBands(n: number | null, bands: string[]) {
  return n != null && bands.some((b) => {
    const r = EMPLOYEE_BANDS[b];
    return !!r && n >= r[0] && n <= r[1];
  });
}

type CompanyCriteria = { industries?: string[]; employees?: string[]; revenue?: string[]; countries?: string[] };
const any = (xs?: string[]) => !!xs && xs.length > 0;

function companyFits(f: CompanyCriteria, c: VisitorCompany): boolean {
  if (any(f.industries) && !(c.industry && f.industries!.includes(c.industry))) return false;
  if (any(f.employees) && !inBands(c.employee_count, f.employees!)) return false;
  if (any(f.revenue) && !(c.revenue_range && f.revenue!.includes(c.revenue_range))) return false;
  if (any(f.countries) && !(c.country && f.countries!.some((x) => x.toLowerCase() === c.country!.toLowerCase()))) return false;
  return true;
}

/** null when the site has no ideal customer profile. */
export function fitsIcp(icp: VisitorSiteSettings["icp"], c: VisitorCompany): boolean | null {
  if (!icp || !(any(icp.industries) || any(icp.employees) || any(icp.revenue) || any(icp.countries))) return null;
  return companyFits(icp, c);
}

/** Whether another visit already identified this company this month (on the workspace clock). */
async function identifiedBefore(s: VisitRow, domain: string): Promise<boolean> {
  const monthStart = new Date(startOfMonthOn(await workspaceZone(s.workspaceId)));
  const [row] = await db
    .select({ id: V.id })
    .from(V)
    .where(and(eq(V.workspaceId, s.workspaceId), eq(V.companyDomain, domain), eq(V.resolveStatus, "identified"), gte(V.resolvedAt, monthStart), ne(V.id, s.id)))
    .limit(1);
  return !!row;
}

/** Distinct companies identified this calendar month on the workspace clock (what the plan's identified_visitors limit counts). */
export async function identifiedThisMonth(workspaceId: string): Promise<number> {
  const monthStart = new Date(startOfMonthOn(await workspaceZone(workspaceId)));
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${V.companyDomain})` })
    .from(V)
    .where(and(eq(V.workspaceId, workspaceId), eq(V.resolveStatus, "identified"), gte(V.resolvedAt, monthStart)));
  return Number(row?.n ?? 0);
}

async function siteById(id: string) {
  const [row] = await db.select().from(S).where(eq(S.id, id)).limit(1);
  return row ?? null;
}

/** How long a lookup that never finished (its process stopped) keeps others off the visit. */
const LOOKUP_CLAIM_MS = 5 * 60_000;

/**
 * Looks up the company behind a visit. Visits stay pending without a lookup token (and are retried once one is
 * set). Over the plan's monthly limit they wait until someone unlocks them (`allowLimited`), which costs one
 * credit per identified company; lookups that find no company, or a company already identified this month, are
 * refunded.
 */
export async function identifyVisit(visitId: string, opts: { allowLimited?: boolean } = {}): Promise<VisitRow | null> {
  const [s] = await db.select().from(V).where(eq(V.id, visitId)).limit(1);
  if (!s || s.identified || s.resolveStatus === "unresolved") return s ?? null;
  if (s.resolveStatus === "limit" && !opts.allowLimited) return s;
  // One lookup per visit at a time: two at once would ask the lookup service twice and could charge twice.
  const now = Date.now();
  const [claimed] = await db
    .update(V)
    .set({ lookupAt: new Date(now) })
    .where(and(eq(V.id, s.id), inArray(V.resolveStatus, ["pending", "limit"]), or(isNull(V.lookupAt), lt(V.lookupAt, new Date(now - LOOKUP_CLAIM_MS)))))
    .returning();
  if (!claimed) return (await db.select().from(V).where(eq(V.id, s.id)).limit(1))[0] ?? s;
  const done = async (patch: Partial<typeof V.$inferInsert>) => (await db.update(V).set({ ...patch, lookupAt: null }).where(eq(V.id, s.id)).returning())[0] ?? s;
  let overLimit = false;
  let paid = false;
  const refund = async () => {
    if (!paid) return;
    paid = false;
    await refundCredits(s.workspaceId, 1, "website_visitors:unlock_refund", { refId: s.id });
  };
  try {
    if (!s.ip || !isIP(s.ip)) return await done({ resolveStatus: "unresolved", resolveNote: "No address recorded", ip: null, resolvedAt: new Date() });
    if (isPrivateIp(s.ip)) return await done({ resolveStatus: "unresolved", resolveNote: "Private network address", ip: null, resolvedAt: new Date() });
    const token = await lookupToken(s.workspaceId);
    if (!token) return await done({ resolveStatus: "pending", resolveNote: "No IP lookup token is set up" });
    const limits = await workspaceLimits(s.workspaceId);
    if (limits.identified_visitors !== null && (await identifiedThisMonth(s.workspaceId)) >= limits.identified_visitors) {
      if (!opts.allowLimited || !(await chargeCredits(s.workspaceId, 1, "website_visitors:unlock", { refId: s.id }))) {
        return await done({ resolveStatus: "limit", resolveNote: "This month's identification limit was reached" });
      }
      overLimit = paid = true;
    }
    let answer: IpinfoAnswer;
    try {
      answer = await ipinfo(s.ip, token);
    } catch (err) {
      await refund();
      return await done({ resolveStatus: overLimit ? "limit" : "pending", resolveNote: (err as Error).message.slice(0, 200) });
    }
    const geo = { country: countryName(answer.country), region: answer.region || null, city: answer.city || null };
    const r = await classify(s.workspaceId, answer);
    if (r.kind === "none") {
      await refund();
      return await done({ ...geo, resolveStatus: "unresolved", resolveNote: r.note, ip: null, resolvedAt: new Date() });
    }
    const co = await datasetCompany(s.workspaceId, r.domain);
    const company: VisitorCompany = {
      name: co?.name ?? r.name,
      domain: r.domain,
      industry: co?.industry ?? null,
      employee_count: co?.employeeCount ?? null,
      revenue_range: co?.revenueRange ?? null,
      country: co?.country ?? null,
      city: co?.city ?? null,
      logo_url: co?.logoUrl ?? null,
      linkedin_url: co?.linkedinUrl ?? null,
      description: co?.description ?? null,
      source: r.source,
      network: r.network,
    };
    // The monthly limit counts companies: one already identified this month costs nothing more.
    if (paid && (await identifiedBefore(s, company.domain))) await refund();
    // A company you hid stays hidden when it visits again.
    const [hiddenBefore] = await db
      .select({ id: V.id })
      .from(V)
      .where(and(eq(V.workspaceId, s.workspaceId), eq(V.companyDomain, company.domain), eq(V.hidden, true)))
      .limit(1);
    const site = await siteById(s.siteId);
    const row = await done({
      ...geo,
      identified: true,
      resolveStatus: "identified",
      resolveNote: null,
      resolvedAt: new Date(),
      ip: null,
      companyName: company.name,
      companyDomain: company.domain,
      companyId: co?.id ?? null,
      companyData: company as unknown as Record<string, unknown>,
      matchesIcp: fitsIcp(site?.settings?.icp, company),
      hidden: s.hidden || !!hiddenBefore,
    });
    if (row.hidden) return row;
    emit("website_visit", s.workspaceId, {
      visit_id: s.id,
      site_id: s.siteId,
      company_name: company.name,
      company_domain: company.domain,
      matches_icp: row.matchesIcp,
      pageviews: row.pageviews,
    });
    await runViews(row).catch((err) => console.error("[visitors:views]", err));
    return row;
  } catch (err) {
    // Whatever went wrong, the credit goes back and the visit can be looked up again.
    await refund().catch(() => {});
    await db
      .update(V)
      .set({ lookupAt: null })
      .where(eq(V.id, s.id))
      .catch(() => {});
    throw err;
  }
}

// ---------- Collecting events ----------

export interface CollectInput {
  key: string;
  visitor?: string;
  event: "pageview" | "leave" | "test" | "conflict";
  url: string;
  referrer?: string;
  title?: string;
  duration?: number;
}

const siteCache = new Map<string, { at: number; site: SiteRow | null }>();
const lastSiteWrite = new Map<string, number>();

async function siteByKey(key: string): Promise<SiteRow | null> {
  const hit = siteCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.site;
  const [row] = await db.select().from(S).where(eq(S.pixelKey, key)).limit(1);
  if (siteCache.size > 2_000) siteCache.clear();
  siteCache.set(key, { at: Date.now(), site: row ?? null });
  return row ?? null;
}

export function forgetSite(key: string) {
  siteCache.delete(key);
}

export function hostAllowed(siteDomain: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === siteDomain || h.endsWith(`.${siteDomain}`);
}

function excludedPath(site: SiteRow, path: string): boolean {
  return (site.settings?.exclude_paths ?? []).some((raw) => {
    const p = raw.trim();
    if (!p) return false;
    if (p.endsWith("*")) return path.startsWith(p.slice(0, -1));
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    return path === base || path.startsWith(`${base}/`);
  });
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const HEADLESS = /(headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake)/i;

/** Events of one browser are handled one at a time, so a pageview and its leave event can't race. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

async function touchSite(site: SiteRow, at: Date, verified: boolean) {
  const last = lastSiteWrite.get(site.id) ?? 0;
  if (!verified && site.verifiedAt && at.getTime() - last < 60_000) return;
  lastSiteWrite.set(site.id, at.getTime());
  await db
    .update(S)
    .set({ lastEventAt: at, ...(site.verifiedAt ? {} : { verifiedAt: at }) })
    .where(eq(S.id, site.id));
  if (!site.verifiedAt) forgetSite(site.pixelKey);
}

/** Returns what happened to the event; callers answer 204 either way so the snippet learns nothing. */
export async function collect(input: CollectInput, meta: { ip: string; userAgent: string; origin: string | null }): Promise<"recorded" | "ignored"> {
  const site = await siteByKey(input.key);
  if (!site) return "ignored";
  let page: URL;
  try {
    page = new URL(input.url);
  } catch {
    return "ignored";
  }
  if ((page.protocol !== "https:" && page.protocol !== "http:") || !hostAllowed(site.domain, page.hostname)) return "ignored";
  if (meta.origin && meta.origin !== "null") {
    try {
      if (!hostAllowed(site.domain, new URL(meta.origin).hostname)) return "ignored";
    } catch {
      return "ignored";
    }
  }
  const now = new Date();
  if (input.event === "test") {
    await touchSite(site, now, true);
    return "recorded";
  }
  if (input.event === "conflict") {
    await db.update(S).set({ conflictAt: now }).where(eq(S.id, site.id));
    forgetSite(site.pixelKey);
    return "recorded";
  }
  if (!input.visitor || isLikelyBot(meta.userAgent) || HEADLESS.test(meta.userAgent) || excludedPath(site, page.pathname)) return "ignored";
  await touchSite(site, now, false);
  const visitor = input.visitor;
  return serial<"recorded" | "ignored">(`${site.id}:${visitor}`, async () => {
    const [last] = await db
      .select()
      .from(V)
      .where(and(eq(V.siteId, site.id), eq(V.visitorKey, visitor)))
      .orderBy(desc(V.lastSeenAt))
      .limit(1);
    const open = last && now.getTime() - last.lastSeenAt.getTime() < VISIT_GAP_MS ? last : null;
    const url = `${page.origin}${page.pathname}${page.search}`.slice(0, 1_000);

    if (input.event === "leave") {
      if (!open) return "ignored";
      const secs = Math.max(0, Math.min(MAX_PAGE_SECONDS, Math.round(Number(input.duration) || 0)));
      const [pv] = await db
        .select()
        .from(P)
        .where(and(eq(P.sessionId, open.id), eq(P.url, url)))
        .orderBy(desc(P.createdAt))
        .limit(1);
      if (!pv || secs <= pv.durationSec) return "ignored";
      await db.update(P).set({ durationSec: secs }).where(eq(P.id, pv.id));
      await db
        .update(V)
        .set({ durationSec: sql`${V.durationSec} + ${secs - pv.durationSec}`, lastSeenAt: now })
        .where(eq(V.id, open.id));
      return "recorded";
    }

    let visit = open;
    if (!visit) {
      let referrer: string | null = null;
      try {
        const r = input.referrer ? new URL(input.referrer) : null;
        if (r && (r.protocol === "https:" || r.protocol === "http:") && !hostAllowed(site.domain, r.hostname)) referrer = `${r.origin}${r.pathname}`.slice(0, 500);
      } catch {
        referrer = null;
      }
      const utm: Record<string, string> = {};
      for (const k of UTM_KEYS) {
        const v = page.searchParams.get(k);
        if (v) utm[k] = v.slice(0, 200);
      }
      const ip = isIP(meta.ip) ? meta.ip : null;
      [visit] = await db
        .insert(V)
        .values({
          workspaceId: site.workspaceId,
          siteId: site.id,
          visitorKey: visitor,
          ip,
          userAgent: meta.userAgent.slice(0, 400),
          referrer,
          utm: Object.keys(utm).length ? utm : null,
          landingUrl: url,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .returning();
    }
    await db.insert(P).values({ workspaceId: site.workspaceId, sessionId: visit!.id, url, path: page.pathname.slice(0, 500), title: input.title?.slice(0, 300) || null });
    const [updated] = await db
      .update(V)
      .set({ pageviews: sql`${V.pageviews} + 1`, lastSeenAt: now })
      .where(eq(V.id, visit!.id))
      .returning();
    if (!open) void identifyVisit(visit!.id).catch((err) => console.error("[visitors:identify]", err));
    else if (updated?.identified) void runViews(updated).catch((err) => console.error("[visitors:views]", err));
    return "recorded";
  });
}

// ---------- Best contacts ----------

/** The most senior people at a company in the lead finder data, optionally limited to seniorities/departments. */
export async function bestContacts(workspaceId: string, companyId: string, f: { seniority?: string[]; departments?: string[] } = {}, limit = 1): Promise<PersonResult[]> {
  const conds: SQL[] = [sql`p.company_id = ${companyId}`, sql`(p.workspace_id is null or p.workspace_id = ${workspaceId})`];
  if (any(f.seniority)) conds.push(sql`p.seniority in (${sql.join(f.seniority!.map((s) => sql`${s}`), sql`, `)})`);
  if (any(f.departments)) conds.push(sql`p.department in (${sql.join(f.departments!.map((s) => sql`${s}`), sql`, `)})`);
  const rows = await db.all<{ id: string }>(sql`select p.id from lf_people p where ${sql.join(conds, sql` and `)} order by ${SENIORITY_RANK}, (p.email is null), p.id limit ${limit}`);
  if (!rows.length) return [];
  const order = new Map(rows.map((r, i) => [r.id, i]));
  return (await peopleByIds(workspaceId, rows.map((r) => r.id))).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/**
 * What the app shows about a person: the address once the workspace has revealed it, or straight away on an
 * unlimited workspace, where revealing is free.
 */
export function contactView(p: PersonResult, unlimited = false) {
  const revealed = unlimited || !!p.unlocked;
  return {
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    full_name: p.full_name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
    title: p.title,
    seniority: p.seniority,
    department: p.department,
    linkedin_url: p.linkedin_url,
    location: personLocation(p) || null,
    has_email: !!p.email,
    email: revealed ? p.email : null,
    email_status: revealed ? p.email_status : null,
    revealed,
    in_workspace: !!p.owned,
  };
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

type PageRow = { url: string; title: string | null; durationSec: number; createdAt: Date };

function visitLead(p: PersonResult, company: VisitorCompany, visit: VisitRow, pages: PageRow[]) {
  return leadInput(p, true, {
    company_name: company.name,
    website_visit_at: iso(visit.firstSeenAt),
    visited_pages: [...new Set(pages.map((pg) => pathOf(pg.url)))].slice(0, 8).join(", "),
    visit_pageviews: visit.pageviews,
    visit_referrer: visit.referrer ? hostOf(visit.referrer) : null,
  });
}

/** Reveals people (credits on metered plans) and adds them as leads. */
export async function addVisitorLeads(o: {
  workspaceId: string;
  userId: string | null;
  people: Array<{ person: PersonResult; company: VisitorCompany; visit: VisitRow; pages: PageRow[] }>;
  campaignId?: string | null;
  listId?: string | null;
  verify?: boolean;
  checkDuplicates?: boolean;
  reason: string;
}): Promise<{ result: AddLeadsResult | null; revealed: number; credits_used: number; out_of_credits: boolean; no_email: number }> {
  const usable = o.campaignId ? o.people.filter((x) => !!x.person.email) : o.people;
  const no_email = o.people.length - usable.length;
  if (!usable.length) return { result: null, revealed: 0, credits_used: 0, out_of_credits: false, no_email };
  const unlocked = await unlockPeople(o.workspaceId, o.userId, usable.map((x) => x.person), o.reason);
  const allowed = new Set(unlocked.allowed.map((p) => p.id));
  const rows = usable.filter((x) => allowed.has(x.person.id));
  if (!rows.length) return { result: null, revealed: 0, credits_used: unlocked.charged, out_of_credits: unlocked.outOfCredits, no_email };
  const result = await addLeads({
    workspaceId: o.workspaceId,
    campaignId: o.campaignId ?? null,
    listId: o.listId ?? null,
    leads: rows.map((x) => visitLead({ ...x.person, unlocked: 1 }, x.company, x.visit, x.pages)),
    userId: o.userId,
    uploadMethod: "website-visitor",
    isWebsiteVisitor: true,
    skipIfInCampaign: !!o.campaignId && !!o.checkDuplicates,
    skipIfInList: !!o.listId && !!o.checkDuplicates,
    verifyOnImport: !!o.verify,
  });
  // The visit remembers the lead it produced.
  for (const c of result.created_leads) {
    const row = rows[c.index];
    if (row) await db.update(V).set({ leadId: c.id }).where(eq(V.id, row.visit.id));
  }
  return { result, revealed: rows.length, credits_used: unlocked.charged, out_of_credits: unlocked.outOfCredits, no_email };
}

// ---------- Tracking filters (views) ----------

function visitMatches(f: VisitorViewFilters, visit: VisitRow, pages: PageRow[]): boolean {
  if (any(f.url_contains)) {
    const terms = f.url_contains!.map((t) => t.toLowerCase());
    if (!pages.some((p) => terms.some((t) => p.url.toLowerCase().includes(t)))) return false;
  }
  if (any(f.referrer_contains)) {
    const terms = f.referrer_contains!.map((t) => t.toLowerCase());
    const hay = [visit.referrer ?? "", visit.utm?.utm_source ?? ""].join(" ").toLowerCase();
    if (!terms.some((t) => hay.includes(t))) return false;
  }
  return true;
}

export function viewMatchesCompany(f: VisitorViewFilters, company: VisitorCompany, fits: boolean | null) {
  if (f.icp_only && !fits) return false;
  return companyFits(f, company);
}

export function alertPayload(view: Pick<ViewRow, "id" | "name">, site: Pick<SiteRow, "id" | "domain"> | null, company: VisitorCompany, visit: VisitRow, pages: PageRow[], person: PersonResult | null, leadId: string | null) {
  const contact = person ? contactView(person) : null;
  return {
    event_type: "website_visitor.identified",
    timestamp: new Date().toISOString(),
    workspace_id: visit.workspaceId,
    view: { id: view.id, name: view.name },
    site: site ? { id: site.id, domain: site.domain } : null,
    company: {
      name: company.name,
      domain: company.domain,
      industry: company.industry,
      employee_count: company.employee_count,
      revenue_range: company.revenue_range,
      country: company.country,
      linkedin_url: company.linkedin_url,
      fits_icp: visit.matchesIcp,
    },
    visit: {
      id: visit.id,
      first_seen_at: iso(visit.firstSeenAt),
      last_seen_at: iso(visit.lastSeenAt),
      pageviews: visit.pageviews,
      duration_sec: visit.durationSec,
      referrer: visit.referrer,
      utm: visit.utm ?? {},
      visitor_location: { city: visit.city, region: visit.region, country: visit.country },
      pages: pages.slice(0, 50).map((p) => ({ url: p.url, title: p.title, duration_sec: p.durationSec, viewed_at: iso(p.createdAt) })),
    },
    best_contact: contact
      ? { first_name: contact.first_name, last_name: contact.last_name, title: contact.title, seniority: contact.seniority, department: contact.department, linkedin_url: contact.linkedin_url, email: contact.email }
      : null,
    lead_id: leadId,
  };
}

function slackText(view: Pick<ViewRow, "name">, company: VisitorCompany, visit: VisitRow, pages: PageRow[], person: PersonResult | null) {
  const paths = [...new Set(pages.map((p) => pathOf(p.url)))].slice(0, 5);
  const c = person ? contactView(person) : null;
  return [
    `*Someone at ${company.name}* (${company.domain}) is on your website`,
    `${visit.pageviews} ${visit.pageviews === 1 ? "page" : "pages"}: ${paths.join(", ")}${visit.referrer ? ` · came from ${hostOf(visit.referrer)}` : ""}`,
    c ? `Best contact: ${c.full_name ?? "Unknown"}${c.title ? `, ${c.title}` : ""}${c.email ? ` · ${c.email}` : ""}` : null,
    `${view.name} · ${config.webUrl}/app/website-visitors?company=${encodeURIComponent(company.domain)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendWebhook(url: string, payload: unknown): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `${config.brandName}-Website-Visitors/1.0` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, detail: res.ok ? null : `The webhook answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: describeFetchError(err) };
  }
}

async function visitPages(visitId: string): Promise<PageRow[]> {
  return db.select({ url: P.url, title: P.title, durationSec: P.durationSec, createdAt: P.createdAt }).from(P).where(eq(P.sessionId, visitId)).orderBy(P.createdAt);
}

/** Checks an identified visit against the workspace's enabled views and delivers each match once a day (on the workspace clock). */
export async function runViews(visit: VisitRow): Promise<void> {
  if (!visit.identified || !visit.companyDomain || visit.hidden) return;
  const views = (await db.select().from(VV).where(and(eq(VV.workspaceId, visit.workspaceId), eq(VV.enabled, true)))).filter((v) => !v.siteId || v.siteId === visit.siteId);
  if (!views.length) return;
  const company = visit.companyData as unknown as VisitorCompany;
  const pages = await visitPages(visit.id);
  const day = await workspaceToday(visit.workspaceId);
  for (const view of views) {
    const f = view.filters;
    if (!viewMatchesCompany(f, company, visit.matchesIcp) || !visitMatches(f, visit, pages)) continue;
    const [already] = await db
      .select({ id: A.id })
      .from(A)
      .where(and(eq(A.viewId, view.id), eq(A.companyDomain, company.domain), eq(A.day, day)))
      .limit(1);
    if (already) continue;
    const contact = visit.companyId ? ((await bestContacts(visit.workspaceId, visit.companyId, { seniority: f.seniority, departments: f.departments }))[0] ?? null) : null;
    if ((any(f.seniority) || any(f.departments)) && !contact) continue;
    await deliver(view, visit, company, pages, contact, day);
  }
}

async function deliver(view: ViewRow, visit: VisitRow, company: VisitorCompany, pages: PageRow[], contact: PersonResult | null, day: string) {
  const ws = visit.workspaceId;
  const [alert] = await db
    .insert(A)
    .values({ workspaceId: ws, viewId: view.id, sessionId: visit.id, companyDomain: company.domain, day, personId: contact?.id ?? null })
    .onConflictDoNothing()
    .returning();
  if (!alert) return;
  const d = view.destinations;
  const results: Record<string, { ok: boolean; detail: string | null }> = {};
  let person = contact;
  let leadId: string | null = null;
  const target = d.campaign_id ? "campaign" : d.list_id ? "list" : null;
  if (target) {
    if (!person) results[target] = { ok: false, detail: "No contact at this company in your lead data" };
    else {
      try {
        const r = await addVisitorLeads({
          workspaceId: ws,
          userId: view.createdBy,
          people: [{ person, company, visit, pages }],
          campaignId: d.campaign_id,
          listId: d.list_id,
          verify: d.verify,
          checkDuplicates: d.check_duplicates,
          reason: "website_visitors:view",
        });
        leadId = r.result?.created_leads[0]?.id ?? null;
        if (r.revealed) person = { ...person, unlocked: 1 };
        results[target] = leadId
          ? { ok: true, detail: null }
          : {
              ok: false,
              detail: r.no_email
                ? "The best contact has no email address"
                : r.out_of_credits
                  ? "Out of credits"
                  : r.result?.in_blocklist
                    ? "On your blocklist"
                    : r.result?.skipped_count || r.result?.duplicated_leads
                      ? "Already added"
                      : "Not added",
            };
      } catch (err) {
        results[target] = { ok: false, detail: (err as Error).message.slice(0, 200) };
      }
    }
  }
  // Self-hosted installs reveal for free, so alerts can carry the address.
  if (person && !person.unlocked && (d.slack_connection_id || d.webhook_url) && (await workspaceLimits(ws)).self_hosted) {
    const u = await unlockPeople(ws, null, [person], "website_visitors:view");
    if (u.allowed.length) person = { ...person, unlocked: 1 };
  }
  if (d.slack_connection_id) {
    const ok = await postToSlack(ws, d.slack_connection_id, slackText(view, company, visit, pages, person));
    results.slack = { ok, detail: ok ? null : "Slack did not accept the message (see Settings → Integrations & API → Apps)" };
  }
  if (d.webhook_url) {
    const site = await siteById(visit.siteId);
    results.webhook = await sendWebhook(d.webhook_url, alertPayload(view, site, company, visit, pages, person, leadId));
  }
  await db.update(A).set({ results, leadId, personId: person?.id ?? null }).where(eq(A.id, alert.id));
  await db
    .update(VV)
    .set({ matches: sql`${VV.matches} + 1`, lastMatchAt: new Date() })
    .where(eq(VV.id, view.id));
}

/** Sends a sample alert to a view's Slack channel and webhook (campaigns and lists are left alone). */
export async function testViewDestinations(workspaceId: string, d: VisitorViewDestinations, name: string) {
  const company: VisitorCompany = {
    name: "Example Company",
    domain: "example.com",
    industry: "Software & Internet",
    employee_count: 120,
    revenue_range: "$10 - 50M",
    country: "United States",
    city: "Austin",
    logo_url: null,
    linkedin_url: null,
    description: null,
    source: "ip_lookup",
    network: null,
  };
  const now = new Date();
  const visit = {
    id: "test",
    workspaceId,
    siteId: "test",
    pageviews: 3,
    durationSec: 95,
    referrer: "https://www.google.com/",
    utm: null,
    city: "Austin",
    region: "Texas",
    country: "United States",
    matchesIcp: true,
    firstSeenAt: now,
    lastSeenAt: now,
  } as unknown as VisitRow;
  const pages: PageRow[] = ["/", "/pricing", "/customers"].map((p) => ({ url: `https://your-site.example${p}`, title: null, durationSec: 30, createdAt: now }));
  const out: Record<string, { ok: boolean; detail: string | null }> = {};
  if (d.slack_connection_id) {
    const ok = await postToSlack(workspaceId, d.slack_connection_id, `(Test) ${slackText({ name }, company, visit, pages, null)}`);
    out.slack = { ok, detail: ok ? null : "Slack did not accept the message (see Settings → Integrations & API → Apps)" };
  }
  if (d.webhook_url) out.webhook = await sendWebhook(d.webhook_url, { ...alertPayload({ id: "test", name }, null, company, visit, pages, null, null), test: true });
  return out;
}

// ---------- Sites ----------

export function snippetFor(site: Pick<SiteRow, "pixelKey">) {
  return `<script async src="${config.trackingBaseUrl}/wv.js" data-key="${site.pixelKey}"></script>`;
}

export function serializeSite(site: SiteRow) {
  const conflict = !!site.conflictAt && Date.now() - site.conflictAt.getTime() < 7 * 86_400_000;
  return {
    id: site.id,
    domain: site.domain,
    pixel_key: site.pixelKey,
    snippet: snippetFor(site),
    settings: { icp: site.settings?.icp ?? {}, exclude_paths: site.settings?.exclude_paths ?? [] },
    test_status: site.verifiedAt ? ("successful" as const) : ("not_tested" as const),
    verified_at: iso(site.verifiedAt),
    last_event_at: iso(site.lastEventAt),
    conflict,
    created_at: iso(site.createdAt),
  };
}

export async function createSite(workspaceId: string, rawDomain: string) {
  const domain = normalizeDomain(rawDomain);
  if (!isHostname(domain)) throw badRequest("Enter your website's domain, like example.com");
  const [dupe] = await db
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.workspaceId, workspaceId), eq(S.domain, domain)))
    .limit(1);
  if (dupe) throw conflict(`${domain} is already set up`);
  const settings = await visitorSettings(workspaceId);
  const [row] = await db
    .insert(S)
    .values({ workspaceId, domain, pixelKey: `wv_${randomToken(15)}`, settings: {}, tosSignedAt: settings?.termsAcceptedAt ?? null })
    .returning();
  return row!;
}

/** Deletes a site with its visits; views limited to it go too. */
export async function deleteSite(site: SiteRow) {
  const visits = await db.select({ id: V.id }).from(V).where(eq(V.siteId, site.id));
  for (let i = 0; i < visits.length; i += 500) {
    const ids = visits.slice(i, i + 500).map((v) => v.id);
    await db.delete(P).where(inArray(P.sessionId, ids));
  }
  await db.delete(V).where(eq(V.siteId, site.id));
  const views = await db.select({ id: VV.id }).from(VV).where(eq(VV.siteId, site.id));
  if (views.length) {
    await db.delete(A).where(
      inArray(
        A.viewId,
        views.map((v) => v.id),
      ),
    );
    await db.delete(VV).where(eq(VV.siteId, site.id));
  }
  await db.delete(S).where(eq(S.id, site.id));
  forgetSite(site.pixelKey);
}

/**
 * "Test code installation": events received recently count as success; otherwise the homepage's HTML is checked
 * for the snippet. Tag-manager installs only show up once a browser loads the page.
 */
export async function testSite(site: SiteRow): Promise<{ status: "receiving" | "installed" | "not_found" | "unreachable"; detail: string }> {
  if (site.lastEventAt && Date.now() - site.lastEventAt.getTime() < 7 * 86_400_000) {
    return { status: "receiving", detail: "Visits from your site are coming in." };
  }
  try {
    const res = await safeFetch(`https://${site.domain}/`, {
      headers: { accept: "text/html", "user-agent": `Mozilla/5.0 (compatible; ${config.brandName}-SnippetCheck/1.0)` },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await readCapped(res, 2_000_000);
    if (!res.ok) return { status: "unreachable", detail: `Your homepage answered HTTP ${res.status}.` };
    if (html.includes(site.pixelKey)) {
      if (!site.verifiedAt) await db.update(S).set({ verifiedAt: new Date() }).where(eq(S.id, site.id));
      return { status: "installed", detail: "The snippet is on your homepage. Visits appear as people browse your site." };
    }
    return {
      status: "not_found",
      detail: "The snippet isn't in your homepage's HTML. If you added it with a tag manager, open your site with ?wv_test=1 at the end of the address: that visit completes the test.",
    };
  } catch (err) {
    return { status: "unreachable", detail: `Your homepage couldn't be loaded: ${describeFetchError(err)}.` };
  }
}

// ---------- Housekeeping ----------

/** Which workspace's waiting visits the next round of background lookups starts with. */
let lookupTurn = 0;

/** Retries lookups that waited for a token, and drops addresses nobody looked up within 30 days. */
export async function runVisitorLookups(): Promise<void> {
  await db
    .update(V)
    .set({ ip: null, resolveStatus: "unresolved", resolveNote: "Not identified within 30 days", resolvedAt: new Date() })
    .where(and(inArray(V.resolveStatus, ["pending", "limit"]), lt(V.firstSeenAt, new Date(Date.now() - PENDING_TTL_MS))));
  // Only workspaces that can look visits up, so visits waiting for a token elsewhere never hold theirs back.
  const waiting = await db
    .selectDistinct({ workspaceId: V.workspaceId })
    .from(V)
    .where(and(eq(V.resolveStatus, "pending"), await inUse(V.workspaceId)));
  const ready: string[] = [];
  for (const w of waiting) if (await lookupToken(w.workspaceId)) ready.push(w.workspaceId);
  if (!ready.length) return;
  // Up to 50 lookups a round, shared between the workspaces (the newest visits of each first), starting with a
  // different one each round.
  ready.sort();
  const start = lookupTurn++ % ready.length;
  const each = Math.max(5, Math.ceil(50 / ready.length));
  let done = 0;
  for (const ws of [...ready.slice(start), ...ready.slice(0, start)]) {
    const pending = await db
      .select({ id: V.id })
      .from(V)
      .where(and(eq(V.workspaceId, ws), eq(V.resolveStatus, "pending")))
      .orderBy(desc(V.lastSeenAt))
      .limit(each);
    for (const p of pending) {
      await identifyVisit(p.id);
      done++;
    }
    if (done >= 50) break;
  }
}

/** "Identify waiting visits": runs lookups now, including visits held back by the monthly limit (one credit each). */
export async function identifyWaiting(workspaceId: string, limit: number) {
  const rows = await db
    .select({ id: V.id })
    .from(V)
    .where(and(eq(V.workspaceId, workspaceId), inArray(V.resolveStatus, ["pending", "limit"])))
    .orderBy(desc(V.lastSeenAt))
    .limit(limit);
  const out = { identified: 0, unresolved: 0, waiting: 0 };
  for (const r of rows) {
    const v = await identifyVisit(r.id, { allowLimited: true });
    if (v?.resolveStatus === "identified") out.identified++;
    else if (v?.resolveStatus === "unresolved") out.unresolved++;
    else out.waiting++;
  }
  return out;
}
