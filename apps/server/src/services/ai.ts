// Shared Claude access for every AI feature: reply labelling, enrichment columns, reply drafting,
// copilot and the agents. One client, one place that decides request options per model, refusal
// handling and token accounting (ai_usage). Features check aiConfigured() and degrade gracefully.
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { eq } from "drizzle-orm";
import type * as z from "zod/v4";
import { toJSONSchema } from "zod/v4";
import { htmlToText } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { badRequest, HttpError } from "../http/errors";
import { decrypt } from "../lib/crypto";
import { sha256 } from "../lib/ids";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Whether the server has an AI of its own: Claude credentials the SDK can resolve (API key, auth token or a named
 * `ant` profile), or a local OpenAI-style server (Settings → Installation → Services, or AI_PROVIDER=openai).
 */
export function aiConfigured(): boolean {
  if (config.aiProvider === "openai") return !!(config.openai.baseUrl && config.openai.model);
  return !!(config.anthropic.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

let serverClient: Anthropic | null = null;
/** The key and address the server client was made with: the owner can change them while the server runs. */
let serverClientFor = "";
const workspaceClients = new Map<string, Anthropic>();
const settingsCache = new Map<string, { key: string | null; model: string | null; at: number }>();

async function workspaceAi(workspaceId: string) {
  const hit = settingsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const entry = { key: decrypt(ws?.settings?.anthropic_api_key_enc ?? null), model: ws?.settings?.ai_model ?? null, at: Date.now() };
  settingsCache.set(workspaceId, entry);
  return entry;
}

export function invalidateWorkspaceAi(workspaceId: string) {
  settingsCache.delete(workspaceId);
}

/** The client and model for a workspace: its own key (Settings → Integrations & API) or the server's. */
export async function resolveAi(workspaceId: string | null): Promise<{ client: Anthropic; model: string; source: "workspace" | "server" }> {
  const ws = workspaceId ? await workspaceAi(workspaceId) : null;
  const model = ws?.model || config.anthropic.model;
  if (ws?.key) {
    const id = sha256(ws.key);
    let c = workspaceClients.get(id);
    if (!c) {
      c = new Anthropic({ apiKey: ws.key });
      workspaceClients.set(id, c);
    }
    return { client: c, model, source: "workspace" };
  }
  if (!aiConfigured()) throw badRequest("AI features need an Anthropic API key. Add one in Settings → Integrations & API → AI, or the installation owner can add one in Settings → Installation → Services.");
  if (config.aiProvider === "openai") {
    throw new HttpError(400, "This feature needs Claude, and this server uses a local AI model. Add an Anthropic API key in Settings → Integrations & API → AI.", "ai_needs_claude");
  }
  const made = `${config.anthropic.apiKey}\n${config.anthropic.baseUrl}`;
  if (!serverClient || made !== serverClientFor) {
    // Unset values leave the SDK to the environment (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, an auth token or profile).
    serverClient = new Anthropic({ apiKey: config.anthropic.apiKey || undefined, baseURL: config.anthropic.baseUrl || undefined });
    serverClientFor = made;
  }
  return { client: serverClient, model, source: "server" };
}

/** Whether AI can run for this workspace (its own key or the server's). */
export async function aiAvailable(workspaceId: string | null): Promise<boolean> {
  if (aiConfigured()) return true;
  return !!(workspaceId && (await workspaceAi(workspaceId)).key);
}

// Server-side refusal fallback ("default" routing) is available for these models on the Claude API.
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|fable-5|sonnet-5-5)$/;
// Older models reject output_config.effort.
const NO_EFFORT_MODELS = /^claude-(3|haiku-4|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

/** Request options that depend on the configured model. */
export function modelOptions(model: string, effort: Effort) {
  return {
    model,
    ...(NO_EFFORT_MODELS.test(model) ? {} : { output_config: { effort } }),
    ...(FALLBACK_MODELS.test(model) ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[] } : {}),
  };
}

export class AiRefusalError extends HttpError {
  constructor(public category: string | null) {
    super(422, "The AI model declined this request.", "ai_refusal", { category });
  }
}

/** Maps SDK errors to messages a workspace user can act on. */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof AiRefusalError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check the key in Settings → Integrations & API → AI or Settings → Installation → Services.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The Anthropic API key does not have access to the configured model.";
  if (err instanceof Anthropic.NotFoundError) return "The configured AI model was not found. Check ANTHROPIC_MODEL or the workspace AI model setting.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is rate limited right now. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `The AI request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `The AI service failed (${err.status ?? "network"}). Try again shortly.`;
  if (err instanceof Anthropic.AnthropicError) return "The AI answered in an unexpected format. Try again.";
  return (err as Error)?.message ?? "AI request failed";
}

/** Converts SDK errors into HTTP errors for route handlers. */
export function toHttpError(err: unknown): Error {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.RateLimitError) return new HttpError(429, aiErrorMessage(err), "ai_rate_limited");
  if (err instanceof Anthropic.AnthropicError) return new HttpError(502, aiErrorMessage(err), "ai_error");
  return err as Error;
}

