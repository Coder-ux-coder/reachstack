// Email verification (syntax, DNS, disposable/role checks and optional SMTP probing) and lead ESP detection.
// SMTP probing needs outbound port 25, which most hosts block, so it is opt-in via VERIFY_SMTP_PROBE=true;
// without it a result is based on DNS only and says so (`method: "dns"`).
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { ESG_LABELS, EsgCode, EspCode, VerificationStatus, domainOf, isValidEmailSyntax } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { mailRouting, resolveA, resolveMx, type MailRouting } from "../lib/dns";
import { iso } from "../lib/time";

export type VerifyStatus = "verified" | "invalid" | "risky" | "catch_all" | "unknown";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  catch_all: boolean | "pending";
  reason: string;
  method: "smtp" | "dns" | "sandbox";
  checks: { syntax: boolean; mx: boolean | null; disposable: boolean; role: boolean; smtp: string | null };
  /** Reused from a check in the last 30 days; costs no credit. */
  cached?: boolean;
}

const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com",
  "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "fakeinbox.com", "throwawaymail.com", "mintemail.com",
  "mohmal.com", "emailondeck.com", "spamgourmet.com", "mailnesia.com", "tempail.com", "burnermail.io", "moakt.com",
  "mailcatch.com", "inboxkitten.com", "tempr.email", "discard.email", "spambox.us", "mytemp.email", "33mail.com",
]);
const ROLE = /^(admin|administrator|info|support|sales|contact|hello|team|office|billing|accounts|noreply|no-reply|postmaster|abuse|webmaster|marketing|hr|jobs|careers|help|enquiries|inquiries|privacy|legal|security)$/i;

/** Maps a verification result onto the lead verification_status codes. */
export function leadVerificationCode(status: VerifyStatus): number {
  return { verified: VerificationStatus.VERIFIED, invalid: VerificationStatus.INVALID, risky: VerificationStatus.RISKY, catch_all: VerificationStatus.CATCH_ALL, unknown: VerificationStatus.NOT_VERIFIED }[status];
}

/** API v2 shape: verification_status is pending | verified | invalid. */
export function apiVerificationStatus(status: VerifyStatus): "verified" | "invalid" | "pending" {
  if (status === "invalid") return "invalid";
  if (status === "unknown") return "pending";
  return "verified";
}

/** Minimal SMTP conversation: EHLO, MAIL FROM, RCPT TO for the address and a random one (catch-all test). */
function smtpProbe(mx: string, email: string): Promise<{ code: number; catchAll: boolean | null; text: string }> {
  return new Promise((resolve) => {
    const sock = connect({ host: mx, port: 25 });
    const domain = domainOf(email);
    const heloHost = new URL(config.appUrl).hostname || "localhost";
    const steps = [`EHLO ${heloHost}`, `MAIL FROM:<verify@${heloHost}>`, `RCPT TO:<${email}>`, `RCPT TO:<${randomBytes(8).toString("hex")}@${domain}>`, "QUIT"];
    let buf = "";
    let step = -1;
    let rcptCode = 0;
    let rcptText = "";
    let catchAll: boolean | null = null;
    const finish = () => {
      sock.destroy();
      resolve({ code: rcptCode, catchAll, text: rcptText });
    };
    sock.setTimeout(12_000, finish);
    sock.on("error", finish);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      // Wait for the final line of a (possibly multi-line) reply.
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buf = "";
      if (step === 2) {
        rcptCode = code;
        rcptText = last;
        if (code >= 500) return finish();
      }
      if (step === 3) catchAll = code < 300;
      if (code >= 400 && step < 2) {
        rcptText = last;
        return finish();
      }
      step++;
      if (step >= steps.length) return finish();
      sock.write(`${steps[step]}\r\n`);
    });
  });
}

/** Deterministic outcomes for sandbox domains (*.test) so demos and tests behave predictably. */
function sandboxResult(email: string): VerifyResult {
  const local = email.split("@")[0]!.toLowerCase();
  const domain = domainOf(email);
  const base = { email, method: "sandbox" as const, checks: { syntax: true, mx: true, disposable: false, role: ROLE.test(local), smtp: "sandbox" } };
  if (local.startsWith("bounce") || local.startsWith("invalid") || domain === "bounce.test") return { ...base, status: "invalid", catch_all: false, reason: "mailbox_not_found" };
  if (domain.includes("catchall")) return { ...base, status: "catch_all", catch_all: true, reason: "accepts_all" };
  if (local.startsWith("risky")) return { ...base, status: "risky", catch_all: false, reason: "low_quality" };
  if (base.checks.role) return { ...base, status: "risky", catch_all: false, reason: "role_account" };
  return { ...base, status: "verified", catch_all: false, reason: "accepted" };
}

