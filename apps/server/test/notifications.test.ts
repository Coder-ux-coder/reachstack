// The notification center (services/notifications.ts, routes/notifications.ts), due reminders and tasks
// (services/reminders.ts), the send watchdog (services/watchdog.ts) and system health (services/health.ts).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CampaignNotSendingStatus, CampaignStatus, EmailType, InterestStatus, VerificationStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { setInterestStatus } from "../src/services/activity";
import { emit } from "../src/services/bus";
import * as notifications from "../src/services/notifications";
import { campaignLink } from "../src/services/notifications";
import { runReminders } from "../src/services/reminders";
import { systemMailLog } from "../src/services/system-mail";
import { runWatchdog } from "../src/services/watchdog";

const N = schema.notifications;
const HOUR = 3_600_000;
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });

let app: FastifyInstance;
let installOwner: TestUser;
let alice: TestUser;
let bob: TestUser;
let viewer: TestUser;
let ws: string;
let sender: string;

before(async () => {
  app = await startServer();
  installOwner = await signUp(app, { firstName: "Olive" });
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Alpha" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Beta" });
  ws = alice.workspaceId!;
  // A "view" member of Alpha: sees campaigns, the Unibox and email accounts, but not the CRM.
  viewer = await signUp(app, { firstName: "Vic" });
  const invite = json(await alice.client.post("/api/v2/workspace-members", { email: viewer.email, role: "view" }));
  json(await viewer.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));
  assert.equal(json(await viewer.client.get("/api/app/auth/me")).workspace.id, ws);
  sender = json(await alice.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

// ---------- Helpers ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bus listeners run after the emitter returns: wait until the check passes. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string): Promise<T> {
  const end = Date.now() + 3_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}: ${JSON.stringify(v)}`);
    await sleep(20);
  }
}

const rows = (type: string, link?: string, workspaceId = ws) =>
  db
    .select()
    .from(N)
    .where(and(eq(N.workspaceId, workspaceId), eq(N.type, type), link ? eq(N.link, link) : undefined));

const recipients = async (type: string, link?: string) => (await rows(type, link)).map((r) => r.userId).sort();
const both = () => [alice.id, viewer.id].sort();

async function campaign(name: string, leads: string[], patch: Record<string, unknown> = {}) {
  const c = alice.client;
  const created = json(await c.post("/api/app/campaigns", { name }));
  json(await c.patch(`/api/v2/campaigns/${created.id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, sequences: [{ steps: [step("Hi {{firstName}}", "<p>Hello {{firstName}}</p>")] }], ...patch }));
  for (const email of leads) json(await c.post("/api/v2/leads", { email, first_name: "Pat", last_name: "Lee", campaign: created.id }));
  return created.id as string;
}

async function launch(id: string) {
  expectStatus(await alice.client.post(`/api/v2/campaigns/${id}/activate`), 200);
  await sleep(30); // the status-change listeners
}

const notSending = async (id: string) => json(await alice.client.get(`/api/v2/campaigns/${id}`)).not_sending_status as number | null;

// ---------- Events ----------

