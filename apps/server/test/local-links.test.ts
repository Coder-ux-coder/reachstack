// Emails sent from a server nobody outside can reach (npm run local on a laptop: tests run at http://localhost:4000):
// tracking links would be broken for the people who get them, so links stay as written, there's no open pixel, and
// unsubscribing works by email. Sandbox mailboxes, which never leave this server, keep tracking. The launch check
// says so. All addresses are made up; nothing is sent (the SMTP driver is replaced).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderCode } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { SmtpImapDriver } from "../src/mail/smtp-imap";
import { SandboxDriver } from "../src/mail/sandbox";
import type { OutgoingMessage } from "../src/mail/types";
import { reachableFromInternet } from "../src/services/tracking";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const BODY = '<p>Hi {{firstName}}, here is <a href="https://www.acme-demo.example.com/book">a time to talk</a>.</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>';

let user: TestUser;

before(async () => {
  const app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Lee", workspaceName: "Laptop Co" });
});
after(stopServer);

/** A campaign with tracking and the unsubscribe header on, one lead, launched from the given mailbox. */
async function launch(name: string, mailbox: string, lead: string) {
  const c = json(await user.client.post("/api/app/campaigns", { name }));
  json(
    await user.client.patch(`/api/v2/campaigns/${c.id}`, {
      email_list: [mailbox],
      campaign_schedule: ALWAYS_OPEN,
      open_tracking: true,
      link_tracking: true,
      insert_unsubscribe_header: true,
      sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Quick question", body: BODY }] }] }],
    }),
  );
  json(await user.client.post("/api/v2/leads", { email: lead, first_name: "Pat", campaign: c.id }));
  return c.id as string;
}

/** Runs the sender, catching what the given driver would have sent. */
async function sentThrough(driver: typeof SmtpImapDriver | typeof SandboxDriver): Promise<OutgoingMessage[]> {
  const caught: OutgoingMessage[] = [];
  const send = driver.prototype.send;
  driver.prototype.send = async function (this: InstanceType<typeof driver>, msg: OutgoingMessage) {
    caught.push(msg);
    return driver === SandboxDriver ? send.call(this, msg) : { messageId: msg.messageId, response: "250 OK (stub)", accepted: msg.to.map((t) => t.address), rejected: [] };
  } as typeof send;
  try {
    await runSender();
  } finally {
    driver.prototype.send = send;
  }
  return caught;
}

describe("a server nobody outside can reach", () => {
  it("is told apart from one people can reach", () => {
    for (const base of ["http://localhost:4000", "http://127.0.0.1:4100", "http://192.168.1.20:4000", "http://10.0.0.7", "http://[::1]:4000", "http://my-laptop:4000", "http://reachstack.local", "https://crm.test", "not a url"]) {
      assert.equal(reachableFromInternet(base), false, base);
    }
    for (const base of ["https://track.acme-mail.com", "https://reachstack.example.org", "http://8.8.8.8"]) {
      assert.equal(reachableFromInternet(base), true, base);
    }
  });

  it("sends links as written, no open pixel, and an unsubscribe link that works by email", async () => {
    const [mailbox] = await db
      .insert(schema.emailAccounts)
      .values({
        workspaceId: user.workspaceId!,
        email: "lee@laptop-co.example.com",
        firstName: "Lee",
        providerCode: ProviderCode.CUSTOM,
        smtp: { host: "smtp.laptop-co.example.com", port: 587, secure: false, user: "lee@laptop-co.example.com" },
        imap: { host: "imap.laptop-co.example.com", port: 993, secure: true, user: "lee@laptop-co.example.com" },
      })
      .returning();
    const id = await launch("From the laptop", mailbox!.email, "pat@prospect-one.example.com");

    const warnings: string[] = json(await user.client.get(`/api/app/campaigns/${id}/launch-check`)).warnings;
    const text = warnings.join("\n");
    assert.match(text, /This server's address \(localhost:4000\) can't be reached from the internet/);
    assert.match(text, /links stay as written and opens and clicks aren't counted/);
    assert.match(text, /The unsubscribe link asks to unsubscribe by email instead/);
    assert.doesNotMatch(text, /no custom tracking domain/, "a tracking domain can't help without a public server");

    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    const [email] = await sentThrough(SmtpImapDriver);
    assert.ok(email, "the email went out");
    const html = email.html ?? "";
    assert.match(html, /href="https:\/\/www\.acme-demo\.example\.com\/book"/, "the link is the one written");
    assert.doesNotMatch(html, /\/t\/c\/|\/t\/o\//, "no tracking link or pixel");
    assert.match(html, /href="mailto:lee@laptop-co\.example\.com\?subject=unsubscribe"/);
    assert.equal(email.headers?.["List-Unsubscribe"], "<mailto:lee@laptop-co.example.com?subject=unsubscribe>");
    assert.equal(email.headers?.["List-Unsubscribe-Post"], undefined, "one click needs a reachable web address");
  });

  it("keeps tracking for sandbox mailboxes, which never leave this server", async () => {
    const sandbox = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, domain: "laptop-sandbox.test", enable_warmup: false })).items[0].email as string;
    const id = await launch("From the sandbox", sandbox, "pat@prospect-two.test");
    assert.doesNotMatch(json(await user.client.get(`/api/app/campaigns/${id}/launch-check`)).warnings.join("\n"), /can't be reached from the internet/);

    expectStatus(await user.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    const [email] = await sentThrough(SandboxDriver);
    assert.ok(email, "the email went out");
    assert.match(email.html ?? "", /href="http:\/\/localhost:4000\/t\/c\//);
    assert.match(email.html ?? "", /\/t\/o\//);
    assert.match(email.headers?.["List-Unsubscribe"] ?? "", /^<http:\/\/localhost:4000\/u\//);
  });
});
