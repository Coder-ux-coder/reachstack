// Lead finder (people/company dataset + enrichment), website visitors and automation workflows.
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AutomationGraph, AutomationStatus, RunStatus } from "@reachstack/shared";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const lfCompanies = sqliteTable(
  "lf_companies",
  {
    id: pk(),
    workspaceId: text("workspace_id"), // null = shared dataset for the installation
    name: text("name").notNull(),
    domain: text("domain"),
    industry: text("industry"),
    subIndustry: text("sub_industry"),
    employeeCount: integer("employee_count"),
    revenueRange: text("revenue_range"),
    foundedYear: integer("founded_year"),
    country: text("country"),
    state: text("state"),
    city: text("city"),
    description: text("description"),
    keywords: text("keywords"),
    technologies: json<string[]>("technologies"),
    funding: json<{ stage?: string; total?: number; last_round_at?: string }>("funding"),
    linkedinUrl: text("linkedin_url"),
    logoUrl: text("logo_url"),
    phone: text("phone"),
    news: json<Array<{ title: string; url?: string; date?: string; type?: string }>>("news"),
    jobPostings: json<Array<{ title: string; url?: string; date?: string }>>("job_postings"),
    createdAt: createdAt(),
  },
  (t) => [index("lf_companies_domain_idx").on(t.domain), index("lf_companies_industry_idx").on(t.industry)],
);

