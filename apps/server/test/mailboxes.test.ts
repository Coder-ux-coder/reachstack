// Mailboxes: who warms up with whom, the warmup and campaign ramps, one workspace clock for daily limits and warmup,
// sending failures that stay until sending works (with a rate-limited account_error), health from what emails did,
// resting, and the provider their servers belong to. Sandbox mailboxes deliver inside the database; "real" mailboxes
// here are rows whose sending is stubbed, so nothing touches the network.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  AccountStatus,
  CampaignNotSendingStatus,
  CampaignStatus,
  ProviderCode,
  SLOW_RAMP,
  WarmupStatus,
  scoreHealth,
  warmupRampDays,
  warmupTarget,
} from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { syncAccount } from "../src/engine/inbox-sync";
import { runSender } from "../src/engine/sender";
import { runWarmup, warmupPool } from "../src/engine/warmup";
import type { AccountRow } from "../src/mail/driver";
import { SandboxDriver } from "../src/mail/sandbox";
import { freshAccessToken } from "../src/mail/oauth";
import { providerForHosts } from "../src/mail/providers";
import { SmtpImapDriver, classifyError } from "../src/mail/smtp-imap";
import { MailError, type OutgoingMessage } from "../src/mail/types";
import { bumpAccountStat, defaultWarmup, errorState, recordAccountError } from "../src/services/accounts";
import { on, type BusEvent } from "../src/services/bus";
import { upsertOAuthAccount } from "../src/services/account-connect";
import { systemHealth } from "../src/services/health";
import { forgetStoppedWorkspaces } from "../src/services/live-workspaces";
import { recheckSendingFailures } from "../src/services/mailbox-health";
import { dayOn, daysBefore, forgetWorkspaceZones, startOfDayOn } from "../src/services/workspace-clock";

const A = schema.emailAccounts;
const S = schema.accountDailyStats;

/** A timezone whose date differs from UTC's right now, so the workspace's "today" can't pass for UTC's. */
const AWAY_ZONE = new Date().getUTCHours() < 12 ? "Etc/GMT+12" : "Etc/GMT-14";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};

let app: FastifyInstance;
let user: TestUser;
let wsId: string;
const events: BusEvent[] = [];

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Mo", workspaceName: "Mailbox Co" });
  wsId = user.workspaceId!;
  await setZone(wsId, AWAY_ZONE);
  on("account_error", (e) => void events.push(e));
});
after(stopServer);

async function setZone(workspaceId: string, zone: string) {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await db
    .update(schema.workspaces)
    .set({ settings: { ...(ws?.settings ?? {}), default_timezone: zone } as typeof ws.settings })
    .where(eq(schema.workspaces.id, workspaceId));
  forgetWorkspaceZones(workspaceId);
}

/** Sandbox mailboxes on their own domain (warmup off unless asked), as rows. */
async function sandbox(u: TestUser, count: number, domain: string, warmup = false): Promise<AccountRow[]> {
  const items = json<{ items: Array<{ email: string }> }>(await u.client.post("/api/app/accounts/sandbox", { count, domain, enable_warmup: warmup })).items;
  const rows = await db.select().from(A).where(inArray(A.email, items.map((i) => i.email)));
  return items.map((i) => rows.find((r) => r.email === i.email)!);
}

const row = async (id: string) => (await db.select().from(A).where(eq(A.id, id)))[0]!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const today = () => dayOn(AWAY_ZONE);

async function setStats(account: AccountRow, date: string, values: Partial<typeof S.$inferInsert>) {
  await db
    .insert(S)
    .values({ workspaceId: account.workspaceId, accountId: account.id, date, ...values })
    .onConflictDoUpdate({ target: [S.accountId, S.date], set: values });
}

/** "Real" mailboxes (their sending stubbed with stubRealSends) with warmup on, as rows. */
async function realBoxes(emails: string[], workspaceId = wsId, extra: Partial<typeof A.$inferInsert> = {}) {
  return db
    .insert(A)
    .values(
      emails.map((email) => ({
        workspaceId,
        email,
        providerCode: ProviderCode.CUSTOM,
        smtp: { host: "smtp.example.test", port: 587, secure: false, user: email },
        imap: { host: "imap.example.test", port: 993, secure: true, user: email },
        warmupStatus: WarmupStatus.ACTIVE,
        warmup: { ...defaultWarmup(), limit: 10, increment: "disabled" },
        warmupStartedAt: new Date(),
        ...extra,
      })),
    )
    .returning();
}

/** Records real mailboxes' sends instead of making them; returns them and the undo. */
function stubRealSends() {
  const sends: Array<{ from: string; to: string }> = [];
  const real = SmtpImapDriver.prototype.send;
  SmtpImapDriver.prototype.send = async (msg: OutgoingMessage) => {
    sends.push({ from: msg.from.address, to: msg.to[0]!.address });
    return { messageId: msg.messageId, response: "250 OK (stub)", accepted: msg.to.map((t) => t.address), rejected: [] };
  };
  return {
    sends,
    undo: () => {
      SmtpImapDriver.prototype.send = real;
    },
  };
}

/** Only these mailboxes take part in warmup. */
async function onlyWarming(accounts: AccountRow[]) {
  await db.update(A).set({ warmupStatus: WarmupStatus.PAUSED });
  if (accounts.length) await db.update(A).set({ warmupStatus: WarmupStatus.ACTIVE }).where(inArray(A.id, accounts.map((a) => a.id)));
}

/** A one-step campaign from these mailboxes with one lead, launched; every other campaign is paused. */
async function campaign(senders: AccountRow[], leadEmail: string, extra: Record<string, unknown> = {}) {
  const c = user.client;
  const created = json(await c.post("/api/app/campaigns", { name: `Campaign for ${leadEmail}` }));
  json(
    await c.patch(`/api/v2/campaigns/${created.id}`, {
      email_list: senders.map((a) => a.email),
      campaign_schedule: ALWAYS_OPEN,
      sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}</p>" }] }] }],
      ...extra,
    }),
  );
  json(await c.post("/api/v2/leads", { email: leadEmail, first_name: "Pat", campaign: created.id }));
  expectStatus(await c.post(`/api/v2/campaigns/${created.id}/activate`), 200);
  await db.update(schema.campaigns).set({ status: CampaignStatus.PAUSED }).where(and(eq(schema.campaigns.status, CampaignStatus.ACTIVE), ne(schema.campaigns.id, created.id)));
  return created.id as string;
}

