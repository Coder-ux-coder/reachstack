// Custom tracking domains. A mailbox's open, click and unsubscribe links use its own domain only while that name reaches
// this installation over HTTPS: otherwise every link would lead nowhere (a certificate never set up or expired, a DNS
// record removed) and nobody could unsubscribe. Checked when a domain is set or someone asks, and every hour in the
// background, so one that stops working falls back to the shared tracking address and one that starts working is used.
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { config } from "../env";
import { hmac, verifyHmac } from "../lib/crypto";
import { verifyCname } from "../lib/dns";
import { publicFetch, readCapped } from "../lib/net";
import { checkableDomain } from "./domain-dns";

const A = schema.emailAccounts;

/** Where custom tracking domains point (the target of their CNAME record). */
export const trackingHost = () => new URL(config.trackingBaseUrl).hostname;

/** The answer /api/health gives to a challenge: only a server holding this installation's secret can give it. */
export const healthProof = (challenge: string) => hmac(`health:${challenge}`, 16);

/** How a check looks a domain up (tests put stand-ins here). */
export const trackingProbes = {
  /** The domain's CNAME record (or its addresses) leads to the tracking host. */
  cname: (host: string): Promise<boolean> => verifyCname(host, trackingHost()),
  /** https://<host> answers as this installation: its certificate is good and requests for it reach this server. */
  https: async (host: string): Promise<boolean> => {
    const challenge = randomUUID();
    try {
      const res = await publicFetch(`https://${host}/api/health?challenge=${challenge}`, { signal: AbortSignal.timeout(8_000) });
      const text = await readCapped(res, 4_096);
      if (!res.ok) return false;
      const proof = (JSON.parse(text) as { proof?: unknown } | null)?.proof;
      return typeof proof === "string" && verifyHmac(`health:${challenge}`, proof, 16);
    } catch {
      return false;
    }
  },
};

export interface TrackingDomainCheck {
  /** The DNS record is in place (shown to help set it up; HTTPS is what decides). */
  cname: boolean;
  /** HTTPS on the domain reaches this installation. */
  ssl: boolean;
  status: "verified" | "pending";
}

/** A tracking domain as entered: lowercased, and a host name like track.yourdomain.com ("" removes it). */
export const trackingDomainInput = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => !v || /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v), "Enter a domain name like track.yourdomain.com");

/** Checks a tracking domain now: verified once its links would work, meaning HTTPS reaches this installation under it. */
export async function checkTrackingDomain(host: string): Promise<TrackingDomainCheck> {
  // Reserved names (.test, .example…) aren't in DNS: nothing to look up.
  if (!checkableDomain(host)) return { cname: false, ssl: false, status: "pending" };
  const [cname, ssl] = await Promise.all([trackingProbes.cname(host).catch(() => false), trackingProbes.https(host)]);
  return { cname, ssl, status: ssl ? "verified" : "pending" };
}

/** Checks made for mailboxes being added, kept a minute: an import of many mailboxes on one domain checks it once. */
const recentChecks = new Map<string, { status: TrackingDomainCheck["status"]; at: number }>();

/** The status a mailbox added with this tracking domain starts with: verified when mailboxes using it already are, else checked now. */
export async function trackingStatusFor(host: string): Promise<TrackingDomainCheck["status"]> {
  const [inUse] = await db
    .select({ id: A.id })
    .from(A)
    .where(and(eq(A.trackingDomainName, host), eq(A.trackingDomainStatus, "verified")))
    .limit(1);
  if (inUse) return "verified";
  const recent = recentChecks.get(host);
  if (recent && Date.now() - recent.at < 60_000) return recent.status;
  const { status } = await checkTrackingDomain(host);
  if (recentChecks.size > 500) recentChecks.clear();
  recentChecks.set(host, { status, at: Date.now() });
  return status;
}

/** Sets the status of every mailbox using this tracking domain (in any workspace: the check is the same). */
async function saveStatus(host: string, status: TrackingDomainCheck["status"]) {
  await db
    .update(A)
    .set({ trackingDomainStatus: status })
    .where(and(eq(A.trackingDomainName, host), or(isNull(A.trackingDomainStatus), ne(A.trackingDomainStatus, status))));
}

/** The background check of every custom tracking domain in use (hourly). */
export async function recheckTrackingDomains(): Promise<void> {
  const rows = await db.selectDistinct({ host: A.trackingDomainName, status: A.trackingDomainStatus }).from(A).where(isNotNull(A.trackingDomainName));
  const verified = new Map<string, boolean>();
  for (const r of rows) if (r.host) verified.set(r.host, (verified.get(r.host) ?? false) || r.status === "verified");
  for (const [host, wasVerified] of verified) {
    let { status } = await checkTrackingDomain(host);
    // A domain in use is only given up when a second look, straight after, fails too: not for one dropped request.
    if (status === "pending" && wasVerified) status = (await checkTrackingDomain(host)).status;
    await saveStatus(host, status);
  }
}
