import type { FastifyInstance } from "fastify";

// The public API reference (/developers) is built from the routes themselves: every /api/v2/ route that
// declares an API scope is listed with a short description, so the page can't drift from the server.

export interface ApiEndpoint {
  method: string;
  path: string;
  scope: string;
  group: string;
  summary: string;
}

/** Product areas, by the path that follows /api/v2/ (longest match wins). */
const GROUPS: Array<[prefix: string, label: string]> = [
  ["accounts", "Email accounts"],
  ["account-campaign-mappings", "Email accounts"],
  ["domains", "Email accounts"],
  ["oauth", "Email accounts"],
  ["campaigns", "Campaigns"],
  ["subsequences", "Subsequences"],
  ["leads", "Leads"],
  ["lead-lists", "Lead lists"],
  ["lead-labels", "Lead labels"],
  ["emails", "Inbox"],
  ["email-verification", "Email verification"],
  ["block-lists-entries", "Block list"],
  ["custom-tags", "Tags"],
  ["custom-tag-mappings", "Tags"],
  ["supersearch-enrichment", "Lead Finder and enrichment"],
  ["inbox-placement-tests", "Inbox placement"],
  ["inbox-placement-analytics", "Inbox placement"],
  ["inbox-placement-reports", "Inbox placement"],
  ["agent-items", "AI agents"],
  ["ai-agents/inbox-manager", "Reply agent"],
  ["ai-agents/lead-finder", "Lead Finder agent"],
  ["ai-agents/deliverability", "Deliverability agent"],
  ["ai-agents/sales", "Sales agent"],
  ["crm-actions", "CRM"],
  ["webhooks", "Webhooks"],
  ["webhook-events", "Webhooks"],
  ["workspaces", "Workspace"],
  ["workspace-members", "Workspace members"],
  ["workspace-group-members", "Agency"],
  ["workspace-billing", "Billing"],
  ["api-keys", "API keys"],
  ["audit-logs", "Audit log"],
  ["background-jobs", "Background jobs"],
  ["dfy-email-account-orders", "Done-for-you domains and mailboxes"],
];

/** Collections that follow the usual list / create / get / update / delete shape: [one, many]. */
const NOUNS: Record<string, [one: string, many: string]> = {
  accounts: ["an email account", "email accounts"],
  "ai-agents/deliverability": ["a deliverability agent", "deliverability agents"],
  "ai-agents/inbox-manager": ["a reply agent", "reply agents"],
  "ai-agents/inbox-manager/:id/guidances": ["a guidance note", "guidance notes"],
  "ai-agents/inbox-manager/:id/replies": ["a drafted reply", "drafted replies"],
  "ai-agents/lead-finder": ["a Lead Finder agent", "Lead Finder agents"],
  "ai-agents/lead-finder/enrichment-workflows": ["an enrichment workflow", "enrichment workflows"],
  "ai-agents/sales": ["a sales agent", "sales agents"],
  "ai-agents/sales/:id/guidance-rules": ["a guidance rule", "guidance rules"],
  "api-keys": ["an API key", "API keys"],
  "audit-logs": ["an audit log entry", "audit log entries"],
  "background-jobs": ["a background job", "background jobs"],
  "block-lists-entries": ["a block list entry", "block list entries"],
  campaigns: ["a campaign", "campaigns"],
  "crm-actions/phone-numbers": ["a phone number", "phone numbers"],
  "custom-tag-mappings": ["a tag assignment", "tag assignments"],
  "custom-tags": ["a tag", "tags"],
  "dfy-email-account-orders": ["a done-for-you order", "done-for-you orders"],
  emails: ["an email", "emails"],
  "inbox-placement-analytics": ["an inbox placement result", "inbox placement results"],
  "inbox-placement-reports": ["an inbox placement report", "inbox placement reports"],
  "inbox-placement-tests": ["an inbox placement test", "inbox placement tests"],
  "lead-labels": ["a lead label", "lead labels"],
  "lead-lists": ["a lead list", "lead lists"],
  leads: ["a lead", "leads"],
  subsequences: ["a subsequence", "subsequences"],
  "supersearch-enrichment/company-lists": ["a company list", "company lists"],
  "supersearch-enrichment/saved-searches": ["a saved search", "saved searches"],
  "webhook-events": ["a webhook delivery", "webhook deliveries"],
  webhooks: ["a webhook", "webhooks"],
  "workspace-group-members": ["a client workspace link", "client workspace links"],
  "workspace-members": ["a workspace member", "workspace members"],
};

