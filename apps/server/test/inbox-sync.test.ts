// Inbox sync that keeps going and files each message once, in the right place: a message that can't be read, a folder
// that can't be opened, the same reply in two mailboxes, a mailbox moved to another workspace or connected in two, a
// reply whose follow-up fails partway, opt-outs from someone else on the thread, warmup emails saved from spam, and
// bounces of warmup emails. Mail goes through sandbox mailboxes and the real inbox sync (nothing leaves the process).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { AccountStatus, CampaignStatus, EmailType, LeadStatus, ProviderCode, WarmupStatus } from "@reachstack/shared";
import { client, db, schema } from "../src/db/client";
import { syncAccount } from "../src/engine/inbox-sync";
import { runSender } from "../src/engine/sender";
import { handleWarmupMessage, runWarmup } from "../src/engine/warmup";
import { uuidv7 } from "../src/lib/ids";
import { buildRaw, newMessageId } from "../src/mail/compose";
import type { AccountRow } from "../src/mail/driver";
import { parseInbound } from "../src/mail/parse";
import { SandboxDriver, storeSandboxMessage } from "../src/mail/sandbox";
import { SmtpImapDriver } from "../src/mail/smtp-imap";
import type { FetchBatch, MailSession, OutgoingMessage } from "../src/mail/types";
import { defaultWarmup } from "../src/services/accounts";
import { startOfDayOn, workspaceZone } from "../src/services/workspace-clock";

const A = schema.emailAccounts;
const M = schema.emails;
const L = schema.leads;

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Inbox Co" });
});
after(stopServer);

const row = async (id: string) => (await db.select().from(A).where(eq(A.id, id)))[0]!;
const sync = async (account: AccountRow) => syncAccount(await row(account.id));

/** Sandbox mailboxes on their own domain, as rows, with no pause between their emails. */
async function mailboxes(count: number, domain: string, u = user): Promise<AccountRow[]> {
  const items = json<{ items: Array<{ email: string }> }>(await u.client.post("/api/app/accounts/sandbox", { count, domain, enable_warmup: false })).items;
  const emails = items.map((i) => i.email);
  await db.update(A).set({ sendingGap: 0 }).where(inArray(A.email, emails));
  const rows = await db.select().from(A).where(inArray(A.email, emails));
  return emails.map((e) => rows.find((r) => r.email === e)!);
}

/** A message arriving in a mailbox's folder (not synced yet). */
async function arrive(to: AccountRow, opts: { from: string; name?: string; subject?: string; text: string; inReplyTo?: string | null; cc?: string[]; also?: AccountRow[] }) {
  const messageId = newMessageId(opts.from);
  const subject = opts.subject ?? "Hello";
  const raw = await buildRaw({
    from: { name: opts.name ?? "", address: opts.from },
    to: [{ name: "", address: to.email }],
    cc: (opts.cc ?? []).map((address) => ({ name: "", address })),
    subject,
    text: opts.text,
    html: null,
    messageId,
    inReplyTo: opts.inReplyTo ?? null,
    references: opts.inReplyTo ? [opts.inReplyTo] : [],
    date: new Date(),
  });
  let uid = 0;
  // The same message lands in every mailbox it was sent to.
  for (const box of [to, ...(opts.also ?? [])]) {
    const got = await storeSandboxMessage({ workspaceId: box.workspaceId, mailbox: box.email, folder: "INBOX", raw, messageId, inReplyTo: opts.inReplyTo ?? null, from: opts.from, subject });
    if (box === to) uid = got;
  }
  return { uid, messageId };
}

const received = async (messageId: string) => db.select().from(M).where(and(eq(M.messageId, messageId), eq(M.ueType, EmailType.RECEIVED)));

