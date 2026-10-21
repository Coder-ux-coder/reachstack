// Timezones of leads, for "send in each lead's timezone" (CampaignSchedule.lead_timezone): which timezones a campaign's
// or a subsequence's active leads are in, so the sender, the Today page and the sending status can read the schedule on
// each of those clocks; and the engine loop that works out the timezone of leads that don't have one yet.
import { and, asc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { LeadStatus, inferLeadTimezone, type CampaignSchedule } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { chunk } from "../http/util";
import { inZone, isScheduleOpen, zoneSchedules } from "../lib/time";

const L = schema.leads;
const MINUTE = 60_000;

/** Whose leads: a campaign's own, or a subsequence's. */
export interface LeadScope {
  kind: "campaign" | "subsequence";
  id: string;
}

const zoneCache = new Map<string, { at: number; zones: Array<string | null> }>();

/** The timezones of the scope's active leads (null for leads without one), at most a minute old. */
export async function leadZones(scope: LeadScope, now = Date.now()): Promise<Array<string | null>> {
  const key = `${scope.kind}:${scope.id}`;
  const hit = zoneCache.get(key);
  if (hit && hit.at <= now && now - hit.at < MINUTE) return hit.zones;
  const where = scope.kind === "campaign" ? and(eq(L.campaignId, scope.id), eq(L.status, LeadStatus.ACTIVE)) : and(eq(L.subsequenceId, scope.id), eq(L.subseqStatus, LeadStatus.ACTIVE));
  const zones = (await db.selectDistinct({ zone: L.timezone }).from(L).where(where)).map((r) => r.zone);
  if (zoneCache.size > 5_000) zoneCache.clear();
  zoneCache.set(key, { at: now, zones });
  return zones;
}

/** Tests: read the timezones again. */
export function forgetLeadZones() {
  zoneCache.clear();
}

/** The schedules the scope's leads go by: one per timezone they're in with "each lead's timezone", else the schedule. */
export async function leadSchedules(schedule: CampaignSchedule, scope: LeadScope, now = Date.now()): Promise<CampaignSchedule[]> {
  return schedule.lead_timezone ? zoneSchedules(schedule, await leadZones(scope, now)) : [schedule];
}

/**
 * With "each lead's timezone": the timezones whose clock has the schedule open at `now` (null: leads without one, on
 * the schedule's own clock). Without leads yet, the schedule's own clock decides.
 */
export async function openLeadZones(schedule: CampaignSchedule, scope: LeadScope, now = Date.now()): Promise<Array<string | null>> {
  const zones = await leadZones(scope, now);
  return (zones.length ? zones : [null]).filter((z) => isScheduleOpen(z ? inZone(schedule, z) : schedule, now));
}

/** Leads in those timezones. */
export function inZones(zones: Array<string | null>): SQL {
  const named = zones.filter((z): z is string => !!z);
  const parts = [zones.includes(null) ? isNull(L.timezone) : undefined, named.length ? inArray(L.timezone, named) : undefined].filter((c): c is SQL => !!c);
  return parts.length ? or(...parts)! : sql`0`;
}

// ---------- Working out timezones ----------

/** Where the pass got to (by lead id), when it began, which leads it looks at, and when the next one starts. */
const pass = { after: "", startedAt: 0, changedSince: 0, nextAt: 0 };
const BATCH = 2_000;

/**
 * Engine loop: works out the timezone of leads that don't have one, from their location, custom fields or phone. The
 * first pass after a start looks at every such lead; the later ones, every ten minutes, only at leads changed since
 * the previous pass began (enrichment, edits, leads added without a place). Their updated times stay as they were.
 */
export async function fillLeadTimezones(now = Date.now()) {
  if (now < pass.nextAt) return;
  if (!pass.after) pass.startedAt = now;
  const rows = await db
    .select({ id: L.id, location: L.location, phone: L.phone, payload: L.payload })
    .from(L)
    .where(and(isNull(L.timezone), gt(L.id, pass.after), ...(pass.changedSince ? [gte(L.updatedAt, new Date(pass.changedSince))] : [])))
    .orderBy(asc(L.id))
    .limit(BATCH);
  const byZone = new Map<string, string[]>();
  for (const r of rows) {
    const zone = inferLeadTimezone(r);
    if (zone) byZone.set(zone, [...(byZone.get(zone) ?? []), r.id]);
  }
  for (const [zone, ids] of byZone) {
    for (const part of chunk(ids, 500)) await db.update(L).set({ timezone: zone, updatedAt: sql`updated_at` }).where(inArray(L.id, part));
  }
  if (rows.length === BATCH) {
    pass.after = rows[rows.length - 1]!.id;
    return;
  }
  pass.after = "";
  pass.changedSince = pass.startedAt - MINUTE;
  pass.nextAt = now + 10 * MINUTE;
}

/** Tests: start over with a full pass. */
export function resetTimezonePass() {
  Object.assign(pass, { after: "", startedAt: 0, changedSince: 0, nextAt: 0 });
}
