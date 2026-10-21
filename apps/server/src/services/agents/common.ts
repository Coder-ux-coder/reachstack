// Shared pieces of the AI agents: the stored agent shape, guidance turned into prompt text, the business
// context every agent writes from, and event logging.
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { EmailType, LeadStatus } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { notFound } from "../../http/errors";
import { iso } from "../../lib/time";

export const AgentType = {
  INBOX_MANAGER: 1,
  SALES: 2,
  DELIVERABILITY: 3,
  AFFILIATE: 4,
  LEAD_FINDER: 6,
  RECRUITING: 7,
  INVESTMENT: 8,
  USER_RESEARCH: 9,
  PARTNERSHIP: 10,
  VOICE: 11,
} as const;

export const AgentStatus = { ERROR: -1, PAUSED: 0, ACTIVE: 1 } as const;

export const GuidanceCategory = { BASICS: 0, GENERAL: 1, OBJECTIONS: 2, SCHEDULING: 3, KNOWLEDGE: 4 } as const;

export type AgentRow = typeof schema.aiAgents.$inferSelect;
export type GuidanceRow = typeof schema.aiAgentGuidance.$inferSelect;

export async function findAgent(workspaceId: string, id: string, type: number): Promise<AgentRow> {
  const A = schema.aiAgents;
  const [row] = await db.select().from(A).where(and(eq(A.id, id), eq(A.workspaceId, workspaceId), eq(A.type, type))).limit(1);
  if (!row) throw notFound("AI agent");
  return row;
}

export function serializeAgent(a: AgentRow, extra: Record<string, unknown> = {}) {
  return {
    id: a.id,
    organization_id: a.workspaceId,
    name: a.name,
    payload: a.payload,
    type: a.type,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt),
    status: a.status,
    is_auto_created: a.isAutoCreated ?? false,
    created_by: a.createdBy,
    description: a.description,
    ...extra,
  };
}

/** Shape returned by the delete endpoints. */
export function serializeAgentSummary(a: { id: string; type: number | null; name: string; status: number; createdAt: Date; updatedAt: Date; configurationMode?: string | null }) {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    status: a.status,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt),
    configuration_mode: a.configurationMode ?? null,
  };
}

export function serializeGuidance(g: GuidanceRow) {
  return {
    id: g.id,
    organization_id: g.workspaceId,
    agent_id: g.agentId,
    label: g.label,
    instruction: g.instruction,
    status: g.status,
    category: g.category,
    basic_guidance_options: g.basicGuidanceOptions ?? undefined,
    timestamp_created: iso(g.createdAt),
    timestamp_updated: iso(g.updatedAt),
  };
}

const TONES: Record<string, string> = {
  friendly: "warm and friendly",
  neutral: "neutral and even",
  matter_of_fact: "direct and matter-of-fact",
  professional: "polished and professional",
  humorous: "light, with a touch of humor where it fits",
};
const LENGTHS: Record<string, string> = { concise: "2-3 short sentences", standard: "one short paragraph", thorough: "two or three short paragraphs" };

/** The agent's active guidance as prompt text, grouped by category. */
export async function guidanceText(agentId: string): Promise<{ text: string; tone: string; length: string }> {
  const G = schema.aiAgentGuidance;
  const rows = await db.select().from(G).where(eq(G.agentId, agentId)).orderBy(asc(G.createdAt));
  const basics = rows.find((g) => g.category === GuidanceCategory.BASICS)?.basicGuidanceOptions;
  const tone = TONES[basics?.tone ?? "professional"] ?? TONES.professional!;
  const length = LENGTHS[basics?.length ?? "concise"] ?? LENGTHS.concise!;
  const sections: Array<[number, string]> = [
    [GuidanceCategory.GENERAL, "General instructions"],
    [GuidanceCategory.OBJECTIONS, "Handling objections"],
    [GuidanceCategory.SCHEDULING, "Scheduling meetings"],
    [GuidanceCategory.KNOWLEDGE, "Knowledge base"],
  ];
  const parts: string[] = [];
  for (const [cat, title] of sections) {
    const items = rows.filter((g) => g.category === cat && g.status === 1 && g.instruction.trim());
    if (items.length) parts.push(`## ${title}\n${items.map((g) => `- ${g.label ? `${g.label}: ` : ""}${g.instruction.trim()}`).join("\n")}`);
  }
  return { text: parts.join("\n\n"), tone, length };
}

