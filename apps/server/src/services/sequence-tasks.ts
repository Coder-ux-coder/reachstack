// Task steps in sequences (TASK_STEPS in @reachstack/shared). A lead that reaches one gets a task (on Today, and in
// CRM → Tasks) and waits for it with no next send time; Done or Skip moves it on to the next step. A task whose lead
// stops waiting (it replied, unsubscribed or bounced, was paused, moved or deleted) is put away, and a lead left
// waiting at a step that isn't a task any more carries on from there.
import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  CampaignStatus,
  LeadStatus,
  TASK_STEPS,
  delayToMs,
  htmlToText,
  isTaskStep,
  renderTemplate,
  senderVariables,
  type SequenceStep,
  type TaskStepKind,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { templateVars } from "../engine/sender";
import { conflict, notFound } from "../http/errors";
import { iso, leadClock } from "../lib/time";
import type { AccountRow } from "../mail/driver";
import { recordEvent } from "./activity";
import { emit } from "./bus";
import { activeSteps, type CampaignRow, type SubsequenceRow } from "./campaigns";
import { stoppedWorkspaces } from "./live-workspaces";
import { currentMembers } from "./members";

const L = schema.leads;
const T = schema.crmTasks;
type LeadRow = typeof L.$inferSelect;
export type SequenceTaskRow = typeof T.$inferSelect;

/** Tasks made per campaign or subsequence in one pass; the rest follow in the next. */
const BATCH = 200;

/** A campaign's own sequence, or one of its subsequences. */
interface Flow {
  campaign: CampaignRow;
  sub: SubsequenceRow | null;
  steps: SequenceStep[];
}

/** The lead columns that say where a lead is in a flow. */
function place(flow: { sub: { id: string } | null; campaign: { id: string } }) {
  return flow.sub
    ? {
        inFlow: and(eq(L.subsequenceId, flow.sub.id), eq(L.subseqStatus, LeadStatus.ACTIVE), notInArray(L.status, [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED]))!,
        step: L.subseqNextStep,
        at: L.subseqNextSendAt,
      }
    : { inFlow: and(eq(L.campaignId, flow.campaign.id), eq(L.status, LeadStatus.ACTIVE))!, step: L.nextStep, at: L.nextSendAt };
}

const ofFlow = (flow: Flow): SQL => (flow.sub ? eq(T.subsequenceId, flow.sub.id) : and(eq(T.campaignId, flow.campaign.id), isNull(T.subsequenceId))!);
const open = and(eq(T.source, "sequence"), eq(T.status, "open"), isNull(T.archivedAt))!;

/** Steps (from 0) that are tasks. A campaign's first step is always an email: its new leads wait with no send time. */
const taskSteps = (flow: Flow) => flow.steps.flatMap((s, i) => (isTaskStep(s) && (flow.sub || i > 0) ? [i] : []));

