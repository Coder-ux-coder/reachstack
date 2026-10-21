// Task steps: a LinkedIn visit, invitation or message, a call, or anything else done by hand. A lead that reaches one
// gets a task (Today, and CRM → Tasks) and waits for it; Done or Skip moves it on. Mail goes through a sandbox mailbox,
// so nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EmailType, LeadStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { runSequenceTasks } from "../src/services/sequence-tasks";
import { summarizeSequence } from "../src/services/sequence-versions";
import { enrollInSubsequence } from "../src/services/subsequences";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const FIRST = "<p>Hello {{firstName}}, a quick question about your pricing page. If it isn't for you, just say and I'll stop emailing you.</p>";
const email = (subject: string, body: string, delay = 0) => ({ type: "email", delay, delay_unit: "days", variants: [{ subject, body }] });
const task = (kind: string, subject = "", body = "", delay = 0) => ({ type: "task", task: kind, delay, delay_unit: "days", variants: [{ subject, body }] });

const L = schema.leads;
const T = schema.crmTasks;
const E = schema.emailEvents;

let app: FastifyInstance;
let user: TestUser;
let other: TestUser;
let sender: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Tasks Co" });
  other = await signUp(app, { firstName: "Kim", workspaceName: "Elsewhere" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  // No pause between this mailbox's emails, so each sender pass can send.
  await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, sender));
});
after(stopServer);

const PAT = { email: "pat@tasks-acme.test", first_name: "Pat", last_name: "Doe", company_name: "Acme", linkedin_url: "https://www.linkedin.com/in/pat-doe", phone: "+14155550123" };

