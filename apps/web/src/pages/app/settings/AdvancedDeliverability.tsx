import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { Button, Callout, Field, NativeSelect, NumberInput, Section, Segmented, SwitchRow } from "@/components/ui";
import { SettingsHeader, useWorkspaceSettings, type FilterAction } from "./parts";

const ACTIONS: Array<{ value: FilterAction; label: string; hint: string }> = [
  { value: "send_as_usual", label: "Send as usual", hint: "No special treatment." },
  { value: "send_last", label: "Send last", hint: "Their first email waits until other new leads have been reached." },
  { value: "skip", label: "Skip", hint: "They're never emailed (unless their sequence already started)." },
];

/** /app/settings/advanced-deliverability */
export default function AdvancedDeliverability() {
  usePageTitle("Advanced deliverability");
  const can = useCan();
  const admin = can.admin;
  const { settings, update } = useWorkspaceSettings();
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    if (settings) setCap(settings.limit_emails_per_company?.daily_limit ?? 3);
  }, [settings]);
  if (!settings) return <SettingsHeader title="Advanced deliverability" />;
  const filtering = settings.ai_lead_filtering ?? { unlikely_to_reply: "send_as_usual", hostile: "send_as_usual" };
  const company = settings.limit_emails_per_company ?? { enabled: false, daily_limit: 3, scope: "across_workspace" as const };

  return (
    <div>
      <SettingsHeader title="Advanced deliverability" description="Workspace-wide rules that protect sender reputation. Campaign options can add to them." />

      <Section title="Lead filtering" description="How to treat leads that rarely reply or tend to report cold email.">
        <div className="space-y-4">
          {(
            [
              ["unlikely_to_reply", "Unlikely to reply", "Shared team inboxes such as info@, sales@ or support@."],
              ["hostile", "Likely to complain", "Desks that handle complaints, like abuse@, legal@, privacy@ or postmaster@."],
            ] as const
          ).map(([key, label, hint]) => (
            <Field key={key} label={label} hint={`${hint} ${ACTIONS.find((a) => a.value === filtering[key])?.hint ?? ""}`}>
              {(id) => (
                <NativeSelect
                  id={id}
                  className="max-w-xs"
                  value={filtering[key]}
                  disabled={!admin}
                  onChange={(v) => update({ ai_lead_filtering: { ...filtering, [key]: v as FilterAction } })}
                  options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
                />
              )}
            </Field>
          ))}
          <p className="flex gap-1.5 text-xs text-muted">
            <Info size={13} className="mt-px shrink-0" /> Leads are classed by their address. There's no shared reply-history model behind this, so treat it as a sensible default rather than a prediction.
          </p>
        </div>
      </Section>

      <Section title="Sending" description="Applied on top of each campaign's own settings.">
        <div className="divide-y divide-line">
          <SwitchRow label="Turn off open tracking everywhere" description="No tracking pixel in any campaign. Opens stop being counted, and emails look more like personal mail." checked={!!settings.disable_open_tracking} onChange={(v) => update({ disable_open_tracking: v })} disabled={!admin} />
          <SwitchRow label="Match the lead's email provider" description="Gmail leads get Google mailboxes and Outlook leads get Microsoft ones when the campaign has both." checked={!!settings.esp_matching_default} onChange={(v) => update({ esp_matching_default: v })} disabled={!admin} />
          <SwitchRow label="Send the first email as plain text" description="The opening email of every campaign goes out without HTML." checked={!!settings.first_email_text_only} onChange={(v) => update({ first_email_text_only: v })} disabled={!admin} />
          <SwitchRow
            label="Limit emails per company"
            description="Caps how many people at one company are emailed each day. Personal-mail domains like gmail.com don't count."
            checked={company.enabled}
            onChange={(v) => update({ limit_emails_per_company: { ...company, enabled: v, daily_limit: company.daily_limit || 3 } })}
            disabled={!admin}
          >
            <div className="flex flex-wrap items-end gap-3">
              <Field label="People per company per day" className="w-48">
                {(id) => <NumberInput id={id} value={cap} onChange={setCap} min={1} max={1000} disabled={!admin} />}
              </Field>
              <Field label="Count">
                {() => (
                  <Segmented
                    size="sm"
                    value={company.scope ?? "across_workspace"}
                    onChange={(scope) => update({ limit_emails_per_company: { ...company, scope } })}
                    options={[
                      { value: "per_campaign", label: "Per campaign" },
                      { value: "across_workspace", label: "Across the workspace" },
                    ]}
                  />
                )}
              </Field>
              <Button size="sm" disabled={!admin || !cap || cap === company.daily_limit} onClick={() => cap && update({ limit_emails_per_company: { ...company, daily_limit: cap } })}>
                Save
              </Button>
            </div>
          </SwitchRow>
        </div>
      </Section>

      <Section title="Sending infrastructure" description="Dedicated IP pools and high-throughput modes.">
        <Callout tone="info">
          Emails go out through your own connected mailboxes (Google, Microsoft or SMTP), so there's no shared IP pool to shard or rotate, and no throttles to relax. Reputation comes from each mailbox and domain; warmup, daily limits and the rules above are what protect it.
        </Callout>
      </Section>
    </div>
  );
}
