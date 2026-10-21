// AI Inbox Manager (API v2 /ai-agents/inbox-manager) plus the app's review queue: approve, edit, discard and
// a playground that drafts a reply to a sample message without saving anything.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest, conflict } from "../http/errors";
import { body, query, zBool, zInt } from "../http/util";
import { aiAvailable, toHttpError } from "../services/ai";
import { calendlyLink, getIntegration, serializeIntegration } from "../services/integrations";
import { serializeTag } from "../services/tags";
import {
  AgentStatus,
  AgentType,
  GuidanceCategory,
  businessContext,
  cleanReplyHtml,
  findAgent,
  guidanceText,
  serializeAgent,
  serializeAgentSummary,
  serializeGuidance,
  type AgentRow,
} from "../services/agents/common";
import {
  JobType,
  SendingStatus,
  discardDraft,
  holdScheduledReplies,
  inboxManagerActivity,
  inboxManagerByDate,
  inboxManagerSummary,
  notInFlight,
  payloadOf,
  replyInFlight,
  runInboxManager,
  sendReply,
  serializeReply,
  staleDraftReason,
  type DiscardReason,
} from "../services/agents/inbox-manager";
import { deleteAgent } from "../services/agents/delete";
import { classifyIncoming } from "../services/agents/reply-classifier";
import { draftReply } from "../services/agents/reply-engine";

const A = schema.aiAgents;
const G = schema.aiAgentGuidance;
const R = schema.aiAgentReplies;

const STALE_DRAFT: Record<DiscardReason, string> = {
  lead_replied_again: "The lead wrote again after this draft was made, so it was discarded. Answer their newest message instead.",
  answered_by_person: "Someone already answered this conversation, so the draft was discarded.",
  lead_unsubscribed: "The lead unsubscribed, so the draft was discarded.",
};
const NOT_SENT: Record<string, string> = {
  LEAD_BLOCKED: "The lead is on your blocklist, so the reply wasn't sent.",
  RECIPIENT_BLOCKED: "An address this reply goes to is on your blocklist, so it wasn't sent.",
  RECIPIENT_UNSUBSCRIBED: "An address this reply goes to unsubscribed, so it wasn't sent.",
  RECIPIENT_BOUNCED: "An address this email goes to bounced before, so it wasn't sent.",
  NO_SENDING_ACCOUNT: "No mailbox is available to send this reply.",
  ACCOUNT_INACTIVE: "The mailbox for this conversation is paused or can't connect right now.",
  SEND_FAILED: "The reply couldn't be sent. Try again in a moment.",
};

type Act = "create" | "read" | "update" | "delete";
const agentCfg = (act: Act) => ({ scope: ["ai_agents", act] as [string, Act], perm: act === "read" ? ("unibox" as const) : ("settings" as const), write: act !== "read" });
// Guidance endpoints accept ai_agents:all or all:<action>.
const guidanceCfg = (act: Act) => ({ scope: ["all", act] as [string, Act], scopeAlso: [["ai_agents", "all"]] as Array<[string, "all"]>, perm: act === "read" ? ("unibox" as const) : ("settings" as const), write: act !== "read" });
const repliesCfg = (act: "read" | "update") => ({ scope: ["ai_sdr_replies", act] as [string, Act], scopeAlso: [["ai_agents", "all"]] as Array<[string, "all"]>, perm: "unibox" as const, write: act === "update" });
const analyticsCfg = { scope: ["ai_inbox_manager_analytics", "read"] as [string, Act], scopeAlso: [["ai_agents", "all"]] as Array<[string, "all"]>, perm: "unibox" as const };

const TONES = ["friendly", "neutral", "matter_of_fact", "professional", "humorous"] as const;
const LENGTHS = ["concise", "standard", "thorough"] as const;

