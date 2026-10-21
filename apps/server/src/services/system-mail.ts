import nodemailer from "nodemailer";
import { config } from "../env";

let transport: nodemailer.Transporter | null = null;
/** The settings the transport was made with: the owner can change them in Settings → Installation → Services. */
let madeWith = "";

function getTransport() {
  if (!config.systemSmtp.host) return null;
  const current = JSON.stringify(config.systemSmtp);
  if (transport && current !== madeWith) {
    transport.close();
    transport = null;
  }
  if (!transport) {
    madeWith = current;
    transport = nodemailer.createTransport({
      host: config.systemSmtp.host,
      port: config.systemSmtp.port,
      secure: config.systemSmtp.port === 465,
      auth: config.systemSmtp.user ? { user: config.systemSmtp.user, pass: config.systemSmtp.pass } : undefined,
    });
  }
  return transport;
}

export interface SystemMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Recently "sent" system mails, so local installs without SMTP can still read links (exposed to superadmins). */
export const systemMailLog: Array<SystemMail & { at: string }> = [];

export async function sendSystemMail(mail: SystemMail): Promise<void> {
  systemMailLog.unshift({ ...mail, at: new Date().toISOString() });
  systemMailLog.length = Math.min(systemMailLog.length, 50);
  const t = getTransport();
  if (!t) {
    console.log(`\n[system mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}\n`);
    return;
  }
  await t.sendMail({
    from: config.systemSmtp.from || config.systemSmtp.user,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html ?? mail.text.replace(/\n/g, "<br/>"),
  });
}

/** The text part of a paragraph written as HTML: line breaks kept, tags dropped, escaped characters restored. */
const plainText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export function systemMailLayout(title: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const brand = config.brandName;
  const text = [title, "", ...paragraphs.map(plainText), ...(cta ? ["", `${cta.label}: ${cta.url}`] : []), "", `— ${brand}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f6f7fb;padding:32px">
<table role="presentation" style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e6e8ef">
<tr><td><div style="font-weight:700;font-size:18px;color:#1b4dff;margin-bottom:16px">${brand}</div>
<h1 style="font-size:20px;margin:0 0 12px;color:#111827">${title}</h1>
${paragraphs.map((p) => `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 12px">${p}</p>`).join("")}
${cta ? `<p style="margin:24px 0"><a href="${cta.url}" style="background:#1b4dff;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${cta.label}</a></p>` : ""}
</td></tr></table></body></html>`;
  return { text, html };
}