/** Demo-dataset addresses (*.test) verify as the dataset records them, so demo leads look realistic. */
async function demoDatasetResult(email: string): Promise<VerifyResult | null> {
  const P = schema.lfPeople;
  const [row] = await db.select({ status: P.emailStatus }).from(P).where(and(isNull(P.workspaceId), eq(P.email, email))).limit(1);
  const base = sandboxResult(email);
  if (row?.status === "catch_all") return { ...base, status: "catch_all", catch_all: true, reason: "accepts_all" };
  if (row?.status === "risky") return { ...base, status: "risky", catch_all: false, reason: "low_quality" };
  return null; // not in the dataset, or verified there: the usual sandbox rules apply
}

export async function verifyAddress(raw: string): Promise<VerifyResult> {
  const email = raw.trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  const domain = domainOf(email);
  const checks: VerifyResult["checks"] = { syntax: isValidEmailSyntax(email), mx: null, disposable: DISPOSABLE.has(domain), role: ROLE.test(local), smtp: null };
  if (!checks.syntax) return { email, status: "invalid", catch_all: false, reason: "invalid_syntax", method: "dns", checks };
  if (domain.endsWith(".test")) return (await demoDatasetResult(email)) ?? sandboxResult(email);
  if (checks.disposable) return { email, status: "invalid", catch_all: false, reason: "disposable_domain", method: "dns", checks };
  const mx = await resolveMx(domain);
  if (mx === null) return { email, status: "unknown", catch_all: "pending", reason: "dns_lookup_failed", method: "dns", checks };
  let hosts = mx;
  if (!hosts.length) {
    // RFC 5321: with no MX record, the domain's A record is the implicit mail host.
    const a = await resolveA(domain);
    if (!a.length) return { email, status: "invalid", catch_all: false, reason: "no_mail_server", method: "dns", checks: { ...checks, mx: false } };
    hosts = [domain];
  }
  checks.mx = true;
  if (config.verifySmtpProbe) {
    const probe = await smtpProbe(hosts[0]!, email);
    checks.smtp = probe.text || null;
    if (probe.code >= 500) return { email, status: "invalid", catch_all: false, reason: "mailbox_not_found", method: "smtp", checks };
    if (probe.code >= 200 && probe.code < 300) {
      if (probe.catchAll) return { email, status: "catch_all", catch_all: true, reason: "accepts_all", method: "smtp", checks };
      return { email, status: checks.role ? "risky" : "verified", catch_all: false, reason: checks.role ? "role_account" : "accepted", method: "smtp", checks };
    }
    // Greylisting, timeouts or blocked port 25: fall back to the DNS verdict below.
  }
  return { email, status: checks.role ? "risky" : "verified", catch_all: "pending", reason: checks.role ? "role_account" : "mx_found", method: "dns", checks };
}

/** Gives the workspace's leads with this address the verdict. */
async function markLeads(workspaceId: string, email: string, status: VerifyResult["status"]) {
  await db
    .update(schema.leads)
    .set({ verificationStatus: leadVerificationCode(status) })
    .where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.email, email)));
}

/** Verifies, stores the result (cached 30 days per workspace), gives it to the leads with that address and returns it. */
export async function verifyAndStore(workspaceId: string, email: string, opts: { jobId?: string | null; useCache?: boolean } = {}) {
  const key = email.trim().toLowerCase();
  if (opts.useCache !== false) {
    const [hit] = await db
      .select()
      .from(schema.emailVerifications)
      .where(and(eq(schema.emailVerifications.workspaceId, workspaceId), eq(schema.emailVerifications.email, key), sql`${schema.emailVerifications.createdAt} > ${Date.now() - 30 * 86_400_000}`))
      .orderBy(desc(schema.emailVerifications.createdAt))
      .limit(1);
    // A check that reached no verdict (the domain's mail servers couldn't be looked up) is tried again, not reused.
    if (hit?.result && hit.verificationStatus !== "pending" && hit.verificationStatus !== "unknown") {
      const cached = hit.result as unknown as VerifyResult;
      if (opts.jobId) await db.insert(schema.emailVerifications).values({ ...hit, id: undefined, jobId: opts.jobId, creditsUsed: 0, createdAt: new Date() });
      // Leads added (or reset) since the address was checked take the verdict too, or they'd stay unverified.
      await markLeads(workspaceId, key, cached.status);
      return { ...cached, cached: true };
    }
  }
  const result = await verifyAddress(key);
  await db.insert(schema.emailVerifications).values({
    workspaceId,
    email: key,
    verificationStatus: result.status,
    catchAll: String(result.catch_all),
    reason: result.reason,
    result: result as unknown as Record<string, unknown>,
    creditsUsed: result.status === "unknown" ? 0 : 1,
    jobId: opts.jobId ?? null,
  });
  await markLeads(workspaceId, key, result.status);
  return result;
}

