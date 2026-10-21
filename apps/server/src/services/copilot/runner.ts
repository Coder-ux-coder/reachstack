// The copilot chat loop: stream Claude's answer (or take the local AI's whole answer), run the tools it calls, and
// stop when it is done or when a card needs the user (an approval or a question). History is append-only and the system prompt and tool list
// are fixed per chat, so every request replays an unchanged prefix (thinking blocks stay valid, the cache hits).
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import * as z from "zod/v4";
import { db, schema } from "../../db/client";
import { config } from "../../env";
import { HttpError } from "../../http/errors";
import { iso } from "../../lib/time";
import { aiErrorMessage, cachedSystem, localToolTurn, modelOptions, recordUsage, resolveAi, structured, usesLocalAi } from "../ai";
import { workspaceZone } from "../workspace-clock";
import { getMemory, memoryPrompt } from "./memory";
import type { CopilotSettings } from "./settings";
import { describeAction, needsApproval, resultText, TOOL_BY_NAME, ToolError, toolParams, type Invoke, type ToolCtx, type ToolDef } from "./tools";

const T = schema.copilotThreads;
const MSG = schema.copilotMessages;
const ACT = schema.copilotActions;

export type ThreadRow = typeof T.$inferSelect;
export type MessageRow = typeof MSG.$inferSelect;
export type ActionRow = typeof ACT.$inferSelect;
type Block = Anthropic.Beta.BetaContentBlockParam;
type Param = Anthropic.Beta.BetaMessageParam;

export const MAX_USER_MESSAGES = 50;
const MAX_ROUNDS = 12;
const MAX_TOKENS = 32_000;
const PENDING = ["awaiting_approval", "awaiting_answer"];

export type Emit = (event: string, data: unknown) => void;

export interface RunCtx {
  thread: ThreadRow;
  wsId: string;
  userId: string;
  timezone: string;
  settings: CopilotSettings;
  invoke: Invoke;
  emit: Emit;
}

// ---------- System prompt (fixed when the chat starts) ----------

export async function buildSystem(o: { wsId: string; workspaceName: string; userName: string }): Promise<string> {
  const brand = `${config.brandName} AI`;
  const memory = memoryPrompt((await getMemory(o.wsId))?.data ?? null);
  return `You are ${brand}, the assistant inside ${config.brandName}, a cold email platform: sending accounts with warmup, campaigns with email sequences, a B2B lead database (Lead Finder), a unified inbox (Unibox), a CRM and AI agents. You are helping ${o.userName || "the user"} in the workspace "${o.workspaceName}".

How you work:
- Look things up with your tools instead of guessing, and quote the real numbers they return. If a tool says something is unavailable, say so plainly.
- When you write an email sequence, show it with propose_sequence (the user gets a card with a "Use in a campaign" button). Don't paste whole sequences into the chat.
- When you suggest who to target, use search_lead_database so the user sees the filters and how many people match.
- Tools that change things (campaigns, leads, agents, memory, tasks) may wait for the user's approval. If the user declines, accept it and offer another way.
- Use ask_user_question only when the answer changes what you do next, such as the audience or which campaign. Otherwise make a sensible choice and say what you assumed.
- quote_dfy_order only prices new domains and mailboxes; the user places the order from the card. Never say an order was placed.
- Answer briefly: short paragraphs, bullet lists, bold for key numbers, Markdown tables for comparisons. No preamble.
- Cold email that works: plain text, under about 120 words, one clear ask, no spam phrases or exclamation marks, at most one link. Variables: {{firstName}}, {{lastName}}, {{companyName}}, {{sendingAccountFirstName}}. Fallbacks: {{firstName | there}}. Spintax: {{RANDOM | Hi | Hey}}.
- Each user message ends with the current date and time; use its date for date ranges ("this week" runs Monday to today). Analytics count days on the workspace's calendar, which it names when that date differs from the user's.
- If you don't know what the business sells, check the memory below. If it is empty, ask for their website, or suggest filling in memory (Copilot → Memory).

<business_memory>
${memory || "(empty)"}
</business_memory>`;
}

