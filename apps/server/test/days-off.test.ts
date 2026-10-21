// Days off in a schedule (CampaignSchedule.days_off): public holidays worked out locally (packages/shared/src/holidays.ts)
// and dates of your own. Nothing goes out on them: the sender's check, the open-time intervals and the Today page agree.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { CampaignStatus, dayOffReason, easter, holidays, upcomingDaysOff } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { isScheduleOpen, nextScheduleOpening, openIntervals } from "../src/lib/time";
import { todayReport } from "../src/services/today";
import { forgetWorkspaceZones } from "../src/services/workspace-clock";

const EVERY_DAY = { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
const allDay = (days_off?: { holidays?: string[]; dates?: string[] }) => ({
  start_date: null,
  end_date: null,
  schedules: [{ name: "All day", timing: { from: "00:00", to: "00:00" }, days: EVERY_DAY, timezone: "UTC" }],
  ...(days_off ? { days_off } : {}),
});
const dates = (country: string, year: number) => holidays(country, year).map((h) => `${h.date} ${h.name}`);

describe("public holidays", () => {
  it("put Easter on the right Sunday", () => {
    assert.deepEqual([2024, 2025, 2026, 2027, 2030].map(easter), [[3, 31], [4, 20], [4, 5], [3, 28], [4, 21]]);
  });

  it("follow each country's rules, moving weekend holidays where the country does", () => {
    assert.deepEqual(dates("US", 2026), [
      "2026-01-01 New Year's Day",
      "2026-01-19 Martin Luther King Jr. Day",
      "2026-02-16 Presidents' Day",
      "2026-05-25 Memorial Day",
      "2026-06-19 Juneteenth",
      "2026-07-03 Independence Day", // the 4th is a Saturday
      "2026-09-07 Labor Day",
      "2026-10-12 Columbus Day",
      "2026-11-11 Veterans Day",
      "2026-11-26 Thanksgiving",
      "2026-12-25 Christmas Day",
    ]);
    // England and Wales: Boxing Day 2026 is a Saturday, so the Monday after is off.
    assert.deepEqual(dates("GB", 2026).slice(-2), ["2026-12-25 Christmas Day", "2026-12-28 Boxing Day (substitute)"]);
    assert.deepEqual(dates("GB", 2027).slice(-2), ["2027-12-27 Christmas Day (substitute)", "2027-12-28 Boxing Day (substitute)"]);
    assert.ok(dates("GB", 2026).includes("2026-04-03 Good Friday") && dates("GB", 2026).includes("2026-04-06 Easter Monday"));
    assert.ok(dates("CA", 2026).includes("2026-05-18 Victoria Day"));
    assert.ok(dates("NL", 2025).includes("2025-04-26 Koningsdag")); // the 27th is a Sunday
    assert.ok(dates("IE", 2030).includes("2030-02-01 St Brigid's Day")); // 1 February 2030 is a Friday
    assert.ok(dates("DE", 2026).includes("2026-05-14 Christi Himmelfahrt"));
    assert.deepEqual(holidays("XX", 2026), []);
  });

  it("count a New Year's Day taken the year before, and own dates", () => {
    // 1 January 2022 was a Saturday: in the US it was taken on Friday 31 December 2021.
    assert.equal(dayOffReason({ holidays: ["US"] }, "2021-12-31"), "New Year's Day (US)");
    assert.equal(dayOffReason({ holidays: ["US"], dates: ["2026-08-14"] }, "2026-08-14"), "Day off");
    assert.equal(dayOffReason({ holidays: ["US"] }, "2026-08-14"), null);
    assert.deepEqual(upcomingDaysOff({ holidays: ["US", "GB"], dates: ["2026-12-24"] }, "2026-12-20", 3), [
      { date: "2026-12-24", names: ["Day off"] },
      { date: "2026-12-25", names: ["Christmas Day (US)", "Christmas Day (GB)"] },
      { date: "2026-12-28", names: ["Boxing Day (substitute) (GB)"] },
    ]);
  });
});

describe("a schedule's days off", () => {
  it("close it for the whole day, and the open-time intervals leave them out", () => {
    const s = allDay({ holidays: ["GB"], dates: ["2030-04-24"] });
    assert.equal(isScheduleOpen(s, Date.parse("2030-04-19T12:00:00Z")), false); // Good Friday
    assert.equal(isScheduleOpen(s, Date.parse("2030-04-20T12:00:00Z")), true);
    assert.equal(isScheduleOpen(s, Date.parse("2030-04-24T23:59:00Z")), false);
    assert.equal(nextScheduleOpening(s, Date.parse("2030-04-22T09:00:00Z")), Date.parse("2030-04-23T00:00:00Z")); // after Easter Monday
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
    assert.deepEqual(openIntervals(s, day("2030-04-18"), day("2030-04-26")), [
      [day("2030-04-18"), day("2030-04-19")],
      [day("2030-04-20"), day("2030-04-22")],
      [day("2030-04-23"), day("2030-04-24")],
      [day("2030-04-25"), day("2030-04-26")],
    ]);
  });

  it("agree with the sender's check at every moment, on any window and timezone", () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const from = Date.parse("2030-04-16T00:00:00Z"); // Easter 2030 is the 21st
    const to = from + 10 * 86_400_000;
    for (let i = 0; i < 16; i++) {
      const schedule = {
        start_date: null,
        end_date: null,
        schedules: [
          {
            name: "Window",
            timing: { from: pick(["00:00", "08:00", "13:30"]), to: pick(["00:00", "17:00", "21:45"]) },
            days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, rand() < 0.75])) as typeof EVERY_DAY,
            timezone: pick(["UTC", "Europe/London", "America/Los_Angeles", "Asia/Tokyo"]),
          },
        ],
        days_off: { holidays: [pick(["GB", "DE", "US", "FR"])], dates: rand() < 0.5 ? ["2030-04-18"] : [] },
      };
      const spans = openIntervals(schedule, from, to);
      for (let t = from; t < to; t += 9 * 60_000 + 7_000) {
        assert.equal(
          spans.some(([a, b]) => t >= a && t < b),
          isScheduleOpen(schedule, t),
          `${JSON.stringify(schedule)} at ${new Date(t).toISOString()}`,
        );
      }
    }
  });
});