/** Everything that isn't plain list / create / get / update / delete, keyed by "METHOD path after /api/v2/". */
const SUMMARIES: Record<string, string> = {
  "GET account-campaign-mappings/:email": "Campaigns that send from an email account",
  "POST accounts/:email/mark-fixed": "Mark an email account's connection problem as fixed",
  "POST accounts/:email/pause": "Pause an email account",
  "POST accounts/:email/resume": "Resume a paused email account",
  "GET accounts/analytics/daily": "Emails sent per account per day",
  "GET accounts/ctd/status": "Check a custom tracking domain",
  "POST accounts/move": "Move email accounts to another workspace",
  "POST accounts/pause": "Pause several email accounts",
  "POST accounts/test/vitals": "Check the DNS records (MX, SPF, DKIM, DMARC) of your sending domains",
  "POST accounts/warmup/disable": "Turn warmup off for email accounts",
  "POST accounts/warmup/enable": "Turn warmup on for email accounts",
  "POST accounts/warmup-analytics": "Warmup results for email accounts",
  "GET domains/:domain/forwarding": "Where a sending domain's website forwards to",
  "PUT domains/:domain/forwarding": "Forward a sending domain's website",
  "DELETE domains/:domain/forwarding": "Stop forwarding a sending domain's website",
  "POST oauth/:provider/init": "Start connecting a Google or Microsoft mailbox",
  "GET oauth/session/status/:sessionId": "Check how a Google or Microsoft connection went",

  "GET agent-items": "List AI agents and automations",
  "POST agent-items/bulk-delete": "Delete several AI agents and automations",

  "POST ai-agents/deliverability/deploy": "Start the deliverability agent",
  "GET ai-agents/deliverability/state": "The deliverability agent's state in this workspace",
  "PATCH ai-agents/deliverability/settings": "Update the deliverability agent's settings",
  "POST ai-agents/deliverability/run-now": "Run the deliverability checks now",
  "GET ai-agents/deliverability/:id/state": "A deliverability agent's state",
  "GET ai-agents/deliverability/:id/feed-items": "What a deliverability agent found",
  "POST ai-agents/deliverability/feed-items/:id/complete": "Mark a finding as handled",
  "POST ai-agents/deliverability/feed-items/:id/pause-affected-accounts": "Pause the email accounts a finding is about",
  "POST ai-agents/deliverability/feed-items/:id/pause-campaign-sending": "Pause the campaign a finding is about",

  "GET ai-agents/inbox-manager/:id/analytics/activity": "What a reply agent did",
  "GET ai-agents/inbox-manager/:id/analytics/summary": "A reply agent's totals",
  "GET ai-agents/inbox-manager/:id/analytics/summary-by-date": "A reply agent's totals per day",

  "GET ai-agents/lead-finder/:id/activities": "What a Lead Finder agent did",
  "GET ai-agents/lead-finder/:id/stats": "A Lead Finder agent's totals",
  "POST ai-agents/lead-finder/:id/pause": "Pause a Lead Finder agent",
  "POST ai-agents/lead-finder/:id/resume": "Resume a Lead Finder agent",
  "POST ai-agents/lead-finder/suggest-audience": "Suggest search filters from a description of your audience",

  "GET ai-agents/sales/:id/activities": "Actions a sales agent took or proposes",
  "POST ai-agents/sales/:id/activities/:activity_id/approve": "Approve a proposed action",
  "POST ai-agents/sales/:id/activities/:activity_id/reject": "Reject a proposed action",
  "POST ai-agents/sales/:id/activities/approve": "Approve several proposed actions",
  "POST ai-agents/sales/:id/activities/reject": "Reject several proposed actions",
  "GET ai-agents/sales/:id/analytics": "A sales agent's results",
  "POST ai-agents/sales/:id/guidance-rules": "Add a guidance rule",
  "DELETE ai-agents/sales/:id/guidance-rules/:rule_id": "Delete a guidance rule",
  "PATCH ai-agents/sales/:id/guidance-rules/:rule_id": "Update a guidance rule",
  "GET ai-agents/sales/:id/leads/:lead_id/research": "What a sales agent found out about a lead",
  "GET ai-agents/sales/:id/leads/activity": "A sales agent's activity per lead",
  "GET ai-agents/sales/:id/leads/activity/summary": "A sales agent's lead activity totals",
  "GET ai-agents/sales/:id/opportunities/summary": "A sales agent's opportunity totals",

  "DELETE block-lists-entries": "Delete block list entries matching a filter",
  "POST block-lists-entries/bulk-create": "Add several block list entries",
  "POST block-lists-entries/bulk-delete": "Delete several block list entries",
  "GET block-lists-entries/download": "Download the block list as CSV",

  "POST campaigns/:id/activate": "Start or resume a campaign",
  "POST campaigns/:id/pause": "Pause a campaign",
  "POST campaigns/:id/duplicate": "Duplicate a campaign",
  "POST campaigns/:id/export": "Export a campaign as JSON",
  "POST campaigns/:id/share": "Share a campaign with another workspace for 7 days",
  "POST campaigns/:id/from-export": "Create a campaign from one another workspace shared",
  "POST campaigns/:id/variables": "Add custom variables to a campaign",
  "GET campaigns/:id/sending-status": "Why a campaign is or isn't sending",
  "GET campaigns/analytics": "Results per campaign",
  "GET campaigns/analytics/daily": "Campaign results per day",
  "GET campaigns/analytics/overview": "Campaign results added up",
  "GET campaigns/analytics/steps": "Campaign results per step and variant",
  "GET campaigns/count-launched": "Count the campaigns that have been launched",
  "GET campaigns/search-by-contact": "Campaigns a lead is in",

  "POST custom-tags/toggle-resource": "Add or remove a tag on email accounts or campaigns",

  "GET dfy-email-account-orders/accounts": "Mailboxes from done-for-you orders",
  "POST dfy-email-account-orders/accounts/cancel": "Cancel done-for-you mailboxes",
  "POST dfy-email-account-orders/domains/check": "Check whether domains can be registered",
  "POST dfy-email-account-orders/domains/pre-warmed-up-list": "Domains that come already warmed up",
  "POST dfy-email-account-orders/domains/similar": "Suggest domains similar to yours",

  "POST emails/send": "Send a new email",
  "POST emails/reply": "Reply to an email",
  "POST emails/forward": "Forward an email",
  "POST emails/test": "Send a test email",
  "POST emails/threads/:thread_id/mark-as-read": "Mark a conversation as read",
  "GET emails/unread/count": "Count unread conversations",

  "POST email-verification": "Verify an email address",
  "GET email-verification/:email": "Get the result of a verification",

  "POST inbox-placement-analytics/deliverability-insights": "Deliverability insights from inbox placement tests",
  "POST inbox-placement-analytics/stats-by-date": "Inbox placement results per day",
  "POST inbox-placement-analytics/stats-by-test-id": "Inbox placement results per test",
  "GET inbox-placement-tests/email-service-provider-options": "Mailbox providers a test can check",

  "POST lead-labels/ai-reply-label": "Suggest a label for a reply",
  "GET lead-lists/:id/verification-stats": "Verification results of a lead list",

  "DELETE leads": "Delete leads from a campaign or list",
  "POST leads/add": "Add up to 1,000 leads to a campaign or list",
  "POST leads/list": "List and filter leads",
  "POST leads/bulk-assign": "Assign leads to a team member",
  "POST leads/merge": "Merge two leads",
  "POST leads/move": "Move or copy leads to another campaign or list",
  "POST leads/subsequence/move": "Move leads into a subsequence",
  "POST leads/subsequence/remove": "Take leads out of a subsequence",
  "POST leads/update-interest-status": "Set a lead's interest status",

  "POST subsequences/:id/duplicate": "Duplicate a subsequence",
  "POST subsequences/:id/pause": "Pause a subsequence",
  "POST subsequences/:id/resume": "Resume a subsequence",
  "GET subsequences/:id/sending-status": "Why a subsequence is or isn't sending",
  "GET subsequences/:id/analytics/steps": "Subsequence results per step",
  "GET subsequences/analytics": "Results per subsequence",

  "POST supersearch-enrichment": "Turn on enrichment for a list or campaign",
  "GET supersearch-enrichment/:resource_id": "Enrichment set up for a list or campaign",
  "PATCH supersearch-enrichment/:resource_id/settings": "Change the enrichment settings of a list or campaign",
  "GET supersearch-enrichment/history/:resource_id": "Enrichment runs of a list or campaign",
  "POST supersearch-enrichment/run": "Run enrichment now",
  "POST supersearch-enrichment/ai": "Add an AI column to a list or campaign",
  "GET supersearch-enrichment/ai/:resource_id/in-progress": "AI columns still being filled",
  "POST supersearch-enrichment/count-leads-from-supersearch": "Count the people a Lead Finder search matches",
  "POST supersearch-enrichment/preview-leads-from-supersearch": "Preview the people a Lead Finder search matches",
  "POST supersearch-enrichment/enrich-leads-from-supersearch": "Import people from a Lead Finder search",
  "POST supersearch-enrichment/signal-keywords-facet": "Keyword suggestions for buying signals",
  "GET supersearch-enrichment/integrations/providers": "Enrichment providers you can use",
  "POST supersearch-enrichment/integrations/run": "Enrich leads with a provider",
  "GET supersearch-enrichment/company-lists/:company_list_id/companies": "Companies in a company list",
  "GET supersearch-enrichment/company-lists/filter-options": "Filters you can build a company list from",
  "GET supersearch-enrichment/company-lists/recipes": "Ready-made company list recipes",
  "GET supersearch-enrichment/company-lists/sources": "Where company lists can come from",

  "GET webhook-events/summary": "Webhook delivery totals",
  "GET webhook-events/summary-by-date": "Webhook delivery totals per day",
  "GET webhooks/event-types": "Events you can subscribe to",
  "POST webhooks/:id/resume": "Resume a webhook that was paused after failures",
  "POST webhooks/:id/test": "Send a test event to a webhook",

  "GET workspace-billing/plan-details": "The workspace's plan",
  "GET workspace-billing/subscription-details": "The workspace's subscription",
  "GET workspace-group-members/admin": "The agency workspace that manages this one",
  "POST workspace-group-members": "Invite a client workspace",
  "POST workspace-members": "Invite someone to the workspace",
  "GET workspaces/current": "Get the workspace",
  "PATCH workspaces/current": "Update the workspace",
  "POST workspaces/current/change-owner": "Hand the workspace to another member",
  "POST workspaces/current/schedule-for-removal": "Schedule the workspace for deletion",
  "DELETE workspaces/current/schedule-for-removal": "Cancel the scheduled deletion",
  "GET workspaces/current/whitelabel-domain": "The white-label domain",
  "POST workspaces/current/whitelabel-domain": "Set a white-label domain",
  "DELETE workspaces/current/whitelabel-domain": "Remove the white-label domain",
};

