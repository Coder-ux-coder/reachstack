import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CalendarClock, CircleCheck, CircleX, Copy, Gauge, Inbox, Pause, Pencil, Play, Plus, RefreshCw, ShieldAlert, Trash2, Webhook } from "lucide-react";
import { CAMPAIGN_TIMEZONES, INBOX_PLACEMENT, WEEKDAYS } from "@reachstack/shared";
import { del, errorMessage, get, patch, post, type Page } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import { RichEditor } from "@/components/RichEditor";
import { EmailFrame } from "@/components/EmailFrame";
import { AccountsPicker } from "@/components/sequence/AccountsPicker";
import { VariablesMenu } from "@/components/sequence/tools";
import { TagPicker, useTags } from "@/components/TagPicker";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  CopyButton,
  EmptyState,
  Field,
  Input,
  MenuItem,
  NativeSelect,
  NumberInput,
  Progress,
  RowMenu,
  Section,
  Segmented,
  Sheet,
  SkeletonRows,
  Switch,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { ScrollX } from "@/components/ui/scroll-x";

// ---------------------------------------------------------------------------------------------------------------
// Types

interface Label {
  region: string;
  sub_region: string;
  type: string;
  esp: string;
}

interface Automation {
  when: {
    condition: "placement_goes_below" | "placement_goes_above" | "added_to_blacklists" | "removed_from_blacklists";
    condition_value?: number | null;
  };
  then: {
    webhook_url?: string;
    pause_sending_campaigns_for?: number;
    pause?: boolean;
    enable_slow_ramp?: boolean;
    disable_slow_ramp?: boolean;
    add_tags?: string[];
  };
}

interface PlacementTest {
  id: string;
  name: string;
  description: string | null;
  type: 1 | 2;
  sending_method: 1 | 2;
  campaign_id: string | null;
  email_subject: string;
  email_body: string;
  emails: string[];
  test_code: string | null;
  tags: string[] | null;
  text_only: boolean | null;
  recipients: string[];
  recipients_labels: Label[] | null;
  schedule: {
    days: Record<string, boolean>;
    timing: { from: string };
    timezone: string;
  } | null;
  automations: Automation[] | null;
  status: 1 | 2 | 3;
  not_sending_status: string;
  timestamp_created: string;
  timestamp_next_run: string | null;
  timestamp_last_run: string | null;
  run_count: number;
}

interface Summary {
  /** Seeds that were read; the percentages are of these. */
  count: number;
  /** Seeds that couldn't be read, left out of the numbers. */
  unchecked_count?: number;
  spam_count: number;
  spam_percent: number;
  inbox_count: number;
  inbox_percent: number;
  category_count: number;
  category_percent: number;
}

interface Seed {
  id: string;
  email: string;
  simulated: boolean;
  region: string;
  sub_region: string;
  type: string;
  esp: string;
  esp_code: number;
  geo: number;
  active: boolean;
}

interface Result {
  id: string;
  run_id: string;
  is_spam: boolean | null;
  has_category: boolean | null;
  sender_email: string | null;
  recipient_email: string;
  recipient_esp: number | null;
  recipient_geo: number | null;
  recipient_type: number | null;
  spf_pass: boolean | null;
  dkim_pass: boolean | null;
  dmarc_pass: boolean | null;
  folder: string | null;
}

interface Report {
  id: string;
  domain: string;
  domain_ip: string | null;
  domain_blacklist_count: number | null;
  domain_ip_blacklist_count: number | null;
  spam_assassin_score: number | null;
  spam_assassin_report: {
    is_spam?: boolean;
    spam_score?: number;
    engine?: string;
    threshold?: number;
    report?: Array<{ name: string; score: string; description: string }>;
  } | null;
  blacklist_report: {
    blacklisted_count?: number;
    details?: Array<{
      blacklist: string;
      is_listed: boolean;
      test_type: "domain" | "ip";
    }>;
  } | null;
  /** DNS check of the sending domain, or a note when the domain is a sandbox one. */
  auth_report: {
    spf?: boolean;
    dkim?: boolean;
    dmarc?: boolean;
    indeterminate?: string[];
    simulated?: boolean;
    note?: string;
  } | null;
}

interface Overview {
  test: PlacementTest;
  run_id: string | null;
  runs: Array<{ run_id: string; timestamp: string | null } & Summary>;
  pending: number;
  summary: Summary;
  by_esp: Array<{ key: string } & Summary>;
  by_geo: Array<{ key: string } & Summary>;
  by_type: Array<{ key: string } & Summary>;
  by_sender: Array<{ key: string } & Summary>;
  results: Result[];
  reports: Report[];
}

const TESTS_KEY = ["placement-tests"];
const ESP_NAMES: Record<number, string> = {
  1: "Google",
  2: "Microsoft",
  8: "AirMail",
  12: "Web.de",
  13: "Libero.it",
};
const GEO_NAMES: Record<number, string> = {
  1: "United States",
  2: "Italy",
  3: "Germany",
  4: "France",
};
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${Math.round(n)}%`);

interface RunStart {
  sending: number;
  skipped: number;
  message?: string;
}

/** A run sends in the background: say how many emails are on their way. */
function toastRunStart(r: RunStart) {
  if (r.message) toast.info(r.message);
  else toast.success(`Sending ${plural(r.sending, "test email")}${r.skipped ? ` (${r.skipped} skipped)` : ""}. Results come in over the next few minutes.`);
}

function StatusBadge({ t }: { t: Pick<PlacementTest, "status" | "type" | "not_sending_status"> }) {
  // Its last run couldn't send (no active mailbox, or none that reaches the seeds).
  if (t.not_sending_status && t.status !== INBOX_PLACEMENT.STATUS_PAUSED) return <Badge tone="warn">{t.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? "Not sending" : "Not sent"}</Badge>;
  if (t.status === INBOX_PLACEMENT.STATUS_COMPLETED) return <Badge tone="neutral">Completed</Badge>;
  if (t.status === INBOX_PLACEMENT.STATUS_PAUSED) return <Badge tone="warn">Paused</Badge>;
  return (
    <Badge tone="ok" dot>
      {t.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? "Scheduled" : "Running"}
    </Badge>
  );
}

function scheduleText(s: PlacementTest["schedule"]) {
  if (!s) return "";
  const days = Object.entries(s.days)
    .filter(([, on]) => on)
    .map(([d]) => WEEKDAYS[Number(d)]!.slice(0, 3));
  return `${days.length === 7 ? "Every day" : days.join(", ")} at ${s.timing.from} (${s.timezone})`;
}

function useSeeds() {
  return useQuery({
    queryKey: ["placement-seeds"],
    queryFn: () => get<{ items: Seed[]; can_manage: boolean }>("/api/app/placement/seeds"),
  });
}

/** Bar split into inbox / tab / spam. */
function PlacementBar({ s, className }: { s: Summary; className?: string }) {
  const primary = Math.max(0, s.inbox_percent - s.category_percent);
  return (
    <div className={cn("flex h-2 w-full overflow-hidden rounded-full bg-panel-2", className)} role="img" aria-label={`${pct(s.inbox_percent)} inbox, ${pct(s.spam_percent)} spam`}>
      <div className="bg-ok" style={{ width: `${primary}%` }} />
      <div className="bg-info" style={{ width: `${s.category_percent}%` }} />
      <div className="bg-bad" style={{ width: `${s.spam_percent}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Seeds

function SeedsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const seeds = useSeeds();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    account_email: "",
    region: "North America",
    sub_region: "US",
    type: "Professional" as "Professional" | "Personal",
    esp: 1,
    geo: 1,
  });
  const items = seeds.data?.items ?? [];
  const manage = !!seeds.data?.can_manage;
  const toggle = async (s: Seed, active: boolean) => {
    try {
      await patch(`/api/app/placement/seeds/${s.id}`, { active });
      qc.invalidateQueries({ queryKey: ["placement-seeds"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const add = async () => {
    try {
      await post("/api/app/placement/seeds", form);
      toast.success("Seed added");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["placement-seeds"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Seed inboxes"
      description="Every test emails the active seeds."
    >
      <div className="space-y-4 p-5">
        {manage ? (
          <Callout tone="info">Seeds are shared by every workspace on this server. After a test, each seed is read to see which folder the email landed in. To add a real seed, connect the mailbox as an email account first, then pick it here.</Callout>
        ) : (
          <p className="text-[13px] text-muted">After a test, each seed is read to see which folder the email landed in. The administrator of this server manages the seed list.</p>
        )}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{s.email}</p>
                <p className="text-xs text-muted">
                  {s.esp} · {s.sub_region} · {s.type}
                  {s.simulated && " · simulated"}
                </p>
              </div>
              {manage ? (
                <Switch checked={s.active} onChange={(v) => toggle(s, v)} aria-label={`Use ${s.email}`} />
              ) : (
                <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "Active" : "Off"}</Badge>
              )}
            </li>
          ))}
        </ul>
        {manage &&
          (adding ? (
            <Card className="space-y-3">
              <Field label="Mailbox (connected email account)">
                {(id) => <Input id={id} value={form.account_email} onChange={(e) => setForm({ ...form, account_email: e.target.value })} placeholder="seed@yourdomain.com" />}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider">
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={String(form.esp)}
                      onChange={(v) => setForm({ ...form, esp: Number(v) })}
                      options={Object.entries(ESP_NAMES).map(([v, l]) => ({
                        value: v,
                        label: l,
                      }))}
                    />
                  )}
                </Field>
                <Field label="Country">
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={String(form.geo)}
                      onChange={(v) => {
                        const geo = Number(v);
                        setForm({
                          ...form,
                          geo,
                          region: geo === 1 ? "North America" : "Europe",
                          sub_region: geo === 1 ? "US" : GEO_NAMES[geo]!,
                        });
                      }}
                      options={Object.entries(GEO_NAMES).map(([v, l]) => ({
                        value: v,
                        label: l,
                      }))}
                    />
                  )}
                </Field>
                <Field label="Type">
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={form.type}
                      onChange={(v) =>
                        setForm({
                          ...form,
                          type: v as "Professional" | "Personal",
                        })
                      }
                      options={[
                        { value: "Professional", label: "Business mailbox" },
                        { value: "Personal", label: "Personal mailbox" },
                      ]}
                    />
                  )}
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" disabled={!form.account_email.includes("@")} onClick={add}>
                  Add seed
                </Button>
              </div>
            </Card>
          ) : (
            <Button icon={<Plus size={15} />} onClick={() => setAdding(true)}>
              Add a seed mailbox
            </Button>
          ))}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// List

