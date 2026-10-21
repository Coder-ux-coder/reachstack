// Content spam scoring. Uses a real SpamAssassin daemon when SPAMD_HOST is set; otherwise an original
// heuristic rule set (clearly reported as "heuristic") scored on the same 0–10+ scale, spam at >= 5.
import { connect } from "node:net";
import { htmlToText } from "@reachstack/shared";
import { config } from "../env";

export interface SpamRule {
  name: string;
  description: string;
  score: string;
}

export interface SpamReport {
  engine: "spamassassin" | "heuristic";
  is_spam: boolean;
  spam_score: number;
  threshold: number;
  report: SpamRule[];
}

const PHRASES = [
  "100% free", "act now", "apply now", "as seen on", "best price", "buy now", "call now", "cancel at any time", "cash bonus",
  "cheap", "click below", "click here", "congratulations", "credit card", "double your", "earn money", "earn extra cash",
  "eliminate debt", "exclusive deal", "extra income", "free gift", "free trial", "get paid", "guarantee", "increase sales",
  "limited time", "lowest price", "make money", "miracle", "no catch", "no cost", "no obligation", "no strings attached",
  "once in a lifetime", "order now", "risk-free", "risk free", "special promotion", "this is not spam", "urgent", "winner",
  "you have been selected", "viagra", "casino", "crypto giveaway", "act immediately", "while supplies last", "100% satisfied",
];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|rebrand\.ly|is\.gd|cutt\.ly|shorturl\.at|tiny\.cc)\//i;
const RISKY_TLDS = /https?:\/\/[^/\s"'<>]+\.(xyz|top|click|loan|work|gq|tk|ml|cf|zip|mov|country|kim|men)(?=[/"'\s>]|$)/i;

/** Known spam-trigger phrases present in a subject or body (lower-cased matches, in list order). */
export function findSpamPhrases(subject: string, html: string): string[] {
  const lower = `${subject}\n${htmlToText(html || "")}`.toLowerCase();
  return PHRASES.filter((p) => lower.includes(p));
}

function rule(out: SpamRule[], name: string, description: string, score: number) {
  if (score > 0) out.push({ name, description, score: score.toFixed(1) });
}

/** Original heuristic rules over the subject and HTML/text body. */
export function heuristicSpamScore(subject: string, html: string): SpamReport {
  const out: SpamRule[] = [];
  const text = htmlToText(html || "");
  const lower = `${subject}\n${text}`.toLowerCase();
  const letters = subject.replace(/[^A-Za-z]/g, "");
  if (!subject.trim()) rule(out, "SUBJ_MISSING", "Message has no subject", 1.0);
  if (letters.length >= 8 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) rule(out, "SUBJ_ALL_CAPS", "Subject is mostly upper case", 1.5);
  if (/!{2,}|!\s*$/.test(subject)) rule(out, "SUBJ_EXCLAMATION", "Subject ends with or repeats exclamation marks", 0.8);
  if (/[$€£]{2,}|\$\d{3,}/.test(lower)) rule(out, "MONEY_EMPHASIS", "Repeated currency symbols or large dollar amounts", 1.2);
  const hits = PHRASES.filter((p) => lower.includes(p));
  if (hits.length) rule(out, "SPAMMY_PHRASES", `Common spam phrases: ${hits.slice(0, 6).join(", ")}`, Math.min(3, hits.length * 0.5));
  const links = [...(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']?(https?:[^"'\s>]+)/gi)].map((m) => m[1]!);
  const bareLinks = links.length ? [] : [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
  const allLinks = [...links, ...bareLinks];
  if (allLinks.length > 3) rule(out, "MANY_LINKS", `${allLinks.length} links in one email`, Math.min(1.5, (allLinks.length - 3) * 0.4));
  if (allLinks.some((l) => SHORTENERS.test(l))) rule(out, "URL_SHORTENER", "Uses a link shortener that hides the destination", 1.2);
  if (allLinks.some((l) => RISKY_TLDS.test(l))) rule(out, "RISKY_TLD", "Links to a domain extension often used by spammers", 0.8);
  if (allLinks.some((l) => /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(l))) rule(out, "RAW_IP_LINK", "Links to a bare IP address", 1.5);
  const images = ((html || "").match(/<img\b/gi) ?? []).length;
  if (images && text.trim().length < 200) rule(out, "IMAGE_HEAVY", "Images with very little text", 1.5);
  if (/<form\b|<script\b|javascript:/i.test(html || "")) rule(out, "ACTIVE_CONTENT", "Forms or scripts inside the email", 2.0);
  if (/display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden/i.test(html || "")) rule(out, "HIDDEN_TEXT", "Hidden text in the HTML", 1.0);
  const capsWords = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !/^(HTTP|HTTPS|HTML|CEO|CTO|COO|CFO|SAAS|B2B|B2C|API|USA|FAQ|ROI|KPI|SEO|PDF|CRM)$/.test(w));
  if (capsWords.length > 5) rule(out, "SHOUTING", "Many words in all caps", 0.7);
  if ((text.match(/!/g) ?? []).length > 3) rule(out, "BODY_EXCLAMATIONS", "Many exclamation marks", 0.5);
  if (text.split(/\s+/).length > 600) rule(out, "LONG_BODY", "Very long for a cold email (over 600 words)", 0.4);
  if (/<img\b[^>]*width=["']?1["']?[^>]*height=["']?1/i.test(html || "")) rule(out, "TRACKING_PIXEL", "Contains an open-tracking pixel", 0.3);
  const score = Math.round(out.reduce((s, r) => s + Number(r.score), 0) * 10) / 10;
  return { engine: "heuristic", is_spam: score >= 5, spam_score: score, threshold: 5, report: out };
}

/** Asks a SpamAssassin daemon (spamd) for a REPORT over a raw RFC 822 message. */
function spamdReport(host: string, port: number, raw: Buffer): Promise<SpamReport> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    sock.setTimeout(15_000, () => sock.destroy(new Error("spamd timeout")));
    sock.on("connect", () => {
      sock.write(`REPORT SPAMC/1.5\r\nContent-length: ${raw.length}\r\n\r\n`);
      sock.write(raw);
      sock.end();
    });
    sock.on("data", (d) => chunks.push(d));
    sock.on("error", reject);
    sock.on("close", () => {
      const res = Buffer.concat(chunks).toString("utf8");
      const head = res.match(/Spam:\s*(True|False|Yes|No)\s*;\s*(-?[\d.]+)\s*\/\s*([\d.]+)/i);
      if (!head) return reject(new Error("Unexpected spamd response"));
      const rules: SpamRule[] = [];
      for (const line of res.split(/\r?\n/)) {
        const m = line.match(/^\s*(-?\d+\.\d)\s+([A-Z0-9_]+)\s+(.*)$/);
        if (m) rules.push({ score: m[1]!, name: m[2]!, description: m[3]!.trim() });
      }
      const score = Number(head[2]);
      resolve({ engine: "spamassassin", is_spam: /true|yes/i.test(head[1]!), spam_score: score, threshold: Number(head[3]), report: rules });
    });
  });
}

/** Scores a message with spamd when configured, falling back to the heuristic rules. */
export async function spamScore(input: { subject: string; html: string; raw?: Buffer }): Promise<SpamReport> {
  const host = config.spamd.host;
  if (host && input.raw) {
    try {
      return await spamdReport(host, config.spamd.port, input.raw);
    } catch {
      // fall through to the heuristic
    }
  }
  return heuristicSpamScore(input.subject, input.html);
}
