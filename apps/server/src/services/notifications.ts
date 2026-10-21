// Notifications. In-app ones live under the bell in the app header (one row per person in `notifications`, so each
// person reads their own) and need no SMTP. Each goes to the workspace members who can open its area (owner and admins
// when it has none). The emails from Settings → Preferences (disconnected sending accounts and positive replies) go
// to the workspace owner and admins, or to the workspace's own list.
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { CampaignStatus, EmailType, INTEREST_STATUS_LABELS, interestSentiment, roleAllows, type Permission, type Role } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { iso } from "../lib/time";
import { effectivePermissions } from "./branding";
import { on } from "./bus";
import { recentBounceStats } from "./campaigns";
import { sendSystemMail, systemMailLayout } from "./system-mail";

const N = schema.notifications;
const HOUR = 3_600_000;

// ---------- In-app notifications ----------

export type NotificationType =
  | "account_error"
  | "positive_reply"
  | "bounce_protect"
  | "campaign_completed"
  | "campaign_stalled"
  | "sending_paused"
  | "reminder_due"
  | "task_due"
  // Written elsewhere: done-for-you orders (routes/dfy.ts) and Copilot tasks (services/copilot/tasks.ts).
  | "dfy_order"
  | "dfy_ready"
  | "copilot_task";

export interface NotifyInput {
  workspaceId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  /** In-app path of what it's about. Repeats are recognized by type and link. */
  link: string;
  /** The area someone must be able to open to get it; null means the workspace owner and admins only. */
  perm: Permission | null;
  /** Leaves out client members (agency portal), for problems the agency handles. */
  staffOnly?: boolean;
  /** Only these people, while they can still open the area; when none of them can, everyone who can. */
  userIds?: Array<string | null | undefined>;
  /** Not sent when one with the same type and link was created since this time (ms), or, with `orUnread`, is still unread. */
  dedupe?: { since: number; orUnread?: boolean };
}

/** People who get a notification: accepted members with a working account who can open the area. */
async function recipientIds(input: Pick<NotifyInput, "workspaceId" | "perm" | "staffOnly" | "userIds">): Promise<string[]> {
  const [ws] = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, input.workspaceId), isNull(schema.workspaces.deletedAt)))
    .limit(1);
  if (!ws) return [];
  const rows = await db
    .select({ member: schema.workspaceMembers })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.accepted, true), isNull(schema.users.deletedAt), isNull(schema.users.disabledAt)));
  const allowed = rows
    .map((r) => r.member)
    .filter((m) => {
      const role = m.role as Role;
      if (input.staffOnly && role === "client") return false;
      return input.perm ? roleAllows(role, input.perm, effectivePermissions(ws, m)) : role === "owner" || role === "admin";
    });
  const wanted = new Set((input.userIds ?? []).filter((id): id is string => !!id));
  const named = allowed.filter((m) => wanted.has(m.userId!));
  return [...new Set((named.length ? named : allowed).map((m) => m.userId!))];
}

/** Whether a notification of this type about this link was created since `since` (or, with `orUnread`, is still unread). */
export async function notifiedSince(workspaceId: string, type: NotificationType, link: string, since: number, orUnread = false): Promise<boolean> {
  const recent = gte(N.createdAt, new Date(since));
  const [hit] = await db
    .select({ id: N.id })
    .from(N)
    .where(and(eq(N.workspaceId, workspaceId), eq(N.type, type), eq(N.link, link), orUnread ? or(recent, isNull(N.readAt)) : recent))
    .limit(1);
  return !!hit;
}

const clip = (s: string | null | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? null));

/** Repeats being written right now (two events in the same moment), so the check-then-insert can't double up. */
const inflight = new Set<string>();

/**
 * The people among `users` who already have this news (same type and link) since `since`, or still unread with
 * `orUnread`: each person's own copy counts for them alone, and one addressed to the whole workspace for everyone.
 */
