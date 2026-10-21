// What happens when replies arrive: opt-outs, out-of-office pauses, quoted text, stopping a lead across campaigns,
// the last look before a follow-up, the reply agent's scope and stale drafts, and replies that arrive without a lead.
// Mail goes through a sandbox mailbox and the real inbox sync; the AI is a local fake (nothing leaves the process).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { EmailType, LeadStatus } from "@reachstack/shared";
import { client, db, schema } from "../src/db/client";
import { syncAccount } from "../src/engine/inbox-sync";
import { runSender } from "../src/engine/sender";
import { buildRaw, newMessageId } from "../src/mail/compose";
import { detectOptOut, isAbsenceNotice, newestReplyText, parseReturnDate, replyWords, resumeAfterAbsence } from "../src/mail/reply-text";
import { storeSandboxMessage } from "../src/mail/sandbox";
import { runInboxManager, runInboxManagers } from "../src/services/agents/inbox-manager";
import { classifyByRules } from "../src/services/agents/reply-classifier";
import { holdSend } from "../src/services/replies";
import { patchWorkspaceSettings } from "../src/services/workspaces";

// ---------- A local stand-in for the AI (the client is created on first use, so it picks this fetch up) ----------

const aiCalls: Array<{ system: string; said: string }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  const req = JSON.parse(String(init?.body ?? "{}"));
  const props = Object.keys(req.output_config?.format?.schema?.properties ?? {});
  const last = [...(req.messages ?? [])].reverse().find((m: { role: string }) => m.role === "user");
  const said: string = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b: { text?: string }) => b.text ?? "").join(" ");
  aiCalls.push({ system: JSON.stringify(req.system ?? ""), said });
  const reply = /<reply>\n([\s\S]*?)\n<\/reply>/.exec(said)?.[1] ?? said;
  const out = props.includes("decision")
    ? { decision: "reply", reply_text: "Hi Pat,\n\nThanks for getting back to me. Which times suit you this week?\n\nSam", confidence: 90, needs_human: false, human_reason: "", information_requested: "", used_booking_link: false }
    : { label: /not interested/i.test(reply) ? "Not interested" : "Interested", confidence: 0.9, reason: "Test reading" };
  const message = { id: "msg_test", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });
const FIRST = "<p>Hello {{firstName}}, a quick question about your pricing page. If it isn't for you, just say and I'll stop emailing you.</p>";

let app: FastifyInstance;
let user: TestUser;
let sender: string;
let workspaceId: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Replies Co" });
  workspaceId = user.workspaceId!;
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  // No pause between this mailbox's emails, so each sender pass can send.
  await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, sender));
});
after(stopServer);

