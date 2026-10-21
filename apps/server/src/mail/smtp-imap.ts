// Real mailbox driver: SMTP (nodemailer) for sending, IMAP (imapflow) for reading. Password or XOAUTH2 auth.
import { ImapFlow, type MailboxObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";
import { ProviderCode } from "@reachstack/shared";
import type { ServerConfig } from "../db/schema";
import { sha256 } from "../lib/ids";
import { toMailOptions } from "./compose";
import type { OAuthTokens } from "./oauth";
import { freshAccessToken } from "./oauth";
import { connectionHint } from "./connection-hints";
import { providerForHosts } from "./providers";
import { MAILBOX_FULL, enhancedCode, refusalKind } from "./refusals";
import { MailError, type ConnectionCheck, type FetchBatch, type FetchedMessage, type FolderInfo, type MailDriver, type MailSession, type OutgoingMessage, type SendResult } from "./types";

export interface DriverAccount {
  id: string;
  email: string;
  imap: ServerConfig | null;
  imapPassword: string | null;
  smtp: ServerConfig | null;
  smtpPassword: string | null;
  oauth: OAuthTokens | null;
  /** Persist refreshed OAuth tokens. */
  saveTokens?: (tokens: OAuthTokens) => Promise<void>;
}

const transports = new Map<string, { key: string; transport: Transporter }>();

/** Network, nodemailer and imapflow error codes for a server that couldn't be reached or dropped the connection. */
const CONNECTION_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  // The server closed the connection before its greeting (imapflow), or its certificate can't be trusted (expired,
  // self-signed, for another name): either way the mailbox can't be reached safely until that's fixed.
  "ClosedAfterConnectTLS",
  "ClosedAfterConnectText",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);
/** The provider's own sending limit for this mailbox. */
const SENDING_QUOTA = /daily (user )?sending (quota|limit)|5\.4\.5|sending (quota|limit) exceeded|submissionquotaexceeded|message rate limit|too many messages/i;

/**
 * Sorts a failure from a mail server: the mailbox's login (auth), reaching the server (connection), the provider's
 * sending limit (quota), the provider refusing this mailbox's mail (rejected), one recipient's address (recipient,
 * `soft` when its mailbox is full), or something to try again later (temporary, unknown).
 */
export function classifyError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; command?: unknown; response?: unknown; responseText?: unknown; message?: unknown; authenticationFailed?: unknown };
  // Only text is shown or matched: imapflow leaves the parsed server answer (an object) in `response`.
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const msg = str(e.response) ?? str(e.responseText) ?? str(e.message) ?? String(err);
  const rc = typeof e.responseCode === "number" ? e.responseCode : 0;
  const code = str(e.code) ?? "";
  const stage = (str(e.command) ?? "").toUpperCase();
  const extra = { responseCode: rc || undefined, command: str(e.command), response: str(e.response) };
  const fail = (kind: MailError["kind"], soft?: boolean) => new MailError(kind, msg, soft ? { ...extra, soft } : extra);
  if (code === "EAUTH" || e.authenticationFailed === true) return fail("auth");

  // Refused while naming the sender (MAIL FROM) or a recipient (RCPT TO), or after the message (DATA).
  if (stage === "MAIL FROM" || stage === "RCPT TO" || stage === "DATA" || code === "EENVELOPE" || code === "EMESSAGE") {
    if (rc === 530 || rc === 534 || rc === 535) return fail("auth");
    if (SENDING_QUOTA.test(msg)) return fail("quota");
    if (rc >= 400 && rc < 500) return MAILBOX_FULL.test(msg) ? fail("recipient", true) : fail("temporary");
    if (rc < 500) return fail("unknown");
    // The provider won't take mail from this mailbox: the sender refused, or a block (policy, reputation, a relay or
    // sender check). That's the mailbox's problem, not the recipient's.
    if (stage === "MAIL FROM") return fail("rejected");
    const kind = refusalKind(null, msg);
    if (kind === "block") return fail("rejected");
    if (kind === "hard") return fail("recipient");
    if (MAILBOX_FULL.test(msg) || enhancedCode(msg) === "5.2.2") return fail("recipient", true);
    // The message refused with no reason given (554 after DATA): the provider refusing this mailbox's mail.
    if (stage === "DATA") return rc === 554 ? fail("rejected") : fail("unknown");
    // A recipient refused with no reason given: a soft bounce, so the address gets a few more tries before it's
    // written off.
    return fail("recipient", true);
  }

  if (rc === 535 || rc === 534 || rc === 530 || /invalid credentials|authenticat|login failed|\[auth/i.test(msg)) return fail("auth");
  if (SENDING_QUOTA.test(msg)) return fail("quota");
  if (CONNECTION_CODES.has(code)) return fail("connection");
  if (code === "ETHROTTLE" || (rc >= 400 && rc < 500)) return fail("temporary");
  return fail("unknown");
}

