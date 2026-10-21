import { useId, useMemo, useState, type ReactNode } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import { CalendarClock, Plus, Save, Trash2, X } from "lucide-react";
import { CAMPAIGN_TIMEZONES, HOLIDAY_COUNTRIES, WEEKDAYS, isHolidayCountry, upcomingDaysOff, type CampaignSchedule, type ScheduleWindow } from "@reachstack/shared";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { browserZone, knownToBrowser, todayIn } from "@/lib/dates";
import { useSession } from "@/lib/session";
import { useDraft, useReportUnsaved, useUnsavedChanges, type SaveEdits } from "@/lib/unsaved";
import { Button, Card, Checkbox, Field, Input, NativeSelect, Switch, useConfirm } from "@/components/ui";

/** New windows use the workspace timezone from Preferences (any zone, listed or not), else the browser's. */
const newWindow = (n: number, workspaceZone?: unknown): ScheduleWindow => ({
  name: n ? `Schedule ${n + 1}` : "New schedule",
  timing: { from: "09:00", to: "17:00" },
  days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
  timezone: knownToBrowser(workspaceZone) ? workspaceZone : (browserZone() ?? "America/New_York"),
});

/** "13:05" as "1:05 PM". */
const timeLabel = (value: string) => {
  const [h = 0, m = 0] = value.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** 15-minute steps, shown as 12-hour times. */
const TIMES = Array.from({ length: 96 }, (_, i) => {
  const value = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
  return { value, label: timeLabel(value) };
});

/** The steps, plus a time that isn't on one (set through the API), so the window shows as it is. */
const timesWith = (value: string) => (TIMES.some((t) => t.value === value) ? TIMES : [...TIMES, { value, label: timeLabel(value) }].sort((a, b) => a.value.localeCompare(b.value)));

/** Offset label like "GMT-05:00" for a zone, so the long list is easy to scan. */
function zoneLabel(zone: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return `${zone.replace(/_/g, " ")} (${part?.value ?? "GMT"})`;
  } catch {
    return zone;
  }
}

const DAY_ORDER = ["1", "2", "3", "4", "5", "6", "0"] as const;

type DaysOff = NonNullable<CampaignSchedule["days_off"]>;

const longDate = (d: string) => format(parseISO(d), "EEE, MMM d, yyyy");

