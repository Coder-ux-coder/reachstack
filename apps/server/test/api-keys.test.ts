// API keys (Authorization: Bearer rs_…): creation, storage, scopes, workspace binding, revocation, and which routes
// they can never reach. Also cross-site (CORS) behaviour, since only the public API answers other websites.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { TestClient, expectStatus, json, listRoutes, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { sha256 } from "../src/lib/ids";

const MISSING_ID = "00000000-0000-7000-8000-000000000000";
const SCHEDULE = {
  schedules: [{ name: "Weekdays", timing: { from: "09:00", to: "17:00" }, days: { "1": true, "2": true, "3": true }, timezone: "America/Chicago" }],
};

let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;
let aliceCampaign: { id: string; name: string };
let bobCampaign: { id: string; name: string };

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  alice = await signUp(app, { firstName: "Alice" });
  bob = await signUp(app, { firstName: "Bob" });
  aliceCampaign = json(await alice.client.post("/api/app/campaigns", { name: "Alice's campaign" })) as typeof aliceCampaign;
  bobCampaign = json(await bob.client.post("/api/app/campaigns", { name: "Bob's campaign" })) as typeof bobCampaign;
});
after(stopServer);

async function createKey(user: TestUser, scopes: string[], name = "Test key"): Promise<{ id: string; key: string }> {
  return json(await user.client.post("/api/v2/api-keys", { name, scopes })) as { id: string; key: string };
}

describe("creating API keys", () => {
  it("shows the key once; afterwards only its prefix, and only a hash is stored", async () => {
    const created = await createKey(alice, ["campaigns:read"]);
    assert.match(created.key, /^rs_[A-Za-z0-9_-]{30,}$/);
    const list = await alice.client.get("/api/v2/api-keys");
    expectStatus(list, 200);
    assert.ok(!list.body.includes(created.key));
    const item = list.json().items.find((k: { id: string }) => k.id === created.id);
    assert.equal(item.key, `${created.key.slice(0, 10)}••••••••`);
    assert.deepEqual(item.scopes, ["campaigns:read"]);
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.id));
    assert.equal(row!.keyHash, sha256(created.key));
    assert.ok(!JSON.stringify(row).includes(created.key));
  });

  it("rejects malformed scopes", async () => {
    for (const scopes of [[], ["campaigns"], ["campaigns:write"], ["Campaigns:read"], ["../x:read"], ["campaigns:read:extra"], ["campaigns:read "]]) {
      expectStatus(await alice.client.post("/api/v2/api-keys", { name: "Bad", scopes }), 400, JSON.stringify(scopes));
    }
  });

  it("keeps each workspace's keys to itself", async () => {
    const created = await createKey(alice, ["campaigns:read"]);
    assert.ok(!json(await bob.client.get("/api/v2/api-keys")).items.some((k: { id: string }) => k.id === created.id));
    expectStatus(await bob.client.delete(`/api/v2/api-keys/${created.id}`), 404);
    expectStatus(await new TestClient(app, created.key).get("/api/v2/campaigns"), 200);
  });
});

