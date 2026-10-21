// "Download all data" (Settings → Workspace & members): one .tar.gz with a workspace's leads, lead lists, campaigns
// (sequences, steps, variants, schedules and subsequences), email accounts, emails by thread, block list,
// unsubscribes, tags and lead labels, as CSV and JSON. It runs as a background job ("workspace-export") because it can
// be big, and the file is kept in DATA_DIR/exports for EXPORT_KEEP_DAYS. Secrets never go in: accounts go through the
// API's serializer (no passwords or OAuth tokens), and settings and records are stripped of secret-looking keys.
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { config } from "../env";
import { chunk } from "../http/util";
import { iso } from "../lib/time";
import { workspaceToday } from "./workspace-clock";
import { serializeAccounts } from "./accounts";
import { writeTarGz, type TarSource } from "./backup-archive";
import { serializeCampaigns } from "./campaigns";
import { registerJobHandler, type JobContext, type JobRow } from "./jobs";
import { serializeLead, type LeadRow } from "./leads";
import { serializeSubsequence } from "./subsequences";
import { serializeEmail } from "./unibox";
import { publicSettings } from "./workspaces";
import { toCsv } from "../lib/csv";

export const WORKSPACE_EXPORT_JOB = "workspace-export";
export const EXPORT_KEEP_DAYS = 7;
const DAY = 86_400_000;
const PAGE = 1000;

export const exportsDir = () => path.join(config.dataDir, "exports");
export const workspaceExportFile = (jobId: string) => path.join(exportsDir(), `workspace-export-${jobId}.tar.gz`);

/** Lower-case ASCII for file names: "Acme Outreach" → "acme-outreach". */
export function slug(name: string, fallback = "workspace"): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || fallback;
}

// ---------- Keeping secrets out ----------

const SECRET_KEY = /(password|passwd|secret|token|api_?key|credential)|_enc$/i;

/** Drops every key that looks like it could hold a secret, at any depth. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !SECRET_KEY.test(k))
      .map(([k, v]) => [k, scrub(v, depth + 1)]),
  ) as T;
}

// ---------- Writers ----------

async function put(out: WriteStream, text: string) {
  if (!out.write(text)) await once(out, "drain");
}

function openFile(file: string) {
  const out = createWriteStream(file, { flags: "wx" });
  const closed = once(out, "close");
  closed.catch(() => undefined);
  return {
    out,
    async close() {
      out.end();
      await closed;
    },
  };
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** CSV with a byte-order mark, so spreadsheet apps read accents and other alphabets correctly. */
class CsvFile {
  private readonly f;
  private columns: string[] = [];
  constructor(file: string) {
    this.f = openFile(file);
  }
  async header(columns: string[]) {
    this.columns = columns;
    await put(this.f.out, `﻿${toCsv([columns])}\r\n`);
  }
  async rows(rows: Array<Record<string, unknown>>) {
    if (rows.length) await put(this.f.out, `${toCsv(rows.map((r) => this.columns.map((c) => cell(r[c]))))}\r\n`);
  }
  close() {
    return this.f.close();
  }
}

async function writeCsv(file: string, rows: Array<Record<string, unknown>>, fallbackColumns: string[]) {
  const csv = new CsvFile(file);
  await csv.header(rows.length ? Object.keys(rows[0]!) : fallbackColumns);
  await csv.rows(rows);
  await csv.close();
}

/** A JSON array written one item at a time, so big ones never sit in memory whole. */
class JsonArrayFile {
  private readonly f;
  private first = true;
  constructor(file: string) {
    this.f = openFile(file);
  }
  async item(value: unknown) {
    const text = `  ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}`;
    await put(this.f.out, `${this.first ? "[\n" : ",\n"}${text}`);
    this.first = false;
  }
  async close() {
    await put(this.f.out, this.first ? "[]\n" : "\n]\n");
    await this.f.close();
  }
}

// ---------- The parts ----------

interface Names {
  campaigns: Map<string, string>;
  lists: Map<string, string>;
}