async function campaign(name: string, leads: string[], extra: Record<string, unknown> = {}, subject = "Hi {{firstName}}") {
  const c = user.client;
  const created = json(await c.post("/api/app/campaigns", { name }));
  json(await c.patch(`/api/v2/campaigns/${created.id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps: [step(subject, FIRST), step("", "<p>Following up, {{firstName}}.</p>")] }], ...extra }));
  for (const email of leads) json(await c.post("/api/v2/leads", { email, first_name: "Pat", campaign: created.id }));
  return created.id as string;
}

async function launch(id: string) {
  expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
}

const leadOf = async (campaignId: string, email: string) => (await db.select().from(schema.leads).where(and(eq(schema.leads.campaignId, campaignId), eq(schema.leads.email, email))))[0]!;
const campaignSends = async (leadId: string) => db.select().from(schema.emails).where(and(eq(schema.emails.leadId, leadId), eq(schema.emails.ueType, EmailType.CAMPAIGN_SENT)));

/** Runs the sender until the lead has `count` campaign emails (each pass sends one email per mailbox). */
async function sendUntil(leadId: string, count: number) {
  for (let i = 0; i < 10 && (await campaignSends(leadId)).length < count; i++) await runSender();
  assert.equal((await campaignSends(leadId)).length, count, "campaign emails sent");
}

/** The Message-ID of the latest campaign email to a lead, for In-Reply-To. */
const lastSentId = async (leadId: string) => (await campaignSends(leadId)).sort((a, b) => b.timestampEmail.getTime() - a.timestampEmail.getTime())[0]!.messageId;

async function sync() {
  const [account] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, sender));
  await syncAccount(account!);
}

/** A message arriving in the sandbox mailbox (the inbox by default), then an inbox sync. */
async function deliver(opts: { from: string; name?: string; subject?: string; text: string; inReplyTo?: string | null; auto?: boolean; folder?: string; date?: Date; sync?: boolean }) {
  const msg = {
    from: { name: opts.name ?? "Pat", address: opts.from },
    to: [{ name: "Sam", address: sender }],
    subject: opts.subject ?? "Re: Hi Pat",
    text: opts.text,
    html: null,
    messageId: newMessageId(opts.from),
    inReplyTo: opts.inReplyTo ?? null,
    references: opts.inReplyTo ? [opts.inReplyTo] : [],
    headers: opts.auto ? { "Auto-Submitted": "auto-replied", "X-Autoreply": "yes" } : undefined,
    date: opts.date ?? new Date(),
  };
  const raw = await buildRaw(msg);
  await storeSandboxMessage({ workspaceId, mailbox: sender, folder: opts.folder ?? "INBOX", raw, messageId: msg.messageId, inReplyTo: msg.inReplyTo, from: opts.from, subject: msg.subject, date: msg.date });
  if (opts.sync !== false) await sync();
  return msg.messageId;
}

const quoted = (text: string) => `${text}\n\nOn Thu, 15 Oct 2026 at 09:00, Sam <${sender}> wrote:\n> Hello Pat, a quick question about your pricing page. If it isn't for you,\n> just say and I'll stop emailing you.`;

/** Bus listeners run after the reply is filed; wait until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 40; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));

// ---------- Reading a reply ----------

describe("reading a reply", () => {
  it("keeps only what the person wrote this time", () => {
    assert.equal(newestReplyText(quoted("Sounds good, Tuesday works.")), "Sounds good, Tuesday works.");
    assert.equal(newestReplyText("Thanks!\n\n-----Original Message-----\nFrom: Sam\nPlease stop emailing me"), "Thanks!");
    assert.equal(newestReplyText("Yes please.\n\nFrom: Sam <sam@example.test>\nSent: Thursday\nTo: Pat\nSubject: Hi"), "Yes please.");
    assert.equal(newestReplyText("Call me Monday.\n--\nPat Lee\nUnsubscribe from our newsletter here"), "Call me Monday.");
    assert.equal(newestReplyText("Sure.\n\nSent from my iPhone"), "Sure.");
  });

  it("tells opt-outs from replies that only mention the words", () => {
    assert.equal(detectOptOut("Re: Hi Pat", "Thanks, but please remove me from your list."), "reply");
    assert.equal(detectOptOut("Re: Hi Pat", "STOP"), "reply");
    assert.equal(detectOptOut("unsubscribe", "This message was automatically generated by Gmail."), "request");
    assert.equal(detectOptOut("Unsubscribe", ""), "request");
    assert.equal(detectOptOut("Re: Hi Pat", "Please don't unsubscribe me, just write again next month."), null);
    assert.equal(detectOptOut("Re: Hi Pat", newestReplyText(quoted("Interesting, tell me more."))), null);
    assert.equal(detectOptOut("Re: Hi Pat", "Can you remove me from the cc and add my colleague?"), null);
  });

  it("finds the return date in an out-of-office notice", () => {
    const sent = new Date("2026-10-15T08:00:00Z"); // a Thursday
    assert.equal(parseReturnDate("I'm out of the office and back on 21 October.", sent), "2026-10-21");
    assert.equal(parseReturnDate("I am on annual leave, returning Monday.", sent), "2026-10-19");
    assert.equal(parseReturnDate("Away until 2026-10-27 with limited access to email.", sent), "2026-10-27");
    assert.equal(parseReturnDate("Ich bin bis zum 24.10. nicht im Büro.", sent), "2026-10-24");
    assert.equal(parseReturnDate("Out from 16 October to 2 November, back on the 3rd? No: back on November 3.", sent), "2026-11-03");
    assert.equal(parseReturnDate("I'm on holiday for two weeks.", sent), "2026-10-29");
    assert.equal(parseReturnDate("Out of office.", sent), null);
    assert.equal(parseReturnDate("I was away until 2026-10-01.", sent), null); // already past
    assert.ok(isAbsenceNotice("Automatic reply: Hi Pat", "I'm out of the office until Monday."));
    assert.ok(!isAbsenceNotice("Re: Hi Pat", "Thanks, we received your request #1234."));
  });

  it("pauses until the day after the return date, a week without one, and 30 days at most", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    assert.equal(resumeAfterAbsence("2026-10-21", now).toISOString(), "2026-10-22T00:00:00.000Z");
    assert.equal(resumeAfterAbsence("2026-10-21", now, "Asia/Karachi").toISOString(), "2026-10-21T19:00:00.000Z");
    assert.equal(resumeAfterAbsence(null, now).toISOString(), "2026-10-22T00:00:00.000Z");
    assert.equal(resumeAfterAbsence("2027-03-01", now).toISOString(), "2026-11-14T08:00:00.000Z");
  });

  it("keyword rules and phrase triggers read the newest text, not our quoted email", () => {
    const text = quoted("Thanks, happy to talk next week.");
    // Read whole, our quoted "I'll stop emailing you" would make this an opt-out.
    assert.equal(classifyByRules("Re: Hi Pat", text, false).category, "unsubscribe");
    assert.equal(classifyByRules("Re: Hi Pat", newestReplyText(text), false).category, "interested");
    assert.doesNotMatch(replyWords({ subject: "Re: Your pricing page", text }), /pricing|stop emailing/);
    assert.match(replyWords({ subject: "Pricing question", text: "Hi" }), /Pricing question/);
    assert.equal(classifyByRules("Automatic reply: Hi", "I'm out of the office until Monday.", true).category, "out_of_office");
    assert.equal(classifyByRules("Re: Hi", "Please take me off your list", false).category, "unsubscribe");
  });
});

// ---------- Opt-outs ----------

describe("opt-outs by reply", () => {
  it("a 'remove me' reply unsubscribes and blocks the address, and still counts as a reply", async () => {
    const id = await campaign("Opt out", ["pat.optout@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.optout@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, text: quoted("Thanks, but we're all set. Please remove me from your list."), inReplyTo: await lastSentId(lead.id) });

    const after = await leadOf(id, lead.email!);
    assert.equal(after.status, LeadStatus.UNSUBSCRIBED);
    assert.equal(after.replyCount, 1);
    const [unsub] = await db.select().from(schema.unsubscribes).where(and(eq(schema.unsubscribes.workspaceId, workspaceId), eq(schema.unsubscribes.email, lead.email!)));
    assert.equal(unsub?.source, "reply");
    const blocked = await db.select().from(schema.blockList).where(and(eq(schema.blockList.workspaceId, workspaceId), eq(schema.blockList.value, lead.email!)));
    assert.equal(blocked.length, 1);
  });

  it("a List-Unsubscribe email unsubscribes without counting as a reply", async () => {
    const id = await campaign("Mailto unsubscribe", ["pat.mailto@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.mailto@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, subject: "unsubscribe", text: "This message was automatically generated by Gmail." });

    const after = await leadOf(id, lead.email!);
    assert.equal(after.status, LeadStatus.UNSUBSCRIBED);
    assert.equal(after.replyCount, 0);
    const [unsub] = await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.email, lead.email!));
    assert.equal(unsub?.source, "header");
    const replies = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "reply")));
    assert.equal(replies.length, 0);
  });
});

// ---------- Out of office ----------

describe("out of office", () => {
  it("pauses the lead until the day after they're back, then the sequence carries on", async () => {
    const id = await campaign("Away", ["pat.away@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.away@example.test");
    await sendUntil(lead.id, 1);
    const back = DateTime.utc().plus({ days: 10 }).startOf("day");
    await deliver({
      from: lead.email!,
      subject: "Automatic reply: Hi Pat",
      text: `Thank you for your email. I'm out of the office until ${back.toFormat("d LLLL yyyy")} with limited access to email.`,
      inReplyTo: await lastSentId(lead.id),
      auto: true,
    });

    const paused = await leadOf(id, lead.email!);
    assert.equal(paused.status, LeadStatus.ACTIVE, "not stopped");
    assert.equal(paused.replyCount, 0, "not counted as a reply");
    assert.equal(paused.nextSendAt, back.plus({ days: 1 }).toMillis());
    const [ev] = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "auto_reply")));
    assert.match(ev!.detail ?? "", /^Out of office until .+\. Emails resume .+\.$/);

    // Nothing goes out while they're away…
    await runSender();
    assert.equal((await campaignSends(lead.id)).length, 1);
    // …and once the pause is over, the next step does.
    await db.update(schema.leads).set({ nextSendAt: Date.now() - 1000 }).where(eq(schema.leads.id, lead.id));
    await sendUntil(lead.id, 2);
  });

  it("pauses the same person in other campaigns too", async () => {
    const a = await campaign("Away A", ["pat.away2@example.test"]);
    const b = await campaign("Away B", ["pat.away2@example.test"]);
    await launch(a);
    const lead = await leadOf(a, "pat.away2@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, subject: "Out of office", text: "I'm on parental leave and will not see your email.", inReplyTo: await lastSentId(lead.id), auto: true });
    const other = await leadOf(b, lead.email!);
    assert.equal(other.status, LeadStatus.ACTIVE);
    // No return date: a week.
    assert.equal(other.nextSendAt, DateTime.utc().plus({ days: 7 }).startOf("day").toMillis());
  });

  it("still stops the lead when the campaign stops on automatic replies", async () => {
    const id = await campaign("Stops on auto", ["pat.autostop@example.test"], { stop_on_auto_reply: true });
    await launch(id);
    const lead = await leadOf(id, "pat.autostop@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, subject: "Automatic reply: Hi Pat", text: "I'm out of the office until Monday.", inReplyTo: await lastSentId(lead.id), auto: true });
    assert.equal((await leadOf(id, lead.email!)).status, LeadStatus.COMPLETED);
  });

  it("someone else's out-of-office on the thread leaves the lead alone", async () => {
    const id = await campaign("Colleague away", ["pat.colleague@example.test"], { stop_on_auto_reply: true });
    await launch(id);
    const lead = await leadOf(id, "pat.colleague@example.test");
    await sendUntil(lead.id, 1);
    const before = await leadOf(id, lead.email!);
    await deliver({ from: "jo.rivera@example.test", name: "Jo Rivera", subject: "Automatic reply: Hi Pat", text: "I'm out of the office until next month with limited access to email.", inReplyTo: await lastSentId(lead.id), auto: true });
    await settle();
    const after = await leadOf(id, lead.email!);
    const filed = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "auto_reply")));
    assert.equal(filed.length, 1, "filed on the lead's thread");
    assert.equal(after.status, LeadStatus.ACTIVE, "not stopped, though the campaign stops on automatic replies");
    assert.equal(after.nextSendAt, before.nextSendAt, "not paused");
    assert.equal(after.interestStatus, before.interestStatus, "not labelled out of office");
  });

  it("someone away who writes back themselves, quoting the email, has replied", async () => {
    const id = await campaign("Away but answers", ["pat.answers@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.answers@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, text: quoted("I'm on vacation until the 20th, but yes, let's talk when I'm back."), inReplyTo: await lastSentId(lead.id) });
    const after = await leadOf(id, lead.email!);
    assert.equal(after.replyCount, 1, "a reply, not an automatic one");
    assert.equal(after.status, LeadStatus.COMPLETED);
    const [filed] = await db.select().from(schema.emails).where(and(eq(schema.emails.leadId, lead.id), eq(schema.emails.ueType, EmailType.RECEIVED)));
    assert.equal(filed?.isAutoReply, 0);
  });
});

