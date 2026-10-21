// Custom variables of a workspace's leads (the keys of their payload): how many leads have each, an example value and
// the emails that use it; renaming one (into one that exists already, which merges them) and removing one from every
// lead. Renaming can change the emails that use it to match: campaign and subsequence steps (a new sequence version
// each) and templates.
import { and, eq, sql } from "drizzle-orm";
import { renameVariable, variableUses, type Sequence } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { Actor } from "./audit";
import { changeLeads, withVariable } from "./leads";
import { recordSequenceVersion } from "./sequence-versions";

const L = schema.leads;
const C = schema.campaigns;
const S = schema.subsequences;
const T = schema.emailTemplates;

/** An email that uses a variable: a campaign's steps, a subsequence's, or a template. */
export interface VariableUse {
  kind: "campaign" | "subsequence" | "template";
  id: string;
  name: string;
  /** The campaign a subsequence belongs to. */
  campaign_id: string | null;
}

const sequenceTexts = (seq: Sequence[] | null | undefined) => (seq ?? []).flatMap((s) => (s.steps ?? []).flatMap((st) => (st.variants ?? []).flatMap((v) => [v.subject ?? "", v.body ?? ""])));

const usedNames = (texts: string[]) => new Set(texts.flatMap((t) => (t.includes("{{") ? variableUses(t).map((u) => u.name.toLowerCase()) : [])));

/** Every email of a workspace with the variable names it uses, lowercased (a variable is found whatever its case). */
async function workspaceEmails(workspaceId: string) {
  const [campaigns, subsequences, templates] = await Promise.all([
    db.select({ id: C.id, name: C.name, sequences: C.sequences, updatedAt: C.updatedAt }).from(C).where(eq(C.workspaceId, workspaceId)),
    db.select({ id: S.id, name: S.name, campaignId: S.parentCampaignId, sequences: S.sequences, updatedAt: S.updatedAt }).from(S).where(eq(S.workspaceId, workspaceId)),
    db.select({ id: T.id, name: T.name, subject: T.subject, body: T.body }).from(T).where(eq(T.workspaceId, workspaceId)),
  ]);
  return {
    campaigns: campaigns.map((c) => ({ ...c, uses: usedNames(sequenceTexts(c.sequences)) })),
    subsequences: subsequences.map((s) => ({ ...s, uses: usedNames(sequenceTexts(s.sequences)) })),
    templates: templates.map((t) => ({ ...t, uses: usedNames([t.subject ?? "", t.body]) })),
  };
}

function usesOf(emails: Awaited<ReturnType<typeof workspaceEmails>>, name: string): VariableUse[] {
  const key = name.toLowerCase();
  return [
    ...emails.campaigns.filter((c) => c.uses.has(key)).map((c) => ({ kind: "campaign" as const, id: c.id, name: c.name, campaign_id: null })),
    ...emails.subsequences.filter((s) => s.uses.has(key)).map((s) => ({ kind: "subsequence" as const, id: s.id, name: s.name, campaign_id: s.campaignId })),
    ...emails.templates.filter((t) => t.uses.has(key)).map((t) => ({ kind: "template" as const, id: t.id, name: t.name, campaign_id: null })),
  ];
}

/** The workspace's custom variables, most used first: leads with a value, an example value and the emails using it. */
export async function listLeadVariables(workspaceId: string) {
  const rows = await db.all<{ name: string; leads: number; example: string | null }>(sql`
    select j.key as name,
      sum(case when j.type in ('text', 'integer', 'real', 'true', 'false') and length(trim(j.value)) > 0 then 1 else 0 end) as leads,
      max(case when j.type in ('text', 'integer', 'real') and length(trim(j.value)) > 0 then substr(trim(j.value), 1, 80) end) as example
    from ${L}, json_each(${L.payload}) j
    where ${L.workspaceId} = ${workspaceId}
    group by j.key
    order by leads desc, j.key
    limit 1000`);
  const emails = await workspaceEmails(workspaceId);
  return rows.filter((r) => r.name).map((r) => ({ name: r.name, leads: Number(r.leads), example: r.example === null ? null : String(r.example), used_in: usesOf(emails, r.name) }));
}