/** The refusal of the email's own recipient, from nodemailer's per-recipient errors (a copy may have been refused instead). */
function ownRefusal(err: unknown, msg: OutgoingMessage): unknown {
  const to = new Set(msg.to.map((a) => a.address.toLowerCase()));
  const each = (err as { rejectedErrors?: Array<{ recipient?: string }> } | null)?.rejectedErrors ?? [];
  return each.find((r) => to.has(String(r.recipient ?? "").toLowerCase())) ?? null;
}

/**
 * The mailbox's Google or Microsoft sign-in token, for one of that provider's own servers only. The token opens the
 * whole mailbox: a side moved onto other servers (a relay for sending, say) signs in there with its own password.
 */
export function tokenFor(acc: Pick<DriverAccount, "oauth">, server: Pick<ServerConfig, "host">): OAuthTokens | null {
  if (!acc.oauth) return null;
  const provider = acc.oauth.provider === "microsoft" ? ProviderCode.MICROSOFT : ProviderCode.GOOGLE;
  return providerForHosts(server.host) === provider ? acc.oauth : null;
}

async function smtpAuth(acc: DriverAccount): Promise<{ user: string; pass?: string; type?: "OAuth2"; accessToken?: string }> {
  if (acc.oauth && acc.smtp && tokenFor(acc, acc.smtp)) {
    const { tokens, refreshed } = await freshAccessToken(acc.oauth);
    if (refreshed) {
      acc.oauth = tokens;
      await acc.saveTokens?.(tokens);
    }
    return { type: "OAuth2", user: acc.email, accessToken: tokens.access_token };
  }
  return { user: acc.smtp?.user || acc.email, pass: acc.smtpPassword ?? "" };
}

async function getTransport(acc: DriverAccount): Promise<Transporter> {
  if (!acc.smtp) throw new MailError("connection", "SMTP server is not configured for this account");
  const auth = await smtpAuth(acc);
  const key = sha256(JSON.stringify([acc.smtp, auth]));
  const cached = transports.get(acc.id);
  if (cached?.key === key) return cached.transport;
  cached?.transport.close();
  const options: SMTPPool.Options & { forceAuth?: boolean } = {
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: acc.smtp.secure,
    requireTLS: !acc.smtp.secure && acc.smtp.port === 587,
    auth: auth.type === "OAuth2" ? { type: "OAuth2", user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass },
    // Log in even when the server doesn't offer it: a server that takes mail without checking the password (the wrong
    // server or port) fails the connection test instead of refusing every recipient later.
    forceAuth: auth.type === "OAuth2" || !!auth.pass,
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  };
  const transport = nodemailer.createTransport(options);
  transports.set(acc.id, { key, transport });
  return transport;
}

export function dropTransport(accountId: string) {
  transports.get(accountId)?.transport.close();
  transports.delete(accountId);
}

async function imapClient(acc: DriverAccount): Promise<ImapFlow> {
  if (!acc.imap) throw new MailError("connection", "IMAP server is not configured for this account");
  let auth: { user: string; pass?: string; accessToken?: string };
  if (acc.oauth && tokenFor(acc, acc.imap)) {
    const { tokens, refreshed } = await freshAccessToken(acc.oauth);
    if (refreshed) {
      acc.oauth = tokens;
      await acc.saveTokens?.(tokens);
    }
    auth = { user: acc.email, accessToken: tokens.access_token };
  } else {
    auth = { user: acc.imap.user || acc.email, pass: acc.imapPassword ?? "" };
  }
  const client = new ImapFlow({
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    auth,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
  } as ConstructorParameters<typeof ImapFlow>[0]);
  client.on("error", () => {
    /* surfaced through the failing command */
  });
  try {
    await client.connect();
  } catch (err) {
    throw classifyError(err);
  }
  return client;
}

