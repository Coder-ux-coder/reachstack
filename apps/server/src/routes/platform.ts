// Smaller API v2 groups: OAuth connect sessions, domain forwarding, workspace billing details,
// CRM phone numbers and the unified "agent items" list (AI agents + automations).
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, PLANS, planById, type ProductKey } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { may } from "../http/auth";
import { assertFound, badRequest, conflict, HttpError, notFound } from "../http/errors";
import { body, params, query, zBool, zInt } from "../http/util";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";
import { buildAuthUrl } from "../mail/oauth";
import { agentPermission, deleteAgent, deleteSalesAgent } from "../services/agents/delete";
import { audit } from "../services/audit";
import { creditBalance, uploadedContacts, workspaceLimits } from "../services/billing-limits";
import { forwardingFor, invalidateForwardingCache, isHostname, normalizeDomain, serializeForwarding, workspaceDomains } from "../services/domains";
import { countryOfNumber, twilioConfigured, twilioRequest } from "../services/twilio";

export const AI_AGENT_TYPES: Record<number, string> = {
  1: "AI Inbox Manager",
  2: "AI Sales Agent",
  3: "AI Deliverability Agent",
  4: "AI Affiliate Agent",
  6: "AI Lead Finder Agent",
  7: "AI Recruiting Agent",
  8: "AI Investment Agent",
  9: "AI User Research Agent",
  10: "AI Partnership Agent",
  11: "AI Voice Agent",
};

type EngageStatus = "Active" | "Paused" | "Draft" | "Error";
interface EngageItem {
  id: string;
  resource_id: string;
  type: "ai_agent" | "automation";
  workspace_id: string;
  name: string;
  status: EngageStatus;
  metadata: Record<string, unknown>;
  timestamp_created: string | null;
  timestamp_updated: string | null;
  tags: null;
}

async function engageItems(workspaceId: string): Promise<EngageItem[]> {
  const [agents, salesAgents, flows] = await Promise.all([
    db.select().from(schema.aiAgents).where(eq(schema.aiAgents.workspaceId, workspaceId)),
    db.select().from(schema.aiSalesAgents).where(eq(schema.aiSalesAgents.workspaceId, workspaceId)),
    db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)),
  ]);
  const base = (id: string, createdAt: Date, updatedAt: Date) => ({ id, resource_id: id, workspace_id: workspaceId, timestamp_created: iso(createdAt), timestamp_updated: iso(updatedAt), tags: null });
  return [
    ...agents.map((a) => ({
      ...base(a.id, a.createdAt, a.updatedAt),
      type: "ai_agent" as const,
      name: a.name,
      status: (a.payload?.draft ? "Draft" : a.status === 1 ? "Active" : a.status === -1 ? "Error" : "Paused") as EngageStatus,
      metadata: { ai_agent_type: a.type, ai_agent_type_label: AI_AGENT_TYPES[a.type] ?? null, configuration_mode: a.configurationMode, last_run_at: iso(a.lastRunAt) },
    })),
    ...salesAgents.map((a) => ({
      ...base(a.id, a.createdAt, a.updatedAt),
      type: "ai_agent" as const,
      name: a.name,
      status: (a.config?.draft ? "Draft" : a.status === 1 ? "Active" : a.status === -1 ? "Error" : "Paused") as EngageStatus,
      metadata: { ai_agent_type: a.agentType, ai_agent_type_label: AI_AGENT_TYPES[a.agentType] ?? null, phase: a.phase, last_action_at: iso(a.lastActionAt) },
    })),
    ...flows.map((w) => ({
      ...base(w.id, w.createdAt, w.updatedAt),
      type: "automation" as const,
      name: w.name,
      status: (w.status === "active" ? "Active" : w.status === "paused" ? "Paused" : "Draft") as EngageStatus,
      metadata: { trigger_type: w.triggerType, run_count: w.runCount, last_run_at: iso(w.lastRunAt) },
    })),
  ].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Subscription summary for one product (null fields when the product is not subscribed). */
