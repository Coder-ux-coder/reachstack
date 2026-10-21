import { useQuery } from "@tanstack/react-query";
import { DEFAULT_INTEREST_STATUSES } from "@reachstack/shared";
import { get } from "./api";

export interface LeadLabel {
  id: string;
  label: string;
  interest_status: number;
  interest_status_label: "positive" | "neutral" | "negative";
  description: string | null;
  use_with_ai: boolean;
  color: string | null;
}

export interface StatusMeta {
  code: number;
  label: string;
  color: string;
  sentiment: "positive" | "neutral" | "negative";
  custom?: LeadLabel;
}

const SENTIMENT_COLORS = { positive: "#16a34a", neutral: "#64748b", negative: "#dc2626" } as const;

/** Built-in interest statuses plus the workspace's custom labels, in one list. */
export function useLeadStatuses() {
  const q = useQuery({
    queryKey: ["lead-statuses"],
    queryFn: () => get<{ built_in: typeof DEFAULT_INTEREST_STATUSES; custom: LeadLabel[] }>("/api/app/lead-statuses"),
    staleTime: 5 * 60_000,
  });
  const all: StatusMeta[] = [
    ...(q.data?.built_in ?? DEFAULT_INTEREST_STATUSES).map((s) => ({ code: s.code, label: s.label, color: s.color, sentiment: s.sentiment })),
    ...(q.data?.custom ?? []).map((c) => ({
      code: c.interest_status,
      label: c.label,
      color: c.color || SENTIMENT_COLORS[c.interest_status_label] || "#64748b",
      sentiment: c.interest_status_label,
      custom: c,
    })),
  ];
  return { ...q, all };
}
