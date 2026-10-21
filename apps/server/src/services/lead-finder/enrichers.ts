// Enrichment sources. Everything here works without paid data providers:
//  - the installation's own dataset (people/companies imported by the administrator),
//  - the company's public website (meta data, social links, technology fingerprints, contact details),
//  - Google News RSS for company news, public ATS job boards (Greenhouse, Lever, Ashby) for open roles,
//  - SMTP-verified email patterns (when VERIFY_SMTP_PROBE=true) and Hunter.io (when HUNTER_API_KEY is set),
//  - Claude for AI columns.
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { domainOf } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { config } from "../../env";
import { safeFetch } from "../../lib/net";
import { normLinkedin, suppressedValues } from "../privacy";
import { verifyAddress } from "../verification";

const UA = () => `Mozilla/5.0 (compatible; ${config.brandName}Bot/1.0; +${config.appUrl})`;

async function fetchText(url: string, opts: { accept?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ status: number; text: string; headers: Headers; finalUrl: string } | null> {
  try {
    const res = await safeFetch(url, { headers: { "user-agent": UA(), accept: opts.accept ?? "*/*" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000) });
    const text = (await res.text()).slice(0, opts.maxBytes ?? 3_000_000);
    return { status: res.status, text, headers: res.headers, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

// ---------- Website ----------

const TECH_SIGNATURES: Array<[string, RegExp]> = [
  ["Google Analytics", /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/i],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js/i],
  ["HubSpot", /js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics\.net/i],
  ["Marketo", /munchkin\.marketo\.net|marketo\.com\/js/i],
  ["Salesforce Pardot", /pi\.pardot\.com|go\.pardot\.com/i],
  ["Intercom", /widget\.intercom\.io|js\.intercomcdn\.com/i],
  ["Drift", /js\.driftt\.com|js\.drift\.com/i],
  ["Zendesk", /static\.zdassets\.com|zendesk\.com\/embeddable/i],
  ["Segment", /cdn\.segment\.com\/analytics\.js/i],
  ["Mixpanel", /cdn\.mxpnl\.com|mixpanel\.com\/libs/i],
  ["Amplitude", /cdn\.amplitude\.com|amplitude\.com\/libs/i],
  ["Hotjar", /static\.hotjar\.com/i],
  ["Microsoft Clarity", /clarity\.ms\/tag/i],
  ["Stripe", /js\.stripe\.com/i],
  ["Shopify", /cdn\.shopify\.com|myshopify\.com/i],
  ["WordPress", /wp-content\/|wp-includes\//i],
  ["Wix", /static\.wixstatic\.com|wix\.com\/_partials/i],
  ["Squarespace", /static1\.squarespace\.com|squarespace-cdn\.com/i],
  ["Webflow", /assets\.website-files\.com|webflow\.js|data-wf-site/i],
  ["Framer", /framerusercontent\.com|framer\.com\/m\//i],
  ["Next.js", /__NEXT_DATA__|\/_next\/static\//i],
  ["Nuxt", /__NUXT__|\/_nuxt\//i],
  ["Gatsby", /___gatsby/i],
  ["React", /data-reactroot|react-dom(\.production)?(\.min)?\.js/i],
  ["Vue.js", /data-v-[a-f0-9]{6,}|vue(\.runtime)?(\.global)?(\.prod)?\.js/i],
  ["Angular", /ng-version=|angular(\.min)?\.js/i],
  ["jQuery", /jquery[.-]\d|jquery(\.min)?\.js/i],
  ["Bootstrap", /bootstrap(\.min)?\.(css|js)/i],
  ["Facebook Pixel", /connect\.facebook\.net\/[^"']+\/fbevents\.js/i],
  ["LinkedIn Insight Tag", /snap\.licdn\.com\/li\.lms-analytics/i],
  ["X (Twitter) Pixel", /static\.ads-twitter\.com\/uwt\.js/i],
  ["TikTok Pixel", /analytics\.tiktok\.com/i],
  ["Calendly", /assets\.calendly\.com|calendly\.com\/assets/i],
  ["Typeform", /embed\.typeform\.com/i],
  ["Crisp", /client\.crisp\.chat/i],
  ["LiveChat", /cdn\.livechatinc\.com/i],
  ["Tawk.to", /embed\.tawk\.to/i],
  ["Optimizely", /cdn\.optimizely\.com/i],
  ["VWO", /dev\.visualwebsiteoptimizer\.com/i],
  ["Klaviyo", /static\.klaviyo\.com/i],
  ["Mailchimp", /chimpstatic\.com|list-manage\.com/i],
  ["Cookiebot", /consent\.cookiebot\.com/i],
  ["OneTrust", /cdn\.cookielaw\.org|optanon/i],
  ["Google reCAPTCHA", /google\.com\/recaptcha|recaptcha\/api\.js/i],
  ["Sentry", /browser\.sentry-cdn\.com|sentry\.io\/api/i],
  ["New Relic", /js-agent\.newrelic\.com|NREUM/i],
  ["Algolia", /algolianet\.com|algolia(search)?(\.min)?\.js/i],
  ["Google Fonts", /fonts\.googleapis\.com/i],
  ["Font Awesome", /font-?awesome/i],
  ["YouTube Embed", /youtube\.com\/embed\//i],
  ["Vimeo", /player\.vimeo\.com/i],
  ["Wistia", /fast\.wistia\.(com|net)/i],
  ["Gong", /gong\.io\/(js|embed)/i],
  ["6sense", /j\.6sc\.co/i],
  ["Clearbit", /tag\.clearbitscripts\.com/i],
  ["Zoominfo WebSights", /ws\.zoominfo\.com/i],
  ["Unbounce", /unbounce\.com/i],
  ["Instapage", /instapage\.com/i],
  ["Leadfeeder", /lftracker|leadfeeder/i],
];

const HEADER_TECH: Array<[string, (h: Headers) => boolean]> = [
  ["Cloudflare", (h) => !!h.get("cf-ray") || /cloudflare/i.test(h.get("server") ?? "")],
  ["Vercel", (h) => !!h.get("x-vercel-id")],
  ["Netlify", (h) => !!h.get("x-nf-request-id")],
  ["Amazon CloudFront", (h) => !!h.get("x-amz-cf-id")],
  ["Fastly", (h) => /fastly/i.test(h.get("x-served-by") ?? "") || !!h.get("x-fastly-request-id")],
  ["Nginx", (h) => /nginx/i.test(h.get("server") ?? "")],
  ["Apache", (h) => /apache/i.test(h.get("server") ?? "")],
  ["Microsoft IIS", (h) => /microsoft-iis/i.test(h.get("server") ?? "")],
  ["Google Cloud", (h) => /^gws|google frontend/i.test(h.get("server") ?? "") || !!h.get("x-cloud-trace-context")],
  ["Heroku", (h) => /heroku/i.test(h.get("via") ?? "")],
];

export interface WebsiteProfile {
  url: string;
  title: string | null;
  description: string | null;
  technologies: string[];
  socials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string; youtube?: string; github?: string };
  emails: string[];
  phones: string[];
  careers_url: string | null;
}

const meta = (html: string, name: string) =>
  html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, "i"))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1] ??
  null;

const decode = (s: string | null) => (s ? s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : null);

export async function websiteProfile(domainOrUrl: string): Promise<WebsiteProfile | null> {
  const url = /^https?:\/\//i.test(domainOrUrl) ? domainOrUrl : `https://${domainOrUrl.replace(/^www\./, "")}`;
  const res = await fetchText(url, { accept: "text/html,application/xhtml+xml" });
  if (!res || res.status >= 400) return null;
  const html = res.text;
  const technologies = [...new Set([...TECH_SIGNATURES.filter(([, re]) => re.test(html)).map(([n]) => n), ...HEADER_TECH.filter(([, test]) => test(res.headers)).map(([n]) => n)])];
  const hrefs = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]!);
  const social = (re: RegExp) => hrefs.find((h) => re.test(h));
  const domain = domainOf(`x@${new URL(res.finalUrl).hostname.replace(/^www\./, "")}`);
  const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]!).toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)))].slice(0, 10);
  const phones = [...new Set([...html.matchAll(/tel:([+\d][\d\s().-]{6,})/gi)].map((m) => m[1]!.trim()))].slice(0, 5);
  const careers = hrefs.find((h) => /careers|jobs|join-us|work-with-us/i.test(h) && !/linkedin|indeed|glassdoor/i.test(h));
  return {
    url: res.finalUrl,
    title: decode(html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ?? null),
    description: decode(meta(html, "description") ?? meta(html, "og:description")),
    technologies,
    socials: {
      linkedin: social(/linkedin\.com\/company\//i),
      twitter: social(/(twitter|x)\.com\/(?!share|intent)[A-Za-z0-9_]+/i),
      facebook: social(/facebook\.com\/(?!sharer)[A-Za-z0-9.]+/i),
      instagram: social(/instagram\.com\/[A-Za-z0-9_.]+/i),
      youtube: social(/youtube\.com\/(c\/|channel\/|@)/i),
      github: social(/github\.com\/[A-Za-z0-9-]+\/?$/i),
    },
    emails: emails.filter((e) => e.endsWith(domain) || emails.length < 3),
    phones,
    careers_url: careers ? new URL(careers, res.finalUrl).href : null,
  };
}

