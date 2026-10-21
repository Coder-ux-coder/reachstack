// Website visitors: response types, queries and small formatters shared by the visitor screens.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { get } from "@/lib/api";

export const VW_KEY = ["website-visitors"] as const;
export const invalidateVisitors = (qc: QueryClient) => qc.invalidateQueries({ queryKey: VW_KEY });

export interface VisitorSite {
  id: string;
  domain: string;
  pixel_key: string;
  snippet: string;
  settings: { icp: Icp; exclude_paths: string[] };
  test_status: "successful" | "not_tested";
  verified_at: string | null;
  last_event_at: string | null;
  conflict: boolean;
  created_at: string;
}

export interface Icp {
  industries?: string[];
  employees?: string[];
  revenue?: string[];
  countries?: string[];
}

export interface Terms {
  version: string;
  accepted: boolean;
  accepted_at: string | null;
  accepted_by: string | null;
}

export interface LookupState {
  source: "workspace" | "server" | null;
  workspace_token_set: boolean;
  server_token_set: boolean;
}

export interface SitesData {
  items: VisitorSite[];
  terms: Terms;
  lookup: LookupState;
  script_url: string;
}

export interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  linkedin_url: string | null;
  location: string | null;
  has_email: boolean;
  email: string | null;
  email_status: string | null;
  revealed: boolean;
  in_workspace: boolean;
}

export interface CompanyRow {
  domain: string;
  name: string;
  logo_url: string | null;
  industry: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  company_location: string | null;
  linkedin_url: string | null;
  in_dataset: boolean;
  fits_icp: boolean;
  visits: number;
  pageviews: number;
  duration_sec: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  top_pages: Array<{ path: string; views: number }>;
  source: string | null;
  visitor_location: string | null;
  lead_id: string | null;
  best_contact: Contact | null;
}

export interface Overview {
  sites: VisitorSite[];
  terms_accepted: boolean;
  lookup: LookupState["source"];
  totals: { companies: number; visits: number; fits: number; pageviews: number; duration_sec: number; unresolved: number };
  waiting: { pending: number; limited: number };
  daily: Array<{ date: string; visits: number; companies: number }>;
  top_pages: Array<{ path: string; views: number; visits: number }>;
  top_sources: Array<{ name: string; visits: number }>;
  usage: { self_hosted: boolean; identified_this_month: number; monthly_limit: number | null };
}

export interface ViewFilters {
  industries?: string[];
  employees?: string[];
  revenue?: string[];
  countries?: string[];
  seniority?: string[];
  departments?: string[];
  url_contains?: string[];
  referrer_contains?: string[];
  icp_only?: boolean;
}

export interface ViewDestinations {
  slack_connection_id?: string | null;
  webhook_url?: string | null;
  campaign_id?: string | null;
  list_id?: string | null;
  verify?: boolean;
  check_duplicates?: boolean;
}

export interface VisitorView {
  id: string;
  name: string;
  site_id: string | null;
  filters: ViewFilters;
  destinations: ViewDestinations;
  enabled: boolean;
  matches: number;
  last_match_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyDetail {
  company: {
    name: string;
    domain: string;
    industry: string | null;
    employee_count: number | null;
    revenue_range: string | null;
    country: string | null;
    city: string | null;
    logo_url: string | null;
    linkedin_url: string | null;
    description: string | null;
    source: "ip_lookup" | "network_name";
    network: string | null;
    company_id: string | null;
  };
  fits_icp: boolean;
  hidden: boolean;
  visits: Array<{
    id: string;
    site_id: string;
    first_seen_at: string;
    last_seen_at: string;
    pageviews: number;
    duration_sec: number;
    referrer: string | null;
    source: string | null;
    utm: Record<string, string>;
    landing_url: string | null;
    visitor_location: string | null;
    lead_id: string | null;
    pages: Array<{ url: string; path: string | null; title: string | null; duration_sec: number; viewed_at: string }>;
  }>;
  contacts: Contact[];
  leads_in_workspace: number;
}

export interface VisitorBilling {
  self_hosted: boolean;
  on_trial: boolean;
  plan: { id: string; name: string; monthly_price: number } | null;
  identified_this_month: number;
  monthly_limit: number | null;
  credits_available: number | null;
  waiting_over_limit: number;
  lookup: LookupState["source"];
  ledger: Array<{ id: string; delta: number; reason: string; created_at: string }>;
}

export const useSites = () => useQuery({ queryKey: [...VW_KEY, "sites"], queryFn: () => get<SitesData>("/api/app/website-visitors/sites") });
export const useViews = () => useQuery({ queryKey: [...VW_KEY, "views"], queryFn: () => get<{ items: VisitorView[] }>("/api/app/website-visitors/views"), select: (d) => d.items });

/** "4m 05s", "1h 12m", "35s". */
export function duration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const contactName = (c: Pick<Contact, "full_name" | "first_name" | "last_name">) => c.full_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unknown";

/** Lead Finder link that searches one company's people. */
export const leadFinderLink = (domain: string) => `/app/lead-finder?filters=${encodeURIComponent(JSON.stringify({ domains: [domain] }))}`;
