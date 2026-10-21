// What a refusal means (src/mail/refusals.ts, classifyError in src/mail/smtp-imap.ts, bounce notices in
// src/mail/parse.ts): only an address that doesn't work is a hard bounce; full mailboxes, blocks and unclear answers
// never write a good lead off, and a refusal of the sender is the mailbox's problem.
import "./helpers/setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { refusalKind } from "../src/mail/refusals";
import { SmtpImapDriver, classifyError } from "../src/mail/smtp-imap";
import { parseInbound } from "../src/mail/parse";
import type { MailError } from "../src/mail/types";

describe("refusal kinds", () => {
  it("reads the status code first, then the server's words", () => {
    assert.equal(refusalKind("5.1.1", "550 5.1.1 The email account that you tried to reach does not exist."), "hard");
    assert.equal(refusalKind("5.2.1", "550 5.2.1 The email account that you tried to reach is disabled."), "hard");
    assert.equal(refusalKind("5.2.2", "552 5.2.2 Mailbox full"), "soft");
    assert.equal(refusalKind("4.2.2", "452 4.2.2 The email account that you tried to reach is over quota."), "soft");
    assert.equal(refusalKind("5.7.26", "550 5.7.26 This mail has been blocked because the sender is unauthenticated."), "block");
    assert.equal(refusalKind("5.7.1", "554 5.7.1 Service unavailable; Client host blocked using zen.spamhaus.org"), "block");
    assert.equal(refusalKind("5.7.1", "554 5.7.1 <pat@example.test>: Recipient address rejected: Access denied"), "block");
    assert.equal(refusalKind("5.1.8", "553 5.1.8 <sam@example.test>: Sender address rejected: Domain not found"), "block");
    // Microsoft's directory check: the address doesn't exist there.
    assert.equal(refusalKind("5.4.1", "550 5.4.1 Recipient address rejected: Access denied. AS(201806281)"), "hard");
    assert.equal(refusalKind("5.4.1", "554 5.4.1 Relay access denied"), "block");
    assert.equal(refusalKind("5.4.7", "Message expired"), "soft");
    assert.equal(refusalKind(null, "550 Requested action not taken: mailbox unavailable"), "hard");
    assert.equal(refusalKind(null, "554 delivery error: dd This mailbox is disabled (554.30)"), "hard");
    assert.equal(refusalKind(null, "550 Rejected by header based Anti-Spoofing policy"), "block");
    assert.equal(refusalKind("5.0.0", "554 5.0.0 Service unavailable"), "soft", "an unclear answer never writes the lead off");
  });
});

