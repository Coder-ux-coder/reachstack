// The sending engine with a sandbox mailbox (delivers locally, never to the internet): what it refuses to send.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { CampaignNotSendingStatus, CampaignStatus, EspCode, LeadStatus, SubsequenceActivity, VerificationStatus } from "@reachstack/shared";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { parseInbound } from "../src/mail/parse";
import { handleBounce, unsubscribeFromCampaign } from "../src/services/activity";
import { emit } from "../src/services/bus";
import { enrollInSubsequence } from "../src/services/subsequences";
import { bounceReason } from "../src/services/bounce-report";
import { runPendingJobs } from "../src/engine/jobs";
import { detectLeadEsps, verifyAndStore } from "../src/services/verification";
import { forgetWorkspaceZones } from "../src/services/workspace-clock";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });

let app: FastifyInstance;
let user: TestUser;
let sender: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Sending Co" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

async function campaignWithLead(name: string, leadEmail: string) {
  const c = user.client;
  const campaign = json(await c.post("/api/app/campaigns", { name }));
  json(await c.patch(`/api/v2/campaigns/${campaign.id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, sequences: [{ steps: [step("Hi {{firstName}}", "<p>Hello {{firstName}}</p>")] }] }));
  json(await c.post("/api/v2/leads", { email: leadEmail, first_name: "Pat", campaign: campaign.id }));
  return campaign.id as string;
}

const sentCount = async (campaignId: string) =>
  (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.type, "sent"), isNull(schema.emailEvents.subsequenceId)))).length;

describe("empty steps", () => {
  it("a campaign whose step was emptied after launch sends nothing and says why", async () => {
    const id = await campaignWithLead("Emptied later", "emptied@example.test");
    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [step("Hi", "<p><br></p>")] }] }));
    await runSender();
    assert.equal(await sentCount(id), 0);
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${id}`)).not_sending_status, 6);

    // Written again, the waiting lead gets the email.
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [step("Hi", "<p>Back again</p>")] }] }));
    await db.update(schema.leads).set({ nextSendAt: null }).where(eq(schema.leads.campaignId, id));
    await runSender();
    assert.equal(await sentCount(id), 1);
  });

  it("a campaign can't launch with an empty step", async () => {
    const id = await campaignWithLead("Never written", "never@example.test");
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [step("Hi", "")] }] }));
    const res = await user.client.post(`/api/v2/campaigns/${id}/activate`);
    expectStatus(res, 400);
    assert.match(json(res, 400).message, /empty email body/);
  });
});