async function writeLeads(file: string, wsId: string, names: Names, report: (done: number, total: number) => Promise<void>): Promise<number> {
  const L = schema.leads;
  const [totalRow] = await db.select({ n: sql<number>`count(*)` }).from(L).where(eq(L.workspaceId, wsId));
  const total = Number(totalRow?.n ?? 0);
  // Every custom variable used in the workspace becomes a column.
  const keys = (
    await db.all<{ key: string }>(
      sql`select distinct j.key as key from ${L}, json_each(${L.payload}) as j where ${L.workspaceId} = ${wsId} and ${L.payload} is not null and json_valid(${L.payload}) and json_type(${L.payload}) = 'object'`,
    )
  )
    .map((r) => String(r.key))
    .sort((a, b) => a.localeCompare(b));
  const base = (l: LeadRow): Record<string, unknown> => {
    const { status_summary: _summary, payload: _payload, ...rest } = serializeLead(l) as Record<string, unknown>;
    return { ...rest, campaign_name: l.campaignId ? (names.campaigns.get(l.campaignId) ?? "") : "", list_name: l.listId ? (names.lists.get(l.listId) ?? "") : "" };
  };
  const csv = new CsvFile(file);
  let custom: Array<[key: string, column: string]> = [];
  let started = false;
  let done = 0;
  let after = "";
  for (;;) {
    const rows = await db
      .select()
      .from(L)
      .where(and(eq(L.workspaceId, wsId), sql`${L.id} > ${after}`))
      .orderBy(asc(L.id))
      .limit(PAGE);
    if (!rows.length) break;
    const out = rows.map((l) => {
      const record = base(l);
      if (!started) {
        const columns = Object.keys(record);
        custom = keys.map((k) => [k, columns.includes(k) ? `custom_${k}` : k]);
      }
      for (const [k, column] of custom) record[column] = (l.payload as Record<string, unknown> | null)?.[k];
      return record;
    });
    if (!started) {
      await csv.header(Object.keys(out[0]!));
      started = true;
    }
    await csv.rows(out);
    done += rows.length;
    after = rows[rows.length - 1]!.id;
    await report(done, total);
  }
  if (!started) await csv.header(["id", "email", "first_name", "last_name", "company_name", "campaign", "list_id", ...keys]);
  await csv.close();
  return done;
}

async function writeEmails(file: string, wsId: string, report: (done: number, total: number) => Promise<void>): Promise<{ threads: number; emails: number }> {
  const E = schema.emails;
  // Threads in the order they started; an email without a thread is a thread of its own.
  const threads = await db.all<{ t: string }>(
    sql`select coalesce(${E.threadId}, ${E.id}) as t, min(${E.timestampEmail}) as first_at from ${E} where ${E.workspaceId} = ${wsId} and ${E.deletedAt} is null group by t order by first_at, t`,
  );
  const json = new JsonArrayFile(file);
  let emails = 0;
  let done = 0;
  for (const part of chunk(
    threads.map((r) => String(r.t)),
    200,
  )) {
    const rows = await db
      .select()
      .from(E)
      .where(and(eq(E.workspaceId, wsId), isNull(E.deletedAt), or(inArray(E.threadId, part), and(isNull(E.threadId), inArray(E.id, part)))))
      .orderBy(asc(E.timestampEmail), asc(E.id));
    const byThread = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.threadId ?? r.id;
      const list = byThread.get(key) ?? [];
      list.push(r);
      byThread.set(key, list);
    }
    for (const key of part) {
      const list = byThread.get(key);
      if (!list?.length) continue;
      const first = list[0]!;
      await json.item({
        thread_id: first.threadId,
        subject: first.subject,
        lead: first.leadEmail,
        campaign_id: first.campaignId,
        email_count: list.length,
        first_at: iso(first.timestampEmail),
        last_at: iso(list[list.length - 1]!.timestampEmail),
        emails: list.map((e) =>
          scrub({
            ...serializeEmail(e),
            in_reply_to: e.inReplyTo,
            references: e.references,
            account_id: e.accountId,
            folder: e.folder,
          }),
        ),
      });
      emails += list.length;
    }
    done += part.length;
    await report(done, threads.length);
  }
  await json.close();
  return { threads: threads.length, emails };
}

const README = (ws: { name: string }, at: Date, by: string | null) => `Data export of the workspace "${ws.name}"
Made ${at.toISOString().replace("T", " ").slice(0, 16)} UTC${by ? ` by ${by}` : ""}.

What's in it:
- leads.csv: every lead with all its fields, and one column per custom variable.
- lead-lists.csv: the lead lists, with how many leads each has.
- campaigns.json: campaigns with their sequences (steps and variants), schedules, options and subsequences.
- email-accounts.csv: the email accounts and their settings. Passwords and sign-in tokens are not included.
- emails.json: emails grouped by thread, with their headers and bodies. Attachments are listed but not included.
- block-list.csv: blocked addresses and domains.
- unsubscribes.csv: people who unsubscribed.
- tags.csv: custom tags and the accounts and campaigns they're on.
- lead-labels.csv: lead labels (interest statuses).
- workspace.json: the workspace's name, preferences and how many of each thing this export holds.

Field names follow the API. Times are in UTC.
Passwords, sign-in tokens, API keys and anything stored encrypted are never part of an export.
Items in Recently deleted are left out. Restore one first to include it.
`;

// ---------- The job ----------

