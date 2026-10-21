// "Ask AI" in the automation editor: Claude drafts an automation (or changes the open one) from a description,
// using only the catalog's triggers and actions and the workspace's own campaigns, lists, labels and people.
import { randomBytes } from "node:crypto";
import * as z from "zod/v4";
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_OPERATORS,
  actionDef,
  defaultConfig,
  layoutGraph,
  nodeLabel,
  triggerDef,
  type AutomationEdge,
  type AutomationGraph,
  type AutomationNode,
  type ConditionOperator,
  type FieldSpec,
  type OutputField,
} from "@reachstack/shared";
import { config } from "../../env";
import { isValidZone } from "../../lib/time";
import { structured } from "../ai";
import { workspaceZone } from "../workspace-clock";

export interface BuildOptions {
  campaigns: Array<{ id: string; name: string }>;
  lists: Array<{ id: string; name: string }>;
  labels: Array<{ code: number; label: string }>;
  members: Array<{ id: string; name: string; email: string }>;
  slack: Array<{ id: string; name: string }>;
  subsequences: Array<{ id: string; name: string; campaign_id: string; campaign_name: string | null }>;
  sites: Array<{ id: string; domain: string }>;
}

const nodeId = () => `n_${randomBytes(5).toString("hex")}`;

const TRIGGER_KEYS = AUTOMATION_TRIGGERS.map((t) => t.key) as [string, ...string[]];
const OPERATORS = CONDITION_OPERATORS.map((o) => o.value) as [ConditionOperator, ...ConditionOperator[]];
const setting = z.object({ field: z.string(), value: z.string() });
const planSchema = z.object({
  name: z.string().describe("A short name for the automation"),
  explanation: z.string().describe("One or two sentences for the user: what the automation does and anything they still need to fill in"),
  trigger: z.object({ key: z.enum(TRIGGER_KEYS), settings: z.array(setting) }),
  steps: z.array(
    z.object({
      id: z.string().describe("Short unique id such as s1"),
      after: z.string().describe('The id of the step this one follows, or "trigger"'),
      branch: z.enum(["none", "true", "false"]).describe("When `after` is a condition: the branch this step is on; otherwise none"),
      type: z.enum(["action", "condition", "delay"]),
      action: z.string().describe("For actions: the action key; otherwise empty"),
      name: z.string().describe("Optional step name; empty to use the action's name"),
      settings: z.array(setting),
      rules: z.array(z.object({ field: z.string(), operator: z.enum(OPERATORS), value: z.string() })).describe("For conditions: rules that must all match"),
      delay_amount: z.number().describe("For delays: how long; otherwise 0"),
      delay_unit: z.enum(["minutes", "hours", "days"]),
    }),
  ),
});
type Plan = z.infer<typeof planSchema>;

const VALUE_HINTS: Partial<Record<FieldSpec["kind"], string>> = {
  campaign: "a campaign id",
  destination: '"campaign:<id>" or "list:<id>"',
  member: "a member's user id",
  members: "member user ids, comma separated",
  label: 'a label code, or "none" for no label',
  slack: "a Slack connection id",
  subsequence: "a subsequence id",
  site: "a website id",
  lead: "a lead id or email, usually {{trigger.lead.id}}",
  keyvalue: 'a JSON object such as {"key": "value"}',
  datetime: "a date, or $now + 2d",
  time: "HH:MM",
  timezone: "an IANA time zone",
  boolean: "true or false",
  number: "a number",
  output_fields: 'a JSON array of {"name", "type", "description"}; type is text, number, boolean, enum (add "values") or array',
};

function fieldText(f: FieldSpec) {
  const options = f.options?.length ? `; one of: ${f.options.map((o) => (o.value === "" ? "empty" : o.value)).join(", ")}` : "";
  const extra = [f.required ? "required" : null, f.any ? "empty means any" : null, f.fromTrigger ? "{{trigger.campaign.id}} means the trigger's campaign" : null, f.default !== undefined ? `default ${JSON.stringify(f.default)}` : null]
    .filter(Boolean)
    .join(", ");
  return `${f.key} (${VALUE_HINTS[f.kind] ?? "text"}${options}${extra ? `; ${extra}` : ""})`;
}

/** "lead.email, lead.first_name, reply.text…" from an example output. */
function dataPaths(example: Record<string, unknown>, prefix: string): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(example)) {
    if (k === "example") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) for (const sub of Object.keys(v)) out.push(`${prefix}.${k}.${sub}`);
    else out.push(`${prefix}.${k}`);
  }
  return out.join(", ");
}

