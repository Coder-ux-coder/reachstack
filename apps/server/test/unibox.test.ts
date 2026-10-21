// Unibox: search across every folder with a count per folder, the "done" state, finding people for the command
// palette, and exports (the list as CSV, conversations as .mbox, one email as .eml). Everything stays inside the
// caller's workspace, and exports carry no secrets or tracking tokens. Every address and value here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type Res, type TestUser } from "./helpers/app";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import Papa from "papaparse";
import { AccountStatus, AuditActivity, EmailType, htmlToText, snippet } from "@reachstack/shared";
import { db, schema } from "../src/db/client";
import { uuidv7 } from "../src/lib/ids";
import { appendOpenPixel, emailToken, rewriteLinks, unsubscribeUrl } from "../src/services/tracking";
import { runScheduledEmails } from "../src/services/unibox";

const MAILBOX = "sales@alice-co.test";
const PAT = "pat@prospect.test";
const IMAP_PASSWORD = "imap-pass-for-unibox-tests-1";
const SMTP_PASSWORD = "smtp-pass-for-unibox-tests-2";
const TRACKING_BASE = "http://localhost:4000";
const PRICES = "https://example.com/prices?a=1&b=2";

let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;
const T = { t1: "", t2: "", t3: "", t4: "", t5: "", t6: "", t7: "", t8: "", t9: "", b1: "" };
const ids = { t1Send: "", t1Reply: "", t8Send: "" };
let tokens: string[] = [];

let clock = Date.now() - 30 * 86_400_000;
/** Inserts one stored email the way inbox sync and the sender do, one minute after the previous one. */
async function addEmail(user: TestUser, e: Partial<typeof schema.emails.$inferInsert> & { threadId: string; ueType: number; subject: string }) {
  const id = e.id ?? uuidv7();
  clock += 60_000;
  await db.insert(schema.emails).values({
    workspaceId: user.workspaceId!,
    messageId: `<${id}@example.test>`,
    eaccount: MAILBOX,
    timestampEmail: new Date(clock),
    isFocused: 1,
    ...e,
    id,
  });
  return id;
}

const received = (from: string, name = "") => ({ ueType: EmailType.RECEIVED, fromAddress: from, fromJson: [{ address: from, name }], toList: MAILBOX, leadEmail: from });
const ours = (to: string, type: number = EmailType.SENT) => ({ ueType: type, fromAddress: MAILBOX, fromJson: [{ address: MAILBOX, name: "Alice Sales" }], toList: to, leadEmail: to });

