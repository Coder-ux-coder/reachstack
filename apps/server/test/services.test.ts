// Settings → Installation → Services (services/service-settings.ts, routes/services.ts) and the local AI server path in
// services/ai.ts: only the installation owner can see or change these settings, saved secrets never come back, a saved
// value replaces the environment's until it's cleared, and a local OpenAI-style AI answers plain and structured
// requests. No network: the local AI server is a stubbed fetch. Every key here is a made-up test string.
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { TestClient, expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";
import { resolveAi, structured } from "../src/services/ai";
import { setAppSetting } from "../src/services/instance";
import { loadServiceSettings } from "../src/services/service-settings";

const AI_KEY = "test-ai-key-saved-on-services-page-7781";
const SMTP_PASS = "test-smtp-pass-saved-on-services-page-5520";
const TWILIO_TOKEN = "test-twilio-token-saved-on-services-page-9034";
const LOCAL_AI = "http://127.0.0.1:11434/v1";

let app: FastifyInstance;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;

interface Field {
  key: string;
  source: "saved" | "env" | "none";
  value: unknown;
  hint: string | null;
  env_set: boolean;
}
const field = (view: { fields: Field[] }, key: string) => view.fields.find((f) => f.key === key)!;
const save = async (values: Record<string, unknown>, expected = 200) => json<{ fields: Field[] }>(await owner.client.patch("/api/app/admin/services", { values }), expected);

before(async () => {
  app = await startServer();
  owner = await signUp(app, { firstName: "Owner" });
  admin = await signUp(app, { firstName: "Admin" });
  member = await signUp(app, { firstName: "Member", workspaceName: "Member Co" });
  expectStatus(await owner.client.patch(`/api/app/admin/users/${admin.id}`, { admin: true }), 200);
});

after(async () => {
  await stopServer();
});

describe("who can use the Services page", () => {
  it("is the installation owner's alone: administrators, members and signed-out visitors are turned away", async () => {
    json(await owner.client.get("/api/app/admin/services"));
    for (const who of [admin, member]) {
      expectStatus(await who.client.get("/api/app/admin/services"), 403);
      expectStatus(await who.client.patch("/api/app/admin/services", { values: { "brand.name": "Taken over" } }), 403);
      expectStatus(await who.client.post("/api/app/admin/services/test", { service: "smtp" }), 403);
    }
    const anon = new TestClient(app);
    expectStatus(await anon.get("/api/app/admin/services"), 401);
    expectStatus(await anon.patch("/api/app/admin/services", { values: { "brand.name": "Taken over" } }), 401);
    assert.notEqual(config.brandName, "Taken over");
  });

  it("refuses a change without the CSRF header", async () => {
    expectStatus(await owner.client.patch("/api/app/admin/services", { values: { "brand.name": "No header" } }, { csrf: false }), 403);
    assert.notEqual(config.brandName, "No header");
  });
});

describe("saving, clearing and the environment", () => {
  it("shows where each value comes from, with the address to register for Google and Microsoft", async () => {
    const view = json<{ fields: Field[]; redirect_uris: { google: string; microsoft: string } }>(await owner.client.get("/api/app/admin/services"));
    // The tests set ANTHROPIC_API_KEY in the environment and leave the SMTP server unset.
    assert.equal(field(view, "anthropic.api_key").source, "env");
    assert.equal(field(view, "anthropic.api_key").env_set, true);
    assert.equal(field(view, "smtp.host").source, "none");
    assert.equal(field(view, "smtp.port").value, 587);
    assert.match(view.redirect_uris.google, /^http:\/\/localhost:4000\//);
    assert.match(view.redirect_uris.microsoft, /^http:\/\/localhost:4000\//);
  });

  it("uses a saved secret at once, never sends it back, and stores it encrypted", async () => {
    const view = await save({ "anthropic.api_key": AI_KEY, "smtp.pass": SMTP_PASS, "twilio.auth_token": TWILIO_TOKEN });
    assert.equal(config.anthropic.apiKey, AI_KEY);
    assert.equal(config.systemSmtp.pass, SMTP_PASS);
    assert.equal(config.twilio.authToken, TWILIO_TOKEN);
    const ai = field(view, "anthropic.api_key");
    assert.equal(ai.source, "saved");
    assert.equal(ai.value, null);
    assert.equal(ai.hint, "…7781");

    const raw = (await owner.client.get("/api/app/admin/services")).body;
    for (const secret of [AI_KEY, SMTP_PASS, TWILIO_TOKEN]) assert.ok(!raw.includes(secret), "a saved secret came back to the browser");
    const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, "services"));
    const stored = JSON.stringify(row!.value);
    for (const secret of [AI_KEY, SMTP_PASS, TWILIO_TOKEN]) assert.ok(!stored.includes(secret), "a secret was stored in plain text");
    assert.match(stored, /"anthropic.api_key":"v1:/);
  });

  it("goes back to the environment when a saved value is cleared, and leaves other values alone", async () => {
    const view = await save({ "anthropic.api_key": null, "smtp.pass": "" });
    assert.equal(config.anthropic.apiKey, "test-key");
    assert.equal(config.systemSmtp.pass, "");
    assert.equal(field(view, "anthropic.api_key").source, "env");
    assert.equal(field(view, "smtp.pass").source, "none");
    assert.equal(field(view, "twilio.auth_token").source, "saved");
    assert.equal(config.twilio.authToken, TWILIO_TOKEN);
    await save({ "twilio.auth_token": null });
    assert.equal(config.twilio.authToken, "");
  });

  it("changes what people see right away: the product name and the sign-in buttons", async () => {
    await save({ "brand.name": "Northwind Mail", "google.client_id": "test-client-id.apps.example.test" });
    assert.equal(json<{ brand: string }>(await new TestClient(app).get("/api/health")).brand, "Northwind Mail");
    const anon = json<{ sign_in: { google: boolean; microsoft: boolean } }>(await new TestClient(app).get("/api/public/config"));
    assert.equal(anon.sign_in.google, true);
    assert.equal(anon.sign_in.microsoft, false);
    await save({ "brand.name": null, "google.client_id": null });
    assert.equal(json<{ brand: string }>(await new TestClient(app).get("/api/health")).brand, "Reachstack");
  });

  it("checks values before saving any of them", async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ "anthropic.base_url": "not a url" }, /web address/],
      [{ "openai.base_url": "ftp://127.0.0.1/v1" }, /web address/],
      [{ "smtp.port": 70000 }, /port/],
      [{ "smtp.port": "25a" }, /port/],
      [{ "privacy.email": "nobody" }, /email/],
      [{ "ai.provider": "someone-else" }, /must be one of/],
      [{ "verify.smtp_probe": "yes" }, /on or off/],
      [{ "no.such.setting": "x" }, /Unknown setting/],
      [{ "brand.name": "x".repeat(501) }, /too long/],
      // One bad value stops the whole save.
      [{ "brand.name": "Half saved", "smtp.port": 0 }, /port/],
    ];
    for (const [values, message] of bad) {
      const res = await owner.client.patch("/api/app/admin/services", { values });
      expectStatus(res, 400, JSON.stringify(values).slice(0, 60));
      assert.match(res.json().message, message);
    }
    assert.notEqual(config.brandName, "Half saved");
    // A local AI needs its address and model, or AI would quietly go off.
    const local = await owner.client.patch("/api/app/admin/services", { values: { "ai.provider": "openai" } });
    expectStatus(local, 400);
    assert.match(local.json().message, /address and model/);
    assert.equal(config.aiProvider, "anthropic");
    // Numbers may arrive as text from a form.
    const view = await save({ "smtp.port": "2525", "verify.smtp_probe": true });
    assert.equal(field(view, "smtp.port").value, 2525);
    assert.equal(config.verifySmtpProbe, true);
    await save({ "smtp.port": null, "verify.smtp_probe": null });
    assert.equal(config.systemSmtp.port, 587);
    assert.equal(config.verifySmtpProbe, false);
  });

  it("is picked up by another process (a separate worker) on its next look", async () => {
    await setAppSetting("services", { values: { "spamd.host": "127.0.0.1", "spamd.port": 7830 }, secrets: {} });
    await loadServiceSettings();
    assert.equal(config.spamd.host, "127.0.0.1");
    assert.equal(config.spamd.port, 7830);
    await setAppSetting("services", { values: {}, secrets: {} });
    await loadServiceSettings();
    assert.equal(config.spamd.host, "");
  });

  it("falls back to the environment for a secret that no longer decrypts, instead of failing", async () => {
    // As after restoring a backup made with another APP_SECRET.
    await setAppSetting("services", { values: {}, secrets: { "anthropic.api_key": "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    await loadServiceSettings();
    assert.equal(config.anthropic.apiKey, "test-key");
    const view = json<{ fields: Field[] }>(await owner.client.get("/api/app/admin/services"));
    assert.equal(field(view, "anthropic.api_key").source, "env");
    await setAppSetting("services", { values: {}, secrets: {} });
    await loadServiceSettings();
  });
});

describe("the Test buttons", () => {
  it("say what's missing before trying anything", async () => {
    for (const service of ["smtp", "smtp_send", "spamd"]) {
      const r = json<{ ok: boolean; message: string }>(await owner.client.post("/api/app/admin/services/test", { service }));
      assert.equal(r.ok, false);
      assert.match(r.message, /first/);
    }
    expectStatus(await owner.client.post("/api/app/admin/services/test", { service: "dns" }), 400);
  });

  it("report a server that can't be reached as a failed test, not an error", async () => {
    await save({ "smtp.host": "127.0.0.1", "smtp.port": 2525, "spamd.host": "127.0.0.1" });
    for (const service of ["smtp", "spamd"]) {
      const r = json<{ ok: boolean; message: string }>(await owner.client.post("/api/app/admin/services/test", { service }));
      assert.equal(r.ok, false, service);
      assert.match(r.message, /127\.0\.0\.1/);
    }
    await save({ "smtp.host": null, "smtp.port": null, "spamd.host": null });
  });
});

describe("a local AI server", () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; body: Record<string, any>; auth: string | null }> = [];
  let answer = "ready";

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(LOCAL_AI)) throw new Error(`unexpected request to ${url}`);
      calls.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ model: "test-local-model", choices: [{ message: { content: answer } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    }) as typeof fetch;
    await save({ "ai.provider": "openai", "openai.base_url": `${LOCAL_AI}/`, "openai.model": "test-local-model", "openai.api_key": "test-local-key-0001" });
  });

  afterEach(() => {
    calls = [];
    answer = "ready";
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await save({ "ai.provider": null, "openai.base_url": null, "openai.model": null, "openai.api_key": null });
  });

  it("answers the AI test through /chat/completions with the saved key", async () => {
    const r = json<{ ok: boolean; message: string }>(await owner.client.post("/api/app/admin/services/test", { service: "ai" }));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /test-local-model/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${LOCAL_AI}/chat/completions`);
    assert.equal(calls[0]!.auth, "Bearer test-local-key-0001");
    assert.equal(calls[0]!.body.model, "test-local-model");
    assert.equal(calls[0]!.body.messages.at(-1).content, "Reply with the single word: ready");
  });

  it("counts AI as on in the installation overview", async () => {
    const o = json<{ services: { ai: boolean } }>(await owner.client.get("/api/app/admin/overview"));
    assert.equal(o.services.ai, true);
  });

  it("returns structured answers checked against the schema, without the model's thinking or code fences", async () => {
    answer = '<think>The sender wants pricing.</think>\nHere you go:\n```json\n{"label": "interested", "confidence": 0.9}\n```';
    const schema = z.object({ label: z.enum(["interested", "not_interested"]), confidence: z.number() });
    const r = await structured({ workspaceId: null, feature: "test", messages: [{ role: "user", content: "Label this reply." }], schema });
    assert.deepEqual(r, { label: "interested", confidence: 0.9 });
    const sent = calls[0]!.body;
    assert.equal(sent.response_format.type, "json_schema");
    assert.deepEqual(Object.keys(sent.response_format.json_schema.schema.properties).sort(), ["confidence", "label"]);
    assert.match(sent.messages[0].content, /JSON Schema/);
  });

  it("says so when the answer doesn't fit the schema", async () => {
    answer = '{"label": "maybe"}';
    const schema = z.object({ label: z.enum(["interested", "not_interested"]) });
    await assert.rejects(structured({ workspaceId: null, feature: "test", messages: [{ role: "user", content: "Label this reply." }], schema }), /expected shape/);
  });

  it("never hands out a Claude client while the server uses a local AI", async () => {
    await assert.rejects(resolveAi(null), (err: { code?: string }) => err.code === "ai_needs_claude");
  });

  it("runs Copilot: the local AI calls a tool, reads its result and answers", async () => {
    const turns: Array<Record<string, any>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(LOCAL_AI)) throw new Error(`unexpected request to ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      // Follow-up suggestions are a plain structured request (no tools).
      if (!body.tools) return Response.json({ choices: [{ message: { content: '{"follow_ups": ["Show my campaigns"]}' } }] });
      turns.push(body);
      const message =
        turns.length === 1
          ? { content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "get_workspace_overview", arguments: "{}" } }] }
          : { content: "<think>Look at the numbers.</think>Your workspace is set up and ready." };
      return Response.json({ model: "test-local-model", choices: [{ finish_reason: turns.length === 1 ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 50, completion_tokens: 9 } });
    }) as typeof fetch;

    const res = await owner.client.post("/api/app/copilot/chat", { text: "How is my workspace doing?" });
    expectStatus(res, 200);
    const events = res.body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event: "))
      .map((chunk) => ({ event: chunk.slice(7, chunk.indexOf("\n")), data: JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)) }));
    assert.equal(events.find((e) => e.event === "error"), undefined, JSON.stringify(events.find((e) => e.event === "error")?.data));
    const done = events.filter((e) => e.event === "action" && e.data.status === "done").map((e) => e.data.tool);
    assert.deepEqual(done, ["get_workspace_overview"], "the tool ran");
    const said = events.filter((e) => e.event === "text").map((e) => e.data.delta).join("");
    assert.equal(said, "Your workspace is set up and ready.", "the answer, without the model's thinking");
    assert.equal(events.at(-1)!.event, "done");

    // The second request carries the call and its result the way the OpenAI chat API expects them.
    assert.equal(turns.length, 2);
    const [, second] = turns;
    assert.equal(second!.tools.some((t: { function: { name: string } }) => t.function.name === "get_workspace_overview"), true);
    const asked = second!.messages.find((m: { role: string; tool_calls?: unknown[] }) => m.role === "assistant" && m.tool_calls);
    const answered = second!.messages.find((m: { role: string }) => m.role === "tool");
    assert.ok(asked && answered, "the call and its result are both in the history");
    assert.equal(answered.tool_call_id, asked.tool_calls[0].id);
    assert.match(asked.tool_calls[0].id, /^toolu_local_/);
    assert.equal(second!.messages[0].role, "system");
  });

  it("reports an AI server that isn't running as a failed test", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r = json<{ ok: boolean; message: string }>(await owner.client.post("/api/app/admin/services/test", { service: "ai" }));
    assert.equal(r.ok, false);
    assert.match(r.message, /Can't reach the AI server/);
  });
});

describe("test limits", () => {
  it("allows 30 tests per owner every 10 minutes", async () => {
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await owner.client.post("/api/app/admin/services/test", { service: "spamd" })).statusCode;
    assert.equal(last, 429);
  });
});