const V2 = "/api/v2/";

function groupOf(rest: string): string {
  let best = "";
  let label = "Other";
  for (const [prefix, l] of GROUPS) {
    if ((rest === prefix || rest.startsWith(`${prefix}/`)) && prefix.length > best.length) {
      best = prefix;
      label = l;
    }
  }
  return label;
}

/** A short description: hand-written above, or worked out for plain list / create / get / update / delete routes. */
export function summarize(method: string, rest: string): string | null {
  const own = SUMMARIES[`${method} ${rest}`];
  if (own) return own;
  const byItem = /\/:[\w]+$/.test(rest);
  const nouns = NOUNS[byItem ? rest.replace(/\/:[\w]+$/, "") : rest];
  if (!nouns) return null;
  const [one, many] = nouns;
  if (!byItem) return method === "GET" ? `List ${many}` : method === "POST" ? `Create ${one}` : method === "DELETE" ? `Delete ${many}` : null;
  return method === "GET" ? `Get ${one}` : method === "PATCH" || method === "PUT" ? `Update ${one}` : method === "DELETE" ? `Delete ${one}` : null;
}

const endpoints: ApiEndpoint[] = [];

/** Records each public API route as it's registered. Call before the routes are registered. */
export function collectApiReference(app: FastifyInstance) {
  app.addHook("onRoute", (r) => {
    const cfg = (r.config ?? {}) as { scope?: [string, string] };
    if (!cfg.scope || !r.url.startsWith(V2)) return;
    for (const method of [r.method].flat()) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const rest = r.url.slice(V2.length);
      endpoints.push({ method, path: r.url, scope: cfg.scope.join(":"), group: groupOf(rest), summary: summarize(method, rest) ?? "" });
    }
  });
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Grouped by product area, in the order the areas are listed above; within an area by path, then method. */
export function apiEndpoints(): ApiEndpoint[] {
  const groupRank = new Map<string, number>();
  for (const [, label] of GROUPS) if (!groupRank.has(label)) groupRank.set(label, groupRank.size);
  return [...endpoints].sort(
    (a, b) =>
      (groupRank.get(a.group) ?? 99) - (groupRank.get(b.group) ?? 99) ||
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
}