// ---------- News (Google News RSS) ----------

const NEWS_TYPES: Array<[string, RegExp]> = [
  ["receives_financing", /\b(raises|raised|funding|series [a-j]|seed round|investment led by|secures \$)/i],
  ["acquires", /\b(acquires|acquired|acquisition of|to acquire)\b/i],
  ["merges_with", /\bmerge[sd]? with\b/i],
  ["launches", /\b(launches|launched|unveils|introduces|debuts|releases)\b/i],
  ["partners_with", /\b(partners with|partnership|teams up with|collaborat)/i],
  ["hires", /\b(hires|appoints|names .* (ceo|cto|cfo|chief|vp|president)|joins as)\b/i],
  ["expands_offices_to", /\b(expands to|expansion into|opens (new )?(office|hq|headquarters))\b/i],
  ["receives_award", /\b(award|wins|named (a|one of)|recognized)\b/i],
  ["goes_public", /\b(ipo|goes public|files to go public)\b/i],
  ["decreases_headcount_by", /\b(layoffs?|lays off|job cuts|cuts \d+ jobs)\b/i],
  ["integrates_with", /\bintegrat(es|ion) with\b/i],
  ["files_suit_against", /\b(sues|lawsuit|files suit)\b/i],
];

export interface NewsItem {
  title: string;
  url: string;
  date: string | null;
  source: string | null;
  type: string | null;
}

