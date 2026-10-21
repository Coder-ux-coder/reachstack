// Why a campaign's emails bounced: by reason, mailbox and step, from the bounce events (value 1 = hard bounce) and
// the code and reason each one keeps in `detail` ("550 · 550 5.1.1 <x>: user unknown").
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/client";
import { iso } from "../lib/time";
import type { DateRange } from "./workspace-clock";

const E = schema.emailEvents;

/**
 * A try the receiving server refused at once (engine/sender.ts): a bounce of an email that was never sent, so it has a
 * step but no email. A bounce notice the app couldn't match to an email it sent has neither, and isn't a try.
 */
export const refusedAtSend = sql`${E.type} = 'bounce' and ${E.emailId} is null and ${E.step} is not null`;

/** Hard bounces as a percent of the emails tried, one decimal. Never over 100: a bounce can arrive for a try made before the period. */
export function bounceRate(bounced: number, tried: number): number {
  const whole = Math.max(tried, bounced);
  return whole ? Math.round((bounced / whole) * 1000) / 10 : 0;
}

export type BounceReason = "no_address" | "domain" | "mailbox_full" | "blocked" | "server" | "temporary" | "other" | "unrecorded";

export const BOUNCE_REASON_LABELS: Record<BounceReason, string> = {
  no_address: "Address doesn't exist",
  domain: "Domain doesn't take mail",
  mailbox_full: "Mailbox full",
  blocked: "Blocked as spam or by policy",
  server: "Receiving server problem",
  temporary: "Temporary failure",
  other: "Other",
  unrecorded: "No reason recorded",
};

/** Sorts a bounce into a reason by its enhanced status code (5.1.1…), falling back to the server's words. */
export function bounceReason(detail: string | null, hard: boolean): BounceReason {
  // Bounces from before 2026-10-15 kept no code or reason.
  if (!detail?.trim()) return "unrecorded";
  const text = detail.toLowerCase();
  const code = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? "";
  // A policy code wins over the words: "5.7.1 Recipient address rejected: Access denied" is a block (mail/refusals.ts).
  if (code.startsWith("5.7.")) return "blocked";
  if (code === "5.1.2" || code === "5.1.10" || /domain not found|host not found|no mx|unrouteable|nxdomain|no such domain/.test(text)) return "domain";
  if (code.startsWith("5.1.") || /user unknown|no such user|does not exist|address not found|unknown recipient|invalid recipient|recipient address rejected|mailbox unavailable|no mailbox/.test(text)) return "no_address";
  if (code === "5.2.2" || code === "4.2.2" || /quota|mailbox full|mailbox is full|insufficient storage/.test(text)) return "mailbox_full";
  if (code.startsWith("5.7.") || /spam|blocked|block list|blocklist|blacklist|policy|reputation|dmarc|not authorized|denied/.test(text)) return "blocked";
  if (/^5\.[345]\./.test(code)) return "server";
  if (!hard || code.startsWith("4.")) return "temporary";
  return "other";
}

/** The diagnostic part of a stored detail, without the leading status. */
const diagnosticOf = (detail: string | null) => (detail?.includes(" · ") ? detail.slice(detail.indexOf(" · ") + 3) : (detail ?? ""));
const codeOf = (detail: string | null) => /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(detail ?? "")?.[1] ?? /\b([45]\d\d)\b/.exec(detail ?? "")?.[1] ?? null;

export async function campaignBounceReport(campaignId: string, range: DateRange, limit = 500) {
  const conds: SQL[] = [eq(E.campaignId, campaignId)];
  if (range.start !== undefined) conds.push(gte(E.createdAt, new Date(range.start)));
  if (range.end !== undefined) conds.push(lte(E.createdAt, new Date(range.end)));
  const hard = sql<number>`sum(case when ${E.type} = 'bounce' and ${E.value} = 1 then 1 else 0 end)`;
  const soft = sql<number>`sum(case when ${E.type} = 'bounce' and coalesce(${E.value}, 0) <> 1 then 1 else 0 end)`;
  const sent = sql<number>`sum(case when ${E.type} = 'sent' then 1 else 0 end)`;
  const refused = sql<number>`sum(case when ${refusedAtSend} then 1 else 0 end)`;

  const [[all], mailboxRows, stepRows, events] = await Promise.all([
    db.select({ hard, soft }).from(E).where(and(...conds)),
    db
      .select({ email: E.accountEmail, sent, refused, hard, soft })
      .from(E)
      .where(and(...conds))
      .groupBy(E.accountEmail),
    db
      .select({ step: E.step, sent, refused, hard, soft })
      .from(E)
      .where(and(...conds, isNull(E.subsequenceId)))
      .groupBy(E.step),
    db
      .select()
      .from(E)
      .where(and(...conds, eq(E.type, "bounce")))
      .orderBy(desc(E.createdAt))
      .limit(Math.min(limit, 5_000)),
  ]);

  const reasons = new Map<BounceReason, { hard: number; soft: number }>();
  const items = events.map((e) => {
    const isHard = e.value === 1;
    const reason = bounceReason(e.detail, isHard);
    const r = reasons.get(reason) ?? { hard: 0, soft: 0 };
    r[isHard ? "hard" : "soft"]++;
    reasons.set(reason, r);
    return {
      lead_email: e.leadEmail,
      type: isHard ? ("hard" as const) : ("soft" as const),
      reason,
      reason_label: BOUNCE_REASON_LABELS[reason],
      code: codeOf(e.detail),
      diagnostic: diagnosticOf(e.detail) || null,
      mailbox: e.accountEmail,
      step: e.step,
      subsequence_id: e.subsequenceId,
      timestamp: iso(e.createdAt),
    };
  });
  return {
    // Every bounce in the range; reasons and the list cover the newest `limit` (see `complete`), the mailbox and step
    // counts cover them all. `tried`: emails sent, and tries the receiving server refused at once (never sent, yet bounced).
    totals: { hard: Number(all?.hard ?? 0), soft: Number(all?.soft ?? 0) },
    complete: events.length < Math.min(limit, 5_000),
    reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, label: BOUNCE_REASON_LABELS[reason], ...n })).sort((a, b) => b.hard + b.soft - (a.hard + a.soft)),
    mailboxes: mailboxRows
      .filter((r) => r.email && (Number(r.hard) || Number(r.soft)))
      .map((r) => {
        const tried = Number(r.sent) + Number(r.refused);
        return { email: r.email!, sent: Number(r.sent), tried, hard: Number(r.hard), soft: Number(r.soft), hard_rate: bounceRate(Number(r.hard), tried) };
      })
      .sort((a, b) => b.hard_rate - a.hard_rate || b.hard - a.hard),
    steps: stepRows
      .filter((r) => r.step !== null && (Number(r.hard) || Number(r.soft)))
      .map((r) => ({ step: r.step!, sent: Number(r.sent), tried: Number(r.sent) + Number(r.refused), hard: Number(r.hard), soft: Number(r.soft) }))
      .sort((a, b) => a.step - b.step),
    items,
  };
}
