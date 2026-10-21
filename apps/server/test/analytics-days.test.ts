// Days in analytics are the workspace's days (Settings → Preferences → Workspace timezone): a date range covers whole
// days on that clock, and daily figures count each event on the day it happened there, daylight saving included. The
// same goes for the reply agent's figures, dates in searches and filters, and the dates Copilot picks. And a
// subsequence's own analytics count only its emails.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EmailType, LeadStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { TOOL_BY_NAME, type ToolCtx } from "../src/services/copilot/tools";
import { runViews } from "../src/services/visitors";
import { dayOn, daysBefore, forgetWorkspaceZones, localDateSql, offsetChanges, parseRange } from "../src/services/workspace-clock";

let app: FastifyInstance;
let user: TestUser;

async function setZone(workspaceId: string, zone: string) {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await db
    .update(schema.workspaces)
    .set({ settings: { ...(ws?.settings ?? {}), default_timezone: zone } as typeof ws.settings })
    .where(eq(schema.workspaces.id, workspaceId));
  forgetWorkspaceZones(workspaceId);
}

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Dana", workspaceName: "Pacific Co" });
  await setZone(user.workspaceId!, "America/Los_Angeles");
});
after(stopServer);

const at = (iso: string) => Date.parse(iso);

describe("a clock's days", () => {
  it("finds every daylight-saving change in a period, to the millisecond", () => {
    const changes = offsetChanges("America/Los_Angeles", at("2026-01-01T00:00:00Z"), at("2027-01-01T00:00:00Z"));
    assert.deepEqual(changes, [
      { at: -Infinity, offset: -8 * 3_600_000 },
      { at: at("2026-03-08T10:00:00Z"), offset: -7 * 3_600_000 },
      { at: at("2026-11-01T09:00:00Z"), offset: -8 * 3_600_000 },
    ]);
    assert.deepEqual(offsetChanges("Asia/Kolkata", at("2026-01-01T00:00:00Z"), at("2027-01-01T00:00:00Z")), [{ at: -Infinity, offset: 5.5 * 3_600_000 }]);
  });

  it("puts each moment on its own calendar day there, either side of a change", async () => {
    const from = at("2026-10-01T00:00:00Z");
    const to = at("2026-11-30T00:00:00Z");
    const day = localDateSql(sql`t`, "America/Los_Angeles", from, to);
    const cases: Array<[string, string]> = [
      ["2026-10-16T06:59:59.999Z", "2026-10-15"], // 23:59 PDT
      ["2026-10-16T07:00:00.000Z", "2026-10-16"], // midnight PDT
      ["2026-11-02T07:59:59.999Z", "2026-11-01"], // 23:59 PST, the day the clocks went back
      ["2026-11-02T08:00:00.000Z", "2026-11-02"], // midnight PST
    ];
    for (const [moment, expected] of cases) {
      const [row] = await db.all<{ d: string }>(sql`select ${day} as d from (select ${at(moment)} as t)`);
      assert.equal(row!.d, expected, moment);
    }
  });

  it("reads dates as whole days on the clock", () => {
    assert.deepEqual(parseRange("2026-10-15", "2026-10-15", "America/Los_Angeles"), {
      start: at("2026-10-15T07:00:00.000Z"),
      end: at("2026-10-16T06:59:59.999Z"),
      zone: "America/Los_Angeles",
    });
    // Exact times stay exact.
    assert.equal(parseRange("2026-10-15T12:00:00Z", undefined, "America/Los_Angeles").start, at("2026-10-15T12:00:00Z"));
  });
});