describe("notifications from events", () => {
  it("a mailbox that keeps failing makes one notification per person", async () => {
    const event = { email: sender, error: "Username and password not accepted", code: "auth", kind: "smtp" };
    emit("account_error", ws, event);
    emit("account_error", ws, event);
    const link = `/app/accounts?account=${encodeURIComponent(sender)}`;
    await until(() => recipients("account_error", link), (r) => r.length === 2, "account_error");
    assert.deepEqual(await recipients("account_error", link), both());
    const [first] = await rows("account_error", link);
    assert.equal(first!.title, `${sender} can't sign in`);
    assert.match(first!.body!, /^Username and password not accepted\. Campaigns skip it/);

    // Flapping: more failures, read or not, add nothing for a while.
    await db.update(N).set({ readAt: new Date() }).where(and(eq(N.workspaceId, ws), eq(N.type, "account_error")));
    emit("account_error", ws, { ...event, code: "connection", error: "Connection timed out" });
    await sleep(150);
    assert.equal((await rows("account_error", link)).length, 2);
  });

  it("bounce protection and a finished campaign tell the people who can see campaigns", async () => {
    const id = await campaign("Spring outreach", []);
    emit("campaign_status_changed", ws, { campaign_id: id, status: CampaignStatus.BOUNCE_PROTECT, previous: CampaignStatus.ACTIVE });
    emit("campaign_status_changed", ws, { campaign_id: id, status: CampaignStatus.BOUNCE_PROTECT, previous: CampaignStatus.ACTIVE });
    await until(() => recipients("bounce_protect", campaignLink(id)), (r) => r.length === 2, "bounce_protect");
    await sleep(100);
    assert.deepEqual(await recipients("bounce_protect", campaignLink(id)), both());
    assert.equal((await rows("bounce_protect", campaignLink(id)))[0]!.title, "“Spring outreach” paused: too many bounces");

    emit("campaign_completed", ws, { campaign_id: id });
    await until(() => recipients("campaign_completed", campaignLink(id)), (r) => r.length === 2, "campaign_completed");
    assert.equal((await rows("campaign_completed", campaignLink(id)))[0]!.title, "“Spring outreach” finished");
    // Not addressed to anyone outside the workspace.
    assert.equal((await rows("campaign_completed", undefined, bob.workspaceId!)).length, 0);
  });

  it("a reply labelled positive notifies, a label set by hand doesn't", async () => {
    const id = await campaign("Labels", ["glad@example.test", "manual@example.test"]);
    const leads = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    const glad = leads.find((l) => l.email === "glad@example.test")!;
    const manual = leads.find((l) => l.email === "manual@example.test")!;
    await setInterestStatus({ workspaceId: ws, leadIds: [glad.id], value: InterestStatus.INTERESTED, source: "ai" });
    await setInterestStatus({ workspaceId: ws, leadIds: [manual.id], value: InterestStatus.INTERESTED, source: "user" });
    const found = await until(() => rows("positive_reply"), (r) => r.length >= 2, "positive_reply");
    await sleep(100);
    assert.deepEqual(
      (await rows("positive_reply")).map((r) => r.userId).sort(),
      both(),
      "one per person, for the AI-labelled reply only",
    );
    assert.equal(found[0]!.title, "Positive reply from Pat Lee");
    assert.match(found[0]!.body!, /^Marked “Interested” in Labels\.$/);
  });
});

describe("repeats and emails", () => {
  it("a mailbox's failure is news again to whoever read the last one, even while someone else hasn't", async () => {
    const event = { email: "flaky.box@example.test", error: "Connection timed out", code: "connection", kind: "smtp" };
    const link = `/app/accounts?account=${encodeURIComponent(event.email)}`;
    emit("account_error", ws, event);
    await until(() => recipients("account_error", link), (r) => r.length === 2, "the first failure");
    // Alice read hers, Vic didn't; half a day later it fails again.
    await db.update(N).set({ readAt: new Date() }).where(and(eq(N.link, link), eq(N.userId, alice.id)));
    await db.update(N).set({ createdAt: new Date(Date.now() - 13 * HOUR) }).where(eq(N.link, link));
    emit("account_error", ws, event);
    await until(() => rows("account_error", link), (r) => r.length === 3, "the second failure");
    await sleep(100);
    const all = await rows("account_error", link);
    assert.equal(all.filter((r) => r.userId === alice.id && !r.readAt).length, 1, "Alice hears of it again");
    assert.equal(all.filter((r) => r.userId === viewer.id).length, 1, "Vic still has his unread one");
  });

  it("positive replies by email: none for a label set by hand, one per person, and a burst in one email", async () => {
    await notifications.sendGathered(ws); // whatever an earlier test left gathering goes out first
    const first = await campaign("Burst", ["burst1@example.test", "burst2@example.test", "burst3@example.test", "burst4@example.test"]);
    const again = await campaign("Burst again", ["burst1@example.test"]);
    const leads = await db.select().from(schema.leads).where(inArray(schema.leads.campaignId, [first, again]));
    const ids = (email: string) => leads.filter((l) => l.email === email).map((l) => l.id);
    const since = new Date().toISOString();
    const mails = () => systemMailLog.filter((m) => m.at >= since && m.to === alice.email && /positive repl/i.test(m.subject));

    await setInterestStatus({ workspaceId: ws, leadIds: ids("burst4@example.test"), value: InterestStatus.INTERESTED, source: "user" });
    await setInterestStatus({ workspaceId: ws, leadIds: [...ids("burst1@example.test"), ...ids("burst2@example.test"), ...ids("burst3@example.test")], value: InterestStatus.INTERESTED, source: "api" });
    await until(async () => mails(), (m) => m.length >= 1, "the first email");
    await sleep(150);
    assert.deepEqual(mails().map((m) => m.subject), ["Positive reply: burst1@example.test"], "the first goes out at once, the rest wait");

    await notifications.sendGathered(ws);
    const sent = mails().reverse();
    assert.deepEqual(sent.map((m) => m.subject), ["Positive reply: burst1@example.test", "2 positive replies in Alpha"]);
    assert.match(sent[1]!.text, /burst2@example\.test: Interested\nburst3@example\.test: Interested/);
    assert.ok(!sent.some((m) => m.text.includes("burst4@example.test")), "a label set by hand isn't emailed");
  });

  it("emails go to the owner and admins whose accounts still work", async () => {
    const ada = await signUp(app, { firstName: "Ada" });
    const invite = json(await alice.client.post("/api/v2/workspace-members", { email: ada.email, role: "admin" }));
    json(await ada.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, ada.id));
    try {
      await notifications.sendGathered(ws);
      await notifications.sendGathered(ws); // the window the last email opened closes empty
      const id = await campaign("Admins only", ["admins@example.test"]);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
      const since = new Date().toISOString();
      await setInterestStatus({ workspaceId: ws, leadIds: [lead!.id], value: InterestStatus.INTERESTED, source: "ai" });
      const sent = () => systemMailLog.filter((m) => m.at >= since && m.subject === "Positive reply: admins@example.test");
      await until(async () => sent(), (m) => m.length >= 1, "the email");
      await sleep(100);
      assert.deepEqual(sent().map((m) => m.to), [alice.email]);
    } finally {
      // The tests after this one count who's in the workspace.
      await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, ws), eq(schema.workspaceMembers.userId, ada.id)));
      await db.update(schema.users).set({ disabledAt: null }).where(eq(schema.users.id, ada.id));
    }
  });
});

