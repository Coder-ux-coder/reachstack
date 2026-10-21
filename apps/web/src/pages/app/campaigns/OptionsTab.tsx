import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Plus, Save, Trash2 } from "lucide-react";
import { isValidEmailSyntax } from "@reachstack/shared";
import { errorMessage, get, post, type Page } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { rebase, useDraft, useReportUnsaved, useUnsavedChanges } from "@/lib/unsaved";
import { AccountsPicker } from "@/components/sequence/AccountsPicker";
import { TagPicker, useTags } from "@/components/TagPicker";
import { Badge, Button, Card, Checkbox, Field, NativeSelect, NumberInput, Segmented, TagInput } from "@/components/ui";
import { useCampaign, type CampaignDetail } from "./context";

type Rule = CampaignDetail["provider_routing_rules"][number];
type Esp = Rule["recipient_esp"][number];

const FIELDS = [
  "email_list",
  "email_tag_list",
  "stop_on_reply",
  "open_tracking",
  "link_tracking",
  "text_only",
  "first_email_text_only",
  "daily_limit",
  "owned_by",
  "email_gap",
  "random_wait_max",
  "daily_max_leads",
  "prioritize_new_leads",
  "auto_variant_select",
  "match_lead_esp",
  "stop_for_company",
  "stop_on_auto_reply",
  "insert_unsubscribe_header",
  "allow_risky_contacts",
  "disable_bounce_protect",
  "cc_list",
  "bcc_list",
  "limit_emails_per_company_override",
  "provider_routing_rules",
  "slow_ramp_up",
  "is_evergreen",
  "pl_value",
] as const;

type Draft = Pick<CampaignDetail, (typeof FIELDS)[number]>;

const pick = (c: CampaignDetail): Draft => Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? null])) as Draft;

