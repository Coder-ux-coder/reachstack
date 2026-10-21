import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";

export const LEAD_FINDER_TABS = [
  { to: "/app/lead-finder", label: "Search" },
  { to: "/app/lead-finder/leads", label: "Lists" },
];

/** The workspace's credits. An unlimited workspace is never charged, and every email shows without revealing. */
export const useLeadFinderCredits = () =>
  useQuery({ queryKey: ["lead-finder", "credits"], queryFn: () => get<{ credits: number | null; unlimited: boolean }>("/api/app/lead-finder/credits") });
