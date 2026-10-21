// Who leads, replies and tasks can be assigned to: people in the workspace.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, schema } from "../db/client";
import { badRequest } from "../http/errors";

const M = schema.workspaceMembers;

/** Invitation links work for 7 days from when they were sent (or last sent again). */
const INVITE_TTL_MS = 7 * 86_400_000;

export function inviteExpired(m: { accepted: boolean; invitedAt: Date | null; updatedAt: Date }): boolean {
  return !m.accepted && Date.now() - (m.invitedAt ?? m.updatedAt).getTime() > INVITE_TTL_MS;
}

/**
 * Removes seats taken through a right that has gone (see workspaceMembers.enteredVia): every seat taken that way, or
 * only one person's, or only those in one workspace. A seat that became the workspace's owner stays. Returns how many
 * were removed.
 */
export async function removeEnteredSeats(via: string, only: { userId?: string; workspaceId?: string } = {}): Promise<number> {
  const gone = await db
    .delete(M)
    .where(
      and(
        eq(M.enteredVia, via),
        only.userId ? eq(M.userId, only.userId) : undefined,
        only.workspaceId ? eq(M.workspaceId, only.workspaceId) : undefined,
        ne(M.role, "owner"),
      ),
    )
    .returning({ userId: M.userId, workspaceId: M.workspaceId });
  for (const s of gone) if (s.userId) await releaseMember(s.userId, s.workspaceId);
  return gone.length;
}

/**
 * Someone left a workspace (or every one, when their account went): its phone numbers stop ringing their personal
 * phone. Leads, tasks and deals keep them as owner for the record; nothing is sent to them any more.
 */
export async function releaseMember(userId: string, workspaceId?: string): Promise<void> {
  const PN = schema.crmPhoneNumbers;
  await db
    .update(PN)
    .set({ assignedTo: null })
    .where(and(eq(PN.assignedTo, userId), workspaceId ? eq(PN.workspaceId, workspaceId) : undefined));
}

/**
 * Turns the request away (400) when any of these user ids isn't someone in the workspace who can work in it now: a
 * member who accepted, with an account that's on. Empty values are left alone.
 */
export async function assertMembers(workspaceId: string, ids: Array<string | null | undefined>, field: string): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return;
  const U = schema.users;
  const rows = await db
    .select({ userId: M.userId })
    .from(M)
    .innerJoin(U, eq(U.id, M.userId))
    .where(and(eq(M.workspaceId, workspaceId), inArray(M.userId, wanted), eq(M.accepted, true), isNull(U.disabledAt), isNull(U.deletedAt)));
  const found = new Set(rows.map((r) => r.userId));
  const missing = wanted.find((id) => !found.has(id));
  if (missing) throw badRequest(`${field}: ${missing} is not a member of this workspace`);
}

/** The ids among `ids` of people who can be given work in the workspace now (see assertMembers). */
export async function currentMembers(workspaceId: string, ids: Array<string | null | undefined>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Set();
  const U = schema.users;
  const rows = await db
    .select({ userId: M.userId })
    .from(M)
    .innerJoin(U, eq(U.id, M.userId))
    .where(and(eq(M.workspaceId, workspaceId), inArray(M.userId, wanted), eq(M.accepted, true), isNull(U.disabledAt), isNull(U.deletedAt)));
  return new Set(rows.map((r) => r.userId!));
}