describe("campaign analytics on the workspace's clock", () => {
  it("count an email sent late in the evening on that evening's day, and include it in that day's totals", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Evening sends" })).id as string;
    const event = (iso: string) => ({ workspaceId: user.workspaceId!, campaignId, leadEmail: `${iso}@days.example.test`, type: "sent" as const, step: 0, variant: 0, createdAt: new Date(iso) });
    await db.insert(schema.emailEvents).values([event("2026-10-15T16:00:00Z"), event("2026-10-16T05:30:00Z"), event("2026-10-16T08:00:00Z")]);

    const daily = json<Array<{ date: string; sent: number }>>(await user.client.get(`/api/v2/campaigns/analytics/daily?campaign_id=${campaignId}&start_date=2026-10-15&end_date=2026-10-16`));
    assert.deepEqual(
      daily.map((d) => [d.date, d.sent]),
      [
        ["2026-10-15", 2], // 9 am and 10:30 pm Pacific
        ["2026-10-16", 1], // 1 am Pacific
      ],
    );
    const overview = json<{ emails_sent_count: number }>(await user.client.get(`/api/v2/campaigns/analytics/overview?id=${campaignId}&start_date=2026-10-15&end_date=2026-10-15`));
    assert.equal(overview.emails_sent_count, 2);
  });
});

describe("a subsequence's analytics", () => {
  it("count its own emails and leads, not the campaign's", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "With a follow-up flow" })).id as string;
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: campaignId, name: "Interested", conditions: { crm_status: [1] } }));
    const leads = await db
      .insert(schema.leads)
      .values(
        // Running, finished twice, not in it, paused, bounced.
        [LeadStatus.ACTIVE, LeadStatus.COMPLETED, LeadStatus.COMPLETED, null, LeadStatus.PAUSED, LeadStatus.BOUNCED].map((subseqStatus, i) => ({
          workspaceId: user.workspaceId!,
          campaignId,
          email: `p${i}@sub-analytics.example.test`,
          ...(subseqStatus === null ? {} : { subsequenceId: sub.id, subseqStatus }),
        })),
      )
      .returning({ id: schema.leads.id });
    const event = (leadIndex: number, type: string, inSub: boolean, step = 0) => ({
      workspaceId: user.workspaceId!,
      campaignId,
      subsequenceId: inSub ? sub.id : null,
      leadId: leads[leadIndex]!.id,
      type,
      step,
      variant: 0,
      createdAt: new Date("2026-10-14T18:00:00Z"),
    });
    await db.insert(schema.emailEvents).values([event(0, "sent", true), event(1, "sent", true), event(1, "sent", true, 1), event(1, "reply", true, 1), event(3, "sent", false), event(3, "reply", false)]);

    const o = json(await user.client.get(`/api/app/subsequences/${sub.id}/overview`));
    assert.deepEqual([o.metrics.emails_sent_count, o.metrics.contacted_count, o.metrics.reply_count_unique], [3, 2, 1]);
    assert.deepEqual(o.leads, { total: 5, active: 2, paused: 1, completed: 2, skipped: 0, stopped: 1, progress: 60 });
    assert.deepEqual(
      o.steps.map((r: { step: string; sent: number; unique_replies: number }) => [r.step, r.sent, r.unique_replies]),
      [
        ["0", 2, 0],
        ["1", 1, 1],
      ],
    );
    assert.deepEqual(o.daily.map((d: { date: string; sent: number }) => [d.date, d.sent]), [["2026-10-14", 3]]);
  });
});

describe("the reply agent's analytics on the workspace's clock", () => {
  it("count a draft written late in the evening on that evening's day", async () => {
    const agent = json(await user.client.post("/api/v2/ai-agents/inbox-manager", { name: "Evening replies", payload: { configuration_type: 1 } }));
    const draft = (iso: string) => ({ workspaceId: user.workspaceId!, agentId: agent.id, jobType: 1, sendingStatus: 1, createdAt: new Date(iso) });
    await db.insert(schema.aiAgentReplies).values([draft("2026-10-15T16:00:00Z"), draft("2026-10-16T05:30:00Z"), draft("2026-10-16T08:00:00Z")]);
    const base = `/api/v2/ai-agents/inbox-manager/${agent.id}/analytics`;
    const days = json<Array<{ date: string; replies_count: number }>>(await user.client.get(`${base}/summary-by-date?from=2026-10-15&to=2026-10-16`));
    assert.deepEqual(
      days.map((d) => [d.date, d.replies_count]),
      [
        ["2026-10-15", 2], // 9 am and 10:30 pm Pacific
        ["2026-10-16", 1], // 1 am Pacific
      ],
    );
    assert.equal(json(await user.client.get(`${base}/summary?from=2026-10-15&to=2026-10-15`)).replies_count, 2);
  });
});