async function alreadyTold(input: NotifyInput & { dedupe: NonNullable<NotifyInput["dedupe"]> }, users: string[]): Promise<Set<string>> {
  const recent = gte(N.createdAt, new Date(input.dedupe.since));
  const rows = await db
    .select({ userId: N.userId })
    .from(N)
    .where(and(eq(N.workspaceId, input.workspaceId), eq(N.type, input.type), eq(N.link, input.link), input.dedupe.orUnread ? or(recent, isNull(N.readAt)) : recent));
  return rows.some((r) => r.userId === null) ? new Set(users) : new Set(rows.map((r) => r.userId!));
}

/** Writes the notification for everyone who should get it. Returns how many people got it (0 for a repeat). */
export async function notify(input: NotifyInput): Promise<number> {
  const key = `${input.workspaceId}|${input.type}|${input.link}`;
  if (inflight.has(key)) return 0;
  inflight.add(key);
  try {
    let users = await recipientIds(input);
    if (input.dedupe && users.length) {
      const told = await alreadyTold({ ...input, dedupe: input.dedupe }, users);
      users = users.filter((u) => !told.has(u));
    }
    if (!users.length) return 0;
    await db.insert(N).values(
      users.map((userId) => ({ workspaceId: input.workspaceId, userId, type: input.type, title: clip(input.title, 200)!, body: clip(input.body, 1_000), link: input.link })),
    );
    return users.length;
  } finally {
    inflight.delete(key);
  }
}

/** One person's notifications in a workspace: their own plus any addressed to the whole workspace. */
const mine = (workspaceId: string, userId: string) => and(eq(N.workspaceId, workspaceId), or(eq(N.userId, userId), isNull(N.userId)))!;

export function serializeNotification(r: typeof N.$inferSelect) {
  return { id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: !!r.readAt, created_at: iso(r.createdAt) };
}

export async function unreadCount(workspaceId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(N)
    .where(and(mine(workspaceId, userId), isNull(N.readAt)));
  return Number(row?.n ?? 0);
}

/** Newest first. Ids are time-ordered, so `before` (the last id of a page) continues the list. */
export async function listNotifications(workspaceId: string, userId: string, opts: { limit: number; before?: string; unreadOnly?: boolean }) {
  const rows = await db
    .select()
    .from(N)
    .where(and(mine(workspaceId, userId), opts.before ? lt(N.id, opts.before) : undefined, opts.unreadOnly ? isNull(N.readAt) : undefined))
    .orderBy(desc(N.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return {
    items: page.map(serializeNotification),
    unread: await unreadCount(workspaceId, userId),
    next_before: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}

/** Marks one notification read; false when it isn't this person's (or doesn't exist). */
export async function markRead(workspaceId: string, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: N.id, readAt: N.readAt })
    .from(N)
    .where(and(mine(workspaceId, userId), eq(N.id, id)))
    .limit(1);
  if (!row) return false;
  if (!row.readAt) await db.update(N).set({ readAt: new Date() }).where(eq(N.id, row.id));
  return true;
}

export async function markAllRead(workspaceId: string, userId: string): Promise<number> {
  const res = await db
    .update(N)
    .set({ readAt: new Date() })
    .where(and(mine(workspaceId, userId), isNull(N.readAt)))
    .returning({ id: N.id });
  return res.length;
}

/** Notifications are kept for 90 days. */
export async function pruneNotifications(now = Date.now()) {
  await db.delete(N).where(lt(N.createdAt, new Date(now - 90 * 24 * HOUR)));
}

export const campaignLink = (campaignId: string) => `/app/campaign/${campaignId}/analytics`;

/** "Connection refused" → "Connection refused." */
const sentence = (s: string) => {
  const t = s.trim();
  return !t ? "" : /[.!?]$/.test(t) ? t : `${t}.`;
};

async function campaignRow(id: unknown) {
  if (typeof id !== "string" || !id) return null;
  const [c] = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1);
  return c ?? null;
}

