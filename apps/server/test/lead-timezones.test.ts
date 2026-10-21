// A lead's timezone (packages/shared/src/lead-timezones.ts): explicit zones, abbreviations and offsets; places written
// the ways lead lists write them; phone country codes. Then "send in each lead's timezone": leads get their timezone
// when added or edited (or from the engine's pass), and the sender only emails leads whose own clock has the window open.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { CampaignNotSendingStatus, CampaignStatus, EsgCode, EspCode, KNOWN_LEAD_ZONES, canonicalZone, inferLeadTimezone, parseTimezone, zoneForPhone, zoneForPlace } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { anyOpen, inZone, openSpans, zoneSchedules } from "../src/lib/time";
import { fillLeadTimezones, forgetLeadZones, resetTimezonePass } from "../src/services/lead-zones";

describe("lead timezones", () => {
  it("only name real timezones", () => {
    for (const zone of KNOWN_LEAD_ZONES) assert.ok(canonicalZone(zone), zone);
  });

  it("read explicit timezones, abbreviations and offsets", () => {
    const cases: Array<[string, string | null]> = [
      ["Europe/Berlin", "Europe/Berlin"],
      ["america/new_york", "America/New_York"],
      ["America/New York", "America/New_York"],
      ["EST", "America/New_York"],
      ["Pacific Time (US & Canada)", "America/Los_Angeles"],
      ["Central Standard Time", "America/Chicago"],
      ["CET", "Europe/Paris"],
      ["UTC", "UTC"],
      ["UTC+2", "Etc/GMT-2"],
      ["GMT-05:00", "Etc/GMT+5"],
      ["+05:30", "Asia/Kolkata"],
      ["UTC+0", "UTC"],
      ["UTC+15", null],
      ["Mars/Olympus", null],
      ["", null],
    ];
    for (const [input, zone] of cases) assert.equal(parseTimezone(input), zone, input);
  });

  it("read places the ways lead lists write them", () => {
    const cases: Array<[string, string | null]> = [
      ["Austin, Texas, United States", "America/Chicago"],
      ["Austin, TX", "America/Chicago"],
      ["Denver CO", "America/Denver"],
      ["San Francisco Bay Area", "America/Los_Angeles"],
      ["Greater Seattle Area", "America/Los_Angeles"],
      ["Washington DC-Baltimore Area", null],
      ["Washington, District of Columbia, United States", "America/New_York"],
      ["Toronto, Ontario, Canada", "America/Toronto"],
      ["Sydney NSW, Australia", "Australia/Sydney"],
      ["Berlin, Germany", "Europe/Berlin"],
      ["London, England, United Kingdom", "Europe/London"],
      ["London", "Europe/London"],
      ["Bengaluru, Karnataka, India", "Asia/Kolkata"],
      ["São Paulo, Brazil", "America/Sao_Paulo"],
      ["IN", "Asia/Kolkata"],
      ["United States", null],
      ["Canada", null],
      ["Somewhere nice", null],
    ];
    for (const [location, zone] of cases) assert.equal(zoneForPlace({ location }), zone, location);
    assert.equal(zoneForPlace({ city: "Boise", state: "ID", country: "US" }), "America/Boise");
    assert.equal(zoneForPlace({ state: "Quebec", country: "CA" }), "America/Toronto");
    assert.equal(zoneForPlace({ country: "de" }), "Europe/Berlin");
  });

  it("read the country code of international phone numbers", () => {
    assert.equal(zoneForPhone("+44 20 7946 0000"), "Europe/London");
    assert.equal(zoneForPhone("0049 30 1234567"), "Europe/Berlin");
    assert.equal(zoneForPhone("+353 1 555 0100"), "Europe/Dublin");
    assert.equal(zoneForPhone("+1 415 555 0100"), null); // the US and Canada share +1
    assert.equal(zoneForPhone("020 7946 0000"), null);
  });

  it("prefer what's given, then custom fields, then the place, then the phone", () => {
    assert.equal(inferLeadTimezone({ timezone: "Asia/Tokyo", location: "Berlin, Germany" }), "Asia/Tokyo");
    assert.equal(inferLeadTimezone({ payload: { "Time Zone": "PST" }, location: "Berlin, Germany" }), "America/Los_Angeles");
    assert.equal(inferLeadTimezone({ payload: { City: "Chicago", State: "IL", Country: "United States" } }), "America/Chicago");
    assert.equal(inferLeadTimezone({ location: "Remote", phone: "+33 1 23 45 67 89" }), "Europe/Paris");
    assert.equal(inferLeadTimezone({ timezone: "not a zone", location: "Paris, France" }), "Europe/Paris");
    assert.equal(inferLeadTimezone({}), null);
  });
});

