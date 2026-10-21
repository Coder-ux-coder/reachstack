// DNS helpers: mailbox provider and security gateway detection, SPF/DKIM/DMARC checks, CNAME verification and DNS
// blocklists.
import { promises as dns } from "node:dns";
import { EsgCode, EspCode, type DomainRecords } from "@reachstack/shared";
import { config } from "../env";

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
const fallback = new dns.Resolver({ timeout: 4000, tries: 2 });
if (config.dnsFallbackServers.length) fallback.setServers(config.dnsFallbackServers);

/** Record lookups retry on public resolvers when the system resolver errors (many routers time out on large TXT
 *  answers). Blocklist queries never use this: DNSBLs refuse queries that arrive through public resolvers. */
async function lookup<T>(fn: (r: dns.Resolver) => Promise<T>): Promise<T> {
  try {
    return await fn(resolver);
  } catch (err) {
    if (isNotFound(err) || !config.dnsFallbackServers.length) throw err;
    return fn(fallback);
  }
}

type CacheEntry<T> = { value: T; expires: number };
const cache = new Map<string, CacheEntry<unknown>>();

/** `fresh`: look it up again even when an earlier answer is still kept (someone just fixed a record and checks again). */
export interface LookupOptions {
  fresh?: boolean;
}

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts: LookupOptions = {}): Promise<T> {
  const hit = opts.fresh ? undefined : cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  if (value === null) return value; // failed lookups are retried next time, not cached
  cache.set(key, { value, expires: Date.now() + ttlMs });
  if (cache.size > 20_000) {
    for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
  }
  return value;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
}

/** Returns MX hosts (sorted by priority), [] when the domain has none, or null when the lookup failed. */
export function resolveMx(domain: string, opts: LookupOptions = {}): Promise<string[] | null> {
  return cached(`mx:${domain}`, 6 * 3_600_000, async () => {
    try {
      const recs = await lookup((r) => r.resolveMx(domain));
      return recs.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
    } catch (err) {
      return isNotFound(err) ? [] : null;
    }
  }, opts);
}

export async function resolveTxt(name: string, opts: LookupOptions = {}): Promise<string[] | null> {
  return cached(`txt:${name}`, 600_000, async () => {
    try {
      const recs = await lookup((r) => r.resolveTxt(name));
      return recs.map((chunks) => chunks.join(""));
    } catch (err) {
      return isNotFound(err) ? [] : null;
    }
  }, opts);
}

export async function resolveCname(name: string): Promise<string[] | null> {
  try {
    return (await lookup((r) => r.resolveCname(name))).map((h) => h.toLowerCase().replace(/\.$/, ""));
  } catch (err) {
    return isNotFound(err) ? [] : null;
  }
}

export async function resolveA(name: string): Promise<string[]> {
  try {
    return await lookup((r) => r.resolve4(name));
  } catch {
    return [];
  }
}

/** Mailbox provider from a domain's MX hosts (sorted by priority). */
export function providerFromMx(mx: string[]): number {
  const all = mx.join(" ");
  if (/google\.com|googlemail\.com/.test(all)) return EspCode.GOOGLE;
  if (/outlook\.com|office365|microsoft|hotmail/.test(all)) return EspCode.MICROSOFT;
  if (/zoho\./.test(all)) return EspCode.ZOHO;
  if (/yahoo|yahoodns/.test(all)) return EspCode.YAHOO;
  if (/yandex/.test(all)) return EspCode.YANDEX;
  if (/web\.de/.test(all)) return EspCode.WEBDE;
  if (/libero\.it/.test(all)) return EspCode.LIBERO;
  return EspCode.OTHER;
}

/** Hosts each security gateway receives mail on, as they show up in MX records. */
const GATEWAY_HOSTS: Array<[RegExp, number]> = [
  [/\.pphosted\.com$|\.ppe-hosted\.com$/, EsgCode.PROOFPOINT],
  [/\.mimecast(-offshore)?\.(com|co\.za)$/, EsgCode.MIMECAST],
  [/\.barracudanetworks\.com$|\.barracuda\.com$/, EsgCode.BARRACUDA],
  [/\.iphmx\.com$/, EsgCode.CISCO],
  [/\.sophos\.com$/, EsgCode.SOPHOS],
  [/\.trendmicro\.(com|eu)$/, EsgCode.TREND_MICRO],
  [/\.messagelabs\.com$/, EsgCode.BROADCOM],
  [/\.mailcontrol\.com$/, EsgCode.FORCEPOINT],
  [/\.hornetsecurity\.com$/, EsgCode.HORNETSECURITY],
  [/\.mxrecord\.(io|mx)$/, EsgCode.CLOUDFLARE],
];

/** Security gateway from a domain's MX hosts: the first one that belongs to a gateway, in priority order. */
export function gatewayFromMx(mx: string[]): number {
  for (const host of mx) {
    const name = host.replace(/\.$/, "");
    for (const [pattern, code] of GATEWAY_HOSTS) if (pattern.test(name)) return code;
  }
  return EsgCode.NONE;
}