/** Ids of the workspace's leads that have this custom variable (with a value or not). */
export async function leadsWithVariable(workspaceId: string, name: string): Promise<string[]> {
  const rows = await db
    .select({ id: L.id })
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), sql`exists (select 1 from json_each(${L.payload}) j where j.key = ${name})`));
  return rows.map((r) => r.id);
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/**
 * Renames a custom variable on these leads: each lead's value moves to the new name, except where the lead already has
 * a value under it (that one stays), so renaming into an existing variable merges the two. With `emails`, the emails
 * that use the old name are changed to the new one; that happens once every lead has the value under both names, so a
 * campaign sending meanwhile finds it either way, and only then is the old name removed.
 */
export async function renameLeadVariable(
  o: { workspaceId: string; leadIds: string[]; from: string; to: string; emails: boolean; actor: Actor },
  onProgress?: (pct: number) => Promise<void>,
): Promise<{ leads: number; emails: number }> {
  const half = (start: number) => async (done: number) => onProgress?.(start + (done / Math.max(o.leadIds.length, 1)) * 50);
  await changeLeads(
    o.workspaceId,
    o.leadIds,
    (lead) => {
      const p = lead.payload;
      if (!p || !Object.hasOwn(p, o.from) || (Object.hasOwn(p, o.to) && !isEmpty(p[o.to]))) return {};
      return { payload: withVariable(p, o.to, p[o.from] ?? null) };
    },
    { onProgress: half(0) },
  );
  const emails = o.emails ? await renameInEmails(o.workspaceId, o.from, o.to, o.actor) : 0;
  await changeLeads(o.workspaceId, o.leadIds, (lead) => ({ payload: withVariable(lead.payload, o.from, null) }), { onProgress: half(50) });
  return { leads: o.leadIds.length, emails };
}

/** Removes a custom variable from these leads. */
export async function deleteLeadVariable(o: { workspaceId: string; leadIds: string[]; name: string }, onProgress?: (pct: number) => Promise<void>) {
  await changeLeads(o.workspaceId, o.leadIds, (lead) => ({ payload: withVariable(lead.payload, o.name, null) }), {
    onProgress: async (done) => onProgress?.((done / Math.max(o.leadIds.length, 1)) * 100),
  });
  return { leads: o.leadIds.length };
}

const renameInSequences = (seq: Sequence[], from: string, to: string): Sequence[] =>
  seq.map((s) => ({
    ...s,
    steps: (s.steps ?? []).map((st) => ({
      ...st,
      variants: (st.variants ?? []).map((v) => ({ ...v, subject: v.subject ? renameVariable(v.subject, from, to) : v.subject, body: v.body ? renameVariable(v.body, from, to) : v.body })),
    })),
  }));

/** Writes `{{to}}` for `{{from}}` in every email of the workspace that uses it; returns how many emails changed. */
async function renameInEmails(workspaceId: string, from: string, to: string, actor: Actor): Promise<number> {
  const emails = await workspaceEmails(workspaceId);
  const key = from.toLowerCase();
  let changed = 0;
  for (const c of emails.campaigns.filter((x) => x.uses.has(key))) {
    const after = renameInSequences(c.sequences, from, to);
    await db.update(C).set({ sequences: after }).where(eq(C.id, c.id));
    await recordSequenceVersion({ workspaceId, campaignId: c.id, before: c.sequences, after, beforeAt: c.updatedAt, actor });
    changed++;
  }
  for (const s of emails.subsequences.filter((x) => x.uses.has(key))) {
    const after = renameInSequences(s.sequences, from, to);
    await db.update(S).set({ sequences: after }).where(eq(S.id, s.id));
    await recordSequenceVersion({ workspaceId, campaignId: s.campaignId, subsequenceId: s.id, before: s.sequences, after, beforeAt: s.updatedAt, actor });
    changed++;
  }
  for (const t of emails.templates.filter((x) => x.uses.has(key))) {
    await db
      .update(T)
      .set({ subject: t.subject ? renameVariable(t.subject, from, to) : t.subject, body: renameVariable(t.body, from, to) })
      .where(eq(T.id, t.id));
    changed++;
  }
  return changed;
}
