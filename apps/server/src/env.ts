import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// Under the test runner, test/helpers/setup.ts must have run first: it points DATA_DIR at a throwaway folder. A test file
// that imports server code before ./helpers/app would otherwise open the real database.
if (process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") {
  throw new Error("Import ./helpers/app (or ./helpers/setup) before any server module in this test file.");
}

const dataDir = path.resolve(REPO_ROOT, str("DATA_DIR", "./data"));
mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
mkdirSync(path.join(dataDir, "exports"), { recursive: true });

function loadSecret(): string {
  const fromEnv = str("APP_SECRET");
  if (fromEnv.length >= 32) return fromEnv;
  const file = path.join(dataDir, "secret.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const port = Number(str("PORT", "4000"));
const appUrl = str("APP_URL", `http://localhost:${port}`).replace(/\/$/, "");

export const config = {
  brandName: str("BRAND_NAME", "Reachstack"),
  port,
  /** Where the server listens: every network (0.0.0.0), or "localhost" for this computer only (127.0.0.1 and ::1). */
  host: str("HOST", "0.0.0.0"),
  appUrl,
  /** Where the browser app lives (defaults to APP_URL; set to the Vite URL while developing UI). */
  webUrl: str("WEB_URL", appUrl).replace(/\/$/, ""),
  trackingBaseUrl: str("TRACKING_BASE_URL", appUrl).replace(/\/$/, ""),
  dataDir,
  dbFile: path.join(dataDir, "app.db"),
  secret: loadSecret(),
  systemSmtp: {
    host: str("SYSTEM_SMTP_HOST"),
    port: Number(str("SYSTEM_SMTP_PORT", "587")),
    user: str("SYSTEM_SMTP_USER"),
    pass: str("SYSTEM_SMTP_PASS"),
    from: str("SYSTEM_SMTP_FROM"),
  },
  google: { clientId: str("GOOGLE_CLIENT_ID"), clientSecret: str("GOOGLE_CLIENT_SECRET") },
  microsoft: { clientId: str("MICROSOFT_CLIENT_ID"), clientSecret: str("MICROSOFT_CLIENT_SECRET") },
  anthropic: { apiKey: str("ANTHROPIC_API_KEY"), model: str("ANTHROPIC_MODEL", "claude-opus-5-5"), baseUrl: str("ANTHROPIC_BASE_URL") },
  /**
   * The AI the server uses when a workspace has no key of its own: "anthropic" (Claude), or "openai" for any server
   * that speaks the OpenAI chat API, such as Ollama or LM Studio on this machine (free, nothing leaves it).
   */
  aiProvider: (str("AI_PROVIDER", "anthropic") === "openai" ? "openai" : "anthropic") as "anthropic" | "openai",
  openai: { baseUrl: str("OPENAI_BASE_URL").replace(/\/$/, ""), apiKey: str("OPENAI_API_KEY"), model: str("OPENAI_MODEL") },
  stripe: { secretKey: str("STRIPE_SECRET_KEY"), webhookSecret: str("STRIPE_WEBHOOK_SECRET") },
  twilio: { accountSid: str("TWILIO_ACCOUNT_SID"), authToken: str("TWILIO_AUTH_TOKEN") },
  ipinfoToken: str("IPINFO_TOKEN"),
  /** IP lookup API base (website visitor identification). */
  ipinfoBaseUrl: str("IPINFO_BASE_URL", "https://ipinfo.io").replace(/\/$/, ""),
  /** Optional email-finder fallback for people outside the dataset. */
  hunterApiKey: str("HUNTER_API_KEY"),
  /** Public resolvers used when the system resolver fails a record lookup (empty disables the fallback). */
  dnsFallbackServers: str("DNS_FALLBACK_SERVERS", "1.1.1.1,8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** SMTP RCPT probing during email verification (needs outbound port 25). */
  verifySmtpProbe: str("VERIFY_SMTP_PROBE", "false") === "true",
  /** SpamAssassin daemon for content scoring; the built-in heuristic is used when unset. */
  spamd: { host: str("SPAMD_HOST"), port: Number(str("SPAMD_PORT", "783")) },
  /** Who runs this installation, for the public privacy center (all optional). */
  privacy: {
    email: str("PRIVACY_EMAIL"),
    phone: str("PRIVACY_PHONE"),
    policyUrl: str("PRIVACY_POLICY_URL"),
    termsUrl: str("TERMS_URL"),
  },
  runWorkerInProcess: str("RUN_WORKER_IN_PROCESS", "true") !== "false",
  /** Set when something starts the server again after it exits ("local" under npm run local), so the app can restart it. */
  supervisor: str("REACHSTACK_SUPERVISOR"),
  /** Allow webhooks and other outbound requests to private/loopback addresses (defaults on outside production). */
  allowPrivateUrls: str("ALLOW_PRIVATE_URLS", process.env.NODE_ENV === "production" ? "false" : "true") === "true",
  /**
   * Which proxies may tell us the visitor's address (X-Forwarded-For): "true", "false", a hop count, or addresses and
   * ranges (proxy-addr names such as loopback, uniquelocal). Default: a proxy on this machine or a private network.
   */
  trustProxy: ((v: string): boolean | number | string => (v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v))(
    str("TRUST_PROXY", "loopback,uniquelocal"),
  ),
  isProduction: process.env.NODE_ENV === "production",
  webDist: path.join(REPO_ROOT, "apps", "web", "dist"),
};

export type AppConfig = typeof config;
