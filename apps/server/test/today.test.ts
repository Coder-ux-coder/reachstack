// The Today page (services/today.ts, GET /api/app/today): what goes out today, what holds the rest back, and the week
// ahead, worked out on a fixed clock. Sandbox mailboxes and made-up addresses only; nothing is sent.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CampaignStatus } from "@reachstack/shared";
import { TestClient, expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { isScheduleOpen, openIntervals } from "../src/lib/time";
import { todayReport, type TodayReport } from "../src/services/today";
import { forgetWorkspaceZones } from "../src/services/workspace-clock";

/** A Wednesday, 15:00 on the workspace clock (UTC). */
const NOW = Date.parse("2030-01-09T15:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVERY_DAY = { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
const window = (from: string, to: string) => ({ start_date: null, end_date: null, schedules: [{ name: "Window", timing: { from, to }, days: EVERY_DAY, timezone: "UTC" }] });
const ALL_DAY = window("00:00", "00:00");
const step = (delayDays = 2) => ({ type: "email", delay: delayDays, delay_unit: "days", variants: [{ subject: "Hello {{firstName|there}}", body: "<p>A short note.</p>" }] });

let app: FastifyInstance;
before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
});
after(stopServer);

interface Setup {
  user: TestUser;
  ws: string;
  boxes: string[];
}

/** A workspace on UTC with sandbox mailboxes, each allowed `limit` campaign emails a day and no gap of its own. */
async function workspace(name: string, count: number, limit: number): Promise<Setup> {
  const user = await signUp(app, { workspaceName: name });
  const ws = user.workspaceId!;
  const [row] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, ws));
  await db
    .update(schema.workspaces)
    .set({ settings: { ...(row?.settings ?? {}), default_timezone: "UTC" } as typeof row.settings })
    .where(eq(schema.workspaces.id, ws));
  forgetWorkspaceZones(ws);
  const items = json(await user.client.post("/api/app/accounts/sandbox", { count, enable_warmup: false })).items as Array<{ id: string; email: string }>;
  for (const a of items) await db.update(schema.emailAccounts).set({ dailyLimit: limit, sendingGap: 0, enableSlowRamp: false }).where(eq(schema.emailAccounts.id, a.id));
  return { user, ws, boxes: items.map((a) => a.email) };
}

/** A running campaign with `leads` new leads: a minute between emails, no random wait and no daily limit unless given. */
async function campaign(s: Setup, name: string, opts: { leads: number; steps?: unknown[]; schedule?: unknown; mailboxes?: string[]; status?: number; extra?: Record<string, unknown> }) {
  const c = json(await s.user.client.post("/api/app/campaigns", { name }));
  json(
    await s.user.client.patch(`/api/v2/campaigns/${c.id}`, {
      email_list: opts.mailboxes ?? s.boxes,
      campaign_schedule: opts.schedule ?? ALL_DAY,
      sequences: [{ steps: opts.steps ?? [step()] }],
      email_gap: 1,
      random_wait_max: 0,
      daily_limit: null,
      ...opts.extra,
    }),
  );
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  const leads = Array.from({ length: opts.leads }, (_, i) => ({ email: `lead${i}.${slug}@today.test`, first_name: "Pat" }));
  if (leads.length) json(await s.user.client.post("/api/v2/leads/add", { campaign_id: c.id, leads }));
  await db
    .update(schema.campaigns)
    .set({ status: opts.status ?? CampaignStatus.ACTIVE, launchedAt: new Date(NOW - 2 * HOUR) })
    .where(eq(schema.campaigns.id, c.id));
  return c.id as string;
}

const report = (s: Setup) => todayReport(s.ws, { mailboxes: true }, NOW);
const flow = (r: TodayReport, id: string) => r.flows.find((f) => f.id === id)!;

