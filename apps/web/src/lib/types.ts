import type { Account as BaseAccount, Campaign as BaseCampaign, DomainDns, Lead as BaseLead, MailboxHealth } from "@reachstack/shared";

export type { Email, LeadList, SequenceStep, SequenceVariant, CampaignSchedule, ScheduleWindow } from "@reachstack/shared";

export interface Tag {
  id: string;
  label: string;
  description?: string | null;
  color?: string | null;
  timestamp_created?: string;
}

export type Account = Omit<BaseAccount, "tags"> & {
  daily_limit_max: number | null;
  warmup_limit_max: number | null;
  timestamp_last_used: string | null;
  autofix_failed: string | null;
  imap_host: string | null;
  imap_port?: number | null;
  imap_username?: string | null;
  smtp_host: string | null;
  smtp_port?: number | null;
  smtp_username?: string | null;
  connection: "oauth_google" | "oauth_microsoft" | "password" | "sandbox" | string;
  campaign_pause_until: string | null;
  inbox_placement_test_limit: number | null;
  tags?: Tag[];
  /** Today's campaign limit (the slow ramp's step) and warmup target, on the workspace clock. */
  daily_limit_today?: number;
  warmup_target_today?: number;
  /** Earlier days with warmup emails sent: how far along the warmup ramp is. */
  warmup_days?: number;
  /** Health over the last 14 days (lists and single-account responses). */
  health?: MailboxHealth | null;
  /** Mailboxes this one can exchange warmup with (single-account responses). */
  warmup_partners?: number;
  /** The same address is connected in another workspace, and its warmup runs from there. */
  warmup_elsewhere?: boolean;
  /** False until mail to the address has been seen arriving (or it signs in with it): until then it only sends warmup. */
  warmup_address_confirmed?: boolean;
  /** The latest DNS check of the mailbox's domain: null until it's checked, and for sandbox mailboxes. */
  dns?: DomainDns | null;
};

export type Campaign = BaseCampaign & {
  leads_count?: number;
  timestamp_launched?: string | null;
};

export type Lead = BaseLead & {
  campaign_name?: string | null;
  list_name?: string | null;
};
