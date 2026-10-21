// Streaming stand-in for the copilot: picks a tool call or an answer from the newest user turn and streams
// it as server-sent events in the Messages API format (with a thinking block first, like adaptive thinking).
let seq = 0;

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
}

function lastToolResults(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  const results = last.content.filter((b) => b.type === "tool_result");
  if (!results.length) return null;
  const prev = [...messages].reverse().find((m) => m.role === "assistant");
  const calls = new Map((prev?.content ?? []).filter((b) => b.type === "tool_use").map((b) => [b.id, b]));
  return results.map((r) => ({ ...r, call: calls.get(r.tool_use_id) }));
}

const tool = (name, input, lead = "") => ({ lead, tool: { name, input } });

/** What to do for a fresh user message. */
function plan(said) {
  const s = said.toLowerCase();
  if (/audit/.test(s)) return tool("get_workspace_overview", {}, "Let me look over the workspace first.");
  if (/analytics|how .*doing|this week|best performing/.test(s)) return tool("get_campaign_analytics", { start_date: "2026-10-06", end_date: "2026-10-13" }, "Pulling this week's numbers.");
  if (/accounts? health|deliverability/.test(s)) return tool("list_email_accounts", { only_problems: false });
  if (/replies/.test(s)) return tool("list_recent_replies", { limit: 5 });
  if (/create (a )?campaign/.test(s))
    return tool("create_campaign", {
      name: "Copilot · Sales leaders",
      steps: [
        { delay_days: 0, variants: [{ subject: "onboarding at {{companyName}}", body: "Hi {{firstName | there}},\n\nTeams like yours lose weeks getting new customers live. We shorten that.\n\nWorth a 20-minute look?\n\n{{sendingAccountFirstName}}" }] },
        { delay_days: 3, variants: [{ subject: "", body: "Hi {{firstName | there}}, most of the delay sits in the handoff between sales and delivery.\n\n{{sendingAccountFirstName}}" }] },
      ],
    }, "I'll set it up as a draft.");
  if (/sequence|write .*email/.test(s))
    return tool("propose_sequence", {
      campaign_name: "Onboarding audit · Heads of Sales",
      steps: [
        { delay_days: 0, variants: [{ subject: "onboarding at {{companyName}}", body: "Hi {{firstName | there}},\n\nTeams like yours often lose weeks getting new customers live.\n\nWorth a 20-minute audit?\n\n{{sendingAccountFirstName}}" }, { subject: "a faster first week", body: "Hi {{firstName | there}},\n\nMost onboarding delays come from handoffs.\n\nOpen to a quick audit?\n\n{{sendingAccountFirstName}}" }] },
        { delay_days: 3, variants: [{ subject: "", body: "Hi {{firstName | there}}, one more idea: a shared checklist cuts most of the back-and-forth.\n\n{{sendingAccountFirstName}}" }] },
        { delay_days: 4, variants: [{ subject: "", body: "Hi {{firstName | there}}, should I close the loop on this?\n\n{{sendingAccountFirstName}}" }] },
      ],
      notes: "Opens with the cost of slow onboarding, then adds one new idea per follow-up.",
    }, "Here's a three-step sequence built around your onboarding audit.");
  if (/lead list|prospects|who should|find .*leads|ideal/.test(s))
    return tool("search_lead_database", { filters: { job_titles: ["Head of Sales", "VP Sales"], locations: ["United States"], employee_counts: ["25 - 100", "100 - 250"] }, explanation: "Sales leaders at US companies with 25 to 250 employees." }, "Here's a list that fits your offer.");
  if (/add .*leads/.test(s)) return tool("add_leads_from_search", { filters: { job_titles: ["Head of Sales"] }, limit: 25, list_name: "Copilot · Heads of Sales" });
  if (/ask me|which audience|options/.test(s))
    return tool("ask_user_question", {
      questions: [
        { header: "Audience", question: "Who should this campaign target?", options: [{ label: "Sales leaders", description: "Heads of Sales and VPs" }, { label: "Founders", description: "Companies under 50 people" }] },
        { header: "Tone", question: "Which tone fits your brand?", options: [{ label: "Friendly" }, { label: "Direct" }, { label: "Formal" }], multi_select: false },
      ],
    });
  if (/domains|mailboxes|dfy/.test(s))
    return tool("quote_dfy_order", { order_type: "dfy", items: [{ domain: "trynorthwind-mock.com", accounts: [{ email_address_prefix: "alex", first_name: "Alex", last_name: "Kim" }, { email_address_prefix: "a.kim", first_name: "Alex", last_name: "Kim" }] }] });
  if (/remember|save .*memory/.test(s)) return tool("save_business_details", { outreach_goal: "Book 20-minute onboarding audits", add_rules: ["Never mention pricing in the first email."] });
  if (/every (day|week|monday)|recurring|schedule/.test(s)) return tool("create_recurring_task", { title: "Weekly analytics", prompt: "Summarize my campaign analytics for this week", frequency: "weekly", time_of_day: "09:00" });
  if (/pause/.test(s)) return tool("list_campaigns", { search: "" });
  return {
    text:
      "## Outbound basics that work\n\n- **Keep it short**: under 100 words, one clear ask.\n- **Warm up** every mailbox for two weeks before sending.\n- **Send 30-50 emails** per mailbox per day.\n\n| Step | Wait | Goal |\n| --- | --- | --- |\n| Email 1 | Day 0 | Problem + offer |\n| Email 2 | Day 3 | New angle |\n| Email 3 | Day 7 | Close the loop |\n\nWant me to draft a sequence?",
  };
}