/** A campaign send stored as sent: open pixel, click-tracking redirect and an unsubscribe link, all carrying its token. */
function trackedSend(id: string, text: string) {
  const html = appendOpenPixel(
    rewriteLinks(`<p>${text} <a href="${PRICES.replace(/&/g, "&amp;")}">prices</a></p><p><a href="${unsubscribeUrl(TRACKING_BASE, id)}">Unsubscribe</a></p>`, TRACKING_BASE, id),
    TRACKING_BASE,
    id,
  );
  tokens.push(emailToken(id));
  return { bodyHtml: html, bodyText: htmlToText(html), contentPreview: snippet(html, 160) };
}

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner; Alice and Bob are ordinary accounts
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Alice Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Bob Co" });

  // A mailbox with a saved password, so the exports can be checked for it.
  expectStatus(
    await alice.client.post("/api/v2/accounts", {
      email: MAILBOX,
      imap_host: "203.0.113.25",
      smtp_host: "203.0.113.25",
      imap_password: IMAP_PASSWORD,
      smtp_password: SMTP_PASSWORD,
      skip_connection_test: true,
    }),
    200,
  );
  const campaign = json(await alice.client.post("/api/app/campaigns", { name: "Spring outreach" }));
  const lead = json(await alice.client.post("/api/v2/leads", { email: PAT, first_name: "Pat", last_name: "Quinn", company_name: "Prospect Labs", campaign: campaign.id }));
  expectStatus(await alice.client.post("/api/v2/leads/update-interest-status", { lead_email: PAT, interest_value: 1 }), 202);

  for (const k of Object.keys(T) as Array<keyof typeof T>) T[k] = uuidv7();
  const soon = new Date(Date.now() + 3 * 86_400_000);

  // T1: a tracked campaign send to Pat and Pat's unread reply (Primary, Sent).
  ids.t1Send = uuidv7();
  await addEmail(alice, { id: ids.t1Send, threadId: T.t1, subject: "Pineapple pricing", ...ours(PAT, EmailType.CAMPAIGN_SENT), leadId: lead.id, campaignId: campaign.id, ...trackedSend(ids.t1Send, "Our pineapple price list:") });
  ids.t1Reply = await addEmail(alice, { threadId: T.t1, subject: "Re: Pineapple pricing", ...received(PAT, "Pat Quinn"), leadId: lead.id, campaignId: campaign.id, bodyText: "Send me the numbers.", contentPreview: "Send me the numbers.", isUnread: 1 });
  // T2: an auto-reply in Others.
  await addEmail(alice, { threadId: T.t2, subject: "Out of office", ...received("ooo@prospect.test", "Jo Rivera"), bodyText: "Back Monday. Ask Jo about the pineapple order.", isFocused: 0, isAutoReply: 1, isUnread: 1 });
  // T3: a manual email nobody answered (Sent only).
  await addEmail(alice, { threadId: T.t3, subject: "Pineapple samples", ...ours("sam@prospect.test"), bodyText: "Samples ship Friday." });
  // T4: a reply that was marked done (Done only).
  await addEmail(alice, { threadId: T.t4, subject: "Thanks, pineapple received", ...received("dana@prospect.test", "Dana"), bodyText: "All good.", archived: true });
  // T5: an unread question with a scheduled answer; only the scheduled email mentions the keyword (Primary, Scheduled).
  await addEmail(alice, { threadId: T.t5, subject: "Question", ...received("lee@prospect.test"), bodyText: "When can we talk?", isUnread: 1 });
  await addEmail(alice, { threadId: T.t5, subject: "Re: Question", ...ours("lee@prospect.test", EmailType.SCHEDULED), bodyText: "Tomorrow works. Bring the pineapple deck.", scheduledAt: soon, timestampEmail: soon });
  // T6: a read reply with a reminder (Primary, Reminders).
  await addEmail(alice, { threadId: T.t6, subject: "Pineapple follow-up", ...received("kim@prospect.test"), bodyText: "Ping me next week.", reminderAt: soon });
  // T7: unrelated, with a subject a spreadsheet would run as a formula.
  await addEmail(alice, { threadId: T.t7, subject: '=HYPERLINK("http://evil.test","open")', ...received("max@prospect.test"), bodyText: "Hello", isUnread: 1 });
  // T8: an unanswered tracked campaign send without the keyword.
  ids.t8Send = uuidv7();
  await addEmail(alice, { id: ids.t8Send, threadId: T.t8, subject: "Price list", ...ours("ana@prospect.test", EmailType.CAMPAIGN_SENT), campaignId: campaign.id, ...trackedSend(ids.t8Send, "Here it is:") });
  // T9: used by the "done" tests.
  await addEmail(alice, { threadId: T.t9, subject: "Done test", ...received("rob@prospect.test"), bodyText: "Nothing to see.", isUnread: 1 });

  // Bob's workspace has mail from the same person, with the same keyword.
  await addEmail(bob, { threadId: T.b1, subject: "Bob's pineapple secret", ...received(PAT, "Pat Q."), eaccount: "bob@bob-co.test", toList: "bob@bob-co.test", bodyText: "Only for Bob.", isUnread: 1 });
});
after(stopServer);

const threadIds = (res: Res) => new Set((json(res).items as Array<{ thread_id: string }>).map((t) => t.thread_id));
const search = (user: TestUser, q: string, extra = "") => user.client.get(`/api/app/unibox/threads?search=${encodeURIComponent(q)}${extra}`);
const counts = async (user: TestUser, q: string) => json(await user.client.get(`/api/app/unibox/search-counts?search=${encodeURIComponent(q)}`));

