// IMAP/SMTP presets for common providers and auto-detection from MX records.
import { ProviderCode, domainOf } from "@reachstack/shared";
import { resolveMx } from "../lib/dns";

export interface ServerPreset {
  host: string;
  port: number;
  secure: boolean;
}

export interface ProviderPreset {
  key: string;
  name: string;
  providerCode: number;
  imap: ServerPreset;
  smtp: ServerPreset;
  /** Help text shown in the connect wizard (e.g. app password instructions). */
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "google",
    name: "Google Workspace / Gmail",
    providerCode: ProviderCode.GOOGLE,
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 587, secure: false },
    hint: "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords and use it as the password. IMAP must be enabled in Gmail settings.",
  },
  {
    key: "microsoft",
    name: "Microsoft 365 / Outlook",
    providerCode: ProviderCode.MICROSOFT,
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    hint: "Microsoft no longer accepts passwords for reading mail (IMAP) on Outlook.com or Microsoft 365, so this usually fails: connect with Sign in with Microsoft instead (Email accounts → Connect → Microsoft). It also needs SMTP AUTH turned on for the mailbox in the Microsoft 365 admin center.",
  },
  {
    key: "zoho",
    name: "Zoho Mail",
    providerCode: ProviderCode.CUSTOM,
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
  },
  {
    key: "yahoo",
    name: "Yahoo Mail",
    providerCode: ProviderCode.CUSTOM,
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    hint: "Generate an app password in Yahoo account security settings.",
  },
  {
    key: "icloud",
    name: "iCloud Mail",
    providerCode: ProviderCode.CUSTOM,
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  {
    key: "fastmail",
    name: "Fastmail",
    providerCode: ProviderCode.CUSTOM,
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
  },
  {
    key: "godaddy",
    name: "GoDaddy (Microsoft 365)",
    providerCode: ProviderCode.MICROSOFT,
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
  {
    key: "yandex",
    name: "Yandex Mail",
    providerCode: ProviderCode.CUSTOM,
    imap: { host: "imap.yandex.com", port: 993, secure: true },
    smtp: { host: "smtp.yandex.com", port: 465, secure: true },
  },
  {
    key: "aws",
    name: "Amazon WorkMail / SES",
    providerCode: ProviderCode.AWS,
    imap: { host: "imap.mail.us-east-1.awsapps.com", port: 993, secure: true },
    smtp: { host: "email-smtp.us-east-1.amazonaws.com", port: 587, secure: false },
  },
];

/**
 * Whose servers these are: Gmail's make a Google mailbox and Microsoft 365's a Microsoft one, however it was added (a
 * spreadsheet, the API, the "Other" form). Anything else is a custom IMAP/SMTP mailbox.
 */
export function providerForHosts(...hosts: Array<string | null | undefined>): number {
  const all = hosts.map((h) => (h ?? "").trim().toLowerCase().replace(/\.$/, ""));
  const on = (re: RegExp) => all.some((h) => re.test(h));
  if (on(/(^|\.)(gmail|googlemail|google)\.com$/)) return ProviderCode.GOOGLE;
  if (on(/(^|\.)(office365|outlook|hotmail|live)\.com$/)) return ProviderCode.MICROSOFT;
  if (on(/(^|\.)(awsapps|amazonaws)\.com$/)) return ProviderCode.AWS;
  return ProviderCode.CUSTOM;
}

/** Guess the provider for a mailbox address. */
export async function detectProvider(email: string): Promise<ProviderPreset | null> {
  const domain = domainOf(email);
  if (!domain) return null;
  if (domain === "gmail.com" || domain === "googlemail.com") return PROVIDER_PRESETS[0]!;
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) return PROVIDER_PRESETS[1]!;
  if (domain.startsWith("yahoo.")) return PROVIDER_PRESETS.find((p) => p.key === "yahoo")!;
  if (domain === "icloud.com" || domain === "me.com") return PROVIDER_PRESETS.find((p) => p.key === "icloud")!;
  const mx = (await resolveMx(domain)) ?? [];
  const all = mx.join(" ");
  if (/google\.com|googlemail\.com/.test(all)) return PROVIDER_PRESETS[0]!;
  if (/outlook\.com|office365|protection\.outlook/.test(all)) return PROVIDER_PRESETS[1]!;
  if (/zoho\./.test(all)) return PROVIDER_PRESETS.find((p) => p.key === "zoho")!;
  if (/messagingengine\.com/.test(all)) return PROVIDER_PRESETS.find((p) => p.key === "fastmail")!;
  if (/yandex/.test(all)) return PROVIDER_PRESETS.find((p) => p.key === "yandex")!;
  if (/awsapps|amazonaws/.test(all)) return PROVIDER_PRESETS.find((p) => p.key === "aws")!;
  return null;
}