const integrationRef = z.object({ connection_id: z.string().min(1), enabled: z.boolean().optional() }).passthrough().nullable();
const payloadFields = {
  configuration_type: z.union([z.literal(1), z.literal(2)]),
  tags: z.array(z.string().min(1)).max(200).optional(),
  handle_followup: z.boolean().optional(),
  respond_to_automatic_emails: z.boolean().optional(),
  handle_objections: z.boolean().optional(),
  integrations: z.object({ slack: integrationRef.optional(), calendly: integrationRef.optional() }).optional(),
  no_show: z
    .object({
      enabled: z.boolean().optional(),
      max_followups: z.number().int().min(1).max(5).optional(),
      fallback_sending_accounts: z.object({ accounts: z.array(z.string().email()).max(500).optional(), tag_ids: z.array(z.string()).max(100).optional() }).optional(),
    })
    .optional(),
  trigger_on_labels_enabled: z.boolean().optional(),
  trigger_on_labels: z.array(z.number().int()).max(50).optional(),
  trigger_on_labels_mode: z.enum(["include", "exclude"]).optional(),
  monthly_credit_budget: z.number().min(0).nullable().optional(),
  followup_business_days_only: z.boolean().optional(),
};
const payloadSchema = z.object(payloadFields).strict();
const payloadPatchSchema = z.object({ ...payloadFields, configuration_type: payloadFields.configuration_type.optional() }).strict();

const guidanceBody = z.object({
  label: z.string().trim().min(1).max(200),
  category: z.number().int().min(0).max(4),
  instruction: z.string().max(10_000).optional(),
  status: z.union([z.literal(0), z.literal(1)]).optional(),
  basic_guidance_options: z.object({ tone: z.enum(TONES), length: z.enum(LENGTHS) }).optional(),
});

/** Checks that tags, connections and fallback mailboxes in a payload belong to the workspace. */
async function validatePayload(wsId: string, p: z.infer<typeof payloadPatchSchema>) {
  const tags = (p.tags ?? []).filter((t) => t !== "default");
  if (tags.length) {
    const found = await db.select({ id: schema.customTags.id }).from(schema.customTags).where(and(eq(schema.customTags.workspaceId, wsId), inArray(schema.customTags.id, tags)));
    if (found.length !== new Set(tags).size) throw badRequest("tags: unknown tag id (use \"default\" for all campaigns and mailboxes)");
  }
  for (const type of ["slack", "calendly"] as const) {
    const ref = p.integrations?.[type];
    if (ref && !(await getIntegration(wsId, ref.connection_id, type))) throw badRequest(`integrations.${type}.connection_id: no ${type} connection with this id`);
  }
  const fb = p.no_show?.fallback_sending_accounts;
  if (fb?.accounts?.length) {
    const emails = fb.accounts.map((e) => e.toLowerCase());
    const found = await db.select({ email: schema.emailAccounts.email }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, wsId), inArray(schema.emailAccounts.email, emails)));
    const missing = emails.filter((e) => !found.some((f) => f.email === e));
    if (missing.length) throw badRequest(`no_show.fallback_sending_accounts.accounts: not a mailbox in this workspace: ${missing.slice(0, 3).join(", ")}`);
  }
  if (fb?.tag_ids?.length) {
    const found = await db.select({ id: schema.customTags.id }).from(schema.customTags).where(and(eq(schema.customTags.workspaceId, wsId), inArray(schema.customTags.id, fb.tag_ids)));
    if (found.length !== new Set(fb.tag_ids).size) throw badRequest("no_show.fallback_sending_accounts.tag_ids: unknown tag id");
  }
}

function normalizePayload(p: Record<string, unknown>) {
  const out: Record<string, unknown> = { tags: ["default"], handle_followup: false, respond_to_automatic_emails: false, handle_objections: false, integrations: {}, ...p };
  const integ = { ...((out.integrations as Record<string, unknown>) ?? {}) };
  for (const k of Object.keys(integ)) if (integ[k] === null) delete integ[k];
  out.integrations = integ;
  if (Array.isArray(out.tags) && !(out.tags as string[]).length) out.tags = ["default"];
  if (Array.isArray(out.fallback_sending_accounts)) delete out.fallback_sending_accounts;
  const ns = out.no_show as { fallback_sending_accounts?: { accounts?: string[] } } | undefined;
  if (ns?.fallback_sending_accounts?.accounts) ns.fallback_sending_accounts.accounts = ns.fallback_sending_accounts.accounts.map((e) => e.toLowerCase());
  return out;
}

/** The stored payload minus internal bookkeeping. */
const publicPayload = (a: AgentRow) => {
  const { active_since: _ignored, ...rest } = (a.payload ?? {}) as Record<string, unknown>;
  return rest;
};

