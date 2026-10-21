// Open/click tracking and unsubscribe links. Tokens carry only the email id plus an HMAC, so links stay short
// and cannot be forged; everything else is looked up from the stored email.
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { decodeEntities } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { hmac, verifyHmac } from "../lib/crypto";
import { isPrivateIp } from "../lib/net";
import type { AccountRow } from "../mail/driver";

export function trackingBase(account: Pick<AccountRow, "trackingDomainName" | "trackingDomainStatus"> | null | undefined): string {
  if (account?.trackingDomainName && account.trackingDomainStatus === "verified") return `https://${account.trackingDomainName}`;
  return config.trackingBaseUrl;
}

/**
 * Whether people's mail apps can open links to this address: not this computer, a private network, a name without a
 * dot or a reserved test name. A server run on a laptop (npm run local) isn't, so its tracking links would be broken.
 */
export function reachableFromInternet(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  const ip = host.replace(/^\[|\]$/g, "");
  if (isIP(ip)) return !isPrivateIp(ip);
  return host.includes(".") && !/\.(?:local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host);
}

/** The unsubscribe link when this server can't be reached: an email to the sender asking to unsubscribe, which inbox sync acts on. */
export function unsubscribeMailto(account: Pick<AccountRow, "email" | "replyTo">): string {
  return `mailto:${account.replyTo || account.email}?subject=unsubscribe`;
}

export function emailToken(emailId: string): string {
  return `${emailId}.${hmac(`t:${emailId}`, 12)}`;
}

export function readEmailToken(token: string | undefined): string | null {
  if (!token) return null;
  const clean = token.replace(/\.gif$/, "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = clean.slice(0, dot);
  return verifyHmac(`t:${id}`, clean.slice(dot + 1), 12) ? id : null;
}

/** The email we sent (campaign or Unibox) that a tracking, unsubscribe or report-abuse token stands for. */
export async function sentEmailByToken(token: string | undefined) {
  const id = readEmailToken(token);
  if (!id) return null;
  const [row] = await db
    .select()
    .from(schema.emails)
    .where(and(eq(schema.emails.id, id), inArray(schema.emails.ueType, [1, 3])))
    .limit(1);
  return row ?? null;
}

export function unsubscribeUrl(base: string, emailId: string): string {
  return `${base}/u/${emailToken(emailId)}`;
}

export function openPixelUrl(base: string, emailId: string): string {
  return `${base}/t/o/${emailToken(emailId)}.gif`;
}

export function clickUrl(base: string, emailId: string, target: string): string {
  const token = emailToken(emailId);
  return `${base}/t/c/${token}?u=${encodeURIComponent(target)}&s=${hmac(`${token}|${target}`, 10)}`;
}

export function verifyClick(token: string, target: string, sig: string | undefined): boolean {
  return !!sig && verifyHmac(`${token}|${target}`, sig, 10);
}

/** Rewrites http(s) links for click tracking (skips mailto/tel, anchors and the unsubscribe link). */
export function rewriteLinks(html: string, base: string, emailId: string): string {
  const unsub = `${base}/u/`;
  return html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi, (m, pre: string, q: string, href: string) => {
    // The address a browser would open: an attribute's character references (&amp;, &#39;, &quot;…) read as characters.
    const url = decodeEntities(href.trim());
    if (!/^https?:\/\//i.test(url) || url.startsWith(unsub) || /data-no-track/i.test(m)) return m;
    return `${pre}${q}${clickUrl(base, emailId, url).replace(/&/g, "&amp;")}${q}`;
  });
}

export function appendOpenPixel(html: string, base: string, emailId: string): string {
  const img = `<img src="${openPixelUrl(base, emailId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : `${html}${img}`;
}

/**
 * Bots, mail security scanners, link previews and scripts, which open and click on their own: they don't count as a
 * person opening or clicking.
 */
const BOT_AGENTS =
  /(bot|crawler|spider|slurp|preview|scanner|barracuda|proofpoint|mimecast|symantec|messagelabs|ironport|forcepoint|zscaler|netskope|cloudmark|spamtitan|appriver|safelinks|urldefense|cisco|fortiguard|trendmicro|sophos|google-safety|facebookexternalhit|whatsapp|python-requests|python-urllib|aiohttp|go-http-client|okhttp|java\/|apache-httpclient|httpclient|libwww|node-fetch|axios|curl\/|wget|headlesschrome)/i;

/**
 * Office apps look a link up ("Protocol Discovery") before the browser that a click opens, so for links that agent
 * isn't a person. Outlook for Windows loads a message's images with the same agent: for opens it's the reader.
 */
const OFFICE_AGENT = /ms-office|microsoft office/i;

export function isLikelyBot(userAgent: string | undefined, kind: "open" | "click" = "click"): boolean {
  if (!userAgent) return false;
  return BOT_AGENTS.test(userAgent) || (kind === "click" && OFFICE_AGENT.test(userAgent));
}

/** Where a tracked link sends people: the address as browsers write it (non-ASCII percent-encoded), or null if it isn't one. */
export function redirectTarget(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- Tracking links in stored copies ----------

// Campaign sends are stored as sent: with the open pixel, click-tracking redirects and maybe an unsubscribe link,
// each carrying the email's signed token. Copies shown in the Unibox, exported, quoted in a reply, forwarded or sent to
// the campaign's cc and bcc addresses must not count as the lead opening or clicking, and must not hand out the token,
// which can also unsubscribe the lead.
const TOKEN = String.raw`[0-9a-fA-F-]{36}\.[\w-]{12}`;
const PIXEL_IMG = new RegExp(String.raw`<img\b[^>]*?\bsrc\s*=\s*(["'])[^"']*?/t/o/${TOKEN}[^"']*\1[^>]*>`, "gi");
const TRACKED_ATTR = new RegExp(String.raw`(["'])(https?://[^"'\s<>]*?/(?:t/[oc]|u)/${TOKEN}[^"'\s<>]*)\1`, "gi");
const TRACKED_TEXT = new RegExp(String.raw`https?://[^\s"'<>()]*?/(?:t/[oc]|u)/${TOKEN}[^\s"'<>()]*`, "gi");

/** Where a click-tracking redirect leads; null for pixels, unsubscribe links and cut-off previews. */
function clickTarget(url: string): string | null {
  const q = /\/t\/c\/[^?\s]+\?([^\s"'<>()]*)/.exec(url)?.[1];
  if (!q) return null;
  const target = new URLSearchParams(q.replace(/&amp;/g, "&")).get("u");
  return target && /^https?:\/\/[^\s]+$/i.test(target) ? target : null;
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Text with tracked links replaced by where they lead (unsubscribe links and pixels are dropped). */
export function untrackText(text: string): string {
  return text.replace(TRACKED_TEXT, (url) => clickTarget(url) ?? (/\/u\//.test(url) ? "(unsubscribe link)" : ""));
}

/** HTML without open pixels, with click redirects pointing straight at their targets and no tracking tokens left. */
export function untrackHtml(html: string): string {
  if (!html || !/\/(?:t\/[oc]|u)\//.test(html)) return html;
  return html
    .replace(PIXEL_IMG, "")
    .replace(TRACKED_ATTR, (_m, q: string, url: string) => {
      const target = clickTarget(url);
      return `${q}${target ? attr(target) : "#"}${q}`;
    })
    .replace(TRACKED_TEXT, (url) => attr(untrackText(url)));
}

/** 43-byte transparent GIF. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