async function campaign(name: string, steps: unknown[], leads: Array<Record<string, unknown>> = [PAT]) {
  const c = user.client;
  const created = json(await c.post("/api/app/campaigns", { name }));
  json(await c.patch(`/api/v2/campaigns/${created.id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps }] }));
  for (const lead of leads) json(await c.post("/api/v2/leads", { ...lead, campaign: created.id }));
  expectStatus(await c.post(`/api/v2/campaigns/${created.id}/activate`), 200);
  return created.id as string;
}

const leadOf = async (campaignId: string, address = PAT.email) => (await db.select().from(L).where(and(eq(L.campaignId, campaignId), eq(L.email, address))))[0]!;
const sends = (leadId: string) => db.select().from(schema.emails).where(and(eq(schema.emails.leadId, leadId), eq(schema.emails.ueType, EmailType.CAMPAIGN_SENT)));
const tasksOf = (leadId: string) => db.select().from(T).where(eq(T.leadId, leadId));
/** The lead's next step comes due now. */
const dueNow = (leadId: string) => db.update(L).set({ nextSendAt: Date.now() - 1000 }).where(eq(L.id, leadId));

/** Runs the sender until the lead has `count` campaign emails (each pass sends one email per mailbox). */
async function sendUntil(leadId: string, count: number) {
  for (let i = 0; i < 10 && (await sends(leadId)).length < count; i++) await runSender();
  assert.equal((await sends(leadId)).length, count, "campaign emails sent");
}

describe("a sequence with task steps", () => {
  it("starts with an email, and says what each task needs before it launches", async () => {
    const c = user.client;
    const id = json(await c.post("/api/app/campaigns", { name: "Task first" })).id as string;
    const first = json(await c.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [task("call"), email("Hi", FIRST)] }] }), 400);
    assert.match(first.message, /starts with an email/);
    json(await c.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [email("Hi", FIRST), { type: "task", delay: 1, variants: [{ subject: "", body: "" }] }] }] }), 400);

    json(await c.patch(`/api/v2/campaigns/${id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, sequences: [{ steps: [email("Hi {{firstName}}", FIRST), task("todo"), task("linkedin_message")] }] }));
    const refused = json(await c.post(`/api/v2/campaigns/${id}/activate`), 400);
    assert.deepEqual(refused.details.problems, ["Step 2 is a task without a title. Say what to do.", "Step 3 needs the message to send on LinkedIn."]);

    // A subsequence may start with one: "Interested → call them".
    const sub = json(await c.post("/api/v2/subsequences", { parent_campaign: id, name: "Call them", conditions: { crm_status: [1] }, sequences: [{ steps: [task("call")] }] }));
    assert.equal(sub.sequences[0].steps[0].task, "call");
  });

  it("reads as emails and tasks in the sequence's versions", () => {
    const summary = (steps: unknown[]) => summarizeSequence([{ steps }] as never).summary;
    assert.equal(summary([email("Hi", FIRST), task("call"), task("todo", "Send the deck")]), "3 steps: 1 email, 2 tasks");
    assert.equal(summary([{ ...email("Hi", FIRST), variants: [{ subject: "A", body: "a" }, { subject: "B", body: "b" }] }, task("call")]), "2 steps: 1 email (2 variants), 1 task");
    assert.equal(summary([email("Hi", FIRST), email("", "<p>Again.</p>")]), "2 steps, 2 variants");
  });

  it("gives a lead that reaches one its task, and holds the next emails until it's done", async () => {
    const id = await campaign("Email, invite, email", [email("Hi {{firstName}}", FIRST), task("linkedin_connect", "", "Hi {{firstName}}, I wrote to you about {{companyName}}'s pricing page."), email("", "<p>Following up, {{firstName}}.</p>")]);
    const lead = await leadOf(id);
    await sendUntil(lead.id, 1);
    await dueNow(lead.id);
    await runSender();
    assert.equal((await sends(lead.id)).length, 1, "a task step sends nothing");

    await runSequenceTasks();
    await runSequenceTasks();
    const tasks = await tasksOf(lead.id);
    assert.equal(tasks.length, 1, "one task, however often the engine looks");
    const [t] = tasks;
    assert.deepEqual(
      [t!.title, t!.description, t!.type, t!.source, t!.status, t!.step, t!.stepKind, t!.campaignId],
      ["Connect with Pat Doe on LinkedIn", "Hi Pat, I wrote to you about Acme's pricing page.", "linkedin", "sequence", "open", 1, "linkedin_connect", id],
    );
    const waiting = await leadOf(id);
    assert.deepEqual([waiting.nextStep, waiting.nextSendAt, waiting.status], [1, null, LeadStatus.ACTIVE]);
    // Nothing's wrong with the campaign: it's waiting for the task.
    const status = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.deepEqual([status.summary.title, status.summary.waiting_for_tasks, status.diagnostics.leads.waiting_for_tasks], ["Waiting for your tasks", true, 1]);
    assert.match(status.summary.reasons[0], /^1 lead waits for a task you do by hand: find it on Today\./);
    for (let i = 0; i < 3; i++) await runSender();
    assert.equal((await sends(lead.id)).length, 1, "the next email waits for the task");

    const list = json(await user.client.get("/api/app/sequence-tasks"));
    assert.equal(list.total, 1);
    assert.deepEqual([list.items[0].kind, list.items[0].step, list.items[0].campaign.name, list.items[0].lead.linkedin_url, list.items[0].lead.name], ["linkedin_connect", 2, "Email, invite, email", PAT.linkedin_url, "Pat Doe"]);
    assert.equal(json(await user.client.get("/api/app/sequence-tasks/count")).open, 1);
    assert.equal(json(await other.client.get("/api/app/sequence-tasks")).total, 0);
    expectStatus(await other.client.post(`/api/app/sequence-tasks/${t!.id}/done`), 404);

    assert.deepEqual(json(await user.client.post(`/api/app/sequence-tasks/${t!.id}/done`)), { moved: true, finished: false });
    expectStatus(await user.client.post(`/api/app/sequence-tasks/${t!.id}/done`), 409);
    const moved = await leadOf(id);
    assert.equal(moved.nextStep, 2);
    assert.ok(moved.nextSendAt !== null && moved.nextSendAt <= Date.now(), "the next step comes after the task's wait (none here)");
    const [done] = await db.select().from(E).where(and(eq(E.leadId, lead.id), eq(E.type, "task_done")));
    assert.deepEqual([done!.step, done!.detail], [1, "Connect with Pat Doe on LinkedIn"]);

    await sendUntil(lead.id, 2);
    assert.equal((await leadOf(id)).status, LeadStatus.COMPLETED);
    const steps = json<Array<{ step: string; sent: number; tasks_done: number }>>(await user.client.get(`/api/v2/campaigns/analytics/steps?campaign_id=${id}`));
    assert.deepEqual(
      steps.map((s) => [s.step, s.sent, s.tasks_done]),
      [
        ["0", 1, 0],
        ["1", 0, 1],
        ["2", 1, 0],
      ],
    );
  });

  it("can be skipped, and is put away when its lead stops waiting", async () => {
    const jo = { email: "jo@tasks-skip.test", first_name: "Jo" };
    const id = await campaign("Email, call, email", [email("Hi {{firstName}}", FIRST), task("call", "Call {{firstName}} about pricing", "Ask about the pricing page."), email("", "<p>Following up.</p>")], [PAT, jo]);
    const pat = await leadOf(id);
    const joLead = await leadOf(id, jo.email);
    await sendUntil(pat.id, 1);
    await sendUntil(joLead.id, 1);
    await dueNow(pat.id);
    await dueNow(joLead.id);
    await runSequenceTasks();
    const [patTask] = await tasksOf(pat.id);
    const [joTask] = await tasksOf(joLead.id);
    assert.equal(patTask!.title, "Call Pat about pricing");

    // Deleting it from the CRM skips it: the lead would otherwise wait forever.
    expectStatus(await user.client.delete(`/api/app/crm/tasks/${patTask!.id}`), 200);
    assert.equal((await leadOf(id)).nextStep, 2);
    assert.equal((await db.select().from(E).where(and(eq(E.leadId, pat.id), eq(E.type, "task_skipped")))).length, 1);

    // Jo replied meanwhile (the campaign stops on replies): nobody needs that call any more.
    await db.update(L).set({ status: LeadStatus.COMPLETED }).where(eq(L.id, joLead.id));
    await runSequenceTasks();
    const [putAway] = await tasksOf(joLead.id);
    assert.ok(putAway!.archivedAt, "put away");
    assert.equal(json(await user.client.get("/api/app/sequence-tasks")).items.filter((i: { id: string }) => i.id === joTask!.id).length, 0);
    expectStatus(await user.client.post(`/api/app/sequence-tasks/${joTask!.id}/skip`), 409);
  });

  it("shows up in the CRM's inbox, and once skipped in its archive, where it stays", async () => {
    const visited = { ...PAT, email: "pat@tasks-archive.test" };
    const id = await campaign("Visit, then email", [email("Hi {{firstName}}", FIRST), task("linkedin_visit"), email("", "<p>Following up.</p>")], [visited]);
    const lead = await leadOf(id, visited.email);
    await sendUntil(lead.id, 1);
    await dueNow(lead.id);
    await runSequenceTasks();
    const [t] = await tasksOf(lead.id);
    const feed = async (view: string) => json<{ items: Array<{ id: string; status: string; meta: { overdue: boolean; source: string } }> }>(await user.client.get(`/api/app/crm/feed?view=${view}&type=task`)).items.filter((i) => i.id === t!.id);
    const [inInbox] = await feed("inbox");
    assert.deepEqual([inInbox?.status, inInbox?.meta.overdue, inInbox?.meta.source], ["open", false, "sequence"]);
    assert.equal(json(await user.client.get("/api/app/crm/counts")).inbox.task >= 1, true);

    json(await user.client.post(`/api/app/sequence-tasks/${t!.id}/skip`));
    assert.equal((await feed("inbox")).length, 0);
    const [archived] = await feed("archive");
    assert.equal(archived?.status, "skipped");
    // Back to the inbox: not for a sequence's task, whose lead has moved on.
    json(await user.client.post("/api/app/crm/feed/inbox", { items: [{ type: "task", id: t!.id }] }));
    assert.equal((await db.select().from(T).where(eq(T.id, t!.id)))[0]!.status, "skipped");
    assert.equal(json(await user.client.get("/api/app/crm/tasks?status=skipped")).items.some((i: { id: string }) => i.id === t!.id), true);
  });

  it("lets a waiting lead carry on when its step stops being a task", async () => {
    const id = await campaign("Call turned email", [email("Hi {{firstName}}", FIRST), task("call"), email("", "<p>Following up.</p>")]);
    const lead = await leadOf(id);
    await sendUntil(lead.id, 1);
    await dueNow(lead.id);
    await runSequenceTasks();
    assert.equal((await tasksOf(lead.id)).length, 1);

    json(await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [email("Hi {{firstName}}", FIRST), email("", "<p>Instead of calling: a second email.</p>"), email("", "<p>Following up.</p>")] }] }));
    await runSequenceTasks();
    const [t] = await tasksOf(lead.id);
    assert.ok(t!.archivedAt, "the task for a step that isn't one any more is put away");
    const freed = await leadOf(id);
    assert.ok(freed.nextSendAt !== null && freed.nextSendAt <= Date.now());
    await sendUntil(lead.id, 2);
  });

  it("goes to the campaign's owner when the lead's owner has left the workspace", async () => {
    const lee = await signUp(app, { firstName: "Lee" });
    const invite = json(await user.client.post("/api/v2/workspace-members", { email: lee.email, role: "editor" }));
    json(await lee.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));
    const kept = { ...PAT, email: "pat@tasks-owner.test" };
    const id = await campaign("Call after a teammate left", [email("Hi {{firstName}}", FIRST), task("call")], [kept]);
    const lead = await leadOf(id, kept.email);
    json(await user.client.patch(`/api/v2/leads/${lead.id}`, { assigned_to: lee.id }));
    expectStatus(await user.client.delete(`/api/v2/workspace-members/${invite.id}`), 200);
    await sendUntil(lead.id, 1);
    await dueNow(lead.id);
    await runSequenceTasks();
    const [t] = await tasksOf(lead.id);
    // Not to Lee, who'd never see it; the lead stays Lee's for the record.
    assert.equal(t!.assignedTo, user.id);
    assert.equal((await leadOf(id, kept.email)).assignedTo, lee.id);
  });

  it("makes the task again for a lead left waiting without one", async () => {
    const id = await campaign("Deck", [email("Hi {{firstName}}", FIRST), task("todo", "Send {{firstName}} the deck")]);
    const lead = await leadOf(id);
    await sendUntil(lead.id, 1);
    await dueNow(lead.id);
    await runSequenceTasks();
    const [first] = await tasksOf(lead.id);
    assert.equal(first!.title, "Send Pat the deck");
    // Lost, say, when the lead was deleted and restored from Recently deleted.
    await db.delete(T).where(eq(T.id, first!.id));
    await runSequenceTasks();
    const again = await tasksOf(lead.id);
    assert.equal(again.length, 1);
    assert.notEqual(again[0]!.id, first!.id);
    // The last step done: the lead has finished the sequence.
    assert.deepEqual(json(await user.client.post(`/api/app/sequence-tasks/${again[0]!.id}/done`)), { moved: true, finished: true });
    const finished = await leadOf(id);
    assert.deepEqual([finished.status, finished.nextSendAt], [LeadStatus.COMPLETED, null]);
  });
});