const sent = async (campaignId: string) =>
  (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.type, "sent")))).length;
const notSending = async (campaignId: string) => (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)))[0]!.notSendingStatus;

/** Makes the sandbox refuse sends from one mailbox; returns the undo. */
function failSendsFrom(email: string, error: MailError) {
  const real = SandboxDriver.prototype.send;
  SandboxDriver.prototype.send = async function (this: SandboxDriver, msg: OutgoingMessage) {
    if (msg.from.address.toLowerCase() === email) throw error;
    return real.call(this, msg);
  };
  return () => {
    SandboxDriver.prototype.send = real;
  };
}

// ---------- Warmup ----------

describe("warmup pool", () => {
  it("pairs real mailboxes with real ones and sandbox mailboxes with sandbox ones", async () => {
    const boxes = await sandbox(user, 2, "pool-sandbox.test", true);
    const warmup = { ...defaultWarmup(), limit: 10, increment: "disabled" };
    const real = await db
      .insert(A)
      .values(
        ["ana@real-one.test", "ben@real-two.test"].map((email) => ({
          workspaceId: wsId,
          email,
          providerCode: ProviderCode.CUSTOM,
          smtp: { host: "smtp.example.test", port: 587, secure: false, user: email },
          imap: { host: "imap.example.test", port: 993, secure: true, user: email },
          warmupStatus: WarmupStatus.ACTIVE,
          warmup,
          warmupStartedAt: new Date(),
        })),
      )
      .returning();
    await onlyWarming([...boxes, ...real]);

    const realSends: Array<{ from: string; to: string }> = [];
    const realSend = SmtpImapDriver.prototype.send;
    SmtpImapDriver.prototype.send = async (msg: OutgoingMessage) => {
      realSends.push({ from: msg.from.address, to: msg.to[0]!.address });
      return { messageId: msg.messageId, response: "250 OK (stub)", accepted: msg.to.map((t) => t.address), rejected: [] };
    };
    try {
      // Midday on the workspace clock, inside real mailboxes' warmup hours.
      await runWarmup(startOfDayOn(AWAY_ZONE) + 12 * 3_600_000);
    } finally {
      SmtpImapDriver.prototype.send = realSend;
    }

    const realEmails = new Set(real.map((a) => a.email));
    assert.deepEqual(realSends.map((s) => s.from).sort(), [...realEmails].sort(), "each real mailbox sends one warmup email");
    for (const s of realSends) assert.ok(realEmails.has(s.to) && s.to !== s.from, `${s.from} wrote to another real mailbox, not ${s.to}`);
    const ids = [...boxes, ...real].map((a) => a.id);
    const messages = await db.select().from(schema.warmupMessages).where(inArray(schema.warmupMessages.senderAccountId, ids));
    const realIds = new Set(real.map((a) => a.id));
    assert.equal(messages.length, 4);
    for (const m of messages) assert.equal(realIds.has(m.senderAccountId), realIds.has(m.recipientAccountId), "warmup stays within its world");

    // The account sheet can say when a mailbox has no one to warm up with.
    const partners = async () => json(await user.client.get(`/api/v2/accounts/${encodeURIComponent(real[0]!.email)}`)).warmup_partners;
    assert.equal(await partners(), 1);
    await onlyWarming([...boxes, real[0]!]);
    assert.equal(await partners(), 0, "the sandbox mailboxes don't count");
    await onlyWarming([]);
  });

  it("leaves out mailboxes that are paused, failing, being set up, or in a deleted or disabled workspace", async () => {
    const [ok, failing, paused, settingUp, resting] = await sandbox(user, 5, "pool-states.test", true);
    await db.update(A).set({ status: AccountStatus.CONNECTION_ERROR }).where(eq(A.id, failing!.id));
    await db.update(A).set({ status: AccountStatus.PAUSED }).where(eq(A.id, paused!.id));
    await db.update(A).set({ setupPending: true }).where(eq(A.id, settingUp!.id));
    await db.update(A).set({ campaignPauseUntil: new Date(Date.now() + 86_400_000) }).where(eq(A.id, resting!.id));

    const gone = await signUp(app, { workspaceName: "Gone Co" });
    const [inDeleted] = await sandbox(gone, 1, "pool-deleted.test", true);
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, gone.workspaceId!));
    const off = await signUp(app, { workspaceName: "Off Co" });
    const [ofDisabled] = await sandbox(off, 1, "pool-disabled.test", true);
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, off.id));

    await onlyWarming([ok!, failing!, paused!, settingUp!, resting!, inDeleted!, ofDisabled!]);
    const pool = new Set((await warmupPool()).map((a) => a.id));
    assert.deepEqual([...pool].sort(), [ok!.id, resting!.id].sort(), "resting only keeps campaigns away");
    await onlyWarming([]);
  });

  it("warms up a mailbox connected in two workspaces once, from the connection that started first", async () => {
    const twinCo = await signUp(app, { workspaceName: "Twin Co" });
    await setZone(twinCo.workspaceId!, AWAY_ZONE);
    const [first] = await realBoxes(["twin@twin-co.test"], wsId, { warmupStartedAt: new Date(Date.now() - 2 * 86_400_000) });
    const [second] = await realBoxes(["twin@twin-co.test"], twinCo.workspaceId!);
    const [pal] = await realBoxes(["pal@pal-co.test"]);
    await onlyWarming([first!, second!, pal!]);
    const { sends, undo } = stubRealSends();
    try {
      await runWarmup(startOfDayOn(AWAY_ZONE) + 12 * 3_600_000);
    } finally {
      undo();
      await onlyWarming([]);
    }
    assert.deepEqual(
      sends.filter((s) => s.from === "twin@twin-co.test").map((s) => s.to),
      ["pal@pal-co.test"],
      "one warmup email from the address, not two",
    );
    const fromTwin = await db.select().from(schema.warmupMessages).where(inArray(schema.warmupMessages.senderAccountId, [first!.id, second!.id]));
    assert.deepEqual(
      fromTwin.map((m) => m.senderAccountId),
      [first!.id],
    );
    // Its sheet in the second workspace says where its warmup runs.
    await db.update(A).set({ warmupStatus: WarmupStatus.ACTIVE }).where(inArray(A.id, [first!.id, second!.id]));
    const sheet = async (u: TestUser) => json(await u.client.get(`/api/v2/accounts/${encodeURIComponent("twin@twin-co.test")}`)).warmup_elsewhere;
    assert.equal(await sheet(twinCo), true);
    assert.equal(await sheet(user), false);
    await onlyWarming([]);
  });
});

