// Reply labelling: maps a lead's reply to an interest status (Interested, Not interested, Out of office, ...)
// or an AI-enabled custom label. Uses Claude when available and keyword rules otherwise. When the workspace
// turns on "auto label with AI", every incoming reply is labelled and the lead's status follows.
import { and, eq } from "drizzle-orm";
import * as z from "zod/v4";
import { DEFAULT_INTEREST_STATUSES, InterestStatus } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { newestReplyText, replyWords } from "../mail/reply-text";
import { setInterestStatus } from "./activity";
import { aiAvailable, cachedSystem, structured } from "./ai";
import { on } from "./bus";

/** Built-in statuses a reply can signal on its own (the rest are set by people after a meeting or deal). */
export const AI_BUILT_IN_STATUSES = DEFAULT_INTEREST_STATUSES.filter((s) => s.code !== InterestStatus.MEETING_COMPLETED && s.code !== InterestStatus.NO_SHOW && s.code !== InterestStatus.WON);

export interface LabelCandidate {
  code: number;
  label: string;
  description: string;
  custom: boolean;
}

const DESCRIPTIONS: Record<number, string> = {
  [InterestStatus.INTERESTED]: "Wants to learn more, asks questions about the offer, or is open to talking.",
  [InterestStatus.MEETING_BOOKED]: "Has agreed to a specific meeting time or confirms a booked call.",
  [InterestStatus.MEETING_COMPLETED]: "Refers to a meeting that already happened.",
  [InterestStatus.WON]: "Has agreed to buy or sign.",
  [InterestStatus.OUT_OF_OFFICE]: "Automatic or manual away/vacation/leave message.",
  [InterestStatus.NOT_INTERESTED]: "Declines, asks to stop emailing, unsubscribes, or says it's not a fit.",
  [InterestStatus.WRONG_PERSON]: "Says they are not the right contact, have left the company, or redirects to someone else.",
  [InterestStatus.LOST]: "Was engaged before but has now gone with someone else or ended the conversation.",
  [InterestStatus.NO_SHOW]: "Missed a scheduled meeting.",
};

/** Built-in statuses the workspace lets the AI use, plus its custom labels marked "use with AI". */
export async function labelCandidates(workspaceId: string): Promise<LabelCandidate[]> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const allowed = (ws?.settings as { ai_label_codes?: number[] | null } | null)?.ai_label_codes ?? null;
  const custom = await db
    .select()
    .from(schema.leadLabels)
    .where(and(eq(schema.leadLabels.workspaceId, workspaceId), eq(schema.leadLabels.useWithAi, true)));
  const builtIn = AI_BUILT_IN_STATUSES.filter((s) => !allowed || allowed.includes(s.code)).map((s) => ({
    code: s.code,
    label: s.label,
    description: DESCRIPTIONS[s.code] ?? "",
    custom: false,
  }));
  const customLabels = custom.map((l) => ({ code: l.interestStatus, label: l.label, description: l.description ?? "", custom: true }));
  // A custom label that reuses a built-in code replaces the built-in wording.
  const byCode = new Map<number, LabelCandidate>();
  for (const c of [...builtIn, ...customLabels]) byCode.set(c.code, c);
  return [...byCode.values()];
}

