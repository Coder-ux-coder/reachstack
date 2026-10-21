// Subsequences: follow-up sequences a lead enters when a trigger fires (lead status, open, click,
// finished without reply, reply containing text). The sending engine runs them like campaigns.
import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { CampaignStatus, LeadStatus, SubsequenceActivity, delayToMs } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { iso } from "../lib/time";
import { replyWords } from "../mail/reply-text";
import { on } from "./bus";
import { reopenForSubsequences, scheduleSchema, sequencesSchema, storedSchedule, type SubsequenceRow } from "./campaigns";
import type { LeadRow } from "./leads";

const L = schema.leads;
const S = schema.subsequences;

export const conditionsSchema = z.object({
  crm_status: z.array(z.number().int().min(-30000).max(30000)).optional(),
  lead_activity: z.array(z.union([z.literal(2), z.literal(4), z.literal(91)])).optional(),
  reply_contains: z.string().max(500).optional(),
});

const subsequenceFields = z.object({
  name: z.string().trim().min(1).max(250),
  conditions: conditionsSchema,
  subsequence_schedule: scheduleSchema.optional(),
  sequences: sequencesSchema.optional(),
  auto_variant_select: z.object({ trigger: z.enum(["reply_rate", "click_rate", "open_rate"]) }).nullable().optional(),
  daily_limit_mode: z.enum(["inherit", "custom", "unlimited"]).optional(),
  daily_limit: z.number().int().min(0).nullable().optional(),
  ignore_account_daily_limit: z.boolean().optional(),
});
export const createSubsequenceSchema = subsequenceFields.extend({ parent_campaign: z.string().min(1) });
export const patchSubsequenceSchema = subsequenceFields.partial();

export function subsequenceColumns(b: z.infer<typeof patchSubsequenceSchema>): Partial<typeof S.$inferInsert> {
  const out: Partial<typeof S.$inferInsert> = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.conditions !== undefined) out.conditions = b.conditions;
  if (b.subsequence_schedule !== undefined)
    out.schedule = storedSchedule(b.subsequence_schedule);
  if (b.sequences !== undefined) out.sequences = b.sequences;
  if (b.auto_variant_select !== undefined) out.autoVariantSelect = b.auto_variant_select;
  if (b.daily_limit_mode !== undefined) out.dailyLimitMode = b.daily_limit_mode;
  if (b.daily_limit !== undefined) out.dailyLimit = b.daily_limit;
  if (b.ignore_account_daily_limit !== undefined) out.ignoreAccountDailyLimit = b.ignore_account_daily_limit;
  return out;
}

export function serializeSubsequence(s: SubsequenceRow) {
  return {
    id: s.id,
    timestamp_created: iso(s.createdAt),
    parent_campaign: s.parentCampaignId,
    workspace: s.workspaceId,
    status: s.status,
    timestamp_leads_updated: iso(s.leadsUpdatedAt ?? s.createdAt),
    name: s.name,
    conditions: s.conditions ?? {},
    subsequence_schedule: s.schedule,
    sequences: s.sequences,
    auto_variant_select: s.autoVariantSelect,
    daily_limit_mode: s.dailyLimitMode,
    daily_limit: s.dailyLimit,
    ignore_account_daily_limit: s.ignoreAccountDailyLimit,
  };
}

/**
 * Puts a lead into a subsequence: stops the main sequence and schedules the first subsequence step. False when the lead
 * bounced or unsubscribed: nothing more goes out to it, so it isn't put anywhere.
 */