const L = schema.leads;
const EVERY_DAY = { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
const hour = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
const at = (iso: string) => Date.parse(iso);

describe("a schedule on each lead's clock", () => {
  // 09:00 to 17:00 in New York; with each lead's timezone, 09:00 to 17:00 wherever the lead is.
  const work = {
    start_date: null,
    end_date: null,
    schedules: [{ name: "Work", timing: { from: "09:00", to: "17:00" }, days: EVERY_DAY, timezone: "America/New_York" }],
    lead_timezone: true,
  };

  it("is open for a timezone when the window is open on that clock", () => {
    const t = at("2030-01-09T08:30:00Z"); // 03:30 in New York, 08:30 in London, 09:30 in Berlin, 17:30 in Tokyo
    assert.equal(anyOpen([work], t), false);
    assert.equal(anyOpen([inZone(work, "Europe/London")], t), false);
    assert.equal(anyOpen([inZone(work, "Europe/Berlin")], t), true);
    // Leads without a timezone (null) go by the schedule's own clock.
    assert.equal(anyOpen(zoneSchedules(work, [null, "Asia/Tokyo"]), t), false);
    assert.equal(anyOpen(zoneSchedules(work, [null, "Europe/Berlin"]), t), true);
    // With the switch off, only the schedule's own clock counts.
    assert.equal(anyOpen(zoneSchedules({ ...work, lead_timezone: false }, ["Europe/Berlin"]), t), false);
  });

  it("merges the open hours of its leads' clocks", () => {
    const day = at("2030-01-09T00:00:00Z");
    // Berlin 08:00 to 16:00 UTC and New York 14:00 to 22:00 UTC overlap: one span.
    assert.deepEqual(openSpans(zoneSchedules(work, [null, "Europe/Berlin"]), day, day + 86_400_000), [[at("2030-01-09T08:00:00Z"), at("2030-01-09T22:00:00Z")]]);
    // Tokyo (00:00 to 08:00 UTC) and New York don't.
    assert.deepEqual(openSpans(zoneSchedules(work, ["Asia/Tokyo", null]), day, day + 86_400_000), [
      [at("2030-01-09T00:00:00Z"), at("2030-01-09T08:00:00Z")],
      [at("2030-01-09T14:00:00Z"), at("2030-01-09T22:00:00Z")],
    ]);
  });
});

// One server for the rest of the file: the owner, and a workspace with four sandbox mailboxes.
let user: TestUser;
let senders: string[];
before(async () => {
  const app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { workspaceName: "Clocks" });
  senders = json(await user.client.post("/api/app/accounts/sandbox", { count: 4, enable_warmup: false })).items.map((a: { email: string }) => a.email);
});
after(stopServer);

