// Single-use tokens sent in emails (verification, password resets, ownership changes, privacy requests).
// Only a hash is stored; a token works once and until it expires.
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { randomToken, sha256 } from "../lib/ids";

export async function issueToken(type: string, opts: { userId?: string | null; email?: string | null; data?: Record<string, unknown>; ttlMs: number }) {
  const token = randomToken(24);
  await db.insert(schema.authTokens).values({
    type,
    userId: opts.userId ?? null,
    email: opts.email ?? null,
    tokenHash: sha256(token),
    data: opts.data ?? null,
    expiresAt: new Date(Date.now() + opts.ttlMs),
  });
  return token;
}

/** Uses a token up in one step, so two requests with the same link can't both get it. */
export async function consumeToken(type: string, token: string) {
  const T = schema.authTokens;
  const [row] = await db
    .update(T)
    .set({ usedAt: new Date() })
    .where(and(eq(T.tokenHash, sha256(token)), eq(T.type, type), isNull(T.usedAt), gt(T.expiresAt, new Date())))
    .returning();
  return row ?? null;
}
