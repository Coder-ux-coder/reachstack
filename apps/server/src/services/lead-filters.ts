// Lead filter rules (the filter builder on the leads tables, API v2 `rules`), the quick filters, saved views and
// sorting. Every rule becomes a drizzle condition; values typed by people are always bound parameters.
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  CUSTOM_INTEREST_BASE,
  LEAD_BOOL_FIELDS,
  LEAD_BOOL_OPS,
  LEAD_DATE_FIELDS,
  LEAD_DATE_OPS,
  LEAD_NUMBER_OPS,
  LEAD_SET_FIELDS,
  LEAD_SET_OPS,
  LEAD_SORTS,
  LEAD_SORT_KEYS,
  LEAD_TEXT_FIELDS,
  LEAD_TEXT_OPS,
  LeadStatus,
  VerificationStatus,
  cleanDomain,
  leadOpNeedsValue,
  type LeadRule,
  type LeadSortKey,
  type LeadTextOp,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { badRequest } from "../http/errors";

const L = schema.leads;
const DAY = 86_400_000;

// ---------- Quick filters and search ----------

const INTEREST_FILTERS: Record<string, number> = {
  FILTER_LEAD_INTERESTED: 1,
  FILTER_LEAD_MEETING_BOOKED: 2,
  FILTER_LEAD_MEETING_COMPLETED: 3,
  FILTER_LEAD_CLOSED: 4,
  FILTER_LEAD_OUT_OF_OFFICE: 0,
  FILTER_LEAD_NOT_INTERESTED: -1,
  FILTER_LEAD_WRONG_PERSON: -2,
  FILTER_LEAD_LOST: -3,
  FILTER_LEAD_NO_SHOW: -4,
};

const PRESETS: Record<string, () => SQL[]> = {
  FILTER_VAL_CONTACTED: () => [isNotNull(L.lastContactAt)],
  FILTER_VAL_NOT_CONTACTED: () => [isNull(L.lastContactAt)],
  FILTER_VAL_COMPLETED: () => [eq(L.status, LeadStatus.COMPLETED)],
  FILTER_VAL_UNSUBSCRIBED: () => [eq(L.status, LeadStatus.UNSUBSCRIBED)],
  FILTER_VAL_ACTIVE: () => [eq(L.status, LeadStatus.ACTIVE)],
  FILTER_VAL_BOUNCED: () => [eq(L.status, LeadStatus.BOUNCED)],
  FILTER_VAL_SKIPPED: () => [eq(L.status, LeadStatus.SKIPPED)],
  FILTER_VAL_RISKY: () => [eq(L.verificationStatus, VerificationStatus.RISKY)],
  FILTER_VAL_INVALID: () => [eq(L.verificationStatus, VerificationStatus.INVALID)],
  FILTER_VAL_VALID: () => [eq(L.verificationStatus, VerificationStatus.VERIFIED)],
  FILTER_VAL_CATCH_ALL: () => [eq(L.verificationStatus, VerificationStatus.CATCH_ALL)],
  FILTER_VAL_NOT_VERIFIED: () => [eq(L.verificationStatus, VerificationStatus.NOT_VERIFIED)],
  FILTER_VAL_IN_SUBSEQUENCE: () => [isNotNull(L.subsequenceId)],
  // Added from a visit to your website (Website visitors).
  FILTER_VAL_WEBSITE_VISITOR: () => [eq(L.isWebsiteVisitor, true)],
  FILTER_VAL_OPENED_NO_REPLY: () => [gt(L.openCount, 0), eq(L.replyCount, 0)],
  FILTER_VAL_COMPLETED_NO_REPLY: () => [eq(L.status, LeadStatus.COMPLETED), eq(L.replyCount, 0)],
  FILTER_VAL_NO_OPENS: () => [eq(L.openCount, 0), isNotNull(L.lastContactAt)],
  FILTER_VAL_REPLIED: () => [gt(L.replyCount, 0)],
  FILTER_VAL_LINK_CLICKED: () => [gt(L.clickCount, 0)],
  FILTER_LEAD_CUSTOM_LABEL_POSITIVE: () => [gte(L.interestStatus, CUSTOM_INTEREST_BASE.positive), lt(L.interestStatus, CUSTOM_INTEREST_BASE.neutral)],
  FILTER_LEAD_CUSTOM_LABEL_NEGATIVE: () => [sql`${L.interestStatus} <= ${CUSTOM_INTEREST_BASE.negative}`],
};

const isPreset = (code: string) => code in PRESETS || code in INTEREST_FILTERS;