export async function companyNews(companyName: string, max = 8): Promise<NewsItem[]> {
  const q = encodeURIComponent(`"${companyName}"`);
  const res = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { accept: "application/rss+xml,text/xml" });
  if (!res || res.status >= 400) return [];
  const items = [...res.text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max);
  const tag = (block: string, name: string) => decode(block.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1] ?? null);
  return items.map((m) => {
    const block = m[1]!;
    const title = tag(block, "title") ?? "";
    const pub = tag(block, "pubDate");
    const published = pub ? new Date(pub) : null;
    return {
      title,
      url: tag(block, "link") ?? "",
      date: published && !Number.isNaN(published.getTime()) ? published.toISOString().slice(0, 10) : null,
      source: tag(block, "source"),
      type: NEWS_TYPES.find(([, re]) => re.test(title))?.[0] ?? null,
    };
  });
}

// ---------- Job listings (public ATS boards) ----------

export interface JobPosting {
  title: string;
  url: string;
  location: string | null;
  board: string;
}

function slugCandidates(companyName: string | null, domain: string | null): string[] {
  const out = new Set<string>();
  if (domain) out.add(domain.split(".")[0]!.toLowerCase());
  if (companyName) {
    const base = companyName.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|company)\b\.?/g, "").trim();
    out.add(base.replace(/[^a-z0-9]+/g, ""));
    out.add(base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  }
  return [...out].filter((s) => s.length >= 2).slice(0, 3);
}

export async function jobListings(companyName: string | null, domain: string | null, max = 25): Promise<JobPosting[]> {
  for (const slug of slugCandidates(companyName, domain)) {
    const gh = await fetchText(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { accept: "application/json" });
    if (gh && gh.status === 200) {
      const data = JSON.parse(gh.text) as { jobs?: Array<{ title: string; absolute_url: string; location?: { name?: string } }> };
      if (data.jobs?.length) return data.jobs.slice(0, max).map((j) => ({ title: j.title, url: j.absolute_url, location: j.location?.name ?? null, board: "greenhouse" }));
    }
    const lever = await fetchText(`https://api.lever.co/v0/postings/${slug}?mode=json`, { accept: "application/json" });
    if (lever && lever.status === 200) {
      const data = JSON.parse(lever.text) as Array<{ text: string; hostedUrl: string; categories?: { location?: string } }>;
      if (Array.isArray(data) && data.length) return data.slice(0, max).map((j) => ({ title: j.text, url: j.hostedUrl, location: j.categories?.location ?? null, board: "lever" }));
    }
    const ashby = await fetchText(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { accept: "application/json" });
    if (ashby && ashby.status === 200) {
      const data = JSON.parse(ashby.text) as { jobs?: Array<{ title: string; jobUrl: string; location?: string }> };
      if (data.jobs?.length) return data.jobs.slice(0, max).map((j) => ({ title: j.title, url: j.jobUrl, location: j.location ?? null, board: "ashby" }));
    }
  }
  return [];
}

// ---------- Work email ----------

export interface EmailFinding {
  email: string | null;
  status: "verified" | "catch_all" | "risky" | "not_found";
  source: "dataset" | "hunter" | "pattern" | "none";
  note?: string;
}

function patterns(first: string, last: string, domain: string): string[] {
  const f = first.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
  const l = last.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
  if (!f) return [];
  const list = l ? [`${f}.${l}`, `${f}`, `${f}${l}`, `${f[0]}${l}`, `${f}${l[0]}`, `${f[0]}.${l}`, `${l}.${f}`, `${f}_${l}`, `${l}`] : [f];
  return [...new Set(list)].map((p) => `${p}@${domain}`);
}

