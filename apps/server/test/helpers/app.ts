// The real API for HTTP tests, driven with Fastify's inject (no ports), plus a small client that keeps a
// session cookie the way a browser does. One server per test file; each file runs in its own process with its
// own empty database (see ./setup).
import { TEST_DATA_DIR } from "./setup";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";
import Fastify, { type FastifyInstance, type HTTPMethods, type LightMyRequestResponse } from "fastify";
import { client as dbClient, initDb } from "../../src/db/client";
import { buildApp } from "../../src/http/app";
import { registerRoutes } from "../../src/routes";
import { bootstrapInstallation } from "../../src/services/bootstrap";
import { updateInstallationSettings } from "../../src/services/installation";

export type Res = LightMyRequestResponse;

let server: FastifyInstance | null = null;

/**
 * Most test files sign several people up, so their installation lets anyone create an account. `installationDefaults`
 * leaves it as a new installation is (invited people only, after the first account).
 */
export async function startServer(opts: { installationDefaults?: boolean } = {}): Promise<FastifyInstance> {
  if (server) return server;
  await initDb();
  await bootstrapInstallation();
  if (!opts.installationDefaults) await updateInstallationSettings({ signup_mode: "open" });
  server = await buildApp();
  await server.ready();
  return server;
}

export async function stopServer() {
  // Event-bus listeners run after the response; give them a moment to finish with the database.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await server?.close();
  server = null;
  dbClient.close();
  await removeDataDir();
}

/**
 * Deletes this process's throwaway data folder. SQLite lets go of its files only once its statements are garbage
 * collected, and Windows won't delete open files, so collect first and retry a few times.
 */
async function removeDataDir() {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  for (let attempt = 0; attempt < 10; attempt++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
    try {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

let addressSeq = 0;
/** A distinct public-looking address (documentation ranges) per client, so per-address rate limits never mix tests. */
export function nextAddress(): string {
  const n = ++addressSeq;
  return n <= 254 ? `203.0.113.${n}` : `198.51.100.${(n - 254) % 254}`;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Send the SPA's CSRF header on writes (default true). */
  csrf?: boolean;
  /** Overrides the client's address for this request. */
  remoteAddress?: string;
}

/** A browser (session cookie) or, with `bearer`, an API client. */
export class TestClient {
  cookie: string | null = null;
  readonly address = nextAddress();

  constructor(
    readonly app: FastifyInstance,
    readonly bearer: string | null = null,
  ) {}

  async request(method: HTTPMethods, url: string, body?: unknown, opts: RequestOptions = {}): Promise<Res> {
    const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Reachstack tests)" };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (this.cookie) headers.cookie = `rs_sid=${this.cookie}`;
    if (opts.csrf !== false && !SAFE.has(method)) headers["x-rs-csrf"] = "1";
    Object.assign(headers, opts.headers);
    const res = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: opts.remoteAddress ?? this.address,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const set = res.cookies.find((c) => c.name === "rs_sid");
    if (set) this.cookie = set.value && !(set.expires && new Date(set.expires).getTime() < Date.now()) ? set.value : null;
    return res;
  }

  get = (url: string, opts?: RequestOptions) => this.request("GET", url, undefined, opts);
  post = (url: string, body?: unknown, opts?: RequestOptions) => this.request("POST", url, body ?? {}, opts);
  patch = (url: string, body?: unknown, opts?: RequestOptions) => this.request("PATCH", url, body ?? {}, opts);
  put = (url: string, body?: unknown, opts?: RequestOptions) => this.request("PUT", url, body ?? {}, opts);
  delete = (url: string, body?: unknown, opts?: RequestOptions) => this.request("DELETE", url, body, opts);
}

/** Asserts the status code, showing the response body when it differs. */
export function expectStatus(res: Res, expected: number | number[], label = "") {
  const list = Array.isArray(expected) ? expected : [expected];
  assert.ok(list.includes(res.statusCode), `${label ? `${label}: ` : ""}expected ${list.join(" or ")}, got ${res.statusCode} ${res.body.slice(0, 400)}`);
}

/** The JSON body of a response with the expected status. */
export function json<T = Record<string, any>>(res: Res, expected = 200): T {
  expectStatus(res, expected);
  return res.json() as T;
}

// ---------- Accounts ----------

/** Obviously fake test password (never a real credential). */
export const PASSWORD = "test-only-password-1";

let emailSeq = 0;
export function uniqueEmail(tag = "user"): string {
  return `${tag}-${++emailSeq}-${process.pid}@example.test`;
}

export interface TestUser {
  client: TestClient;
  email: string;
  password: string;
  id: string;
  workspaceId: string | null;
  me: Record<string, any>;
}

export async function signUp(app: FastifyInstance, opts: { email?: string; password?: string; firstName?: string; workspaceName?: string; inviteToken?: string } = {}): Promise<TestUser> {
  const client = new TestClient(app);
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? PASSWORD;
  const res = await client.post("/api/app/auth/signup", {
    email,
    password,
    first_name: opts.firstName ?? "Test",
    last_name: "User",
    ...(opts.workspaceName ? { workspace_name: opts.workspaceName } : {}),
    ...(opts.inviteToken ? { invite_token: opts.inviteToken } : {}),
  });
  expectStatus(res, 200, `sign up ${email}`);
  const me = json(await client.get("/api/app/auth/me"));
  return { client, email, password, id: me.user.id, workspaceId: me.workspace?.id ?? null, me };
}

export async function logIn(app: FastifyInstance, email: string, password = PASSWORD): Promise<TestClient> {
  const client = new TestClient(app);
  expectStatus(await client.post("/api/app/auth/login", { email, password }), 200, `log in ${email}`);
  return client;
}

// ---------- Route table ----------

export interface RouteInfo {
  method: string;
  url: string;
  config: { auth?: string; scope?: [string, string]; admin?: boolean; owner?: boolean; write?: boolean; perm?: string };
}

/** Every route the API registers, with its auth config (the same view as `npm run routes:audit`). */
export async function listRoutes(): Promise<RouteInfo[]> {
  const bare = Fastify();
  const rows: RouteInfo[] = [];
  bare.addHook("onRoute", (r) => {
    for (const method of Array.isArray(r.method) ? r.method : [r.method]) {
      if (method !== "HEAD") rows.push({ method, url: r.url, config: (r.config ?? {}) as RouteInfo["config"] });
    }
  });
  await registerRoutes(bare);
  await bare.ready();
  await bare.close();
  return rows;
}
