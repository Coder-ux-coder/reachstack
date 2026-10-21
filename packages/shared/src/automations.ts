// Automations: the workflow graph stored per automation, the catalog of triggers and actions, the warnings
// shown on steps, and the helpers that resolve {{ }} references and evaluate conditions. The server runs
// graphs with these definitions; the web editor builds its forms, warnings and previews from the same ones.
import { CAMPAIGN_STATUS_LABELS, CRM_TASK_TYPES, type DelayUnit } from "./constants";
import { extractVariables, renderTemplate, type TemplateObject } from "./template";

export const AUTOMATION_STATUSES = ["draft", "active", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** queued: waiting for the engine · waiting: paused on a delay · error: a step failed */
export const RUN_STATUSES = ["queued", "running", "waiting", "success", "error", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
};

/** Retries allowed per failed run (each retry resumes at the failed step). */
export const MAX_RUN_RETRIES = 3;
/** Longest delay a step may wait. */
export const MAX_DELAY_DAYS = 30;
export const MAX_AUTOMATION_NODES = 100;

// ---------------------------------------------------------------------------------------------------------------
// Graph

export type NodeKind = "trigger" | "action" | "condition" | "delay" | "paths" | "merge";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "less_than"
  | "greater_or_equal"
  | "less_or_equal";

export interface ConditionRule {
  /** Path into the run data, e.g. "trigger.lead.email" or "steps.n_ab12.score". */
  field: string;
  operator: ConditionOperator;
  /** Compare value; may contain {{ }} references. */
  value?: string;
}

/** Rules inside a group must all match (AND); the condition passes when any group matches (OR). */
export interface ConditionGroup {
  rules: ConditionRule[];
}

export interface OutputField {
  name: string;
  type: "text" | "number" | "boolean" | "enum" | "array";
  description?: string;
  /** enum: the allowed values */
  values?: string[];
  min?: number | null;
  max?: number | null;
  integer?: boolean;
}

export interface NodeData {
  /** Custom step name; falls back to the trigger or action name. */
  name?: string | null;
  /** trigger and action: catalog key */
  key?: string | null;
  config?: Record<string, unknown>;
  /** Output of the last test: the sample record for a trigger, the result for an action. */
  sample?: Record<string, unknown> | null;
  tested?: boolean;
  /** condition */
  groups?: ConditionGroup[];
  /** delay */
  amount?: number | null;
  unit?: DelayUnit | null;
  /** paths: one outgoing branch per entry (edge sourceHandle = path id) */
  paths?: Array<{ id: string; name: string }>;
}

export interface AutomationNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: NodeData;
}

/** sourceHandle: null for the default output, "true"/"false" for conditions, a path id for paths. */
export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface AutomationGraph {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export const emptyGraph = (): AutomationGraph => ({ nodes: [], edges: [] });

/**
 * What the automation does, without layout, names and test data. Two graphs with the same signature run the same
 * way: saving a change to it gives the automation a new version (runs waiting on a delay stop).
 */
export function graphSignature(graph: AutomationGraph): string {
  const nodes = [...graph.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((n) => [n.id, n.type, n.data.key ?? null, n.data.config ?? {}, n.data.groups ?? null, n.data.amount ?? null, n.data.unit ?? null, (n.data.paths ?? []).map((p) => p.id)]);
  const edges = graph.edges.map((e) => `${e.source}>${e.target}:${e.sourceHandle ?? ""}`).sort();
  return JSON.stringify([nodes, edges]);
}

/** Distance between steps in the editor (pixels): columns side by side, rows top to bottom. */
export const NODE_GAP = { x: 300, y: 150 };

/** Order of a step's outgoing branches: a condition's true branch before false, paths as listed. */
function branchRank(node: AutomationNode | undefined, handle: string | null | undefined): number {
  if (node?.type === "condition") return handle === "false" ? 1 : 0;
  if (node?.type === "paths") return Math.max(0, (node.data.paths ?? []).findIndex((p) => p.id === handle));
  return 0;
}

/**
 * Top-down layout: each step a row below the step before it (the longest way down from the trigger), branches
 * side by side under their step, joins centred under the paths they join. Connections that loop back are ignored.
 */
export function layoutGraph(graph: AutomationGraph): AutomationGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
  const kids = new Map<string, string[]>();
  for (const e of edges) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  // Depth-first post-order, reversed: a topological order in which loop-closing connections point backwards.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    seen.add(id);
    for (const k of kids.get(id) ?? []) if (!seen.has(k)) visit(k);
    order.push(id);
  };
  const hasParent = new Set(edges.map((e) => e.target));
  const roots = [...graph.nodes.filter((n) => n.type === "trigger"), ...graph.nodes.filter((n) => n.type !== "trigger" && !hasParent.has(n.id))];
  for (const n of [...roots, ...graph.nodes]) if (!seen.has(n.id)) visit(n.id);
  order.reverse();
  const rank = new Map(order.map((id, i) => [id, i]));
  const forward = edges.filter((e) => rank.get(e.target)! > rank.get(e.source)!);
  const depth = new Map(order.map((id) => [id, 0]));
  for (const id of order) for (const e of forward) if (e.source === id) depth.set(e.target, Math.max(depth.get(e.target)!, depth.get(id)! + 1));

  const x = new Map<string, number>();
  const rows = new Map<number, string[]>();
  for (const id of order) rows.set(depth.get(id)!, [...(rows.get(depth.get(id)!) ?? []), id]);
  let rootX = 0;
  for (const d of [...rows.keys()].sort((a, b) => a - b)) {
    const items = rows
      .get(d)!
      .map((id) => {
        const parents = forward.filter((e) => e.target === id);
        // Several children of one step start where the step is; their branch order breaks the tie.
        const want = parents.length ? parents.reduce((s, e) => s + x.get(e.source)!, 0) / parents.length : (rootX += NODE_GAP.x) - NODE_GAP.x;
        const tie = parents.length ? Math.min(...parents.map((e) => branchRank(byId.get(e.source), e.sourceHandle))) : 0;
        return { id, want, tie };
      })
      .sort((a, b) => a.want - b.want || a.tie - b.tie);
    // Neighbours that would overlap form a block, centred on what its members want.
    const blocks: Array<{ items: typeof items; center: number }> = [];
    for (const item of items) {
      blocks.push({ items: [item], center: item.want });
      for (;;) {
        const b = blocks[blocks.length - 1]!;
        const a = blocks[blocks.length - 2];
        if (!a) break;
        const aRight = a.center + ((a.items.length - 1) * NODE_GAP.x) / 2;
        const bLeft = b.center - ((b.items.length - 1) * NODE_GAP.x) / 2;
        if (aRight + NODE_GAP.x <= bLeft + 0.5) break;
        const merged = [...a.items, ...b.items];
        blocks.splice(blocks.length - 2, 2, { items: merged, center: merged.reduce((s, i) => s + i.want, 0) / merged.length });
      }
    }
    for (const b of blocks) b.items.forEach((item, i) => x.set(item.id, b.center + (i - (b.items.length - 1) / 2) * NODE_GAP.x));
  }
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: { x: Math.round(x.get(n.id) ?? 0), y: (depth.get(n.id) ?? 0) * NODE_GAP.y } })) };
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog

export type AppKey = "core" | "slack" | "webhooks" | "schedule" | "manual" | "ai" | "tools";

export interface AppDef {
  key: AppKey;
  label: string;
  description: string;
  /** "apps" are products; "tools" are built-in helpers. */
  group: "apps" | "tools";
  /** The label is the product's own name (the web app shows the configured brand). */
  brand?: boolean;
}

export const AUTOMATION_APPS: AppDef[] = [
  { key: "core", label: "Reachstack", description: "Leads, campaigns, email accounts and CRM", group: "apps", brand: true },
  { key: "slack", label: "Slack", description: "Post messages to a channel", group: "apps" },
  { key: "webhooks", label: "Webhooks", description: "Receive or send HTTP requests", group: "tools" },
  { key: "schedule", label: "Schedule", description: "Start at set times", group: "tools" },
  { key: "manual", label: "Manual start", description: "Start with the Run button", group: "tools" },
  { key: "ai", label: "AI", description: "Read, classify or write with Claude", group: "tools" },
  { key: "tools", label: "Utilities", description: "Log messages while you build", group: "tools" },
];

export const appDef = (key: string | null | undefined) => AUTOMATION_APPS.find((a) => a.key === key) ?? null;

export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "campaign"
  | "destination"
  | "member"
  | "members"
  | "label"
  | "slack"
  | "subsequence"
  | "site"
  | "lead"
  | "keyvalue"
  | "datetime"
  | "time"
  | "timezone"
  | "output_fields";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** Accepts {{ }} references to the trigger and earlier steps. */
  templated?: boolean;
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  /** Only shown (and only required) while another field has one of these values. */
  when?: { key: string; is: unknown[] };
  /** Filters: offer "Any" (empty value). */
  any?: boolean;
  /** Campaign pickers: offer "The trigger's campaign". */
  fromTrigger?: boolean;
  /** keyvalue: suggested keys (free text is still allowed when `freeKeys`). */
  keys?: Array<{ value: string; label: string }>;
  freeKeys?: boolean;
  min?: number;
  max?: number;
}

export type TriggerObject = "lead" | "campaign" | "account" | "task" | "call" | "sms" | "visit" | "enrichment" | "webhook" | "schedule" | "manual";

export interface TriggerDef {
  /** Stored as the automation's trigger type; core triggers use the engine's event names. */
  key: string;
  app: AppKey;
  label: string;
  description: string;
  object: TriggerObject;
  fields: FieldSpec[];
  /** Output used when the trigger is tested with example data instead of a real record. */
  example: Record<string, unknown>;
}

export interface ActionDef {
  key: string;
  app: AppKey;
  label: string;
  description: string;
  fields: FieldSpec[];
  /** Output of a successful run, offered in the field picker before the step is tested. */
  example: Record<string, unknown>;
  /** Changes data here or elsewhere, so testing it really does it. */
  sideEffects: boolean;
}

const EXAMPLE_LEAD = {
  id: "00000000-0000-7000-8000-00000000e001",
  email: "jordan.lee@example.com",
  first_name: "Jordan",
  last_name: "Lee",
  full_name: "Jordan Lee",
  company_name: "Example Co",
  company_domain: "example.com",
  job_title: "Head of Growth",
  phone: "+1 555 0100",
  website: "https://example.com",
  linkedin_url: null,
  location: "Austin, TX",
  personalization: "Saw your post about scaling outbound.",
  label: "Interested",
  label_code: 1,
  status: "Active",
  owner_email: null,
  deal_value: null,
  campaign_id: "00000000-0000-7000-8000-00000000e002",
  list_id: null,
  custom: { industry: "Software" },
};
const EXAMPLE_CAMPAIGN = { id: "00000000-0000-7000-8000-00000000e002", name: "Example campaign" };
const ex = (event: string, extra: Record<string, unknown> = {}, withLead = true) => ({
  example: true,
  event,
  occurred_at: "2026-01-15T14:30:00.000Z",
  ...(withLead ? { lead: EXAMPLE_LEAD, campaign: EXAMPLE_CAMPAIGN } : {}),
  ...extra,
});

const campaignFilter: FieldSpec = { key: "campaign_id", label: "Campaign", kind: "campaign", any: true, hint: "Leave on “Any campaign” to run for every campaign." };

const CAMPAIGN_STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  ...[1, 2, 3, 4, -2, -1].map((code) => ({ value: String(code), label: CAMPAIGN_STATUS_LABELS[code]! })),
  { value: "deleted", label: "Deleted" },
];