// ---------- Quoted text ----------

describe("quoted text", () => {
  it("doesn't set off phrase triggers, subsequences or labels", async () => {
    expectStatus(await user.client.put("/api/app/blocklist/settings", { triggers: { statuses: [], phrases: ["stop emailing"] } }), 200);
    await patchWorkspaceSettings(workspaceId, { auto_label_with_ai: true });
    const id = await campaign("Quoted", ["pat.quoted@example.test", "pat.pricing@example.test"]);
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Pricing questions", conditions: { reply_contains: "pricing" } }));
    json(await user.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: [{ steps: [step("", "<p>Here's how pricing works.</p>")] }] }));
    expectStatus(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`), 200);
    await launch(id);
    const quiet = await leadOf(id, "pat.quoted@example.test");
    const asks = await leadOf(id, "pat.pricing@example.test");
    await sendUntil(quiet.id, 1);
    await sendUntil(asks.id, 1);

    const before = aiCalls.length;
    await deliver({ from: quiet.email!, subject: "Re: Your pricing page", text: quoted("Thanks, happy to talk next week."), inReplyTo: await lastSentId(quiet.id) });
    await eventually(async () => (await leadOf(id, quiet.email!)).interestStatus !== null, "the reply label");
    await settle();
    const lead = await leadOf(id, quiet.email!);
    assert.equal(lead.status, LeadStatus.COMPLETED, "stopped by the reply, not unsubscribed");
    assert.equal(lead.subsequenceId, null, "quoted 'pricing' doesn't start the subsequence");
    const blocked = await db.select().from(schema.blockList).where(and(eq(schema.blockList.workspaceId, workspaceId), eq(schema.blockList.value, quiet.email!)));
    assert.equal(blocked.length, 0, "quoted 'stop emailing' doesn't block");
    const labelCalls = aiCalls.slice(before).filter((c) => c.system.includes("You label replies"));
    assert.ok(labelCalls.length >= 1);
    for (const c of labelCalls) assert.doesNotMatch(c.said, /pricing|stop emailing/);

    // The lead's own words still count.
    await deliver({ from: asks.email!, text: quoted("What does your pricing look like for a team of five?"), inReplyTo: await lastSentId(asks.id) });
    await eventually(async () => (await leadOf(id, asks.email!)).subsequenceId === sub.id, "the subsequence");
  });
});

// ---------- Across campaigns ----------

describe("a reply stops the lead in other campaigns", () => {
  it("by default, except campaigns that keep sending after a reply", async () => {
    const a = await campaign("Cross A", ["pat.cross@example.test"]);
    const b = await campaign("Cross B", ["pat.cross@example.test"]);
    const keep = await campaign("Cross keeps going", ["pat.cross@example.test"], { stop_on_reply: false });
    await launch(a);
    const lead = await leadOf(a, "pat.cross@example.test");
    await sendUntil(lead.id, 1);
    // B has the lead waiting in a subsequence as well.
    await db.update(schema.leads).set({ subseqStatus: LeadStatus.ACTIVE, subseqNextSendAt: Date.now() + 86_400_000 }).where(eq(schema.leads.id, (await leadOf(b, lead.email!)).id));
    await deliver({ from: lead.email!, text: "Sounds interesting, let's talk.", inReplyTo: await lastSentId(lead.id) });

    assert.equal((await leadOf(a, lead.email!)).status, LeadStatus.COMPLETED);
    const other = await leadOf(b, lead.email!);
    assert.equal(other.status, LeadStatus.COMPLETED);
    assert.equal(other.subseqStatus, LeadStatus.COMPLETED);
    assert.equal((await leadOf(keep, lead.email!)).status, LeadStatus.ACTIVE);
  });

  it("not when the workspace turned it off", async () => {
    expectStatus(await user.client.patch("/api/app/workspaces/current/settings", { stop_campaign_on_lead_reply_from_any_campaign: false }), 200);
    try {
      const a = await campaign("Apart A", ["pat.apart@example.test"]);
      const b = await campaign("Apart B", ["pat.apart@example.test"]);
      await launch(a);
      const lead = await leadOf(a, "pat.apart@example.test");
      await sendUntil(lead.id, 1);
      await deliver({ from: lead.email!, text: "Sounds interesting, let's talk.", inReplyTo: await lastSentId(lead.id) });
      assert.equal((await leadOf(a, lead.email!)).status, LeadStatus.COMPLETED);
      assert.equal((await leadOf(b, lead.email!)).status, LeadStatus.ACTIVE);
    } finally {
      expectStatus(await user.client.patch("/api/app/workspaces/current/settings", { stop_campaign_on_lead_reply_from_any_campaign: true }), 200);
    }
  });
});

// ---------- Before a follow-up ----------

describe("stop for company", () => {
  it("stops colleagues in a subsequence or paused when one of them replies", async () => {
    const emails = ["pat@acme-company.example.test", "kim@acme-company.example.test", "lee@acme-company.example.test"];
    const id = await campaign("Company stop", emails, { stop_for_company: true });
    await launch(id);
    const pat = await leadOf(id, emails[0]!);
    await sendUntil(pat.id, 1);
    // Kim is in a subsequence, Lee was paused by hand.
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Later", conditions: { crm_status: [1] } }));
    await db
      .update(schema.leads)
      .set({ status: LeadStatus.COMPLETED, subsequenceId: sub.id, subseqStatus: LeadStatus.ACTIVE, subseqNextSendAt: Date.now() + 86_400_000 })
      .where(eq(schema.leads.email, emails[1]!));
    await db.update(schema.leads).set({ status: LeadStatus.PAUSED }).where(eq(schema.leads.email, emails[2]!));
    await deliver({ from: pat.email!, text: "Yes, let's talk next week.", inReplyTo: await lastSentId(pat.id) });
    await settle();
    assert.equal((await leadOf(id, emails[1]!)).subseqStatus, LeadStatus.COMPLETED, "the colleague in a subsequence");
    assert.equal((await leadOf(id, emails[2]!)).status, LeadStatus.COMPLETED, "the paused colleague");
  });
});

describe("the last look before a follow-up", () => {
  it("holds the follow-up when a reply was filed after the last email", async () => {
    const id = await campaign("Last look", ["pat.late@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.late@example.test");
    await sendUntil(lead.id, 1);
    const sentLead = await leadOf(id, lead.email!);
    // A reply that was filed, but whose handling never ran (a crash, say).
    await db.insert(schema.emails).values({
      workspaceId,
      messageId: "<late-reply-1@example.test>",
      threadId: sentLead.threadId,
      subject: "Re: Hi Pat",
      fromAddress: lead.email,
      leadEmail: lead.email,
      leadId: lead.id,
      campaignId: id,
      eaccount: sender,
      ueType: EmailType.RECEIVED,
      bodyText: "Yes, let's talk.",
      timestampEmail: new Date(),
      createdAt: new Date(Date.now() + 1000),
    });
    await db.update(schema.leads).set({ nextSendAt: Date.now() - 1000 }).where(eq(schema.leads.id, lead.id));
    await runSender();
    assert.equal((await campaignSends(lead.id)).length, 1, "no follow-up");
    assert.equal((await leadOf(id, lead.email!)).status, LeadStatus.COMPLETED);
  });

  it("reads the lead and the campaign again, in case they changed since the sending pass loaded them", async () => {
    const id = await campaign("Stale row", ["pat.stale@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.stale@example.test");
    const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
    assert.equal(await holdSend("campaign", row!, lead, {}), false);
    await db.update(schema.leads).set({ status: LeadStatus.UNSUBSCRIBED }).where(eq(schema.leads.id, lead.id));
    assert.equal(await holdSend("campaign", row!, lead, {}), true);
    await db.update(schema.leads).set({ status: LeadStatus.ACTIVE, nextSendAt: Date.now() + 86_400_000 }).where(eq(schema.leads.id, lead.id));
    assert.equal(await holdSend("campaign", row!, lead, {}), true, "paused (out of office) meanwhile");
    await db.update(schema.leads).set({ nextSendAt: null, nextStep: 1 }).where(eq(schema.leads.id, lead.id));
    assert.equal(await holdSend("campaign", row!, lead, {}), true, "moved on to another step meanwhile");
    await db.update(schema.leads).set({ nextStep: 0 }).where(eq(schema.leads.id, lead.id));
    assert.equal(await holdSend("campaign", row!, lead, {}), false);
    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/pause`), 200);
    assert.equal(await holdSend("campaign", row!, lead, {}), true, "the campaign was paused meanwhile");
  });
});