/** Behind a gateway the MX records name the gateway, but the SPF record still says who sends the domain's mail. */
export function providerFromSpf(txt: string[]): number | null {
  const spf = txt.find((t) => /^v=spf1/i.test(t.trim()))?.toLowerCase() ?? "";
  const google = /include:_spf\.google\.com/.test(spf);
  const microsoft = /include:spf\.protection\.outlook\.com/.test(spf);
  const zoho = /include:(one\.)?zoho(mail)?\.(com|eu|in)\b/.test(spf);
  if (Number(google) + Number(microsoft) + Number(zoho) !== 1) return null; // none, or more than one: can't tell
  return google ? EspCode.GOOGLE : microsoft ? EspCode.MICROSOFT : EspCode.ZOHO;
}

export interface MailRouting {
  /** EspCode; IN_QUEUE when DNS couldn't be read (try again later). */
  esp: number;
  /** EsgCode; IN_QUEUE when DNS couldn't be read. */
  esg: number;
}

/** Mailbox provider and security gateway for a recipient domain, from its MX records (and SPF behind a gateway). */
export async function mailRouting(domain: string): Promise<MailRouting> {
  if (!domain) return { esp: EspCode.NOT_FOUND, esg: EsgCode.NONE };
  const mx = await resolveMx(domain);
  if (mx === null) return { esp: EspCode.IN_QUEUE, esg: EsgCode.IN_QUEUE };
  if (!mx.length) return { esp: EspCode.NOT_FOUND, esg: EsgCode.NONE };
  const esg = gatewayFromMx(mx);
  let esp = providerFromMx(mx);
  if (esp === EspCode.OTHER && esg !== EsgCode.NONE) esp = providerFromSpf((await resolveTxt(domain)) ?? []) ?? esp;
  return { esp, esg };
}

export interface DomainAuthResult {
  domain: string;
  allPass: boolean;
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  indeterminate: Array<"mx" | "spf" | "dkim" | "dmarc">;
  details: DomainRecords;
}

const DKIM_SELECTORS = [
  "google",
  "selector1",
  "selector2",
  "default",
  "dkim",
  "mail",
  "k1",
  "k2",
  "s1",
  "s2",
  "smtp",
  "zoho",
  "zmail",
  "mxvault",
  "protonmail",
  "everlytickey1",
  "mandrill",
  "sendgrid",
  "amazonses",
  "key1",
];

/** Second-level labels countries register domains under (example.co.uk, example.com.au). */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "ltd", "plc"]);

/**
 * The registered ("organizational") domain a name belongs to: mail.example.com → example.com, mail.example.co.uk →
 * example.co.uk. A close approximation of the public suffix list, enough to find the DMARC policy of a subdomain.
 */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const take = labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

const isSpf = (t: string) => /^v=spf1(\s|$)/i.test(t.trim());
const isDmarc = (t: string) => /^v=DMARC1\s*(;|$)/i.test(t.trim());

/** Whether DKIM records hold a public key: "key", "revoked" (an empty p=, how a key is withdrawn) or null (none). */
function dkimKey(records: string[]): "key" | "revoked" | null {
  let revoked = false;
  for (const record of records) {
    const tags = new Map<string, string>();
    for (const part of record.split(";")) {
      const at = part.indexOf("=");
      if (at > 0) tags.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).replace(/\s+/g, ""));
    }
    if (!tags.has("p") || (tags.has("v") && tags.get("v")!.toUpperCase() !== "DKIM1")) continue;
    if (tags.get("p")) return "key";
    revoked = true;
  }
  return revoked ? "revoked" : null;
}

