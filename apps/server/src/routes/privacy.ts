// The public privacy center (/privacy/*): opt-out, data request and privacy request forms, the link that confirms a
// request, and abuse reports. The installation administrator works through requests, reports and the
// suppression list under /api/app/admin/privacy (Settings → Privacy center in the app).
import type { FastifyInstance } from "fastify";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isValidEmailSyntax } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest } from "../http/errors";
import { rateLimit } from "../http/rate-limit";
import { body, clientIp, query, zInt } from "../http/util";
import { requireInstanceAdmin } from "../services/instance";
import {
  REQUEST_CHOICES,
  abuseStatus,
  confirmRequest,
  createRequest,
  normLinkedin,
  optOut,
  removeFromDataset,
  reportAbuse,
  sendConfirmation,
  sendDataReport,
  serializeRequest,
  type RequestDetails,
} from "../services/privacy";

const R = schema.privacyRequests;
const S = schema.privacySuppressions;
const A = schema.abuseReports;

const mustConfirm = (message: string) => z.literal(true, { errorMap: () => ({ message }) });

const person = {
  first_name: z.string().trim().min(1, "Enter your first name").max(80),
  last_name: z.string().trim().min(1, "Enter your last name").max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => isValidEmailSyntax(v), "Enter a valid email address"),
  company_name: z.string().trim().max(120).nullish(),
  linkedin_url: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .refine((v) => !v || !!normLinkedin(v), "Enter a LinkedIn profile link, like https://www.linkedin.com/in/your-name"),
};

const meta = (req: Parameters<typeof clientIp>[0]) => ({ ip: clientIp(req).slice(0, 64), user_agent: String(req.headers["user-agent"] ?? "").slice(0, 400) });

/** Public forms: a few submissions per address per hour, and a few emails per recipient per day. */
function limitForm(req: Parameters<typeof clientIp>[0], form: string, email: string) {
  rateLimit(`privacy:${form}:ip:${clientIp(req)}`, 10, 60 * 60_000, "Too many requests from this network. Please try again in an hour.");
  rateLimit(`privacy:${form}:email:${email}`, 3, 24 * 60 * 60_000, "We already received requests for this address today. Check your inbox, or try again tomorrow.");
}

