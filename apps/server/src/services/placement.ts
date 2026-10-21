// Inbox placement tests: send a test email from your accounts to seed mailboxes, then read each seed to see
// whether it landed in the inbox, a category tab or spam. Seeds are connected mailboxes (accounts flagged as
// seeds) or simulated sandbox seeds for demo/test installs. Each run also produces blocklist + content reports.
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { AccountStatus, INBOX_PLACEMENT, domainOf, renderTemplate } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { badRequest, conflict } from "../http/errors";
import { zWhen } from "../http/util";
import { checkDomainAuth, checkDomainBlocklists, checkIpBlocklists, resolveA, resolveMx } from "../lib/dns";
import { uuidv7 } from "../lib/ids";
import { publicFetch } from "../lib/net";
import { heuristicSpamScore, spamScore, type SpamReport } from "../lib/spam-score";
import { iso, isValidZone } from "../lib/time";
import { buildRaw, newMessageId } from "../mail/compose";
import { driverFor, isSandbox, type AccountRow } from "../mail/driver";
import { parseInbound } from "../mail/parse";
import { templateVars } from "../engine/sender";
import { errorState } from "./accounts";
import { inUse } from "./live-workspaces";
import { resourcesWithTags } from "./tags";
import { workspaceZone } from "./workspace-clock";

const T = schema.inboxPlacementTests;
const R = schema.inboxPlacementResults;
const REP = schema.inboxPlacementReports;
const SEEDS = schema.placementSeeds;

export type PlacementTestRow = typeof T.$inferSelect;
export type SeedRow = typeof SEEDS.$inferSelect;

export const ESP_NAMES: Record<number, string> = { 1: "Google", 2: "Microsoft", 8: "AirMail", 12: "Web.de", 13: "Libero.it" };
export const GEO_NAMES: Record<number, string> = { 1: "United States", 2: "Italy", 3: "Germany", 4: "France" };
const SEED_FOLDERS = ["INBOX", "Junk", "Spam", "[Gmail]/Spam", "Junk Email", "Bulk Mail"];
const MISSING_AFTER_MS = 30 * 60_000;
/** A real seed mailbox is searched for tests sent from other tools at most this often (each search signs in to it). */
const EXTERNAL_SCAN_MS = 2 * 60_000;
/** A run counts as still sending this long at most: one cut short by a restart doesn't hold its results back for good. */
const SENDING_MAX_MS = 2 * 3_600_000;

/** Simulated seed network for sandbox installs (no real mail leaves the server). */
const SANDBOX_SEEDS: Array<Omit<typeof SEEDS.$inferInsert, "id" | "createdAt">> = [
  { email: "seed.google.us.pro@gworkspace.seed.test", region: "North America", subRegion: "US", type: "Professional", esp: 1, geo: 1 },
  { email: "seed.google.us.personal@gmail.seed.test", region: "North America", subRegion: "US", type: "Personal", esp: 1, geo: 1 },
  { email: "seed.outlook.us.pro@m365.seed.test", region: "North America", subRegion: "US", type: "Professional", esp: 2, geo: 1 },
  { email: "seed.outlook.us.personal@outlook.seed.test", region: "North America", subRegion: "US", type: "Personal", esp: 2, geo: 1 },
  { email: "seed.airmail.us@airmail.seed.test", region: "North America", subRegion: "US", type: "Professional", esp: 8, geo: 1 },
  { email: "seed.google.fr.pro@gworkspace-fr.seed.test", region: "Europe", subRegion: "France", type: "Professional", esp: 1, geo: 4 },
  { email: "seed.outlook.de.pro@m365-de.seed.test", region: "Europe", subRegion: "Germany", type: "Professional", esp: 2, geo: 3 },
  { email: "seed.webde.de@webde.seed.test", region: "Europe", subRegion: "Germany", type: "Personal", esp: 12, geo: 3 },
  { email: "seed.libero.it@libero.seed.test", region: "Europe", subRegion: "Italy", type: "Personal", esp: 13, geo: 2 },
];

export async function ensureSandboxSeeds() {
  await db
    .insert(SEEDS)
    .values(SANDBOX_SEEDS.map((s) => ({ ...s, accountId: null })))
    .onConflictDoNothing();
}

export function serializeSeed(s: SeedRow) {
  return {
    id: s.id,
    email: s.email,
    account_id: s.accountId,
    simulated: !s.accountId,
    region: s.region,
    sub_region: s.subRegion,
    type: s.type,
    esp: ESP_NAMES[s.esp] ?? String(s.esp),
    esp_code: s.esp,
    geo: s.geo,
    active: s.active,
  };
}

export async function espOptions() {
  await ensureSandboxSeeds();
  const seeds = await db.select().from(SEEDS).where(eq(SEEDS.active, true));
  const seen = new Map<string, { region: string; sub_region: string; type: string; esp: string }>();
  for (const s of seeds) {
    const o = { region: s.region, sub_region: s.subRegion, type: s.type, esp: ESP_NAMES[s.esp] ?? String(s.esp) };
    seen.set(JSON.stringify(o), o);
  }
  return [...seen.values()];
}