/** A label's name: built in, or one of the workspace's own. */
async function labelName(workspaceId: string, value: number): Promise<string> {
  if (INTEREST_STATUS_LABELS[value]) return INTEREST_STATUS_LABELS[value]!;
  const [custom] = await db
    .select({ label: schema.leadLabels.label })
    .from(schema.leadLabels)
    .where(and(eq(schema.leadLabels.workspaceId, workspaceId), eq(schema.leadLabels.interestStatus, value)))
    .limit(1);
  return custom?.label ?? "Interested";
}

const n = (v: number) => v.toLocaleString("en-US");

// A mailbox stopped working. A flapping mailbox makes one notification: none while the last one is still unread, and
// after that at most one every 12 hours.
on("account_error", async (ev) => {
  const email = String(ev.data.email ?? "").trim();
  // `code` is what went wrong (services/accounts.ts recordAccountError), `kind` which side: smtp (sending) or imap (inbox).
  const code = typeof ev.data.code === "string" ? ev.data.code : null;
  const what =
    code === "auth"
      ? "can't sign in"
      : code === "quota"
        ? "hit its provider's sending limit"
        : code === "rejected"
          ? "is having its emails refused"
          : ev.data.kind === "imap"
            ? "can't check its inbox"
            : "stopped sending";
  await notify({
    workspaceId: ev.workspaceId,
    type: "account_error",
    title: `${email || "A mailbox"} ${what}`,
    body: `${sentence(String(ev.data.error ?? "The connection failed"))} Campaigns skip it until it works again.`,
    link: email ? `/app/accounts?account=${encodeURIComponent(email)}` : "/app/accounts?status=errors",
    perm: "accounts",
    staffOnly: true,
    dedupe: { since: Date.now() - 12 * HOUR, orUnread: true },
  });
});

