// Sandbox driver: a closed mail world inside the database. Every address is a mailbox, so sending,
// warmup, replies, bounces and auto-replies can be exercised without real mail servers.
//
// Recipient conventions (local part prefix) trigger automatic responses so demos show realistic data:
//   bounce…@  or  …@bounce.test   → hard bounce (DSN) back to the sender
//   ooo…@                         → out-of-office auto-reply
//   interested…@ / yes…@          → positive human reply
//   meeting…@                     → reply proposing a meeting time
//   notinterested…@ / no.…@       → negative reply
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { domainOf } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { buildRaw, newMessageId, replySubject } from "./compose";
import type { Address, ConnectionCheck, FetchBatch, FolderInfo, MailDriver, MailSession, OutgoingMessage, SendResult } from "./types";

export const SANDBOX_FOLDERS: FolderInfo[] = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
  { path: "Sent", name: "Sent", specialUse: "\\Sent" },
  { path: "Trash", name: "Trash", specialUse: "\\Trash" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
];

const lower = (a: string) => a.trim().toLowerCase();

export async function storeSandboxMessage(input: {
  workspaceId: string | null;
  mailbox: string;
  folder: string;
  raw: Buffer | string;
  messageId?: string | null;
  inReplyTo?: string | null;
  from?: string | null;
  subject?: string | null;
  flags?: string[];
  date?: Date;
}): Promise<number> {
  const [row] = await db
    .insert(schema.sandboxMessages)
    .values({
      workspaceId: input.workspaceId,
      mailbox: lower(input.mailbox),
      folder: input.folder,
      raw: typeof input.raw === "string" ? input.raw : input.raw.toString("utf8"),
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      fromAddress: input.from ?? null,
      subject: input.subject ?? null,
      flags: input.flags ?? [],
      internalDate: input.date ?? new Date(),
    })
    .returning({ uid: schema.sandboxMessages.uid });
  return row!.uid;
}