// ---------- Other folders ----------

describe("replies in other folders", () => {
  it("count when a filter archived them, and archived mail from strangers is left alone", async () => {
    const id = await campaign("Archived", ["pat.archived@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.archived@example.test");
    await sendUntil(lead.id, 1);
    await deliver({ from: lead.email!, text: "Yes, interested.", inReplyTo: await lastSentId(lead.id), folder: "Archive" });
    assert.equal((await leadOf(id, lead.email!)).status, LeadStatus.COMPLETED);
    const [filed] = await db.select().from(schema.emails).where(and(eq(schema.emails.leadId, lead.id), eq(schema.emails.ueType, EmailType.RECEIVED)));
    assert.equal(filed?.folder, "archive");

    await deliver({ from: "newsletter@shop.test", subject: "Our autumn sale", text: "Big savings", folder: "Archive" });
    const stranger = await db.select().from(schema.emails).where(eq(schema.emails.fromAddress, "newsletter@shop.test"));
    assert.equal(stranger.length, 0);
  });
});

// ---------- The reply agent ----------

describe("the reply agent", () => {
  it("answers only its tagged campaigns, leaves out-of-office alone and drops drafts that went stale", async () => {
    const c = user.client;
    // Labels come from the agent alone here.
    await patchWorkspaceSettings(workspaceId, { auto_label_with_ai: false });
    const tagged = await campaign("Agent tagged", ["pat.agent@example.test", "pat.agentooo@example.test"]);
    const other = await campaign("Agent untagged", ["pat.agentother@example.test"]);
    await launch(tagged);
    await launch(other);
    const mine = await leadOf(tagged, "pat.agent@example.test");
    const away = await leadOf(tagged, "pat.agentooo@example.test");
    const theirs = await leadOf(other, "pat.agentother@example.test");
    for (const l of [mine, away, theirs]) await sendUntil(l.id, 1);

    const tag = json(await c.post("/api/v2/custom-tags", { label: "Reply agent" }));
    json(await c.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [tag.id], resource_type: 2, resource_ids: [tagged], assign: true }));
    const agent = json(await c.post("/api/v2/ai-agents/inbox-manager", { name: "Replies", payload: { configuration_type: 1, tags: [tag.id] } }));
    // Switched on an hour ago; replies filed a minute ago (the agent waits 30 seconds for labels first).
    const [row] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent.id));
    await db
      .update(schema.aiAgents)
      .set({ payload: { ...(row!.payload ?? {}), active_since: new Date(Date.now() - 3_600_000).toISOString() } })
      .where(eq(schema.aiAgents.id, agent.id));
    const backdate = () => db.update(schema.emails).set({ createdAt: new Date(Date.now() - 60_000) }).where(and(eq(schema.emails.workspaceId, workspaceId), eq(schema.emails.ueType, EmailType.RECEIVED)));
    const agentRow = async () => (await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent.id)))[0]!;
    const drafts = () => db.select().from(schema.aiAgentReplies).where(eq(schema.aiAgentReplies.agentId, agent.id)).orderBy(desc(schema.aiAgentReplies.createdAt));

    await deliver({ from: mine.email!, text: quoted("Sounds interesting, tell me more."), inReplyTo: await lastSentId(mine.id) });
    await deliver({ from: theirs.email!, text: "Sounds interesting, tell me more.", inReplyTo: await lastSentId(theirs.id) });
    await deliver({ from: away.email!, subject: "Automatic reply: Hi Pat", text: "I'm out of the office until Monday.", inReplyTo: await lastSentId(away.id), auto: true });
    await settle();
    await backdate();
    await runInboxManager(await agentRow());

    let list = await drafts();
    assert.deepEqual(
      list.map((d) => d.leadEmail),
      [mine.email],
      "a draft for the tagged campaign only, none for the out-of-office",
    );
    const first = list[0]!;
    assert.equal((first.usageMetadata as { classification?: { category: string } }).classification?.category, "interested");
    const skipped = await db.select().from(schema.aiAgentEvents).where(and(eq(schema.aiAgentEvents.agentId, agent.id), eq(schema.aiAgentEvents.eventType, "reply_skipped")));
    assert.ok(skipped.some((e) => e.payload.reason === "out_of_office"));
    assert.equal((await leadOf(tagged, mine.email!)).interestStatus, 1, "the agent fills in the lead's status");

    // The lead writes again before anyone sends the draft: it's discarded, and the newer message gets its own.
    await deliver({ from: mine.email!, text: "Also, could we do Thursday?", inReplyTo: await lastSentId(mine.id), date: new Date(Date.now() + 5_000) });
    await backdate();
    await runInboxManager(await agentRow());
    list = await drafts();
    const discarded = list.find((d) => d.id === first.id)!;
    assert.equal(discarded.sendingStatus, -1);
    assert.equal(discarded.errorCode, null);
    assert.equal((discarded.usageMetadata as { discarded?: string }).discarded, "lead_replied_again");
    const second = list.find((d) => d.id !== first.id && d.sendingStatus === 2)!;
    assert.ok(second, "a new draft for the newest message");

    // Someone answers by hand: approving the draft now is refused, and it's discarded.
    const [newest] = await db.select().from(schema.emails).where(eq(schema.emails.id, second.inReplyToEmailId!));
    await db.insert(schema.emails).values({
      workspaceId,
      messageId: "<manual-answer-1@example.test>",
      threadId: newest!.threadId,
      subject: "Re: Hi Pat",
      fromAddress: sender,
      leadEmail: mine.email,
      leadId: mine.id,
      eaccount: sender,
      ueType: EmailType.SENT,
      bodyText: "Thursday works, I'll send an invite.",
      timestampEmail: new Date(Date.now() + 10_000),
    });
    const res = await c.post(`/api/app/ai-agents/inbox-manager/${agent.id}/replies/${second.id}/approve`, {});
    expectStatus(res, 409);
    assert.match(res.json().message, /already answered/);
    const [gone] = await db.select().from(schema.aiAgentReplies).where(eq(schema.aiAgentReplies.id, second.id));
    assert.equal((gone!.usageMetadata as { discarded?: string }).discarded, "answered_by_person");
    const overview = json(await c.get(`/api/app/ai-agents/inbox-manager/${agent.id}/overview`));
    assert.equal(overview.counts.failed, 0, "discarded drafts aren't failures");

    // A newer message gets a draft that is approved and sent: in review mode that's handled by the agent, not "needed you".
    await deliver({ from: mine.email!, text: "Great, talk Thursday.", inReplyTo: await lastSentId(mine.id), date: new Date(Date.now() + 20_000) });
    await backdate();
    await runInboxManager(await agentRow());
    const third = (await drafts()).find((d) => d.sendingStatus === 2);
    assert.ok(third, "a draft for the newest message");
    assert.equal(json(await c.post(`/api/app/ai-agents/inbox-manager/${agent.id}/replies/${third.id}/approve`, {})).sending_status, 1);
    const summary = json(await c.get(`/api/v2/ai-agents/inbox-manager/${agent.id}/analytics/summary`));
    assert.equal(summary.human_intervention, 0, "approving drafts in review mode isn't needing a person");
    assert.equal(summary.resolution_rate, 100, "discarded drafts are left out, the approved one counts");
  });
});

