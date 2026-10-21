import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const aiAgents = sqliteTable(
  "ai_agents",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    type: integer("type").notNull(),
    status: integer("status").notNull().default(0), // -1 error, 0 paused, 1 active
    configurationMode: text("configuration_mode"), // copilot | fully_automatic
    payload: json<Record<string, unknown>>("payload").notNull(),
    description: text("description"),
    isAutoCreated: bool("is_auto_created").default(false),
    createdBy: text("created_by"),
    lastRunAt: ts("last_run_at"),
    /** Held by the AI Inbox Manager pass running now (see runInboxManager); a pass cut short frees it once this passes. */
    runningUntil: ts("running_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_agents_ws_idx").on(t.workspaceId, t.type)],
);

export const aiAgentGuidance = sqliteTable(
  "ai_agent_guidance",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    label: text("label").notNull(),
    instruction: text("instruction").notNull().default(""),
    status: integer("status").notNull().default(1),
    category: integer("category").notNull().default(1), // 0 basics, 1 general, 2 objections, 3 scheduling, 4 knowledge
    basicGuidanceOptions: json<{ tone?: string; length?: string }>("basic_guidance_options"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_agent_guidance_agent_idx").on(t.agentId)],
);

/** Replies drafted/sent by the reply agent or the sales agent (inbox manager queue). */
export const aiAgentReplies = sqliteTable(
  "ai_agent_replies",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id"),
    threadId: text("thread_id"),
    inReplyToEmailId: text("in_reply_to"),
    leadEmail: text("lead"),
    accountEmail: text("account_email"),
    subject: text("subject"),
    html: text("html"),
    requiresHitl: bool("requires_hitl").default(false),
    requiresHitlReason: text("requires_hitl_reason"),
    confidenceScore: real("confidence_score"),
    sendingStatus: integer("sending_status").notNull().default(2), // 1 sent, 2 scheduled or awaiting approval, -1 failed
    actionPending: bool("action_pending").default(true),
    feedbackPositive: bool("feedback_positive"),
    feedbackText: text("feedback_text"),
    isFollowup: bool("is_followup").default(false),
    errorCode: text("error_code"),
    usageMetadata: json<Record<string, unknown>>("usage_metadata"),
    estimatedTimeSavedSeconds: integer("estimated_time_saved_seconds"),
    generationLagSeconds: real("generation_lag_seconds"),
    sentEmailId: text("sent_email_id"),
    scheduledSendAt: ts("scheduled_send_at"),
    informationRequested: text("information_requested"),
    isAutomaticEmail: bool("is_automatic_email").default(false),
    calendlyToolUsed: bool("calendly_tool_used").default(false),
    jobType: integer("job_type"), // 1 inbox reply, 2 follow-up, 3 no-show follow-up
    followupNumber: integer("followup_number"),
    leadId: text("lead_id"),
    campaignId: text("campaign_id"),
    accountId: text("account_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_agent_replies_ws_idx").on(t.workspaceId, t.createdAt), index("ai_agent_replies_agent_idx").on(t.agentId, t.sendingStatus)],
);

