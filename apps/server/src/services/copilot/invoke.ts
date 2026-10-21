// How copilot tools reach the app's API: an in-process request (Fastify inject) carrying the user's own
// session, so every tool gets exactly the user's permissions, validation and audit trail.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { SESSION_COOKIE } from "../../http/auth";
import { randomToken, sha256 } from "../../lib/ids";
import { ToolError, type Invoke } from "./tools";

let appRef: FastifyInstance | null = null;
let building: Promise<FastifyInstance> | null = null;

/** Registered by the copilot routes; a standalone worker builds its own (unlistened) app on first use. */
export function setCopilotApp(app: FastifyInstance) {
  appRef = app;
}

async function app(): Promise<FastifyInstance> {
  if (appRef) return appRef;
  building ??= (async () => {
    const { buildApp } = await import("../../http/app");
    const a = await buildApp();
    await a.ready();
    return a;
  })();
  appRef = await building;
  return appRef;
}

export function invokerFor(sessionToken: string, workspaceId: string): Invoke {
  return async <T>(method: string, url: string, body?: unknown) => {
    const res = await (await app()).inject({
      method: method as "GET",
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        "x-rs-csrf": "1",
        "x-workspace-id": workspaceId,
        "user-agent": "copilot",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let data: unknown = null;
    try {
      data = res.body ? JSON.parse(res.body) : null;
    } catch {
      data = res.body;
    }
    if (res.statusCode >= 400) {
      const message = (data as { message?: string } | null)?.message ?? `Request failed (${res.statusCode})`;
      throw new ToolError(res.statusCode === 403 ? `You don't have permission for this: ${message}` : message, res.statusCode);
    }
    return data as T;
  };
}

/** A short-lived session for work that runs without the user present (scheduled tasks). */
export async function withInternalSession<T>(userId: string, workspaceId: string, f: (token: string) => Promise<T>): Promise<T> {
  const token = randomToken(32);
  const [session] = await db
    .insert(schema.sessions)
    .values({ userId, tokenHash: sha256(token), currentWorkspaceId: workspaceId, userAgent: "copilot-task", lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60_000) })
    .returning();
  try {
    return await f(token);
  } finally {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session!.id));
  }
}
