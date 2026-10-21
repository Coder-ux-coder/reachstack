// The MCP server: AI assistants (Claude, Cursor, Codex and others) work in a workspace through tools, over the Model
// Context Protocol's Streamable HTTP transport at /mcp. It keeps no sessions: every POST carries an API key as its
// Bearer token and gets its answers back as JSON, so nothing streams. The tools are in services/mcp-tools.ts.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { REPO_ROOT, config } from "../env";
import { resolveAuth } from "../http/auth";
import { HttpError } from "../http/errors";
import { MCP_TOOLS, ToolError, findTool, readArguments, toolListing, type ToolContext } from "../services/mcp-tools";

/** Protocol versions this server speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The stdio bridge for AI apps that start their tools as programs (Claude Desktop, Codex…). */
const BRIDGE = path.join(REPO_ROOT, "tools", "mcp.mjs");
/** Longest answer an assistant gets from one tool (about 20,000 tokens). */
const MAX_TEXT = 80_000;

const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "1.0.0");
  } catch {
    return "1.0.0";
  }
})();

function instructions(): string {
  const brand = config.brandName;
  return [
    `${brand} is a cold email platform. These tools work in one workspace, with what its API key allows.`,
    `Start with get_overview. A campaign needs email accounts to send from (connect_email_account, or create_test_mailboxes to try things without sending real email), steps (its emails), a schedule, and leads (add_leads, or search_lead_finder then import_from_lead_finder). Make it with create_campaign, add the leads, look it over with check_campaign and preview_email (or send_test_email to the person), then launch_campaign. Replies arrive in list_replies; get_conversation reads an exchange and reply_to_email answers it.`,
    `Ask the person before anything that emails real people: launch_campaign, reply_to_email, and send_test_email to anyone but them. Test mailboxes never send real email. People may rather type mailbox passwords into ${brand} themselves (Email accounts → Connect) than share them in a chat.`,
    `In emails, {{firstName}}, {{companyName}} and the lead's other fields fill in per lead, {{firstName | there}} gives a fallback, and {{RANDOM | Hi | Hello}} varies the wording.`,
    `For anything without a tool, api_reference lists every REST endpoint and api_request calls one. People use ${brand} in their browser at ${config.webUrl}.`,
  ].join("\n\n");
}

/**
 * Which web pages may call the MCP server from a browser: this installation's own, and any on this computer (an MCP
 * inspector, say). Other sites are turned away, so a page can't reach a server on localhost through a rebound name.
 */