/** What the workspace sells, from the copilot memory (business details, ICP, offer, proof, tone). */
export async function businessContext(workspaceId: string): Promise<string> {
  const rows = await db.select().from(schema.copilotMemory).where(eq(schema.copilotMemory.workspaceId, workspaceId));
  if (!rows.length) return "";
  const order = ["business_details", "offer", "icp", "case_studies", "tone"];
  rows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  return rows
    .map((r) => {
      const body = Object.entries(r.data ?? {})
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
      return body ? `## ${r.key.replace(/^custom:/, "").replace(/_/g, " ")}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
}

/** Why an answer that hasn't gone out would now be wrong to send. */
export type DiscardReason = "lead_replied_again" | "answered_by_person" | "lead_unsubscribed";

/**
 * Whether the conversation an unsent answer was written for has moved on: the lead unsubscribed, wrote again after
 * the message it answers, or someone answered (or scheduled an answer) by hand. `ownEmailId` is the answer itself
 * once it's on its way. Null while the answer still fits.
 */
export async function conversationMovedOn(workspaceId: string, inReplyToEmailId: string | null, opts: { leadId?: string | null; ownEmailId?: string | null } = {}): Promise<DiscardReason | null> {
  const E = schema.emails;
  if (opts.leadId) {
    const [lead] = await db.select({ status: schema.leads.status }).from(schema.leads).where(eq(schema.leads.id, opts.leadId)).limit(1);
    if (lead?.status === LeadStatus.UNSUBSCRIBED) return "lead_unsubscribed";
  }
  const [original] = inReplyToEmailId ? await db.select().from(E).where(eq(E.id, inReplyToEmailId)).limit(1) : [];
  if (!original) return null;
  const newer = await db
    .select({ id: E.id, ueType: E.ueType })
    .from(E)
    .where(
      and(
        eq(E.workspaceId, workspaceId),
        original.threadId ? eq(E.threadId, original.threadId) : eq(E.id, original.id),
        ne(E.id, original.id),
        gt(E.timestampEmail, original.timestampEmail),
        inArray(E.ueType, [EmailType.RECEIVED, EmailType.SENT, EmailType.SCHEDULED]),
        // An automatic reply or a bounce notice isn't the lead writing again.
        eq(E.isAutoReply, 0),
        eq(E.isBounce, false),
      ),
    )
    .limit(20);
  if (newer.some((e) => e.ueType === EmailType.RECEIVED)) return "lead_replied_again";
  if (newer.some((e) => e.id !== opts.ownEmailId)) return "answered_by_person";
  return null;
}

export async function logAgentEvent(workspaceId: string, agentId: string, eventType: string, payload: Record<string, unknown> = {}) {
  await db.insert(schema.aiAgentEvents).values({ workspaceId, agentId, eventType, payload });
}

/** Strips anything but basic formatting from model-written HTML before it is emailed. */
export function cleanReplyHtml(html: string): string {
  const allowed = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a", "div", "span"]);
  return html
    .replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      const n = name.toLowerCase();
      if (!allowed.has(n)) return "";
      if (tag.startsWith("</")) return `</${n}>`;
      if (n === "a") {
        const href = /href\s*=\s*"(https?:\/\/[^"]+|mailto:[^"]+)"/i.exec(attrs)?.[1];
        return href ? `<a href="${href}">` : "<a>";
      }
      return `<${n}>`;
    })
    .trim();
}

/**
 * Web addresses in escaped text as links. What ends a sentence after one isn't part of it: a full stop, comma, quote
 * or a closing bracket that has no opening one in the address ("(see https://x.test/a)" links https://x.test/a).
 */
export function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (raw) => {
    let url = raw;
    let tail = "";
    for (;;) {
      const entity = /&(gt|quot|#39);$/.exec(url);
      if (entity) {
        tail = entity[0] + tail;
        url = url.slice(0, -entity[0].length);
        continue;
      }
      const last = url.at(-1) ?? "";
      const opens = (o: string) => url.split(o).length - 1;
      if (/[.,;:!?'"*]/.test(last) || (last === ")" && opens("(") < opens(")")) || (last === "]" && opens("[") < opens("]"))) {
        tail = last + tail;
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    return url.length > "https://".length ? `<a href="${url}">${url}</a>${tail}` : raw;
  });
}

/** Plain text (as models often answer) to simple paragraphs. */
export function textToParagraphs(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${linkify(esc(p).replace(/\n/g, "<br>"))}</p>`)
    .join("");
}