// ---------- The list ----------

describe("the notification list", () => {
  it("is newest first with an unread count, and marks one or all read for that person only", async () => {
    const page = json(await alice.client.get("/api/app/notifications"));
    assert.ok(page.items.length >= 4);
    assert.equal(page.unread, page.items.filter((n: { read: boolean }) => !n.read).length);
    const ids = page.items.map((n: { id: string }) => n.id);
    assert.deepEqual(ids, [...ids].sort().reverse(), "newest first");

    // Paging: the last id of a page continues the list.
    const one = json(await alice.client.get("/api/app/notifications?limit=1"));
    assert.equal(one.items.length, 1);
    assert.equal(one.next_before, one.items[0].id);
    const next = json(await alice.client.get(`/api/app/notifications?limit=1&before=${one.next_before}`));
    assert.equal(next.items[0].id, ids[1]);

    const target = page.items.find((n: { read: boolean }) => !n.read);
    const marked = json(await alice.client.post(`/api/app/notifications/${target.id}/read`));
    assert.equal(marked.unread, page.unread - 1);
    const unreadOnly = json(await alice.client.get("/api/app/notifications?unread=true"));
    assert.ok(unreadOnly.items.every((n: { read: boolean; id: string }) => !n.read && n.id !== target.id));

    // The viewer's copy of the same news is still unread.
    const viewerBefore = json(await viewer.client.get("/api/app/notifications")).unread;
    assert.ok(viewerBefore > 0);
    assert.deepEqual(json(await alice.client.post("/api/app/notifications/read-all")).unread, 0);
    assert.equal(json(await alice.client.get("/api/app/notifications")).unread, 0);
    assert.equal(json(await viewer.client.get("/api/app/notifications")).unread, viewerBefore);
  });

  it("never shows or touches another workspace's notifications", async () => {
    const theirs = json(await bob.client.get("/api/app/notifications"));
    assert.deepEqual(theirs.items, []);
    assert.equal(theirs.unread, 0);
    const [aliceRow] = await rows("campaign_completed");
    expectStatus(await bob.client.post(`/api/app/notifications/${aliceRow!.id}/read`), 404);
    // Nor another person's in the same workspace.
    const [viewerRow] = (await rows("campaign_completed")).filter((r) => r.userId === viewer.id);
    expectStatus(await alice.client.post(`/api/app/notifications/${viewerRow!.id}/read`), 404);
    expectStatus(await bob.client.post("/api/app/notifications/read-all"), 200);
    const [still] = await db.select().from(N).where(eq(N.id, viewerRow!.id));
    assert.equal(still!.readAt, null);
  });
});

// ---------- Reminders ----------

