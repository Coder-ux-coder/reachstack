// Names of every campaign and list, for pickers: all of them, however many there are, newest first.
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";

export interface Named {
  id: string;
  name: string;
}

export const useCampaignNames = (enabled = true) =>
  useQuery({ queryKey: ["campaigns", "names"], queryFn: () => get<{ items: Array<Named & { status: number }> }>("/api/app/campaigns/names"), enabled });

export const useListNames = (enabled = true) => useQuery({ queryKey: ["lead-lists", "names"], queryFn: () => get<{ items: Named[] }>("/api/app/lead-lists/names"), enabled });