describe("an approved draft", () => {
  it("goes out once, however many times it's approved and whatever the agent's loop is doing", async () => {
    const c = user.client;
    const id = await campaign("Approve once", ["pat.once@example.test"]);
    await launch(id);
    const lead = await leadOf(id, "pat.once@example.test");
    await sendUntil(lead.id, 1);
    const agent = json(await c.post("/api/v2/ai-agents/inbox-manager", { name: "Approve once", payload: { configuration_type: 1 } }));
    await deliver({ from: lead.email!, text: quoted("Sounds good, tell me more."), inReplyTo: await lastSentId(lead.id) });
    await settle();
    const [incoming] = await db.select().from(schema.emails).where(and(eq(schema.emails.leadId, lead.id), eq(schema.emails.ueType, EmailType.RECEIVED)));
    const [draft] = await db
      .insert(schema.aiAgentReplies)
      .values({ workspaceId, agentId: agent.id, threadId: incoming!.threadId, inReplyToEmailId: incoming!.id, leadEmail: lead.email, leadId: lead.id, html: "<p>Thanks, Pat. Does Thursday work?</p>", sendingStatus: 2, actionPending: true, jobType: 1 })
      .returning();

    const approve = () => c.post(`/api/app/ai-agents/inbox-manager/${agent.id}/replies/${draft!.id}/approve`, {});
    const [first, second] = await Promise.all([approve(), approve(), runInboxManagers()]);
    for (const res of [first!, second!]) assert.ok([200, 409].includes(res.statusCode), `approve answered ${res.statusCode}: ${res.body}`);
    await settle();
    const answers = await db.select().from(schema.emails).where(and(eq(schema.emails.threadId, incoming!.threadId!), eq(schema.emails.ueType, EmailType.SENT)));
    assert.equal(answers.length, 1, "one reply went out");
    const [row] = await db.select().from(schema.aiAgentReplies).where(eq(schema.aiAgentReplies.id, draft!.id));
    assert.equal(row!.sendingStatus, 1);
    assert.equal((row!.usageMetadata as { discarded?: string } | null)?.discarded, undefined, "its own email didn't discard it");
    // Approving it again says so.
    assert.match(json(await approve(), 409).message, /already sent/);
  });
});

