// The installation owner and administrators (services/instance.ts, services/installation.ts, routes/admin.ts):
// who they are, what only they can do, sign-up modes, turning accounts off, handing over ownership and limits.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { PASSWORD, TestClient, expectStatus, json, listRoutes, logIn, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";

const MISSING_ID = "00000000-0000-7000-8000-000000000000";

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let admin: TestUser;

before(async () => {
  app = await startServer();
  owner = await signUp(app, { firstName: "Owner" });
  member = await signUp(app, { firstName: "Member" });
  admin = await signUp(app, { firstName: "Admin" });
  expectStatus(await owner.client.patch(`/api/app/admin/users/${admin.id}`, { admin: true }), 200);
});
after(stopServer);

async function setInstallation(patch: Record<string, unknown>) {
  return json(await owner.client.patch("/api/app/admin/settings", patch));
}

describe("who owns the installation", () => {
  it("the first account is the owner, and its workspace is unmetered", async () => {
    assert.equal(owner.me.features.owner, true);
    assert.equal(owner.me.features.instance_admin, true);
    assert.equal(owner.me.workspace.self_hosted, true);
    assert.equal(owner.me.workspace.trial_ends_at, null);
    const overview = json(await owner.client.get("/api/app/admin/overview"));
    assert.equal(overview.you.owner, true);
    assert.equal(overview.owner.id, owner.id);
  });

  it("later accounts are neither owner nor administrator", async () => {
    assert.equal(member.me.features.owner, false);
    assert.equal(member.me.features.instance_admin, false);
    const people = json(await owner.client.get(`/api/app/admin/users?search=${encodeURIComponent(member.email)}`));
    assert.equal(people.items.length, 1);
    assert.equal(people.items[0].owner, false);
    assert.equal(people.items[0].admin, false);
  });

  it("an administrator the owner chose is an administrator, not the owner", async () => {
    const me = json(await admin.client.get("/api/app/auth/me"));
    assert.equal(me.features.instance_admin, true);
    assert.equal(me.features.owner, false);
  });
});

describe("installation admin routes", () => {
  it("answer 403 to people who aren't administrators, on every route", async () => {
    const routes = (await listRoutes()).filter((r) => r.url.startsWith("/api/app/admin/"));
    assert.ok(routes.length >= 25, `only found ${routes.length} admin routes`);
    routes.push(
      { method: "GET", url: "/api/app/system/mail-log", config: {} },
      { method: "POST", url: "/api/app/placement/seeds", config: {} },
      { method: "PATCH", url: "/api/app/placement/seeds/:id", config: {} },
    );
    const failures: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z_]+/g, MISSING_ID);
      const res = await member.client.request(r.method as "GET", url, r.method === "GET" || r.method === "DELETE" ? undefined : {});
      if (res.statusCode !== 403) failures.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    assert.deepEqual(failures, []);
  });

  it("let administrators look and help, but only the owner changes the installation", async () => {
    for (const url of ["/api/app/admin/overview", "/api/app/admin/users", "/api/app/admin/workspaces", "/api/app/admin/settings", "/api/app/admin/sessions"]) {
      expectStatus(await admin.client.get(url), 200, url);
    }
    const ownerOnly: Array<[method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown]> = [
      ["PATCH", "/api/app/admin/settings", { signup_mode: "closed" }],
      ["POST", "/api/app/admin/owner", { user_id: admin.id, password: PASSWORD }],
      ["GET", "/api/app/admin/mail-log"],
      ["GET", "/api/app/system/mail-log"],
      ["PATCH", `/api/app/admin/workspaces/${member.workspaceId}`, { unlimited: false }],
      ["POST", `/api/app/admin/workspaces/${member.workspaceId}/credits`, { pool: "credits", amount: 100 }],
      ["POST", `/api/app/admin/users/${member.id}/reset-link`, {}],
      ["DELETE", `/api/app/admin/users/${member.id}`],
      ["PATCH", `/api/app/admin/users/${member.id}`, { admin: true }],
      ["POST", "/api/app/admin/restart", {}],
    ];
    for (const [method, url, body] of ownerOnly) expectStatus(await admin.client.request(method, url, body), 403, `${method} ${url}`);
    assert.equal(json(await admin.client.get("/api/app/admin/settings")).signup_mode, "open");
    assert.equal(json(await member.client.get("/api/app/auth/me")).features.instance_admin, false);
  });

  it("restarting from the app is offered only where something starts the server again", async () => {
    // Tests run without REACHSTACK_SUPERVISOR, like a server started by hand: exiting would just stop it.
    assert.equal(json(await owner.client.get("/api/app/admin/overview")).runtime.can_restart, false);
    assert.equal(json(await owner.client.get("/api/app/admin/health")).can_restart, false);
    assert.match(json(await owner.client.post("/api/app/admin/restart", {}), 400).message, /can't restart itself/);
    // The health check names this start, so the app can tell when a restart has happened.
    assert.match(json(await owner.client.get("/api/health")).boot, /^[0-9a-f]{8}$/);
  });

  it("nobody can turn off, sign out or delete the owner from the people list", async () => {
    expectStatus(await owner.client.patch(`/api/app/admin/users/${owner.id}`, { disabled: true }), 400);
    expectStatus(await admin.client.patch(`/api/app/admin/users/${owner.id}`, { disabled: true }), 403);
    expectStatus(await admin.client.post(`/api/app/admin/users/${owner.id}/sign-out`), 403);
    expectStatus(await admin.client.delete(`/api/app/admin/users/${owner.id}`), 403);
    expectStatus(await owner.client.get("/api/app/auth/me"), 200);
  });
});

