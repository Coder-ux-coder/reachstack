// Webhooks: queueing matching webhook events, delivery with retries/backoff, and serializers.
import { createHmac } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { AuditActivity, WEBHOOK_EVENT_LABELS, type WebhookPayload } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { uuidv7 } from "../lib/ids";
import { describeFetchError, publicFetch, readCapped } from "../lib/net";
import { iso } from "../lib/time";
import { audit } from "./audit";
import { stoppedWorkspaces } from "./live-workspaces";

export type WebhookRow = typeof schema.webhooks.$inferSelect;
export type WebhookEventRow = typeof schema.webhookEvents.$inferSelect;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const DISABLE_AFTER_FAILURES = 25;
/** At most this many deliveries to one webhook per pass, so a slow or failing endpoint can't hold up the others. */
const PER_HOOK_PER_PASS = 5;
/** The delivery log keeps finished deliveries this long. */
const EVENTS_KEPT_MS = 30 * 86_400_000;

export function serializeWebhook(w: WebhookRow) {
  return {
    id: w.id,
    organization: w.workspaceId,
    campaign: w.campaignId,
    name: w.name,
    target_hook_url: w.targetHookUrl,
    event_type: w.eventType,
    custom_interest_value: w.customInterestValue,
    headers: w.headers,
    timestamp_created: iso(w.createdAt),
    status: w.status,
    timestamp_error: iso(w.timestampError),
  };
}

export function serializeWebhookEvent(e: WebhookEventRow) {
  return {
    id: e.id,
    organization_id: e.workspaceId,
    timestamp_created: iso(e.createdAt),
    timestamp_created_date: iso(e.createdAt)?.slice(0, 10),
    payload: e.payload,
    success: e.success,
    retry_count: e.retryCount,
    will_retry: e.willRetry,
    webhook_url: e.webhookUrl,
    status_code: e.statusCode,
    error_message: e.errorMessage,
    timestamp_next_retry: iso(e.nextRetryAt),
    retry_group_id: e.retryGroupId,
    retry_successful: e.retryCount > 0 ? e.success : null,
    lead_email: e.leadEmail,
    response_time_ms: e.responseTimeMs,
    webhook_id: e.webhookId,
    event_type: e.eventType,
  };
}

export function webhookEventTypes() {
  return Object.entries(WEBHOOK_EVENT_LABELS).map(([id, label]) => ({ id, label, type: id.startsWith("lead_") ? "lead_status" : "email_event" }));
}

/**
 * Queue a webhook event for every active webhook in the workspace that subscribes to it.
 * `interestValue` lets custom-label webhooks (custom_interest_value) match interest changes.
 */
export async function enqueueWebhooks(
  workspaceId: string,
  eventType: string,
  payload: Partial<WebhookPayload>,
  /** `allEvents`: a label change no event of its own covers (Lost, a custom label) also goes to "all events" webhooks. */
  opts: { campaignId?: string | null; interestValue?: number | null; allEvents?: boolean } = {},
): Promise<number> {
  const hooks = await db
    .select()
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.workspaceId, workspaceId), eq(schema.webhooks.status, 1)));
  if (!hooks.length) return 0;
  const matching = hooks.filter((h) => {
    if (h.campaignId && h.campaignId !== (opts.campaignId ?? payload.campaign_id ?? null)) return false;
    if (h.customInterestValue !== null && h.customInterestValue !== undefined) {
      return opts.interestValue !== undefined && opts.interestValue !== null && opts.interestValue === h.customInterestValue;
    }
    if (!h.eventType || h.eventType === "all_events") return eventType !== "lead_interest_changed" || !!opts.allEvents;
    return h.eventType === eventType;
  });
  if (!matching.length) return 0;
  // What the event is, when and where comes last: nothing in the payload (a lead's own variables) replaces it.
  const body: WebhookPayload = {
    ...payload,
    timestamp: new Date().toISOString(),
    event_type: eventType,
    workspace: workspaceId,
  };
  await db.insert(schema.webhookEvents).values(
    matching.map((h) => ({
      workspaceId,
      webhookId: h.id,
      eventType,
      payload: body,
      webhookUrl: h.targetHookUrl,
      leadEmail: (payload.lead_email as string | undefined) ?? null,
      nextRetryAt: new Date(),
      retryGroupId: uuidv7(),
    })),
  );
  return matching.length;
}

