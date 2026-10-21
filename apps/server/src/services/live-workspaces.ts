// Workspaces still in use: not deleted, and owned by an account that's neither turned off nor deleted. Background work
// (sending, inbox sync, agents, automations, webhooks, tasks…) leaves the others alone. Nothing is changed in them, so
// turning an account back on picks up where it stopped.
import { eq, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db, schema } from "../db/client";

const W = schema.workspaces;
const U = schema.users;

let cache: { at: number; dead: Set<string> } | null = null;

/** Workspaces background work must skip: deleted, or their owner deleted or turned off. Cached for a few seconds. */
export async function stoppedWorkspaces(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 10_000) return cache.dead;
  const rows = await db
    .select({ id: W.id })
    .from(W)
    .leftJoin(U, eq(U.id, W.ownerId))
    .where(or(isNotNull(W.deletedAt), isNull(U.id), isNotNull(U.deletedAt), isNotNull(U.disabledAt)));
  cache = { at: Date.now(), dead: new Set(rows.map((r) => r.id)) };
  return cache.dead;
}

/** After deleting a workspace or turning an account off or on, so the loops see it on their next pass. */
export function forgetStoppedWorkspaces() {
  cache = null;
}

export async function workspaceInUse(id: string): Promise<boolean> {
  return !(await stoppedWorkspaces()).has(id);
}

/** A query condition that keeps rows of workspaces in use (undefined when all of them are). */
export async function inUse(workspaceColumn: SQLiteColumn): Promise<SQL | undefined> {
  const dead = await stoppedWorkspaces();
  return dead.size ? notInArray(workspaceColumn, [...dead]) : undefined;
}
