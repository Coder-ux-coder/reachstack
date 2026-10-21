#!/usr/bin/env node
// Starts Reachstack the way someone who just downloaded it does, and checks that it works. The launcher (start.sh, or
// Start Reachstack.cmd on Windows) installs what's missing, builds the web app and starts the server; then this makes
// the owner account and a key, connects test mailboxes through the AI tools, launches a campaign and waits for its
// emails to go out and a reply to come back, runs the command-line tools and `npm run api-key`, and stops it all.
//
//   node tools/dev/first-start.mjs                 run it in a fresh copy (GitHub runs it on Linux, macOS and Windows)
//   node tools/dev/first-start.mjs --port 4600     the port to start on (default 4600)
//
// It uses a new, empty data folder (never ./data), and made-up .test addresses with test mailboxes: nothing is sent.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 4600);
const BASE = `http://localhost:${PORT}`;
const isWindows = process.platform === "win32";
const dataDir = mkdtempSync(path.join(os.tmpdir(), "reachstack-first-start-"));
const env = { ...process.env, DATA_DIR: dataDir };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

let failures = 0;
const pass = (what) => console.log(`  ✓ ${what}`);
/** Records a failed check and carries on. */
function check(ok, what, detail) {
  if (ok) pass(what);
  else {
    failures++;
    console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`);
  }
  return ok;
}
/** A check the rest depends on: stops the run when it fails. */
function must(ok, what, detail) {
  if (!check(ok, what, detail)) throw new Error(`stopped: ${what}`);
}
const short = (v) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).slice(0, 400);

// ---------- HTTP, with the session cookie a browser would keep ----------

let cookie = "";
async function http(method, url, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "x-rs-csrf": "1", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    if (pair.startsWith("rs_sid=")) cookie = pair;
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, json };
}

async function healthy() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3_000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

// ---------- The MCP tools, as an AI app calls them ----------

let key = "";
let rpcId = 0;
async function mcp(method, params) {
  const res = await http("POST", "/mcp", {
    body: { jsonrpc: "2.0", id: ++rpcId, method, params },
    headers: { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream", cookie: "", "mcp-protocol-version": "2025-06-18" },
  });
  if (!res.json || res.json.jsonrpc !== "2.0") throw new Error(`/mcp answered ${res.status}: ${short(res.text)}`);
  if (res.json.error) throw new Error(`${method}: ${res.json.error.message}`);
  return res.json.result;
}
/** Runs a tool; returns its answer (parsed when it's JSON) and whether it was an error. */
async function tool(name, args = {}) {
  const result = await mcp("tools/call", { name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text
  }
  return { error: !!result.isError, data, text };
}

/** Polls until `test` returns something truthy, or gives up after `ms`. */
async function waitFor(ms, test) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(3_000);
  }
}

// ---------- Start and stop the launcher ----------

let launcher = null;
function startLauncher() {
  const opts = { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] };
  if (isWindows) {
    // Start Reachstack.cmd, as a double-click runs it (cmd needs the quotes kept as they are).
    const cmd = path.join(ROOT, "Start Reachstack.cmd");
    return spawn("cmd.exe", ["/d", "/s", "/c", `""${cmd}" --no-open --port ${PORT}"`], { ...opts, windowsVerbatimArguments: true });
  }
  // Its own process group, so stopping it reaches the server it starts too.
  return spawn("sh", [path.join(ROOT, "start.sh"), "--no-open", "--port", String(PORT)], { ...opts, detached: true });
}

async function stopLauncher() {
  if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null) return;
  const exited = new Promise((resolve) => launcher.once("exit", resolve));
  if (isWindows) spawnSync("taskkill", ["/pid", String(launcher.pid), "/t", "/f"], { stdio: "ignore" });
  else {
    try {
      process.kill(-launcher.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([exited, sleep(20_000)]);
  if (!isWindows && launcher.exitCode === null && launcher.signalCode === null) {
    try {
      process.kill(-launcher.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// ---------- The checks ----------

async function run() {
  console.log(`\nFirst start check: ${ROOT}\nNode ${process.versions.node} on ${process.platform}, port ${PORT}, data in ${dataDir}\n`);
  must(!(await healthy()), `nothing answers on port ${PORT} yet`, "something already runs there: stop it or pass --port");

  launcher = startLauncher();
  // The first start installs packages and builds the web app, which takes a few minutes.
  const up = await waitFor(25 * 60_000, async () => (launcher.exitCode !== null ? "stopped" : (await healthy()) ? "up" : null));
  must(up === "up", `the launcher installed, built and started it (${elapsed()})`, up === "stopped" ? `the launcher stopped with exit code ${launcher.exitCode}` : "no answer after 25 minutes");

  // A fresh install: the first visitor makes the owner account.
  let config = await http("GET", "/api/public/config");
  must(config.status === 200 && config.json?.first_run === true, "a fresh install asks for its owner (first_run)", short(config.text));
  check(config.json?.signup_mode === "invite", "after the owner, sign-up is by invitation", config.json?.signup_mode);

  // The web app, served by the server.
  const page = await http("GET", "/");
  must(page.status === 200 && page.type.includes("text/html") && page.text.includes('id="root"'), "the web app's page loads", `${page.status} ${page.type}`);
  const script = /<script[^>]+src="([^"]+\.js)"/.exec(page.text)?.[1];
  const asset = script ? await http("GET", script) : null;
  check(asset?.status === 200 && /javascript/.test(asset.type), "its script loads", script ?? "no script tag");
  for (const route of ["/signup", "/login", "/developers"]) {
    const r = await http("GET", route);
    check(r.status === 200 && r.text.includes('id="root"'), `${route} opens the app`, String(r.status));
  }

  // The owner account (a made-up address and a random password, on this computer only).
  const signup = await http("POST", "/api/app/auth/signup", {
    body: { email: "owner@first-start.test", password: randomBytes(18).toString("base64url"), first_name: "Avery", last_name: "Tester", workspace_name: "First start", timezone: "UTC" },
  });
  must(signup.status === 200 && !!cookie, "the owner account is made and signed in", `${signup.status} ${short(signup.text)}`);
  const me = await http("GET", "/api/app/auth/me");
  check(me.json?.workspace?.name === "First start", "it has its workspace", short(me.json?.workspace));
  config = await http("GET", "/api/public/config");
  check(config.json?.first_run === false, "the install has its owner now");
  const stranger = await fetch(`${BASE}/api/app/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rs-csrf": "1" },
    body: JSON.stringify({ email: "stranger@first-start.test", password: randomBytes(18).toString("base64url") }),
  });
  check(stranger.status === 403, "a stranger can't sign up without an invitation", String(stranger.status));

  // A key for an AI assistant, made the way the AI assistants tab makes one.
  const made = await http("POST", "/api/v2/api-keys", { body: { name: "AI assistant", scopes: ["all:all"] } });
  must(made.status === 200 && /^rs_/.test(made.json?.key ?? ""), "an API key is made", `${made.status} ${short(made.text)}`);
  key = made.json.key;

  // The MCP server.
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "first-start", version: "1" } });
  check(!!init.protocolVersion && !!init.serverInfo?.name, `MCP: initialize (${init.serverInfo?.name} ${init.serverInfo?.version})`);
  const { tools } = await mcp("tools/list", {});
  check(tools.length >= 30, `MCP: ${tools.length} tools`);
  const anon = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check(anon.status === 401, "MCP: no key, no tools", String(anon.status));

  // A campaign from start to finish, through the tools.
  const boxes = await tool("create_test_mailboxes", { count: 2, domain: "first-start-team.test" });
  must(!boxes.error && boxes.data.created?.length === 2, "test mailboxes are connected", short(boxes.text));
  const campaign = await tool("create_campaign", {
    name: "First start",
    steps: [
      { subject: "Quick question, {{firstName | there}}", body: "Hi {{firstName | there}},\n\nThis is the first start check.\n\nNot the right time? Just reply 'stop'.\n\n{{sendingAccountFirstName}}" },
      { body: "Following up on this, {{firstName}}.", wait_days: 2 },
    ],
    use_all_mailboxes: true,
    schedule: { days: ["everyday"], from: "00:00", to: "23:59", timezone: "UTC" },
  });
  must(!campaign.error && !!campaign.data.id, "a campaign is made", short(campaign.text));
  const campaignId = campaign.data.id;
  const leads = await tool("add_leads", {
    campaign_id: campaignId,
    leads: [
      { email: "interested.casey@prospect-first.test", first_name: "Casey", company_name: "Prospect First" },
      { email: "sam@prospect-first.test", first_name: "Sam", company_name: "Prospect First" },
    ],
  });
  check(!leads.error, "leads are added", short(leads.text));
  const checked = await tool("check_campaign", { campaign_id: campaignId });
  check(!checked.error, "the launch check runs", short(checked.text));
  const preview = await tool("preview_email", { campaign_id: campaignId });
  check(!preview.error && /Casey|Sam/.test(preview.text), "an email previews with the lead's name", short(preview.text));
  const launched = await tool("launch_campaign", { campaign_id: campaignId });
  must(!launched.error, "the campaign launches", short(launched.text));

  const sent = await waitFor(5 * 60_000, async () => {
    const a = await tool("campaign_analytics", { campaign_id: campaignId });
    return !a.error && a.data[0]?.emails_sent >= 2 ? a.data[0] : null;
  });
  if (!sent) console.log(`    status: ${short((await tool("campaign_status", { campaign_id: campaignId })).text)}`);
  check(!!sent, `both first emails went out (${elapsed()})`);
  const replies = await waitFor(3 * 60_000, async () => {
    const r = await tool("list_replies", { campaign_id: campaignId });
    const items = r.data?.replies ?? r.data?.items ?? r.data;
    return !r.error && Array.isArray(items) && items.length ? items : null;
  });
  check(!!replies, `the interested lead's reply arrived in the inbox (${elapsed()})`);

  // The command line and the stdio bridge, the way an assistant with a terminal uses them.
  const bridge = spawnSync(process.execPath, [path.join(ROOT, "tools", "mcp.mjs"), "call", "get_overview"], {
    cwd: ROOT,
    env: { ...env, REACHSTACK_URL: BASE, REACHSTACK_API_KEY: key },
    encoding: "utf8",
    timeout: 60_000,
  });
  let overview = null;
  try {
    overview = JSON.parse(bridge.stdout);
  } catch {
    // reported below
  }
  check(bridge.status === 0 && !!overview, "node tools/mcp.mjs call get_overview", short(bridge.stderr || bridge.stdout));
  const stdio = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "mcp.mjs")], { cwd: ROOT, env: { ...env, REACHSTACK_URL: BASE, REACHSTACK_API_KEY: key }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "first-start", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    setTimeout(() => child.stdin.end(), 5_000);
  });
  const answers = stdio.out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check(stdio.code === 0 && answers.length === 2 && answers.find((a) => a.id === 2)?.result?.tools?.length >= 30, "the stdio MCP server answers and exits cleanly", `exit ${stdio.code}, ${answers.length} answers`);

  // npm run api-key, as AGENTS.md has an assistant do.
  const npmKey = spawnSync("npm run api-key -- --read-only --name \"First start check\"", { cwd: ROOT, env, encoding: "utf8", shell: true, timeout: 120_000 });
  check(npmKey.status === 0 && /\brs_[A-Za-z0-9_-]{20,}/.test(npmKey.stdout), "npm run api-key makes a key", short(npmKey.stderr || npmKey.stdout));

  // The engine kept running, and nothing crashed.
  check(await healthy(), "still healthy at the end");
}

let crashed = null;
try {
  await run();
} catch (err) {
  crashed = err;
  console.log(`\n  ${err.message}`);
} finally {
  await stopLauncher();
  // The server finishes what the engine is doing before it closes.
  check(!!(await waitFor(30_000, async () => !(await healthy()))), "stopping the launcher stops the server");
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1_000 });
  } catch {
    // a temporary folder; the system clears it
  }
}
console.log(failures || crashed ? `\nFirst start check failed (${failures} failed, ${elapsed()}).\n` : `\nFirst start check passed (${elapsed()}).\n`);
process.exitCode = failures || crashed ? 1 : 0;
