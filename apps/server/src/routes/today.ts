// The Today page: what goes out today, why not more, the week ahead (services/today.ts), and the tasks the sequences
// ask for (services/sequence-tasks.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { roleAllows } from "@reachstack/shared";
import { ctx } from "../http/context";
import { query, zInt } from "../http/util";
import { effectivePermissions } from "../services/branding";
import { countSequenceTasks, finishSequenceTask, listSequenceTasks } from "../services/sequence-tasks";
import { todayReport } from "../services/today";

export default async function todayRoutes(app: FastifyInstance) {
  app.get("/api/app/today", { config: { perm: "view_campaigns" } }, async (req) => {
    const c = ctx(req);
    const a = req.auth;
    // Mailbox addresses and counters need the email accounts permission (clients and custom roles may not have it).
    const mailboxes = !!a.role && roleAllows(a.role, "accounts", effectivePermissions(a.workspace, a.member));
    return todayReport(c.wsId, { mailboxes });
  });

  app.get("/api/app/sequence-tasks", { config: { perm: "view_campaigns" } }, async (req) => {
    const q = query(req, z.object({ limit: zInt(1, 500).optional() }));
    return listSequenceTasks(ctx(req).wsId, q.limit ?? 100);
  });

  app.get("/api/app/sequence-tasks/count", { config: { perm: "view_campaigns" } }, async (req) => ({ open: await countSequenceTasks(ctx(req).wsId) }));

  // Done or skipped, the lead moves on to the sequence's next step.
  for (const outcome of ["done", "skip"] as const) {
    app.post(`/api/app/sequence-tasks/:id/${outcome}`, { config: { perm: "edit_campaigns", write: true } }, async (req) => {
      const { moved, finished } = await finishSequenceTask(ctx(req).wsId, (req.params as { id: string }).id, outcome === "done" ? "done" : "skipped");
      return { moved, finished };
    });
  }
}