export const AUTOMATION_TRIGGERS: TriggerDef[] = [
  {
    key: "reply_received",
    app: "core",
    label: "Lead replied",
    description: "A lead answers one of your emails.",
    object: "lead",
    fields: [campaignFilter, { key: "first_only", label: "Only a lead's first reply", kind: "boolean" }],
    example: ex("reply_received", {
      reply: { subject: "Re: Quick question", text: "Sounds interesting. Can you send pricing?", snippet: "Sounds interesting. Can you send pricing?", is_first: true, email_id: null, account_email: "you@yourdomain.com", unibox_url: null },
    }),
  },
  {
    key: "auto_reply_received",
    app: "core",
    label: "Auto-reply received",
    description: "An out-of-office or other automatic reply arrives.",
    object: "lead",
    fields: [campaignFilter],
    example: ex("auto_reply_received", { reply: { subject: "Out of office", text: "I'm away until Monday.", snippet: "I'm away until Monday.", is_first: false, email_id: null, account_email: "you@yourdomain.com", unibox_url: null } }),
  },
  {
    key: "email_sent",
    app: "core",
    label: "Email sent",
    description: "A campaign email goes out to a lead.",
    object: "lead",
    fields: [campaignFilter, { key: "step", label: "Only this step", kind: "number", min: 1, hint: "Step number in the sequence. Leave empty for every step." }],
    example: ex("email_sent", { email: { step: 1, account_email: "you@yourdomain.com", last_step: false, subsequence_id: null } }),
  },
  {
    key: "email_opened",
    app: "core",
    label: "Email opened",
    description: "A lead opens a campaign email (needs open tracking).",
    object: "lead",
    fields: [campaignFilter, { key: "first_only", label: "Only the first open", kind: "boolean" }],
    example: ex("email_opened", { email: { step: 1, is_first: true } }),
  },
  {
    key: "email_link_clicked",
    app: "core",
    label: "Link clicked",
    description: "A lead clicks a tracked link in a campaign email.",
    object: "lead",
    fields: [campaignFilter, { key: "url_contains", label: "Only links containing", kind: "text", placeholder: "/pricing" }],
    example: ex("email_link_clicked", { email: { step: 1 }, link: { url: "https://example.com/pricing" } }),
  },
  {
    key: "email_bounced",
    app: "core",
    label: "Email bounced",
    description: "A campaign email can't be delivered.",
    object: "lead",
    fields: [campaignFilter, { key: "hard_only", label: "Only hard bounces", kind: "boolean" }],
    example: ex("email_bounced", { bounce: { type: "hard" } }),
  },
  {
    key: "lead_unsubscribed",
    app: "core",
    label: "Lead unsubscribed",
    description: "A lead uses the unsubscribe link or asks to be removed.",
    object: "lead",
    fields: [campaignFilter],
    example: ex("lead_unsubscribed"),
  },
  {
    key: "lead_interest_changed",
    app: "core",
    label: "Lead label changed",
    description: "A lead gets a new label, such as Interested or Meeting booked.",
    object: "lead",
    fields: [{ key: "label", label: "New label", kind: "label", any: true }, campaignFilter],
    example: ex("lead_interest_changed", { label_change: { label: "Interested", code: 1, previous_label: null, previous_code: null, source: "user" } }),
  },
  {
    key: "lead_added",
    app: "core",
    label: "Lead added",
    description: "A lead is added to a campaign or list. A large import starts at most 1,000 runs.",
    object: "lead",
    fields: [{ key: "destination", label: "Added to", kind: "destination", any: true }],
    example: ex("lead_added", { list: null }),
  },
  {
    key: "lead_status_changed",
    app: "core",
    label: "Lead finished the sequence",
    description: "The last step of a campaign's sequence is sent to a lead.",
    object: "lead",
    fields: [campaignFilter, { key: "no_reply_only", label: "Only leads who never replied", kind: "boolean" }],
    example: ex("lead_status_changed", { sequence: { replied: false, subsequence_id: null } }),
  },
  {
    key: "campaign_status_changed",
    app: "core",
    label: "Campaign status changed",
    description: "A campaign is launched, paused, completed or stopped by bounce protection.",
    object: "campaign",
    fields: [campaignFilter, { key: "status", label: "New status", kind: "select", options: CAMPAIGN_STATUS_OPTIONS }],
    example: ex("campaign_status_changed", { campaign: EXAMPLE_CAMPAIGN, status: { code: 2, label: "Paused", previous_code: 1, previous_label: "Active", reason: null } }, false),
  },
  {
    key: "campaign_completed",
    app: "core",
    label: "Campaign completed",
    description: "Every lead in a campaign has finished the sequence.",
    object: "campaign",
    fields: [campaignFilter],
    example: ex("campaign_completed", { campaign: EXAMPLE_CAMPAIGN }, false),
  },
  {
    key: "account_error",
    app: "core",
    label: "Email account error",
    description: "A sending account stops working, for example after a password change.",
    object: "account",
    fields: [],
    example: ex("account_error", { account: { id: "00000000-0000-7000-8000-00000000e003", email: "you@yourdomain.com", error: "Authentication failed" } }, false),
  },
  {
    key: "account_added",
    app: "core",
    label: "Email account added",
    description: "A sending account is connected to the workspace.",
    object: "account",
    fields: [],
    example: ex("account_added", { account: { id: "00000000-0000-7000-8000-00000000e003", email: "you@yourdomain.com" } }, false),
  },
  {
    key: "crm_task_created",
    app: "core",
    label: "CRM task created",
    description: "A task is added in the CRM.",
    object: "task",
    fields: [],
    example: ex("crm_task_created", { task: { id: "00000000-0000-7000-8000-00000000e004", title: "Call Jordan", due_at: "2026-01-16T15:00:00.000Z", assigned_to: null } }),
  },
  {
    key: "call_completed",
    app: "core",
    label: "Call ended",
    description: "A CRM call finishes.",
    object: "call",
    fields: [],
    example: ex("call_completed", { call: { id: "00000000-0000-7000-8000-00000000e005", status: "completed", direction: "outbound", duration_sec: 184, outcome: "connected", phone_number: "+15550100" } }),
  },
  {
    key: "sms_received",
    app: "core",
    label: "Text message received",
    description: "A lead texts one of your CRM phone numbers.",
    object: "sms",
    fields: [],
    example: ex("sms_received", { sms: { id: "00000000-0000-7000-8000-00000000e006", from: "+15550100", body: "Thanks, talk tomorrow" } }),
  },
  {
    key: "website_visit",
    app: "core",
    label: "Website visitor identified",
    description: "A company visiting your website is identified.",
    object: "visit",
    fields: [
      { key: "site_id", label: "Website", kind: "site", any: true },
      { key: "icp_only", label: "Only companies that match your ideal customer profile", kind: "boolean" },
    ],
    example: ex(
      "website_visit",
      {
        visit: { id: "00000000-0000-7000-8000-00000000e007", site_id: null, landing_url: "https://yourdomain.com/pricing", pageviews: 3, duration_sec: 140, referrer: "https://www.google.com/", country: "US", city: "Austin" },
        company: { name: "Example Co", domain: "example.com", industry: "Software", employee_count: 120, country: "US", matches_icp: true },
      },
      false,
    ),
  },
  {
    key: "enrichment_completed",
    app: "core",
    label: "Lead Finder enrichment finished",
    description: "An enrichment run on a list or campaign completes.",
    object: "enrichment",
    fields: [],
    example: ex("enrichment_completed", { enrichment: { resource_id: EXAMPLE_CAMPAIGN.id, resource_type: "campaign", leads: 25, stop_reason: null } }, false),
  },
  {
    key: "webhook",
    app: "webhooks",
    label: "Catch a webhook",
    description: "Starts when another app sends a request to this automation's URL.",
    object: "webhook",
    fields: [],
    example: {
      example: true,
      event: "webhook",
      occurred_at: "2026-01-15T14:30:00.000Z",
      request: {
        method: "POST",
        body: { email: "jordan.lee@example.com", first_name: "Jordan", company: "Example Co" },
        query: {},
        headers: { "content-type": "application/json", "user-agent": "ExampleApp/1.0" },
        content_type: "application/json",
      },
    },
  },
  {
    key: "schedule",
    app: "schedule",
    label: "Run on a schedule",
    description: "Starts every few minutes, hours, days or weeks.",
    object: "schedule",
    fields: [
      {
        key: "frequency",
        label: "Repeat",
        kind: "select",
        required: true,
        default: "daily",
        options: [
          { value: "minutes", label: "Every few minutes" },
          { value: "hours", label: "Every few hours" },
          { value: "daily", label: "Every day" },
          { value: "weekly", label: "Every week" },
        ],
      },
      { key: "every", label: "Every", kind: "number", min: 1, max: 1440, default: 1, required: true, when: { key: "frequency", is: ["minutes", "hours"] }, hint: "Runs at least 15 minutes apart." },
      {
        key: "weekday",
        label: "On",
        kind: "select",
        default: "1",
        required: true,
        when: { key: "frequency", is: ["weekly"] },
        options: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => ({ value: String(i), label: d })),
      },
      { key: "time", label: "At", kind: "time", default: "09:00", required: true, when: { key: "frequency", is: ["daily", "weekly"] } },
      { key: "timezone", label: "Timezone", kind: "timezone", default: "UTC", required: true, when: { key: "frequency", is: ["daily", "weekly"] } },
    ],
    example: { example: true, event: "schedule", occurred_at: "2026-01-15T09:00:00.000Z", schedule: { scheduled_for: "2026-01-15T09:00:00.000Z", run_number: 1 } },
  },
  {
    key: "manual",
    app: "manual",
    label: "Start manually",
    description: "Runs only when someone clicks Run.",
    object: "manual",
    fields: [],
    example: { example: true, event: "manual", occurred_at: "2026-01-15T14:30:00.000Z", started_by: { name: "Alex Morgan", email: "alex@yourdomain.com" } },
  },
];

