// Recently deleted. Deleting a campaign, a lead list, leads, a template or a subsequence moves the rows the delete takes
// out of the live tables into deleted_items (one entry per delete) and deleted_item_rows (the rows exactly as stored,
// as gzipped JSON, a few hundred per chunk). Nothing else in the app has to skip deleted rows, because they're simply
// not there any more, and for 30 days an entry can be put back as it was, ids included. The "recently-deleted" engine
// loop removes older entries for good. Emails (Unibox threads) are never part of a delete: they stay, so a restored
// campaign or lead finds its conversations again.
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { CampaignStatus, canWrite, roleAllows, type Permission } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { AuthContext } from "../http/context";
import { conflict, notFound, paymentRequired } from "../http/errors";
import { chunk } from "../http/util";
import { iso } from "../lib/time";
import { AgentStatus, AgentType, logAgentEvent } from "./agents/common";
import type { Actor } from "./audit";
import { uploadedContacts, workspaceLimits } from "./billing-limits";
import { effectivePermissions } from "./branding";
import type { CampaignRow, SubsequenceRow } from "./campaigns";

export const RETENTION_DAYS = 30;
const DAY = 86_400_000;
/** An entry still "deleting" that moved nothing for this long belongs to a delete that stopped half-way: what it holds can come back. */
const STALLED_MS = 10 * 60_000;
/** Where leads go when their campaign or list is gone for good, or already has someone with the same address. */
export const RESTORED_LIST_NAME = "Restored leads";

const D = schema.deletedItems;
const R = schema.deletedItemRows;
const L = schema.leads;

export const DELETED_KINDS = ["campaign", "lead_list", "leads", "template", "subsequence"] as const;
export type DeletedKind = (typeof DELETED_KINDS)[number];
export type DeletedEntry = typeof D.$inferSelect;
type Row = Record<string, unknown>;

/** The tables a delete takes rows from, by their name in the database. */
const TABLES = {
  campaigns: schema.campaigns,
  subsequences: schema.subsequences,
  leads: schema.leads,
  lead_lists: schema.leadLists,
  email_events: schema.emailEvents,
  custom_tag_mappings: schema.customTagMappings,
  email_templates: schema.emailTemplates,
  sequence_versions: schema.sequenceVersions,
};
type TableName = keyof typeof TABLES;
/** Not a table: where each lead in a deleted subsequence was in it, put back when the subsequence comes back. */
const LEAD_STATE = "lead_subsequence_state";

