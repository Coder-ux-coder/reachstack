import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Sequence } from "@reachstack/shared";
import { createdAt, json, pk, ts, workspaceId } from "./_helpers";

/**
 * Recently deleted (services/recently-deleted.ts): one row per delete of a campaign, a lead list, some leads, a
 * template or a subsequence. The rows the delete took out of the live tables are in deleted_item_rows; both go for
 * good after 30 days.
 */
export const deletedItems = sqliteTable(
  "deleted_items",
  {
    id: pk(),
    workspaceId: workspaceId(),
    /** campaign | lead_list | leads | template | subsequence */
    kind: text("kind").notNull(),
    /** deleting (rows are still being moved) | ready (can be restored) */
    status: text("status").notNull().default("deleting"),
    /** The campaign, list, template or subsequence that was deleted (null for leads). */
    itemId: text("item_id"),
    name: text("name").notNull(),
    /** How many of each thing went with it (leads, events, subsequences…), for the list. */
    counts: json<Record<string, number>>("counts").notNull(),
    /** What restoring needs to know: the leads' campaigns and lists, a subsequence's campaign, a template's kind. */
    meta: json<Record<string, unknown>>("meta"),
    deletedBy: text("deleted_by"),
    /** Who deleted it, as shown at the time: a person's name, or the API key's. */
    deletedByName: text("deleted_by_name"),
    /** Size of the stored rows, compressed. */
    bytes: integer("bytes").notNull().default(0),
    /** When the delete last moved rows in, while it's still "deleting". */
    movedAt: ts("moved_at"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("deleted_items_ws_idx").on(t.workspaceId, t.createdAt), index("deleted_items_expires_idx").on(t.expiresAt)],
);

/** The rows a delete took out, exactly as they were stored: gzipped JSON, a few hundred rows per chunk. */
export const deletedItemRows = sqliteTable(
  "deleted_item_rows",
  {
    id: pk(),
    entryId: text("entry_id").notNull(),
    seq: integer("seq").notNull(),
    /** The table the rows came from ("lead_subsequence_state" for the leads a deleted subsequence let go). */
    tableName: text("table_name").notNull(),
    rowCount: integer("row_count").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
  },
  (t) => [index("deleted_item_rows_entry_idx").on(t.entryId, t.seq)],
);

/** Every saved version of a campaign's or subsequence's sequence; the newest is the current one. The last 50 are kept. */
export const sequenceVersions = sqliteTable(
  "sequence_versions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    campaignId: text("campaign_id").notNull(),
    /** Set for a subsequence's sequence, null for the campaign's own. */
    subsequenceId: text("subsequence_id"),
    sequences: json<Sequence[]>("sequences").notNull(),
    /** edit | create | restore | agent | earlier (what the sequence held before versions were kept) */
    source: text("source").notNull().default("edit"),
    createdBy: text("created_by"),
    /** Who saved it, as shown at the time: a person's name, the API key's or the AI agent's. */
    createdByName: text("created_by_name"),
    /** The version a restore brought back. */
    restoredFrom: text("restored_from"),
    createdAt: createdAt(),
  },
  (t) => [index("sequence_versions_owner_idx").on(t.campaignId, t.subsequenceId, t.createdAt)],
);