describe("subsequences", () => {
  it("start as drafts and only run once their emails are written", async () => {
    const parent = await campaignWithLead("With a follow-up", "follow@example.test");
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: parent, name: "Interested", conditions: { crm_status: [1] } }));
    assert.equal(sub.status, 0);

    const blocked = await user.client.post(`/api/v2/subsequences/${sub.id}/resume`);
    expectStatus(blocked, 400);
    assert.match(json(blocked, 400).message, /Step 1 has an empty email body/);

    // A reply in the thread may leave the subject empty; the body is what matters.
    json(await user.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: [{ steps: [step("", "<p>Great, here's a time that works</p>")] }] }));
    assert.equal(json(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`)).status, 1);
  });

  it("don't count toward the campaign's own step numbers", async () => {
    const parent = await campaignWithLead("Stats apart", "stats@example.test");
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: parent, name: "Follow-up", conditions: { crm_status: [1] } }));
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, parent));
    const [ws] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, parent));
    await db.insert(schema.emailEvents).values([
      { workspaceId: ws!.workspaceId, campaignId: parent, leadId: lead!.id, leadEmail: lead!.email, type: "sent", step: 0, variant: 0 },
      { workspaceId: ws!.workspaceId, campaignId: parent, subsequenceId: sub.id, leadId: lead!.id, leadEmail: lead!.email, type: "sent", step: 0, variant: 0 },
    ]);
    const steps = json<Array<{ step: string | number; sent: number }>>(await user.client.get(`/api/v2/campaigns/analytics/steps?campaign_id=${parent}`));
    assert.equal(steps.find((s) => Number(s.step) === 0)?.sent, 1);
  });
});

describe("a lead in a subsequence", () => {
  let mailbox: string;
  before(async () => {
    // A mailbox of its own, so the earlier tests' sends don't keep it waiting out its gap.
    mailbox = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
  });

  /** A campaign with these leads, each in a running two-step subsequence (the campaign running subsequences). */
  async function inSubsequence(name: string, emails: string[], conditions: Record<string, unknown> = { crm_status: [1] }) {
    const parent = await campaignWithLead(name, emails[0]!);
    json(await user.client.patch(`/api/v2/campaigns/${parent}`, { email_list: [mailbox], email_gap: 0, random_wait_max: 0 }));
    for (const email of emails.slice(1)) json(await user.client.post("/api/v2/leads", { email, first_name: "Lee", campaign: parent }));
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: parent, name: `${name}: follow-up`, conditions }));
    json(await user.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: [{ steps: [step("", "<p>One more thing</p>"), step("", "<p>And another</p>")] }] }));
    json(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`));
    await db.update(schema.campaigns).set({ status: CampaignStatus.RUNNING_SUBSEQUENCES }).where(eq(schema.campaigns.id, parent));
    const [row] = await db.select().from(schema.subsequences).where(eq(schema.subsequences.id, sub.id));
    return { parent, sub: row! };
  }
  const leadsOf = (campaignId: string) => db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaignId));
  const subSends = async (subId: string) => (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.subsequenceId, subId), eq(schema.emailEvents.type, "sent")))).length;
  const due = (campaignId: string) => db.update(schema.leads).set({ subseqNextSendAt: Date.now() - 1_000 }).where(eq(schema.leads.campaignId, campaignId));

  it("gets nothing more once the address bounces or leaves the campaign, and the campaign can finish", async () => {
    const { parent, sub } = await inSubsequence("Ends in a subsequence", ["sub.bounce@example.test", "sub.leaves@example.test"]);
    for (const l of await leadsOf(parent)) await enrollInSubsequence(l, sub);
    const bounced = (await leadsOf(parent)).find((l) => l.email === "sub.bounce@example.test")!;
    await handleBounce({ workspaceId: bounced.workspaceId, lead: bounced, campaignId: parent, accountId: null, accountEmail: null, hard: true });
    await unsubscribeFromCampaign({ workspaceId: bounced.workspaceId, email: "sub.leaves@example.test", campaignId: parent });
    // Whatever wakes the subsequence up again (its steps edited, a resume), nothing goes out to them.
    await due(parent);
    await runSender();
    assert.equal(await subSends(sub.id), 0);
    assert.deepEqual(
      (await leadsOf(parent)).map((l) => [l.email, l.status, l.subseqStatus]).sort(),
      [
        ["sub.bounce@example.test", LeadStatus.BOUNCED, LeadStatus.BOUNCED],
        ["sub.leaves@example.test", LeadStatus.UNSUBSCRIBED, LeadStatus.UNSUBSCRIBED],
      ],
    );
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${parent}`)).status, CampaignStatus.COMPLETED, "not running subsequences for good");
  });

  it("is paused, resumed and marked completed there too", async () => {
    const { parent, sub } = await inSubsequence("Paused in a subsequence", ["sub.paused@example.test"]);
    const [lead] = await leadsOf(parent);
    await enrollInSubsequence(lead!, sub);
    const status = (action: string) => user.client.post("/api/app/leads/status", { ids: [lead!.id], action });
    json(await status("pause"));
    assert.equal((await leadsOf(parent))[0]!.subseqStatus, LeadStatus.PAUSED);
    await due(parent);
    await runSender();
    assert.equal(await subSends(sub.id), 0, "nothing while paused");
    json(await status("resume"));
    await runSender();
    assert.equal(await subSends(sub.id), 1, "carries on once resumed");
    json(await status("mark_completed"));
    assert.equal((await leadsOf(parent))[0]!.subseqStatus, LeadStatus.COMPLETED);
  });

  it("isn't started by an open once the lead has replied", async () => {
    const { parent, sub } = await inSubsequence("Opened follow-up", ["opened.replied@example.test", "opened.quiet@example.test"], { lead_activity: [SubsequenceActivity.EMAIL_OPENED] });
    const leads = await leadsOf(parent);
    const replied = leads.find((l) => l.email === "opened.replied@example.test")!;
    await db.update(schema.leads).set({ replyCount: 1 }).where(eq(schema.leads.id, replied.id));
    for (const l of leads) emit("email_opened", l.workspaceId, { lead_id: l.id, campaign_id: parent });
    await new Promise((r) => setTimeout(r, 150));
    const after = await leadsOf(parent);
    assert.equal(after.find((l) => l.id === replied.id)!.subsequenceId, null, "in a conversation already");
    assert.equal(after.find((l) => l.id !== replied.id)!.subsequenceId, sub.id);
  });
});

/** A delivery status notification as a mail server sends it. */
function dsn(opts: { subject: string; action: string; status: string; recipient: string }) {
  return Buffer.from(
    [
      "From: Mail Delivery Subsystem <mailer-daemon@example.test>",
      "To: sam@example.test",
      `Subject: ${opts.subject}`,
      "Message-ID: <dsn-1@example.test>",
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
      "Reporting-MTA: dns; mx.example.test",
      "",
      `Final-Recipient: rfc822; ${opts.recipient}`,
      `Action: ${opts.action}`,
      `Status: ${opts.status}`,
      "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

describe("bounces", () => {
  it("tell hard bounces, soft bounces and delay notices apart", async () => {
    const hard = await parseInbound(dsn({ subject: "Delivery Status Notification (Failure)", action: "failed", status: "5.1.1", recipient: "gone@example.test" }));
    assert.equal(hard.bounce?.kind, "hard");
    assert.equal(hard.bounce?.recipient, "gone@example.test");
    const full = await parseInbound(dsn({ subject: "Delivery Status Notification (Failure)", action: "failed", status: "5.2.2", recipient: "full@example.test" }));
    assert.equal(full.bounce?.kind, "soft");
    const delay = await parseInbound(dsn({ subject: "Delivery Status Notification (Delay)", action: "delayed", status: "4.4.7", recipient: "slow@example.test" }));
    assert.equal(delay.bounce?.kind, "delayed");
    assert.equal(delay.bounce?.hard, false);
  });

  it("a hard bounce stops the same address in every campaign, and keeps the reason", async () => {
    const a = await campaignWithLead("Bounce A", "gone@example.test");
    const b = await campaignWithLead("Bounce B", "gone@example.test");
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, a));
    await handleBounce({ workspaceId: lead!.workspaceId, lead: lead!, campaignId: a, accountId: null, accountEmail: null, hard: true, status: "5.1.1", diagnostic: "smtp; 550 5.1.1 no such user" });
    const [other] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, b));
    assert.equal(other!.status, -1);
    const [ev] = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, a), eq(schema.emailEvents.type, "bounce")));
    assert.equal(ev!.detail, "5.1.1 · smtp; 550 5.1.1 no such user");

    // Someone added later with that address is skipped, not emailed.
    const c = await campaignWithLead("Bounce C", "gone@example.test");
    // Its own mailbox, so the earlier tests' sending gap doesn't hold this one back.
    const fresh = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    json(await user.client.patch(`/api/v2/campaigns/${c}`, { email_list: [fresh] }));
    expectStatus(await user.client.post(`/api/v2/campaigns/${c}/activate`), 200);
    await runSender();
    assert.equal(await sentCount(c), 0);
    const [later] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, c));
    assert.equal(later!.status, -1);
  });

  it("protection pauses on hard bounces over the week, not soft ones, and gives a week's grace after a resume", async () => {
    const id = await campaignWithLead("Protected", "protected@example.test");
    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    const ev = (type: string, value: number | null = null) => ({ workspaceId: lead!.workspaceId, campaignId: id, leadEmail: "x@example.test", type, value });
    const status = async () => json(await user.client.get(`/api/v2/campaigns/${id}`)).status as number;

    // 250 sent, 30 soft bounces and 10 hard ones (4%): below the 5% default.
    await db.insert(schema.emailEvents).values([...Array.from({ length: 250 }, () => ev("sent")), ...Array.from({ length: 30 }, () => ev("bounce", 0)), ...Array.from({ length: 10 }, () => ev("bounce", 1))]);
    await runSender();
    assert.equal(await status(), 1);

    // Five more hard bounces: 6%.
    await db.insert(schema.emailEvents).values(Array.from({ length: 5 }, () => ev("bounce", 1)));
    await runSender();
    assert.equal(await status(), -2);
    const paused = json(await user.client.get(`/api/v2/campaigns/${id}`));
    assert.equal(paused.bounce_stats.bounced, 15);

    // Resumed on purpose: not paused again straight away.
    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    await runSender();
    assert.equal(await status(), 1);
    assert.ok(Date.parse(json(await user.client.get(`/api/v2/campaigns/${id}`)).bounce_grace_until) > Date.now() + 6 * 86_400_000);
  });
});

describe("verify on import", () => {
  it("queues a verification run, and the leads stop waiting once it ends", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Verified import" }));
    const res = json(
      await user.client.post("/api/v2/leads/add", {
        campaign_id: campaign.id,
        verify_leads_on_import: true,
        leads: [{ email: "good.person@example.test" }, { email: "invalid.person@example.test" }],
      }),
    );
    assert.equal(res.leads_uploaded, 2);
    const before = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaign.id));
    assert.deepEqual(before.map((l) => l.verificationStatus), [12, 12]);
    const jobs = await db.select().from(schema.backgroundJobs).where(and(eq(schema.backgroundJobs.type, "verify-leads"), eq(schema.backgroundJobs.workspaceId, before[0]!.workspaceId)));
    assert.equal(jobs.length, 1);

    await runPendingJobs();
    for (let i = 0; i < 50; i++) {
      const [job] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, jobs[0]!.id));
      if (job!.status === "success" || job!.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = Object.fromEntries((await db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaign.id))).map((l) => [l.email, l.verificationStatus]));
    assert.deepEqual(after, { "good.person@example.test": 1, "invalid.person@example.test": -1 });
  });

  it("an address checked recently gives a new lead the earlier verdict, for free", async () => {
    await verifyAndStore(user.workspaceId!, "checked.before@example.test");
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Verified twice" }));
    json(await user.client.post("/api/v2/leads/add", { campaign_id: campaign.id, verify_leads_on_import: true, leads: [{ email: "checked.before@example.test" }] }));
    const [job] = await db.select().from(schema.backgroundJobs).where(and(eq(schema.backgroundJobs.type, "verify-leads"), sql`json_extract(${schema.backgroundJobs.data}, '$.campaign_id') = ${campaign.id}`));
    assert.ok(job, "a verification run was queued");
    await runPendingJobs();
    for (let i = 0; i < 50; i++) {
      const [now] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id));
      if (now!.status === "success" || now!.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaign.id));
    assert.equal(lead!.verificationStatus, VerificationStatus.VERIFIED, "not left as unverified because the answer came from the cache");
  });
});

describe("launch checks", () => {
  it("warn about unknown variables, a short gap and a limit the mailboxes can't reach", async () => {
    const c = user.client;
    const campaign = json(await c.post("/api/app/campaigns", { name: "Checked launch" }));
    json(
      await c.patch(`/api/v2/campaigns/${campaign.id}`, {
        email_list: [sender],
        campaign_schedule: ALWAYS_OPEN,
        email_gap: 1,
        daily_limit: 5000,
        sequences: [{ steps: [step("Hi {{firstName}}", "<p>Hello {{fristName}}, {{firstName|there}}</p>"), step("", "<p>Following up {{fristName}}</p>")] }],
      }),
    );
    json(await c.post("/api/v2/leads", { email: "checked@example.test", first_name: "Pat", campaign: campaign.id }));
    const check = json(await c.get(`/api/app/campaigns/${campaign.id}/launch-check`));
    assert.equal(check.ready, true);
    const text = check.warnings.join("\n");
    assert.match(text, /\{\{fristName\}\} in steps 1 and 2 isn't a lead field/);
    assert.doesNotMatch(text, /\{\{firstName\}\} in/);
    assert.match(text, /every minute/);
    assert.match(text, /may send 5000 emails a day/);
  });

  it("the preview lists template problems as text", async () => {
    const id = await campaignWithLead("Preview warnings", "preview@example.test");
    const p = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { subject: "Hi", body: "<p>Hello {{fristName}}</p>" }));
    assert.deepEqual(p.warnings, ["{{fristName}} isn't a field this lead has, so it's left empty."]);
  });
});

describe("A/B variants", () => {
  const twoVariants = { type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "A {{firstName}}", body: "<p>Version A</p>" }, { subject: "B {{firstName}}", body: "<p>Version B</p>" }] };
  const variantCounts = async (campaignId: string) => {
    const rows = await db.select({ variant: schema.emailEvents.variant }).from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.type, "sent")));
    return [rows.filter((r) => r.variant === 0).length, rows.filter((r) => r.variant === 1).length];
  };
  async function abCampaign(name: string, leads: number, extra: Record<string, unknown> = {}) {
    const c = user.client;
    const mailbox = json(await c.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    // No pause between this mailbox's emails, so a few sender passes send them all.
    await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
    const campaign = json(await c.post("/api/app/campaigns", { name }));
    json(await c.patch(`/api/v2/campaigns/${campaign.id}`, { email_list: [mailbox], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps: [twoVariants] }], ...extra }));
    for (let i = 0; i < leads; i++) json(await c.post("/api/v2/leads", { email: `${name.toLowerCase().replace(/\W+/g, ".")}.${i}@example.test`, first_name: "Pat", campaign: campaign.id }));
    expectStatus(await c.post(`/api/v2/campaigns/${campaign.id}/activate`), 200);
    return campaign.id as string;
  }
  async function sendAll(id: string, total: number) {
    for (let i = 0; i < 30; i++) {
      const [a, b] = await variantCounts(id);
      if (a + b >= total) return;
      await runSender();
    }
  }
  /**
   * Past sends and replies for a step, as if the campaign had been running for a while: the variants took turns, one
   * send a second, ending `daysAgo` days ago (a week by default, so they don't count toward today's limits).
   */
  async function history(id: string, perVariant: Array<{ sent: number; replies: number }>, daysAgo = 7) {
    const [row] = await db.select({ ws: schema.campaigns.workspaceId }).from(schema.campaigns).where(eq(schema.campaigns.id, id));
    const end = Date.now() - daysAgo * 86_400_000;
    const rounds = Math.max(...perVariant.map((v) => v.sent));
    const values = [];
    for (let i = 0; i < rounds; i++) {
      for (const [variant, v] of perVariant.entries()) {
        const createdAt = new Date(end - (rounds - i) * perVariant.length * 1000 + variant * 1000);
        if (i < v.sent) values.push({ workspaceId: row!.ws, type: "sent", campaignId: id, leadId: `past-${daysAgo}-${variant}-${i}`, step: 0, variant, createdAt });
        if (i < v.replies) values.push({ workspaceId: row!.ws, type: "reply", campaignId: id, leadId: `past-${daysAgo}-${variant}-${i}`, step: 0, variant, createdAt });
      }
    }
    for (let i = 0; i < values.length; i += 200) await db.insert(schema.emailEvents).values(values.slice(i, i + 200));
  }
  const withRandom = async (value: number, fn: () => Promise<void>) => {
    const real = Math.random;
    Math.random = () => value;
    try {
      await fn();
    } finally {
      Math.random = real;
    }
  };

  it("take turns, so the split stays even", async () => {
    const id = await abCampaign("Even split", 10);
    await sendAll(id, 10);
    assert.deepEqual(await variantCounts(id), [5, 5]);
  });

  it("only pick a winner once there's something to compare", async () => {
    const quiet = await abCampaign("No signal yet", 4, { auto_variant_select: { trigger: "reply_rate" } });
    await history(quiet, [
      { sent: 60, replies: 0 },
      { sent: 60, replies: 2 },
    ]);
    await withRandom(0.5, () => sendAll(quiet, 124));
    const [a, b] = await variantCounts(quiet);
    assert.deepEqual([a - 60, b - 60], [2, 2]);

    const clear = await abCampaign("Clear winner", 4, { auto_variant_select: { trigger: "reply_rate" } });
    await history(clear, [
      { sent: 60, replies: 1 },
      { sent: 60, replies: 6 },
    ]);
    await withRandom(0.5, () => sendAll(clear, 124));
    const [ca, cb] = await variantCounts(clear);
    assert.deepEqual([ca - 60, cb - 60], [0, 4]);
  });

  it("a variant added later catches up over the latest sends, not by taking every send", async () => {
    const three = { ...twoVariants, variants: [...twoVariants.variants, { subject: "C {{firstName}}", body: "<p>Version C</p>" }] };
    const id = await abCampaign("Added later", 3, { sequences: [{ steps: [three] }] });
    // A and B ran alone for a month; C joined last week and has taken its turns since.
    await history(id, [{ sent: 500, replies: 0 }, { sent: 500, replies: 0 }], 30);
    await history(id, [{ sent: 20, replies: 0 }, { sent: 20, replies: 0 }, { sent: 20, replies: 0 }]);
    const counts = async () => {
      const rows = await db.select({ variant: schema.emailEvents.variant }).from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, id), eq(schema.emailEvents.type, "sent")));
      return [0, 1, 2].map((v) => rows.filter((r) => r.variant === v).length);
    };
    for (let i = 0; i < 10 && (await counts()).reduce((a, b) => a + b, 0) < 1063; i++) await runSender();
    assert.deepEqual(await counts(), [521, 521, 21], "one each, not all three to C");
  });

  it("don't judge by opens when open tracking is off", async () => {
    const id = await abCampaign("Opens untracked", 4, { auto_variant_select: { trigger: "open_rate" }, open_tracking: false });
    await history(id, [
      { sent: 60, replies: 0 },
      { sent: 60, replies: 0 },
    ]);
    const [row] = await db.select({ ws: schema.campaigns.workspaceId }).from(schema.campaigns).where(eq(schema.campaigns.id, id));
    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    await db.insert(schema.emailEvents).values(Array.from({ length: 20 }, (_, i) => ({ workspaceId: row!.ws, type: "open", campaignId: id, leadId: `past-0-${i}`, step: 0, variant: 0, createdAt: lastWeek })));
    await withRandom(0.5, () => sendAll(id, 124));
    const [a, b] = await variantCounts(id);
    assert.deepEqual([a - 60, b - 60], [2, 2]);
  });
});

describe("the sending queue", () => {
  /** A one- or two-step campaign from its own new mailboxes (no sending gap), with these leads, launched. */
  async function queued(name: string, opts: { mailboxes?: number; leads: string[]; steps?: number; extra?: Record<string, unknown> }) {
    const c = user.client;
    const mailboxes: string[] = json(await c.post("/api/app/accounts/sandbox", { count: opts.mailboxes ?? 1, enable_warmup: false })).items.map((i: { email: string }) => i.email);
    await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(inArray(schema.emailAccounts.email, mailboxes));
    const campaign = json(await c.post("/api/app/campaigns", { name }));
    const steps = opts.steps === 2 ? [step("Hi", "<p>One</p>"), step("", "<p>Two</p>")] : [step("Hi", "<p>One</p>")];
    json(await c.patch(`/api/v2/campaigns/${campaign.id}`, { email_list: mailboxes, campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps }], ...opts.extra }));
    for (const email of opts.leads) json(await c.post("/api/v2/leads", { email, campaign: campaign.id }));
    if (opts.leads.length) expectStatus(await c.post(`/api/v2/campaigns/${campaign.id}/activate`), 200);
    const ids = await db.select({ id: schema.emailAccounts.id, email: schema.emailAccounts.email }).from(schema.emailAccounts).where(inArray(schema.emailAccounts.email, mailboxes));
    return { id: campaign.id as string, mailboxes: mailboxes.map((m) => ids.find((r) => r.email === m)!.id) };
  }
  const leadBy = async (email: string) => (await db.select().from(schema.leads).where(eq(schema.leads.email, email)))[0]!;

  it("follow-ups waiting for their own mailbox don't hold up new leads", async () => {
    const leads = ["queue.sticky1@example.test", "queue.sticky2@example.test", "queue.new@example.test"];
    const { id, mailboxes } = await queued("Queue: sticky", { mailboxes: 2, leads, steps: 2 });
    const [busy, free] = mailboxes;
    // Two follow-ups are due from the first mailbox, which has used up its day.
    await db
      .update(schema.leads)
      .set({ nextStep: 1, senderAccountId: busy, nextSendAt: Date.now() - 60_000 })
      .where(inArray(schema.leads.email, leads.slice(0, 2)));
    await db.update(schema.emailAccounts).set({ dailyLimit: 0 }).where(eq(schema.emailAccounts.id, busy!));
    await runSender();
    const sent = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, id), eq(schema.emailEvents.type, "sent")));
    assert.deepEqual(
      sent.map((e) => [e.leadEmail, e.accountId]),
      [["queue.new@example.test", free]],
      "the new lead went out from the other mailbox",
    );
    assert.equal((await leadBy("queue.sticky1@example.test")).nextStep, 1, "the follow-ups wait for their mailbox");
  });

  it("leads no mailbox may email under the provider rules don't hold up the others", async () => {
    const leads = ["queue.g1@example.test", "queue.g2@example.test", "queue.other@example.test"];
    const { id } = await queued("Queue: rules", { leads });
    await db.update(schema.leads).set({ espCode: EspCode.GOOGLE }).where(inArray(schema.leads.email, leads.slice(0, 2)));
    await db.update(schema.leads).set({ espCode: EspCode.OTHER }).where(eq(schema.leads.email, leads[2]!));
    // Google recipients only from Outlook mailboxes, and this campaign has none.
    await db
      .update(schema.campaigns)
      .set({ providerRoutingRules: [{ recipient_esp: ["google"], sender_esp: ["outlook"], action: "send" }] as never })
      .where(eq(schema.campaigns.id, id));
    await runSender();
    assert.equal((await leadBy("queue.other@example.test")).status, LeadStatus.COMPLETED);
    assert.equal((await leadBy("queue.g1@example.test")).nextStep, 0);
  });

  it("with provider rules, a first email waits for the lead's provider to be looked up", async () => {
    const leads = ["pat@gworkspace-wait.test", "kim@plain-wait.test"];
    const { id } = await queued("Queue: provider lookup", { leads });
    // Google recipients only from Outlook mailboxes, and this campaign has none: a Google address can't be emailed.
    await db
      .update(schema.campaigns)
      .set({ providerRoutingRules: [{ recipient_esp: ["google"], sender_esp: ["outlook"], action: "send" }] as never })
      .where(eq(schema.campaigns.id, id));
    assert.equal((await leadBy(leads[0]!)).espCode, EspCode.IN_QUEUE);
    await runSender();
    assert.equal((await leadBy(leads[0]!)).nextStep, 0, "not sent before its provider is known");
    assert.equal((await leadBy(leads[1]!)).nextStep, 0);
    await detectLeadEsps();
    await runSender();
    assert.equal((await leadBy(leads[0]!)).nextStep, 0, "on Google: no mailbox may email it");
    assert.equal((await leadBy(leads[1]!)).status, LeadStatus.COMPLETED, "the other one went out");
  });

  it("first emails waiting for verification don't hold up the rest, and say why when they're all that's left", async () => {
    const leads = ["queue.pending1@example.test", "queue.pending2@example.test", "queue.checked@example.test"];
    const { id } = await queued("Queue: verifying", { leads });
    await db.update(schema.leads).set({ verificationStatus: VerificationStatus.PENDING }).where(inArray(schema.leads.email, leads.slice(0, 2)));
    await runSender();
    assert.equal((await leadBy("queue.checked@example.test")).status, LeadStatus.COMPLETED);
    await runSender();
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${id}`)).not_sending_status, CampaignNotSendingStatus.VERIFYING);
  });

  it("leads added while a campaign runs subsequences get its emails, and it's active again", async () => {
    const { id } = await queued("Queue: late lead", { leads: ["queue.late@example.test"], steps: 2 });
    await db.update(schema.campaigns).set({ status: CampaignStatus.RUNNING_SUBSEQUENCES }).where(eq(schema.campaigns.id, id));
    await runSender();
    assert.equal((await leadBy("queue.late@example.test")).nextStep, 1, "the first email went out");
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${id}`)).status, CampaignStatus.ACTIVE);
  });

  it("schedule dates are days: a date with a time keeps its day, and a date that doesn't exist is refused", async () => {
    const { id } = await queued("Queue: dates", { leads: [] });
    const at = (start: string) => user.client.patch(`/api/v2/campaigns/${id}`, { campaign_schedule: { ...ALWAYS_OPEN, start_date: start } });
    json(await at("2026-10-15T00:00:00Z"));
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${id}`)).campaign_schedule.start_date, "2026-10-15");
    expectStatus(await at("2026-02-30"), 400);
  });
});

