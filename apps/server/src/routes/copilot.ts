// Copilot ("<brand> AI"): chats that stream over server-sent events, memory (business details), recurring
// tasks and per-user settings.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { contains, db, escapeLike, schema } from "../db/client";
import { SESSION_COOKIE } from "../http/auth";
import { ctx } from "../http/context";
import { badRequest, conflict, HttpError, notFound, unauthorized } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { iso } from "../lib/time";
import { aiAvailable, aiErrorMessage } from "../services/ai";
import { listIntegrations } from "../services/integrations";
import { invokerFor, setCopilotApp } from "../services/copilot/invoke";
import { clearMemory, extractFromFile, extractFromWebsite, getMemory, memorySchema, saveMemory } from "../services/copilot/memory";
import {
  buildSystem,
  countUserMessages,
  decide,
  interrupted,
  MAX_USER_MESSAGES,
  regenerate,
  retryPlan,
  sendUserMessage,
  serializeAction,
  serializeMessage,
  stopThread,
  type Emit,
  type RunCtx,
  type ThreadRow,
} from "../services/copilot/runner";
import { CHAT_MODELS, getCopilotSettings, saveCopilotSettings, settingsSchema } from "../services/copilot/settings";
import { firstSchedule, runTask, serializeTask, type Frequency } from "../services/copilot/tasks";
import { quoteProblems, toCampaignSteps } from "../services/copilot/tools";
import { FALLBACK_ZONE } from "../services/workspace-clock";

const T = schema.copilotThreads;
const MSG = schema.copilotMessages;
const ACT = schema.copilotActions;
const TK = schema.copilotTasks;

const write = { perm: "edit_campaigns" as const, write: true };
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const frequency = z.enum(["daily", "weekly", "monthly"]);

function timezoneOf(c: ReturnType<typeof ctx>) {
  return c.user.timezone || (c.workspace.settings?.default_timezone as string | undefined) || FALLBACK_ZONE;
}

/** "running" left behind by a restart (or quiet for two minutes) reads as idle. */
function effectiveStatus(t: ThreadRow) {
  return interrupted(t) ? "idle" : t.status;
}

function serializeThread(t: ThreadRow, mine = true) {
  return { id: t.id, title: t.title, status: effectiveStatus(t), pinned: t.pinned, shared: t.shared, task_id: t.taskId, mine, created_at: iso(t.createdAt), updated_at: iso(t.updatedAt) };
}

async function threadFor(req: FastifyRequest, id: string, mode: "view" | "own") {
  const c = ctx(req);
  const [t] = await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId))).limit(1);
  const mine = !!t && t.userId === c.user.id;
  if (!t || (!mine && (mode === "own" || !t.shared))) throw notFound("Chat");
  return { thread: t, mine };
}

/** Takes over the response for a server-sent event stream. */
function openStream(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);
  const emit: Emit = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  return { emit, end };
}

async function runCtx(req: FastifyRequest, thread: ThreadRow, emit: Emit): Promise<RunCtx> {
  const c = ctx(req);
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) throw unauthorized("Copilot needs a signed-in session");
  return { thread, wsId: c.wsId, userId: c.user.id, timezone: timezoneOf(c), settings: await getCopilotSettings(c.user.id, c.wsId), invoke: invokerFor(token, c.wsId), emit };
}

async function assertAi(workspaceId: string) {
  if (!(await aiAvailable(workspaceId))) throw new HttpError(400, "Copilot needs AI: add an Anthropic API key in Settings → Integrations & API → AI, or the installation owner can set one up (Claude or a free local AI) in Settings → Installation → Services.", "ai_not_configured");
}

async function assertCanRun(t: ThreadRow) {
  if (effectiveStatus(t) === "running") throw conflict("Copilot is still answering in this chat. Wait for it to finish or press Stop.");
  await assertAi(t.workspaceId);
}

/** Streams `work` to the client; failures after the stream opened arrive as an "error" event. */
async function stream(reply: FastifyReply, work: (emit: Emit) => Promise<unknown>) {
  const s = openStream(reply);
  try {
    await work(s.emit);
  } catch (err) {
    s.emit("error", { message: err instanceof HttpError ? err.message : aiErrorMessage(err) });
    s.emit("done", { status: "idle" });
  } finally {
    s.end();
  }
}

