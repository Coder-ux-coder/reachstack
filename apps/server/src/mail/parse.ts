// Parses inbound RFC 822 messages and classifies bounces and automatic replies.
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { htmlToText, snippet } from "@reachstack/shared";
import { sha256 } from "../lib/ids";
import { bracketId } from "./compose";
import { enhancedCode, refusalKind, type RefusalKind } from "./refusals";
import { isReplySubject, newestReplyText, quotesEarlier } from "./reply-text";

export interface ParsedAddress {
  address: string;
  name: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  content: Buffer;
}

export interface InboundMessage {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: string | null;
  date: Date;
  text: string;
  html: string;
  preview: string;
  headers: Map<string, unknown>;
  attachments: ParsedAttachment[];
  isAutoReply: boolean;
  bounce: BounceInfo | null;
}

export interface BounceInfo {
  hard: boolean;
  /**
   * hard: the address doesn't work; soft: a temporary failure (mailbox full…); block: the receiving side refused the
   * sender or the message (policy, reputation), which says nothing about the address; delayed: still being retried,
   * not a bounce. See ./refusals.
   */
  kind: RefusalKind | "delayed";
  status: string | null;
  recipient: string | null;
  /** Every address the notice reports on (failed, final and original recipients), lowercased. */
  recipients: string[];
  diagnostic: string | null;
  originalMessageId: string | null;
}

function addrs(v: AddressObject | AddressObject[] | undefined): ParsedAddress[] {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: ParsedAddress[] = [];
  for (const group of list) {
    for (const a of group.value ?? []) {
      if (a.address) out.push({ address: a.address.toLowerCase(), name: a.name ?? "" });
      for (const g of a.group ?? []) if (g.address) out.push({ address: g.address.toLowerCase(), name: g.name ?? "" });
    }
  }
  return out;
}

function headerStr(headers: Map<string, unknown>, key: string): string {
  const v = headers.get(key);
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) return String((v as { value: unknown }).value ?? "");
  return String(v);
}

/** A parameter of a structured header (Content-Type's report-type…), lowercased. */
function headerParam(headers: Map<string, unknown>, key: string, param: string): string {
  const v = headers.get(key);
  if (v && typeof v === "object") return String((v as { params?: Record<string, unknown> }).params?.[param] ?? "").toLowerCase();
  return (new RegExp(`${param}\\s*=\\s*"?([^";\\s]+)`, "i").exec(typeof v === "string" ? v : "")?.[1] ?? "").toLowerCase();
}

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|abwesenheitsnotiz|réponse automatique|respuesta automática|risposta automatica|autosvar|automatisch antwoord|i am (currently )?out of|on (annual )?leave|away from (the )?office|vacation reply|autoreply)/i;
// Only wording a person rarely writes themselves: "I will be back next week, let's talk then" is a reply, not an
// auto-reply, so a bare "will be back" doesn't count.
const AUTO_BODY =
  /(i('| a)m (currently )?(out of (the )?office|away from (the |my )?(office|desk)|on (annual |parental |maternity |paternity |sick )?leave|on (vacation|holiday))|i('ll| will) be out of (the )?office|limited access to (my )?e-?mail|this is an automa(ted|tic) (reply|response|message|e-?mail))/i;

export function detectAutoReply(headers: Map<string, unknown>, subject: string, text: string): boolean {
  const autoSubmitted = headerStr(headers, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers.has("x-autoreply") || headers.has("x-autorespond") || headers.has("x-autoresponse")) return true;
  const precedence = headerStr(headers, "precedence").toLowerCase();
  if (precedence === "auto_reply") return true;
  if (headerStr(headers, "x-auto-response-suppress").toLowerCase().includes("all") && AUTO_SUBJECT.test(subject)) return true;
  if (AUTO_SUBJECT.test(subject.trim())) return true;
  // Wording alone only counts when nothing earlier is quoted: an out-of-office notice doesn't quote the email it
  // answers, while a person writing back usually does ("I'm on vacation until the 20th, but yes, let's talk"). And only
  // the person's own words: our quoted email must not make a reply look automatic.
  return !quotesEarlier(text) && AUTO_BODY.test(newestReplyText(text).slice(0, 600));
}

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon|bounce|bounces|noreply-dmarc)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|subsystem)|message not delivered|could not be delivered|delivery failure|address not found|non-delivery|nondeliverable|delivery delayed|delayed mail)/i;

/** An SMTP refusal in a server's words: "550 5.1.1 …" at the start of a line, or an enhanced code like 5.1.1. */
const SMTP_REFUSAL = /^\s*55[0-4][ -]|\b5\.\d{1,3}\.\d{1,3}\b/m;