describe("bounce report", () => {
  it("sorts bounces by reason from the code or the server's words", () => {
    assert.equal(bounceReason("550 · 550 5.1.1 <x@example.test>: Recipient address rejected: User unknown", true), "no_address");
    assert.equal(bounceReason("5.1.2 · Host or domain name not found", true), "domain");
    assert.equal(bounceReason("552 · 552 5.2.2 Mailbox full", false), "mailbox_full");
    assert.equal(bounceReason("550 5.7.1 Message rejected as spam", true), "blocked");
    assert.equal(bounceReason("421 4.4.2 Connection timed out", false), "temporary");
    assert.equal(bounceReason("5.0.0 · Something else entirely", true), "other");
    assert.equal(bounceReason(null, true), "unrecorded");
  });

  it("breaks a campaign's bounces down by reason, mailbox and step", async () => {
    const id = await campaignWithLead("Bounce report", "report.lead@example.test");
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    const [account] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, sender));
    const base = { workspaceId: lead!.workspaceId, lead: lead!, campaignId: id, accountId: account!.id, accountEmail: sender };
    // One sent email for the mailbox's rate, then a soft and a hard bounce notice about it.
    await db.insert(schema.emailEvents).values({ workspaceId: lead!.workspaceId, type: "sent", campaignId: id, leadId: lead!.id, accountEmail: sender, emailId: "report-email", step: 0, variant: 0 });
    await handleBounce({ ...base, emailId: "report-email", step: 0, variant: 0, hard: false, status: "4.2.2", diagnostic: "Mailbox full" });
    await handleBounce({ ...base, emailId: "report-email", step: 0, variant: 0, hard: true, status: "5.1.1", diagnostic: "User unknown" });

    const r = json(await user.client.get(`/api/app/campaigns/${id}/bounces`));
    assert.deepEqual(r.totals, { hard: 1, soft: 1 });
    assert.deepEqual(
      r.reasons.map((x: { reason: string; hard: number; soft: number }) => [x.reason, x.hard, x.soft]).sort(),
      [
        ["mailbox_full", 0, 1],
        ["no_address", 1, 0],
      ],
    );
    assert.deepEqual(r.mailboxes, [{ email: sender, sent: 1, tried: 1, hard: 1, soft: 1, hard_rate: 100 }]);
    assert.deepEqual(r.steps, [{ step: 0, sent: 1, tried: 1, hard: 1, soft: 1 }]);
    assert.equal(r.items[0].code, "5.1.1");
    assert.equal(r.items[0].diagnostic, "User unknown");
  });

  it("counts every bounce in the totals, beyond the newest ones it lists", async () => {
    const id = await campaignWithLead("Many bounces", "many.bounces@example.test");
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    const bounce = (value: number, detail: string) => ({ workspaceId: lead!.workspaceId, type: "bounce", value, campaignId: id, leadId: lead!.id, accountEmail: sender, step: 0, variant: 0, detail });
    await db.insert(schema.emailEvents).values([bounce(1, "550 · 5.1.1 User unknown"), bounce(0, "452 · 4.2.2 Mailbox full"), bounce(1, "550 · 5.1.1 User unknown")]);
    const r = json(await user.client.get(`/api/app/campaigns/${id}/bounces?limit=1`));
    assert.deepEqual(r.totals, { hard: 2, soft: 1 });
    assert.equal(r.items.length, 1);
    assert.equal(r.complete, false);
  });
});

