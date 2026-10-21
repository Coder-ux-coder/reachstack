// Lead filter rules and sorts for the leads tables (all leads, lists, campaign leads) and API v2 `rules`.
// The server validates rules and turns them into SQL; the web app builds them, shows them as chips and keeps them
// in the URL. Saved views store the same rules.

export const LEAD_TEXT_OPS = ["contains", "not_contains", "is", "is_not", "empty", "not_empty"] as const;
export const LEAD_SET_OPS = ["is", "is_not"] as const;
export const LEAD_BOOL_OPS = ["yes", "no"] as const;
export const LEAD_NUMBER_OPS = ["is", "is_not", "gte", "lte"] as const;
export const LEAD_DATE_OPS = ["before", "after", "within_days", "over_days", "empty", "not_empty"] as const;

export type LeadTextOp = (typeof LEAD_TEXT_OPS)[number];
export type LeadSetOp = (typeof LEAD_SET_OPS)[number];
export type LeadBoolOp = (typeof LEAD_BOOL_OPS)[number];
export type LeadNumberOp = (typeof LEAD_NUMBER_OPS)[number];
export type LeadDateOp = (typeof LEAD_DATE_OPS)[number];

export const LEAD_SET_FIELDS = ["status", "verification", "provider", "gateway"] as const;
export const LEAD_BOOL_FIELDS = ["opened", "replied", "clicked"] as const;
export const LEAD_TEXT_FIELDS = ["company_name", "company_domain", "job_title", "location"] as const;
export const LEAD_DATE_FIELDS = ["created", "last_contacted"] as const;

export type LeadRule =
  | { field: (typeof LEAD_SET_FIELDS)[number]; op: LeadSetOp; value: number[] }
  /** null in the list means "no lead status yet". */
  | { field: "interest"; op: LeadSetOp; value: Array<number | null> }
  /** Member user ids; null means nobody. */
  | { field: "owner"; op: LeadSetOp; value: Array<string | null> }
  | { field: (typeof LEAD_BOOL_FIELDS)[number]; op: LeadBoolOp }
  /** Steps of the main sequence sent so far (0 = not sent yet). */
  | { field: "step"; op: LeadNumberOp; value: number }
  | { field: (typeof LEAD_TEXT_FIELDS)[number]; op: LeadTextOp; value?: string }
  /** before/after take a date (YYYY-MM-DD or an ISO time); within_days/over_days take a number of days. */
  | { field: (typeof LEAD_DATE_FIELDS)[number]; op: LeadDateOp; value?: string | number }
  | { field: "custom"; key: string; op: LeadTextOp; value?: string }
  /** One of the quick filters (FILTER_VAL_…), so saved views keep it. */
  | { field: "preset"; op: "is"; value: string }
  /** The search box, so saved views keep it. */
  | { field: "search"; op: "contains"; value: string };

export type LeadRuleField = LeadRule["field"];

export type LeadFieldKind = "set" | "bool" | "number" | "text" | "date" | "custom";

export interface LeadFieldDef {
  field: Exclude<LeadRuleField, "preset" | "search">;
  label: string;
  kind: LeadFieldKind;
  /** Only meaningful for campaign leads (hidden on lists). */
  campaignOnly?: boolean;
}

/** The fields the filter builder offers, in menu order. */
export const LEAD_FILTER_FIELDS: LeadFieldDef[] = [
  { field: "status", label: "Status", kind: "set", campaignOnly: true },
  { field: "interest", label: "Lead status", kind: "set" },
  { field: "verification", label: "Email check", kind: "set" },
  { field: "provider", label: "Email provider", kind: "set" },
  { field: "gateway", label: "Security gateway", kind: "set" },
  { field: "owner", label: "Owner", kind: "set" },
  { field: "opened", label: "Opened", kind: "bool", campaignOnly: true },
  { field: "replied", label: "Replied", kind: "bool", campaignOnly: true },
  { field: "clicked", label: "Clicked a link", kind: "bool", campaignOnly: true },
  { field: "step", label: "Steps sent", kind: "number", campaignOnly: true },
  { field: "company_name", label: "Company", kind: "text" },
  { field: "company_domain", label: "Company domain", kind: "text" },
  { field: "job_title", label: "Job title", kind: "text" },
  { field: "location", label: "Location", kind: "text" },
  { field: "created", label: "Date added", kind: "date" },
  { field: "last_contacted", label: "Last contacted", kind: "date", campaignOnly: true },
  { field: "custom", label: "Custom variable", kind: "custom" },
];

export const LEAD_OP_LABELS: Record<string, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  empty: "is empty",
  not_empty: "has a value",
  yes: "yes",
  no: "no",
  gte: "is at least",
  lte: "is at most",
  before: "before",
  after: "on or after",
  within_days: "in the last",
  over_days: "more than",
};

/** Operators per field kind, in the order the builder lists them. */
export function leadFieldOps(field: LeadFieldDef["field"]): readonly string[] {
  const def = LEAD_FILTER_FIELDS.find((f) => f.field === field);
  switch (def?.kind) {
    case "set":
      return LEAD_SET_OPS;
    case "bool":
      return LEAD_BOOL_OPS;
    case "number":
      return LEAD_NUMBER_OPS;
    case "date":
      // Every lead has a date added, so only "last contacted" can be empty ("never").
      return field === "last_contacted" ? LEAD_DATE_OPS : LEAD_DATE_OPS.filter((o) => o !== "empty" && o !== "not_empty");
    default:
      return LEAD_TEXT_OPS;
  }
}

/** Operators that take no value. */
export const leadOpNeedsValue = (op: string) => !["empty", "not_empty", "yes", "no"].includes(op);

export const LEAD_SORT_KEYS = ["timestamp_created", "timestamp_last_contact", "name", "company_name", "email_open_count", "email_reply_count"] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

export const LEAD_SORTS: Array<{ key: LeadSortKey; label: string; order: "asc" | "desc"; campaignOnly?: boolean }> = [
  { key: "timestamp_created", label: "Date added", order: "desc" },
  { key: "timestamp_last_contact", label: "Last contacted", order: "desc", campaignOnly: true },
  { key: "name", label: "Name", order: "asc" },
  { key: "company_name", label: "Company", order: "asc" },
  { key: "email_open_count", label: "Opens", order: "desc", campaignOnly: true },
  { key: "email_reply_count", label: "Replies", order: "desc", campaignOnly: true },
];

/** Most rules a filter may combine. */
export const MAX_LEAD_RULES = 25;
