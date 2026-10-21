// Stripe over its REST API (no SDK): form-encoded requests, webhook signature checks, and the handlers
// that keep subscriptions, plans, invoices and credit balances in step with what Stripe reports.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { planById } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { badRequest, HttpError } from "../http/errors";

const API = "https://api.stripe.com/v1";
// Pinned so subscription objects keep current_period_end at the top level.
const STRIPE_VERSION = "2024-06-20";

export const stripeEnabled = () => !!config.stripe.secretKey;

/** Stripe's bracketed form encoding: {a: {b: [{c: 1}]}} → a[b][0][c]=1 */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") out.push(...encode(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") out.push(...encode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!config.stripe.secretKey) throw badRequest("Billing isn't set up on this server");
  const qs = encode(params).join("&");
  const res = await fetch(method === "POST" ? `${API}${path}` : `${API}${path}${qs ? `?${qs}` : ""}`, {
    method,
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
      "stripe-version": STRIPE_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? qs : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, `Stripe: ${json.error?.message ?? res.statusText}`, "stripe_error");
  return json;
}

/** Checks the Stripe-Signature header (t=…,v1=…) against the raw body. */
export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  const sigs = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

type Workspace = typeof schema.workspaces.$inferSelect;

/** The workspace's Stripe customer, created on first use. */
export async function ensureCustomer(ws: Workspace, email: string): Promise<string> {
  if (ws.stripeCustomerId) return ws.stripeCustomerId;
  const c = await stripe<{ id: string }>("POST", "/customers", { email, name: ws.name, metadata: { workspace_id: ws.id } });
  await db.update(schema.workspaces).set({ stripeCustomerId: c.id }).where(eq(schema.workspaces.id, ws.id));
  return c.id;
}

const STATUS: Record<string, string> = { active: "active", trialing: "trialing", past_due: "past_due", unpaid: "past_due", canceled: "cancelled", incomplete_expired: "cancelled", incomplete: "past_due", paused: "past_due" };

interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number }> };
  metadata?: Record<string, string>;
  customer: string;
}

async function setPlan(workspaceId: string, product: string, planId: string | null) {
  const [ws] = await db.select({ planIds: schema.workspaces.planIds }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const planIds = { ...(ws?.planIds ?? {}), [product]: planId };
  if (planId === null) delete planIds[product];
  await db.update(schema.workspaces).set({ planIds }).where(eq(schema.workspaces.id, workspaceId));
}

async function syncSubscription(sub: StripeSubscription, fallback?: { workspaceId: string; product: string; planId: string; interval: string }) {
  const S = schema.subscriptions;
  const [row] = await db.select().from(S).where(eq(S.stripeSubscriptionId, sub.id)).limit(1);
  const meta = sub.metadata ?? {};
  const workspaceId = row?.workspaceId ?? meta.workspace_id ?? fallback?.workspaceId;
  const product = row?.product ?? meta.product ?? fallback?.product;
  const planId = meta.plan_id ?? row?.planId ?? fallback?.planId;
  if (!workspaceId || !product || !planId) return;
  const status = STATUS[sub.status] ?? "active";
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  const values = {
    status,
    planId,
    interval: meta.interval ?? row?.interval ?? fallback?.interval ?? "month",
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
  };
  if (row) await db.update(S).set(values).where(eq(S.id, row.id));
  else await db.insert(S).values({ workspaceId, product, stripeSubscriptionId: sub.id, ...values });
  if (status === "cancelled") {
    const [ws] = await db.select({ planIds: schema.workspaces.planIds }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
    if (ws?.planIds?.[product] === planId) await setPlan(workspaceId, product, null);
  } else {
    await setPlan(workspaceId, product, planId);
    // A new subscription for a product replaces the old one; unused time is credited back by Stripe.
    const older = await db
      .select()
      .from(S)
      .where(and(eq(S.workspaceId, workspaceId), eq(S.product, product), ne(S.stripeSubscriptionId, sub.id), ne(S.status, "cancelled")));
    for (const o of older) {
      if (o.stripeSubscriptionId) await stripe("DELETE", `/subscriptions/${o.stripeSubscriptionId}`, { prorate: true }).catch((e) => console.error("[stripe] cancel replaced subscription", e));
      await db.update(S).set({ status: "cancelled" }).where(eq(S.id, o.id));
    }
  }
}

async function grantOnce(workspaceId: string, pool: string, amount: number, reason: string, refId: string) {
  const L = schema.creditLedger;
  const [seen] = await db.select({ id: L.id }).from(L).where(and(eq(L.workspaceId, workspaceId), eq(L.refId, refId), eq(L.reason, reason))).limit(1);
  if (!seen && amount > 0) await db.insert(L).values({ workspaceId, pool, delta: amount, reason, refId });
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export async function handleStripeEvent(ev: StripeEvent): Promise<void> {
  const o = ev.data.object;
  switch (ev.type) {
    case "checkout.session.completed": {
      const meta = (o.metadata ?? {}) as Record<string, string>;
      if (!meta.workspace_id) return;
      if (o.mode === "subscription" && typeof o.subscription === "string") {
        const sub = await stripe<StripeSubscription>("GET", `/subscriptions/${o.subscription}`);
        await syncSubscription(sub, { workspaceId: meta.workspace_id, product: meta.product!, planId: meta.plan_id!, interval: meta.interval ?? "month" });
      } else if (o.mode === "payment" && o.payment_status === "paid" && meta.pool && meta.credits) {
        await grantOnce(meta.workspace_id, meta.pool, Number(meta.credits), "purchase", String(o.id));
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(o as unknown as StripeSubscription);
      return;
    case "invoice.paid": {
      const subId = typeof o.subscription === "string" ? o.subscription : null;
      const [sub] = subId ? await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, subId)).limit(1) : [];
      const [ws] = sub ? [] : await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.stripeCustomerId, String(o.customer))).limit(1);
      const workspaceId = sub?.workspaceId ?? ws?.id;
      if (!workspaceId) return;
      const [known] = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.stripeInvoiceId, String(o.id))).limit(1);
      if (!known) {
        await db.insert(schema.invoices).values({
          workspaceId,
          number: String(o.number ?? o.id),
          description: sub ? (planById(sub.planId)?.name ?? sub.planId) : "Purchase",
          amount: Number(o.amount_paid ?? 0) / 100,
          currency: String(o.currency ?? "usd"),
          status: "paid",
          pdfUrl: (o.invoice_pdf as string | null) ?? (o.hosted_invoice_url as string | null) ?? null,
          stripeInvoiceId: String(o.id),
        });
      }
      // Each paid period refills the plan's monthly credits.
      const plan = sub ? planById(sub.planId) : undefined;
      const monthly = plan?.limits.monthly_credits;
      if (sub && monthly) await grantOnce(workspaceId, "credits", sub.interval === "year" ? monthly * 12 : monthly, "plan_period", String(o.id));
      if (sub && plan?.limits.verification_credits) await grantOnce(workspaceId, "verification", plan.limits.verification_credits, "plan_period", String(o.id));
      return;
    }
    case "invoice.payment_failed": {
      const subId = typeof o.subscription === "string" ? o.subscription : null;
      if (subId) await db.update(schema.subscriptions).set({ status: "past_due" }).where(eq(schema.subscriptions.stripeSubscriptionId, subId));
      return;
    }
    default:
      return;
  }
}