/** Changes what the sandbox's mail sessions fetch, for one test; returns the undo. */
async function interceptFetch(change: (folder: string, fetch: () => Promise<FetchBatch>) => Promise<FetchBatch>) {
  const probe = await new SandboxDriver({ email: "probe@inbox-co.test", workspaceId: user.workspaceId! }).open();
  const proto = Object.getPrototypeOf(probe) as MailSession;
  const real = proto.fetchNew;
  proto.fetchNew = function (this: MailSession, folder, sinceUid, opts) {
    return change(folder, () => real.call(this, folder, sinceUid, opts));
  };
  return () => {
    proto.fetchNew = real;
  };
}

/** A one-step campaign from `sender` to these leads, launched, with its first emails sent. */
async function campaignTo(sender: AccountRow, leads: Array<{ email: string; first_name: string; last_name?: string }>) {
  const c = user.client;
  const created = json(await c.post("/api/app/campaigns", { name: `Campaign to ${leads[0]!.email}` }));
  json(
    await c.patch(`/api/v2/campaigns/${created.id}`, {
      email_list: [sender.email],
      campaign_schedule: ALWAYS_OPEN,
      email_gap: 0,
      random_wait_max: 0,
      sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}, a quick question.</p>" }] }] }],
    }),
  );
  for (const lead of leads) json(await c.post("/api/v2/leads", { ...lead, campaign: created.id }));
  expectStatus(await c.post(`/api/v2/campaigns/${created.id}/activate`), 200);
  const sends = async () => db.select().from(M).where(and(eq(M.campaignId, created.id), eq(M.ueType, EmailType.CAMPAIGN_SENT)));
  for (let i = 0; i < 10 && (await sends()).length < leads.length; i++) await runSender();
  const sent = await sends();
  assert.equal(sent.length, leads.length, "first emails sent");
  // Nothing else of this workspace's keeps sending in later tests.
  await db.update(schema.campaigns).set({ status: CampaignStatus.PAUSED }).where(eq(schema.campaigns.id, created.id));
  const leadRows = await db.select().from(L).where(eq(L.campaignId, created.id));
  return leads.map((l) => {
    const lead = leadRows.find((r) => r.email === l.email)!;
    return { lead, sentId: sent.find((s) => s.leadId === lead.id)!.messageId };
  });
}

// ---------- Messages that can't be read ----------

describe("a message that can't be read", () => {
  const damaged = new Set<number>();
  let undo: () => void;
  before(async () => {
    undo = await interceptFetch(async (_folder, fetch) => {
      const batch = await fetch();
      const unreadable = (m: FetchBatch["messages"][number]) =>
        Object.defineProperty({ ...m }, "raw", {
          get() {
            throw new Error("damaged message");
          },
        });
      return { ...batch, messages: batch.messages.map((m) => (damaged.has(m.uid) ? unreadable(m) : m)) };
    });
  });
  after(() => undo());

  it("is tried on the next passes, then skipped, while the mail after it comes through", async () => {
    const [box] = await mailboxes(1, "damaged-one.test");
    const bad = await arrive(box!, { from: "lee@stranger-one.test", text: "First" });
    const good = await arrive(box!, { from: "kim@stranger-one.test", text: "Second" });
    damaged.add(bad.uid);

    await sync(box!);
    assert.equal((await received(good.messageId)).length, 1, "the next message is filed");
    assert.equal((await received(bad.messageId)).length, 0);
    assert.equal((await row(box!.id)).syncState?.INBOX?.lastUid, bad.uid - 1, "the unreadable one is tried again");
    await sync(box!);
    assert.equal((await row(box!.id)).syncState?.INBOX?.lastUid, bad.uid - 1);
    await sync(box!);
    assert.ok((await row(box!.id)).syncState!.INBOX!.lastUid >= good.uid, "skipped after three tries");
    assert.equal((await received(good.messageId)).length, 1, "what came through isn't filed twice");
    assert.equal((await row(box!.id)).status, AccountStatus.ACTIVE, "the mailbox itself is fine");
  });

  it("nothing is given up on when nothing in the folder can be read", async () => {
    const [box] = await mailboxes(1, "damaged-all.test");
    const only = await arrive(box!, { from: "lee@stranger-two.test", text: "Only one" });
    damaged.add(only.uid);
    for (let i = 0; i < 4; i++) await sync(box!);
    assert.equal((await row(box!.id)).syncState?.INBOX?.lastUid, only.uid - 1, "still waiting for it");
    damaged.delete(only.uid);
    await sync(box!);
    assert.equal((await received(only.messageId)).length, 1);
  });
});