describe("warmup ramp", () => {
  it("Recommended starts small, grows every day and reaches the limit", () => {
    const rec = { limit: 40, increment: "0" };
    const days = warmupRampDays(rec);
    assert.equal(warmupTarget(rec, 0), 2);
    assert.ok(warmupTarget(rec, 1) > warmupTarget(rec, 0));
    for (let d = 1; d <= days; d++) assert.ok(warmupTarget(rec, d) >= warmupTarget(rec, d - 1));
    assert.equal(warmupTarget(rec, days), 40);
    assert.ok(days <= 14, `reaches 40 in ${days} days`);
    assert.equal(warmupTarget({ limit: 10, increment: "0" }, 8), 10);
    assert.equal(warmupTarget({ limit: 10, increment: "0" }, 4), 6);
    assert.equal(warmupTarget({ limit: 10, increment: "disabled" }, 0), 10, "no ramp: the full amount from day one");
    assert.equal(warmupTarget({ limit: 30, increment: "4" }, 2), 10);
  });

  it("sends warmup only up to today's target", async () => {
    const [q, partner] = await sandbox(user, 2, "ramp.test", true);
    await db.update(A).set({ warmup: { ...defaultWarmup(), limit: 20, increment: "2" } }).where(eq(A.id, q!.id));
    await onlyWarming([q!, partner!]);
    for (const back of [1, 2, 3]) await setStats(q!, daysBefore(today(), back), { warmupSent: 1 });
    await setStats(q!, today(), { warmupSent: 8 });

    const fromQ = async () => (await db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.senderAccountId, q!.id))).length;
    await runWarmup();
    assert.equal(await fromQ(), 0, "three days in at +2 a day: 8 today, already sent");

    const account = json(await user.client.get(`/api/v2/accounts/${encodeURIComponent(q!.email)}`));
    assert.equal(account.warmup_target_today, 8);
    assert.equal(account.warmup_days, 3);

    await setStats(q!, today(), { warmupSent: 7 });
    await runWarmup();
    assert.equal(await fromQ(), 1);
    await onlyWarming([]);
  });

  it("counts replies toward the daily limit: past it, a reply waits for tomorrow", async () => {
    const [r, o] = await sandbox(user, 2, "reply-limit.test", true);
    await db.update(A).set({ warmup: { ...defaultWarmup(), limit: 5, increment: "disabled" } }).where(eq(A.id, r!.id));
    await onlyWarming([r!, o!]);
    await setStats(r!, today(), { warmupSent: 5 });
    const W = schema.warmupMessages;
    const [owed] = await db
      .insert(W)
      .values({ senderAccountId: o!.id, recipientAccountId: r!.id, messageId: "<owed@reply-limit.test>", subject: "Quick sync", tag: "warmup", sentAt: new Date(Date.now() - 3_600_000), replyDueAt: new Date(Date.now() - 60_000) })
      .returning();
    const fromR = async () => db.select().from(W).where(eq(W.senderAccountId, r!.id));

    await runWarmup();
    assert.equal((await fromR()).length, 0, "five of five sent today: no reply");
    assert.equal((await db.select().from(W).where(eq(W.id, owed!.id)))[0]!.replied, false, "the reply is still owed");

    await setStats(r!, today(), { warmupSent: 4 });
    await runWarmup();
    const sentByR = await fromR();
    assert.deepEqual(
      sentByR.map((m) => [m.isReply, m.inReplyTo]),
      [[true, "<owed@reply-limit.test>"]],
      "room for one: the owed reply goes first, nothing new on top",
    );
    await onlyWarming([]);
  });

  it("real mailboxes send warmup only between 6 AM and 10 PM, even when behind for the day", async () => {
    const boxes = await realBoxes(["late@late-one.test", "night@late-two.test"]);
    await onlyWarming(boxes);
    const { sends, undo } = stubRealSends();
    try {
      await runWarmup(startOfDayOn(AWAY_ZONE) + 23 * 3_600_000);
      assert.equal(sends.length, 0, "11 PM: none, though nothing went out today");
      await runWarmup(startOfDayOn(AWAY_ZONE) + 21 * 3_600_000);
      assert.equal(sends.length, 2, "9 PM: one each");
    } finally {
      undo();
      await onlyWarming([]);
    }
  });

  it("an owed reply waits out the weekend with weekdays only", async () => {
    const [k, o] = await sandbox(user, 2, "weekday-replies.test", true);
    await db.update(A).set({ warmup: { ...defaultWarmup(), advanced: { ...defaultWarmup().advanced, weekday_only: true } } }).where(eq(A.id, k!.id));
    await onlyWarming([k!, o!]);
    // Friday noon in UTC is already Saturday at UTC+14.
    const fridayNoonUtc = Date.UTC(2026, 9, 9, 12, 0);
    const W = schema.warmupMessages;
    const [owed] = await db
      .insert(W)
      .values({
        senderAccountId: o!.id,
        recipientAccountId: k!.id,
        messageId: "<owed@weekday-replies.test>",
        subject: "Lunch?",
        tag: "warmup",
        sentAt: new Date(fridayNoonUtc - 3_600_000),
        processedAt: new Date(fridayNoonUtc - 3_000_000),
        replyDueAt: new Date(fridayNoonUtc - 60_000),
      })
      .returning();
    const repliesFromK = async () => (await db.select().from(W).where(and(eq(W.senderAccountId, k!.id), eq(W.isReply, true)))).length;
    try {
      await setZone(wsId, "Etc/GMT-14");
      await runWarmup(fridayNoonUtc);
      assert.equal(await repliesFromK(), 0);
      assert.equal((await db.select().from(W).where(eq(W.id, owed!.id)))[0]!.replied, false, "still owed");
      await setZone(wsId, "UTC");
      await runWarmup(fridayNoonUtc);
      assert.equal(await repliesFromK(), 1);
    } finally {
      await setZone(wsId, AWAY_ZONE);
      await onlyWarming([]);
    }
  });

  it("a reply that fails to send stays owed and is tried again later, once per pass", async () => {
    const [f, o] = await sandbox(user, 2, "reply-fails.test", true);
    await db.update(A).set({ warmup: { ...defaultWarmup(), limit: 10, increment: "disabled" } }).where(eq(A.id, f!.id));
    await onlyWarming([f!, o!]);
    const W = schema.warmupMessages;
    const owed = await db
      .insert(W)
      .values(
        [1, 2].map((n) => ({
          senderAccountId: o!.id,
          recipientAccountId: f!.id,
          messageId: `<owed-${n}@reply-fails.test>`,
          subject: `Question ${n}`,
          tag: "warmup",
          sentAt: new Date(Date.now() - 3_600_000),
          processedAt: new Date(Date.now() - 3_000_000),
          replyDueAt: new Date(Date.now() - n * 60_000),
        })),
      )
      .returning();
    const undoFail = failSendsFrom(f!.email, new MailError("connection", "Connection timed out"));
    try {
      await runWarmup();
    } finally {
      undoFail();
    }
    const after = await db.select().from(W).where(inArray(W.id, owed.map((m) => m.id)));
    assert.deepEqual(
      after.map((m) => m.replied),
      [false, false],
      "nothing dropped",
    );
    assert.equal((await row(f!.id)).consecutiveErrors, 1, "tried once, not once per owed reply");
    await runWarmup(Date.now() + 31 * 60_000);
    const replies = await db.select().from(W).where(and(eq(W.senderAccountId, f!.id), eq(W.isReply, true)));
    assert.deepEqual(replies.map((m) => m.inReplyTo).sort(), ["<owed-1@reply-fails.test>", "<owed-2@reply-fails.test>"]);
    await onlyWarming([]);
  });

  it("weekdays only follows the workspace's weekend", async () => {
    const [k, partner] = await sandbox(user, 2, "weekdays.test", true);
    await db.update(A).set({ warmup: { ...defaultWarmup(), advanced: { ...defaultWarmup().advanced, weekday_only: true } } }).where(eq(A.id, k!.id));
    await onlyWarming([k!, partner!]);
    const fromK = async () => (await db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.senderAccountId, k!.id))).length;
    // Friday noon in UTC is already Saturday at UTC+14.
    const fridayNoonUtc = Date.UTC(2026, 9, 9, 12, 0);
    try {
      await setZone(wsId, "Etc/GMT-14");
      await runWarmup(fridayNoonUtc);
      assert.equal(await fromK(), 0);
      await setZone(wsId, "UTC");
      await runWarmup(fridayNoonUtc);
      assert.equal(await fromK(), 1);
    } finally {
      await setZone(wsId, AWAY_ZONE);
      await onlyWarming([]);
    }
  });
});