describe("analytics funnel", () => {
  it("counts a lead toward every stage up to the furthest it reached", async () => {
    const id = await campaignWithLead("Funnel", "funnel.lead@example.test");
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    // The shared mailbox has used its sending gap by now, so the sent email is recorded directly.
    await db.insert(schema.emailEvents).values({ workspaceId: lead!.workspaceId, type: "sent", campaignId: id, leadId: lead!.id, accountEmail: sender, step: 0, variant: 0 });
    // Straight to "won" without setting a meeting first.
    expectStatus(await user.client.post("/api/v2/leads/update-interest-status", { lead_email: "funnel.lead@example.test", campaign_id: id, interest_value: 4 }), [200, 202]);
    const f = json(await user.client.get(`/api/app/analytics/funnel?id=${id}`));
    assert.equal(f.contacted, 1);
    assert.deepEqual([f.interested, f.meeting_booked, f.meeting_completed, f.won], [1, 1, 1, 1]);
    assert.equal(f.replied, 0);
  });
});

describe("new campaigns", () => {
  it("send on weekdays, 9 to 5 on the workspace's clock", async () => {
    const W = schema.workspaces;
    const [ws] = await db.select({ settings: W.settings }).from(W).where(eq(W.id, user.workspaceId!));
    const setZone = async (settings: typeof ws.settings) => {
      await db.update(W).set({ settings }).where(eq(W.id, user.workspaceId!));
      forgetWorkspaceZones(user.workspaceId!);
    };
    await setZone({ ...(ws!.settings ?? {}), default_timezone: "Asia/Tokyo" } as typeof ws.settings);
    try {
      const created = json(await user.client.post("/api/app/campaigns", { name: "On our clock" }));
      const [window] = json(await user.client.get(`/api/v2/campaigns/${created.id}`)).campaign_schedule.schedules;
      assert.deepEqual([window.timezone, window.timing], ["Asia/Tokyo", { from: "09:00", to: "17:00" }]);
      // A copy keeps the schedule it was given.
      const copy = json(await user.client.post(`/api/v2/campaigns/${created.id}/duplicate`, {}));
      assert.equal(json(await user.client.get(`/api/v2/campaigns/${copy.id}`)).campaign_schedule.schedules[0].timezone, "Asia/Tokyo");
    } finally {
      await setZone(ws!.settings);
    }
  });
});