function dsn(original: OutgoingMessage, recipient: string): { raw: string; messageId: string } {
  const boundary = `rs-dsn-${Date.now().toString(36)}`;
  const messageId = newMessageId("mailer-daemon@sandbox.local");
  const raw = [
    `From: Mail Delivery Subsystem <mailer-daemon@sandbox.local>`,
    `To: ${original.from.address}`,
    `Subject: Delivery Status Notification (Failure)`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Auto-Submitted: auto-replied`,
    `X-Failed-Recipients: ${recipient}`,
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Address not found`,
    ``,
    `Your message wasn't delivered to ${recipient} because the address couldn't be found, or is unable to receive mail.`,
    ``,
    `--${boundary}`,
    `Content-Type: message/delivery-status`,
    ``,
    `Reporting-MTA: dns; sandbox.local`,
    ``,
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: failed`,
    `Status: 5.1.1`,
    `Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/rfc822-headers`,
    ``,
    `Message-ID: ${original.messageId}`,
    `From: ${original.from.address}`,
    `To: ${recipient}`,
    `Subject: ${original.subject}`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
  return { raw, messageId };
}

const CANNED: Array<{ test: (local: string) => boolean; auto?: boolean; text: string }> = [
  {
    test: (l) => l.startsWith("ooo"),
    auto: true,
    text: "Thank you for your email. I'm out of the office with limited access to email until next Monday. I'll respond as soon as I'm back.",
  },
  {
    test: (l) => l.startsWith("notinterested") || l.startsWith("no.") || l === "no",
    text: "Thanks, but we're not interested right now. Please remove me from your list.",
  },
  {
    test: (l) => l.startsWith("meeting"),
    text: "Happy to chat. Does Tuesday at 2pm work? Send over an invite.",
  },
  {
    test: (l) => l.startsWith("interested") || l.startsWith("yes"),
    text: "Thanks for reaching out, this looks relevant for us. Could you share more details and pricing?",
  },
];

async function autoRespond(workspaceId: string | null, original: OutgoingMessage, recipient: Address) {
  const local = recipient.address.split("@")[0]!.toLowerCase();
  const domain = domainOf(recipient.address);
  if (local.startsWith("bounce") || domain === "bounce.test") {
    const d = dsn(original, recipient.address);
    await storeSandboxMessage({
      workspaceId,
      mailbox: original.from.address,
      folder: "INBOX",
      raw: d.raw,
      messageId: d.messageId,
      inReplyTo: original.messageId,
      from: "mailer-daemon@sandbox.local",
      subject: "Delivery Status Notification (Failure)",
    });
    return;
  }
  const canned = CANNED.find((c) => c.test(local));
  if (!canned) return;
  // A simulated prospect answers each sender once, so replies sent on autopilot don't ping-pong forever.
  const SM = schema.sandboxMessages;
  const [already] = await db
    .select({ uid: SM.uid })
    .from(SM)
    .where(and(eq(SM.mailbox, lower(original.from.address)), eq(SM.folder, "INBOX"), sql`lower(${SM.fromAddress}) = ${lower(recipient.address)}`))
    .limit(1);
  if (already) return;
  // Arrives a little after the original so threads read naturally (the Date header has whole seconds).
  const arrives = new Date(Date.now() + 2000);
  const reply: OutgoingMessage = {
    from: { name: recipient.name ?? null, address: recipient.address },
    to: [original.from],
    date: arrives,
    subject: canned.auto ? `Automatic reply: ${original.subject}` : replySubject(original.subject),
    text: canned.text,
    html: `<div>${canned.text}</div>`,
    messageId: newMessageId(recipient.address),
    inReplyTo: original.messageId,
    references: [...(original.references ?? []), original.messageId],
    headers: canned.auto ? { "Auto-Submitted": "auto-replied", "X-Autoreply": "yes" } : undefined,
  };
  const raw = await buildRaw(reply);
  await storeSandboxMessage({
    workspaceId,
    mailbox: original.from.address,
    folder: "INBOX",
    raw,
    messageId: reply.messageId,
    inReplyTo: original.messageId,
    from: recipient.address,
    subject: reply.subject,
    date: arrives,
  });
  await storeSandboxMessage({ workspaceId, mailbox: recipient.address, folder: "Sent", raw, messageId: reply.messageId, from: recipient.address, subject: reply.subject, flags: ["\\Seen"] });
}

class SandboxSession implements MailSession {
  constructor(private mailbox: string) {}

  async folders() {
    return SANDBOX_FOLDERS;
  }

  async fetchNew(folder: string, sinceUid: number, opts: { uidValidity?: string | null; max: number; sinceDate?: Date }): Promise<FetchBatch> {
    const t = schema.sandboxMessages;
    const where = [eq(t.mailbox, this.mailbox), eq(t.folder, folder), gt(t.uid, sinceUid)];
    if (!sinceUid && opts.sinceDate) where.push(gte(t.internalDate, opts.sinceDate));
    const rows = await db.select().from(t).where(and(...where)).orderBy(asc(t.uid)).limit(opts.max);
    const [maxRow] = await db
      .select({ m: sql<number>`coalesce(max(${t.uid}), 0)` })
      .from(t)
      .where(and(eq(t.mailbox, this.mailbox), eq(t.folder, folder)));
    const highestUid = rows.length === opts.max ? rows[rows.length - 1]!.uid : Math.max(sinceUid, Number(maxRow?.m ?? 0));
    return {
      uidValidity: "1",
      highestUid,
      messages: rows.map((r) => ({ folder, uid: r.uid, raw: Buffer.from(r.raw, "utf8"), flags: r.flags ?? [], internalDate: r.internalDate })),
    };
  }

  async move(_folder: string, uid: number, destination: string) {
    await db
      .update(schema.sandboxMessages)
      .set({ folder: destination })
      .where(and(eq(schema.sandboxMessages.uid, uid), eq(schema.sandboxMessages.mailbox, this.mailbox)));
    return uid;
  }

  async addFlags(_folder: string, uid: number, flags: string[]) {
    const [row] = await db
      .select({ flags: schema.sandboxMessages.flags })
      .from(schema.sandboxMessages)
      .where(and(eq(schema.sandboxMessages.uid, uid), eq(schema.sandboxMessages.mailbox, this.mailbox)));
    if (!row) return;
    const next = [...new Set([...(row.flags ?? []), ...flags])];
    await db.update(schema.sandboxMessages).set({ flags: next }).where(eq(schema.sandboxMessages.uid, uid));
  }

  async searchText(text: string, folders: string[], since: Date, max: number) {
    const t = schema.sandboxMessages;
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.mailbox, this.mailbox), inArray(t.folder, folders), gte(t.internalDate, since), sql`instr(${t.raw}, ${text}) > 0`))
      .orderBy(desc(t.uid))
      .limit(max);
    return rows.map((r) => ({ folder: r.folder, uid: r.uid, raw: Buffer.from(r.raw, "utf8"), flags: r.flags ?? [], internalDate: r.internalDate }));
  }

  async findByMessageId(messageId: string, folders: string[]) {
    const t = schema.sandboxMessages;
    const [r] = await db
      .select()
      .from(t)
      .where(and(eq(t.mailbox, this.mailbox), eq(t.messageId, messageId), inArray(t.folder, folders)))
      .limit(1);
    return r ? { folder: r.folder, uid: r.uid, raw: Buffer.from(r.raw, "utf8"), flags: r.flags ?? [], internalDate: r.internalDate } : null;
  }

  async append(folder: string, raw: Buffer, flags?: string[]) {
    await storeSandboxMessage({ workspaceId: null, mailbox: this.mailbox, folder, raw, flags: flags ?? ["\\Seen"] });
  }

  async close() {}
}

export class SandboxDriver implements MailDriver {
  readonly kind = "sandbox" as const;
  constructor(private acc: { email: string; workspaceId: string }) {}

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const raw = await buildRaw(msg);
    const envelope = msg.envelopeTo?.map((a) => a.toLowerCase());
    const recipients = envelope ? envelope.map((address) => ({ address })) : [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])];
    // Sent keeps the transmission to the people it's addressed to; a copy sent on its own to cc/bcc isn't filed again.
    if (!envelope || msg.to.some((a) => envelope.includes(a.address.toLowerCase()))) {
      await storeSandboxMessage({
        workspaceId: this.acc.workspaceId,
        mailbox: this.acc.email,
        folder: "Sent",
        raw,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo,
        from: msg.from.address,
        subject: msg.subject,
        flags: ["\\Seen"],
      });
    }
    for (const r of recipients) {
      const isBounce = r.address.toLowerCase().startsWith("bounce") || domainOf(r.address) === "bounce.test";
      if (!isBounce) {
        const spam = (msg.sandbox?.spamChance ?? 0) > Math.random();
        // Simulated Gmail-style category tab (Promotions) for mail that reaches the inbox.
        const category = !spam && (msg.sandbox?.categoryChance ?? 0) > Math.random();
        await storeSandboxMessage({
          workspaceId: this.acc.workspaceId,
          mailbox: r.address,
          folder: spam ? "Junk" : "INBOX",
          raw,
          messageId: msg.messageId,
          inReplyTo: msg.inReplyTo,
          from: msg.from.address,
          subject: msg.subject,
          flags: category ? ["$Promotions"] : [],
        });
      }
      await autoRespond(this.acc.workspaceId, msg, r);
    }
    return { messageId: msg.messageId, response: "250 2.0.0 OK (sandbox)", accepted: recipients.map((r) => r.address), rejected: [] };
  }

  async open(): Promise<MailSession> {
    return new SandboxSession(lower(this.acc.email));
  }

  async verify(): Promise<{ smtp: ConnectionCheck; imap: ConnectionCheck }> {
    return { smtp: { ok: true }, imap: { ok: true } };
  }

  async verifySmtp(): Promise<ConnectionCheck> {
    return { ok: true };
  }
}

/** Mailboxes (addresses) that have sandbox mail for a workspace — used by the sandbox viewer. */
export async function sandboxMailboxes(workspaceId: string) {
  const t = schema.sandboxMessages;
  return db
    .select({ mailbox: t.mailbox, count: sql<number>`count(*)`, last: sql<number>`max(${t.internalDate})` })
    .from(t)
    .where(eq(t.workspaceId, workspaceId))
    .groupBy(t.mailbox)
    .orderBy(sql`max(${t.internalDate}) desc`)
    .limit(500);
}

export async function sandboxMessagesFor(workspaceId: string, mailbox: string, folders?: string[]) {
  const t = schema.sandboxMessages;
  const where = [eq(t.workspaceId, workspaceId), eq(t.mailbox, lower(mailbox))];
  if (folders?.length) where.push(inArray(t.folder, folders));
  return db.select().from(t).where(and(...where)).orderBy(sql`${t.uid} desc`).limit(200);
}