const leadField: FieldSpec = {
  key: "lead",
  label: "Lead",
  kind: "lead",
  templated: true,
  required: true,
  default: "{{trigger.lead.id}}",
  hint: "A lead ID or email address. Starts out as the trigger's lead.",
};

export const LEAD_FIELD_KEYS = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "company_name", label: "Company name" },
  { value: "company_domain", label: "Company domain" },
  { value: "job_title", label: "Job title" },
  { value: "phone", label: "Phone" },
  { value: "website", label: "Website" },
  { value: "linkedin_url", label: "LinkedIn URL" },
  { value: "location", label: "Location" },
  { value: "personalization", label: "Personalization" },
  { value: "pl_value_lead", label: "Deal value" },
];

const leadOut = (extra: Record<string, unknown> = {}) => ({ lead_id: EXAMPLE_LEAD.id, email: EXAMPLE_LEAD.email, ...extra });

export const AUTOMATION_ACTIONS: ActionDef[] = [
  {
    key: "set_lead_label",
    app: "core",
    label: "Set lead label",
    description: "Give the lead a label such as Interested, or clear it.",
    fields: [leadField, { key: "label", label: "Label", kind: "label", required: true, hint: "Choose “No label” to clear the lead's label." }],
    example: leadOut({ label: "Interested", label_code: 1, changed: true }),
    sideEffects: true,
  },
  {
    key: "move_lead",
    app: "core",
    label: "Move lead",
    description: "Move the lead to another campaign or list, or add a copy there.",
    fields: [
      leadField,
      { key: "destination", label: "Move to", kind: "destination", required: true },
      { key: "copy", label: "Keep the lead where it is and add a copy", kind: "boolean" },
    ],
    example: leadOut({ moved: true, moved_to: { type: "campaign", id: EXAMPLE_CAMPAIGN.id, name: EXAMPLE_CAMPAIGN.name }, copied: false, skipped_reason: null }),
    sideEffects: true,
  },
  {
    key: "add_lead",
    app: "core",
    label: "Add a lead",
    description: "Create a lead in a campaign or list from data in this automation.",
    fields: [
      { key: "destination", label: "Add to", kind: "destination", required: true },
      { key: "email", label: "Email", kind: "text", templated: true, required: true, placeholder: "{{trigger.request.body.email}}" },
      { key: "first_name", label: "First name", kind: "text", templated: true },
      { key: "last_name", label: "Last name", kind: "text", templated: true },
      { key: "company_name", label: "Company name", kind: "text", templated: true },
      { key: "job_title", label: "Job title", kind: "text", templated: true },
      { key: "phone", label: "Phone", kind: "text", templated: true },
      { key: "website", label: "Website", kind: "text", templated: true },
      { key: "personalization", label: "Personalization", kind: "textarea", templated: true },
      { key: "custom", label: "Custom variables", kind: "keyvalue", templated: true, freeKeys: true },
      { key: "skip_existing", label: "Skip if the lead is already in the workspace", kind: "boolean", default: true },
    ],
    example: leadOut({ added: true, skipped_reason: null, destination: { type: "campaign", id: EXAMPLE_CAMPAIGN.id, name: EXAMPLE_CAMPAIGN.name } }),
    sideEffects: true,
  },
  {
    key: "update_lead",
    app: "core",
    label: "Update lead fields",
    description: "Change the lead's details or custom variables.",
    fields: [leadField, { key: "values", label: "Fields to update", kind: "keyvalue", templated: true, required: true, keys: LEAD_FIELD_KEYS, freeKeys: true, hint: "Any other name is saved as a custom variable." }],
    example: leadOut({ updated: ["first_name"] }),
    sideEffects: true,
  },
  {
    key: "lead_sending",
    app: "core",
    label: "Pause, resume or stop a lead",
    description: "Change whether the campaign keeps emailing the lead.",
    fields: [
      leadField,
      {
        key: "mode",
        label: "Change to",
        kind: "select",
        required: true,
        options: [
          { value: "pause", label: "Pause sending" },
          { value: "resume", label: "Resume sending" },
          { value: "stop", label: "Stop: mark the sequence as finished" },
        ],
      },
    ],
    example: leadOut({ status: "Paused", changed: true }),
    sideEffects: true,
  },
  {
    key: "assign_lead",
    app: "core",
    label: "Assign lead owner",
    description: "Make a workspace member the lead's owner.",
    fields: [leadField, { key: "member", label: "Owner", kind: "member", required: true }],
    example: leadOut({ owner_email: "alex@yourdomain.com" }),
    sideEffects: true,
  },
  {
    key: "add_note",
    app: "core",
    label: "Add a note to the lead",
    description: "Save a note on the lead, shown in the CRM and Unibox.",
    fields: [leadField, { key: "note", label: "Note", kind: "textarea", templated: true, required: true }],
    example: leadOut({ note_id: "00000000-0000-7000-8000-00000000e008" }),
    sideEffects: true,
  },
  {
    key: "add_to_subsequence",
    app: "core",
    label: "Add lead to a subsequence",
    description: "Stop the main sequence and start one of the campaign's subsequences.",
    fields: [leadField, { key: "subsequence_id", label: "Subsequence", kind: "subsequence", required: true }],
    example: leadOut({ subsequence: { id: "00000000-0000-7000-8000-00000000e009", name: "Follow-up for openers" } }),
    sideEffects: true,
  },
  {
    key: "create_task",
    app: "core",
    label: "Create a CRM task",
    description: "Add a to-do, call or email task for your team.",
    fields: [
      { key: "title", label: "Title", kind: "text", templated: true, required: true, placeholder: "Call {{trigger.lead.first_name}}" },
      { key: "description", label: "Description", kind: "textarea", templated: true },
      { key: "type", label: "Type", kind: "select", default: "todo", options: CRM_TASK_TYPES.map((t) => ({ value: t, label: t === "todo" ? "To-do" : t === "sms" ? "SMS" : t === "linkedin" ? "LinkedIn" : t[0]!.toUpperCase() + t.slice(1) })) },
      {
        key: "priority",
        label: "Priority",
        kind: "select",
        default: "normal",
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
        ],
      },
      { key: "due", label: "Due", kind: "datetime", hint: "A date, or an expression such as $now + 2d." },
      { key: "assignee", label: "Assign to", kind: "member", hint: "Leave empty to leave the task unassigned." },
      { key: "lead_email", label: "Lead email", kind: "text", templated: true, default: "{{trigger.lead.email}}" },
    ],
    example: { task_id: "00000000-0000-7000-8000-00000000e004", title: "Call Jordan", due_at: "2026-01-17T14:30:00.000Z", assigned_to: null },
    sideEffects: true,
  },
  {
    key: "add_to_blocklist",
    app: "core",
    label: "Add to blocklist",
    description: "Never email this address (or its whole domain) again.",
    fields: [
      { key: "value", label: "Email or domain", kind: "text", templated: true, required: true, default: "{{trigger.lead.email}}" },
      { key: "block_domain", label: "Block the whole domain", kind: "boolean" },
    ],
    example: { value: "jordan.lee@example.com", added: true },
    sideEffects: true,
  },
  {
    key: "campaign_status",
    app: "core",
    label: "Pause or launch a campaign",
    description: "Change a campaign's status.",
    fields: [
      { key: "campaign_id", label: "Campaign", kind: "campaign", required: true, fromTrigger: true },
      {
        key: "status",
        label: "Set to",
        kind: "select",
        required: true,
        options: [
          { value: "pause", label: "Paused" },
          { value: "activate", label: "Active (launch or resume)" },
        ],
      },
    ],
    example: { campaign_id: EXAMPLE_CAMPAIGN.id, name: EXAMPLE_CAMPAIGN.name, status: "Paused", previous_status: "Active", changed: true },
    sideEffects: true,
  },
  {
    key: "notify_team",
    app: "core",
    label: "Email your team",
    description: "Send an email to workspace members.",
    fields: [
      { key: "to", label: "Send to", kind: "members", required: true },
      { key: "subject", label: "Subject", kind: "text", templated: true, required: true, placeholder: "{{trigger.lead.email}} replied" },
      { key: "body", label: "Message", kind: "textarea", templated: true, required: true },
    ],
    example: { sent_to: ["alex@yourdomain.com"], subject: "jordan.lee@example.com replied" },
    sideEffects: true,
  },
  {
    key: "slack_message",
    app: "slack",
    label: "Send a Slack message",
    description: "Post to the channel of a Slack connection.",
    fields: [
      { key: "connection_id", label: "Slack connection", kind: "slack", required: true },
      { key: "text", label: "Message", kind: "textarea", templated: true, required: true, placeholder: "{{trigger.lead.email}} replied: {{trigger.reply.snippet}}" },
    ],
    example: { delivered: true },
    sideEffects: true,
  },
  {
    key: "send_webhook",
    app: "webhooks",
    label: "Send a webhook",
    description: "Send an HTTP request to another app.",
    fields: [
      { key: "url", label: "URL", kind: "text", templated: true, required: true, placeholder: "https://example.com/hooks/new-lead" },
      {
        key: "method",
        label: "Method",
        kind: "select",
        default: "POST",
        options: ["POST", "PUT", "PATCH", "GET", "DELETE"].map((m) => ({ value: m, label: m })),
      },
      {
        key: "body_mode",
        label: "Body",
        kind: "select",
        default: "trigger",
        when: { key: "method", is: ["POST", "PUT", "PATCH", "DELETE"] },
        options: [
          { value: "trigger", label: "All trigger data (JSON)" },
          { value: "fields", label: "Fields I choose (JSON)" },
          { value: "raw", label: "Custom text" },
        ],
      },
      { key: "fields", label: "Fields", kind: "keyvalue", templated: true, freeKeys: true, required: true, when: { key: "body_mode", is: ["fields"] } },
      { key: "raw", label: "Body text", kind: "textarea", templated: true, required: true, when: { key: "body_mode", is: ["raw"] } },
      { key: "headers", label: "Headers", kind: "keyvalue", templated: true, freeKeys: true },
    ],
    example: { status: 200, ok: true, body: { received: true } },
    sideEffects: true,
  },
  {
    key: "ai_prompt",
    app: "ai",
    label: "Ask AI",
    description: "Have Claude read the data and return the fields you define.",
    fields: [
      { key: "prompt", label: "Instructions", kind: "textarea", templated: true, required: true, placeholder: "Read this reply and score how interested the lead is: {{trigger.reply.text}}" },
      { key: "output_fields", label: "Fields to return", kind: "output_fields", required: true, default: [{ name: "answer", type: "text", description: "" }] },
    ],
    example: { answer: "Example answer" },
    sideEffects: false,
  },
  {
    key: "log",
    app: "tools",
    label: "Add a log message",
    description: "Write a message to the run's log, to check values while you build.",
    fields: [{ key: "message", label: "Message", kind: "textarea", templated: true, required: true }],
    example: { message: "Example message" },
    sideEffects: false,
  },
];