// ---------- Folders ----------

describe("a folder that can't be opened", () => {
  it("doesn't stop the inbox, and the folder list is read again", async () => {
    const [box] = await mailboxes(1, "lost-spam.test");
    const undo = await interceptFetch(async (folder, fetch) => {
      if (folder === "Junk") throw new Error("Mailbox doesn't exist: Junk");
      return fetch();
    });
    const msg = await arrive(box!, { from: "kim@stranger-three.test", text: "Hello there" });
    try {
      await sync(box!);
    } finally {
      undo();
    }
    assert.equal((await received(msg.messageId)).length, 1, "the inbox was read");
    let r = await row(box!.id);
    assert.equal(r.status, AccountStatus.ACTIVE, "no connection error for a spam folder");
    assert.equal(r.folders?.checked_at, 0, "folders read again on the next pass");
    await sync(box!);
    r = await row(box!.id);
    assert.ok((r.folders?.checked_at ?? 0) > Date.now() - 60_000);
    assert.equal(r.folders?.spam, "Junk");
  });
});

// ---------- Filed once, in the right place ----------

describe("where a reply is filed", () => {
  it("a reply sent to two of the workspace's mailboxes is filed, and counted, once", async () => {
    const [one, two] = await mailboxes(2, "two-boxes.test");
    const [{ lead, sentId }] = await campaignTo(one!, [{ email: "pat@two-boxes-lead.test", first_name: "Pat" }]);
    const reply = await arrive(one!, { from: lead.email!, name: "Pat", subject: "Re: Hi Pat", text: "Yes, let's talk.", inReplyTo: sentId, cc: [two!.email], also: [two!] });
    await sync(two!);
    await sync(one!);
    const rows = await received(reply.messageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.leadId, lead.id);
    const after = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!;
    assert.equal(after.replyCount, 1);
    const events = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "reply")));
    assert.equal(events.length, 1);
  });

  it("a mailbox moved to another workspace still files replies to what it sent before, where it sent them", async () => {
    const [box] = await mailboxes(1, "moved-box.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@moved-box-lead.test", first_name: "Pat" }]);
    const other = await signUp(app, { firstName: "Ola", workspaceName: "Other Co" });
    await db.update(A).set({ workspaceId: other.workspaceId! }).where(eq(A.id, box!.id));

    const reply = await arrive(box!, { from: lead.email!, name: "Pat", subject: "Re: Hi Pat", text: "Interested, tell me more.", inReplyTo: sentId });
    await sync(box!);
    const rows = await received(reply.messageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.workspaceId, user.workspaceId, "with the conversation it answers");
    assert.equal(rows[0]!.leadId, lead.id);
    const after = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!;
    assert.equal(after.replyCount, 1);
    assert.equal(after.status, LeadStatus.COMPLETED);

    // New mail from strangers belongs to the mailbox's new workspace.
    const stranger = await arrive(box!, { from: "kim@stranger-four.test", text: "Hi there" });
    await sync(box!);
    assert.equal((await received(stranger.messageId))[0]?.workspaceId, other.workspaceId);
  });

  it("a mailbox connected in two workspaces puts a reply down to the lead whose email it answers", async () => {
    const [box] = await mailboxes(1, "shared-box.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@shared-box-lead.test", first_name: "Pat" }]);
    // The same mailbox in another workspace, where the same person is a lead too.
    const other = await signUp(app, { firstName: "Ola", workspaceName: "Shared Box Co" });
    const [twin] = await db
      .insert(A)
      .values({ ...(await row(box!.id)), id: uuidv7(), workspaceId: other.workspaceId!, syncState: null })
      .returning();
    json(await other.client.post("/api/v2/leads", { email: lead.email, first_name: "Pat" }));
    const [theirs] = await db.select().from(L).where(and(eq(L.workspaceId, other.workspaceId!), eq(L.email, lead.email!)));

    const reply = await arrive(box!, { from: lead.email!, name: "Pat", subject: "Re: Hi Pat", text: "Yes, tell me more.", inReplyTo: sentId });
    await sync(twin!);
    await sync(box!);
    const rows = await received(reply.messageId);
    assert.equal(rows.find((r) => r.workspaceId === user.workspaceId)?.leadId, lead.id, "with the conversation it answers");
    assert.equal(rows.find((r) => r.workspaceId === other.workspaceId)?.leadId ?? null, null, "not put down to the other workspace's lead");
    assert.equal((await db.select().from(L).where(eq(L.id, lead.id)))[0]!.replyCount, 1);
    const untouched = (await db.select().from(L).where(eq(L.id, theirs!.id)))[0]!;
    assert.equal(untouched.replyCount, 0);
    assert.equal(untouched.status, theirs!.status);
    const events = await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.leadId, theirs!.id));
    assert.equal(events.length, 0);
  });

  it("a message without a Message-ID is filed once, however often it's read", async () => {
    const [box] = await mailboxes(1, "no-id.test");
    const raw = [`From: Kim <kim@stranger-five.test>`, `To: ${box!.email}`, `Subject: No id here`, `Date: ${new Date().toUTCString()}`, ``, `Just a note without an id.`, ``].join("\r\n");
    const first = await parseInbound(Buffer.from(raw));
    const again = await parseInbound(Buffer.from(raw));
    assert.equal(first.messageId, again.messageId, "the same made-up id each time");
    for (const folder of ["INBOX", "INBOX"]) await storeSandboxMessage({ workspaceId: box!.workspaceId, mailbox: box!.email, folder, raw, from: "kim@stranger-five.test", subject: "No id here" });
    await sync(box!);
    await db.update(A).set({ syncState: null }).where(eq(A.id, box!.id)); // read the folder from the start again
    await sync(box!);
    assert.equal((await received(first.messageId)).length, 1);
  });
});