// ---------- Replies without a lead ----------

describe("which email a reply counts for", () => {
  const twoVariants = { sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Idea A for {{firstName}}", body: FIRST }, { subject: "Idea B for {{firstName}}", body: FIRST }] }] }] };

  it("one that doesn't name the email it answers counts for the last campaign email the lead got", async () => {
    const id = await campaign("Attribution", ["pat@acme-attribution.test"], twoVariants);
    await launch(id);
    const lead = await leadOf(id, "pat@acme-attribution.test");
    await sendUntil(lead.id, 1);
    const [sent] = await campaignSends(lead.id);
    // Since then the lead has moved into a subsequence.
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "After the first email", conditions: { crm_status: [1] } }));
    await db.update(schema.leads).set({ subsequenceId: sub.id, subseqStatus: LeadStatus.ACTIVE }).where(eq(schema.leads.id, lead.id));

    // Written as a new email, so nothing in it names the email it answers.
    await deliver({ from: "pat@acme-attribution.test", subject: "A question", text: "What would this cost us?" });
    const replies = () => db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, lead.id), eq(schema.emailEvents.type, "reply")));
    await eventually(async () => (await replies()).length > 0, "the reply to be counted");
    const [event] = await replies();
    assert.deepEqual([event!.step, event!.variant, event!.subsequenceId], [Number(sent!.step), sent!.variant, null]);
  });

  it("but not for one sent after the reply was written", async () => {
    const id = await campaign("Crossed in the post", ["jo@acme-crossed.test"]);
    await launch(id);
    const lead = await leadOf(id, "jo@acme-crossed.test");
    await sendUntil(lead.id, 1);
    await db.update(schema.emails).set({ timestampEmail: new Date(Date.now() - 3_600_000) }).where(and(eq(schema.emails.leadId, lead.id), eq(schema.emails.ueType, EmailType.CAMPAIGN_SENT)));
    await db.update(schema.leads).set({ nextSendAt: Date.now() - 1000 }).where(eq(schema.leads.id, lead.id));
    await sendUntil(lead.id, 2);
    const followUp = (await campaignSends(lead.id)).find((e) => e.step === "1")!;
    // Written half a minute before the follow-up went out, as a new email.
    await deliver({ from: "jo@acme-crossed.test", subject: "Pricing", text: "What would this cost us?", date: new Date(followUp.timestampEmail.getTime() - 30_000) });
    const E = schema.emailEvents;
    const replies = () => db.select().from(E).where(and(eq(E.leadId, lead.id), eq(E.type, "reply")));
    await eventually(async () => (await replies()).length > 0, "the reply to be counted");
    assert.equal((await replies())[0]!.step, 0);
  });

  it("and replies (and bounces) counted before that are moved to the email they answer", async () => {
    const id = await campaign("Attribution before", ["kai@acme-before.test"], twoVariants);
    await launch(id);
    const lead = await leadOf(id, "kai@acme-before.test");
    await sendUntil(lead.id, 1);
    const [sent] = await campaignSends(lead.id);
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Moved in since", conditions: { crm_status: [1] } }));
    await db.update(schema.leads).set({ subsequenceId: sub.id, subseqStatus: LeadStatus.ACTIVE }).where(eq(schema.leads.id, lead.id));
    // The first names no email; the second answers the campaign email.
    await deliver({ from: "kai@acme-before.test", subject: "A question", text: "What would this cost us?" });
    await deliver({ from: "kai@acme-before.test", text: "And can it start next month?", inReplyTo: sent!.messageId });
    const E = schema.emailEvents;
    const replies = () => db.select().from(E).where(and(eq(E.leadId, lead.id), eq(E.type, "reply"))).orderBy(E.createdAt);
    await eventually(async () => (await replies()).length === 2, "both replies to be counted");

    // As they used to be counted: for the subsequence the lead was in by then, and the one naming no email for the
    // step the lead was on, with no variant.
    const [first, second] = await replies();
    await db.update(E).set({ step: 1, variant: null, subsequenceId: sub.id }).where(eq(E.id, first!.id));
    await db.update(E).set({ subsequenceId: sub.id }).where(eq(E.id, second!.id));
    await db.update(schema.leads).set({ repliedStep: 1, repliedVariant: null }).where(eq(schema.leads.id, lead.id));
    // And a bounce of that email, without its variant.
    const [bounce] = await db.insert(E).values({ workspaceId, type: "bounce", campaignId: id, leadId: lead.id, leadEmail: lead.email, emailId: sent!.id, step: 0, value: 1 }).returning();

    const repair = readFileSync(new URL("../drizzle/0021_event_attribution.sql", import.meta.url), "utf8");
    for (const statement of repair.split("--> statement-breakpoint")) await client.execute(statement);

    const expected = [Number(sent!.step), sent!.variant, null];
    assert.deepEqual(
      (await replies()).map((e) => [e.step, e.variant, e.subsequenceId]),
      [expected, expected],
    );
    const after = await leadOf(id, lead.email!);
    assert.deepEqual([after.repliedStep, after.repliedVariant], [Number(sent!.step), sent!.variant]);
    const [bounced] = await db.select().from(E).where(eq(E.id, bounce!.id));
    assert.deepEqual([bounced!.step, bounced!.variant], [Number(sent!.step), sent!.variant]);
  });
});