// ---------- Validation / serialization ----------

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const automationSchema = z.object({
  when: z.object({
    condition: z.enum(["placement_goes_below", "placement_goes_above", "added_to_blacklists", "removed_from_blacklists"]),
    condition_value: z.number().nullable().optional(),
  }),
  then: z.object({
    webhook_url: z.string().url().optional(),
    pause_sending_campaigns_for: z.number().int().min(1).max(365).optional(),
    pause: z.boolean().optional(),
    enable_slow_ramp: z.boolean().optional(),
    disable_slow_ramp: z.boolean().optional(),
    add_tags: z.array(z.string()).optional(),
  }),
});
const labelSchema = z.object({ region: z.string(), sub_region: z.string(), type: z.string(), esp: z.string() });
export const testFieldsSchema = z.object({
  name: z.string().trim().min(1).max(250),
  delivery_mode: z.union([z.literal(1), z.literal(2)]).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  schedule: z.object({ days: z.record(z.boolean()), timing: z.object({ from: hm }), timezone: z.string().refine(isValidZone, "Unknown timezone") }).optional(),
  type: z.union([z.literal(1), z.literal(2)]),
  sending_method: z.union([z.literal(1), z.literal(2)]),
  campaign_id: z.string().nullable().optional(),
  email_subject: z.string().max(998),
  email_body: z.string().max(200_000),
  emails: z.array(z.string()),
  test_code: z
    .string()
    .regex(/^ptid_[A-Za-z0-9_-]{8,64}$/, "Use ptid_ followed by 8 to 64 letters, numbers, hyphens or underscores")
    .nullable()
    .optional(),
  tags: z.array(z.string()).nullable().optional(),
  text_only: z.boolean().nullable().optional(),
  recipients_labels: z.array(labelSchema).optional(),
  timestamp_next_run: zWhen.nullable().optional(),
  automations: z.array(automationSchema).nullable().optional(),
  status: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
  not_sending_status: z.enum(["daily_limits_hit", "other"]).nullable().optional(),
  run_immediately: z.boolean().optional(),
});

/** A code for a test sent from another tool: long and random, so no two tests (of any workspace) share one. */
export const newTestCode = () => `ptid_${randomBytes(9).toString("base64url")}`;

/** A code someone chose is refused when another test already has it: the seeds are searched by code. */
export async function assertTestCodeFree(code: string, testId?: string) {
  const [taken] = await db
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.testCode, code), ...(testId ? [ne(T.id, testId)] : [])))
    .limit(1);
  if (taken) throw conflict("Another test already uses this test code. Leave it empty to get a new one.");
}

/** The seeds a test sends to: tests sent from another tool can only reach real ones. */
export async function testRecipients(labels: PlacementTestRow["recipientsLabels"], sendingMethod: number): Promise<SeedRow[]> {
  const seeds = await seedsForLabels(labels);
  if (sendingMethod !== INBOX_PLACEMENT.SENDING_EXTERNAL) {
    if (!seeds.length) throw badRequest("None of the chosen seed groups has an active seed inbox");
    return seeds;
  }
  const real = seeds.filter((s) => s.accountId);
  if (!real.length) {
    throw badRequest("Tests sent from another tool need real seed inboxes, and the chosen groups only have simulated ones. Connect real seed mailboxes from Seed inboxes first.");
  }
  return real;
}

export function testColumns(b: Partial<z.infer<typeof testFieldsSchema>>): Partial<typeof T.$inferInsert> {
  const o: Partial<typeof T.$inferInsert> = {};
  if (b.name !== undefined) o.name = b.name;
  if (b.delivery_mode !== undefined) o.deliveryMode = b.delivery_mode;
  if (b.description !== undefined) o.description = b.description;
  if (b.schedule !== undefined) o.schedule = b.schedule;
  if (b.type !== undefined) o.type = b.type;
  if (b.sending_method !== undefined) o.sendingMethod = b.sending_method;
  if (b.campaign_id !== undefined) o.campaignId = b.campaign_id;
  if (b.email_subject !== undefined) o.emailSubject = b.email_subject;
  if (b.email_body !== undefined) o.emailBody = b.email_body;
  if (b.emails !== undefined) o.emails = [...new Set(b.emails.map((e) => e.trim().toLowerCase()))];
  if (b.test_code !== undefined) o.testCode = b.test_code;
  if (b.tags !== undefined) o.tags = b.tags;
  if (b.text_only !== undefined) o.textOnly = b.text_only;
  if (b.recipients_labels !== undefined) o.recipientsLabels = b.recipients_labels;
  if (b.timestamp_next_run !== undefined) o.nextRunAt = b.timestamp_next_run ? new Date(b.timestamp_next_run) : null;
  if (b.automations !== undefined) o.automations = b.automations;
  if (b.status !== undefined && b.status !== null) o.status = b.status;
  if (b.not_sending_status !== undefined) o.notSendingStatus = b.not_sending_status;
  return o;
}

export function serializeTest(t: PlacementTestRow, metadata?: Record<string, unknown>) {
  return {
    id: t.id,
    organization_id: t.workspaceId,
    name: t.name,
    delivery_mode: t.deliveryMode,
    description: t.description,
    schedule: t.schedule,
    type: t.type,
    sending_method: t.sendingMethod,
    campaign_id: t.campaignId,
    email_subject: t.emailSubject,
    email_body: t.emailBody,
    emails: t.emails,
    test_code: t.testCode,
    tags: t.tags,
    text_only: t.textOnly,
    recipients: t.recipients,
    recipients_labels: t.recipientsLabels,
    timestamp_created: iso(t.createdAt),
    timestamp_next_run: iso(t.nextRunAt),
    automations: t.automations,
    status: t.status,
    not_sending_status: t.notSendingStatus ?? "",
    // Extensions for the web app.
    timestamp_last_run: iso(t.lastRunAt),
    run_count: t.runCount,
    ...(metadata ? { metadata } : {}),
  };
}