describe("who can sign up", () => {
  it("rejects unknown modes and unknown settings", async () => {
    expectStatus(await owner.client.patch("/api/app/admin/settings", { signup_mode: "everyone" }), 400);
    expectStatus(await owner.client.patch("/api/app/admin/settings", { signup_mode: "closed", surprise: true }), 400);
    assert.equal(json(await owner.client.get("/api/app/admin/settings")).signup_mode, "open");
  });

  it("closed: nobody new gets in, and the answer doesn't reveal who has an account", async () => {
    assert.equal((await setInstallation({ signup_mode: "closed" })).signup_mode, "closed");
    try {
      assert.equal(json(await new TestClient(app).get("/api/public/config")).signup_mode, "closed");
      for (const email of [uniqueEmail("stranger"), member.email]) {
        const res = await new TestClient(app).post("/api/app/auth/signup", { email, password: PASSWORD });
        expectStatus(res, 403, email);
        assert.equal(res.json().code, "signup_closed");
      }
      await logIn(app, member.email);
    } finally {
      await setInstallation({ signup_mode: "open" });
    }
  });

  it("invitation only: strangers are refused, invited people get in", async () => {
    await setInstallation({ signup_mode: "invite" });
    try {
      const stranger = await new TestClient(app).post("/api/app/auth/signup", { email: uniqueEmail("stranger"), password: PASSWORD });
      expectStatus(stranger, 403);
      assert.equal(stranger.json().code, "signup_closed");

      const invitee = uniqueEmail("invitee");
      const invite = json(await member.client.post("/api/v2/workspace-members", { email: invitee, role: "editor" }));
      const token = new URL(invite.invite_url).searchParams.get("token")!;
      const someoneElse = await new TestClient(app).post("/api/app/auth/signup", { email: uniqueEmail("stranger"), password: PASSWORD, invite_token: token });
      expectStatus(someoneElse, 403);

      const joined = await signUp(app, { email: invitee, inviteToken: token });
      assert.equal(joined.me.workspace.id, member.workspaceId);
      assert.equal(joined.me.membership.role, "editor");
      assert.equal(joined.me.workspaces.length, 1);
    } finally {
      await setInstallation({ signup_mode: "open" });
    }
  });
});