async function agentJson(a: AgentRow, withMetadata = false) {
  const base = serializeAgent({ ...a, payload: publicPayload(a) });
  if (!withMetadata) return base;
  const p = payloadOf(a);
  const tagIds = (p.tags ?? []).filter((t) => t !== "default");
  const tags = tagIds.length ? await db.select().from(schema.customTags).where(and(eq(schema.customTags.workspaceId, a.workspaceId), inArray(schema.customTags.id, tagIds))) : [];
  const integrations: Record<string, unknown> = {};
  for (const type of ["slack", "calendly"] as const) {
    const row = await getIntegration(a.workspaceId, p.integrations?.[type]?.connection_id, type);
    if (row) integrations[type] = serializeIntegration(row);
  }
  return { ...base, metadata: { tags: Object.fromEntries(tags.map((t) => [t.id, serializeTag(t)])), integrations } };
}

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

export default async function inboxManagerRoutes(app: FastifyInstance) {
  const base = "/api/v2/ai-agents/inbox-manager";

  app.post(base, { config: agentCfg("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2_000).optional(),
        payload: payloadSchema,
        guidances: z.array(guidanceBody).max(50).optional(),
      }),
    );
    await validatePayload(c.wsId, b.payload);
    for (const g of b.guidances ?? []) checkGuidance(g.category, g.instruction, g.basic_guidance_options);
    if ((b.guidances ?? []).filter((g) => g.category === GuidanceCategory.BASICS).length > 1) throw badRequest("guidances: only one BASICS guidance is allowed");
    const payload = { ...normalizePayload(b.payload), active_since: new Date().toISOString() };
    const [row] = await db
      .insert(A)
      .values({
        workspaceId: c.wsId,
        name: b.name,
        description: b.description ?? null,
        type: AgentType.INBOX_MANAGER,
        status: AgentStatus.ACTIVE,
        configurationMode: b.payload.configuration_type === 2 ? "fully_automatic" : "copilot",
        payload,
        createdBy: c.userId,
      })
      .returning();
    const guidances = b.guidances ?? [];
    if (!guidances.some((g) => g.category === GuidanceCategory.BASICS)) guidances.unshift({ label: "Tone and length", category: GuidanceCategory.BASICS, basic_guidance_options: { tone: "professional", length: "concise" } });
    for (const g of guidances) await insertGuidance(c.wsId, row!.id, g);
    return agentJson(row!);
  });

  app.get(base, { config: agentCfg("read") }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), status: z.coerce.number().int().min(0).max(1).optional(), search: z.string().optional() }));
    const limit = q.limit ?? 20;
    const conds = [eq(A.workspaceId, c.wsId), eq(A.type, AgentType.INBOX_MANAGER)];
    if (q.status !== undefined) conds.push(eq(A.status, q.status));
    if (q.search) conds.push(contains(sql`lower(${A.name})`, q.search.toLowerCase()));
    if (q.starting_after) conds.push(lt(A.id, q.starting_after));
    const rows = await db.select().from(A).where(and(...conds)).orderBy(desc(A.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: await Promise.all(page.map((a) => agentJson(a))), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
  });

  app.get(`${base}/:id`, { config: agentCfg("read") }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ with_metadata: zBool }));
    return agentJson(await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER), !!q.with_metadata);
  });

  app.patch(`${base}/:id`, { config: agentCfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200).optional(), status: z.union([z.literal(0), z.literal(1)]).optional(), payload: payloadPatchSchema.optional(), description: z.string().max(2_000).nullable().optional() }));
    const set: Partial<typeof A.$inferInsert> = {};
    if (b.name) set.name = b.name;
    if (b.description !== undefined) set.description = b.description;
    let payload = { ...(a.payload ?? {}) } as Record<string, unknown>;
    if (b.payload) {
      await validatePayload(c.wsId, b.payload);
      const integrations = { ...((payload.integrations as Record<string, unknown>) ?? {}), ...(b.payload.integrations ?? {}) };
      payload = normalizePayload({ ...payload, ...b.payload, integrations });
      if (b.payload.configuration_type) set.configurationMode = b.payload.configuration_type === 2 ? "fully_automatic" : "copilot";
    }
    if (b.status !== undefined && b.status !== a.status) {
      if (b.status === AgentStatus.ACTIVE) {
        if (!(await aiAvailable(c.wsId))) throw badRequest("AI is not configured. Add an Anthropic API key in Settings → Integrations & API → AI before activating the agent.");
        payload.active_since = new Date().toISOString(); // answer what arrives from now on, not the backlog
      } else await holdScheduledReplies(a.id);
      set.status = b.status;
    }
    // Review mode never sends on its own: drafts already queued by autopilot wait for approval.
    if (b.payload?.configuration_type === 1) await holdScheduledReplies(a.id, "review");
    set.payload = payload;
    const [row] = await db.update(A).set(set).where(eq(A.id, a.id)).returning();
    return agentJson(row!);
  });

  app.delete(`${base}/:id`, { config: agentCfg("delete") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    await deleteAgent(a);
    return serializeAgentSummary(a);
  });

  // ---------- Guidance ----------

  const findGuidance = async (agentId: string, id: string) => assertFound((await db.select().from(G).where(and(eq(G.id, id), eq(G.agentId, agentId))).limit(1))[0], "Guidance");

  app.get(`${base}/:id/guidances`, { config: guidanceCfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), status: z.coerce.number().int().min(0).max(1).optional() }));
    const limit = q.limit ?? 20;
    const conds = [eq(G.agentId, a.id)];
    if (q.status !== undefined) conds.push(eq(G.status, q.status));
    if (q.starting_after) conds.push(lt(G.id, q.starting_after));
    const rows = await db.select().from(G).where(and(...conds)).orderBy(desc(G.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeGuidance), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
  });

  app.post(`${base}/:id/guidances`, { config: guidanceCfg("create") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const b = body(req, guidanceBody);
    checkGuidance(b.category, b.instruction, b.basic_guidance_options);
    if (b.category === GuidanceCategory.BASICS) {
      const [existing] = await db.select({ id: G.id }).from(G).where(and(eq(G.agentId, a.id), eq(G.category, GuidanceCategory.BASICS))).limit(1);
      if (existing) throw conflict("This agent already has a BASICS guidance; update it instead");
    }
    return serializeGuidance(await insertGuidance(c.wsId, a.id, b));
  });

  app.get(`${base}/:id/guidances/:guidance_id`, { config: guidanceCfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    return serializeGuidance(await findGuidance(a.id, (req.params as { guidance_id: string }).guidance_id));
  });

  app.patch(`${base}/:id/guidances/:guidance_id`, { config: guidanceCfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const g = await findGuidance(a.id, (req.params as { guidance_id: string }).guidance_id);
    const b = body(req, guidanceBody.partial());
    const category = b.category ?? g.category;
    const instruction = b.instruction ?? (category === GuidanceCategory.BASICS ? "" : g.instruction);
    const options = b.basic_guidance_options ?? (category === GuidanceCategory.BASICS ? (g.basicGuidanceOptions ?? undefined) : undefined);
    checkGuidance(category, instruction, options as z.infer<typeof guidanceBody>["basic_guidance_options"]);
    if (category === GuidanceCategory.BASICS && g.category !== GuidanceCategory.BASICS) {
      const [existing] = await db.select({ id: G.id }).from(G).where(and(eq(G.agentId, a.id), eq(G.category, GuidanceCategory.BASICS))).limit(1);
      if (existing) throw conflict("This agent already has a BASICS guidance");
    }
    const [row] = await db
      .update(G)
      .set({
        label: b.label ?? g.label,
        category,
        instruction: category === GuidanceCategory.BASICS ? "" : instruction,
        status: category === GuidanceCategory.BASICS ? 1 : (b.status ?? g.status),
        basicGuidanceOptions: category === GuidanceCategory.BASICS ? (options ?? null) : null,
      })
      .where(eq(G.id, g.id))
      .returning();
    return serializeGuidance(row!);
  });

  app.delete(`${base}/:id/guidances/:guidance_id`, { config: guidanceCfg("delete") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const g = await findGuidance(a.id, (req.params as { guidance_id: string }).guidance_id);
    await db.delete(G).where(eq(G.id, g.id));
    return serializeGuidance(g);
  });

  // ---------- Replies ----------

  const findReply = async (agentId: string, id: string) => assertFound((await db.select().from(R).where(and(eq(R.id, id), eq(R.agentId, agentId))).limit(1))[0], "Reply");

  app.get(`${base}/:id/replies`, { config: repliesCfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), requires_hitl: zBool, information_requested: zBool, action_pending: zBool }));
    const limit = q.limit ?? 20;
    const conds = [eq(R.agentId, a.id)];
    if (q.requires_hitl !== undefined) conds.push(eq(R.requiresHitl, q.requires_hitl));
    if (q.information_requested !== undefined) conds.push(q.information_requested ? isNotNull(R.informationRequested) : isNull(R.informationRequested));
    if (q.action_pending !== undefined) conds.push(eq(R.actionPending, q.action_pending));
    if (q.starting_after) conds.push(lt(R.id, q.starting_after));
    const rows = await db.select().from(R).where(and(...conds)).orderBy(desc(R.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeReply), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
  });

  app.get(`${base}/:id/replies/:reply_id`, { config: repliesCfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    return serializeReply(await findReply(a.id, (req.params as { reply_id: string }).reply_id));
  });

  app.patch(`${base}/:id/replies/:reply_id`, { config: repliesCfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const r = await findReply(a.id, (req.params as { reply_id: string }).reply_id);
    const b = body(req, z.object({ feedback_positive: z.boolean().optional(), feedback_text: z.string().max(5_000).optional(), action_pending: z.boolean().optional() }));
    const set: Partial<typeof R.$inferInsert> = {};
    if (b.feedback_positive !== undefined) set.feedbackPositive = b.feedback_positive;
    if (b.feedback_text !== undefined) set.feedbackText = b.feedback_text;
    if (b.action_pending !== undefined) set.actionPending = b.action_pending;
    if (!Object.keys(set).length) return serializeReply(r);
    const [row] = await db.update(R).set(set).where(eq(R.id, r.id)).returning();
    return serializeReply(row!);
  });

  // ---------- Analytics ----------

  const range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

  app.get(`${base}/:id/analytics/summary`, { config: analyticsCfg }, async (req) => {
    const c = ctx(req);
    const q = query(req, range);
    return inboxManagerSummary(await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER), q.from, q.to);
  });

  app.get(`${base}/:id/analytics/summary-by-date`, { config: analyticsCfg }, async (req) => {
    const c = ctx(req);
    const q = query(req, range);
    if (q.from && q.to && q.from > q.to) throw badRequest("from must be on or before to");
    if (q.from && q.to && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 366) throw badRequest("The window can span at most 366 days");
    return inboxManagerByDate(await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER), q.from, q.to);
  });

  app.get(`${base}/:id/analytics/activity`, { config: analyticsCfg }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).optional(),
        starting_after: z.string().optional(),
        action_pending: zBool,
        activity_type: z.enum(["reply", "followup", "recovery"]).optional(),
        job_type: z.coerce.number().int().min(1).max(3).optional(),
      }),
    );
    if (q.job_type && q.activity_type) throw badRequest("job_type cannot be combined with activity_type");
    if (q.activity_type === "recovery" && q.action_pending !== undefined) throw badRequest("action_pending cannot be combined with activity_type=recovery");
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    return inboxManagerActivity(a, { limit: q.limit ?? 20, startingAfter: q.starting_after, actionPending: q.action_pending, activityType: q.activity_type, jobType: q.job_type });
  });

  // ---------- App: review queue, manual run and playground ----------

  const app_ = "/api/app/ai-agents/inbox-manager";
  const reviewCfg = { perm: "unibox" as const, write: true };

  app.post(`${app_}/:id/replies/:reply_id/approve`, { config: reviewCfg }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const r = await findReply(a.id, (req.params as { reply_id: string }).reply_id);
    const b = body(req, z.object({ html: z.string().min(1).max(100_000).optional() }));
    if (r.sendingStatus === SendingStatus.SENT) throw conflict("This reply was already sent");
    if (replyInFlight(r)) throw conflict("This reply is already on its way");
    if (!r.html && !b.html) throw badRequest("Write the reply before sending it");
    // The conversation may have moved on since the draft was written.
    const stale = await staleDraftReason(r);
    if (stale) {
      await discardDraft(r, stale);
      throw conflict(STALE_DRAFT[stale]);
    }
    // Only while nobody else is sending it (a second click, or the loop with an autopilot reply).
    const [ready] = await db
      .update(R)
      .set({ html: b.html ? cleanReplyHtml(b.html) : r.html, actionPending: false, sendingStatus: SendingStatus.SCHEDULED, errorCode: null, scheduledSendAt: new Date() })
      .where(and(eq(R.id, r.id), ne(R.sendingStatus, SendingStatus.SENT), notInFlight()))
      .returning();
    if (!ready) throw conflict("This reply is already on its way");
    const sent = await sendReply(ready);
    // Taken by the loop in the meantime: it goes out from there.
    if (replyInFlight(sent)) return serializeReply(sent);
    if (sent.sendingStatus !== SendingStatus.SENT) {
      const discarded = (sent.usageMetadata as { discarded?: DiscardReason } | null)?.discarded;
      throw conflict(discarded ? STALE_DRAFT[discarded] : (NOT_SENT[sent.errorCode ?? ""] ?? NOT_SENT.SEND_FAILED!));
    }
    return serializeReply(sent);
  });

  app.patch(`${app_}/:id/replies/:reply_id`, { config: reviewCfg }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const r = await findReply(a.id, (req.params as { reply_id: string }).reply_id);
    if (r.sendingStatus === SendingStatus.SENT) throw conflict("This reply was already sent");
    const b = body(req, z.object({ html: z.string().min(1).max(100_000) }));
    const [row] = await db.update(R).set({ html: cleanReplyHtml(b.html) }).where(eq(R.id, r.id)).returning();
    return serializeReply(row!);
  });

  app.post(`${app_}/:id/replies/:reply_id/discard`, { config: reviewCfg }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const r = await findReply(a.id, (req.params as { reply_id: string }).reply_id);
    if (r.sendingStatus === SendingStatus.SENT) throw conflict("This reply was already sent");
    if (replyInFlight(r)) throw conflict("This reply is already on its way");
    const [row] = await db.update(R).set({ sendingStatus: SendingStatus.FAILED, errorCode: null, actionPending: false, scheduledSendAt: null }).where(eq(R.id, r.id)).returning();
    return serializeReply(row!);
  });

  app.post(`${app_}/:id/run`, { config: { perm: "settings" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    if (a.status !== AgentStatus.ACTIVE) throw badRequest("Activate the agent first");
    if (!(await aiAvailable(c.wsId))) throw badRequest("AI is not configured. Add an Anthropic API key in Settings → Integrations & API → AI.");
    const drafted = await runInboxManager(a);
    if (drafted === null) throw conflict("The agent is checking for replies right now. Its drafts show up here in a moment.");
    const [fresh] = await db.select().from(A).where(eq(A.id, a.id)).limit(1);
    return { drafted, status: fresh?.status ?? a.status };
  });

  app.post(`${app_}/:id/playground`, { config: { perm: "unibox" as const } }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const b = body(
      req,
      z.object({
        message: z.string().trim().min(1).max(10_000),
        subject: z.string().max(300).optional(),
        lead: z.object({ first_name: z.string().max(100).optional(), last_name: z.string().max(100).optional(), company_name: z.string().max(200).optional(), job_title: z.string().max(200).optional() }).optional(),
        mode: z.enum(["reply", "followup", "no_show"]).optional(),
      }),
    );
    if (!(await aiAvailable(c.wsId))) throw badRequest("AI is not configured. Add an Anthropic API key in Settings → Integrations & API → AI.");
    const p = payloadOf(a);
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    try {
      // A reply is sorted first, as in the inbox: some kinds are never answered.
      const reading = !b.mode || b.mode === "reply" ? await classifyIncoming(c.wsId, { subject: b.subject ?? "", bodyText: b.message, bodyHtml: "", isAutoReply: false }) : null;
      const leftAlone = reading?.category === "unsubscribe" ? "Unsubscribe requests are never answered." : reading?.category === "out_of_office" ? "Out-of-office messages are never answered." : null;
      if (leftAlone) {
        return {
          decision: "no_reply",
          html: "",
          confidence_score: Math.round((reading?.confidence ?? 0) * 100),
          requires_hitl: false,
          requires_hitl_reason: leftAlone,
          information_requested: null,
          calendly_tool_used: false,
          would_send_automatically: false,
          classification: reading,
        };
      }
      const draft = await draftReply({
        workspaceId: c.wsId,
        feature: "inbox_manager_playground",
        agentName: a.name,
        guidance: await guidanceText(a.id),
        context: await businessContext(c.wsId),
        bookingLink: await calendlyLink(c.wsId, p.integrations?.calendly?.connection_id),
        extraInstructions: p.handle_objections ? "If the prospect declines, you may address the objection once, briefly and respectfully." : "If the prospect declines, do not try to change their mind.",
        thread: [{ from: "lead", date: now, subject: b.subject ?? "Re: our conversation", text: b.message }],
        lead: { ...(b.lead ?? {}), email: null, interest_status: null },
        sender: { name: c.auth.user ? `${c.auth.user.firstName} ${c.auth.user.lastName}`.trim() || c.auth.user.email : "Sales", email: c.auth.user?.email ?? "" },
        mode: b.mode === "followup" ? { kind: "followup", number: 1, daysSinceLast: 3 } : b.mode === "no_show" ? { kind: "no_show", number: 1 } : { kind: "reply" },
      });
      const autopilot = p.configuration_type === 2;
      return {
        decision: draft.decision,
        html: draft.html,
        confidence_score: draft.confidence,
        requires_hitl: !autopilot || draft.needsHuman || draft.decision !== "reply" || draft.confidence < 70,
        requires_hitl_reason: draft.humanReason,
        information_requested: draft.informationRequested,
        calendly_tool_used: draft.usedBookingLink,
        would_send_automatically: autopilot && draft.decision === "reply" && !draft.needsHuman && draft.confidence >= 70,
        classification: reading,
      };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  app.get(`${app_}/:id/overview`, { config: { perm: "unibox" as const } }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idParam(req), AgentType.INBOX_MANAGER);
    const [counts] = await db
      .select({
        pending: sql<number>`sum(case when ${R.actionPending} = 1 and ${R.sendingStatus} <> ${SendingStatus.SENT} then 1 else 0 end)`,
        scheduled: sql<number>`sum(case when ${R.sendingStatus} = ${SendingStatus.SCHEDULED} and ${R.actionPending} = 0 then 1 else 0 end)`,
        sent: sql<number>`sum(case when ${R.sendingStatus} = ${SendingStatus.SENT} then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${R.sendingStatus} = ${SendingStatus.FAILED} and ${R.errorCode} is not null then 1 else 0 end)`,
        noShow: sql<number>`sum(case when ${R.jobType} = ${JobType.NO_SHOW} then 1 else 0 end)`,
      })
      .from(R)
      .where(eq(R.agentId, a.id));
    const events = await db.select().from(schema.aiAgentEvents).where(eq(schema.aiAgentEvents.agentId, a.id)).orderBy(desc(schema.aiAgentEvents.createdAt)).limit(20);
    return {
      agent: await agentJson(a, true),
      ai_available: await aiAvailable(c.wsId),
      last_run_at: a.lastRunAt?.toISOString() ?? null,
      counts: { pending: Number(counts?.pending ?? 0), scheduled: Number(counts?.scheduled ?? 0), sent: Number(counts?.sent ?? 0), failed: Number(counts?.failed ?? 0), no_show: Number(counts?.noShow ?? 0) },
      recent_events: events.map((e) => ({ id: e.id, type: e.eventType, payload: e.payload, timestamp_created: e.createdAt.toISOString() })),
    };
  });
}

/** BASICS carries tone/length and no text; every other category carries text and no tone/length. */
function checkGuidance(category: number, instruction: string | undefined, options: { tone: string; length: string } | undefined) {
  if (category === GuidanceCategory.BASICS) {
    if (instruction && instruction.trim()) throw badRequest("instruction must be empty for the BASICS category");
    if (!options) throw badRequest("basic_guidance_options is required for the BASICS category");
    return;
  }
  if (options) throw badRequest("basic_guidance_options is only allowed for the BASICS category");
  if (!instruction || !instruction.trim()) throw badRequest("instruction is required for this category");
}

async function insertGuidance(workspaceId: string, agentId: string, g: z.infer<typeof guidanceBody>) {
  const basics = g.category === GuidanceCategory.BASICS;
  const [row] = await db
    .insert(G)
    .values({
      workspaceId,
      agentId,
      label: g.label,
      category: g.category,
      instruction: basics ? "" : (g.instruction ?? "").trim(),
      status: basics ? 1 : (g.status ?? 1),
      basicGuidanceOptions: basics ? (g.basic_guidance_options ?? null) : null,
    })
    .returning();
  return row!;
}
