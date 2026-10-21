import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { clientIp } from "../http/util";

export interface AuditInput {
  workspaceId: string;
  activityType: number;
  req?: FastifyRequest;
  userId?: string | null;
  affectedCount?: number | null;
  campaignId?: string | null;
  webhookId?: string | null;
  subsequenceId?: string | null;
  listId?: string | null;
  metadata?: Record<string, unknown>;
}

const displayName = (u: { firstName: string; lastName: string; email: string }) => `${u.firstName} ${u.lastName}`.trim() || u.email;

/** Who did something, for records that show it later ("Deleted by …"): the person, or the API key by its name. */
export interface Actor {
  userId: string | null;
  name: string | null;
}

export function actorOf(req: FastifyRequest): Actor {
  const a = req.auth;
  if (a.user) return { userId: a.user.id, name: displayName(a.user) };
  if (a.apiKey) return { userId: null, name: `API key “${a.apiKey.name}”` };
  return { userId: null, name: null };
}

/** The same for work that runs in the background on someone's behalf (a job started by a user). */
export async function actorForUser(userId: string | null): Promise<Actor> {
  if (!userId) return { userId: null, name: null };
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return { userId, name: u ? displayName(u) : null };
}

export async function audit(input: AuditInput): Promise<void> {
  const a = input.req?.auth;
  const user = a?.user;
  try {
    // Sign-ins are logged before the session exists, so the name comes from the user id.
    let userName = user ? displayName(user) : null;
    if (!userName && input.userId) {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
      userName = u ? displayName(u) : null;
    }
    await db.insert(schema.auditLogs).values({
      workspaceId: input.workspaceId,
      activityType: input.activityType,
      userId: input.userId ?? user?.id ?? null,
      userName,
      ipAddress: input.req ? clientIp(input.req) : "",
      userAgent: input.req ? String(input.req.headers["user-agent"] ?? "").slice(0, 300) : null,
      fromApi: a?.via === "api_key" || a?.via === "oauth",
      apiKeyId: a?.apiKey?.id ?? null,
      affectedCount: input.affectedCount ?? null,
      campaignId: input.campaignId ?? null,
      webhookId: input.webhookId ?? null,
      subsequenceId: input.subsequenceId ?? null,
      listId: input.listId ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    console.error("audit log failed", err);
  }
}
