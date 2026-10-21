// Agency white label: the agency's name, colour and logo replace the product brand for its client members and on
// its own portal domain, and its default client access applies to client members without a list of their own.
import { and, eq, isNull } from "drizzle-orm";
import type { Permission } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";

type Workspace = typeof schema.workspaces.$inferSelect;
type Member = typeof schema.workspaceMembers.$inferSelect;

export interface Brand {
  name: string;
  color: string | null;
  logo_url: string | null;
}

export const productBrand = (): Brand => ({ name: config.brandName, color: null, logo_url: null });

/** The agency's brand when white label is switched on for this workspace. */
export function agencyBrand(ws: Workspace | null | undefined): Brand | null {
  const a = ws?.settings?.agency;
  if (!ws || !a?.enabled) return null;
  return { name: a.brand_name?.trim() || ws.name, color: a.brand_color ?? null, logo_url: ws.logoUrl };
}

/** A member's own access list, or for clients without one, the agency's default client access. */
export function effectivePermissions(ws: Workspace | null | undefined, member: Member | null | undefined): Permission[] | null {
  if (member?.permissions?.length) return member.permissions;
  const defaults = ws?.settings?.agency?.client_permissions;
  if (member?.role === "client" && defaults?.length) return defaults;
  return member?.permissions ?? null;
}

const ownHosts = new Set([config.webUrl, config.appUrl].map((u) => new URL(u).hostname));
const hostCache = new Map<string, { at: number; brand: Brand | null }>();

/** Brand for a request that arrived on an agency's portal domain (a CNAME to this server). */
export async function brandForHost(host: string | undefined): Promise<Brand | null> {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!h || ownHosts.has(h) || h === "localhost" || /^[\d.]+$/.test(h)) return null;
  const hit = hostCache.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.brand;
  const [ws] = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.clientDomain, h), isNull(schema.workspaces.deletedAt)))
    .limit(1);
  const brand = agencyBrand(ws);
  if (hostCache.size > 500) hostCache.clear();
  hostCache.set(h, { at: Date.now(), brand });
  return brand;
}

/** Called after branding or portal domains change. */
export const forgetPortalBrands = () => hostCache.clear();
