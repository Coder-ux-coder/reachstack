// Copilot preferences, kept per user and workspace in users.preferences.copilot[workspaceId].
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db/client";

export const CHAT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] as const;

export const settingsSchema = z.object({
  /** Runs campaign-building and lead tools without asking first. */
  warp_mode: z.boolean(),
  follow_up_suggestions: z.boolean(),
  /** Counts actions and time saved for the new-chat page. */
  analytics: z.boolean(),
  /** When off, every tool call waits for approval, reads included. */
  execute_tools: z.boolean(),
  enrich_leads_limit: z.number().int().min(1).max(50_000),
  slack_integration_id: z.string().min(1).nullable(),
  /** null follows the workspace AI model. */
  chat_model: z.enum(CHAT_MODELS).nullable(),
});

export type CopilotSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: CopilotSettings = {
  warp_mode: false,
  follow_up_suggestions: true,
  analytics: true,
  execute_tools: true,
  enrich_leads_limit: 100,
  slack_integration_id: null,
  chat_model: null,
};

type Prefs = Record<string, unknown> & { copilot?: Record<string, unknown> };

async function prefsOf(userId: string): Promise<Prefs> {
  const [u] = await db.select({ preferences: schema.users.preferences }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return (u?.preferences ?? {}) as Prefs;
}

export async function getCopilotSettings(userId: string, workspaceId: string): Promise<CopilotSettings> {
  const stored = (await prefsOf(userId)).copilot?.[workspaceId];
  const parsed = settingsSchema.partial().safeParse(stored ?? {});
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export async function saveCopilotSettings(userId: string, workspaceId: string, patch: Partial<CopilotSettings>): Promise<CopilotSettings> {
  const prefs = await prefsOf(userId);
  const next = { ...(await getCopilotSettings(userId, workspaceId)), ...patch };
  await db
    .update(schema.users)
    .set({ preferences: { ...prefs, copilot: { ...(prefs.copilot ?? {}), [workspaceId]: next } } })
    .where(eq(schema.users.id, userId));
  return next;
}