export const triggerDef = (key: string | null | undefined) => AUTOMATION_TRIGGERS.find((t) => t.key === key) ?? null;
export const actionDef = (key: string | null | undefined) => AUTOMATION_ACTIONS.find((a) => a.key === key) ?? null;

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  trigger: "Trigger",
  action: "Action",
  condition: "Condition",
  delay: "Delay",
  paths: "Paths",
  merge: "Join paths",
};

/** The step's display name. */
export function nodeLabel(node: Pick<AutomationNode, "type" | "data">): string {
  if (node.data.name?.trim()) return node.data.name.trim();
  if (node.type === "trigger") return triggerDef(node.data.key)?.label ?? "Trigger";
  if (node.type === "action") return actionDef(node.data.key)?.label ?? "Action";
  return NODE_KIND_LABELS[node.type];
}

/** Apps used by an automation, in catalog order (shown in the list). */
export function graphApps(graph: AutomationGraph): AppKey[] {
  const used = new Set<AppKey>();
  for (const n of graph.nodes) {
    const def = n.type === "trigger" ? triggerDef(n.data.key) : n.type === "action" ? actionDef(n.data.key) : null;
    if (def) used.add(def.app);
  }
  return AUTOMATION_APPS.map((a) => a.key).filter((k) => used.has(k));
}