const leadName = (lead: Pick<LeadRow, "firstName" | "lastName" | "email">) => [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || lead.email || "this lead";

/** The task's title and note for this lead: the step's own wording with the lead's details filled in. */
function taskText(step: SequenceStep, lead: LeadRow, account: AccountRow | null, flow: Flow) {
  const kind: TaskStepKind = step.task ?? "todo";
  const schedule = flow.sub?.schedule ?? flow.campaign.schedule;
  const vars = {
    ...templateVars(lead, account, leadClock(schedule, lead.timezone), ""),
    // No mailbox has written to them yet: nothing to sign with, rather than sample names.
    ...(account ? {} : senderVariables({ email: "", first_name: "", last_name: "", signature: "" })),
  };
  const v = step.variants[0];
  const title = (v?.subject?.trim() ? renderTemplate(v.subject, vars).output.replace(/\s+/g, " ").trim() : "") || TASK_STEPS[kind].title(leadName(lead));
  const body = v?.body?.trim() ? v.body : "";
  const note = body ? renderTemplate(/<[a-z][^<>]*>/i.test(body) ? htmlToText(body) : body, vars).output.trim() : "";
  return { kind, title: title.slice(0, 500), note: note || null };
}

/** Leads at a task step that's due, or waiting without a task (say, restored from Recently deleted), get one. */
async function openTasks(flow: Flow, now: number): Promise<number> {
  const steps = taskSteps(flow);
  if (!steps.length) return 0;
  const p = place(flow);
  const leads = await db
    .select()
    .from(L)
    .where(
      and(
        p.inFlow,
        inArray(p.step, steps),
        or(isNull(p.at), lte(p.at, now)),
        sql`not exists (select 1 from ${T} where ${T.leadId} = ${L.id} and ${open} and ${T.step} = ${p.step} and ${ofFlow(flow)})`,
      ),
    )
    .orderBy(asc(p.at))
    .limit(BATCH);
  if (!leads.length) return 0;
  const accountIds = [...new Set(leads.map((l) => l.senderAccountId).filter((id): id is string => !!id))];
  const accounts = new Map((accountIds.length ? await db.select().from(schema.emailAccounts).where(inArray(schema.emailAccounts.id, accountIds)) : []).map((a) => [a.id, a]));
  // A task goes to the lead's owner, or the campaign's when the owner has left or is turned off (else to nobody).
  const people = await currentMembers(flow.campaign.workspaceId, [...leads.map((l) => l.assignedTo), flow.campaign.ownedBy]);
  const assignee = (lead: LeadRow) => [lead.assignedTo, flow.campaign.ownedBy].find((id): id is string => !!id && people.has(id)) ?? null;
  let made = 0;
  for (const lead of leads) {
    const index = flow.sub ? lead.subseqNextStep : lead.nextStep;
    const step = flow.steps[index]!;
    const text = taskText(step, lead, lead.senderAccountId ? (accounts.get(lead.senderAccountId) ?? null) : null, flow);
    // The lead waits for its task from now on, as long as it's still at this step.
    const [held] = await db
      .update(L)
      .set(flow.sub ? { subseqNextSendAt: null } : { nextSendAt: null })
      .where(and(eq(L.id, lead.id), p.inFlow, eq(p.step, index)))
      .returning({ id: L.id });
    if (!held) continue;
    const [task] = await db
      .insert(T)
      .values({
        workspaceId: flow.campaign.workspaceId,
        leadId: lead.id,
        leadEmail: lead.email,
        title: text.title,
        description: text.note,
        type: TASK_STEPS[text.kind].crmType,
        dueAt: new Date(now),
        assignedTo: assignee(lead),
        source: "sequence",
        campaignId: flow.campaign.id,
        subsequenceId: flow.sub?.id ?? null,
        step: index,
        stepKind: text.kind,
      })
      .returning();
    made++;
    emit("crm_task_created", flow.campaign.workspaceId, { task_id: task!.id, title: task!.title, lead_email: lead.email, assigned_to: task!.assignedTo, due_at: iso(task!.dueAt) });
  }
  return made;
}

/**
 * A running flow's steps changed: tasks for steps that aren't tasks any more are put away, and leads waiting at such a
 * step (or past the last one) carry on now.
 */
async function followSteps(flow: Flow, now: number) {
  const steps = taskSteps(flow);
  await db
    .update(T)
    .set({ archivedAt: new Date(now) })
    .where(and(open, ofFlow(flow), steps.length ? notInArray(T.step, steps) : undefined));
  const p = place(flow);
  await db
    .update(L)
    .set(flow.sub ? { subseqNextSendAt: now } : { nextSendAt: now })
    .where(and(p.inFlow, isNull(p.at), flow.sub ? undefined : sql`${L.nextStep} > 0`, steps.length ? notInArray(p.step, steps) : undefined));
}

/** Open tasks whose lead isn't waiting at that step any more (it replied, was paused, moved on or deleted) are put away. */
async function putAwayStale(now: Date) {
  await db
    .update(T)
    .set({ archivedAt: now })
    .where(
      and(
        open,
        sql`not exists (select 1 from ${L} where ${L.id} = ${T.leadId} and case when ${T.subsequenceId} is null
          then ${L.campaignId} = ${T.campaignId} and ${L.status} = ${LeadStatus.ACTIVE} and ${L.nextStep} = ${T.step}
          else ${L.subsequenceId} = ${T.subsequenceId} and ${L.subseqStatus} = ${LeadStatus.ACTIVE} and ${L.subseqNextStep} = ${T.step}
            and ${L.status} not in (${LeadStatus.BOUNCED}, ${LeadStatus.UNSUBSCRIBED}) end)`,
      ),
    );
}

/** Engine loop: makes the tasks that are due in running campaigns and subsequences, and puts away the stale ones. */
export async function runSequenceTasks(now = Date.now()) {
  const stopped = await stoppedWorkspaces();
  const campaigns = await db
    .select()
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.status, [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES]));
  for (const campaign of campaigns) {
    if (stopped.has(campaign.workspaceId)) continue;
    const flows: Flow[] = [];
    if (campaign.status === CampaignStatus.ACTIVE) flows.push({ campaign, sub: null, steps: activeSteps(campaign) });
    const subs = await db
      .select()
      .from(schema.subsequences)
      .where(and(eq(schema.subsequences.parentCampaignId, campaign.id), eq(schema.subsequences.status, CampaignStatus.ACTIVE)));
    for (const sub of subs) flows.push({ campaign, sub, steps: sub.sequences?.[0]?.steps ?? [] });
    for (const flow of flows) {
      await followSteps(flow, now);
      await openTasks(flow, now);
    }
  }
  await putAwayStale(new Date(now));
}

/** The campaign or subsequence a task came from, as it is now (null: deleted). */
async function flowOf(task: SequenceTaskRow): Promise<Flow | null> {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, task.campaignId ?? "")).limit(1);
  if (!campaign) return null;
  if (!task.subsequenceId) return { campaign, sub: null, steps: activeSteps(campaign) };
  const [sub] = await db.select().from(schema.subsequences).where(eq(schema.subsequences.id, task.subsequenceId)).limit(1);
  return sub ? { campaign, sub, steps: sub.sequences?.[0]?.steps ?? [] } : null;
}