export default async function privacyRoutes(app: FastifyInstance) {
  // ---------- Public forms ----------

  app.post("/api/public/privacy/opt-out", { config: { auth: "public" } }, async (req) => {
    const b = body(
      req,
      z.object({
        ...person,
        confirm_identity: mustConfirm("Confirm that you are this person or are acting for them"),
        confirm_retention: mustConfirm("Confirm that we may keep your address to honor the opt-out"),
      }),
    );
    limitForm(req, "opt-out", b.email);
    await optOut({ email: b.email, first_name: b.first_name, last_name: b.last_name, company_name: b.company_name ?? null, linkedin_url: b.linkedin_url ?? null, ...meta(req) });
    return { ok: true };
  });

  app.post("/api/public/privacy/data-request", { config: { auth: "public" } }, async (req) => {
    const b = body(
      req,
      z.object({
        ...person,
        confirm_identity: mustConfirm("Confirm that you are this person or are acting for them"),
        confirm_verification: mustConfirm("Confirm that we may use these details to verify you and find your data"),
      }),
    );
    limitForm(req, "data-request", b.email);
    const row = await createRequest("data_request", { email: b.email, first_name: b.first_name, last_name: b.last_name, company_name: b.company_name ?? null, linkedin_url: b.linkedin_url ?? null, ...meta(req) }, "pending");
    await sendConfirmation(row);
    return { ok: true };
  });

  app.post("/api/public/privacy/requests", { config: { auth: "public" } }, async (req) => {
    const b = body(
      req,
      z
        .object({
          ...person,
          applicant_type: z.enum(["self", "agent"], { errorMap: () => ({ message: "Choose who is making the request" }) }),
          country: z.string().trim().min(1, "Choose your country").max(80),
          state: z.string().trim().max(80).nullish(),
          requests: z.array(z.enum(REQUEST_CHOICES)).min(1, "Choose at least one request").max(REQUEST_CHOICES.length),
          message: z.string().trim().max(2_000).nullish(),
          confirm: mustConfirm("Confirm that the details are accurate"),
          // Left empty by people; bots fill every field.
          website: z.string().max(200).optional(),
        })
        .refine((v) => !(v.requests.includes("correct") || v.requests.includes("other")) || !!v.message, { message: "Tell us what to correct or what you need", path: ["message"] }),
    );
    if (b.website) return { ok: true };
    limitForm(req, "requests", b.email);
    const details: RequestDetails & { email: string } = {
      email: b.email,
      first_name: b.first_name,
      last_name: b.last_name,
      company_name: b.company_name ?? null,
      linkedin_url: b.linkedin_url ?? null,
      applicant_type: b.applicant_type,
      country: b.country,
      state: b.state ?? null,
      requests: [...new Set(b.requests)],
      message: b.message ?? null,
      ...meta(req),
    };
    await sendConfirmation(await createRequest("removal", details, "pending"));
    return { ok: true };
  });

  /** The link from the confirmation email. */
  app.post("/api/public/privacy/confirm", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ token: z.string().min(10).max(200) }));
    rateLimit(`privacy:confirm:${clientIp(req)}`, 30, 15 * 60_000);
    const outcome = await confirmRequest(b.token);
    if (!outcome) throw badRequest("This link is invalid, was already used or has expired. Send the form again to get a new one.");
    return outcome;
  });

  // ---------- Abuse reports ----------

  app.post("/api/public/abuse/verify", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ id: z.string().min(1).max(200) }));
    rateLimit(`abuse:${clientIp(req)}`, 60, 15 * 60_000);
    return { status: await abuseStatus(b.id) };
  });

  app.post("/api/public/abuse/submit", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ id: z.string().min(1).max(200) }));
    rateLimit(`abuse:${clientIp(req)}`, 60, 15 * 60_000);
    const status = await reportAbuse(b.id, { ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
    if (status === "invalid") throw badRequest("We couldn't find this report ID. Use the link from the email you received.");
    return { status };
  });

  // ---------- The administrator's privacy center ----------

  const admin = { auth: "user" as const };
  const adminWrite = { auth: "user" as const, write: true };

  app.get("/api/app/admin/privacy/summary", { config: admin }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const [requests] = await db
      .select({
        pending: sql<number>`sum(case when ${R.status} = 'pending' then 1 else 0 end)`,
        verified: sql<number>`sum(case when ${R.status} = 'verified' then 1 else 0 end)`,
        total: sql<number>`count(*)`,
      })
      .from(R);
    const [abuse] = await db
      .select({ open: sql<number>`sum(case when ${A.status} = 'open' then 1 else 0 end)`, total: sql<number>`count(*)` })
      .from(A);
    const [suppressed] = await db.select({ n: sql<number>`count(*)` }).from(S);
    return {
      requests: { pending: Number(requests?.pending ?? 0), waiting: Number(requests?.verified ?? 0), total: Number(requests?.total ?? 0) },
      abuse: { open: Number(abuse?.open ?? 0), total: Number(abuse?.total ?? 0) },
      suppressions: Number(suppressed?.n ?? 0),
    };
  });

  app.get("/api/app/admin/privacy/requests", { config: admin }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(
      req,
      z.object({
        status: z.enum(["pending", "verified", "resolved", "rejected"]).optional(),
        type: z.enum(["opt_out", "data_request", "removal"]).optional(),
        search: z.string().trim().max(200).optional(),
        limit: zInt(1, 200).default(50),
        offset: zInt(0, 1_000_000).default(0),
      }),
    );
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(R.status, q.status));
    if (q.type) conds.push(eq(R.type, q.type));
    if (q.search) conds.push(or(contains(R.email, q.search.toLowerCase()), contains(sql`lower(${R.name})`, q.search.toLowerCase()))!);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(R).where(where).orderBy(desc(R.createdAt)).limit(q.limit).offset(q.offset);
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(R).where(where);
    return { items: rows.map(serializeRequest), total: Number(count?.n ?? 0) };
  });

  const findRequest = async (id: string) => assertFound((await db.select().from(R).where(eq(R.id, id)).limit(1))[0], "Request");

  app.patch("/api/app/admin/privacy/requests/:id", { config: adminWrite }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const row = await findRequest((req.params as { id: string }).id);
    const b = body(req, z.object({ status: z.enum(["verified", "resolved", "rejected"]).optional(), note: z.string().trim().max(2_000).nullish() }));
    const details = { ...(row.details ?? {}), ...(b.note !== undefined ? { note: b.note } : {}), handled_by: c.user.email };
    const [updated] = await db
      .update(R)
      .set({ details, ...(b.status ? { status: b.status, resolvedAt: b.status === "verified" ? null : new Date() } : {}) })
      .where(eq(R.id, row.id))
      .returning();
    return serializeRequest(updated!);
  });

  /** Removes the person's profiles from the shared Lead Finder data and keeps them out. */
  app.post("/api/app/admin/privacy/requests/:id/remove", { config: adminWrite }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const row = await findRequest((req.params as { id: string }).id);
    const details = (row.details ?? {}) as unknown as RequestDetails;
    const matched = await removeFromDataset({ email: row.email, linkedin: details.linkedin_url, reason: "removal", requestId: row.id });
    const [updated] = await db
      .update(R)
      .set({ details: { ...(row.details ?? {}), matched, handled_by: c.user.email } })
      .where(eq(R.id, row.id))
      .returning();
    return { removed: matched, request: serializeRequest(updated!) };
  });

  /** Emails the person what the shared Lead Finder data holds about them. */
  app.post("/api/app/admin/privacy/requests/:id/send-report", { config: adminWrite }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const row = await findRequest((req.params as { id: string }).id);
    const details = (row.details ?? {}) as unknown as RequestDetails;
    const matched = await sendDataReport(row.email, details.linkedin_url);
    const [updated] = await db
      .update(R)
      .set({ details: { ...(row.details ?? {}), matched, handled_by: c.user.email } })
      .where(eq(R.id, row.id))
      .returning();
    return { matched, request: serializeRequest(updated!) };
  });

  app.get("/api/app/admin/privacy/abuse-reports", { config: admin }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(req, z.object({ status: z.enum(["open", "reviewed"]).optional(), limit: zInt(1, 200).default(50), offset: zInt(0, 1_000_000).default(0) }));
    const where = q.status ? eq(A.status, q.status) : undefined;
    const rows = await db
      .select({ r: A, workspace: schema.workspaces.name, campaign: schema.campaigns.name })
      .from(A)
      .leftJoin(schema.workspaces, eq(schema.workspaces.id, A.workspaceId))
      .leftJoin(schema.campaigns, eq(schema.campaigns.id, A.campaignId))
      .where(where)
      .orderBy(desc(A.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(A).where(where);
    return {
      items: rows.map(({ r, workspace, campaign }) => ({
        id: r.id,
        status: r.status,
        lead_email: r.leadEmail,
        account_email: r.accountEmail,
        subject: r.subject,
        workspace_id: r.workspaceId,
        workspace_name: workspace,
        campaign_id: r.campaignId,
        campaign_name: campaign,
        note: r.note,
        reviewed_at: r.reviewedAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
      })),
      total: Number(count?.n ?? 0),
    };
  });

  app.patch("/api/app/admin/privacy/abuse-reports/:id", { config: adminWrite }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const id = (req.params as { id: string }).id;
    assertFound((await db.select({ id: A.id }).from(A).where(eq(A.id, id)).limit(1))[0], "Abuse report");
    const b = body(req, z.object({ status: z.enum(["open", "reviewed"]).optional(), note: z.string().trim().max(2_000).nullish() }));
    await db
      .update(A)
      .set({
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(b.status ? { status: b.status, reviewedAt: b.status === "reviewed" ? new Date() : null, reviewedBy: b.status === "reviewed" ? c.user.email : null } : {}),
      })
      .where(eq(A.id, id));
    return { ok: true };
  });

  app.get("/api/app/admin/privacy/suppressions", { config: admin }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(req, z.object({ search: z.string().trim().max(200).optional(), limit: zInt(1, 200).default(50), offset: zInt(0, 1_000_000).default(0) }));
    const where = q.search ? contains(S.value, q.search.toLowerCase()) : undefined;
    const rows = await db.select().from(S).where(where).orderBy(desc(S.createdAt)).limit(q.limit).offset(q.offset);
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(S).where(where);
    return {
      items: rows.map((s) => ({ id: s.id, type: s.type, value: s.value, reason: s.reason, block_sending: s.blockSending, created_at: s.createdAt.toISOString() })),
      total: Number(count?.n ?? 0),
    };
  });

  /** Lets an address back into the data (and campaigns), e.g. after a mistaken report. */
  app.delete("/api/app/admin/privacy/suppressions/:id", { config: adminWrite }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const id = (req.params as { id: string }).id;
    assertFound((await db.select({ id: S.id }).from(S).where(eq(S.id, id)).limit(1))[0], "Entry");
    await db.delete(S).where(eq(S.id, id));
    return { ok: true };
  });
}