const pack = promisify(gzip);
const unpack = promisify(gunzip);
const all = (...conds: SQL[]) => and(...conds)!;
/** `"id" in (…)` for any of the tables above. */
const idIn = (ids: string[]) =>
  sql`"id" in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
const fmt = new Intl.NumberFormat("en-US");
const count = (x: number, word: string, words = `${word}s`) => `${fmt.format(x)} ${x === 1 ? word : words}`;

// ---------- Who may see and restore what ----------

/** Restoring, or deleting for good, needs what deleting that kind of item needs. */
function needs(kind: string, meta: Row | null): { view: Permission | null; manage: Permission; write: boolean } {
  if (kind === "leads" || kind === "lead_list") return { view: "leads", manage: "leads", write: true };
  // Reply templates belong to the Unibox (view members write them); email templates to campaign editing.
  if (kind === "template") return meta?.reply ? { view: null, manage: "unibox", write: false } : { view: null, manage: "edit_campaigns", write: true };
  return { view: "view_campaigns", manage: "edit_campaigns", write: true };
}

function allows(a: AuthContext, perm: Permission | null, write: boolean): boolean {
  if (!a.role) return false;
  if (write && !canWrite(a.role)) return false;
  return !perm || roleAllows(a.role, perm, effectivePermissions(a.workspace, a.member));
}

export function canManageDeleted(a: AuthContext, e: Pick<DeletedEntry, "kind" | "meta">): boolean {
  const n = needs(e.kind, e.meta);
  return allows(a, n.manage, n.write);
}

/** Kinds a member may see in the list: the same people who can see campaigns, or leads, see them deleted. */
function visibleKinds(a: AuthContext): DeletedKind[] {
  return DELETED_KINDS.filter((k) => allows(a, needs(k, null).view, false));
}

// ---------- Deleting ----------

/** Fills one entry. Each chunk is stored and taken out of its table in one transaction, so no row is lost or doubled. */
class Writer {
  private seq = 0;
  bytes = 0;
  constructor(readonly entryId: string) {}

  private async stored(table: string, rows: Row[]) {
    const data = await pack(Buffer.from(JSON.stringify(rows)));
    this.bytes += data.length;
    return { entryId: this.entryId, seq: this.seq++, tableName: table, rowCount: rows.length, data };
  }

  /** With every chunk: the delete is still going (see isReady). */
  private alive() {
    return db.update(D).set({ movedAt: new Date() }).where(eq(D.id, this.entryId));
  }

  /** Moves the rows matching `where` out of a table, `size` at a time. Returns how many moved. */
  async move(name: TableName, where: SQL, opts: { size?: number; seen?: (rows: Row[]) => void } = {}): Promise<number> {
    const table = TABLES[name];
    let moved = 0;
    for (;;) {
      const rows = await db.all<Row>(sql`select * from ${table} where ${where} limit ${opts.size ?? 500}`);
      if (!rows.length) return moved;
      opts.seen?.(rows);
      const chunkRow = await this.stored(name, rows);
      await db.batch([db.insert(R).values(chunkRow), db.run(sql`delete from ${table} where ${idIn(rows.map((r) => String(r.id)))}`), this.alive()]);
      moved += rows.length;
    }
  }

  /** Lets the leads in a subsequence go (as deleting one always did), keeping where each one was in it. */
  async release(sub: SubsequenceRow): Promise<number> {
    let released = 0;
    for (;;) {
      const leads = await db
        .select({ id: L.id, subseqStatus: L.subseqStatus, subseqNextStep: L.subseqNextStep, subseqNextSendAt: L.subseqNextSendAt })
        .from(L)
        .where(all(eq(L.workspaceId, sub.workspaceId), eq(L.subsequenceId, sub.id)))
        .limit(500);
      if (!leads.length) return released;
      const rows = leads.map((l) => ({ id: l.id, subseq_status: l.subseqStatus, subseq_next_step: l.subseqNextStep, subseq_next_send_at: l.subseqNextSendAt }));
      const chunkRow = await this.stored(LEAD_STATE, rows);
      await db.batch([
        db.insert(R).values(chunkRow),
        db
          .update(L)
          .set({ subsequenceId: null, subseqStatus: null, subseqNextSendAt: null, subseqNextStep: 0 })
          .where(
            inArray(
              L.id,
              leads.map((l) => l.id),
            ),
          ),
        this.alive(),
      ]);
      released += leads.length;
    }
  }
}

async function openEntry(workspaceId: string, kind: DeletedKind, itemId: string | null, name: string, actor: Actor, meta: Row | null = null): Promise<Writer> {
  const [row] = await db
    .insert(D)
    .values({ workspaceId, kind, itemId, name, counts: {}, meta, deletedBy: actor.userId, deletedByName: actor.name, expiresAt: new Date(Date.now() + RETENTION_DAYS * DAY) })
    .returning({ id: D.id });
  return new Writer(row!.id);
}

async function closeEntry(w: Writer, counts: Record<string, number>, extra: { name?: string; meta?: Row } = {}) {
  await db
    .update(D)
    .set({ status: "ready", counts, bytes: w.bytes, ...extra })
    .where(eq(D.id, w.entryId));
}

/** A campaign with everything that belongs to it: leads, subsequences, analytics events, tags and sequence versions. */
export async function trashCampaign(c: CampaignRow, actor: Actor): Promise<string> {
  const ws = c.workspaceId;
  const { campaigns: C, subsequences: S, email_events: E, custom_tag_mappings: TM, sequence_versions: V } = TABLES;
  const w = await openEntry(ws, "campaign", c.id, c.name, actor);
  // The campaign goes first, so the sender stops picking it up while the rest moves.
  await w.move("campaigns", all(eq(C.workspaceId, ws), eq(C.id, c.id)));
  const subsequences = await w.move("subsequences", all(eq(S.workspaceId, ws), eq(S.parentCampaignId, c.id)));
  const leads = await w.move("leads", all(eq(L.workspaceId, ws), eq(L.campaignId, c.id)));
  const events = await w.move("email_events", all(eq(E.workspaceId, ws), eq(E.campaignId, c.id)), { size: 2000 });
  await w.move("custom_tag_mappings", all(eq(TM.workspaceId, ws), eq(TM.resourceId, c.id)));
  await w.move("sequence_versions", all(eq(V.workspaceId, ws), eq(V.campaignId, c.id)));
  await closeEntry(w, { leads, subsequences, events });
  return w.entryId;
}

/** A lead list and its leads. */
export async function trashLeadList(list: typeof schema.leadLists.$inferSelect, actor: Actor): Promise<{ entryId: string; leads: number }> {
  const ws = list.workspaceId;
  const w = await openEntry(ws, "lead_list", list.id, list.name, actor);
  await w.move("lead_lists", all(eq(schema.leadLists.workspaceId, ws), eq(schema.leadLists.id, list.id)));
  const leads = await w.move("leads", all(eq(L.workspaceId, ws), eq(L.listId, list.id)));
  await closeEntry(w, { leads });
  return { entryId: w.entryId, leads };
}

/** Leads picked one by one or by a filter: one entry for the whole delete. Their emails and events stay where they are. */
export async function trashLeads(workspaceId: string, ids: string[], actor: Actor): Promise<{ entryId: string | null; count: number }> {
  if (!ids.length) return { entryId: null, count: 0 };
  const w = await openEntry(workspaceId, "leads", null, count(ids.length, "lead"), actor);
  const campaigns = new Set<string>();
  const lists = new Set<string>();
  let first: Row | null = null;
  let moved = 0;
  for (const part of chunk(ids, 500)) {
    moved += await w.move("leads", all(eq(L.workspaceId, workspaceId), inArray(L.id, part)), {
      seen: (rows) => {
        first ??= rows[0] ?? null;
        for (const r of rows) {
          if (r.campaign_id) campaigns.add(String(r.campaign_id));
          if (r.list_id) lists.add(String(r.list_id));
        }
      },
    });
  }
  if (!moved) {
    await db.delete(D).where(eq(D.id, w.entryId));
    return { entryId: null, count: 0 };
  }
  const one = moved === 1 ? (first as Row | null) : null;
  const person = one ? [one.first_name, one.last_name].filter(Boolean).join(" ") : "";
  const name = one ? (person && one.email ? `${person} (${String(one.email)})` : String(one.email ?? person ?? "") || "1 lead") : count(moved, "lead");
  await closeEntry(w, { leads: moved }, { name, meta: { campaigns: [...campaigns], lists: [...lists], from: await describeContainers([...campaigns], [...lists]) } });
  return { entryId: w.entryId, count: moved };
}

/** "From “Q4 outreach”" or "From 2 campaigns and 1 list", for the list of deleted things. */
async function describeContainers(campaignIds: string[], listIds: string[]): Promise<string | null> {
  if (campaignIds.length + listIds.length === 1) {
    const [c] = campaignIds.length
      ? await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignIds[0]!))
      : await db.select({ name: schema.leadLists.name }).from(schema.leadLists).where(eq(schema.leadLists.id, listIds[0]!));
    return c ? `From “${c.name}”` : null;
  }
  const parts = [campaignIds.length ? count(campaignIds.length, "campaign") : "", listIds.length ? count(listIds.length, "list") : ""].filter(Boolean);
  return parts.length ? `From ${parts.join(" and ")}` : null;
}

export async function trashTemplate(t: typeof schema.emailTemplates.$inferSelect, actor: Actor): Promise<string> {
  const T = schema.emailTemplates;
  const w = await openEntry(t.workspaceId, "template", t.id, t.name, actor, { reply: t.isReplyTemplate });
  await w.move("email_templates", all(eq(T.workspaceId, t.workspaceId), eq(T.id, t.id)));
  await closeEntry(w, {});
  return w.entryId;
}

/** A subsequence and its sequence versions. Its leads leave it but stay in the campaign; its events stay too. */
export async function trashSubsequence(s: SubsequenceRow, actor: Actor): Promise<string> {
  const ws = s.workspaceId;
  const { subsequences: S, sequence_versions: V } = TABLES;
  const [parent] = await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, s.parentCampaignId));
  const w = await openEntry(ws, "subsequence", s.id, s.name, actor, { campaign_id: s.parentCampaignId, campaign_name: parent?.name ?? null });
  await w.move("subsequences", all(eq(S.workspaceId, ws), eq(S.id, s.id)));
  const leads = await w.release(s);
  await w.move("sequence_versions", all(eq(V.workspaceId, ws), eq(V.subsequenceId, s.id)));
  await closeEntry(w, { leads });
  return w.entryId;
}

// ---------- Listing ----------

/** Whether an entry can be restored or deleted for good: complete, or its delete stopped part-way (it moves nothing any more). */
export function isReady(e: Pick<DeletedEntry, "status" | "createdAt" | "movedAt">, now = Date.now()): boolean {
  return e.status === "ready" || (e.movedAt ?? e.createdAt).getTime() < now - STALLED_MS;
}

/** What's in Recently deleted for this member, newest first. Entries past 30 days count as gone even before the purge. */
export async function listDeleted(a: AuthContext, workspaceId: string, q: { kind?: DeletedKind; limit: number; startingAfter?: string }, now = Date.now()) {
  const kinds = visibleKinds(a).filter((k) => !q.kind || k === q.kind);
  if (!kinds.length) return { items: [] as DeletedEntry[], next: null };
  const conds = [eq(D.workspaceId, workspaceId), gt(D.expiresAt, new Date(now)), inArray(D.kind, kinds)];
  if (q.startingAfter) conds.push(lt(D.id, q.startingAfter));
  const rows = await db
    .select()
    .from(D)
    .where(and(...conds))
    .orderBy(desc(D.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit);
  return { items, next: rows.length > q.limit ? items[items.length - 1]!.id : null };
}

/** One entry of this workspace that hasn't expired, or a 404. */
export async function findDeleted(workspaceId: string, id: string, now = Date.now()): Promise<DeletedEntry> {
  const [row] = await db
    .select()
    .from(D)
    .where(and(eq(D.id, id), eq(D.workspaceId, workspaceId), gt(D.expiresAt, new Date(now))))
    .limit(1);
  if (!row) throw notFound("Deleted item");
  return row;
}

export function serializeDeleted(e: DeletedEntry, a: AuthContext, now = Date.now()) {
  const meta = (e.meta ?? {}) as { from?: string | null; campaign_name?: string | null; reply?: boolean };
  const context =
    e.kind === "leads" ? (meta.from ?? null) : e.kind === "subsequence" ? (meta.campaign_name ? `In “${meta.campaign_name}”` : null) : e.kind === "template" ? (meta.reply ? "Reply template" : "Email template") : null;
  return {
    id: e.id,
    kind: e.kind as DeletedKind,
    name: e.name,
    item_id: e.itemId,
    context,
    counts: e.counts,
    deleted_at: iso(e.createdAt),
    deleted_by_name: e.deletedByName,
    expires_at: iso(e.expiresAt),
    days_left: Math.max(0, Math.ceil((e.expiresAt.getTime() - now) / DAY)),
    ready: isReady(e, now),
    can_restore: canManageDeleted(a, e),
  };
}

// ---------- Restoring ----------

export interface RestoreResult {
  kind: DeletedKind;
  item_id: string | null;
  name: string;
  /** What happened, in a sentence or two (shown as is). */
  message: string;
  /** Where the restored thing is in the app. */
  link: string | null;
  counts: Record<string, number>;
}

/** The entry's chunks in the order they were written, one at a time so a big campaign never sits in memory whole. */
async function* storedChunks(entryId: string): AsyncGenerator<{ table: string; rows: Row[] }> {
  let after = -1;
  for (;;) {
    const [c] = await db
      .select()
      .from(R)
      .where(and(eq(R.entryId, entryId), gt(R.seq, after)))
      .orderBy(asc(R.seq))
      .limit(1);
    if (!c) return;
    after = c.seq;
    yield { table: c.tableName, rows: JSON.parse((await unpack(c.data)).toString("utf8")) as Row[] };
  }
}

/**
 * Puts rows back exactly as they were stored. Columns added to the table since then get their defaults, and a row whose
 * id is taken, or that clashes with a unique index, is left out. Returns the ids that went in.
 */
async function insertRows(name: TableName, rows: Row[]): Promise<Set<string>> {
  const inserted = new Set<string>();
  if (!rows.length) return inserted;
  const table = TABLES[name];
  const known = new Set(Object.values(getTableColumns(table)).map((col) => col.name));
  const cols = Object.keys(rows[0]!).filter((k) => known.has(k));
  const columns = sql.join(
    cols.map((k) => sql.identifier(k)),
    sql`, `,
  );
  // Stay well under SQLite's limit on bound values per statement.
  for (const part of chunk(rows, Math.max(1, Math.floor(8000 / cols.length)))) {
    const values = sql.join(
      part.map(
        (r) =>
          sql`(${sql.join(
            cols.map((k) => sql`${r[k] ?? null}`),
            sql`, `,
          )})`,
      ),
      sql`, `,
    );
    const out = await db.all<{ id: string }>(sql`insert into ${table} (${columns}) values ${values} on conflict do nothing returning "id"`);
    for (const o of out) inserted.add(o.id);
  }
  return inserted;
}

async function existingIds(table: (typeof TABLES)[TableName] | typeof schema.customTags, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk([...new Set(ids)], 800)) {
    for (const r of await db.all<{ id: string }>(sql`select "id" from ${table} where ${idIn(part)}`)) out.add(r.id);
  }
  return out;
}

/** The name, or "name (restored)" when another item of the same kind is already called that. */
function freeName(name: string, taken: Set<string>, max: number): string {
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? " (restored)" : ` (restored ${i})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const lowerNames = (rows: Array<{ name: string }>) => new Set(rows.map((r) => r.name.trim().toLowerCase()));
const renamedNote = (what: string, from: string, to: string) => (from === to ? "" : ` Another ${what} is called “${from}”, so this one is now “${to}”.`);
/** Statuses that never send by themselves, so a restore keeps them (a suspended campaign stays suspended). */
const STILL: number[] = [CampaignStatus.DRAFT, CampaignStatus.PAUSED, CampaignStatus.COMPLETED, CampaignStatus.BOUNCE_PROTECT, CampaignStatus.ACCOUNT_SUSPENDED];
/** Back, but never sending on its own: anything that was sending (or would restart by itself) comes back paused. */
const parked = (status: unknown): number => (STILL.includes(Number(status)) ? Number(status) : CampaignStatus.PAUSED);
/** What a restored campaign is doing now, after "… is back". */
const STATE_NOTE: Partial<Record<number, string>> = {
  [CampaignStatus.DRAFT]: " It's still a draft.",
  [CampaignStatus.COMPLETED]: " It had finished, so nothing more is sent.",
  [CampaignStatus.BOUNCE_PROTECT]: " It's still paused by bounce protection.",
  [CampaignStatus.ACCOUNT_SUSPENDED]: " It's still suspended.",
};

