// Done-for-you domains and mailboxes: availability (public RDAP), restricted names, pricing quotes and orders.
// Ordering records the request; registering domains and creating mailboxes is done by the installation's
// administrator (or a provider integration), who then marks the order fulfilled.
import { getAppSetting } from "./instance";
import { isHostname, normalizeDomain } from "./domains";

export type MailboxProvider = 1 | 2 | 3; // 1 Google, 2 AirMail, 3 Microsoft
export const PROVIDER_NAMES: Record<MailboxProvider, string> = { 1: "google", 2: "airmail", 3: "microsoft" };
export const providerCode = (name: string): MailboxProvider => (name === "microsoft" ? 3 : name === "airmail" ? 2 : 1);

export interface DfyPricing {
  domain_per_year: number;
  prewarmed_domain_per_year: number;
  mailbox_per_month: Record<"1" | "2", number>;
  microsoft_domain_per_month: number;
}

export const DEFAULT_PRICING: DfyPricing = {
  domain_per_year: 15,
  prewarmed_domain_per_year: 45,
  mailbox_per_month: { "1": 4.5, "2": 3.5 },
  microsoft_domain_per_month: 20,
};

export const pricing = () => getAppSetting<DfyPricing>("dfy_pricing", DEFAULT_PRICING);

/** Pre-warmed inventory the administrator has stocked: [{ domain, account_type }]. */
export const prewarmedInventory = () => getAppSetting<Array<{ domain: string; account_type: MailboxProvider }>>("dfy_prewarmed_inventory", []);

/** Names that impersonate well-known brands or look like phishing are refused. */
export const RESTRICTED_KEYWORDS = [
  "google", "gmail", "microsoft", "outlook", "office365", "hotmail", "yahoo", "apple", "icloud", "amazon", "paypal", "stripe",
  "facebook", "instagram", "whatsapp", "linkedin", "netflix", "spotify", "coinbase", "binance", "irs", "gov", "bank",
  "login", "signin", "verify", "account-security", "wallet", "secure-", "support-team",
];

export function restrictedKeyword(domain: string): string | null {
  const label = domain.split(".")[0] ?? "";
  return RESTRICTED_KEYWORDS.find((k) => label.includes(k)) ?? null;
}

const ALLOWED_TLDS = new Set(["com", "org"]);
export function validDfyDomain(domain: string): boolean {
  return isHostname(domain) && domain.split(".").length === 2 && ALLOWED_TLDS.has(domain.split(".")[1]!);
}

const rdapCache = new Map<string, { available: boolean | null; at: number }>();

// Registry RDAP servers come from IANA's bootstrap file; these cover the common TLDs if it can't be fetched.
const RDAP_FALLBACK: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
  org: "https://rdap.publicinterestregistry.org/rdap/",
};
let rdapBootstrap: { at: number; map: Map<string, string> } | null = null;

async function rdapBase(tld: string): Promise<string | null> {
  if (!rdapBootstrap || Date.now() - rdapBootstrap.at > 86_400_000) {
    try {
      const res = await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(8_000) });
      const json = (await res.json()) as { services: Array<[string[], string[]]> };
      const map = new Map<string, string>();
      for (const [tlds, urls] of json.services) {
        const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
        if (url) for (const t of tlds) map.set(t.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
      }
      rdapBootstrap = { at: Date.now(), map };
    } catch {
      // keep the fallback table
    }
  }
  return rdapBootstrap?.map.get(tld) ?? RDAP_FALLBACK[tld] ?? null;
}

/** true = not registered, false = registered, null = could not tell (registry unreachable). */
export async function domainAvailable(raw: string): Promise<boolean | null> {
  const domain = normalizeDomain(raw);
  const hit = rdapCache.get(domain);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.available;
  const base = await rdapBase(domain.split(".").pop() ?? "");
  if (!base) return null;
  let available: boolean | null = null;
  try {
    const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) available = true;
    else if (res.ok) available = false;
    await res.body?.cancel().catch(() => undefined);
  } catch {
    available = null;
  }
  if (available !== null) rdapCache.set(domain, { available, at: Date.now() });
  return available;
}

export async function checkDomains(domains: string[]) {
  const out: Array<{ domain: string; available: boolean; unavailable_reason?: "restricted"; restricted_keyword?: string }> = [];
  for (let i = 0; i < domains.length; i += 6) {
    const batch = await Promise.all(
      domains.slice(i, i + 6).map(async (raw) => {
        const domain = normalizeDomain(raw);
        const kw = restrictedKeyword(domain);
        if (kw) return { domain, available: false, unavailable_reason: "restricted" as const, restricted_keyword: kw };
        if (!validDfyDomain(domain)) return { domain, available: false };
        return { domain, available: (await domainAvailable(domain)) === true };
      }),
    );
    out.push(...batch);
  }
  return out;
}

/** Brandable variations of a domain (prefix/suffix words) that are still unregistered. */
export async function similarDomains(raw: string, tlds: string[] = ["com", "org"], max = 20): Promise<string[]> {
  const base = normalizeDomain(raw).split(".")[0]!.replace(/[^a-z0-9-]/g, "");
  if (!base) return [];
  const prefixes = ["get", "try", "use", "hey", "meet", "go", "join", "with", "hello", "team"];
  const suffixes = ["hq", "app", "mail", "team", "labs", "group", "co", "inc", "now", "works"];
  const names = [...prefixes.map((p) => `${p}${base}`), ...suffixes.map((s) => `${base}${s}`), ...prefixes.slice(0, 4).map((p) => `${p}-${base}`)];
  const candidates = names.flatMap((n) => tlds.filter((t) => ALLOWED_TLDS.has(t)).map((t) => `${n}.${t}`)).filter((d) => !restrictedKeyword(d));
  const found: string[] = [];
  for (let i = 0; i < candidates.length && found.length < max; i += 8) {
    const batch = await Promise.all(candidates.slice(i, i + 8).map(async (d) => ((await domainAvailable(d)) === true ? d : null)));
    found.push(...batch.filter((d): d is string => !!d));
  }
  return found.slice(0, max);
}

export const PREFIX_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