/** /app/inbox-placement */
export function PlacementTests() {
  usePageTitle("Inbox placement");
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [seedsOpen, setSeedsOpen] = useState(false);
  const tests = useQuery({
    queryKey: TESTS_KEY,
    queryFn: () => get<Page<PlacementTest>>("/api/v2/inbox-placement-tests", { limit: 100 }),
  });
  const items = tests.data?.items ?? [];
  const ids = items.map((t) => t.id);
  const stats = useQuery({
    queryKey: ["placement-stats", ids],
    queryFn: () => post<Array<{ test_id: string } & Summary>>("/api/v2/inbox-placement-analytics/stats-by-test-id", { test_ids: ids, latest_run_only: true }),
    enabled: ids.length > 0,
  });
  const seeds = useSeeds();
  const activeSeeds = (seeds.data?.items ?? []).filter((s) => s.active);
  const onlySimulated = activeSeeds.length > 0 && activeSeeds.every((s) => s.simulated);
  const statFor = (id: string) => stats.data?.find((s) => s.test_id === id);

  const [starting, setStarting] = useState<string | null>(null);
  const run = async (t: PlacementTest) => {
    if (starting) return;
    setStarting(t.id);
    try {
      toastRunStart(await post<RunStart>(`/api/app/inbox-placement-tests/${t.id}/run`));
      qc.invalidateQueries({ queryKey: TESTS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(null);
    }
  };
  const setStatus = async (t: PlacementTest, status: 1 | 2) => {
    try {
      await patch(`/api/v2/inbox-placement-tests/${t.id}`, { status });
      qc.invalidateQueries({ queryKey: TESTS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (t: PlacementTest) => {
    if (
      !(await confirm({
        title: `Delete "${t.name}"?`,
        description: "Its results and reports are deleted too.",
        confirmLabel: "Delete test",
        danger: true,
      }))
    )
      return;
    try {
      await del(`/api/v2/inbox-placement-tests/${t.id}`);
      qc.invalidateQueries({ queryKey: TESTS_KEY });
      toast.success("Test deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inbox placement</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            Send a test email to seed inboxes at major providers and see whether it lands in the inbox, a tab or spam, with blocklist and content checks for your domains.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setSeedsOpen(true)}>Seed inboxes</Button>
          {can.write && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => nav("/app/inbox-placement/create")}>
              New test
            </Button>
          )}
        </div>
      </div>
      {onlySimulated && (
        <Callout tone="info" className="mt-4" title="Results here are simulated">
          This server only has its built-in sandbox seeds, so tests run against simulated providers. Connect real seed mailboxes from Seed inboxes to measure real placement.
        </Callout>
      )}
      <Card padded={false} className="mt-5 overflow-hidden">
        {tests.isLoading ? (
          <SkeletonRows rows={4} />
        ) : !items.length ? (
          <EmptyState
            icon={<Gauge size={22} />}
            title="No placement tests yet"
            description="Run a one-off check before a launch, or schedule a weekly test that pauses campaigns automatically when placement drops."
            action={
              can.write && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => nav("/app/inbox-placement/create")}>
                  New test
                </Button>
              )
            }
          />
        ) : (
          <ScrollX>
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="border-b border-line bg-panel-2/50 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Test</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="w-56 px-4 py-2.5 font-medium">Latest placement</th>
                  <th className="px-4 py-2.5 font-medium">Last run</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((t) => {
                  const s = statFor(t.id);
                  return (
                    <tr key={t.id} className="cursor-pointer hover:bg-panel-2/40" onClick={() => nav(`/app/inbox-placement/${t.id}/results`)}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{t.name}</p>
                        <p className="text-xs text-muted">
                          {t.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? scheduleText(t.schedule) : "One-time"}
                          {t.sending_method === INBOX_PLACEMENT.SENDING_EXTERNAL && " · sent from another tool"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge t={t} />
                      </td>
                      <td className="px-4 py-3">
                        {s && s.count ? (
                          <div className="space-y-1.5">
                            <PlacementBar s={s} />
                            <p className="text-xs text-muted">
                              <span className="font-medium text-ok">{pct(s.inbox_percent)} inbox</span> · {pct(s.category_percent)} tabs ·{" "}
                              <span className="text-bad">{pct(s.spam_percent)} spam</span>
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-faint">{s?.unchecked_count ? "Seeds couldn't be read" : "No results yet"}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">
                        {t.timestamp_last_run ? dateTime(t.timestamp_last_run) : "—"}
                        {t.timestamp_next_run && t.status === INBOX_PLACEMENT.STATUS_ACTIVE && <p className="text-xs">Next {dateTime(t.timestamp_next_run)}</p>}
                      </td>
                      <td className="px-2" onClick={(e) => e.stopPropagation()}>
                        {can.write && (
                          <RowMenu>
                            {t.sending_method === INBOX_PLACEMENT.SENDING_FROM_APP && (
                              <MenuItem icon={<Play size={14} />} disabled={starting === t.id} onSelect={() => run(t)}>
                                Run now
                              </MenuItem>
                            )}
                            {t.type === INBOX_PLACEMENT.TYPE_AUTOMATED && t.status === INBOX_PLACEMENT.STATUS_ACTIVE && (
                              <MenuItem icon={<Pause size={14} />} onSelect={() => setStatus(t, 2)}>
                                Pause schedule
                              </MenuItem>
                            )}
                            {t.type === INBOX_PLACEMENT.TYPE_AUTOMATED && t.status === INBOX_PLACEMENT.STATUS_PAUSED && (
                              <MenuItem icon={<CalendarClock size={14} />} onSelect={() => setStatus(t, 1)}>
                                Resume schedule
                              </MenuItem>
                            )}
                            <MenuItem icon={<Pencil size={14} />} onSelect={() => nav(`/app/inbox-placement/create?id=${t.id}`)}>
                              Edit
                            </MenuItem>
                            <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(t)}>
                              Delete
                            </MenuItem>
                          </RowMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollX>
        )}
      </Card>
      <SeedsSheet open={seedsOpen} onOpenChange={setSeedsOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Create / edit

const CONDITIONS: Array<{
  value: Automation["when"]["condition"];
  label: string;
  needsValue: boolean;
}> = [
  {
    value: "placement_goes_below",
    label: "Inbox placement drops below",
    needsValue: true,
  },
  {
    value: "placement_goes_above",
    label: "Inbox placement rises above",
    needsValue: true,
  },
  {
    value: "added_to_blacklists",
    label: "A sending domain gets blocklisted",
    needsValue: false,
  },
  {
    value: "removed_from_blacklists",
    label: "Sending domains are off blocklists again",
    needsValue: false,
  },
];

function AutomationEditor({ value, onChange }: { value: Automation[]; onChange: (v: Automation[]) => void }) {
  const tags = useTags();
  const set = (i: number, a: Automation) => onChange(value.map((x, j) => (j === i ? a : x)));
  return (
    <div className="space-y-3">
      {value.map((a, i) => {
        const cond = CONDITIONS.find((c) => c.value === a.when.condition)!;
        return (
          <Card key={i} className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="When" className="min-w-[14rem] flex-1">
                {(id) => (
                  <NativeSelect
                    id={id}
                    value={a.when.condition}
                    onChange={(v) =>
                      set(i, {
                        ...a,
                        when: {
                          condition: v as Automation["when"]["condition"],
                          condition_value: a.when.condition_value ?? 80,
                        },
                      })
                    }
                    options={CONDITIONS.map((c) => ({
                      value: c.value,
                      label: c.label,
                    }))}
                  />
                )}
              </Field>
              {cond.needsValue && (
                <Field label="Inbox %" className="w-28">
                  {(id) => (
                    <NumberInput
                      id={id}
                      value={a.when.condition_value ?? 80}
                      onChange={(v) =>
                        set(i, {
                          ...a,
                          when: { ...a.when, condition_value: v ?? 0 },
                        })
                      }
                      min={0}
                      max={100}
                      suffix="%"
                    />
                  )}
                </Field>
              )}
              <Button size="icon-sm" variant="ghost" aria-label="Remove rule" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash2 size={15} />
              </Button>
            </div>
            <div className="space-y-2.5 border-t border-line pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-faint">Then, for the test's sending accounts</p>
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  label="Stop campaigns using them for"
                  checked={!!a.then.pause_sending_campaigns_for}
                  onChange={(on) =>
                    set(i, {
                      ...a,
                      then: {
                        ...a.then,
                        pause_sending_campaigns_for: on ? 7 : undefined,
                      },
                    })
                  }
                />
                {!!a.then.pause_sending_campaigns_for && (
                  <NumberInput
                    className="w-28"
                    value={a.then.pause_sending_campaigns_for}
                    onChange={(v) =>
                      set(i, {
                        ...a,
                        then: {
                          ...a.then,
                          pause_sending_campaigns_for: Math.max(1, v ?? 1),
                        },
                      })
                    }
                    min={1}
                    max={365}
                    suffix="days"
                    aria-label="Pause campaigns for"
                  />
                )}
              </div>
              <Checkbox
                label="Pause the accounts (warmup included) until you resume them"
                checked={!!a.then.pause}
                onChange={(on) => set(i, { ...a, then: { ...a.then, pause: on || undefined } })}
              />
              <Checkbox
                label="Turn on slow ramp-up"
                checked={!!a.then.enable_slow_ramp}
                onChange={(on) =>
                  set(i, {
                    ...a,
                    then: {
                      ...a.then,
                      enable_slow_ramp: on || undefined,
                      disable_slow_ramp: on ? undefined : a.then.disable_slow_ramp,
                    },
                  })
                }
              />
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  label="Tag them"
                  checked={a.then.add_tags !== undefined}
                  onChange={(on) =>
                    set(i, {
                      ...a,
                      then: { ...a.then, add_tags: on ? [] : undefined },
                    })
                  }
                />
                {a.then.add_tags !== undefined && (
                  <TagPicker
                    value={a.then.add_tags}
                    onChange={(ids) => set(i, { ...a, then: { ...a.then, add_tags: ids } })}
                    trigger={
                      <Button size="xs">
                        {a.then.add_tags.length
                          ? (tags.data ?? [])
                              .filter((t) => a.then.add_tags!.includes(t.id))
                              .map((t) => t.label)
                              .join(", ") || "Choose tags"
                          : "Choose tags"}
                      </Button>
                    }
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  label="Call a webhook"
                  checked={a.then.webhook_url !== undefined}
                  onChange={(on) =>
                    set(i, {
                      ...a,
                      then: { ...a.then, webhook_url: on ? "" : undefined },
                    })
                  }
                />
                {a.then.webhook_url !== undefined && (
                  <Input
                    className="min-w-[16rem] flex-1"
                    inputSize="sm"
                    value={a.then.webhook_url}
                    onChange={(e) =>
                      set(i, {
                        ...a,
                        then: { ...a.then, webhook_url: e.target.value },
                      })
                    }
                    placeholder="https://hooks.example.com/placement"
                    leading={<Webhook size={14} />}
                    aria-label="Webhook URL"
                  />
                )}
              </div>
            </div>
          </Card>
        );
      })}
      <Button
        size="sm"
        icon={<Plus size={14} />}
        onClick={() =>
          onChange([
            ...value,
            {
              when: { condition: "placement_goes_below", condition_value: 80 },
              then: { pause_sending_campaigns_for: 7 },
            },
          ])
        }
      >
        Add rule
      </Button>
    </div>
  );
}

const ALL_DAYS = {
  "0": false,
  "1": true,
  "2": true,
  "3": true,
  "4": true,
  "5": true,
  "6": false,
};

/** /app/inbox-placement/create (and ?id= to edit) */
export function PlacementEditor() {
  const [params] = useSearchParams();
  const editId = params.get("id");
  usePageTitle(editId ? "Edit placement test" : "New placement test");
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: ["placement-test", editId],
    queryFn: () => get<PlacementTest>(`/api/v2/inbox-placement-tests/${editId}`),
    enabled: !!editId,
  });
  const options = useQuery({
    queryKey: ["placement-esp-options"],
    queryFn: () => get<Label[]>("/api/v2/inbox-placement-tests/email-service-provider-options"),
  });
  const campaigns = useQuery({
    queryKey: ["campaigns", "picker"],
    queryFn: () =>
      get<Page<{ id: string; name: string }>>("/api/v2/campaigns", {
        limit: 100,
      }),
  });
  const defaultZone = useWorkspaceZone();
  const [form, setForm] = useState({
    name: "",
    description: "",
    type: 1 as 1 | 2,
    sending_method: 1 as 1 | 2,
    emails: [] as string[],
    tags: [] as string[],
    email_subject: "",
    email_body: "",
    text_only: false,
    campaign_id: "" as string,
    labels: null as Label[] | null,
    schedule: {
      days: ALL_DAYS as Record<string, boolean>,
      timing: { from: "09:00" },
      timezone: defaultZone,
    },
    automations: [] as Automation[],
    test_code: "",
  });
  const [loaded, setLoaded] = useState(!editId);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(dirty && !busy);
  useEffect(() => {
    const t = existing.data;
    if (!t || loaded) return;
    setForm({
      name: t.name,
      description: t.description ?? "",
      type: t.type,
      sending_method: t.sending_method,
      emails: t.emails ?? [],
      tags: t.tags ?? [],
      email_subject: t.email_subject,
      email_body: t.email_body,
      text_only: !!t.text_only,
      campaign_id: t.campaign_id ?? "",
      labels: t.recipients_labels?.length ? t.recipients_labels : null,
      schedule: t.schedule ?? {
        days: ALL_DAYS,
        timing: { from: "09:00" },
        timezone: defaultZone,
      },
      automations: t.automations ?? [],
      test_code: t.test_code ?? "",
    });
    setLoaded(true);
  }, [existing.data, loaded, defaultZone]);
  const set = (patchForm: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patchForm }));
    setDirty(true);
  };
  const labelKey = (l: Label) => `${l.esp}|${l.region}|${l.sub_region}|${l.type}`;
  const allLabels = options.data ?? [];
  const chosen = form.labels ?? allLabels;
  const toggleLabel = (l: Label, on: boolean) => {
    const next = on ? [...chosen, l] : chosen.filter((x) => labelKey(x) !== labelKey(l));
    set({ labels: next.length === allLabels.length ? null : next });
  };

  const copyFromCampaign = async (id: string) => {
    set({ campaign_id: id });
    if (!id) return;
    try {
      const c = await get<{
        sequences?: Array<{
          steps: Array<{ variants: Array<{ subject: string; body: string }> }>;
        }>;
      }>(`/api/v2/campaigns/${id}`);
      const v = c.sequences?.[0]?.steps?.[0]?.variants?.[0];
      if (v) set({ campaign_id: id, email_subject: v.subject, email_body: v.body });
      else toast.info("That campaign has no first email yet");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const problems: string[] = [];
  if (!form.name.trim()) problems.push("Name the test");
  if (form.sending_method === 1 && !form.emails.length && !form.tags.length) problems.push("Choose at least one sending account");
  if (form.sending_method === 1 && !form.email_body.trim()) problems.push("Write the email body");
  if (form.type === 2 && !Object.values(form.schedule.days).some(Boolean)) problems.push("Pick at least one day");
  if (form.labels && !form.labels.length) problems.push("Choose at least one seed group");
  if (form.automations.some((a) => a.then.webhook_url !== undefined && !/^https:\/\//.test(a.then.webhook_url))) problems.push("Webhook URLs must start with https://");

  const save = async () => {
    setBusy(true);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      type: form.type,
      sending_method: form.sending_method,
      emails: form.sending_method === 1 ? form.emails : [],
      tags: form.sending_method === 1 ? form.tags : [],
      email_subject: form.email_subject,
      email_body: form.email_body,
      text_only: form.text_only,
      campaign_id: form.campaign_id || null,
      recipients_labels: form.labels ?? [],
      ...(form.type === 2 ? { schedule: form.schedule, automations: form.automations } : { automations: [] }),
      ...(form.sending_method === 2 && form.test_code ? { test_code: form.test_code } : {}),
    };
    try {
      const t = editId
        ? await patch<PlacementTest>(`/api/v2/inbox-placement-tests/${editId}`, body)
        : await post<PlacementTest>("/api/v2/inbox-placement-tests", {
            ...body,
            run_immediately: form.type === 2,
          });
      qc.invalidateQueries({ queryKey: TESTS_KEY });
      qc.invalidateQueries({ queryKey: ["placement-test", t.id] });
      setDirty(false);
      toast.success(editId ? "Test saved" : form.sending_method === 1 ? "Test started" : "Test created");
      nav(`/app/inbox-placement/${t.id}/results`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (editId && !loaded) return <SkeletonRows rows={6} />;
  const zones = (CAMPAIGN_TIMEZONES as readonly string[]).includes(form.schedule.timezone) ? [...CAMPAIGN_TIMEZONES] : [form.schedule.timezone, ...CAMPAIGN_TIMEZONES];
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link to="/app/inbox-placement" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Inbox placement
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{editId ? "Edit test" : "New placement test"}</h1>
        <Button variant="primary" loading={busy} disabled={problems.length > 0} onClick={save}>
          {editId ? "Save test" : form.sending_method === 1 ? (form.type === 1 ? "Save and run" : "Save and schedule") : "Create test"}
        </Button>
      </div>
      {problems.length > 0 && dirty && <p className="mt-2 text-right text-xs text-muted">{problems[0]}</p>}

      <Section title="Basics">
        <div className="space-y-3">
          <Field label="Name">
            {(id) => (
              <Input id={id} value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={250} placeholder="Weekly check, main domains" autoFocus={!editId} />
            )}
          </Field>
          <Field label="Notes" optional>
            {(id) => <Textarea id={id} rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />}
          </Field>
        </div>
      </Section>

      <Section title="When" description="Run it once, or on a schedule that keeps watching your reputation.">
        <div className="space-y-3">
          <Segmented
            value={String(form.type) as "1" | "2"}
            onChange={(v) => set({ type: Number(v) as 1 | 2 })}
            options={[
              { value: "1", label: "Once" },
              { value: "2", label: "On a schedule" },
            ]}
          />
          {form.type === 2 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {WEEKDAYS.map((d, i) => (
                  <Checkbox
                    key={d}
                    label={d.slice(0, 3)}
                    checked={!!form.schedule.days[String(i)]}
                    onChange={(on) =>
                      set({
                        schedule: {
                          ...form.schedule,
                          days: { ...form.schedule.days, [String(i)]: on },
                        },
                      })
                    }
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                <Field label="At" className="w-32">
                  {(id) => (
                    <Input
                      id={id}
                      type="time"
                      value={form.schedule.timing.from}
                      onChange={(e) =>
                        set({
                          schedule: {
                            ...form.schedule,
                            timing: { from: e.target.value || "09:00" },
                          },
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Timezone" className="min-w-[14rem] flex-1">
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={form.schedule.timezone}
                      onChange={(v) => set({ schedule: { ...form.schedule, timezone: v } })}
                      options={zones.map((z) => ({ value: z, label: z }))}
                    />
                  )}
                </Field>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Sent from" description="Test the mailboxes you actually send with.">
        <div className="space-y-3">
          <Segmented
            value={String(form.sending_method) as "1" | "2"}
            onChange={(v) => set({ sending_method: Number(v) as 1 | 2 })}
            options={[
              { value: "1", label: "My email accounts" },
              { value: "2", label: "Another tool" },
            ]}
          />
          {form.sending_method === 1 ? (
            <AccountsPicker emails={form.emails} tagIds={form.tags} onChange={(v) => set({ emails: v.emails, tags: v.tagIds })} />
          ) : (
            <Callout tone="info" title="Send it yourself">
              After saving, send your email from the other tool to every seed address shown on the results page, and include the test code in the body so replies can be matched.
              {editId && form.test_code && (
                <span className="mt-2 flex items-center gap-2">
                  <code className="rounded bg-panel-2 px-1.5 py-0.5 text-xs">{form.test_code}</code>
                  <CopyButton value={form.test_code} />
                </span>
              )}
            </Callout>
          )}
        </div>
      </Section>

      {form.sending_method === 1 && (
        <Section title="Email" description="Use the email you plan to send. Variables get sample values.">
          <div className="space-y-3">
            <Field label="Copy from a campaign" optional>
              {(id) => (
                <NativeSelect
                  id={id}
                  value={form.campaign_id}
                  onChange={copyFromCampaign}
                  options={[
                    { value: "", label: "Write it here" },
                    ...(campaigns.data?.items ?? []).map((c) => ({
                      value: c.id,
                      label: c.name,
                    })),
                  ]}
                />
              )}
            </Field>
            <Field label="Subject">
              {(id) => <Input id={id} value={form.email_subject} onChange={(e) => set({ email_subject: e.target.value })} placeholder="Quick question, {{firstName}}" />}
            </Field>
            <Field label="Body">
              {() => (
                <RichEditor
                  value={form.email_body}
                  onChange={(html) => set({ email_body: html })}
                  minHeight={200}
                  toolbarExtra={<VariablesMenu onInsert={(t) => set({ email_body: `${form.email_body}${t}` })} />}
                />
              )}
            </Field>
            <Checkbox label="Send as plain text" checked={form.text_only} onChange={(v) => set({ text_only: v })} />
          </div>
        </Section>
      )}

      <Section title="Seed inboxes" description="Which providers and countries to test against.">
        {options.isLoading ? (
          <SkeletonRows rows={2} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {allLabels.map((l) => (
              <Checkbox
                key={labelKey(l)}
                label={`${l.esp} · ${l.sub_region} · ${l.type === "Professional" ? "business" : "personal"}`}
                checked={chosen.some((x) => labelKey(x) === labelKey(l))}
                onChange={(on) => toggleLabel(l, on)}
              />
            ))}
          </div>
        )}
      </Section>

      {form.type === 2 && (
        <Section title="Automations" description="Protect your reputation when a scheduled test finds a problem.">
          <AutomationEditor value={form.automations} onChange={(automations) => set({ automations })} />
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Results

function PlacementLayoutInner({ data, refetch }: { data: Overview; refetch: () => void }) {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = data.test;
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      toastRunStart(await post<RunStart>(`/api/app/inbox-placement-tests/${t.id}/run`));
      qc.invalidateQueries({ queryKey: TESTS_KEY });
      refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn("border-b-2 pb-2.5 text-[13px] font-medium", isActive ? "border-brand text-text" : "border-transparent text-muted hover:text-text");
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <Link to="/app/inbox-placement" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Inbox placement
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t.name}</h1>
        <StatusBadge t={t} />
        <div className="ml-auto flex gap-2">
          {can.write && (
            <Button icon={<Pencil size={14} />} onClick={() => nav(`/app/inbox-placement/create?id=${t.id}`)}>
              Edit
            </Button>
          )}
          {can.write && t.sending_method === INBOX_PLACEMENT.SENDING_FROM_APP && (
            <Button variant="primary" icon={<RefreshCw size={14} />} loading={running} onClick={run}>
              Run again
            </Button>
          )}
        </div>
      </div>
      <nav className="mt-4 flex gap-5 border-b border-line">
        <NavLink to={`/app/inbox-placement/${t.id}/results`} className={tab}>
          Results
        </NavLink>
        <NavLink to={`/app/inbox-placement/${t.id}/test-details`} className={tab}>
          Test details
        </NavLink>
      </nav>
      <div className="pt-6">
        <Outlet context={{ data, refetch }} />
      </div>
    </div>
  );
}

type OutletData = { data: Overview; refetch: () => void };

/** /app/inbox-placement/:test_id — header and tabs, loading the test overview once. */
export function PlacementLayout() {
  const { test_id } = useParams();
  const [params] = useSearchParams();
  const runId = params.get("run") ?? undefined;
  const q = useQuery({
    queryKey: ["placement-overview", test_id, runId],
    queryFn: () =>
      get<Overview>(`/api/app/inbox-placement-tests/${test_id}/overview`, {
        run_id: runId,
      }),
    refetchInterval: (query) => ((query.state.data as Overview | undefined)?.pending ? 3000 : false),
  });
  usePageTitle(q.data?.test.name ?? "Inbox placement");
  if (q.isLoading) return <SkeletonRows rows={8} />;
  if (!q.data) return <EmptyState title="Test not found" action={<Link to="/app/inbox-placement">Back to tests</Link>} />;
  return <PlacementLayoutInner data={q.data} refetch={() => q.refetch()} />;
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ key: string } & Summary> }) {
  const read = rows.filter((r) => r.count > 0);
  if (!read.length) return null;
  return (
    <Card>
      <CardHeader title={title} />
      <ul className="space-y-3">
        {read.map((r) => (
          <li key={r.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
              <span className="truncate font-medium">{r.key}</span>
              <span className="shrink-0 text-xs text-muted">
                <span className="text-ok">{pct(r.inbox_percent)}</span> inbox · <span className="text-bad">{pct(r.spam_percent)}</span> spam · {r.count}
              </span>
            </div>
            <PlacementBar s={r} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Pass({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-faint">–</span>;
  return ok ? <CircleCheck size={15} className="text-ok" aria-label="Pass" /> : <CircleX size={15} className="text-bad" aria-label="Fail" />;
}

function folderLabel(r: Result) {
  if (r.folder === "unchecked") return <Badge tone="warn">Seed unreadable</Badge>;
  if (r.folder === "missing") return <Badge tone="neutral">Not received</Badge>;
  if (r.is_spam) return <Badge tone="bad">Spam</Badge>;
  if (r.has_category) return <Badge tone="info">Tab{r.folder && r.folder !== "INBOX" ? `: ${r.folder}` : ""}</Badge>;
  return <Badge tone="ok">Inbox</Badge>;
}

/** /app/inbox-placement/:test_id/results */
export function PlacementResults() {
  const { data } = useOutletContext<OutletData>();
  const [params, setParams] = useSearchParams();
  const seeds = useSeeds();
  const t = data.test;
  const s = data.summary;
  const missing = data.results.filter((r) => r.folder === "missing").length;
  const unchecked = s.unchecked_count ?? 0;
  if (!data.run_id) {
    return (
      <div className="space-y-4">
        {t.sending_method === INBOX_PLACEMENT.SENDING_EXTERNAL ? (
          <Card>
            <CardHeader title="Send your test email" description="Send one email from your other tool to all of these addresses. Put the test code anywhere in the body." />
            <div className="mb-3 flex items-center gap-2 text-[13px]">
              Test code <code className="rounded bg-panel-2 px-1.5 py-0.5 text-xs">{t.test_code}</code>
              {t.test_code && <CopyButton value={t.test_code} />}
            </div>
            <Textarea readOnly rows={Math.min(10, t.recipients.length + 1)} value={t.recipients.join(", ")} aria-label="Seed addresses" />
            <div className="mt-2 flex justify-end">
              <CopyButton value={t.recipients.join(", ")} label="Copy addresses" />
            </div>
          </Card>
        ) : (
          <EmptyState
            icon={<Inbox size={22} />}
            title="No runs yet"
            description={
              t.type === INBOX_PLACEMENT.TYPE_AUTOMATED
                ? `The first run is ${t.timestamp_next_run ? dateTime(t.timestamp_next_run) : "scheduled"}.`
                : "Run the test to see where your email lands."
            }
          />
        )}
        {!!seeds.data?.items.some((x) => x.active && x.simulated) && <p className="text-xs text-muted">Simulated seeds only receive mail from sandbox accounts on this server.</p>}
      </div>
    );
  }
  const toolbar = data.runs.length > 1 || data.pending > 0 || !!params.get("run");
  return (
    <div className="space-y-6">
      {toolbar && (
        <div className="flex flex-wrap items-center gap-3">
          {data.runs.length > 1 && (
            <NativeSelect
              size="sm"
              className="w-64"
              value={data.run_id}
              onChange={(v) => setParams((p) => ({ ...Object.fromEntries(p), run: v }))}
              options={[...data.runs].reverse().map((r, i) => ({
                value: r.run_id,
                label: `${i === 0 ? "Latest · " : ""}${r.timestamp ? dateTime(r.timestamp) : r.run_id}`,
              }))}
              aria-label="Run"
            />
          )}
          {data.pending > 0 && (
            <span className="inline-flex items-center gap-2 text-[13px] text-muted">
              <RefreshCw size={14} className="animate-spin" /> Waiting for {plural(data.pending, "seed")} to receive the email…
            </span>
          )}
          {params.get("run") && (
            <button type="button" className="text-xs text-brand-text hover:underline" onClick={() => setParams({})}>
              Show latest run
            </button>
          )}
        </div>
      )}
      {s.count === 0 ? (
        <Card className="flex items-start gap-3 text-[13px] text-muted">
          {data.pending > 0 ? (
            <>
              <RefreshCw size={16} className="mt-0.5 shrink-0 animate-spin" /> The test emails are on their way. Each seed mailbox is checked shortly after delivery and the results
              fill in here.
            </>
          ) : unchecked > 0 ? (
            `None of the ${plural(unchecked, "seed")} this run went to could be read, so it can't say where the email landed. A seed whose mailbox can't be signed in to is left out of the next runs until it's fixed.`
          ) : (
            "Nothing from this run has reached a seed yet."
          )}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["Inbox", s.inbox_percent - s.category_percent, s.inbox_count - s.category_count, "text-ok"],
                ["Other tabs", s.category_percent, s.category_count, "text-info"],
                ["Spam", s.spam_percent, s.spam_count, "text-bad"],
              ] as const
            ).map(([label, p, n, tone]) => (
              <Card key={label} className="p-3 sm:p-5">
                <p className="text-[13px] text-muted">{label}</p>
                <p className={cn("mt-1 text-2xl font-semibold tabular-nums sm:text-3xl", tone)}>{pct(p)}</p>
                <p className="text-xs text-muted">
                  {n} of {plural(s.count, "seed")}
                  {label === "Spam" && missing > 0 && `, including ${missing} never received`}
                </p>
              </Card>
            ))}
          </div>
          {unchecked > 0 && (
            <p className="text-xs text-muted">
              {plural(unchecked, "seed")} couldn't be read, so {unchecked === 1 ? "it's" : "they're"} left out of these numbers.
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown title="By provider" rows={data.by_esp} />
            <Breakdown title="By country" rows={data.by_geo} />
            <Breakdown title="By mailbox type" rows={data.by_type} />
            <Breakdown title="By sending account" rows={data.by_sender} />
          </div>
        </>
      )}

      {data.reports.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Domain health</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.reports.map((r) => {
              const listed = (r.domain_blacklist_count ?? 0) + (r.domain_ip_blacklist_count ?? 0);
              const sa = r.spam_assassin_report;
              const rules = sa?.report ?? [];
              const auth = r.auth_report;
              const listedOn = (r.blacklist_report?.details ?? []).filter((d) => d.is_listed);
              return (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.domain}</span>
                    {r.domain_ip && <span className="text-xs text-muted">{r.domain_ip}</span>}
                    <Badge tone={listed ? "bad" : "ok"} className="ml-auto">
                      {listed ? `On ${plural(listed, "blocklist")}` : "Not blocklisted"}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-faint">Content score</p>
                      <p className="mt-1">
                        <span className={cn("font-semibold tabular-nums", sa?.is_spam ? "text-bad" : "text-ok")}>{r.spam_assassin_score ?? "–"}</span>
                        {sa?.threshold !== undefined && <span className="text-muted"> / {sa.threshold} spam threshold</span>}
                      </p>
                      {sa?.engine && <p className="text-xs text-muted">{sa.engine === "spamassassin" ? "SpamAssassin" : "Built-in heuristic check"}</p>}
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-faint">Authentication</p>
                      {auth?.simulated ? (
                        <p className="mt-1 text-xs text-muted">{auth.note}</p>
                      ) : (
                        <div className="mt-1 flex gap-3">
                          {(["spf", "dkim", "dmarc"] as const).map((k) => (
                            <span key={k} className="inline-flex items-center gap-1 uppercase">
                              <Pass ok={auth?.indeterminate?.includes(k) ? null : (auth?.[k] ?? null)} /> <span className="text-xs">{k}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {rules.length > 0 && (
                    <details className="mt-3 text-[13px]">
                      <summary className="cursor-pointer text-muted">Content rules that matched ({rules.length})</summary>
                      <ul className="mt-2 space-y-1">
                        {rules.slice(0, 20).map((x, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="w-10 shrink-0 text-right tabular-nums text-muted">{x.score}</span>
                            <span>{x.description || x.name}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {listedOn.length > 0 && (
                    <p className="mt-3 flex gap-1.5 text-xs text-bad">
                      <ShieldAlert size={14} className="shrink-0" /> Listed on {listedOn.map((d) => `${d.blacklist}${d.test_type === "ip" ? " (IP)" : ""}`).join(", ")}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <Card padded={false} className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Every seed</h2>
        </div>
        <ScrollX>
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-line bg-panel-2/50 text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Seed</th>
                <th className="px-4 py-2.5 font-medium">Landed in</th>
                <th className="px-4 py-2.5 font-medium">From</th>
                <th className="px-4 py-2.5 text-center font-medium">SPF</th>
                <th className="px-4 py-2.5 text-center font-medium">DKIM</th>
                <th className="px-4 py-2.5 text-center font-medium">DMARC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.results.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{ESP_NAMES[r.recipient_esp ?? 0] ?? "Other"}</p>
                    <p className="text-xs text-muted">
                      {GEO_NAMES[r.recipient_geo ?? 0] ?? ""} · {r.recipient_type === 1 ? "business" : "personal"}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">{folderLabel(r)}</td>
                  <td className="max-w-[14rem] truncate px-4 py-2.5 text-muted">{r.sender_email}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex justify-center">
                      <Pass ok={r.spf_pass} />
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex justify-center">
                      <Pass ok={r.dkim_pass} />
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex justify-center">
                      <Pass ok={r.dmarc_pass} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      </Card>

      {data.runs.length > 1 && (
        <Card>
          <CardHeader title="History" description="Inbox placement across runs." />
          <ul className="space-y-2">
            {data.runs
              .slice()
              .reverse()
              .map((r) => (
                <li key={r.run_id}>
                  <button type="button" className="-my-1 flex w-full items-center gap-3 py-1 text-left text-[13px]" onClick={() => setParams({ run: r.run_id })}>
                    <span className="w-40 shrink-0 text-muted">{r.timestamp ? dateTime(r.timestamp) : r.run_id}</span>
                    {r.count > 0 ? (
                      <>
                        <Progress value={r.inbox_percent} tone={r.inbox_percent >= 80 ? "ok" : r.inbox_percent >= 50 ? "warn" : "bad"} className="flex-1" />
                        <span className="w-12 text-right tabular-nums">{pct(r.inbox_percent)}</span>
                      </>
                    ) : (
                      <span className="flex-1 text-xs text-faint">{r.unchecked_count ? "Seeds unreadable" : "No results"}</span>
                    )}
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** /app/inbox-placement/:test_id/test-details */
export function PlacementDetails() {
  const { data } = useOutletContext<OutletData>();
  const t = data.test;
  const tags = useTags();
  const tagNames = useMemo(() => (tags.data ?? []).filter((x) => t.tags?.includes(x.id)).map((x) => x.label), [tags.data, t.tags]);
  const rows: Array<[string, React.ReactNode]> = [
    ["Type", t.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? `Scheduled · ${scheduleText(t.schedule)}` : "One-time"],
    ["Sent from", t.sending_method === INBOX_PLACEMENT.SENDING_EXTERNAL ? "Another tool" : [...t.emails, ...tagNames.map((n) => `tag: ${n}`)].join(", ") || "—"],
    ["Seeds", plural(t.recipients.length, "inbox", "inboxes")],
    ["Runs so far", num(t.run_count)],
    ...(t.timestamp_next_run && t.status === INBOX_PLACEMENT.STATUS_ACTIVE ? [["Next run", dateTime(t.timestamp_next_run)] as [string, React.ReactNode]] : []),
    ["Created", dateTime(t.timestamp_created)],
  ];
  if (t.description) rows.unshift(["Notes", t.description]);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {t.sending_method === INBOX_PLACEMENT.SENDING_FROM_APP && (
          <Card>
            <CardHeader title="Email" />
            <p className="text-sm">
              <span className="text-muted">Subject: </span>
              <span className="font-medium">{t.email_subject || "(no subject)"}</span>
            </p>
            <div className="mt-3 rounded-lg border border-line px-3 py-2.5">
              <EmailFrame
                html={t.text_only ? `<pre style="white-space:pre-wrap;font-family:inherit">${t.email_body.replace(/<[^>]+>/g, "")}</pre>` : t.email_body}
                minHeight={160}
              />
            </div>
          </Card>
        )}
        {!!t.automations?.length && (
          <Card>
            <CardHeader title="Automations" />
            <ul className="space-y-2 text-[13px]">
              {t.automations.map((a, i) => {
                const c = CONDITIONS.find((x) => x.value === a.when.condition);
                const actions = [
                  a.then.pause_sending_campaigns_for && `stop campaigns on the accounts for ${plural(a.then.pause_sending_campaigns_for, "day")}`,
                  a.then.pause && "pause the accounts",
                  a.then.enable_slow_ramp && "turn on slow ramp-up",
                  a.then.add_tags?.length && "tag the accounts",
                  a.then.webhook_url && "call a webhook",
                ].filter(Boolean);
                return (
                  <li key={i}>
                    When {c?.label.toLowerCase()}
                    {c?.needsValue ? ` ${a.when.condition_value ?? 0}%` : ""}: {actions.join(", ") || "nothing"}.
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
      <Card>
        <dl className="space-y-3 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="mt-0.5 break-words">{v}</dd>
            </div>
          ))}
          {t.test_code && (
            <div>
              <dt className="text-xs text-muted">Test code</dt>
              <dd className="mt-0.5 flex items-center gap-2">
                <code className="text-xs">{t.test_code}</code>
                <CopyButton value={t.test_code} />
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={14} />}
            onClick={() => navigator.clipboard.writeText(t.recipients.join(", ")).then(() => toast.success("Seed addresses copied"))}
          >
            Copy seed addresses
          </Button>
        </div>
      </Card>
    </div>
  );
}