// ---------- The workspace clock ----------

describe("workspace clock", () => {
  it("dates a mailbox's counters on the workspace's day, not UTC's", async () => {
    const [m] = await sandbox(user, 1, "clock-day.test");
    await bumpAccountStat(wsId, m!.id, "sent");
    const rows = await db.select().from(S).where(eq(S.accountId, m!.id));
    assert.deepEqual(
      rows.map((r) => r.date),
      [today()],
    );
    assert.notEqual(today(), new Date().toISOString().slice(0, 10));
    assert.equal(json(await user.client.get(`/api/v2/accounts/${encodeURIComponent(m!.email)}`)).sent_today, 1);
  });

  it("a mailbox's daily limit counts the workspace's day", async () => {
    const [fresh, full] = await sandbox(user, 2, "clock-cap.test");
    const utcDay = new Date().toISOString().slice(0, 10);
    for (const a of [fresh!, full!]) json(await user.client.patch(`/api/v2/accounts/${encodeURIComponent(a.email)}`, { daily_limit: 3 }));
    await setStats(fresh!, utcDay, { sent: 3 }); // UTC's date is another day on the workspace clock
    await setStats(full!, today(), { sent: 3 });

    const freshCampaign = await campaign([fresh!], "lead-cap-fresh@example.test");
    await runSender();
    assert.equal(await sent(freshCampaign), 1);

    const fullCampaign = await campaign([full!], "lead-cap-full@example.test");
    await runSender();
    assert.equal(await sent(fullCampaign), 0);
    assert.equal(await notSending(fullCampaign), CampaignNotSendingStatus.ACCOUNTS_DAILY_LIMIT);
  });

  it("a campaign's daily limit resets at the workspace's midnight", async () => {
    const [x, y] = await sandbox(user, 2, "clock-campaign.test");
    const midnight = startOfDayOn(AWAY_ZONE);
    const withEarlierSend = async (sender: AccountRow, leadEmail: string, at: number) => {
      const id = await campaign([sender], leadEmail, { daily_limit: 1 });
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
      await db
        .insert(schema.emailEvents)
        .values({ workspaceId: wsId, campaignId: id, leadId: lead!.id, leadEmail: "earlier@example.test", type: "sent", step: 0, variant: 0, createdAt: new Date(at) });
      return id;
    };

    const yesterday = await withEarlierSend(x!, "lead-before-midnight@example.test", midnight - 60_000);
    await runSender();
    assert.equal(await sent(yesterday), 2, "a send just before midnight was yesterday's");

    const todays = await withEarlierSend(y!, "lead-after-midnight@example.test", midnight + 60_000);
    await runSender();
    assert.equal(await sent(todays), 1, "a send just after midnight uses up today's limit of 1");
    assert.equal(await notSending(todays), CampaignNotSendingStatus.CAMPAIGN_DAILY_LIMIT);
    const status = json(await user.client.get(`/api/v2/campaigns/${todays}/sending-status`));
    assert.equal(status.diagnostics.sent_today, 1);
  });

  it("slow ramp counts from the mailbox's first campaign email, not when it was added", async () => {
    const [m] = await sandbox(user, 1, "slow-ramp.test");
    json(await user.client.patch(`/api/v2/accounts/${encodeURIComponent(m!.email)}`, { daily_limit: 50, enable_slow_ramp: true }));
    await db.update(A).set({ createdAt: new Date(Date.now() - 60 * 86_400_000) }).where(eq(A.id, m!.id));
    const limitToday = async () => json(await user.client.get(`/api/v2/accounts/${encodeURIComponent(m!.email)}`)).daily_limit_today;
    assert.equal(await limitToday(), SLOW_RAMP.start, "added two months ago but never sent: day one");
    await setStats(m!, daysBefore(today(), 3), { sent: 4 });
    assert.equal(await limitToday(), SLOW_RAMP.start + 3 * SLOW_RAMP.step);
  });
});

