#!/usr/bin/env node
// Reachstack's AI tools for apps that start their tools as programs (Claude Desktop, Codex, Gemini CLI and others): an
// MCP server on standard input and output that hands every message to a running Reachstack. Also a command line for
// the same tools, for an assistant that only has a terminal. It needs nothing but Node.js.
//
//   node tools/mcp.mjs                                   the MCP server (what an AI app starts)
//   node tools/mcp.mjs tools                             the tools, and what each one takes
//   node tools/mcp.mjs call get_overview                 runs a tool and prints its answer
//   node tools/mcp.mjs call get_campaign campaign_id=…   arguments as name=value
//   node tools/mcp.mjs call create_campaign --file c.json   or as JSON: a file, - for standard input, or '{…}'
//
// Which Reachstack and which key: REACHSTACK_URL (default: where it was started on this computer, else
// http://localhost:4000) and REACHSTACK_API_KEY (default: the key `npm run api-key -- --save` kept in the data folder).
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDotEnv() {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}
const dotenv = readDotEnv();
const setting = (name) => process.env[name] || dotenv[name] || "";
const dataDir = path.resolve(ROOT, setting("DATA_DIR") || "./data");
const BRAND = setting("BRAND_NAME") || "Reachstack";

function readText(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function serverUrl() {
  if (process.env.REACHSTACK_URL) return process.env.REACHSTACK_URL.trim().replace(/\/+$/, "");
  try {
    const state = JSON.parse(readText(path.join(dataDir, "local-server.json")));
    if (state.url) return String(state.url).replace(/\/+$/, "");
  } catch {
    // not started with the launcher, or not running
  }
  return (setting("APP_URL") || `http://localhost:${setting("PORT") || 4000}`).replace(/\/+$/, "");
}

const URL_ = serverUrl();
const KEY = (process.env.REACHSTACK_API_KEY || readText(path.join(dataDir, "agent-api-key"))).trim();
const NO_KEY = `No API key: set REACHSTACK_API_KEY, or run npm run api-key -- --save in ${BRAND}'s folder (or make one in Settings → Integrations & API → AI assistants).`;

let protocolVersion = null;

/** Sends one message (or batch) to the MCP endpoint; null when it was only notifications. */
async function post(message) {
  let res;
  try {
    res = await fetch(`${URL_}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${KEY}`,
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
    });
  } catch {
    throw new Error(`${BRAND} isn't answering at ${URL_}. Start it (Start Reachstack.cmd, sh start.sh or npm run local), or set REACHSTACK_URL to where it runs.`);
  }
  if (res.status === 202) return null;
  const text = await res.text();
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    // keeps answer undefined
  }
  const rpc = (a) => a && typeof a === "object" && a.jsonrpc === "2.0";
  if (!(Array.isArray(answer) ? answer.every(rpc) : rpc(answer))) {
    throw new Error(`${URL_}/mcp didn't answer as ${BRAND}'s MCP server would (${res.status}). Check REACHSTACK_URL, and that ${BRAND} is up to date.`);
  }
  return answer;
}

// ---------- The MCP server on standard input and output ----------

function serve() {
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  async function handle(msg) {
    const id = !Array.isArray(msg) && msg && typeof msg === "object" ? msg.id : undefined;
    try {
      if (!KEY) throw new Error(NO_KEY);
      const answer = await post(msg);
      if (answer?.result?.protocolVersion && msg.method === "initialize") protocolVersion = answer.result.protocolVersion;
      // A refusal of the whole request (no key, another website) has no id: it answers this message.
      if (answer && !Array.isArray(answer) && answer.error && answer.id === null && id !== undefined) answer.id = id;
      if (answer) write(answer);
    } catch (err) {
      if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
      else process.stderr.write(`${err.message}\n`);
    }
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Answers go back as they're ready, matched by id. When the app closes standard input, the process ends by itself
    // once they're all out (ending it at once while fetch closes its connections crashes Node on Windows).
    handle(msg);
  });
  process.stderr.write(`${BRAND} MCP tools: passing messages to ${URL_}/mcp${KEY ? "" : ` (${NO_KEY})`}\n`);
}

// ---------- The command line ----------

/** Stops the command with a message (it ends with exit code 1). */
function fail(message) {
  throw new Error(message);
}

async function rpc(method, params) {
  if (!KEY) fail(NO_KEY);
  const answer = await post({ jsonrpc: "2.0", id: 1, method, params });
  if (answer?.error) fail(answer.error.message);
  return answer.result;
}

const typeOf = (schema) => schema?.type ?? schema?.anyOf?.find((s) => s.type !== "null")?.type;

/** name=value pairs, read the way the tool's input says (text stays text); or JSON. */
function readArguments(rest, tool) {
  if (!rest.length) return {};
  if (rest[0] === "--file" || rest[0] === "-") {
    const file = rest[0] === "-" ? "-" : rest[1];
    if (!file) fail("--file needs a file name.");
    try {
      return JSON.parse(readFileSync(file === "-" ? 0 : path.resolve(file), "utf8"));
    } catch (err) {
      fail(`Couldn't read the arguments: ${err.message}`);
    }
  }
  if (rest.length === 1 && rest[0].trim().startsWith("{")) {
    try {
      return JSON.parse(rest[0]);
    } catch (err) {
      fail(`That isn't JSON: ${err.message}`);
    }
  }
  const props = tool.inputSchema?.properties ?? {};
  const out = {};
  for (const pair of rest) {
    const i = pair.indexOf("=");
    if (i <= 0) fail(`"${pair}" isn't name=value.`);
    const name = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    if (!props[name]) fail(`${tool.name} takes no "${name}". It takes: ${Object.keys(props).join(", ") || "nothing"}.`);
    const type = typeOf(props[name]);
    if (type === "string") out[name] = raw;
    else {
      try {
        out[name] = JSON.parse(raw);
      } catch {
        out[name] = type === "array" ? raw.split(",").map((s) => s.trim()) : raw;
      }
    }
  }
  return out;
}

async function cli(command, rest) {
  if (command === "tools") {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const required = new Set(t.inputSchema?.required ?? []);
      console.log(`${t.name}${props.length ? ` ${props.map((p) => (required.has(p) ? p : `[${p}]`)).join(" ")}` : ""}\n  ${t.description}\n`);
    }
    return;
  }
  if (command === "call") {
    const name = rest[0];
    if (!name) fail("Which tool? node tools/mcp.mjs tools lists them.");
    const { tools } = await rpc("tools/list", {});
    const tool = tools.find((t) => t.name === name);
    if (!tool) fail(`There's no tool called ${name}. node tools/mcp.mjs tools lists them.`);
    const result = await rpc("tools/call", { name, arguments: readArguments(rest.slice(1), tool) });
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    if (result.isError) fail(text);
    console.log(text);
    return;
  }
  fail(`Usage:
  node tools/mcp.mjs                        the MCP server, for AI apps
  node tools/mcp.mjs tools                  lists the tools
  node tools/mcp.mjs call <tool> [name=value …]   runs one (or --file args.json, - for standard input, '{…}')`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command) serve();
else {
  try {
    await cli(command, rest);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