/** The day something happened, on the workspace's clock. */
const dayIn = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toISODate();

export function serializeResult(r: typeof R.$inferSelect, zone = "UTC") {
  const received = r.recordType === 2;
  return {
    id: r.id,
    timestamp_created: iso(r.createdAt),
    timestamp_created_date: dayIn(r.createdAt, zone),
    test_id: r.testId,
    run_id: r.runId,
    is_spam: received ? r.isSpam : null,
    has_category: received ? r.hasCategory : null,
    sender_email: r.senderEmail,
    sender_esp: received ? r.senderEsp : null,
    recipient_email: r.recipientEmail,
    recipient_esp: r.recipientEsp,
    recipient_geo: r.recipientGeo,
    recipient_type: r.recipientType,
    spf_pass: received ? r.spfPass : null,
    dkim_pass: received ? r.dkimPass : null,
    dmarc_pass: received ? r.dmarcPass : null,
    smtp_ip_blacklist_report: received ? r.smtpIpBlacklistReport : null,
    authentication_failure_results: received ? r.authenticationFailureResults : null,
    record_type: r.recordType,
    folder: r.folder,
  };
}

export function serializeReport(r: typeof REP.$inferSelect, opts: { skipSpam?: boolean; skipBlacklist?: boolean; zone?: string } = {}) {
  return {
    id: r.id,
    timestamp_created: iso(r.createdAt),
    timestamp_created_date: dayIn(r.createdAt, opts.zone ?? "UTC"),
    organization_id: r.workspaceId,
    test_id: r.testId,
    domain: r.domain,
    domain_ip: r.domainIp,
    domain_blacklist_count: r.domainBlacklistCount,
    domain_ip_blacklist_count: r.domainIpBlacklistCount,
    spam_assassin_score: r.spamAssassinScore,
    ...(opts.skipSpam ? {} : { spam_assassin_report: r.spamAssassinReport }),
    ...(opts.skipBlacklist ? {} : { blacklist_report: r.blacklistReport }),
    auth_report: r.authReport,
  };
}

// ---------- Scheduling ----------

/** Next scheduled run after `after` for an automated test (days 0=Sunday, timing.from HH:mm in the test timezone). */
export function nextRunAt(schedule: PlacementTestRow["schedule"], after = Date.now()): Date | null {
  if (!schedule) return null;
  const zone = isValidZone(schedule.timezone) ? schedule.timezone : "UTC";
  const [h, m] = schedule.timing.from.split(":").map(Number);
  let day = DateTime.fromMillis(after).setZone(zone).startOf("day");
  for (let i = 0; i < 8; i++) {
    const candidate = day.set({ hour: h!, minute: m! });
    if (schedule.days[String(candidate.weekday % 7)] && candidate.toMillis() > after) return candidate.toJSDate();
    day = day.plus({ days: 1 });
  }
  return null;
}

// ---------- Running a test ----------

async function testSenders(t: PlacementTestRow): Promise<AccountRow[]> {
  const ids = t.tags?.length ? await resourcesWithTags(t.workspaceId, t.tags, "any") : [];
  const emails = t.emails ?? [];
  if (!emails.length && !ids.length) return [];
  const rows = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, t.workspaceId));
  return rows.filter((a) => (emails.includes(a.email) || ids.includes(a.id)) && a.status === AccountStatus.ACTIVE);
}

/** Active seeds matching a test's recipient labels (all active seeds when no labels are set). */
export async function seedsForLabels(labels: PlacementTestRow["recipientsLabels"]): Promise<SeedRow[]> {
  await ensureSandboxSeeds();
  const active = await db.select().from(SEEDS).where(eq(SEEDS.active, true));
  // A real seed whose mailbox was removed, or can't be signed in to for reading, can't say where an email landed, so
  // nothing is sent to it.
  const linked = active.map((s) => s.accountId).filter((id): id is string => !!id);
  const boxes = linked.length
    ? await db
        .select({ id: schema.emailAccounts.id, status: schema.emailAccounts.status, statusMessage: schema.emailAccounts.statusMessage })
        .from(schema.emailAccounts)
        .where(inArray(schema.emailAccounts.id, linked))
    : [];
  const unreadable = (a: (typeof boxes)[number]) => a.status === AccountStatus.CONNECTION_ERROR && (errorState(a.statusMessage)?.sides?.imap ?? !errorState(a.statusMessage)?.sides);
  const alive = new Set(boxes.filter((a) => !unreadable(a)).map((a) => a.id));
  const seeds = active.filter((s) => !s.accountId || alive.has(s.accountId));
  if (!labels?.length) return seeds;
  return seeds.filter((s) => labels.some((l) => l.region === s.region && l.sub_region === s.subRegion && l.type === s.type && l.esp === (ESP_NAMES[s.esp] ?? "")));
}

