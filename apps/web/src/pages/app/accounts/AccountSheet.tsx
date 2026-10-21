import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Link, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Inbox, MoreHorizontal, Pause, Play, RefreshCw, Send, Trash2, Wrench } from "lucide-react";
import {
  AccountStatus,
  HEALTH_MIN,
  HEALTH_STATUS_LABELS,
  PROVIDER_LABELS,
  ProviderCode,
  REST_DAYS,
  SLOW_RAMP,
  WARMUP_HOURS,
  WARMUP_START,
  warmupIncrease,
  warmupRampDays,
  type MailboxHealth,
} from "@reachstack/shared";
import { del, errorMessage, get, isNotFound, patch, post } from "@/lib/api";
import type { Account } from "@/lib/types";
import { useCan } from "@/lib/session";
import { rebase, useDraft, useUnsavedChanges } from "@/lib/unsaved";
import { ago, dateTime, num, pct, plural } from "@/lib/format";
import { BarsChart, TrendChart } from "@/components/charts";
import { RichEditor } from "@/components/RichEditor";
import { AccountStatusBadge, CampaignStatusBadge, HealthBadge, Score, WarmupBadge } from "@/components/status";
import { TagPicker } from "@/components/TagPicker";
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValue,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  NumberInput,
  Select,
  Sheet,
  Skeleton,
  SwitchRow,
  TabPanel,
  Tabs,
  useConfirm,
} from "@/components/ui";
import { ACCOUNTS_KEY } from "./Accounts";
import { DomainSetup } from "./dns";
import { toastFailedTest, type ConnectionTest } from "./checks";

interface WarmupAnalytics {
  email_date_data: Record<string, Record<string, { sent: number; landed_inbox: number; landed_spam: number; received: number; saved_from_spam: number; replied: number }>>;
  aggregate_data: Record<string, { sent: number; landed_inbox: number; landed_spam: number; received: number; saved_from_spam: number; replied: number; health_score: number | null }>;
}

type Tab = "health" | "warmup" | "settings" | "campaigns" | "log";

interface HealthReport {
  health: MailboxHealth | null;
  trend: Array<{ date: string; score: number | null }>;
  timezone: string;
}

/** "6 AM" from 6, "10 PM" from 22. */
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