describe("a reply whose follow-up fails partway", () => {
  it("is in the Unibox at once, and the lead is stopped on the next pass, once", async () => {
    const [box] = await mailboxes(1, "retry-box.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@retry-box-lead.test", first_name: "Pat" }]);
    // The database refuses the lead's update, as when the disk is full.
    await client.execute(`CREATE TRIGGER refuse_reply BEFORE UPDATE OF email_reply_count ON leads WHEN NEW.id = '${lead.id}' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END`);
    const reply = await arrive(box!, { from: lead.email!, name: "Pat", subject: "Re: Hi Pat", text: "Yes, send me the details.", inReplyTo: sentId });
    try {
      await sync(box!);
    } finally {
      await client.execute("DROP TRIGGER refuse_reply");
    }
    let rows = await received(reply.messageId);
    assert.equal(rows.length, 1, "filed all the same");
    assert.equal(rows[0]!.retryHandling, true);
    assert.equal((await db.select().from(L).where(eq(L.id, lead.id)))[0]!.replyCount, 0);
    assert.equal((await row(box!.id)).syncState?.INBOX?.lastUid, reply.uid - 1, "read again on the next pass");

    await sync(box!);
    rows = await received(reply.messageId);
    assert.equal(rows.length, 1, "not filed twice");
    assert.equal(rows[0]!.retryHandling, false);
    const after = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!;
    assert.equal(after.replyCount, 1);
    assert.equal(after.status, LeadStatus.COMPLETED);
    const events = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "reply")));
    assert.equal(events.length, 1);
  });
});

// ---------- Opt-outs ----------