describe("dates in the Unibox", () => {
  const email = (iso: string, subject: string) => ({
    workspaceId: user.workspaceId!,
    messageId: `<${subject.replace(/\W+/g, "-")}@days.example.test>`,
    threadId: subject,
    subject,
    fromAddress: "pat@days.example.test",
    leadEmail: "pat@days.example.test",
    eaccount: "me@pacific.example.test",
    ueType: EmailType.RECEIVED,
    timestampEmail: new Date(iso),
    createdAt: new Date(iso),
  });
  const subjects = (res: Awaited<ReturnType<TestUser["client"]["get"]>>) =>
    json<{ items: Array<{ subject: string }> }>(res)
      .items.map((e) => e.subject)
      .sort();
  let ids: string[] = [];

  before(async () => {
    const rows = await db
      .insert(schema.emails)
      .values([email("2026-10-16T05:30:00Z", "Late on the 15th"), email("2026-10-16T08:00:00Z", "Early on the 16th")])
      .returning({ id: schema.emails.id });
    ids = rows.map((r) => r.id);
  });

  it("are read on the workspace's clock in a search", async () => {
    const search = async (q: string) => subjects(await user.client.get(`/api/v2/emails?limit=50&search=${encodeURIComponent(`from:pat@days.example.test ${q}`)}`));
    assert.deepEqual(await search("after:2026-10-16"), ["Early on the 16th"]);
    assert.deepEqual(await search("before:2026-10-16"), ["Late on the 15th"]);
    assert.deepEqual(await search("after:2026-10"), [], "after October is November on");
    assert.deepEqual(await search("before:2026-11"), ["Early on the 16th", "Late on the 15th"]);
  });

  it("cover the whole day in the list's date filters, and a time that isn't one is turned away", async () => {
    const list = (q: string) => user.client.get(`/api/v2/emails?limit=50&lead=pat@days.example.test&${q}`);
    assert.deepEqual(subjects(await list("min_timestamp_created=2026-10-15&max_timestamp_created=2026-10-15")), ["Late on the 15th"]);
    assert.deepEqual(subjects(await list("min_timestamp_created=2026-10-16T07:00:00Z")), ["Early on the 16th"]);
    expectStatus(await list("min_timestamp_created=last+week"), 400);
    const res = await user.client.patch(`/api/v2/emails/${ids[0]}`, { reminder_ts: "next tuesday" });
    expectStatus(res, 400);
    assert.match(res.json().message, /reminder_ts: Use a date and time/);
  });
});

describe("a lead filter's dates", () => {
  it("are midnight on the workspace's clock", async () => {
    await db.insert(schema.leads).values([
      { workspaceId: user.workspaceId!, email: "late@filter-days.example.test", createdAt: new Date("2026-10-16T05:30:00Z") },
      { workspaceId: user.workspaceId!, email: "early@filter-days.example.test", createdAt: new Date("2026-10-16T08:00:00Z") },
    ]);
    const added = async (op: "before" | "after") =>
      json<{ items: Array<{ email: string }> }>(await user.client.post("/api/v2/leads/list", { limit: 100, search: "filter-days", rules: [{ field: "created", op, value: "2026-10-16" }] })).items.map((l) => l.email);
    assert.deepEqual(await added("after"), ["early@filter-days.example.test"]);
    assert.deepEqual(await added("before"), ["late@filter-days.example.test"]);
  });
});