describe("search across all mail", () => {
  it("finds mail in every folder and tab, and counts it per folder", async () => {
    assert.deepEqual(threadIds(await search(alice, "pineapple", "&folder=all")), new Set([T.t1, T.t2, T.t3, T.t4, T.t5, T.t6]));
    assert.deepEqual(await counts(alice, "pineapple"), { all: 6, primary: 2, others: 1, sent: 2, scheduled: 1, reminders: 1, done: 1 });
  });

  it("each count matches the list for that folder", async () => {
    const lists: Array<[string, string, Set<string>]> = [
      ["primary", "&folder=inbox&mode=emode_focused", new Set([T.t1, T.t6])],
      ["others", "&folder=inbox&mode=emode_others", new Set([T.t2])],
      ["sent", "&folder=sent", new Set([T.t1, T.t3])],
      ["scheduled", "&folder=scheduled", new Set([T.t5])],
      ["reminders", "&folder=reminders", new Set([T.t6])],
      ["done", "&folder=done", new Set([T.t4])],
    ];
    const c = await counts(alice, "pineapple");
    for (const [name, qs, expected] of lists) {
      const got = threadIds(await search(alice, "pineapple", qs));
      assert.deepEqual(got, expected, name);
      assert.equal(c[name], got.size, `${name} count`);
    }
  });

  it("keeps the search operators working across folders", async () => {
    assert.deepEqual(threadIds(await search(alice, "from:dana@prospect.test", "&folder=all")), new Set([T.t4]));
    assert.deepEqual(threadIds(await search(alice, "subject:samples", "&folder=all")), new Set([T.t3]));
    assert.deepEqual(threadIds(await search(alice, "lead:pat@prospect.test", "&folder=all")), new Set([T.t1]));
    assert.deepEqual(await counts(alice, "in:sent pineapple"), { all: 2, primary: 0, others: 0, sent: 2, scheduled: 0, reminders: 0, done: 0 });
    assert.deepEqual(threadIds(await search(alice, "is:done", "&folder=all")), new Set([T.t4]));
  });

  it("other filters still apply while searching every folder", async () => {
    assert.deepEqual(threadIds(await search(alice, "pineapple", "&folder=all&is_unread=true")), new Set([T.t1, T.t2]));
    assert.equal((await counts(alice, "pineapple")).all, 6);
    const unread = json(await alice.client.get(`/api/app/unibox/search-counts?search=pineapple&is_unread=true`));
    assert.equal(unread.all, 2);
  });

  it("only ever looks inside the caller's workspace", async () => {
    assert.deepEqual(threadIds(await search(bob, "pineapple", "&folder=all")), new Set([T.b1]));
    assert.deepEqual(await counts(bob, "pineapple"), { all: 1, primary: 1, others: 0, sent: 0, scheduled: 0, reminders: 0, done: 0 });
    // The same person wrote to both workspaces; each sees only its own conversation.
    assert.deepEqual(threadIds(await search(bob, PAT, "&folder=all")), new Set([T.b1]));
    assert.deepEqual(threadIds(await search(alice, PAT, "&folder=all")), new Set([T.t1]));
    assert.ok(!(await search(alice, "secret", "&folder=all")).body.includes("Bob's pineapple secret"));
    expectStatus(await bob.client.get(`/api/app/unibox/threads/${T.t1}`), 404);
  });
});