describe("an opt-out from someone else on the thread", () => {
  it("unsubscribes the person who asked, not the lead", async () => {
    const [box] = await mailboxes(1, "colleague.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@acme-colleague.test", first_name: "Pat" }]);
    await arrive(box!, { from: "lee@acme-colleague.test", name: "Lee Park", subject: "Re: Hi Pat", text: "Please remove me from your list.", inReplyTo: sentId });
    await sync(box!);
    const unsubscribed = (await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.workspaceId, user.workspaceId!))).map((u) => u.email);
    assert.ok(unsubscribed.includes("lee@acme-colleague.test"));
    assert.ok(!unsubscribed.includes("pat@acme-colleague.test"), "the lead didn't ask");
    const after = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!;
    assert.equal(after.replyCount, 1, "it still counts as a reply on the thread");
  });

  it("the lead writing from another address, under their own name, is the lead", async () => {
    const [box] = await mailboxes(1, "own-name.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@acme-own-name.test", first_name: "Pat", last_name: "Lee" }]);
    await arrive(box!, { from: "pat.lee@home-mail.test", name: "Pat Lee", subject: "Re: Hi Pat", text: "Please remove me from your list.", inReplyTo: sentId });
    await sync(box!);
    const unsubscribed = (await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.workspaceId, user.workspaceId!))).map((u) => u.email);
    assert.ok(unsubscribed.includes(lead.email!));
  });
});

describe("someone answering a forward", () => {
  it("is filed with the conversation, but isn't the lead replying", async () => {
    const [box] = await mailboxes(1, "forward-box.test");
    const [{ lead, sentId }] = await campaignTo(box!, [{ email: "pat@forward-lead.test", first_name: "Pat" }]);
    const fromLead = await arrive(box!, { from: lead.email!, name: "Pat", subject: "Re: Hi Pat", text: "Who handles pricing?", inReplyTo: sentId });
    await sync(box!);
    const [leadReply] = await received(fromLead.messageId);
    const contacted = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!.lastContactAt;

    // Passed on to a colleague, who answers the forward.
    const fwd = json(await user.client.post("/api/v2/emails/forward", { eaccount: box!.email, reply_to_uuid: leadReply!.id, to_address_email_list: "sam@our-sales-team.test", subject: "Fwd: Re: Hi Pat" }));
    const answer = await arrive(box!, { from: "sam@our-sales-team.test", name: "Sam Ortiz", subject: "Re: Fwd: Re: Hi Pat", text: "I will take this one.", inReplyTo: fwd.message_id });
    await sync(box!);
    const [filed] = await received(answer.messageId);
    assert.equal(filed!.threadId, leadReply!.threadId, "in the conversation");
    assert.equal(filed!.leadId, null, "not the lead's");
    assert.equal(filed!.isFocused, 1, "with the conversation, not in Others");

    const after = (await db.select().from(L).where(eq(L.id, lead.id)))[0]!;
    assert.equal(after.replyCount, 1, "the lead replied once");
    assert.equal(after.lastContactAt?.getTime(), contacted?.getTime(), "forwarding isn't contacting the lead");
    const replies = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "reply")));
    assert.equal(replies.length, 1);

    // The list still shows the conversation's lead, though its newest email is the colleague's.
    const list = json(await user.client.get(`/api/app/unibox/threads?folder=all&search=${encodeURIComponent("take this one")}`));
    assert.deepEqual(
      list.items.map((t: { thread_id: string; lead: { id: string } | null }) => [t.thread_id, t.lead?.id]),
      [[leadReply!.threadId, lead.id]],
    );
  });
});

// ---------- Warmup ----------