/** A restore can't take a workspace past its plan's limit of uploaded contacts (leads going back into campaigns). */
async function assertWithinPlan(entry: DeletedEntry) {
  const limits = await workspaceLimits(entry.workspaceId);
  if (limits.uploaded_contacts === null) return;
  const emails = new Set<string>();
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table === "leads") for (const r of rows) if (r.email && r.campaign_id) emails.add(String(r.email));
  }
  if (!emails.size) return;
  let fresh = emails.size;
  for (const part of chunk([...emails], 800)) {
    const [row] = await db
      .select({ n: sql<number>`count(distinct ${L.email})` })
      .from(L)
      .where(and(eq(L.workspaceId, entry.workspaceId), inArray(L.email, part)));
    fresh -= Number(row?.n ?? 0);
  }
  if ((await uploadedContacts(entry.workspaceId)) + fresh > limits.uploaded_contacts) {
    throw paymentRequired(`Restoring this would take the workspace past its plan's limit of ${fmt.format(limits.uploaded_contacts)} contacts. Delete leads you no longer need, or upgrade, then try again.`);
  }
}

/** Lead Finder agents stopped when their campaign was deleted come back with it, paused: turning one on finds leads again. */
async function reviveLeadFinderAgents(workspaceId: string, campaignId: string | null) {
  if (!campaignId) return;
  const AG = schema.aiAgents;
  const stopped = await db
    .select({ id: AG.id })
    .from(AG)
    .where(
      and(
        eq(AG.workspaceId, workspaceId),
        eq(AG.type, AgentType.LEAD_FINDER),
        eq(AG.status, AgentStatus.ERROR),
        sql`json_extract(${AG.payload}, '$.campaign_id') = ${campaignId}`,
      ),
    );
  for (const a of stopped) {
    await db.update(AG).set({ status: AgentStatus.PAUSED }).where(eq(AG.id, a.id));
    await logAgentEvent(workspaceId, a.id, "campaign_restored", { reason: "The campaign was restored. Turn the agent on to keep it stocked." });
  }
}