describe("done", () => {
  const inbox = async () => threadIds(await alice.client.get("/api/app/unibox/threads"));
  const unreadPrimary = async () => json(await alice.client.get("/api/app/unibox/summary")).unread.primary as number;

  it("takes a conversation out of the inbox and the unread count until a new reply arrives", async () => {
    assert.ok((await inbox()).has(T.t9));
    assert.ok(!(await inbox()).has(T.t4), "a thread marked done earlier stays out of the inbox");
    const before = await unreadPrimary();

    assert.equal(json(await alice.client.post("/api/app/unibox/bulk", { thread_ids: [T.t9], action: "mark_done" })).updated, 1);
    assert.ok(!(await inbox()).has(T.t9));
    assert.ok(threadIds(await alice.client.get("/api/app/unibox/threads?folder=done")).has(T.t9));
    assert.equal(await unreadPrimary(), before - 1);

    await addEmail(alice, { threadId: T.t9, subject: "Re: Done test", ...received("rob@prospect.test"), bodyText: "One more thing.", isUnread: 1 });
    assert.ok((await inbox()).has(T.t9), "a new reply brings it back");
    assert.ok(!threadIds(await alice.client.get("/api/app/unibox/threads?folder=done")).has(T.t9));
    assert.equal(await unreadPrimary(), before);
  });

  it("can be undone, and can't touch another workspace's conversation", async () => {
    json(await alice.client.post("/api/app/unibox/bulk", { thread_ids: [T.t9], action: "mark_done" }));
    json(await alice.client.post("/api/app/unibox/bulk", { thread_ids: [T.t9], action: "mark_not_done" }));
    assert.ok((await inbox()).has(T.t9));
    assert.equal(json(await bob.client.post("/api/app/unibox/bulk", { thread_ids: [T.t1], action: "mark_done" })).updated, 0);
    assert.ok((await inbox()).has(T.t1));
  });
});

describe("find a person", () => {
  const people = async (user: TestUser, q: string) =>
    json(await user.client.get(`/api/app/unibox/people?q=${encodeURIComponent(q)}`)).items as Array<{ email: string; name: string | null; threads: number; company_name: string | null }>;

  it("matches the address, the lead's name or company, and a sender's display name", async () => {
    for (const q of ["pat@prospect", "Quinn", "pat quinn", "prospect labs"]) {
      const pat = (await people(alice, q)).find((p) => p.email === PAT);
      assert.ok(pat, q);
      assert.equal(pat.name, "Pat Quinn", q);
      assert.equal(pat.company_name, "Prospect Labs", q);
      assert.equal(pat.threads, 1, q);
    }
    const jo = (await people(alice, "rivera"))[0];
    assert.equal(jo?.email, "ooo@prospect.test");
    assert.equal(jo?.name, "Jo Rivera");
  });

  it("only knows the caller's workspace", async () => {
    const pat = (await people(bob, "pat")).find((p) => p.email === PAT);
    assert.equal(pat?.threads, 1);
    assert.equal(pat?.name, "Pat Q."); // Bob's own sender name, not Alice's lead
    assert.deepEqual(await people(bob, "rivera"), []);
    assert.deepEqual(await people(bob, "Quinn"), []);
    expectStatus(await alice.client.get("/api/app/unibox/people"), 400);
  });
});

/** Secrets that must never appear in anything the Unibox shows or exports. */
function assertClean(body: string, label: string) {
  for (const s of [IMAP_PASSWORD, SMTP_PASSWORD, alice.client.cookie!, bob.client.cookie!, "_sealed", ...tokens]) {
    assert.ok(!body.includes(s), `${label} contains ${s.slice(0, 12)}…`);
  }
  assert.ok(!/\/t\/[oc]\/[0-9a-f-]{36}\./i.test(body), `${label} contains a tracking URL`);
}

describe("tracking in what the Unibox shows", () => {
  it("the thread view shows our sends without the open pixel or tracking tokens", async () => {
    const res = await alice.client.get(`/api/app/unibox/threads/${T.t1}`);
    expectStatus(res, 200);
    assertClean(res.body, "thread");
    const send = json(res).emails.find((e: { id: string }) => e.id === ids.t1Send);
    assert.ok(send.body.html.includes(PRICES.replace(/&/g, "&amp;")), "the link points at its real target");
    assert.ok(!/<img/i.test(send.body.html));
  });
});