/**
 * The current time where the user is, appended to each user message (never edited later), with today's date on the
 * workspace's calendar when it isn't the user's: analytics count days on that calendar.
 */
export function contextLine(timezone: string, workspaceZone: string, at = new Date()): string {
  const valid = (zone: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    } catch {
      return "UTC";
    }
  };
  const tz = valid(timezone);
  const ws = valid(workspaceZone);
  const now = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  const day = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
  const today = day(ws) === day(tz) ? `Today is ${day(tz)}.` : `Today is ${day(tz)} for the user and ${day(ws)} on the workspace's calendar (${ws}), which analytics and date ranges go by.`;
  return `<context>Now: ${now} (${tz}). ${today}</context>`;
}

// ---------- Storage ----------

async function insertMessage(threadId: string, role: "user" | "assistant", content: Block[] | Anthropic.Beta.BetaContentBlock[], extra: Partial<typeof MSG.$inferInsert> = {}) {
  // Strictly increasing timestamps keep the history order stable even within one millisecond.
  const [last] = await db.select({ at: MSG.createdAt }).from(MSG).where(eq(MSG.threadId, threadId)).orderBy(desc(MSG.createdAt)).limit(1);
  const createdAt = new Date(Math.max(Date.now(), (last?.at.getTime() ?? 0) + 1));
  const [row] = await db
    .insert(MSG)
    .values({ threadId, role, content, createdAt, ...extra })
    .returning();
  await db.update(T).set({ updatedAt: new Date() }).where(eq(T.id, threadId));
  return row!;
}

export async function setThreadStatus(threadId: string, status: "idle" | "running" | "waiting") {
  await db.update(T).set({ status }).where(eq(T.id, threadId));
}

/** Messages as the API expects them: consecutive rows of the same role become one turn. */
async function loadHistory(threadId: string): Promise<Param[]> {
  const rows = await db.select().from(MSG).where(eq(MSG.threadId, threadId)).orderBy(asc(MSG.createdAt), asc(MSG.id));
  return pairResults(rows.map((r) => ({ role: r.role as "user" | "assistant", content: [...(r.content as Block[])] })));
}

/**
 * Joins rows of the same role into one turn and starts the turn after each tool call with the call's result, as the
 * API requires, wherever the result was stored: an answer cut short by a restart gets its results later, after
 * whatever was written since. A call that never got one says so.
 */