export const aiSalesAgents = sqliteTable(
  "ai_sales_agents",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull().default("website"), // website | pitch_deck
    input: text("input"),
    status: integer("status").notNull().default(0),
    phase: text("phase").notNull().default("learning"), // learning | scaling | paused | trial_ended
    config: json<Record<string, unknown>>("config").notNull(),
    agentType: integer("agent_type").notNull().default(2),
    selfImprovement: bool("self_improvement").default(true),
    masterLeadListId: text("master_lead_list_id"),
    initialScrapeReady: bool("initial_scrape_ready").notNull().default(false),
    lastActionAt: ts("timestamp_last_action"),
    lastDecisionAt: ts("timestamp_last_decision"),
    nextDecisionAt: ts("next_decision_time"),
    /** Set while a planning round runs (claimed atomically), so two rounds never overlap. */
    decidingUntil: ts("deciding_until"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_sales_agents_ws_idx").on(t.workspaceId)],
);

export const aiSalesAgentActivities = sqliteTable(
  "ai_sales_agent_activities",
  {
    id: pk(),
    workspaceId: workspaceId(),
    aiSdrId: text("ai_sdr_id").notNull(),
    actionType: text("action_type").notNull(),
    actionStatus: text("action_status").notNull().default("pending"),
    actionPayload: json<Record<string, unknown>>("action_payload"),
    actionOutput: json<Record<string, unknown>>("action_output"),
    emailId: text("email_id"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    rejectedBy: text("rejected_by"),
    rejectedAt: ts("rejected_at"),
    rejectionReason: text("rejection_reason"),
    aiReasoning: text("ai_reasoning"),
    aiConfidence: real("ai_confidence"),
    result: json<Record<string, unknown>>("result"),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    executedAt: ts("timestamp_executed"),
    completedAt: ts("timestamp_completed"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_sdr_activities_idx").on(t.aiSdrId, t.createdAt)],
);

export const copilotThreads = sqliteTable(
  "copilot_threads",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    pinned: bool("pinned").notNull().default(false),
    /** System prompt fixed when the thread starts, so later turns replay an unchanged prefix. */
    system: text("system"),
    status: text("status").notNull().default("idle"), // idle | running | waiting (a card needs the user)
    taskId: text("task_id"),
    /** Teammates in the workspace can open a shared chat's link (read only). */
    shared: bool("shared").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("copilot_threads_user_idx").on(t.workspaceId, t.userId, t.updatedAt)],
);

export const copilotMessages = sqliteTable(
  "copilot_messages",
  {
    id: pk(),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(), // user | assistant
    content: json<unknown>("content").notNull(), // Anthropic content blocks
    display: json<Record<string, unknown>>("display"), // UI cards rendered for tool results
    /** Tool results and other turns the model needs but the chat doesn't show. */
    hidden: bool("hidden").notNull().default(false),
    model: text("model"),
    stopReason: text("stop_reason"),
    feedback: json<{ helpful: boolean; text?: string | null; at: string }>("feedback"),
    createdAt: createdAt(),
  },
  (t) => [index("copilot_messages_thread_idx").on(t.threadId, t.createdAt)],
);

/** One tool the copilot ran (or asked to run): what the chat cards and the time-saved stats read. */
export const copilotActions = sqliteTable(
  "copilot_actions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    toolUseId: text("tool_use_id").notNull(),
    tool: text("tool").notNull(),
    input: json<Record<string, unknown>>("input").notNull(),
    status: text("status").notNull(), // running | done | error | awaiting_approval | denied | awaiting_answer | answered | skipped
    result: json<Record<string, unknown>>("result"),
    error: text("error"),
    secondsSaved: integer("seconds_saved").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("copilot_actions_tool_use_uq").on(t.threadId, t.toolUseId), index("copilot_actions_user_idx").on(t.workspaceId, t.userId, t.createdAt)],
);

export const copilotMemory = sqliteTable(
  "copilot_memory",
  {
    id: pk(),
    workspaceId: workspaceId(),
    key: text("key").notNull(), // business_details | icp | offer | case_studies | tone | custom:<name>
    data: json<Record<string, unknown>>("data").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("copilot_memory_ws_key_uq").on(t.workspaceId, t.key)],
);

export const copilotTasks = sqliteTable(
  "copilot_tasks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    frequency: text("frequency").notNull().default("once"), // once | daily | weekly | monthly
    timeOfDay: text("time_of_day").default("09:00"),
    timezone: text("timezone").default("UTC"),
    /** Monthly tasks: the day of the month they run on (the last day of a shorter month). */
    dayOfMonth: integer("day_of_month"),
    nextRunAt: ts("next_run_at"),
    lastRunAt: ts("last_run_at"),
    lastResult: text("last_result"),
    lastThreadId: text("last_thread_id"),
    status: text("status").notNull().default("active"), // active | paused
    lastStatus: text("last_status"), // success | failed | waiting
    lastError: text("last_error"),
    runCount: integer("run_count").notNull().default(0),
    sourceThreadId: text("source_thread_id"),
    /** Set while a run is in progress so two workers never run the same task. */
    lockedUntil: ts("locked_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("copilot_tasks_next_idx").on(t.status, t.nextRunAt)],
);

export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: pk(),
    workspaceId: workspaceId(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_ws_idx").on(t.workspaceId, t.createdAt)],
);

/** Event log of agents that keep a timeline (Lead Finder top-ups, inbox-manager recoveries). */
export const aiAgentEvents = sqliteTable(
  "ai_agent_events",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_agent_events_agent_idx").on(t.agentId, t.createdAt)],
);

/** One run of the Deliverability Agent over a workspace. */
export const deliverabilityCycles = sqliteTable(
  "deliverability_cycles",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull().default("running"), // running | completed
    totalChecks: integer("total_checks").notNull().default(0),
    healthyCount: integer("healthy_count").notNull().default(0),
    needsAttentionCount: integer("needs_attention_count").notNull().default(0),
    infoCount: integer("info_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    score: real("score"),
    startedAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("deliverability_cycles_agent_idx").on(t.agentId, t.startedAt)],
);

/** Individual checks inside a cycle. */
export const deliverabilityActivities = sqliteTable(
  "deliverability_activities",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    cycleId: text("cycle_id"),
    activityCode: text("activity_code").notNull(),
    status: text("status").notNull().default("queued"), // queued | in_progress | completed | failed | skipped | cancelled
    priority: integer("priority").notNull().default(50),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    subjectName: text("subject_name"),
    payload: json<Record<string, unknown>>("payload"),
    result: json<Record<string, unknown>>("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [index("deliverability_activities_agent_idx").on(t.agentId, t.status)],
);

/** Insights, recommendations and actions the Deliverability Agent shows in its feed. */
export const deliverabilityFeedItems = sqliteTable(
  "deliverability_feed_items",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    sourceActivityId: text("source_activity_id"),
    feedCode: text("feed_code").notNull(),
    kind: text("kind").notNull(), // insight | recommendation | action
    status: text("status").notNull().default("todo"), // todo | done | dismissed | failed
    severity: text("severity").notNull().default("info"), // info | success | warning | critical
    priority: integer("priority").notNull().default(50),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    subjectName: text("subject_name"),
    payload: json<Record<string, unknown>>("payload").notNull(),
    resultPayload: json<Record<string, unknown>>("result_payload"),
    actionCode: text("action_code"),
    actionStatus: text("action_status"),
    actionPayload: json<Record<string, unknown>>("action_payload"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
    dismissedAt: ts("dismissed_at"),
    expiresAt: ts("expires_at"),
  },
  (t) => [index("deliverability_feed_agent_idx").on(t.agentId, t.status, t.createdAt), index("deliverability_feed_dedupe_idx").on(t.agentId, t.dedupeKey)],
);

/** Saved AI-enrichment column sets the Lead Finder Agent can reuse. */
export const enrichmentWorkflows = sqliteTable("enrichment_workflows", {
  id: pk(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Sources an AI Sales Agent used to research and personalize for a lead. */
export const aiLeadResearch = sqliteTable(
  "ai_lead_research",
  {
    id: pk(),
    workspaceId: workspaceId(),
    agentId: text("agent_id").notNull(),
    leadId: text("lead_id").notNull(),
    research: json<{ grounding: Array<{ field: string; citations: Array<{ url: string; title: string }> }>; sources: Array<{ url: string }> }>("research").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_lead_research_uq").on(t.agentId, t.leadId)],
);