const testSeeds = (t: PlacementTestRow) => seedsForLabels(t.recipientsLabels);

function senderEsp(a: AccountRow): number | null {
  if (a.providerCode === 2) return 1;
  if (a.providerCode === 3) return 2;
  if (a.providerCode === 8 || a.providerCode === 11) return 8;
  return null;
}

/** Simulated placement odds for sandbox seeds: provider strictness, sender warm-up and content all matter. */
function simulatedChances(seed: SeedRow, sender: AccountRow, content: SpamReport, html: string) {
  const strictness: Record<number, number> = { 1: 0.05, 2: 0.08, 8: 0.04, 12: 0.06, 13: 0.05 };
  const warm = sender.warmupScore ?? (sender.warmupStatus === 1 ? 70 : 35);
  const spam =
    (strictness[seed.esp] ?? 0.05) +
    (Math.max(0, 100 - warm) / 100) * 0.35 +
    Math.min(0.6, (content.spam_score / 10) * 0.6) +
    (seed.type === "Personal" ? 0.03 : 0);
  const links = (html.match(/<a\b/gi) ?? []).length;
  const images = (html.match(/<img\b/gi) ?? []).length;
  const category = seed.esp === 1 ? Math.min(0.8, 0.1 + links * 0.12 + (images ? 0.2 : 0)) : 0;
  return { spamChance: Math.min(0.95, spam), categoryChance: category };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunStart {
  run_id: string;
  /** Emails the run is sending. */
  sending: number;
  /** Sender and seed pairs that can't reach each other (sandbox mailboxes only reach simulated seeds). */
  skipped: number;
  message?: string;
  /** Settles once every email of the run went out (or failed). */
  finished: Promise<void>;
}

/**
 * Starts one run of a test; its emails go out in the background. A test sends one run at a time, and a run's results
 * are only added up once it has sent everything.
 */
export async function runTest(testId: string): Promise<RunStart> {
  const [t] = await db.select().from(T).where(eq(T.id, testId));
  if (!t) throw badRequest("Inbox placement test not found");
  const nothing = Promise.resolve();
  if (t.sendingMethod === INBOX_PLACEMENT.SENDING_EXTERNAL) {
    return { run_id: "", sending: 0, skipped: 0, message: "This test is sent from outside the app. Send your email to the seed list with the test code in the body.", finished: nothing };
  }
  const runId = uuidv7();
  const now = new Date();
  const [claimed] = await db
    .update(T)
    .set({ sendingRunId: runId, sendingSince: now })
    .where(and(eq(T.id, t.id), or(isNull(T.sendingRunId), lt(T.sendingSince, new Date(now.getTime() - SENDING_MAX_MS)))))
    .returning();
  if (!claimed) throw conflict("This test is sending a run right now. Its results come in over the next few minutes.");
  const senders = await testSenders(t);
  const seeds = await testSeeds(t);
  const pairs: Array<{ sender: AccountRow; seed: SeedRow }> = [];
  let skipped = 0;
  for (const sender of senders) {
    for (const seed of seeds) {
      // Simulated seeds only exist inside this install, so only sandbox senders can reach them (and vice versa).
      if (isSandbox(sender) !== !seed.accountId) skipped++;
      else pairs.push({ sender, seed });
    }
  }
  const message = !senders.length
    ? "No active sending accounts were selected"
    : !pairs.length
      ? "None of the seeds can be reached from these mailboxes: sandbox mailboxes only reach simulated seeds, and connected mailboxes only real ones."
      : undefined;
  await db
    .update(T)
    .set({
      lastRunAt: now,
      runCount: t.runCount + 1,
      nextRunAt: t.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? nextRunAt(t.schedule) : null,
      recipients: [...new Set([...(t.recipients ?? []), ...seeds.map((s) => s.email)])],
      notSendingStatus: pairs.length ? null : "other",
      // With nothing to send, the run is over before it began (and so is a one-time test).
      ...(pairs.length ? {} : { sendingRunId: null, sendingSince: null }),
      ...(!pairs.length && t.type === INBOX_PLACEMENT.TYPE_ONE_TIME ? { status: INBOX_PLACEMENT.STATUS_COMPLETED } : {}),
    })
    .where(eq(T.id, t.id));
  if (!pairs.length) return { run_id: runId, sending: 0, skipped, message, finished: nothing };
  // Variables like {{time}} read the test's clock, or the workspace's for a test without a schedule.
  const zone = t.schedule?.timezone ?? (await workspaceZone(t.workspaceId));
  const finished = sendRun(t, runId, pairs, zone).catch((err) => console.error(`[placement] run ${runId} of ${t.id} failed`, err));
  return { run_id: runId, sending: pairs.length, skipped, finished };
}

/** Sends a run's emails; then its results can be added up. */
async function sendRun(t: PlacementTestRow, runId: string, pairs: Array<{ sender: AccountRow; seed: SeedRow }>, tz: string) {
  let sent = 0;
  const jobs = pairs.map(({ sender, seed }) => async () => {
    const sandboxSender = isSandbox(sender);
    const messageId = newMessageId(sender.email);
    // Same rendering as campaign emails (variables and spintax); seeds get sample lead values.
    const vars = templateVars(null, sender, tz, "");
    const subject = renderTemplate(t.emailSubject, vars).output.trim() || "(no subject)";
    const body = renderTemplate(t.emailBody, vars, { escapeHtml: true }).output;
    const html = t.textOnly ? null : body;
    const text = t.textOnly ? body.replace(/<[^>]+>/g, "") : null;
    try {
      await driverFor(sender).send({
        from: { name: `${sender.firstName} ${sender.lastName}`.trim(), address: sender.email },
        to: [{ address: seed.email }],
        subject,
        html,
        text,
        messageId,
        headers: { "X-Placement-Test": t.id },
        sandbox: sandboxSender ? simulatedChances(seed, sender, heuristicSpamScore(subject, body), body) : undefined,
      });
      await db
        .insert(R)
        .values({
          workspaceId: t.workspaceId,
          testId: t.id,
          runId,
          recordType: 1,
          senderEmail: sender.email,
          senderEsp: senderEsp(sender),
          recipientEmail: seed.email,
          recipientEsp: seed.esp,
          recipientGeo: seed.geo,
          recipientType: seed.type === "Professional" ? 1 : 2,
          messageId,
        })
        .onConflictDoNothing();
      sent++;
    } catch (err) {
      console.error(`[placement] ${sender.email} → ${seed.email}: ${(err as Error).message}`);
    }
  });
  try {
    if (t.deliveryMode === INBOX_PLACEMENT.DELIVERY_ALL_TOGETHER) {
      for (let i = 0; i < jobs.length; i += 10) await Promise.all(jobs.slice(i, i + 10).map((j) => j()));
    } else {
      for (const j of jobs) {
        await j();
        if (jobs.length > 1) await sleep(1500);
      }
    }
  } finally {
    await db
      .update(T)
      .set({
        sendingRunId: null,
        sendingSince: null,
        // Not one email went out: there's nothing to wait for (a one-time test is over).
        ...(sent ? {} : { notSendingStatus: "other", ...(t.type === INBOX_PLACEMENT.TYPE_ONE_TIME ? { status: INBOX_PLACEMENT.STATUS_COMPLETED } : {}) }),
      })
      .where(and(eq(T.id, t.id), eq(T.sendingRunId, runId)));
  }
}

// ---------- Reading seeds ----------

function authFromHeaders(raw: string) {
  const ar = (raw.match(/^Authentication-Results:[\s\S]*?(?=\r?\n\S)/gim) ?? []).join(" ").toLowerCase();
  if (!ar) return null;
  const pick = (k: string) => {
    const m = ar.match(new RegExp(`${k}=(\\w+)`));
    return m ? m[1] === "pass" : null;
  };
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc"), raw: ar.slice(0, 1000) };
}

function sendingIp(raw: string): string | null {
  const received = raw.match(/^Received:[\s\S]*?(?=\r?\n\S)/gim) ?? [];
  for (const r of received) {
    for (const m of r.matchAll(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/g)) {
      const ip = m[1]!;
      if (!/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return ip;
    }
  }
  return null;
}

type SeedFacts = Pick<SeedRow, "email" | "type"> & { esp: number | null; geo: number | null };

/**
 * Where an email landed in a seed: the folder it was found in, "missing" when the seed was read and it wasn't there
 * (counted as spam), or "unchecked" when the seed couldn't be read at all (left out of the numbers).
 */
async function recordReceived(
  t: { id: string; workspaceId: string },
  sent: typeof R.$inferSelect | null,
  seed: SeedFacts,
  found: { folder: string; raw: Buffer; flags: string[] } | null,
  sender: string | null,
  unchecked = false,
) {
  const raw = found?.raw.toString("utf8") ?? "";
  const isSpam = unchecked ? null : !found || /junk|spam|bulk/i.test(found.folder);
  const hasCategory = unchecked ? null : found ? found.flags.some((f) => /promotions|social|updates|forums|^\$category/i.test(f)) : false;
  const senderDomain = domainOf(sender ?? sent?.senderEmail ?? "");
  let auth = authFromHeaders(raw);
  let failures: Record<string, unknown> | null = null;
  if (!auth && found) {
    if (senderDomain.endsWith(".test")) {
      auth = { spf: true, dkim: true, dmarc: true, raw: "simulated (sandbox domain)" };
      failures = { simulated: true };
    } else if (senderDomain) {
      const dns = await checkDomainAuth(senderDomain);
      auth = { spf: dns.spf, dkim: dns.dkim, dmarc: dns.dmarc, raw: "from DNS records (no Authentication-Results header)" };
    }
  }
  if (auth && (!auth.spf || !auth.dkim || !auth.dmarc)) failures = { ...(failures ?? {}), spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, details: auth.raw };
  const ip = found ? sendingIp(raw) : null;
  const hits = ip ? await checkIpBlocklists(ip) : [];
  await db
    .insert(R)
    .values({
      workspaceId: t.workspaceId,
      testId: t.id,
      runId: sent?.runId ?? "external",
      recordType: 2,
      senderEmail: sent?.senderEmail ?? sender,
      senderEsp: sent?.senderEsp ?? null,
      recipientEmail: seed.email,
      recipientEsp: seed.esp,
      recipientGeo: seed.geo,
      recipientType: seed.type === "Professional" ? 1 : 2,
      messageId: sent?.messageId ?? (found ? parseMessageId(raw) : null),
      isSpam,
      hasCategory,
      folder: found?.folder ?? (unchecked ? "unchecked" : "missing"),
      spfPass: auth?.spf ?? null,
      dkimPass: auth?.dkim ?? null,
      dmarcPass: auth?.dmarc ?? null,
      smtpIp: ip,
      smtpIpBlacklistReport: ip ? { ip, blacklisted_count: hits.filter((h) => h.listed).length, details: hits.map((h) => ({ blacklist: h.list, is_listed: h.listed })) } : null,
      authenticationFailureResults: failures,
    })
    .onConflictDoNothing();
}

function parseMessageId(raw: string): string | null {
  const m = raw.match(/^Message-ID:\s*(<[^>]+>)/im);
  return m ? m[1]! : null;
}

async function openSeed(seed: SeedRow) {
  if (!seed.accountId) {
    const { SandboxDriver } = await import("../mail/sandbox");
    return new SandboxDriver({ email: seed.email, workspaceId: "" }).open();
  }
  const [acc] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, seed.accountId));
  if (!acc) return null;
  return driverFor(acc).open();
}