// ---------- Sending failures ----------

describe("sending failures", () => {
  it("a failed login takes the mailbox out of sending until sending works again", async () => {
    const [m] = await sandbox(user, 1, "fail-login.test");
    const [hook] = await db.insert(schema.webhooks).values({ workspaceId: wsId, targetHookUrl: "https://hooks.invalid/account-errors", eventType: "account_error" }).returning();
    const id = await campaign([m!], "lead-login@example.test");
    const undo = failSendsFrom(m!.email, new MailError("auth", "535 5.7.8 Username and password not accepted", { responseCode: 535 }));
    try {
      await runSender();
    } finally {
      undo();
    }
    assert.equal(await sent(id), 0);
    let r = await row(m!.id);
    assert.equal(r.status, AccountStatus.CONNECTION_ERROR);
    assert.equal(errorState(r.statusMessage)?.sides?.smtp?.code, "auth");
    assert.equal((await db.select().from(S).where(and(eq(S.accountId, m!.id), eq(S.date, today()))))[0]?.sendErrors, 1, "counts against health");

    await settle();
    const mine = () => events.filter((e) => e.data.account_id === m!.id);
    assert.equal(mine().length, 1);
    assert.deepEqual({ ...mine()[0]!.data, error: undefined }, { account_id: m!.id, email: m!.email, error: undefined, kind: "smtp", code: "auth", status: AccountStatus.CONNECTION_ERROR });
    assert.match(String(mine()[0]!.data.error), /not accepted/);
    const queued = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.webhookId, hook!.id));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.eventType, "account_error");
    assert.equal(queued[0]!.payload.kind, "smtp");
    assert.equal(queued[0]!.payload.email_account, m!.email);

    // The inbox still syncs fine, which says nothing about sending.
    await syncAccount(r);
    r = await row(m!.id);
    assert.equal(r.status, AccountStatus.CONNECTION_ERROR);

    // Failing the same way again doesn't announce it again.
    await recordAccountError(r, "auth", "535 5.7.8 Username and password not accepted");
    await settle();
    assert.equal(mine().length, 1);

    // Re-tested: not before 15 minutes, then sending works and the mailbox is back.
    await recheckSendingFailures(Date.now() + 5 * 60_000);
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
    await recheckSendingFailures(Date.now() + 16 * 60_000);
    r = await row(m!.id);
    assert.equal(r.status, AccountStatus.ACTIVE);
    assert.equal(r.statusMessage, null);

    // Failing again within six hours of the last alert takes it out again, without another alert.
    await recordAccountError(r, "auth", "535 5.7.8 Username and password not accepted");
    await settle();
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
    assert.equal(mine().length, 1);
    assert.equal((await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.webhookId, hook!.id))).length, 1);
  });

  it("a test email that goes out puts the mailbox back", async () => {
    const [m] = await sandbox(user, 1, "fail-test-email.test");
    await recordAccountError(m!, "auth", "535 Authentication failed");
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
    const res = json(await user.client.post(`/api/app/accounts/${encodeURIComponent(m!.email)}/test-email`, { to: "check@example.test" }));
    assert.equal(res.ok, true);
    assert.equal((await row(m!.id)).status, AccountStatus.ACTIVE);
  });

  it("a provider's sending limit waits hours before the mailbox is tried again", async () => {
    const [m] = await sandbox(user, 1, "fail-quota.test");
    await recordAccountError(m!, "quota", "550 5.4.5 Daily user sending quota exceeded");
    assert.equal((await row(m!.id)).status, AccountStatus.SENDING_ERROR);
    await recheckSendingFailures(Date.now() + 3_600_000);
    assert.equal((await row(m!.id)).status, AccountStatus.SENDING_ERROR);
    await recheckSendingFailures(Date.now() + 7 * 3_600_000);
    assert.equal((await row(m!.id)).status, AccountStatus.ACTIVE);
  });

  it("a good send clears a run of connection failures; a paused mailbox stays paused", async () => {
    const [m, p] = await sandbox(user, 2, "fail-connection.test");
    await recordAccountError(m!, "connection", "Connection timed out");
    let r = await row(m!.id);
    assert.equal(r.status, AccountStatus.ACTIVE, "one dropped connection doesn't take it out");
    assert.equal(r.consecutiveErrors, 1);
    const id = await campaign([m!], "lead-connection@example.test");
    await runSender();
    assert.equal(await sent(id), 1);
    r = await row(m!.id);
    assert.equal(r.consecutiveErrors, 0);
    assert.equal(r.statusMessage, null);

    await db.update(A).set({ status: AccountStatus.PAUSED }).where(eq(A.id, p!.id));
    await recordAccountError(await row(p!.id), "auth", "535 Authentication failed");
    assert.equal((await row(p!.id)).status, AccountStatus.CONNECTION_ERROR);
    await recheckSendingFailures(Date.now() + 16 * 60_000);
    assert.equal((await row(p!.id)).status, AccountStatus.PAUSED);
  });

  it("a mailbox paused after an earlier blip stays paused once sending works again", async () => {
    const [m] = await sandbox(user, 1, "blip-then-pause.test");
    await recordAccountError(m!, "connection", "Connection timed out");
    assert.equal((await row(m!.id)).status, AccountStatus.ACTIVE, "one blip doesn't take it out");
    await db.update(A).set({ status: AccountStatus.PAUSED }).where(eq(A.id, m!.id));
    await recordAccountError(await row(m!.id), "auth", "535 Authentication failed");
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
    await recheckSendingFailures(Date.now() + 16 * 60_000);
    assert.equal((await row(m!.id)).status, AccountStatus.PAUSED);
  });

  it("sending that keeps failing is re-tested less and less often, and not once its workspace is gone", async () => {
    const [m] = await sandbox(user, 1, "retest-backoff.test");
    const gone = await signUp(app, { workspaceName: "Retest Gone Co" });
    const [g] = await sandbox(gone, 1, "retest-gone.test");
    await recordAccountError(m!, "auth", "535 Authentication failed");
    await recordAccountError(g!, "auth", "535 Authentication failed");
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, gone.id));
    forgetStoppedWorkspaces();
    const tried: string[] = [];
    const real = SandboxDriver.prototype.verifySmtp;
    SandboxDriver.prototype.verifySmtp = async function (this: SandboxDriver) {
      tried.push((this as unknown as { acc: { email: string } }).acc.email);
      return { ok: false, error: "535 Authentication failed", code: "auth" };
    };
    const mine = () => tried.filter((e) => e === m!.email || e === g!.email);
    try {
      await recheckSendingFailures(Date.now() + 16 * 60_000);
      assert.deepEqual(mine(), [m!.email], "a turned-off account's mailbox isn't tried");
      // Failed again: the next test waits twice as long (30 minutes), the one after twice that.
      await recheckSendingFailures(Date.now() + 29 * 60_000);
      assert.equal(mine().length, 1);
      await recheckSendingFailures(Date.now() + 31 * 60_000);
      assert.equal(mine().length, 2);
      await recheckSendingFailures(Date.now() + 59 * 60_000);
      assert.equal(mine().length, 2);
      await recheckSendingFailures(Date.now() + 61 * 60_000);
      assert.equal(mine().length, 3);
    } finally {
      SandboxDriver.prototype.verifySmtp = real;
    }
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
  });

  it("an inbox that can't log in is flagged on its own side and cleared by a good sync", async () => {
    const [m] = await sandbox(user, 1, "fail-inbox.test");
    const realOpen = SandboxDriver.prototype.open;
    SandboxDriver.prototype.open = async function (this: SandboxDriver) {
      throw new MailError("auth", "Invalid credentials (Failure)");
    };
    try {
      await syncAccount(m!);
    } finally {
      SandboxDriver.prototype.open = realOpen;
    }
    const r = await row(m!.id);
    assert.equal(r.status, AccountStatus.CONNECTION_ERROR);
    assert.deepEqual(Object.keys(errorState(r.statusMessage)?.sides ?? {}), ["imap"]);
    await settle();
    assert.equal(events.find((e) => e.data.account_id === m!.id)?.data.kind, "imap");
    await syncAccount(r);
    assert.equal((await row(m!.id)).status, AccountStatus.ACTIVE);
  });

  it("tells a refused mailbox apart from a refused recipient", () => {
    const kind = (e: Record<string, unknown>) => classifyError(Object.assign(new Error(String(e.response)), e)).kind;
    assert.equal(kind({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550, response: "550 5.1.1 <pat@example.test>: Recipient address rejected: User unknown" }), "recipient");
    assert.equal(kind({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550, response: "550 5.7.1 Sender address rejected: not owned by user" }), "rejected");
    assert.equal(kind({ code: "EMESSAGE", command: "DATA", responseCode: 554, response: "554 5.7.1 Message rejected: sending from this account is blocked" }), "rejected");
    assert.equal(kind({ code: "EMESSAGE", command: "DATA", responseCode: 550, response: "550 5.1.1 The email account that you tried to reach does not exist" }), "recipient");
    assert.equal(kind({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 5.7.8 Username and password not accepted" }), "auth");
  });
});

describe("refusals while sending", () => {
  /** A refusal as nodemailer reports it. */
  const refusal = (command: string, response: string) =>
    classifyError(Object.assign(new Error(response), { code: "EENVELOPE", command, response, responseCode: Number(response.slice(0, 3)) }));
  /** A mailbox with no sending gap, so each pass may try again at once. */
  async function eager(domain: string) {
    const [m] = await sandbox(user, 1, domain);
    await db.update(A).set({ sendingGap: 0 }).where(eq(A.id, m!.id));
    return (await row(m!.id)) as AccountRow;
  }
  const leadOf = async (campaignId: string) => (await db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaignId)))[0]!;
  const bounces = async (campaignId: string) => db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.type, "bounce")));

  it("a full mailbox is tried again a day later, and counts as bounced after three tries", async () => {
    const m = await eager("refused-full.test");
    const id = await campaign([m], "full-mailbox@example.test", { email_gap: 0, random_wait_max: 0 });
    const undo = failSendsFrom(m.email, refusal("RCPT TO", "452 4.2.2 The email account that you tried to reach is over quota"));
    try {
      await runSender();
      let lead = await leadOf(id);
      assert.equal(lead.status, 1, "still active");
      assert.ok(lead.nextSendAt! > Date.now() + 23 * 3_600_000, "tried again tomorrow");
      assert.deepEqual((await bounces(id)).map((b) => b.value), [0]);
      for (let i = 0; i < 2; i++) {
        await db.update(schema.leads).set({ nextSendAt: Date.now() - 1000 }).where(eq(schema.leads.id, lead.id));
        await runSender();
      }
      lead = await leadOf(id);
      assert.equal(lead.status, -1, "bounced on the third try");
      assert.deepEqual((await bounces(id)).map((b) => b.value).sort(), [0, 0, 1]);
    } finally {
      undo();
    }
    assert.equal((await row(m.id)).status, AccountStatus.ACTIVE, "the mailbox did nothing wrong");
  });

  it("a refused sender takes the mailbox out of sending, not the lead", async () => {
    const m = await eager("refused-sender.test");
    const id = await campaign([m], "fine-lead@example.test", { email_gap: 0, random_wait_max: 0 });
    const undo = failSendsFrom(m.email, refusal("RCPT TO", "553 5.7.1 <x@refused-sender.test>: Sender address rejected: not owned by user"));
    try {
      await runSender();
    } finally {
      undo();
    }
    const lead = await leadOf(id);
    assert.equal(lead.status, 1);
    assert.equal((await bounces(id)).length, 0);
    assert.equal((await row(m.id)).status, AccountStatus.SENDING_ERROR);
  });

  it("a refused try waits out the sending gap like a send", async () => {
    const [m] = await sandbox(user, 1, "refused-gap.test");
    const id = await campaign([m!], "gone-1@example.test");
    json(await user.client.post("/api/v2/leads", { email: "gone-2@example.test", campaign: id }));
    const undo = failSendsFrom(m!.email, refusal("RCPT TO", "550 5.1.1 <x@example.test>: Recipient address rejected: User unknown"));
    try {
      await runSender();
      await runSender();
    } finally {
      undo();
    }
    assert.equal((await bounces(id)).length, 1, "one try, then the mailbox waits");
  });

  it("a bounce notice about a copied address leaves the lead alone", async () => {
    const [m] = await sandbox(user, 1, "copied-bounce.test");
    const id = await campaign([m!], "copied-lead@example.test", { bcc_list: ["bounce.crm@example.test"] });
    await runSender();
    assert.equal(await sent(id), 1);
    await syncAccount((await row(m!.id)) as AccountRow);
    const notices = await db.select().from(schema.emails).where(and(eq(schema.emails.accountId, m!.id), eq(schema.emails.isBounce, true)));
    assert.equal(notices.length, 1, "the notice is filed");
    assert.notEqual((await leadOf(id)).status, -1);
    assert.equal((await bounces(id)).length, 0, "and doesn't count against the campaign");
  });

  it("a Google sign-in that's refused is a login failure; not reaching Google is a connection one", async () => {
    const realFetch = globalThis.fetch;
    const tokens = { provider: "google" as const, access_token: "expired", refresh_token: "stored", expires_at: 0 };
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })) as typeof fetch;
      await assert.rejects(freshAccessToken(tokens), (e: MailError) => e.kind === "auth" && /expired or revoked\. Connect the mailbox again/.test(e.message) && /Testing/.test(e.message));
      globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      await assert.rejects(freshAccessToken(tokens), (e: MailError) => e.kind === "connection");
      await assert.rejects(freshAccessToken({ ...tokens, refresh_token: null }), (e: MailError) => e.kind === "auth");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------- Health ----------