export function serializeVerification(r: typeof schema.emailVerifications.$inferSelect) {
  const result = (r.result ?? {}) as Partial<VerifyResult>;
  return {
    id: r.id,
    email: r.email,
    verification_status: r.verificationStatus,
    catch_all: r.catchAll === "true" ? true : r.catchAll === "false" ? false : "pending",
    reason: r.reason,
    method: result.method ?? null,
    checks: result.checks ?? null,
    credits_used: r.creditsUsed,
    job_id: r.jobId,
    timestamp_created: iso(r.createdAt),
  };
}

// ---------- Mailbox provider and security gateway of leads ----------

/** Made-up .test domains take their provider and gateway from words in the name, like acme-mimecast-m365.test. */
function sandboxRouting(domain: string): MailRouting {
  const words = new Set(domain.split(/[^a-z0-9]+/));
  const esp = /gmail|google|gworkspace/.test(domain)
    ? EspCode.GOOGLE
    : /outlook|hotmail|m365|microsoft/.test(domain)
      ? EspCode.MICROSOFT
      : /zoho/.test(domain)
        ? EspCode.ZOHO
        : EspCode.OTHER;
  const gateway = Object.entries(ESG_LABELS).find(([code, label]) => Number(code) > 0 && words.has(label.toLowerCase().replace(/[^a-z]/g, "")));
  return { esp, esg: gateway ? Number(gateway[0]) : EsgCode.NONE };
}

const routingFor = async (domain: string): Promise<MailRouting> => (domain.endsWith(".test") ? sandboxRouting(domain) : mailRouting(domain));

function byDomain(rows: Array<{ id: string; email: string | null }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const d = domainOf(r.email ?? "");
    out.set(d, [...(out.get(d) ?? []), r.id]);
  }
  return out;
}

/** How far the gateway pass over leads that already have a provider got (by id), and when the next pass starts. */
const gatewayPass = { after: "", nextAt: 0 };

/**
 * Engine loop: one MX lookup per domain gives a lead's mailbox provider and security gateway. New leads go first.
 * Then leads that got a provider without a gateway (added before gateways were checked) are checked a pass at a
 * time, in id order, keeping their updated time; a domain that couldn't be looked up waits for the next pass.
 */
export async function detectLeadEsps(now = Date.now()) {
  const L = schema.leads;
  const fresh = await db.select({ id: L.id, email: L.email }).from(L).where(eq(L.espCode, EspCode.IN_QUEUE)).orderBy(asc(L.updatedAt)).limit(400);
  for (const [domain, ids] of byDomain(fresh)) {
    const found = await routingFor(domain);
    // DNS failures stay "in queue"; touching updated_at moves them to the back so other leads are not starved.
    await db
      .update(L)
      .set(found.esp === EspCode.IN_QUEUE ? { updatedAt: new Date() } : { espCode: found.esp, esgCode: found.esg })
      .where(inArray(L.id, ids));
  }
  if (now < gatewayPass.nextAt) return;
  const known = await db
    .select({ id: L.id, email: L.email })
    .from(L)
    .where(and(eq(L.esgCode, EsgCode.IN_QUEUE), ne(L.espCode, EspCode.IN_QUEUE), gt(L.id, gatewayPass.after)))
    .orderBy(asc(L.id))
    .limit(400);
  const done = known.length < 400;
  gatewayPass.after = done ? "" : known[known.length - 1]!.id;
  if (done) gatewayPass.nextAt = now + 3_600_000;
  for (const [domain, ids] of byDomain(known)) {
    const { esg } = await routingFor(domain);
    if (esg !== EsgCode.IN_QUEUE) await db.update(L).set({ esgCode: esg, updatedAt: sql`updated_at` }).where(inArray(L.id, ids));
  }
}

/** Tests: start the gateway pass over. */
export function resetGatewayPass() {
  gatewayPass.after = "";
  gatewayPass.nextAt = 0;
}
