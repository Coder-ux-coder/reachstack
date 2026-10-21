// Conversions in analytics: a status the global sync copies to the person's other leads counts once, where it was set;
// a lead's pipeline value counts once however often it turns positive; step opportunities are the period's, credited
// to the email the lead replied to; and each mailbox's figures count a person once for the whole period.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { InterestStatus } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { client, db, schema } from "../src/db/client";
import { setInterestStatus } from "../src/services/activity";
import { moveLeads } from "../src/services/leads";
import { dayOn, daysBefore } from "../src/services/workspace-clock";

const L = schema.leads;
const E = schema.emailEvents;
const DAY = 86_400_000;

let app: FastifyInstance;
let user: TestUser;
let ws: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Cleo", workspaceName: "Conversions Co" });
  ws = user.workspaceId!;
});
after(stopServer);

const campaign = async (name: string) => json(await user.client.post("/api/app/campaigns", { name })).id as string;
const leadRow = async (id: string) => (await db.select().from(L).where(eq(L.id, id)))[0]!;
const overview = async (q: string) => json(await user.client.get(`/api/v2/campaigns/analytics/overview?${q}`));
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe("a status the sync copies to the person's other leads", () => {
  it("counts where it was set, not again in every campaign it was copied to", async () => {
    const a = await campaign("Where they replied");
    const b = await campaign("Also in this one");
    const [inA, inB] = await db
      .insert(L)
      .values([
        { workspaceId: ws, campaignId: a, email: "pat@conversions.example.test" },
        { workspaceId: ws, campaignId: b, email: "pat@conversions.example.test" },
      ])
      .returning();
    await setInterestStatus({ workspaceId: ws, leadIds: [inA!.id], value: InterestStatus.INTERESTED });
    assert.equal((await leadRow(inB!.id)).interestStatus, InterestStatus.INTERESTED, "the sync copied it over");

    assert.equal((await overview(`id=${a}`)).total_interested, 1);
    assert.equal((await overview(`id=${b}`)).total_interested, 0);
    assert.equal((await overview(`ids=${a},${b}`)).total_interested, 1, "one person");
  });
});

describe("figures from before", () => {
  it("count a status the sync had copied, and a lead's value, once too", async () => {
    const [a, b, c] = [await campaign("Replied earlier"), await campaign("Copied earlier"), await campaign("Imported earlier")];
    const [set, copied, imported] = await db
      .insert(L)
      .values([
        { workspaceId: ws, campaignId: a, email: "old@before.example.test", interestStatus: InterestStatus.INTERESTED, lastInterestChangeAt: ago(3) },
        { workspaceId: ws, campaignId: b, email: "old@before.example.test", interestStatus: InterestStatus.INTERESTED, lastInterestChangeAt: ago(3) },
        // A status that came with the lead when it was added: nobody set it elsewhere.
        { workspaceId: ws, campaignId: c, email: "came-with-it@before.example.test", interestStatus: InterestStatus.INTERESTED },
      ])
      .returning();
    const event = (type: string, value: number, daysAgo: number) => ({ workspaceId: ws, campaignId: a, leadId: set!.id, leadEmail: set!.email, type, value, createdAt: ago(daysAgo) });
    await db.insert(E).values([event("interest_change", InterestStatus.INTERESTED, 3), event("opportunity", 500, 3), event("opportunity", 500, 2)]);

    const repair = readFileSync(new URL("../drizzle/0028_interest_synced.sql", import.meta.url), "utf8");
    // The column is there already: only the repairs.
    for (const statement of repair.split("--> statement-breakpoint").slice(1)) await client.execute(statement);

    assert.deepEqual([(await leadRow(set!.id)).interestSynced, (await leadRow(copied!.id)).interestSynced, (await leadRow(imported!.id)).interestSynced], [false, true, false]);
    assert.equal((await overview(`ids=${a},${b},${c}`)).total_interested, 2);
    assert.equal((await overview(`id=${a}`)).total_opportunity_value, 500);
  });
});

describe("a lead's pipeline value", () => {
  it("counts once, however often the lead turns positive", async () => {
    const id = await campaign("Changeable");
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { pl_value: 500 }));
    const [lead] = await db.insert(L).values({ workspaceId: ws, campaignId: id, email: "sam@conversions.example.test" }).returning();
    for (const value of [InterestStatus.INTERESTED, InterestStatus.NOT_INTERESTED, InterestStatus.MEETING_BOOKED]) await setInterestStatus({ workspaceId: ws, leadIds: [lead!.id], value });
    const o = await overview(`id=${id}`);
    assert.equal(o.total_opportunities, 1);
    assert.equal(o.total_opportunity_value, 500);
  });
});

