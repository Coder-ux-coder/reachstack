// Custom tags (labels) attached to accounts and campaigns.
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { badRequest } from "../http/errors";
import { iso } from "../lib/time";

export type TagRow = typeof schema.customTags.$inferSelect;

export function serializeTag(t: TagRow) {
  return {
    id: t.id,
    organization_id: t.workspaceId,
    label: t.label,
    description: t.description,
    color: t.color,
    timestamp_created: iso(t.createdAt),
    timestamp_updated: iso(t.updatedAt),
  };
}

/** resourceId → tags */
export async function tagsFor(workspaceId: string, resourceIds: string[]): Promise<Map<string, ReturnType<typeof serializeTag>[]>> {
  const out = new Map<string, ReturnType<typeof serializeTag>[]>();
  if (!resourceIds.length) return out;
  const rows = await db
    .select({ m: schema.customTagMappings, t: schema.customTags })
    .from(schema.customTagMappings)
    .innerJoin(schema.customTags, and(eq(schema.customTags.id, schema.customTagMappings.tagId), eq(schema.customTags.workspaceId, workspaceId)))
    .where(and(eq(schema.customTagMappings.workspaceId, workspaceId), inArray(schema.customTagMappings.resourceId, resourceIds)));
  for (const r of rows) {
    const list = out.get(r.m.resourceId) ?? [];
    list.push(serializeTag(r.t));
    out.set(r.m.resourceId, list);
  }
  return out;
}

/** Turns the request away (400) when any of these isn't one of the workspace's tags. */
export async function assertTags(workspaceId: string, tagIds: string[]): Promise<void> {
  const wanted = [...new Set(tagIds)];
  if (!wanted.length) return;
  const rows = await db
    .select({ id: schema.customTags.id })
    .from(schema.customTags)
    .where(and(eq(schema.customTags.workspaceId, workspaceId), inArray(schema.customTags.id, wanted)));
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.find((id) => !found.has(id));
  if (missing) throw badRequest(`tag_ids: ${missing} is not a tag in this workspace`);
}

/** Resource ids that carry any (or all) of the given tags. */
export async function resourcesWithTags(workspaceId: string, tagIds: string[], mode: "any" | "all" = "any"): Promise<string[]> {
  if (!tagIds.length) return [];
  const rows = await db
    .select({ resourceId: schema.customTagMappings.resourceId, tagId: schema.customTagMappings.tagId })
    .from(schema.customTagMappings)
    .where(and(eq(schema.customTagMappings.workspaceId, workspaceId), inArray(schema.customTagMappings.tagId, tagIds)));
  if (mode === "any") return [...new Set(rows.map((r) => r.resourceId))];
  const counts = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = counts.get(r.resourceId) ?? new Set();
    s.add(r.tagId);
    counts.set(r.resourceId, s);
  }
  return [...counts.entries()].filter(([, s]) => tagIds.every((t) => s.has(t))).map(([id]) => id);
}