async function buildExport({ job, progress, cancelled }: JobContext): Promise<Record<string, unknown>> {
  const wsId = job.workspaceId;
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)).limit(1);
  if (!ws) throw new Error("The workspace no longer exists");
  const [by] = job.userId ? await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, job.userId)).limit(1) : [];
  const at = new Date();
  const folder = `${slug(ws.name)}-export-${await workspaceToday(wsId)}`;
  await mkdir(exportsDir(), { recursive: true });
  const work = await mkdtemp(path.join(exportsDir(), ".work-"));
  const dir = path.join(work, folder);
  const out = workspaceExportFile(job.id);
  const partial = `${out}.partial`;
  await mkdir(dir);
  const file = (name: string) => path.join(dir, name);
  const stage = (from: number, to: number) => async (done: number, total: number) => progress(from + ((to - from) * done) / Math.max(1, total));
  try {
    const counts: Record<string, number> = {};

    const campaignRows = await db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, wsId)).orderBy(asc(schema.campaigns.createdAt));
    const listRows = await db.select().from(schema.leadLists).where(eq(schema.leadLists.workspaceId, wsId)).orderBy(asc(schema.leadLists.createdAt));
    const names: Names = { campaigns: new Map(campaignRows.map((c) => [c.id, c.name])), lists: new Map(listRows.map((l) => [l.id, l.name])) };

    counts.leads = await writeLeads(file("leads.csv"), wsId, names, stage(2, 40));
    if (await cancelled()) return {};

    const L = schema.leads;
    const perList = new Map(
      (await db.select({ id: L.listId, n: sql<number>`count(*)` }).from(L).where(and(eq(L.workspaceId, wsId), isNotNull(L.listId))).groupBy(L.listId)).map((r) => [r.id!, Number(r.n)]),
    );
    const perCampaign = new Map(
      (await db.select({ id: L.campaignId, n: sql<number>`count(*)` }).from(L).where(and(eq(L.workspaceId, wsId), isNotNull(L.campaignId))).groupBy(L.campaignId)).map((r) => [r.id!, Number(r.n)]),
    );
    await writeCsv(
      file("lead-lists.csv"),
      listRows.map((l) => ({ id: l.id, name: l.name, leads: perList.get(l.id) ?? 0, owned_by: l.ownedBy, created_by: l.createdBy, has_enrichment_task: l.hasEnrichmentTask, timestamp_created: iso(l.createdAt) })),
      ["id", "name", "leads", "owned_by", "created_by", "has_enrichment_task", "timestamp_created"],
    );
    counts.lead_lists = listRows.length;

    const subsequences = await db.select().from(schema.subsequences).where(eq(schema.subsequences.workspaceId, wsId)).orderBy(asc(schema.subsequences.createdAt));
    const campaigns = (await serializeCampaigns(wsId, campaignRows)).map((c) =>
      scrub({
        ...c,
        tags: ((c.tags ?? []) as Array<{ label?: string }>).map((t) => t.label ?? ""),
        lead_count: perCampaign.get(c.id) ?? 0,
        subsequences: subsequences.filter((s) => s.parentCampaignId === c.id).map(serializeSubsequence),
      }),
    );
    await writeFile(file("campaigns.json"), `${JSON.stringify(campaigns, null, 2)}\n`);
    counts.campaigns = campaigns.length;
    await progress(44);

    const accountRows = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, wsId)).orderBy(asc(schema.emailAccounts.createdAt));
    const accounts = (await serializeAccounts(wsId, accountRows, { includeTags: true })).map((a) =>
      scrub({ ...a, tags: ((a.tags ?? []) as unknown as Array<{ label?: string }>).map((t) => t.label ?? "").join("; ") }),
    );
    await writeCsv(file("email-accounts.csv"), accounts, ["id", "email", "first_name", "last_name", "provider_code", "status", "warmup_status", "daily_limit"]);
    counts.email_accounts = accounts.length;
    await progress(48);
    if (await cancelled()) return {};

    const mail = await writeEmails(file("emails.json"), wsId, stage(48, 90));
    counts.threads = mail.threads;
    counts.emails = mail.emails;
    if (await cancelled()) return {};

    const blocked = await db.select().from(schema.blockList).where(eq(schema.blockList.workspaceId, wsId)).orderBy(asc(schema.blockList.createdAt));
    await writeCsv(
      file("block-list.csv"),
      blocked.map((b) => ({ value: b.value, is_domain: b.isDomain, source: b.source, timestamp_created: iso(b.createdAt) })),
      ["value", "is_domain", "source", "timestamp_created"],
    );
    counts.block_list = blocked.length;

    const unsubscribed = await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.workspaceId, wsId)).orderBy(asc(schema.unsubscribes.createdAt));
    await writeCsv(
      file("unsubscribes.csv"),
      unsubscribed.map((u) => ({ email: u.email, campaign: u.campaignId, campaign_name: u.campaignId ? (names.campaigns.get(u.campaignId) ?? "") : "", source: u.source, timestamp_created: iso(u.createdAt) })),
      ["email", "campaign", "campaign_name", "source", "timestamp_created"],
    );
    counts.unsubscribes = unsubscribed.length;

    const tags = await db.select().from(schema.customTags).where(eq(schema.customTags.workspaceId, wsId)).orderBy(asc(schema.customTags.createdAt));
    const mappings = await db.select().from(schema.customTagMappings).where(eq(schema.customTagMappings.workspaceId, wsId));
    const accountEmails = new Map(accountRows.map((a) => [a.id, a.email]));
    const on = (tagId: string, type: number, label: Map<string, string>) =>
      mappings
        .filter((m) => m.tagId === tagId && m.resourceType === type)
        .map((m) => label.get(m.resourceId))
        .filter(Boolean)
        .join("; ");
    await writeCsv(
      file("tags.csv"),
      tags.map((t) => ({ id: t.id, label: t.label, description: t.description, color: t.color, accounts: on(t.id, 1, accountEmails), campaigns: on(t.id, 2, names.campaigns), timestamp_created: iso(t.createdAt) })),
      ["id", "label", "description", "color", "accounts", "campaigns", "timestamp_created"],
    );
    counts.tags = tags.length;

    const labels = await db.select().from(schema.leadLabels).where(eq(schema.leadLabels.workspaceId, wsId)).orderBy(asc(schema.leadLabels.createdAt));
    await writeCsv(
      file("lead-labels.csv"),
      labels.map((l) => ({ id: l.id, label: l.label, interest_status: l.interestStatus, sentiment: l.interestStatusLabel, description: l.description, use_with_ai: l.useWithAi, color: l.color, timestamp_created: iso(l.createdAt) })),
      ["id", "label", "interest_status", "sentiment", "description", "use_with_ai", "color", "timestamp_created"],
    );
    counts.lead_labels = labels.length;

    await writeFile(
      file("workspace.json"),
      `${JSON.stringify({ id: ws.id, name: ws.name, timestamp_created: iso(ws.createdAt), exported_at: at.toISOString(), exported_by: by?.email ?? null, settings: scrub(publicSettings(ws)), counts }, null, 2)}\n`,
    );
    await writeFile(file("README.txt"), README(ws, at, by?.email ?? null));
    await progress(94);

    const entries: TarSource[] = (await readdir(dir)).sort().map((name) => ({ name: `${folder}/${name}`, file: path.join(dir, name) }));
    // Left by a try the app stopped in the middle of (the archive is never written over).
    await rm(partial, { force: true });
    await writeTarGz(partial, entries);
    await rename(partial, out);
    const bytes = (await stat(out)).size;
    return { file: path.basename(out), name: `${folder}.tar.gz`, bytes, counts, expires_at: new Date(Date.now() + EXPORT_KEEP_DAYS * DAY).toISOString() };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