function findBounce(parsed: ParsedMail, from: ParsedAddress | null, subject: string, text: string): BounceInfo | null {
  const ctype = headerStr(parsed.headers, "content-type").toLowerCase();
  // A delivery report says so in its Content-Type (report-type=delivery-status), whatever language its subject is in.
  const isReport = ctype === "multipart/report" && headerParam(parsed.headers, "content-type", "report-type") === "delivery-status";
  const local = from?.address.split("@")[0] ?? "";
  // Without either sign, a bounce-like subject and a refusal code in the message's own words (not a reply to ours, and
  // not the email it quotes, where "550" may be a price).
  const looksLike =
    isReport || (BOUNCE_FROM.test(local) && BOUNCE_SUBJECT.test(subject)) || (!isReplySubject(subject) && BOUNCE_SUBJECT.test(subject) && SMTP_REFUSAL.test(newestReplyText(text)));
  if (!looksLike) return null;

  // The delivery-status part may be parsed as an attachment, and so may the copy of the original email (whose words
  // and numbers must not be read as the server's answer, only its Message-ID).
  let report = text;
  let original = text;
  for (const a of parsed.attachments ?? []) {
    const t = (a.contentType || "").toLowerCase();
    const body = `\n${a.content.toString("utf8").slice(0, 20_000)}`;
    if (t.includes("delivery-status")) report += body;
    else if (t.includes("rfc822-headers") || t === "message/rfc822" || t.includes("text/rfc822")) original += body;
  }
  const diagnostic = /Diagnostic-Code:\s*([^\r\n]+)/i.exec(report)?.[1]?.trim() ?? null;
  const words = diagnostic ?? text.slice(0, 3_000);
  const status = /Status:\s*([245]\.\d{1,3}\.\d{1,3})/i.exec(report)?.[1] ?? enhancedCode(words);
  const recipients = [
    ...new Set(
      [...headerStr(parsed.headers, "x-failed-recipients").split(","), ...[...report.matchAll(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/gi)].map((m) => m[1]!)]
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes("@")),
    ),
  ];
  // Some servers leave out the original's headers but answer it in the thread.
  const originalMessageId = bracketId(/^Message-ID:\s*(<[^>]+>)/im.exec(original)?.[1] ?? null) ?? bracketId(parsed.inReplyTo ?? null);
  const code = status ?? "";
  // "Action: delayed" (or a delay subject with a 4.x.x code) means the server is still trying: not a bounce.
  const action = /^Action:\s*(\w+)/im.exec(report)?.[1]?.toLowerCase() ?? null;
  const delayed = action === "delayed" || (action !== "failed" && /\bdelay(ed)?\b/i.test(subject) && (!code || code.startsWith("4")));
  // Only an address that doesn't work is a hard bounce; a full mailbox, a block or an unclear answer isn't.
  const kind = delayed ? "delayed" : refusalKind(status, words);
  return { hard: kind === "hard", kind, status, recipient: recipients[0] ?? null, recipients, diagnostic, originalMessageId };
}

export async function parseInbound(raw: Buffer): Promise<InboundMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: false });
  const from = addrs(parsed.from)[0] ?? null;
  const subject = (parsed.subject ?? "").trim();
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = (parsed.text ?? "").trim() || htmlToText(html);
  const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? String(parsed.references).split(/\s+/) : [])
    .map((r) => bracketId(r))
    .filter((r): r is string => !!r);
  // A message without a Message-ID gets one from what it says, the same every time it's read, so it's never filed twice.
  const messageId = bracketId(parsed.messageId) ?? `<generated-${sha256([from?.address ?? "", parsed.date?.toISOString() ?? "", subject, text.slice(0, 2000)].join("\n")).slice(0, 32)}@local>`;
  const bounce = findBounce(parsed, from, subject, text);
  const replyTo = addrs(parsed.replyTo)[0]?.address ?? null;
  return {
    messageId,
    inReplyTo: bracketId(parsed.inReplyTo ?? null),
    references,
    subject,
    from,
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    replyTo,
    date: parsed.date ?? new Date(),
    text,
    html: html || `<div>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</div>`,
    preview: snippet(stripQuoted(text) || text, 160),
    headers: parsed.headers,
    attachments: (parsed.attachments ?? [])
      .filter((a) => !bounce || !(a.contentType || "").includes("delivery-status"))
      .map((a) => ({
        filename: a.filename || "attachment",
        contentType: a.contentType || "application/octet-stream",
        size: a.size ?? a.content.length,
        contentId: a.cid ?? null,
        content: a.content,
      })),
    isAutoReply: !bounce && detectAutoReply(parsed.headers, subject, text),
    bounce,
  };
}

/** Removes quoted previous messages and the signature from a reply ("On … wrote:", "> …", Outlook headers). */
export const stripQuoted = (text: string): string => newestReplyText(text);