describe("a reply that arrived without a lead", () => {
  it("can be linked to its lead, which stops that lead's emails", async () => {
    const id = await campaign("Stray", ["pat@acme-stray.test"], {}, "Stray idea for {{firstName}}");
    await launch(id);
    const lead = await leadOf(id, "pat@acme-stray.test");
    await sendUntil(lead.id, 1);
    // A colleague answers in a new email, so nothing ties it to the lead.
    await deliver({ from: "lee@acme-stray.test", name: "Lee Park", subject: "Re: Stray idea for Pat", text: "Pat forwarded this to me. Can we talk next week?" });
    const [stray] = await db.select().from(schema.emails).where(eq(schema.emails.fromAddress, "lee@acme-stray.test"));
    assert.equal(stray?.leadId, null);

    const suggestions = json(await user.client.get(`/api/app/replies/${stray!.id}/lead-suggestions`));
    assert.equal(suggestions.items[0]?.id, lead.id);
    const found = json(await user.client.get(`/api/app/replies/${stray!.id}/lead-suggestions?q=acme-stray`));
    assert.ok(found.items.some((s: { id: string }) => s.id === lead.id));

    const linked = json(await user.client.post(`/api/app/replies/${stray!.id}/attach`, { lead_id: lead.id }));
    assert.equal(linked.lead.id, lead.id);
    const after = await leadOf(id, lead.email!);
    assert.equal(after.status, LeadStatus.COMPLETED);
    assert.equal(after.replyCount, 1);
    const [moved] = await db.select().from(schema.emails).where(eq(schema.emails.id, stray!.id));
    assert.equal(moved?.leadId, lead.id);
    assert.equal(moved?.threadId, after.threadId, "filed under the lead's conversation");
    expectStatus(await user.client.post(`/api/app/replies/${stray!.id}/attach`, { lead_id: lead.id }), 409);
  });

  it("or its sender becomes a new lead that doesn't get the sequence", async () => {
    const id = await campaign("Stray new lead", [], {}, "Another idea for {{firstName}}");
    await deliver({ from: "kim@other-stray.test", name: "Kim Lee", subject: "Question", text: "Saw your note to my team. What does it cost?" });
    const [stray] = await db.select().from(schema.emails).where(eq(schema.emails.fromAddress, "kim@other-stray.test"));
    const made = json(await user.client.post(`/api/app/replies/${stray!.id}/create-lead`, { campaign_id: id }));
    assert.equal(made.lead.email, "kim@other-stray.test");
    assert.equal(made.lead.first_name, "Kim");
    const lead = await leadOf(id, "kim@other-stray.test");
    assert.equal(lead.status, LeadStatus.COMPLETED);
    const [linked] = await db.select().from(schema.emails).where(eq(schema.emails.id, stray!.id));
    assert.equal(linked?.leadId, lead.id);
    expectStatus(await user.client.post(`/api/app/replies/${stray!.id}/create-lead`, { campaign_id: id }), 409);
  });
});
