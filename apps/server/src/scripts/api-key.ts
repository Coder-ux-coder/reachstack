// Makes an API key from the machine Reachstack runs on, so an AI assistant (or any program) can work in a workspace
// without anyone signing in to the web app first. The key belongs to the workspace's owner, like one made in Settings.
//
//   npm run api-key                                    a full-access key for the installation owner's workspace
//   npm run api-key -- --workspace "Acme Outreach"     for another workspace (its name or id)
//   npm run api-key -- --read-only                     one that can look at everything and change nothing
//   npm run api-key -- --name "Claude"                 its name in Settings → Integrations & API (default "AI assistant")
//   npm run api-key -- --save                          also keeps it in the data folder, where node tools/mcp.mjs finds it
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { AuditActivity } from "@reachstack/shared";
import { db, initDb, schema } from "../db/client";
import { config } from "../env";
import { defaultWorkspaceId } from "../http/auth";
import { randomToken, sha256 } from "../lib/ids";
import { audit } from "../services/audit";
import { getOwnerId } from "../services/instance";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    name: { type: "string" },
    "read-only": { type: "boolean" },
    save: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

await initDb();
const W = schema.workspaces;

/** Where people open this installation: where the launcher started it, else the configured address. */
function address(): string {
  try {
    const state = JSON.parse(readFileSync(path.join(config.dataDir, "local-server.json"), "utf8")) as { url?: string };
    if (state.url) return state.url;
  } catch {
    // not started with the launcher, or not running
  }
  return config.appUrl;
}

async function chooseWorkspace() {
  const asked = values.workspace?.trim();
  if (asked) {
    const all = await db.select().from(W).where(isNull(W.deletedAt));
    const byId = all.find((w) => w.id === asked);
    const byName = all.filter((w) => w.name.toLowerCase() === asked.toLowerCase());
    if (byId) return byId;
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) fail(`More than one workspace is called "${asked}". Use its id: ${byName.map((w) => w.id).join(", ")}`);
    fail(`No workspace is called "${asked}". There are: ${all.map((w) => `${w.name} (${w.id})`).join(", ") || "none yet"}.`);
  }
  const ownerId = await getOwnerId();
  const [owner] = ownerId ? await db.select().from(schema.users).where(and(eq(schema.users.id, ownerId), isNull(schema.users.deletedAt))).limit(1) : [];
  if (!owner) fail(`Nobody has an account yet. Open ${address()} and create the owner account first, then run this again.`);
  const wsId = await defaultWorkspaceId(owner);
  const [ws] = wsId ? await db.select().from(W).where(eq(W.id, wsId)).limit(1) : [];
  if (!ws) fail("The owner has no workspace. Make one in the web app, or name one with --workspace.");
  return ws;
}

const ws = await chooseWorkspace();
const readOnly = !!values["read-only"];
const name = values.name?.trim().slice(0, 100) || "AI assistant";
const raw = `rs_${randomToken(30)}`;
await db.insert(schema.apiKeys).values({ workspaceId: ws.id, name, keyHash: sha256(raw), keyPrefix: raw.slice(0, 10), scopes: [readOnly ? "all:read" : "all:all"], createdBy: ws.ownerId });
await audit({ workspaceId: ws.id, activityType: AuditActivity.API_KEY_CREATED, userId: ws.ownerId, metadata: { name, from: "npm run api-key" } });

const mcpUrl = `${address().replace(/\/$/, "")}/mcp`;
const lines = [
  `Made the API key "${name}" for the workspace ${ws.name} (${readOnly ? "read only" : "full access"}):`,
  "",
  `  ${raw}`,
  "",
  "Keep it private: it can do anything in this workspace that the key allows. Delete it any time in",
  "Settings → Integrations & API → API keys.",
];
if (values.save) {
  const file = path.join(config.dataDir, "agent-api-key");
  writeFileSync(file, `${raw}\n`, { mode: 0o600 });
  lines.push("", `Saved in ${file}: node tools/mcp.mjs uses it from there.`);
}
lines.push(
  "",
  "Connect an AI assistant (docs/agents.md has the details):",
  `  Claude Code:   claude mcp add --transport http reachstack ${mcpUrl} --header "Authorization: Bearer ${raw}"`,
  `  Other apps:    the MCP address ${mcpUrl}, with the header Authorization: Bearer <the key>`,
  `  A terminal:    node tools/mcp.mjs tools${values.save ? "" : "   (with REACHSTACK_API_KEY set to the key, or make it with --save)"}`,
);
console.log(`\n${lines.map((l) => (l ? `  ${l}` : "")).join("\n")}\n`);
process.exit(0);