registerJobHandler(WORKSPACE_EXPORT_JOB, buildExport);

/**
 * Deletes finished exports after EXPORT_KEEP_DAYS (workspace exports, and lead exports, which are downloaded as soon as
 * they're ready; Lead Finder's stay listed, so they're kept), and work folders a stopped export left behind.
 */
export async function removeOldExports(now = Date.now()) {
  const dir = exportsDir();
  let leadFinder: Set<string> | null = null;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const leftover = name.startsWith(".work-") || /^workspace-export-.+\.tar\.gz\.partial$/.test(name);
    const leads = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i.test(name);
    if (!leftover && !leads && !/^workspace-export-.+\.tar\.gz$/.test(name)) continue;
    const full = path.join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || now - st.mtimeMs <= (leftover ? DAY : EXPORT_KEEP_DAYS * DAY)) continue;
    if (leads) {
      leadFinder ??= new Set((await db.select({ file: schema.lfExports.filePath }).from(schema.lfExports)).map((r) => r.file ?? ""));
      if (leadFinder.has(name)) continue;
    }
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What the export section shows for one export job. */
export async function exportView(job: JobRow) {
  const result = (job.result ?? {}) as { bytes?: number; counts?: Record<string, number>; expires_at?: string; name?: string };
  const available = job.status === "success" && (await stat(workspaceExportFile(job.id)).then(() => true, () => false));
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    error: job.status === "failed" ? job.error : null,
    created_at: iso(job.createdAt),
    finished_at: job.status === "success" || job.status === "failed" ? iso(job.updatedAt) : null,
    bytes: result.bytes ?? null,
    counts: result.counts ?? null,
    expires_at: result.expires_at ?? null,
    available,
    file_name: result.name ?? null,
  };
}