function productSummary(planId: string | null | undefined, sub: typeof schema.subscriptions.$inferSelect | undefined) {
  const plan = planById(planId);
  return {
    plan_name: plan?.name ?? null,
    interval: plan ? ((sub?.interval as "month" | "year" | undefined) ?? "month") : null,
    current_period_end: sub?.currentPeriodEnd ? Math.floor(sub.currentPeriodEnd.getTime() / 1000) : null,
    cancel_at_time: sub?.cancelAtPeriodEnd && sub.currentPeriodEnd ? Math.floor(sub.currentPeriodEnd.getTime() / 1000) : null,
    price_in_dollars: plan ? (sub?.interval === "year" ? plan.yearly_price * 12 : plan.monthly_price) : null,
    product_id: plan?.id ?? null,
  };
}

export default async function platformRoutes(app: FastifyInstance) {
  // ---------- OAuth connect sessions (for API clients that open the consent page themselves) ----------

  app.post("/api/v2/oauth/:provider/init", { config: { scope: ["accounts", "create"], perm: "accounts", write: true } }, async (req) => {
    const { provider } = params(req, z.object({ provider: z.enum(["google", "microsoft"]) }));
    const c = ctx(req);
    const id = uuidv7();
    // Throws a clear 400 when the provider's OAuth app is not configured on this server.
    const auth_url = buildAuthUrl({ provider, purpose: "connect_account", workspace_id: c.wsId, user_id: c.userId ?? undefined, session_id: id });
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await db.insert(schema.oauthSessions).values({ id, workspaceId: c.wsId, userId: c.userId, provider, expiresAt });
    return { session_id: id, auth_url, expires_at: iso(expiresAt) };
  });

  app.get("/api/v2/oauth/session/status/:sessionId", { config: { scope: ["accounts", "read"], perm: "accounts" } }, async (req) => {
    const { sessionId } = params(req, z.object({ sessionId: z.string() }));
    const [row] = await db
      .select()
      .from(schema.oauthSessions)
      .where(and(eq(schema.oauthSessions.id, sessionId), eq(schema.oauthSessions.workspaceId, ctx(req).wsId)))
      .limit(1);
    const s = assertFound(row, "OAuth session");
    const status = s.status === "pending" && s.expiresAt.getTime() < Date.now() ? "expired" : s.status;
    return {
      status,
      ...(s.email ? { email: s.email } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.error ? { error: s.error, error_description: s.errorDescription ?? undefined } : {}),
    };
  });

  // ---------- Domain forwarding ----------

  const domainParam = async (req: Parameters<typeof ctx>[0]) => {
    const c = ctx(req);
    const domain = normalizeDomain((req.params as { domain: string }).domain);
    if (!(await workspaceDomains(c.wsId)).has(domain)) throw notFound("Domain");
    return { c, domain };
  };

  app.get("/api/v2/domains/:domain/forwarding", { config: { scope: ["accounts", "read"], perm: "accounts" } }, async (req) => {
    const { c, domain } = await domainParam(req);
    return serializeForwarding(domain, await forwardingFor(c.wsId, domain));
  });

  app.put("/api/v2/domains/:domain/forwarding", { config: { scope: ["accounts", "update"], perm: "accounts", write: true } }, async (req) => {
    const { c, domain } = await domainParam(req);
    const b = body(req, z.object({ forwarding_domain: z.string().min(3).max(253), forwarding_mode: z.enum(["redirect", "stealth"]).default("redirect") }));
    const target = normalizeDomain(b.forwarding_domain);
    if (!isHostname(target)) throw badRequest("forwarding_domain must be a domain name like example.com");
    if (target === domain) throw badRequest("The forwarding domain must be different from the domain itself");
    const [row] = await db
      .insert(schema.domainForwarding)
      .values({ workspaceId: c.wsId, domain, forwardingDomain: target, forwardingMode: b.forwarding_mode })
      // A domain forwards one way for the whole installation: another workspace's setting isn't taken over.
      .onConflictDoUpdate({
        target: schema.domainForwarding.domain,
        set: { forwardingDomain: target, forwardingMode: b.forwarding_mode, updatedAt: new Date() },
        setWhere: eq(schema.domainForwarding.workspaceId, c.wsId),
      })
      .returning();
    if (!row) throw conflict(`${domain} already forwards from another workspace on this installation. It can be changed there.`);
    await db
      .update(schema.dfyOrders)
      .set({ forwardingDomain: target, forwardingMode: b.forwarding_mode })
      .where(and(eq(schema.dfyOrders.workspaceId, c.wsId), eq(schema.dfyOrders.domain, domain)));
    invalidateForwardingCache(domain);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.DOMAIN_FORWARDING_UPDATED, req, userId: c.userId, metadata: { domain, forwarding_domain: target, forwarding_mode: b.forwarding_mode } });
    return serializeForwarding(domain, row);
  });

  app.delete("/api/v2/domains/:domain/forwarding", { config: { scope: ["accounts", "update"], perm: "accounts", write: true } }, async (req) => {
    const { c, domain } = await domainParam(req);
    await db.delete(schema.domainForwarding).where(and(eq(schema.domainForwarding.workspaceId, c.wsId), eq(schema.domainForwarding.domain, domain)));
    await db
      .update(schema.dfyOrders)
      .set({ forwardingDomain: null, forwardingMode: null })
      .where(and(eq(schema.dfyOrders.workspaceId, c.wsId), eq(schema.dfyOrders.domain, domain)));
    invalidateForwardingCache(domain);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.DOMAIN_FORWARDING_UPDATED, req, userId: c.userId, metadata: { domain, removed: true } });
    return serializeForwarding(domain, null);
  });

  // ---------- Workspace billing ----------

  app.get("/api/v2/workspace-billing/plan-details", { config: { scope: ["workspace_billing", "read"], perm: "billing" } }, async (req) => {
    const c = ctx(req);
    const ws = c.workspace;
    const [limits, leadCount, credits, subs] = await Promise.all([
      workspaceLimits(ws.id),
      uploadedContacts(ws.id),
      creditBalance(ws.id, "credits"),
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ws.id)),
    ]);
    const planIds = ws.planIds ?? {};
    const subFor = (product: ProductKey) => subs.find((s) => s.product === product && s.status !== "cancelled");
    const selfHostedName = limits.self_hosted ? "Self-hosted (unlimited)" : limits.on_trial ? "Trial" : null;
    const outreach = productSummary(planIds.outreach, subFor("outreach"));
    const bundle = productSummary(planIds.bundle, subFor("bundle"));
    const creditPlan = productSummary(planIds.credits, subFor("credits"));
    const withCredits = (product: ProductKey, limit: number | null) => ({ ...productSummary(planIds[product], subFor(product)), available_credits: limits.self_hosted ? null : credits, plan_limit: limit });
    const leadLimit = limits.uploaded_contacts;
    return {
      organization_id: ws.id,
      organization_name: ws.name,
      // Unlimited limits (self-hosted mode) are reported as null.
      subscriptions: {
        outreach: { ...outreach, plan_name: outreach.plan_name ?? selfHostedName, addons_qty: 0, total_lead_limit: leadLimit, current_lead_count: leadCount, base_lead_limit: leadLimit },
        credits: { ...creditPlan, plan_name: creditPlan.plan_name ?? selfHostedName, total_credits: limits.monthly_credits, available_credits: limits.self_hosted ? null : credits, price_option_id: null },
        bundle: { ...bundle, total_lead_limit: leadLimit, current_lead_count: leadCount, base_lead_limit: leadLimit },
        crm: withCredits("crm", null),
        website_visitors: withCredits("website_visitors", limits.identified_visitors),
        inbox_placement: withCredits("inbox_placement", limits.inbox_placement_tests),
      },
      addons: {
        outreach: { product_id: "addon_contacts_25k", unit_lead_limit: 25_000, existing_quantity: 0, max_quantity: limits.self_hosted ? 0 : 20, interval: "month", can_purchase: !limits.self_hosted, purchase_blocked_reason: limits.self_hosted ? "self_hosted" : null, annual_discount_percent: 20, monthly_pricing_tiers: [] },
        credits: { product_id: "addon_credits_50k", annual_product_id: "addon_credits_50k_annual", unit_credits: 50_000, annual_unit_credits: 600_000, existing_quantity: 0, max_quantity: limits.self_hosted ? 0 : 20, interval: "month", can_purchase: !limits.self_hosted, purchase_blocked_reason: limits.self_hosted ? "self_hosted" : null, monthly_price_in_dollars: 97, annual_price_in_dollars: 931 },
      },
    };
  });

  app.get("/api/v2/workspace-billing/subscription-details", { config: { scope: ["workspace_billing", "read"], perm: "billing" } }, async (req) => {
    const ws = ctx(req).workspace;
    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ws.id));
    const items = subs
      .filter((s) => s.status !== "cancelled")
      .map((s) => {
        const plan = planById(s.planId);
        return {
          workspace_id: ws.id,
          interval: s.interval as "month" | "year",
          quantity: 1,
          product_id: s.planId,
          product_type: s.product === "credits" ? "prt_leadfinder" : "prt_outreach",
          plan_type: "plt_primary",
          current_period_end: s.currentPeriodEnd ? Math.floor(s.currentPeriodEnd.getTime() / 1000) : null,
          cancel_at_time: s.cancelAtPeriodEnd && s.currentPeriodEnd ? Math.floor(s.currentPeriodEnd.getTime() / 1000) : null,
          price_in_dollars: plan ? (s.interval === "year" ? plan.yearly_price * 12 : plan.monthly_price) : null,
          price_id: s.stripeSubscriptionId,
        };
      });
    return { subscriptions: items, all_subs_cancelled: items.length > 0 && items.every((s) => s.cancel_at_time !== null) };
  });

  // Plan catalog for the billing pages.
  app.get("/api/app/billing/plans", { config: { auth: "user" } }, async () => PLANS);

  // ---------- CRM phone numbers ----------

  const serializeNumber = (n: typeof schema.crmPhoneNumbers.$inferSelect) => ({
    id: n.id,
    timestamp_created: iso(n.createdAt),
    organization_id: n.workspaceId,
    phone_number: n.number,
    country: countryOfNumber(n.number),
    locality: n.friendlyName,
    subscription_id: null,
    twilio_sid: n.twilioSid,
    renewal_date: null,
    price: null,
    capabilities: n.capabilities ?? null,
    assigned_to: n.assignedTo,
  });

  app.get("/api/v2/crm-actions/phone-numbers", { config: { scope: ["crm_actions", "read"], perm: "crm" } }, async (req) => {
    const rows = await db.select().from(schema.crmPhoneNumbers).where(eq(schema.crmPhoneNumbers.workspaceId, ctx(req).wsId));
    return rows.map(serializeNumber);
  });

  app.delete("/api/v2/crm-actions/phone-numbers/:id", { config: { scope: ["crm_actions", "delete"], perm: "crm", write: true } }, async (req) => {
    const c = ctx(req);
    const [row] = await db
      .select()
      .from(schema.crmPhoneNumbers)
      .where(and(eq(schema.crmPhoneNumbers.id, (req.params as { id: string }).id), eq(schema.crmPhoneNumbers.workspaceId, c.wsId)))
      .limit(1);
    const n = assertFound(row, "Phone number");
    // keep_in_twilio unlinks the number from this workspace and leaves it in the Twilio account (for numbers used elsewhere).
    const keep = query(req, z.object({ keep_in_twilio: zBool })).keep_in_twilio;
    let cleanupPending = false;
    if (!keep && n.twilioSid && twilioConfigured()) {
      // Releasing the number stops Twilio billing for it.
      await twilioRequest("DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(n.twilioSid)}.json`).catch(() => {
        cleanupPending = true;
      });
    } else if (!keep && n.twilioSid) cleanupPending = true;
    await db.delete(schema.crmPhoneNumbers).where(eq(schema.crmPhoneNumbers.id, n.id));
    return { cleanup_pending: cleanupPending, ...serializeNumber(n) };
  });

  // ---------- Agent items (AI agents + automations) ----------

  app.get("/api/v2/agent-items", { config: { scope: ["agent_items", "read"], perm: "dashboard" } }, async (req) => {
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).optional(),
        starting_after: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        ai_agent_type: zInt().optional(),
        search: z.string().optional(),
      }),
    );
    const types = q.ai_agent_type !== undefined ? ["ai_agent"] : (q.type?.split(",").map((t) => t.trim()).filter(Boolean) ?? []);
    const statuses = q.status?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [];
    const search = q.search?.toLowerCase();
    const items = (await engageItems(ctx(req).wsId)).filter(
      (i) =>
        (!types.length || types.includes(i.type)) &&
        (!statuses.length || statuses.includes(i.status.toLowerCase())) &&
        (q.ai_agent_type === undefined || i.metadata.ai_agent_type === q.ai_agent_type) &&
        (!search || i.name.toLowerCase().includes(search)) &&
        (!q.starting_after || i.id < q.starting_after),
    );
    const limit = q.limit ?? 20;
    const page = items.slice(0, limit);
    return { items: page, next_starting_after: items.length > limit ? page[page.length - 1]!.id : null };
  });

  // Each item needs what deleting it on its own page needs, and goes with the same clean-up.
  app.post("/api/v2/agent-items/bulk-delete", { config: { scope: ["agent_items", "delete"], write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ items: z.array(z.object({ id: z.string(), type: z.enum(["ai_agent", "automation"]).default("ai_agent") })).min(1).max(500) }));
    const deleted: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const item of b.items) {
      if (item.type === "automation") {
        const [flow] = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(and(eq(schema.workflows.id, item.id), eq(schema.workflows.workspaceId, c.wsId))).limit(1);
        if (!flow) failed.push({ id: item.id, reason: "not_found" });
        else if (!may(req, "edit_campaigns")) failed.push({ id: item.id, reason: "forbidden" });
        else {
          await db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, flow.id));
          await db.delete(schema.workflows).where(eq(schema.workflows.id, flow.id));
          deleted.push(item.id);
        }
        continue;
      }
      const [agent] = await db.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.id, item.id), eq(schema.aiAgents.workspaceId, c.wsId))).limit(1);
      if (agent) {
        if (!may(req, agentPermission(agent.type))) failed.push({ id: item.id, reason: "forbidden" });
        else {
          await deleteAgent(agent);
          deleted.push(item.id);
        }
        continue;
      }
      const [sales] = await db.select().from(schema.aiSalesAgents).where(and(eq(schema.aiSalesAgents.id, item.id), eq(schema.aiSalesAgents.workspaceId, c.wsId))).limit(1);
      if (!sales) failed.push({ id: item.id, reason: "not_found" });
      else if (!may(req, "edit_campaigns")) failed.push({ id: item.id, reason: "forbidden" });
      else {
        try {
          await deleteSalesAgent(sales);
          deleted.push(item.id);
        } catch (err) {
          // Still running campaigns: they're deleted or moved out of the agent first.
          if (!(err instanceof HttpError && err.statusCode === 409)) throw err;
          failed.push({ id: item.id, reason: "has_campaigns" });
        }
      }
    }
    return { deleted_ids: deleted, failed };
  });
}