/**
 * Marks a sequence's task done or skipped and moves its lead on to the next step (after the step's wait), or finishes
 * the sequence when it was the last (`finished`). `moved` is false when the lead had stopped waiting for it meanwhile.
 */
export async function finishSequenceTask(workspaceId: string, taskId: string, outcome: "done" | "skipped"): Promise<{ task: SequenceTaskRow; moved: boolean; finished: boolean }> {
  const [task] = await db
    .select()
    .from(T)
    .where(and(eq(T.id, taskId), eq(T.workspaceId, workspaceId), eq(T.source, "sequence")))
    .limit(1);
  if (!task) throw notFound("Task");
  if (task.status !== "open") throw conflict(`This task was already ${task.status === "done" ? "done" : "skipped"}.`);
  if (task.archivedAt) throw conflict("This lead isn't waiting for this task any more: it replied, was paused, moved or deleted.");
  const now = new Date();
  // The lead moves on before the task is marked finished: the other way round, for a moment its step would have no
  // open task, and the engine could make it another one.
  const flow = await flowOf(task);
  let moved = false;
  let last = false;
  if (flow && task.leadId && task.step !== null) {
    const p = place(flow);
    const step = flow.steps[task.step];
    last = task.step >= flow.steps.length - 1;
    const nextAt = last ? null : now.getTime() + delayToMs(step?.delay, step?.delay_unit);
    const rows = await db
      .update(L)
      .set(
        flow.sub
          ? { subseqNextStep: task.step + 1, subseqNextSendAt: nextAt, lastTouchAt: now, ...(last ? { subseqStatus: LeadStatus.COMPLETED } : {}) }
          : { nextStep: task.step + 1, nextSendAt: nextAt, lastTouchAt: now, ...(last ? { status: LeadStatus.COMPLETED, completedAt: now } : {}) },
      )
      .where(and(eq(L.id, task.leadId), p.inFlow, eq(p.step, task.step)))
      .returning({ replyCount: L.replyCount });
    moved = rows.length > 0;
    if (moved && last) {
      emit("lead_status_changed", workspaceId, { lead_id: task.leadId, campaign_id: flow.campaign.id, subsequence_id: flow.sub?.id ?? null, status: "completed", reply_count: rows[0]!.replyCount });
    }
  }
  // Finished on purpose: not put away, even if the engine noticed its lead had moved on in the meantime.
  const [row] = await db
    .update(T)
    .set({ status: outcome, completedAt: now, archivedAt: null })
    .where(and(eq(T.id, task.id), eq(T.status, "open")))
    .returning();
  if (!row) throw conflict("This task was finished meanwhile.");
  await recordEvent({
    workspaceId,
    type: outcome === "done" ? "task_done" : "task_skipped",
    campaignId: task.campaignId,
    subsequenceId: task.subsequenceId,
    leadId: task.leadId,
    leadEmail: task.leadEmail,
    step: task.step,
    detail: task.title,
  });
  return { task: row, moved, finished: moved && last };
}

/** Open tasks from sequences, oldest first, with what doing them needs: the lead's profile, phone and where they're from. */
export async function listSequenceTasks(workspaceId: string, limit = 100) {
  const C = schema.campaigns;
  const S = schema.subsequences;
  const where = and(eq(T.workspaceId, workspaceId), open);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        task: T,
        lead: { id: L.id, email: L.email, firstName: L.firstName, lastName: L.lastName, companyName: L.companyName, jobTitle: L.jobTitle, linkedinUrl: L.linkedinUrl, phone: L.phone, location: L.location, timezone: L.timezone },
        campaignName: C.name,
        subsequenceName: S.name,
      })
      .from(T)
      .leftJoin(L, eq(L.id, T.leadId))
      .leftJoin(C, eq(C.id, T.campaignId))
      .leftJoin(S, eq(S.id, T.subsequenceId))
      .where(where)
      .orderBy(asc(T.dueAt), asc(T.createdAt))
      .limit(limit),
    db.select({ n: sql<number>`count(*)` }).from(T).where(where),
  ]);
  return {
    total: Number(total?.n ?? 0),
    items: rows.map(({ task: t, lead, campaignName, subsequenceName }) => ({
      id: t.id,
      kind: t.stepKind,
      title: t.title,
      note: t.description,
      due_at: iso(t.dueAt),
      step: (t.step ?? 0) + 1,
      campaign: t.campaignId ? { id: t.campaignId, name: campaignName ?? null } : null,
      subsequence: t.subsequenceId ? { id: t.subsequenceId, name: subsequenceName ?? null } : null,
      assigned_to: t.assignedTo,
      lead: lead?.id
        ? {
            id: lead.id,
            email: lead.email,
            name: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || null,
            company_name: lead.companyName,
            job_title: lead.jobTitle,
            linkedin_url: lead.linkedinUrl,
            phone: lead.phone,
            location: lead.location,
            timezone: lead.timezone,
          }
        : null,
    })),
  };
}

/** How many tasks from sequences are waiting (the Today badge). */
export async function countSequenceTasks(workspaceId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(T).where(and(eq(T.workspaceId, workspaceId), open));
  return Number(row?.n ?? 0);
}
