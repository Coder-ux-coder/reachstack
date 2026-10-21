// Analytics figures that add up: bounce rates out of every email tried (one the receiving server refused at once was
// never sent, yet it bounced) and never over 100%, a bounce-protection pause that keeps its own numbers, the funnel and
// the overview's status counts, unsubscribes from a subsequence's emails, the feed's first open of each email, Copilot's
// whole campaign list, the slow ramp-up in the sending check, and a date with a time in a mailbox's daily figures.
// Mailboxes are sandboxes and the one send is stubbed: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CUSTOM_INTEREST_BASE, CampaignStatus, LeadStatus, scoreHealth } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { SandboxDriver } from "../src/mail/sandbox";
import { recentBounceStats } from "../src/services/campaigns";
import { invokerFor } from "../src/services/copilot/invoke";
import { DEFAULT_SETTINGS } from "../src/services/copilot/settings";
import { TOOL_BY_NAME } from "../src/services/copilot/tools";
import { emailToken } from "../src/services/tracking";

const E = schema.emailEvents;
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const ONE_STEP = [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}</p>" }] }] }];

let app: FastifyInstance;
let user: TestUser;
let ws: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Ari", workspaceName: "Rates Co" });
  ws = user.workspaceId!;
});
after(stopServer);

const campaign = async (name: string) => json(await user.client.post("/api/app/campaigns", { name })).id as string;
const mailbox = async (domain: string) => json(await user.client.post("/api/app/accounts/sandbox", { count: 1, domain, enable_warmup: false })).items[0].email as string;

/** A campaign sending from `box` to one lead, launched. */
async function launched(name: string, box: string, leadEmail: string, extra: Record<string, unknown> = {}) {
  const id = await campaign(name);
  json(await user.client.patch(`/api/v2/campaigns/${id}`, { email_list: [box], campaign_schedule: ALWAYS_OPEN, sequences: ONE_STEP, ...extra }));
  json(await user.client.post("/api/v2/leads", { email: leadEmail, first_name: "Pat", campaign: id }));
  expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
  return id;
}

