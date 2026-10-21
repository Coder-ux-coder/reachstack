// What a failed mailbox connection test tells the user to do (src/mail/connection-hints.ts): app passwords for Gmail
// and Yahoo, Microsoft's sign-in instead of passwords, SMTP AUTH, misspelled servers and mismatched ports.
import "./helpers/setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectionHint } from "../src/mail/connection-hints";

const refused = { ok: false, code: "auth", error: "Invalid credentials (Failure)" };

describe("connection hints", () => {
  it("names the fix for refused passwords by provider", () => {
    assert.match(connectionHint("imap", { host: "imap.gmail.com", port: 993 }, refused, false)!, /app password.*myaccount\.google\.com\/apppasswords/);
    assert.match(connectionHint("imap", { host: "outlook.office365.com", port: 993 }, refused, false)!, /Sign in with Microsoft/);
    assert.match(
      connectionHint("smtp", { host: "smtp.office365.com", port: 587 }, { ok: false, code: "auth", error: "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant." }, false)!,
      /SMTP AUTH is off for this mailbox/,
    );
    assert.match(connectionHint("smtp", { host: "smtp.mail.yahoo.com", port: 465 }, refused, false)!, /Yahoo needs an app password/);
    assert.match(connectionHint("imap", { host: "mail.acme-mail.example.com", port: 993 }, refused, false)!, /app password/);
    assert.match(connectionHint("imap", { host: "imap.gmail.com", port: 993 }, refused, true)!, /sign-in was refused/, "a signed-in mailbox isn't told about passwords");
  });

  it("explains servers that can't be reached", () => {
    assert.match(connectionHint("imap", { host: "imap.gmial.com", port: 993 }, { ok: false, code: "connection", error: "getaddrinfo ENOTFOUND imap.gmial.com" }, false)!, /no server called imap\.gmial\.com/);
    assert.match(connectionHint("smtp", { host: "smtp.example.org", port: 465 }, { ok: false, code: "connection", error: "ssl3_get_record:wrong version number" }, false)!, /use port 587/);
    assert.match(connectionHint("smtp", { host: "smtp.example.org", port: 2525 }, { ok: false, code: "connection", error: "Connection timeout" }, false)!, /Couldn't reach smtp\.example\.org on port 2525/);
  });

  it("says nothing when it worked or there's nothing useful to add", () => {
    assert.equal(connectionHint("imap", { host: "imap.gmail.com", port: 993 }, { ok: true }, false), undefined);
    assert.equal(connectionHint("smtp", { host: "smtp.example.org", port: 587 }, { ok: false, code: "unknown", error: "Something odd" }, false), undefined);
  });
});
