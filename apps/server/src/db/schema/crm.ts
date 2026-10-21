import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const crmTasks = sqliteTable(
  "crm_tasks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull().default("todo"), // todo | call | email | linkedin | sms | meeting
    status: text("status").notNull().default("open"), // open | done
    priority: text("priority").notNull().default("normal"), // low | normal | high
    dueAt: ts("due_at"),
    assignedTo: text("assigned_to"),
    createdBy: text("created_by"),
    completedAt: ts("completed_at"),
    archivedAt: ts("archived_at"),
    source: text("source"), // manual | automation | salesflow | ai | sequence
    /** A sequence's task step (source "sequence"): the campaign or subsequence, the step (from 0) and its kind. */
    campaignId: text("campaign_id"),
    subsequenceId: text("subsequence_id"),
    step: integer("step"),
    stepKind: text("step_kind"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("crm_tasks_ws_due_idx").on(t.workspaceId, t.status, t.dueAt),
    index("crm_tasks_lead_idx").on(t.workspaceId, t.leadEmail),
    index("crm_tasks_lead_id_idx").on(t.leadId, t.status),
  ],
);

export const crmCalls = sqliteTable(
  "crm_calls",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    phoneNumber: text("phone_number").notNull(),
    fromNumber: text("from_number"),
    direction: text("direction").notNull().default("outbound"),
    status: text("status").notNull().default("completed"), // queued | ringing | in-progress | completed | no-answer | busy | failed
    outcome: text("outcome"), // connected | voicemail | no_answer | wrong_number | meeting_booked
    durationSec: integer("duration_sec").notNull().default(0),
    recordingUrl: text("recording_url"),
    notes: text("notes"),
    twilioSid: text("twilio_sid"),
    createdBy: text("created_by"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
  },
  (t) => [index("crm_calls_ws_idx").on(t.workspaceId, t.createdAt), index("crm_calls_lead_idx").on(t.workspaceId, t.leadEmail)],
);

export const crmSms = sqliteTable(
  "crm_sms",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    phoneNumber: text("phone_number").notNull(),
    fromNumber: text("from_number"),
    direction: text("direction").notNull().default("outbound"),
    body: text("body").notNull(),
    status: text("status").notNull().default("sent"),
    twilioSid: text("twilio_sid"),
    createdBy: text("created_by"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
  },
  (t) => [index("crm_sms_ws_idx").on(t.workspaceId, t.createdAt), index("crm_sms_lead_idx").on(t.workspaceId, t.leadEmail)],
);

export const crmPhoneNumbers = sqliteTable("crm_phone_numbers", {
  id: pk(),
  workspaceId: workspaceId(),
  number: text("number").notNull(),
  friendlyName: text("friendly_name"),
  twilioSid: text("twilio_sid"),
  capabilities: json<{ voice?: boolean; sms?: boolean }>("capabilities"),
  assignedTo: text("assigned_to"),
  createdAt: createdAt(),
});

export const crmMeetings = sqliteTable(
  "crm_meetings",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    title: text("title").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at"),
    location: text("location"),
    notes: text("notes"),
    status: text("status").notNull().default("scheduled"), // scheduled | completed | no_show | cancelled
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("crm_meetings_ws_idx").on(t.workspaceId, t.startAt)],
);

/** Saved CRM views (filters/sort/columns). */
export const crmViews = sqliteTable(
  "crm_views",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    entity: text("entity").notNull().default("leads"),
    filters: json<unknown[]>("filters").notNull(),
    sort: json<unknown[]>("sort"),
    columns: json<string[]>("columns"),
    isShared: bool("is_shared").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("crm_views_ws_idx").on(t.workspaceId)],
);

/** Sales flows: smart queues of leads based on activity queries (API: SalesFlow). */
export const salesFlows = sqliteTable(
  "sales_flows",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    isDefault: bool("is_default").default(false),
    queries: json<Array<{ actionType: string; values: Record<string, unknown> }>>("queries").notNull(),
    listId: text("list_id"),
    campaignId: text("campaign_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sales_flows_ws_idx").on(t.workspaceId)],
);

/** Deal details for a lead in the CRM pipeline (one row per lead email); the pipeline stage is the lead's
 * lt_interest_status, mirrored in `stage`. */
export const crmOpportunities = sqliteTable(
  "crm_opportunities",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    companyName: text("company_name"),
    companyDomain: text("company_domain"),
    name: text("name").notNull(),
    value: real("value").notNull().default(0),
    stage: integer("stage").notNull().default(1),
    ownerId: text("owner_id"),
    expectedCloseAt: ts("expected_close_at"),
    recurrence: text("recurrence").notNull().default("one_time"), // one_time | monthly | annual
    priority: text("priority").notNull().default("normal"), // normal | high
    wonAt: ts("won_at"),
    notes: text("notes"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("crm_opps_ws_stage_idx").on(t.workspaceId, t.stage),
    uniqueIndex("crm_opps_ws_lead_uq").on(t.workspaceId, t.leadEmail).where(sql`lead_email is not null`),
  ],
);