const chatBody = z.object({
  thread_id: z.string().optional(),
  text: z.string().trim().min(1, "Write a message").max(20_000),
  recurring: z.object({ frequency }).optional(),
});

const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("deny") }),
  z.object({ decision: z.literal("skip") }),
  z.object({ decision: z.literal("answer"), answers: z.array(z.object({ question: z.string().max(400), answer: z.array(z.string().max(500)).max(10) })).min(1).max(4) }),
]);

const taskBody = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(3).max(4_000),
  frequency,
  time_of_day: hm.default("09:00"),
  timezone: z.string().max(80).optional(),
  source_thread_id: z.string().optional(),
  ran_now: z.boolean().optional(),
});

export default async function copilotRoutes(app: FastifyInstance) {
  setCopilotApp(app);

  // ---------- Chats ----------

  app.get("/api/app/copilot/threads", async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ search: z.string().max(200).optional(), limit: zInt(1, 200).optional() }));
    const rows = await db
      .select()
      .from(T)
      .where(and(eq(T.workspaceId, c.wsId), eq(T.userId, c.user.id), q.search ? contains(T.title, q.search) : undefined))
      .orderBy(desc(T.pinned), desc(T.updatedAt))
      .limit(q.limit ?? 100);
    return { items: rows.map((t) => serializeThread(t)) };
  });

  app.get("/api/app/copilot/threads/:id", async (req) => {
    const { thread, mine } = await threadFor(req, (req.params as { id: string }).id, "view");
    const [messages, actions] = await Promise.all([
      db.select().from(MSG).where(and(eq(MSG.threadId, thread.id), eq(MSG.hidden, false))).orderBy(MSG.createdAt, MSG.id),
      db.select().from(ACT).where(eq(ACT.threadId, thread.id)),
    ]);
    const userMessages = messages.filter((m) => m.role === "user").length;
    return {
      thread: serializeThread(thread, mine),
      messages: messages.map(serializeMessage),
      actions: actions.map(serializeAction),
      limit: { max_messages: MAX_USER_MESSAGES, used: userMessages, reached: userMessages >= MAX_USER_MESSAGES },
    };
  });

  app.patch("/api/app/copilot/threads/:id", async (req) => {
    const { thread } = await threadFor(req, (req.params as { id: string }).id, "own");
    const b = body(req, z.object({ title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional(), shared: z.boolean().optional() }));
    const [row] = await db.update(T).set({ ...b, updatedAt: thread.updatedAt }).where(eq(T.id, thread.id)).returning();
    return serializeThread(row!);
  });

  app.delete("/api/app/copilot/threads/:id", async (req) => {
    const { thread } = await threadFor(req, (req.params as { id: string }).id, "own");
    stopThread(thread.id);
    await db.delete(ACT).where(eq(ACT.threadId, thread.id));
    await db.delete(MSG).where(eq(MSG.threadId, thread.id));
    await db.delete(T).where(eq(T.id, thread.id));
    return { ok: true };
  });

  /** Sends a message (creating the chat when thread_id is absent) and streams the answer. */
  app.post("/api/app/copilot/chat", async (req, reply) => {
    const c = ctx(req);
    const b = body(req, chatBody);
    let thread: ThreadRow;
    let created = false;
    if (b.thread_id) {
      thread = (await threadFor(req, b.thread_id, "own")).thread;
      if ((await countUserMessages(thread.id)) >= MAX_USER_MESSAGES) throw conflict(`This chat has reached the maximum of ${MAX_USER_MESSAGES} messages. Start a new chat.`);
    } else {
      // No AI to answer with: no empty chat is left behind.
      await assertAi(c.wsId);
      const system = await buildSystem({ wsId: c.wsId, workspaceName: c.workspace.name, userName: [c.user.firstName, c.user.lastName].filter(Boolean).join(" ") });
      const title = b.text.replace(/\s+/g, " ").trim().slice(0, 80);
      thread = { ...(await db.insert(T).values({ workspaceId: c.wsId, userId: c.user.id, title, system }).returning())[0]! };
      created = true;
    }
    await assertCanRun(thread);
    const r = await runCtx(req, thread, () => undefined);
    await stream(reply, async (emit) => {
      r.emit = emit;
      if (created) emit("thread", serializeThread(thread));
      if (created && b.recurring) {
        const timeOfDay = new Intl.DateTimeFormat("en-GB", { timeZone: r.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
        const [task] = await db
          .insert(TK)
          .values({
            workspaceId: c.wsId,
            userId: c.user.id,
            title: thread.title,
            prompt: b.text,
            frequency: b.recurring.frequency,
            timeOfDay,
            timezone: r.timezone,
            ...firstSchedule(b.recurring.frequency, timeOfDay, r.timezone, true),
            sourceThreadId: thread.id,
          })
          .returning();
        await db.update(T).set({ taskId: task!.id }).where(eq(T.id, thread.id));
        emit("task", serializeTask(task!));
      }
      await sendUserMessage(r, b.text);
    });
  });

  app.post("/api/app/copilot/threads/:id/regenerate", async (req, reply) => {
    const { thread } = await threadFor(req, (req.params as { id: string }).id, "own");
    await assertCanRun(thread);
    // Refused before the answer streams when trying again could repeat changes the answer made.
    const plan = await retryPlan(thread.id);
    const r = await runCtx(req, thread, () => undefined);
    await stream(reply, async (emit) => {
      r.emit = emit;
      await regenerate(r, plan);
    });
  });

  /** Approve, deny, answer or skip a card; the chat continues once nothing else is waiting. */
  app.post("/api/app/copilot/threads/:id/actions/:action_id", async (req, reply) => {
    const p = req.params as { id: string; action_id: string };
    const { thread } = await threadFor(req, p.id, "own");
    const b = body(req, decisionBody);
    const [action] = await db.select().from(ACT).where(and(eq(ACT.id, p.action_id), eq(ACT.threadId, thread.id))).limit(1);
    if (!action) throw notFound("Action");
    await assertCanRun(thread);
    const r = await runCtx(req, thread, () => undefined);
    await stream(reply, async (emit) => {
      r.emit = emit;
      await decide(r, action, b.decision === "answer" ? { kind: "answer", answers: b.answers } : { kind: b.decision });
    });
  });

  app.post("/api/app/copilot/threads/:id/stop", async (req) => {
    const { thread } = await threadFor(req, (req.params as { id: string }).id, "own");
    const stopped = stopThread(thread.id);
    if (!stopped && thread.status === "running") await db.update(T).set({ status: "idle" }).where(eq(T.id, thread.id));
    return { stopped };
  });

  app.post("/api/app/copilot/messages/:id/feedback", async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ helpful: z.boolean(), text: z.string().trim().max(2_000).nullable().optional() }));
    const [m] = await db
      .select({ id: MSG.id })
      .from(MSG)
      .innerJoin(T, eq(T.id, MSG.threadId))
      .where(and(eq(MSG.id, (req.params as { id: string }).id), eq(T.workspaceId, c.wsId), eq(T.userId, c.user.id), eq(MSG.role, "assistant")))
      .limit(1);
    if (!m) throw notFound("Message");
    const feedback = { helpful: b.helpful, text: b.text ?? null, at: new Date().toISOString() };
    await db.update(MSG).set({ feedback }).where(eq(MSG.id, m.id));
    return { feedback };
  });

  /** Actions taken and time saved, for the new-chat page. */
  app.get("/api/app/copilot/stats", async (req) => {
    const c = ctx(req);
    const [row] = await db
      .select({ n: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${ACT.secondsSaved}), 0)` })
      .from(ACT)
      .where(and(eq(ACT.workspaceId, c.wsId), eq(ACT.userId, c.user.id), eq(ACT.status, "done")));
    const settings = await getCopilotSettings(c.user.id, c.wsId);
    return { enabled: settings.analytics, actions: Number(row?.n ?? 0), seconds_saved: Number(row?.s ?? 0), hours_saved: Math.round((Number(row?.s ?? 0) / 3600) * 10) / 10 };
  });

  // ---------- Card actions that act outside the model loop ----------

  async function ownAction(req: FastifyRequest, tool: string) {
    const c = ctx(req);
    const [row] = await db
      .select({ a: ACT, t: T })
      .from(ACT)
      .innerJoin(T, eq(T.id, ACT.threadId))
      .where(and(eq(ACT.id, (req.params as { id: string }).id), eq(ACT.workspaceId, c.wsId), eq(T.userId, c.user.id), eq(ACT.tool, tool)))
      .limit(1);
    if (!row || row.a.status !== "done") throw notFound("Card");
    return row;
  }

  async function setCard(actionId: string, result: Record<string, unknown>, card: Record<string, unknown>) {
    const [row] = await db.update(ACT).set({ result: { ...result, card } }).where(eq(ACT.id, actionId)).returning();
    return serializeAction(row!);
  }

  /** "Use in a campaign" on a sequence card: replaces an existing campaign's sequence or creates a campaign. */
  app.post("/api/app/copilot/actions/:id/use-sequence", { config: write }, async (req) => {
    const c = ctx(req);
    const { a } = await ownAction(req, "propose_sequence");
    const b = body(req, z.object({ campaign_id: z.string().optional(), new_campaign_name: z.string().trim().min(1).max(250).optional() }).refine((v) => !!v.campaign_id !== !!v.new_campaign_name, "Pick a campaign or name a new one"));
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const invoke = invokerFor(token, c.wsId);
    const result = (a.result ?? {}) as { card: { steps: Parameters<typeof toCampaignSteps>[0] } & Record<string, unknown> } & Record<string, unknown>;
    const sequences = [{ steps: toCampaignSteps(result.card.steps) }];
    let campaign: { id: string; name: string };
    if (b.campaign_id) campaign = await invoke("PATCH", `/api/v2/campaigns/${encodeURIComponent(b.campaign_id)}`, { sequences });
    else {
      const tz = timezoneOf(c);
      const days = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), d >= 1 && d <= 5]));
      campaign = await invoke("POST", "/api/v2/campaigns", { name: b.new_campaign_name, sequences, campaign_schedule: { schedules: [{ name: "Working hours", timing: { from: "09:00", to: "17:00" }, days, timezone: tz }] } });
    }
    return setCard(a.id, result, { ...result.card, used_in: { id: campaign.id, name: campaign.name, created: !b.campaign_id } });
  });

  /** "Place order" on a DFY quote card: re-prices first and refuses if anything changed since the quote. */
  app.post("/api/app/copilot/actions/:id/place-order", { config: { perm: "billing" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const { a } = await ownAction(req, "quote_dfy_order");
    const result = (a.result ?? {}) as { card: { order: Record<string, unknown>; quote: { due_now: number; valid: boolean }; status: string } & Record<string, unknown> } & Record<string, unknown>;
    if (result.card.status !== "quoted") throw conflict(result.card.status === "placed" ? "This order was already placed" : "This quote can no longer be ordered");
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const invoke = invokerFor(token, c.wsId);
    const fresh = await invoke<Record<string, unknown>>("POST", "/api/v2/dfy-email-account-orders", { ...result.card.order, simulation: true });
    if (!fresh.order_is_valid || Number(fresh.total_price) !== Number(result.card.quote.due_now)) {
      // The card says why it can't be ordered now (a domain taken since, say), as a first quote would.
      const quote = { ...result.card.quote, due_now: fresh.total_price, monthly: fresh.total_accounts_price_per_month, yearly_domains: fresh.total_domains_price_per_year, valid: !!fresh.order_is_valid, ...quoteProblems(fresh) };
      const card = { ...result.card, status: fresh.order_is_valid ? "changed" : "invalid", quote };
      return { action: await setCard(a.id, result, fresh.order_is_valid ? { ...card, status: "quoted" } : card), changed: true };
    }
    const placed = await invoke<Record<string, unknown>>("POST", "/api/v2/dfy-email-account-orders", { ...result.card.order, simulation: false });
    if (!placed.order_placed) throw badRequest("The order couldn't be placed. Ask Copilot to adjust it.");
    return { action: await setCard(a.id, result, { ...result.card, status: "placed", placed: { domains: placed.number_of_domains_ordered, accounts: placed.number_of_accounts_ordered } }), changed: false };
  });

  app.post("/api/app/copilot/actions/:id/decline-order", async (req) => {
    const { a } = await ownAction(req, "quote_dfy_order");
    const result = (a.result ?? {}) as { card: Record<string, unknown> } & Record<string, unknown>;
    if (result.card.status !== "quoted") throw conflict("This quote is no longer open");
    return { action: await setCard(a.id, result, { ...result.card, status: "dismissed" }) };
  });

  // ---------- Memory ----------

  app.get("/api/app/copilot/memory", async (req) => {
    const m = await getMemory(ctx(req).wsId);
    let updatedByName: string | null = null;
    if (m?.updatedBy) {
      const [u] = await db.select({ f: schema.users.firstName, l: schema.users.lastName, e: schema.users.email }).from(schema.users).where(eq(schema.users.id, m.updatedBy)).limit(1);
      updatedByName = u ? [u.f, u.l].filter(Boolean).join(" ") || u.e : null;
    }
    return { memory: m?.data ?? null, updated_at: iso(m?.updatedAt ?? null), updated_by: updatedByName };
  });

  app.put("/api/app/copilot/memory", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ memory: memorySchema }));
    const m = await saveMemory(c.wsId, c.user.id, b.memory);
    return { memory: m.data, updated_at: iso(m.updatedAt) };
  });

  app.delete("/api/app/copilot/memory", { config: write }, async (req) => {
    await clearMemory(ctx(req).wsId);
    return { ok: true };
  });

  app.post("/api/app/copilot/memory/extract/website", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ url: z.string().trim().min(4).max(500) }));
    const url = /^https?:\/\//i.test(b.url) ? b.url : `https://${b.url}`;
    try {
      new URL(url);
    } catch {
      throw badRequest("Enter a website address such as https://example.com");
    }
    try {
      return { memory: await extractFromWebsite(c.wsId, url) };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, `Couldn't read that website: ${aiErrorMessage(err)}`, "extract_failed");
    }
  });

  /** Multipart field "file": a PDF or text document of up to 10 MB. */
  app.post("/api/app/copilot/memory/extract/file", { config: write }, async (req) => {
    const c = ctx(req);
    const part = await req.file();
    if (!part) throw badRequest("Choose a file");
    const okType = /^(application\/pdf|text\/(plain|markdown|csv|html))$/.test(part.mimetype) || /\.(pdf|txt|md)$/i.test(part.filename);
    if (!okType) throw badRequest("Upload a PDF or a text document");
    const bytes = await part.toBuffer();
    if (bytes.length > 10 * 1024 * 1024) throw badRequest("The file must be smaller than 10 MB");
    try {
      return { memory: await extractFromFile(c.wsId, { name: part.filename, mime: part.mimetype, bytes }) };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, `Couldn't read that file: ${aiErrorMessage(err)}`, "extract_failed");
    }
  });

  /** Job titles from the lead database for the ICP title filters. */
  app.get("/api/app/copilot/memory/job-titles", async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ q: z.string().trim().min(1).max(100) }));
    const needle = `%${escapeLike(q.q.toLowerCase())}%`;
    const rows = await db.all<{ title: string; n: number }>(
      sql`select title, count(*) as n from lf_people where (workspace_id is null or workspace_id = ${c.wsId}) and title is not null and lower(title) like ${needle} escape '\\' group by lower(title) order by n desc limit 15`,
    );
    return { items: rows.map((r) => r.title) };
  });

  // ---------- Tasks ----------

  app.get("/api/app/copilot/tasks", async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(TK).where(and(eq(TK.workspaceId, c.wsId), eq(TK.userId, c.user.id))).orderBy(desc(TK.createdAt));
    return { items: rows.map(serializeTask) };
  });

  app.post("/api/app/copilot/tasks", async (req) => {
    const c = ctx(req);
    const b = body(req, taskBody);
    const tz = b.timezone || timezoneOf(c);
    const count = await db.select({ id: TK.id }).from(TK).where(and(eq(TK.workspaceId, c.wsId), eq(TK.userId, c.user.id)));
    if (count.length >= 50) throw badRequest("You can have up to 50 tasks. Delete one first.");
    const [row] = await db
      .insert(TK)
      .values({ workspaceId: c.wsId, userId: c.user.id, title: b.title, prompt: b.prompt, frequency: b.frequency, timeOfDay: b.time_of_day, timezone: tz, ...firstSchedule(b.frequency, b.time_of_day, tz, !!b.ran_now), sourceThreadId: b.source_thread_id ?? null })
      .returning();
    return serializeTask(row!);
  });

  async function ownTask(req: FastifyRequest) {
    const c = ctx(req);
    const [t] = await db.select().from(TK).where(and(eq(TK.id, (req.params as { id: string }).id), eq(TK.workspaceId, c.wsId), eq(TK.userId, c.user.id))).limit(1);
    if (!t) throw notFound("Task");
    return t;
  }

  app.patch("/api/app/copilot/tasks/:id", async (req) => {
    const t = await ownTask(req);
    const b = body(req, taskBody.omit({ source_thread_id: true, ran_now: true }).partial().extend({ status: z.enum(["active", "paused"]).optional() }));
    const freq = (b.frequency ?? t.frequency) as Frequency;
    const time = b.time_of_day ?? t.timeOfDay ?? "09:00";
    const tz = b.timezone ?? t.timezone ?? "UTC";
    const reschedule = b.frequency !== undefined || b.time_of_day !== undefined || b.timezone !== undefined || (b.status === "active" && t.status !== "active");
    const [row] = await db
      .update(TK)
      .set({ ...(b.title ? { title: b.title } : {}), ...(b.prompt ? { prompt: b.prompt } : {}), frequency: freq, timeOfDay: time, timezone: tz, ...(b.status ? { status: b.status } : {}), ...(reschedule ? firstSchedule(freq, time, tz) : {}) })
      .where(eq(TK.id, t.id))
      .returning();
    return serializeTask(row!);
  });

  app.delete("/api/app/copilot/tasks/:id", async (req) => {
    const t = await ownTask(req);
    await db.delete(TK).where(eq(TK.id, t.id));
    return { ok: true };
  });

  /** Runs a task now (also "Retry" after a failure); the run continues in the background. */
  app.post("/api/app/copilot/tasks/:id/run", async (req) => {
    const t = await ownTask(req);
    if (t.lockedUntil && t.lockedUntil.getTime() > Date.now()) throw conflict("This task is already running");
    await assertAi(t.workspaceId);
    const [locked] = await db.update(TK).set({ lockedUntil: new Date(Date.now() + 15 * 60_000) }).where(eq(TK.id, t.id)).returning();
    void runTask(locked!).catch(async (err) => {
      await db.update(TK).set({ lockedUntil: null, lastStatus: "failed", lastError: String((err as Error).message).slice(0, 500), lastRunAt: new Date() }).where(eq(TK.id, t.id));
    });
    return serializeTask(locked!);
  });

  // ---------- Settings ----------

  app.get("/api/app/copilot/settings", async (req) => {
    const c = ctx(req);
    const [settings, integrations] = await Promise.all([getCopilotSettings(c.user.id, c.wsId), listIntegrations(c.wsId)]);
    return {
      settings,
      models: CHAT_MODELS,
      workspace_model: (c.workspace.settings?.ai_model as string | null) ?? null,
      slack_connections: integrations.filter((i) => i.type === "slack").map((i) => ({ id: i.id, name: i.name })),
      ai_available: await aiAvailable(c.wsId),
    };
  });

  app.put("/api/app/copilot/settings", async (req) => {
    const c = ctx(req);
    const b = body(req, settingsSchema.partial().strict());
    if (b.slack_integration_id) {
      const ok = (await listIntegrations(c.wsId)).some((i) => i.type === "slack" && i.id === b.slack_integration_id);
      if (!ok) throw badRequest("slack_integration_id: account not found, try another one");
    }
    return { settings: await saveCopilotSettings(c.user.id, c.wsId, b) };
  });

}