describe("leads' timezones", () => {
  let listId: string;
  before(async () => {
    listId = json(await user.client.post("/api/v2/lead-lists", { name: "Everyone" })).id;
  });

  const add = async (lead: Record<string, unknown>) => json(await user.client.post("/api/v2/leads", { list_id: listId, ...lead }));
  const idOf = async (email: string) => (await db.select({ id: L.id }).from(L).where(eq(L.email, email)))[0]!.id;

  it("are worked out when a lead is added, or taken as given", async () => {
    assert.equal((await add({ email: "ana@clock.test", location: "Austin, Texas, United States" })).timezone, "America/Chicago");
    assert.equal((await add({ email: "ben@clock.test", timezone: "CET", location: "Austin, TX" })).timezone, "Europe/Paris");
    assert.equal((await add({ email: "cy@clock.test", phone: "+44 20 7946 0000" })).timezone, "Europe/London");
    assert.equal((await add({ email: "dee@clock.test" })).timezone, null);
    const bad = await user.client.post("/api/v2/leads", { list_id: listId, email: "eve@clock.test", timezone: "Mars/Olympus" });
    assert.match(json(bad, 400).message, /Unknown timezone/);
    // In an import, a timezone nobody can read is worked out from the rest instead.
    json(await user.client.post("/api/v2/leads/add", { list_id: listId, leads: [{ email: "fay@clock.test", timezone: "Mars/Olympus", location: "Berlin, Germany" }] }));
    const [fay] = await db.select({ tz: L.timezone }).from(L).where(eq(L.email, "fay@clock.test"));
    assert.equal(fay?.tz, "Europe/Berlin");
  });

  it("follow the lead's place when it changes, unless one was given", async () => {
    const ana = await idOf("ana@clock.test");
    const ben = await idOf("ben@clock.test");
    assert.equal(json(await user.client.patch(`/api/v2/leads/${ana}`, { location: "Denver, CO" })).timezone, "America/Denver");
    // Ben's was given (CET), so a new place doesn't change it, until it's cleared.
    assert.equal(json(await user.client.patch(`/api/v2/leads/${ben}`, { location: "Sydney NSW, Australia" })).timezone, "Europe/Paris");
    assert.equal(json(await user.client.patch(`/api/v2/leads/${ben}`, { timezone: null })).timezone, "Australia/Sydney");
    assert.equal(json(await user.client.patch(`/api/v2/leads/${ben}`, { timezone: "UTC+2" })).timezone, "Etc/GMT-2");
    json(await user.client.patch(`/api/v2/leads/${ben}`, { timezone: "sometime" }), 400);
  });

  it("are filled in by the engine for leads without one, keeping their updated time", async () => {
    const old = new Date("2030-01-01T00:00:00.000Z");
    const emails = ["ana@clock.test", "dee@clock.test"];
    // As leads added before timezones were kept; one has a custom field saying where they are.
    await db.update(L).set({ payload: { Country: "Japan" } }).where(eq(L.email, "dee@clock.test"));
    await db.update(L).set({ timezone: null, updatedAt: old }).where(inArray(L.email, emails));
    resetTimezonePass();
    await fillLeadTimezones();
    const rows = await db.select({ email: L.email, tz: L.timezone, updatedAt: L.updatedAt }).from(L).where(inArray(L.email, emails));
    assert.deepEqual(rows.map((r) => [r.email, r.tz]).sort(), [
      ["ana@clock.test", "America/Denver"],
      ["dee@clock.test", "Asia/Tokyo"],
    ]);
    for (const r of rows) assert.equal(r.updatedAt.toISOString(), old.toISOString());
  });

  it("go with a new address's provider and gateway", async () => {
    const cy = await idOf("cy@clock.test");
    await db.update(L).set({ espCode: EspCode.OTHER, esgCode: EsgCode.NONE }).where(eq(L.id, cy));
    const free = json(await user.client.patch(`/api/v2/leads/${cy}`, { email: "cy@gmail.com" }));
    assert.deepEqual([free.esp_code, free.esg_code], [EspCode.GOOGLE, EsgCode.NONE]);
    const work = json(await user.client.patch(`/api/v2/leads/${cy}`, { email: "cy@new-employer.test" }));
    assert.deepEqual([work.esp_code, work.esg_code], [EspCode.IN_QUEUE, EsgCode.IN_QUEUE]);
  });
});

