// Minimal stand-in for POST /v1/messages: records each request and answers with a canned message.
// Usage: node anthropic-mock.mjs [log file] [port]   (log file optional; it records full request bodies)
import http from "node:http";
import fs from "node:fs";
import { copilotStream } from "./copilot.mjs";
const log = process.argv[2];
const port = Number(process.argv[3] ?? 4999);

/** Canned reply drafts keyed off the newest prospect message in the <thread> block. */
function draftFor(said) {
  const thread = /<thread>([\s\S]*?)<\/thread>/.exec(said)?.[1] ?? "";
  const lastProspect = thread.split(/\n\n(?=\[)/).filter((m) => / PROSPECT /.test(m)).pop() ?? "";
  const link = /<booking_link>(.*?)<\/booking_link>/.exec(said)?.[1];
  const name = /"first_name":"([^"]*)"/.exec(said)?.[1] ?? "there";
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(said)?.[1] ?? "";
  const base = { needs_human: false, human_reason: "", information_requested: "", used_booking_link: false };
  if (/follow-up #/.test(task)) return { ...base, decision: "reply", reply_text: `Hi ${name},\n\nJust floating this back up in case it got buried. Happy to share a two-minute overview if useful.\n\nAlex`, confidence: 82 };
  if (/no-show/.test(task)) return { ...base, decision: "reply", reply_text: `Hi ${name},\n\nLooks like we missed each other. No worries at all. ${link ? `Grab a new time here: ${link}` : "Which times work for you this week?"}\n\nAlex`, confidence: 85, used_booking_link: !!link };
  if (/unsubscribe|remove me|stop/i.test(lastProspect)) return { ...base, decision: "no_reply", reply_text: "", confidence: 95 };
  if (/price|pricing|cost|contract/i.test(lastProspect)) return { ...base, decision: "reply", reply_text: `Hi ${name},\n\nGood question. Plans start at $49 per mailbox per month.\n\nAlex`, confidence: 55, needs_human: true, human_reason: "Pricing question" };
  if (/not interested|no thanks|not a fit/i.test(lastProspect)) return { ...base, decision: "reply", reply_text: `Understood, ${name}. Thanks for letting me know.\n\nAlex`, confidence: 90 };
  if (/integrat/i.test(lastProspect)) return { ...base, decision: "request_info", reply_text: "", confidence: 30, information_requested: "Which CRMs do we integrate with?" };
  return {
    ...base,
    decision: "reply",
    reply_text: `Hi ${name},\n\nGreat to hear from you. ${link ? `You can pick a time that suits you here: ${link}` : "Which times work for you this week?"}\n\nAlex`,
    confidence: 88,
    used_booking_link: !!link,
  };
}

/** Business brief for the Sales Agent setup, using industries from the allowed list in the prompt. */
function memoryFor(said) {
  const allowed = (/<allowed_industries>(.*?)<\/allowed_industries>/.exec(said)?.[1] ?? "").split(" | ");
  const pick = (name) => (allowed.includes(name) ? [name] : []);
  return {
    company: "Northwind Ops",
    business_description: "Northwind Ops builds customer onboarding software for B2B service companies. Teams use it to launch new accounts faster and keep renewals on track.",
    business_offers: ["A 20-minute onboarding audit", "A two-week pilot with one team"],
    icps: [
      { name: "Customer success leaders in business services", problems_solved: ["Slow onboarding", "Churn surprises"], benefits: ["Faster time to value"], usp: "Playbooks built for services firms", customer_goals: ["Raise renewals"], job_titles: ["VP of Customer Success"], industries: pick("Business Services"), company_sizes: [] },
      { name: "Founders at financial services firms", problems_solved: ["Manual client setup"], benefits: ["Fewer handoffs"], usp: "Compliance-ready templates", customer_goals: ["Scale without hiring"], job_titles: ["Founder & CEO"], industries: pick("Financial Services"), company_sizes: [] },
    ],
  };
}

