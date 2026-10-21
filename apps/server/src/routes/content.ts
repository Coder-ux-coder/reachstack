// Writing tools around the sequence editor: saved templates (emails and reply snippets) with a built-in
// library, the AI writers (sequence, spintax, rewrite, spam words) and campaign diagnosis.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as z4 from "zod/v4";
import { canWrite, escapeHtml, htmlToText, roleAllows, validateBraces, type Permission } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest, forbidden } from "../http/errors";
import { body, query, zBool } from "../http/util";
import { iso } from "../lib/time";
import { findSpamPhrases, heuristicSpamScore } from "../lib/spam-score";
import { aiAvailable, aiErrorMessage, cachedSystem, complete, structured, toHttpError } from "../services/ai";
import { actorOf } from "../services/audit";
import { effectivePermissions } from "../services/branding";
import { trashTemplate } from "../services/recently-deleted";
import { findCampaign, sendingStatus } from "./campaigns";

const T = schema.emailTemplates;

type TemplateRow = typeof T.$inferSelect;

function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject ?? "",
    body: t.body,
    category: t.category,
    is_reply_template: t.isReplyTemplate,
    created_by: t.createdBy,
    timestamp_created: iso(t.createdAt),
    timestamp_updated: iso(t.updatedAt),
  };
}

/** Email templates need campaign editing rights; reply snippets only need the unibox. */
function assertTemplateWrite(req: FastifyRequest, isReply: boolean) {
  const a = req.auth;
  if (!a.role) throw forbidden();
  const perm = isReply ? "unibox" : "edit_campaigns";
  if (!roleAllows(a.role, perm, effectivePermissions(a.workspace, a.member))) throw forbidden();
  if (!isReply && !canWrite(a.role)) throw forbidden();
}

/** Plain text with blank-line paragraphs → editor HTML (variables and spintax pass through untouched). */
function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * An email for the AI to edit as text, with what text can't hold kept as markers: links as [label](address) and images
 * as [image 1], [image 2]…, so they come back as they were (see {@link withMarkup}).
 */
function editable(html: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = htmlToText(html, {
    markdownLinks: true,
    image: (tag) => {
      images.push(tag);
      return ` [image ${images.length}] `;
    },
  });
  return { text, images };
}

/** Text from the AI as paragraphs, with the links and images its markers stand for. */
function withMarkup(text: string, images: string[]): string {
  return paragraphs(text)
    .replace(/\[([^\]\n]{0,500})\]\(((?:https?:\/\/|mailto:|tel:)[^\s()<>]+)\)/g, (_m, label: string, href: string) => `<a href="${href}">${label || href}</a>`)
    .replace(/\[image (\d{1,3})\]/g, (m, n: string) => images[Number(n) - 1] ?? m);
}

/** What the AI is told about the markers. */
const MARKERS = "Links are written [text](address) and images [image 1], [image 2]…: keep every one exactly as written, where it is, and never inside a spin.";

// ---------- Built-in template library (original copy) ----------

interface LibraryTemplate {
  id: string;
  category: string;
  name: string;
  subject: string;
  body: string;
}

const lib = (id: string, category: string, name: string, subject: string, text: string): LibraryTemplate => ({ id: `lib_${id}`, category, name, subject, body: paragraphs(text) });

