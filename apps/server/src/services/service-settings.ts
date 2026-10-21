// Keys and services the installation owner sets in Settings → Installation → Services. A value saved there replaces
// the matching environment variable while the server runs; clearing it goes back to the environment, so a server set
// up with environment variables keeps working unchanged. Secrets are stored encrypted with the app secret and never
// sent to the browser: the page only learns whether one is set and its last four characters. Each process (the API
// and a separate worker) loads the values at start and looks for changes every 30 seconds.
import net from "node:net";
import nodemailer from "nodemailer";
import { config } from "../env";
import { badRequest } from "../http/errors";
import { decrypt, encrypt } from "../lib/crypto";
import { redirectUri } from "../mail/oauth";
import { getAppSetting, setAppSetting } from "./instance";

const KEY = "services";

export type ServiceFieldKind = "text" | "secret" | "url" | "email" | "port" | "switch" | "choice";
type Value = string | number | boolean;

interface FieldDef {
  key: string;
  env: string;
  kind: ServiceFieldKind;
  choices?: readonly string[];
  read: () => Value;
  write: (v: Value) => void;
}

const text = (v: Value) => String(v);
const FIELDS: FieldDef[] = [
  { key: "ai.provider", env: "AI_PROVIDER", kind: "choice", choices: ["anthropic", "openai"], read: () => config.aiProvider, write: (v) => (config.aiProvider = v === "openai" ? "openai" : "anthropic") },
  { key: "anthropic.api_key", env: "ANTHROPIC_API_KEY", kind: "secret", read: () => config.anthropic.apiKey, write: (v) => (config.anthropic.apiKey = text(v)) },
  { key: "anthropic.model", env: "ANTHROPIC_MODEL", kind: "text", read: () => config.anthropic.model, write: (v) => (config.anthropic.model = text(v)) },
  { key: "anthropic.base_url", env: "ANTHROPIC_BASE_URL", kind: "url", read: () => config.anthropic.baseUrl, write: (v) => (config.anthropic.baseUrl = text(v).replace(/\/$/, "")) },
  { key: "openai.base_url", env: "OPENAI_BASE_URL", kind: "url", read: () => config.openai.baseUrl, write: (v) => (config.openai.baseUrl = text(v).replace(/\/$/, "")) },
  { key: "openai.api_key", env: "OPENAI_API_KEY", kind: "secret", read: () => config.openai.apiKey, write: (v) => (config.openai.apiKey = text(v)) },
  { key: "openai.model", env: "OPENAI_MODEL", kind: "text", read: () => config.openai.model, write: (v) => (config.openai.model = text(v)) },
  { key: "google.client_id", env: "GOOGLE_CLIENT_ID", kind: "text", read: () => config.google.clientId, write: (v) => (config.google.clientId = text(v)) },
  { key: "google.client_secret", env: "GOOGLE_CLIENT_SECRET", kind: "secret", read: () => config.google.clientSecret, write: (v) => (config.google.clientSecret = text(v)) },
  { key: "microsoft.client_id", env: "MICROSOFT_CLIENT_ID", kind: "text", read: () => config.microsoft.clientId, write: (v) => (config.microsoft.clientId = text(v)) },
  { key: "microsoft.client_secret", env: "MICROSOFT_CLIENT_SECRET", kind: "secret", read: () => config.microsoft.clientSecret, write: (v) => (config.microsoft.clientSecret = text(v)) },
  { key: "smtp.host", env: "SYSTEM_SMTP_HOST", kind: "text", read: () => config.systemSmtp.host, write: (v) => (config.systemSmtp.host = text(v)) },
  { key: "smtp.port", env: "SYSTEM_SMTP_PORT", kind: "port", read: () => config.systemSmtp.port, write: (v) => (config.systemSmtp.port = Number(v)) },
  { key: "smtp.user", env: "SYSTEM_SMTP_USER", kind: "text", read: () => config.systemSmtp.user, write: (v) => (config.systemSmtp.user = text(v)) },
  { key: "smtp.pass", env: "SYSTEM_SMTP_PASS", kind: "secret", read: () => config.systemSmtp.pass, write: (v) => (config.systemSmtp.pass = text(v)) },
  { key: "smtp.from", env: "SYSTEM_SMTP_FROM", kind: "text", read: () => config.systemSmtp.from, write: (v) => (config.systemSmtp.from = text(v)) },
  { key: "verify.smtp_probe", env: "VERIFY_SMTP_PROBE", kind: "switch", read: () => config.verifySmtpProbe, write: (v) => (config.verifySmtpProbe = v === true) },
  { key: "spamd.host", env: "SPAMD_HOST", kind: "text", read: () => config.spamd.host, write: (v) => (config.spamd.host = text(v)) },
  { key: "spamd.port", env: "SPAMD_PORT", kind: "port", read: () => config.spamd.port, write: (v) => (config.spamd.port = Number(v)) },
  { key: "ipinfo.token", env: "IPINFO_TOKEN", kind: "secret", read: () => config.ipinfoToken, write: (v) => (config.ipinfoToken = text(v)) },
  { key: "hunter.api_key", env: "HUNTER_API_KEY", kind: "secret", read: () => config.hunterApiKey, write: (v) => (config.hunterApiKey = text(v)) },
  { key: "twilio.account_sid", env: "TWILIO_ACCOUNT_SID", kind: "text", read: () => config.twilio.accountSid, write: (v) => (config.twilio.accountSid = text(v)) },
  { key: "twilio.auth_token", env: "TWILIO_AUTH_TOKEN", kind: "secret", read: () => config.twilio.authToken, write: (v) => (config.twilio.authToken = text(v)) },
  { key: "brand.name", env: "BRAND_NAME", kind: "text", read: () => config.brandName, write: (v) => (config.brandName = text(v)) },
  { key: "privacy.email", env: "PRIVACY_EMAIL", kind: "email", read: () => config.privacy.email, write: (v) => (config.privacy.email = text(v)) },
  { key: "privacy.phone", env: "PRIVACY_PHONE", kind: "text", read: () => config.privacy.phone, write: (v) => (config.privacy.phone = text(v)) },
  { key: "privacy.policy_url", env: "PRIVACY_POLICY_URL", kind: "url", read: () => config.privacy.policyUrl, write: (v) => (config.privacy.policyUrl = text(v)) },
  { key: "privacy.terms_url", env: "TERMS_URL", kind: "url", read: () => config.privacy.termsUrl, write: (v) => (config.privacy.termsUrl = text(v)) },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** What the environment says, taken before anything saved here is applied. */
const FROM_ENV = new Map(FIELDS.map((f) => [f.key, f.read()]));
const envSet = (f: FieldDef) => (process.env[f.env] ?? "") !== "";

interface Stored {
  values: Record<string, Value>;
  /** Encrypted with the app secret. */
  secrets: Record<string, string>;
  updated_at?: string;
  updated_by?: string;
}

const empty = (): Stored => ({ values: {}, secrets: {} });

/** A saved secret, or null when it no longer decrypts (a backup restored under another APP_SECRET). */
function openSecret(value: string | undefined): string | null {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

function apply(stored: Stored) {
  for (const f of FIELDS) {
    // A secret that no longer decrypts falls back to the environment rather than stopping the server from starting.
    const own = f.kind === "secret" ? openSecret(stored.secrets[f.key]) : stored.values[f.key];
    f.write(own ?? FROM_ENV.get(f.key)!);
  }
}

let applied = "";

/** Applies what's saved, if it changed since the last look. */
export async function loadServiceSettings() {
  const stored = (await getAppSetting<Stored | null>(KEY, null)) ?? empty();
  const json = JSON.stringify(stored);
  if (json === applied) return;
  applied = json;
  apply({ values: stored.values ?? {}, secrets: stored.secrets ?? {} });
}

let timer: NodeJS.Timeout | null = null;

/** Loads the saved values now and keeps this process in step with changes made in another one. */
export async function startServiceSettingsSync() {
  await loadServiceSettings();
  if (timer) return;
  timer = setInterval(() => void loadServiceSettings().catch(() => undefined), 30_000);
  timer.unref();
}

export interface ServiceFieldView {
  key: string;
  env: string;
  kind: ServiceFieldKind;
  choices?: readonly string[];
  /** Where the value in use comes from. */
  source: "saved" | "env" | "none";
  /** The value in use, for everything but secrets. */
  value: Value | null;
  /** The last four characters of a secret in use, so the owner can tell keys apart. */
  hint: string | null;
  /** The environment has a value too (what clearing the saved one goes back to). */
  env_set: boolean;
}

const lastFour = (s: string) => (s.length > 8 ? `…${s.slice(-4)}` : "set");

export async function serviceSettingsView() {
  const stored = (await getAppSetting<Stored | null>(KEY, null)) ?? empty();
  const fields: ServiceFieldView[] = FIELDS.map((f) => {
    const saved = f.kind === "secret" ? !!openSecret(stored.secrets?.[f.key]) : stored.values?.[f.key] !== undefined;
    const value = f.read();
    const inUse = typeof value === "string" ? value !== "" : true;
    return {
      key: f.key,
      env: f.env,
      kind: f.kind,
      ...(f.choices ? { choices: f.choices } : {}),
      source: saved ? "saved" : envSet(f) ? "env" : "none",
      value: f.kind === "secret" ? null : value,
      hint: f.kind === "secret" && inUse ? lastFour(String(value)) : null,
      env_set: envSet(f),
    };
  });
  return {
    fields,
    updated_at: stored.updated_at ?? null,
    updated_by: stored.updated_by ?? null,
    /** Register these with Google and Microsoft: one address serves both sign-in and connecting mailboxes. */
    redirect_uris: { google: redirectUri("google"), microsoft: redirectUri("microsoft") },
  };
}

function check(f: FieldDef, raw: unknown): Value {
  const label = f.key;
  switch (f.kind) {
    case "switch":
      if (typeof raw !== "boolean") throw badRequest(`${label} must be on or off`);
      return raw;
    case "port": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw badRequest("Enter a port number between 1 and 65535");
      return n;
    }
    case "choice":
      if (!f.choices!.includes(String(raw))) throw badRequest(`${label} must be one of ${f.choices!.join(", ")}`);
      return String(raw);
    default: {
      if (typeof raw !== "string") throw badRequest(`${label} must be text`);
      const v = raw.trim();
      if (v.length > (f.kind === "secret" ? 4_000 : 500)) throw badRequest(`${label} is too long`);
      if (f.kind === "url") {
        let u: URL | null = null;
        try {
          u = new URL(v);
        } catch {
          // reported below
        }
        if (!u || !/^https?:$/.test(u.protocol)) throw badRequest("Enter a full web address starting with http:// or https://");
      }
      if (f.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest("Enter a valid email address");
      return v;
    }
  }
}

/**
 * Saves the given values: a value replaces the environment's, null or "" clears it (back to the environment). Keys
 * not mentioned stay as they are.
 */
export async function updateServiceSettings(patch: Record<string, unknown>, userId: string) {
  const stored = (await getAppSetting<Stored | null>(KEY, null)) ?? empty();
  const next: Stored = { values: { ...(stored.values ?? {}) }, secrets: { ...(stored.secrets ?? {}) } };
  for (const [key, raw] of Object.entries(patch)) {
    const f = BY_KEY.get(key);
    if (!f) throw badRequest(`Unknown setting: ${key}`);
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) {
      delete next.values[key];
      delete next.secrets[key];
      continue;
    }
    const v = check(f, raw);
    if (f.kind === "secret") next.secrets[key] = encrypt(String(v));
    else next.values[key] = v;
  }
  // A local AI without its address or model would quietly turn AI off for every workspace.
  const inUse = (key: string) => String(next.values[key] ?? FROM_ENV.get(key) ?? "");
  if (inUse("ai.provider") === "openai" && (!inUse("openai.base_url") || !inUse("openai.model"))) {
    throw badRequest("Add the AI server's address and model to use a local AI.");
  }
  next.updated_at = new Date().toISOString();
  next.updated_by = userId;
  await setAppSetting(KEY, next);
  await loadServiceSettings();
  return serviceSettingsView();
}

// ---------- Connection checks (the page's "Test" buttons) ----------

export interface CheckResult {
  ok: boolean;
  message: string;
}

/** Signs in to the system SMTP server without sending anything. */
export async function checkSystemSmtp(): Promise<CheckResult> {
  const s = config.systemSmtp;
  if (!s.host) return { ok: false, message: "Add the SMTP server first." };
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.verify();
    return { ok: true, message: s.user ? `Signed in to ${s.host} as ${s.user}.` : `Connected to ${s.host}.` };
  } catch (err) {
    return { ok: false, message: `${s.host}:${s.port} answered: ${(err as Error).message}` };
  } finally {
    transport.close();
  }
}

/** Asks SpamAssassin's spamd for a PONG. */
export function checkSpamd(): Promise<CheckResult> {
  const { host, port } = config.spamd;
  if (!host) return Promise.resolve({ ok: false, message: "Add the spamd host first." });
  return new Promise((resolve) => {
    let reply = "";
    const done = (r: CheckResult) => {
      socket.destroy();
      resolve(r);
    };
    const socket = net.connect({ host, port, timeout: 5_000 }, () => socket.write("PING SPAMC/1.5\r\n\r\n"));
    socket.on("data", (d) => (reply += d.toString("utf8")));
    socket.on("end", () => done(/PONG/.test(reply) ? { ok: true, message: `spamd at ${host}:${port} answered.` } : { ok: false, message: `${host}:${port} isn't spamd: ${reply.slice(0, 80) || "no answer"}` }));
    socket.on("timeout", () => done({ ok: false, message: `${host}:${port} didn't answer within 5 seconds.` }));
    socket.on("error", (err) => done({ ok: false, message: `Can't reach ${host}:${port}: ${err.message}` }));
  });
}
