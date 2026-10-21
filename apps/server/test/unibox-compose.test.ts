// Replying from the Unibox: a reply that continues a subsequence is checked before it goes out, and reported as sent
// once it has; replies and forwards answer emails that were sent; a deleted conversation's scheduled email stays unsent;
// the sidebar counts what the lists show; uploads are checked as they arrive and cleared away when never sent. Mail goes
// through sandbox mailboxes (nothing leaves the process). Every address and value here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { CampaignStatus, EmailType, LeadStatus } from "@reachstack/shared";
import { client, db, schema } from "../src/db/client";
import { resolveStoredPath } from "../src/lib/data-files";
import { uuidv7 } from "../src/lib/ids";
import { SandboxDriver } from "../src/mail/sandbox";
import type { OutgoingMessage } from "../src/mail/types";
import * as unibox from "../src/services/unibox";

const M = schema.emails;
const L = schema.leads;
const A = schema.emailAttachments;

let app: FastifyInstance;
let user: TestUser;
let box = "";
let campaignId = "";
let subId = "";

const step = (subject: string) => ({ type: "email", delay: 2, delay_unit: "days", variants: [{ subject, body: `<p>${subject}</p>` }] });

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Uma", workspaceName: "Compose Co" });
  box = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, domain: "compose-co.test", enable_warmup: false })).items[0].email;
  campaignId = json(await user.client.post("/api/app/campaigns", { name: "Spring" })).id;
  const [sub] = await db
    .insert(schema.subsequences)
    .values({
      workspaceId: user.workspaceId!,
      parentCampaignId: campaignId,
      name: "Nudge",
      status: CampaignStatus.ACTIVE,
      conditions: { reply_contains: "later" },
      sequences: [{ steps: [step("Checking in"), step("One more thing")] }] as never,
    })
    .returning({ id: schema.subsequences.id });
  subId = sub!.id;
});
after(stopServer);

const delivered = async (to: string) => (await db.select().from(schema.sandboxMessages).where(eq(schema.sandboxMessages.mailbox, to))).length;
const ownIn = async (threadId: string) => db.select().from(M).where(and(eq(M.threadId, threadId), inArray(M.ueType, [EmailType.SENT, EmailType.SCHEDULED])));
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

/** A lead of the campaign who wrote in: their message, unread, in a conversation of its own. */
async function conversation(email: string) {
  const lead = json(await user.client.post("/api/v2/leads", { email, first_name: "Pat", campaign: campaignId }));
  const threadId = uuidv7();
  const emailId = uuidv7();
  await db.insert(M).values({
    id: emailId,
    workspaceId: user.workspaceId!,
    messageId: `<${emailId}@prospect.test>`,
    threadId,
    subject: "Re: Hello",
    fromAddress: email,
    fromJson: [{ address: email, name: "Pat" }],
    toList: box,
    leadEmail: email,
    leadId: lead.id,
    campaignId,
    eaccount: box,
    ueType: EmailType.RECEIVED,
    bodyText: "Tell me more.",
    bodyHtml: "<p>Tell me more.</p>",
    timestampEmail: new Date(Date.now() - 60_000),
    isUnread: 1,
  });
  return { lead: lead as { id: string }, threadId, emailId };
}

const reply = (emailId: string, extra: Record<string, unknown> = {}) =>
  user.client.post("/api/v2/emails/reply", { eaccount: box, reply_to_uuid: emailId, subject: "Re: Hello", body: { html: "<p>Here you go.</p>" }, ...extra });
const continuing = (step: number, subsequence_id = subId) => ({ continuation: { subsequence_id, step, wait: 2, wait_unit: "days" } });