export async function enrollInSubsequence(lead: Pick<LeadRow, "id" | "workspaceId" | "campaignId">, sub: SubsequenceRow): Promise<boolean> {
  const first = sub.sequences?.[0]?.steps?.[0];
  const preDelay = first?.pre_delay ? delayToMs(first.pre_delay, first.pre_delay_unit ?? "days") : 0;
  const now = new Date();
  const [entered] = await db
    .update(L)
    .set({
      subsequenceId: sub.id,
      subseqStatus: LeadStatus.ACTIVE,
      subseqNextStep: 0,
      subseqNextSendAt: now.getTime() + preDelay,
      addedSubsequenceAt: now,
      status: LeadStatus.COMPLETED,
      nextSendAt: null,
    })
    .where(and(eq(L.id, lead.id), notInArray(L.status, [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED])))
    .returning({ id: L.id });
  if (!entered) return false;
  await db.update(S).set({ leadsUpdatedAt: now }).where(eq(S.id, sub.id));
  // A finished campaign starts running again for its subsequences.
  await reopenForSubsequences(sub.workspaceId, sub.parentCampaignId);
  return true;
}

/** This subsequence has emailed the lead before (it was in it). */
async function emailedBy(leadId: string, subsequenceId: string): Promise<boolean> {
  const E = schema.emailEvents;
  const [row] = await db
    .select({ id: E.id })
    .from(E)
    .where(and(eq(E.leadId, leadId), eq(E.subsequenceId, subsequenceId), eq(E.type, "sent")))
    .limit(1);
  return !!row;
}

export async function removeFromSubsequence(leadId: string) {
  await db.update(L).set({ subsequenceId: null, subseqNextStep: 0, subseqNextSendAt: null, subseqStatus: null, addedSubsequenceAt: null }).where(eq(L.id, leadId));
}

type Trigger = { kind: "crm_status"; value: number } | { kind: "activity"; value: number } | { kind: "reply"; text: string };

function matches(sub: SubsequenceRow, t: Trigger): boolean {
  const c = sub.conditions ?? {};
  if (t.kind === "crm_status") return !!c.crm_status?.includes(t.value);
  if (t.kind === "activity") return !!c.lead_activity?.includes(t.value);
  const needle = c.reply_contains?.trim().toLowerCase();
  return !!needle && t.text.toLowerCase().includes(needle);
}

async function trigger(leadId: unknown, t: Trigger) {
  if (typeof leadId !== "string") return;
  const [lead] = await db.select().from(L).where(eq(L.id, leadId)).limit(1);
  if (!lead?.campaignId) return;
  if (lead.status === LeadStatus.BOUNCED || lead.status === LeadStatus.UNSUBSCRIBED) return;
  // Paused by someone: left where it is.
  if (lead.status === LeadStatus.PAUSED || lead.subseqStatus === LeadStatus.PAUSED) return;
  // Someone who replied is in a conversation: an open or a click doesn't start automatic follow-ups.
  if (t.kind === "activity" && lead.replyCount > 0) return;
  const subs = await db
    .select()
    .from(S)
    .where(and(eq(S.parentCampaignId, lead.campaignId), eq(S.status, CampaignStatus.ACTIVE)));
  for (const s of subs) {
    if (s.id === lead.subsequenceId || !matches(s, t)) continue;
    // A subsequence that already emailed this lead isn't started over: opening its emails would send them again, and
    // two subsequences that start on opens would pass the lead back and forth.
    if (await emailedBy(lead.id, s.id)) continue;
    await enrollInSubsequence(lead, s);
    return;
  }
}

on("lead_interest_changed", (e) => {
  if (typeof e.data.value === "number") return trigger(e.data.lead_id, { kind: "crm_status", value: e.data.value });
});
on("email_opened", (e) => trigger(e.data.lead_id, { kind: "activity", value: SubsequenceActivity.EMAIL_OPENED }));
on("email_link_clicked", (e) => trigger(e.data.lead_id, { kind: "activity", value: SubsequenceActivity.LINK_CLICKED }));
on("lead_status_changed", (e) => {
  if (e.data.status === "completed" && !e.data.subsequence_id && !Number(e.data.reply_count ?? 0)) {
    return trigger(e.data.lead_id, { kind: "activity", value: SubsequenceActivity.COMPLETED_WITHOUT_REPLY });
  }
});
// "Reply contains" reads the person's own words, not our quoted email or "Re: <our subject>".
on("reply_received", (e) => trigger(e.data.lead_id, { kind: "reply", text: replyWords(e.data) }));
