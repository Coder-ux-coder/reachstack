// Block list helpers: value normalisation, Google Sheets sync, and the automatic triggers from
// Settings → Blocklist ("also block leads marked as …" / "whose reply contains …").
import { and, eq, isNotNull, sql } from "drizzle-orm";
import Papa from "papaparse";
import { unescapeCsvFormula } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { badRequest } from "../http/errors";
import { chunk } from "../http/util";
import { replyWords } from "../mail/reply-text";
import { on } from "./bus";
import { patchWorkspaceSettings } from "./workspaces";
import { inUse } from "./live-workspaces";

const B = schema.blockList;

export interface BlockTriggers {
  statuses: number[];
  phrases: string[];
}

/** An email address or a bare domain, lower-cased; null when it's neither. */
export function blockValue(v: string): { value: string; isDomain: boolean } | null {
  const value = v.trim().toLowerCase().replace(/^@/, "");
  if (!value) return null;
  if (value.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { value, isDomain: false } : null;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? { value, isDomain: true } : null;
}

/** Adds addresses/domains, skipping invalid and existing ones. Returns how many were new. */
export async function addBlocked(workspaceId: string, values: string[], source: string): Promise<{ valid: number; added: number }> {
  const valid = [...new Map(values.map(blockValue).filter((v): v is NonNullable<typeof v> => !!v).map((v) => [v.value, v])).values()];
  let added = 0;
  for (const part of chunk(valid, 500)) {
    const rows = await db
      .insert(B)
      .values(part.map((v) => ({ workspaceId, value: v.value, isDomain: v.isDomain, source })))
      .onConflictDoNothing()
      .returning({ id: B.id });
    added += rows.length;
  }
  return { valid: valid.length, added };
}

/** Reads the first column of a public Google Sheet and adds every address or domain in it. */
export async function syncBlockSheet(workspaceId: string, url: string): Promise<{ found: number; valid: number; added: number }> {
  const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(url);
  if (!m) throw badRequest("Paste a Google Sheets link");
  const gid = /[#&?]gid=(\d+)/.exec(url)?.[1] ?? "0";
  // Only the fixed Google export endpoint is fetched, never the pasted URL itself.
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!res.ok) throw badRequest("Could not read the sheet. Share it as 'Anyone with the link can view'.");
  const text = await res.text();
  if (/^\s*<!doctype html|<html/i.test(text)) throw badRequest("Could not read the sheet. Share it as 'Anyone with the link can view'.");
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true, transform: unescapeCsvFormula }).data;
  if (rows.some((r) => r.filter((c) => c.trim()).length > 1)) throw badRequest("Use a sheet with a single column of emails or domains.");
  const values = rows.map((r) => r[0] ?? "").filter(Boolean);
  const r = await addBlocked(workspaceId, values, "sheet");
  // A read that works clears the error an earlier one left.
  await patchWorkspaceSettings(workspaceId, { global_block_sheet_link: url, global_block_sheet_synced_at: new Date().toISOString(), global_block_sheet_error: null });
  return { found: values.length, ...r };
}

/** Daily refresh of linked sheets (new rows in the sheet get blocked; removed rows stay blocked). */
export async function refreshBlockSheets() {
  const rows = await db
    .select({ id: schema.workspaces.id, settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(and(isNotNull(sql`json_extract(${schema.workspaces.settings}, '$.global_block_sheet_link')`), sql`${schema.workspaces.deletedAt} is null`, await inUse(schema.workspaces.id)));
  for (const ws of rows) {
    const s = (ws.settings ?? {}) as { global_block_sheet_link?: string | null; global_block_sheet_synced_at?: string };
    if (!s.global_block_sheet_link) continue;
    if (s.global_block_sheet_synced_at && Date.now() - Date.parse(s.global_block_sheet_synced_at) < 24 * 3_600_000) continue;
    try {
      await syncBlockSheet(ws.id, s.global_block_sheet_link);
    } catch (err) {
      // Try again tomorrow rather than every pass.
      await patchWorkspaceSettings(ws.id, { global_block_sheet_synced_at: new Date().toISOString(), global_block_sheet_error: (err as Error).message });
    }
  }
}

async function triggersFor(workspaceId: string): Promise<BlockTriggers | null> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const t = (ws?.settings as { blocklist_triggers?: BlockTriggers } | null)?.blocklist_triggers;
  return t && (t.statuses?.length || t.phrases?.length) ? t : null;
}

on("lead_interest_changed", async (ev) => {
  const email = ev.data.lead_email as string | null;
  const value = ev.data.value as number | null;
  if (!email || value === null) return;
  const t = await triggersFor(ev.workspaceId);
  if (t?.statuses.includes(value)) await addBlocked(ev.workspaceId, [email], "trigger");
});

on("reply_received", async (ev) => {
  const email = ev.data.lead_email as string | null;
  if (!email) return;
  const t = await triggersFor(ev.workspaceId);
  if (!t?.phrases.length) return;
  // The person's own words only: a phrase in our quoted email or in "Re: <our subject>" doesn't count.
  const text = replyWords(ev.data).toLowerCase();
  if (t.phrases.some((p) => p.trim() && text.includes(p.trim().toLowerCase()))) await addBlocked(ev.workspaceId, [email], "trigger");
});