describe("a reply that continues a subsequence", () => {
  it("is checked before it goes out: when it's refused, nothing was sent", async () => {
    const c = await conversation("ana@prospect-one.test");
    const refused = async (extra: Record<string, unknown>, message: RegExp) => {
      const res = await reply(c.emailId, extra);
      expectStatus(res, 400);
      assert.match(res.json().message, message);
    };
    await refused(continuing(0, uuidv7()), /no longer available/);
    await refused(continuing(5), /step does not exist/);
    await db.update(L).set({ status: LeadStatus.BOUNCED }).where(eq(L.id, c.lead.id));
    await refused(continuing(1), /bounced, so nothing more is sent to them/);
    assert.equal(await delivered("ana@prospect-one.test"), 0, "nothing went out");
    assert.equal((await ownIn(c.threadId)).length, 0);

    // Without it, the reply goes (they wrote in; the writer knows).
    json(await reply(c.emailId));
    assert.equal(await delivered("ana@prospect-one.test"), 1);
  });

  it("goes out and puts the lead into the subsequence at that step, saying whether it will run", async () => {
    const c = await conversation("ben@prospect-two.test");
    const res = json(await reply(c.emailId, continuing(1)));
    assert.equal(res.continuation.step, 2);
    assert.equal(res.continuation.running, false, "its campaign hasn't started");
    const lead = (await db.select().from(L).where(eq(L.id, c.lead.id)))[0]!;
    assert.deepEqual([lead.subsequenceId, lead.subseqStatus, lead.subseqNextStep], [subId, LeadStatus.ACTIVE, 1]);
    assert.equal(await delivered("ben@prospect-two.test"), 1);

    await db.update(schema.campaigns).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.campaigns.id, campaignId));
    try {
      const c2 = await conversation("bo@prospect-two.test");
      assert.equal(json(await reply(c2.emailId, continuing(0))).continuation.running, true);
    } finally {
      await db.update(schema.campaigns).set({ status: CampaignStatus.DRAFT }).where(eq(schema.campaigns.id, campaignId));
    }
  });

  it("is reported as sent, once, when what follows it can't be scheduled after it went out", async () => {
    const c = await conversation("cy@prospect-three.test");
    await client.execute(`CREATE TRIGGER refuse_continuation BEFORE UPDATE OF subseq_status ON leads WHEN NEW.id = '${c.lead.id}' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END`);
    let res;
    try {
      res = json(await reply(c.emailId, continuing(0)));
    } finally {
      await client.execute("DROP TRIGGER refuse_continuation");
    }
    assert.equal(res.ue_type, EmailType.SENT);
    assert.equal(res.continuation, undefined);
    assert.match(res.continuation_error, /couldn't be continued/);
    assert.equal(await delivered("cy@prospect-three.test"), 1);
    assert.equal((await ownIn(c.threadId)).length, 1, "a second try would send it twice");
  });

  it("a bounce that comes in between the check and the reply stands", async () => {
    const c = await conversation("dee@prospect-four.test");
    const plan = await unibox.checkContinuation(user.workspaceId!, c.lead.id, { subsequenceId: subId, step: 0, waitMs: 60_000 });
    await db.update(L).set({ status: LeadStatus.BOUNCED }).where(eq(L.id, c.lead.id));
    await assert.rejects(unibox.scheduleContinuation(plan, uuidv7()), /bounced or unsubscribed meanwhile/);
    const lead = (await db.select().from(L).where(eq(L.id, c.lead.id)))[0]!;
    assert.deepEqual([lead.status, lead.subsequenceId], [LeadStatus.BOUNCED, null]);
  });
});