describe("bounce rates", () => {
  it("count an address refused at once as a try, and a bounce notice nobody could match as a bounce only", async () => {
    const id = await campaign("Refusals");
    const ev = (type: string, extra: Partial<typeof E.$inferInsert> = {}) => ({ workspaceId: ws, campaignId: id, leadEmail: "x@rates.example.test", type, ...extra });
    await db.insert(E).values([
      ...Array.from({ length: 90 }, () => ev("sent", { step: 0 })),
      // Refused by the receiving server when sent: a try, and a hard bounce.
      ...Array.from({ length: 10 }, () => ev("bounce", { step: 0, value: 1 })),
      // Bounce notices that matched no email: bounces, not more tries.
      ...Array.from({ length: 5 }, () => ev("bounce", { value: 1 })),
    ]);
    assert.deepEqual(await recentBounceStats(id), { sent: 100, bounced: 15, rate: 15 });
  });

  it("keep the numbers behind a bounce-protection pause, however long ago it was", async () => {
    const id = await campaign("Paused long ago");
    const longAgo = new Date(Date.now() - 12 * 86_400_000);
    const ev = (type: string, i: number, value: number | null = null) => ({ workspaceId: ws, campaignId: id, leadEmail: `p${i}@paused.example.test`, type, step: 0, emailId: `paused-email-${i}`, value, createdAt: longAgo });
    await db.insert(E).values([...Array.from({ length: 200 }, (_, i) => ev("sent", i)), ...Array.from({ length: 20 }, (_, i) => ev("bounce", i, 1))]);
    await db.update(schema.campaigns).set({ status: CampaignStatus.BOUNCE_PROTECT }).where(eq(schema.campaigns.id, id));
    assert.deepEqual(json(await user.client.get(`/api/v2/campaigns/${id}`)).bounce_stats, { sent: 200, bounced: 20, rate: 10 });
    assert.equal((await recentBounceStats(id)).sent, 0, "nothing in the last week");
  });

  it("are out of every email a mailbox tried, in the bounce report, the mailbox totals and the campaign list", async () => {
    const id = await campaign("Mostly refused");
    const box = "box@mostly-refused.example.test";
    const ev = (type: string, extra: Partial<typeof E.$inferInsert> = {}) => ({ workspaceId: ws, campaignId: id, leadEmail: "z@rates.example.test", accountEmail: box, type, step: 0, ...extra });
    // 10 sent, 30 refused when sent: 30 hard bounces out of 40 tries.
    await db.insert(E).values([...Array.from({ length: 10 }, () => ev("sent")), ...Array.from({ length: 30 }, () => ev("bounce", { value: 1 }))]);

    const report = json(await user.client.get(`/api/app/campaigns/${id}/bounces`));
    const row = report.mailboxes.find((m: { email: string }) => m.email === box);
    assert.deepEqual([row.sent, row.tried, row.hard, row.hard_rate], [10, 40, 30, 75]);
    assert.deepEqual(
      report.steps.map((s: { step: number; tried: number; hard: number }) => [s.step, s.tried, s.hard]),
      [[0, 40, 30]],
    );

    const totals = json(await user.client.get("/api/app/accounts/analytics/totals"));
    const mine = totals.find((t: { email: string }) => t.email === box);
    assert.deepEqual([mine.sent, mine.refused, mine.bounced], [10, 30, 30]);

    const [listed] = json(await user.client.get(`/api/v2/campaigns/analytics?id=${id}`));
    assert.deepEqual([listed.emails_sent_count, listed.emails_refused_count], [10, 30]);
    assert.equal(json(await user.client.get(`/api/v2/campaigns/analytics/overview?id=${id}`)).emails_refused_count, 30);
  });

  it("are out of the emails tried in a mailbox's health, too", () => {
    const base = { sent: 0, bounced: 0, refused: 0, replies: 0, sendErrors: 0, warmupSent: 0, warmupInbox: 0, warmupSpam: 0 };
    const h = scoreHealth({ ...base, sent: 10, refused: 30, bounced: 30 });
    assert.deepEqual([h.tried, h.bounce_rate], [40, 75]);
    assert.match(h.issues[0]!, /^75% of campaign emails hard-bounced/);
    // A bounce of an email sent before the period can't make it more than all of them.
    assert.equal(scoreHealth({ ...base, sent: 20, bounced: 25 }).bounce_rate, 100);
  });

  it("count a refusal toward the mailbox's tries the moment it happens", async () => {
    const box = await mailbox("refusing-box.test");
    const id = await launched("Refused at once", box, "gone@refusing-lead.test");
    const realSend = SandboxDriver.prototype.send;
    SandboxDriver.prototype.send = async () => {
      throw Object.assign(new Error("Message failed: 550 5.1.1 User unknown"), {
        code: "EENVELOPE",
        command: "RCPT TO",
        response: "550 5.1.1 <gone@refusing-lead.test>: Recipient address rejected: User unknown",
        responseCode: 550,
      });
    };
    try {
      await runSender();
    } finally {
      SandboxDriver.prototype.send = realSend;
    }
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    assert.equal(lead!.status, LeadStatus.BOUNCED);
    const [account] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, box));
    const days = await db.select().from(schema.accountDailyStats).where(eq(schema.accountDailyStats.accountId, account!.id));
    assert.deepEqual(
      days.map((d) => [d.sent, d.bounced, d.refused]),
      [[0, 1, 1]],
    );
  });
});

describe("the sending check", () => {
  it("says the slow ramp-up is what stopped today's sending", async () => {
    const box = await mailbox("ramping-box.test");
    const id = await launched("Ramping up", box, "next@ramp.example.test", { slow_ramp_up: true, daily_limit: 500 });
    // Its first day: the ramp's 20 have gone out.
    await db.insert(E).values(Array.from({ length: 20 }, (_, i) => ({ workspaceId: ws, campaignId: id, leadEmail: `r${i}@ramp.example.test`, accountEmail: box, type: "sent", step: 0 })));
    const s = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.equal(s.diagnostics.daily_limit, 20);
    assert.equal(s.summary.is_sending, false);
    assert.ok(
      s.summary.reasons.some((r: string) => /slow ramp-up allows 20 emails today/.test(r)),
      JSON.stringify(s.summary.reasons),
    );
  });
});