describe("campaign progress", () => {
  it("counts every lead with nothing left to send as done, so a finished campaign is 100%", async () => {
    const id = await campaignWithLead("Progress", "progress.one@example.test");
    for (const email of ["progress.two@example.test", "progress.three@example.test", "progress.four@example.test"]) {
      json(await user.client.post("/api/v2/leads", { email, first_name: "Pat", campaign: id }));
    }
    const leads = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, id));
    const set = (email: string, status: number) => db.update(schema.leads).set({ status }).where(and(eq(schema.leads.campaignId, id), eq(schema.leads.email, email)));
    await set("progress.one@example.test", LeadStatus.COMPLETED);
    await set("progress.two@example.test", LeadStatus.SKIPPED);
    await set("progress.three@example.test", LeadStatus.PAUSED);
    assert.equal(leads.length, 4);
    const row = async () => json(await user.client.get("/api/app/campaigns?search=Progress")).items.find((c: { id: string }) => c.id === id);
    assert.equal((await row()).stats.progress, 50, "the paused and the active lead still have emails to come");
    let overview = json(await user.client.get(`/api/app/campaigns/${id}/overview`));
    assert.deepEqual([overview.leads.done, overview.leads.paused, overview.leads.active, overview.leads.progress], [2, 1, 1, 50]);

    await set("progress.three@example.test", LeadStatus.BOUNCED);
    await set("progress.four@example.test", LeadStatus.UNSUBSCRIBED);
    assert.equal((await row()).stats.progress, 100);
    overview = json(await user.client.get(`/api/app/campaigns/${id}/overview`));
    assert.equal(overview.leads.done, 4);
  });

  it("a finished campaign shows leads added later as waiting, and resuming sends to them", async () => {
    const c = user.client;
    // Its own mailbox with no pause between emails, so both rounds go out within the test.
    const mailbox = json(await c.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
    const id = json(await c.post("/api/app/campaigns", { name: "Finished, then more" })).id as string;
    json(await c.patch(`/api/v2/campaigns/${id}`, { email_list: [mailbox], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps: [step("Hi", "<p>Hello</p>")] }] }));
    json(await c.post("/api/v2/leads", { email: "first.round@example.test", first_name: "Pat", campaign: id }));
    expectStatus(await c.post(`/api/v2/campaigns/${id}/activate`), 200);
    const campaign = async () => (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!;
    const finish = async () => {
      for (let i = 0; i < 5 && (await campaign()).status !== CampaignStatus.COMPLETED; i++) await runSender();
      assert.equal((await campaign()).status, CampaignStatus.COMPLETED);
    };
    await finish();
    assert.ok((await campaign()).completedAt);

    json(await c.post("/api/v2/leads", { email: "second.round@example.test", first_name: "Pat", campaign: id }));
    const row = async () => json(await c.get("/api/app/campaigns?search=Finished")).items.find((r: { id: string }) => r.id === id);
    assert.deepEqual([(await row()).status, (await row()).stats.waiting], [CampaignStatus.COMPLETED, 1], "it stays finished until someone resumes it");
    assert.equal(json(await c.get(`/api/v2/campaigns/${id}/sending-status`)).diagnostics.leads.active, 1);

    expectStatus(await c.post(`/api/v2/campaigns/${id}/activate`), 200);
    assert.equal((await campaign()).completedAt, null);
    await finish();
    assert.equal(await sentCount(id), 2, "the new lead got the sequence, and the first one nothing more");
    assert.equal((await row()).stats.waiting, 0);
  });
});
