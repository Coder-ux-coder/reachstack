// App connections a workspace sets up once and features reference by id (agents, automations):
// Slack incoming webhooks for notifications and a Calendly booking link for meeting replies.
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { badRequest, notFound } from "../http/errors";
import { decryptJson, encryptJson } from "../lib/crypto";
import { safeFetch } from "../lib/net";
import { iso } from "../lib/time";

export type IntegrationRow = typeof schema.integrations.$inferSelect;
export const SUPPORTED_INTEGRATIONS = ["slack", "calendly"] as const;
export type IntegrationType = (typeof SUPPORTED_INTEGRATIONS)[number];

export interface SlackConfig {
  webhook_url: string;
}
export interface CalendlyConfig {
  scheduling_url: string;
}

/** Validates the secret part of a connection and returns [secret config, public config]. */
export function validateIntegration(type: string, config: Record<string, unknown>): [Record<string, unknown>, Record<string, unknown>] {
  if (type === "slack") {
    const url = String(config.webhook_url ?? "").trim();
    if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url)) throw badRequest("Use a Slack incoming webhook URL (https://hooks.slack.com/services/...)");
    return [{ webhook_url: url }, { channel_hint: String(config.channel ?? "") || null }];
  }
  if (type === "calendly") {
    const url = String(config.scheduling_url ?? "").trim();
    if (!/^https:\/\/(www\.)?calendly\.com\/[A-Za-z0-9._~/-]+$/.test(url)) throw badRequest("Use a Calendly scheduling link (https://calendly.com/...)");
    return [{ scheduling_url: url }, { scheduling_url: url }];
  }
  throw badRequest(`Unsupported integration: ${type}. Available: ${SUPPORTED_INTEGRATIONS.join(", ")}`);
}

export function serializeIntegration(r: IntegrationRow) {
  return { id: r.id, type: r.type, name: r.name, status: r.status, error: r.error, config: r.publicConfig ?? {}, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt) };
}

export async function getIntegration(workspaceId: string, id: string | null | undefined, type?: IntegrationType): Promise<IntegrationRow | null> {
  if (!id) return null;
  const I = schema.integrations;
  const [row] = await db.select().from(I).where(and(eq(I.id, id), eq(I.workspaceId, workspaceId))).limit(1);
  return row && (!type || row.type === type) ? row : null;
}

export async function requireIntegration(workspaceId: string, id: string, type: IntegrationType) {
  const row = await getIntegration(workspaceId, id, type);
  if (!row) throw notFound(`${type === "slack" ? "Slack" : "Calendly"} connection`);
  return row;
}

export const integrationSecret = <T>(row: IntegrationRow) => decryptJson<T>(row.configEnc);

export async function listIntegrations(workspaceId: string) {
  const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.workspaceId, workspaceId)).orderBy(desc(schema.integrations.createdAt));
  return rows.map(serializeIntegration);
}

export async function createIntegration(workspaceId: string, userId: string | null, type: string, name: string | null, config: Record<string, unknown>) {
  const [secret, pub] = validateIntegration(type, config);
  const [row] = await db
    .insert(schema.integrations)
    .values({ workspaceId, type, name: name || (type === "slack" ? "Slack" : "Calendly"), configEnc: encryptJson(secret), publicConfig: pub, createdBy: userId })
    .returning();
  return row!;
}

/** Posts a message to a Slack connection; failures are recorded on the connection, never thrown. */
export async function postToSlack(workspaceId: string, connectionId: string | null | undefined, text: string): Promise<boolean> {
  const row = await getIntegration(workspaceId, connectionId, "slack");
  const cfg = row ? integrationSecret<SlackConfig>(row) : null;
  if (!row || !cfg?.webhook_url) return false;
  try {
    const res = await safeFetch(cfg.webhook_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
    const ok = res.ok;
    await db.update(schema.integrations).set({ status: ok ? "connected" : "error", error: ok ? null : `Slack answered HTTP ${res.status}` }).where(eq(schema.integrations.id, row.id));
    return ok;
  } catch (err) {
    await db.update(schema.integrations).set({ status: "error", error: (err as Error).message.slice(0, 300) }).where(eq(schema.integrations.id, row.id));
    return false;
  }
}

export async function calendlyLink(workspaceId: string, connectionId: string | null | undefined): Promise<string | null> {
  const row = await getIntegration(workspaceId, connectionId, "calendly");
  return row ? (integrationSecret<CalendlyConfig>(row)?.scheduling_url ?? null) : null;
}