describe("a warmup email saved from spam", () => {
  it("is marked read and important in the inbox, under the UID it has there", async () => {
    const [from, to] = await mailboxes(2, "warm-rescue.test");
    const messageId = newMessageId(from!.email);
    const [wm] = await db
      .insert(schema.warmupMessages)
      .values({ senderAccountId: from!.id, recipientAccountId: to!.id, messageId, subject: "Quick note", tag: "wr-test", sentAt: new Date() })
      .returning();
    const flagged: Array<[string, number, string[]]> = [];
    const moved: Array<[string, number, string]> = [];
    // A server that doesn't say the new UID: it's looked up by Message-ID.
    const session = {
      move: async (folder: string, uid: number, destination: string) => {
        moved.push([folder, uid, destination]);
        return null;
      },
      findByMessageId: async () => ({ folder: "INBOX", uid: 912, raw: Buffer.from(""), flags: [], internalDate: null }),
      addFlags: async (folder: string, uid: number, flags: string[]) => void flagged.push([folder, uid, flags]),
    } as unknown as MailSession;
    const folders = { inbox: "INBOX", spam: "Junk", sent: "Sent", trash: "Trash", archive: null, important: null, all: null };
    await handleWarmupMessage(to!, session, folders, { folder: "Junk", uid: 17, raw: Buffer.from(""), flags: [], internalDate: null }, wm!);
    assert.deepEqual(moved, [["Junk", 17, "INBOX"]]);
    assert.deepEqual(
      flagged.map(([folder, uid]) => [folder, uid]),
      [
        ["INBOX", 912],
        ["INBOX", 912],
      ],
    );
    const [after] = await db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, wm!.id));
    assert.equal(after?.savedFromSpam, true);
    assert.equal(after?.opened, true);
    assert.equal(after?.important, true);
  });

  it("is treated as its sender set (not as the recipient's own warmup is), and counted once when read twice at once", async () => {
    const [from, to] = await mailboxes(2, "warm-settings.test");
    // The sender's warmup emails stay where they land, unread; the recipient's own setting (everything) doesn't matter.
    await db
      .update(A)
      .set({ warmup: { ...defaultWarmup(), advanced: { ...defaultWarmup().advanced, open_rate: 0, important_rate: 0, spam_save_rate: 0 } } })
      .where(eq(A.id, from!.id));
    const [wm] = await db
      .insert(schema.warmupMessages)
      .values({ senderAccountId: from!.id, recipientAccountId: to!.id, messageId: newMessageId(from!.email), subject: "Quick note", tag: "ws-test", sentAt: new Date() })
      .returning();
    const acted: string[] = [];
    const session = {
      move: async () => {
        acted.push("move");
        return null;
      },
      findByMessageId: async () => null,
      addFlags: async (_folder: string, _uid: number, flags: string[]) => void acted.push(...flags),
    } as unknown as MailSession;
    const folders = { inbox: "INBOX", spam: "Junk", sent: "Sent", trash: "Trash", archive: null, important: null, all: null };
    const fetched = { folder: "Junk", uid: 21, raw: Buffer.from(""), flags: [], internalDate: null };
    await Promise.all([handleWarmupMessage(to!, session, folders, fetched, wm!), handleWarmupMessage(to!, session, folders, fetched, wm!)]);
    assert.deepEqual(acted, []);
    const [after] = await db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, wm!.id));
    assert.deepEqual([after!.folder, after!.savedFromSpam, after!.opened, after!.important], ["spam", false, false, false]);
    const stats = await db.select().from(schema.accountDailyStats).where(eq(schema.accountDailyStats.accountId, to!.id));
    assert.equal(
      stats.reduce((n, s) => n + s.warmupReceived, 0),
      1,
      "received once",
    );
  });
});