describe("days off through the API", () => {
  let user: TestUser;
  before(async () => {
    const app = await startServer();
    await signUp(app); // the installation owner
    user = await signUp(app, { workspaceName: "Days off" });
  });
  after(stopServer);

  it("are saved sorted and without repeats, refuse unknown countries, and go away when emptied", async () => {
    const c = json(await user.client.post("/api/app/campaigns", { name: "Holidays" }));
    const patch = (days_off: unknown) => user.client.patch(`/api/v2/campaigns/${c.id}`, { campaign_schedule: { ...allDay(), days_off } });
    json(await patch({ holidays: ["US", "GB", "US"], dates: ["2030-12-31", "2030-12-24", "2030-12-31"] }));
    const saved = json(await user.client.get(`/api/v2/campaigns/${c.id}`)).campaign_schedule;
    assert.deepEqual(saved.days_off, { holidays: ["US", "GB"], dates: ["2030-12-24", "2030-12-31"] });
    json(await patch({ holidays: ["XX"] }), 400);
    json(await patch({ dates: ["24/12/2030"] }), 400);
    json(await patch({ holidays: [], dates: [] }));
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${c.id}`)).campaign_schedule.days_off, undefined);
  });

  it("are why the Today page says a campaign sends nothing more today", async () => {
    const now = Date.parse("2030-01-09T15:00:00Z");
    const ws = user.workspaceId!;
    const [row] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, ws));
    await db
      .update(schema.workspaces)
      .set({ settings: { ...(row?.settings ?? {}), default_timezone: "UTC" } as typeof row.settings })
      .where(eq(schema.workspaces.id, ws));
    forgetWorkspaceZones(ws);
    const sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    const c = json(await user.client.post("/api/app/campaigns", { name: "Quiet day" }));
    json(
      await user.client.patch(`/api/v2/campaigns/${c.id}`, {
        email_list: [sender],
        campaign_schedule: allDay({ dates: ["2030-01-09"] }),
        sequences: [{ steps: [{ type: "email", delay: 2, delay_unit: "days", variants: [{ subject: "Hello", body: "<p>Hi</p>" }] }] }],
      }),
    );
    json(await user.client.post("/api/v2/leads", { email: "waits@days-off.test", campaign: c.id }));
    await db.update(schema.campaigns).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.campaigns.id, c.id));
    const f = (await todayReport(ws, { mailboxes: false }, now)).flows.find((x) => x.id === c.id)!;
    assert.deepEqual(f.held, [{ reason: "schedule", emails: 1, text: "Today is a day off: one of its own dates." }]);
    assert.equal(f.window.next_open_at, "2030-01-10T00:00:00.000Z");
  });
});