async function restoreCampaign(entry: DeletedEntry): Promise<RestoreResult> {
  const ws = entry.workspaceId;
  const C = schema.campaigns;
  await assertWithinPlan(entry);
  let name = entry.name;
  let original = entry.name;
  let status: number = CampaignStatus.PAUSED;
  let leads = 0;
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table === "campaigns") {
      const r = rows[0]!;
      original = String(r.name);
      name = freeName(original, lowerNames(await db.select({ name: C.name }).from(C).where(and(eq(C.workspaceId, ws), ne(C.id, String(r.id))))), 250);
      status = parked(r.status);
      Object.assign(r, { name, status, not_sending_status: null });
      if (!(await insertRows("campaigns", rows)).size && !(await existingIds(C, [String(r.id)])).size) {
        // Only its share link can clash (another campaign has the same one by now): it comes back unshared.
        await insertRows("campaigns", [{ ...r, share_token: null, share_expires_at: null }]);
      }
      if (!(await existingIds(C, [String(r.id)])).size) throw conflict("The campaign couldn't be put back. Nothing was changed.");
    } else if (table === "subsequences") {
      for (const r of rows) r.status = parked(r.status);
      await insertRows("subsequences", rows);
    } else if (table === "custom_tag_mappings") {
      // Tags deleted in the meantime stay deleted.
      const tags = await existingIds(
        schema.customTags,
        rows.map((r) => String(r.tag_id)),
      );
      await insertRows(
        "custom_tag_mappings",
        rows.filter((r) => tags.has(String(r.tag_id))),
      );
    } else if (table in TABLES) {
      const ids = await insertRows(table as TableName, rows);
      if (table === "leads") leads += ids.size;
    }
  }
  await reviveLeadFinderAgents(ws, entry.itemId);
  const state = STATE_NOTE[status] ?? " It's paused, so nothing is sent until you resume it.";
  return {
    kind: "campaign",
    item_id: entry.itemId,
    name,
    message: `“${name}” is back${leads ? ` with ${count(leads, "lead")}` : ""}.${state}${renamedNote("campaign", original, name)}`,
    link: entry.itemId ? `/app/campaign/${entry.itemId}/analytics` : null,
    counts: { leads },
  };
}