describe("export", () => {
  const csvRows = (res: Res) => {
    expectStatus(res, 200);
    assert.match(String(res.headers["content-type"]), /^text\/csv/);
    assert.match(String(res.headers["content-disposition"]), /^attachment; filename="unibox-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.ok(res.body.startsWith("\ufeff"), "starts with a byte order mark for Excel");
    const parsed = Papa.parse<Record<string, string>>(res.body.slice(1), { header: true, skipEmptyLines: true });
    assert.deepEqual(parsed.meta.fields, ["from", "to", "subject", "date", "label", "campaign", "last_message", "lead", "messages"]);
    return parsed.data;
  };

  it("the list as CSV holds the workspace's matching conversations and no secrets", async () => {
    const res = await alice.client.get("/api/app/unibox/export/csv?folder=all&search=pineapple");
    const rows = csvRows(res);
    assert.deepEqual(new Set(rows.map((r) => r.subject)), new Set(["Re: Pineapple pricing", "Out of office", "Pineapple samples", "Thanks, pineapple received", "Question", "Pineapple follow-up"]));
    const t1 = rows.find((r) => r.subject === "Re: Pineapple pricing")!;
    assert.equal(t1.from, `Pat Quinn <${PAT}>`);
    assert.equal(t1.to, MAILBOX);
    assert.equal(t1.label, "Interested");
    assert.equal(t1.campaign, "Spring outreach");
    assert.equal(t1.last_message, "Send me the numbers.");
    assert.equal(t1.lead, PAT);
    assert.equal(t1.messages, "2");
    assert.ok(!Number.isNaN(Date.parse(t1.date!)));
    assert.ok(!res.body.includes("Bob's pineapple secret"));
    assertClean(res.body, "csv");
  });

  it("CSV previews of tracked sends lose their tokens, and formula-like cells are defused", async () => {
    const sent = await alice.client.get("/api/app/unibox/export/csv?folder=sent");
    const t8 = csvRows(sent).find((r) => r.subject === "Price list");
    assert.ok(t8?.last_message.startsWith("Here it is: prices (https://example.com/pri"), t8?.last_message);
    assertClean(sent.body, "sent csv");
    const inbox = csvRows(await alice.client.get("/api/app/unibox/export/csv"));
    assert.ok(inbox.some((r) => r.subject === `'=HYPERLINK("http://evil.test","open")`), "a leading = is escaped");
    assert.ok(!inbox.some((r) => r.subject.startsWith("=")));
  });

  it("another workspace's CSV only has its own mail", async () => {
    const res = await bob.client.get("/api/app/unibox/export/csv?folder=all&search=pineapple");
    assert.deepEqual(csvRows(res).map((r) => r.subject), ["Bob's pineapple secret"]);
    assert.ok(!res.body.includes("Pineapple pricing"));
    assert.ok(!res.body.includes(PAT.replace("pat", "kim")));
  });

  async function mboxMessages(res: Res) {
    expectStatus(res, 200);
    assert.equal(res.headers["content-type"], "application/mbox");
    const parts = res.body.split(/^From \S+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\n/m);
    assert.equal(parts.shift(), "", "the file starts with a From line");
    return Promise.all(parts.map((p) => simpleParser(Buffer.from(p.replace(/^>(>*From )/gm, "$1"), "latin1"))));
  }

  it("conversations as .mbox: only the workspace's emails, oldest first, links untracked", async () => {
    const res = await alice.client.get(`/api/app/unibox/export/mbox?thread_ids=${T.t1},${T.b1},${T.t3}`);
    const messages = await mboxMessages(res);
    assert.deepEqual(
      messages.map((m) => m.subject),
      ["Pineapple pricing", "Re: Pineapple pricing", "Pineapple samples"],
    );
    assert.equal(messages[0]!.messageId, `<${ids.t1Send}@example.test>`);
    assert.equal(messages[1]!.from?.value[0]?.address, PAT);
    assert.ok(messages[0]!.text?.includes(PRICES), messages[0]!.text);
    assert.ok(!/<img/i.test(String(messages[0]!.html)), "no open pixel");
    for (const m of messages) assertClean(`${m.html || ""}\n${m.text ?? ""}\n${m.headerLines.map((h) => h.line).join("\n")}`, `mbox ${m.subject}`);
    assertClean(res.body, "mbox");
    assert.ok(!res.body.includes("Only for Bob"));
  });

  it("exports show in the audit log, with who, how many and the format", async () => {
    const logged = async () =>
      (await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.workspaceId, alice.workspaceId!), eq(schema.auditLogs.activityType, AuditActivity.UNIBOX_EXPORTED)))).map((l) => ({
        count: l.affectedCount,
        format: (l.metadata as { format?: string } | null)?.format,
        by: l.userId,
      }));
    const before = (await logged()).length;
    csvRows(await alice.client.get("/api/app/unibox/export/csv?folder=all&search=pineapple"));
    await mboxMessages(await alice.client.get(`/api/app/unibox/export/mbox?thread_ids=${T.t1},${T.t3}`));
    const after = (await logged()).slice(before);
    assert.deepEqual(after, [
      { count: 6, format: "csv", by: alice.id },
      { count: 2, format: "mbox", by: alice.id },
    ]);
  });

  it("refuses other workspaces' conversations, empty requests and unsent emails", async () => {
    expectStatus(await bob.client.get(`/api/app/unibox/export/mbox?thread_ids=${T.t1}`), 404);
    expectStatus(await alice.client.get("/api/app/unibox/export/mbox"), 400);
    expectStatus(await bob.client.get(`/api/app/unibox/emails/${ids.t1Send}/eml`), 404);
    const [scheduled] = await db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(and(eq(schema.emails.threadId, T.t5), eq(schema.emails.ueType, EmailType.SCHEDULED)));
    expectStatus(await alice.client.get(`/api/app/unibox/emails/${scheduled!.id}/eml`), 400);
  });

  it("one email as .eml", async () => {
    const res = await alice.client.get(`/api/app/unibox/emails/${ids.t1Send}/eml`);
    expectStatus(res, 200);
    assert.equal(res.headers["content-type"], "message/rfc822");
    assert.match(String(res.headers["content-disposition"]), /filename="Pineapple pricing\.eml"/);
    const m = await simpleParser(res.rawPayload);
    assert.equal(m.subject, "Pineapple pricing");
    assert.equal(m.from?.value[0]?.address, MAILBOX);
    assert.equal(m.to && !Array.isArray(m.to) ? m.to.value[0]?.address : null, PAT);
    assert.ok(m.text?.includes(PRICES));
    assertClean(res.body, "eml");
    assertClean(`${m.html || ""}${m.text}`, "eml (decoded)");
  });

  it("needs the Unibox permission, like reading mail", async () => {
    const member = await signUp(app, { email: uniqueEmail("no-unibox") });
    const invite = json(await alice.client.post("/api/v2/workspace-members", { email: member.email, role: "editor" }));
    const token = new URL(invite.invite_url).searchParams.get("token")!;
    json(await member.client.post(`/api/app/invitations/${encodeURIComponent(token)}/accept`));
    json(await alice.client.patch(`/api/v2/workspace-members/${invite.id}`, { permissions: ["dashboard", "leads"] }));
    for (const url of [
      "/api/app/unibox/threads?folder=all&search=pineapple",
      "/api/app/unibox/search-counts?search=pineapple",
      "/api/app/unibox/people?q=pat",
      "/api/app/unibox/export/csv",
      `/api/app/unibox/export/mbox?thread_ids=${T.t1}`,
      `/api/app/unibox/emails/${ids.t1Send}/eml`,
    ]) {
      expectStatus(await member.client.get(url), 403, url);
    }
  });
});