describe("reminders", () => {
  async function conversation(thread: string, lead: string, reminderAt: Date | null) {
    const base = { workspaceId: ws, threadId: thread, leadEmail: lead, eaccount: sender, subject: "Pricing question" };
    await db.insert(schema.emails).values([
      { ...base, messageId: `<${thread}-in@example.test>`, ueType: EmailType.RECEIVED, timestampEmail: new Date(Date.now() - 2 * HOUR), archived: true, isUnread: 0 },
      { ...base, messageId: `<${thread}-out@example.test>`, ueType: EmailType.SENT, timestampEmail: new Date(Date.now() - HOUR), reminderAt },
    ]);
  }

  it("a due follow-up reminder brings the conversation back unread and notifies the lead's owner once", async () => {
    const id = await campaign("Reminder lead", ["remind@example.test"]);
    await db.update(schema.leads).set({ assignedTo: viewer.id }).where(eq(schema.leads.campaignId, id));
    await conversation("thread-remind-1", "remind@example.test", new Date(Date.now() - 60_000));
    await runReminders();
    await runReminders();
    const link = "/app/unibox?folder=reminders&thread=thread-remind-1";
    assert.deepEqual(await recipients("reminder_due", link), [viewer.id]);
    const [n] = await rows("reminder_due", link);
    assert.equal(n!.title, "Follow up with Pat Lee");
    assert.equal(n!.body, "Your reminder on “Pricing question” is due.");
    const [received] = await db
      .select()
      .from(schema.emails)
      .where(and(eq(schema.emails.threadId, "thread-remind-1"), eq(schema.emails.ueType, EmailType.RECEIVED)));
    assert.equal(received!.archived, false);
    assert.equal(received!.isUnread, 1);
  });

  it("a reminder on a conversation nobody owns goes to everyone who can open the Unibox", async () => {
    await conversation("thread-remind-3", "nobody@example.test", new Date(Date.now() - 60_000));
    await runReminders();
    const link = "/app/unibox?folder=reminders&thread=thread-remind-3";
    assert.deepEqual(await recipients("reminder_due", link), both());
    assert.equal((await rows("reminder_due", link))[0]!.title, "Follow up with nobody@example.test");
  });

  it("a reminder that isn't due yet waits, and a reply from the lead clears it", async () => {
    await conversation("thread-remind-2", "later@example.test", new Date(Date.now() + 2 * HOUR));
    await runReminders();
    assert.equal((await rows("reminder_due", "/app/unibox?folder=reminders&thread=thread-remind-2")).length, 0);
    emit("reply_received", ws, { thread_id: "thread-remind-2", lead_email: "later@example.test" });
    await until(
      async () => (await db.select({ at: schema.emails.reminderAt }).from(schema.emails).where(eq(schema.emails.threadId, "thread-remind-2"))).map((r) => r.at),
      (ats) => ats.length === 2 && ats.every((at) => at === null),
      "reminder cleared",
    );
  });

  it("a CRM task that comes due notifies the person it's assigned to", async () => {
    const [task] = await db
      .insert(schema.crmTasks)
      .values({ workspaceId: ws, title: "Call back about the demo", dueAt: new Date(Date.now() - 60_000), assignedTo: alice.id, createdBy: alice.id })
      .returning();
    await runReminders();
    await runReminders();
    assert.deepEqual(await recipients("task_due", `/app/crm/tasks?item=${encodeURIComponent(`task:${task!.id}`)}`), [alice.id]);
  });

  it("more tasks due at one moment than a pass reads are all announced, and so are the ones after them", async () => {
    const at = new Date(Date.now() - 30_000);
    const batch = await db
      .insert(schema.crmTasks)
      .values(Array.from({ length: 501 }, (_, i) => ({ workspaceId: ws, title: `Batch call ${i}`, dueAt: at, assignedTo: alice.id, createdBy: alice.id })))
      .returning({ id: schema.crmTasks.id });
    const [later] = await db
      .insert(schema.crmTasks)
      .values({ workspaceId: ws, title: "Later call", dueAt: new Date(Date.now() - 10_000), assignedTo: alice.id, createdBy: alice.id })
      .returning({ id: schema.crmTasks.id });
    for (let pass = 0; pass < 4; pass++) await runReminders();
    const links = new Set((await rows("task_due")).map((n) => n.link));
    const missing = [...batch, later!].filter((t) => !links.has(`/app/crm/tasks?item=${encodeURIComponent(`task:${t.id}`)}`));
    assert.equal(missing.length, 0, `${missing.length} due tasks were never announced`);
  });
});

// ---------- Send watchdog ----------