async function restoreLeadList(entry: DeletedEntry): Promise<RestoreResult> {
  const ws = entry.workspaceId;
  const LL = schema.leadLists;
  let name = entry.name;
  let original = entry.name;
  let leads = 0;
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table === "lead_lists") {
      const r = rows[0]!;
      original = String(r.name);
      name = freeName(original, lowerNames(await db.select({ name: LL.name }).from(LL).where(and(eq(LL.workspaceId, ws), ne(LL.id, String(r.id))))), 200);
      r.name = name;
      await insertRows("lead_lists", rows);
      if (!(await existingIds(LL, [String(r.id)])).size) throw conflict("The list couldn't be put back. Nothing was changed.");
    } else if (table === "leads") {
      leads += (await insertRows("leads", rows)).size;
    }
  }
  return {
    kind: "lead_list",
    item_id: entry.itemId,
    name,
    message: `“${name}” is back${leads ? ` with ${count(leads, "lead")}` : ""}.${renamedNote("list", original, name)}`,
    link: entry.itemId ? `/app/lead-finder/leads?list=${entry.itemId}` : null,
    counts: { leads },
  };
}

/** The "Restored leads" list, made the first time it's needed. */
async function restoredList(workspaceId: string, actor: Actor): Promise<string> {
  const LL = schema.leadLists;
  const [existing] = await db
    .select({ id: LL.id })
    .from(LL)
    .where(and(eq(LL.workspaceId, workspaceId), eq(LL.name, RESTORED_LIST_NAME)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db.insert(LL).values({ workspaceId, name: RESTORED_LIST_NAME, createdBy: actor.userId, ownedBy: actor.userId }).returning({ id: LL.id });
  return row!.id;
}

/** What a lead sent from a campaign it can't go back to leaves behind: its place in that campaign's sending. */
const OUT_OF_CAMPAIGN: Row = {
  campaign_id: null,
  next_send_at: null,
  sender_account_id: null,
  thread_message_ids: null,
  last_subject: null,
  subsequence_id: null,
  subseq_next_step: 0,
  subseq_next_send_at: null,
  subseq_status: null,
};

async function restoreLeads(entry: DeletedEntry, actor: Actor): Promise<RestoreResult> {
  const ws = entry.workspaceId;
  const meta = (entry.meta ?? {}) as { campaigns?: string[]; lists?: string[] };
  const campaigns = await existingIds(schema.campaigns, meta.campaigns ?? []);
  const lists = await existingIds(schema.leadLists, meta.lists ?? []);
  const missing = [...(meta.campaigns ?? []).filter((id) => !campaigns.has(id)), ...(meta.lists ?? []).filter((id) => !lists.has(id))];
  if (missing.length) {
    // Their campaign or list is in Recently deleted too: it has to come back first, or the leads would have nowhere to go.
    const [holder] = await db
      .select()
      .from(D)
      .where(and(eq(D.workspaceId, ws), inArray(D.itemId, missing), ne(D.id, entry.id), gt(D.expiresAt, new Date())))
      .limit(1);
    if (holder) throw conflict(`These leads were in “${holder.name}”, which is in Recently deleted too. Restore the ${holder.kind === "campaign" ? "campaign" : "list"} first, then the leads.`);
  }
  await assertWithinPlan(entry);
  let restored = 0;
  let toList = 0;
  let skipped = 0;
  let listId: string | null = null;
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table !== "leads") continue;
    const already = await existingIds(
      L,
      rows.map((r) => String(r.id)),
    );
    const fresh = rows.filter((r) => !already.has(String(r.id)));
    skipped += rows.length - fresh.length;
    // Leads whose campaign or list is gone for good can't go back there.
    const home = (r: Row) => (r.campaign_id ? campaigns.has(String(r.campaign_id)) : r.list_id ? lists.has(String(r.list_id)) : false);
    const homed = fresh.filter(home);
    const inserted = await insertRows("leads", homed);
    restored += inserted.size;
    // The rest, and leads whose campaign or list has someone with the same address by now, go to the "Restored leads" list.
    const rest = [...fresh.filter((r) => !home(r)), ...homed.filter((r) => !inserted.has(String(r.id)))];
    if (rest.length) {
      listId ??= await restoredList(ws, actor);
      const moved = await insertRows(
        "leads",
        rest.map((r) => ({ ...r, ...OUT_OF_CAMPAIGN, list_id: listId })),
      );
      toList += moved.size;
      skipped += rest.length - moved.size;
    }
  }
  const total = restored + toList;
  const parts = [`${count(total, "lead")} ${total === 1 ? "is" : "are"} back.`];
  if (toList) parts.push(`${count(toList, "lead")} went to the list “${RESTORED_LIST_NAME}”, because ${toList === 1 ? "its campaign or list is gone or has the same address in it already" : "their campaign or list is gone or has the same addresses in it already"}.`);
  if (skipped) parts.push(`${count(skipped, "lead")} ${skipped === 1 ? "was" : "were"} already there.`);
  const single = (meta.campaigns?.length ?? 0) + (meta.lists?.length ?? 0) === 1 && !toList;
  return {
    kind: "leads",
    item_id: null,
    name: entry.name,
    message: parts.join(" "),
    link: single ? (meta.campaigns?.[0] ? `/app/campaign/${meta.campaigns[0]}/leads` : `/app/lead-finder/leads?list=${meta.lists![0]}`) : listId ? `/app/lead-finder/leads?list=${listId}` : null,
    counts: { leads: total, to_list: toList, skipped },
  };
}

