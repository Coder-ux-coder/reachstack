// What to do about a failed connection check, in plain words, from the server's answer and the provider. Shown
// under the error when a mailbox is connected or reconnected.
import type { ConnectionCheck } from "./types";

export function connectionHint(side: "imap" | "smtp", server: { host: string; port: number }, check: ConnectionCheck, signedIn: boolean): string | undefined {
  if (check.ok) return undefined;
  const message = (check.error ?? "").toLowerCase();
  const host = server.host.toLowerCase();
  const google = /(^|\.)(gmail|googlemail|google)\.com$/.test(host);
  const microsoft = /(^|\.)(office365|outlook|hotmail|live)\.com$/.test(host);
  const yahoo = /(^|\.)yahoo\.com$/.test(host);

  if (check.code === "auth") {
    if (signedIn) return "The sign-in was refused, perhaps revoked or expired. Connect the mailbox again with its sign-in button.";
    // Asked to log in, the server said it doesn't do that here: a server for receiving mail, not for sending it.
    if (side === "smtp" && /\b50[0-4]\b|not (enabled|implemented|recogni[sz]ed|supported|available)|unrecogni[sz]ed command/.test(message)) {
      return `${server.host} doesn't take logins on port ${server.port}. Use your provider's server for sending mail (SMTP submission), usually on port 587 (STARTTLS) or 465 (SSL/TLS).`;
    }
    if (google) return "Gmail needs an app password, not your usual password: turn on 2-Step Verification for the account, create one at myaccount.google.com/apppasswords, and check that IMAP is on in Gmail's settings.";
    if (microsoft) {
      if (side === "smtp" && /smtpclientauthentication is disabled|5\.7\.139/.test(message)) {
        return "SMTP AUTH is off for this mailbox. Turn it on in the Microsoft 365 admin center (the user → Mail → Manage email apps → Authenticated SMTP), or connect with Sign in with Microsoft.";
      }
      return "Microsoft no longer accepts passwords for Outlook.com and Microsoft 365 mailboxes. Connect it with Sign in with Microsoft instead.";
    }
    if (yahoo) return "Yahoo needs an app password: create one in your Yahoo account's security settings and use it here.";
    return "The username or password was refused. Many providers want an app password instead of your usual one: look for \"app password\" or \"IMAP access\" in your provider's help.";
  }

  if (check.code === "connection") {
    if (/enotfound|getaddrinfo|eai_again/.test(message)) return `There's no server called ${server.host}. Check the spelling.`;
    if (/wrong version number|ssl routines|unknown protocol|tls/.test(message)) {
      if (side === "imap") return "The security setting didn't match: IMAP over SSL/TLS uses port 993.";
      return server.port === 465 ? "Port 465 expects a secure connection from the start. If your provider says STARTTLS, use port 587." : "The security setting didn't match: try port 465 (SSL/TLS) or 587 (STARTTLS).";
    }
    return `Couldn't reach ${server.host} on port ${server.port}. Check the port (IMAP is usually 993, SMTP 587 or 465) and that nothing on this network blocks it.`;
  }
  return undefined;
}