export async function recordUsage(workspaceId: string | null, feature: string, model: string, usage: Anthropic.Beta.BetaUsage | null | undefined) {
  if (!workspaceId || !usage) return;
  await db
    .insert(schema.aiUsage)
    .values({
      workspaceId,
      feature,
      model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    })
    .catch(() => undefined);
}

function checkStop(msg: Anthropic.Beta.BetaMessage) {
  if (msg.stop_reason === "refusal") throw new AiRefusalError(msg.stop_details?.category ?? null);
}

export function textOf(msg: Anthropic.Beta.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** A stable system prompt block marked for caching (cheap when the same instructions repeat across calls). */
export const cachedSystem = (text: string): Anthropic.Beta.BetaTextBlockParam[] => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

interface CallOptions {
  workspaceId: string | null;
  feature: string;
  system?: string | Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  effort?: Effort;
  maxTokens?: number;
  tools?: Anthropic.Beta.BetaToolUnion[];
}

// ---------- A local AI server (Ollama, LM Studio…) through the OpenAI chat API ----------

/** Whether a call goes to the server's OpenAI-style AI: the server uses one and the workspace has no Claude key. */
export async function usesLocalAi(workspaceId: string | null): Promise<boolean> {
  if (config.aiProvider !== "openai") return false;
  return !(workspaceId && (await workspaceAi(workspaceId)).key);
}

/** The text of a message, dropping images, documents and tool blocks the local AI can't take. */
const flatten = (content: string | ReadonlyArray<{ type: string; text?: unknown }>): string =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");

/** One chat completion from the OpenAI-style server. With `schema`, it's asked for JSON matching it. */
async function localChat(o: CallOptions, schema?: Record<string, unknown>): Promise<{ text: string; model: string }> {
  if (!aiConfigured()) throw badRequest("Add the AI server's address and model in Settings → Installation → Services.");
  const system = [o.system ? flatten(o.system) : "", schema ? `Answer with one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(schema)}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const messages = [...(system ? [{ role: "system", content: system }] : []), ...o.messages.map((m) => ({ role: m.role, content: flatten(m.content) }))];
  const model = config.openai.model;
  let res: Response;
  try {
    // The owner's own setting, usually a server on this machine, so private addresses are fine here.
    res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.openai.apiKey ? { authorization: `Bearer ${config.openai.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.min(o.maxTokens ?? 4_000, 8_000),
        ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema } } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new HttpError(502, `Can't reach the AI server at ${config.openai.baseUrl}. Check that it's running. (${(err as Error).message})`, "ai_unreachable");
  }
  const raw = await res.text();
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 502, `The AI server answered ${res.status}: ${raw.slice(0, 300)}`, "ai_error");
  let data: { model?: string; choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(502, "The AI server's answer wasn't JSON. Check the address: it's usually the one ending in /v1.", "ai_error");
  }
  // Reasoning models write their thinking in <think> tags before the answer.
  const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const usage = { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 } as Anthropic.Beta.BetaUsage;
  await recordUsage(o.workspaceId, o.feature, data.model ?? model, usage);
  return { text, model: data.model ?? model };
}

