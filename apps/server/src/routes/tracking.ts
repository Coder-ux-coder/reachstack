// Public tracking endpoints: open pixel, click redirect and unsubscribe (page + RFC 8058 one-click).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { escapeHtml, LeadStatus } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { badRequest, notFound } from "../http/errors";
import { body, clientIp } from "../http/util";
import { handleClick, handleOpen, handleUnsubscribe, unsubscribeFromCampaign } from "../services/activity";
import { isLikelyBot, PIXEL_GIF, readEmailToken, redirectTarget, sentEmailByToken, verifyClick } from "../services/tracking";

async function emailFor(token: string) {
  const id = readEmailToken(token);
  if (!id) return null;
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id)).limit(1);
  return row ?? null;
}

function trackCtx(email: NonNullable<Awaited<ReturnType<typeof emailFor>>>, req: FastifyRequest) {
  return {
    workspaceId: email.workspaceId,
    leadId: email.leadId,
    campaignId: email.campaignId,
    subsequenceId: email.subsequenceId,
    emailId: email.id,
    accountId: email.accountId,
    accountEmail: email.eaccount,
    step: email.step != null ? Number(email.step) : null,
    variant: email.variant,
    ip: clientIp(req),
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 400),
  };
}

const page = (title: string, inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5b6170;--accent:#2f6fed;--border:#e3e6eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#eef0f4;--muted:#a3a9b6;--accent:#6b9bff;--border:#272b35}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
.card{max-width:440px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:32px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}
small{display:block;margin-top:20px;color:var(--muted);font-size:12px}</style></head><body><div class="card">${inner}</div></body></html>`;

/**
 * Mail security scanners fetch the pixel and follow links as an email arrives, often with a HEAD request or a scanner's
 * own agent: those, and anything this soon after sending, don't count as the person opening or clicking.
 */
const SCAN_WINDOW_MS = { open: 5_000, click: 30_000 } as const;

function byPerson(req: FastifyRequest, sentAt: Date, kind: keyof typeof SCAN_WINDOW_MS): boolean {
  if (req.method !== "GET" || isLikelyBot(String(req.headers["user-agent"] ?? ""), kind)) return false;
  return Date.now() - sentAt.getTime() > SCAN_WINDOW_MS[kind];
}

export default async function trackingRoutes(app: FastifyInstance) {
  app.get("/t/o/:token", { config: { auth: "public" } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.header("cache-control", "no-store, no-cache, must-revalidate, private").header("content-type", "image/gif");
    const email = await emailFor(token).catch(() => null);
    if (email && byPerson(req, email.timestampEmail, "open")) {
      handleOpen(trackCtx(email, req)).catch((err) => req.log.error(err));
    }
    return reply.send(PIXEL_GIF);
  });

  app.get("/t/c/:token", { config: { auth: "public" } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const { u, s } = req.query as { u?: string; s?: string };
    // Signed as written in the email; sent on as browsers write addresses (a header can't carry other characters).
    const target = u && /^https?:\/\//i.test(u) && verifyClick(token, u, s) ? redirectTarget(u) : null;
    if (!target) return reply.code(400).type("text/html").send(page("Invalid link", "<h1>This link is invalid</h1><p>The link may have been altered.</p>"));
    const email = await emailFor(token).catch(() => null);
    if (email && byPerson(req, email.timestampEmail, "click")) {
      handleClick({ ...trackCtx(email, req), url: u! }).catch((err) => req.log.error(err));
    }
    return reply.redirect(target, 302);
  });

  app.get("/u/:token", { config: { auth: "public" } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const email = await emailFor(token);
    reply.type("text/html");
    if (!email?.leadEmail) return page("Link expired", "<h1>Link expired</h1><p>This unsubscribe link is no longer valid.</p>");
    const address = escapeHtml(email.leadEmail);
    const [already] = await db
      .select({ id: schema.unsubscribes.id })
      .from(schema.unsubscribes)
      .where(and(eq(schema.unsubscribes.workspaceId, email.workspaceId), eq(schema.unsubscribes.email, email.leadEmail.toLowerCase())))
      .limit(1);
    if (already) {
      return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${address} will not receive further emails from this sender.</p>`);
    }
    // The narrower choice lives in the web app; this page stays a plain form so it works on any tracking domain.
    const campaignOnly = email.campaignId
      ? `<p style="margin:16px 0 0"><a href="${config.webUrl}/broadcasts/unsubscribe?token=${encodeURIComponent(token)}" style="color:var(--accent);font-size:14px">Only stop emails from this campaign</a></p>`
      : "";
    return page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1><p>Stop receiving emails at <b>${address}</b> from this sender?</p>
      <form method="post"><button type="submit">Unsubscribe</button></form>${campaignOnly}<small>Powered by ${escapeHtml(config.brandName)}</small>`,
    );
  });

  // Handles both the confirmation form and RFC 8058 one-click (List-Unsubscribe-Post).
  app.post("/u/:token", { config: { auth: "public" } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const email = await emailFor(token);
    if (!email?.leadEmail) return reply.code(404).type("text/html").send(page("Link expired", "<h1>Link expired</h1>"));
    const oneClick = typeof req.body === "string" ? req.body.includes("One-Click") : !!(req.body as Record<string, unknown> | undefined)?.["List-Unsubscribe"];
    await handleUnsubscribe({ workspaceId: email.workspaceId, email: email.leadEmail, campaignId: email.campaignId, subsequenceId: email.subsequenceId, source: oneClick ? "header" : "link", leadId: email.leadId });
    if (oneClick) return reply.code(200).send({ ok: true });
    return reply.type("text/html").send(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escapeHtml(email.leadEmail)} will not receive further emails from this sender.</p>`));
  });

  // ---------- Unsubscribe pages in the web app (/email-marketing/unsubscribe and /broadcasts/unsubscribe) ----------

  app.get("/api/public/unsubscribe/:token", { config: { auth: "public" } }, async (req) => {
    const email = await sentEmailByToken((req.params as { token: string }).token);
    if (!email?.leadEmail) throw notFound("Unsubscribe link");
    const address = email.leadEmail.toLowerCase();
    const [all] = await db
      .select({ id: schema.unsubscribes.id })
      .from(schema.unsubscribes)
      .where(and(eq(schema.unsubscribes.workspaceId, email.workspaceId), eq(schema.unsubscribes.email, address)))
      .limit(1);
    // Stopped for this campaign: its lead says so, or it's remembered (the lead was deleted since).
    const S = schema.leadSuppressions;
    const stopped =
      !!email.campaignId &&
      ((
        await db
          .select({ id: schema.leads.id })
          .from(schema.leads)
          .where(and(eq(schema.leads.workspaceId, email.workspaceId), eq(schema.leads.campaignId, email.campaignId), eq(schema.leads.email, address), eq(schema.leads.status, LeadStatus.UNSUBSCRIBED)))
          .limit(1)
      ).length > 0 ||
        (
          await db
            .select({ id: S.id })
            .from(S)
            .where(and(eq(S.workspaceId, email.workspaceId), eq(S.email, address), eq(S.reason, "unsubscribed"), eq(S.campaignId, email.campaignId)))
            .limit(1)
        ).length > 0);
    return { email: address, from: email.eaccount, has_campaign: !!email.campaignId, unsubscribed: { all: !!all, campaign: !!all || stopped } };
  });

  app.post("/api/public/unsubscribe/:token", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ scope: z.enum(["all", "campaign"]) }));
    const email = await sentEmailByToken((req.params as { token: string }).token);
    if (!email?.leadEmail) throw notFound("Unsubscribe link");
    if (b.scope === "campaign") {
      if (!email.campaignId) throw badRequest("This email wasn't part of a campaign. Unsubscribe from all emails instead.");
      await unsubscribeFromCampaign({ workspaceId: email.workspaceId, email: email.leadEmail, campaignId: email.campaignId, subsequenceId: email.subsequenceId, leadId: email.leadId });
    } else {
      await handleUnsubscribe({ workspaceId: email.workspaceId, email: email.leadEmail, campaignId: email.campaignId, subsequenceId: email.subsequenceId, source: "link", leadId: email.leadId });
    }
    return { ok: true };
  });

  // Form posts arrive as application/x-www-form-urlencoded; keep the raw body as a string.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, bodyStr, done) => done(null, bodyStr));
}
