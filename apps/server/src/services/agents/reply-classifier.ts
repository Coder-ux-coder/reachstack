// Sorts a lead's message before the Inbox Manager drafts anything: interested, wants a meeting, a question, not
// interested, wrong person, out of office, unsubscribe, an automatic email, or other. Plain rules settle the clear
// cases (opt-outs, out-of-office and other automatic emails); the AI reads the rest, and the keyword rules stand in
// when the AI call fails. Only the newest part of the message counts, never our quoted email.
import * as z from "zod/v4";
import { InterestStatus, htmlToText } from "@reachstack/shared";
import { detectOptOut, isAbsenceNotice, newestReplyText } from "../../mail/reply-text";
import { cachedSystem, structured } from "../ai";
import { ruleLabel } from "../reply-labels";

export type ReplyCategory = "interested" | "meeting" | "question" | "not_interested" | "wrong_person" | "out_of_office" | "unsubscribe" | "automatic" | "other";

export interface ReplyClass {
  category: ReplyCategory;
  confidence: number; // 0-1
  reason: string;
  method: "rules" | "ai";
}

const CATEGORIES: Array<{ key: ReplyCategory; label: string; description: string }> = [
  { key: "interested", label: "Interested", description: "Wants to learn more or is open to talking." },
  { key: "meeting", label: "Meeting", description: "Agrees to a call, proposes or confirms a time, or asks for a booking link." },
  { key: "question", label: "Question", description: "Asks something about the offer without saying yes or no yet." },
  { key: "not_interested", label: "Not interested", description: "Declines, says it's not a fit, or not now." },
  { key: "wrong_person", label: "Wrong person", description: "Not the right contact, has left the company, or points to someone else." },
  { key: "out_of_office", label: "Out of office", description: "Away, on leave or on holiday." },
  { key: "unsubscribe", label: "Unsubscribe", description: "Asks to stop the emails or to be removed." },
  { key: "automatic", label: "Automatic", description: "An automatic email such as a ticket confirmation, not written by a person." },
  { key: "other", label: "Other", description: "None of the above." },
];

/** The lead status a category stands for, when it says enough on its own. */
export const CATEGORY_STATUS: Partial<Record<ReplyCategory, number>> = {
  interested: InterestStatus.INTERESTED,
  question: InterestStatus.INTERESTED,
  meeting: InterestStatus.MEETING_BOOKED,
  not_interested: InterestStatus.NOT_INTERESTED,
  unsubscribe: InterestStatus.NOT_INTERESTED,
  wrong_person: InterestStatus.WRONG_PERSON,
  out_of_office: InterestStatus.OUT_OF_OFFICE,
};

const RULE_CATEGORY: Record<number, ReplyCategory> = {
  [InterestStatus.INTERESTED]: "interested",
  [InterestStatus.MEETING_BOOKED]: "meeting",
  [InterestStatus.NOT_INTERESTED]: "not_interested",
  [InterestStatus.WRONG_PERSON]: "wrong_person",
  [InterestStatus.OUT_OF_OFFICE]: "out_of_office",
};

const SYSTEM = `You sort replies to B2B outreach emails for a sales team before anyone answers them.
Read the prospect's newest message and pick the single category that fits best. Judge only what the prospect
wrote; ignore quoted earlier messages and signatures. A message written by a person is never "Automatic".
Return the exact category name, a confidence between 0 and 1, and one short sentence saying why.

Categories:
${CATEGORIES.map((c) => `- ${c.label}: ${c.description}`).join("\n")}`;

const schema = z.object({
  label: z.string().describe(`The category, exactly one of: ${CATEGORIES.map((c) => c.label).join(" | ")}`),
  confidence: z.number().describe("0 to 1"),
  reason: z.string().describe("One short sentence"),
});

/** Rules only: the clear cases, and the keyword fallback for the rest. */
export function classifyByRules(subject: string, newest: string, isAutoReply: boolean): ReplyClass {
  if (detectOptOut(subject, newest)) return { category: "unsubscribe", confidence: 0.95, reason: "Asks to stop the emails", method: "rules" };
  if (isAutoReply) {
    return isAbsenceNotice(subject, newest)
      ? { category: "out_of_office", confidence: 0.95, reason: "An out-of-office notice", method: "rules" }
      : { category: "automatic", confidence: 0.9, reason: "An automatic email", method: "rules" };
  }
  if (!newest.trim()) return { category: "other", confidence: 0, reason: "Nothing new in the message", method: "rules" };
  const r = ruleLabel(newest);
  const category = r ? RULE_CATEGORY[r.code] : undefined;
  return category ? { category, confidence: r!.confidence, reason: "Matched common reply wording", method: "rules" } : { category: "other", confidence: 0.3, reason: "No clear intent found", method: "rules" };
}

/** Sorts one received email. Uses the AI for anything the rules can't settle; the rules answer if the AI fails. */
export async function classifyIncoming(workspaceId: string, email: { subject: string; bodyText: string | null; bodyHtml: string | null; isAutoReply: number | boolean | null }): Promise<ReplyClass> {
  const newest = newestReplyText(email.bodyText || htmlToText(email.bodyHtml ?? ""));
  const rules = classifyByRules(email.subject, newest, !!email.isAutoReply);
  if (rules.confidence >= 0.9 || !newest.trim()) return rules;
  try {
    const out = await structured({
      workspaceId,
      feature: "inbox_manager_classify",
      effort: "low",
      maxTokens: 1_000,
      system: cachedSystem(SYSTEM),
      messages: [{ role: "user", content: `<subject>${email.subject.slice(0, 300)}</subject>\n<reply>\n${newest.slice(0, 8_000)}\n</reply>` }],
      schema,
    });
    const said = out.label.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const hit = CATEGORIES.find((c) => c.key === said || c.label.toLowerCase() === out.label.trim().toLowerCase());
    if (!hit) return rules;
    // A person's message isn't automatic, whatever the model says.
    if (hit.key === "automatic" && !email.isAutoReply) return rules;
    return { category: hit.key, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), reason: out.reason.trim().slice(0, 300), method: "ai" };
  } catch (err) {
    // A refusal or an outage: the rules decide, and a broken key still surfaces when the agent drafts.
    console.warn(`[inbox-manager] classifying a reply failed: ${(err as Error).message}`);
    return rules;
  }
}