describe("signing in again with Google or Microsoft", () => {
  const identity = (email: string, token: string) => ({
    email,
    first_name: "Mo",
    last_name: "Lane",
    tokens: { access_token: token, refresh_token: `${token}-refresh`, expires_at: Date.now() + 3_600_000, provider: "google" as const },
  });

  it("clears the login failure and keeps a paused mailbox paused", async () => {
    const email = "mo.paused@signin-again.test";
    const first = await upsertOAuthAccount(wsId, user.id, identity(email, "test-token-one"), { enableWarmup: false });
    assert.equal(first.created, true);
    await db.update(A).set({ status: AccountStatus.PAUSED, folders: { inbox: "INBOX", spam: "[Gmail]/Spam", sent: null, trash: null, archive: null, important: null, all: "[Gmail]/All Mail", checked_at: Date.now() } }).where(eq(A.id, first.id));
    await recordAccountError(await row(first.id), "auth", "Google refused the sign-in (invalid_grant)");
    assert.equal((await row(first.id)).status, AccountStatus.CONNECTION_ERROR);

    const again = await upsertOAuthAccount(wsId, user.id, identity(email, "test-token-two"), { enableWarmup: false });
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);
    const r = await row(first.id);
    assert.equal(r.status, AccountStatus.PAUSED, "paused before the failure: paused after");
    assert.equal(r.consecutiveErrors, 0);
    assert.equal(errorState(r.statusMessage), null);
    assert.equal(r.folders?.inbox, "INBOX", "same server: folders kept");
  });

  it("puts a failing mailbox back to work", async () => {
    const email = "mo.failing@signin-again.test";
    const first = await upsertOAuthAccount(wsId, user.id, identity(email, "test-token-three"), { enableWarmup: false });
    await recordAccountError(await row(first.id), "auth", "Google refused the sign-in (invalid_grant)");
    assert.equal((await row(first.id)).status, AccountStatus.CONNECTION_ERROR);
    await upsertOAuthAccount(wsId, user.id, identity(email, "test-token-four"), { enableWarmup: false });
    assert.equal((await row(first.id)).status, AccountStatus.ACTIVE);
  });
});