const LIBRARY: LibraryTemplate[] = [
  lib(
    "intro_problem",
    "First touch",
    "Problem first",
    "{{companyName}} and {{RANDOM | slow follow-ups | missed replies | manual reporting}}",
    `{{RANDOM | Hi | Hey}} {{firstName | there}},

Most {{jobTitle | teams}} I talk to lose a few deals a month simply because follow-ups slip through the cracks.

We help companies like {{companyName}} put that on autopilot, so every lead gets a timely, personal reply.

Worth a quick look?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "intro_observation",
    "First touch",
    "Observation opener",
    "Quick thought on {{companyName}}",
    `Hi {{firstName | there}},

{{personalization | I was looking at your website and had an idea worth sharing.}}

We recently helped a team in a similar spot cut their response time in half without hiring. Happy to send over how they did it.

Would that be useful?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "intro_short",
    "First touch",
    "Three-line ask",
    "{{firstName}}, quick question",
    `{{firstName | Hi}},

Who looks after outbound at {{companyName}}?

I'd like to share an idea that could free up a few hours a week for that person.

Thanks,
{{sendingAccountFirstName}}`,
  ),
  lib(
    "follow_bump",
    "Follow-ups",
    "Gentle bump",
    "",
    `{{RANDOM | Hi | Hey}} {{firstName | there}}, just floating this back to the top of your inbox.

Is improving this on your radar this quarter, or should I check back later in the year?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "follow_value",
    "Follow-ups",
    "Add value",
    "",
    `Hi {{firstName | there}},

Thought this might help either way: the three changes that made the biggest difference for teams like yours were shorter first emails, fewer links, and one clear question at the end.

If you'd like, I can review your current outreach and send back notes. No strings attached.

{{sendingAccountFirstName}}`,
  ),
  lib(
    "follow_case",
    "Follow-ups",
    "Case study",
    "",
    `Hi {{firstName | there}},

One of our customers was in a very similar position to {{companyName}}. Within six weeks they doubled their booked meetings while sending fewer emails.

Want me to send the short write-up?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "breakup",
    "Follow-ups",
    "Polite close",
    "",
    `Hi {{firstName | there}},

I haven't heard back, so I'll assume the timing isn't right and stop reaching out.

If things change, just reply to this email and I'll pick it up from here.

All the best,
{{sendingAccountFirstName}}`,
  ),
  lib(
    "meeting",
    "Meetings",
    "Meeting request",
    "15 minutes next week?",
    `Hi {{firstName | there}},

Would you be open to a 15-minute call next week? I'll show you exactly how we'd approach this for {{companyName}}, and you can decide if it's worth pursuing.

Does {{RANDOM | Tuesday | Wednesday | Thursday}} work?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "referral",
    "Meetings",
    "Right person?",
    "Right person at {{companyName}}?",
    `Hi {{firstName | there}},

I'm trying to reach whoever handles new customer acquisition at {{companyName}}. Is that you, or could you point me to the right person?

Thanks in advance,
{{sendingAccountFirstName}}`,
  ),
  lib(
    "event",
    "Events",
    "Event invite",
    "Invite: small roundtable for {{jobTitle | leaders}}",
    `Hi {{firstName | there}},

We're hosting a small online roundtable for {{jobTitle | leaders}} next month. It's 45 minutes, no slides, just practical notes from people doing the work.

Would you like a seat? I'll send the details.

{{sendingAccountFirstName}}`,
  ),
  lib(
    "reengage",
    "Re-engagement",
    "Picking back up",
    "Picking this back up",
    `Hi {{firstName | there}},

We spoke a while ago and the timing wasn't right. A lot has changed on our side since then, including a few things you asked about.

Worth reconnecting for 15 minutes?

{{sendingAccountFirstName}}`,
  ),
  lib(
    "recruit",
    "Recruiting",
    "Candidate outreach",
    "{{firstName}}, an opening you might like",
    `Hi {{firstName | there}},

Your background stood out to me. We're hiring for a role that looks like a natural next step for you, with a team that ships quickly and works remotely.

Open to a short chat this week?

{{sendingAccountFirstName}}`,
  ),
];

// ---------- AI prompts ----------

const WRITING_RULES = `Rules for every email you write:
- Plain, natural language. Short sentences. No hype, no clichés, no exclamation marks, no emojis.
- Under 120 words per email unless asked otherwise. One clear question or call to action at the end.
- Use merge variables exactly in this form when they help: {{firstName}}, {{lastName}}, {{companyName}}, {{jobTitle}}, {{website}}, {{personalization}}, {{sendingAccountFirstName}}. You may give a fallback: {{firstName | there}}.
- Never invent facts, results, customer names or numbers that were not provided.
- Separate paragraphs with a blank line. Do not use HTML or Markdown.
- Sign off with {{sendingAccountFirstName}} on its own line.`;

const sequenceOutput = z4.object({
  steps: z4
    .array(
      z4.object({
        subject: z4.string().describe("Subject line. Empty string for follow-ups that should stay in the same thread."),
        body: z4.string().describe("Email body as plain text with blank lines between paragraphs."),
        wait_days: z4.number().describe("Days to wait after the previous step before sending this one. 0 for the first step."),
      }),
    )
    .describe("The emails in order."),
});

const spamOutput = z4.object({
  findings: z4.array(
    z4.object({
      phrase: z4.string().describe("The exact phrase as it appears in the text (copy it verbatim)."),
      where: z4.enum(["subject", "body"]),
      reason: z4.string().describe("Why it may trigger spam filters, in one short sentence."),
      replacement: z4.string().describe("A natural alternative that keeps the meaning."),
    }),
  ),
});

export default async function contentRoutes(app: FastifyInstance) {
  // ---------- Templates ----------

  app.get("/api/app/templates", async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ search: z.string().optional(), category: z.string().optional(), type: z.enum(["email", "reply", "all"]).optional() }));
    const conds: SQL[] = [eq(T.workspaceId, c.wsId)];
    // Email templates belong with campaigns and reply templates with the Unibox: members see the kinds they work with.
    const a = req.auth;
    const perms = effectivePermissions(a.workspace, a.member);
    const may = (p: Permission) => !!a.role && roleAllows(a.role, p, perms);
    const seesEmail = may("view_campaigns") || may("edit_campaigns");
    const seesReply = may("unibox");
    if (!seesEmail && !seesReply) throw forbidden();
    if (q.type === "email" || !seesReply) conds.push(eq(T.isReplyTemplate, false));
    if (q.type === "reply" || !seesEmail) conds.push(eq(T.isReplyTemplate, true));
    if (q.category) conds.push(eq(T.category, q.category));
    if (q.search) {
      const s = q.search.trim().toLowerCase();
      conds.push(or(contains(sql`lower(${T.name})`, s), contains(sql`lower(coalesce(${T.subject}, ''))`, s), contains(sql`lower(${T.body})`, s))!);
    }
    const rows = await db.select().from(T).where(and(...conds)).orderBy(desc(T.updatedAt));
    const cats = await db
      .selectDistinct({ category: T.category })
      .from(T)
      .where(and(eq(T.workspaceId, c.wsId), sql`${T.category} is not null and ${T.category} != ''`))
      .orderBy(asc(T.category));
    return { items: rows.map(serializeTemplate), categories: cats.map((r) => r.category!) };
  });

  app.get("/api/app/templates/library", async () => ({
    categories: [...new Set(LIBRARY.map((t) => t.category))],
    items: LIBRARY.map((t) => ({ ...t, is_library: true })),
  }));

  const templateInput = z.object({
    name: z.string().trim().min(1).max(200),
    subject: z.string().max(2000).default(""),
    body: z.string().max(200_000),
    category: z.string().trim().max(80).nullable().optional(),
    is_reply_template: z.boolean().default(false),
  });

  app.post("/api/app/templates", async (req) => {
    const c = ctx(req);
    const b = body(req, templateInput);
    assertTemplateWrite(req, b.is_reply_template);
    const braces = validateBraces(`${b.subject}\n${b.body}`);
    if (braces) throw badRequest(braces);
    const [row] = await db
      .insert(T)
      .values({ workspaceId: c.wsId, name: b.name, subject: b.subject, body: b.body, category: b.category || null, isReplyTemplate: b.is_reply_template, createdBy: c.userId })
      .returning();
    return serializeTemplate(row!);
  });

  const findTemplate = async (wsId: string, id: string) => {
    const [row] = await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, wsId))).limit(1);
    return assertFound(row, "Template");
  };

  app.patch("/api/app/templates/:id", async (req) => {
    const c = ctx(req);
    const current = await findTemplate(c.wsId, (req.params as { id: string }).id);
    const b = body(req, templateInput.partial());
    // Both kinds count: turning an email template into a reply template still changes an email template.
    assertTemplateWrite(req, current.isReplyTemplate);
    if (b.is_reply_template !== undefined && b.is_reply_template !== current.isReplyTemplate) assertTemplateWrite(req, b.is_reply_template);
    const braces = validateBraces(`${b.subject ?? current.subject ?? ""}\n${b.body ?? current.body}`);
    if (braces) throw badRequest(braces);
    const [row] = await db
      .update(T)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.subject !== undefined ? { subject: b.subject } : {}),
        ...(b.body !== undefined ? { body: b.body } : {}),
        ...(b.category !== undefined ? { category: b.category || null } : {}),
        ...(b.is_reply_template !== undefined ? { isReplyTemplate: b.is_reply_template } : {}),
      })
      .where(eq(T.id, current.id))
      .returning();
    return serializeTemplate(row!);
  });

  app.post("/api/app/templates/:id/duplicate", async (req) => {
    const c = ctx(req);
    const src = await findTemplate(c.wsId, (req.params as { id: string }).id);
    assertTemplateWrite(req, src.isReplyTemplate);
    const [row] = await db
      .insert(T)
      .values({ workspaceId: c.wsId, name: `${src.name} (copy)`, subject: src.subject, body: src.body, category: src.category, isReplyTemplate: src.isReplyTemplate, createdBy: c.userId })
      .returning();
    return serializeTemplate(row!);
  });

  app.delete("/api/app/templates/:id", async (req) => {
    const c = ctx(req);
    const row = await findTemplate(c.wsId, (req.params as { id: string }).id);
    assertTemplateWrite(req, row.isReplyTemplate);
    // It waits in Recently deleted for 30 days.
    return { ok: true, recently_deleted_id: await trashTemplate(row, actorOf(req)) };
  });

  // ---------- AI sequence writer ----------

  const A = schema.sequenceAvatars;
  const avatarFields = z.object({
    company_name: z.string().trim().max(200).default(""),
    offer: z.string().trim().max(4000).default(""),
    audience: z.string().trim().max(4000).default(""),
    case_studies: z.string().trim().max(4000).default(""),
    cta: z.string().trim().max(500).default(""),
    tone: z.string().trim().max(100).default(""),
    language: z.string().trim().max(50).default(""),
  });

  app.get("/api/app/ai/avatars", { config: { perm: "edit_campaigns" } }, async (req) => {
    const rows = await db.select().from(A).where(eq(A.workspaceId, ctx(req).wsId)).orderBy(desc(A.createdAt));
    return { items: rows.map((r) => ({ id: r.id, name: r.name, data: r.data, timestamp_created: iso(r.createdAt) })) };
  });

  app.post("/api/app/ai/avatars", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(120), data: avatarFields }));
    const [row] = await db.insert(A).values({ workspaceId: c.wsId, name: b.name, data: b.data, createdBy: c.userId }).returning();
    return { id: row!.id, name: row!.name, data: row!.data, timestamp_created: iso(row!.createdAt) };
  });

  app.delete("/api/app/ai/avatars/:id", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const [row] = await db
      .delete(A)
      .where(and(eq(A.id, (req.params as { id: string }).id), eq(A.workspaceId, c.wsId)))
      .returning();
    assertFound(row, "Avatar");
    return { ok: true };
  });

  app.post("/api/app/ai/sequence", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, avatarFields.extend({ steps: z.number().int().min(1).max(7).default(3) }));
    if (!b.offer && !b.audience) throw badRequest("Describe your offer and who it's for");
    const brief = [
      b.company_name && `Company: ${b.company_name}`,
      b.offer && `Offer: ${b.offer}`,
      b.audience && `Target audience: ${b.audience}`,
      b.case_studies && `Proof the writer may use (only this): ${b.case_studies}`,
      b.cta && `Call to action: ${b.cta}`,
      b.tone && `Tone: ${b.tone}`,
      b.language && `Write in: ${b.language}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const out = await structured({
        workspaceId: c.wsId,
        feature: "sequence_writer",
        effort: "medium",
        maxTokens: 8_000,
        system: cachedSystem(`You write cold email sequences for B2B outreach.\n\n${WRITING_RULES}\n- The first email needs a subject line. Follow-ups usually leave the subject empty so they thread under the first email.\n- Each follow-up adds something new (a different angle, a short proof point, or an easy out); never just "checking in".`),
        messages: [{ role: "user", content: `Write a ${b.steps}-step sequence.\n\n<brief>\n${brief}\n</brief>` }],
        schema: sequenceOutput,
      });
      return {
        steps: out.steps.slice(0, b.steps).map((s, i) => ({
          subject: s.subject.trim(),
          body: paragraphs(s.body),
          delay: i === 0 ? 0 : Math.max(1, Math.round(s.wait_days || 2)),
        })),
      };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  // ---------- Spintax, rewrite, spam words ----------

  app.post("/api/app/ai/spintax", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ subject: z.string().max(2000).default(""), body: z.string().max(100_000) }));
    const { text, images } = editable(b.body);
    if (!text.trim()) throw badRequest("Write the email first");
    try {
      const out = await structured({
        workspaceId: c.wsId,
        feature: "spintax_writer",
        effort: "low",
        maxTokens: 6_000,
        system: cachedSystem(
          `You add spintax to cold emails so each recipient gets slightly different wording.\nSyntax: {{RANDOM | option one | option two | option three}}.\n- Vary greetings, transitions, verbs and sign-offs; keep the meaning, tone and length identical.\n- Every option must read naturally in context. 2-3 options per spin, 3-8 spins per email.\n- Keep existing merge variables like {{firstName}} or {{companyName | your team}} exactly as they are and never put them inside a spin.\n- Keep paragraphs separated by blank lines. No HTML or Markdown.\n- ${MARKERS}`,
        ),
        messages: [{ role: "user", content: `<subject>${b.subject}</subject>\n<body>\n${text}\n</body>` }],
        schema: z4.object({ subject: z4.string(), body: z4.string() }),
      });
      const subject = b.subject ? out.subject.trim() : "";
      const bodyHtml = withMarkup(out.body, images);
      const problem = validateBraces(`${subject}\n${bodyHtml}`);
      if (problem) throw badRequest(`The AI produced invalid spintax (${problem}). Try again.`);
      return { subject, body: bodyHtml };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  app.post("/api/app/ai/write", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        instruction: z.string().trim().min(1).max(2000),
        subject: z.string().max(2000).default(""),
        body: z.string().max(100_000).default(""),
        with_subject: z.boolean().default(false),
      }),
    );
    const { text: written, images } = editable(b.body);
    const current = written.trim();
    try {
      const out = await structured({
        workspaceId: c.wsId,
        feature: "email_writer",
        effort: "low",
        maxTokens: 4_000,
        system: cachedSystem(`You write and edit cold emails.\n\n${WRITING_RULES}\n\nWhen editing: ${MARKERS}`),
        messages: [
          {
            role: "user",
            content: current
              ? `Edit this email. Instruction: ${b.instruction}\n\n<subject>${b.subject}</subject>\n<body>\n${current}\n</body>`
              : `Write an email. Brief: ${b.instruction}`,
          },
        ],
        schema: z4.object({ subject: z4.string().describe("Subject line (empty if not needed)"), body: z4.string() }),
      });
      return { subject: b.with_subject || !current ? out.subject.trim() : b.subject, body: withMarkup(out.body, images) };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  /** Spam words: AI findings with replacements when AI is available, the built-in phrase list otherwise. */
  app.post("/api/app/ai/spam-words", { config: { perm: "view_campaigns" } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ subject: z.string().max(2000).default(""), body: z.string().max(200_000).default(""), use_ai: zBool }));
    const heuristic = heuristicSpamScore(b.subject, b.body);
    const listHits = findSpamPhrases(b.subject, b.body).map((phrase) => ({
      phrase,
      where: b.subject.toLowerCase().includes(phrase) ? ("subject" as const) : ("body" as const),
      reason: "Common spam-filter trigger phrase",
      replacement: "",
    }));
    if (b.use_ai === false || !(await aiAvailable(c.wsId))) return { method: "rules", findings: listHits, score: heuristic };
    try {
      const out = await structured({
        workspaceId: c.wsId,
        feature: "spam_words",
        effort: "low",
        maxTokens: 3_000,
        system: cachedSystem(
          "You review cold emails for wording that commonly triggers spam filters or feels pushy (hype, pressure, money claims, 'free', 'guarantee', excessive urgency). Only flag phrases that are really present. Return an empty list when the email is clean. Ignore merge variables like {{firstName}} and spintax syntax.",
        ),
        messages: [{ role: "user", content: `<subject>${b.subject}</subject>\n<body>\n${htmlToText(b.body)}\n</body>` }],
        schema: spamOutput,
      });
      const lower = `${b.subject}\n${htmlToText(b.body)}`.toLowerCase();
      const findings = out.findings.filter((f) => f.phrase.trim() && lower.includes(f.phrase.toLowerCase()));
      for (const hit of listHits) if (!findings.some((f) => f.phrase.toLowerCase() === hit.phrase)) findings.push(hit);
      return { method: "ai", findings, score: heuristic };
    } catch (err) {
      return { method: "rules", findings: listHits, score: heuristic, ai_error: aiErrorMessage(err) };
    }
  });

  // ---------- Campaign diagnosis ----------

  app.post("/api/app/campaigns/:id/diagnose", { config: { perm: "view_campaigns" } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const status = await sendingStatus(row);
    const base = { campaign_id: row.id, checked_at: new Date().toISOString(), ...status };
    const fallback = status.summary.is_sending
      ? "The campaign is sending normally."
      : status.summary.reasons.length
        ? `Not sending because: ${status.summary.reasons.join(" ")}`
        : "No problems were found.";
    if (!(await aiAvailable(c.wsId))) return { ...base, ai_summary: null, rule_summary: fallback };
    try {
      const r = await complete({
        workspaceId: c.wsId,
        feature: "campaign_diagnosis",
        effort: "low",
        maxTokens: 1_500,
        system: cachedSystem(
          "You explain cold email campaign sending diagnostics to a busy user. Use only the JSON you are given. Write 2-4 short sentences in plain language: whether it is sending, the main reason if not, and the single most useful next step. No headings, no lists, no Markdown.",
        ),
        messages: [{ role: "user", content: `<campaign name="${escapeHtml(row.name)}">\n${JSON.stringify(status)}\n</campaign>` }],
      });
      return { ...base, ai_summary: r.text, rule_summary: fallback };
    } catch (err) {
      return { ...base, ai_summary: null, rule_summary: fallback, ai_error: aiErrorMessage(err) };
    }
  });
}
