// Builds MIME messages (nodemailer options or raw RFC 822 bytes) from OutgoingMessage.
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { domainOf, escapeHtml, htmlToText, textToHtml } from "@reachstack/shared";
import { uuidv7 } from "../lib/ids";
import type { Address, OutgoingMessage } from "./types";

export function newMessageId(fromEmail: string): string {
  const domain = domainOf(fromEmail) || "localhost";
  return `<${uuidv7().replace(/-/g, "")}@${domain}>`;
}

/** Normalises a Message-ID to the bracketed form. */
export function bracketId(id: string | null | undefined): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  return t.startsWith("<") ? t : `<${t}>`;
}

const fmt = (a: Address): Mail.Address | string => (a.name ? { name: a.name, address: a.address } : a.address);

export function toMailOptions(msg: OutgoingMessage): Mail.Options {
  const html = msg.html ?? undefined;
  const text = msg.text ?? (html ? htmlToText(html) : "");
  const references = (msg.references ?? []).filter(Boolean);
  return {
    from: fmt(msg.from),
    to: msg.to.map(fmt),
    cc: msg.cc?.length ? msg.cc.map(fmt) : undefined,
    bcc: msg.bcc?.length ? msg.bcc.map(fmt) : undefined,
    replyTo: msg.replyTo || undefined,
    subject: msg.subject,
    html,
    text,
    messageId: msg.messageId,
    inReplyTo: msg.inReplyTo || undefined,
    references: references.length ? references.join(" ") : undefined,
    headers: msg.headers,
    ...(msg.envelopeTo ? { envelope: { from: msg.from.address, to: msg.envelopeTo } } : {}),
    date: msg.date ?? new Date(),
    attachments: msg.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      path: a.path,
      content: a.content,
      cid: a.cid,
    })),
  };
}

/** Raw RFC 822 bytes (used by the sandbox driver and for IMAP APPEND). */
export async function buildRaw(msg: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer(toMailOptions(msg));
  const node = composer.compile();
  node.keepBcc = false;
  return node.build();
}

export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^\s*fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/** Appends a quoted copy of the previous message under a reply body (Gmail-style). `from` is plain text ("Name <address>"). */
export function quoteHtml(previous: { html?: string | null; text?: string | null; from: string; date: Date }): string {
  const when = previous.date.toUTCString();
  const inner = previous.html || textToHtml(previous.text ?? "");
  return `<br/><div class="rs-quote"><div>On ${when}, ${escapeHtml(previous.from)} wrote:<br/></div><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${inner}</blockquote></div>`;
}