describe("send watchdog", () => {
  it("flags a running campaign that should be sending but isn't, names the cause, and notifies once", async () => {
    // Provider rules that leave no mailbox for anyone: the sender skips every lead without a word.
    const id = await campaign("Quiet one", ["quiet@example.test"], { provider_routing_rules: [{ action: "do_not_send", recipient_esp: ["all"], sender_esp: ["all"] }] });
    await launch(id);
    await runSender();
    assert.equal(await notSending(id), null);

    const t0 = Date.now();
    await runWatchdog(t0);
    assert.equal(await notSending(id), null, "too early to judge");
    await runWatchdog(t0 + 3 * HOUR);
    assert.equal(await notSending(id), CampaignNotSendingStatus.STALLED);
    const link = campaignLink(id);
    assert.deepEqual(await recipients("campaign_stalled", link), both());
    const [n] = await rows("campaign_stalled", link);
    assert.equal(n!.title, "“Quiet one” stopped sending");
    assert.match(n!.body!, /hasn't sent anything yet.*provider rules/);

    // The campaign page says so, and the sender doesn't wipe it while nothing goes out.
    const status = json(await alice.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.equal(status.summary.is_sending, false);
    assert.equal(status.summary.title, "Stopped sending");
    await runSender();
    assert.equal(await notSending(id), CampaignNotSendingStatus.STALLED);

    // Still stalled later: no second notification.
    await runWatchdog(t0 + 4 * HOUR);
    assert.equal((await rows("campaign_stalled", link)).length, 2);

    // Fixed: the next send clears the reason.
    json(await alice.client.patch(`/api/v2/campaigns/${id}`, { provider_routing_rules: [] }));
    await runSender();
    assert.equal(await notSending(id), null);
  });

  it("says when the due leads all wait for email verification", async () => {
    const id = await campaign("Verifying", ["pending@example.test"]);
    await db.update(schema.leads).set({ verificationStatus: VerificationStatus.PENDING }).where(eq(schema.leads.campaignId, id));
    await launch(id);
    await runSender();
    const t0 = Date.now();
    await runWatchdog(t0);
    await runWatchdog(t0 + 3 * HOUR);
    assert.equal(await notSending(id), CampaignNotSendingStatus.VERIFYING);
    const [n] = await rows("campaign_stalled", campaignLink(id));
    assert.match(n!.body!, /waiting for their email verification/);
  });

  it("leaves expected pauses alone: schedule closed, no lead due yet", async () => {
    const closed = await campaign("Closed schedule", ["closed@example.test"]);
    const waiting = await campaign("Nobody due", ["waiting@example.test"]);
    await launch(closed);
    await launch(waiting);
    await db
      .update(schema.campaigns)
      .set({ schedule: { ...ALWAYS_OPEN, end_date: "2020-01-31" } })
      .where(eq(schema.campaigns.id, closed));
    await db
      .update(schema.leads)
      .set({ nextStep: 1, nextSendAt: Date.now() + 24 * HOUR })
      .where(eq(schema.leads.campaignId, waiting));
    const t0 = Date.now();
    await runWatchdog(t0);
    await runWatchdog(t0 + 3 * HOUR);
    for (const id of [closed, waiting]) {
      assert.notEqual(await notSending(id), CampaignNotSendingStatus.STALLED);
      assert.equal((await rows("campaign_stalled", campaignLink(id))).length, 0);
    }
  });
});

// ---------- System health ----------

describe("system health", () => {
  it("is for the installation's owner and administrators only", async () => {
    const h = json(await installOwner.client.get("/api/app/admin/health"));
    assert.ok(["ok", "warn", "bad"].includes(h.status));
    for (const part of ["engine", "inbox_sync", "jobs", "campaigns", "storage"]) assert.ok(h[part], part);
    assert.ok(h.inbox_sync.mailboxes >= 1);
    assert.ok(h.storage.database_bytes > 0);
    assert.equal(typeof h.jobs.pending, "number");
    // The campaign waiting on verification is listed for someone to look at.
    assert.ok(h.campaigns.items.some((c: { name: string; not_sending_status: number }) => c.name === "Verifying" && c.not_sending_status === CampaignNotSendingStatus.VERIFYING));

    expectStatus(await alice.client.get("/api/app/admin/health"), 403);
    expectStatus(await viewer.client.get("/api/app/admin/health"), 403);
    expectStatus(await installOwner.client.patch(`/api/app/admin/users/${bob.id}`, { admin: true }), 200);
    expectStatus(await bob.client.get("/api/app/admin/health"), 200);
  });
});