/** MX / SPF / DKIM / DMARC check for a sending domain (the "test domain setup" / vitals check). */
export async function checkDomainAuth(domain: string, dkimSelector?: string | null, opts: LookupOptions = {}): Promise<DomainAuthResult> {
  const indeterminate: DomainAuthResult["indeterminate"] = [];
  const notes: NonNullable<DomainRecords["notes"]> = {};
  const mx = await resolveMx(domain, opts);
  if (mx === null) indeterminate.push("mx");
  const txt = await resolveTxt(domain, opts);
  if (txt === null) indeterminate.push("spf");
  // Exactly one: inboxes treat two SPF records as an error, the same as none.
  const spfs = (txt ?? []).filter(isSpf);
  if (spfs.length > 1) notes.spf = `The domain has ${spfs.length} SPF records, and inboxes treat more than one as no SPF at all. Merge them into one record.`;

  // A subdomain without a DMARC record of its own is covered by its organization's (RFC 7489 §6.6.3).
  let dmarcTxt = await resolveTxt(`_dmarc.${domain}`, opts);
  let dmarcDomain = domain;
  const org = organizationalDomain(domain);
  if (dmarcTxt && !dmarcTxt.some(isDmarc) && org !== domain) {
    dmarcTxt = await resolveTxt(`_dmarc.${org}`, opts);
    dmarcDomain = org;
  }
  if (dmarcTxt === null) indeterminate.push("dmarc");
  const dmarcs = (dmarcTxt ?? []).filter(isDmarc);
  if (dmarcs.length > 1) notes.dmarc = `_dmarc.${dmarcDomain} has ${dmarcs.length} DMARC records, and inboxes ignore DMARC when there's more than one. Keep one.`;

  let dkimSel: string | null = null;
  const selectors = dkimSelector ? [dkimSelector, ...DKIM_SELECTORS] : DKIM_SELECTORS;
  const results = await Promise.all(
    selectors.map(async (sel): Promise<{ sel: string; ok: boolean; failed: boolean; note?: string }> => {
      const name = `${sel}._domainkey.${domain}`;
      const recs = await resolveTxt(name, opts);
      if (recs === null) return { sel, ok: false, failed: true };
      const key = dkimKey(recs);
      if (key === "key") return { sel, ok: true, failed: false };
      if (key === "revoked") return { sel, ok: false, failed: false, note: `The DKIM record at ${sel}._domainkey has an empty key (p=), which means it was revoked. Publish the current one from your email provider.` };
      // A selector handed to the email provider (a CNAME) needs a key at the other end.
      const cname = await resolveCname(name);
      if (cname === null) return { sel, ok: false, failed: true };
      if (!cname.length) return { sel, ok: false, failed: false };
      const target = await resolveTxt(cname[0]!, opts);
      if (target === null) return { sel, ok: false, failed: true };
      if (dkimKey(target) === "key") return { sel, ok: true, failed: false };
      return { sel, ok: false, failed: false, note: `${sel}._domainkey points to ${cname[0]}, which has no DKIM key yet. Finish turning DKIM on with your email provider.` };
    }),
  );
  const hit = results.find((r) => r.ok);
  if (hit) dkimSel = hit.sel;
  else {
    if (results.every((r) => r.failed)) indeterminate.push("dkim");
    const note = results.find((r) => r.note)?.note;
    if (note) notes.dkim = note;
  }

  const res = {
    domain,
    mx: !!mx?.length,
    spf: spfs.length === 1,
    dkim: !!dkimSel,
    dmarc: dmarcs.length === 1,
    indeterminate,
    details: {
      mx: mx ?? [],
      spf: spfs[0] ?? null,
      dmarc: dmarcs[0] ?? null,
      dkim_selector: dkimSel,
      ...(dmarcs.length && dmarcDomain !== domain ? { dmarc_domain: dmarcDomain } : {}),
      ...(Object.keys(notes).length ? { notes } : {}),
    },
  };
  return { ...res, allPass: res.mx && res.spf && res.dkim && res.dmarc };
}

export const IP_BLOCKLISTS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
  "dnsbl.sorbs.net",
  "psbl.surriel.com",
  "bl.mailspike.net",
  "ix.dnsbl.manitu.net",
  "dnsbl-1.uceprotect.net",
  "spam.dnsbl.anonmails.de",
  "all.s5h.net",
];

export const DOMAIN_BLOCKLISTS = ["dbl.spamhaus.org", "multi.surbl.org", "black.uribl.com", "dbl.nordspam.com"];

export interface BlocklistHit {
  list: string;
  listed: boolean;
  error?: boolean;
}

async function listed(query: string): Promise<{ listed: boolean; error: boolean }> {
  try {
    const a = await resolver.resolve4(query);
    // 127.255.255.x answers (and 127.0.0.1, which RFC 5782 rules out as a listing) are "query refused / public
    // resolver" sentinels, not listings.
    const real = a.filter((ip) => ip.startsWith("127.") && !ip.startsWith("127.255.255.") && ip !== "127.0.0.1");
    return { listed: real.length > 0, error: real.length === 0 && a.length > 0 };
  } catch (err) {
    return { listed: false, error: !isNotFound(err) };
  }
}

export async function checkIpBlocklists(ip: string, opts: LookupOptions = {}): Promise<BlocklistHit[]> {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return [];
  const rev = ip.split(".").reverse().join(".");
  return cached(`dnsbl-ip:${ip}`, 3_600_000, () => Promise.all(IP_BLOCKLISTS.map(async (list) => ({ list, ...(await listed(`${rev}.${list}`)) }))), opts);
}

export async function checkDomainBlocklists(domain: string, opts: LookupOptions = {}): Promise<BlocklistHit[]> {
  return cached(`dnsbl-dom:${domain}`, 3_600_000, () => Promise.all(DOMAIN_BLOCKLISTS.map(async (list) => ({ list, ...(await listed(`${domain}.${list}`)) }))), opts);
}

/** Is `host` a CNAME pointing at `target` (or already resolving to the same addresses)? */
export async function verifyCname(host: string, target: string): Promise<boolean> {
  const cname = await resolveCname(host);
  const t = target.toLowerCase().replace(/\.$/, "");
  if (cname?.some((c) => c === t)) return true;
  const [a, b] = await Promise.all([resolveA(host), resolveA(t)]);
  return a.length > 0 && a.some((ip) => b.includes(ip));
}