type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** Claude-style history (text, tool_use and tool_result blocks) as OpenAI chat messages; thinking is dropped. */
function toChatMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    const blocks = (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) as Array<Record<string, unknown>>;
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (m.role === "assistant") {
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b): ToolCall => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results answer the assistant turn just before, so they come first.
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const content = flatten((b.content ?? "") as string | Array<{ type: string; text?: unknown }>);
      out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${content}` : content });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/** A tool call some local models write as plain JSON instead of a real call: {"name": "...", "arguments": {...}}. */
function toolCallInText(text: string, tools: ReadonlyArray<{ name: string }>): { name: string; input: unknown } | null {
  const found = jsonIn(text) as { name?: unknown; arguments?: unknown; parameters?: unknown } | null;
  if (!found || typeof found.name !== "string" || !tools.some((t) => t.name === found.name)) return null;
  const rest = text.replace(/```(?:json)?[\s\S]*?```/gi, "").replace(/\{[\s\S]*\}/, "").trim();
  if (rest.length > 40) return null;
  return { name: found.name, input: found.arguments ?? found.parameters ?? {} };
}

/**
 * One turn with tools through the OpenAI-style server (Copilot on a local AI), answered in Claude's shape: text and
 * tool_use blocks, stop_reason "tool_use" when it calls tools. Usage is left to the caller to record.
 */
export async function localToolTurn(o: {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: ReadonlyArray<{ name: string; description?: string; input_schema: unknown }>;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<Anthropic.Beta.BetaMessage> {
  if (!aiConfigured()) throw badRequest("Add the AI server's address and model in Settings → Installation → Services.");
  const model = config.openai.model;
  let res: Response;
  try {
    res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.openai.apiKey ? { authorization: `Bearer ${config.openai.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: toChatMessages(o.system, o.messages),
        tools: o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } })),
        tool_choice: "auto",
        max_tokens: Math.min(o.maxTokens, 8_000),
        stream: false,
      }),
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
  } catch (err) {
    if (o.signal?.aborted) throw err;
    throw new HttpError(502, `Can't reach the AI server at ${config.openai.baseUrl}. Check that it's running. (${(err as Error).message})`, "ai_unreachable");
  }
  const raw = await res.text();
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 502, `The AI server answered ${res.status}: ${raw.slice(0, 300)}`, "ai_error");
  type Answer = {
    model?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  let data: Answer;
  try {
    data = JSON.parse(raw) as Answer;
  } catch {
    throw new HttpError(502, "The AI server's answer wasn't JSON. Check the address: it's usually the one ending in /v1.", "ai_error");
  }
  const choice = data.choices?.[0];
  let text = (choice?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Our own ids: local servers number calls per answer ("call_0"), which would repeat across turns.
  const newId = () => `toolu_local_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const calls: Anthropic.Beta.BetaToolUseBlock[] = (choice?.message?.tool_calls ?? []).map((c) => {
    let input: unknown = c.function?.arguments ?? {};
    if (typeof input === "string") {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        input = { unreadable_arguments: input };
      }
    }
    return { type: "tool_use", id: newId(), name: c.function?.name ?? "", input } as Anthropic.Beta.BetaToolUseBlock;
  });
  if (!calls.length && text) {
    const inText = toolCallInText(text, o.tools);
    if (inText) {
      calls.push({ type: "tool_use", id: newId(), name: inText.name, input: inText.input } as Anthropic.Beta.BetaToolUseBlock);
      text = "";
    }
  }
  const content = [...(text ? [{ type: "text", text, citations: null }] : []), ...calls] as Anthropic.Beta.BetaContentBlock[];
  return {
    id: "local",
    type: "message",
    role: "assistant",
    model: data.model ?? model,
    content,
    stop_reason: calls.length ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** The JSON object in a model's answer, tolerating code fences and words around it. */
function jsonIn(text: string): unknown {
  const inner = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(inner.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** An answer shaped like Claude's, so callers that read `message` work with either AI. */
const asMessage = (text: string, model: string) =>
  ({ id: "local", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Beta.BetaMessage;

/** Plain text completion. */
export async function complete(o: CallOptions): Promise<{ text: string; message: Anthropic.Beta.BetaMessage }> {
  if (await usesLocalAi(o.workspaceId)) {
    const r = await localChat(o);
    return { text: r.text, message: asMessage(r.text, r.model) };
  }
  const { client, model } = await resolveAi(o.workspaceId);
  const msg = await client.beta.messages.create({
    ...modelOptions(model, o.effort ?? "medium"),
    max_tokens: o.maxTokens ?? 16_000,
    ...(o.system ? { system: o.system } : {}),
    ...(o.tools ? { tools: o.tools } : {}),
    messages: o.messages,
  });
  await recordUsage(o.workspaceId, o.feature, msg.model ?? model, msg.usage);
  checkStop(msg);
  return { text: textOf(msg), message: msg };
}

/** Structured JSON output validated against a zod (v4) schema. */
export async function structured<S extends z.ZodType>(o: CallOptions & { schema: S }): Promise<z.infer<S>> {
  if (await usesLocalAi(o.workspaceId)) {
    const schema = { ...(toJSONSchema(o.schema) as Record<string, unknown>) };
    delete schema.$schema;
    const r = await localChat(o, schema);
    const parsed = o.schema.safeParse(jsonIn(r.text));
    if (!parsed.success) throw new HttpError(502, "The AI's answer didn't have the expected shape. Try again, or use a larger model.", "ai_parse");
    return parsed.data as z.infer<S>;
  }
  const { client, model } = await resolveAi(o.workspaceId);
  const opts = modelOptions(model, o.effort ?? "medium");
  const msg = await client.beta.messages.parse({
    ...opts,
    output_config: { ...(opts.output_config ?? {}), format: betaZodOutputFormat(o.schema) },
    max_tokens: o.maxTokens ?? 16_000,
    ...(o.system ? { system: o.system } : {}),
    messages: o.messages,
  });
  await recordUsage(o.workspaceId, o.feature, msg.model ?? model, msg.usage);
  checkStop(msg);
  if (msg.parsed_output == null) throw new HttpError(502, "The AI response could not be read. Try again.", "ai_parse");
  return msg.parsed_output as z.infer<S>;
}

// ---------- Website text for grounding (enrichment, research) ----------

const pageCache = new Map<string, { text: string; at: number }>();

/** Readable text of a public web page (scripts/styles stripped), cached for an hour. */
export async function pageText(url: string, maxChars = 12_000): Promise<string> {
  const { safeFetch } = await import("../lib/net");
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.text;
  const res = await safeFetch(url, {
    headers: { "user-agent": `Mozilla/5.0 (compatible; ${config.brandName}Bot/1.0; +${config.appUrl})`, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 2_000_000);
  // A page can be anything: read in one pass, whatever its shape.
  const text = htmlToText(html)
    .replace(/\n\s*\n+/g, "\n")
    .slice(0, maxChars);
  pageCache.set(url, { text, at: Date.now() });
  if (pageCache.size > 500) pageCache.clear();
  return text;
}