/** Config with every field's default filled in (used when a trigger or action is picked). */
/** A step's settings before anyone changes them; a timezone starts on `zone` (the workspace's) when it's given. */
export function defaultConfig(fields: FieldSpec[], zone?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === "timezone" && zone) out[f.key] = zone;
    // Copies, so editing a step's list never changes the catalog's default.
    else if (f.default !== undefined) out[f.key] = f.default !== null && typeof f.default === "object" ? JSON.parse(JSON.stringify(f.default)) : f.default;
  }
  return out;
}

/** Example output of an AI step: one example value per output field. */
export function aiExample(fields: OutputField[] | null | undefined): Record<string, unknown> {
  if (!fields?.length) return { answer: "Example answer" };
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.name) continue;
    out[f.name] =
      f.type === "number" ? (f.min ?? 0) : f.type === "boolean" ? true : f.type === "enum" ? (f.values?.[0] ?? "") : f.type === "array" ? ["Example"] : "Example";
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Field visibility and requirements

/** Whether a field is shown; pass the config merged with defaults (see defaultConfig). */
export function fieldVisible(field: FieldSpec, config: Record<string, unknown>): boolean {
  return !field.when || field.when.is.includes(config[field.when.key] as never);
}

function isBlank(field: FieldSpec, value: unknown): boolean {
  if (field.kind === "boolean") return false;
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) {
    if (field.kind === "keyvalue") return !value.some((row) => typeof row === "object" && row && String((row as { key?: unknown }).key ?? "").trim());
    if (field.kind === "output_fields") return !value.some((row) => typeof row === "object" && row && String((row as { name?: unknown }).name ?? "").trim());
    return value.length === 0;
  }
  return false;
}

/** Labels of required fields that are empty (only fields currently shown count). */
export function missingFields(fields: FieldSpec[], config: Record<string, unknown> = {}): string[] {
  const withDefaults = { ...defaultConfig(fields), ...config };
  return fields.filter((f) => f.required && fieldVisible(f, withDefaults) && isBlank(f, withDefaults[f.key])).map((f) => f.label);
}

// ---------------------------------------------------------------------------------------------------------------
// Warnings

export interface NodeWarning {
  code: string;
  message: string;
  /** Blocking warnings keep the automation from being activated. */
  blocking: boolean;
}

export interface GraphWarnings {
  graph: NodeWarning[];
  nodes: Record<string, NodeWarning[]>;
  blocking: number;
}

const block = (code: string, message: string): NodeWarning => ({ code, message, blocking: true });
const advise = (code: string, message: string): NodeWarning => ({ code, message, blocking: false });

/** Step ids referenced as {{steps.<id>…}} in a config value, condition or text. */
export function referencedSteps(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const name of extractVariables(value)) {
      const m = /^steps\.([A-Za-z0-9_-]+)/.exec(name);
      if (m) out.add(m[1]!);
    }
  } else if (Array.isArray(value)) value.forEach((v) => referencedSteps(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => referencedSteps(v, out));
  return out;
}

function conditionReferences(groups: ConditionGroup[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const g of groups ?? []) {
    for (const r of g.rules ?? []) {
      const m = /^steps\.([A-Za-z0-9_-]+)/.exec(r.field ?? "");
      if (m) out.add(m[1]!);
      referencedSteps(r.value ?? "", out);
    }
  }
  return out;
}

const NO_VALUE_OPERATORS: ConditionOperator[] = ["is_empty", "is_not_empty"];

/** Ids of nodes that sit on a cycle (connections that loop back to an earlier step). */
function cyclicNodes(graph: AutomationGraph): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const state = new Map<string, 1 | 2>();
  const onCycle = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const t of next.get(id) ?? []) {
      if (state.get(t) === 1) stack.slice(stack.indexOf(t)).forEach((n) => onCycle.add(n));
      else if (!state.get(t)) visit(t);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const n of graph.nodes) if (!state.get(n.id)) visit(n.id);
  return onCycle;
}