describe("step opportunities", () => {
  type StepRow = { step: string | null; variant: string | null; sent: number; opportunities: number };
  const steps = async (id: string, dates = "") =>
    json<StepRow[]>(await user.client.get(`/api/v2/campaigns/analytics/steps?campaign_id=${id}&include_opportunities_count=true${dates}`)).map((r) => [r.step, r.variant, r.sent, r.opportunities]);

  /** A lead in the campaign that replied first to the email at `step` (variant, subsequence) and is interested. */
  async function converted(campaignId: string, email: string, reply: { step: number; variant: number | null; subsequenceId?: string; daysAgo?: number }, statusDaysAgo = 0) {
    const [lead] = await db
      .insert(L)
      .values({ workspaceId: ws, campaignId, email, interestStatus: InterestStatus.INTERESTED, lastInterestChangeAt: ago(statusDaysAgo), repliedStep: reply.step, repliedVariant: reply.variant, replyCount: 1 })
      .returning();
    await db.insert(E).values({
      workspaceId: ws,
      campaignId,
      subsequenceId: reply.subsequenceId ?? null,
      leadId: lead!.id,
      leadEmail: email,
      type: "reply",
      step: reply.step,
      variant: reply.variant,
      isFirst: true,
      createdAt: ago(reply.daysAgo ?? 1),
    });
    return lead!;
  }

  it("go to the variant the lead replied to, and only this campaign's own steps", async () => {
    const id = await campaign("Two variants");
    await db.insert(E).values([0, 1].map((variant) => ({ workspaceId: ws, campaignId: id, leadEmail: `v${variant}@steps.example.test`, type: "sent", step: 0, variant, createdAt: ago(2) })));
    // A reply from before replies were matched to the email they answer (variant unknown)…
    await converted(id, "unknown@steps.example.test", { step: 0, variant: null });
    // …and one to the follow-up flow's first email, which is no step of the campaign's.
    await converted(id, "flow@steps.example.test", { step: 0, variant: 0, subsequenceId: "some-subsequence" });
    assert.deepEqual(await steps(id), [
      ["0", "0", 1, 0],
      ["0", "1", 1, 0],
      ["0", null, 0, 1],
    ]);
  });

  it("are the leads that turned positive in the period, on a step that went out before it too", async () => {
    const id = await campaign("Slow burners");
    await db.insert(E).values({ workspaceId: ws, campaignId: id, leadEmail: "recent@steps.example.test", type: "sent", step: 0, variant: 0, createdAt: ago(1) });
    await converted(id, "long-ago@steps.example.test", { step: 0, variant: 0 }, 60);
    await converted(id, "slow@steps.example.test", { step: 1, variant: 0, daysAgo: 40 });
    const today = dayOn("UTC");
    assert.deepEqual(await steps(id, `&start_date=${daysBefore(today, 6)}&end_date=${today}`), [
      ["0", "0", 1, 0],
      ["1", "0", 0, 1],
    ]);
  });

  it("stay with the campaign when the lead moves on", async () => {
    const from = await campaign("First go");
    const to = await campaign("Second go");
    const lead = await converted(from, "mover@steps.example.test", { step: 2, variant: 1 });
    await moveLeads({ workspaceId: ws, leadIds: [lead.id], toCampaignId: to });
    const moved = await leadRow(lead.id);
    assert.deepEqual([moved.campaignId, moved.repliedStep, moved.repliedVariant], [to, null, null]);
  });
});

describe("a mailbox's figures", () => {
  it("count each person once for the whole period, and all time without dates", async () => {
    const id = await campaign("Mailbox totals");
    const mailbox = "rep@totals.example.test";
    const [one, two] = await db
      .insert(L)
      .values([
        { workspaceId: ws, campaignId: id, email: "one@totals.example.test" },
        { workspaceId: ws, campaignId: id, email: "two@totals.example.test" },
      ])
      .returning();
    const event = (lead: typeof one, type: string, daysAgo: number, step = 0) => ({ workspaceId: ws, campaignId: id, leadId: lead!.id, leadEmail: lead!.email, accountEmail: mailbox, type, step, variant: 0, createdAt: ago(daysAgo) });
    await db.insert(E).values([event(one, "sent", 60), event(one, "open", 59), event(one, "sent", 2, 1), event(one, "open", 1, 1), event(one, "reply", 1, 1), event(two, "sent", 1)]);

    const totals = async (q = "") => json<Array<{ email: string }>>(await user.client.get(`/api/app/accounts/analytics/totals${q}`)).find((r) => r.email === mailbox);
    assert.deepEqual(await totals(), { email: mailbox, sent: 3, refused: 0, contacted: 2, opened: 1, replied: 1, bounced: 0 });
    const today = dayOn("UTC");
    assert.deepEqual(await totals(`?start_date=${daysBefore(today, 6)}&end_date=${today}`), { email: mailbox, sent: 2, refused: 0, contacted: 2, opened: 1, replied: 1, bounced: 0 });
  });
});
