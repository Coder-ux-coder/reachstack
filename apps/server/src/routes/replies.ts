// Replies that arrived without a lead (from another address, a forward, a colleague): likely leads, linking the reply
// to one, or making its sender a new lead. Either way that lead's emails stop, as for any reply.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ctx } from "../http/context";
import { body, query } from "../http/util";
import { serializeLead } from "../services/leads";
import { attachReplyToLead, createLeadFromReply, leadSuggestions, receivedEmail } from "../services/replies";

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

const linked = (r: { email: { id: string; threadId: string | null }; lead: Parameters<typeof serializeLead>[0] }) => ({
  email_id: r.email.id,
  thread_id: r.email.threadId,
  lead: serializeLead(r.lead),
});

export default async function replyRoutes(app: FastifyInstance) {
  const base = "/api/app/replies/:id";

  app.get(`${base}/lead-suggestions`, { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ q: z.string().trim().max(200).optional() }));
    const email = await receivedEmail(c.wsId, idOf(req));
    return { lead_id: email.leadId, items: email.leadId ? [] : await leadSuggestions(c.wsId, email, q.q) };
  });

  app.post(`${base}/attach`, { config: { perm: "unibox", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ lead_id: z.string().min(1) }));
    return linked(await attachReplyToLead(c.wsId, idOf(req), b.lead_id));
  });

  app.post(`${base}/create-lead`, { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        campaign_id: z.string().min(1).optional(),
        list_id: z.string().min(1).optional(),
        first_name: z.string().trim().max(200).optional(),
        last_name: z.string().trim().max(200).optional(),
        company_name: z.string().trim().max(300).optional(),
      }),
    );
    return linked(
      await createLeadFromReply(c.wsId, idOf(req), { campaignId: b.campaign_id, listId: b.list_id, firstName: b.first_name, lastName: b.last_name, companyName: b.company_name }, c.userId),
    );
  });
}
