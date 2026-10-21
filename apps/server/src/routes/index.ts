import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { config } from "../env";
import { brandForHost, productBrand } from "../services/branding";
import auth from "./auth";
import workspaces from "./workspaces";
import accounts from "./accounts";
import oauth from "./oauth";
import leads from "./leads";
import tracking from "./tracking";
import campaigns from "./campaigns";
import subsequences from "./subsequences";
import emails from "./emails";
import webhooks from "./webhooks";
import deliverability from "./deliverability";
import platform from "./platform";
import dfy from "./dfy";
import ai from "./ai";
import leadFinder from "./lead-finder";
import integrations from "./integrations";
import agentsInbox from "./agents-inbox";
import agentsLeadFinder from "./agents-lead-finder";
import agentsDeliverability from "./agents-deliverability";
import agentsSales from "./agents-sales";
import agents from "./agents";
import dashboard from "./dashboard";
import content from "./content";
import blocklist from "./blocklist";
import billing from "./billing";
import crm from "./crm";
import copilot from "./copilot";
import websiteVisitors from "./website-visitors";
import automations from "./automations";
import privacy from "./privacy";
import admin from "./admin";
import backups from "./backups";
import recentlyDeleted from "./recently-deleted";
import sequenceVersions from "./sequence-versions";
import services from "./services";
import notifications from "./notifications";
import replies from "./replies";
import today from "./today";
import mcp from "./mcp";
import { getInstallationSettings, hasAccounts } from "../services/installation";
import { BOOT_ID } from "../services/restart";
import { healthProof } from "../services/tracking-domains";
import { apiEndpoints, collectApiReference } from "../http/api-reference";

export async function registerRoutes(app: FastifyInstance) {
  collectApiReference(app);
  app.get("/api/health", { config: { auth: "public" } }, async (req) => {
    // A tracking domain's check asks with a challenge: the proof shows the answer came from this installation.
    const challenge = (req.query as { challenge?: unknown }).challenge;
    const proof = typeof challenge === "string" && /^[\w-]{16,64}$/.test(challenge) ? healthProof(challenge) : undefined;
    return { ok: true, brand: config.brandName, boot: BOOT_ID, ...(proof ? { proof } : {}) };
  });
  // What the sign-in and marketing pages need before anyone is logged in.
  // On an agency's portal domain the agency's brand replaces ours, and sign-in is email and password only.
  app.get("/api/public/config", { config: { auth: "public" } }, async (req) => {
    const portal = await brandForHost(req.hostname);
    return {
      brand: portal ?? productBrand(),
      portal: !!portal,
      sign_in: { google: !portal && !!config.google.clientId, microsoft: !portal && !!config.microsoft.clientId },
      billing: { stripe: !!config.stripe.secretKey },
      email_delivery: !!config.systemSmtp.host,
      /** Who may create an account (the sign-up page explains when it's limited). */
      signup_mode: (await getInstallationSettings()).signup_mode,
      /** Nobody has an account yet: the first one can always be made, and it runs the installation. */
      first_run: !(await hasAccounts()),
      privacy: {
        email: config.privacy.email || null,
        phone: config.privacy.phone || null,
        policy_url: config.privacy.policyUrl || null,
        terms_url: config.privacy.termsUrl || null,
      },
    };
  });
  // The API reference on /developers, read from the routes themselves.
  app.get("/api/public/api-reference", { config: { auth: "public" } }, async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return { base_path: "/api/v2", endpoints: apiEndpoints() };
  });
  // Lets phones add the app to the home screen and open it full screen, under the brand people signed up with.
  app.get("/api/public/manifest.webmanifest", { config: { auth: "public" } }, async (req, reply) => {
    const brand = (await brandForHost(req.hostname)) ?? productBrand();
    reply.header("content-type", "application/manifest+json").header("cache-control", "public, max-age=3600");
    return {
      name: brand.name,
      short_name: brand.name,
      start_url: "/app/unibox",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: brand.color ?? "#4f46e5",
      icons: [{ src: brand.logo_url ?? "/favicon.svg", sizes: "any", purpose: "any" }],
    };
  });
  // The QR code on /mobile-app: opens the inbox on a phone.
  app.get("/api/public/mobile-qr.svg", { config: { auth: "public" } }, async (req, reply) => {
    const portal = await brandForHost(req.hostname);
    const svg = await QRCode.toString(`${portal ? `https://${req.hostname}` : config.webUrl}/app/unibox`, { type: "svg", margin: 1, width: 200 });
    return reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=3600").send(svg);
  });
  await app.register(auth);
  await app.register(workspaces);
  await app.register(accounts);
  await app.register(oauth);
  await app.register(leads);
  await app.register(tracking);
  await app.register(campaigns);
  await app.register(subsequences);
  await app.register(emails);
  await app.register(webhooks);
  await app.register(deliverability);
  await app.register(platform);
  await app.register(dfy);
  await app.register(ai);
  await app.register(leadFinder);
  await app.register(integrations);
  await app.register(agentsInbox);
  await app.register(agentsLeadFinder);
  await app.register(agentsDeliverability);
  await app.register(agentsSales);
  await app.register(agents);
  await app.register(dashboard);
  await app.register(content);
  await app.register(blocklist);
  await app.register(billing);
  await app.register(crm);
  await app.register(copilot);
  await app.register(websiteVisitors);
  await app.register(automations);
  await app.register(privacy);
  await app.register(admin);
  await app.register(backups);
  await app.register(recentlyDeleted);
  await app.register(sequenceVersions);
  await app.register(services);
  await app.register(notifications);
  await app.register(replies);
  await app.register(today);
  await app.register(mcp);
}