function Row({ title, description, children, badge }: { title: ReactNode; description?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className="grid gap-3 border-b border-line py-5 last:border-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-8">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </p>
        {description && <p className="mt-1 text-[13px] leading-snug text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OnOff({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn(disabled && "pointer-events-none opacity-60")}>
      <Segmented
        size="sm"
        value={value ? "on" : "off"}
        onChange={(v) => onChange(v === "on")}
        options={[
          { value: "off", label: "Disable" },
          { value: "on", label: "Enable" },
        ]}
      />
    </div>
  );
}

const ESPS: Array<{ value: Esp; label: string }> = [
  { value: "all", label: "Any provider" },
  { value: "google", label: "Google" },
  { value: "outlook", label: "Microsoft" },
  { value: "other", label: "Other" },
];

export default function OptionsTab() {
  const { campaign, save, readOnly, setPending } = useCampaign();
  const me = useSession();
  const qc = useQueryClient();
  // Follows the saved options only: the reload after a tag change, Launch or Pause leaves unsaved edits alone.
  const [d, setD, dirty] = useDraft(pick(campaign), campaign.id);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(dirty && !readOnly);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

  const members = useQuery({
    queryKey: ["workspace-members"],
    queryFn: () => get<Page<{ user_id: string | null; email: string; name: { first: string; last: string }; accepted: boolean }>>("/api/v2/workspace-members", { limit: 100 }),
    enabled: advanced,
  });
  const tagList = useTags();
  const settings = useQuery({ queryKey: ["workspace-settings"], queryFn: () => get<Record<string, unknown>>("/api/app/workspaces/current/settings"), enabled: advanced });
  const companyLimit = settings.data?.limit_emails_per_company as { enabled?: boolean; daily_limit?: number } | undefined;

  const persist = async () => {
    setSaving(true);
    try {
      const sent = d;
      const saved = pick(campaign);
      // Only what was changed here: the rest may have been changed elsewhere since (and an owner who has since left the
      // workspace would be refused).
      const changes = Object.fromEntries(FIELDS.filter((k) => JSON.stringify(sent[k]) !== JSON.stringify(saved[k])).map((k) => [k, sent[k]]));
      const updated = await save(changes);
      // The options as the server keeps them; anything changed while saving stays unsaved.
      setD((cur) => rebase(cur, sent, pick({ ...campaign, ...updated })));
      toast.success("Options saved");
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useReportUnsaved(dirty && !readOnly, persist, (s) => setPending(s && { what: "options", save: s }));

  const setTags = async (ids: string[]) => {
    const current = campaign.tags ?? [];
    const add = ids.filter((t) => !current.includes(t));
    const remove = current.filter((t) => !ids.includes(t));
    try {
      if (add.length) await post("/api/v2/custom-tags/toggle-resource", { tag_ids: add, resource_type: 2, resource_ids: [campaign.id], assign: true });
      if (remove.length) await post("/api/v2/custom-tags/toggle-resource", { tag_ids: remove, resource_type: 2, resource_ids: [campaign.id], assign: false });
      await qc.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      // The campaigns list shows and filters by tags too.
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const rules = d.provider_routing_rules ?? [];
  const setRule = (i: number, patch: Partial<Rule>) => set("provider_routing_rules", rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const override = d.limit_emails_per_company_override;

  return (
    <div className="mx-auto max-w-5xl">
      <Card className="py-0">
        <Row title="Accounts to use" description="Select one or more accounts to send emails from. Sending rotates across them.">
          <AccountsPicker emails={d.email_list} tagIds={d.email_tag_list} disabled={readOnly} onChange={(v) => setD((cur) => ({ ...cur, email_list: v.emails, email_tag_list: v.tagIds }))} />
        </Row>
        <Row title="Stop sending emails on reply" description="Stop the sequence for a lead as soon as they reply.">
          <OnOff value={d.stop_on_reply !== false} onChange={(v) => set("stop_on_reply", v)} disabled={readOnly} />
        </Row>
        <Row title="Open tracking" description="Track email opens with a tiny image. Off by default because it can hurt inbox placement.">
          <div className="space-y-2">
            <OnOff value={!!d.open_tracking} onChange={(v) => set("open_tracking", v)} disabled={readOnly} />
            <Checkbox label="Link tracking (rewrite links to count clicks)" checked={d.link_tracking !== false && !!d.link_tracking} disabled={readOnly} onChange={(v) => set("link_tracking", v)} />
            {!me.features.tracking_reachable && (d.open_tracking || d.link_tracking) && (
              <p className="text-xs text-muted">
                This server can't be reached from the internet, so emails from your own mailboxes keep their links as written and opens and clicks aren't
                counted. Replies, bounces and unsubscribes still are. Sandbox mailboxes show tracking as usual.
              </p>
            )}
          </div>
        </Row>
        <Row title="Delivery optimization" badge={<Badge tone="ok">Recommended</Badge>} description="Plain-text emails look personal and land in the inbox more often. Text-only also turns off open tracking.">
          <div className="space-y-2">
            <Checkbox
              label="Send emails as text-only (no HTML)"
              checked={!!d.text_only}
              disabled={readOnly}
              onChange={(v) => setD((cur) => ({ ...cur, text_only: v, ...(v ? { open_tracking: false } : {}) }))}
            />
            <Checkbox label="Send the first email as text-only" checked={!!d.first_email_text_only} disabled={readOnly || !!d.text_only} onChange={(v) => set("first_email_text_only", v)} />
          </div>
        </Row>
        <Row title="Daily limit" description="The most emails this campaign sends per day, across all its accounts. Each account's own limit still applies.">
          <NumberInput value={d.daily_limit} onChange={(v) => set("daily_limit", v)} min={0} max={100000} suffix="emails" disabled={readOnly} className="w-40" aria-label="Daily limit" />
        </Row>

        <div className="py-4">
          <button type="button" onClick={() => setAdvanced(!advanced)} className="-my-1 inline-flex items-center gap-1.5 py-1 text-[13px] font-medium text-brand-text">
            <ChevronDown size={15} className={cn("transition-transform", advanced && "rotate-180")} />
            {advanced ? "Hide advanced options" : "Show advanced options"}
          </button>
        </div>

        {advanced && (
          <>
            <Row title="Owner" description="The teammate responsible for this campaign. Used for filters and CRM assignment.">
              <NativeSelect
                value={d.owned_by ?? ""}
                disabled={readOnly}
                onChange={(v) => set("owned_by", v || null)}
                options={[
                  { value: "", label: "No owner" },
                  ...(members.data?.items ?? [])
                    .filter((m) => m.user_id)
                    .map((m) => ({ value: m.user_id!, label: [m.name.first, m.name.last].filter(Boolean).join(" ") || m.email })),
                ]}
              />
            </Row>
            <Row title="Custom tags" description="Tags group campaigns for filtering and reports.">
              {readOnly ? (
                <p className="text-[13px] text-muted">
                  {(campaign.tags ?? [])
                    .map((id) => tagList.data?.find((t) => t.id === id)?.label)
                    .filter(Boolean)
                    .join(", ") || "None"}
                </p>
              ) : (
                <TagPicker value={campaign.tags ?? []} onChange={setTags} title="Add tags" />
              )}
            </Row>
            <Row title="Sending pattern" description="How emails are spaced out. Gaps are per sending account.">
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Minimum time between emails">
                    {(id) => <NumberInput id={id} value={d.email_gap} onChange={(v) => set("email_gap", v)} min={0} max={1440} suffix="min" disabled={readOnly} />}
                  </Field>
                  <Field label="Random additional time">
                    {(id) => <NumberInput id={id} value={d.random_wait_max} onChange={(v) => set("random_wait_max", v)} min={0} max={1440} suffix="min" disabled={readOnly} />}
                  </Field>
                  <Field label="Max new leads per day">
                    {(id) => <NumberInput id={id} value={d.daily_max_leads} onChange={(v) => set("daily_max_leads", v || null)} min={0} suffix="leads" disabled={readOnly} />}
                  </Field>
                </div>
                <Checkbox label="Prioritize new leads over scheduled follow-ups" checked={!!d.prioritize_new_leads} disabled={readOnly} onChange={(v) => set("prioritize_new_leads", v)} />
                <div className="space-y-2">
                  <Checkbox
                    label="Auto-optimize A/B testing (send the winning variant once there's enough data)"
                    checked={!!d.auto_variant_select}
                    disabled={readOnly}
                    onChange={(v) => set("auto_variant_select", v ? { trigger: "reply_rate" } : null)}
                  />
                  {d.auto_variant_select && (
                    <div className="ml-6 flex items-center gap-2 text-[13px]">
                      Winning metric
                      <NativeSelect
                        size="sm"
                        className="w-40"
                        value={d.auto_variant_select.trigger}
                        disabled={readOnly}
                        onChange={(v) => set("auto_variant_select", { trigger: v as "reply_rate" })}
                        options={[
                          { value: "reply_rate", label: "Reply rate" },
                          { value: "click_rate", label: "Click rate" },
                          { value: "open_rate", label: "Open rate" },
                        ]}
                      />
                    </div>
                  )}
                  {d.auto_variant_select && ((d.auto_variant_select.trigger === "open_rate" && !d.open_tracking) || (d.auto_variant_select.trigger === "click_rate" && !d.link_tracking)) && (
                    <p className="ml-6 text-xs text-warn">
                      {d.auto_variant_select.trigger === "open_rate" ? "Open tracking is off" : "Link tracking is off"}, so there's nothing to compare: variants keep taking turns.
                    </p>
                  )}
                  <p className="ml-6 text-xs text-muted">Variants take turns so each gets the same share. A winner is picked once each has 50 sends and there are a few results to compare.</p>
                </div>
                <Checkbox label="Slow ramp-up: start with a few emails a day and grow gradually" checked={!!d.slow_ramp_up} disabled={readOnly} onChange={(v) => set("slow_ramp_up", v)} />
              </div>
            </Row>
            <Row title="Provider matching" description="Send from a Google account to Google recipients and Microsoft to Microsoft when possible. Usually improves inbox placement.">
              <OnOff value={!!d.match_lead_esp} onChange={(v) => set("match_lead_esp", v)} disabled={readOnly} />
            </Row>
            <Row title="Provider rules" description="Finer control: which sender providers may email which recipient providers.">
              <div className="space-y-2">
                {rules.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <NativeSelect
                      size="sm"
                      className="w-32"
                      value={r.action}
                      disabled={readOnly}
                      onChange={(v) => setRule(i, { action: v as Rule["action"] })}
                      options={[
                        { value: "send", label: "Send" },
                        { value: "do_not_send", label: "Don't send" },
                      ]}
                    />
                    to
                    <NativeSelect size="sm" className="w-36" value={r.recipient_esp[0] ?? "all"} disabled={readOnly} onChange={(v) => setRule(i, { recipient_esp: [v as Esp] })} options={ESPS} />
                    recipients from
                    <NativeSelect size="sm" className="w-36" value={r.sender_esp[0] ?? "all"} disabled={readOnly} onChange={(v) => setRule(i, { sender_esp: [v as Esp] })} options={ESPS} />
                    accounts
                    {!readOnly && (
                      <Button size="icon-sm" variant="ghost" aria-label="Remove rule" onClick={() => set("provider_routing_rules", rules.filter((_, j) => j !== i))}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                ))}
                {!readOnly && (
                  <Button size="xs" icon={<Plus size={13} />} onClick={() => set("provider_routing_rules", [...rules, { action: "send", recipient_esp: ["google"], sender_esp: ["google"] }])}>
                    Add rule
                  </Button>
                )}
              </div>
            </Row>
            <Row title="Stop campaign for company on reply" description="When anyone at a company replies, stop emailing everyone else from that company in this campaign.">
              <OnOff value={!!d.stop_for_company} onChange={(v) => set("stop_for_company", v)} disabled={readOnly} />
            </Row>
            <Row
              title="Stop sending emails on auto-reply"
              description="Stop the sequence when any automatic response arrives. When off, an out-of-office message pauses the lead until the day after they're back (a week if they don't say, 30 days at most), then the sequence carries on."
            >
              <OnOff value={!!d.stop_on_auto_reply} onChange={(v) => set("stop_on_auto_reply", v)} disabled={readOnly} />
            </Row>
            <Row title="Insert unsubscribe link header" description="Adds a one-click unsubscribe header that Gmail and Outlook show next to the sender. Bulk senders are expected to include it.">
              <OnOff value={d.insert_unsubscribe_header !== false && !!d.insert_unsubscribe_header} onChange={(v) => set("insert_unsubscribe_header", v)} disabled={readOnly} />
            </Row>
            <Row title="Allow risky emails" description="Contact leads that verification marked as risky, or turn off bounce protection for this campaign.">
              <div className="space-y-2">
                <Checkbox label="Send to risky emails" checked={!!d.allow_risky_contacts} disabled={readOnly} onChange={(v) => set("allow_risky_contacts", v)} />
                <Checkbox label="Disable bounce protection (not recommended)" checked={!!d.disable_bounce_protect} disabled={readOnly} onChange={(v) => set("disable_bounce_protect", v)} />
              </div>
            </Row>
            <Row
              title="Company email limits"
              description={
                <>
                  {companyLimit?.enabled ? `Workspace limit: at most ${companyLimit.daily_limit ?? 3} emails per company per day. ` : "No workspace-wide company limit is set. "}
                  <Link to="/app/settings/advanced-deliverability" className="text-brand-text hover:underline">
                    Manage workspace defaults
                  </Link>
                </>
              }
            >
              <div className="space-y-2">
                <Checkbox
                  label="Override the workspace setting for this campaign"
                  checked={!!override}
                  disabled={readOnly}
                  onChange={(v) => set("limit_emails_per_company_override", v ? { mode: "custom", daily_limit: companyLimit?.daily_limit ?? 3 } : null)}
                />
                {override && (
                  <div className="ml-6 flex flex-wrap items-center gap-2 text-[13px]">
                    <NativeSelect
                      size="sm"
                      className="w-56"
                      value={override.mode}
                      disabled={readOnly}
                      onChange={(v) => set("limit_emails_per_company_override", { ...override, mode: v as "custom" })}
                      options={[
                        { value: "custom", label: "Yes, use a custom limit" },
                        { value: "disabled", label: "No, no limit for this campaign" },
                      ]}
                    />
                    {override.mode === "custom" && (
                      <NumberInput value={override.daily_limit ?? 3} onChange={(v) => set("limit_emails_per_company_override", { ...override, daily_limit: Math.max(1, v ?? 1) })} min={1} suffix="per day" disabled={readOnly} aria-label="Emails per company per day" />
                    )}
                  </div>
                )}
              </div>
            </Row>
            <Row title="CC and BCC" description="Recipients copied on every email in this campaign.">
              <div className="space-y-3">
                <Field label="CC">{(id) => <TagInput id={id} value={d.cc_list} onChange={(v) => set("cc_list", v)} validate={isValidEmailSyntax} placeholder="Separate emails with a comma" disabled={readOnly} />}</Field>
                <Field label="BCC">{(id) => <TagInput id={id} value={d.bcc_list} onChange={(v) => set("bcc_list", v)} validate={isValidEmailSyntax} placeholder="Separate emails with a comma" disabled={readOnly} />}</Field>
              </div>
            </Row>
            <Row title="Evergreen" description="Keep the campaign running after every lead finishes, so leads you add later start right away.">
              <OnOff value={!!d.is_evergreen} onChange={(v) => set("is_evergreen", v)} disabled={readOnly} />
            </Row>
            <Row title="Value per opportunity" description="Used to estimate pipeline value in analytics when a lead becomes an opportunity.">
              <NumberInput value={d.pl_value} onChange={(v) => set("pl_value", v)} min={0} suffix="$" disabled={readOnly} className="w-40" aria-label="Value per opportunity" />
            </Row>
          </>
        )}
      </Card>

      {!readOnly && (
        <div className="sticky bottom-4 mt-4 flex justify-end">
          <Button variant="primary" icon={<Save size={15} />} loading={saving} disabled={!dirty} onClick={persist} className="shadow-lg">
            {dirty ? "Save options" : "Saved"}
          </Button>
        </div>
      )}
    </div>
  );
}