describe("schedule windows", () => {
  it("are open exactly when the sender's check says so, across clock changes", () => {
    let seed = 0x2f6b;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const times = ["00:00", "06:15", "09:00", "12:30", "17:30", "22:00"];
    const zones = ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Sydney"];
    const from = Date.parse("2030-03-06T00:00:00Z"); // takes in the US clock change on 10 March
    const to = from + 9 * DAY;
    for (let i = 0; i < 24; i++) {
      const schedule = {
        start_date: rand() < 0.3 ? "2030-03-08" : null,
        end_date: rand() < 0.3 ? "2030-03-12" : null,
        schedules: Array.from({ length: 1 + Math.floor(rand() * 2) }, () => ({
          name: "Window",
          timing: { from: pick(times), to: pick(times) },
          days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, rand() < 0.6])) as typeof EVERY_DAY,
          timezone: pick(zones),
        })),
      };
      const spans = openIntervals(schedule, from, to);
      for (let t = from; t < to; t += 11 * 60_000 + 13_000) {
        const inside = spans.some(([a, b]) => t >= a && t < b);
        assert.equal(inside, isScheduleOpen(schedule, t), `${JSON.stringify(schedule)} at ${new Date(t).toISOString()}`);
      }
    }
  });
});

describe("today's bottleneck", () => {
  it("is the mailboxes' daily limits when more is due than they can send", async () => {
    const s = await workspace("Limits", 4, 5);
    const [a, b, resting, spare] = s.boxes as [string, string, string, string];
    await db.update(schema.emailAccounts).set({ campaignPauseUntil: new Date(NOW + 2 * DAY) }).where(eq(schema.emailAccounts.email, resting));
    const id = await campaign(s, "Big list", { leads: 30, mailboxes: [a, b, resting] });
    const r = await report(s);
    assert.deepEqual([r.timezone, r.day, r.resets_at], ["UTC", "2030-01-09", "2030-01-10T00:00:00.000Z"]);
    assert.deepEqual({ sent: r.sent, due: r.due, more: r.more, wont_fit: r.wont_fit }, { sent: 0, due: 30, more: 10, wont_fit: 20 });
    assert.deepEqual(r.capacity, { mailboxes: 3, usable: 2, limit: 10, sent: 0, left: 10 });
    assert.equal(r.bottleneck.reason, "mailbox_limits");
    // The spare mailbox could help: it's in no running campaign.
    assert.equal(
      r.bottleneck.detail,
      `20 due emails won't fit today: the 2 mailboxes they send from have room for about 10 more emails. Your other mailboxes have room for about 5 more emails: add them to "Big list", or connect more mailboxes.`,
    );
    assert.deepEqual(r.bottleneck.link, { label: "Choose mailboxes", to: `/app/campaign/${id}/options` });
    const f = flow(r, id);
    assert.deepEqual(f.held.map((h) => [h.reason, h.emails]), [["mailbox_limits", 20]]);
    assert.deepEqual({ due: f.due_today, now: f.due_now, more: f.more_today }, { due: 30, now: 30, more: 10 });
    assert.deepEqual(f.mailboxes, { attached: 3, usable: 2 });
    const box = (email: string) => r.mailboxes!.find((m) => m.email === email)!;
    assert.deepEqual([box(a).more_today, box(b).more_today], [5, 5]);
    assert.deepEqual([box(resting).note, box(resting).usable, box(resting).resting_until], ["Resting", false, new Date(NOW + 2 * DAY).toISOString()]);
    assert.deepEqual([box(spare).note, box(spare).usable, box(spare).campaigns], ["Not in a running campaign", false, 0]);
    // The resting mailbox is back for Saturday the 12th; by then the list is done.
    assert.deepEqual(
      r.forecast.map((d) => [d.date, d.due, d.sends, d.capacity]),
      [
        ["2030-01-09", 30, 10, 10],
        ["2030-01-10", 20, 10, 10],
        ["2030-01-11", 10, 10, 10],
        ["2030-01-12", 0, 0, 15],
        ["2030-01-13", 0, 0, 15],
        ["2030-01-14", 0, 0, 15],
        ["2030-01-15", 0, 0, 15],
      ],
    );
  });

  it("is a shared mailbox's room when another campaign uses it first, whatever the later campaign's own limit", async () => {
    const s = await workspace("Shared", 1, 5);
    const first = await campaign(s, "First in line", { leads: 10 });
    const second = await campaign(s, "Second in line", { leads: 10, extra: { daily_limit: 3 } });
    const r = await report(s);
    assert.deepEqual(flow(r, first).held, [{ reason: "mailbox_limits", emails: 5, text: "Its mailbox has room for 5 more today." }]);
    // Raising its daily limit wouldn't send more today: the mailbox is what stops it.
    assert.deepEqual(flow(r, second).held, [
      { reason: "mailbox_limits", emails: 10, text: 'Its mailbox is shared with "First in line", which uses up today\'s room first.' },
      { reason: "campaign_limit", emails: 7, text: "Its daily limit of 3 leaves room for 3 more." },
    ]);
    assert.deepEqual([r.bottleneck.reason, r.wont_fit], ["mailbox_limits", 15]);
    assert.equal(r.bottleneck.detail, "15 due emails won't fit today: the mailbox they send from has room for about 5 more emails. Connect more mailboxes or raise their daily limits.");
    assert.deepEqual(r.bottleneck.link, { label: "Email accounts", to: "/app/accounts" });
  });

  it("is the campaign's daily limit, counting what it already sent today", async () => {
    const s = await workspace("Campaign limit", 1, 50);
    const id = await campaign(s, "Capped", { leads: 10, extra: { daily_limit: 3 } });
    const [acct] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, s.ws));
    const sent = (email: string, at: number) =>
      db.insert(schema.emailEvents).values({ workspaceId: s.ws, type: "sent", campaignId: id, accountId: acct!.id, leadEmail: email, isFirst: true, createdAt: new Date(at) });
    await sent("earlier@today.test", NOW - HOUR);
    await sent("yesterday@today.test", NOW - DAY); // before midnight: yesterday's
    await db.insert(schema.accountDailyStats).values({ workspaceId: s.ws, accountId: acct!.id, date: "2030-01-09", sent: 1 });
    const r = await report(s);
    assert.equal(r.sent, 1);
    const f = flow(r, id);
    assert.deepEqual({ sent: f.sent_today, due: f.due_today, more: f.more_today, limit: f.daily_limit }, { sent: 1, due: 10, more: 2, limit: 3 });
    assert.deepEqual(f.held, [{ reason: "campaign_limit", emails: 8, text: "Its daily limit of 3 leaves room for 2 more." }]);
    assert.equal(r.bottleneck.reason, "campaign_limit");
    assert.equal(r.bottleneck.link?.to, `/app/campaign/${id}/options`);
    const m = r.mailboxes![0]!;
    assert.deepEqual({ sent: m.sent_today, limit: m.limit_today, more: m.more_today }, { sent: 1, limit: 50, more: 2 });
  });

  it("is the sending window once it has closed for the day", async () => {
    const s = await workspace("Closed window", 1, 50);
    const id = await campaign(s, "Mornings", { leads: 5, schedule: window("09:00", "10:00") });
    const r = await report(s);
    const f = flow(r, id);
    assert.deepEqual(f.window, { open_now: false, minutes_left: 0, next_open_at: "2030-01-10T09:00:00.000Z" });
    assert.deepEqual(f.held.map((h) => [h.reason, h.emails]), [["schedule", 5]]);
    assert.equal(r.more, 0);
    assert.equal(r.bottleneck.title, "Sending windows are closed for today");
    assert.equal(r.bottleneck.link?.to, `/app/campaign/${id}/schedule`);
    // Tomorrow's hour fits all five, a minute apart.
    assert.deepEqual(r.forecast.slice(0, 2).map((d) => [d.due, d.sends]), [[5, 0], [5, 5]]);
  });

  it("is the time between emails when the window is short", async () => {
    const s = await workspace("Gap", 1, 100);
    const id = await campaign(s, "Spaced out", { leads: 10, schedule: window("14:00", "16:00"), extra: { email_gap: 30 } });
    const r = await report(s);
    const f = flow(r, id);
    assert.deepEqual([f.window.open_now, f.window.minutes_left], [true, 60]);
    assert.equal(f.more_today, 2);
    assert.deepEqual(f.held, [{ reason: "sending_gap", emails: 8, text: "Each mailbox waits about 30 minutes between emails, so 2 more fit in today's window." }]);
    assert.equal(r.bottleneck.reason, "sending_gap");
    assert.deepEqual(r.forecast.slice(0, 3).map((d) => d.sends), [2, 4, 4]);
  });

  it("is slow ramp-up while a new campaign ramps", async () => {
    const s = await workspace("Ramp", 1, 100);
    const id = await campaign(s, "Ramping", { leads: 50, extra: { slow_ramp_up: true } });
    await db.update(schema.campaigns).set({ launchedAt: new Date(NOW - DAY) }).where(eq(schema.campaigns.id, id));
    const r = await report(s);
    const f = flow(r, id);
    assert.equal(f.daily_limit, 40);
    assert.deepEqual(f.held, [{ reason: "ramp_up", emails: 10, text: "Slow ramp-up allows 40 emails today, 20 more each day." }]);
    assert.equal(r.bottleneck.reason, "ramp_up");
    assert.deepEqual(r.forecast.slice(0, 2).map((d) => d.sends), [40, 10]);
  });

  it("is the limit on new leads a day, and follow-ups come due in the forecast", async () => {
    const s = await workspace("New leads", 1, 100);
    const id = await campaign(s, "Two steps", { leads: 10, steps: [step(2), step(1)], extra: { daily_max_leads: 4 } });
    const r = await report(s);
    assert.deepEqual(flow(r, id).held, [{ reason: "new_lead_limit", emails: 6, text: "Its limit of 4 new leads a day leaves room for 4 more." }]);
    assert.equal(r.bottleneck.reason, "new_lead_limit");
    // Four first emails a day, and each lead's second email two days after its first.
    assert.deepEqual(
      r.forecast.map((d) => [d.due, d.sends]),
      [[10, 4], [6, 4], [6, 6], [4, 4], [2, 2], [0, 0], [0, 0]],
    );
  });

  it("is nothing while everything due fits, and says when nothing is due", async () => {
    const s = await workspace("Fits", 1, 50);
    const id = await campaign(s, "Small", { leads: 3, steps: [step(2), step(2)] });
    let r = await report(s);
    assert.deepEqual([r.bottleneck.reason, r.bottleneck.title], ["on_track", "Everything due today fits"]);
    assert.deepEqual(flow(r, id).held, []);
    // Once the first emails are out, the second ones are two days off.
    await db.update(schema.leads).set({ nextStep: 1, nextSendAt: NOW + 2 * DAY }).where(eq(schema.leads.campaignId, id));
    r = await report(s);
    assert.equal(r.bottleneck.reason, "no_leads");
    assert.equal(r.next_due_at, new Date(NOW + 2 * DAY).toISOString());
    assert.deepEqual(r.forecast.map((d) => d.due), [0, 0, 3, 0, 0, 0, 0]);
  });

  it("is that nothing runs when the only campaign is paused, with what waits in it", async () => {
    const s = await workspace("Paused", 1, 50);
    const id = await campaign(s, "On hold", { leads: 5, status: CampaignStatus.PAUSED });
    const r = await report(s);
    assert.equal(r.bottleneck.reason, "idle");
    assert.equal(r.bottleneck.detail, "5 emails due today wait in stopped campaigns.");
    assert.deepEqual([r.due, r.waiting_in_stopped], [0, 5]);
    const f = flow(r, id);
    assert.equal(f.running, false);
    assert.deepEqual(f.held, [{ reason: "not_running", emails: 5, text: "The campaign is paused." }]);
  });
});

describe("GET /api/app/today", () => {
  it("shows mailboxes only to people allowed to see them, and refuses API keys", async () => {
    const s = await workspace("Access", 1, 50);
    await campaign(s, "Visible", { leads: 2 });
    const own = json<TodayReport>(await s.user.client.get("/api/app/today"));
    assert.equal(own.mailboxes?.length, 1);
    assert.equal(own.flows.length, 1);
    const invitee = uniqueEmail("client");
    const invite = json(await s.user.client.post("/api/v2/workspace-members", { email: invitee, role: "client" }));
    const client = await signUp(app, { email: invitee, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
    const theirs = json<TodayReport>(await client.client.get("/api/app/today"));
    assert.equal(theirs.mailboxes, null);
    assert.equal(theirs.flows.length, 1);
    const key = json(await s.user.client.post("/api/v2/api-keys", { name: "Everything", scopes: ["all:all"] })).key as string;
    expectStatus(await new TestClient(app, key).get("/api/app/today"), 403);
  });
});
