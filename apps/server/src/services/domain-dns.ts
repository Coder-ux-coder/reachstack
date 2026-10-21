// The DNS check of each sending domain: MX (replies arrive), SPF and DKIM (the mail is really yours) and DMARC (what
// inboxes do when it isn't). Run from Accounts, when a mailbox is connected and once a day in the background, and kept
// per workspace so the account list shows it without waiting on DNS.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ProviderCode, type DomainDns } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { checkDomainAuth, type DomainAuthResult, type LookupOptions } from "../lib/dns";
import { on } from "./bus";
import { inUse } from "./live-workspaces";

const D = schema.domainChecks;
const A = schema.emailAccounts;
const W = schema.workspaces;
type CheckRow = typeof D.$inferSelect;
type Mailbox = { email: string; providerCode: number };

/** How long a check counts as current; the background loop runs older ones again. */
export const DNS_RECHECK_MS = 24 * 3_600_000;

export const mailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();

/** Reserved names (.test, .example, .invalid, .localhost) and sandbox mailboxes aren't in DNS. */
export const checkableDomain = (domain: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !/\.(test|example|invalid|localhost)$/.test(domain);
const checkable = (a: Mailbox) => a.providerCode !== ProviderCode.SANDBOX && checkableDomain(mailDomain(a.email));

function serialize(r: CheckRow): DomainDns {
  const unknown = new Set(r.indeterminate ?? []);
  // A record whose lookup failed is unknown (null), not missing.
  const state = (key: "mx" | "spf" | "dkim" | "dmarc", found: boolean) => (found ? true : unknown.has(key) ? null : false);
  return {
    domain: r.domain,
    mx: state("mx", r.mx),
    spf: state("spf", r.spf),
    dkim: state("dkim", r.dkim),
    dmarc: state("dmarc", r.dmarc),
    details: r.details,
    checked_at: r.checkedAt.toISOString(),
  };
}

/** Keeps a check's result as the domain's latest. */
export async function saveDomainCheck(workspaceId: string, r: DomainAuthResult): Promise<DomainDns> {
  const values = { mx: r.mx, spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, indeterminate: r.indeterminate, details: r.details, checkedAt: new Date() };
  const [row] = await db
    .insert(D)
    .values({ workspaceId, domain: r.domain, ...values })
    .onConflictDoUpdate({ target: [D.workspaceId, D.domain], set: values })
    .returning();
  return serialize(row!);
}

/** Checks these domains now, four at a time, and keeps the results (`fresh`: none of the answers kept from earlier lookups). */
export async function checkDomains(workspaceId: string, domains: string[], opts: LookupOptions = {}): Promise<DomainDns[]> {
  const todo = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(checkableDomain);
  const out: DomainDns[] = [];
  for (let i = 0; i < todo.length; i += 4) {
    const results = await Promise.all(todo.slice(i, i + 4).map((d) => checkDomainAuth(d, undefined, opts)));
    for (const r of results) out.push(await saveDomainCheck(workspaceId, r));
  }
  return out;
}

/** A check that found a record missing (one that couldn't be looked up doesn't count). */
export const missingRecord = (d: DomainDns | null | undefined) => !!d && (d.mx === false || d.spf === false || d.dkim === false || d.dmarc === false);

/** Checks the domains of these mailboxes now (sandbox ones are left out). */
export function checkMailboxDomains(workspaceId: string, mailboxes: Mailbox[], opts: LookupOptions = {}) {
  return checkDomains(workspaceId, mailboxes.filter(checkable).map((a) => mailDomain(a.email)), opts);
}

/** The latest check of each mailbox's domain, by mailbox id: null when it hasn't been checked yet or can't be. */
export async function mailboxDns(workspaceId: string, mailboxes: Array<Mailbox & { id: string }>): Promise<Map<string, DomainDns | null>> {
  const domains = [...new Set(mailboxes.filter(checkable).map((a) => mailDomain(a.email)))];
  const rows = domains.length ? await db.select().from(D).where(and(eq(D.workspaceId, workspaceId), inArray(D.domain, domains))) : [];
  const byDomain = new Map(rows.map((r) => [r.domain, serialize(r)]));
  return new Map(mailboxes.map((a) => [a.id, checkable(a) ? (byDomain.get(mailDomain(a.email)) ?? null) : null]));
}

/** A check where no lookup got an answer (the machine was offline) is tried again after an hour, not a day. */
const isFresh = (r: { checkedAt: Date; indeterminate: string[] }) => Date.now() - r.checkedAt.getTime() < (r.indeterminate.length >= 4 ? 3_600_000 : DNS_RECHECK_MS);

/** The background loop: domains of real mailboxes never checked, or not in the last day, a few at a time. */
export async function refreshDomainChecks(max = 20) {
  const mailboxes = await db
    .select({ workspaceId: A.workspaceId, email: A.email, providerCode: A.providerCode })
    .from(A)
    .innerJoin(W, eq(W.id, A.workspaceId))
    .where(and(isNull(W.deletedAt), ne(A.providerCode, ProviderCode.SANDBOX), await inUse(A.workspaceId)));
  const wanted = new Map<string, Set<string>>();
  for (const m of mailboxes) {
    if (!checkable(m)) continue;
    if (!wanted.has(m.workspaceId)) wanted.set(m.workspaceId, new Set());
    wanted.get(m.workspaceId)!.add(mailDomain(m.email));
  }
  if (!wanted.size) return;
  const fresh = new Set(
    (await db.select({ workspaceId: D.workspaceId, domain: D.domain, checkedAt: D.checkedAt, indeterminate: D.indeterminate }).from(D).where(inArray(D.workspaceId, [...wanted.keys()])))
      .filter(isFresh)
      .map((r) => `${r.workspaceId} ${r.domain}`),
  );
  let left = max;
  for (const [workspaceId, domains] of wanted) {
    const due = [...domains].filter((d) => !fresh.has(`${workspaceId} ${d}`)).slice(0, left);
    if (!due.length) continue;
    await checkDomains(workspaceId, due);
    left -= due.length;
    if (left <= 0) break;
  }
}

// A new mailbox's domain is checked straight away, unless it was in the last hour: a bulk import of fifty mailboxes on
// one domain checks it once.
const checking = new Set<string>();
on("account_added", async (ev) => {
  const [a] = await db.select({ email: A.email, providerCode: A.providerCode }).from(A).where(eq(A.id, String(ev.data.account_id ?? ""))).limit(1);
  if (!a || !checkable(a)) return;
  const domain = mailDomain(a.email);
  const key = `${ev.workspaceId} ${domain}`;
  if (checking.has(key)) return;
  checking.add(key);
  try {
    const [last] = await db.select({ checkedAt: D.checkedAt }).from(D).where(and(eq(D.workspaceId, ev.workspaceId), eq(D.domain, domain))).limit(1);
    if (!last || Date.now() - last.checkedAt.getTime() > 3_600_000) await checkDomains(ev.workspaceId, [domain]);
  } finally {
    checking.delete(key);
  }
});
