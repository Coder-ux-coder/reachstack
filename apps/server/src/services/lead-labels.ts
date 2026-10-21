// Codes of custom lead labels: given out once, and taken out of everything that names one when its label goes.
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { CUSTOM_INTEREST_BASE } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { BlockTriggers } from "./blocklist";
import { getWorkspaceSetting, patchWorkspaceSettings } from "./workspaces";

type Kind = "positive" | "negative" | "neutral";

/** Workspace setting with the last code given out for each kind of label. */
const LAST_CODES = "label_codes_given";

const isKind = (kind: Kind, v: number) =>
  kind === "positive" ? v >= CUSTOM_INTEREST_BASE.positive && v < CUSTOM_INTEREST_BASE.neutral : kind === "neutral" ? v >= CUSTOM_INTEREST_BASE.neutral : v <= CUSTOM_INTEREST_BASE.negative;

/** Custom label codes something still names, for workspaces whose labels were deleted before codes were kept. */
async function codesNamed(wsId: string): Promise<number[]> {
  const E = schema.emails;
  const custom = or(sql`${E.interestStatus} >= ${CUSTOM_INTEREST_BASE.positive}`, sql`${E.interestStatus} <= ${CUSTOM_INTEREST_BASE.negative}`);
  const inEmails = await db.selectDistinct({ v: E.interestStatus }).from(E).where(and(eq(E.workspaceId, wsId), isNotNull(E.interestStatus), custom));
  const triggers = await getWorkspaceSetting<BlockTriggers | null>(wsId, "blocklist_triggers", null);
  const subs = await db.select({ c: schema.subsequences.conditions }).from(schema.subsequences).where(eq(schema.subsequences.workspaceId, wsId));
  return [...inEmails.map((r) => r.v!), ...(triggers?.statuses ?? []), ...subs.flatMap((s) => s.c?.crm_status ?? [])];
}

/**
 * The code for a new custom label of this kind. A code is never given out twice, even once its label is deleted: an
 * automation, an old email or an export may still name it, and it mustn't come to mean another label.
 */
export async function nextLabelCode(wsId: string, kind: Kind): Promise<number> {
  const given = await getWorkspaceSetting<Partial<Record<Kind, number>>>(wsId, LAST_CODES, {});
  const labels = await db.select({ v: schema.leadLabels.interestStatus }).from(schema.leadLabels).where(eq(schema.leadLabels.workspaceId, wsId));
  const codes = [...labels.map((r) => r.v), ...(given[kind] !== undefined ? [given[kind]!] : await codesNamed(wsId))].filter((v) => isKind(kind, v));
  const code =
    kind === "negative" ? Math.min(CUSTOM_INTEREST_BASE.negative + 1, ...codes) - 1 : Math.max(CUSTOM_INTEREST_BASE[kind] - 1, ...codes) + 1;
  await patchWorkspaceSettings(wsId, { [LAST_CODES]: { ...given, [kind]: code } });
  return code;
}

/**
 * A deleted label's leads and conversations go back to no label, and a blocklist trigger or subsequence that started
 * on it no longer names it.
 */
export async function retireLabelCode(wsId: string, code: number) {
  await db.update(schema.leads).set({ interestStatus: null, interestSynced: false }).where(and(eq(schema.leads.workspaceId, wsId), eq(schema.leads.interestStatus, code)));
  await db.update(schema.emails).set({ interestStatus: null }).where(and(eq(schema.emails.workspaceId, wsId), eq(schema.emails.interestStatus, code)));
  const triggers = await getWorkspaceSetting<BlockTriggers | null>(wsId, "blocklist_triggers", null);
  if (triggers?.statuses?.includes(code)) await patchWorkspaceSettings(wsId, { blocklist_triggers: { ...triggers, statuses: triggers.statuses.filter((s) => s !== code) } });
  const S = schema.subsequences;
  const subs = (await db.select({ id: S.id, conditions: S.conditions }).from(S).where(eq(S.workspaceId, wsId))).filter((s) => s.conditions?.crm_status?.includes(code));
  for (const s of subs) await db.update(S).set({ conditions: { ...s.conditions, crm_status: s.conditions.crm_status!.filter((v) => v !== code) } }).where(eq(S.id, s.id));
  // Its deals leave the pipeline with their leads (no status), and sales flows stop filtering on it.
  await db.update(schema.crmOpportunities).set({ stage: 0 }).where(and(eq(schema.crmOpportunities.workspaceId, wsId), eq(schema.crmOpportunities.stage, code)));
  const F = schema.salesFlows;
  const named = (q: { actionType: string; values: Record<string, unknown> }) => (q.values?.["lead-status"] as { status?: number } | undefined)?.status === code;
  for (const f of await db.select({ id: F.id, queries: F.queries }).from(F).where(eq(F.workspaceId, wsId))) {
    if (f.queries.some(named)) await db.update(F).set({ queries: f.queries.filter((q) => !named(q)) }).where(eq(F.id, f.id));
  }
}