/** A workspace on a clock whose date isn't the UTC date right now. */
async function farAway(name: string) {
  const zone = dayOn("Etc/GMT-14") !== dayOn("UTC") ? "Etc/GMT-14" : "Etc/GMT+12";
  const far = await signUp(app, { workspaceName: name });
  await setZone(far.workspaceId!, zone);
  return { far, zone };
}

describe("a website visitor view's alerts", () => {
  it("go out once a day on the workspace's clock", async () => {
    const { far, zone } = await farAway("Visitors Co");
    const now = new Date();
    const [view] = await db.insert(schema.visitorViews).values({ workspaceId: far.workspaceId!, name: "Everyone", filters: {}, destinations: {} }).returning();
    const [visit] = await db
      .insert(schema.visitorSessions)
      .values({ workspaceId: far.workspaceId!, siteId: "site-days", visitorKey: "visitor-1", companyDomain: "acme.example.test", companyData: { name: "Acme", domain: "acme.example.test" }, identified: true, resolveStatus: "identified", firstSeenAt: now, lastSeenAt: now })
      .returning();
    await runViews(visit!);
    await runViews(visit!);
    const alerts = await db.select({ day: schema.visitorAlerts.day }).from(schema.visitorAlerts).where(eq(schema.visitorAlerts.viewId, view!.id));
    assert.deepEqual(
      alerts.map((a) => a.day),
      [dayOn(zone)],
    );
  });
});

describe("Copilot's default dates", () => {
  it("end today on the workspace's clock", async () => {
    const { far, zone } = await farAway("Far Away Co");
    const urls: string[] = [];
    const ctx = {
      wsId: far.workspaceId!,
      userId: far.id,
      threadId: "none",
      timezone: "UTC",
      settings: {},
      invoke: async (_method: string, url: string) => {
        urls.push(url);
        return url.startsWith("/api/v2/campaigns/analytics?") || url.startsWith("/api/v2/campaigns/analytics/daily") ? [] : { items: [] };
      },
    } as unknown as ToolCtx;
    await TOOL_BY_NAME.get("get_campaign_analytics")!.run({} as never, ctx);
    await TOOL_BY_NAME.get("get_workspace_overview")!.run({} as never, ctx);
    const today = dayOn(zone);
    assert.ok(urls.includes(`/api/v2/campaigns/analytics?start_date=${daysBefore(today, 6)}&end_date=${today}`), urls.join("\n"));
    assert.ok(urls.includes(`/api/v2/campaigns/analytics/overview?start_date=${daysBefore(today, 29)}&end_date=${today}`), urls.join("\n"));
  });
});

describe("a period's dates", () => {
  it("can be centuries away without freezing the server", async () => {
    const started = Date.now();
    for (const path of ["daily", "overview"]) expectStatus(await user.client.get(`/api/v2/campaigns/analytics/${path}?start_date=0001-01-01&end_date=9999-12-31`), 200, path);
    // Generous, for slow machines: a range like this used to freeze the server.
    assert.ok(Date.now() - started < 10_000, `answered in ${Date.now() - started} ms`);
    // Anything before 1970 or more than a year ahead is outside the period.
    const { start, end } = parseRange("1066-10-14", "3000-01-01");
    assert.equal(start, 0);
    assert.ok(end! <= Date.now() + 366 * 86_400_000);
  });
});

describe("the analytics overview", () => {
  it("counts only the workspace's own leads, whatever campaign it's asked about", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Finished leads" })).id as string;
    await db.insert(schema.leads).values({ workspaceId: user.workspaceId!, campaignId, email: "done@overview-own.example.test", status: LeadStatus.COMPLETED });
    assert.equal(json(await user.client.get(`/api/v2/campaigns/analytics/overview?id=${campaignId}`)).completed_count, 1);
    const other = await signUp(app, { workspaceName: "Curious Co" });
    assert.equal(json(await other.client.get(`/api/v2/campaigns/analytics/overview?id=${campaignId}`)).completed_count, 0);
  });
});