describe("turning accounts off", () => {
  it("ends the account's sessions and blocks sign-in until it's turned back on", async () => {
    const u = await signUp(app);
    const secondSession = await logIn(app, u.email);
    expectStatus(await admin.client.patch(`/api/app/admin/users/${u.id}`, { disabled: true }), 200);
    expectStatus(await u.client.get("/api/app/auth/me"), 401);
    expectStatus(await secondSession.get("/api/app/auth/me"), 401);
    const refused = await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: u.password });
    expectStatus(refused, 403);
    assert.equal(refused.json().code, "account_disabled");
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: "wrong-password" }), 401);
    assert.equal(json(await owner.client.get(`/api/app/admin/users?search=${encodeURIComponent(u.email)}`)).items[0].disabled, true);

    expectStatus(await owner.client.patch(`/api/app/admin/users/${u.id}`, { disabled: false }), 200);
    await logIn(app, u.email);
  });

  it("a session that somehow survives stops working while the account is off", async () => {
    const u = await signUp(app);
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, u.id));
    expectStatus(await u.client.get("/api/app/auth/me"), 401);
    expectStatus(await u.client.get("/api/app/campaigns"), 401);
    await db.update(schema.users).set({ disabledAt: null }).where(eq(schema.users.id, u.id));
    expectStatus(await u.client.get("/api/app/auth/me"), 200);
  });
});

describe("handing over ownership", () => {
  it("needs the owner's password and an active account to hand it to", async () => {
    const heir = await signUp(app);
    expectStatus(await owner.client.post("/api/app/admin/owner", { user_id: heir.id }), 400);
    expectStatus(await owner.client.post("/api/app/admin/owner", { user_id: heir.id, password: "wrong-password" }), 400);
    expectStatus(await owner.client.post("/api/app/admin/owner", { user_id: MISSING_ID, password: owner.password }), 404);
    assert.equal(json(await heir.client.get("/api/app/auth/me")).features.owner, false);
    expectStatus(await member.client.post("/api/app/admin/owner", { user_id: member.id, password: member.password }), 403);
  });

  it("moves owner rights and unmetered workspaces to the new owner; the old owner stays an administrator", async () => {
    await setInstallation({ new_workspace_mode: "trial" });
    let heir: TestUser;
    try {
      heir = await signUp(app);
    } finally {
      await setInstallation({ new_workspace_mode: "unlimited" });
    }
    assert.equal(heir.me.workspace.self_hosted, false);

    expectStatus(await owner.client.post("/api/app/admin/owner", { user_id: heir.id, password: owner.password }), 200);
    const heirMe = json(await heir.client.get("/api/app/auth/me"));
    assert.equal(heirMe.features.owner, true);
    assert.equal(heirMe.workspace.self_hosted, true);
    assert.equal(heirMe.workspace.trial_ends_at, null);
    const formerMe = json(await owner.client.get("/api/app/auth/me"));
    assert.equal(formerMe.features.owner, false);
    assert.equal(formerMe.features.instance_admin, true);
    expectStatus(await owner.client.patch("/api/app/admin/settings", { signup_mode: "open" }), 403);

    // And back again, so the rest of the file has its owner.
    expectStatus(await heir.client.post("/api/app/admin/owner", { user_id: owner.id, password: heir.password }), 200);
    assert.equal(json(await owner.client.get("/api/app/auth/me")).features.owner, true);
    assert.equal(json(await heir.client.get("/api/app/auth/me")).features.owner, false);
  });
});

