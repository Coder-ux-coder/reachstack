// Workspace isolation: one workspace can't read or change another's campaigns, leads, mailboxes, lists, notes,
// jobs or members, through the app API or API v2, by id or in bulk. Also roles inside a shared workspace.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { TestClient, expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";

type Attempt = [method: HTTPMethods, url: string, body?: unknown];

let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;
/** Alice's data, which Bob tries to reach. */
const A = { campaignId: "", accountEmail: "", leadId: "", leadEmail: "", listId: "", noteId: "", blockId: "", tagId: "", jobId: "" };

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner; Alice and Bob are ordinary accounts
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Alice Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Bob Co" });

  const c = alice.client;
  const campaign = json(await c.post("/api/app/campaigns", { name: "Alice's campaign" }));
  const account = json(await c.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0];
  json(await c.patch(`/api/v2/campaigns/${campaign.id}`, { email_list: [account.email] }));
  const lead = json(await c.post("/api/v2/leads", { email: "prospect@example.test", first_name: "Pat", campaign: campaign.id }));
  const list = json(await c.post("/api/v2/lead-lists", { name: "Alice's list" }));
  const note = json(await c.post("/api/app/lead-notes", { lead_email: lead.email, lead_id: lead.id, body: "Private note" }));
  const block = json(await c.post("/api/v2/block-lists-entries", { bl_value: "blocked@example.test" }));
  const tag = json(await c.post("/api/v2/custom-tags", { label: "Alice tag" }));
  const job = json(await c.post("/api/app/leads/export", { campaign: campaign.id }));
  Object.assign(A, {
    campaignId: campaign.id,
    accountEmail: account.email,
    leadId: lead.id,
    leadEmail: lead.email,
    listId: list.id,
    noteId: note.id,
    blockId: block.id,
    tagId: tag.id,
    jobId: job.id,
  });
});
after(stopServer);