describe("test mailboxes", () => {
  it("live at a domain of their workspace's own: another workspace can't make some at the same one", async () => {
    await sandbox(user, 1, "taken-domain.test");
    const other = await signUp(app, { workspaceName: "Copycat Co" });
    const copy = await other.client.post("/api/app/accounts/sandbox", { count: 1, domain: "taken-domain.test", enable_warmup: false });
    expectStatus(copy, 409);
    assert.match(copy.body, /Another workspace/);
    expectStatus(await other.client.post("/api/app/accounts/sandbox", { count: 1, domain: "not a domain", enable_warmup: false }), 400);
    const own = json(await other.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email as string;
    assert.match(own, /^alex@copycat-co-[a-z0-9]{4}\.test$/);
  });
});

describe("system health", () => {
  it("counts an inbox as late by how often it's synced, and not at all once its workspace is gone", async () => {
    const quiet = await signUp(app, { workspaceName: "Quiet Co" });
    const [q] = await sandbox(quiet, 1, "health-quiet.test");
    await db.update(A).set({ lastSyncAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(A.id, q!.id));
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, quiet.id));
    forgetStoppedWorkspaces();
    // Can't send, but its inbox is fine: it's still synced every few seconds, so seven minutes is late.
    const [s] = await sandbox(user, 1, "health-sending.test");
    await recordAccountError(s!, "auth", "535 Authentication failed");
    await db.update(A).set({ lastSyncAt: new Date(Date.now() - 7 * 60_000) }).where(eq(A.id, s!.id));
    const items = (await systemHealth()).inbox_sync.items;
    assert.equal(
      items.find((i) => i.email === q!.email),
      undefined,
    );
    assert.equal(items.find((i) => i.email === s!.email)?.late, true);
  });
});