function HealthTab({ account }: { account: Account }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...ACCOUNTS_KEY, "health", account.email],
    queryFn: () => get<HealthReport>(`/api/app/accounts/${encodeURIComponent(account.email)}/health`),
  });
  const h = q.data?.health ?? account.health ?? null;
  const trend = q.data?.trend ?? [];
  const rate = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v}%`);
  return (
    <div className="space-y-5 p-5">
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3.5">
          <p className="text-xs text-muted">Health score</p>
          <p className="mt-1 text-2xl">
            <Score value={h?.score} />
          </p>
          <p className="mt-0.5 text-xs text-muted">{HEALTH_STATUS_LABELS[h?.status ?? "unknown"]}</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-xs text-muted">Hard bounces</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{rate(h?.bounce_rate)}</p>
          <p className="mt-0.5 text-xs text-muted">{h?.tried ? `${num(h.bounced)} of ${plural(h.tried, "campaign email")}` : "No campaign emails yet"}</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-xs text-muted">Replies</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{rate(h?.reply_rate)}</p>
          <p className="mt-0.5 text-xs text-muted">{h?.sent ? `${num(h.replies)} of ${plural(h.sent, "campaign email")}` : "No campaign emails yet"}</p>
        </Card>
      </div>
      {h && h.score === null ? (
        <Callout title="Not enough activity yet">
          A score shows up once {HEALTH_MIN.placement} warmup emails have landed or about {HEALTH_MIN.sends} emails have gone out in the last {h.window_days} days.
        </Callout>
      ) : h?.issues.length ? (
        <Callout tone={h.status === "at_risk" ? "bad" : "warn"} title="What's pulling the score down">
          <ul className="list-disc space-y-0.5 pl-4">
            {h.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {h && (
        <KeyValue
          items={[
            ["Failed sends", !h.send_errors ? "None" : h.send_error_rate === null ? num(h.send_errors) : `${num(h.send_errors)} (${h.send_error_rate}% of sends)`],
            [
              "Warmup in inbox",
              h.warmup_inbox_rate !== null ? `${h.warmup_inbox_rate}% of ${plural(h.warmup_landed, "warmup email")}` : h.warmup_landed ? `${plural(h.warmup_landed, "warmup email")} landed so far` : "No warmup results yet",
            ],
            ["Period", `Last ${h.window_days} days, workspace time${q.data ? ` (${q.data.timezone.replace(/_/g, " ")})` : ""}`],
          ]}
        />
      )}
      <div>
        <p className="mb-2 text-[13px] font-medium">Health score · last 30 days</p>
        {q.isLoading ? (
          <Skeleton className="h-48" />
        ) : trend.some((d) => d.score !== null) ? (
          <TrendChart data={trend} height={190} series={[{ key: "score", label: "Health score", color: "#10b981" }]} />
        ) : (
          <EmptyState className="py-8" title="No trend yet" description="Each day's score appears here once the mailbox has enough activity." />
        )}
      </div>
      <DomainSetup account={account} onChecked={() => qc.invalidateQueries({ queryKey: ACCOUNTS_KEY })} />
      <RestSection account={account} />
    </div>
  );
}

/** "Rest this mailbox": campaigns skip it for a while (campaign_pause_until); warmup keeps going. */
function RestSection({ account }: { account: Account }) {
  const qc = useQueryClient();
  const can = useCan();
  const [days, setDays] = useState(String(REST_DAYS[1]));
  const [busy, setBusy] = useState(false);
  const until = account.campaign_pause_until && new Date(account.campaign_pause_until) > new Date() ? account.campaign_pause_until : null;
  const save = async (value: string | null, ok: string) => {
    setBusy(true);
    try {
      await patch(`/api/v2/accounts/${encodeURIComponent(account.email)}`, { campaign_pause_until: value });
      await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h3 className="text-sm font-semibold">Rest this mailbox</h3>
      <p className="text-[13px] text-muted">Campaigns skip it for a while so its reputation can recover. Warmup keeps going, and campaigns use it again when the rest ends.</p>
      {until ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px]">Resting until {dateTime(until)}</span>
          {can.perm("accounts") && (
            <Button size="sm" loading={busy} onClick={() => save(null, "Rest ended. Campaigns can use this mailbox again.")}>
              End rest now
            </Button>
          )}
        </div>
      ) : (
        can.perm("accounts") && (
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" className="w-32" value={days} onChange={setDays} options={REST_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} aria-label="How long to rest" />
            <Button size="sm" loading={busy} onClick={() => save(new Date(Date.now() + Number(days) * 86_400_000).toISOString(), `Resting for ${days} days`)}>
              Rest mailbox
            </Button>
          </div>
        )
      )}
    </section>
  );
}

function WarmupTab({ account }: { account: Account }) {
  const a = useQuery({
    queryKey: [...ACCOUNTS_KEY, "warmup-analytics", account.email],
    queryFn: () => post<WarmupAnalytics>("/api/v2/accounts/warmup-analytics", { emails: [account.email], days: 14 }),
  });
  const days = a.data?.email_date_data[account.email] ?? {};
  const agg = a.data?.aggregate_data[account.email];
  const chart = Object.entries(days)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([date, d]) => ({ date, inbox: d.landed_inbox, spam: d.landed_spam, saved: d.saved_from_spam }));
  return (
    <div className="space-y-5 p-5">
      {account.warmup_status === 1 && account.warmup_elsewhere && (
        <Callout title="Warmup runs from its other connection">
          This address is also connected in another workspace on this server, and its warmup runs there, so the mailbox doesn't warm up twice. The numbers here stay empty.
        </Callout>
      )}
      {account.warmup_status === 1 && account.warmup_address_confirmed === false && (
        <Callout tone="warn" title="Waiting for an email to this address">
          This mailbox signs in as {account.imap_username}, so it isn't certain yet that mail to {account.email} reaches it. It sends warmup emails, but gets none until an email to {account.email} arrives in its inbox. Send it one from any mailbox, this one included.
        </Callout>
      )}
      {account.warmup_status === 1 && account.warmup_partners === 0 && (
        <Callout tone="warn" title="No one to warm up with yet">
          {account.provider_code === ProviderCode.SANDBOX
            ? "Test mailboxes warm up with each other. Add another test mailbox with warmup on."
            : "Real mailboxes warm up with the other real mailboxes on this server, and none has warmup on yet. Connect another mailbox and turn on its warmup."}
        </Callout>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3.5">
          <p className="text-xs text-muted">Warmup score</p>
          <p className="mt-1 text-2xl">
            <Score value={agg?.health_score ?? account.stat_warmup_score} />
          </p>
        </Card>
        <Card className="p-3.5">
          <p className="text-xs text-muted">Landed in inbox</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{agg ? pct(agg.landed_inbox, agg.sent, 0) : "–"}</p>
        </Card>
        <Card className="p-3.5">
          <p className="text-xs text-muted">Saved from spam</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{agg ? num(agg.saved_from_spam) : "–"}</p>
        </Card>
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">Warmup emails · last 14 days</p>
        {a.isLoading ? (
          <Skeleton className="h-52" />
        ) : chart.length ? (
          <BarsChart
            data={chart}
            stacked
            height={210}
            series={[
              { key: "inbox", label: "Inbox", color: "#10b981" },
              { key: "spam", label: "Spam", color: "#ef4444" },
              { key: "saved", label: "Saved from spam", color: "#f59e0b" },
            ]}
          />
        ) : (
          <EmptyState
            className="py-8"
            title="No warmup activity yet"
            description={
              account.warmup_status !== 1
                ? "Turn on warmup to start building reputation."
                : account.provider_code === ProviderCode.SANDBOX
                  ? "The first warmup emails go out within a few minutes."
                  : `The first warmup emails go out within the hour, between ${hourLabel(WARMUP_HOURS.from)} and ${hourLabel(WARMUP_HOURS.to)} workspace time.`
            }
          />
        )}
      </div>
      {agg && (
        <KeyValue
          items={[
            ...(account.warmup_status === 1 && account.warmup_target_today !== undefined
              ? ([["Today", `${num(account.warmup_sent_today ?? 0)} of ${plural(account.warmup_target_today, "warmup email")}${account.warmup_target_today < (account.warmup?.limit ?? 0) ? `, rising to ${num(account.warmup?.limit)} a day` : ""}`]] as Array<[string, string]>)
              : []),
            ["Sent", num(agg.sent)],
            ["Received", num(agg.received)],
            ["Replies", num(agg.replied)],
            ["Warmup started", account.timestamp_warmup_start ? dateTime(account.timestamp_warmup_start) : "Not started"],
            ["Tag for filtering", account.warmup?.warmup_custom_ftag ? <span className="font-mono">{account.warmup.warmup_custom_ftag}</span> : "–"],
          ]}
        />
      )}
    </div>
  );
}

/** The form itself lives in AccountSheet, so switching tabs keeps unsaved edits. */
function SettingsTab({ account, form, setForm, dirty }: { account: Account; form: SettingsForm; setForm: Dispatch<SetStateAction<SettingsForm>>; dirty: boolean }) {
  const qc = useQueryClient();
  const can = useCan();
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const sent = form;
      const updated = await patch<Account>(`/api/v2/accounts/${encodeURIComponent(account.email)}`, {
        first_name: form.first_name,
        last_name: form.last_name,
        signature: form.signature || null,
        reply_to: form.reply_to || null,
        daily_limit: form.daily_limit,
        sending_gap: form.sending_gap ?? 0,
        enable_slow_ramp: form.enable_slow_ramp,
        tracking_domain_name: form.tracking_domain_name || null,
        warmup: {
          limit: form.warmup_limit ?? 10,
          increment: form.warmup_increment,
          reply_rate: form.reply_rate ?? 30,
          warmup_custom_ftag: form.ftag || null,
          advanced: { weekday_only: form.weekday_only, read_emulation: form.read_emulation, warm_ctd: form.warm_ctd, open_rate: form.open_rate ?? 100, spam_save_rate: form.spam_save_rate ?? 100, important_rate: form.important_rate ?? 100 },
        },
      });
      // Take the settings as the server kept them (blanks become defaults); anything edited while saving stays unsaved.
      setForm((cur) => rebase(cur, sent, toForm({ ...account, ...updated })));
      await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const disabled = !can.perm("accounts");
  const ramp = { limit: form.warmup_limit ?? 10, increment: form.warmup_increment };
  const increase = warmupIncrease(ramp);
  const rampDays = warmupRampDays(ramp);
  return (
    <div className="space-y-6 p-5 pb-24">
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Sender</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">{(id) => <Input id={id} value={form.first_name} disabled={disabled} onChange={(e) => set("first_name", e.target.value)} />}</Field>
          <Field label="Last name">{(id) => <Input id={id} value={form.last_name} disabled={disabled} onChange={(e) => set("last_name", e.target.value)} />}</Field>
        </div>
        <Field label="Reply-to address" optional hint="Replies go here instead of the sending mailbox.">
          {(id) => <Input id={id} type="email" value={form.reply_to} disabled={disabled} onChange={(e) => set("reply_to", e.target.value)} />}
        </Field>
        <Field label="Signature" hint="Emails show it where a sequence step or reply has {{accountSignature}} (Variables → Signature), so each mailbox signs with its own.">
          <RichEditor value={form.signature} onChange={(v) => set("signature", v)} minHeight={90} disabled={disabled} placeholder="Your name, title and links" />
        </Field>
      </section>

      <section className="space-y-4 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Campaign sending</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Daily limit" hint="Campaign emails a day. Resets at midnight, workspace time.">
            {(id) => <NumberInput id={id} value={form.daily_limit} min={0} max={10000} disabled={disabled} onChange={(v) => set("daily_limit", v)} className="w-full" />}
          </Field>
          <Field label="Minimum wait between emails" hint="Minutes">
            {(id) => <NumberInput id={id} value={form.sending_gap} min={0} max={1440} disabled={disabled} onChange={(v) => set("sending_gap", v)} className="w-full" />}
          </Field>
        </div>
        <SwitchRow
          label="Slow ramp-up"
          description={`Send ${SLOW_RAMP.start} campaign emails on the mailbox's first sending day and ${SLOW_RAMP.step} more each day after, until the daily limit.${account.enable_slow_ramp && account.daily_limit_today !== undefined ? ` Today: ${num(account.daily_limit_today)}.` : ""}`}
          checked={form.enable_slow_ramp}
          disabled={disabled}
          onChange={(v) => set("enable_slow_ramp", v)}
        />
      </section>

      <section className="space-y-4 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Warmup</h3>
        <p className="text-[13px] text-muted">
          {account.provider_code === ProviderCode.SANDBOX
            ? "Test mailboxes warm up with other test mailboxes on this server, at any hour. Nothing leaves the server."
            : `Warmup emails go to other real mailboxes connected to this server, between ${hourLabel(WARMUP_HOURS.from)} and ${hourLabel(WARMUP_HOURS.to)} workspace time.`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Warmup emails per day">{(id) => <NumberInput id={id} value={form.warmup_limit} min={0} max={200} disabled={disabled} onChange={(v) => set("warmup_limit", v)} className="w-full" />}</Field>
          <Field
            label="Daily increase"
            hint={
              increase === null
                ? "Sends the full amount from the first day."
                : rampDays
                  ? `Starts at ${WARMUP_START} a day and adds ${increase} a day, reaching ${num(ramp.limit)} after ${plural(rampDays, "day")} of warmup.`
                  : `Sends ${num(ramp.limit)} a day from the first day.`
            }
          >
            {(id) => (
              <Select id={id}
                value={form.warmup_increment}
                disabled={disabled}
                onChange={(v) => set("warmup_increment", v)}
                options={[
                  { value: "disabled", label: "Disabled" },
                  { value: "0", label: "Recommended" },
                  { value: "1", label: "+1 per day" },
                  { value: "2", label: "+2 per day" },
                  { value: "3", label: "+3 per day" },
                  { value: "4", label: "+4 per day" },
                ]}
              />
            )}
          </Field>
          <Field label="Reply rate" hint="Share of warmup emails that get a reply (%)">
            {(id) => <NumberInput id={id} value={form.reply_rate} min={0} max={100} disabled={disabled} onChange={(v) => set("reply_rate", v)} className="w-full" />}
          </Field>
          <Field label="Filter tag" hint="Warmup emails carry this tag so you can filter them out of your inbox.">
            {(id) => <Input id={id} value={form.ftag} disabled={disabled} onChange={(e) => set("ftag", e.target.value)} />}
          </Field>
        </div>
        <SwitchRow label="Weekdays only" description="No warmup emails on Saturday and Sunday, workspace time." checked={form.weekday_only} disabled={disabled} onChange={(v) => set("weekday_only", v)} />
        <SwitchRow
          label="Read emulation"
          description="Not available on this server yet. Warmup emails get opened (see Open rate), but nothing scrolls through them like a person reading."
          checked={false}
          disabled
          onChange={() => {}}
        />
        <SwitchRow label="Warm up the tracking domain" description="Include your custom tracking domain in warmup emails." checked={form.warm_ctd} disabled={disabled} onChange={(v) => set("warm_ctd", v)} />
        <p className="text-xs text-muted">What the other mailboxes do with this one's warmup emails:</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Open rate %">{(id) => <NumberInput id={id} value={form.open_rate} min={0} max={100} disabled={disabled} onChange={(v) => set("open_rate", v)} className="w-full" />}</Field>
          <Field label="Mark important %">{(id) => <NumberInput id={id} value={form.important_rate} min={0} max={100} disabled={disabled} onChange={(v) => set("important_rate", v)} className="w-full" />}</Field>
          <Field label="Rescue from spam %">{(id) => <NumberInput id={id} value={form.spam_save_rate} min={0} max={100} disabled={disabled} onChange={(v) => set("spam_save_rate", v)} className="w-full" />}</Field>
        </div>
      </section>

      <TrackingDomain account={account} value={form.tracking_domain_name} onChange={(v) => set("tracking_domain_name", v)} disabled={disabled} />

      {account.connection === "password" && <Credentials account={account} />}

      {can.perm("accounts") && (
        <div className="fixed bottom-0 right-0 flex w-full max-w-2xl items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
          {dirty && <span className="mr-auto text-xs text-warn">Unsaved changes</span>}
          <Button disabled={!dirty} onClick={() => setForm(toForm(account))}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}

/** The Settings tab's values for an account (the defaults while it loads). */
function toForm(a: Account | undefined) {
  return {
    first_name: a?.first_name ?? "",
    last_name: a?.last_name ?? "",
    signature: a?.signature ?? "",
    reply_to: a?.reply_to ?? "",
    daily_limit: a?.daily_limit ?? null,
    sending_gap: (a?.sending_gap ?? null) as number | null,
    enable_slow_ramp: !!a?.enable_slow_ramp,
    tracking_domain_name: a?.tracking_domain_name ?? "",
    warmup_limit: (a?.warmup?.limit ?? 10) as number | null,
    warmup_increment: a?.warmup?.increment ?? "disabled",
    reply_rate: (a?.warmup?.reply_rate ?? 30) as number | null,
    ftag: a?.warmup?.warmup_custom_ftag ?? "",
    weekday_only: !!a?.warmup?.advanced?.weekday_only,
    read_emulation: !!a?.warmup?.advanced?.read_emulation,
    warm_ctd: !!a?.warmup?.advanced?.warm_ctd,
    open_rate: (a?.warmup?.advanced?.open_rate ?? 100) as number | null,
    important_rate: (a?.warmup?.advanced?.important_rate ?? 100) as number | null,
    spam_save_rate: (a?.warmup?.advanced?.spam_save_rate ?? 100) as number | null,
  };
}

type SettingsForm = ReturnType<typeof toForm>;

function TrackingDomain({ account, value, onChange, disabled }: { account: Account; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const providers = useQuery({
    queryKey: ["account-providers"],
    queryFn: () => get<{ tracking_host: string; tracking_reachable: boolean }>("/api/app/accounts/providers"),
    staleTime: Infinity,
  });
  const qc = useQueryClient();
  const [check, setCheck] = useState<{ cname: boolean; ssl: boolean; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const host = providers.data?.tracking_host;
  const verified = account.tracking_domain_status === "verified";
  if (providers.data && !providers.data.tracking_reachable && account.provider_code !== ProviderCode.SANDBOX) {
    return (
      <section className="space-y-2 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">Custom tracking domain</h3>
        <p className="text-[13px] text-muted">
          This server runs at {host}, which people who get your emails can't reach, so a tracking domain would have nothing to point at. Emails from this
          mailbox keep their links as written, opens and clicks aren't counted, and the unsubscribe link asks to unsubscribe by email (that reply
          unsubscribes them). To track opens and clicks, run the app on a server with a public address.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Custom tracking domain</h3>
        {account.tracking_domain_name && <Badge tone={verified ? "ok" : "warn"}>{verified ? "Verified" : "Pending"}</Badge>}
      </div>
      <p className="text-[13px] text-muted">Open and click tracking links use your own domain instead of the shared one, which keeps your reputation separate.</p>
      {account.tracking_domain_name && !verified && (
        <p className="text-[13px] text-muted">
          Links switch to {account.tracking_domain_name} once https://{account.tracking_domain_name} reaches this server, which needs the DNS record below
          and a certificate for that name on your server. Until then they use the shared address, so every link keeps working. It's checked every hour.
        </p>
      )}
      <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value.trim().toLowerCase())} placeholder="track.yourdomain.com" />
      {host && (
        <div className="rounded-lg bg-panel-2 p-3 text-[13px]">
          <p className="mb-2 text-muted">Add this DNS record at your domain provider:</p>
          <div className="grid grid-cols-[4rem_1fr_auto] items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span className="text-faint">Type</span>
            <span>CNAME</span>
            <span />
            <span className="text-faint">Name</span>
            <span>{value ? value.split(".")[0] : "track"}</span>
            <span />
            <span className="text-faint">Value</span>
            <span className="truncate">{host}</span>
            <CopyButton value={host} />
          </div>
        </div>
      )}
      {account.tracking_domain_name && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            loading={busy}
            icon={<RefreshCw size={13} />}
            onClick={async () => {
              setBusy(true);
              try {
                setCheck(await post<{ cname: boolean; ssl: boolean; status: string }>(`/api/app/accounts/${encodeURIComponent(account.email)}/ctd/check`));
                // The badge shows what the check found.
                await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Check now
          </Button>
          {check && (
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <span className={check.cname ? "text-ok" : "text-warn"}>{check.cname ? "CNAME found" : "CNAME not found yet"}</span>
              <span className={check.ssl ? "text-ok" : "text-bad"}>{check.ssl ? "HTTPS reaches this server" : "HTTPS doesn't reach this server yet"}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Credentials({ account }: { account: Account }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const initial = { imap_host: account.imap_host ?? "", imap_port: account.imap_port ?? 993, smtp_host: account.smtp_host ?? "", smtp_port: account.smtp_port ?? 587 };
  const [form, setForm] = useState({ ...initial, imap_password: "", smtp_password: "" });
  const imapMoved = form.imap_host.trim() !== initial.imap_host || form.imap_port !== initial.imap_port;
  const smtpMoved = form.smtp_host.trim() !== initial.smtp_host || form.smtp_port !== initial.smtp_port;
  // A saved password is never sent to a different server, so moving a side needs its password again.
  const missing = (imapMoved && !form.imap_password) || (smtpMoved && !form.smtp_password && !form.imap_password);
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h3 className="text-sm font-semibold">Connection</h3>
      <KeyValue
        items={[
          ["IMAP server", account.imap_host ?? "–"],
          ["SMTP server", account.smtp_host ?? "–"],
        ]}
      />
      <Button size="sm" onClick={() => setOpen(true)}>
        Update password or servers
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Update connection"
        description="Leave a password empty to keep the current one. Changing a server or port needs that password again."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={missing}
              onClick={async () => {
                setBusy(true);
                try {
                  await patch(`/api/v2/accounts/${encodeURIComponent(account.email)}`, {
                    ...(imapMoved ? { imap_host: form.imap_host.trim(), imap_port: form.imap_port } : {}),
                    ...(smtpMoved ? { smtp_host: form.smtp_host.trim(), smtp_port: form.smtp_port } : {}),
                    ...(form.imap_password ? { imap_password: form.imap_password } : {}),
                    ...(form.smtp_password ? { smtp_password: form.smtp_password } : {}),
                  });
                  const r = await post<ConnectionTest>(`/api/app/accounts/${encodeURIComponent(account.email)}/reconnect`);
                  await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
                  if (r.ok) {
                    toast.success("Connection updated and working");
                    setOpen(false);
                  } else toastFailedTest(r, "Saved, but the connection test failed");
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save and test
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="IMAP host">{(id) => <Input id={id} value={form.imap_host} onChange={(e) => setForm({ ...form, imap_host: e.target.value })} />}</Field>
          <Field label="Port">{(id) => <NumberInput id={id} value={form.imap_port} onChange={(v) => setForm({ ...form, imap_port: v ?? 993 })} className="w-full" />}</Field>
          <Field label="SMTP host">{(id) => <Input id={id} value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />}</Field>
          <Field label="Port">{(id) => <NumberInput id={id} value={form.smtp_port} onChange={(v) => setForm({ ...form, smtp_port: v ?? 587 })} className="w-full" />}</Field>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="IMAP password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={form.imap_password} onChange={(e) => setForm({ ...form, imap_password: e.target.value })} />}</Field>
          <Field label="SMTP password" hint="Defaults to the IMAP password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.smtp_password} onChange={(e) => setForm({ ...form, smtp_password: e.target.value })} />}
          </Field>
        </div>
      </Dialog>
    </section>
  );
}

function CampaignsTab({ account }: { account: Account }) {
  const q = useQuery({
    queryKey: [...ACCOUNTS_KEY, "campaigns", account.email],
    queryFn: () => get<{ items: Array<{ id: string; campaign_name: string; status: number }> }>(`/api/app/accounts/${encodeURIComponent(account.email)}/campaigns`),
  });
  if (q.isLoading) return <Skeleton className="m-5 h-24" />;
  if (!q.data?.items.length) return <EmptyState title="Not used by any campaign" description="Add this account to a campaign's sending accounts in the campaign options." />;
  return (
    <ul className="divide-y divide-line">
      {q.data.items.map((c) => (
        <li key={c.id}>
          <Link to={`/app/campaign/${c.id}/analytics`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-panel-2">
            <span className="truncate text-sm font-medium">{c.campaign_name}</span>
            <CampaignStatusBadge status={c.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function LogTab({ account }: { account: Account }) {
  const q = useQuery({
    queryKey: [...ACCOUNTS_KEY, "warmup-log", account.email],
    queryFn: () =>
      get<{ items: Array<{ id: string; direction: "sent" | "received"; subject: string; is_reply: boolean; sent_at: string; folder: string | null; saved_from_spam: boolean; opened: boolean; replied: boolean }> }>(
        `/api/app/accounts/${encodeURIComponent(account.email)}/warmup-log`,
      ),
  });
  if (q.isLoading) return <Skeleton className="m-5 h-24" />;
  if (!q.data?.items.length) return <EmptyState title="No warmup emails yet" />;
  return (
    <ul className="divide-y divide-line">
      {q.data.items.map((m) => (
        <li key={m.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
          <Badge tone={m.direction === "sent" ? "brand" : "info"}>{m.direction === "sent" ? "Sent" : "Received"}</Badge>
          <span className="min-w-0 flex-1 truncate">
            {m.is_reply ? "Re: " : ""}
            {m.subject}
          </span>
          {m.direction === "received" && (
            <span className={m.folder === "spam" && !m.saved_from_spam ? "text-bad" : "text-ok"}>{m.saved_from_spam ? "Rescued from spam" : m.folder === "spam" ? "Spam" : "Inbox"}</span>
          )}
          <span className="shrink-0 text-xs text-faint">{ago(m.sent_at)}</span>
        </li>
      ))}
    </ul>
  );
}

const SIDE_LABELS = { smtp: "Sending (SMTP)", imap: "Inbox (IMAP)" } as const;

/** Why the mailbox can't send: each failing half on its own line, so it's clear which password or server to fix. */
function FailureText({ account }: { account: Account }) {
  const m = account.status_message;
  const sides = (["smtp", "imap"] as const).filter((side) => m?.sides?.[side]);
  if (!sides.length) return <>{m?.e_message ?? m?.response ?? "The last send or sync failed."}</>;
  return (
    <>
      {sides.map((side) => (
        <p key={side}>
          <span className="font-medium text-text">{SIDE_LABELS[side]}:</span> {m!.sides![side]!.message}
        </p>
      ))}
    </>
  );
}

const UNSAVED_SETTINGS = "Your changes to this account's settings haven't been saved yet.";

export function AccountSheet({ email, onClose }: { email: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("health");
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...ACCOUNTS_KEY, "one", email],
    queryFn: () => get<Account>(`/api/v2/accounts/${encodeURIComponent(email!)}`),
    enabled: !!email,
  });
  useEffect(() => setTab("health"), [email]);
  const a = q.data;
  // The Settings form lives here so it outlasts switching tabs. It follows the saved settings only, so the reload after
  // a pause, a warmup change, tags or a connection test leaves unsaved edits alone.
  const [form, setForm, dirty] = useDraft(toForm(a), a?.email);
  // The panel is open while the page's ?account= names this mailbox: Back, which drops that, asks first too.
  const { pathname } = useLocation();
  useUnsavedChanges(dirty, UNSAVED_SETTINGS, (next) => next.pathname === pathname && new URLSearchParams(next.search).get("account") === email);
  // However the panel closes (X, Esc, a click outside, Back), unsaved settings are asked about once, by the guard above.
  const close = () => onClose();
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const tagIds = useMemo(() => a?.tags?.map((t) => t.id) ?? [], [a]);
  const enc = email ? encodeURIComponent(email) : "";

  return (
    <Sheet
      open={!!email}
      onOpenChange={(v) => !v && close()}
      width="max-w-2xl"
      title={email ?? ""}
      description={a ? `${[a.first_name, a.last_name].filter(Boolean).join(" ") || "No sender name"} · ${PROVIDER_LABELS[a.provider_code] ?? "Mailbox"}` : undefined}
      actions={
        a &&
        can.perm("accounts") && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="rounded-md p-1.5 text-faint hover:bg-panel-2 hover:text-text" aria-label="Account actions">
                <MoreHorizontal size={16} />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Send size={14} />} onSelect={() => setTestOpen(true)}>
                Send a test email
              </MenuItem>
              {a.provider_code !== ProviderCode.SANDBOX && (
                <MenuItem icon={<Inbox size={14} />} onSelect={() => act("sync", () => post(`/api/app/accounts/${enc}/sync`), "Inbox synced")}>
                  Check for new replies now
                </MenuItem>
              )}
              {can.write && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    icon={<Trash2 size={14} />}
                    onSelect={async () => {
                      if (await confirm({ title: `Delete ${a.email}?`, description: "The account is removed from every campaign.", confirmLabel: "Delete", danger: true })) {
                        await act("delete", () => del(`/api/v2/accounts/${enc}`), "Account deleted");
                        onClose();
                      }
                    }}
                  >
                    Delete account
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )
      }
    >
      {!a ? (
        q.isError ? (
          isNotFound(q.error) ? (
            <EmptyState title="Account not found" description="It was deleted, or it belongs to another workspace." action={<Button onClick={onClose}>Close</Button>} />
          ) : (
            <ErrorState title="Couldn't load this account" error={q.error} onRetry={() => q.refetch()} />
          )
        ) : (
          <div className="space-y-3 p-5">
            <Skeleton className="h-16" />
            <Skeleton className="h-40" />
          </div>
        )
      ) : (
        <>
          <div className="space-y-3 border-b border-line px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <AccountStatusBadge status={a.status} />
              <WarmupBadge status={a.warmup_status} />
              <HealthBadge health={a.health} />
              <span className="text-xs text-muted">
                {num(a.sent_today ?? 0)}/{a.daily_limit_today ?? a.daily_limit ?? "∞"} sent today · last used {ago(a.timestamp_last_used)}
              </span>
              <div className="ml-auto">
                <TagPicker
                  value={tagIds}
                  onChange={async (ids) => {
                    const added = ids.filter((x) => !tagIds.includes(x));
                    const removed = tagIds.filter((x) => !ids.includes(x));
                    await act("tags", async () => {
                      if (added.length) await post("/api/app/accounts/tags", { emails: [a.email], tag_ids: added, assign: true });
                      if (removed.length) await post("/api/app/accounts/tags", { emails: [a.email], tag_ids: removed, assign: false });
                    });
                  }}
                />
              </div>
            </div>
            {a.status < 0 && (
              <Callout
                tone="bad"
                title="This account can't send"
                action={
                  can.perm("accounts") && (
                    <div className="flex gap-1.5">
                      <Button size="xs" icon={<RefreshCw size={12} />} loading={busy === "reconnect"} onClick={() => act("reconnect", async () => {
                        const r = await post<ConnectionTest>(`/api/app/accounts/${enc}/reconnect`);
                        if (r.ok) toast.success("Connection works again");
                        else toastFailedTest(r, "Still failing");
                      })}>
                        Retry
                      </Button>
                      <Button size="xs" icon={<Wrench size={12} />} loading={busy === "fixed"} onClick={() => act("fixed", () => post(`/api/v2/accounts/${enc}/mark-fixed`), "Marked as fixed")}>
                        Mark fixed
                      </Button>
                    </div>
                  )
                }
              >
                <FailureText account={a} />
              </Callout>
            )}
            {a.campaign_pause_until && new Date(a.campaign_pause_until) > new Date() && (
              <Callout tone="warn" title={`Resting until ${dateTime(a.campaign_pause_until)}`}>
                Campaigns skip this mailbox until then. Warmup keeps going.
              </Callout>
            )}
            {can.perm("accounts") && (
              <div className="flex flex-wrap gap-2">
                {a.status === AccountStatus.PAUSED ? (
                  <Button size="sm" icon={<Play size={14} />} loading={busy === "resume"} onClick={() => act("resume", () => post(`/api/v2/accounts/${enc}/resume`), "Sending resumed")}>
                    Resume sending
                  </Button>
                ) : (
                  <Button size="sm" icon={<Pause size={14} />} loading={busy === "pause"} onClick={() => act("pause", () => post(`/api/v2/accounts/${enc}/pause`), "Sending paused")}>
                    Pause sending
                  </Button>
                )}
                {a.warmup_status === 1 ? (
                  <Button size="sm" loading={busy === "w"} onClick={() => act("w", () => post("/api/v2/accounts/warmup/disable", { emails: [a.email] }), "Warmup paused")}>
                    Pause warmup
                  </Button>
                ) : (
                  <Button size="sm" variant="soft" loading={busy === "w"} disabled={a.status !== 1} onClick={() => act("w", () => post("/api/v2/accounts/warmup/enable", { emails: [a.email] }), "Warmup enabled")}>
                    Enable warmup
                  </Button>
                )}
                <Button size="sm" icon={<RefreshCw size={14} />} loading={busy === "test"} onClick={() => act("test", async () => {
                  const r = await post<ConnectionTest>(`/api/app/accounts/${enc}/reconnect`);
                  if (r.ok) toast.success("IMAP and SMTP both connect");
                  else toastFailedTest(r);
                })}>
                  Test connection
                </Button>
              </div>
            )}
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            className="px-5"
            tabs={[
              { value: "health", label: "Health" },
              { value: "warmup", label: "Warmup" },
              { value: "settings", label: "Settings", badge: dirty && <span role="img" className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-label="Unsaved changes" title="Unsaved changes" /> },
              { value: "campaigns", label: "Campaigns" },
              { value: "log", label: "Warmup log" },
            ]}
          >
            <TabPanel value="health">
              <HealthTab account={a} />
            </TabPanel>
            <TabPanel value="warmup">
              <WarmupTab account={a} />
            </TabPanel>
            <TabPanel value="settings">
              <SettingsTab account={a} form={form} setForm={setForm} dirty={dirty} />
            </TabPanel>
            <TabPanel value="campaigns">
              <CampaignsTab account={a} />
            </TabPanel>
            <TabPanel value="log">
              <LogTab account={a} />
            </TabPanel>
          </Tabs>
        </>
      )}
      <Dialog
        open={testOpen}
        onOpenChange={setTestOpen}
        size="sm"
        title="Send a test email"
        description={`Sends a short message from ${email} to check delivery.`}
        footer={
          <>
            <Button onClick={() => setTestOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === "send"}
              disabled={!testTo.includes("@")}
              onClick={() =>
                act("send", async () => {
                  const r = await post<{ ok: boolean; error?: string }>(`/api/app/accounts/${enc}/test-email`, { to: testTo });
                  if (r.ok) {
                    toast.success(`Test email sent to ${testTo}`);
                    setTestOpen(false);
                  } else toast.error(r.error ?? "Sending failed");
                })
              }
            >
              Send
            </Button>
          </>
        }
      >
        <Input autoFocus type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@yourcompany.com" />
      </Dialog>
    </Sheet>
  );
}