/** Three-step sequence; the campaign name follows the prefix the prompt asks for. */
function sequenceFor(said) {
  const prefix = /campaign_name: "(.*?) · <short ICP label>"/.exec(said)?.[1] ?? "Agent";
  const icp = /"name": "([^"]+)"/.exec(said)?.[1] ?? "Buyers";
  const challenger = /<performance>/.test(said);
  return {
    campaign_name: `${prefix} · ${icp.split(" ").slice(0, 3).join(" ")}`,
    steps: [
      { delay_days: 0, subject: challenger ? "a different idea" : "onboarding at {{companyName}}", body: "{{personalization}}\n\nHi {{firstName}}, teams like yours often lose weeks getting new accounts live. We help shorten that.\n\nWorth a 20-minute audit?\n\n{{sendingAccountFirstName}}" },
      { delay_days: 3, subject: "", body: "Hi {{firstName}}, one more thought: most of the delay sits in handoffs between sales and delivery.\n\n{{sendingAccountFirstName}}" },
      { delay_days: 4, subject: "", body: "Hi {{firstName}}, should I close the loop on this?\n\n{{sendingAccountFirstName}}" },
    ],
    reasoning: challenger ? "Leads with the handoff problem instead of speed." : "Opens with the onboarding delay this profile feels most.",
  };
}

/** Opening line grounded in the first research note, when there is one. */
function researchFor(said) {
  const note = /<note url="([^"]+)">\n([\s\S]*?)\n<\/note>/.exec(said);
  const company = /"company":"([^"]*)"/.exec(said)?.[1] ?? "your company";
  if (!note) return { first_line: `Your role at ${company} puts onboarding speed squarely on your desk.`, used_facts: [] };
  return { first_line: `Saw the recent news at ${company}: ${note[2].trim().slice(0, 60)}.`, used_facts: [{ fact: note[2].trim().slice(0, 80), source_url: note[1] }] };
}

/** "Ask AI" automation step: one plausible value per requested field. */
function fillFields(schema) {
  const out = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const t = prop.type;
    out[key] = prop.enum ? prop.enum[0] : t === "number" || t === "integer" ? 7 : t === "boolean" ? true : t === "array" ? ["Mock item"] : `Mock ${key.replace(/_/g, " ")}`;
  }
  return out;
}