function catalogText() {
  const triggers = AUTOMATION_TRIGGERS.map((t) => `- ${t.key}: ${t.label}. ${t.description}${t.fields.length ? ` Settings: ${t.fields.map(fieldText).join("; ")}.` : ""} Data: ${dataPaths(t.example, "trigger")}`);
  const actions = AUTOMATION_ACTIONS.map((a) => `- ${a.key}: ${a.label}. ${a.description} Settings: ${a.fields.map(fieldText).join("; ")}. Returns: ${Object.keys(a.example).join(", ")}`);
  return `Triggers:\n${triggers.join("\n")}\n\nActions:\n${actions.join("\n")}\n\nCondition operators: ${OPERATORS.join(", ")}.`;
}

function optionsText(o: BuildOptions) {
  const list = (title: string, rows: string[]) => `${title}:\n${rows.length ? rows.join("\n") : "(none)"}`;
  return [
    list("Campaigns", o.campaigns.map((c) => `- ${c.id}: ${c.name}`)),
    list("Lists", o.lists.map((l) => `- ${l.id}: ${l.name}`)),
    list("Labels", o.labels.map((l) => `- ${l.code}: ${l.label}`)),
    list("Members", o.members.map((m) => `- ${m.id}: ${m.name} <${m.email}>`)),
    list("Slack connections", o.slack.map((s) => `- ${s.id}: ${s.name}`)),
    list("Subsequences", o.subsequences.map((s) => `- ${s.id}: ${s.name}${s.campaign_name ? ` (in ${s.campaign_name})` : ""}`)),
    list("Websites", o.sites.map((s) => `- ${s.id}: ${s.domain}`)),
  ].join("\n\n");
}

const system = () => `You design automations for ${config.brandName}, a cold email outreach product. An automation starts with one trigger and then runs steps. Build what the user asks for with only the triggers, actions and workspace options below.

How to answer:
- Every step names the step it follows in "after" ("trigger" for the first step). Steps that follow a condition set "branch" to "true" or "false"; all other steps use "none". Several steps may follow the same step.
- Use type "condition" with "rules" (all must match) to branch on data, "delay" with delay_amount and delay_unit to wait, and "action" with "action" set to an action key for everything else.
- Settings hold one entry per field you fill in, with the field keys listed. Leave out what you don't know; the user fills it in.
- Put data from the trigger or earlier steps into settings and rule values with {{trigger.lead.email}} or {{steps.<step id>.<field>}}. Rule fields are plain paths such as trigger.reply.text or steps.s1.score.
- Only use ids from the workspace options.
- Keep the automation as small as the request allows.

${catalogText()}`;

function settingValue(f: FieldSpec, raw: string): unknown {
  const v = raw.trim();
  // A choice given by its label ("Monday", "every week") is the option it names; anything else is left out.
  if (f.kind === "select" && f.options?.length) {
    const lower = v.toLowerCase();
    const option =
      f.options.find((o) => o.value === v) ??
      f.options.find((o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower) ??
      (lower.length >= 3 ? f.options.find((o) => o.label.toLowerCase().startsWith(lower) || lower.startsWith(o.label.toLowerCase())) : undefined);
    return option?.value;
  }
  switch (f.kind) {
    case "time": {
      const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(v);
      if (!m) return undefined;
      let hour = Number(m[1]);
      const minute = Number(m[2] ?? 0);
      if (m[3]) hour = (hour % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : undefined;
    }
    case "timezone":
      return isValidZone(v) ? v : undefined;
    case "boolean":
      return /^(true|yes|1|on)$/i.test(v);
    case "number": {
      const n = Number(v);
      return v && Number.isFinite(n) ? n : undefined;
    }
    case "members":
      return v
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    case "keyvalue": {
      try {
        const obj = JSON.parse(v) as Record<string, unknown>;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return Object.entries(obj).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
      } catch {
        // "key=value; key2=value2"
      }
      return v
        .split(/[;\n]+/)
        .map((pair) => pair.split("="))
        .filter((p) => p.length >= 2 && p[0]!.trim())
        .map(([key, ...rest]) => ({ key: key!.trim(), value: rest.join("=").trim() }));
    }
    case "output_fields": {
      try {
        const rows = JSON.parse(v) as Array<Partial<OutputField>>;
        const types = ["text", "number", "boolean", "enum", "array"];
        return (Array.isArray(rows) ? rows : [])
          .filter((r) => r && typeof r.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name))
          .map((r) => ({ name: r.name!, type: types.includes(String(r.type)) ? r.type! : "text", description: r.description ?? "", ...(Array.isArray(r.values) ? { values: r.values.map(String) } : {}) }));
      } catch {
        return [];
      }
    }
    default:
      return v;
  }
}

function configFrom(fields: FieldSpec[], settings: Plan["trigger"]["settings"], zone: string) {
  const out = defaultConfig(fields, zone);
  for (const s of settings) {
    const f = fields.find((x) => x.key === s.field);
    if (!f) continue;
    const value = settingValue(f, s.value);
    if (value !== undefined) out[f.key] = value;
  }
  return out;
}

/** Plan step ids → node ids in every {{steps.<id>…}} reference and rule field. */
function rewriteRefs<T>(value: T, ids: Map<string, string>): T {
  if (typeof value === "string") return value.replace(/(\bsteps\.)([A-Za-z0-9_-]+)/g, (m, head: string, id: string) => (ids.has(id) ? `${head}${ids.get(id)}` : m)) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, ids)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteRefs(v, ids)])) as T;
  return value;
}

