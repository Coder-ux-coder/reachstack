// Plan limits and usage. Self-hosted workspaces (no Stripe) are unlimited; hosted workspaces use
// the limits of their subscribed plans, or trial limits while the trial runs.
import { and, eq, gte, sql } from "drizzle-orm";
import { planById, type PlanLimits } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { uuidv7 } from "../lib/ids";
import { startOfMonthOn, workspaceZone } from "./workspace-clock";

export type ResolvedLimits = { [K in keyof Required<PlanLimits>]: number | null } & { self_hosted: boolean; on_trial: boolean; trial_expired: boolean };

const UNLIMITED: ResolvedLimits = {
  uploaded_contacts: null,
  monthly_emails: null,
  monthly_credits: null,
  email_accounts: null,
  identified_visitors: null,
  verification_credits: null,
  inbox_placement_tests: null,
  self_hosted: true,
  on_trial: false,
  trial_expired: false,
};

const TRIAL: PlanLimits = { uploaded_contacts: 250, monthly_emails: 1_000, email_accounts: null, monthly_credits: 100, identified_visitors: 50, verification_credits: 100, inbox_placement_tests: 5 };

export async function workspaceLimits(workspaceId: string): Promise<ResolvedLimits> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  if (!ws || ws.selfHosted) return UNLIMITED;
  const out: ResolvedLimits = {
    uploaded_contacts: 0,
    monthly_emails: 0,
    monthly_credits: 0,
    email_accounts: 0,
    identified_visitors: 0,
    verification_credits: 0,
    inbox_placement_tests: 0,
    self_hosted: false,
    on_trial: false,
    trial_expired: false,
  };
  const plans = Object.values(ws.planIds ?? {})
    .map((id) => planById(id))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const apply = (limits: PlanLimits) => {
    for (const [k, v] of Object.entries(limits) as Array<[keyof PlanLimits, number | null | undefined]>) {
      if (v === undefined) continue;
      const cur = out[k];
      out[k] = v === null || cur === null ? null : Math.max(cur, v);
    }
  };
  for (const p of plans) apply(p.limits);
  if (!plans.length) {
    const onTrial = !!ws.trialEndsAt && ws.trialEndsAt.getTime() > Date.now();
    out.on_trial = onTrial;
    out.trial_expired = !onTrial;
    if (onTrial) apply(TRIAL);
  }
  return out;
}

export async function monthlyEmailsSent(workspaceId: string): Promise<number> {
  // The month as the workspace's clock has it, like its other daily and monthly counts.
  const start = new Date(startOfMonthOn(await workspaceZone(workspaceId)));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.emailEvents)
    .where(and(eq(schema.emailEvents.workspaceId, workspaceId), eq(schema.emailEvents.type, "sent"), gte(schema.emailEvents.createdAt, start)));
  return Number(row?.n ?? 0);
}

export async function uploadedContacts(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${schema.leads.email})` })
    .from(schema.leads)
    .where(eq(schema.leads.workspaceId, workspaceId));
  return Number(row?.n ?? 0);
}

export async function creditBalance(workspaceId: string, pool: "credits" | "verification" | "visitors" = "credits"): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)` })
    .from(schema.creditLedger)
    .where(and(eq(schema.creditLedger.workspaceId, workspaceId), eq(schema.creditLedger.pool, pool)));
  return Number(row?.n ?? 0);
}

/**
 * Charges credits. Self-hosted workspaces are never charged (usage is still recorded at zero cost).
 * Returns false when the balance is insufficient.
 */
export async function chargeCredits(workspaceId: string, amount: number, reason: string, opts: { pool?: "credits" | "verification" | "visitors"; refId?: string | null; userId?: string | null } = {}): Promise<boolean> {
  const pool = opts.pool ?? "credits";
  const limits = await workspaceLimits(workspaceId);
  if (limits.self_hosted) return true;
  // The balance is read by the statement that takes the credits, so two charges at once can't spend the same credits.
  const res = await db.run(sql`insert into credit_ledger (id, workspace_id, pool, delta, reason, ref_id, user_id, created_at)
    select ${uuidv7()}, ${workspaceId}, ${pool}, ${-amount}, ${reason}, ${opts.refId ?? null}, ${opts.userId ?? null}, ${Date.now()}
    where (select coalesce(sum(delta), 0) from credit_ledger where workspace_id = ${workspaceId} and pool = ${pool}) >= ${amount}`);
  return res.rowsAffected > 0;
}

/** Returns credits for paid work that produced nothing. Self-hosted workspaces were never charged. Returns the amount. */
export async function refundCredits(workspaceId: string, amount: number, reason: string, opts: { pool?: "credits" | "verification" | "visitors"; refId?: string | null } = {}): Promise<number> {
  if (amount <= 0 || (await workspaceLimits(workspaceId)).self_hosted) return 0;
  await db.insert(schema.creditLedger).values({ workspaceId, pool: opts.pool ?? "credits", delta: amount, reason, refId: opts.refId ?? null, userId: null });
  return amount;
}
