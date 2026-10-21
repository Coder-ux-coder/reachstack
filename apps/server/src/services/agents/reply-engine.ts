// Writes the next message in an email thread on behalf of an agent (Inbox Manager, Sales Agent), with a
// confidence score and a hand-off flag for conversations a person should take over.
import { asc, eq } from "drizzle-orm";
import * as z from "zod/v4";
import { DEFAULT_INTEREST_STATUSES, EmailType } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { newestReplyText } from "../../mail/reply-text";
import { cachedSystem, structured } from "../ai";
import { chronological } from "../unibox";
import { cleanReplyHtml, textToParagraphs } from "./common";

export type ReplyDecision = "reply" | "request_info" | "no_reply";

export interface ReplyDraft {
  decision: ReplyDecision;
  html: string;
  confidence: number; // 0-100
  needsHuman: boolean;
  humanReason: string | null;
  informationRequested: string | null;
  usedBookingLink: boolean;
}

export interface ThreadMessage {
  from: "lead" | "us";
  date: string;
  subject: string;
  text: string;
}

/** Drops quoted history and signatures so each message is only what that person wrote. */
export function newestPart(text: string): string {
  return newestReplyText(text).slice(0, 4_000);
}

/** The last messages of a thread, oldest first. */
export async function threadMessages(threadId: string | null, fallbackEmailId: string, limit = 8): Promise<ThreadMessage[]> {
  const E = schema.emails;
  const rows = threadId
    ? await db.select().from(E).where(eq(E.threadId, threadId)).orderBy(asc(E.timestampEmail))
    : await db.select().from(E).where(eq(E.id, fallbackEmailId));
  return rows
    .filter((r) => r.ueType !== EmailType.SCHEDULED)
    .sort(chronological)
    .slice(-limit)
    .map((r) => ({
      from: r.ueType === EmailType.RECEIVED ? "lead" : "us",
      date: r.timestampEmail.toISOString().slice(0, 16).replace("T", " "),
      subject: r.subject,
      text: newestPart(r.bodyText || r.bodyHtml.replace(/<[^>]+>/g, " ")),
    }));
}

const SYSTEM = `You are an email assistant that answers prospects on behalf of a salesperson. You write the next
message in an existing email thread.

Ground rules:
- Only state facts found in the business context, the knowledge base or the thread. Never invent prices,
  features, customers, results, availability or commitments. If the prospect asks something you cannot
  answer from what you have, choose "request_info" and say exactly what you need to know.
- Answer the newest message from the prospect. Keep the thread's language.
- When the prospect wants to talk and a booking link is provided, offer the link; otherwise ask which times
  suit them. Do not propose specific times you cannot confirm.
- If the prospect asks to stop, unsubscribe or be removed, choose "no_reply".
- If the prospect declines, follow the objection guidance when it is provided; otherwise close politely in one
  or two sentences without pushing.
- Set needs_human for pricing negotiations, contracts, legal or compliance questions, complaints, angry
  prospects, or anything sensitive. A person will review those.
- Write plain text paragraphs with no subject line, no placeholders and no markdown. Sign with the
  salesperson's first name only.

Confidence is 0-100: how safe it is to send your reply without anyone reviewing it.`;

const draftSchema = z.object({
  decision: z.string().describe("Exactly one of: reply, request_info, no_reply"),
  reply_text: z.string().describe("The email body as plain text paragraphs. Empty when decision is no_reply."),
  confidence: z.number().describe("0 to 100"),
  needs_human: z.boolean(),
  human_reason: z.string().describe("Short reason when needs_human is true, otherwise empty"),
  information_requested: z.string().describe("For request_info: the question for the salesperson, otherwise empty"),
  used_booking_link: z.boolean().describe("True when the reply includes the booking link"),
});

export interface DraftInput {
  workspaceId: string;
  feature: string;
  agentName: string;
  guidance: { text: string; tone: string; length: string };
  context: string;
  extraInstructions?: string;
  bookingLink?: string | null;
  thread: ThreadMessage[];
  lead: { first_name?: string | null; last_name?: string | null; company_name?: string | null; job_title?: string | null; email?: string | null; interest_status?: number | null };
  sender: { name: string; email: string };
  mode?: { kind: "reply" } | { kind: "followup"; number: number; daysSinceLast: number } | { kind: "no_show"; number: number };
}

export async function draftReply(input: DraftInput): Promise<ReplyDraft> {
  const status = DEFAULT_INTEREST_STATUSES.find((s) => s.code === input.lead.interest_status)?.label ?? "Not labelled";
  const mode = input.mode ?? { kind: "reply" };
  const task =
    mode.kind === "followup"
      ? `Write follow-up #${mode.number}: the prospect has not answered our last message for ${mode.daysSinceLast} days. Add something useful in a sentence or two and make it easy to reply; do not repeat the earlier message or guilt them.`
      : mode.kind === "no_show"
        ? `The prospect missed the meeting they booked (no-show #${mode.number}). Write a short, friendly note that assumes good intent and offers to reschedule${input.bookingLink ? " with the booking link" : ""}.`
        : "Reply to the prospect's newest message.";
  const user = [
    `<task>\n${task}\n</task>`,
    `<style>\nTone: ${input.guidance.tone}. Length: ${input.guidance.length}.\n</style>`,
    input.guidance.text ? `<guidance>\n${input.guidance.text}\n</guidance>` : "",
    input.extraInstructions ? `<instructions>\n${input.extraInstructions}\n</instructions>` : "",
    `<business_context>\n${input.context || "(none provided: do not describe the offer beyond what the thread says)"}\n</business_context>`,
    input.bookingLink ? `<booking_link>${input.bookingLink}</booking_link>` : "",
    `<salesperson>\nName: ${input.sender.name}\nEmail: ${input.sender.email}\n</salesperson>`,
    `<prospect>\n${JSON.stringify({ ...input.lead, interest_status: status })}\n</prospect>`,
    `<thread>\n${input.thread.map((m) => `[${m.date}] ${m.from === "lead" ? "PROSPECT" : "US"} — ${m.subject}\n${m.text}`).join("\n\n")}\n</thread>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await structured({
    workspaceId: input.workspaceId,
    feature: input.feature,
    effort: "medium",
    maxTokens: 4_000,
    system: cachedSystem(SYSTEM),
    messages: [{ role: "user", content: user }],
    schema: draftSchema,
  });
  const decision: ReplyDecision = (["reply", "request_info", "no_reply"] as const).find((d) => d === out.decision.trim().toLowerCase()) ?? "request_info";
  const text = out.reply_text.trim();
  return {
    decision: decision === "reply" && !text ? "request_info" : decision,
    html: text ? cleanReplyHtml(textToParagraphs(text)) : "",
    confidence: Math.max(0, Math.min(100, Math.round(out.confidence))),
    needsHuman: out.needs_human,
    humanReason: out.human_reason.trim() || null,
    informationRequested: out.information_requested.trim() || null,
    usedBookingLink: out.used_booking_link && !!input.bookingLink && text.includes(input.bookingLink),
  };
}