describe("workspace limits", () => {
  it("other people's new workspaces start the way the owner chose; the owner's are always unmetered", async () => {
    await setInstallation({ new_workspace_mode: "trial" });
    try {
      const u = await signUp(app);
      assert.equal(u.me.workspace.self_hosted, false);
      const days = (Date.parse(u.me.workspace.trial_ends_at) - Date.now()) / 86_400_000;
      assert.ok(days > 13.9 && days <= 14, `trial days ${days}`);
      const billing = json(await u.client.get("/api/app/billing/overview"));
      assert.equal(billing.on_trial, true);
      assert.equal(billing.usage.uploaded_contacts.limit, 250);
      assert.equal(billing.usage.monthly_emails.limit, 1000);

      const ownerTab = await logIn(app, owner.email);
      const extra = json(await ownerTab.post("/api/app/workspaces", { name: "Owner's second workspace" }));
      assert.equal(extra.self_hosted, true);
      expectStatus(await owner.client.patch(`/api/app/admin/workspaces/${owner.workspaceId}`, { unlimited: false }), 400);
    } finally {
      await setInstallation({ new_workspace_mode: "unlimited" });
    }
    assert.equal((await signUp(app)).me.workspace.self_hosted, true);
  });

  it("the owner's plan, credits and unlimited switch decide a workspace's limits, and the limits hold", async () => {
    await setInstallation({ new_workspace_mode: "trial" });
    let u: TestUser;
    try {
      u = await signUp(app);
    } finally {
      await setInstallation({ new_workspace_mode: "unlimited" });
    }
    const campaign = json(await u.client.post("/api/app/campaigns", { name: "Limits" }));
    const leads = (count: number, from: number) => Array.from({ length: count }, (_, i) => ({ email: `lead-${from + i}@example.test` }));

    const first = json(await u.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: leads(260, 0) }));
    assert.equal(first.leads_uploaded, 250);
    assert.equal(first.remaining_in_plan, 0);
    assert.equal(first.over_plan_limit, 10, "the rows left out are counted");
    // An import over the limit finishes and says how many rows weren't added, rather than failing.
    const job = json(await u.client.post("/api/app/leads/import", { campaign_id: campaign.id, leads: leads(3, 2000), source: "manual" }));
    let done: typeof schema.backgroundJobs.$inferSelect | undefined;
    for (let i = 0; i < 100 && !["success", "failed"].includes(done?.status ?? ""); i++) {
      await runPendingJobs();
      [done] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id));
    }
    assert.equal(done?.status, "success");
    assert.equal((done!.result as Record<string, number>).over_plan_limit, 3);
    assert.equal((done!.result as Record<string, number>).leads_uploaded, 0);
    const over = await u.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: leads(1, 1000) });
    expectStatus(over, 402);
    assert.equal(over.json().code, "payment_required");

    const ws = `/api/app/admin/workspaces/${u.workspaceId}`;
    expectStatus(await owner.client.patch(ws, { plan_ids: { outreach: "no_such_plan" } }), 400);
    expectStatus(await owner.client.patch(ws, { plan_ids: { outreach: "outreach_growth" } }), 200);
    const growth = json(await u.client.get("/api/app/billing/overview"));
    assert.equal(growth.usage.uploaded_contacts.limit, 1000);
    assert.equal(growth.usage.uploaded_contacts.used, 250);
    assert.equal(growth.usage.monthly_emails.limit, 5000);
    assert.equal(json(await u.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: leads(10, 1000) })).leads_uploaded, 10);

    expectStatus(await owner.client.post(`${ws}/credits`, { pool: "credits", amount: -5 }), 400);
    expectStatus(await owner.client.post(`${ws}/credits`, { pool: "credits", amount: 120, note: "test grant" }), 200);
    assert.equal(json(await u.client.get("/api/app/billing/overview")).usage.credits.balance, 120);

    expectStatus(await owner.client.patch(ws, { unlimited: true }), 200);
    const unlimited = json(await u.client.get("/api/app/billing/overview"));
    assert.equal(unlimited.self_hosted, true);
    assert.equal(unlimited.usage.uploaded_contacts.limit, null);
  });
});

describe("helping in other workspaces", () => {
  it("an administrator can open someone's workspace, which adds them as an admin there", async () => {
    const helper = await logIn(app, owner.email);
    assert.equal(json(await helper.post(`/api/app/admin/workspaces/${member.workspaceId}/enter`)).workspace_id, member.workspaceId);
    const me = json(await helper.get("/api/app/auth/me"));
    assert.equal(me.workspace.id, member.workspaceId);
    assert.equal(me.membership.role, "admin");
    expectStatus(await member.client.post(`/api/app/admin/workspaces/${owner.workspaceId}/enter`), 403);
  });
});
