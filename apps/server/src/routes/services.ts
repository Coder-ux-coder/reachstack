// Settings → Installation → Services: the keys and service settings the installation owner can set here instead of in
// the server's .env file. Owner only: every route checks before reading its input, so other people get a 403 whatever
// they send, and API keys can't reach them (no API scope). Saved secrets are never sent back.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../env";
import { ctx, type User } from "../http/context";
import { rateLimit } from "../http/rate-limit";
import { body } from "../http/util";
import { aiConfigured, aiErrorMessage, complete } from "../services/ai";
import { requireOwner } from "../services/instance";
import { checkSpamd, checkSystemSmtp, serviceSettingsView, updateServiceSettings, type CheckResult } from "../services/service-settings";
import { sendSystemMail, systemMailLayout } from "../services/system-mail";

async function owner(req: FastifyRequest): Promise<User> {
  const me = ctx(req).user;
  await requireOwner(me);
  return me;
}

/** A one-word question to the server's AI, as the workspaces without their own key would ask it. */
async function checkAi(): Promise<CheckResult> {
  if (!aiConfigured()) return { ok: false, message: config.aiProvider === "openai" ? "Add the AI server's address and model first." : "Add an Anthropic API key first." };
  const started = Date.now();
  try {
    const r = await complete({
      workspaceId: null,
      feature: "services_test",
      effort: "low",
      // Room for a reasoning model's thinking before its one-word answer.
      maxTokens: 1_000,
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    if (!r.text) return { ok: false, message: `${r.message.model} answered without any text. Try a larger model.` };
    return { ok: true, message: `${r.message.model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s.` };
  } catch (err) {
    return { ok: false, message: aiErrorMessage(err) };
  }
}

/** Signing in proves the password; a real email also proves the From address is accepted. */
async function sendTestEmail(me: User): Promise<CheckResult> {
  if (!config.systemSmtp.host) return { ok: false, message: "Add the SMTP server first." };
  const m = systemMailLayout("Your system email works", [`This test came from ${config.brandName}. Sign-up confirmations, password links and alerts are sent the same way.`]);
  try {
    await sendSystemMail({ to: me.email, subject: `Test email from ${config.brandName}`, ...m });
    return { ok: true, message: `Sent to ${me.email}. Check that it arrived, and not in spam.` };
  } catch (err) {
    return { ok: false, message: `${config.systemSmtp.host} didn't take it: ${(err as Error).message}` };
  }
}

export default async function serviceRoutes(app: FastifyInstance) {
  const user = { config: { auth: "user" as const } };

  app.get("/api/app/admin/services", user, async (req) => {
    await owner(req);
    return serviceSettingsView();
  });

  // { values: { "anthropic.api_key": "…", "smtp.port": 587, "smtp.user": null } }: null or "" goes back to the environment.
  app.patch("/api/app/admin/services", user, async (req) => {
    const me = await owner(req);
    const b = body(req, z.object({ values: z.record(z.string(), z.unknown()) }).strict());
    return updateServiceSettings(b.values, me.id);
  });

  // The page's Test buttons. They reach out to the servers set above, so they're limited per owner.
  app.post("/api/app/admin/services/test", user, async (req) => {
    const me = await owner(req);
    const b = body(req, z.object({ service: z.enum(["ai", "smtp", "smtp_send", "spamd"]) }));
    rateLimit(`services-test:${me.id}`, 30, 10 * 60_000, "That's a lot of tests. Try again in a few minutes.");
    if (b.service === "ai") return checkAi();
    if (b.service === "smtp") return checkSystemSmtp();
    if (b.service === "smtp_send") return sendTestEmail(me);
    return checkSpamd();
  });
}
