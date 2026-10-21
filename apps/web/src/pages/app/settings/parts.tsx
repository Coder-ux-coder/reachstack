import type { ReactNode } from "react";
import type { Permission } from "@reachstack/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, get, patch } from "@/lib/api";
import { ME_KEY } from "@/lib/session";

/** Page heading used by every settings screen. */
export function SettingsHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export type WorkspaceSettings = Record<string, unknown> & {
  default_timezone?: string;
  timezone_confirmed?: boolean;
  unibox_show_auto_replies?: boolean;
  unibox_save_non_campaign_emails?: boolean;
  unibox_save_undelivered?: boolean;
  stop_campaign_on_lead_reply_from_any_campaign?: boolean;
  disable_global_lead_status_sync?: boolean;
  auto_label_with_ai?: boolean;
  auto_label_ooo?: boolean;
  update_existing_labels_with_ai?: boolean;
  ai_label_codes?: number[] | null;
  limit_emails_per_company?: { enabled: boolean; daily_limit: number; scope?: "per_campaign" | "across_workspace" };
  esp_matching_default?: boolean;
  first_email_text_only?: boolean;
  disable_open_tracking?: boolean;
  auto_pause_on_bounce?: boolean;
  single_account_per_gap?: boolean;
  send_one_at_a_time?: boolean;
  sticky_sending_accounts_for_leads?: boolean;
  bounce_protect_threshold?: number;
  ai_lead_filtering?: { unlikely_to_reply: FilterAction; hostile: FilterAction };
  notify_account_disconnect?: boolean;
  notify_positive_reply?: boolean;
  notification_recipients?: string[];
  custom_warmup_copy?: { enabled: boolean; subjects: string[]; bodies: string[] };
  agency?: AgencySettings;
};
export interface AgencySettings {
  enabled?: boolean;
  brand_name?: string | null;
  brand_color?: string | null;
  client_permissions?: Permission[];
}
export type FilterAction = "send_as_usual" | "skip" | "send_last";

export const SETTINGS_KEY = ["workspace-settings"];

/** Workspace preferences with an optimistic save that reverts (and says why) when the server refuses. */
export function useWorkspaceSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<WorkspaceSettings>("/api/app/workspaces/current/settings") });
  const update = async (changes: Partial<WorkspaceSettings>, message = "Saved") => {
    const before = qc.getQueryData<WorkspaceSettings>(SETTINGS_KEY);
    qc.setQueryData<WorkspaceSettings>(SETTINGS_KEY, (s) => ({ ...(s ?? {}), ...changes }));
    try {
      const next = await patch<WorkspaceSettings>("/api/app/workspaces/current/settings", changes);
      qc.setQueryData(SETTINGS_KEY, next);
      qc.invalidateQueries({ queryKey: ME_KEY });
      if (message) toast.success(message);
      return true;
    } catch (e) {
      qc.setQueryData(SETTINGS_KEY, before);
      toast.error(errorMessage(e));
      return false;
    }
  };
  return { settings: q.data, loading: q.isLoading, update };
}