describe("scheduled emails", () => {
  let box = "";
  before(async () => {
    box = json(await alice.client.post("/api/app/accounts/sandbox", { count: 1, domain: "later-co.test", enable_warmup: false })).items[0].email;
  });

  const later = () => new Date(Date.now() + 3_600_000).toISOString();
  const schedule = async (to: string) => json(await alice.client.post("/api/v2/emails/send", { eaccount: box, to: [to], subject: "Later", body: { html: "<p>Talk soon</p>" }, scheduled_at: later() }));
  const makeDue = (id: string) => db.update(schema.emails).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.emails.id, id));
  const stored = async (id: string) => (await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]!;
  const delivered = async (to: string) => (await db.select().from(schema.sandboxMessages).where(eq(schema.sandboxMessages.mailbox, to))).length;

  it("goes out when it's due", async () => {
    const e = await schedule("kim@later-one.test");
    assert.equal(e.ue_type, EmailType.SCHEDULED);
    await makeDue(e.id);
    await runScheduledEmails();
    const s = await stored(e.id);
    assert.equal(s.ueType, EmailType.SENT);
    assert.equal(s.sendError, null);
    assert.equal(await delivered("kim@later-one.test"), 1);
  });

  it("isn't sent to someone who unsubscribed after it was written", async () => {
    const e = await schedule("lee@later-two.test");
    await db.insert(schema.unsubscribes).values({ workspaceId: alice.workspaceId!, email: "lee@later-two.test", source: "link" });
    await makeDue(e.id);
    await runScheduledEmails();
    const s = await stored(e.id);
    assert.equal(s.ueType, EmailType.SCHEDULED, "still there to reschedule or cancel");
    assert.equal(s.scheduledAt, null);
    assert.match(s.sendError ?? "", /lee@later-two\.test was unsubscribed after this email was scheduled/);
    assert.equal(await delivered("lee@later-two.test"), 0);
  });

  it("isn't sent to a domain blocklisted after it was written", async () => {
    const e = await schedule("max@later-blocked.test");
    json(await alice.client.post("/api/v2/block-lists-entries", { bl_value: "later-blocked.test" }));
    await makeDue(e.id);
    await runScheduledEmails();
    assert.match((await stored(e.id)).sendError ?? "", /added to your blocklist after this email was scheduled/);
    assert.equal(await delivered("max@later-blocked.test"), 0);
  });

  it("waits with a note while its mailbox is paused, and goes once rescheduled after a resume", async () => {
    const e = await schedule("ola@later-three.test");
    await db.update(schema.emailAccounts).set({ status: AccountStatus.PAUSED }).where(eq(schema.emailAccounts.email, box));
    await makeDue(e.id);
    await runScheduledEmails();
    assert.match((await stored(e.id)).sendError ?? "", /is paused\. Resume it in Email accounts, then reschedule this email\./);
    assert.equal(await delivered("ola@later-three.test"), 0);

    await db.update(schema.emailAccounts).set({ status: AccountStatus.ACTIVE }).where(eq(schema.emailAccounts.email, box));
    json(await alice.client.post(`/api/app/emails/${e.id}/reschedule`, { scheduled_at: later() }));
    assert.equal((await stored(e.id)).sendError, null);
    await makeDue(e.id);
    await runScheduledEmails();
    assert.equal((await stored(e.id)).ueType, EmailType.SENT);
    assert.equal(await delivered("ola@later-three.test"), 1);
  });

  it("keeps a reminder after the send: set earlier, moved with a new time, or after a late send", async () => {
    const hour = 3_600_000;
    const at = Date.now() + 72 * hour;
    const e = json(
      await alice.client.post("/api/v2/emails/send", { eaccount: box, to: ["ivy@later-seven.test"], subject: "Monday", body: { html: "<p>Talk Monday</p>" }, scheduled_at: new Date(at).toISOString(), reminder_ts: new Date(Date.now() + 24 * hour).toISOString() }),
    );
    // "Remind me in a day" on an email that goes out in three days: a day after it goes out.
    const due = (await stored(e.id)).reminderAt!.getTime();
    assert.ok(Math.abs(due - (at + 24 * hour)) < 5_000, `reminder at ${new Date(due).toISOString()}`);
    // Moved two days later, the reminder follows.
    json(await alice.client.post(`/api/app/emails/${e.id}/reschedule`, { scheduled_at: new Date(at + 48 * hour).toISOString() }));
    assert.ok(Math.abs((await stored(e.id)).reminderAt!.getTime() - (at + 72 * hour)) < 5_000);
    // Sent late (as after a long stop): still a day after it actually went out.
    await db.update(schema.emails).set({ scheduledAt: new Date(Date.now() - 48 * hour), reminderAt: new Date(Date.now() - 24 * hour) }).where(eq(schema.emails.id, e.id));
    await runScheduledEmails();
    const sent = await stored(e.id);
    assert.equal(sent.ueType, EmailType.SENT);
    assert.ok(Math.abs(sent.reminderAt!.getTime() - (Date.now() + 24 * hour)) < 60_000, `reminder at ${sent.reminderAt!.toISOString()}`);
  });

  it("one that wasn't sent can be sent now; a sent one can't be rescheduled", async () => {
    const e = await schedule("una@later-six.test");
    await db.update(schema.emailAccounts).set({ status: AccountStatus.PAUSED }).where(eq(schema.emailAccounts.email, box));
    await makeDue(e.id);
    await runScheduledEmails();
    assert.equal((await stored(e.id)).scheduledAt, null, "not sent, so not waiting either");
    await db.update(schema.emailAccounts).set({ status: AccountStatus.ACTIVE }).where(eq(schema.emailAccounts.email, box));

    expectStatus(await alice.client.post(`/api/app/emails/${e.id}/reschedule`, { scheduled_at: new Date(Date.now() - 60_000).toISOString() }), 400);
    const now = json(await alice.client.post(`/api/app/emails/${e.id}/reschedule`, { now: true }));
    assert.ok(Date.parse(now.scheduled_at) <= Date.now());
    assert.equal((await stored(e.id)).sendError, null);
    await runScheduledEmails();
    assert.equal((await stored(e.id)).ueType, EmailType.SENT);
    assert.equal(await delivered("una@later-six.test"), 1);

    const again = await alice.client.post(`/api/app/emails/${e.id}/reschedule`, { now: true });
    expectStatus(again, 400);
    assert.match(again.json().message, /not scheduled/);
  });

  it("a reply to someone who had already unsubscribed goes, since the writer knew", async () => {
    const thread = uuidv7();
    await db.insert(schema.unsubscribes).values({ workspaceId: alice.workspaceId!, email: "rae@later-four.test", source: "reply", createdAt: new Date(Date.now() - 60_000) });
    const original = await addEmail(alice, { threadId: thread, subject: "Please take me off", ...received("rae@later-four.test", "Rae"), eaccount: box, toList: box, bodyText: "Please take me off your list." });
    const reply = json(
      await alice.client.post("/api/v2/emails/reply", { eaccount: box, reply_to_uuid: original, subject: "Re: Please take me off", body: { html: "<p>Done, you won't hear from us again.</p>" }, scheduled_at: later() }),
    );
    await makeDue(reply.id);
    await runScheduledEmails();
    assert.equal((await stored(reply.id)).ueType, EmailType.SENT);
    assert.equal(await delivered("rae@later-four.test"), 1);
  });

  it("a paused mailbox doesn't send now either; one with a connection problem is tried", async () => {
    await db.update(schema.emailAccounts).set({ status: AccountStatus.PAUSED }).where(eq(schema.emailAccounts.email, box));
    const paused = await alice.client.post("/api/v2/emails/send", { eaccount: box, to: ["sky@later-five.test"], subject: "Now", body: { html: "<p>Hi</p>" } });
    expectStatus(paused, 400);
    assert.match(paused.json().message, /is paused\. Resume it in Email accounts to send from it\./);
    await db.update(schema.emailAccounts).set({ status: AccountStatus.CONNECTION_ERROR }).where(eq(schema.emailAccounts.email, box));
    json(await alice.client.post("/api/v2/emails/send", { eaccount: box, to: ["sky@later-five.test"], subject: "Now", body: { html: "<p>Hi</p>" } }));
    assert.equal(await delivered("sky@later-five.test"), 1);
    await db.update(schema.emailAccounts).set({ status: AccountStatus.ACTIVE }).where(eq(schema.emailAccounts.email, box));
  });
});