async function restoreTemplate(entry: DeletedEntry): Promise<RestoreResult> {
  const T = schema.emailTemplates;
  let name = entry.name;
  let original = entry.name;
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table !== "email_templates") continue;
    const r = rows[0]!;
    original = String(r.name);
    const others = await db
      .select({ name: T.name })
      .from(T)
      .where(and(eq(T.workspaceId, entry.workspaceId), eq(T.isReplyTemplate, !!r.is_reply_template), ne(T.id, String(r.id))));
    name = freeName(original, lowerNames(others), 200);
    r.name = name;
    await insertRows("email_templates", rows);
  }
  return { kind: "template", item_id: entry.itemId, name, message: `“${name}” is back.${renamedNote("template", original, name)}`, link: "/app/templates", counts: {} };
}

async function restoreSubsequence(entry: DeletedEntry): Promise<RestoreResult> {
  const ws = entry.workspaceId;
  const S = schema.subsequences;
  const meta = (entry.meta ?? {}) as { campaign_id?: string; campaign_name?: string | null };
  const [parent] = meta.campaign_id
    ? await db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, meta.campaign_id), eq(schema.campaigns.workspaceId, ws)))
        .limit(1)
    : [];
  if (!parent) {
    const [holder] = meta.campaign_id
      ? await db
          .select()
          .from(D)
          .where(and(eq(D.workspaceId, ws), eq(D.itemId, meta.campaign_id), gt(D.expiresAt, new Date())))
          .limit(1)
      : [];
    if (holder) throw conflict(`Its campaign “${holder.name}” is in Recently deleted too. Restore the campaign first, then the subsequence.`);
    throw conflict("Its campaign was deleted for good, so the subsequence can't come back.");
  }
  let name = entry.name;
  let original = entry.name;
  let status: number = CampaignStatus.PAUSED;
  let leads = 0;
  for await (const { table, rows } of storedChunks(entry.id)) {
    if (table === "subsequences") {
      const r = rows[0]!;
      original = String(r.name);
      name = freeName(original, lowerNames(await db.select({ name: S.name }).from(S).where(and(eq(S.parentCampaignId, parent.id), ne(S.id, String(r.id))))), 250);
      status = parked(r.status);
      Object.assign(r, { name, status });
      await insertRows("subsequences", rows);
      if (!(await existingIds(S, [String(r.id)])).size) throw conflict("The subsequence couldn't be put back. Nothing was changed.");
    } else if (table === LEAD_STATE) {
      // Leads that moved into another subsequence (or out of the campaign) since then stay where they are.
      for (const r of rows) {
        const back = await db
          .update(L)
          .set({ subsequenceId: entry.itemId, subseqStatus: r.subseq_status as number | null, subseqNextStep: Number(r.subseq_next_step ?? 0), subseqNextSendAt: r.subseq_next_send_at as number | null })
          .where(and(eq(L.id, String(r.id)), eq(L.campaignId, parent.id), isNull(L.subsequenceId)))
          .returning({ id: L.id });
        leads += back.length;
      }
    } else if (table in TABLES) {
      await insertRows(table as TableName, rows);
    }
  }
  return {
    kind: "subsequence",
    item_id: entry.itemId,
    name,
    message: `“${name}” is back in “${parent.name}”${leads ? ` with ${count(leads, "lead")}` : ""}.${STATE_NOTE[status] ?? " It's paused, so nothing is sent until you resume it."}${renamedNote("subsequence", original, name)}`,
    link: entry.itemId ? `/app/campaign/${parent.id}/subsequences/${entry.itemId}/sequences` : null,
    counts: { leads },
  };
}