function Chip({ children, label, onRemove }: { children: ReactNode; label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-panel-2 py-0.5 pr-1 pl-2.5 text-xs">
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="hit-24 rounded-full p-0.5 text-muted hover:bg-line hover:text-text">
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** Public holidays of some countries and dates of your own, on the schedule's calendar. */
/** "Each lead's timezone": the windows on each lead's own clock instead of the schedule's. */
function LeadClockCard({ on, onChange, readOnly }: { on: boolean; onChange: (v: boolean) => void; readOnly?: boolean }) {
  const id = useId();
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="text-[13px] font-medium">
            Each lead's timezone
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Send inside the window on each lead's own clock, from the lead's timezone, location or phone number. Leads it can't place go by the schedule's
            timezone.
          </p>
        </div>
        <Switch id={id} checked={on} disabled={readOnly} onChange={onChange} />
      </div>
    </Card>
  );
}

function DaysOffCard({ value, onChange, readOnly, zone, leadClock }: { value: CampaignSchedule["days_off"]; onChange: (v: DaysOff | null) => void; readOnly?: boolean; zone: string; leadClock?: boolean }) {
  const off: Required<DaysOff> = { holidays: value?.holidays ?? [], dates: value?.dates ?? [] };
  const [date, setDate] = useState("");
  const today = todayIn(zone);
  const upcoming = upcomingDaysOff(off, today, 4);
  const set = (next: Required<DaysOff>) => onChange(next.holidays.length || next.dates.length ? next : null);
  const add = () => {
    if (!date) return;
    if (!off.dates.includes(date)) set({ ...off, dates: [...off.dates, date].sort() });
    setDate("");
  };
  const country = (c: string) => (isHolidayCountry(c) ? HOLIDAY_COUNTRIES[c] : c);
  const future = off.dates.filter((d) => d >= today);
  const past = off.dates.length - future.length;
  return (
    <Card className="space-y-3">
      <div>
        <p className="text-[13px] font-medium">Days off</p>
        <p className="mt-0.5 text-xs text-muted">Nothing goes out on these days ({leadClock ? "each lead's" : zone.replace(/_/g, " ")} calendar).</p>
      </div>
      <Field label="Public holidays">
        {(id) => (
          <div className="space-y-2">
            {off.holidays.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {off.holidays.map((c) => (
                  <Chip key={c} label={`${country(c)} holidays`} onRemove={readOnly ? undefined : () => set({ ...off, holidays: off.holidays.filter((x) => x !== c) })}>
                    {country(c)}
                  </Chip>
                ))}
              </div>
            )}
            {!readOnly && (
              <NativeSelect
                id={id}
                value=""
                onChange={(v) => v && set({ ...off, holidays: [...off.holidays, v] })}
                options={[
                  { value: "", label: off.holidays.length ? "Add another country…" : "Add a country…" },
                  ...Object.entries(HOLIDAY_COUNTRIES)
                    .filter(([c]) => !off.holidays.includes(c))
                    .map(([value, label]) => ({ value, label })),
                ]}
              />
            )}
            {readOnly && !off.holidays.length && <p className="text-xs text-faint">None</p>}
          </div>
        )}
      </Field>
      <Field label="Other dates">
        {(id) => (
          <div className="space-y-2">
            {future.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {future.map((d) => (
                  <Chip key={d} label={longDate(d)} onRemove={readOnly ? undefined : () => set({ ...off, dates: off.dates.filter((x) => x !== d) })}>
                    {format(parseISO(d), "MMM d, yyyy")}
                  </Chip>
                ))}
              </div>
            )}
            {past > 0 && !readOnly && (
              <button type="button" className="text-xs text-muted hover:text-text hover:underline" onClick={() => set({ ...off, dates: future })}>
                Remove {past} past date{past === 1 ? "" : "s"}
              </button>
            )}
            {!readOnly && (
              <div className="flex gap-2">
                <Input id={id} type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
                <Button onClick={add} disabled={!date}>
                  Add
                </Button>
              </div>
            )}
            {readOnly && !future.length && <p className="text-xs text-faint">None</p>}
          </div>
        )}
      </Field>
      {upcoming.length > 0 && (
        <div className="border-t border-line pt-3 text-xs">
          <p className="mb-1 font-medium">Coming up</p>
          <ul className="space-y-1 text-muted">
            {upcoming.map((d) => (
              <li key={d.date}>
                <span className="text-text tabular-nums">{format(parseISO(d.date), "EEE, MMM d")}</span> · {d.names.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function ScheduleEditor({
  schedule,
  onSave,
  readOnly,
  title = "Campaign",
  onUnsaved,
  scope,
}: {
  schedule: CampaignSchedule | null | undefined;
  onSave: (s: CampaignSchedule) => Promise<unknown>;
  readOnly?: boolean;
  title?: string;
  /** Given a way to save while there are unsaved edits (null once there are none), so the page can save them first. */
  onUnsaved?: (save: SaveEdits | null) => void;
  /** Whose schedule this is: edits never carry over to another one's. */
  scope?: string;
}) {
  const zone = useSession().workspace?.settings.default_timezone;
  const confirm = useConfirm();
  const baseline = useMemo<CampaignSchedule>(
    () => ({
      start_date: schedule?.start_date ?? null,
      end_date: schedule?.end_date ?? null,
      schedules: schedule?.schedules?.length ? schedule.schedules : [newWindow(0, zone)],
      days_off: schedule?.days_off ?? null,
      ...(schedule?.lead_timezone ? { lead_timezone: true } : {}),
    }),
    [schedule, zone],
  );
  // Follows the saved schedule: what's typed while it saves, or before a reload, stays.
  const [draft, setDraft, dirty, sending] = useDraft<CampaignSchedule>(baseline, scope);
  const [sel, setSel] = useState(0);
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(dirty && !readOnly);

  const idx = Math.min(sel, draft.schedules.length - 1);
  const w = draft.schedules[idx]!;
  const zones = useMemo(() => {
    const list = [...CAMPAIGN_TIMEZONES] as string[];
    if (!list.includes(w.timezone)) list.unshift(w.timezone);
    return list.map((z) => ({ value: z, label: zoneLabel(z) }));
  }, [w.timezone]);

  const setWindow = (patch: Partial<ScheduleWindow>) => setDraft((d) => ({ ...d, schedules: d.schedules.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));

  const errors: string[] = [];
  if (draft.start_date && draft.end_date && draft.start_date > draft.end_date) errors.push("The start date can't be after the end date.");
  draft.schedules.forEach((s) => {
    if (!s.name.trim()) errors.push("Add a name for each schedule.");
    if (s.timing.from >= s.timing.to) errors.push(`“${s.name || "Schedule"}”: the end time must be after the start time.`);
    if (!Object.values(s.days).some(Boolean)) errors.push(`“${s.name || "Schedule"}”: pick at least one day.`);
  });

  const save = async () => {
    if (errors.length) {
      toast.error(errors[0]!);
      return false;
    }
    setSaving(true);
    const sent = draft;
    sending(sent);
    try {
      await onSave(sent);
      toast.success("Schedule saved");
      return true;
    } catch (e) {
      sending(undefined);
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useReportUnsaved(dirty && !readOnly, save, onUnsaved);

  const remove = async () => {
    if (draft.schedules.length === 1) return;
    if (!(await confirm({ title: `Delete “${w.name}”?`, confirmLabel: "Delete schedule", danger: true }))) return;
    setDraft((d) => ({ ...d, schedules: d.schedules.filter((_, i) => i !== idx) }));
    setSel(Math.max(0, idx - 1));
  };

  const hours = (() => {
    const [fh, fm] = w.timing.from.split(":").map(Number);
    const [th, tm] = w.timing.to.split(":").map(Number);
    return Math.max(0, (th! * 60 + tm! - (fh! * 60 + fm!)) / 60);
  })();
  const days = DAY_ORDER.filter((d) => w.days[d]).length;

  return (
    <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card className="space-y-3">
          <Field label="Start">
            {(id) => (
              <div className="flex items-center gap-2">
                <Input id={id} type="date" value={draft.start_date ?? ""} disabled={readOnly} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} />
                {draft.start_date && !readOnly && (
                  <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, start_date: null })}>
                    Now
                  </Button>
                )}
              </div>
            )}
          </Field>
          <Field label="End" hint={draft.end_date ? undefined : "No end date"}>
            {(id) => (
              <div className="flex items-center gap-2">
                <Input id={id} type="date" value={draft.end_date ?? ""} min={draft.start_date ?? undefined} disabled={readOnly} onChange={(e) => setDraft({ ...draft, end_date: e.target.value || null })} />
                {draft.end_date && !readOnly && (
                  <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, end_date: null })}>
                    Clear
                  </Button>
                )}
              </div>
            )}
          </Field>
        </Card>
        <LeadClockCard on={!!draft.lead_timezone} readOnly={readOnly} onChange={(v) => setDraft(({ lead_timezone: _, ...d }) => (v ? { ...d, lead_timezone: true } : d))} />
        <DaysOffCard
          value={draft.days_off}
          readOnly={readOnly}
          zone={draft.schedules[0]?.timezone ?? "UTC"}
          leadClock={!!draft.lead_timezone}
          onChange={(days_off) => setDraft((d) => ({ ...d, days_off }))}
        />
        <div className="space-y-1.5">
          {draft.schedules.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSel(i)}
              className={cn("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px]", i === idx ? "border-brand bg-brand-soft/40" : "border-line bg-panel hover:border-line-strong")}
            >
              <CalendarClock size={14} className="text-muted" />
              <span className="truncate font-medium">{s.name || "Untitled"}</span>
            </button>
          ))}
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              icon={<Plus size={14} />}
              onClick={() => {
                setDraft((d) => ({ ...d, schedules: [...d.schedules, newWindow(d.schedules.length, zone)] }));
                setSel(draft.schedules.length);
              }}
            >
              Add schedule
            </Button>
          )}
        </div>
      </div>

      <Card className="space-y-5">
        <div className="flex items-end gap-2">
          <Field label="Schedule name" className="flex-1">
            {(id) => <Input id={id} value={w.name} disabled={readOnly} onChange={(e) => setWindow({ name: e.target.value })} placeholder="Give your schedule a name" />}
          </Field>
          {!readOnly && draft.schedules.length > 1 && (
            <Button variant="ghost" icon={<Trash2 size={14} />} onClick={remove}>
              Delete
            </Button>
          )}
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">Timing</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From">{(id) => <NativeSelect id={id} value={w.timing.from} disabled={readOnly} onChange={(v) => setWindow({ timing: { ...w.timing, from: v } })} options={timesWith(w.timing.from)} />}</Field>
            <Field label="To">{(id) => <NativeSelect id={id} value={w.timing.to} disabled={readOnly} onChange={(v) => setWindow({ timing: { ...w.timing, to: v } })} options={timesWith(w.timing.to)} />}</Field>
            <Field label="Timezone">{(id) => <NativeSelect id={id} value={w.timezone} disabled={readOnly} onChange={(v) => setWindow({ timezone: v })} options={zones} />}</Field>
          </div>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">Days</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {DAY_ORDER.map((d) => (
              <Checkbox key={d} label={WEEKDAYS[Number(d)]} checked={!!w.days[d]} disabled={readOnly} onChange={(v) => setWindow({ days: { ...w.days, [d]: v } })} />
            ))}
          </div>
        </div>

        <p className="text-xs text-muted">
          Sends {hours ? `${hours % 1 ? hours.toFixed(2) : hours} hours a day` : "never"} on {days} day{days === 1 ? "" : "s"} a week{" "}
          {draft.lead_timezone ? `on each lead's clock (${w.timezone.replace(/_/g, " ")} when it can't place them)` : `in ${w.timezone.replace(/_/g, " ")}`}
          {draft.days_off ? ", except on its days off" : ""}. {title} emails only go out inside this window, spaced by the gap set in Options.
        </p>

        {errors.length > 0 && <p className="text-xs text-bad">{errors[0]}</p>}
        {!readOnly && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={save}>
              {dirty ? "Save" : "Saved"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