/** What to say after tool results come back. */
function afterResults(results) {
  const r = results[0];
  const name = r.call?.name;
  const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  if (r.is_error) return { text: /declined|didn't approve/i.test(content) ? "Understood, I won't do that. Want me to try something else?" : `That didn't work: ${content.slice(0, 160)}` };
  let data = {};
  try {
    data = JSON.parse(content);
  } catch {}
  switch (name) {
    case "get_campaign_analytics": {
      const t = data.totals ?? {};
      return { text: `This week you sent **${t.emails_sent ?? 0}** emails and got **${t.unique_replies ?? 0}** replies.\n\n| Campaign | Sent | Replies |\n| --- | --- | --- |\n${(data.campaigns ?? []).slice(0, 5).map((c) => `| ${c.name} | ${c.emails_sent} | ${c.unique_replies} |`).join("\n")}` };
    }
    case "get_workspace_overview":
      return { text: `**Audit summary**\n\n- ${data.email_accounts?.total ?? 0} email accounts, ${data.email_accounts?.warmup_on ?? 0} warming up\n- ${data.campaigns?.total ?? 0} campaigns\n- Reply rate last 30 days: **${data.last_30_days?.reply_rate_pct ?? 0}%**` };
    case "search_lead_database":
      return { text: `I found **${data.total_matches ?? 0}** people who match. Open the list in Lead Finder from the card, or ask me to add them to a campaign.` };
    case "propose_sequence":
      return { text: "The sequence is in the card above. Use it in a campaign when you're happy with it." };
    case "ask_user_question":
      return { text: `Thanks. Going with ${(data.answers ?? []).map((a) => a.answer.join(", ")).join(" and ")}.` };
    case "quote_dfy_order":
      return { text: data.quoted ? `That comes to **$${data.due_now}** now. Place the order from the card if it looks right.` : "Some of those domains can't be ordered; want me to suggest others?" };
    default:
      return { text: "Done. Anything else?" };
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function copilotStream(json, res) {
  const messages = json.messages ?? [];
  const results = lastToolResults(messages);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const said = textOf(lastUser?.content).replace(/<context>[\s\S]*?<\/context>/g, "");
  const step = results ? afterResults(results) : plan(said);
  const blocks = [{ type: "thinking" }];
  if (step.lead) blocks.push({ type: "text", text: step.lead });
  if (step.text) blocks.push({ type: "text", text: step.text });
  if (step.tool) blocks.push({ type: "tool_use", id: `toolu_mock_${Date.now()}_${seq++}`, name: step.tool.name, input: step.tool.input });

  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_mock" });
  sse(res, "message_start", { type: "message_start", message: { id: `msg_mock_${seq++}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 } } });
  let i = 0;
  const next = () => {
    if (i >= blocks.length) {
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: step.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 120 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    const b = blocks[i];
    const index = i++;
    if (b.type === "thinking") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "c2lnX21vY2s=" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      setTimeout(next, 150);
    } else if (b.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      const parts = b.text.match(/[\s\S]{1,18}/g) ?? [];
      let p = 0;
      const tick = () => {
        if (p < parts.length) {
          sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: parts[p++] } });
          setTimeout(tick, 25);
        } else {
          sse(res, "content_block_stop", { type: "content_block_stop", index });
          next();
        }
      };
      tick();
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const raw = JSON.stringify(b.input);
      for (const part of raw.match(/[\s\S]{1,40}/g) ?? []) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      setTimeout(next, 100);
    }
  };
  next();
}