async function post(hook: Pick<WebhookRow, "targetHookUrl" | "headers" | "secret">, payload: unknown) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `${config.brandName}-Webhooks/1.0`,
    ...(hook.headers ?? {}),
  };
  if (hook.secret) headers["x-webhook-signature"] = `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
  const started = Date.now();
  try {
    const res = await publicFetch(hook.targetHookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
    const ms = Date.now() - started;
    if (res.ok) {
      // Whatever the endpoint answers with isn't needed, and isn't read.
      await res.body?.cancel().catch(() => {});
      return { ok: true, status: res.status, ms, error: null as string | null };
    }
    // Only the start of an error page is kept: an endpoint can answer with anything, of any size.
    const text = (await readCapped(res, 1024).catch(() => "")).trim();
    return { ok: false, status: res.status, ms, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  } catch (err) {
    return { ok: false, status: null as number | null, ms: Date.now() - started, error: describeFetchError(err) };
  }
}

/**
 * Deliver due webhook events (engine loop): the longest-waiting first, a few per webhook, so one endpoint that's slow
 * or down (each try can take 15 seconds) doesn't hold up everyone else's.
 */
export async function deliverDueWebhooks(batch = 50): Promise<number> {
  const EV = schema.webhookEvents;
  const ranked = db.$with("ranked").as(
    db
      .select({ id: EV.id, nextRetryAt: EV.nextRetryAt, n: sql<number>`row_number() over (partition by ${EV.webhookId} order by ${EV.nextRetryAt}, ${EV.id})`.as("n") })
      .from(EV)
      .where(and(eq(EV.willRetry, true), or(isNull(EV.nextRetryAt), lte(EV.nextRetryAt, new Date())))),
  );
  const picked = await db
    .with(ranked)
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.n, PER_HOOK_PER_PASS))
    .orderBy(asc(ranked.nextRetryAt), asc(ranked.id))
    .limit(batch);
  if (!picked.length) return 0;
  const due = await db.select().from(EV).where(inArray(EV.id, picked.map((p) => p.id)));
  const hookIds = [...new Set(due.map((d) => d.webhookId))];
  const hooks = new Map((await db.select().from(schema.webhooks).where(inArray(schema.webhooks.id, hookIds))).map((h) => [h.id, h]));
  const stopped = await stoppedWorkspaces();
  await Promise.all(
    due.map(async (ev) => {
      const hook = hooks.get(ev.webhookId);
      if (stopped.has(ev.workspaceId)) {
        await db.update(schema.webhookEvents).set({ willRetry: false, errorMessage: "Workspace deleted or turned off" }).where(eq(schema.webhookEvents.id, ev.id));
        return;
      }
      if (!hook || hook.status !== 1) {
        await db.update(schema.webhookEvents).set({ willRetry: false, errorMessage: hook ? "Webhook paused" : "Webhook deleted" }).where(eq(schema.webhookEvents.id, ev.id));
        return;
      }
      const r = await post(hook, ev.payload);
      if (r.ok) {
        await db
          .update(schema.webhookEvents)
          .set({ success: true, willRetry: false, statusCode: r.status, responseTimeMs: r.ms, errorMessage: null, deliveredAt: new Date(), nextRetryAt: null })
          .where(eq(schema.webhookEvents.id, ev.id));
        await db
          .update(schema.webhooks)
          .set({ consecutiveFailures: 0 })
          .where(and(eq(schema.webhooks.id, hook.id), gt(schema.webhooks.consecutiveFailures, 0)));
        return;
      }
      const delay = RETRY_DELAYS_MS[ev.retryCount];
      await db
        .update(schema.webhookEvents)
        .set({
          success: false,
          statusCode: r.status,
          responseTimeMs: r.ms,
          errorMessage: r.error,
          retryCount: delay !== undefined ? ev.retryCount + 1 : ev.retryCount,
          willRetry: delay !== undefined,
          nextRetryAt: delay !== undefined ? new Date(Date.now() + delay) : null,
        })
        .where(eq(schema.webhookEvents.id, ev.id));
      if (delay === undefined) {
        // Counted in the database: several deliveries of one webhook can give up in the same pass.
        const W = schema.webhooks;
        const [after] = await db
          .update(W)
          .set({ consecutiveFailures: sql`${W.consecutiveFailures} + 1` })
          .where(eq(W.id, hook.id))
          .returning({ failures: W.consecutiveFailures });
        if ((after?.failures ?? 0) < DISABLE_AFTER_FAILURES) return;
        const [disabled] = await db
          .update(W)
          .set({ status: -1, timestampError: new Date() })
          .where(and(eq(W.id, hook.id), eq(W.status, 1)))
          .returning({ id: W.id });
        if (disabled) await audit({ workspaceId: hook.workspaceId, activityType: AuditActivity.WEBHOOK_ERROR, webhookId: hook.id });
      }
    }),
  );
  return due.length;
}

/** Daily: finished deliveries leave the log after 30 days (ones still being retried stay). */
export async function pruneWebhookEvents(now = Date.now()): Promise<number> {
  const EV = schema.webhookEvents;
  let removed = 0;
  for (;;) {
    const old = await db
      .select({ id: EV.id })
      .from(EV)
      .where(and(eq(EV.willRetry, false), lt(EV.createdAt, new Date(now - EVENTS_KEPT_MS))))
      .limit(2_000);
    if (!old.length) return removed;
    await db.delete(EV).where(inArray(EV.id, old.map((o) => o.id)));
    removed += old.length;
  }
}

/** Sends a sample payload immediately (POST /webhooks/{id}/test). */
export async function testWebhook(hook: WebhookRow) {
  const sample: WebhookPayload = {
    timestamp: new Date().toISOString(),
    event_type: hook.eventType && hook.eventType !== "all_events" ? hook.eventType : "reply_received",
    workspace: hook.workspaceId,
    campaign_id: hook.campaignId ?? "00000000-0000-0000-0000-000000000000",
    campaign_name: "Test campaign",
    lead_email: "lead@example.com",
    email_account: "sender@example.com",
    is_test: true,
    reply_text_snippet: "This is a test event.",
  };
  const r = await post(hook, sample);
  return { success: r.ok, message: r.ok ? "Webhook delivered" : "Webhook delivery failed", response_time_ms: r.ms, status_code: r.status ?? 0, error: r.error ?? undefined };
}
