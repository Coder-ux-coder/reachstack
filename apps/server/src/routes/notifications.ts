// The bell in the app header: the signed-in person's notifications in the current workspace. Browser sessions only
// (notifications belong to a person, and API keys have none).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ctx } from "../http/context";
import { notFound } from "../http/errors";
import { params, query, zBool } from "../http/util";
import { listNotifications, markAllRead, markRead, unreadCount } from "../services/notifications";

export default async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/app/notifications", async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), before: z.string().max(64).optional(), unread: zBool }));
    return listNotifications(c.wsId, c.user.id, { limit: q.limit, before: q.before, unreadOnly: !!q.unread });
  });

  app.post("/api/app/notifications/:id/read", async (req) => {
    const c = ctx(req);
    const p = params(req, z.object({ id: z.string().min(1).max(64) }));
    if (!(await markRead(c.wsId, c.user.id, p.id))) throw notFound("Notification");
    return { ok: true, unread: await unreadCount(c.wsId, c.user.id) };
  });

  app.post("/api/app/notifications/read-all", async (req) => {
    const c = ctx(req);
    return { ok: true, updated: await markAllRead(c.wsId, c.user.id), unread: 0 };
  });
}