/** Seeds whose mailbox couldn't be opened, by address: how many times in a row, and when last. */
const seedFailures = new Map<string, { count: number; at: number }>();
/** When each real seed was last searched for tests sent from other tools. */
const lastScanned = new Map<string, number>();

/**
 * Opens a seed's mailbox, or null when it can't be. After a failure it isn't tried again for a while (2 minutes,
 * doubling up to an hour), so a mailbox that refuses sign-ins isn't asked every few seconds.
 */
async function openSeedSafely(seed: SeedRow) {
  const failed = seedFailures.get(seed.email);
  if (failed && Date.now() < failed.at + Math.min(3_600_000, 2 * 60_000 * 2 ** Math.min(failed.count - 1, 5))) return null;
  const session = await openSeed(seed).catch(() => null);
  if (session) seedFailures.delete(seed.email);
  else seedFailures.set(seed.email, { count: (failed?.count ?? 0) + 1, at: Date.now() });
  return session;
}

/** Engine loop: resolves where pending test emails landed, scans for external tests, finalizes runs. */
export async function checkPlacement() {
  const since = new Date(Date.now() - 3 * 3_600_000);
  const pending = await db
    .select()
    .from(R)
    .where(
      and(
        eq(R.recordType, 1),
        gte(R.createdAt, since),
        sql`not exists (select 1 from inbox_placement_results x where x.test_id = ${R.testId} and x.message_id = ${R.messageId} and x.recipient_email = ${R.recipientEmail} and x.record_type = 2)`,
      ),
    )
    .orderBy(asc(R.createdAt))
    .limit(200);
  if (pending.length) {
    const seeds = new Map((await db.select().from(SEEDS)).map((s) => [s.email, s]));
    const byRecipient = new Map<string, typeof pending>();
    for (const p of pending) byRecipient.set(p.recipientEmail!, [...(byRecipient.get(p.recipientEmail!) ?? []), p]);
    for (const [email, rows] of byRecipient) {
      const seed = seeds.get(email);
      const session = seed ? await openSeedSafely(seed) : null;
      if (!seed || !session) {
        // A seed that can't be read (removed, or its mailbox deleted or failing) can't say where the emails landed:
        // after the usual wait they're marked unchecked, left out of the numbers, so their run still finishes.
        for (const row of rows) {
          if (Date.now() - row.createdAt.getTime() <= MISSING_AFTER_MS) continue;
          const facts: SeedFacts = seed ?? { email, esp: row.recipientEsp, geo: row.recipientGeo, type: row.recipientType === 1 ? "Professional" : "Personal" };
          await recordReceived({ id: row.testId, workspaceId: row.workspaceId }, row, facts, null, row.senderEmail, true);
        }
        continue;
      }
      try {
        for (const row of rows) {
          const found = await session.findByMessageId(row.messageId!, SEED_FOLDERS).catch(() => null);
          if (found || Date.now() - row.createdAt.getTime() > MISSING_AFTER_MS) {
            await recordReceived({ id: row.testId, workspaceId: row.workspaceId }, row, seed, found, row.senderEmail);
          }
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    }
  }
  await scanExternalTests();
  await finalizeRuns();
  await resumePausedAccounts();
}

/** External tests: look for the test code in every seed and record what arrived. */
async function scanExternalTests() {
  const tests = await db
    .select()
    .from(T)
    .where(and(eq(T.sendingMethod, INBOX_PLACEMENT.SENDING_EXTERNAL), eq(T.status, INBOX_PLACEMENT.STATUS_ACTIVE)));
  if (!tests.length) return;
  const seeds = await db.select().from(SEEDS).where(eq(SEEDS.active, true));
  for (const seed of seeds) {
    // The seeds a test gave out to send to (every seed, for tests from before it kept that list).
    const mine = tests.filter((t) => t.testCode && (!t.recipients.length || t.recipients.includes(seed.email)));
    if (!mine.length) continue;
    if (seed.accountId) {
      if (Date.now() - (lastScanned.get(seed.email) ?? 0) < EXTERNAL_SCAN_MS) continue;
      lastScanned.set(seed.email, Date.now());
    }
    const session = await openSeedSafely(seed);
    if (!session) continue;
    try {
      for (const t of mine) {
        if (!t.testCode) continue;
        // The seed's search finds any text containing the code; only the code itself counts (ptid_abc isn't ptid_abcd).
        const code = new RegExp(`(^|[^A-Za-z0-9_-])${t.testCode.replace(/[^A-Za-z0-9_]/g, "\\$&")}($|[^A-Za-z0-9_-])`);
        const found = await session.searchText(t.testCode, SEED_FOLDERS, t.lastRunAt ?? t.createdAt, 20).catch(() => []);
        for (const f of found) {
          const parsed = await parseInbound(f.raw);
          if (!code.test(`${parsed.subject}\n${parsed.text}\n${parsed.html}`)) continue;
          const [exists] = await db
            .select({ id: R.id })
            .from(R)
            .where(and(eq(R.testId, t.id), eq(R.messageId, parsed.messageId), eq(R.recipientEmail, seed.email), eq(R.recordType, 2)))
            .limit(1);
          if (!exists) await recordReceived(t, null, seed, f, parsed.from?.address ?? null);
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}

/** Stats for one set of received records. Seeds that couldn't be read say nothing about placement: they're only counted as unchecked. */
export function placementSummary(rows: Array<{ isSpam: boolean | null; hasCategory: boolean | null }>) {
  const checked = rows.filter((r) => r.isSpam !== null);
  const count = checked.length;
  const spam = checked.filter((r) => r.isSpam).length;
  const category = checked.filter((r) => !r.isSpam && r.hasCategory).length;
  const inbox = count - spam;
  const pct = (n: number) => (count ? Math.round((n / count) * 10000) / 100 : 0);
  return {
    count,
    spam_count: spam,
    spam_percent: pct(spam),
    inbox_count: inbox,
    inbox_percent: pct(inbox),
    category_count: category,
    category_percent: pct(category),
    unchecked_count: rows.length - count,
  };
}

const finalized = new Set<string>();

/** When every email of a run is accounted for: write domain reports, run automations, complete one-time tests. */
async function finalizeRuns() {
  const recent = await db
    .select({ testId: R.testId, runId: R.runId })
    .from(R)
    .where(and(eq(R.recordType, 1), gte(R.createdAt, new Date(Date.now() - 6 * 3_600_000))))
    .groupBy(R.testId, R.runId);
  for (const { testId, runId } of recent) {
    if (finalized.has(runId)) continue;
    const [already] = await db.select({ id: REP.id }).from(REP).where(eq(REP.runId, runId)).limit(1);
    if (already) {
      finalized.add(runId);
      continue;
    }
    const rows = await db.select().from(R).where(and(eq(R.testId, testId), eq(R.runId, runId)));
    const sent = rows.filter((r) => r.recordType === 1);
    const received = rows.filter((r) => r.recordType === 2);
    if (received.length < sent.length) continue;
    const [t] = await db.select().from(T).where(eq(T.id, testId));
    if (!t) continue;
    // Still sending: more of its emails are on the way.
    if (t.sendingRunId === runId && t.sendingSince && t.sendingSince.getTime() > Date.now() - SENDING_MAX_MS) continue;
    finalized.add(runId);
    const domains = [...new Set(sent.map((s) => domainOf(s.senderEmail ?? "")).filter(Boolean))];
    const listedNow: string[] = [];
    for (const domain of domains) {
      const report = await buildDomainReport(t, runId, domain);
      if ((report.domainBlacklistCount ?? 0) + (report.domainIpBlacklistCount ?? 0) > 0) listedNow.push(domain);
    }
    if (t.type === INBOX_PLACEMENT.TYPE_ONE_TIME) await db.update(T).set({ status: INBOX_PLACEMENT.STATUS_COMPLETED }).where(eq(T.id, t.id));
    await runAutomations(t, runId, placementSummary(received), listedNow);
  }
}

async function buildDomainReport(t: PlacementTestRow, runId: string, domain: string) {
  const sandboxDomain = domain.endsWith(".test");
  let ip = "";
  let domainHits: Awaited<ReturnType<typeof checkDomainBlocklists>> = [];
  let ipHits: Awaited<ReturnType<typeof checkIpBlocklists>> = [];
  let auth: Record<string, unknown> | null = null;
  if (!sandboxDomain) {
    ip = (await resolveA(domain))[0] ?? "";
    if (!ip) {
      const mx = await resolveMx(domain);
      if (mx?.[0]) ip = (await resolveA(mx[0]))[0] ?? "";
    }
    domainHits = await checkDomainBlocklists(domain);
    ipHits = ip ? await checkIpBlocklists(ip) : [];
    auth = { ...(await checkDomainAuth(domain)) };
  } else {
    auth = { domain, simulated: true, note: "Sandbox domains are not published in DNS, so DNS checks are skipped." };
  }
  const raw = await buildRaw({ from: { address: `test@${domain}` }, to: [{ address: "seed@example.com" }], subject: t.emailSubject, html: t.emailBody, messageId: newMessageId(`test@${domain}`) });
  const content = await spamScore({ subject: t.emailSubject, html: t.emailBody, raw });
  const details = [
    ...domainHits.map((h) => ({ blacklist: h.list, is_listed: h.listed, test_type: "domain" })),
    ...ipHits.map((h) => ({ blacklist: h.list, is_listed: h.listed, test_type: "ip" })),
  ];
  const values = {
    workspaceId: t.workspaceId,
    testId: t.id,
    runId,
    domain,
    domainIp: ip,
    domainBlacklistCount: domainHits.filter((h) => h.listed).length,
    domainIpBlacklistCount: ipHits.filter((h) => h.listed).length,
    spamAssassinScore: content.spam_score,
    spamAssassinReport: { is_spam: content.is_spam, spam_score: Math.round(content.spam_score), engine: content.engine, threshold: content.threshold, report: content.report },
    blacklistReport: { address: domain, ip, is_domain: true, blacklisted_count: details.filter((d) => d.is_listed).length, is_blacklisted: details.some((d) => d.is_listed), details },
    authReport: auth,
  };
  await db.insert(REP).values(values);
  return values;
}

async function runAutomations(t: PlacementTestRow, runId: string, summary: ReturnType<typeof placementSummary>, listedNow: string[]) {
  const autos = (t.automations ?? []) as Array<z.infer<typeof automationSchema>>;
  if (!autos.length) return;
  const [prevRun] = await db
    .select({ runId: REP.runId })
    .from(REP)
    .where(and(eq(REP.testId, t.id), sql`${REP.runId} != ${runId}`))
    .orderBy(desc(REP.createdAt))
    .limit(1);
  const prevListed = prevRun?.runId
    ? (await db.select().from(REP).where(eq(REP.runId, prevRun.runId))).filter((r) => (r.domainBlacklistCount ?? 0) + (r.domainIpBlacklistCount ?? 0) > 0).length > 0
    : false;
  const senders = await testSenders(t);
  // Placement is judged on the seeds that could be read, and only when they were at least half of the run.
  const judged = summary.count > 0 && summary.count >= summary.unchecked_count;
  for (const a of autos) {
    const v = a.when.condition_value ?? 0;
    const fire =
      (a.when.condition === "placement_goes_below" && judged && summary.inbox_percent < v) ||
      (a.when.condition === "placement_goes_above" && judged && summary.inbox_percent > v) ||
      (a.when.condition === "added_to_blacklists" && listedNow.length > 0 && !prevListed) ||
      (a.when.condition === "removed_from_blacklists" && listedNow.length === 0 && prevListed);
    if (!fire) continue;
    const ids = senders.map((s) => s.id);
    if (a.then.webhook_url) {
      try {
        const res = await publicFetch(a.then.webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: a.when.condition, test_id: t.id, test_name: t.name, run_id: runId, ...summary, blacklisted_domains: listedNow, timestamp: new Date().toISOString() }),
          signal: AbortSignal.timeout(15_000),
        });
        await res.body?.cancel().catch(() => {});
      } catch (err) {
        console.error(`[placement] automation webhook failed: ${(err as Error).message}`);
      }
    }
    if (ids.length && a.then.pause) {
      await db
        .update(schema.emailAccounts)
        .set({ status: AccountStatus.PAUSED, statusMessage: { paused_by: "inbox_placement", test_id: t.id, resume_at: null } })
        .where(inArray(schema.emailAccounts.id, ids));
    }
    if (ids.length && a.then.pause_sending_campaigns_for) {
      // Campaigns stop using these accounts for a while; warmup keeps running.
      await db
        .update(schema.emailAccounts)
        .set({ campaignPauseUntil: new Date(Date.now() + a.then.pause_sending_campaigns_for * 86_400_000) })
        .where(inArray(schema.emailAccounts.id, ids));
    }
    if (ids.length && (a.then.enable_slow_ramp || a.then.disable_slow_ramp)) {
      await db.update(schema.emailAccounts).set({ enableSlowRamp: !!a.then.enable_slow_ramp }).where(inArray(schema.emailAccounts.id, ids));
    }
    if (ids.length && a.then.add_tags?.length) {
      const rows = ids.flatMap((resourceId) => a.then.add_tags!.map((tagId) => ({ workspaceId: t.workspaceId, tagId, resourceId, resourceType: 1 })));
      await db.insert(schema.customTagMappings).values(rows).onConflictDoNothing();
    }
  }
}

/** Accounts paused "for N days" by an automation resume automatically. */
async function resumePausedAccounts() {
  const paused = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.status, AccountStatus.PAUSED));
  for (const a of paused) {
    const msg = a.statusMessage as { paused_by?: string; resume_at?: string | null } | null;
    if (msg?.paused_by === "inbox_placement" && msg.resume_at && Date.parse(msg.resume_at) <= Date.now()) {
      await db.update(schema.emailAccounts).set({ status: AccountStatus.ACTIVE, statusMessage: null }).where(eq(schema.emailAccounts.id, a.id));
    }
  }
}

/** Engine loop: starts automated tests whose next run is due. */
export async function runDuePlacementTests() {
  const due = await db
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.status, INBOX_PLACEMENT.STATUS_ACTIVE), lt(T.nextRunAt, new Date()), eq(T.sendingMethod, INBOX_PLACEMENT.SENDING_FROM_APP), await inUse(T.workspaceId)))
    .limit(5);
  for (const d of due) {
    // Clear first so a slow run is never started twice.
    await db.update(T).set({ nextRunAt: null }).where(eq(T.id, d.id));
    await runTest(d.id).catch((err) => console.error(`[placement] run ${d.id} failed`, err));
  }
}