/** Automation draft for "Ask AI" in the automation editor. */
function automationFor(said) {
  const slack = /slack/i.test(said);
  const none = { action: "", name: "", settings: [], rules: [], delay_amount: 0, delay_unit: "minutes" };
  return {
    name: slack ? "Pricing replies to Slack" : "Label pricing replies",
    explanation: slack ? "When a lead asks about pricing, they're labelled Interested and the team hears about it in Slack. Pick the Slack connection to finish." : "When a lead asks about pricing, they're labelled Interested and a note is logged.",
    trigger: { key: "reply_received", settings: [{ field: "first_only", value: "false" }] },
    steps: [
      { ...none, id: "s1", after: "trigger", branch: "none", type: "condition", name: "Asks about pricing", rules: [{ field: "trigger.reply.text", operator: "contains", value: "pricing" }] },
      { ...none, id: "s2", after: "s1", branch: "true", type: "action", action: "set_lead_label", settings: [{ field: "label", value: "1" }] },
      slack
        ? { ...none, id: "s3", after: "s2", branch: "none", type: "action", action: "slack_message", settings: [{ field: "text", value: "{{trigger.lead.email}} asked about pricing: {{trigger.reply.snippet}}" }] }
        : { ...none, id: "s3", after: "s2", branch: "none", type: "action", action: "log", settings: [{ field: "message", value: "Labelled {{steps.s2.email}} as {{steps.s2.label}}" }] },
    ],
  };
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    if (log) fs.appendFileSync(log, JSON.stringify({ url: req.url, headers: { beta: req.headers["anthropic-beta"], key: req.headers["x-api-key"] ? "(set)" : null }, body: json }) + "\n");
    if (json.stream && (json.tools ?? []).some((t) => t.name === "get_workspace_overview")) return copilotStream(json, res);
    const format = json.output_config?.format;
    const props = Object.keys(format?.schema?.properties ?? {});
    if (props.includes("follow_ups")) {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_mock" });
      return res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text: JSON.stringify({ follow_ups: ["Write a sequence for this audience", "Which campaign has the best reply rate?", "Audit my workspace"] }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 80, output_tokens: 30 } }));
    }
    const last = [...(json.messages ?? [])].reverse().find((m) => m.role === "user");
    const said = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join(" ");
    const name = /"first_name":\s*"([^"]*)"/.exec(said)?.[1];
    const sys = JSON.stringify(json.system ?? "");
    const stepProps = Object.keys(format?.schema?.properties?.steps?.items?.properties ?? {});
    let text;
    if (props.includes("trigger") && props.includes("steps")) text = JSON.stringify(automationFor(said));
    else if (/You are one step in an automation/.test(sys)) text = JSON.stringify(fillFields(format?.schema));
    else if (props.includes("job_titles"))
      text = JSON.stringify({
        job_titles: /sales/i.test(said) ? ["Head of Sales", "VP Sales", "Sales Director"] : ["Founder", "CEO"],
        exclude_job_titles: ["Intern"],
        levels: ["VP-Level", "Director-Level", "vp-level"],
        departments: /sales/i.test(said) ? ["Sales"] : [],
        locations: /united states|us\b|usa/i.test(said) ? ["United States"] : [],
        industries: /software|saas/i.test(said) ? ["Software & Internet"] : [],
        employee_bands: ["25 - 100", "100 - 250", "100-250 people"],
        revenue_bands: [],
        technologies: /hubspot/i.test(said) ? ["HubSpot"] : [],
        keywords: [],
        company_names: [],
        explanation: "Senior sales leaders at mid-sized companies.",
      });
    else if (props.includes("suggestions"))
      text = JSON.stringify({
        profile_summary: "Mostly sales leaders at small software companies in the United States.",
        suggestions: [
          { label: "Sales leaders at software companies", query: "Head of Sales at software companies", rationale: "The largest group already in the campaign.", departments: ["Sales"], levels: ["VP-Level"], industries: ["Software & Internet"], employee_bands: ["25 - 100"], countries: ["United States"], title_keywords: ["Head of Sales"], look_alike_domain: "" },
          { label: "Founders at small companies", query: "Founders at companies under 100 people", rationale: "Founders still buy at this size.", departments: [], levels: ["C-Level"], industries: [], employee_bands: ["0 - 25", "25 - 100"], countries: ["United States"], title_keywords: ["Founder"], look_alike_domain: "" },
        ],
      });
    else if (props.includes("findings")) text =JSON.stringify({ findings: /free/i.test(said) ? [{ phrase: "free", where: "body", reason: "Promises of free things are a classic filter trigger.", replacement: "at no cost to you" }] : [] });
    else if (stepProps.includes("wait_days"))
      text = JSON.stringify({
        steps: [
          { subject: "{{companyName}} and slow onboarding", body: "Hi {{firstName | there}},\n\nTeams like yours often lose weeks getting new customers live.\n\nWorth a short call?\n\n{{sendingAccountFirstName}}", wait_days: 0 },
          { subject: "", body: "Hi {{firstName | there}}, one more idea: most delays sit in the handoff.\n\n{{sendingAccountFirstName}}", wait_days: 3 },
          { subject: "", body: "Hi {{firstName | there}}, should I close the loop?\n\n{{sendingAccountFirstName}}", wait_days: 4 },
        ],
      });
    else if (props.length === 2 && props.includes("subject") && props.includes("body"))
      text = /spintax/i.test(sys)
        ? JSON.stringify({ subject: "{{RANDOM | Quick | Short}} question", body: "{{RANDOM | Hi | Hey}} {{firstName | there}},\n\nWe {{RANDOM | help | support}} teams like yours.\n\n{{sendingAccountFirstName}}" })
        : JSON.stringify({ subject: "A shorter subject", body: "Hi {{firstName | there}},\n\nShorter version of your email.\n\n{{sendingAccountFirstName}}" });
    else if (props.includes("decision")) text = JSON.stringify(draftFor(said));
    else if (props.includes("icps")) text = JSON.stringify(memoryFor(said));
    else if (props.includes("steps")) text = JSON.stringify(sequenceFor(said));
    else if (props.includes("first_line")) text = JSON.stringify(researchFor(said));
    else if (format) text = JSON.stringify({ label: "Interested", confidence: 0.92, reason: "Asks which times work." });
    else text = name ? `Mock line for ${name}` : "OK";
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_mock" });
    res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 } }));
  });
}).listen(port, () => console.log(`mock on ${port}`));
