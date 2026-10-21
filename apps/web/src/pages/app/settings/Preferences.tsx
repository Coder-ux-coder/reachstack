import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CAMPAIGN_TIMEZONES, DEFAULT_WORKSPACE_TIMEZONE, InterestStatus } from "@reachstack/shared";
import { FlaskConical, Tags, Upload } from "lucide-react";
import { errorMessage, get, patch, post, put } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks";
import { imageToDataUrl } from "@/lib/image";
import { useBrowserNotifications } from "@/lib/notifications";
import { ME_KEY, useBrand, useCan } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { Avatar, Badge, Button, Callout, Dialog, Field, Input, NativeSelect, NumberInput, Section, Switch, SwitchRow, TagInput, Textarea } from "@/components/ui";
import { useDraft, useUnsavedChanges } from "@/lib/unsaved";
import { SettingsHeader, useWorkspaceSettings } from "./parts";

interface WorkspaceRow {
  id: string;
  name: string;
  org_logo_url: string | null;
  default_opportunity_value: number | null;
}

interface AiSettings {
  server_key_configured: boolean;
  workspace_key_set: boolean;
  available: boolean;
  auto_label_with_ai: boolean;
}

/** Statuses a reply can signal by itself; the others are set by people after meetings or deals. */
const AI_BUILT_IN = new Set<number>([InterestStatus.INTERESTED, InterestStatus.MEETING_BOOKED, InterestStatus.OUT_OF_OFFICE, InterestStatus.NOT_INTERESTED, InterestStatus.WRONG_PERSON, InterestStatus.LOST]);