describe("sending in each lead's timezone", () => {
  // Open from two hours ago until three hours from now on a UTC clock (and on one an hour ahead, even if the hour turns
  // during the test); closed on clocks six hours behind. The schedule's own clock is nine hours ahead, so leads it can't
  // place wait.
  const aroundNow = (leadTimezone: boolean) => {
    const h = new Date().getUTCHours();
    return {
      start_date: null,
      end_date: null,
      schedules: [{ name: "Around now", timing: { from: hour(h - 2), to: hour(h + 3) }, days: EVERY_DAY, timezone: "Etc/GMT-9" }],
      ...(leadTimezone ? { lead_timezone: true } : {}),
    };
  };

  async function campaign(name: string, leadTimezone: boolean, leads: Array<Record<string, unknown>>) {
    const c = json(await user.client.post("/api/app/campaigns", { name }));
    json(
      await user.client.patch(`/api/v2/campaigns/${c.id}`, {
        email_list: senders,
        campaign_schedule: aroundNow(leadTimezone),
        sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi", body: "<p>Hello</p>" }] }] }],
      }),
    );
    json(await user.client.post("/api/v2/leads/add", { campaign_id: c.id, leads }));
    await db.update(schema.campaigns).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.campaigns.id, c.id));
    return c.id as string;
  }
  const E = schema.emailEvents;
  const emailed = async (campaignId: string) =>
    (await db.select({ email: E.leadEmail }).from(E).where(and(eq(E.campaignId, campaignId), eq(E.type, "sent")))).map((e) => e.email).sort();
  const notSending = async (id: string) => (await db.select({ s: schema.campaigns.notSendingStatus }).from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]?.s;

  it("emails only the leads whose own clock has the window open", async () => {
    const id = await campaign("Each lead's clock", true, [
      { email: "utc@round.test", timezone: "UTC" },
      { email: "plus1@round.test", timezone: "Etc/GMT-1" },
      { email: "minus6@round.test", timezone: "Etc/GMT+6" },
      { email: "nowhere@round.test" },
    ]);
    forgetLeadZones();
    await runSender();
    assert.deepEqual(await emailed(id), ["plus1@round.test", "utc@round.test"]);
    const status = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`)).diagnostics;
    assert.equal(status.schedule_open, true);
    assert.equal(status.lead_timezone, true);
  });

  it("is outside the schedule when every lead's window is closed", async () => {
    const id = await campaign("All closed", true, [{ email: "minus6b@round.test", timezone: "Etc/GMT+6" }, { email: "nowhere-b@round.test" }]);
    forgetLeadZones();
    await runSender();
    assert.deepEqual(await emailed(id), []);
    assert.equal(await notSending(id), CampaignNotSendingStatus.OUTSIDE_SCHEDULE);
    const status = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.equal(status.diagnostics.schedule_open, false);
    assert.ok(
      status.summary.reasons.some((r: string) => /on every lead's clock/.test(r)),
      status.summary.reasons.join(" "),
    );
  });

  it("goes by the schedule's own clock when the switch is off", async () => {
    const id = await campaign("One clock", false, [{ email: "utc-c@round.test", timezone: "UTC" }]);
    await runSender();
    assert.deepEqual(await emailed(id), []);
    assert.equal(await notSending(id), CampaignNotSendingStatus.OUTSIDE_SCHEDULE);
    // The time is left for the page to show on the schedule's clock, with no zone tacked on.
    const status = json(await user.client.get(`/api/v2/campaigns/${id}/sending-status`));
    assert.ok(
      status.summary.reasons.some((r: string) => /^Outside the sending schedule\. The next window opens at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\.$/.test(r)),
      status.summary.reasons.join(" "),
    );
  });

  it("says in plain words why a campaign isn't running", async () => {
    const c = json(await user.client.post("/api/app/campaigns", { name: "Not yet" }));
    const first = async () => json(await user.client.get(`/api/v2/campaigns/${c.id}/sending-status`)).summary.reasons[0];
    assert.equal(await first(), "The campaign hasn't been launched yet.");
    await db.update(schema.campaigns).set({ status: CampaignStatus.BOUNCE_PROTECT }).where(eq(schema.campaigns.id, c.id));
    assert.equal(await first(), "The campaign was paused by bounce protection.");
  });

  it("fills in the day of the week on the lead's clock", async () => {
    // Kiritimati (UTC+14) and the schedule's clock (UTC-12) are always on different days.
    const id = await campaign("Weekdays", true, [{ email: "kiri@round.test", timezone: "Pacific/Kiritimati" }]);
    const kiri = (await db.select({ id: L.id }).from(L).where(and(eq(L.campaignId, id), eq(L.email, "kiri@round.test"))))[0]!.id;
    const schedule = { ...aroundNow(true), schedules: [{ ...aroundNow(true).schedules[0]!, timezone: "Etc/GMT+12" }] };
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { campaign_schedule: schedule }));
    const weekday = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(new Date());
    const preview = async () => json(await user.client.post(`/api/app/campaigns/${id}/preview`, { lead_id: kiri, subject: "x", body: "{{day_of_week}}" })).body;
    assert.equal(await preview(), weekday("Pacific/Kiritimati"));
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { campaign_schedule: { ...schedule, lead_timezone: false } }));
    assert.equal(await preview(), weekday("Etc/GMT+12"));
  });

  it("keeps the switch with the schedule, and drops it when it's off", async () => {
    const c = json(await user.client.post("/api/app/campaigns", { name: "Saved" }));
    json(await user.client.patch(`/api/v2/campaigns/${c.id}`, { campaign_schedule: aroundNow(true) }));
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${c.id}`)).campaign_schedule.lead_timezone, true);
    json(await user.client.patch(`/api/v2/campaigns/${c.id}`, { campaign_schedule: { ...aroundNow(false), lead_timezone: false } }));
    assert.equal(json(await user.client.get(`/api/v2/campaigns/${c.id}`)).campaign_schedule.lead_timezone, undefined);
  });
});
