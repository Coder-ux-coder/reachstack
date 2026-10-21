// Settings → Billing & usage: plan overview, Stripe Checkout / customer portal, cancellation, and the
// Stripe webhook. Without STRIPE_SECRET_KEY every workspace is self-hosted and unlimited.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, PLANS, planById, VERIFICATION_CREDIT_PACKS } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { badRequest, HttpError, notFound } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { iso } from "../lib/time";
import { audit } from "../services/audit";
import { creditBalance, monthlyEmailsSent, uploadedContacts, workspaceLimits } from "../services/billing-limits";
import { ensureCustomer, handleStripeEvent, stripe, stripeEnabled, verifyStripeSignature } from "../services/stripe";

export default async function billingRoutes(app: FastifyInstance) {
  const read = { perm: "billing" as const };
  const manage = { perm: "billing" as const, admin: true };
  const back = (q: string) => `${config.webUrl}/app/settings/billing?${q}`;

  app.get("/api/app/billing/overview", { config: read }, async (req) => {
    const c = ctx(req);
    const ws = c.workspace;
    const [limits, contacts, emails, credits, verification, visitors, accounts, subs, invoices] = await Promise.all([
      workspaceLimits(ws.id),
      uploadedContacts(ws.id),
      monthlyEmailsSent(ws.id),
      creditBalance(ws.id, "credits"),
      creditBalance(ws.id, "verification"),
      creditBalance(ws.id, "visitors"),
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.emailAccounts)
        .where(eq(schema.emailAccounts.workspaceId, ws.id))
        .then((r) => Number(r[0]?.n ?? 0)),
      db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.workspaceId, ws.id), ne(schema.subscriptions.status, "cancelled"))),
      db.select().from(schema.invoices).where(eq(schema.invoices.workspaceId, ws.id)).orderBy(desc(schema.invoices.createdAt)).limit(50),
    ]);
    return {
      stripe_enabled: stripeEnabled(),
      self_hosted: limits.self_hosted,
      on_trial: limits.on_trial,
      trial_expired: limits.trial_expired,
      trial_ends_at: iso(ws.trialEndsAt),
      plan_ids: ws.planIds ?? {},
      subscriptions: subs.map((s) => ({
        id: s.id,
        product: s.product,
        plan_id: s.planId,
        plan_name: planById(s.planId)?.name ?? s.planId,
        interval: s.interval,
        status: s.status,
        current_period_end: iso(s.currentPeriodEnd),
        cancel_at_period_end: s.cancelAtPeriodEnd,
      })),
      usage: {
        uploaded_contacts: { used: contacts, limit: limits.uploaded_contacts },
        monthly_emails: { used: emails, limit: limits.monthly_emails },
        email_accounts: { used: accounts, limit: limits.email_accounts },
        credits: { balance: limits.self_hosted ? null : credits, monthly: limits.monthly_credits },
        verification_credits: { balance: limits.self_hosted ? null : verification },
        visitor_credits: { balance: limits.self_hosted ? null : visitors, limit: limits.identified_visitors },
      },
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, description: i.description, amount: i.amount, currency: i.currency, status: i.status, pdf_url: i.pdfUrl, created_at: iso(i.createdAt) })),
      plans: PLANS,
      verification_packs: VERIFICATION_CREDIT_PACKS,
    };
  });

  /** Recent credit movements for one pool (purchases, plan refills, usage, refunds). */
  app.get("/api/app/billing/credit-ledger", { config: read }, async (req) => {
    const q = query(req, z.object({ pool: z.enum(["credits", "verification", "visitors"]).default("credits"), limit: zInt(1, 200).optional() }));
    const L = schema.creditLedger;
    const rows = await db
      .select()
      .from(L)
      .where(and(eq(L.workspaceId, ctx(req).wsId), eq(L.pool, q.pool)))
      .orderBy(desc(L.createdAt))
      .limit(q.limit ?? 50);
    return rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, ref_id: r.refId, created_at: iso(r.createdAt) }));
  });

  /** Starts Stripe Checkout for a plan; the webhook activates it once paid. */
  app.post("/api/app/billing/checkout", { config: manage }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ plan_id: z.string(), interval: z.enum(["month", "year"]).default("month") }));
    const plan = planById(b.plan_id);
    if (!plan) throw notFound("Plan");
    if (c.workspace.selfHosted) throw badRequest("This workspace is self-hosted and already unlimited");
    const customer = await ensureCustomer(c.workspace, c.user.email);
    const unit = Math.round((b.interval === "year" ? plan.yearly_price * 12 : plan.monthly_price) * 100);
    const meta = { workspace_id: c.wsId, plan_id: plan.id, product: plan.product, interval: b.interval };
    const session = await stripe<{ url: string }>("POST", "/checkout/sessions", {
      mode: "subscription",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: unit, recurring: { interval: b.interval }, product_data: { name: `${config.brandName} ${plan.name}` } } }],
      success_url: back("checkout=success"),
      cancel_url: back("checkout=cancelled"),
      allow_promotion_codes: true,
      metadata: meta,
      subscription_data: { metadata: meta },
    });
    return { url: session.url };
  });

  /** One-time purchase of verification credits. */
  app.post("/api/app/billing/credit-packs", { config: manage }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ pack_id: z.string() }));
    const pack = VERIFICATION_CREDIT_PACKS.find((p) => p.id === b.pack_id);
    if (!pack) throw notFound("Credit pack");
    if (c.workspace.selfHosted) throw badRequest("This workspace is self-hosted and already unlimited");
    const customer = await ensureCustomer(c.workspace, c.user.email);
    const session = await stripe<{ url: string }>("POST", "/checkout/sessions", {
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(pack.price * 100), product_data: { name: `${pack.credits.toLocaleString("en-US")} verification credits` } } }],
      success_url: back("checkout=success"),
      cancel_url: back("checkout=cancelled"),
      metadata: { workspace_id: c.wsId, pool: "verification", credits: String(pack.credits) },
    });
    return { url: session.url };
  });

  /** Stripe's customer portal: payment methods, invoices, billing details. */
  app.post("/api/app/billing/portal", { config: manage }, async (req) => {
    const c = ctx(req);
    if (!c.workspace.stripeCustomerId) throw badRequest("There's no billing account yet. Choose a plan first.");
    const s = await stripe<{ url: string }>("POST", "/billing_portal/sessions", { customer: c.workspace.stripeCustomerId, return_url: back("portal=done") });
    return { url: s.url };
  });

  /** Cancels at the end of the paid period (or resumes a scheduled cancellation). */
  app.post("/api/app/billing/subscriptions/:id/cancel", { config: { ...manage, owner: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ resume: z.boolean().default(false), reason: z.string().max(100).optional(), feedback: z.string().max(2_000).optional() }));
    const [sub] = await db
      .select()
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.id, (req.params as { id: string }).id), eq(schema.subscriptions.workspaceId, c.wsId)))
      .limit(1);
    if (!sub?.stripeSubscriptionId) throw notFound("Subscription");
    await stripe("POST", `/subscriptions/${sub.stripeSubscriptionId}`, { cancel_at_period_end: !b.resume });
    await db.update(schema.subscriptions).set({ cancelAtPeriodEnd: !b.resume }).where(eq(schema.subscriptions.id, sub.id));
    if (!b.resume) await audit({ workspaceId: c.wsId, activityType: AuditActivity.SUBSCRIPTION_CANCEL_REQUESTED, req, metadata: { action: "subscription_cancel_requested", plan_id: sub.planId, reason: b.reason ?? null, feedback: b.feedback ?? null } });
    return { ok: true };
  });

  // Stripe sends the raw JSON body; it must be verified before it's parsed.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "string" }, (_req, raw, done) => done(null, raw));
    hook.post("/api/webhooks/stripe", { config: { auth: "public" } }, async (req, reply) => {
      const secret = config.stripe.webhookSecret;
      if (!secret) throw new HttpError(503, "Stripe webhooks aren't configured");
      const raw = String(req.body ?? "");
      if (!verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) throw new HttpError(400, "Invalid signature");
      await handleStripeEvent(JSON.parse(raw));
      return reply.send({ received: true });
    });
  });
}