function WorkspaceSection({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace-current"], queryFn: () => get<WorkspaceRow>("/api/v2/workspaces/current") });
  const [name, setName] = useState("");
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ws.data) {
      setName(ws.data.name);
      setValue(ws.data.default_opportunity_value);
    }
  }, [ws.data]);
  const save = async (changes: Record<string, unknown>, message = "Workspace updated") => {
    setBusy(true);
    try {
      await patch("/api/app/workspaces/current", changes);
      await qc.invalidateQueries({ queryKey: ["workspace-current"] });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success(message);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!ws.data) return null;
  const dirty = name.trim() !== ws.data.name || value !== ws.data.default_opportunity_value;
  return (
    <Section title="Workspace" description="The name and logo teammates and clients see.">
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar name={ws.data.name} src={ws.data.org_logo_url} size={48} className="rounded-xl" />
          {admin && (
            <div className="flex gap-2">
              <input
                ref={file}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    await save({ logo_url: await imageToDataUrl(f, 256) }, "Logo updated");
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              />
              <Button size="sm" icon={<Upload size={14} />} onClick={() => file.current?.click()}>
                Upload logo
              </Button>
              {ws.data.org_logo_url && (
                <Button size="sm" variant="ghost" onClick={() => save({ logo_url: null }, "Logo removed")}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workspace name">{(id) => <Input id={id} value={name} maxLength={120} disabled={!admin} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Default opportunity value" hint="Counted when a lead turns positive and its campaign has no value of its own.">
            {(id) => <NumberInput id={id} value={value} onChange={setValue} min={0} suffix="USD" disabled={!admin} />}
          </Field>
        </div>
        <p className="text-xs text-muted">Workspace ID: {ws.data.id}</p>
        {admin && (
          <Button variant="primary" disabled={!dirty || !name.trim()} loading={busy} onClick={() => save({ name: name.trim(), default_opportunity_value: value })}>
            Save
          </Button>
        )}
      </div>
    </Section>
  );
}

function LabelsDialog({ open, onOpenChange, allowed, onChange }: { open: boolean; onOpenChange: (v: boolean) => void; allowed: number[] | null; onChange: (codes: number[] | null) => void }) {
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const builtIn = statuses.all.filter((s) => !s.custom && AI_BUILT_IN.has(s.code));
  const custom = statuses.all.filter((s) => s.custom);
  const isOn = (code: number) => !allowed || allowed.includes(code);
  const toggleBuiltIn = (code: number, on: boolean) => {
    const current = allowed ?? builtIn.map((s) => s.code);
    const next = on ? [...new Set([...current, code])] : current.filter((c) => c !== code);
    onChange(next.length === builtIn.length ? null : next);
  };
  const toggleCustom = async (id: string, on: boolean) => {
    try {
      await patch(`/api/v2/lead-labels/${id}`, { use_with_ai: on });
      await qc.invalidateQueries({ queryKey: ["lead-statuses"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Labels the AI can apply" description="Turn labels off to keep the AI from using them on incoming replies." footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}>
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Built-in labels</p>
          <div className="divide-y divide-line rounded-lg border border-line">
            {builtIn.map((s) => (
              <label key={s.code} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
                <Switch size="sm" checked={isOn(s.code)} onChange={(v) => toggleBuiltIn(s.code, v)} aria-label={s.label} />
              </label>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Custom labels</p>
          {custom.length ? (
            <div className="divide-y divide-line rounded-lg border border-line">
              {custom.map((s) => (
                <div key={s.code} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </span>
                    {!s.custom!.description && <span className="mt-0.5 block text-xs text-warn">Add a description so the AI knows when to use it.</span>}
                  </span>
                  <Switch size="sm" checked={!!s.custom!.use_with_ai} onChange={(v) => toggleCustom(s.custom!.id, v)} aria-label={s.label} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              No custom labels yet. <Link to="/app/settings/lead-labels" className="text-brand-text hover:underline">Create one</Link> and describe when it applies.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function TestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ result: string | null; reason: string; confidence: number; method: string; custom_labels_considered: string[] } | null>(null);
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await post("/api/v2/lead-labels/ai-reply-label", { reply_text: text }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Test reply labelling"
      description="Paste a reply to see which label it would get."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={run}>
            Run test
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Thanks for reaching out. Could you send me the PDF?" aria-label="Reply to test" />
        {result && (
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-[13px]">
            <p>
              Detected label: {result.result ? <Badge tone="brand">{result.result}</Badge> : <span className="text-muted">No label</span>}
              <span className="ml-2 text-xs text-muted">
                {Math.round(result.confidence * 100)}% · {result.method === "ai" ? "AI" : "keyword rules (no AI key)"}
              </span>
            </p>
            <p className="mt-1 text-muted">{result.reason}</p>
            <p className="mt-1 text-xs text-faint">Custom labels considered: {result.custom_labels_considered.length ? result.custom_labels_considered.join(", ") : "none"}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AiSection({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const { settings, update } = useWorkspaceSettings();
  const ai = useQuery({ queryKey: ["ai-settings"], queryFn: () => get<AiSettings>("/api/app/ai/settings") });
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  if (!settings || !ai.data) return null;
  const setAutoLabel = async (v: boolean) => {
    try {
      await put("/api/app/ai/settings", { auto_label_with_ai: v });
      await qc.invalidateQueries({ queryKey: ["ai-settings"] });
      toast.success("Saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section
      title="AI automations"
      description="Label replies as they arrive."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Tags size={14} />} onClick={() => setLabelsOpen(true)} disabled={!admin}>
            Choose labels
          </Button>
          <Button size="sm" icon={<FlaskConical size={14} />} onClick={() => setTestOpen(true)}>
            Test
          </Button>
        </div>
      }
    >
      {!ai.data.available && (
        <Callout tone="info" className="mb-2">
          No AI key is set, so replies are labelled with keyword rules. <Link to="/app/settings/integrations#ai" className="font-medium text-brand-text hover:underline">Add an Anthropic key</Link> for better accuracy.
        </Callout>
      )}
      <div className="divide-y divide-line">
        <SwitchRow label="Automatically label replies" description="Sets the lead's status from each reply." checked={ai.data.auto_label_with_ai} onChange={setAutoLabel} disabled={!admin} />
        <SwitchRow
          label="Let the AI replace existing labels"
          description="When a later reply points to a better label, the AI can change one already set. Leave off if your team labels by hand."
          checked={!!settings.update_existing_labels_with_ai}
          onChange={(v) => update({ update_existing_labels_with_ai: v })}
          disabled={!admin || !ai.data.auto_label_with_ai}
        />
        <SwitchRow label="Label out-of-office replies" description="Automatic replies saying the lead is away get the Out of office status." checked={settings.auto_label_ooo !== false} onChange={(v) => update({ auto_label_ooo: v })} disabled={!admin || !ai.data.auto_label_with_ai} />
        <div className="flex items-center justify-between gap-6 py-3">
          <div>
            <p className="text-sm font-medium">AI reply agent</p>
            <p className="mt-0.5 text-[13px] text-muted">Drafts or sends replies to leads in the Unibox, with your guidance and approval rules.</p>
          </div>
          <Link to="/app/ai-agents" className="-my-1 shrink-0 py-1 text-[13px] font-medium text-brand-text hover:underline">
            Set up in Agents
          </Link>
        </div>
      </div>
      <LabelsDialog open={labelsOpen} onOpenChange={setLabelsOpen} allowed={settings.ai_label_codes ?? null} onChange={(codes) => update({ ai_label_codes: codes })} />
      <TestDialog open={testOpen} onOpenChange={setTestOpen} />
    </Section>
  );
}

/** Unlike the rest of this page, this is personal and kept by each browser (lib/notifications.ts). */
function BrowserNotificationsSection() {
  const brand = useBrand();
  const browser = useBrowserNotifications();
  const toggle = async (on: boolean) => {
    const answer = await browser.setEnabled(on);
    if (on && answer === "denied") toast.error("Your browser blocks notifications for this site. Allow them in its site settings, then try again.");
  };
  return (
    <Section title="On this browser" description="Just for you, on the browser you're using now.">
      <div className="divide-y divide-line">
        <SwitchRow
          label="Browser notifications"
          description={
            browser.permission === "unsupported"
              ? "This browser can't show notifications."
              : browser.permission === "denied"
                ? "Blocked for this site. Allow notifications in your browser's site settings to turn this on."
                : `An alert from your browser for each new notification under the bell, while ${brand} is open in a tab.`
          }
          checked={browser.enabled}
          onChange={toggle}
          disabled={browser.permission === "unsupported" || browser.permission === "denied"}
        />
      </div>
    </Section>
  );
}

export default function Preferences() {
  usePageTitle("Preferences");
  const can = useCan();
  const { settings, update } = useWorkspaceSettings();
  // Typed but not saved yet: kept when another setting on the page is saved.
  const [recipients, setRecipients, recipientsDirty] = useDraft<string[]>(settings?.notification_recipients ?? []);
  const [threshold, setThreshold] = useDraft<number | null>(settings?.bounce_protect_threshold ?? 5);
  const [advanced, setAdvanced] = useState(false);
  const admin = can.admin;
  // Recipients and the bounce limit have their own Save buttons: leaving with either unsaved asks first.
  useUnsavedChanges(admin && (recipientsDirty || threshold !== (settings?.bounce_protect_threshold ?? 5)));
  if (!settings) return <SettingsHeader title="Preferences" />;
  const tz = settings.default_timezone ?? DEFAULT_WORKSPACE_TIMEZONE;
  const zones = (CAMPAIGN_TIMEZONES as readonly string[]).includes(tz) ? [...CAMPAIGN_TIMEZONES] : [tz, ...CAMPAIGN_TIMEZONES];

  return (
    <div>
      <SettingsHeader title="Preferences" description={admin ? "Applies to everyone in this workspace." : "Only workspace admins can change these."} />
      <WorkspaceSection admin={admin} />

      <Section title="Leads" description="How lead statuses and replies carry across campaigns.">
        <div className="divide-y divide-line">
          <SwitchRow
            label="Keep lead statuses in sync across campaigns"
            description="Changing a lead's status also changes it for the same address in your other campaigns and lists."
            checked={!settings.disable_global_lead_status_sync}
            onChange={(v) => update({ disable_global_lead_status_sync: !v })}
            disabled={!admin}
          />
          <SwitchRow
            label="Stop a lead in every campaign when they reply to one"
            description="Otherwise only the campaign they replied to stops."
            checked={settings.stop_campaign_on_lead_reply_from_any_campaign !== false}
            onChange={(v) => update({ stop_campaign_on_lead_reply_from_any_campaign: v })}
            disabled={!admin}
          />
        </div>
      </Section>

      <AiSection admin={admin} />

      <Section title="Unibox" description="What shows up in the shared inbox.">
        <div className="divide-y divide-line">
          <SwitchRow label="Show auto-replies" description="Out-of-office and other automatic replies. Searching for is:auto still finds them." checked={settings.unibox_show_auto_replies !== false} onChange={(v) => update({ unibox_show_auto_replies: v })} disabled={!admin} />
          <SwitchRow label="Keep emails that aren't part of a campaign" description="Mail from people who aren't your leads. When off, it isn't stored at all." checked={settings.unibox_save_non_campaign_emails !== false} onChange={(v) => update({ unibox_save_non_campaign_emails: v })} disabled={!admin} />
          <SwitchRow label="Show bounce notices" description="Undelivered-mail reports. Bounces still count in analytics either way." checked={settings.unibox_save_undelivered !== false} onChange={(v) => update({ unibox_save_undelivered: v })} disabled={!admin} />
        </div>
      </Section>

      <Section title="Outreach" description="Sending behaviour for every campaign in this workspace.">
        <div className="divide-y divide-line">
          <SwitchRow
            label="Pause campaigns with high bounce rates"
            description={`A campaign pauses when ${settings.bounce_protect_threshold ?? 5}% of the emails it sent in the last 7 days hard-bounced, once it has sent at least 200. After you resume it, it isn't paused again for 7 days. Campaigns can opt out in their options.`}
            checked={settings.auto_pause_on_bounce !== false}
            onChange={(v) => update({ auto_pause_on_bounce: v })}
            disabled={!admin}
          >
            <div className="flex items-end gap-2">
              <Field label="Pause at" className="w-36">
                {(id) => <NumberInput id={id} value={threshold} onChange={setThreshold} min={1} max={20} suffix="%" disabled={!admin} />}
              </Field>
              <Button size="sm" disabled={!admin || !threshold || threshold === (settings.bounce_protect_threshold ?? 5)} onClick={() => threshold && update({ bounce_protect_threshold: threshold })}>
                Save
              </Button>
            </div>
          </SwitchRow>
          <div className="py-3">
            <Field label="Workspace timezone" hint="New campaign schedules start in this timezone, and agents time their follow-ups by it. Daily sending limits reset at its midnight, and warmup keeps to its daytime hours.">
              {(id) => <NativeSelect id={id} value={tz} onChange={(v) => update({ default_timezone: v })} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} disabled={!admin} className="max-w-xs" />}
            </Field>
          </div>
          <div className="py-2">
            <button type="button" className="-my-1 py-1 text-[13px] font-medium text-brand-text hover:underline" onClick={() => setAdvanced(!advanced)}>
              {advanced ? "Hide advanced" : "Show advanced"}
            </button>
          </div>
          {advanced && (
            <>
              <SwitchRow
                label="Sticky sending accounts for leads"
                description="A lead's first email in a new campaign comes from the mailbox that emailed them before, when it's part of that campaign."
                checked={!!settings.sticky_sending_accounts_for_leads}
                onChange={(v) => update({ sticky_sending_accounts_for_leads: v })}
                disabled={!admin}
              />
              <SwitchRow
                label="One sending account per time gap"
                description="Normally every mailbox in a campaign waits out its own gap. With this on, the whole campaign waits after each email."
                checked={!!settings.single_account_per_gap}
                onChange={(v) => update({ single_account_per_gap: v })}
                disabled={!admin}
              />
              <SwitchRow label="Send emails one at a time" description="Releases a single email per sending pass instead of a burst across mailboxes." checked={!!settings.send_one_at_a_time} onChange={(v) => update({ send_one_at_a_time: v })} disabled={!admin} />
            </>
          )}
        </div>
      </Section>

      <Section title="Notifications" description="Emails about events that need attention. The bell at the top of the app shows these and more.">
        <div className="divide-y divide-line">
          <SwitchRow label="A sending account disconnects" checked={settings.notify_account_disconnect !== false} onChange={(v) => update({ notify_account_disconnect: v })} disabled={!admin} />
          <SwitchRow label="A lead replies positively" description="Interested, meeting booked, or a positive custom label." checked={settings.notify_positive_reply !== false} onChange={(v) => update({ notify_positive_reply: v })} disabled={!admin} />
          <div className="space-y-2 py-3">
            <Field label="Send notifications to" hint="Leave empty to notify the workspace owner and admins.">
              {(id) => <TagInput id={id} value={recipients} onChange={setRecipients} placeholder="name@company.com" validate={(v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)} disabled={!admin} />}
            </Field>
            {admin && recipientsDirty && (
              <Button size="sm" variant="primary" onClick={() => update({ notification_recipients: recipients })}>
                Save recipients
              </Button>
            )}
          </div>
        </div>
      </Section>

      <BrowserNotificationsSection />
    </div>
  );
}