export const lfPeople = sqliteTable(
  "lf_people",
  {
    id: pk(),
    workspaceId: text("workspace_id"),
    companyId: text("company_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    title: text("title"),
    seniority: text("seniority"),
    department: text("department"),
    email: text("email"),
    emailStatus: text("email_status"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    country: text("country"),
    state: text("state"),
    city: text("city"),
    createdAt: createdAt(),
  },
  (t) => [index("lf_people_company_idx").on(t.companyId), index("lf_people_title_idx").on(t.title), index("lf_people_country_idx").on(t.country)],
);

/** People a workspace has revealed (paid credits) from the lead finder. */
export const lfUnlocks = sqliteTable(
  "lf_unlocks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    personId: text("person_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lf_unlocks_uq").on(t.workspaceId, t.personId)],
);

export const lfSavedSearches = sqliteTable(
  "lf_saved_searches",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    filters: json<Record<string, unknown>>("filters").notNull(),
    isHistory: bool("is_history").notNull().default(false),
    resultCount: integer("result_count"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("lf_saved_searches_ws_idx").on(t.workspaceId, t.isHistory, t.createdAt)],
);

export const enrichments = sqliteTable(
  "enrichments",
  {
    id: pk(),
    workspaceId: workspaceId(),
    resourceId: text("resource_id").notNull(),
    resourceType: integer("resource_type").notNull(), // 1 list, 2 campaign
    type: text("type").notNull(),
    enrichmentPayload: json<Record<string, unknown>>("enrichment_payload"),
    limit: integer("limit"),
    autoUpdate: bool("auto_update").default(false),
    skipRowsWithoutEmail: bool("skip_rows_without_email").default(false),
    inProgress: bool("in_progress").default(false),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("enrichments_resource_idx").on(t.resourceId)],
);

export const lfExports = sqliteTable("lf_exports", {
  id: pk(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  count: integer("count").notNull().default(0),
  filePath: text("file_path"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const evergreenJobs = sqliteTable(
  "evergreen_jobs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    type: text("type").notNull(), // supersearch_to_list | list_to_campaign
    name: text("name").notNull(),
    source: json<Record<string, unknown>>("source").notNull(),
    targetId: text("target_id").notNull(),
    dailyLimit: integer("daily_limit").notNull().default(50),
    status: text("status").notNull().default("active"),
    lastRunAt: ts("last_run_at"),
    totalMoved: integer("total_moved").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("evergreen_jobs_status_idx").on(t.status)],
);

export interface VisitorSiteSettings {
  /** Companies matching this profile are marked as a fit in the visitor list. */
  icp?: { industries?: string[]; employees?: string[]; revenue?: string[]; countries?: string[] };
  /** Path prefixes ("/admin", "/account/*") the snippet's visits are ignored on. */
  exclude_paths?: string[];
}

export const visitorSites = sqliteTable(
  "visitor_sites",
  {
    id: pk(),
    workspaceId: workspaceId(),
    domain: text("domain").notNull(),
    pixelKey: text("pixel_key").notNull(),
    settings: json<VisitorSiteSettings>("settings"),
    tosSignedAt: ts("tos_signed_at"),
    lastEventAt: ts("last_event_at"),
    /** First event received from the snippet (a test visit or a real one). */
    verifiedAt: ts("verified_at"),
    /** Last time the snippet saw a second snippet with a different key on the same page. */
    conflictAt: ts("conflict_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("visitor_sites_pixel_uq").on(t.pixelKey), index("visitor_sites_ws_idx").on(t.workspaceId)],
);

export const visitorSessions = sqliteTable(
  "visitor_sessions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    siteId: text("site_id").notNull(),
    visitorKey: text("visitor_key").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    companyName: text("company_name"),
    companyDomain: text("company_domain"),
    companyData: json<Record<string, unknown>>("company_data"),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    referrer: text("referrer"),
    utm: json<Record<string, string>>("utm"),
    landingUrl: text("landing_url"),
    pageviews: integer("pageviews").notNull().default(0),
    durationSec: integer("duration_sec").notNull().default(0),
    identified: bool("identified").notNull().default(false),
    /** pending (not looked up yet) | identified | unresolved (no business behind the address) | limit (monthly limit reached) */
    resolveStatus: text("resolve_status").notNull().default("pending"),
    resolveNote: text("resolve_note"),
    resolvedAt: ts("resolved_at"),
    /** Matching company in the lead finder dataset, when there is one. */
    companyId: text("company_id"),
    matchesIcp: bool("matches_icp"),
    leadId: text("lead_id"),
    hidden: bool("hidden").notNull().default(false),
    /** When a lookup of the visit's company started: others leave the visit alone until it ends (or a few minutes pass). */
    lookupAt: ts("lookup_at"),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
  },
  (t) => [
    index("visitor_sessions_ws_idx").on(t.workspaceId, t.lastSeenAt),
    index("visitor_sessions_key_idx").on(t.siteId, t.visitorKey),
    index("visitor_sessions_company_idx").on(t.workspaceId, t.companyDomain),
    index("visitor_sessions_status_idx").on(t.workspaceId, t.resolveStatus),
  ],
);

export const visitorPageviews = sqliteTable(
  "visitor_pageviews",
  {
    id: pk(),
    workspaceId: workspaceId(),
    sessionId: text("session_id").notNull(),
    url: text("url").notNull(),
    path: text("path"),
    title: text("title"),
    durationSec: integer("duration_sec").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("visitor_pageviews_session_idx").on(t.sessionId)],
);

export interface VisitorViewFilters {
  industries?: string[];
  employees?: string[];
  revenue?: string[];
  countries?: string[];
  /** Applied to the people considered for the best contact. */
  seniority?: string[];
  departments?: string[];
  /** Any page of the visit contains one of these. */
  url_contains?: string[];
  referrer_contains?: string[];
  icp_only?: boolean;
}

export interface VisitorViewDestinations {
  slack_connection_id?: string | null;
  webhook_url?: string | null;
  campaign_id?: string | null;
  list_id?: string | null;
  /** Verify the best contact's address when it is added. */
  verify?: boolean;
  /** Skip people already in any campaign (campaign target) or any list (list target). */
  check_duplicates?: boolean;
}

/** Tracking filters: identified visits that match send alerts and add the best contact to a campaign or list. */
export const visitorViews = sqliteTable(
  "visitor_views",
  {
    id: pk(),
    workspaceId: workspaceId(),
    siteId: text("site_id"),
    name: text("name").notNull(),
    filters: json<VisitorViewFilters>("filters").notNull(),
    destinations: json<VisitorViewDestinations>("destinations").notNull(),
    enabled: bool("enabled").notNull().default(true),
    matches: integer("matches").notNull().default(0),
    lastMatchAt: ts("last_match_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("visitor_views_ws_idx").on(t.workspaceId)],
);

/** One delivery per view, company and day (on the workspace clock); results per destination. */
export const visitorAlerts = sqliteTable(
  "visitor_alerts",
  {
    id: pk(),
    workspaceId: workspaceId(),
    viewId: text("view_id").notNull(),
    sessionId: text("session_id").notNull(),
    companyDomain: text("company_domain").notNull(),
    day: text("day").notNull(),
    results: json<Record<string, { ok: boolean; detail?: string | null }>>("results"),
    personId: text("person_id"),
    leadId: text("lead_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("visitor_alerts_uq").on(t.viewId, t.companyDomain, t.day), index("visitor_alerts_view_idx").on(t.viewId, t.createdAt)],
);

/** Workspace-wide website visitor settings: accepted terms and an optional IP lookup token. */
export const visitorSettings = sqliteTable("visitor_settings", {
  workspaceId: text("workspace_id").primaryKey(),
  termsVersion: text("terms_version"),
  termsAcceptedAt: ts("terms_accepted_at"),
  termsAcceptedBy: text("terms_accepted_by"),
  ipinfoTokenEnc: text("ipinfo_token_enc"),
  updatedAt: updatedAt(),
});

/** Automations: a trigger and the steps that follow it, as a graph (see packages/shared/src/automations.ts). */
export const workflows = sqliteTable(
  "workflows",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<AutomationStatus>().notNull().default("draft"),
    /** The trigger's catalog key, so events find their automations without reading every graph. */
    triggerType: text("trigger_type"),
    graph: json<AutomationGraph>("graph").notNull(),
    /** Bumped whenever the graph changes; runs remember the version they started on. */
    version: integer("version").notNull().default(1),
    /** Secret part of the URL that starts a "Catch a webhook" automation. */
    webhookToken: text("webhook_token"),
    /** The last requests received on that URL (newest first), offered as test data. */
    webhookSamples: json<Array<Record<string, unknown>>>("webhook_samples"),
    /** Schedule triggers: when the next run is due. */
    nextRunAt: ts("next_run_at"),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: ts("last_run_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflows_ws_trigger_idx").on(t.workspaceId, t.status, t.triggerType),
    uniqueIndex("workflows_webhook_token_uq").on(t.webhookToken),
    index("workflows_next_run_idx").on(t.status, t.nextRunAt),
  ],
);

/** One execution of an automation. `context` holds the engine's progress (see services/automations/engine.ts). */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    workflowId: text("workflow_id").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    triggerEvent: json<Record<string, unknown>>("trigger_event"),
    context: json<Record<string, unknown>>("context"),
    currentNodeId: text("current_node_id"),
    resumeAt: ts("resume_at"),
    logs: json<Array<{ at: string; node: string; level: string; message: string }>>("logs"),
    error: text("error"),
    durationMs: real("duration_ms"),
    /** Graph version the run started on: a run waiting on a delay is cancelled when the automation changed. */
    workflowVersion: integer("workflow_version").notNull().default(1),
    /** 0 for the original run, 1… for retries of it; retryOf points at the original run. */
    attempt: integer("attempt").notNull().default(0),
    retryOf: text("retry_of"),
    /** Started with "Run test" (sample data), not by a real event. */
    isTest: bool("is_test").notNull().default(false),
    leadEmail: text("lead_email"),
    /** Set while the engine works on the run; stale locks mean the process stopped mid-run. */
    lockedAt: ts("locked_at"),
    startedAt: createdAt(),
    updatedAt: ts("updated_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("workflow_runs_wf_idx").on(t.workflowId, t.startedAt),
    index("workflow_runs_resume_idx").on(t.status, t.resumeAt),
    index("workflow_runs_ws_idx").on(t.workspaceId, t.startedAt),
    // One run per attempt: two retries started at once can't both run the failed step again.
    uniqueIndex("workflow_runs_retry_attempt_uq").on(t.retryOf, t.attempt).where(sql`retry_of is not null`),
  ],
);

/** Company lists built from a company source (the local dataset or a connected data provider). */
export const companyLists = sqliteTable(
  "company_lists",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    providerId: text("provider_id").notNull(),
    companySourceId: text("company_source_id").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | IN_PROGRESS | COMPLETED | FAILED
    terminalReason: text("terminal_reason"),
    requestedCount: integer("requested_count").notNull(),
    companyCount: integer("company_count").notNull().default(0),
    savedCount: integer("saved_count").notNull().default(0),
    creditsCharged: integer("credits_charged").notNull().default(0),
    filters: json<Record<string, unknown>>("filters").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("company_lists_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const companyListMembers = sqliteTable(
  "company_list_members",
  {
    id: pk(),
    listId: text("list_id").notNull(),
    normalizedDomain: text("normalized_domain").notNull(),
    companyName: text("company_name"),
    data: json<Record<string, unknown>>("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("company_list_members_uq").on(t.listId, t.normalizedDomain)],
);

/** One run of an enrichment over a list or campaign (history shown next to the enrichment column). */
export const enrichmentRuns = sqliteTable(
  "enrichment_runs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    enrichmentId: text("enrichment_id").notNull(),
    resourceId: text("resource_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("running"), // running | completed | failed | cancelled
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    creditsUsed: real("credits_used").notNull().default(0),
    error: text("error"),
    jobId: text("job_id"),
    startedAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("enrichment_runs_resource_idx").on(t.resourceId, t.startedAt)],
);