/** A quick filter (API v2 `filter`, FILTER_VAL_… codes) as conditions; empty means no filter. */
export function presetConditions(filter: string | undefined): SQL[] {
  if (!filter) return [];
  const preset = PRESETS[filter];
  if (preset) return preset();
  if (filter in INTEREST_FILTERS) return [eq(L.interestStatus, INTEREST_FILTERS[filter]!)];
  throw badRequest(`Unknown filter ${filter}`);
}

/** `%`, `_` and `\` typed by people match themselves inside LIKE patterns. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const containsPattern = (s: string) => `%${likeEscape(s.trim().toLowerCase())}%`;
const likeContains = (expr: SQL, s: string) => sql`${expr} like ${containsPattern(s)} escape '\\'`;

/** The search box: email, name, company or job title contains the text. */
export function searchCondition(search: string): SQL {
  return or(
    likeContains(sql`lower(coalesce(${L.email}, ''))`, search),
    likeContains(sql`lower(coalesce(${L.firstName}, '') || ' ' || coalesce(${L.lastName}, ''))`, search),
    likeContains(sql`lower(coalesce(${L.companyName}, ''))`, search),
    likeContains(sql`lower(coalesce(${L.jobTitle}, ''))`, search),
  )!;
}

// ---------- Rules ----------

const ISO_WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date ("2026-10-15": midnight on the workspace clock) or an ISO time (what the web app sends for the viewer's own midnight). */
function parseWhen(v: unknown, zone = "UTC"): Date | null {
  if (typeof v !== "string" || !ISO_WHEN.test(v)) return null;
  const t = v.length === 10 ? DateTime.fromISO(v, { zone }).toMillis() : Date.parse(v);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 1970 && year <= 2200 ? new Date(t) : null;
}

const text = z.string().trim().max(200);

const ruleUnion = z.discriminatedUnion("field", [
  z.object({ field: z.enum(LEAD_SET_FIELDS), op: z.enum(LEAD_SET_OPS), value: z.array(z.number().int()).min(1, "Pick at least one value").max(50) }),
  z.object({ field: z.literal("interest"), op: z.enum(LEAD_SET_OPS), value: z.array(z.number().int().nullable()).min(1, "Pick at least one lead status").max(50) }),
  z.object({ field: z.literal("owner"), op: z.enum(LEAD_SET_OPS), value: z.array(z.string().max(64).nullable()).min(1, "Pick at least one person").max(50) }),
  z.object({ field: z.enum(LEAD_BOOL_FIELDS), op: z.enum(LEAD_BOOL_OPS) }),
  z.object({ field: z.literal("step"), op: z.enum(LEAD_NUMBER_OPS), value: z.number().int().min(0).max(100) }),
  z.object({ field: z.enum(LEAD_TEXT_FIELDS), op: z.enum(LEAD_TEXT_OPS), value: text.optional() }),
  z.object({ field: z.enum(LEAD_DATE_FIELDS), op: z.enum(LEAD_DATE_OPS), value: z.union([z.string().trim().max(40), z.number()]).optional() }),
  z.object({ field: z.literal("custom"), key: z.string().trim().min(1, "Choose a custom variable").max(100), op: z.enum(LEAD_TEXT_OPS), value: text.optional() }),
  z.object({ field: z.literal("preset"), op: z.literal("is"), value: z.string().max(60) }),
  z.object({ field: z.literal("search"), op: z.literal("contains"), value: text.pipe(z.string().min(1, "Enter something to search for")) }),
]);

export const leadRuleSchema = ruleUnion.superRefine((r, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message });
  if (r.field === "preset") {
    if (!isPreset(r.value)) bad(`Unknown quick filter ${r.value}`);
  } else if ((LEAD_DATE_FIELDS as readonly string[]).includes(r.field) && "op" in r) {
    const v = (r as { value?: unknown }).value;
    if (r.op === "before" || r.op === "after") {
      if (!parseWhen(v)) bad("Enter a date like 2026-10-15");
    } else if (r.op === "within_days" || r.op === "over_days") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 3650) bad("Enter a number of days from 1 to 3650");
    } else if (r.field === "created") bad("Every lead has a date added; choose before, after or a number of days");
  } else if (r.field === "custom" || (LEAD_TEXT_FIELDS as readonly string[]).includes(r.field)) {
    const v = (r as { value?: string }).value;
    if (leadOpNeedsValue(r.op) && !v) bad("Enter a value");
  }
}) as unknown as z.ZodType<LeadRule>;

const lowerText = (expr: SQL | AnyColumn) => sql`lower(trim(coalesce(${expr}, '')))`;

