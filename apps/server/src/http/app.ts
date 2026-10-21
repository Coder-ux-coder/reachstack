import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyError, type FastifyHttpOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { isDuplicate } from "../db/client";
import { config } from "../env";
import { registerRoutes } from "../routes";
import { mcpOriginAllowed } from "../routes/mcp";
import { domainForwardingHook } from "../services/domains";
import { authHook, SESSION_COOKIE } from "./auth";
import { HttpError } from "./errors";
import { toHttpError } from "../services/ai";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Hashes of the inline scripts in the built app shell (the theme script), so the policy allows exactly those. */
function inlineScriptHashes(file: string): string[] {
  try {
    const html = readFileSync(file, "utf8");
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  } catch {
    return [];
  }
}

/** Content policy for the web app: its own scripts only, images from anywhere (logos, email images), no framing. */
function appShellPolicy(): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(path.join(config.webDist, "index.html")).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A database refusal of a duplicate: SQLite's unique or primary key constraint, as libsql or Drizzle wrap it. */
export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" },
    trustProxy: config.trustProxy as FastifyHttpOptions<never>["trustProxy"],
    bodyLimit: 30 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  await app.register(cookie);
  // The web app is same-origin. Only the public API (bearer keys, no cookies) answers other sites, and the MCP server
  // answers pages on this computer (an MCP inspector).
  await app.register(cors, {
    hook: "preHandler",
    delegator: (req, cb) => {
      const url = req.url ?? "";
      const open = url.startsWith("/api/v2/") || ((url === "/mcp" || url.startsWith("/mcp?")) && !!req.headers.origin && mcpOriginAllowed(req.headers.origin));
      cb(null, { origin: open, credentials: false, methods: "GET,HEAD,POST,PUT,PATCH,DELETE" });
    },
  });
  await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 10 } });

  app.decorateRequest("auth", null as never);

  // CSRF: cookie-authenticated state changes must come from our own SPA (custom header forces a CORS preflight cross-site).
  app.addHook("onRequest", async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (!req.url.startsWith("/api/")) return;
    // A Bearer key never falls back to the session cookie, so only those requests can skip the check.
    if (/^bearer\s+/i.test(req.headers.authorization ?? "")) return;
    if (!req.cookies?.[SESSION_COOKIE]) return;
    if (req.headers["x-rs-csrf"] !== "1") throw new HttpError(403, "Missing CSRF header", "csrf");
  });
  // Security headers on every answer; pages also refuse to be framed by other sites.
  const httpsOnly = config.appUrl.startsWith("https://");
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    if (httpsOnly) reply.header("strict-transport-security", "max-age=15552000");
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
      reply.header("x-frame-options", "DENY");
      if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    }
    return payload;
  });
  // Forwarded sending domains pointed at this server send their visitors to the main website.
  app.addHook("onRequest", domainForwardingHook);
  app.addHook("preHandler", authHook);

  app.setErrorHandler((raw: FastifyError | HttpError, req, reply) => {
    // AI failures surface as 502/429 with a readable message rather than a bare 500; a unique index refusing a
    // duplicate (two requests at once, or a name that's taken) as 409.
    const err = (isDuplicate(raw) ? new HttpError(409, "That already exists (it may have just been added). Refresh and try again.", "conflict") : toHttpError(raw)) as FastifyError | HttpError;
    const status = (err as HttpError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err, url: req.url }, "request failed");
    const isValidation = (err as FastifyError).validation !== undefined;
    reply.status(isValidation ? 400 : status).send({
      statusCode: isValidation ? 400 : status,
      error: status >= 500 ? "Internal Server Error" : (err as HttpError).code ?? err.name ?? "Error",
      message: status >= 500 && config.isProduction ? "Something went wrong" : err.message,
      ...((err as HttpError).code ? { code: (err as HttpError).code } : {}),
      ...((err as HttpError).details && status < 500 ? { details: (err as HttpError).details } : {}),
    });
  });

  await registerRoutes(app);

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false });
    const shellPolicy = appShellPolicy();
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", message: `Route ${req.method} ${req.url.split("?")[0]} not found` });
      }
      return reply.header("content-security-policy", shellPolicy).type("text/html").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", message: `Route ${req.method} ${req.url.split("?")[0]} not found` });
      }
      return reply
        .type("text/html")
        .send(`<p>The web app has not been built yet. Run <code>npm run build</code> or use the dev server on port 5173.</p>`);
    });
  }

  return app;
}