/** Every attempt must be refused: 403/404 by default (`refusals` widens that, e.g. a 400 "Campaign not found"). */
async function expectRefused(client: TestClient, attempts: Attempt[], refusals = [403, 404]) {
  const failures: string[] = [];
  for (const [method, url, body] of attempts) {
    const res = await client.request(method, url, body ?? (method === "GET" || method === "DELETE" ? undefined : {}));
    if (!refusals.includes(res.statusCode)) failures.push(`${method} ${url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
  }
  assert.deepEqual(failures, []);
}

describe("another workspace's campaigns", () => {
  it("can't be read, changed, launched, copied or deleted by id", async () => {
    const id = A.campaignId;
    await expectRefused(bob.client, [
      ["GET", `/api/v2/campaigns/${id}`],
      ["PATCH", `/api/v2/campaigns/${id}`, { name: "Taken over" }],
      ["DELETE", `/api/v2/campaigns/${id}`],
      ["POST", `/api/v2/campaigns/${id}/activate`],
      ["POST", `/api/v2/campaigns/${id}/pause`],
      ["POST", `/api/v2/campaigns/${id}/share`],
      ["POST", `/api/v2/campaigns/${id}/duplicate`],
      ["POST", `/api/v2/campaigns/${id}/export`],
      ["POST", `/api/v2/campaigns/${id}/variables`, { variables: ["x"] }],
      ["GET", `/api/v2/campaigns/${id}/sending-status`],
      ["GET", `/api/app/campaigns/${id}/launch-check`],
      ["GET", `/api/app/campaigns/${id}/overview`],
      ["GET", `/api/app/campaigns/${id}/accounts`],
      ["POST", `/api/app/campaigns/${id}/preview`],
      ["POST", `/api/app/campaigns/${id}/test-email`, { to: "someone@example.test" }],
    ]);
    const still = json(await alice.client.get(`/api/v2/campaigns/${id}`));
    assert.equal(still.name, "Alice's campaign");
    assert.deepEqual(still.email_list, [A.accountEmail]);
  });

  it("don't show up in lists, analytics or bulk actions", async () => {
    assert.ok(!json(await bob.client.get("/api/v2/campaigns")).items.some((c: { id: string }) => c.id === A.campaignId));
    assert.ok(!json(await bob.client.get("/api/app/campaigns")).items.some((c: { id: string }) => c.id === A.campaignId));
    assert.deepEqual(json(await bob.client.get(`/api/v2/campaigns/analytics?id=${A.campaignId}`)), []);
    assert.equal(json(await bob.client.post("/api/app/campaigns/bulk", { ids: [A.campaignId], action: "delete" })).updated, 0);
    assert.equal(json(await bob.client.post("/api/app/campaigns/bulk", { ids: [A.campaignId], action: "pause" })).updated, 0);
    expectStatus(await alice.client.get(`/api/v2/campaigns/${A.campaignId}`), 200);
  });

  it("can only be copied once shared, and the copy never takes the sharer's mailboxes or leads", async () => {
    expectStatus(await bob.client.post(`/api/v2/campaigns/${A.campaignId}/from-export`), 404);
    expectStatus(await new TestClient(app).get(`/api/public/share/campaign/${A.campaignId}`), 404);

    expectStatus(await alice.client.post(`/api/v2/campaigns/${A.campaignId}/share`), 204);
    const page = await new TestClient(app).get(`/api/public/share/campaign/${A.campaignId}`);
    expectStatus(page, 200);
    assert.ok(!page.body.includes(A.accountEmail));
    assert.ok(!page.body.includes(A.leadEmail));

    const copy = json(await bob.client.post(`/api/v2/campaigns/${A.campaignId}/from-export`));
    assert.notEqual(copy.id, A.campaignId);
    assert.deepEqual(copy.email_list, []);
    assert.deepEqual(json(await bob.client.post("/api/v2/leads/list", { campaign: copy.id })).items, []);
    expectStatus(await alice.client.get(`/api/v2/campaigns/${copy.id}`), 404);
  });
});

describe("another workspace's leads", () => {
  it("can't be read, changed, merged or deleted by id", async () => {
    const own = json(await bob.client.post("/api/v2/leads", { email: "bobs-lead@example.test" }));
    await expectRefused(bob.client, [
      ["GET", `/api/v2/leads/${A.leadId}`],
      ["PATCH", `/api/v2/leads/${A.leadId}`, { first_name: "Taken" }],
      ["DELETE", `/api/v2/leads/${A.leadId}`],
      ["GET", `/api/app/leads/${A.leadId}/activity`],
      ["POST", "/api/v2/leads/merge", { lead_id: A.leadId, destination_lead_id: own.id }],
      ["POST", "/api/v2/leads/merge", { lead_id: own.id, destination_lead_id: A.leadId }],
      ["POST", "/api/v2/leads/subsequence/remove", { id: A.leadId }],
      ["POST", "/api/v2/leads/update-interest-status", { lead_email: A.leadEmail, interest_value: 1 }],
    ]);
    const lead = json(await alice.client.get(`/api/v2/leads/${A.leadId}`));
    assert.equal(lead.first_name, "Pat");
    assert.equal(lead.email, A.leadEmail);
  });

  it("don't show up in lists, searches or bulk actions", async () => {
    assert.deepEqual(json(await bob.client.post("/api/v2/leads/list", { campaign: A.campaignId })).items, []);
    assert.ok(!json(await bob.client.post("/api/v2/leads/list", {})).items.some((l: { id: string }) => l.id === A.leadId));
    assert.deepEqual(json(await bob.client.get(`/api/app/leads/by-email?email=${encodeURIComponent(A.leadEmail)}`)).items, []);
    assert.equal(json(await bob.client.post("/api/app/leads/delete", { ids: [A.leadId] })).count, 0);
    assert.equal(json(await bob.client.post("/api/app/leads/status", { ids: [A.leadId], action: "pause" })).affected, 0);
    expectStatus(await alice.client.get(`/api/v2/leads/${A.leadId}`), 200);
  });

  it("can't be added to, or moved into, another workspace's campaign or list", async () => {
    await expectRefused(
      bob.client,
      [
        ["POST", "/api/v2/leads", { email: "intruder@example.test", campaign: A.campaignId }],
        ["POST", "/api/v2/leads", { email: "intruder@example.test", list_id: A.listId }],
        ["POST", "/api/v2/leads/add", { campaign_id: A.campaignId, leads: [{ email: "intruder@example.test" }] }],
        ["POST", "/api/v2/leads/move", { contacts: ["bobs-lead@example.test"], to_campaign_id: A.campaignId }],
        ["POST", "/api/v2/leads/move", { contacts: ["bobs-lead@example.test"], to_list_id: A.listId }],
      ],
      [400, 403, 404],
    );
    assert.deepEqual(
      json(await alice.client.post("/api/v2/leads/list", { campaign: A.campaignId })).items.map((l: { email: string }) => l.email),
      [A.leadEmail],
    );
  });
});

describe("another workspace's email accounts", () => {
  it("can't be read, changed, paused, synced or deleted by address", async () => {
    const e = encodeURIComponent(A.accountEmail);
    await expectRefused(bob.client, [
      ["GET", `/api/v2/accounts/${e}`],
      ["PATCH", `/api/v2/accounts/${e}`, { first_name: "Taken" }],
      ["DELETE", `/api/v2/accounts/${e}`],
      ["POST", `/api/v2/accounts/${e}/pause`],
      ["POST", `/api/v2/accounts/${e}/resume`],
      ["POST", `/api/v2/accounts/${e}/mark-fixed`],
      ["GET", `/api/v2/account-campaign-mappings/${e}`],
      ["GET", `/api/app/accounts/${e}/campaigns`],
      ["GET", `/api/app/accounts/${e}/warmup-log`],
      ["POST", `/api/app/accounts/${e}/sync`],
      ["POST", `/api/app/accounts/${e}/reconnect`],
    ]);
    const account = json(await alice.client.get(`/api/v2/accounts/${e}`));
    assert.notEqual(account.first_name, "Taken");
    assert.equal(account.status, 1);
  });

  it("don't show up in lists, and bulk actions or moves can't reach them", async () => {
    assert.ok(!json(await bob.client.get("/api/v2/accounts")).items.some((a: { email: string }) => a.email === A.accountEmail));
    await expectRefused(bob.client, [
      ["POST", "/api/v2/accounts/move", { emails: [A.accountEmail], source_workspace_id: alice.workspaceId, destination_workspace_id: bob.workspaceId }],
    ]);
    for (const url of ["/api/app/accounts/bulk", "/api/v2/accounts/warmup/disable"]) {
      const res = await bob.client.post(url, { emails: [A.accountEmail], action: "pause" });
      expectStatus(res, 400, url);
    }
    // Bob can't push his own mailbox into Alice's workspace either.
    const mine = json(await bob.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0];
    await expectRefused(bob.client, [["POST", "/api/v2/accounts/move", { emails: [mine.email], source_workspace_id: bob.workspaceId, destination_workspace_id: alice.workspaceId }]]);
    const account = json(await alice.client.get(`/api/v2/accounts/${encodeURIComponent(A.accountEmail)}`));
    assert.equal(account.status, 1);
    assert.equal(account.organization, alice.workspaceId);
  });
});

describe("another workspace's lists, notes, block list, tags and jobs", () => {
  it("can't be read, changed or deleted by id", async () => {
    await expectRefused(bob.client, [
      ["GET", `/api/v2/lead-lists/${A.listId}`],
      ["PATCH", `/api/v2/lead-lists/${A.listId}`, { name: "Taken" }],
      ["DELETE", `/api/v2/lead-lists/${A.listId}`],
      ["PATCH", `/api/app/lead-notes/${A.noteId}`, { body: "Changed" }],
      ["DELETE", `/api/app/lead-notes/${A.noteId}`],
      ["GET", `/api/v2/block-lists-entries/${A.blockId}`],
      ["PATCH", `/api/v2/block-lists-entries/${A.blockId}`, { bl_value: "other@example.test" }],
      ["DELETE", `/api/v2/block-lists-entries/${A.blockId}`],
      ["GET", `/api/v2/custom-tags/${A.tagId}`],
      ["PATCH", `/api/v2/custom-tags/${A.tagId}`, { label: "Taken" }],
      ["DELETE", `/api/v2/custom-tags/${A.tagId}`],
      ["GET", `/api/v2/background-jobs/${A.jobId}`],
      ["POST", `/api/app/background-jobs/${A.jobId}/cancel`],
      ["GET", `/api/app/exports/${A.jobId}/download`],
    ]);
    const email = encodeURIComponent(A.leadEmail);
    assert.deepEqual(json(await bob.client.get(`/api/app/lead-notes?lead_email=${email}`)).items, []);
    assert.equal(json(await alice.client.get(`/api/app/lead-notes?lead_email=${email}`)).items[0].body, "Private note");
    assert.equal(json(await alice.client.get(`/api/v2/lead-lists/${A.listId}`)).name, "Alice's list");
    assert.equal(json(await alice.client.get(`/api/v2/block-lists-entries/${A.blockId}`)).bl_value, "blocked@example.test");
    assert.equal(json(await alice.client.get(`/api/v2/custom-tags/${A.tagId}`)).label, "Alice tag");
    assert.equal(json(await alice.client.get(`/api/v2/background-jobs/${A.jobId}`)).status, "pending");
  });

  it("tags stay in their workspace: theirs can't go on your things, nor yours on theirs", async () => {
    const mine = json(await bob.client.post("/api/app/campaigns", { name: "Bob's campaign" }));
    const bobTag = json(await bob.client.post("/api/v2/custom-tags", { label: "Bob tag" }));
    const refused = json(await bob.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [A.tagId], resource_type: 2, resource_ids: [mine.id], assign: true }), 400);
    assert.match(refused.message, /is not a tag in this workspace/);
    assert.match(json(await bob.client.post("/api/app/accounts/tags", { include_all_emails: true, tag_ids: [A.tagId], assign: true }), 400).message, /is not a tag in this workspace/);
    // Bob's own tag aimed at Alice's campaign changes nothing.
    json(await bob.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [bobTag.id], resource_type: 2, resource_ids: [A.campaignId, mine.id], assign: true }));
    const tagged = json(await bob.client.get(`/api/v2/custom-tag-mappings?resource_ids=${A.campaignId},${mine.id}`)).items.map((m: { resource_id: string }) => m.resource_id);
    assert.deepEqual(tagged, [mine.id]);
  });

  it("another workspace's jobs never show up in job lists, even when asked for by id", async () => {
    for (const q of [`ids=${A.jobId}`, `included_ids=${A.jobId}`, `entity_id=${A.campaignId}`]) {
      assert.ok(!json(await bob.client.get(`/api/v2/background-jobs?${q}`)).items.some((j: { id: string }) => j.id === A.jobId), q);
    }
  });
});

describe("choosing a workspace", () => {
  it("a workspace header naming someone else's workspace is ignored", async () => {
    const opts = { headers: { "x-workspace-id": alice.workspaceId! } };
    assert.equal(json(await bob.client.get("/api/app/auth/me", opts)).workspace.id, bob.workspaceId);
    assert.ok(!json(await bob.client.get("/api/v2/campaigns", opts)).items.some((c: { id: string }) => c.id === A.campaignId));
    expectStatus(await bob.client.get(`/api/v2/campaigns/${A.campaignId}`, opts), 404);
    expectStatus(await bob.client.patch(`/api/v2/campaigns/${A.campaignId}`, { name: "Taken" }, opts), 404);
  });

  it("switching to someone else's workspace is refused", async () => {
    expectStatus(await bob.client.post(`/api/app/workspaces/${alice.workspaceId}/switch`), 404);
    assert.equal(json(await bob.client.get("/api/app/auth/me")).workspace.id, bob.workspaceId);
  });

  it("an invitation only works for the address it was sent to", async () => {
    const invite = json(await alice.client.post("/api/v2/workspace-members", { email: uniqueEmail("invitee"), role: "view" }));
    const token = new URL(invite.invite_url).searchParams.get("token")!;
    expectStatus(await bob.client.post(`/api/app/invitations/${encodeURIComponent(token)}/accept`), 403);
    expectStatus(await bob.client.post(`/api/app/workspaces/${alice.workspaceId}/switch`), 404);
  });

  it("a workspace's members are only listed to that workspace", async () => {
    const members = await bob.client.get("/api/v2/workspace-members");
    expectStatus(members, 200);
    assert.ok(!members.body.includes(alice.email));
  });
});

describe("roles inside a shared workspace", () => {
  async function join(role: "view" | "editor" | "admin") {
    const person = await signUp(app);
    const invite = json(await alice.client.post("/api/v2/workspace-members", { email: person.email, role }));
    const token = new URL(invite.invite_url).searchParams.get("token")!;
    json(await person.client.post(`/api/app/invitations/${encodeURIComponent(token)}/accept`));
    const me = json(await person.client.get("/api/app/auth/me"));
    assert.equal(me.workspace.id, alice.workspaceId);
    assert.equal(me.membership.role, role);
    return { ...person, memberId: invite.id as string };
  }

  it("a view member can look but not change anything, and loses access once removed", async () => {
    const viewer = await join("view");
    expectStatus(await viewer.client.get(`/api/v2/campaigns/${A.campaignId}`), 200);
    await expectRefused(viewer.client, [
      ["PATCH", `/api/v2/campaigns/${A.campaignId}`, { name: "Viewer edit" }],
      ["POST", "/api/app/campaigns", { name: "Viewer campaign" }],
      ["DELETE", `/api/v2/leads/${A.leadId}`],
      ["POST", "/api/v2/api-keys", { name: "viewer key", scopes: ["all:all"] }],
      ["POST", "/api/v2/workspace-members", { email: uniqueEmail(), role: "admin" }],
      ["PATCH", `/api/v2/workspace-members/${viewer.memberId}`, { role: "admin" }],
      ["GET", "/api/app/billing/overview"],
    ]);
    expectStatus(await alice.client.delete(`/api/v2/workspace-members/${viewer.memberId}`), 200);
    assert.notEqual(json(await viewer.client.get("/api/app/auth/me")).workspace?.id, alice.workspaceId);
    expectStatus(await viewer.client.get(`/api/v2/campaigns/${A.campaignId}`), 404);
  });

  it("an editor works on campaigns but can't manage the team, keys, billing or the workspace", async () => {
    const editor = await join("editor");
    const renamed = json(await editor.client.patch(`/api/v2/campaigns/${A.campaignId}`, { name: "Alice's campaign" }));
    assert.equal(renamed.name, "Alice's campaign");
    await expectRefused(editor.client, [
      ["POST", "/api/v2/api-keys", { name: "editor key", scopes: ["all:all"] }],
      ["GET", "/api/v2/api-keys"],
      ["POST", "/api/v2/workspace-members", { email: uniqueEmail(), role: "admin" }],
      ["GET", "/api/app/billing/overview"],
      ["PATCH", "/api/app/workspaces/current/security", { require_2fa: false }],
      ["DELETE", "/api/app/workspaces/current", { confirm_name: "Alice Co" }],
    ]);
    expectStatus(await alice.client.get("/api/app/auth/me"), 200);
  });

  it("a workspace admin can't demote or remove the workspace owner", async () => {
    const admin = await join("admin");
    const members = json(await admin.client.get("/api/v2/workspace-members")).items as Array<{ id: string; role: string }>;
    const ownerMember = members.find((m) => m.role === "owner")!;
    expectStatus(await admin.client.patch(`/api/v2/workspace-members/${ownerMember.id}`, { role: "view" }), 400);
    expectStatus(await admin.client.delete(`/api/v2/workspace-members/${ownerMember.id}`), 400);
    expectStatus(await admin.client.delete("/api/app/workspaces/current", { confirm_name: "Alice Co" }), 403);
    assert.equal(json(await alice.client.get("/api/app/auth/me")).membership.role, "owner");
  });
});
