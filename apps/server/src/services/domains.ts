// Sending-domain helpers: which domains a workspace owns, and web forwarding for domains pointed at this server.
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { config } from "../env";

const HOSTNAME = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/;

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export const isHostname = (d: string) => HOSTNAME.test(d);

/** Domains of this workspace's connected email accounts and done-for-you orders. */
export async function workspaceDomains(workspaceId: string): Promise<Set<string>> {
  const [accounts, orders] = await Promise.all([
    db.select({ email: schema.emailAccounts.email }).from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, workspaceId)),
    db.select({ domain: schema.dfyOrders.domain }).from(schema.dfyOrders).where(eq(schema.dfyOrders.workspaceId, workspaceId)),
  ]);
  const out = new Set<string>();
  for (const a of accounts) out.add(a.email.split("@")[1]!.toLowerCase());
  for (const o of orders) out.add(o.domain.toLowerCase());
  return out;
}

export function serializeForwarding(domain: string, row?: { forwardingDomain: string; forwardingMode: string } | null) {
  return { domain, forwarding_domain: row?.forwardingDomain ?? null, forwarding_mode: (row?.forwardingMode as "redirect" | "stealth" | undefined) ?? null };
}

export async function forwardingFor(workspaceId: string, domain: string) {
  const [row] = await db
    .select()
    .from(schema.domainForwarding)
    .where(and(eq(schema.domainForwarding.workspaceId, workspaceId), eq(schema.domainForwarding.domain, domain)))
    .limit(1);
  return row ?? null;
}

// ---------- Host-based forwarding (global onRequest hook) ----------

/** Hosts this installation itself is served on are never forwarded. */
const OWN_HOSTS = new Set([config.appUrl, config.webUrl, config.trackingBaseUrl].map((u) => new URL(u).hostname.toLowerCase()));

const hostCache = new Map<string, { row: { forwardingDomain: string; forwardingMode: string } | null; at: number }>();

export function invalidateForwardingCache(domain?: string) {
  if (domain) {
    hostCache.delete(domain);
    hostCache.delete(`www.${domain}`);
  } else hostCache.clear();
}

async function lookupHost(host: string) {
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.row;
  const domain = host.replace(/^www\./, "");
  const [row] = await db
    .select({ forwardingDomain: schema.domainForwarding.forwardingDomain, forwardingMode: schema.domainForwarding.forwardingMode })
    .from(schema.domainForwarding)
    .where(eq(schema.domainForwarding.domain, domain))
    .limit(1);
  hostCache.set(host, { row: row ?? null, at: Date.now() });
  if (hostCache.size > 5_000) hostCache.clear();
  return row ?? null;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * When a forwarded sending domain's website points at this server, its visitors go to the main site:
 * `redirect` answers 301, `stealth` keeps the sending domain in the address bar and frames the main site.
 * App, API and tracking paths are never forwarded.
 */
export async function domainForwardingHook(req: FastifyRequest, reply: FastifyReply) {
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const host = (req.hostname || "").toLowerCase().replace(/:\d+$/, "");
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.endsWith(".localhost") || OWN_HOSTS.has(host)) return;
  const path = req.url.split("?")[0] ?? "/";
  if (/^\/(api|app|auth|assets|t|o|c|u|unsubscribe|privacy|share)(\/|$)/.test(path)) return;
  const row = await lookupHost(host);
  if (!row) return;
  const target = `https://${row.forwardingDomain}`;
  if (row.forwardingMode === "stealth") {
    return reply
      .header("cache-control", "public, max-age=300")
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttr(host)}</title>` +
          `<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden}</style></head>` +
          `<body><iframe src="${escapeAttr(target + path)}" title="${escapeAttr(row.forwardingDomain)}"></iframe></body></html>`,
      );
  }
  return reply.redirect(`${target}${path === "/" ? "" : path}`, 301);
}