describe("what a reply or forward answers", () => {
  it("an email that went out, never one still scheduled", async () => {
    const first = json(await user.client.post("/api/v2/emails/send", { eaccount: box, to: ["fay@prospect-six.test"], subject: "Hello Fay", body: { html: "<p>Hi Fay</p>" } }));
    const later = json(await user.client.post("/api/v2/emails/reply", { eaccount: box, reply_to_uuid: first.id, subject: "Re: Hello Fay", body: { html: "<p>Following up</p>" }, scheduled_at: inAnHour() }));
    assert.equal(later.ue_type, EmailType.SCHEDULED);
    // A bounce notice for it came back: a reply isn't for the mail server.
    const notice = uuidv7();
    await db.insert(M).values({
      id: notice,
      workspaceId: user.workspaceId!,
      messageId: `<${notice}@mail-server.test>`,
      threadId: first.thread_id,
      subject: "Undelivered Mail Returned to Sender",
      fromAddress: "mailer-daemon@mail-server.test",
      toList: box,
      eaccount: box,
      ueType: EmailType.RECEIVED,
      isBounce: true,
      timestampEmail: new Date(),
    });
    const thread = json(await user.client.get(`/api/app/unibox/threads/${first.thread_id}`));
    assert.equal(thread.reply_target_id, first.id, "replies and reminders go to the email that was sent");

    // The scheduled one doesn't exist for anyone else yet: answering or forwarding it is refused.
    const answered = await user.client.post("/api/v2/emails/reply", { eaccount: box, reply_to_uuid: later.id, subject: "Re", body: { html: "<p>x</p>" } });
    expectStatus(answered, 400);
    assert.match(answered.json().message, /hasn't been sent yet/);
    expectStatus(await user.client.post("/api/v2/emails/forward", { eaccount: box, reply_to_uuid: later.id, to_address_email_list: "gus@our-team.test", subject: "Fwd" }), 400);
    assert.equal(await delivered("gus@our-team.test"), 0);
  });
});

describe("a conversation deleted while scheduled emails go out", () => {
  it("its scheduled email isn't sent", async () => {
    const send = (to: string) => user.client.post("/api/v2/emails/send", { eaccount: box, to: [to], subject: "Later", body: { html: "<p>Talk soon</p>" }, scheduled_at: inAnHour() });
    const a = json(await send("hal@later-a.test"));
    const b = json(await send("ivy@later-b.test"));
    await db.update(M).set({ scheduledAt: new Date(Date.now() - 1000) }).where(inArray(M.id, [a.id, b.id]));
    // While the first one goes out, the other one's conversation is deleted.
    const real = SandboxDriver.prototype.send;
    let deleted: { id: string; to: string } | null = null;
    SandboxDriver.prototype.send = async function (this: SandboxDriver, msg: OutgoingMessage) {
      const to = msg.to[0]?.address;
      if (!deleted && (to === "hal@later-a.test" || to === "ivy@later-b.test")) {
        const other = to === "hal@later-a.test" ? { e: b, to: "ivy@later-b.test" } : { e: a, to: "hal@later-a.test" };
        expectStatus(await user.client.post("/api/app/unibox/bulk", { thread_ids: [other.e.thread_id], action: "delete" }), 200);
        deleted = { id: other.e.id, to: other.to };
      }
      return real.call(this, msg);
    };
    try {
      await unibox.runScheduledEmails();
    } finally {
      SandboxDriver.prototype.send = real;
    }
    assert.ok(deleted, "one of them went out");
    const gone = deleted as { id: string; to: string };
    assert.equal(await delivered(gone.to), 0);
    assert.equal((await db.select().from(M).where(eq(M.id, gone.id)))[0]!.ueType, EmailType.SCHEDULED);
    assert.equal(await delivered(gone.to === "hal@later-a.test" ? "ivy@later-b.test" : "hal@later-a.test"), 1);
  });
});

describe("the sidebar counts", () => {
  it("count what the lists show", async () => {
    const kay = await signUp(app, { firstName: "Kay", workspaceName: "Counts Co" });
    const add = (e: Partial<typeof M.$inferInsert> & { threadId: string; ueType: number }) => {
      const id = uuidv7();
      return db.insert(M).values({ id, workspaceId: kay.workspaceId!, messageId: `<${id}@counts.test>`, eaccount: "kay@counts-co.test", subject: "Hi", timestampEmail: new Date(), ...e });
    };
    // One conversation with an unread message in each tab is one unread conversation in the inbox.
    const both = uuidv7();
    await add({ threadId: both, ueType: EmailType.RECEIVED, fromAddress: "lou@counts-lead.test", isUnread: 1, isFocused: 1 });
    await add({ threadId: both, ueType: EmailType.RECEIVED, fromAddress: "desk@counts-lead.test", isUnread: 1, isFocused: 0 });
    // An unread auto-reply, which the inbox hides by default.
    await add({ threadId: uuidv7(), ueType: EmailType.RECEIVED, fromAddress: "ooo@counts-lead.test", isUnread: 1, isFocused: 0, isAutoReply: 1 });
    // A reminder on an email that hasn't gone out yet waits for the send.
    const soon = new Date(Date.now() + 86_400_000);
    await add({ threadId: uuidv7(), ueType: EmailType.SCHEDULED, scheduledAt: soon, timestampEmail: soon, reminderAt: new Date(soon.getTime() + 86_400_000) });

    let s = json(await kay.client.get("/api/app/unibox/summary"));
    assert.deepEqual(s.unread, { primary: 1, others: 1, inbox: 1 });
    assert.equal(s.reminders, 0);
    assert.equal(s.scheduled, 1);
    const listed = async (q: string) => json(await kay.client.get(`/api/app/unibox/threads?${q}`)).items.length;
    assert.equal(await listed("folder=reminders"), s.reminders);
    assert.equal(await listed("folder=inbox&mode=emode_others&is_unread=true"), s.unread.others);

    json(await kay.client.patch("/api/app/workspaces/current/settings", { unibox_show_auto_replies: true }));
    s = json(await kay.client.get("/api/app/unibox/summary"));
    assert.deepEqual(s.unread, { primary: 1, others: 2, inbox: 2 });
    assert.equal(await listed("folder=inbox&mode=emode_others&is_unread=true"), s.unread.others);
  });
});

describe("attachments", () => {
  function upload(files: Array<{ name: string; data: Buffer }>) {
    const boundary = `----rs-test-${randomUUID()}`;
    const parts: Buffer[] = [];
    for (const f of files) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.data, Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return user.client.request("POST", "/api/app/uploads", Buffer.concat(parts), { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  }
  const unsent = async () => db.select({ id: A.id }).from(A).where(and(eq(A.workspaceId, user.workspaceId!), isNull(A.emailId)));

  it("a file over 25 MB is refused as it arrives, and nothing of that upload is kept", async () => {
    const before = (await unsent()).length;
    const big = await upload([{ name: "notes.txt", data: Buffer.from("small") }, { name: "big.bin", data: Buffer.alloc(25 * 1024 * 1024 + 1) }]);
    expectStatus(big, 413);
    assert.match(big.json().message, /"big\.bin" is too large\. Attachments can be up to 25 MB\./);
    assert.equal((await unsent()).length, before, "the small file of that upload is gone too");

    const many = await upload(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") })));
    expectStatus(many, 413);
    assert.match(many.json().message, /up to 10 files/);
    assert.equal((await unsent()).length, before);

    assert.equal(json(await upload([{ name: "notes.txt", data: Buffer.from("small") }])).files.length, 1);
  });

  it("files that never went out are cleared away after a week; sent ones and recent ones stay", async () => {
    const one = async (name: string) => json(await upload([{ name, data: Buffer.from(name) }])).files[0].id as string;
    const [old, fresh, sent] = [await one("old.txt"), await one("fresh.txt"), await one("sent.txt")];
    const c = await conversation("jo@prospect-seven.test");
    json(await reply(c.emailId, { attachment_ids: [sent] }));
    await db.update(A).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) }).where(inArray(A.id, [old, sent]));
    const oldFile = resolveStoredPath((await db.select().from(A).where(eq(A.id, old)))[0]!.storagePath);
    assert.ok(existsSync(oldFile));

    await unibox.pruneUploads();
    const left = new Set((await db.select({ id: A.id }).from(A).where(inArray(A.id, [old, fresh, sent]))).map((r) => r.id));
    assert.deepEqual([left.has(old), left.has(fresh), left.has(sent)], [false, true, true]);
    assert.ok(!existsSync(oldFile), "its file is gone too");
  });
});