describe("mailbox health", () => {
  it("scores bounces, replies, failed sends and warmup placement, and says what's wrong", () => {
    const base = { sent: 0, bounced: 0, refused: 0, replies: 0, sendErrors: 0, warmupSent: 0, warmupInbox: 0, warmupSpam: 0 };
    assert.equal(scoreHealth(base).score, null);
    assert.equal(scoreHealth(base).status, "unknown");
    assert.equal(scoreHealth({ ...base, sent: 3, sendErrors: 1 }).score, null, "one failure among a few sends is noise");

    const good = scoreHealth({ ...base, sent: 120, replies: 4, warmupSent: 60, warmupInbox: 58, warmupSpam: 1 });
    assert.equal(good.status, "healthy");
    assert.deepEqual(good.issues, []);

    const bouncing = scoreHealth({ ...base, sent: 200, bounced: 12, replies: 0 });
    assert.equal(bouncing.status, "at_risk");
    assert.equal(bouncing.bounce_rate, 6);
    assert.match(bouncing.issues[0]!, /6% of campaign emails hard-bounced/);
    assert.match(bouncing.issues[1]!, /No replies to 200 campaign emails/);

    const spammy = scoreHealth({ ...base, warmupSent: 40, warmupInbox: 30, warmupSpam: 10 });
    assert.equal(spammy.warmup_inbox_rate, 75);
    assert.match(spammy.issues[0]!, /25% of warmup emails landed in spam/);

    const failing = scoreHealth({ ...base, sent: 40, sendErrors: 10 });
    assert.match(failing.issues[0]!, /10 of 50 sends failed/);
    assert.ok(failing.score! < 70);
  });

  it("shows in the list, sorts worst first, and has a daily trend", async () => {
    const [good, bad, quiet] = await sandbox(user, 3, "health-check.test");
    await setStats(good!, today(), { sent: 100, replies: 5, warmupSent: 30, warmupInbox: 30 });
    await setStats(bad!, today(), { sent: 100, bounced: 8 });

    const list = json(await user.client.get("/api/v2/accounts?search=health-check.test&sort_by=health_score&sort_order=asc"));
    assert.deepEqual(
      list.items.map((a: { email: string }) => a.email),
      [bad!.email, good!.email, quiet!.email],
      "worst first, no score last",
    );
    assert.equal(list.items[0].health.status, "at_risk");
    assert.match(list.items[0].health.issues[0], /hard-bounced/);
    assert.equal(list.items[1].health.score, 100);
    assert.equal(list.items[2].health.score, null);

    const report = json(await user.client.get(`/api/app/accounts/${encodeURIComponent(bad!.email)}/health`));
    assert.equal(report.timezone, AWAY_ZONE);
    assert.equal(report.trend.length, 30);
    assert.equal(report.trend.at(-1).date, today());
    assert.equal(report.trend.at(-1).score, report.health.score);
    assert.equal(report.trend.at(-1).bounced, 8);
    assert.equal(report.trend[0].score, null, "a month ago there was nothing to judge");

    const summary = json(await user.client.get("/api/app/accounts/summary"));
    assert.ok(summary.at_risk >= 1);
    assert.equal(typeof summary.health_score, "number");
  });

  it("resting keeps campaigns away while warmup carries on", async () => {
    const [r, partner] = await sandbox(user, 2, "resting.test", true);
    const id = await campaign([r!], "lead-resting@example.test");
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    json(await user.client.patch(`/api/v2/accounts/${encodeURIComponent(r!.email)}`, { campaign_pause_until: until }));

    await runSender();
    assert.equal(await sent(id), 0);
    assert.equal(await notSending(id), CampaignNotSendingStatus.ACCOUNTS_UNAVAILABLE);
    const status = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.ok(status.summary.reasons.includes("Every sending account has an error, is paused or is resting."));
    assert.equal(status.diagnostics.accounts.items[0].resting_until, until);

    await onlyWarming([r!, partner!]);
    assert.ok((await warmupPool()).some((a) => a.id === r!.id));
    await onlyWarming([]);

    json(await user.client.patch(`/api/v2/accounts/${encodeURIComponent(r!.email)}`, { campaign_pause_until: null }));
    await runSender();
    assert.equal(await sent(id), 1);
  });
});

// ---------- Provider ----------

describe("provider from the servers", () => {
  it("Gmail's or Microsoft 365's servers make a Google or Microsoft mailbox, however it was added", () => {
    assert.equal(providerForHosts("imap.gmail.com", "smtp.gmail.com"), ProviderCode.GOOGLE);
    assert.equal(providerForHosts("outlook.office365.com", "smtp.office365.com"), ProviderCode.MICROSOFT);
    assert.equal(providerForHosts("IMAP.GMAIL.COM.", "relay.example.test"), ProviderCode.GOOGLE);
    assert.equal(providerForHosts("imap.mail.us-east-1.awsapps.com", "email-smtp.us-east-1.amazonaws.com"), ProviderCode.AWS);
    assert.equal(providerForHosts("mail.notgmail.com", "gmail.com.example.test"), ProviderCode.CUSTOM);
    assert.equal(providerForHosts("203.0.113.25", undefined), ProviderCode.CUSTOM);
  });

  it("a mailbox moved onto other servers takes their provider", async () => {
    const email = "moving.provider@mailbox-co.example.test";
    const created = json(await user.client.post("/api/v2/accounts", { email, imap_host: "203.0.113.25", smtp_host: "203.0.113.25", imap_password: "test-only-pass-7", skip_connection_test: true }));
    assert.equal(created.provider_code, ProviderCode.CUSTOM);
    // As if it had been on Gmail's servers until now.
    await db.update(A).set({ providerCode: ProviderCode.GOOGLE }).where(eq(A.email, email));
    const moved = json(await user.client.patch(`/api/v2/accounts/${encodeURIComponent(email)}`, { imap_host: "203.0.113.26", smtp_host: "203.0.113.26", imap_password: "test-only-pass-8" }));
    assert.equal(moved.provider_code, ProviderCode.CUSTOM);
  });
});