class ImapSession implements MailSession {
  constructor(private client: ImapFlow) {}

  async folders(): Promise<FolderInfo[]> {
    const list = await this.client.list();
    return list.map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse ?? (f.path.toUpperCase() === "INBOX" ? "\\Inbox" : null) }));
  }

  async fetchNew(folder: string, sinceUid: number, opts: { uidValidity?: string | null; max: number; sinceDate?: Date }): Promise<FetchBatch> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const mb = this.client.mailbox as MailboxObject;
      const uidValidity = String(mb.uidValidity);
      let since = sinceUid;
      if (opts.uidValidity && opts.uidValidity !== uidValidity) since = 0;
      if (!mb.exists) return { uidValidity, messages: [], highestUid: Math.max(since, (mb.uidNext ?? 1) - 1) };
      let uids: number[];
      if (since > 0) {
        if (mb.uidNext && mb.uidNext - 1 <= since) return { uidValidity, messages: [], highestUid: since };
        const found = await this.client.search({ uid: `${since + 1}:*` }, { uid: true });
        uids = (found || []).filter((u) => u > since);
      } else {
        const found = await this.client.search(opts.sinceDate ? { since: opts.sinceDate } : { all: true }, { uid: true });
        uids = (found || []).slice(-opts.max);
      }
      uids.sort((a, b) => a - b);
      const highestAll = uids.length ? uids[uids.length - 1]! : since;
      const take = uids.slice(0, opts.max);
      const fetchSome = async (list: number[]) => {
        const got: FetchBatch["messages"] = [];
        for await (const m of this.client.fetch(list, { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
          if (!m.source) continue;
          got.push({ folder, uid: m.uid, raw: m.source, flags: [...(m.flags ?? [])], internalDate: m.internalDate ? new Date(m.internalDate) : null });
        }
        return got;
      };
      let messages: FetchBatch["messages"] = [];
      const failed: number[] = [];
      if (take.length) {
        try {
          messages = await fetchSome(take);
        } catch (err) {
          // One message the server won't hand over (a damaged file on its side) fails the whole fetch: get them one at a
          // time, so the rest still come through. When none do, the trouble isn't one message.
          messages = [];
          for (const uid of take) {
            try {
              messages.push(...(await fetchSome([uid])));
            } catch {
              failed.push(uid);
            }
          }
          if (!messages.length) throw err;
        }
      }
      // When more messages are waiting than `max`, the cursor only advances to the last fetched UID.
      const highestUid = take.length < uids.length ? take[take.length - 1]! : highestAll;
      return { uidValidity, messages, highestUid, ...(failed.length ? { failed } : {}) };
    } finally {
      lock.release();
    }
  }

  async move(folder: string, uid: number, destination: string): Promise<number | null> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const moved = await this.client.messageMove(String(uid), destination, { uid: true });
      return (moved && moved.uidMap?.get(uid)) || null;
    } finally {
      lock.release();
    }
  }

  async addFlags(folder: string, uid: number, flags: string[]): Promise<void> {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const gmail = this.client.capabilities.has("X-GM-EXT-1");
      const labels = flags.filter((f) => f === "\\Important");
      const plain = flags.filter((f) => f !== "\\Important");
      if (labels.length) {
        if (gmail) await this.client.messageFlagsAdd(String(uid), labels, { uid: true, useLabels: true });
        else plain.push("\\Flagged");
      }
      if (plain.length) await this.client.messageFlagsAdd(String(uid), [...new Set(plain)], { uid: true });
    } finally {
      lock.release();
    }
  }

  async searchText(text: string, folders: string[], since: Date, max: number): Promise<FetchedMessage[]> {
    const out: FetchedMessage[] = [];
    for (const folder of folders) {
      let lock;
      try {
        lock = await this.client.getMailboxLock(folder);
      } catch {
        continue;
      }
      try {
        const uids = ((await this.client.search({ body: text, since }, { uid: true })) || []).slice(-max);
        if (!uids.length) continue;
        for await (const m of this.client.fetch(uids, { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
          if (m.source) out.push({ folder, uid: m.uid, raw: m.source, flags: [...(m.flags ?? [])], internalDate: m.internalDate ? new Date(m.internalDate) : null });
        }
      } finally {
        lock.release();
      }
    }
    return out.slice(-max);
  }

  async findByMessageId(messageId: string, folders: string[]): Promise<FetchedMessage | null> {
    for (const folder of folders) {
      let lock;
      try {
        lock = await this.client.getMailboxLock(folder);
      } catch {
        continue; // folder missing on this server
      }
      try {
        const uids = (await this.client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
        if (!uids.length) continue;
        for await (const m of this.client.fetch(uids.slice(-1), { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
          if (m.source) return { folder, uid: m.uid, raw: m.source, flags: [...(m.flags ?? [])], internalDate: m.internalDate ? new Date(m.internalDate) : null };
        }
      } finally {
        lock.release();
      }
    }
    return null;
  }

  async append(folder: string, raw: Buffer, flags?: string[]): Promise<void> {
    await this.client.append(folder, raw, flags ?? ["\\Seen"]);
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

export class SmtpImapDriver implements MailDriver {
  readonly kind = "smtp-imap" as const;
  constructor(private acc: DriverAccount) {}

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const transport = await getTransport(this.acc);
    let info: Awaited<ReturnType<Transporter["sendMail"]>>;
    try {
      info = await transport.sendMail(toMailOptions(msg));
    } catch (err) {
      // When every recipient was refused, the email's own recipient's refusal says what happened (not a copy's).
      const classified = classifyError(ownRefusal(err, msg) ?? err);
      if (classified.kind === "auth" || classified.kind === "connection") dropTransport(this.acc.id);
      throw classified;
    }
    const list = (v: unknown) => ((v ?? []) as Array<string | { address: string }>).map((a) => (typeof a === "string" ? a : a.address));
    const rejected = list(info.rejected);
    // Copies (cc, bcc) went out but every addressee was refused: the email didn't reach the people it was written to.
    const refused = new Set(rejected.map((a) => a.toLowerCase()));
    if (msg.to.length && msg.to.every((a) => refused.has(a.address.toLowerCase()))) {
      throw classifyError(ownRefusal(info, msg) ?? Object.assign(new Error("Recipient refused"), { code: "EENVELOPE", command: "RCPT TO" }));
    }
    return { messageId: info.messageId || msg.messageId, response: info.response, accepted: list(info.accepted), rejected };
  }

  async open(): Promise<MailSession> {
    return new ImapSession(await imapClient(this.acc));
  }

  private withHint(side: "imap" | "smtp", check: ConnectionCheck): ConnectionCheck {
    const server = this.acc[side];
    const hint = server ? connectionHint(side, server, check, !!tokenFor(this.acc, server)) : undefined;
    return hint ? { ...check, hint } : check;
  }

  async verifySmtp(): Promise<ConnectionCheck> {
    try {
      dropTransport(this.acc.id);
      const t = await getTransport(this.acc);
      await t.verify();
      return { ok: true };
    } catch (err) {
      const e = classifyError(err);
      return this.withHint("smtp", { ok: false, error: e.message, code: e.kind });
    }
  }

  async verify(): Promise<{ smtp: ConnectionCheck; imap: ConnectionCheck }> {
    const smtp = await this.verifySmtp();
    const imap: ConnectionCheck = await (async () => {
      let client: ImapFlow | null = null;
      try {
        client = await imapClient(this.acc);
        await client.list();
        return { ok: true };
      } catch (err) {
        const e = classifyError(err);
        return this.withHint("imap", { ok: false, error: e.message, code: e.kind });
      } finally {
        if (client) await client.logout().catch(() => client?.close());
      }
    })();
    return { smtp, imap };
  }
}
