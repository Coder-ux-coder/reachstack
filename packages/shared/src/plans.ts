// Plan catalog. Prices are illustrative defaults for a hosted deployment; when Stripe is not
// configured the workspace runs in "self-hosted" mode where every limit is unlimited.

export type ProductKey = "outreach" | "credits" | "bundle" | "crm" | "website_visitors" | "verification" | "inbox_placement";

export interface PlanLimits {
  uploaded_contacts?: number | null; // null = unlimited
  monthly_emails?: number | null;
  monthly_credits?: number | null;
  email_accounts?: number | null;
  identified_visitors?: number | null;
  verification_credits?: number | null;
  inbox_placement_tests?: number | null;
}

export interface PlanDef {
  id: string;
  product: ProductKey;
  name: string;
  description: string;
  monthly_price: number; // USD
  yearly_price: number; // USD per month when billed yearly
  limits: PlanLimits;
  features: string[];
  popular?: boolean;
}

export const PLANS: PlanDef[] = [
  {
    id: "outreach_growth",
    product: "outreach",
    name: "Growth",
    description: "For founders and small teams starting outbound.",
    monthly_price: 37,
    yearly_price: 30,
    limits: { uploaded_contacts: 1_000, monthly_emails: 5_000, email_accounts: null },
    features: ["Unlimited email accounts", "Unlimited warmup", "A/Z testing", "Unibox", "Webhooks & API", "Team members"],
  },
  {
    id: "outreach_hypergrowth",
    product: "outreach",
    name: "Hyper Growth",
    description: "The complete outreach stack for growing teams.",
    monthly_price: 97,
    yearly_price: 77.6,
    limits: { uploaded_contacts: 25_000, monthly_emails: 125_000, email_accounts: null },
    features: ["Everything in Growth", "Reply agent & advanced deliverability", "Premium support"],
    popular: true,
  },
  {
    id: "outreach_lightspeed",
    product: "outreach",
    name: "Light Speed",
    description: "High volume sending with private infrastructure options.",
    monthly_price: 358,
    yearly_price: 286.3,
    limits: { uploaded_contacts: 100_000, monthly_emails: 500_000, email_accounts: null },
    features: ["Everything in Hyper Growth", "Dedicated IP pools", "Priority support"],
  },
  {
    id: "credits_growth",
    product: "credits",
    name: "Growth Credits",
    description: "Lead finder searches, enrichment and AI columns.",
    monthly_price: 47,
    yearly_price: 37.6,
    limits: { monthly_credits: 1_500 },
    features: ["Lead finder", "Waterfall work-email enrichment", "AI enrichment columns"],
  },
  {
    id: "credits_supersonic",
    product: "credits",
    name: "Supersonic Credits",
    description: "For teams sourcing leads every week.",
    monthly_price: 97,
    yearly_price: 77.6,
    limits: { monthly_credits: 5_000 },
    features: ["Everything in Growth Credits", "Technology, news & funding enrichment"],
    popular: true,
  },
  {
    id: "credits_hyper",
    product: "credits",
    name: "Hyper Credits",
    description: "Data at scale.",
    monthly_price: 197,
    yearly_price: 157.6,
    limits: { monthly_credits: 15_000 },
    features: ["Everything in Supersonic", "Evergreen enrichment jobs"],
  },
  {
    id: "bundle_starter",
    product: "bundle",
    name: "Starter",
    description: "Outreach + credits for solo operators.",
    monthly_price: 77,
    yearly_price: 61.6,
    limits: { uploaded_contacts: 1_000, monthly_emails: 5_000, monthly_credits: 1_500 },
    features: ["Growth outreach", "Growth credits"],
  },
  {
    id: "bundle_scale",
    product: "bundle",
    name: "Scale",
    description: "The full stack, nothing left out.",
    monthly_price: 167,
    yearly_price: 133.6,
    limits: { uploaded_contacts: 25_000, monthly_emails: 125_000, monthly_credits: 5_000 },
    features: ["Hyper Growth outreach", "Supersonic credits", "Sales agent"],
    popular: true,
  },
  {
    id: "bundle_agency",
    product: "bundle",
    name: "Agency",
    description: "More volume and the limits to back it up.",
    monthly_price: 497,
    yearly_price: 397.6,
    limits: { uploaded_contacts: 100_000, monthly_emails: 500_000, monthly_credits: 15_000 },
    features: ["Light Speed outreach", "Hyper credits", "Workspace groups & client portal"],
  },
  {
    id: "crm_growth",
    product: "crm",
    name: "Growth CRM",
    description: "Pipeline, tasks and team inbox.",
    monthly_price: 47,
    yearly_price: 37.6,
    limits: {},
    features: ["Opportunities pipeline", "Tasks", "Reports"],
  },
  {
    id: "crm_hyper",
    product: "crm",
    name: "Hyper CRM",
    description: "Calls, SMS, salesflows and website visitors in your CRM.",
    monthly_price: 97,
    yearly_price: 77.6,
    limits: {},
    features: ["Everything in Growth CRM", "Calling & SMS", "Salesflows", "Advanced reporting"],
    popular: true,
  },
  {
    id: "visitors_starter",
    product: "website_visitors",
    name: "Visitors Starter",
    description: "Identify companies visiting your site.",
    monthly_price: 49,
    yearly_price: 39.2,
    limits: { identified_visitors: 500 },
    features: ["Company identification", "Slack alerts", "ICP filters"],
  },
  {
    id: "visitors_growth",
    product: "website_visitors",
    name: "Visitors Growth",
    description: "More identified visitors and automations.",
    monthly_price: 149,
    yearly_price: 119.2,
    limits: { identified_visitors: 3_000 },
    features: ["Everything in Starter", "Push visitors to campaigns"],
  },
  {
    id: "inbox_placement_pro",
    product: "inbox_placement",
    name: "Inbox Placement",
    description: "Automated inbox placement tests and blacklist monitoring.",
    monthly_price: 47,
    yearly_price: 37.6,
    limits: { inbox_placement_tests: null },
    features: ["Automated tests", "Blacklist & spam score reports", "Slack/email alerts"],
  },
];

export const VERIFICATION_CREDIT_PACKS = [
  { id: "verify_5k", credits: 5_000, price: 24 },
  { id: "verify_25k", credits: 25_000, price: 89 },
  { id: "verify_100k", credits: 100_000, price: 249 },
];

export const CREDIT_COSTS = {
  lead_finder_unlock: 1,
  work_email_enrichment: 1,
  fully_enriched_profile: 2,
  email_verification: 0.25,
  ai_enrichment: 0.5,
  technologies: 1,
  news: 1,
  funding: 1,
  joblisting: 1,
} as const;

export function planById(id: string | null | undefined): PlanDef | undefined {
  return PLANS.find((p) => p.id === id);
}