/** Everything that keeps an automation from running as intended, per step. */
export function automationWarnings(graph: AutomationGraph): GraphWarnings {
  const nodes: Record<string, NodeWarning[]> = {};
  const graphWarnings: NodeWarning[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const incoming = (id: string) => graph.edges.filter((e) => e.target === id && ids.has(e.source));
  const outgoing = (id: string, handle?: string | null) =>
    graph.edges.filter((e) => e.source === id && ids.has(e.target) && (handle === undefined || (e.sourceHandle ?? null) === handle));
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (!triggers.length) graphWarnings.push(block("no_trigger", "Add a trigger to start this automation."));
  if (triggers.length > 1) graphWarnings.push(block("many_triggers", "An automation can only have one trigger. Delete the extra ones."));
  const cyclic = cyclicNodes(graph);

  for (const n of graph.nodes) {
    const list: NodeWarning[] = [];
    const config = n.data.config ?? {};
    if (n.type === "trigger") {
      const def = triggerDef(n.data.key);
      if (!def) list.push(block("trigger_not_configured", "Trigger not configured. Choose an app and a trigger event."));
      else {
        const missing = missingFields(def.fields, config);
        if (missing.length) list.push(block("missing_fields", `Fill in the required fields: ${missing.join(", ")}.`));
        if (!n.data.tested) list.push(advise("trigger_not_tested", "Trigger not tested. Test it to check it works and to pick fields from real data."));
      }
      if (!outgoing(n.id).length) list.push(block("trigger_no_outgoing", "No step connected. Connect an action to continue the automation."));
    } else if (n.type === "action") {
      const def = actionDef(n.data.key);
      if (!incoming(n.id).length) list.push(block("disconnected", "This step is not connected, so it never runs. Connect it to the automation."));
      if (!def) list.push(block("action_not_configured", "Action not configured. Choose an app and an action."));
      else {
        const missing = missingFields(def.fields, config);
        if (missing.length) list.push(block("missing_fields", `Fill in the required fields: ${missing.join(", ")}.`));
        if (!n.data.tested) list.push(advise("action_not_tested", "Action not tested yet."));
      }
    } else if (n.type === "condition") {
      if (!incoming(n.id).length) list.push(block("condition_no_incoming", "No incoming connection. Connect this condition to a trigger or action."));
      const groups = n.data.groups ?? [];
      const incomplete = !groups.length || groups.some((g) => !g.rules?.length || g.rules.some((r) => !r.field || !r.operator || (!NO_VALUE_OPERATORS.includes(r.operator) && r.value === undefined)));
      if (incomplete) list.push(block("condition_not_configured", "Condition not configured. Choose a field and an operator for every rule."));
      if (!outgoing(n.id, "true").length) list.push(block("condition_no_true_branch", "Connect a step to the true (green) branch. The false branch is optional."));
    } else if (n.type === "delay") {
      if (!incoming(n.id).length) list.push(block("delay_no_incoming", "No incoming connection. Connect this delay to an earlier step."));
      if (!outgoing(n.id).length) list.push(block("delay_no_outgoing", "No outgoing connection. Connect the step that comes after this delay."));
      const error = delayError(n.data.amount, n.data.unit);
      if (error) list.push(block("delay_not_configured", error));
    } else if (n.type === "paths") {
      if (!incoming(n.id).length) list.push(block("paths_no_incoming", "No incoming connection. Connect these paths to an earlier step."));
      for (const p of n.data.paths ?? []) {
        if (!outgoing(n.id, p.id).length) list.push(advise("path_empty", `Path “${p.name}” has no steps yet.`));
      }
    } else if (n.type === "merge") {
      if (incoming(n.id).length < 2) list.push(block("merge_inputs", "Connect at least two paths to join them."));
      if (!outgoing(n.id).length) list.push(block("merge_no_outgoing", "No outgoing connection. Connect the step that comes after the joined paths."));
    }
    const refs = n.type === "condition" ? conditionReferences(n.data.groups) : referencedSteps(config);
    const missingRefs = [...refs].filter((id) => !ids.has(id));
    if (missingRefs.length) list.push(block("invalid_reference", "A field uses data from a step that was deleted. Update the field."));
    if (cyclic.has(n.id)) list.push(block("cycle", "This step loops back to an earlier step. Remove the connection that closes the loop."));
    if (list.length) nodes[n.id] = list;
  }
  const blocking = graphWarnings.filter((w) => w.blocking).length + Object.values(nodes).reduce((s, l) => s + l.filter((w) => w.blocking).length, 0);
  return { graph: graphWarnings, nodes, blocking };
}

export function delayError(amount: number | null | undefined, unit: DelayUnit | null | undefined): string | null {
  if (!unit) return "Delay not configured. Choose minutes, hours or days.";
  if (amount === null || amount === undefined || !(amount > 0)) return "Delay not configured. The amount must be greater than 0.";
  if (!Number.isInteger(amount)) return "The delay must be a whole number.";
  const minutes = amount * (unit === "days" ? 1440 : unit === "hours" ? 60 : 1);
  if (minutes > MAX_DELAY_DAYS * 1440) return `A delay can be at most ${MAX_DELAY_DAYS} days.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Data references and conditions

/** The data a step can reference: {{trigger.…}}, {{steps.<id>.…}}, {{workflow.…}}, {{run.…}}, {{now}}. */
export interface RunVariables extends TemplateObject {
  trigger: TemplateObject;
  steps: TemplateObject;
}

function pathSegments(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return out;
}

/** Reads a dotted path ("trigger.lead.email", "steps.n1.items[0]"); keys match case-insensitively when not exact. */
export function getPath(vars: unknown, path: string): unknown {
  const segments = pathSegments(path.trim());
  if (!segments.length) return undefined;
  let node: unknown = vars;
  for (const seg of segments) {
    if (node === null || node === undefined) return undefined;
    if (typeof seg === "number" || (Array.isArray(node) && /^\d+$/.test(seg))) {
      if (!Array.isArray(node)) return undefined;
      node = node[Number(seg)];
      continue;
    }
    if (typeof node !== "object") return undefined;
    const obj = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, seg)) node = obj[seg];
    else {
      const key = Object.keys(obj).find((k) => k.toLowerCase() === seg.toLowerCase());
      node = key === undefined ? undefined : obj[key];
    }
  }
  return node;
}

/**
 * Data for testing steps in the editor: the trigger's test record (or its example), and for every action what
 * its test returned (or its example output).
 */
export function testVariables(graph: AutomationGraph, workflow: { id: string; name: string }): RunVariables {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const steps: Record<string, unknown> = {};
  for (const n of graph.nodes) {
    if (n.type !== "action") continue;
    const def = actionDef(n.data.key);
    steps[n.id] = n.data.sample ?? (def?.key === "ai_prompt" ? aiExample(n.data.config?.output_fields as OutputField[] | undefined) : (def?.example ?? null));
  }
  return {
    trigger: (trigger?.data.sample ?? triggerDef(trigger?.data.key)?.example ?? {}) as TemplateObject,
    steps: steps as TemplateObject,
    workflow: { id: workflow.id, name: workflow.name },
    run: { id: null, attempt: 0, is_test: true },
    now: new Date().toISOString(),
  };
}

const SINGLE_TOKEN = /^\s*\{\{\s*([^{}|]+?)\s*\}\}\s*$/;

/**
 * Resolves a templated field. A field that is exactly one reference keeps the referenced value's type
 * (numbers, lists and objects stay structured); anything else renders to text.
 */
export function resolveValue(template: unknown, vars: RunVariables): unknown {
  if (typeof template !== "string") return template;
  const single = SINGLE_TOKEN.exec(template);
  if (single && !/^random$/i.test(single[1]!.trim())) {
    const v = getPath(vars, single[1]!);
    return v === undefined ? "" : v;
  }
  return renderTemplate(template, vars).output;
}

/** Like resolveValue, but always text (objects and lists become JSON). */
export function resolveText(template: unknown, vars: RunVariables): string {
  const v = resolveValue(template, vars);
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const CONDITION_OPERATORS: Array<{ value: ConditionOperator; label: string; needsValue: boolean }> = [
  { value: "equals", label: "Equals", needsValue: true },
  { value: "not_equals", label: "Does not equal", needsValue: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "not_contains", label: "Does not contain", needsValue: true },
  { value: "is_empty", label: "Is empty", needsValue: false },
  { value: "is_not_empty", label: "Is not empty", needsValue: false },
  { value: "greater_than", label: "Greater than", needsValue: true },
  { value: "less_than", label: "Less than", needsValue: true },
  { value: "greater_or_equal", label: "Greater than or equal", needsValue: true },
  { value: "less_or_equal", label: "Less than or equal", needsValue: true },
];

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).trim().toLowerCase();
const numeric = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};
const empty = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);

export interface RuleResult {
  field: string;
  operator: ConditionOperator;
  left: unknown;
  right: string;
  result: boolean;
}

export function evaluateRule(rule: ConditionRule, vars: RunVariables): RuleResult {
  const left = getPath(vars, rule.field ?? "");
  const right = rule.operator === "is_empty" || rule.operator === "is_not_empty" ? "" : resolveText(rule.value ?? "", vars);
  const r = right.trim().toLowerCase();
  const contains = () => (Array.isArray(left) ? left.some((x) => text(x) === r || text(x).includes(r)) : text(left).includes(r));
  let result: boolean;
  switch (rule.operator) {
    case "equals":
      result = Array.isArray(left) ? left.some((x) => text(x) === r) : text(left) === r;
      break;
    case "not_equals":
      result = Array.isArray(left) ? !left.some((x) => text(x) === r) : text(left) !== r;
      break;
    case "contains":
      result = contains();
      break;
    case "not_contains":
      result = !contains();
      break;
    case "is_empty":
      result = empty(left);
      break;
    case "is_not_empty":
      result = !empty(left);
      break;
    case "greater_than":
      result = numeric(left) > numeric(right);
      break;
    case "less_than":
      result = numeric(left) < numeric(right);
      break;
    case "greater_or_equal":
      result = numeric(left) >= numeric(right);
      break;
    case "less_or_equal":
      result = numeric(left) <= numeric(right);
      break;
    default:
      result = false;
  }
  return { field: rule.field, operator: rule.operator, left, right, result };
}

/** OR across groups, AND inside a group. Returns per-rule details for the condition test view. */
export function evaluateCondition(groups: ConditionGroup[] | undefined, vars: RunVariables) {
  const details = (groups ?? []).map((g) => {
    const rules = (g.rules ?? []).map((r) => evaluateRule(r, vars));
    return { result: rules.length > 0 && rules.every((r) => r.result), rules };
  });
  return { result: details.some((g) => g.result), groups: details };
}

// ---------------------------------------------------------------------------------------------------------------
// Date expressions ("$now", "$now + 7d")

const OFFSET_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "$now" or "$now + 30m / 24h / 7d / 2w / 1M" (additions only); null when the text isn't an expression. */
export function parseDateExpression(expr: string, now: Date = new Date()): Date | null {
  const m = /^\s*\$now((?:\s*\+\s*\d+\s*[mhdwM])*)\s*$/.exec(expr);
  if (!m) return null;
  const d = new Date(now.getTime());
  const re = /\+\s*(\d+)\s*([mhdwM])/g;
  let part: RegExpExecArray | null;
  while ((part = re.exec(m[1]!))) {
    const n = Number(part[1]);
    if (part[2] === "M") d.setUTCMonth(d.getUTCMonth() + n);
    else d.setTime(d.getTime() + n * OFFSET_MS[part[2]!]!);
  }
  return d;
}

/** How far a timezone's clock is ahead of UTC at an instant, in ms. */
function zoneOffsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/** "2026-03-01", "2026-03-01 15:00" or "2026-03-01T15:00": a date, and maybe a time, with no timezone. */
const WALL_TIME = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*$/;

/** A date and time as `zone`'s clock shows it; null for one that doesn't exist (February 30th, 25:00). */
function wallTimeIn(zone: string, m: RegExpExecArray): Date | null {
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "9", m[5] ?? "0", m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    // Twice, for a clock change between the guess and the answer.
    return new Date(wall - zoneOffsetMs(zone, wall - zoneOffsetMs(zone, wall)));
  } catch {
    return null; // not a timezone
  }
}

/**
 * A date from a fixed value or an expression; null when it can't be read. With `zone` (the workspace's), a date and
 * time without a timezone is that time on its clock, and a date alone 9:00 there, as a task's due date in the CRM.
 */
export function resolveDate(value: unknown, now: Date = new Date(), zone?: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const expr = parseDateExpression(value, now);
    if (expr) return expr;
    const wall = zone ? WALL_TIME.exec(value) : null;
    if (wall) return wallTimeIn(zone!, wall);
  }
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}