export function pairResults(rows: Param[]): Param[] {
  const results = new Map<string, Block>();
  for (const r of rows) if (r.role === "user") for (const b of r.content as Block[]) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const out: Param[] = [];
  const add = (role: "user" | "assistant", content: Block[]) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = [...(prev.content as Block[]), ...content];
    else out.push({ role, content });
  };
  for (const r of rows) {
    const blocks = r.content as Block[];
    if (r.role === "user") {
      const rest = blocks.filter((b) => b.type !== "tool_result");
      if (rest.length) add("user", rest);
      continue;
    }
    add("assistant", blocks);
    const calls = blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use").map((b) => b.id);
    if (calls.length) add("user", calls.map((id) => results.get(id) ?? ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Not run: the answer was cut short." } as Block)));
  }
  return out;
}

/** A cache breakpoint on the newest block, so the next turn reads the whole conversation from cache. */
function withCacheBreakpoint(messages: Param[]): Param[] {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return messages;
  const blocks = [...(last.content as Block[])];
  const i = blocks.length - 1;
  const b = blocks[i]!;
  if (b.type === "text" || b.type === "tool_result") blocks[i] = { ...b, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

const stripThinking = (messages: Param[]): Param[] =>
  messages.map((m) => (m.role === "assistant" && Array.isArray(m.content) ? { ...m, content: (m.content as Block[]).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") } : m));

// ---------- Serialization for the chat ----------

export function serializeMessage(m: MessageRow) {
  const content = (m.content ?? []) as Array<Record<string, unknown>>;
  const display = (m.display ?? {}) as { text?: string; suggestions?: string[] };
  const blocks =
    m.role === "assistant"
      ? content.filter((b) => (b.type === "text" && String(b.text ?? "").trim()) || b.type === "tool_use").map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name }))
      : [{ type: "text", text: display.text ?? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") }];
  return {
    id: m.id,
    role: m.role,
    blocks,
    stop_reason: m.stopReason,
    feedback: m.feedback ?? null,
    suggestions: display.suggestions ?? [],
    created_at: iso(m.createdAt),
  };
}

export function serializeAction(a: ActionRow) {
  const def = TOOL_BY_NAME.get(a.tool);
  const result = (a.result ?? {}) as { card?: Record<string, unknown>; answers?: unknown; summary?: string };
  return {
    id: a.id,
    tool_use_id: a.toolUseId,
    message_id: a.messageId,
    tool: a.tool,
    kind: def?.kind ?? "read",
    status: a.status,
    working: def?.working ?? "Working",
    summary: summaryOf(a),
    input: a.input,
    card: result.card ?? null,
    answers: result.answers ?? null,
    error: a.error,
    created_at: iso(a.createdAt),
  };
}

/** What the action does, in a line: the one worked out when it was called (naming its campaign), or from its input. */
function summaryOf(a: ActionRow): string | null {
  const saved = (a.result as { summary?: unknown } | null)?.summary;
  if (typeof saved === "string") return saved;
  const def = TOOL_BY_NAME.get(a.tool);
  return def?.describe ? safeDescribe(def, a.input) : null;
}

function safeDescribe(def: ToolDef, input: unknown) {
  try {
    return def.describe!(input as never, { campaign: null });
  } catch {
    return null;
  }
}

// ---------- Tool calls ----------

function toolCtx(r: RunCtx): ToolCtx {
  return { wsId: r.wsId, userId: r.userId, threadId: r.thread.id, timezone: r.timezone, settings: r.settings, invoke: r.invoke };
}

async function updateAction(id: string, set: Partial<typeof ACT.$inferInsert>) {
  const [row] = await db.update(ACT).set(set).where(eq(ACT.id, id)).returning();
  return row!;
}

/** Actions running in this process now: settling what a restart cut short (settleInterrupted) leaves them alone. */
const executing = new Set<string>();

/** Runs one tool call and records the outcome on its action row. */
async function execute(r: RunCtx, a: ActionRow): Promise<ActionRow> {
  const def = TOOL_BY_NAME.get(a.tool)!;
  executing.add(a.id);
  try {
    let row = await updateAction(a.id, { status: "running", error: null });
    r.emit("action", serializeAction(row));
    const summary = (a.result as { summary?: string } | null)?.summary;
    try {
      const out = await def.run(a.input as never, toolCtx(r));
      row = await updateAction(a.id, {
        status: "done",
        result: { ...(summary ? { summary } : {}), content: out.content as Record<string, unknown>, ...(out.card ? { card: out.card } : {}) },
        secondsSaved: def.minutesSaved * 60,
      });
    } catch (err) {
      const message = err instanceof ToolError || err instanceof HttpError ? err.message : aiErrorMessage(err);
      row = await updateAction(a.id, { status: "error", error: message.slice(0, 2_000) });
    }
    r.emit("action", serializeAction(row));
    return row;
  } finally {
    executing.delete(a.id);
  }
}

/** The tool_result block the model reads for a finished action. */
function resultBlock(a: ActionRow): Anthropic.Beta.BetaToolResultBlockParam {
  const res = (a.result ?? {}) as { content?: unknown; answers?: unknown; invalid?: unknown };
  switch (a.status) {
    case "done":
      return { type: "tool_result", tool_use_id: a.toolUseId, content: resultText(res.content ?? "Done.") };
    case "answered":
      return { type: "tool_result", tool_use_id: a.toolUseId, content: resultText({ answers: res.answers }) };
    case "skipped":
      return { type: "tool_result", tool_use_id: a.toolUseId, content: a.error ?? "The user chose to answer in the chat instead. Wait for their message." };
    case "denied":
      return { type: "tool_result", tool_use_id: a.toolUseId, is_error: true, content: a.error ?? "The user declined this action. Don't retry it unless they ask." };
    default:
      return { type: "tool_result", tool_use_id: a.toolUseId, is_error: true, content: a.error ?? "The tool failed." };
  }
}

/**
 * Creates action rows for the tool calls in an assistant turn and runs what may run now.
 * Returns "waiting" when an approval or an answer is still needed.
 */
async function handleToolCalls(r: RunCtx, message: MessageRow, calls: Anthropic.Beta.BetaToolUseBlock[]): Promise<"continue" | "waiting"> {
  let waiting = false;
  for (const call of calls) {
    const def = TOOL_BY_NAME.get(call.name);
    const input = (call.input ?? {}) as Record<string, unknown>;
    const base = { workspaceId: r.wsId, userId: r.userId, threadId: r.thread.id, messageId: message.id, toolUseId: call.id, tool: call.name, input };
    if (!def) {
      const [row] = await db.insert(ACT).values({ ...base, status: "error", error: `Unknown tool ${call.name}` }).returning();
      r.emit("action", serializeAction(row!));
      continue;
    }
    // Inputs can arrive truncated or malformed (eager input streaming); never run a tool on them.
    const parsed = def.schema.safeParse(input);
    if (!parsed.success) {
      const [row] = await db
        .insert(ACT)
        .values({ ...base, status: "error", error: JSON.stringify({ INVALID_JSON: JSON.stringify(input), issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }) })
        .returning();
      r.emit("action", serializeAction(row!));
      continue;
    }
    const clean = parsed.data as Record<string, unknown>;
    if (def.kind === "question") {
      const out = await def.run(clean as never, toolCtx(r));
      const [row] = await db.insert(ACT).values({ ...base, input: clean, status: "awaiting_answer", result: { card: out.card } }).returning();
      r.emit("action", serializeAction(row!));
      waiting = true;
      continue;
    }
    // Changes carry a line saying what they do (the approval card's, and what "Try again" says was done).
    const summary = def.kind === "write" ? await describeAction(def, clean, toolCtx(r)) : null;
    const described = summary ? { result: { summary } } : {};
    if (needsApproval(def, r.settings)) {
      const [row] = await db.insert(ACT).values({ ...base, input: clean, status: "awaiting_approval", ...described }).returning();
      r.emit("action", serializeAction(row!));
      waiting = true;
      continue;
    }
    const [row] = await db.insert(ACT).values({ ...base, input: clean, status: "running", ...described }).returning();
    await execute(r, row!);
  }
  if (waiting) return "waiting";
  await appendResults(r.thread.id, message.id);
  return "continue";
}

/** Settling runs one at a time per chat: two cards settled at once add the turn's results once. */
const settling = new Map<string, Promise<boolean>>();

/** Once every call of an assistant turn is settled, adds the turn's tool results to the history (once). */
function appendResults(threadId: string, messageId: string): Promise<boolean> {
  const run = (settling.get(threadId) ?? Promise.resolve(true)).catch(() => true).then(() => appendResultsNow(threadId, messageId));
  settling.set(threadId, run);
  const done = () => {
    if (settling.get(threadId) === run) settling.delete(threadId);
  };
  run.then(done, done);
  return run;
}

async function appendResultsNow(threadId: string, messageId: string): Promise<boolean> {
  const actions = await db.select().from(ACT).where(and(eq(ACT.threadId, threadId), eq(ACT.messageId, messageId)));
  if (actions.some((a) => PENDING.includes(a.status) || a.status === "running")) return false;
  const [message] = await db.select().from(MSG).where(eq(MSG.id, messageId)).limit(1);
  const order = ((message?.content ?? []) as Array<{ type: string; id?: string }>).filter((b) => b.type === "tool_use").map((b) => b.id!);
  // Already in the history: another card of the turn settled it.
  if (order.length) {
    const [added] = await db
      .select({ id: MSG.id })
      .from(MSG)
      .where(and(eq(MSG.threadId, threadId), eq(MSG.role, "user"), sql`json_extract(${MSG.content}, '$[0].tool_use_id') = ${order[0]}`))
      .limit(1);
    if (added) return true;
  }
  const byId = new Map(actions.map((a) => [a.toolUseId, a]));
  const blocks = order.map((id) => (byId.has(id) ? resultBlock(byId.get(id)!) : ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Not run." } as Anthropic.Beta.BetaToolResultBlockParam)));
  await insertMessage(threadId, "user", blocks, { hidden: true });
  return true;
}

/** Settles calls still waiting on the user (they wrote a new message instead). */
async function supersedePending(threadId: string) {
  const pending = await db.select().from(ACT).where(and(eq(ACT.threadId, threadId), inArray(ACT.status, PENDING)));
  if (!pending.length) return;
  for (const a of pending) {
    if (a.status === "awaiting_answer") await updateAction(a.id, { status: "skipped", error: "The user didn't pick an answer and wrote a new message instead." });
    else await updateAction(a.id, { status: "denied", error: "The user didn't approve this and wrote a new message instead. Don't run it unless they ask." });
  }
  for (const messageId of new Set(pending.map((a) => a.messageId))) await appendResults(threadId, messageId);
}

// ---------- Answers cut short ----------

const STARTED_AT = Date.now();

/** A chat marked as answering that nothing here is answering: the app restarted mid-answer, or it went quiet for two minutes. */
export function interrupted(t: ThreadRow): boolean {
  return t.status === "running" && !isRunning(t.id) && (t.updatedAt.getTime() < STARTED_AT || Date.now() - t.updatedAt.getTime() > 120_000);
}

/**
 * Settles what an answer cut short left behind, so the chat can carry on: calls still marked as running failed (they
 * may or may not have finished), and their results go into the chat.
 */
async function settleInterrupted(threadId: string) {
  if (isRunning(threadId)) return;
  const stale = (await db.select().from(ACT).where(and(eq(ACT.threadId, threadId), eq(ACT.status, "running")))).filter((a) => !executing.has(a.id));
  for (const a of stale) {
    const write = TOOL_BY_NAME.get(a.tool)?.kind === "write";
    await updateAction(a.id, {
      status: "error",
      error: write ? "The app restarted while this ran, so it may or may not have finished. Check before doing it again." : "The app restarted while this ran. Run it again if it's still needed.",
      result: { ...((a.result ?? {}) as Record<string, unknown>), interrupted: true },
    });
  }
  for (const messageId of new Set(stale.map((a) => a.messageId))) await appendResults(threadId, messageId);
}

// ---------- Streaming one model turn ----------

class Stopped extends Error {
  constructor(public partial: string) {
    super("stopped");
  }
}

/** Eager input streaming only toward the real API: a proxy may reject the field. */
function eagerAllowed(): boolean {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return true;
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

async function streamTurn(o: { client: Anthropic; model: string; system: string; messages: Param[]; signal: AbortSignal; emit: Emit }): Promise<Anthropic.Beta.BetaMessage> {
  const stream = o.client.beta.messages.stream(
    { ...modelOptions(o.model, "medium"), max_tokens: MAX_TOKENS, system: cachedSystem(o.system), tools: toolParams(eagerAllowed()), messages: withCacheBreakpoint(o.messages) },
    { signal: o.signal },
  );
  const drafts = new Map<number, string>();
  try {
    // With eager input streaming an unparseable tool input rejects here or in finalMessage(), so both sit in the try.
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "text") o.emit("block", { index: ev.index, type: "text" });
        else if (b.type === "thinking" || b.type === "redacted_thinking") o.emit("block", { index: ev.index, type: "thinking" });
        else if (b.type === "tool_use") o.emit("block", { index: ev.index, type: "tool_use", id: b.id, name: b.name, working: TOOL_BY_NAME.get(b.name)?.working ?? "Working" });
      } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        drafts.set(ev.index, (drafts.get(ev.index) ?? "") + ev.delta.text);
        o.emit("text", { index: ev.index, delta: ev.delta.text });
      }
    }
    return await stream.finalMessage();
  } catch (err) {
    if (o.signal.aborted) throw new Stopped([...drafts.values()].join("\n\n").trim());
    throw err;
  }
}

/** One turn on the server's local AI (no streaming there): the answer is shown once it's complete. */
async function localTurn(o: { system: string; messages: Param[]; signal: AbortSignal; emit: Emit }): Promise<Anthropic.Beta.BetaMessage> {
  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await localToolTurn({ system: o.system, messages: o.messages, tools: toolParams(false), maxTokens: MAX_TOKENS, signal: o.signal });
  } catch (err) {
    if (o.signal.aborted) throw new Stopped("");
    throw err;
  }
  msg.content.forEach((b, index) => {
    if (b.type === "text") {
      o.emit("block", { index, type: "text" });
      o.emit("text", { index, delta: b.text });
    } else if (b.type === "tool_use") o.emit("block", { index, type: "tool_use", id: b.id, name: b.name, working: TOOL_BY_NAME.get(b.name)?.working ?? "Working" });
  });
  return msg;
}

const isBindingError = (err: unknown) => err instanceof Anthropic.BadRequestError && /thinking/i.test(err.message) && /signature|bound|binding/i.test(err.message);

// ---------- The loop ----------

const running = new Map<string, AbortController>();

export function isRunning(threadId: string) {
  return running.has(threadId);
}

export function stopThread(threadId: string): boolean {
  const ac = running.get(threadId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/** Runs the model until it finishes or waits on the user. Errors reach the chat as an "error" event. */
export async function respond(r: RunCtx): Promise<"idle" | "waiting"> {
  const ac = new AbortController();
  running.set(r.thread.id, ac);
  await setThreadStatus(r.thread.id, "running");
  let status: "idle" | "waiting" = "idle";
  try {
    status = await loop(r, ac.signal);
  } catch (err) {
    r.emit("error", { message: err instanceof HttpError ? err.message : aiErrorMessage(err) });
  } finally {
    running.delete(r.thread.id);
    await setThreadStatus(r.thread.id, status);
    r.emit("done", { status });
  }
  return status;
}

async function loop(r: RunCtx, signal: AbortSignal): Promise<"idle" | "waiting"> {
  // The server's local AI (Ollama, LM Studio…) when the workspace has no Claude key of its own.
  const local = await usesLocalAi(r.wsId);
  const claude = local ? null : await resolveAi(r.wsId);
  const model = claude ? (r.settings.chat_model ?? claude.model) : config.openai.model;
  let jsonRetries = 0;
  let stripped = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) return "idle";
    const history = await loadHistory(r.thread.id);
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = claude
        ? await streamTurn({ client: claude.client, model, system: r.thread.system ?? "", messages: stripped ? stripThinking(history) : history, signal, emit: r.emit })
        : await localTurn({ system: r.thread.system ?? "", messages: history, signal, emit: r.emit });
      jsonRetries = 0;
    } catch (err) {
      if (err instanceof Stopped) {
        if (err.partial) {
          const row = await insertMessage(r.thread.id, "assistant", [{ type: "text", text: `${err.partial}\n\n_(stopped)_` }], { stopReason: "stopped", model });
          r.emit("message", serializeMessage(row));
        }
        return "idle";
      }
      // A history that no longer matches its thinking signatures: one retry without the old thinking.
      if (isBindingError(err) && !stripped) {
        stripped = true;
        r.emit("reset", {});
        round--;
        continue;
      }
      // A tool input the SDK could not parse at all: re-issue the turn (API errors are not retried here).
      if (!(err instanceof Anthropic.APIError) && !(err instanceof HttpError) && jsonRetries++ < 2) {
        r.emit("reset", {});
        round--;
        continue;
      }
      throw err;
    }
    await recordUsage(r.wsId, "copilot", msg.model ?? model, msg.usage);

    if (msg.stop_reason === "refusal") {
      const row = await insertMessage(r.thread.id, "assistant", [{ type: "text", text: "I can't help with that request." }], { stopReason: "refusal", model: msg.model });
      r.emit("message", serializeMessage(row));
      return "idle";
    }
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason === "max_tokens" && calls.length) {
      // A cut-off tool input can still look valid: keep the text, drop the call.
      const text = msg.content.filter((b) => b.type === "text");
      const row = await insertMessage(r.thread.id, "assistant", text.length ? text : [{ type: "text", text: "_(The answer was cut off.)_" }], { stopReason: "max_tokens", model: msg.model });
      r.emit("message", serializeMessage(row));
      r.emit("error", { message: "The answer got too long and was cut off. Ask for a shorter version or one step at a time." });
      return "idle";
    }
    const row = await insertMessage(r.thread.id, "assistant", msg.content, { stopReason: msg.stop_reason, model: msg.model });
    r.emit("message", serializeMessage(row));
    if (msg.stop_reason === "pause_turn") continue;
    if (!calls.length) {
      if (r.settings.follow_up_suggestions && msg.stop_reason === "end_turn") await suggestFollowUps(r, row);
      return "idle";
    }
    if ((await handleToolCalls(r, row, calls)) === "waiting") return "waiting";
  }
  r.emit("error", { message: "I stopped after many steps. Say \"continue\" if you want me to keep going." });
  return "idle";
}

// ---------- Entry points ----------

/** Adds the user's message (settling any card they skipped, and an answer a restart cut short) and answers it. */
export async function sendUserMessage(r: RunCtx, text: string) {
  await settleInterrupted(r.thread.id);
  await supersedePending(r.thread.id);
  const row = await insertMessage(r.thread.id, "user", [{ type: "text", text }, { type: "text", text: contextLine(r.timezone, await workspaceZone(r.wsId)) }], { display: { text } });
  r.emit("message", serializeMessage(row));
  return respond(r);
}

export async function countUserMessages(threadId: string) {
  const rows = await db.select({ id: MSG.id }).from(MSG).where(and(eq(MSG.threadId, threadId), eq(MSG.role, "user"), eq(MSG.hidden, false)));
  return rows.length;
}

async function lastUserMessage(threadId: string) {
  const [row] = await db
    .select()
    .from(MSG)
    .where(and(eq(MSG.threadId, threadId), eq(MSG.role, "user"), eq(MSG.hidden, false)))
    .orderBy(desc(MSG.createdAt))
    .limit(1);
  if (!row) throw new HttpError(400, "Nothing to try again yet");
  return row;
}

/**
 * What "Try again" does with the last answer. One that changed nothing is answered again. One that made changes
 * and stopped part-way (an error, a restart) carries on from where it stopped: answering again could make them
 * twice, so a finished one that made changes isn't tried again at all.
 */
export async function retryPlan(threadId: string): Promise<"again" | "continue"> {
  await settleInterrupted(threadId);
  const lastUser = await lastUserMessage(threadId);
  const later = await db.select().from(MSG).where(and(eq(MSG.threadId, threadId), gt(MSG.createdAt, lastUser.createdAt))).orderBy(asc(MSG.createdAt), asc(MSG.id));
  if (!later.length) return "again";
  const actions = await db.select().from(ACT).where(and(eq(ACT.threadId, threadId), inArray(ACT.messageId, later.map((m) => m.id))));
  const changed = actions.filter((a) => TOOL_BY_NAME.get(a.tool)?.kind === "write" && (a.status === "done" || (a.result as { interrupted?: boolean } | null)?.interrupted));
  if (!changed.length) return "again";
  const end = later[later.length - 1]!;
  const finished = end.role === "assistant" && !((end.content ?? []) as Array<{ type: string }>).some((b) => b.type === "tool_use");
  if (!finished) return "continue";
  const what = [...new Set(changed.map(summaryOf).filter((s): s is string => !!s))].join("; ");
  throw new HttpError(409, `This answer already made changes${what ? ` (${what})` : ""}, so trying it again could make them twice. Write what you'd like instead.`, "already_changed");
}

/** "Try again": drops the last answer (everything after the newest user message) and answers again, or carries on (see retryPlan). */
export async function regenerate(r: RunCtx, plan?: "again" | "continue") {
  if ((plan ?? (await retryPlan(r.thread.id))) === "continue") {
    await supersedePending(r.thread.id);
    return respond(r);
  }
  const lastUser = await lastUserMessage(r.thread.id);
  const later = await db.select({ id: MSG.id }).from(MSG).where(and(eq(MSG.threadId, r.thread.id), gt(MSG.createdAt, lastUser.createdAt)));
  const ids = later.map((m) => m.id);
  if (ids.length) {
    await db.delete(ACT).where(and(eq(ACT.threadId, r.thread.id), inArray(ACT.messageId, ids)));
    await db.delete(MSG).where(inArray(MSG.id, ids));
  }
  r.emit("truncate", { after: lastUser.id });
  return respond(r);
}

export type Decision = { kind: "approve" } | { kind: "deny" } | { kind: "answer"; answers: Array<{ question: string; answer: string[] }> } | { kind: "skip" };

/** Applies the user's click on an approval or question card; continues the chat once nothing else is waiting. */
export async function decide(r: RunCtx, action: ActionRow, d: Decision) {
  await settleInterrupted(r.thread.id);
  const waitingFor = d.kind === "approve" || d.kind === "deny" ? "awaiting_approval" : "awaiting_answer";
  const set: Partial<typeof ACT.$inferInsert> =
    d.kind === "approve"
      ? { status: "running", error: null }
      : d.kind === "deny"
        ? { status: "denied", error: null }
        : d.kind === "skip"
          ? { status: "skipped", error: null }
          : { status: "answered", result: { card: ((action.result ?? {}) as { card?: unknown }).card, answers: d.answers } as Record<string, unknown> };
  // Taken in one statement: of two clicks at once (a double click, a second tab) one counts, so an action runs once.
  const [taken] = await db
    .update(ACT)
    .set(set)
    .where(and(eq(ACT.id, action.id), eq(ACT.status, waitingFor)))
    .returning();
  if (!taken) throw new HttpError(409, waitingFor === "awaiting_approval" ? "This action is no longer waiting for approval" : "This question is no longer active. Reply in the chat instead.", "not_pending");
  if (d.kind === "approve") {
    // The chat shows as answering while it runs, so nothing else starts in it meanwhile.
    await setThreadStatus(r.thread.id, "running");
    await execute(r, taken);
  } else r.emit("action", serializeAction(taken));
  const settled = await appendResults(r.thread.id, action.messageId);
  if (!settled) {
    await setThreadStatus(r.thread.id, "waiting");
    r.emit("done", { status: "waiting" });
    return "waiting" as const;
  }
  // "Answer in chat instead": stay quiet until the user writes.
  if (d.kind === "skip") {
    await setThreadStatus(r.thread.id, "idle");
    r.emit("done", { status: "idle" });
    return "idle" as const;
  }
  return respond(r);
}

// ---------- Follow-up suggestions ----------

const followUpSchema = z.object({ follow_ups: z.array(z.string()) });

async function suggestFollowUps(r: RunCtx, answer: MessageRow) {
  try {
    const [lastUser] = await db
      .select()
      .from(MSG)
      .where(and(eq(MSG.threadId, r.thread.id), eq(MSG.role, "user"), eq(MSG.hidden, false)))
      .orderBy(desc(MSG.createdAt))
      .limit(1);
    const asked = ((lastUser?.display ?? {}) as { text?: string }).text ?? "";
    const said = ((answer.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("\n").slice(0, 4_000);
    if (!said.trim()) return;
    const out = await structured({
      workspaceId: r.wsId,
      feature: "copilot_follow_ups",
      effort: "low",
      maxTokens: 1_000,
      system: "You suggest what a user of a cold email platform might ask their assistant next. Write up to three short requests (under 12 words each) in the user's voice, each a natural next step from the exchange. No numbering.",
      messages: [{ role: "user", content: `<user_asked>${asked.slice(0, 2_000)}</user_asked>\n<assistant_answered>${said}</assistant_answered>` }],
      schema: followUpSchema,
    });
    const follow = out.follow_ups.map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (!follow.length) return;
    await db.update(MSG).set({ display: { ...((answer.display ?? {}) as Record<string, unknown>), suggestions: follow } }).where(eq(MSG.id, answer.id));
    r.emit("suggestions", { message_id: answer.id, items: follow });
  } catch {
    // Suggestions are optional.
  }
}
