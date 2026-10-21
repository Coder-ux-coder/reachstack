// One step to run Reachstack on this computer: it installs what's missing, builds the web app when its sources changed,
// starts the server on a free port and opens it in the browser. Close the window or press Ctrl+C to stop it.
//
//   npm run local                    (on Windows, double-clicking "Start Reachstack.cmd" does the same)
//   npm run local -- --port 4300     use this port
//   npm run local -- --no-open       don't open the browser
//   npm run local -- --lan           let other devices on your network reach it too (this computer only by default)
//   npm run local -- --shortcut      put a "Reachstack" shortcut on the desktop (Windows) and stop there
//
// Settings in .env apply as usual (PORT, HOST, APP_URL…); the options above take precedence. If it's already running,
// starting it again just opens it. The server is restarted if it stops unexpectedly, and when it asks to be (exit code
// 75: "Restart now" in Settings → Installation, after a restore was checked).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(ROOT, "apps", "server");
const WEB_DIR = path.join(ROOT, "apps", "web");
const PORTS = [4000, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900];
const RESTART_CODE = 75;
const isWindows = process.platform === "win32";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const say = (line = "") => console.log(line ? `  ${line}` : "");
function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---------- Desktop shortcut (Windows) ----------

if (flag("shortcut")) {
  if (!isWindows) fail("The desktop shortcut is for Windows. Elsewhere, start it with npm run local.");
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const script = [
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Reachstack.lnk'))",
    `$link.TargetPath = ${quote(path.join(ROOT, "Start Reachstack.cmd"))}`,
    `$link.WorkingDirectory = ${quote(ROOT)}`,
    `$link.IconLocation = ${quote(path.join(ROOT, "tools", "reachstack.ico"))}`,
    "$link.Description = 'Start Reachstack and open it in the browser'",
    "$link.Save()",
    "Join-Path $desktop 'Reachstack.lnk'",
  ].join("; ");
  const made = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (made.status !== 0) fail(`Couldn't make the shortcut: ${(made.stderr || made.stdout).trim()}`);
  say(`Made ${made.stdout.trim()}: double-click it to start Reachstack.`);
  process.exit(0);
}

// ---------- Node and dependencies ----------

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  fail(`Reachstack needs Node.js 22.12 or newer (this is ${process.versions.node}). Install the current LTS from https://nodejs.org and start it again.`);
}

/** Runs npm in the repository, showing its output. True when it worked. */
function npm(npmArgs) {
  // npm is a .cmd file on Windows, which only runs through a shell (the arguments here are fixed words).
  return spawnSync(["npm", ...npmArgs].join(" "), { cwd: ROOT, stdio: "inherit", shell: true }).status === 0;
}

function missingPackages() {
  const needs = [
    [SERVER_DIR, ["tsx", "fastify", "@libsql/client", "drizzle-orm"]],
    [WEB_DIR, ["vite", "react"]],
  ];
  return needs.flatMap(([dir, names]) => {
    const req = createRequire(path.join(dir, "package.json"));
    return names.filter((name) => {
      try {
        req.resolve(name);
        return false;
      } catch {
        return true;
      }
    });
  });
}

// Which package-lock.json the installed packages match, so an update that changes them (git pull, a new download
// over the old folder) installs again. Without the note, what's installed is taken to match.
const LOCK_FILE = path.join(ROOT, "package-lock.json");
const INSTALLED_FOR = path.join(ROOT, "node_modules", ".reachstack-installed");
const lockHash = () => (existsSync(LOCK_FILE) ? createHash("sha256").update(readFileSync(LOCK_FILE)).digest("hex") : "");
const installedFor = () => (existsSync(INSTALLED_FOR) ? readFileSync(INSTALLED_FOR, "utf8").trim() : null);
const noteInstalled = () => {
  try {
    writeFileSync(INSTALLED_FOR, lockHash());
  } catch {
    // only saves an install after the next update
  }
};

const missing = missingPackages();
const updated = !missing.length && installedFor() !== null && installedFor() !== lockHash();
if (missing.length || updated) {
  say(updated ? "Reachstack was updated: installing what changed…" : "Installing what Reachstack needs (the first time takes a few minutes)…");
  if (!npm(["install", "--no-audit", "--no-fund"])) fail("Installing failed (see above). Check the internet connection and start it again.");
  if (missingPackages().length) fail(`Still missing after installing: ${missingPackages().join(", ")}.`);
  noteInstalled();
} else if (installedFor() === null) {
  noteInstalled();
}

// The database driver is a native module, made for the common systems only (not Windows on ARM, for one).
const driver = (() => {
  try {
    return createRequire(createRequire(path.join(SERVER_DIR, "package.json")).resolve("@libsql/client")).resolve("libsql");
  } catch {
    return null;
  }
})();
if (driver && spawnSync(process.execPath, ["-e", "require(process.argv[1])", driver], { stdio: "ignore", windowsHide: true }).status !== 0) {
  fail(
    isWindows && process.arch === "arm64"
      ? "Reachstack's database driver doesn't run on Windows on ARM yet. Install the x64 version of Node.js from https://nodejs.org/en/download (Windows on ARM runs it), then start Reachstack again."
      : `Reachstack's database driver (libsql) doesn't run on this system (${process.platform} ${process.arch}). It runs on Windows (x64), macOS and Linux (x64 and ARM).`,
  );
}

// ---------- Settings (.env, then the options) ----------