describe("a subsequence that starts with a call", () => {
  it("gives the lead its task when it moves in, and the CRM's Done moves it on", async () => {
    const id = await campaign("Interested leads get a call", [email("Hi {{firstName}}", FIRST)]);
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Call them", conditions: { crm_status: [1] }, sequences: [{ steps: [task("call"), email("", "<p>Thanks for the call, {{firstName}}.</p>")] }] }));
    expectStatus(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`), 200);
    const lead = await leadOf(id);
    await sendUntil(lead.id, 1);
    // Marked interested after the campaign finished: the subsequence takes the lead in.
    const [row] = await db.select().from(schema.subsequences).where(eq(schema.subsequences.id, sub.id));
    await enrollInSubsequence(lead, row!);
    await runSequenceTasks();
    const [t] = await tasksOf(lead.id);
    assert.deepEqual([t!.title, t!.type, t!.subsequenceId, t!.step], ["Call Pat Doe", "call", sub.id, 0]);
    assert.equal((await leadOf(id)).subseqNextSendAt, null);

    const crm = json(await user.client.get(`/api/app/crm/tasks/${t!.id}`));
    assert.deepEqual([crm.source, crm.step, crm.step_kind, crm.subsequence_id], ["sequence", 1, "call", sub.id]);
    // What calling them takes, and where the task came from.
    assert.deepEqual([crm.lead_name, crm.lead_phone, crm.lead_linkedin_url, crm.campaign_name, crm.subsequence_name], ["Pat Doe", PAT.phone, PAT.linkedin_url, "Interested leads get a call", "Call them"]);
    // Due when the lead got there, but not overdue until it has waited a day.
    assert.equal(crm.overdue, false);
    await db.update(T).set({ dueAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(T.id, t!.id));
    assert.equal(json(await user.client.get(`/api/app/crm/tasks/${t!.id}`)).overdue, true);
    expectStatus(await user.client.patch(`/api/app/crm/tasks/${t!.id}`, { lead_email: "someone@else.test" }), 400);
    json(await user.client.patch(`/api/app/crm/tasks/${t!.id}`, { status: "done" }));
    const moved = await leadOf(id);
    assert.equal(moved.subseqNextStep, 1);
    expectStatus(await user.client.patch(`/api/app/crm/tasks/${t!.id}`, { status: "open" }), 409);
    await sendUntil(lead.id, 2);
    const [followUp] = (await sends(lead.id)).filter((e) => e.subsequenceId === sub.id);
    assert.equal(followUp!.step, "1");
  });
});
