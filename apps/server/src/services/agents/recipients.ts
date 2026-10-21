// Who the AI agents may write to: the people a campaign may email, checked against every address an email goes to (a
// reply goes to whoever wrote, which isn't always the lead's address on file).
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { blockedSet } from "../leads";
import { suppressedValues } from "../privacy";

export type RecipientRefusal = "blocked" | "unsubscribed" | "bounced";

/**
 * Why an agent may not email these addresses: on the blocklist (or barred from every campaign for reporting one of
 * this installation's emails as abuse), unsubscribed from the workspace or from the conversation's campaign, or, for
 * an email the agent writes unprompted (a follow-up, a no-show win-back), hard-bounced before. Null when it may.
 */
export async function recipientRefusal(
  workspaceId: string,
  addresses: Array<string | null | undefined>,
  opts: { campaignId?: string | null; unprompted?: boolean } = {},
): Promise<RecipientRefusal | null> {
  const emails = [...new Set(addresses.map((x) => (x ?? "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return null;
  if ((await blockedSet(workspaceId, emails)).size || (await suppressedValues("email", emails, true)).size) return "blocked";
  const U = schema.unsubscribes;
  const [unsubscribed] = await db
    .select({ id: U.id })
    .from(U)
    .where(and(eq(U.workspaceId, workspaceId), inArray(U.email, emails)))
    .limit(1);
  if (unsubscribed) return "unsubscribed";
  const S = schema.leadSuppressions;
  const kinds = [opts.campaignId ? and(eq(S.reason, "unsubscribed"), eq(S.campaignId, opts.campaignId)) : undefined, opts.unprompted ? eq(S.reason, "bounced") : undefined].filter(
    (k): k is SQL => !!k,
  );
  if (!kinds.length) return null;
  const rows = await db
    .select({ reason: S.reason })
    .from(S)
    .where(and(eq(S.workspaceId, workspaceId), inArray(S.email, emails), or(...kinds)));
  if (rows.some((r) => r.reason === "unsubscribed")) return "unsubscribed";
  return rows.length ? "bounced" : null;
}