// A lead turned positive. A label someone set by hand isn't news to them; replies the AI or the rules labelled, and
// changes from automations and the API, are.
on("lead_interest_changed", async (ev) => {
  const value = ev.data.value as number | null;
  if (interestSentiment(value) !== "positive" || interestSentiment(ev.data.previous as number | null) === "positive") return;
  if ((ev.data.source ?? "user") === "user") return;
  const leadId = typeof ev.data.lead_id === "string" ? ev.data.lead_id : null;
  const email = typeof ev.data.lead_email === "string" && ev.data.lead_email ? ev.data.lead_email.toLowerCase() : null;
  const L = schema.leads;
  const [lead] = leadId
    ? await db.select({ firstName: L.firstName, lastName: L.lastName, campaignId: L.campaignId }).from(L).where(eq(L.id, leadId)).limit(1)
    : [];
  const name = [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim() || email || "A lead";
  const M = schema.emails;
  // The conversation to open: the lead's latest reply (found by address, which is indexed).
  const byLead = email ? eq(M.leadEmail, email) : leadId ? eq(M.leadId, leadId) : null;
  const [reply] = byLead
    ? await db
        .select({ threadId: M.threadId })
        .from(M)
        .where(and(eq(M.workspaceId, ev.workspaceId), byLead, eq(M.ueType, EmailType.RECEIVED), isNull(M.deletedAt)))
        .orderBy(desc(M.timestampEmail))
        .limit(1)
    : [];
  const campaign = await campaignRow(lead?.campaignId);
  await notify({
    workspaceId: ev.workspaceId,
    type: "positive_reply",
    title: `Positive reply from ${name}`,
    body: `Marked “${await labelName(ev.workspaceId, value!)}”${campaign ? ` in ${campaign.name}` : ""}.`,
    link: reply?.threadId ? `/app/unibox?thread=${encodeURIComponent(reply.threadId)}` : `/app/unibox?search=${encodeURIComponent(email ?? name)}`,
    perm: "unibox",
    dedupe: { since: Date.now() - HOUR },
  });
});

// Bounce protection paused a campaign (engine/sender.ts finalizeCampaign).
on("campaign_status_changed", async (ev) => {
  if (ev.data.status !== CampaignStatus.BOUNCE_PROTECT) return;
  const c = await campaignRow(ev.data.campaign_id);
  if (!c) return;
  const s = await recentBounceStats(c.id);
  await notify({
    workspaceId: ev.workspaceId,
    type: "bounce_protect",
    title: `“${c.name}” paused: too many bounces`,
    body: s.sent
      ? `In the last 7 days ${n(s.bounced)} of its ${n(s.sent)} emails hard-bounced (${s.rate}%). Clean or verify the leads that are left, then resume it.`
      : "Too many of its emails hard-bounced. Clean or verify the leads that are left, then resume it.",
    link: campaignLink(c.id),
    perm: "view_campaigns",
    staffOnly: true,
    dedupe: { since: Date.now() - HOUR },
  });
});

on("campaign_completed", async (ev) => {
  const c = await campaignRow(ev.data.campaign_id);
  if (!c) return;
  const E = schema.emailEvents;
  const [t] = await db
    .select({ sent: sql<number>`sum(case when ${E.type} = 'sent' then 1 else 0 end)`, replies: sql<number>`count(distinct case when ${E.type} = 'reply' then ${E.leadId} end)` })
    .from(E)
    .where(eq(E.campaignId, c.id));
  const sent = Number(t?.sent ?? 0);
  const replies = Number(t?.replies ?? 0);
  await notify({
    workspaceId: ev.workspaceId,
    type: "campaign_completed",
    title: `“${c.name}” finished`,
    body: `Every lead has been through the sequence: ${n(sent)} email${sent === 1 ? "" : "s"} sent, ${n(replies)} ${replies === 1 ? "lead" : "leads"} replied.`,
    link: campaignLink(c.id),
    perm: "view_campaigns",
    dedupe: { since: Date.now() - 24 * HOUR },
  });
});

// ---------- Email notifications (Settings → Preferences) ----------

interface NotificationPrefs {
  notify_account_disconnect?: boolean;
  notify_positive_reply?: boolean;
  notification_recipients?: string[];
}

async function workspaceFor(workspaceId: string) {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return ws ?? null;
}

/** The workspace's own list (Preferences), else its owner and admins whose accounts still work, at their sign-in address. */
async function recipients(workspaceId: string, prefs: NotificationPrefs): Promise<string[]> {
  const custom = (prefs.notification_recipients ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (custom.length) return [...new Set(custom)];
  const M = schema.workspaceMembers;
  const U = schema.users;
  const rows = await db
    .select({ email: U.email })
    .from(M)
    .innerJoin(U, eq(U.id, M.userId))
    .where(and(eq(M.workspaceId, workspaceId), eq(M.accepted, true), inArray(M.role, ["owner", "admin"]), isNull(U.deletedAt), isNull(U.disabledAt)));
  return [...new Set(rows.map((r) => r.email.toLowerCase()))];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// One disconnect notice per account every six hours, so a flapping mailbox doesn't flood anyone.
const lastDisconnectNotice = new Map<string, number>();

on("account_error", async (ev) => {
  const ws = await workspaceFor(ev.workspaceId);
  const prefs = (ws?.settings ?? {}) as NotificationPrefs;
  if (!ws || prefs.notify_account_disconnect === false) return;
  const key = String(ev.data.account_id ?? ev.data.email);
  const last = lastDisconnectNotice.get(key) ?? 0;
  if (Date.now() - last < 6 * 3_600_000) return;
  lastDisconnectNotice.set(key, Date.now());
  const email = escape(String(ev.data.email ?? "A sending account"));
  const { text, html } = systemMailLayout(
    "A sending account needs attention",
    [`${email} in the ${escape(ws.name)} workspace stopped working: ${escape(String(ev.data.error ?? "connection failed"))}.`, "Campaigns skip it until it's reconnected."],
    { label: "Open email accounts", url: `${config.webUrl}/app/accounts?status=errors` },
  );
  for (const to of await recipients(ev.workspaceId, prefs)) await sendSystemMail({ to, subject: `${String(ev.data.email ?? "Account")} disconnected`, text, html });
});

// Positive replies by email. A label someone set by hand isn't news to them. A person is told of once in 12 hours (their
// leads in other campaigns change with them), and while the first email of a while goes out at once, any more in the
// next ten minutes come together in one: a busy morning or a bulk change is a few emails, not hundreds.
const POSITIVE_GATHER_MS = 10 * 60_000;
const POSITIVE_REPEAT_MS = 12 * HOUR;
const positiveToldAt = new Map<string, number>();
/** Per workspace, while a gathering window is open: the positive replies waiting for its email. */
const gathering = new Map<string, Array<{ lead: string; label: string }>>();

on("lead_interest_changed", async (ev) => {
  const value = ev.data.value as number | null;
  if (interestSentiment(value) !== "positive" || interestSentiment(ev.data.previous as number | null) === "positive") return;
  if ((ev.data.source ?? "user") === "user") return;
  const ws = await workspaceFor(ev.workspaceId);
  const prefs = (ws?.settings ?? {}) as NotificationPrefs;
  if (!ws || prefs.notify_positive_reply === false) return;
  const address = typeof ev.data.lead_email === "string" ? ev.data.lead_email.trim().toLowerCase() : "";
  const who = `${ev.workspaceId}|${address || String(ev.data.lead_id ?? "")}`;
  const now = Date.now();
  if (now - (positiveToldAt.get(who) ?? 0) < POSITIVE_REPEAT_MS) return;
  positiveToldAt.set(who, now);
  if (positiveToldAt.size > 10_000) for (const [k, at] of positiveToldAt) if (now - at >= POSITIVE_REPEAT_MS) positiveToldAt.delete(k);
  const item = { lead: address || "A lead", label: await labelName(ev.workspaceId, value!) };
  const waiting = gathering.get(ev.workspaceId);
  if (waiting) {
    waiting.push(item);
    return;
  }
  gatherFor(ev.workspaceId);
  await emailPositives(ev.workspaceId, [item]);
});

/** Opens a gathering window: what comes in during it goes out as one email when it closes. */
function gatherFor(workspaceId: string) {
  gathering.set(workspaceId, []);
  setTimeout(() => void sendGathered(workspaceId), POSITIVE_GATHER_MS).unref();
}

/** Sends what gathered; a window that gathered something opens the next one, so a steady stream is one email a window. */
export async function sendGathered(workspaceId: string) {
  const items = gathering.get(workspaceId) ?? [];
  gathering.delete(workspaceId);
  if (!items.length) return;
  gatherFor(workspaceId);
  await emailPositives(workspaceId, items).catch((err) => console.error("[notifications] positive replies email", err));
}

async function emailPositives(workspaceId: string, items: Array<{ lead: string; label: string }>) {
  const ws = await workspaceFor(workspaceId);
  const prefs = (ws?.settings ?? {}) as NotificationPrefs;
  if (!ws || prefs.notify_positive_reply === false || !items.length) return;
  const one = items.length === 1 ? items[0]! : null;
  const shown = items.slice(0, 30);
  const { text, html } = one
    ? systemMailLayout(`${escape(one.lead)} is now “${escape(one.label)}”`, [`A lead in the ${escape(ws.name)} workspace was marked ${escape(one.label)}.`], {
        label: "Open the conversation",
        url: `${config.webUrl}/app/unibox?search=${encodeURIComponent(`lead:${one.lead}`)}`,
      })
    : systemMailLayout(
        `${items.length} positive replies`,
        [
          `Leads in the ${escape(ws.name)} workspace marked positive in the last few minutes:`,
          shown.map((i) => `${escape(i.lead)}: ${escape(i.label)}`).join("<br>") + (items.length > shown.length ? `<br>and ${items.length - shown.length} more` : ""),
        ],
        { label: "Open the Unibox", url: `${config.webUrl}/app/unibox` },
      );
  const subject = one ? `Positive reply: ${one.lead}` : `${items.length} positive replies in ${ws.name}`;
  for (const to of await recipients(workspaceId, prefs)) await sendSystemMail({ to, subject, text, html });
}