describe("using an API key", () => {
  it("works on routes inside its scopes, with no CSRF header needed", async () => {
    const { key } = await createKey(alice, ["campaigns:read", "campaigns:create"]);
    const api = new TestClient(app, key);
    assert.ok(json(await api.get("/api/v2/campaigns")).items.some((c: { id: string }) => c.id === aliceCampaign.id));
    expectStatus(await api.get(`/api/v2/campaigns/${aliceCampaign.id}`), 200);
    const made = json(await api.post("/api/v2/campaigns", { name: "Made with a key", campaign_schedule: SCHEDULE }, { csrf: false }));
    assert.equal(made.name, "Made with a key");
  });

  it("gets 403 outside its scopes", async () => {
    const api = new TestClient(app, (await createKey(alice, ["campaigns:read"])).key);
    const attempts: Array<[HTTPMethods, string, unknown?]> = [
      ["POST", "/api/v2/campaigns", { name: "Not allowed", campaign_schedule: SCHEDULE }],
      ["PATCH", `/api/v2/campaigns/${aliceCampaign.id}`, { name: "Renamed by key" }],
      ["DELETE", `/api/v2/campaigns/${aliceCampaign.id}`],
      ["POST", "/api/v2/leads/list", {}],
      ["GET", "/api/v2/accounts"],
      ["GET", "/api/v2/background-jobs"],
      ["GET", "/api/v2/workspace-members"],
      ["GET", "/api/v2/api-keys"],
      ["POST", "/api/v2/api-keys", { name: "More power", scopes: ["all:all"] }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await api.request(method, url, body);
      expectStatus(res, 403, `${method} ${url}`);
      assert.equal(res.json().code, "forbidden");
    }
    assert.equal(json(await alice.client.get(`/api/v2/campaigns/${aliceCampaign.id}`)).name, aliceCampaign.name);
  });

  it("can never reach app routes that declare no API scope, even with every scope", async () => {
    const api = new TestClient(app, (await createKey(alice, ["all:all"])).key);
    const routes = (await listRoutes()).filter((r) => r.url.startsWith("/api/app/") && !r.config.scope && r.config.auth !== "public");
    assert.ok(routes.length > 100, `only ${routes.length} routes`);
    const failures: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z_]+/g, MISSING_ID);
      const res = await api.request(r.method as HTTPMethods, url, r.method === "GET" || r.method === "DELETE" ? undefined : {});
      if (res.statusCode !== 403) failures.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 100)}`);
    }
    assert.deepEqual(failures, []);
  });

  it("acts only in its own workspace, whatever cookie or workspace header comes along", async () => {
    const { key } = await createKey(alice, ["all:all"]);
    const api = new TestClient(app, key);
    for (const [method, body] of [["GET"], ["PATCH", { name: "Taken" }], ["DELETE"]] as Array<[HTTPMethods, unknown?]>) {
      expectStatus(await api.request(method, `/api/v2/campaigns/${bobCampaign.id}`, body), 404, method);
    }
    assert.equal(json(await bob.client.get(`/api/v2/campaigns/${bobCampaign.id}`)).name, "Bob's campaign");

    const withBobsCookie = new TestClient(app, key);
    withBobsCookie.cookie = bob.client.cookie;
    const ids = json(await withBobsCookie.get("/api/v2/campaigns")).items.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(aliceCampaign.id));
    assert.ok(!ids.includes(bobCampaign.id));
    const viaHeader = json(await api.get("/api/v2/campaigns", { headers: { "x-workspace-id": bob.workspaceId! } }));
    assert.ok(!viaHeader.items.some((c: { id: string }) => c.id === bobCampaign.id));
  });

  it("stops working once deleted, and a bad key never falls back to the session cookie", async () => {
    const { id, key } = await createKey(alice, ["campaigns:read"]);
    const api = new TestClient(app, key);
    expectStatus(await api.get("/api/v2/campaigns"), 200);
    expectStatus(await alice.client.delete(`/api/v2/api-keys/${id}`), 200);
    expectStatus(await api.get("/api/v2/campaigns"), 401);

    const forged = new TestClient(app, "rs_made-up-key-made-up-key-made-up-key");
    forged.cookie = alice.client.cookie;
    expectStatus(await forged.get("/api/v2/campaigns"), 401);
    expectStatus(await forged.get("/api/app/auth/me"), 401);
  });

  it(
    "a key that may only create keys can't create one with more power than itself",
    async () => {
      const api = new TestClient(app, (await createKey(alice, ["api_keys:create"])).key);
      expectStatus(await api.post("/api/v2/api-keys", { name: "Escalated", scopes: ["all:all"] }), [400, 403]);
    },
  );
});

describe("cross-site access", () => {
  const evil = { origin: "https://evil.example" };

  it("the app API never answers other websites", async () => {
    for (const url of ["/api/app/auth/me", "/api/app/campaigns", "/api/public/config"]) {
      const res = await alice.client.get(url, { headers: evil });
      expectStatus(res, 200, url);
      assert.equal(res.headers["access-control-allow-origin"], undefined, url);
    }
    const preflight = await new TestClient(app).request("OPTIONS", "/api/app/campaigns", undefined, {
      headers: { ...evil, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-rs-csrf" },
    });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  });

  it("the public API answers other websites, but never with credentials", async () => {
    const res = await new TestClient(app, (await createKey(alice, ["campaigns:read"])).key).get("/api/v2/campaigns", { headers: { origin: "https://tool.example" } });
    expectStatus(res, 200);
    assert.equal(res.headers["access-control-allow-origin"], "https://tool.example");
    assert.notEqual(res.headers["access-control-allow-credentials"], "true");
  });

  it("API answers tell browsers not to sniff types or leak full referrers", async () => {
    for (const res of [await alice.client.get("/api/app/auth/me"), await new TestClient(app).get("/api/health")]) {
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
    }
  });
});