const RULES: Array<[number, RegExp]> = [
  [InterestStatus.OUT_OF_OFFICE, /\b(out of (the )?office|on (vacation|holiday|leave)|away (until|from)|annual leave|parental leave|maternity leave|automatic reply|auto-?reply|limited access to (my )?email|back in the office)\b/i],
  [InterestStatus.WRONG_PERSON, /\b(wrong person|not the right (person|contact)|no longer (with|at|work)|(have|has) left (the company|[a-z]+)|doesn'?t work here|not my (area|department)|you should (reach out|contact|talk) to|better person to)\b/i],
  [InterestStatus.NOT_INTERESTED, /\b(not interested|no thanks|no thank you|unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not contact|don'?t (contact|email)|not a (good )?fit|we'?re (all )?set|not (right )?now|please stop|not looking)\b/i],
  [InterestStatus.MEETING_BOOKED, /\b(booked|(just )?scheduled|calendar invite|sent (you )?an invite|see you (on|then|tomorrow)|confirmed for|locked in|talk (to you )?(on|then))\b/i],
  [InterestStatus.INTERESTED, /\b(interested|sounds (good|great|interesting)|let'?s (chat|talk|connect|set up)|tell me more|more (info|information|details)|happy to (chat|talk|connect)|set up a (call|meeting|time)|what times?|when are you (free|available)|open to|send (me|over) (more|the)|could you share|how much|pricing)\b/i],
];

export function ruleLabel(text: string): { code: number; confidence: number } | null {
  const t = text.slice(0, 4_000);
  for (const [code, re] of RULES) if (re.test(t)) return { code, confidence: 0.55 };
  return null;
}

const SYSTEM = `You label replies to B2B outreach emails for a sales team.
Read the reply and pick the single label from the list that best describes the sender's intent.
Judge the newest message only; ignore quoted earlier messages and signatures.
If the reply is a question about the offer, treat it as interest unless it clearly declines.
Return the exact label text, a confidence between 0 and 1, and one short sentence saying why.`;

/** Classifies a reply. Falls back to keyword rules when no AI key is available. */
export async function classifyReply(workspaceId: string, text: string): Promise<{ code: number | null; label: string | null; confidence: number; reason: string; method: "ai" | "rules"; considered: string[] }> {
  const candidates = await labelCandidates(workspaceId);
  const considered = candidates.filter((c) => c.custom).map((c) => c.label);
  // Only the newest message: wording in our quoted email or the sender's signature says nothing about them.
  const body = newestReplyText(text).trim();
  if (!body) return { code: null, label: null, confidence: 0, reason: "Empty reply", method: "rules", considered };
  if (!(await aiAvailable(workspaceId))) {
    const r = ruleLabel(body);
    const match = r ? candidates.find((c) => c.code === r.code) : undefined;
    return { code: match?.code ?? null, label: match?.label ?? null, confidence: r?.confidence ?? 0, reason: r ? "Matched common reply wording" : "No clear intent found", method: "rules", considered };
  }
  const list = candidates.map((c) => `- ${c.label}: ${c.description || "(custom label)"}`).join("\n");
  const out = await structured({
    workspaceId,
    feature: "reply_label",
    effort: "low",
    maxTokens: 2_000,
    system: cachedSystem(`${SYSTEM}\n\nLabels:\n${list}`),
    messages: [{ role: "user", content: `<reply>\n${body.slice(0, 12_000)}\n</reply>` }],
    schema: z.object({
      label: z.string().describe(`Exactly one of: ${candidates.map((c) => c.label).join(" | ")}`),
      confidence: z.number().describe("0 to 1"),
      reason: z.string().describe("One short sentence"),
    }),
  });
  const match = candidates.find((c) => c.label.toLowerCase() === out.label.trim().toLowerCase());
  return { code: match?.code ?? null, label: match?.label ?? null, confidence: Math.max(0, Math.min(1, out.confidence)), reason: out.reason, method: "ai", considered };
}

async function autoLabel(workspaceId: string, data: Record<string, unknown>, forced?: number) {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const prefs = (ws?.settings ?? {}) as { auto_label_with_ai?: boolean; auto_label_ooo?: boolean; update_existing_labels_with_ai?: boolean; ai_label_codes?: number[] | null };
  if (!prefs.auto_label_with_ai) return;
  if (forced === InterestStatus.OUT_OF_OFFICE && (prefs.auto_label_ooo === false || (prefs.ai_label_codes && !prefs.ai_label_codes.includes(forced)))) return;
  const leadId = data.lead_id as string | undefined;
  const emailId = data.email_id as string | undefined;
  if (!leadId) return;
  const result = forced !== undefined ? { code: forced, confidence: 1 } : await classifyReply(workspaceId, replyWords(data));
  if (result.code === null || result.confidence < 0.5) return;
  if (emailId) await db.update(schema.emails).set({ aiInterestValue: result.code }).where(eq(schema.emails.id, emailId));
  const [lead] = await db.select({ status: schema.leads.interestStatus }).from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1);
  // By default only fill an empty status or move on from "Out of office"; replacing a label needs the workspace's opt-in.
  if (lead && (lead.status === null || lead.status === InterestStatus.OUT_OF_OFFICE || (prefs.update_existing_labels_with_ai && lead.status !== result.code))) {
    await setInterestStatus({ workspaceId, leadIds: [leadId], value: result.code, source: "ai" });
  }
}

on("reply_received", (e) => autoLabel(e.workspaceId, e.data));
// Only an away notice is "Out of office"; other automatic emails ("we got your message") leave the label alone.
on("auto_reply_received", (e) => {
  if (e.data.out_of_office) return autoLabel(e.workspaceId, e.data, InterestStatus.OUT_OF_OFFICE);
});
