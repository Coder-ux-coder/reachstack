// The public privacy center behind /privacy/*: opt-outs, data requests and the privacy request form from people in
// the Lead Finder data, abuse reports about sent emails, and the suppression list that keeps those people out of
// the shared data (and, after an abuse report, out of every campaign). Workspace imports are each workspace's own
// data and aren't touched.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { escapeHtml } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { SuppressionReason } from "../db/schema/privacy";
import { config } from "../env";
import { chunk } from "../http/util";
import { handleUnsubscribe } from "./activity";
import { consumeToken, issueToken } from "./auth-tokens";
import { instanceAdminEmails } from "./instance";
import { sendSystemMail, systemMailLayout } from "./system-mail";
import { sentEmailByToken } from "./tracking";

const R = schema.privacyRequests;
const S = schema.privacySuppressions;
const A = schema.abuseReports;
const P = schema.lfPeople;
const C = schema.lfCompanies;
const U = schema.lfUnlocks;

export type RequestType = "opt_out" | "data_request" | "removal";
export type RequestStatus = "pending" | "verified" | "resolved" | "rejected";
export const REQUEST_CHOICES = ["access", "delete", "opt_out", "correct", "other"] as const;
export type RequestChoice = (typeof REQUEST_CHOICES)[number];
export type RequestRow = typeof R.$inferSelect;

/** What a request form collected, plus what happened to it (`details` on privacy_requests). */
export interface RequestDetails {
  first_name: string;
  last_name: string;
  company_name?: string | null;
  linkedin_url?: string | null;
  applicant_type?: "self" | "agent";
  country?: string | null;
  state?: string | null;
  requests?: RequestChoice[];
  message?: string | null;
  /** Profiles found in the Lead Finder data when the request was carried out. */
  matched?: number;
  note?: string | null;
  handled_by?: string | null;
  ip?: string;
  user_agent?: string;
}

export const normEmail = (v: string) => v.trim().toLowerCase();