/** Restores in this process right now, so a double click can't put the same rows back twice. */
const restoring = new Set<string>();

export async function restoreDeleted(entry: DeletedEntry, actor: Actor): Promise<RestoreResult> {
  if (!isReady(entry)) throw conflict("This is still being deleted. Try again in a moment.");
  if (restoring.has(entry.id)) throw conflict("This is already being restored.");
  restoring.add(entry.id);
  try {
    const kind = entry.kind as DeletedKind;
    const result =
      kind === "campaign"
        ? await restoreCampaign(entry)
        : kind === "lead_list"
          ? await restoreLeadList(entry)
          : kind === "leads"
            ? await restoreLeads(entry, actor)
            : kind === "template"
              ? await restoreTemplate(entry)
              : await restoreSubsequence(entry);
    await db.batch([db.delete(R).where(eq(R.entryId, entry.id)), db.delete(D).where(eq(D.id, entry.id))]);
    return result;
  } finally {
    restoring.delete(entry.id);
  }
}

// ---------- Deleting for good ----------

/** Deletes an entry for good ("Delete forever", or 30 days after the delete). */
export async function removeDeleted(entry: Pick<DeletedEntry, "id" | "kind" | "itemId" | "workspaceId">): Promise<void> {
  await db.batch([db.delete(R).where(eq(R.entryId, entry.id)), db.delete(D).where(eq(D.id, entry.id))]);
  // A campaign's or list's enrichment columns waited in place in case it came back; now nothing will use them.
  if ((entry.kind === "campaign" || entry.kind === "lead_list") && entry.itemId) {
    const { enrichments: EN, enrichmentRuns: ER } = schema;
    await db.batch([
      db.delete(ER).where(and(eq(ER.workspaceId, entry.workspaceId), eq(ER.resourceId, entry.itemId))),
      db.delete(EN).where(and(eq(EN.workspaceId, entry.workspaceId), eq(EN.resourceId, entry.itemId))),
    ]);
  }
}

/** "Delete forever" in the list. */
export async function deleteForever(entry: DeletedEntry): Promise<void> {
  if (!isReady(entry)) throw conflict("This is still being deleted. Try again in a moment.");
  if (restoring.has(entry.id)) throw conflict("This is being restored right now.");
  await removeDeleted(entry);
}

/** Engine loop: entries older than 30 days go for good. Returns how many. */
export async function purgeDeleted(now = Date.now()): Promise<number> {
  let purged = 0;
  for (;;) {
    const rows = await db
      .select({ id: D.id, kind: D.kind, itemId: D.itemId, workspaceId: D.workspaceId })
      .from(D)
      .where(lte(D.expiresAt, new Date(now)))
      .limit(100);
    if (!rows.length) return purged;
    for (const r of rows) await removeDeleted(r);
    purged += rows.length;
  }
}