describe("lead statuses in analytics", () => {
  it("count a positive label of your own as interest in the funnel, as for opportunities", async () => {
    const id = await campaign("Own labels");
    const [lead] = await db.insert(schema.leads).values({ workspaceId: ws, campaignId: id, email: "hot@labels.example.test" }).returning();
    const ev = (type: string, value: number | null = null) => ({ workspaceId: ws, campaignId: id, leadId: lead!.id, leadEmail: lead!.email, type, value, step: 0 });
    await db.insert(E).values([ev("sent"), ev("interest_change", CUSTOM_INTEREST_BASE.positive + 1), ev("opportunity", 0)]);
    assert.equal(json(await user.client.get(`/api/app/analytics/funnel?id=${id}`)).interested, 1);
    assert.equal(json(await user.client.get(`/api/v2/campaigns/analytics/overview?id=${id}`)).total_opportunities, 1);
  });

  it("count every change of status when asked to (expand_crm_events), and each lead once by default", async () => {
    const id = await campaign("Status changes");
    const [lead] = await db.insert(schema.leads).values({ workspaceId: ws, campaignId: id, email: "deal@labels.example.test", interestStatus: 4, lastInterestChangeAt: new Date() }).returning();
    const ev = (type: string, value: number) => ({ workspaceId: ws, campaignId: id, leadId: lead!.id, leadEmail: lead!.email, type, value });
    await db.insert(E).values([ev("interest_change", 1), ev("opportunity", 500), ev("interest_change", 2), ev("interest_change", 4)]);
    const totals = async (expand: boolean) => {
      const o = json(await user.client.get(`/api/v2/campaigns/analytics/overview?id=${id}${expand ? "&expand_crm_events=true" : ""}`));
      return [o.total_opportunities, o.total_interested, o.total_meeting_booked, o.total_meeting_completed, o.total_closed];
    };
    assert.deepEqual(await totals(false), [1, 0, 0, 0, 1], "each lead once, where it is now");
    assert.deepEqual(await totals(true), [1, 1, 1, 0, 1], "every change");
  });
});

describe("a subsequence's analytics", () => {
  it("count an unsubscribe from one of its emails", async () => {
    const id = await campaign("With a follow-up flow");
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Interested", conditions: { crm_status: [1] } }));
    const [lead] = await db
      .insert(schema.leads)
      .values({ workspaceId: ws, campaignId: id, email: "leaving@sub-unsub.example.test", subsequenceId: sub.id, subseqStatus: LeadStatus.ACTIVE })
      .returning();
    const [email] = await db
      .insert(schema.emails)
      .values({ workspaceId: ws, messageId: "<leaving@sub-unsub.example.test>", eaccount: "box@sub-unsub.example.test", ueType: 1, timestampEmail: new Date(), campaignId: id, subsequenceId: sub.id, leadId: lead!.id, leadEmail: lead!.email })
      .returning();
    const res = await app.inject({ method: "POST", url: `/u/${emailToken(email!.id)}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    expectStatus(res, 200);
    assert.equal(json(await user.client.get(`/api/app/subsequences/${sub.id}/overview`)).metrics.unsubscribed_count, 1);
  });
});

describe("the activity feed", () => {
  it("shows the first open of each email, not only a lead's first open ever", async () => {
    const id = await campaign("Opened twice");
    const [lead] = await db.insert(schema.leads).values({ workspaceId: ws, campaignId: id, email: "reader@feed.example.test" }).returning();
    const open = (emailId: string, isFirst: boolean) => ({ workspaceId: ws, campaignId: id, leadId: lead!.id, leadEmail: lead!.email, type: "open", emailId, step: 0, isFirst });
    // As opens are recorded: the first email opened twice, then the second once; only the very first is the lead's first.
    for (const e of [open("feed-email-1", true), open("feed-email-1", false), open("feed-email-2", false)]) await db.insert(E).values(e);
    const feed = json(await user.client.get(`/api/app/activity-feed?campaign_id=${id}&types=open`));
    assert.deepEqual(feed.items.map((i: { email_id: string }) => i.email_id).sort(), ["feed-email-1", "feed-email-2"]);
  });
});

describe("Copilot's workspace overview", () => {
  it("counts the campaigns (the list gives at most 100 a page)", async () => {
    await campaign("Counted by Copilot");
    const ctx = { wsId: ws, userId: user.id, threadId: "none", timezone: "UTC", settings: DEFAULT_SETTINGS, invoke: invokerFor(user.client.cookie!, ws) };
    const out = (await TOOL_BY_NAME.get("get_workspace_overview")!.run({} as never, ctx)) as { content: { campaigns: { total?: number; unavailable?: string } } };
    const [{ n }] = (await db.select({ n: count() }).from(schema.campaigns).where(eq(schema.campaigns.workspaceId, ws))) as [{ n: number }];
    assert.equal(out.content.campaigns.unavailable, undefined);
    assert.equal(out.content.campaigns.total, n);
  });
});

describe("a mailbox's daily figures", () => {
  it("take an end date with a time, and turn away one that isn't a date", async () => {
    const box = await mailbox("daily-figures.test");
    const path = (end: string) => `/api/v2/accounts/analytics/daily?emails=${encodeURIComponent(box)}&end_date=${encodeURIComponent(end)}`;
    expectStatus(await user.client.get(path("2026-10-17T10:00:00Z")), 200);
    expectStatus(await user.client.get(path("not-a-date")), 400);
  });
});