describe("a mailbox that signs in under another name", () => {
  it("gets warmup emails only once mail to its address has arrived in its inbox", async () => {
    const noon = startOfDayOn(await workspaceZone(user.workspaceId!)) + 12 * 3_600_000;
    const server = (login: string) => ({ host: "imap.example.test", port: 993, secure: true, user: login });
    const base = {
      workspaceId: user.workspaceId!,
      providerCode: ProviderCode.CUSTOM,
      smtp: { host: "smtp.example.test", port: 587, secure: false, user: "smtp-login" },
      warmupStatus: WarmupStatus.ACTIVE,
      warmup: { ...defaultWarmup(), limit: 10, increment: "disabled" },
      warmupStartedAt: new Date(),
    };
    const [typed, pal] = await db
      .insert(A)
      .values([
        { ...base, email: "sales@typed-five.test", imap: server("login@typed-five.test") },
        { ...base, email: "pal@pal-five.test", imap: server("pal@pal-five.test") },
      ])
      .returning();
    await db.update(A).set({ warmupStatus: WarmupStatus.PAUSED }).where(notInArray(A.id, [typed!.id, pal!.id]));
    const sends: Array<[string, string]> = [];
    const realSend = SmtpImapDriver.prototype.send;
    const realOpen = SmtpImapDriver.prototype.open;
    SmtpImapDriver.prototype.send = async (msg: OutgoingMessage) => {
      sends.push([msg.from.address, msg.to[0]!.address]);
      return { messageId: msg.messageId, response: "250 OK (stub)", accepted: msg.to.map((t) => t.address), rejected: [] };
    };
    // Its inbox, here, is a sandbox one.
    SmtpImapDriver.prototype.open = async () => new SandboxDriver({ email: typed!.email, workspaceId: typed!.workspaceId }).open();
    try {
      await runWarmup(noon);
      assert.deepEqual(sends, [["sales@typed-five.test", "pal@pal-five.test"]], "it sends, but nothing is sent to it yet");
      assert.equal(json(await user.client.get(`/api/v2/accounts/${encodeURIComponent(typed!.email)}`)).warmup_address_confirmed, false);

      await arrive(typed!, { from: "someone@elsewhere.test", text: "Hello there" });
      await sync(typed!);
      assert.ok((await row(typed!.id)).addressSeenAt, "mail to the address arrived");
      sends.length = 0;
      await runWarmup(noon + 3_600_000);
      assert.ok(
        sends.some(([from, to]) => from === "pal@pal-five.test" && to === "sales@typed-five.test"),
        JSON.stringify(sends),
      );
    } finally {
      SmtpImapDriver.prototype.send = realSend;
      SmtpImapDriver.prototype.open = realOpen;
      await db.update(A).set({ warmupStatus: WarmupStatus.PAUSED }).where(inArray(A.id, [typed!.id, pal!.id]));
    }
  });
});

describe("a bounce of a warmup email", () => {
  it("stays out of the Unibox and says nothing about leads", async () => {
    const [box, partner] = await mailboxes(2, "warm-bounce.test");
    const warmId = newMessageId(box!.email);
    await db.insert(schema.warmupMessages).values({ senderAccountId: box!.id, recipientAccountId: partner!.id, messageId: warmId, subject: "Quick hello", tag: "wb-tag", sentAt: new Date() });
    const dsnId = newMessageId("mailer-daemon@warm-bounce.test");
    const raw = [
      "From: Mail Delivery Subsystem <mailer-daemon@warm-bounce.test>",
      `To: ${box!.email}`,
      "Subject: Delivery Status Notification (Failure)",
      `Message-ID: ${dsnId}`,
      `In-Reply-To: ${warmId}`,
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      "MIME-Version: 1.0",
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "There was a problem delivering your message.",
      "--b1",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.warm-bounce.test",
      "",
      `Final-Recipient: rfc822; ${partner!.email}`,
      "Action: failed",
      "Status: 5.2.2",
      "Diagnostic-Code: smtp; 552 5.2.2 The recipient's mailbox is full",
      "--b1--",
      "",
    ].join("\r\n");
    await storeSandboxMessage({ workspaceId: box!.workspaceId, mailbox: box!.email, folder: "INBOX", raw, messageId: dsnId, from: "mailer-daemon@warm-bounce.test", subject: "Delivery Status Notification (Failure)" });
    await sync(box!);
    assert.equal((await db.select().from(M).where(eq(M.messageId, dsnId))).length, 0, "not filed");
    assert.equal((await row(box!.id)).status, AccountStatus.ACTIVE);
  });
});