/** "https://www.linkedin.com/in/Jane-Doe/?trk=1" → "linkedin.com/in/jane-doe"; null for anything that isn't a profile link. */
export function normLinkedin(raw: string | null | undefined): string | null {
  const m = /linkedin\.com\/(in|pub)\/([^/?#\s]+)/i.exec(raw ?? "");
  if (!m) return null;
  let slug = m[2]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Keep the slug as written.
  }
  return `linkedin.com/${m[1]!.toLowerCase()}/${slug.toLowerCase()}`;
}

const brand = () => escapeHtml(config.brandName);
const formatDate = (d: Date | number | null | undefined) => (d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "unknown date");

// ---------- Suppression list ----------

/** Which of these values are suppressed. With sendingOnly, only those no campaign may email. */
export async function suppressedValues(type: "email" | "linkedin", values: Array<string | null | undefined>, sendingOnly = false): Promise<Set<string>> {
  const list = [...new Set(values.filter((v): v is string => !!v))];
  const out = new Set<string>();
  for (const part of chunk(list, 500)) {
    const rows = await db
      .select({ value: S.value })
      .from(S)
      .where(and(eq(S.type, type), inArray(S.value, part), sendingOnly ? eq(S.blockSending, true) : undefined));
    for (const r of rows) out.add(r.value);
  }
  return out;
}

/** True when no campaign on this installation may email the address (it reported one of our emails as abuse). */
export async function sendingBlocked(email: string): Promise<boolean> {
  return (await suppressedValues("email", [normEmail(email)], true)).size > 0;
}

export async function suppress(
  who: { email?: string | null; linkedin?: string | null },
  reason: SuppressionReason,
  opts: { blockSending?: boolean; requestId?: string | null; abuseReportId?: string | null } = {},
) {
  const li = normLinkedin(who.linkedin);
  const rows = [...(who.email ? [{ type: "email", value: normEmail(who.email) }] : []), ...(li ? [{ type: "linkedin", value: li }] : [])];
  for (const r of rows) {
    const insert = db.insert(S).values({ ...r, reason, blockSending: !!opts.blockSending, requestId: opts.requestId ?? null, abuseReportId: opts.abuseReportId ?? null });
    // An abuse report tightens an existing entry: from then on no campaign may email the address either.
    if (opts.blockSending) await insert.onConflictDoUpdate({ target: [S.type, S.value], set: { blockSending: true, reason, abuseReportId: opts.abuseReportId ?? null } });
    else await insert.onConflictDoNothing();
  }
}

// ---------- The person's profiles in the shared Lead Finder data ----------

/** Shared profiles with this email address or LinkedIn profile, with their companies. */
async function sharedProfiles(email: string, linkedin?: string | null) {
  const li = normLinkedin(linkedin);
  const conds = [eq(P.email, normEmail(email))];
  if (li) conds.push(sql`instr(lower(coalesce(${P.linkedinUrl}, '')), ${li.split("/").pop()!}) > 0`);
  const rows = await db
    .select({ p: P, c: C })
    .from(P)
    .leftJoin(C, eq(C.id, P.companyId))
    .where(and(isNull(P.workspaceId), or(...conds)));
  // instr() only narrows the search: keep exact profile matches.
  return rows.filter((r) => (r.p.email && normEmail(r.p.email) === normEmail(email)) || (li && normLinkedin(r.p.linkedinUrl) === li));
}

/** Deletes a person's shared Lead Finder profiles (and the records of who revealed them) and keeps them out from now on. */
export async function removeFromDataset(input: { email: string; linkedin?: string | null; reason: SuppressionReason; requestId?: string | null; blockSending?: boolean; abuseReportId?: string | null }): Promise<number> {
  const found = await sharedProfiles(input.email, input.linkedin);
  const ids = found.map((r) => r.p.id);
  for (const part of chunk(ids, 500)) {
    await db.delete(U).where(inArray(U.personId, part));
    await db.delete(P).where(inArray(P.id, part));
  }
  const opts = { requestId: input.requestId, blockSending: input.blockSending, abuseReportId: input.abuseReportId };
  await suppress({ email: input.email, linkedin: input.linkedin }, input.reason, opts);
  // Profiles found by email also keep their LinkedIn profile out.
  for (const r of found) if (r.p.linkedinUrl) await suppress({ linkedin: r.p.linkedinUrl }, input.reason, opts);
  return ids.length;
}

/**
 * Emails the person what the shared data holds about them: the profiles under the address the report goes to. A
 * LinkedIn link given on the form can remove a profile, but never shows one (owning the inbox doesn't prove the
 * profile is theirs, and a report would hand out someone else's details). Returns how many profiles were found.
 */
export async function sendDataReport(email: string, linkedin?: string | null, removing = false): Promise<number> {
  const found = await sharedProfiles(email);
  const ids = found.map((r) => r.p.id);
  const reveals = ids.length
    ? await db
        .select({ personId: U.personId, n: sql<number>`count(*)`, last: sql<number>`max(${U.createdAt})` })
        .from(U)
        .where(inArray(U.personId, ids))
        .groupBy(U.personId)
    : [];
  const revealsOf = new Map(reveals.map((r) => [r.personId, r]));
  const [suppressed] = await db
    .select()
    .from(S)
    .where(and(eq(S.type, "email"), eq(S.value, normEmail(email))))
    .limit(1);

  const paragraphs: string[] = [];
  const text: string[] = [];
  if (!found.length) {
    paragraphs.push(`We searched the Lead Finder data on ${brand()} and found no profile for <b>${escapeHtml(normEmail(email))}</b>.`);
    text.push(`We searched the Lead Finder data on ${config.brandName} and found no profile for ${normEmail(email)}.`);
  } else {
    paragraphs.push(`Here is everything the Lead Finder data on ${brand()} holds about you (${found.length === 1 ? "one profile" : `${found.length} profiles`}).`);
    text.push(`Here is everything the Lead Finder data on ${config.brandName} holds about you (${found.length === 1 ? "one profile" : `${found.length} profiles`}).`);
    for (const { p, c } of found) {
      const fields: Array<[string, string | null | undefined]> = [
        ["Name", p.fullName ?? [p.firstName, p.lastName].filter(Boolean).join(" ")],
        ["Job title", p.title],
        ["Seniority", p.seniority],
        ["Department", p.department],
        ["Work email", p.email ? `${p.email}${p.emailStatus ? ` (${p.emailStatus})` : ""}` : null],
        ["Phone", p.phone],
        ["LinkedIn", p.linkedinUrl],
        ["Location", [p.city, p.state, p.country].filter(Boolean).join(", ")],
        ["Company", c ? [c.name, c.domain].filter(Boolean).join(" · ") : null],
        ["Company details", c ? [c.industry, c.employeeCount ? `${c.employeeCount} employees` : null, [c.city, c.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : null],
      ];
      const shown = fields.filter(([, v]) => v);
      const seen = revealsOf.get(p.id);
      const source = `Source: a data file the administrator of ${config.brandName} imported on ${formatDate(p.createdAt)}.`;
      const use = seen
        ? `Shared with: ${seen.n === 1 ? "one workspace" : `${seen.n} workspaces`} on ${config.brandName} revealed this profile to contact you, most recently on ${formatDate(seen.last)}.`
        : `Shared with: no workspace on ${config.brandName} has revealed this profile.`;
      paragraphs.push(`${shown.map(([k, v]) => `<b>${k}:</b> ${escapeHtml(String(v))}`).join("<br/>")}<br/><br/>${escapeHtml(source)}<br/>${escapeHtml(use)}`);
      text.push("", ...shown.map(([k, v]) => `${k}: ${v}`), source, use);
    }
    const why = `Why we hold it: users of ${config.brandName} search this data to find business contacts, then add the people they choose to their lists and campaigns.`;
    paragraphs.push(escapeHtml(why));
    text.push("", why);
  }
  if (linkedin) {
    const only = "This report shows the profiles under the address it was sent to. To see a profile kept under another address, send the request from that address.";
    paragraphs.push(escapeHtml(only));
    text.push("", only);
  }
  if (removing) {
    paragraphs.push("As you asked, we're removing it now and keeping your address out of the data from now on.");
    text.push("As you asked, we're removing it now and keeping your address out of the data from now on.");
  } else if (suppressed) {
    const line = `Your address has been on our do-not-add list since ${formatDate(suppressed.createdAt)}, so it won't be added again.`;
    paragraphs.push(escapeHtml(line));
    text.push(line);
  }
  const theirs = `Companies that use ${config.brandName} may also keep your details in their own lists and campaigns. To see or remove those, ask the company that contacted you.`;
  paragraphs.push(escapeHtml(theirs));
  text.push("", theirs);
  const optOut = `${config.webUrl}/privacy/opt-out`;
  if (!removing) text.push("", `To have your profile removed: ${optOut}`);
  const m = systemMailLayout("The data we hold about you", paragraphs, removing ? undefined : { label: "Remove my profile", url: optOut });
  await sendSystemMail({ to: normEmail(email), subject: `Your data report from ${config.brandName}`, text: ["The data we hold about you", "", ...text, "", `— ${config.brandName}`].join("\n"), html: m.html });
  return found.length;
}

// ---------- Requests ----------

/** Where the confirmation link lands (opt-outs need none: they only ever remove data). */
const CONFIRM_PATH: Record<RequestType, string> = { opt_out: "/privacy/opt-out/confirm", data_request: "/privacy/data-request/confirm", removal: "/privacy/manager" };

export async function createRequest(type: RequestType, details: RequestDetails & { email: string }, status: RequestStatus): Promise<RequestRow> {
  const { email, ...rest } = details;
  const [row] = await db
    .insert(R)
    .values({ type, email: normEmail(email), name: `${rest.first_name} ${rest.last_name}`.trim(), details: rest as unknown as Record<string, unknown>, status, resolvedAt: status === "resolved" ? new Date() : null })
    .returning();
  return row!;
}

const ASK_TEXT: Record<RequestChoice, string> = {
  access: "send you a copy of your data",
  delete: "delete your data",
  opt_out: "stop using or sharing your data",
  correct: "correct your data",
  other: "answer a question about your data",
};

/** "a, b and c" */
const listOf = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? ""));

/** Sends the link that proves the person owns the address (for a request made on their behalf: that they agree). */
export async function sendConfirmation(row: RequestRow) {
  const token = await issueToken("privacy_verify", { email: row.email, data: { request_id: row.id }, ttlMs: 7 * 86_400_000 });
  const url = `${config.webUrl}${CONFIRM_PATH[row.type as RequestType]}?token=${encodeURIComponent(token)}`;
  const details = (row.details ?? {}) as unknown as RequestDetails;
  const asks = listOf((row.type === "data_request" ? ["access" as const] : (details.requests ?? [])).map((c) => ASK_TEXT[c]));
  const agent = details.applicant_type === "agent";
  const m = systemMailLayout(
    "Confirm your privacy request",
    agent
      ? [
          `Someone acting for you asked ${brand()} to ${asks}.`,
          "If you agree, confirm with the button below. The link works for 7 days.",
          "If you didn't ask anyone to do this, ignore this email and nothing will happen.",
        ]
      : [`Someone, hopefully you, asked ${brand()} to ${asks}.`, "Confirm it was you with the button below. The link works for 7 days.", "If you didn't ask for this, ignore this email and nothing will happen."],
    { label: agent ? "I agree, go ahead" : "Confirm my request", url },
  );
  await sendSystemMail({ to: row.email, subject: `Confirm your privacy request to ${config.brandName}`, ...m });
}

export async function optOut(details: RequestDetails & { email: string }) {
  const row = await createRequest("opt_out", details, "resolved");
  const matched = await removeFromDataset({ email: row.email, linkedin: details.linkedin_url, reason: "opt_out", requestId: row.id });
  await db
    .update(R)
    .set({ details: { ...(row.details ?? {}), matched } })
    .where(eq(R.id, row.id));
  // The outcome goes to the address itself, so the form never tells anyone else whether we held a profile.
  const m = systemMailLayout(
    matched ? "We removed your profile" : "You're opted out",
    matched
      ? [`We removed your profile from the Lead Finder data on ${brand()}, and your address is on our do-not-add list, so it won't come back.`, "Companies that already added you to their own lists keep their copy. Ask them directly to remove it."]
      : [`We found no profile for this address in the Lead Finder data on ${brand()}. We've added it to our do-not-add list, so it won't be added later.`],
  );
  await sendSystemMail({ to: row.email, subject: matched ? `Your profile was removed from ${config.brandName}` : `You're opted out of ${config.brandName}`, ...m });
}

export interface ConfirmOutcome {
  type: RequestType;
  status: RequestStatus;
  /** Parts of the request already carried out. */
  done: RequestChoice[];
  /** Parts waiting for the administrator. */
  waiting: RequestChoice[];
}

/** Handles the link from the confirmation email. Null when the link is invalid, used or expired. */
export async function confirmRequest(token: string): Promise<ConfirmOutcome | null> {
  const t = await consumeToken("privacy_verify", token);
  const id = t?.data?.request_id;
  const [row] = id ? await db.select().from(R).where(eq(R.id, String(id))).limit(1) : [];
  if (!row) return null;
  const type = row.type as RequestType;
  const details = (row.details ?? {}) as unknown as RequestDetails;
  if (row.status !== "pending") return { type, status: row.status as RequestStatus, done: [], waiting: [] };
  const asked: RequestChoice[] = type === "data_request" ? ["access"] : (details.requests ?? []);
  const removing = asked.includes("delete") || asked.includes("opt_out");
  const done: RequestChoice[] = [];
  let matched = details.matched;
  // The report comes first, so it shows what we held before a removal in the same request.
  if (asked.includes("access")) {
    matched = await sendDataReport(row.email, details.linkedin_url, removing);
    done.push("access");
  }
  if (removing) {
    matched = await removeFromDataset({ email: row.email, linkedin: details.linkedin_url, reason: asked.includes("delete") ? "removal" : "opt_out", requestId: row.id });
    done.push(...asked.filter((a) => a === "delete" || a === "opt_out"));
  }
  const waiting = asked.filter((a) => a === "correct" || a === "other");
  const status: RequestStatus = waiting.length ? "verified" : "resolved";
  const now = new Date();
  await db
    .update(R)
    .set({ status, verifiedAt: now, resolvedAt: status === "resolved" ? now : null, details: { ...(row.details ?? {}), ...(matched !== undefined ? { matched } : {}) } })
    .where(eq(R.id, row.id));
  // A data report already says the profile is being removed; otherwise confirm the removal on its own.
  if (removing && !asked.includes("access")) {
    const m = systemMailLayout(matched ? "We removed your profile" : "You're opted out", [
      matched
        ? `We removed your profile from the Lead Finder data on ${brand()}, and your address is on our do-not-add list, so it won't come back.`
        : `We found no profile for this address in the Lead Finder data on ${brand()}. We've added it to our do-not-add list, so it won't be added later.`,
    ]);
    await sendSystemMail({ to: row.email, subject: `Your privacy request to ${config.brandName}`, ...m });
  }
  if (waiting.length) {
    const asks = waiting.map((w) => (w === "correct" ? "correct their data" : "answer a question")).join(" and ");
    await notifyAdmins("A privacy request needs you", [`<b>${escapeHtml(row.name ?? row.email)}</b> (${escapeHtml(row.email)}) confirmed a privacy request that asks you to ${asks}.`]);
  }
  return { type, status, done, waiting };
}

async function notifyAdmins(title: string, paragraphs: string[]) {
  const m = systemMailLayout(title, paragraphs, { label: "Open the privacy center", url: `${config.webUrl}/app/settings/privacy` });
  for (const to of await instanceAdminEmails()) await sendSystemMail({ to, subject: title, ...m });
}

export function serializeRequest(r: RequestRow) {
  const d = (r.details ?? {}) as unknown as RequestDetails;
  return {
    id: r.id,
    type: r.type as RequestType,
    status: r.status as RequestStatus,
    email: r.email,
    name: r.name,
    company_name: d.company_name ?? null,
    linkedin_url: d.linkedin_url ?? null,
    applicant_type: d.applicant_type ?? null,
    country: d.country ?? null,
    state: d.state ?? null,
    requests: d.requests ?? (r.type === "data_request" ? ["access"] : r.type === "opt_out" ? ["opt_out"] : []),
    message: d.message ?? null,
    matched: d.matched ?? null,
    note: d.note ?? null,
    created_at: r.createdAt.toISOString(),
    verified_at: r.verifiedAt?.toISOString() ?? null,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
  };
}

// ---------- Abuse reports ----------

export type AbuseCheck = "valid" | "reported" | "invalid";

/** Whether a report ID (from the X-Report-Abuse link of a sent email) can be reported. */
export async function abuseStatus(token: string): Promise<AbuseCheck> {
  const email = await sentEmailByToken(token);
  if (!email?.leadEmail) return "invalid";
  const [prev] = await db.select({ id: A.id }).from(A).where(eq(A.emailId, email.id)).limit(1);
  return prev ? "reported" : "valid";
}

/**
 * Records the report, unsubscribes the person, and keeps every campaign on this installation from emailing them
 * again. "reported" means this call filed it; "already" that the email had been reported before.
 */
export async function reportAbuse(token: string, meta: { ip: string; userAgent: string }): Promise<"reported" | "already" | "invalid"> {
  const email = await sentEmailByToken(token);
  if (!email?.leadEmail) return "invalid";
  const [report] = await db
    .insert(A)
    .values({
      emailId: email.id,
      workspaceId: email.workspaceId,
      campaignId: email.campaignId,
      accountEmail: email.eaccount,
      leadEmail: normEmail(email.leadEmail),
      subject: email.subject.slice(0, 300),
      ip: meta.ip.slice(0, 64),
      userAgent: meta.userAgent.slice(0, 400),
    })
    .onConflictDoNothing()
    .returning({ id: A.id });
  if (!report) return "already";
  await handleUnsubscribe({ workspaceId: email.workspaceId, email: email.leadEmail, campaignId: email.campaignId, subsequenceId: email.subsequenceId, source: "abuse", leadId: email.leadId });
  await removeFromDataset({ email: email.leadEmail, reason: "abuse", blockSending: true, abuseReportId: report.id });

  const [ws] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, email.workspaceId)).limit(1);
  const who = escapeHtml(normEmail(email.leadEmail));
  const from = escapeHtml(email.eaccount);
  const subject = escapeHtml(email.subject || "(no subject)");
  const members = await db
    .select({ email: schema.workspaceMembers.email })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, email.workspaceId), eq(schema.workspaceMembers.accepted, true), inArray(schema.workspaceMembers.role, ["owner", "admin"])));
  const m = systemMailLayout(
    "One of your emails was reported as unwanted",
    [`${who} reported “${subject}”, sent from ${from}, as unwanted outreach.`, `They're unsubscribed, and no campaign on ${brand()} will email them again. Reports like this hurt the reputation of your sending accounts, so check who your campaigns reach and how often.`],
    email.campaignId ? { label: "Open the campaign", url: `${config.webUrl}/app/campaign/${email.campaignId}/analytics` } : undefined,
  );
  for (const to of new Set(members.map((r) => r.email.toLowerCase()))) await sendSystemMail({ to, subject: `An email from ${email.eaccount} was reported as unwanted`, ...m });
  await notifyAdmins("New abuse report", [`${who} reported “${subject}”, sent from ${from} in the <b>${escapeHtml(ws?.name ?? "unknown")}</b> workspace.`]);
  return "reported";
}