function textCondition(expr: SQL | AnyColumn, op: LeadTextOp, raw: string | undefined): SQL {
  const value = lowerText(expr);
  const v = (raw ?? "").trim().toLowerCase();
  switch (op) {
    case "contains":
      return likeContains(value, v);
    case "not_contains":
      return sql`not (${likeContains(value, v)})`;
    case "is":
      return sql`${value} = ${v}`;
    case "is_not":
      return sql`${value} <> ${v}`;
    case "empty":
      return sql`${value} = ''`;
    case "not_empty":
      return sql`${value} <> ''`;
  }
}

/** One of several values (null = no value); "is not" also keeps rows without a value. */
function setCondition(col: AnyColumn, op: "is" | "is_not", values: Array<number | string | null>): SQL {
  const plain = values.filter((v): v is number | string => v !== null);
  const withNull = values.length !== plain.length;
  if (op === "is") return or(...[plain.length ? inArray(col, plain) : undefined, withNull ? isNull(col) : undefined].filter((c): c is SQL => !!c))!;
  return and(...[plain.length ? or(notInArray(col, plain), isNull(col)) : undefined, withNull ? isNotNull(col) : undefined].filter((c): c is SQL => !!c))!;
}

/** The value of one custom variable as text (null when the lead doesn't have it). The key is always a bound value. */
export const customValue = (key: string) =>
  /^[\w -]+$/.test(key)
    ? sql`cast(json_extract(${L.payload}, ${`$."${key}"`}) as text)`
    : sql`(select cast(j.value as text) from json_each(${L.payload}) j where j.key = ${key} limit 1)`;

const SET_COLUMNS = { status: L.status, verification: L.verificationStatus, provider: L.espCode, gateway: L.esgCode } as const;
const COUNTERS = { opened: L.openCount, replied: L.replyCount, clicked: L.clickCount } as const;
const TEXT_COLUMNS = { company_name: L.companyName, company_domain: L.companyDomain, job_title: L.jobTitle, location: L.location } as const;
const DATE_COLUMNS = { created: L.createdAt, last_contacted: L.lastContactAt } as const;

/** One validated rule as a condition. */
/** A rule as SQL; plain dates are midnight on `zone` (the workspace clock). */
export function ruleCondition(r: LeadRule, zone = "UTC"): SQL {
  switch (r.field) {
    case "status":
    case "verification":
    case "provider":
    case "gateway":
      return setCondition(SET_COLUMNS[r.field], r.op, r.value);
    case "interest":
      return setCondition(L.interestStatus, r.op, r.value);
    case "owner":
      return setCondition(L.assignedTo, r.op, r.value);
    case "opened":
    case "replied":
    case "clicked":
      return r.op === "yes" ? gt(COUNTERS[r.field], 0) : eq(COUNTERS[r.field], 0);
    case "step":
      if (r.op === "is") return eq(L.nextStep, r.value);
      if (r.op === "is_not") return ne(L.nextStep, r.value);
      return r.op === "gte" ? gte(L.nextStep, r.value) : lte(L.nextStep, r.value);
    case "company_name":
    case "job_title":
    case "location":
      return textCondition(TEXT_COLUMNS[r.field], r.op, r.value);
    case "company_domain":
      // "www.acme.com" or a pasted URL means acme.com.
      return textCondition(L.companyDomain, r.op, r.op === "is" || r.op === "is_not" ? cleanDomain(r.value) || r.value : r.value);
    case "created":
    case "last_contacted": {
      const col = DATE_COLUMNS[r.field];
      switch (r.op) {
        case "before":
          return lt(col, parseWhen(r.value, zone)!);
        case "after":
          return gte(col, parseWhen(r.value, zone)!);
        case "within_days":
          return gte(col, new Date(Date.now() - Number(r.value) * DAY));
        case "over_days":
          return lt(col, new Date(Date.now() - Number(r.value) * DAY));
        case "empty":
          return isNull(col);
        case "not_empty":
          return isNotNull(col);
      }
      break;
    }
    case "custom":
      return textCondition(customValue(r.key), r.op, r.value);
    case "preset":
      return and(...presetConditions(r.value)) ?? sql`1 = 1`;
    case "search":
      return searchCondition(r.value);
  }
  throw badRequest("Unknown filter rule");
}

// ---------- Sorting ----------

export interface SortKey {
  expr: SQL;
  dir: "asc" | "desc";
}

/**
 * Sort keys for a sort choice, ending with the lead id so the order is total. Leads without a value (never
 * contacted, no company) come last in both directions.
 */