/** A nodemailer error as it comes out of a refused SMTP command. */
const smtp = (command: string, response: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Message failed: ${response}`), { code: command === "DATA" ? "EMESSAGE" : "EENVELOPE", command, response, responseCode: Number(response.slice(0, 3)), ...extra });

describe("send failures", () => {
  it("tell a recipient's address from the sender's problem", () => {
    const sort = (e: Error) => {
      const m = classifyError(e);
      return m.soft ? `${m.kind} (soft)` : m.kind;
    };
    assert.equal(sort(smtp("RCPT TO", "550 5.1.1 <pat@example.test>: Recipient address rejected: User unknown")), "recipient");
    assert.equal(sort(smtp("RCPT TO", "452 4.2.2 The email account that you tried to reach is over quota")), "recipient (soft)");
    assert.equal(sort(smtp("RCPT TO", "450 4.2.0 <pat@example.test>: Recipient address rejected: Greylisted")), "temporary");
    assert.equal(sort(smtp("RCPT TO", "553 5.7.1 <sam@example.test>: Sender address rejected: not owned by user sam")), "rejected");
    assert.equal(sort(smtp("RCPT TO", "554 5.7.1 <pat@example.test>: Relay access denied")), "rejected");
    assert.equal(sort(smtp("RCPT TO", "550 Rejected")), "recipient (soft)", "a refusal without a reason gets more tries");
    assert.equal(sort(smtp("DATA", "550 5.7.26 Unauthenticated email from example.test is not accepted due to its DMARC policy")), "rejected");
    assert.equal(sort(smtp("DATA", "552 5.3.4 Message size exceeds fixed limit")), "unknown");
    assert.equal(sort(smtp("RCPT TO", "550 5.4.5 Daily user sending limit exceeded")), "quota");
    assert.equal(sort(smtp("MAIL FROM", "530 5.7.0 Authentication Required")), "auth");
  });

  it("judge by the email's own recipient, and notice it was refused when only a copy went out", async () => {
    const own = smtp("RCPT TO", "452 4.2.2 Mailbox full", { recipient: "pat@example.test" });
    const copy = smtp("RCPT TO", "550 5.1.1 User unknown", { recipient: "crm@example.test" });
    let outcome: () => Promise<unknown> = async () => ({});
    const real = nodemailer.createTransport;
    nodemailer.createTransport = (() => ({ sendMail: () => outcome(), close() {} })) as unknown as typeof nodemailer.createTransport;
    try {
      const driver = new SmtpImapDriver({
        id: "refusals-driver",
        email: "sam@example.test",
        imap: null,
        imapPassword: null,
        smtp: { host: "smtp.example.test", port: 587, secure: false, user: "sam@example.test" },
        smtpPassword: "not-a-real-password",
        oauth: null,
      });
      const msg = { from: { address: "sam@example.test" }, to: [{ address: "pat@example.test" }], bcc: [{ address: "crm@example.test" }], subject: "Hi", text: "Hello", messageId: "<m1@example.test>" };
      // Every recipient refused, the copy last: the addressee's full mailbox decides, not the copy's unknown user.
      outcome = () => Promise.reject(Object.assign(smtp("RCPT TO", "550 5.1.1 User unknown"), { rejectedErrors: [own, copy] }));
      await assert.rejects(driver.send(msg), (e: MailError) => e.kind === "recipient" && e.soft === true);
      // The copy went out but the addressee was refused: not a sent email.
      outcome = async () => ({ messageId: "<m1@example.test>", accepted: ["crm@example.test"], rejected: ["pat@example.test"], rejectedErrors: [own], response: "250 OK" });
      await assert.rejects(driver.send(msg), (e: MailError) => e.kind === "recipient" && e.soft === true);
      outcome = async () => ({ messageId: "<m1@example.test>", accepted: ["pat@example.test"], rejected: ["crm@example.test"], rejectedErrors: [copy], response: "250 OK" });
      assert.deepEqual((await driver.send(msg)).rejected, ["crm@example.test"]);
    } finally {
      nodemailer.createTransport = real;
    }
  });

  it("never throw on an inbox server's answer that isn't text", () => {
    const imap = Object.assign(new Error("Command failed"), { response: { tag: "5", command: "NO", attributes: [] }, responseText: "Server unavailable. Try again later", responseStatus: "NO" });
    const e = classifyError(imap);
    assert.equal(e.kind, "unknown");
    assert.equal(e.message, "Server unavailable. Try again later");
    assert.equal(classifyError(Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })).kind, "connection");
  });
});

/** A bounce notice about `recipient`, for the email with Message-ID `original`. */
function notice(opts: { status?: string; diagnostic?: string; recipient: string; original?: string; text?: string; from?: string; subject?: string }) {
  return Buffer.from(
    [
      `From: ${opts.from ?? "Mail Delivery System <mailer-daemon@mx.example.test>"}`,
      "To: sam@example.test",
      `Subject: ${opts.subject ?? "Undelivered Mail Returned to Sender"}`,
      "Message-ID: <notice-1@mx.example.test>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      "MIME-Version: 1.0",
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      opts.text ?? "This is the mail system. Your message could not be delivered to one or more recipients.",
      "--b1",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.example.test",
      "",
      `Final-Recipient: rfc822; ${opts.recipient}`,
      "Action: failed",
      ...(opts.status ? [`Status: ${opts.status}`] : []),
      ...(opts.diagnostic ? [`Diagnostic-Code: smtp; ${opts.diagnostic}`] : []),
      "--b1",
      "Content-Type: text/rfc822-headers",
      "",
      `Message-ID: ${opts.original ?? "<sent-1@example.test>"}`,
      "Subject: Version 5.1.2 is out",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

describe("bounce notices", () => {
  it("only call an address that doesn't work a hard bounce", async () => {
    const block = await parseInbound(notice({ status: "5.7.1", diagnostic: "550 5.7.1 Service unavailable, client host blocked using a block list", recipient: "pat@example.test" }));
    assert.equal(block.bounce?.kind, "block");
    assert.equal(block.bounce?.hard, false);
    const gone = await parseInbound(notice({ status: "5.1.1", diagnostic: "550 5.1.1 User unknown", recipient: "gone@example.test" }));
    assert.equal(gone.bounce?.kind, "hard");
    assert.deepEqual(gone.bounce?.recipients, ["gone@example.test"]);
    assert.equal(gone.bounce?.originalMessageId, "<sent-1@example.test>");
    // No code: the words decide, and the original's subject ("Version 5.1.2") isn't read as one.
    const vague = await parseInbound(notice({ recipient: "pat@example.test", text: "Delivery to the following recipient failed permanently: the server didn't say why." }));
    assert.equal(vague.bounce?.kind, "soft");
    assert.equal(vague.bounce?.status, null);
  });

  it("know a delivery report by its type, whatever language its subject is in", async () => {
    for (const subject of ["Unzustellbar: Angebot für Sie", "Non remis : Votre devis", "No se puede entregar: Presupuesto"]) {
      const report = await parseInbound(notice({ from: "postmaster@contoso.example.test", subject, status: "5.1.1", diagnostic: "550 5.1.1 RESOLVER.ADR.RecipientNotFound", recipient: "gone@example.test" }));
      assert.equal(report.bounce?.kind, "hard", subject);
      assert.equal(report.isAutoReply, false, subject);
    }
  });

  it("don't take a person's reply for one, even when it talks about failed deliveries and quotes a price", async () => {
    const reply = await parseInbound(
      Buffer.from(
        [
          "From: Pat Quinn <pat@example.test>",
          "To: sam@example.test",
          "Subject: Re: Undelivered parcels this week",
          "Message-ID: <reply-1@example.test>",
          "In-Reply-To: <sent-1@example.test>",
          "Content-Type: text/plain",
          "",
          "Interested, send me the details.",
          "",
          "On Mon, Oct 12, 2026 at 9:00 AM Sam <sam@example.test> wrote:",
          "> Our courier plan is $550 a month and covers every undelivered parcel.",
          "",
        ].join("\r\n"),
      ),
    );
    assert.equal(reply.bounce, null);
    // A notice from a server that isn't a mailer-daemon still counts when its own words carry the refusal.
    const plain = await parseInbound(
      Buffer.from(["From: mail@relay.example.test", "To: sam@example.test", "Subject: Delivery failed", "Message-ID: <n-2@relay.example.test>", "Content-Type: text/plain", "", "550 5.1.1 <gone@example.test>: Recipient address rejected", ""].join("\r\n")),
    );
    assert.equal(plain.bounce?.kind, "hard");
  });
});