function toGraph(plan: Plan, zone: string): AutomationGraph {
  const trigger = triggerDef(plan.trigger.key)!;
  const triggerNodeId = nodeId();
  const ids = new Map(plan.steps.map((s) => [s.id, nodeId()]));
  const nodes: AutomationNode[] = [{ id: triggerNodeId, type: "trigger", position: { x: 0, y: 0 }, data: { key: trigger.key, config: configFrom(trigger.fields, plan.trigger.settings, zone) } }];
  const edges: AutomationEdge[] = [];
  for (const s of plan.steps) {
    const id = ids.get(s.id)!;
    const def = s.type === "action" ? actionDef(s.action) : null;
    if (s.type === "action" && !def) continue;
    const name = s.name.trim() || null;
    if (s.type === "condition") nodes.push({ id, type: "condition", position: { x: 0, y: 0 }, data: { name, groups: [{ rules: s.rules.map((r) => ({ field: r.field.replace(/^\{\{\s*|\s*\}\}$/g, ""), operator: r.operator, value: r.value })) }] } });
    else if (s.type === "delay") nodes.push({ id, type: "delay", position: { x: 0, y: 0 }, data: { name, amount: Math.max(1, Math.round(s.delay_amount)), unit: s.delay_unit } });
    else nodes.push({ id, type: "action", position: { x: 0, y: 0 }, data: { name, key: def!.key, config: configFrom(def!.fields, s.settings, zone) } });
  }
  const present = new Set(nodes.map((n) => n.id));
  for (const s of plan.steps) {
    const target = ids.get(s.id)!;
    const source = s.after === "trigger" ? triggerNodeId : ids.get(s.after);
    if (!source || !present.has(source) || !present.has(target)) continue;
    const sourceNode = nodes.find((n) => n.id === source)!;
    const handle = sourceNode.type === "condition" ? (s.branch === "false" ? "false" : "true") : null;
    edges.push({ id: `e_${randomBytes(5).toString("hex")}`, source, target, sourceHandle: handle });
  }
  return layoutGraph(rewriteRefs({ nodes, edges }, ids));
}

/** A compact description of the open automation, so Claude can change it instead of starting over. */
function currentText(graph: AutomationGraph) {
  if (!graph.nodes.length) return "";
  const steps = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    key: n.data.key ?? undefined,
    name: nodeLabel(n),
    config: n.data.config && Object.keys(n.data.config).length ? n.data.config : undefined,
    rules: n.data.groups?.flatMap((g) => g.rules),
    delay: n.type === "delay" ? `${n.data.amount} ${n.data.unit}` : undefined,
    after: graph.edges.filter((e) => e.target === n.id).map((e) => (e.sourceHandle ? `${e.source} (${e.sourceHandle})` : e.source)),
  }));
  return `\n\nThe automation currently looks like this (return the whole automation with the change; you may reuse these ids):\n${JSON.stringify(steps)}`;
}

export async function buildAutomation(workspaceId: string, request: string, current: AutomationGraph, options: BuildOptions) {
  const zone = await workspaceZone(workspaceId);
  const plan = await structured({
    workspaceId,
    feature: "automation-builder",
    system: `${system()}\n\nThe workspace's timezone is ${zone}: schedule times are on it unless the user names another.\n\nWorkspace options:\n${optionsText(options)}`,
    messages: [{ role: "user", content: `${request.trim()}${currentText(current)}` }],
    schema: planSchema,
    effort: "medium",
    maxTokens: 16_000,
  });
  return { name: plan.name.trim().slice(0, 120) || "New automation", explanation: plan.explanation.trim(), graph: toGraph(plan, zone) };
}
