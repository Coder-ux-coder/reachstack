// Sequence version history: every saved state of a campaign's or subsequence's sequence, with who saved it and when.
// The newest version is the current sequence, so whatever a change replaces is always kept. The last 50 per sequence
// stay. Restoring one saves its steps again as a new version (routes/sequence-versions.ts).
import { and, desc, eq, isNull, notInArray, type SQL } from "drizzle-orm";
import type { Sequence } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { iso } from "../lib/time";
import type { Actor } from "./audit";

export const MAX_VERSIONS = 50;
const V = schema.sequenceVersions;
export type VersionRow = typeof V.$inferSelect;
export type VersionSource = "edit" | "create" | "restore" | "agent" | "earlier";

/** Whose sequence: a campaign's own (no subsequenceId) or one of its subsequences. */
export interface SequenceOwner {
  workspaceId: string;
  campaignId: string;
  subsequenceId?: string | null;
}

const ownerConds = (o: SequenceOwner): SQL[] => [eq(V.workspaceId, o.workspaceId), eq(V.campaignId, o.campaignId), o.subsequenceId ? eq(V.subsequenceId, o.subsequenceId) : isNull(V.subsequenceId)];

const visibleText = (html: string | undefined) =>
  (html ?? "")
    .replace(/<(?!img\b)[^>]*>/gi, " ")
    .replace(/&nbsp;| /g, " ")
    .trim();

/** The steps in one canonical form, so saving the same sequence again doesn't count as a change. */
export function sequenceKey(seq: Sequence[] | null | undefined): string {
  return JSON.stringify(
    (seq ?? []).map((s) =>
      (s.steps ?? []).map((st) => [
        st.delay ?? 0,
        st.delay_unit ?? "days",
        st.pre_delay ?? 0,
        st.pre_delay ? (st.pre_delay_unit ?? "days") : null,
        (st.variants ?? []).map((v) => [v.subject ?? "", v.body ?? "", !!v.v_disabled]),
        // Task steps only, so the key of a sequence of emails stays what it always was.
        ...(st.type === "task" ? [st.task ?? null] : []),
      ]),
    ),
  );
}

/** Nothing written yet (a new campaign's blank first step): not worth keeping as a version. */
export function isBlankSequence(seq: Sequence[] | null | undefined): boolean {
  return !(seq ?? []).some((s) => (s.steps ?? []).some((st) => (st.variants ?? []).some((v) => (v.subject ?? "").trim() || visibleText(v.body))));
}

/** "3 steps, 5 variants, 1 task", and the first subject so a version is easy to recognise. */
export function summarizeSequence(seq: Sequence[]) {
  const steps = seq[0]?.steps ?? [];
  const emails = steps.filter((s) => s.type !== "task");
  const tasks = steps.length - emails.length;
  const variants = emails.reduce((sum, s) => sum + (s.variants?.length ?? 0), 0);
  const count = (x: number, word: string) => `${x} ${word}${x === 1 ? "" : "s"}`;
  return {
    steps: steps.length,
    variants,
    // "3 steps, 5 variants"; with tasks, "3 steps: 1 email, 2 tasks" (and the variants when an email has more than one).
    summary: tasks
      ? `${count(steps.length, "step")}: ${count(emails.length, "email")}${variants > emails.length ? ` (${count(variants, "variant")})` : ""}, ${count(tasks, "task")}`
      : `${count(steps.length, "step")}, ${count(variants, "variant")}`,
    first_subject: emails[0]?.variants?.find((v) => v.subject?.trim())?.subject?.trim() ?? null,
  };
}

/**
 * Keeps a change to a sequence. Call it once the new steps are saved: `before` is what the sequence held until now and
 * `after` what it holds now. When `before` isn't the newest version (a campaign from before versions were kept), it's
 * kept too, so every change can be undone.
 */
export async function recordSequenceVersion(
  o: SequenceOwner & { before: Sequence[] | null; after: Sequence[]; actor: Actor; source?: VersionSource; restoredFrom?: string | null; beforeAt?: Date | null },
): Promise<void> {
  if (o.before && sequenceKey(o.before) === sequenceKey(o.after)) return;
  const owner = { workspaceId: o.workspaceId, campaignId: o.campaignId, subsequenceId: o.subsequenceId ?? null };
  const [latest] = await db
    .select()
    .from(V)
    .where(and(...ownerConds(o)))
    .orderBy(desc(V.createdAt), desc(V.id))
    .limit(1);
  const now = Date.now();
  // Ids made in the same millisecond don't sort in order, so each new version is stamped after the newest one.
  let next = (latest?.createdAt.getTime() ?? 0) + 1;
  if (o.before && !isBlankSequence(o.before) && (!latest || sequenceKey(latest.sequences) !== sequenceKey(o.before))) {
    // Saved some time before this change; when exactly isn't known, so it's the last time the owner changed.
    const at = Math.max(next, Math.min(o.beforeAt?.getTime() ?? now, now));
    await db.insert(V).values({ ...owner, sequences: o.before, source: "earlier", createdAt: new Date(at) });
    next = at + 1;
  }
  if (!isBlankSequence(o.after)) {
    await db.insert(V).values({
      ...owner,
      sequences: o.after,
      source: o.source ?? "edit",
      createdBy: o.actor.userId,
      createdByName: o.actor.name,
      restoredFrom: o.restoredFrom ?? null,
      createdAt: new Date(Math.max(now, next)),
    });
  }
  const keep = await db
    .select({ id: V.id })
    .from(V)
    .where(and(...ownerConds(o)))
    .orderBy(desc(V.createdAt), desc(V.id))
    .limit(MAX_VERSIONS);
  if (keep.length === MAX_VERSIONS) {
    await db.delete(V).where(
      and(
        ...ownerConds(o),
        notInArray(
          V.id,
          keep.map((k) => k.id),
        ),
      ),
    );
  }
}

/** Newest first. The newest is marked current when it matches what the sequence holds now. */
export async function listSequenceVersions(o: SequenceOwner, current: Sequence[]) {
  const rows = await db
    .select()
    .from(V)
    .where(and(...ownerConds(o)))
    .orderBy(desc(V.createdAt), desc(V.id))
    .limit(MAX_VERSIONS);
  const when = new Map(rows.map((r) => [r.id, r.createdAt]));
  const currentKey = sequenceKey(current);
  return rows.map((r, i) => serializeVersion(r, { current: i === 0 && sequenceKey(r.sequences) === currentKey, restoredFromAt: r.restoredFrom ? (when.get(r.restoredFrom) ?? null) : null }));
}

export async function findSequenceVersion(o: SequenceOwner, id: string): Promise<VersionRow | null> {
  const [row] = await db
    .select()
    .from(V)
    .where(and(...ownerConds(o), eq(V.id, id)))
    .limit(1);
  return row ?? null;
}

export function serializeVersion(r: VersionRow, extra: { current?: boolean; restoredFromAt?: Date | null; withSteps?: boolean } = {}) {
  return {
    id: r.id,
    created_at: iso(r.createdAt),
    created_by_name: r.createdByName,
    source: r.source as VersionSource,
    restored_from: r.restoredFrom,
    restored_from_at: iso(extra.restoredFromAt ?? null),
    current: !!extra.current,
    ...summarizeSequence(r.sequences),
    ...(extra.withSteps ? { sequences: r.sequences } : {}),
  };
}
