// Starting points for the copilot: quick actions on the new-chat page, the prompt library (with fill-in
// variables) and email frameworks for "/" in the composer.
import type { LucideIcon } from "lucide-react";
import { BarChart3, Compass, Lightbulb, ListChecks, Mail, Rocket, Search, Trophy } from "lucide-react";

export const QUICK_ACTIONS: Array<{ label: string; prompt: string; icon: LucideIcon }> = [
  { label: "Find ideal prospects", prompt: "Suggest a lead list that fits my business", icon: Search },
  { label: "Build a full campaign", prompt: "Build a complete campaign for my business: who to target, the email sequence and the sending settings", icon: Rocket },
  { label: "Write a sequence", prompt: "Help me write a cold email sequence", icon: Mail },
  { label: "Campaign ideas", prompt: "Give me five campaign ideas based on my business", icon: Lightbulb },
  { label: "Weekly analytics", prompt: "Summarize my campaign results for this week", icon: BarChart3 },
  { label: "Best campaigns", prompt: "Which three campaigns perform best by opportunities and replies, and why?", icon: Trophy },
  { label: "Get advice", prompt: "What should I change to get more replies from my outbound?", icon: Compass },
  { label: "Audit my workspace", prompt: "Audit my workspace and tell me what to fix first", icon: ListChecks },
];

export interface LibraryPrompt {
  title: string;
  text: string;
  /** {{name}} placeholders the user fills in before inserting. */
  variables?: Array<{ name: string; label: string; placeholder: string }>;
}

const v = (name: string, label: string, placeholder: string) => ({ name, label, placeholder });

export const PROMPT_LIBRARY: LibraryPrompt[] = [
  { title: "Full campaign", text: "Build a complete outbound campaign for my business." },
  { title: "Campaign ideas", text: "List campaign ideas that fit my business, with the audience and angle for each." },
  { title: "Lead list", text: "Suggest a lead list that fits my business." },
  { title: "This week's results", text: "Summarize my campaign results for this week." },
  { title: "Email sequence", text: "Write a three-step cold email sequence for my business." },
  { title: "Outbound playbook", text: "Give me a practical outbound playbook for the next 30 days." },
  { title: "Workspace audit", text: "Audit my workspace: sending accounts, warmup, campaigns and results." },
  { title: "Sales pitch", text: "Write a short, convincing sales pitch for my business." },
  {
    title: "Targeting for a niche",
    text: "Who should I target in {{industry}}? I want to reach {{targetRole}} in {{location}}.",
    variables: [v("industry", "Industry", "e.g. Logistics"), v("targetRole", "Target role", "e.g. Head of Operations"), v("location", "Location", "e.g. Germany")],
  },
  {
    title: "Results report",
    text: "Report on {{metrics}} across my campaigns for {{timeframe}}, and what to change.",
    variables: [v("metrics", "Metrics", "e.g. reply rate and opportunities"), v("timeframe", "Time period", "e.g. the last 30 days")],
  },
  {
    title: "Outbound plan",
    text: "Plan outbound for a {{businessType}} that wants to reach {{targetAudience}}. Our edge: {{uniqueValue}}.",
    variables: [v("businessType", "Type of business", "e.g. B2B payroll software"), v("targetAudience", "Audience", "e.g. finance leads at 50-500 person firms"), v("uniqueValue", "What makes you different", "e.g. setup in one day")],
  },
  {
    title: "Return on campaigns",
    text: "Estimate the return on my campaigns over {{timeframe}} if they cost {{costs}}.",
    variables: [v("timeframe", "Time period", "e.g. this quarter"), v("costs", "Costs", "e.g. $400 a month in tools")],
  },
  { title: "Handling objections", text: "What objections will prospects raise about my offer, and how should I answer each one?" },
  {
    title: "Buyer persona",
    text: "Describe the ideal buyer of {{product}} among {{jobRole}} in {{industry}}: goals, pains, and what makes them reply.",
    variables: [v("product", "Product or service", "e.g. our onboarding audit"), v("jobRole", "Role", "e.g. Customer Success leads"), v("industry", "Industry", "e.g. SaaS")],
  },
  {
    title: "New market",
    text: "Plan how to take {{product}} into {{newRegion}}, starting with {{industry}} companies.",
    variables: [v("product", "Product or service", "e.g. our scheduling tool"), v("newRegion", "Region or country", "e.g. the Nordics"), v("industry", "Industry", "e.g. clinics")],
  },
  {
    title: "Use cases",
    text: "Give me use cases for our offer that would matter to {{jobRole}} at {{industry}} companies.",
    variables: [v("jobRole", "Role", "e.g. IT managers"), v("industry", "Industry", "e.g. manufacturing")],
  },
];

/** Email frameworks offered after "/" in the composer. "..." marks what the copilot fills in. */
export const EMAIL_FRAMEWORKS: Array<{ name: string; outline: string }> = [
  { name: "Problem first", outline: "Open with a question about ... that {{companyName}} likely faces. One line on how we fix it. Ask for 15 minutes." },
  { name: "Peer proof", outline: "Mention a company like {{companyName}} that got ... after working with us. Offer to share how." },
  { name: "Three ideas", outline: "{{firstName}}, I wrote three ideas for ... at {{companyName}}: 1. ... 2. ... 3. ... Worth a quick chat?" },
  { name: "Short case study", outline: "One sentence on a customer's before and after (...). One sentence on why it applies to {{companyName}}. Soft ask." },
  { name: "Observation", outline: "Start from something specific about {{companyName}} (..., from their site). Connect it to a problem we solve. Ask if it is a priority." },
  { name: "No-risk offer", outline: "If we can't deliver ... within ..., you don't pay. Ask if that's worth a call." },
  { name: "Pain question", outline: "Is ... slowing {{companyName}} down, like most teams in {{industry}}? We help by .... Open to a look?" },
  { name: "Trend note", outline: "Teams in {{industry}} are starting to .... Ask how {{companyName}} is handling it, and offer a short walkthrough." },
  { name: "Free resource", outline: "I put together a short ... for {{companyName}}, with three things you could act on. Want me to send it?" },
  { name: "Right person?", outline: "We help teams like yours with .... Are you the right person to talk to about it, or should I reach someone else?" },
  { name: "Two lines", outline: "Two sentences: what we do for companies like {{companyName}}, and a yes-or-no question." },
  { name: "Video intro", outline: "Introduce a short video made for {{companyName}} showing .... Link placeholder [VIDEO_URL]. Ask for 15 minutes." },
];

export const fillVariables = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (all, name: string) => values[name]?.trim() || all);