function readDotEnv() {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
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
const STATE_FILE = path.join(dataDir, "local-server.json");
const lan = flag("lan");
const host = lan ? "0.0.0.0" : setting("HOST") || "localhost";

// ---------- Already running? ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (flag("no-open")) return;
  const [cmd, cmdArgs] = isWindows ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    // A computer without a browser opener (a server, a minimal Linux) reports that as an event, not an exception.
    const opener = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
    opener.on("error", () => undefined);
    opener.unref();
  } catch {
    // no browser to open; the address is printed
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

const previous = readState();
if (previous?.launcher_pid && pidAlive(previous.launcher_pid) && (await answers(previous.port))) {
  say(`Reachstack is already running: ${previous.url}`);
  openBrowser(previous.url);
  process.exit(0);
}

// ---------- Port ----------

/** Whether nothing listens on the port, on any of this computer's addresses. */
async function portFree(port) {
  const tryListen = (h) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", (err) => resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"));
      srv.listen({ port, host: h, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  for (const h of ["0.0.0.0", "127.0.0.1", "::1"]) if (!(await tryListen(h))) return false;
  return true;
}

async function choosePort() {
  const asked = option("port") || setting("PORT");
  if (asked) {
    const port = Number(asked);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`"${asked}" isn't a port number.`);
    if (await portFree(port)) return port;
    if (await answers(port)) {
      say(`Reachstack is already running on port ${port}.`);
      openBrowser(`http://localhost:${port}`);
      process.exit(0);
    }
    fail(`Port ${port} is used by another program. Choose another one with --port, or change PORT in .env.`);
  }
  for (const port of PORTS) if (await portFree(port)) return port;
  fail(`Ports ${PORTS[0]}–${PORTS.at(-1)} are all in use. Choose a free one with --port.`);
}

const port = await choosePort();

/** A localhost address keeps its path but takes the chosen port; any other address (a real domain) is kept as it is. */
function localAddress(value, fallback) {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return value;
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

const appUrl = localAddress(setting("APP_URL"), `http://localhost:${port}`);

// ---------- Web app ----------

/** The newest change under a file or folder (folders count too, so deleted files are noticed). */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    max = Math.max(max, newest(path.join(p, entry.name)));
  }
  return max;
}

const builtAt = newest(path.join(WEB_DIR, "dist", "index.html"));
const sourcesChangedAt = Math.max(
  ...["src", "public", "index.html", "vite.config.ts", "package.json", "tsconfig.json"].map((p) => newest(path.join(WEB_DIR, p))),
  newest(path.join(ROOT, "packages", "shared", "src")),
);
if (!builtAt || sourcesChangedAt > builtAt) {
  say(builtAt ? "The app changed since it was last built: building it again (about a minute)…" : "Building the web app (the first time takes about a minute)…");
  const vite = path.join(path.dirname(createRequire(path.join(WEB_DIR, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  if (spawnSync(process.execPath, [vite, "build"], { cwd: WEB_DIR, stdio: "inherit" }).status !== 0) fail("Building the web app failed (see above).");
}

// ---------- Server ----------

const env = {
  ...process.env,
  PORT: String(port),
  HOST: host,
  APP_URL: appUrl,
  WEB_URL: localAddress(setting("WEB_URL"), appUrl),
  TRACKING_BASE_URL: localAddress(setting("TRACKING_BASE_URL"), appUrl),
  REACHSTACK_SUPERVISOR: "local",
};

let child = null;
let stopping = false;
const crashes = [];

function writeState(serverPid) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ launcher_pid: process.pid, server_pid: serverPid, port, url: appUrl, started_at: new Date().toISOString() }, null, 2));
  } catch {
    // only used to notice a second start
  }
}

function clearState() {
  if (readState()?.launcher_pid === process.pid) rmSync(STATE_FILE, { force: true });
}

async function waitUntilAnswering(proc) {
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null) return false;
    if (await answers(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startServer(first) {
  const envFile = path.join(ROOT, ".env");
  const nodeArgs = [...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), "--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, nodeArgs, { cwd: SERVER_DIR, env, stdio: "inherit" });
  const proc = child;
  writeState(proc.pid);
  proc.on("exit", (code, signal) => void onExit(proc, code, signal));
  if (await waitUntilAnswering(proc)) {
    say(`Open ${appUrl} in your browser${lan ? " (other devices: this computer's network address, same port)" : ""}. Close this window or press Ctrl+C to stop.`);
    say();
    if (first) openBrowser(appUrl);
  } else if (proc.exitCode === null) {
    say(`The server hasn't answered after two minutes. It may still be starting: try ${appUrl} in a moment.`);
  }
}

async function onExit(proc, code, signal) {
  if (proc !== child) return;
  if (stopping) {
    clearState();
    process.exit(0);
  }
  if (code === RESTART_CODE) {
    say("Restarting…");
    return startServer(false);
  }
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > 10 * 60_000) crashes.shift();
  if (crashes.length > 5) {
    clearState();
    fail("The server keeps stopping (see the messages above), so it isn't started again.");
  }
  say(`The server stopped unexpectedly (${signal ?? `exit code ${code}`}). Starting it again in a few seconds…`);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (!stopping) await startServer(false);
}

function stop() {
  if (stopping) return;
  stopping = true;
  say("Stopping…");
  // Ctrl+C reaches the server too (same console) and it shuts down by itself; this is for a window being closed.
  setTimeout(() => child?.kill(), 3_000).unref();
  setTimeout(() => {
    clearState();
    process.exit(0);
  }, 10_000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

say();
say(`Starting Reachstack on port ${port}…`);
await startServer(true);
