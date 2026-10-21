// Automations API: types and calls shared by the list, History and the editor.
import { useQuery } from "@tanstack/react-query";
import type { AppKey, AutomationGraph, AutomationStatus, GraphWarnings, RunStatus } from "@reachstack/shared";
import { get } from "@/lib/api";

export const BASE = "/api/app/automations";

export interface AutomationSummary {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger_type: string | null;
  apps: AppKey[];
  steps: number;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  problems: number;
  timestamp_created: string;
  timestamp_updated: string;
}

export interface Automation extends AutomationSummary {
  graph: AutomationGraph;
  version: number;
  webhook_url: string | null;
  webhook_samples: number;
  warnings: GraphWarnings;
  /** PATCH: the save turned the automation off because of problems. */
  turned_off?: boolean;
}

export interface Options {
  campaigns: Array<{ id: string; name: string; status: number }>;
  lists: Array<{ id: string; name: string }>;
  labels: Array<{ code: number; label: string }>;
  members: Array<{ id: string; name: string; email: string }>;
  slack: Array<{ id: string; name: string }>;
  subsequences: Array<{ id: string; name: string; campaign_id: string; campaign_name: string | null }>;
  sites: Array<{ id: string; domain: string }>;
  ai: boolean;
  webhook_base: string;
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  status: RunStatus;
  error: string | null;
  current_step: { id: string; name: string } | null;
  lead_email: string | null;
  is_test: boolean;
  attempt: number;
  retry_of: string | null;
  resume_at: string | null;
  duration_ms: number | null;
  timestamp_created: string;
  timestamp_updated: string;
  timestamp_finished: string | null;
}

export interface RunStep {
  id: string;
  name: string;
  type: string | null;
  key: string | null;
  status: "running" | "success" | "error" | "waiting";
  started_at: string;
  finished_at: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
}

export interface RunDetail extends RunSummary {
  trigger: Record<string, unknown> | null;
  steps: RunStep[];
  logs: Array<{ at: string; node: string; level: string; message: string }>;
  attempts: Array<{ id: string; attempt: number; status: RunStatus; timestamp_created: string }>;
  retry: { available: boolean; reason: string | null; message: string | null };
}

export interface TriggerSample {
  id: string;
  label: string;
  at: string | null;
  output: Record<string, unknown>;
}

export interface StepTestResult {
  status: "success" | "error";
  input: unknown;
  output: unknown;
  error: string | null;
  logs: Array<{ level: string; message: string }>;
}

export const keys = {
  list: ["automations"] as const,
  one: (id: string) => ["automations", id] as const,
  options: ["automations", "options"] as const,
  runs: ["automation-runs"] as const,
  run: (id: string) => ["automation-runs", "one", id] as const,
};

export function useOptions() {
  return useQuery({ queryKey: keys.options, queryFn: () => get<Options>(`${BASE}/options`), staleTime: 60_000 });
}

export const ACTIVE_RUN: RunStatus[] = ["queued", "running", "waiting"];

/** "820 ms", "4.2 s", "3 min", "2 h 5 min", "3 d 4 h". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const d = Math.floor(h / 24);
  return `${d} d${h % 24 ? ` ${h % 24} h` : ""}`;
}