export function leadSortKeys(by: LeadSortKey, order?: "asc" | "desc"): SortKey[] {
  const dir = order ?? LEAD_SORTS.find((s) => s.key === by)?.order ?? "desc";
  const key = (expr: SQL, d: "asc" | "desc" = dir): SortKey => ({ expr, dir: d });
  const emptyLast = (cond: SQL) => key(sql`(case when ${cond} then 1 else 0 end)`, "asc");
  const id = key(sql`${L.id}`);
  switch (by) {
    case "timestamp_created":
      return [key(sql`${L.createdAt}`), id];
    case "timestamp_last_contact":
      return [emptyLast(sql`${L.lastContactAt} is null`), key(sql`coalesce(${L.lastContactAt}, 0)`), id];
    case "name": {
      const name = sql`lower(coalesce(nullif(trim(coalesce(${L.firstName}, '') || ' ' || coalesce(${L.lastName}, '')), ''), ${L.email}, ''))`;
      return [emptyLast(sql`${name} = ''`), key(name), id];
    }
    case "company_name": {
      const company = lowerText(L.companyName);
      return [emptyLast(sql`${company} = ''`), key(company), id];
    }
    case "email_open_count":
      return [key(sql`${L.openCount}`), id];
    case "email_reply_count":
      return [key(sql`${L.replyCount}`), id];
  }
}

export const sortOrder = (keys: SortKey[]) => keys.map((k) => (k.dir === "asc" ? asc(k.expr) : desc(k.expr)));

/** Rows that come after a lead in this order (cursor pagination keeps `starting_after` a lead id). */
export async function afterLead(wsId: string, keys: SortKey[], leadId: string): Promise<SQL> {
  const fields = Object.fromEntries(keys.map((k, i) => [`k${i}`, k.expr]));
  const [row] = await db.select(fields).from(L).where(and(eq(L.id, leadId), eq(L.workspaceId, wsId))).limit(1);
  if (!row) throw badRequest("starting_after: that lead no longer exists. Load the list from the start.");
  const at = keys.map((_, i) => (row as Record<string, unknown>)[`k${i}`]);
  const steps = keys.map((k, i) => and(...keys.slice(0, i).map((p, j) => sql`${p.expr} = ${at[j]}`), k.dir === "asc" ? sql`${k.expr} > ${at[i]}` : sql`${k.expr} < ${at[i]}`)!);
  return or(...steps)!;
}

export const leadSortSchema = { sort_by: z.enum(LEAD_SORT_KEYS).optional(), sort_order: z.enum(["asc", "desc"]).optional() };

// ---------- Saved views ----------

const V = schema.crmViews;
export type SavedViewRow = typeof V.$inferSelect;

export async function findSavedView(wsId: string, id: string): Promise<SavedViewRow | null> {
  const [row] = await db.select().from(V).where(and(eq(V.id, id), eq(V.workspaceId, wsId))).limit(1);
  return row ?? null;
}

/** A saved view's rules, or null when it holds older activity queries instead. */
export function viewRules(view: SavedViewRow): LeadRule[] | null {
  const r = z.array(leadRuleSchema).safeParse(view.filters);
  return r.success ? r.data : null;
}

const viewSortSchema = z.array(z.object({ by: z.enum(LEAD_SORT_KEYS), order: z.enum(["asc", "desc"]) })).min(1);

export function viewSort(view: SavedViewRow): { by: LeadSortKey; order: "asc" | "desc" } | null {
  const r = viewSortSchema.safeParse(view.sort);
  return r.success ? r.data[0]! : null;
}

/** The sort a request asks for: its own, else its saved view's; null keeps the default (newest first). */
export async function requestedSort(wsId: string, f: { sort_by?: LeadSortKey; sort_order?: "asc" | "desc"; smart_view_id?: string }): Promise<SortKey[] | null> {
  if (f.sort_by) return leadSortKeys(f.sort_by, f.sort_order);
  if (f.smart_view_id) {
    const view = await findSavedView(wsId, f.smart_view_id);
    const s = view && viewSort(view);
    if (s) return leadSortKeys(s.by, s.order);
  }
  return null;
}

export function serializeSavedView(v: SavedViewRow) {
  const sort = viewSort(v);
  return {
    id: v.id,
    name: v.name,
    rules: viewRules(v) ?? [],
    sort_by: sort?.by ?? null,
    sort_order: sort?.order ?? null,
    created_by: v.createdBy,
    timestamp_created: v.createdAt.toISOString(),
    timestamp_updated: v.updatedAt.toISOString(),
  };
}
