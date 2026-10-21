// Imported first by every test file (directly or through ./app). It runs before any server module, so src/env.ts
// sees these settings: a throwaway data folder for this test process (never the real data/ folder), no integration
// keys, and AI pointed at a closed local port. It also makes any attempt to reach the network fail loudly.
import dns from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const TEST_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "rs-test-"));

const UNSET = [
  "PORT",
  "HOST",
  "REACHSTACK_SUPERVISOR",
  "WEB_URL",
  "TRACKING_BASE_URL",
  "BRAND_NAME",
  "TRUST_PROXY",
  "SYSTEM_SMTP_HOST",
  "SYSTEM_SMTP_PORT",
  "SYSTEM_SMTP_USER",
  "SYSTEM_SMTP_PASS",
  "SYSTEM_SMTP_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_MODEL",
  "AI_PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_CLIENT_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "IPINFO_TOKEN",
  "IPINFO_BASE_URL",
  "HUNTER_API_KEY",
  "VERIFY_SMTP_PROBE",
  "SPAMD_HOST",
  "SPAMD_PORT",
  "PRIVACY_EMAIL",
  "PRIVACY_PHONE",
  "PRIVACY_POLICY_URL",
  "TERMS_URL",
];
for (const key of UNSET) delete process.env[key];

Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: TEST_DATA_DIR,
  APP_URL: "http://localhost:4000",
  APP_SECRET: "rs-test-secret-not-a-real-one-".padEnd(40, "x"),
  RUN_WORKER_IN_PROCESS: "false",
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  // Production behaviour for user-supplied URLs, so the SSRF guard is really exercised.
  ALLOW_PRIVATE_URLS: "false",
  LOG_LEVEL: process.env.RS_TEST_LOG_LEVEL || "silent",
});

// stopServer() removes the folder once the database is closed; this covers files that never start a server.
process.on("exit", () => {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Still open (a run that stopped early): left for the OS temp cleanup.
  }
});

// ---------- No network ----------

function blocked(what: string): Error {
  return Object.assign(new Error(`Tests must not use the network (${what})`), { code: "ERR_TEST_NETWORK" });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  throw blocked(`fetch ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
}) as typeof fetch;

// TCP and TLS sockets (SMTP, IMAP, HTTP clients). Local IPC pipes stay allowed.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const pipe = typeof first === "string" || (typeof first === "object" && first !== null && typeof (first as { path?: unknown }).path === "string");
  if (pipe) return realConnect.apply(this, args as never);
  const target = (typeof first === "object" && first !== null ? first : { port: first, host: args[1] }) as { host?: unknown; port?: unknown };
  const err = blocked(`connect ${String(target.host ?? "localhost")}:${String(target.port)}`);
  process.nextTick(() => this.destroy(err));
  return this;
} as typeof net.Socket.prototype.connect;

// Name lookups: "localhost" and IP literals resolve locally; anything else would ask a DNS server.
const isLocalName = (host: unknown) => typeof host === "string" && (host === "localhost" || net.isIP(host) !== 0);
const realLookup = dns.lookup;
dns.lookup = function (hostname: string, ...rest: unknown[]) {
  if (isLocalName(hostname)) return (realLookup as (...a: unknown[]) => unknown).call(dns, hostname, ...rest);
  const callback = rest.at(-1) as (err: Error) => void;
  process.nextTick(callback, blocked(`DNS lookup ${hostname}`));
  return {};
} as typeof dns.lookup;
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = (async (hostname: string, options?: unknown) => {
  if (!isLocalName(hostname)) throw blocked(`DNS lookup ${hostname}`);
  return realPromiseLookup(hostname, options as never);
}) as typeof dns.promises.lookup;

// Record lookups (MX, TXT, …) always go to a DNS server.
const isResolve = (name: string) => name.startsWith("resolve") || name === "reverse";
const callbackStyle = (name: string) =>
  function (host: unknown, ...rest: unknown[]) {
    process.nextTick(rest.at(-1) as (err: Error) => void, blocked(`DNS ${name} ${String(host)}`));
    return {};
  };
const promiseStyle = (name: string) => async (host: unknown) => {
  throw blocked(`DNS ${name} ${String(host)}`);
};
const patch = (target: object, style: (name: string) => unknown) => {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (isResolve(name) && typeof (target as Record<string, unknown>)[name] === "function") (target as Record<string, unknown>)[name] = style(name);
  }
};
patch(dns, callbackStyle);
patch(dns.Resolver.prototype, callbackStyle);
patch(dns.promises, promiseStyle);
patch(dns.promises.Resolver.prototype, promiseStyle);
// ES module imports of node:dns and node:dns/promises see the guarded functions too.
syncBuiltinESMExports();

// ---------- Quieter output ----------

// Without SMTP the server prints every system email; tests read them from systemMailLog instead.
const realLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("\n[system mail]")) return;
  realLog(...args);
};