export async function hunterFind(first: string, last: string, domain: string): Promise<EmailFinding | null> {
  const key = config.hunterApiKey;
  if (!key) return null;
  const u = new URL("https://api.hunter.io/v2/email-finder");
  u.searchParams.set("domain", domain);
  u.searchParams.set("first_name", first);
  u.searchParams.set("last_name", last);
  try {
    // The key goes in a header so it never lands in URL logs.
    const res = await fetch(u, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { email?: string | null; score?: number; verification?: { status?: string } } };
    const email = data.data?.email;
    if (!email) return null;
    const vs = data.data?.verification?.status;
    return { email: email.toLowerCase(), status: vs === "valid" ? "verified" : vs === "accept_all" ? "catch_all" : "risky", source: "hunter" };
  } catch {
    return null;
  }
}

/** Finds a work email: dataset first, then Hunter (if configured), then SMTP-verified patterns (if enabled). */
export async function findWorkEmail(
  person: { first_name: string | null; last_name: string | null; domain: string | null; linkedin_url?: string | null },
  flow: string[] = ["instantly"],
  workspaceId: string | null = null,
): Promise<EmailFinding> {
  const first = (person.first_name ?? "").trim();
  const last = (person.last_name ?? "").trim();
  const domain = (person.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!domain || !first) return { email: null, status: "not_found", source: "none", note: "A first name and company domain are needed" };
  const P = schema.lfPeople;
  const C = schema.lfCompanies;
  const [hit] = await db
    .select({ email: P.email, status: P.emailStatus })
    .from(P)
    .innerJoin(C, eq(C.id, P.companyId))
    .where(
      and(
        // Shared rows plus this workspace's private imports; never another workspace's rows.
        workspaceId ? or(isNull(P.workspaceId), eq(P.workspaceId, workspaceId)) : isNull(P.workspaceId),
        eq(C.domain, domain),
        isNotNull(P.email),
        sql`lower(${P.firstName}) = ${first.toLowerCase()}`,
        sql`lower(coalesce(${P.lastName}, '')) = ${last.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (hit?.email) return { email: hit.email, status: hit.status === "catch_all" || hit.status === "risky" ? hit.status : "verified", source: "dataset" };
  // Outside the dataset, never look up people who opted out of this installation's data.
  const notFound: EmailFinding = { email: null, status: "not_found", source: "none" };
  if ((await suppressedValues("linkedin", [normLinkedin(person.linkedin_url)])).size) return notFound;
  const allowed = async (f: EmailFinding) => (f.email && (await suppressedValues("email", [f.email.toLowerCase()])).size ? notFound : f);
  for (const provider of flow) {
    if (provider === "hunter" || provider === "instantly") {
      const h = await hunterFind(first, last, domain);
      if (h) return allowed(h);
    }
  }
  if (!config.verifySmtpProbe) return { email: null, status: "not_found", source: "none", note: "Turn on VERIFY_SMTP_PROBE or set HUNTER_API_KEY to look up emails outside the dataset" };
  const candidates = patterns(first, last, domain);
  for (const candidate of candidates) {
    const r = await verifyAddress(candidate);
    // No SMTP answer (port 25 blocked, greylisting, timeouts): further probes would only wait for timeouts.
    if (r.method !== "smtp") return { email: null, status: "not_found", source: "none", note: "The recipient mail server could not be probed" };
    if (r.status === "verified" || r.status === "risky") return allowed({ email: candidate, status: r.status, source: "pattern" });
    // A catch-all server accepts every address, so the most common pattern is the best guess.
    if (r.status === "catch_all") return allowed({ email: candidates[0]!, status: "catch_all", source: "pattern", note: "The domain accepts all addresses; this is the most common pattern" });
    if (r.reason !== "mailbox_not_found") break;
  }
  return { email: null, status: "not_found", source: "none" };
}

// ---------- Engagement score ----------

/** 0–100 score from the lead's own activity (opens, clicks, replies, recency). */
export function engagementScore(lead: { openCount: number; clickCount: number; replyCount: number; lastOpenAt: Date | null; lastClickAt: Date | null; lastReplyAt: Date | null }): number {
  const last = Math.max(lead.lastOpenAt?.getTime() ?? 0, lead.lastClickAt?.getTime() ?? 0, lead.lastReplyAt?.getTime() ?? 0);
  const days = last ? (Date.now() - last) / 86_400_000 : 365;
  const recency = days < 3 ? 15 : days < 14 ? 8 : days < 45 ? 3 : 0;
  return Math.min(100, Math.round(Math.min(lead.openCount, 6) * 5 + Math.min(lead.clickCount, 4) * 10 + Math.min(lead.replyCount, 2) * 25 + recency));
}