export function mcpOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    return [config.appUrl, config.webUrl].some((own) => new URL(own).origin === u.origin);
  } catch {
    return false;
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

/** The workspace an API key (or app token) works in, or why it can't be used. */
async function bearer(req: FastifyRequest): Promise<{ workspaceId: string } | { status: number; message: string }> {
  if (!/^bearer\s+\S/i.test(req.headers.authorization ?? "")) {
    return { status: 401, message: `Send an API key as the Bearer token (Authorization: Bearer rs_…). Make one in ${config.brandName}: Settings → Integrations & API → AI assistants.` };
  }
  try {
    const a = req.auth.via === "api_key" || req.auth.via === "oauth" ? req.auth : await resolveAuth(req);
    if ((a.via === "api_key" || a.via === "oauth") && a.workspace) return { workspaceId: a.workspace.id };
  } catch (err) {
    if (err instanceof HttpError && err.statusCode < 500) return { status: err.statusCode === 403 ? 403 : 401, message: err.message };
    throw err;
  }
  return { status: 401, message: "Invalid API key" };
}

/** The API, called as the assistant: with its key, from its address. */
function forward(app: FastifyInstance, req: FastifyRequest): ToolContext["api"] {
  return async (method, url, opts = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const res = await app.inject({
      method,
      url: qs.size ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url,
      headers: {
        authorization: req.headers.authorization!,
        host: req.headers.host ?? "localhost",
        "user-agent": String(req.headers["user-agent"] ?? "MCP client"),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      remoteAddress: req.ip,
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
    let body: unknown = res.body;
    if (String(res.headers["content-type"] ?? "").includes("json") && res.body) {
      try {
        body = JSON.parse(res.body);
      } catch {
        // kept as text
      }
    }
    return { status: res.statusCode, body };
  };
}

/** What a tool answered, as the text an assistant reads; a very long one is cut, with a note saying so. */
function show(out: unknown): string {
  const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters: ask for less, with a limit or a filter)` : text;
}

async function callTool(id: unknown, params: Record<string, unknown>, ctx: ToolContext, req: FastifyRequest) {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = findTool(name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name || "(no name)"}`);
  try {
    const out = await tool.run(readArguments(tool, params.arguments), ctx);
    return rpcResult(id, { content: [{ type: "text", text: show(out) }], isError: false });
  } catch (err) {
    if (err instanceof ToolError) return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
    req.log.error({ err, tool: name }, "MCP tool failed");
    return rpcResult(id, { content: [{ type: "text", text: "Something went wrong on the server while running this tool. Try again; if it keeps failing, the server's log says why." }], isError: true });
  }
}

async function answer(raw: unknown, ctx: ToolContext, req: FastifyRequest): Promise<object | null> {
  const msg = (raw && typeof raw === "object" ? raw : {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
  // An answer to something this server asked: it never asks, so there's nothing to do.
  if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) return null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg.id, -32600, "Not a JSON-RPC 2.0 request");
  const notification = msg.id === undefined;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(msg.id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "reachstack", title: config.brandName, version: VERSION },
        instructions: instructions(),
      });
    }
    case "ping":
      return notification ? null : rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: MCP_TOOLS.map(toolListing) });
    case "tools/call":
      return callTool(msg.id, params, ctx, req);
    default:
      if (notification || msg.method.startsWith("notifications/")) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export default async function mcpRoutes(app: FastifyInstance) {
  app.post("/mcp", { config: { auth: "public" } }, async (req, reply) => {
    if (!mcpOriginAllowed(req.headers.origin)) return reply.code(403).send(rpcError(null, -32600, "Pages on other websites can't use this MCP server."));
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !MCP_VERSIONS.includes(version)) {
      return reply.code(400).send(rpcError(null, -32600, `This server speaks MCP ${MCP_VERSIONS.join(", ")}, not ${version}.`));
    }
    const auth = await bearer(req);
    if ("message" in auth) return reply.code(auth.status).header("www-authenticate", 'Bearer error="invalid_token"').send(rpcError(null, -32001, auth.message));
    const ctx: ToolContext = { workspaceId: auth.workspaceId, api: forward(app, req) };
    const batch = Array.isArray(req.body);
    const messages = batch ? (req.body as unknown[]) : [req.body];
    if (!messages.length) return reply.code(400).send(rpcError(null, -32600, "An empty batch"));
    const answers = (await Promise.all(messages.map((m) => answer(m, ctx, req)))).filter((a) => a !== null);
    // Only notifications (or answers): accepted, nothing to say back.
    if (!answers.length) return reply.code(202).send();
    return reply.header("cache-control", "no-store").send(batch ? answers : answers[0]);
  });

  // Nothing streams from this server and it keeps no sessions, so there's nothing to open or close.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      config: { auth: "public" },
      handler: async (_req, reply) =>
        reply.code(405).header("allow", "POST").send({ statusCode: 405, error: "Method Not Allowed", message: "This is an MCP server (Streamable HTTP): connect an MCP client to this address. docs/agents.md explains how." }),
    });
  }

  // OAuth discovery: MCP clients ask here before they sign in. API keys are the way in, so they learn there's nothing to
  // discover rather than reading the web app's page.
  app.get("/.well-known/*", { config: { auth: "public" } }, async (_req, reply) =>
    reply.code(404).send({ statusCode: 404, error: "Not Found", message: `${config.brandName} takes API keys (Authorization: Bearer rs_…), not OAuth.` }),
  );

  // The AI assistants tab: what Claude Desktop and other apps that start their tools as programs run, on this computer.
  app.get("/api/app/mcp", { config: { admin: true } }, async () => ({ bridge: existsSync(BRIDGE) ? BRIDGE : null, node: process.execPath }));
}
