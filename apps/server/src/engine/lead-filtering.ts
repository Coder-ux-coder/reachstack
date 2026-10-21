// "AI lead filtering" from Settings → Advanced deliverability. The hosted product scores leads with a model
// trained on its network's reply data; that data isn't available here, so leads are classed by their address:
// shared team inboxes rarely answer cold email, and complaint/legal desks are the ones that report it.
import { sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client";

export type FilterAction = "send_as_usual" | "skip" | "send_last";
export type LeadRisk = "unlikely_to_reply" | "hostile";
export interface LeadFilteringPrefs {
  unlikely_to_reply?: FilterAction;
  hostile?: FilterAction;
}

const UNLIKELY = ["info", "sales", "contact", "hello", "hi", "support", "help", "admin", "office", "team", "careers", "jobs", "hr", "billing", "accounts", "marketing", "press", "media", "enquiries", "inquiries", "noreply", "no-reply", "donotreply", "webmaster", "service", "customerservice", "orders", "reception"];
const HOSTILE = ["abuse", "legal", "spam", "postmaster", "privacy", "compliance", "security", "dmca", "gdpr", "complaint", "complaints", "lawyer", "counsel", "dpo"];

export function leadRisk(email: string | null | undefined): LeadRisk | null {
  const local = (email ?? "").split("@")[0]!.toLowerCase();
  if (HOSTILE.includes(local)) return "hostile";
  if (UNLIKELY.includes(local)) return "unlikely_to_reply";
  return null;
}

export function filteringPrefs(settings: Record<string, unknown>): LeadFilteringPrefs {
  return (settings.ai_lead_filtering ?? {}) as LeadFilteringPrefs;
}

/** 1 for leads whose class is set to "send last", else 0; used to order first-step sends. */
export function sendLastOrder(prefs: LeadFilteringPrefs): SQL | null {
  const locals = [...(prefs.unlikely_to_reply === "send_last" ? UNLIKELY : []), ...(prefs.hostile === "send_last" ? HOSTILE : [])];
  if (!locals.length) return null;
  const L = schema.leads;
  return sql`case when lower(substr(${L.email}, 1, instr(${L.email}, '@') - 1)) in (${sql.join(
    locals.map((l) => sql`${l}`),
    sql`, `,
  )}) then 1 else 0 end`;
}
